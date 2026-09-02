import Foundation

enum HQReleaseChannel: String, CaseIterable, Equatable, Sendable {
    case stable
    case beta
    case alpha

    var feedReleaseTag: String {
        "sparkle-\(rawValue)"
    }

    func appcastURL(releaseDownloadBaseURL: URL) -> URL {
        releaseDownloadBaseURL
            .appendingPathComponent(feedReleaseTag, isDirectory: true)
            .appendingPathComponent("appcast.xml", isDirectory: false)
    }

    static func availableChannels(isIndigoUser: Bool) -> [HQReleaseChannel] {
        isIndigoUser ? allCases : [.stable]
    }

    static func effective(
        preferredChannel: HQReleaseChannel?,
        isIndigoUser: Bool
    ) -> HQReleaseChannel {
        guard isIndigoUser else {
            return .stable
        }

        return preferredChannel ?? .beta
    }
}

struct HQUpdateDescriptor: Equatable, Sendable {
    let version: String
    let displayVersion: String
    let releaseNotesURL: URL?
}

struct HQUpdateSchedulingPolicy: Equatable, Sendable {
    let initialCheckDelay: TimeInterval
    let periodicCheckInterval: TimeInterval
    let automaticallyChecks: Bool
    let automaticallyInstalls: Bool

    static let legacy = HQUpdateSchedulingPolicy(
        initialCheckDelay: 10,
        periodicCheckInterval: 6 * 60 * 60,
        automaticallyChecks: true,
        automaticallyInstalls: false
    )
}

enum HQUpdaterState: Equatable, Sendable {
    case idle(channel: HQReleaseChannel)
    case checking(channel: HQReleaseChannel)
    case upToDate(channel: HQReleaseChannel)
    case available(channel: HQReleaseChannel, update: HQUpdateDescriptor)
    case downloading(channel: HQReleaseChannel, update: HQUpdateDescriptor)
    case readyToInstall(channel: HQReleaseChannel, update: HQUpdateDescriptor)
    case installing(channel: HQReleaseChannel, update: HQUpdateDescriptor)
    case failed(channel: HQReleaseChannel, message: String)
}

enum HQUpdaterDriverEvent: Equatable, Sendable {
    case found(HQUpdateDescriptor)
    case notFound
    case downloading(HQUpdateDescriptor)
    case downloaded(HQUpdateDescriptor)
    case installing(HQUpdateDescriptor)
    case failed(message: String)
}

enum HQUpdaterError: Error, Equatable, Sendable {
    case notStarted
    case insecureFeedURL
    case cannotCheckForUpdates
    case noAvailableUpdate
}

@MainActor
protocol HQUpdaterDriving: AnyObject {
    var canCheckForUpdates: Bool { get }
    var eventHandler: ((HQUpdaterDriverEvent) -> Void)? { get set }

    func start(feedURL: URL, policy: HQUpdateSchedulingPolicy) throws
    func checkForUpdates()
    func presentAvailableUpdate()
}

@MainActor
final class HQNativeUpdaterService {
    private let driver: any HQUpdaterDriving
    private let releaseDownloadBaseURL: URL
    private let schedulingPolicy: HQUpdateSchedulingPolicy
    private var channel: HQReleaseChannel?
    private(set) var state: HQUpdaterState = .idle(channel: .stable)
    var onStateChange: ((HQUpdaterState) -> Void)?

    init(
        driver: any HQUpdaterDriving,
        releaseDownloadBaseURL: URL = URL(
            string: "https://github.com/indigoai-us/hq-desktop-app/releases/download/"
        )!,
        schedulingPolicy: HQUpdateSchedulingPolicy = .legacy
    ) {
        self.driver = driver
        self.releaseDownloadBaseURL = releaseDownloadBaseURL
        self.schedulingPolicy = schedulingPolicy
        driver.eventHandler = { [weak self] event in
            self?.handle(event)
        }
    }

    func start(
        preferredChannel: HQReleaseChannel?,
        isIndigoUser: Bool
    ) throws {
        let effectiveChannel = HQReleaseChannel.effective(
            preferredChannel: preferredChannel,
            isIndigoUser: isIndigoUser
        )
        let feedURL = effectiveChannel.appcastURL(
            releaseDownloadBaseURL: releaseDownloadBaseURL
        )
        guard feedURL.scheme?.lowercased() == "https",
              feedURL.host?.isEmpty == false
        else {
            throw HQUpdaterError.insecureFeedURL
        }

        try driver.start(feedURL: feedURL, policy: schedulingPolicy)
        channel = effectiveChannel
        setState(.idle(channel: effectiveChannel))
    }

    func checkForUpdates() throws {
        guard let channel else {
            throw HQUpdaterError.notStarted
        }
        guard driver.canCheckForUpdates else {
            throw HQUpdaterError.cannotCheckForUpdates
        }

        setState(.checking(channel: channel))
        driver.checkForUpdates()
    }

    func presentAvailableUpdate() throws {
        switch state {
        case .available, .downloading, .readyToInstall, .installing:
            driver.presentAvailableUpdate()
        case .idle, .checking, .upToDate, .failed:
            throw HQUpdaterError.noAvailableUpdate
        }
    }

    private func handle(_ event: HQUpdaterDriverEvent) {
        guard let channel else {
            return
        }

        switch event {
        case let .found(update):
            setState(.available(channel: channel, update: update))
        case .notFound:
            setState(.upToDate(channel: channel))
        case let .downloading(update):
            setState(.downloading(channel: channel, update: update))
        case let .downloaded(update):
            setState(.readyToInstall(channel: channel, update: update))
        case let .installing(update):
            setState(.installing(channel: channel, update: update))
        case let .failed(message):
            setState(.failed(channel: channel, message: message))
        }
    }

    private func setState(_ newState: HQUpdaterState) {
        state = newState
        onStateChange?(newState)
    }
}
