import Foundation
import XCTest
@testable import HQIOS

final class HQMQTTProtocolTests: XCTestCase {
    func testWakeEnvelopeAcceptsOnlyTheExactV2RecipientScopedContract() throws {
        let decoded = try HQRealtimeWakeEnvelopeDecoder.decode(wakePayload(), expectedRecipient: principal)
        XCTAssertEqual(decoded.eventID.uuidString.lowercased(), eventID)
        XCTAssertEqual(decoded.eventType, "work.changed")
        XCTAssertEqual(decoded.scope, "work")
        XCTAssertEqual(decoded.resourceID, "thr_01KQ2RY9VB1S105X2GZ2EPHKWY")
        XCTAssertEqual(decoded.recipientUID, principal)

        let invalid: [(String, Data)] = [
            ("extra key", wakePayload(extra: ["payload": "must-not-cross"])),
            ("foreign recipient", wakePayload(recipient: "agt_01KQ2RY9VB1S105X2GZ2EPHKWY")),
            ("non-UUID event", wakePayload(eventID: "evt_1")),
            ("unsupported scope", wakePayload(scope: "admin")),
            ("malformed event type", wakePayload(eventType: "Secret Rotated")),
            ("invalid timestamp", wakePayload(createdAt: "not-a-date")),
            ("oversized", Data(repeating: 0x41, count: 1_025))
        ]
        for (label, payload) in invalid {
            XCTAssertThrowsError(try HQRealtimeWakeEnvelopeDecoder.decode(payload, expectedRecipient: principal), label)
        }
    }

    func testSubscribedTopicTreatsForwardCompatibleV2EnvelopeAsWakeOnly() async throws {
        let payload = wakePayload(
            eventType: "notification.created",
            scope: "dm",
            resourceID: "ntf_01KQ2RY9VB1S105X2GZ2EPHKWY"
        )
        let socket = TestWebSocket(frames: [
            .data(Data([0x20, 0x02, 0x00, 0x00])),
            .data(Data([0x90, 0x06, 0x00, 0x01, 0x01, 0x01, 0x01, 0x01])),
            .data(publishPacket(topic: topics[3], packetID: 45, payload: payload))
        ])
        let connector = HQURLSessionMQTTConnector(factory: RecordingWebSocketFactory(socket: socket))
        let session = try await connector.connect(url: signedURL, clientID: clientID, keepAliveSeconds: 45)
        try await session.subscribe(topics: topics, qos: 1)

        let wake = try await session.nextWake()
        XCTAssertEqual(wake?.envelope?.eventType, "notification.created")
        XCTAssertEqual(wake?.topic, topics[3])
        let sent = await socket.sentPackets()
        XCTAssertEqual(sent.last, Data([0x40, 0x02, 0x00, 0x2D]))
        await session.disconnect()
    }

    func testCodecParsesCanonicalMultibyteQoS1PublishAndRejectsUnsafeFrames() throws {
        let payload = wakePayload()
        let publish = publishPacket(topic: topics[2], packetID: 42, payload: payload)
        XCTAssertNotEqual(publish[1] & 0x80, 0, "The fixed envelope must exercise MQTT multibyte remaining length.")
        var buffer = publish
        XCTAssertEqual(
            try HQMQTTWireCodec.decodeNext(from: &buffer),
            .publish(topic: topics[2], packetID: 42, payload: payload)
        )
        XCTAssertTrue(buffer.isEmpty)
        XCTAssertEqual(HQMQTTWireCodec.pubAck(packetID: 42), Data([0x40, 0x02, 0x00, 0x2A]))
        XCTAssertEqual(HQMQTTWireCodec.pingRequest, Data([0xC0, 0x00]))

        var nonCanonical = Data([0x30, 0x80, 0x00])
        XCTAssertThrowsError(try HQMQTTWireCodec.decodeNext(from: &nonCanonical))
        var oversized = Data([0x30, 0x81, 0x10]) // 2,049-byte remaining length.
        XCTAssertThrowsError(try HQMQTTWireCodec.decodeNext(from: &oversized)) {
            XCTAssertEqual($0 as? HQRealtimeClientError, .packetTooLarge)
        }
        var qosZero = publish
        qosZero[0] = 0x30
        XCTAssertThrowsError(try HQMQTTWireCodec.decodeNext(from: &qosZero))
        var badUTF8 = publishPacket(topicBytes: Data([0xC3, 0x28]), packetID: 7, payload: payload)
        XCTAssertThrowsError(try HQMQTTWireCodec.decodeNext(from: &badUTF8))
    }

    func testConnectorRequestsAndVerifiesMQTTWebSocketSubprotocol() async throws {
        let socket = TestWebSocket(frames: [.data(Data([0x20, 0x02, 0x00, 0x00]))], negotiated: "mqtt")
        let factory = RecordingWebSocketFactory(socket: socket)
        let connector = HQURLSessionMQTTConnector(factory: factory)
        let session = try await connector.connect(url: signedURL, clientID: clientID, keepAliveSeconds: 45)

        XCTAssertEqual(factory.requestedSubprotocols, ["mqtt"])
        XCTAssertEqual(factory.requestedURL, signedURL)
        let sent = await socket.sentPackets()
        XCTAssertEqual(sent.first?.first, 0x10)
        await session.disconnect()

        let wrongSocket = TestWebSocket(frames: [.data(Data([0x20, 0x02, 0x00, 0x00]))], negotiated: "http/1.1")
        let wrong = HQURLSessionMQTTConnector(factory: RecordingWebSocketFactory(socket: wrongSocket))
        let error = await capturedError { try await wrong.connect(url: self.signedURL, clientID: self.clientID, keepAliveSeconds: 45) }
        XCTAssertEqual(error as? HQRealtimeClientError, .invalidWebSocketSubprotocol)
        let wrongCancellationCount = await wrongSocket.cancelCount()
        XCTAssertEqual(wrongCancellationCount, 1)
    }

    func testSessionRejectsMissingSubprotocolAndIncompleteTopicSet() async throws {
        let missingProtocolSocket = TestWebSocket(
            frames: [.data(Data([0x20, 0x02, 0x00, 0x00]))],
            negotiated: nil
        )
        let missingProtocol = HQURLSessionMQTTConnector(
            factory: RecordingWebSocketFactory(socket: missingProtocolSocket)
        )
        let protocolError = await capturedError {
            try await missingProtocol.connect(
                url: self.signedURL,
                clientID: self.clientID,
                keepAliveSeconds: 45
            )
        }
        XCTAssertEqual(protocolError as? HQRealtimeClientError, .invalidWebSocketSubprotocol)
        let protocolCancellationCount = await missingProtocolSocket.cancelCount()
        XCTAssertEqual(protocolCancellationCount, 1)

        let incompleteSocket = TestWebSocket(frames: [
            .data(Data([0x20, 0x02, 0x00, 0x00])),
            .data(Data([0x90, 0x03, 0x00, 0x01, 0x01]))
        ])
        let incompleteSession = try await HQURLSessionMQTTConnector(
            factory: RecordingWebSocketFactory(socket: incompleteSocket)
        ).connect(url: signedURL, clientID: clientID, keepAliveSeconds: 45)
        let topicError = await capturedError {
            try await incompleteSession.subscribe(topics: [self.topics[0]], qos: 1)
        }
        XCTAssertEqual(topicError as? HQRealtimeClientError, .invalidMQTTPacket)
        let incompleteCancellationCount = await incompleteSocket.cancelCount()
        XCTAssertEqual(incompleteCancellationCount, 1)
    }

    func testConnectTimeoutIsDeterministicAndCancelsTheInFlightSocket() async {
        let scheduler = ManualRealtimeScheduler()
        let socket = TestWebSocket()
        let connector = HQURLSessionMQTTConnector(
            factory: RecordingWebSocketFactory(socket: socket),
            operationTimeoutNanoseconds: 10,
            sleep: scheduler.sleep
        )
        let url = signedURL
        let identifier = clientID
        let pending = Task { try await connector.connect(url: url, clientID: identifier, keepAliveSeconds: 45) }
        await scheduler.waitForPendingSleeps(1)
        scheduler.advance(by: 10)

        let error = await capturedError { try await pending.value }
        XCTAssertEqual(error as? HQRealtimeClientError, .operationTimedOut)
        let cancellationCount = await socket.cancelCount()
        XCTAssertEqual(cancellationCount, 1)
    }

    func testQoS1PublishIsPubAckedBeforeDeliveryAndIdenticalDuplicateIsDropped() async throws {
        let firstPayload = wakePayload()
        let secondID = "87654321-4321-4123-8123-cba987654321"
        let secondPayload = wakePayload(eventID: secondID, resourceID: "thr_second")
        let socket = TestWebSocket(frames: [
            .data(Data([0x20, 0x02, 0x00, 0x00])),
            .data(Data([0x90, 0x06, 0x00, 0x01, 0x01, 0x01, 0x01, 0x01])),
            .data(publishPacket(topic: topics[2], packetID: 42, payload: firstPayload)),
            .data(publishPacket(topic: topics[2], packetID: 43, payload: firstPayload)),
            .data(publishPacket(topic: topics[2], packetID: 44, payload: secondPayload))
        ])
        let connector = HQURLSessionMQTTConnector(factory: RecordingWebSocketFactory(socket: socket))
        let session = try await connector.connect(url: signedURL, clientID: clientID, keepAliveSeconds: 45)
        try await session.subscribe(topics: topics, qos: 1)

        let first = try await session.nextWake()
        let second = try await session.nextWake()
        XCTAssertEqual(first?.envelope?.eventID.uuidString.lowercased(), eventID)
        XCTAssertEqual(second?.envelope?.eventID.uuidString.lowercased(), secondID)
        let sent = await socket.sentPackets()
        XCTAssertEqual(Array(sent.suffix(3)), [
            Data([0x40, 0x02, 0x00, 0x2A]),
            Data([0x40, 0x02, 0x00, 0x2B]),
            Data([0x40, 0x02, 0x00, 0x2C])
        ])
        await session.disconnect()
    }

    func testConflictingEventReuseAndTextOrUnsupportedFramesDisconnect() async throws {
        let conflict = wakePayload(resourceID: "thr_conflict")
        let socket = TestWebSocket(frames: [
            .data(Data([0x20, 0x02, 0x00, 0x00])),
            .data(Data([0x90, 0x06, 0x00, 0x01, 0x01, 0x01, 0x01, 0x01])),
            .data(publishPacket(topic: topics[2], packetID: 8, payload: wakePayload())),
            .data(publishPacket(topic: topics[2], packetID: 9, payload: conflict))
        ])
        let session: any HQMQTTSession
        do {
            session = try await HQURLSessionMQTTConnector(factory: RecordingWebSocketFactory(socket: socket))
                .connect(url: signedURL, clientID: clientID, keepAliveSeconds: 45)
        } catch {
            XCTFail("CONNECT setup failed: \(error)")
            return
        }
        do {
            try await session.subscribe(topics: topics, qos: 1)
        } catch {
            XCTFail("SUBSCRIBE setup failed: \(error)")
            return
        }
        do {
            _ = try await session.nextWake()
        } catch {
            XCTFail("Initial wake setup failed: \(error)")
            return
        }
        let conflictError = await capturedError { try await session.nextWake() }
        XCTAssertEqual(conflictError as? HQRealtimeClientError, .duplicateWakeConflict)
        let conflictCancellationCount = await socket.cancelCount()
        XCTAssertEqual(conflictCancellationCount, 1)

        for frame in [HQWebSocketMessage.text("not MQTT"), .data(Data([0xE0, 0x00]))] {
            let hostile = TestWebSocket(frames: [
                .data(Data([0x20, 0x02, 0x00, 0x00])),
                .data(Data([0x90, 0x06, 0x00, 0x01, 0x01, 0x01, 0x01, 0x01])), frame
            ])
            let hostileSession = try await HQURLSessionMQTTConnector(factory: RecordingWebSocketFactory(socket: hostile))
                .connect(url: signedURL, clientID: clientID, keepAliveSeconds: 45)
            try await hostileSession.subscribe(topics: topics, qos: 1)
            let hostileError = await capturedError { try await hostileSession.nextWake() }
            let hostileCancellationCount = await hostile.cancelCount()
            XCTAssertNotNil(hostileError)
            XCTAssertEqual(hostileCancellationCount, 1)
        }
    }

    func testKeepAliveRequiresPingResponseAndDisconnectsOnWatchdogExpiry() async throws {
        let scheduler = ManualRealtimeScheduler()
        let socket = TestWebSocket(frames: [
            .data(Data([0x20, 0x02, 0x00, 0x00])),
            .data(Data([0x90, 0x06, 0x00, 0x01, 0x01, 0x01, 0x01, 0x01]))
        ])
        let connector = HQURLSessionMQTTConnector(
            factory: RecordingWebSocketFactory(socket: socket),
            sleep: scheduler.sleep
        )
        let session = try await connector.connect(
            url: signedURL,
            clientID: clientID,
            keepAliveSeconds: 1
        )
        try await session.subscribe(topics: topics, qos: 1)
        let pendingWake = Task { try await session.nextWake() }
        await scheduler.waitForPendingSleeps(1)
        scheduler.advance(by: 1_000_000_000)
        await waitUntil { await socket.sentPackets().contains(HQMQTTWireCodec.pingRequest) }
        await socket.enqueue(.data(
            Data([0xD0, 0x00]) +
                publishPacket(topic: topics[2], packetID: 77, payload: wakePayload())
        ))
        let wake = try await pendingWake.value
        XCTAssertEqual(wake?.envelope?.eventID.uuidString.lowercased(), eventID)
        await session.disconnect()

        let timeoutScheduler = ManualRealtimeScheduler()
        let timeoutSocket = TestWebSocket(frames: [
            .data(Data([0x20, 0x02, 0x00, 0x00])),
            .data(Data([0x90, 0x06, 0x00, 0x01, 0x01, 0x01, 0x01, 0x01]))
        ])
        let timeoutSession = try await HQURLSessionMQTTConnector(
            factory: RecordingWebSocketFactory(socket: timeoutSocket),
            sleep: timeoutScheduler.sleep
        ).connect(url: signedURL, clientID: clientID, keepAliveSeconds: 1)
        try await timeoutSession.subscribe(topics: topics, qos: 1)
        let timedOutWake = Task { try await timeoutSession.nextWake() }
        await timeoutScheduler.waitForPendingSleeps(1)
        timeoutScheduler.advance(by: 1_000_000_000)
        await waitUntil {
            await timeoutSocket.sentPackets().contains(HQMQTTWireCodec.pingRequest)
        }
        await timeoutScheduler.waitForPendingSleeps(1)
        timeoutScheduler.advance(by: 1_000_000_000)
        let error = await capturedError { try await timedOutWake.value }
        XCTAssertEqual(error as? HQRealtimeClientError, .pingTimedOut)
        let cancellations = await timeoutSocket.cancelCount()
        XCTAssertEqual(cancellations, 1)
    }

    func testFastPingResponseBeforeSendCompletesDoesNotTripWatchdog() async throws {
        let scheduler = ManualRealtimeScheduler()
        let socket = TestWebSocket(
            frames: [
                .data(Data([0x20, 0x02, 0x00, 0x00])),
                .data(Data([0x90, 0x06, 0x00, 0x01, 0x01, 0x01, 0x01, 0x01]))
            ],
            blockFirstSendMatching: HQMQTTWireCodec.pingRequest
        )
        let session = try await HQURLSessionMQTTConnector(
            factory: RecordingWebSocketFactory(socket: socket),
            sleep: scheduler.sleep
        ).connect(url: signedURL, clientID: clientID, keepAliveSeconds: 1)
        try await session.subscribe(topics: topics, qos: 1)

        let pendingWake = Task { try await session.nextWake() }
        await scheduler.waitForPendingSleeps(1)
        scheduler.advance(by: 1_000_000_000)
        await socket.waitUntilSendBlocked()
        await socket.enqueue(.data(
            Data([0xD0, 0x00]) +
                publishPacket(topic: topics[2], packetID: 78, payload: wakePayload())
        ))
        _ = try await pendingWake.value
        await socket.releaseBlockedSend()
        await waitUntil { scheduler.pendingDelays().sorted() == [1_000_000_000] }

        scheduler.advance(by: 1_000_000_000)
        await waitUntil {
            await socket.sentPackets().filter { $0 == HQMQTTWireCodec.pingRequest }.count == 2
        }
        let cancellationCount = await socket.cancelCount()
        XCTAssertEqual(cancellationCount, 0)
        await session.disconnect()
    }

    func testPubAckSendIsBoundedAndTimeoutDisconnectsBeforeWakeDelivery() async throws {
        let scheduler = ManualRealtimeScheduler()
        let pubAck = HQMQTTWireCodec.pubAck(packetID: 79)
        let socket = TestWebSocket(
            frames: [
                .data(Data([0x20, 0x02, 0x00, 0x00])),
                .data(Data([0x90, 0x06, 0x00, 0x01, 0x01, 0x01, 0x01, 0x01])),
                .data(publishPacket(topic: topics[2], packetID: 79, payload: wakePayload()))
            ],
            blockFirstSendMatching: pubAck
        )
        let session = try await HQURLSessionMQTTConnector(
            factory: RecordingWebSocketFactory(socket: socket),
            operationTimeoutNanoseconds: 10_000_000_000,
            sleep: scheduler.sleep
        ).connect(url: signedURL, clientID: clientID, keepAliveSeconds: 45)
        try await session.subscribe(topics: topics, qos: 1)

        let pendingWake = Task { try await session.nextWake() }
        await socket.waitUntilSendBlocked()
        for _ in 0 ..< 20 { await Task.yield() }
        let hasAckTimeout = scheduler.pendingDelays().contains(10_000_000_000)
        XCTAssertTrue(hasAckTimeout, "PUBACK must use the bounded send path")
        if hasAckTimeout {
            scheduler.advance(by: 10_000_000_000)
        } else {
            await socket.releaseBlockedSend()
        }

        let error = await capturedError { try await pendingWake.value }
        XCTAssertEqual(error as? HQRealtimeClientError, .operationTimedOut)
        let cancellationCount = await socket.cancelCount()
        XCTAssertEqual(cancellationCount, 1)
        await session.disconnect()
    }

    func testBackgroundAwaitsInFlightConnectAndFencesItsStaleSession() async {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let credentials = try! clientCredentials(now: now)
        let session = DeferredClientSession()
        let connector = DeferredClientConnector(session: session)
        let reconciler = HQReconciler(operation: {})
        let client = HQRealtimeClient(
            credentialsProvider: { credentials },
            connector: connector,
            signer: HQIoTWebSocketSigner(now: { now }),
            reconciler: reconciler
        )
        let foreground = Task { await client.foregrounded() }
        await connector.waitUntilStarted()
        let completion = AsyncCompletionFlag()
        let background = Task {
            await client.backgrounded()
            await completion.markComplete()
        }
        for _ in 0 ..< 20 { await Task.yield() }
        let completedBeforeConnectReturned = await completion.isComplete()
        XCTAssertFalse(
            completedBeforeConnectReturned,
            "Teardown must await the cancelled in-flight connection boundary."
        )

        await connector.complete()
        await background.value
        await foreground.value
        let state = await client.currentState()
        let subscribes = await session.subscribeCount()
        let disconnects = await session.disconnectCount()
        XCTAssertEqual(state, .suspended)
        XCTAssertEqual(subscribes, 0)
        XCTAssertEqual(disconnects, 1)
    }

    func testSlowRESTReconciliationDoesNotBlockSocketDrainAndWakeBurstCoalesces() async {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let credentials = try! clientCredentials(now: now)
        let session = QueuedClientSession()
        let connector = QueuedClientConnector(session: session)
        let gate = MQTTGate()
        let reconciliation = BlockingClientReconciliation(blockedRun: 3, gate: gate)
        let reconciler = HQReconciler(operation: { try await reconciliation.run() })
        let client = HQRealtimeClient(
            credentialsProvider: { credentials },
            connector: connector,
            signer: HQIoTWebSocketSigner(now: { now }),
            reconciler: reconciler
        )

        await client.foregrounded()
        await waitUntil { await reconciliation.count() == 2 }
        await session.enqueue(HQRealtimeWake(topic: topics[2]))
        await waitUntil { await reconciliation.count() == 3 }
        for index in 0 ..< 32 {
            await session.enqueue(HQRealtimeWake(topic: "hq/ignored/\(index)"))
        }

        await waitUntil { await session.deliveryCount() == 33 }
        let runsWhileBlocked = await reconciliation.count()
        XCTAssertEqual(runsWhileBlocked, 3)
        await gate.open()
        await waitUntil { await reconciliation.count() == 4 }
        for _ in 0 ..< 100 { await Task.yield() }
        let coalescedRunCount = await reconciliation.count()
        XCTAssertEqual(coalescedRunCount, 4)
        await client.backgrounded()
    }

    func testReconnectBackoffUsesFullJitterWithOneThroughSixtySecondCap() {
        let ceilings = (1 ... 8).map {
            HQRealtimeClient.reconnectDelay(failure: $0, randomUnit: 1)
        }
        XCTAssertEqual(ceilings, [1, 2, 4, 8, 16, 32, 60, 60])
        XCTAssertEqual(HQRealtimeClient.reconnectDelay(failure: 4, randomUnit: 0.5), 4)
        XCTAssertGreaterThan(
            HQRealtimeClient.reconnectDelay(failure: 1, randomUnit: 0),
            0,
            "Even the lowest jitter draw must not create a tight retry loop."
        )
    }

    func testClientUsesExpirySkewAndRunsSafetyPollingWhileConnected() async {
        let initialNow = Date(timeIntervalSince1970: 1_700_000_000)
        let scheduler = ManualRealtimeScheduler(baseDate: initialNow)
        let credentials = try! clientCredentials(now: initialNow, expiresIn: 120)
        let session = StableClientSession()
        let connector = StableClientConnector(session: session)
        let counter = ClientReconciliationCounter()
        let reconciler = HQReconciler(operation: { await counter.increment() })
        let client = HQRealtimeClient(
            credentialsProvider: { credentials },
            connector: connector,
            signer: HQIoTWebSocketSigner(now: { scheduler.dateNow() }),
            reconciler: reconciler,
            pollInterval: 30,
            refreshSkew: 60,
            stableConnectionInterval: 90,
            now: { scheduler.dateNow() },
            randomUnit: { 1 },
            sleep: scheduler.sleep
        )

        await client.foregrounded()
        await scheduler.waitForPendingSleeps(3)
        let initialDelays = scheduler.pendingDelays().sorted()
        XCTAssertEqual(initialDelays, [
            30_000_000_000,
            60_000_000_000,
            90_000_000_000
        ])

        let beforePoll = await counter.value()
        scheduler.advance(by: 30_000_000_000)
        await waitUntil { await counter.value() > beforePoll }
        let connectionsBeforeRenewal = await connector.connectCount()
        XCTAssertEqual(connectionsBeforeRenewal, 1)

        scheduler.advance(by: 30_000_000_000)
        await waitUntil { await connector.connectCount() == 2 }
        let disconnectsAtRenewal = await session.disconnectCount()
        XCTAssertEqual(disconnectsAtRenewal, 1)
        await client.backgrounded()
    }

    private let principal = "prs_01KQ2RY9VB1S105X2GZ2EPHKWY"
    private let eventID = "12345678-1234-4123-8123-123456789abc"
    private let clientID = "rt2-12345678-1234-4123-8123-123456789abc"
    private let signedURL = URL(string: "wss://a1example-ats.iot.us-east-1.amazonaws.com/mqtt?redacted=test")!

    private var topics: [String] {
        ["dm", "sessions", "work", "notifications"].map { "hq/\(principal)/\($0)" }
    }

    private func wakePayload(eventID: String? = nil, eventType: String = "work.changed", scope: String = "work",
                             resourceID: String = "thr_01KQ2RY9VB1S105X2GZ2EPHKWY", recipient: String? = nil,
                             createdAt: String = "2026-08-14T12:00:00.000Z", extra: [String: Any] = [:]) -> Data {
        var object: [String: Any] = [
            "contractVersion": 2,
            "eventId": eventID ?? self.eventID,
            "eventType": eventType,
            "scope": scope,
            "resourceId": resourceID,
            "recipientUid": recipient ?? principal,
            "createdAt": createdAt
        ]
        extra.forEach { object[$0] = $1 }
        return try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    }

    private func publishPacket(topic: String, packetID: UInt16, payload: Data) -> Data {
        publishPacket(topicBytes: Data(topic.utf8), packetID: packetID, payload: payload)
    }

    private func publishPacket(topicBytes: Data, packetID: UInt16, payload: Data) -> Data {
        var body = Data([UInt8(topicBytes.count >> 8), UInt8(topicBytes.count & 0xFF)])
        body += topicBytes
        body += Data([UInt8(packetID >> 8), UInt8(packetID & 0xFF)])
        body += payload
        return Data([0x32]) + independentlyEncodedRemainingLength(body.count) + body
    }

    private func independentlyEncodedRemainingLength(_ length: Int) -> Data {
        precondition(length >= 0)
        var quotient = length
        var bytes = Data()
        repeat {
            let remainder = quotient % 128
            quotient /= 128
            bytes.append(UInt8(remainder) | (quotient == 0 ? 0 : 0x80))
        } while quotient != 0
        return bytes
    }

    private func clientCredentials(now: Date,
                                   expiresIn: TimeInterval = 3_600) throws -> HQRealtimeCredentials {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        let expiry = formatter.string(from: now.addingTimeInterval(expiresIn))
        let body = """
        {"contractVersion":2,"credentials":{"accessKeyId":"ASIAFIXEDVECTOR00001","secretAccessKey":"fixedSecretKeyForVectorTests/0001","sessionToken":"FwoGZXIvYXdzEFixedVectorToken+With/Special=Chars0001","expiration":"\(expiry)"},"iotEndpoint":"a1example-ats.iot.us-east-1.amazonaws.com","region":"us-east-1","clientId":"rt2-12345678-1234-4123-8123-123456789abc","topic":"hq/\(principal)/dm","topics":{"dm":"hq/\(principal)/dm","sessions":"hq/\(principal)/sessions","work":"hq/\(principal)/work","notifications":"hq/\(principal)/notifications"},"expiresAt":"\(expiry)"}
        """
        var decoder = HQDomainJSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        decoder.realtimeValidationNow = now
        return try decoder.decode(HQRealtimeCredentials.self, from: Data(body.utf8))
    }

    private func waitUntil(_ condition: @escaping @Sendable () async -> Bool) async {
        for _ in 0 ..< 1_000 {
            if await condition() { return }
            await Task.yield()
        }
        XCTFail("Timed out waiting for asynchronous MQTT state")
    }
}

private func capturedError<T: Sendable>(_ operation: () async throws -> T) async -> Error? {
    do { _ = try await operation(); return nil } catch { return error }
}

private actor AsyncCompletionFlag {
    private var complete = false
    func markComplete() { complete = true }
    func isComplete() -> Bool { complete }
}

private actor DeferredClientConnector: HQMQTTConnecting {
    private let session: DeferredClientSession
    private var connectContinuation: CheckedContinuation<Void, Never>?
    private var startWaiters: [CheckedContinuation<Void, Never>] = []
    private var started = false

    init(session: DeferredClientSession) { self.session = session }

    func connect(url _: URL, clientID _: String,
                 keepAliveSeconds _: UInt16) async throws -> any HQMQTTSession {
        started = true
        let waiters = startWaiters
        startWaiters.removeAll()
        waiters.forEach { $0.resume() }
        await withCheckedContinuation { connectContinuation = $0 }
        return session
    }

    func waitUntilStarted() async {
        if started { return }
        await withCheckedContinuation { startWaiters.append($0) }
    }

    func complete() {
        connectContinuation?.resume()
        connectContinuation = nil
    }
}

private actor DeferredClientSession: HQMQTTSession {
    private var subscriptions = 0
    private var disconnects = 0

    func subscribe(topics _: [String], qos _: UInt8) async throws {
        subscriptions += 1
    }

    func nextWake() async throws -> HQRealtimeWake? { nil }
    func disconnect() async { disconnects += 1 }
    func subscribeCount() -> Int { subscriptions }
    func disconnectCount() -> Int { disconnects }
}

private actor QueuedClientConnector: HQMQTTConnecting {
    private let session: QueuedClientSession

    init(session: QueuedClientSession) { self.session = session }

    func connect(url _: URL, clientID _: String,
                 keepAliveSeconds _: UInt16) async throws -> any HQMQTTSession {
        session
    }
}

private actor QueuedClientSession: HQMQTTSession {
    private var wakes: [HQRealtimeWake] = []
    private var wakeContinuation: CheckedContinuation<HQRealtimeWake?, Error>?
    private var deliveries = 0

    func subscribe(topics _: [String], qos _: UInt8) async throws {}

    func nextWake() async throws -> HQRealtimeWake? {
        try Task.checkCancellation()
        if !wakes.isEmpty {
            deliveries += 1
            return wakes.removeFirst()
        }
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                wakeContinuation = continuation
            }
        } onCancel: {
            Task { await self.cancelPendingWake() }
        }
    }

    func enqueue(_ wake: HQRealtimeWake) {
        if let wakeContinuation {
            self.wakeContinuation = nil
            deliveries += 1
            wakeContinuation.resume(returning: wake)
        } else {
            wakes.append(wake)
        }
    }

    func disconnect() async { cancelPendingWake() }
    func deliveryCount() -> Int { deliveries }

    private func cancelPendingWake() {
        wakeContinuation?.resume(throwing: CancellationError())
        wakeContinuation = nil
    }
}

private actor MQTTGate {
    private var opened = false
    private var continuations: [CheckedContinuation<Void, Never>] = []

    func wait() async {
        if opened { return }
        await withCheckedContinuation { continuations.append($0) }
    }

    func open() {
        opened = true
        let waiting = continuations
        continuations.removeAll()
        waiting.forEach { $0.resume() }
    }
}

private actor BlockingClientReconciliation {
    private let blockedRun: Int
    private let gate: MQTTGate
    private var runs = 0

    init(blockedRun: Int, gate: MQTTGate) {
        self.blockedRun = blockedRun
        self.gate = gate
    }

    func run() async throws {
        runs += 1
        let ordinal = runs
        if ordinal == blockedRun { await gate.wait() }
        try Task.checkCancellation()
    }

    func count() -> Int { runs }
}

private actor StableClientConnector: HQMQTTConnecting {
    private let session: StableClientSession
    private var connections = 0

    init(session: StableClientSession) { self.session = session }

    func connect(url _: URL, clientID _: String,
                 keepAliveSeconds _: UInt16) async throws -> any HQMQTTSession {
        connections += 1
        return session
    }

    func connectCount() -> Int { connections }
}

private actor StableClientSession: HQMQTTSession {
    private var disconnects = 0
    private var wakeContinuation: CheckedContinuation<HQRealtimeWake?, Error>?

    func subscribe(topics _: [String], qos _: UInt8) async throws {}

    func nextWake() async throws -> HQRealtimeWake? {
        try Task.checkCancellation()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                wakeContinuation = continuation
            }
        } onCancel: {
            Task { await self.cancelPendingWake() }
        }
    }

    func disconnect() async {
        disconnects += 1
        cancelPendingWake()
    }

    func disconnectCount() -> Int { disconnects }

    private func cancelPendingWake() {
        wakeContinuation?.resume(throwing: CancellationError())
        wakeContinuation = nil
    }
}

private actor ClientReconciliationCounter {
    private var reconciliations = 0

    func increment() { reconciliations += 1 }
    func value() -> Int { reconciliations }
}

private final class RecordingWebSocketFactory: HQWebSocketCreating, @unchecked Sendable {
    private let lock = NSLock()
    private let socket: TestWebSocket
    private var capturedURL: URL?
    private var capturedSubprotocols: [String] = []

    init(socket: TestWebSocket) { self.socket = socket }

    func makeWebSocket(url: URL, subprotocols: [String]) -> any HQWebSocketTransport {
        lock.withLock {
            capturedURL = url
            capturedSubprotocols = subprotocols
        }
        return socket
    }

    var requestedURL: URL? { lock.withLock { capturedURL } }
    var requestedSubprotocols: [String] { lock.withLock { capturedSubprotocols } }
}

private actor TestWebSocket: HQWebSocketTransport {
    private var frames: [HQWebSocketMessage]
    private var waiter: CheckedContinuation<HQWebSocketMessage, Error>?
    private var sent: [Data] = []
    private var cancellations = 0
    private let negotiated: String?
    private let blockFirstSendMatching: Data?
    private var didBlockSend = false
    private var sendIsBlocked = false
    private var blockedSendContinuation: CheckedContinuation<Void, Error>?
    private var blockedSendWaiters: [CheckedContinuation<Void, Never>] = []

    init(frames: [HQWebSocketMessage] = [], negotiated: String? = "mqtt",
         blockFirstSendMatching: Data? = nil) {
        self.frames = frames
        self.negotiated = negotiated
        self.blockFirstSendMatching = blockFirstSendMatching
    }

    func resume() async {}
    func send(_ data: Data) async throws {
        sent.append(data)
        guard !didBlockSend, data == blockFirstSendMatching else { return }
        didBlockSend = true
        sendIsBlocked = true
        let waiters = blockedSendWaiters
        blockedSendWaiters.removeAll()
        waiters.forEach { $0.resume() }
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                blockedSendContinuation = continuation
            }
        } onCancel: {
            Task { await self.cancelBlockedSend() }
        }
    }

    func receive() async throws -> HQWebSocketMessage {
        try Task.checkCancellation()
        if !frames.isEmpty { return frames.removeFirst() }
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                waiter = continuation
            }
        } onCancel: {
            Task { await self.cancelPendingReceive() }
        }
    }

    func enqueue(_ frame: HQWebSocketMessage) {
        if let waiter {
            self.waiter = nil
            waiter.resume(returning: frame)
        } else {
            frames.append(frame)
        }
    }

    func negotiatedSubprotocol() async -> String? { negotiated }

    func cancel() async {
        cancellations += 1
        cancelPendingReceive()
        cancelBlockedSend()
    }

    func sentPackets() -> [Data] { sent }
    func cancelCount() -> Int { cancellations }

    func waitUntilSendBlocked() async {
        if sendIsBlocked { return }
        await withCheckedContinuation { blockedSendWaiters.append($0) }
    }

    func releaseBlockedSend() {
        sendIsBlocked = false
        blockedSendContinuation?.resume()
        blockedSendContinuation = nil
    }

    private func cancelPendingReceive() {
        waiter?.resume(throwing: CancellationError())
        waiter = nil
    }

    private func cancelBlockedSend() {
        sendIsBlocked = false
        blockedSendContinuation?.resume(throwing: CancellationError())
        blockedSendContinuation = nil
    }
}

private final class ManualRealtimeScheduler: @unchecked Sendable {
    private struct Waiter {
        let deadline: UInt64
        let continuation: CheckedContinuation<Void, Error>
    }

    private let lock = NSLock()
    private let baseDate: Date
    private var now: UInt64 = 0
    private var waiters: [UUID: Waiter] = [:]
    private var pendingSleepWaiters: [(minimumCount: Int, continuation: CheckedContinuation<Void, Never>)] = []
    private var cancelledBeforeInstall = Set<UUID>()

    init(baseDate: Date = Date(timeIntervalSince1970: 0)) {
        self.baseDate = baseDate
    }

    func dateNow() -> Date {
        lock.withLock {
            baseDate.addingTimeInterval(TimeInterval(now) / 1_000_000_000)
        }
    }

    func pendingDelays() -> [UInt64] {
        lock.withLock {
            waiters.values.map { waiter in
                waiter.deadline > now ? waiter.deadline - now : 0
            }
        }
    }

    func sleep(_ nanoseconds: UInt64) async throws {
        let id = UUID()
        try Task.checkCancellation()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                install(id: id, delay: nanoseconds, continuation: continuation)
            }
        } onCancel: {
            self.cancel(id: id)
        }
    }

    func advance(by nanoseconds: UInt64) {
        let ready: [CheckedContinuation<Void, Error>] = lock.withLock {
            now &+= nanoseconds
            let ids = waiters.compactMap { $0.value.deadline <= now ? $0.key : nil }
            return ids.compactMap { waiters.removeValue(forKey: $0)?.continuation }
        }
        ready.forEach { $0.resume() }
    }

    func waitForPendingSleeps(_ count: Int) async {
        precondition(count > 0)
        await withCheckedContinuation { continuation in
            let isReady = lock.withLock { () -> Bool in
                guard waiters.count < count else { return true }
                pendingSleepWaiters.append((count, continuation))
                return false
            }
            if isReady { continuation.resume() }
        }
    }

    private func install(id: UUID, delay: UInt64, continuation: CheckedContinuation<Void, Error>) {
        let (cancelled, readyWaiters) = lock.withLock { () -> (Bool, [CheckedContinuation<Void, Never>]) in
            if cancelledBeforeInstall.remove(id) != nil { return (true, []) }
            waiters[id] = Waiter(deadline: now &+ delay, continuation: continuation)
            let ready = pendingSleepWaiters.compactMap { waiter -> CheckedContinuation<Void, Never>? in
                waiters.count >= waiter.minimumCount ? waiter.continuation : nil
            }
            pendingSleepWaiters.removeAll { waiters.count >= $0.minimumCount }
            return (false, ready)
        }
        readyWaiters.forEach { $0.resume() }
        if cancelled { continuation.resume(throwing: CancellationError()) }
    }

    private func cancel(id: UUID) {
        let continuation: CheckedContinuation<Void, Error>? = lock.withLock {
            if let waiter = waiters.removeValue(forKey: id) { return waiter.continuation }
            cancelledBeforeInstall.insert(id)
            return nil
        }
        continuation?.resume(throwing: CancellationError())
    }
}
