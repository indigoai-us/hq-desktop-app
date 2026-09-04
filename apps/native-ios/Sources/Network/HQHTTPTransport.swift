import Foundation

enum HQHTTPMethod: String, Codable, Sendable {
    case get = "GET"
    case post = "POST"
    case put = "PUT"
    case delete = "DELETE"
}

/// Retry eligibility is owned by the audited route matrix. A request cannot
/// opt itself into replay by supplying a retry count.
enum HQRequestReplayClass: Equatable, Sendable {
    case safeRead
    case provenIdempotentMutation
    case unsafeMutation

    var maximumAttempts: Int {
        switch self {
        case .safeRead, .provenIdempotentMutation: 3
        case .unsafeMutation: 1
        }
    }

    var authorizationReplayPolicy: HQAuthorizationReplayPolicy {
        switch self {
        case .safeRead: .safeRead
        case .provenIdempotentMutation: .idempotentMutation
        case .unsafeMutation: .unsafeMutation
        }
    }
}

/// A normalized, credential-safe HTTPS origin. Base URLs must be origins only:
/// no credentials, query, fragment, or non-root path are accepted.
struct HQHTTPSOrigin: Equatable, Sendable {
    static let production = try! HQHTTPSOrigin(validatingBaseURL: URL(string: "https://hqapi.getindigo.ai")!)

    let host: String
    let effectivePort: Int
    let baseURL: URL

    init(validatingBaseURL url: URL) throws {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              components.scheme?.lowercased() == "https",
              let rawHost = components.host,
              !rawHost.isEmpty,
              components.user == nil,
              components.password == nil,
              components.query == nil,
              components.fragment == nil,
              components.path.isEmpty || components.path == "/",
              components.port.map({ (1 ... 65_535).contains($0) }) ?? true
        else { throw HQHTTPTransportError.invalidOrigin }

        let normalizedHost = rawHost.lowercased()
        let port = components.port ?? 443
        var normalized = URLComponents()
        normalized.scheme = "https"
        normalized.host = normalizedHost
        if port != 443 { normalized.port = port }
        normalized.path = ""
        guard let baseURL = normalized.url else { throw HQHTTPTransportError.invalidOrigin }

        host = normalizedHost
        effectivePort = port
        self.baseURL = baseURL
    }

    func contains(_ url: URL) -> Bool {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              components.scheme?.lowercased() == "https",
              components.user == nil,
              components.password == nil,
              components.fragment == nil,
              let requestHost = components.host?.lowercased()
        else { return false }
        return requestHost == host && (components.port ?? 443) == effectivePort
    }
}

struct HQHTTPRequest: Sendable {
    let contractID: String
    let url: URL
    let method: HQHTTPMethod
    let body: Data?
    let requestClass: HQNetworkDiagnostic.RequestClass

    init(contractID: String, url: URL, method: HQHTTPMethod, body: Data? = nil,
         requestClass: HQNetworkDiagnostic.RequestClass) {
        self.contractID = contractID
        self.url = url
        self.method = method
        self.body = body
        self.requestClass = requestClass
    }
}

struct HQHTTPResponse: Sendable {
    let statusCode: Int
    let data: Data
    let requestID: UUID
    let retryCount: Int
}

enum HQHTTPTransportError: Error, Equatable, LocalizedError {
    case insecureURL
    case invalidOrigin
    case invalidAuthorization
    case invalidContract
    case invalidResponse
    case responseTooLarge
    case transportFailure

    var errorDescription: String? {
        switch self {
        case .insecureURL: "HQ requires a secure HTTPS connection."
        case .invalidOrigin: "HQ rejected an untrusted service origin."
        case .invalidAuthorization: "HQ could not prepare a secure session request."
        case .invalidContract: "HQ rejected a request outside the audited route contract."
        case .invalidResponse: "HQ received an invalid network response."
        case .responseTooLarge: "HQ received a response that is too large to process safely."
        case .transportFailure: "HQ could not reach the service."
        }
    }
}

protocol HQHTTPSending: Sendable {
    func send(_ request: HQHTTPRequest, credentials: HQAuthorizationCredentials) async throws -> HQHTTPResponse
}

struct HQLoadedHTTPResponse: Sendable {
    let response: HTTPURLResponse
    let data: Data
}

protocol HQHTTPResponseLoading: Sendable {
    func load(_ request: URLRequest, maximumBytes: Int) async throws -> HQLoadedHTTPResponse
}

/// Streams response bytes and cancels consumption as soon as the hard cap is
/// crossed. Content-Length is rejected before any body is retained.
final class HQURLSessionResponseLoader: HQHTTPResponseLoading, @unchecked Sendable {
    private let session: URLSession

    init(session: URLSession = HQHTTPTransport.secureSession()) {
        self.session = session
    }

    func load(_ request: URLRequest, maximumBytes: Int) async throws -> HQLoadedHTTPResponse {
        let (bytes, rawResponse) = try await session.bytes(for: request, delegate: HQNoRedirectSessionDelegate())
        try Task.checkCancellation()
        guard let response = rawResponse as? HTTPURLResponse else { throw HQHTTPTransportError.invalidResponse }
        if response.expectedContentLength > Int64(maximumBytes) {
            throw HQHTTPTransportError.responseTooLarge
        }

        var data = Data()
        if response.expectedContentLength > 0 {
            data.reserveCapacity(min(maximumBytes, Int(response.expectedContentLength)))
        }
        for try await byte in bytes {
            try Task.checkCancellation()
            guard data.count < maximumBytes else { throw HQHTTPTransportError.responseTooLarge }
            data.append(byte)
        }
        try Task.checkCancellation()
        return HQLoadedHTTPResponse(response: response, data: data)
    }
}

/// The only authenticated HQ API transport. Authorization is formed from the
/// validated Cognito ID token; access and refresh tokens never enter this type.
final class HQHTTPTransport: HQHTTPSending, @unchecked Sendable {
    static let maximumResponseBytes = 1_048_576
    static let maximumRetryAfter: TimeInterval = 5

    private let allowedOrigin: HQHTTPSOrigin
    private let loader: any HQHTTPResponseLoading
    private let diagnostics: HQNetworkDiagnostics
    private let now: @Sendable () -> Date
    private let randomUnit: @Sendable () -> Double
    private let sleep: @Sendable (UInt64) async throws -> Void

    init(allowedOrigin: HQHTTPSOrigin = .production,
         session: URLSession = HQHTTPTransport.secureSession(),
         diagnostics: HQNetworkDiagnostics = .shared,
         now: @escaping @Sendable () -> Date = { .now },
         randomUnit: @escaping @Sendable () -> Double = { Double.random(in: 0 ... 1) },
         sleep: @escaping @Sendable (UInt64) async throws -> Void = { try await Task.sleep(nanoseconds: $0) }) {
        self.allowedOrigin = allowedOrigin
        loader = HQURLSessionResponseLoader(session: session)
        self.diagnostics = diagnostics
        self.now = now
        self.randomUnit = randomUnit
        self.sleep = sleep
    }

    init(allowedOrigin: HQHTTPSOrigin = .production,
         loader: any HQHTTPResponseLoading,
         diagnostics: HQNetworkDiagnostics = .shared,
         now: @escaping @Sendable () -> Date = { .now },
         randomUnit: @escaping @Sendable () -> Double = { Double.random(in: 0 ... 1) },
         sleep: @escaping @Sendable (UInt64) async throws -> Void = { try await Task.sleep(nanoseconds: $0) }) {
        self.allowedOrigin = allowedOrigin
        self.loader = loader
        self.diagnostics = diagnostics
        self.now = now
        self.randomUnit = randomUnit
        self.sleep = sleep
    }

    static func secureSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCredentialStorage = nil
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 30
        configuration.timeoutIntervalForResource = 60
        return URLSession(configuration: configuration, delegate: HQNoRedirectSessionDelegate(), delegateQueue: nil)
    }

    func send(_ request: HQHTTPRequest, credentials: HQAuthorizationCredentials) async throws -> HQHTTPResponse {
        guard request.url.scheme?.lowercased() == "https" else { throw HQHTTPTransportError.insecureURL }
        guard allowedOrigin.contains(request.url) else { throw HQHTTPTransportError.invalidOrigin }
        guard credentials.tokenType == "Bearer", Self.isHeaderSafe(credentials.idToken) else {
            throw HQHTTPTransportError.invalidAuthorization
        }
        guard let descriptor = HQRouteContractMatrix.descriptor(for: request.contractID),
              descriptor.method == request.method,
              descriptor.matches(request.url),
              descriptor.diagnosticClass == request.requestClass,
              Self.method(request.method, permits: descriptor.replayClass)
        else { throw HQHTTPTransportError.invalidContract }

        let requestID = UUID()
        let maximumAttempts = descriptor.replayClass.maximumAttempts
        var attempt = 1

        while true {
            try Task.checkCancellation()
            let startedAt = now()
            do {
                var urlRequest = URLRequest(url: request.url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 30)
                urlRequest.httpMethod = request.method.rawValue
                urlRequest.httpBody = request.body
                urlRequest.httpShouldHandleCookies = false
                urlRequest.setValue(credentials.authorizationHeaderValue, forHTTPHeaderField: "Authorization")
                urlRequest.setValue(requestID.uuidString, forHTTPHeaderField: "X-Request-ID")
                urlRequest.setValue("application/json", forHTTPHeaderField: "Accept")
                if request.body != nil {
                    urlRequest.setValue("application/json; charset=utf-8", forHTTPHeaderField: "Content-Type")
                }

                let loaded = try await loader.load(urlRequest, maximumBytes: Self.maximumResponseBytes)
                try Task.checkCancellation()
                guard loaded.data.count <= Self.maximumResponseBytes else {
                    throw HQHTTPTransportError.responseTooLarge
                }
                let response = loaded.response
                guard response.url == request.url, allowedOrigin.contains(response.url ?? request.url) else {
                    throw HQHTTPTransportError.invalidResponse
                }

                let authentication: HQNetworkDiagnostic.Authentication = response.statusCode == 401 ? .rejected : .authenticated
                if Self.isTransient(response.statusCode), attempt < maximumAttempts {
                    let delay = Self.retryDelay(response: response, retryNumber: attempt, now: now(), randomUnit: randomUnit())
                    await record(requestID: requestID, request: request, startedAt: startedAt, attempt: attempt,
                                 statusCode: response.statusCode, authentication: authentication,
                                 outcome: .retryScheduled, retryDelay: delay)
                    try await sleep(Self.nanoseconds(delay))
                    try Task.checkCancellation()
                    attempt += 1
                    continue
                }

                await record(requestID: requestID, request: request, startedAt: startedAt, attempt: attempt,
                             statusCode: response.statusCode, authentication: authentication,
                             outcome: (200 ... 299).contains(response.statusCode) ? .success : .serverFailure)
                return HQHTTPResponse(statusCode: response.statusCode, data: loaded.data,
                                      requestID: requestID, retryCount: attempt - 1)
            } catch is CancellationError {
                await record(requestID: requestID, request: request, startedAt: startedAt, attempt: attempt,
                             statusCode: nil, authentication: .unavailable, outcome: .cancelled)
                throw CancellationError()
            } catch let error as URLError where error.code == .cancelled {
                await record(requestID: requestID, request: request, startedAt: startedAt, attempt: attempt,
                             statusCode: nil, authentication: .unavailable, outcome: .cancelled)
                throw error
            } catch let error as HQHTTPTransportError {
                let outcome: HQNetworkDiagnostic.Outcome
                switch error {
                case .invalidResponse: outcome = .invalidResponse
                case .responseTooLarge: outcome = .responseRejected
                default: outcome = .transportFailure
                }
                await record(requestID: requestID, request: request, startedAt: startedAt, attempt: attempt,
                             statusCode: nil, authentication: .unavailable, outcome: outcome)
                throw error
            } catch let error as URLError {
                if Self.isTransient(error), attempt < maximumAttempts {
                    let delay = Self.fullJitterDelay(retryNumber: attempt, randomUnit: randomUnit())
                    await record(requestID: requestID, request: request, startedAt: startedAt, attempt: attempt,
                                 statusCode: nil, authentication: .unavailable,
                                 outcome: .retryScheduled, retryDelay: delay)
                    do {
                        try await sleep(Self.nanoseconds(delay))
                        try Task.checkCancellation()
                    } catch is CancellationError {
                        await record(requestID: requestID, request: request, startedAt: startedAt, attempt: attempt,
                                     statusCode: nil, authentication: .unavailable, outcome: .cancelled)
                        throw CancellationError()
                    }
                    attempt += 1
                    continue
                }
                await record(requestID: requestID, request: request, startedAt: startedAt, attempt: attempt,
                             statusCode: nil, authentication: .unavailable, outcome: .transportFailure)
                throw HQHTTPTransportError.transportFailure
            } catch {
                await record(requestID: requestID, request: request, startedAt: startedAt, attempt: attempt,
                             statusCode: nil, authentication: .unavailable, outcome: .transportFailure)
                throw HQHTTPTransportError.transportFailure
            }
        }
    }

    private func record(requestID: UUID, request: HQHTTPRequest, startedAt: Date, attempt: Int,
                        statusCode: Int?, authentication: HQNetworkDiagnostic.Authentication,
                        outcome: HQNetworkDiagnostic.Outcome, retryDelay: TimeInterval? = nil) async {
        await diagnostics.record(HQNetworkDiagnostic(
            id: UUID(),
            requestID: requestID,
            requestClass: request.requestClass,
            statusCode: statusCode,
            latency: max(0, now().timeIntervalSince(startedAt)),
            retryCount: max(0, attempt - 1),
            authentication: authentication,
            outcome: outcome,
            retryDelayMilliseconds: retryDelay.map { min(5_000, max(0, Int(($0 * 1_000).rounded()))) },
            occurredAt: now()
        ))
    }

    static func retryDelay(response: HTTPURLResponse, retryNumber: Int, now: Date, randomUnit: Double) -> TimeInterval {
        if let value = response.value(forHTTPHeaderField: "Retry-After"),
           let serverDelay = retryAfter(value, now: now) {
            return min(maximumRetryAfter, max(0, serverDelay))
        }
        return fullJitterDelay(retryNumber: retryNumber, randomUnit: randomUnit)
    }

    static func retryAfter(_ value: String, now: Date) -> TimeInterval? {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty, trimmed.allSatisfy(\.isNumber), let seconds = UInt64(trimmed) {
            return min(maximumRetryAfter, TimeInterval(seconds))
        }

        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "EEE',' dd MMM yyyy HH':'mm':'ss zzz"
        guard let date = formatter.date(from: trimmed) else { return nil }
        return min(maximumRetryAfter, max(0, date.timeIntervalSince(now)))
    }

    static func fullJitterDelay(retryNumber: Int, randomUnit: Double) -> TimeInterval {
        let cap = min(1.0, 0.2 * pow(2, Double(max(0, retryNumber - 1))))
        let boundedUnit = randomUnit.isFinite ? min(1, max(0, randomUnit)) : 0
        return cap * boundedUnit
    }

    private static func nanoseconds(_ delay: TimeInterval) -> UInt64 {
        UInt64((min(maximumRetryAfter, max(0, delay)) * 1_000_000_000).rounded())
    }

    private static func method(_ method: HQHTTPMethod, permits replayClass: HQRequestReplayClass) -> Bool {
        switch replayClass {
        case .safeRead: method == .get
        case .provenIdempotentMutation: method != .get
        case .unsafeMutation: true
        }
    }

    private static func isTransient(_ status: Int) -> Bool {
        status == 408 || status == 429 || (500 ... 599).contains(status)
    }

    private static func isTransient(_ error: URLError) -> Bool {
        switch error.code {
        case .timedOut, .networkConnectionLost, .notConnectedToInternet,
             .cannotConnectToHost, .dnsLookupFailed, .resourceUnavailable:
            true
        default:
            false
        }
    }

    private static func isHeaderSafe(_ token: String) -> Bool {
        !token.isEmpty && token.utf8.count <= 16_384 && !token.contains(where: { $0.isWhitespace || $0.isNewline })
    }
}
