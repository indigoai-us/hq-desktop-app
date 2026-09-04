import AuthenticationServices
import CryptoKit
import Foundation
import Security
import UIKit

struct HQOAuthConfiguration: Equatable, Sendable {
    let hostedDomain: URL
    let clientID: String
    let redirectURI: URL
    let scopes: [String]

    static let production = HQOAuthConfiguration(
        hostedDomain: URL(string: "https://vault-indigo-hq-prod.auth.us-east-1.amazoncognito.com")!,
        clientID: "7acei2c8v870enheptb1j5foln",
        redirectURI: URL(string: "hqmobile://auth")!,
        scopes: ["openid", "email", "profile"]
    )

    var authorizationEndpoint: URL { hostedDomain.appending(path: "/oauth2/authorize") }
    var tokenEndpoint: URL { hostedDomain.appending(path: "/oauth2/token") }
    var revocationEndpoint: URL { hostedDomain.appending(path: "/oauth2/revoke") }
}

enum HQOAuthError: Error, Equatable, LocalizedError {
    case cancelled
    case concurrentSignIn
    case invalidRedirect
    case stateMismatch
    case missingAuthorizationCode
    case provider(code: String, description: String?)
    case randomGenerationFailed(OSStatus)
    case invalidTokenResponse
    case tokenExchangeFailed(statusCode: Int)
    case invalidIdentityToken
    case webAuthenticationUnavailable

    var errorDescription: String? {
        switch self {
        case .cancelled: "Sign-in was cancelled. You can try again when ready."
        case .concurrentSignIn: "A secure sign-in is already in progress."
        case .invalidRedirect: "HQ received an invalid sign-in callback. Please try signing in again."
        case .stateMismatch: "The sign-in response did not match this request. Please try again."
        case .missingAuthorizationCode: "The sign-in response did not contain an authorization code."
        case let .provider(code, description):
            description.map { "The identity provider declined sign-in (\(code)): \($0)" }
                ?? "The identity provider declined sign-in (\(code))."
        case .randomGenerationFailed: "HQ could not create a secure sign-in request. Please try again."
        case .invalidTokenResponse: "HQ could not read the secure sign-in response."
        case .tokenExchangeFailed: "HQ could not finish secure sign-in. Please try again."
        case .invalidIdentityToken: "HQ could not identify this secure session. Please sign in again."
        case .webAuthenticationUnavailable: "Secure sign-in is not available from this device right now."
        }
    }
}

protocol HQOAuthTransport: Sendable {
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)
}

struct HQURLSessionOAuthTransport: HQOAuthTransport {
    private let session: URLSession
    init(session: URLSession = HQURLSessionOAuthTransport.secureSession()) { self.session = session }

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        guard let requestedURL = request.url, requestedURL.scheme == "https", requestedURL.port == nil,
              requestedURL.host == "vault-indigo-hq-prod.auth.us-east-1.amazoncognito.com",
              requestedURL.path == "/oauth2/token" || requestedURL.path == "/oauth2/revoke",
              request.httpBody?.count ?? 0 <= 65_536 else { throw HQOAuthError.invalidTokenResponse }
        var hardened = request
        hardened.cachePolicy = .reloadIgnoringLocalCacheData
        hardened.httpShouldHandleCookies = false
        let (bytes, response) = try await session.bytes(for: hardened)
        try Task.checkCancellation()
        guard let response = response as? HTTPURLResponse, response.url == requestedURL,
              response.url?.scheme == "https", response.url?.port == nil,
              response.expectedContentLength <= 262_144 || response.expectedContentLength < 0 else { throw HQOAuthError.invalidTokenResponse }
        var data = Data()
        data.reserveCapacity(response.expectedContentLength > 0 ? Int(response.expectedContentLength) : 0)
        for try await byte in bytes {
            guard data.count < 262_144 else { throw HQOAuthError.invalidTokenResponse }
            data.append(byte)
        }
        try Task.checkCancellation()
        return (data, response)
    }

    static func secureSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCredentialStorage = nil
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: configuration, delegate: HQOAuthNoRedirectDelegate(), delegateQueue: nil)
    }
}

final class HQOAuthNoRedirectDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

protocol HQRandomByteGenerating: Sendable {
    func bytes(count: Int) throws -> Data
}

struct HQSystemRandomByteGenerator: HQRandomByteGenerating {
    func bytes(count: Int) throws -> Data {
        var bytes = [UInt8](repeating: 0, count: count)
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        guard status == errSecSuccess else { throw HQOAuthError.randomGenerationFailed(status) }
        return Data(bytes)
    }
}

@MainActor
protocol HQWebAuthenticationPresenting: AnyObject {
    func authenticate(url: URL, callbackScheme: String) async throws -> URL
}

@MainActor
final class HQASWebAuthenticationPresenter: NSObject, HQWebAuthenticationPresenting, ASWebAuthenticationPresentationContextProviding {
    private struct ActiveTransaction {
        let id: UUID
        let session: ASWebAuthenticationSession
        let continuation: CheckedContinuation<URL, Error>
    }

    private var active: ActiveTransaction?

    func authenticate(url: URL, callbackScheme: String) async throws -> URL {
        guard active == nil else { throw HQOAuthError.concurrentSignIn }
        let transactionID = UUID()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                let session = ASWebAuthenticationSession(url: url, callbackURLScheme: callbackScheme) { [weak self] callbackURL, error in
                    Task { @MainActor in self?.finish(id: transactionID, callbackURL: callbackURL, error: error) }
                }
                session.presentationContextProvider = self
                active = ActiveTransaction(id: transactionID, session: session, continuation: continuation)
                guard !Task.isCancelled else {
                    cancel(id: transactionID)
                    return
                }
                guard session.start() else {
                    finish(id: transactionID, result: .failure(HQOAuthError.webAuthenticationUnavailable))
                    return
                }
            }
        } onCancel: {
            Task { @MainActor [weak self] in self?.cancel(id: transactionID) }
        }
    }

    private func finish(id: UUID, callbackURL: URL?, error: Error?) {
        if let webError = error as? ASWebAuthenticationSessionError, webError.code == .canceledLogin {
            finish(id: id, result: .failure(HQOAuthError.cancelled))
        } else if let error {
            finish(id: id, result: .failure(error))
        } else if let callbackURL {
            finish(id: id, result: .success(callbackURL))
        } else {
            finish(id: id, result: .failure(HQOAuthError.invalidRedirect))
        }
    }

    private func finish(id: UUID, result: Result<URL, Error>) {
        guard let transaction = active, transaction.id == id else { return }
        active = nil
        transaction.continuation.resume(with: result)
    }

    private func cancel(id: UUID) {
        guard let transaction = active, transaction.id == id else { return }
        transaction.session.cancel()
        finish(id: id, result: .failure(CancellationError()))
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows).first(where: { $0.isKeyWindow }) ?? ASPresentationAnchor()
    }
}

protocol HQTokenRefreshing: AnyObject, Sendable {
    func refresh(refreshToken: String) async throws -> HQAuthTokens
    func revoke(refreshToken: String) async throws
}

@MainActor
protocol HQInteractiveOAuthAuthenticating: HQTokenRefreshing {
    func authenticate() async throws -> HQAuthTokens
}

enum HQInboundURLClassification: Equatable {
    case authenticationCallback
    case appNavigation
    case unrelated
}

struct HQInboundURLClassifier {
    static func classify(_ url: URL) -> HQInboundURLClassification {
        guard url.scheme?.lowercased() == "hqmobile" else { return .unrelated }
        return url.host?.lowercased() == "auth" ? .authenticationCallback : .appNavigation
    }
}

@MainActor
final class HQOAuthClient: HQInteractiveOAuthAuthenticating {
    private let configuration: HQOAuthConfiguration
    private let transport: any HQOAuthTransport
    private let presenter: any HQWebAuthenticationPresenting
    private let random: any HQRandomByteGenerating
    private let idTokenValidator: any HQIDTokenValidating
    private let clock: @Sendable () -> Date
    private var authenticationInProgress = false

    init(configuration: HQOAuthConfiguration = .production,
         transport: any HQOAuthTransport = HQURLSessionOAuthTransport(),
         presenter: any HQWebAuthenticationPresenting = HQASWebAuthenticationPresenter(),
         random: any HQRandomByteGenerating = HQSystemRandomByteGenerator(),
         idTokenValidator: any HQIDTokenValidating = HQCognitoIDTokenValidator(),
         clock: @escaping @Sendable () -> Date = { .now }) {
        self.configuration = configuration
        self.transport = transport
        self.presenter = presenter
        self.random = random
        self.idTokenValidator = idTokenValidator
        self.clock = clock
    }

    func authenticate() async throws -> HQAuthTokens {
        guard !authenticationInProgress else { throw HQOAuthError.concurrentSignIn }
        authenticationInProgress = true
        defer { authenticationInProgress = false }
        let state = try randomURLSafeString(byteCount: 32)
        let verifier = try randomURLSafeString(byteCount: 64)
        guard state != verifier, (43...128).contains(verifier.count) else { throw HQOAuthError.randomGenerationFailed(errSecParam) }
        let callback = try await presenter.authenticate(url: authorizationURL(state: state, verifier: verifier), callbackScheme: configuration.redirectURI.scheme ?? "hqmobile")
        try Task.checkCancellation()
        let code = try authorizationCode(from: callback, expectedState: state)
        try Task.checkCancellation()
        let tokens = try await exchangeAuthorizationCode(code, verifier: verifier)
        try Task.checkCancellation()
        return tokens
    }

    func authorizationURL(state: String, verifier: String) -> URL {
        var components = URLComponents(url: configuration.authorizationEndpoint, resolvingAgainstBaseURL: false)!
        components.queryItems = [
            URLQueryItem(name: "response_type", value: "code"), URLQueryItem(name: "client_id", value: configuration.clientID),
            URLQueryItem(name: "redirect_uri", value: configuration.redirectURI.absoluteString), URLQueryItem(name: "scope", value: configuration.scopes.joined(separator: " ")),
            URLQueryItem(name: "state", value: state), URLQueryItem(name: "code_challenge_method", value: "S256"),
            URLQueryItem(name: "code_challenge", value: Self.pkceChallenge(for: verifier)),
        ]
        return components.url!
    }

    func authorizationCode(from callback: URL, expectedState: String) throws -> String {
        guard Self.isRegisteredCallback(callback, redirectURI: configuration.redirectURI),
              let items = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems else { throw HQOAuthError.invalidRedirect }
        let stateItems = items.filter { $0.name == "state" }
        guard stateItems.count == 1, let state = stateItems[0].value, Self.isStrictOAuthValue(state) else { throw HQOAuthError.invalidRedirect }
        guard state == expectedState else { throw HQOAuthError.stateMismatch }
        let codeItems = items.filter { $0.name == "code" }
        let errorItems = items.filter { $0.name == "error" }
        let descriptionItems = items.filter { $0.name == "error_description" }
        guard codeItems.count <= 1, errorItems.count <= 1, descriptionItems.count <= 1,
              (codeItems.count == 1) != (errorItems.count == 1) else { throw HQOAuthError.invalidRedirect }
        if codeItems.count == 1 {
            guard let code = codeItems[0].value else { throw HQOAuthError.invalidRedirect }
            guard descriptionItems.isEmpty, Self.isStrictOAuthValue(code) else { throw HQOAuthError.invalidRedirect }
            return code
        }
        guard let providerCode = errorItems[0].value, Self.isStrictOAuthValue(providerCode) else { throw HQOAuthError.invalidRedirect }
        let description = descriptionItems.first?.value
        if let description, !Self.isSafeProviderDescription(description) { throw HQOAuthError.invalidRedirect }
        throw HQOAuthError.provider(code: providerCode, description: description)
    }

    func refresh(refreshToken: String) async throws -> HQAuthTokens {
        guard Self.isStrictTokenString(refreshToken) else { throw HQOAuthError.invalidTokenResponse }
        let response = try await tokenRequest(["grant_type": "refresh_token", "client_id": configuration.clientID, "refresh_token": refreshToken])
        try Task.checkCancellation()
        return try await tokens(from: response, fallbackRefreshToken: refreshToken)
    }

    func revoke(refreshToken: String) async throws {
        guard Self.isStrictTokenString(refreshToken) else { throw HQOAuthError.invalidTokenResponse }
        var request = URLRequest(url: configuration.revocationEndpoint)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        request.httpBody = Self.formData(["client_id": configuration.clientID, "token": refreshToken])
        let (_, response) = try await transport.send(request)
        guard (200..<300).contains(response.statusCode) else { throw HQOAuthError.tokenExchangeFailed(statusCode: response.statusCode) }
    }

    static func pkceChallenge(for verifier: String) -> String {
        Data(SHA256.hash(data: Data(verifier.utf8))).base64URLEncodedString()
    }

    static func isRegisteredCallback(_ url: URL, redirectURI: URL = HQOAuthConfiguration.production.redirectURI) -> Bool {
        guard let callback = URLComponents(url: url, resolvingAgainstBaseURL: false), let registered = URLComponents(url: redirectURI, resolvingAgainstBaseURL: false) else { return false }
        return callback.scheme?.lowercased() == registered.scheme?.lowercased()
            && callback.host?.lowercased() == registered.host?.lowercased()
            && callback.port == nil && registered.port == nil && callback.path.isEmpty && registered.path.isEmpty
            && callback.user == nil && callback.password == nil && callback.fragment == nil
    }

    private func exchangeAuthorizationCode(_ code: String, verifier: String) async throws -> HQAuthTokens {
        let response = try await tokenRequest(["grant_type": "authorization_code", "client_id": configuration.clientID, "redirect_uri": configuration.redirectURI.absoluteString, "code": code, "code_verifier": verifier])
        try Task.checkCancellation()
        return try await tokens(from: response, fallbackRefreshToken: nil)
    }

    private func tokenRequest(_ parameters: [String: String]) async throws -> Data {
        var request = URLRequest(url: configuration.tokenEndpoint)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        request.httpBody = Self.formData(parameters)
        let (data, response) = try await transport.send(request)
        guard (200..<300).contains(response.statusCode) else { throw HQOAuthError.tokenExchangeFailed(statusCode: response.statusCode) }
        return data
    }

    private func tokens(from data: Data, fallbackRefreshToken: String?) async throws -> HQAuthTokens {
        let response: TokenResponse
        do { response = try JSONDecoder().decode(TokenResponse.self, from: data) } catch { throw HQOAuthError.invalidTokenResponse }
        guard [response.idToken, response.accessToken, response.tokenType].allSatisfy(Self.isStrictTokenString),
              response.tokenType == "Bearer", response.expiresIn > 0, response.expiresIn <= 2_592_000 else { throw HQOAuthError.invalidTokenResponse }
        if let received = response.refreshToken, !Self.isStrictTokenString(received) { throw HQOAuthError.invalidTokenResponse }
        guard let refreshToken = response.refreshToken ?? fallbackRefreshToken, Self.isStrictTokenString(refreshToken) else { throw HQOAuthError.invalidIdentityToken }
        let validated: HQValidatedIDToken
        do { validated = try await idTokenValidator.validate(response.idToken, now: clock()) }
        catch is CancellationError { throw CancellationError() }
        catch { throw HQOAuthError.invalidIdentityToken }
        let expiresAt = min(clock().addingTimeInterval(TimeInterval(response.expiresIn)), validated.expiresAt)
        guard expiresAt.timeIntervalSinceReferenceDate.isFinite else { throw HQOAuthError.invalidTokenResponse }
        return HQAuthTokens(idToken: response.idToken, accessToken: response.accessToken, refreshToken: refreshToken, tokenType: "Bearer", expiresAt: expiresAt, subjectID: validated.subjectID)
    }

    private struct TokenResponse: Decodable {
        let idToken: String; let accessToken: String; let refreshToken: String?; let tokenType: String; let expiresIn: Int
        enum CodingKeys: String, CodingKey { case idToken = "id_token"; case accessToken = "access_token"; case refreshToken = "refresh_token"; case tokenType = "token_type"; case expiresIn = "expires_in" }
    }

    private func randomURLSafeString(byteCount: Int) throws -> String { try random.bytes(count: byteCount).base64URLEncodedString() }
    private static func isStrictOAuthValue(_ value: String) -> Bool {
        !value.isEmpty && !value.unicodeScalars.contains { CharacterSet.whitespacesAndNewlines.contains($0) || CharacterSet.controlCharacters.contains($0) }
    }
    private static func isSafeProviderDescription(_ value: String) -> Bool {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return !trimmed.isEmpty && value == trimmed && !value.unicodeScalars.contains { CharacterSet.controlCharacters.contains($0) }
    }
    private static func isStrictTokenString(_ value: String) -> Bool { isStrictOAuthValue(value) }
    private static func formData(_ values: [String: String]) -> Data? {
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~"))
        return values.sorted(by: { $0.key < $1.key }).map { key, value in
            "\(key.addingPercentEncoding(withAllowedCharacters: allowed) ?? key)=\(value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value)"
        }.joined(separator: "&").data(using: .utf8)
    }
}

private extension Data {
    func base64URLEncodedString() -> String {
        base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
}
