import XCTest
@testable import HQNative

/// Compile-time snapshot of `Parity/events.json`. Keeping this at file scope
/// makes the immutable value safely available to non-main-actor source-gate
/// tests without crossing the `@MainActor` XCTest boundary.
let retainedNativeParityLedgerEventNames: Set<String> = [
    "activity:append",
    "activity:list",
    "auth:reauth-required",
    "banner:event",
    "channel:new-message",
    "channel:updated",
    "content:progress",
    "core-state:changed",
    "desktop:navigate",
    "dm:detail-event",
    "dm:inbox-open",
    "dm:new-events",
    "dm:request-new",
    "dm:request-update",
    "dm:unread-summary",
    "drift:report",
    "hq-cli-update:available",
    "hq-cli-update:cleared",
    "install:progress",
    "marketplace:install-complete",
    "marketplace:install-error",
    "marketplace:install-progress",
    "marketplace:publish-progress",
    "meeting:closed",
    "meeting:detected",
    "meetings-window:action",
    "meetings-window:request-snapshot",
    "meetings:focus-meeting",
    "message:reaction",
    "messages:open-conversation",
    "notification:banner-action",
    "notification:dm-action",
    "notification:meeting-action",
    "notification:share-action",
    "pack-update:available",
    "pack-update:cleared",
    "packages:complete",
    "packages:error",
    "packages:progress",
    "packages:updates",
    "popover:meetings-snapshot",
    "popover:opened",
    "recording:ended",
    "recording:error",
    "recording:started",
    "share:events-list",
    "sync:auth-error",
    "sync:complete",
    "sync:conflict",
    "sync:error",
    "sync:external-idle",
    "sync:external-progress",
    "sync:fanout-plan",
    "sync:personal-first-push-complete",
    "sync:personal-first-push-progress",
    "sync:personal-first-push-scan",
    "sync:plan",
    "sync:progress",
    "sync:setup-needed",
    "sync:totals",
    "thread:new-reply",
    "tray:check-for-updates",
    "tray:open-desktop",
    "tray:open-settings",
    "tray:sign-out",
    "tray:sync-now",
    "update:available",
    "widget:click-away",
    "widget:notification",
    "widget:occlusion",
]

@MainActor
final class HQNativeEventParityTests: XCTestCase {
    func testEveryRetainedGapHasAnEventSpecificDecoderAndReducer() throws {
        let fixtures = Self.fixtures
        XCTAssertEqual(HQNativeParityEventName.allCases.count, 49)
        XCTAssertEqual(
            Set(fixtures.keys),
            Set(HQNativeParityEventName.allCases)
        )

        let consumer = HQNativeParityEventConsumer()
        var sequence: UInt64 = 0
        for name in HQNativeParityEventName.allCases {
            sequence += 1
            let result = consumer.consume(
                HQEngineEvent(
                    requestID: "parity-\(sequence)",
                    name: name.rawValue,
                    sequence: sequence,
                    data: try XCTUnwrap(fixtures[name])
                )
            )
            guard case .success = result else {
                return XCTFail("\(name.rawValue) did not decode: \(result)")
            }
        }

        XCTAssertEqual(consumer.history.count, 49)
        XCTAssertEqual(consumer.latest.count, 49)
        XCTAssertEqual(
            Set(consumer.history.map(\.name)),
            Set(HQNativeParityEventName.allCases)
        )
    }

    func testEveryRetainedGapRejectsWrongTypedPayloads() {
        for (offset, name) in HQNativeParityEventName.allCases.enumerated() {
            let consumer = HQNativeParityEventConsumer()
            let result = consumer.consume(
                HQEngineEvent(
                    requestID: nil,
                    name: name.rawValue,
                    sequence: UInt64(offset + 1),
                    data: .bool(false)
                )
            )
            guard case let .failure(error) = result else {
                XCTFail("\(name.rawValue) accepted an invalid boolean payload")
                continue
            }
            XCTAssertEqual(error.eventName, name.rawValue)
            XCTAssertTrue(consumer.history.isEmpty)
            XCTAssertTrue(consumer.latest.isEmpty)
        }
    }

    func testStrictConsumerNamesExactlyCoverGeneratedLedgerSnapshot() {
        let strictConsumers = Set(
            HQNativeParityEventName.allCases.map(\.rawValue)
                + HQNativeEvent.allCases.map(\.rawValue)
                + HQRecallEventName.allCases.map(\.rawValue)
                + HQCloudRealtimeEventName.allCases.map(\.rawValue)
                + HQActivityEventName.allCases.map(\.rawValue)
                + [HQDMRequestUpdateRecord.eventName]
        )
        XCTAssertEqual(retainedNativeParityLedgerEventNames.count, 70)
        XCTAssertEqual(
            strictConsumers.intersection(retainedNativeParityLedgerEventNames),
            retainedNativeParityLedgerEventNames
        )
        XCTAssertEqual(
            strictConsumers.subtracting(retainedNativeParityLedgerEventNames),
            [
                "permission:status",
                "permissions:all-granted",
                "recording:media-capture",
            ]
        )
    }

    func testDirectSwiftSourcesAndRetiredBoundaryAreExact() {
        let expectedDirectNames: Set<HQNativeParityEventName> = [
            .desktopNavigate,
            .dmDetailEvent,
            .dmInboxOpen,
            .meetingsWindowAction,
            .meetingsWindowRequestSnapshot,
            .meetingsFocusMeeting,
            .messagesOpenConversation,
            .notificationBannerAction,
            .notificationDMAction,
            .notificationMeetingAction,
            .notificationShareAction,
            .popoverMeetingsSnapshot,
            .popoverOpened,
            .trayCheckForUpdates,
            .trayOpenDesktop,
            .trayOpenSettings,
            .traySignOut,
            .traySyncNow,
            .updateAvailable,
        ]

        XCTAssertEqual(
            HQNativeParitySourceRegistry.directSwiftNames,
            expectedDirectNames
        )
        XCTAssertEqual(
            HQNativeParitySourceRegistry.directSwiftReplacements.count,
            19
        )
        XCTAssertTrue(
            HQNativeParitySourceRegistry.directSwiftReplacements.allSatisfy {
                $0.disposition == .directSwiftReplacement
                    && !$0.nativeSource.isEmpty
                    && !$0.observableEffect.isEmpty
            }
        )
        XCTAssertEqual(
            HQNativeParitySourceRegistry.retiredNames,
            [.syncConflict]
        )
        XCTAssertEqual(
            HQNativeParitySourceRegistry.retiredCompatibility.count,
            1
        )
        XCTAssertTrue(
            HQNativeParitySourceRegistry.directSwiftNames.isDisjoint(
                with: HQNativeParitySourceRegistry.retiredNames
            )
        )
    }

    func testSyncReducersPreserveProgressConflictAndTerminalState() throws {
        let consumer = HQNativeParityEventConsumer()
        let sequence: [(HQNativeParityEventName, UInt64)] = [
            (.syncTotals, 1),
            (.syncFanoutPlan, 2),
            (.syncPlan, 3),
            (.syncProgress, 4),
            (.syncConflict, 5),
            (.syncComplete, 6),
        ]

        for (name, eventSequence) in sequence {
            let result = consumer.consume(
                HQEngineEvent(
                    requestID: "sync",
                    name: name.rawValue,
                    sequence: eventSequence,
                    data: try XCTUnwrap(Self.fixtures[name])
                )
            )
            guard case .success = result else {
                return XCTFail("\(name.rawValue) did not reduce")
            }
        }

        XCTAssertEqual(consumer.sync.totalFiles, 4)
        XCTAssertEqual(consumer.sync.companies.map(\.slug), ["indigo"])
        XCTAssertEqual(consumer.sync.plans.count, 1)
        XCTAssertEqual(consumer.sync.lastProgress?.path, "knowledge/a.md")
        XCTAssertEqual(
            consumer.sync.conflictsByPath["knowledge/conflict.md"]?
                .canAutoResolve,
            false
        )
        XCTAssertEqual(consumer.sync.phase, .conflict)
        XCTAssertEqual(
            consumer.sync.completedByCompany["indigo"]?.conflicts,
            1
        )
    }

    func testNotificationAndDeepLinkReducersProduceNativeEffects() throws {
        let consumer = HQNativeParityEventConsumer()

        let navigation = consumer.consume(
            event(.desktopNavigate, sequence: 1)
        )
        XCTAssertEqual(navigation, .success(.navigate(route: "settings:sync")))

        let conversation = consumer.consume(
            event(.messagesOpenConversation, sequence: 2)
        )
        XCTAssertEqual(
            conversation,
            .success(
                .openScene(
                    id: "messages",
                    message: "Opened the selected conversation."
                )
            )
        )
        XCTAssertEqual(consumer.conversationTarget?.email, "friend@example.com")

        let directConversation = consumer.openConversation(
            HQNativeConversationTarget(
                personUID: "",
                email: "legacy@example.com",
                displayName: "Legacy"
            )
        )
        XCTAssertEqual(
            directConversation,
            .openScene(
                id: "messages",
                message: "Opened the selected conversation."
            )
        )
        XCTAssertEqual(
            consumer.conversationTarget?.email,
            "legacy@example.com"
        )

        XCTAssertEqual(
            consumer.consume(event(.notificationDMAction, sequence: 3)),
            .success(
                .openScene(
                    id: HQSecondaryWindowKind.directMessageDetail.rawValue,
                    message: "Opened the selected conversation."
                )
            )
        )
        XCTAssertEqual(consumer.dmDetailMessage?.eventID, "dm-1")
        XCTAssertEqual(
            consumer.consume(event(.notificationShareAction, sequence: 4)),
            .success(
                .openScene(
                    id: HQSecondaryWindowKind.shareDetail.rawValue,
                    message: "Opened the secure share."
                )
            )
        )
        XCTAssertEqual(consumer.selectedShare?.eventID, "share-1")

        let notification = consumer.consume(
            event(.notificationMeetingAction, sequence: 5)
        )
        guard case let .success(.notificationMeeting(action)) = notification else {
            return XCTFail("Meeting notification action was not typed")
        }
        XCTAssertEqual(action.operation, .record)
        XCTAssertEqual(action.windowID, "window-1")

        let popover = consumer.consume(
            event(.popoverOpened, sequence: 6)
        )
        XCTAssertEqual(
            popover,
            .success(.none(message: "Menu bar state refreshed."))
        )
        XCTAssertEqual(consumer.popoverOpenGeneration, 1)
    }

    private func event(
        _ name: HQNativeParityEventName,
        sequence: UInt64
    ) -> HQEngineEvent {
        HQEngineEvent(
            requestID: nil,
            name: name.rawValue,
            sequence: sequence,
            data: Self.fixtures[name]!
        )
    }

    private static let driftEntry: HQJSONValue = .object([
        "path": .string("core/policies/example.md"),
        "size": .number(12),
        "gitShaLocal": .string("local"),
        "gitShaUpstream": .string("remote"),
    ])

    private static let driftReport: HQJSONValue = .object([
        "count": .number(1),
        "modified": .array([driftEntry]),
        "missing": .array([]),
        "added": .array([]),
        "scannedAt": .string("2026-07-26T00:00:00Z"),
        "hqVersion": .string("14.2.1"),
        "targetRepo": .string("indigoai-us/hq-core"),
        "targetRef": .string("v14.2.1"),
    ])

    private static let dm: HQJSONValue = .object([
        "eventId": .string("dm-1"),
        "fromPersonUid": .string("person-1"),
        "fromEmail": .string("friend@example.com"),
        "fromDisplayName": .string("Friend"),
        "body": .string("Native parity is ready."),
        "details": .string("Open the complete message."),
        "prompt": .string("Review the native parity work."),
        "createdAt": .string("2026-07-26T00:00:00Z"),
    ])

    private static let share: HQJSONValue = .object([
        "eventId": .string("share-1"),
        "issuerEmail": .string("friend@example.com"),
        "issuerDisplayName": .string("Friend"),
        "paths": .array([.string("knowledge/brief.md")]),
        "note": .string("Please review."),
        "permission": .string("read"),
        "createdAt": .string("2026-07-26T00:00:00Z"),
    ])

    private static let fixtures: [
        HQNativeParityEventName: HQJSONValue?
    ] = [
        .contentProgress: .object([
            "handle": .string("content-1"),
            "phase": .string("download"),
            "receivedBytes": .number(50),
            "totalBytes": .number(100),
            "percent": .number(50),
            "slow": .bool(false),
            "stalled": .bool(false),
            "message": .string("Downloading HQ template"),
        ]),
        .coreStateChanged: .object([
            "channel": .string("release"),
            "targetRepo": .string("indigoai-us/hq-core"),
            "targetVersion": .string("14.2.1"),
            "targetRef": .string("v14.2.1"),
            "localVersion": .string("14.2.0"),
            "floorSha": .string("floor"),
            "isEligible": .bool(true),
            "versionBehind": .bool(true),
            "driftReport": driftReport,
            "unchangedCount": .number(20),
            "userOnlyCount": .number(0),
            "scannedAt": .string("2026-07-26T00:00:00Z"),
        ]),
        .desktopNavigate: .string("settings:sync"),
        .dmDetailEvent: dm,
        .dmInboxOpen: nil,
        .driftReport: driftReport,
        .hqCLIUpdateAvailable: .object([
            "local": .string("5.0.0"),
            "latest": .string("5.1.0"),
        ]),
        .hqCLIUpdateCleared: .object([
            "local": .string("5.1.0"),
            "latest": .string("5.1.0"),
        ]),
        .installProgress: .object([
            "handle": .string("install-1"),
            "line": .string("Installing dependencies"),
            "finished": .bool(false),
            "error": .null,
        ]),
        .marketplaceInstallComplete: .object([
            "source": .string("hq-pack-example"),
            "scope": .string("personal"),
        ]),
        .marketplaceInstallError: .object([
            "source": .string("hq-pack-example"),
            "scope": .string("personal"),
            "message": .string("Install failed"),
        ]),
        .marketplaceInstallProgress: .object([
            "source": .string("hq-pack-example"),
            "scope": .string("personal"),
            "line": .string("Installing pack"),
        ]),
        .marketplacePublishProgress: .object([
            "stream": .string("stdout"),
            "line": .string("Publishing pack"),
        ]),
        .meetingsWindowAction: .object([
            "action": .string("change-company"),
            "windowId": .string("window-1"),
            "companyUid": .string("company-1"),
        ]),
        .meetingsWindowRequestSnapshot: nil,
        .meetingsFocusMeeting: .object([
            "meetingId": .string("meeting-1"),
        ]),
        .messagesOpenConversation: .object([
            "personUid": .string("person-1"),
            "email": .string("friend@example.com"),
            "displayName": .string("Friend"),
        ]),
        .notificationBannerAction: .object([
            "kind": .string("update"),
            "action": .string("open"),
            "data": .object(["version": .string("0.11.0")]),
        ]),
        .notificationDMAction: .object([
            "action": .string("open"),
            "event": dm,
        ]),
        .notificationMeetingAction: .object([
            "action": .string("record"),
            "windowId": .string("window-1"),
            "platform": .string("zoom"),
            "meetingId": .null,
        ]),
        .notificationShareAction: .object([
            "action": .string("open"),
            "event": share,
        ]),
        .packUpdateAvailable: .object([
            "count": .number(2),
            "names": .array([
                .string("hq-pack-alpha"),
                .string("hq-pack-beta"),
            ]),
        ]),
        .packUpdateCleared: nil,
        .packagesComplete: .object([
            "op": .string("update"),
            "name": .string("hq-pack-alpha"),
        ]),
        .packagesError: .object([
            "op": .string("install"),
            "name": .string("hq-pack-alpha"),
            "message": .string("Package install failed"),
        ]),
        .packagesProgress: .object([
            "op": .string("install"),
            "name": .string("hq-pack-alpha"),
            "line": .string("Installing package"),
        ]),
        .packagesUpdates: .object([
            "packs": .object([
                "installed": .array([]),
                "available": .array([]),
            ]),
            "registry": .object([
                "installed": .array([]),
                "available": .array([]),
                "offline": .bool(false),
            ]),
            "error": .null,
        ]),
        .popoverMeetingsSnapshot: .object([
            "activeMeetings": .array([
                .object([
                    "windowId": .string("window-1"),
                    "platform": .string("zoom"),
                    "meetingUrl": .string("https://zoom.us/j/123"),
                    "detectedAt": .string("2026-07-26T00:00:00Z"),
                    "state": .string("detected"),
                    "recordingId": .null,
                    "error": .null,
                    "companyUid": .string("company-1"),
                ]),
            ]),
            "memberships": .array([
                .object([
                    "companyUid": .string("company-1"),
                    "companyName": .string("Indigo"),
                    "role": .string("ADMIN"),
                    "status": .string("ACTIVE"),
                ]),
            ]),
            "defaultRecordingCompanyUid": .string("company-1"),
        ]),
        .popoverOpened: nil,
        .syncAuthError: .object([
            "message": .string("Sign in again"),
        ]),
        .syncComplete: .object([
            "company": .string("indigo"),
            "filesDownloaded": .number(3),
            "bytesDownloaded": .number(300),
            "filesSkipped": .number(1),
            "conflicts": .number(1),
            "aborted": .bool(true),
            "filesTombstoned": .number(0),
            "filesRefusedStale": .number(0),
        ]),
        .syncConflict: .object([
            "path": .string("knowledge/conflict.md"),
            "localHash": .string("local"),
            "remoteHash": .string("remote"),
            "canAutoResolve": .bool(false),
        ]),
        .syncError: .object([
            "company": .string("indigo"),
            "path": .string("knowledge/a.md"),
            "message": .string("Sync failed"),
        ]),
        .syncExternalIdle: nil,
        .syncExternalProgress: .object([
            "pid": .number(123),
            "company": .string("indigo"),
            "phase": .string("pull"),
            "filesTotal": .number(4),
            "filesDone": .number(2),
            "conflicts": .number(0),
            "currentFile": .string("knowledge/a.md"),
            "startedAt": .string("2026-07-26T00:00:00Z"),
            "updatedAt": .string("2026-07-26T00:00:01Z"),
            "status": .string("syncing"),
        ]),
        .syncFanoutPlan: .object([
            "companies": .array([
                .object([
                    "uid": .string("company-1"),
                    "slug": .string("indigo"),
                    "name": .string("Indigo"),
                ]),
            ]),
        ]),
        .syncPersonalFirstPushComplete: .object([
            "personUid": .string("person-1"),
            "filesUploaded": .number(2),
            "filesSkipped": .number(1),
        ]),
        .syncPersonalFirstPushProgress: .object([
            "personUid": .string("person-1"),
            "filesDone": .number(1),
            "filesTotal": .number(2),
            "currentFile": .string("personal/knowledge/a.md"),
        ]),
        .syncPersonalFirstPushScan: .object([
            "personUid": .string("person-1"),
            "filesScanned": .number(3),
            "filesTotal": .number(4),
            "currentFile": .string("personal/knowledge/a.md"),
        ]),
        .syncPlan: .object([
            "company": .string("indigo"),
            "filesToDownload": .number(2),
            "bytesToDownload": .number(200),
            "filesToUpload": .number(1),
            "bytesToUpload": .number(100),
            "filesToSkip": .number(1),
            "filesToConflict": .number(1),
            "filesToDelete": .number(0),
        ]),
        .syncProgress: .object([
            "company": .string("indigo"),
            "path": .string("knowledge/a.md"),
            "bytes": .number(100),
            "message": .string("Downloaded knowledge/a.md"),
            "direction": .string("down"),
            "deleted": .bool(false),
            "author": .string("friend@example.com"),
        ]),
        .syncSetupNeeded: nil,
        .syncTotals: .object([
            "totalFiles": .number(4),
        ]),
        .trayCheckForUpdates: nil,
        .trayOpenDesktop: nil,
        .trayOpenSettings: nil,
        .traySignOut: nil,
        .traySyncNow: nil,
        .updateAvailable: .object([
            "version": .string("0.11.0"),
            "body": .string("Native macOS release"),
            "date": .string("2026-07-26T00:00:00Z"),
        ]),
    ]

}
