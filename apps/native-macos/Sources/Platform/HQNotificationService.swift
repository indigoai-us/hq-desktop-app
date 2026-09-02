import Foundation
import UserNotifications

struct HQNotificationPayload: Equatable, Sendable {
    let identifier: String
    let title: String
    let body: String
    let categoryIdentifier: String
    let userInfo: [String: String]
    let playsSound: Bool

    init(
        identifier: String,
        title: String,
        body: String,
        categoryIdentifier: String = "",
        userInfo: [String: String] = [:],
        playsSound: Bool = true
    ) {
        self.identifier = identifier
        self.title = title
        self.body = body
        self.categoryIdentifier = categoryIdentifier
        self.userInfo = userInfo
        self.playsSound = playsSound
    }
}

enum HQNotificationServiceError: Error, Equatable {
    case emptyIdentifier
    case emptyTitle
    case deliveryInvalidated
}

@MainActor
protocol HQUserNotificationCenterDriving {
    func requestAuthorization(options: UNAuthorizationOptions) async throws -> Bool
    func add(_ request: UNNotificationRequest) async throws
    func install(delegate: UNUserNotificationCenterDelegate)
    func setNotificationCategories(_ categories: Set<UNNotificationCategory>)
    func removeAllDeliveredNotifications()
    func removeAllPendingNotificationRequests()
    func removeDeliveredNotifications(withIdentifiers identifiers: [String])
    func removePendingNotificationRequests(withIdentifiers identifiers: [String])
}

extension HQUserNotificationCenterDriving {
    func removeAllDeliveredNotifications() {}
    func removeAllPendingNotificationRequests() {}
    func removeDeliveredNotifications(withIdentifiers _: [String]) {}
    func removePendingNotificationRequests(withIdentifiers _: [String]) {}
}

@MainActor
final class HQSystemUserNotificationCenter: HQUserNotificationCenterDriving {
    private let center: UNUserNotificationCenter

    init(center: UNUserNotificationCenter = .current()) {
        self.center = center
    }

    func requestAuthorization(options: UNAuthorizationOptions) async throws -> Bool {
        try await center.requestAuthorization(options: options)
    }

    func add(_ request: UNNotificationRequest) async throws {
        try await center.add(request)
    }

    func install(delegate: UNUserNotificationCenterDelegate) {
        center.delegate = delegate
    }

    func setNotificationCategories(
        _ categories: Set<UNNotificationCategory>
    ) {
        center.setNotificationCategories(categories)
    }

    func removeAllDeliveredNotifications() {
        center.removeAllDeliveredNotifications()
    }

    func removeAllPendingNotificationRequests() {
        center.removeAllPendingNotificationRequests()
    }

    func removeDeliveredNotifications(withIdentifiers identifiers: [String]) {
        center.removeDeliveredNotifications(withIdentifiers: identifiers)
    }

    func removePendingNotificationRequests(withIdentifiers identifiers: [String]) {
        center.removePendingNotificationRequests(withIdentifiers: identifiers)
    }
}

enum HQNativeNotificationResponse: Equatable, Sendable {
    case directMessage(
        operation: HQNativeDMNotificationOperation,
        eventID: String,
        payload: HQJSONValue?
    )
    case share(
        operation: HQNativeShareNotificationOperation,
        eventID: String,
        payload: HQJSONValue?
    )
    case meeting(
        operation: HQNativeMeetingNotificationOperation,
        windowID: String?,
        platform: String?,
        meetingID: String?
    )
}

enum HQNativeNotificationContract {
    static let directMessageCategory = "hq.direct-message"
    static let shareCategory = "hq.share"
    static let meetingCategory = "hq.meeting"
    static let encodedPayloadKey = "hqPayload"
    static let logicalIdentifierKey = "hqLogicalIdentifier"
    static let deliveryGenerationKey = "hqDeliveryGeneration"

    static let directMessageOpen = "hq.dm.open"
    static let directMessageCopy = "hq.dm.copy"
    static let shareClaude = "hq.share.claude"
    static let shareCopy = "hq.share.copy"
    static let shareOpen = "hq.share.open"
    static let meetingRecord = "hq.meeting.record"
    static let meetingAssign = "hq.meeting.assign"
    static let meetingOpen = "hq.meeting.open"

    @MainActor
    static func categories() -> Set<UNNotificationCategory> {
        [
            UNNotificationCategory(
            identifier: directMessageCategory,
            actions: [
                UNNotificationAction(
                    identifier: directMessageOpen,
                    title: "Open Conversation",
                    options: [.foreground]
                ),
                UNNotificationAction(
                    identifier: directMessageCopy,
                    title: "Copy Prompt",
                    options: []
                ),
            ],
            intentIdentifiers: []
            ),
            UNNotificationCategory(
            identifier: shareCategory,
            actions: [
                UNNotificationAction(
                    identifier: shareClaude,
                    title: "Open in Claude Code",
                    options: [.foreground]
                ),
                UNNotificationAction(
                    identifier: shareCopy,
                    title: "Copy Prompt",
                    options: []
                ),
                UNNotificationAction(
                    identifier: shareOpen,
                    title: "View Share",
                    options: [.foreground]
                ),
            ],
            intentIdentifiers: []
            ),
            UNNotificationCategory(
            identifier: meetingCategory,
            actions: [
                UNNotificationAction(
                    identifier: meetingRecord,
                    title: "Record",
                    options: [.foreground]
                ),
                UNNotificationAction(
                    identifier: meetingAssign,
                    title: "Assign",
                    options: [.foreground]
                ),
                UNNotificationAction(
                    identifier: meetingOpen,
                    title: "Open HQ",
                    options: [.foreground]
                ),
            ],
            intentIdentifiers: []
            ),
        ]
    }

    static var foregroundPresentationOptions:
        UNNotificationPresentationOptions
    {
        [.banner, .list, .sound, .badge]
    }

    static func response(
        categoryIdentifier: String,
        actionIdentifier: String,
        userInfo: [AnyHashable: Any]
    ) -> HQNativeNotificationResponse? {
        let action = actionIdentifier == UNNotificationDefaultActionIdentifier
            ? defaultAction(for: categoryIdentifier)
            : actionIdentifier
        let payload = decodedPayload(userInfo[encodedPayloadKey])
        let payloadEventID: String?
        if case let .object(object) = payload {
            payloadEventID = jsonString(object["eventId"])
        } else {
            payloadEventID = nil
        }
        let eventID = string("eventId", in: userInfo)
            ?? payloadEventID

        switch categoryIdentifier {
        case directMessageCategory:
            let operation: HQNativeDMNotificationOperation
            switch action {
            case directMessageOpen:
                operation = .open
            case directMessageCopy:
                operation = .copy
            default:
                return nil
            }
            guard let eventID, !eventID.isEmpty else { return nil }
            return .directMessage(
                operation: operation,
                eventID: eventID,
                payload: payload
            )

        case shareCategory:
            let operation: HQNativeShareNotificationOperation
            switch action {
            case shareClaude:
                operation = .claude
            case shareCopy:
                operation = .copy
            case shareOpen:
                operation = .open
            default:
                return nil
            }
            guard let eventID, !eventID.isEmpty else { return nil }
            return .share(
                operation: operation,
                eventID: eventID,
                payload: payload
            )

        case meetingCategory:
            let operation: HQNativeMeetingNotificationOperation
            switch action {
            case meetingRecord:
                operation = .record
            case meetingAssign:
                operation = .assign
            case meetingOpen:
                operation = .open
            default:
                return nil
            }
            return .meeting(
                operation: operation,
                windowID: string("windowId", in: userInfo),
                platform: string("platform", in: userInfo),
                meetingID: string("meetingId", in: userInfo)
            )

        default:
            return nil
        }
    }

    static func encodedPayload(_ value: HQJSONValue) -> String? {
        guard let data = try? JSONEncoder().encode(value) else {
            return nil
        }
        return String(data: data, encoding: .utf8)
    }

    private static func defaultAction(
        for categoryIdentifier: String
    ) -> String {
        switch categoryIdentifier {
        case directMessageCategory:
            directMessageOpen
        case shareCategory:
            shareClaude
        case meetingCategory:
            meetingOpen
        default:
            ""
        }
    }

    private static func decodedPayload(_ value: Any?) -> HQJSONValue? {
        guard let string = value as? String,
              let data = string.data(using: .utf8)
        else {
            return nil
        }
        return try? JSONDecoder().decode(HQJSONValue.self, from: data)
    }

    private static func string(
        _ key: String,
        in userInfo: [AnyHashable: Any]
    ) -> String? {
        guard let value = userInfo[key] as? String else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func jsonString(_ value: HQJSONValue?) -> String? {
        guard case let .string(string) = value else { return nil }
        return string
    }
}

@MainActor
private final class HQNotificationCenterDelegate:
    NSObject,
    UNUserNotificationCenterDelegate
{
    var onResponse: ((
        HQNativeNotificationResponse,
        UInt64?
    ) -> Void)?

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler:
            @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler(
            HQNativeNotificationContract.foregroundPresentationOptions
        )
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let completion = HQNotificationResponseCompletion(
            completionHandler
        )
        let request = response.notification.request
        let mapped = HQNativeNotificationContract.response(
            categoryIdentifier: request.content.categoryIdentifier,
            actionIdentifier: response.actionIdentifier,
            userInfo: request.content.userInfo
        )
        let generation = (
            request.content.userInfo[
                HQNativeNotificationContract.deliveryGenerationKey
            ] as? String
        ).flatMap(UInt64.init)
        Task { @MainActor [weak self] in
            if let mapped {
                self?.onResponse?(mapped, generation)
            }
            // Keep the notification action alive until its payload has crossed
            // onto the main actor. This matters for cold/background actions:
            // completing before the handoff can let macOS suspend the process
            // while the response is still only a scheduled task.
            completion.call()
        }
    }
}

/// `UNUserNotificationCenterDelegate` supplies an escaping completion closure
/// that predates Swift concurrency and is not annotated `Sendable`. The system
/// contract permits calling it from any queue, so this wrapper safely carries
/// it across the main-actor handoff where HQ consumes the response.
private struct HQNotificationResponseCompletion: @unchecked Sendable {
    private let callback: () -> Void

    init(_ callback: @escaping () -> Void) {
        self.callback = callback
    }

    func call() {
        callback()
    }
}

@MainActor
final class HQNativeNotificationService {
    private let center: any HQUserNotificationCenterDriving
    private let delegate = HQNotificationCenterDelegate()
    private var responseHandler:
        ((HQNativeNotificationResponse) -> Void)?
    private var pendingResponses: [HQNativeNotificationResponse] = []
    private var deliveryGeneration: UInt64 = 0

    var onResponse: ((HQNativeNotificationResponse) -> Void)? {
        get {
            responseHandler
        }
        set {
            responseHandler = newValue
            drainPendingResponses()
        }
    }

    init(center: any HQUserNotificationCenterDriving = HQSystemUserNotificationCenter()) {
        self.center = center
        delegate.onResponse = { [weak self] response, generation in
            self?.receive(
                response,
                deliveryGeneration: generation
            )
        }
        center.setNotificationCategories(
            HQNativeNotificationContract.categories()
        )
        center.install(delegate: delegate)
    }

    func requestAuthorization() async throws -> Bool {
        try await center.requestAuthorization(options: [.alert, .badge, .sound])
    }

    func deliver(_ payload: HQNotificationPayload) async throws {
        guard !payload.identifier.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw HQNotificationServiceError.emptyIdentifier
        }
        guard !payload.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw HQNotificationServiceError.emptyTitle
        }

        let generation = deliveryGeneration
        var userInfo = payload.userInfo
        userInfo[HQNativeNotificationContract.logicalIdentifierKey] =
            payload.identifier
        userInfo[HQNativeNotificationContract.deliveryGenerationKey] =
            String(generation)

        let content = UNMutableNotificationContent()
        content.title = payload.title
        content.body = payload.body
        content.categoryIdentifier = payload.categoryIdentifier
        content.userInfo = userInfo
        content.sound = payload.playsSound ? .default : nil

        let request = UNNotificationRequest(
            identifier: "\(payload.identifier).g\(generation)",
            content: content,
            trigger: nil
        )
        try await center.add(request)
        guard generation == deliveryGeneration else {
            center.removeDeliveredNotifications(
                withIdentifiers: [request.identifier]
            )
            center.removePendingNotificationRequests(
                withIdentifiers: [request.identifier]
            )
            throw HQNotificationServiceError.deliveryInvalidated
        }
    }

    func removeAllDeliveredAndPending() {
        deliveryGeneration &+= 1
        pendingResponses.removeAll()
        center.removeAllDeliveredNotifications()
        center.removeAllPendingNotificationRequests()
    }

    /// Retains a cold/background notification response until the application
    /// Store installs its route handler. Draining removes the response before
    /// invoking client code, so repeated lifecycle installation cannot replay
    /// an already-consumed action.
    func receive(_ response: HQNativeNotificationResponse) {
        guard let responseHandler else {
            pendingResponses.append(response)
            return
        }
        responseHandler(response)
    }

    var currentDeliveryGeneration: UInt64 {
        deliveryGeneration
    }

    func receive(
        _ response: HQNativeNotificationResponse,
        deliveryGeneration responseGeneration: UInt64?
    ) {
        guard responseGeneration == deliveryGeneration else {
            return
        }
        receive(response)
    }

    private func drainPendingResponses() {
        guard let responseHandler, !pendingResponses.isEmpty else {
            return
        }
        let responses = pendingResponses
        pendingResponses.removeAll(keepingCapacity: true)
        for response in responses {
            responseHandler(response)
        }
    }
}
