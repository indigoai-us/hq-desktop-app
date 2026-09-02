import ServiceManagement
import XCTest
@testable import HQNative

@MainActor
final class HQNativePlatformLaunchAtLoginTests: XCTestCase {
    func testMapsSystemStatuses() {
        XCTAssertEqual(makeService(status: .notRegistered).state, .disabled)
        XCTAssertEqual(makeService(status: .enabled).state, .enabled)
        XCTAssertEqual(makeService(status: .requiresApproval).state, .requiresApproval)
    }

    func testEnablingRegistersWhenNotRegistered() async throws {
        let driver = LaunchAtLoginDriverSpy(status: .notRegistered)
        let service = HQNativeLaunchAtLoginService(service: driver)

        try await service.setEnabled(true)

        XCTAssertEqual(driver.registerCallCount, 1)
        XCTAssertEqual(driver.unregisterCallCount, 0)
    }

    func testEnablingIsIdempotentWhenEnabledOrAwaitingApproval() async throws {
        for status in [SMAppService.Status.enabled, .requiresApproval] {
            let driver = LaunchAtLoginDriverSpy(status: status)
            let service = HQNativeLaunchAtLoginService(service: driver)

            try await service.setEnabled(true)

            XCTAssertEqual(driver.registerCallCount, 0)
            XCTAssertEqual(driver.unregisterCallCount, 0)
        }
    }

    func testDisablingUnregistersEnabledAndApprovalRequiredItems() async throws {
        for status in [SMAppService.Status.enabled, .requiresApproval] {
            let driver = LaunchAtLoginDriverSpy(status: status)
            let service = HQNativeLaunchAtLoginService(service: driver)

            try await service.setEnabled(false)

            XCTAssertEqual(driver.unregisterCallCount, 1)
            XCTAssertEqual(driver.registerCallCount, 0)
        }
    }

    func testDisablingIsIdempotentWhenAlreadyNotRegistered() async throws {
        let driver = LaunchAtLoginDriverSpy(status: .notRegistered)
        let service = HQNativeLaunchAtLoginService(service: driver)

        try await service.setEnabled(false)

        XCTAssertEqual(driver.registerCallCount, 0)
        XCTAssertEqual(driver.unregisterCallCount, 0)
    }

    func testMissingRegistrationCanBeRecreatedOrLeftDisabled() async throws {
        let enablingDriver = LaunchAtLoginDriverSpy(status: .notFound)
        let enablingService = HQNativeLaunchAtLoginService(service: enablingDriver)

        XCTAssertEqual(enablingService.state, .unavailable)
        try await enablingService.setEnabled(true)
        XCTAssertEqual(enablingDriver.registerCallCount, 1)

        let disablingDriver = LaunchAtLoginDriverSpy(status: .notFound)
        let disablingService = HQNativeLaunchAtLoginService(service: disablingDriver)
        try await disablingService.setEnabled(false)
        XCTAssertEqual(disablingDriver.registerCallCount, 0)
        XCTAssertEqual(disablingDriver.unregisterCallCount, 0)
    }

    func testRegisterFailurePropagates() async {
        let driver = LaunchAtLoginDriverSpy(status: .notRegistered)
        driver.registerError = LaunchAtLoginDriverTestError.registerFailed
        let service = HQNativeLaunchAtLoginService(service: driver)

        do {
            try await service.setEnabled(true)
            XCTFail("Expected register failure")
        } catch {
            XCTAssertEqual(error as? LaunchAtLoginDriverTestError, .registerFailed)
        }
    }

    func testUnregisterFailurePropagates() async {
        let driver = LaunchAtLoginDriverSpy(status: .enabled)
        driver.unregisterError = LaunchAtLoginDriverTestError.unregisterFailed
        let service = HQNativeLaunchAtLoginService(service: driver)

        do {
            try await service.setEnabled(false)
            XCTFail("Expected unregister failure")
        } catch {
            XCTAssertEqual(error as? LaunchAtLoginDriverTestError, .unregisterFailed)
        }
    }

    private func makeService(status: SMAppService.Status) -> HQNativeLaunchAtLoginService {
        HQNativeLaunchAtLoginService(service: LaunchAtLoginDriverSpy(status: status))
    }
}

private enum LaunchAtLoginDriverTestError: Error, Equatable {
    case registerFailed
    case unregisterFailed
}

@MainActor
private final class LaunchAtLoginDriverSpy: HQLaunchAtLoginDriving {
    let status: SMAppService.Status
    var registerError: Error?
    var unregisterError: Error?
    private(set) var registerCallCount = 0
    private(set) var unregisterCallCount = 0

    init(status: SMAppService.Status) {
        self.status = status
    }

    func register() throws {
        registerCallCount += 1
        if let registerError {
            throw registerError
        }
    }

    func unregister() async throws {
        unregisterCallCount += 1
        if let unregisterError {
            throw unregisterError
        }
    }
}
