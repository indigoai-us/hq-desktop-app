import Foundation
import SwiftUI

protocol HQRealtimeControlling: Sendable {
    func foregrounded() async
    func boot() async
    func backgrounded() async
}

extension HQRealtimeClient: HQRealtimeControlling {}

struct HQRealtimeRuntime: Sendable {
    let client: any HQRealtimeControlling
    let reconciler: HQReconciler
    let invalidateAuthoritativeState: @Sendable () async -> Void

    init(client: any HQRealtimeControlling,
         reconciler: HQReconciler,
         invalidateAuthoritativeState: @escaping @Sendable () async -> Void = {}) {
        self.client = client
        self.reconciler = reconciler
        self.invalidateAuthoritativeState = invalidateAuthoritativeState
    }
}

/// Pure scene classification. Networking ownership lives one level above each
/// WindowGroup scene so multiple windows can never create multiple sockets.
enum HQSceneLifecycle {
    static func isForeground(_ phase: ScenePhase) -> Bool { phase == .active }
}

/// One instance is created by `HQIOSApp` and shared by every WindowGroup root.
/// All public mutations are synchronous on MainActor: the identity generation
/// is invalidated before any teardown await can yield.
@MainActor
final class HQAppRealtimeOwner: ObservableObject {
    typealias Factory = @MainActor @Sendable (HQReconciliationFence) throws -> HQRealtimeRuntime

    private let factory: Factory
    private var subjectID: String?
    private var generation: UInt64 = 0
    private var foregroundScenes: Set<UUID> = []
    private var runtime: HQRealtimeRuntime?
    private var transition: Task<Void, Never>?
    private var bootedSubjectID: String?

    private(set) var activeSubjectID: String?

    init(factory: @escaping Factory) {
        self.factory = factory
    }

    func sessionChanged(subjectID nextSubjectID: String?) {
        let normalized = nextSubjectID?.trimmingCharacters(in: .whitespacesAndNewlines)
        let next = normalized.flatMap { $0.isEmpty ? nil : $0 }
        guard next != subjectID else {
            startIfNeeded()
            return
        }

        subjectID = next
        activeSubjectID = next
        bootedSubjectID = nil
        rebuildRuntime()
    }

    func sceneChanged(_ sceneID: UUID, phase: ScenePhase) {
        let wasForeground = !foregroundScenes.isEmpty
        if HQSceneLifecycle.isForeground(phase) {
            foregroundScenes.insert(sceneID)
        } else {
            foregroundScenes.remove(sceneID)
        }
        guard wasForeground != !foregroundScenes.isEmpty else { return }
        rebuildRuntime()
    }

    func sceneRemoved(_ sceneID: UUID) {
        let wasForeground = !foregroundScenes.isEmpty
        foregroundScenes.remove(sceneID)
        if wasForeground, foregroundScenes.isEmpty { rebuildRuntime() }
    }

    private func startIfNeeded() {
        guard runtime == nil, subjectID != nil, !foregroundScenes.isEmpty else { return }
        rebuildRuntime()
    }

    private func rebuildRuntime() {
        generation &+= 1
        let epoch = generation
        transition?.cancel()
        let previous = runtime
        runtime = nil

        guard let subjectID, !foregroundScenes.isEmpty else {
            transition = teardown(previous)
            return
        }

        let fence = HQReconciliationFence(subjectID: subjectID, generation: epoch) { [weak self] in
            await MainActor.run {
                self?.isCurrent(subjectID: subjectID, generation: epoch) == true
            }
        }

        let next: HQRealtimeRuntime
        do {
            next = try factory(fence)
        } catch {
            // Construction failures stay non-modal. A later scene/session
            // transition can retry without retaining server error text.
            transition = teardown(previous)
            return
        }
        runtime = next
        let needsBoot = bootedSubjectID != subjectID

        transition = Task { [weak self] in
            await Self.stop(previous)
            guard !Task.isCancelled, self?.isCurrent(subjectID: subjectID, generation: epoch) == true else {
                return
            }

            await next.client.foregrounded()
            guard !Task.isCancelled, self?.isCurrent(subjectID: subjectID, generation: epoch) == true else {
                return
            }

            if needsBoot {
                await next.client.boot()
                guard !Task.isCancelled, self?.isCurrent(subjectID: subjectID, generation: epoch) == true else {
                    return
                }
                self?.bootedSubjectID = subjectID
            }
        }
    }

    private func teardown(_ runtime: HQRealtimeRuntime?) -> Task<Void, Never>? {
        guard let runtime else { return nil }
        return Task { await Self.stop(runtime) }
    }

    private static func stop(_ runtime: HQRealtimeRuntime?) async {
        guard let runtime else { return }
        await runtime.reconciler.cancel()
        await runtime.client.backgrounded()
        await runtime.invalidateAuthoritativeState()
    }

    private func isCurrent(subjectID: String, generation: UInt64) -> Bool {
        self.subjectID == subjectID && self.generation == generation &&
            runtime != nil && !foregroundScenes.isEmpty
    }
}
