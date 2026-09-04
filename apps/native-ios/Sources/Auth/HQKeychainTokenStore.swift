import Foundation
import Security

struct HQAuthTokens: Codable, Equatable, Sendable {
    let idToken: String
    let accessToken: String
    let refreshToken: String
    let tokenType: String
    let expiresAt: Date
    let subjectID: String

    func expires(within interval: TimeInterval, now: Date = .now) -> Bool {
        expiresAt <= now.addingTimeInterval(interval)
    }

    var hasValidLocalShape: Bool {
        tokenType == "Bearer" && [idToken, accessToken, refreshToken, subjectID].allSatisfy { value in
            !value.isEmpty && !value.unicodeScalars.contains {
                CharacterSet.whitespacesAndNewlines.contains($0) || CharacterSet.controlCharacters.contains($0)
            }
        } && expiresAt.timeIntervalSinceReferenceDate.isFinite
    }
}

protocol HQTokenStoring: Sendable {
    func load() async throws -> HQAuthTokens?
    func save(_ tokens: HQAuthTokens) async throws
    func purge() async throws
}

enum HQKeychainTokenStoreError: Error, Equatable, LocalizedError {
    case locked(OSStatus)
    case corrupt
    case operationFailed(OSStatus)

    var errorDescription: String? {
        switch self {
        case .locked: "Unlock this device so HQ can finish securing your session."
        case .corrupt: "The secure session was damaged and has been removed. Please sign in again."
        case let .operationFailed(status): "HQ could not update the secure session (Keychain status \(status)). Restart HQ and try again."
        }
    }
}

protocol HQSecurityAdapting: Sendable {
    func copy(service: String, account: String) -> (OSStatus, Data?)
    func add(service: String, account: String, data: Data, accessibility: CFString, synchronizable: Bool) -> OSStatus
    func update(service: String, account: String, data: Data, accessibility: CFString, synchronizable: Bool) -> OSStatus
    func delete(service: String, account: String) -> OSStatus
}

struct HQSystemSecurityAdapter: HQSecurityAdapting, @unchecked Sendable {
    func copy(service: String, account: String) -> (OSStatus, Data?) {
        var result: CFTypeRef?
        var query = base(service: service, account: account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        return (status, result as? Data)
    }

    func add(service: String, account: String, data: Data, accessibility: CFString, synchronizable: Bool) -> OSStatus {
        var attributes = base(service: service, account: account)
        attributes[kSecValueData as String] = data
        attributes[kSecAttrAccessible as String] = accessibility
        attributes[kSecAttrSynchronizable as String] = synchronizable ? kCFBooleanTrue : kCFBooleanFalse
        return SecItemAdd(attributes as CFDictionary, nil)
    }

    func update(service: String, account: String, data: Data, accessibility: CFString, synchronizable: Bool) -> OSStatus {
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: accessibility,
            kSecAttrSynchronizable as String: synchronizable ? kCFBooleanTrue as Any : kCFBooleanFalse as Any,
        ]
        return SecItemUpdate(base(service: service, account: account) as CFDictionary, attributes as CFDictionary)
    }

    func delete(service: String, account: String) -> OSStatus {
        SecItemDelete(base(service: service, account: account) as CFDictionary)
    }

    private func base(service: String, account: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
         kSecAttrAccount as String: account, kSecAttrSynchronizable as String: kCFBooleanFalse as Any]
    }
}

actor HQKeychainTokenStore: HQTokenStoring {
    nonisolated(unsafe) static let itemAccessibility = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
    private let service: String
    private let account: String
    private let security: any HQSecurityAdapting

    init(service: String = "com.hqforwork.mobile.auth", account: String = "oauth-session-v1",
         security: any HQSecurityAdapting = HQSystemSecurityAdapter()) {
        self.service = service
        self.account = account
        self.security = security
    }

    func load() throws -> HQAuthTokens? {
        let (status, data) = security.copy(service: service, account: account)
        if status == errSecItemNotFound { return nil }
        try Self.validate(status)
        guard let data else { throw HQKeychainTokenStoreError.corrupt }
        do {
            let tokens = try JSONDecoder.hqAuth.decode(HQAuthTokens.self, from: data)
            guard tokens.hasValidLocalShape else { throw HQKeychainTokenStoreError.corrupt }
            return tokens
        }
        catch {
            let purgeStatus = security.delete(service: service, account: account)
            if purgeStatus != errSecSuccess && purgeStatus != errSecItemNotFound { try Self.validate(purgeStatus) }
            throw HQKeychainTokenStoreError.corrupt
        }
    }

    func save(_ tokens: HQAuthTokens) throws {
        guard tokens.hasValidLocalShape else { throw HQKeychainTokenStoreError.corrupt }
        let data = try JSONEncoder.hqAuth.encode(tokens)
        let status = security.add(service: service, account: account, data: data, accessibility: Self.itemAccessibility, synchronizable: false)
        if status == errSecDuplicateItem {
            let update = security.update(service: service, account: account, data: data, accessibility: Self.itemAccessibility, synchronizable: false)
            if update == errSecItemNotFound {
                let recreate = security.add(service: service, account: account, data: data, accessibility: Self.itemAccessibility, synchronizable: false)
                try Self.validate(recreate)
            } else {
                try Self.validate(update)
            }
            return
        }
        try Self.validate(status)
    }

    func purge() throws {
        let status = security.delete(service: service, account: account)
        guard status != errSecItemNotFound else { return }
        try Self.validate(status)
    }

    static func validate(_ status: OSStatus) throws {
        guard status != errSecSuccess else { return }
        if status == errSecInteractionNotAllowed || status == errSecNotAvailable || status == errSecAuthFailed {
            throw HQKeychainTokenStoreError.locked(status)
        }
        throw HQKeychainTokenStoreError.operationFailed(status)
    }
}

actor HQKeychainSignOutFence: HQSignOutFenceStoring {
    static let service = "com.hqforwork.mobile.auth.tombstone"
    static let account = "pending-local-purge-v1"
    private let security: any HQSecurityAdapting

    init(security: any HQSecurityAdapting = HQSystemSecurityAdapter()) { self.security = security }

    func isArmed() throws -> Bool {
        let (status, _) = security.copy(service: Self.service, account: Self.account)
        if status == errSecItemNotFound { return false }
        try HQKeychainTokenStore.validate(status)
        // The tombstone is intentionally nonsecret. Any item at its exact
        // service/account is fail-closed evidence that local cleanup may be
        // incomplete, even if an interrupted write left malformed bytes.
        return true
    }

    func arm() throws {
        let status = security.add(service: Self.service, account: Self.account, data: Data([1]),
                                  accessibility: HQKeychainTokenStore.itemAccessibility, synchronizable: false)
        if status == errSecDuplicateItem {
            let updated = security.update(service: Self.service, account: Self.account, data: Data([1]),
                                          accessibility: HQKeychainTokenStore.itemAccessibility, synchronizable: false)
            try HQKeychainTokenStore.validate(updated)
        } else {
            try HQKeychainTokenStore.validate(status)
        }
    }

    func clear() throws {
        let status = security.delete(service: Self.service, account: Self.account)
        guard status != errSecItemNotFound else { return }
        try HQKeychainTokenStore.validate(status)
    }
}

enum HQFileSignOutFenceError: Error, Equatable, LocalizedError {
    case unavailable
    case corrupt

    var errorDescription: String? {
        switch self {
        case .unavailable: "HQ could not update its independent local sign-out marker. Restart HQ and try again."
        case .corrupt: "HQ found a damaged local sign-out marker and must reset local security state."
        }
    }
}

/// A nonsecret, app-container marker independent of Keychain availability. Its
/// only meaning is "finish local purge before loading credentials." Atomic
/// replacement plus read-after-write/remove checks make acknowledged state
/// transitions durable and observable.
actor HQFileSignOutFence: HQSignOutFenceStoring {
    private let markerURL: URL
    private let fileManager: FileManager
    private static let marker = Data("hq-pending-local-purge-v1\n".utf8)

    init(markerURL: URL? = nil, fileManager: FileManager = .default) {
        self.fileManager = fileManager
        let root = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? fileManager.temporaryDirectory
        self.markerURL = markerURL ?? root
            .appendingPathComponent("com.hqforwork.mobile", isDirectory: true)
            .appendingPathComponent("pending-local-purge-v1", isDirectory: false)
    }

    func isArmed() throws -> Bool {
        guard fileManager.fileExists(atPath: markerURL.path) else { return false }
        // Presence is the durable security signal. Treat malformed or
        // unreadable contents as armed so restore can purge protected state,
        // remove the marker, and recover on the next launch.
        return true
    }

    func arm() throws {
        do {
            try fileManager.createDirectory(at: markerURL.deletingLastPathComponent(),
                                            withIntermediateDirectories: true)
            try Self.marker.write(to: markerURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            guard try Data(contentsOf: markerURL) == Self.marker else { throw HQFileSignOutFenceError.unavailable }
        } catch let error as HQFileSignOutFenceError { throw error }
        catch { throw HQFileSignOutFenceError.unavailable }
    }

    func clear() throws {
        do {
            if fileManager.fileExists(atPath: markerURL.path) { try fileManager.removeItem(at: markerURL) }
            guard !fileManager.fileExists(atPath: markerURL.path) else { throw HQFileSignOutFenceError.unavailable }
        } catch let error as HQFileSignOutFenceError { throw error }
        catch { throw HQFileSignOutFenceError.unavailable }
    }
}

/// Mirrors every transition into two independent persistence mechanisms. All
/// operations attempt both stores; a single surviving marker is sufficient to
/// force fail-closed cleanup after process restart.
actor HQCompositeSignOutFence: HQSignOutFenceStoring {
    private let primary: any HQSignOutFenceStoring
    private let secondary: any HQSignOutFenceStoring

    init(primary: any HQSignOutFenceStoring, secondary: any HQSignOutFenceStoring) {
        self.primary = primary
        self.secondary = secondary
    }

    func isArmed() async throws -> Bool {
        var firstError: Error?
        var armed = false
        do { armed = try await primary.isArmed() || armed } catch { firstError = error }
        do { armed = try await secondary.isArmed() || armed } catch { if firstError == nil { firstError = error } }
        if armed { return true }
        if let firstError { throw firstError }
        return false
    }

    func arm() async throws {
        var firstError: Error?
        do { try await primary.arm() } catch { firstError = error }
        do { try await secondary.arm() } catch { if firstError == nil { firstError = error } }
        if let firstError { throw firstError }
    }

    func clear() async throws {
        var firstError: Error?
        do { try await primary.clear() } catch { firstError = error }
        do { try await secondary.clear() } catch { if firstError == nil { firstError = error } }
        if let firstError { throw firstError }
    }
}

private actor HQAsyncCredentialMutex {
    private var locked = false
    private var waiters: [CheckedContinuation<Void, Never>] = []
    func lock() async {
        if !locked { locked = true; return }
        await withCheckedContinuation { waiters.append($0) }
    }
    func unlock() {
        if waiters.isEmpty { locked = false }
        else { waiters.removeFirst().resume() }
    }
}

enum HQLocalCredentialVaultError: Error, Equatable, LocalizedError {
    case staleSaveCleaned
    case securityFailure
    var errorDescription: String? {
        switch self {
        case .staleSaveCleaned: "A newer authentication action replaced this credential save."
        case .securityFailure: "HQ could not prove that local credentials were removed."
        }
    }
}

/// Serializes credential writes, tombstone transitions, and purges across MainActor
/// reentrancy. Invalidation is recorded before waiting for an in-flight save, so
/// a save that straddles sign-out must clean itself up before releasing the lock.
actor HQLocalCredentialVault {
    private let tokenStore: any HQTokenStoring
    private let fence: any HQSignOutFenceStoring
    private let mutex = HQAsyncCredentialMutex()
    private var invalidatedThrough: UInt64 = 0
    private var securityFailureLatched = false

    init(tokenStore: any HQTokenStoring, fence: any HQSignOutFenceStoring) {
        self.tokenStore = tokenStore
        self.fence = fence
    }

    func load() async throws -> HQAuthTokens? {
        await mutex.lock()
        do {
            guard !securityFailureLatched else { throw HQLocalCredentialVaultError.securityFailure }
            let result = try await tokenStore.load()
            await mutex.unlock()
            return result
        } catch { await mutex.unlock(); throw error }
    }

    func isFenceArmed() async throws -> Bool {
        await mutex.lock()
        do {
            guard !securityFailureLatched else { throw HQLocalCredentialVaultError.securityFailure }
            let result = try await fence.isArmed()
            await mutex.unlock()
            return result
        } catch { await mutex.unlock(); throw error }
    }

    func save(_ tokens: HQAuthTokens, generation: UInt64) async throws {
        await mutex.lock()
        do {
            guard !securityFailureLatched else { throw HQLocalCredentialVaultError.securityFailure }
            guard generation > invalidatedThrough, try await !fence.isArmed() else { throw HQLocalCredentialVaultError.securityFailure }
            try await tokenStore.save(tokens)
            if generation <= invalidatedThrough {
                do { try await fence.arm() }
                catch {
                    _ = try? await tokenStore.purge()
                    securityFailureLatched = true
                    throw HQLocalCredentialVaultError.securityFailure
                }
                do { try await tokenStore.purge() }
                catch { securityFailureLatched = true; throw HQLocalCredentialVaultError.securityFailure }
                throw HQLocalCredentialVaultError.staleSaveCleaned
            }
            await mutex.unlock()
        } catch { await mutex.unlock(); throw error }
    }

    func invalidateAndPurge(generation: UInt64) async throws {
        invalidatedThrough = max(invalidatedThrough, generation)
        await mutex.lock()
        do {
            guard !securityFailureLatched else { throw HQLocalCredentialVaultError.securityFailure }
            do { try await fence.arm() }
            catch {
                _ = try? await tokenStore.purge()
                securityFailureLatched = true
                throw HQLocalCredentialVaultError.securityFailure
            }
            do { try await tokenStore.purge() }
            catch { securityFailureLatched = true; throw HQLocalCredentialVaultError.securityFailure }
            await mutex.unlock()
        } catch { await mutex.unlock(); throw error }
    }

    func hasInvalidated(through generation: UInt64) -> Bool {
        invalidatedThrough >= generation
    }

    func clearFence(generation: UInt64) async throws {
        await mutex.lock()
        do {
            guard !securityFailureLatched else { throw HQLocalCredentialVaultError.securityFailure }
            guard generation == invalidatedThrough else { throw HQLocalCredentialVaultError.staleSaveCleaned }
            do { try await fence.clear() }
            catch { securityFailureLatched = true; throw HQLocalCredentialVaultError.securityFailure }
            await mutex.unlock()
        } catch { await mutex.unlock(); throw error }
    }
}

private extension JSONEncoder {
    static var hqAuth: JSONEncoder { let value = JSONEncoder(); value.dateEncodingStrategy = .iso8601; return value }
}

private extension JSONDecoder {
    static var hqAuth: JSONDecoder { let value = JSONDecoder(); value.dateDecodingStrategy = .iso8601; return value }
}
