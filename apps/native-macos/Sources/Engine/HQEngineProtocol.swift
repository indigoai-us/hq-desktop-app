import Foundation

enum HQJSONValue: Codable, Equatable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([HQJSONValue])
    case object([String: HQJSONValue])

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([HQJSONValue].self) {
            self = .array(value)
        } else {
            self = .object(try container.decode([String: HQJSONValue].self))
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null:
            try container.encodeNil()
        case let .bool(value):
            try container.encode(value)
        case let .number(value):
            try container.encode(value)
        case let .string(value):
            try container.encode(value)
        case let .array(value):
            try container.encode(value)
        case let .object(value):
            try container.encode(value)
        }
    }
}

struct HQEngineRequest: Codable, Equatable, Sendable {
    let protocolVersion: Int
    let id: String
    let method: String
    let params: HQJSONValue

    init(
        protocolVersion: Int = HQEngineCodec.protocolVersion,
        id: String,
        method: String,
        params: HQJSONValue = .object([:])
    ) {
        self.protocolVersion = protocolVersion
        self.id = id
        self.method = method
        self.params = params
    }
}

enum HQEngineEnvelopeKind: String, Codable, Sendable {
    case handshake
    case result
    case error
    case event
    case pong
    case end
}

struct HQEngineErrorPayload: Codable, Equatable, Error, Sendable {
    let code: String
    let message: String
    let retryable: Bool
}

struct HQEngineEnvelope: Codable, Equatable, Sendable {
    let protocolVersion: Int
    let id: String?
    let kind: HQEngineEnvelopeKind
    let sequence: UInt64?
    let result: HQJSONValue?
    let error: HQEngineErrorPayload?
    let event: String?
    let data: HQJSONValue?
}

enum HQEngineCodec {
    static let protocolVersion = 1

    enum CodecError: LocalizedError, Equatable {
        case invalidProtocolVersion(expected: Int, received: Int)
        case trailingData

        var errorDescription: String? {
            switch self {
            case let .invalidProtocolVersion(expected, received):
                "Engine protocol mismatch: expected \(expected), received \(received)."
            case .trailingData:
                "Engine protocol line contained trailing data."
            }
        }
    }

    static func encode(_ request: HQEngineRequest) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]

        var data = try encoder.encode(request)
        data.append(0x0A)
        return data
    }

    static func decode(_ line: Data) throws -> HQEngineEnvelope {
        guard let source = String(data: line, encoding: .utf8) else {
            return try JSONDecoder().decode(HQEngineEnvelope.self, from: line)
        }

        let payloads = source
            .split(whereSeparator: \.isNewline)
            .map(String.init)
            .filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }

        guard payloads.count == 1 else {
            throw CodecError.trailingData
        }

        let envelope = try JSONDecoder().decode(
            HQEngineEnvelope.self,
            from: Data(payloads[0].utf8)
        )
        guard envelope.protocolVersion == protocolVersion else {
            throw CodecError.invalidProtocolVersion(
                expected: protocolVersion,
                received: envelope.protocolVersion
            )
        }

        return envelope
    }
}
