import AppKit
import XCTest
import UserNotifications
@testable import HQNative

final class HQRouteParserTests: XCTestCase {
    func testCommandPaletteKeyResolverMapsUnmodifiedNavigationKeys() {
        XCTAssertEqual(
            HQCommandPaletteKeyAction.resolve(
                keyCode: 126,
                modifiers: []
            ),
            .moveUp
        )
        XCTAssertEqual(
            HQCommandPaletteKeyAction.resolve(
                keyCode: 125,
                modifiers: [.numericPad]
            ),
            .moveDown
        )
        XCTAssertEqual(
            HQCommandPaletteKeyAction.resolve(
                keyCode: 36,
                modifiers: []
            ),
            .activate
        )
        XCTAssertEqual(
            HQCommandPaletteKeyAction.resolve(
                keyCode: 76,
                modifiers: [.numericPad]
            ),
            .activate
        )
        XCTAssertEqual(
            HQCommandPaletteKeyAction.resolve(
                keyCode: 53,
                modifiers: []
            ),
            .dismiss
        )
    }

    func testCommandPaletteKeyResolverPreservesModifiedAndUnrelatedKeys() {
        XCTAssertNil(
            HQCommandPaletteKeyAction.resolve(
                keyCode: 125,
                modifiers: [.command]
            )
        )
        XCTAssertNil(
            HQCommandPaletteKeyAction.resolve(
                keyCode: 36,
                modifiers: [.option]
            )
        )
        XCTAssertNil(
            HQCommandPaletteKeyAction.resolve(
                keyCode: 0,
                modifiers: []
            )
        )
    }

    func testUsesAppNamespacedSceneLaunchFlag() {
        XCTAssertEqual(
            HQLaunchConfiguration.initialScene(
                arguments: ["HQNative", "--hq-scene", "onboarding"]
            ),
            "onboarding"
        )
    }

    func testNativeCommandLaunchParsingPreservesRepeatedCommandsInOrder() {
        XCTAssertEqual(
            HQLaunchConfiguration.initialNativeCommands(
                arguments: [
                    "HQNative",
                    "--native-command",
                    "open_messages_window",
                    "--native-command",
                    "open_messages_window",
                    "--native-command",
                    "show_main_window",
                ]
            ),
            [
                .openMessagesWindow,
                .openMessagesWindow,
                .showMainWindow,
            ]
        )
    }

    func testParsesGlobalDestinations() {
        XCTAssertEqual(HQRouteParser.parse("inbox"), .global(.inbox))
        XCTAssertEqual(HQRouteParser.parse("mission-control"), .global(.missionControl))
        XCTAssertEqual(HQRouteParser.parse("marketplace"), .global(.marketplace))
    }

    func testParsesCompanyAndLegacySections() {
        XCTAssertEqual(
            HQRouteParser.parse("company:indigo:projects"),
            .company(slug: "indigo", section: .projects)
        )
        XCTAssertEqual(
            HQRouteParser.parse("company/indigo/tasks"),
            .company(slug: "indigo", section: .projects)
        )
        XCTAssertEqual(
            HQRouteParser.parse("company:indigo:more"),
            .company(slug: "indigo", section: .activity)
        )
    }

    func testParsesFilesWithoutLosingNestedPath() {
        XCTAssertEqual(
            HQRouteParser.parse("files:indigo:knowledge/briefs/positioning.md"),
            .files(slug: "indigo", path: "knowledge/briefs/positioning.md")
        )
    }

    func testRoundTripsEverySupportedRoute() {
        let routes: [HQRoute] = [
            .global(.home),
            .library(.workers),
            .settings(.updates),
            .company(slug: "indigo", section: .knowledge),
            .files(slug: "indigo", path: "knowledge/a.md"),
            .project(company: "indigo", projectID: "native-app"),
            .task(company: "indigo", projectID: "native-app", taskID: "NATIVE-001"),
        ]

        for route in routes {
            XCTAssertEqual(HQRouteParser.parse(HQRouteParser.serialize(route)), route)
        }
    }

    func testRejectsUnknownOrEmptyRoutes() {
        XCTAssertNil(HQRouteParser.parse(nil))
        XCTAssertNil(HQRouteParser.parse(""))
        XCTAssertNil(HQRouteParser.parse("definitely-not-a-route"))
    }

    func testEveryNativeRouteHasADeterministicScreenAccessibilityIdentifier() {
        let routesAndIdentifiers: [(HQRoute, String)] = [
            (.global(.home), "screen.home"),
            (.global(.missionControl), "screen.mission-control"),
            (.global(.inbox), "screen.inbox"),
            (.global(.meetings), "screen.meetings"),
            (.global(.marketplace), "screen.marketplace"),
            (.global(.moderation), "screen.moderation"),
            (.library(.skills), "screen.library.skills"),
            (.library(.workers), "screen.library.workers"),
            (.library(.installed), "screen.library.installed"),
            (.library(.profile), "screen.library.profile"),
            (.files(slug: "indigo", path: nil), "screen.files"),
            (.company(slug: "indigo", section: .overview), "screen.company.overview"),
            (.company(slug: "indigo", section: .goals), "screen.company.goals"),
            (.company(slug: "indigo", section: .projects), "screen.company.projects"),
            (.company(slug: "indigo", section: .skills), "screen.company.skills"),
            (.company(slug: "indigo", section: .workers), "screen.company.workers"),
            (.company(slug: "indigo", section: .knowledge), "screen.company.knowledge"),
            (.company(slug: "indigo", section: .team), "screen.company.team"),
            (.company(slug: "indigo", section: .activity), "screen.company.activity"),
            (.company(slug: "indigo", section: .deployments), "screen.company.deployments"),
            (.company(slug: "indigo", section: .secrets), "screen.company.secrets"),
            (.company(slug: "indigo", section: .settings), "screen.company.settings"),
            (.settings(.sync), "screen.settings.sync"),
            (.settings(.notifications), "screen.settings.notifications"),
            (.settings(.widget), "screen.settings.widget"),
            (.settings(.updates), "screen.settings.updates"),
            (.settings(.general), "screen.settings.general"),
            (.settings(.meetings), "screen.settings.meetings"),
            (.project(company: "indigo", projectID: "native-macos"), "screen.project"),
            (
                .task(company: "indigo", projectID: "native-macos", taskID: "NATIVE-004"),
                "screen.task"
            ),
        ]

        for (route, expectedIdentifier) in routesAndIdentifiers {
            XCTAssertEqual(HQScreenAccessibility.identifier(for: route), expectedIdentifier)
        }
    }

    func testVisualTourCatalogCoversEverySurfaceAcrossFourRestorationSafeVariants() {
        XCTAssertEqual(HQVisualTourCatalog.routes.count, 30)
        XCTAssertEqual(HQVisualTourCatalog.windows.count, 17)
        XCTAssertEqual(HQVisualTourVariant.allCases.count, 4)
        XCTAssertEqual(
            HQVisualTourCatalog.routes.count
                + HQVisualTourCatalog.windows.count,
            47
        )
        XCTAssertEqual(
            Set(
                HQVisualTourCatalog.routes.map(\.accessibilityIdentifier)
            ).count,
            30
        )
        XCTAssertEqual(
            HQVisualTourCatalog.windows.first {
                $0.parityID == "banner"
            }?.accessibilityIdentifier,
            "window.banner.direct-message"
        )
        XCTAssertEqual(
            HQVisualTourCatalog.windows.first {
                $0.parityID == "widget"
            }?.accessibilityIdentifier,
            "window.widget.expanded"
        )

        for variant in HQVisualTourVariant.allCases {
            for surface in
                HQVisualTourCatalog.routes + HQVisualTourCatalog.windows
            {
                let arguments = surface.launchArguments(
                    variant: variant
                )
                XCTAssertEqual(
                    Array(arguments.prefix(4)),
                    [
                        "-ApplePersistenceIgnoreState",
                        "YES",
                        "-NSTreatUnknownArgumentsAsOpen",
                        "NO",
                    ]
                )
                XCTAssertTrue(arguments.contains("--visual-tour"))
                XCTAssertTrue(arguments.contains(variant.rawValue))
                XCTAssertTrue(
                    surface.artifactRelativePath(variant: variant)
                        .hasSuffix(".png")
                )
            }
        }
    }
}

final class HQNativeProductionSourceGateTests: XCTestCase {
    func testProductionLaunchDefaultsToLiveEngineAndFixturesRequireExplicitTestingMode() {
        XCTAssertEqual(
            HQLaunchMode.resolve(
                arguments: ["HQNative"],
                environment: [:]
            ),
            .live
        )
        XCTAssertEqual(
            HQLaunchMode.resolve(
                arguments: ["HQNative", "--ui-testing"],
                environment: [:]
            ),
            .uiTestingFixture
        )
        XCTAssertEqual(
            HQLaunchMode.resolve(
                arguments: ["HQNative", "--preview-fixtures"],
                environment: [:]
            ),
            .previewFixture
        )
    }

    func testUnitTestHostUsesFixturesButExplicitUIAndVisualModesWin() {
        let testEnvironment = [
            "XCTestConfigurationFilePath": "/tmp/HQNativeTests.xctestconfiguration",
        ]
        XCTAssertEqual(
            HQLaunchMode.resolve(
                arguments: ["HQNative"],
                environment: testEnvironment
            ),
            .previewFixture
        )
        XCTAssertEqual(
            HQLaunchMode.resolve(
                arguments: ["HQNative", "--ui-testing"],
                environment: testEnvironment
            ),
            .uiTestingFixture
        )
        XCTAssertEqual(
            HQLaunchMode.resolve(
                arguments: ["HQNative", "--visual-tour"],
                environment: testEnvironment
            ),
            .visualTourFixture
        )
        XCTAssertEqual(
            HQLaunchMode.resolve(
                arguments: ["HQNative", "--live"],
                environment: testEnvironment
            ),
            .live,
            "The explicit live UI-test smoke path must still exercise the real sidecar."
        )
        XCTAssertEqual(
            HQLaunchMode.resolve(
                arguments: ["HQNative", "--preview-fixtures"],
                environment: ["XCTestBundlePath": "/tmp/HQNativeTests.xctest"]
            ),
            .previewFixture
        )
    }

    func testSceneRegistryCoversEveryParityLedgerWindow() {
        XCTAssertEqual(
            Set(HQSceneRegistration.allIDs),
            [
                "main",
                "menubar",
                "onboarding",
                "sign-in",
                "recovery",
                "meetings",
                "meeting-permissions",
                "dm-detail",
                "share-detail",
                "messages",
                "banner",
                "widget",
                "activity",
                "drift",
                "new-files",
                "notification-history",
                "settings",
            ]
        )
    }

    func testSceneDescriptorsExactlyMatchWindowParityLedger() {
        let retainedWindows: [HQSceneDescriptor] = [
            HQSceneDescriptor(id: "main", title: "HQ", width: 1_180, height: 760, multiplicity: .windowGroup),
            HQSceneDescriptor(id: "menubar", title: "HQ", width: 296, height: 360, multiplicity: .menuBarExtra),
            HQSceneDescriptor(id: "onboarding", title: "Set up HQ", width: 780, height: 620, multiplicity: .singleton),
            HQSceneDescriptor(id: "sign-in", title: "Sign in to HQ", width: 520, height: 440, multiplicity: .singleton),
            HQSceneDescriptor(id: "recovery", title: "HQ Recovery", width: 620, height: 460, multiplicity: .singleton),
            HQSceneDescriptor(id: "meetings", title: "HQ Meetings", width: 460, height: 600, multiplicity: .singleton),
            HQSceneDescriptor(id: "meeting-permissions", title: "Meeting Permissions", width: 640, height: 700, multiplicity: .singleton),
            HQSceneDescriptor(id: "dm-detail", title: "Conversation", width: 820, height: 640, multiplicity: .singleton),
            HQSceneDescriptor(id: "share-detail", title: "Shared with you", width: 640, height: 560, multiplicity: .singleton),
            HQSceneDescriptor(id: "messages", title: "Messages", width: 720, height: 560, multiplicity: .singleton),
            HQSceneDescriptor(id: "banner", title: "HQ Notification", width: 366, height: 104, multiplicity: .singleton),
            HQSceneDescriptor(id: "widget", title: "HQ Widget", width: 340, height: 480, multiplicity: .singleton),
            HQSceneDescriptor(id: "activity", title: "Recent Changes", width: 560, height: 460, multiplicity: .singleton),
            HQSceneDescriptor(id: "drift", title: "HQ Core Changes", width: 560, height: 480, multiplicity: .singleton),
            HQSceneDescriptor(id: "new-files", title: "New Files", width: 500, height: 400, multiplicity: .singleton),
            HQSceneDescriptor(id: "notification-history", title: "Notifications", width: 680, height: 620, multiplicity: .singleton),
            HQSceneDescriptor(id: "settings", title: "HQ Settings", width: 760, height: 620, multiplicity: .singleton),
        ]

        XCTAssertEqual(HQSceneRegistration.all, retainedWindows)
    }

    func testEveryDeclaredProductionControlHasATypedResolution() {
        for kind in HQSecondaryWindowKind.allCases {
            let fixture = HQSecondaryWindowFixtures.fixture(for: kind)
            for action in [
                fixture.primaryAction,
                fixture.secondaryAction,
            ].compactMap({ $0 }) {
                XCTAssertNotNil(
                    HQSecondaryWindowActionRegistry.resolution(
                        for: kind,
                        actionID: action.id
                    ),
                    "\(kind.rawValue).\(action.id) is not wired."
                )
            }
        }
    }

    func testProductionLaunchModesAreExplicitAndLiveRendersProduction() {
        XCTAssertTrue(HQLaunchMode.live.rendersProductionSurfaces)
        XCTAssertFalse(HQLaunchMode.live.usesLegacyFixtureSurfaces)
        XCTAssertFalse(HQLaunchMode.visualTourFixture.usesLegacyFixtureSurfaces)
        XCTAssertTrue(HQLaunchMode.uiTestingFixture.usesLegacyFixtureSurfaces)
        XCTAssertTrue(HQLaunchMode.previewFixture.usesLegacyFixtureSurfaces)
    }

    func testEveryNativeParityCommandHasATypedDispatcherResolution() {
        XCTAssertEqual(
            Set(HQNativeCommand.allCases.map(\.rawValue)),
            Self.retainedNativeCommandNames,
            "Every native ledger command must have exactly one typed dispatcher case."
        )

        for command in HQNativeCommand.allCases {
            switch HQNativeActionRegistry.resolution(for: command) {
            case .implemented:
                break
            case let .disabled(reason):
                XCTFail(
                    "\(command.rawValue) remains disabled at shipping: \(reason)"
                )
            }
        }
    }

    func testEveryNativeParityEventHasTypedProducerAndConsumer() {
        let typedNativeNames = Set(
            HQNativeEvent.allCases.map(\.rawValue)
                + HQNativeParitySourceRegistry.directSwiftNames.map(\.rawValue)
        )
        let retiredNames = Set(
            HQNativeParitySourceRegistry.retiredNames.map(\.rawValue)
        )
        let retainedNames = retainedNativeParityLedgerEventNames
        let engineNames = retainedNames
            .subtracting(typedNativeNames)
            .subtracting(retiredNames)

        XCTAssertEqual(typedNativeNames.count, 23)
        XCTAssertEqual(engineNames.count, 46)
        XCTAssertEqual(retiredNames.count, 1)
        XCTAssertEqual(
            typedNativeNames.union(engineNames).union(retiredNames),
            retainedNames
        )
        XCTAssertEqual(
            retainedNames.count,
            70
        )
    }

    private static let retainedNativeCommandNames: Set<String> = [
        "activity_window_ready",
        "apply_widget_settings",
        "available_channels",
        "banner_action",
        "banner_window_ready",
        "check_for_updates",
        "claude_desktop_installed",
        "detail_window_ready",
        "dismiss_banner",
        "dm_detail_window_ready",
        "drift_window_ready",
        "get_autostart_enabled",
        "get_pending_update",
        "home_dir",
        "install_update",
        "keychain_delete",
        "keychain_get",
        "keychain_set",
        "launch_claude_code",
        "launch_claude_desktop",
        "launch_cli_in_terminal",
        "launch_codex_desktop",
        "launch_menubar_app",
        "list_displays",
        "meetings_clear_prompt_badge",
        "meetings_permissions_state",
        "meetings_set_prompt_badge",
        "meetings_take_pending_focus",
        "menubar_installed",
        "messages_window_ready",
        "notification_permission_state",
        "notification_request_permission",
        "open_activity_log",
        "open_claude_code_link",
        "open_desktop_alt_window",
        "open_developer_settings",
        "open_dm_detail",
        "open_drift_detail",
        "open_in_editor",
        "open_inbox_window",
        "open_meeting_permissions_window",
        "open_meetings_window",
        "open_messages_window",
        "open_new_files_detail",
        "open_notification_history",
        "open_packages_window",
        "open_settings_window",
        "open_share_detail",
        "packages_window_ready",
        "permissions_force_native_register",
        "permissions_open_settings",
        "pick_avatar_file",
        "pick_folder",
        "pick_pack_directory",
        "preview_dm_banner",
        "preview_meeting_banner",
        "preview_share_banner",
        "preview_update_banner",
        "quit_app",
        "resize_banner",
        "resize_widget",
        "reveal_folder",
        "set_autostart_enabled",
        "set_main_window_vibrancy",
        "set_tray_state",
        "set_widget_focusable",
        "share_detail_window_ready",
        "show_main_window",
        "show_main_window_at_tray",
        "take_pending_messages_target",
        "widget_ready",
    ]
}

@MainActor
final class HQAppStoreTests: XCTestCase {
    func testStartupHandshakesAndLoadsEveryRequiredLiveDomain() async throws {
        let engine = HQRecordingAppEngine(
            responses: [
                "config.get": .object([
                    "source": .string("local"),
                    "config": .object(["company_slug": .string("indigo")]),
                ]),
                "auth.state": .object([
                    "source": .string("local"),
                    "authenticated": .bool(true),
                    "hasStoredTokens": .bool(true),
                ]),
                "workspaces.list": .object([
                    "source": .string("local"),
                    "hqFolderPath": .string("/tmp/HQ"),
                    "workspaces": .array([
                        .object([
                            "slug": .string("indigo"),
                            "displayName": .string("Indigo"),
                            "path": .string("/tmp/HQ/companies/indigo"),
                            "exists": .bool(true),
                            "source": .string("local"),
                        ]),
                    ]),
                ]),
                "sync.status": .object([
                    "lastSyncAt": .string("2026-07-26T18:00:00Z"),
                    "pendingChanges": .number(0),
                ]),
                "projects.list": .array([
                    .object([
                        "id": .string("native-macos"),
                        "companySlug": .string("indigo"),
                        "title": .string("Native macOS"),
                        "summary": .string("Native HQ"),
                        "status": .string("in-progress"),
                        "path": .string("/tmp/HQ/companies/indigo/projects/native-macos"),
                        "tasks": .array([]),
                    ]),
                ]),
                "sessions.list": .array([
                    .object([
                        "id": .string("session-1"),
                        "title": .string("Native implementation"),
                        "provider": .string("codex"),
                        "status": .string("active"),
                    ]),
                ]),
            ]
        )
        let store = HQAppStore(
            engine: engine,
            launchMode: .live
        )

        await store.start()

        XCTAssertEqual(store.phase, .ready)
        XCTAssertEqual(store.content.snapshot.workspaces.map(\.slug), ["indigo"])
        XCTAssertEqual(store.content.snapshot.projects.map(\.id), ["native-macos"])
        XCTAssertEqual(store.sessions.map(\.id), ["session-1"])
        XCTAssertTrue(store.isAuthenticated)
        let requestedMethods = await engine.requestedMethods()
        XCTAssertEqual(
            Set(requestedMethods),
            [
                "config.get",
                "auth.state",
                "workspaces.list",
                "sync.status",
                "projects.list",
                "sessions.list",
            ]
        )
    }

    func testLiveBootstrapStartsUpdaterOnceOnWorkspaceGatedChannel()
        async
    {
        let indigoDriver = HQAppStoreUpdaterDriverSpy()
        let indigoStore = HQAppStore(
            engine: HQRecordingAppEngine(responses: Self.liveResponses),
            launchMode: .live,
            updaterService: HQNativeUpdaterService(driver: indigoDriver)
        )

        await indigoStore.start()
        await indigoStore.start()

        XCTAssertEqual(indigoDriver.startCallCount, 1)
        XCTAssertTrue(
            indigoDriver.startedFeedURL?.absoluteString
                .hasSuffix("/sparkle-beta/appcast.xml") == true
        )
        XCTAssertNil(indigoStore.updaterStartupFailure)

        var publicResponses = Self.liveResponses
        publicResponses["workspaces.list"] = .object([
            "source": .string("local"),
            "workspaces": .array([
                .object([
                    "slug": .string("acme"),
                    "displayName": .string("Acme"),
                    "path": .string("/tmp/acme"),
                    "exists": .bool(true),
                    "source": .string("local"),
                ]),
            ]),
        ])
        let publicDriver = HQAppStoreUpdaterDriverSpy()
        let publicStore = HQAppStore(
            engine: HQRecordingAppEngine(responses: publicResponses),
            launchMode: .live,
            updaterService: HQNativeUpdaterService(driver: publicDriver)
        )

        await publicStore.start()

        XCTAssertEqual(publicDriver.startCallCount, 1)
        XCTAssertTrue(
            publicDriver.startedFeedURL?.absoluteString
                .hasSuffix("/sparkle-stable/appcast.xml") == true
        )
        XCTAssertNil(publicStore.updaterStartupFailure)
    }

    func testUpdaterBootstrapFailureIsObservableAndNonfatal() async {
        let driver = HQAppStoreUpdaterDriverSpy()
        driver.startError = HQUpdaterError.cannotCheckForUpdates
        let store = HQAppStore(
            engine: HQRecordingAppEngine(responses: Self.liveResponses),
            launchMode: .live,
            updaterService: HQNativeUpdaterService(driver: driver)
        )

        await store.start()
        await store.start()

        XCTAssertEqual(driver.startCallCount, 1)
        XCTAssertEqual(store.phase, .ready)
        XCTAssertEqual(
            store.content.snapshot.workspaces.map(\.slug),
            ["indigo"]
        )
        XCTAssertNotNil(store.updaterStartupFailure)
        XCTAssertFalse(store.updaterStartupFailure?.isEmpty ?? true)
    }

    func testFixtureBootstrapNeverStartsProductionUpdater() async {
        let driver = HQAppStoreUpdaterDriverSpy()
        let store = HQAppStore(
            engine: HQRecordingAppEngine(responses: [:]),
            launchMode: .visualTourFixture,
            updaterService: HQNativeUpdaterService(driver: driver)
        )

        await store.start()

        XCTAssertEqual(driver.startCallCount, 0)
        XCTAssertNil(store.updaterStartupFailure)
    }

    func testOnboardingRunsEveryAdvertisedNativeStageInCanonicalOrder()
        async
    {
        var responses = Self.liveResponses
        responses["fetch_and_extract_template"] =
            .string("/tmp/HQ-native")
        for method in [
            "install_deps",
            "configure_claude_settings_path",
            "start_initial_cloud_sync",
            "install_default_packages",
            "git_init",
            "personalize_hq",
            "register_search_index",
            "record_step_start",
            "record_step_ok",
            "record_install_complete",
            "mark_first_run_complete",
        ] {
            responses[method] = .null
        }
        let stageMethods = [
            "fetch_and_extract_template",
            "install_deps",
            "configure_claude_settings_path",
            "start_initial_cloud_sync",
            "install_default_packages",
            "git_init",
            "personalize_hq",
            "register_search_index",
        ]
        let capabilities = Set(
            [
                "config.get",
                "auth.state",
                "workspaces.list",
                "sync.status",
                "projects.list",
                "sessions.list",
                "shutdown",
                "record_step_start",
                "record_step_ok",
                "record_step_failure",
                "record_install_complete",
                "mark_first_run_complete",
            ] + stageMethods
        )
        let engine = HQRecordingAppEngine(
            responses: responses,
            advertisedCapabilities: capabilities
        )
        let store = HQAppStore(
            engine: engine,
            launchMode: .live,
            updaterService: HQNativeUpdaterService(
                driver: HQAppStoreUpdaterDriverSpy()
            )
        )

        await store.start()
        await store.perform(
            .secondaryWindow(
                kind: .onboarding,
                actionID: "run-setup"
            )
        )

        XCTAssertTrue(
            store.setupStages.allSatisfy {
                $0.status == .complete
            }
        )
        XCTAssertEqual(store.hqFolderPath, "/tmp/HQ-native")
        let requested = await engine.requestedMethods()
        XCTAssertEqual(
            requested.filter(stageMethods.contains),
            stageMethods
        )
        XCTAssertFalse(requested.contains("import_existing_setup"))
        XCTAssertFalse(requested.contains("install_menubar_app"))
        XCTAssertTrue(requested.contains("record_install_complete"))
        XCTAssertTrue(requested.contains("mark_first_run_complete"))
        XCTAssertEqual(
            store.operationState,
            .success("All native setup stages completed.")
        )
    }

    func testOnboardingMissingCapabilityIsExplicitAndRecoveryDoesNotRepeatCompletedStages()
        async
    {
        var responses = Self.liveResponses
        responses["fetch_and_extract_template"] =
            .string("/tmp/HQ-native")
        for method in [
            "install_deps",
            "start_initial_cloud_sync",
            "install_default_packages",
            "git_init",
            "personalize_hq",
        ] {
            responses[method] = .null
        }
        let stageMethods = [
            "fetch_and_extract_template",
            "install_deps",
            "start_initial_cloud_sync",
            "install_default_packages",
            "git_init",
            "personalize_hq",
        ]
        let capabilities = Set(
            [
                "config.get",
                "auth.state",
                "workspaces.list",
                "sync.status",
                "projects.list",
                "sessions.list",
                "shutdown",
            ] + stageMethods
        )
        let engine = HQRecordingAppEngine(
            responses: responses,
            advertisedCapabilities: capabilities
        )
        let store = HQAppStore(
            engine: engine,
            launchMode: .live,
            updaterService: HQNativeUpdaterService(
                driver: HQAppStoreUpdaterDriverSpy()
            )
        )

        await store.start()
        await store.perform(
            .secondaryWindow(
                kind: .onboarding,
                actionID: "run-setup"
            )
        )
        XCTAssertEqual(
            store.setupStages.first {
                $0.id == .indexing
            }?.status,
            .unavailable
        )
        let firstRequests = await engine.requestedMethods()

        await store.perform(
            .secondaryWindow(
                kind: .recovery,
                actionID: "repair"
            )
        )
        let secondRequests = await engine.requestedMethods()
        for method in stageMethods {
            XCTAssertEqual(
                secondRequests.filter { $0 == method }.count,
                firstRequests.filter { $0 == method }.count,
                "Recovery repeated completed \(method)."
            )
        }
        guard case let .failure(message) = store.operationState else {
            return XCTFail("Missing capability must remain explicit")
        }
        XCTAssertTrue(message.contains("Register search index"))
    }

    func testNativeCompatibilityCommandsReturnExactLegacyResultShapes() async {
        let driver = HQAppStoreUpdaterDriverSpy()
        let store = HQAppStore(
            engine: HQRecordingAppEngine(responses: [:]),
            launchMode: .visualTourFixture,
            updaterService: HQNativeUpdaterService(driver: driver)
        )

        await store.perform(.nativeCommand(.homeDir))
        XCTAssertEqual(
            store.lastNativeResult,
            .string(FileManager.default.homeDirectoryForCurrentUser.path)
        )

        await store.perform(.nativeCommand(.listDisplays))
        guard case let .array(displays)? = store.lastNativeResult else {
            return XCTFail("list_displays must return an array")
        }
        XCTAssertEqual(displays.count, NSScreen.screens.count)
        for display in displays {
            guard case let .object(object) = display else {
                return XCTFail("Each display must be an object")
            }
            XCTAssertEqual(Set(object.keys), ["name", "primary"])
            guard case .string? = object["name"],
                  case .bool? = object["primary"]
            else {
                return XCTFail("Display fields must retain their legacy types")
            }
        }

        await store.perform(
            .nativeCommand(
                .applyWidgetSettings,
                payload: .object(["mode": .string("compact")])
            )
        )
        XCTAssertEqual(store.widgetMode, .compact)
        XCTAssertEqual(store.lastNativeResult, .null)

        let trayCases: [(String, HQTrayState)] = [
            ("idle", .current),
            ("syncing", .syncing),
            ("error", .error),
            ("conflict", .attention),
            ("prompt", .attention),
        ]
        for (rawValue, expected) in trayCases {
            await store.perform(
                .nativeCommand(.setTrayState, payload: .string(rawValue))
            )
            XCTAssertEqual(store.trayState, expected)
            XCTAssertEqual(store.lastNativeResult, .null)
        }

        await store.perform(
            .nativeCommand(.setWidgetFocusable, payload: .bool(false))
        )
        XCTAssertFalse(store.widgetIsFocusable)
        XCTAssertEqual(store.lastNativeResult, .null)

        await store.perform(
            .nativeCommand(
                .meetingsSetPromptBadge,
                payload: .object(["count": .number(2)])
            )
        )
        XCTAssertTrue(store.meetingPromptBadgeVisible)
        XCTAssertEqual(store.lastNativeResult, .null)
        await store.perform(
            .nativeCommand(.meetingsSetPromptBadge, payload: .number(0))
        )
        XCTAssertFalse(store.meetingPromptBadgeVisible)
        XCTAssertEqual(store.lastNativeResult, .null)

        await store.perform(.nativeCommand(.menubarInstalled))
        guard case let .object(menuBar)? = store.lastNativeResult else {
            return XCTFail("menubar_installed must return an object")
        }
        XCTAssertEqual(
            Set(menuBar.keys),
            ["installed", "version", "exePath"]
        )
        XCTAssertEqual(menuBar["installed"], .bool(true))

        await store.perform(.nativeCommand(.meetingsPermissionsState))
        guard case let .object(permissions)? = store.lastNativeResult else {
            return XCTFail("meetings_permissions_state must return an object")
        }
        XCTAssertEqual(
            Set(permissions.keys),
            [
                "accessibility",
                "screenCapture",
                "microphone",
                "systemAudio",
                "fullDiskAccess",
                "allRequiredGranted",
            ]
        )
        let statusVocabulary = Set(["granted", "denied", "prompt", "unknown"])
        for key in [
            "accessibility",
            "screenCapture",
            "microphone",
            "systemAudio",
            "fullDiskAccess",
        ] {
            guard case let .string(status)? = permissions[key] else {
                return XCTFail("\(key) must be a permission status string")
            }
            XCTAssertTrue(statusVocabulary.contains(status))
        }
        guard case .bool? = permissions["allRequiredGranted"] else {
            return XCTFail("allRequiredGranted must be a Boolean")
        }

        await store.perform(.nativeCommand(.claudeDesktopInstalled))
        guard case .bool? = store.lastNativeResult else {
            return XCTFail("claude_desktop_installed must return a Boolean")
        }

        await store.perform(.nativeCommand(.availableChannels))
        guard case let .array(channels)? = store.lastNativeResult else {
            return XCTFail("available_channels must return an array")
        }
        XCTAssertFalse(channels.isEmpty)
        XCTAssertTrue(channels.allSatisfy {
            guard case .string = $0 else { return false }
            return true
        })

        await store.perform(.nativeCommand(.getPendingUpdate))
        XCTAssertEqual(store.lastNativeResult, .null)
        let descriptor = HQUpdateDescriptor(
            version: "12.4.0",
            displayVersion: "12.4",
            releaseNotesURL: URL(string: "https://example.com/release")
        )
        driver.eventHandler?(.found(descriptor))
        await store.perform(.nativeCommand(.getPendingUpdate))
        XCTAssertEqual(
            store.lastNativeResult,
            .object([
                "version": .string("12.4.0"),
                "body": .null,
                "date": .null,
            ])
        )

        await store.perform(.nativeCommand(.showMainWindow))
        XCTAssertEqual(
            store.lastNativeResult,
            .null,
            "Unit-returning commands must clear any prior result."
        )
    }

    func testFinalNativeCompatibilityCommandsPreserveLegacyContracts() async throws {
        let temporaryRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let packDirectory = temporaryRoot
            .appendingPathComponent("pack", isDirectory: true)
        let avatarURL = temporaryRoot.appendingPathComponent("avatar.webp")
        let documentURL = temporaryRoot.appendingPathComponent("notes.md")
        let outsideURL = temporaryRoot.deletingLastPathComponent()
            .appendingPathComponent("\(UUID().uuidString)-outside.md")
        try FileManager.default.createDirectory(
            at: packDirectory,
            withIntermediateDirectories: true
        )
        try Data("avatar".utf8).write(to: avatarURL)
        try Data("native notes".utf8).write(to: documentURL)
        try Data("outside".utf8).write(to: outsideURL)
        defer {
            try? FileManager.default.removeItem(at: temporaryRoot)
            try? FileManager.default.removeItem(at: outsideURL)
        }

        var pickerResults = [[avatarURL], [packDirectory]]
        var pickerRequests: [HQFilePickerRequest] = []
        var openedURLs: [URL] = []
        let engine = HQRecordingAppEngine(
            responses: [
                "config.get": .object([
                    "source": .string("local"),
                    "config": .object([:]),
                ]),
                "auth.state": .object([
                    "source": .string("local"),
                    "authenticated": .bool(true),
                ]),
                "workspaces.list": .object([
                    "source": .string("local"),
                    "hqFolderPath": .string(temporaryRoot.path),
                    "workspaces": .array([]),
                ]),
                "sync.status": .object([:]),
                "projects.list": .array([]),
                "sessions.list": .array([]),
            ]
        )
        let store = HQAppStore(
            engine: engine,
            launchMode: .live,
            pickFiles: { request in
                pickerRequests.append(request)
                return pickerResults.removeFirst()
            },
            openWorkspaceURL: { url in
                openedURLs.append(url)
            }
        )
        await store.start()

        await store.perform(.nativeCommand(.pickAvatarFile))
        XCTAssertEqual(store.lastNativeResult, .string(avatarURL.path))
        guard case let .files(avatarTypes) = pickerRequests[0].mode else {
            return XCTFail("pick_avatar_file must use a file-only panel")
        }
        XCTAssertEqual(
            Set(avatarTypes.map(\.identifier)),
            Set([
                "public.png",
                "public.jpeg",
                "org.webmproject.webp",
                "com.compuserve.gif",
            ])
        )

        await store.perform(.nativeCommand(.pickPackDirectory))
        XCTAssertEqual(store.lastNativeResult, .string(packDirectory.path))
        XCTAssertEqual(pickerRequests[1].mode, .folders)

        await store.perform(
            .nativeCommand(
                .openInEditor,
                payload: .object(["path": .string("notes.md")])
            )
        )
        XCTAssertEqual(store.lastNativeResult, .null)
        XCTAssertEqual(
            openedURLs,
            [documentURL.resolvingSymlinksInPath().standardizedFileURL]
        )

        await store.perform(
            .nativeCommand(
                .openInEditor,
                payload: .object([
                    "path": .string("../\(outsideURL.lastPathComponent)"),
                ])
            )
        )
        guard case let .failure(editorFailure) = store.operationState else {
            return XCTFail("Workspace traversal must fail closed.")
        }
        XCTAssertTrue(editorFailure.contains("escapes the HQ workspace"))
        XCTAssertEqual(
            openedURLs,
            [documentURL.resolvingSymlinksInPath().standardizedFileURL]
        )

        await store.perform(
            .nativeCommand(.setMainWindowVibrancy, payload: .bool(false))
        )
        XCTAssertFalse(store.mainWindowVibrancyEnabled)
        XCTAssertEqual(store.lastNativeResult, .null)

        XCTAssertNil(store.sceneRequest)
        await store.perform(.nativeCommand(.showMainWindowAtTray))
        XCTAssertNil(
            store.sceneRequest,
            "The native replacement must not open a full main window where the legacy host showed an anchored popover."
        )
        XCTAssertEqual(store.menuBarHandoffGeneration, 1)
        XCTAssertEqual(store.trayState, .attention)
        XCTAssertEqual(store.lastNativeResult, .null)
        guard case let .success(message) = store.operationState else {
            return XCTFail("The native MenuBarExtra handoff must succeed.")
        }
        XCTAssertTrue(message.contains("MenuBarExtra"))

        await store.perform(
            .nativeCommand(
                .openMeetingsWindow,
                payload: .object([
                    "focusMeetingId": .string("meeting-native-42"),
                ])
            )
        )
        await store.perform(.nativeCommand(.meetingsTakePendingFocus))
        XCTAssertEqual(
            store.lastNativeResult,
            .string("meeting-native-42")
        )
        await store.perform(.nativeCommand(.meetingsTakePendingFocus))
        XCTAssertEqual(store.lastNativeResult, .null)

        await store.perform(
            .nativeCommand(
                .openMessagesWindow,
                payload: .object([
                    "target": .object([
                        "personUid": .string("person-native-42"),
                        "email": .string("native@example.com"),
                        "displayName": .string("Native Friend"),
                    ]),
                ])
            )
        )
        await store.perform(.nativeCommand(.takePendingMessagesTarget))
        XCTAssertEqual(
            store.lastNativeResult,
            .object([
                "personUid": .string("person-native-42"),
                "email": .string("native@example.com"),
                "displayName": .string("Native Friend"),
            ])
        )
        await store.perform(.nativeCommand(.takePendingMessagesTarget))
        XCTAssertEqual(store.lastNativeResult, .null)

        await store.perform(
            .nativeCommand(
                .meetingsSetPromptBadge,
                payload: .object(["count": .number(2)])
            )
        )
        await store.perform(.nativeCommand(.meetingsClearPromptBadge))
        XCTAssertTrue(
            store.meetingPromptBadgeVisible,
            "The legacy badge clear command decrements by one."
        )
        await store.perform(.nativeCommand(.meetingsClearPromptBadge))
        XCTAssertFalse(store.meetingPromptBadgeVisible)
        XCTAssertEqual(store.lastNativeResult, .null)
    }

    func testNativeMessageComposersPreserveExactBodiesAndDestinations() async {
        let engine = HQRecordingAppEngine(
            responses: [
                "send_dm": .null,
                "send_dm_to_email": .object([
                    "state": .string("connectionRequested"),
                ]),
                "send_channel_message": .null,
            ],
            advertisedCapabilities: [
                "send_dm",
                "send_dm_to_email",
                "send_channel_message",
            ]
        )
        let store = HQAppStore(
            engine: engine,
            launchMode: .uiTestingFixture
        )
        store.capabilities = [
            "send_dm",
            "send_dm_to_email",
            "send_channel_message",
        ]

        await store.perform(
            .nativeCommand(
                .openMessagesWindow,
                payload: .object([
                    "target": .object([
                        "personUid": .string("person-42"),
                        "email": .string("person@example.com"),
                        "displayName": .string("Person"),
                    ]),
                ])
            )
        )
        await store.perform(
            .sendMessage(
                HQMessagesSendRequest(
                    body: "  Preserve my DM body.  ",
                    section: .directMessages,
                    rowID: "target-person-person-42"
                )
            )
        )

        await store.perform(
            .nativeCommand(
                .openMessagesWindow,
                payload: .object([
                    "target": .object([
                        "personUid": .string(""),
                        "email": .string("email-only@example.com"),
                        "displayName": .string("Email Only"),
                    ]),
                ])
            )
        )
        await store.perform(
            .sendMessage(
                HQMessagesSendRequest(
                    body: "Email body",
                    section: .directMessages,
                    rowID: "target-email-email-only@example.com"
                )
            )
        )

        store.receiveEngineEvent(
            HQEngineEvent(
                requestID: nil,
                name: HQCloudRealtimeEventName.channelUpdated.rawValue,
                sequence: 1,
                data: .object([
                    "channelId": .string("channel-native"),
                    "name": .string("native"),
                    "scope": .string("company"),
                ])
            )
        )
        await store.perform(
            .sendMessage(
                HQMessagesSendRequest(
                    body: "Channel body",
                    section: .channels,
                    rowID: "list_channels-channel-native"
                )
            )
        )

        store.receiveEngineEvent(
            HQEngineEvent(
                requestID: nil,
                name: HQNativeParityEventName.notificationDMAction.rawValue,
                sequence: 2,
                data: .object([
                    "action": .string("open"),
                    "event": .object([
                        "eventId": .string("dm-detail-1"),
                        "fromPersonUid": .string("reply-person"),
                        "fromEmail": .string("reply@example.com"),
                        "fromDisplayName": .string("Reply Person"),
                        "body": .string("Reply to me"),
                        "details": .null,
                        "prompt": .null,
                        "createdAt": .string("2026-07-27T00:00:00Z"),
                    ]),
                ])
            )
        )
        await store.perform(
            .replyToDirectMessage("  Exact reply body.  ")
        )

        let directMessageParams = await engine.requestedParams(
            for: "send_dm"
        )
        let emailMessageParams = await engine.requestedParams(
            for: "send_dm_to_email"
        )
        let channelMessageParams = await engine.requestedParams(
            for: "send_channel_message"
        )
        XCTAssertEqual(
            directMessageParams,
            [
                .object([
                    "toPersonUid": .string("person-42"),
                    "body": .string("  Preserve my DM body.  "),
                ]),
                .object([
                    "toPersonUid": .string("reply-person"),
                    "body": .string("  Exact reply body.  "),
                ]),
            ]
        )
        XCTAssertEqual(
            emailMessageParams,
            [
                .object([
                    "toEmail": .string("email-only@example.com"),
                    "toPersonUid": .null,
                    "body": .string("Email body"),
                ]),
            ]
        )
        XCTAssertEqual(
            channelMessageParams,
            [
                .object([
                    "channelId": .string("channel-native"),
                    "body": .string("Channel body"),
                ]),
            ]
        )
    }

    func testMessagesSelectionAtomicallyChangesVisibleRecipientBeforeSend() async throws {
        var responses = Self.liveResponses
        responses["fetch_notification_history"] = .object([
            "dms": .array([
                .object([
                    "eventId": .string("dm-caitlin"),
                    "fromPersonUid": .string("person-caitlin"),
                    "fromEmail": .string("caitlin@example.com"),
                    "fromDisplayName": .string("Caitlin"),
                    "body": .string("Caitlin's prior conversation."),
                    "createdAt": .string("2026-07-27T02:00:00Z"),
                ]),
                .object([
                    "eventId": .string("dm-jacob"),
                    "fromPersonUid": .string("person-jacob"),
                    "fromEmail": .string("jacob@example.com"),
                    "fromDisplayName": .string("Jacob"),
                    "body": .string("Jacob's selected conversation."),
                    "createdAt": .string("2026-07-27T02:01:00Z"),
                ]),
            ]),
        ])
        responses["list_channels"] = .object([
            "channels": .array([
                .object([
                    "channelId": .string("channel-native"),
                    "title": .string("# native"),
                    "preview": .string("Native channel conversation."),
                ]),
            ]),
        ])
        responses["list_dm_requests"] = .object([
            "requests": .array([]),
        ])
        responses["fetch_dm_thread"] = .object([
            "messages": .array([
                .object([
                    "eventId": .string("jacob-thread-message"),
                    "fromPersonUid": .string("person-jacob"),
                    "fromDisplayName": .string("Jacob"),
                    "body": .string("Only Jacob's loaded thread is visible."),
                    "createdAt": .string("2026-07-27T02:02:00Z"),
                    "direction": .string("in"),
                ]),
            ]),
        ])
        responses["fetch_channel"] = .object([
            "messages": .array([
                .object([
                    "eventId": .string("channel-message-1"),
                    "fromPersonUid": .string("person-caitlin"),
                    "fromDisplayName": .string("Caitlin"),
                    "body": .string("Exact native channel content."),
                    "createdAt": .string("2026-07-27T02:03:00Z"),
                    "direction": .string("in"),
                ]),
            ]),
        ])
        responses["send_dm"] = .null
        responses["send_channel_message"] = .null

        let capabilities = Set(Self.liveResponses.keys).union([
            "fetch_notification_history",
            "list_channels",
            "list_dm_requests",
            "fetch_dm_thread",
            "fetch_channel",
            "send_dm",
            "send_channel_message",
        ])
        let engine = HQRecordingAppEngine(
            responses: responses,
            delayedMethods: ["fetch_dm_thread"],
            advertisedCapabilities: capabilities
        )
        let store = HQAppStore(
            engine: engine,
            launchMode: .live
        )
        await store.start()

        await store.perform(
            .selectMessageConversation(
                HQMessagesSelectionRequest(
                    section: .directMessages,
                    rowID: "fetch_notification_history-dm-caitlin"
                )
            )
        )
        for _ in 0..<100 {
            if store.messagesWindowFixture()?.selectionIsReady == true {
                break
            }
            try? await Task.sleep(nanoseconds: 5_000_000)
        }
        XCTAssertTrue(
            store.messagesWindowFixture()?.selectionIsReady == true
        )

        await store.perform(
            .selectMessageConversation(
                HQMessagesSelectionRequest(
                    section: .directMessages,
                    rowID: "fetch_notification_history-dm-jacob"
                )
            )
        )

        let loadingFixture = try XCTUnwrap(
            store.messagesWindowFixture()
        )
        XCTAssertEqual(loadingFixture.selectedSection, .directMessages)
        XCTAssertEqual(
            loadingFixture.selectedRowID,
            "target-person-person-jacob"
        )
        XCTAssertEqual(
            loadingFixture.selectedConversation.title,
            "Jacob"
        )
        XCTAssertFalse(loadingFixture.selectionIsReady)
        XCTAssertEqual(
            store.selectedMessagesConversation,
            HQMessagesSelectionRequest(
                section: .directMessages,
                rowID: "fetch_notification_history-dm-jacob"
            )
        )

        for _ in 0..<100 {
            if store.messagesWindowFixture()?.selectionIsReady == true {
                break
            }
            try? await Task.sleep(nanoseconds: 5_000_000)
        }
        let readyFixture = try XCTUnwrap(store.messagesWindowFixture())
        XCTAssertTrue(readyFixture.selectionIsReady)
        XCTAssertEqual(
            readyFixture.selectedConversation.messages.map(\.body),
            ["Only Jacob's loaded thread is visible."]
        )

        await store.perform(
            .sendMessage(
                HQMessagesSendRequest(
                    body: "Reply only to Jacob.",
                    section: .directMessages,
                    rowID: readyFixture.selectedRowID
                )
            )
        )
        let directMessageParams = await engine.requestedParams(
            for: "send_dm"
        )
        XCTAssertEqual(
            directMessageParams,
            [
                .object([
                    "toPersonUid": .string("person-jacob"),
                    "body": .string("Reply only to Jacob."),
                ]),
            ]
        )

        await store.perform(
            .selectMessageConversation(
                HQMessagesSelectionRequest(
                    section: .channels,
                    rowID: "list_channels-channel-native"
                )
            )
        )
        for _ in 0..<100 {
            if store.messagesWindowFixture()?.selectionIsReady == true {
                break
            }
            try? await Task.sleep(nanoseconds: 5_000_000)
        }
        let channelFixture = try XCTUnwrap(store.messagesWindowFixture())
        XCTAssertEqual(channelFixture.selectedSection, .channels)
        XCTAssertEqual(
            channelFixture.selectedConversation.title,
            "# native"
        )
        XCTAssertTrue(channelFixture.selectionIsReady)
        XCTAssertEqual(
            channelFixture.selectedConversation.messages.map(\.body),
            ["Exact native channel content."]
        )
        await store.perform(
            .sendMessage(
                HQMessagesSendRequest(
                    body: "Channel only.",
                    section: .channels,
                    rowID: "list_channels-channel-native"
                )
            )
        )
        let channelMessageParams = await engine.requestedParams(
            for: "send_channel_message"
        )
        XCTAssertEqual(
            channelMessageParams,
            [
                .object([
                    "channelId": .string("channel-native"),
                    "body": .string("Channel only."),
                ]),
            ]
        )
    }

    func testRecallDetectionUsesDurableEnginePolicyThenNativeDelivery()
        async throws
    {
        let notificationCenter = HQRouteNotificationCenterSpy()
        let notificationService = HQNativeNotificationService(
            center: notificationCenter
        )
        let updaterDriver = HQAppStoreUpdaterDriverSpy()
        let responses: [String: HQJSONValue] = [
            "config.get": .object([
                "source": .string("local"),
                "config": .object([:]),
            ]),
            "auth.state": .object([
                "source": .string("local"),
                "authenticated": .bool(true),
            ]),
            "workspaces.list": .object([
                "source": .string("local"),
                "workspaces": .array([]),
            ]),
            "sync.status": .object([:]),
            "projects.list": .array([]),
            "sessions.list": .array([]),
            "meetings_notify_detected": .object([
                "allowed": .bool(true),
                "reason": .string("allowed"),
                "notification": .object([
                    "title": .string("Meet meeting detected"),
                    "body": .string(
                        "Meet: https://meet.google.com/native-review"
                    ),
                    "windowId": .string("window-native-42"),
                    "platform": .string("meet"),
                    "meetingUrl": .string(
                        "https://meet.google.com/native-review"
                    ),
                    "sourceEventId": .string("source-native-42"),
                ]),
            ]),
        ]
        let capabilities: Set<String> = [
            "config.get",
            "auth.state",
            "workspaces.list",
            "sync.status",
            "projects.list",
            "sessions.list",
            "meetings_notify_detected",
        ]
        let engine = HQRecordingAppEngine(
            responses: responses,
            advertisedCapabilities: capabilities
        )
        let store = HQAppStore(
            engine: engine,
            launchMode: .live,
            notificationService: notificationService,
            updaterService: HQNativeUpdaterService(driver: updaterDriver)
        )
        await store.start()

        store.receiveEngineEvent(
            HQEngineEvent(
                requestID: nil,
                name: "meeting:detected",
                sequence: 42,
                data: .object([
                    "detectionId": .string("detection-native-42"),
                    "meetingUrl": .string(
                        "https://meet.google.com/native-review"
                    ),
                    "windowId": .string("window-native-42"),
                    "platform": .string("meet"),
                    "detectedAt": .string("2026-07-27T06:00:00Z"),
                    "source": .string("sdk-active-app"),
                    "sourceEventId": .string("source-native-42"),
                ])
            )
        )

        for _ in 0..<100 where store.nativeNotificationHistory.isEmpty {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        let notification = try XCTUnwrap(
            store.nativeNotificationHistory.last
        )
        XCTAssertEqual(notification.title, "Meet meeting detected")
        XCTAssertEqual(
            notification.body,
            "Meet: https://meet.google.com/native-review"
        )
        XCTAssertEqual(notification.categoryIdentifier, "hq.meeting")
        XCTAssertEqual(
            notification.userInfo,
            [
                "windowId": "window-native-42",
                "platform": "meet",
                "meetingUrl": "https://meet.google.com/native-review",
                "sourceEventId": "source-native-42",
            ]
        )
        XCTAssertTrue(store.isBannerPresented)
        XCTAssertEqual(store.activeBannerKind, .meetingReady)
        XCTAssertTrue(store.meetingPromptBadgeVisible)
        XCTAssertEqual(notificationCenter.addedRequests.count, 1)

        let detectedNotificationParams = await engine.requestedParams(
            for: "meetings_notify_detected"
        )
        XCTAssertEqual(
            detectedNotificationParams,
            [
                .object([
                    "payload": .object([
                        "meetingUrl": .string(
                            "https://meet.google.com/native-review"
                        ),
                        "windowId": .string("window-native-42"),
                        "platform": .string("meet"),
                        "summary": .null,
                        "sourceEventId": .string("source-native-42"),
                    ]),
                ]),
            ]
        )
    }

    func testSuppressedRecallNotificationNeverCrossesNativeDeliveryBoundary()
        async throws
    {
        let notificationCenter = HQRouteNotificationCenterSpy()
        let engine = HQRecordingAppEngine(
            responses: [
                "config.get": .object([
                    "source": .string("local"),
                    "config": .object([:]),
                ]),
                "auth.state": .object([
                    "source": .string("local"),
                    "authenticated": .bool(true),
                ]),
                "workspaces.list": .object([
                    "source": .string("local"),
                    "workspaces": .array([]),
                ]),
                "sync.status": .object([:]),
                "projects.list": .array([]),
                "sessions.list": .array([]),
                "meetings_notify_detected": .object([
                    "allowed": .bool(false),
                    "reason": .string("platform-filtered"),
                ]),
            ],
            advertisedCapabilities: [
                "config.get",
                "auth.state",
                "workspaces.list",
                "sync.status",
                "projects.list",
                "sessions.list",
                "meetings_notify_detected",
            ]
        )
        let store = HQAppStore(
            engine: engine,
            launchMode: .live,
            notificationService: HQNativeNotificationService(
                center: notificationCenter
            ),
            updaterService: HQNativeUpdaterService(
                driver: HQAppStoreUpdaterDriverSpy()
            )
        )
        await store.start()

        store.receiveEngineEvent(
            HQEngineEvent(
                requestID: nil,
                name: "meeting:detected",
                sequence: 43,
                data: .object([
                    "detectionId": .string("detection-suppressed"),
                    "meetingUrl": .string("https://zoom.us/j/42"),
                    "windowId": .string("window-suppressed"),
                    "platform": .string("zoom"),
                    "detectedAt": .string("2026-07-27T06:01:00Z"),
                    "source": .string("sdk-active-app"),
                    "sourceEventId": .string("source-suppressed"),
                ])
            )
        )

        for _ in 0..<100
        where store.secondaryDomainValues["meetings_notify_detected"] == nil {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTAssertEqual(
            store.secondaryDomainValues["meetings_notify_detected"],
            .object([
                "allowed": .bool(false),
                "reason": .string("platform-filtered"),
            ])
        )
        XCTAssertTrue(store.nativeNotificationHistory.isEmpty)
        XCTAssertTrue(notificationCenter.addedRequests.isEmpty)
        XCTAssertFalse(store.isBannerPresented)
        XCTAssertFalse(store.meetingPromptBadgeVisible)
        XCTAssertEqual(
            store.operationState,
            .success(
                "Meeting notification suppressed: platform-filtered."
            )
        )
    }

    func testMenuBarLabelReflectsEveryTrayStateAndNativeHandoff()
        async
    {
        let store = HQAppStore(
            engine: HQRecordingAppEngine(responses: [:]),
            launchMode: .uiTestingFixture
        )

        XCTAssertEqual(store.menuBarSymbolName, "h.circle")
        XCTAssertEqual(store.menuBarAccessibilityValue, "Connecting")

        await store.perform(
            .nativeCommand(.setTrayState, payload: .string("syncing"))
        )
        XCTAssertEqual(
            store.menuBarSymbolName,
            "arrow.triangle.2.circlepath.circle.fill"
        )
        XCTAssertEqual(store.menuBarAccessibilityValue, "Syncing")

        await store.perform(.nativeCommand(.showMainWindowAtTray))
        XCTAssertEqual(store.menuBarSymbolName, "exclamationmark.circle.fill")
        XCTAssertEqual(
            store.menuBarAccessibilityValue,
            "HQ is ready in the menu bar"
        )
        XCTAssertEqual(store.menuBarHandoffGeneration, 1)

        await store.perform(
            .nativeCommand(.setTrayState, payload: .string("error"))
        )
        XCTAssertEqual(store.menuBarSymbolName, "xmark.octagon.fill")
        XCTAssertEqual(store.menuBarAccessibilityValue, "Error")

        await store.perform(
            .nativeCommand(.setTrayState, payload: .string("current"))
        )
        XCTAssertEqual(store.menuBarSymbolName, "h.circle")
        XCTAssertEqual(store.menuBarAccessibilityValue, "Connecting")
    }

    func testMenuBannerAndMeetingControlsEmitTypedParityContracts()
        async
    {
        XCTAssertEqual(
            HQSecondaryWindowActionRegistry.resolution(
                for: .menuBar,
                actionID: "open"
            ),
            .nativeParityEvent(.trayOpenDesktop, data: nil)
        )
        XCTAssertEqual(
            HQSecondaryWindowActionRegistry.resolution(
                for: .menuBar,
                actionID: "settings"
            ),
            .nativeParityEvent(.trayOpenSettings, data: nil)
        )
        XCTAssertEqual(
            HQSecondaryWindowActionRegistry.resolution(
                for: .menuBar,
                actionID: "sign-out"
            ),
            .nativeParityEvent(.traySignOut, data: nil)
        )
        XCTAssertEqual(
            HQSecondaryWindowActionRegistry.resolution(
                for: .menuBar,
                actionID: "sync-now"
            ),
            .nativeParityEvent(.traySyncNow, data: nil)
        )
        XCTAssertEqual(
            HQSecondaryWindowActionRegistry.resolution(
                for: .menuBar,
                actionID: "check-updates"
            ),
            .nativeParityEvent(.trayCheckForUpdates, data: nil)
        )

        let engine = HQRecordingAppEngine(
            responses: ["start_recording": .null],
            advertisedCapabilities: ["start_recording"]
        )
        let store = HQAppStore(
            engine: engine,
            launchMode: .uiTestingFixture,
            updaterService: HQNativeUpdaterService(
                driver: HQAppStoreUpdaterDriverSpy()
            )
        )
        store.capabilities = ["start_recording"]

        await store.perform(
            .secondaryWindow(kind: .menuBar, actionID: "settings")
        )
        XCTAssertEqual(
            store.nativeParityEvents.history.last?.name,
            .trayOpenSettings
        )
        XCTAssertEqual(store.sceneRequest?.sceneID, "settings")

        await store.perform(
            .secondaryWindow(
                kind: .banner,
                actionID: "banner.direct-message.open"
            )
        )
        XCTAssertEqual(
            store.nativeParityEvents.lastBannerAction?.source,
            .dm
        )
        XCTAssertEqual(
            store.nativeParityEvents.lastBannerAction?.action,
            "open"
        )
        XCTAssertEqual(store.sceneRequest?.sceneID, "dm-detail")

        await store.perform(
            .secondaryWindow(
                kind: .meetings,
                actionID: "meeting-action|start|window-live-1|company-1"
            )
        )
        guard case let .meetingsWindowAction(action)? =
            store.nativeParityEvents.latest[.meetingsWindowAction]
        else {
            return XCTFail("Meeting control did not emit its typed event.")
        }
        XCTAssertEqual(action.operation, .start)
        XCTAssertEqual(action.windowID, "window-live-1")
        XCTAssertEqual(action.companyUID, "company-1")

        for _ in 0..<100 {
            if await engine.requestedMethods().contains(
                "start_recording"
            ) {
                break
            }
            await Task.yield()
        }
        let startRecordingParams = await engine.requestedParams(
            for: "start_recording"
        )
        XCTAssertEqual(
            startRecordingParams,
            [
                .object([
                    "windowId": .string("window-live-1"),
                    "companyUid": .string("company-1"),
                ]),
            ]
        )
    }

    func testMeetingPromptBadgeRejectsFractionalCount() async {
        let store = HQAppStore(
            engine: HQRecordingAppEngine(responses: [:]),
            launchMode: .visualTourFixture
        )

        await store.perform(
            .nativeCommand(
                .meetingsSetPromptBadge,
                payload: .number(1.5)
            )
        )

        XCTAssertEqual(
            store.operationState,
            .failure(
                "meetings_set_prompt_badge requires a nonnegative integer count."
            )
        )
        XCTAssertEqual(store.lastNativeResult, .null)
    }

    func testUnsupportedActionPublishesExplicitCapabilityErrorWithoutFakeSuccess() async {
        let engine = HQRecordingAppEngine(responses: [:])
        let store = HQAppStore(engine: engine, launchMode: .live)
        store.capabilities = ["config.get"]

        await store.perform(.syncNow)

        guard case let .failure(message) = store.operationState else {
            return XCTFail("Expected an explicit failure state")
        }
        XCTAssertTrue(message.contains("start_sync"))
    }

    func testEngineActionPublishesBusyThenSuccessState() async {
        let engine = HQRecordingAppEngine(
            responses: [
                "start_sync": .object(["completed": .bool(true)]),
            ],
            delayedMethods: ["start_sync"]
        )
        let store = HQAppStore(
            engine: engine,
            launchMode: .live,
            allowsUnresolvedAuthenticationForTesting: true
        )
        store.capabilities = ["start_sync"]

        let operation = Task {
            await store.perform(.syncNow)
        }
        await Task.yield()

        XCTAssertEqual(store.operationState, .busy("Running start_sync…"))
        await operation.value
        XCTAssertEqual(store.operationState, .success("Sync completed."))
    }

    func testMainAndMenuBarSyncActionsUseOnlyCanonicalStartSync() async {
        let engine = HQRecordingAppEngine(
            responses: [
                "start_sync": .object(["completed": .bool(true)]),
            ]
        )
        let store = HQAppStore(
            engine: engine,
            launchMode: .live,
            allowsUnresolvedAuthenticationForTesting: true
        )
        store.capabilities = ["start_sync"]

        await store.perform(.syncNow)
        await store.perform(
            .secondaryWindow(kind: .menuBar, actionID: "sync-now")
        )

        for _ in 0..<100 {
            if await engine.requestedParams(for: "start_sync").count == 2 {
                break
            }
            try? await Task.sleep(nanoseconds: 1_000_000)
        }
        let startSyncParams = await engine.requestedParams(
            for: "start_sync"
        )
        XCTAssertEqual(
            startSyncParams,
            [.object([:]), .object([:])]
        )
        let methods = await engine.requestedMethods()
        XCTAssertFalse(methods.contains("sync.run"))
        XCTAssertEqual(
            HQSecondaryWindowActionRegistry.resolution(
                for: .menuBar,
                actionID: "sync-now"
            ),
            .nativeParityEvent(.traySyncNow, data: nil)
        )
    }

    func testLiveModeNeverSubstitutesPreviewSentinels() async {
        let engine = HQRecordingAppEngine(responses: Self.liveResponses)
        let store = HQAppStore(engine: engine, launchMode: .live)

        XCTAssertTrue(store.content.snapshot.workspaces.isEmpty)
        XCTAssertTrue(store.content.messages.isEmpty)
        await store.start()

        XCTAssertEqual(store.content.snapshot.projects.map(\.title), ["Native macOS"])
        XCTAssertFalse(store.content.snapshot.projects.map(\.title).contains("HQ for macOS"))
        XCTAssertFalse(store.content.messages.contains { $0.person == "Maya Chen" })
        XCTAssertTrue(store.content.meetings.isEmpty)
        XCTAssertTrue(store.content.packs.isEmpty)
        XCTAssertTrue(store.content.people.isEmpty)
    }

    func testLiveSecondaryDomainsRenderOnlyEngineBackedRows() async {
        let capabilities: Set<String> = [
            "config.get",
            "auth.state",
            "workspaces.list",
            "sync.status",
            "projects.list",
            "sessions.list",
            "shutdown",
            "list_channels",
            "list_dm_requests",
            "fetch_notification_history",
            "get_activity_log",
            "get_company_activity",
            "get_lifecycle_state",
        ]
        var responses = Self.liveResponses
        responses["list_channels"] = .object([
            "channels": .array([
                .object([
                    "id": .string("channel-1"),
                    "name": .string("Native macOS"),
                    "preview": .string("Engine-backed message"),
                ]),
            ]),
        ])
        responses["list_dm_requests"] = .object(["requests": .array([])])
        responses["fetch_notification_history"] = .object([
            "dms": .array([
                .object([
                    "id": .string("dm-1"),
                    "title": .string("Direct message"),
                    "body": .string("Live history"),
                ]),
            ]),
            "shares": .array([
                .object([
                    "id": .string("share-1"),
                    "title": .string("Shared brief"),
                    "path": .string("knowledge/brief.md"),
                ]),
            ]),
            "files": .array([
                .object([
                    "id": .string("file-1"),
                    "title": .string("New file"),
                    "path": .string("knowledge/new.md"),
                ]),
            ]),
        ])
        responses["get_activity_log"] = .array([
            .object([
                "id": .string("local-activity-1"),
                "title": .string("Native app launched"),
                "detail": .string("Local activity log"),
            ]),
        ])
        responses["get_company_activity"] = .object([
            "activity": .array([
                .object([
                    "id": .string("activity-1"),
                    "title": .string("Project advanced"),
                    "detail": .string("Native story completed"),
                ]),
            ]),
        ])
        responses["get_lifecycle_state"] = .object([
            "changes": .array([
                .object([
                    "id": .string("core-change"),
                    "title": .string("Core state"),
                    "status": .string("clean"),
                ]),
            ]),
        ])
        let engine = HQRecordingAppEngine(
            responses: responses,
            advertisedCapabilities: capabilities
        )
        let store = HQAppStore(engine: engine, launchMode: .live)

        await store.start()

        XCTAssertEqual(
            rowTitles(in: store.windowState(for: .messages)),
            ["Native macOS"]
        )
        XCTAssertEqual(
            rowTitles(in: store.windowState(for: .activity)),
            ["Native app launched", "Project advanced"]
        )
        XCTAssertEqual(
            rowTitles(in: store.windowState(for: .shareDetail)),
            ["Shared brief"]
        )
        XCTAssertEqual(
            rowTitles(in: store.windowState(for: .newFiles)),
            ["New file"]
        )
        XCTAssertEqual(
            rowTitles(in: store.windowState(for: .drift)),
            ["Core state"]
        )
        XCTAssertEqual(
            Set(rowTitles(in: store.windowState(for: .notificationHistory))),
            ["Direct message", "Shared brief", "New file"]
        )
        let methods = await engine.requestedMethods()
        XCTAssertTrue(methods.contains("get_activity_log"))
        XCTAssertTrue(methods.contains("get_company_activity"))
    }

    func testNativeOAuthSignInRunsExactEngineFlowAndRefreshesAuthState() async {
        var responses = Self.liveResponses
        responses["auth.state"] = .object([
            "authenticated": .bool(false),
            "hasStoredTokens": .bool(false),
        ])
        responses["start_oauth_login"] = .object([
            "authorizeUrl": .string("https://auth.example.test/authorize"),
            "state": .string("state-1"),
        ])
        responses["oauth_listen_for_code"] = .object([
            "code": .string("code-1"),
        ])
        responses["oauth_exchange_code"] = .object([
            "authenticated": .bool(true),
            "expiresAt": .string("2026-07-27T00:00:00Z"),
        ])
        let capabilities: Set<String> = [
            "config.get",
            "auth.state",
            "workspaces.list",
            "sync.status",
            "projects.list",
            "sessions.list",
            "shutdown",
            "start_oauth_login",
            "oauth_listen_for_code",
            "oauth_exchange_code",
            "oauth_cancel_listen",
        ]
        let engine = HQRecordingAppEngine(
            responses: responses,
            advertisedCapabilities: capabilities
        )
        var openedURLs: [URL] = []
        let store = HQAppStore(
            engine: engine,
            launchMode: .live,
            openExternalURL: { openedURLs.append($0) }
        )
        await store.start()

        await store.perform(
            .secondaryWindow(kind: .signIn, actionID: "sign-in-google")
        )

        XCTAssertEqual(
            openedURLs.map(\.absoluteString),
            ["https://auth.example.test/authorize"]
        )
        XCTAssertTrue(store.isAuthenticated)
        XCTAssertEqual(store.sceneRequest?.sceneID, "main")
        let requestedMethods = await engine.requestedMethods()
        XCTAssertEqual(
            requestedMethods.filter {
                $0.hasPrefix("oauth_") || $0 == "start_oauth_login"
            },
            [
                "start_oauth_login",
                "oauth_listen_for_code",
                "oauth_exchange_code",
            ]
        )
        XCTAssertEqual(
            store.operationState,
            .success("Signed in to HQ with Google.")
        )
    }

    func testEveryProductionRouteLoadsRealEngineDataWithExactParameters() async {
        let routeCapabilities: Set<String> = [
            "config.get",
            "auth.state",
            "workspaces.list",
            "sync.status",
            "projects.list",
            "sessions.list",
            "shutdown",
            "list_channels",
            "list_dm_requests",
            "fetch_notification_history",
            "meetings_list_accounts",
            "list_marketplace_listings",
            "list_moderation_queue",
            "get_library_root",
            "get_library_company",
            "list_packages",
            "get_my_creator",
            "get_company_file_tree",
            "get_company_file_content",
            "get_company_summary",
            "get_company_board",
            "get_company_crm_projection_vault",
            "get_company_project_creators",
            "get_company_team_telemetry",
            "get_company_activity",
            "get_company_deployments",
            "get_company_secrets",
            "get_local_company_goals",
            "get_sync_mode",
            "get_local_project_prd",
            "get_local_project_readme",
        ]
        var responses = Self.liveResponses
        responses.merge([
            "list_channels": .object([
                "channels": .array([
                    .object([
                        "channelId": .string("channel-1"),
                        "name": .string("Product"),
                        "preview": .string("Native route data"),
                    ]),
                ]),
            ]),
            "list_dm_requests": .object(["requests": .array([])]),
            "fetch_notification_history": .object([
                "dms": .array([]),
                "shares": .array([]),
                "files": .array([]),
            ]),
            "meetings_list_accounts": .array([
                .object([
                    "id": .string("calendar-1"),
                    "name": .string("HQ Calendar"),
                    "status": .string("connected"),
                ]),
            ]),
            "list_marketplace_listings": .array([
                .object([
                    "id": .string("listing-1"),
                    "name": .string("Native craft"),
                    "slug": .string("native-craft"),
                    "version": .string("1.0.0"),
                    "summary": .string("A real marketplace response"),
                ]),
            ]),
            "list_moderation_queue": .array([
                .object([
                    "id": .string("review-1"),
                    "name": .string("Review craft"),
                    "slug": .string("review-craft"),
                    "versionLock": .string("v1"),
                    "summary": .string("Awaiting native review"),
                ]),
            ]),
            "get_library_root": .object([
                "skills": .array([
                    .object([
                        "name": .string("Native craft"),
                        "description": .string("Build real AppKit surfaces"),
                        "path": .string(".claude/skills/native-craft/SKILL.md"),
                    ]),
                ]),
                "workers": .array([
                    .object([
                        "id": .string("worker-1"),
                        "name": .string("Native Worker"),
                        "description": .string("Owns macOS implementation"),
                        "path": .string("core/workers/native"),
                    ]),
                ]),
            ]),
            "get_library_company": .object([
                "skills": .array([
                    .object([
                        "name": .string("Company craft"),
                        "description": .string("Indigo native craft"),
                        "path": .string("companies/indigo/skills/craft/SKILL.md"),
                    ]),
                ]),
                "workers": .array([
                    .object([
                        "id": .string("company-worker-1"),
                        "name": .string("Company Worker"),
                        "description": .string("Indigo native worker"),
                        "path": .string("companies/indigo/workers/native"),
                    ]),
                ]),
            ]),
            "list_packages": .object([
                "packages": .array([
                    .object([
                        "id": .string("engineering"),
                        "name": .string("Engineering"),
                        "status": .string("installed"),
                        "version": .string("2.0.0"),
                    ]),
                ]),
            ]),
            "get_my_creator": .object([
                "handle": .string("corey"),
                "displayName": .string("Corey"),
                "bio": .string("Building native HQ"),
                "socialLinks": .array([]),
            ]),
            "get_company_file_tree": .object([
                "name": .string("indigo"),
                "path": .string("companies/indigo"),
                "isDir": .bool(true),
                "children": .array([
                    .object([
                        "name": .string("brief.md"),
                        "path": .string("companies/indigo/knowledge/brief.md"),
                        "isDir": .bool(false),
                        "children": .array([]),
                    ]),
                ]),
            ]),
            "get_company_file_content": .string("# Native brief"),
            "get_company_summary": .object([
                "board": .number(1),
                "activity": .object(["last7d": .number(4)]),
                "deployments": .number(1),
                "secrets": .number(1),
            ]),
            "get_company_board": .object([
                "inbox": .array([
                    .object([
                        "id": .string("board-1"),
                        "title": .string("Launch"),
                        "status": .string("inbox"),
                    ]),
                ]),
                "doing": .array([]),
                "review": .array([]),
                "done": .array([]),
            ]),
            "get_company_crm_projection_vault": .null,
            "get_company_project_creators": .array([
                .object([
                    "id": .string("native-macos"),
                    "creator": .string("Ada"),
                ]),
            ]),
            "get_company_team_telemetry": .object([
                "humans": .number(3),
                "agents": .number(2),
            ]),
            "get_company_activity": .object([
                "recent": .array([
                    .object([
                        "id": .string("activity-1"),
                        "who": .string("Ada"),
                        "what": .string("Completed native route loading"),
                        "when": .string("Now"),
                    ]),
                ]),
            ]),
            "get_company_deployments": .array([
                .object([
                    "sub": .string("HQ"),
                    "url": .string("https://hq.example.test"),
                    "state": .string("ready"),
                ]),
            ]),
            "get_company_secrets": .array([
                .object([
                    "env": .string("prod"),
                    "count": .number(1),
                    "items": .array([
                        .object([
                            "key": .string("API_KEY"),
                            "upd": .string("2026-07-26"),
                            "rot": .string("current"),
                        ]),
                    ]),
                ]),
            ]),
            "get_local_company_goals": .object([
                "objectives": .array([
                    .object([
                        "id": .string("goal-1"),
                        "title": .string("Native UI"),
                        "detail": .string("Ship every native route"),
                    ]),
                ]),
                "initiatives": .array([]),
            ]),
            "get_sync_mode": .object([
                "syncMode": .string("shared"),
                "isDefault": .bool(false),
            ]),
            "get_local_project_prd": .object([
                "name": .string("Native macOS"),
                "description": .string("A real native application"),
                "userStories": .array([
                    .object([
                        "id": .string("NATIVE-001"),
                        "title": .string("Shell"),
                        "description": .string("Build the native shell"),
                        "passes": .bool(false),
                    ]),
                ]),
            ]),
            "get_local_project_readme": .string("# Native macOS"),
        ]) { _, new in new }
        let engine = HQRecordingAppEngine(
            responses: responses,
            advertisedCapabilities: routeCapabilities
        )
        let store = HQAppStore(engine: engine, launchMode: .live)
        await store.start()

        let routesAndExpectedRows: [(HQRoute, String)] = [
            (.global(.inbox), "Product"),
            (.global(.meetings), "HQ Calendar"),
            (.global(.marketplace), "Native craft"),
            (.global(.moderation), "Review craft"),
            (.library(.skills), "Native craft"),
            (.library(.workers), "Native Worker"),
            (.library(.installed), "Engineering"),
            (.library(.profile), "Corey"),
            (.files(slug: "indigo", path: "knowledge/brief.md"), "brief.md"),
            (.company(slug: "indigo", section: .overview), "Launch"),
            (.company(slug: "indigo", section: .goals), "Native UI"),
            (.company(slug: "indigo", section: .projects), "Launch"),
            (.company(slug: "indigo", section: .skills), "Company craft"),
            (.company(slug: "indigo", section: .workers), "Company Worker"),
            (.company(slug: "indigo", section: .knowledge), "brief.md"),
            (.company(slug: "indigo", section: .team), "Ada"),
            (.company(slug: "indigo", section: .activity), "Ada"),
            (.company(slug: "indigo", section: .deployments), "HQ"),
            (.company(slug: "indigo", section: .secrets), "prod"),
            (.company(slug: "indigo", section: .settings), "Sync Mode"),
            (.settings(.sync), "Sync Mode"),
            (
                .project(company: "indigo", projectID: "native-macos"),
                "Shell"
            ),
            (
                .task(
                    company: "indigo",
                    projectID: "native-macos",
                    taskID: "NATIVE-001"
                ),
                "Shell"
            ),
        ]

        for (route, expectedRow) in routesAndExpectedRows {
            if route == .settings(.sync) {
                await store.perform(.selectSyncWorkspace("indigo"))
            }
            await store.loadLiveRoute(route)
            XCTAssertTrue(
                routeRowTitles(in: store.liveRouteState(for: route))
                    .contains(expectedRow),
                "\(HQRouteParser.serialize(route)) did not render \(expectedRow)"
            )
        }

        let activityParams = await engine.requestedParams(
            for: "get_company_activity"
        )
        let goalsParams = await engine.requestedParams(
            for: "get_local_company_goals"
        )
        let treeParams = await engine.requestedParams(
            for: "get_company_file_tree"
        )
        let contentParams = await engine.requestedParams(
            for: "get_company_file_content"
        )
        let syncModeParams = await engine.requestedParams(
            for: "get_sync_mode"
        )
        let projectParams = await engine.requestedParams(
            for: "get_local_project_prd"
        )
        XCTAssertEqual(
            activityParams.last,
            .object(["slug": .string("indigo")])
        )
        XCTAssertEqual(
            goalsParams.last,
            .object(["companySlug": .string("indigo")])
        )
        XCTAssertEqual(
            treeParams.last,
            .object(["slug": .string("indigo")])
        )
        XCTAssertEqual(
            contentParams.last,
            .object([
                "path": .string("companies/indigo/knowledge/brief.md"),
            ])
        )
        XCTAssertEqual(
            syncModeParams.last,
            .object(["companySlug": .string("indigo")])
        )
        XCTAssertEqual(
            projectParams.last,
            .object([
                "prdPath": .string(
                    "companies/indigo/projects/native-macos/prd.json"
                ),
            ])
        )
    }

    func testSyncSettingsDoNotQueryTheFirstLocalWorkspaceBeforeSelection() async {
        var responses = Self.liveResponses
        responses["workspaces.list"] = .object([
            "source": .string("local"),
            "hqFolderPath": .string("/tmp/HQ"),
            "workspaces": .array([
                .object([
                    "slug": .string("alive"),
                    "displayName": .string("Alive"),
                    "path": .string("/tmp/HQ/companies/alive"),
                    "exists": .bool(true),
                    "source": .string("local"),
                ]),
                .object([
                    "slug": .string("indigo"),
                    "displayName": .string("Indigo"),
                    "path": .string("/tmp/HQ/companies/indigo"),
                    "exists": .bool(true),
                    "source": .string("local"),
                ]),
            ]),
        ])
        responses["get_sync_mode"] = .object([
            "syncMode": .string("shared"),
            "isDefault": .bool(false),
        ])
        let engine = HQRecordingAppEngine(
            responses: responses,
            advertisedCapabilities: Set(responses.keys)
        )
        let store = HQAppStore(engine: engine, launchMode: .live)
        await store.start()

        await store.loadLiveRoute(.settings(.sync))

        XCTAssertTrue(
            routeRowTitles(
                in: store.liveRouteState(for: .settings(.sync))
            ).isEmpty
        )
        let requestedSyncModes = await engine.requestedParams(
            for: "get_sync_mode"
        )
        XCTAssertEqual(
            requestedSyncModes,
            [],
            "Settings must not assume the first local workspace has a cloud membership."
        )

        store.selectedRoute = .settings(.sync)
        await store.perform(.selectSyncWorkspace("indigo"))

        XCTAssertTrue(
            routeRowTitles(
                in: store.liveRouteState(for: .settings(.sync))
            ).contains("Sync Mode")
        )
        let selectedSyncModeParams = await engine.requestedParams(
            for: "get_sync_mode"
        )
        XCTAssertEqual(
            selectedSyncModeParams.last,
            .object(["companySlug": .string("indigo")])
        )
    }

    func testInWindowNavigationReusesTheExistingMainWindow() async {
        let store = HQAppStore(
            engine: HQRecordingAppEngine(responses: [:]),
            launchMode: .visualTourFixture
        )
        await store.start()
        XCTAssertNil(store.sceneRequest)

        await store.perform(.navigate(.library(.workers)))

        XCTAssertEqual(store.selectedRoute, .library(.workers))
        XCTAssertNil(
            store.sceneRequest,
            "Changing tabs inside the native shell must not open another WindowGroup instance."
        )
    }

    func testLiveRouteLoaderDistinguishesHonestEmptyAndFailureStates() async {
        var responses = Self.liveResponses
        responses["list_marketplace_listings"] = .array([])
        let capabilities: Set<String> = [
            "config.get",
            "auth.state",
            "workspaces.list",
            "sync.status",
            "projects.list",
            "sessions.list",
            "shutdown",
            "list_marketplace_listings",
            "meetings_list_accounts",
        ]
        let engine = HQRecordingAppEngine(
            responses: responses,
            advertisedCapabilities: capabilities
        )
        let store = HQAppStore(engine: engine, launchMode: .live)
        await store.start()

        await store.loadLiveRoute(.global(.marketplace))
        guard case .empty = store.liveRouteState(for: .global(.marketplace)) else {
            return XCTFail("An empty marketplace response must render an honest empty state.")
        }

        await store.loadLiveRoute(.global(.meetings))
        guard case let .failure(failure) = store.liveRouteState(
            for: .global(.meetings)
        ) else {
            return XCTFail("An engine error must render an actionable failure state.")
        }
        XCTAssertTrue(failure.message.contains("meetings_list_accounts"))
    }

    func testNativeEventConsumersRecordEveryParityEventAndApplyState() async {
        let store = HQAppStore(
            engine: HQRecordingAppEngine(responses: [:]),
            launchMode: .live,
            allowsUnresolvedAuthenticationForTesting: true
        )

        await store.perform(
            .nativeEvent(
                .bannerEvent,
                data: .object(["presented": .bool(true)])
            )
        )
        await store.perform(
            .nativeEvent(
                .widgetNotification,
                data: .object(["kind": .string("sync")])
            )
        )
        await store.perform(
            .nativeEvent(
                .widgetOcclusion,
                data: .object(["occluded": .bool(true)])
            )
        )
        await store.perform(
            .nativeEvent(
                .widgetClickAway,
                data: .object(["windowNumber": .number(1)])
            )
        )

        XCTAssertEqual(
            Set(store.nativeEventHistory.map(\.event)),
            Set(HQNativeEvent.allCases)
        )
        XCTAssertEqual(store.nativeEventHistory.count, 4)
        XCTAssertTrue(store.isBannerPresented)
        XCTAssertEqual(store.trayState, .attention)
        XCTAssertTrue(store.widgetIsOccluded)
        XCTAssertFalse(store.widgetIsFocusable)
    }

    func testRecallEngineEventSubscriberReducesEveryExactProducerPayload() {
        XCTAssertEqual(
            Set(HQRecallEventName.allCases.map(\.rawValue)),
            [
                "meeting:detected",
                "meeting:closed",
                "permission:status",
                "permissions:all-granted",
                "recording:started",
                "recording:ended",
                "recording:media-capture",
                "recording:error",
            ]
        )
        let store = HQAppStore(
            engine: HQRecordingAppEngine(responses: [:]),
            launchMode: .live,
            allowsUnresolvedAuthenticationForTesting: true
        )

        store.receiveEngineEvent(
            HQEngineEvent(
                requestID: nil,
                name: "meeting:detected",
                sequence: 1,
                data: .object([
                    "detectionId": .string("detection-1"),
                    "meetingUrl": .string("https://meet.google.com/abc-defg-hij"),
                    "windowId": .string("window-1"),
                    "platform": .string("meet"),
                    "detectedAt": .string("2026-07-26T21:00:00Z"),
                    "source": .string("sdk-active-app"),
                    "sourceEventId": .string("source-1"),
                ])
            )
        )
        XCTAssertEqual(
            store.detectedMeetings["detection-1"]?.platform,
            .meet
        )

        store.receiveEngineEvent(
            HQEngineEvent(
                requestID: nil,
                name: "permission:status",
                sequence: 2,
                data: .object([
                    "permission": .string("microphone"),
                    "status": .string("granted"),
                ])
            )
        )
        XCTAssertEqual(
            store.recallPermissionStatuses[.microphone],
            "granted"
        )

        store.receiveEngineEvent(
            HQEngineEvent(
                requestID: nil,
                name: "permissions:all-granted",
                sequence: 3,
                data: .object([:])
            )
        )
        XCTAssertTrue(store.allRecallPermissionsGranted)

        store.receiveEngineEvent(
            HQEngineEvent(
                requestID: nil,
                name: "recording:started",
                sequence: 4,
                data: .object([
                    "windowId": .string("window-1"),
                    "platform": .string("meet"),
                    "startedAt": .string("2026-07-26T21:01:00Z"),
                ])
            )
        )
        XCTAssertEqual(
            store.activeRecallRecordings["window-1"]?.platform,
            .meet
        )

        store.receiveEngineEvent(
            HQEngineEvent(
                requestID: nil,
                name: "recording:media-capture",
                sequence: 5,
                data: .object([
                    "windowId": .string("window-1"),
                    "captureType": .string("system-audio"),
                    "capturing": .bool(true),
                ])
            )
        )
        XCTAssertEqual(
            store.recallMediaCapture["window-1"]?.capturing,
            true
        )

        store.receiveEngineEvent(
            HQEngineEvent(
                requestID: nil,
                name: "recording:ended",
                sequence: 6,
                data: .object([
                    "windowId": .string("window-1"),
                    "platform": .string("meet"),
                    "endedAt": .string("2026-07-26T21:30:00Z"),
                ])
            )
        )
        XCTAssertNil(store.activeRecallRecordings["window-1"])
        XCTAssertEqual(store.lastRecallRecordingEnded?.windowID, "window-1")

        store.receiveEngineEvent(
            HQEngineEvent(
                requestID: nil,
                name: "recording:error",
                sequence: 7,
                data: .object([
                    "cmd": .string("record"),
                    "windowId": .string("window-1"),
                    "message": .string("Native helper exited"),
                ])
            )
        )
        XCTAssertEqual(
            store.lastRecallRecordingError?.message,
            "Native helper exited"
        )

        store.receiveEngineEvent(
            HQEngineEvent(
                requestID: nil,
                name: "meeting:closed",
                sequence: 8,
                data: .object([
                    "windowId": .string("window-1"),
                    "platform": .string("meet"),
                    "closedAt": .string("2026-07-26T21:31:00Z"),
                ])
            )
        )
        XCTAssertTrue(store.detectedMeetings.isEmpty)
        XCTAssertNil(store.recallMediaCapture["window-1"])
        XCTAssertEqual(
            Set(store.recallEventHistory.map(\.name)),
            Set(HQRecallEventName.allCases)
        )
        XCTAssertEqual(store.recallEventHistory.count, 8)
    }

    func testDMRequestUpdateSubscriberPrunesPendingStateForEveryProducerState() async {
        var responses = Self.liveResponses
        responses["list_channels"] = .object(["channels": .array([])])
        responses["fetch_notification_history"] = .object([
            "dms": .array([]),
            "shares": .array([]),
            "files": .array([]),
        ])
        responses["list_dm_requests"] = .object([
            "requests": .array([
                .object([
                    "pairKey": .string("pair-active"),
                    "title": .string("Active request"),
                ]),
                .object([
                    "pairKey": .string("pair-declined"),
                    "title": .string("Declined request"),
                ]),
                .object([
                    "pairKey": .string("pair-blocked"),
                    "title": .string("Blocked request"),
                ]),
                .object([
                    "pairKey": .string("pair-resolved"),
                    "title": .string("Resolved request"),
                ]),
            ]),
        ])
        let capabilities: Set<String> = [
            "config.get",
            "auth.state",
            "workspaces.list",
            "sync.status",
            "projects.list",
            "sessions.list",
            "shutdown",
            "list_channels",
            "list_dm_requests",
            "fetch_notification_history",
        ]
        let store = HQAppStore(
            engine: HQRecordingAppEngine(
                responses: responses,
                advertisedCapabilities: capabilities
            ),
            launchMode: .live
        )
        await store.start()
        await store.loadLiveRoute(.global(.inbox))

        XCTAssertEqual(
            Set(rowTitles(in: store.windowState(for: .messages))),
            [
                "Active request",
                "Declined request",
                "Blocked request",
                "Resolved request",
            ]
        )

        for (index, state) in HQDMRequestState.allCases.enumerated() {
            let pairKey = "pair-\(state.rawValue)"
            store.receiveEngineEvent(
                HQEngineEvent(
                    requestID: nil,
                    name: HQDMRequestUpdateRecord.eventName,
                    sequence: UInt64(index + 1),
                    data: .object([
                        "pairKey": .string(pairKey),
                        "state": .string(state.rawValue),
                    ])
                )
            )

            XCTAssertFalse(
                rowTitles(in: store.windowState(for: .messages))
                    .contains { $0.lowercased().contains(state.rawValue) }
            )
            XCTAssertFalse(
                routeRowTitles(
                    in: store.liveRouteState(for: .global(.inbox))
                ).contains { $0.lowercased().contains(state.rawValue) }
            )
        }

        XCTAssertEqual(
            store.dmRequestUpdateHistory.map(\.state),
            [.active, .declined, .blocked, .resolved]
        )
        XCTAssertTrue(
            rowTitles(in: store.windowState(for: .messages)).isEmpty
        )

        store.receiveEngineEvent(
            HQEngineEvent(
                requestID: nil,
                name: HQDMRequestUpdateRecord.eventName,
                sequence: 5,
                data: .object([
                    "pairKey": .string("pair-invalid"),
                    "state": .string("pending"),
                ])
            )
        )
        XCTAssertEqual(store.dmRequestUpdateHistory.count, 4)
        XCTAssertEqual(
            store.operationState,
            .failure("HQ emitted an invalid dm:request-update payload.")
        )
    }

    func testCloudRealtimeSubscriberReducesEveryExactProducerPayload() async {
        var responses = Self.liveResponses
        responses["list_channels"] = .object(["channels": .array([])])
        responses["list_dm_requests"] = .object(["requests": .array([])])
        responses["fetch_notification_history"] = .object([
            "dms": .array([]),
            "shares": .array([]),
            "files": .array([]),
        ])
        let capabilities: Set<String> = [
            "config.get",
            "auth.state",
            "workspaces.list",
            "sync.status",
            "projects.list",
            "sessions.list",
            "shutdown",
            "list_channels",
            "list_dm_requests",
            "fetch_notification_history",
        ]
        let store = HQAppStore(
            engine: HQRecordingAppEngine(
                responses: responses,
                advertisedCapabilities: capabilities
            ),
            launchMode: .live
        )
        await store.start()
        XCTAssertTrue(store.isAuthenticated)

        store.receiveEngineEvent(
            HQEngineEvent(
                requestID: nil,
                name: "dm:unread-summary",
                sequence: 1,
                data: .object([
                    "unreadDms": .number(2),
                    "pendingRequests": .number(0),
                ])
            )
        )
        store.receiveEngineEvent(
            HQEngineEvent(
                requestID: nil,
                name: "dm:new-events",
                sequence: 2,
                data: .array([
                    .object([
                        "eventId": .string("dm-1"),
                        "fromPersonUid": .string("person-1"),
                        "fromEmail": .string("ada@example.test"),
                        "fromDisplayName": .string("Ada"),
                        "body": .string("The native build is ready."),
                        "details": .string("Open the visual tour."),
                        "prompt": .null,
                        "createdAt": .string("2026-07-26T22:00:00Z"),
                    ]),
                ])
            )
        )
        store.receiveEngineEvent(
            HQEngineEvent(
                requestID: nil,
                name: "dm:request-new",
                sequence: 3,
                data: .object([
                    "pairKey": .string("pair-1"),
                    "fromPersonUid": .string("person-2"),
                    "fromEmail": .string("grace@example.test"),
                    "fromDisplayName": .string("Grace"),
                    "message": .string("Let us connect."),
                    "sharedCompany": .string("Indigo"),
                    "createdAt": .string("2026-07-26T22:01:00Z"),
                ])
            )
        )
        store.receiveEngineEvent(
            HQEngineEvent(
                requestID: nil,
                name: "channel:updated",
                sequence: 4,
                data: .object([
                    "channelId": .string("channel-1"),
                    "name": .string("native-macos"),
                    "scope": .string("company"),
                    "unread": .number(0),
                ])
            )
        )
        store.receiveEngineEvent(
            HQEngineEvent(
                requestID: nil,
                name: "channel:new-message",
                sequence: 5,
                data: .object([
                    "channelId": .string("channel-1"),
                    "unread": .number(3),
                ])
            )
        )
        store.receiveEngineEvent(
            HQEngineEvent(
                requestID: nil,
                name: "thread:new-reply",
                sequence: 6,
                data: .object([
                    "rootEventId": .string("root-1"),
                    "reply": .object([
                        "eventId": .string("reply-1"),
                        "fromPersonUid": .string("person-3"),
                        "fromDisplayName": .string("Lin"),
                        "body": .string("Looks good."),
                        "createdAt": .string("2026-07-26T22:02:00Z"),
                    ]),
                    "replyCount": .number(4),
                ])
            )
        )
        store.receiveEngineEvent(
            HQEngineEvent(
                requestID: nil,
                name: "message:reaction",
                sequence: 7,
                data: .object([
                    "messageScope": .string("channel"),
                    "messageId": .string("message-1"),
                    "reactions": .array([
                        .object([
                            "emoji": .string("💎"),
                            "count": .number(2),
                            "reactedByMe": .bool(true),
                        ]),
                    ]),
                ])
            )
        )
        store.receiveEngineEvent(
            HQEngineEvent(
                requestID: nil,
                name: "share:events-list",
                sequence: 8,
                data: .array([
                    .object([
                        "eventId": .string("share-1"),
                        "issuerEmail": .string("ida@example.test"),
                        "issuerDisplayName": .string("Ida"),
                        "issuerPersonUid": .string("person-4"),
                        "paths": .array([
                            .string("knowledge/native.md"),
                        ]),
                        "permission": .string("read"),
                        "note": .string("Native architecture notes."),
                        "createdAt": .string("2026-07-26T22:03:00Z"),
                    ]),
                ])
            )
        )
        store.receiveEngineEvent(
            HQEngineEvent(
                requestID: nil,
                name: "auth:reauth-required",
                sequence: 9,
                data: .null
            )
        )

        XCTAssertTrue(store.cloudRealtimeEventHistory.isEmpty)
        XCTAssertEqual(store.unreadDMMessages, 0)
        XCTAssertEqual(store.pendingDMRequests, 0)
        XCTAssertEqual(store.messageBadgeCount, 0)
        XCTAssertTrue(store.content.messages.isEmpty)
        XCTAssertTrue(store.content.snapshot.workspaces.isEmpty)
        XCTAssertTrue(store.channelUnreadByID.isEmpty)
        XCTAssertTrue(store.threadReplies.isEmpty)
        XCTAssertTrue(store.threadReplyCounts.isEmpty)
        XCTAssertTrue(store.messageReactionState.isEmpty)
        XCTAssertTrue(store.sessions.isEmpty)
        XCTAssertNil(store.hqFolderPath)
        XCTAssertNil(store.selectedMessagesConversation)
        XCTAssertNil(store.activeBannerPayload)
        XCTAssertNil(store.nativeParityEvents.conversationTarget)
        XCTAssertNil(store.nativeParityEvents.dmDetailMessage)
        XCTAssertNil(store.nativeParityEvents.selectedShare)
        XCTAssertEqual(
            store.nativeNotificationHistory.map(\.categoryIdentifier),
            ["hq.authentication"]
        )
        XCTAssertFalse(store.isAuthenticated)
        XCTAssertTrue(store.requiresReauthentication)
        XCTAssertEqual(
            store.authState,
            .object([
                "authenticated": .bool(false),
                "reauthRequired": .bool(true),
            ])
        )
        XCTAssertEqual(
            store.sceneRequest?.sceneID,
            HQSecondaryWindowKind.signIn.rawValue
        )
        XCTAssertEqual(
            store.operationState,
            .failure("Your HQ session expired. Sign in again to continue.")
        )
    }

    func testCloudRealtimeSubscribersRejectEveryMalformedExactPayload() {
        let store = HQAppStore(
            engine: HQRecordingAppEngine(responses: [:]),
            launchMode: .live,
            allowsUnresolvedAuthenticationForTesting: true
        )
        let invalidPayloads: [
            (name: HQCloudRealtimeEventName, data: HQJSONValue)
        ] = [
            (.directMessages, .array([])),
            (
                .unreadSummary,
                .object([
                    "unreadDms": .number(-1),
                    "pendingRequests": .number(0),
                ])
            ),
            (
                .requestNew,
                .object([
                    "pairKey": .string("pair-1"),
                ])
            ),
            (
                .channelNewMessage,
                .object([
                    "channelId": .string("channel-1"),
                    "unread": .number(1.5),
                ])
            ),
            (
                .channelUpdated,
                .object([
                    "channelId": .string("channel-1"),
                    "name": .string("native-macos"),
                ])
            ),
            (
                .threadNewReply,
                .object([
                    "rootEventId": .string("root-1"),
                    "replyCount": .number(1),
                ])
            ),
            (
                .messageReaction,
                .object([
                    "messageScope": .string("channel"),
                    "messageId": .string("message-1"),
                    "reactions": .array([
                        .object([
                            "emoji": .string("💎"),
                            "count": .number(-1),
                            "reactedByMe": .bool(false),
                        ]),
                    ]),
                ])
            ),
            (
                .shareEvents,
                .array([
                    .object([
                        "eventId": .string("share-1"),
                        "paths": .array([]),
                    ]),
                ])
            ),
            (.reauthenticationRequired, .object([:])),
        ]

        for (index, payload) in invalidPayloads.enumerated() {
            store.receiveEngineEvent(
                HQEngineEvent(
                    requestID: nil,
                    name: payload.name.rawValue,
                    sequence: UInt64(index + 1),
                    data: payload.data
                )
            )
            XCTAssertEqual(
                store.operationState,
                .failure(
                    "HQ emitted an invalid \(payload.name.rawValue) payload."
                )
            )
        }

        XCTAssertTrue(store.cloudRealtimeEventHistory.isEmpty)
        XCTAssertTrue(store.nativeNotificationHistory.isEmpty)
        XCTAssertFalse(store.requiresReauthentication)
    }

    func testMessagesSceneVisibilityMarksUnreadMessagesWithExactNativeCommand() async {
        var responses = Self.liveResponses
        responses["get_unread_summary"] = .object([
            "unreadDms": .number(4),
            "pendingRequests": .number(2),
        ])
        responses["mark_messages_read"] = .null
        let capabilities: Set<String> = [
            "config.get",
            "auth.state",
            "workspaces.list",
            "sync.status",
            "projects.list",
            "sessions.list",
            "shutdown",
            "get_unread_summary",
            "mark_messages_read",
        ]
        let engine = HQRecordingAppEngine(
            responses: responses,
            advertisedCapabilities: capabilities
        )
        let store = HQAppStore(engine: engine, launchMode: .live)
        await store.start()

        XCTAssertEqual(store.unreadDMMessages, 4)
        XCTAssertEqual(store.pendingDMRequests, 2)
        XCTAssertEqual(store.messageBadgeCount, 6)

        await store.perform(
            .sceneReady(HQSecondaryWindowKind.messages.rawValue)
        )

        let markReadParams = await engine.requestedParams(
            for: "mark_messages_read"
        )
        XCTAssertEqual(markReadParams, [.object([:])])
        XCTAssertEqual(store.unreadDMMessages, 0)
        XCTAssertEqual(store.pendingDMRequests, 2)
        XCTAssertEqual(store.messageBadgeCount, 2)
        XCTAssertEqual(
            store.operationState,
            .success("Messages marked as read.")
        )
    }

    func testActivitySubscribersAppendAndReplaceExactProducerEntries() {
        let store = HQAppStore(
            engine: HQRecordingAppEngine(responses: [:]),
            launchMode: .live,
            allowsUnresolvedAuthenticationForTesting: true
        )

        store.receiveEngineEvent(
            HQEngineEvent(
                requestID: nil,
                name: "activity:append",
                sequence: 1,
                data: .object([
                    "company": .string("indigo"),
                    "path": .string("knowledge/native.md"),
                    "bytes": .number(42),
                    "direction": .string("down"),
                    "author": .null,
                    "isNew": .null,
                    "at": .number(1_722_000_000_000),
                ])
            )
        )

        XCTAssertEqual(store.syncActivityEntries.count, 1)
        XCTAssertEqual(store.syncActivityEntries[0].company, "indigo")
        XCTAssertEqual(store.syncActivityEntries[0].bytes, 42)
        XCTAssertNil(store.syncActivityEntries[0].isNew)
        XCTAssertEqual(store.content.activity.map(\.action), ["updated"])

        store.receiveEngineEvent(
            HQEngineEvent(
                requestID: nil,
                name: "activity:list",
                sequence: 2,
                data: .array([
                    .object([
                        "company": .string("indigo"),
                        "path": .string("knowledge/native.md"),
                        "bytes": .number(42),
                        "direction": .string("down"),
                        "author": .string("ada@example.test"),
                        "isNew": .bool(true),
                        "at": .number(1_722_000_000_000),
                    ]),
                    .object([
                        "company": .string("indigo"),
                        "path": .string("projects/native/prd.json"),
                        "bytes": .number(512),
                        "direction": .string("up"),
                        "at": .number(1_722_000_001_000),
                    ]),
                ])
            )
        )

        XCTAssertEqual(
            store.syncActivityEntries.map(\.path),
            [
                "knowledge/native.md",
                "projects/native/prd.json",
            ]
        )
        XCTAssertEqual(
            store.content.activity.map(\.action),
            ["added", "uploaded"]
        )
        XCTAssertEqual(
            store.content.activity.map(\.actor),
            ["ada@example.test", "Indigo"]
        )
        XCTAssertEqual(
            store.activityEventHistory.map(\.name),
            [.append, .list]
        )

        store.receiveEngineEvent(
            HQEngineEvent(
                requestID: nil,
                name: "activity:append",
                sequence: 3,
                data: .object([
                    "company": .string("indigo"),
                    "path": .string("invalid.md"),
                    "bytes": .number(1),
                    "direction": .string("sideways"),
                    "at": .number(1_722_000_002_000),
                ])
            )
        )
        XCTAssertEqual(store.activityEventHistory.count, 2)
        XCTAssertEqual(
            store.operationState,
            .failure("HQ emitted an invalid activity:append payload.")
        )
    }

    func testShutdownAwaitsGracefulProtocolRequestAndStopsEngineOnce() async {
        let engine = HQRecordingAppEngine(responses: Self.liveResponses)
        let store = HQAppStore(engine: engine, launchMode: .live)
        await store.start()

        await store.shutdown()
        await store.shutdown()

        XCTAssertTrue(store.didShutdown)
        let stopCallCount = await engine.stopCallCount()
        let requestedMethods = await engine.requestedMethods()
        XCTAssertEqual(stopCallCount, 1)
        XCTAssertEqual(
            requestedMethods.filter { $0 == "shutdown" },
            ["shutdown"]
        )
    }

    func testShutdownBoundsNonresponsiveProtocolRequestAndStillStopsEngine() async {
        let engine = HQRecordingAppEngine(
            responses: Self.liveResponses,
            nonresponsiveMethods: ["shutdown"]
        )
        let store = HQAppStore(
            engine: engine,
            launchMode: .live,
            shutdownRequestTimeoutNanoseconds: 20_000_000
        )
        await store.start()

        let started = ContinuousClock.now
        await store.shutdown()
        let elapsed = started.duration(to: ContinuousClock.now)

        XCTAssertLessThan(elapsed, .milliseconds(500))
        XCTAssertTrue(store.didShutdown)
        let stopCallCount = await engine.stopCallCount()
        let shutdownTimeouts = await engine.requestTimeouts(for: "shutdown")
        XCTAssertEqual(stopCallCount, 1)
        XCTAssertEqual(shutdownTimeouts, [20_000_000])
    }

    func testUnexpectedEngineFailureRefreshesWithFreshEngineAndReturnsReady() async {
        let failedEngine = HQRecordingAppEngine(
            responses: Self.liveResponses
        )
        let replacementEngine = HQRecordingAppEngine(
            responses: Self.liveResponses
        )
        var factoryCalls = 0
        let store = HQAppStore(
            engine: failedEngine,
            engineFactory: {
                factoryCalls += 1
                return replacementEngine
            },
            launchMode: .live
        )
        await store.start()
        XCTAssertEqual(store.phase, .ready)

        await failedEngine.failLifecycle("sidecar exited with status 9")
        for _ in 0..<100 {
            if case .failed = store.phase {
                break
            }
            await Task.yield()
        }

        guard case let .failed(message) = store.phase else {
            return XCTFail("Expected sidecar death to visibly fail the app")
        }
        XCTAssertTrue(message.contains("sidecar exited with status 9"))

        await store.perform(.refresh)

        XCTAssertEqual(factoryCalls, 1)
        XCTAssertEqual(store.phase, .ready)
        let replacementStarts = await replacementEngine.startCallCount()
        XCTAssertEqual(replacementStarts, 1)
    }

    func testChooseHQFolderValidatesMergesSettingsAndRehydratesLiveState()
        async
    {
        var responses = Self.liveResponses
        responses["detect_hq"] = .object([
            "exists": .bool(true),
            "isHq": .bool(true),
            "nonEmpty": .bool(true),
        ])
        responses["check_writable"] = .bool(true)
        responses["get_settings"] = .object([
            "hqPath": .string("/tmp/OldHQ"),
            "dmNotifications": .bool(false),
            "releaseChannel": .string("beta"),
        ])
        responses["save_settings"] = .null
        let capabilities = Set(
            [
                "config.get",
                "auth.state",
                "workspaces.list",
                "sync.status",
                "projects.list",
                "sessions.list",
                "detect_hq",
                "check_writable",
                "get_settings",
                "save_settings",
            ]
        )
        let engine = HQRecordingAppEngine(
            responses: responses,
            advertisedCapabilities: capabilities
        )
        let store = HQAppStore(
            engine: engine,
            pickFiles: { _ in
                [URL(fileURLWithPath: "/tmp/HQ", isDirectory: true)]
            }
        )

        await store.start()
        await store.perform(.nativeCommand(.pickFolder))

        XCTAssertEqual(store.hqFolderPath, "/tmp/HQ")
        XCTAssertEqual(store.lastNativeResult, .string("/tmp/HQ"))
        let saveParams = await engine.requestedParams(for: "save_settings")
        XCTAssertEqual(
            saveParams.last,
            .object([
                "prefs": .object([
                    "hqPath": .string("/tmp/HQ"),
                    "dmNotifications": .bool(false),
                    "releaseChannel": .string("beta"),
                ]),
            ])
        )
        let methods = await engine.requestedMethods()
        for method in [
            "config.get",
            "auth.state",
            "workspaces.list",
            "sync.status",
            "projects.list",
            "sessions.list",
        ] {
            XCTAssertEqual(
                methods.filter { $0 == method }.count,
                2,
                "\(method) was not rehydrated after the folder save."
            )
        }
    }

    func testChooseHQFolderCancellationIsNeutralAndDoesNotCallEngine()
        async
    {
        let engine = HQRecordingAppEngine(responses: [:])
        let store = HQAppStore(
            engine: engine,
            pickFiles: { _ in [] }
        )

        await store.perform(.nativeCommand(.pickFolder))

        XCTAssertEqual(store.lastNativeResult, .null)
        XCTAssertEqual(
            store.operationState,
            .success("Folder selection cancelled.")
        )
        let requestedMethods = await engine.requestedMethods()
        XCTAssertTrue(requestedMethods.isEmpty)
    }

    func testOverlappingFolderChoicesOnlyNewestCompletionCanCommit()
        async
    {
        let olderDetectionGate = HQTestRequestGate()
        var responses = Self.liveResponses
        responses.merge([
            "detect_hq": .object([
                "exists": .bool(true),
                "isHq": .bool(true),
                "nonEmpty": .bool(true),
            ]),
            "check_writable": .bool(true),
            "get_settings": .object([
                "hqPath": .string("/tmp/HQ"),
                "releaseChannel": .string("stable"),
            ]),
            "save_settings": .null,
        ]) { _, replacement in replacement }
        var selectedPaths = ["/tmp/OlderHQ", "/tmp/NewerHQ"]
        let engine = HQRecordingAppEngine(
            responses: responses,
            advertisedCapabilities:
                Set(Self.liveResponses.keys).union([
                    "detect_hq",
                    "check_writable",
                    "get_settings",
                    "save_settings",
                ]),
            requestStubs: [
                HQTestEngineRequestStub(
                    method: "detect_hq",
                    params: .object([
                        "path": .string("/tmp/OlderHQ"),
                    ]),
                    response: responses["detect_hq"]!,
                    gate: olderDetectionGate
                ),
                HQTestEngineRequestStub(
                    method: "workspaces.list",
                    occurrence: 2,
                    response: .object([
                        "source": .string("local"),
                        "hqFolderPath": .string("/tmp/NewerHQ"),
                        "workspaces": .array([]),
                    ])
                ),
            ]
        )
        let store = HQAppStore(
            engine: engine,
            launchMode: .live,
            updaterService: HQNativeUpdaterService(
                driver: HQAppStoreUpdaterDriverSpy()
            ),
            pickFiles: { _ in
                let path = selectedPaths.removeFirst()
                return [URL(fileURLWithPath: path, isDirectory: true)]
            }
        )
        await store.start()

        let olderChoice = Task {
            await store.perform(.nativeCommand(.pickFolder))
        }
        await waitForGate(olderDetectionGate)
        let newerChoice = Task {
            await store.perform(.nativeCommand(.pickFolder))
        }
        await newerChoice.value
        XCTAssertEqual(store.hqFolderPath, "/tmp/NewerHQ")

        await olderDetectionGate.releaseNext()
        await olderChoice.value

        XCTAssertEqual(store.hqFolderPath, "/tmp/NewerHQ")
        XCTAssertEqual(store.lastNativeResult, .string("/tmp/NewerHQ"))
        let savedFolderPreferences = await engine.requestedParams(
            for: "save_settings"
        )
        XCTAssertEqual(
            savedFolderPreferences,
            [
                .object([
                    "prefs": .object([
                        "hqPath": .string("/tmp/NewerHQ"),
                        "releaseChannel": .string("stable"),
                    ]),
                ]),
            ]
        )
    }

    func testFolderChoiceStartedBeforeAuthClearCannotSaveOrRehydrate()
        async
    {
        let validationGate = HQTestRequestGate()
        var responses = Self.liveResponses
        responses.merge([
            "detect_hq": .object([
                "exists": .bool(true),
                "isHq": .bool(true),
                "nonEmpty": .bool(true),
            ]),
            "check_writable": .bool(true),
            "get_settings": .object([
                "hqPath": .string("/tmp/HQ"),
            ]),
            "save_settings": .null,
        ]) { _, replacement in replacement }
        let engine = HQRecordingAppEngine(
            responses: responses,
            advertisedCapabilities:
                Set(Self.liveResponses.keys).union([
                    "detect_hq",
                    "check_writable",
                    "get_settings",
                    "save_settings",
                ]),
            requestStubs: [
                HQTestEngineRequestStub(
                    method: "detect_hq",
                    params: .object([
                        "path": .string("/tmp/PreSignOutHQ"),
                    ]),
                    response: responses["detect_hq"]!,
                    gate: validationGate
                ),
            ]
        )
        let store = HQAppStore(
            engine: engine,
            launchMode: .live,
            updaterService: HQNativeUpdaterService(
                driver: HQAppStoreUpdaterDriverSpy()
            ),
            pickFiles: { _ in
                [
                    URL(
                        fileURLWithPath: "/tmp/PreSignOutHQ",
                        isDirectory: true
                    ),
                ]
            }
        )
        await store.start()

        let choice = Task {
            await store.perform(.nativeCommand(.pickFolder))
        }
        await waitForGate(validationGate)
        store.receiveEngineEvent(Self.reauthenticationEvent(sequence: 50))
        await validationGate.releaseNext()
        await choice.value

        XCTAssertFalse(store.isAuthenticated)
        let saveRequests = await engine.requestedParams(
            for: "save_settings"
        )
        let settingsRequests = await engine.requestedParams(
            for: "get_settings"
        )
        XCTAssertTrue(saveRequests.isEmpty)
        XCTAssertTrue(settingsRequests.isEmpty)
        XCTAssertTrue(store.content.snapshot.workspaces.isEmpty)
        XCTAssertTrue(store.content.snapshot.projects.isEmpty)
        XCTAssertTrue(store.sessions.isEmpty)
        XCTAssertNil(store.hqFolderPath)
        XCTAssertNil(store.lastNativeResult)
    }

    func testFolderSaveFailureLeavesPreviousLiveStateIntact()
        async
    {
        var responses = Self.liveResponses
        responses.merge([
            "detect_hq": .object([
                "exists": .bool(true),
                "isHq": .bool(true),
                "nonEmpty": .bool(true),
            ]),
            "check_writable": .bool(true),
            "get_settings": .object([
                "hqPath": .string("/tmp/HQ"),
                "releaseChannel": .string("stable"),
            ]),
        ]) { _, replacement in replacement }
        let engine = HQRecordingAppEngine(
            responses: responses,
            advertisedCapabilities:
                Set(Self.liveResponses.keys).union([
                    "detect_hq",
                    "check_writable",
                    "get_settings",
                    "save_settings",
                ]),
            requestStubs: [
                HQTestEngineRequestStub(
                    method: "save_settings",
                    occurrence: 1,
                    errorMessage: "Settings could not be saved."
                ),
            ]
        )
        let store = HQAppStore(
            engine: engine,
            launchMode: .live,
            updaterService: HQNativeUpdaterService(
                driver: HQAppStoreUpdaterDriverSpy()
            ),
            pickFiles: { _ in
                [
                    URL(
                        fileURLWithPath: "/tmp/UnsavedHQ",
                        isDirectory: true
                    ),
                ]
            }
        )
        await store.start()
        let originalWorkspaces = store.content.snapshot.workspaces
        let originalProjects = store.content.snapshot.projects
        let originalSessions = store.sessions

        await store.perform(.nativeCommand(.pickFolder))

        XCTAssertEqual(store.hqFolderPath, "/tmp/HQ")
        XCTAssertEqual(
            store.content.snapshot.workspaces,
            originalWorkspaces
        )
        XCTAssertEqual(store.content.snapshot.projects, originalProjects)
        XCTAssertEqual(store.sessions, originalSessions)
        XCTAssertNotEqual(store.lastNativeResult, .string("/tmp/UnsavedHQ"))
        guard case let .failure(message) = store.operationState else {
            return XCTFail("Expected the save failure to be visible.")
        }
        XCTAssertTrue(message.contains("Settings could not be saved"))
    }

    func testFolderHydrationFailureRollsBackPersistedSettingsAndLiveState()
        async
    {
        var responses = Self.liveResponses
        let originalSettings: HQJSONValue = .object([
            "hqPath": .string("/tmp/HQ"),
            "dmNotifications": .bool(false),
            "releaseChannel": .string("beta"),
        ])
        responses.merge([
            "detect_hq": .object([
                "exists": .bool(true),
                "isHq": .bool(true),
                "nonEmpty": .bool(true),
            ]),
            "check_writable": .bool(true),
            "get_settings": originalSettings,
            "save_settings": .null,
        ]) { _, replacement in replacement }
        let engine = HQRecordingAppEngine(
            responses: responses,
            advertisedCapabilities:
                Set(Self.liveResponses.keys).union([
                    "detect_hq",
                    "check_writable",
                    "get_settings",
                    "save_settings",
                ]),
            requestStubs: [
                HQTestEngineRequestStub(
                    method: "config.get",
                    occurrence: 2,
                    errorMessage: "The replacement HQ could not hydrate."
                ),
                HQTestEngineRequestStub(
                    method: "get_settings",
                    occurrence: 2,
                    response: .object([
                        "hqPath": .string("/tmp/HydrationFailureHQ"),
                        "dmNotifications": .bool(false),
                        "releaseChannel": .string("beta"),
                    ])
                ),
            ]
        )
        let store = HQAppStore(
            engine: engine,
            launchMode: .live,
            updaterService: HQNativeUpdaterService(
                driver: HQAppStoreUpdaterDriverSpy()
            ),
            pickFiles: { _ in
                [
                    URL(
                        fileURLWithPath: "/tmp/HydrationFailureHQ",
                        isDirectory: true
                    ),
                ]
            }
        )
        await store.start()
        let originalWorkspaces = store.content.snapshot.workspaces
        let originalProjects = store.content.snapshot.projects
        let originalSessions = store.sessions

        await store.perform(.nativeCommand(.pickFolder))

        let saveRequests = await engine.requestedParams(
            for: "save_settings"
        )
        XCTAssertEqual(
            saveRequests,
            [
                .object([
                    "prefs": .object([
                        "hqPath": .string("/tmp/HydrationFailureHQ"),
                        "dmNotifications": .bool(false),
                        "releaseChannel": .string("beta"),
                    ]),
                ]),
                .object(["prefs": originalSettings]),
            ],
            "A failed full hydration must restore the exact previous preference object."
        )
        XCTAssertEqual(store.hqFolderPath, "/tmp/HQ")
        XCTAssertEqual(
            store.content.snapshot.workspaces,
            originalWorkspaces
        )
        XCTAssertEqual(store.content.snapshot.projects, originalProjects)
        XCTAssertEqual(store.sessions, originalSessions)
        XCTAssertNotEqual(
            store.lastNativeResult,
            .string("/tmp/HydrationFailureHQ")
        )
        guard case let .failure(message) = store.operationState else {
            return XCTFail("Expected the hydration failure to be visible.")
        }
        XCTAssertTrue(message.contains("could not hydrate"))
    }

    func testWidgetAndMeetingPermissionControlsUsePublishedTypedState()
        async
    {
        var persistedModes: [HQWidgetMode] = []
        var openedDestinations: [HQSystemSettingsDestination] = []
        let store = HQAppStore(
            engine: HQRecordingAppEngine(responses: [:]),
            launchMode: .visualTourFixture,
            privacyAuthorization: { capability in
                switch capability {
                case .screenRecording:
                    return .denied
                case .microphone:
                    return .authorized
                case .camera:
                    return .unknown
                }
            },
            accessibilityIsTrusted: { true },
            openSystemSettings: {
                openedDestinations.append($0)
            },
            initialWidgetMode: .expanded,
            persistWidgetMode: {
                persistedModes.append($0)
            }
        )

        await store.start()
        XCTAssertEqual(
            HQSecondaryWindowActionRegistry.resolution(
                for: .widget,
                actionID: "customize"
            ),
            .navigate(.settings(.widget))
        )
        await store.perform(
            .nativeCommand(
                .applyWidgetSettings,
                payload: .object(["mode": .string("compact")])
            )
        )
        XCTAssertEqual(store.widgetMode, .compact)
        XCTAssertEqual(persistedModes, [.compact])

        await store.perform(
            .sceneReady(HQSecondaryWindowKind.meetingPermissions.rawValue)
        )
        XCTAssertEqual(
            store.meetingPermissionSnapshot,
            HQMeetingPermissionSnapshot(
                accessibility: .authorized,
                screenRecording: .denied,
                microphone: .authorized
            )
        )
        guard case let .content(permissionFixture) = store.windowState(
            for: .meetingPermissions
        ) else {
            return XCTFail("Meeting permissions did not render content.")
        }
        XCTAssertEqual(
            permissionFixture.rows.map(\.value),
            ["Allowed", "Denied", "Allowed"]
        )

        await store.perform(
            .secondaryWindow(
                kind: .meetingPermissions,
                actionID: "open-settings.accessibility"
            )
        )
        await store.perform(
            .nativeCommand(
                .permissionsOpenSettings,
                payload: .string("notifications")
            )
        )
        XCTAssertEqual(
            openedDestinations,
            [.accessibility, .notifications]
        )
    }

    func testRetainedBannerPayloadKeepsVisibleCopyAndPrimaryActionAligned()
        async
    {
        let store = HQAppStore(
            engine: HQRecordingAppEngine(responses: [:]),
            launchMode: .visualTourFixture
        )

        await store.start()
        await store.perform(.nativeCommand(.previewShareBanner))
        XCTAssertEqual(
            store.bannerWindowFixture()?.message,
            HQBannerFixture.preview(for: .syncComplete).message
        )
        await store.perform(
            .secondaryWindow(
                kind: .banner,
                actionID: "banner.sync-complete.open"
            )
        )
        XCTAssertEqual(
            store.sceneRequest?.sceneID,
            HQSecondaryWindowKind.activity.rawValue
        )

        await store.perform(.nativeCommand(.previewMeetingBanner))
        XCTAssertEqual(
            store.bannerWindowFixture()?.actionTitle,
            "Open Meeting"
        )
        await store.perform(
            .secondaryWindow(
                kind: .banner,
                actionID: "banner.meeting-ready.open"
            )
        )
        XCTAssertEqual(
            store.sceneRequest?.sceneID,
            HQSecondaryWindowKind.meetings.rawValue
        )

        await store.perform(.nativeCommand(.previewDMBanner))
        XCTAssertEqual(
            store.bannerWindowFixture()?.title,
            "New message from Caitlin"
        )
        await store.perform(
            .secondaryWindow(
                kind: .banner,
                actionID: "banner.direct-message.open"
            )
        )
        XCTAssertEqual(
            store.sceneRequest?.sceneID,
            HQSecondaryWindowKind.directMessageDetail.rawValue
        )
        XCTAssertEqual(
            store.nativeParityEvents.dmDetailMessage?.eventID,
            "fixture-dm"
        )
        guard case let .content(detailFixture) = store.windowState(
            for: .directMessageDetail
        ) else {
            return XCTFail("Retained DM did not open exact detail content.")
        }
        XCTAssertEqual(
            detailFixture.rows.first?.detail,
            HQBannerFixture.preview(for: .directMessage).message
        )

        await store.perform(.nativeCommand(.previewUpdateBanner))
        await store.perform(
            .secondaryWindow(
                kind: .banner,
                actionID: "banner.update-available.open"
            )
        )
        XCTAssertEqual(store.selectedRoute, .settings(.updates))

        await store.perform(.nativeCommand(.previewDMBanner))
        await store.perform(.nativeCommand(.dismissBanner))
        XCTAssertNil(store.activeBannerPayload)
        XCTAssertNil(store.bannerWindowFixture())
    }

    func testVisualTourPrimesBannerWithoutOpeningItOverOtherSurfaces()
        async
    {
        let store = HQAppStore(
            engine: HQRecordingAppEngine(responses: [:]),
            launchMode: .visualTourFixture
        )

        await store.start()

        XCTAssertNotNil(
            store.bannerWindowFixture(),
            "The dedicated banner capture still needs deterministic content."
        )
        XCTAssertNil(
            store.sceneRequest,
            "Visual-tour bootstrap must not cover unrelated routes with a banner."
        )

        await store.startAndApplyLaunchArguments([
            "HQ",
            "--visual-tour",
            "--visual-variant",
            "light",
            "--hq-scene",
            HQSecondaryWindowKind.banner.rawValue,
        ])
        XCTAssertEqual(
            store.sceneRequest?.sceneID,
            HQSecondaryWindowKind.banner.rawValue,
            "The dedicated banner surface must still open on explicit request."
        )
    }

    func testClickedBannerUsesExactSnapshotWithoutDismissingReplacement()
        async throws
    {
        let store = HQAppStore(
            engine: HQRecordingAppEngine(responses: Self.liveResponses),
            launchMode: .live,
            updaterService: HQNativeUpdaterService(
                driver: HQAppStoreUpdaterDriverSpy()
            )
        )
        await store.start()
        store.receiveEngineEvent(
            Self.directMessageEvent(
                sequence: 1,
                id: "dm-a",
                personUID: "person-a",
                name: "Ada",
                body: "Banner A"
            )
        )
        let clickedA = try XCTUnwrap(store.activeBannerPayload)

        await store.perform(.nativeCommand(.previewUpdateBanner))
        let replacementB = try XCTUnwrap(store.activeBannerPayload)
        XCTAssertNotEqual(clickedA, replacementB)

        await store.perform(.activateBanner(clickedA))

        XCTAssertEqual(
            store.nativeParityEvents.dmDetailMessage?.eventID,
            "dm-a"
        )
        XCTAssertEqual(
            store.sceneRequest?.sceneID,
            HQSecondaryWindowKind.directMessageDetail.rawValue
        )
        XCTAssertEqual(store.activeBannerPayload, replacementB)
        XCTAssertTrue(store.isBannerPresented)
        XCTAssertEqual(
            store.bannerWindowFixture()?.title,
            "HQ 12.4.0 is available"
        )
    }

    func testReplacementDMBannerReplacesRenderedCopyAndReplyRecipient()
        async throws
    {
        var responses = Self.liveResponses
        responses["send_dm"] = .null
        let engine = HQRecordingAppEngine(
            responses: responses,
            advertisedCapabilities:
                Set(Self.liveResponses.keys).union(["send_dm"])
        )
        let store = HQAppStore(
            engine: engine,
            launchMode: .live,
            updaterService: HQNativeUpdaterService(
                driver: HQAppStoreUpdaterDriverSpy()
            )
        )
        await store.start()

        store.receiveEngineEvent(
            Self.directMessageEvent(
                sequence: 10,
                id: "dm-a",
                personUID: "person-a",
                name: "Ada",
                body: "Stale message A"
            )
        )
        let bannerA = try XCTUnwrap(store.activeBannerPayload)
        await store.perform(.activateBanner(bannerA))
        XCTAssertEqual(
            store.nativeParityEvents.dmDetailMessage?.fromPersonUID,
            "person-a"
        )

        store.receiveEngineEvent(
            Self.directMessageEvent(
                sequence: 11,
                id: "dm-b",
                personUID: "person-b",
                name: "Bea",
                body: "Current message B"
            )
        )
        XCTAssertEqual(
            store.bannerWindowFixture()?.title,
            "New message from Bea"
        )
        XCTAssertEqual(
            store.bannerWindowFixture()?.message,
            "Current message B"
        )

        let bannerB = try XCTUnwrap(store.activeBannerPayload)
        await store.perform(.activateBanner(bannerB))
        XCTAssertEqual(
            store.nativeParityEvents.dmDetailMessage?.eventID,
            "dm-b"
        )
        await store.perform(.replyToDirectMessage("Reply only to B"))

        let replyRequests = await engine.requestedParams(for: "send_dm")
        XCTAssertEqual(
            replyRequests,
            [
                .object([
                    "toPersonUid": .string("person-b"),
                    "body": .string("Reply only to B"),
                ]),
            ]
        )
    }

    func testSignedOutBootstrapAndRefreshNeverRestoreProtectedShellData()
        async
    {
        var responses = Self.liveResponses
        responses["auth.state"] = .object([
            "source": .string("local"),
            "authenticated": .bool(false),
            "hasStoredTokens": .bool(false),
        ])
        let store = HQAppStore(
            engine: HQRecordingAppEngine(responses: responses),
            launchMode: .live,
            updaterService: HQNativeUpdaterService(
                driver: HQAppStoreUpdaterDriverSpy()
            )
        )

        await store.start()
        XCTAssertFalse(store.isAuthenticated)
        XCTAssertTrue(store.content.snapshot.workspaces.isEmpty)
        XCTAssertTrue(store.content.snapshot.projects.isEmpty)
        XCTAssertTrue(store.sessions.isEmpty)
        XCTAssertNil(store.hqFolderPath)

        await store.perform(.refresh)
        XCTAssertFalse(store.isAuthenticated)
        XCTAssertTrue(store.content.snapshot.workspaces.isEmpty)
        XCTAssertTrue(store.content.snapshot.projects.isEmpty)
        XCTAssertTrue(store.sessions.isEmpty)
        XCTAssertNil(store.hqFolderPath)
    }

    func testProtectedEventsAndNotificationResponsesAreIgnoredAfterAuthClear()
        async
    {
        let store = HQAppStore(
            engine: HQRecordingAppEngine(responses: Self.liveResponses),
            launchMode: .live,
            updaterService: HQNativeUpdaterService(
                driver: HQAppStoreUpdaterDriverSpy()
            )
        )
        await store.start()
        store.receiveEngineEvent(Self.reauthenticationEvent(sequence: 20))
        let notificationCount = store.nativeNotificationHistory.count

        let queuedMessage = Self.directMessageValue(
            id: "queued-dm",
            personUID: "queued-person",
            name: "Queued",
            body: "Must not cross the cleared boundary"
        )
        store.receiveEngineEvent(
            Self.directMessageEvent(
                sequence: 21,
                id: "queued-dm",
                personUID: "queued-person",
                name: "Queued",
                body: "Must not cross the cleared boundary"
            )
        )
        store.receiveEngineEvent(
            Self.recordingStartedEvent(
                sequence: 22,
                windowID: "queued-window",
                startedAt: "2026-07-27T07:22:00Z"
            )
        )
        store.receiveNativeNotificationResponse(
            .directMessage(
                operation: .open,
                eventID: "queued-dm",
                payload: queuedMessage
            )
        )

        XCTAssertFalse(store.isAuthenticated)
        XCTAssertTrue(store.cloudRealtimeEventHistory.isEmpty)
        XCTAssertTrue(store.content.messages.isEmpty)
        XCTAssertTrue(store.activeRecallRecordings.isEmpty)
        XCTAssertTrue(store.recallEventHistory.isEmpty)
        XCTAssertNil(store.activeBannerPayload)
        XCTAssertNil(store.nativeParityEvents.dmDetailMessage)
        XCTAssertEqual(
            store.sceneRequest?.sceneID,
            HQSecondaryWindowKind.signIn.rawValue
        )
        XCTAssertEqual(
            store.nativeNotificationHistory.count,
            notificationCount
        )
    }

    func testAuthPurgeStopsRetainedRecordingWithoutDeletingReusedWindow()
        async
    {
        let stopGate = HQTestRequestGate()
        var responses = Self.liveResponses
        responses.merge([
            "stop_recording": .null,
            "start_oauth_login": .object([
                "authorizeUrl": .string(
                    "https://auth.example.test/recording-reauth"
                ),
                "state": .string("recording-reauth-state"),
            ]),
            "oauth_listen_for_code": .object([
                "code": .string("recording-reauth-code"),
            ]),
            "oauth_exchange_code": .object([
                "authenticated": .bool(true),
            ]),
            "oauth_cancel_listen": .null,
        ]) { _, replacement in replacement }
        let capabilities = Set(Self.liveResponses.keys).union([
            "stop_recording",
            "start_oauth_login",
            "oauth_listen_for_code",
            "oauth_exchange_code",
            "oauth_cancel_listen",
        ])
        let engine = HQRecordingAppEngine(
            responses: responses,
            advertisedCapabilities: capabilities,
            requestStubs: [
                HQTestEngineRequestStub(
                    method: "stop_recording",
                    params: .object([
                        "windowId": .string("reused-window"),
                    ]),
                    response: .null,
                    gate: stopGate
                ),
            ]
        )
        let store = HQAppStore(
            engine: engine,
            launchMode: .live,
            updaterService: HQNativeUpdaterService(
                driver: HQAppStoreUpdaterDriverSpy()
            ),
            openExternalURL: { _ in }
        )
        await store.start()
        let oldStartedAt = "2026-07-27T07:30:00Z"
        store.receiveEngineEvent(
            Self.recordingStartedEvent(
                sequence: 30,
                windowID: "reused-window",
                startedAt: oldStartedAt
            )
        )

        store.receiveEngineEvent(Self.reauthenticationEvent(sequence: 31))
        await waitForGate(stopGate)
        XCTAssertEqual(
            store.activeRecallRecordings["reused-window"]?.startedAt,
            oldStartedAt,
            "The handle must remain truthful until stop_recording succeeds."
        )

        await store.perform(
            .secondaryWindow(kind: .signIn, actionID: "sign-in-google")
        )
        XCTAssertTrue(store.isAuthenticated)
        let newStartedAt = "2026-07-27T07:31:00Z"
        store.receiveEngineEvent(
            Self.recordingStartedEvent(
                sequence: 32,
                windowID: "reused-window",
                startedAt: newStartedAt
            )
        )
        await stopGate.releaseNext()
        await waitForCompletedRequest(
            "stop_recording",
            engine: engine
        )
        for _ in 0..<20 {
            await Task.yield()
        }

        let stopRequests = await engine.requestedParams(
            for: "stop_recording"
        )
        XCTAssertEqual(
            stopRequests,
            [
                .object([
                    "windowId": .string("reused-window"),
                ]),
            ]
        )
        XCTAssertEqual(
            store.activeRecallRecordings["reused-window"]?.startedAt,
            newStartedAt,
            "A stale stop completion must not erase a newer recording that reused the window ID."
        )
    }

    func testAuthPurgeReapsEngineBeforeClearingRecordingWhenStopFails()
        async
    {
        let engine = HQRecordingAppEngine(
            responses: Self.liveResponses,
            advertisedCapabilities:
                Set(Self.liveResponses.keys).union(["stop_recording"]),
            requestStubs: [
                HQTestEngineRequestStub(
                    method: "stop_recording",
                    params: .object([
                        "windowId": .string("failed-stop-window"),
                    ]),
                    errorMessage: "Recall refused to stop the recording."
                ),
            ]
        )
        let store = HQAppStore(
            engine: engine,
            launchMode: .live,
            updaterService: HQNativeUpdaterService(
                driver: HQAppStoreUpdaterDriverSpy()
            )
        )
        await store.start()
        store.receiveEngineEvent(
            Self.recordingStartedEvent(
                sequence: 40,
                windowID: "failed-stop-window",
                startedAt: "2026-07-27T07:40:00Z"
            )
        )

        store.receiveEngineEvent(Self.reauthenticationEvent(sequence: 41))
        await waitForCompletedRequest(
            "stop_recording",
            engine: engine
        )
        for _ in 0..<20 {
            await Task.yield()
        }

        let engineStopCalls = await engine.stopCallCount()
        XCTAssertEqual(engineStopCalls, 1)
        XCTAssertNil(
            store.activeRecallRecordings["failed-stop-window"],
            "The recording handle may clear only after engine.stop has reaped the capture process."
        )
        guard case let .failed(message) = store.phase else {
            return XCTFail("The stop failure must require a Refresh.")
        }
        XCTAssertTrue(message.contains("Recall refused to stop"))
        XCTAssertTrue(message.localizedCaseInsensitiveContains("refresh"))
    }

    func testOAuthIsSingleFlightAndCancelInvalidatesLateCallback()
        async
    {
        let callbackGate = HQTestRequestGate()
        var responses = Self.liveResponses
        responses.merge([
            "auth.state": .object([
                "authenticated": .bool(false),
                "hasStoredTokens": .bool(false),
            ]),
            "start_oauth_login": .object([
                "authorizeUrl": .string(
                    "https://auth.example.test/single-flight"
                ),
                "state": .string("single-flight-state"),
            ]),
            "oauth_listen_for_code": .object([
                "code": .string("late-cancelled-code"),
            ]),
            "oauth_exchange_code": .object([
                "authenticated": .bool(true),
            ]),
            "oauth_cancel_listen": .null,
        ]) { _, replacement in replacement }
        let engine = HQRecordingAppEngine(
            responses: responses,
            advertisedCapabilities:
                Set(Self.liveResponses.keys).union([
                    "start_oauth_login",
                    "oauth_listen_for_code",
                    "oauth_exchange_code",
                    "oauth_cancel_listen",
                ]),
            requestStubs: [
                HQTestEngineRequestStub(
                    method: "oauth_listen_for_code",
                    params: .object([
                        "state": .string("single-flight-state"),
                    ]),
                    response: responses["oauth_listen_for_code"]!,
                    gate: callbackGate
                ),
            ]
        )
        var openedURLs: [URL] = []
        let store = HQAppStore(
            engine: engine,
            launchMode: .live,
            updaterService: HQNativeUpdaterService(
                driver: HQAppStoreUpdaterDriverSpy()
            ),
            openExternalURL: { openedURLs.append($0) }
        )
        await store.start()

        let googleFlow = Task {
            await store.perform(
                .secondaryWindow(
                    kind: .signIn,
                    actionID: "sign-in-google"
                )
            )
        }
        await waitForGate(callbackGate)
        XCTAssertEqual(
            store.oauthFlowState,
            .waiting(provider: "Google", state: "single-flight-state")
        )

        await store.perform(
            .secondaryWindow(
                kind: .signIn,
                actionID: "sign-in-microsoft"
            )
        )
        let startParams = await engine.requestedParams(
            for: "start_oauth_login"
        )
        XCTAssertEqual(
            startParams,
            [
                .object(["provider": .string("Google")]),
            ],
            "A second provider cannot replace an active OAuth flow."
        )

        await store.perform(
            .secondaryWindow(kind: .signIn, actionID: "cancel")
        )
        let cancellationParams = await engine.requestedParams(
            for: "oauth_cancel_listen"
        )
        XCTAssertEqual(
            cancellationParams,
            [
                .object([
                    "state": .string("single-flight-state"),
                ]),
            ]
        )
        await callbackGate.releaseNext()
        await googleFlow.value

        XCTAssertEqual(store.oauthFlowState, .idle)
        XCTAssertFalse(store.isAuthenticated)
        let exchangeParams = await engine.requestedParams(
            for: "oauth_exchange_code"
        )
        XCTAssertTrue(exchangeParams.isEmpty)
        XCTAssertEqual(
            openedURLs.map(\.absoluteString),
            ["https://auth.example.test/single-flight"]
        )
    }

    func testOAuthExchangeCompletionCannotAuthenticateAfterAuthClear()
        async
    {
        let exchangeGate = HQTestRequestGate()
        var responses = Self.liveResponses
        responses.merge([
            "start_oauth_login": .object([
                "authorizeUrl": .string(
                    "https://auth.example.test/stale-exchange"
                ),
                "state": .string("stale-exchange-state"),
            ]),
            "oauth_listen_for_code": .object([
                "code": .string("stale-exchange-code"),
            ]),
            "oauth_exchange_code": .object([
                "authenticated": .bool(true),
            ]),
            "oauth_cancel_listen": .null,
        ]) { _, replacement in replacement }
        let engine = HQRecordingAppEngine(
            responses: responses,
            advertisedCapabilities:
                Set(Self.liveResponses.keys).union([
                    "start_oauth_login",
                    "oauth_listen_for_code",
                    "oauth_exchange_code",
                    "oauth_cancel_listen",
                ]),
            requestStubs: [
                HQTestEngineRequestStub(
                    method: "oauth_exchange_code",
                    params: .object([
                        "code": .string("stale-exchange-code"),
                    ]),
                    response: .object([
                        "authenticated": .bool(true),
                    ]),
                    gate: exchangeGate
                ),
            ]
        )
        let store = HQAppStore(
            engine: engine,
            launchMode: .live,
            updaterService: HQNativeUpdaterService(
                driver: HQAppStoreUpdaterDriverSpy()
            ),
            openExternalURL: { _ in }
        )
        await store.start()

        let flow = Task {
            await store.perform(
                .secondaryWindow(
                    kind: .signIn,
                    actionID: "sign-in-google"
                )
            )
        }
        await waitForGate(exchangeGate)
        XCTAssertEqual(
            store.oauthFlowState,
            .exchanging(
                provider: "Google",
                state: "stale-exchange-state"
            )
        )

        store.receiveEngineEvent(Self.reauthenticationEvent(sequence: 60))
        XCTAssertFalse(store.isAuthenticated)
        await exchangeGate.releaseNext()
        await flow.value

        XCTAssertEqual(store.oauthFlowState, .idle)
        XCTAssertFalse(store.isAuthenticated)
        XCTAssertTrue(store.content.snapshot.workspaces.isEmpty)
        XCTAssertTrue(store.content.snapshot.projects.isEmpty)
        XCTAssertTrue(store.sessions.isEmpty)
        XCTAssertNil(store.hqFolderPath)
        XCTAssertNotEqual(store.sceneRequest?.sceneID, "main")
    }

    func testDelayedPackageRefreshCannotCommitAfterAuthClear()
        async
    {
        let packagesGate = HQTestRequestGate()
        let packageResponse: HQJSONValue = .object([
            "packages": .array([
                .object([
                    "name": .string("protected-native-pack"),
                    "version": .string("1.0.0"),
                ]),
            ]),
        ])
        var responses = Self.liveResponses
        responses["list_packages"] = packageResponse
        let engine = HQRecordingAppEngine(
            responses: responses,
            requestStubs: [
                HQTestEngineRequestStub(
                    method: "list_packages",
                    response: packageResponse,
                    gate: packagesGate
                ),
            ]
        )
        let store = HQAppStore(
            engine: engine,
            launchMode: .live,
            updaterService: HQNativeUpdaterService(
                driver: HQAppStoreUpdaterDriverSpy()
            )
        )
        await store.start()
        store.capabilities.insert("list_packages")

        store.emitNativeParityEvent(
            .packagesComplete,
            data: .object([
                "op": .string("install"),
                "name": .string("protected-native-pack"),
                "message": .null,
            ])
        )
        await waitForGate(packagesGate)
        store.receiveEngineEvent(Self.reauthenticationEvent(sequence: 70))
        await packagesGate.releaseNext()
        await waitForCompletedRequest(
            "list_packages",
            engine: engine
        )
        for _ in 0..<20 {
            await Task.yield()
        }

        XCTAssertFalse(store.isAuthenticated)
        XCTAssertNil(store.secondaryDomainValues["list_packages"])
        XCTAssertNil(store.secondaryDomainFailures["list_packages"])
        XCTAssertTrue(store.content.packs.isEmpty)
        XCTAssertTrue(store.nativeParityEvents.packageLog.isEmpty)
    }

    func testDelayedMeetingPolicyCannotDeliverOrCommitAfterAuthClear()
        async
    {
        let meetingPolicyGate = HQTestRequestGate()
        let notificationCenter = HQRouteNotificationCenterSpy()
        let policyResponse: HQJSONValue = .object([
            "allowed": .bool(true),
            "reason": .string("allowed"),
            "notification": .object([
                "title": .string("Protected meeting"),
                "body": .string("This completion is stale."),
                "windowId": .string("stale-meeting-window"),
                "platform": .string("meet"),
                "meetingUrl": .string(
                    "https://meet.google.com/stale-policy"
                ),
                "sourceEventId": .string("stale-policy-event"),
            ]),
        ])
        var responses = Self.liveResponses
        responses["meetings_notify_detected"] = policyResponse
        let engine = HQRecordingAppEngine(
            responses: responses,
            requestStubs: [
                HQTestEngineRequestStub(
                    method: "meetings_notify_detected",
                    response: policyResponse,
                    gate: meetingPolicyGate
                ),
            ]
        )
        let store = HQAppStore(
            engine: engine,
            launchMode: .live,
            notificationService: HQNativeNotificationService(
                center: notificationCenter
            ),
            updaterService: HQNativeUpdaterService(
                driver: HQAppStoreUpdaterDriverSpy()
            )
        )
        await store.start()
        store.capabilities.insert("meetings_notify_detected")

        store.receiveEngineEvent(
            HQEngineEvent(
                requestID: nil,
                name: HQRecallEventName.meetingDetected.rawValue,
                sequence: 80,
                data: .object([
                    "detectionId": .string("stale-policy-detection"),
                    "meetingUrl": .string(
                        "https://meet.google.com/stale-policy"
                    ),
                    "windowId": .string("stale-meeting-window"),
                    "platform": .string("meet"),
                    "detectedAt": .string("2026-07-27T08:00:00Z"),
                    "source": .string("sdk-active-app"),
                    "sourceEventId": .string("stale-policy-event"),
                ])
            )
        )
        await waitForGate(meetingPolicyGate)
        store.receiveEngineEvent(Self.reauthenticationEvent(sequence: 81))
        await meetingPolicyGate.releaseNext()
        await waitForCompletedRequest(
            "meetings_notify_detected",
            engine: engine
        )
        for _ in 0..<20 {
            await Task.yield()
        }

        XCTAssertFalse(store.isAuthenticated)
        XCTAssertTrue(store.detectedMeetings.isEmpty)
        XCTAssertNil(
            store.secondaryDomainValues["meetings_notify_detected"]
        )
        XCTAssertTrue(
            store.nativeNotificationHistory.allSatisfy {
                $0.categoryIdentifier != "hq.meeting"
            }
        )
        XCTAssertTrue(
            notificationCenter.addedRequests.allSatisfy {
                $0.content.categoryIdentifier != "hq.meeting"
            }
        )
        XCTAssertNil(store.activeBannerPayload)
        XCTAssertFalse(store.isBannerPresented)
        XCTAssertFalse(store.meetingPromptBadgeVisible)
    }

    func testUnresolvedLiveAuthRejectsProtectedMutationEventAndNotification()
        async
    {
        let protectedMessage = Self.directMessageValue(
            id: "pre-bootstrap-dm",
            personUID: "pre-bootstrap-person",
            name: "Pre Bootstrap",
            body: "This must remain inaccessible."
        )
        let engine = HQRecordingAppEngine(
            responses: [
                HQEngineAppCommand.sendAgencyMessage.rawValue: .null,
            ]
        )
        let store = HQAppStore(
            engine: engine,
            launchMode: .live,
            updaterService: HQNativeUpdaterService(
                driver: HQAppStoreUpdaterDriverSpy()
            )
        )
        store.capabilities = [
            HQEngineAppCommand.sendAgencyMessage.rawValue,
        ]

        await store.perform(
            .engineCommand(
                .sendAgencyMessage,
                params: .object([
                    "body": .string("Must not send before auth resolves."),
                ]),
                successMessage: "Sent."
            )
        )
        store.receiveEngineEvent(
            Self.directMessageEvent(
                sequence: 90,
                id: "pre-bootstrap-dm",
                personUID: "pre-bootstrap-person",
                name: "Pre Bootstrap",
                body: "This must remain inaccessible."
            )
        )
        store.receiveNativeNotificationResponse(
            .directMessage(
                operation: .open,
                eventID: "pre-bootstrap-dm",
                payload: protectedMessage
            )
        )

        let protectedRequests = await engine.requestedParams(
            for: HQEngineAppCommand.sendAgencyMessage.rawValue
        )
        XCTAssertTrue(protectedRequests.isEmpty)
        XCTAssertTrue(store.content.messages.isEmpty)
        XCTAssertTrue(store.cloudRealtimeEventHistory.isEmpty)
        XCTAssertTrue(store.nativeNotificationHistory.isEmpty)
        XCTAssertNil(store.activeBannerPayload)
        XCTAssertNil(store.nativeParityEvents.dmDetailMessage)
        XCTAssertNil(store.sceneRequest)
        guard case let .failure(message) = store.operationState else {
            return XCTFail("Unresolved production auth must fail closed.")
        }
        XCTAssertTrue(message.localizedCaseInsensitiveContains("sign in"))
    }

    func testEventAndLifecycleStreamsSurviveSignedOutBootstrapAndOAuth()
        async
    {
        var responses = Self.liveResponses
        responses.merge([
            "auth.state": .object([
                "authenticated": .bool(false),
                "hasStoredTokens": .bool(false),
            ]),
            "start_oauth_login": .object([
                "authorizeUrl": .string(
                    "https://auth.example.test/stream-reauth"
                ),
                "state": .string("stream-reauth-state"),
            ]),
            "oauth_listen_for_code": .object([
                "code": .string("stream-reauth-code"),
            ]),
            "oauth_exchange_code": .object([
                "authenticated": .bool(true),
            ]),
            "oauth_cancel_listen": .null,
        ]) { _, replacement in replacement }
        let engine = HQRecordingAppEngine(
            responses: responses,
            advertisedCapabilities:
                Set(Self.liveResponses.keys).union([
                    "start_oauth_login",
                    "oauth_listen_for_code",
                    "oauth_exchange_code",
                    "oauth_cancel_listen",
                ])
        )
        let store = HQAppStore(
            engine: engine,
            launchMode: .live,
            updaterService: HQNativeUpdaterService(
                driver: HQAppStoreUpdaterDriverSpy()
            ),
            openExternalURL: { _ in }
        )
        await store.start()
        XCTAssertFalse(store.isAuthenticated)

        await engine.emitEvent(
            Self.directMessageEvent(
                sequence: 91,
                id: "signed-out-stream-dm",
                personUID: "signed-out-person",
                name: "Signed Out",
                body: "Ignore while signed out."
            )
        )
        for _ in 0..<20 {
            await Task.yield()
        }
        XCTAssertTrue(store.content.messages.isEmpty)

        await store.perform(
            .secondaryWindow(kind: .signIn, actionID: "sign-in-google")
        )
        XCTAssertTrue(store.isAuthenticated)
        await engine.emitEvent(
            Self.directMessageEvent(
                sequence: 92,
                id: "post-oauth-stream-dm",
                personUID: "post-oauth-person",
                name: "Post OAuth",
                body: "The listener is still alive."
            )
        )
        for _ in 0..<1_000 {
            if store.content.messages.contains(where: {
                $0.id == "post-oauth-stream-dm"
            }) {
                break
            }
            await Task.yield()
        }
        XCTAssertTrue(
            store.content.messages.contains {
                $0.id == "post-oauth-stream-dm"
            }
        )

        await engine.failLifecycle("stream lifecycle proof")
        for _ in 0..<1_000 {
            if case .failed = store.phase {
                break
            }
            await Task.yield()
        }
        guard case let .failed(message) = store.phase else {
            return XCTFail("Lifecycle delivery did not survive OAuth.")
        }
        XCTAssertTrue(message.contains("stream lifecycle proof"))
    }

    func testCancelledOAuthExchangeSignsOutLateAuthenticatedSession()
        async
    {
        let exchangeGate = HQTestRequestGate()
        var responses = Self.liveResponses
        responses.merge([
            "auth.state": .object([
                "authenticated": .bool(false),
                "hasStoredTokens": .bool(false),
            ]),
            "start_oauth_login": .object([
                "authorizeUrl": .string(
                    "https://auth.example.test/cancelled-exchange-cleanup"
                ),
                "state": .string("cancelled-exchange-state"),
            ]),
            "oauth_listen_for_code": .object([
                "code": .string("cancelled-exchange-code"),
            ]),
            "oauth_exchange_code": .object([
                "authenticated": .bool(true),
            ]),
            "oauth_cancel_listen": .null,
            "sign_out": .null,
        ]) { _, replacement in replacement }
        let engine = HQRecordingAppEngine(
            responses: responses,
            advertisedCapabilities:
                Set(Self.liveResponses.keys).union([
                    "start_oauth_login",
                    "oauth_listen_for_code",
                    "oauth_exchange_code",
                    "oauth_cancel_listen",
                    "sign_out",
                ]),
            requestStubs: [
                HQTestEngineRequestStub(
                    method: "oauth_exchange_code",
                    params: .object([
                        "code": .string("cancelled-exchange-code"),
                    ]),
                    response: .object([
                        "authenticated": .bool(true),
                    ]),
                    gate: exchangeGate
                ),
            ]
        )
        let store = HQAppStore(
            engine: engine,
            launchMode: .live,
            updaterService: HQNativeUpdaterService(
                driver: HQAppStoreUpdaterDriverSpy()
            ),
            openExternalURL: { _ in }
        )
        await store.start()

        let flow = Task {
            await store.perform(
                .secondaryWindow(
                    kind: .signIn,
                    actionID: "sign-in-google"
                )
            )
        }
        await waitForGate(exchangeGate)
        await store.perform(
            .secondaryWindow(kind: .signIn, actionID: "cancel")
        )
        await exchangeGate.releaseNext()
        await flow.value
        await waitForCompletedRequest("sign_out", engine: engine)

        let cleanupRequests = await engine.requestedParams(for: "sign_out")
        XCTAssertEqual(cleanupRequests, [.object([:])])
        XCTAssertFalse(store.isAuthenticated)
        XCTAssertEqual(store.oauthFlowState, .idle)
    }

    func testAuthClearedOAuthExchangeSignsOutLateAuthenticatedSession()
        async
    {
        let exchangeGate = HQTestRequestGate()
        var responses = Self.liveResponses
        responses.merge([
            "start_oauth_login": .object([
                "authorizeUrl": .string(
                    "https://auth.example.test/stale-exchange-cleanup"
                ),
                "state": .string("stale-cleanup-state"),
            ]),
            "oauth_listen_for_code": .object([
                "code": .string("stale-cleanup-code"),
            ]),
            "oauth_exchange_code": .object([
                "authenticated": .bool(true),
            ]),
            "oauth_cancel_listen": .null,
            "sign_out": .null,
        ]) { _, replacement in replacement }
        let engine = HQRecordingAppEngine(
            responses: responses,
            advertisedCapabilities:
                Set(Self.liveResponses.keys).union([
                    "start_oauth_login",
                    "oauth_listen_for_code",
                    "oauth_exchange_code",
                    "oauth_cancel_listen",
                    "sign_out",
                ]),
            requestStubs: [
                HQTestEngineRequestStub(
                    method: "oauth_exchange_code",
                    params: .object([
                        "code": .string("stale-cleanup-code"),
                    ]),
                    response: .object([
                        "authenticated": .bool(true),
                    ]),
                    gate: exchangeGate
                ),
            ]
        )
        let store = HQAppStore(
            engine: engine,
            launchMode: .live,
            updaterService: HQNativeUpdaterService(
                driver: HQAppStoreUpdaterDriverSpy()
            ),
            openExternalURL: { _ in }
        )
        await store.start()

        let flow = Task {
            await store.perform(
                .secondaryWindow(
                    kind: .signIn,
                    actionID: "sign-in-google"
                )
            )
        }
        await waitForGate(exchangeGate)
        store.receiveEngineEvent(Self.reauthenticationEvent(sequence: 93))
        await exchangeGate.releaseNext()
        await flow.value
        await waitForCompletedRequest("sign_out", engine: engine)

        let cleanupRequests = await engine.requestedParams(for: "sign_out")
        XCTAssertEqual(cleanupRequests, [.object([:])])
        XCTAssertFalse(store.isAuthenticated)
        XCTAssertTrue(store.content.snapshot.workspaces.isEmpty)
        XCTAssertEqual(store.oauthFlowState, .idle)
    }

    func testLateSupersededFolderSaveReassertsNewestCommittedPreferences()
        async
    {
        let olderSaveGate = HQTestRequestGate()
        let originalSettings: HQJSONValue = .object([
            "hqPath": .string("/tmp/HQ"),
            "releaseChannel": .string("stable"),
        ])
        let olderSettings: HQJSONValue = .object([
            "hqPath": .string("/tmp/LateOlderHQ"),
            "releaseChannel": .string("stable"),
        ])
        let newerSettings: HQJSONValue = .object([
            "hqPath": .string("/tmp/CommittedNewerHQ"),
            "releaseChannel": .string("stable"),
        ])
        var responses = Self.liveResponses
        responses.merge([
            "detect_hq": .object([
                "exists": .bool(true),
                "isHq": .bool(true),
                "nonEmpty": .bool(true),
            ]),
            "check_writable": .bool(true),
            "get_settings": originalSettings,
            "save_settings": .null,
        ]) { _, replacement in replacement }
        var selectedPaths = [
            "/tmp/LateOlderHQ",
            "/tmp/CommittedNewerHQ",
        ]
        let engine = HQRecordingAppEngine(
            responses: responses,
            advertisedCapabilities:
                Set(Self.liveResponses.keys).union([
                    "detect_hq",
                    "check_writable",
                    "get_settings",
                    "save_settings",
                ]),
            requestStubs: [
                HQTestEngineRequestStub(
                    method: "save_settings",
                    params: .object(["prefs": olderSettings]),
                    occurrence: 1,
                    response: .null,
                    gate: olderSaveGate
                ),
                HQTestEngineRequestStub(
                    method: "workspaces.list",
                    occurrence: 2,
                    response: .object([
                        "source": .string("local"),
                        "hqFolderPath": .string(
                            "/tmp/CommittedNewerHQ"
                        ),
                        "workspaces": .array([]),
                    ])
                ),
                HQTestEngineRequestStub(
                    method: "get_settings",
                    occurrence: 3,
                    response: olderSettings
                ),
            ]
        )
        let store = HQAppStore(
            engine: engine,
            launchMode: .live,
            updaterService: HQNativeUpdaterService(
                driver: HQAppStoreUpdaterDriverSpy()
            ),
            pickFiles: { _ in
                let path = selectedPaths.removeFirst()
                return [URL(fileURLWithPath: path, isDirectory: true)]
            }
        )
        await store.start()

        let olderChoice = Task {
            await store.perform(.nativeCommand(.pickFolder))
        }
        await waitForGate(olderSaveGate)
        let newerChoice = Task {
            await store.perform(.nativeCommand(.pickFolder))
        }
        await olderSaveGate.releaseNext()
        await olderChoice.value
        await newerChoice.value

        let saveRequests = await engine.requestedParams(
            for: "save_settings"
        )
        XCTAssertEqual(
            saveRequests,
            [
                .object(["prefs": olderSettings]),
                .object(["prefs": newerSettings]),
            ],
            "Folder settings transactions must serialize so the newest choice is the final atomic write."
        )
        XCTAssertEqual(store.hqFolderPath, "/tmp/CommittedNewerHQ")
        XCTAssertEqual(
            store.lastNativeResult,
            .string("/tmp/CommittedNewerHQ")
        )
    }

    func testDelayedNotificationAddIsRepurgedAfterAuthenticationClear()
        async
    {
        let notificationAddGate = HQTestRequestGate()
        let notificationCenter = HQGatedNotificationCenterSpy(
            addGate: notificationAddGate
        )
        var responses = Self.liveResponses
        responses["sign_out"] = .null
        let engine = HQRecordingAppEngine(
            responses: responses,
            advertisedCapabilities:
                Set(Self.liveResponses.keys).union(["sign_out"])
        )
        let store = HQAppStore(
            engine: engine,
            launchMode: .live,
            notificationService: HQNativeNotificationService(
                center: notificationCenter
            ),
            updaterService: HQNativeUpdaterService(
                driver: HQAppStoreUpdaterDriverSpy()
            )
        )
        await store.start()
        store.receiveEngineEvent(
            Self.directMessageEvent(
                sequence: 94,
                id: "delayed-notification",
                personUID: "delayed-notification-person",
                name: "Delayed",
                body: "This request completes after sign-out."
            )
        )
        await waitForGate(notificationAddGate)

        store.emitNativeParityEvent(.traySignOut)
        await waitForCompletedRequest("sign_out", engine: engine)
        for _ in 0..<1_000 where store.isAuthenticated {
            await Task.yield()
        }
        XCTAssertFalse(store.isAuthenticated)
        let deliveredPurgesAtClear =
            notificationCenter.deliveredRemovalCount
        let pendingPurgesAtClear = notificationCenter.pendingRemovalCount
        XCTAssertGreaterThanOrEqual(deliveredPurgesAtClear, 1)
        XCTAssertGreaterThanOrEqual(pendingPurgesAtClear, 1)

        await notificationAddGate.releaseNext()
        for _ in 0..<1_000 {
            if notificationCenter.addCompletions == 1 {
                break
            }
            await Task.yield()
        }
        for _ in 0..<20 {
            await Task.yield()
        }

        XCTAssertEqual(notificationCenter.addCompletions, 1)
        XCTAssertTrue(
            notificationCenter.addedRequests.isEmpty,
            "A non-cancellation-aware add that lands after auth clear must be purged."
        )
        XCTAssertGreaterThan(
            notificationCenter.deliveredRemovalCount,
            deliveredPurgesAtClear
        )
        XCTAssertGreaterThan(
            notificationCenter.pendingRemovalCount,
            pendingPurgesAtClear
        )
        XCTAssertTrue(store.nativeNotificationHistory.isEmpty)
    }

    func testStaleRecordingStartCleanupFailureStopsEngineAndRequiresRefresh()
        async
    {
        let startGate = HQTestRequestGate()
        var responses = Self.liveResponses
        responses["start_recording"] = .null
        let engine = HQRecordingAppEngine(
            responses: responses,
            advertisedCapabilities:
                Set(Self.liveResponses.keys).union([
                    "start_recording",
                    "stop_recording",
                ]),
            requestStubs: [
                HQTestEngineRequestStub(
                    method: "start_recording",
                    params: .object([
                        "windowId": .string("stale-start-window"),
                        "companyUid": .string("company-native"),
                    ]),
                    response: .null,
                    gate: startGate
                ),
                HQTestEngineRequestStub(
                    method: "stop_recording",
                    params: .object([
                        "windowId": .string("stale-start-window"),
                    ]),
                    errorMessage:
                        "Compensating stop could not reach Recall."
                ),
            ]
        )
        let store = HQAppStore(
            engine: engine,
            launchMode: .live,
            updaterService: HQNativeUpdaterService(
                driver: HQAppStoreUpdaterDriverSpy()
            )
        )
        await store.start()

        let staleStart = Task {
            await store.perform(
                .engineCommand(
                    .startRecording,
                    params: .object([
                        "windowId": .string("stale-start-window"),
                        "companyUid": .string("company-native"),
                    ]),
                    successMessage: "Recording started."
                )
            )
        }
        await waitForGate(startGate)
        store.receiveEngineEvent(Self.reauthenticationEvent(sequence: 95))
        await startGate.releaseNext()
        await staleStart.value
        await waitForCompletedRequest("stop_recording", engine: engine)
        for _ in 0..<1_000 {
            if await engine.stopCallCount() == 1 {
                break
            }
            await Task.yield()
        }

        let staleCleanupStopCalls = await engine.stopCallCount()
        XCTAssertEqual(staleCleanupStopCalls, 1)
        guard case let .failed(message) = store.phase else {
            return XCTFail(
                "Failed stale-recording cleanup must require Refresh."
            )
        }
        XCTAssertTrue(
            message.localizedCaseInsensitiveContains("recording")
        )
        XCTAssertTrue(message.localizedCaseInsensitiveContains("refresh"))

        await store.perform(
            .engineCommand(
                .startRecording,
                params: .object([
                    "windowId": .string("stale-start-window"),
                    "companyUid": .string("company-native"),
                ]),
                successMessage: "Must not restart."
            )
        )
        let startRequests = await engine.requestedParams(
            for: "start_recording"
        )
        XCTAssertEqual(startRequests.count, 1)
    }

    func testLogoutCleanupBlocksWindowReuseAndReapsEngineBeforeHandleClear()
        async
    {
        let recordingCleanupGate = HQTestRequestGate()
        let engineStopGate = HQTestRequestGate()
        var responses = Self.liveResponses
        responses.merge([
            "start_recording": .null,
            "start_oauth_login": .object([
                "authorizeUrl": .string(
                    "https://auth.example.test/cleanup-pending"
                ),
                "state": .string("cleanup-pending-state"),
            ]),
            "oauth_listen_for_code": .object([
                "code": .string("cleanup-pending-code"),
            ]),
            "oauth_exchange_code": .object([
                "authenticated": .bool(true),
            ]),
            "oauth_cancel_listen": .null,
        ]) { _, replacement in replacement }
        let engine = HQRecordingAppEngine(
            responses: responses,
            advertisedCapabilities:
                Set(Self.liveResponses.keys).union([
                    "start_recording",
                    "stop_recording",
                    "start_oauth_login",
                    "oauth_listen_for_code",
                    "oauth_exchange_code",
                    "oauth_cancel_listen",
                ]),
            requestStubs: [
                HQTestEngineRequestStub(
                    method: "stop_recording",
                    params: .object([
                        "windowId": .string("cleanup-pending-window"),
                    ]),
                    errorMessage: "Logout cleanup failed.",
                    gate: recordingCleanupGate
                ),
            ],
            stopGate: engineStopGate
        )
        let store = HQAppStore(
            engine: engine,
            launchMode: .live,
            updaterService: HQNativeUpdaterService(
                driver: HQAppStoreUpdaterDriverSpy()
            ),
            openExternalURL: { _ in }
        )
        await store.start()
        let retainedStartedAt = "2026-07-27T08:40:00Z"
        store.receiveEngineEvent(
            Self.recordingStartedEvent(
                sequence: 96,
                windowID: "cleanup-pending-window",
                startedAt: retainedStartedAt
            )
        )

        store.receiveEngineEvent(Self.reauthenticationEvent(sequence: 97))
        await waitForGate(recordingCleanupGate)
        await store.perform(
            .secondaryWindow(kind: .signIn, actionID: "sign-in-google")
        )
        XCTAssertTrue(store.isAuthenticated)

        await store.perform(
            .engineCommand(
                .startRecording,
                params: .object([
                    "windowId": .string("cleanup-pending-window"),
                    "companyUid": .string("company-new"),
                ]),
                successMessage: "Must wait for cleanup."
            )
        )
        let prematureStarts = await engine.requestedParams(
            for: "start_recording"
        )
        XCTAssertTrue(
            prematureStarts.isEmpty,
            "A window remains cleanup-pending and cannot be reused by a new capture."
        )

        await recordingCleanupGate.releaseNext()
        await waitForCompletedRequest("stop_recording", engine: engine)
        await waitForGate(engineStopGate)
        let cleanupStopStarts = await engine.stopStartCount()
        XCTAssertEqual(cleanupStopStarts, 1)
        XCTAssertEqual(
            store.activeRecallRecordings[
                "cleanup-pending-window"
            ]?.startedAt,
            retainedStartedAt,
            "The retained handle remains until engine.stop has reaped the capture process."
        )

        await engineStopGate.releaseNext()
        for _ in 0..<1_000 {
            if await engine.stopCallCount() == 1,
               store.activeRecallRecordings[
                   "cleanup-pending-window"
               ] == nil
            {
                break
            }
            await Task.yield()
        }

        let cleanupStopCalls = await engine.stopCallCount()
        XCTAssertEqual(cleanupStopCalls, 1)
        XCTAssertNil(
            store.activeRecallRecordings["cleanup-pending-window"]
        )
        guard case let .failed(message) = store.phase else {
            return XCTFail(
                "Logout cleanup failure must leave a Refresh-required phase."
            )
        }
        XCTAssertTrue(message.localizedCaseInsensitiveContains("refresh"))
    }

    func testSignedOutExternalNotificationParityAndMessagesSceneStayProtected()
        async
    {
        var responses = Self.liveResponses
        responses["auth.state"] = .object([
            "authenticated": .bool(false),
            "hasStoredTokens": .bool(false),
        ])
        responses["mark_messages_read"] = .null
        let engine = HQRecordingAppEngine(
            responses: responses,
            advertisedCapabilities:
                Set(Self.liveResponses.keys).union([
                    "mark_messages_read",
                ])
        )
        let store = HQAppStore(
            engine: engine,
            launchMode: .live,
            updaterService: HQNativeUpdaterService(
                driver: HQAppStoreUpdaterDriverSpy()
            )
        )
        await store.start()
        XCTAssertFalse(store.isAuthenticated)

        store.receiveEngineEvent(
            HQEngineEvent(
                requestID: nil,
                name:
                    HQNativeParityEventName.notificationDMAction.rawValue,
                sequence: 100,
                data: .object([
                    "action": .string("open"),
                    "event": Self.directMessageValue(
                        id: "signed-out-native-dm",
                        personUID: "signed-out-person",
                        name: "Signed Out",
                        body: "This payload must remain protected."
                    ),
                ])
            )
        )
        store.receiveEngineEvent(
            HQEngineEvent(
                requestID: nil,
                name:
                    HQNativeParityEventName.notificationShareAction.rawValue,
                sequence: 101,
                data: .object([
                    "action": .string("open"),
                    "event": .object([
                        "eventId": .string("signed-out-native-share"),
                        "issuerEmail": .string(
                            "signed-out@example.test"
                        ),
                        "issuerDisplayName": .string("Signed Out"),
                        "issuerPersonUid": .string(
                            "signed-out-person"
                        ),
                        "paths": .array([
                            .string("knowledge/protected.md"),
                        ]),
                        "note": .string(
                            "This share must remain protected."
                        ),
                        "permission": .string("read"),
                        "createdAt": .string(
                            "2026-07-27T09:00:00Z"
                        ),
                    ]),
                ])
            )
        )
        await store.perform(
            .sceneReady(HQSecondaryWindowKind.messages.rawValue)
        )

        let markReadRequests = await engine.requestedParams(
            for: "mark_messages_read"
        )
        XCTAssertTrue(
            markReadRequests.isEmpty,
            "A signed-out messages scene must not mutate protected read state."
        )
        XCTAssertTrue(
            store.nativeParityEvents.history.allSatisfy {
                $0.name != .notificationDMAction
                    && $0.name != .notificationShareAction
            },
            "External DM/share parity events must be ignored while signed out."
        )
        XCTAssertNil(store.nativeParityEvents.dmDetailMessage)
        XCTAssertNil(store.nativeParityEvents.selectedShare)
        XCTAssertNotEqual(
            store.sceneRequest?.sceneID,
            HQSecondaryWindowKind.directMessageDetail.rawValue
        )
        XCTAssertNotEqual(
            store.sceneRequest?.sceneID,
            HQSecondaryWindowKind.shareDetail.rawValue
        )
    }

    func testAuthClearDuringPostExchangeRehydrateAlwaysSignsOut()
        async
    {
        let rehydrateGate = HQTestRequestGate()
        var responses = Self.liveResponses
        responses.merge([
            "start_oauth_login": .object([
                "authorizeUrl": .string(
                    "https://auth.example.test/stale-rehydrate"
                ),
                "state": .string("stale-rehydrate-state"),
            ]),
            "oauth_listen_for_code": .object([
                "code": .string("stale-rehydrate-code"),
            ]),
            "oauth_exchange_code": .object([
                "authenticated": .bool(true),
            ]),
            "oauth_cancel_listen": .null,
            "sign_out": .null,
        ]) { _, replacement in replacement }
        let engine = HQRecordingAppEngine(
            responses: responses,
            advertisedCapabilities:
                Set(Self.liveResponses.keys).union([
                    "start_oauth_login",
                    "oauth_listen_for_code",
                    "oauth_exchange_code",
                    "oauth_cancel_listen",
                    "sign_out",
                ]),
            requestStubs: [
                HQTestEngineRequestStub(
                    method: "config.get",
                    occurrence: 2,
                    response: responses["config.get"]!,
                    gate: rehydrateGate
                ),
            ]
        )
        let store = HQAppStore(
            engine: engine,
            launchMode: .live,
            updaterService: HQNativeUpdaterService(
                driver: HQAppStoreUpdaterDriverSpy()
            ),
            openExternalURL: { _ in }
        )
        await store.start()

        let flow = Task {
            await store.perform(
                .secondaryWindow(
                    kind: .signIn,
                    actionID: "sign-in-google"
                )
            )
        }
        await waitForGate(rehydrateGate)
        let completedExchanges = await engine.completedRequestCount(
            for: "oauth_exchange_code"
        )
        XCTAssertEqual(
            completedExchanges,
            1,
            "The auth clear must land after credentials were exchanged."
        )

        store.receiveEngineEvent(Self.reauthenticationEvent(sequence: 102))
        await rehydrateGate.releaseNext()
        await flow.value
        await waitForCompletedRequest("sign_out", engine: engine)

        let signOutRequests = await engine.requestedParams(for: "sign_out")
        XCTAssertEqual(
            signOutRequests,
            [.object([:])],
            "Any invalidation after a successful exchange must discard credentials, even while rehydration is pending."
        )
        XCTAssertFalse(store.isAuthenticated)
        XCTAssertTrue(store.content.snapshot.workspaces.isEmpty)
        XCTAssertEqual(store.oauthFlowState, .idle)
    }

    func testRepeatedAuthClearSignalsIssueOnePendingRecordingStop()
        async
    {
        let cleanupGate = HQTestRequestGate()
        var responses = Self.liveResponses
        responses.merge([
            "stop_recording": .null,
            "start_oauth_login": .object([
                "authorizeUrl": .string(
                    "https://auth.example.test/repeated-auth-clear"
                ),
                "state": .string("repeated-auth-clear-state"),
            ]),
            "oauth_listen_for_code": .object([
                "code": .string("repeated-auth-clear-code"),
            ]),
            "oauth_exchange_code": .object([
                "authenticated": .bool(true),
            ]),
            "oauth_cancel_listen": .null,
        ]) { _, replacement in replacement }
        let engine = HQRecordingAppEngine(
            responses: responses,
            advertisedCapabilities:
                Set(Self.liveResponses.keys).union([
                    "stop_recording",
                    "start_oauth_login",
                    "oauth_listen_for_code",
                    "oauth_exchange_code",
                    "oauth_cancel_listen",
                ]),
            requestStubs: [
                HQTestEngineRequestStub(
                    method: "stop_recording",
                    params: .object([
                        "windowId": .string(
                            "repeated-auth-clear-window"
                        ),
                    ]),
                    response: .null,
                    gate: cleanupGate
                ),
            ]
        )
        let store = HQAppStore(
            engine: engine,
            launchMode: .live,
            updaterService: HQNativeUpdaterService(
                driver: HQAppStoreUpdaterDriverSpy()
            ),
            openExternalURL: { _ in }
        )
        await store.start()
        store.receiveEngineEvent(
            Self.recordingStartedEvent(
                sequence: 103,
                windowID: "repeated-auth-clear-window",
                startedAt: "2026-07-27T09:10:00Z"
            )
        )

        store.receiveEngineEvent(Self.reauthenticationEvent(sequence: 104))
        await waitForGate(cleanupGate)
        await store.perform(
            .secondaryWindow(
                kind: .signIn,
                actionID: "sign-in-google"
            )
        )
        XCTAssertTrue(
            store.isAuthenticated,
            "The second clear must be a real authenticated transition while the first cleanup is pending."
        )
        store.receiveEngineEvent(Self.reauthenticationEvent(sequence: 105))
        for _ in 0..<50 {
            await Task.yield()
        }

        let cleanupArrivals = await cleanupGate.arrivalCount()
        let pendingStopRequests = await engine.requestedParams(
            for: "stop_recording"
        )
        XCTAssertEqual(
            cleanupArrivals,
            1,
            "One pending capture cleanup must remain single-flight across repeated auth-clear signals."
        )
        XCTAssertEqual(
            pendingStopRequests,
            [
                .object([
                    "windowId": .string(
                        "repeated-auth-clear-window"
                    ),
                ]),
            ]
        )

        await cleanupGate.releaseNext()
        await waitForCompletedRequest("stop_recording", engine: engine)
        for _ in 0..<20 {
            await Task.yield()
        }
        let completedStopRequests = await engine.requestedParams(
            for: "stop_recording"
        )
        XCTAssertEqual(
            completedStopRequests.count,
            1
        )
        XCTAssertNil(
            store.activeRecallRecordings[
                "repeated-auth-clear-window"
            ]
        )
    }

    func testStaleRecordingStartSuccessWithoutStopCapabilityReapsEngine()
        async
    {
        let startGate = HQTestRequestGate()
        var responses = Self.liveResponses
        responses["start_recording"] = .null
        let engine = HQRecordingAppEngine(
            responses: responses,
            advertisedCapabilities:
                Set(Self.liveResponses.keys).union([
                    "start_recording",
                ]),
            requestStubs: [
                HQTestEngineRequestStub(
                    method: "start_recording",
                    params: .object([
                        "windowId": .string(
                            "ambiguous-success-window"
                        ),
                        "companyUid": .string("company-native"),
                    ]),
                    response: .null,
                    gate: startGate
                ),
            ]
        )
        let store = HQAppStore(
            engine: engine,
            launchMode: .live,
            updaterService: HQNativeUpdaterService(
                driver: HQAppStoreUpdaterDriverSpy()
            )
        )
        await store.start()

        let start = Task {
            await store.perform(
                .engineCommand(
                    .startRecording,
                    params: .object([
                        "windowId": .string(
                            "ambiguous-success-window"
                        ),
                        "companyUid": .string("company-native"),
                    ]),
                    successMessage: "Recording started."
                )
            )
        }
        await waitForGate(startGate)
        store.receiveEngineEvent(Self.reauthenticationEvent(sequence: 107))
        await startGate.releaseNext()
        await start.value
        await waitForEngineStop(engine)

        let engineStopCalls = await engine.stopCallCount()
        let compensationRequests = await engine.requestedParams(
            for: "stop_recording"
        )
        XCTAssertEqual(engineStopCalls, 1)
        XCTAssertTrue(compensationRequests.isEmpty)
        guard case let .failed(message) = store.phase else {
            return XCTFail(
                "An un-compensatable late recording success must require Refresh."
            )
        }
        XCTAssertTrue(message.localizedCaseInsensitiveContains("recording"))
        XCTAssertTrue(message.localizedCaseInsensitiveContains("refresh"))
    }

    func testStaleRecordingStartErrorWithoutStopCapabilityReapsEngine()
        async
    {
        let startGate = HQTestRequestGate()
        var responses = Self.liveResponses
        responses["start_recording"] = .null
        let engine = HQRecordingAppEngine(
            responses: responses,
            advertisedCapabilities:
                Set(Self.liveResponses.keys).union([
                    "start_recording",
                ]),
            requestStubs: [
                HQTestEngineRequestStub(
                    method: "start_recording",
                    params: .object([
                        "windowId": .string(
                            "ambiguous-error-window"
                        ),
                        "companyUid": .string("company-native"),
                    ]),
                    errorMessage:
                        "The transport closed after dispatching start_recording.",
                    gate: startGate
                ),
            ]
        )
        let store = HQAppStore(
            engine: engine,
            launchMode: .live,
            updaterService: HQNativeUpdaterService(
                driver: HQAppStoreUpdaterDriverSpy()
            )
        )
        await store.start()

        let start = Task {
            await store.perform(
                .engineCommand(
                    .startRecording,
                    params: .object([
                        "windowId": .string(
                            "ambiguous-error-window"
                        ),
                        "companyUid": .string("company-native"),
                    ]),
                    successMessage: "Recording started."
                )
            )
        }
        await waitForGate(startGate)
        store.receiveEngineEvent(Self.reauthenticationEvent(sequence: 108))
        await startGate.releaseNext()
        await start.value
        await waitForEngineStop(engine)

        let engineStopCalls = await engine.stopCallCount()
        let compensationRequests = await engine.requestedParams(
            for: "stop_recording"
        )
        XCTAssertEqual(engineStopCalls, 1)
        XCTAssertTrue(compensationRequests.isEmpty)
        guard case let .failed(message) = store.phase else {
            return XCTFail(
                "An ambiguous recording error without a stop capability must require Refresh."
            )
        }
        XCTAssertTrue(message.localizedCaseInsensitiveContains("recording"))
        XCTAssertTrue(message.localizedCaseInsensitiveContains("refresh"))
    }

    func testLiveRouteFanOutDoesNotDispatchQueuedProtectedRequestAfterAuthClear()
        async
    {
        let routeMethods: Set<String> = [
            "list_channels",
            "list_dm_requests",
            "fetch_notification_history",
        ]
        var responses = Self.liveResponses
        responses.merge([
            "list_channels": .object(["channels": .array([])]),
            "list_dm_requests": .object(["requests": .array([])]),
            "fetch_notification_history": .object([
                "dms": .array([]),
                "shares": .array([]),
                "files": .array([]),
            ]),
        ]) { _, replacement in replacement }
        let engine = HQQueuedFanOutAppEngine(
            responses: responses,
            advertisedCapabilities: Set(Self.liveResponses.keys)
        )
        let store = HQAppStore(
            engine: engine,
            launchMode: .live,
            updaterService: HQNativeUpdaterService(
                driver: HQAppStoreUpdaterDriverSpy()
            )
        )
        await store.start()
        store.capabilities.formUnion(routeMethods)
        engine.armProtectedFanOut(methods: routeMethods) { [weak store] in
            store?.receiveEngineEvent(
                Self.reauthenticationEvent(sequence: 109)
            )
        }

        let loading = Task {
            await store.loadLiveRoute(.global(.inbox))
        }
        await waitForFanOutGate(engine)
        for _ in 0..<50 {
            await Task.yield()
        }

        XCTAssertFalse(store.isAuthenticated)
        let requestsBeforeRelease = engine.requestedMethods().filter {
            routeMethods.contains($0)
        }
        XCTAssertEqual(
            requestsBeforeRelease.count,
            1,
            "Only the first protected route request may reach the engine before auth invalidates the queued siblings."
        )

        await engine.releaseGatedRequest()
        await loading.value
        let completedRouteRequests = engine.requestedMethods().filter {
            routeMethods.contains($0)
        }
        XCTAssertEqual(
            completedRouteRequests,
            requestsBeforeRelease,
            "Queued route fan-out requests must re-check auth before dispatch."
        )
    }

    func testSecondaryDomainFanOutDoesNotDispatchQueuedProtectedRequestAfterAuthClear()
        async
    {
        let secondaryMethods: Set<String> = [
            "get_activity_log",
            "list_channels",
        ]
        var responses = Self.liveResponses
        responses.merge([
            "get_activity_log": .array([]),
            "list_channels": .object(["channels": .array([])]),
        ]) { _, replacement in replacement }
        let engine = HQQueuedFanOutAppEngine(
            responses: responses,
            advertisedCapabilities:
                Set(Self.liveResponses.keys).union(secondaryMethods)
        )
        let store = HQAppStore(
            engine: engine,
            launchMode: .live,
            updaterService: HQNativeUpdaterService(
                driver: HQAppStoreUpdaterDriverSpy()
            )
        )
        engine.armProtectedFanOut(
            methods: secondaryMethods
        ) { [weak store] in
            store?.receiveEngineEvent(
                Self.reauthenticationEvent(sequence: 110)
            )
        }

        let startup = Task {
            await store.start()
        }
        await waitForFanOutGate(engine)
        for _ in 0..<50 {
            await Task.yield()
        }

        XCTAssertFalse(store.isAuthenticated)
        let requestsBeforeRelease = engine.requestedMethods().filter {
            secondaryMethods.contains($0)
        }
        XCTAssertEqual(
            requestsBeforeRelease.count,
            1,
            "Only the first protected secondary-domain request may dispatch before auth clear."
        )

        await engine.releaseGatedRequest()
        await startup.value
        let completedSecondaryRequests = engine.requestedMethods().filter {
            secondaryMethods.contains($0)
        }
        XCTAssertEqual(
            completedSecondaryRequests,
            requestsBeforeRelease,
            "Queued secondary-domain requests must not dispatch after their auth generation is invalidated."
        )
    }

    private func waitForFanOutGate(
        _ engine: HQQueuedFanOutAppEngine,
        file: StaticString = #filePath,
        line: UInt = #line
    ) async {
        for _ in 0..<1_000 {
            if await engine.gatedArrivalCount() >= 1 {
                return
            }
            await Task.yield()
        }
        XCTFail(
            "Timed out waiting for the first protected fan-out request.",
            file: file,
            line: line
        )
    }

    private func waitForGate(
        _ gate: HQTestRequestGate,
        arrivals expectedCount: Int = 1,
        file: StaticString = #filePath,
        line: UInt = #line
    ) async {
        for _ in 0..<1_000 {
            if await gate.arrivalCount() >= expectedCount {
                return
            }
            await Task.yield()
        }
        XCTFail(
            "Timed out waiting for a gated engine request.",
            file: file,
            line: line
        )
    }

    private func waitForCompletedRequest(
        _ method: String,
        count expectedCount: Int = 1,
        engine: HQRecordingAppEngine,
        file: StaticString = #filePath,
        line: UInt = #line
    ) async {
        for _ in 0..<1_000 {
            if await engine.completedRequestCount(for: method)
                >= expectedCount
            {
                return
            }
            await Task.yield()
        }
        XCTFail(
            "Timed out waiting for \(method) to complete.",
            file: file,
            line: line
        )
    }

    private func waitForEngineStop(
        _ engine: HQRecordingAppEngine,
        file: StaticString = #filePath,
        line: UInt = #line
    ) async {
        for _ in 0..<1_000 {
            if await engine.stopCallCount() >= 1 {
                return
            }
            await Task.yield()
        }
        XCTFail(
            "Timed out waiting for the engine to stop.",
            file: file,
            line: line
        )
    }

    private static func directMessageValue(
        id: String,
        personUID: String,
        name: String,
        body: String
    ) -> HQJSONValue {
        .object([
            "eventId": .string(id),
            "fromPersonUid": .string(personUID),
            "fromEmail": .string("\(personUID)@example.test"),
            "fromDisplayName": .string(name),
            "body": .string(body),
            "details": .null,
            "prompt": .null,
            "createdAt": .string("2026-07-27T07:00:00Z"),
        ])
    }

    private static func directMessageEvent(
        sequence: UInt64,
        id: String,
        personUID: String,
        name: String,
        body: String
    ) -> HQEngineEvent {
        HQEngineEvent(
            requestID: nil,
            name: HQCloudRealtimeEventName.directMessages.rawValue,
            sequence: sequence,
            data: .array([
                directMessageValue(
                    id: id,
                    personUID: personUID,
                    name: name,
                    body: body
                ),
            ])
        )
    }

    private static func reauthenticationEvent(
        sequence: UInt64
    ) -> HQEngineEvent {
        HQEngineEvent(
            requestID: nil,
            name: HQCloudRealtimeEventName.reauthenticationRequired.rawValue,
            sequence: sequence,
            data: .null
        )
    }

    private static func recordingStartedEvent(
        sequence: UInt64,
        windowID: String,
        startedAt: String
    ) -> HQEngineEvent {
        HQEngineEvent(
            requestID: nil,
            name: HQRecallEventName.recordingStarted.rawValue,
            sequence: sequence,
            data: .object([
                "windowId": .string(windowID),
                "platform": .string("meet"),
                "startedAt": .string(startedAt),
            ])
        )
    }

    private static let liveResponses: [String: HQJSONValue] = [
        "config.get": .object([
            "source": .string("local"),
            "config": .object(["company_slug": .string("indigo")]),
        ]),
        "auth.state": .object([
            "source": .string("local"),
            "authenticated": .bool(true),
            "hasStoredTokens": .bool(true),
        ]),
        "workspaces.list": .object([
            "source": .string("local"),
            "hqFolderPath": .string("/tmp/HQ"),
            "workspaces": .array([
                .object([
                    "slug": .string("indigo"),
                    "displayName": .string("Indigo"),
                    "path": .string("/tmp/HQ/companies/indigo"),
                    "exists": .bool(true),
                    "source": .string("local"),
                ]),
            ]),
        ]),
        "sync.status": .object([
            "lastSyncAt": .string("2026-07-26T18:00:00Z"),
            "pendingChanges": .number(0),
        ]),
        "projects.list": .array([
            .object([
                "id": .string("native-macos"),
                "companySlug": .string("indigo"),
                "title": .string("Native macOS"),
                "summary": .string("Native HQ"),
                "status": .string("in-progress"),
                "path": .string("/tmp/HQ/companies/indigo/projects/native-macos"),
                "prdPath": .string(
                    "companies/indigo/projects/native-macos/prd.json"
                ),
                "tasks": .array([]),
            ]),
        ]),
        "sessions.list": .array([
            .object([
                "id": .string("session-1"),
                "title": .string("Native implementation"),
                "provider": .string("codex"),
                "status": .string("active"),
            ]),
        ]),
    ]

    private func rowTitles(in state: HQWindowContentState) -> [String] {
        guard case let .content(fixture) = state else {
            return []
        }
        return fixture.rows.map(\.title)
    }

    private func routeRowTitles(in state: HQLiveRouteState) -> [String] {
        guard case let .content(content) = state else {
            return []
        }
        return content.rows.map(\.title)
    }
}

@MainActor
private final class HQAppStoreUpdaterDriverSpy: HQUpdaterDriving {
    var canCheckForUpdates = true
    var eventHandler: ((HQUpdaterDriverEvent) -> Void)?
    var startError: Error?
    private(set) var startCallCount = 0
    private(set) var startedFeedURL: URL?
    private(set) var startedPolicy: HQUpdateSchedulingPolicy?

    func start(
        feedURL: URL,
        policy: HQUpdateSchedulingPolicy
    ) throws {
        startCallCount += 1
        startedFeedURL = feedURL
        startedPolicy = policy
        if let startError {
            throw startError
        }
    }

    func checkForUpdates() {}

    func presentAvailableUpdate() {}
}

@MainActor
private final class HQRouteNotificationCenterSpy:
    HQUserNotificationCenterDriving
{
    private(set) var addedRequests: [UNNotificationRequest] = []

    func requestAuthorization(
        options _: UNAuthorizationOptions
    ) async throws -> Bool {
        true
    }

    func add(_ request: UNNotificationRequest) async throws {
        addedRequests.append(request)
    }

    func install(delegate _: UNUserNotificationCenterDelegate) {}

    func setNotificationCategories(
        _: Set<UNNotificationCategory>
    ) {}
}

@MainActor
private final class HQGatedNotificationCenterSpy:
    HQUserNotificationCenterDriving
{
    let addGate: HQTestRequestGate
    private(set) var addedRequests: [UNNotificationRequest] = []
    private(set) var addCompletions = 0
    private(set) var deliveredRemovalCount = 0
    private(set) var pendingRemovalCount = 0

    init(addGate: HQTestRequestGate) {
        self.addGate = addGate
    }

    func requestAuthorization(
        options _: UNAuthorizationOptions
    ) async throws -> Bool {
        true
    }

    func add(_ request: UNNotificationRequest) async throws {
        await addGate.wait()
        addedRequests.append(request)
        addCompletions += 1
    }

    func install(delegate _: UNUserNotificationCenterDelegate) {}

    func setNotificationCategories(
        _: Set<UNNotificationCategory>
    ) {}

    func removeAllDeliveredNotifications() {
        deliveredRemovalCount += 1
        addedRequests.removeAll()
    }

    func removeAllPendingNotificationRequests() {
        pendingRemovalCount += 1
        addedRequests.removeAll()
    }

    func removeDeliveredNotifications(
        withIdentifiers identifiers: [String]
    ) {
        deliveredRemovalCount += 1
        let identifiers = Set(identifiers)
        addedRequests.removeAll {
            identifiers.contains($0.identifier)
        }
    }

    func removePendingNotificationRequests(
        withIdentifiers identifiers: [String]
    ) {
        pendingRemovalCount += 1
        let identifiers = Set(identifiers)
        addedRequests.removeAll {
            identifiers.contains($0.identifier)
        }
    }
}

@MainActor
private final class HQQueuedFanOutAppEngine: HQAppEngine {
    nonisolated let events: AsyncStream<HQEngineEvent> = AsyncStream {
        $0.finish()
    }

    private let responses: [String: HQJSONValue]
    private let advertisedCapabilities: Set<String>
    private let gate = HQTestRequestGate()
    private var requests: [(method: String, params: HQJSONValue)] = []
    private var armedMethods: Set<String> = []
    private var didGateProtectedRequest = false
    private var onFirstProtectedRequestPending: (() -> Void)?

    init(
        responses: [String: HQJSONValue],
        advertisedCapabilities: Set<String>
    ) {
        self.responses = responses
        self.advertisedCapabilities = advertisedCapabilities
    }

    func start() async throws -> HQJSONValue {
        .object([
            "capabilities": .array(
                advertisedCapabilities.sorted().map(HQJSONValue.string)
            ),
        ])
    }

    func request(
        _ method: String,
        params: HQJSONValue
    ) async throws -> HQJSONValue {
        requests.append((method, params))
        guard let response = responses[method] else {
            throw HQEngineErrorPayload(
                code: "capability_not_implemented",
                message: "\(method) unavailable in queued fan-out engine",
                retryable: false
            )
        }
        if !didGateProtectedRequest, armedMethods.contains(method) {
            didGateProtectedRequest = true
            onFirstProtectedRequestPending?()
            await gate.wait()
        }
        return response
    }

    func stop() async {}

    func armProtectedFanOut(
        methods: Set<String>,
        onFirstPending: @escaping () -> Void
    ) {
        armedMethods = methods
        onFirstProtectedRequestPending = onFirstPending
    }

    func gatedArrivalCount() async -> Int {
        await gate.arrivalCount()
    }

    func releaseGatedRequest() async {
        await gate.releaseNext()
    }

    func requestedMethods() -> [String] {
        requests.map(\.method)
    }
}

private actor HQTestRequestGate {
    private var arrivals = 0
    private var continuations: [CheckedContinuation<Void, Never>] = []

    func wait() async {
        arrivals += 1
        await withCheckedContinuation { continuation in
            continuations.append(continuation)
        }
    }

    func arrivalCount() -> Int {
        arrivals
    }

    func releaseNext() {
        guard !continuations.isEmpty else { return }
        continuations.removeFirst().resume()
    }
}

private struct HQTestEngineRequestStub: Sendable {
    let method: String
    let params: HQJSONValue?
    let occurrence: Int?
    let response: HQJSONValue
    let errorMessage: String?
    let gate: HQTestRequestGate?

    init(
        method: String,
        params: HQJSONValue? = nil,
        occurrence: Int? = nil,
        response: HQJSONValue = .null,
        errorMessage: String? = nil,
        gate: HQTestRequestGate? = nil
    ) {
        self.method = method
        self.params = params
        self.occurrence = occurrence
        self.response = response
        self.errorMessage = errorMessage
        self.gate = gate
    }

    func matches(
        method requestedMethod: String,
        params requestedParams: HQJSONValue,
        occurrence requestedOccurrence: Int
    ) -> Bool {
        method == requestedMethod
            && (params == nil || params == requestedParams)
            && (occurrence == nil || occurrence == requestedOccurrence)
    }
}

private actor HQRecordingAppEngine: HQAppEngine {
    nonisolated let events: AsyncStream<HQEngineEvent>
    nonisolated let lifecycleEvents: AsyncStream<HQAppEngineLifecycleEvent>
    private let responses: [String: HQJSONValue]
    private let delayedMethods: Set<String>
    private let nonresponsiveMethods: Set<String>
    private let advertisedCapabilities: Set<String>?
    private let channelResponses: [String: HQJSONValue]
    private let channelDelays: [String: UInt64]
    private let requestStubs: [HQTestEngineRequestStub]
    private let stopGate: HQTestRequestGate?
    private var methods: [String] = []
    private var completedMethods: [String] = []
    private var requests: [(method: String, params: HQJSONValue)] = []
    private var timeoutRequests: [
        (method: String, timeoutNanoseconds: UInt64?)
    ] = []
    private var stopCalls = 0
    private var stopStarts = 0
    private var startCalls = 0
    private let eventContinuation:
        AsyncStream<HQEngineEvent>.Continuation
    private let lifecycleContinuation:
        AsyncStream<HQAppEngineLifecycleEvent>.Continuation

    init(
        responses: [String: HQJSONValue],
        delayedMethods: Set<String> = [],
        nonresponsiveMethods: Set<String> = [],
        advertisedCapabilities: Set<String>? = nil,
        channelResponses: [String: HQJSONValue] = [:],
        channelDelays: [String: UInt64] = [:],
        requestStubs: [HQTestEngineRequestStub] = [],
        stopGate: HQTestRequestGate? = nil
    ) {
        self.responses = responses
        self.delayedMethods = delayedMethods
        self.nonresponsiveMethods = nonresponsiveMethods
        self.advertisedCapabilities = advertisedCapabilities
        self.channelResponses = channelResponses
        self.channelDelays = channelDelays
        self.requestStubs = requestStubs
        self.stopGate = stopGate
        var capturedEvents: AsyncStream<HQEngineEvent>.Continuation?
        events = AsyncStream { capturedEvents = $0 }
        eventContinuation = capturedEvents!
        var capturedLifecycle:
            AsyncStream<HQAppEngineLifecycleEvent>.Continuation?
        lifecycleEvents = AsyncStream { capturedLifecycle = $0 }
        lifecycleContinuation = capturedLifecycle!
    }

    func start() async throws -> HQJSONValue {
        startCalls += 1
        let capabilities = advertisedCapabilities ?? [
            "config.get",
            "auth.state",
            "workspaces.list",
            "sync.status",
            "projects.list",
            "sessions.list",
            "shutdown",
            "set_local_project_status",
            "set_local_story_passes",
        ]
        return .object([
            "capabilities": .array(
                capabilities.sorted().map(HQJSONValue.string)
            ),
        ])
    }

    func request(
        _ method: String,
        params: HQJSONValue
    ) async throws -> HQJSONValue {
        methods.append(method)
        requests.append((method, params))
        let occurrence = methods.lazy.filter { $0 == method }.count
        defer {
            completedMethods.append(method)
        }
        if let stub = requestStubs.first(where: {
            $0.matches(
                method: method,
                params: params,
                occurrence: occurrence
            )
        }) {
            if let gate = stub.gate {
                await gate.wait()
            }
            if let errorMessage = stub.errorMessage {
                throw HQEngineErrorPayload(
                    code: "test_request_failed",
                    message: errorMessage,
                    retryable: false
                )
            }
            return stub.response
        }
        if method == "fetch_channel",
           let channelID = params.object?["channelId"]?.stringValue
        {
            if let delay = channelDelays[channelID] {
                try? await Task.sleep(nanoseconds: delay)
            }
            if let response = channelResponses[channelID] {
                return response
            }
        }
        if delayedMethods.contains(method) {
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        if method == "shutdown" {
            return .object(["accepted": .bool(true)])
        }
        guard let response = responses[method] else {
            throw HQEngineErrorPayload(
                code: "capability_not_implemented",
                message: "\(method) unavailable in test engine",
                retryable: false
            )
        }
        return response
    }

    func request(
        _ method: String,
        params: HQJSONValue,
        timeoutNanoseconds: UInt64?
    ) async throws -> HQJSONValue {
        timeoutRequests.append((method, timeoutNanoseconds))
        if nonresponsiveMethods.contains(method),
           let timeoutNanoseconds
        {
            try await Task.sleep(nanoseconds: timeoutNanoseconds)
            throw HQEngineClientError.requestTimedOut(method)
        }
        return try await request(method, params: params)
    }

    func stop() async {
        stopStarts += 1
        if let stopGate {
            await stopGate.wait()
        }
        stopCalls += 1
        eventContinuation.finish()
        lifecycleContinuation.yield(.stopped)
        lifecycleContinuation.finish()
    }

    func emitEvent(_ event: HQEngineEvent) {
        eventContinuation.yield(event)
    }

    func failLifecycle(_ message: String) {
        lifecycleContinuation.yield(.failed(message))
        lifecycleContinuation.finish()
    }

    func requestedMethods() -> [String] {
        methods
    }

    func completedRequestCount(for method: String) -> Int {
        completedMethods.lazy.filter { $0 == method }.count
    }

    func requestedParams(for method: String) -> [HQJSONValue] {
        requests.compactMap { request in
            request.method == method ? request.params : nil
        }
    }

    func stopCallCount() -> Int {
        stopCalls
    }

    func stopStartCount() -> Int {
        stopStarts
    }

    func startCallCount() -> Int {
        startCalls
    }

    func requestTimeouts(for method: String) -> [UInt64] {
        timeoutRequests.compactMap { request in
            request.method == method ? request.timeoutNanoseconds : nil
        }
    }
}
