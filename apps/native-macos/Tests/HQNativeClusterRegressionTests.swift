import XCTest
@testable import HQNative

@MainActor
final class HQNativeClusterRegressionTests: XCTestCase {
    func testMeetingStartUsesSelectedCompanyAndSuppressesDuplicateRequests()
        async
    {
        let engine = ClusterRegressionRecordingEngine(
            responses: Self.liveResponses.merging([
                "start_recording": [.null],
            ]) { _, replacement in replacement },
            advertisedCapabilities: Self.bootstrapCapabilities.union([
                "start_recording",
            ]),
            delayedMethods: ["start_recording"]
        )
        let store = makeStore(engine: engine)
        await store.start()

        let action = HQAppAction.secondaryWindow(
            kind: .meetings,
            actionID: "meeting-action|start|window-1|company-indigo"
        )
        await store.perform(action)
        await store.perform(action)
        try? await Task.sleep(nanoseconds: 250_000_000)

        let startRecordingRequestCount = await engine.requestCount(
            for: "start_recording"
        )
        XCTAssertEqual(
            startRecordingRequestCount,
            1,
            "A meeting row must synchronously suppress duplicate Record clicks."
        )
        let params = await engine.requestedParams(for: "start_recording")
        XCTAssertEqual(
            params.first?.object?["companyUid"],
            .string("company-indigo"),
            "Record must use the company currently selected in that meeting row."
        )
    }

    func testOnboardingResumeSkipsStagesCompletedInInstallManifest() async {
        let stageMethods = [
            "fetch_and_extract_template",
            "install_deps",
            "start_initial_cloud_sync",
            "install_default_packages",
            "git_init",
            "personalize_hq",
            "register_search_index",
        ]
        let completedSteps = Dictionary(
            uniqueKeysWithValues: HQSetupStageID.allCases.map {
                (
                    $0.rawValue,
                    HQJSONValue.object(["status": .string("ok")])
                )
            }
        )
        var responses = Self.liveResponses
        responses["read_install_manifest"] = [
            .object([
                "installPath": .string("/tmp/HQ"),
                "steps": .object(completedSteps),
            ]),
        ]
        for method in stageMethods {
            responses[method] = [
                method == "fetch_and_extract_template"
                    ? .string("/tmp/HQ")
                    : .null,
            ]
        }
        let engine = ClusterRegressionRecordingEngine(
            responses: responses,
            advertisedCapabilities: Self.bootstrapCapabilities.union(
                stageMethods + ["read_install_manifest"]
            )
        )
        let store = makeStore(engine: engine)
        await store.start()
        XCTAssertTrue(
            store.setupStages.allSatisfy { $0.status == .complete },
            "The manifest precondition must represent a completed setup."
        )

        await store.perform(
            .secondaryWindow(kind: .onboarding, actionID: "run-setup")
        )

        for method in stageMethods {
            let requestCount = await engine.requestCount(for: method)
            XCTAssertEqual(
                requestCount,
                0,
                "Resume repeated completed setup stage \(method)."
            )
        }
    }

    func testSuccessfulOnboardingRehydratesLiveApplicationState() async {
        let stageMethods = [
            "fetch_and_extract_template",
            "install_deps",
            "start_initial_cloud_sync",
            "install_default_packages",
            "git_init",
            "personalize_hq",
            "register_search_index",
        ]
        var responses = Self.liveResponses
        responses["workspaces.list"] = [
            .object(["workspaces": .array([])]),
            .object([
                "hqFolderPath": .string("/tmp/HQ"),
                "workspaces": .array([
                    .object([
                        "slug": .string("indigo"),
                        "displayName": .string("Indigo"),
                        "path": .string("/tmp/HQ/companies/indigo"),
                        "exists": .bool(true),
                    ]),
                ]),
            ]),
        ]
        responses["projects.list"] = [
            .array([]),
            .array([
                .object([
                    "id": .string("native-macos"),
                    "companySlug": .string("indigo"),
                    "title": .string("Native macOS"),
                    "summary": .string("Native application"),
                    "status": .string("in-progress"),
                    "path": .string(
                        "/tmp/HQ/companies/indigo/projects/native-macos"
                    ),
                    "tasks": .array([]),
                ]),
            ]),
        ]
        responses["sessions.list"] = [
            .array([]),
            .array([
                .object([
                    "id": .string("session-native"),
                    "title": .string("Native verification"),
                    "provider": .string("codex"),
                    "status": .string("active"),
                ]),
            ]),
        ]
        for method in stageMethods {
            responses[method] = [
                method == "fetch_and_extract_template"
                    ? .string("/tmp/HQ")
                    : .null,
            ]
        }
        responses["record_install_complete"] = [.null]
        responses["mark_first_run_complete"] = [.null]

        let engine = ClusterRegressionRecordingEngine(
            responses: responses,
            advertisedCapabilities: Self.bootstrapCapabilities.union(
                stageMethods + [
                    "record_install_complete",
                    "mark_first_run_complete",
                ]
            )
        )
        let store = makeStore(engine: engine)
        await store.start()
        XCTAssertTrue(store.content.snapshot.workspaces.isEmpty)

        await store.perform(
            .secondaryWindow(kind: .onboarding, actionID: "run-setup")
        )

        XCTAssertEqual(
            store.content.snapshot.workspaces.map(\.slug),
            ["indigo"]
        )
        XCTAssertEqual(
            store.content.snapshot.projects.map(\.id),
            ["native-macos"]
        )
        XCTAssertEqual(store.sessions.map(\.id), ["session-native"])
        let workspaceRequestCount = await engine.requestCount(
            for: "workspaces.list"
        )
        XCTAssertGreaterThanOrEqual(
            workspaceRequestCount,
            2,
            "Open HQ must not expose the bootstrap snapshot from before setup."
        )
    }

    func testMessagesWindowTreatsDirectMessageHistoryAsContent() async {
        var responses = Self.liveResponses
        responses["list_channels"] = [
            .object(["channels": .array([])]),
        ]
        responses["list_dm_requests"] = [
            .object(["requests": .array([])]),
        ]
        responses["fetch_notification_history"] = [
            .object([
                "dms": .array([
                    .object([
                        "eventId": .string("dm-1"),
                        "fromPersonUid": .string("person-1"),
                        "fromEmail": .string("friend@example.com"),
                        "fromDisplayName": .string("Friend"),
                        "body": .string("Native message"),
                        "createdAt": .string("2026-07-27T00:00:00Z"),
                    ]),
                ]),
                "shares": .array([]),
                "files": .array([]),
            ]),
        ]
        let engine = ClusterRegressionRecordingEngine(
            responses: responses,
            advertisedCapabilities: Self.bootstrapCapabilities.union([
                "list_channels",
                "list_dm_requests",
                "fetch_notification_history",
            ])
        )
        let store = makeStore(engine: engine)
        await store.start()

        guard case .content = store.windowState(for: .messages) else {
            return XCTFail(
                "DM history must keep Messages out of the empty state."
            )
        }
        let fixture = try? XCTUnwrap(store.messagesWindowFixture())
        XCTAssertEqual(
            fixture?.sections.first {
                $0.kind == .directMessages
            }?.rows.count,
            1
        )
    }

    func testDomainWindowsExposeTheirProductionActions() async {
        var responses = Self.liveResponses
        responses["get_lifecycle_state"] = [
            .object([
                "changes": .array([
                    .object([
                        "id": .string("change-1"),
                        "title": .string("Core file changed"),
                        "detail": .string("Review before updating."),
                    ]),
                ]),
            ]),
        ]
        responses["fetch_notification_history"] = [
            .object([
                "dms": .array([]),
                "shares": .array([]),
                "files": .array([
                    .object([
                        "id": .string("file-1"),
                        "title": .string("native.md"),
                        "path": .string(
                            "companies/indigo/knowledge/native.md"
                        ),
                    ]),
                ]),
            ]),
        ]
        let engine = ClusterRegressionRecordingEngine(
            responses: responses,
            advertisedCapabilities: Self.bootstrapCapabilities.union([
                "get_lifecycle_state",
                "fetch_notification_history",
            ])
        )
        let store = makeStore(engine: engine)
        await store.start()

        assertActions(
            store.windowState(for: .drift),
            primary: "review",
            secondary: "preserve"
        )
        assertActions(
            store.windowState(for: .newFiles),
            primary: "review-files",
            secondary: "reveal"
        )
        assertActions(
            store.windowState(for: .notificationHistory),
            primary: "mark-read",
            secondary: "settings"
        )
        assertActions(
            store.windowState(for: .settings),
            primary: "done",
            secondary: "defaults"
        )
    }

    func testMarketplaceMutationIsKeyedAndRefreshesAffectedRoute() async {
        var responses = Self.liveResponses
        responses["list_marketplace_listings"] = [
            .array([
                .object([
                    "id": .string("listing-1"),
                    "name": .string("Native Craft"),
                    "slug": .string("native-craft"),
                    "version": .string("1.0.0"),
                ]),
            ]),
        ]
        responses["install_marketplace_pack"] = [.null]
        let engine = ClusterRegressionRecordingEngine(
            responses: responses,
            advertisedCapabilities: Self.bootstrapCapabilities.union([
                "list_marketplace_listings",
                "install_marketplace_pack",
            ]),
            delayedMethods: ["install_marketplace_pack"]
        )
        let store = makeStore(engine: engine)
        await store.start()
        store.selectedRoute = .global(.marketplace)
        await store.loadLiveRoute(.global(.marketplace))

        let params = HQJSONValue.object([
            "slug": .string("native-craft"),
            "version": .string("1.0.0"),
            "scope": .object(["kind": .string("personal")]),
        ])
        let first = Task { @MainActor in
            await store.perform(
                .engineCommand(
                    .installMarketplacePack,
                    params: params,
                    successMessage: "Installed Native Craft."
                )
            )
        }
        let second = Task { @MainActor in
            await store.perform(
                .engineCommand(
                    .installMarketplacePack,
                    params: params,
                    successMessage: "Installed Native Craft."
                )
            )
        }
        await first.value
        await second.value

        let installRequestCount = await engine.requestCount(
            for: "install_marketplace_pack"
        )
        XCTAssertEqual(
            installRequestCount,
            1,
            "The same marketplace install must not run concurrently twice."
        )
        let listingRequestCount = await engine.requestCount(
            for: "list_marketplace_listings"
        )
        XCTAssertGreaterThanOrEqual(
            listingRequestCount,
            2,
            "A successful install must refresh its affected live route."
        )
    }

    private func makeStore(
        engine: ClusterRegressionRecordingEngine
    ) -> HQAppStore {
        HQAppStore(
            engine: engine,
            launchMode: .live,
            updaterService: HQNativeUpdaterService(
                driver: ClusterRegressionUpdaterDriver()
            )
        )
    }

    private func assertActions(
        _ state: HQWindowContentState,
        primary: String,
        secondary: String,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        guard case let .content(fixture) = state else {
            return XCTFail("Expected content state.", file: file, line: line)
        }
        XCTAssertEqual(
            fixture.primaryAction?.id,
            primary,
            file: file,
            line: line
        )
        XCTAssertEqual(
            fixture.secondaryAction?.id,
            secondary,
            file: file,
            line: line
        )
    }

    private static let bootstrapCapabilities: Set<String> = [
        "config.get",
        "auth.state",
        "workspaces.list",
        "sync.status",
        "projects.list",
        "sessions.list",
    ]

    private static let liveResponses: [String: [HQJSONValue]] = [
        "config.get": [.object([:])],
        "auth.state": [
            .object([
                "authenticated": .bool(true),
                "hasStoredTokens": .bool(true),
            ]),
        ],
        "workspaces.list": [
            .object([
                "hqFolderPath": .string("/tmp/HQ"),
                "workspaces": .array([
                    .object([
                        "slug": .string("indigo"),
                        "displayName": .string("Indigo"),
                        "path": .string("/tmp/HQ/companies/indigo"),
                        "exists": .bool(true),
                    ]),
                ]),
            ]),
        ],
        "sync.status": [.object([:])],
        "projects.list": [.array([])],
        "sessions.list": [.array([])],
    ]
}

@MainActor
private final class ClusterRegressionUpdaterDriver: HQUpdaterDriving {
    var canCheckForUpdates = true
    var eventHandler: ((HQUpdaterDriverEvent) -> Void)?

    func start(
        feedURL _: URL,
        policy _: HQUpdateSchedulingPolicy
    ) throws {}

    func checkForUpdates() {}

    func presentAvailableUpdate() {}
}

private actor ClusterRegressionRecordingEngine: HQAppEngine {
    nonisolated let events: AsyncStream<HQEngineEvent>
    private var responses: [String: [HQJSONValue]]
    private let advertisedCapabilities: Set<String>
    private let delayedMethods: Set<String>
    private var requests: [(method: String, params: HQJSONValue)] = []

    init(
        responses: [String: [HQJSONValue]],
        advertisedCapabilities: Set<String>,
        delayedMethods: Set<String> = []
    ) {
        self.responses = responses
        self.advertisedCapabilities = advertisedCapabilities
        self.delayedMethods = delayedMethods
        events = AsyncStream { continuation in
            continuation.finish()
        }
    }

    func start() async throws -> HQJSONValue {
        .object([
            "capabilities": .array(
                advertisedCapabilities.sorted().map(HQJSONValue.string)
            ),
        ])
    }

    func request(
        _ method: String,
        params: HQJSONValue
    ) async throws -> HQJSONValue {
        requests.append((method, params))
        if delayedMethods.contains(method) {
            try await Task.sleep(nanoseconds: 120_000_000)
        }
        guard var values = responses[method], let value = values.first else {
            throw HQEngineErrorPayload(
                code: "missing_test_response",
                message: "\(method) has no recording-engine response.",
                retryable: false
            )
        }
        if values.count > 1 {
            values.removeFirst()
            responses[method] = values
        }
        return value
    }

    func stop() async {}

    func requestCount(for method: String) -> Int {
        requests.filter { $0.method == method }.count
    }

    func requestedParams(for method: String) -> [HQJSONValue] {
        requests.compactMap {
            $0.method == method ? $0.params : nil
        }
    }
}
