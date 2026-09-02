import Combine
import Foundation

enum HQSecondaryWindowKind: String, CaseIterable, Hashable, Sendable {
    case menuBar = "menubar"
    case onboarding
    case signIn = "sign-in"
    case recovery
    case meetings
    case meetingPermissions = "meeting-permissions"
    case directMessageDetail = "dm-detail"
    case shareDetail = "share-detail"
    case messages
    case banner
    case widget
    case activity
    case drift
    case newFiles = "new-files"
    case notificationHistory = "notification-history"
    case settings
}

struct HQWindowActionFixture: Identifiable, Equatable, Sendable {
    let id: String
    let title: String
    let symbolName: String
}

struct HQWindowRowFixture: Identifiable, Equatable, Sendable {
    let id: String
    let title: String
    let detail: String
    let symbolName: String
    let value: String?
    let metadata: [String: HQJSONValue]

    init(
        id: String,
        title: String,
        detail: String,
        symbolName: String,
        value: String? = nil,
        metadata: [String: HQJSONValue] = [:]
    ) {
        self.id = id
        self.title = title
        self.detail = detail
        self.symbolName = symbolName
        self.value = value
        self.metadata = metadata
    }
}

struct HQWindowFixture: Equatable, Sendable {
    let kind: HQSecondaryWindowKind
    let title: String
    let subtitle: String
    let symbolName: String
    let accessibilityIdentifier: String
    let rows: [HQWindowRowFixture]
    let primaryAction: HQWindowActionFixture?
    let secondaryAction: HQWindowActionFixture?
}

struct HQWindowEmptyState: Equatable, Sendable {
    let title: String
    let message: String
}

struct HQWindowFailureState: Equatable, Sendable {
    let message: String
    let retryTitle: String
}

enum HQWindowContentState: Equatable, Sendable {
    case loading
    case content(HQWindowFixture)
    case empty(HQWindowEmptyState)
    case failure(HQWindowFailureState)
}

@MainActor
final class HQSecondaryWindowViewModel: ObservableObject {
    let kind: HQSecondaryWindowKind
    @Published private(set) var state: HQWindowContentState

    init(kind: HQSecondaryWindowKind, state: HQWindowContentState = .loading) {
        self.kind = kind
        self.state = state
    }

    func presentFixture() {
        state = .content(HQSecondaryWindowFixtures.fixture(for: kind))
    }

    func presentEmpty(title: String, message: String) {
        state = .empty(HQWindowEmptyState(title: title, message: message))
    }

    func presentFailure(message: String, retryTitle: String = "Try Again") {
        state = .failure(HQWindowFailureState(message: message, retryTitle: retryTitle))
    }

    func beginLoading() {
        state = .loading
    }
}

enum HQSecondaryWindowFixtures {
    static func fixture(for kind: HQSecondaryWindowKind) -> HQWindowFixture {
        switch kind {
        case .menuBar:
            return make(
                kind,
                title: "HQ",
                subtitle: "Everything is synced",
                symbol: "checkmark.circle",
                rows: [
                    row("sync", "Sync status", "Up to date just now", "arrow.triangle.2.circlepath", "Current"),
                    row("inbox", "Inbox", "Three updates need your attention", "tray", "3"),
                    row("meetings", "Meetings", "Standup starts in 18 minutes", "video", "10:30"),
                    row("settings", "Settings", "Open native HQ preferences.", "gearshape"),
                    row("check-updates", "Check for Updates", "Use the signed Sparkle update feed.", "arrow.down.circle"),
                    row("sign-out", "Sign Out", "End this HQ session on this Mac.", "rectangle.portrait.and.arrow.right"),
                ],
                primary: action("open", "Open HQ", "macwindow"),
                secondary: action("sync-now", "Sync Now", "arrow.clockwise")
            )
        case .onboarding:
            return make(
                kind,
                title: "Set up HQ",
                subtitle: "A private workspace for your team and agents.",
                symbol: "sparkles",
                rows: [
                    row("identity", "Sign in", "Use your HQ identity to connect this Mac.", "person.crop.circle.badge.checkmark", "Done"),
                    row("workspace", "Choose workspace", "Keep HQ in a folder you control.", "folder", "Done"),
                    row("permissions", "Grant permissions", "Enable only the macOS capabilities you want.", "hand.raised", "Next"),
                    row("sync", "First sync", "Download the shared context you can access.", "icloud.and.arrow.down"),
                ],
                primary: action("continue", "Continue", "arrow.right"),
                secondary: action("learn", "Learn More", "questionmark.circle")
            )
        case .signIn:
            return make(
                kind,
                title: "Sign in to HQ",
                subtitle: "Your browser will open for secure authentication.",
                symbol: "person.crop.circle",
                rows: [
                    row("browser", "Browser sign-in", "HQ never asks you to paste a password into the app.", "safari"),
                    row("machine", "This Mac", "Corey's MacBook Pro", "laptopcomputer"),
                ],
                primary: action("sign-in", "Continue in Browser", "arrow.up.forward.app"),
                secondary: action("cancel", "Not Now", "xmark")
            )
        case .recovery:
            return make(
                kind,
                title: "HQ Recovery",
                subtitle: "Repair the local runtime without losing your workspace.",
                symbol: "cross.case",
                rows: [
                    row("diagnostics", "Diagnostics", "The recovery sequence checks the app, helper, identity, and workspace.", "stethoscope"),
                    row("repair", "Repair stages", "The recovery sequence restores signed components and reconnects services.", "wrench.and.screwdriver"),
                    row("logs", "Recovery log", "The last repair completed two days ago.", "doc.text.magnifyingglass"),
                ],
                primary: action("repair", "Run Recovery", "cross.case.fill"),
                secondary: action("export", "Open Activity Log", "clock.arrow.circlepath")
            )
        case .meetings:
            return make(
                kind,
                title: "HQ Meetings",
                subtitle: "Capture context only when you choose.",
                symbol: "video",
                rows: [
                    HQWindowRowFixture(
                        id: "standup",
                        title: "Product standup",
                        detail: "Detected now · Zoom",
                        symbolName: "person.3",
                        value: "Detected",
                        metadata: [
                            "windowId": .string("fixture-zoom-window"),
                            "state": .string("detected"),
                            "companyUid": .string("indigo"),
                            "focused": .bool(true),
                            "memberships": .array([
                                .object([
                                    "companyUid": .string("indigo"),
                                    "companyName": .string("Indigo"),
                                    "status": .string("active"),
                                ]),
                            ]),
                        ]
                    ),
                    row("client", "Indigo × Acme", "Today · Google Meet", "briefcase", "2:00"),
                    row("last", "Growth review", "Notes and 7 action items are ready.", "checkmark.bubble", "Ready"),
                ],
                primary: action("start", "Start Capture", "record.circle"),
                secondary: action("history", "Meeting History", "clock")
            )
        case .meetingPermissions:
            return make(
                kind,
                title: "Meeting Permissions",
                subtitle: "macOS keeps every capture permission under your control.",
                symbol: "lock.shield",
                rows: [
                    row("microphone", "Microphone", "Capture meeting audio when recording is on.", "mic", "Allowed"),
                    row("screen", "Screen Recording", "Detect supported meeting windows.", "rectangle.on.rectangle", "Allowed"),
                    row("camera", "Camera", "Optional participant-presence detection.", "camera", "Off"),
                    row("calendar", "Calendar", "Match captures to scheduled meetings.", "calendar", "Allowed"),
                ],
                primary: action("open-settings", "Open System Settings", "gearshape"),
                secondary: action("check", "Check Again", "arrow.clockwise")
            )
        case .directMessageDetail:
            return make(
                kind,
                title: "Conversation",
                subtitle: "Caitlin · Active now",
                symbol: "message",
                rows: [
                    row("message-1", "Caitlin", "The native preview is ready for a final visual pass.", "person.crop.circle", "12:04"),
                    row("message-2", "You", "Perfect. I’ll check the meeting and widget states too.", "person.crop.circle.fill", "12:06"),
                    row("message-3", "Caitlin", "I attached the acceptance checklist.", "paperclip", "12:08"),
                ],
                primary: action("reply", "Reply", "arrowshape.turn.up.left"),
                secondary: action("open", "Open in Messages", "arrow.up.right.square")
            )
        case .shareDetail:
            return make(
                kind,
                title: "Shared with you",
                subtitle: "A secure HQ file share from Jacob.",
                symbol: "person.2.wave.2",
                rows: [
                    row("file", "Native app visual brief.pdf", "2.4 MB · PDF document", "doc.richtext"),
                    row("sender", "Jacob Posel", "Indigo · Shared 11 minutes ago", "person.crop.circle"),
                    row("access", "Single-use access", "This share expires after download.", "lock", "Protected"),
                ],
                primary: action("open-inbox", "Open Inbox", "tray"),
                secondary: nil
            )
        case .messages:
            return make(
                kind,
                title: "Messages",
                subtitle: "Direct messages, channels, requests, groups, threads, and reactions.",
                symbol: "bubble.left.and.bubble.right",
                rows: HQMessagesFixture.preview.sections.flatMap(\.rows).prefix(6).map {
                    row($0.id, $0.title, $0.preview, "bubble.left", $0.unreadCount > 0 ? "\($0.unreadCount)" : nil)
                },
                primary: action("requests", "Open Inbox", "tray.full"),
                secondary: nil
            )
        case .banner:
            return make(
                kind,
                title: "HQ Notification",
                subtitle: "Native banners stay concise and actionable.",
                symbol: "bell",
                rows: HQBannerFixture.all.map {
                    row($0.kind.rawValue, $0.title, $0.message, $0.symbolName)
                },
                primary: action("open", "Open", "arrow.up.right.square"),
                secondary: action("dismiss", "Dismiss", "xmark")
            )
        case .widget:
            return make(
                kind,
                title: "HQ Widget",
                subtitle: "A glanceable view of sync, inbox, meetings, and activity.",
                symbol: "square.grid.2x2",
                rows: HQWidgetFixture.preview(for: .expanded).recentItems,
                primary: action("open", "Open HQ", "macwindow"),
                secondary: action("customize", "Customize", "slider.horizontal.3")
            )
        case .activity:
            return make(
                kind,
                title: "Recent Changes",
                subtitle: "The latest workspace activity across this Mac.",
                symbol: "clock.arrow.circlepath",
                rows: [
                    row("knowledge", "Knowledge updated", "indigo/knowledge/engineering/native-macos.md", "doc.text", "Now"),
                    row("project", "Project advanced", "Native macOS · 4 of 12 stories complete", "list.bullet.rectangle", "4m"),
                    row("sync", "Sync completed", "28 additions · 3 updates", "arrow.triangle.2.circlepath", "9m"),
                    row("message", "New message", "Caitlin replied in #native-app", "bubble.left", "12m"),
                ],
                primary: action("open", "Open HQ Home", "house"),
                secondary: action("refresh", "Refresh", "arrow.clockwise")
            )
        case .drift:
            return make(
                kind,
                title: "HQ Core Changes",
                subtitle: "Review local core drift before the next update.",
                symbol: "arrow.triangle.branch",
                rows: [
                    row("modified", "3 modified files", "Local edits differ from signed HQ Core.", "pencil.and.outline", "Review"),
                    row("added", "1 untracked file", "A local helper is outside the release bundle.", "plus.rectangle.on.folder", "New"),
                    row("update", "Core 12.4.0 available", "Update after reviewing or preserving changes.", "arrow.down.circle", "Ready"),
                ],
                primary: action("review", "Review Files", "doc.text.magnifyingglass"),
                secondary: action("preserve", "Reveal Workspace", "folder")
            )
        case .newFiles:
            return make(
                kind,
                title: "New Files",
                subtitle: "Native rendering closes the legacy no-renderer gap.",
                symbol: "doc.badge.plus",
                rows: [
                    row("brief", "native-window-brief.md", "companies/indigo/knowledge/engineering", "doc.text", "12 KB"),
                    row("mock", "widget-expanded.png", "workspace/reports/native-macos", "photo", "884 KB"),
                    row("plan", "acceptance-checklist.md", "companies/indigo/projects/native-macos", "checklist", "8 KB"),
                ],
                primary: action("review-files", "Review Files", "doc.text.magnifyingglass"),
                secondary: action("reveal", "Reveal in Finder", "folder")
            )
        case .notificationHistory:
            return make(
                kind,
                title: "Notifications",
                subtitle: "A searchable history of important HQ updates.",
                symbol: "bell.badge",
                rows: [
                    row("dm", "New direct message", "Caitlin: The native preview is ready.", "message", "Now"),
                    row("meeting", "Meeting notes ready", "Product standup · 7 action items", "video", "18m"),
                    row("sync", "Sync completed", "28 additions · 3 updates", "checkmark.circle", "1h"),
                    row("update", "HQ update available", "Version 12.4.0 is ready to install.", "arrow.down.circle", "2h"),
                ],
                primary: action("mark-read", "Mark All Read", "checkmark.circle"),
                secondary: action("settings", "Notification Settings", "gearshape")
            )
        case .settings:
            return make(
                kind,
                title: "HQ Settings",
                subtitle: "Native preferences for sync, notifications, widgets, meetings, and updates.",
                symbol: "gearshape",
                rows: [
                    row("general", "General", "Launch, appearance, and workspace location.", "switch.2"),
                    row("sync", "Sync", "Automatic sync and bandwidth preferences.", "arrow.triangle.2.circlepath"),
                    row("notifications", "Notifications", "Banners, sounds, and history.", "bell"),
                    row("widget", "Widget", "Compact or expanded menu-bar presence.", "square.grid.2x2"),
                    row("meetings", "Meetings", "Detection, capture, and privacy controls.", "video"),
                    row("updates", "Updates", "Signed automatic updates and release channel.", "arrow.down.circle"),
                ],
                primary: action("done", "Done", "checkmark"),
                secondary: action("defaults", "Restore Defaults", "arrow.counterclockwise")
            )
        }
    }

    private static func make(
        _ kind: HQSecondaryWindowKind,
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

    private static func row(
        _ id: String,
        _ title: String,
        _ detail: String,
        _ symbol: String,
        _ value: String? = nil
    ) -> HQWindowRowFixture {
        HQWindowRowFixture(
            id: id,
            title: title,
            detail: detail,
            symbolName: symbol,
            value: value
        )
    }

    private static func action(
        _ id: String,
        _ title: String,
        _ symbol: String
    ) -> HQWindowActionFixture {
        HQWindowActionFixture(id: id, title: title, symbolName: symbol)
    }
}

enum HQMessageSectionKind: String, CaseIterable, Equatable, Sendable {
    case directMessages = "direct-messages"
    case channels
    case requests
    case groups
    case threads
    case reactions

    var title: String {
        switch self {
        case .directMessages: "Direct Messages"
        case .channels: "Channels"
        case .requests: "Requests"
        case .groups: "Groups"
        case .threads: "Threads"
        case .reactions: "Reactions"
        }
    }
}

struct HQMessageListRowFixture: Identifiable, Equatable, Sendable {
    let id: String
    let title: String
    let preview: String
    let timestamp: String
    let unreadCount: Int
    let isMuted: Bool
}

struct HQMessageSectionFixture: Identifiable, Equatable, Sendable {
    var id: HQMessageSectionKind { kind }
    let kind: HQMessageSectionKind
    let rows: [HQMessageListRowFixture]
}

struct HQMessageReactionFixture: Identifiable, Equatable, Sendable {
    var id: String { emoji }
    let emoji: String
    let count: Int
    let reactedByCurrentUser: Bool
}

struct HQMessageBubbleFixture: Identifiable, Equatable, Sendable {
    let id: String
    let author: String
    let body: String
    let timestamp: String
    let isCurrentUser: Bool
    let reactions: [HQMessageReactionFixture]
}

struct HQMessageThreadFixture: Equatable, Sendable {
    let title: String
    let replyCount: Int
    let messages: [HQMessageBubbleFixture]
}

struct HQConversationFixture: Equatable, Sendable {
    let title: String
    let subtitle: String
    let messages: [HQMessageBubbleFixture]
    let thread: HQMessageThreadFixture?
}

struct HQMessagesFixture: Equatable, Sendable {
    let sections: [HQMessageSectionFixture]
    let selectedSection: HQMessageSectionKind
    let selectedRowID: String
    let selectionIsReady: Bool
    let selectedConversation: HQConversationFixture

    static let preview = HQMessagesFixture(
        sections: [
            section(
                .directMessages,
                rows: [
                    messageRow("caitlin", "Caitlin", "The native preview is ready.", "Now", 2),
                    messageRow("jacob", "Jacob", "Shared a visual brief.", "14m", 0),
                ]
            ),
            section(
                .channels,
                rows: [
                    messageRow("native-app", "# native-app", "Corey: Windows are fully native.", "8m", 4),
                    messageRow("hq-liveops", "# hq-liveops", "Fleet status is healthy.", "32m", 0, true),
                ]
            ),
            section(
                .requests,
                rows: [
                    messageRow("request-1", "Stefan", "Wants to start a conversation.", "1h", 1),
                ]
            ),
            section(
                .groups,
                rows: [
                    messageRow("design", "Native design crew", "3 people · Last active now", "Now", 0),
                ]
            ),
            section(
                .threads,
                rows: [
                    messageRow("thread", "Liquid Glass review", "6 replies · Caitlin replied", "5m", 1),
                ]
            ),
            section(
                .reactions,
                rows: [
                    messageRow("reaction", "Mentioned by Jacob", "“This interaction feels right.”", "18m", 1),
                ]
            ),
        ],
        selectedSection: .channels,
        selectedRowID: "native-app",
        selectionIsReady: true,
        selectedConversation: HQConversationFixture(
            title: "# native-app",
            subtitle: "8 members · 3 active",
            messages: [
                HQMessageBubbleFixture(
                    id: "m1",
                    author: "Caitlin",
                    body: "The native preview is ready for a final visual pass.",
                    timestamp: "12:04",
                    isCurrentUser: false,
                    reactions: [
                        HQMessageReactionFixture(emoji: "✨", count: 3, reactedByCurrentUser: true),
                        HQMessageReactionFixture(emoji: "👍", count: 2, reactedByCurrentUser: false),
                    ]
                ),
                HQMessageBubbleFixture(
                    id: "m2",
                    author: "You",
                    body: "Perfect. I’m checking every secondary surface and state.",
                    timestamp: "12:06",
                    isCurrentUser: true,
                    reactions: []
                ),
                HQMessageBubbleFixture(
                    id: "m3",
                    author: "Jacob",
                    body: "I added the acceptance checklist in the thread.",
                    timestamp: "12:08",
                    isCurrentUser: false,
                    reactions: [
                        HQMessageReactionFixture(emoji: "✅", count: 4, reactedByCurrentUser: false),
                    ]
                ),
            ],
            thread: HQMessageThreadFixture(
                title: "Liquid Glass review",
                replyCount: 2,
                messages: [
                    HQMessageBubbleFixture(
                        id: "t1",
                        author: "Caitlin",
                        body: "Keep the controls native and the palette monochrome.",
                        timestamp: "12:09",
                        isCurrentUser: false,
                        reactions: []
                    ),
                    HQMessageBubbleFixture(
                        id: "t2",
                        author: "You",
                        body: "Done. Materials are standard until the shared helper lands.",
                        timestamp: "12:10",
                        isCurrentUser: true,
                        reactions: []
                    ),
                ]
            )
        )
    )

    private static func section(
        _ kind: HQMessageSectionKind,
        rows: [HQMessageListRowFixture]
    ) -> HQMessageSectionFixture {
        HQMessageSectionFixture(kind: kind, rows: rows)
    }

    private static func messageRow(
        _ id: String,
        _ title: String,
        _ preview: String,
        _ timestamp: String,
        _ unreadCount: Int,
        _ isMuted: Bool = false
    ) -> HQMessageListRowFixture {
        HQMessageListRowFixture(
            id: id,
            title: title,
            preview: preview,
            timestamp: timestamp,
            unreadCount: unreadCount,
            isMuted: isMuted
        )
    }
}

enum HQBannerKind: String, CaseIterable, Equatable, Sendable {
    case syncComplete = "sync-complete"
    case meetingReady = "meeting-ready"
    case directMessage = "direct-message"
    case updateAvailable = "update-available"
}

struct HQBannerFixture: Identifiable, Equatable, Sendable {
    var id: HQBannerKind { kind }
    let kind: HQBannerKind
    let title: String
    let message: String
    let symbolName: String
    let actionTitle: String

    static let all: [HQBannerFixture] = [
        HQBannerFixture(
            kind: .syncComplete,
            title: "Sync complete",
            message: "28 additions and 3 updates are ready.",
            symbolName: "checkmark.circle",
            actionTitle: "View Changes"
        ),
        HQBannerFixture(
            kind: .meetingReady,
            title: "Meeting notes ready",
            message: "Product standup has 7 action items.",
            symbolName: "video",
            actionTitle: "Open Notes"
        ),
        HQBannerFixture(
            kind: .directMessage,
            title: "New message from Caitlin",
            message: "The native preview is ready.",
            symbolName: "message",
            actionTitle: "Reply"
        ),
        HQBannerFixture(
            kind: .updateAvailable,
            title: "HQ update available",
            message: "Version 12.4.0 is signed and ready.",
            symbolName: "arrow.down.circle",
            actionTitle: "Review Update"
        ),
    ]
}

enum HQWidgetMode: String, CaseIterable, Equatable, Sendable {
    case compact
    case expanded
}

struct HQWidgetActivityFixture: Identifiable, Equatable, Sendable {
    let id: String
    let title: String
    let timestamp: String
}

struct HQWidgetFixture: Equatable, Sendable {
    let mode: HQWidgetMode
    let headline: String
    let status: String
    let recentItems: [HQWindowRowFixture]
    let activity: [HQWidgetActivityFixture]

    static func preview(for mode: HQWidgetMode) -> HQWidgetFixture {
        let items = [
            HQWindowRowFixture(
                id: "inbox",
                title: "Inbox",
                detail: "Updates needing attention",
                symbolName: "tray",
                value: "3"
            ),
            HQWindowRowFixture(
                id: "meeting",
                title: "Next meeting",
                detail: "Product standup",
                symbolName: "video",
                value: "18m"
            ),
            HQWindowRowFixture(
                id: "projects",
                title: "Active projects",
                detail: "Across Indigo",
                symbolName: "square.stack.3d.up",
                value: "6"
            ),
            HQWindowRowFixture(
                id: "sync",
                title: "Last sync",
                detail: "Everything is current",
                symbolName: "checkmark.circle",
                value: "Now"
            ),
        ]

        switch mode {
        case .compact:
            return HQWidgetFixture(
                mode: .compact,
                headline: "HQ is current",
                status: "Synced just now",
                recentItems: Array(items.prefix(2)),
                activity: []
            )
        case .expanded:
            return HQWidgetFixture(
                mode: .expanded,
                headline: "Good afternoon, Corey",
                status: "HQ is current",
                recentItems: items,
                activity: [
                    HQWidgetActivityFixture(id: "a1", title: "Native window brief updated", timestamp: "Now"),
                    HQWidgetActivityFixture(id: "a2", title: "Caitlin replied in #native-app", timestamp: "8m"),
                    HQWidgetActivityFixture(id: "a3", title: "Product standup notes ready", timestamp: "18m"),
                ]
            )
        }
    }
}
