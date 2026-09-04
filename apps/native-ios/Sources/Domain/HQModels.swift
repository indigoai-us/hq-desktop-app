import Foundation

/// A JSON value used for server fields that the current client does not yet
/// understand. Network boundaries must decode through `HQDomainJSONDecoder`,
/// which rejects numeric tokens that Foundation.Decimal cannot represent
/// exactly before `JSONDecoder` can silently round them.
enum HQJSONValue: Codable, Equatable, Hashable, Sendable {
    case null
    case bool(Bool)
    /// Decimal avoids the silent precision loss that a binary floating-point
    /// intermediary would cause for opaque server fields.
    case number(Decimal)
    case string(String)
    case array([HQJSONValue])
    case object([String: HQJSONValue])

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Decimal.self) {
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
        case .null: try container.encodeNil()
        case let .bool(value): try container.encode(value)
        case let .number(value): try container.encode(value)
        case let .string(value): try container.encode(value)
        case let .array(value): try container.encode(value)
        case let .object(value): try container.encode(value)
        }
    }
}

enum HQDomainJSONDecodingError: Error, Equatable, LocalizedError {
    case malformedNumber(String)
    case unsupportedNumberPrecision(String)

    var errorDescription: String? {
        switch self {
        case let .malformedNumber(value):
            "Malformed JSON number: \(value)"
        case let .unsupportedNumberPrecision(value):
            "JSON number cannot be represented exactly by Decimal: \(value)"
        }
    }
}

/// The mandatory raw-data decoder for response DTOs. It examines numeric
/// lexemes before Foundation has converted them, accepting only values that fit
/// Decimal's 38-significant-digit and exponent limits exactly.
struct HQDomainJSONDecoder {
    var dateDecodingStrategy: JSONDecoder.DateDecodingStrategy = .deferredToDate
    /// Test-only/injected validation clock for short-lived realtime contracts.
    /// Production decoding leaves this nil and validates against `Date.now`.
    var realtimeValidationNow: Date?

    func decode<Value: Decodable>(_ type: Value.Type, from data: Data) throws -> Value {
        let validatedData = try HQOpaqueJSONNumberValidator.validate(data)
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = dateDecodingStrategy
        if let realtimeValidationNow {
            decoder.userInfo[.hqRealtimeValidationNow] = realtimeValidationNow
        }
        return try decoder.decode(type, from: validatedData)
    }
}

extension CodingUserInfoKey {
    static let hqRealtimeValidationNow = CodingUserInfoKey(rawValue: "hq.realtime.validation-now")!
}

private enum HQOpaqueJSONNumberValidator {
    private static let maximumSignificantDigits = 38
    private static let supportedExponent = -128 ... 127

    static func validate(_ data: Data) throws -> Data {
        let bytes = Array(data)
        var index = 0
        var insideString = false
        var escaped = false
        var validatedBytes: [UInt8] = []
        validatedBytes.reserveCapacity(bytes.count)

        while index < bytes.count {
            let byte = bytes[index]
            if insideString {
                validatedBytes.append(byte)
                if escaped {
                    escaped = false
                } else if byte == 0x5C {
                    escaped = true
                } else if byte == 0x22 {
                    insideString = false
                }
                index += 1
                continue
            }

            if byte == 0x22 {
                validatedBytes.append(byte)
                insideString = true
                index += 1
            } else if byte == 0x2D || isDigit(byte) {
                let validatedNumber = try validateNumber(in: bytes, startingAt: index)
                validatedBytes.append(contentsOf: validatedNumber.lexeme.utf8)
                index = validatedNumber.endIndex
            } else {
                validatedBytes.append(byte)
                index += 1
            }
        }

        return Data(validatedBytes)
    }

    private static func validateNumber(in bytes: [UInt8], startingAt start: Int) throws -> (endIndex: Int, lexeme: String) {
        var index = start
        if bytes[index] == 0x2D {
            index += 1
            guard index < bytes.count else { throw malformed(bytes, start, index) }
        }

        if bytes[index] == 0x30 {
            index += 1
            if index < bytes.count, isDigit(bytes[index]) {
                throw malformed(bytes, start, index + 1)
            }
        } else {
            guard isOneThroughNine(bytes[index]) else { throw malformed(bytes, start, index + 1) }
            repeat { index += 1 } while index < bytes.count && isDigit(bytes[index])
        }

        if index < bytes.count, bytes[index] == 0x2E {
            index += 1
            let fractionStart = index
            while index < bytes.count, isDigit(bytes[index]) { index += 1 }
            guard index > fractionStart else { throw malformed(bytes, start, index) }
        }

        if index < bytes.count, (bytes[index] == 0x65 || bytes[index] == 0x45) {
            index += 1
            if index < bytes.count, (bytes[index] == 0x2B || bytes[index] == 0x2D) { index += 1 }
            let exponentStart = index
            while index < bytes.count, isDigit(bytes[index]) { index += 1 }
            guard index > exponentStart else { throw malformed(bytes, start, index) }
        }

        let lexeme = String(decoding: bytes[start ..< index], as: UTF8.self)
        return (index, try validateDecimalPrecision(lexeme))
    }

    private static func validateDecimalPrecision(_ lexeme: String) throws -> String {
        let unsigned = lexeme.first == "-" ? String(lexeme.dropFirst()) : lexeme
        let exponentSplit = unsigned.split(omittingEmptySubsequences: false, whereSeparator: { $0 == "e" || $0 == "E" })
        guard exponentSplit.count <= 2 else { throw HQDomainJSONDecodingError.malformedNumber(lexeme) }

        let mantissa = String(exponentSplit[0])
        let exponent: Int
        if exponentSplit.count == 2 {
            guard let parsed = Int(exponentSplit[1]), (-10_000 ... 10_000).contains(parsed) else {
                throw HQDomainJSONDecodingError.unsupportedNumberPrecision(lexeme)
            }
            exponent = parsed
        } else {
            exponent = 0
        }

        let mantissaSplit = mantissa.split(separator: ".", omittingEmptySubsequences: false)
        guard mantissaSplit.count <= 2 else { throw HQDomainJSONDecodingError.malformedNumber(lexeme) }
        let fractionalCount = mantissaSplit.count == 2 ? mantissaSplit[1].count : 0
        var coefficient = mantissaSplit.joined()
        while coefficient.first == "0" { coefficient.removeFirst() }
        guard !coefficient.isEmpty else {
            // Zero has no meaningful normalized scale, but an out-of-contract
            // raw exponent is still unsupported input and must fail loudly.
            guard supportedExponent.contains(exponent) else {
                throw HQDomainJSONDecodingError.unsupportedNumberPrecision(lexeme)
            }
            return lexeme
        }

        var removableTrailingZeros = 0
        while coefficient.last == "0" {
            coefficient.removeLast()
            removableTrailingZeros += 1
        }

        let decimalExponent = exponent - fractionalCount + removableTrailingZeros
        let sign = lexeme.first == "-" ? "-" : ""
        let normalizedLexeme = "\(sign)\(coefficient)e\(decimalExponent)"
        guard coefficient.count <= maximumSignificantDigits,
              supportedExponent.contains(decimalExponent),
              Decimal(string: normalizedLexeme, locale: Locale(identifier: "en_US_POSIX")) != nil
        else {
            throw HQDomainJSONDecodingError.unsupportedNumberPrecision(lexeme)
        }

        // Foundation rejects a small set of exact boundary spellings before
        // Decodable sees them (for example `10e-129`). Substitute only those
        // spellings with an exactly equivalent normalized Decimal lexeme.
        return Decimal(string: lexeme, locale: Locale(identifier: "en_US_POSIX")) == nil
            ? normalizedLexeme
            : lexeme
    }

    private static func malformed(_ bytes: [UInt8], _ start: Int, _ end: Int) -> HQDomainJSONDecodingError {
        .malformedNumber(String(decoding: bytes[start ..< min(end, bytes.count)], as: UTF8.self))
    }

    private static func isDigit(_ byte: UInt8) -> Bool { (0x30 ... 0x39).contains(byte) }
    private static func isOneThroughNine(_ byte: UInt8) -> Bool { (0x31 ... 0x39).contains(byte) }
}

/// Shared work-state vocabulary. Unknown server values remain visible rather
/// than being coerced into a known state.
enum HQWorkState: Hashable, Sendable, Codable {
    case notStarted
    case inProgress
    case active
    case complete
    case unknown(String)

    init(rawValue: String) {
        switch rawValue {
        case "not-started": self = .notStarted
        case "in-progress": self = .inProgress
        case "active": self = .active
        case "complete": self = .complete
        default: self = .unknown(rawValue)
        }
    }

    var rawValue: String {
        switch self {
        case .notStarted: "not-started"
        case .inProgress: "in-progress"
        case .active: "active"
        case .complete: "complete"
        case let .unknown(value): value
        }
    }

    init(from decoder: Decoder) throws {
        self.init(rawValue: try decoder.singleValueContainer().decode(String.self))
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}

/// Records how ownership was established so the client never silently turns an
/// inferred or server-supplied owner into a user assignment.
enum HQOwnershipProvenance: Hashable, Sendable, Codable {
    case assigned
    case inherited
    case inferred
    case system
    case unknown(String)

    init(rawValue: String) {
        switch rawValue {
        case "assigned": self = .assigned
        case "inherited": self = .inherited
        case "inferred": self = .inferred
        case "system": self = .system
        default: self = .unknown(rawValue)
        }
    }

    var rawValue: String {
        switch self {
        case .assigned: "assigned"
        case .inherited: "inherited"
        case .inferred: "inferred"
        case .system: "system"
        case let .unknown(value): value
        }
    }

    init(from decoder: Decoder) throws {
        self.init(rawValue: try decoder.singleValueContainer().decode(String.self))
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}

enum HQConnectionState: Hashable, Sendable, Codable {
    case connected
    case needsConnect
    case provisioning
    case cloudOnly
    case error
    case unknown(String)

    init(rawValue: String) {
        switch rawValue {
        case "connected": self = .connected
        case "needs_connect": self = .needsConnect
        case "provisioning": self = .provisioning
        case "cloud-only": self = .cloudOnly
        case "error": self = .error
        default: self = .unknown(rawValue)
        }
    }

    var rawValue: String {
        switch self {
        case .connected: "connected"
        case .needsConnect: "needs_connect"
        case .provisioning: "provisioning"
        case .cloudOnly: "cloud-only"
        case .error: "error"
        case let .unknown(value): value
        }
    }

    init(from decoder: Decoder) throws { self.init(rawValue: try decoder.singleValueContainer().decode(String.self)) }
    func encode(to encoder: Encoder) throws { var container = encoder.singleValueContainer(); try container.encode(rawValue) }
}

enum HQCapabilityDisposition: Hashable, Sendable, Codable {
    case cloudBackedNative
    case iosAdapted
    case degradedReadOnly
    case deviceUnavailable
    case blockedMissingExternalBackend
    case unknown(String)

    init(rawValue: String) {
        switch rawValue {
        case "cloud-backed-native": self = .cloudBackedNative
        case "ios-adapted": self = .iosAdapted
        case "degraded-read-only": self = .degradedReadOnly
        case "device-unavailable": self = .deviceUnavailable
        case "blocked-missing-external-backend": self = .blockedMissingExternalBackend
        default: self = .unknown(rawValue)
        }
    }

    var rawValue: String {
        switch self {
        case .cloudBackedNative: "cloud-backed-native"
        case .iosAdapted: "ios-adapted"
        case .degradedReadOnly: "degraded-read-only"
        case .deviceUnavailable: "device-unavailable"
        case .blockedMissingExternalBackend: "blocked-missing-external-backend"
        case let .unknown(value): value
        }
    }

    init(from decoder: Decoder) throws { self.init(rawValue: try decoder.singleValueContainer().decode(String.self)) }
    func encode(to encoder: Encoder) throws { var container = encoder.singleValueContainer(); try container.encode(rawValue) }
}

enum HQProjectStatus: Hashable, Sendable, Codable {
    case planned
    case active
    case blocked
    case complete
    case unknown(String)

    init(rawValue: String) {
        switch rawValue {
        case "planned": self = .planned
        case "active": self = .active
        case "blocked": self = .blocked
        case "complete": self = .complete
        default: self = .unknown(rawValue)
        }
    }

    var rawValue: String {
        switch self {
        case .planned: "planned"
        case .active: "active"
        case .blocked: "blocked"
        case .complete: "complete"
        case let .unknown(value): value
        }
    }

    init(from decoder: Decoder) throws { self.init(rawValue: try decoder.singleValueContainer().decode(String.self)) }
    func encode(to encoder: Encoder) throws { var container = encoder.singleValueContainer(); try container.encode(rawValue) }
}

enum HQMeetingState: Hashable, Sendable, Codable {
    case scheduled
    case starting
    case recording
    case stopping
    case complete
    case cancelled
    case error
    case unknown(String)

    init(rawValue: String) {
        switch rawValue {
        case "scheduled": self = .scheduled
        case "starting": self = .starting
        case "recording": self = .recording
        case "stopping": self = .stopping
        case "complete": self = .complete
        case "cancelled": self = .cancelled
        case "error": self = .error
        default: self = .unknown(rawValue)
        }
    }

    var rawValue: String {
        switch self {
        case .scheduled: "scheduled"
        case .starting: "starting"
        case .recording: "recording"
        case .stopping: "stopping"
        case .complete: "complete"
        case .cancelled: "cancelled"
        case .error: "error"
        case let .unknown(value): value
        }
    }

    init(from decoder: Decoder) throws { self.init(rawValue: try decoder.singleValueContainer().decode(String.self)) }
    func encode(to encoder: Encoder) throws { var container = encoder.singleValueContainer(); try container.encode(rawValue) }
}

enum HQMarketplaceListingStatus: Hashable, Sendable, Codable {
    case draft
    case pending
    case approved
    case rejected
    case yanked
    case unknown(String)

    init(rawValue: String) {
        switch rawValue {
        case "draft": self = .draft
        case "pending": self = .pending
        case "approved": self = .approved
        case "rejected": self = .rejected
        case "yanked": self = .yanked
        default: self = .unknown(rawValue)
        }
    }

    var rawValue: String {
        switch self {
        case .draft: "draft"
        case .pending: "pending"
        case .approved: "approved"
        case .rejected: "rejected"
        case .yanked: "yanked"
        case let .unknown(value): value
        }
    }

    init(from decoder: Decoder) throws { self.init(rawValue: try decoder.singleValueContainer().decode(String.self)) }
    func encode(to encoder: Encoder) throws { var container = encoder.singleValueContainer(); try container.encode(rawValue) }
}

enum HQDeploymentStatus: Hashable, Sendable, Codable {
    case queued
    case building
    case healthy
    case failed
    case cancelled
    case unknown(String)

    init(rawValue: String) {
        switch rawValue {
        case "queued": self = .queued
        case "building": self = .building
        case "healthy": self = .healthy
        case "failed": self = .failed
        case "cancelled": self = .cancelled
        default: self = .unknown(rawValue)
        }
    }

    var rawValue: String {
        switch self {
        case .queued: "queued"
        case .building: "building"
        case .healthy: "healthy"
        case .failed: "failed"
        case .cancelled: "cancelled"
        case let .unknown(value): value
        }
    }

    init(from decoder: Decoder) throws { self.init(rawValue: try decoder.singleValueContainer().decode(String.self)) }
    func encode(to encoder: Encoder) throws { var container = encoder.singleValueContainer(); try container.encode(rawValue) }
}

protocol HQExtensibleResponseDTO {
    var extensions: [String: HQJSONValue] { get }
}

enum HQMembershipRole: Hashable, Sendable, Codable {
    case owner
    case admin
    case member
    case guest
    case unknown(String)

    init(rawValue: String) {
        switch rawValue {
        case "owner": self = .owner
        case "admin": self = .admin
        case "member": self = .member
        case "guest": self = .guest
        default: self = .unknown(rawValue)
        }
    }

    var rawValue: String {
        switch self {
        case .owner: "owner"
        case .admin: "admin"
        case .member: "member"
        case .guest: "guest"
        case let .unknown(value): value
        }
    }

    init(from decoder: Decoder) throws { self.init(rawValue: try decoder.singleValueContainer().decode(String.self)) }
    func encode(to encoder: Encoder) throws { var container = encoder.singleValueContainer(); try container.encode(rawValue) }
}

enum HQMembershipStatus: Hashable, Sendable, Codable {
    case invited
    case active
    case suspended
    case revoked
    case unknown(String)

    init(rawValue: String) {
        switch rawValue {
        case "invited": self = .invited
        case "active": self = .active
        case "suspended": self = .suspended
        case "revoked": self = .revoked
        default: self = .unknown(rawValue)
        }
    }

    var rawValue: String {
        switch self {
        case .invited: "invited"
        case .active: "active"
        case .suspended: "suspended"
        case .revoked: "revoked"
        case let .unknown(value): value
        }
    }

    init(from decoder: Decoder) throws { self.init(rawValue: try decoder.singleValueContainer().decode(String.self)) }
    func encode(to encoder: Encoder) throws { var container = encoder.singleValueContainer(); try container.encode(rawValue) }
}

struct HQMobileFeatureFlags: Codable, Hashable, Sendable, HQExtensibleResponseDTO {
    let agents: Bool
    let claudeAutoOpen: Bool
    let groupMessaging: Bool
    let pushPreviews: Bool
    let reactions: Bool
    let threadReplies: Bool
    let work: Bool
    private(set) var extensions: [String: HQJSONValue] = [:]
}

struct HQMobileConfiguration: Codable, Hashable, Sendable, HQExtensibleResponseDTO {
    let features: HQMobileFeatureFlags
    private(set) var extensions: [String: HQJSONValue] = [:]
}

struct HQMembershipBrand: Codable, Hashable, Sendable, HQExtensibleResponseDTO {
    let website: String
    let faviconURL: String
    private(set) var extensions: [String: HQJSONValue] = [:]
}

struct HQMembership: Codable, Hashable, Sendable, HQExtensibleResponseDTO {
    let schemaVersion: Int
    let role: HQMembershipRole
    let updatedAt: Date
    let acceptedAt: Date?
    let invitedAt: Date?
    let companyUID: String
    let invitationID: String
    let createdAt: Date
    let membershipKey: String
    let invitedBy: String
    let status: HQMembershipStatus
    let personUID: String
    let companyName: String
    let companySlug: String
    let bucketName: String
    let fleetEnabled: Bool
    let teamPlanEnabled: Bool
    let brandingEnabled: Bool
    let brand: HQMembershipBrand?
    private(set) var extensions: [String: HQJSONValue] = [:]
}

struct HQMembershipResponse: Codable, Hashable, Sendable, HQExtensibleResponseDTO {
    let memberships: [HQMembership]
    private(set) var extensions: [String: HQJSONValue] = [:]
}

struct HQSubject: Codable, Hashable, Sendable, HQExtensibleResponseDTO {
    let id: String
    private(set) var extensions: [String: HQJSONValue]

    init(id: String, extensions: [String: HQJSONValue] = [:]) {
        self.id = id
        self.extensions = extensions
    }
}

struct HQCompany: Codable, Hashable, Sendable, HQExtensibleResponseDTO {
    let id: String
    let slug: String
    let name: String
    private(set) var extensions: [String: HQJSONValue] = [:]
}

struct HQProject: Codable, Hashable, Sendable, HQExtensibleResponseDTO {
    let id: String
    let companyID: String
    let title: String
    let status: HQProjectStatus
    let ownerID: String?
    let ownership: HQOwnershipProvenance
    private(set) var extensions: [String: HQJSONValue] = [:]
}

struct HQGoal: Codable, Hashable, Sendable, HQExtensibleResponseDTO {
    let id: String
    let title: String
    let progress: Decimal
    private(set) var extensions: [String: HQJSONValue] = [:]
}

struct HQMessage: Codable, Hashable, Sendable, HQExtensibleResponseDTO {
    let id: String
    let threadID: String
    let senderID: String
    let body: String
    let sentAt: Date
    private(set) var extensions: [String: HQJSONValue] = [:]
}

struct HQThread: Codable, Hashable, Sendable, HQExtensibleResponseDTO {
    let id: String
    let participantIDs: [String]
    let updatedAt: Date?
    private(set) var extensions: [String: HQJSONValue] = [:]
}

struct HQReaction: Codable, Hashable, Sendable, HQExtensibleResponseDTO {
    let emoji: String
    let subjectID: String
    let messageID: String
    private(set) var extensions: [String: HQJSONValue] = [:]
}

struct HQShare: Codable, Hashable, Sendable, HQExtensibleResponseDTO {
    let id: String
    let title: String
    let ownerID: String
    let route: HQRoute?
    private(set) var extensions: [String: HQJSONValue] = [:]
}

struct HQMeeting: Codable, Hashable, Sendable, HQExtensibleResponseDTO {
    let id: String
    let title: String
    let startsAt: Date
    let state: HQMeetingState
    private(set) var extensions: [String: HQJSONValue] = [:]
}

struct HQMarketplaceListing: Codable, Hashable, Sendable, HQExtensibleResponseDTO {
    let id: String
    let title: String
    let publisherID: String
    let status: HQMarketplaceListingStatus
    private(set) var extensions: [String: HQJSONValue] = [:]
}

struct HQWorker: Codable, Hashable, Sendable, HQExtensibleResponseDTO {
    let id: String
    let name: String
    let state: HQWorkState
    private(set) var extensions: [String: HQJSONValue] = [:]
}

struct HQSkill: Codable, Hashable, Sendable, HQExtensibleResponseDTO {
    let id: String
    let name: String
    let version: String?
    private(set) var extensions: [String: HQJSONValue] = [:]
}

struct HQFileMetadata: Codable, Hashable, Sendable, HQExtensibleResponseDTO {
    let id: String
    let path: String
    let size: Int64
    let updatedAt: Date?
    private(set) var extensions: [String: HQJSONValue] = [:]
}

struct HQActivity: Codable, Hashable, Sendable, HQExtensibleResponseDTO {
    let id: String
    /// Activity kind is intentionally an open server vocabulary, not a closed
    /// enum. Its exact spelling is retained while future sibling fields pass
    /// through `extensions`.
    let kind: String
    let occurredAt: Date
    private(set) var extensions: [String: HQJSONValue] = [:]
}

struct HQDeployment: Codable, Hashable, Sendable, HQExtensibleResponseDTO {
    let id: String
    let environment: String
    let status: HQDeploymentStatus
    let createdAt: Date
    private(set) var extensions: [String: HQJSONValue] = [:]
}

struct HQSecretMetadata: Codable, Hashable, Sendable, HQExtensibleResponseDTO {
    let id: String
    let name: String
    let updatedAt: Date?
    private(set) var extensions: [String: HQJSONValue] = [:]
}

struct HQPage<Item: Codable & Hashable & Sendable>: Codable, Hashable, Sendable, HQExtensibleResponseDTO {
    let items: [Item]
    let nextCursor: String?
    let hasMore: Bool
    private(set) var extensions: [String: HQJSONValue] = [:]

    init(items: [Item], nextCursor: String?, hasMore: Bool?, extensions: [String: HQJSONValue] = [:]) throws {
        if let nextCursor, nextCursor.isEmpty {
            throw DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "Opaque cursor cannot be empty"))
        }
        let cursorImpliesMore = nextCursor != nil
        if let hasMore, hasMore != cursorImpliesMore {
            throw DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "hasMore and nextCursor disagree"))
        }
        self.items = items
        self.nextCursor = nextCursor
        self.hasMore = hasMore ?? cursorImpliesMore
        self.extensions = extensions
    }
}

struct HQResponseEnvelope<Payload: Codable & Hashable & Sendable>: Codable, Hashable, Sendable, HQExtensibleResponseDTO {
    let data: Payload?
    let error: HQErrorEnvelope?
    let extensions: [String: HQJSONValue]

    init(data: Payload?, error: HQErrorEnvelope?, extensions: [String: HQJSONValue] = [:]) {
        self.data = data
        self.error = error
        self.extensions = extensions
    }

    private static var knownKeys: Set<String> { ["data", "error"] }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: HQDynamicCodingKey.self)
        data = try container.decodeIfPresent(Payload.self, forKey: HQDynamicCodingKey("data"))
        error = try container.decodeIfPresent(HQErrorEnvelope.self, forKey: HQDynamicCodingKey("error"))
        extensions = Dictionary(uniqueKeysWithValues: try container.allKeys.compactMap { key in
            guard !Self.knownKeys.contains(key.stringValue) else { return nil }
            return (key.stringValue, try container.decode(HQJSONValue.self, forKey: key))
        })
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: HQDynamicCodingKey.self)
        try container.encodeIfPresent(data, forKey: HQDynamicCodingKey("data"))
        try container.encodeIfPresent(error, forKey: HQDynamicCodingKey("error"))
        for (key, value) in extensions where !Self.knownKeys.contains(key) {
            try container.encode(value, forKey: HQDynamicCodingKey(key))
        }
    }
}

/// A representative work item whose custom coding retains any future response
/// keys in `extensions` for diagnostics, cache persistence, and re-encoding.
struct HQTask: Identifiable, Codable, Hashable, Sendable, HQExtensibleResponseDTO {
    let id: String
    let title: String
    let detail: String
    let priority: Int
    let passes: Bool
    let acceptanceCriteria: [String]
    let dependencies: [String]
    let state: HQWorkState
    let ownerID: String?
    let ownership: HQOwnershipProvenance
    let extensions: [String: HQJSONValue]

    init(
        id: String,
        title: String,
        detail: String,
        priority: Int,
        passes: Bool,
        acceptanceCriteria: [String],
        dependencies: [String],
        state: HQWorkState,
        ownerID: String? = nil,
        ownership: HQOwnershipProvenance = .unknown("unspecified"),
        extensions: [String: HQJSONValue] = [:]
    ) {
        self.id = id
        self.title = title
        self.detail = detail
        self.priority = priority
        self.passes = passes
        self.acceptanceCriteria = acceptanceCriteria
        self.dependencies = dependencies
        self.state = state
        self.ownerID = ownerID
        self.ownership = ownership
        self.extensions = extensions
    }

    private static let knownKeys: Set<String> = [
        "id", "title", "detail", "priority", "passes", "acceptanceCriteria",
        "dependencies", "state", "ownerID", "ownership"
    ]

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: HQDynamicCodingKey.self)
        func required<T: Decodable>(_ key: String, _ type: T.Type = T.self) throws -> T {
            try container.decode(T.self, forKey: HQDynamicCodingKey(key))
        }
        func optional<T: Decodable>(_ key: String, _ type: T.Type = T.self) throws -> T? {
            try container.decodeIfPresent(T.self, forKey: HQDynamicCodingKey(key))
        }

        id = try required("id")
        title = try required("title")
        detail = try optional("detail") ?? ""
        priority = try optional("priority") ?? 0
        passes = try optional("passes") ?? false
        acceptanceCriteria = try optional("acceptanceCriteria") ?? []
        dependencies = try optional("dependencies") ?? []
        state = try optional("state") ?? .unknown("unspecified")
        ownerID = try optional("ownerID")
        ownership = try optional("ownership") ?? .unknown("unspecified")

        extensions = Dictionary(uniqueKeysWithValues: try container.allKeys.compactMap { key in
            guard !Self.knownKeys.contains(key.stringValue) else { return nil }
            return (key.stringValue, try container.decode(HQJSONValue.self, forKey: key))
        })
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: HQDynamicCodingKey.self)
        try container.encode(id, forKey: HQDynamicCodingKey("id"))
        try container.encode(title, forKey: HQDynamicCodingKey("title"))
        try container.encode(detail, forKey: HQDynamicCodingKey("detail"))
        try container.encode(priority, forKey: HQDynamicCodingKey("priority"))
        try container.encode(passes, forKey: HQDynamicCodingKey("passes"))
        try container.encode(acceptanceCriteria, forKey: HQDynamicCodingKey("acceptanceCriteria"))
        try container.encode(dependencies, forKey: HQDynamicCodingKey("dependencies"))
        try container.encode(state, forKey: HQDynamicCodingKey("state"))
        try container.encodeIfPresent(ownerID, forKey: HQDynamicCodingKey("ownerID"))
        try container.encode(ownership, forKey: HQDynamicCodingKey("ownership"))
        for (key, value) in extensions where !Self.knownKeys.contains(key) {
            try container.encode(value, forKey: HQDynamicCodingKey(key))
        }
    }
}

struct HQErrorEnvelope: Codable, Equatable, Hashable, Sendable, HQExtensibleResponseDTO {
    let code: String
    let message: String
    let retryable: Bool
    let extensions: [String: HQJSONValue]

    init(code: String, message: String, retryable: Bool, extensions: [String: HQJSONValue] = [:]) {
        self.code = code
        self.message = message
        self.retryable = retryable
        self.extensions = extensions
    }

    private static let knownKeys: Set<String> = ["code", "message", "retryable"]

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: HQDynamicCodingKey.self)
        code = try container.decode(String.self, forKey: HQDynamicCodingKey("code"))
        message = try container.decode(String.self, forKey: HQDynamicCodingKey("message"))
        retryable = try container.decodeIfPresent(Bool.self, forKey: HQDynamicCodingKey("retryable")) ?? false
        extensions = Dictionary(uniqueKeysWithValues: try container.allKeys.compactMap { key in
            guard !Self.knownKeys.contains(key.stringValue) else { return nil }
            return (key.stringValue, try container.decode(HQJSONValue.self, forKey: key))
        })
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: HQDynamicCodingKey.self)
        try container.encode(code, forKey: HQDynamicCodingKey("code"))
        try container.encode(message, forKey: HQDynamicCodingKey("message"))
        try container.encode(retryable, forKey: HQDynamicCodingKey("retryable"))
        for (key, value) in extensions where !Self.knownKeys.contains(key) {
            try container.encode(value, forKey: HQDynamicCodingKey(key))
        }
    }
}

/// A caller-owned policy controls retention and access; cache storage itself has
/// no global subject and therefore cannot accidentally cross an identity.
protocol HQSubjectCachePolicy {
    func allowsRead(subject: HQSubject) -> Bool
    func allowsWrite(subject: HQSubject) -> Bool
}

struct HQAllowAuthenticatedSubjectCachePolicy: HQSubjectCachePolicy {
    init() {}

    func allowsRead(subject: HQSubject) -> Bool { !subject.id.isEmpty }
    func allowsWrite(subject: HQSubject) -> Bool { !subject.id.isEmpty }
}

struct HQSubjectCache<Key: Hashable, Value> {
    private let policy: any HQSubjectCachePolicy
    private var activeSubjectID: String?
    private var values: [String: [Key: Value]] = [:]

    init(policy: any HQSubjectCachePolicy) {
        self.policy = policy
    }

    mutating func activate(_ subject: HQSubject) {
        // Account switching is a security boundary, not a cache namespace
        // toggle. Purge all protected values before another subject can become
        // active so switching back can never resurrect prior-account data.
        // Unknown response extensions are mutable server metadata, not part of
        // authenticated identity; only the immutable subject ID is compared.
        if let activeSubjectID, activeSubjectID != subject.id {
            values.removeAll()
        }
        activeSubjectID = subject.id
    }

    mutating func store(_ value: Value, for key: Key, subject: HQSubject) {
        guard activeSubjectID == subject.id, policy.allowsWrite(subject: subject) else { return }
        values[subject.id, default: [:]][key] = value
    }

    func value(for key: Key, subject: HQSubject) -> Value? {
        guard activeSubjectID == subject.id, policy.allowsRead(subject: subject) else { return nil }
        return values[subject.id]?[key]
    }

    mutating func signOut(_: HQSubject) {
        // Sign-out is an authentication boundary, so a stale caller snapshot
        // must not be able to leave the active subject's protected state behind.
        purgeAllProtectedState()
    }

    mutating func purgeAllProtectedState() {
        values.removeAll()
        activeSubjectID = nil
    }
}

/// The process-wide owner of the app's real US-003 identity-scoped response
/// cache. Authentication purges this same owner; it does not maintain a
/// parallel placeholder store.
actor HQSubjectCacheOwner: HQProtectedStateStore {
    static let shared = HQSubjectCacheOwner()
    private var cache = HQSubjectCache<String, Data>(policy: HQAllowAuthenticatedSubjectCachePolicy())

    func activate(_ subject: HQSubject) { cache.activate(subject) }
    func store(_ value: Data, for key: String, subject: HQSubject) { cache.store(value, for: key, subject: subject) }
    func value(for key: String, subject: HQSubject) -> Data? { cache.value(for: key, subject: subject) }
    func purgeProtectedState() { cache.purgeAllProtectedState() }
}

private struct HQDynamicCodingKey: CodingKey, Hashable {
    let stringValue: String
    let intValue: Int?

    init(_ stringValue: String) {
        self.stringValue = stringValue
        intValue = nil
    }

    init?(stringValue: String) { self.init(stringValue) }
    init?(intValue: Int) { return nil }
}

private extension KeyedDecodingContainer where Key == HQDynamicCodingKey {
    func required<Value: Decodable>(_ key: String, as type: Value.Type = Value.self) throws -> Value {
        try decode(type, forKey: HQDynamicCodingKey(key))
    }

    func optional<Value: Decodable>(_ key: String, as type: Value.Type = Value.self) throws -> Value? {
        try decodeIfPresent(type, forKey: HQDynamicCodingKey(key))
    }

    func unknownFields(excluding knownKeys: Set<String>) throws -> [String: HQJSONValue] {
        Dictionary(uniqueKeysWithValues: try allKeys.compactMap { key in
            guard !knownKeys.contains(key.stringValue) else { return nil }
            return (key.stringValue, try decode(HQJSONValue.self, forKey: key))
        })
    }
}

private extension KeyedEncodingContainer where Key == HQDynamicCodingKey {
    mutating func encodeUnknownFields(_ fields: [String: HQJSONValue], excluding knownKeys: Set<String>) throws {
        for (key, value) in fields where !knownKeys.contains(key) {
            try encode(value, forKey: HQDynamicCodingKey(key))
        }
    }
}

extension HQMobileFeatureFlags {
    private static var knownKeys: Set<String> {
        ["agents", "claudeAutoOpen", "groupMessaging", "pushPreviews", "reactions", "threadReplies", "work"]
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: HQDynamicCodingKey.self)
        agents = try container.required("agents")
        claudeAutoOpen = try container.required("claudeAutoOpen")
        groupMessaging = try container.required("groupMessaging")
        pushPreviews = try container.required("pushPreviews")
        reactions = try container.required("reactions")
        threadReplies = try container.required("threadReplies")
        work = try container.required("work")
        extensions = try container.unknownFields(excluding: Self.knownKeys)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: HQDynamicCodingKey.self)
        try container.encode(agents, forKey: HQDynamicCodingKey("agents"))
        try container.encode(claudeAutoOpen, forKey: HQDynamicCodingKey("claudeAutoOpen"))
        try container.encode(groupMessaging, forKey: HQDynamicCodingKey("groupMessaging"))
        try container.encode(pushPreviews, forKey: HQDynamicCodingKey("pushPreviews"))
        try container.encode(reactions, forKey: HQDynamicCodingKey("reactions"))
        try container.encode(threadReplies, forKey: HQDynamicCodingKey("threadReplies"))
        try container.encode(work, forKey: HQDynamicCodingKey("work"))
        try container.encodeUnknownFields(extensions, excluding: Self.knownKeys)
    }
}

extension HQMobileConfiguration {
    private static var knownKeys: Set<String> { ["features"] }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: HQDynamicCodingKey.self)
        features = try container.required("features")
        extensions = try container.unknownFields(excluding: Self.knownKeys)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: HQDynamicCodingKey.self)
        try container.encode(features, forKey: HQDynamicCodingKey("features"))
        try container.encodeUnknownFields(extensions, excluding: Self.knownKeys)
    }
}

extension HQMembershipBrand {
    private static var knownKeys: Set<String> { ["website", "faviconUrl"] }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: HQDynamicCodingKey.self)
        website = try container.required("website")
        faviconURL = try container.required("faviconUrl")
        extensions = try container.unknownFields(excluding: Self.knownKeys)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: HQDynamicCodingKey.self)
        try container.encode(website, forKey: HQDynamicCodingKey("website"))
        try container.encode(faviconURL, forKey: HQDynamicCodingKey("faviconUrl"))
        try container.encodeUnknownFields(extensions, excluding: Self.knownKeys)
    }
}

extension HQMembership {
    private static var knownKeys: Set<String> {
        [
            "schemaVersion", "role", "updatedAt", "acceptedAt", "invitedAt", "companyUid",
            "invitationId", "createdAt", "membershipKey", "invitedBy", "status", "personUid",
            "companyName", "companySlug", "bucketName", "fleetEnabled", "teamPlanEnabled",
            "brandingEnabled", "brand",
        ]
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: HQDynamicCodingKey.self)
        schemaVersion = try container.required("schemaVersion")
        role = try container.required("role")
        updatedAt = try container.required("updatedAt")
        acceptedAt = try container.optional("acceptedAt")
        invitedAt = try container.optional("invitedAt")
        companyUID = try container.required("companyUid")
        invitationID = try container.required("invitationId")
        createdAt = try container.required("createdAt")
        membershipKey = try container.required("membershipKey")
        invitedBy = try container.required("invitedBy")
        status = try container.required("status")
        personUID = try container.required("personUid")
        companyName = try container.required("companyName")
        companySlug = try container.required("companySlug")
        bucketName = try container.required("bucketName")
        fleetEnabled = try container.required("fleetEnabled")
        teamPlanEnabled = try container.required("teamPlanEnabled")
        brandingEnabled = try container.required("brandingEnabled")
        brand = try container.optional("brand")
        extensions = try container.unknownFields(excluding: Self.knownKeys)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: HQDynamicCodingKey.self)
        try container.encode(schemaVersion, forKey: HQDynamicCodingKey("schemaVersion"))
        try container.encode(role, forKey: HQDynamicCodingKey("role"))
        try container.encode(updatedAt, forKey: HQDynamicCodingKey("updatedAt"))
        try container.encodeIfPresent(acceptedAt, forKey: HQDynamicCodingKey("acceptedAt"))
        try container.encodeIfPresent(invitedAt, forKey: HQDynamicCodingKey("invitedAt"))
        try container.encode(companyUID, forKey: HQDynamicCodingKey("companyUid"))
        try container.encode(invitationID, forKey: HQDynamicCodingKey("invitationId"))
        try container.encode(createdAt, forKey: HQDynamicCodingKey("createdAt"))
        try container.encode(membershipKey, forKey: HQDynamicCodingKey("membershipKey"))
        try container.encode(invitedBy, forKey: HQDynamicCodingKey("invitedBy"))
        try container.encode(status, forKey: HQDynamicCodingKey("status"))
        try container.encode(personUID, forKey: HQDynamicCodingKey("personUid"))
        try container.encode(companyName, forKey: HQDynamicCodingKey("companyName"))
        try container.encode(companySlug, forKey: HQDynamicCodingKey("companySlug"))
        try container.encode(bucketName, forKey: HQDynamicCodingKey("bucketName"))
        try container.encode(fleetEnabled, forKey: HQDynamicCodingKey("fleetEnabled"))
        try container.encode(teamPlanEnabled, forKey: HQDynamicCodingKey("teamPlanEnabled"))
        try container.encode(brandingEnabled, forKey: HQDynamicCodingKey("brandingEnabled"))
        try container.encodeIfPresent(brand, forKey: HQDynamicCodingKey("brand"))
        try container.encodeUnknownFields(extensions, excluding: Self.knownKeys)
    }
}

extension HQMembershipResponse {
    private static var knownKeys: Set<String> { ["memberships"] }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: HQDynamicCodingKey.self)
        memberships = try container.required("memberships")
        extensions = try container.unknownFields(excluding: Self.knownKeys)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: HQDynamicCodingKey.self)
        try container.encode(memberships, forKey: HQDynamicCodingKey("memberships"))
        try container.encodeUnknownFields(extensions, excluding: Self.knownKeys)
    }
}

extension HQSubject {
    private static var knownKeys: Set<String> { ["id"] }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: HQDynamicCodingKey.self)
        id = try container.required("id")
        extensions = try container.unknownFields(excluding: Self.knownKeys)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: HQDynamicCodingKey.self)
        try container.encode(id, forKey: HQDynamicCodingKey("id"))
        try container.encodeUnknownFields(extensions, excluding: Self.knownKeys)
    }
}

extension HQCompany {
    private static var knownKeys: Set<String> { ["id", "slug", "name"] }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: HQDynamicCodingKey.self)
        id = try container.required("id")
        slug = try container.required("slug")
        name = try container.required("name")
        extensions = try container.unknownFields(excluding: Self.knownKeys)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: HQDynamicCodingKey.self)
        try container.encode(id, forKey: HQDynamicCodingKey("id"))
        try container.encode(slug, forKey: HQDynamicCodingKey("slug"))
        try container.encode(name, forKey: HQDynamicCodingKey("name"))
        try container.encodeUnknownFields(extensions, excluding: Self.knownKeys)
    }
}

extension HQProject {
    private static var knownKeys: Set<String> { ["id", "companyID", "title", "status", "ownerID", "ownership"] }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: HQDynamicCodingKey.self)
        id = try container.required("id")
        companyID = try container.required("companyID")
        title = try container.required("title")
        status = try container.required("status")
        ownerID = try container.optional("ownerID")
        ownership = try container.required("ownership")
        extensions = try container.unknownFields(excluding: Self.knownKeys)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: HQDynamicCodingKey.self)
        try container.encode(id, forKey: HQDynamicCodingKey("id"))
        try container.encode(companyID, forKey: HQDynamicCodingKey("companyID"))
        try container.encode(title, forKey: HQDynamicCodingKey("title"))
        try container.encode(status, forKey: HQDynamicCodingKey("status"))
        try container.encodeIfPresent(ownerID, forKey: HQDynamicCodingKey("ownerID"))
        try container.encode(ownership, forKey: HQDynamicCodingKey("ownership"))
        try container.encodeUnknownFields(extensions, excluding: Self.knownKeys)
    }
}

extension HQGoal {
    private static var knownKeys: Set<String> { ["id", "title", "progress"] }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: HQDynamicCodingKey.self)
        id = try container.required("id")
        title = try container.required("title")
        progress = try container.required("progress")
        extensions = try container.unknownFields(excluding: Self.knownKeys)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: HQDynamicCodingKey.self)
        try container.encode(id, forKey: HQDynamicCodingKey("id"))
        try container.encode(title, forKey: HQDynamicCodingKey("title"))
        try container.encode(progress, forKey: HQDynamicCodingKey("progress"))
        try container.encodeUnknownFields(extensions, excluding: Self.knownKeys)
    }
}

extension HQMessage {
    private static var knownKeys: Set<String> { ["id", "threadID", "senderID", "body", "sentAt"] }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: HQDynamicCodingKey.self)
        id = try container.required("id")
        threadID = try container.required("threadID")
        senderID = try container.required("senderID")
        body = try container.required("body")
        sentAt = try container.required("sentAt")
        extensions = try container.unknownFields(excluding: Self.knownKeys)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: HQDynamicCodingKey.self)
        try container.encode(id, forKey: HQDynamicCodingKey("id"))
        try container.encode(threadID, forKey: HQDynamicCodingKey("threadID"))
        try container.encode(senderID, forKey: HQDynamicCodingKey("senderID"))
        try container.encode(body, forKey: HQDynamicCodingKey("body"))
        try container.encode(sentAt, forKey: HQDynamicCodingKey("sentAt"))
        try container.encodeUnknownFields(extensions, excluding: Self.knownKeys)
    }
}

extension HQThread {
    private static var knownKeys: Set<String> { ["id", "participantIDs", "updatedAt"] }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: HQDynamicCodingKey.self)
        id = try container.required("id")
        participantIDs = try container.required("participantIDs")
        updatedAt = try container.optional("updatedAt")
        extensions = try container.unknownFields(excluding: Self.knownKeys)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: HQDynamicCodingKey.self)
        try container.encode(id, forKey: HQDynamicCodingKey("id"))
        try container.encode(participantIDs, forKey: HQDynamicCodingKey("participantIDs"))
        try container.encodeIfPresent(updatedAt, forKey: HQDynamicCodingKey("updatedAt"))
        try container.encodeUnknownFields(extensions, excluding: Self.knownKeys)
    }
}

extension HQReaction {
    private static var knownKeys: Set<String> { ["emoji", "subjectID", "messageID"] }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: HQDynamicCodingKey.self)
        emoji = try container.required("emoji")
        subjectID = try container.required("subjectID")
        messageID = try container.required("messageID")
        extensions = try container.unknownFields(excluding: Self.knownKeys)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: HQDynamicCodingKey.self)
        try container.encode(emoji, forKey: HQDynamicCodingKey("emoji"))
        try container.encode(subjectID, forKey: HQDynamicCodingKey("subjectID"))
        try container.encode(messageID, forKey: HQDynamicCodingKey("messageID"))
        try container.encodeUnknownFields(extensions, excluding: Self.knownKeys)
    }
}

extension HQShare {
    private static var knownKeys: Set<String> { ["id", "title", "ownerID", "route"] }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: HQDynamicCodingKey.self)
        id = try container.required("id")
        title = try container.required("title")
        ownerID = try container.required("ownerID")
        route = try container.optional("route")
        extensions = try container.unknownFields(excluding: Self.knownKeys)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: HQDynamicCodingKey.self)
        try container.encode(id, forKey: HQDynamicCodingKey("id"))
        try container.encode(title, forKey: HQDynamicCodingKey("title"))
        try container.encode(ownerID, forKey: HQDynamicCodingKey("ownerID"))
        try container.encodeIfPresent(route, forKey: HQDynamicCodingKey("route"))
        try container.encodeUnknownFields(extensions, excluding: Self.knownKeys)
    }
}

extension HQMeeting {
    private static var knownKeys: Set<String> { ["id", "title", "startsAt", "state"] }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: HQDynamicCodingKey.self)
        id = try container.required("id")
        title = try container.required("title")
        startsAt = try container.required("startsAt")
        state = try container.required("state")
        extensions = try container.unknownFields(excluding: Self.knownKeys)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: HQDynamicCodingKey.self)
        try container.encode(id, forKey: HQDynamicCodingKey("id"))
        try container.encode(title, forKey: HQDynamicCodingKey("title"))
        try container.encode(startsAt, forKey: HQDynamicCodingKey("startsAt"))
        try container.encode(state, forKey: HQDynamicCodingKey("state"))
        try container.encodeUnknownFields(extensions, excluding: Self.knownKeys)
    }
}

extension HQMarketplaceListing {
    private static var knownKeys: Set<String> { ["id", "title", "publisherID", "status"] }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: HQDynamicCodingKey.self)
        id = try container.required("id")
        title = try container.required("title")
        publisherID = try container.required("publisherID")
        status = try container.required("status")
        extensions = try container.unknownFields(excluding: Self.knownKeys)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: HQDynamicCodingKey.self)
        try container.encode(id, forKey: HQDynamicCodingKey("id"))
        try container.encode(title, forKey: HQDynamicCodingKey("title"))
        try container.encode(publisherID, forKey: HQDynamicCodingKey("publisherID"))
        try container.encode(status, forKey: HQDynamicCodingKey("status"))
        try container.encodeUnknownFields(extensions, excluding: Self.knownKeys)
    }
}

extension HQWorker {
    private static var knownKeys: Set<String> { ["id", "name", "state"] }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: HQDynamicCodingKey.self)
        id = try container.required("id")
        name = try container.required("name")
        state = try container.required("state")
        extensions = try container.unknownFields(excluding: Self.knownKeys)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: HQDynamicCodingKey.self)
        try container.encode(id, forKey: HQDynamicCodingKey("id"))
        try container.encode(name, forKey: HQDynamicCodingKey("name"))
        try container.encode(state, forKey: HQDynamicCodingKey("state"))
        try container.encodeUnknownFields(extensions, excluding: Self.knownKeys)
    }
}

extension HQSkill {
    private static var knownKeys: Set<String> { ["id", "name", "version"] }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: HQDynamicCodingKey.self)
        id = try container.required("id")
        name = try container.required("name")
        version = try container.optional("version")
        extensions = try container.unknownFields(excluding: Self.knownKeys)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: HQDynamicCodingKey.self)
        try container.encode(id, forKey: HQDynamicCodingKey("id"))
        try container.encode(name, forKey: HQDynamicCodingKey("name"))
        try container.encodeIfPresent(version, forKey: HQDynamicCodingKey("version"))
        try container.encodeUnknownFields(extensions, excluding: Self.knownKeys)
    }
}

extension HQFileMetadata {
    private static var knownKeys: Set<String> { ["id", "path", "size", "updatedAt"] }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: HQDynamicCodingKey.self)
        id = try container.required("id")
        path = try container.required("path")
        size = try container.required("size")
        updatedAt = try container.optional("updatedAt")
        extensions = try container.unknownFields(excluding: Self.knownKeys)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: HQDynamicCodingKey.self)
        try container.encode(id, forKey: HQDynamicCodingKey("id"))
        try container.encode(path, forKey: HQDynamicCodingKey("path"))
        try container.encode(size, forKey: HQDynamicCodingKey("size"))
        try container.encodeIfPresent(updatedAt, forKey: HQDynamicCodingKey("updatedAt"))
        try container.encodeUnknownFields(extensions, excluding: Self.knownKeys)
    }
}

extension HQActivity {
    private static var knownKeys: Set<String> { ["id", "kind", "occurredAt"] }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: HQDynamicCodingKey.self)
        id = try container.required("id")
        kind = try container.required("kind")
        occurredAt = try container.required("occurredAt")
        extensions = try container.unknownFields(excluding: Self.knownKeys)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: HQDynamicCodingKey.self)
        try container.encode(id, forKey: HQDynamicCodingKey("id"))
        try container.encode(kind, forKey: HQDynamicCodingKey("kind"))
        try container.encode(occurredAt, forKey: HQDynamicCodingKey("occurredAt"))
        try container.encodeUnknownFields(extensions, excluding: Self.knownKeys)
    }
}

extension HQDeployment {
    private static var knownKeys: Set<String> { ["id", "environment", "status", "createdAt"] }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: HQDynamicCodingKey.self)
        id = try container.required("id")
        environment = try container.required("environment")
        status = try container.required("status")
        createdAt = try container.required("createdAt")
        extensions = try container.unknownFields(excluding: Self.knownKeys)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: HQDynamicCodingKey.self)
        try container.encode(id, forKey: HQDynamicCodingKey("id"))
        try container.encode(environment, forKey: HQDynamicCodingKey("environment"))
        try container.encode(status, forKey: HQDynamicCodingKey("status"))
        try container.encode(createdAt, forKey: HQDynamicCodingKey("createdAt"))
        try container.encodeUnknownFields(extensions, excluding: Self.knownKeys)
    }
}

extension HQSecretMetadata {
    private static var knownKeys: Set<String> { ["id", "name", "updatedAt"] }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: HQDynamicCodingKey.self)
        id = try container.required("id")
        name = try container.required("name")
        updatedAt = try container.optional("updatedAt")
        extensions = try container.unknownFields(excluding: Self.knownKeys)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: HQDynamicCodingKey.self)
        try container.encode(id, forKey: HQDynamicCodingKey("id"))
        try container.encode(name, forKey: HQDynamicCodingKey("name"))
        try container.encodeIfPresent(updatedAt, forKey: HQDynamicCodingKey("updatedAt"))
        try container.encodeUnknownFields(extensions, excluding: Self.knownKeys)
    }
}

extension HQPage {
    private static var knownKeys: Set<String> { ["items", "nextCursor", "hasMore"] }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: HQDynamicCodingKey.self)
        try self.init(
            items: container.required("items"),
            nextCursor: container.optional("nextCursor"),
            hasMore: container.optional("hasMore"),
            extensions: container.unknownFields(excluding: Self.knownKeys)
        )
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: HQDynamicCodingKey.self)
        try container.encode(items, forKey: HQDynamicCodingKey("items"))
        try container.encodeIfPresent(nextCursor, forKey: HQDynamicCodingKey("nextCursor"))
        try container.encode(hasMore, forKey: HQDynamicCodingKey("hasMore"))
        try container.encodeUnknownFields(extensions, excluding: Self.knownKeys)
    }
}
