import XCTest
@testable import HQIOS

final class HQRealtimeLifecycleTests: XCTestCase {
    func testPartialAuthoritativePassAppliesKnownDomainsButDoesNotRecordFullMarker() async throws {
        let diagnostics = HQNetworkDiagnostics()
        let current = FenceProbe(current: true)
        let fence = HQReconciliationFence(subjectID: "subject-a", generation: 1) {
            await current.value()
        }
        let applier = ApplyingProbe(domains: [.mobileConfiguration, .membership])
        let reconciler = HQReconciler(
            fence: fence,
            requiredDomains: Set(HQAuthoritativeDomain.allCases),
            diagnostics: diagnostics,
            fetch: { fence in .knownContractSnapshot(subjectID: fence.subjectID) },
            applier: applier
        )

        do {
            try await reconciler.reconcile(.boot)
            XCTFail("A partial authoritative pass must not be reported as complete")
        } catch let error as HQReconciliationError {
            XCTAssertEqual(error, .authoritativeDomainsUnavailable([.inbox, .notifications, .work]))
        }

        let applyCount = await applier.applyCount()
        let lastReconciliationAt = await diagnostics.snapshot().lastReconciliationAt
        XCTAssertEqual(applyCount, 1)
        XCTAssertNil(lastReconciliationAt)
    }

    func testCompleteAuthoritativePassRecordsMarkerOnlyAfterApply() async throws {
        let diagnostics = HQNetworkDiagnostics()
        let current = FenceProbe(current: true)
        let fence = HQReconciliationFence(subjectID: "subject-a", generation: 4) {
            await current.value()
        }
        let applier = ApplyingProbe(domains: [.mobileConfiguration, .membership])
        let completedAt = Date(timeIntervalSince1970: 123)
        let reconciler = HQReconciler(
            fence: fence,
            requiredDomains: [.mobileConfiguration, .membership],
            diagnostics: diagnostics,
            now: { completedAt },
            fetch: { fence in .knownContractSnapshot(subjectID: fence.subjectID) },
            applier: applier
        )

        try await reconciler.reconcile(.foreground)

        let applyCount = await applier.applyCount()
        let lastReconciliationAt = await diagnostics.snapshot().lastReconciliationAt
        XCTAssertEqual(applyCount, 1)
        XCTAssertEqual(lastReconciliationAt, completedAt)
    }

    func testIdentityFenceRejectsAStaleFetchBeforeItCanApplyOrMark() async throws {
        let diagnostics = HQNetworkDiagnostics()
        let current = FenceProbe(current: true)
        let fetchGate = SuspensionGate()
        let fetchStarted = AsyncCounter()
        let fence = HQReconciliationFence(subjectID: "subject-a", generation: 7) {
            await current.value()
        }
        let applier = ApplyingProbe(domains: [.mobileConfiguration, .membership])
        let reconciler = HQReconciler(
            fence: fence,
            requiredDomains: [.mobileConfiguration, .membership],
            diagnostics: diagnostics,
            fetch: { fence in
                await fetchStarted.increment()
                await fetchGate.wait()
                return .knownContractSnapshot(subjectID: fence.subjectID)
            },
            applier: applier
        )

        let reconcile = Task { try await reconciler.reconcile(.wake) }
        await Self.eventually { await fetchStarted.value() == 1 }
        await current.set(false)
        await fetchGate.open()

        do {
            try await reconcile.value
            XCTFail("A stale subject generation must fail closed")
        } catch let error as HQReconciliationError {
            XCTAssertEqual(error, .staleIdentityFence)
        }
        let applyCount = await applier.applyCount()
        let lastReconciliationAt = await diagnostics.snapshot().lastReconciliationAt
        XCTAssertEqual(applyCount, 0)
        XCTAssertNil(lastReconciliationAt)
    }

    func testBurstCoalescesIntoOneActiveAndAtMostOneTrailingPass() async throws {
        let current = FenceProbe(current: true)
        let firstFetchGate = SuspensionGate()
        let fetches = FetchProbe(firstGate: firstFetchGate)
        let fence = HQReconciliationFence(subjectID: "subject-a", generation: 9) {
            await current.value()
        }
        let reconciler = HQReconciler(
            fence: fence,
            requiredDomains: [],
            diagnostics: HQNetworkDiagnostics(),
            fetch: { fence in try await fetches.fetch(subjectID: fence.subjectID) },
            applier: ApplyingProbe(domains: [])
        )

        let first = Task { try await reconciler.reconcile(.wake) }
        await Self.eventually { await fetches.count() == 1 }
        let second = Task { try await reconciler.reconcile(.wake) }
        let third = Task { try await reconciler.reconcile(.polling) }
        for _ in 0 ..< 20 { await Task.yield() }
        await firstFetchGate.open()

        _ = try await (first.value, second.value, third.value)
        let fetchCount = await fetches.count()
        XCTAssertEqual(fetchCount, 2)
    }

    func testCancellationPreventsOldFlightFromClearingOrMarkingOverANewerFlight() async throws {
        let current = FenceProbe(current: true)
        let firstFetchGate = SuspensionGate()
        let fetches = FetchProbe(firstGate: firstFetchGate)
        let diagnostics = HQNetworkDiagnostics()
        let fence = HQReconciliationFence(subjectID: "subject-a", generation: 11) {
            await current.value()
        }
        let reconciler = HQReconciler(
            fence: fence,
            requiredDomains: [],
            diagnostics: diagnostics,
            fetch: { fence in try await fetches.fetch(subjectID: fence.subjectID) },
            applier: ApplyingProbe(domains: [])
        )

        let cancelledFlight = Task { try await reconciler.reconcile(.wake) }
        await Self.eventually { await fetches.count() == 1 }
        await reconciler.cancel()
        let replacementFlight = Task { try await reconciler.reconcile(.foreground) }
        await Self.eventually { await fetches.count() == 2 }
        try await replacementFlight.value
        await firstFetchGate.open()

        do {
            try await cancelledFlight.value
            XCTFail("The cancelled generation must not complete")
        } catch is CancellationError {
        }
        let fetchCount = await fetches.count()
        let marker = await diagnostics.snapshot().lastReconciliationAt
        XCTAssertEqual(fetchCount, 2)
        XCTAssertNotNil(marker, "The replacement flight remains authoritative")
    }

    func testOldGenerationInvalidationCannotEraseNewSubjectState() async throws {
        let firstCurrent = FenceProbe(current: true)
        let secondCurrent = FenceProbe(current: true)
        let firstFence = HQReconciliationFence(subjectID: "subject-a", generation: 1) {
            await firstCurrent.value()
        }
        let secondFence = HQReconciliationFence(subjectID: "subject-b", generation: 2) {
            await secondCurrent.value()
        }
        let store = HQAuthoritativeStateStore()

        _ = try await store.apply(.empty(subjectID: "subject-a"), fence: firstFence)
        await firstCurrent.set(false)
        _ = try await store.apply(.empty(subjectID: "subject-b"), fence: secondFence)
        await store.invalidate(fence: firstFence)

        let currentSnapshot = await store.snapshot(for: secondFence)
        XCTAssertEqual(currentSnapshot?.subjectID, "subject-b")
    }

    func testStoreRejectsOlderGenerationAfterNewerSubjectHasCommitted() async throws {
        // Models the TOCTOU edge where an old apply already observed its
        // external fence as current before an account switch reached the
        // state-store actor.
        let oldFence = HQReconciliationFence(subjectID: "subject-a", generation: 1) { true }
        let newFence = HQReconciliationFence(subjectID: "subject-b", generation: 2) { true }
        let store = HQAuthoritativeStateStore()

        _ = try await store.apply(.empty(subjectID: "subject-b"), fence: newFence)

        do {
            _ = try await store.apply(.empty(subjectID: "subject-a"), fence: oldFence)
            XCTFail("An older generation must not overwrite newer subject state")
        } catch let error as HQReconciliationError {
            XCTAssertEqual(error, .staleIdentityFence)
        }

        let currentSnapshot = await store.snapshot(for: newFence)
        XCTAssertEqual(currentSnapshot?.subjectID, "subject-b")
    }

    func testInvalidatedGenerationCannotCommitAgainAfterTeardown() async throws {
        // Models an apply continuation resuming after sign-out invalidation.
        // Its earlier external fence observation cannot authorize a late
        // subject-state commit.
        let fence = HQReconciliationFence(subjectID: "subject-a", generation: 3) { true }
        let store = HQAuthoritativeStateStore()

        _ = try await store.apply(.empty(subjectID: "subject-a"), fence: fence)
        await store.invalidate(fence: fence)

        do {
            _ = try await store.apply(.empty(subjectID: "subject-a"), fence: fence)
            XCTFail("An invalidated generation must remain tombstoned")
        } catch let error as HQReconciliationError {
            XCTAssertEqual(error, .staleIdentityFence)
        }

        let invalidatedSnapshot = await store.snapshot(for: fence)
        XCTAssertNil(invalidatedSnapshot)
    }

    @MainActor
    func testAppOwnerStoresNoIndependentPollingScheduler() {
        let factory = RuntimeFactoryProbe()
        let owner = HQAppRealtimeOwner { fence in factory.makeRuntime(fence: fence) }
        let storedProperties = Set(Mirror(reflecting: owner).children.compactMap(\.label))
        let forbiddenSchedulerState: Set<String> = ["safetyPoll", "safetyPollInterval", "sleep"]

        XCTAssertTrue(
            storedProperties.isDisjoint(with: forbiddenSchedulerState),
            "The app owner must not retain an independent timer, interval, or sleep policy"
        )
    }

    @MainActor
    func testAppOwnerDoesNotReconcileIndependentlyWhileActive() async {
        let factory = RuntimeFactoryProbe()
        let owner = HQAppRealtimeOwner { fence in factory.makeRuntime(fence: fence) }
        let scene = UUID()

        owner.sessionChanged(subjectID: "subject-a")
        owner.sceneChanged(scene, phase: .active)
        await Self.eventually { await factory.service(for: "subject-a")?.bootCount() == 1 }
        for _ in 0 ..< 50 { await Task.yield() }

        let ownerReconciliations = await factory.reconcileCount(for: "subject-a")
        XCTAssertEqual(ownerReconciliations, 0, "The app owner must delegate polling to its realtime client")
        owner.sessionChanged(subjectID: nil)
    }

    @MainActor
    func testOneAppOwnerSharesOneRuntimeAcrossTwoActiveScenes() async {
        let factory = RuntimeFactoryProbe()
        let owner = HQAppRealtimeOwner { fence in factory.makeRuntime(fence: fence) }
        let sceneOne = UUID()
        let sceneTwo = UUID()

        owner.sessionChanged(subjectID: "subject-a")
        owner.sceneChanged(sceneOne, phase: .active)
        owner.sceneChanged(sceneTwo, phase: .active)
        await Self.eventually { await factory.makeCount() == 1 }
        let service = factory.service(for: "subject-a")!
        await Self.eventually {
            let foregrounds = await service.foregroundCount()
            let boots = await service.bootCount()
            return foregrounds == 1 && boots == 1
        }

        owner.sceneChanged(sceneOne, phase: .background)
        for _ in 0 ..< 20 { await Task.yield() }
        let partialBackgroundCount = await service.backgroundCount()
        XCTAssertEqual(partialBackgroundCount, 0)

        owner.sceneChanged(sceneTwo, phase: .background)
        await Self.eventually { await service.backgroundCount() == 1 }
        XCTAssertEqual(factory.makeCount(), 1)

        owner.sceneChanged(sceneOne, phase: .active)
        await Self.eventually { await factory.makeCount() == 2 }
        let resumedService = factory.service(for: "subject-a")!
        await Self.eventually { await resumedService.foregroundCount() == 1 }
        let resumedBoots = await resumedService.bootCount()
        XCTAssertEqual(resumedBoots, 0, "Boot runs once per authenticated subject, not once per scene epoch")
    }

    @MainActor
    func testAccountSwitchInvalidatesOldGenerationBeforeAwaitedForegroundCompletes() async {
        let firstForegroundGate = SuspensionGate()
        let factory = RuntimeFactoryProbe(foregroundGates: ["subject-a": firstForegroundGate])
        let owner = HQAppRealtimeOwner { fence in factory.makeRuntime(fence: fence) }
        let scene = UUID()

        owner.sessionChanged(subjectID: "subject-a")
        owner.sceneChanged(scene, phase: .active)
        await Self.eventually { await factory.service(for: "subject-a")?.foregroundCount() == 1 }
        let first = factory.service(for: "subject-a")!

        owner.sessionChanged(subjectID: "subject-b")
        await Self.eventually { await first.backgroundCount() == 1 }
        await firstForegroundGate.open()
        await Self.eventually { await factory.service(for: "subject-b")?.bootCount() == 1 }
        let second = factory.service(for: "subject-b")!

        let firstBoots = await first.bootCount()
        let secondForegrounds = await second.foregroundCount()
        let firstFenceCurrent = await factory.fence(for: "subject-a")!.isCurrent()
        let secondFenceCurrent = await factory.fence(for: "subject-b")!.isCurrent()
        XCTAssertEqual(firstBoots, 0)
        XCTAssertEqual(secondForegrounds, 1)
        XCTAssertFalse(firstFenceCurrent)
        XCTAssertTrue(secondFenceCurrent)
        for _ in 0 ..< 50 { await Task.yield() }
        let firstBackgrounds = await first.backgroundCount()
        XCTAssertEqual(firstBackgrounds, 1, "A canceled transition must not stop an old client scheduler twice")
    }

    @MainActor
    func testRapidAccountSwitchesStopEachSupersededRuntimeOnceWithoutStoppingCurrentRuntime() async {
        let firstForegroundGate = SuspensionGate()
        let secondForegroundGate = SuspensionGate()
        let factory = RuntimeFactoryProbe(foregroundGates: [
            "subject-a": firstForegroundGate,
            "subject-b": secondForegroundGate
        ])
        let owner = HQAppRealtimeOwner { fence in factory.makeRuntime(fence: fence) }
        let scene = UUID()

        owner.sessionChanged(subjectID: "subject-a")
        owner.sceneChanged(scene, phase: .active)
        await Self.eventually("first foreground starts") {
            await factory.service(for: "subject-a")?.foregroundCount() == 1
        }
        let first = factory.service(for: "subject-a")!

        owner.sessionChanged(subjectID: "subject-b")
        await Self.eventually("first runtime stops and second foreground starts") {
            let firstStops = await first.backgroundCount()
            let secondForegrounds = await factory.service(for: "subject-b")?.foregroundCount()
            return firstStops == 1 && secondForegrounds == 1
        }
        let second = factory.service(for: "subject-b")!

        owner.sessionChanged(subjectID: "subject-c")
        await Self.eventually("second runtime stops and third runtime boots") {
            let secondStops = await second.backgroundCount()
            let thirdBoots = await factory.service(for: "subject-c")?.bootCount()
            return secondStops == 1 && thirdBoots == 1
        }
        let third = factory.service(for: "subject-c")!

        await firstForegroundGate.open()
        await secondForegroundGate.open()
        for _ in 0 ..< 100 { await Task.yield() }

        let firstStops = await first.backgroundCount()
        let secondStops = await second.backgroundCount()
        let thirdStops = await third.backgroundCount()
        let firstBoots = await first.bootCount()
        let secondBoots = await second.bootCount()
        let thirdBoots = await third.bootCount()
        XCTAssertEqual(firstStops, 1)
        XCTAssertEqual(secondStops, 1)
        XCTAssertEqual(thirdStops, 0)
        XCTAssertEqual(firstBoots, 0)
        XCTAssertEqual(secondBoots, 0)
        XCTAssertEqual(thirdBoots, 1)

        owner.sessionChanged(subjectID: nil)
        await Self.eventually("current runtime cleanup") { await third.backgroundCount() == 1 }
    }

    @MainActor
    func testRapidBackgroundThenForegroundDoesNotOrphanTheSupersededRuntime() async {
        let factory = RuntimeFactoryProbe()
        let owner = HQAppRealtimeOwner { fence in factory.makeRuntime(fence: fence) }
        let scene = UUID()

        owner.sessionChanged(subjectID: "subject-a")
        owner.sceneChanged(scene, phase: .active)
        await Self.eventually("initial runtime boot") { await factory.service(for: "subject-a")?.bootCount() == 1 }
        let first = factory.service(for: "subject-a")!

        owner.sceneChanged(scene, phase: .background)
        owner.sceneChanged(scene, phase: .active)
        await Self.eventually("replacement runtime foreground") {
            let makes = await factory.makeCount()
            let foregrounds = await factory.service(for: "subject-a")?.foregroundCount()
            return makes == 2 && foregrounds == 1
        }
        let second = factory.service(for: "subject-a")!
        await Self.eventually("superseded runtime stop") { await first.backgroundCount() == 1 }
        for _ in 0 ..< 50 { await Task.yield() }

        let firstStops = await first.backgroundCount()
        let secondStops = await second.backgroundCount()
        let secondBoots = await second.bootCount()
        XCTAssertEqual(firstStops, 1)
        XCTAssertEqual(secondStops, 0)
        XCTAssertEqual(secondBoots, 0)

        owner.sessionChanged(subjectID: nil)
        await Self.eventually("replacement runtime cleanup") { await second.backgroundCount() == 1 }
    }

    @MainActor
    func testBackgroundAndSignOutStopEachClientSchedulerOnceWithoutLateOldRuntimeActions() async {
        let factory = RuntimeFactoryProbe()
        let owner = HQAppRealtimeOwner { fence in factory.makeRuntime(fence: fence) }
        let scene = UUID()

        owner.sessionChanged(subjectID: "subject-a")
        owner.sceneChanged(scene, phase: .active)
        await Self.eventually("first runtime boot") { await factory.service(for: "subject-a")?.bootCount() == 1 }
        let signedOutService = factory.service(for: "subject-a")!

        owner.sessionChanged(subjectID: nil)
        await Self.eventually("client scheduler stop on sign-out") {
            let backgrounds = await signedOutService.backgroundCount()
            let invalidations = await factory.invalidationCount(for: "subject-a")
            return backgrounds == 1 && invalidations == 1
        }
        XCTAssertNil(owner.activeSubjectID)

        owner.sessionChanged(subjectID: "subject-b")
        await Self.eventually("second runtime boot") { await factory.service(for: "subject-b")?.bootCount() == 1 }
        let backgroundedService = factory.service(for: "subject-b")!
        owner.sceneChanged(scene, phase: .background)
        await Self.eventually("client scheduler stop on background") {
            let backgrounds = await backgroundedService.backgroundCount()
            let invalidations = await factory.invalidationCount(for: "subject-b")
            return backgrounds == 1 && invalidations == 1
        }

        for _ in 0 ..< 50 { await Task.yield() }
        let signedOutBackgrounds = await signedOutService.backgroundCount()
        let backgroundedBackgrounds = await backgroundedService.backgroundCount()
        let signedOutInvalidations = await factory.invalidationCount(for: "subject-a")
        let backgroundedInvalidations = await factory.invalidationCount(for: "subject-b")
        let signedOutReconciliations = await factory.reconcileCount(for: "subject-a")
        let backgroundedReconciliations = await factory.reconcileCount(for: "subject-b")
        XCTAssertEqual(signedOutBackgrounds, 1)
        XCTAssertEqual(backgroundedBackgrounds, 1)
        XCTAssertEqual(signedOutInvalidations, 1)
        XCTAssertEqual(backgroundedInvalidations, 1)
        XCTAssertEqual(signedOutReconciliations, 0)
        XCTAssertEqual(backgroundedReconciliations, 0)
    }

    func testAcceptanceBlockersTellTheTruthAboutTheDeployedWakeContract() {
        XCTAssertEqual(HQRealtimeAcceptance.externalBlockers, [
            .liveBrokerAndCrossIdentityCanaryRequired,
            .sequenceGapUnavailableInDeployedWakeContract
        ])
    }

    private static func eventually(
        _ label: String = "asynchronous lifecycle state",
        attempts: Int = 500,
        _ predicate: @escaping @Sendable () async -> Bool
    ) async {
        for _ in 0 ..< attempts {
            if await predicate() { return }
            await Task.yield()
        }
        XCTFail("Timed out waiting for \(label)")
    }
}

private actor FenceProbe {
    private var current: Bool
    init(current: Bool) { self.current = current }
    func value() -> Bool { current }
    func set(_ value: Bool) { current = value }
}

private actor AsyncCounter {
    private var count = 0
    func increment() { count += 1 }
    func value() -> Int { count }
}

private actor SuspensionGate {
    private var isOpen = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func wait() async {
        guard !isOpen else { return }
        await withCheckedContinuation { waiters.append($0) }
    }

    func open() {
        isOpen = true
        let pending = waiters
        waiters.removeAll()
        pending.forEach { $0.resume() }
    }
}

private actor FetchProbe {
    private var fetchCount = 0
    private let firstGate: SuspensionGate
    init(firstGate: SuspensionGate) { self.firstGate = firstGate }

    func fetch(subjectID: String) async throws -> HQAuthoritativeSnapshot {
        fetchCount += 1
        if fetchCount == 1 { await firstGate.wait() }
        return .empty(subjectID: subjectID)
    }

    func count() -> Int { fetchCount }
}

private actor ApplyingProbe: HQAuthoritativeStateApplying {
    private let domains: Set<HQAuthoritativeDomain>
    private var count = 0
    init(domains: Set<HQAuthoritativeDomain>) { self.domains = domains }

    func apply(_ snapshot: HQAuthoritativeSnapshot, fence: HQReconciliationFence) async throws -> Set<HQAuthoritativeDomain> {
        count += 1
        return domains
    }

    func invalidate(fence _: HQReconciliationFence) {}
    func applyCount() -> Int { count }
}

private actor MockRealtimeService: HQRealtimeControlling {
    private let foregroundGate: SuspensionGate?
    private var foregrounds = 0
    private var boots = 0
    private var backgrounds = 0

    init(foregroundGate: SuspensionGate?) { self.foregroundGate = foregroundGate }

    func foregrounded() async {
        foregrounds += 1
        if let foregroundGate { await foregroundGate.wait() }
    }

    func boot() async { boots += 1 }
    func backgrounded() async { backgrounds += 1 }
    func foregroundCount() -> Int { foregrounds }
    func bootCount() -> Int { boots }
    func backgroundCount() -> Int { backgrounds }
}

@MainActor
private final class RuntimeFactoryProbe {
    private let foregroundGates: [String: SuspensionGate]
    private var services: [String: MockRealtimeService] = [:]
    private var fences: [String: HQReconciliationFence] = [:]
    private var reconcileCounters: [String: AsyncCounter] = [:]
    private var invalidationCounters: [String: AsyncCounter] = [:]
    private var makes = 0

    init(foregroundGates: [String: SuspensionGate] = [:]) {
        self.foregroundGates = foregroundGates
    }

    func makeRuntime(fence: HQReconciliationFence) -> HQRealtimeRuntime {
        makes += 1
        fences[fence.subjectID] = fence
        let service = MockRealtimeService(foregroundGate: foregroundGates[fence.subjectID])
        services[fence.subjectID] = service
        let counter = AsyncCounter()
        reconcileCounters[fence.subjectID] = counter
        let invalidationCounter = AsyncCounter()
        invalidationCounters[fence.subjectID] = invalidationCounter
        let reconciler = HQReconciler(
            fence: fence,
            requiredDomains: [],
            diagnostics: HQNetworkDiagnostics(),
            fetch: { currentFence in
                await counter.increment()
                return .empty(subjectID: currentFence.subjectID)
            },
            applier: ApplyingProbe(domains: [])
        )
        return HQRealtimeRuntime(
            client: service,
            reconciler: reconciler,
            invalidateAuthoritativeState: { await invalidationCounter.increment() }
        )
    }

    func makeCount() -> Int { makes }
    func service(for subjectID: String) -> MockRealtimeService? { services[subjectID] }
    func fence(for subjectID: String) -> HQReconciliationFence? { fences[subjectID] }
    func reconcileCount(for subjectID: String) async -> Int { await reconcileCounters[subjectID]?.value() ?? 0 }
    func invalidationCount(for subjectID: String) async -> Int { await invalidationCounters[subjectID]?.value() ?? 0 }
}

private extension HQAuthoritativeSnapshot {
    static func knownContractSnapshot(subjectID: String) -> HQAuthoritativeSnapshot {
        HQAuthoritativeSnapshot(
            subjectID: subjectID,
            mobileConfiguration: nil,
            membership: nil,
            availableDomains: [.mobileConfiguration, .membership]
        )
    }

    static func empty(subjectID: String) -> HQAuthoritativeSnapshot {
        HQAuthoritativeSnapshot(
            subjectID: subjectID,
            mobileConfiguration: nil,
            membership: nil,
            availableDomains: []
        )
    }
}
