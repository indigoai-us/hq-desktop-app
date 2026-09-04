import CryptoKit
import Foundation

enum HQRealtimeClientError: Error, Equatable, Sendable {
    case invalidEndpoint
    case invalidCredentialExpiry
    case brokerRejected
    case invalidMQTTPacket
    case unsupportedMQTTPacket
    case packetTooLarge
    case operationTimedOut
    case invalidWebSocketSubprotocol
    case invalidWakeEnvelope
    case foreignWakeRecipient
    case duplicateWakeConflict
    case pingTimedOut
}

struct HQRealtimeWake: Equatable, Sendable {
    let topic: String
    let envelope: HQRealtimeWakeEnvelope?

    init(topic: String) {
        self.topic = topic
        envelope = nil
    }

    init(topic: String, envelope: HQRealtimeWakeEnvelope) {
        self.topic = topic
        self.envelope = envelope
    }
}

protocol HQMQTTSession: Sendable {
    func subscribe(topics: [String], qos: UInt8) async throws
    func nextWake() async throws -> HQRealtimeWake?
    func disconnect() async
}

protocol HQMQTTConnecting: Sendable {
    func connect(url: URL, clientID: String, keepAliveSeconds: UInt16) async throws -> any HQMQTTSession
}

/// SigV4 signing is intentionally local and narrow.  It signs only the MQTT
/// websocket handshake and never serializes temporary credentials to logs.
struct HQIoTWebSocketSigner: Sendable {
    private static let algorithm = "AWS4-HMAC-SHA256"
    private static let service = "iotdevicegateway"

    let now: @Sendable () -> Date

    init(now: @escaping @Sendable () -> Date = { .now }) {
        self.now = now
    }

    func signedURL(credentials: HQRealtimeCredentials) throws -> URL {
        guard credentials.credentials.expiration > now() else {
            throw HQRealtimeClientError.invalidCredentialExpiry
        }
        guard let endpoint = normalizedEndpoint(credentials.iotEndpoint) else {
            throw HQRealtimeClientError.invalidEndpoint
        }

        let date = Self.timestamp(now())
        let day = String(date.prefix(8))
        let scope = "\(day)/\(credentials.region)/\(Self.service)/aws4_request"
        let query = [
            ("X-Amz-Algorithm", Self.algorithm),
            ("X-Amz-Credential", "\(credentials.credentials.accessKeyID)/\(scope)"),
            ("X-Amz-Date", date),
            ("X-Amz-SignedHeaders", "host")
        ]
        let canonicalQuery = Self.canonicalQuery(query)
        let canonicalRequest = [
            "GET",
            "/mqtt",
            canonicalQuery,
            "host:\(endpoint)\n",
            "host",
            Self.sha256Hex("")
        ].joined(separator: "\n")
        let stringToSign = [Self.algorithm, date, scope, Self.sha256Hex(canonicalRequest)].joined(separator: "\n")
        let signingKey = Self.signingKey(secret: credentials.credentials.secretAccessKey, day: day, region: credentials.region)
        let signature = Self.hmacHex(key: signingKey, value: stringToSign)

        // AWS IoT's deployed contract is unusual but intentional: the STS
        // session token is appended only after the canonical request is signed.
        let finalQuery = "\(canonicalQuery)&X-Amz-Signature=\(signature)&X-Amz-Security-Token=\(Self.encode(credentials.credentials.sessionToken))"
        guard let url = URL(string: "wss://\(endpoint)/mqtt?\(finalQuery)") else {
            throw HQRealtimeClientError.invalidEndpoint
        }
        return url
    }

    private func normalizedEndpoint(_ value: String) -> String? {
        guard !value.isEmpty, value == value.lowercased(), value.utf8.count <= 253,
              !value.contains("://"), !value.contains("/"), !value.contains(":"),
              !value.contains("?"), !value.contains("#"), !value.contains("@"),
              let components = URLComponents(string: "wss://\(value)"),
              components.scheme?.lowercased() == "wss",
              let host = components.host, host == value,
              components.user == nil, components.password == nil,
              components.port == nil, components.path.isEmpty,
              components.query == nil, components.fragment == nil,
              value.range(
                  of: "^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?-ats\\.iot\\.[a-z0-9]+(?:-[a-z0-9]+){1,4}\\.amazonaws\\.com(?:\\.cn)?$",
                  options: .regularExpression
              ) == (value.startIndex ..< value.endIndex)
        else { return nil }
        return host
    }

    private static func timestamp(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "yyyyMMdd'T'HHmmss'Z'"
        return formatter.string(from: date)
    }

    private static func canonicalQuery(_ items: [(String, String)]) -> String {
        var encoded: [(name: String, value: String)] = []
        for item in items { encoded.append((name: encode(item.0), value: encode(item.1))) }
        encoded.sort { lhs, rhs in lhs.name == rhs.name ? lhs.value < rhs.value : lhs.name < rhs.name }
        return encoded.map { item in "\(item.name)=\(item.value)" }.joined(separator: "&")
    }

    private static func encode(_ value: String) -> String {
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.~")
        return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? ""
    }

    private static func sha256Hex(_ value: String) -> String {
        SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    private static func hmac(key: SymmetricKey, value: String) -> Data {
        Data(HMAC<SHA256>.authenticationCode(for: Data(value.utf8), using: key))
    }

    private static func hmacHex(key: SymmetricKey, value: String) -> String {
        hmac(key: key, value: value).map { String(format: "%02x", $0) }.joined()
    }

    private static func signingKey(secret: String, day: String, region: String) -> SymmetricKey {
        let date = hmac(key: SymmetricKey(data: Data("AWS4\(secret)".utf8)), value: day)
        let regionKey = hmac(key: SymmetricKey(data: date), value: region)
        let serviceKey = hmac(key: SymmetricKey(data: regionKey), value: service)
        return SymmetricKey(data: hmac(key: SymmetricKey(data: serviceKey), value: "aws4_request"))
    }
}

actor HQRealtimeClient {
    enum State: Equatable, Sendable { case idle, connecting, connected, polling, suspended }

    typealias CredentialsProvider = @Sendable () async throws -> HQRealtimeCredentials
    private let credentialsProvider: CredentialsProvider
    private let connector: any HQMQTTConnecting
    private let signer: HQIoTWebSocketSigner
    private let reconciler: HQReconciler
    private let sleep: @Sendable (UInt64) async throws -> Void
    private let now: @Sendable () -> Date
    private let randomUnit: @Sendable () -> Double
    private let pollInterval: TimeInterval
    private let refreshSkew: TimeInterval
    private let stableConnectionInterval: TimeInterval
    private var state: State = .idle
    private var foreground = false
    private var session: (any HQMQTTSession)?
    private var connecting: Task<Void, Never>?
    private var lifecycleGeneration: UInt64 = 0
    private var connectionID: UUID?
    private var listener: Task<Void, Never>?
    private var retry: Task<Void, Never>?
    private var polling: Task<Void, Never>?
    private var credentialRefresh: Task<Void, Never>?
    private var stableConnection: Task<Void, Never>?
    private var wakeReconciliation: Task<Void, Never>?
    private var wakeReconciliationPending = false
    private var failures = 0

    init(credentialsProvider: @escaping CredentialsProvider,
         connector: any HQMQTTConnecting = HQURLSessionMQTTConnector(),
         signer: HQIoTWebSocketSigner = HQIoTWebSocketSigner(),
         reconciler: HQReconciler,
         pollInterval: TimeInterval = 60,
         refreshSkew: TimeInterval = 60,
         stableConnectionInterval: TimeInterval = 30,
         now: @escaping @Sendable () -> Date = { .now },
         randomUnit: @escaping @Sendable () -> Double = { Double.random(in: 0 ... 1) },
         sleep: @escaping @Sendable (UInt64) async throws -> Void = { try await Task.sleep(nanoseconds: $0) }) {
        self.credentialsProvider = credentialsProvider
        self.connector = connector
        self.signer = signer
        self.reconciler = reconciler
        self.pollInterval = max(1, pollInterval)
        self.refreshSkew = max(0, refreshSkew)
        self.stableConnectionInterval = max(1, stableConnectionInterval)
        self.now = now
        self.randomUnit = randomUnit
        self.sleep = sleep
    }

    func foregrounded() async {
        guard !foreground else { return }
        foreground = true
        lifecycleGeneration &+= 1
        let generation = lifecycleGeneration
        startPollingIfNeeded(generation: generation)
        await reconcileQuietly(.foreground, generation: generation)
        await connectIfNeeded(generation: generation)
    }

    func boot() async {
        guard foreground else { return }
        let generation = lifecycleGeneration
        startPollingIfNeeded(generation: generation)
        await reconcileQuietly(.boot, generation: generation)
        await connectIfNeeded(generation: generation)
    }

    func backgrounded() async {
        foreground = false
        lifecycleGeneration &+= 1
        let inFlightConnection = connecting
        let inFlightWakeReconciliation = wakeReconciliation
        connecting = nil
        inFlightConnection?.cancel()
        wakeReconciliation = nil
        wakeReconciliationPending = false
        inFlightWakeReconciliation?.cancel()
        listener?.cancel(); listener = nil
        retry?.cancel(); retry = nil
        polling?.cancel(); polling = nil
        credentialRefresh?.cancel(); credentialRefresh = nil
        stableConnection?.cancel(); stableConnection = nil
        connectionID = nil
        let connectedSession = session
        session = nil
        state = .suspended
        await reconciler.cancel()
        if let connectedSession { await connectedSession.disconnect() }
        if let inFlightConnection { await inFlightConnection.value }
        if let inFlightWakeReconciliation { await inFlightWakeReconciliation.value }
    }

    func sequenceGapDetected() async {
        guard foreground else { return }
        await reconcileQuietly(.sequenceGap, generation: lifecycleGeneration)
    }
    func currentState() -> State { state }

    private func connectIfNeeded(generation: UInt64) async {
        guard isCurrent(generation), session == nil else { return }
        if let connecting {
            await connecting.value
            return
        }
        state = .connecting
        let task = Task { [weak self] in
            guard let self else { return }
            await self.performConnect(generation: generation)
        }
        connecting = task
        await task.value
    }

    private func performConnect(generation: UInt64) async {
        var candidate: (any HQMQTTSession)?
        do {
            let credentials = try await credentialsProvider()
            try Task.checkCancellation()
            guard isCurrent(generation) else { return }
            let url = try signer.signedURL(credentials: credentials)
            let connected = try await connector.connect(url: url, clientID: credentials.clientID, keepAliveSeconds: 45)
            candidate = connected
            guard isCurrent(generation), !Task.isCancelled else {
                await connected.disconnect()
                return
            }
            try await connected.subscribe(topics: credentials.topics.all, qos: 1)
            guard isCurrent(generation), !Task.isCancelled else {
                await connected.disconnect()
                return
            }
            session = connected
            candidate = nil
            let id = UUID()
            connectionID = id
            state = .connected
            startPollingIfNeeded(generation: generation)
            scheduleRefresh(
                expiration: credentials.credentials.expiration,
                generation: generation,
                connectionID: id
            )
            scheduleStableReset(generation: generation, connectionID: id)
            startListener(connected, generation: generation, connectionID: id)
            connecting = nil
            await reconcileQuietly(.reconnect, generation: generation)
        } catch is CancellationError {
            if let candidate { await candidate.disconnect() }
            if lifecycleGeneration == generation {
                connecting = nil
                if foreground { state = .idle }
            }
        } catch {
            if let candidate { await candidate.disconnect() }
            if isCurrent(generation) {
                connecting = nil
                await connectionFailed(generation: generation)
            }
        }
        if lifecycleGeneration == generation { connecting = nil }
    }

    private func startListener(_ connected: any HQMQTTSession,
                               generation: UInt64,
                               connectionID: UUID) {
        listener?.cancel()
        listener = Task { [weak self] in
            do {
                while !Task.isCancelled, let wake = try await connected.nextWake() {
                    await self?.accepted(
                        wake,
                        generation: generation,
                        connectionID: connectionID
                    )
                }
                if !Task.isCancelled {
                    await self?.connectionFailed(
                        generation: generation,
                        connectionID: connectionID
                    )
                }
            } catch is CancellationError {
            } catch {
                await self?.connectionFailed(
                    generation: generation,
                    connectionID: connectionID
                )
            }
        }
    }

    private func accepted(_ wake: HQRealtimeWake,
                          generation: UInt64,
                          connectionID: UUID) {
        guard isCurrent(generation), self.connectionID == connectionID,
              session != nil
        else { return }
        _ = wake // Payload/topic are intentionally not application state.
        wakeReconciliationPending = true
        guard wakeReconciliation == nil else { return }
        wakeReconciliation = Task { [weak self] in
            await self?.drainWakeReconciliations(generation: generation)
        }
    }

    private func drainWakeReconciliations(generation: UInt64) async {
        while isCurrent(generation), wakeReconciliationPending,
              !Task.isCancelled {
            wakeReconciliationPending = false
            await reconcileQuietly(.wake, generation: generation)
        }
        guard lifecycleGeneration == generation else { return }
        wakeReconciliation = nil
    }

    private func connectionFailed(generation: UInt64,
                                  connectionID expectedConnectionID: UUID? = nil) async {
        guard isCurrent(generation) else { return }
        if let expectedConnectionID, connectionID != expectedConnectionID { return }
        listener?.cancel(); listener = nil
        credentialRefresh?.cancel(); credentialRefresh = nil
        stableConnection?.cancel(); stableConnection = nil
        let failedSession = session
        session = nil
        connectionID = nil
        if let failedSession { await failedSession.disconnect() }
        guard isCurrent(generation) else { return }
        state = .polling
        failures = min(failures + 1, 30)
        startPollingIfNeeded(generation: generation)
        scheduleReconnect(generation: generation)
    }

    private func scheduleReconnect(generation: UInt64) {
        guard retry == nil, isCurrent(generation) else { return }
        let seconds = Self.reconnectDelay(failure: failures, randomUnit: randomUnit())
        retry = Task { [weak self] in
            do {
                try await self?.sleep(Self.nanoseconds(seconds))
                guard !Task.isCancelled else { return }
                await self?.clearRetryAndConnect(generation: generation)
            } catch {}
        }
    }

    private func clearRetryAndConnect(generation: UInt64) async {
        guard isCurrent(generation) else { return }
        retry = nil
        await connectIfNeeded(generation: generation)
    }

    private func startPollingIfNeeded(generation: UInt64) {
        guard polling == nil, isCurrent(generation) else { return }
        polling = Task { [weak self] in
            while !Task.isCancelled {
                do {
                    guard let self else { return }
                    try await self.sleep(Self.nanoseconds(self.pollInterval))
                    guard !Task.isCancelled else { return }
                    await self.pollOnce(generation: generation)
                } catch { return }
            }
        }
    }

    private func pollOnce(generation: UInt64) async {
        guard isCurrent(generation) else { return }
        await reconcileQuietly(.polling, generation: generation)
    }

    private func scheduleRefresh(expiration: Date,
                                 generation: UInt64,
        connectionID: UUID) {
        credentialRefresh?.cancel()
        let delay = max(1, expiration.timeIntervalSince(now()) - refreshSkew)
        credentialRefresh = Task { [weak self] in
            do {
                try await self?.sleep(Self.nanoseconds(delay))
                guard !Task.isCancelled else { return }
                await self?.renewCredentials(
                    generation: generation,
                    connectionID: connectionID
                )
            } catch {}
        }
    }

    private func renewCredentials(generation: UInt64, connectionID: UUID) async {
        guard isCurrent(generation), self.connectionID == connectionID else { return }
        credentialRefresh = nil
        stableConnection?.cancel(); stableConnection = nil
        listener?.cancel(); listener = nil
        let expiredSession = session
        session = nil
        self.connectionID = nil
        state = .idle
        if let expiredSession { await expiredSession.disconnect() }
        guard isCurrent(generation) else { return }
        await connectIfNeeded(generation: generation)
    }

    private func scheduleStableReset(generation: UInt64, connectionID: UUID) {
        stableConnection?.cancel()
        let delay = stableConnectionInterval
        stableConnection = Task { [weak self] in
            do {
                try await self?.sleep(Self.nanoseconds(delay))
                guard !Task.isCancelled else { return }
                await self?.markConnectionStable(
                    generation: generation,
                    connectionID: connectionID
                )
            } catch {}
        }
    }

    private func markConnectionStable(generation: UInt64, connectionID: UUID) {
        guard isCurrent(generation), self.connectionID == connectionID,
              session != nil
        else { return }
        failures = 0
        stableConnection = nil
    }

    static func reconnectDelay(failure: Int, randomUnit: Double) -> TimeInterval {
        let exponent = max(0, min(failure - 1, 30))
        let ceiling = min(pow(2, Double(exponent)), 60)
        let unit = max(0, min(randomUnit, 1))
        return max(0.25, ceiling * unit)
    }

    private static func nanoseconds(_ seconds: TimeInterval) -> UInt64 {
        let maximum = TimeInterval(UInt64.max) / 1_000_000_000
        return UInt64(min(max(0, seconds), maximum) * 1_000_000_000)
    }

    private func reconcileQuietly(_ reason: HQReconciler.Reason,
                                  generation: UInt64) async {
        guard isCurrent(generation) else { return }
        do { try await reconciler.reconcile(reason) } catch { /* fallback state is intentionally non-modal */ }
    }

    private func isCurrent(_ generation: UInt64) -> Bool {
        foreground && lifecycleGeneration == generation
    }
}
