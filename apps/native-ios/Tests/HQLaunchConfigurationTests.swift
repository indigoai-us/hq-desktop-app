import XCTest
@testable import HQIOS

final class HQLaunchConfigurationTests: XCTestCase {
    func testBuiltApplicationRegistersTheMobileOAuthCallback() throws {
        let appBundle = try XCTUnwrap(Bundle(identifier: "com.hqforwork.mobile") ?? Bundle.main)
        XCTAssertEqual(appBundle.bundleIdentifier, "com.hqforwork.mobile")

        let urlTypes = try XCTUnwrap(appBundle.object(forInfoDictionaryKey: "CFBundleURLTypes") as? [[String: Any]])
        let schemes = urlTypes.flatMap { $0["CFBundleURLSchemes"] as? [String] ?? [] }
        XCTAssertTrue(schemes.contains("hqmobile"), "Built HQ app must register hqmobile:// callbacks")
        XCTAssertNotNil(
            appBundle.object(forInfoDictionaryKey: "UILaunchScreen") as? [String: Any],
            "Built HQ app must declare a launch screen so iPhone does not enter legacy letterbox mode"
        )
    }

    func testBuiltApplicationDeclaresAdaptivePhoneAndPadOrientations() throws {
        let appBundle = try XCTUnwrap(Bundle(identifier: "com.hqforwork.mobile") ?? Bundle.main)
        let infoData = try Data(contentsOf: appBundle.bundleURL.appending(path: "Info.plist"))
        let rawInfo = try XCTUnwrap(
            try PropertyListSerialization.propertyList(from: infoData, format: nil) as? [String: Any]
        )
        let phoneOrientations = try XCTUnwrap(
            rawInfo["UISupportedInterfaceOrientations"] as? [String]
        )
        let padOrientations = try XCTUnwrap(
            rawInfo["UISupportedInterfaceOrientations~ipad"] as? [String]
        )

        XCTAssertEqual(
            Set(phoneOrientations),
            Set([
                "UIInterfaceOrientationPortrait",
                "UIInterfaceOrientationLandscapeLeft",
                "UIInterfaceOrientationLandscapeRight",
            ])
        )
        XCTAssertEqual(
            Set(padOrientations),
            Set([
                "UIInterfaceOrientationPortrait",
                "UIInterfaceOrientationPortraitUpsideDown",
                "UIInterfaceOrientationLandscapeLeft",
                "UIInterfaceOrientationLandscapeRight",
            ])
        )
    }

    func testDefaultLaunchIsSignedOut() {
        XCTAssertEqual(HQLaunchConfiguration.resolve(arguments: [], environment: [:]).state, .signedOut)
    }

    func testFixtureFlagFailsClosedOutsideXCTestHarness() {
        let configuration = HQLaunchConfiguration.resolve(
            arguments: ["--hq-test-harness"],
            environment: ["HQIOS_USE_FIXTURES": "1"]
        )

        XCTAssertEqual(configuration.state, .fixtureLeakBlocked)
    }

    func testFixtureTourRequiresBothHarnessAndExplicitTestMarker() {
        let configuration = HQLaunchConfiguration.resolve(
            arguments: ["--hq-test-harness"],
            environment: ["HQIOS_USE_FIXTURES": "1", "HQIOS_TEST_HARNESS": "1"]
        )

        XCTAssertEqual(configuration.state, .fixtureVisualTour)
    }

    func testHarnessStateRequiresExplicitTestMarker() {
        let configuration = HQLaunchConfiguration.resolve(
            arguments: ["--hq-test-harness"],
            environment: ["HQIOS_TEST_HARNESS": "1"]
        )

        XCTAssertEqual(configuration.state, .testHarness)
    }

    func testReleaseBuildGateBlocksFixturesEvenWhenEveryRuntimeMarkerLeaks() {
        let configuration = HQLaunchConfiguration.resolve(
            arguments: ["--hq-test-harness"],
            environment: ["HQIOS_USE_FIXTURES": "1", "HQIOS_TEST_HARNESS": "1"],
            buildAllowsTestHarness: false
        )

        XCTAssertEqual(configuration.state, .fixtureLeakBlocked)
    }

    func testReleaseBuildGateBlocksDeterministicAuthHarness() {
        let configuration = HQLaunchConfiguration.resolve(
            arguments: ["--hq-auth-harness"],
            environment: ["HQIOS_TEST_HARNESS": "1", "HQIOS_AUTH_HARNESS_SCENARIO": "signed-in"],
            buildAllowsTestHarness: false
        )
        XCTAssertEqual(configuration.state, .signedOut)
    }
}
