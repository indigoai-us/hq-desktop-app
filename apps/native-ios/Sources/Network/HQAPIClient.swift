import Foundation

struct HQAPIErrorEnvelope: Decodable, Equatable, Sendable {
    let statusCode: Int
    let code: String?
    let message: String?
    let requestID: String?

    init(from decoder: Decoder) throws {
        let value = try HQJSONValue(from: decoder)
        let fields = Self.fields(in: value)
        statusCode = 0
        code = fields.code
        message = fields.message
        requestID = fields.requestID
    }

    init(statusCode: Int, data: Data) {
        self.statusCode = statusCode
        if let decoded = try? HQDomainJSONDecoder().decode(HQAPIErrorEnvelope.self, from: data) {
            code = decoded.code
            message = decoded.message
            requestID = decoded.requestID
        } else {
            code = nil
            let raw = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
            message = raw.flatMap { $0.isEmpty ? nil : String($0.prefix(512)) }
            requestID = nil
        }
    }

    private static func fields(in value: HQJSONValue) -> (code: String?, message: String?, requestID: String?) {
        switch value {
        case let .string(message):
            return (nil, message, nil)
        case let .object(object):
            let nested = object["error"]
            let nestedObject = nested?.objectValue
            let nestedMessage = nested?.stringValue ?? nestedObject?["message"]?.stringValue
            return (
                object["code"]?.stringValue ?? nestedObject?["code"]?.stringValue,
                object["message"]?.stringValue ?? nestedMessage,
                object["requestId"]?.stringValue ?? nestedObject?["requestId"]?.stringValue
            )
        default:
            return (nil, nil, nil)
        }
    }
}

private extension HQJSONValue {
    var stringValue: String? {
        guard case let .string(value) = self else { return nil }
        return value
    }

    var objectValue: [String: HQJSONValue]? {
        guard case let .object(value) = self else { return nil }
        return value
    }
}

enum HQAPIClientError: Error, Equatable, LocalizedError {
    case server(HQAPIErrorEnvelope)
    case invalidContract(String)

    var errorDescription: String? {
        switch self {
        case let .server(error): error.message ?? "HQ could not complete this request (HTTP \(error.statusCode))."
        case let .invalidContract(id): "HQ does not recognize the \(id) route contract."
        }
    }
}

enum HQRouteDegradedState: Equatable, Sendable {
    case partialResponse(contractID: String)
    case unknownEnum(contractID: String, value: String)
}

enum HQRouteUnavailableState: Equatable, Sendable {
    case unverifiedResponseSchema(contractID: String)
}

enum HQRouteResult<Value: Sendable>: Sendable {
    case content(Value)
    case degraded(HQRouteDegradedState)
    case unavailable(HQRouteUnavailableState)
}

extension HQRouteResult: Equatable where Value: Equatable {}

protocol HQUnknownEnumReporting {
    var unknownServerValue: String? { get }
}

extension HQWorkState: HQUnknownEnumReporting {
    var unknownServerValue: String? { if case let .unknown(value) = self { value } else { nil } }
}
extension HQOwnershipProvenance: HQUnknownEnumReporting {
    var unknownServerValue: String? { if case let .unknown(value) = self { value } else { nil } }
}
extension HQConnectionState: HQUnknownEnumReporting {
    var unknownServerValue: String? { if case let .unknown(value) = self { value } else { nil } }
}
extension HQCapabilityDisposition: HQUnknownEnumReporting {
    var unknownServerValue: String? { if case let .unknown(value) = self { value } else { nil } }
}
extension HQProjectStatus: HQUnknownEnumReporting {
    var unknownServerValue: String? { if case let .unknown(value) = self { value } else { nil } }
}
extension HQMeetingState: HQUnknownEnumReporting {
    var unknownServerValue: String? { if case let .unknown(value) = self { value } else { nil } }
}
extension HQMarketplaceListingStatus: HQUnknownEnumReporting {
    var unknownServerValue: String? { if case let .unknown(value) = self { value } else { nil } }
}
extension HQDeploymentStatus: HQUnknownEnumReporting {
    var unknownServerValue: String? { if case let .unknown(value) = self { value } else { nil } }
}
extension HQMembershipRole: HQUnknownEnumReporting {
    var unknownServerValue: String? { if case let .unknown(value) = self { value } else { nil } }
}
extension HQMembershipStatus: HQUnknownEnumReporting {
    var unknownServerValue: String? { if case let .unknown(value) = self { value } else { nil } }
}

struct HQRealtimeCredentialsRequest: Encodable, Sendable {
    let contractVersion = 2
}

private struct HQRealtimeCodingKey: CodingKey, Hashable {
    let stringValue: String
    let intValue: Int?

    init?(stringValue: String) {
        self.stringValue = stringValue
        intValue = nil
    }

    init?(intValue: Int) {
        stringValue = String(intValue)
        self.intValue = intValue
    }
}

private enum HQRealtimeContractValidation {
    static let maximumCredentialResponseBytes = 64 * 1_024

    private struct JSONContainerFrame {
        enum Kind {
            case object
            case array
        }

        let kind: Kind
        var seenKeys: Set<String> = []
        var expectingKey: Bool
    }

    static func requiresExactKeys(_ expected: Set<String>, from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: HQRealtimeCodingKey.self)
        let actual = Set(container.allKeys.map(\.stringValue))
        guard actual == expected else {
            throw DecodingError.dataCorrupted(.init(
                codingPath: decoder.codingPath,
                debugDescription: "Realtime contract keys do not match the deployed v2 envelope"
            ))
        }
    }

    /// Foundation and the deployed JavaScript boundary do not agree on which
    /// duplicate member wins. Reject duplicates in every object before decoding
    /// so an ambiguous credential can never acquire platform-dependent meaning.
    static func hasDuplicateObjectKeys(in data: Data) -> Bool {
        guard let serialized = String(data: data, encoding: .utf8) else { return true }
        var frames: [JSONContainerFrame] = []
        var inString = false
        var escaped = false
        var stringStart: String.Index?
        var index = serialized.startIndex

        while index < serialized.endIndex {
            let character = serialized[index]
            if inString {
                if escaped {
                    escaped = false
                } else if character == "\\" {
                    escaped = true
                } else if character == "\"" {
                    inString = false
                    if let frameIndex = frames.indices.last,
                       frames[frameIndex].kind == .object,
                       frames[frameIndex].expectingKey,
                       let stringStart {
                        let end = serialized.index(after: index)
                        let token = Data(serialized[stringStart ..< end].utf8)
                        guard let key = try? JSONDecoder().decode(String.self, from: token) else {
                            return true
                        }
                        guard frames[frameIndex].seenKeys.insert(key).inserted else { return true }
                        frames[frameIndex].expectingKey = false
                    }
                }
            } else if character == "\"" {
                inString = true
                stringStart = index
            } else if character == "{" {
                frames.append(JSONContainerFrame(kind: .object, expectingKey: true))
            } else if character == "[" {
                frames.append(JSONContainerFrame(kind: .array, expectingKey: false))
            } else if character == "}" {
                guard frames.last?.kind == .object else { return true }
                frames.removeLast()
            } else if character == "]" {
                guard frames.last?.kind == .array else { return true }
                frames.removeLast()
            } else if character == ",", let frameIndex = frames.indices.last,
                      frames[frameIndex].kind == .object {
                frames[frameIndex].expectingKey = true
            }
            index = serialized.index(after: index)
        }
        return inString || !frames.isEmpty
    }

    static func isPrintableASCII(_ value: String, maximum: Int) -> Bool {
        !value.isEmpty && value.utf8.count <= maximum && value.utf8.allSatisfy { byte in
            byte >= 0x21 && byte <= 0x7e
        }
    }

    static func isAccessKeyID(_ value: String) -> Bool {
        matches(value, pattern: "^(?:AKIA|ASIA)[A-Z0-9]{16}$")
    }

    static func strictUTCDate(_ value: String) -> Date? {
        guard value.utf8.count <= 35,
              matches(value, pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,9})?Z$")
        else { return nil }

        let formatter = ISO8601DateFormatter()
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.formatOptions = value.contains(".")
            ? [.withInternetDateTime, .withFractionalSeconds]
            : [.withInternetDateTime]
        return formatter.date(from: value)
    }

    static func matches(_ value: String, pattern: String) -> Bool {
        value.range(of: pattern, options: .regularExpression) == (value.startIndex ..< value.endIndex)
    }

    static func principal(fromDMTopic topic: String) -> String? {
        let components = topic.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        guard components.count == 3, components[0] == "hq", components[2] == "dm",
              matches(components[1], pattern: "^(?:prs|agt)_[0-9A-HJKMNP-TV-Z]{26}$")
        else { return nil }
        return components[1]
    }

    static func isRegion(_ region: String) -> Bool {
        region.utf8.count <= 32 && matches(region, pattern: "^[a-z0-9]+(?:-[a-z0-9]+){1,4}$")
    }

    static func isDataATSEndpoint(_ endpoint: String, region: String) -> Bool {
        guard endpoint.utf8.count <= 253, endpoint == endpoint.lowercased(),
              !endpoint.contains("://"), !endpoint.contains("/"), !endpoint.contains(":"),
              !endpoint.contains("?"), !endpoint.contains("#"), !endpoint.contains("@")
        else { return false }
        let labels = endpoint.split(separator: ".", omittingEmptySubsequences: false)
        guard labels.count >= 3,
              labels.allSatisfy({ !$0.isEmpty && $0.utf8.count <= 63 }),
              labels.last.map({ matches(String($0), pattern: "^[a-z]{2,63}$") }) == true
        else { return false }
        let escapedRegion = NSRegularExpression.escapedPattern(for: region)
        return matches(
            endpoint,
            pattern: "^[a-z0-9][a-z0-9-]{0,62}-ats\\.iot\\.\(escapedRegion)\\.amazonaws\\.com(?:\\.cn)?$"
        )
    }

    static func isV2ClientID(_ clientID: String) -> Bool {
        matches(clientID, pattern: "^rt2-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
    }
}

struct HQRealtimeCredentials: Decodable, Sendable {
    struct TemporaryCredentials: Decodable, Sendable {
        let accessKeyID: String
        let secretAccessKey: String
        let sessionToken: String
        let expiration: Date
        let expirationWire: String

        enum CodingKeys: String, CodingKey {
            case accessKeyID = "accessKeyId"
            case secretAccessKey
            case sessionToken
            case expiration
        }

        init(from decoder: Decoder) throws {
            try HQRealtimeContractValidation.requiresExactKeys(
                ["accessKeyId", "secretAccessKey", "sessionToken", "expiration"],
                from: decoder
            )
            let values = try decoder.container(keyedBy: CodingKeys.self)
            accessKeyID = try values.decode(String.self, forKey: .accessKeyID)
            secretAccessKey = try values.decode(String.self, forKey: .secretAccessKey)
            sessionToken = try values.decode(String.self, forKey: .sessionToken)
            let expirationValue = try values.decode(String.self, forKey: .expiration)
            guard let decodedExpiration = HQRealtimeContractValidation.strictUTCDate(expirationValue),
                  HQRealtimeContractValidation.isAccessKeyID(accessKeyID),
                  HQRealtimeContractValidation.isPrintableASCII(secretAccessKey, maximum: 256),
                  HQRealtimeContractValidation.isPrintableASCII(sessionToken, maximum: 4_096),
                  decodedExpiration.timeIntervalSinceReferenceDate.isFinite
            else {
                throw DecodingError.dataCorruptedError(
                    forKey: .expiration, in: values,
                    debugDescription: "Realtime temporary credentials are invalid"
                )
            }
            expiration = decodedExpiration
            expirationWire = expirationValue
        }
    }

    struct Topics: Decodable, Equatable, Sendable {
        let dm: String
        let sessions: String
        let work: String
        let notifications: String

        var all: [String] { [dm, sessions, work, notifications] }

        enum CodingKeys: String, CodingKey { case dm, sessions, work, notifications }

        init(from decoder: Decoder) throws {
            try HQRealtimeContractValidation.requiresExactKeys(
                ["dm", "sessions", "work", "notifications"],
                from: decoder
            )
            let values = try decoder.container(keyedBy: CodingKeys.self)
            dm = try values.decode(String.self, forKey: .dm)
            sessions = try values.decode(String.self, forKey: .sessions)
            work = try values.decode(String.self, forKey: .work)
            notifications = try values.decode(String.self, forKey: .notifications)
        }
    }

    let contractVersion: Int
    let credentials: TemporaryCredentials
    let iotEndpoint: String
    let region: String
    let clientID: String
    /// The caller-scoped topic root returned by the deployed v2 contract.
    /// It is retained as a boundary check; subscriptions always use `topics`.
    let topic: String
    let topics: Topics
    let expiresAt: Date

    enum CodingKeys: String, CodingKey {
        case contractVersion
        case credentials
        case iotEndpoint
        case region
        case clientID = "clientId"
        case topic
        case topics
        case expiresAt
    }

    init(from decoder: Decoder) throws {
        try HQRealtimeContractValidation.requiresExactKeys(
            ["contractVersion", "credentials", "iotEndpoint", "region", "clientId", "topic", "topics", "expiresAt"],
            from: decoder
        )
        let values = try decoder.container(keyedBy: CodingKeys.self)
        contractVersion = try values.decode(Int.self, forKey: .contractVersion)
        credentials = try values.decode(TemporaryCredentials.self, forKey: .credentials)
        iotEndpoint = try values.decode(String.self, forKey: .iotEndpoint)
        region = try values.decode(String.self, forKey: .region)
        clientID = try values.decode(String.self, forKey: .clientID)
        topic = try values.decode(String.self, forKey: .topic)
        topics = try values.decode(Topics.self, forKey: .topics)
        let expiresAtValue = try values.decode(String.self, forKey: .expiresAt)
        guard let decodedExpiresAt = HQRealtimeContractValidation.strictUTCDate(expiresAtValue) else {
            throw DecodingError.dataCorruptedError(
                forKey: .expiresAt, in: values,
                debugDescription: "Realtime expiration is invalid"
            )
        }
        expiresAt = decodedExpiresAt
        let validationNow = decoder.userInfo[.hqRealtimeValidationNow] as? Date ?? .now
        let remainingLifetime = expiresAt.timeIntervalSince(validationNow)
        guard let principal = HQRealtimeContractValidation.principal(fromDMTopic: topics.dm),
              contractVersion == 2,
              topic == topics.dm,
              topics.sessions == "hq/\(principal)/sessions",
              topics.work == "hq/\(principal)/work",
              topics.notifications == "hq/\(principal)/notifications",
              HQRealtimeContractValidation.isRegion(region),
              HQRealtimeContractValidation.isDataATSEndpoint(iotEndpoint, region: region),
              HQRealtimeContractValidation.isV2ClientID(clientID),
              credentials.expirationWire == expiresAtValue,
              credentials.expiration == expiresAt,
              remainingLifetime > 0,
              expiresAt.timeIntervalSinceReferenceDate.isFinite,
              [credentials.accessKeyID, credentials.secretAccessKey, credentials.sessionToken,
               iotEndpoint, region, clientID, topic].allSatisfy({ !$0.isEmpty })
        else {
            throw DecodingError.dataCorruptedError(forKey: .topics, in: values,
                                                   debugDescription: "Unsupported realtime v2 envelope")
        }
    }
}

struct HQEmptyResponse: Equatable, Sendable {}

struct HQWindow<Item: Codable & Hashable & Sendable>: Codable, Hashable, Sendable {
    let items: [Item]
    let nextCursor: String?
    let windowStart: String?
}

struct HQEndpoint<Value: Sendable>: Sendable {
    let id: String
    let method: HQHTTPMethod
    let url: URL
    let requestClass: HQNetworkDiagnostic.RequestClass
    let replayClass: HQRequestReplayClass
    let decode: @Sendable (_ statusCode: Int, _ data: Data) -> HQRouteResult<Value>
}

enum HQEndpointFactory {
    static func bare<Value: Decodable & Sendable>(descriptor: HQRouteContractDescriptor, url: URL,
                                                   requestClass: HQNetworkDiagnostic.RequestClass,
                                                   as type: Value.Type) -> HQEndpoint<Value> {
        endpoint(descriptor: descriptor, url: url, requestClass: requestClass) { data in
            if descriptor.id == "realtime-credentials" {
                guard data.count <= HQRealtimeContractValidation.maximumCredentialResponseBytes,
                      !HQRealtimeContractValidation.hasDuplicateObjectKeys(in: data)
                else { throw ShapeError.invalid }
            }
            return try domainDecoder().decode(type, from: data)
        }
    }

    static func envelope<Value: Decodable & Sendable>(descriptor: HQRouteContractDescriptor, url: URL,
                                                       requestClass: HQNetworkDiagnostic.RequestClass,
                                                       key: String, as type: Value.Type) -> HQEndpoint<Value> {
        endpoint(descriptor: descriptor, url: url, requestClass: requestClass) { data in
            let object = try object(from: data)
            guard let payload = object[key] else { throw ShapeError.invalid }
            return try decode(type, from: payload)
        }
    }

    static func page<Item: Codable & Hashable & Sendable>(descriptor: HQRouteContractDescriptor, url: URL,
                                                           requestClass: HQNetworkDiagnostic.RequestClass,
                                                           itemsKey: String, item: Item.Type) -> HQEndpoint<HQPage<Item>> {
        endpoint(descriptor: descriptor, url: url, requestClass: requestClass) { data in
            let object = try object(from: data)
            guard let rawItems = object[itemsKey] else { throw ShapeError.invalid }
            let items = try decode([Item].self, from: rawItems)
            let cursor = try optionalString(object["nextCursor"])
            let explicitHasMore = try optionalBool(object["hasMore"])
            let excluded = Set([itemsKey, "nextCursor", "hasMore"])
            return try HQPage(items: items, nextCursor: cursor, hasMore: explicitHasMore,
                              extensions: object.filter { !excluded.contains($0.key) })
        }
    }

    static func window<Item: Codable & Hashable & Sendable>(descriptor: HQRouteContractDescriptor, url: URL,
                                                             requestClass: HQNetworkDiagnostic.RequestClass,
                                                             itemsKey: String, item: Item.Type) -> HQEndpoint<HQWindow<Item>> {
        endpoint(descriptor: descriptor, url: url, requestClass: requestClass) { data in
            let object = try object(from: data)
            guard let rawItems = object[itemsKey] else { throw ShapeError.invalid }
            let items = try decode([Item].self, from: rawItems)
            return HQWindow(items: items,
                            nextCursor: try optionalString(object["nextCursor"]),
                            windowStart: try optionalString(object["since"]))
        }
    }

    static func empty(descriptor: HQRouteContractDescriptor, url: URL,
                      requestClass: HQNetworkDiagnostic.RequestClass) -> HQEndpoint<HQEmptyResponse> {
        HQEndpoint(id: descriptor.id, method: descriptor.method, url: url,
                   requestClass: requestClass, replayClass: descriptor.replayClass) { statusCode, data in
            let isEmpty = data.allSatisfy { byte in
                byte == 0x20 || byte == 0x09 || byte == 0x0A || byte == 0x0D
            }
            guard statusCode == 204 || isEmpty else {
                return .degraded(.partialResponse(contractID: descriptor.id))
            }
            return .content(HQEmptyResponse())
        }
    }

    private static func endpoint<Value: Decodable & Sendable>(descriptor: HQRouteContractDescriptor, url: URL,
                                                               requestClass: HQNetworkDiagnostic.RequestClass,
                                                               decodeValue: @escaping @Sendable (Data) throws -> Value) -> HQEndpoint<Value> {
        HQEndpoint(id: descriptor.id, method: descriptor.method, url: url,
                   requestClass: requestClass, replayClass: descriptor.replayClass) { _, data in
            do {
                let value = try decodeValue(data)
                if let unknown = firstUnknownValue(in: value) {
                    return .degraded(.unknownEnum(contractID: descriptor.id, value: unknown))
                }
                return .content(value)
            } catch {
                return .degraded(.partialResponse(contractID: descriptor.id))
            }
        }
    }

    private enum ShapeError: Error { case invalid }

    private static func object(from data: Data) throws -> [String: HQJSONValue] {
        let value = try domainDecoder().decode(HQJSONValue.self, from: data)
        guard case let .object(object) = value else { throw ShapeError.invalid }
        return object
    }

    private static func decode<Value: Decodable>(_ type: Value.Type, from value: HQJSONValue) throws -> Value {
        try domainDecoder().decode(type, from: JSONEncoder().encode(value))
    }

    private static func domainDecoder() -> HQDomainJSONDecoder {
        var decoder = HQDomainJSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }

    private static func firstUnknownValue(in value: Any, depth: Int = 0) -> String? {
        guard depth < 16 else { return nil }
        if let reporting = value as? any HQUnknownEnumReporting,
           let unknown = reporting.unknownServerValue {
            return unknown
        }
        for child in Mirror(reflecting: value).children {
            if let unknown = firstUnknownValue(in: child.value, depth: depth + 1) { return unknown }
        }
        return nil
    }

    private static func optionalString(_ value: HQJSONValue?) throws -> String? {
        guard let value else { return nil }
        if case .null = value { return nil }
        guard case let .string(string) = value, !string.isEmpty else { throw ShapeError.invalid }
        return string
    }

    private static func optionalBool(_ value: HQJSONValue?) throws -> Bool? {
        guard let value else { return nil }
        if case .null = value { return nil }
        guard case let .bool(flag) = value else { throw ShapeError.invalid }
        return flag
    }
}

enum HQPaginationContract: Equatable, Sendable {
    case none
    case opaqueCursor
    case window
}

enum HQResponseContract: Equatable, Sendable {
    case verifiedBare
    case unverified
}

struct HQRouteContractDescriptor: Sendable {
    let id: String
    let method: HQHTTPMethod
    let pathTemplate: String
    let pagination: HQPaginationContract
    let replayClass: HQRequestReplayClass
    let responseContract: HQResponseContract

    var diagnosticClass: HQNetworkDiagnostic.RequestClass {
        switch id {
        case "mobile-config": .bootstrap
        case "membership-me": .membership
        case "realtime-credentials": .realtime
        default:
            switch replayClass {
            case .safeRead: .routeRead
            case .provenIdempotentMutation: .idempotentMutation
            case .unsafeMutation: .unsafeMutation
            }
        }
    }

    private static let dynamicSegmentAllowedCharacters: CharacterSet = {
        var allowed = CharacterSet.urlPathAllowed
        allowed.remove(charactersIn: "/?#%\\")
        allowed.subtract(.controlCharacters)
        return allowed
    }()

    /// Returns the one canonical path-segment representation accepted by the
    /// credential-bearing transport boundary. Keeping this encoder shared with
    /// `matches` prevents directly constructed requests from using an encoded
    /// delimiter, traversal token, control byte, or double encoding that the
    /// typed client itself could never produce.
    static func canonicalDynamicSegment(_ value: String) -> String? {
        guard !value.isEmpty,
              value != ".", value != "..",
              !value.unicodeScalars.contains(where: {
                  CharacterSet(charactersIn: "/?#%\\").contains($0)
                      || CharacterSet.controlCharacters.contains($0)
              })
        else { return nil }
        return value.addingPercentEncoding(withAllowedCharacters: dynamicSegmentAllowedCharacters)
    }

    func matches(_ url: URL) -> Bool {
        guard let path = URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedPath else {
            return false
        }
        let templateSegments = pathTemplate.split(separator: "/", omittingEmptySubsequences: false)
        let actualSegments = path.split(separator: "/", omittingEmptySubsequences: false)
        guard templateSegments.count == actualSegments.count else { return false }
        return zip(templateSegments, actualSegments).allSatisfy { template, actual in
            if template.hasPrefix("{"), template.hasSuffix("}") {
                let encoded = String(actual)
                guard let decoded = encoded.removingPercentEncoding else { return false }
                return Self.canonicalDynamicSegment(decoded) == encoded
            }
            return template == actual
        }
    }
}

enum HQRouteContractMatrix {
    private static func contract(_ id: String, _ method: HQHTTPMethod, _ path: String,
                                 pagination: HQPaginationContract = .none,
                                 replayClass: HQRequestReplayClass? = nil,
                                 responseContract: HQResponseContract = .unverified) -> HQRouteContractDescriptor {
        HQRouteContractDescriptor(
            id: id,
            method: method,
            pathTemplate: path,
            pagination: pagination,
            replayClass: replayClass ?? (method == .get ? .safeRead : .unsafeMutation),
            responseContract: responseContract
        )
    }

    /// Authenticated HQ API routes only. Cognito token and revoke contracts are
    /// owned by `HQOAuthClient` and deliberately cannot receive an HQ ID-token
    /// Authorization header through this matrix.
    static let definitions: [String: HQRouteContractDescriptor] = Dictionary(uniqueKeysWithValues: [
        contract("mobile-config", .get, "/v1/mobile/config", responseContract: .verifiedBare),
        contract("membership-me", .get, "/membership/me", responseContract: .verifiedBare),
        contract("notifications", .get, "/v1/notify/notifications", pagination: .opaqueCursor),
        contract("notification-ack", .post, "/v1/notify/notifications/ack"),
        contract("notifications-read-all", .post, "/v1/notify/notifications/read-all"),
        contract("notification-action", .post, "/v1/notify/notifications/{id}/actions/{action}"),
        contract("dm-inbox", .get, "/v1/notify/inbox"),
        contract("dm-inbox-ack", .post, "/v1/notify/inbox/ack"),
        contract("dm-threads", .get, "/v1/notify/dm-threads", pagination: .opaqueCursor),
        contract("dm-thread", .get, "/v1/notify/thread", pagination: .window),
        contract("dm-send", .post, "/v1/notify/dm"),
        contract("dm-thread-read", .post, "/v1/notify/thread/read"),
        contract("reply-threads", .get, "/v1/notify/threads"),
        contract("dm-reply", .post, "/v1/notify/dm"),
        contract("channel-directory", .get, "/v1/notify/channels", pagination: .opaqueCursor),
        contract("channel-create", .post, "/v1/notify/channels"),
        contract("channel-messages", .get, "/v1/notify/channels/{channelId}/messages", pagination: .window),
        contract("channel-send", .post, "/v1/notify/channels/{channelId}/messages"),
        contract("channel-reply", .post, "/v1/notify/channels/{channelId}/messages"),
        contract("channel-members", .get, "/v1/notify/channels/{channelId}/members"),
        contract("channel-member-add", .post, "/v1/notify/channels/{channelId}/members"),
        contract("channel-member-remove", .delete, "/v1/notify/channels/{channelId}/members/{personUid}"),
        contract("channel-delete", .delete, "/v1/notify/channels/{channelId}"),
        contract("channel-read", .post, "/v1/notify/channels/{channelId}/read"),
        contract("contacts", .get, "/v1/notify/contacts"),
        contract("dm-requests", .get, "/v1/notify/connections/requests"),
        contract("message-search", .get, "/v1/notify/search"),
        contract("reactions-fetch", .get, "/v1/notify/reactions"),
        contract("reaction-add", .post, "/v1/notify/reactions"),
        contract("reaction-remove", .delete, "/v1/notify/reactions"),
        contract("shared-with-me", .get, "/v1/files/shared-with-me"),
        contract("shared-with-me-ack", .post, "/v1/files/shared-with-me/ack"),
        contract("calendar-events", .get, "/v1/calendar/events"),
        contract("bot-list", .get, "/v1/bot/list"),
        contract("bot-invite", .post, "/v1/bot/invite"),
        contract("bot-cancel", .post, "/v1/bot/{botId}/cancel"),
        contract("listings", .get, "/v1/listings"),
        contract("listing-detail", .get, "/v1/listings/{listingId}"),
        contract("listing-install", .post, "/v1/listings/{listingId}/installs"),
        contract("moderation-queue", .get, "/v1/moderation/queue"),
        contract("moderation-decision", .post, "/v1/moderation/listings/{listingId}"),
        contract("moderation-yank", .post, "/v1/moderation/listings/{listingId}/yank"),
        contract("skills-shelf", .get, "/v1/skills/{companyUid}/shelf"),
        contract("skills-me", .get, "/v1/skills/{companyUid}/me"),
        contract("agent-mobile-roster", .get, "/v1/agents/mobile-roster"),
        contract("profile", .get, "/v1/profile"),
        contract("profile-update", .put, "/v1/profile"),
        contract("files-list", .get, "/v1/files/list"),
        contract("files-presign", .post, "/v1/files/presign"),
        contract("company-members", .get, "/v1/companies/{slug}/members"),
        contract("company-activity", .get, "/v1/companies/{slug}/activity"),
        contract("company-deployments", .get, "/v1/companies/{slug}/deployments"),
        contract("company-secrets", .get, "/v1/companies/{slug}/secrets"),
        contract("company-board", .get, "/v1/companies/{slug}/board"),
        contract("work-mesh-project", .get, "/v1/work-mesh/projects/{id}"),
        // Vending a scoped credential is semantically idempotent. The route
        // matrix is the sole authority permitting the one auth refresh/replay.
        contract("realtime-credentials", .post, "/v1/realtime/credentials",
                 replayClass: .provenIdempotentMutation, responseContract: .verifiedBare),
        contract("push-device-register", .post, "/v1/realtime/devices"),
        contract("push-device-remove", .delete, "/v1/realtime/devices/{deviceId}")
    ].map { ($0.id, $0) })

    static var identifiers: Set<String> { Set(definitions.keys) }
    static func descriptor(for id: String) -> HQRouteContractDescriptor? { definitions[id] }
}

@MainActor
final class HQAPIClient {
    static let productionBaseURL = HQHTTPSOrigin.production.baseURL

    private let baseURL: URL
    private let session: HQSessionController
    private let transport: any HQHTTPSending

    init(baseURL: URL = HQAPIClient.productionBaseURL,
         session: HQSessionController,
         transport: (any HQHTTPSending)? = nil) throws {
        let origin = try HQHTTPSOrigin(validatingBaseURL: baseURL)
        self.baseURL = origin.baseURL
        self.session = session
        self.transport = transport ?? HQHTTPTransport(allowedOrigin: origin)
    }

    func mobileConfiguration() async throws -> HQRouteResult<HQMobileConfiguration> {
        try await execute(try verifiedBareEndpoint("mobile-config", as: HQMobileConfiguration.self,
                                                  requestClass: .bootstrap))
    }

    func membership() async throws -> HQRouteResult<HQMembershipResponse> {
        try await execute(try verifiedBareEndpoint("membership-me", as: HQMembershipResponse.self,
                                                  requestClass: .membership))
    }

    func realtimeCredentials() async throws -> HQRouteResult<HQRealtimeCredentials> {
        try await execute(try verifiedBareEndpoint("realtime-credentials", as: HQRealtimeCredentials.self,
                                                  requestClass: .realtime),
                          bodyData: try JSONEncoder().encode(HQRealtimeCredentialsRequest()))
    }

    func realtimeCredentialsValue() async throws -> HQRealtimeCredentials {
        switch try await realtimeCredentials() {
        case let .content(value): value
        case .degraded, .unavailable:
            throw HQAPIClientError.invalidContract("realtime-credentials")
        }
    }

    /// The first native vertical slice has two response schemas with captured,
    /// redacted contract evidence.  Realtime intentionally hydrates only these
    /// authoritative REST values until downstream route schemas are proven.
    func reconcileAuthoritativeState() async throws {
        async let configuration = mobileConfiguration()
        async let currentMembership = membership()
        guard case .content = try await configuration,
              case .content = try await currentMembership
        else { throw HQAPIClientError.invalidContract("authoritative-reconciliation") }
    }

    /// Until a contract-specific DTO/normalizer is backed by redacted real
    /// evidence, the route is explicitly unavailable rather than accepting an
    /// arbitrary JSON object (including `{}`) as usable content.
    func routeValue(contractID: String, pathArguments: [String: String] = [:],
                    query: [URLQueryItem] = []) async throws -> HQRouteResult<HQJSONValue> {
        try unavailableRoute(contractID: contractID, pathArguments: pathArguments, query: query)
    }

    func routeValue<Body: Encodable>(contractID: String, pathArguments: [String: String] = [:],
                                      query: [URLQueryItem] = [], body: Body) async throws -> HQRouteResult<HQJSONValue> {
        _ = try JSONEncoder().encode(body)
        return try unavailableRoute(contractID: contractID, pathArguments: pathArguments, query: query)
    }

    func routePage<Item: Codable & Hashable & Sendable>(contractID: String,
                                                         pathArguments: [String: String] = [:],
                                                         query: [URLQueryItem] = [],
                                                         item: Item.Type) async throws -> HQRouteResult<HQPage<Item>> {
        guard let descriptor = HQRouteContractMatrix.descriptor(for: contractID),
              descriptor.pagination == .opaqueCursor
        else { throw HQAPIClientError.invalidContract(contractID) }
        _ = try resolvedURL(descriptor, pathArguments: pathArguments, query: query)
        return .unavailable(.unverifiedResponseSchema(contractID: contractID))
    }

    func routeWindow<Item: Codable & Hashable & Sendable>(contractID: String,
                                                           pathArguments: [String: String] = [:],
                                                           query: [URLQueryItem] = [],
                                                           item: Item.Type) async throws -> HQRouteResult<HQWindow<Item>> {
        guard let descriptor = HQRouteContractMatrix.descriptor(for: contractID),
              descriptor.pagination == .window
        else { throw HQAPIClientError.invalidContract(contractID) }
        _ = try resolvedURL(descriptor, pathArguments: pathArguments, query: query)
        return .unavailable(.unverifiedResponseSchema(contractID: contractID))
    }

    private func execute<Value: Sendable>(_ endpoint: HQEndpoint<Value>,
                                          bodyData: Data? = nil) async throws -> HQRouteResult<Value> {
        let request = HQHTTPRequest(contractID: endpoint.id, url: endpoint.url, method: endpoint.method,
                                    body: bodyData, requestClass: endpoint.requestClass)
        return try await session.performAuthorized(replayPolicy: endpoint.replayClass.authorizationReplayPolicy) { credentials in
            let response = try await self.transport.send(request, credentials: credentials)
            try Task.checkCancellation()
            if response.statusCode == 401 {
                return HQAuthorizedResponse(statusCode: 401, value: nil)
            }
            guard (200 ... 299).contains(response.statusCode) else {
                throw HQAPIClientError.server(HQAPIErrorEnvelope(statusCode: response.statusCode, data: response.data))
            }
            let result = endpoint.decode(response.statusCode, response.data)
            try Task.checkCancellation()
            return HQAuthorizedResponse(statusCode: response.statusCode, value: result)
        }
    }

    private func verifiedBareEndpoint<Value: Decodable & Sendable>(_ contractID: String, as type: Value.Type,
                                                                    requestClass: HQNetworkDiagnostic.RequestClass) throws -> HQEndpoint<Value> {
        guard let descriptor = HQRouteContractMatrix.descriptor(for: contractID),
              descriptor.responseContract == .verifiedBare
        else { throw HQAPIClientError.invalidContract(contractID) }
        let url = try resolvedURL(descriptor, pathArguments: [:], query: [])
        return HQEndpointFactory.bare(descriptor: descriptor, url: url, requestClass: requestClass, as: type)
    }

    private func unavailableRoute<Value: Sendable>(contractID: String,
                                                    pathArguments: [String: String],
                                                    query: [URLQueryItem]) throws -> HQRouteResult<Value> {
        guard let descriptor = HQRouteContractMatrix.descriptor(for: contractID),
              descriptor.responseContract == .unverified
        else { throw HQAPIClientError.invalidContract(contractID) }
        _ = try resolvedURL(descriptor, pathArguments: pathArguments, query: query)
        return .unavailable(.unverifiedResponseSchema(contractID: contractID))
    }

    /// Internal so contract tests and future typed route adapters exercise the
    /// exact same segment encoder rather than reimplementing URL construction.
    func resolvedURL(_ descriptor: HQRouteContractDescriptor,
                     pathArguments: [String: String], query: [URLQueryItem]) throws -> URL {
        let path = try resolvedPath(descriptor.pathTemplate, arguments: pathArguments)
        return try resolve(path, query: query)
    }

    private func resolvedPath(_ template: String, arguments: [String: String]) throws -> String {
        var path = template
        for (name, value) in arguments {
            guard let encoded = HQRouteContractDescriptor.canonicalDynamicSegment(value)
            else { throw HQAPIClientError.invalidContract(template) }
            path = path.replacingOccurrences(of: "{\(name)}", with: encoded)
        }
        guard !path.contains("{"), !path.contains("}"), path.hasPrefix("/"), !path.hasPrefix("//")
        else { throw HQAPIClientError.invalidContract(template) }
        return path
    }

    private func resolve(_ path: String, query: [URLQueryItem]) throws -> URL {
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false),
              path.hasPrefix("/"), !path.hasPrefix("//")
        else { throw HQAPIClientError.invalidContract(path) }
        // `resolvedPath` has already encoded each dynamic segment exactly once.
        // Assigning it to `.path` would escape `%` again (`%20` -> `%2520`).
        components.percentEncodedPath = path
        components.queryItems = query.isEmpty ? nil : query
        guard let url = components.url,
              let origin = try? HQHTTPSOrigin(validatingBaseURL: baseURL),
              origin.contains(url)
        else { throw HQAPIClientError.invalidContract(path) }
        return url
    }
}
