import XCTest
@testable import HQNative

@MainActor
final class HQSecondaryWindowModelsTests: XCTestCase {
    func testEveryNonMainParityWindowHasANativeFixture() {
        let expected: Set<HQSecondaryWindowKind> = [
            .menuBar,
            .onboarding,
            .signIn,
            .recovery,
            .meetings,
            .meetingPermissions,
            .directMessageDetail,
            .shareDetail,
            .messages,
            .banner,
            .widget,
            .activity,
            .drift,
            .newFiles,
            .notificationHistory,
            .settings,
        ]

        XCTAssertEqual(Set(HQSecondaryWindowKind.allCases), expected)

        for kind in expected {
            let fixture = HQSecondaryWindowFixtures.fixture(for: kind)
            XCTAssertFalse(fixture.title.isEmpty, "Missing title for \(kind)")
            XCTAssertFalse(fixture.accessibilityIdentifier.isEmpty, "Missing identifier for \(kind)")
            XCTAssertEqual(
                fixture.accessibilityIdentifier,
                "window.\(kind.rawValue)",
                "Fixture identifiers must stay deterministic for UI automation"
            )
        }
    }

    func testEveryDeclaredSecondaryWindowActionHasANativeResolution() {
        for kind in HQSecondaryWindowKind.allCases {
            let fixture = HQSecondaryWindowFixtures.fixture(for: kind)
            let actions = [
                fixture.primaryAction,
                fixture.secondaryAction,
            ].compactMap { $0 }

            for action in actions {
                XCTAssertNotNil(
                    HQSecondaryWindowActionRegistry.resolution(
                        for: kind,
                        actionID: action.id
                    ),
                    "Missing native resolution for \(kind.rawValue).\(action.id)"
                )
            }
        }

        let liveActions: [(HQSecondaryWindowKind, String)] = [
            (.menuBar, "sync-now"),
            (.onboarding, "sign-in-google"),
            (.onboarding, "sign-in-microsoft"),
            (.signIn, "sign-in-google"),
            (.signIn, "sign-in-microsoft"),
            (.settings, "refresh"),
            (.meetings, "permissions"),
            (.meetings, "refresh"),
            (.meetingPermissions, "check"),
            (.meetingPermissions, "open-settings"),
            (.activity, "refresh"),
            (.drift, "refresh"),
            (.notificationHistory, "refresh"),
            (.recovery, "retry"),
        ]
        for (kind, actionID) in liveActions {
            XCTAssertNotNil(
                HQSecondaryWindowActionRegistry.resolution(
                    for: kind,
                    actionID: actionID
                ),
                "Missing live native resolution for \(kind.rawValue).\(actionID)"
            )
        }
    }

    func testSecondaryWindowCallsToActionDescribeTheirActualResolution() {
        let recovery = HQSecondaryWindowFixtures.fixture(for: .recovery)
        XCTAssertEqual(recovery.secondaryAction?.title, "Open Activity Log")
        XCTAssertEqual(
            HQSecondaryWindowActionRegistry.resolution(
                for: .recovery,
                actionID: recovery.secondaryAction?.id ?? ""
            ),
            .openScene(.activity)
        )

        let share = HQSecondaryWindowFixtures.fixture(for: .shareDetail)
        XCTAssertEqual(share.primaryAction?.title, "Open Inbox")
        XCTAssertNil(share.secondaryAction)
        XCTAssertEqual(
            HQSecondaryWindowActionRegistry.resolution(
                for: .shareDetail,
                actionID: share.primaryAction?.id ?? ""
            ),
            .navigate(.global(.inbox))
        )

        let activity = HQSecondaryWindowFixtures.fixture(for: .activity)
        XCTAssertEqual(activity.primaryAction?.title, "Open HQ Home")
        XCTAssertEqual(
            HQSecondaryWindowActionRegistry.resolution(
                for: .activity,
                actionID: activity.primaryAction?.id ?? ""
            ),
            .navigate(.global(.home))
        )

        let drift = HQSecondaryWindowFixtures.fixture(for: .drift)
        XCTAssertEqual(drift.secondaryAction?.title, "Reveal Workspace")
        XCTAssertEqual(
            HQSecondaryWindowActionRegistry.resolution(
                for: .drift,
                actionID: drift.secondaryAction?.id ?? ""
            ),
            .revealWorkspace
        )
    }

    func testMessagesFixtureCoversTheCompleteNativeInformationArchitecture() {
        let fixture = HQMessagesFixture.preview

        XCTAssertEqual(
            fixture.sections.map(\.kind),
            [.directMessages, .channels, .requests, .groups, .threads, .reactions]
        )
        XCTAssertTrue(fixture.sections.allSatisfy { !$0.rows.isEmpty })
        XCTAssertFalse(fixture.selectedConversation.messages.isEmpty)
        XCTAssertTrue(fixture.selectedConversation.messages.contains { !$0.reactions.isEmpty })
        XCTAssertNotNil(fixture.selectedConversation.thread)
        let selectedRow = fixture.sections.first {
            $0.kind == fixture.selectedSection
        }?.rows.first {
            $0.id == fixture.selectedRowID
        }
        XCTAssertEqual(
            selectedRow?.title,
            fixture.selectedConversation.title,
            "The highlighted row and visible conversation must describe the same recipient."
        )
        XCTAssertTrue(fixture.selectionIsReady)
    }

    func testBannerFixturesCoverAllFourNotificationKinds() {
        XCTAssertEqual(
            Set(HQBannerFixture.all.map(\.kind)),
            [.syncComplete, .meetingReady, .directMessage, .updateAvailable]
        )
        XCTAssertEqual(HQBannerFixture.all.count, 4)
        XCTAssertTrue(HQBannerFixture.all.allSatisfy { !$0.title.isEmpty && !$0.symbolName.isEmpty })
    }

    func testWidgetFixturesProvideCompactAndExpandedLayouts() {
        let compact = HQWidgetFixture.preview(for: .compact)
        let expanded = HQWidgetFixture.preview(for: .expanded)

        XCTAssertEqual(compact.mode, .compact)
        XCTAssertEqual(expanded.mode, .expanded)
        XCTAssertLessThan(compact.recentItems.count, expanded.recentItems.count)
        XCTAssertFalse(expanded.activity.isEmpty)
        XCTAssertTrue(compact.activity.isEmpty)
    }

    func testNewFilesFixtureClosesTheLegacyNoRendererGap() {
        let fixture = HQSecondaryWindowFixtures.fixture(for: .newFiles)

        XCTAssertEqual(fixture.title, "New Files")
        XCTAssertFalse(fixture.rows.isEmpty)
        XCTAssertEqual(fixture.primaryAction?.title, "Review Files")
        XCTAssertEqual(fixture.accessibilityIdentifier, "window.new-files")
    }

    func testWindowViewModelSupportsLoadingContentEmptyAndFailureStates() {
        let model = HQSecondaryWindowViewModel(kind: .activity)
        XCTAssertEqual(model.state, .loading)

        model.presentFixture()
        XCTAssertEqual(
            model.state,
            .content(HQSecondaryWindowFixtures.fixture(for: .activity))
        )

        model.presentEmpty(title: "No recent changes", message: "Everything is caught up.")
        XCTAssertEqual(
            model.state,
            .empty(
                HQWindowEmptyState(
                    title: "No recent changes",
                    message: "Everything is caught up."
                )
            )
        )

        model.presentFailure(message: "Could not load recent changes.")
        XCTAssertEqual(
            model.state,
            .failure(
                HQWindowFailureState(
                    message: "Could not load recent changes.",
                    retryTitle: "Try Again"
                )
            )
        )
    }
}
