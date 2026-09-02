import XCTest
@testable import HQNative

final class HQEngineMessageRouterTests: XCTestCase {
    func testRoutesHandshakeAndRequestResults() throws {
        var router = HQEngineMessageRouter()

        let handshake = try router.route(
            HQEngineEnvelope(
                protocolVersion: 1,
                id: nil,
                kind: .handshake,
                sequence: 0,
                result: .object(["engineVersion": .string("0.1.0")]),
                error: nil,
                event: nil,
                data: nil
            )
        )
        XCTAssertEqual(
            handshake,
            .handshake(.object(["engineVersion": .string("0.1.0")]))
        )

        let response = try router.route(
            HQEngineEnvelope(
                protocolVersion: 1,
                id: "req-1",
                kind: .result,
                sequence: nil,
                result: .object(["healthy": .bool(true)]),
                error: nil,
                event: nil,
                data: nil
            )
        )
        XCTAssertEqual(
            response,
            .response(id: "req-1", value: .object(["healthy": .bool(true)]))
        )
    }

    func testRoutesStructuredFailureWithoutDiscardingRetryability() throws {
        var router = HQEngineMessageRouter()
        let payload = HQEngineErrorPayload(
            code: "AUTH_REQUIRED",
            message: "Sign in again",
            retryable: false
        )

        let routed = try router.route(
            HQEngineEnvelope(
                protocolVersion: 1,
                id: "req-2",
                kind: .error,
                sequence: nil,
                result: nil,
                error: payload,
                event: nil,
                data: nil
            )
        )

        XCTAssertEqual(routed, .failure(id: "req-2", error: payload))
    }

    func testRoutesStrictlySequencedEvents() throws {
        var router = HQEngineMessageRouter()
        _ = try router.route(
            HQEngineEnvelope(
                protocolVersion: 1,
                id: nil,
                kind: .handshake,
                sequence: 0,
                result: .object([:]),
                error: nil,
                event: nil,
                data: nil
            )
        )

        let event = try router.route(
            HQEngineEnvelope(
                protocolVersion: 1,
                id: "sync-1",
                kind: .event,
                sequence: 1,
                result: nil,
                error: nil,
                event: "sync:progress",
                data: .object(["completed": .number(3)])
            )
        )

        XCTAssertEqual(
            event,
            .event(
                HQEngineEvent(
                    requestID: "sync-1",
                    name: "sync:progress",
                    sequence: 1,
                    data: .object(["completed": .number(3)])
                )
            )
        )
    }

    func testRejectsSequenceGapsAndMalformedEnvelopes() throws {
        var router = HQEngineMessageRouter()
        _ = try router.route(
            HQEngineEnvelope(
                protocolVersion: 1,
                id: nil,
                kind: .handshake,
                sequence: 0,
                result: .object([:]),
                error: nil,
                event: nil,
                data: nil
            )
        )

        XCTAssertThrowsError(
            try router.route(
                HQEngineEnvelope(
                    protocolVersion: 1,
                    id: nil,
                    kind: .event,
                    sequence: 2,
                    result: nil,
                    error: nil,
                    event: "sync:progress",
                    data: nil
                )
            )
        ) { error in
            XCTAssertEqual(
                error as? HQEngineRoutingError,
                .invalidSequence(expected: 1, received: 2)
            )
        }

        XCTAssertThrowsError(
            try router.route(
                HQEngineEnvelope(
                    protocolVersion: 1,
                    id: nil,
                    kind: .result,
                    sequence: nil,
                    result: .object([:]),
                    error: nil,
                    event: nil,
                    data: nil
                )
            )
        ) { error in
            XCTAssertEqual(
                error as? HQEngineRoutingError,
                .missingField(kind: .result, field: "id")
            )
        }
    }
}
