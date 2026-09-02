import Foundation

enum HQProjectParser {
    enum ParseError: LocalizedError {
        case malformed
        case missingIdentity

        var errorDescription: String? {
            switch self {
            case .malformed:
                "The project file is not valid JSON."
            case .missingIdentity:
                "The project file has no id or title."
            }
        }
    }

    static func parse(data: Data, companySlug: String, path: URL) throws -> HQProject {
        guard let object = try? JSONSerialization.jsonObject(with: data),
              let root = object as? [String: Any]
        else {
            throw ParseError.malformed
        }

        let projectID = string(root["id"]) ?? string(root["name"])
        let title = string(root["title"]) ?? string(root["name"])
        guard let projectID, !projectID.isEmpty, let title, !title.isEmpty else {
            throw ParseError.missingIdentity
        }

        let rawTasks = (root["userStories"] as? [[String: Any]])
            ?? (root["stories"] as? [[String: Any]])
            ?? []

        let tasks = rawTasks.compactMap(parseTask)
        let projectLivePhase = string(root["livePhase"])

        return HQProject(
            id: projectID,
            companySlug: companySlug,
            title: title,
            summary: string(root["objective"])
                ?? string(root["description"])
                ?? "",
            status: string(root["status"]) ?? "planned",
            branch: string(root["branchName"]) ?? string(root["branch"]),
            path: path,
            tasks: tasks,
            owner: string(root["owner"]),
            livePhase: projectLivePhase
        )
    }

    private static func parseTask(_ raw: [String: Any]) -> HQTask? {
        guard let id = string(raw["id"]), !id.isEmpty,
              let title = string(raw["title"]), !title.isEmpty
        else {
            return nil
        }

        let passes = raw["passes"] as? Bool ?? false
        let livePhase = string(raw["livePhase"])
        let notes = string(raw["notes"])
        let state: HQWorkState
        if passes {
            state = .complete
        } else if livePhase?.isEmpty == false {
            state = .active
        } else if notes?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false {
            state = .inProgress
        } else {
            state = .notStarted
        }

        return HQTask(
            id: id,
            title: title,
            detail: string(raw["description"]) ?? "",
            priority: int(raw["priority"]) ?? 0,
            passes: passes,
            acceptanceCriteria: strings(raw["acceptanceCriteria"]),
            dependencies: strings(raw["dependencies"]),
            state: state
        )
    }

    private static func string(_ value: Any?) -> String? {
        switch value {
        case let value as String:
            value
        case let value as NSNumber:
            value.stringValue
        default:
            nil
        }
    }

    private static func int(_ value: Any?) -> Int? {
        switch value {
        case let value as Int:
            value
        case let value as NSNumber:
            value.intValue
        case let value as String:
            Int(value)
        default:
            nil
        }
    }

    private static func strings(_ value: Any?) -> [String] {
        (value as? [Any])?.compactMap(string) ?? []
    }
}
