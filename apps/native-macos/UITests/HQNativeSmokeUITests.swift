import XCTest

@MainActor
final class HQNativeSmokeUITests: XCTestCase {
    private func element(_ root: XCUIElement, identifiedBy identifier: String) -> XCUIElement {
        root.descendants(matching: .any)[identifier]
    }

    private func launch(
        route: String? = nil,
        scene: String? = nil,
        nativeCommands: [String] = []
    ) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = [
            "-ApplePersistenceIgnoreState",
            "YES",
            "-NSTreatUnknownArgumentsAsOpen",
            "NO",
            "--ui-testing",
        ]
        if let route {
            app.launchArguments += ["--route", route]
        }
        if let scene {
            app.launchArguments += ["--hq-scene", scene]
        }
        for command in nativeCommands {
            app.launchArguments += ["--native-command", command]
        }
        app.launch()
        app.activate()
        XCTAssertTrue(
            app.wait(for: .runningForeground, timeout: 5),
            "HQ did not become the foreground app after launch."
        )
        return app
    }

    private func launchVisual(scene: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = [
            "-ApplePersistenceIgnoreState",
            "YES",
            "-NSTreatUnknownArgumentsAsOpen",
            "NO",
            "--visual-tour",
            "--visual-variant",
            "light",
            "--hq-scene",
            scene,
        ]
        app.launch()
        app.activate()
        XCTAssertTrue(
            app.wait(for: .runningForeground, timeout: 5),
            "HQ did not become the foreground app after visual launch."
        )
        return app
    }

    private func waitForSelected(
        _ element: XCUIElement,
        timeout: TimeInterval = 5
    ) -> Bool {
        let predicate = NSPredicate(
            format: "value == %@",
            "Selected"
        )
        return XCTWaiter.wait(
            for: [
                XCTNSPredicateExpectation(
                    predicate: predicate,
                    object: element
                ),
            ],
            timeout: timeout
        ) == .completed
    }

    private func waitForNonExistence(
        _ element: XCUIElement,
        timeout: TimeInterval = 5
    ) -> Bool {
        XCTWaiter.wait(
            for: [
                XCTNSPredicateExpectation(
                    predicate: NSPredicate(format: "exists == false"),
                    object: element
                ),
            ],
            timeout: timeout
        ) == .completed
    }

    func testMainWindowLaunchesWithNativeNavigationShell() {
        let app = launch()
        XCTAssertTrue(app.windows["HQ"].waitForExistence(timeout: 5))
        XCTAssertTrue(element(app, identifiedBy: "shell.sidebar").waitForExistence(timeout: 5))

        for identifier in [
            "sidebar.home",
            "sidebar.mission-control",
            "sidebar.inbox",
            "sidebar.meetings",
            "sidebar.marketplace",
            "sidebar.library",
            "sidebar.files",
            "sidebar.company.indigo",
            "sidebar.settings",
        ] {
            XCTAssertTrue(
                element(app, identifiedBy: identifier).exists,
                "Missing required native navigation item \(identifier)"
            )
        }
        XCTAssertTrue(element(app, identifiedBy: "screen.home").exists)
    }

    func testEveryDeepRouteRendersItsCompleteNativeSurface() {
        let routes = [
            ("mission-control", "screen.mission-control"),
            ("inbox", "screen.inbox"),
            ("meetings", "screen.meetings"),
            ("marketplace", "screen.marketplace"),
            ("moderation", "screen.moderation"),
            ("library:skills", "screen.library.skills"),
            ("library:workers", "screen.library.workers"),
            ("library:installed", "screen.library.installed"),
            ("library:profile", "screen.library.profile"),
            ("files:indigo:knowledge/briefs/positioning.md", "screen.files"),
            ("company:indigo:overview", "screen.company.overview"),
            ("company:indigo:goals", "screen.company.goals"),
            ("company:indigo:projects", "screen.company.projects"),
            ("company:indigo:skills", "screen.company.skills"),
            ("company:indigo:workers", "screen.company.workers"),
            ("company:indigo:knowledge", "screen.company.knowledge"),
            ("company:indigo:team", "screen.company.team"),
            ("company:indigo:activity", "screen.company.activity"),
            ("company:indigo:deployments", "screen.company.deployments"),
            ("company:indigo:secrets", "screen.company.secrets"),
            ("company:indigo:settings", "screen.company.settings"),
            ("settings:sync", "screen.settings.sync"),
            ("settings:notifications", "screen.settings.notifications"),
            ("settings:widget", "screen.settings.widget"),
            ("settings:updates", "screen.settings.updates"),
            ("settings:general", "screen.settings.general"),
            ("settings:meetings", "screen.settings.meetings"),
            ("project:indigo:native-macos", "screen.project"),
            ("task:indigo:native-macos:NATIVE-004", "screen.task"),
        ]

        for (route, identifier) in routes {
            let app = launch(route: route)
            XCTAssertTrue(
                element(app, identifiedBy: identifier).waitForExistence(timeout: 5),
                "Route \(route) did not render \(identifier)"
            )
            app.terminate()
        }
    }

    func testEverySecondarySceneRendersFromExplicitTestingDeepLink() {
        let sceneIDs = [
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

        for sceneID in sceneIDs {
            let app = ["banner", "widget"].contains(sceneID)
                ? launchVisual(scene: sceneID)
                : launch(scene: sceneID)
            let surfaceIdentifier: String
            switch sceneID {
            case "banner":
                surfaceIdentifier = "window.banner.direct-message"
            case "widget":
                surfaceIdentifier = "window.widget.expanded"
            default:
                surfaceIdentifier = "window.\(sceneID)"
            }
            XCTAssertTrue(
                element(app, identifiedBy: surfaceIdentifier)
                    .waitForExistence(timeout: 5),
                "Scene \(sceneID) did not render \(surfaceIdentifier)"
            )
            app.terminate()
        }
    }

    func testCompactGlassScenesUseTheirRegisteredWindowSizes() {
        let expectations: [
            (
                scene: String,
                title: String,
                readinessIdentifier: String,
                maximumWidth: CGFloat,
                maximumHeight: CGFloat
            )
        ] = [
            ("menubar", "HQ", "window.menubar", 340, 410),
            (
                "banner",
                "HQ Notification",
                "window.banner.direct-message",
                400,
                150
            ),
            ("widget", "HQ Widget", "window.widget.expanded", 380, 540),
        ]

        for expectation in expectations {
            let app = ["banner", "widget"].contains(expectation.scene)
                ? launchVisual(scene: expectation.scene)
                : launch(scene: expectation.scene)
            let readiness = element(
                app,
                identifiedBy: expectation.readinessIdentifier
            )
            XCTAssertTrue(readiness.waitForExistence(timeout: 5))
            XCTAssertLessThanOrEqual(
                readiness.frame.width,
                expectation.maximumWidth,
                "Scene \(expectation.scene) expanded beyond its compact width."
            )
            XCTAssertLessThanOrEqual(
                readiness.frame.height,
                expectation.maximumHeight,
                "Scene \(expectation.scene) expanded beyond its compact height."
            )
            app.terminate()
        }
    }

    func testRepresentativeSecondaryActionsPublishVisibleSuccessAndErrorStates() {
        let menuBar = launch(scene: "menubar")
        let syncButton = element(
            menuBar,
            identifiedBy: "window.menubar.action.sync-now"
        )
        XCTAssertTrue(syncButton.waitForExistence(timeout: 5))
        syncButton.click()
        XCTAssertTrue(
            element(menuBar, identifiedBy: "operation.error")
                .waitForExistence(timeout: 5)
        )
        menuBar.terminate()

        let onboarding = launch(scene: "onboarding")
        let continueButton = onboarding.windows["Set up HQ"]
            .descendants(matching: .any)[
                "window.onboarding.action.continue"
            ]
        XCTAssertTrue(continueButton.waitForExistence(timeout: 5))
        continueButton.click()
        XCTAssertTrue(
            onboarding.windows["Set up HQ"]
                .descendants(matching: .any)["operation.success"]
                .waitForExistence(timeout: 5)
        )
    }

    func testOpeningSingletonSceneTwiceProducesExactlyOneWindow() {
        let app = launch(
            nativeCommands: [
                "open_messages_window",
                "open_messages_window",
            ]
        )

        XCTAssertTrue(app.windows["Messages"].waitForExistence(timeout: 5))
        XCTAssertEqual(
            app.windows.matching(identifier: "Messages").count,
            1,
            "The singleton Messages scene must not duplicate"
        )
    }

    func testSidebarSelectionTraitsFollowEveryNavigationFamily() {
        let app = launch()
        let home = element(app, identifiedBy: "sidebar.home")
        let mission = element(
            app,
            identifiedBy: "sidebar.mission-control"
        )
        let library = element(app, identifiedBy: "sidebar.library")
        let settings = element(app, identifiedBy: "sidebar.settings")

        XCTAssertTrue(home.waitForExistence(timeout: 5))
        XCTAssertTrue(waitForSelected(home))

        mission.click()
        XCTAssertTrue(waitForSelected(mission))
        XCTAssertNotEqual(home.value as? String, "Selected")

        library.click()
        XCTAssertTrue(waitForSelected(library))
        XCTAssertNotEqual(mission.value as? String, "Selected")

        settings.click()
        XCTAssertTrue(waitForSelected(settings))
        XCTAssertNotEqual(library.value as? String, "Selected")
    }

    func testCommandPaletteSupportsFocusedKeyboardNavigationReturnAndEscape() {
        let app = launch()
        defer { app.terminate() }

        let toolbarButton = element(
            app,
            identifiedBy: "toolbar.command-palette"
        )
        XCTAssertTrue(toolbarButton.waitForExistence(timeout: 5))
        toolbarButton
            .coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
            .click()

        let palette = element(app, identifiedBy: "command-palette")
        let search = element(
            app,
            identifiedBy: "command-palette.search"
        )
        XCTAssertTrue(palette.waitForExistence(timeout: 5))
        XCTAssertTrue(search.waitForExistence(timeout: 5))

        search.typeText("Open")
        XCTAssertEqual(
            search.value as? String,
            "Open",
            "The palette search field must receive focus when presented."
        )

        let openInbox = element(
            app,
            identifiedBy: "command.open-inbox"
        )
        let openMeetings = element(
            app,
            identifiedBy: "command.open-meetings"
        )
        XCTAssertTrue(waitForSelected(openInbox))

        search.typeKey(
            XCUIKeyboardKey.downArrow.rawValue,
            modifierFlags: []
        )
        XCTAssertTrue(
            waitForSelected(openMeetings),
            "Down Arrow must advance the selected command."
        )

        search.typeKey(
            XCUIKeyboardKey.return.rawValue,
            modifierFlags: []
        )
        XCTAssertTrue(
            element(app, identifiedBy: "screen.meetings")
                .waitForExistence(timeout: 5),
            "Return must activate the selected command."
        )
        XCTAssertTrue(waitForNonExistence(palette))

        toolbarButton.click()
        XCTAssertTrue(palette.waitForExistence(timeout: 5))
        element(app, identifiedBy: "command-palette.search").typeKey(
            XCUIKeyboardKey.escape.rawValue,
            modifierFlags: []
        )
        XCTAssertTrue(
            waitForNonExistence(palette),
            "Escape must dismiss the command palette."
        )
        XCTAssertTrue(
            element(app, identifiedBy: "screen.meetings").exists,
            "Escape must not activate a command or change the current route."
        )
    }

    func testNormalLiveLaunchShowsNativeShellWithoutAutomaticUpdaterModal() {
        let app = XCUIApplication()
        app.launchArguments = [
            "-ApplePersistenceIgnoreState",
            "YES",
            "-NSTreatUnknownArgumentsAsOpen",
            "NO",
            "--live",
        ]
        app.launch()
        app.activate()
        XCTAssertTrue(
            app.wait(for: .runningForeground, timeout: 5),
            "HQ did not become the foreground app after live launch."
        )
        defer { app.terminate() }

        XCTAssertTrue(
            element(app, identifiedBy: "shell.root")
                .waitForExistence(timeout: 10),
            "The explicit live launch did not reach the native shell."
        )
        XCTAssertFalse(
            app.alerts.firstMatch.waitForExistence(timeout: 12),
            "Normal launch must not show an automatic Sparkle alert."
        )
        XCTAssertFalse(app.windows["Software Update"].exists)
        XCTAssertFalse(app.windows["Update Error"].exists)
    }

    func testTypedMenuBannerAndMeetingControlsReachVisibleNativeEffects() {
        let menuBar = launch(scene: "menubar")
        for identifier in [
            "window.menubar.action.sync-now",
            "window.menubar.action.open",
            "window.menubar.row.settings",
            "window.menubar.row.check-updates",
            "window.menubar.row.sign-out",
        ] {
            XCTAssertTrue(
                element(menuBar, identifiedBy: identifier)
                    .waitForExistence(timeout: 5),
                "Missing native menu-bar action \(identifier)"
            )
        }
        menuBar.terminate()

        let banner = launchVisual(scene: "banner")
        let bannerSurface = element(
            banner,
            identifiedBy: "window.banner.direct-message"
        )
        XCTAssertTrue(bannerSurface.waitForExistence(timeout: 5))
        let bannerAction = bannerSurface.descendants(matching: .any)[
            "banner.direct-message.action"
        ]
        XCTAssertTrue(bannerAction.waitForExistence(timeout: 5))
        bannerAction.click()
        XCTAssertTrue(
            banner.windows["Conversation"].waitForExistence(timeout: 5),
            "The typed direct-message banner action did not open its detail."
        )
        XCTAssertFalse(
            element(banner, identifiedBy: "window.banner.direct-message")
                .exists
        )
        banner.terminate()

        let meetings = launch(scene: "meetings")
        let meetingsWindow = meetings.windows["HQ Meetings"]
        let start = meetingsWindow.descendants(matching: .any)[
            "window.meetings.row.standup.action.start"
        ]
        XCTAssertTrue(
            meetingsWindow.descendants(matching: .any)[
                "window.meetings.row.standup.focused"
            ].waitForExistence(timeout: 5)
        )
        XCTAssertTrue(
            meetingsWindow.descendants(matching: .any)[
                "window.meetings.row.standup.company"
            ].exists
        )
        XCTAssertTrue(start.exists)
        start.click()
        XCTAssertTrue(
            meetingsWindow.descendants(matching: .any)["operation.error"]
                .waitForExistence(timeout: 5),
            "The fixture engine must visibly reject unavailable capture rather than no-op."
        )
    }

    func testMessagesSelectionChangesHeaderAndDisablesSendUntilLoaded() {
        let app = launchVisual(scene: "messages")
        defer { app.terminate() }

        let jacob = element(
            app,
            identifiedBy:
                "messages.sidebar.row.fetch_notification_history-visual-dm-jacob"
        )
        XCTAssertTrue(jacob.waitForExistence(timeout: 8))
        jacob.click()

        let title = element(
            app,
            identifiedBy: "messages.conversation.title"
        )
        XCTAssertTrue(title.waitForExistence(timeout: 5))
        XCTAssertEqual(
            title.value as? String,
            "Jacob",
            "The visible header must switch to the clicked recipient before composing."
        )
        XCTAssertTrue(
            element(
                app,
                identifiedBy:
                    "messages.conversation.message.live-target-person-person-jacob"
            ).waitForExistence(timeout: 5),
            "The visible body must be owned by the same selected recipient."
        )

        let composer = element(
            app,
            identifiedBy: "messages.composer"
        )
        XCTAssertTrue(composer.exists)
        composer.click()
        composer.typeText("Do not send to the previous recipient.")
        XCTAssertFalse(
            element(app, identifiedBy: "messages.action.send").isEnabled,
            "Send must stay disabled until the selected conversation is loaded."
        )
    }
}
