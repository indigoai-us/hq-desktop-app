import Foundation
import XCTest
@testable import HQNative

@MainActor
final class HQNativeUpdaterServiceTests: XCTestCase {
    private let releaseDownloadBaseURL = URL(
        string: "https://github.com/indigoai-us/hq-desktop-app/releases/download/"
    )!

    func testReleaseChannelsUseDedicatedGitHubReleaseAssets() {
        XCTAssertEqual(
            HQReleaseChannel.stable.appcastURL(
                releaseDownloadBaseURL: releaseDownloadBaseURL
            ).absoluteString,
            "https://github.com/indigoai-us/hq-desktop-app/releases/download/sparkle-stable/appcast.xml"
        )
        XCTAssertEqual(
            HQReleaseChannel.beta.appcastURL(
                releaseDownloadBaseURL: releaseDownloadBaseURL
            ).absoluteString,
            "https://github.com/indigoai-us/hq-desktop-app/releases/download/sparkle-beta/appcast.xml"
        )
        XCTAssertEqual(
            HQReleaseChannel.alpha.appcastURL(
                releaseDownloadBaseURL: releaseDownloadBaseURL
            ).absoluteString,
            "https://github.com/indigoai-us/hq-desktop-app/releases/download/sparkle-alpha/appcast.xml"
        )
    }

    func testNonIndigoUsersAreRestrictedToStable() {
        XCTAssertEqual(HQReleaseChannel.availableChannels(isIndigoUser: false), [.stable])

        for preferredChannel in HQReleaseChannel.allCases {
            XCTAssertEqual(
                HQReleaseChannel.effective(
                    preferredChannel: preferredChannel,
                    isIndigoUser: false
                ),
                .stable
            )
        }
    }

    func testIndigoUsersDefaultToBetaAndCanSelectEveryChannel() {
        XCTAssertEqual(
            HQReleaseChannel.availableChannels(isIndigoUser: true),
            [.stable, .beta, .alpha]
        )
        XCTAssertEqual(
            HQReleaseChannel.effective(preferredChannel: nil, isIndigoUser: true),
            .beta
        )

        for preferredChannel in HQReleaseChannel.allCases {
            XCTAssertEqual(
                HQReleaseChannel.effective(
                    preferredChannel: preferredChannel,
                    isIndigoUser: true
                ),
                preferredChannel
            )
        }
    }

    func testStartConfiguresTheEffectiveFeedAndIdleState() throws {
        let driver = UpdaterDriverSpy()
        let service = HQNativeUpdaterService(
            driver: driver,
            releaseDownloadBaseURL: releaseDownloadBaseURL
        )

        try service.start(preferredChannel: .alpha, isIndigoUser: true)

        XCTAssertEqual(
            driver.startedFeedURL?.absoluteString,
            "https://github.com/indigoai-us/hq-desktop-app/releases/download/sparkle-alpha/appcast.xml"
        )
        XCTAssertEqual(driver.startCallCount, 1)
        XCTAssertEqual(service.state, .idle(channel: .alpha))
        XCTAssertEqual(driver.startedPolicy, .legacy)
    }

    func testLegacyScheduleChecksAfterTenSecondsThenEverySixHours() {
        XCTAssertEqual(HQUpdateSchedulingPolicy.legacy.initialCheckDelay, 10)
        XCTAssertEqual(
            HQUpdateSchedulingPolicy.legacy.periodicCheckInterval,
            6 * 60 * 60
        )
        XCTAssertTrue(HQUpdateSchedulingPolicy.legacy.automaticallyChecks)
        XCTAssertFalse(HQUpdateSchedulingPolicy.legacy.automaticallyInstalls)
    }

    func testStartFailsClosedForAnInsecureAppcastBaseURL() {
        let service = HQNativeUpdaterService(
            driver: UpdaterDriverSpy(),
            releaseDownloadBaseURL: URL(
                string: "http://github.com/indigoai-us/hq-desktop-app/releases/download/"
            )!
        )

        XCTAssertThrowsError(
            try service.start(preferredChannel: .stable, isIndigoUser: false)
        ) { error in
            XCTAssertEqual(error as? HQUpdaterError, .insecureFeedURL)
        }
    }

    func testCheckForUpdatesTransitionsToCheckingAndCallsDriver() throws {
        let driver = UpdaterDriverSpy()
        let service = try makeStartedService(driver: driver)

        try service.checkForUpdates()

        XCTAssertEqual(service.state, .checking(channel: .beta))
        XCTAssertEqual(driver.checkCallCount, 1)
    }

    func testCheckForUpdatesRejectsAnUnavailableDriver() throws {
        let driver = UpdaterDriverSpy()
        driver.canCheckForUpdates = false
        let service = try makeStartedService(driver: driver)

        XCTAssertThrowsError(try service.checkForUpdates()) { error in
            XCTAssertEqual(error as? HQUpdaterError, .cannotCheckForUpdates)
        }
        XCTAssertEqual(service.state, .idle(channel: .beta))
        XCTAssertEqual(driver.checkCallCount, 0)
    }

    func testDriverEventsProduceExplicitUpdateLifecycleStates() throws {
        let driver = UpdaterDriverSpy()
        let service = try makeStartedService(driver: driver)
        let update = HQUpdateDescriptor(
            version: "0.11.0-beta.2",
            displayVersion: "0.11.0-beta.2",
            releaseNotesURL: URL(
                string: "https://github.com/indigoai-us/hq-desktop-app/releases/tag/v0.11.0-beta.2"
            )
        )

        driver.send(.found(update))
        XCTAssertEqual(service.state, .available(channel: .beta, update: update))

        driver.send(.downloading(update))
        XCTAssertEqual(service.state, .downloading(channel: .beta, update: update))

        driver.send(.downloaded(update))
        XCTAssertEqual(service.state, .readyToInstall(channel: .beta, update: update))

        driver.send(.installing(update))
        XCTAssertEqual(service.state, .installing(channel: .beta, update: update))
    }

    func testNotFoundAndFailureEventsCompleteTheCheckCycle() throws {
        let driver = UpdaterDriverSpy()
        let service = try makeStartedService(driver: driver)

        try service.checkForUpdates()
        driver.send(.notFound)
        XCTAssertEqual(service.state, .upToDate(channel: .beta))

        try service.checkForUpdates()
        driver.send(.failed(message: "The update signature is invalid."))
        XCTAssertEqual(
            service.state,
            .failed(
                channel: .beta,
                message: "The update signature is invalid."
            )
        )
    }

    func testPresentAvailableUpdateDelegatesOnlyWhenAnUpdateExists() throws {
        let driver = UpdaterDriverSpy()
        let service = try makeStartedService(driver: driver)
        let update = HQUpdateDescriptor(
            version: "0.11.0",
            displayVersion: "0.11",
            releaseNotesURL: nil
        )

        XCTAssertThrowsError(try service.presentAvailableUpdate()) { error in
            XCTAssertEqual(error as? HQUpdaterError, .noAvailableUpdate)
        }
        XCTAssertEqual(driver.presentCallCount, 0)

        driver.send(.found(update))
        try service.presentAvailableUpdate()

        XCTAssertEqual(driver.presentCallCount, 1)
    }

    func testStateChangesAreObservableWithoutBindingToSparkle() throws {
        let driver = UpdaterDriverSpy()
        let service = HQNativeUpdaterService(
            driver: driver,
            releaseDownloadBaseURL: releaseDownloadBaseURL
        )
        var observedStates: [HQUpdaterState] = []
        service.onStateChange = { observedStates.append($0) }

        try service.start(preferredChannel: nil, isIndigoUser: true)
        try service.checkForUpdates()
        driver.send(.notFound)

        XCTAssertEqual(
            observedStates,
            [
                .idle(channel: .beta),
                .checking(channel: .beta),
                .upToDate(channel: .beta),
            ]
        )
    }

    private func makeStartedService(
        driver: UpdaterDriverSpy
    ) throws -> HQNativeUpdaterService {
        let service = HQNativeUpdaterService(
            driver: driver,
            releaseDownloadBaseURL: releaseDownloadBaseURL
        )
        try service.start(preferredChannel: nil, isIndigoUser: true)
        return service
    }
}

@MainActor
private final class UpdaterDriverSpy: HQUpdaterDriving {
    var canCheckForUpdates = true
    var eventHandler: ((HQUpdaterDriverEvent) -> Void)?
    private(set) var startedFeedURL: URL?
    private(set) var startedPolicy: HQUpdateSchedulingPolicy?
    private(set) var startCallCount = 0
    private(set) var checkCallCount = 0
    private(set) var presentCallCount = 0

    func start(feedURL: URL, policy: HQUpdateSchedulingPolicy) throws {
        startCallCount += 1
        startedFeedURL = feedURL
        startedPolicy = policy
    }

    func checkForUpdates() {
        checkCallCount += 1
    }

    func presentAvailableUpdate() {
        presentCallCount += 1
    }

    func send(_ event: HQUpdaterDriverEvent) {
        eventHandler?(event)
    }
}
