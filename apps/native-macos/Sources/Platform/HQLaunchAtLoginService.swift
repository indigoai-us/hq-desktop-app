import ServiceManagement

enum HQLaunchAtLoginState: Equatable, Sendable {
    case disabled
    case enabled
    case requiresApproval
    case unavailable
}

@MainActor
protocol HQLaunchAtLoginDriving {
    var status: SMAppService.Status { get }

    func register() throws
    func unregister() async throws
}

@MainActor
final class HQSystemLaunchAtLoginDriver: HQLaunchAtLoginDriving {
    private let service: SMAppService

    init(service: SMAppService = .mainApp) {
        self.service = service
    }

    var status: SMAppService.Status {
        service.status
    }

    func register() throws {
        try service.register()
    }

    func unregister() async throws {
        try await service.unregister()
    }
}

@MainActor
final class HQNativeLaunchAtLoginService {
    private let service: any HQLaunchAtLoginDriving

    init(service: any HQLaunchAtLoginDriving = HQSystemLaunchAtLoginDriver()) {
        self.service = service
    }

    var state: HQLaunchAtLoginState {
        switch service.status {
        case .notRegistered:
            .disabled
        case .enabled:
            .enabled
        case .requiresApproval:
            .requiresApproval
        case .notFound:
            .unavailable
        @unknown default:
            .unavailable
        }
    }

    func setEnabled(_ isEnabled: Bool) async throws {
        switch (isEnabled, service.status) {
        case (true, .notRegistered), (true, .notFound):
            try service.register()
        case (false, .enabled), (false, .requiresApproval):
            try await service.unregister()
        case (true, .enabled),
             (true, .requiresApproval),
             (false, .notRegistered),
             (false, .notFound):
            return
        @unknown default:
            return
        }
    }
}
