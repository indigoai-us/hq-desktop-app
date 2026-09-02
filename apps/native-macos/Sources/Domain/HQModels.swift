import Foundation

enum HQConnectionState: String, Codable, Hashable, Sendable {
    case connected
    case needsConnect = "needs_connect"
    case provisioning
    case cloudOnly = "cloud-only"
    case error
}

struct HQWorkspace: Identifiable, Codable, Hashable, Sendable {
    var id: String { slug }
    let slug: String
    let name: String
    let path: URL?
    let kind: String
    let state: HQConnectionState
    let lastSyncedAt: Date?
}

enum HQWorkState: String, Codable, CaseIterable, Hashable, Sendable {
    case notStarted = "not-started"
    case inProgress = "in-progress"
    case active
    case complete
}

struct HQTask: Identifiable, Codable, Hashable, Sendable {
    let id: String
    let title: String
    let detail: String
    let priority: Int
    let passes: Bool
    let acceptanceCriteria: [String]
    let dependencies: [String]
    let state: HQWorkState
}

struct HQProject: Identifiable, Codable, Hashable, Sendable {
    let id: String
    let companySlug: String
    let title: String
    let summary: String
    let status: String
    let branch: String?
    let path: URL
    let tasks: [HQTask]
    let owner: String?
    let livePhase: String?
    let prdPath: String?
    let boardPath: String?

    init(
        id: String,
        companySlug: String,
        title: String,
        summary: String,
        status: String,
        branch: String?,
        path: URL,
        tasks: [HQTask],
        owner: String?,
        livePhase: String?,
        prdPath: String? = nil,
        boardPath: String? = nil
    ) {
        self.id = id
        self.companySlug = companySlug
        self.title = title
        self.summary = summary
        self.status = status
        self.branch = branch
        self.path = path
        self.tasks = tasks
        self.owner = owner
        self.livePhase = livePhase
        self.prdPath = prdPath
        self.boardPath = boardPath
    }
}

struct HQGoal: Identifiable, Codable, Hashable, Sendable {
    let id: String
    let title: String
    let detail: String
    let progress: Double
    let owner: String?
}

struct HQSnapshot: Sendable {
    var workspaces: [HQWorkspace]
    var projects: [HQProject]
    var goals: [String: [HQGoal]]

    static let empty = HQSnapshot(workspaces: [], projects: [], goals: [:])
}
