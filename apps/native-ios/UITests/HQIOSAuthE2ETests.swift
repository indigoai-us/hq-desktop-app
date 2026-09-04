import XCTest

@MainActor
final class HQIOSAuthHarnessUITests: XCTestCase {
    private func launch(scenario: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-ApplePersistenceIgnoreState", "YES", "--hq-auth-harness"]
        app.launchEnvironment = ["HQIOS_TEST_HARNESS": "1", "HQIOS_AUTH_HARNESS_SCENARIO": scenario]
        app.launch()
        XCTAssertTrue(app.descendants(matching: .any)["hq.screen.auth-harness.ready"].waitForExistence(timeout: 10))
        return app
    }

    func testHarnessRecoverableOfflineCopyAndRetryInteraction() {
        let app = launch(scenario: "recoverable")
        let status = app.staticTexts["hq.auth.harness.status"]
        XCTAssertEqual(status.label, "Secure sign-in could not connect. No credentials were stored.")
        app.buttons["hq.auth.harness.retry"].tap()
        XCTAssertEqual(status.label, "Ready to retry secure sign-in.")
    }

    func testHarnessSignedInCopyAndLocalSignOutInteraction() {
        let app = launch(scenario: "signed-in")
        app.buttons["hq.auth.harness.sign-out"].tap()
        XCTAssertTrue(app.buttons["hq.auth.harness.retry"].waitForExistence(timeout: 3))
        XCTAssertEqual(app.staticTexts["hq.auth.harness.status"].label, "Signed out securely on this device.")
    }
}
