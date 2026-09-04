import UIKit
import XCTest

@MainActor
final class HQIOSNavigationUITests: XCTestCase {
    private struct RouteExpectation {
        let route: String
        let readiness: String
        let tab: String
    }

    private var isPad: Bool { UIDevice.current.userInterfaceIdiom == .pad }

    private func application(ignorePersistence: Bool = true, resetNavigation: Bool = false) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--hq-test-harness", "--hq-navigation-harness"]
        if ignorePersistence {
            app.launchArguments += ["-ApplePersistenceIgnoreState", "YES"]
        }
        if ignorePersistence || resetNavigation {
            app.launchArguments.append("--hq-navigation-reset")
        }
        app.launchEnvironment = ["HQIOS_TEST_HARNESS": "1", "HQIOS_SHELL_STATE": "content"]
        return app
    }

    @discardableResult
    private func launch(ignorePersistence: Bool = true, resetNavigation: Bool = false) -> XCUIApplication {
        let app = application(ignorePersistence: ignorePersistence, resetNavigation: resetNavigation)
        app.launch()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 10))
        XCTAssertTrue(app.descendants(matching: .any)["window.main"].waitForExistence(timeout: 10))
        return app
    }

    private func open(_ route: String, in app: XCUIApplication) {
        let url = URL(string: "hqmobile://route/\(route)")!
        XCUIDevice.shared.system.open(url)
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 10), route)
    }

    private func coldOpen(_ route: String, in app: XCUIApplication) {
        app.open(URL(string: "hqmobile://route/\(route)")!)
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 10), route)
    }

    private func assertRoute(_ expected: RouteExpectation, in app: XCUIApplication) {
        let destination = app.descendants(matching: .any)[expected.readiness]
        XCTAssertTrue(destination.waitForExistence(timeout: 10), expected.route)
        XCTAssertEqual(destination.value as? String, expected.route, expected.route)

        if isPad {
            let container = app.buttons["hq.sidebar.container.\(expected.tab)"]
            XCTAssertTrue(container.waitForExistence(timeout: 5), expected.route)
            XCTAssertTrue(container.isSelected, expected.route)
            XCTAssertTrue(app.descendants(matching: .any)["hq.shell.pad.ready"].exists, expected.route)
        } else {
            let container = app.tabBars.buttons[expected.tab.capitalized]
            XCTAssertTrue(container.waitForExistence(timeout: 5), expected.route)
            XCTAssertTrue(container.isSelected, expected.route)
            XCTAssertTrue(app.descendants(matching: .any)["hq.shell.phone.ready"].exists, expected.route)
        }
    }

    func testCanonicalRoutesBatchOneUsesActualWarmLinksAndExactContainers() {
        let routes = canonicalRoutes()
        XCTAssertEqual(routes.count, 30)
        assertRoutes(Array(routes[0 ..< 10]))
    }

    func testCanonicalRoutesBatchTwoUsesActualWarmLinksAndExactContainers() {
        let routes = canonicalRoutes()
        XCTAssertEqual(routes.count, 30)
        assertRoutes(Array(routes[10 ..< 20]))
    }

    func testCanonicalRoutesBatchThreeUsesActualWarmLinksAndExactContainers() {
        let routes = canonicalRoutes()
        XCTAssertEqual(routes.count, 30)
        assertRoutes(Array(routes[20 ..< 30]))
    }

    private func assertRoutes(_ routes: [RouteExpectation]) {
        let app = launch()
        for expected in routes {
            open(expected.route, in: app)
            assertRoute(expected, in: app)
        }
    }

    func testEncodedDynamicIdentitiesRemainExactAcrossActualDeepLinks() {
        let routes = [
            RouteExpectation(route: "company:Indigo%20%26%20Caf%C3%A9%2F%25%3AHQ:knowledge", readiness: "screen.company.knowledge", tab: "work"),
            RouteExpectation(route: "files:R%26D%20%2F%20HQ:knowledge%2F%F0%9F%8C%8E%3A100%25%2Emd", readiness: "screen.files", tab: "more"),
            RouteExpectation(route: "project:indigo:ios%252Fapp", readiness: "screen.project", tab: "work"),
            RouteExpectation(route: "task:indigo:ios%2Fapp:NATIVE%3A003", readiness: "screen.task", tab: "work"),
        ]
        let app = launch()

        for expected in routes {
            open(expected.route, in: app)
            assertRoute(expected, in: app)
        }
    }

    func testColdDeepLinkSurvivesSceneRestorationOrdering() {
        let expected = RouteExpectation(
            route: "task:indigo%20labs:ios%2Fapp:NATIVE%3A007",
            readiness: "screen.task",
            tab: "work"
        )
        let app = application()
        app.launch()
        XCTAssertTrue(app.descendants(matching: .any)["window.main"].waitForExistence(timeout: 10))
        app.terminate()

        coldOpen(expected.route, in: app)
        assertRoute(expected, in: app)
    }

    func testSystemBackPopsTheSharedTypedHistory() throws {
        let app = launchHistory()
        let back = app.navigationBars.buttons
            .matching(NSPredicate(format: "label == %@", "indigo · ios"))
            .firstMatch
        XCTAssertTrue(back.waitForExistence(timeout: 5))
        back.tap()
        assertProjectHistory(in: app)
    }

    func testEdgeSwipeBackPopsTheSharedTypedHistory() throws {
        guard !isPad else { throw XCTSkip("The iPad split view uses column navigation instead of phone edge swipe.") }
        let app = launchHistory()
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.01, dy: 0.5))
            .press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.5)))
        assertProjectHistory(in: app)
    }

    func testHardwareKeyboardBackPopsTheSharedTypedHistory() throws {
        guard isPad else { throw XCTSkip("App-level hardware keyboard commands are exercised on the iPad shell.") }
        let app = launchHistory()
        let responder = app.descendants(matching: .any)["hq.navigation.key-command-responder"]
        XCTAssertTrue(responder.waitForExistence(timeout: 5))
        XCTAssertTrue(waitForValueContaining("first:true", on: responder))
        responder.typeKey(.leftArrow, modifierFlags: .command)
        assertProjectHistory(in: app)
    }

    func testPadInspectorIsOptionalAndTracksTheExactTypedRoute() throws {
        guard isPad else { throw XCTSkip("The optional inspector belongs to the iPad split-view shell.") }
        let app = launch()
        let inspector = app.descendants(matching: .any)["hq.shell.inspector.ready"]
        XCTAssertFalse(inspector.exists)

        let button = app.buttons["screen.home.inspector"]
        XCTAssertTrue(button.waitForExistence(timeout: 5))
        button.tap()
        XCTAssertTrue(inspector.waitForExistence(timeout: 5))
        XCTAssertEqual(inspector.value as? String, "home")

        app.buttons["Close inspector"].tap()
        XCTAssertFalse(inspector.waitForExistence(timeout: 1))
        assertRoute(RouteExpectation(route: "home", readiness: "screen.home", tab: "home"), in: app)
    }

    func testScrollContextSurvivesTabSwitchAndPadRotation() {
        let app = launch()
        let home = RouteExpectation(route: "home", readiness: "screen.home", tab: "home")
        assertRoute(home, in: app)
        let anchor = app.descendants(matching: .any)["screen.home.scroll-anchor"]
        XCTAssertTrue(anchor.waitForExistence(timeout: 5))
        app.swipeUp()
        let moved = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value != 'overview'"), object: anchor)
        XCTAssertEqual(XCTWaiter.wait(for: [moved], timeout: 5), .completed)
        let retainedAnchor = anchor.value as? String

        open("inbox", in: app)
        assertRoute(RouteExpectation(route: "inbox", readiness: "screen.inbox", tab: "inbox"), in: app)
        open("home", in: app)
        assertRoute(home, in: app)
        XCTAssertTrue(waitForValue(retainedAnchor, on: anchor))

        guard isPad else { return }
        XCUIDevice.shared.orientation = .portrait
        XCTAssertTrue(app.descendants(matching: .any)["hq.shell.pad.ready"].waitForExistence(timeout: 10))
        assertRoute(home, in: app)
        XCTAssertTrue(waitForValue(retainedAnchor, on: anchor))
        XCUIDevice.shared.orientation = .landscapeLeft
    }

    func testPadColumnCollapseAndExpansionPreserveRouteAndScrollContext() throws {
        guard isPad else { throw XCTSkip("Column collapse is specific to the iPad split-view shell.") }
        let app = launch()
        let expected = RouteExpectation(route: "project:indigo:ios", readiness: "screen.project", tab: "work")
        open(expected.route, in: app)
        assertRoute(expected, in: app)

        let anchor = app.descendants(matching: .any)["screen.project.scroll-anchor"]
        XCTAssertTrue(anchor.waitForExistence(timeout: 5))
        app.swipeUp()
        let moved = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value != 'overview'"), object: anchor)
        XCTAssertEqual(XCTWaiter.wait(for: [moved], timeout: 5), .completed)
        let retainedAnchor = anchor.value as? String

        let hideSidebar = app.buttons["Hide Sidebar"]
        XCTAssertTrue(hideSidebar.waitForExistence(timeout: 5))
        hideSidebar.tap()
        XCTAssertTrue(waitForValue(retainedAnchor, on: anchor))
        XCTAssertEqual(app.descendants(matching: .any)[expected.readiness].value as? String, expected.route)

        let showSidebar = app.buttons["Show Sidebar"]
        XCTAssertTrue(showSidebar.waitForExistence(timeout: 5))
        showSidebar.tap()
        assertRoute(expected, in: app)
        XCTAssertTrue(waitForValue(retainedAnchor, on: anchor))
    }

    func testNavigationRelaunchRestoresRouteAndRealScrollAnchorWithoutIgnoringPersistence() {
        var app = launch(ignorePersistence: false, resetNavigation: true)
        let expected = RouteExpectation(route: "project:indigo:ios", readiness: "screen.project", tab: "work")
        open(expected.route, in: app)
        assertRoute(expected, in: app)
        let anchor = app.descendants(matching: .any)["screen.project.scroll-anchor"]
        app.swipeUp()
        let moved = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value != 'overview'"), object: anchor)
        XCTAssertEqual(XCTWaiter.wait(for: [moved], timeout: 5), .completed)
        let retainedAnchor = anchor.value as? String
        let persistence = app.descendants(matching: .any)["hq.navigation.persisted-snapshot"]
        XCTAssertTrue(persistence.waitForExistence(timeout: 5))
        let persistedSnapshot = persistence.value as? String
        XCTAssertFalse(persistedSnapshot?.isEmpty ?? true)
        let sceneID = app.descendants(matching: .any)["hq.navigation.scene-id"].value as? String
        XCUIDevice.shared.press(.home)
        XCTAssertTrue(app.wait(for: .runningBackground, timeout: 10))
        app.terminate()

        app = application(ignorePersistence: false)
        app.launch()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 10))
        XCTAssertEqual(
            decodedSnapshot(app.descendants(matching: .any)["hq.navigation.persisted-snapshot"].value as? String),
            decodedSnapshot(persistedSnapshot)
        )
        XCTAssertEqual(app.descendants(matching: .any)["hq.navigation.scene-id"].value as? String, sceneID)
        assertRoute(expected, in: app)
        XCTAssertTrue(waitForValue(retainedAnchor, on: app.descendants(matching: .any)["screen.project.scroll-anchor"]))
    }

    func testProductionShellConditionsExposeWindowAndStateReadiness() {
        let states: [(String, String, String)] = [
            ("onboarding", "window.onboarding", "window.onboarding.state.content"),
            ("signIn", "window.sign-in", "window.sign-in.state.content"),
            ("loading", "window.main", "window.main.state.loading"),
            ("offline", "window.main", "window.main.state.error"),
            ("accessDenied", "window.main", "window.main.state.error"),
            ("capabilityUnavailable", "window.main", "window.main.state.unavailable"),
        ]

        for (state, root, readiness) in states {
            let app = application()
            app.launchEnvironment["HQIOS_SHELL_STATE"] = state
            app.launch()
            XCTAssertTrue(app.descendants(matching: .any)[root].waitForExistence(timeout: 10), state)
            XCTAssertTrue(app.descendants(matching: .any)[readiness].exists, state)
            XCTAssertTrue(app.descendants(matching: .any)["hq.condition.\(state)"].exists, state)
            app.terminate()
        }
    }

    private func launchHistory() -> XCUIApplication {
        let app = launch()
        open("project:indigo:ios", in: app)
        assertRoute(RouteExpectation(route: "project:indigo:ios", readiness: "screen.project", tab: "work"), in: app)
        open("task:indigo:ios:US%2D007", in: app)
        assertRoute(RouteExpectation(route: "task:indigo:ios:US%2D007", readiness: "screen.task", tab: "work"), in: app)
        return app
    }

    private func assertProjectHistory(in app: XCUIApplication) {
        assertRoute(RouteExpectation(route: "project:indigo:ios", readiness: "screen.project", tab: "work"), in: app)
    }

    private func waitForValue(_ value: String?, on element: XCUIElement, timeout: TimeInterval = 5) -> Bool {
        guard let value else { return false }
        let expectation = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "value == %@", value),
            object: element
        )
        return XCTWaiter.wait(for: [expectation], timeout: timeout) == .completed
    }

    private func waitForValueContaining(_ fragment: String, on element: XCUIElement, timeout: TimeInterval = 5) -> Bool {
        let expectation = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "value CONTAINS %@", fragment),
            object: element
        )
        return XCTWaiter.wait(for: [expectation], timeout: timeout) == .completed
    }

    private func decodedSnapshot(_ encoded: String?) -> NSDictionary? {
        guard let encoded,
              let data = Data(base64Encoded: encoded),
              let object = try? JSONSerialization.jsonObject(with: data) as? NSDictionary
        else { return nil }
        return object
    }

    private func canonicalRoutes() -> [RouteExpectation] {
        [
            .init(route: "home", readiness: "screen.home", tab: "home"),
            .init(route: "mission-control", readiness: "screen.mission-control", tab: "work"),
            .init(route: "inbox", readiness: "screen.inbox", tab: "inbox"),
            .init(route: "meetings", readiness: "screen.meetings", tab: "meetings"),
            .init(route: "marketplace", readiness: "screen.marketplace", tab: "more"),
            .init(route: "moderation", readiness: "screen.moderation", tab: "more"),
            .init(route: "library:skills", readiness: "screen.library.skills", tab: "more"),
            .init(route: "library:workers", readiness: "screen.library.workers", tab: "more"),
            .init(route: "library:installed", readiness: "screen.library.installed", tab: "more"),
            .init(route: "library:profile", readiness: "screen.library.profile", tab: "more"),
            .init(route: "files", readiness: "screen.files", tab: "more"),
            .init(route: "settings:sync", readiness: "screen.settings.sync", tab: "more"),
            .init(route: "settings:notifications", readiness: "screen.settings.notifications", tab: "more"),
            .init(route: "settings:widget", readiness: "screen.settings.widget", tab: "more"),
            .init(route: "settings:updates", readiness: "screen.settings.updates", tab: "more"),
            .init(route: "settings:general", readiness: "screen.settings.general", tab: "more"),
            .init(route: "settings:meetings", readiness: "screen.settings.meetings", tab: "more"),
            .init(route: "company:indigo:overview", readiness: "screen.company.overview", tab: "work"),
            .init(route: "company:indigo:goals", readiness: "screen.company.goals", tab: "work"),
            .init(route: "company:indigo:projects", readiness: "screen.company.projects", tab: "work"),
            .init(route: "company:indigo:skills", readiness: "screen.company.skills", tab: "work"),
            .init(route: "company:indigo:workers", readiness: "screen.company.workers", tab: "work"),
            .init(route: "company:indigo:knowledge", readiness: "screen.company.knowledge", tab: "work"),
            .init(route: "company:indigo:team", readiness: "screen.company.team", tab: "work"),
            .init(route: "company:indigo:activity", readiness: "screen.company.activity", tab: "work"),
            .init(route: "company:indigo:deployments", readiness: "screen.company.deployments", tab: "work"),
            .init(route: "company:indigo:secrets", readiness: "screen.company.secrets", tab: "work"),
            .init(route: "company:indigo:settings", readiness: "screen.company.settings", tab: "work"),
            .init(route: "project:indigo:ios", readiness: "screen.project", tab: "work"),
            .init(route: "task:indigo:ios:US%2D007", readiness: "screen.task", tab: "work"),
        ]
    }
}
