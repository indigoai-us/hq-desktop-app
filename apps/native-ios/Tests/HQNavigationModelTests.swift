import XCTest
@testable import HQIOS

@MainActor
final class HQNavigationModelTests: XCTestCase {
    func testDeviceIdiomOwnsRootNavigationStyleSoCompactPadRemainsSplitView() {
        XCTAssertEqual(HQAdaptiveNavigationStyle.resolve(userInterfaceIdiom: .phone), .tabs)
        XCTAssertEqual(HQAdaptiveNavigationStyle.resolve(userInterfaceIdiom: .pad), .split)
    }

    func testSceneCoordinatorQueuesColdLinkUntilRestorationThenPreservesRestoredHistory() throws {
        let project = try route(.project(company: "indigo", projectID: "ios"))
        let task = try route(.task(company: "indigo", projectID: "ios", taskID: "US-007"))
        let saved = HQNavigationModel()
        saved.navigate(to: project)

        let firstScene = HQSceneNavigationCoordinator(authenticationRequired: false)
        let secondScene = HQSceneNavigationCoordinator(authenticationRequired: false)
        firstScene.receiveDeepLink(task)
        firstScene.restore(encodedSnapshot: try XCTUnwrap(saved.encodedSnapshot()), ownerSubjectID: nil)

        XCTAssertEqual(firstScene.navigation.path(for: .work), [project, task])
        XCTAssertEqual(secondScene.navigation.selectedTab, .home)
        XCTAssertTrue(secondScene.navigation.path(for: .work).isEmpty)
    }

    func testSceneCoordinatorPurgesProtectedNavigationOnSessionLossOrSubjectChange() throws {
        let protectedRoute = try route(.project(company: "private", projectID: "secret"))
        let coordinator = HQSceneNavigationCoordinator(authenticationRequired: true)
        coordinator.activate(subjectID: "subject-a")
        coordinator.navigation.navigate(to: protectedRoute)
        coordinator.navigation.recordScrollAnchor("private-section", for: protectedRoute)
        coordinator.navigation.presentInspector(for: protectedRoute)

        coordinator.deactivate()

        XCTAssertEqual(coordinator.navigation.selectedTab, .home)
        XCTAssertTrue(coordinator.navigation.path(for: .work).isEmpty)
        XCTAssertNil(coordinator.navigation.scrollAnchor(for: protectedRoute))
        XCTAssertNil(coordinator.navigation.inspectorRoute)

        coordinator.activate(subjectID: "subject-a")
        coordinator.navigation.navigate(to: protectedRoute)
        coordinator.activate(subjectID: "subject-b")
        XCTAssertEqual(coordinator.navigation.selectedTab, .home)
        XCTAssertTrue(coordinator.navigation.path(for: .work).isEmpty)
    }

    func testAuthenticatedSceneRejectsOwnerlessRestoredProtectedNavigation() throws {
        let protectedRoute = try route(.project(company: "private", projectID: "secret"))
        let saved = HQNavigationModel()
        saved.navigate(to: protectedRoute)
        saved.recordScrollAnchor("private-section", for: protectedRoute)
        saved.presentInspector(for: protectedRoute)

        let coordinator = HQSceneNavigationCoordinator(authenticationRequired: true)
        coordinator.restore(encodedSnapshot: try XCTUnwrap(saved.encodedSnapshot()), ownerSubjectID: nil)
        coordinator.activate(subjectID: "subject-a")

        XCTAssertEqual(coordinator.navigation.selectedTab, .home)
        XCTAssertTrue(coordinator.navigation.path(for: .work).isEmpty)
        XCTAssertNil(coordinator.navigation.scrollAnchor(for: protectedRoute))
        XCTAssertNil(coordinator.navigation.inspectorRoute)
    }

    func testBootstrapShellStateFailsClosedForUnavailableAndDeniedResponses() throws {
        let configuration: HQRouteResult<HQMobileConfiguration> = .content(try makeConfiguration())
        let activeMembership: HQRouteResult<HQMembershipResponse> = .content(try makeMembership(status: "active"))
        XCTAssertEqual(HQShellPresentationState.bootstrap(configuration: configuration, membership: activeMembership), .content)

        let unavailable = HQRouteResult<HQMobileConfiguration>.unavailable(.unverifiedResponseSchema(contractID: "mobile-config"))
        XCTAssertEqual(HQShellPresentationState.bootstrap(configuration: unavailable, membership: activeMembership), .capabilityUnavailable)

        let deniedMembership: HQRouteResult<HQMembershipResponse> = .content(try makeMembership(status: "revoked"))
        XCTAssertEqual(HQShellPresentationState.bootstrap(configuration: configuration, membership: deniedMembership), .accessDenied)
    }

    func testEveryCanonicalRouteDeepLinksToItsEnclosingTabAndExactDestination() throws {
        let routes = try canonicalRoutes()

        XCTAssertEqual(routes.count, 30)
        for route in routes {
            let model = HQNavigationModel()
            model.openDeepLink(route)

            XCTAssertEqual(model.selectedTab, route.navigationTab, route.canonicalString)
            XCTAssertEqual(model.sidebarSelection, route, route.canonicalString)
            XCTAssertEqual(
                model.path(for: route.navigationTab),
                route == route.navigationTab.rootRoute ? [] : [route],
                route.canonicalString
            )
        }
    }

    func testSystemPathMutationAndModelBackShareTheSameHistory() throws {
        let project = try route(.project(company: "indigo", projectID: "native-ios"))
        let task = try route(.task(company: "indigo", projectID: "native-ios", taskID: "US-007"))
        let model = HQNavigationModel()

        model.navigate(to: project)
        model.pathBinding(for: .work).wrappedValue.append(task) // Equivalent to system back-stack push.
        XCTAssertEqual(model.sidebarSelection, task)

        model.pop()
        XCTAssertEqual(model.path(for: .work), [project])
        XCTAssertEqual(model.sidebarSelection, project)

        model.pathBinding(for: .work).wrappedValue = [] // Equivalent to edge-swipe/system back.
        XCTAssertEqual(model.sidebarSelection, try route(.global(.missionControl)))
    }

    func testDeepLinkPreservesExistingTargetAndOtherTabHistory() throws {
        let files = try route(.files(company: "Indigo & Café", path: "knowledge/brief:one.md"))
        let project = try route(.project(company: "Indigo & Café", projectID: "ios/app"))
        let task = try route(.task(company: "Indigo & Café", projectID: "ios/app", taskID: "NATIVE:003"))
        let model = HQNavigationModel()

        model.navigate(to: files)
        model.recordScrollAnchor("section-7", for: files)
        model.navigate(to: project)
        model.openDeepLink(task)

        XCTAssertEqual(model.selectedTab, .work)
        XCTAssertEqual(model.path(for: .work), [project, task])
        XCTAssertEqual(model.path(for: .more), [files])
        XCTAssertEqual(model.scrollAnchor(for: files), "section-7")

        model.pop()
        XCTAssertEqual(model.sidebarSelection, project)
        XCTAssertEqual(model.path(for: .work), [project])
    }

    func testDeepLinkToRootPreservesBackHistoryWhenTheTargetTabHasHistory() throws {
        let project = try route(.project(company: "indigo", projectID: "ios"))
        let root = try route(.global(.missionControl))
        let model = HQNavigationModel()

        model.navigate(to: project)
        model.openDeepLink(root)

        XCTAssertEqual(model.path(for: .work), [project, root])
        model.pop()
        XCTAssertEqual(model.sidebarSelection, project)
    }

    func testRepeatedDeepLinkDoesNotDuplicateTheCurrentDestination() throws {
        let project = try route(.project(company: "indigo", projectID: "ios"))
        let task = try route(.task(company: "indigo", projectID: "ios", taskID: "US-007"))
        let model = HQNavigationModel()

        model.openDeepLink(project)
        model.openDeepLink(task)
        model.openDeepLink(task)

        XCTAssertEqual(model.path(for: .work), [project, task])
        model.pop()
        XCTAssertEqual(model.sidebarSelection, project)
    }

    func testSidebarCollapseAndExpansionPreserveTypedRouteAndScrollContext() throws {
        let project = try route(.project(company: "indigo", projectID: "ios"))
        let model = HQNavigationModel()
        model.openDeepLink(project)
        model.recordScrollAnchor("section-7", for: project)

        model.splitViewVisibility = .detailOnly
        XCTAssertEqual(model.splitViewVisibility, .detailOnly)
        XCTAssertEqual(model.sidebarSelection, project)
        XCTAssertEqual(model.scrollAnchor(for: project), "section-7")

        model.splitViewVisibility = .all
        XCTAssertEqual(model.splitViewVisibility, .all)
        XCTAssertEqual(model.path(for: .work), [project])
        XCTAssertEqual(model.scrollAnchor(for: project), "section-7")
    }

    func testScrollPositionBindingPersistsAndClearsActualAnchor() throws {
        let route = try route(.global(.home))
        let model = HQNavigationModel()
        let binding = model.scrollAnchorBinding(for: route)

        XCTAssertNil(binding.wrappedValue)
        binding.wrappedValue = "section-8"
        XCTAssertEqual(model.scrollAnchor(for: route), "section-8")
        binding.wrappedValue = nil
        XCTAssertNil(model.scrollAnchor(for: route))
    }

    func testSnapshotRestoresPathsSelectionInspectorAndScrollContext() throws {
        let files = try route(.files(company: "indigo labs", path: "knowledge/brief:one.md"))
        let project = try route(.project(company: "indigo labs", projectID: "ios/app"))
        let model = HQNavigationModel()
        model.openDeepLink(files)
        model.recordScrollAnchor("section-7", for: files)
        model.presentInspector(for: files)
        model.splitViewVisibility = .detailOnly
        model.navigate(to: project)

        let restored = HQNavigationModel(snapshot: model.snapshot())
        XCTAssertEqual(restored.selectedTab, .work)
        XCTAssertEqual(restored.sidebarSelection, project)
        XCTAssertEqual(restored.path(for: .more), [files])
        XCTAssertEqual(restored.path(for: .work), [project])
        XCTAssertEqual(restored.scrollAnchor(for: files), "section-7")
        XCTAssertEqual(restored.inspectorRoute, files)
        XCTAssertTrue(restored.inspectorPresented)
        XCTAssertEqual(restored.splitViewVisibility, .detailOnly)

        let encoded = try XCTUnwrap(model.encodedSnapshot())
        let sceneRestored = HQNavigationModel()
        sceneRestored.restore(encodedSnapshot: encoded)
        XCTAssertEqual(sceneRestored.snapshot(), model.snapshot())
        XCTAssertEqual(sceneRestored.splitViewVisibility, .detailOnly)
    }

    func testMalformedRestorationFailsClosedInsteadOfRetainingProtectedState() throws {
        let protectedRoute = try route(.project(company: "private", projectID: "secret"))
        let model = HQNavigationModel()
        model.navigate(to: protectedRoute)
        model.recordScrollAnchor("private-section", for: protectedRoute)
        model.presentInspector(for: protectedRoute)

        model.restore(encodedSnapshot: "not-valid-base64")

        XCTAssertEqual(model.selectedTab, .home)
        XCTAssertEqual(model.sidebarSelection, HQNavigationTab.home.rootRoute)
        XCTAssertTrue(HQNavigationTab.allCases.allSatisfy { model.path(for: $0).isEmpty })
        XCTAssertNil(model.scrollAnchor(for: protectedRoute))
        XCTAssertNil(model.inspectorRoute)
    }

    func testRestorationRejectsRouteStoredUnderWrongTab() throws {
        let files = try route(.files(company: "private", path: "secret.md"))
        let protectedRoute = try route(.project(company: "private", projectID: "secret"))
        let model = HQNavigationModel()
        model.navigate(to: protectedRoute)

        var invalid = model.snapshot()
        invalid.selectedTab = .work
        invalid.sidebarSelection = files
        invalid.workPath = [files]
        let data = try JSONEncoder().encode(invalid)

        model.restore(encodedSnapshot: data.base64EncodedString())

        XCTAssertEqual(model.selectedTab, .home)
        XCTAssertEqual(model.sidebarSelection, HQNavigationTab.home.rootRoute)
        XCTAssertTrue(HQNavigationTab.allCases.allSatisfy { model.path(for: $0).isEmpty })
    }

    func testResetPurgesSubjectScopedRouteAndScrollContext() throws {
        let route = try route(.project(company: "indigo labs", projectID: "confidential"))
        let model = HQNavigationModel()
        model.openDeepLink(route)
        model.recordScrollAnchor("private-section", for: route)
        model.presentInspector(for: route)

        model.reset()

        XCTAssertEqual(model.selectedTab, .home)
        XCTAssertEqual(model.sidebarSelection, HQNavigationTab.home.rootRoute)
        XCTAssertTrue(HQNavigationTab.allCases.allSatisfy { model.path(for: $0).isEmpty })
        XCTAssertNil(model.scrollAnchor(for: route))
        XCTAssertNil(model.inspectorRoute)
        XCTAssertFalse(model.inspectorPresented)
    }

    private func canonicalRoutes() throws -> [HQRoute] {
        try [
            .global(.home), .global(.missionControl), .global(.inbox), .global(.meetings), .global(.marketplace), .global(.moderation),
            .library(.skills), .library(.workers), .library(.installed), .library(.profile), .files(company: nil, path: nil),
            .settings(.sync), .settings(.notifications), .settings(.widget), .settings(.updates), .settings(.general), .settings(.meetings),
            .company(slug: "indigo", section: .overview), .company(slug: "indigo", section: .goals), .company(slug: "indigo", section: .projects),
            .company(slug: "indigo", section: .skills), .company(slug: "indigo", section: .workers), .company(slug: "design & research", section: .knowledge),
            .company(slug: "indigo", section: .team), .company(slug: "indigo", section: .activity), .company(slug: "indigo", section: .deployments),
            .company(slug: "indigo", section: .secrets), .company(slug: "indigo", section: .settings),
            .project(company: "indigo labs", projectID: "ios/app"), .task(company: "indigo labs", projectID: "ios/app", taskID: "NATIVE:003"),
        ].map { try route($0) }
    }

    private func route(_ kind: HQRouteKind) throws -> HQRoute {
        try XCTUnwrap(HQRoute(kind: kind))
    }

    private func makeConfiguration() throws -> HQMobileConfiguration {
        try HQDomainJSONDecoder().decode(
            HQMobileConfiguration.self,
            from: Data(#"{"features":{"agents":true,"claudeAutoOpen":true,"groupMessaging":true,"pushPreviews":true,"reactions":true,"threadReplies":true,"work":true}}"#.utf8)
        )
    }

    private func makeMembership(status: String) throws -> HQMembershipResponse {
        let payload = """
        {"memberships":[{"schemaVersion":1,"role":"member","updatedAt":0,"acceptedAt":0,"invitedAt":0,"companyUid":"company","invitationId":"invitation","createdAt":0,"membershipKey":"membership","invitedBy":"inviter","status":"\(status)","personUid":"person","companyName":"Company","companySlug":"company","bucketName":"bucket","fleetEnabled":false,"teamPlanEnabled":false,"brandingEnabled":false,"brand":null}]}
        """
        return try HQDomainJSONDecoder().decode(HQMembershipResponse.self, from: Data(payload.utf8))
    }
}
