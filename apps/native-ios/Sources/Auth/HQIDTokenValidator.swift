import Foundation
import Security

struct HQJSONWebKey: Codable, Equatable, Sendable {
    let kid: String
    let kty: String
    let n: String
    let e: String
    let use: String?
    let alg: String?
}

enum HQIDTokenValidationError: Error, Equatable, LocalizedError {
    case malformed
    case unsupportedAlgorithm
    case unknownKey
    case invalidSignature
    case invalidIssuer
    case invalidAudience
    case expired
    case invalidTokenUse
    case invalidSubject
    case invalidJWKS

    var errorDescription: String? { "HQ could not validate the identity provider session. Please sign in again." }
}

protocol HQIDTokenValidating: Sendable {
    func validate(_ token: String, now: Date) async throws -> HQValidatedIDToken
    /// Verifies every cryptographic and identity binding needed before a stored
    /// refresh token may be used. Expiration is intentionally reported in the
    /// result instead of rejected so an otherwise authentic, expired ID token
    /// can bootstrap Cognito's refresh-token grant.
    func validateStoredIdentity(_ token: String, now: Date) async throws -> HQValidatedIDToken
}

extension HQIDTokenValidating {
    func validateStoredIdentity(_ token: String, now: Date) async throws -> HQValidatedIDToken {
        try await validate(token, now: now)
    }
}

struct HQValidatedIDToken: Equatable, Sendable {
    let subjectID: String
    let expiresAt: Date
}

struct HQIDTokenClockPolicy: Equatable, Sendable {
    let allowedSkew: TimeInterval
    let maximumLifetime: TimeInterval
    static let production = HQIDTokenClockPolicy(allowedSkew: 60, maximumLifetime: 86_400)
}

struct HQJWKSResponse: Sendable {
    let keys: [HQJSONWebKey]
    let maxAge: TimeInterval?
}

protocol HQJWKSProviding: Sendable {
    func keys() async throws -> HQJWKSResponse
}

protocol HQJWTSignatureVerifying: Sendable {
    func verify(message: Data, signature: Data, key: HQJSONWebKey) throws -> Bool
}

struct HQPinnedCognitoJWKSProvider: HQJWKSProviding {
    let issuer: URL
    private let session: URLSession

    init(issuer: URL, session: URLSession = HQPinnedCognitoJWKSProvider.secureSession()) {
        self.issuer = issuer
        self.session = session
    }

    func keys() async throws -> HQJWKSResponse {
        guard issuer.scheme == "https", issuer.user == nil, issuer.password == nil,
              issuer.query == nil, issuer.fragment == nil,
              issuer.host == "cognito-idp.us-east-1.amazonaws.com",
              issuer.path == "/us-east-1_AXf6Kb5nE"
        else { throw HQIDTokenValidationError.invalidIssuer }
        let url = issuer.appending(path: ".well-known/jwks.json")
        let (bytes, response) = try await session.bytes(from: url)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200,
              http.url == url, http.url?.scheme == "https", http.url?.port == nil,
              http.expectedContentLength <= 262_144 || http.expectedContentLength < 0 else { throw HQIDTokenValidationError.invalidJWKS }
        let mime = http.mimeType?.lowercased()
        guard mime == "application/json" || mime == "application/jwk-set+json" else { throw HQIDTokenValidationError.invalidJWKS }
        var data = Data()
        data.reserveCapacity(http.expectedContentLength > 0 ? Int(http.expectedContentLength) : 0)
        for try await byte in bytes {
            guard data.count < 262_144 else { throw HQIDTokenValidationError.invalidJWKS }
            data.append(byte)
        }
        try Task.checkCancellation()
        let document = try JSONDecoder().decode(JWKSDocument.self, from: data)
        guard !document.keys.isEmpty, document.keys.count <= 16 else { throw HQIDTokenValidationError.invalidJWKS }
        return HQJWKSResponse(keys: document.keys, maxAge: Self.maxAge(http.value(forHTTPHeaderField: "Cache-Control")))
    }

    private struct JWKSDocument: Decodable { let keys: [HQJSONWebKey] }

    static func secureSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCredentialStorage = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: configuration, delegate: HQNoRedirectSessionDelegate(), delegateQueue: nil)
    }

    private static func maxAge(_ cacheControl: String?) -> TimeInterval? {
        guard let cacheControl else { return nil }
        for directive in cacheControl.split(separator: ",") {
            let parts = directive.trimmingCharacters(in: .whitespaces).split(separator: "=", maxSplits: 1)
            if parts.count == 2, parts[0].lowercased() == "max-age", let seconds = TimeInterval(parts[1]) { return seconds }
        }
        return nil
    }
}

final class HQNoRedirectSessionDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

struct HQRS256SignatureVerifier: HQJWTSignatureVerifying {
    func verify(message: Data, signature: Data, key: HQJSONWebKey) throws -> Bool {
        guard key.kty == "RSA", key.alg == "RS256", key.use == "sig",
              let modulus = Data(hqBase64URL: key.n), let exponent = Data(hqBase64URL: key.e),
              modulus.count == 256, exponent == Data([1, 0, 1]), signature.count == 256 else { throw HQIDTokenValidationError.invalidJWKS }
        let rsa = Self.sequence(Self.integer(modulus), Self.integer(exponent))
        let attributes: [CFString: Any] = [
            kSecAttrKeyType: kSecAttrKeyTypeRSA,
            kSecAttrKeyClass: kSecAttrKeyClassPublic,
            kSecAttrKeySizeInBits: modulus.count * 8,
        ]
        var error: Unmanaged<CFError>?
        guard let publicKey = SecKeyCreateWithData(rsa as CFData, attributes as CFDictionary, &error) else {
            throw HQIDTokenValidationError.invalidJWKS
        }
        return SecKeyVerifySignature(publicKey, .rsaSignatureMessagePKCS1v15SHA256,
                                     message as CFData, signature as CFData, &error)
    }

    private static func integer(_ bytes: Data) -> Data {
        var value = bytes.drop(while: { $0 == 0 })
        if value.isEmpty { value = Data([0]) }
        var content = Data(value)
        if let first = content.first, first & 0x80 != 0 { content.insert(0, at: 0) }
        return Data([0x02]) + length(content.count) + content
    }

    private static func sequence(_ values: Data...) -> Data {
        let content = values.reduce(into: Data(), { $0.append($1) })
        return Data([0x30]) + length(content.count) + content
    }

    private static func length(_ count: Int) -> Data {
        if count < 128 { return Data([UInt8(count)]) }
        var value = count
        var bytes: [UInt8] = []
        while value > 0 { bytes.insert(UInt8(value & 0xff), at: 0); value >>= 8 }
        return Data([0x80 | UInt8(bytes.count)] + bytes)
    }
}

actor HQCognitoIDTokenValidator: HQIDTokenValidating {
    static let productionIssuer = URL(string: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_AXf6Kb5nE")!
    static let productionAudience = "7acei2c8v870enheptb1j5foln"

    private let issuer: URL
    private let audience: String
    private let jwks: any HQJWKSProviding
    private let verifier: any HQJWTSignatureVerifying
    private let clockPolicy: HQIDTokenClockPolicy
    private var cachedKeys: [String: HQJSONWebKey] = [:]
    private var cacheExpiresAt = Date.distantPast
    private var lastFetchAt = Date.distantPast
    private struct FetchFlight {
        let id: UUID
        let generation: UInt64
        let task: Task<HQJWKSResponse, Error>
    }
    private var fetchFlight: FetchFlight?
    private var fetchGeneration: UInt64 = 0
    private var lastFetchFailureAt = Date.distantPast

    init(issuer: URL = productionIssuer, audience: String = productionAudience,
         jwks: (any HQJWKSProviding)? = nil,
         verifier: any HQJWTSignatureVerifying = HQRS256SignatureVerifier(),
         clockPolicy: HQIDTokenClockPolicy = .production) {
        self.issuer = issuer
        self.audience = audience
        self.jwks = jwks ?? HQPinnedCognitoJWKSProvider(issuer: issuer)
        self.verifier = verifier
        self.clockPolicy = clockPolicy
    }

    func validate(_ token: String, now: Date) async throws -> HQValidatedIDToken {
        try await validate(token, now: now, permitsExpiredIdentity: false)
    }

    func validateStoredIdentity(_ token: String, now: Date) async throws -> HQValidatedIDToken {
        try await validate(token, now: now, permitsExpiredIdentity: true)
    }

    private func validate(_ token: String, now: Date, permitsExpiredIdentity: Bool) async throws -> HQValidatedIDToken {
        guard token.utf8.count <= 16_384 else { throw HQIDTokenValidationError.malformed }
        let parts = token.split(separator: ".", omittingEmptySubsequences: false).map(String.init)
        guard parts.count == 3, parts.allSatisfy(Self.isCanonicalBase64URL),
              parts.allSatisfy({ $0.utf8.count <= 8_192 }),
              let headerData = Data(hqBase64URL: parts[0]),
              let claimsData = Data(hqBase64URL: parts[1]),
              let signature = Data(hqBase64URL: parts[2]),
              Self.hasUniqueSecurityMembers(headerData, names: ["alg", "kid"]),
              Self.hasUniqueSecurityMembers(claimsData, names: ["iss", "aud", "exp", "iat", "nbf", "sub", "token_use"])
        else { throw HQIDTokenValidationError.malformed }
        let header = try decode(Header.self, from: headerData)
        guard header.alg == "RS256" else { throw HQIDTokenValidationError.unsupportedAlgorithm }
        guard isStrict(header.kid), header.kid.utf8.count <= 256 else { throw HQIDTokenValidationError.unknownKey }

        var key = now < cacheExpiresAt ? cachedKeys[header.kid] : nil
        if key == nil {
            if !cachedKeys.isEmpty, now < cacheExpiresAt, now.timeIntervalSince(lastFetchAt) < 30 {
                throw HQIDTokenValidationError.unknownKey
            }
            if now.timeIntervalSince(lastFetchFailureAt) < 30 { throw HQIDTokenValidationError.unknownKey }
            let fetched = try await fetchKeys(now: now)
            key = fetched[header.kid]
        }
        guard let key else { throw HQIDTokenValidationError.unknownKey }
        guard let modulus = Data(hqBase64URL: key.n), signature.count == modulus.count else {
            throw HQIDTokenValidationError.invalidSignature
        }
        let message = Data("\(parts[0]).\(parts[1])".utf8)
        guard try verifier.verify(message: message, signature: signature, key: key) else {
            throw HQIDTokenValidationError.invalidSignature
        }

        let claims = try decode(Claims.self, from: claimsData)
        guard claims.iss.utf8.count <= 2_048, claims.aud.utf8.count <= 512, claims.sub.utf8.count <= 512,
              claims.iss == issuer.absoluteString else { throw HQIDTokenValidationError.invalidIssuer }
        guard claims.aud == audience else { throw HQIDTokenValidationError.invalidAudience }
        let timestamp = now.timeIntervalSince1970
        let exp = TimeInterval(claims.exp)
        let iat = TimeInterval(claims.iat)
        guard (permitsExpiredIdentity || exp > timestamp - clockPolicy.allowedSkew),
              iat <= timestamp + clockPolicy.allowedSkew,
              exp > iat, exp - iat <= clockPolicy.maximumLifetime else { throw HQIDTokenValidationError.expired }
        if let nbf = claims.nbf {
            guard TimeInterval(nbf) <= timestamp + clockPolicy.allowedSkew else { throw HQIDTokenValidationError.expired }
        }
        guard claims.tokenUse == "id" else { throw HQIDTokenValidationError.invalidTokenUse }
        guard isStrict(claims.sub) else { throw HQIDTokenValidationError.invalidSubject }
        try Task.checkCancellation()
        return HQValidatedIDToken(subjectID: claims.sub, expiresAt: Date(timeIntervalSince1970: exp))
    }

    private func fetchKeys(now: Date) async throws -> [String: HQJSONWebKey] {
        let flight: FetchFlight
        if let fetchFlight { flight = fetchFlight }
        else {
            let provider = jwks
            fetchGeneration &+= 1
            let created = FetchFlight(id: UUID(), generation: fetchGeneration,
                                      task: Task { try await provider.keys() })
            fetchFlight = created
            flight = created
        }
        do {
            let response = try await flight.task.value
            try Task.checkCancellation()
            guard response.keys.count <= 16,
                  Set(response.keys.map(\.kid)).count == response.keys.count,
                  response.keys.allSatisfy({ validKeyMetadata($0) }) else { throw HQIDTokenValidationError.invalidJWKS }
            // Another waiter may already have completed this shared flight, or
            // a newer flight may have replaced it after this waiter suspended.
            // Stale waiters are read-only: they never clear or install state.
            guard fetchFlight?.id == flight.id,
                  fetchFlight?.generation == flight.generation else {
                if now < cacheExpiresAt, !cachedKeys.isEmpty { return cachedKeys }
                throw HQIDTokenValidationError.unknownKey
            }
            fetchFlight = nil
            cachedKeys = Dictionary(uniqueKeysWithValues: response.keys.map { ($0.kid, $0) })
            lastFetchAt = now
            cacheExpiresAt = now.addingTimeInterval(min(max(response.maxAge ?? 300, 30), 3_600))
            return cachedKeys
        } catch {
            // Cancellation belongs to this waiter, not the unstructured shared
            // request. Only the flight that still owns the slot may mutate it.
            if !(error is CancellationError), fetchFlight?.id == flight.id,
               fetchFlight?.generation == flight.generation {
                fetchFlight = nil
                lastFetchFailureAt = now
            }
            throw error
        }
    }

    private func validKeyMetadata(_ key: HQJSONWebKey) -> Bool {
        guard isStrict(key.kid), key.kid.utf8.count <= 256, key.kty == "RSA", key.use == "sig", key.alg == "RS256",
              key.n.utf8.count <= 1_024, key.e.utf8.count <= 16,
              let modulus = Data(hqBase64URL: key.n), let exponent = Data(hqBase64URL: key.e) else { return false }
        return modulus.count == 256 && exponent == Data([1, 0, 1])
    }

    private func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        do { return try JSONDecoder().decode(type, from: data) }
        catch { throw HQIDTokenValidationError.malformed }
    }

    private func isStrict(_ value: String) -> Bool {
        !value.isEmpty && !value.unicodeScalars.contains {
            CharacterSet.whitespacesAndNewlines.contains($0) || CharacterSet.controlCharacters.contains($0)
        }
    }

    private struct Header: Decodable { let alg: String; let kid: String }
    private struct Claims: Decodable {
        let iss: String; let aud: String; let exp: Int64; let iat: Int64; let nbf: Int64?; let sub: String; let tokenUse: String
        enum CodingKeys: String, CodingKey { case iss, aud, exp, iat, nbf, sub; case tokenUse = "token_use" }
    }

    private static func isCanonicalBase64URL(_ value: String) -> Bool {
        guard !value.isEmpty, value.utf8.count % 4 != 1,
              value.unicodeScalars.allSatisfy({ scalar in
                  (scalar.value >= 65 && scalar.value <= 90) || (scalar.value >= 97 && scalar.value <= 122)
                      || (scalar.value >= 48 && scalar.value <= 57) || scalar == "-" || scalar == "_"
              }), let decoded = Data(hqBase64URL: value) else { return false }
        return decoded.hqBase64URLString == value
    }

    private static func hasUniqueSecurityMembers(_ data: Data, names: [String]) -> Bool {
        guard let source = String(data: data, encoding: .utf8), !source.contains("\\u") else { return false }
        for name in names {
            let escaped = NSRegularExpression.escapedPattern(for: name)
            guard let regex = try? NSRegularExpression(pattern: "\\\"\(escaped)\\\"\\s*:") else { return false }
            let range = NSRange(source.startIndex..<source.endIndex, in: source)
            if regex.numberOfMatches(in: source, range: range) > 1 { return false }
        }
        return true
    }
}

extension Data {
    init?(hqBase64URL value: String) {
        var base64 = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
        self.init(base64Encoded: base64)
    }

    var hqBase64URLString: String {
        base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
}
