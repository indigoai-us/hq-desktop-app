import SwiftUI
import UIKit

enum HQAdaptiveNavigationStyle: Equatable, Sendable {
    case tabs
    case split

    static func resolve(userInterfaceIdiom: UIUserInterfaceIdiom) -> Self {
        userInterfaceIdiom == .pad ? .split : .tabs
    }
}

enum HQShellPresentationState: String, Equatable, Sendable {
    case content
    case onboarding
    case signIn
    case loading
    case offline
    case accessDenied
    case capabilityUnavailable

    var windowIdentifier: String {
        switch self {
        case .onboarding: "window.onboarding"
        case .signIn: "window.sign-in"
        default: "window.main"
        }
    }

    var readinessState: String {
        switch self {
        case .content, .onboarding, .signIn: "content"
        case .loading: "loading"
        case .offline, .accessDenied: "error"
        case .capabilityUnavailable: "unavailable"
        }
    }

    /// Bootstrap has only two verified response contracts. Unknown or
    /// unverified states must not be rendered as usable HQ content.
    static func bootstrap(
        configuration: HQRouteResult<HQMobileConfiguration>,
        membership: HQRouteResult<HQMembershipResponse>
    ) -> Self {
        switch membership {
        case let .content(response):
            if response.memberships.contains(where: { $0.status == .active }) {
                switch configuration {
                case .content: return .content
                case .degraded, .unavailable: return .capabilityUnavailable
                }
            }
            if response.memberships.contains(where: { $0.status == .invited }) || response.memberships.isEmpty {
                return .onboarding
            }
            if response.memberships.contains(where: { $0.status == .suspended || $0.status == .revoked }) {
                return .accessDenied
            }
            return .capabilityUnavailable
        case .degraded, .unavailable:
            return .capabilityUnavailable
        }
    }

    static func failure(for error: Error) -> Self {
        if case let HQAPIClientError.server(envelope) = error,
           [401, 403].contains(envelope.statusCode) {
            return .accessDenied
        }
        if error is URLError || error as? HQHTTPTransportError == .transportFailure {
            return .offline
        }
        return .capabilityUnavailable
    }
}

struct HQAdaptiveShell: View {
    @ObservedObject var navigation: HQNavigationModel
    let presentationState: HQShellPresentationState
    let recoveryAction: (() -> Void)?

    init(
        navigation: HQNavigationModel,
        presentationState: HQShellPresentationState,
        recoveryAction: (() -> Void)? = nil
    ) {
        self.navigation = navigation
        self.presentationState = presentationState
        self.recoveryAction = recoveryAction
    }

    var body: some View {
        Group {
            if presentationState == .content {
                if HQAdaptiveNavigationStyle.resolve(userInterfaceIdiom: UIDevice.current.userInterfaceIdiom) == .tabs {
                    phoneShell
                } else {
                    padShell
                }
            } else {
                HQShellStateView(state: presentationState, recoveryAction: recoveryAction)
            }
        }
        .accessibilityIdentifier("hq.shell.ready")
        .background(alignment: .topLeading) {
            HQNavigationKeyCommandBridge(navigation: navigation)
                .frame(width: 1, height: 1)
        }
        .overlay(alignment: .topLeading) {
            VStack(spacing: 0) {
                Color.clear
                    .frame(width: 1, height: 1)
                    .accessibilityElement()
                    .accessibilityIdentifier(presentationState.windowIdentifier)
                Color.clear
                    .frame(width: 1, height: 1)
                    .accessibilityElement()
                    .accessibilityIdentifier("\(presentationState.windowIdentifier).state.\(presentationState.readinessState)")
                Color.clear
                    .frame(width: 1, height: 1)
                    .accessibilityElement()
                    .accessibilityIdentifier("hq.condition.\(presentationState.rawValue)")
                if presentationState == .content {
                    Color.clear
                        .frame(width: 1, height: 1)
                        .accessibilityElement()
                        .accessibilityIdentifier(
                            HQAdaptiveNavigationStyle.resolve(userInterfaceIdiom: UIDevice.current.userInterfaceIdiom) == .split
                                ? "hq.shell.pad.ready"
                                : "hq.shell.phone.ready"
                        )
                }
            }
        }
    }

    private var phoneShell: some View {
        TabView(selection: navigation.tabBinding()) {
            ForEach(HQNavigationTab.allCases, id: \.self) { tab in
                HQTabStack(tab: tab, navigation: navigation)
                    .tabItem { Label(tab.title, systemImage: tab.symbolName) }
                    .tag(tab)
                    .accessibilityIdentifier("hq.tab.\(tab.rawValue)")
            }
        }
        .accessibilityIdentifier("hq.shell.phone.ready")
    }

    private var padShell: some View {
        NavigationSplitView(columnVisibility: $navigation.splitViewVisibility) {
            HQSidebar(navigation: navigation)
                .navigationSplitViewColumnWidth(min: 240, ideal: 280, max: 360)
        } detail: {
            HQPadTabStack(tab: navigation.selectedTab, navigation: navigation)
                .id(navigation.selectedTab)
                .inspector(isPresented: navigation.inspectorBinding()) {
                    HQInspector(navigation: navigation)
                        .inspectorColumnWidth(min: 220, ideal: 280, max: 340)
                }
        }
        .navigationSplitViewStyle(.balanced)
        .accessibilityIdentifier("hq.shell.pad.ready")
    }
}

private struct HQNavigationKeyCommandBridge: UIViewRepresentable {
    let navigation: HQNavigationModel

    func makeUIView(context: Context) -> KeyCommandView {
        let view = KeyCommandView()
        view.onBack = { navigation.pop() }
        #if DEBUG
        view.isAccessibilityElement = true
        view.accessibilityIdentifier = "hq.navigation.key-command-responder"
        #else
        view.isAccessibilityElement = false
        #endif
        return view
    }

    func updateUIView(_ view: KeyCommandView, context: Context) {
        view.onBack = { navigation.pop() }
        view.claimFirstResponder()
    }

    @MainActor
    final class KeyCommandView: UIView {
        var onBack: (() -> Void)?
        private var observingActivation = false

        override var canBecomeFirstResponder: Bool { true }

        override var keyCommands: [UIKeyCommand]? {
            [
                backCommand(input: "[", title: "Back"),
                backCommand(input: UIKeyCommand.inputLeftArrow, title: "Back"),
            ]
        }

        override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
            let handled = presses.contains { press in
                guard let key = press.key, key.modifierFlags.contains(.command) else { return false }
                return key.charactersIgnoringModifiers == "[" || key.keyCode == .keyboardLeftArrow
            }
            guard handled else {
                super.pressesBegan(presses, with: event)
                return
            }
            #if DEBUG
            accessibilityValue = "handled:true;first:\(isFirstResponder)"
            #endif
            onBack?()
        }

        override func didMoveToWindow() {
            super.didMoveToWindow()
            if window == nil {
                stopObservingActivation()
            } else {
                startObservingActivation()
                claimFirstResponder()
            }
        }

        func claimFirstResponder() {
            guard window != nil else { return }
            Task { @MainActor [weak self] in
                await Task.yield()
                guard let self else { return }
                let claimed = becomeFirstResponder()
                #if DEBUG
                accessibilityValue = "claimed:\(claimed);first:\(isFirstResponder)"
                #endif
            }
        }

        @objc private func handleBackCommand() {
            onBack?()
        }

        @objc private func applicationDidBecomeActive() {
            claimFirstResponder()
        }

        private func backCommand(input: String, title: String) -> UIKeyCommand {
            let command = UIKeyCommand(
                title: title,
                action: #selector(handleBackCommand),
                input: input,
                modifierFlags: .command
            )
            command.wantsPriorityOverSystemBehavior = true
            return command
        }

        private func startObservingActivation() {
            guard !observingActivation else { return }
            NotificationCenter.default.addObserver(
                self,
                selector: #selector(applicationDidBecomeActive),
                name: UIApplication.didBecomeActiveNotification,
                object: nil
            )
            observingActivation = true
        }

        private func stopObservingActivation() {
            guard observingActivation else { return }
            NotificationCenter.default.removeObserver(
                self,
                name: UIApplication.didBecomeActiveNotification,
                object: nil
            )
            observingActivation = false
        }

        deinit {
            NotificationCenter.default.removeObserver(self)
        }
    }
}

/// A split-view detail can be constructed after its model path is already
/// populated by a cold link or a sidebar-container change. On iPadOS, handing
/// that nonempty computed binding to a newly created NavigationStack can leave
/// the stack visually at its root. Keep only the stack's presentation binding
/// locally, then reconcile it after the detail exists; the model remains the
/// durable owner and receives every native pop immediately.
private struct HQPadTabStack: View {
    let tab: HQNavigationTab
    @ObservedObject var navigation: HQNavigationModel
    @Environment(\.scenePhase) private var scenePhase
    @State private var presentedPath: [HQRoute] = []
    @State private var stackIdentity: UInt64 = 0
    @State private var appliedRevision: UInt64?

    var body: some View {
        NavigationStack(path: $presentedPath) {
            HQRouteDestination(route: tab.rootRoute, navigation: navigation)
                .navigationDestination(for: HQRoute.self) { route in
                    HQRouteDestination(route: route, navigation: navigation)
                }
        }
        .id(stackIdentity)
        .onReceive(navigation.$presentationRevision) { revision in
            // Unlike a view task, this subscription is not cancelled when the
            // system briefly changes scene activity while opening a URL.
            scheduleReconciliation(revision: revision)
        }
        .onChange(of: scenePhase, initial: true) { _, phase in
            guard phase == .active else { return }
            scheduleReconciliation(revision: navigation.presentationRevision)
        }
        .onChange(of: presentedPath) { _, path in
            guard navigation.path(for: tab) != path else { return }
            navigation.pathBinding(for: tab).wrappedValue = path
        }
    }

    private func scheduleReconciliation(revision: UInt64) {
        Task { @MainActor in
            await Task.yield()
            guard scenePhase == .active else { return }
            let modelPath = navigation.path(for: tab)
            guard appliedRevision != revision || presentedPath != modelPath else { return }
            if presentedPath != modelPath {
                var transaction = Transaction(animation: nil)
                transaction.disablesAnimations = true
                withTransaction(transaction) {
                    presentedPath = modelPath
                }
            }
            appliedRevision = revision
            // The split view can retain its UIKit detail controller even after
            // the bound SwiftUI path is correct. Recreate only that stack, and
            // only after the complete local path is installed.
            await Task.yield()
            stackIdentity &+= 1
        }
    }
}

private struct HQTabStack: View {
    let tab: HQNavigationTab
    @ObservedObject var navigation: HQNavigationModel

    var body: some View {
        NavigationStack(path: navigation.pathBinding(for: tab)) {
            HQRouteDestination(route: tab.rootRoute, navigation: navigation)
                .navigationDestination(for: HQRoute.self) { route in
                    HQRouteDestination(route: route, navigation: navigation)
                }
        }
    }
}

private struct HQSidebar: View {
    @ObservedObject var navigation: HQNavigationModel

    var body: some View {
        List {
            Section("HQ") {
                ForEach(HQNavigationTab.allCases, id: \.self) { tab in
                    Button {
                        navigation.select(tab: tab)
                    } label: {
                        Label(tab.title, systemImage: tab.symbolName)
                    }
                    .accessibilityIdentifier("hq.sidebar.container.\(tab.rawValue)")
                    .accessibilityAddTraits(navigation.selectedTab == tab ? .isSelected : [])
                }
            }
        }
        .navigationTitle("HQ")
        .accessibilityIdentifier("hq.shell.sidebar.ready")
    }
}

private struct HQInspector: View {
    @ObservedObject var navigation: HQNavigationModel

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if navigation.inspectorPresented, let route = navigation.inspectorRoute {
                Text("Inspector")
                    .font(.headline)
                Text(route.displayName)
                    .foregroundStyle(.secondary)
                Button("Close inspector") { navigation.presentInspector(for: nil) }
            } else {
                ContentUnavailableView("No inspector", systemImage: "sidebar.right")
            }
        }
        .padding()
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("hq.shell.inspector.ready")
        .accessibilityValue(navigation.inspectorRoute?.canonicalString ?? "")
    }
}

private struct HQRouteDestination: View {
    let route: HQRoute
    @ObservedObject var navigation: HQNavigationModel

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 16) {
                Text(route.displayName)
                    .font(.title.bold())
                    .accessibilityAddTraits(.isHeader)
                    .id("overview")

                Text(route.canonicalString)
                    .font(.footnote.monospaced())
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)

                HQCapabilityDispositionCard(disposition: route.capabilityDisposition)
                    .id("capability")

                ForEach(1 ... 10, id: \.self) { section in
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Context \(section)")
                            .font(.headline)
                        Text("This section preserves its place when you change tabs, resize a window, or follow another HQ route.")
                            .foregroundStyle(.secondary)
                    }
                    .padding()
                    .frame(maxWidth: .infinity, minHeight: 88, alignment: .leading)
                    .background(.quaternary, in: RoundedRectangle(cornerRadius: 14))
                    .id("section-\(section)")
                }

                Button(navigation.inspectorRoute == route ? "Close inspector" : "Show inspector") {
                    navigation.presentInspector(for: navigation.inspectorRoute == route ? nil : route)
                }
                .buttonStyle(.bordered)
                .accessibilityIdentifier("\(route.readinessIdentifier).inspector")

                Color.clear
                    .frame(height: 1)
                    .accessibilityElement()
                    .accessibilityIdentifier("\(route.readinessIdentifier).state.\(route.capabilityDisposition.isUnavailable ? "unavailable" : "content")")
            }
            .scrollTargetLayout()
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(horizontalSizeClass == .compact ? 16 : 24)
        }
        .scrollPosition(id: navigation.scrollAnchorBinding(for: route), anchor: .top)
        .navigationTitle(route.displayName)
        .accessibilityIdentifier(route.readinessIdentifier)
        .accessibilityValue(route.canonicalString)
        .overlay(alignment: .topLeading) {
            Color.clear
                .frame(width: 1, height: 1)
                .accessibilityElement()
                .accessibilityIdentifier("\(route.readinessIdentifier).scroll-anchor")
                .accessibilityValue(navigation.scrollAnchor(for: route) ?? "overview")
        }
    }

    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
}

private struct HQCapabilityDispositionCard: View {
    let disposition: HQCapabilityDisposition

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(disposition.title, systemImage: disposition.symbolName)
                .font(.headline)
            Text(disposition.detail)
                .foregroundStyle(.secondary)
        }
        .padding()
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary, in: RoundedRectangle(cornerRadius: 16))
        .accessibilityElement(children: .combine)
    }
}

private struct HQShellStateView: View {
    let state: HQShellPresentationState
    let recoveryAction: (() -> Void)?

    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: symbolName)
                .font(.system(size: 44))
                .accessibilityHidden(true)
            Text(title)
                .font(.title.bold())
            Text(detail)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            if state == .offline, let recoveryAction {
                Button("Try again", action: recoveryAction)
                    .buttonStyle(.bordered)
                    .accessibilityIdentifier("window.main.retry")
            }
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(uiColor: .systemBackground))
    }

    private var title: String {
        switch state {
        case .onboarding: "Welcome to HQ"
        case .signIn: "Sign in to HQ"
        case .loading: "Loading HQ"
        case .offline: "You’re offline"
        case .accessDenied: "Access denied"
        case .capabilityUnavailable: "Unavailable on this device"
        case .content: "HQ"
        }
    }

    private var detail: String {
        switch state {
        case .onboarding: "Set up your secure HQ workspace to continue."
        case .signIn: "Use your secure account to open this workspace."
        case .loading: "Restoring your secure session."
        case .offline: "Check your connection, then try again."
        case .accessDenied: "Your account cannot open this destination."
        case .capabilityUnavailable: "This capability needs a supported mobile or cloud service."
        case .content: ""
        }
    }

    private var symbolName: String {
        switch state {
        case .onboarding: "hand.wave"
        case .signIn: "lock.shield"
        case .loading: "arrow.triangle.2.circlepath"
        case .offline: "wifi.slash"
        case .accessDenied: "lock.trianglebadge.exclamationmark"
        case .capabilityUnavailable: "iphone.slash"
        case .content: "square.stack.3d.up"
        }
    }
}

private extension HQCapabilityDisposition {
    var isUnavailable: Bool {
        switch self {
        case .deviceUnavailable, .blockedMissingExternalBackend: true
        default: false
        }
    }

    var title: String {
        switch self {
        case .cloudBackedNative: "Cloud-backed destination"
        case .iosAdapted: "Adapted for iPhone and iPad"
        case .degradedReadOnly: "Read-only on mobile"
        case .deviceUnavailable: "Unavailable on this device"
        case .blockedMissingExternalBackend: "Awaiting an HQ cloud capability"
        case .unknown: "Capability status unavailable"
        }
    }

    var detail: String {
        switch self {
        case .cloudBackedNative: "This route keeps its canonical identity while HQ loads authorized cloud state."
        case .iosAdapted: "This desktop behavior is represented through the matching iOS system capability."
        case .degradedReadOnly: "Mobile can show the available cloud information but cannot perform unsupported local actions."
        case .deviceUnavailable: "This behavior depends on a desktop-only device capability and is not presented as working here."
        case .blockedMissingExternalBackend: "HQ has no verified mobile-safe backend for this route yet, so no local or fixture substitute is shown."
        case .unknown: "The app cannot safely determine this capability’s availability."
        }
    }

    var symbolName: String {
        switch self {
        case .cloudBackedNative: "icloud"
        case .iosAdapted: "iphone"
        case .degradedReadOnly: "eye"
        case .deviceUnavailable: "iphone.slash"
        case .blockedMissingExternalBackend: "exclamationmark.triangle"
        case .unknown: "questionmark.circle"
        }
    }
}
