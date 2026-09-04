import Foundation
import XCTest
@testable import HQIOS

final class HQHTTPContractTests: XCTestCase {
    override func tearDown() {
        HQHTTPStubURLProtocol.handler = nil
        super.tearDown()
    }

    func testTransportPinsExactOriginBeforeAttachingIDTokenAuthorization() async throws {
        let loader = HQScriptedLoader(steps: [.response(status: 200, headers: [:], data: Data("{}".utf8), url: nil)])
        let transport = HQHTTPTransport(loader: loader, sleep: { _ in })
        let response = try await transport.send(
            request(),
            credentials: credentials("id-token-only")
        )
        XCTAssertEqual(response.statusCode, 200)

        let capturedRequests = await loader.capturedRequests()
        let captured = try XCTUnwrap(capturedRequests.first)
        XCTAssertEqual(captured.authorization, "Bearer id-token-only")
        XCTAssertEqual(captured.requestID?.count, 36)
        XCTAssertEqual(captured.accept, "application/json")
        XCTAssertNil(captured.cookie)

        let rejected = [
            "http://hqapi.getindigo.ai/v1/mobile/config",
            "https://foreign.invalid/v1/mobile/config",
            "https://hqapi.getindigo.ai:444/v1/mobile/config",
            "https://user@hqapi.getindigo.ai/v1/mobile/config",
            "https://hqapi.getindigo.ai/v1/mobile/config#credential-trap"
        ]
        for value in rejected {
            let error = await captureError {
                try await transport.send(self.request(url: URL(string: value)!), credentials: self.credentials("secret"))
            }
            XCTAssertTrue(error is HQHTTPTransportError, "Expected transport rejection for \(value)")
        }
        let requestCount = await loader.requestCount()
        XCTAssertEqual(requestCount, 1, "Rejected origins must never reach a credential-bearing loader.")
    }

    @MainActor
    func testOriginNormalizationAndHostileBaseURLRejection() async throws {
        let normalized = try HQHTTPSOrigin(validatingBaseURL: URL(string: "https://HQAPI.GETINDIGO.AI:443/")!)
        XCTAssertEqual(normalized, .production)
        XCTAssertTrue(normalized.contains(URL(string: "https://hqapi.getindigo.ai:443/path?q=1")!))

        let hostileBases = [
            "http://hqapi.getindigo.ai",
            "https://user@hqapi.getindigo.ai",
            "https://hqapi.getindigo.ai/base",
            "https://hqapi.getindigo.ai?redirect=evil",
            "https://hqapi.getindigo.ai#evil"
        ]
        for value in hostileBases {
            XCTAssertThrowsError(try HQHTTPSOrigin(validatingBaseURL: URL(string: value)!))
        }

        let session = makeController()
        for value in hostileBases {
            do {
                _ = try HQAPIClient(baseURL: URL(string: value)!, session: session)
                XCTFail("Accepted hostile base URL: \(value)")
            } catch {}
        }
    }

    func testPerTaskRedirectDelegateRejectsCredentialBearingRedirectDeterministically() throws {
        var original = URLRequest(url: URL(string: "https://hqapi.getindigo.ai/v1/mobile/config")!)
        original.setValue("Bearer never-forward", forHTTPHeaderField: "Authorization")
        var redirected = URLRequest(url: URL(string: "https://foreign.invalid/capture")!)
        redirected.setValue("Bearer never-forward", forHTTPHeaderField: "Authorization")

        let configuration = URLSessionConfiguration.ephemeral
        let session = URLSession(configuration: configuration)
        let task = session.dataTask(with: original)
        defer {
            task.cancel()
            session.invalidateAndCancel()
        }
        let response = try XCTUnwrap(HTTPURLResponse(
            url: original.url!, statusCode: 302, httpVersion: nil,
            headerFields: ["Location": redirected.url!.absoluteString]
        ))
        let capture = HQRedirectDecisionCapture()

        HQNoRedirectSessionDelegate().urlSession(
            session,
            task: task,
            willPerformHTTPRedirection: response,
            newRequest: redirected,
            completionHandler: { capture.record($0) }
        )

        XCTAssertTrue(capture.wasCalled)
        XCTAssertNil(capture.followedRequest, "A nil redirect decision guarantees no redirected request receives credentials.")
    }

    func testTransportStreamsAndRejectsContentLengthBeforeBodyRetention() async throws {
        HQHTTPStubURLProtocol.handler = { request in
            .response(
                HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil,
                                headerFields: ["Content-Length": "\(HQHTTPTransport.maximumResponseBytes + 1)"])!,
                []
            )
        }
        let transport = HQHTTPTransport(session: makeURLSession(), sleep: { _ in })
        let error = await captureError { try await transport.send(self.request(), credentials: self.credentials()) }
        XCTAssertEqual(error as? HQHTTPTransportError, .responseTooLarge)
    }

    func testTransportStopsAnUnboundedStreamAtOneMiB() async throws {
        let oversized = Data(repeating: 0x61, count: HQHTTPTransport.maximumResponseBytes + 1)
        HQHTTPStubURLProtocol.handler = { request in
            .response(HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: [:])!,
                      oversized.chunked(size: 8_192))
        }
        let transport = HQHTTPTransport(session: makeURLSession(), sleep: { _ in })
        let error = await captureError { try await transport.send(self.request(), credentials: self.credentials()) }
        XCTAssertEqual(error as? HQHTTPTransportError, .responseTooLarge)
    }

    func testMatrixOwnedSafeReadRetriesWithBoundedFullJitter() async throws {
        let loader = HQScriptedLoader(steps: [
            .response(status: 503, headers: [:], data: Data(), url: nil),
            .response(status: 503, headers: [:], data: Data(), url: nil),
            .response(status: 200, headers: [:], data: Data(), url: nil)
        ])
        let delays = HQDelayRecorder()
        let transport = HQHTTPTransport(loader: loader, randomUnit: { 0.5 }, sleep: { await delays.append($0) })
        let response = try await transport.send(request(), credentials: credentials())

        XCTAssertEqual(response.retryCount, 2)
        let requestCount = await loader.requestCount()
        let recordedDelays = await delays.values()
        XCTAssertEqual(requestCount, 3)
        XCTAssertEqual(recordedDelays, [100_000_000, 200_000_000])
    }

    func testRetryAfterSecondsAndHTTPDateAreStrictlyClamped() async throws {
        let fixedNow = Date(timeIntervalSince1970: 1_700_000_000)
        let httpDate = Self.httpDate(fixedNow.addingTimeInterval(2))
        let loader = HQScriptedLoader(steps: [
            .response(status: 429, headers: ["Retry-After": "99"], data: Data(), url: nil),
            .response(status: 503, headers: ["Retry-After": httpDate], data: Data(), url: nil),
            .response(status: 200, headers: [:], data: Data(), url: nil)
        ])
        let delays = HQDelayRecorder()
        let transport = HQHTTPTransport(loader: loader, now: { fixedNow }, randomUnit: { 1 },
                                        sleep: { await delays.append($0) })
        _ = try await transport.send(request(), credentials: credentials())
        let recordedDelays = await delays.values()
        XCTAssertEqual(recordedDelays, [5_000_000_000, 2_000_000_000])

        XCTAssertNil(HQHTTPTransport.retryAfter("-1", now: fixedNow))
        XCTAssertNil(HQHTTPTransport.retryAfter("1.5", now: fixedNow))
        XCTAssertNil(HQHTTPTransport.retryAfter("tomorrow", now: fixedNow))
        XCTAssertEqual(HQHTTPTransport.fullJitterDelay(retryNumber: 1, randomUnit: -2), 0)
        XCTAssertEqual(HQHTTPTransport.fullJitterDelay(retryNumber: 99, randomUnit: 2), 1)
    }

    func testUnsafeMutationCannotOptIntoRetryAndContractMethodMustMatch() async throws {
        let loader = HQScriptedLoader(steps: [
            .response(status: 503, headers: ["Retry-After": "0"], data: Data(), url: nil)
        ])
        let transport = HQHTTPTransport(loader: loader, sleep: { _ in XCTFail("Unsafe mutation attempted backoff") })
        let mutation = HQHTTPRequest(contractID: "dm-send", url: URL(string: "https://hqapi.getindigo.ai/v1/notify/dm")!,
                                     method: .post, body: Data("{}".utf8), requestClass: .unsafeMutation)
        let response = try await transport.send(mutation, credentials: credentials())
        XCTAssertEqual(response.statusCode, 503)
        var requestCount = await loader.requestCount()
        XCTAssertEqual(requestCount, 1)

        let mismatched = HQHTTPRequest(contractID: "mobile-config", url: URL(string: "https://hqapi.getindigo.ai/v1/mobile/config")!,
                                       method: .post, body: Data("{}".utf8), requestClass: .bootstrap)
        let error = await captureError { try await transport.send(mismatched, credentials: self.credentials()) }
        XCTAssertEqual(error as? HQHTTPTransportError, .invalidContract)
        requestCount = await loader.requestCount()
        XCTAssertEqual(requestCount, 1)
    }

    func testContractPathAndDiagnosticClassGuardsAreIndependentlyEnforced() async throws {
        let loader = HQScriptedLoader(steps: [
            .response(status: 200, headers: [:], data: Data(), url: nil)
        ])
        let transport = HQHTTPTransport(loader: loader, sleep: { _ in })

        let wrongPath = HQHTTPRequest(
            contractID: "mobile-config",
            url: URL(string: "https://hqapi.getindigo.ai/v1/notify/dm")!,
            method: .get,
            requestClass: .bootstrap
        )
        let pathError = await captureError { try await transport.send(wrongPath, credentials: self.credentials()) }
        XCTAssertEqual(pathError as? HQHTTPTransportError, .invalidContract)
        var requestCount = await loader.requestCount()
        XCTAssertEqual(requestCount, 0, "A wrong path with otherwise-correct semantics must fail before credentials reach the loader.")

        let wrongClass = HQHTTPRequest(
            contractID: "mobile-config",
            url: URL(string: "https://hqapi.getindigo.ai/v1/mobile/config")!,
            method: .get,
            requestClass: .routeRead
        )
        let classError = await captureError { try await transport.send(wrongClass, credentials: self.credentials()) }
        XCTAssertEqual(classError as? HQHTTPTransportError, .invalidContract)
        requestCount = await loader.requestCount()
        XCTAssertEqual(requestCount, 0, "A spoofed diagnostic class must fail independently of path and method.")

        let validResponse = try await transport.send(request(), credentials: credentials())
        XCTAssertEqual(validResponse.statusCode, 200)
        requestCount = await loader.requestCount()
        XCTAssertEqual(requestCount, 1)
    }

    func testDynamicPathGateRejectsHostileEncodingsBeforeLoadingCredentials() async throws {
        let loader = HQScriptedLoader(steps: [
            .response(status: 200, headers: [:], data: Data(), url: nil)
        ])
        let transport = HQHTTPTransport(loader: loader, sleep: { _ in })

        let hostileSegments = ["%2F", "%2E%2E", "%5C", "%00", "%252F"]
        for segment in hostileSegments {
            let url = try XCTUnwrap(URL(string: "https://hqapi.getindigo.ai/v1/listings/\(segment)"))
            let request = HQHTTPRequest(
                contractID: "listing-detail",
                url: url,
                method: .get,
                requestClass: .routeRead
            )

            let error = await captureError {
                try await transport.send(request, credentials: self.credentials("never-load"))
            }
            XCTAssertEqual(error as? HQHTTPTransportError, .invalidContract, segment)
            let requestCount = await loader.requestCount()
            XCTAssertEqual(requestCount, 0, "Hostile segment \(segment) reached the credential-bearing loader.")
        }

        let validURL = try XCTUnwrap(URL(string: "https://hqapi.getindigo.ai/v1/listings/caf%C3%A9%20launch"))
        let validRequest = HQHTTPRequest(
            contractID: "listing-detail",
            url: validURL,
            method: .get,
            requestClass: .routeRead
        )
        let response = try await transport.send(validRequest, credentials: credentials())

        XCTAssertEqual(response.statusCode, 200)
        let requestCount = await loader.requestCount()
        XCTAssertEqual(requestCount, 1, "Canonical UTF-8 and space escapes must remain valid dynamic IDs.")
    }

    func testAuditedMatrixHasNoUnprovenMutationReplay() {
        for descriptor in HQRouteContractMatrix.definitions.values {
            if descriptor.method == .get {
                XCTAssertEqual(descriptor.replayClass, .safeRead, descriptor.id)
            } else if descriptor.id == "realtime-credentials" {
                XCTAssertEqual(descriptor.replayClass, .provenIdempotentMutation, descriptor.id)
            } else {
                XCTAssertEqual(descriptor.replayClass, .unsafeMutation, descriptor.id)
            }
        }
    }

    func testInFlightCancellationIsPreservedWithoutRetry() async throws {
        let loader = HQCancellationLoader(error: CancellationError())
        let diagnostics = HQNetworkDiagnostics()
        let transport = HQHTTPTransport(loader: loader, diagnostics: diagnostics)
        let pendingRequest = request()
        let pendingCredentials = credentials()
        let task = Task { try await transport.send(pendingRequest, credentials: pendingCredentials) }
        await loader.waitUntilStarted()
        task.cancel()
        let error = await captureError { try await task.value }
        XCTAssertTrue(error is CancellationError)
        let requestCount = await loader.requestCount()
        let snapshot = await diagnostics.snapshot()
        XCTAssertEqual(requestCount, 1)
        XCTAssertEqual(snapshot.recent.last?.outcome, .cancelled)
    }

    func testCancelledURLErrorIsPreservedWithoutRetry() async throws {
        let loader = HQScriptedLoader(steps: [.urlError(.cancelled)])
        let transport = HQHTTPTransport(loader: loader)
        let error = await captureError { try await transport.send(self.request(), credentials: self.credentials()) }
        XCTAssertEqual((error as? URLError)?.code, .cancelled)
        let requestCount = await loader.requestCount()
        XCTAssertEqual(requestCount, 1)
    }

    func testCancellationDuringBackoffDoesNotStartAnotherAttempt() async throws {
        let loader = HQScriptedLoader(steps: [
            .response(status: 503, headers: [:], data: Data(), url: nil),
            .response(status: 200, headers: [:], data: Data(), url: nil)
        ])
        let backoff = HQBackoffGate()
        let transport = HQHTTPTransport(loader: loader, sleep: { try await backoff.pause($0) })
        let pendingRequest = request()
        let pendingCredentials = credentials()
        let task = Task { try await transport.send(pendingRequest, credentials: pendingCredentials) }
        await backoff.waitUntilStarted()
        task.cancel()
        let error = await captureError { try await task.value }
        XCTAssertTrue(error is CancellationError)
        let requestCount = await loader.requestCount()
        XCTAssertEqual(requestCount, 1)
    }

    @MainActor
    func testSafe401RefreshesOnceAndReplaysWithNewIDToken() async throws {
        let oauth = HQRefreshOAuth(refreshed: refreshedTokens)
        let store = HQMemoryTokenStore(tokens: validTokens)
        let protected = HQMemoryProtectedState()
        let session = makeController(oauth: oauth, store: store, protected: protected)
        await session.restoreSession()
        let transport = HQCredentialSequenceTransport(statuses: [401, 200], successData: mobileConfigurationData)
        let client = try HQAPIClient(session: session, transport: transport)

        let result = try await client.mobileConfiguration()
        guard case .content = result else { return XCTFail("Expected decoded content after refresh") }
        let observedTokens = await transport.idTokens()
        let refreshCount = await oauth.refreshCount()
        let purgeCount = await store.purgeCount()
        XCTAssertEqual(observedTokens, ["stored-id-token", "refreshed-id-token"])
        XCTAssertEqual(refreshCount, 1)
        XCTAssertEqual(purgeCount, 0)
    }

    @MainActor
    func testRepeated401PurgesAndRequiresAuthentication() async throws {
        let oauth = HQRefreshOAuth(refreshed: refreshedTokens)
        let store = HQMemoryTokenStore(tokens: validTokens)
        let protected = HQMemoryProtectedState()
        let session = makeController(oauth: oauth, store: store, protected: protected)
        await session.restoreSession()
        let transport = HQCredentialSequenceTransport(statuses: [401, 401], successData: mobileConfigurationData)
        let client = try HQAPIClient(session: session, transport: transport)

        let error: Error?
        do {
            _ = try await client.mobileConfiguration()
            XCTFail("Expected repeated 401 to fail closed")
            error = nil
        } catch let caught {
            error = caught
        }
        XCTAssertEqual(error as? HQSessionError, .unauthorizedAfterRetry)
        let observedTokens = await transport.idTokens()
        let refreshCount = await oauth.refreshCount()
        let tokenPurgeCount = await store.purgeCount()
        let protectedPurgeCount = await protected.purgeCount()
        XCTAssertEqual(observedTokens, ["stored-id-token", "refreshed-id-token"])
        XCTAssertEqual(refreshCount, 1)
        XCTAssertGreaterThanOrEqual(tokenPurgeCount, 1)
        XCTAssertGreaterThanOrEqual(protectedPurgeCount, 1)
        if case .reauthenticationRequired = session.state {} else { XCTFail("Session did not fail closed") }
    }

    @MainActor
    func testRealtimeCredential401RefreshesAndReplaysExactlyOnce() async throws {
        let oauth = HQRefreshOAuth(refreshed: refreshedTokens)
        let store = HQMemoryTokenStore(tokens: validTokens)
        let protected = HQMemoryProtectedState()
        let session = makeController(oauth: oauth, store: store, protected: protected)
        await session.restoreSession()
        let transport = HQCredentialSequenceTransport(statuses: [401, 200], successData: realtimeCredentialsData)
        let client = try HQAPIClient(session: session, transport: transport)

        let result = try await client.realtimeCredentials()
        guard case let .content(credentials) = result else { return XCTFail("Expected strict v2 credentials after replay") }
        XCTAssertEqual(credentials.topic, credentials.topics.dm)
        let callCount = await transport.callCount()
        let observedTokens = await transport.idTokens()
        let observedRequests = await transport.capturedRequests()
        let refreshCount = await oauth.refreshCount()
        let purgeCount = await store.purgeCount()
        XCTAssertEqual(callCount, 2)
        XCTAssertEqual(observedTokens, ["stored-id-token", "refreshed-id-token"])
        XCTAssertEqual(observedRequests.map(\.contractID), ["realtime-credentials", "realtime-credentials"])
        XCTAssertEqual(observedRequests.map(\.method.rawValue), ["POST", "POST"])
        XCTAssertEqual(observedRequests.map(\.url.path), ["/v1/realtime/credentials", "/v1/realtime/credentials"])
        XCTAssertEqual(
            observedRequests.compactMap(\.body),
            [Data(#"{"contractVersion":2}"#.utf8), Data(#"{"contractVersion":2}"#.utf8)]
        )
        XCTAssertEqual(refreshCount, 1)
        XCTAssertEqual(purgeCount, 0)
    }

    @MainActor
    func testConcurrent401ResponsesShareOneRefreshFlight() async throws {
        let oauth = HQRefreshOAuth(refreshed: refreshedTokens, delayNanoseconds: 20_000_000)
        let store = HQMemoryTokenStore(tokens: validTokens)
        let session = makeController(oauth: oauth, store: store, protected: HQMemoryProtectedState())
        await session.restoreSession()
        let transport = HQConcurrent401Transport(successData: mobileConfigurationData)
        let client = try HQAPIClient(session: session, transport: transport)

        async let first = client.mobileConfiguration()
        async let second = client.mobileConfiguration()
        _ = try await (first, second)

        let refreshCount = await oauth.refreshCount()
        let storedCalls = await transport.storedTokenCalls()
        let refreshedCalls = await transport.refreshedTokenCalls()
        XCTAssertEqual(refreshCount, 1)
        XCTAssertEqual(storedCalls, 2)
        XCTAssertEqual(refreshedCalls, 2)
    }

    func testTypedResponseFactoriesCoverBareEnvelopePageWindowAndEmpty() throws {
        let descriptor = try XCTUnwrap(HQRouteContractMatrix.descriptor(for: "mobile-config"))
        let url = URL(string: "https://hqapi.getindigo.ai/test")!

        let bare = HQEndpointFactory.bare(descriptor: descriptor, url: url, requestClass: .routeRead, as: HQWorkState.self)
        XCTAssertEqual(bare.decode(200, Data("\"future-state\"".utf8)),
                       .degraded(.unknownEnum(contractID: descriptor.id, value: "future-state")))
        XCTAssertEqual(bare.decode(200, Data("{}".utf8)), .degraded(.partialResponse(contractID: descriptor.id)))

        let envelope = HQEndpointFactory.envelope(descriptor: descriptor, url: url, requestClass: .routeRead,
                                                   key: "data", as: HQTestPayload.self)
        XCTAssertEqual(envelope.decode(200, Data("{\"data\":{\"value\":\"ok\"}}".utf8)),
                       .content(HQTestPayload(value: "ok")))
        XCTAssertEqual(envelope.decode(200, Data("{}".utf8)), .degraded(.partialResponse(contractID: descriptor.id)))

        let page = HQEndpointFactory.page(descriptor: descriptor, url: url, requestClass: .routeRead,
                                          itemsKey: "events", item: String.self)
        let pageResult = page.decode(200, Data("{\"events\":[\"a\"],\"nextCursor\":\"opaque\",\"hasMore\":true}".utf8))
        guard case let .content(decodedPage) = pageResult else { return XCTFail("Expected page content") }
        XCTAssertEqual(decodedPage.items, ["a"])
        XCTAssertEqual(decodedPage.nextCursor, "opaque")
        XCTAssertTrue(decodedPage.hasMore)
        XCTAssertEqual(page.decode(200, Data("{\"events\":[],\"hasMore\":true}".utf8)),
                       .degraded(.partialResponse(contractID: descriptor.id)))
        XCTAssertThrowsError(try HQDomainJSONDecoder().decode(HQPage<String>.self,
                                                              from: Data("{\"items\":[],\"nextCursor\":\"\",\"hasMore\":true}".utf8)))
        XCTAssertThrowsError(try HQDomainJSONDecoder().decode(HQPage<String>.self,
                                                              from: Data("{\"items\":[],\"nextCursor\":null,\"hasMore\":true}".utf8)))

        let window = HQEndpointFactory.window(descriptor: descriptor, url: url, requestClass: .routeRead,
                                              itemsKey: "messages", item: String.self)
        XCTAssertEqual(window.decode(200, Data("{\"messages\":[\"m\"],\"since\":\"cursor-time\"}".utf8)),
                       .content(HQWindow(items: ["m"], nextCursor: nil, windowStart: "cursor-time")))

        let empty = HQEndpointFactory.empty(descriptor: descriptor, url: url, requestClass: .routeRead)
        XCTAssertEqual(empty.decode(204, Data()), .content(HQEmptyResponse()))
        XCTAssertEqual(empty.decode(200, Data(" \n".utf8)), .content(HQEmptyResponse()))
        XCTAssertEqual(empty.decode(200, Data("{}".utf8)), .degraded(.partialResponse(contractID: descriptor.id)))
    }

    @MainActor
    func testUnverifiedShapesAreUnavailableWithoutNetworkRequest() async throws {
        let transport = HQCredentialSequenceTransport(statuses: [200], successData: Data("{}".utf8))
        let session = makeController()
        await session.restoreSession()
        let client = try HQAPIClient(session: session, transport: transport)

        let value = try await client.routeValue(contractID: "listing-detail", pathArguments: ["listingId": "safe"])
        XCTAssertEqual(value, .unavailable(.unverifiedResponseSchema(contractID: "listing-detail")))
        let page: HQRouteResult<HQPage<String>> = try await client.routePage(contractID: "notifications", item: String.self)
        XCTAssertEqual(page, .unavailable(.unverifiedResponseSchema(contractID: "notifications")))
        let window: HQRouteResult<HQWindow<String>> = try await client.routeWindow(contractID: "dm-thread", item: String.self)
        XCTAssertEqual(window, .unavailable(.unverifiedResponseSchema(contractID: "dm-thread")))
        let callCount = await transport.callCount()
        XCTAssertEqual(callCount, 0)
    }

    @MainActor
    func testDynamicPathSegmentsAreEncodedExactlyOnceAndTraversalIsRejected() async throws {
        let session = makeController()
        let client = try HQAPIClient(session: session, transport: HQCredentialSequenceTransport(statuses: [], successData: Data()))

        let result = try await client.routeValue(contractID: "listing-detail",
                                                 pathArguments: ["listingId": "hello world café"])
        XCTAssertEqual(result, .unavailable(.unverifiedResponseSchema(contractID: "listing-detail")))

        let descriptor = try XCTUnwrap(HQRouteContractMatrix.descriptor(for: "listing-detail"))
        let encodedURL = try client.resolvedURL(descriptor,
                                                pathArguments: ["listingId": "hello world café"], query: [])
        XCTAssertEqual(encodedURL.absoluteString,
                       "https://hqapi.getindigo.ai/v1/listings/hello%20world%20caf%C3%A9")
        XCTAssertTrue(descriptor.matches(encodedURL))
        XCTAssertFalse(encodedURL.absoluteString.contains("%2520"))

        for malicious in ["..", ".", "a/b", "a%2Fb", "a?query", "a#fragment"] {
            do {
                _ = try await client.routeValue(contractID: "listing-detail", pathArguments: ["listingId": malicious])
                XCTFail("Accepted unsafe path argument: \(malicious)")
            } catch {}
        }
    }

    @MainActor
    func testMembershipClientDecodesCapturedISO8601Fixture() async throws {
        let fixtureURL = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appending(path: "Contracts/Fixtures/membership-me.redacted.json")
        let fixture = try Data(contentsOf: fixtureURL)
        let transport = HQCredentialSequenceTransport(statuses: [200], successData: fixture)
        let session = makeController()
        await session.restoreSession()
        let client = try HQAPIClient(session: session, transport: transport)

        let result = try await client.membership()
        guard case let .degraded(.unknownEnum(contractID, value)) = result else {
            return XCTFail("Redacted enum sentinels should remain a visible degraded state")
        }
        XCTAssertEqual(contractID, "membership-me")
        XCTAssertEqual(value, "__redacted__")
    }

    func testPaginationVariantsAreRegisteredWithoutInventedNormalizers() {
        XCTAssertEqual(HQRouteContractMatrix.descriptor(for: "notifications")?.pagination, .opaqueCursor)
        XCTAssertEqual(HQRouteContractMatrix.descriptor(for: "dm-threads")?.pagination, .opaqueCursor)
        XCTAssertEqual(HQRouteContractMatrix.descriptor(for: "channel-directory")?.pagination, .opaqueCursor)
        XCTAssertEqual(HQRouteContractMatrix.descriptor(for: "dm-thread")?.pagination, .window)
        XCTAssertEqual(HQRouteContractMatrix.descriptor(for: "channel-messages")?.pagination, .window)
        XCTAssertEqual(HQRouteContractMatrix.descriptor(for: "contacts")?.pagination, HQPaginationContract.none)
    }

    func testRegisteredErrorEnvelopesSupportTopLevelNestedAndStringForms() {
        let top = HQAPIErrorEnvelope(statusCode: 400, data: Data("{\"code\":\"TOP\",\"message\":\"top message\",\"requestId\":\"r1\"}".utf8))
        XCTAssertEqual(top.statusCode, 400)
        XCTAssertEqual(top.code, "TOP")
        XCTAssertEqual(top.message, "top message")
        XCTAssertEqual(top.requestID, "r1")

        let nested = HQAPIErrorEnvelope(statusCode: 403, data: Data("{\"error\":{\"code\":\"NESTED\",\"message\":\"nested message\",\"requestId\":\"r2\"}}".utf8))
        XCTAssertEqual(nested.statusCode, 403)
        XCTAssertEqual(nested.code, "NESTED")
        XCTAssertEqual(nested.message, "nested message")
        XCTAssertEqual(nested.requestID, "r2")

        XCTAssertEqual(HQAPIErrorEnvelope(statusCode: 409, data: Data("{\"error\":\"string error\"}".utf8)).message, "string error")
        XCTAssertEqual(HQAPIErrorEnvelope(statusCode: 500, data: Data("\"root string\"".utf8)).message, "root string")
    }

    func testAuthenticatedMatrixExcludesCognitoAndMatchesCloudInventory() throws {
        let source = try Data(contentsOf: URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .deletingLastPathComponent().appending(path: "Contracts/cloud-routes.json"))
        let object = try JSONSerialization.jsonObject(with: source) as? [String: Any]
        let contracts = try XCTUnwrap(object?["contracts"] as? [[String: Any]])
        let authenticated = contracts.filter { !["cognito-token", "cognito-revoke"].contains($0["id"] as? String) }
        XCTAssertEqual(HQRouteContractMatrix.identifiers, Set(authenticated.compactMap { $0["id"] as? String }))
        XCTAssertNil(HQRouteContractMatrix.descriptor(for: "cognito-token"))
        XCTAssertNil(HQRouteContractMatrix.descriptor(for: "cognito-revoke"))
        for contract in authenticated {
            let id = try XCTUnwrap(contract["id"] as? String)
            let descriptor = try XCTUnwrap(HQRouteContractMatrix.descriptor(for: id))
            XCTAssertEqual(descriptor.method.rawValue, contract["method"] as? String)
            let expectedPath = try XCTUnwrap(contract["path"] as? String)
                .split(separator: "?", maxSplits: 1).first.map(String.init)
            XCTAssertEqual(descriptor.pathTemplate, expectedPath)
        }
    }

    func testDiagnosticsRingIsBoundedAndReconciliationIsExplicit() async {
        let diagnostics = HQNetworkDiagnostics()
        for index in 0 ..< 25 {
            await diagnostics.record(diagnostic(index: index, statusCode: 200, outcome: .success))
        }
        var snapshot = await diagnostics.snapshot()
        XCTAssertEqual(snapshot.recent.count, 20)
        XCTAssertEqual(snapshot.recent.first?.retryCount, 5)
        XCTAssertNil(snapshot.lastReconciliationAt, "An ordinary 2xx is not a reconciliation.")

        let reconciledAt = Date(timeIntervalSince1970: 1234)
        await diagnostics.recordReconciliationCompleted(at: reconciledAt)
        snapshot = await diagnostics.snapshot()
        XCTAssertEqual(snapshot.lastReconciliationAt, reconciledAt)
    }

    func testDiagnosticsContainOnlySanitizedBoundedMetadata() async throws {
        let diagnostics = HQNetworkDiagnostics()
        let loader = HQScriptedLoader(steps: [
            .response(status: 503, headers: [:], data: Data("{\"message\":\"person@example.com\"}".utf8), url: nil)
        ])
        let transport = HQHTTPTransport(loader: loader, diagnostics: diagnostics)
        let mutation = HQHTTPRequest(contractID: "dm-send", url: URL(string: "https://hqapi.getindigo.ai/v1/notify/dm?person=private")!,
                                     method: .post, body: Data("{\"body\":\"person@example.com\"}".utf8),
                                     requestClass: .unsafeMutation)
        _ = try await transport.send(mutation, credentials: credentials("never-log-this-token"))
        let snapshot = await diagnostics.snapshot()
        XCTAssertEqual(snapshot.recent.count, 1)
        XCTAssertEqual(snapshot.recent[0].outcome, .serverFailure)
        let rendered = String(describing: snapshot)
        XCTAssertFalse(rendered.contains("never-log-this-token"))
        XCTAssertFalse(rendered.contains("person@example.com"))
        XCTAssertFalse(rendered.contains("/v1/notify"))
        XCTAssertFalse(rendered.contains("private"))
    }

    func testUnknownServerEnumRemainsVisible() throws {
        let state = try HQDomainJSONDecoder().decode(HQWorkState.self, from: Data("\"future-work-state\"".utf8))
        XCTAssertEqual(state, .unknown("future-work-state"))
    }

    func testRealtimeV2EnvelopeRequiresCredentialMaterialAndExactlyFourScopedTopics() throws {
        var decoder = HQDomainJSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        XCTAssertNoThrow(try decoder.decode(HQRealtimeCredentials.self, from: realtimeCredentialsData))
        let missingExpirationMirror = Data(String(decoding: realtimeCredentialsData, as: UTF8.self)
            .replacingOccurrences(of: ",\"expiresAt\":\"[^\"]+\"", with: "", options: .regularExpression).utf8)
        XCTAssertThrowsError(try decoder.decode(HQRealtimeCredentials.self, from: missingExpirationMirror))
    }

    private func request(url: URL = URL(string: "https://hqapi.getindigo.ai/v1/mobile/config")!) -> HQHTTPRequest {
        HQHTTPRequest(contractID: "mobile-config", url: url, method: .get, requestClass: .bootstrap)
    }

    private func credentials(_ token: String = "safe-id-token") -> HQAuthorizationCredentials {
        HQAuthorizationCredentials(tokenType: "Bearer", idToken: token)
    }

    private func makeURLSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [HQHTTPStubURLProtocol.self]
        configuration.httpCookieStorage = nil
        configuration.urlCredentialStorage = nil
        return URLSession(configuration: configuration, delegate: HQNoRedirectSessionDelegate(), delegateQueue: nil)
    }

    @MainActor
    private func makeController(oauth: HQRefreshOAuth? = nil,
                                store: HQMemoryTokenStore? = nil,
                                protected: HQMemoryProtectedState? = nil) -> HQSessionController {
        HQSessionController(
            oauth: oauth ?? HQRefreshOAuth(refreshed: refreshedTokens),
            tokenStore: store ?? HQMemoryTokenStore(tokens: validTokens),
            protectedState: protected ?? HQMemoryProtectedState(),
            signOutFence: HQMemoryFence(),
            idTokenValidator: HQHTTPTestValidator()
        )
    }

    private var validTokens: HQAuthTokens {
        HQAuthTokens(idToken: "stored-id-token", accessToken: "stored-access-token",
                     refreshToken: "stored-refresh-token", tokenType: "Bearer",
                     expiresAt: Date(timeIntervalSinceNow: 3_600), subjectID: "subject")
    }

    private var refreshedTokens: HQAuthTokens {
        HQAuthTokens(idToken: "refreshed-id-token", accessToken: "refreshed-access-token",
                     refreshToken: "stored-refresh-token", tokenType: "Bearer",
                     expiresAt: Date(timeIntervalSinceNow: 7_200), subjectID: "subject")
    }

    private var mobileConfigurationData: Data {
        Data("""
        {"features":{"agents":false,"claudeAutoOpen":false,"groupMessaging":false,"pushPreviews":false,"reactions":false,"threadReplies":false,"work":false}}
        """.utf8)
    }

    private var realtimeCredentialsData: Data {
        let expiry = ISO8601DateFormatter().string(from: Date().addingTimeInterval(3_600))
        return Data("""
        {"contractVersion":2,"credentials":{"accessKeyId":"ASIAEXAMPLE000000001","secretAccessKey":"secret","sessionToken":"session","expiration":"\(expiry)"},"iotEndpoint":"a1example-ats.iot.us-east-1.amazonaws.com","region":"us-east-1","clientId":"rt2-12345678-1234-4123-8123-123456789abc","topic":"hq/prs_01KQ2RY9VB1S105X2GZ2EPHKWY/dm","topics":{"dm":"hq/prs_01KQ2RY9VB1S105X2GZ2EPHKWY/dm","sessions":"hq/prs_01KQ2RY9VB1S105X2GZ2EPHKWY/sessions","work":"hq/prs_01KQ2RY9VB1S105X2GZ2EPHKWY/work","notifications":"hq/prs_01KQ2RY9VB1S105X2GZ2EPHKWY/notifications"},"expiresAt":"\(expiry)"}
        """.utf8)
    }

    private func diagnostic(index: Int, statusCode: Int?, outcome: HQNetworkDiagnostic.Outcome) -> HQNetworkDiagnostic {
        HQNetworkDiagnostic(id: UUID(), requestID: UUID(), requestClass: .routeRead, statusCode: statusCode,
                            latency: 0.01, retryCount: index, authentication: .authenticated,
                            outcome: outcome, retryDelayMilliseconds: nil,
                            occurredAt: Date(timeIntervalSince1970: TimeInterval(index)))
    }

    private static func httpDate(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "EEE',' dd MMM yyyy HH':'mm':'ss zzz"
        return formatter.string(from: date)
    }
}

private func captureError<T>(_ operation: () async throws -> T,
                             file: StaticString = #filePath, line: UInt = #line) async -> Error? {
    do {
        _ = try await operation()
        XCTFail("Expected an error", file: file, line: line)
        return nil
    } catch {
        return error
    }
}

private func XCTAssertThrowsErrorAsync<T>(_ operation: @autoclosure () async throws -> T,
                                           file: StaticString = #filePath, line: UInt = #line) async {
    _ = await captureError({ try await operation() }, file: file, line: line)
}

private struct HQCapturedRequest: Sendable {
    let authorization: String?
    let requestID: String?
    let accept: String?
    let cookie: String?
}

private actor HQScriptedLoader: HQHTTPResponseLoading {
    enum Step: Sendable {
        case response(status: Int, headers: [String: String], data: Data, url: URL?)
        case urlError(URLError.Code)
    }

    private var steps: [Step]
    private var requests: [HQCapturedRequest] = []

    init(steps: [Step]) { self.steps = steps }

    func load(_ request: URLRequest, maximumBytes: Int) async throws -> HQLoadedHTTPResponse {
        requests.append(HQCapturedRequest(
            authorization: request.value(forHTTPHeaderField: "Authorization"),
            requestID: request.value(forHTTPHeaderField: "X-Request-ID"),
            accept: request.value(forHTTPHeaderField: "Accept"),
            cookie: request.value(forHTTPHeaderField: "Cookie")
        ))
        guard !steps.isEmpty else { throw URLError(.badServerResponse) }
        switch steps.removeFirst() {
        case let .response(status, headers, data, overrideURL):
            let url = overrideURL ?? request.url!
            return HQLoadedHTTPResponse(
                response: HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: headers)!,
                data: data
            )
        case let .urlError(code):
            throw URLError(code)
        }
    }

    func capturedRequests() -> [HQCapturedRequest] { requests }
    func requestCount() -> Int { requests.count }
}

private actor HQDelayRecorder {
    private var recorded: [UInt64] = []
    func append(_ value: UInt64) { recorded.append(value) }
    func values() -> [UInt64] { recorded }
}

private actor HQCancellationLoader: HQHTTPResponseLoading {
    private var count = 0
    private var started = false
    private var waiters: [CheckedContinuation<Void, Never>] = []
    private let error: any Error & Sendable

    init(error: any Error & Sendable) { self.error = error }

    func load(_ request: URLRequest, maximumBytes: Int) async throws -> HQLoadedHTTPResponse {
        count += 1
        started = true
        waiters.forEach { $0.resume() }
        waiters.removeAll()
        do {
            try await Task.sleep(nanoseconds: UInt64.max)
            throw error
        } catch is CancellationError {
            throw error
        }
    }

    func waitUntilStarted() async {
        if started { return }
        await withCheckedContinuation { waiters.append($0) }
    }

    func requestCount() -> Int { count }
}

private actor HQBackoffGate {
    private var started = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func pause(_ nanoseconds: UInt64) async throws {
        started = true
        waiters.forEach { $0.resume() }
        waiters.removeAll()
        try await Task.sleep(nanoseconds: UInt64.max)
    }

    func waitUntilStarted() async {
        if started { return }
        await withCheckedContinuation { waiters.append($0) }
    }
}

private enum HQHTTPStubAction {
    case response(HTTPURLResponse, [Data])
}

private final class HQHTTPStubURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: (@Sendable (URLRequest) -> HQHTTPStubAction)?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let action = Self.handler?(request) else { fatalError("Missing URL protocol handler") }
        switch action {
        case let .response(response, chunks):
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            for chunk in chunks { client?.urlProtocol(self, didLoad: chunk) }
            client?.urlProtocolDidFinishLoading(self)
        }
    }

    override func stopLoading() {}
}

private final class HQRedirectDecisionCapture: @unchecked Sendable {
    private let lock = NSLock()
    private var called = false
    private var request: URLRequest?

    func record(_ request: URLRequest?) {
        lock.withLock {
            called = true
            self.request = request
        }
    }

    var wasCalled: Bool { lock.withLock { called } }
    var followedRequest: URLRequest? { lock.withLock { request } }
}

private actor HQRefreshOAuth: HQTokenRefreshing {
    private let refreshed: HQAuthTokens
    private let delayNanoseconds: UInt64
    private var refreshes = 0

    init(refreshed: HQAuthTokens, delayNanoseconds: UInt64 = 0) {
        self.refreshed = refreshed
        self.delayNanoseconds = delayNanoseconds
    }

    func refresh(refreshToken: String) async throws -> HQAuthTokens {
        refreshes += 1
        if delayNanoseconds > 0 { try await Task.sleep(nanoseconds: delayNanoseconds) }
        return refreshed
    }

    func revoke(refreshToken: String) async throws {}
    func refreshCount() -> Int { refreshes }
}

private actor HQMemoryTokenStore: HQTokenStoring {
    private var tokens: HQAuthTokens?
    private var purges = 0

    init(tokens: HQAuthTokens?) { self.tokens = tokens }
    func load() async throws -> HQAuthTokens? { tokens }
    func save(_ tokens: HQAuthTokens) async throws { self.tokens = tokens }
    func purge() async throws { tokens = nil; purges += 1 }
    func purgeCount() -> Int { purges }
}

private actor HQMemoryProtectedState: HQProtectedStatePurging {
    private var purges = 0
    func purgeAllProtectedState() async throws { purges += 1 }
    func purgeCount() -> Int { purges }
}

private actor HQMemoryFence: HQSignOutFenceStoring {
    private var armed = false
    func isArmed() async throws -> Bool { armed }
    func arm() async throws { armed = true }
    func clear() async throws { armed = false }
}

private struct HQHTTPTestValidator: HQIDTokenValidating {
    func validate(_ token: String, now: Date) async throws -> HQValidatedIDToken {
        HQValidatedIDToken(subjectID: "subject", expiresAt: now.addingTimeInterval(7_200))
    }
}

private actor HQCredentialSequenceTransport: HQHTTPSending {
    private var statuses: [Int]
    private let successData: Data
    private var tokens: [String] = []
    private var requests: [HQHTTPRequest] = []

    init(statuses: [Int], successData: Data) {
        self.statuses = statuses
        self.successData = successData
    }

    func send(_ request: HQHTTPRequest, credentials: HQAuthorizationCredentials) async throws -> HQHTTPResponse {
        tokens.append(credentials.idToken)
        requests.append(request)
        guard !statuses.isEmpty else { throw URLError(.badServerResponse) }
        let status = statuses.removeFirst()
        return HQHTTPResponse(statusCode: status, data: status == 200 ? successData : Data("{\"error\":\"unauthorized\"}".utf8),
                              requestID: UUID(), retryCount: 0)
    }

    func idTokens() -> [String] { tokens }
    func callCount() -> Int { tokens.count }
    func capturedRequests() -> [HQHTTPRequest] { requests }
}

private actor HQConcurrent401Transport: HQHTTPSending {
    private let successData: Data
    private var storedCalls = 0
    private var refreshedCalls = 0
    private var storedWaiters: [CheckedContinuation<Void, Never>] = []

    init(successData: Data) { self.successData = successData }

    func send(_ request: HQHTTPRequest, credentials: HQAuthorizationCredentials) async throws -> HQHTTPResponse {
        if credentials.idToken == "stored-id-token" {
            storedCalls += 1
            if storedCalls < 2 {
                await withCheckedContinuation { storedWaiters.append($0) }
            } else {
                storedWaiters.forEach { $0.resume() }
                storedWaiters.removeAll()
            }
            return HQHTTPResponse(statusCode: 401, data: Data(), requestID: UUID(), retryCount: 0)
        }
        refreshedCalls += 1
        return HQHTTPResponse(statusCode: 200, data: successData, requestID: UUID(), retryCount: 0)
    }

    func storedTokenCalls() -> Int { storedCalls }
    func refreshedTokenCalls() -> Int { refreshedCalls }
}

private struct HQTestPayload: Codable, Equatable, Sendable {
    let value: String
}

private extension Data {
    func chunked(size: Int) -> [Data] {
        stride(from: 0, to: count, by: size).map { start in
            subdata(in: start ..< Swift.min(start + size, count))
        }
    }
}
