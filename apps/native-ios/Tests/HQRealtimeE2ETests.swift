import XCTest
@testable import HQIOS

/// Deterministic contract/lifecycle coverage. These are deliberately not named
/// live tests: broker authorization and cross-identity proof require the
/// separately authorized non-production canary described in the PRD.
final class HQRealtimeE2ETests: XCTestCase {
    func testV2CredentialsDecodeOnlyTheExactIdentityScopedDeployedContract() throws {
        let decoded = try decodeCredentials()
        XCTAssertEqual(decoded.topics.all, [
            "hq/\(principal)/dm", "hq/\(principal)/sessions",
            "hq/\(principal)/work", "hq/\(principal)/notifications"
        ])
        XCTAssertEqual(decoded.topic, decoded.topics.dm)
        XCTAssertEqual(decoded.credentials.expiration, vectorExpiry)
        XCTAssertEqual(decoded.expiresAt, vectorExpiry)

        let invalidBodies: [(String, String)] = [
            ("extra top-level key", String(validCredentialJSON.dropLast()) + ",\"extra\":true}"),
            ("extra credential key", validCredentialJSON.replacingOccurrences(of: "\"expiration\":\"2026-08-14T13:00:00Z\"", with: "\"expiration\":\"2026-08-14T13:00:00Z\",\"extra\":true")),
            ("extra topic key", validCredentialJSON.replacingOccurrences(of: "\"notifications\":\"hq/\(principal)/notifications\"", with: "\"notifications\":\"hq/\(principal)/notifications\",\"extra\":\"hq/\(principal)/extra\"")),
            ("topic is not the dm topic", validCredentialJSON.replacingOccurrences(of: "\"topic\":\"hq/\(principal)/dm\"", with: "\"topic\":\"hq/\(principal)/work\"")),
            ("mixed principals", validCredentialJSON.replacingOccurrences(of: "\"work\":\"hq/\(principal)/work\"", with: "\"work\":\"hq/agt_01KQ2RY9VB1S105X2GZ2EPHKWY/work\"")),
            ("wildcard topic", validCredentialJSON.replacingOccurrences(of: "\"work\":\"hq/\(principal)/work\"", with: "\"work\":\"hq/\(principal)/#\"")),
            ("invalid access key shape", validCredentialJSON.replacingOccurrences(of: "ASIAFIXEDVECTOR00001", with: "NOPEFIXEDVECTOR00001")),
            ("non-ASCII secret key", validCredentialJSON.replacingOccurrences(of: "fixedSecretKeyForVectorTests/0001", with: "fixedSecretKeyForVectorTests/é")),
            ("oversized secret key", validCredentialJSON.replacingOccurrences(of: "fixedSecretKeyForVectorTests/0001", with: String(repeating: "s", count: 257))),
            ("whitespace-bearing session token", validCredentialJSON.replacingOccurrences(of: "FwoGZXIvYXdzEFixedVectorToken+With/Special=Chars0001", with: "token with spaces")),
            ("oversized session token", validCredentialJSON.replacingOccurrences(of: "FwoGZXIvYXdzEFixedVectorToken+With/Special=Chars0001", with: String(repeating: "t", count: 4_097))),
            ("scheme-bearing endpoint", validCredentialJSON.replacingOccurrences(of: "\"iotEndpoint\":\"a1example-ats.iot.us-east-1.amazonaws.com\"", with: "\"iotEndpoint\":\"wss://a1example-ats.iot.us-east-1.amazonaws.com\"")),
            ("oversized endpoint label", validCredentialJSON.replacingOccurrences(of: "a1example-ats.iot.us-east-1.amazonaws.com", with: "\(String(repeating: "a", count: 60))-ats.iot.us-east-1.amazonaws.com")),
            ("endpoint region mismatch", validCredentialJSON.replacingOccurrences(of: "iot.us-east-1.amazonaws.com", with: "iot.us-west-2.amazonaws.com")),
            ("non-v4 client id", validCredentialJSON.replacingOccurrences(of: "rt2-12345678-1234-4123-8123-123456789abc", with: "rt2-12345678-1234-1123-8123-123456789abc")),
            ("expiry mirrors differ", validCredentialJSON.replacingOccurrences(of: "\"expiresAt\":\"2026-08-14T13:00:00Z\"", with: "\"expiresAt\":\"2026-08-14T12:59:59Z\"")),
            ("expiry mirrors differ on the wire", validCredentialJSON.replacingOccurrences(of: "\"expiresAt\":\"2026-08-14T13:00:00Z\"", with: "\"expiresAt\":\"2026-08-14T13:00:00.0Z\"")),
            ("non-UTC wire timestamps", validCredentialJSON.replacingOccurrences(of: "2026-08-14T13:00:00Z", with: "2026-08-14T13:00:00+00:00")),
            ("expired", validCredentialJSON.replacingOccurrences(of: "2026-08-14T13:00:00Z", with: "2026-08-14T12:00:00Z"))
        ]
        for (label, body) in invalidBodies {
            XCTAssertThrowsError(try decodeCredentials(Data(body.utf8)), label)
        }

        let longerLived = validCredentialJSON.replacingOccurrences(
            of: "2026-08-14T13:00:00Z",
            with: "2026-08-15T13:00:00Z"
        )
        XCTAssertNoThrow(try decodeCredentials(Data(longerLived.utf8)), "The deployed parser accepts every future UTC expiry")
    }

    func testCredentialVendingUsesTheAuditedIdempotentReplayClass() {
        XCTAssertEqual(HQRouteContractMatrix.descriptor(for: "realtime-credentials")?.replayClass, .provenIdempotentMutation)
    }

    func testCredentialEndpointRejectsAmbiguousDuplicateObjectKeys() throws {
        let descriptor = try XCTUnwrap(HQRouteContractMatrix.descriptor(for: "realtime-credentials"))
        let endpoint = HQEndpointFactory.bare(
            descriptor: descriptor,
            url: try XCTUnwrap(URL(string: "https://hqapi.getindigo.ai/v1/realtime/credentials")),
            requestClass: .realtime,
            as: HQRealtimeCredentials.self
        )
        let duplicateBodies = [
            endpointCredentialJSON.replacingOccurrences(
                of: "{\"contractVersion\":2",
                with: "{\"contractVersion\":2,\"contractVersion\":2"
            ),
            endpointCredentialJSON.replacingOccurrences(
                of: "{\"contractVersion\":2",
                with: "{\"\\u0063ontractVersion\":2,\"contractVersion\":2"
            ),
            endpointCredentialJSON.replacingOccurrences(
                of: "\"accessKeyId\":\"ASIAFIXEDVECTOR00001\"",
                with: "\"accessKeyId\":\"ASIAFIXEDVECTOR00001\",\"accessKeyId\":\"NOPEFIXEDVECTOR00001\""
            ),
            endpointCredentialJSON.replacingOccurrences(
                of: "\"dm\":\"hq/\(principal)/dm\"",
                with: "\"dm\":\"hq/\(principal)/dm\",\"dm\":\"hq/agt_01KQ2RY9VB1S105X2GZ2EPHKWY/dm\""
            )
        ]

        for body in duplicateBodies {
            guard case .degraded = endpoint.decode(200, Data(body.utf8)) else {
                XCTFail("Ambiguous duplicate JSON object keys must fail closed")
                continue
            }
        }
    }

    func testCredentialEndpointEnforcesTheDeployed64KiBResponseCap() throws {
        let descriptor = try XCTUnwrap(HQRouteContractMatrix.descriptor(for: "realtime-credentials"))
        let endpoint = HQEndpointFactory.bare(
            descriptor: descriptor,
            url: try XCTUnwrap(URL(string: "https://hqapi.getindigo.ai/v1/realtime/credentials")),
            requestClass: .realtime,
            as: HQRealtimeCredentials.self
        )
        var exactLimit = Data(endpointCredentialJSON.utf8)
        exactLimit.append(Data(repeating: 0x20, count: (64 * 1_024) - exactLimit.count))
        XCTAssertEqual(exactLimit.count, 64 * 1_024)
        guard case .content = endpoint.decode(200, exactLimit) else {
            return XCTFail("Realtime credentials at the exact 64 KiB boundary must be accepted")
        }

        var oversized = exactLimit
        oversized.append(0x20)

        guard case .degraded = endpoint.decode(200, oversized) else {
            return XCTFail("Realtime credentials larger than 64 KiB must fail closed")
        }
    }

    func testSignerByteMatchesTheSharedGoldenVectorAndDoesNotSignTheToken() throws {
        let now = vectorNow
        let signer = HQIoTWebSocketSigner(now: { now })
        let url = try signer.signedURL(credentials: decodeCredentials())
        XCTAssertEqual(url.absoluteString, goldenSignedURL)
        XCTAssertFalse(url.absoluteString.contains("X-Amz-Expires"))

        let alternate = validCredentialJSON.replacingOccurrences(
            of: "FwoGZXIvYXdzEFixedVectorToken+With/Special=Chars0001",
            with: "completely-different-token"
        )
        let alternateURL = try signer.signedURL(credentials: decodeCredentials(Data(alternate.utf8)))
        XCTAssertEqual(signature(in: url), signature(in: alternateURL))
        XCTAssertTrue(url.absoluteString.hasSuffix("X-Amz-Security-Token=FwoGZXIvYXdzEFixedVectorToken%2BWith%2FSpecial%3DChars0001"))
    }

    func testForegroundWakeReconcilesAndBackgroundSuspendsOneConnection() async {
        let counter = ReconciliationCounter()
        let reconciler = HQReconciler(operation: { await counter.increment() })
        let socket = TestMQTTSession()
        let connector = TestConnector(session: socket)
        let credentials = try! decodeCredentials()
        let client = HQRealtimeClient(
            credentialsProvider: { credentials },
            connector: connector,
            signer: HQIoTWebSocketSigner(now: { Date(timeIntervalSince1970: 1_700_000_000) }),
            reconciler: reconciler,
            sleep: { _ in try await Task.sleep(nanoseconds: 1_000_000_000) }
        )

        await client.foregrounded()
        await waitUntil { await connector.connectCount() == 1 }
        await socket.enqueue(HQRealtimeWake(topic: "hq/person/work"))
        await waitUntil { await counter.value() >= 3 } // foreground, connected, wake
        await client.backgrounded()

        let state = await client.currentState()
        let connections = await connector.connectCount()
        let disconnects = await socket.disconnectCount()
        XCTAssertEqual(state, .suspended)
        XCTAssertEqual(connections, 1)
        XCTAssertEqual(disconnects, 1)
    }

    func testBrokerFailureUsesPollingStateWithoutAUserVisibleFailureLoop() async {
        let counter = ReconciliationCounter()
        let reconciler = HQReconciler(operation: { await counter.increment() })
        let connector = FailingConnector()
        let credentials = try! decodeCredentials()
        let client = HQRealtimeClient(
            credentialsProvider: { credentials },
            connector: connector,
            signer: HQIoTWebSocketSigner(now: { Date(timeIntervalSince1970: 1_700_000_000) }),
            reconciler: reconciler,
            sleep: { _ in try await Task.sleep(nanoseconds: 5_000_000_000) }
        )

        await client.foregrounded()
        let state = await client.currentState()
        let connections = await connector.connectCount()
        XCTAssertEqual(state, .polling)
        XCTAssertEqual(connections, 1)
        await client.backgrounded()
    }

    private var principal: String { "prs_01KQ2RY9VB1S105X2GZ2EPHKWY" }
    private var vectorNow: Date { ISO8601DateFormatter().date(from: "2026-08-14T12:00:00Z")! }
    private var vectorExpiry: Date { ISO8601DateFormatter().date(from: "2026-08-14T13:00:00Z")! }
    private var validCredentialJSON: String {
        """
        {"contractVersion":2,"credentials":{"accessKeyId":"ASIAFIXEDVECTOR00001","secretAccessKey":"fixedSecretKeyForVectorTests/0001","sessionToken":"FwoGZXIvYXdzEFixedVectorToken+With/Special=Chars0001","expiration":"2026-08-14T13:00:00Z"},"iotEndpoint":"a1example-ats.iot.us-east-1.amazonaws.com","region":"us-east-1","clientId":"rt2-12345678-1234-4123-8123-123456789abc","topic":"hq/\(principal)/dm","topics":{"dm":"hq/\(principal)/dm","sessions":"hq/\(principal)/sessions","work":"hq/\(principal)/work","notifications":"hq/\(principal)/notifications"},"expiresAt":"2026-08-14T13:00:00Z"}
        """
    }
    private var endpointCredentialJSON: String {
        validCredentialJSON.replacingOccurrences(
            of: "2026-08-14T13:00:00Z",
            with: "2099-01-01T00:00:00Z"
        )
    }
    private var goldenSignedURL: String {
        "wss://a1example-ats.iot.us-east-1.amazonaws.com/mqtt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=ASIAFIXEDVECTOR00001%2F20260814%2Fus-east-1%2Fiotdevicegateway%2Faws4_request&X-Amz-Date=20260814T120000Z&X-Amz-SignedHeaders=host&X-Amz-Signature=0fc6f54651cd53342e675005c6206e1f118a536e9967d3211403c9e649224958&X-Amz-Security-Token=FwoGZXIvYXdzEFixedVectorToken%2BWith%2FSpecial%3DChars0001"
    }

    private func decodeCredentials(_ data: Data? = nil) throws -> HQRealtimeCredentials {
        var decoder = HQDomainJSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        decoder.realtimeValidationNow = vectorNow
        return try decoder.decode(HQRealtimeCredentials.self, from: data ?? Data(validCredentialJSON.utf8))
    }

    private func signature(in url: URL) -> String? {
        URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?
            .first(where: { $0.name == "X-Amz-Signature" })?.value
    }

    private func waitUntil(_ condition: @escaping @Sendable () async -> Bool) async {
        for _ in 0 ..< 100 {
            if await condition() { return }
            await Task.yield()
        }
        XCTFail("Timed out waiting for asynchronous realtime work")
    }
}

private actor ReconciliationCounter {
    private var count = 0
    func increment() { count += 1 }
    func value() -> Int { count }
}

private actor TestConnector: HQMQTTConnecting {
    private let session: TestMQTTSession
    private var count = 0
    init(session: TestMQTTSession) { self.session = session }
    func connect(url _: URL, clientID _: String, keepAliveSeconds _: UInt16) async throws -> any HQMQTTSession { count += 1; return session }
    func connectCount() -> Int { count }
}

private actor FailingConnector: HQMQTTConnecting {
    private var count = 0
    func connect(url _: URL, clientID _: String, keepAliveSeconds _: UInt16) async throws -> any HQMQTTSession { count += 1; throw HQRealtimeClientError.brokerRejected }
    func connectCount() -> Int { count }
}

private actor TestMQTTSession: HQMQTTSession {
    private var queued: [HQRealtimeWake] = []
    private var waiter: CheckedContinuation<HQRealtimeWake?, Never>?
    private var disconnects = 0

    func subscribe(topics _: [String], qos _: UInt8) async throws {}
    func nextWake() async throws -> HQRealtimeWake? {
        if !queued.isEmpty { return queued.removeFirst() }
        return await withCheckedContinuation { waiter = $0 }
    }
    func enqueue(_ wake: HQRealtimeWake) {
        if let waiter { self.waiter = nil; waiter.resume(returning: wake) } else { queued.append(wake) }
    }
    func disconnect() async { disconnects += 1; waiter?.resume(returning: nil); waiter = nil }
    func disconnectCount() -> Int { disconnects }
}
