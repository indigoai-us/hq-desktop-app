import XCTest
@testable import HQNative

final class HQEngineClientTests: XCTestCase {
    func testStartsOnlyAfterReceivingHandshake() async throws {
        let transport = HQFakeEngineTransport()
        let client = HQEngineClient(
            transport: transport,
            makeRequestID: { "req-start" }
        )

        async let started = client.start()
        await transport.emit(
            #"{"protocolVersion":1,"id":null,"kind":"handshake","sequence":0,"result":{"applicationVersion":"0.10.21","capabilities":["health"],"engineVersion":"0.1.0"},"error":null,"event":null,"data":null}"#
        )

        let handshake = try await started
        XCTAssertEqual(
            handshake,
            .object([
                "applicationVersion": .string("0.10.21"),
                "capabilities": .array([.string("health")]),
                "engineVersion": .string("0.1.0"),
            ])
        )
        let startCount = await transport.startCount
        XCTAssertEqual(startCount, 1)
    }

    func testCorrelatesRequestResultByIdentifier() async throws {
        let transport = HQFakeEngineTransport()
        let client = HQEngineClient(
            transport: transport,
            makeRequestID: { "req-health" }
        )
        await transport.emit(Self.handshake)
        _ = try await client.start()

        async let result = client.request("health")
        await transport.waitForSentCount(1)
        let sentLine = await transport.sentLine(at: 0)
        XCTAssertEqual(
            sentLine,
            #"{"id":"req-health","method":"health","params":{},"protocolVersion":1}"# + "\n"
        )

        await transport.emit(
            #"{"protocolVersion":1,"id":"req-health","kind":"result","sequence":null,"result":{"healthy":true},"error":null,"event":null,"data":null}"#
        )
        let response = try await result
        XCTAssertEqual(
            response,
            .object(["healthy": .bool(true)])
        )
    }

    func testSurfacesStructuredEngineFailure() async throws {
        let transport = HQFakeEngineTransport()
        let client = HQEngineClient(
            transport: transport,
            makeRequestID: { "req-auth" }
        )
        await transport.emit(Self.handshake)
        _ = try await client.start()

        async let result = client.request("auth.state")
        await transport.waitForSentCount(1)
        await transport.emit(
            #"{"protocolVersion":1,"id":"req-auth","kind":"error","sequence":null,"result":null,"error":{"code":"AUTH_REQUIRED","message":"Sign in again","retryable":false},"event":null,"data":null}"#
        )

        do {
            _ = try await result
            XCTFail("Expected a structured engine failure")
        } catch {
            XCTAssertEqual(
                error as? HQEngineErrorPayload,
                HQEngineErrorPayload(
                    code: "AUTH_REQUIRED",
                    message: "Sign in again",
                    retryable: false
                )
            )
        }
    }

    func testPublishesEngineEvents() async throws {
        let transport = HQFakeEngineTransport()
        let client = HQEngineClient(
            transport: transport,
            makeRequestID: { "unused" }
        )
        await transport.emit(Self.handshake)
        _ = try await client.start()

        let eventTask = Task {
            var iterator = client.events.makeAsyncIterator()
            return await iterator.next()
        }
        await transport.emit(
            #"{"protocolVersion":1,"id":"sync-1","kind":"event","sequence":1,"result":null,"error":null,"event":"sync:progress","data":{"completed":3}}"#
        )

        let event = await eventTask.value
        XCTAssertEqual(
            event,
            HQEngineEvent(
                requestID: "sync-1",
                name: "sync:progress",
                sequence: 1,
                data: .object(["completed": .number(3)])
            )
        )
    }

    func testTransportFailureFailsPendingRequests() async throws {
        let transport = HQFakeEngineTransport()
        let client = HQEngineClient(
            transport: transport,
            makeRequestID: { "req-pending" }
        )
        await transport.emit(Self.handshake)
        _ = try await client.start()

        async let result = client.request("sync.status")
        await transport.waitForSentCount(1)
        await transport.fail(HQFakeTransportError.disconnected)

        do {
            _ = try await result
            XCTFail("Expected the pending request to fail")
        } catch {
            XCTAssertEqual(error as? HQFakeTransportError, .disconnected)
        }
    }

    func testRequestDeadlineFailsWithoutWaitingForTransportResponse() async throws {
        let transport = HQFakeEngineTransport()
        let client = HQEngineClient(
            transport: transport,
            makeRequestID: { "req-timeout" }
        )
        await transport.emit(Self.handshake)
        _ = try await client.start()

        do {
            _ = try await client.request(
                "sync.status",
                timeoutNanoseconds: 20_000_000
            )
            XCTFail("Expected the request deadline to expire")
        } catch {
            XCTAssertEqual(
                error as? HQEngineClientError,
                .requestTimedOut("sync.status")
            )
        }

        let sentCount = await transport.sentCount()
        XCTAssertEqual(sentCount, 1)
        await client.stop()
    }

    func testTransportFailureCannotReturnAStaleHandshakeOnRestart() async throws {
        let transport = HQFakeEngineTransport()
        let client = HQEngineClient(
            transport: transport,
            makeRequestID: { "req-failure" }
        )
        await transport.emit(Self.handshake)
        _ = try await client.start()

        let lifecycleTask = Task {
            var iterator = client.lifecycleEvents.makeAsyncIterator()
            return await iterator.next()
        }
        async let pending = client.request("sync.status")
        await transport.waitForSentCount(1)
        await transport.fail(HQFakeTransportError.disconnected)
        _ = try? await pending

        guard case .failed = await lifecycleTask.value else {
            return XCTFail(
                "Expected terminal transport failure to publish lifecycle failure"
            )
        }
        do {
            _ = try await client.start()
            XCTFail("Expected a terminal transport failure")
        } catch {
            XCTAssertEqual(
                error as? HQEngineClientError,
                .transportEnded
            )
        }
    }

    private static let handshake =
        #"{"protocolVersion":1,"id":null,"kind":"handshake","sequence":0,"result":{"applicationVersion":"0.10.21","capabilities":["health"],"engineVersion":"0.1.0"},"error":null,"event":null,"data":null}"#
}

private enum HQFakeTransportError: Error, Equatable {
    case disconnected
}

private actor HQFakeEngineTransport: HQEngineTransport {
    private let stream: AsyncThrowingStream<Data, Error>
    private let continuation: AsyncThrowingStream<Data, Error>.Continuation
    private var sent: [Data] = []
    private var sentWaiters: [
        (count: Int, continuation: CheckedContinuation<Void, Never>)
    ] = []
    private(set) var startCount = 0

    init() {
        var captured: AsyncThrowingStream<Data, Error>.Continuation?
        stream = AsyncThrowingStream { captured = $0 }
        continuation = captured!
    }

    func start() async throws -> AsyncThrowingStream<Data, Error> {
        startCount += 1
        return stream
    }

    func send(_ data: Data) async throws {
        sent.append(data)
        var remaining: [
            (count: Int, continuation: CheckedContinuation<Void, Never>)
        ] = []
        for waiter in sentWaiters {
            if sent.count >= waiter.count {
                waiter.continuation.resume()
            } else {
                remaining.append(waiter)
            }
        }
        sentWaiters = remaining
    }

    func stop() async {
        continuation.finish()
    }

    func emit(_ line: String) {
        continuation.yield(Data(line.utf8))
    }

    func fail(_ error: Error) {
        continuation.finish(throwing: error)
    }

    func waitForSentCount(_ count: Int) async {
        guard sent.count < count else { return }
        await withCheckedContinuation { continuation in
            sentWaiters.append((count, continuation))
        }
    }

    func sentLine(at index: Int) -> String? {
        guard sent.indices.contains(index) else { return nil }
        return String(data: sent[index], encoding: .utf8)
    }

    func sentCount() -> Int {
        sent.count
    }
}
