import Combine
import Foundation

/// The retained event channels that were still handled only by the legacy
/// Svelte renderer. Every case has an event-specific decoder below; merely
/// falling through to a generic status message is intentionally not parity.
enum HQNativeParityEventName: String, CaseIterable, Equatable, Hashable, Sendable {
    case contentProgress = "content:progress"
    case coreStateChanged = "core-state:changed"
    case desktopNavigate = "desktop:navigate"
    case dmDetailEvent = "dm:detail-event"
    case dmInboxOpen = "dm:inbox-open"
    case driftReport = "drift:report"
    case hqCLIUpdateAvailable = "hq-cli-update:available"
    case hqCLIUpdateCleared = "hq-cli-update:cleared"
    case installProgress = "install:progress"
    case marketplaceInstallComplete = "marketplace:install-complete"
    case marketplaceInstallError = "marketplace:install-error"
    case marketplaceInstallProgress = "marketplace:install-progress"
    case marketplacePublishProgress = "marketplace:publish-progress"
    case meetingsWindowAction = "meetings-window:action"
    case meetingsWindowRequestSnapshot = "meetings-window:request-snapshot"
    case meetingsFocusMeeting = "meetings:focus-meeting"
    case messagesOpenConversation = "messages:open-conversation"
    case notificationBannerAction = "notification:banner-action"
    case notificationDMAction = "notification:dm-action"
    case notificationMeetingAction = "notification:meeting-action"
    case notificationShareAction = "notification:share-action"
    case packUpdateAvailable = "pack-update:available"
    case packUpdateCleared = "pack-update:cleared"
    case packagesComplete = "packages:complete"
    case packagesError = "packages:error"
    case packagesProgress = "packages:progress"
    case packagesUpdates = "packages:updates"
    case popoverMeetingsSnapshot = "popover:meetings-snapshot"
    case popoverOpened = "popover:opened"
    case syncAuthError = "sync:auth-error"
    case syncComplete = "sync:complete"
    case syncConflict = "sync:conflict"
    case syncError = "sync:error"
    case syncExternalIdle = "sync:external-idle"
    case syncExternalProgress = "sync:external-progress"
    case syncFanoutPlan = "sync:fanout-plan"
    case syncPersonalFirstPushComplete = "sync:personal-first-push-complete"
    case syncPersonalFirstPushProgress = "sync:personal-first-push-progress"
    case syncPersonalFirstPushScan = "sync:personal-first-push-scan"
    case syncPlan = "sync:plan"
    case syncProgress = "sync:progress"
    case syncSetupNeeded = "sync:setup-needed"
    case syncTotals = "sync:totals"
    case trayCheckForUpdates = "tray:check-for-updates"
    case trayOpenDesktop = "tray:open-desktop"
    case trayOpenSettings = "tray:open-settings"
    case traySignOut = "tray:sign-out"
    case traySyncNow = "tray:sync-now"
    case updateAvailable = "update:available"
}

enum HQNativeParitySourceDisposition: String, Equatable, Sendable {
    /// The legacy cross-webview event was replaced by a direct Swift action or
    /// shared observable state transition. No synthetic engine event is needed.
    case directSwiftReplacement
    /// The old payload remains decodable for older sidecars, but current
    /// production architecture intentionally has no live producer.
    case retiredCompatibility
}

struct HQNativeParitySourceRegistration: Equatable, Sendable {
    let name: HQNativeParityEventName
    let disposition: HQNativeParitySourceDisposition
    let nativeSource: String
    let observableEffect: String
}

enum HQNativeParitySourceRegistry {
    /// These channels existed to bridge legacy desktop windows or native menu
    /// callbacks.
    /// Native HQ invokes the same behavior directly through typed Swift actions
    /// and shared `HQAppStore` state. Listing them here prevents the parity gate
    /// from mistaking the intentionally removed event bus hop for a missing
    /// producer.
    static let directSwiftReplacements: [HQNativeParitySourceRegistration] = [
        direct(
            .desktopNavigate,
            source: "HQAppAction.navigate + HQRouteParser",
            effect: "selectedRoute and the main scene update"
        ),
        direct(
            .dmDetailEvent,
            source: "HQAppStore direct-message selection",
            effect: "the selected DM payload renders in directMessageDetail"
        ),
        direct(
            .dmInboxOpen,
            source: "HQSecondaryWindowActionRegistry",
            effect: "directMessageDetail opens on the inbox/history state"
        ),
        direct(
            .meetingsWindowAction,
            source: "HQSecondaryWindowActionRegistry",
            effect: "start, stop, or company assignment reaches the engine"
        ),
        direct(
            .meetingsWindowRequestSnapshot,
            source: "shared HQAppStore meeting state",
            effect: "the meetings scene observes the current snapshot directly"
        ),
        direct(
            .meetingsFocusMeeting,
            source: "HQAppStore meeting selection",
            effect: "the meetings scene opens with a focused meeting identifier"
        ),
        direct(
            .messagesOpenConversation,
            source: "HQAppStore conversation selection",
            effect: "the messages scene opens and loads the selected DM thread"
        ),
        direct(
            .notificationBannerAction,
            source: "HQBannerWindowView action dispatch",
            effect: "the typed banner action executes in HQAppStore"
        ),
        direct(
            .notificationDMAction,
            source: "HQ native DM notification action",
            effect: "copy or direct-message detail behavior executes"
        ),
        direct(
            .notificationMeetingAction,
            source: "HQ native meeting notification action",
            effect: "open, record, or assignment behavior executes"
        ),
        direct(
            .notificationShareAction,
            source: "HQ native share notification action",
            effect: "copy, Claude, or share-detail behavior executes"
        ),
        direct(
            .popoverMeetingsSnapshot,
            source: "shared HQAppStore meeting state",
            effect: "menu-bar and meetings scenes observe one snapshot"
        ),
        direct(
            .popoverOpened,
            source: "MenuBarExtra scene lifecycle",
            effect: "the menu-bar scene refreshes from shared store state"
        ),
        direct(
            .trayCheckForUpdates,
            source: "MenuBarExtra check-for-updates action",
            effect: "HQNativeUpdaterService checks the Sparkle feed"
        ),
        direct(
            .trayOpenDesktop,
            source: "MenuBarExtra open action",
            effect: "the main native scene opens"
        ),
        direct(
            .trayOpenSettings,
            source: "MenuBarExtra settings action",
            effect: "the native settings route opens"
        ),
        direct(
            .traySignOut,
            source: "MenuBarExtra sign-out action",
            effect: "native credentials and authenticated state clear"
        ),
        direct(
            .traySyncNow,
            source: "MenuBarExtra sync action",
            effect: "the native sync operation starts"
        ),
        direct(
            .updateAvailable,
            source: "HQNativeUpdaterService.onStateChange",
            effect: "the observable Sparkle update state refreshes"
        ),
    ]

    static let retiredCompatibility: [HQNativeParitySourceRegistration] = [
        HQNativeParitySourceRegistration(
            name: .syncConflict,
            disposition: .retiredCompatibility,
            nativeSource: "hq-desktop-core SyncConflictEvent compatibility type",
            observableEffect:
                "old sidecars decode safely; current conflicts arrive in sync:complete"
        ),
    ]

    static let directSwiftNames = Set(directSwiftReplacements.map(\.name))
    static let retiredNames = Set(retiredCompatibility.map(\.name))

    private static func direct(
        _ name: HQNativeParityEventName,
        source: String,
        effect: String
    ) -> HQNativeParitySourceRegistration {
        HQNativeParitySourceRegistration(
            name: name,
            disposition: .directSwiftReplacement,
            nativeSource: source,
            observableEffect: effect
        )
    }
}

struct HQNativeContentProgress: Equatable, Sendable {
    let handle: String
    let phase: String
    let receivedBytes: Int?
    let totalBytes: Int?
    let percent: Double?
    let slow: Bool
    let stalled: Bool
    let message: String
}

struct HQNativeDriftEntry: Equatable, Sendable {
    let path: String
    let size: Int
    let gitSHALocal: String?
    let gitSHAUpstream: String?
    let stagingStatus: String?
}

struct HQNativeDriftReport: Equatable, Sendable {
    let count: Int
    let modified: [HQNativeDriftEntry]
    let missing: [HQNativeDriftEntry]
    let added: [HQNativeDriftEntry]
    let scannedAt: String
    let hqVersion: String
    let targetRepo: String
    let targetRef: String
}

struct HQNativeCoreState: Equatable, Sendable {
    let channel: String
    let targetRepo: String
    let targetVersion: String
    let targetRef: String
    let localVersion: String?
    let floorSHA: String?
    let isEligible: Bool
    let versionBehind: Bool
    let driftReport: HQNativeDriftReport
    let unchangedCount: Int
    let userOnlyCount: Int
    let scannedAt: String
}

struct HQNativeCLIUpdate: Equatable, Sendable {
    let local: String?
    let latest: String
}

struct HQNativeInstallProgress: Equatable, Sendable {
    let handle: String
    let line: String
    let finished: Bool
    let error: String?
}

struct HQNativeMarketplaceProgress: Equatable, Sendable {
    let source: String
    let scope: String
    let line: String
}

struct HQNativeMarketplaceTerminal: Equatable, Sendable {
    let source: String
    let scope: String
    let message: String?
}

struct HQNativePublishProgress: Equatable, Sendable {
    let stream: String?
    let line: String?
}

enum HQNativeMeetingWindowOperation: String, Equatable, Sendable {
    case start
    case stop
    case changeCompany = "change-company"
}

struct HQNativeMeetingWindowAction: Equatable, Sendable {
    let operation: HQNativeMeetingWindowOperation
    let windowID: String
    let companyUID: String?
}

enum HQNativeMeetingState: String, Equatable, Sendable {
    case detected
    case starting
    case recording
    case stopping
    case error
}

struct HQNativeMeetingSnapshotRow: Equatable, Sendable {
    let windowID: String
    let platform: String
    let meetingURL: String
    let detectedAt: String
    let state: HQNativeMeetingState
    let recordingID: String?
    let error: String?
    let companyUID: String?
    let companyUserSet: Bool?
    let summary: String?
    let sourceEventID: String?
}

struct HQNativeMeetingMembership: Equatable, Sendable {
    let companyUID: String
    let companyName: String?
    let role: String?
    let status: String
}

struct HQNativeMeetingsSnapshot: Equatable, Sendable {
    let activeMeetings: [HQNativeMeetingSnapshotRow]
    let memberships: [HQNativeMeetingMembership]
    let defaultRecordingCompanyUID: String?
}

struct HQNativeConversationTarget: Equatable, Sendable {
    let personUID: String
    let email: String
    let displayName: String
}

enum HQNativeBannerSource: String, Equatable, Sendable {
    case dm
    case share
    case update
    case meeting
}

struct HQNativeBannerAction: Equatable, Sendable {
    let source: HQNativeBannerSource
    let action: String
    let data: HQJSONValue
}

enum HQNativeDMNotificationOperation: String, Equatable, Sendable {
    case copy
    case open
}

struct HQNativeDMNotificationAction: Equatable, Sendable {
    let operation: HQNativeDMNotificationOperation
    let message: HQRealtimeDirectMessage
}

struct HQNativeShareSnapshot: Equatable, Sendable {
    let eventID: String
    let issuerEmail: String
    let issuerDisplayName: String
    let paths: [String]
    let note: String?
    let permission: String
    let createdAt: String
}

enum HQNativeShareNotificationOperation: String, Equatable, Sendable {
    case claude
    case copy
    case open
}

struct HQNativeShareNotificationAction: Equatable, Sendable {
    let operation: HQNativeShareNotificationOperation
    let share: HQNativeShareSnapshot
}

enum HQNativeMeetingNotificationOperation: String, Equatable, Sendable {
    case open
    case record
    case assign
}

struct HQNativeMeetingNotificationAction: Equatable, Sendable {
    let operation: HQNativeMeetingNotificationOperation
    let windowID: String?
    let platform: String?
    let meetingID: String?
}

struct HQNativePackUpdate: Equatable, Sendable {
    let count: Int
    let names: [String]
}

struct HQNativePackagesProgress: Equatable, Sendable {
    let operation: String
    let name: String
    let line: String
}

struct HQNativePackagesTerminal: Equatable, Sendable {
    let operation: String
    let name: String
    let message: String?
}

struct HQNativePackagesView: Equatable, Sendable {
    let packs: HQJSONValue?
    let registry: HQJSONValue?
    let error: String?
}

struct HQNativeSyncCompany: Equatable, Sendable {
    let uid: String
    let slug: String
    let name: String?
}

struct HQNativeSyncPlan: Equatable, Sendable {
    let company: String
    let filesToDownload: Int
    let bytesToDownload: Int
    let filesToUpload: Int
    let bytesToUpload: Int
    let filesToSkip: Int
    let filesToConflict: Int
    let filesToDelete: Int?
}

struct HQNativeSyncProgress: Equatable, Sendable {
    let company: String
    let path: String
    let bytes: Int
    let message: String?
    let direction: String?
    let deleted: Bool?
    let author: String?
}

struct HQNativeSyncComplete: Equatable, Sendable {
    let company: String
    let filesDownloaded: Int
    let bytesDownloaded: Int
    let filesSkipped: Int
    let conflicts: Int
    let aborted: Bool
    let filesTombstoned: Int?
    let filesRefusedStale: Int?
}

struct HQNativeSyncConflict: Equatable, Sendable {
    let path: String
    let localHash: String
    let remoteHash: String
    let canAutoResolve: Bool
}

struct HQNativeSyncFailure: Equatable, Sendable {
    let company: String?
    let path: String?
    let message: String
}

struct HQNativeExternalSyncProgress: Equatable, Sendable {
    let processID: Int
    let company: String?
    let phase: String
    let filesTotal: Int
    let filesDone: Int
    let conflicts: Int
    let currentFile: String?
    let startedAt: String
    let updatedAt: String
    let status: String
}

struct HQNativePersonalSyncScan: Equatable, Sendable {
    let personUID: String
    let filesScanned: Int
    let filesTotal: Int
    let currentFile: String?
}

struct HQNativePersonalSyncProgress: Equatable, Sendable {
    let personUID: String
    let filesDone: Int
    let filesTotal: Int
    let currentFile: String?
}

struct HQNativePersonalSyncComplete: Equatable, Sendable {
    let personUID: String
    let filesUploaded: Int
    let filesSkipped: Int
}

struct HQNativeAppUpdate: Equatable, Sendable {
    let version: String
    let body: String?
    let date: String?
}

enum HQNativeParityEventPayload: Equatable, Sendable {
    case contentProgress(HQNativeContentProgress)
    case coreStateChanged(HQNativeCoreState)
    case desktopNavigate(String)
    case dmDetailEvent(HQRealtimeDirectMessage)
    case dmInboxOpen
    case driftReport(HQNativeDriftReport)
    case hqCLIUpdateAvailable(HQNativeCLIUpdate)
    case hqCLIUpdateCleared(HQNativeCLIUpdate)
    case installProgress(HQNativeInstallProgress)
    case marketplaceInstallComplete(HQNativeMarketplaceTerminal)
    case marketplaceInstallError(HQNativeMarketplaceTerminal)
    case marketplaceInstallProgress(HQNativeMarketplaceProgress)
    case marketplacePublishProgress(HQNativePublishProgress)
    case meetingsWindowAction(HQNativeMeetingWindowAction)
    case meetingsWindowRequestSnapshot
    case meetingsFocusMeeting(String)
    case messagesOpenConversation(HQNativeConversationTarget)
    case notificationBannerAction(HQNativeBannerAction)
    case notificationDMAction(HQNativeDMNotificationAction)
    case notificationMeetingAction(HQNativeMeetingNotificationAction)
    case notificationShareAction(HQNativeShareNotificationAction)
    case packUpdateAvailable(HQNativePackUpdate)
    case packUpdateCleared
    case packagesComplete(HQNativePackagesTerminal)
    case packagesError(HQNativePackagesTerminal)
    case packagesProgress(HQNativePackagesProgress)
    case packagesUpdates(HQNativePackagesView)
    case popoverMeetingsSnapshot(HQNativeMeetingsSnapshot)
    case popoverOpened
    case syncAuthError(HQNativeSyncFailure)
    case syncComplete(HQNativeSyncComplete)
    case syncConflict(HQNativeSyncConflict)
    case syncError(HQNativeSyncFailure)
    case syncExternalIdle
    case syncExternalProgress(HQNativeExternalSyncProgress)
    case syncFanoutPlan([HQNativeSyncCompany])
    case syncPersonalFirstPushComplete(HQNativePersonalSyncComplete)
    case syncPersonalFirstPushProgress(HQNativePersonalSyncProgress)
    case syncPersonalFirstPushScan(HQNativePersonalSyncScan)
    case syncPlan(HQNativeSyncPlan)
    case syncProgress(HQNativeSyncProgress)
    case syncSetupNeeded
    case syncTotals(Int)
    case trayCheckForUpdates
    case trayOpenDesktop
    case trayOpenSettings
    case traySignOut
    case traySyncNow
    case updateAvailable(HQNativeAppUpdate)
}

struct HQNativeParityEventRecord: Equatable, Sendable {
    let name: HQNativeParityEventName
    let sequence: UInt64
    let payload: HQNativeParityEventPayload

    init?(event: HQEngineEvent) {
        guard let name = HQNativeParityEventName(rawValue: event.name) else {
            return nil
        }
        guard let payload = Self.decode(name: name, data: event.data) else {
            return nil
        }
        self.name = name
        sequence = event.sequence
        self.payload = payload
    }

    private static func decode(
        name: HQNativeParityEventName,
        data: HQJSONValue?
    ) -> HQNativeParityEventPayload? {
        switch name {
        case .contentProgress:
            guard let object = data?.parityObject,
                  let handle = object.parityString("handle"),
                  let phase = object.parityString("phase"),
                  let slow = object.parityBool("slow"),
                  let stalled = object.parityBool("stalled"),
                  let message = object.parityString("message"),
                  let received = object.parityOptionalInteger("receivedBytes"),
                  let total = object.parityOptionalInteger("totalBytes"),
                  let percent = object.parityOptionalNumber("percent")
            else { return nil }
            return .contentProgress(
                HQNativeContentProgress(
                    handle: handle,
                    phase: phase,
                    receivedBytes: received,
                    totalBytes: total,
                    percent: percent,
                    slow: slow,
                    stalled: stalled,
                    message: message
                )
            )

        case .coreStateChanged:
            guard let state = data.flatMap(HQNativeCoreState.init(value:)) else {
                return nil
            }
            return .coreStateChanged(state)

        case .desktopNavigate:
            guard let route = data?.parityNonemptyString else { return nil }
            return .desktopNavigate(route)

        case .dmDetailEvent:
            guard let data, let message = HQRealtimeDirectMessage(value: data) else {
                return nil
            }
            return .dmDetailEvent(message)

        case .dmInboxOpen:
            return data.parityIsUnit ? .dmInboxOpen : nil

        case .driftReport:
            guard let report = data.flatMap(HQNativeDriftReport.init(value:)) else {
                return nil
            }
            return .driftReport(report)

        case .hqCLIUpdateAvailable, .hqCLIUpdateCleared:
            guard let object = data?.parityObject,
                  let latest = object.parityNonemptyString("latest"),
                  let local = object.parityOptionalString("local")
            else { return nil }
            let update = HQNativeCLIUpdate(local: local, latest: latest)
            return name == .hqCLIUpdateAvailable
                ? .hqCLIUpdateAvailable(update)
                : .hqCLIUpdateCleared(update)

        case .installProgress:
            guard let object = data?.parityObject,
                  let handle = object.parityNonemptyString("handle"),
                  let line = object.parityString("line"),
                  let finished = object.parityBool("finished"),
                  let error = object.parityOptionalString("error")
            else { return nil }
            return .installProgress(
                HQNativeInstallProgress(
                    handle: handle,
                    line: line,
                    finished: finished,
                    error: error
                )
            )

        case .marketplaceInstallComplete,
             .marketplaceInstallError:
            guard let object = data?.parityObject,
                  let source = object.parityNonemptyString("source"),
                  let scope = object.parityNonemptyString("scope"),
                  let message = object.parityOptionalString("message")
            else { return nil }
            let terminal = HQNativeMarketplaceTerminal(
                source: source,
                scope: scope,
                message: message
            )
            if name == .marketplaceInstallError, message == nil {
                return nil
            }
            return name == .marketplaceInstallComplete
                ? .marketplaceInstallComplete(terminal)
                : .marketplaceInstallError(terminal)

        case .marketplaceInstallProgress:
            guard let object = data?.parityObject,
                  let source = object.parityNonemptyString("source"),
                  let scope = object.parityNonemptyString("scope"),
                  let line = object.parityString("line")
            else { return nil }
            return .marketplaceInstallProgress(
                HQNativeMarketplaceProgress(
                    source: source,
                    scope: scope,
                    line: line
                )
            )

        case .marketplacePublishProgress:
            guard let object = data?.parityObject,
                  let stream = object.parityOptionalString("stream"),
                  let line = object.parityOptionalString("line")
            else { return nil }
            return .marketplacePublishProgress(
                HQNativePublishProgress(stream: stream, line: line)
            )

        case .meetingsWindowAction:
            guard let object = data?.parityObject,
                  let operationValue = object.parityString("action"),
                  let operation = HQNativeMeetingWindowOperation(
                      rawValue: operationValue
                  ),
                  let windowID = object.parityNonemptyString("windowId"),
                  let companyUID = object.parityOptionalString("companyUid")
            else { return nil }
            return .meetingsWindowAction(
                HQNativeMeetingWindowAction(
                    operation: operation,
                    windowID: windowID,
                    companyUID: companyUID
                )
            )

        case .meetingsWindowRequestSnapshot:
            return data.parityIsUnit ? .meetingsWindowRequestSnapshot : nil

        case .meetingsFocusMeeting:
            guard let object = data?.parityObject,
                  let meetingID = object.parityNonemptyString("meetingId")
            else { return nil }
            return .meetingsFocusMeeting(meetingID)

        case .messagesOpenConversation:
            guard let object = data?.parityObject,
                  let personUID = object.parityString("personUid"),
                  let email = object.parityString("email"),
                  let displayName = object.parityString("displayName"),
                  !personUID.isEmpty || !email.isEmpty
            else { return nil }
            return .messagesOpenConversation(
                HQNativeConversationTarget(
                    personUID: personUID,
                    email: email,
                    displayName: displayName
                )
            )

        case .notificationBannerAction:
            guard let object = data?.parityObject,
                  let sourceValue = object.parityString("kind"),
                  let source = HQNativeBannerSource(rawValue: sourceValue),
                  let action = object.parityNonemptyString("action"),
                  let eventData = object["data"],
                  eventData.parityObject != nil
            else { return nil }
            return .notificationBannerAction(
                HQNativeBannerAction(
                    source: source,
                    action: action,
                    data: eventData
                )
            )

        case .notificationDMAction:
            guard let object = data?.parityObject,
                  let operationValue = object.parityString("action"),
                  let operation = HQNativeDMNotificationOperation(
                      rawValue: operationValue
                  ),
                  let messageValue = object["event"],
                  let message = HQRealtimeDirectMessage(value: messageValue)
            else { return nil }
            return .notificationDMAction(
                HQNativeDMNotificationAction(
                    operation: operation,
                    message: message
                )
            )

        case .notificationMeetingAction:
            guard let object = data?.parityObject,
                  let operationValue = object.parityString("action"),
                  let operation = HQNativeMeetingNotificationOperation(
                      rawValue: operationValue
                  ),
                  let windowID = object.parityOptionalString("windowId"),
                  let platform = object.parityOptionalString("platform"),
                  let meetingID = object.parityOptionalString("meetingId"),
                  operation != .record || windowID?.isEmpty == false,
                  operation != .assign || meetingID?.isEmpty == false
            else { return nil }
            return .notificationMeetingAction(
                HQNativeMeetingNotificationAction(
                    operation: operation,
                    windowID: windowID,
                    platform: platform,
                    meetingID: meetingID
                )
            )

        case .notificationShareAction:
            guard let object = data?.parityObject,
                  let operationValue = object.parityString("action"),
                  let operation = HQNativeShareNotificationOperation(
                      rawValue: operationValue
                  ),
                  let shareValue = object["event"],
                  let share = HQNativeShareSnapshot(value: shareValue)
            else { return nil }
            return .notificationShareAction(
                HQNativeShareNotificationAction(
                    operation: operation,
                    share: share
                )
            )

        case .packUpdateAvailable:
            guard let object = data?.parityObject,
                  let count = object.parityNonnegativeInteger("count"),
                  let names = object.parityStringArray("names"),
                  count == names.count
            else { return nil }
            return .packUpdateAvailable(
                HQNativePackUpdate(count: count, names: names)
            )

        case .packUpdateCleared:
            return data.parityIsUnit ? .packUpdateCleared : nil

        case .packagesComplete, .packagesError:
            guard let object = data?.parityObject,
                  let operation = object.parityNonemptyString("op"),
                  let packageName = object.parityNonemptyString("name"),
                  let message = object.parityOptionalString("message")
            else { return nil }
            let terminal = HQNativePackagesTerminal(
                operation: operation,
                name: packageName,
                message: message
            )
            if name == .packagesError, message == nil {
                return nil
            }
            return name == .packagesComplete
                ? .packagesComplete(terminal)
                : .packagesError(terminal)

        case .packagesProgress:
            guard let object = data?.parityObject,
                  let operation = object.parityNonemptyString("op"),
                  let packageName = object.parityNonemptyString("name"),
                  let line = object.parityString("line")
            else { return nil }
            return .packagesProgress(
                HQNativePackagesProgress(
                    operation: operation,
                    name: packageName,
                    line: line
                )
            )

        case .packagesUpdates:
            guard let object = data?.parityObject,
                  object.parityOptionalObject("packs") != nil,
                  object.parityOptionalObject("registry") != nil,
                  let error = object.parityOptionalString("error")
            else { return nil }
            return .packagesUpdates(
                HQNativePackagesView(
                    packs: object["packs"] == .null ? nil : object["packs"],
                    registry: object["registry"] == .null
                        ? nil
                        : object["registry"],
                    error: error
                )
            )

        case .popoverMeetingsSnapshot:
            guard let snapshot = data.flatMap(HQNativeMeetingsSnapshot.init(value:)) else {
                return nil
            }
            return .popoverMeetingsSnapshot(snapshot)

        case .popoverOpened:
            return data.parityIsUnit ? .popoverOpened : nil

        case .syncAuthError:
            guard let object = data?.parityObject,
                  let message = object.parityNonemptyString("message")
            else { return nil }
            return .syncAuthError(
                HQNativeSyncFailure(
                    company: nil,
                    path: nil,
                    message: message
                )
            )

        case .syncComplete:
            guard let object = data?.parityObject,
                  let company = object.parityNonemptyString("company"),
                  let filesDownloaded = object.parityNonnegativeInteger(
                      "filesDownloaded"
                  ),
                  let bytesDownloaded = object.parityNonnegativeInteger(
                      "bytesDownloaded"
                  ),
                  let filesSkipped = object.parityNonnegativeInteger(
                      "filesSkipped"
                  ),
                  let conflicts = object.parityNonnegativeInteger("conflicts"),
                  let aborted = object.parityBool("aborted"),
                  let filesTombstoned = object.parityOptionalNonnegativeInteger(
                      "filesTombstoned"
                  ),
                  let filesRefusedStale =
                    object.parityOptionalNonnegativeInteger("filesRefusedStale")
            else { return nil }
            return .syncComplete(
                HQNativeSyncComplete(
                    company: company,
                    filesDownloaded: filesDownloaded,
                    bytesDownloaded: bytesDownloaded,
                    filesSkipped: filesSkipped,
                    conflicts: conflicts,
                    aborted: aborted,
                    filesTombstoned: filesTombstoned,
                    filesRefusedStale: filesRefusedStale
                )
            )

        case .syncConflict:
            guard let object = data?.parityObject,
                  let path = object.parityNonemptyString("path"),
                  let localHash = object.parityNonemptyString("localHash"),
                  let remoteHash = object.parityNonemptyString("remoteHash"),
                  let canAutoResolve = object.parityBool("canAutoResolve")
            else { return nil }
            return .syncConflict(
                HQNativeSyncConflict(
                    path: path,
                    localHash: localHash,
                    remoteHash: remoteHash,
                    canAutoResolve: canAutoResolve
                )
            )

        case .syncError:
            guard let object = data?.parityObject,
                  let company = object.parityOptionalString("company"),
                  let path = object.parityNonemptyString("path"),
                  let message = object.parityNonemptyString("message")
            else { return nil }
            return .syncError(
                HQNativeSyncFailure(
                    company: company,
                    path: path,
                    message: message
                )
            )

        case .syncExternalIdle:
            return data.parityIsUnit ? .syncExternalIdle : nil

        case .syncExternalProgress:
            guard let object = data?.parityObject,
                  let processID = object.parityNonnegativeInteger("pid"),
                  let company = object.parityOptionalString("company"),
                  let phase = object.parityNonemptyString("phase"),
                  let filesTotal = object.parityNonnegativeInteger("filesTotal"),
                  let filesDone = object.parityNonnegativeInteger("filesDone"),
                  let conflicts = object.parityNonnegativeInteger("conflicts"),
                  let currentFile = object.parityOptionalString("currentFile"),
                  let startedAt = object.parityNonemptyString("startedAt"),
                  let updatedAt = object.parityNonemptyString("updatedAt"),
                  let status = object.parityNonemptyString("status")
            else { return nil }
            return .syncExternalProgress(
                HQNativeExternalSyncProgress(
                    processID: processID,
                    company: company,
                    phase: phase,
                    filesTotal: filesTotal,
                    filesDone: filesDone,
                    conflicts: conflicts,
                    currentFile: currentFile,
                    startedAt: startedAt,
                    updatedAt: updatedAt,
                    status: status
                )
            )

        case .syncFanoutPlan:
            guard let object = data?.parityObject,
                  let values = object["companies"]?.parityArray
            else { return nil }
            let companies = values.compactMap(HQNativeSyncCompany.init(value:))
            guard companies.count == values.count else { return nil }
            return .syncFanoutPlan(companies)

        case .syncPersonalFirstPushComplete:
            guard let object = data?.parityObject,
                  let personUID = object.parityNonemptyString("personUid"),
                  let filesUploaded = object.parityNonnegativeInteger(
                      "filesUploaded"
                  ),
                  let filesSkipped = object.parityNonnegativeInteger(
                      "filesSkipped"
                  )
            else { return nil }
            return .syncPersonalFirstPushComplete(
                HQNativePersonalSyncComplete(
                    personUID: personUID,
                    filesUploaded: filesUploaded,
                    filesSkipped: filesSkipped
                )
            )

        case .syncPersonalFirstPushProgress:
            guard let object = data?.parityObject,
                  let personUID = object.parityNonemptyString("personUid"),
                  let filesDone = object.parityNonnegativeInteger("filesDone"),
                  let filesTotal = object.parityNonnegativeInteger("filesTotal"),
                  let currentFile = object.parityOptionalString("currentFile")
            else { return nil }
            return .syncPersonalFirstPushProgress(
                HQNativePersonalSyncProgress(
                    personUID: personUID,
                    filesDone: filesDone,
                    filesTotal: filesTotal,
                    currentFile: currentFile
                )
            )

        case .syncPersonalFirstPushScan:
            guard let object = data?.parityObject,
                  let personUID = object.parityNonemptyString("personUid"),
                  let filesScanned = object.parityNonnegativeInteger(
                      "filesScanned"
                  ),
                  let filesTotal = object.parityNonnegativeInteger("filesTotal"),
                  let currentFile = object.parityOptionalString("currentFile")
            else { return nil }
            return .syncPersonalFirstPushScan(
                HQNativePersonalSyncScan(
                    personUID: personUID,
                    filesScanned: filesScanned,
                    filesTotal: filesTotal,
                    currentFile: currentFile
                )
            )

        case .syncPlan:
            guard let plan = data.flatMap(HQNativeSyncPlan.init(value:)) else {
                return nil
            }
            return .syncPlan(plan)

        case .syncProgress:
            guard let object = data?.parityObject,
                  let company = object.parityNonemptyString("company"),
                  let path = object.parityNonemptyString("path"),
                  let bytes = object.parityNonnegativeInteger("bytes"),
                  let message = object.parityOptionalString("message"),
                  let direction = object.parityOptionalString("direction"),
                  let deleted = object.parityOptionalBool("deleted"),
                  let author = object.parityOptionalString("author")
            else { return nil }
            return .syncProgress(
                HQNativeSyncProgress(
                    company: company,
                    path: path,
                    bytes: bytes,
                    message: message,
                    direction: direction,
                    deleted: deleted,
                    author: author
                )
            )

        case .syncSetupNeeded:
            return data.parityIsUnit ? .syncSetupNeeded : nil

        case .syncTotals:
            guard let object = data?.parityObject,
                  let total = object.parityNonnegativeInteger("totalFiles")
            else { return nil }
            return .syncTotals(total)

        case .trayCheckForUpdates:
            return data.parityIsUnit ? .trayCheckForUpdates : nil
        case .trayOpenDesktop:
            return data.parityIsUnit ? .trayOpenDesktop : nil
        case .trayOpenSettings:
            return data.parityIsUnit ? .trayOpenSettings : nil
        case .traySignOut:
            return data.parityIsUnit ? .traySignOut : nil
        case .traySyncNow:
            return data.parityIsUnit ? .traySyncNow : nil

        case .updateAvailable:
            guard let object = data?.parityObject,
                  let version = object.parityNonemptyString("version"),
                  let body = object.parityOptionalString("body"),
                  let date = object.parityOptionalString("date")
            else { return nil }
            return .updateAvailable(
                HQNativeAppUpdate(
                    version: version,
                    body: body,
                    date: date
                )
            )
        }
    }
}

enum HQNativeParityEffect: Equatable, Sendable {
    case none(message: String)
    case failure(message: String)
    case navigate(route: String)
    case openScene(id: String, message: String)
    case showMainWindow(message: String)
    case syncNow
    case signOut
    case checkForUpdates
    case meetingAction(HQNativeMeetingWindowAction)
    case notificationBanner(HQNativeBannerAction)
    case notificationDM(HQNativeDMNotificationAction)
    case notificationMeeting(HQNativeMeetingNotificationAction)
    case notificationShare(HQNativeShareNotificationAction)
    case syncState(HQJSONValue, tray: HQTrayState, message: String)
    case syncFailure(HQNativeSyncFailure, authentication: Bool)
    case refreshPackages(message: String)
}

enum HQNativeSyncEventPhase: String, Equatable, Sendable {
    case idle
    case syncing
    case setupNeeded = "setup-needed"
    case authenticationRequired = "auth-error"
    case conflict
    case error
}

struct HQNativeSyncEventState: Equatable, Sendable {
    var phase: HQNativeSyncEventPhase = .idle
    var totalFiles = 0
    var plans: [HQNativeSyncPlan] = []
    var companies: [HQNativeSyncCompany] = []
    var lastProgress: HQNativeSyncProgress?
    var externalProgress: HQNativeExternalSyncProgress?
    var completedByCompany: [String: HQNativeSyncComplete] = [:]
    var conflictsByPath: [String: HQNativeSyncConflict] = [:]
    var lastFailure: HQNativeSyncFailure?
    var personalScan: HQNativePersonalSyncScan?
    var personalProgress: HQNativePersonalSyncProgress?
    var personalComplete: HQNativePersonalSyncComplete?
}

struct HQNativeParityEventError: Error, Equatable, Sendable {
    let eventName: String
    let reason: String
}

@MainActor
final class HQNativeParityEventConsumer: ObservableObject {
    static let handledNames = Set(HQNativeParityEventName.allCases.map(\.rawValue))

    @Published private(set) var history: [HQNativeParityEventRecord] = []
    @Published private(set) var latest: [
        HQNativeParityEventName: HQNativeParityEventPayload
    ] = [:]
    @Published private(set) var sync = HQNativeSyncEventState()
    @Published private(set) var coreState: HQNativeCoreState?
    @Published private(set) var driftReport: HQNativeDriftReport?
    @Published private(set) var contentProgressByHandle: [
        String: HQNativeContentProgress
    ] = [:]
    @Published private(set) var installProgressByHandle: [
        String: HQNativeInstallProgress
    ] = [:]
    @Published private(set) var marketplaceLog: [String] = []
    @Published private(set) var packageLog: [String] = []
    @Published private(set) var packagesView: HQNativePackagesView?
    @Published private(set) var hqCLIUpdate: HQNativeCLIUpdate?
    @Published private(set) var packUpdate: HQNativePackUpdate?
    @Published private(set) var appUpdate: HQNativeAppUpdate?
    @Published private(set) var meetingsSnapshot = HQNativeMeetingsSnapshot(
        activeMeetings: [],
        memberships: [],
        defaultRecordingCompanyUID: nil
    )
    @Published private(set) var focusedMeetingID: String?
    @Published private(set) var conversationTarget: HQNativeConversationTarget?
    @Published private(set) var dmDetailMessage: HQRealtimeDirectMessage?
    @Published private(set) var selectedShare: HQNativeShareSnapshot?
    @Published private(set) var lastBannerAction: HQNativeBannerAction?
    @Published private(set) var lastDMNotificationAction:
        HQNativeDMNotificationAction?
    @Published private(set) var lastMeetingNotificationAction:
        HQNativeMeetingNotificationAction?
    @Published private(set) var lastShareNotificationAction:
        HQNativeShareNotificationAction?
    @Published private(set) var popoverOpenGeneration = 0
    @Published private(set) var meetingSnapshotRequestGeneration = 0

    func accepts(_ eventName: String) -> Bool {
        Self.handledNames.contains(eventName)
    }

    func openConversation(
        _ target: HQNativeConversationTarget
    ) -> HQNativeParityEffect {
        conversationTarget = target
        return .openScene(
            id: "messages",
            message: "Opened the selected conversation."
        )
    }

    func clearConversationTarget() {
        conversationTarget = nil
    }

    func openDirectMessage(
        _ message: HQRealtimeDirectMessage
    ) -> HQNativeParityEffect {
        dmDetailMessage = message
        return .openScene(
            id: HQSecondaryWindowKind.directMessageDetail.rawValue,
            message: "Opened the selected conversation."
        )
    }

    func openShare(
        _ share: HQNativeShareSnapshot
    ) -> HQNativeParityEffect {
        selectedShare = share
        return .openScene(
            id: HQSecondaryWindowKind.shareDetail.rawValue,
            message: "Opened the secure share."
        )
    }

    func consume(
        _ event: HQEngineEvent
    ) -> Result<HQNativeParityEffect, HQNativeParityEventError> {
        guard accepts(event.name) else {
            return .failure(
                HQNativeParityEventError(
                    eventName: event.name,
                    reason: "The event is not registered with the native parity consumer."
                )
            )
        }
        guard let record = HQNativeParityEventRecord(event: event) else {
            return .failure(
                HQNativeParityEventError(
                    eventName: event.name,
                    reason: "The payload does not match the retained legacy contract."
                )
            )
        }

        history.append(record)
        if history.count > 2_000 {
            history.removeFirst(history.count - 2_000)
        }
        latest[record.name] = record.payload
        return .success(reduce(record.payload))
    }

    private func reduce(
        _ payload: HQNativeParityEventPayload
    ) -> HQNativeParityEffect {
        switch payload {
        case let .contentProgress(progress):
            contentProgressByHandle[progress.handle] = progress
            return .none(message: progress.message)

        case let .coreStateChanged(state):
            coreState = state
            driftReport = state.driftReport
            return .none(
                message: state.versionBehind
                    ? "An HQ core update is available."
                    : "HQ core state refreshed."
            )

        case let .desktopNavigate(route):
            return .navigate(route: route)

        case let .dmDetailEvent(message):
            dmDetailMessage = message
            return .openScene(
                id: "dm-detail",
                message: "Opened the selected conversation."
            )

        case .dmInboxOpen:
            dmDetailMessage = nil
            return .openScene(
                id: "dm-detail",
                message: "Opened the message inbox."
            )

        case let .driftReport(report):
            driftReport = report
            return .openScene(
                id: "drift",
                message: "Core drift report refreshed."
            )

        case let .hqCLIUpdateAvailable(update):
            hqCLIUpdate = update
            return .none(message: "HQ CLI \(update.latest) is available.")

        case let .hqCLIUpdateCleared(update):
            hqCLIUpdate = update.local == update.latest ? nil : update
            return .none(message: "HQ CLI update state refreshed.")

        case let .installProgress(progress):
            installProgressByHandle[progress.handle] = progress
            if let error = progress.error {
                return .failure(message: error)
            }
            return .none(
                message: progress.finished
                    ? "Installation step completed."
                    : progress.line
            )

        case let .marketplaceInstallComplete(terminal):
            return .none(
                message: "Installed \(terminal.source) to \(terminal.scope)."
            )

        case let .marketplaceInstallError(terminal):
            return .failure(message: terminal.message ?? "Install failed.")

        case let .marketplaceInstallProgress(progress):
            marketplaceLog = Self.appendingCapped(
                progress.line,
                to: marketplaceLog
            )
            return .none(message: progress.line)

        case let .marketplacePublishProgress(progress):
            if let line = progress.line, !line.isEmpty {
                marketplaceLog = Self.appendingCapped(
                    line,
                    to: marketplaceLog
                )
            }
            return .none(
                message: progress.line.flatMap { $0.isEmpty ? nil : $0 }
                    ?? "Marketplace publish progress updated."
            )

        case let .meetingsWindowAction(action):
            return .meetingAction(action)

        case .meetingsWindowRequestSnapshot:
            meetingSnapshotRequestGeneration += 1
            return .none(message: "Meeting snapshot requested.")

        case let .meetingsFocusMeeting(meetingID):
            focusedMeetingID = meetingID
            return .openScene(
                id: "meetings",
                message: "Focused the selected meeting."
            )

        case let .messagesOpenConversation(target):
            conversationTarget = target
            return .openScene(
                id: "messages",
                message: "Opened the selected conversation."
            )

        case let .notificationBannerAction(action):
            lastBannerAction = action
            if action.source == .dm,
               let message = HQRealtimeDirectMessage(value: action.data)
            {
                dmDetailMessage = message
            } else if action.source == .share,
                      let share = HQNativeShareSnapshot(value: action.data)
            {
                selectedShare = share
            }
            return .notificationBanner(action)

        case let .notificationDMAction(action):
            lastDMNotificationAction = action
            if action.operation == .open {
                return openDirectMessage(action.message)
            }
            return .notificationDM(action)

        case let .notificationMeetingAction(action):
            lastMeetingNotificationAction = action
            return .notificationMeeting(action)

        case let .notificationShareAction(action):
            lastShareNotificationAction = action
            if action.operation == .open {
                return openShare(action.share)
            }
            selectedShare = action.share
            return .notificationShare(action)

        case let .packUpdateAvailable(update):
            packUpdate = update
            return .none(
                message: "\(update.count) pack update\(update.count == 1 ? "" : "s") available."
            )

        case .packUpdateCleared:
            packUpdate = nil
            return .none(message: "Pack updates are current.")

        case let .packagesComplete(terminal):
            return .refreshPackages(
                message: "\(terminal.name) \(terminal.operation) completed."
            )

        case let .packagesError(terminal):
            return .failure(
                message: terminal.message ?? "Package operation failed."
            )

        case let .packagesProgress(progress):
            packageLog = Self.appendingCapped(progress.line, to: packageLog)
            return .none(message: progress.line)

        case let .packagesUpdates(view):
            packagesView = view
            return .none(message: "Package update state refreshed.")

        case let .popoverMeetingsSnapshot(snapshot):
            meetingsSnapshot = snapshot
            return .none(message: "Meeting snapshot refreshed.")

        case .popoverOpened:
            popoverOpenGeneration += 1
            return .none(message: "Menu bar state refreshed.")

        case let .syncAuthError(failure):
            sync.phase = .authenticationRequired
            sync.lastFailure = failure
            return .syncFailure(failure, authentication: true)

        case let .syncComplete(complete):
            sync.completedByCompany[complete.company] = complete
            let hasUnresolvedConflicts = complete.aborted
                && complete.conflicts > 0
            if hasUnresolvedConflicts {
                sync.phase = .conflict
            } else if complete.aborted {
                let failure = HQNativeSyncFailure(
                    company: complete.company,
                    path: nil,
                    message: "Sync aborted before completion."
                )
                sync.phase = .error
                sync.lastFailure = failure
            } else if sync.phase != .conflict, sync.phase != .error {
                sync.phase = .idle
            }
            return .syncState(
                .object([
                    "company": .string(complete.company),
                    "filesDownloaded": .number(Double(complete.filesDownloaded)),
                    "bytesDownloaded": .number(Double(complete.bytesDownloaded)),
                    "filesSkipped": .number(Double(complete.filesSkipped)),
                    "conflicts": .number(Double(complete.conflicts)),
                    "aborted": .bool(complete.aborted),
                ]),
                tray: hasUnresolvedConflicts
                    ? .attention
                    : (complete.aborted ? .error : .current),
                message: hasUnresolvedConflicts
                    ? "Sync needs conflict resolution."
                    : (
                        complete.aborted
                            ? "Sync aborted for \(complete.company)."
                            : "Sync completed for \(complete.company)."
                    )
            )

        case let .syncConflict(conflict):
            sync.conflictsByPath[conflict.path] = conflict
            sync.phase = .conflict
            return .syncState(
                .object([
                    "path": .string(conflict.path),
                    "canAutoResolve": .bool(conflict.canAutoResolve),
                ]),
                tray: .attention,
                message: "Sync conflict at \(conflict.path)."
            )

        case let .syncError(failure):
            sync.phase = .error
            sync.lastFailure = failure
            return .syncFailure(failure, authentication: false)

        case .syncExternalIdle:
            sync.externalProgress = nil
            if sync.phase == .syncing {
                sync.phase = .idle
            }
            return .syncState(
                .object(["state": .string("idle")]),
                tray: .current,
                message: "External sync completed."
            )

        case let .syncExternalProgress(progress):
            sync.externalProgress = progress
            sync.phase = .syncing
            return .syncState(
                .object([
                    "company": progress.company.map(HQJSONValue.string) ?? .null,
                    "phase": .string(progress.phase),
                    "filesTotal": .number(Double(progress.filesTotal)),
                    "filesDone": .number(Double(progress.filesDone)),
                    "conflicts": .number(Double(progress.conflicts)),
                    "currentFile": progress.currentFile.map(HQJSONValue.string)
                        ?? .null,
                ]),
                tray: .syncing,
                message: "External sync is \(progress.phase)."
            )

        case let .syncFanoutPlan(companies):
            sync.companies = companies
            sync.phase = .syncing
            return .syncState(
                .object([
                    "companies": .array(
                        companies.map {
                            .object([
                                "uid": .string($0.uid),
                                "slug": .string($0.slug),
                                "name": $0.name.map(HQJSONValue.string) ?? .null,
                            ])
                        }
                    ),
                ]),
                tray: .syncing,
                message: "Sync planned for \(companies.count) workspace\(companies.count == 1 ? "" : "s")."
            )

        case let .syncPersonalFirstPushComplete(complete):
            sync.personalComplete = complete
            return .none(
                message: "Uploaded \(complete.filesUploaded) personal file\(complete.filesUploaded == 1 ? "" : "s")."
            )

        case let .syncPersonalFirstPushProgress(progress):
            sync.personalProgress = progress
            sync.phase = .syncing
            return .syncState(
                .object([
                    "personUid": .string(progress.personUID),
                    "filesDone": .number(Double(progress.filesDone)),
                    "filesTotal": .number(Double(progress.filesTotal)),
                    "currentFile": progress.currentFile.map(HQJSONValue.string)
                        ?? .null,
                ]),
                tray: .syncing,
                message: "Uploading personal files."
            )

        case let .syncPersonalFirstPushScan(scan):
            sync.personalScan = scan
            sync.phase = .syncing
            return .syncState(
                .object([
                    "personUid": .string(scan.personUID),
                    "filesScanned": .number(Double(scan.filesScanned)),
                    "filesTotal": .number(Double(scan.filesTotal)),
                    "currentFile": scan.currentFile.map(HQJSONValue.string)
                        ?? .null,
                ]),
                tray: .syncing,
                message: "Scanning personal files."
            )

        case let .syncPlan(plan):
            sync.plans.append(plan)
            sync.phase = .syncing
            return .syncState(
                .object([
                    "company": .string(plan.company),
                    "filesToDownload": .number(Double(plan.filesToDownload)),
                    "filesToUpload": .number(Double(plan.filesToUpload)),
                    "filesToConflict": .number(Double(plan.filesToConflict)),
                ]),
                tray: .syncing,
                message: "Sync plan updated for \(plan.company)."
            )

        case let .syncProgress(progress):
            sync.lastProgress = progress
            sync.phase = .syncing
            return .syncState(
                .object([
                    "company": .string(progress.company),
                    "path": .string(progress.path),
                    "bytes": .number(Double(progress.bytes)),
                    "message": progress.message.map(HQJSONValue.string) ?? .null,
                ]),
                tray: .syncing,
                message: progress.message ?? "Syncing \(progress.path)."
            )

        case .syncSetupNeeded:
            sync.phase = .setupNeeded
            return .syncState(
                .object(["state": .string("setup-needed")]),
                tray: .attention,
                message: "Sync setup is required."
            )

        case let .syncTotals(total):
            sync.totalFiles = total
            sync.phase = .syncing
            return .syncState(
                .object(["totalFiles": .number(Double(total))]),
                tray: .syncing,
                message: "Preparing \(total) file\(total == 1 ? "" : "s") to sync."
            )

        case .trayCheckForUpdates:
            return .checkForUpdates
        case .trayOpenDesktop:
            return .showMainWindow(message: "Opened HQ.")
        case .trayOpenSettings:
            return .openScene(id: "settings", message: "Opened HQ Settings.")
        case .traySignOut:
            return .signOut
        case .traySyncNow:
            return .syncNow

        case let .updateAvailable(update):
            appUpdate = update
            return .none(message: "HQ \(update.version) is available.")
        }
    }

    private static func appendingCapped(
        _ line: String,
        to lines: [String]
    ) -> [String] {
        Array((lines + [line]).suffix(200))
    }
}

private extension HQNativeCoreState {
    init?(value: HQJSONValue) {
        guard let object = value.parityObject,
              let channel = object.parityNonemptyString("channel"),
              ["release", "staging"].contains(channel),
              let targetRepo = object.parityNonemptyString("targetRepo"),
              let targetVersion = object.parityNonemptyString("targetVersion"),
              let targetRef = object.parityNonemptyString("targetRef"),
              let localVersion = object.parityOptionalString("localVersion"),
              let floorSHA = object.parityOptionalString("floorSha"),
              let isEligible = object.parityBool("isEligible"),
              let versionBehind = object.parityBool("versionBehind"),
              let driftValue = object["driftReport"],
              let driftReport = HQNativeDriftReport(value: driftValue),
              let unchangedCount = object.parityNonnegativeInteger(
                  "unchangedCount"
              ),
              let userOnlyCount = object.parityNonnegativeInteger(
                  "userOnlyCount"
              ),
              let scannedAt = object.parityNonemptyString("scannedAt")
        else { return nil }
        self.channel = channel
        self.targetRepo = targetRepo
        self.targetVersion = targetVersion
        self.targetRef = targetRef
        self.localVersion = localVersion
        self.floorSHA = floorSHA
        self.isEligible = isEligible
        self.versionBehind = versionBehind
        self.driftReport = driftReport
        self.unchangedCount = unchangedCount
        self.userOnlyCount = userOnlyCount
        self.scannedAt = scannedAt
    }
}

private extension HQNativeDriftReport {
    init?(value: HQJSONValue) {
        guard let object = value.parityObject,
              let count = object.parityNonnegativeInteger("count"),
              let modified = object.parityDriftEntries("modified"),
              let missing = object.parityDriftEntries("missing"),
              let added = object.parityDriftEntries("added"),
              let scannedAt = object.parityNonemptyString("scannedAt"),
              let hqVersion = object.parityNonemptyString("hqVersion"),
              let targetRepo = object.parityNonemptyString("targetRepo"),
              let targetRef = object.parityNonemptyString("targetRef")
        else { return nil }
        self.count = count
        self.modified = modified
        self.missing = missing
        self.added = added
        self.scannedAt = scannedAt
        self.hqVersion = hqVersion
        self.targetRepo = targetRepo
        self.targetRef = targetRef
    }
}

private extension HQNativeDriftEntry {
    init?(value: HQJSONValue) {
        guard let object = value.parityObject,
              let path = object.parityNonemptyString("path"),
              let size = object.parityNonnegativeInteger("size"),
              let local = object.parityOptionalString("gitShaLocal"),
              let upstream = object.parityOptionalString("gitShaUpstream"),
              let stagingStatus = object.parityOptionalString("stagingStatus")
        else { return nil }
        self.path = path
        self.size = size
        gitSHALocal = local
        gitSHAUpstream = upstream
        self.stagingStatus = stagingStatus
    }
}

private extension HQNativeShareSnapshot {
    init?(value: HQJSONValue) {
        guard let object = value.parityObject,
              let eventID = object.parityNonemptyString("eventId"),
              let issuerEmail = object.parityString("issuerEmail"),
              let issuerDisplayName = object.parityString("issuerDisplayName"),
              let paths = object.parityStringArray("paths"),
              !paths.isEmpty,
              let note = object.parityOptionalString("note"),
              let permission = object.parityNonemptyString("permission"),
              let createdAt = object.parityNonemptyString("createdAt")
        else { return nil }
        self.eventID = eventID
        self.issuerEmail = issuerEmail
        self.issuerDisplayName = issuerDisplayName
        self.paths = paths
        self.note = note
        self.permission = permission
        self.createdAt = createdAt
    }
}

private extension HQNativeMeetingsSnapshot {
    init?(value: HQJSONValue) {
        guard let object = value.parityObject,
              let meetingValues = object["activeMeetings"]?.parityArray,
              let membershipValues = object["memberships"]?.parityArray,
              let defaultUID = object.parityOptionalString(
                  "defaultRecordingCompanyUid"
              )
        else { return nil }
        let meetings = meetingValues.compactMap(
            HQNativeMeetingSnapshotRow.init(value:)
        )
        let memberships = membershipValues.compactMap(
            HQNativeMeetingMembership.init(value:)
        )
        guard meetings.count == meetingValues.count,
              memberships.count == membershipValues.count
        else { return nil }
        activeMeetings = meetings
        self.memberships = memberships
        defaultRecordingCompanyUID = defaultUID
    }
}

private extension HQNativeMeetingSnapshotRow {
    init?(value: HQJSONValue) {
        guard let object = value.parityObject,
              let windowID = object.parityNonemptyString("windowId"),
              let platform = object.parityNonemptyString("platform"),
              let meetingURL = object.parityString("meetingUrl"),
              let detectedAt = object.parityNonemptyString("detectedAt"),
              let stateValue = object.parityString("state"),
              let state = HQNativeMeetingState(rawValue: stateValue),
              let recordingID = object.parityOptionalString("recordingId"),
              let error = object.parityOptionalString("error"),
              let companyUID = object.parityOptionalString("companyUid"),
              let companyUserSet = object.parityOptionalBool("companyUserSet"),
              let summary = object.parityOptionalString("summary"),
              let sourceEventID = object.parityOptionalString("sourceEventId")
        else { return nil }
        self.windowID = windowID
        self.platform = platform
        self.meetingURL = meetingURL
        self.detectedAt = detectedAt
        self.state = state
        self.recordingID = recordingID
        self.error = error
        self.companyUID = companyUID
        self.companyUserSet = companyUserSet
        self.summary = summary
        self.sourceEventID = sourceEventID
    }
}

private extension HQNativeMeetingMembership {
    init?(value: HQJSONValue) {
        guard let object = value.parityObject,
              let companyUID = object.parityNonemptyString("companyUid"),
              let companyName = object.parityOptionalString("companyName"),
              let role = object.parityOptionalString("role"),
              let status = object.parityNonemptyString("status")
        else { return nil }
        self.companyUID = companyUID
        self.companyName = companyName
        self.role = role
        self.status = status
    }
}

private extension HQNativeSyncCompany {
    init?(value: HQJSONValue) {
        guard let object = value.parityObject,
              let uid = object.parityNonemptyString("uid"),
              let slug = object.parityNonemptyString("slug"),
              let name = object.parityOptionalString("name")
        else { return nil }
        self.uid = uid
        self.slug = slug
        self.name = name
    }
}

private extension HQNativeSyncPlan {
    init?(value: HQJSONValue) {
        guard let object = value.parityObject,
              let company = object.parityNonemptyString("company"),
              let filesToDownload = object.parityNonnegativeInteger(
                  "filesToDownload"
              ),
              let bytesToDownload = object.parityNonnegativeInteger(
                  "bytesToDownload"
              ),
              let filesToUpload = object.parityNonnegativeInteger(
                  "filesToUpload"
              ),
              let bytesToUpload = object.parityNonnegativeInteger(
                  "bytesToUpload"
              ),
              let filesToSkip = object.parityNonnegativeInteger("filesToSkip"),
              let filesToConflict = object.parityNonnegativeInteger(
                  "filesToConflict"
              ),
              let filesToDelete = object.parityOptionalNonnegativeInteger(
                  "filesToDelete"
              )
        else { return nil }
        self.company = company
        self.filesToDownload = filesToDownload
        self.bytesToDownload = bytesToDownload
        self.filesToUpload = filesToUpload
        self.bytesToUpload = bytesToUpload
        self.filesToSkip = filesToSkip
        self.filesToConflict = filesToConflict
        self.filesToDelete = filesToDelete
    }
}

private extension Optional where Wrapped == HQJSONValue {
    var parityIsUnit: Bool {
        switch self {
        case nil, .some(.null):
            true
        case .some(.object(let object)):
            object.isEmpty
        default:
            false
        }
    }
}

private extension HQJSONValue {
    var parityObject: [String: HQJSONValue]? {
        guard case let .object(value) = self else { return nil }
        return value
    }

    var parityArray: [HQJSONValue]? {
        guard case let .array(value) = self else { return nil }
        return value
    }

    var parityNonemptyString: String? {
        guard case let .string(value) = self, !value.isEmpty else {
            return nil
        }
        return value
    }
}

private extension Dictionary where Key == String, Value == HQJSONValue {
    func parityString(_ key: String) -> String? {
        guard case let .string(value)? = self[key] else { return nil }
        return value
    }

    func parityNonemptyString(_ key: String) -> String? {
        parityString(key).flatMap { $0.isEmpty ? nil : $0 }
    }

    func parityBool(_ key: String) -> Bool? {
        guard case let .bool(value)? = self[key] else { return nil }
        return value
    }

    func parityOptionalBool(_ key: String) -> Bool?? {
        guard let value = self[key] else { return .some(nil) }
        if value == .null { return .some(nil) }
        guard case let .bool(decoded) = value else { return nil }
        return .some(decoded)
    }

    func parityOptionalString(_ key: String) -> String?? {
        guard let value = self[key] else { return .some(nil) }
        if value == .null { return .some(nil) }
        guard case let .string(decoded) = value else { return nil }
        return .some(decoded)
    }

    func parityNumber(_ key: String) -> Double? {
        guard case let .number(value)? = self[key], value.isFinite else {
            return nil
        }
        return value
    }

    func parityOptionalNumber(_ key: String) -> Double?? {
        guard let value = self[key] else { return .some(nil) }
        if value == .null { return .some(nil) }
        guard case let .number(decoded) = value, decoded.isFinite else {
            return nil
        }
        return .some(decoded)
    }

    func parityNonnegativeInteger(_ key: String) -> Int? {
        guard let value = parityNumber(key),
              value >= 0,
              value.rounded() == value,
              value <= Double(Int.max)
        else { return nil }
        return Int(value)
    }

    func parityOptionalInteger(_ key: String) -> Int?? {
        guard let value = self[key] else { return .some(nil) }
        if value == .null { return .some(nil) }
        guard case let .number(number) = value,
              number.isFinite,
              number.rounded() == number,
              number >= Double(Int.min),
              number <= Double(Int.max)
        else { return nil }
        return .some(Int(number))
    }

    func parityOptionalNonnegativeInteger(_ key: String) -> Int?? {
        guard let value = self[key] else { return .some(nil) }
        if value == .null { return .some(nil) }
        guard case let .number(number) = value,
              number.isFinite,
              number >= 0,
              number.rounded() == number,
              number <= Double(Int.max)
        else { return nil }
        return .some(Int(number))
    }

    func parityStringArray(_ key: String) -> [String]? {
        guard case let .array(values)? = self[key] else { return nil }
        let strings = values.compactMap { value -> String? in
            guard case let .string(string) = value else { return nil }
            return string
        }
        return strings.count == values.count ? strings : nil
    }

    func parityOptionalObject(_ key: String) -> Bool? {
        guard let value = self[key] else { return nil }
        switch value {
        case .null, .object:
            return true
        default:
            return nil
        }
    }

    func parityDriftEntries(_ key: String) -> [HQNativeDriftEntry]? {
        guard case let .array(values)? = self[key] else { return nil }
        let entries = values.compactMap(HQNativeDriftEntry.init(value:))
        return entries.count == values.count ? entries : nil
    }
}
