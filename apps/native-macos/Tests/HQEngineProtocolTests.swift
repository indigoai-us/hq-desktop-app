import XCTest
@testable import HQNative

final class HQEngineProtocolTests: XCTestCase {
    func testEncodesCanonicalSingleLineRequest() throws {
        let request = HQEngineRequest(
            id: "req-7",
            method: "workspaces.list",
            params: .object(["includeCloud": .bool(true)])
        )

        let data = try HQEngineCodec.encode(request)
        let line = try XCTUnwrap(String(data: data, encoding: .utf8))

        XCTAssertEqual(
            line,
            #"{"id":"req-7","method":"workspaces.list","params":{"includeCloud":true},"protocolVersion":1}"# + "\n"
        )
        XCTAssertEqual(line.filter { $0 == "\n" }.count, 1)
    }

    func testDecodesHandshakeEnvelope() throws {
        let line = Data(
            #"{"protocolVersion":1,"id":null,"kind":"handshake","sequence":0,"result":{"applicationVersion":"0.10.21","capabilities":["health","workspaces.list"],"engineVersion":"0.1.0"},"error":null,"event":null,"data":null}"#.utf8
        )

        let envelope = try HQEngineCodec.decode(line)

        XCTAssertEqual(envelope.kind, .handshake)
        XCTAssertEqual(envelope.sequence, 0)
        XCTAssertEqual(
            envelope.result,
            .object([
                "applicationVersion": .string("0.10.21"),
                "capabilities": .array([.string("health"), .string("workspaces.list")]),
                "engineVersion": .string("0.1.0"),
            ])
        )
    }

    func testDecodesEventAndStructuredError() throws {
        let event = try HQEngineCodec.decode(
            Data(
                #"{"protocolVersion":1,"id":"sync-1","kind":"event","sequence":4,"result":null,"error":null,"event":"sync:progress","data":{"completed":3,"total":8}}"#.utf8
            )
        )
        XCTAssertEqual(event.kind, .event)
        XCTAssertEqual(event.event, "sync:progress")
        XCTAssertEqual(event.sequence, 4)

        let failure = try HQEngineCodec.decode(
            Data(
                #"{"protocolVersion":1,"id":"sync-1","kind":"error","sequence":5,"result":null,"error":{"code":"AUTH_REQUIRED","message":"Sign in again","retryable":false},"event":null,"data":null}"#.utf8
            )
        )
        XCTAssertEqual(
            failure.error,
            HQEngineErrorPayload(code: "AUTH_REQUIRED", message: "Sign in again", retryable: false)
        )
    }

    func testRejectsProtocolVersionMismatch() {
        let line = Data(
            #"{"protocolVersion":2,"id":null,"kind":"handshake","result":{},"error":null,"event":null,"data":null}"#.utf8
        )

        XCTAssertThrowsError(try HQEngineCodec.decode(line)) { error in
            XCTAssertEqual(
                error as? HQEngineCodec.CodecError,
                .invalidProtocolVersion(expected: 1, received: 2)
            )
        }
    }

    func testRejectsMultipleProtocolObjectsOnOneLine() {
        let line = Data(
            """
            {"protocolVersion":1,"id":"1","kind":"result","result":{}}
            {"protocolVersion":1,"id":"2","kind":"result","result":{}}
            """.utf8
        )

        XCTAssertThrowsError(try HQEngineCodec.decode(line)) { error in
            XCTAssertEqual(error as? HQEngineCodec.CodecError, .trailingData)
        }
    }
}

