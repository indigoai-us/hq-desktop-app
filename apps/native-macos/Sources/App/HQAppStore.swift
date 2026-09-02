import AppKit
import ApplicationServices
import Combine
import Foundation
import SwiftUI
import UniformTypeIdentifiers
import UserNotifications

// MARK: - Launch and scene contracts

enum HQLaunchMode: Equatable, Sendable {
    case live
    case uiTestingFixture
    case previewFixture
    case visualTourFixture

    static func resolve(
        arguments: [String] = CommandLine.arguments,
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) -> HQLaunchMode {
        if arguments.contains("--visual-tour") {
            return .visualTourFixture
        }
        if arguments.contains("--ui-testing") {
            return .uiTestingFixture
        }
        if arguments.contains("--preview-fixtures") {
            return .previewFixture
        }
        if arguments.contains("--live") {
            return .live
        }
        if environment["XCTestConfigurationFilePath"]?.isEmpty == false
            || environment["XCTestBundlePath"]?.isEmpty == false
        {
            return .previewFixture
        }
        return .live
    }

    var usesFixtures: Bool {
        self != .live
    }

    var rendersProductionSurfaces: Bool {
        self == .live || self == .visualTourFixture
    }

    var usesLegacyFixtureSurfaces: Bool {
        self == .uiTestingFixture || self == .previewFixture
    }
}

enum HQSceneMultiplicity: String, Equatable, Sendable {
    case singleton
    case windowGroup
    case menuBarExtra
}

struct HQSceneDescriptor: Equatable, Sendable {
    let id: String
    let title: String
    let width: CGFloat
    let height: CGFloat
    let multiplicity: HQSceneMultiplicity
}

enum HQSceneRegistration {
    static let all: [HQSceneDescriptor] = [
        descriptor("main", "HQ", 1_180, 760, .windowGroup),
        descriptor("menubar", "HQ", 296, 360, .menuBarExtra),
        descriptor("onboarding", "Set up HQ", 780, 620),
        descriptor("sign-in", "Sign in to HQ", 520, 440),
        descriptor("recovery", "HQ Recovery", 620, 460),
        descriptor("meetings", "HQ Meetings", 460, 600),
        descriptor("meeting-permissions", "Meeting Permissions", 640, 700),
        descriptor("dm-detail", "Conversation", 820, 640),
        descriptor("share-detail", "Shared with you", 640, 560),
        descriptor("messages", "Messages", 720, 560),
        descriptor("banner", "HQ Notification", 366, 104),
        descriptor("widget", "HQ Widget", 340, 480),
        descriptor("activity", "Recent Changes", 560, 460),
        descriptor("drift", "HQ Core Changes", 560, 480),
        descriptor("new-files", "New Files", 500, 400),
        descriptor("notification-history", "Notifications", 680, 620),
        descriptor("settings", "HQ Settings", 760, 620),
    ]

    static let allIDs = all.map(\.id)

    static func descriptor(for id: String) -> HQSceneDescriptor {
        guard let descriptor = all.first(where: { $0.id == id }) else {
            preconditionFailure("Unregistered native scene \(id)")
        }
        return descriptor
    }

    private static func descriptor(
        _ id: String,
        _ title: String,
        _ width: CGFloat,
        _ height: CGFloat,
        _ multiplicity: HQSceneMultiplicity = .singleton
    ) -> HQSceneDescriptor {
        HQSceneDescriptor(
            id: id,
            title: title,
            width: width,
            height: height,
            multiplicity: multiplicity
        )
    }
}

struct HQAppSceneRequest: Identifiable, Equatable, Sendable {
    let id = UUID()
    let sceneID: String
}

// MARK: - Typed action and native parity registry

enum HQAppAction: Equatable, Sendable {
    case refresh
    case syncNow
    case showCommandPalette
    case navigate(HQRoute)
    case selectSyncWorkspace(String?)
    case openScene(HQSecondaryWindowKind)
    case showMainWindow
    case sceneReady(String)
    case nativeCommand(HQNativeCommand, payload: HQJSONValue? = nil)
    case secondaryWindow(kind: HQSecondaryWindowKind, actionID: String)
    case activateBanner(HQActiveBannerPayload)
    case replyToDirectMessage(String)
    case selectMessageConversation(HQMessagesSelectionRequest)
    case sendMessage(HQMessagesSendRequest)
    case engineCommand(
        HQEngineAppCommand,
        params: HQJSONValue,
        successMessage: String
    )
    case capabilityUnavailable(reason: String)
    case nativeEvent(HQNativeEvent, data: HQJSONValue)
    case setProjectStatus(boardPath: String, projectID: String, status: String)
    case setStoryPasses(prdPath: String, storyID: String, passes: Bool)
    case installMarketplace(
        listingID: String,
        slug: String,
        version: String?,
        scope: HQJSONValue
    )
}

enum HQNativeEvent: String, CaseIterable, Equatable, Sendable {
    case bannerEvent = "banner:event"
    case widgetClickAway = "widget:click-away"
    case widgetNotification = "widget:notification"
    case widgetOcclusion = "widget:occlusion"
}

struct HQNativeEventRecord: Identifiable, Equatable, Sendable {
    let id = UUID()
    let event: HQNativeEvent
    let data: HQJSONValue
}

enum HQEngineAppCommand: String, CaseIterable, Equatable, Sendable {
    case answerAgencyQuestion = "answer_agency_question"
    case claimPendingCompanyInvite = "claim_pending_company_invite"
    case createDirectory = "create_directory"
    case decideModerationListing = "decide_moderation_listing"
    case getCompanyDeployments = "get_company_deployments"
    case getCompanySecrets = "get_company_secrets"
    case getLibrarySkillDetail = "get_library_skill_detail"
    case getLibraryWorkerDetail = "get_library_worker_detail"
    case getLocalCompanyGoals = "get_local_company_goals"
    case getMarketplaceListing = "get_marketplace_listing"
    case installMarketplacePack = "install_marketplace_pack"
    case listAgencyQuestions = "list_agency_questions"
    case listAgentSessions = "list_agent_sessions"
    case markMessagesRead = "mark_messages_read"
    case meetingsCancelBot = "meetings_cancel_bot"
    case meetingsInviteBot = "meetings_invite_bot"
    case meetingsJoinBotNow = "meetings_join_bot_now"
    case meetingsListAccounts = "meetings_list_accounts"
    case oauthCancelListen = "oauth_cancel_listen"
    case oauthExchangeCode = "oauth_exchange_code"
    case oauthListenForCode = "oauth_listen_for_code"
    case readTextFile = "read_text_file"
    case sendAgencyMessage = "send_agency_message"
    case setSyncMode = "set_sync_mode"
    case setLocalProjectStatus = "set_local_project_status"
    case setLocalStoryPasses = "set_local_story_passes"
    case signOut = "sign_out"
    case startRecording = "start_recording"
    case startDaemon = "start_daemon"
    case startOAuthLogin = "start_oauth_login"
    case updateCreatorProfile = "update_creator_profile"
    case updatePackage = "update_package"
    case yankMarketplaceListing = "yank_marketplace_listing"
}

enum HQNativeCommand: String, CaseIterable, Sendable {
    case activityWindowReady = "activity_window_ready"
    case applyWidgetSettings = "apply_widget_settings"
    case availableChannels = "available_channels"
    case bannerAction = "banner_action"
    case bannerWindowReady = "banner_window_ready"
    case checkForUpdates = "check_for_updates"
    case claudeDesktopInstalled = "claude_desktop_installed"
    case detailWindowReady = "detail_window_ready"
    case dismissBanner = "dismiss_banner"
    case dmDetailWindowReady = "dm_detail_window_ready"
    case driftWindowReady = "drift_window_ready"
    case getAutostartEnabled = "get_autostart_enabled"
    case getPendingUpdate = "get_pending_update"
    case homeDir = "home_dir"
    case installUpdate = "install_update"
    case keychainDelete = "keychain_delete"
    case keychainGet = "keychain_get"
    case keychainSet = "keychain_set"
    case launchClaudeCode = "launch_claude_code"
    case launchClaudeDesktop = "launch_claude_desktop"
    case launchCliInTerminal = "launch_cli_in_terminal"
    case launchCodexDesktop = "launch_codex_desktop"
    case launchMenubarApp = "launch_menubar_app"
    case listDisplays = "list_displays"
    case meetingsClearPromptBadge = "meetings_clear_prompt_badge"
    case meetingsPermissionsState = "meetings_permissions_state"
    case meetingsSetPromptBadge = "meetings_set_prompt_badge"
    case meetingsTakePendingFocus = "meetings_take_pending_focus"
    case menubarInstalled = "menubar_installed"
    case messagesWindowReady = "messages_window_ready"
    case takePendingMessagesTarget = "take_pending_messages_target"
    case notificationPermissionState = "notification_permission_state"
    case notificationRequestPermission = "notification_request_permission"
    case openActivityLog = "open_activity_log"
    case openClaudeCodeLink = "open_claude_code_link"
    case openDesktopAltWindow = "open_desktop_alt_window"
    case openDeveloperSettings = "open_developer_settings"
    case openDMDetail = "open_dm_detail"
    case openDriftDetail = "open_drift_detail"
    case openInboxWindow = "open_inbox_window"
    case openMeetingPermissionsWindow = "open_meeting_permissions_window"
    case openMeetingsWindow = "open_meetings_window"
    case openMessagesWindow = "open_messages_window"
    case openNewFilesDetail = "open_new_files_detail"
    case openNotificationHistory = "open_notification_history"
    case openPackagesWindow = "open_packages_window"
    case openSettingsWindow = "open_settings_window"
    case openShareDetail = "open_share_detail"
    case openInEditor = "open_in_editor"
    case packagesWindowReady = "packages_window_ready"
    case permissionsForceNativeRegister = "permissions_force_native_register"
    case permissionsOpenSettings = "permissions_open_settings"
    case pickAvatarFile = "pick_avatar_file"
    case pickFolder = "pick_folder"
    case pickPackDirectory = "pick_pack_directory"
    case previewDMBanner = "preview_dm_banner"
    case previewMeetingBanner = "preview_meeting_banner"
    case previewShareBanner = "preview_share_banner"
    case previewUpdateBanner = "preview_update_banner"
    case quitApp = "quit_app"
    case resizeBanner = "resize_banner"
    case resizeWidget = "resize_widget"
    case revealFolder = "reveal_folder"
    case setAutostartEnabled = "set_autostart_enabled"
    case setMainWindowVibrancy = "set_main_window_vibrancy"
    case setTrayState = "set_tray_state"
    case setWidgetFocusable = "set_widget_focusable"
    case shareDetailWindowReady = "share_detail_window_ready"
    case showMainWindow = "show_main_window"
    case showMainWindowAtTray = "show_main_window_at_tray"
    case widgetReady = "widget_ready"
}

private struct HQLegacyCognitoTokens: Decodable {
    let accessToken: String
    let idToken: String?
    let refreshToken: String
    let expiresAt: HQLegacyCognitoExpiry
}

private enum HQLegacyCognitoExpiry: Decodable {
    case epochMilliseconds(Int64)
    case rfc3339(String)

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let value = try? container.decode(Int64.self) {
            self = .epochMilliseconds(value)
            return
        }
        if let value = try? container.decode(String.self),
           Self.isRFC3339(value)
        {
            self = .rfc3339(value)
            return
        }
        throw DecodingError.dataCorruptedError(
            in: container,
            debugDescription:
                "expiresAt must be integral epoch milliseconds or RFC 3339."
        )
    }

    private static func isRFC3339(_ value: String) -> Bool {
        let standard = ISO8601DateFormatter()
        standard.formatOptions = [.withInternetDateTime]
        if standard.date(from: value) != nil {
            return true
        }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [
            .withInternetDateTime,
            .withFractionalSeconds,
        ]
        return fractional.date(from: value) != nil
    }
}

enum HQNativeCommandImplementation: Equatable, Sendable {
    case sceneReady(String)
    case openScene(HQSecondaryWindowKind)
    case openMeetingsWindow
    case showMainWindow
    case showMainWindowAtTray
    case navigate(HQRoute)
    case dismissBanner
    case bannerAction
    case previewBanner(HQBannerKind)
    case quit
    case openInEditor
    case pickAvatarFile
    case pickFolder
    case pickPackDirectory
    case revealFolder
    case getAutostart
    case setAutostart
    case homeDirectory
    case listDisplays
    case requestNotificationPermission
    case openPrivacySettings
    case applyWidgetSettings
    case availableUpdateChannels
    case checkForUpdates
    case applicationInstalled(bundleIdentifiers: [String])
    case pendingUpdate
    case installUpdate
    case keychainDelete
    case keychainGet
    case keychainSet
    case launchApplication(bundleIdentifiers: [String])
    case launchTerminal
    case meetingPermissionsState
    case clearMeetingPromptBadge
    case setMeetingPromptBadge
    case takePendingMeetingFocus
    case takePendingMessagesTarget
    case menuBarInstalled
    case notificationPermissionState
    case openExternalLink
    case forcePermissionRegistration
    case resizeWindow(HQSecondaryWindowKind)
    case setTrayState
    case setMainWindowVibrancy
    case setWidgetFocusable
}

enum HQNativeCommandResolution: Equatable, Sendable {
    case implemented(HQNativeCommandImplementation)
    case disabled(reason: String)
}

enum HQNativeActionRegistry {
    static func resolution(for command: HQNativeCommand) -> HQNativeCommandResolution {
        switch command {
        case .activityWindowReady:
            return .implemented(.sceneReady(HQSecondaryWindowKind.activity.rawValue))
        case .bannerWindowReady:
            return .implemented(.sceneReady(HQSecondaryWindowKind.banner.rawValue))
        case .detailWindowReady:
            return .implemented(.sceneReady(HQSecondaryWindowKind.newFiles.rawValue))
        case .dmDetailWindowReady:
            return .implemented(.sceneReady(HQSecondaryWindowKind.directMessageDetail.rawValue))
        case .driftWindowReady:
            return .implemented(.sceneReady(HQSecondaryWindowKind.drift.rawValue))
        case .messagesWindowReady:
            return .implemented(.sceneReady(HQSecondaryWindowKind.messages.rawValue))
        case .packagesWindowReady:
            return .implemented(.sceneReady("packages"))
        case .shareDetailWindowReady:
            return .implemented(.sceneReady(HQSecondaryWindowKind.shareDetail.rawValue))
        case .widgetReady:
            return .implemented(.sceneReady(HQSecondaryWindowKind.widget.rawValue))

        case .openActivityLog:
            return .implemented(.openScene(.activity))
        case .openDMDetail:
            return .implemented(.openScene(.directMessageDetail))
        case .openDriftDetail:
            return .implemented(.openScene(.drift))
        case .openMeetingPermissionsWindow:
            return .implemented(.openScene(.meetingPermissions))
        case .openMeetingsWindow:
            return .implemented(.openMeetingsWindow)
        case .openMessagesWindow:
            return .implemented(.openScene(.messages))
        case .openNewFilesDetail:
            return .implemented(.openScene(.newFiles))
        case .openNotificationHistory:
            return .implemented(.openScene(.notificationHistory))
        case .openSettingsWindow, .openDeveloperSettings:
            return .implemented(.openScene(.settings))
        case .openShareDetail:
            return .implemented(.openScene(.shareDetail))
        case .launchMenubarApp:
            return .implemented(.openScene(.menuBar))
        case .openDesktopAltWindow, .showMainWindow:
            return .implemented(.showMainWindow)
        case .openInboxWindow:
            return .implemented(.navigate(.global(.inbox)))
        case .openPackagesWindow:
            return .implemented(.navigate(.global(.marketplace)))

        case .bannerAction:
            return .implemented(.bannerAction)
        case .dismissBanner:
            return .implemented(.dismissBanner)
        case .previewDMBanner:
            return .implemented(.previewBanner(.directMessage))
        case .previewMeetingBanner:
            return .implemented(.previewBanner(.meetingReady))
        case .previewShareBanner:
            return .implemented(.previewBanner(.syncComplete))
        case .previewUpdateBanner:
            return .implemented(.previewBanner(.updateAvailable))
        case .quitApp:
            return .implemented(.quit)
        case .openInEditor:
            return .implemented(.openInEditor)
        case .pickAvatarFile:
            return .implemented(.pickAvatarFile)
        case .pickFolder:
            return .implemented(.pickFolder)
        case .pickPackDirectory:
            return .implemented(.pickPackDirectory)
        case .revealFolder:
            return .implemented(.revealFolder)
        case .getAutostartEnabled:
            return .implemented(.getAutostart)
        case .setAutostartEnabled:
            return .implemented(.setAutostart)
        case .homeDir:
            return .implemented(.homeDirectory)
        case .listDisplays:
            return .implemented(.listDisplays)
        case .notificationRequestPermission:
            return .implemented(.requestNotificationPermission)
        case .permissionsOpenSettings:
            return .implemented(.openPrivacySettings)

        case .applyWidgetSettings:
            return .implemented(.applyWidgetSettings)
        case .availableChannels:
            return .implemented(.availableUpdateChannels)
        case .checkForUpdates:
            return .implemented(.checkForUpdates)
        case .claudeDesktopInstalled:
            return .implemented(
                .applicationInstalled(
                    bundleIdentifiers: [
                        "com.anthropic.claudefordesktop",
                        "com.anthropic.Claude",
                    ]
                )
            )
        case .getPendingUpdate:
            return .implemented(.pendingUpdate)
        case .installUpdate:
            return .implemented(.installUpdate)
        case .keychainDelete:
            return .implemented(.keychainDelete)
        case .keychainGet:
            return .implemented(.keychainGet)
        case .keychainSet:
            return .implemented(.keychainSet)
        case .launchClaudeCode:
            return .implemented(.launchTerminal)
        case .launchClaudeDesktop:
            return .implemented(
                .launchApplication(
                    bundleIdentifiers: [
                        "com.anthropic.claudefordesktop",
                        "com.anthropic.Claude",
                    ]
                )
            )
        case .launchCliInTerminal:
            return .implemented(.launchTerminal)
        case .launchCodexDesktop:
            return .implemented(
                .launchApplication(
                    bundleIdentifiers: [
                        "com.openai.codex",
                        "com.openai.chat",
                    ]
                )
            )
        case .meetingsPermissionsState:
            return .implemented(.meetingPermissionsState)
        case .meetingsClearPromptBadge:
            return .implemented(.clearMeetingPromptBadge)
        case .meetingsSetPromptBadge:
            return .implemented(.setMeetingPromptBadge)
        case .meetingsTakePendingFocus:
            return .implemented(.takePendingMeetingFocus)
        case .takePendingMessagesTarget:
            return .implemented(.takePendingMessagesTarget)
        case .menubarInstalled:
            return .implemented(.menuBarInstalled)
        case .notificationPermissionState:
            return .implemented(.notificationPermissionState)
        case .openClaudeCodeLink:
            return .implemented(.openExternalLink)
        case .permissionsForceNativeRegister:
            return .implemented(.forcePermissionRegistration)
        case .resizeBanner:
            return .implemented(.resizeWindow(.banner))
        case .resizeWidget:
            return .implemented(.resizeWindow(.widget))
        case .setTrayState:
            return .implemented(.setTrayState)
        case .setMainWindowVibrancy:
            return .implemented(.setMainWindowVibrancy)
        case .setWidgetFocusable:
            return .implemented(.setWidgetFocusable)
        case .showMainWindowAtTray:
            return .implemented(.showMainWindowAtTray)
        }
    }
}

enum HQSecondaryWindowActionResolution: Equatable, Sendable {
    case reload
    case syncNow
    case runOnboarding
    case runRecovery
    case oauth(provider: String)
    case cancelOAuth
    case openScene(HQSecondaryWindowKind)
    case showMainWindow
    case navigate(HQRoute)
    case nativeCommand(HQNativeCommand)
    case nativeCommandPayload(HQNativeCommand, HQJSONValue)
    case openExternal(URL)
    case startDetectedMeeting
    case revealWorkspace
    case restoreDefaults
    case markNotificationsRead
    case nativeParityEvent(
        HQNativeParityEventName,
        data: HQJSONValue?
    )
    case bannerNotificationAction(String)
}

enum HQSecondaryWindowActionRegistry {
    static func resolution(
        for kind: HQSecondaryWindowKind,
        actionID: String
    ) -> HQSecondaryWindowActionResolution? {
        if ["retry", "refresh"].contains(actionID) {
            return .reload
        }
        if kind == .banner {
            return actionID == "dismiss" || actionID.hasSuffix(".dismiss")
                ? .nativeCommand(.dismissBanner)
                : .bannerNotificationAction(actionID)
        }

        switch (kind, actionID) {
        case (.menuBar, "sync-now"):
            return .nativeParityEvent(.traySyncNow, data: nil)
        case (.menuBar, "open"):
            return .nativeParityEvent(.trayOpenDesktop, data: nil)
        case (.menuBar, "settings"):
            return .nativeParityEvent(.trayOpenSettings, data: nil)
        case (.menuBar, "sign-out"):
            return .nativeParityEvent(.traySignOut, data: nil)
        case (.menuBar, "check-updates"):
            return .nativeParityEvent(.trayCheckForUpdates, data: nil)
        case (.widget, "open"):
            return .showMainWindow
        case (.onboarding, "continue"),
             (.onboarding, "run-setup"):
            return .runOnboarding
        case (.onboarding, "learn"):
            return .openExternal(URL(string: "https://hq.computer")!)
        case (.onboarding, "recovery"):
            return .openScene(.recovery)
        case (.onboarding, "done"):
            return .showMainWindow
        case (.onboarding, "sign-in-google"),
             (.signIn, "sign-in-google"),
             (.signIn, "sign-in"):
            return .oauth(provider: "Google")
        case (.onboarding, "sign-in-microsoft"),
             (.signIn, "sign-in-microsoft"):
            return .oauth(provider: "Microsoft")
        case (.signIn, "cancel"):
            return .cancelOAuth
        case (.recovery, "repair"):
            return .runRecovery
        case (.recovery, let actionID)
            where actionID.hasPrefix("stage."):
            return .runRecovery
        case (.recovery, "export"):
            return .openScene(.activity)
        case (.meetings, "permissions"):
            return .openScene(.meetingPermissions)
        case (.meetings, "start"):
            return .startDetectedMeeting
        case (.meetings, "history"):
            return .navigate(.global(.meetings))
        case (.meetingPermissions, "check"):
            return .nativeCommand(.meetingsPermissionsState)
        case (.meetingPermissions, let actionID)
            where actionID.hasPrefix("open-settings."):
            let destination = String(
                actionID.dropFirst("open-settings.".count)
            )
            guard HQSystemSettingsDestination(rawValue: destination) != nil
            else {
                return nil
            }
            return .nativeCommandPayload(
                .permissionsOpenSettings,
                .string(destination)
            )
        case (.settings, "open-settings"),
             (.meetingPermissions, "open-settings"):
            return .nativeCommand(.permissionsOpenSettings)
        case (.meetings, let dynamicAction)
            where dynamicAction.hasPrefix("meeting-action|"):
            let fields = dynamicAction.split(
                separator: "|",
                omittingEmptySubsequences: false
            ).map(String.init)
            guard fields.count == 4,
                  let operation = HQNativeMeetingWindowOperation(
                      rawValue: fields[1]
                  ),
                  !fields[2].isEmpty
            else {
                return nil
            }
            return .nativeParityEvent(
                .meetingsWindowAction,
                data: .object([
                    "action": .string(operation.rawValue),
                    "windowId": .string(fields[2]),
                    "companyUid": fields[3].isEmpty
                        ? .null
                        : .string(fields[3]),
                ])
            )
        case (.directMessageDetail, "reply"),
             (.directMessageDetail, "open"):
            return .openScene(.messages)
        case (.shareDetail, "open-inbox"),
             (.messages, "requests"):
            return .navigate(.global(.inbox))
        case (.widget, "customize"):
            return .navigate(.settings(.widget))
        case (.activity, "open"):
            return .navigate(.global(.home))
        case (.drift, "review"), (.newFiles, "review-files"):
            return .navigate(.files(slug: nil, path: nil))
        case (.drift, "preserve"),
             (.newFiles, "reveal"):
            return .revealWorkspace
        case (.notificationHistory, "mark-read"):
            return .markNotificationsRead
        case (.notificationHistory, "settings"):
            return .navigate(.settings(.notifications))
        case (.settings, "defaults"):
            return .restoreDefaults
        case (.settings, "open-main"), (.settings, "done"):
            return .navigate(.settings(.sync))
        default:
            return nil
        }
    }
}

// MARK: - Engine-backed state

protocol HQAppEngine: Sendable {
    nonisolated var events: AsyncStream<HQEngineEvent> { get }
    nonisolated var lifecycleEvents:
        AsyncStream<HQAppEngineLifecycleEvent> { get }

    func start() async throws -> HQJSONValue
    func request(_ method: String, params: HQJSONValue) async throws -> HQJSONValue
    func request(
        _ method: String,
        params: HQJSONValue,
        timeoutNanoseconds: UInt64?
    ) async throws -> HQJSONValue
    func stop() async
}

extension HQAppEngine {
    nonisolated var lifecycleEvents:
        AsyncStream<HQAppEngineLifecycleEvent>
    {
        AsyncStream { continuation in
            continuation.finish()
        }
    }

    func request(
        _ method: String,
        params: HQJSONValue,
        timeoutNanoseconds _: UInt64?
    ) async throws -> HQJSONValue {
        try await request(method, params: params)
    }
}

extension HQEngineClient: HQAppEngine {}

typealias HQAppEngineFactory =
    @MainActor () throws -> any HQAppEngine

enum HQAppPhase: Equatable, Sendable {
    case idle
    case loading
    case ready
    case failed(String)
}

enum HQOperationState: Equatable, Sendable {
    case idle
    case busy(String)
    case success(String)
    case failure(String)
}

enum HQSetupStageID: String, CaseIterable, Equatable, Sendable {
    case content
    case dependencies = "deps"
    case initialSync = "initial-sync"
    case packages
    case gitInitialize = "git-init"
    case personalize
    case importExisting = "import"
    case indexing
    case menuBar = "menubar"

    var title: String {
        switch self {
        case .content: "Download HQ template"
        case .dependencies: "Install dependencies"
        case .initialSync: "Start initial cloud sync"
        case .packages: "Install default packages"
        case .gitInitialize: "Initialize workspace"
        case .personalize: "Personalize HQ"
        case .importExisting: "Import existing setup"
        case .indexing: "Register search index"
        case .menuBar: "Activate menu bar"
        }
    }

    var symbolName: String {
        switch self {
        case .content: "arrow.down.doc"
        case .dependencies: "shippingbox"
        case .initialSync: "icloud.and.arrow.up"
        case .packages: "square.stack.3d.up"
        case .gitInitialize: "point.3.connected.trianglepath.dotted"
        case .personalize: "person.crop.circle.badge.checkmark"
        case .importExisting: "tray.and.arrow.down"
        case .indexing: "text.magnifyingglass"
        case .menuBar: "menubar.rectangle"
        }
    }

    var engineMethod: String? {
        switch self {
        case .content: "fetch_and_extract_template"
        case .dependencies: "install_deps"
        case .initialSync: "start_initial_cloud_sync"
        case .packages: "install_default_packages"
        case .gitInitialize: "git_init"
        case .personalize: "personalize_hq"
        case .importExisting, .menuBar: nil
        case .indexing: "register_search_index"
        }
    }

    var builtInExplanation: String? {
        switch self {
        case .importExisting:
            "Built in: the retired legacy import command was an explicit no-op."
        case .menuBar:
            "Built in: this native app already owns its MenuBarExtra."
        default:
            nil
        }
    }
}

enum HQSetupStageStatus: String, Equatable, Sendable {
    case pending
    case running
    case complete
    case failed
    case unavailable

    var displayValue: String {
        switch self {
        case .pending: "Pending"
        case .running: "Running"
        case .complete: "Done"
        case .failed: "Failed"
        case .unavailable: "Unavailable"
        }
    }
}

struct HQSetupStage: Identifiable, Equatable, Sendable {
    let id: HQSetupStageID
    var status: HQSetupStageStatus
    var detail: String

    static var initial: [HQSetupStage] {
        HQSetupStageID.allCases.map {
            HQSetupStage(
                id: $0,
                status: .pending,
                detail: $0.builtInExplanation
                    ?? "Waiting to run through the bundled HQ engine."
            )
        }
    }
}

struct HQLiveSession: Identifiable, Equatable, Sendable {
    let id: String
    let title: String
    let provider: String
    let status: String
    let company: String?
    let project: String?
}

enum HQTrayState: String, Equatable, Sendable {
    case current
    case syncing
    case attention
    case error
}

struct HQLiveRouteContent: Equatable, Sendable {
    let title: String
    let subtitle: String
    let symbolName: String
    let rows: [HQWindowRowFixture]
    let notice: String?
}

enum HQLiveRouteState: Equatable, Sendable {
    case loading
    case content(HQLiveRouteContent)
    case empty(HQWindowEmptyState)
    case failure(HQWindowFailureState)
}

private struct HQLiveRouteRequest: Sendable {
    let method: String
    let params: HQJSONValue
}

private struct HQLiveRouteDescriptor: Sendable {
    let title: String
    let subtitle: String
    let symbolName: String
    let emptyTitle: String
    let emptyMessage: String
    let requests: [HQLiveRouteRequest]
    let preflightState: HQLiveRouteState?
}

enum HQRecallEventName: String, CaseIterable, Equatable, Sendable {
    case meetingDetected = "meeting:detected"
    case meetingClosed = "meeting:closed"
    case permissionStatus = "permission:status"
    case permissionsAllGranted = "permissions:all-granted"
    case recordingStarted = "recording:started"
    case recordingEnded = "recording:ended"
    case recordingMediaCapture = "recording:media-capture"
    case recordingError = "recording:error"
}

enum HQRecallMeetingPlatform: String, Equatable, Sendable {
    case zoom
    case meet
    case teams
    case slack
    case webex
    case other
}

enum HQRecallPermission: String, Equatable, Hashable, Sendable {
    case accessibility
    case screenCapture = "screen-capture"
    case microphone
    case systemAudio = "system-audio"
    case fullDiskAccess = "full-disk-access"
}

struct HQRecallMeetingDetection: Equatable, Sendable {
    let detectionID: String
    let meetingURL: String
    let windowID: String?
    let platform: HQRecallMeetingPlatform
    let detectedAt: String
    let source: String
    let sourceEventID: String?
}

struct HQRecallMeetingClosure: Equatable, Sendable {
    let windowID: String
    let platform: HQRecallMeetingPlatform
    let closedAt: String
}

struct HQRecallPermissionUpdate: Equatable, Sendable {
    let permission: HQRecallPermission
    let status: String
}

struct HQRecallRecordingStarted: Equatable, Sendable {
    let windowID: String
    let platform: HQRecallMeetingPlatform
    let startedAt: String
}

struct HQRecallRecordingEnded: Equatable, Sendable {
    let windowID: String
    let platform: HQRecallMeetingPlatform
    let endedAt: String
}

struct HQRecallMediaCapture: Equatable, Sendable {
    let windowID: String
    let captureType: String
    let capturing: Bool
}

struct HQRecallRecordingError: Equatable, Sendable {
    let command: String
    let windowID: String
    let message: String
}

enum HQRecallEventPayload: Equatable, Sendable {
    case meetingDetected(HQRecallMeetingDetection)
    case meetingClosed(HQRecallMeetingClosure)
    case permissionStatus(HQRecallPermissionUpdate)
    case permissionsAllGranted
    case recordingStarted(HQRecallRecordingStarted)
    case recordingEnded(HQRecallRecordingEnded)
    case recordingMediaCapture(HQRecallMediaCapture)
    case recordingError(HQRecallRecordingError)
}

struct HQRecallEventRecord: Equatable, Sendable {
    let name: HQRecallEventName
    let sequence: UInt64
    let payload: HQRecallEventPayload

    init?(event: HQEngineEvent) {
        guard let name = HQRecallEventName(rawValue: event.name),
              let object = event.data?.object
        else {
            return nil
        }

        func required(_ key: String) -> String? {
            guard let value = object.string(for: key), !value.isEmpty else {
                return nil
            }
            return value
        }

        let decoded: HQRecallEventPayload
        switch name {
        case .meetingDetected:
            guard let detectionID = required("detectionId"),
                  let meetingURL = required("meetingUrl"),
                  let platformValue = required("platform"),
                  let platform = HQRecallMeetingPlatform(
                      rawValue: platformValue
                  ),
                  let detectedAt = required("detectedAt"),
                  let source = required("source"),
                  source == "sdk-active-app"
            else {
                return nil
            }
            decoded = .meetingDetected(
                HQRecallMeetingDetection(
                    detectionID: detectionID,
                    meetingURL: meetingURL,
                    windowID: object.string(for: "windowId"),
                    platform: platform,
                    detectedAt: detectedAt,
                    source: source,
                    sourceEventID: object.string(for: "sourceEventId")
                )
            )
        case .meetingClosed:
            guard let windowID = required("windowId"),
                  let platformValue = required("platform"),
                  let platform = HQRecallMeetingPlatform(
                      rawValue: platformValue
                  ),
                  let closedAt = required("closedAt")
            else {
                return nil
            }
            decoded = .meetingClosed(
                HQRecallMeetingClosure(
                    windowID: windowID,
                    platform: platform,
                    closedAt: closedAt
                )
            )
        case .permissionStatus:
            guard let permissionValue = required("permission"),
                  let permission = HQRecallPermission(
                      rawValue: permissionValue
                  ),
                  let status = required("status")
            else {
                return nil
            }
            decoded = .permissionStatus(
                HQRecallPermissionUpdate(
                    permission: permission,
                    status: status
                )
            )
        case .permissionsAllGranted:
            decoded = .permissionsAllGranted
        case .recordingStarted:
            guard let windowID = required("windowId"),
                  let platformValue = required("platform"),
                  let platform = HQRecallMeetingPlatform(
                      rawValue: platformValue
                  ),
                  let startedAt = required("startedAt")
            else {
                return nil
            }
            decoded = .recordingStarted(
                HQRecallRecordingStarted(
                    windowID: windowID,
                    platform: platform,
                    startedAt: startedAt
                )
            )
        case .recordingEnded:
            guard let windowID = required("windowId"),
                  let platformValue = required("platform"),
                  let platform = HQRecallMeetingPlatform(
                      rawValue: platformValue
                  ),
                  let endedAt = required("endedAt")
            else {
                return nil
            }
            decoded = .recordingEnded(
                HQRecallRecordingEnded(
                    windowID: windowID,
                    platform: platform,
                    endedAt: endedAt
                )
            )
        case .recordingMediaCapture:
            guard let windowID = required("windowId"),
                  let captureType = required("captureType"),
                  let capturing = object.bool(for: "capturing")
            else {
                return nil
            }
            decoded = .recordingMediaCapture(
                HQRecallMediaCapture(
                    windowID: windowID,
                    captureType: captureType,
                    capturing: capturing
                )
            )
        case .recordingError:
            guard let command = required("cmd"),
                  let windowID = required("windowId"),
                  let message = required("message")
            else {
                return nil
            }
            decoded = .recordingError(
                HQRecallRecordingError(
                    command: command,
                    windowID: windowID,
                    message: message
                )
            )
        }

        self.name = name
        sequence = event.sequence
        payload = decoded
    }
}

enum HQDMRequestState: String, CaseIterable, Equatable, Sendable {
    case active
    case declined
    case blocked
    case resolved
}

struct HQDMRequestUpdateRecord: Equatable, Sendable {
    static let eventName = "dm:request-update"

    let pairKey: String
    let state: HQDMRequestState
    let sequence: UInt64

    init?(event: HQEngineEvent) {
        guard event.name == Self.eventName,
              let object = event.data?.object,
              let pairKey = object.string(for: "pairKey"),
              !pairKey.isEmpty,
              let stateValue = object.string(for: "state"),
              let state = HQDMRequestState(rawValue: stateValue)
        else {
            return nil
        }
        self.pairKey = pairKey
        self.state = state
        sequence = event.sequence
    }
}

enum HQCloudRealtimeEventName: String, CaseIterable, Equatable, Sendable {
    case directMessages = "dm:new-events"
    case unreadSummary = "dm:unread-summary"
    case requestNew = "dm:request-new"
    case channelNewMessage = "channel:new-message"
    case channelUpdated = "channel:updated"
    case threadNewReply = "thread:new-reply"
    case messageReaction = "message:reaction"
    case shareEvents = "share:events-list"
    case reauthenticationRequired = "auth:reauth-required"
}

struct HQRealtimeDirectMessage: Equatable, Sendable {
    let eventID: String
    let fromPersonUID: String
    let fromEmail: String
    let fromDisplayName: String
    let body: String
    let details: String?
    let prompt: String?
    let createdAt: String

    init?(value: HQJSONValue) {
        guard let object = value.object,
              let eventID = object.string(for: "eventId"),
              !eventID.isEmpty,
              let fromPersonUID = object.string(for: "fromPersonUid"),
              !fromPersonUID.isEmpty,
              let fromEmail = object.string(for: "fromEmail"),
              let fromDisplayName = object.string(for: "fromDisplayName"),
              let body = object.string(for: "body"),
              let createdAt = object.string(for: "createdAt"),
              !createdAt.isEmpty
        else {
            return nil
        }
        if let detailsValue = object["details"],
           detailsValue != .null,
           detailsValue.stringValue == nil
        {
            return nil
        }
        if let promptValue = object["prompt"],
           promptValue != .null,
           promptValue.stringValue == nil
        {
            return nil
        }
        self.eventID = eventID
        self.fromPersonUID = fromPersonUID
        self.fromEmail = fromEmail
        self.fromDisplayName = fromDisplayName
        self.body = body
        details = object.string(for: "details")
        prompt = object.string(for: "prompt")
        self.createdAt = createdAt
    }

    var json: HQJSONValue {
        .object([
            "eventId": .string(eventID),
            "fromPersonUid": .string(fromPersonUID),
            "fromEmail": .string(fromEmail),
            "fromDisplayName": .string(fromDisplayName),
            "body": .string(body),
            "details": details.map(HQJSONValue.string) ?? .null,
            "prompt": prompt.map(HQJSONValue.string) ?? .null,
            "createdAt": .string(createdAt),
        ])
    }
}

struct HQRealtimeDMRequest: Equatable, Sendable {
    let pairKey: String
    let fromPersonUID: String
    let fromEmail: String
    let fromDisplayName: String
    let message: String?
    let sharedCompany: String?
    let createdAt: String

    init?(value: HQJSONValue) {
        guard let object = value.object,
              let pairKey = object.string(for: "pairKey"),
              !pairKey.isEmpty,
              let fromPersonUID = object.string(for: "fromPersonUid"),
              !fromPersonUID.isEmpty,
              let fromEmail = object.string(for: "fromEmail"),
              let fromDisplayName = object.string(for: "fromDisplayName"),
              let createdAt = object.string(for: "createdAt"),
              !createdAt.isEmpty
        else {
            return nil
        }
        if let messageValue = object["message"],
           messageValue != .null,
           messageValue.stringValue == nil
        {
            return nil
        }
        if let companyValue = object["sharedCompany"],
           companyValue != .null,
           companyValue.stringValue == nil
        {
            return nil
        }
        self.pairKey = pairKey
        self.fromPersonUID = fromPersonUID
        self.fromEmail = fromEmail
        self.fromDisplayName = fromDisplayName
        message = object.string(for: "message")
        sharedCompany = object.string(for: "sharedCompany")
        self.createdAt = createdAt
    }

    var json: HQJSONValue {
        .object([
            "pairKey": .string(pairKey),
            "fromPersonUid": .string(fromPersonUID),
            "fromEmail": .string(fromEmail),
            "fromDisplayName": .string(fromDisplayName),
            "message": message.map(HQJSONValue.string) ?? .null,
            "sharedCompany": sharedCompany.map(HQJSONValue.string) ?? .null,
            "createdAt": .string(createdAt),
        ])
    }
}

struct HQRealtimeUnreadSummary: Equatable, Sendable {
    let unreadDMs: Int
    let pendingRequests: Int

    init?(value: HQJSONValue) {
        guard let object = value.object,
              let unreadDMs = Self.nonnegativeInteger(
                  object["unreadDms"]
              ),
              let pendingRequests = Self.nonnegativeInteger(
                  object["pendingRequests"]
              )
        else {
            return nil
        }
        self.unreadDMs = unreadDMs
        self.pendingRequests = pendingRequests
    }

    private static func nonnegativeInteger(
        _ value: HQJSONValue?
    ) -> Int? {
        guard let number = value?.numberValue,
              number.isFinite,
              number >= 0,
              number.rounded() == number,
              number <= Double(Int.max)
        else {
            return nil
        }
        return Int(number)
    }
}

struct HQRealtimeChannelMessage: Equatable, Sendable {
    let channelID: String
    let unread: Int

    init?(value: HQJSONValue) {
        guard let object = value.object,
              let channelID = object.string(for: "channelId"),
              !channelID.isEmpty,
              let summary = HQRealtimeUnreadSummary(
                  value: .object([
                      "unreadDms": object["unread"] ?? .null,
                      "pendingRequests": .number(0),
                  ])
              )
        else {
            return nil
        }
        self.channelID = channelID
        unread = summary.unreadDMs
    }
}

struct HQRealtimeChannel: Equatable, Sendable {
    let channelID: String
    let name: String
    let scope: String
    let unread: Int?
    let json: HQJSONValue

    init?(value: HQJSONValue) {
        guard let object = value.object,
              let channelID = object.string(for: "channelId"),
              !channelID.isEmpty,
              let name = object.string(for: "name"),
              let scope = object.string(for: "scope")
        else {
            return nil
        }
        let unread: Int?
        if let rawUnread = object["unread"] {
            guard let decoded = HQRealtimeUnreadSummary(
                value: .object([
                    "unreadDms": rawUnread,
                    "pendingRequests": .number(0),
                ])
            ) else {
                return nil
            }
            unread = decoded.unreadDMs
        } else {
            unread = nil
        }
        self.channelID = channelID
        self.name = name
        self.scope = scope
        self.unread = unread
        json = value
    }
}

struct HQRealtimeThreadReply: Equatable, Sendable {
    let eventID: String
    let fromPersonUID: String
    let fromDisplayName: String
    let body: String
    let createdAt: String
    let json: HQJSONValue

    init?(value: HQJSONValue) {
        guard let object = value.object,
              let eventID = object.string(for: "eventId"),
              !eventID.isEmpty,
              let fromPersonUID = object.string(for: "fromPersonUid"),
              !fromPersonUID.isEmpty,
              let body = object.string(for: "body"),
              let createdAt = object.string(for: "createdAt"),
              !createdAt.isEmpty
        else {
            return nil
        }
        self.eventID = eventID
        self.fromPersonUID = fromPersonUID
        fromDisplayName = object.string(for: "fromDisplayName") ?? ""
        self.body = body
        self.createdAt = createdAt
        json = value
    }
}

struct HQRealtimeThreadUpdate: Equatable, Sendable {
    let rootEventID: String
    let reply: HQRealtimeThreadReply
    let replyCount: Int

    init?(value: HQJSONValue) {
        guard let object = value.object,
              let rootEventID = object.string(for: "rootEventId"),
              !rootEventID.isEmpty,
              let replyValue = object["reply"],
              let reply = HQRealtimeThreadReply(value: replyValue),
              let count = HQRealtimeUnreadSummary(
                  value: .object([
                      "unreadDms": object["replyCount"] ?? .null,
                      "pendingRequests": .number(0),
                  ])
              )?.unreadDMs
        else {
            return nil
        }
        self.rootEventID = rootEventID
        self.reply = reply
        replyCount = count
    }
}

struct HQRealtimeReaction: Equatable, Sendable {
    let emoji: String
    let count: Int
    let reactedByCurrentUser: Bool

    init?(value: HQJSONValue) {
        guard let object = value.object,
              let emoji = object.string(for: "emoji"),
              !emoji.isEmpty,
              let count = HQRealtimeUnreadSummary(
                  value: .object([
                      "unreadDms": object["count"] ?? .null,
                      "pendingRequests": .number(0),
                  ])
              )?.unreadDMs,
              let reacted = object.bool(for: "reactedByMe")
        else {
            return nil
        }
        self.emoji = emoji
        self.count = count
        reactedByCurrentUser = reacted
    }
}

struct HQRealtimeReactionUpdate: Equatable, Sendable {
    let messageScope: String
    let messageID: String
    let reactions: [HQRealtimeReaction]

    init?(value: HQJSONValue) {
        guard let object = value.object,
              let messageScope = object.string(for: "messageScope"),
              !messageScope.isEmpty,
              let messageID = object.string(for: "messageId"),
              !messageID.isEmpty,
              let values = object["reactions"]?.arrayValue
        else {
            return nil
        }
        let reactions = values.compactMap(HQRealtimeReaction.init(value:))
        guard reactions.count == values.count else {
            return nil
        }
        self.messageScope = messageScope
        self.messageID = messageID
        self.reactions = reactions
    }
}

struct HQRealtimeShare: Equatable, Sendable {
    let eventID: String
    let issuerEmail: String
    let issuerDisplayName: String
    let issuerPersonUID: String
    let paths: [String]
    let note: String?
    let permission: String
    let createdAt: String
    let json: HQJSONValue

    init?(value: HQJSONValue) {
        guard let object = value.object,
              let eventID = object.string(for: "eventId"),
              !eventID.isEmpty,
              let issuerEmail = object.string(for: "issuerEmail"),
              let issuerDisplayName = object.string(
                  for: "issuerDisplayName"
              ),
              let issuerPersonUID = object.string(for: "issuerPersonUid"),
              let pathValues = object["paths"]?.arrayValue,
              let permission = object.string(for: "permission"),
              !permission.isEmpty,
              let createdAt = object.string(for: "createdAt"),
              !createdAt.isEmpty
        else {
            return nil
        }
        let paths = pathValues.compactMap(\.stringValue)
        guard paths.count == pathValues.count, !paths.isEmpty else {
            return nil
        }
        if let noteValue = object["note"],
           noteValue != .null,
           noteValue.stringValue == nil
        {
            return nil
        }
        self.eventID = eventID
        self.issuerEmail = issuerEmail
        self.issuerDisplayName = issuerDisplayName
        self.issuerPersonUID = issuerPersonUID
        self.paths = paths
        note = object.string(for: "note")
        self.permission = permission
        self.createdAt = createdAt
        json = value
    }
}

enum HQCloudRealtimeEventPayload: Equatable, Sendable {
    case directMessages([HQRealtimeDirectMessage])
    case unreadSummary(HQRealtimeUnreadSummary)
    case requestNew(HQRealtimeDMRequest)
    case channelNewMessage(HQRealtimeChannelMessage)
    case channelUpdated(HQRealtimeChannel)
    case threadNewReply(HQRealtimeThreadUpdate)
    case messageReaction(HQRealtimeReactionUpdate)
    case shareEvents([HQRealtimeShare])
    case reauthenticationRequired
}

struct HQCloudRealtimeEventRecord: Equatable, Sendable {
    let name: HQCloudRealtimeEventName
    let sequence: UInt64
    let payload: HQCloudRealtimeEventPayload

    init?(event: HQEngineEvent) {
        guard let name = HQCloudRealtimeEventName(rawValue: event.name),
              let data = event.data
        else {
            return nil
        }

        let payload: HQCloudRealtimeEventPayload
        switch name {
        case .directMessages:
            guard let values = data.arrayValue else { return nil }
            let messages = values.compactMap(
                HQRealtimeDirectMessage.init(value:)
            )
            guard messages.count == values.count, !messages.isEmpty else {
                return nil
            }
            payload = .directMessages(messages)
        case .unreadSummary:
            guard let summary = HQRealtimeUnreadSummary(value: data) else {
                return nil
            }
            payload = .unreadSummary(summary)
        case .requestNew:
            guard let request = HQRealtimeDMRequest(value: data) else {
                return nil
            }
            payload = .requestNew(request)
        case .channelNewMessage:
            guard let update = HQRealtimeChannelMessage(value: data) else {
                return nil
            }
            payload = .channelNewMessage(update)
        case .channelUpdated:
            guard let channel = HQRealtimeChannel(value: data) else {
                return nil
            }
            payload = .channelUpdated(channel)
        case .threadNewReply:
            guard let update = HQRealtimeThreadUpdate(value: data) else {
                return nil
            }
            payload = .threadNewReply(update)
        case .messageReaction:
            guard let update = HQRealtimeReactionUpdate(value: data) else {
                return nil
            }
            payload = .messageReaction(update)
        case .shareEvents:
            guard let values = data.arrayValue else { return nil }
            let shares = values.compactMap(HQRealtimeShare.init(value:))
            guard shares.count == values.count, !shares.isEmpty else {
                return nil
            }
            payload = .shareEvents(shares)
        case .reauthenticationRequired:
            guard data == .null else { return nil }
            payload = .reauthenticationRequired
        }
        self.name = name
        sequence = event.sequence
        self.payload = payload
    }
}

enum HQActivityEventName: String, CaseIterable, Equatable, Sendable {
    case append = "activity:append"
    case list = "activity:list"
}

enum HQActivityDirection: String, Equatable, Sendable {
    case up
    case down
    case deleted
}

struct HQSyncActivityEntry: Equatable, Sendable {
    let company: String
    let path: String
    let bytes: UInt64
    let direction: HQActivityDirection
    let author: String?
    let isNew: Bool?
    let at: UInt64

    init?(value: HQJSONValue) {
        guard let object = value.object,
              let company = object.string(for: "company"),
              !company.isEmpty,
              let path = object.string(for: "path"),
              !path.isEmpty,
              let bytesValue = object["bytes"]?.numberValue,
              bytesValue.isFinite,
              bytesValue >= 0,
              bytesValue.rounded() == bytesValue,
              bytesValue <= Double(UInt64.max),
              let directionValue = object.string(for: "direction"),
              let direction = HQActivityDirection(
                  rawValue: directionValue
              ),
              let atValue = object["at"]?.numberValue,
              atValue.isFinite,
              atValue >= 0,
              atValue.rounded() == atValue,
              atValue <= Double(UInt64.max)
        else {
            return nil
        }
        self.company = company
        self.path = path
        bytes = UInt64(bytesValue)
        self.direction = direction
        author = object.string(for: "author")
        isNew = object["isNew"]?.boolValue
        at = UInt64(atValue)
    }

    var json: HQJSONValue {
        .object([
            "company": .string(company),
            "path": .string(path),
            "bytes": .number(Double(bytes)),
            "direction": .string(direction.rawValue),
            "author": author.map(HQJSONValue.string) ?? .null,
            "isNew": isNew.map(HQJSONValue.bool) ?? .null,
            "at": .number(Double(at)),
        ])
    }
}

enum HQActivityEventPayload: Equatable, Sendable {
    case append(HQSyncActivityEntry)
    case list([HQSyncActivityEntry])
}

struct HQActivityEventRecord: Equatable, Sendable {
    let name: HQActivityEventName
    let sequence: UInt64
    let payload: HQActivityEventPayload

    init?(event: HQEngineEvent) {
        guard let name = HQActivityEventName(rawValue: event.name),
              let data = event.data
        else {
            return nil
        }

        let payload: HQActivityEventPayload
        switch name {
        case .append:
            guard let entry = HQSyncActivityEntry(value: data) else {
                return nil
            }
            payload = .append(entry)
        case .list:
            guard let values = data.arrayValue else {
                return nil
            }
            let entries = values.compactMap(HQSyncActivityEntry.init(value:))
            guard entries.count == values.count else {
                return nil
            }
            payload = .list(entries)
        }
        self.name = name
        sequence = event.sequence
        self.payload = payload
    }
}

private enum HQNativeCompatibilityError: LocalizedError {
    case workspaceUnavailable
    case invalidWorkspaceRoot(String)
    case missingWorkspacePath(String)
    case workspacePathEscapesRoot(String)

    var errorDescription: String? {
        switch self {
        case .workspaceUnavailable:
            return "The HQ workspace folder is unavailable."
        case let .invalidWorkspaceRoot(path):
            return "The HQ workspace folder does not exist: \(path)"
        case let .missingWorkspacePath(path):
            return "The requested workspace path does not exist: \(path)"
        case let .workspacePathEscapesRoot(path):
            return "The requested path escapes the HQ workspace: \(path)"
        }
    }
}

enum HQActiveBannerPayload: Equatable, Sendable {
    case syncComplete(company: String, message: String)
    case meetingReady(
        title: String,
        message: String,
        windowID: String?,
        meetingID: String?,
        platform: String
    )
    case directMessage(HQRealtimeDirectMessage)
    case updateAvailable(version: String, body: String?)

    var kind: HQBannerKind {
        switch self {
        case .syncComplete:
            return .syncComplete
        case .meetingReady:
            return .meetingReady
        case .directMessage:
            return .directMessage
        case .updateAvailable:
            return .updateAvailable
        }
    }
}

enum HQOAuthFlowState: Equatable, Sendable {
    case idle
    case starting(provider: String)
    case waiting(provider: String, state: String)
    case exchanging(provider: String, state: String)
    case cancelling(provider: String?, state: String?)

    var isActive: Bool {
        self != .idle
    }

    var pendingState: String? {
        switch self {
        case let .waiting(_, state),
             let .exchanging(_, state):
            return state
        case let .cancelling(_, state):
            return state
        case .idle, .starting:
            return nil
        }
    }
}

@MainActor
private final class HQAsyncSerialGate {
    private var isHeld = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func acquire() async {
        guard isHeld else {
            isHeld = true
            return
        }
        await withCheckedContinuation { continuation in
            waiters.append(continuation)
        }
    }

    func release() {
        guard !waiters.isEmpty else {
            isHeld = false
            return
        }
        waiters.removeFirst().resume()
    }
}

@MainActor
final class HQAppStore: ObservableObject {
    @Published private(set) var phase: HQAppPhase = .idle
    @Published private(set) var content: HQShellFixture
    @Published var selectedRoute: HQRoute
    @Published private(set) var selectedSyncWorkspaceSlug: String?
    @Published var capabilities: Set<String> = []
    @Published private(set) var operationState: HQOperationState = .idle
    @Published private(set) var sessions: [HQLiveSession] = []
    @Published private(set) var isAuthenticated = false
    @Published private(set) var config: HQJSONValue = .object([:])
    @Published private(set) var authState: HQJSONValue = .object([:])
    @Published private(set) var syncState: HQJSONValue = .object([:])
    @Published private(set) var hqFolderPath: String?
    @Published private(set) var setupStages = HQSetupStage.initial
    @Published private(set) var setupIsRunning = false
    @Published private(set) var readySceneIDs: Set<String> = []
    @Published private(set) var sceneRequest: HQAppSceneRequest?
    @Published private(set) var activeBannerKind: HQBannerKind = .directMessage
    @Published private(set) var activeBannerPayload: HQActiveBannerPayload?
    @Published private(set) var isBannerPresented = false
    @Published var isCommandPalettePresented = false
    @Published private(set) var widgetMode: HQWidgetMode = .expanded
    @Published private(set) var widgetIsFocusable = true
    @Published private(set) var meetingPermissionSnapshot =
        HQMeetingPermissionSnapshot.unknown
    @Published private(set) var trayState: HQTrayState = .current
    @Published private(set) var menuBarHandoffGeneration = 0
    @Published private(set) var meetingPromptBadgeVisible = false
    @Published private(set) var focusedMeetingID: String?
    @Published private(set) var mainWindowVibrancyEnabled = true
    @Published private(set) var lastNativeResult: HQJSONValue?
    @Published private(set) var nativeEventHistory: [HQNativeEventRecord] = []
    @Published private(set) var widgetIsOccluded = false
    @Published private(set) var didShutdown = false
    @Published private(set) var secondaryDomainValues: [String: HQJSONValue] = [:]
    @Published private(set) var secondaryDomainFailures: [String: String] = [:]
    @Published private(set) var secondaryDomainLoading: Set<String> = []
    @Published private(set) var liveRouteStates: [HQRoute: HQLiveRouteState] = [:]
    @Published private(set) var recallEventHistory: [HQRecallEventRecord] = []
    @Published private(set) var detectedMeetings: [
        String: HQRecallMeetingDetection
    ] = [:]
    @Published private(set) var recallPermissionStatuses: [
        HQRecallPermission: String
    ] = [:]
    @Published private(set) var allRecallPermissionsGranted = false
    @Published private(set) var activeRecallRecordings: [
        String: HQRecallRecordingStarted
    ] = [:]
    @Published private(set) var lastRecallRecordingEnded: HQRecallRecordingEnded?
    @Published private(set) var recallMediaCapture: [
        String: HQRecallMediaCapture
    ] = [:]
    @Published private(set) var lastRecallRecordingError: HQRecallRecordingError?
    @Published private(set) var dmRequestUpdateHistory: [
        HQDMRequestUpdateRecord
    ] = []
    @Published private(set) var syncActivityEntries: [
        HQSyncActivityEntry
    ] = []
    @Published private(set) var activityEventHistory: [
        HQActivityEventRecord
    ] = []
    @Published private(set) var cloudRealtimeEventHistory: [
        HQCloudRealtimeEventRecord
    ] = []
    @Published private(set) var channelUnreadByID: [String: Int] = [:]
    @Published private(set) var threadReplies: [
        String: [HQRealtimeThreadReply]
    ] = [:]
    @Published private(set) var threadReplyCounts: [String: Int] = [:]
    @Published private(set) var messageReactionState: [
        String: [String: [HQRealtimeReaction]]
    ] = [:]
    @Published private(set) var nativeNotificationHistory: [
        HQNotificationPayload
    ] = []
    @Published private(set) var requiresReauthentication = false
    @Published private(set) var oauthFlowState: HQOAuthFlowState = .idle
    @Published private(set) var updaterState: HQUpdaterState =
        .idle(channel: .stable)
    @Published private(set) var updaterStartupFailure: String?
    @Published private(set) var unreadDMMessages = 0
    @Published private(set) var pendingDMRequests = 0
    @Published private(set) var selectedMessagesConversation:
        HQMessagesSelectionRequest?
    @Published private(set) var nativeParityEvents =
        HQNativeParityEventConsumer()

    var messageBadgeCount: Int {
        unreadDMMessages
            + pendingDMRequests
            + channelUnreadByID.values.reduce(0, +)
    }

    var menuBarSymbolName: String {
        switch trayState {
        case .syncing:
            return "arrow.triangle.2.circlepath.circle.fill"
        case .attention:
            return "exclamationmark.circle.fill"
        case .error:
            return "xmark.octagon.fill"
        case .current:
            return phase == .ready ? "h.circle.fill" : "h.circle"
        }
    }

    var menuBarAccessibilityValue: String {
        switch trayState {
        case .syncing:
            return "Syncing"
        case .attention:
            return menuBarHandoffGeneration > 0
                ? "HQ is ready in the menu bar"
                : "Needs attention"
        case .error:
            return "Error"
        case .current:
            return phase == .ready ? "Current" : "Connecting"
        }
    }

    let launchMode: HQLaunchMode

    private var hasProtectedAccess: Bool {
        isAuthenticated
            || launchMode.usesFixtures
            || (
                allowsUnresolvedAuthenticationForTesting
                    && !authenticationStateResolved
            )
    }

    private var engine: (any HQAppEngine)?
    private let engineFactory: HQAppEngineFactory?
    private var bootstrapFailure: String?
    private let openExternalURL: @MainActor (URL) throws -> Void
    private let pickFiles: @MainActor (HQFilePickerRequest) -> [URL]
    private let openWorkspaceURL: @MainActor (URL) throws -> Void
    private let privacyAuthorization:
        @MainActor (HQPrivacyCapability) -> HQPrivacyAuthorization
    private let accessibilityIsTrusted: @MainActor () -> Bool
    private let openSystemSettings:
        @MainActor (HQSystemSettingsDestination) throws -> Void
    private let persistWidgetMode: @MainActor (HQWidgetMode) -> Void
    private let keychainStore: HQKeychainStore
    private let injectedNotificationService: HQNativeNotificationService?
    private let injectedUpdaterService: HQNativeUpdaterService?
    private let shutdownRequestTimeoutNanoseconds: UInt64
    private let allowsUnresolvedAuthenticationForTesting: Bool
    private var didStart = false
    private var authenticationStateResolved = false
    private var didApplyLaunchArguments = false
    private var engineGeneration: UInt64 = 0
    private var authenticatedDataGeneration: UInt64 = 0
    private var eventTask: Task<Void, Never>?
    private var lifecycleTask: Task<Void, Never>?
    private var consumedSceneRequestIDs: Set<UUID> = []
    private var pendingMeetingFocusID: String?
    private var meetingPromptBadgeCount = 0
    private var nativeUIEventSequence: UInt64 = 0
    private var nativeConversationLoadGeneration = 0
    private var pendingMessagesTarget: HQNativeConversationTarget?
    private var selectedChannelID: String?
    @Published private(set) var activeMutationKeys: Set<String> = []
    private var activeMeetingWindowMutations: Set<String> = []
    private var activeRecordingStartWindows: Set<String> = []
    private var pendingRecordingCleanup:
        [String: HQRecallRecordingStarted] = [:]
    private var recordingCleanupTasks:
        [String: Task<Void, Never>] = [:]
    private var recordingReaperTask: Task<Void, Never>?
    private var recordingReaperGeneration: UInt64?
    private var workspaceOperationGeneration: UInt64 = 0
    private var oauthFlowGeneration: UInt64 = 0
    private var oauthInFlightGeneration: UInt64?
    private var oauthCancellationTask: Task<Void, Never>?
    private var notificationDeliveryTasks: [
        UUID: Task<Void, Never>
    ] = [:]
    private var bootstrapPreferredReleaseChannel: HQReleaseChannel?
    private var updaterDidStart = false
    private let folderWriteGate = HQAsyncSerialGate()
    private lazy var notificationService: HQNativeNotificationService = {
        let service =
            injectedNotificationService ?? HQNativeNotificationService()
        service.onResponse = { [weak self] response in
            self?.receiveNativeNotificationResponse(response)
        }
        return service
    }()
    private lazy var updaterService: HQNativeUpdaterService = {
        let service = injectedUpdaterService
            ?? HQNativeUpdaterService(driver: HQSparkleUpdaterDriver())
        service.onStateChange = { [weak self] state in
            self?.receiveUpdaterState(state)
        }
        return service
    }()

    init(
        engine: any HQAppEngine,
        engineFactory: HQAppEngineFactory? = nil,
        launchMode: HQLaunchMode = .live,
        initialRoute: HQRoute = HQLaunchConfiguration.initialRoute,
        keychainStore: HQKeychainStore = HQKeychainStore(),
        notificationService: HQNativeNotificationService? = nil,
        updaterService: HQNativeUpdaterService? = nil,
        openExternalURL: @escaping @MainActor (URL) throws -> Void = {
            try HQNativeWorkspaceService().openURL($0)
        },
        pickFiles: @escaping @MainActor (HQFilePickerRequest) -> [URL] = {
            HQNativeFilePicker().pick($0)
        },
        openWorkspaceURL: @escaping @MainActor (URL) throws -> Void = {
            try HQNativeWorkspaceService().openURL($0)
        },
        privacyAuthorization: @escaping @MainActor (
            HQPrivacyCapability
        ) -> HQPrivacyAuthorization = {
            HQNativePrivacyService().authorizationStatus(for: $0)
        },
        accessibilityIsTrusted: @escaping @MainActor () -> Bool = {
            AXIsProcessTrusted()
        },
        openSystemSettings: @escaping @MainActor (
            HQSystemSettingsDestination
        ) throws -> Void = {
            try HQNativePrivacyService().openSettings($0)
        },
        initialWidgetMode: HQWidgetMode? = nil,
        persistWidgetMode: @escaping @MainActor (HQWidgetMode) -> Void = {
            UserDefaults.standard.set(
                $0.rawValue,
                forKey: "hq.native.widget-mode"
            )
        },
        allowsUnresolvedAuthenticationForTesting: Bool = false,
        shutdownRequestTimeoutNanoseconds: UInt64 = 4_000_000_000
    ) {
        self.engine = engine
        self.engineFactory = engineFactory
        self.launchMode = launchMode
        self.openExternalURL = openExternalURL
        self.pickFiles = pickFiles
        self.openWorkspaceURL = openWorkspaceURL
        self.privacyAuthorization = privacyAuthorization
        self.accessibilityIsTrusted = accessibilityIsTrusted
        self.openSystemSettings = openSystemSettings
        self.persistWidgetMode = persistWidgetMode
        self.keychainStore = keychainStore
        injectedNotificationService = notificationService
        injectedUpdaterService = updaterService
        self.allowsUnresolvedAuthenticationForTesting =
            allowsUnresolvedAuthenticationForTesting
        self.shutdownRequestTimeoutNanoseconds =
            shutdownRequestTimeoutNanoseconds
        bootstrapFailure = nil
        selectedRoute = initialRoute
        content = launchMode.usesFixtures ? .preview : .liveEmpty
        widgetMode = initialWidgetMode
            ?? UserDefaults.standard.string(
                forKey: "hq.native.widget-mode"
            ).flatMap(HQWidgetMode.init(rawValue:))
            ?? .expanded
    }

    private init(
        engine: (any HQAppEngine)?,
        engineFactory: HQAppEngineFactory? = nil,
        launchMode: HQLaunchMode,
        initialRoute: HQRoute,
        bootstrapFailure: String?,
        shutdownRequestTimeoutNanoseconds: UInt64 = 4_000_000_000
    ) {
        self.engine = engine
        self.engineFactory = engineFactory
        self.launchMode = launchMode
        openExternalURL = {
            try HQNativeWorkspaceService().openURL($0)
        }
        pickFiles = {
            HQNativeFilePicker().pick($0)
        }
        openWorkspaceURL = {
            try HQNativeWorkspaceService().openURL($0)
        }
        privacyAuthorization = {
            HQNativePrivacyService().authorizationStatus(for: $0)
        }
        accessibilityIsTrusted = {
            AXIsProcessTrusted()
        }
        openSystemSettings = {
            try HQNativePrivacyService().openSettings($0)
        }
        persistWidgetMode = {
            UserDefaults.standard.set(
                $0.rawValue,
                forKey: "hq.native.widget-mode"
            )
        }
        keychainStore = HQKeychainStore()
        injectedNotificationService = nil
        injectedUpdaterService = nil
        allowsUnresolvedAuthenticationForTesting = false
        self.shutdownRequestTimeoutNanoseconds =
            shutdownRequestTimeoutNanoseconds
        self.bootstrapFailure = bootstrapFailure
        selectedRoute = initialRoute
        content = launchMode.usesFixtures ? .preview : .liveEmpty
        widgetMode = UserDefaults.standard.string(
            forKey: "hq.native.widget-mode"
        ).flatMap(HQWidgetMode.init(rawValue:)) ?? .expanded
    }

    static func makeDefault(
        arguments: [String] = CommandLine.arguments,
        bundle: Bundle = .main
    ) -> HQAppStore {
        let mode = HQLaunchMode.resolve(arguments: arguments)
        let route = HQLaunchConfiguration.initialRoute(arguments: arguments)

        if mode.usesFixtures {
            return HQAppStore(
                engine: nil,
                launchMode: mode,
                initialRoute: route,
                bootstrapFailure: nil
            )
        }

        let engineFactory: HQAppEngineFactory = {
            let transport = try HQProcessEngineTransport.bundled(
                bundle: bundle
            )
            return HQEngineClient(transport: transport)
        }

        do {
            return HQAppStore(
                engine: try engineFactory(),
                engineFactory: engineFactory,
                launchMode: .live,
                initialRoute: route,
                bootstrapFailure: nil
            )
        } catch {
            return HQAppStore(
                engine: nil,
                engineFactory: engineFactory,
                launchMode: .live,
                initialRoute: route,
                bootstrapFailure: Self.message(for: error)
            )
        }
    }

    func start() async {
        guard !didStart else { return }
        didStart = true

        if launchMode == .visualTourFixture {
            prepareVisualTourState()
            phase = .ready
            operationState = .success(
                "Deterministic production-surface tour loaded."
            )
            return
        }

        if launchMode.usesFixtures {
            phase = .ready
            operationState = .success("Explicit UI testing data loaded.")
            return
        }

        phase = .loading
        operationState = .busy("Connecting to the HQ engine…")

        if let bootstrapFailure {
            failStartup("The bundled HQ engine could not be created: \(bootstrapFailure)")
            return
        }
        guard let engine else {
            failStartup("The bundled HQ engine is unavailable.")
            return
        }
        let dataGeneration = authenticatedDataGeneration

        do {
            let handshake = try await engine.start()
            capabilities = Self.capabilities(from: handshake)

            async let configRequest = engine.request("config.get", params: .object([:]))
            async let authRequest = engine.request("auth.state", params: .object([:]))
            async let syncRequest = engine.request("sync.status", params: .object([:]))
            let (loadedConfig, loadedAuth, loadedSync) = try await (
                configRequest,
                authRequest,
                syncRequest
            )
            guard dataGeneration == authenticatedDataGeneration else {
                return
            }
            let authenticated =
                loadedAuth.object?["authenticated"]?.boolValue ?? false
            authenticationStateResolved = true
            bootstrapPreferredReleaseChannel = Self.releaseChannel(
                from: loadedConfig
            )
            guard authenticated else {
                config = .object([:])
                authState = loadedAuth
                syncState = .object([:])
                isAuthenticated = false
                requiresReauthentication =
                    loadedAuth.object?["reauthRequired"]?.boolValue ?? false
                hqFolderPath = nil
                sessions = []
                content = .liveEmpty
                phase = .ready
                operationState = .success(
                    "HQ is ready. Sign in to load protected workspace data."
                )
                listenForEvents(from: engine)
                startUpdaterAfterLiveBootstrap()
                return
            }

            async let workspaceRequest = engine.request(
                "workspaces.list",
                params: .object(["includeCloud": .bool(false)])
            )
            async let projectRequest = engine.request(
                "projects.list",
                params: .object([:])
            )
            async let sessionRequest = engine.request(
                "sessions.list",
                params: .object([:])
            )
            let (loadedWorkspaces, loadedProjects, loadedSessions) =
                try await (
                    workspaceRequest,
                    projectRequest,
                    sessionRequest
                )
            guard dataGeneration == authenticatedDataGeneration else {
                return
            }

            config = loadedConfig
            authState = loadedAuth
            syncState = loadedSync
            isAuthenticated = true
            hqFolderPath = loadedWorkspaces.object?["hqFolderPath"]?.stringValue
            let workspaces = Self.decodeWorkspaces(loadedWorkspaces)
            if let selectedSyncWorkspaceSlug,
               !workspaces.contains(where: {
                   $0.slug == selectedSyncWorkspaceSlug
               })
            {
                self.selectedSyncWorkspaceSlug = nil
            }
            let projects = Self.decodeProjects(loadedProjects, workspaces: workspaces)
            sessions = Self.decodeSessions(loadedSessions)
            content = HQShellFixture(
                snapshot: HQSnapshot(
                    workspaces: workspaces,
                    projects: projects,
                    goals: [:]
                ),
                messages: [],
                meetings: [],
                packs: [],
                libraryItems: [],
                people: [],
                activity: [],
                files: [],
                deployments: [],
                secrets: []
            )
            phase = .ready
            operationState = .success(
                "Loaded \(workspaces.count) workspaces, \(projects.count) projects, and \(sessions.count) sessions."
            )
            listenForEvents(from: engine)
            await loadSecondaryDomains(
                from: engine,
                companySlug: workspaces.first?.slug,
                generation: dataGeneration
            )
            startUpdaterAfterLiveBootstrap()
        } catch {
            failStartup(Self.message(for: error))
        }
    }

    func shutdown() async {
        guard !didShutdown else { return }
        didShutdown = true
        eventTask?.cancel()
        eventTask = nil
        lifecycleTask?.cancel()
        lifecycleTask = nil
        oauthCancellationTask?.cancel()
        oauthCancellationTask = nil
        for task in recordingCleanupTasks.values {
            task.cancel()
        }
        recordingCleanupTasks.removeAll()
        recordingReaperTask?.cancel()
        recordingReaperTask = nil
        recordingReaperGeneration = nil

        if let engine {
            if capabilities.contains("shutdown") {
                _ = try? await engine.request(
                    "shutdown",
                    params: .object([:]),
                    timeoutNanoseconds: shutdownRequestTimeoutNanoseconds
                )
            }
            await engine.stop()
        }

        phase = .idle
        operationState = .success("HQ engine stopped cleanly.")
    }

    func dispatch(_ action: HQAppAction) {
        Task {
            await perform(action)
        }
    }

    func perform(_ action: HQAppAction) async {
        switch action {
        case .refresh:
            await reloadLiveContent()
        case .syncNow:
            await requestSync()
        case .showCommandPalette:
            isCommandPalettePresented = true
        case let .navigate(route):
            selectedRoute = route
            sceneRequest = HQAppSceneRequest(sceneID: "main")
            operationState = .success("Opened \(HQRouteParser.serialize(route)).")
        case let .selectSyncWorkspace(slug):
            if let slug,
               !content.snapshot.workspaces.contains(where: {
                   $0.slug == slug
               })
            {
                operationState = .failure(
                    "The selected sync workspace is no longer available."
                )
                return
            }
            selectedSyncWorkspaceSlug = slug
            liveRouteStates.removeValue(forKey: .settings(.sync))
            if selectedRoute == .settings(.sync) {
                await loadLiveRoute(.settings(.sync))
            }
        case let .openScene(kind):
            sceneRequest = HQAppSceneRequest(sceneID: kind.rawValue)
        case .showMainWindow:
            sceneRequest = HQAppSceneRequest(sceneID: "main")
        case let .sceneReady(sceneID):
            await sceneDidBecomeReady(sceneID)
        case let .nativeCommand(command, payload):
            await performNative(command, payload: payload)
        case let .secondaryWindow(kind, actionID):
            await performSecondaryWindowAction(kind: kind, actionID: actionID)
        case let .activateBanner(payload):
            await performBannerNotificationAction(payload)
        case let .replyToDirectMessage(body):
            await sendNativeDirectMessageReply(body)
        case let .selectMessageConversation(request):
            selectNativeMessageConversation(request)
        case let .sendMessage(request):
            await sendNativeMessage(request)
        case let .engineCommand(command, params, successMessage):
            await requestMutation(
                method: command.rawValue,
                params: params,
                success: successMessage
            )
        case let .capabilityUnavailable(reason):
            operationState = .failure(reason)
        case let .nativeEvent(event, data):
            consumeNativeEvent(event, data: data)
        case let .setProjectStatus(boardPath, projectID, status):
            await requestMutation(
                method: "set_local_project_status",
                params: .object([
                    "boardPath": .string(boardPath),
                    "projectId": .string(projectID),
                    "status": .string(status),
                ]),
                success: "Project status updated."
            )
        case let .setStoryPasses(prdPath, storyID, passes):
            await requestMutation(
                method: "set_local_story_passes",
                params: .object([
                    "prdPath": .string(prdPath),
                    "storyId": .string(storyID),
                    "passes": .bool(passes),
                ]),
                success: passes ? "Story completed." : "Story reopened."
            )
        case let .installMarketplace(
            listingID,
            slug,
            version,
            scope
        ):
            await installMarketplacePack(
                listingID: listingID,
                slug: slug,
                version: version,
                scope: scope
            )
        }
    }

    private func consumeNativeEvent(
        _ event: HQNativeEvent,
        data: HQJSONValue
    ) {
        nativeEventHistory.append(
            HQNativeEventRecord(event: event, data: data)
        )
        switch event {
        case .bannerEvent:
            consumeBannerEvent(data)
        case .widgetClickAway:
            consumeWidgetClickAway(data)
        case .widgetNotification:
            consumeWidgetNotification(data)
        case .widgetOcclusion:
            consumeWidgetOcclusion(data)
        }
    }

    private func consumeBannerEvent(_ data: HQJSONValue) {
        if let presented = data.object?["presented"]?.boolValue {
            isBannerPresented = presented
        }
    }

    private func consumeWidgetClickAway(_ data: HQJSONValue) {
        widgetIsFocusable = false
        lastNativeResult = data
    }

    private func consumeWidgetNotification(_ data: HQJSONValue) {
        trayState = .attention
        lastNativeResult = data
    }

    private func consumeWidgetOcclusion(_ data: HQJSONValue) {
        widgetIsOccluded = data.object?["occluded"]?.boolValue ?? false
        lastNativeResult = data
    }

    func startAndApplyLaunchArguments(
        _ arguments: [String] = CommandLine.arguments
    ) async {
        await start()
        guard !didApplyLaunchArguments else { return }
        didApplyLaunchArguments = true

        for command in HQLaunchConfiguration.initialNativeCommands(arguments: arguments) {
            await perform(.nativeCommand(command))
            await Task.yield()
        }
        if let sceneID = HQLaunchConfiguration.initialScene(arguments: arguments),
           sceneID != "main"
        {
            sceneRequest = HQAppSceneRequest(sceneID: sceneID)
        }
    }

    func consume(_ request: HQAppSceneRequest) -> Bool {
        consumedSceneRequestIDs.insert(request.id).inserted
    }

    private func loadSecondaryDomains(
        from engine: any HQAppEngine,
        companySlug: String?,
        generation requestedGeneration: UInt64? = nil
    ) async {
        let dataGeneration =
            requestedGeneration ?? authenticatedDataGeneration
        guard dataGeneration == authenticatedDataGeneration else {
            return
        }
        var requests: [(method: String, params: HQJSONValue)] = []

        if capabilities.contains("get_lifecycle_state") {
            requests.append(("get_lifecycle_state", .object([:])))
        }
        if capabilities.contains("read_install_manifest") {
            requests.append(("read_install_manifest", .object([:])))
        }
        if isAuthenticated {
            if capabilities.contains("get_activity_log") {
                requests.append(("get_activity_log", .object([:])))
            }
            if capabilities.contains(
                HQEngineAppCommand.meetingsListAccounts.rawValue
            ) {
                requests.append((
                    HQEngineAppCommand.meetingsListAccounts.rawValue,
                    .object([:])
                ))
            }
            if capabilities.contains("list_channels") {
                requests.append(("list_channels", .object([:])))
            }
            if capabilities.contains("list_dm_requests") {
                requests.append(("list_dm_requests", .object([:])))
            }
            if capabilities.contains("get_unread_summary") {
                requests.append(("get_unread_summary", .object([:])))
            }
            if capabilities.contains("fetch_notification_history") {
                requests.append((
                    "fetch_notification_history",
                    .object(["limit": .number(100)])
                ))
            }
            if let companySlug,
               capabilities.contains("get_company_activity")
            {
                requests.append((
                    "get_company_activity",
                    .object(["slug": .string(companySlug)])
                ))
            }
        }

        let methods = Set(requests.map(\.method))
        secondaryDomainLoading.formUnion(methods)
        for method in methods {
            secondaryDomainFailures[method] = nil
        }

        let secondaryTasks = requests.map { request in
            Task { @MainActor [weak self] in
                let requiresAuthentication = ![
                    "get_lifecycle_state",
                    "read_install_manifest",
                ].contains(request.method)
                guard let self,
                      dataGeneration == self.authenticatedDataGeneration,
                      !requiresAuthentication || self.hasProtectedAccess
                else {
                    return (
                        method: request.method,
                        value: Optional<HQJSONValue>.none,
                        failure: Optional<String>.none
                    )
                }
                do {
                    return (
                        method: request.method,
                        value: try await engine.request(
                            request.method,
                            params: request.params
                        ),
                        failure: Optional<String>.none
                    )
                } catch {
                    return (
                        method: request.method,
                        value: Optional<HQJSONValue>.none,
                        failure: Self.message(for: error)
                    )
                }
            }
        }

        for task in secondaryTasks {
            let result = await task.value
            guard dataGeneration == authenticatedDataGeneration else {
                secondaryTasks.forEach { $0.cancel() }
                break
            }
            secondaryDomainLoading.remove(result.method)
            if let value = result.value {
                secondaryDomainValues[result.method] = value
                if result.method == "get_unread_summary" {
                    applyUnreadSummary(value)
                } else if result.method == "read_install_manifest" {
                    applyInstallManifest(value)
                }
            }
            if let failure = result.failure {
                secondaryDomainFailures[result.method] = failure
            }
        }
    }

    private func prepareVisualTourState() {
        isAuthenticated = true
        hqFolderPath = "/Users/corey/Documents/HQ"
        selectedSyncWorkspaceSlug = "indigo"
        setupStages = HQSetupStageID.allCases.enumerated().map {
            index, id in
            HQSetupStage(
                id: id,
                status: index < 5
                    ? .complete
                    : (index == 5 ? .running : .pending),
                detail: id.builtInExplanation
                    ?? (index < 5
                        ? "Completed by the bundled HQ engine."
                        : (index == 5
                            ? "Personalizing the native workspace."
                            : "Waiting for the preceding stage."))
            )
        }
        capabilities = Set(
            HQEngineAppCommand.allCases.map(\.rawValue)
                + [
                    "fetch_and_extract_template",
                    "fetch_notification_history",
                    "get_activity_log",
                    "get_company_activity",
                    "get_lifecycle_state",
                    "get_sync_mode",
                    "git_init",
                    "install_default_packages",
                    "install_deps",
                    "list_channels",
                    "list_dm_requests",
                    "list_marketplace_listings",
                    "list_moderation_queue",
                    "list_packages",
                    "meetings_list_accounts",
                    "personalize_hq",
                    "read_install_manifest",
                    "register_search_index",
                    "set_local_project_status",
                    "set_local_story_passes",
                    "start_initial_cloud_sync",
                ]
        )
        sessions = [
            HQLiveSession(
                id: "visual-session-codex",
                title: "Native macOS visual verification",
                provider: "Codex",
                status: "active",
                company: "Indigo",
                project: "native-macos"
            ),
            HQLiveSession(
                id: "visual-session-parker",
                title: "Creative system review",
                provider: "Claude",
                status: "idle",
                company: "Indigo",
                project: "creative-ops"
            ),
        ]
        secondaryDomainValues = [
            "get_lifecycle_state": .object([
                "changes": .array([
                    .object([
                        "id": .string("core-clean"),
                        "title": .string("HQ Core is verified"),
                        "detail": .string(
                            "Signed native components match the release."
                        ),
                        "status": .string("clean"),
                    ]),
                ]),
            ]),
            "meetings_list_accounts": .object([
                "accounts": .array([
                    .object([
                        "id": .string("calendar-native"),
                        "title": .string("Indigo Calendar"),
                        "detail": .string(
                            "Meeting capture is ready on this Mac."
                        ),
                        "status": .string("connected"),
                    ]),
                ]),
            ]),
            "list_channels": .object([
                "channels": .array([
                    .object([
                        "channelId": .string("native-app"),
                        "title": .string("# native-app"),
                        "preview": .string(
                            "The production SwiftUI tour is ready."
                        ),
                        "unreadCount": .number(2),
                    ]),
                ]),
            ]),
            "list_dm_requests": .object([
                "requests": .array([
                    .object([
                        "pairKey": .string("visual-request"),
                        "title": .string("Stefan"),
                        "detail": .string(
                            "Wants to start a native HQ conversation."
                        ),
                    ]),
                ]),
            ]),
            "fetch_notification_history": .object([
                "dms": .array([
                    .object([
                        "eventId": .string("visual-dm-caitlin"),
                        "fromPersonUid": .string("person-caitlin"),
                        "fromEmail": .string("caitlin@example.com"),
                        "fromDisplayName": .string("Caitlin"),
                        "body": .string(
                            "The production visual pass is ready."
                        ),
                        "createdAt": .string(
                            "2026-07-27T02:30:00Z"
                        ),
                    ]),
                    .object([
                        "eventId": .string("visual-dm-jacob"),
                        "fromPersonUid": .string("person-jacob"),
                        "fromEmail": .string("jacob@example.com"),
                        "fromDisplayName": .string("Jacob"),
                        "body": .string(
                            "Shared a fresh native interaction brief."
                        ),
                        "createdAt": .string(
                            "2026-07-27T02:25:00Z"
                        ),
                    ]),
                ]),
                "shares": .array([
                    .object([
                        "id": .string("visual-share"),
                        "title": .string("Native visual brief"),
                        "path": .string(
                            "knowledge/briefs/native-visual.md"
                        ),
                    ]),
                ]),
                "files": .array([
                    .object([
                        "id": .string("visual-file"),
                        "title": .string("acceptance-checklist.md"),
                        "path": .string(
                            "projects/native-macos/acceptance-checklist.md"
                        ),
                    ]),
                ]),
            ]),
            "get_company_activity": .object([
                "activity": .array([
                    .object([
                        "id": .string("visual-activity"),
                        "title": .string("Native route verified"),
                        "detail": .string(
                            "The production SwiftUI surface rendered."
                        ),
                        "status": .string("Now"),
                    ]),
                ]),
            ]),
            "get_activity_log": .array([
                .object([
                    "id": .string("visual-local-activity"),
                    "title": .string("Native app launched"),
                    "detail": .string(
                        "The local HQ activity log is available."
                    ),
                    "status": .string("Now"),
                ]),
            ]),
        ]
        secondaryDomainFailures.removeAll()
        secondaryDomainLoading.removeAll()
        widgetMode = .expanded
        let visualBanner = Self.previewBannerPayload(for: .directMessage)
        activeBannerPayload = visualBanner
        activeBannerKind = visualBanner.kind
        isBannerPresented = true
        unreadDMMessages = 2
        pendingDMRequests = 1
    }

    private func visualTourRows(
        for route: HQRoute
    ) -> [HQWindowRowFixture] {
        func row(
            _ id: String,
            _ title: String,
            _ detail: String,
            _ symbol: String,
            _ value: String? = nil,
            metadata: [String: HQJSONValue] = [:]
        ) -> HQWindowRowFixture {
            HQWindowRowFixture(
                id: id,
                title: title,
                detail: detail,
                symbolName: symbol,
                value: value,
                metadata: metadata
            )
        }

        switch route {
        case .global(.marketplace):
            return [
                row(
                    "native-craft",
                    "Native macOS Craft",
                    "Production-ready AppKit and SwiftUI patterns.",
                    "shippingbox",
                    "1.0.0",
                    metadata: [
                        "slug": .string("native-macos-craft"),
                        "version": .string("1.0.0"),
                    ]
                ),
            ]
        case .global(.moderation):
            return [
                row(
                    "moderation-native",
                    "Native Craft Review",
                    "Verified instructions and signed package contents.",
                    "checkmark.shield",
                    "Ready",
                    metadata: [
                        "id": .string("moderation-native"),
                        "versionLock": .string("visual-v1"),
                    ]
                ),
            ]
        case .library(.skills), .company(_, .skills):
            return [
                row(
                    "skill-native",
                    "native-macos",
                    "Build production macOS surfaces with AppKit and SwiftUI.",
                    "wand.and.stars",
                    "Skill",
                    metadata: [
                        "_hqCollection": .string("Skills"),
                        "path": .string(
                            ".claude/skills/native-macos/SKILL.md"
                        ),
                    ]
                ),
            ]
        case .library(.workers), .company(_, .workers):
            return [
                row(
                    "worker-native",
                    "Native Window Worker",
                    "Owns deterministic production-surface verification.",
                    "person.2.badge.gearshape",
                    "Worker",
                    metadata: [
                        "_hqCollection": .string("Workers"),
                        "path": .string("core/workers/native"),
                    ]
                ),
            ]
        case .files, .company(_, .knowledge):
            return [
                row(
                    "file-native-brief",
                    "native-visual.md",
                    "knowledge/briefs/native-visual.md",
                    "doc.text",
                    "12 KB",
                    metadata: [
                        "path": .string(
                            "companies/indigo/knowledge/briefs/native-visual.md"
                        ),
                    ]
                ),
            ]
        case let .task(_, _, taskID):
            return [
                row(
                    taskID,
                    "Visual parity verification",
                    "Every production route and window is screenshot-ready.",
                    "checkmark.circle",
                    "In progress",
                    metadata: [
                        "id": .string(taskID),
                        "passes": .bool(false),
                    ]
                ),
            ]
        case .global(.inbox):
            return [
                row(
                    "inbox-native",
                    "Caitlin",
                    "The production visual pass is ready.",
                    "message",
                    "Now"
                ),
                row(
                    "share-native",
                    "Native visual brief",
                    "Shared securely with your Indigo workspace.",
                    "person.2.wave.2",
                    "New"
                ),
            ]
        case .global(.meetings), .settings(.meetings):
            return [
                row(
                    "meeting-native",
                    "Product standup",
                    "Zoom · Capture permissions verified",
                    "video",
                    "10:30"
                ),
            ]
        default:
            return [
                row(
                    "visual-primary",
                    "Production data",
                    "Deterministic engine-shaped content for visual verification.",
                    "checkmark.circle",
                    "Ready"
                ),
                row(
                    "visual-secondary",
                    "Native interaction",
                    "AppKit and SwiftUI actions remain wired in this state.",
                    "cursorarrow.click",
                    "Verified"
                ),
            ]
        }
    }

    func loadLiveRoute(
        _ route: HQRoute,
        generation requestedGeneration: UInt64? = nil
    ) async {
        if launchMode == .visualTourFixture {
            let descriptor = liveRouteDescriptor(for: route)
            liveRouteStates[route] = .content(
                HQLiveRouteContent(
                    title: descriptor.title,
                    subtitle: descriptor.subtitle,
                    symbolName: descriptor.symbolName,
                    rows: visualTourRows(for: route),
                    notice: nil
                )
            )
            return
        }
        guard launchMode == .live else { return }
        let dataGeneration =
            requestedGeneration ?? authenticatedDataGeneration
        guard dataGeneration == authenticatedDataGeneration else {
            return
        }
        guard hasProtectedAccess else {
            liveRouteStates[route] = .empty(
                HQWindowEmptyState(
                    title: "Sign in to HQ",
                    message:
                        "Authenticate before loading protected workspace data."
                )
            )
            return
        }
        guard phase == .ready else {
            liveRouteStates[route] = .loading
            return
        }
        guard let engine else {
            liveRouteStates[route] = .failure(
                HQWindowFailureState(
                    message: "The bundled HQ engine is unavailable.",
                    retryTitle: "Reconnect"
                )
            )
            return
        }

        let descriptor = liveRouteDescriptor(for: route)
        if let preflightState = descriptor.preflightState {
            liveRouteStates[route] = preflightState
            return
        }
        guard !descriptor.requests.isEmpty else {
            liveRouteStates[route] = .empty(
                HQWindowEmptyState(
                    title: descriptor.emptyTitle,
                    message: descriptor.emptyMessage
                )
            )
            return
        }

        liveRouteStates[route] = .loading
        let missingMethods = descriptor.requests
            .map(\.method)
            .filter { !capabilities.contains($0) }
        let runnableRequests = descriptor.requests.filter {
            capabilities.contains($0.method)
        }
        var values: [String: HQJSONValue] = [:]
        var failures = missingMethods.map {
            "The HQ engine did not advertise \($0)."
        }

        let routeTasks = runnableRequests.map { request in
            Task { @MainActor [weak self] in
                guard let self,
                      self.hasProtectedAccess,
                      dataGeneration == self.authenticatedDataGeneration
                else {
                    return (
                        method: request.method,
                        value: Optional<HQJSONValue>.none,
                        failure: Optional<String>.none
                    )
                }
                do {
                    return (
                        method: request.method,
                        value: try await engine.request(
                            request.method,
                            params: request.params
                        ),
                        failure: Optional<String>.none
                    )
                } catch {
                    return (
                        method: request.method,
                        value: Optional<HQJSONValue>.none,
                        failure:
                            "\(request.method): \(Self.message(for: error))"
                    )
                }
            }
        }
        for task in routeTasks {
            let result = await task.value
            guard dataGeneration == authenticatedDataGeneration else {
                routeTasks.forEach { $0.cancel() }
                return
            }
            if let value = result.value {
                values[result.method] = value
            }
            if let failure = result.failure {
                failures.append(failure)
            }
        }
        guard dataGeneration == authenticatedDataGeneration else {
            return
        }

        let rows: [HQWindowRowFixture] = descriptor.requests.flatMap { request in
            guard let value = values[request.method] else {
                return [HQWindowRowFixture]()
            }
            return Self.liveRouteRows(
                from: value,
                idPrefix: "\(HQRouteParser.serialize(route))-\(request.method)",
                sourceLabel: Self.humanized(request.method),
                defaultSymbol: descriptor.symbolName
            )
        }

        if rows.isEmpty {
            if values.isEmpty, let failure = failures.first {
                liveRouteStates[route] = .failure(
                    HQWindowFailureState(
                        message: failure,
                        retryTitle: "Try Again"
                    )
                )
            } else {
                liveRouteStates[route] = .empty(
                    HQWindowEmptyState(
                        title: descriptor.emptyTitle,
                        message: failures.isEmpty
                            ? descriptor.emptyMessage
                            : "\(descriptor.emptyMessage) \(failures.joined(separator: " "))"
                    )
                )
            }
            return
        }

        liveRouteStates[route] = .content(
            HQLiveRouteContent(
                title: descriptor.title,
                subtitle: descriptor.subtitle,
                symbolName: descriptor.symbolName,
                rows: rows,
                notice: failures.isEmpty
                    ? nil
                    : failures.joined(separator: " ")
            )
        )
    }

    func liveRouteState(for route: HQRoute) -> HQLiveRouteState {
        if phase == .idle || phase == .loading {
            return .loading
        }
        if case let .failed(message) = phase {
            return .failure(
                HQWindowFailureState(
                    message: message,
                    retryTitle: "Reconnect"
                )
            )
        }
        return liveRouteStates[route] ?? .loading
    }

    private func liveRouteDescriptor(
        for route: HQRoute
    ) -> HQLiveRouteDescriptor {
        let defaultSlug = content.snapshot.workspaces.first?.slug

        func request(
            _ method: String,
            _ params: HQJSONValue = .object([:])
        ) -> HQLiveRouteRequest {
            HQLiveRouteRequest(method: method, params: params)
        }

        func descriptor(
            title: String,
            subtitle: String,
            symbol: String,
            emptyTitle: String,
            emptyMessage: String,
            requests: [HQLiveRouteRequest] = [],
            preflightState: HQLiveRouteState? = nil
        ) -> HQLiveRouteDescriptor {
            HQLiveRouteDescriptor(
                title: title,
                subtitle: subtitle,
                symbolName: symbol,
                emptyTitle: emptyTitle,
                emptyMessage: emptyMessage,
                requests: requests,
                preflightState: preflightState
            )
        }

        func companyDescriptor(
            slug: String,
            section: HQCompanySection
        ) -> HQLiveRouteDescriptor {
            let cloudParams = HQJSONValue.object(["slug": .string(slug)])
            let localParams = HQJSONValue.object([
                "companySlug": .string(slug),
            ])
            switch section {
            case .overview:
                return descriptor(
                    title: "\(slug.capitalized) overview",
                    subtitle: "Cloud summary, board, and CRM projection",
                    symbol: "building.2",
                    emptyTitle: "No company overview data",
                    emptyMessage: "HQ returned an empty overview for \(slug).",
                    requests: [
                        request("get_company_summary", cloudParams),
                        request("get_company_board", cloudParams),
                        request("get_company_crm_projection_vault", cloudParams),
                    ]
                )
            case .goals:
                return descriptor(
                    title: "Goals",
                    subtitle: "Objectives and initiatives from the local company board",
                    symbol: "target",
                    emptyTitle: "No goals",
                    emptyMessage: "\(slug) has no local objectives or initiatives.",
                    requests: [
                        request("get_local_company_goals", localParams),
                    ]
                )
            case .projects:
                return descriptor(
                    title: "Company board",
                    subtitle: "Current project workflow from HQ cloud",
                    symbol: "rectangle.stack",
                    emptyTitle: "No board projects",
                    emptyMessage: "\(slug) has no projects on its cloud board.",
                    requests: [
                        request("get_company_board", cloudParams),
                    ]
                )
            case .skills, .workers:
                return descriptor(
                    title: section == .skills ? "Company skills" : "Company workers",
                    subtitle: "Local \(slug) library",
                    symbol: section == .skills ? "wand.and.stars" : "person.2.badge.gearshape",
                    emptyTitle: section == .skills ? "No company skills" : "No company workers",
                    emptyMessage: "\(slug) has no \(section.rawValue) in its local library.",
                    requests: [
                        request("get_library_company", localParams),
                    ]
                )
            case .knowledge:
                return descriptor(
                    title: "Company knowledge",
                    subtitle: "Local files under companies/\(slug)",
                    symbol: "doc.text.magnifyingglass",
                    emptyTitle: "No company files",
                    emptyMessage: "\(slug) has no visible local knowledge files.",
                    requests: [
                        request(
                            "get_company_file_tree",
                            .object(["slug": .string(slug)])
                        ),
                    ]
                )
            case .team:
                return descriptor(
                    title: "Team",
                    subtitle: "Project creators and 30-day team telemetry",
                    symbol: "person.3",
                    emptyTitle: "No team telemetry",
                    emptyMessage: "HQ returned no team records for \(slug).",
                    requests: [
                        request("get_company_project_creators", cloudParams),
                        request("get_company_team_telemetry", cloudParams),
                    ]
                )
            case .activity:
                return descriptor(
                    title: "Activity",
                    subtitle: "Recent authenticated company activity",
                    symbol: "clock.arrow.circlepath",
                    emptyTitle: "No recent activity",
                    emptyMessage: "\(slug) has no recent company activity.",
                    requests: [
                        request("get_company_activity", cloudParams),
                    ]
                )
            case .deployments:
                return descriptor(
                    title: "Deployments",
                    subtitle: "Live applications scoped to \(slug)",
                    symbol: "shippingbox",
                    emptyTitle: "No deployments",
                    emptyMessage: "\(slug) has no active deployments.",
                    requests: [
                        request("get_company_deployments", cloudParams),
                    ]
                )
            case .secrets:
                return descriptor(
                    title: "Secret metadata",
                    subtitle: "Names and rotation metadata only; values never enter the app",
                    symbol: "key",
                    emptyTitle: "No secret metadata",
                    emptyMessage: "\(slug) has no secret keys visible to this identity.",
                    requests: [
                        request("get_company_secrets", cloudParams),
                    ]
                )
            case .settings:
                return descriptor(
                    title: "Company sync",
                    subtitle: "Cloud sync scope for \(slug)",
                    symbol: "arrow.triangle.2.circlepath",
                    emptyTitle: "No sync configuration",
                    emptyMessage: "HQ returned no sync configuration for \(slug).",
                    requests: [
                        request("get_sync_mode", localParams),
                    ]
                )
            }
        }

        switch route {
        case .global(.home), .global(.missionControl):
            return descriptor(
                title: "HQ",
                subtitle: "Live local HQ state",
                symbol: "house",
                emptyTitle: "No live data",
                emptyMessage: "HQ returned no live records."
            )
        case .global(.inbox):
            return descriptor(
                title: "Inbox",
                subtitle: "Channels, requests, direct messages, shares, and files",
                symbol: "tray",
                emptyTitle: "Inbox is clear",
                emptyMessage: "HQ returned no messages, requests, shares, or file updates.",
                requests: [
                    request("list_channels"),
                    request("list_dm_requests"),
                    request(
                        "fetch_notification_history",
                        .object(["limit": .number(100)])
                    ),
                ]
            )
        case .global(.meetings):
            return descriptor(
                title: "Meetings",
                subtitle: "Connected meeting accounts",
                symbol: "video",
                emptyTitle: "No meeting accounts",
                emptyMessage: "Connect a meeting provider to use meeting capture.",
                requests: [request("meetings_list_accounts")]
            )
        case .global(.marketplace):
            return descriptor(
                title: "Marketplace",
                subtitle: "Public, redacted HQ pack listings",
                symbol: "shippingbox",
                emptyTitle: "No marketplace listings",
                emptyMessage: "The public marketplace returned no listings.",
                requests: [request("list_marketplace_listings")]
            )
        case .global(.moderation):
            return descriptor(
                title: "Moderation",
                subtitle: "Authenticated pending-review marketplace listings",
                symbol: "checkmark.shield",
                emptyTitle: "Moderation queue is clear",
                emptyMessage: "There are no pending marketplace reviews.",
                requests: [request("list_moderation_queue")]
            )
        case .global(.library):
            return descriptor(
                title: "Library",
                subtitle: "Root and personal skills and workers",
                symbol: "books.vertical",
                emptyTitle: "Library is empty",
                emptyMessage: "No root or personal skills and workers were discovered.",
                requests: [request("get_library_root")]
            )
        case let .library(section):
            switch section {
            case .skills, .workers:
                return descriptor(
                    title: "Library \(section.rawValue.capitalized)",
                    subtitle: "Local HQ library records",
                    symbol: section == .workers
                        ? "person.2.badge.gearshape"
                        : "wand.and.stars",
                    emptyTitle: "No \(section.rawValue)",
                    emptyMessage: "No \(section.rawValue) were discovered in the local HQ library.",
                    requests: [request("get_library_root")]
                )
            case .installed:
                return descriptor(
                    title: "Installed packs",
                    subtitle: "Packages installed in this HQ workspace",
                    symbol: "shippingbox.fill",
                    emptyTitle: "No installed packs",
                    emptyMessage: "HQ returned no installed packages.",
                    requests: [request("list_packages")]
                )
            case .profile:
                return descriptor(
                    title: "Creator profile",
                    subtitle: "The authenticated marketplace creator identity",
                    symbol: "person.crop.circle",
                    emptyTitle: "No creator profile",
                    emptyMessage: "Claim a creator handle to publish HQ packs.",
                    requests: [request("get_my_creator")]
                )
            }
        case .global(.files):
            guard let defaultSlug else {
                return descriptor(
                    title: "Files",
                    subtitle: "Local company files",
                    symbol: "folder",
                    emptyTitle: "No workspace selected",
                    emptyMessage: "Choose an HQ folder before browsing files.",
                    preflightState: .empty(
                        HQWindowEmptyState(
                            title: "No workspace selected",
                            message: "Choose an HQ folder before browsing files."
                        )
                    )
                )
            }
            return liveRouteDescriptor(
                for: .files(slug: defaultSlug, path: nil)
            )
        case let .files(slug, path):
            guard let slug = slug ?? defaultSlug else {
                return descriptor(
                    title: "Files",
                    subtitle: "Local company files",
                    symbol: "folder",
                    emptyTitle: "No workspace selected",
                    emptyMessage: "Choose an HQ folder before browsing files.",
                    preflightState: .empty(
                        HQWindowEmptyState(
                            title: "No workspace selected",
                            message: "Choose an HQ folder before browsing files."
                        )
                    )
                )
            }
            var requests = [
                request(
                    "get_company_file_tree",
                    .object(["slug": .string(slug)])
                ),
            ]
            if let path, !path.isEmpty {
                let companyPath = path.hasPrefix("companies/")
                    ? path
                    : "companies/\(slug)/\(path)"
                requests.append(
                    request(
                        "get_company_file_content",
                        .object(["path": .string(companyPath)])
                    )
                )
            }
            return descriptor(
                title: "\(slug.capitalized) files",
                subtitle: path ?? "All local company files",
                symbol: "folder",
                emptyTitle: "No files",
                emptyMessage: "\(slug) has no visible local files.",
                requests: requests
            )
        case .global(.settings):
            return descriptor(
                title: "Settings",
                subtitle: "Native application settings",
                symbol: "gearshape",
                emptyTitle: "Settings are ready",
                emptyMessage: "Native settings do not require an engine response."
            )
        case let .settings(section):
            if section == .sync {
                guard let selectedSyncWorkspaceSlug else {
                    return descriptor(
                        title: "Sync settings",
                        subtitle: "Native macOS workspace sync controls",
                        symbol: "arrow.triangle.2.circlepath",
                        emptyTitle: "Select a workspace",
                        emptyMessage:
                            "Choose the company workspace whose sync scope you want to inspect."
                    )
                }
                return companyDescriptor(
                    slug: selectedSyncWorkspaceSlug,
                    section: .settings
                )
            }
            if section == .meetings {
                return descriptor(
                    title: "Meeting settings",
                    subtitle: "Connected meeting accounts",
                    symbol: "video",
                    emptyTitle: "No meeting accounts",
                    emptyMessage: "Connect a meeting provider to use meeting capture.",
                    requests: [request("meetings_list_accounts")]
                )
            }
            return descriptor(
                title: "\(section.rawValue.capitalized) settings",
                subtitle: "Native macOS settings",
                symbol: "gearshape",
                emptyTitle: "Settings are ready",
                emptyMessage: "This section is managed entirely by native macOS services."
            )
        case let .company(slug, section):
            guard content.snapshot.workspaces.contains(where: {
                $0.slug == slug
            }) else {
                return descriptor(
                    title: slug,
                    subtitle: "Company workspace",
                    symbol: "building.2",
                    emptyTitle: "Workspace not found",
                    emptyMessage: "Reconnect or refresh HQ to discover \(slug).",
                    preflightState: .failure(
                        HQWindowFailureState(
                            message: "The live workspaces response does not contain \(slug).",
                            retryTitle: "Refresh"
                        )
                    )
                )
            }
            return companyDescriptor(slug: slug, section: section)
        case let .project(company, projectID),
             let .task(company, projectID, _):
            guard let project = content.snapshot.projects.first(where: {
                $0.companySlug == company && $0.id == projectID
            }) else {
                return descriptor(
                    title: projectID,
                    subtitle: "Local project",
                    symbol: "rectangle.stack",
                    emptyTitle: "Project not found",
                    emptyMessage: "Refresh HQ to rediscover this project.",
                    preflightState: .failure(
                        HQWindowFailureState(
                            message: "The live projects response does not contain \(projectID).",
                            retryTitle: "Refresh"
                        )
                    )
                )
            }
            guard let prdPath = project.prdPath, !prdPath.isEmpty else {
                return descriptor(
                    title: project.title,
                    subtitle: "Local project",
                    symbol: "rectangle.stack",
                    emptyTitle: "No linked PRD",
                    emptyMessage: "\(project.title) has no prdPath in projects.list.",
                    preflightState: .empty(
                        HQWindowEmptyState(
                            title: "No linked PRD",
                            message: "\(project.title) has no prdPath in projects.list."
                        )
                    )
                )
            }
            let params = HQJSONValue.object([
                "prdPath": .string(prdPath),
            ])
            return descriptor(
                title: project.title,
                subtitle: "Live PRD and project README",
                symbol: "rectangle.stack",
                emptyTitle: "Project plan is empty",
                emptyMessage: "\(project.title) has no stories or README content.",
                requests: [
                    request("get_local_project_prd", params),
                    request("get_local_project_readme", params),
                ]
            )
        }
    }

    private static func liveRouteRows(
        from value: HQJSONValue,
        idPrefix: String,
        sourceLabel: String,
        defaultSymbol: String
    ) -> [HQWindowRowFixture] {
        var rows: [HQWindowRowFixture] = []

        func append(
            _ value: HQJSONValue,
            label: String,
            path: String
        ) {
            switch value {
            case .null:
                return
            case let .array(values):
                for (index, child) in values.enumerated() {
                    append(
                        child,
                        label: label,
                        path: "\(path)-\(index)"
                    )
                }
            case let .object(object):
                let title = [
                    "title",
                    "name",
                    "displayName",
                    "subject",
                    "eventType",
                    "kind",
                    "creator",
                    "who",
                    "sub",
                    "env",
                    "key",
                    "slug",
                    "path",
                    "body",
                    "id",
                ].compactMap { object.string(for: $0) }.first
                let rawID = object.string(for: "id")
                    ?? object.string(for: "uid")
                    ?? object.string(for: "channelId")
                    ?? object.string(for: "eventId")
                    ?? object.string(for: "path")
                    ?? path
                if let title, !title.isEmpty {
                    let detail = [
                        "detail",
                        "summary",
                        "description",
                        "preview",
                    "message",
                    "what",
                    "file",
                    "text",
                    "body",
                        "path",
                        "status",
                        "url",
                    ].compactMap { object.string(for: $0) }
                        .first(where: { $0 != title }) ?? ""
                    let rowValue = [
                        "timestamp",
                        "createdAt",
                        "updatedAt",
                        "when",
                        "status",
                        "state",
                        "version",
                        "syncMode",
                        "count",
                        "unreadCount",
                    ].compactMap { object[$0]?.displayValue }.first
                    rows.append(
                        HQWindowRowFixture(
                            id: "\(idPrefix)-\(rawID)",
                            title: title,
                            detail: detail,
                            symbolName: object.string(for: "symbolName")
                                ?? defaultSymbol,
                            value: rowValue,
                            metadata: object.merging(
                                ["_hqCollection": .string(label)]
                            ) { current, _ in current }
                        )
                    )
                } else {
                    for key in object.keys.sorted() {
                        guard let displayValue = object[key]?.displayValue else {
                            continue
                        }
                        rows.append(
                            HQWindowRowFixture(
                                id: "\(idPrefix)-\(path)-\(key)",
                                title: humanized(key),
                                detail: label,
                                symbolName: defaultSymbol,
                                value: displayValue,
                                metadata: [key: object[key] ?? .null]
                            )
                        )
                    }
                }

                for key in object.keys.sorted() {
                    guard let child = object[key] else { continue }
                    switch child {
                    case .array, .object:
                        append(
                            child,
                            label: humanized(key),
                            path: "\(path)-\(key)"
                        )
                    case .null, .bool, .number, .string:
                        break
                    }
                }
            case let .string(string):
                guard !string.trimmingCharacters(
                    in: .whitespacesAndNewlines
                ).isEmpty else {
                    return
                }
                rows.append(
                    HQWindowRowFixture(
                        id: "\(idPrefix)-\(path)",
                        title: label,
                        detail: string,
                        symbolName: defaultSymbol
                    )
                )
            case .bool, .number:
                guard let displayValue = value.displayValue else { return }
                rows.append(
                    HQWindowRowFixture(
                        id: "\(idPrefix)-\(path)",
                        title: label,
                        detail: sourceLabel,
                        symbolName: defaultSymbol,
                        value: displayValue
                    )
                )
            }
        }

        append(value, label: sourceLabel, path: "root")
        var seen: Set<String> = []
        return rows.filter { seen.insert($0.id).inserted }
    }

    private static func humanized(_ value: String) -> String {
        let withoutPrefix = value
            .replacingOccurrences(of: "get_", with: "")
            .replacingOccurrences(of: "list_", with: "")
            .replacingOccurrences(of: "fetch_", with: "")
            .replacingOccurrences(of: "_", with: " ")
            .replacingOccurrences(of: "-", with: " ")
        var output = ""
        for character in withoutPrefix {
            if character.isUppercase,
               output.last?.isWhitespace == false
            {
                output.append(" ")
            }
            output.append(character)
        }
        return output
            .split(separator: " ")
            .map { $0.prefix(1).uppercased() + $0.dropFirst() }
            .joined(separator: " ")
    }

    func messagesWindowFixture() -> HQMessagesFixture? {
        guard case .content = windowState(for: .messages) else {
            return nil
        }

        func rows(
            method: String,
            collectionKeys: [String],
            symbol: String
        ) -> [HQWindowRowFixture] {
            guard let value = secondaryDomainValues[method] else {
                return []
            }
            return Self.windowRows(
                from: value,
                collectionKeys: collectionKeys,
                idPrefix: method,
                defaultSymbol: symbol
            )
        }

        func messageRows(
            _ rows: [HQWindowRowFixture],
            unreadCount: Int = 0
        ) -> [HQMessageListRowFixture] {
            rows.enumerated().map { index, row in
                HQMessageListRowFixture(
                    id: row.id,
                    title: row.title,
                    preview: row.detail,
                    timestamp: row.value ?? "Now",
                    unreadCount: index == 0 ? unreadCount : 0,
                    isMuted: false
                )
            }
        }

        var directMessages = rows(
            method: "fetch_notification_history",
            collectionKeys: ["dms"],
            symbol: "message"
        )
        let channels = rows(
            method: "list_channels",
            collectionKeys: ["channels"],
            symbol: "number"
        )
        let requests = rows(
            method: "list_dm_requests",
            collectionKeys: ["requests"],
            symbol: "person.crop.circle.badge.questionmark"
        )
        let target = nativeParityEvents.conversationTarget
        let threadValues = secondaryDomainValues["fetch_dm_thread"]?
            .object?["messages"]?.arrayValue ?? []
        let threadMessages = threadValues.reversed().compactMap {
            value -> HQMessageBubbleFixture? in
            guard let object = value.object,
                  let eventID = object.string(for: "eventId"),
                  let body = object.string(for: "body")
            else {
                return nil
            }
            let author = object.string(for: "fromDisplayName")
                ?? object.string(for: "fromEmail")
                ?? (object.string(for: "direction") == "out"
                    ? "You"
                    : target?.displayName ?? "HQ member")
            return HQMessageBubbleFixture(
                id: eventID,
                author: author,
                body: body,
                timestamp: object.string(for: "createdAt") ?? "Now",
                isCurrentUser: object.string(for: "direction") == "out",
                reactions: []
            )
        }
        let channelMessageValues = secondaryDomainValues["fetch_channel"]?
            .object?["messages"]?.arrayValue ?? []
        let channelScope = selectedChannelID.map { "chan:\($0)" }

        func bubble(
            from value: HQJSONValue,
            scope: String?
        ) -> HQMessageBubbleFixture? {
            guard let object = value.object,
                  let eventID = object.string(for: "eventId"),
                  let body = object.string(for: "body")
            else {
                return nil
            }
            let isCurrentUser = object.string(for: "direction") == "out"
            let author = object.string(for: "fromDisplayName")
                ?? object.string(for: "fromEmail")
                ?? (isCurrentUser ? "You" : "HQ member")
            let reactions = scope.flatMap {
                messageReactionState[$0]?[eventID]
            }?.map {
                HQMessageReactionFixture(
                    emoji: $0.emoji,
                    count: $0.count,
                    reactedByCurrentUser: $0.reactedByCurrentUser
                )
            } ?? []
            return HQMessageBubbleFixture(
                id: eventID,
                author: author,
                body: body,
                timestamp: object.string(for: "createdAt") ?? "Now",
                isCurrentUser: isCurrentUser,
                reactions: reactions
            )
        }

        let channelMessages = channelMessageValues.reversed().compactMap {
            bubble(from: $0, scope: channelScope)
        }
        let channelThread: HQMessageThreadFixture? = {
            guard let object = secondaryDomainValues["fetch_thread"]?.object,
                  let root = object["root"],
                  let replies = object["replies"]?.arrayValue,
                  let rawReplyCount = object["replyCount"]?.numberValue,
                  rawReplyCount >= 0,
                  rawReplyCount.rounded() == rawReplyCount,
                  rawReplyCount <= Double(Int.max)
            else {
                return nil
            }
            let threadMessages = (
                [root] + Array(replies.reversed())
            ).compactMap {
                bubble(from: $0, scope: channelScope)
            }
            guard !threadMessages.isEmpty else { return nil }
            return HQMessageThreadFixture(
                title: "Thread",
                replyCount: Int(rawReplyCount),
                messages: threadMessages
            )
        }()

        let requestedChannel = selectedMessagesConversation.flatMap {
            request -> HQWindowRowFixture? in
            guard request.section == .channels else { return nil }
            return channels.first { $0.id == request.rowID }
        }
        let requestedDirectMessage = selectedMessagesConversation.flatMap {
            request -> HQWindowRowFixture? in
            guard request.section == .directMessages else { return nil }
            return directMessages.first { $0.id == request.rowID }
        }

        let selected: HQWindowRowFixture
        let selectedSection: HQMessageSectionKind
        if let requestedChannel {
            selected = requestedChannel
            selectedSection = .channels
        } else if let target {
            let displayName = target.displayName.trimmingCharacters(
                in: .whitespacesAndNewlines
            )
            let email = target.email.trimmingCharacters(
                in: .whitespacesAndNewlines
            )
            let preview = threadValues.first?.object?.string(for: "body")
                ?? secondaryDomainFailures["fetch_dm_thread"]
                ?? (secondaryDomainLoading.contains("fetch_dm_thread")
                    ? "Loading conversation…"
                    : (target.personUID.isEmpty
                        ? "Start a new conversation."
                        : "No messages yet."))
            selected = HQWindowRowFixture(
                id: target.personUID.isEmpty
                    ? "target-email-\(email)"
                    : "target-person-\(target.personUID)",
                title: displayName.isEmpty ? email : displayName,
                detail: preview,
                symbolName: "message",
                value: threadValues.first?.object?.string(for: "createdAt")
                    ?? "Now"
            )
            directMessages.removeAll { $0.id == selected.id }
            directMessages.insert(selected, at: 0)
            selectedSection = .directMessages
        } else if let requestedDirectMessage {
            selected = requestedDirectMessage
            selectedSection = .directMessages
        } else if let first = directMessages.first {
            selected = first
            selectedSection = .directMessages
        } else if let first = channels.first {
            selected = first
            selectedSection = .channels
        } else if let first = requests.first {
            selected = first
            selectedSection = .requests
        } else {
            return nil
        }

        let conversationMessages: [HQMessageBubbleFixture]
        if selectedSection == .channels,
           selectedChannelID != nil
        {
            conversationMessages = channelMessages
        } else if selectedSection == .directMessages,
           target != nil,
           !threadMessages.isEmpty
        {
            conversationMessages = threadMessages
        } else {
            conversationMessages = [
                HQMessageBubbleFixture(
                    id: "live-\(selected.id)",
                    author: selected.title
                        .replacingOccurrences(of: "# ", with: ""),
                    body: selected.detail.isEmpty
                        ? "Conversation is ready."
                        : selected.detail,
                    timestamp: selected.value ?? "Now",
                    isCurrentUser: false,
                    reactions: []
                ),
            ]
        }

        let sections = [
                HQMessageSectionFixture(
                    kind: .directMessages,
                    rows: messageRows(
                        directMessages,
                        unreadCount: unreadDMMessages
                    )
                ),
                HQMessageSectionFixture(
                    kind: .channels,
                    rows: messageRows(
                        channels,
                        unreadCount: unreadDMMessages
                    )
                ),
                HQMessageSectionFixture(
                    kind: .requests,
                    rows: messageRows(
                        requests,
                        unreadCount: pendingDMRequests
                    )
                ),
            ]
        return HQMessagesFixture(
            sections: sections,
            selectedSection: selectedSection,
            selectedRowID: selected.id,
            selectionIsReady: (
                selectedSection == .channels
                    && selectedChannelID
                        == selected.metadata["channelId"]?.stringValue
                    && !secondaryDomainLoading.contains("fetch_channel")
                    && secondaryDomainValues["fetch_channel"] != nil
            ) || (
                    selectedSection == .directMessages
                        && target != nil
                        && !secondaryDomainLoading.contains(
                            "fetch_dm_thread"
                        )
                        && (
                            target?.personUID.isEmpty == true
                                || secondaryDomainValues[
                                    "fetch_dm_thread"
                                ] != nil
                        )
                ),
            selectedConversation: HQConversationFixture(
                title: selected.title,
                subtitle: isAuthenticated
                    ? "Live HQ conversation"
                    : "Authentication required",
                messages: conversationMessages,
                thread: selectedSection == .channels
                    ? channelThread
                    : nil
            )
        )
    }

    func bannerWindowFixture() -> HQBannerFixture? {
        guard case .content = windowState(for: .banner),
              isBannerPresented,
              let payload = activeBannerPayload
        else {
            return nil
        }

        switch payload {
        case let .syncComplete(_, message):
            return HQBannerFixture(
                kind: .syncComplete,
                title: "Sync complete",
                message: message,
                symbolName: "checkmark.circle",
                actionTitle: "View Changes"
            )
        case let .meetingReady(title, message, _, _, _):
            return HQBannerFixture(
                kind: .meetingReady,
                title: title,
                message: message,
                symbolName: "video",
                actionTitle: "Open Meeting"
            )
        case let .directMessage(message):
            let sender = message.fromDisplayName.trimmingCharacters(
                in: .whitespacesAndNewlines
            )
            return HQBannerFixture(
                kind: .directMessage,
                title: sender.isEmpty
                    ? "New HQ message"
                    : "New message from \(sender)",
                message: message.body,
                symbolName: "message",
                actionTitle: "Reply"
            )
        case let .updateAvailable(version, body):
            return HQBannerFixture(
                kind: .updateAvailable,
                title: "HQ \(version) is available",
                message: body ?? "A signed native update is ready.",
                symbolName: "arrow.down.circle",
                actionTitle: "Review Update"
            )
        }
    }

    func widgetWindowFixture() -> HQWidgetFixture? {
        guard case .content = windowState(for: .widget) else {
            return nil
        }

        let recentItems = [
            HQWindowRowFixture(
                id: "messages",
                title: "Messages",
                detail: "Unread messages and requests",
                symbolName: "bubble.left.and.bubble.right",
                value: "\(messageBadgeCount)"
            ),
            HQWindowRowFixture(
                id: "workspaces",
                title: "Workspaces",
                detail: "Available on this Mac",
                symbolName: "building.2",
                value: "\(content.snapshot.workspaces.count)"
            ),
            HQWindowRowFixture(
                id: "projects",
                title: "Projects",
                detail: "Indexed by the local engine",
                symbolName: "square.stack.3d.up",
                value: "\(content.snapshot.projects.count)"
            ),
            HQWindowRowFixture(
                id: "sessions",
                title: "Agent sessions",
                detail: "Currently discovered",
                symbolName: "terminal",
                value: "\(sessions.count)"
            ),
        ]
        let activity = content.activity.prefix(3).map {
            HQWidgetActivityFixture(
                id: $0.id,
                title: "\($0.actor) \($0.action) \($0.target)",
                timestamp: $0.time
            )
        }

        return HQWidgetFixture(
            mode: widgetMode,
            headline: phase == .ready ? "HQ is current" : "HQ needs attention",
            status: "\(content.snapshot.projects.count) projects · \(sessions.count) sessions",
            recentItems: recentItems,
            activity: activity
        )
    }

    func windowState(for kind: HQSecondaryWindowKind) -> HQWindowContentState {
        if launchMode.usesLegacyFixtureSurfaces {
            return .content(HQSecondaryWindowFixtures.fixture(for: kind))
        }

        // Notification responses can arrive during a cold launch, before the
        // engine bootstrap reaches `.ready`. Their retained payload is already
        // sufficient to render a useful native detail window immediately.
        if kind == .directMessageDetail,
           let message = nativeParityEvents.dmDetailMessage
            ?? secondaryDomainValues["dm:detail-event"].flatMap(
                HQRealtimeDirectMessage.init(value:)
            )
        {
            return nativeDirectMessageDetailState(
                kind: kind,
                message: message
            )
        }
        if kind == .shareDetail,
           let share = nativeParityEvents.selectedShare
        {
            return nativeShareDetailState(kind: kind, share: share)
        }

        switch phase {
        case .idle, .loading:
            return .loading
        case let .failed(message):
            return .failure(
                HQWindowFailureState(
                    message: message,
                    retryTitle: "Reconnect"
                )
            )
        case .ready:
            break
        }

        switch kind {
        case .menuBar:
            return .content(
                liveWindowFixture(
                    kind: kind,
                    title: "HQ",
                    subtitle: phase == .ready ? "Connected to the local HQ engine" : "HQ engine status",
                    symbol: phase == .ready ? "checkmark.circle" : "exclamationmark.triangle",
                    rows: [
                        HQWindowRowFixture(
                            id: "workspaces",
                            title: "Workspaces",
                            detail: "Discovered on this Mac",
                            symbolName: "building.2",
                            value: "\(content.snapshot.workspaces.count)"
                        ),
                        HQWindowRowFixture(
                            id: "projects",
                            title: "Projects",
                            detail: "Available from the live engine",
                            symbolName: "square.stack.3d.up",
                            value: "\(content.snapshot.projects.count)"
                        ),
                        HQWindowRowFixture(
                            id: "sessions",
                            title: "Agent sessions",
                            detail: "Currently discovered",
                            symbolName: "terminal",
                            value: "\(sessions.count)"
                        ),
                        HQWindowRowFixture(
                            id: "settings",
                            title: "Settings",
                            detail: "Open native HQ preferences.",
                            symbolName: "gearshape"
                        ),
                        HQWindowRowFixture(
                            id: "check-updates",
                            title: "Check for Updates",
                            detail: "Use the signed native update feed.",
                            symbolName: "arrow.down.circle"
                        ),
                        HQWindowRowFixture(
                            id: "sign-out",
                            title: "Sign Out",
                            detail: "End this HQ session on this Mac.",
                            symbolName: "rectangle.portrait.and.arrow.right"
                        ),
                    ],
                    primary: HQWindowActionFixture(
                        id: "open",
                        title: "Open HQ",
                        symbolName: "macwindow"
                    ),
                    secondary: HQWindowActionFixture(
                        id: "sync-now",
                        title: "Sync Now",
                        symbolName: "arrow.clockwise"
                    )
                )
            )
        case .onboarding:
            return .content(
                liveWindowFixture(
                    kind: kind,
                    title: isAuthenticated ? "HQ is connected" : "Set up HQ",
                    subtitle: isAuthenticated
                        ? "Complete or resume every native setup stage on this Mac."
                        : "Authentication is required before protected workspace data can load.",
                    symbol: isAuthenticated ? "checkmark.shield" : "person.crop.circle.badge.questionmark",
                    rows: isAuthenticated
                        ? setupStages.map { stage in
                            HQWindowRowFixture(
                                id: stage.id.rawValue,
                                title: stage.id.title,
                                detail: stage.detail,
                                symbolName: stage.id.symbolName,
                                value: stage.status.displayValue
                            )
                        }
                        : [
                            HQWindowRowFixture(
                                id: "authentication",
                                title: "Authentication",
                                detail: "Sign in through a supported HQ identity provider.",
                                symbolName: "person.crop.circle",
                                value: "Required"
                            ),
                            HQWindowRowFixture(
                                id: "workspace",
                                title: "HQ folder",
                                detail: hqFolderPath
                                    ?? "The bundled engine will resolve the workspace.",
                                symbolName: "folder",
                                value: hqFolderPath == nil ? "Pending" : "Ready"
                            ),
                        ],
                    primary: setupIsRunning
                        ? nil
                        : (isAuthenticated
                            ? HQWindowActionFixture(
                                id: setupStages.allSatisfy({
                                    $0.status == .complete
                                }) ? "done" : "run-setup",
                                title: setupStages.allSatisfy({
                                    $0.status == .complete
                                }) ? "Open HQ" : "Run Native Setup",
                                symbolName: setupStages.allSatisfy({
                                    $0.status == .complete
                                }) ? "checkmark" : "play.fill"
                            )
                            : HQWindowActionFixture(
                            id: "sign-in-google",
                            title: "Continue with Google",
                            symbolName: "safari"
                        )),
                    secondary: setupIsRunning
                        ? nil
                        : (isAuthenticated
                            ? HQWindowActionFixture(
                                id: "recovery",
                                title: "Open Recovery",
                                symbolName: "cross.case"
                            )
                            : HQWindowActionFixture(
                            id: "sign-in-microsoft",
                            title: "Continue with Microsoft",
                            symbolName: "safari"
                        ))
                )
            )
        case .settings:
            return .content(
                liveWindowFixture(
                    kind: kind,
                    title: "HQ Settings",
                    subtitle: "Native settings backed by current app state.",
                    symbol: "gearshape",
                    rows: [
                        HQWindowRowFixture(
                            id: "engine",
                            title: "HQ engine",
                            detail: "\(capabilities.count) capabilities advertised",
                            symbolName: "server.rack",
                            value: phase == .ready ? "Ready" : "Unavailable"
                        ),
                        HQWindowRowFixture(
                            id: "authentication",
                            title: "Authentication",
                            detail: isAuthenticated ? "Signed in" : "No active HQ session",
                            symbolName: "person.crop.circle",
                            value: isAuthenticated ? "Active" : "Required"
                        ),
                    ],
                    primary: HQWindowActionFixture(
                        id: "done",
                        title: "Done",
                        symbolName: "checkmark"
                    ),
                    secondary: HQWindowActionFixture(
                        id: "defaults",
                        title: "Restore Defaults",
                        symbolName: "arrow.uturn.backward"
                    )
                )
            )
        case .meetings:
            return liveMeetingsWindowState()
        case .meetingPermissions:
            return .content(
                liveWindowFixture(
                    kind: kind,
                    title: "Meeting Permissions",
                    subtitle: "Review and update the macOS privacy controls used by meeting capture.",
                    symbol: "lock.shield",
                    rows: [
                        HQWindowRowFixture(
                            id: "accessibility",
                            title: "Accessibility",
                            detail: "Lets HQ detect and follow supported meeting windows.",
                            symbolName: Self.permissionSymbol(
                                for: meetingPermissionSnapshot.accessibility
                            ),
                            value: Self.permissionTitle(
                                for: meetingPermissionSnapshot.accessibility
                            ),
                            metadata: [
                                "settingsDestination": .string(
                                    HQSystemSettingsDestination
                                        .accessibility.rawValue
                                ),
                            ]
                        ),
                        HQWindowRowFixture(
                            id: "screen-recording",
                            title: "Screen Recording",
                            detail: "Lets HQ capture the meeting window you choose.",
                            symbolName: Self.permissionSymbol(
                                for: meetingPermissionSnapshot.screenRecording
                            ),
                            value: Self.permissionTitle(
                                for: meetingPermissionSnapshot.screenRecording
                            ),
                            metadata: [
                                "settingsDestination": .string(
                                    HQSystemSettingsDestination
                                        .screenRecording.rawValue
                                ),
                            ]
                        ),
                        HQWindowRowFixture(
                            id: "microphone",
                            title: "Microphone",
                            detail: "Lets HQ capture meeting audio while recording.",
                            symbolName: Self.permissionSymbol(
                                for: meetingPermissionSnapshot.microphone
                            ),
                            value: Self.permissionTitle(
                                for: meetingPermissionSnapshot.microphone
                            ),
                            metadata: [
                                "settingsDestination": .string(
                                    HQSystemSettingsDestination
                                        .microphone.rawValue
                                ),
                            ]
                        ),
                    ],
                    primary: HQWindowActionFixture(
                        id: "check",
                        title: "Check Again",
                        symbolName: "arrow.clockwise"
                    ),
                    secondary: nil
                )
            )
        case .directMessageDetail:
            if let message = secondaryDomainValues["dm:detail-event"].flatMap(
                    HQRealtimeDirectMessage.init(value:)
                )
                ?? nativeParityEvents.dmDetailMessage
            {
                return nativeDirectMessageDetailState(
                    kind: kind,
                    message: message
                )
            }
            return .empty(
                HQWindowEmptyState(
                    title: "Choose a conversation",
                    message: isAuthenticated
                        ? "Open a direct message before replying."
                        : "Sign in to view direct messages."
                )
            )
        case .messages:
            if let target = nativeParityEvents.conversationTarget {
                let title = target.displayName.trimmingCharacters(
                    in: .whitespacesAndNewlines
                )
                let email = target.email.trimmingCharacters(
                    in: .whitespacesAndNewlines
                )
                return .content(
                    liveWindowFixture(
                        kind: kind,
                        title: title.isEmpty ? email : title,
                        subtitle: "Selected HQ direct-message conversation.",
                        symbol: "bubble.left.and.bubble.right",
                        rows: [
                            HQWindowRowFixture(
                                id: target.personUID.isEmpty
                                    ? "email-\(email)"
                                    : "person-\(target.personUID)",
                                title: title.isEmpty ? email : title,
                                detail: email,
                                symbolName: "message"
                            ),
                        ],
                        primary: nil,
                        secondary: nil
                    )
                )
            }
            return liveDomainWindowState(
                kind: kind,
                methods: [
                    "fetch_notification_history",
                    "list_channels",
                    "list_dm_requests",
                ],
                collectionKeys: ["channels", "requests"],
                title: "Messages",
                subtitle: "Channels and direct-message requests from HQ.",
                symbol: "bubble.left.and.bubble.right",
                emptyTitle: "No messages yet",
                emptyMessage: isAuthenticated
                    ? "No channels or direct-message requests were returned."
                    : "Sign in to load channels and direct messages.",
                primary: nil,
                secondary: nil,
                renderEmptyContent: !domainRows(
                    method: "fetch_notification_history",
                    collectionKey: "dms"
                ).isEmpty
            )
        case .shareDetail:
            if let share = nativeParityEvents.selectedShare
                ?? secondaryDomainValues["share:events-list"]?
                    .arrayValue?.first.flatMap(nativeParityShare(from:))
            {
                return nativeShareDetailState(kind: kind, share: share)
            }
            return liveDomainWindowState(
                kind: kind,
                methods: ["fetch_notification_history"],
                collectionKeys: ["shares"],
                title: "Shared with you",
                subtitle: "Recent secure shares from HQ.",
                symbol: "person.2.wave.2",
                emptyTitle: "No share selected",
                emptyMessage: isAuthenticated
                    ? "Open a share notification to inspect its details."
                    : "Sign in to load secure shares.",
                primary: nil,
                secondary: nil
            )
        case .banner:
            return isBannerPresented
                ? .content(
                    liveWindowFixture(
                        kind: kind,
                        title: "HQ notification",
                        subtitle: "A user-requested native preview is active.",
                        symbol: "bell",
                        rows: [],
                        primary: nil,
                        secondary: nil
                    )
                )
                : .empty(
                    HQWindowEmptyState(
                        title: "No active notification",
                        message: "Native HQ banners appear here when a live event arrives."
                    )
                )
        case .widget:
            return .content(
                liveWindowFixture(
                    kind: kind,
                    title: "HQ",
                    subtitle: phase == .ready ? "Live engine connected" : "Engine unavailable",
                    symbol: "square.grid.2x2",
                    rows: [
                        HQWindowRowFixture(
                            id: "workspaces",
                            title: "Workspaces",
                            detail: "Live local discovery",
                            symbolName: "building.2",
                            value: "\(content.snapshot.workspaces.count)"
                        ),
                        HQWindowRowFixture(
                            id: "projects",
                            title: "Projects",
                            detail: "Live local project index",
                            symbolName: "square.stack.3d.up",
                            value: "\(content.snapshot.projects.count)"
                        ),
                    ],
                    primary: HQWindowActionFixture(
                        id: "open",
                        title: "Open HQ",
                        symbolName: "macwindow"
                    ),
                    secondary: nil
                )
            )
        case .activity:
            return liveDomainWindowState(
                kind: kind,
                methods: ["get_activity_log", "get_company_activity"],
                collectionKeys: ["activity", "events", "items"],
                title: "Recent Changes",
                subtitle: "Local HQ activity and authenticated company changes.",
                symbol: "clock.arrow.circlepath",
                emptyTitle: "No recent changes",
                emptyMessage: isAuthenticated
                    ? "HQ returned no local or company activity."
                    : "No local activity is available; sign in for company activity.",
                primary: HQWindowActionFixture(
                    id: "refresh",
                    title: "Refresh",
                    symbolName: "arrow.clockwise"
                ),
                secondary: nil
            )
        case .drift:
            return liveDomainWindowState(
                kind: kind,
                methods: ["get_lifecycle_state"],
                collectionKeys: ["changes", "steps", "state"],
                title: "HQ Core Changes",
                subtitle: "Current lifecycle and local-core state from the bundled engine.",
                symbol: "arrow.triangle.branch",
                emptyTitle: "No core changes",
                emptyMessage: "The engine reported no lifecycle or core changes.",
                primary: HQWindowActionFixture(
                    id: "review",
                    title: "Review Changes",
                    symbolName: "doc.text.magnifyingglass"
                ),
                secondary: HQWindowActionFixture(
                    id: "preserve",
                    title: "Reveal Workspace",
                    symbolName: "folder"
                )
            )
        case .newFiles:
            return liveDomainWindowState(
                kind: kind,
                methods: ["fetch_notification_history"],
                collectionKeys: ["files"],
                title: "New Files",
                subtitle: "Files reported by the live HQ notification history.",
                symbol: "doc.badge.plus",
                emptyTitle: "No new files",
                emptyMessage: isAuthenticated
                    ? "HQ returned no new files."
                    : "Sign in to load new-file history.",
                primary: HQWindowActionFixture(
                    id: "review-files",
                    title: "Review Files",
                    symbolName: "doc.text.magnifyingglass"
                ),
                secondary: HQWindowActionFixture(
                    id: "reveal",
                    title: "Reveal Workspace",
                    symbolName: "folder"
                )
            )
        case .notificationHistory:
            return liveDomainWindowState(
                kind: kind,
                methods: ["fetch_notification_history"],
                collectionKeys: ["dms", "shares", "files"],
                title: "Notifications",
                subtitle: "Direct-message, share, and file history from HQ.",
                symbol: "bell.badge",
                emptyTitle: "No notifications",
                emptyMessage: isAuthenticated
                    ? "HQ returned no notification history."
                    : "Sign in to load notification history.",
                primary: HQWindowActionFixture(
                    id: "mark-read",
                    title: "Mark All Read",
                    symbolName: "checkmark.circle"
                ),
                secondary: HQWindowActionFixture(
                    id: "settings",
                    title: "Notification Settings",
                    symbolName: "gearshape"
                )
            )
        case .recovery:
            return .content(
                liveWindowFixture(
                    kind: kind,
                    title: "HQ Recovery",
                    subtitle: setupStages.allSatisfy({
                        $0.status == .complete
                    })
                        ? "Every native setup stage is healthy."
                        : "Retry incomplete setup stages without repeating completed work.",
                    symbol: "cross.case",
                    rows: setupStages.map { stage in
                        HQWindowRowFixture(
                            id: "stage.\(stage.id.rawValue)",
                            title: stage.id.title,
                            detail: stage.detail,
                            symbolName: stage.id.symbolName,
                            value: stage.status.displayValue
                        )
                    },
                    primary: setupIsRunning
                        ? nil
                        : HQWindowActionFixture(
                            id: "repair",
                            title: "Run Recovery",
                            symbolName: "cross.case.fill"
                        ),
                    secondary: HQWindowActionFixture(
                        id: "export",
                        title: "Open Activity Log",
                        symbolName: "clock.arrow.circlepath"
                    )
                )
            )
        case .signIn:
            return .content(
                liveWindowFixture(
                    kind: kind,
                    title: isAuthenticated ? "Signed in to HQ" : "Sign in to HQ",
                    subtitle: isAuthenticated
                        ? "This Mac has an active HQ authentication session."
                        : "Authenticate securely in your browser with PKCE and a loopback callback.",
                    symbol: isAuthenticated ? "checkmark.shield" : "person.crop.circle",
                    rows: [
                        HQWindowRowFixture(
                            id: "authentication",
                            title: "Authentication",
                            detail: isAuthenticated
                                ? "Protected cloud capabilities are enabled."
                                : "Choose an identity provider to continue.",
                            symbolName: "lock.shield",
                            value: isAuthenticated ? "Active" : "Required"
                        ),
                    ],
                    primary: isAuthenticated
                        ? nil
                        : HQWindowActionFixture(
                            id: "sign-in-google",
                            title: "Continue with Google",
                            symbolName: "safari"
                        ),
                    secondary: isAuthenticated
                        ? nil
                        : HQWindowActionFixture(
                            id: "sign-in-microsoft",
                            title: "Continue with Microsoft",
                            symbolName: "safari"
                        )
                )
            )
        }
    }

    private func reloadLiveContent() async {
        if launchMode == .visualTourFixture {
            prepareVisualTourState()
            await loadLiveRoute(selectedRoute)
            operationState = .success(
                "Deterministic production-surface tour reloaded."
            )
            return
        }
        guard launchMode == .live else {
            operationState = .success("Testing data is already loaded.")
            return
        }
        if case .failed = phase, engineFactory != nil {
            guard await replaceEngineAfterFailure() else { return }
        }
        liveRouteStates.removeAll()
        didStart = false
        await start()
        if isAuthenticated {
            await loadLiveRoute(selectedRoute)
        } else {
            liveRouteStates.removeAll()
        }
    }

    private func replaceEngineAfterFailure() async -> Bool {
        engineGeneration &+= 1
        eventTask?.cancel()
        eventTask = nil
        lifecycleTask?.cancel()
        lifecycleTask = nil

        if let engine {
            await engine.stop()
        }
        for task in recordingCleanupTasks.values {
            task.cancel()
        }
        recordingCleanupTasks.removeAll()
        recordingReaperTask?.cancel()
        recordingReaperTask = nil
        recordingReaperGeneration = nil
        activeRecordingStartWindows.removeAll()
        pendingRecordingCleanup.removeAll()
        activeRecallRecordings.removeAll()
        recallMediaCapture.removeAll()

        guard let engineFactory else { return false }
        do {
            engine = try engineFactory()
            bootstrapFailure = nil
            capabilities.removeAll()
            return true
        } catch {
            engine = nil
            let detail = Self.message(for: error)
            bootstrapFailure = detail
            failStartup(
                "The bundled HQ engine could not be restarted: \(detail)"
            )
            return false
        }
    }

    private func requestSync() async {
        guard capabilities.contains("start_sync") else {
            operationState = .failure(
                "Sync cannot start because the HQ engine did not advertise the required “start_sync” capability."
            )
            return
        }
        await requestMutation(
            method: "start_sync",
            params: .object([:]),
            success: "Sync completed."
        )
    }

    func isMutationInFlight(
        method: String,
        params: HQJSONValue
    ) -> Bool {
        activeMutationKeys.contains(
            Self.mutationKey(method: method, params: params)
        )
    }

    @discardableResult
    private func requestMutation(
        method: String,
        params: HQJSONValue,
        success: String
    ) async -> Bool {
        guard capabilities.contains(method) else {
            operationState = .failure(
                "This action requires the “\(method)” capability, which the HQ engine did not advertise."
            )
            return false
        }
        guard let engine else {
            operationState = .failure("The bundled HQ engine is unavailable.")
            return false
        }
        if case .failed = phase {
            operationState = .failure(
                "The HQ engine must be refreshed before protected actions can continue."
            )
            return false
        }
        guard hasProtectedAccess else {
            operationState = .failure(
                "Sign in before running protected HQ actions."
            )
            return false
        }
        let recordingStartWindowID =
            method == HQEngineAppCommand.startRecording.rawValue
                ? params.object?["windowId"]?.stringValue
                : nil
        if let recordingStartWindowID {
            guard pendingRecordingCleanup[recordingStartWindowID] == nil
            else {
                operationState = .failure(
                    "Meeting capture cleanup is still finishing for this window. Refresh HQ if it does not complete."
                )
                return false
            }
            guard activeRecallRecordings[recordingStartWindowID] == nil
            else {
                operationState = .failure(
                    "Meeting capture is already active for this window."
                )
                return false
            }
            guard activeRecordingStartWindows.insert(
                recordingStartWindowID
            ).inserted else {
                operationState = .failure(
                    "Meeting capture is already starting for this window."
                )
                return false
            }
        }
        defer {
            if let recordingStartWindowID {
                activeRecordingStartWindows.remove(recordingStartWindowID)
            }
        }
        let dataGeneration = authenticatedDataGeneration
        let requestEngineGeneration = engineGeneration
        let mutationKey = Self.mutationKey(method: method, params: params)
        guard activeMutationKeys.insert(mutationKey).inserted else {
            return false
        }
        defer { activeMutationKeys.remove(mutationKey) }

        operationState = .busy("Running \(method)…")
        do {
            _ = try await engine.request(method, params: params)
            guard hasProtectedAccess,
                  dataGeneration == authenticatedDataGeneration
            else {
                if method == HQEngineAppCommand.startRecording.rawValue,
                   let windowID = params.object?["windowId"]?.stringValue
                {
                    await compensateStaleRecordingStart(
                        windowID: windowID,
                        through: engine,
                        engineGeneration: requestEngineGeneration
                    )
                }
                return false
            }
            if launchMode == .live,
               phase == .ready,
               isAuthenticated,
               method != HQEngineAppCommand.signOut.rawValue
            {
                await loadLiveRoute(selectedRoute)
                guard hasProtectedAccess,
                      dataGeneration == authenticatedDataGeneration
                else {
                    return false
                }
            }
            operationState = .success(success)
            return true
        } catch {
            let failureMessage = Self.message(for: error)
            if method == HQEngineAppCommand.startRecording.rawValue,
               let windowID = recordingStartWindowID
            {
                await compensateStaleRecordingStart(
                    windowID: windowID,
                    through: engine,
                    engineGeneration: requestEngineGeneration
                )
                if case .failed = phase {
                    return false
                }
            }
            operationState = .failure(failureMessage)
            return false
        }
    }

    private static func mutationKey(
        method: String,
        params: HQJSONValue
    ) -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let encoded = (try? encoder.encode(params))
            .flatMap { String(data: $0, encoding: .utf8) } ?? "null"
        return "\(method)|\(encoded)"
    }

    private func installMarketplacePack(
        listingID: String,
        slug: String,
        version: String?,
        scope: HQJSONValue
    ) async {
        let params: HQJSONValue = .object([
            "slug": .string(slug),
            "version": version.map(HQJSONValue.string) ?? .null,
            "scope": scope,
        ])
        guard await requestMutation(
            method: HQEngineAppCommand.installMarketplacePack.rawValue,
            params: params,
            success: "Installed \(slug)."
        ) else {
            return
        }
        guard hasProtectedAccess,
              capabilities.contains("record_marketplace_install"),
              let engine
        else {
            return
        }
        _ = try? await engine.request(
            "record_marketplace_install",
            params: .object([
                "listingId": .string(listingID),
                "scope": scope,
            ])
        )
    }

    private func performNative(
        _ command: HQNativeCommand,
        payload: HQJSONValue?
    ) async {
        switch HQNativeActionRegistry.resolution(for: command) {
        case let .disabled(reason):
            operationState = .failure(
                "\(command.rawValue) is unavailable: \(reason)"
            )
        case let .implemented(implementation):
            lastNativeResult = .null
            await performNativeImplementation(implementation, payload: payload)
        }
    }

    private func performNativeImplementation(
        _ implementation: HQNativeCommandImplementation,
        payload: HQJSONValue?
    ) async {
        switch implementation {
        case let .sceneReady(sceneID):
            await sceneDidBecomeReady(sceneID)
        case let .openScene(kind):
            if kind == .messages,
               let target = nativeConversationTarget(from: payload)
            {
                applyNativeParityEffect(
                    nativeParityEvents.openConversation(target)
                )
            } else {
                sceneRequest = HQAppSceneRequest(sceneID: kind.rawValue)
            }
        case .openMeetingsWindow:
            let focusMeetingID = payload?.object?["focusMeetingId"]?.stringValue?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if let focusMeetingID, !focusMeetingID.isEmpty {
                pendingMeetingFocusID = focusMeetingID
            }
            sceneRequest = HQAppSceneRequest(
                sceneID: HQSecondaryWindowKind.meetings.rawValue
            )
        case .showMainWindow:
            sceneRequest = HQAppSceneRequest(sceneID: "main")
        case .showMainWindowAtTray:
            // The legacy host reused its main window as a faux popover and had
            // to move that window beneath a separate status item. The native
            // host has a real, permanently registered MenuBarExtra, so there is
            // no free-floating window to reposition. Record the handoff and
            // draw attention to the already-anchored native control; opening a
            // full main window here would invert the legacy intent.
            menuBarHandoffGeneration += 1
            trayState = .attention
            lastNativeResult = .null
            operationState = .success(
                "HQ is ready in the native MenuBarExtra."
            )
        case let .navigate(route):
            selectedRoute = route
            sceneRequest = HQAppSceneRequest(sceneID: "main")
        case .dismissBanner:
            dismissActiveBanner()
            closeSecondaryWindow(.banner)
            operationState = .success("Notification dismissed.")
        case .bannerAction:
            dismissActiveBanner()
            closeSecondaryWindow(.banner)
            operationState = .success("Notification opened.")
            sceneRequest = HQAppSceneRequest(sceneID: "main")
        case let .previewBanner(kind):
            presentBanner(Self.previewBannerPayload(for: kind))
        case .quit:
            NSApplication.shared.terminate(nil)
        case .openInEditor:
            let rawPath = payload?.stringValue
                ?? payload?.object?["path"]?.stringValue
            guard let rawPath,
                  !rawPath.trimmingCharacters(
                    in: .whitespacesAndNewlines
                  ).isEmpty
            else {
                operationState = .failure(
                    "open_in_editor requires a nonempty path."
                )
                return
            }
            do {
                let url = try validatedWorkspaceURL(forPath: rawPath)
                try openWorkspaceURL(url)
                lastNativeResult = .null
                operationState = .success(
                    "Opened \(url.lastPathComponent) in its default editor."
                )
            } catch {
                operationState = .failure(Self.message(for: error))
            }
        case .pickAvatarFile:
            let selection = pickFiles(
                HQFilePickerRequest(
                    mode: .files(
                        allowedContentTypes: [
                            .png,
                            .jpeg,
                            .webP,
                            .gif,
                        ]
                    ),
                    message: "Choose an avatar image",
                    prompt: "Choose"
                )
            )
            lastNativeResult = selection.first.map {
                .string($0.path)
            } ?? .null
            operationState = .success(
                selection.first == nil
                    ? "Avatar selection cancelled."
                    : "Selected an avatar image."
            )
        case .pickFolder:
            await chooseHQFolder()
        case .pickPackDirectory:
            let selection = pickFiles(
                HQFilePickerRequest(
                    mode: .folders,
                    message: "Choose a skill or worker folder to publish",
                    prompt: "Choose"
                )
            )
            lastNativeResult = selection.first.map {
                .string($0.path)
            } ?? .null
            operationState = .success(
                selection.first == nil
                    ? "Pack selection cancelled."
                    : "Selected a pack folder."
            )
        case .revealFolder:
            guard let path = payload?.stringValue, !path.isEmpty else {
                operationState = .failure(
                    "reveal_folder requires an explicit local path."
                )
                return
            }
            do {
                try HQNativeWorkspaceService().revealInFinder([
                    URL(fileURLWithPath: path)
                ])
                lastNativeResult = .null
                operationState = .success("Revealed the folder in Finder.")
            } catch {
                operationState = .failure(Self.message(for: error))
            }
        case .getAutostart:
            let state = HQNativeLaunchAtLoginService().state
            lastNativeResult = .bool(state == .enabled)
            operationState = .success(
                "Launch at login is \(Self.description(for: state))."
            )
        case .setAutostart:
            guard let enabled = payload?.boolValue else {
                operationState = .failure(
                    "set_autostart_enabled requires a Boolean payload."
                )
                return
            }
            operationState = .busy("Updating launch at login…")
            do {
                try await HQNativeLaunchAtLoginService().setEnabled(enabled)
                lastNativeResult = .null
                operationState = .success(
                    enabled ? "Launch at login enabled." : "Launch at login disabled."
                )
            } catch {
                operationState = .failure(Self.message(for: error))
            }
        case .homeDirectory:
            lastNativeResult = .string(
                FileManager.default.homeDirectoryForCurrentUser.path
            )
            operationState = .success(
                FileManager.default.homeDirectoryForCurrentUser.path
            )
        case .listDisplays:
            lastNativeResult = .array(
                NSScreen.screens.enumerated().map { index, screen in
                    .object([
                        "name": .string(screen.localizedName),
                        "primary": .bool(index == 0),
                    ])
                }
            )
            operationState = .success(
                "Detected \(NSScreen.screens.count) display\(NSScreen.screens.count == 1 ? "" : "s")."
            )
        case .requestNotificationPermission:
            operationState = .busy("Requesting notification permission…")
            do {
                let granted = try await notificationService
                    .requestAuthorization()
                lastNativeResult = .string(
                    granted ? "granted" : "denied"
                )
                operationState = granted
                    ? .success("Notification permission granted.")
                    : .failure("Notification permission was not granted.")
            } catch {
                operationState = .failure(Self.message(for: error))
            }
        case .openPrivacySettings:
            let destinationName = payload?.stringValue
                ?? payload?.object?["destination"]?.stringValue
                ?? HQSystemSettingsDestination.microphone.rawValue
            guard let destination = HQSystemSettingsDestination(
                rawValue: destinationName
            ) else {
                operationState = .failure(
                    "Unknown System Settings destination “\(destinationName)”."
                )
                return
            }
            do {
                try openSystemSettings(destination)
                operationState = .success(
                    "Opened \(Self.systemSettingsTitle(for: destination)) settings."
                )
            } catch {
                operationState = .failure(Self.message(for: error))
            }
        case .applyWidgetSettings:
            let modeName = payload?.object?["mode"]?.stringValue
            let requestedMode: HQWidgetMode?
            if let modeName {
                requestedMode = HQWidgetMode(rawValue: modeName)
            } else if payload?.object?["reset"]?.boolValue == true {
                requestedMode = .expanded
            } else {
                requestedMode = nil
            }
            guard let requestedMode else {
                operationState = .failure(
                    "apply_widget_settings requires compact or expanded mode."
                )
                return
            }
            widgetMode = requestedMode
            persistWidgetMode(requestedMode)
            lastNativeResult = .null
            operationState = .success("Widget settings applied.")
        case .availableUpdateChannels:
            let channels = HQReleaseChannel.availableChannels(
                isIndigoUser: isIndigoWorkspace
            )
            lastNativeResult = .array(channels.map { .string($0.rawValue) })
            operationState = .success(
                "Available update channels: \(channels.map(\.rawValue).joined(separator: ", "))."
            )
        case .checkForUpdates:
            do {
                try startUpdaterIfNeeded()
                try updaterService.checkForUpdates()
                operationState = .busy("Checking for signed HQ updates…")
            } catch {
                operationState = .failure(Self.message(for: error))
            }
        case let .applicationInstalled(bundleIdentifiers):
            let installedIdentifier = bundleIdentifiers.first {
                NSWorkspace.shared.urlForApplication(
                    withBundleIdentifier: $0
                ) != nil
            }
            lastNativeResult = .bool(installedIdentifier != nil)
            operationState = .success(
                installedIdentifier == nil
                    ? "The requested application is not installed."
                    : "The requested application is installed."
            )
        case .pendingUpdate:
            do {
                try startUpdaterIfNeeded()
                lastNativeResult = Self.legacyPendingUpdateJSON(
                    for: updaterService.state
                )
                operationState = .success("Read the signed updater state.")
            } catch {
                operationState = .failure(Self.message(for: error))
            }
        case .installUpdate:
            do {
                try startUpdaterIfNeeded()
                try updaterService.presentAvailableUpdate()
                operationState = .success("Presented the signed update installer.")
            } catch {
                operationState = .failure(Self.message(for: error))
            }
        case .keychainDelete:
            performLegacyKeychainDelete(payload)
        case .keychainGet:
            performLegacyKeychainGet(payload)
        case .keychainSet:
            performLegacyKeychainSet(payload)
        case let .launchApplication(bundleIdentifiers):
            await launchApplication(bundleIdentifiers: bundleIdentifiers)
        case .launchTerminal:
            await launchApplication(bundleIdentifiers: ["com.apple.Terminal"])
        case .meetingPermissionsState:
            refreshMeetingPermissionSnapshot()
            operationState = .success("Meeting permission state refreshed.")
        case .clearMeetingPromptBadge:
            setMeetingPromptBadgeCount(
                max(0, meetingPromptBadgeCount - 1)
            )
            lastNativeResult = .null
            operationState = .success("Meeting prompt badge updated.")
        case .setMeetingPromptBadge:
            let count = payload?.numberValue
                ?? payload?.object?["count"]?.numberValue
            if let count {
                guard count >= 0, count.rounded() == count else {
                    operationState = .failure(
                        "meetings_set_prompt_badge requires a nonnegative integer count."
                    )
                    return
                }
                setMeetingPromptBadgeCount(Int(count))
            } else {
                operationState = .failure(
                    "meetings_set_prompt_badge requires a nonnegative integer count."
                )
                return
            }
            lastNativeResult = .null
            operationState = .success(
                meetingPromptBadgeVisible
                    ? "Meeting prompt badge shown."
                    : "Meeting prompt badge cleared."
            )
        case .takePendingMeetingFocus:
            if let pendingMeetingFocusID {
                focusedMeetingID = pendingMeetingFocusID
            }
            lastNativeResult = pendingMeetingFocusID.map {
                .string($0)
            } ?? .null
            pendingMeetingFocusID = nil
            operationState = .success("Read pending meeting focus.")
        case .takePendingMessagesTarget:
            lastNativeResult = pendingMessagesTarget.map {
                .object([
                    "personUid": .string($0.personUID),
                    "email": .string($0.email),
                    "displayName": .string($0.displayName),
                ])
            } ?? .null
            pendingMessagesTarget = nil
            operationState = .success("Read pending Messages target.")
        case .menuBarInstalled:
            lastNativeResult = .object([
                "installed": .bool(true),
                "version": Bundle.main.object(
                    forInfoDictionaryKey: "CFBundleShortVersionString"
                ).map { .string(String(describing: $0)) } ?? .null,
                "exePath": Bundle.main.executableURL.map {
                    .string($0.path)
                } ?? .null,
            ])
            operationState = .success("The native menu bar scene is active.")
        case .notificationPermissionState:
            let settings = await UNUserNotificationCenter.current()
                .notificationSettings()
            let status = Self.description(for: settings.authorizationStatus)
            lastNativeResult = .string(status)
            operationState = .success("Notification permission is \(status).")
        case .openExternalLink:
            guard let rawURL = payload?.stringValue,
                  let url = URL(string: rawURL),
                  let scheme = url.scheme?.lowercased(),
                  ["https", "http", "claude", "hqx"].contains(scheme)
            else {
                operationState = .failure(
                    "open_claude_code_link requires a validated HTTPS, Claude, or HQ link."
                )
                return
            }
            do {
                try HQNativeWorkspaceService().openURL(url)
                operationState = .success("Opened the external link.")
            } catch {
                operationState = .failure(Self.message(for: error))
            }
        case .forcePermissionRegistration:
            NSApplication.shared.registerForRemoteNotifications()
            sceneRequest = HQAppSceneRequest(
                sceneID: HQSecondaryWindowKind.meetingPermissions.rawValue
            )
            operationState = .success(
                "Registered for native notifications and opened the permission checklist."
            )
        case let .resizeWindow(kind):
            let descriptor = HQSceneRegistration.descriptor(for: kind.rawValue)
            let width = payload?.object?["width"]?.numberValue
                ?? Double(descriptor.width)
            let height = payload?.object?["height"]?.numberValue
                ?? Double(descriptor.height)
            guard width > 0, height > 0 else {
                operationState = .failure(
                    "\(kind.rawValue) size must be positive."
                )
                return
            }
            guard let window = NSApplication.shared.windows.first(where: {
                $0.title == descriptor.title
            }) else {
                sceneRequest = HQAppSceneRequest(sceneID: kind.rawValue)
                operationState = .success(
                    "Opened \(descriptor.title) at its requested size."
                )
                return
            }
            window.setContentSize(
                NSSize(width: width, height: height)
            )
            operationState = .success("Resized \(descriptor.title).")
        case .setTrayState:
            let rawState = payload?.stringValue
                ?? payload?.object?["state"]?.stringValue
                ?? "idle"
            let normalizedState: HQTrayState? = switch rawState.lowercased() {
            case "idle", "current": .current
            case "syncing": .syncing
            case "error": .error
            case "conflict", "prompt", "attention": .attention
            default: nil
            }
            guard let state = normalizedState else {
                operationState = .failure(
                    "Unknown tray state “\(rawState)”."
                )
                return
            }
            trayState = state
            lastNativeResult = .null
            operationState = .success("Menu bar state is \(state.rawValue).")
        case .setMainWindowVibrancy:
            let enabled = payload?.boolValue
                ?? payload?.object?["enabled"]?.boolValue
            guard let enabled else {
                operationState = .failure(
                    "set_main_window_vibrancy requires an enabled Boolean."
                )
                return
            }
            mainWindowVibrancyEnabled = enabled
            if let mainWindow = NSApplication.shared.windows.first(where: {
                $0.title
                    == HQSceneRegistration.descriptor(for: "main").title
            }) {
                mainWindow.isOpaque = !enabled
                mainWindow.backgroundColor = enabled
                    ? .clear
                    : .windowBackgroundColor
            }
            lastNativeResult = .null
            operationState = .success(
                enabled
                    ? "Native window material enabled."
                    : "Native window material disabled."
            )
        case .setWidgetFocusable:
            widgetIsFocusable = payload?.boolValue
                ?? payload?.object?["focusable"]?.boolValue
                ?? true
            if let widgetWindow = NSApplication.shared.windows.first(where: {
                $0.title == HQSceneRegistration.descriptor(for: "widget").title
            }) {
                widgetWindow.ignoresMouseEvents = !widgetIsFocusable
                widgetWindow.level = widgetIsFocusable ? .floating : .normal
            }
            lastNativeResult = .null
            operationState = .success(
                widgetIsFocusable
                    ? "Widget accepts focus."
                    : "Widget ignores pointer focus."
            )
        }
    }

    private func chooseHQFolder() async {
        workspaceOperationGeneration &+= 1
        let operationGeneration = workspaceOperationGeneration
        let startingAuthGeneration = authenticatedDataGeneration
        var rollbackSettings: HQJSONValue?
        var rollbackPath: String?
        var holdsFolderWriteGate = false
        defer {
            if holdsFolderWriteGate {
                folderWriteGate.release()
            }
        }
        let selection = pickFiles(
            HQFilePickerRequest(
                mode: .folders,
                message: "Choose an HQ workspace folder",
                prompt: "Choose"
            )
        )
        guard let selectedURL = selection.first else {
            lastNativeResult = .null
            operationState = .success("Folder selection cancelled.")
            return
        }
        guard let engine else {
            operationState = .failure(
                "The HQ engine is unavailable to validate this folder."
            )
            return
        }

        let requiredMethods = [
            "detect_hq",
            "check_writable",
            "get_settings",
            "save_settings",
            "workspaces.list",
        ]
        guard requiredMethods.allSatisfy(capabilities.contains) else {
            operationState = .failure(
                "This HQ engine cannot validate and save an HQ folder."
            )
            return
        }

        let path = selectedURL.standardizedFileURL.path
        operationState = .busy("Checking the selected HQ folder…")
        do {
            async let detectionRequest = engine.request(
                "detect_hq",
                params: .object(["path": .string(path)])
            )
            async let writableRequest = engine.request(
                "check_writable",
                params: .object(["path": .string(path)])
            )
            let (detectionValue, writableValue) = try await (
                detectionRequest,
                writableRequest
            )
            guard operationGeneration == workspaceOperationGeneration,
                  startingAuthGeneration == authenticatedDataGeneration
            else {
                operationState = .failure(
                    "The folder choice was superseded before validation completed."
                )
                return
            }
            guard let detection = detectionValue.object,
                  let exists = detection["exists"]?.boolValue,
                  let isHQ = detection["isHq"]?.boolValue,
                  let nonEmpty = detection["nonEmpty"]?.boolValue,
                  let writable = writableValue.boolValue
            else {
                operationState = .failure(
                    "HQ returned an invalid folder-validation response."
                )
                return
            }
            guard writable else {
                operationState = .failure(
                    "\(path) is not writable. Choose another folder."
                )
                return
            }
            guard !(exists && nonEmpty && !isHQ) else {
                operationState = .failure(
                    "\(path) already has files and is not an HQ folder."
                )
                return
            }

            await folderWriteGate.acquire()
            holdsFolderWriteGate = true
            guard operationGeneration == workspaceOperationGeneration,
                  startingAuthGeneration == authenticatedDataGeneration
            else {
                operationState = .failure(
                    "The folder choice was superseded before it could acquire the settings transaction."
                )
                return
            }
            let settingsValue = try await engine.request(
                "get_settings",
                params: .object([:])
            )
            guard operationGeneration == workspaceOperationGeneration,
                  startingAuthGeneration == authenticatedDataGeneration
            else {
                operationState = .failure(
                    "The folder choice was superseded before it could be saved."
                )
                return
            }
            guard var settings = settingsValue.object else {
                operationState = .failure(
                    "HQ returned invalid settings while saving the folder."
                )
                return
            }
            settings["hqPath"] = .string(path)
            // Establish reconciliation intent before the request. The engine
            // may commit settings and then lose its response transport.
            rollbackSettings = settingsValue
            rollbackPath = path
            _ = try await engine.request(
                "save_settings",
                params: .object(["prefs": .object(settings)])
            )
            guard operationGeneration == workspaceOperationGeneration,
                  startingAuthGeneration == authenticatedDataGeneration
            else {
                if let rollbackFailure = await rollbackHQFolderSettings(
                    settingsValue,
                    replacingPath: path,
                    through: engine
                ) {
                    failHQFolderReconciliation(
                        path: path,
                        reason: rollbackFailure
                    )
                    return
                }
                operationState = .failure(
                    "The folder choice was superseded while it was being saved."
                )
                return
            }

            authenticatedDataGeneration &+= 1
            let dataGeneration = authenticatedDataGeneration
            guard try await rehydrateLiveState(
                from: engine,
                fallbackHQPath: path,
                generation: dataGeneration
            ) else {
                if let rollbackFailure = await rollbackHQFolderSettings(
                    settingsValue,
                    replacingPath: path,
                    through: engine
                ) {
                    failHQFolderReconciliation(
                        path: path,
                        reason: rollbackFailure
                    )
                }
                return
            }
            lastNativeResult = .string(path)
            operationState = .success("HQ folder updated to \(path).")
            rollbackSettings = nil
            rollbackPath = nil
        } catch {
            if let rollbackSettings, let rollbackPath {
                if let rollbackFailure = await rollbackHQFolderSettings(
                    rollbackSettings,
                    replacingPath: rollbackPath,
                    through: engine
                ) {
                    failHQFolderReconciliation(
                        path: rollbackPath,
                        reason: rollbackFailure
                    )
                    return
                }
            }
            if operationGeneration == workspaceOperationGeneration {
                operationState = .failure(Self.message(for: error))
            }
        }
    }

    private func rollbackHQFolderSettings(
        _ previousSettings: HQJSONValue,
        replacingPath selectedPath: String,
        through engine: any HQAppEngine
    ) async -> String? {
        do {
            let current = try await engine.request(
                "get_settings",
                params: .object([:])
            )
            guard current.object?["hqPath"]?.stringValue == selectedPath
            else {
                return nil
            }
            _ = try await engine.request(
                "save_settings",
                params: .object(["prefs": previousSettings])
            )
            return nil
        } catch {
            return Self.message(for: error)
        }
    }

    private func failHQFolderReconciliation(
        path: String,
        reason: String
    ) {
        let message =
            "HQ could not verify or restore workspace settings after updating \(path): \(reason) Refresh HQ before continuing."
        phase = .failed(message)
        operationState = .failure(message)
    }

    private func rehydrateLiveState(
        from engine: any HQAppEngine,
        fallbackHQPath: String? = nil,
        authOverride: HQJSONValue? = nil,
        generation requestedGeneration: UInt64? = nil,
        oauthGeneration requiredOAuthGeneration: UInt64? = nil
    ) async throws -> Bool {
        let dataGeneration =
            requestedGeneration ?? authenticatedDataGeneration
        guard dataGeneration == authenticatedDataGeneration,
              requiredOAuthGeneration.map({
                  $0 == oauthFlowGeneration
              }) ?? true
        else {
            return false
        }
        let loadedConfig = capabilities.contains("config.get")
            ? try await engine.request("config.get", params: .object([:]))
            : .object([:])
        guard dataGeneration == authenticatedDataGeneration,
              requiredOAuthGeneration.map({
                  $0 == oauthFlowGeneration
              }) ?? true
        else {
            return false
        }
        let loadedAuth: HQJSONValue
        if let authOverride {
            loadedAuth = authOverride
        } else if capabilities.contains("auth.state") {
            loadedAuth = try await engine.request(
                "auth.state",
                params: .object([:])
            )
        } else {
            loadedAuth = .object(["authenticated": .bool(false)])
        }
        guard dataGeneration == authenticatedDataGeneration,
              requiredOAuthGeneration.map({
                  $0 == oauthFlowGeneration
              }) ?? true
        else {
            return false
        }
        let authenticated =
            loadedAuth.object?["authenticated"]?.boolValue ?? false
        authenticationStateResolved = true
        guard authenticated else {
            guard dataGeneration == authenticatedDataGeneration else {
                return false
            }
            config = .object([:])
            authState = loadedAuth
            syncState = .object([:])
            isAuthenticated = false
            requiresReauthentication =
                loadedAuth.object?["reauthRequired"]?.boolValue ?? false
            hqFolderPath = nil
            sessions = []
            content = .liveEmpty
            secondaryDomainValues.removeAll()
            secondaryDomainFailures.removeAll()
            secondaryDomainLoading.removeAll()
            liveRouteStates.removeAll()
            return true
        }
        let loadedSync = capabilities.contains("sync.status")
            ? try await engine.request("sync.status", params: .object([:]))
            : .object([:])
        guard dataGeneration == authenticatedDataGeneration,
              requiredOAuthGeneration.map({
                  $0 == oauthFlowGeneration
              }) ?? true
        else {
            return false
        }
        let loadedWorkspaces = try await engine.request(
            "workspaces.list",
            params: .object(["includeCloud": .bool(false)])
        )
        guard dataGeneration == authenticatedDataGeneration,
              requiredOAuthGeneration.map({
                  $0 == oauthFlowGeneration
              }) ?? true
        else {
            return false
        }
        let workspaces = Self.decodeWorkspaces(loadedWorkspaces)
        let loadedProjects = capabilities.contains("projects.list")
            ? try await engine.request(
                "projects.list",
                params: .object([:])
            )
            : .array([])
        guard dataGeneration == authenticatedDataGeneration,
              requiredOAuthGeneration.map({
                  $0 == oauthFlowGeneration
              }) ?? true
        else {
            return false
        }
        let loadedSessions = capabilities.contains("sessions.list")
            ? try await engine.request(
                "sessions.list",
                params: .object([:])
            )
            : .array([])
        let projects = Self.decodeProjects(
            loadedProjects,
            workspaces: workspaces
        )
        guard dataGeneration == authenticatedDataGeneration,
              requiredOAuthGeneration.map({
                  $0 == oauthFlowGeneration
              }) ?? true
        else {
            return false
        }

        config = loadedConfig
        authState = loadedAuth
        syncState = loadedSync
        isAuthenticated = true
        requiresReauthentication = false
        hqFolderPath = fallbackHQPath
            ?? loadedWorkspaces.object?["hqFolderPath"]?.stringValue
        sessions = Self.decodeSessions(loadedSessions)
        content = HQShellFixture(
            snapshot: HQSnapshot(
                workspaces: workspaces,
                projects: projects,
                goals: [:]
            ),
            messages: [],
            meetings: [],
            packs: [],
            libraryItems: [],
            people: [],
            activity: [],
            files: [],
            deployments: [],
            secrets: []
        )

        secondaryDomainValues.removeAll()
        secondaryDomainFailures.removeAll()
        secondaryDomainLoading.removeAll()
        liveRouteStates.removeAll()
        await loadSecondaryDomains(
            from: engine,
            companySlug: workspaces.first?.slug,
            generation: dataGeneration
        )
        guard dataGeneration == authenticatedDataGeneration else {
            return false
        }
        await loadLiveRoute(
            selectedRoute,
            generation: dataGeneration
        )
        return dataGeneration == authenticatedDataGeneration
            && (
                requiredOAuthGeneration.map {
                    $0 == oauthFlowGeneration
                } ?? true
            )
    }

    private func refreshMeetingPermissionSnapshot() {
        let snapshot = HQMeetingPermissionSnapshot(
            accessibility: accessibilityIsTrusted()
                ? .authorized
                : .denied,
            screenRecording: privacyAuthorization(.screenRecording),
            microphone: privacyAuthorization(.microphone)
        )
        meetingPermissionSnapshot = snapshot

        let accessibility = Self.description(
            for: snapshot.accessibility
        )
        let screenRecording = Self.description(
            for: snapshot.screenRecording
        )
        let microphone = Self.description(for: snapshot.microphone)
        lastNativeResult = .object([
            "accessibility": .string(accessibility),
            "screenCapture": .string(screenRecording),
            "microphone": .string(microphone),
            "systemAudio": .string(screenRecording),
            "fullDiskAccess": .string("unknown"),
            "allRequiredGranted": .bool(snapshot.allRequiredGranted),
        ])
    }

    private func presentBanner(_ payload: HQActiveBannerPayload) {
        activeBannerPayload = payload
        activeBannerKind = payload.kind
        isBannerPresented = true
        sceneRequest = HQAppSceneRequest(
            sceneID: HQSecondaryWindowKind.banner.rawValue
        )
    }

    private func dismissActiveBanner() {
        isBannerPresented = false
        activeBannerPayload = nil
    }

    private static func previewBannerPayload(
        for kind: HQBannerKind
    ) -> HQActiveBannerPayload {
        let fixture = HQBannerFixture.preview(for: kind)
        switch kind {
        case .syncComplete:
            return .syncComplete(
                company: "Indigo",
                message: fixture.message
            )
        case .meetingReady:
            return .meetingReady(
                title: fixture.title,
                message: fixture.message,
                windowID: "fixture-meeting-window",
                meetingID: "fixture-meeting",
                platform: "zoom"
            )
        case .directMessage:
            return .directMessage(
                HQRealtimeDirectMessage(
                    value: .object([
                        "eventId": .string("fixture-dm"),
                        "fromPersonUid": .string("fixture-person"),
                        "fromDisplayName": .string("Caitlin"),
                        "fromEmail": .string("caitlin@example.com"),
                        "body": .string(fixture.message),
                        "createdAt": .string(
                            "2026-07-27T00:00:00Z"
                        ),
                    ])
                )!
            )
        case .updateAvailable:
            return .updateAvailable(
                version: "12.4.0",
                body: fixture.message
            )
        }
    }

    private func setMeetingPromptBadgeCount(_ count: Int) {
        meetingPromptBadgeCount = max(0, count)
        meetingPromptBadgeVisible = meetingPromptBadgeCount > 0
    }

    private func closeSecondaryWindow(_ kind: HQSecondaryWindowKind) {
        let title = HQSceneRegistration.descriptor(
            for: kind.rawValue
        ).title
        NSApplication.shared.windows.first {
            $0.title == title
        }?.close()
    }

    private func validatedWorkspaceURL(forPath rawPath: String) throws -> URL {
        guard let hqFolderPath,
              !hqFolderPath.trimmingCharacters(
                in: .whitespacesAndNewlines
              ).isEmpty
        else {
            throw HQNativeCompatibilityError.workspaceUnavailable
        }

        let workspaceRoot = URL(
            fileURLWithPath: hqFolderPath,
            isDirectory: true
        )
        var rootIsDirectory: ObjCBool = false
        guard FileManager.default.fileExists(
            atPath: workspaceRoot.path,
            isDirectory: &rootIsDirectory
        ),
            rootIsDirectory.boolValue
        else {
            throw HQNativeCompatibilityError.invalidWorkspaceRoot(
                workspaceRoot.path
            )
        }

        let requestedURL = rawPath.hasPrefix("/")
            ? URL(fileURLWithPath: rawPath)
            : workspaceRoot.appendingPathComponent(rawPath)
        guard FileManager.default.fileExists(atPath: requestedURL.path) else {
            throw HQNativeCompatibilityError.missingWorkspacePath(rawPath)
        }

        let canonicalRoot = workspaceRoot
            .resolvingSymlinksInPath()
            .standardizedFileURL
        let canonicalRequest = requestedURL
            .resolvingSymlinksInPath()
            .standardizedFileURL
        let rootPrefix = canonicalRoot.path.hasSuffix("/")
            ? canonicalRoot.path
            : canonicalRoot.path + "/"
        guard canonicalRequest.path == canonicalRoot.path
            || canonicalRequest.path.hasPrefix(rootPrefix)
        else {
            throw HQNativeCompatibilityError.workspacePathEscapesRoot(
                rawPath
            )
        }
        return canonicalRequest
    }

    private func performLegacyKeychainSet(_ payload: HQJSONValue?) {
        guard let object = payload?.object,
              let service = object.string(for: "service"),
              let account = object.string(for: "account"),
              let secret = object.string(for: "secret")
        else {
            operationState = .failure(
                "keychain_set requires service, account, and secret strings."
            )
            return
        }
        guard Self.isLegacyCognitoKey(
            service: service,
            account: account
        ) else {
            operationState = .failure(
                "unsupported compat keychain entry"
            )
            return
        }
        guard Self.isValidLegacyCognitoTokenSecret(secret) else {
            operationState = .failure(
                "invalid cognito token payload"
            )
            return
        }

        do {
            try keychainStore.save(
                Data(secret.utf8),
                for: Self.legacyCognitoCredentialKey
            )
            lastNativeResult = .null
            operationState = .success("Cognito tokens stored securely.")
        } catch {
            operationState = .failure(Self.message(for: error))
        }
    }

    private func performLegacyKeychainGet(_ payload: HQJSONValue?) {
        guard let object = payload?.object,
              let service = object.string(for: "service"),
              let account = object.string(for: "account")
        else {
            operationState = .failure(
                "keychain_get requires service and account strings."
            )
            return
        }
        guard Self.isLegacyCognitoKey(
            service: service,
            account: account
        ) else {
            lastNativeResult = .null
            operationState = .success("No compatible keychain value.")
            return
        }

        do {
            guard let data = try keychainStore.data(
                for: Self.legacyCognitoCredentialKey
            ) else {
                lastNativeResult = .null
                operationState = .success("No Cognito tokens are stored.")
                return
            }
            guard let secret = String(data: data, encoding: .utf8),
                  Self.isValidLegacyCognitoTokenSecret(secret)
            else {
                operationState = .failure(
                    "Stored cognito token payload is invalid."
                )
                return
            }
            lastNativeResult = .string(secret)
            operationState = .success("Cognito tokens loaded securely.")
        } catch {
            operationState = .failure(Self.message(for: error))
        }
    }

    private func performLegacyKeychainDelete(_ payload: HQJSONValue?) {
        guard let object = payload?.object,
              let service = object.string(for: "service"),
              let account = object.string(for: "account")
        else {
            operationState = .failure(
                "keychain_delete requires service and account strings."
            )
            return
        }
        guard Self.isLegacyCognitoKey(
            service: service,
            account: account
        ) else {
            lastNativeResult = .null
            operationState = .success("No compatible keychain value.")
            return
        }

        do {
            try keychainStore.delete(Self.legacyCognitoCredentialKey)
            lastNativeResult = .null
            operationState = .success("Cognito tokens deleted.")
        } catch {
            operationState = .failure(Self.message(for: error))
        }
    }

    private static let legacyCognitoCredentialKey = HQCredentialKey(
        service: "cognito",
        account: "tokens"
    )

    private static func isLegacyCognitoKey(
        service: String,
        account: String
    ) -> Bool {
        service == legacyCognitoCredentialKey.service
            && account == legacyCognitoCredentialKey.account
    }

    private static func isValidLegacyCognitoTokenSecret(
        _ secret: String
    ) -> Bool {
        (try? JSONDecoder().decode(
            HQLegacyCognitoTokens.self,
            from: Data(secret.utf8)
        )) != nil
    }

    private func performSecondaryWindowAction(
        kind: HQSecondaryWindowKind,
        actionID: String
    ) async {
        guard let resolution = HQSecondaryWindowActionRegistry.resolution(
            for: kind,
            actionID: actionID
        ) else {
            operationState = .failure(
                "Unknown \(kind.rawValue) action “\(actionID)”."
            )
            return
        }

        switch resolution {
        case .reload:
            await reloadLiveContent()
        case .syncNow:
            await requestSync()
        case .runOnboarding:
            await runSetupStages(recoveryOnly: false)
        case .runRecovery:
            await runSetupStages(recoveryOnly: true)
        case let .oauth(provider):
            await performOAuthSignIn(provider: provider)
        case .cancelOAuth:
            await cancelOAuth()
        case let .openScene(scene):
            if scene == .messages,
               let message = nativeParityEvents.dmDetailMessage
                    ?? secondaryDomainValues["dm:detail-event"].flatMap(
                        HQRealtimeDirectMessage.init(value:)
                    )
            {
                applyNativeParityEffect(
                    nativeParityEvents.openConversation(
                        HQNativeConversationTarget(
                            personUID: message.fromPersonUID,
                            email: message.fromEmail,
                            displayName: message.fromDisplayName
                        )
                    )
                )
            } else {
                sceneRequest = HQAppSceneRequest(sceneID: scene.rawValue)
            }
        case .showMainWindow:
            sceneRequest = HQAppSceneRequest(sceneID: "main")
        case let .navigate(route):
            selectedRoute = route
            sceneRequest = HQAppSceneRequest(sceneID: "main")
            await loadLiveRoute(route)
        case let .nativeCommand(command):
            await performNative(command, payload: nil)
        case let .nativeCommandPayload(command, payload):
            await performNative(command, payload: payload)
        case let .openExternal(url):
            do {
                try openExternalURL(url)
                operationState = .success("Opened HQ in your browser.")
            } catch {
                operationState = .failure(Self.message(for: error))
            }
        case .startDetectedMeeting:
            guard let windowID = detectedMeetings.values
                .compactMap(\.windowID)
                .sorted()
                .first
            else {
                operationState = .failure(
                    "No supported meeting window is currently detected."
                )
                return
            }
            await requestMutation(
                method: HQEngineAppCommand.startRecording.rawValue,
                params: .object([
                    "windowId": .string(windowID),
                    "companyUid": .null,
                ]),
                success: "Meeting capture started."
            )
        case .revealWorkspace:
            guard let workspaceURL = content.snapshot.workspaces
                .compactMap(\.path)
                .first
            else {
                operationState = .failure(
                    "No local HQ workspace is available to reveal."
                )
                return
            }
            do {
                try HQNativeWorkspaceService().revealInFinder([workspaceURL])
                operationState = .success("Revealed the HQ workspace in Finder.")
            } catch {
                operationState = .failure(Self.message(for: error))
            }
        case .restoreDefaults:
            widgetMode = .expanded
            widgetIsFocusable = true
            trayState = .current
            setMeetingPromptBadgeCount(0)
            lastNativeResult = .object([
                "widgetMode": .string(widgetMode.rawValue),
                "widgetFocusable": .bool(widgetIsFocusable),
                "trayState": .string(trayState.rawValue),
                "meetingPromptBadgeVisible": .bool(
                    meetingPromptBadgeVisible
                ),
            ])
            operationState = .success("Native settings restored to defaults.")
        case .markNotificationsRead:
            secondaryDomainValues["fetch_notification_history"] = .object([
                "dms": .array([]),
                "shares": .array([]),
                "files": .array([]),
            ])
            lastNativeResult = .object(["markedRead": .bool(true)])
            operationState = .success("All notifications marked as read.")
        case let .nativeParityEvent(name, data):
            emitNativeParityEvent(name, data: data)
        case let .bannerNotificationAction(actionID):
            let action = actionID.split(separator: ".").last.map(String.init)
                ?? actionID
            if action == "dismiss" {
                await performNative(.dismissBanner, payload: nil)
            } else if let payload = activeBannerPayload {
                await performBannerNotificationAction(payload)
            } else if launchMode.usesFixtures,
                      actionID.contains(".direct-message.")
            {
                await performBannerNotificationAction(
                    Self.previewBannerPayload(for: .directMessage)
                )
            } else {
                operationState = .failure(
                    "The notification source is no longer available."
                )
            }
        }
    }

    private func runSetupStages(recoveryOnly: Bool) async {
        guard !setupIsRunning else { return }

        if launchMode.usesFixtures {
            setupStages = HQSetupStageID.allCases.map {
                HQSetupStage(
                    id: $0,
                    status: .complete,
                    detail: $0.builtInExplanation
                        ?? "Completed by the deterministic native test engine."
                )
            }
            operationState = .success(
                recoveryOnly
                    ? "Native recovery completed."
                    : "Native setup completed."
            )
            return
        }

        guard isAuthenticated else {
            sceneRequest = HQAppSceneRequest(
                sceneID: HQSecondaryWindowKind.signIn.rawValue
            )
            operationState = .failure(
                "Sign in before running protected setup stages."
            )
            return
        }
        guard let engine else {
            operationState = .failure(
                "The bundled HQ engine is unavailable for setup."
            )
            return
        }

        setupIsRunning = true
        defer { setupIsRunning = false }
        var failedStageIDs: [HQSetupStageID] = []
        let setupAuthGeneration = authenticatedDataGeneration

        for stageID in HQSetupStageID.allCases {
            guard hasProtectedAccess,
                  setupAuthGeneration == authenticatedDataGeneration
            else {
                operationState = .failure(
                    "Authentication changed while setup was running. Sign in again before continuing."
                )
                return
            }
            guard setupStage(stageID)?.status != .complete else {
                continue
            }

            if let explanation = stageID.builtInExplanation {
                updateSetupStage(
                    stageID,
                    status: .complete,
                    detail: explanation
                )
                continue
            }
            guard let method = stageID.engineMethod else {
                continue
            }
            guard capabilities.contains(method) else {
                failedStageIDs.append(stageID)
                updateSetupStage(
                    stageID,
                    status: .unavailable,
                    detail:
                        "The bundled engine did not advertise \(method)."
                )
                continue
            }

            updateSetupStage(
                stageID,
                status: .running,
                detail: "Running \(method)…"
            )
            operationState = .busy(stageID.title)
            await recordSetupStage(
                "record_step_start",
                stageID: stageID
            )
            guard hasProtectedAccess,
                  setupAuthGeneration == authenticatedDataGeneration
            else {
                operationState = .failure(
                    "Authentication changed while setup was running. Sign in again before continuing."
                )
                return
            }

            do {
                let result = try await engine.request(
                    method,
                    params: setupParams(for: stageID)
                )
                guard hasProtectedAccess,
                      setupAuthGeneration == authenticatedDataGeneration
                else {
                    operationState = .failure(
                        "Authentication changed while setup was running. Sign in again before continuing."
                    )
                    return
                }
                if stageID == .content,
                   let path = result.stringValue,
                   !path.isEmpty
                {
                    hqFolderPath = path
                }
                if stageID == .dependencies,
                   let hqFolderPath,
                   capabilities.contains(
                       "configure_claude_settings_path"
                   )
                {
                    _ = try await engine.request(
                        "configure_claude_settings_path",
                        params: .object([
                            "hqPath": .string(hqFolderPath),
                        ])
                    )
                    guard hasProtectedAccess,
                          setupAuthGeneration
                            == authenticatedDataGeneration
                    else {
                        operationState = .failure(
                            "Authentication changed while setup was running. Sign in again before continuing."
                        )
                        return
                    }
                }
                updateSetupStage(
                    stageID,
                    status: .complete,
                    detail: "Completed by \(method)."
                )
                await recordSetupStage(
                    "record_step_ok",
                    stageID: stageID
                )
            } catch {
                guard hasProtectedAccess,
                      setupAuthGeneration == authenticatedDataGeneration
                else {
                    operationState = .failure(
                        "Authentication changed while setup was running. Sign in again before continuing."
                    )
                    return
                }
                let message = Self.message(for: error)
                failedStageIDs.append(stageID)
                updateSetupStage(
                    stageID,
                    status: .failed,
                    detail: message
                )
                await recordSetupStage(
                    "record_step_failure",
                    stageID: stageID,
                    error: message
                )
            }
        }

        if failedStageIDs.isEmpty {
            guard hasProtectedAccess,
                  setupAuthGeneration == authenticatedDataGeneration
            else {
                operationState = .failure(
                    "Authentication changed while setup was running. Sign in again before continuing."
                )
                return
            }
            for method in [
                "record_install_complete",
                "mark_first_run_complete",
            ] where capabilities.contains(method) {
                guard hasProtectedAccess,
                      setupAuthGeneration == authenticatedDataGeneration
                else {
                    operationState = .failure(
                        "Authentication changed while setup was running. Sign in again before continuing."
                    )
                    return
                }
                _ = try? await engine.request(
                    method,
                    params: .object([:])
                )
            }
            guard hasProtectedAccess,
                  setupAuthGeneration == authenticatedDataGeneration
            else {
                operationState = .failure(
                    "Authentication changed while setup was running. Sign in again before continuing."
                )
                return
            }
            authenticatedDataGeneration &+= 1
            let dataGeneration = authenticatedDataGeneration
            do {
                guard try await reloadLiveContentAfterSetup(
                    from: engine,
                    fallbackHQPath: hqFolderPath,
                    authOverride: authState,
                    generation: dataGeneration
                ) else {
                    operationState = .failure(
                        "Setup completed, but a newer authentication state superseded its refresh."
                    )
                    return
                }
                listenForEvents(from: engine)
                operationState = .success(
                    recoveryOnly
                        ? "All native recovery stages completed."
                        : "All native setup stages completed."
                )
            } catch {
                operationState = .failure(
                    "Setup completed, but HQ could not refresh live state: \(Self.message(for: error))"
                )
            }
        } else {
            operationState = .failure(
                "\(failedStageIDs.count) setup stage"
                    + (failedStageIDs.count == 1 ? "" : "s")
                    + " need attention: "
                    + failedStageIDs.map(\.title).joined(separator: ", ")
                    + "."
            )
        }
    }

    private func reloadLiveContentAfterSetup(
        from engine: any HQAppEngine,
        fallbackHQPath: String?,
        authOverride: HQJSONValue,
        generation: UInt64
    ) async throws -> Bool {
        try await rehydrateLiveState(
            from: engine,
            fallbackHQPath: fallbackHQPath,
            authOverride: authOverride,
            generation: generation
        )
    }

    private func setupStage(
        _ id: HQSetupStageID
    ) -> HQSetupStage? {
        setupStages.first { $0.id == id }
    }

    private func updateSetupStage(
        _ id: HQSetupStageID,
        status: HQSetupStageStatus,
        detail: String
    ) {
        guard let index = setupStages.firstIndex(where: {
            $0.id == id
        }) else {
            return
        }
        setupStages[index].status = status
        setupStages[index].detail = detail
    }

    private func setupParams(
        for stageID: HQSetupStageID
    ) -> HQJSONValue {
        switch stageID {
        case .content:
            .object([
                "handle": .string(
                    "native-onboarding-\(UUID().uuidString.lowercased())"
                ),
            ])
        case .gitInitialize:
            hqFolderPath.map {
                .object(["path": .string($0)])
            } ?? .object([:])
        default:
            .object([:])
        }
    }

    private func recordSetupStage(
        _ method: String,
        stageID: HQSetupStageID,
        error: String? = nil
    ) async {
        guard capabilities.contains(method),
              let engine
        else {
            return
        }
        var params: [String: HQJSONValue] = [
            "stepId": .string(stageID.rawValue),
        ]
        if let error {
            params["error"] = .string(error)
        }
        _ = try? await engine.request(
            method,
            params: .object(params)
        )
    }

    private func sceneDidBecomeReady(_ sceneID: String) async {
        readySceneIDs.insert(sceneID)
        if sceneID == HQSecondaryWindowKind.meetingPermissions.rawValue {
            refreshMeetingPermissionSnapshot()
            operationState = .success(
                "Meeting permission state refreshed."
            )
            return
        }
        guard sceneID == HQSecondaryWindowKind.messages.rawValue,
              launchMode == .live,
              hasProtectedAccess,
              capabilities.contains(
                  HQEngineAppCommand.markMessagesRead.rawValue
              ),
              let engine
        else {
            return
        }

        operationState = .busy("Marking messages as read…")
        let dataGeneration = authenticatedDataGeneration
        do {
            _ = try await engine.request(
                HQEngineAppCommand.markMessagesRead.rawValue,
                params: .object([:])
            )
            guard hasProtectedAccess,
                  dataGeneration == authenticatedDataGeneration
            else {
                return
            }
            unreadDMMessages = 0
            secondaryDomainValues["get_unread_summary"] = .object([
                "unreadDms": .number(0),
                "pendingRequests": .number(
                    Double(pendingDMRequests)
                ),
            ])
            content = HQShellFixture(
                snapshot: content.snapshot,
                messages: content.messages.map {
                    HQMessageFixture(
                        id: $0.id,
                        person: $0.person,
                        initials: $0.initials,
                        preview: $0.preview,
                        detail: $0.detail,
                        time: $0.time,
                        unread: false,
                        kind: $0.kind
                    )
                },
                meetings: content.meetings,
                packs: content.packs,
                libraryItems: content.libraryItems,
                people: content.people,
                activity: content.activity,
                files: content.files,
                deployments: content.deployments,
                secrets: content.secrets
            )
            lastNativeResult = .object([
                "unreadDms": .number(0),
                "pendingRequests": .number(
                    Double(pendingDMRequests)
                ),
            ])
            operationState = .success("Messages marked as read.")
        } catch {
            operationState = .failure(Self.message(for: error))
        }
    }

    private func applyUnreadSummary(_ value: HQJSONValue) {
        guard let object = value.object,
              let unread = Self.nonnegativeInteger(
                  object["unreadDms"]
              ),
              let pending = Self.nonnegativeInteger(
                  object["pendingRequests"]
              )
        else {
            secondaryDomainFailures["get_unread_summary"] =
                "HQ returned an invalid unread summary."
            return
        }
        unreadDMMessages = unread
        pendingDMRequests = pending
    }

    private func applyInstallManifest(_ value: HQJSONValue) {
        guard let object = value.object else {
            secondaryDomainFailures["read_install_manifest"] =
                "HQ returned an invalid install manifest."
            return
        }
        if let installPath = object["installPath"]?.stringValue,
           !installPath.isEmpty
        {
            hqFolderPath = installPath
        }
        let stepObjects = object["steps"]?.object ?? [:]
        setupStages = HQSetupStageID.allCases.map { stageID in
            guard let step = stepObjects[stageID.rawValue]?.object else {
                return HQSetupStage(
                    id: stageID,
                    status: .pending,
                    detail: stageID.builtInExplanation
                        ?? "Waiting to run through the bundled HQ engine."
                )
            }
            let rawStatus = step["status"]?.stringValue ?? "pending"
            let detail = step["error"]?.stringValue
                ?? (rawStatus == "ok"
                    ? "Completed in the previous setup run."
                    : "Ready to resume from the install manifest.")
            let status: HQSetupStageStatus = switch rawStatus {
            case "ok": .complete
            case "failed": .failed
            case "skipped": .unavailable
            case "running": .pending
            default: .pending
            }
            return HQSetupStage(
                id: stageID,
                status: status,
                detail: detail
            )
        }
    }

    private static func nonnegativeInteger(
        _ value: HQJSONValue?
    ) -> Int? {
        guard let number = value?.numberValue,
              number.isFinite,
              number >= 0,
              number.rounded() == number,
              number <= Double(Int.max)
        else {
            return nil
        }
        return Int(number)
    }

    private func reduceDMRequestUpdate(_ record: HQDMRequestUpdateRecord) {
        if let requests = secondaryDomainValues["list_dm_requests"] {
            secondaryDomainValues["list_dm_requests"] =
                Self.removingDMRequest(
                    pairKey: record.pairKey,
                    from: requests
                )
        }

        let inboxRoute = HQRoute.global(.inbox)
        if case let .content(content)? = liveRouteStates[inboxRoute] {
            let remainingRows = content.rows.filter {
                $0.metadata["pairKey"]?.stringValue != record.pairKey
            }
            liveRouteStates[inboxRoute] = remainingRows.isEmpty
                ? .empty(
                    HQWindowEmptyState(
                        title: "Inbox is clear",
                        message: "HQ returned no messages, requests, shares, or file updates."
                    )
                )
                : .content(
                    HQLiveRouteContent(
                        title: content.title,
                        subtitle: content.subtitle,
                        symbolName: content.symbolName,
                        rows: remainingRows,
                        notice: content.notice
                    )
                )
        }

        operationState = .success(
            "Direct-message request is \(record.state.rawValue)."
        )
    }

    private static func removingDMRequest(
        pairKey: String,
        from value: HQJSONValue
    ) -> HQJSONValue {
        func prune(_ candidate: HQJSONValue) -> HQJSONValue? {
            switch candidate {
            case let .array(values):
                return .array(values.compactMap(prune))
            case let .object(object):
                if object["pairKey"]?.stringValue == pairKey {
                    return nil
                }
                return .object(
                    object.mapValues { prune($0) ?? .null }
                )
            case .null, .bool, .number, .string:
                return candidate
            }
        }
        return prune(value) ?? .object([:])
    }

    private func receiveDMRequestUpdate(_ event: HQEngineEvent) -> Bool {
        guard event.name == HQDMRequestUpdateRecord.eventName else {
            return false
        }
        guard let record = HQDMRequestUpdateRecord(event: event) else {
            operationState = .failure(
                "HQ emitted an invalid dm:request-update payload."
            )
            return true
        }
        dmRequestUpdateHistory.append(record)
        reduceDMRequestUpdate(record)
        return true
    }

    private func receiveCloudRealtimeEvent(
        _ event: HQEngineEvent
    ) -> Bool {
        guard HQCloudRealtimeEventName(rawValue: event.name) != nil else {
            return false
        }
        guard let record = HQCloudRealtimeEventRecord(event: event) else {
            operationState = .failure(
                "HQ emitted an invalid \(event.name) payload."
            )
            return true
        }
        cloudRealtimeEventHistory.append(record)
        reduceCloudRealtimeEvent(record)
        return true
    }

    private func reduceCloudRealtimeEvent(
        _ record: HQCloudRealtimeEventRecord
    ) {
        switch record.payload {
        case let .directMessages(messages):
            mergeDomainRows(
                messages.map(\.json),
                method: "fetch_notification_history",
                collectionKey: "dms",
                uniqueKey: "eventId"
            )
            let ids = Set(messages.map(\.eventID))
            let fixtures = messages.map { message in
                HQMessageFixture(
                    id: message.eventID,
                    person: message.fromDisplayName.isEmpty
                        ? message.fromEmail
                        : message.fromDisplayName,
                    initials: Self.initials(
                        for: message.fromDisplayName.isEmpty
                            ? message.fromEmail
                            : message.fromDisplayName
                    ),
                    preview: message.body,
                    detail: message.details ?? message.body,
                    time: message.createdAt,
                    unread: true,
                    kind: "Direct message"
                )
            }
            content = HQShellFixture(
                snapshot: content.snapshot,
                messages: fixtures + content.messages.filter {
                    !ids.contains($0.id)
                },
                meetings: content.meetings,
                packs: content.packs,
                libraryItems: content.libraryItems,
                people: content.people,
                activity: content.activity,
                files: content.files,
                deployments: content.deployments,
                secrets: content.secrets
            )
            if let message = messages.last {
                presentBanner(.directMessage(message))
            }
            trayState = .attention
            for message in messages {
                presentNativeNotification(
                    HQNotificationPayload(
                        identifier:
                            "dm-\(record.sequence)-\(message.eventID)",
                        title: message.fromDisplayName.isEmpty
                            ? "New HQ message"
                            : "New message from \(message.fromDisplayName)",
                        body: message.body,
                        categoryIdentifier: "hq.direct-message",
                        userInfo: [
                            "eventId": message.eventID,
                            "fromPersonUid": message.fromPersonUID,
                            HQNativeNotificationContract.encodedPayloadKey:
                                HQNativeNotificationContract.encodedPayload(
                                    message.json
                                ) ?? "",
                        ]
                    )
                )
            }
            operationState = .success(
                "Received \(messages.count) new direct message\(messages.count == 1 ? "" : "s")."
            )

        case let .unreadSummary(summary):
            unreadDMMessages = summary.unreadDMs
            if summary.pendingRequests > 0 || pendingDMRequests == 0 {
                pendingDMRequests = summary.pendingRequests
            }
            secondaryDomainValues["get_unread_summary"] = .object([
                "unreadDms": .number(Double(unreadDMMessages)),
                "pendingRequests": .number(Double(pendingDMRequests)),
            ])
            trayState = messageBadgeCount > 0 ? .attention : .current
            operationState = .success("Message counts updated.")

        case let .requestNew(request):
            let existing = domainRows(
                method: "list_dm_requests",
                collectionKey: "requests"
            )
            let isNew = !existing.contains {
                $0.object?["pairKey"]?.stringValue == request.pairKey
            }
            mergeDomainRows(
                [request.json],
                method: "list_dm_requests",
                collectionKey: "requests",
                uniqueKey: "pairKey"
            )
            if isNew {
                pendingDMRequests += 1
            }
            trayState = .attention
            let displayName = request.fromDisplayName.isEmpty
                ? request.fromEmail
                : request.fromDisplayName
            presentNativeNotification(
                HQNotificationPayload(
                    identifier:
                        "dm-request-\(record.sequence)-\(request.pairKey)",
                    title: "\(displayName) wants to connect",
                    body: request.message
                        ?? request.sharedCompany.map {
                            "You both work with \($0)."
                        }
                        ?? "Open Messages to review the request.",
                    categoryIdentifier: "hq.connection-request",
                    userInfo: ["pairKey": request.pairKey]
                )
            )
            operationState = .success(
                "New direct-message request from \(displayName)."
            )

        case let .channelNewMessage(update):
            channelUnreadByID[update.channelID] = update.unread
            updateChannel(
                id: update.channelID,
                transform: { object in
                    var updated = object
                    updated["unread"] = .number(Double(update.unread))
                    return updated
                }
            )
            trayState = .attention
            let channelName = channelTitle(for: update.channelID)
            presentNativeNotification(
                HQNotificationPayload(
                    identifier:
                        "channel-\(record.sequence)-\(update.channelID)",
                    title: "New message in \(channelName)",
                    body: "\(update.unread) unread message\(update.unread == 1 ? "" : "s").",
                    categoryIdentifier: "hq.channel-message",
                    userInfo: ["channelId": update.channelID]
                )
            )
            operationState = .success(
                "\(channelName) has new activity."
            )

        case let .channelUpdated(channel):
            mergeDomainRows(
                [channel.json],
                method: "list_channels",
                collectionKey: "channels",
                uniqueKey: "channelId"
            )
            if let unread = channel.unread {
                channelUnreadByID[channel.channelID] = unread
            }
            operationState = .success(
                "Updated \(channel.name.isEmpty ? "channel" : channel.name)."
            )

        case let .threadNewReply(update):
            var replies = threadReplies[update.rootEventID] ?? []
            if !replies.contains(where: {
                $0.eventID == update.reply.eventID
            }) {
                replies.append(update.reply)
            }
            threadReplies[update.rootEventID] = replies
            threadReplyCounts[update.rootEventID] = update.replyCount
            operationState = .success("Thread reply received.")

        case let .messageReaction(update):
            var scope = messageReactionState[update.messageScope] ?? [:]
            scope[update.messageID] = update.reactions
            messageReactionState[update.messageScope] = scope
            operationState = .success("Message reactions updated.")

        case let .shareEvents(shares):
            mergeDomainRows(
                shares.map(\.json),
                method: "fetch_notification_history",
                collectionKey: "shares",
                uniqueKey: "eventId"
            )
            trayState = .attention
            for share in shares {
                let issuer = share.issuerDisplayName.isEmpty
                    ? share.issuerEmail
                    : share.issuerDisplayName
                presentNativeNotification(
                    HQNotificationPayload(
                        identifier:
                            "share-\(record.sequence)-\(share.eventID)",
                        title: "\(issuer) shared with you",
                        body: share.note
                            ?? share.paths.joined(separator: ", "),
                        categoryIdentifier: "hq.share",
                        userInfo: [
                            "eventId": share.eventID,
                            HQNativeNotificationContract.encodedPayloadKey:
                                HQNativeNotificationContract.encodedPayload(
                                    share.json
                                ) ?? "",
                        ]
                    )
                )
            }
            operationState = .success(
                "Received \(shares.count) secure share\(shares.count == 1 ? "" : "s")."
            )

        case .reauthenticationRequired:
            clearAuthenticatedState(requiresReauthentication: true)
            sceneRequest = HQAppSceneRequest(
                sceneID: HQSecondaryWindowKind.signIn.rawValue
            )
            presentNativeNotification(
                HQNotificationPayload(
                    identifier: "auth-reauth-\(record.sequence)",
                    title: "Sign in to HQ again",
                    body: "Your secure HQ session expired.",
                    categoryIdentifier: "hq.authentication",
                    playsSound: false
                ),
                requiresAuthentication: false
            )
            operationState = .failure(
                "Your HQ session expired. Sign in again to continue."
            )
        }
    }

    private func presentNativeNotification(
        _ payload: HQNotificationPayload,
        requiresAuthentication: Bool = true
    ) {
        guard !requiresAuthentication || hasProtectedAccess
        else {
            return
        }
        nativeNotificationHistory.append(payload)
        let taskID = UUID()
        let dataGeneration = authenticatedDataGeneration
        let task = Task { @MainActor [weak self] in
            guard let self else { return }
            defer { notificationDeliveryTasks[taskID] = nil }
            guard !requiresAuthentication
                    || (
                        hasProtectedAccess
                            && dataGeneration == authenticatedDataGeneration
                    )
            else {
                return
            }
            try? await notificationService.deliver(payload)
        }
        notificationDeliveryTasks[taskID] = task
    }

    func installNativeNotificationRouting() {
        _ = notificationService
    }

    func receiveNativeNotificationResponse(
        _ response: HQNativeNotificationResponse
    ) {
        guard hasProtectedAccess else {
            operationState = .failure(
                "Sign in again before acting on a protected HQ notification."
            )
            return
        }
        switch response {
        case let .directMessage(operation, eventID, payload):
            let value = payload ?? domainRows(
                method: "fetch_notification_history",
                collectionKey: "dms"
            ).first(where: {
                $0.object?["eventId"]?.stringValue == eventID
            })
            guard let value,
                  let message = HQRealtimeDirectMessage(value: value)
            else {
                operationState = .failure(
                    "The selected direct-message notification is no longer available."
                )
                return
            }
            emitNativeParityEvent(
                .notificationDMAction,
                data: .object([
                    "action": .string(operation.rawValue),
                    "event": message.json,
                ])
            )

        case let .share(operation, eventID, payload):
            let value = payload ?? domainRows(
                method: "fetch_notification_history",
                collectionKey: "shares"
            ).first(where: {
                $0.object?["eventId"]?.stringValue == eventID
            })
            guard let value,
                  let share = nativeParityShare(from: value)
            else {
                operationState = .failure(
                    "The selected secure-share notification is no longer available."
                )
                return
            }
            emitNativeParityEvent(
                .notificationShareAction,
                data: .object([
                    "action": .string(operation.rawValue),
                    "event": nativeParityJSON(for: share),
                ])
            )

        case let .meeting(operation, windowID, platform, meetingID):
            emitNativeParityEvent(
                .notificationMeetingAction,
                data: .object([
                    "action": .string(operation.rawValue),
                    "windowId": windowID.map(HQJSONValue.string) ?? .null,
                    "platform": platform.map(HQJSONValue.string) ?? .null,
                    "meetingId": meetingID.map(HQJSONValue.string) ?? .null,
                ])
            )
        }
    }

    private func domainRows(
        method: String,
        collectionKey: String
    ) -> [HQJSONValue] {
        let value = secondaryDomainValues[method]
        return value?.object?[collectionKey]?.arrayValue
            ?? value?.arrayValue
            ?? []
    }

    private func mergeDomainRows(
        _ incoming: [HQJSONValue],
        method: String,
        collectionKey: String,
        uniqueKey: String
    ) {
        var object = secondaryDomainValues[method]?.object ?? [:]
        let existing = domainRows(
            method: method,
            collectionKey: collectionKey
        )
        let incomingIDs = Set(
            incoming.compactMap {
                $0.object?[uniqueKey]?.stringValue
            }
        )
        object[collectionKey] = .array(
            incoming + existing.filter {
                guard let id = $0.object?[uniqueKey]?.stringValue else {
                    return true
                }
                return !incomingIDs.contains(id)
            }
        )
        secondaryDomainValues[method] = .object(object)
        secondaryDomainFailures[method] = nil
    }

    private func updateChannel(
        id: String,
        transform: ([String: HQJSONValue]) -> [String: HQJSONValue]
    ) {
        var object = secondaryDomainValues["list_channels"]?.object ?? [:]
        var rows = domainRows(
            method: "list_channels",
            collectionKey: "channels"
        )
        rows = rows.map { value in
            guard let channel = value.object,
                  channel["channelId"]?.stringValue == id
            else {
                return value
            }
            return .object(transform(channel))
        }
        object["channels"] = .array(rows)
        secondaryDomainValues["list_channels"] = .object(object)
    }

    private func channelTitle(for id: String) -> String {
        let title = domainRows(
            method: "list_channels",
            collectionKey: "channels"
        ).compactMap(\.object).first {
            $0["channelId"]?.stringValue == id
        }?.string(for: "name")
        guard let title, !title.isEmpty else {
            return "a channel"
        }
        return title.hasPrefix("#") ? title : "#\(title)"
    }

    private static func initials(for value: String) -> String {
        let parts = value.split(whereSeparator: \.isWhitespace)
        let initials = parts.prefix(2).compactMap(\.first)
        if initials.isEmpty {
            return value.prefix(2).uppercased()
        }
        return String(initials).uppercased()
    }

    private func receiveActivityEvent(_ event: HQEngineEvent) -> Bool {
        guard HQActivityEventName(rawValue: event.name) != nil else {
            return false
        }
        guard let record = HQActivityEventRecord(event: event) else {
            operationState = .failure(
                "HQ emitted an invalid \(event.name) payload."
            )
            return true
        }
        activityEventHistory.append(record)
        reduceActivityEvent(record)
        return true
    }

    private func reduceActivityEvent(_ record: HQActivityEventRecord) {
        switch record.payload {
        case let .append(entry):
            syncActivityEntries.append(entry)
            if syncActivityEntries.count > 2_000 {
                syncActivityEntries.removeFirst(
                    syncActivityEntries.count - 2_000
                )
            }
        case let .list(entries):
            syncActivityEntries = Array(entries.suffix(2_000))
        }

        let activity = syncActivityEntries.map(Self.activityFixture)
        content = HQShellFixture(
            snapshot: content.snapshot,
            messages: content.messages,
            meetings: content.meetings,
            packs: content.packs,
            libraryItems: content.libraryItems,
            people: content.people,
            activity: activity,
            files: content.files,
            deployments: content.deployments,
            secrets: content.secrets
        )
        secondaryDomainValues["get_company_activity"] = .object([
            "activity": .array(syncActivityEntries.map(\.json)),
        ])
        operationState = .success(
            record.name == .append
                ? "Workspace activity updated."
                : "Workspace activity reconciled."
        )
    }

    private static func activityFixture(
        for entry: HQSyncActivityEntry
    ) -> HQActivityFixture {
        let action: String
        let symbol: String
        switch entry.direction {
        case .up:
            action = "uploaded"
            symbol = "arrow.up.circle"
        case .down:
            action = entry.isNew == true ? "added" : "updated"
            symbol = entry.isNew == true
                ? "doc.badge.plus"
                : "arrow.down.circle"
        case .deleted:
            action = "deleted"
            symbol = "trash"
        }
        return HQActivityFixture(
            id: "\(entry.company):\(entry.path):\(entry.at)",
            actor: entry.author ?? entry.company.capitalized,
            action: action,
            target: entry.path,
            time: Date(
                timeIntervalSince1970: Double(entry.at) / 1_000
            ).formatted(date: .abbreviated, time: .shortened),
            symbol: symbol
        )
    }

    private func performOAuthSignIn(provider: String) async {
        guard !oauthFlowState.isActive,
              oauthInFlightGeneration == nil
        else {
            operationState = .failure(
                "An HQ sign-in flow is already in progress."
            )
            return
        }
        let requiredMethods = [
            HQEngineAppCommand.startOAuthLogin.rawValue,
            HQEngineAppCommand.oauthListenForCode.rawValue,
            HQEngineAppCommand.oauthExchangeCode.rawValue,
        ]
        guard requiredMethods.allSatisfy(capabilities.contains) else {
            operationState = .failure(
                "The HQ engine did not advertise the complete OAuth sign-in flow."
            )
            return
        }
        guard let engine else {
            operationState = .failure("The bundled HQ engine is unavailable.")
            return
        }

        oauthFlowGeneration &+= 1
        let flowGeneration = oauthFlowGeneration
        oauthInFlightGeneration = flowGeneration
        oauthFlowState = .starting(provider: provider)
        defer {
            if oauthInFlightGeneration == flowGeneration {
                oauthInFlightGeneration = nil
                oauthFlowState = .idle
            }
        }
        operationState = .busy("Opening \(provider) sign-in…")
        var pendingState: String?
        var exchangeWasRequested = false
        do {
            let flow = try await engine.request(
                HQEngineAppCommand.startOAuthLogin.rawValue,
                params: .object(["provider": .string(provider)])
            )
            pendingState = flow.object?["state"]?.stringValue
            guard flowGeneration == oauthFlowGeneration else {
                await cancelOAuthListener(
                    state: pendingState,
                    using: engine
                )
                return
            }
            guard let authorizeURLString = flow.object?["authorizeUrl"]?.stringValue,
                  let authorizeURL = URL(string: authorizeURLString),
                  authorizeURL.scheme?.lowercased() == "https",
                  let state = pendingState,
                  !state.isEmpty
            else {
                throw HQEngineErrorPayload(
                    code: "oauth_response_invalid",
                    message: "The HQ engine returned an invalid OAuth authorization response.",
                    retryable: false
                )
            }
            oauthFlowState = .waiting(
                provider: provider,
                state: state
            )
            try openExternalURL(authorizeURL)

            operationState = .busy("Waiting for \(provider) sign-in…")
            let callback = try await engine.request(
                HQEngineAppCommand.oauthListenForCode.rawValue,
                params: .object(["state": .string(state)])
            )
            guard flowGeneration == oauthFlowGeneration else {
                await cancelOAuthListener(state: state, using: engine)
                return
            }
            guard let code = callback.object?["code"]?.stringValue,
                  !code.isEmpty
            else {
                throw HQEngineErrorPayload(
                    code: "oauth_callback_invalid",
                    message: "The OAuth callback did not include an authorization code.",
                    retryable: false
                )
            }

            oauthFlowState = .exchanging(
                provider: provider,
                state: state
            )
            operationState = .busy("Completing HQ sign-in…")
            exchangeWasRequested = true
            let loadedAuth = try await engine.request(
                HQEngineAppCommand.oauthExchangeCode.rawValue,
                params: .object(["code": .string(code)])
            )
            guard flowGeneration == oauthFlowGeneration else {
                await discardStaleOAuthAuthentication(using: engine)
                return
            }
            guard loadedAuth.object?["authenticated"]?.boolValue == true else {
                throw HQEngineErrorPayload(
                    code: "oauth_authentication_incomplete",
                    message: "HQ authentication was not completed.",
                    retryable: false
                )
            }

            authenticatedDataGeneration &+= 1
            let dataGeneration = authenticatedDataGeneration
            guard try await rehydrateLiveState(
                from: engine,
                authOverride: loadedAuth,
                generation: dataGeneration,
                oauthGeneration: flowGeneration
            ) else {
                await discardStaleOAuthAuthentication(using: engine)
                return
            }
            guard flowGeneration == oauthFlowGeneration else {
                await discardStaleOAuthAuthentication(using: engine)
                return
            }
            pendingState = nil
            listenForEvents(from: engine)
            sceneRequest = HQAppSceneRequest(sceneID: "main")
            closeSecondaryWindow(.signIn)
            NSApplication.shared.activate(ignoringOtherApps: true)
            operationState = .success("Signed in to HQ with \(provider).")
        } catch {
            let failureMessage = Self.message(for: error)
            if exchangeWasRequested {
                await discardStaleOAuthAuthentication(using: engine)
                if case .failed = phase {
                    return
                }
                operationState = .failure(failureMessage)
                return
            }
            guard flowGeneration == oauthFlowGeneration else {
                await cancelOAuthListener(
                    state: pendingState,
                    using: engine
                )
                return
            }
            await cancelOAuthListener(state: pendingState, using: engine)
            operationState = .failure(failureMessage)
        }
    }

    private func cancelOAuth() async {
        guard oauthFlowState.isActive else {
            sceneRequest = HQAppSceneRequest(sceneID: "main")
            operationState = .success("Sign-in cancellation complete.")
            return
        }
        let provider: String? = switch oauthFlowState {
        case let .starting(provider),
             let .waiting(provider, _),
             let .exchanging(provider, _):
            provider
        case let .cancelling(provider, _):
            provider
        case .idle:
            nil
        }
        let pendingState = oauthFlowState.pendingState
        oauthFlowGeneration &+= 1
        let cancellationGeneration = oauthFlowGeneration
        oauthFlowState = .cancelling(
            provider: provider,
            state: pendingState
        )
        if let engine {
            await cancelOAuthListener(
                state: pendingState,
                using: engine
            )
        }
        guard cancellationGeneration == oauthFlowGeneration else {
            return
        }
        if oauthInFlightGeneration == nil {
            oauthFlowState = .idle
        }
        sceneRequest = HQAppSceneRequest(sceneID: "main")
        operationState = .success("HQ sign-in was cancelled.")
    }

    private func invalidateOAuthFlow() {
        guard oauthFlowState.isActive || oauthInFlightGeneration != nil else {
            return
        }
        let provider: String? = switch oauthFlowState {
        case let .starting(provider),
             let .waiting(provider, _),
             let .exchanging(provider, _):
            provider
        case let .cancelling(provider, _):
            provider
        case .idle:
            nil
        }
        let pendingState = oauthFlowState.pendingState
        oauthFlowGeneration &+= 1
        if oauthInFlightGeneration == nil {
            oauthFlowState = .idle
        } else {
            oauthFlowState = .cancelling(
                provider: provider,
                state: pendingState
            )
        }
        guard let pendingState,
              !pendingState.isEmpty,
              let engine
        else {
            return
        }
        oauthCancellationTask = Task { [weak self] in
            await self?.cancelOAuthListener(
                state: pendingState,
                using: engine
            )
        }
    }

    private func cancelOAuthListener(
        state: String?,
        using engine: any HQAppEngine
    ) async {
        guard let state,
              !state.isEmpty,
              capabilities.contains(
                HQEngineAppCommand.oauthCancelListen.rawValue
              )
        else {
            return
        }
        _ = try? await engine.request(
            HQEngineAppCommand.oauthCancelListen.rawValue,
            params: .object(["state": .string(state)])
        )
    }

    private func discardStaleOAuthAuthentication(
        using engine: any HQAppEngine
    ) async {
        var cleanupFailure: String?
        if capabilities.contains(HQEngineAppCommand.signOut.rawValue) {
            do {
                _ = try await engine.request(
                    HQEngineAppCommand.signOut.rawValue,
                    params: .object([:])
                )
            } catch {
                cleanupFailure = Self.message(for: error)
            }
        } else {
            cleanupFailure =
                "The HQ engine did not advertise sign_out."
        }

        if cleanupFailure != nil {
            await engine.stop()
        }
        clearAuthenticatedState(requiresReauthentication: false)
        if let cleanupFailure {
            let message =
                "A cancelled HQ sign-in could not discard its credentials, so the engine was stopped: \(cleanupFailure)"
            phase = .failed(message)
            operationState = .failure(message)
        }
    }

    private var isIndigoWorkspace: Bool {
        content.snapshot.workspaces.contains { $0.slug == "indigo" }
    }

    private static func releaseChannel(
        from value: HQJSONValue
    ) -> HQReleaseChannel? {
        let rawValue = value.object?["releaseChannel"]?.stringValue
            ?? value.object?["preferences"]?.object?["releaseChannel"]?
                .stringValue
        return rawValue.flatMap(HQReleaseChannel.init(rawValue:))
    }

    private var preferredReleaseChannel: HQReleaseChannel? {
        Self.releaseChannel(from: config)
    }

    private func startUpdaterIfNeeded() throws {
        guard !updaterDidStart else { return }
        try updaterService.start(
            preferredChannel:
                bootstrapPreferredReleaseChannel
                    ?? preferredReleaseChannel,
            isIndigoUser: isIndigoWorkspace
        )
        updaterDidStart = true
    }

    private func startUpdaterAfterLiveBootstrap() {
        do {
            try startUpdaterIfNeeded()
            updaterStartupFailure = nil
        } catch {
            updaterStartupFailure = Self.message(for: error)
        }
    }

    private func receiveUpdaterState(_ state: HQUpdaterState) {
        updaterState = state
        lastNativeResult = Self.json(for: state)
        switch state {
        case let .idle(channel):
            operationState = .success(
                "Updater ready on the \(channel.rawValue) channel."
            )
        case .checking:
            operationState = .busy("Checking for signed HQ updates…")
        case .upToDate:
            operationState = .success("HQ is up to date.")
        case let .available(_, update):
            operationState = .success(
                "HQ \(update.displayVersion) is available."
            )
        case let .downloading(_, update):
            operationState = .busy(
                "Downloading HQ \(update.displayVersion)…"
            )
        case let .readyToInstall(_, update):
            operationState = .success(
                "HQ \(update.displayVersion) is ready to install."
            )
        case let .installing(_, update):
            operationState = .busy(
                "Installing HQ \(update.displayVersion)…"
            )
        case let .failed(_, message):
            operationState = .failure(message)
        }
    }

    private func launchApplication(bundleIdentifiers: [String]) async {
        guard let applicationURL = bundleIdentifiers.lazy.compactMap({
            NSWorkspace.shared.urlForApplication(withBundleIdentifier: $0)
        }).first else {
            operationState = .failure(
                "The requested application is not installed on this Mac."
            )
            return
        }

        operationState = .busy("Opening \(applicationURL.deletingPathExtension().lastPathComponent)…")
        do {
            let configuration = NSWorkspace.OpenConfiguration()
            configuration.activates = true
            _ = try await NSWorkspace.shared.openApplication(
                at: applicationURL,
                configuration: configuration
            )
            operationState = .success(
                "Opened \(applicationURL.deletingPathExtension().lastPathComponent)."
            )
        } catch {
            operationState = .failure(Self.message(for: error))
        }
    }

    private func listenForEvents(from engine: any HQAppEngine) {
        guard eventTask == nil, lifecycleTask == nil else {
            return
        }
        engineGeneration &+= 1
        let generation = engineGeneration
        eventTask = Task { [weak self] in
            for await event in engine.events {
                guard let self else { return }
                guard self.engineGeneration == generation,
                      !self.didShutdown
                else {
                    return
                }
                self.receiveEngineEvent(event)
            }
        }

        lifecycleTask = Task { [weak self] in
            for await lifecycle in engine.lifecycleEvents {
                guard let self else { return }
                guard self.engineGeneration == generation else { return }
                self.receiveEngineLifecycle(lifecycle)
            }
        }
    }

    private func receiveEngineLifecycle(
        _ lifecycle: HQAppEngineLifecycleEvent
    ) {
        guard !didShutdown else { return }
        switch lifecycle {
        case let .failed(detail):
            eventTask?.cancel()
            eventTask = nil
            let message = "The HQ engine stopped unexpectedly: \(detail)"
            phase = .failed(message)
            operationState = .failure(message)
        case .stopped:
            break
        }
    }

    func receiveEngineEvent(_ event: HQEngineEvent) {
        consumeEngineEvent(event, fromTrustedNativeSource: false)
    }

    private func consumeEngineEvent(
        _ event: HQEngineEvent,
        fromTrustedNativeSource: Bool
    ) {
        let unauthenticatedNativeEvent =
            fromTrustedNativeSource
                && HQNativeParityEventName(rawValue: event.name).map {
                    Self.unauthenticatedNativeParityEvents.contains($0)
                } == true
        guard hasProtectedAccess || unauthenticatedNativeEvent else {
            return
        }
        if HQRecallEventName(rawValue: event.name) != nil {
            guard let record = HQRecallEventRecord(event: event) else {
                operationState = .failure(
                    "Recall emitted an invalid \(event.name) payload."
                )
                return
            }
            recallEventHistory.append(record)
            reduceRecallEvent(record)
            return
        }
        if receiveDMRequestUpdate(event) {
            return
        }
        if receiveCloudRealtimeEvent(event) {
            return
        }
        if receiveActivityEvent(event) {
            return
        }
        if nativeParityEvents.accepts(event.name) {
            switch nativeParityEvents.consume(event) {
            case let .success(effect):
                applyNativeParityEffect(effect)
                presentBannerIfNeeded(for: event)
            case let .failure(error):
                operationState = .failure(
                    "HQ emitted an invalid \(error.eventName) payload: \(error.reason)"
                )
            }
            return
        }
        operationState = .failure(
            "HQ emitted an event with no native consumer: \(event.name)."
        )
    }

    private func presentBannerIfNeeded(for event: HQEngineEvent) {
        switch HQNativeParityEventName(rawValue: event.name) {
        case .updateAvailable:
            guard let update = nativeParityEvents.appUpdate else { return }
            presentBanner(
                .updateAvailable(
                    version: update.version,
                    body: update.body
                )
            )
            trayState = .attention
        case .syncComplete:
            guard let object = event.data?.object,
                  object["aborted"]?.boolValue == false,
                  object["conflicts"]?.numberValue == 0,
                  let company = object["company"]?.stringValue
            else {
                return
            }
            presentBanner(
                .syncComplete(
                    company: company,
                    message: "Sync completed for \(company)."
                )
            )
        default:
            break
        }
    }

    /// Native SwiftUI producers use the retained typed event boundary too, so
    /// their payloads receive the same strict decoding and observable effects
    /// as matching sidecar events.
    func emitNativeParityEvent(
        _ name: HQNativeParityEventName,
        data: HQJSONValue? = nil
    ) {
        nativeUIEventSequence &+= 1
        consumeEngineEvent(
            HQEngineEvent(
                requestID: nil,
                name: name.rawValue,
                sequence: nativeUIEventSequence,
                data: data
            ),
            fromTrustedNativeSource: true
        )
    }

    private static let unauthenticatedNativeParityEvents:
        Set<HQNativeParityEventName> = [
            .trayCheckForUpdates,
            .trayOpenDesktop,
            .trayOpenSettings,
            .updateAvailable,
        ]

    private func applyNativeParityEffect(
        _ effect: HQNativeParityEffect
    ) {
        switch effect {
        case let .none(message):
            operationState = .success(message)
        case let .failure(message):
            operationState = .failure(message)
        case let .navigate(route):
            guard let parsed = HQRouteParser.parse(route) else {
                operationState = .failure(
                    "HQ requested an invalid native route: \(route)."
                )
                return
            }
            selectedRoute = parsed
            sceneRequest = HQAppSceneRequest(sceneID: "main")
            operationState = .success("Opened \(route).")
        case let .openScene(id, message):
            if id == HQSecondaryWindowKind.meetings.rawValue {
                focusedMeetingID = nativeParityEvents.focusedMeetingID
                    ?? focusedMeetingID
            }
            sceneRequest = HQAppSceneRequest(sceneID: id)
            operationState = .success(message)
            if id == HQSecondaryWindowKind.messages.rawValue,
               let target = nativeParityEvents.conversationTarget
            {
                pendingMessagesTarget = target
                nativeConversationLoadGeneration += 1
                let generation = nativeConversationLoadGeneration
                let method = "fetch_dm_thread"
                // Invalidate the previous recipient's thread synchronously.
                // The view must never observe the new target alongside stale
                // messages or a ready composer while the replacement request
                // is still waiting for its task to begin.
                secondaryDomainValues[method] = nil
                secondaryDomainFailures[method] = nil
                if target.personUID.trimmingCharacters(
                    in: .whitespacesAndNewlines
                ).isEmpty {
                    secondaryDomainLoading.remove(method)
                } else {
                    secondaryDomainLoading.insert(method)
                }
                Task { [weak self] in
                    await self?.loadNativeConversationTarget(
                        target,
                        generation: generation
                    )
                }
            }
        case let .showMainWindow(message):
            sceneRequest = HQAppSceneRequest(sceneID: "main")
            operationState = .success(message)
        case .syncNow:
            Task { [weak self] in
                await self?.requestSync()
            }
        case .signOut:
            Task { [weak self] in
                await self?.signOutFromNativeParity()
            }
        case .checkForUpdates:
            Task { [weak self] in
                await self?.performNative(
                    .checkForUpdates,
                    payload: nil
                )
            }
        case let .meetingAction(action):
            performNativeMeetingAction(action)
        case let .notificationBanner(action):
            performNativeBannerAction(action)
        case let .notificationDM(action):
            performNativeDMNotificationAction(action)
        case let .notificationMeeting(action):
            performNativeMeetingNotificationAction(action)
        case let .notificationShare(action):
            performNativeShareNotificationAction(action)
        case let .syncState(state, tray, message):
            syncState = state
            trayState = tray
            operationState = .success(message)
        case let .syncFailure(failure, authentication):
            let failureState = HQJSONValue.object([
                "state": .string(authentication ? "auth-error" : "error"),
                "company": failure.company.map(HQJSONValue.string) ?? .null,
                "path": failure.path.map(HQJSONValue.string) ?? .null,
                "message": .string(failure.message),
            ])
            if authentication {
                clearAuthenticatedState(requiresReauthentication: true)
                syncState = failureState
                sceneRequest = HQAppSceneRequest(
                    sceneID: HQSecondaryWindowKind.signIn.rawValue
                )
            } else {
                syncState = failureState
                trayState = .error
            }
            operationState = .failure(failure.message)
        case let .refreshPackages(message):
            operationState = .success(message)
            Task { [weak self] in
                await self?.refreshPackagesFromNativeParity()
            }
        }
    }

    private func signOutFromNativeParity() async {
        await requestMutation(
            method: HQEngineAppCommand.signOut.rawValue,
            params: .object([:]),
            success: "Signed out of HQ."
        )
        guard case .success = operationState else { return }
        clearAuthenticatedState(requiresReauthentication: false)
        sceneRequest = HQAppSceneRequest(
            sceneID: HQSecondaryWindowKind.signIn.rawValue
        )
    }

    private func clearAuthenticatedState(
        requiresReauthentication reauthenticationRequired: Bool
    ) {
        authenticatedDataGeneration &+= 1
        authenticationStateResolved = true
        workspaceOperationGeneration &+= 1
        nativeConversationLoadGeneration += 1
        invalidateOAuthFlow()
        for task in notificationDeliveryTasks.values {
            task.cancel()
        }
        notificationDeliveryTasks.removeAll()
        notificationService.removeAllDeliveredAndPending()
        let recordingsToStop = activeRecallRecordings
        isAuthenticated = false
        requiresReauthentication = reauthenticationRequired
        authState = .object([
            "authenticated": .bool(false),
            "reauthRequired": .bool(reauthenticationRequired),
        ])
        config = .object([:])
        syncState = .object([:])
        hqFolderPath = nil
        selectedSyncWorkspaceSlug = nil
        sessions = []
        content = .liveEmpty
        setupStages = HQSetupStage.initial
        setupIsRunning = false

        secondaryDomainValues.removeAll()
        secondaryDomainFailures.removeAll()
        secondaryDomainLoading.removeAll()
        liveRouteStates.removeAll()

        selectedMessagesConversation = nil
        selectedChannelID = nil
        pendingMessagesTarget = nil
        unreadDMMessages = 0
        pendingDMRequests = 0
        channelUnreadByID.removeAll()
        threadReplies.removeAll()
        threadReplyCounts.removeAll()
        messageReactionState.removeAll()
        dmRequestUpdateHistory.removeAll()

        detectedMeetings.removeAll()
        lastRecallRecordingEnded = nil
        recallMediaCapture.removeAll()
        lastRecallRecordingError = nil
        recallEventHistory.removeAll()
        focusedMeetingID = nil
        pendingMeetingFocusID = nil
        setMeetingPromptBadgeCount(0)

        syncActivityEntries.removeAll()
        activityEventHistory.removeAll()
        cloudRealtimeEventHistory.removeAll()
        nativeNotificationHistory.removeAll()
        nativeEventHistory.removeAll()
        nativeParityEvents = HQNativeParityEventConsumer()
        lastNativeResult = nil

        dismissActiveBanner()
        closeSecondaryWindow(.banner)
        trayState = reauthenticationRequired ? .attention : .current
        selectedRoute = .global(.home)
        isCommandPalettePresented = false
        stopRecordingsAfterAuthenticationClear(recordingsToStop)
    }

    private func stopRecordingsAfterAuthenticationClear(
        _ recordings: [String: HQRecallRecordingStarted]
    ) {
        guard !recordings.isEmpty else { return }
        var newlyOwnedRecordings: [
            String: HQRecallRecordingStarted
        ] = [:]
        for (windowID, snapshot) in recordings {
            guard pendingRecordingCleanup[windowID] == nil else {
                continue
            }
            pendingRecordingCleanup[windowID] = snapshot
            newlyOwnedRecordings[windowID] = snapshot
        }
        guard !newlyOwnedRecordings.isEmpty else { return }
        guard let engine else {
            let message =
                "HQ signed out while meeting capture was active, but the bundled engine is unavailable. Quit HQ before continuing."
            phase = .failed(message)
            operationState = .failure(message)
            return
        }
        let cleanupEngineGeneration = engineGeneration
        guard capabilities.contains("stop_recording") else {
            guard let (windowID, snapshot) = newlyOwnedRecordings.first
            else {
                return
            }
            let task = Task { [weak self] in
                guard let self else { return }
                await self.failClosedAfterRecordingCleanupFailure(
                    windowID: windowID,
                    snapshot: snapshot,
                    through: engine,
                    engineGeneration: cleanupEngineGeneration,
                    reason:
                        "The engine did not advertise stop_recording."
                )
            }
            recordingCleanupTasks[windowID] = task
            return
        }
        for (windowID, snapshot) in newlyOwnedRecordings {
            let task = Task { [weak self] in
                do {
                    _ = try await engine.request(
                        "stop_recording",
                        params: .object([
                            "windowId": .string(windowID),
                        ])
                    )
                    guard let self,
                          self.engineGeneration == cleanupEngineGeneration,
                          self.pendingRecordingCleanup[windowID] == snapshot
                    else {
                        return
                    }
                    if self.activeRecallRecordings[windowID] == snapshot {
                        self.activeRecallRecordings[windowID] = nil
                    }
                    self.recallMediaCapture[windowID] = nil
                    self.pendingRecordingCleanup[windowID] = nil
                    self.recordingCleanupTasks[windowID] = nil
                } catch {
                    await self?.failClosedAfterRecordingCleanupFailure(
                        windowID: windowID,
                        snapshot: snapshot,
                        through: engine,
                        engineGeneration: cleanupEngineGeneration,
                        reason: Self.message(for: error)
                    )
                }
            }
            recordingCleanupTasks[windowID] = task
        }
    }

    private func compensateStaleRecordingStart(
        windowID: String,
        through engine: any HQAppEngine,
        engineGeneration requestEngineGeneration: UInt64
    ) async {
        guard capabilities.contains("stop_recording") else {
            await failClosedAfterRecordingCleanupFailure(
                windowID: windowID,
                snapshot: nil,
                through: engine,
                engineGeneration: requestEngineGeneration,
                reason:
                    "The engine did not advertise stop_recording after an uncertain start_recording outcome."
            )
            return
        }
        do {
            _ = try await engine.request(
                "stop_recording",
                params: .object([
                    "windowId": .string(windowID),
                ])
            )
        } catch {
            await failClosedAfterRecordingCleanupFailure(
                windowID: windowID,
                snapshot: nil,
                through: engine,
                engineGeneration: requestEngineGeneration,
                reason: Self.message(for: error)
            )
        }
    }

    private func failClosedAfterRecordingCleanupFailure(
        windowID: String,
        snapshot: HQRecallRecordingStarted?,
        through engine: any HQAppEngine,
        engineGeneration cleanupEngineGeneration: UInt64,
        reason: String
    ) async {
        let reaperTask: Task<Void, Never>
        if recordingReaperGeneration == cleanupEngineGeneration,
           let existingTask = recordingReaperTask
        {
            reaperTask = existingTask
        } else {
            let newTask = Task {
                await engine.stop()
            }
            recordingReaperGeneration = cleanupEngineGeneration
            recordingReaperTask = newTask
            reaperTask = newTask
        }

        await reaperTask.value
        guard engineGeneration == cleanupEngineGeneration else {
            return
        }

        eventTask?.cancel()
        eventTask = nil
        lifecycleTask?.cancel()
        lifecycleTask = nil

        if let snapshot,
           pendingRecordingCleanup[windowID] == snapshot
        {
            pendingRecordingCleanup[windowID] = nil
        }
        pendingRecordingCleanup.removeAll()
        activeRecallRecordings.removeAll()
        recallMediaCapture.removeAll()
        recordingCleanupTasks.removeAll()
        activeRecordingStartWindows.removeAll()

        let message =
            "Meeting recording cleanup failed for \(windowID): \(reason) The HQ engine was stopped to end capture. Refresh HQ before continuing."
        phase = .failed(message)
        operationState = .failure(message)
    }

    private func refreshPackagesFromNativeParity() async {
        guard hasProtectedAccess,
              capabilities.contains("list_packages"),
              let engine
        else {
            return
        }
        let dataGeneration = authenticatedDataGeneration
        do {
            let value = try await engine.request(
                "list_packages",
                params: .object([:])
            )
            guard hasProtectedAccess,
                  dataGeneration == authenticatedDataGeneration
            else {
                return
            }
            secondaryDomainValues["list_packages"] = value
            secondaryDomainFailures["list_packages"] = nil
        } catch {
            guard hasProtectedAccess,
                  dataGeneration == authenticatedDataGeneration
            else {
                return
            }
            secondaryDomainFailures["list_packages"] =
                Self.message(for: error)
        }
    }

    private func loadNativeConversationTarget(
        _ target: HQNativeConversationTarget,
        generation: Int
    ) async {
        let method = "fetch_dm_thread"
        guard generation == nativeConversationLoadGeneration else {
            return
        }

        secondaryDomainValues[method] = nil
        secondaryDomainFailures[method] = nil
        guard !target.personUID.trimmingCharacters(
            in: .whitespacesAndNewlines
        ).isEmpty else {
            secondaryDomainLoading.remove(method)
            return
        }
        guard capabilities.contains(method), let engine else {
            secondaryDomainFailures[method] =
                "This HQ engine cannot load direct-message threads."
            secondaryDomainLoading.remove(method)
            return
        }

        secondaryDomainLoading.insert(method)
        do {
            let value = try await engine.request(
                method,
                params: .object([
                    "withPersonUid": .string(target.personUID),
                    "limit": .number(50),
                ])
            )
            guard generation == nativeConversationLoadGeneration,
                  nativeParityEvents.conversationTarget == target
            else {
                return
            }
            secondaryDomainValues[method] = value
            secondaryDomainFailures[method] = nil
        } catch {
            guard generation == nativeConversationLoadGeneration,
                  nativeParityEvents.conversationTarget == target
            else {
                return
            }
            secondaryDomainFailures[method] = Self.message(for: error)
        }
        if generation == nativeConversationLoadGeneration {
            secondaryDomainLoading.remove(method)
        }
    }

    private enum NativeMessageDestination: Equatable {
        case person(uid: String)
        case email(String)
        case channel(id: String)
    }

    private func selectNativeMessageConversation(
        _ request: HQMessagesSelectionRequest
    ) {
        selectedMessagesConversation = request
        switch request.section {
        case .directMessages:
            clearSelectedChannelState()
            guard let object = nativeMessageRowObject(
                method: "fetch_notification_history",
                collectionKey: "dms",
                rowID: request.rowID
            ) else {
                operationState = .failure(
                    "The selected direct message is no longer available."
                )
                return
            }
            let personUID = object.string(for: "fromPersonUid")
                ?? object.string(for: "personUid")
                ?? ""
            let email = object.string(for: "fromEmail")
                ?? object.string(for: "email")
                ?? ""
            let displayName = object.string(for: "fromDisplayName")
                ?? object.string(for: "displayName")
                ?? object.string(for: "title")
                ?? email
            guard !personUID.isEmpty || !email.isEmpty else {
                operationState = .failure(
                    "The selected direct message has no recipient."
                )
                return
            }
            emitNativeParityEvent(
                .messagesOpenConversation,
                data: .object([
                    "personUid": .string(personUID),
                    "email": .string(email),
                    "displayName": .string(displayName),
                ])
            )

        case .channels:
            guard let object = nativeMessageRowObject(
                method: "list_channels",
                collectionKey: "channels",
                rowID: request.rowID
            ),
                let channelID = object.string(for: "channelId"),
                !channelID.isEmpty
            else {
                operationState = .failure(
                    "The selected channel is no longer available."
                )
                return
            }
            nativeParityEvents.clearConversationTarget()
            pendingMessagesTarget = nil
            nativeConversationLoadGeneration += 1
            let generation = nativeConversationLoadGeneration
            selectedChannelID = channelID
            secondaryDomainLoading.remove("fetch_dm_thread")
            secondaryDomainValues["fetch_dm_thread"] = nil
            secondaryDomainFailures["fetch_dm_thread"] = nil
            secondaryDomainValues["fetch_channel"] = nil
            secondaryDomainFailures["fetch_channel"] = nil
            secondaryDomainValues["fetch_thread"] = nil
            secondaryDomainFailures["fetch_thread"] = nil
            secondaryDomainLoading.insert("fetch_channel")
            operationState = .busy("Loading the selected channel…")
            Task { [weak self] in
                await self?.loadNativeChannel(
                    channelID,
                    generation: generation
                )
            }

        case .requests:
            selectedRoute = .global(.inbox)
            sceneRequest = HQAppSceneRequest(sceneID: "main")
            operationState = .success("Opened Inbox.")

        case .groups, .threads, .reactions:
            clearSelectedChannelState()
            nativeConversationLoadGeneration += 1
            nativeParityEvents.clearConversationTarget()
            operationState = .success(
                "Selected \(request.section.title.lowercased())."
            )
        }
    }

    private func clearSelectedChannelState() {
        selectedChannelID = nil
        secondaryDomainLoading.remove("fetch_channel")
        secondaryDomainValues["fetch_channel"] = nil
        secondaryDomainFailures["fetch_channel"] = nil
        secondaryDomainValues["fetch_thread"] = nil
        secondaryDomainFailures["fetch_thread"] = nil
    }

    private func loadNativeChannel(
        _ channelID: String,
        generation: Int
    ) async {
        let method = "fetch_channel"
        guard generation == nativeConversationLoadGeneration,
              selectedChannelID == channelID
        else {
            return
        }
        defer {
            if generation == nativeConversationLoadGeneration,
               selectedChannelID == channelID
            {
                secondaryDomainLoading.remove(method)
            }
        }

        guard capabilities.contains(method), let engine else {
            secondaryDomainFailures[method] =
                "This HQ engine cannot load channel conversations."
            return
        }

        do {
            let value = try await engine.request(
                method,
                params: .object(["channelId": .string(channelID)])
            )
            guard generation == nativeConversationLoadGeneration,
                  selectedChannelID == channelID
            else {
                return
            }
            guard let messageValues = value.object?["messages"]?.arrayValue,
                  messageValues.allSatisfy({ $0.object != nil })
            else {
                secondaryDomainFailures[method] =
                    "HQ returned an invalid channel conversation."
                return
            }

            let messageScope = "chan:\(channelID)"
            if capabilities.contains("fetch_reactions") {
                var reactionsByMessage =
                    messageReactionState[messageScope] ?? [:]
                for messageValue in messageValues {
                    guard let messageID = messageValue.object?
                        .string(for: "eventId"),
                        !messageID.hasPrefix("local-")
                    else {
                        continue
                    }
                    do {
                        let reactionValue = try await engine.request(
                            "fetch_reactions",
                            params: .object([
                                "messageScope": .string(messageScope),
                                "messageId": .string(messageID),
                            ])
                        )
                        guard generation == nativeConversationLoadGeneration,
                              selectedChannelID == channelID
                        else {
                            return
                        }
                        guard let values = reactionValue.arrayValue else {
                            secondaryDomainFailures["fetch_reactions"] =
                                "HQ returned invalid channel reactions."
                            continue
                        }
                        let reactions = values.compactMap(
                            HQRealtimeReaction.init(value:)
                        )
                        guard reactions.count == values.count else {
                            secondaryDomainFailures["fetch_reactions"] =
                                "HQ returned invalid channel reactions."
                            continue
                        }
                        reactionsByMessage[messageID] = reactions
                    } catch {
                        guard generation == nativeConversationLoadGeneration,
                              selectedChannelID == channelID
                        else {
                            return
                        }
                        secondaryDomainFailures["fetch_reactions"] =
                            Self.message(for: error)
                    }
                }
                messageReactionState[messageScope] = reactionsByMessage
            }

            if capabilities.contains("fetch_thread"),
               let rootMessage = messageValues.first(where: { value in
                   guard let object = value.object,
                         let replyCount = object["replyCount"]?.numberValue
                   else {
                       return false
                   }
                   return replyCount > 0
                       && (
                           object.string(for: "rootEventId") != nil
                               || object.string(for: "eventId") != nil
                       )
               }),
               let rootObject = rootMessage.object,
               let rootEventID =
                    rootObject.string(for: "rootEventId")
                    ?? rootObject.string(for: "eventId")
            {
                do {
                    let threadValue = try await engine.request(
                        "fetch_thread",
                        params: .object([
                            "scope": .string("channel"),
                            "rootEventId": .string(rootEventID),
                            "channelId": .string(channelID),
                            "withPersonUid": .null,
                        ])
                    )
                    guard generation == nativeConversationLoadGeneration,
                          selectedChannelID == channelID
                    else {
                        return
                    }
                    secondaryDomainValues["fetch_thread"] = threadValue
                    secondaryDomainFailures["fetch_thread"] = nil
                } catch {
                    guard generation == nativeConversationLoadGeneration,
                          selectedChannelID == channelID
                    else {
                        return
                    }
                    secondaryDomainFailures["fetch_thread"] =
                        Self.message(for: error)
                }
            }

            secondaryDomainValues[method] = value
            secondaryDomainFailures[method] = nil
            operationState = .success("Opened the selected channel.")
        } catch {
            guard generation == nativeConversationLoadGeneration,
                  selectedChannelID == channelID
            else {
                return
            }
            secondaryDomainFailures[method] = Self.message(for: error)
            operationState = .failure(Self.message(for: error))
        }
    }

    private func sendNativeDirectMessageReply(_ body: String) async {
        guard !body.trimmingCharacters(
            in: .whitespacesAndNewlines
        ).isEmpty else {
            operationState = .failure("Enter a reply before sending.")
            return
        }
        guard let message = secondaryDomainValues["dm:detail-event"].flatMap(
                HQRealtimeDirectMessage.init(value:)
            )
            ?? nativeParityEvents.dmDetailMessage
        else {
            operationState = .failure(
                "The direct-message recipient is no longer available."
            )
            return
        }
        await requestMutation(
            method: "send_dm",
            params: .object([
                "toPersonUid": .string(message.fromPersonUID),
                "body": .string(body),
            ]),
            success: "Reply sent."
        )
    }

    private func sendNativeMessage(
        _ request: HQMessagesSendRequest
    ) async {
        guard !request.body.trimmingCharacters(
            in: .whitespacesAndNewlines
        ).isEmpty else {
            operationState = .failure("Enter a message before sending.")
            return
        }
        guard let destination = nativeMessageDestination(for: request) else {
            operationState = .failure(
                "Select a direct message or channel that can receive messages."
            )
            return
        }

        let method: String
        let params: HQJSONValue
        switch destination {
        case let .person(uid):
            method = "send_dm"
            params = .object([
                "toPersonUid": .string(uid),
                "body": .string(request.body),
            ])
        case let .email(email):
            method = "send_dm_to_email"
            params = .object([
                "toEmail": .string(email),
                "toPersonUid": .null,
                "body": .string(request.body),
            ])
        case let .channel(id):
            method = "send_channel_message"
            params = .object([
                "channelId": .string(id),
                "body": .string(request.body),
            ])
        }

        await requestMutation(
            method: method,
            params: params,
            success: "Message sent."
        )
        guard case .success = operationState else { return }
        appendOptimisticNativeMessage(
            request.body,
            destination: destination
        )
    }

    private func nativeMessageDestination(
        for request: HQMessagesSendRequest
    ) -> NativeMessageDestination? {
        if request.section == .directMessages,
           let target = nativeParityEvents.conversationTarget
        {
            let targetRowID = target.personUID.isEmpty
                ? "target-email-\(target.email)"
                : "target-person-\(target.personUID)"
            if request.rowID == targetRowID {
                if !target.personUID.isEmpty {
                    return .person(uid: target.personUID)
                }
                if !target.email.isEmpty {
                    return .email(target.email)
                }
            }
        }

        let source: (method: String, key: String)
        switch request.section {
        case .directMessages:
            source = ("fetch_notification_history", "dms")
        case .channels:
            source = ("list_channels", "channels")
        case .requests:
            source = ("list_dm_requests", "requests")
        case .groups, .threads, .reactions:
            return nil
        }
        guard let object = nativeMessageRowObject(
            method: source.method,
            collectionKey: source.key,
            rowID: request.rowID
        ) else {
            return nil
        }

        if request.section == .channels,
           let channelID = object.string(for: "channelId")
            ?? object.string(for: "id")
            ?? object.string(for: "uid"),
           !channelID.isEmpty
        {
            return .channel(id: channelID)
        }
        let personUID = object.string(for: "fromPersonUid")
            ?? object.string(for: "personUid")
            ?? object.string(for: "uid")
            ?? ""
        if !personUID.isEmpty {
            return .person(uid: personUID)
        }
        let email = object.string(for: "fromEmail")
            ?? object.string(for: "email")
            ?? ""
        return email.isEmpty ? nil : .email(email)
    }

    private func nativeMessageRowObject(
        method: String,
        collectionKey: String,
        rowID: String
    ) -> [String: HQJSONValue]? {
        domainRows(
            method: method,
            collectionKey: collectionKey
        ).enumerated().first(where: { index, value in
            guard let object = value.object else { return false }
            let rawID = object.string(for: "id")
                ?? object.string(for: "uid")
                ?? object.string(for: "channelId")
                ?? object.string(for: "eventId")
                ?? object.string(for: "path")
                ?? "\(index)"
            return "\(method)-\(rawID)" == rowID
        })?.element.object
    }

    private func appendOptimisticNativeMessage(
        _ body: String,
        destination: NativeMessageDestination
    ) {
        guard let target = nativeParityEvents.conversationTarget else {
            return
        }
        let matchesSelectedTarget: Bool
        switch destination {
        case let .person(uid):
            matchesSelectedTarget = target.personUID == uid
        case let .email(email):
            matchesSelectedTarget =
                target.personUID.isEmpty && target.email == email
        case .channel:
            matchesSelectedTarget = false
        }
        guard matchesSelectedTarget else { return }

        let method = "fetch_dm_thread"
        var object = secondaryDomainValues[method]?.object ?? [:]
        var messages = object["messages"]?.arrayValue ?? []
        messages.insert(
            .object([
                "eventId": .string("local-\(UUID().uuidString)"),
                "fromPersonUid": .string("me"),
                "fromEmail": .string(""),
                "fromDisplayName": .string("You"),
                "body": .string(body),
                "details": .null,
                "prompt": .null,
                "createdAt": .string(
                    ISO8601DateFormatter().string(from: Date())
                ),
                "direction": .string("out"),
            ]),
            at: 0
        )
        object["messages"] = .array(messages)
        secondaryDomainValues[method] = .object(object)
    }

    private func nativeConversationTarget(
        from payload: HQJSONValue?
    ) -> HQNativeConversationTarget? {
        let root = payload?.object
        let object = root?["target"]?.object ?? root
        guard let object else { return nil }
        let personUID = object.string(for: "personUid") ?? ""
        let email = object.string(for: "email") ?? ""
        let displayName = object.string(for: "displayName") ?? ""
        guard !personUID.trimmingCharacters(
            in: .whitespacesAndNewlines
        ).isEmpty || !email.trimmingCharacters(
            in: .whitespacesAndNewlines
        ).isEmpty else {
            return nil
        }
        return HQNativeConversationTarget(
            personUID: personUID,
            email: email,
            displayName: displayName
        )
    }

    private func performNativeMeetingAction(
        _ action: HQNativeMeetingWindowAction
    ) {
        guard pendingRecordingCleanup[action.windowID] == nil else {
            operationState = .failure(
                "Meeting capture cleanup is still finishing for this window. Refresh HQ if it does not complete."
            )
            return
        }
        guard activeMeetingWindowMutations.insert(action.windowID).inserted
        else {
            return
        }
        let method: String
        let success: String
        switch action.operation {
        case .start:
            method = "start_recording"
            success = "Meeting capture started."
        case .stop:
            method = "stop_recording"
            success = "Meeting capture stopped."
        case .changeCompany:
            method = "meetings_set_company"
            success = "Meeting company updated."
        }
        Task { [weak self] in
            guard let self else { return }
            defer {
                activeMeetingWindowMutations.remove(action.windowID)
            }
            await requestMutation(
                method: method,
                params: .object([
                    "windowId": .string(action.windowID),
                    "companyUid": action.companyUID.map(HQJSONValue.string)
                        ?? .null,
                ]),
                success: success
            )
        }
    }

    private func performNativeDMNotificationAction(
        _ action: HQNativeDMNotificationAction
    ) {
        switch action.operation {
        case .copy:
            guard let prompt = action.message.prompt?
                .trimmingCharacters(in: .whitespacesAndNewlines),
                !prompt.isEmpty
            else {
                operationState = .failure(
                    "This message does not contain a prompt to copy."
                )
                return
            }
            writeNativeParityClipboard(prompt)
            operationState = .success("Copied the message prompt.")
        case .open:
            secondaryDomainValues["dm:detail-event"] = action.message.json
            applyNativeParityEffect(
                nativeParityEvents.openDirectMessage(action.message)
            )
        }
    }

    private func performNativeShareNotificationAction(
        _ action: HQNativeShareNotificationAction
    ) {
        let prompt = Self.nativeSharePrompt(for: action.share)
        switch action.operation {
        case .copy:
            writeNativeParityClipboard(prompt)
            operationState = .success("Copied the secure-share prompt.")
        case .open:
            secondaryDomainValues["share:events-list"] = .array([
                nativeParityJSON(for: action.share),
            ])
            sceneRequest = HQAppSceneRequest(
                sceneID: HQSecondaryWindowKind.shareDetail.rawValue
            )
            operationState = .success("Opened the secure share.")
        case .claude:
            guard let url = Self.nativeClaudeCodeURL(
                folder: hqFolderPath ?? "",
                prompt: prompt
            ) else {
                operationState = .failure(
                    "Could not build the Claude Code secure-share link."
                )
                return
            }
            do {
                try openExternalURL(url)
                operationState = .success(
                    "Opened the secure share in Claude Code."
                )
            } catch {
                operationState = .failure(Self.message(for: error))
            }
        }
    }

    static func nativeSharePrompt(
        for share: HQNativeShareSnapshot
    ) -> String {
        let note = share.note?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedNote = note.flatMap {
            $0.isEmpty ? nil : $0
        } ?? "(no note)"
        return "\(share.issuerDisplayName) shared these files with me: \(share.paths.joined(separator: ", "))\n\nTheir note: \(normalizedNote)."
    }

    static func nativeClaudeCodeURL(
        folder: String,
        prompt: String
    ) -> URL? {
        var components = URLComponents()
        components.scheme = "claude"
        components.host = "code"
        components.path = "/new"
        var items = [URLQueryItem(name: "q", value: prompt)]
        if !folder.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            items.append(URLQueryItem(name: "folder", value: folder))
        }
        components.queryItems = items
        return components.url
    }

    private func performNativeMeetingNotificationAction(
        _ action: HQNativeMeetingNotificationAction
    ) {
        switch action.operation {
        case .open:
            sceneRequest = HQAppSceneRequest(sceneID: "main")
            setMeetingPromptBadgeCount(0)
            operationState = .success("Opened the detected meeting.")
        case .assign:
            focusedMeetingID = action.meetingID ?? action.windowID
            sceneRequest = HQAppSceneRequest(
                sceneID: HQSecondaryWindowKind.meetings.rawValue
            )
            setMeetingPromptBadgeCount(0)
            operationState = .success("Opened meeting assignment.")
        case .record:
            guard let windowID = action.windowID else {
                operationState = .failure(
                    "The meeting notification did not include a window."
                )
                return
            }
            setMeetingPromptBadgeCount(0)
            performNativeMeetingAction(
                HQNativeMeetingWindowAction(
                    operation: .start,
                    windowID: windowID,
                    companyUID: nil
                )
            )
        }
    }

    private func performBannerNotificationAction(
        _ payload: HQActiveBannerPayload
    ) async {
        if activeBannerPayload == payload {
            dismissActiveBanner()
            closeSecondaryWindow(.banner)
        }
        switch payload {
        case .syncComplete:
            sceneRequest = HQAppSceneRequest(
                sceneID: HQSecondaryWindowKind.activity.rawValue
            )
            operationState = .success("Opened recent sync changes.")
        case let .meetingReady(_, _, windowID, meetingID, _):
            focusedMeetingID = meetingID ?? windowID
            setMeetingPromptBadgeCount(0)
            sceneRequest = HQAppSceneRequest(
                sceneID: HQSecondaryWindowKind.meetings.rawValue
            )
            operationState = .success("Opened the matching meeting.")
        case let .directMessage(message):
            emitNativeParityEvent(
                .notificationBannerAction,
                data: .object([
                    "kind": .string(HQNativeBannerSource.dm.rawValue),
                    "action": .string(
                        HQNativeDMNotificationOperation.open.rawValue
                    ),
                    "data": message.json,
                ])
            )
        case .updateAvailable:
            selectedRoute = .settings(.updates)
            sceneRequest = HQAppSceneRequest(sceneID: "main")
            await loadLiveRoute(.settings(.updates))
            operationState = .success("Opened HQ update settings.")
        }
    }

    private func performNativeBannerAction(
        _ action: HQNativeBannerAction
    ) {
        let object = action.data.object ?? [:]
        switch action.source {
        case .dm:
            guard let message = HQRealtimeDirectMessage(value: action.data),
                  let operation = HQNativeDMNotificationOperation(
                      rawValue: action.action
                  )
            else {
                operationState = .failure(
                    "The message banner action was invalid."
                )
                return
            }
            performNativeDMNotificationAction(
                HQNativeDMNotificationAction(
                    operation: operation,
                    message: message
                )
            )
        case .share:
            guard let share = nativeParityShare(from: action.data),
                  let operation = HQNativeShareNotificationOperation(
                      rawValue: action.action
                  )
            else {
                operationState = .failure(
                    "The share banner action was invalid."
                )
                return
            }
            performNativeShareNotificationAction(
                HQNativeShareNotificationAction(
                    operation: operation,
                    share: share
                )
            )
        case .update:
            selectedRoute = .settings(.updates)
            sceneRequest = HQAppSceneRequest(sceneID: "main")
            if action.action == "update" {
                Task { [weak self] in
                    await self?.performNative(.installUpdate, payload: nil)
                }
            } else {
                operationState = .success("Opened the HQ update.")
            }
        case .meeting:
            let meetingAction = HQNativeMeetingNotificationAction(
                operation: action.action == "record"
                    ? .record
                    : action.action == "assign" ? .assign : .open,
                windowID: object["windowId"]?.stringValue,
                platform: object["platform"]?.stringValue,
                meetingID: object["meetingId"]?.stringValue
            )
            performNativeMeetingNotificationAction(meetingAction)
        }
    }

    private func writeNativeParityClipboard(_ value: String) {
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        pasteboard.setString(value, forType: .string)
    }

    private func nativeParityJSON(
        for share: HQNativeShareSnapshot
    ) -> HQJSONValue {
        .object([
            "eventId": .string(share.eventID),
            "issuerEmail": .string(share.issuerEmail),
            "issuerDisplayName": .string(share.issuerDisplayName),
            "paths": .array(share.paths.map(HQJSONValue.string)),
            "note": share.note.map(HQJSONValue.string) ?? .null,
            "permission": .string(share.permission),
            "createdAt": .string(share.createdAt),
        ])
    }

    private func nativeParityShare(
        from value: HQJSONValue
    ) -> HQNativeShareSnapshot? {
        guard let object = value.object,
              let eventID = object["eventId"]?.stringValue,
              let issuerEmail = object["issuerEmail"]?.stringValue,
              let issuerDisplayName = object["issuerDisplayName"]?.stringValue,
              let pathValues = object["paths"]?.arrayValue,
              pathValues.allSatisfy({ $0.stringValue != nil }),
              let permission = object["permission"]?.stringValue,
              let createdAt = object["createdAt"]?.stringValue
        else {
            return nil
        }
        return HQNativeShareSnapshot(
            eventID: eventID,
            issuerEmail: issuerEmail,
            issuerDisplayName: issuerDisplayName,
            paths: pathValues.compactMap(\.stringValue),
            note: object["note"]?.stringValue,
            permission: permission,
            createdAt: createdAt
        )
    }

    private func reduceRecallEvent(_ record: HQRecallEventRecord) {
        switch record.payload {
        case let .meetingDetected(meeting):
            detectedMeetings[meeting.detectionID] = meeting
            operationState = .success(
                "Detected a \(meeting.platform.rawValue) meeting."
            )
            Task { [weak self] in
                await self?.requestMeetingNotification(for: meeting)
            }
        case let .meetingClosed(meeting):
            detectedMeetings = detectedMeetings.filter {
                $0.value.windowID != meeting.windowID
            }
            activeRecallRecordings[meeting.windowID] = nil
            recallMediaCapture[meeting.windowID] = nil
            operationState = .success(
                "\(meeting.platform.rawValue.capitalized) meeting closed."
            )
        case let .permissionStatus(update):
            recallPermissionStatuses[update.permission] = update.status
            if !["authorized", "granted"].contains(
                update.status.lowercased()
            ) {
                allRecallPermissionsGranted = false
            }
            operationState = .success(
                "\(update.permission.rawValue) permission is \(update.status)."
            )
        case .permissionsAllGranted:
            allRecallPermissionsGranted = true
            operationState = .success(
                "All Recall permissions are granted."
            )
        case let .recordingStarted(recording):
            activeRecallRecordings[recording.windowID] = recording
            lastRecallRecordingError = nil
            operationState = .success(
                "Recording started for \(recording.platform.rawValue)."
            )
        case let .recordingEnded(recording):
            activeRecallRecordings[recording.windowID] = nil
            recallMediaCapture[recording.windowID] = nil
            lastRecallRecordingEnded = recording
            operationState = .success(
                "Recording ended for \(recording.platform.rawValue)."
            )
        case let .recordingMediaCapture(capture):
            recallMediaCapture[capture.windowID] = capture
            operationState = .success(
                capture.capturing
                    ? "Recall is capturing \(capture.captureType)."
                    : "Recall stopped capturing \(capture.captureType)."
            )
        case let .recordingError(failure):
            activeRecallRecordings[failure.windowID] = nil
            recallMediaCapture[failure.windowID] = nil
            lastRecallRecordingError = failure
            operationState = .failure(failure.message)
        }
    }

    private func requestMeetingNotification(
        for meeting: HQRecallMeetingDetection
    ) async {
        let method = "meetings_notify_detected"
        guard hasProtectedAccess,
              capabilities.contains(method),
              let engine
        else {
            return
        }
        let dataGeneration = authenticatedDataGeneration

        let requestPayload: HQJSONValue = .object([
            "meetingUrl": .string(meeting.meetingURL),
            "windowId": meeting.windowID.map(HQJSONValue.string) ?? .null,
            "platform": .string(meeting.platform.rawValue),
            "summary": .null,
            "sourceEventId": meeting.sourceEventID.map(HQJSONValue.string)
                ?? .null,
        ])

        do {
            let response = try await engine.request(
                method,
                params: .object(["payload": requestPayload])
            )
            guard hasProtectedAccess,
                  dataGeneration == authenticatedDataGeneration
            else {
                return
            }
            guard let object = response.object,
                  let allowed = object["allowed"]?.boolValue,
                  let reason = object["reason"]?.stringValue
            else {
                operationState = .failure(
                    "The meeting notification policy returned an invalid response."
                )
                return
            }

            secondaryDomainValues[method] = response
            guard allowed else {
                guard object["notification"] == nil
                    || object["notification"] == .null
                else {
                    operationState = .failure(
                        "A suppressed meeting notification unexpectedly included delivery content."
                    )
                    return
                }
                operationState = .success(
                    "Meeting notification suppressed: \(reason)."
                )
                return
            }

            guard reason == "allowed",
                  let notification = object["notification"]?.object,
                  let title = notification["title"]?.stringValue,
                  !title.isEmpty,
                  let body = notification["body"]?.stringValue,
                  !body.isEmpty,
                  let platform = notification["platform"]?.stringValue
            else {
                operationState = .failure(
                    "The allowed meeting notification was missing native delivery content."
                )
                return
            }

            var userInfo = ["platform": platform]
            for key in [
                "windowId",
                "meetingUrl",
                "sourceEventId",
            ] {
                if let value = notification[key]?.stringValue, !value.isEmpty {
                    userInfo[key] = value
                }
            }
            presentNativeNotification(
                HQNotificationPayload(
                    identifier:
                        "meeting-\(meeting.sourceEventID ?? meeting.windowID ?? meeting.detectionID)",
                    title: title,
                    body: body,
                    categoryIdentifier: "hq.meeting",
                    userInfo: userInfo
                )
            )
            presentBanner(
                .meetingReady(
                    title: title,
                    message: body,
                    windowID: meeting.windowID,
                    meetingID:
                        meeting.sourceEventID ?? meeting.detectionID,
                    platform: platform
                )
            )
            setMeetingPromptBadgeCount(meetingPromptBadgeCount + 1)
            trayState = .attention
            operationState = .success("Presented the detected meeting.")
        } catch {
            guard hasProtectedAccess,
                  dataGeneration == authenticatedDataGeneration
            else {
                return
            }
            operationState = .failure(Self.message(for: error))
        }
    }

    private func failStartup(_ message: String) {
        phase = .failed(message)
        operationState = .failure(message)
    }

    private func nativeDirectMessageDetailState(
        kind: HQSecondaryWindowKind,
        message: HQRealtimeDirectMessage
    ) -> HQWindowContentState {
        let sender = message.fromDisplayName
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let senderLabel = sender.isEmpty ? message.fromEmail : sender
        var rows = [
            HQWindowRowFixture(
                id: "dm-\(message.eventID)-body",
                title: "Message",
                detail: message.body,
                symbolName: "text.bubble",
                metadata: ["eventId": .string(message.eventID)]
            ),
        ]
        if let details = message.details?
            .trimmingCharacters(in: .whitespacesAndNewlines),
           !details.isEmpty
        {
            rows.append(
                HQWindowRowFixture(
                    id: "dm-\(message.eventID)-details",
                    title: "Details",
                    detail: details,
                    symbolName: "text.alignleft"
                )
            )
        }
        if let prompt = message.prompt?
            .trimmingCharacters(in: .whitespacesAndNewlines),
           !prompt.isEmpty
        {
            rows.append(
                HQWindowRowFixture(
                    id: "dm-\(message.eventID)-prompt",
                    title: "Agent prompt",
                    detail: prompt,
                    symbolName: "sparkles"
                )
            )
        }

        return .content(
            liveWindowFixture(
                kind: kind,
                title: senderLabel.isEmpty ? "Direct Message" : senderLabel,
                subtitle: [message.fromEmail, message.createdAt]
                    .filter { !$0.isEmpty }
                    .joined(separator: " · "),
                symbol: "message.fill",
                rows: rows,
                primary: HQWindowActionFixture(
                    id: "open",
                    title: "Open Messages",
                    symbolName: "bubble.left.and.bubble.right"
                ),
                secondary: nil
            )
        )
    }

    private func nativeShareDetailState(
        kind: HQSecondaryWindowKind,
        share: HQNativeShareSnapshot
    ) -> HQWindowContentState {
        let sender = share.issuerDisplayName
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let senderLabel = sender.isEmpty ? share.issuerEmail : sender
        var rows = [
            HQWindowRowFixture(
                id: "share-\(share.eventID)-paths",
                title: share.paths.count == 1 ? "Shared file" : "Shared files",
                detail: share.paths.joined(separator: "\n"),
                symbolName: "doc.on.doc",
                value: "\(share.paths.count)",
                metadata: ["eventId": .string(share.eventID)]
            ),
            HQWindowRowFixture(
                id: "share-\(share.eventID)-permission",
                title: "Permission",
                detail: "Access granted by \(senderLabel)",
                symbolName: "lock.open",
                value: share.permission
            ),
        ]
        if let note = share.note?
            .trimmingCharacters(in: .whitespacesAndNewlines),
           !note.isEmpty
        {
            rows.insert(
                HQWindowRowFixture(
                    id: "share-\(share.eventID)-note",
                    title: "Note",
                    detail: note,
                    symbolName: "quote.bubble"
                ),
                at: 1
            )
        }

        return .content(
            liveWindowFixture(
                kind: kind,
                title: "Shared with you",
                subtitle: [senderLabel, share.createdAt]
                    .filter { !$0.isEmpty }
                    .joined(separator: " · "),
                symbol: "person.2.wave.2",
                rows: rows,
                primary: nil,
                secondary: nil
            )
        )
    }

    private func liveWindowFixture(
        kind: HQSecondaryWindowKind,
        title: String,
        subtitle: String,
        symbol: String,
        rows: [HQWindowRowFixture],
        primary: HQWindowActionFixture?,
        secondary: HQWindowActionFixture?
    ) -> HQWindowFixture {
        HQWindowFixture(
            kind: kind,
            title: title,
            subtitle: subtitle,
            symbolName: symbol,
            accessibilityIdentifier: "window.\(kind.rawValue)",
            rows: rows,
            primaryAction: primary,
            secondaryAction: secondary
        )
    }

    private func liveMeetingsWindowState() -> HQWindowContentState {
        let method = HQEngineAppCommand.meetingsListAccounts.rawValue
        let snapshot = currentNativeMeetingsSnapshot
        if secondaryDomainLoading.contains(method),
           snapshot.activeMeetings.isEmpty
        {
            return .loading
        }
        if secondaryDomainValues[method] == nil,
           snapshot.activeMeetings.isEmpty,
           let failure = secondaryDomainFailures[method]
        {
            return .failure(
                HQWindowFailureState(
                    message: failure,
                    retryTitle: "Try Again"
                )
            )
        }

        let memberships: HQJSONValue = .array(
            snapshot.memberships.map { membership in
                .object([
                    "companyUid": .string(membership.companyUID),
                    "companyName": membership.companyName.map(
                        HQJSONValue.string
                    ) ?? .null,
                    "status": .string(membership.status),
                ])
            }
        )
        let activeRows = snapshot.activeMeetings.map { meeting in
            let isFocused = focusedMeetingID == meeting.windowID
                || focusedMeetingID == meeting.sourceEventID
            let summary = meeting.summary?.trimmingCharacters(
                in: .whitespacesAndNewlines
            )
            let error = meeting.error?.trimmingCharacters(
                in: .whitespacesAndNewlines
            )
            let meetingURL = meeting.meetingURL.trimmingCharacters(
                in: .whitespacesAndNewlines
            )
            return HQWindowRowFixture(
                id: "active-\(meeting.windowID)",
                title: summary?.isEmpty == false
                    ? summary!
                    : "\(Self.meetingPlatformLabel(meeting.platform)) meeting",
                detail: error?.isEmpty == false
                    ? error!
                    : (meetingURL.isEmpty
                        ? "Detected \(meeting.detectedAt)"
                        : meetingURL),
                symbolName: meeting.state == .recording
                    ? "record.circle.fill"
                    : "video",
                value: meeting.state.rawValue.capitalized,
                metadata: [
                    "windowId": .string(meeting.windowID),
                    "state": .string(meeting.state.rawValue),
                    "companyUid": meeting.companyUID.map(
                        HQJSONValue.string
                    ) ?? .null,
                    "memberships": memberships,
                    "focused": .bool(isFocused),
                ]
            )
        }

        let accountRows = secondaryDomainValues[method].map {
            Self.windowRows(
                from: $0,
                collectionKeys: ["accounts", "calendars", "meetings"],
                idPrefix: method,
                defaultSymbol: "calendar"
            )
        } ?? []
        let focusedAccountRows = accountRows.map { row in
            let rowMeetingID = row.metadata["meetingId"]?.stringValue
                ?? row.metadata["id"]?.stringValue
                ?? row.metadata["uid"]?.stringValue
            var metadata = row.metadata
            metadata["focused"] = .bool(
                focusedMeetingID != nil
                    && focusedMeetingID == rowMeetingID
            )
            return HQWindowRowFixture(
                id: row.id,
                title: row.title,
                detail: row.detail,
                symbolName: row.symbolName,
                value: row.value,
                metadata: metadata
            )
        }

        return .content(
            liveWindowFixture(
                kind: .meetings,
                title: "HQ Meetings",
                subtitle: activeRows.isEmpty
                    ? "No active capture. Connected meeting accounts remain available below."
                    : "\(activeRows.count) active meeting\(activeRows.count == 1 ? "" : "s") from the live native detector.",
                symbol: activeRows.isEmpty ? "video" : "waveform.circle",
                rows: activeRows + focusedAccountRows,
                primary: HQWindowActionFixture(
                    id: "permissions",
                    title: "Meeting Permissions",
                    symbolName: "lock.shield"
                ),
                secondary: HQWindowActionFixture(
                    id: "refresh",
                    title: "Refresh",
                    symbolName: "arrow.clockwise"
                )
            )
        )
    }

    private var currentNativeMeetingsSnapshot: HQNativeMeetingsSnapshot {
        let retained = nativeParityEvents.meetingsSnapshot
        guard retained.activeMeetings.isEmpty,
              !detectedMeetings.isEmpty
        else {
            return retained
        }

        let active = detectedMeetings.values.sorted {
            $0.detectionID < $1.detectionID
        }.map { meeting in
            let windowID = meeting.windowID ?? meeting.detectionID
            let recording = activeRecallRecordings[windowID] != nil
            let recordingError = lastRecallRecordingError.flatMap {
                $0.windowID == windowID ? $0.message : nil
            }
            return HQNativeMeetingSnapshotRow(
                windowID: windowID,
                platform: meeting.platform.rawValue,
                meetingURL: meeting.meetingURL,
                detectedAt: meeting.detectedAt,
                state: recordingError == nil
                    ? (recording ? .recording : .detected)
                    : .error,
                recordingID: nil,
                error: recordingError,
                companyUID: nil,
                companyUserSet: nil,
                summary: nil,
                sourceEventID: meeting.sourceEventID
                    ?? meeting.detectionID
            )
        }
        return HQNativeMeetingsSnapshot(
            activeMeetings: active,
            memberships: retained.memberships,
            defaultRecordingCompanyUID:
                retained.defaultRecordingCompanyUID
        )
    }

    private static func meetingPlatformLabel(_ platform: String) -> String {
        switch platform.lowercased() {
        case "meet", "google-meet", "googlemeet":
            return "Google Meet"
        case "zoom":
            return "Zoom"
        case "teams":
            return "Teams"
        case "slack":
            return "Slack"
        case "webex":
            return "Webex"
        default:
            return platform.isEmpty ? "Active" : platform.capitalized
        }
    }

    private func liveDomainWindowState(
        kind: HQSecondaryWindowKind,
        methods: [String],
        collectionKeys: [String],
        title: String,
        subtitle: String,
        symbol: String,
        emptyTitle: String,
        emptyMessage: String,
        primary: HQWindowActionFixture?,
        secondary: HQWindowActionFixture?,
        renderEmptyContent: Bool = false
    ) -> HQWindowContentState {
        if methods.contains(where: secondaryDomainLoading.contains) {
            return .loading
        }

        let loaded = methods.compactMap { method -> (String, HQJSONValue)? in
            secondaryDomainValues[method].map { (method, $0) }
        }
        if loaded.isEmpty,
           let failure = methods.compactMap({ secondaryDomainFailures[$0] }).first
        {
            return .failure(
                HQWindowFailureState(
                    message: failure,
                    retryTitle: "Try Again"
                )
            )
        }

        let rows = loaded.flatMap { method, value in
            Self.windowRows(
                from: value,
                collectionKeys: collectionKeys,
                idPrefix: method,
                defaultSymbol: symbol
            )
        }
        guard !rows.isEmpty || renderEmptyContent else {
            return .empty(
                HQWindowEmptyState(
                    title: emptyTitle,
                    message: emptyMessage
                )
            )
        }

        return .content(
            liveWindowFixture(
                kind: kind,
                title: title,
                subtitle: subtitle,
                symbol: symbol,
                rows: rows,
                primary: primary,
                secondary: secondary
            )
        )
    }

    private static func windowRows(
        from value: HQJSONValue,
        collectionKeys: [String],
        idPrefix: String,
        defaultSymbol: String
    ) -> [HQWindowRowFixture] {
        var values = value.arrayValue ?? []
        if let object = value.object {
            for key in collectionKeys {
                if let rows = object[key]?.arrayValue {
                    values.append(contentsOf: rows)
                } else if let row = object[key]?.object {
                    values.append(.object(row))
                }
            }
        }

        return values.enumerated().compactMap { index, value in
            guard let object = value.object else { return nil }
            let rawID = object.string(for: "id")
                ?? object.string(for: "uid")
                ?? object.string(for: "channelId")
                ?? object.string(for: "eventId")
                ?? object.string(for: "path")
                ?? "\(index)"
            let title = object.string(for: "title")
                ?? object.string(for: "name")
                ?? object.string(for: "displayName")
                ?? object.string(for: "fromDisplayName")
                ?? object.string(for: "fromEmail")
                ?? object.string(for: "subject")
                ?? object.string(for: "eventType")
                ?? object.string(for: "kind")
                ?? object.string(for: "path")
                ?? object.string(for: "body")
                ?? "HQ item"
            let detail = object.string(for: "detail")
                ?? object.string(for: "summary")
                ?? object.string(for: "preview")
                ?? object.string(for: "message")
                ?? object.string(for: "body")
                ?? object.string(for: "path")
                ?? object.string(for: "status")
                ?? ""
            let value = object.string(for: "timestamp")
                ?? object.string(for: "createdAt")
                ?? object.string(for: "updatedAt")
                ?? object.string(for: "status")
                ?? object["unreadCount"]?.displayValue

            return HQWindowRowFixture(
                id: "\(idPrefix)-\(rawID)",
                title: title,
                detail: detail,
                symbolName: object.string(for: "symbolName") ?? defaultSymbol,
                value: value,
                metadata: object
            )
        }
    }

    private static func capabilities(from handshake: HQJSONValue) -> Set<String> {
        Set(
            handshake.object?["capabilities"]?.arrayValue?
                .compactMap(\.stringValue) ?? []
        )
    }

    private static func decodeWorkspaces(_ value: HQJSONValue) -> [HQWorkspace] {
        let rows = value.object?["workspaces"]?.arrayValue ?? value.arrayValue ?? []
        return rows.compactMap { row in
            guard let object = row.object,
                  let slug = object.string(for: "slug"),
                  !slug.isEmpty
            else {
                return nil
            }
            let path = object.string(for: "path").map(URL.init(fileURLWithPath:))
            let exists = object.bool(for: "exists") ?? (path != nil)
            return HQWorkspace(
                slug: slug,
                name: object.string(for: "displayName")
                    ?? object.string(for: "name")
                    ?? slug,
                path: path,
                kind: object.string(for: "kind") ?? "company",
                state: exists ? .connected : .needsConnect,
                lastSyncedAt: nil
            )
        }
    }

    private static func decodeProjects(
        _ value: HQJSONValue,
        workspaces: [HQWorkspace]
    ) -> [HQProject] {
        let rows = value.object?["projects"]?.arrayValue ?? value.arrayValue ?? []
        let workspacePaths = Dictionary(
            uniqueKeysWithValues: workspaces.compactMap { workspace in
                workspace.path.map { (workspace.slug, $0) }
            }
        )

        return rows.compactMap { row in
            guard let object = row.object,
                  let id = object.string(for: "id"),
                  !id.isEmpty
            else {
                return nil
            }
            let company = object.string(for: "companySlug")
                ?? object.string(for: "company")
                ?? "personal"
            let path: URL
            if let explicitPath = object.string(for: "path") {
                path = URL(fileURLWithPath: explicitPath)
            } else if let workspacePath = workspacePaths[company] {
                path = workspacePath
                    .appendingPathComponent("projects", isDirectory: true)
                    .appendingPathComponent(id, isDirectory: true)
            } else {
                path = URL(fileURLWithPath: "/")
                    .appendingPathComponent("HQ", isDirectory: true)
                    .appendingPathComponent("companies", isDirectory: true)
                    .appendingPathComponent(company, isDirectory: true)
                    .appendingPathComponent("projects", isDirectory: true)
                    .appendingPathComponent(id, isDirectory: true)
            }

            let taskRows = object["tasks"]?.arrayValue
                ?? object["userStories"]?.arrayValue
                ?? []
            return HQProject(
                id: id,
                companySlug: company,
                title: object.string(for: "title")
                    ?? object.string(for: "name")
                    ?? id,
                summary: object.string(for: "summary")
                    ?? object.string(for: "description")
                    ?? "",
                status: object.string(for: "status") ?? "unknown",
                branch: object.string(for: "branch")
                    ?? object.string(for: "branchName"),
                path: path,
                tasks: taskRows.compactMap(decodeTask),
                owner: object.string(for: "owner"),
                livePhase: object.string(for: "livePhase"),
                prdPath: object.string(for: "prdPath"),
                boardPath: object.string(for: "boardPath")
                    ?? "companies/\(company)/board.json"
            )
        }
    }

    private static func decodeTask(_ value: HQJSONValue) -> HQTask? {
        guard let object = value.object,
              let id = object.string(for: "id"),
              !id.isEmpty
        else {
            return nil
        }
        let passes = object["passes"]?.boolValue ?? false
        let rawState = object.string(for: "state")
            ?? (passes ? HQWorkState.complete.rawValue : HQWorkState.notStarted.rawValue)
        let state = HQWorkState(rawValue: rawState) ?? (passes ? .complete : .notStarted)
        return HQTask(
            id: id,
            title: object.string(for: "title") ?? id,
            detail: object.string(for: "detail")
                ?? object.string(for: "description")
                ?? "",
            priority: Int(object["priority"]?.numberValue ?? 0),
            passes: passes,
            acceptanceCriteria: object["acceptanceCriteria"]?.arrayValue?
                .compactMap(\.stringValue) ?? [],
            dependencies: (
                object["dependencies"]?.arrayValue
                    ?? object["dependsOn"]?.arrayValue
                    ?? []
            ).compactMap(\.stringValue),
            state: state
        )
    }

    private static func decodeSessions(_ value: HQJSONValue) -> [HQLiveSession] {
        let rows = value.object?["sessions"]?.arrayValue ?? value.arrayValue ?? []
        return rows.compactMap { row in
            guard let object = row.object,
                  let id = object.string(for: "id"),
                  !id.isEmpty
            else {
                return nil
            }
            return HQLiveSession(
                id: id,
                title: object.string(for: "title")
                    ?? object.string(for: "project")
                    ?? id,
                provider: object.string(for: "provider")
                    ?? object.string(for: "tool")
                    ?? "unknown",
                status: object.string(for: "status") ?? "unknown",
                company: object.string(for: "company"),
                project: object.string(for: "project")
            )
        }
    }

    nonisolated private static func message(for error: Error) -> String {
        if let payload = error as? HQEngineErrorPayload {
            return payload.message
        }
        if let localized = error as? LocalizedError,
           let description = localized.errorDescription
        {
            return description
        }
        return error.localizedDescription
    }

    private static func description(for state: HQLaunchAtLoginState) -> String {
        switch state {
        case .disabled: "disabled"
        case .enabled: "enabled"
        case .requiresApproval: "waiting for approval in System Settings"
        case .unavailable: "unavailable"
        }
    }

    private static func description(
        for authorization: HQPrivacyAuthorization
    ) -> String {
        switch authorization {
        case .notDetermined: "prompt"
        case .restricted: "denied"
        case .denied: "denied"
        case .authorized: "granted"
        case .unknown: "unknown"
        }
    }

    private static func permissionTitle(
        for authorization: HQPrivacyAuthorization
    ) -> String {
        switch authorization {
        case .authorized:
            return "Allowed"
        case .notDetermined:
            return "Ask"
        case .restricted:
            return "Restricted"
        case .denied:
            return "Denied"
        case .unknown:
            return "Unknown"
        }
    }

    private static func permissionSymbol(
        for authorization: HQPrivacyAuthorization
    ) -> String {
        switch authorization {
        case .authorized:
            return "checkmark.shield.fill"
        case .notDetermined:
            return "questionmark.diamond"
        case .restricted, .denied:
            return "exclamationmark.triangle.fill"
        case .unknown:
            return "questionmark.circle"
        }
    }

    private static func systemSettingsTitle(
        for destination: HQSystemSettingsDestination
    ) -> String {
        switch destination {
        case .notifications:
            return "Notifications"
        case .accessibility:
            return "Accessibility"
        case .camera:
            return "Camera"
        case .microphone:
            return "Microphone"
        case .screenRecording:
            return "Screen Recording"
        }
    }

    private static func description(
        for authorization: UNAuthorizationStatus
    ) -> String {
        switch authorization {
        case .notDetermined: "prompt"
        case .denied: "denied"
        case .authorized, .provisional, .ephemeral: "granted"
        @unknown default: "unknown"
        }
    }

    private static func legacyPendingUpdateJSON(
        for state: HQUpdaterState
    ) -> HQJSONValue {
        let update: HQUpdateDescriptor? = switch state {
        case let .available(_, descriptor),
             let .downloading(_, descriptor),
             let .readyToInstall(_, descriptor),
             let .installing(_, descriptor):
            descriptor
        case .idle, .checking, .upToDate, .failed:
            nil
        }

        guard let update else {
            return .null
        }

        return .object([
            "version": .string(update.version),
            "body": .null,
            "date": .null,
        ])
    }

    private static func json(for state: HQUpdaterState) -> HQJSONValue {
        let channel: HQReleaseChannel
        let status: String
        let update: HQUpdateDescriptor?
        let message: String?

        switch state {
        case let .idle(value):
            (channel, status, update, message) = (value, "idle", nil, nil)
        case let .checking(value):
            (channel, status, update, message) = (value, "checking", nil, nil)
        case let .upToDate(value):
            (channel, status, update, message) = (value, "up-to-date", nil, nil)
        case let .available(value, descriptor):
            (channel, status, update, message) = (value, "available", descriptor, nil)
        case let .downloading(value, descriptor):
            (channel, status, update, message) = (value, "downloading", descriptor, nil)
        case let .readyToInstall(value, descriptor):
            (channel, status, update, message) = (value, "ready-to-install", descriptor, nil)
        case let .installing(value, descriptor):
            (channel, status, update, message) = (value, "installing", descriptor, nil)
        case let .failed(value, failure):
            (channel, status, update, message) = (value, "failed", nil, failure)
        }

        return .object([
            "channel": .string(channel.rawValue),
            "status": .string(status),
            "version": update.map { .string($0.version) } ?? .null,
            "displayVersion": update.map { .string($0.displayVersion) } ?? .null,
            "releaseNotesURL": update?.releaseNotesURL.map {
                .string($0.absoluteString)
            } ?? .null,
            "message": message.map(HQJSONValue.string) ?? .null,
        ])
    }
}

extension HQShellFixture {
    static let liveEmpty = HQShellFixture(
        snapshot: .empty,
        messages: [],
        meetings: [],
        packs: [],
        libraryItems: [],
        people: [],
        activity: [],
        files: [],
        deployments: [],
        secrets: []
    )
}

extension HQJSONValue {
    var object: [String: HQJSONValue]? {
        guard case let .object(value) = self else { return nil }
        return value
    }

    var arrayValue: [HQJSONValue]? {
        guard case let .array(value) = self else { return nil }
        return value
    }

    var stringValue: String? {
        guard case let .string(value) = self else { return nil }
        return value
    }

    var boolValue: Bool? {
        guard case let .bool(value) = self else { return nil }
        return value
    }

    var numberValue: Double? {
        guard case let .number(value) = self else { return nil }
        return value
    }

    var displayValue: String? {
        switch self {
        case let .string(value):
            return value
        case let .number(value):
            return value.rounded() == value
                ? String(Int(value))
                : String(value)
        case let .bool(value):
            return value ? "Yes" : "No"
        case .null, .array, .object:
            return nil
        }
    }
}

private extension Dictionary where Key == String, Value == HQJSONValue {
    func string(for key: String) -> String? {
        self[key]?.stringValue
    }

    func bool(for key: String) -> Bool? {
        guard let value = self[key] else { return nil }
        return value.boolValue
    }
}
