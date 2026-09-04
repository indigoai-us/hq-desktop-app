import Foundation

enum HQGlobalRoute: String, CaseIterable, Codable, Hashable, Sendable {
    case home
    case missionControl = "mission-control"
    case inbox
    case meetings
    case marketplace
    case moderation
}

enum HQLibrarySection: String, CaseIterable, Codable, Hashable, Sendable {
    case skills
    case workers
    case installed
    case profile
}

enum HQSettingsSection: String, CaseIterable, Codable, Hashable, Sendable {
    case sync
    case notifications
    case widget
    case updates
    case general
    case meetings
}

enum HQCompanySection: String, CaseIterable, Codable, Hashable, Sendable {
    case overview
    case goals
    case projects
    case skills
    case workers
    case knowledge
    case team
    case activity
    case deployments
    case secrets
    case settings
}

enum HQRouteKind: Hashable, Sendable {
    case global(HQGlobalRoute)
    case library(HQLibrarySection)
    case settings(HQSettingsSection)
    case company(slug: String, section: HQCompanySection)
    case files(company: String?, path: String?)
    case project(company: String, projectID: String)
    case task(company: String, projectID: String, taskID: String)
}

/// A route is a domain identifier, not a presentation or navigation object.
/// Parsed routes retain their exact canonical encoded spelling, while routes
/// constructed from values use the same strict percent-encoding rules.
struct HQRoute: Hashable, Sendable, Codable {
    let kind: HQRouteKind
    let canonicalString: String

    init?(kind: HQRouteKind) {
        guard Self.hasValidDynamicSegments(kind) else { return nil }
        self.kind = kind
        canonicalString = Self.serialize(kind)
    }

    static func parse(_ source: String?) -> HQRoute? {
        guard let source, !source.isEmpty, source == source.trimmingCharacters(in: .whitespacesAndNewlines) else {
            return nil
        }
        let parts = source.split(separator: ":", omittingEmptySubsequences: false).map(String.init)
        guard let head = parts.first else { return nil }

        let kind: HQRouteKind?
        if let global = HQGlobalRoute(rawValue: head), parts.count == 1 {
            kind = .global(global)
        } else {
            switch head {
            case "library":
                kind = parts.count == 2 ? HQLibrarySection(rawValue: parts[1]).map(HQRouteKind.library) : nil
            case "settings":
                kind = parts.count == 2 ? HQSettingsSection(rawValue: parts[1]).map(HQRouteKind.settings) : nil
            case "company":
                guard parts.count == 3,
                      let slug = decode(parts[1]),
                      let section = HQCompanySection(rawValue: parts[2])
                else { return nil }
                kind = .company(slug: slug, section: section)
            case "files":
                switch parts.count {
                case 1:
                    kind = .files(company: nil, path: nil)
                case 2:
                    guard let company = decode(parts[1]) else { return nil }
                    kind = .files(company: company, path: nil)
                case 3:
                    let company = parts[1].isEmpty ? nil : decode(parts[1])
                    guard let path = decode(parts[2]) else { return nil }
                    kind = .files(company: company, path: path)
                default:
                    return nil
                }
            case "project":
                guard parts.count == 3, let company = decode(parts[1]), let projectID = decode(parts[2]) else { return nil }
                kind = .project(company: company, projectID: projectID)
            case "task":
                guard parts.count == 4,
                      let company = decode(parts[1]),
                      let projectID = decode(parts[2]),
                      let taskID = decode(parts[3])
                else { return nil }
                kind = .task(company: company, projectID: projectID, taskID: taskID)
            default:
                kind = nil
            }
        }

        guard let kind, let route = HQRoute(kind: kind) else { return nil }
        // Canonical serialization is deliberately exact: malformed or partially
        // encoded input is rejected instead of silently changing route identity.
        guard serialize(kind) == source else { return nil }
        return route
    }

    static func serialize(_ route: HQRoute) -> String { route.canonicalString }

    static let ledgerIdentifiers: [String] = [
        "home", "mission-control", "inbox", "meetings", "marketplace", "moderation",
        "library:skills", "library:workers", "library:installed", "library:profile", "files",
        "settings:sync", "settings:notifications", "settings:widget", "settings:updates",
        "settings:general", "settings:meetings", "company:{slug}:overview", "company:{slug}:goals",
        "company:{slug}:projects", "company:{slug}:skills", "company:{slug}:workers",
        "company:{slug}:knowledge", "company:{slug}:team", "company:{slug}:activity",
        "company:{slug}:deployments", "company:{slug}:secrets", "company:{slug}:settings",
        "project:{company}:{project}", "task:{company}:{project}:{task}"
    ]

    private static func serialize(_ kind: HQRouteKind) -> String {
        switch kind {
        case let .global(route): route.rawValue
        case let .library(section): "library:\(section.rawValue)"
        case let .settings(section): "settings:\(section.rawValue)"
        case let .company(slug, section): "company:\(encode(slug)):\(section.rawValue)"
        case let .files(company, path):
            if company == nil, let path {
                "files::\(encode(path))"
            } else {
                (["files"] + [company, path].compactMap { $0.map(encode) }).joined(separator: ":")
            }
        case let .project(company, projectID): "project:\(encode(company)):\(encode(projectID))"
        case let .task(company, projectID, taskID): "task:\(encode(company)):\(encode(projectID)):\(encode(taskID))"
        }
    }

    /// Reject invalid in-memory route identities at construction time. Empty
    /// dynamic values cannot be distinguished from missing colon-delimited
    /// segments, so accepting them would create routes that do not parse back.
    /// The only intentional empty slot is the absent company in `files::<path>`.
    private static func hasValidDynamicSegments(_ kind: HQRouteKind) -> Bool {
        switch kind {
        case .global, .library, .settings:
            true
        case let .company(slug, _):
            !slug.isEmpty
        case let .files(company, path):
            (company.map { !$0.isEmpty } ?? true)
                && (path.map { !$0.isEmpty } ?? true)
        case let .project(company, projectID):
            !company.isEmpty && !projectID.isEmpty
        case let .task(company, projectID, taskID):
            !company.isEmpty && !projectID.isEmpty && !taskID.isEmpty
        }
    }

    private static func encode(_ value: String) -> String {
        // Encode UTF-8 bytes directly so route spelling is deterministic across
        // Foundation versions. The preserved macOS route contract uses
        // CharacterSet.alphanumerics, so even RFC 3986's -._~ bytes are encoded;
        // every escape uses uppercase hexadecimal.
        let hexadecimal = Array("0123456789ABCDEF".utf8)
        var encoded: [UInt8] = []
        encoded.reserveCapacity(value.utf8.count)

        for byte in value.utf8 {
            switch byte {
            case 0x41 ... 0x5A, 0x61 ... 0x7A, 0x30 ... 0x39:
                encoded.append(byte)
            default:
                encoded.append(0x25)
                encoded.append(hexadecimal[Int(byte >> 4)])
                encoded.append(hexadecimal[Int(byte & 0x0F)])
            }
        }

        return String(decoding: encoded, as: UTF8.self)
    }

    private static func decode(_ value: String) -> String? {
        guard !value.isEmpty, let decoded = value.removingPercentEncoding else { return nil }
        return decoded
    }

    init(from decoder: Decoder) throws {
        guard let route = Self.parse(try decoder.singleValueContainer().decode(String.self)) else {
            throw DecodingError.dataCorruptedError(in: try decoder.singleValueContainer(), debugDescription: "Invalid HQ route")
        }
        self = route
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(canonicalString)
    }
}
