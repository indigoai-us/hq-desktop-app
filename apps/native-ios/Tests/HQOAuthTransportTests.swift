import XCTest
@testable import HQIOS

final class HQOAuthTransportTests: XCTestCase {
    override func tearDown() {
        StubURLProtocol.handler = nil
        super.tearDown()
    }

    func testSecureOAuthSessionDisablesCookiesCredentialsAndCache() {
        let configuration = HQURLSessionOAuthTransport.secureSession().configuration
        XCTAssertNil(configuration.httpCookieStorage)
        XCTAssertFalse(configuration.httpShouldSetCookies)
        XCTAssertNil(configuration.urlCredentialStorage)
        XCTAssertNil(configuration.urlCache)
        XCTAssertEqual(configuration.requestCachePolicy, .reloadIgnoringLocalCacheData)
    }

    func testOAuthTransportRejectsFinalURLMismatchAndOversizePayload() async {
        let mismatch = makeSession(delegate: HQOAuthNoRedirectDelegate())
        StubURLProtocol.handler = { request in
            (HTTPURLResponse(url: URL(string: "https://foreign.invalid/oauth2/token")!, statusCode: 200, httpVersion: nil,
                             headerFields: ["Content-Type": "application/json"])!, Data("{}".utf8))
        }
        await assertTransportRejects(session: mismatch)

        StubURLProtocol.handler = { request in
            (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil,
                             headerFields: ["Content-Type": "application/json"])!, Data(repeating: 1, count: 262_145))
        }
        await assertTransportRejects(session: makeSession(delegate: HQOAuthNoRedirectDelegate()))
    }

    func testOAuthTransportDoesNotFollow307Or308AndNeverForwardsRequestBody() async throws {
        for status in [307, 308] {
            let counter = LockedRequestCounter()
            StubURLProtocol.handler = { request in
                counter.record(request)
                return (HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil,
                                        headerFields: ["Location": "https://foreign.invalid/capture"])!, Data())
            }
            let transport = HQURLSessionOAuthTransport(session: makeSession(delegate: HQOAuthNoRedirectDelegate()))
            let (_, response) = try await transport.send(tokenRequest())
            XCTAssertEqual(response.statusCode, status)
            XCTAssertEqual(counter.count, 1)
        }
    }

    func testOAuthTransportForcesNoCookieAndReloadPolicyOnRequest() async throws {
        let capture = LockedRequestCounter()
        StubURLProtocol.handler = { request in
            capture.record(request)
            return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil,
                                    headerFields: ["Content-Type": "application/json"])!, Data("{}".utf8))
        }
        _ = try await HQURLSessionOAuthTransport(session: makeSession(delegate: HQOAuthNoRedirectDelegate())).send(tokenRequest())
        XCTAssertEqual(capture.cachePolicies, [.reloadIgnoringLocalCacheData])
        XCTAssertEqual(capture.cookieFlags, [false])
    }

    func testPinnedJWKSProviderRejectsWrongFinalURLMimeOversizeAndRedirect() async {
        let issuer = HQCognitoIDTokenValidator.productionIssuer
        let cases: [(URL, Int, [String: String], Data)] = [
            (URL(string: "https://foreign.invalid/jwks")!, 200, ["Content-Type": "application/json"], Data("{\"keys\":[]}".utf8)),
            (issuer.appending(path: ".well-known/jwks.json"), 200, ["Content-Type": "text/plain"], Data("{\"keys\":[]}".utf8)),
            (issuer.appending(path: ".well-known/jwks.json"), 200, ["Content-Type": "application/json"], Data(repeating: 1, count: 262_145)),
            (issuer.appending(path: ".well-known/jwks.json"), 307, ["Location": "https://foreign.invalid/jwks"], Data()),
        ]
        for item in cases {
            StubURLProtocol.handler = { _ in
                (HTTPURLResponse(url: item.0, statusCode: item.1, httpVersion: nil, headerFields: item.2)!, item.3)
            }
            let provider = HQPinnedCognitoJWKSProvider(issuer: issuer, session: makeSession(delegate: HQNoRedirectSessionDelegate()))
            do { _ = try await provider.keys(); XCTFail("Invalid JWKS response accepted") }
            catch { XCTAssertTrue(error is HQIDTokenValidationError) }
        }
    }

    private func assertTransportRejects(session: URLSession) async {
        do { _ = try await HQURLSessionOAuthTransport(session: session).send(tokenRequest()); XCTFail("Invalid OAuth response accepted") }
        catch { XCTAssertEqual(error as? HQOAuthError, .invalidTokenResponse) }
    }

    private func tokenRequest() -> URLRequest {
        var request = URLRequest(url: URL(string: "https://vault-indigo-hq-prod.auth.us-east-1.amazoncognito.com/oauth2/token")!)
        request.httpMethod = "POST"; request.httpBody = Data("grant_type=refresh_token".utf8)
        return request
    }

    private func makeSession(delegate: URLSessionDelegate) -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubURLProtocol.self]
        configuration.httpCookieStorage = nil; configuration.urlCredentialStorage = nil
        return URLSession(configuration: configuration, delegate: delegate, delegateQueue: nil)
    }
}

private final class StubURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: (@Sendable (URLRequest) -> (HTTPURLResponse, Data))?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        guard let handler = Self.handler else { fatalError("Missing URL protocol handler") }
        let (response, data) = handler(request)
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

private final class LockedRequestCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var requests: [URLRequest] = []
    func record(_ request: URLRequest) { lock.withLock { requests.append(request) } }
    var count: Int { lock.withLock { requests.count } }
    var bodies: [String] { lock.withLock { requests.compactMap { $0.httpBody.flatMap { String(data: $0, encoding: .utf8) } } } }
    var cachePolicies: [URLRequest.CachePolicy] { lock.withLock { requests.map(\.cachePolicy) } }
    var cookieFlags: [Bool] { lock.withLock { requests.map(\.httpShouldHandleCookies) } }
}
