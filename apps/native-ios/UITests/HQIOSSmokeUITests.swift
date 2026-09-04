import XCTest

@MainActor
final class HQIOSSmokeUITests: XCTestCase {
    private func launch(arguments: [String] = [], environment: [String: String] = [:]) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-ApplePersistenceIgnoreState", "YES"] + arguments
        app.launchEnvironment = environment.merging(["HQIOS_TEST_HARNESS": "1"]) { _, testMarker in testMarker }
        app.launch()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 10), "HQIOS did not reach the foreground")
        return app
    }

    private func assertReady(_ identifier: String, in app: XCUIApplication) {
        let ready = app.descendants(matching: .any)[identifier]
        XCTAssertTrue(ready.waitForExistence(timeout: 10), "Missing readiness identifier: \(identifier)")
        // Capture the physical simulator screen only after the app is known to
        // be foregrounded and its readiness element exists. XCUIApplication's
        // cropped application-frame capture can omit content on some runtimes.
        let screenshot = XCUIScreen.main.screenshot()
        XCTAssertGreaterThan(screenshot.pngRepresentation.count, 1_024, "Smoke screenshot was unexpectedly blank")
        let attachment = XCTAttachment(screenshot: screenshot)
        attachment.name = identifier
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    func testSignedOutLaunchPublishesStableReadiness() {
        let app = launch()
        assertReady("hq.screen.signed-out.ready", in: app)
    }

    func testHarnessLaunchPublishesStableReadiness() {
        let app = launch(arguments: ["--hq-test-harness"])
        assertReady("hq.screen.test-harness.ready", in: app)
    }

    func testFixtureVisualTourIsLimitedToTheXCTestHarness() {
        let app = launch(
            arguments: ["--hq-test-harness"],
            environment: ["HQIOS_USE_FIXTURES": "1"]
        )
        assertReady("hq.screen.fixture-tour.ready", in: app)
    }

    func testFixtureLeakIsBlockedBeforeAnyProductionSurfaceRenders() {
        let app = launch(environment: ["HQIOS_USE_FIXTURES": "1"])
        assertReady("hq.screen.fixture-leak-blocked.ready", in: app)
        XCTAssertFalse(app.descendants(matching: .any)["hq.screen.fixture-tour.ready"].exists)
    }
}
