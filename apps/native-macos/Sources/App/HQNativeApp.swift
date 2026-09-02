import AppKit
import SwiftUI

// MARK: - Application

@main
struct HQNativeApp: App {
    @NSApplicationDelegateAdaptor(HQApplicationDelegate.self)
    private var applicationDelegate
    @StateObject private var store: HQAppStore

    init() {
        let store = HQAppStore.makeDefault()
        store.installNativeNotificationRouting()
        _store = StateObject(wrappedValue: store)
        HQAppLifecycleCoordinator.shared.store = store
    }

    init(store: HQAppStore) {
        store.installNativeNotificationRouting()
        _store = StateObject(wrappedValue: store)
        HQAppLifecycleCoordinator.shared.store = store
    }

    private var mainWindowDescriptor: HQSceneDescriptor {
        let main = HQSceneRegistration.descriptor(for: "main")
        guard store.launchMode.usesFixtures,
              let sceneID = HQLaunchConfiguration.initialScene(),
              let kind = HQSecondaryWindowKind(rawValue: sceneID),
              store.launchMode != .visualTourFixture || kind == .menuBar
        else {
            return main
        }
        return HQSceneRegistration.descriptor(for: kind.rawValue)
    }

    var body: some Scene {
        WindowGroup("HQ", id: "main") {
            HQMainSceneRoot(store: store)
                .tint(HQPalette.ink)
        }
        .defaultSize(
            width: mainWindowDescriptor.width,
            height: mainWindowDescriptor.height
        )
        .windowResizability(.contentMinSize)
        .windowStyle(.hiddenTitleBar)
        .commands {
            CommandGroup(replacing: .newItem) {
                Button("Open HQ Window") {
                    store.dispatch(.showMainWindow)
                }
                .keyboardShortcut("n", modifiers: [.command])
            }

            CommandMenu("Navigate") {
                HQRouteCommand("Home", route: .global(.home), key: "1", store: store)
                HQRouteCommand(
                    "Mission Control",
                    route: .global(.missionControl),
                    key: "2",
                    store: store
                )
                Divider()
                HQRouteCommand("Inbox", route: .global(.inbox), key: "3", store: store)
                HQRouteCommand("Meetings", route: .global(.meetings), key: "4", store: store)
                HQRouteCommand(
                    "Marketplace",
                    route: .global(.marketplace),
                    key: "5",
                    store: store
                )
                HQRouteCommand("Library", route: .library(.skills), key: "6", store: store)
                HQRouteCommand(
                    "Files",
                    route: .files(slug: nil, path: nil),
                    key: "7",
                    store: store
                )
                Divider()
                HQRouteCommand("Settings", route: .settings(.sync), key: ",", store: store)
            }

            CommandMenu("HQ") {
                Button("Sync Now") {
                    store.dispatch(.syncNow)
                }
                .keyboardShortcut("r", modifiers: [.command, .shift])

                Button("Open Command Palette") {
                    store.dispatch(.showCommandPalette)
                }
                .keyboardShortcut("k", modifiers: [.command])
            }
        }

        MenuBarExtra {
            HQSecondarySceneRoot(store: store, kind: .menuBar)
                .frame(
                    width: HQSceneRegistration.descriptor(for: "menubar").width,
                    height: HQSceneRegistration.descriptor(for: "menubar").height
                )
        } label: {
            Image(systemName: store.menuBarSymbolName)
                .accessibilityLabel("HQ")
                .accessibilityValue(store.menuBarAccessibilityValue)
                .id(
                    "\(store.trayState.rawValue)-\(store.menuBarHandoffGeneration)"
                )
                .accessibilityIdentifier("window.menubar.item")
        }
        .menuBarExtraStyle(.window)

        singletonWindow(kind: .onboarding)
        singletonWindow(kind: .signIn)
        singletonWindow(kind: .recovery)
        singletonWindow(kind: .meetings)
        singletonWindow(kind: .meetingPermissions)
        singletonWindow(kind: .directMessageDetail)
        singletonWindow(kind: .shareDetail)
        singletonWindow(kind: .messages)
        singletonWindow(kind: .banner)
        singletonWindow(kind: .widget)
        singletonWindow(kind: .activity)
        singletonWindow(kind: .drift)
        singletonWindow(kind: .newFiles)
        singletonWindow(kind: .notificationHistory)
        singletonWindow(kind: .settings)
    }

    @SceneBuilder
    private func singletonWindow(kind: HQSecondaryWindowKind) -> some Scene {
        let descriptor = HQSceneRegistration.descriptor(for: kind.rawValue)
        Window(descriptor.title, id: descriptor.id) {
            HQSecondarySceneRoot(store: store, kind: kind)
                .tint(HQPalette.ink)
        }
        .defaultSize(width: descriptor.width, height: descriptor.height)
        .windowResizability(.contentMinSize)
    }
}

@MainActor
private final class HQAppLifecycleCoordinator {
    static let shared = HQAppLifecycleCoordinator()
    weak var store: HQAppStore?

    func shutdown() async {
        await store?.shutdown()
    }

    func installNativeNotificationRouting() {
        store?.installNativeNotificationRouting()
    }
}

private actor HQApplicationTerminationGate {
    private var isResolved = false
    private var waiter: CheckedContinuation<Void, Never>?

    func wait() async {
        guard !isResolved else { return }
        await withCheckedContinuation { continuation in
            waiter = continuation
        }
    }

    func resolve() {
        guard !isResolved else { return }
        isResolved = true
        waiter?.resume()
        waiter = nil
    }
}

@MainActor
private final class HQApplicationDelegate: NSObject, NSApplicationDelegate {
    private static let finalTerminationDeadlineNanoseconds: UInt64 =
        12_000_000_000
    private var terminationIsInFlight = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        HQAppLifecycleCoordinator.shared.installNativeNotificationRouting()
    }

    func applicationShouldTerminate(
        _ sender: NSApplication
    ) -> NSApplication.TerminateReply {
        guard !terminationIsInFlight else {
            return .terminateLater
        }
        terminationIsInFlight = true

        Task { @MainActor in
            let gate = HQApplicationTerminationGate()
            let shutdownTask = Task { @MainActor in
                await HQAppLifecycleCoordinator.shared.shutdown()
                await gate.resolve()
            }
            let deadlineTask = Task {
                do {
                    try await Task.sleep(
                        nanoseconds:
                            Self.finalTerminationDeadlineNanoseconds
                    )
                } catch {
                    return
                }
                await gate.resolve()
            }

            await gate.wait()
            shutdownTask.cancel()
            deadlineTask.cancel()
            sender.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }
}

private struct HQRouteCommand: View {
    let title: String
    let route: HQRoute
    let key: KeyEquivalent
    @ObservedObject var store: HQAppStore

    init(
        _ title: String,
        route: HQRoute,
        key: KeyEquivalent,
        store: HQAppStore
    ) {
        self.title = title
        self.route = route
        self.key = key
        self.store = store
    }

    var body: some View {
        Button(title) {
            store.dispatch(.navigate(route))
        }
        .keyboardShortcut(key, modifiers: [.command])
    }
}

enum HQLaunchConfiguration {
    static var initialRoute: HQRoute {
        initialRoute(arguments: CommandLine.arguments)
    }

    static func initialRoute(arguments: [String]) -> HQRoute {
        guard let index = arguments.firstIndex(of: "--route"),
              arguments.indices.contains(index + 1),
              let route = HQRouteParser.parse(arguments[index + 1])
        else {
            return .global(.home)
        }
        return route
    }

    static func initialScene(arguments: [String] = CommandLine.arguments) -> String? {
        argument(after: "--hq-scene", in: arguments)
            ?? argument(after: "--scene", in: arguments)
    }

    static func initialNativeCommand(
        arguments: [String] = CommandLine.arguments
    ) -> HQNativeCommand? {
        initialNativeCommands(arguments: arguments).first
    }

    static func initialNativeCommands(
        arguments: [String] = CommandLine.arguments
    ) -> [HQNativeCommand] {
        arguments.indices.compactMap { index in
            guard arguments[index] == "--native-command",
                  arguments.indices.contains(index + 1)
            else {
                return nil
            }
            return HQNativeCommand(rawValue: arguments[index + 1])
        }
    }

    private static func argument(after flag: String, in arguments: [String]) -> String? {
        guard let index = arguments.firstIndex(of: flag),
              arguments.indices.contains(index + 1)
        else {
            return nil
        }
        return arguments[index + 1]
    }
}

enum HQVisualTourVariant: String, CaseIterable, Equatable, Sendable {
    case light
    case dark
    case lightReduced = "light-reduced"
    case darkReduced = "dark-reduced"

    var colorScheme: ColorScheme {
        switch self {
        case .light, .lightReduced:
            .light
        case .dark, .darkReduced:
            .dark
        }
    }

    var reducesTransparency: Bool {
        self == .lightReduced || self == .darkReduced
    }

    var reducesMotion: Bool {
        reducesTransparency
    }
}

struct HQVisualTourConfiguration: Equatable, Sendable {
    let variant: HQVisualTourVariant?

    var isEnabled: Bool {
        variant != nil
    }

    static func resolve(
        arguments: [String] = CommandLine.arguments,
        launchMode: HQLaunchMode
    ) -> HQVisualTourConfiguration {
        guard launchMode == .visualTourFixture,
              arguments.contains("--visual-tour")
        else {
            return HQVisualTourConfiguration(variant: nil)
        }
        let rawVariant = argument(
            after: "--visual-variant",
            in: arguments
        )
        return HQVisualTourConfiguration(
            variant: rawVariant.flatMap(HQVisualTourVariant.init(rawValue:))
                ?? .light
        )
    }

    private static func argument(
        after flag: String,
        in arguments: [String]
    ) -> String? {
        guard let index = arguments.firstIndex(of: flag),
              arguments.indices.contains(index + 1)
        else {
            return nil
        }
        return arguments[index + 1]
    }
}

struct HQVisualTourSurface: Equatable, Sendable {
    enum Kind: String, Equatable, Sendable {
        case route
        case window
    }

    let kind: Kind
    let parityID: String
    let launchValue: String
    let accessibilityIdentifier: String

    func launchArguments(variant: HQVisualTourVariant) -> [String] {
        var arguments = [
            "-ApplePersistenceIgnoreState",
            "YES",
            "-NSTreatUnknownArgumentsAsOpen",
            "NO",
            "--visual-tour",
            "--visual-variant",
            variant.rawValue,
        ]
        switch kind {
        case .route:
            arguments += ["--route", launchValue]
        case .window where launchValue != "main":
            arguments += ["--hq-scene", launchValue]
        case .window:
            break
        }
        return arguments
    }

    func artifactRelativePath(
        variant: HQVisualTourVariant
    ) -> String {
        let stem = parityID
            .replacingOccurrences(of: "{slug}", with: "indigo")
            .replacingOccurrences(of: "{company}", with: "indigo")
            .replacingOccurrences(of: "{project}", with: "native-macos")
            .replacingOccurrences(of: "{task}", with: "NATIVE-004")
            .replacingOccurrences(of: ":", with: "--")
            .replacingOccurrences(of: "/", with: "-")
        return "apps/native-macos/VisualTour/Artifacts/\(variant.rawValue)/\(kind.rawValue)--\(stem).png"
    }
}

enum HQVisualTourCatalog {
    static let routes: [HQVisualTourSurface] = [
        route("home", "home"),
        route("mission-control", "mission-control"),
        route("inbox", "inbox"),
        route("meetings", "meetings"),
        route("marketplace", "marketplace"),
        route("moderation", "moderation"),
        route("library:skills", "library:skills"),
        route("library:workers", "library:workers"),
        route("library:installed", "library:installed"),
        route("library:profile", "library:profile"),
        route("files", "files:indigo:knowledge/briefs/positioning.md"),
        route("settings:sync", "settings:sync"),
        route("settings:notifications", "settings:notifications"),
        route("settings:widget", "settings:widget"),
        route("settings:updates", "settings:updates"),
        route("settings:general", "settings:general"),
        route("settings:meetings", "settings:meetings"),
        route("company:{slug}:overview", "company:indigo:overview"),
        route("company:{slug}:goals", "company:indigo:goals"),
        route("company:{slug}:projects", "company:indigo:projects"),
        route("company:{slug}:skills", "company:indigo:skills"),
        route("company:{slug}:workers", "company:indigo:workers"),
        route("company:{slug}:knowledge", "company:indigo:knowledge"),
        route("company:{slug}:team", "company:indigo:team"),
        route("company:{slug}:activity", "company:indigo:activity"),
        route("company:{slug}:deployments", "company:indigo:deployments"),
        route("company:{slug}:secrets", "company:indigo:secrets"),
        route("company:{slug}:settings", "company:indigo:settings"),
        route(
            "project:{company}:{project}",
            "project:indigo:native-macos"
        ),
        route(
            "task:{company}:{project}:{task}",
            "task:indigo:native-macos:NATIVE-004"
        ),
    ]

    static let windows: [HQVisualTourSurface] =
        HQSceneRegistration.all.map { descriptor in
            HQVisualTourSurface(
                kind: .window,
                parityID: descriptor.id,
                launchValue: descriptor.id,
                accessibilityIdentifier: windowAccessibilityIdentifier(
                    for: descriptor.id
                )
            )
        }

    private static func route(
        _ parityID: String,
        _ launchValue: String
    ) -> HQVisualTourSurface {
        guard let parsed = HQRouteParser.parse(launchValue) else {
            preconditionFailure(
                "Invalid visual-tour route \(launchValue)"
            )
        }
        return HQVisualTourSurface(
            kind: .route,
            parityID: parityID,
            launchValue: launchValue,
            accessibilityIdentifier: HQScreenAccessibility.identifier(
                for: parsed
            )
        )
    }

    private static func windowAccessibilityIdentifier(
        for sceneID: String
    ) -> String {
        switch sceneID {
        case "main":
            "shell.root"
        case "banner":
            "window.banner.direct-message"
        case "widget":
            "window.widget.expanded"
        default:
            "window.\(sceneID)"
        }
    }
}

private struct HQVisualTourEnvironmentModifier: ViewModifier {
    let configuration: HQVisualTourConfiguration

    @ViewBuilder
    func body(content: Content) -> some View {
        if let variant = configuration.variant {
            content
                .preferredColorScheme(variant.colorScheme)
                .environment(
                    \.hqForcedReduceTransparency,
                    variant.reducesTransparency
                )
                .environment(
                    \.locale,
                    Locale(identifier: "en_US_POSIX")
                )
                .transaction { transaction in
                    if variant.reducesMotion {
                        transaction.disablesAnimations = true
                        transaction.animation = nil
                    }
                }
                .overlay(alignment: .topLeading) {
                    Color.clear
                        .frame(width: 1, height: 1)
                        .accessibilityElement()
                        .accessibilityLabel(
                            "Visual tour \(variant.rawValue)"
                        )
                        .accessibilityIdentifier(
                            "visual-tour.variant.\(variant.rawValue)"
                        )
                }
        } else {
            content
        }
    }
}

// MARK: - Scene roots

private struct HQMainSceneRoot: View {
    @ObservedObject var store: HQAppStore

    private var testingScene: HQSecondaryWindowKind? {
        guard let sceneID = HQLaunchConfiguration.initialScene(),
              sceneID != "main"
        else {
            return nil
        }
        if store.launchMode == .visualTourFixture {
            guard sceneID == HQSecondaryWindowKind.menuBar.rawValue else {
                return nil
            }
        } else {
            guard store.launchMode == .uiTestingFixture else {
                return nil
            }
        }
        return HQSecondaryWindowKind(rawValue: sceneID)
    }

    private var visualTourConfiguration: HQVisualTourConfiguration {
        HQVisualTourConfiguration.resolve(
            launchMode: store.launchMode
        )
    }

    var body: some View {
        let testingScene = testingScene
        Group {
            if let testingScene {
                HQSecondarySceneContent(store: store, kind: testingScene)
            } else {
                HQShellView(store: store)
            }
        }
        .frame(
            minWidth: testingScene == nil ? 960 : nil,
            minHeight: testingScene == nil ? 640 : nil
        )
        .frame(
            width: testingScene?.usesCompactWindowPresentation == true
                ? HQSceneRegistration.descriptor(
                    for: testingScene?.rawValue ?? "main"
                ).width
                : nil,
            height: testingScene?.usesCompactWindowPresentation == true
                ? HQSceneRegistration.descriptor(
                    for: testingScene?.rawValue ?? "main"
                ).height
                : nil
        )
        .background {
            if let testingScene,
               testingScene.usesCompactWindowPresentation
            {
                HQCompactWindowConfiguration(kind: testingScene)
            }
        }
        .environment(
            \.hqAppActionDispatcher,
            HQAppActionDispatcher { [weak store] action in
                guard let store else {
                    preconditionFailure("HQAppStore was released while a scene was active.")
                }
                store.dispatch(action)
            }
        )
        .environment(
            \.hqAppCapabilities,
            HQAppCapabilities(
                available: store.capabilities,
                permitsFixtureActions: store.launchMode.usesFixtures
            )
        )
        .modifier(HQSceneRequestBridge(store: store))
        .modifier(
            HQVisualTourEnvironmentModifier(
                configuration: visualTourConfiguration
            )
        )
        .task {
            await store.startAndApplyLaunchArguments()
            await store.perform(.sceneReady("main"))
        }
    }
}

private struct HQSecondarySceneRoot: View {
    @ObservedObject var store: HQAppStore
    let kind: HQSecondaryWindowKind

    private var visualTourConfiguration: HQVisualTourConfiguration {
        HQVisualTourConfiguration.resolve(
            launchMode: store.launchMode
        )
    }

    var body: some View {
        HQSecondarySceneContent(store: store, kind: kind)
            .frame(
                width: kind.usesStandaloneCompactWindowPresentation
                    ? HQSceneRegistration.descriptor(for: kind.rawValue).width
                    : nil,
                height: kind.usesStandaloneCompactWindowPresentation
                    ? HQSceneRegistration.descriptor(for: kind.rawValue).height
                    : nil
            )
            .background {
                if kind.usesStandaloneCompactWindowPresentation {
                    HQCompactWindowConfiguration(kind: kind)
                }
            }
            .environment(
                \.hqAppActionDispatcher,
                HQAppActionDispatcher { [weak store] action in
                    guard let store else {
                        preconditionFailure(
                            "HQAppStore was released while a scene was active."
                        )
                    }
                    store.dispatch(action)
                }
            )
            .environment(
                \.hqAppCapabilities,
                HQAppCapabilities(
                    available: store.capabilities,
                    permitsFixtureActions: store.launchMode.usesFixtures
                )
            )
            .modifier(HQSceneRequestBridge(store: store))
            .modifier(
                HQVisualTourEnvironmentModifier(
                    configuration: visualTourConfiguration
                )
            )
            .task {
                await store.start()
                await store.perform(.sceneReady(kind.rawValue))
                if kind == .menuBar {
                    store.emitNativeParityEvent(.popoverOpened)
                }
                if kind == .meetings {
                    store.emitNativeParityEvent(
                        .meetingsWindowRequestSnapshot
                    )
                    await store.perform(
                        .nativeCommand(.meetingsTakePendingFocus)
                    )
                }
            }
    }
}

private struct HQSecondarySceneContent: View {
    @ObservedObject var store: HQAppStore
    let kind: HQSecondaryWindowKind

    var body: some View {
        let state = store.windowState(for: kind)
        let bannerFixture = store.bannerWindowFixture()
        let renderedBannerPayload = store.activeBannerPayload
        ZStack(alignment: .bottom) {
            HQSecondaryWindowView(
                kind: kind,
                state: state,
                messagesFixture: store.messagesWindowFixture(),
                bannerFixture: bannerFixture,
                widgetFixture: store.widgetWindowFixture(),
                onDirectMessageReply: { body in
                    store.dispatch(.replyToDirectMessage(body))
                },
                onMessageSelect: { request in
                    store.dispatch(.selectMessageConversation(request))
                },
                onMessageSend: { request in
                    store.dispatch(.sendMessage(request))
                },
                onWidgetModeChange: { mode in
                    store.dispatch(
                        .nativeCommand(
                            .applyWidgetSettings,
                            payload: .object([
                                "mode": .string(mode.rawValue),
                            ])
                        )
                    )
                }
            ) { actionID in
                if kind == .banner,
                   actionID.hasSuffix(".open"),
                   let renderedBannerPayload
                {
                    store.dispatch(.activateBanner(renderedBannerPayload))
                } else {
                    store.dispatch(
                        .secondaryWindow(kind: kind, actionID: actionID)
                    )
                }
            }

            if store.launchMode != .visualTourFixture {
                HQOperationBanner(state: store.operationState)
                    .padding(12)
            }
        }
        .background(
            kind.usesCompactWindowPresentation
                ? Color.clear
                : Color(nsColor: .windowBackgroundColor)
        )
        .modifier(HQSecondarySceneAccessibilityModifier(kind: kind))
        .modifier(HQNativeWindowEventProducer(store: store, kind: kind))
    }
}

private extension HQSecondaryWindowKind {
    var usesCompactWindowPresentation: Bool {
        self == .menuBar || usesStandaloneCompactWindowPresentation
    }

    var usesStandaloneCompactWindowPresentation: Bool {
        self == .banner || self == .widget
    }
}

private struct HQCompactWindowConfiguration: NSViewRepresentable {
    let kind: HQSecondaryWindowKind

    func makeNSView(context: Context) -> HQCompactWindowConfigurationView {
        HQCompactWindowConfigurationView(kind: kind)
    }

    func updateNSView(
        _ nsView: HQCompactWindowConfigurationView,
        context: Context
    ) {
        nsView.kind = kind
        nsView.applyConfiguration()
    }
}

@MainActor
private final class HQCompactWindowConfigurationView: NSView {
    var kind: HQSecondaryWindowKind

    init(kind: HQSecondaryWindowKind) {
        self.kind = kind
        super.init(frame: .zero)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        nil
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        applyConfiguration()
    }

    func applyConfiguration() {
        guard let window else { return }
        let descriptor = HQSceneRegistration.descriptor(for: kind.rawValue)
        let size = NSSize(width: descriptor.width, height: descriptor.height)

        if kind.usesStandaloneCompactWindowPresentation {
            window.styleMask = .borderless
        } else {
            window.styleMask.remove(.resizable)
            window.titlebarAppearsTransparent = true
        }
        window.titleVisibility = .hidden
        window.contentMinSize = size
        window.contentMaxSize = size
        if window.contentView?.bounds.size != size {
            window.setContentSize(size)
        }
        window.isMovableByWindowBackground = true
        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = true

        for button in [
            NSWindow.ButtonType.closeButton,
            .miniaturizeButton,
            .zoomButton,
        ] {
            window.standardWindowButton(button)?.isHidden = true
        }

        if kind.usesStandaloneCompactWindowPresentation {
            window.level = .floating
            window.collectionBehavior.formUnion([
                .canJoinAllSpaces,
                .fullScreenAuxiliary,
            ])
        }
    }
}

private struct HQSecondarySceneAccessibilityModifier: ViewModifier {
    let kind: HQSecondaryWindowKind

    @ViewBuilder
    func body(content: Content) -> some View {
        if kind == .menuBar || kind == .banner || kind == .widget {
            content.overlay(alignment: .topLeading) {
                Color.clear
                    .frame(width: 1, height: 1)
                    .accessibilityElement()
                    .accessibilityLabel("\(kind.rawValue) scene")
                    .accessibilityIdentifier("scene.\(kind.rawValue)")
            }
        } else {
            content
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("scene.\(kind.rawValue)")
        }
    }
}

private struct HQNativeWindowEventProducer: ViewModifier {
    @ObservedObject var store: HQAppStore
    let kind: HQSecondaryWindowKind

    func body(content: Content) -> some View {
        content
            .onChange(of: store.isBannerPresented) { presented in
                if kind == .banner {
                    store.dispatch(
                        .nativeEvent(
                            .bannerEvent,
                            data: .object(["presented": .bool(presented)])
                        )
                    )
                }
                if kind == .widget, presented {
                    store.dispatch(
                        .nativeEvent(
                            .widgetNotification,
                            data: .object([
                                "bannerKind": .string(
                                    store.activeBannerKind.rawValue
                                ),
                            ])
                        )
                    )
                }
            }
            .onReceive(
                NotificationCenter.default.publisher(
                    for: NSWindow.didResignKeyNotification
                )
            ) { notification in
                guard kind == .widget,
                      let window = notification.object as? NSWindow,
                      window.title
                        == HQSceneRegistration.descriptor(for: "widget").title
                else {
                    return
                }
                store.dispatch(
                    .nativeEvent(
                        .widgetClickAway,
                        data: .object(["windowNumber": .number(Double(window.windowNumber))])
                    )
                )
            }
            .onReceive(
                NotificationCenter.default.publisher(
                    for: NSWindow.didChangeOcclusionStateNotification
                )
            ) { notification in
                guard kind == .widget,
                      let window = notification.object as? NSWindow,
                      window.title
                        == HQSceneRegistration.descriptor(for: "widget").title
                else {
                    return
                }
                store.dispatch(
                    .nativeEvent(
                        .widgetOcclusion,
                        data: .object([
                            "occluded": .bool(
                                !window.occlusionState.contains(.visible)
                            ),
                        ])
                    )
                )
            }
    }
}

private struct HQSceneRequestBridge: ViewModifier {
    @ObservedObject var store: HQAppStore
    @Environment(\.openWindow) private var openWindow

    func body(content: Content) -> some View {
        content
            .onChange(of: store.sceneRequest) { request in
                guard let request, store.consume(request) else { return }
                if request.sceneID == HQSecondaryWindowKind.menuBar.rawValue {
                    NSApplication.shared.activate(ignoringOtherApps: true)
                } else {
                    openWindow(id: request.sceneID)
                    NSApplication.shared.activate(ignoringOtherApps: true)
                }
            }
    }
}

private struct HQOperationBanner: View {
    let state: HQOperationState

    var body: some View {
        switch state {
        case .idle:
            EmptyView()
        case let .busy(message):
            status(message, symbol: "arrow.triangle.2.circlepath", identifier: "busy") {
                ProgressView()
                    .controlSize(.small)
            }
        case let .success(message):
            status(message, symbol: "checkmark.circle", identifier: "success")
        case let .failure(message):
            status(message, symbol: "exclamationmark.triangle", identifier: "error")
        }
    }

    private func status<Trailing: View>(
        _ message: String,
        symbol: String,
        identifier: String,
        @ViewBuilder trailing: () -> Trailing
    ) -> some View {
        HStack(spacing: 9) {
            Image(systemName: symbol)
            Text(message)
                .font(.caption)
                .lineLimit(2)
            trailing()
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(.regularMaterial, in: Capsule())
        .overlay {
            Capsule().stroke(.quaternary, lineWidth: 1)
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("operation.\(identifier)")
    }

    private func status(
        _ message: String,
        symbol: String,
        identifier: String
    ) -> some View {
        status(message, symbol: symbol, identifier: identifier) {
            EmptyView()
        }
    }
}

private struct HQAppActionDispatcher: Sendable {
    let send: @MainActor @Sendable (HQAppAction) -> Void
}

private struct HQAppActionDispatcherKey: EnvironmentKey {
    static let defaultValue = HQAppActionDispatcher { action in
        preconditionFailure(
            "No HQ app action dispatcher was installed for \(String(describing: action))."
        )
    }
}

private extension EnvironmentValues {
    var hqAppActionDispatcher: HQAppActionDispatcher {
        get { self[HQAppActionDispatcherKey.self] }
        set { self[HQAppActionDispatcherKey.self] = newValue }
    }
}

private struct HQAppCapabilities: Sendable {
    let available: Set<String>
    let permitsFixtureActions: Bool

    func supports(_ capability: String) -> Bool {
        permitsFixtureActions || available.contains(capability)
    }
}

private struct HQAppCapabilitiesKey: EnvironmentKey {
    static let defaultValue = HQAppCapabilities(
        available: [],
        permitsFixtureActions: false
    )
}

private extension EnvironmentValues {
    var hqAppCapabilities: HQAppCapabilities {
        get { self[HQAppCapabilitiesKey.self] }
        set { self[HQAppCapabilitiesKey.self] = newValue }
    }
}

private struct HQActionButton<Label: View>: View {
    @Environment(\.hqAppActionDispatcher) private var dispatcher
    @Environment(\.hqAppCapabilities) private var capabilities
    let action: HQAppAction
    let requiredCapability: String?
    @ViewBuilder let label: () -> Label

    init(
        action: HQAppAction,
        requiredCapability: String? = nil,
        @ViewBuilder label: @escaping () -> Label
    ) {
        self.action = action
        self.requiredCapability = requiredCapability
        self.label = label
    }

    var body: some View {
        Button {
            dispatcher.send(action)
        } label: {
            label()
        }
        .disabled(
            requiredCapability.map { !capabilities.supports($0) } ?? false
        )
        .help(
            requiredCapability.flatMap { capability in
                capabilities.supports(capability)
                    ? nil
                    : "Requires the unavailable \(capability) capability."
            } ?? ""
        )
    }
}

private extension HQActionButton where Label == Text {
    init(
        _ title: String,
        action: HQAppAction,
        requiredCapability: String? = nil
    ) {
        self.action = action
        self.requiredCapability = requiredCapability
        label = { Text(title) }
    }

    init(
        _ title: String,
        command: HQEngineAppCommand,
        params: HQJSONValue = .object([:]),
        successMessage: String
    ) {
        action = .engineCommand(
            command,
            params: params,
            successMessage: successMessage
        )
        requiredCapability = command.rawValue
        label = { Text(title) }
    }
}

private struct HQUnavailableButton: View {
    @Environment(\.hqAppActionDispatcher) private var dispatcher
    let title: String
    let reason: String

    var body: some View {
        Button(title) {
            dispatcher.send(.capabilityUnavailable(reason: reason))
        }
        .disabled(true)
        .help(reason)
        .accessibilityValue(reason)
    }
}

enum HQScreenAccessibility {
    static func identifier(for route: HQRoute) -> String {
        switch route {
        case let .global(destination):
            return "screen.\(destination.rawValue)"
        case let .library(section):
            return "screen.library.\(section.rawValue)"
        case .files:
            return "screen.files"
        case let .company(_, section):
            return "screen.company.\(section.rawValue)"
        case let .settings(section):
            return "screen.settings.\(section.rawValue)"
        case .project:
            return "screen.project"
        case .task:
            return "screen.task"
        }
    }
}

// MARK: - Injection-friendly UI data contract

protocol HQShellDataProviding {
    var fixture: HQShellFixture { get }
}

struct HQShellFixture {
    let snapshot: HQSnapshot
    let messages: [HQMessageFixture]
    let meetings: [HQMeetingFixture]
    let packs: [HQPackFixture]
    let libraryItems: [HQLibraryFixture]
    let people: [HQPersonFixture]
    let activity: [HQActivityFixture]
    let files: [HQFileFixture]
    let deployments: [HQDeploymentFixture]
    let secrets: [HQSecretFixture]
}

struct HQMessageFixture: Identifiable, Hashable {
    let id: String
    let person: String
    let initials: String
    let preview: String
    let detail: String
    let time: String
    let unread: Bool
    let kind: String
}

struct HQMeetingFixture: Identifiable, Hashable {
    let id: String
    let title: String
    let time: String
    let duration: String
    let company: String
    let attendees: Int
    let state: String
}

struct HQPackFixture: Identifiable, Hashable {
    let id: String
    let title: String
    let category: String
    let detail: String
    let author: String
    let installs: String
    let installed: Bool
    let symbol: String
}

struct HQLibraryFixture: Identifiable, Hashable {
    let id: String
    let name: String
    let kind: String
    let detail: String
    let scope: String
    let status: String
    let symbol: String
}

struct HQPersonFixture: Identifiable, Hashable {
    let id: String
    let name: String
    let role: String
    let initials: String
    let status: String
    let focus: String
    let sessions: Int
}

struct HQActivityFixture: Identifiable, Hashable {
    let id: String
    let actor: String
    let action: String
    let target: String
    let time: String
    let symbol: String
}

struct HQFileFixture: Identifiable, Hashable {
    let id: String
    let name: String
    let path: String
    let kind: String
    let detail: String
    let modified: String
}

struct HQDeploymentFixture: Identifiable, Hashable {
    let id: String
    let name: String
    let environment: String
    let state: String
    let version: String
    let time: String
}

struct HQSecretFixture: Identifiable, Hashable {
    let id: String
    let name: String
    let environment: String
    let updated: String
    let rotated: String
}

struct HQFixtureDataProvider: HQShellDataProviding {
    let fixture: HQShellFixture = .preview
}

extension HQShellFixture {
    static let preview: HQShellFixture = {
        let tasks = [
            HQTask(
                id: "NATIVE-001",
                title: "Native application foundation",
                detail: "Define the SwiftUI shell, routes, and service boundaries.",
                priority: 1,
                passes: true,
                acceptanceCriteria: ["macOS 13 deployment", "No webviews"],
                dependencies: [],
                state: .complete
            ),
            HQTask(
                id: "NATIVE-002",
                title: "Global navigation",
                detail: "Ship every global and company destination in NavigationSplitView.",
                priority: 1,
                passes: true,
                acceptanceCriteria: ["Keyboard navigation", "Stable deep links"],
                dependencies: ["NATIVE-001"],
                state: .complete
            ),
            HQTask(
                id: "NATIVE-003",
                title: "Liquid Glass system",
                detail: "Use real system glass on macOS 26 with a native material fallback.",
                priority: 1,
                passes: false,
                acceptanceCriteria: ["GlassEffectContainer", "Reduced-transparency fallback"],
                dependencies: ["NATIVE-001"],
                state: .active
            ),
            HQTask(
                id: "NATIVE-004",
                title: "Visual parity verification",
                detail: "Exercise every route, state, and detail surface in the packaged app.",
                priority: 1,
                passes: false,
                acceptanceCriteria: [
                    "Every route has a stable accessibility identifier",
                    "Light and dark appearances verified",
                    "Project and task detail render natively",
                ],
                dependencies: ["NATIVE-002", "NATIVE-003"],
                state: .inProgress
            ),
        ]

        let projects = [
            HQProject(
                id: "native-macos",
                companySlug: "indigo",
                title: "HQ for macOS",
                summary: "A fully native HQ workspace with Liquid Glass and complete parity.",
                status: "In progress",
                branch: "feat/native-macos",
                path: URL(fileURLWithPath: "/HQ/companies/indigo/projects/native-macos"),
                tasks: tasks,
                owner: "Corey Epstein",
                livePhase: "Building visual shell"
            ),
            HQProject(
                id: "creative-ops",
                companySlug: "indigo",
                title: "Creative Operations",
                summary: "Turn winning signals into a repeatable campaign factory.",
                status: "Active",
                branch: "main",
                path: URL(fileURLWithPath: "/HQ/companies/indigo/projects/creative-ops"),
                tasks: Array(tasks.prefix(3)),
                owner: "Parker",
                livePhase: "Validating"
            ),
            HQProject(
                id: "recovery",
                companySlug: "liverecover",
                title: "Recovery Journeys",
                summary: "Improve guided recovery and incident response.",
                status: "Planning",
                branch: nil,
                path: URL(fileURLWithPath: "/HQ/companies/liverecover/projects/recovery"),
                tasks: Array(tasks.prefix(2)),
                owner: "Maya Chen",
                livePhase: nil
            ),
        ]

        let workspaces = [
            HQWorkspace(
                slug: "indigo",
                name: "Indigo",
                path: URL(fileURLWithPath: "/HQ/companies/indigo"),
                kind: "company",
                state: .connected,
                lastSyncedAt: Date()
            ),
            HQWorkspace(
                slug: "liverecover",
                name: "LiveRecover",
                path: URL(fileURLWithPath: "/HQ/companies/liverecover"),
                kind: "company",
                state: .connected,
                lastSyncedAt: Date().addingTimeInterval(-1_020)
            ),
            HQWorkspace(
                slug: "moonflow",
                name: "Moonflow",
                path: URL(fileURLWithPath: "/HQ/companies/moonflow"),
                kind: "company",
                state: .needsConnect,
                lastSyncedAt: nil
            ),
        ]

        let goals = [
            "indigo": [
                HQGoal(
                    id: "goal-1",
                    title: "Ship the native HQ experience",
                    detail: "Replace every webview surface with a coherent Mac-native workflow.",
                    progress: 0.68,
                    owner: "Corey"
                ),
                HQGoal(
                    id: "goal-2",
                    title: "Double creative learning velocity",
                    detail: "Close the loop from signal to experiment within one working day.",
                    progress: 0.43,
                    owner: "Parker"
                ),
            ],
            "liverecover": [
                HQGoal(
                    id: "goal-3",
                    title: "Reduce recovery time",
                    detail: "Make every incident actionable in under ten minutes.",
                    progress: 0.81,
                    owner: "Maya"
                ),
            ],
        ]

        return HQShellFixture(
            snapshot: HQSnapshot(workspaces: workspaces, projects: projects, goals: goals),
            messages: [
                HQMessageFixture(
                    id: "m1",
                    person: "Maya Chen",
                    initials: "MC",
                    preview: "The native shell is ready for the review pass.",
                    detail: "I checked the project and task flows. The remaining edge is permission recovery.",
                    time: "2m",
                    unread: true,
                    kind: "Direct message"
                ),
                HQMessageFixture(
                    id: "m2",
                    person: "Parker",
                    initials: "PK",
                    preview: "Three new creative signals landed in Indigo.",
                    detail: "The strongest pattern is a direct before-and-after proof point. I queued variants.",
                    time: "18m",
                    unread: true,
                    kind: "Agent update"
                ),
                HQMessageFixture(
                    id: "m3",
                    person: "Engineering",
                    initials: "EN",
                    preview: "Shared native-macos/verification.md",
                    detail: "Visual QA matrix, accessibility checks, and signed-runtime notes.",
                    time: "1h",
                    unread: false,
                    kind: "Shared file"
                ),
                HQMessageFixture(
                    id: "m4",
                    person: "Alex Morgan",
                    initials: "AM",
                    preview: "Can you invite me to the company workspace?",
                    detail: "I need access to the goals and knowledge sections for tomorrow.",
                    time: "3h",
                    unread: false,
                    kind: "Request"
                ),
            ],
            meetings: [
                HQMeetingFixture(
                    id: "mtg-1",
                    title: "Indigo product review",
                    time: "10:00 AM",
                    duration: "45 min",
                    company: "Indigo",
                    attendees: 6,
                    state: "Live now"
                ),
                HQMeetingFixture(
                    id: "mtg-2",
                    title: "Creative Operations standup",
                    time: "11:30 AM",
                    duration: "25 min",
                    company: "Indigo",
                    attendees: 4,
                    state: "Bot invited"
                ),
                HQMeetingFixture(
                    id: "mtg-3",
                    title: "Recovery journey planning",
                    time: "2:00 PM",
                    duration: "50 min",
                    company: "LiveRecover",
                    attendees: 8,
                    state: "Upcoming"
                ),
                HQMeetingFixture(
                    id: "mtg-4",
                    title: "Weekly company pulse",
                    time: "4:30 PM",
                    duration: "30 min",
                    company: "Indigo",
                    attendees: 10,
                    state: "Upcoming"
                ),
            ],
            packs: [
                HQPackFixture(
                    id: "pack-parker",
                    title: "Parker Growth",
                    category: "Marketing",
                    detail: "Signal intake, ad ideation, scripts, and creative iteration workflows.",
                    author: "HQ",
                    installs: "2.4k",
                    installed: true,
                    symbol: "sparkles"
                ),
                HQPackFixture(
                    id: "pack-engineering",
                    title: "Engineering",
                    category: "Development",
                    detail: "Planning, TDD, review, release, and production incident workflows.",
                    author: "HQ",
                    installs: "4.8k",
                    installed: true,
                    symbol: "hammer"
                ),
                HQPackFixture(
                    id: "pack-research",
                    title: "Research Desk",
                    category: "Knowledge",
                    detail: "Evidence capture, synthesis, source review, and knowledge freshness.",
                    author: "Maya Chen",
                    installs: "918",
                    installed: false,
                    symbol: "text.magnifyingglass"
                ),
                HQPackFixture(
                    id: "pack-security",
                    title: "Secure Sidecar",
                    category: "Security",
                    detail: "Capability bridges and least-privilege integration patterns.",
                    author: "HQ",
                    installs: "687",
                    installed: false,
                    symbol: "lock.shield"
                ),
            ],
            libraryItems: [
                HQLibraryFixture(
                    id: "lib-1",
                    name: "deep-plan",
                    kind: "Skill",
                    detail: "Turn an ambiguous project into an execution-ready plan.",
                    scope: "Personal",
                    status: "Ready",
                    symbol: "point.3.connected.trianglepath.dotted"
                ),
                HQLibraryFixture(
                    id: "lib-2",
                    name: "execute-task",
                    kind: "Skill",
                    detail: "Execute one PRD story through implementation and verification.",
                    scope: "Indigo",
                    status: "Ready",
                    symbol: "checkmark.circle"
                ),
                HQLibraryFixture(
                    id: "lib-3",
                    name: "Parker",
                    kind: "Worker",
                    detail: "Creative strategist focused on ad learning velocity.",
                    scope: "Indigo",
                    status: "Online",
                    symbol: "person.crop.circle.badge.checkmark"
                ),
                HQLibraryFixture(
                    id: "lib-4",
                    name: "Engineering",
                    kind: "Pack",
                    detail: "The complete HQ engineering workflow collection.",
                    scope: "Global",
                    status: "Update available",
                    symbol: "shippingbox"
                ),
                HQLibraryFixture(
                    id: "lib-5",
                    name: "Corey Epstein",
                    kind: "Creator profile",
                    detail: "Published skills, packs, and organization identity.",
                    scope: "@corey",
                    status: "Verified",
                    symbol: "person.text.rectangle"
                ),
            ],
            people: [
                HQPersonFixture(
                    id: "person-1",
                    name: "Corey Epstein",
                    role: "Owner",
                    initials: "CE",
                    status: "Online",
                    focus: "Native macOS HQ",
                    sessions: 12
                ),
                HQPersonFixture(
                    id: "person-2",
                    name: "Maya Chen",
                    role: "Member",
                    initials: "MC",
                    status: "Online",
                    focus: "Recovery research",
                    sessions: 8
                ),
                HQPersonFixture(
                    id: "person-3",
                    name: "Parker",
                    role: "Agent",
                    initials: "PK",
                    status: "Running",
                    focus: "Creative signal validation",
                    sessions: 36
                ),
                HQPersonFixture(
                    id: "person-4",
                    name: "Engineering",
                    role: "Agent",
                    initials: "EN",
                    status: "Idle",
                    focus: "Waiting for review",
                    sessions: 21
                ),
            ],
            activity: [
                HQActivityFixture(
                    id: "a1",
                    actor: "Corey",
                    action: "completed",
                    target: "NATIVE-002 Global navigation",
                    time: "4m ago",
                    symbol: "checkmark.circle"
                ),
                HQActivityFixture(
                    id: "a2",
                    actor: "Parker",
                    action: "promoted",
                    target: "Proof-led creative pattern",
                    time: "19m ago",
                    symbol: "arrow.up.right.circle"
                ),
                HQActivityFixture(
                    id: "a3",
                    actor: "Maya",
                    action: "updated",
                    target: "Recovery journey brief",
                    time: "47m ago",
                    symbol: "doc.text"
                ),
                HQActivityFixture(
                    id: "a4",
                    actor: "HQ Sync",
                    action: "downloaded",
                    target: "12 company changes",
                    time: "1h ago",
                    symbol: "arrow.down.circle"
                ),
            ],
            files: [
                HQFileFixture(
                    id: "f1",
                    name: "positioning.md",
                    path: "knowledge/briefs/positioning.md",
                    kind: "Markdown",
                    detail: "Indigo is the operating layer that gives a team AI shared memory, clear permissions, and durable workflows.",
                    modified: "12m ago"
                ),
                HQFileFixture(
                    id: "f2",
                    name: "prd.json",
                    path: "projects/native-macos/prd.json",
                    kind: "JSON",
                    detail: "{\n  \"id\": \"native-macos\",\n  \"status\": \"active\",\n  \"stories\": 8\n}",
                    modified: "24m ago"
                ),
                HQFileFixture(
                    id: "f3",
                    name: "README.md",
                    path: "projects/native-macos/README.md",
                    kind: "Markdown",
                    detail: "# HQ for macOS\n\nA first-class Mac application built with SwiftUI and AppKit.",
                    modified: "31m ago"
                ),
                HQFileFixture(
                    id: "f4",
                    name: "company.yaml",
                    path: "settings/company.yaml",
                    kind: "YAML",
                    detail: "name: Indigo\nmode: connected\nsync: realtime",
                    modified: "Yesterday"
                ),
            ],
            deployments: [
                HQDeploymentFixture(
                    id: "d1",
                    name: "hq.computer",
                    environment: "Production",
                    state: "Healthy",
                    version: "2026.07.26.3",
                    time: "16m ago"
                ),
                HQDeploymentFixture(
                    id: "d2",
                    name: "native-preview",
                    environment: "Internal",
                    state: "Building",
                    version: "0.1.0-43",
                    time: "Now"
                ),
                HQDeploymentFixture(
                    id: "d3",
                    name: "api",
                    environment: "Production",
                    state: "Healthy",
                    version: "4.18.2",
                    time: "2h ago"
                ),
            ],
            secrets: [
                HQSecretFixture(
                    id: "s1",
                    name: "OPENAI_API_KEY",
                    environment: "Production",
                    updated: "18 days ago",
                    rotated: "Quarterly"
                ),
                HQSecretFixture(
                    id: "s2",
                    name: "SLACK_BOT_TOKEN",
                    environment: "Production",
                    updated: "4 days ago",
                    rotated: "Monthly"
                ),
                HQSecretFixture(
                    id: "s3",
                    name: "RECALL_API_KEY",
                    environment: "Meetings",
                    updated: "32 days ago",
                    rotated: "Quarterly"
                ),
            ]
        )
    }()
}

// MARK: - Native material and visual system

private enum HQPalette {
    static let ink = Color.primary
    static let subtle = Color.secondary
    static let hairline = Color.primary.opacity(0.10)
    static let selection = Color.primary.opacity(0.075)
    static let active = Color.primary.opacity(0.14)
    static let muted = Color.primary.opacity(0.045)
}

private enum HQSpacing {
    static let page: CGFloat = 28
    static let card: CGFloat = 18
    static let section: CGFloat = 22
    static let radius: CGFloat = 18
}

private struct HQMaterialBackdrop: NSViewRepresentable {
    func makeNSView(context: Context) -> NSVisualEffectView {
        let view = NSVisualEffectView()
        view.material = .underWindowBackground
        view.blendingMode = .behindWindow
        view.state = .active
        view.isEmphasized = false
        return view
    }

    func updateNSView(_ nsView: NSVisualEffectView, context: Context) {
        nsView.state = .active
    }
}

private struct HQGlassCard<Content: View>: View {
    let content: Content

    init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            content
        }
            .padding(HQSpacing.card)
            .frame(maxWidth: .infinity, alignment: .leading)
            .hqAdaptiveGlassSurface()
    }
}

private struct HQPage<Content: View>: View {
    let eyebrow: String
    let title: String
    let subtitle: String
    let identifier: String
    let content: Content

    init(
        eyebrow: String,
        title: String,
        subtitle: String,
        identifier: String,
        @ViewBuilder content: () -> Content
    ) {
        self.eyebrow = eyebrow
        self.title = title
        self.subtitle = subtitle
        self.identifier = identifier
        self.content = content()
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: HQSpacing.section) {
                VStack(alignment: .leading, spacing: 7) {
                    Text(eyebrow.uppercased())
                        .font(.caption.weight(.semibold))
                        .tracking(1.4)
                        .foregroundStyle(.secondary)
                    Text(title)
                        .font(.system(size: 30, weight: .semibold, design: .rounded))
                    Text(subtitle)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                content
            }
            .padding(HQSpacing.page)
            .frame(maxWidth: 1_180, alignment: .leading)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(identifier)
    }
}

private struct HQSectionTitle: View {
    let title: String
    var detail: String?
    var action: String?

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.headline)
                if let detail {
                    Text(detail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer()
            if let action {
                sectionAction(action)
            }
        }
    }

    @ViewBuilder
    private func sectionAction(_ title: String) -> some View {
        Group {
            switch title {
            case "Open messages":
                HQActionButton(title, action: .openScene(.messages))
            case "Refresh":
                HQActionButton(title, action: .refresh)
            case "Check for updates":
                HQActionButton(title, action: .nativeCommand(.checkForUpdates))
            case "Open calendar":
                HQActionButton(title, action: .openScene(.meetings))
            case "Review all":
                HQActionButton(title, action: .navigate(.global(.inbox)))
            case "View projects":
                HQActionButton(title, action: .navigate(.global(.home)))
            default:
                HQUnavailableButton(
                    title: title,
                    reason: "“\(title)” requires a dedicated live workflow that is not advertised by the engine."
                )
            }
        }
        .buttonStyle(.plain)
        .font(.caption.weight(.medium))
        .accessibilityIdentifier("action.\(title.hqIdentifier)")
    }
}

private struct HQStatusPill: View {
    let text: String
    var emphasized = false

    var body: some View {
        Text(text)
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 9)
            .padding(.vertical, 4)
            .background(
                emphasized ? HQPalette.active : HQPalette.muted,
                in: Capsule()
            )
            .overlay(Capsule().stroke(HQPalette.hairline))
    }
}

private struct HQAvatar: View {
    let initials: String
    var size: CGFloat = 34

    var body: some View {
        Text(initials)
            .font(.system(size: size * 0.32, weight: .semibold, design: .rounded))
            .frame(width: size, height: size)
            .background(HQPalette.active, in: Circle())
            .overlay(Circle().stroke(HQPalette.hairline))
            .accessibilityHidden(true)
    }
}

private struct HQMetricCard: View {
    let label: String
    let value: String
    let detail: String
    let symbol: String

    var body: some View {
        HQGlassCard {
            HStack(alignment: .top, spacing: 14) {
                Image(systemName: symbol)
                    .font(.title3)
                    .frame(width: 28, height: 28)
                    .background(HQPalette.muted, in: RoundedRectangle(cornerRadius: 8))
                VStack(alignment: .leading, spacing: 5) {
                    Text(value)
                        .font(.title2.weight(.semibold))
                    Text(label)
                        .font(.subheadline.weight(.medium))
                    Text(detail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }
}

private extension String {
    var hqIdentifier: String {
        lowercased()
            .replacingOccurrences(of: " ", with: "-")
            .replacingOccurrences(of: "/", with: "-")
    }
}

// MARK: - Shell and navigation

private struct HQShellView: View {
    @ObservedObject var store: HQAppStore
    @Environment(\.accessibilityReduceTransparency)
    private var reduceTransparency

    private var fixture: HQShellFixture {
        store.content
    }

    private var syncMessage: String {
        switch store.operationState {
        case .idle:
            return store.phase == .ready ? "HQ engine ready" : "Not connected"
        case let .busy(message), let .success(message), let .failure(message):
            return message
        }
    }

    var body: some View {
        ZStack {
            if reduceTransparency || !store.mainWindowVibrancyEnabled {
                Color(nsColor: .windowBackgroundColor)
                    .ignoresSafeArea()
            } else {
                HQMaterialBackdrop()
                    .ignoresSafeArea()
            }

            NavigationSplitView {
                HQSidebarView(fixture: fixture, selection: $store.selectedRoute)
                    .navigationSplitViewColumnWidth(min: 220, ideal: 246, max: 286)
            } detail: {
                HQAdaptiveGlassContainer {
                    if store.launchMode.rendersProductionSurfaces {
                        HQLiveRouteView(
                            store: store,
                            route: store.selectedRoute,
                            navigate: navigate
                        )
                    } else {
                        HQRouteView(
                            route: store.selectedRoute,
                            fixture: fixture,
                            navigate: navigate
                        )
                    }
                }
                .background(Color.clear)
                .toolbar {
                    ToolbarItem(placement: .navigation) {
                        HStack(spacing: 7) {
                            Circle()
                                .fill(HQPalette.ink)
                                .frame(width: 6, height: 6)
                            Text(syncMessage)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        .accessibilityIdentifier("toolbar.sync-status")
                    }

                    ToolbarItemGroup {
                        Button {
                            store.dispatch(.syncNow)
                        } label: {
                            Label("Sync Now", systemImage: "arrow.triangle.2.circlepath")
                        }
                        .accessibilityIdentifier("toolbar.sync")

                        Button {
                            store.dispatch(.showCommandPalette)
                        } label: {
                            Label("Command Palette", systemImage: "command")
                        }
                        .accessibilityIdentifier("toolbar.command-palette")
                    }
                }
            }
            .navigationSplitViewStyle(.balanced)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("shell.root")

            if store.isCommandPalettePresented {
                HQCommandPalette(
                    selection: $store.selectedRoute,
                    isPresented: $store.isCommandPalettePresented
                )
                    .transition(.scale(scale: 0.98).combined(with: .opacity))
                    .zIndex(10)
            }

            if store.launchMode != .visualTourFixture {
                VStack {
                    Spacer()
                    HQOperationBanner(state: store.operationState)
                        .padding(12)
                }
                .allowsHitTesting(false)
                .zIndex(20)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("shell.root")
        .animation(.easeOut(duration: 0.16), value: store.isCommandPalettePresented)
    }

    private func navigate(_ route: HQRoute) {
        store.dispatch(.navigate(route))
    }
}

private struct HQSidebarView: View {
    let fixture: HQShellFixture
    @Binding var selection: HQRoute

    private let companySections: [(HQCompanySection, String, String)] = [
        (.overview, "Overview", "square.grid.2x2"),
        (.goals, "Goals", "target"),
        (.projects, "Projects", "rectangle.stack"),
        (.knowledge, "Knowledge", "books.vertical"),
        (.team, "Team", "person.2"),
        (.activity, "More", "ellipsis.circle"),
    ]

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                Text("HQ")
                    .font(.system(size: 18, weight: .bold, design: .rounded))
                    .frame(width: 34, height: 34)
                    .background(HQPalette.ink, in: RoundedRectangle(cornerRadius: 10))
                    .foregroundStyle(Color(nsColor: .windowBackgroundColor))
                VStack(alignment: .leading, spacing: 1) {
                    Text("Headquarters")
                        .font(.subheadline.weight(.semibold))
                    Text("Team AI workspace")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                Spacer()
            }
            .padding(.horizontal, 14)
            .padding(.top, 16)
            .padding(.bottom, 10)

            ScrollView {
                LazyVStack(alignment: .leading, spacing: 2) {
                    sidebarButton(
                        "Home",
                        symbol: "house",
                        route: .global(.home),
                        identifier: "sidebar.home"
                    )
                    sidebarButton(
                        "Mission Control",
                        symbol: "dot.radiowaves.left.and.right",
                        route: .global(.missionControl),
                        identifier: "sidebar.mission-control"
                    )

                    sidebarSectionTitle("Workspace")
                        .padding(.top, 10)

                    sidebarButton(
                        "Inbox",
                        symbol: "tray",
                        route: .global(.inbox),
                        identifier: "sidebar.inbox",
                        badge: fixture.messages.filter(\.unread).isEmpty
                            ? nil
                            : "\(fixture.messages.filter(\.unread).count)"
                    )
                    sidebarButton(
                        "Meetings",
                        symbol: "video",
                        route: .global(.meetings),
                        identifier: "sidebar.meetings"
                    )
                    sidebarButton(
                        "Marketplace",
                        symbol: "square.grid.2x2",
                        route: .global(.marketplace),
                        identifier: "sidebar.marketplace"
                    )
                    sidebarButton(
                        "Library",
                        symbol: "shippingbox",
                        route: .library(.skills),
                        identifier: "sidebar.library"
                    )
                    sidebarButton(
                        "Files",
                        symbol: "folder",
                        route: .files(slug: nil, path: nil),
                        identifier: "sidebar.files"
                    )
                    sidebarButton(
                        "Moderation",
                        symbol: "checkmark.shield",
                        route: .global(.moderation),
                        identifier: "sidebar.moderation"
                    )

                    sidebarSectionTitle("Companies")
                        .padding(.top, 10)

                    ForEach(fixture.snapshot.workspaces) { workspace in
                        VStack(alignment: .leading, spacing: 2) {
                            Button {
                                selection = .company(slug: workspace.slug, section: .overview)
                            } label: {
                                HStack(spacing: 9) {
                                    Text(String(workspace.name.prefix(1)))
                                        .font(.caption.weight(.bold))
                                        .frame(width: 23, height: 23)
                                        .background(
                                            HQPalette.active,
                                            in: RoundedRectangle(cornerRadius: 7)
                                        )
                                    Text(workspace.name)
                                        .font(.subheadline.weight(.semibold))
                                    Spacer()
                                    Circle()
                                        .fill(
                                            workspace.state == .connected
                                                ? HQPalette.ink
                                                : HQPalette.subtle
                                        )
                                        .frame(width: 6, height: 6)
                                }
                                .padding(.horizontal, 10)
                                .padding(.vertical, 7)
                                .background(
                                    companySelected(workspace.slug)
                                        ? HQPalette.selection
                                        : Color.clear,
                                    in: RoundedRectangle(cornerRadius: 8)
                                )
                                .contentShape(Rectangle())
                                .accessibilityElement(children: .combine)
                            }
                            .buttonStyle(.plain)
                            .accessibilityElement(children: .combine)
                            .accessibilityIdentifier("sidebar.company.\(workspace.slug)")
                            .accessibilityAddTraits(
                                companySelected(workspace.slug)
                                    ? .isSelected
                                    : []
                            )
                            .accessibilityRemoveTraits(
                                companySelected(workspace.slug)
                                    ? []
                                    : .isSelected
                            )
                            .accessibilityValue(
                                companySelected(workspace.slug)
                                    ? "Selected"
                                    : ""
                            )
                            .padding(.horizontal, 7)

                            ForEach(companySections, id: \.0) { section, title, symbol in
                                sidebarButton(
                                    title,
                                    symbol: symbol,
                                    route: .company(slug: workspace.slug, section: section),
                                    identifier: "sidebar.company.\(workspace.slug).\(section.rawValue)",
                                    inset: true
                                )
                            }
                        }
                    }
                }
                .padding(.vertical, 4)
            }
            .accessibilityIdentifier("shell.sidebar")

            Divider()

            sidebarButton(
                "Settings",
                symbol: "gearshape",
                route: .settings(.sync),
                identifier: "sidebar.settings"
            )
            .padding(10)
        }
        .background(.thinMaterial)
    }

    @ViewBuilder
    private func sidebarButton(
        _ title: String,
        symbol: String,
        route: HQRoute,
        identifier: String,
        badge: String? = nil,
        inset: Bool = false
    ) -> some View {
        Button {
            selection = route
        } label: {
            HStack(spacing: 9) {
                Image(systemName: symbol)
                    .frame(width: 18)
                    .foregroundStyle(selected(route) ? .primary : .secondary)
                Text(title)
                    .font(.subheadline)
                Spacer()
                if let badge {
                    Text(badge)
                        .font(.caption2.weight(.bold))
                        .frame(minWidth: 18, minHeight: 18)
                        .background(HQPalette.active, in: Capsule())
                }
            }
            .padding(.leading, inset ? 21 : 0)
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .background(
                selected(route) ? HQPalette.selection : Color.clear,
                in: RoundedRectangle(cornerRadius: 8)
            )
            .contentShape(Rectangle())
            .accessibilityElement(children: .combine)
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier(identifier)
        .accessibilityAddTraits(selected(route) ? .isSelected : [])
        .accessibilityRemoveTraits(selected(route) ? [] : .isSelected)
        .accessibilityValue(selected(route) ? "Selected" : "")
        .padding(.horizontal, 7)
    }

    private func sidebarSectionTitle(_ title: String) -> some View {
        Text(title)
            .font(.caption.weight(.semibold))
            .foregroundStyle(.secondary)
            .padding(.horizontal, 17)
            .padding(.vertical, 5)
    }

    private func selected(_ route: HQRoute) -> Bool {
        switch route {
        case .library:
            switch selection {
            case .library, .global(.library):
                true
            default:
                false
            }
        case .files:
            switch selection {
            case .files, .global(.files):
                true
            default:
                false
            }
        case .settings:
            switch selection {
            case .settings, .global(.settings):
                true
            default:
                false
            }
        case let .company(slug, .projects):
            switch selection {
            case let .project(selectedSlug, _),
                 let .task(selectedSlug, _, _):
                selectedSlug == slug
            default:
                selection == route
            }
        default:
            selection == route
        }
    }

    private func companySelected(_ slug: String) -> Bool {
        switch selection {
        case let .company(selectedSlug, _),
             let .project(selectedSlug, _),
             let .task(selectedSlug, _, _):
            return selectedSlug == slug
        default:
            return false
        }
    }
}

private struct HQCommandPalette: View {
    @Binding var selection: HQRoute
    @Binding var isPresented: Bool
    @State private var query = ""
    @State private var selectedIndex = 0
    @FocusState private var searchIsFocused: Bool

    private let commands: [(String, String, HQRoute)] = [
        ("Go to Home", "house", .global(.home)),
        ("Open Inbox", "tray", .global(.inbox)),
        ("Open Meetings", "video", .global(.meetings)),
        ("Browse Marketplace", "square.grid.2x2", .global(.marketplace)),
        ("Browse Library", "shippingbox", .library(.skills)),
        ("Open Files", "folder", .files(slug: nil, path: nil)),
        ("Open Indigo projects", "rectangle.stack", .company(slug: "indigo", section: .projects)),
        ("Open Settings", "gearshape", .settings(.sync)),
    ]

    var body: some View {
        ZStack {
            Color.black.opacity(0.18)
                .ignoresSafeArea()
                .onTapGesture { isPresented = false }

            VStack(spacing: 0) {
                HStack {
                    Image(systemName: "magnifyingglass")
                        .foregroundStyle(.secondary)
                    TextField("Search HQ or run a command", text: $query)
                        .textFieldStyle(.plain)
                        .font(.title3)
                        .focused($searchIsFocused)
                        .onSubmit(activateSelectedCommand)
                        .onMoveCommand(perform: moveSelection)
                        .onExitCommand(perform: dismiss)
                        .accessibilityIdentifier("command-palette.search")
                    Text("⌘K")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .padding(17)

                Divider()

                ScrollView {
                    VStack(spacing: 4) {
                        ForEach(filteredCommands.indices, id: \.self) { index in
                            let command = filteredCommands[index]
                            Button {
                                activateCommand(at: index)
                            } label: {
                                HStack(spacing: 12) {
                                    Image(systemName: command.1)
                                        .frame(width: 22)
                                    Text(command.0)
                                    Spacer()
                                    Image(systemName: "return")
                                        .font(.caption)
                                        .foregroundStyle(.tertiary)
                                }
                                .padding(.horizontal, 14)
                                .padding(.vertical, 10)
                                .contentShape(Rectangle())
                                .background(
                                    index == selectedIndex
                                        ? HQPalette.muted
                                        : Color.clear,
                                    in: RoundedRectangle(cornerRadius: 9)
                                )
                            }
                            .buttonStyle(.plain)
                            .accessibilityAddTraits(
                                index == selectedIndex ? .isSelected : []
                            )
                            .accessibilityValue(
                                index == selectedIndex ? "Selected" : ""
                            )
                            .accessibilityIdentifier("command.\(command.0.hqIdentifier)")
                        }
                        if filteredCommands.isEmpty {
                            VStack(spacing: 8) {
                                Image(systemName: "magnifyingglass")
                                    .font(.title2)
                                    .foregroundStyle(.secondary)
                                Text("No matching commands")
                                    .font(.headline)
                                Text("Try a different search.")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            .frame(maxWidth: .infinity)
                            .padding(28)
                            .accessibilityIdentifier(
                                "command-palette.empty"
                            )
                        }
                    }
                    .padding(8)
                }
                .frame(maxHeight: 350)

                Divider()
                HStack {
                    Text("Navigate")
                    Spacer()
                    Text("↑↓ Select   ↩ Open   esc Close")
                }
                .font(.caption2)
                .foregroundStyle(.secondary)
                .padding(12)
            }
            .frame(width: 570)
            .hqAdaptiveGlassSurface(cornerRadius: 22)
            .shadow(color: .black.opacity(0.18), radius: 28, y: 12)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("command-palette")
        }
        .onAppear {
            query = ""
            selectedIndex = 0
            searchIsFocused = true
        }
        .onChange(of: query) { _ in
            selectedIndex = 0
        }
        .onChange(of: filteredCommands.count) { count in
            clampSelection(to: count)
        }
        .onMoveCommand(perform: moveSelection)
        .onExitCommand(perform: dismiss)
        .background {
            HQCommandPaletteKeyMonitor { action in
                switch action {
                case .moveUp:
                    moveSelection(.up)
                case .moveDown:
                    moveSelection(.down)
                case .activate:
                    activateSelectedCommand()
                case .dismiss:
                    dismiss()
                }
            }
            .frame(width: 0, height: 0)
        }
    }

    private var filteredCommands: [(String, String, HQRoute)] {
        guard !query.isEmpty else { return commands }
        return commands.filter { $0.0.localizedCaseInsensitiveContains(query) }
    }

    private func moveSelection(_ direction: MoveCommandDirection) {
        guard !filteredCommands.isEmpty else {
            selectedIndex = 0
            return
        }
        switch direction {
        case .up:
            selectedIndex = max(0, selectedIndex - 1)
        case .down:
            selectedIndex = min(
                filteredCommands.count - 1,
                selectedIndex + 1
            )
        default:
            break
        }
    }

    private func clampSelection(to count: Int) {
        selectedIndex = count == 0
            ? 0
            : min(max(0, selectedIndex), count - 1)
    }

    private func activateSelectedCommand() {
        activateCommand(at: selectedIndex)
    }

    private func activateCommand(at index: Int) {
        guard filteredCommands.indices.contains(index) else { return }
        selection = filteredCommands[index].2
        dismiss()
    }

    private func dismiss() {
        searchIsFocused = false
        isPresented = false
    }
}

enum HQCommandPaletteKeyAction: Equatable {
    case moveUp
    case moveDown
    case activate
    case dismiss

    static func resolve(
        keyCode: UInt16,
        modifiers: NSEvent.ModifierFlags
    ) -> HQCommandPaletteKeyAction? {
        let unsupportedModifiers = modifiers.intersection([
            .command,
            .control,
            .option,
        ])
        guard unsupportedModifiers.isEmpty else { return nil }

        switch keyCode {
        case 126:
            return .moveUp
        case 125:
            return .moveDown
        case 36, 76:
            return .activate
        case 53:
            return .dismiss
        default:
            return nil
        }
    }
}

private struct HQCommandPaletteKeyMonitor: NSViewRepresentable {
    let onAction: (HQCommandPaletteKeyAction) -> Void

    func makeNSView(context: Context) -> MonitorView {
        let view = MonitorView()
        view.onAction = onAction
        return view
    }

    func updateNSView(_ nsView: MonitorView, context: Context) {
        nsView.onAction = onAction
    }

    final class MonitorView: NSView {
        var onAction: ((HQCommandPaletteKeyAction) -> Void)?
        private var eventMonitor: EventMonitorRegistration?

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            if window == nil {
                removeEventMonitor()
            } else {
                installEventMonitor()
            }
        }

        private func installEventMonitor() {
            guard eventMonitor == nil else { return }
            eventMonitor = EventMonitorRegistration(
                NSEvent.addLocalMonitorForEvents(
                    matching: .keyDown
                ) { [weak self] event in
                    guard let self,
                          self.window?.isKeyWindow == true,
                          let action = HQCommandPaletteKeyAction.resolve(
                              keyCode: event.keyCode,
                              modifiers: event.modifierFlags
                          )
                    else {
                        return event
                    }
                    onAction?(action)
                    return nil
                }
            )
        }

        private func removeEventMonitor() {
            eventMonitor = nil
        }

        private final class EventMonitorRegistration: @unchecked Sendable {
            private let token: Any

            init?(_ token: Any?) {
                guard let token else { return nil }
                self.token = token
            }

            deinit {
                NSEvent.removeMonitor(token)
            }
        }
    }
}

// MARK: - Route renderer

private struct HQMarketplaceInstallTarget: Identifiable {
    let id: String
    let label: String
    let scope: HQJSONValue
}

private struct HQLiveRouteView: View {
    @ObservedObject var store: HQAppStore
    let route: HQRoute
    let navigate: (HQRoute) -> Void
    @State private var reviewedModerationVersions: Set<String> = []
    @State private var moderationRejectionNotes: [String: String] = [:]
    @State private var marketplaceTargetByListing: [String: String] = [:]

    private var projects: [HQProject] {
        store.content.snapshot.projects
    }

    var body: some View {
        HQPage(
            eyebrow: "Live HQ",
            title: title,
            subtitle: subtitle,
            identifier: HQScreenAccessibility.identifier(for: route)
        ) {
            switch store.phase {
            case .idle, .loading:
                HQGlassCard {
                    HStack(spacing: 12) {
                        ProgressView()
                        Text("Loading live HQ data…")
                            .font(.headline)
                    }
                    Text("Connecting to the bundled engine and reading this Mac.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .accessibilityIdentifier("live.state.loading")
            case let .failed(message):
                HQGlassCard {
                    Label("HQ engine unavailable", systemImage: "exclamationmark.triangle")
                        .font(.headline)
                    Text(message)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    HQActionButton("Try Again", action: .refresh)
                        .padding(.top, 8)
                }
                .accessibilityIdentifier("live.state.error")
            case .ready:
                readyContent
            }
        }
        .task(
            id: "\(HQRouteParser.serialize(route))-\(store.phase == .ready)"
        ) {
            guard store.phase == .ready else { return }
            await store.loadLiveRoute(route)
        }
    }

    @ViewBuilder
    private var readyContent: some View {
        switch route {
        case .global(.home):
            home
        case .global(.missionControl):
            sessions
        case .global(.inbox),
             .global(.meetings),
             .global(.moderation),
             .global(.files),
             .files:
            liveRouteContent
        case .global(.marketplace):
            VStack(alignment: .leading, spacing: 12) {
                liveRouteContent
                HQMarketplaceProgressView(
                    events: store.nativeParityEvents
                )
            }
        case .global(.library):
            library(section: .skills)
        case let .library(section):
            library(section: section)
        case .global(.settings):
            settings(section: .general)
        case let .settings(section):
            settings(section: section)
        case let .company(slug, section):
            company(slug: slug, section: section)
        case let .project(company, projectID):
            project(company: company, projectID: projectID)
        case let .task(company, projectID, taskID):
            task(company: company, projectID: projectID, taskID: taskID)
        }
    }

    private var home: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 14) {
                HQMetricCard(
                    label: "Workspaces",
                    value: "\(store.content.snapshot.workspaces.count)",
                    detail: "Discovered by the local engine",
                    symbol: "building.2"
                )
                HQMetricCard(
                    label: "Projects",
                    value: "\(projects.count)",
                    detail: "Indexed from local HQ data",
                    symbol: "rectangle.stack"
                )
                HQMetricCard(
                    label: "Sessions",
                    value: "\(store.sessions.count)",
                    detail: "Discovered agent sessions",
                    symbol: "terminal"
                )
                HQMetricCard(
                    label: "Capabilities",
                    value: "\(store.capabilities.count)",
                    detail: "Advertised by the bundled engine",
                    symbol: "bolt.horizontal.circle"
                )
            }

            HQGlassCard {
                HQSectionTitle(
                    title: "Workspaces",
                    detail: store.content.snapshot.workspaces.isEmpty
                        ? "No local workspaces were discovered"
                        : "Local workspace discovery"
                )
                Divider().padding(.vertical, 8)
                if store.content.snapshot.workspaces.isEmpty {
                    Text("Choose an HQ folder in Settings to discover workspaces.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(store.content.snapshot.workspaces) { workspace in
                        Button {
                            navigate(
                                .company(
                                    slug: workspace.slug,
                                    section: .overview
                                )
                            )
                        } label: {
                            HStack {
                                Image(systemName: "building.2")
                                VStack(alignment: .leading) {
                                    Text(workspace.name)
                                        .font(.subheadline.weight(.semibold))
                                    Text(workspace.path?.path ?? "No local path")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                        .lineLimit(1)
                                }
                                Spacer()
                                HQStatusPill(text: workspace.state.rawValue)
                                Image(systemName: "chevron.right")
                                    .foregroundStyle(.tertiary)
                            }
                            .padding(.vertical, 7)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier(
                            "live.workspace.\(workspace.slug)"
                        )
                    }
                }
            }

            projectList(
                title: "Projects",
                detail: projects.isEmpty
                    ? "No local projects were indexed"
                    : "Live project index"
            )
        }
    }

    private var sessions: some View {
        HQGlassCard {
            HQSectionTitle(
                title: "Agent sessions",
                detail: store.sessions.isEmpty
                    ? "No sessions were discovered"
                    : "\(store.sessions.count) live records"
            )
            Divider().padding(.vertical, 8)
            if store.sessions.isEmpty {
                Text("The engine returned no local Claude or Codex sessions.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(store.sessions) { session in
                    HStack(spacing: 12) {
                        Image(systemName: "terminal")
                            .frame(width: 30, height: 30)
                            .background(
                                HQPalette.muted,
                                in: RoundedRectangle(cornerRadius: 8)
                            )
                        VStack(alignment: .leading) {
                            Text(session.title)
                                .font(.subheadline.weight(.semibold))
                            Text(
                                [session.provider, session.company, session.project]
                                    .compactMap { $0 }
                                    .joined(separator: " · ")
                            )
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        }
                        Spacer()
                        HQStatusPill(text: session.status)
                    }
                    .padding(.vertical, 7)
                    .accessibilityIdentifier("live.session.\(session.id)")
                }
            }
        }
    }

    @ViewBuilder
    private func company(
        slug: String,
        section: HQCompanySection
    ) -> some View {
        let workspace = store.content.snapshot.workspaces.first {
            $0.slug == slug
        }
        let companyProjects = projects.filter { $0.companySlug == slug }

        companySectionPicker(slug: slug, section: section)

        if let workspace {
            HStack(spacing: 14) {
                HQMetricCard(
                    label: "Connection",
                    value: workspace.state.rawValue,
                    detail: workspace.path?.path ?? "No local path",
                    symbol: "externaldrive.connected.to.line.below"
                )
                HQMetricCard(
                    label: "Projects",
                    value: "\(companyProjects.count)",
                    detail: "Indexed for \(workspace.name)",
                    symbol: "rectangle.stack"
                )
            }

            switch section {
            case .overview:
                VStack(alignment: .leading, spacing: 16) {
                    liveRouteContent
                    projectList(
                        title: workspace.name,
                        detail: companyProjects.isEmpty
                            ? "No local projects were indexed for this workspace"
                            : "Local projects from projects.list",
                        rows: companyProjects
                    )
                }
            case .projects:
                VStack(alignment: .leading, spacing: 16) {
                    liveRouteContent
                    projectList(
                        title: workspace.name,
                        detail: companyProjects.isEmpty
                            ? "No local projects were indexed for this workspace"
                            : "Local projects from projects.list",
                        rows: companyProjects
                    )
                }
            case .goals,
                 .skills,
                 .workers,
                 .knowledge,
                 .team,
                 .activity,
                 .deployments,
                 .secrets:
                liveRouteContent
            case .settings:
                VStack(alignment: .leading, spacing: 16) {
                    liveRouteContent
                    syncModeActions(slug: slug)
                    HQGlassCard {
                        HQSectionTitle(title: "Workspace")
                        Divider().padding(.vertical, 8)
                        liveValue("Slug", value: slug)
                        liveValue(
                            "Path",
                            value: workspace.path?.path ?? "No local path"
                        )
                        liveValue(
                            "Connection",
                            value: workspace.state.rawValue
                        )
                    }
                }
            }
        } else {
            liveRouteContent
        }
    }

    private func companySectionPicker(
        slug: String,
        section: HQCompanySection
    ) -> some View {
        HQGlassCard {
            HStack {
                Label("Company section", systemImage: "building.2")
                    .font(.subheadline.weight(.medium))
                Spacer()
                Picker(
                    "Company section",
                    selection: Binding(
                        get: { section },
                        set: {
                            navigate(.company(slug: slug, section: $0))
                        }
                    )
                ) {
                    ForEach(HQCompanySection.allCases, id: \.self) {
                        Text(
                            $0.rawValue
                                .replacingOccurrences(of: "-", with: " ")
                                .capitalized
                        )
                        .tag($0)
                    }
                }
                .labelsHidden()
                .frame(width: 190)
                .accessibilityIdentifier("company.section-picker")
            }
        }
    }

    private func library(section: HQLibrarySection) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            Picker(
                "Library section",
                selection: Binding(
                    get: { section },
                    set: { navigate(.library($0)) }
                )
            ) {
                ForEach(HQLibrarySection.allCases, id: \.self) {
                    Text($0.rawValue.capitalized).tag($0)
                }
            }
            .pickerStyle(.segmented)
            .accessibilityIdentifier("library.tabs")
            liveRouteContent
        }
    }

    @ViewBuilder
    private func project(
        company: String,
        projectID: String
    ) -> some View {
        if let project = projects.first(where: {
            $0.companySlug == company && $0.id == projectID
        }) {
            HQGlassCard {
                HStack {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(project.title)
                            .font(.title2.weight(.semibold))
                        Text(project.summary.isEmpty ? "No project summary" : project.summary)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    HQStatusPill(text: project.status)
                }
                Divider().padding(.vertical, 8)
                liveValue("Company", value: project.companySlug)
                liveValue("Path", value: project.path.path)
                liveValue("Branch", value: project.branch ?? "Not reported")
                liveValue("Tasks", value: "\(project.tasks.count)")
            }
            projectList(
                title: "Tasks",
                detail: project.tasks.isEmpty
                    ? "Task details were not included by projects.list"
                    : "Live project tasks",
                project: project
            )
            liveRouteContent
            if let boardPath = project.boardPath {
                HQGlassCard {
                    HQSectionTitle(
                        title: "Project status",
                        detail: "Writes the local company board through the engine"
                    )
                    Divider().padding(.vertical, 8)
                    HStack {
                        ForEach(["inbox", "doing", "review", "done"], id: \.self) {
                            status in
                            HQActionButton(
                                status.capitalized,
                                action: .setProjectStatus(
                                    boardPath: boardPath,
                                    projectID: project.id,
                                    status: status
                                ),
                                requiredCapability: "set_local_project_status"
                            )
                        }
                        Spacer()
                    }
                }
            }
        } else {
            liveRouteContent
        }
    }

    @ViewBuilder
    private func task(
        company: String,
        projectID: String,
        taskID: String
    ) -> some View {
        let project = projects.first {
            $0.companySlug == company && $0.id == projectID
        }
        let task = project?.tasks.first { $0.id == taskID }

        if let task {
            HQGlassCard {
                HStack {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(task.title)
                            .font(.title2.weight(.semibold))
                        Text(task.detail.isEmpty ? "No task detail" : task.detail)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    HQStatusPill(text: task.state.rawValue)
                }
                Divider().padding(.vertical, 8)
                liveValue("ID", value: task.id)
                liveValue("Priority", value: "\(task.priority)")
                liveValue(
                    "Dependencies",
                    value: task.dependencies.isEmpty
                        ? "None"
                        : task.dependencies.joined(separator: ", ")
                )
                liveValue(
                    "Acceptance criteria",
                    value: "\(task.acceptanceCriteria.count)"
                )
            }
        }
        liveRouteContent
    }

    private func settings(section: HQSettingsSection) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            Picker(
                "Settings section",
                selection: Binding(
                    get: { section },
                    set: { navigate(.settings($0)) }
                )
            ) {
                ForEach(HQSettingsSection.allCases, id: \.self) {
                    Text($0.rawValue.capitalized).tag($0)
                }
            }
            .pickerStyle(.segmented)
            .accessibilityIdentifier("settings.tabs")

            if section == .sync || section == .meetings {
                liveRouteContent
            }
            HQGlassCard {
                HQSectionTitle(
                    title: "\(section.rawValue.capitalized) settings",
                    detail: "Native macOS controls"
                )
                Divider().padding(.vertical, 8)
                liveValue(
                    "Engine",
                    value: store.phase == .ready ? "Ready" : "Unavailable"
                )
                liveValue(
                    "Authentication",
                    value: store.isAuthenticated ? "Authenticated" : "Not authenticated"
                )
                liveValue(
                    "Capabilities",
                    value: "\(store.capabilities.count)"
                )
                liveValue(
                    "Workspaces",
                    value: "\(store.content.snapshot.workspaces.count)"
                )
            }
            HQGlassCard {
                switch section {
                case .sync:
                    if store.content.snapshot.workspaces.isEmpty {
                        Text("Choose an HQ folder before changing sync mode.")
                            .foregroundStyle(.secondary)
                    } else {
                        VStack(alignment: .leading, spacing: 10) {
                            Picker(
                                "Workspace",
                                selection: Binding(
                                    get: {
                                        validSelectedSyncWorkspaceSlug
                                    },
                                    set: {
                                        store.dispatch(
                                            .selectSyncWorkspace($0)
                                        )
                                    }
                                )
                            ) {
                                Text("Choose a workspace…")
                                    .tag(nil as String?)
                                ForEach(
                                    store.content.snapshot.workspaces
                                ) { workspace in
                                    Text(workspace.name)
                                        .tag(workspace.slug as String?)
                                }
                            }
                            .frame(maxWidth: 340)
                            .accessibilityIdentifier(
                                "settings.sync.workspace"
                            )

                            if let slug = validSelectedSyncWorkspaceSlug {
                                syncModeActionButtons(slug: slug)
                            } else {
                                Text(
                                    "Select the workspace whose sync scope you want to change."
                                )
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            }
                        }
                    }
                case .notifications:
                    HStack {
                        HQActionButton(
                            "Request Notifications",
                            action: .nativeCommand(.notificationRequestPermission)
                        )
                        HQActionButton(
                            "Open System Settings",
                            action: .nativeCommand(
                                .permissionsOpenSettings,
                                payload: .string(
                                    HQSystemSettingsDestination
                                        .notifications.rawValue
                                )
                            )
                        )
                        Spacer()
                    }
                case .widget:
                    HStack {
                        Text(
                            "Current mode: \(store.widgetMode.rawValue.capitalized)"
                        )
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier(
                            "settings.widget.current-mode"
                        )
                        HQActionButton(
                            "Compact",
                            action: .nativeCommand(
                                .applyWidgetSettings,
                                payload: .object([
                                    "mode": .string(
                                        HQWidgetMode.compact.rawValue
                                    ),
                                ])
                            )
                        )
                        .disabled(store.widgetMode == .compact)
                        .accessibilityIdentifier(
                            "settings.widget.mode.compact"
                        )
                        HQActionButton(
                            "Expanded",
                            action: .nativeCommand(
                                .applyWidgetSettings,
                                payload: .object([
                                    "mode": .string(
                                        HQWidgetMode.expanded.rawValue
                                    ),
                                ])
                            )
                        )
                        .disabled(store.widgetMode == .expanded)
                        .accessibilityIdentifier(
                            "settings.widget.mode.expanded"
                        )
                        HQActionButton(
                            "Open Widget",
                            action: .openScene(.widget)
                        )
                        HQActionButton(
                            "Preview Notification",
                            action: .nativeCommand(.previewDMBanner)
                        )
                        Spacer()
                    }
                case .updates:
                    VStack(alignment: .leading, spacing: 10) {
                        Label(
                            updaterStateDescription,
                            systemImage: updaterStateSymbol
                        )
                        .font(.subheadline)
                        .accessibilityIdentifier(
                            "settings.updates.state"
                        )
                        HStack {
                            HQActionButton(
                                "Check for Updates",
                                action: .nativeCommand(.checkForUpdates)
                            )
                            HQActionButton(
                                "Install Available Update",
                                action: .nativeCommand(.installUpdate)
                            )
                            .disabled(!updaterCanInstall)
                            .accessibilityIdentifier(
                                "settings.updates.install"
                            )
                            Spacer()
                        }
                    }
                case .general:
                    HStack {
                        HQActionButton(
                            "Choose HQ Folder",
                            action: .nativeCommand(.pickFolder)
                        )
                        HQActionButton(
                            "Enable Launch at Login",
                            action: .nativeCommand(
                                .setAutostartEnabled,
                                payload: .bool(true)
                            )
                        )
                        HQActionButton("Refresh", action: .refresh)
                        Spacer()
                    }
                case .meetings:
                    HStack {
                        HQActionButton(
                            "Open Meetings",
                            action: .openScene(.meetings)
                        )
                        HQActionButton(
                            "Review Permissions",
                            action: .openScene(.meetingPermissions)
                        )
                        Spacer()
                    }
                }
            }
        }
    }

    private var validSelectedSyncWorkspaceSlug: String? {
        guard let selectedSyncWorkspaceSlug =
                  store.selectedSyncWorkspaceSlug,
              store.content.snapshot.workspaces.contains(
                  where: { $0.slug == selectedSyncWorkspaceSlug }
              )
        else {
            return nil
        }
        return selectedSyncWorkspaceSlug
    }

    private var updaterCanInstall: Bool {
        if case .available = store.updaterState {
            return true
        }
        return false
    }

    private var updaterStateDescription: String {
        switch store.updaterState {
        case let .idle(channel):
            return "Ready to check the \(channel.rawValue) channel."
        case let .checking(channel):
            return "Checking the \(channel.rawValue) channel…"
        case let .upToDate(channel):
            return "HQ is up to date on the \(channel.rawValue) channel."
        case let .available(channel, update):
            return "HQ \(update.displayVersion) is available on \(channel.rawValue)."
        case let .downloading(_, update):
            return "Downloading HQ \(update.displayVersion)…"
        case let .readyToInstall(_, update):
            return "HQ \(update.displayVersion) is ready to install."
        case let .installing(_, update):
            return "Installing HQ \(update.displayVersion)…"
        case let .failed(channel, message):
            return "The \(channel.rawValue) update check failed: \(message)"
        }
    }

    private var updaterStateSymbol: String {
        switch store.updaterState {
        case .idle:
            return "arrow.clockwise"
        case .checking, .downloading:
            return "arrow.triangle.2.circlepath"
        case .upToDate:
            return "checkmark.circle"
        case .available, .readyToInstall:
            return "arrow.down.circle"
        case .installing:
            return "shippingbox"
        case .failed:
            return "exclamationmark.triangle"
        }
    }

    @ViewBuilder
    private var liveRouteContent: some View {
        switch store.liveRouteState(for: route) {
        case .loading:
            HQGlassCard {
                HStack(spacing: 12) {
                    ProgressView()
                    Text("Loading \(title.lowercased())…")
                        .font(.headline)
                }
                Text("Reading the exact live engine contracts for this screen.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .accessibilityIdentifier("live.route.loading")
        case let .failure(failure):
            HQGlassCard {
                Label(
                    "Could not load \(title.lowercased())",
                    systemImage: "exclamationmark.triangle"
                )
                .font(.headline)
                Text(failure.message)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                HQActionButton(failure.retryTitle, action: .refresh)
                    .padding(.top, 8)
            }
            .accessibilityIdentifier("live.route.error")
        case let .empty(empty):
            HQGlassCard {
                Label(empty.title, systemImage: "tray")
                    .font(.headline)
                Text(empty.message)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                HQActionButton("Refresh", action: .refresh)
                    .padding(.top, 8)
            }
            .accessibilityIdentifier("live.route.empty")
        case let .content(content):
            VStack(alignment: .leading, spacing: 12) {
                if let notice = content.notice {
                    HQGlassCard {
                        Label(
                            "Some live data could not load",
                            systemImage: "exclamationmark.triangle"
                        )
                        .font(.headline)
                        Text(notice)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                    }
                }
                HQGlassCard {
                    HQSectionTitle(
                        title: content.title,
                        detail: content.subtitle
                    )
                    Divider().padding(.vertical, 8)
                    ForEach(rowsForCurrentRoute(content.rows)) { row in
                        liveRouteRow(row)
                        if row.id != rowsForCurrentRoute(content.rows).last?.id {
                            Divider()
                        }
                    }
                }
                .accessibilityIdentifier("live.route.content")
            }
        }
    }

    private func liveRouteRow(_ row: HQWindowRowFixture) -> some View {
        let usesStackedActions = route == .global(.moderation)
        return VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .center, spacing: 12) {
                Image(systemName: row.symbolName)
                    .frame(width: 30, height: 30)
                    .background(
                        HQPalette.muted,
                        in: RoundedRectangle(cornerRadius: 8)
                    )
                VStack(alignment: .leading, spacing: 3) {
                    Text(row.title)
                        .font(.subheadline.weight(.semibold))
                        .textSelection(.enabled)
                    if !row.detail.isEmpty {
                        Text(row.detail)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(3)
                            .textSelection(.enabled)
                    }
                }
                Spacer(minLength: 12)
                if let value = row.value {
                    HQStatusPill(text: value)
                }
                if !usesStackedActions {
                    liveRouteActions(for: row)
                }
            }
            if usesStackedActions {
                liveRouteActions(for: row)
            }
        }
        .padding(.vertical, 7)
        .accessibilityIdentifier("live.route.row.\(row.id)")
    }

    @ViewBuilder
    private func liveRouteActions(
        for row: HQWindowRowFixture
    ) -> some View {
        switch route {
        case .global(.marketplace):
            if let slug = metadataString("slug", in: row) {
                let listingID = metadataString("id", in: row) ?? row.id
                let version = metadataString("version", in: row)
                let selectionKey = marketplaceSelectionKey(
                    listingID: listingID,
                    version: version
                )
                let selectedTarget = marketplaceInstallTarget(
                    for: selectionKey
                )
                let installParams = marketplaceInstallParams(
                    slug: slug,
                    version: version,
                    scope: selectedTarget?.scope
                )
                let isInstalling = installParams.map {
                    store.isMutationInFlight(
                        method: HQEngineAppCommand
                            .installMarketplacePack.rawValue,
                        params: $0
                    )
                } ?? false

                HStack(spacing: 8) {
                    Picker(
                        "Install target",
                        selection: marketplaceTargetBinding(
                            for: selectionKey
                        )
                    ) {
                        Text("Choose a target…")
                            .tag(nil as String?)
                        ForEach(marketplaceInstallTargets) { target in
                            Text(target.label)
                                .tag(target.id as String?)
                        }
                    }
                    .labelsHidden()
                    .frame(width: 190)
                    .disabled(isInstalling)
                    .accessibilityIdentifier(
                        "marketplace.target.\(listingID)"
                    )

                    if let selectedTarget {
                        HQActionButton(
                            "Install",
                            action: .installMarketplace(
                                listingID: listingID,
                                slug: slug,
                                version: version,
                                scope: selectedTarget.scope
                            )
                        )
                        .disabled(isInstalling)
                        .accessibilityIdentifier(
                            "marketplace.install.\(listingID)"
                        )
                    } else {
                        HQActionButton(
                            "Install",
                            action: .capabilityUnavailable(
                                reason: "Choose an install target first."
                            )
                        )
                        .disabled(true)
                    }
                }
            }
        case .global(.moderation):
            if let listingID = metadataString("id", in: row) {
                let versionLock = metadataString("versionLock", in: row)
                    ?? metadataString("version", in: row)
                let reviewKey = moderationReviewKey(
                    listingID: listingID,
                    versionLock: versionLock
                )
                let instructionText = moderationInstructionText(in: row)
                let injectionScan = row.metadata["injectionScan"]
                let rejectionNote =
                    moderationRejectionNotes[reviewKey] ?? ""
                let trimmedRejectionNote =
                    rejectionNote.trimmingCharacters(
                        in: .whitespacesAndNewlines
                    )
                let approveParams = moderationParams(
                    id: listingID,
                    decision: "approve",
                    note: nil,
                    versionLock: versionLock
                )
                let rejectParams = moderationParams(
                    id: listingID,
                    decision: "reject",
                    note: trimmedRejectionNote,
                    versionLock: versionLock
                )
                let mutationInFlight =
                    store.isMutationInFlight(
                        method: HQEngineAppCommand
                            .decideModerationListing.rawValue,
                        params: approveParams
                    )
                    || store.isMutationInFlight(
                        method: HQEngineAppCommand
                            .decideModerationListing.rawValue,
                        params: rejectParams
                    )

                VStack(alignment: .leading, spacing: 10) {
                    moderationEvidence(
                        instructionText: instructionText,
                        injectionScan: injectionScan
                    )

                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                        Toggle(
                            "Reviewed \(versionLock ?? "current version")",
                            isOn: moderationReviewBinding(for: reviewKey)
                        )
                        .toggleStyle(.checkbox)
                        .disabled(mutationInFlight)
                        .help(
                            "Confirm every instruction document and injection-scan result for this exact listing version."
                        )

                        TextField(
                            "Required rejection note",
                            text: moderationRejectionNoteBinding(
                                for: reviewKey
                            )
                        )
                        .textFieldStyle(.roundedBorder)
                        .disabled(mutationInFlight)
                        .accessibilityIdentifier(
                            "moderation.rejection-note.\(listingID)"
                        )

                        HQActionButton(
                            "Approve",
                            command: .decideModerationListing,
                            params: approveParams,
                            successMessage: "Approved \(row.title)."
                        )
                        .disabled(
                            !reviewedModerationVersions.contains(
                                reviewKey
                            ) || mutationInFlight
                        )

                        HQActionButton(
                            "Reject",
                            command: .decideModerationListing,
                            params: rejectParams,
                            successMessage: "Rejected \(row.title)."
                        )
                        .disabled(
                            !reviewedModerationVersions.contains(
                                reviewKey
                            )
                                || trimmedRejectionNote.isEmpty
                                || mutationInFlight
                        )
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        case .global(.files), .files:
            if let path = metadataString("path", in: row) {
                HStack(spacing: 8) {
                    HQActionButton(
                        "Open",
                        action: .navigate(.files(
                                slug: fileWorkspaceSlug(
                                    for: path,
                                    row: row
                                ),
                                path: path
                            ))
                    )
                    if let absolutePath = localAbsolutePath(for: path) {
                        HQActionButton(
                            "Open in Editor",
                            action: .nativeCommand(
                                .openInEditor,
                                payload: .object([
                                    "path": .string(absolutePath),
                                ])
                            )
                        )
                    }
                }
            }
        case .library,
             .global(.library),
             .company(_, .skills),
             .company(_, .workers),
             .company(_, .knowledge):
            if let path = metadataString("path", in: row),
               let absolutePath = localAbsolutePath(for: path)
            {
                HQActionButton(
                    "Reveal",
                    action: .nativeCommand(
                        .revealFolder,
                        payload: .string(absolutePath)
                    )
                )
            }
        case let .task(_, projectID, taskID):
            if metadataString("id", in: row) == taskID,
               let project = projects.first(where: { $0.id == projectID }),
               let prdPath = project.prdPath
            {
                let passes = metadataBool("passes", in: row) ?? false
                HQActionButton(
                    passes ? "Reopen" : "Complete",
                    action: .setStoryPasses(
                        prdPath: prdPath,
                        storyID: taskID,
                        passes: !passes
                    ),
                    requiredCapability: "set_local_story_passes"
                )
            }
        default:
            EmptyView()
        }
    }

    private func rowsForCurrentRoute(
        _ rows: [HQWindowRowFixture]
    ) -> [HQWindowRowFixture] {
        switch route {
        case let .task(_, _, taskID):
            let taskRows = rows.filter {
                metadataString("id", in: $0) == taskID
            }
            return taskRows.isEmpty ? rows : taskRows
        case .library(.skills), .company(_, .skills):
            return rows.filter {
                metadataString("_hqCollection", in: $0) == "Skills"
            }
        case .library(.workers), .company(_, .workers):
            return rows.filter {
                metadataString("_hqCollection", in: $0) == "Workers"
            }
        default:
            return rows
        }
    }

    private func syncModeActions(slug: String) -> some View {
        HQGlassCard {
            HQSectionTitle(
                title: "Sync scope",
                detail: "Choose which authorized company paths sync to this Mac"
            )
            Divider().padding(.vertical, 8)
            syncModeActionButtons(slug: slug)
        }
    }

    private func syncModeActionButtons(slug: String) -> some View {
        HStack {
            HQActionButton(
                "Sync Everything",
                command: .setSyncMode,
                params: .object([
                    "companySlug": .string(slug),
                    "mode": .string("all"),
                ]),
                successMessage: "Sync mode set to everything."
            )
            HQActionButton(
                "Shared Paths Only",
                command: .setSyncMode,
                params: .object([
                    "companySlug": .string(slug),
                    "mode": .string("shared"),
                ]),
                successMessage: "Sync mode set to shared paths."
            )
            Spacer()
        }
    }

    private var marketplaceInstallTargets: [HQMarketplaceInstallTarget] {
        [
            HQMarketplaceInstallTarget(
                id: "personal",
                label: "Personal",
                scope: .object(["kind": .string("personal")])
            ),
        ] + store.content.snapshot.workspaces.map { workspace in
            HQMarketplaceInstallTarget(
                id: "company:\(workspace.slug)",
                label: "\(workspace.name) · Company",
                scope: .object([
                    "kind": .string("company"),
                    "slug": .string(workspace.slug),
                ])
            )
        }
    }

    private func marketplaceSelectionKey(
        listingID: String,
        version: String?
    ) -> String {
        "\(listingID)|\(version ?? "latest")"
    }

    private func marketplaceTargetBinding(
        for selectionKey: String
    ) -> Binding<String?> {
        Binding(
            get: {
                guard let targetID =
                    marketplaceTargetByListing[selectionKey],
                    marketplaceInstallTargets.contains(
                        where: { $0.id == targetID }
                    )
                else {
                    return nil
                }
                return targetID
            },
            set: { targetID in
                guard let targetID,
                      marketplaceInstallTargets.contains(
                          where: { $0.id == targetID }
                      )
                else {
                    marketplaceTargetByListing.removeValue(
                        forKey: selectionKey
                    )
                    return
                }
                marketplaceTargetByListing[selectionKey] = targetID
            }
        )
    }

    private func marketplaceInstallTarget(
        for selectionKey: String
    ) -> HQMarketplaceInstallTarget? {
        guard let targetID = marketplaceTargetByListing[selectionKey]
        else {
            return nil
        }
        return marketplaceInstallTargets.first {
            $0.id == targetID
        }
    }

    private func marketplaceInstallParams(
        slug: String,
        version: String?,
        scope: HQJSONValue?
    ) -> HQJSONValue? {
        guard let scope else { return nil }
        return .object([
            "slug": .string(slug),
            "version": version.map(HQJSONValue.string) ?? .null,
            "scope": scope,
        ])
    }

    private func moderationReviewKey(
        listingID: String,
        versionLock: String?
    ) -> String {
        "\(listingID)|\(versionLock ?? "unversioned")"
    }

    private func moderationReviewBinding(
        for reviewKey: String
    ) -> Binding<Bool> {
        Binding(
            get: {
                reviewedModerationVersions.contains(reviewKey)
            },
            set: { reviewed in
                if reviewed {
                    reviewedModerationVersions.insert(reviewKey)
                } else {
                    reviewedModerationVersions.remove(reviewKey)
                }
            }
        )
    }

    private func moderationRejectionNoteBinding(
        for reviewKey: String
    ) -> Binding<String> {
        Binding(
            get: {
                moderationRejectionNotes[reviewKey] ?? ""
            },
            set: { note in
                moderationRejectionNotes[reviewKey] = note
            }
        )
    }

    private func moderationInstructionText(
        in row: HQWindowRowFixture
    ) -> [String] {
        var values: [String] = []
        for key in [
            "instructions",
            "instructionDocuments",
            "instructionFiles",
        ] {
            if let value = row.metadata[key] {
                values.append(contentsOf: instructionTextValues(in: value))
            }
        }
        if let directText = row.metadata["text"]?.stringValue {
            values.append(directText)
        }

        var seen: Set<String> = []
        return values.compactMap { value in
            let trimmed = value.trimmingCharacters(
                in: .whitespacesAndNewlines
            )
            guard !trimmed.isEmpty, seen.insert(trimmed).inserted else {
                return nil
            }
            return trimmed
        }
    }

    private func instructionTextValues(
        in value: HQJSONValue
    ) -> [String] {
        switch value {
        case let .array(values):
            return values.flatMap(instructionTextValues)
        case let .object(object):
            var values = object["text"]?.stringValue.map { [$0] } ?? []
            for (key, child) in object where key != "text" {
                values.append(contentsOf: instructionTextValues(in: child))
            }
            return values
        case let .string(value):
            return [value]
        case .null, .bool, .number:
            return []
        }
    }

    private func moderationEvidence(
        instructionText: [String],
        injectionScan: HQJSONValue?
    ) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Instruction review")
                .font(.caption.weight(.semibold))
            if instructionText.isEmpty {
                Text("No instruction text was returned for this listing.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(
                    Array(instructionText.prefix(8).enumerated()),
                    id: \.offset
                ) { _, text in
                    Text(text)
                        .font(.caption)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }

            Divider()
            Text("Injection scan")
                .font(.caption.weight(.semibold))
            if let injectionScan {
                let lines = moderationScanLines(from: injectionScan)
                if lines.isEmpty {
                    Text("The scan returned no displayable fields.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(
                        Array(lines.prefix(12).enumerated()),
                        id: \.offset
                    ) { _, line in
                        Text(line)
                            .font(.caption.monospaced())
                            .textSelection(.enabled)
                    }
                }
            } else {
                Text("No injection-scan result was returned.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(10)
        .background(
            HQPalette.muted.opacity(0.55),
            in: RoundedRectangle(cornerRadius: 10)
        )
        .accessibilityIdentifier("moderation.evidence")
    }

    private func moderationScanLines(
        from value: HQJSONValue,
        prefix: String? = nil
    ) -> [String] {
        switch value {
        case let .object(object):
            return object.keys.sorted().flatMap { key in
                guard let child = object[key] else {
                    return [String]()
                }
                let childPrefix = [prefix, metadataLabel(key)]
                    .compactMap { $0 }
                    .joined(separator: " · ")
                return moderationScanLines(
                    from: child,
                    prefix: childPrefix
                )
            }
        case let .array(values):
            return values.enumerated().flatMap { index, child in
                moderationScanLines(
                    from: child,
                    prefix: "\(prefix ?? "Item") \(index + 1)"
                )
            }
        case .null:
            return prefix.map { ["\($0): —"] } ?? []
        case .bool, .number, .string:
            guard let displayValue = value.displayValue else { return [] }
            return ["\(prefix ?? "Result"): \(displayValue)"]
        }
    }

    private func metadataLabel(_ key: String) -> String {
        key
            .replacingOccurrences(of: "_", with: " ")
            .replacingOccurrences(of: "-", with: " ")
            .capitalized
    }

    private func moderationParams(
        id: String,
        decision: String,
        note: String?,
        versionLock: String?
    ) -> HQJSONValue {
        .object([
            "id": .string(id),
            "decision": .string(decision),
            "note": note.map(HQJSONValue.string) ?? .null,
            "versionLock": versionLock.map(HQJSONValue.string) ?? .null,
        ])
    }

    private func fileWorkspaceSlug(
        for path: String,
        row: HQWindowRowFixture
    ) -> String? {
        if case let .files(slug, _) = route, let slug {
            return slug
        }
        if let companySlug = metadataString("companySlug", in: row)
            ?? metadataString("workspaceSlug", in: row)
        {
            return companySlug
        }
        let components = URL(fileURLWithPath: path).pathComponents
        guard let companiesIndex = components.firstIndex(of: "companies"),
              components.indices.contains(companiesIndex + 1)
        else {
            return nil
        }
        return components[companiesIndex + 1]
    }

    private func metadataString(
        _ key: String,
        in row: HQWindowRowFixture
    ) -> String? {
        guard case let .string(value)? = row.metadata[key] else { return nil }
        return value
    }

    private func metadataBool(
        _ key: String,
        in row: HQWindowRowFixture
    ) -> Bool? {
        guard case let .bool(value)? = row.metadata[key] else { return nil }
        return value
    }

    private func localAbsolutePath(for relativePath: String) -> String? {
        if relativePath.hasPrefix("/") {
            return relativePath
        }
        guard let companyPath = store.content.snapshot.workspaces
            .compactMap(\.path)
            .first
        else {
            return nil
        }
        let hqRoot = companyPath
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        return hqRoot
            .appendingPathComponent(relativePath)
            .standardizedFileURL
            .path
    }

    private func projectList(
        title: String,
        detail: String,
        rows: [HQProject]? = nil
    ) -> some View {
        let visibleProjects = rows ?? projects
        return HQGlassCard {
            HQSectionTitle(title: title, detail: detail)
            Divider().padding(.vertical, 8)
            if visibleProjects.isEmpty {
                Text("No projects are available from the live engine.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(visibleProjects) { project in
                    Button {
                        navigate(
                            .project(
                                company: project.companySlug,
                                projectID: project.id
                            )
                        )
                    } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(project.title)
                                    .font(.subheadline.weight(.semibold))
                                Text(
                                    project.summary.isEmpty
                                        ? project.path.path
                                        : project.summary
                                )
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                            }
                            Spacer()
                            HQStatusPill(text: project.status)
                            Image(systemName: "chevron.right")
                                .foregroundStyle(.tertiary)
                        }
                        .padding(.vertical, 7)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("live.project.\(project.id)")
                }
            }
        }
    }

    private func projectList(
        title: String,
        detail: String,
        project: HQProject
    ) -> some View {
        HQGlassCard {
            HQSectionTitle(title: title, detail: detail)
            Divider().padding(.vertical, 8)
            if project.tasks.isEmpty {
                Text("No task rows are available from the current engine response.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(project.tasks) { task in
                    Button {
                        navigate(
                            .task(
                                company: project.companySlug,
                                projectID: project.id,
                                taskID: task.id
                            )
                        )
                    } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(task.title)
                                    .font(.subheadline.weight(.semibold))
                                Text(task.detail)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                            }
                            Spacer()
                            HQStatusPill(text: task.state.rawValue)
                            Image(systemName: "chevron.right")
                                .foregroundStyle(.tertiary)
                        }
                        .padding(.vertical, 7)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("live.task.\(task.id)")
                }
            }
        }
    }

    @ViewBuilder
    private func liveValue(_ label: String, value: String) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(label)
                .foregroundStyle(.secondary)
            Spacer()
            Text(value)
                .multilineTextAlignment(.trailing)
                .textSelection(.enabled)
        }
        .font(.subheadline)
        .padding(.vertical, 4)
    }

    private var title: String {
        switch route {
        case let .global(destination):
            destination.rawValue
                .replacingOccurrences(of: "-", with: " ")
                .capitalized
        case let .library(section):
            "Library · \(section.rawValue.capitalized)"
        case .files:
            "Files"
        case let .company(slug, section):
            "\(slug.capitalized) · \(section.rawValue.capitalized)"
        case let .settings(section):
            "Settings · \(section.rawValue.capitalized)"
        case let .project(_, projectID):
            projects.first { $0.id == projectID }?.title ?? projectID
        case let .task(_, projectID, taskID):
            projects.first { $0.id == projectID }?
                .tasks.first { $0.id == taskID }?.title ?? taskID
        }
    }

    private var subtitle: String {
        if store.launchMode == .visualTourFixture {
            "Deterministic visual-tour data rendered through the production-native screen."
        } else {
            "Live data from the bundled HQ engine. Preview data is never substituted."
        }
    }
}

private struct HQMarketplaceProgressView: View {
    @ObservedObject var events: HQNativeParityEventConsumer

    var body: some View {
        let marketplaceLog = events.marketplaceLog
        let progressRows = events.installProgressByHandle
            .values
            .sorted { $0.handle < $1.handle }

        HQGlassCard {
            HQSectionTitle(
                title: "Install progress",
                detail: progressRows.contains(where: { !$0.finished })
                    ? "Installing"
                    : "Native marketplace event stream"
            )
            Divider().padding(.vertical, 8)

            if progressRows.isEmpty, marketplaceLog.isEmpty {
                Text(
                    "Choose an explicit target on a listing to begin an install."
                )
                .font(.caption)
                .foregroundStyle(.secondary)
            } else {
                ForEach(progressRows, id: \.handle) { progress in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        if progress.finished {
                            Image(
                                systemName: progress.error == nil
                                    ? "checkmark.circle"
                                    : "exclamationmark.triangle"
                            )
                        } else {
                            ProgressView()
                                .controlSize(.small)
                        }
                        VStack(alignment: .leading, spacing: 2) {
                            Text(progress.line)
                                .font(.caption.monospaced())
                                .textSelection(.enabled)
                            if let error = progress.error {
                                Text(error)
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                                    .textSelection(.enabled)
                            }
                        }
                    }
                    .accessibilityIdentifier(
                        "marketplace.progress.\(progress.handle.hqIdentifier)"
                    )
                }

                ForEach(
                    Array(marketplaceLog.suffix(12).enumerated()),
                    id: \.offset
                ) { _, line in
                    Text(line)
                        .font(.caption.monospaced())
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .accessibilityIdentifier("marketplace.progress")
    }
}

private struct HQRouteView: View {
    let route: HQRoute
    let fixture: HQShellFixture
    let navigate: (HQRoute) -> Void

    @ViewBuilder
    var body: some View {
        switch route {
        case let .global(destination):
            global(destination)
        case let .library(section):
            HQLibraryView(section: section, fixture: fixture)
        case let .settings(section):
            HQSettingsView(section: section)
        case let .files(slug, path):
            HQFilesView(slug: slug, path: path, fixture: fixture)
        case let .company(slug, section):
            HQCompanyView(
                slug: slug,
                section: section,
                fixture: fixture,
                navigate: navigate
            )
        case let .project(company, projectID):
            HQProjectView(
                company: company,
                projectID: projectID,
                fixture: fixture,
                navigate: navigate
            )
        case let .task(company, projectID, taskID):
            HQTaskView(
                company: company,
                projectID: projectID,
                taskID: taskID,
                fixture: fixture,
                navigate: navigate
            )
        }
    }

    @ViewBuilder
    private func global(_ destination: HQGlobalRoute) -> some View {
        switch destination {
        case .home:
            HQHomeView(fixture: fixture, navigate: navigate)
        case .missionControl:
            HQMissionControlView(fixture: fixture)
        case .inbox:
            HQInboxView(fixture: fixture)
        case .meetings:
            HQMeetingsView(fixture: fixture)
        case .marketplace:
            HQMarketplaceView(fixture: fixture)
        case .moderation:
            HQModerationView(fixture: fixture)
        case .library:
            HQLibraryView(section: .skills, fixture: fixture)
        case .files:
            HQFilesView(slug: nil, path: nil, fixture: fixture)
        case .settings:
            HQSettingsView(section: .sync)
        }
    }
}

// MARK: - Global views

private struct HQHomeView: View {
    let fixture: HQShellFixture
    let navigate: (HQRoute) -> Void

    private let metricColumns = [
        GridItem(.adaptive(minimum: 175), spacing: 14),
    ]

    var body: some View {
        HQPage(
            eyebrow: "Sunday, July 26",
            title: "Good afternoon, Corey",
            subtitle: "Here is what needs attention across your companies.",
            identifier: "screen.home"
        ) {
            LazyVGrid(columns: metricColumns, spacing: 14) {
                HQMetricCard(label: "Companies", value: "3", detail: "2 connected", symbol: "building.2")
                HQMetricCard(label: "Active projects", value: "2", detail: "7 tasks moving", symbol: "rectangle.stack")
                HQMetricCard(label: "Needs you", value: "3", detail: "1 conflict · 2 decisions", symbol: "exclamationmark.circle")
                HQMetricCard(label: "Agent sessions", value: "4", detail: "2 running now", symbol: "bolt.horizontal.circle")
            }

            HStack(alignment: .top, spacing: 16) {
                HQGlassCard {
                    HQSectionTitle(
                        title: "Needs you",
                        detail: "Decisions and safety checks",
                        action: "Review all"
                    )
                    Divider().padding(.vertical, 8)
                    needRow(
                        symbol: "person.crop.circle.badge.plus",
                        title: "Accept Indigo company invite",
                        detail: "Invited by Alex · expires in 6 days",
                        action: "Accept"
                    )
                    needRow(
                        symbol: "arrow.triangle.branch",
                        title: "Resolve README conflict",
                        detail: "Indigo / native-macos · changed on two devices",
                        action: "Compare"
                    )
                    needRow(
                        symbol: "shield.lefthalf.filled",
                        title: "Review core customization",
                        detail: "1 modified file can be restored safely",
                        action: "Review"
                    )
                }

                HQGlassCard {
                    HQSectionTitle(
                        title: "Today",
                        detail: "Meetings and active work",
                        action: "Open calendar"
                    )
                    Divider().padding(.vertical, 8)
                    ForEach(Array(fixture.meetings.prefix(3))) { meeting in
                        HStack(spacing: 12) {
                            VStack(spacing: 2) {
                                Text(meeting.time)
                                    .font(.caption.weight(.semibold))
                                Text(meeting.duration)
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }
                            .frame(width: 62)
                            Divider().frame(height: 35)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(meeting.title)
                                    .font(.subheadline.weight(.medium))
                                Text("\(meeting.company) · \(meeting.attendees) people")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            HQStatusPill(text: meeting.state, emphasized: meeting.state == "Live now")
                        }
                        .padding(.vertical, 6)
                    }
                }
            }

            HQGlassCard {
                HQSectionTitle(
                    title: "Portfolio",
                    detail: "Work moving across every company",
                    action: "View projects"
                )
                Divider().padding(.vertical, 8)
                ForEach(fixture.snapshot.projects) { project in
                    Button {
                        navigate(.project(company: project.companySlug, projectID: project.id))
                    } label: {
                        HStack(spacing: 14) {
                            RoundedRectangle(cornerRadius: 3)
                                .fill(HQPalette.ink)
                                .frame(width: 4, height: 38)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(project.title)
                                    .font(.subheadline.weight(.semibold))
                                Text(project.summary)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                            }
                            Spacer()
                            Text(project.companySlug.capitalized)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            HQStatusPill(text: project.status)
                            Image(systemName: "chevron.right")
                                .font(.caption)
                                .foregroundStyle(.tertiary)
                        }
                        .padding(.vertical, 7)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("home.project.\(project.id)")
                }
            }

            HQGlassCard {
                HQSectionTitle(title: "Recent activity", detail: "Latest changes from people and agents")
                Divider().padding(.vertical, 8)
                ForEach(fixture.activity) { item in
                    HQActivityRow(item: item)
                }
            }
        }
    }

    @ViewBuilder
    private func needRow(symbol: String, title: String, detail: String, action: String) -> some View {
        HStack(spacing: 12) {
            Image(systemName: symbol)
                .frame(width: 26, height: 26)
                .background(HQPalette.muted, in: RoundedRectangle(cornerRadius: 8))
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.subheadline.weight(.medium))
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Group {
                switch action {
                case "Accept":
                    HQActionButton(
                        action,
                        command: .claimPendingCompanyInvite,
                        params: .object(["companySlug": .string("indigo")]),
                        successMessage: "Company invitation accepted."
                    )
                case "Compare":
                    HQActionButton(
                        action,
                        action: .navigate(.files(slug: "indigo", path: nil))
                    )
                case "Review":
                    HQActionButton(action, action: .openScene(.drift))
                default:
                    HQUnavailableButton(
                        title: action,
                        reason: "No live action is registered for \(action)."
                    )
                }
            }
            .controlSize(.small)
            .accessibilityIdentifier("home.\(action.hqIdentifier)")
        }
        .padding(.vertical, 6)
    }
}

private struct HQMissionControlView: View {
    let fixture: HQShellFixture

    var body: some View {
        HQPage(
            eyebrow: "Live operations",
            title: "Mission Control",
            subtitle: "Agents, open questions, and recent runs in one operational view.",
            identifier: "screen.mission-control"
        ) {
            HStack(spacing: 14) {
                HQMetricCard(label: "Running", value: "2", detail: "Parker · Engineering", symbol: "bolt.fill")
                HQMetricCard(label: "Awaiting you", value: "2", detail: "Decisions block progress", symbol: "person.crop.circle.badge.questionmark")
                HQMetricCard(label: "Completed today", value: "11", detail: "94% successful", symbol: "checkmark.circle")
                HQMetricCard(label: "Outposts", value: "3", detail: "All reachable", symbol: "network")
            }

            HStack(alignment: .top, spacing: 16) {
                HQGlassCard {
                    HQSectionTitle(title: "Live sessions", detail: "Streaming from local and fleet agents")
                    Divider().padding(.vertical, 8)
                    ForEach(fixture.people.filter { $0.role == "Agent" }) { person in
                        HStack(spacing: 12) {
                            HQAvatar(initials: person.initials)
                            VStack(alignment: .leading, spacing: 3) {
                                HStack {
                                    Text(person.name).font(.subheadline.weight(.semibold))
                                    HQStatusPill(text: person.status, emphasized: person.status == "Running")
                                }
                                Text(person.focus)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            HQActionButton(
                                "Open",
                                command: .listAgentSessions,
                                params: .object(["agentId": .string(person.id)]),
                                successMessage: "Loaded sessions for \(person.name)."
                            )
                                .controlSize(.small)
                                .accessibilityIdentifier("mission.open.\(person.id)")
                        }
                        .padding(.vertical, 7)
                    }
                }

                HQGlassCard {
                    HQSectionTitle(title: "Questions", detail: "Agents waiting for a decision")
                    Divider().padding(.vertical, 8)
                    question(
                        agent: "Engineering",
                        prompt: "Use SwiftUI NavigationSplitView as the permanent shell?",
                        time: "4m"
                    )
                    question(
                        agent: "Parker",
                        prompt: "Promote the direct proof concept to production testing?",
                        time: "21m"
                    )
                }
            }

            HQGlassCard {
                HQSectionTitle(title: "Team channel", detail: "Coordination from all active agents", action: "Open messages")
                Divider().padding(.vertical, 8)
                ForEach(Array(fixture.messages.prefix(3))) { message in
                    HStack(alignment: .top, spacing: 12) {
                        HQAvatar(initials: message.initials, size: 30)
                        VStack(alignment: .leading, spacing: 3) {
                            HStack {
                                Text(message.person).font(.subheadline.weight(.semibold))
                                Text(message.time).font(.caption2).foregroundStyle(.secondary)
                            }
                            Text(message.preview).font(.subheadline)
                        }
                    }
                    .padding(.vertical, 5)
                }
                HStack {
                    TextField("Message the active team…", text: .constant(""))
                        .textFieldStyle(.plain)
                        .disabled(true)
                        .help("Sending team messages requires the unavailable messages.send capability.")
                    HQActionButton(
                        action: .capabilityUnavailable(
                            reason: "Enter a message before sending it."
                        )
                    ) {
                        Image(systemName: "arrow.up.circle.fill")
                    }
                    .disabled(true)
                    .help("Enter a message before sending it.")
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("mission.send-message")
                }
                .padding(10)
                .background(HQPalette.muted, in: RoundedRectangle(cornerRadius: 10))
                .padding(.top, 8)
            }
        }
    }

    @ViewBuilder
    private func question(agent: String, prompt: String, time: String) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack {
                Text(agent).font(.caption.weight(.semibold))
                Spacer()
                Text(time).font(.caption2).foregroundStyle(.secondary)
            }
            Text(prompt).font(.subheadline)
            HStack {
                HQActionButton(
                    "Approve",
                    command: .answerAgencyQuestion,
                    params: .object([
                        "questionId": .string(agent.hqIdentifier),
                        "answer": .string("approved"),
                    ]),
                    successMessage: "Answered \(agent)."
                )
                .controlSize(.small)
                HQUnavailableButton(
                    title: "Answer…",
                    reason: "A custom answer requires the dedicated decision editor."
                )
                .controlSize(.small)
            }
        }
        .padding(.vertical, 8)
    }
}

private struct HQInboxView: View {
    let fixture: HQShellFixture
    @State private var selectedID: String
    @State private var reply = ""

    init(fixture: HQShellFixture) {
        self.fixture = fixture
        _selectedID = State(initialValue: fixture.messages.first?.id ?? "")
    }

    var body: some View {
        HQPage(
            eyebrow: "Unified inbox",
            title: "Inbox",
            subtitle: "Direct messages, agent updates, requests, and shared work.",
            identifier: "screen.inbox"
        ) {
            HStack(alignment: .top, spacing: 16) {
                HQGlassCard {
                    HStack {
                        Text("Recent").font(.headline)
                        Spacer()
                        HQStatusPill(text: "2 unread", emphasized: true)
                    }
                    Divider().padding(.vertical, 8)

                    ForEach(fixture.messages) { message in
                        Button {
                            selectedID = message.id
                        } label: {
                            HStack(alignment: .top, spacing: 11) {
                                HQAvatar(initials: message.initials)
                                VStack(alignment: .leading, spacing: 3) {
                                    HStack {
                                        Text(message.person).font(.subheadline.weight(.semibold))
                                        Spacer()
                                        Text(message.time).font(.caption2).foregroundStyle(.secondary)
                                    }
                                    Text(message.preview)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                        .lineLimit(2)
                                    Text(message.kind.uppercased())
                                        .font(.system(size: 9, weight: .semibold))
                                        .tracking(0.7)
                                        .foregroundStyle(.secondary)
                                }
                                if message.unread {
                                    Circle().fill(HQPalette.ink).frame(width: 7, height: 7)
                                }
                            }
                            .padding(9)
                            .background(
                                selectedID == message.id ? HQPalette.selection : Color.clear,
                                in: RoundedRectangle(cornerRadius: 11)
                            )
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("inbox.thread.\(message.id)")
                    }
                }
                .frame(maxWidth: 390)

                HQGlassCard {
                    if let message = fixture.messages.first(where: { $0.id == selectedID }) {
                        HStack {
                            HQAvatar(initials: message.initials, size: 40)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(message.person).font(.headline)
                                Text(message.kind).font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            HQActionButton(action: .openScene(.messages)) {
                                Image(systemName: "ellipsis")
                            }
                                .buttonStyle(.plain)
                                .accessibilityIdentifier("inbox.more")
                        }
                        Divider().padding(.vertical, 8)
                        Spacer(minLength: 24)
                        VStack(alignment: .leading, spacing: 5) {
                            Text(message.detail)
                                .font(.body)
                                .padding(13)
                                .background(HQPalette.muted, in: RoundedRectangle(cornerRadius: 14))
                            Text("Today at \(message.time)")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                        Spacer(minLength: 90)
                        HStack(alignment: .bottom, spacing: 8) {
                            TextField("Reply to \(message.person)…", text: $reply, axis: .vertical)
                                .textFieldStyle(.plain)
                                .lineLimit(1 ... 4)
                            Button {
                                reply = ""
                            } label: {
                                Image(systemName: "arrow.up.circle.fill").font(.title2)
                            }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("inbox.send")
                        }
                        .padding(12)
                        .background(HQPalette.muted, in: RoundedRectangle(cornerRadius: 14))
                    }
                }
                .frame(maxWidth: .infinity, minHeight: 430)
            }
        }
    }
}

private struct HQMeetingsView: View {
    let fixture: HQShellFixture

    var body: some View {
        HQPage(
            eyebrow: "Calendar intelligence",
            title: "Meetings",
            subtitle: "Your agenda, active capture, connected calendars, and bot health.",
            identifier: "screen.meetings"
        ) {
            if let live = fixture.meetings.first {
                HQGlassCard {
                    HStack(spacing: 16) {
                        ZStack {
                            Circle().fill(HQPalette.active).frame(width: 52, height: 52)
                            Image(systemName: "waveform").font(.title2)
                        }
                        VStack(alignment: .leading, spacing: 5) {
                            HStack {
                                HQStatusPill(text: "LIVE NOW", emphasized: true)
                                Text(live.time).font(.caption).foregroundStyle(.secondary)
                            }
                            Text(live.title).font(.title3.weight(.semibold))
                            Text("\(live.company) · \(live.attendees) attendees · Recording locally")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        HQActionButton(
                            "Open meeting",
                            action: .openScene(.meetings)
                        )
                            .accessibilityIdentifier("meetings.open-live")
                        HQActionButton(
                            "Stop",
                            command: .meetingsCancelBot,
                            params: .object([:]),
                            successMessage: "Meeting capture stopped."
                        )
                            .accessibilityIdentifier("meetings.stop-recording")
                    }
                }
            }

            HStack(alignment: .top, spacing: 16) {
                HQGlassCard {
                    HQSectionTitle(title: "Today", detail: "Sunday, July 26", action: "Refresh")
                    Divider().padding(.vertical, 8)
                    ForEach(fixture.meetings) { meeting in
                        HStack(spacing: 14) {
                            Text(meeting.time)
                                .font(.caption.weight(.semibold))
                                .frame(width: 68, alignment: .leading)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(meeting.title).font(.subheadline.weight(.medium))
                                Text("\(meeting.duration) · \(meeting.company)")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            HQStatusPill(text: meeting.state, emphasized: meeting.state == "Live now")
                            HQActionButton(
                                action: .engineCommand(
                                    meeting.state == "Bot invited"
                                        ? .meetingsCancelBot
                                        : .meetingsInviteBot,
                                    params: .object([
                                        "meetingId": .string(meeting.id),
                                    ]),
                                    successMessage: meeting.state == "Bot invited"
                                        ? "Meeting bot invitation cancelled."
                                        : "Meeting bot invited."
                                ),
                                requiredCapability: (
                                    meeting.state == "Bot invited"
                                        ? HQEngineAppCommand.meetingsCancelBot
                                        : HQEngineAppCommand.meetingsInviteBot
                                ).rawValue
                            ) {
                                Image(systemName: meeting.state == "Bot invited" ? "checkmark" : "plus")
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(
                                meeting.state == "Bot invited" ? "Bot invited" : "Invite meeting bot"
                            )
                            .accessibilityIdentifier("meetings.bot.\(meeting.id)")
                        }
                        .padding(.vertical, 8)
                    }
                }

                VStack(spacing: 16) {
                    HQGlassCard {
                        HQSectionTitle(title: "Meeting bot", detail: "Healthy and ready")
                        Divider().padding(.vertical, 8)
                        labeledValue("Recall bridge", value: "Connected")
                        labeledValue("Audio capture", value: "Allowed")
                        labeledValue("Screen detection", value: "Allowed")
                        labeledValue("Last check", value: "Just now")
                    }
                    HQGlassCard {
                        HQSectionTitle(title: "Calendars", detail: "2 connected")
                        Divider().padding(.vertical, 8)
                        calendarRow("Google Calendar", detail: "corey@getindigo.ai")
                        calendarRow("Outlook", detail: "Corey Epstein")
                        HQActionButton(
                            "Manage calendars",
                            command: .meetingsListAccounts,
                            successMessage: "Calendar accounts refreshed."
                        )
                            .controlSize(.small)
                            .padding(.top, 8)
                            .accessibilityIdentifier("meetings.manage-calendars")
                    }
                    HQGlassCard {
                        Text("Invite by URL").font(.headline)
                        Text("Paste a Zoom, Meet, or Teams link.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        HStack {
                            TextField("https://…", text: .constant(""))
                                .textFieldStyle(.plain)
                                .disabled(true)
                                .help("Meeting invitations require the unavailable meetings.invite capability.")
                            HQUnavailableButton(
                                title: "Invite",
                                reason: "Enter a supported meeting URL before inviting the meeting bot."
                            )
                            .controlSize(.small)
                        }
                        .padding(10)
                        .background(HQPalette.muted, in: RoundedRectangle(cornerRadius: 10))
                    }
                }
                .frame(maxWidth: 340)
            }
        }
    }

    @ViewBuilder
    private func labeledValue(_ label: String, value: String) -> some View {
        HStack {
            Text(label).font(.caption).foregroundStyle(.secondary)
            Spacer()
            Text(value).font(.caption.weight(.medium))
        }
        .padding(.vertical, 4)
    }

    @ViewBuilder
    private func calendarRow(_ name: String, detail: String) -> some View {
        HStack(spacing: 10) {
            Image(systemName: "calendar").frame(width: 24)
            VStack(alignment: .leading) {
                Text(name).font(.caption.weight(.medium))
                Text(detail).font(.caption2).foregroundStyle(.secondary)
            }
            Spacer()
            Circle().fill(HQPalette.ink).frame(width: 6, height: 6)
        }
        .padding(.vertical, 5)
    }
}

private struct HQMarketplaceView: View {
    let fixture: HQShellFixture
    @State private var search = ""
    @State private var selectedID: String

    init(fixture: HQShellFixture) {
        self.fixture = fixture
        _selectedID = State(initialValue: fixture.packs.first?.id ?? "")
    }

    var body: some View {
        HQPage(
            eyebrow: "Approved capabilities",
            title: "Marketplace",
            subtitle: "Discover trusted packs that extend what your HQ team can do.",
            identifier: "screen.marketplace"
        ) {
            HStack {
                HStack {
                    Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                    TextField("Search skills, workers, and packs", text: $search)
                        .textFieldStyle(.plain)
                }
                .padding(11)
                .hqAdaptiveGlassSurface(cornerRadius: 12)
                Picker("Category", selection: .constant("All")) {
                    Text("All").tag("All")
                    Text("Development").tag("Development")
                    Text("Marketing").tag("Marketing")
                    Text("Knowledge").tag("Knowledge")
                }
                .frame(width: 170)
                .accessibilityIdentifier("marketplace.category")
                .disabled(true)
                .help("Category filtering requires the unavailable marketplace.search capability.")
            }

            HStack(alignment: .top, spacing: 16) {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 220), spacing: 14)], spacing: 14) {
                    ForEach(filteredPacks) { pack in
                        Button {
                            selectedID = pack.id
                        } label: {
                            HQGlassCard {
                                HStack {
                                    Image(systemName: pack.symbol)
                                        .font(.title2)
                                        .frame(width: 42, height: 42)
                                        .background(HQPalette.muted, in: RoundedRectangle(cornerRadius: 12))
                                    Spacer()
                                    if pack.installed {
                                        HQStatusPill(text: "Installed")
                                    }
                                }
                                Text(pack.title).font(.headline).padding(.top, 12)
                                Text(pack.detail)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(3)
                                    .padding(.vertical, 6)
                                HStack {
                                    Text(pack.category)
                                    Spacer()
                                    Text("\(pack.installs) installs")
                                }
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                            }
                            .overlay {
                                RoundedRectangle(cornerRadius: HQSpacing.radius)
                                    .stroke(
                                        selectedID == pack.id ? HQPalette.ink.opacity(0.35) : .clear,
                                        lineWidth: 1.5
                                    )
                            }
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("marketplace.pack.\(pack.id)")
                    }
                }

                if let pack = fixture.packs.first(where: { $0.id == selectedID }) {
                    HQGlassCard {
                        Image(systemName: pack.symbol)
                            .font(.system(size: 31))
                            .frame(width: 62, height: 62)
                            .background(HQPalette.muted, in: RoundedRectangle(cornerRadius: 17))
                        Text(pack.title).font(.title2.weight(.semibold)).padding(.top, 12)
                        Text("by \(pack.author)").font(.caption).foregroundStyle(.secondary)
                        Text(pack.detail).font(.subheadline).padding(.vertical, 12)
                        Divider()
                        Text("INCLUDES").font(.caption2.weight(.semibold)).tracking(1).padding(.top, 12)
                        Label("8 production-ready skills", systemImage: "checkmark")
                        Label("2 specialized workers", systemImage: "checkmark")
                        Label("Automatic updates", systemImage: "checkmark")
                        Spacer(minLength: 18)
                        HQActionButton(
                            pack.installed ? "Manage pack" : "Install pack",
                            command: pack.installed
                                ? .getMarketplaceListing
                                : .installMarketplacePack,
                            params: .object(["packId": .string(pack.id)]),
                            successMessage: pack.installed
                                ? "Pack details refreshed."
                                : "Pack installed."
                        )
                            .frame(maxWidth: .infinity)
                            .accessibilityIdentifier("marketplace.install")
                    }
                    .frame(width: 285)
                    .frame(minHeight: 390)
                }
            }
        }
    }

    private var filteredPacks: [HQPackFixture] {
        guard !search.isEmpty else { return fixture.packs }
        return fixture.packs.filter {
            $0.title.localizedCaseInsensitiveContains(search)
                || $0.detail.localizedCaseInsensitiveContains(search)
        }
    }
}

private struct HQModerationView: View {
    let fixture: HQShellFixture

    var body: some View {
        HQPage(
            eyebrow: "Administrator",
            title: "Moderation",
            subtitle: "Review marketplace submissions, creator access, and emergency actions.",
            identifier: "screen.moderation"
        ) {
            HStack(spacing: 14) {
                HQMetricCard(label: "Pending review", value: "3", detail: "Oldest is 8 hours", symbol: "clock")
                HQMetricCard(label: "Creator requests", value: "2", detail: "Identity verified", symbol: "person.badge.plus")
                HQMetricCard(label: "Flagged findings", value: "1", detail: "Injection scan", symbol: "exclamationmark.shield")
            }

            HQGlassCard {
                HQSectionTitle(title: "Pack review queue", detail: "Default deny until approved")
                Divider().padding(.vertical, 8)
                moderationRow(
                    name: "Research Desk",
                    author: "Maya Chen",
                    finding: "Clean · 12 files scanned",
                    age: "2h"
                )
                moderationRow(
                    name: "Revenue Intelligence",
                    author: "Alex Morgan",
                    finding: "1 instruction requires review",
                    age: "5h"
                )
                moderationRow(
                    name: "Customer Voice",
                    author: "Jamie Lee",
                    finding: "Clean · 7 files scanned",
                    age: "8h"
                )
            }

            HStack(alignment: .top, spacing: 16) {
                HQGlassCard {
                    HQSectionTitle(title: "Creator applications", detail: "2 ready")
                    Divider().padding(.vertical, 8)
                    personApplication("Jordan Kim", handle: "@jordank", packs: "3 submitted")
                    personApplication("Sam Ortiz", handle: "@samortiz", packs: "1 submitted")
                }
                HQGlassCard {
                    HQSectionTitle(title: "Emergency controls", detail: "Actions are audited")
                    Divider().padding(.vertical, 8)
                    Text("Immediately remove a compromised listing from every Marketplace surface.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    HQUnavailableButton(
                        title: "Yank listing…",
                        reason: "Choose a marketplace listing before using the audited yank workflow."
                    )
                        .padding(.top, 10)
                        .accessibilityIdentifier("moderation.yank")
                }
            }
        }
    }

    @ViewBuilder
    private func moderationRow(name: String, author: String, finding: String, age: String) -> some View {
        HStack(spacing: 12) {
            Image(systemName: "shippingbox")
                .frame(width: 34, height: 34)
                .background(HQPalette.muted, in: RoundedRectangle(cornerRadius: 9))
            VStack(alignment: .leading, spacing: 3) {
                Text(name).font(.subheadline.weight(.semibold))
                Text("\(author) · \(finding)").font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            Text(age).font(.caption2).foregroundStyle(.secondary)
            HQActionButton(
                "Review",
                command: .getMarketplaceListing,
                params: .object(["name": .string(name)]),
                successMessage: "Loaded \(name) for moderation."
            )
            .controlSize(.small)
        }
        .padding(.vertical, 7)
    }

    @ViewBuilder
    private func personApplication(_ name: String, handle: String, packs: String) -> some View {
        HStack {
            HQAvatar(initials: String(name.split(separator: " ").compactMap(\.first)), size: 32)
            VStack(alignment: .leading) {
                Text(name).font(.subheadline.weight(.medium))
                Text("\(handle) · \(packs)").font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            HQUnavailableButton(
                title: "Approve",
                reason: "Creator approval requires a selected moderation application record."
            )
            .controlSize(.small)
        }
        .padding(.vertical, 6)
    }
}

// MARK: - Library and files

private struct HQLibraryView: View {
    let fixture: HQShellFixture
    @State private var section: HQLibrarySection
    @State private var search = ""

    init(section: HQLibrarySection, fixture: HQShellFixture) {
        self.fixture = fixture
        _section = State(initialValue: section)
    }

    var body: some View {
        HQPage(
            eyebrow: "Reusable capability",
            title: "Library",
            subtitle: "Your installed skills, workers, packs, and creator identity.",
            identifier: "screen.library.\(section.rawValue)"
        ) {
            Picker("Library section", selection: $section) {
                ForEach(HQLibrarySection.allCases, id: \.self) {
                    Text($0.rawValue.capitalized).tag($0)
                }
            }
            .pickerStyle(.segmented)
            .accessibilityIdentifier("library.tabs")

            HStack {
                HStack {
                    Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                    TextField("Search \(section.rawValue)", text: $search).textFieldStyle(.plain)
                }
                .padding(11)
                .hqAdaptiveGlassSurface(cornerRadius: 12)
                Group {
                    if section == .profile {
                        HQUnavailableButton(
                            title: "Edit profile",
                            reason: "Profile editing requires the creator-profile form workflow."
                        )
                    } else {
                        HQActionButton(
                            action: .navigate(.global(.marketplace))
                        ) {
                            Label("Add from Marketplace", systemImage: "plus")
                        }
                    }
                }
                .accessibilityIdentifier("library.primary-action")
            }

            switch section {
            case .skills:
                libraryCollection(kind: "Skill", emptyTitle: "No skills found")
            case .workers:
                libraryCollection(kind: "Worker", emptyTitle: "No workers found")
            case .installed:
                installedPacks
            case .profile:
                creatorProfile
            }
        }
    }

    @ViewBuilder
    private func libraryCollection(kind: String, emptyTitle: String) -> some View {
        let items = fixture.libraryItems.filter {
            $0.kind == kind && (search.isEmpty || $0.name.localizedCaseInsensitiveContains(search))
        }
        if items.isEmpty {
            HQGlassCard {
                VStack(spacing: 10) {
                    Image(systemName: "shippingbox")
                        .font(.largeTitle)
                        .foregroundStyle(.secondary)
                    Text(emptyTitle)
                        .font(.headline)
                    Text("Try a different search or add one from Marketplace.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, minHeight: 180)
            }
        } else {
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 250), spacing: 14)], spacing: 14) {
                ForEach(items) { item in
                    HQGlassCard {
                        HStack {
                            Image(systemName: item.symbol)
                                .font(.title2)
                                .frame(width: 42, height: 42)
                                .background(HQPalette.muted, in: RoundedRectangle(cornerRadius: 12))
                            Spacer()
                            HQStatusPill(text: item.status)
                        }
                        Text(item.name).font(.headline).padding(.top, 10)
                        Text(item.detail).font(.caption).foregroundStyle(.secondary).padding(.vertical, 5)
                        Text(item.scope).font(.caption2).foregroundStyle(.secondary)
                    }
                    .accessibilityIdentifier("library.item.\(item.id)")
                }
            }
        }
    }

    private var installedPacks: some View {
        HQGlassCard {
            HQSectionTitle(title: "Installed packs", detail: "2 packs · 1 update available", action: "Check for updates")
            Divider().padding(.vertical, 8)
            ForEach(fixture.packs.filter(\.installed)) { pack in
                HStack(spacing: 12) {
                    Image(systemName: pack.symbol)
                        .frame(width: 36, height: 36)
                        .background(HQPalette.muted, in: RoundedRectangle(cornerRadius: 10))
                    VStack(alignment: .leading, spacing: 3) {
                        Text(pack.title).font(.subheadline.weight(.semibold))
                        Text("Installed for Personal · Automatic updates")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    if pack.id == "pack-engineering" {
                        HQStatusPill(text: "Update available", emphasized: true)
                        HQActionButton(
                            "Update",
                            command: .updatePackage,
                            params: .object(["packageId": .string(pack.id)]),
                            successMessage: "\(pack.title) updated."
                        )
                        .controlSize(.small)
                    } else {
                        HQActionButton(
                            "Manage",
                            command: .getMarketplaceListing,
                            params: .object(["packId": .string(pack.id)]),
                            successMessage: "Loaded \(pack.title)."
                        )
                        .controlSize(.small)
                    }
                }
                .padding(.vertical, 8)
            }
        }
    }

    private var creatorProfile: some View {
        HStack(alignment: .top, spacing: 16) {
            HQGlassCard {
                HQAvatar(initials: "CE", size: 74)
                Text("Corey Epstein").font(.title2.weight(.semibold)).padding(.top, 12)
                Text("@corey").font(.subheadline).foregroundStyle(.secondary)
                HQStatusPill(text: "Verified creator", emphasized: true).padding(.vertical, 8)
                Text("Building calm, durable operating systems for people and AI teams.")
                    .font(.subheadline)
                Divider().padding(.vertical, 10)
                labeled("Published packs", "4")
                labeled("Total installs", "8.2k")
                labeled("Followers", "1.3k")
                HQUnavailableButton(
                    title: "Edit creator profile",
                    reason: "Creator profile editing requires the dedicated profile form."
                )
                    .frame(maxWidth: .infinity)
                    .padding(.top, 12)
            }
            .frame(maxWidth: 330)

            HQGlassCard {
                HQSectionTitle(title: "Published work", detail: "Visible in Marketplace")
                Divider().padding(.vertical, 8)
                ForEach(fixture.packs.prefix(3)) { pack in
                    HStack {
                        Image(systemName: pack.symbol).frame(width: 28)
                        VStack(alignment: .leading) {
                            Text(pack.title).font(.subheadline.weight(.medium))
                            Text("\(pack.installs) installs").font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        HQStatusPill(text: "Published")
                    }
                    .padding(.vertical, 7)
                }
            }
        }
    }

    @ViewBuilder
    private func labeled(_ name: String, _ value: String) -> some View {
        HStack {
            Text(name).foregroundStyle(.secondary)
            Spacer()
            Text(value).fontWeight(.semibold)
        }
        .font(.caption)
        .padding(.vertical, 3)
    }
}

private struct HQFilesView: View {
    let slug: String?
    let path: String?
    let fixture: HQShellFixture
    @State private var selectedID: String

    init(slug: String?, path: String?, fixture: HQShellFixture) {
        self.slug = slug
        self.path = path
        self.fixture = fixture
        let matched = fixture.files.first(where: { $0.path == path })
        _selectedID = State(initialValue: matched?.id ?? fixture.files.first?.id ?? "")
    }

    var body: some View {
        HQPage(
            eyebrow: slug?.capitalized ?? "All workspaces",
            title: "Files",
            subtitle: "Browse and preview company knowledge without leaving HQ.",
            identifier: "screen.files"
        ) {
            HStack(alignment: .top, spacing: 16) {
                HQGlassCard {
                    HStack {
                        Text(slug?.capitalized ?? "HQ").font(.headline)
                        Spacer()
                        HQActionButton(action: .refresh) {
                            Image(systemName: "arrow.clockwise")
                        }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("files.refresh")
                    }
                    Divider().padding(.vertical, 8)
                    folder("knowledge", depth: 0)
                    folder("briefs", depth: 1)
                    ForEach(fixture.files) { file in
                        Button {
                            selectedID = file.id
                        } label: {
                            HStack(spacing: 8) {
                                Image(systemName: file.kind == "Markdown" ? "doc.text" : "curlybraces")
                                    .frame(width: 18)
                                Text(file.name).lineLimit(1)
                                Spacer()
                            }
                            .font(.caption)
                            .padding(.leading, 28)
                            .padding(.vertical, 6)
                            .background(
                                selectedID == file.id ? HQPalette.selection : Color.clear,
                                in: RoundedRectangle(cornerRadius: 7)
                            )
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("files.item.\(file.id)")
                    }
                }
                .frame(width: 285)

                if let file = fixture.files.first(where: { $0.id == selectedID }) {
                    HQGlassCard {
                        HStack {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(file.name).font(.headline)
                                Text(file.path).font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            HQActionButton(
                                "Reveal",
                                action: .nativeCommand(
                                    .revealFolder,
                                    payload: .string(file.path)
                                )
                            )
                                .controlSize(.small)
                                .accessibilityIdentifier("files.reveal")
                            HQActionButton(
                                "Open in editor",
                                action: .nativeCommand(
                                    .openInEditor,
                                    payload: .object([
                                        "path": .string(file.path),
                                    ])
                                )
                            )
                                .controlSize(.small)
                                .accessibilityIdentifier("files.open-editor")
                        }
                        Divider().padding(.vertical, 12)
                        Text(file.kind.uppercased())
                            .font(.caption2.weight(.semibold))
                            .tracking(1)
                            .foregroundStyle(.secondary)
                        Text(file.detail)
                            .font(file.kind == "Markdown" ? .body : .system(.body, design: .monospaced))
                            .textSelection(.enabled)
                            .padding(.top, 10)
                            .frame(maxWidth: .infinity, minHeight: 330, alignment: .topLeading)
                        Divider()
                        HStack {
                            Text("Modified \(file.modified)")
                            Spacer()
                            Text("Read-only preview")
                        }
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .padding(.top, 8)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func folder(_ name: String, depth: CGFloat) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "chevron.down").font(.system(size: 8))
            Image(systemName: "folder.fill")
            Text(name)
            Spacer()
        }
        .font(.caption.weight(.medium))
        .padding(.leading, depth * 18)
        .padding(.vertical, 5)
    }
}

// MARK: - Company views

private struct HQCompanyView: View {
    let slug: String
    let fixture: HQShellFixture
    let navigate: (HQRoute) -> Void
    @State private var section: HQCompanySection

    init(
        slug: String,
        section: HQCompanySection,
        fixture: HQShellFixture,
        navigate: @escaping (HQRoute) -> Void
    ) {
        self.slug = slug
        self.fixture = fixture
        self.navigate = navigate
        _section = State(initialValue: section)
    }

    private var company: HQWorkspace? {
        fixture.snapshot.workspaces.first(where: { $0.slug == slug })
    }

    private var companyProjects: [HQProject] {
        fixture.snapshot.projects.filter { $0.companySlug == slug }
    }

    var body: some View {
        HQPage(
            eyebrow: company?.state == .connected ? "Connected company" : "Local company",
            title: company?.name ?? slug.capitalized,
            subtitle: companySubtitle,
            identifier: "screen.company.\(section.rawValue)"
        ) {
            HStack {
                HQStatusPill(
                    text: company?.state == .connected ? "Synced" : "Needs connection",
                    emphasized: company?.state == .connected
                )
                Text("Last synced just now")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
                HQUnavailableButton(
                    title: "New project",
                    reason: "Project creation requires a name and destination from the dedicated project wizard."
                )
                    .accessibilityIdentifier("company.new-project")
                HQActionButton(
                    action: .capabilityUnavailable(
                        reason: "No additional company actions are available for this workspace."
                    )
                ) {
                    Image(systemName: "ellipsis")
                }
                    .disabled(true)
                    .help("No additional company actions are available for this workspace.")
                    .accessibilityIdentifier("company.more-actions")
            }

            switch section {
            case .overview:
                overview
            case .goals:
                goals
            case .projects:
                projects
            case .skills:
                companyLibrary(kind: "Skill")
            case .workers:
                companyLibrary(kind: "Worker")
            case .knowledge:
                knowledge
            case .team:
                team
            case .activity, .deployments, .secrets, .settings:
                operations
            }
        }
    }

    private var companySubtitle: String {
        switch section {
        case .overview: "Company pulse, priorities, and work in motion."
        case .goals: "Objectives and measurable outcomes for the current cycle."
        case .projects: "Plan, track, and open every active workstream."
        case .skills: "Company-scoped skills available to people and agents."
        case .workers: "Specialized agents configured for this company."
        case .knowledge: "Durable context, briefs, decisions, and policies."
        case .team: "People, agents, roles, and recent operating activity."
        case .activity: "Recent changes across this company."
        case .deployments: "Environments, releases, and delivery health."
        case .secrets: "Metadata-only inventory of configured credentials."
        case .settings: "Company identity, cloud connection, and access."
        }
    }

    private var overview: some View {
        VStack(alignment: .leading, spacing: HQSpacing.section) {
            HStack(spacing: 14) {
                HQMetricCard(label: "Active projects", value: "\(companyProjects.count)", detail: "1 needs attention", symbol: "rectangle.stack")
                HQMetricCard(label: "Goals on track", value: "1 of 2", detail: "68% average progress", symbol: "target")
                HQMetricCard(label: "Team activity", value: "47", detail: "Changes this week", symbol: "waveform.path.ecg")
                HQMetricCard(label: "Agents running", value: "2", detail: "No blockers", symbol: "bolt")
            }

            HStack(alignment: .top, spacing: 16) {
                HQGlassCard {
                    HQSectionTitle(title: "Goals", detail: "Current company objectives", action: "View all")
                    Divider().padding(.vertical, 8)
                    ForEach(fixture.snapshot.goals[slug] ?? []) { goal in
                        VStack(alignment: .leading, spacing: 7) {
                            HStack {
                                Text(goal.title).font(.subheadline.weight(.semibold))
                                Spacer()
                                Text("\(Int(goal.progress * 100))%").font(.caption.weight(.semibold))
                            }
                            ProgressView(value: goal.progress)
                                .tint(HQPalette.ink)
                            Text(goal.detail).font(.caption).foregroundStyle(.secondary)
                        }
                        .padding(.vertical, 7)
                    }
                }
                HQGlassCard {
                    HQSectionTitle(title: "Needs you", detail: "Company decisions")
                    Divider().padding(.vertical, 8)
                    Label("Approve native release criteria", systemImage: "checkmark.seal")
                    Label("Resolve one project conflict", systemImage: "arrow.triangle.branch")
                    Label("Review Parker's promoted signal", systemImage: "sparkles")
                    HQActionButton(
                        "Review queue",
                        action: .navigate(.global(.moderation))
                    )
                        .controlSize(.small)
                        .padding(.top, 12)
                }
            }

            HQGlassCard {
                HQSectionTitle(title: "In flight", detail: "Projects with recent activity")
                Divider().padding(.vertical, 8)
                ForEach(companyProjects) { project in
                    projectRow(project)
                }
            }

            HStack {
                Button("Browse company skills") { section = .skills }
                    .accessibilityIdentifier("company.open-skills")
                Button("Meet company workers") { section = .workers }
                    .accessibilityIdentifier("company.open-workers")
                Spacer()
            }
        }
    }

    private var goals: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                HQSectionTitle(title: "Company goals", detail: "Q3 2026 · 2 objectives")
                Spacer()
                HQUnavailableButton(
                    title: "Create goal",
                    reason: "Goal creation is unavailable until the engine exposes goals.create."
                )
                .accessibilityIdentifier("company.create-goal")
            }
            ForEach(fixture.snapshot.goals[slug] ?? []) { goal in
                HQGlassCard {
                    HStack(alignment: .top) {
                        VStack(alignment: .leading, spacing: 8) {
                            Text(goal.title).font(.title3.weight(.semibold))
                            Text(goal.detail).font(.subheadline).foregroundStyle(.secondary)
                            if let owner = goal.owner {
                                Label(owner, systemImage: "person").font(.caption)
                            }
                        }
                        Spacer()
                        Text("\(Int(goal.progress * 100))%")
                            .font(.title2.weight(.semibold))
                    }
                    ProgressView(value: goal.progress)
                        .tint(HQPalette.ink)
                        .padding(.vertical, 10)
                    Divider()
                    HStack {
                        Label("2 key results", systemImage: "checklist")
                        Spacer()
                        Text(goal.progress > 0.6 ? "On track" : "At risk")
                            .font(.caption.weight(.medium))
                    }
                    .font(.caption)
                    .padding(.top, 8)
                }
            }
        }
    }

    private var projects: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Picker("View", selection: .constant("Portfolio")) {
                    Text("Portfolio").tag("Portfolio")
                    Text("List").tag("List")
                }
                .pickerStyle(.segmented)
                .frame(width: 180)
                .disabled(true)
                .help("Alternate layouts require the unavailable projects.view_preferences capability.")
                Spacer()
                HQUnavailableButton(
                    title: "Filter",
                    reason: "Project filtering is unavailable until projects.view_preferences is exposed."
                )
                HQUnavailableButton(
                    title: "New project",
                    reason: "Project creation requires the dedicated project wizard."
                )
            }

            LazyVGrid(columns: [GridItem(.adaptive(minimum: 310), spacing: 14)], spacing: 14) {
                ForEach(companyProjects) { project in
                    Button {
                        navigate(.project(company: slug, projectID: project.id))
                    } label: {
                        HQGlassCard {
                            HStack {
                                HQStatusPill(text: project.status, emphasized: project.livePhase != nil)
                                Spacer()
                                if let livePhase = project.livePhase {
                                    Label(livePhase, systemImage: "bolt.fill")
                                        .font(.caption2)
                                }
                            }
                            Text(project.title).font(.title3.weight(.semibold)).padding(.top, 12)
                            Text(project.summary)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(3)
                                .padding(.vertical, 7)
                            ProgressView(
                                value: Double(project.tasks.filter(\.passes).count),
                                total: Double(max(project.tasks.count, 1))
                            )
                            .tint(HQPalette.ink)
                            HStack {
                                Text("\(project.tasks.filter(\.passes).count)/\(project.tasks.count) tasks")
                                Spacer()
                                Text(project.owner ?? "Unassigned")
                            }
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .padding(.top, 5)
                        }
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("company.project.\(project.id)")
                }
            }
        }
    }

    @ViewBuilder
    private func companyLibrary(kind: String) -> some View {
        HStack {
            HQSectionTitle(title: "\(kind)s", detail: "Scoped to \(company?.name ?? slug.capitalized)")
            Spacer()
            HQUnavailableButton(
                title: "Add \(kind.lowercased())",
                reason: "Adding a \(kind.lowercased()) requires the dedicated library installer."
            )
        }
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 250), spacing: 14)], spacing: 14) {
            ForEach(fixture.libraryItems.filter { $0.kind == kind }) { item in
                HQGlassCard {
                    Image(systemName: item.symbol)
                        .font(.title2)
                        .frame(width: 42, height: 42)
                        .background(HQPalette.muted, in: RoundedRectangle(cornerRadius: 11))
                    Text(item.name).font(.headline).padding(.top, 9)
                        Text(item.detail).font(.caption).foregroundStyle(.secondary).padding(.vertical, 5)
                    HStack {
                        HQStatusPill(text: item.status)
                        Spacer()
                        HQActionButton(
                            "Open",
                            command: kind == "Skill"
                                ? .getLibrarySkillDetail
                                : .getLibraryWorkerDetail,
                            params: .object([
                                "companySlug": .string(slug),
                                "name": .string(item.name),
                            ]),
                            successMessage: "Loaded \(item.name)."
                        )
                        .controlSize(.small)
                    }
                }
            }
        }
    }

    private var knowledge: some View {
        HStack(alignment: .top, spacing: 16) {
            HQGlassCard {
                HQSectionTitle(title: "Knowledge tree", detail: "23 documents")
                Divider().padding(.vertical, 8)
                knowledgeNode("Company brief", symbol: "doc.text", depth: 0)
                knowledgeNode("Decisions", symbol: "folder", depth: 0)
                knowledgeNode("2026-07-20-native-app.md", symbol: "doc", depth: 1)
                knowledgeNode("Meeting notes", symbol: "folder", depth: 0)
                knowledgeNode("Product review.md", symbol: "doc", depth: 1)
                knowledgeNode("Policies", symbol: "folder", depth: 0)
            }
            .frame(width: 310)

            HQGlassCard {
                HStack {
                    VStack(alignment: .leading) {
                        Text("Company brief").font(.headline)
                        Text("knowledge/company-brief.md").font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    HQActionButton(
                        "Open in editor",
                        action: .nativeCommand(
                            .openInEditor,
                            payload: .object([
                                "path": .string(
                                    "companies/\(slug)/knowledge/company-brief.md"
                                ),
                            ])
                        )
                    )
                    .controlSize(.small)
                }
                Divider().padding(.vertical, 12)
                Text("Indigo")
                    .font(.system(size: 25, weight: .semibold, design: .rounded))
                Text(
                    "Indigo builds the shared operating layer for people and AI teams. The company values durable context, narrow permissions, and observable outcomes."
                )
                .font(.body)
                .padding(.vertical, 10)
                Text("Current priorities")
                    .font(.headline)
                    .padding(.top, 8)
                Label("Ship the native macOS experience", systemImage: "circle.fill")
                Label("Accelerate creative learning", systemImage: "circle.fill")
                Label("Strengthen company knowledge freshness", systemImage: "circle.fill")
            }
        }
    }

    private var team: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 14) {
                HQMetricCard(label: "People", value: "2", detail: "Both active this week", symbol: "person.2")
                HQMetricCard(label: "Agents", value: "2", detail: "1 running now", symbol: "bolt")
                HQMetricCard(label: "Sessions", value: "77", detail: "Last 30 days", symbol: "chart.xyaxis.line")
            }
            HQGlassCard {
                HQSectionTitle(title: "Company team", detail: "People and agents", action: "Invite")
                Divider().padding(.vertical, 8)
                ForEach(fixture.people) { person in
                    HStack(spacing: 12) {
                        HQAvatar(initials: person.initials)
                        VStack(alignment: .leading, spacing: 3) {
                            HStack {
                                Text(person.name).font(.subheadline.weight(.semibold))
                                HQStatusPill(text: person.role)
                            }
                            Text(person.focus).font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        VStack(alignment: .trailing, spacing: 3) {
                            Text(person.status).font(.caption.weight(.medium))
                            Text("\(person.sessions) sessions").font(.caption2).foregroundStyle(.secondary)
                        }
                        Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
                    }
                    .padding(.vertical, 8)
                }
            }
        }
    }

    private var operations: some View {
        VStack(alignment: .leading, spacing: 16) {
            Picker("Operations", selection: $section) {
                Text("Activity").tag(HQCompanySection.activity)
                Text("Deployments").tag(HQCompanySection.deployments)
                Text("Secrets").tag(HQCompanySection.secrets)
                Text("Settings").tag(HQCompanySection.settings)
            }
            .pickerStyle(.segmented)
            .accessibilityIdentifier("company.operations-tabs")

            switch section {
            case .activity:
                activity
            case .deployments:
                deployments
            case .secrets:
                secrets
            case .settings:
                companySettings
            default:
                EmptyView()
            }
        }
    }

    private var activity: some View {
        HQGlassCard {
            HQSectionTitle(title: "Company activity", detail: "Latest local and cloud changes", action: "Export")
            Divider().padding(.vertical, 8)
            ForEach(fixture.activity) { item in
                HQActivityRow(item: item)
            }
        }
    }

    private var deployments: some View {
        HQGlassCard {
            HQSectionTitle(title: "Deployments", detail: "3 environments", action: "Deploy")
            Divider().padding(.vertical, 8)
            ForEach(fixture.deployments) { deployment in
                HStack(spacing: 13) {
                    Image(systemName: deployment.state == "Healthy" ? "checkmark.circle" : "arrow.triangle.2.circlepath")
                        .frame(width: 30, height: 30)
                        .background(HQPalette.muted, in: RoundedRectangle(cornerRadius: 9))
                    VStack(alignment: .leading, spacing: 3) {
                        Text(deployment.name).font(.subheadline.weight(.semibold))
                        Text("\(deployment.environment) · \(deployment.version)")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    HQStatusPill(text: deployment.state, emphasized: deployment.state == "Building")
                    Text(deployment.time).font(.caption2).foregroundStyle(.secondary)
                    HQActionButton(
                        "Open",
                        command: .getCompanyDeployments,
                        params: .object(["companySlug": .string(slug)]),
                        successMessage: "Deployment state refreshed."
                    )
                    .controlSize(.small)
                }
                .padding(.vertical, 8)
            }
        }
    }

    private var secrets: some View {
        VStack(alignment: .leading, spacing: 16) {
            HQGlassCard {
                HStack(spacing: 12) {
                    Image(systemName: "lock.shield")
                        .font(.title2)
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Secret values never appear in HQ").font(.headline)
                        Text("Only names, environments, and rotation metadata are shown.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    HQActionButton(
                        "Open secure manager",
                        command: .getCompanySecrets,
                        params: .object(["companySlug": .string(slug)]),
                        successMessage: "Secret metadata refreshed."
                    )
                }
            }
            HQGlassCard {
                HQSectionTitle(title: "Secret inventory", detail: "\(fixture.secrets.count) configured")
                Divider().padding(.vertical, 8)
                ForEach(fixture.secrets) { secret in
                    HStack {
                        Image(systemName: "key").frame(width: 27)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(secret.name).font(.system(.subheadline, design: .monospaced).weight(.medium))
                            Text(secret.environment).font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        VStack(alignment: .trailing) {
                            Text("Updated \(secret.updated)").font(.caption)
                            Text("Rotation: \(secret.rotated)").font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                    .padding(.vertical, 8)
                }
            }
        }
    }

    private var companySettings: some View {
        HStack(alignment: .top, spacing: 16) {
            HQGlassCard {
                HQSectionTitle(title: "Company identity")
                Divider().padding(.vertical, 8)
                settingField("Display name", value: company?.name ?? slug.capitalized)
                settingField("Company slug", value: slug)
                settingField("Cloud UID", value: "cmp_\(slug)")
                HQActionButton(
                    "Open HQ Console",
                    action: .nativeCommand(
                        .openClaudeCodeLink,
                        payload: .string("https://hq.getindigo.ai/company/\(slug)")
                    )
                )
                    .padding(.top, 10)
                    .accessibilityIdentifier("company.open-console")
            }
            HQGlassCard {
                HQSectionTitle(title: "Connection")
                Divider().padding(.vertical, 8)
                labeledSetting("Cloud sync", value: "Connected")
                labeledSetting("Realtime updates", value: "On")
                labeledSetting("Local folder", value: "~/Documents/HQ/companies/\(slug)")
                HQUnavailableButton(
                    title: "Disconnect company…",
                    reason: "Disconnecting a company requires the protected workspace removal flow."
                )
                    .padding(.top, 10)
                    .accessibilityIdentifier("company.disconnect")
            }
        }
    }

    @ViewBuilder
    private func projectRow(_ project: HQProject) -> some View {
        Button {
            navigate(.project(company: slug, projectID: project.id))
        } label: {
            HStack(spacing: 13) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(project.title).font(.subheadline.weight(.semibold))
                    Text(project.summary).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer()
                Text("\(project.tasks.filter(\.passes).count)/\(project.tasks.count)")
                    .font(.caption.monospacedDigit())
                HQStatusPill(text: project.status)
                Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
            }
            .padding(.vertical, 8)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder
    private func knowledgeNode(_ title: String, symbol: String, depth: CGFloat) -> some View {
        HStack {
            Image(systemName: symbol).frame(width: 18)
            Text(title)
            Spacer()
        }
        .font(.caption)
        .padding(.leading, depth * 18)
        .padding(.vertical, 5)
    }

    @ViewBuilder
    private func settingField(_ name: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(name).font(.caption).foregroundStyle(.secondary)
            TextField(name, text: .constant(value))
                .textFieldStyle(.roundedBorder)
                .disabled(true)
                .help("Editing company fields requires the unavailable companies.update capability.")
        }
        .padding(.vertical, 4)
    }

    @ViewBuilder
    private func labeledSetting(_ name: String, value: String) -> some View {
        HStack {
            Text(name).font(.caption).foregroundStyle(.secondary)
            Spacer()
            Text(value).font(.caption.weight(.medium))
        }
        .padding(.vertical, 6)
    }
}

private struct HQActivityRow: View {
    let item: HQActivityFixture

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: item.symbol)
                .frame(width: 28, height: 28)
                .background(HQPalette.muted, in: RoundedRectangle(cornerRadius: 8))
            Text(item.actor).font(.subheadline.weight(.semibold))
            Text(item.action).font(.subheadline).foregroundStyle(.secondary)
            Text(item.target).font(.subheadline)
            Spacer()
            Text(item.time).font(.caption2).foregroundStyle(.secondary)
        }
        .padding(.vertical, 6)
    }
}

// MARK: - Project and task detail

private struct HQProjectView: View {
    let company: String
    let projectID: String
    let fixture: HQShellFixture
    let navigate: (HQRoute) -> Void
    @State private var tab = "Overview"

    private var project: HQProject? {
        fixture.snapshot.projects.first { $0.companySlug == company && $0.id == projectID }
    }

    var body: some View {
        HQPage(
            eyebrow: company.capitalized,
            title: project?.title ?? "Project",
            subtitle: project?.summary ?? "Project detail is unavailable.",
            identifier: "screen.project"
        ) {
            HStack {
                Button {
                    navigate(.company(slug: company, section: .projects))
                } label: {
                    Label("Projects", systemImage: "chevron.left")
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("project.back")
                Spacer()
                HQStatusPill(text: project?.status ?? "Unknown", emphasized: project?.livePhase != nil)
                HQActionButton(
                    "Open in editor",
                    action: .nativeCommand(
                        .openInEditor,
                        payload: .object([
                            "path": .string(project?.path.path ?? ""),
                        ])
                    )
                )
                    .accessibilityIdentifier("project.open-editor")
                HQUnavailableButton(
                    title: "Run project",
                    reason: "Running a project requires a selected worker and execution plan."
                )
                    .accessibilityIdentifier("project.run")
            }

            Picker("Project section", selection: $tab) {
                Text("Overview").tag("Overview")
                Text("Tasks").tag("Tasks")
                Text("Files").tag("Files")
                Text("Activity").tag("Activity")
            }
            .pickerStyle(.segmented)
            .accessibilityIdentifier("project.tabs")

            switch tab {
            case "Tasks":
                taskList
            case "Files":
                HQGlassCard {
                    HQSectionTitle(title: "Project files", detail: project?.path.path)
                    Divider().padding(.vertical, 8)
                    ForEach(fixture.files.filter { $0.path.contains("native-macos") }) { file in
                        Label(file.name, systemImage: "doc.text")
                            .font(.subheadline)
                            .padding(.vertical, 6)
                    }
                }
            case "Activity":
                HQGlassCard {
                    HQSectionTitle(title: "Project activity")
                    Divider().padding(.vertical, 8)
                    ForEach(fixture.activity) { HQActivityRow(item: $0) }
                }
            default:
                overview
            }
        }
    }

    private var overview: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 14) {
                HQMetricCard(
                    label: "Tasks complete",
                    value: "\(project?.tasks.filter(\.passes).count ?? 0)/\(project?.tasks.count ?? 0)",
                    detail: "2 currently active",
                    symbol: "checklist"
                )
                HQMetricCard(
                    label: "Branch",
                    value: project?.branch ?? "—",
                    detail: "Working tree clean",
                    symbol: "arrow.triangle.branch"
                )
                HQMetricCard(
                    label: "Owner",
                    value: project?.owner ?? "Unassigned",
                    detail: "Last active 4m ago",
                    symbol: "person"
                )
            }
            HStack(alignment: .top, spacing: 16) {
                HQGlassCard {
                    HQSectionTitle(title: "Objective")
                    Divider().padding(.vertical, 8)
                    Text(project?.summary ?? "")
                        .font(.body)
                    Text("Success means every HQ surface is native, calm, fast, and fully verified on supported macOS releases.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .padding(.top, 8)
                }
                HQGlassCard {
                    HQSectionTitle(title: "Live work", detail: project?.livePhase)
                    Divider().padding(.vertical, 8)
                    Label("Engineering agent is implementing NATIVE-004", systemImage: "bolt.fill")
                        .font(.subheadline)
                    ProgressView(value: 0.62)
                        .tint(HQPalette.ink)
                        .padding(.vertical, 10)
                    Text("Visual shell · 18 minutes elapsed")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            taskList
        }
    }

    private var taskList: some View {
        HQGlassCard {
            HQSectionTitle(title: "Tasks", detail: "\(project?.tasks.count ?? 0) stories")
            Divider().padding(.vertical, 8)
            ForEach(project?.tasks ?? []) { task in
                Button {
                    navigate(.task(company: company, projectID: projectID, taskID: task.id))
                } label: {
                    HStack(spacing: 12) {
                        Image(systemName: task.passes ? "checkmark.circle.fill" : "circle")
                            .foregroundStyle(task.passes ? .primary : .secondary)
                        VStack(alignment: .leading, spacing: 3) {
                            HStack {
                                Text(task.id).font(.caption.monospaced().weight(.semibold))
                                Text(task.title).font(.subheadline.weight(.medium))
                            }
                            Text(task.detail).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                        }
                        Spacer()
                        HQStatusPill(text: task.state.hqTitle, emphasized: task.state == .active)
                        Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
                    }
                    .padding(.vertical, 8)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("project.task.\(task.id)")
            }
        }
    }
}

private struct HQTaskView: View {
    let company: String
    let projectID: String
    let taskID: String
    let fixture: HQShellFixture
    let navigate: (HQRoute) -> Void

    private var project: HQProject? {
        fixture.snapshot.projects.first { $0.companySlug == company && $0.id == projectID }
    }

    private var task: HQTask? {
        project?.tasks.first { $0.id == taskID }
    }

    var body: some View {
        HQPage(
            eyebrow: "\(project?.title ?? projectID) · \(taskID)",
            title: task?.title ?? "Task",
            subtitle: task?.detail ?? "Task detail is unavailable.",
            identifier: "screen.task"
        ) {
            HStack {
                Button {
                    navigate(.project(company: company, projectID: projectID))
                } label: {
                    Label("Project", systemImage: "chevron.left")
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("task.back")
                Spacer()
                HQStatusPill(text: task?.state.hqTitle ?? "Unknown", emphasized: task?.state == .active)
                HQActionButton(
                    "Mark complete",
                    command: .setLocalStoryPasses,
                    params: .object([
                        "prdPath": .string(
                            "companies/\(company)/projects/\(projectID)/prd.json"
                        ),
                        "storyId": .string(taskID),
                        "passes": .bool(true),
                    ]),
                    successMessage: "Marked \(taskID) complete."
                )
                    .accessibilityIdentifier("task.complete")
                HQUnavailableButton(
                    title: "Run story",
                    reason: "Running a story requires a selected worker and execution environment."
                )
                    .accessibilityIdentifier("task.run")
            }

            HStack(alignment: .top, spacing: 16) {
                VStack(spacing: 16) {
                    HQGlassCard {
                        HQSectionTitle(title: "Acceptance criteria", detail: "\(task?.acceptanceCriteria.count ?? 0) checks")
                        Divider().padding(.vertical, 8)
                        ForEach(task?.acceptanceCriteria ?? [], id: \.self) { criterion in
                            HStack(alignment: .top, spacing: 10) {
                                Image(systemName: "circle")
                                    .font(.caption)
                                    .padding(.top, 2)
                                Text(criterion).font(.subheadline)
                                Spacer()
                            }
                            .padding(.vertical, 5)
                        }
                    }
                    HQGlassCard {
                        HQSectionTitle(title: "Implementation notes")
                        Divider().padding(.vertical, 8)
                        Text(
                            "Keep the native shell injection-friendly. Validate route roots, native materials, resizing, keyboard navigation, and both appearances before closing the story."
                        )
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, minHeight: 90, alignment: .topLeading)
                    }
                }

                VStack(spacing: 16) {
                    HQGlassCard {
                        HQSectionTitle(title: "Details")
                        Divider().padding(.vertical, 8)
                        detailRow("Priority", value: "P\(task?.priority ?? 0)")
                        detailRow("State", value: task?.state.hqTitle ?? "Unknown")
                        detailRow("Dependencies", value: task?.dependencies.joined(separator: ", ") ?? "None")
                        detailRow("Owner", value: project?.owner ?? "Unassigned")
                    }
                    HQGlassCard {
                        HQSectionTitle(title: "Live run", detail: "Engineering")
                        Divider().padding(.vertical, 8)
                        Label("Testing native route parity", systemImage: "bolt.fill")
                            .font(.subheadline)
                        Text("18m elapsed · 4 files changed")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .padding(.vertical, 6)
                        HQActionButton(
                            "Open live session",
                            command: .listAgentSessions,
                            params: .object([
                                "company": .string(company),
                                "project": .string(projectID),
                            ]),
                            successMessage: "Live sessions refreshed."
                        )
                            .frame(maxWidth: .infinity)
                            .accessibilityIdentifier("task.open-session")
                    }
                }
                .frame(maxWidth: 330)
            }
        }
    }

    @ViewBuilder
    private func detailRow(_ name: String, value: String) -> some View {
        HStack(alignment: .top) {
            Text(name).font(.caption).foregroundStyle(.secondary)
            Spacer()
            Text(value).font(.caption.weight(.medium)).multilineTextAlignment(.trailing)
        }
        .padding(.vertical, 5)
    }
}

private extension HQWorkState {
    var hqTitle: String {
        switch self {
        case .notStarted: "To do"
        case .inProgress: "In progress"
        case .active: "Running"
        case .complete: "Complete"
        }
    }
}

// MARK: - Settings

private struct HQSettingsView: View {
    @State private var section: HQSettingsSection
    @State private var syncOnLaunch = true
    @State private var realtimeSync = true
    @State private var personalSync = true
    @State private var dmNotifications = true
    @State private var shareNotifications = true
    @State private var meetingNotifications = true
    @State private var widgetEnabled = true
    @State private var launchAtLogin = true
    @State private var telemetry = false
    @State private var autoUpdates = true
    @State private var detectMeetings = true

    init(section: HQSettingsSection) {
        _section = State(initialValue: section)
    }

    var body: some View {
        HQPage(
            eyebrow: "Application preferences",
            title: "Settings",
            subtitle: settingSubtitle,
            identifier: "screen.settings.\(section.rawValue)"
        ) {
            Picker("Settings section", selection: $section) {
                ForEach(HQSettingsSection.allCases, id: \.self) {
                    Text($0.rawValue.capitalized).tag($0)
                }
            }
            .pickerStyle(.segmented)
            .accessibilityIdentifier("settings.tabs")

            switch section {
            case .sync:
                syncSettings
            case .notifications:
                notificationSettings
            case .widget:
                widgetSettings
            case .updates:
                updateSettings
            case .general:
                generalSettings
            case .meetings:
                meetingSettings
            }
        }
    }

    private var settingSubtitle: String {
        switch section {
        case .sync: "Choose what stays synchronized and how often."
        case .notifications: "Control which activity can interrupt you."
        case .widget: "Keep the most important updates one click away."
        case .updates: "Manage the app, CLI, packs, and HQ core."
        case .general: "Startup, privacy, release channel, and account."
        case .meetings: "Detection, recording defaults, and macOS permissions."
        }
    }

    private var syncSettings: some View {
        VStack(spacing: 16) {
            HQGlassCard {
                HQSectionTitle(title: "HQ folder", detail: "The local source of truth")
                Divider().padding(.vertical, 8)
                HStack {
                    Image(systemName: "folder").frame(width: 28)
                    VStack(alignment: .leading) {
                        Text("~/Documents/HQ").font(.system(.subheadline, design: .monospaced))
                        Text("3 companies · 247 files").font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    HQActionButton(
                        "Choose…",
                        action: .nativeCommand(.pickFolder)
                    )
                    .accessibilityIdentifier("settings.choose-folder")
                    HQActionButton(
                        "Reveal",
                        action: .nativeCommand(
                            .revealFolder,
                            payload: .string(
                                FileManager.default.homeDirectoryForCurrentUser
                                    .appendingPathComponent("Documents/HQ")
                                    .path
                            )
                        )
                    )
                    .accessibilityIdentifier("settings.reveal-folder")
                }
            }
            HQGlassCard {
                HQSectionTitle(title: "Sync behavior")
                Divider().padding(.vertical, 8)
                settingsToggle("Sync on launch", detail: "Check every connected company when HQ opens.", value: $syncOnLaunch)
                settingsToggle("Realtime sync", detail: "Listen for cloud changes while HQ is running.", value: $realtimeSync)
                settingsToggle("Sync personal workspace", detail: "Include your personal skills and preferences.", value: $personalSync)
            }
            HQGlassCard {
                HQSectionTitle(title: "Sync status", detail: "Healthy")
                Divider().padding(.vertical, 8)
                settingsValue("Daemon", value: "Running")
                settingsValue("Last full sync", value: "Just now")
                settingsValue("Pending changes", value: "0")
                HQActionButton("Sync now", action: .syncNow)
                    .padding(.top, 10)
                    .accessibilityIdentifier("settings.sync-now")
            }
        }
    }

    private var notificationSettings: some View {
        HStack(alignment: .top, spacing: 16) {
            HQGlassCard {
                HQSectionTitle(title: "Activity")
                Divider().padding(.vertical, 8)
                settingsToggle("Direct messages", detail: "New messages from people and agents.", value: $dmNotifications)
                settingsToggle("Shared files", detail: "Files and folders shared with you.", value: $shareNotifications)
                settingsToggle("Meetings", detail: "Starting soon, bot state, and recordings.", value: $meetingNotifications)
            }
            HQGlassCard {
                HQSectionTitle(title: "macOS permission", detail: "Allowed")
                Divider().padding(.vertical, 8)
                Label("HQ can show notifications", systemImage: "checkmark.circle.fill")
                    .font(.subheadline)
                Text("Banners, sounds, and Notification Center behavior are managed by macOS.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.vertical, 8)
                HQActionButton(
                    "Open System Settings",
                    action: .nativeCommand(.permissionsOpenSettings)
                )
                    .accessibilityIdentifier("settings.notification-system")
            }
        }
    }

    private var widgetSettings: some View {
        HStack(alignment: .top, spacing: 16) {
            HQGlassCard {
                HQSectionTitle(title: "Desktop widget")
                Divider().padding(.vertical, 8)
                settingsToggle("Show widget", detail: "Keep HQ available above other windows.", value: $widgetEnabled)
                settingsValue("Display", value: "Built-in Retina Display")
                settingsValue("Position", value: "Top right")
                settingsValue("Recent items", value: "3")
                HQActionButton(
                    "Reset position",
                    action: .nativeCommand(
                        .resizeWidget,
                        payload: .object(["reset": .bool(true)])
                    )
                )
                    .padding(.top, 10)
                    .accessibilityIdentifier("settings.widget-reset")
            }
            HQGlassCard {
                HQSectionTitle(title: "Preview", detail: "Interactive native widget")
                Divider().padding(.vertical, 8)
                HStack(spacing: 10) {
                    Text("HQ").font(.headline)
                    Divider().frame(height: 22)
                    HQStatusPill(text: "2")
                    Text("Maya sent a message").font(.caption)
                    Image(systemName: "chevron.right").font(.caption)
                }
                .padding(13)
                .hqAdaptiveGlassSurface(cornerRadius: 14)
                .frame(maxWidth: .infinity)
            }
        }
    }

    private var updateSettings: some View {
        VStack(spacing: 16) {
            HQGlassCard {
                HStack {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("HQ for macOS").font(.headline)
                        Text("Version 0.1.0 · Native preview channel")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    HQStatusPill(text: "Up to date", emphasized: true)
                    HQActionButton(
                        "Check now",
                        action: .nativeCommand(.checkForUpdates)
                    )
                    .accessibilityIdentifier("settings.check-updates")
                }
                Divider().padding(.vertical, 10)
                settingsToggle("Install updates automatically", detail: "Download signed releases in the background.", value: $autoUpdates)
            }
            HQGlassCard {
                HQSectionTitle(title: "HQ components", detail: "App and local toolchain")
                Divider().padding(.vertical, 8)
                updateRow("HQ CLI", version: "12.2.0", state: "Current")
                updateRow("Engineering pack", version: "4.7.1", state: "Update available")
                updateRow("Parker pack", version: "3.9.0", state: "Current")
                updateRow("HQ core", version: "12.2.0", state: "1 local edit")
            }
        }
    }

    private var generalSettings: some View {
        HStack(alignment: .top, spacing: 16) {
            HQGlassCard {
                HQSectionTitle(title: "Application")
                Divider().padding(.vertical, 8)
                settingsToggle("Launch at login", detail: "Start HQ quietly when you sign in.", value: $launchAtLogin)
                settingsToggle("Share anonymous diagnostics", detail: "Help improve reliability without company content.", value: $telemetry)
                settingsValue("Release channel", value: "Native preview")
            }
            HQGlassCard {
                HQSectionTitle(title: "Account")
                Divider().padding(.vertical, 8)
                HStack(spacing: 11) {
                    HQAvatar(initials: "CE")
                    VStack(alignment: .leading) {
                        Text("Corey Epstein").font(.subheadline.weight(.semibold))
                        Text("corey@getindigo.ai").font(.caption).foregroundStyle(.secondary)
                    }
                }
                .padding(.bottom, 10)
                HQActionButton(
                    "Sign out",
                    command: .signOut,
                    successMessage: "Signed out."
                )
                .accessibilityIdentifier("settings.sign-out")
                HQActionButton("Quit HQ", action: .nativeCommand(.quitApp))
                    .accessibilityIdentifier("settings.quit")
            }
        }
    }

    private var meetingSettings: some View {
        VStack(spacing: 16) {
            HQGlassCard {
                HQSectionTitle(title: "Meeting detection")
                Divider().padding(.vertical, 8)
                settingsToggle("Detect active meetings", detail: "Recognize Zoom, Meet, and Teams windows.", value: $detectMeetings)
                settingsValue("Default recording company", value: "Indigo")
                settingsValue("Capture mode", value: "Local audio + screen context")
            }
            HQGlassCard {
                HQSectionTitle(title: "macOS permissions", detail: "3 of 3 allowed")
                Divider().padding(.vertical, 8)
                permissionRow("Accessibility", detail: "Detect meeting windows")
                permissionRow("Screen Recording", detail: "Understand meeting context")
                permissionRow("Microphone", detail: "Capture meeting audio")
                HQActionButton(
                    "Open permission wizard",
                    action: .openScene(.meetingPermissions)
                )
                    .padding(.top, 10)
                    .accessibilityIdentifier("settings.meeting-permissions")
            }
        }
    }

    @ViewBuilder
    private func settingsToggle(
        _ title: String,
        detail: String,
        value: Binding<Bool>
    ) -> some View {
        Toggle(isOn: value) {
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.subheadline.weight(.medium))
                Text(detail).font(.caption).foregroundStyle(.secondary)
            }
        }
        .toggleStyle(.switch)
        .padding(.vertical, 7)
        .accessibilityIdentifier("settings.toggle.\(title.hqIdentifier)")
    }

    @ViewBuilder
    private func settingsValue(_ title: String, value: String) -> some View {
        HStack {
            Text(title).font(.subheadline)
            Spacer()
            Text(value).font(.caption.weight(.medium)).foregroundStyle(.secondary)
        }
        .padding(.vertical, 7)
    }

    @ViewBuilder
    private func updateRow(_ title: String, version: String, state: String) -> some View {
        HStack {
            Image(systemName: "shippingbox").frame(width: 28)
            VStack(alignment: .leading) {
                Text(title).font(.subheadline.weight(.medium))
                Text(version).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            HQStatusPill(text: state, emphasized: state.contains("available"))
            if state.contains("available") {
                HQActionButton(
                    "Update",
                    action: .nativeCommand(.installUpdate)
                )
                .controlSize(.small)
            }
        }
        .padding(.vertical, 7)
    }

    @ViewBuilder
    private func permissionRow(_ title: String, detail: String) -> some View {
        HStack {
            Image(systemName: "checkmark.circle.fill").frame(width: 27)
            VStack(alignment: .leading) {
                Text(title).font(.subheadline.weight(.medium))
                Text(detail).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            Text("Allowed").font(.caption.weight(.medium))
        }
        .padding(.vertical, 7)
    }
}
