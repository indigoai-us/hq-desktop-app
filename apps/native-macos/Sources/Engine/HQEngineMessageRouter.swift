import Foundation

struct HQEngineEvent: Equatable, Sendable {
    let requestID: String?
    let name: String
    let sequence: UInt64
    let data: HQJSONValue?
}

enum HQEngineRoutedMessage: Equatable, Sendable {
    case handshake(HQJSONValue)
    case response(id: String, value: HQJSONValue)
    case failure(id: String?, error: HQEngineErrorPayload)
    case event(HQEngineEvent)
    case pong(id: String, value: HQJSONValue)
    case end(id: String, value: HQJSONValue)
}

enum HQEngineRoutingError: Error, Equatable, Sendable {
    case invalidHandshakeSequence(received: UInt64?)
    case invalidSequence(expected: UInt64, received: UInt64)
    case missingField(kind: HQEngineEnvelopeKind, field: String)
}

struct HQEngineMessageRouter: Sendable {
    private(set) var lastSequence: UInt64 = 0

    mutating func route(_ envelope: HQEngineEnvelope) throws -> HQEngineRoutedMessage {
        switch envelope.kind {
        case .handshake:
            guard envelope.sequence == 0 else {
                throw HQEngineRoutingError.invalidHandshakeSequence(
                    received: envelope.sequence
                )
            }
            let result = try required(
                envelope.result,
                field: "result",
                in: envelope.kind
            )
            lastSequence = 0
            return .handshake(result)

        case .result:
            return .response(
                id: try required(envelope.id, field: "id", in: envelope.kind),
                value: try required(
                    envelope.result,
                    field: "result",
                    in: envelope.kind
                )
            )

        case .error:
            return .failure(
                id: envelope.id,
                error: try required(
                    envelope.error,
                    field: "error",
                    in: envelope.kind
                )
            )

        case .event:
            let sequence = try required(
                envelope.sequence,
                field: "sequence",
                in: envelope.kind
            )
            let expected = lastSequence + 1
            guard sequence == expected else {
                throw HQEngineRoutingError.invalidSequence(
                    expected: expected,
                    received: sequence
                )
            }

            let event = HQEngineEvent(
                requestID: envelope.id,
                name: try required(
                    envelope.event,
                    field: "event",
                    in: envelope.kind
                ),
                sequence: sequence,
                data: envelope.data
            )
            lastSequence = sequence
            return .event(event)

        case .pong:
            return .pong(
                id: try required(envelope.id, field: "id", in: envelope.kind),
                value: try required(
                    envelope.result,
                    field: "result",
                    in: envelope.kind
                )
            )

        case .end:
            return .end(
                id: try required(envelope.id, field: "id", in: envelope.kind),
                value: try required(
                    envelope.result,
                    field: "result",
                    in: envelope.kind
                )
            )
        }
    }

    private func required<Value>(
        _ value: Value?,
        field: String,
        in kind: HQEngineEnvelopeKind
    ) throws -> Value {
        guard let value else {
            throw HQEngineRoutingError.missingField(kind: kind, field: field)
        }
        return value
    }
}
