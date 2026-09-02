import AppKit
import UserNotifications
import XCTest
@testable import HQNative

@MainActor
final class HQNativePlatformNotificationTests: XCTestCase {
    func testRegistersEveryInteractiveCategoryAndRetainsDelegate() {
        let center = NotificationCenterSpy()
        _ = HQNativeNotificationService(center: center)

        XCTAssertNotNil(center.installedDelegate)
        XCTAssertEqual(center.delegateInstallCount, 1)
        XCTAssertEqual(
            Set(center.categories.map(\.identifier)),
            [
                HQNativeNotificationContract.directMessageCategory,
                HQNativeNotificationContract.shareCategory,
                HQNativeNotificationContract.meetingCategory,
            ]
        )
        XCTAssertEqual(
            Set(
                center.categories.flatMap {
                    $0.actions.map(\.identifier)
                }
            ),
            [
                HQNativeNotificationContract.directMessageOpen,
                HQNativeNotificationContract.directMessageCopy,
                HQNativeNotificationContract.shareClaude,
                HQNativeNotificationContract.shareCopy,
                HQNativeNotificationContract.shareOpen,
                HQNativeNotificationContract.meetingRecord,
                HQNativeNotificationContract.meetingAssign,
                HQNativeNotificationContract.meetingOpen,
            ]
        )
        XCTAssertEqual(
            HQNativeNotificationContract.foregroundPresentationOptions,
            [.banner, .list, .sound, .badge]
        )
    }

    func testDefaultAndCustomActionsMapToTypedResponses() throws {
        let directMessage = Self.directMessage
        let directPayload = try XCTUnwrap(
            HQNativeNotificationContract.encodedPayload(directMessage)
        )
        let directInfo: [AnyHashable: Any] = [
            "eventId": "dm-1",
            HQNativeNotificationContract.encodedPayloadKey: directPayload,
        ]
        let directCases: [
            (String, HQNativeNotificationResponse)
        ] = [
            (
                UNNotificationDefaultActionIdentifier,
                .directMessage(
                    operation: .open,
                    eventID: "dm-1",
                    payload: directMessage
                )
            ),
            (
                HQNativeNotificationContract.directMessageOpen,
                .directMessage(
                    operation: .open,
                    eventID: "dm-1",
                    payload: directMessage
                )
            ),
            (
                HQNativeNotificationContract.directMessageCopy,
                .directMessage(
                    operation: .copy,
                    eventID: "dm-1",
                    payload: directMessage
                )
            ),
        ]

        let share = Self.share
        let sharePayload = try XCTUnwrap(
            HQNativeNotificationContract.encodedPayload(share)
        )
        let shareInfo: [AnyHashable: Any] = [
            "eventId": "share-1",
            HQNativeNotificationContract.encodedPayloadKey: sharePayload,
        ]
        let shareCases: [
            (String, HQNativeNotificationResponse)
        ] = [
            (
                UNNotificationDefaultActionIdentifier,
                .share(
                    operation: .claude,
                    eventID: "share-1",
                    payload: share
                )
            ),
            (
                HQNativeNotificationContract.shareClaude,
                .share(
                    operation: .claude,
                    eventID: "share-1",
                    payload: share
                )
            ),
            (
                HQNativeNotificationContract.shareCopy,
                .share(
                    operation: .copy,
                    eventID: "share-1",
                    payload: share
                )
            ),
            (
                HQNativeNotificationContract.shareOpen,
                .share(
                    operation: .open,
                    eventID: "share-1",
                    payload: share
                )
            ),
        ]

        let meetingInfo: [AnyHashable: Any] = [
            "windowId": "window-1",
            "platform": "zoom",
            "meetingId": "meeting-1",
        ]
        let meetingCases: [
            (String, HQNativeNotificationResponse)
        ] = [
            (
                UNNotificationDefaultActionIdentifier,
                .meeting(
                    operation: .open,
                    windowID: "window-1",
                    platform: "zoom",
                    meetingID: "meeting-1"
                )
            ),
            (
                HQNativeNotificationContract.meetingRecord,
                .meeting(
                    operation: .record,
                    windowID: "window-1",
                    platform: "zoom",
                    meetingID: "meeting-1"
                )
            ),
            (
                HQNativeNotificationContract.meetingAssign,
                .meeting(
                    operation: .assign,
                    windowID: "window-1",
                    platform: "zoom",
                    meetingID: "meeting-1"
                )
            ),
            (
                HQNativeNotificationContract.meetingOpen,
                .meeting(
                    operation: .open,
                    windowID: "window-1",
                    platform: "zoom",
                    meetingID: "meeting-1"
                )
            ),
        ]

        for (action, expected) in directCases {
            XCTAssertEqual(
                HQNativeNotificationContract.response(
                    categoryIdentifier:
                        HQNativeNotificationContract.directMessageCategory,
                    actionIdentifier: action,
                    userInfo: directInfo
                ),
                expected,
                "Unexpected DM mapping for \(action)"
            )
        }
        for (action, expected) in shareCases {
            XCTAssertEqual(
                HQNativeNotificationContract.response(
                    categoryIdentifier:
                        HQNativeNotificationContract.shareCategory,
                    actionIdentifier: action,
                    userInfo: shareInfo
                ),
                expected,
                "Unexpected share mapping for \(action)"
            )
        }
        for (action, expected) in meetingCases {
            XCTAssertEqual(
                HQNativeNotificationContract.response(
                    categoryIdentifier:
                        HQNativeNotificationContract.meetingCategory,
                    actionIdentifier: action,
                    userInfo: meetingInfo
                ),
                expected,
                "Unexpected meeting mapping for \(action)"
            )
        }

        XCTAssertNil(
            HQNativeNotificationContract.response(
                categoryIdentifier:
                    HQNativeNotificationContract.directMessageCategory,
                actionIdentifier: "unsupported",
                userInfo: directInfo
            )
        )
        XCTAssertNil(
            HQNativeNotificationContract.response(
                categoryIdentifier: "unsupported",
                actionIdentifier: UNNotificationDefaultActionIdentifier,
                userInfo: [:]
            )
        )
    }

    func testColdResponsesWaitForRoutingAndAreConsumedExactlyOnce() {
        let center = NotificationCenterSpy()
        let service = HQNativeNotificationService(center: center)

        service.receive(
            .directMessage(
                operation: .open,
                eventID: "dm-1",
                payload: Self.directMessage
            )
        )
        service.receive(
            .share(
                operation: .open,
                eventID: "share-1",
                payload: Self.share
            )
        )
        service.receive(
            .meeting(
                operation: .assign,
                windowID: "window-1",
                platform: "zoom",
                meetingID: "meeting-1"
            )
        )

        let store = HQAppStore(
            engine: NotificationTestEngine(),
            launchMode: .live,
            notificationService: service,
            allowsUnresolvedAuthenticationForTesting: true
        )
        XCTAssertTrue(store.nativeParityEvents.history.isEmpty)

        store.installNativeNotificationRouting()

        XCTAssertEqual(
            store.nativeParityEvents.history.map(\.name),
            [
                .notificationDMAction,
                .notificationShareAction,
                .notificationMeetingAction,
            ]
        )
        XCTAssertEqual(
            store.nativeParityEvents.dmDetailMessage?.eventID,
            "dm-1"
        )
        XCTAssertEqual(
            store.nativeParityEvents.selectedShare?.eventID,
            "share-1"
        )
        XCTAssertEqual(store.focusedMeetingID, "meeting-1")

        guard case let .content(directDetail) = store.windowState(
            for: .directMessageDetail
        ) else {
            return XCTFail("The cold DM payload did not render.")
        }
        XCTAssertEqual(directDetail.title, "Friend")
        guard case let .content(shareDetail) = store.windowState(
            for: .shareDetail
        ) else {
            return XCTFail("The cold share payload did not render.")
        }
        XCTAssertTrue(
            shareDetail.rows.contains {
                $0.detail.contains("knowledge/native.md")
            }
        )

        store.installNativeNotificationRouting()
        XCTAssertEqual(store.nativeParityEvents.history.count, 3)
    }

    func testStoreColdDefaultClickRoutesThroughRetainedService() throws {
        let center = NotificationCenterSpy()
        let service = HQNativeNotificationService(center: center)
        var openedURL: URL?
        let store = HQAppStore(
            engine: NotificationTestEngine(),
            launchMode: .live,
            notificationService: service,
            openExternalURL: { openedURL = $0 },
            allowsUnresolvedAuthenticationForTesting: true
        )
        store.installNativeNotificationRouting()

        let response = try XCTUnwrap(
            HQNativeNotificationContract.response(
                categoryIdentifier: HQNativeNotificationContract.shareCategory,
                actionIdentifier: UNNotificationDefaultActionIdentifier,
                userInfo: [
                    "eventId": "share-1",
                    HQNativeNotificationContract.encodedPayloadKey:
                        try XCTUnwrap(
                            HQNativeNotificationContract.encodedPayload(
                                Self.share
                            )
                        ),
                ]
            )
        )
        service.onResponse?(response)

        XCTAssertEqual(openedURL?.scheme, "claude")
        XCTAssertEqual(openedURL?.host, "code")
        XCTAssertEqual(openedURL?.path, "/new")
        XCTAssertEqual(
            store.operationState,
            .success("Opened the secure share in Claude Code.")
        )
        XCTAssertEqual(center.delegateInstallCount, 1)
    }

    func testDirectMessageCopyAndOpenHaveObservableEffects() {
        let center = NotificationCenterSpy()
        let service = HQNativeNotificationService(center: center)
        let store = HQAppStore(
            engine: NotificationTestEngine(),
            launchMode: .live,
            notificationService: service,
            allowsUnresolvedAuthenticationForTesting: true
        )
        store.installNativeNotificationRouting()

        service.onResponse?(
            .directMessage(
                operation: .copy,
                eventID: "dm-1",
                payload: Self.directMessage
            )
        )
        XCTAssertEqual(
            NSPasteboard.general.string(forType: .string),
            "Review native notification parity."
        )

        service.onResponse?(
            .directMessage(
                operation: .open,
                eventID: "dm-1",
                payload: Self.directMessage
            )
        )
        XCTAssertEqual(
            store.sceneRequest?.sceneID,
            HQSecondaryWindowKind.directMessageDetail.rawValue
        )
        guard case let .content(detail) = store.windowState(
            for: .directMessageDetail
        ) else {
            return XCTFail("The selected direct message did not render.")
        }
        XCTAssertEqual(detail.title, "Friend")
        XCTAssertEqual(
            store.nativeParityEvents.history.last?.name,
            .notificationDMAction
        )
    }

    func testColdShareOpenRendersAndMeetingAssignFocusesTarget() {
        let center = NotificationCenterSpy()
        let service = HQNativeNotificationService(center: center)
        let store = HQAppStore(
            engine: NotificationTestEngine(),
            launchMode: .live,
            notificationService: service,
            allowsUnresolvedAuthenticationForTesting: true
        )
        store.installNativeNotificationRouting()

        service.onResponse?(
            .share(
                operation: .open,
                eventID: "share-1",
                payload: Self.share
            )
        )
        XCTAssertEqual(
            store.sceneRequest?.sceneID,
            HQSecondaryWindowKind.shareDetail.rawValue
        )
        XCTAssertEqual(
            store.nativeParityEvents.selectedShare?.eventID,
            "share-1"
        )
        guard case let .content(detail) = store.windowState(for: .shareDetail)
        else {
            return XCTFail("The cold secure-share payload did not render.")
        }
        XCTAssertEqual(detail.title, "Shared with you")
        XCTAssertTrue(
            detail.rows.contains {
                $0.detail.contains("knowledge/native.md")
            }
        )
        XCTAssertEqual(
            store.nativeParityEvents.history.last?.name,
            .notificationShareAction
        )

        service.onResponse?(
            .meeting(
                operation: .assign,
                windowID: "window-fallback",
                platform: "zoom",
                meetingID: "meeting-focus"
            )
        )
        XCTAssertEqual(
            store.sceneRequest?.sceneID,
            HQSecondaryWindowKind.meetings.rawValue
        )
        XCTAssertEqual(store.focusedMeetingID, "meeting-focus")
        XCTAssertEqual(
            store.nativeParityEvents.history.last?.name,
            .notificationMeetingAction
        )
    }

    func testMeetingRecordResponseReachesEngine() async {
        let center = NotificationCenterSpy()
        let service = HQNativeNotificationService(center: center)
        let engine = NotificationTestEngine()
        let store = HQAppStore(
            engine: engine,
            launchMode: .live,
            notificationService: service
        )
        store.installNativeNotificationRouting()
        await store.start()

        service.onResponse?(
            .meeting(
                operation: .record,
                windowID: "window-1",
                platform: "zoom",
                meetingID: nil
            )
        )
        for _ in 0..<20 {
            if (await engine.requestedMethods()).contains("start_recording") {
                break
            }
            try? await Task.sleep(for: .milliseconds(10))
        }

        let requestedMethods = await engine.requestedMethods()
        let recordingParams = await engine.lastParams(
            for: "start_recording"
        )
        XCTAssertTrue(requestedMethods.contains("start_recording"))
        XCTAssertEqual(
            recordingParams,
            .object([
                "windowId": .string("window-1"),
                "companyUid": .null,
            ])
        )
    }

    func testPermissionRequestReusesRetainedDelegateService() async {
        let center = NotificationCenterSpy()
        center.authorizationResult = true
        let service = HQNativeNotificationService(center: center)
        let store = HQAppStore(
            engine: NotificationTestEngine(),
            launchMode: .live,
            notificationService: service
        )
        store.installNativeNotificationRouting()

        await store.perform(
            .nativeCommand(.notificationRequestPermission)
        )

        XCTAssertEqual(center.authorizationRequests.count, 1)
        XCTAssertEqual(center.delegateInstallCount, 1)
        XCTAssertNotNil(service.onResponse)
    }

    func testRequestsAlertBadgeAndSoundAuthorization() async throws {
        let center = NotificationCenterSpy()
        center.authorizationResult = true
        let service = HQNativeNotificationService(center: center)

        let authorized = try await service.requestAuthorization()

        XCTAssertTrue(authorized)
        XCTAssertEqual(center.authorizationRequests, [[.alert, .badge, .sound]])
    }

    func testReturnsDeniedAuthorizationWithoutMaskingIt() async throws {
        let center = NotificationCenterSpy()
        center.authorizationResult = false
        let service = HQNativeNotificationService(center: center)

        let authorized = try await service.requestAuthorization()

        XCTAssertFalse(authorized)
        XCTAssertEqual(center.authorizationRequests, [[.alert, .badge, .sound]])
    }

    func testDeliversImmediateNativeNotification() async throws {
        let center = NotificationCenterSpy()
        let service = HQNativeNotificationService(center: center)
        let payload = HQNotificationPayload(
            identifier: "sync-complete",
            title: "Sync complete",
            body: "Indigo is up to date.",
            categoryIdentifier: "sync",
            userInfo: ["workspace": "indigo"],
            playsSound: true
        )

        try await service.deliver(payload)

        let request = try XCTUnwrap(center.addedRequests.first)
        XCTAssertEqual(request.identifier, "sync-complete.g0")
        XCTAssertNil(request.trigger)
        XCTAssertEqual(request.content.title, "Sync complete")
        XCTAssertEqual(request.content.body, "Indigo is up to date.")
        XCTAssertEqual(request.content.categoryIdentifier, "sync")
        XCTAssertEqual(
            request.content.userInfo as? [String: String],
            [
                "workspace": "indigo",
                HQNativeNotificationContract.logicalIdentifierKey:
                    "sync-complete",
                HQNativeNotificationContract.deliveryGenerationKey: "0",
            ]
        )
        XCTAssertNotNil(request.content.sound)
    }

    func testPreClearDeliveryGenerationResponseIsRejectedAfterReauthentication()
        async throws
    {
        let center = NotificationCenterSpy()
        let service = HQNativeNotificationService(center: center)
        var routedResponses: [HQNativeNotificationResponse] = []
        service.onResponse = { routedResponses.append($0) }
        let directResponse = HQNativeNotificationResponse.directMessage(
            operation: .open,
            eventID: "dm-1",
            payload: Self.directMessage
        )
        let shareResponse = HQNativeNotificationResponse.share(
            operation: .open,
            eventID: "share-1",
            payload: Self.share
        )

        try await service.deliver(
            HQNotificationPayload(
                identifier: "pre-clear-dm",
                title: "Protected message",
                body: "Delivered before authentication was cleared.",
                categoryIdentifier:
                    HQNativeNotificationContract.directMessageCategory,
                userInfo: [
                    "eventId": "dm-1",
                    HQNativeNotificationContract.encodedPayloadKey:
                        try XCTUnwrap(
                            HQNativeNotificationContract.encodedPayload(
                                Self.directMessage
                            )
                        ),
                ]
            )
        )
        let preClearRequest = try XCTUnwrap(
            center.addedRequests.first
        )
        let preClearGeneration = try deliveryGeneration(
            in: preClearRequest
        )

        service.removeAllDeliveredAndPending()

        try await service.deliver(
            HQNotificationPayload(
                identifier: "post-reauth-share",
                title: "Current share",
                body: "Delivered after authentication was restored.",
                categoryIdentifier:
                    HQNativeNotificationContract.shareCategory,
                userInfo: [
                    "eventId": "share-1",
                    HQNativeNotificationContract.encodedPayloadKey:
                        try XCTUnwrap(
                            HQNativeNotificationContract.encodedPayload(
                                Self.share
                            )
                        ),
                ]
            )
        )
        let postReauthenticationRequest = try XCTUnwrap(
            center.addedRequests.last
        )
        let postReauthenticationGeneration = try deliveryGeneration(
            in: postReauthenticationRequest
        )
        XCTAssertNotEqual(
            preClearGeneration,
            postReauthenticationGeneration
        )

        service.receive(
            directResponse,
            deliveryGeneration: preClearGeneration
        )
        service.receive(
            shareResponse,
            deliveryGeneration: postReauthenticationGeneration
        )

        XCTAssertEqual(
            routedResponses,
            [shareResponse],
            "A response stamped before auth clear must not route in a later authenticated generation."
        )
    }

    func testSilentPayloadOmitsSound() async throws {
        let center = NotificationCenterSpy()
        let service = HQNativeNotificationService(center: center)

        try await service.deliver(
            HQNotificationPayload(
                identifier: "background-sync",
                title: "Background sync",
                body: "Finished.",
                playsSound: false
            )
        )

        XCTAssertNil(try XCTUnwrap(center.addedRequests.first).content.sound)
    }

    func testRejectsBlankIdentifierBeforeDelivery() async {
        let center = NotificationCenterSpy()
        let service = HQNativeNotificationService(center: center)

        do {
            try await service.deliver(
                HQNotificationPayload(identifier: "  ", title: "Title", body: "Body")
            )
            XCTFail("Expected emptyIdentifier")
        } catch {
            XCTAssertEqual(error as? HQNotificationServiceError, .emptyIdentifier)
            XCTAssertEqual(center.addedRequests.count, 0)
        }
    }

    func testRejectsBlankTitleBeforeDelivery() async {
        let center = NotificationCenterSpy()
        let service = HQNativeNotificationService(center: center)

        do {
            try await service.deliver(
                HQNotificationPayload(identifier: "id", title: "\n", body: "Body")
            )
            XCTFail("Expected emptyTitle")
        } catch {
            XCTAssertEqual(error as? HQNotificationServiceError, .emptyTitle)
            XCTAssertEqual(center.addedRequests.count, 0)
        }
    }

    private func deliveryGeneration(
        in request: UNNotificationRequest,
        file: StaticString = #filePath,
        line: UInt = #line
    ) throws -> UInt64 {
        let value = request.content.userInfo[
            HQNativeNotificationContract.deliveryGenerationKey
        ]
        let generation =
            (value as? UInt64)
                ?? (value as? NSNumber)?.uint64Value
                ?? (value as? String).flatMap(UInt64.init)
        return try XCTUnwrap(
            generation,
            "The delivered notification must carry its auth-bound generation.",
            file: file,
            line: line
        )
    }

    private static let directMessage: HQJSONValue = .object([
        "eventId": .string("dm-1"),
        "fromPersonUid": .string("person-1"),
        "fromEmail": .string("friend@example.com"),
        "fromDisplayName": .string("Friend"),
        "body": .string("Native notifications are connected."),
        "details": .null,
        "prompt": .string("Review native notification parity."),
        "createdAt": .string("2026-07-27T00:00:00Z"),
    ])

    private static let share: HQJSONValue = .object([
        "eventId": .string("share-1"),
        "issuerEmail": .string("friend@example.com"),
        "issuerDisplayName": .string("Friend"),
        "issuerPersonUid": .string("person-1"),
        "paths": .array([.string("knowledge/native.md")]),
        "note": .string("Please review"),
        "permission": .string("read"),
        "createdAt": .string("2026-07-27T00:00:00Z"),
    ])
}

@MainActor
private final class NotificationCenterSpy: HQUserNotificationCenterDriving {
    var authorizationResult = false
    var authorizationError: Error?
    var addError: Error?
    private(set) var authorizationRequests: [UNAuthorizationOptions] = []
    private(set) var addedRequests: [UNNotificationRequest] = []
    private(set) var categories: Set<UNNotificationCategory> = []
    private(set) var installedDelegate: UNUserNotificationCenterDelegate?
    private(set) var delegateInstallCount = 0

    func requestAuthorization(options: UNAuthorizationOptions) async throws -> Bool {
        authorizationRequests.append(options)
        if let authorizationError {
            throw authorizationError
        }
        return authorizationResult
    }

    func add(_ request: UNNotificationRequest) async throws {
        addedRequests.append(request)
        if let addError {
            throw addError
        }
    }

    func install(delegate: UNUserNotificationCenterDelegate) {
        installedDelegate = delegate
        delegateInstallCount += 1
    }

    func setNotificationCategories(
        _ categories: Set<UNNotificationCategory>
    ) {
        self.categories = categories
    }
}

private actor NotificationTestEngine: HQAppEngine {
    nonisolated let events: AsyncStream<HQEngineEvent> = AsyncStream {
        $0.finish()
    }
    private var requests: [(String, HQJSONValue)] = []

    func start() async throws -> HQJSONValue {
        .object([
            "capabilities": .array([
                "config.get",
                "auth.state",
                "workspaces.list",
                "sync.status",
                "projects.list",
                "sessions.list",
                "start_recording",
            ].map(HQJSONValue.string)),
        ])
    }

    func request(
        _ method: String,
        params: HQJSONValue
    ) async throws -> HQJSONValue {
        requests.append((method, params))
        switch method {
        case "config.get":
            return .object([:])
        case "auth.state":
            return .object(["authenticated": .bool(true)])
        case "workspaces.list":
            return .object(["workspaces": .array([])])
        case "sync.status":
            return .object([:])
        case "projects.list", "sessions.list":
            return .array([])
        case "start_recording":
            return .null
        default:
            throw HQEngineErrorPayload(
                code: "unsupported",
                message: "\(method) unavailable",
                retryable: false
            )
        }
    }

    func stop() async {}

    func requestedMethods() -> [String] {
        requests.map(\.0)
    }

    func lastParams(for method: String) -> HQJSONValue? {
        requests.last(where: { $0.0 == method })?.1
    }
}
