import Foundation
import Sparkle

@MainActor
final class HQSparkleUpdaterDriver: NSObject, HQUpdaterDriving, SPUUpdaterDelegate {
    var eventHandler: ((HQUpdaterDriverEvent) -> Void)?

    private var feedURL: URL?
    private var initialCheckTask: Task<Void, Never>?
    private var hasStarted = false

    private lazy var standardUpdaterController = SPUStandardUpdaterController(
        startingUpdater: false,
        updaterDelegate: self,
        userDriverDelegate: nil
    )

    var canCheckForUpdates: Bool {
        standardUpdaterController.updater.canCheckForUpdates
    }

    func start(feedURL: URL, policy: HQUpdateSchedulingPolicy) throws {
        self.feedURL = feedURL

        let updater = standardUpdaterController.updater
        updater.automaticallyChecksForUpdates = policy.automaticallyChecks
        updater.updateCheckInterval = policy.periodicCheckInterval
        updater.automaticallyDownloadsUpdates = policy.automaticallyInstalls

        if hasStarted {
            updater.resetUpdateCycleAfterShortDelay()
        } else {
            do {
                try updater.start()
                hasStarted = true
            } catch {
                eventHandler?(.failed(message: error.localizedDescription))
                throw error
            }
        }

        scheduleInitialBackgroundCheck(
            after: policy.initialCheckDelay,
            updater: updater
        )
    }

    func checkForUpdates() {
        standardUpdaterController.updater.checkForUpdateInformation()
    }

    func presentAvailableUpdate() {
        standardUpdaterController.checkForUpdates(nil)
    }

    func feedURLString(for updater: SPUUpdater) -> String? {
        feedURL?.absoluteString
    }

    func updater(
        _ updater: SPUUpdater,
        didFindValidUpdate item: SUAppcastItem
    ) {
        eventHandler?(.found(descriptor(for: item)))
    }

    func updaterDidNotFindUpdate(_ updater: SPUUpdater) {
        eventHandler?(.notFound)
    }

    func updater(
        _ updater: SPUUpdater,
        willDownloadUpdate item: SUAppcastItem,
        with request: NSMutableURLRequest
    ) {
        eventHandler?(.downloading(descriptor(for: item)))
    }

    func updater(
        _ updater: SPUUpdater,
        didDownloadUpdate item: SUAppcastItem
    ) {
        eventHandler?(.downloaded(descriptor(for: item)))
    }

    func updater(
        _ updater: SPUUpdater,
        willInstallUpdate item: SUAppcastItem
    ) {
        eventHandler?(.installing(descriptor(for: item)))
    }

    func updater(
        _ updater: SPUUpdater,
        failedToDownloadUpdate item: SUAppcastItem,
        error: any Error
    ) {
        eventHandler?(.failed(message: error.localizedDescription))
    }

    func updater(
        _ updater: SPUUpdater,
        didAbortWithError error: any Error
    ) {
        let nsError = error as NSError
        guard nsError.code != SUError.noUpdateError.rawValue,
              nsError.code != SUError.installationCanceledError.rawValue
        else {
            return
        }

        eventHandler?(.failed(message: error.localizedDescription))
    }

    private func scheduleInitialBackgroundCheck(
        after delay: TimeInterval,
        updater: SPUUpdater
    ) {
        initialCheckTask?.cancel()
        let nanoseconds = UInt64(max(0, delay) * 1_000_000_000)
        initialCheckTask = Task { @MainActor [weak self, weak updater] in
            do {
                try await Task.sleep(nanoseconds: nanoseconds)
            } catch {
                return
            }

            guard self != nil,
                  let updater,
                  updater.automaticallyChecksForUpdates,
                  !updater.sessionInProgress
            else {
                return
            }

            updater.checkForUpdateInformation()
        }
    }

    private func descriptor(for item: SUAppcastItem) -> HQUpdateDescriptor {
        HQUpdateDescriptor(
            version: item.versionString,
            displayVersion: item.displayVersionString,
            releaseNotesURL: item.releaseNotesURL
        )
    }
}
