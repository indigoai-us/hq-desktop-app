import SwiftUI
import UIKit

@main
@MainActor
struct HQIOSApp: App {
    private let launch: HQLaunchConfiguration
    @StateObject private var session: HQSessionController
    @StateObject private var realtimeOwner: HQAppRealtimeOwner
    @StateObject private var shellPresentation: HQShellPresentationStore

    init() {
        let session = HQSessionController()
        let shellPresentation = HQShellPresentationStore()
        launch = HQLaunchConfiguration.current
        _session = StateObject(wrappedValue: session)
        _shellPresentation = StateObject(wrappedValue: shellPresentation)
        _realtimeOwner = StateObject(wrappedValue: Self.makeRealtimeOwner(session: session, shellPresentation: shellPresentation))
    }

    var body: some Scene {
        WindowGroup {
            HQSceneRoot(launch: launch, session: session, realtimeOwner: realtimeOwner, shellPresentation: shellPresentation)
        }
    }

    private static func makeRealtimeOwner(
        session: HQSessionController,
        shellPresentation: HQShellPresentationStore
    ) -> HQAppRealtimeOwner {
        let stateStore = HQAuthoritativeStateStore()
        return HQAppRealtimeOwner { fence in
            let api = try HQAPIClient(session: session)
            let reconciler = HQReconciler(
                fence: fence,
                fetch: { activeFence in
                    do {
                    async let configurationResult = api.mobileConfiguration()
                    async let membershipResult = api.membership()
                    let (configurationRoute, membershipRoute) = try await (configurationResult, membershipResult)

                    let configuration: HQMobileConfiguration?
                    switch configurationRoute {
                    case let .content(value): configuration = value
                    case .degraded, .unavailable: configuration = nil
                    }
                    let membership: HQMembershipResponse?
                    switch membershipRoute {
                    case let .content(value): membership = value
                    case .degraded, .unavailable: membership = nil
                    }

                    await MainActor.run {
                        shellPresentation.apply(configuration: configurationRoute, membership: membershipRoute)
                    }

                    var available: Set<HQAuthoritativeDomain> = []
                    if configuration != nil { available.insert(.mobileConfiguration) }
                    if membership != nil { available.insert(.membership) }
                    return HQAuthoritativeSnapshot(
                        subjectID: activeFence.subjectID,
                        mobileConfiguration: configuration,
                        membership: membership,
                        availableDomains: available
                    )
                    } catch {
                        await MainActor.run { shellPresentation.apply(error: error) }
                        throw error
                    }
                },
                applier: stateStore
            )
            let client = HQRealtimeClient(
                credentialsProvider: { try await api.realtimeCredentialsValue() },
                reconciler: reconciler
            )
            return HQRealtimeRuntime(
                client: client,
                reconciler: reconciler,
                invalidateAuthoritativeState: { await stateStore.invalidate(fence: fence) }
            )
        }
    }
}

/// `WindowGroup` constructs this value per scene, so each iPad window owns an
/// independent route history while authentication and realtime remain app-wide.
private struct HQSceneRoot: View {
    let launch: HQLaunchConfiguration
    @ObservedObject var session: HQSessionController
    @ObservedObject var realtimeOwner: HQAppRealtimeOwner
    @ObservedObject var shellPresentation: HQShellPresentationStore
    @StateObject private var coordinator: HQSceneNavigationCoordinator
    @State private var persistenceSceneID: String?
    @SceneStorage("hq.navigation.snapshot") private var persistedNavigationSnapshot = ""
    @SceneStorage("hq.navigation.subject") private var persistedNavigationSubject = ""

    init(
        launch: HQLaunchConfiguration,
        session: HQSessionController,
        realtimeOwner: HQAppRealtimeOwner,
        shellPresentation: HQShellPresentationStore
    ) {
        self.launch = launch
        self.session = session
        self.realtimeOwner = realtimeOwner
        self.shellPresentation = shellPresentation
        _coordinator = StateObject(
            wrappedValue: HQSceneNavigationCoordinator(authenticationRequired: launch.state == .signedOut)
        )
    }

    var body: some View {
        HQLaunchRoot(
            launch: launch,
            session: session,
            realtimeOwner: realtimeOwner,
            navigation: coordinator.navigation,
            shellPresentation: shellPresentation
        )
        .background {
            HQSceneIdentifierReader { sceneID in
                resolvePersistenceScene(sceneID)
            }
        }
        .task {
            openHarnessRouteIfPresent()
            guard launch.state == .signedOut else { return }
            await session.restoreSession()
        }
        .onOpenURL(perform: handleInboundURL)
        .onChange(of: coordinator.navigation.snapshot()) { _, _ in
            persistSceneNavigation()
        }
        .onChange(of: session.state) { _, state in
            applyAuthenticationState(state)
        }
        .overlay(alignment: .bottomTrailing) {
            navigationPersistenceProbe
        }
    }

    private func handleInboundURL(_ url: URL) {
        switch HQInboundURLClassifier.classify(url) {
        case .authenticationCallback:
            session.handleInboundURL(url)
        case .appNavigation:
            if let route = HQDeepLinkRouter.route(from: url) {
                // `onOpenURL` can be delivered inside SwiftUI's current view
                // update transaction. Mutating a NavigationStack path in that
                // transaction persists the model value but iPadOS can drop the
                // matching presentation transition. Resume on the next main-
                // actor turn so the typed path and UI advance together.
                Task { @MainActor in
                    await Task.yield()
                    coordinator.receiveDeepLink(route)
                }
            }
        case .unrelated:
            break
        }
    }

    private func resolvePersistenceScene(_ sceneID: String) {
        guard persistenceSceneID == nil else { return }
        persistenceSceneID = sceneID

        #if DEBUG
        if case .navigationHarness = launch.state,
           ProcessInfo.processInfo.arguments.contains("--hq-navigation-reset") {
            persistedNavigationSnapshot = ""
            persistedNavigationSubject = ""
            HQNavigationPersistenceStore.remove(sceneID: sceneID)
        }
        #endif

        if persistedNavigationSnapshot.isEmpty,
           let stored = HQNavigationPersistenceStore.load(sceneID: sceneID) {
            persistedNavigationSnapshot = stored.snapshot
            persistedNavigationSubject = stored.subjectID ?? ""
        }
        coordinator.restore(
            encodedSnapshot: persistedNavigationSnapshot,
            ownerSubjectID: persistedNavigationSubject.isEmpty ? nil : persistedNavigationSubject
        )
        if case let .signedIn(subjectID) = session.state {
            coordinator.activate(subjectID: subjectID)
        }
    }

    private func openHarnessRouteIfPresent() {
        guard case .navigationHarness = launch.state,
              let rawRoute = ProcessInfo.processInfo.environment["HQIOS_NAVIGATION_ROUTE"],
              let route = HQRoute.parse(rawRoute)
        else { return }
        coordinator.receiveDeepLink(route)
    }

    private func applyAuthenticationState(_ state: HQAuthenticationState) {
        switch state {
        case let .signedIn(subjectID):
            HQNavigationPersistenceStore.removeRecords(notOwnedBy: subjectID)
            coordinator.activate(subjectID: subjectID)
        case .signedOut, .reauthenticationRequired, .securityResetRequired:
            HQNavigationPersistenceStore.removeAll()
            coordinator.deactivate()
            shellPresentation.reset()
        case .restoring, .signingIn, .signingOut:
            break
        }
        persistSceneNavigation()
    }

    private func persistSceneNavigation() {
        guard coordinator.restorationComplete, let persistenceSceneID else { return }
        persistedNavigationSnapshot = coordinator.navigation.encodedSnapshot() ?? ""
        persistedNavigationSubject = coordinator.snapshotOwnerSubjectID ?? ""
        HQNavigationPersistenceStore.save(
            .init(
                snapshot: persistedNavigationSnapshot,
                subjectID: coordinator.snapshotOwnerSubjectID
            ),
            sceneID: persistenceSceneID
        )
    }

    @ViewBuilder
    private var navigationPersistenceProbe: some View {
        #if DEBUG
        if case .navigationHarness = launch.state {
            VStack(spacing: 0) {
                Color.clear
                    .frame(width: 1, height: 1)
                    .accessibilityElement()
                    .accessibilityIdentifier("hq.navigation.persisted-snapshot")
                    .accessibilityValue(persistedNavigationSnapshot)
                Color.clear
                    .frame(width: 1, height: 1)
                    .accessibilityElement()
                    .accessibilityIdentifier("hq.navigation.scene-id")
                    .accessibilityValue(persistenceSceneID ?? "missing")
            }
        }
        #endif
    }
}

private struct HQPersistedNavigationRecord: Codable, Equatable {
    let snapshot: String
    let subjectID: String?
}

private enum HQNavigationPersistenceStore {
    private static let keyPrefix = "hq.navigation.scene.v1."

    static func load(sceneID: String) -> HQPersistedNavigationRecord? {
        guard let data = UserDefaults.standard.data(forKey: keyPrefix + sceneID),
              let record = try? JSONDecoder().decode(HQPersistedNavigationRecord.self, from: data)
        else { return nil }
        return record
    }

    static func save(_ record: HQPersistedNavigationRecord, sceneID: String) {
        guard let data = try? JSONEncoder().encode(record) else { return }
        UserDefaults.standard.set(data, forKey: keyPrefix + sceneID)
    }

    static func remove(sceneID: String) {
        UserDefaults.standard.removeObject(forKey: keyPrefix + sceneID)
    }

    static func removeRecords(notOwnedBy subjectID: String) {
        for key in UserDefaults.standard.dictionaryRepresentation().keys where key.hasPrefix(keyPrefix) {
            guard let data = UserDefaults.standard.data(forKey: key),
                  let record = try? JSONDecoder().decode(HQPersistedNavigationRecord.self, from: data),
                  record.subjectID == subjectID
            else {
                UserDefaults.standard.removeObject(forKey: key)
                continue
            }
        }
    }

    static func removeAll() {
        for key in UserDefaults.standard.dictionaryRepresentation().keys where key.hasPrefix(keyPrefix) {
            UserDefaults.standard.removeObject(forKey: key)
        }
    }
}

private struct HQSceneIdentifierReader: UIViewRepresentable {
    let onResolve: @MainActor (String) -> Void

    func makeUIView(context: Context) -> SceneView {
        SceneView(onResolve: onResolve)
    }

    func updateUIView(_ view: SceneView, context: Context) {
        view.onResolve = onResolve
        view.resolveIfPossible()
    }

    @MainActor
    final class SceneView: UIView {
        var onResolve: @MainActor (String) -> Void

        init(onResolve: @escaping @MainActor (String) -> Void) {
            self.onResolve = onResolve
            super.init(frame: .zero)
            isAccessibilityElement = false
        }

        @available(*, unavailable)
        required init?(coder: NSCoder) { nil }

        override func didMoveToWindow() {
            super.didMoveToWindow()
            resolveIfPossible()
        }

        func resolveIfPossible() {
            guard let identifier = window?.windowScene?.session.persistentIdentifier else { return }
            // UIKit can call this while SwiftUI is reconciling the representable.
            // Defer the published scene/navigation update to the next main-actor
            // turn rather than mutating state from within that view update.
            Task { @MainActor [weak self] in
                await Task.yield()
                self?.onResolve(identifier)
            }
        }
    }
}

struct HQLaunchConfiguration: Equatable {
    enum State: Equatable {
        case signedOut
        case testHarness
        case authHarness(String)
        case fixtureVisualTour
        case fixtureLeakBlocked
        case navigationHarness(HQShellPresentationState)
    }

    static let oauthRedirectURI = "hqmobile://auth"

    #if DEBUG
    static let buildAllowsTestHarness = true
    #else
    static let buildAllowsTestHarness = false
    #endif

    let state: State

    static var current: HQLaunchConfiguration {
        resolve(arguments: ProcessInfo.processInfo.arguments, environment: ProcessInfo.processInfo.environment)
    }

    static func resolve(
        arguments: [String],
        environment: [String: String],
        buildAllowsTestHarness: Bool = Self.buildAllowsTestHarness
    ) -> HQLaunchConfiguration {
        let fixtureRequested = environment["HQIOS_USE_FIXTURES"] == "1"
        let testHarnessRequested = arguments.contains("--hq-test-harness")
        let authHarnessRequested = arguments.contains("--hq-auth-harness")
        let navigationHarnessRequested = arguments.contains("--hq-navigation-harness")
        // UI tests launch the app in a distinct process and do not propagate
        // XCTestConfigurationFilePath. The explicit marker is set only by the
        // checked-in test plan and XCUIApplication harness; a fixture flag by
        // itself always renders the fail-closed screen.
        // The runtime marker is intentionally insufficient on its own. Release
        // compiles this gate to false, so leaked process arguments/environment
        // can never authorize fixture rendering in a distributable build.
        let testHarnessAuthorized = buildAllowsTestHarness && environment["HQIOS_TEST_HARNESS"] == "1"
        let fixtureAllowed = testHarnessRequested && testHarnessAuthorized

        if fixtureRequested && !fixtureAllowed {
            return HQLaunchConfiguration(state: .fixtureLeakBlocked)
        }
        if fixtureRequested {
            return HQLaunchConfiguration(state: .fixtureVisualTour)
        }
        if authHarnessRequested && testHarnessAuthorized {
            return HQLaunchConfiguration(state: .authHarness(environment["HQIOS_AUTH_HARNESS_SCENARIO"] ?? "recoverable"))
        }
        if navigationHarnessRequested && testHarnessAuthorized {
            let requestedState = HQShellPresentationState(rawValue: environment["HQIOS_SHELL_STATE"] ?? "content") ?? .content
            return HQLaunchConfiguration(state: .navigationHarness(requestedState))
        }
        if testHarnessRequested && testHarnessAuthorized {
            return HQLaunchConfiguration(state: .testHarness)
        }
        return HQLaunchConfiguration(state: .signedOut)
    }
}

@MainActor
final class HQShellPresentationStore: ObservableObject {
    @Published private(set) var state: HQShellPresentationState = .loading

    func apply(
        configuration: HQRouteResult<HQMobileConfiguration>,
        membership: HQRouteResult<HQMembershipResponse>
    ) {
        state = .bootstrap(configuration: configuration, membership: membership)
    }

    func apply(error: Error) {
        state = .failure(for: error)
    }

    func reset() {
        state = .loading
    }
}

private struct HQLaunchRoot: View {
    let launch: HQLaunchConfiguration
    @ObservedObject var session: HQSessionController
    @ObservedObject var realtimeOwner: HQAppRealtimeOwner
    @ObservedObject var navigation: HQNavigationModel
    @ObservedObject var shellPresentation: HQShellPresentationStore
    @Environment(\.scenePhase) private var scenePhase
    @State private var sceneID = UUID()

    var body: some View {
        Group {
            switch launch.state {
        case .signedOut:
            if case .signedIn = session.state {
                authenticatedScreen()
            } else if case .restoring = session.state {
                HQAdaptiveShell(navigation: navigation, presentationState: .loading)
            } else {
                signedOutScreen
            }
        case .testHarness:
            launchScreen(
                title: "HQ test harness",
                detail: "Deterministic signed-out test state.",
                identifier: "hq.screen.test-harness.ready"
            )
        case let .authHarness(scenario):
            #if DEBUG
            HQAuthDeterministicHarness(scenario: scenario)
            #else
            launchScreen(title: "Test configuration blocked", detail: "Authentication test state is unavailable in this build.", identifier: "hq.screen.test-configuration-blocked.ready")
            #endif
        case .fixtureVisualTour:
            launchScreen(
                title: "HQ fixture visual tour",
                detail: "Fixtures are available only inside XCTest.",
                identifier: "hq.screen.fixture-tour.ready"
            )
        case .fixtureLeakBlocked:
            launchScreen(
                title: "Fixture configuration blocked",
                detail: "Fixture data cannot render outside the test harness.",
                identifier: "hq.screen.fixture-leak-blocked.ready"
            )
        case let .navigationHarness(state):
            #if DEBUG
            HQAdaptiveShell(navigation: navigation, presentationState: state)
            #else
            launchScreen(title: "Test configuration blocked", detail: "Navigation test state is unavailable in this build.", identifier: "hq.screen.test-configuration-blocked.ready")
            #endif
            }
        }
        .task {
            realtimeOwner.sessionChanged(subjectID: signedInSubjectID)
            realtimeOwner.sceneChanged(sceneID, phase: scenePhase)
        }
        .onChange(of: session.state) { _, _ in
            realtimeOwner.sessionChanged(subjectID: signedInSubjectID)
        }
        .onChange(of: scenePhase) { _, phase in
            realtimeOwner.sceneChanged(sceneID, phase: phase)
        }
        .onDisappear {
            realtimeOwner.sceneRemoved(sceneID)
        }
    }

    private var signedInSubjectID: String? {
        guard launch.state == .signedOut,
              case let .signedIn(subjectID) = session.state
        else { return nil }
        return subjectID
    }

    private var signedOutScreen: some View {
        VStack(spacing: 16) {
            Image(systemName: "square.stack.3d.up.fill")
                .font(.system(size: 44))
                .foregroundStyle(.indigo)
            Text("Sign in to HQ")
                .font(.title.bold())
            Text(sessionMessage ?? "Your secure HQ workspace is ready.")
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .accessibilityIdentifier("hq.auth.status")
            Button("Sign in securely") {
                Task { await session.signIn() }
            }
            .buttonStyle(.borderedProminent)
            .disabled(!session.canStartSignIn)
            .accessibilityIdentifier("hq.auth.sign-in")
            if session.isAuthenticationBusy {
                ProgressView()
                    .accessibilityIdentifier("hq.auth.progress")
            }
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(uiColor: .systemBackground))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("window.sign-in")
        .overlay {
            Color.clear
                .frame(width: 1, height: 1)
                .accessibilityElement()
                .accessibilityIdentifier("hq.screen.signed-out.ready")
            Color.clear
                .frame(width: 1, height: 1)
                .accessibilityElement()
                .accessibilityIdentifier("window.sign-in.state.content")
        }
    }

    private var sessionMessage: String? {
        switch session.state {
        case let .signedOut(message): message
        case let .reauthenticationRequired(message): message
        case let .securityResetRequired(message): message
        case .restoring: "Restoring your secure session…"
        case .signingIn: "Opening secure sign-in…"
        case .signingOut: "Removing secure session data…"
        case .signedIn: nil
        }
    }

    private func authenticatedScreen() -> some View {
        HQAdaptiveShell(navigation: navigation, presentationState: shellPresentation.state)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        NavigationLink("Network diagnostics") { HQNetworkDiagnosticsView() }
                        Button("Sign out") {
                            // Invalidate the realtime identity synchronously before the
                            // asynchronous token purge/revocation can suspend.
                            realtimeOwner.sessionChanged(subjectID: nil)
                            navigation.reset()
                            Task { await session.signOut() }
                        }
                    } label: {
                        Image(systemName: "person.crop.circle")
                    }
                    .accessibilityIdentifier("hq.account.menu")
                }
            }
            .accessibilityIdentifier("hq.screen.authenticated.ready")
    }

    private func launchScreen(title: String, detail: String, identifier: String) -> some View {
        VStack(spacing: 16) {
            Image(systemName: "square.stack.3d.up.fill")
                .font(.system(size: 44))
                .foregroundStyle(.indigo)
            Text(title)
                .font(.title.bold())
            Text(detail)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(uiColor: .systemBackground))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(identifier)
    }

}

#if DEBUG
/// A presentation-only deterministic harness. It is intentionally not named or
/// reported as auth E2E; live Cognito proof belongs to HQIOSLiveE2E.testplan.
private struct HQAuthDeterministicHarness: View {
    let scenario: String
    @State private var status = ""
    @State private var signedIn = true

    var body: some View {
        VStack(spacing: 16) {
            Color.clear
                .frame(width: 1, height: 1)
                .accessibilityElement()
                .accessibilityIdentifier("hq.screen.auth-harness.ready")
            Image(systemName: signedIn && scenario == "signed-in" ? "checkmark.shield.fill" : "exclamationmark.shield.fill")
                .font(.system(size: 44))
                .foregroundStyle(.indigo)
            Text(signedIn && scenario == "signed-in" ? "Signed in to HQ" : "Sign in to HQ")
                .font(.title.bold())
            Text(message)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .accessibilityIdentifier("hq.auth.harness.status")
            if scenario == "signed-in" && signedIn {
                Button("Sign out") { signedIn = false; status = "Signed out securely on this device." }
                    .buttonStyle(.bordered)
                    .accessibilityIdentifier("hq.auth.harness.sign-out")
            } else {
                Button("Try sign-in again") { status = "Ready to retry secure sign-in." }
                    .buttonStyle(.borderedProminent)
                    .accessibilityIdentifier("hq.auth.harness.retry")
            }
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(uiColor: .systemBackground))
    }

    private var message: String {
        if !status.isEmpty { return status }
        if scenario == "signed-in" { return "This deterministic test session can be removed locally." }
        return "Secure sign-in could not connect. No credentials were stored."
    }
}
#endif
