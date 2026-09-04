import Combine
import Foundation
import SwiftUI

/// The five top-level destinations are intentionally presentation-level. A
/// canonical `HQRoute` remains the source of truth for every destination.
enum HQNavigationTab: String, CaseIterable, Codable, Hashable, Sendable {
    case home
    case work
    case inbox
    case meetings
    case more

    var rootRoute: HQRoute {
        switch self {
        case .home: HQRoute(kind: .global(.home))!
        case .work: HQRoute(kind: .global(.missionControl))!
        case .inbox: HQRoute(kind: .global(.inbox))!
        case .meetings: HQRoute(kind: .global(.meetings))!
        case .more: HQRoute(kind: .global(.marketplace))!
        }
    }

    var title: String { rawValue.capitalized }

    var symbolName: String {
        switch self {
        case .home: "house"
        case .work: "checklist"
        case .inbox: "tray"
        case .meetings: "video"
        case .more: "ellipsis.circle"
        }
    }
}

struct HQNavigationSnapshot: Codable, Equatable, Sendable {
    var selectedTab: HQNavigationTab
    var sidebarSelection: HQRoute
    var homePath: [HQRoute]
    var workPath: [HQRoute]
    var inboxPath: [HQRoute]
    var meetingsPath: [HQRoute]
    var morePath: [HQRoute]
    var scrollAnchors: [String: String]
    var inspectorRoute: HQRoute?
    var inspectorPresented: Bool
    var splitViewState: HQNavigationSplitViewState
}

enum HQNavigationSplitViewState: String, Codable, Equatable, Sendable {
    case automatic
    case all
    case doubleColumn
    case detailOnly

    init(_ visibility: NavigationSplitViewVisibility) {
        if visibility == .all {
            self = .all
        } else if visibility == .doubleColumn {
            self = .doubleColumn
        } else if visibility == .detailOnly {
            self = .detailOnly
        } else {
            self = .automatic
        }
    }

    var visibility: NavigationSplitViewVisibility {
        switch self {
        case .automatic: .automatic
        case .all: .all
        case .doubleColumn: .doubleColumn
        case .detailOnly: .detailOnly
        }
    }
}

/// One navigation state drives every presentation. Keeping paths as typed route
/// arrays makes system back, edge swipe, keyboard back, deep links, and scene
/// restoration use the same history rather than parallel ad-hoc selections.
@MainActor
final class HQNavigationModel: ObservableObject {
    @Published private(set) var selectedTab: HQNavigationTab
    @Published private(set) var sidebarSelection: HQRoute
    @Published private var paths: [HQNavigationTab: [HQRoute]]
    @Published private(set) var scrollAnchors: [String: String]
    @Published private(set) var inspectorRoute: HQRoute?
    @Published private(set) var inspectorPresented: Bool
    @Published var splitViewVisibility: NavigationSplitViewVisibility
    @Published private(set) var presentationRevision: UInt64 = 0

    init(snapshot: HQNavigationSnapshot? = nil) {
        let snapshot = snapshot.flatMap { Self.isValid($0) ? $0 : nil }
        let defaultRoute = HQNavigationTab.home.rootRoute
        selectedTab = snapshot?.selectedTab ?? .home
        sidebarSelection = snapshot?.sidebarSelection ?? defaultRoute
        paths = [
            .home: snapshot?.homePath ?? [],
            .work: snapshot?.workPath ?? [],
            .inbox: snapshot?.inboxPath ?? [],
            .meetings: snapshot?.meetingsPath ?? [],
            .more: snapshot?.morePath ?? [],
        ]
        scrollAnchors = snapshot?.scrollAnchors ?? [:]
        inspectorRoute = snapshot?.inspectorRoute
        inspectorPresented = snapshot?.inspectorPresented ?? false
        splitViewVisibility = snapshot?.splitViewState.visibility ?? .all
        synchronizeSelection(for: selectedTab)
    }

    func select(tab: HQNavigationTab) {
        selectedTab = tab
        synchronizeSelection(for: tab)
        presentationRevision &+= 1
    }

    func navigate(to route: HQRoute) {
        let tab = route.navigationTab
        var path = paths[tab, default: []]
        if route == tab.rootRoute {
            path.removeAll()
        } else if path.last != route {
            path.append(route)
        }
        paths[tab] = path
        selectedTab = tab
        // Publish the identity used by the iPad detail only after its complete
        // typed path is installed, so NavigationSplitView cannot rebuild an
        // intermediate container root and retain it.
        sidebarSelection = route
        presentationRevision &+= 1
    }

    /// Deep links select their enclosing container and push the exact route on
    /// that container's existing history. A root link is pushed only when the
    /// target already has history, allowing Back to restore prior context.
    func openDeepLink(_ route: HQRoute) {
        let tab = route.navigationTab
        var path = paths[tab, default: []]
        if path.last != route && (route != tab.rootRoute || !path.isEmpty) {
            path.append(route)
        }
        paths[tab] = path
        selectedTab = tab
        sidebarSelection = route
        presentationRevision &+= 1
    }

    func pop() {
        var path = paths[selectedTab, default: []]
        guard !path.isEmpty else { return }
        path.removeLast()
        paths[selectedTab] = path
        synchronizeSelection(for: selectedTab)
        presentationRevision &+= 1
    }

    func pathBinding(for tab: HQNavigationTab) -> Binding<[HQRoute]> {
        Binding(
            get: { self.paths[tab, default: []] },
            set: { self.setPath($0, for: tab) }
        )
    }

    func path(for tab: HQNavigationTab) -> [HQRoute] {
        paths[tab, default: []]
    }

    func tabBinding() -> Binding<HQNavigationTab> {
        Binding(get: { self.selectedTab }, set: { self.select(tab: $0) })
    }

    func recordScrollAnchor(_ anchor: String?, for route: HQRoute) {
        guard let anchor, !anchor.isEmpty else { return }
        scrollAnchors[route.canonicalString] = anchor
    }

    func scrollAnchor(for route: HQRoute) -> String? {
        scrollAnchors[route.canonicalString]
    }

    func scrollAnchorBinding(for route: HQRoute) -> Binding<String?> {
        Binding(
            get: { self.scrollAnchor(for: route) },
            set: { anchor in
                if let anchor, !anchor.isEmpty {
                    self.scrollAnchors[route.canonicalString] = anchor
                } else {
                    self.scrollAnchors.removeValue(forKey: route.canonicalString)
                }
            }
        )
    }

    func presentInspector(for route: HQRoute?) {
        inspectorRoute = route
        inspectorPresented = route != nil
    }

    func inspectorBinding() -> Binding<Bool> {
        Binding(
            get: { self.inspectorPresented },
            set: { presented in
                if !presented { self.presentInspector(for: nil) }
            }
        )
    }

    func snapshot() -> HQNavigationSnapshot {
        HQNavigationSnapshot(
            selectedTab: selectedTab,
            sidebarSelection: sidebarSelection,
            homePath: paths[.home, default: []],
            workPath: paths[.work, default: []],
            inboxPath: paths[.inbox, default: []],
            meetingsPath: paths[.meetings, default: []],
            morePath: paths[.more, default: []],
            scrollAnchors: scrollAnchors,
            inspectorRoute: inspectorRoute,
            inspectorPresented: inspectorPresented,
            splitViewState: HQNavigationSplitViewState(splitViewVisibility)
        )
    }

    func restore(_ snapshot: HQNavigationSnapshot) {
        guard Self.isValid(snapshot) else {
            reset()
            return
        }
        paths = [
            .home: snapshot.homePath,
            .work: snapshot.workPath,
            .inbox: snapshot.inboxPath,
            .meetings: snapshot.meetingsPath,
            .more: snapshot.morePath,
        ]
        scrollAnchors = snapshot.scrollAnchors
        inspectorRoute = snapshot.inspectorRoute
        inspectorPresented = snapshot.inspectorPresented
        splitViewVisibility = snapshot.splitViewState.visibility
        selectedTab = snapshot.selectedTab
        synchronizeSelection(for: selectedTab)
        presentationRevision &+= 1
    }

    func encodedSnapshot() -> String? {
        guard let data = try? JSONEncoder().encode(snapshot()) else { return nil }
        return data.base64EncodedString()
    }

    func restore(encodedSnapshot: String) {
        guard let data = Data(base64Encoded: encodedSnapshot),
              let snapshot = try? JSONDecoder().decode(HQNavigationSnapshot.self, from: data)
        else {
            reset()
            return
        }
        restore(snapshot)
    }

    /// Route and scroll context can reveal protected company/work identifiers,
    /// so it follows the same subject-scoped sign-out boundary as other local
    /// presentation state.
    func reset() {
        selectedTab = .home
        sidebarSelection = HQNavigationTab.home.rootRoute
        paths = Dictionary(uniqueKeysWithValues: HQNavigationTab.allCases.map { ($0, []) })
        scrollAnchors.removeAll()
        inspectorRoute = nil
        inspectorPresented = false
        splitViewVisibility = .all
        presentationRevision &+= 1
    }

    private func setPath(_ path: [HQRoute], for tab: HQNavigationTab) {
        guard paths[tab, default: []] != path else { return }
        paths[tab] = path
        if selectedTab == tab { synchronizeSelection(for: tab) }
        presentationRevision &+= 1
    }

    private func synchronizeSelection(for tab: HQNavigationTab) {
        sidebarSelection = paths[tab, default: []].last ?? tab.rootRoute
    }

    private static func isValid(_ snapshot: HQNavigationSnapshot) -> Bool {
        let paths: [(HQNavigationTab, [HQRoute])] = [
            (.home, snapshot.homePath),
            (.work, snapshot.workPath),
            (.inbox, snapshot.inboxPath),
            (.meetings, snapshot.meetingsPath),
            (.more, snapshot.morePath),
        ]
        guard paths.allSatisfy({ tab, routes in routes.allSatisfy { $0.navigationTab == tab } }) else {
            return false
        }
        let selectedPath = paths.first { $0.0 == snapshot.selectedTab }?.1 ?? []
        guard snapshot.sidebarSelection == (selectedPath.last ?? snapshot.selectedTab.rootRoute) else {
            return false
        }
        guard snapshot.inspectorPresented == (snapshot.inspectorRoute != nil) else {
            return false
        }
        return snapshot.scrollAnchors.allSatisfy { canonicalRoute, anchor in
            HQRoute.parse(canonicalRoute) != nil && !anchor.isEmpty
        }
    }
}

/// A scene owns exactly one coordinator. It keeps inbound navigation separate
/// from persisted subject-scoped history until restoration and authentication
/// have resolved, so cold links cannot be overwritten or leak another account.
@MainActor
final class HQSceneNavigationCoordinator: ObservableObject {
    let navigation: HQNavigationModel

    private let authenticationRequired: Bool
    private var navigationObservation: AnyCancellable?
    private var pendingRoutes: [HQRoute] = []
    private(set) var restorationComplete = false
    private(set) var activeSubjectID: String?
    private(set) var snapshotOwnerSubjectID: String?

    init(authenticationRequired: Bool) {
        self.authenticationRequired = authenticationRequired
        let navigation = HQNavigationModel()
        self.navigation = navigation
        navigationObservation = navigation.objectWillChange.sink { [weak self] _ in
            self?.objectWillChange.send()
        }
    }

    func receiveDeepLink(_ route: HQRoute) {
        guard restorationComplete, !authenticationRequired || activeSubjectID != nil else {
            pendingRoutes.append(route)
            return
        }
        navigation.openDeepLink(route)
    }

    func restore(encodedSnapshot: String, ownerSubjectID: String?) {
        guard !restorationComplete else { return }
        restorationComplete = true
        snapshotOwnerSubjectID = ownerSubjectID
        if !encodedSnapshot.isEmpty {
            navigation.restore(encodedSnapshot: encodedSnapshot)
        }
        if !authenticationRequired {
            applyPendingRoutes()
        } else if let activeSubjectID {
            finishActivation(subjectID: activeSubjectID)
        }
    }

    func activate(subjectID: String) {
        let subjectChanged = activeSubjectID.map { $0 != subjectID } ?? false
        activeSubjectID = subjectID
        if subjectChanged {
            navigation.reset()
        }
        guard restorationComplete else { return }
        // An ownerless record is unsafe once authentication is required. Scene
        // restoration can arrive before (or independently of) UserDefaults,
        // and accepting it would let a previous subject's route, scroll anchor,
        // or inspector context appear under the next authenticated session.
        if snapshotOwnerSubjectID != subjectID {
            navigation.reset()
        }
        finishActivation(subjectID: subjectID)
    }

    func deactivate() {
        if activeSubjectID != nil || snapshotOwnerSubjectID != nil {
            navigation.reset()
        }
        activeSubjectID = nil
        snapshotOwnerSubjectID = nil
    }

    private func finishActivation(subjectID: String) {
        snapshotOwnerSubjectID = subjectID
        applyPendingRoutes()
    }

    private func applyPendingRoutes() {
        let routes = pendingRoutes
        pendingRoutes.removeAll(keepingCapacity: true)
        routes.forEach(navigation.openDeepLink)
    }
}

extension HQRoute {
    var navigationTab: HQNavigationTab {
        switch kind {
        case .global(.home): .home
        case .global(.missionControl), .company, .project, .task: .work
        case .global(.inbox): .inbox
        case .global(.meetings): .meetings
        case .global(.marketplace), .global(.moderation), .library, .files, .settings: .more
        }
    }

    var readinessIdentifier: String {
        switch kind {
        case let .global(route): "screen.\(route.rawValue)"
        case let .library(section): "screen.library.\(section.rawValue)"
        case .files: "screen.files"
        case let .settings(section): "screen.settings.\(section.rawValue)"
        case let .company(_, section): "screen.company.\(section.rawValue)"
        case .project: "screen.project"
        case .task: "screen.task"
        }
    }

    var displayName: String {
        switch kind {
        case let .global(route):
            switch route {
            case .home: "Home"
            case .missionControl: "Mission Control"
            case .inbox: "Inbox"
            case .meetings: "Meetings"
            case .marketplace: "Marketplace"
            case .moderation: "Moderation"
            }
        case let .library(section): "Library · \(section.rawValue.capitalized)"
        case let .settings(section): "Settings · \(section.rawValue.capitalized)"
        case let .company(slug, section): "\(slug) · \(section.rawValue.capitalized)"
        case let .files(company, path):
            [company, path].compactMap { $0 }.isEmpty ? "Files" : "Files · \([company, path].compactMap { $0 }.joined(separator: " / "))"
        case let .project(company, projectID): "\(company) · \(projectID)"
        case let .task(company, projectID, taskID): "\(company) · \(projectID) · \(taskID)"
        }
    }

    var capabilityDisposition: HQCapabilityDisposition {
        switch kind {
        case .global(.home), .global(.missionControl), .task:
            .blockedMissingExternalBackend
        case .library(.workers), .library(.installed), .company(_, .workers), .company(_, .secrets):
            .degradedReadOnly
        case .settings(.sync), .settings(.updates):
            .deviceUnavailable
        case .settings(.notifications), .settings(.widget), .settings(.general), .settings(.meetings):
            .iosAdapted
        case .company(_, .overview), .company(_, .goals), .company(_, .settings):
            .blockedMissingExternalBackend
        default:
            .cloudBackedNative
        }
    }
}
