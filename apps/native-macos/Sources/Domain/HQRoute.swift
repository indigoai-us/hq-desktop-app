import Foundation

enum HQGlobalRoute: String, CaseIterable, Codable, Hashable, Sendable {
    case home
    case missionControl = "mission-control"
    case inbox
    case meetings
    case marketplace
    case moderation
    case library
    case files
    case settings
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

enum HQRoute: Hashable, Sendable {
    case global(HQGlobalRoute)
    case company(slug: String, section: HQCompanySection)
    case library(HQLibrarySection)
    case settings(HQSettingsSection)
    case files(slug: String?, path: String?)
    case project(company: String, projectID: String)
    case task(company: String, projectID: String, taskID: String)
}

enum HQRouteParser {
    static func parse(_ value: String?) -> HQRoute? {
        guard let rawValue = value?.trimmingCharacters(in: .whitespacesAndNewlines),
              !rawValue.isEmpty
        else {
            return nil
        }

        let normalized = rawValue.replacingOccurrences(of: "/", with: ":")
        let parts = normalized.split(separator: ":", omittingEmptySubsequences: false).map(String.init)
        guard let head = parts.first else { return nil }

        if let global = HQGlobalRoute(rawValue: head), parts.count == 1 {
            return .global(global)
        }

        switch head {
        case "company":
            guard parts.count >= 2, !parts[1].isEmpty else { return nil }
            let sectionName = parts.count >= 3 ? legacyCompanySection(parts[2]) : "overview"
            guard let section = HQCompanySection(rawValue: sectionName) else { return nil }
            return .company(slug: decode(parts[1]), section: section)
        case "library":
            guard parts.count >= 2, let section = HQLibrarySection(rawValue: parts[1]) else {
                return .global(.library)
            }
            return .library(section)
        case "settings":
            guard parts.count >= 2, let section = HQSettingsSection(rawValue: parts[1]) else {
                return .global(.settings)
            }
            return .settings(section)
        case "files":
            let slug = parts.count >= 2 && !parts[1].isEmpty ? decode(parts[1]) : nil
            let path = parts.count >= 3
                ? parts.dropFirst(2).map(decode).joined(separator: "/")
                : nil
            return .files(slug: slug, path: path?.isEmpty == true ? nil : path)
        case "project":
            guard parts.count == 3 else { return nil }
            return .project(company: decode(parts[1]), projectID: decode(parts[2]))
        case "task":
            guard parts.count == 4 else { return nil }
            return .task(
                company: decode(parts[1]),
                projectID: decode(parts[2]),
                taskID: decode(parts[3])
            )
        default:
            return nil
        }
    }

    static func serialize(_ route: HQRoute) -> String {
        switch route {
        case let .global(route):
            return route.rawValue
        case let .company(slug, section):
            return "company:\(encode(slug)):\(section.rawValue)"
        case let .library(section):
            return "library:\(section.rawValue)"
        case let .settings(section):
            return "settings:\(section.rawValue)"
        case let .files(slug, path):
            return ["files", slug.map(encode), path.map(encode)]
                .compactMap { $0 }
                .joined(separator: ":")
        case let .project(company, projectID):
            return "project:\(encode(company)):\(encode(projectID))"
        case let .task(company, projectID, taskID):
            return "task:\(encode(company)):\(encode(projectID)):\(encode(taskID))"
        }
    }

    private static func legacyCompanySection(_ value: String) -> String {
        switch value {
        case "accounts":
            "overview"
        case "tasks":
            "projects"
        case "library":
            "skills"
        case "more":
            "activity"
        default:
            value
        }
    }

    private static func encode(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? value
    }

    private static func decode(_ value: String) -> String {
        value.removingPercentEncoding ?? value
    }
}
