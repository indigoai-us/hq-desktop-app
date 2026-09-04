import Combine
import Foundation

protocol HQProtectedStateStore: Sendable {
    func purgeProtectedState() async throws
}

protocol HQProtectedStatePurging: Sendable {
    func purgeAllProtectedState() async throws
}

actor HQProtectedStatePurger: HQProtectedStatePurging {
    private var stores: [any HQProtectedStateStore]

    init(stores: [any HQProtectedStateStore] = [HQSubjectCacheOwner.shared]) {
        self.stores = stores
    }

    func register(_ store: any HQProtectedStateStore) { stores.append(store) }

    func purgeAllProtectedState() async throws {
        var firstError: Error?
        for store in stores {
            do { try await store.purgeProtectedState() } catch { if firstError == nil { firstError = error } }
        }
        if let firstError { throw firstError }
    }
}

protocol HQSignOutFenceStoring: Sendable {
    func isArmed() async throws -> Bool
    func arm() async throws
    func clear() async throws
}

enum HQAuthenticationState: Equatable {
    case restoring
    case signedOut(message: String?)
    case signingIn
    case signingOut
    case signedIn(subjectID: String)
    case reauthenticationRequired(message: String)
    case securityResetRequired(message: String)
}

enum HQSessionError: Error, Equatable, LocalizedError {
    case signedOut
    case interactiveSignInRequired(String)
    case unauthorizedAfterRetry
    case unsafeReplayDenied
    case staleTransaction
    case localPurgeFailed(String)

    var errorDescription: String? {
        switch self {
        case .signedOut: "Sign in to continue."
        case let .interactiveSignInRequired(message): message
        case .unauthorizedAfterRetry: "Your HQ session was not accepted. Please sign in again."
        case .unsafeReplayDenied: "HQ did not repeat this change after authorization expired. Sign in and try the change again."
        case .staleTransaction: "A newer authentication action replaced this request."
        case let .localPurgeFailed(message): message
        }
    }
}

enum HQAuthorizationReplayPolicy: Sendable {
    case safeRead
    case idempotentMutation
    case unsafeMutation

    var permitsReplay: Bool { self != .unsafeMutation }
}

struct HQAuthorizedResponse<Value: Sendable>: Sendable {
    let statusCode: Int
    let value: Value?
}

struct HQAuthorizationCredentials: Equatable, Sendable {
    let tokenType: String
    let idToken: String

    var authorizationHeaderValue: String { "\(tokenType) \(idToken)" }
}

@MainActor
final class HQSessionController: ObservableObject {
    @Published private(set) var state: HQAuthenticationState = .signedOut(message: nil)

    private struct RefreshFlight {
        let id: UUID
        let generation: UInt64
        let task: Task<HQAuthTokens, Error>
    }

    private let oauth: any HQTokenRefreshing
    private let interactiveOAuth: (any HQInteractiveOAuthAuthenticating)?
    private let credentialVault: HQLocalCredentialVault
    private let protectedState: any HQProtectedStatePurging
    private let idTokenValidator: any HQIDTokenValidating
    private let clock: @Sendable () -> Date
    private let refreshSkew: TimeInterval
    private var tokens: HQAuthTokens?
    private var refreshFlight: RefreshFlight?
    private var generation: UInt64 = 0
    private var credentialRevision: UInt64 = 0
    private var signInActive = false

    convenience init() {
        let validator = HQCognitoIDTokenValidator()
        let oauth = HQOAuthClient(idTokenValidator: validator)
        self.init(oauth: oauth, interactiveOAuth: oauth, tokenStore: HQKeychainTokenStore(),
                  protectedState: HQProtectedStatePurger(), idTokenValidator: validator)
    }

    init(oauth: any HQTokenRefreshing,
         interactiveOAuth: (any HQInteractiveOAuthAuthenticating)? = nil,
         tokenStore: any HQTokenStoring,
         protectedState: any HQProtectedStatePurging,
         signOutFence: any HQSignOutFenceStoring = HQCompositeSignOutFence(
            primary: HQKeychainSignOutFence(), secondary: HQFileSignOutFence()
         ),
         idTokenValidator: any HQIDTokenValidating = HQCognitoIDTokenValidator(),
         clock: @escaping @Sendable () -> Date = { .now }, refreshSkew: TimeInterval = 90) {
        self.oauth = oauth
        self.interactiveOAuth = interactiveOAuth
        self.credentialVault = HQLocalCredentialVault(tokenStore: tokenStore, fence: signOutFence)
        self.protectedState = protectedState
        self.idTokenValidator = idTokenValidator
        self.clock = clock
        self.refreshSkew = refreshSkew
    }

    var isAuthenticationBusy: Bool { state == .restoring || state == .signingIn || state == .signingOut }
    var canStartSignIn: Bool {
        !isAuthenticationBusy && !signInActive && {
            if case .securityResetRequired = state { return false }
            return true
        }()
    }

    func restoreSession() async {
        guard !isAuthenticationBusy else { return }
        let operationGeneration = beginTransaction()
        state = .restoring
        let pendingSignOut: Bool
        do { pendingSignOut = try await credentialVault.isFenceArmed() }
        catch { presentPurgeFailure(error, generation: operationGeneration); return }
        if pendingSignOut {
            do {
                try await purgeLocalState(generation: operationGeneration)
                guard isCurrent(operationGeneration) else { return }
                state = .signedOut(message: "Sign-out was completed securely.")
            } catch { presentPurgeFailure(error, generation: operationGeneration) }
            return
        }
        do {
            guard let stored = try await credentialVault.load() else {
                guard isCurrent(operationGeneration) else { return }
                state = .signedOut(message: nil)
                return
            }
            let verified = try await idTokenValidator.validateStoredIdentity(stored.idToken, now: clock())
            guard verified.subjectID == stored.subjectID else { throw HQOAuthError.invalidIdentityToken }
            let recovered = HQAuthTokens(idToken: stored.idToken, accessToken: stored.accessToken,
                                         refreshToken: stored.refreshToken, tokenType: stored.tokenType,
                                         expiresAt: min(stored.expiresAt, verified.expiresAt), subjectID: stored.subjectID)
            guard isCurrent(operationGeneration) else { return }
            tokens = recovered
            credentialRevision &+= 1
            let valid = try await validTokens(generation: operationGeneration)
            guard isCurrent(operationGeneration) else { return }
            state = .signedIn(subjectID: valid.subjectID)
        } catch is CancellationError {
            // A caller cancelling its wait must not overwrite a shared refresh
            // that independently completed and installed a valid session.
            return
        } catch {
            if case .reauthenticationRequired = state { return }
            if case .securityResetRequired = state { return }
            await failClosedAfterAuthenticationError(error, generation: operationGeneration)
        }
    }

    func signIn() async {
        guard canStartSignIn else { return }
        guard let interactiveOAuth else {
            state = .reauthenticationRequired(message: "Secure sign-in is unavailable. Please restart HQ and try again.")
            return
        }
        let operationGeneration = beginTransaction()
        signInActive = true
        state = .signingIn
        defer { if isCurrent(operationGeneration) { signInActive = false } }
        do {
            let newTokens = try await interactiveOAuth.authenticate()
            guard isCurrent(operationGeneration) else { return }
            try await install(newTokens, generation: operationGeneration)
        } catch is CancellationError {
            guard isCurrent(operationGeneration) else { return }
            await failClosedAfterAuthenticationError(HQOAuthError.cancelled, generation: operationGeneration, signedOutOnSuccess: true)
        } catch {
            guard isCurrent(operationGeneration) else { return }
            await failClosedAfterAuthenticationError(error, generation: operationGeneration, signedOutOnSuccess: true)
        }
    }

    /// ASWebAuthenticationSession owns auth callbacks. App navigation links are
    /// classified separately and must never destroy a valid session.
    func handleInboundURL(_ url: URL) {
        switch HQInboundURLClassifier.classify(url) {
        case .authenticationCallback, .appNavigation, .unrelated:
            return
        }
    }

    func signOut() async {
        guard state != .signingOut else { return }
        let refreshSnapshot = tokens?.refreshToken
        let operationGeneration = beginTransaction()
        signInActive = false
        tokens = nil
        state = .signingOut
        do {
            try await purgeLocalState(generation: operationGeneration)
            guard isCurrent(operationGeneration) else { return }
        } catch {
            presentPurgeFailure(error, generation: operationGeneration)
            return
        }

        var message: String?
        if let refreshSnapshot {
            do { try await oauth.revoke(refreshToken: refreshSnapshot) }
            catch { message = "Signed out on this device. HQ could not revoke the remote session while offline." }
        }
        guard isCurrent(operationGeneration) else { return }
        state = .signedOut(message: message)
    }

    /// The network layer receives only the validated wire credentials it needs;
    /// the access token and refresh token never cross this boundary.
    func credentials() async throws -> HQAuthorizationCredentials {
        let valid = try await validTokens(generation: generation)
        guard valid.hasValidLocalShape else { throw HQOAuthError.invalidTokenResponse }
        return credentials(from: valid)
    }

    func performAuthorized<Value: Sendable>(replayPolicy: HQAuthorizationReplayPolicy,
                                  _ operation: (HQAuthorizationCredentials) async throws -> HQAuthorizedResponse<Value>) async throws -> Value {
        let operationGeneration = generation
        let initial = try await validTokens(generation: operationGeneration)
        let rejectedRevision = credentialRevision
        let initialCredentials = credentials(from: initial)
        let first = try await operation(initialCredentials)
        guard isCurrent(operationGeneration) else { throw HQSessionError.staleTransaction }
        if first.statusCode != 401, let value = first.value { return value }
        if first.statusCode != 401 { throw HQSessionError.unauthorizedAfterRetry }
        guard replayPolicy.permitsReplay else {
            try await requireReauthentication(after: HQSessionError.unsafeReplayDenied, generation: operationGeneration)
            throw HQSessionError.unsafeReplayDenied
        }

        let retryTokens: HQAuthTokens
        if credentialRevision != rejectedRevision, let current = tokens {
            retryTokens = current
        } else {
            retryTokens = try await refresh(force: true, generation: operationGeneration)
        }
        let retry = try await operation(credentials(from: retryTokens))
        guard isCurrent(operationGeneration) else { throw HQSessionError.staleTransaction }
        if retry.statusCode != 401, let value = retry.value { return value }
        try await requireReauthentication(after: HQSessionError.unauthorizedAfterRetry, generation: operationGeneration)
        throw HQSessionError.unauthorizedAfterRetry
    }

    private func validTokens(generation operationGeneration: UInt64) async throws -> HQAuthTokens {
        guard isCurrent(operationGeneration), let tokens else { throw HQSessionError.signedOut }
        guard tokens.hasValidLocalShape else { throw HQOAuthError.invalidTokenResponse }
        if tokens.expires(within: refreshSkew, now: clock()) { return try await refresh(force: false, generation: operationGeneration) }
        return tokens
    }

    private func refresh(force: Bool, generation operationGeneration: UInt64) async throws -> HQAuthTokens {
        guard isCurrent(operationGeneration), let current = tokens else { throw HQSessionError.signedOut }
        if !force && !current.expires(within: refreshSkew, now: clock()) { return current }
        if let flight = refreshFlight, flight.generation == operationGeneration {
            let result = try await flight.task.value
            try Task.checkCancellation()
            return result
        }

        let id = UUID()
        let oauth = oauth
        let refreshToken = current.refreshToken
        let task = Task { [weak self] () throws -> HQAuthTokens in
            do {
                let result = try await oauth.refresh(refreshToken: refreshToken)
                guard let self else { throw HQSessionError.signedOut }
                return try await self.acceptRefresh(result, id: id, generation: operationGeneration)
            } catch {
                await self?.finishRefreshFailure(error, id: id, generation: operationGeneration)
                throw error
            }
        }
        refreshFlight = RefreshFlight(id: id, generation: operationGeneration, task: task)
        let result = try await task.value
        try Task.checkCancellation()
        return result
    }

    private func acceptRefresh(_ refreshed: HQAuthTokens, id: UUID, generation operationGeneration: UInt64) async throws -> HQAuthTokens {
        guard refreshFlight?.id == id, isCurrent(operationGeneration) else { throw HQSessionError.staleTransaction }
        guard tokens?.subjectID == refreshed.subjectID else { throw HQOAuthError.invalidIdentityToken }
        do {
            try await install(refreshed, generation: operationGeneration)
            if refreshFlight?.id == id { refreshFlight = nil }
            return refreshed
        } catch {
            if refreshFlight?.id == id { refreshFlight = nil }
            throw error
        }
    }

    private func finishRefreshFailure(_ error: Error, id: UUID, generation operationGeneration: UInt64) async {
        guard refreshFlight?.id == id else { return }
        refreshFlight = nil
        guard isCurrent(operationGeneration), !(error is CancellationError), error as? HQSessionError != .staleTransaction else { return }
        await failClosedAfterAuthenticationError(error, generation: operationGeneration)
    }

    private func install(_ newTokens: HQAuthTokens, generation operationGeneration: UInt64) async throws {
        guard isCurrent(operationGeneration) else { throw HQSessionError.staleTransaction }
        let previousSubject = tokens?.subjectID
        if let previousSubject, previousSubject != newTokens.subjectID {
            try await protectedState.purgeAllProtectedState()
            guard isCurrent(operationGeneration) else { throw HQSessionError.staleTransaction }
        }
        let verified = try await idTokenValidator.validate(newTokens.idToken, now: clock())
        guard verified.subjectID == newTokens.subjectID else { throw HQOAuthError.invalidIdentityToken }
        guard isCurrent(operationGeneration) else { throw HQSessionError.staleTransaction }
        try await credentialVault.save(newTokens, generation: operationGeneration)
        guard isCurrent(operationGeneration) else { throw HQSessionError.staleTransaction }
        tokens = newTokens
        credentialRevision &+= 1
        state = .signedIn(subjectID: newTokens.subjectID)
    }

    private func requireReauthentication(after error: Error, generation operationGeneration: UInt64) async throws {
        let next = beginTransaction()
        guard next != operationGeneration else { throw HQSessionError.staleTransaction }
        do {
            try await purgeLocalState(generation: next)
            guard isCurrent(next) else { throw HQSessionError.staleTransaction }
            state = .reauthenticationRequired(message: actionableMessage(for: error))
        } catch {
            presentPurgeFailure(error, generation: next)
            throw error
        }
    }

    private func failClosedAfterAuthenticationError(_ error: Error, generation operationGeneration: UInt64,
                                                     signedOutOnSuccess: Bool = false) async {
        guard isCurrent(operationGeneration) else { return }
        do {
            try await purgeLocalState(generation: operationGeneration)
            guard isCurrent(operationGeneration) else { return }
            state = signedOutOnSuccess ? .signedOut(message: actionableMessage(for: error))
                : .reauthenticationRequired(message: actionableMessage(for: error))
        } catch { presentPurgeFailure(error, generation: operationGeneration) }
    }

    private func purgeLocalState(generation operationGeneration: UInt64) async throws {
        guard isCurrent(operationGeneration) else { throw HQSessionError.staleTransaction }
        tokens = nil
        var firstError: Error?
        do { try await credentialVault.invalidateAndPurge(generation: operationGeneration) }
        catch { firstError = error }
        guard isCurrent(operationGeneration) else { throw HQSessionError.staleTransaction }
        do { try await protectedState.purgeAllProtectedState() }
        catch { if firstError == nil { firstError = error } }
        if let firstError { throw firstError }
        guard isCurrent(operationGeneration) else { throw HQSessionError.staleTransaction }
        try await credentialVault.clearFence(generation: operationGeneration)
    }

    private func presentPurgeFailure(_ error: Error, generation operationGeneration: UInt64) {
        guard isCurrent(operationGeneration) else { return }
        tokens = nil
        state = .securityResetRequired(message: "HQ could not remove secure local session data. \(actionableMessage(for: error))")
    }

    @discardableResult
    private func beginTransaction() -> UInt64 {
        generation &+= 1
        refreshFlight?.task.cancel()
        refreshFlight = nil
        return generation
    }

    private func isCurrent(_ candidate: UInt64) -> Bool { candidate == generation }

    private func actionableMessage(for error: Error) -> String {
        if let error = error as? LocalizedError, let description = error.errorDescription { return description }
        return "Your secure HQ session expired. Please sign in again."
    }

    private func credentials(from tokens: HQAuthTokens) -> HQAuthorizationCredentials {
        HQAuthorizationCredentials(tokenType: tokens.tokenType, idToken: tokens.idToken)
    }
}
