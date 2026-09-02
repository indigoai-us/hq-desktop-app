import AppKit
import AVFoundation
import CoreGraphics
import Foundation

enum HQPrivacyCapability: String, CaseIterable, Equatable, Hashable, Sendable {
    case camera
    case microphone
    case screenRecording
}

enum HQPrivacyAuthorization: Equatable, Sendable {
    case notDetermined
    case restricted
    case denied
    case authorized
    case unknown
}

enum HQSystemSettingsDestination:
    String,
    CaseIterable,
    Equatable,
    Hashable,
    Sendable
{
    case notifications
    case accessibility
    case camera
    case microphone
    case screenRecording
}

struct HQMeetingPermissionSnapshot: Equatable, Sendable {
    let accessibility: HQPrivacyAuthorization
    let screenRecording: HQPrivacyAuthorization
    let microphone: HQPrivacyAuthorization

    static let unknown = HQMeetingPermissionSnapshot(
        accessibility: .unknown,
        screenRecording: .unknown,
        microphone: .unknown
    )

    var allRequiredGranted: Bool {
        accessibility == .authorized
            && screenRecording == .authorized
            && microphone == .authorized
    }
}

enum HQPrivacyServiceError: Error, Equatable {
    case settingsOpenRejected(URL)
}

@MainActor
protocol HQPrivacyStatusProviding {
    func authorizationStatus(for capability: HQPrivacyCapability) -> HQPrivacyAuthorization
}

@MainActor
protocol HQSystemSettingsOpening {
    func openSettingsURL(_ url: URL) -> Bool
}

@MainActor
struct HQSystemPrivacyStatusProvider: HQPrivacyStatusProviding {
    func authorizationStatus(for capability: HQPrivacyCapability) -> HQPrivacyAuthorization {
        switch capability {
        case .camera:
            Self.authorization(from: AVCaptureDevice.authorizationStatus(for: .video))
        case .microphone:
            Self.authorization(from: AVCaptureDevice.authorizationStatus(for: .audio))
        case .screenRecording:
            Self.screenRecordingAuthorization(
                isPreflightAllowed: CGPreflightScreenCaptureAccess()
            )
        }
    }

    static func authorization(from status: AVAuthorizationStatus) -> HQPrivacyAuthorization {
        switch status {
        case .notDetermined:
            .notDetermined
        case .restricted:
            .restricted
        case .denied:
            .denied
        case .authorized:
            .authorized
        @unknown default:
            .unknown
        }
    }

    static func screenRecordingAuthorization(isPreflightAllowed: Bool) -> HQPrivacyAuthorization {
        isPreflightAllowed ? .authorized : .denied
    }
}

@MainActor
final class HQSystemSettingsOpener: HQSystemSettingsOpening {
    private let workspace: NSWorkspace

    init(workspace: NSWorkspace = .shared) {
        self.workspace = workspace
    }

    func openSettingsURL(_ url: URL) -> Bool {
        workspace.open(url)
    }
}

@MainActor
final class HQNativePrivacyService {
    private let statusProvider: any HQPrivacyStatusProviding
    private let settingsOpener: any HQSystemSettingsOpening

    init(
        statusProvider: any HQPrivacyStatusProviding = HQSystemPrivacyStatusProvider(),
        settingsOpener: any HQSystemSettingsOpening = HQSystemSettingsOpener()
    ) {
        self.statusProvider = statusProvider
        self.settingsOpener = settingsOpener
    }

    func authorizationStatus(for capability: HQPrivacyCapability) -> HQPrivacyAuthorization {
        statusProvider.authorizationStatus(for: capability)
    }

    func openSettings(for capability: HQPrivacyCapability) throws {
        let destination: HQSystemSettingsDestination = switch capability {
        case .camera:
            .camera
        case .microphone:
            .microphone
        case .screenRecording:
            .screenRecording
        }
        try openSettings(destination)
    }

    func openSettings(_ destination: HQSystemSettingsDestination) throws {
        let url = Self.settingsURL(for: destination)
        guard settingsOpener.openSettingsURL(url) else {
            throw HQPrivacyServiceError.settingsOpenRejected(url)
        }
    }

    static func settingsURL(for capability: HQPrivacyCapability) -> URL {
        let destination: HQSystemSettingsDestination = switch capability {
        case .camera:
            .camera
        case .microphone:
            .microphone
        case .screenRecording:
            .screenRecording
        }
        return settingsURL(for: destination)
    }

    static func settingsURL(
        for destination: HQSystemSettingsDestination
    ) -> URL {
        switch destination {
        case .notifications:
            return URL(
                string:
                    "x-apple.systempreferences:com.apple.Notifications-Settings.extension"
            )!
        case .accessibility:
            return privacyURL(pane: "Privacy_Accessibility")
        case .camera:
            return privacyURL(pane: "Privacy_Camera")
        case .microphone:
            return privacyURL(pane: "Privacy_Microphone")
        case .screenRecording:
            return privacyURL(pane: "Privacy_ScreenCapture")
        }
    }

    private static func privacyURL(pane: String) -> URL {
        URL(
            string:
                "x-apple.systempreferences:com.apple.preference.security?\(pane)"
        )!
    }
}
