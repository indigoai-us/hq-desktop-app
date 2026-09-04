import Foundation

/// REST domains that must be refreshed and applied before the app may call a
/// pass an authoritative reconciliation. The last three domains remain
/// unavailable until their deployed response contracts are captured.
enum HQAuthoritativeDomain: String, CaseIterable, Hashable, Sendable {
    case mobileConfiguration
    case membership
    case inbox
    case notifications
    case work
}

/// A typed, subject-bound REST snapshot. `availableDomains` describes decoded
/// server content, not merely successful HTTP responses.
struct HQAuthoritativeSnapshot: Sendable {
    let subjectID: String
    let mobileConfiguration: HQMobileConfiguration?
    let membership: HQMembershipResponse?
    let availableDomains: Set<HQAuthoritativeDomain>

    init(subjectID: String,
         mobileConfiguration: HQMobileConfiguration?,
         membership: HQMembershipResponse?,
         availableDomains: Set<HQAuthoritativeDomain>) {
        self.subjectID = subjectID
        self.mobileConfiguration = mobileConfiguration
        self.membership = membership
        self.availableDomains = availableDomains
    }
}

enum HQReconciliationError: Error, Equatable, Sendable {
    case staleIdentityFence
    case snapshotSubjectMismatch
    case authoritativeDomainsUnavailable(Set<HQAuthoritativeDomain>)
}

/// A generation token minted by the app-global owner. Every suspension point
/// in fetch/apply/mark is followed by a fence check, so an old account or old
/// foreground epoch cannot publish state into the new one.
struct HQReconciliationFence: Sendable {
    let subjectID: String
    let generation: UInt64
    private let current: @Sendable () async -> Bool

    init(subjectID: String, generation: UInt64,
         isCurrent: @escaping @Sendable () async -> Bool) {
        self.subjectID = subjectID
        self.generation = generation
        current = isCurrent
    }

    func isCurrent() async -> Bool { await current() }

    func checkCurrent() async throws {
        try Task.checkCancellation()
        guard await current() else { throw HQReconciliationError.staleIdentityFence }
    }
}

protocol HQAuthoritativeStateApplying: Sendable {
    /// Returns only domains committed to subject-scoped local state.
    func apply(_ snapshot: HQAuthoritativeSnapshot,
               fence: HQReconciliationFence) async throws -> Set<HQAuthoritativeDomain>
    func invalidate(fence: HQReconciliationFence) async
}

/// The production state boundary. Reads and writes are both subject/fence
/// scoped; switching identity makes the previous snapshot unreadable even if a
/// non-cooperative fetch finishes late.
actor HQAuthoritativeStateStore: HQAuthoritativeStateApplying {
    private struct StoredState: Sendable {
        let subjectID: String
        let generation: UInt64
        let mobileConfiguration: HQMobileConfiguration?
        let membership: HQMembershipResponse?
    }

    private var state: StoredState?
    private var newestGenerationSeen: UInt64?
    private var invalidatedThroughGeneration: UInt64?

    func apply(_ snapshot: HQAuthoritativeSnapshot,
               fence: HQReconciliationFence) async throws -> Set<HQAuthoritativeDomain> {
        guard snapshot.subjectID == fence.subjectID else {
            throw HQReconciliationError.snapshotSubjectMismatch
        }
        try await fence.checkCurrent()
        if let invalidatedThroughGeneration,
           fence.generation <= invalidatedThroughGeneration {
            throw HQReconciliationError.staleIdentityFence
        }
        if let newestGenerationSeen,
           fence.generation < newestGenerationSeen {
            throw HQReconciliationError.staleIdentityFence
        }

        var applied: Set<HQAuthoritativeDomain> = []
        if snapshot.availableDomains.contains(.mobileConfiguration), snapshot.mobileConfiguration != nil {
            applied.insert(.mobileConfiguration)
        }
        if snapshot.availableDomains.contains(.membership), snapshot.membership != nil {
            applied.insert(.membership)
        }

        // The actor-local generation guards close the gap between the external
        // fence observation and this commit. Future domain DTOs must be added
        // here before they can count as applied.
        newestGenerationSeen = max(newestGenerationSeen ?? fence.generation, fence.generation)
        state = StoredState(
            subjectID: fence.subjectID,
            generation: fence.generation,
            mobileConfiguration: snapshot.mobileConfiguration,
            membership: snapshot.membership
        )
        return applied
    }

    func snapshot(for fence: HQReconciliationFence) async -> HQAuthoritativeSnapshot? {
        guard await fence.isCurrent(),
              let state,
              state.subjectID == fence.subjectID,
              state.generation == fence.generation
        else { return nil }

        var available: Set<HQAuthoritativeDomain> = []
        if state.mobileConfiguration != nil { available.insert(.mobileConfiguration) }
        if state.membership != nil { available.insert(.membership) }
        return HQAuthoritativeSnapshot(
            subjectID: state.subjectID,
            mobileConfiguration: state.mobileConfiguration,
            membership: state.membership,
            availableDomains: available
        )
    }

    func invalidate(fence: HQReconciliationFence) {
        newestGenerationSeen = max(newestGenerationSeen ?? fence.generation, fence.generation)
        invalidatedThroughGeneration = max(invalidatedThroughGeneration ?? fence.generation, fence.generation)
        guard state?.subjectID == fence.subjectID,
              state?.generation == fence.generation
        else { return }
        state = nil
    }
}

enum HQRealtimeExternalBlocker: Hashable, Sendable {
    case liveBrokerAndCrossIdentityCanaryRequired
    case sequenceGapUnavailableInDeployedWakeContract
}

enum HQRealtimeAcceptance {
    /// Deployed wake envelopes do not carry a cursor or sequence. We retain a
    /// bounded foreground safety reconcile, but never claim sequence-gap proof.
    static let externalBlockers: Set<HQRealtimeExternalBlocker> = [
        .liveBrokerAndCrossIdentityCanaryRequired,
        .sequenceGapUnavailableInDeployedWakeContract
    ]
}

/// MQTT is only a wake signal. This actor is the sole path from a wake to
/// subject-scoped authoritative REST state.
actor HQReconciler {
    enum Reason: Equatable, Sendable {
        case boot
        case foreground
        case reconnect
        case sequenceGap
        case wake
        case polling
    }

    typealias Operation = @Sendable () async throws -> Void
    typealias Fetch = @Sendable (HQReconciliationFence) async throws -> HQAuthoritativeSnapshot

    private struct Flight {
        let id: UUID
        let task: Task<Void, Error>
    }

    private let fence: HQReconciliationFence?
    private let requiredDomains: Set<HQAuthoritativeDomain>
    private let fetch: Fetch?
    private let applier: (any HQAuthoritativeStateApplying)?
    private let legacyOperation: Operation?
    private let diagnostics: HQNetworkDiagnostics
    private let now: @Sendable () -> Date
    private var active: Flight?
    private var pending = false

    init(fence: HQReconciliationFence,
         requiredDomains: Set<HQAuthoritativeDomain> = Set(HQAuthoritativeDomain.allCases),
         diagnostics: HQNetworkDiagnostics = .shared,
         now: @escaping @Sendable () -> Date = { .now },
         fetch: @escaping Fetch,
         applier: any HQAuthoritativeStateApplying) {
        self.fence = fence
        self.requiredDomains = requiredDomains
        self.fetch = fetch
        self.applier = applier
        legacyOperation = nil
        self.diagnostics = diagnostics
        self.now = now
    }

    /// Compatibility for narrow protocol tests that count wake-triggered
    /// operations. Production construction uses the typed initializer above.
    init(diagnostics: HQNetworkDiagnostics = .shared,
         now: @escaping @Sendable () -> Date = { .now },
         operation: @escaping Operation) {
        fence = nil
        requiredDomains = []
        fetch = nil
        applier = nil
        legacyOperation = operation
        self.diagnostics = diagnostics
        self.now = now
    }

    /// Coalesces any burst into one active pass and at most one trailing pass.
    /// Failures are intentionally non-presentational; the lifecycle owner keeps
    /// a bounded safety loop without generating a modal error storm.
    func reconcile(_ reason: Reason) async throws {
        if let active {
            pending = true
            _ = try await active.task.value
            return
        }

        repeat {
            pending = false
            let id = UUID()
            let task = Task { try await self.performPass(reason: reason) }
            active = Flight(id: id, task: task)
            do {
                try await task.value
            } catch {
                if active?.id == id {
                    active = nil
                    pending = false
                }
                throw error
            }
            guard active?.id == id else { return }
            active = nil
        } while pending
    }

    func cancel() {
        active?.task.cancel()
        active = nil
        pending = false
    }

    private func performPass(reason _: Reason) async throws {
        if let legacyOperation {
            try Task.checkCancellation()
            try await legacyOperation()
            try Task.checkCancellation()
            await diagnostics.recordReconciliationCompleted(at: now())
            return
        }

        guard let fence, let fetch, let applier else {
            throw HQReconciliationError.authoritativeDomainsUnavailable(requiredDomains)
        }
        try await fence.checkCurrent()
        let snapshot = try await fetch(fence)
        try await fence.checkCurrent()
        guard snapshot.subjectID == fence.subjectID else {
            throw HQReconciliationError.snapshotSubjectMismatch
        }

        let applied = try await applier.apply(snapshot, fence: fence)
        try await fence.checkCurrent()
        let missing = requiredDomains.subtracting(applied)
        guard missing.isEmpty else {
            throw HQReconciliationError.authoritativeDomainsUnavailable(missing)
        }
        await diagnostics.recordReconciliationCompleted(at: now())
    }
}
