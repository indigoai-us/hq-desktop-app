import AVFoundation
import XCTest
@testable import HQNative

@MainActor
final class HQNativePlatformPrivacyTests: XCTestCase {
    func testDelegatesStatusForEveryCapability() {
        let provider = PrivacyStatusProviderSpy(
            statuses: [
                .camera: .authorized,
                .microphone: .denied,
                .screenRecording: .restricted,
            ]
        )
        let service = HQNativePrivacyService(
            statusProvider: provider,
            settingsOpener: SettingsOpenerSpy()
        )

        XCTAssertEqual(service.authorizationStatus(for: .camera), .authorized)
        XCTAssertEqual(service.authorizationStatus(for: .microphone), .denied)
        XCTAssertEqual(service.authorizationStatus(for: .screenRecording), .restricted)
        XCTAssertEqual(provider.requestedCapabilities, [.camera, .microphone, .screenRecording])
    }

    func testMapsEveryAVFoundationAuthorizationState() {
        XCTAssertEqual(
            HQSystemPrivacyStatusProvider.authorization(from: .notDetermined),
            .notDetermined
        )
        XCTAssertEqual(
            HQSystemPrivacyStatusProvider.authorization(from: .restricted),
            .restricted
        )
        XCTAssertEqual(HQSystemPrivacyStatusProvider.authorization(from: .denied), .denied)
        XCTAssertEqual(
            HQSystemPrivacyStatusProvider.authorization(from: .authorized),
            .authorized
        )
    }

    func testMapsScreenRecordingPreflightState() {
        XCTAssertEqual(
            HQSystemPrivacyStatusProvider.screenRecordingAuthorization(isPreflightAllowed: true),
            .authorized
        )
        XCTAssertEqual(
            HQSystemPrivacyStatusProvider.screenRecordingAuthorization(isPreflightAllowed: false),
            .denied
        )
    }

    func testOpensExactPrivacySettingsDeepLinks() throws {
        let opener = SettingsOpenerSpy()
        opener.openResult = true
        let service = HQNativePrivacyService(
            statusProvider: PrivacyStatusProviderSpy(statuses: [:]),
            settingsOpener: opener
        )

        try service.openSettings(for: .camera)
        try service.openSettings(for: .microphone)
        try service.openSettings(for: .screenRecording)

        XCTAssertEqual(
            opener.openedURLs.map(\.absoluteString),
            [
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Camera",
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
                "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
            ]
        )
    }

    func testOpensNotificationsAndMeetingPermissionDestinationsExactly()
        throws
    {
        let opener = SettingsOpenerSpy()
        opener.openResult = true
        let service = HQNativePrivacyService(
            statusProvider: PrivacyStatusProviderSpy(statuses: [:]),
            settingsOpener: opener
        )

        try service.openSettings(.notifications)
        try service.openSettings(.accessibility)
        try service.openSettings(.screenRecording)
        try service.openSettings(.microphone)

        XCTAssertEqual(
            opener.openedURLs.map(\.absoluteString),
            [
                "x-apple.systempreferences:com.apple.Notifications-Settings.extension",
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
                "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
            ]
        )
    }

    func testReportsRejectedSettingsDeepLink() {
        let opener = SettingsOpenerSpy()
        opener.openResult = false
        let service = HQNativePrivacyService(
            statusProvider: PrivacyStatusProviderSpy(statuses: [:]),
            settingsOpener: opener
        )
        let expectedURL = URL(
            string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Camera"
        )!

        XCTAssertThrowsError(try service.openSettings(for: .camera)) { error in
            XCTAssertEqual(
                error as? HQPrivacyServiceError,
                .settingsOpenRejected(expectedURL)
            )
        }
    }
}

@MainActor
private final class PrivacyStatusProviderSpy: HQPrivacyStatusProviding {
    private let statuses: [HQPrivacyCapability: HQPrivacyAuthorization]
    private(set) var requestedCapabilities: [HQPrivacyCapability] = []

    init(statuses: [HQPrivacyCapability: HQPrivacyAuthorization]) {
        self.statuses = statuses
    }

    func authorizationStatus(for capability: HQPrivacyCapability) -> HQPrivacyAuthorization {
        requestedCapabilities.append(capability)
        return statuses[capability] ?? .unknown
    }
}

@MainActor
private final class SettingsOpenerSpy: HQSystemSettingsOpening {
    var openResult = false
    private(set) var openedURLs: [URL] = []

    func openSettingsURL(_ url: URL) -> Bool {
        openedURLs.append(url)
        return openResult
    }
}
