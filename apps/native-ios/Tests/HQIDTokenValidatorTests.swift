import XCTest
@testable import HQIOS

final class HQIDTokenValidatorTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_000)

    func testValidRS256CognitoClaimsReturnVerifiedSubjectAndSignedExpiry() async throws {
        let provider = TestJWKSProvider(responses: [.init(keys: [jwk()], maxAge: 300)])
        let validator = HQCognitoIDTokenValidator(jwks: provider, verifier: TestSignatureVerifier(valid: true))
        let result = try await validator.validate(jwt(), now: now)
        XCTAssertEqual(result, .init(subjectID: "subject-a", expiresAt: Date(timeIntervalSince1970: 2_000)))
    }

    func testUnsignedUnknownKeyWeakKeyAndBadSignatureFailClosed() async {
        await assertValidation(.unsupportedAlgorithm, token: jwt(alg: "none"))
        await assertValidation(.unknownKey, token: jwt(kid: "foreign"))
        let weak = jwk(modulusBytes: 128)
        await assertValidation(.invalidJWKS, token: jwt(), keys: [weak])
        await assertValidation(.invalidSignature, token: jwt(signatureBytes: 255))
        await assertValidation(.invalidSignature, token: jwt(), verifier: TestSignatureVerifier(valid: false))
    }

    func testIssuerAudienceExpiryTokenUseAndSubjectAreBound() async {
        await assertValidation(.invalidIssuer, token: jwt(claimOverrides: ["iss": "https://foreign.invalid"]))
        await assertValidation(.invalidAudience, token: jwt(claimOverrides: ["aud": "foreign-client"]))
        await assertValidation(.expired, token: jwt(claimOverrides: ["exp": 939]))
        await assertValidation(.invalidTokenUse, token: jwt(claimOverrides: ["token_use": "access"]))
        await assertValidation(.invalidSubject, token: jwt(claimOverrides: ["sub": " "]))
    }

    func testStoredIdentityValidationAllowsOnlyExpirationToBeStale() async throws {
        let expired = jwt(claimOverrides: ["exp": 939, "iat": 900])
        let validator = makeValidator()
        do { _ = try await validator.validate(expired, now: now); XCTFail("Normal validation accepted expired token") }
        catch { XCTAssertEqual(error as? HQIDTokenValidationError, .expired) }
        let stored = try await validator.validateStoredIdentity(expired, now: now)
        XCTAssertEqual(stored, .init(subjectID: "subject-a", expiresAt: Date(timeIntervalSince1970: 939)))

        let invalidCases: [(HQIDTokenValidationError, String)] = [
            (.invalidIssuer, jwt(claimOverrides: ["iss": "https://foreign.invalid", "exp": 939])),
            (.invalidAudience, jwt(claimOverrides: ["aud": "foreign-client", "exp": 939])),
            (.invalidTokenUse, jwt(claimOverrides: ["token_use": "access", "exp": 939])),
        ]
        for (expected, token) in invalidCases {
            do { _ = try await makeValidator().validateStoredIdentity(token, now: now); XCTFail("Stored validation accepted \(expected)") }
            catch { XCTAssertEqual(error as? HQIDTokenValidationError, expected) }
        }
        do {
            _ = try await makeValidator(verifier: .init(valid: false)).validateStoredIdentity(expired, now: now)
            XCTFail("Stored validation accepted invalid signature")
        } catch { XCTAssertEqual(error as? HQIDTokenValidationError, .invalidSignature) }
    }

    func testIntegerNumericDatesAndExactClockSkewBoundaries() async throws {
        let validator = makeValidator()
        _ = try await validator.validate(jwt(claimOverrides: ["exp": 941]), now: now)
        _ = try await makeValidator().validate(jwt(claimOverrides: ["nbf": 1_060]), now: now)
        _ = try await makeValidator().validate(jwt(claimOverrides: ["iat": 1_060, "exp": 2_000]), now: now)
        await assertValidation(.expired, token: jwt(claimOverrides: ["exp": 940]))
        await assertValidation(.expired, token: jwt(claimOverrides: ["nbf": 1_061]))
        await assertValidation(.expired, token: jwt(claimOverrides: ["iat": 1_061, "exp": 2_000]))
        await assertValidation(.expired, token: jwt(claimOverrides: ["iat": 1_000, "exp": 87_401]))
        let decimalToken = jwt(claimOverrides: ["exp": 2_000.5])
        await assertValidation(.malformed, token: decimalToken)
    }

    func testUnknownKidStormIsRateLimitedAndCacheExpiresAtBoundedMaxAge() async throws {
        let provider = TestJWKSProvider(responses: [
            .init(keys: [jwk(kid: "known")], maxAge: 30),
            .init(keys: [jwk(kid: "rotated")], maxAge: 30),
        ])
        let validator = HQCognitoIDTokenValidator(jwks: provider, verifier: TestSignatureVerifier(valid: true))
        _ = try await validator.validate(jwt(kid: "known"), now: now)
        for _ in 0..<2 {
            do { _ = try await validator.validate(jwt(kid: "unknown"), now: Date(timeIntervalSince1970: 1_001)); XCTFail("Unknown key accepted") }
            catch { XCTAssertEqual(error as? HQIDTokenValidationError, .unknownKey) }
        }
        let rateLimitedCount = await provider.count()
        XCTAssertEqual(rateLimitedCount, 1)
        _ = try await validator.validate(jwt(kid: "rotated"), now: Date(timeIntervalSince1970: 1_031))
        let refreshedCount = await provider.count()
        XCTAssertEqual(refreshedCount, 2)
    }

    func testConcurrentInitialKeyMissUsesOneJWKSFlight() async throws {
        let provider = GatedJWKSProvider(response: .init(keys: [jwk()], maxAge: 300))
        let validator = HQCognitoIDTokenValidator(jwks: provider, verifier: TestSignatureVerifier(valid: true))
        let token = jwt()
        let validationTime = now
        let first = Task { try await validator.validate(token, now: validationTime) }
        await provider.waitUntilStarted()
        let second = Task { try await validator.validate(token, now: validationTime) }
        await provider.finish()
        _ = try await first.value; _ = try await second.value
        let fetchCount = await provider.count()
        XCTAssertEqual(fetchCount, 1)
    }

    func testCancelledOldWaiterCannotClearOrInstallOverNewJWKSFlightABCInterleaving() async throws {
        let provider = MultiGatedJWKSProvider()
        let validator = HQCognitoIDTokenValidator(jwks: provider, verifier: TestSignatureVerifier(valid: true))
        let tokenA = jwt(kid: "key-a")
        let tokenC = jwt(kid: "key-c")
        let validationTime = now
        let oldWaiterA = Task(priority: .background) { try await validator.validate(tokenA, now: validationTime) }
        await provider.waitUntilStarted(count: 1)
        let completingWaiterB = Task(priority: .high) { try await validator.validate(tokenA, now: validationTime) }
        oldWaiterA.cancel()
        await provider.finish(index: 0, result: .success(.init(keys: [jwk(kid: "key-a")], maxAge: 30)))
        _ = try await completingWaiterB.value

        let newFlightC = Task(priority: .high) {
            try await validator.validate(tokenC, now: Date(timeIntervalSince1970: 1_031))
        }
        await provider.waitUntilStarted(count: 2)
        await provider.finish(index: 1, result: .success(.init(keys: [jwk(kid: "key-c")], maxAge: 300)))
        let cResult = try await newFlightC.value
        XCTAssertEqual(cResult.subjectID, "subject-a")
        do { _ = try await oldWaiterA.value; XCTFail("Cancelled old waiter completed") }
        catch { XCTAssertTrue(error is CancellationError) }
        let fetchCount = await provider.count()
        XCTAssertEqual(fetchCount, 2, "Old waiter disturbed the replacement flight slot")
    }

    func testCompactJWSRequiresCanonicalBase64URLValidUTF8AndUniqueSecurityMembers() async {
        let valid = jwt()
        let parts = valid.split(separator: ".").map(String.init)
        await assertValidation(.malformed, token: "\(parts[0])=.\(parts[1]).\(parts[2])")
        await assertValidation(.malformed, token: ".\(parts[1]).\(parts[2])")
        await assertValidation(.malformed, token: "/\(parts[0].dropFirst()).\(parts[1]).\(parts[2])")
        await assertValidation(.malformed, token: "\(Data([0xff]).hqBase64URL).\(parts[1]).\(parts[2])")

        let duplicateHeader = Data(#"{"alg":"RS256","alg":"none","kid":"key-1"}"#.utf8).hqBase64URL
        await assertValidation(.malformed, token: "\(duplicateHeader).\(parts[1]).\(parts[2])")
        let duplicateClaims = Data(#"{"iss":"https://cognito-idp.us-east-1.amazonaws.com/us-east-1_AXf6Kb5nE","aud":"7acei2c8v870enheptb1j5foln","exp":2000,"exp":3000,"iat":900,"sub":"subject-a","token_use":"id"}"#.utf8).hqBase64URL
        await assertValidation(.malformed, token: "\(parts[0]).\(duplicateClaims).\(parts[2])")
    }

    func testJWKRequiresExact2048BitModulusAndCanonicalExponent() async {
        await assertValidation(.invalidJWKS, token: jwt(), keys: [jwk(modulusBytes: 257)])
        let wrongExponent = HQJSONWebKey(kid: "key-1", kty: "RSA", n: Data(repeating: 0x81, count: 256).hqBase64URL,
                                        e: Data([3]).hqBase64URL, use: "sig", alg: "RS256")
        await assertValidation(.invalidJWKS, token: jwt(), keys: [wrongExponent])
    }

    private func assertValidation(_ expected: HQIDTokenValidationError, token: String,
                                  keys: [HQJSONWebKey]? = nil,
                                  verifier: TestSignatureVerifier = .init(valid: true)) async {
        let validator = makeValidator(keys: keys, verifier: verifier)
        do { _ = try await validator.validate(token, now: now); XCTFail("Invalid token accepted") }
        catch { XCTAssertEqual(error as? HQIDTokenValidationError, expected) }
    }

    private func makeValidator(keys: [HQJSONWebKey]? = nil, verifier: TestSignatureVerifier = .init(valid: true)) -> HQCognitoIDTokenValidator {
        HQCognitoIDTokenValidator(jwks: TestJWKSProvider(responses: [.init(keys: keys ?? [jwk()], maxAge: 300)]), verifier: verifier)
    }

    private func jwk(kid: String = "key-1", modulusBytes: Int = 256) -> HQJSONWebKey {
        .init(kid: kid, kty: "RSA", n: Data(repeating: 0x81, count: modulusBytes).hqBase64URL,
              e: Data([1, 0, 1]).hqBase64URL, use: "sig", alg: "RS256")
    }

    private func jwt(kid: String = "key-1", alg: String = "RS256", signatureBytes: Int = 256,
                     claimOverrides: [String: Any] = [:]) -> String {
        var claims: [String: Any] = [
            "iss": HQCognitoIDTokenValidator.productionIssuer.absoluteString,
            "aud": HQCognitoIDTokenValidator.productionAudience,
            "exp": 2_000, "iat": 900, "sub": "subject-a", "token_use": "id",
        ]
        claimOverrides.forEach { claims[$0.key] = $0.value }
        let header = try! JSONSerialization.data(withJSONObject: ["alg": alg, "kid": kid]).hqBase64URL
        let payload = try! JSONSerialization.data(withJSONObject: claims).hqBase64URL
        return "\(header).\(payload).\(Data(repeating: 0x5a, count: signatureBytes).hqBase64URL)"
    }
}

private struct TestSignatureVerifier: HQJWTSignatureVerifying {
    let valid: Bool
    func verify(message: Data, signature: Data, key: HQJSONWebKey) throws -> Bool { valid }
}

private actor TestJWKSProvider: HQJWKSProviding {
    private var responses: [HQJWKSResponse]
    private var fetches = 0
    init(responses: [HQJWKSResponse]) { self.responses = responses }
    func keys() throws -> HQJWKSResponse {
        fetches += 1
        guard !responses.isEmpty else { throw HQIDTokenValidationError.invalidJWKS }
        return responses.count == 1 ? responses[0] : responses.removeFirst()
    }
    func count() -> Int { fetches }
}

private actor GatedJWKSProvider: HQJWKSProviding {
    let response: HQJWKSResponse
    private var fetches = 0
    private var continuation: CheckedContinuation<HQJWKSResponse, Error>?
    init(response: HQJWKSResponse) { self.response = response }
    func keys() async throws -> HQJWKSResponse {
        fetches += 1
        return try await withCheckedThrowingContinuation { continuation = $0 }
    }
    func waitUntilStarted() async { while continuation == nil { await Task.yield() } }
    func finish() { continuation?.resume(returning: response); continuation = nil }
    func count() -> Int { fetches }
}

private actor MultiGatedJWKSProvider: HQJWKSProviding {
    private var fetches = 0
    private var continuations: [Int: CheckedContinuation<HQJWKSResponse, Error>] = [:]

    func keys() async throws -> HQJWKSResponse {
        let index = fetches
        fetches += 1
        return try await withCheckedThrowingContinuation { continuations[index] = $0 }
    }

    func waitUntilStarted(count expected: Int) async {
        while fetches < expected { await Task.yield() }
    }

    func finish(index: Int, result: Result<HQJWKSResponse, Error>) {
        continuations.removeValue(forKey: index)?.resume(with: result)
    }

    func count() -> Int { fetches }
}

private extension Data {
    var hqBase64URL: String {
        base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
}
