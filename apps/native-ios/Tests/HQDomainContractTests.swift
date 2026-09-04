import CryptoKit
import Foundation
import XCTest
@testable import HQIOS

final class HQDomainContractTests: XCTestCase {
    func testEveryLedgerRouteHasOneUniqueCanonicalRuntimeIdentity() throws {
        let routes: [(ledgerID: String, route: HQRoute)] = [
            ("home", try route(.global(.home))),
            ("mission-control", try route(.global(.missionControl))),
            ("inbox", try route(.global(.inbox))),
            ("meetings", try route(.global(.meetings))),
            ("marketplace", try route(.global(.marketplace))),
            ("moderation", try route(.global(.moderation))),
            ("library:skills", try route(.library(.skills))),
            ("library:workers", try route(.library(.workers))),
            ("library:installed", try route(.library(.installed))),
            ("library:profile", try route(.library(.profile))),
            ("files", try route(.files(company: nil, path: nil))),
            ("settings:sync", try route(.settings(.sync))),
            ("settings:notifications", try route(.settings(.notifications))),
            ("settings:widget", try route(.settings(.widget))),
            ("settings:updates", try route(.settings(.updates))),
            ("settings:general", try route(.settings(.general))),
            ("settings:meetings", try route(.settings(.meetings))),
            ("company:{slug}:overview", try route(.company(slug: "indigo", section: .overview))),
            ("company:{slug}:goals", try route(.company(slug: "indigo", section: .goals))),
            ("company:{slug}:projects", try route(.company(slug: "indigo", section: .projects))),
            ("company:{slug}:skills", try route(.company(slug: "indigo", section: .skills))),
            ("company:{slug}:workers", try route(.company(slug: "indigo", section: .workers))),
            ("company:{slug}:knowledge", try route(.company(slug: "design & research", section: .knowledge))),
            ("company:{slug}:team", try route(.company(slug: "indigo", section: .team))),
            ("company:{slug}:activity", try route(.company(slug: "indigo", section: .activity))),
            ("company:{slug}:deployments", try route(.company(slug: "indigo", section: .deployments))),
            ("company:{slug}:secrets", try route(.company(slug: "indigo", section: .secrets))),
            ("company:{slug}:settings", try route(.company(slug: "indigo", section: .settings))),
            ("project:{company}:{project}", try route(.project(company: "indigo labs", projectID: "ios/app"))),
            ("task:{company}:{project}:{task}", try route(.task(company: "indigo labs", projectID: "ios/app", taskID: "NATIVE:003"))),
        ]

        XCTAssertEqual(HQRoute.ledgerIdentifiers.count, 30)
        XCTAssertEqual(Set(HQRoute.ledgerIdentifiers).count, 30)
        XCTAssertEqual(routes.map(\.ledgerID), HQRoute.ledgerIdentifiers)
        XCTAssertEqual(routes.count, 30)

        var serializedIdentities = Set<String>()
        for (_, route) in routes {
            let serialized = HQRoute.serialize(route)
            XCTAssertTrue(serializedIdentities.insert(serialized).inserted, "Duplicate runtime route identity: \(serialized)")
            XCTAssertEqual(HQRoute.parse(serialized), route)
            XCTAssertEqual(try JSONDecoder().decode(HQRoute.self, from: JSONEncoder().encode(route)), route)
        }

        XCTAssertEqual(HQRoute.parse("files")?.kind, .files(company: nil, path: nil))
    }

    func testDynamicRouteSegmentsUseExactMacOSCanonicalPercentEncoding() throws {
        let punctuation = try route(.company(slug: "AZaz09-._~", section: .overview))
        XCTAssertEqual(HQRoute.serialize(punctuation), "company:AZaz09%2D%2E%5F%7E:overview")

        let encoded = try route(.company(slug: "space /:%+é", section: .knowledge))
        XCTAssertEqual(HQRoute.serialize(encoded), "company:space%20%2F%3A%25%2B%C3%A9:knowledge")
        XCTAssertEqual(HQRoute.parse(HQRoute.serialize(encoded)), encoded)

        let pathOnly = try route(.files(company: nil, path: "private/brief-._~.md"))
        XCTAssertEqual(HQRoute.serialize(pathOnly), "files::private%2Fbrief%2D%2E%5F%7E%2Emd")
        XCTAssertEqual(HQRoute.parse(HQRoute.serialize(pathOnly)), pathOnly)

        let companyPath = try route(.files(company: "indigo labs", path: "knowledge/brief:one.md"))
        XCTAssertEqual(HQRoute.parse(HQRoute.serialize(companyPath)), companyPath)

        XCTAssertNil(HQRoute.parse("company:design & research:knowledge"))
        XCTAssertNil(HQRoute.parse("company:space%2fslash:overview"), "Lowercase percent escapes are noncanonical")
        XCTAssertNil(HQRoute.parse("company:dash-value:overview"), "macOS encodes punctuation in dynamic segments")
        XCTAssertNil(HQRoute.parse("company:%41lpha:overview"), "Alphanumeric bytes must remain literal")
        XCTAssertNil(HQRoute.parse("company:bad%ZZvalue:overview"))
    }

    func testRouteConstructionRejectsEmptyRequiredDynamicSegments() throws {
        let invalidKinds: [HQRouteKind] = [
            .company(slug: "", section: .overview),
            .files(company: "", path: nil),
            .files(company: "", path: "brief.md"),
            .files(company: nil, path: ""),
            .files(company: "indigo", path: ""),
            .project(company: "", projectID: "project"),
            .project(company: "indigo", projectID: ""),
            .task(company: "", projectID: "project", taskID: "task"),
            .task(company: "indigo", projectID: "", taskID: "task"),
            .task(company: "indigo", projectID: "project", taskID: ""),
        ]
        for kind in invalidKinds {
            XCTAssertNil(HQRoute(kind: kind), "Invalid route kind must not acquire a runtime identity: \(kind)")
        }

        let validBoundaryKinds: [HQRouteKind] = [
            .files(company: nil, path: nil),
            .files(company: nil, path: "brief.md"),
            .files(company: "indigo", path: nil),
            .files(company: "indigo", path: "brief.md"),
        ]
        for kind in validBoundaryKinds {
            let constructed = try route(kind)
            XCTAssertEqual(HQRoute.parse(HQRoute.serialize(constructed)), constructed)
        }
    }

    func testReducerReplaysEveryExplicitStateWithoutIOModuleDependencies() {
        typealias State = HQLoadState<[String]>
        let isEmpty: ([String]) -> Bool = { $0.isEmpty }
        let loading = HQLoadReducer.reduce(state: State.empty, action: .loadStarted, isEmpty: isEmpty)
        XCTAssertEqual(loading, .loading(previous: nil))
        let content = HQLoadReducer.reduce(state: loading, action: .received(["work"]), isEmpty: isEmpty)
        XCTAssertEqual(content, .content(["work"]))
        XCTAssertEqual(HQLoadReducer.reduce(state: content, action: .received([]), isEmpty: isEmpty), .empty)
        XCTAssertEqual(HQLoadReducer.reduce(state: content, action: .receivedPartial(["work"], missingFields: ["owner"]), isEmpty: isEmpty), .partial(["work"], missingFields: ["owner"]))
        XCTAssertEqual(HQLoadReducer.reduce(state: content, action: .cached(["work"]), isEmpty: isEmpty), .stale(["work"]))
        XCTAssertEqual(HQLoadReducer.reduce(state: content, action: .offline, isEmpty: isEmpty), .offline(previous: ["work"]))
        XCTAssertEqual(HQLoadReducer.reduce(state: content, action: .permissionDenied, isEmpty: isEmpty), .permissionDenied)
        XCTAssertEqual(HQLoadReducer.reduce(state: content, action: .failed(.message("nope", retryable: true)), isEmpty: isEmpty), .error(.message("nope", retryable: true), previous: ["work"]))
    }

    func testEveryResponseDTOPreservesUnknownSiblingFields() throws {
        try assertUnknownFields(HQMobileFeatureFlags.self, #"{"agents":false,"claudeAutoOpen":false,"groupMessaging":false,"pushPreviews":false,"reactions":false,"threadReplies":false,"work":false}"#)
        try assertUnknownFields(HQMobileConfiguration.self, #"{"features":{"agents":false,"claudeAutoOpen":false,"groupMessaging":false,"pushPreviews":false,"reactions":false,"threadReplies":false,"work":false}}"#)
        try assertUnknownFields(HQMembershipBrand.self, #"{"website":"https://example.invalid","faviconUrl":"https://example.invalid/favicon.png"}"#)
        let membershipJSON = #"{"schemaVersion":1,"role":"future-role","updatedAt":0,"acceptedAt":0,"invitedAt":0,"companyUid":"company","invitationId":"invitation","createdAt":0,"membershipKey":"membership","invitedBy":"inviter","status":"future-membership-state","personUid":"person","companyName":"Company","companySlug":"company","bucketName":"bucket","fleetEnabled":false,"teamPlanEnabled":false,"brandingEnabled":false,"brand":null}"#
        let membership = try assertUnknownFields(HQMembership.self, membershipJSON)
        XCTAssertEqual(membership.role, .unknown("future-role"))
        XCTAssertEqual(membership.status, .unknown("future-membership-state"))
        try assertUnknownFields(HQMembershipResponse.self, #"{"memberships":[]}"#)
        try assertUnknownFields(HQSubject.self, #"{"id":"subject"}"#)
        try assertUnknownFields(HQCompany.self, #"{"id":"company","slug":"indigo","name":"Indigo"}"#)
        let project = try assertUnknownFields(HQProject.self, #"{"id":"project","companyID":"company","title":"iOS","status":"future-project-state","ownerID":null,"ownership":"future-owner-source"}"#)
        XCTAssertEqual(project.status, .unknown("future-project-state"))
        XCTAssertEqual(project.ownership, .unknown("future-owner-source"))
        try assertUnknownFields(HQGoal.self, #"{"id":"goal","title":"Ship","progress":0.5}"#)
        try assertUnknownFields(HQMessage.self, #"{"id":"message","threadID":"thread","senderID":"sender","body":"Hello","sentAt":0}"#)
        try assertUnknownFields(HQThread.self, #"{"id":"thread","participantIDs":["one","two"],"updatedAt":0}"#)
        try assertUnknownFields(HQReaction.self, #"{"emoji":"👍","subjectID":"subject","messageID":"message"}"#)
        try assertUnknownFields(HQShare.self, #"{"id":"share","title":"Brief","ownerID":"owner","route":"home"}"#)
        let meeting = try assertUnknownFields(HQMeeting.self, #"{"id":"meeting","title":"Weekly","startsAt":0,"state":"future-meeting-state"}"#)
        XCTAssertEqual(meeting.state, .unknown("future-meeting-state"))
        let listing = try assertUnknownFields(HQMarketplaceListing.self, #"{"id":"listing","title":"Skill","publisherID":"publisher","status":"future-listing-state"}"#)
        XCTAssertEqual(listing.status, .unknown("future-listing-state"))
        let worker = try assertUnknownFields(HQWorker.self, #"{"id":"worker","name":"Parker","state":"future-work-state"}"#)
        XCTAssertEqual(worker.state, .unknown("future-work-state"))
        try assertUnknownFields(HQSkill.self, #"{"id":"skill","name":"Audit","version":"1.0.0"}"#)
        try assertUnknownFields(HQFileMetadata.self, #"{"id":"file","path":"knowledge/brief.md","size":12,"updatedAt":0}"#)
        try assertUnknownFields(HQActivity.self, #"{"id":"activity","kind":"future-open-vocabulary","occurredAt":0}"#)
        let deployment = try assertUnknownFields(HQDeployment.self, #"{"id":"deployment","environment":"staging","status":"future-deployment-state","createdAt":0}"#)
        XCTAssertEqual(deployment.status, .unknown("future-deployment-state"))
        try assertUnknownFields(HQSecretMetadata.self, #"{"id":"secret","name":"API_TOKEN","updatedAt":0}"#)
        try assertUnknownFields(HQTask.self, #"{"id":"US-003","title":"Domain","state":"future-task-state","ownership":"future-owner-source"}"#)
        try assertUnknownFields(HQErrorEnvelope.self, #"{"code":"FUTURE","message":"Future error","retryable":false}"#)

        let pageJSON = addingSyntheticUnknownField(to: #"{"items":[{"id":"worker","name":"Parker","state":"future-work-state","itemFuture":"kept"}],"nextCursor":"cursor","hasMore":true}"#)
        let page = try domainDecoder.decode(HQPage<HQWorker>.self, from: Data(pageJSON.utf8))
        XCTAssertEqual(page.extensions[syntheticUnknownKey], syntheticUnknownValue)
        XCTAssertEqual(page.items.first?.extensions["itemFuture"], .string("kept"))
        XCTAssertEqual(try domainDecoder.decode(HQPage<HQWorker>.self, from: JSONEncoder().encode(page)), page)

        let envelopeJSON = addingSyntheticUnknownField(to: #"{"data":{"id":"US-003","title":"Domain","state":"future-task-state","taskFuture":"kept"},"error":null}"#)
        let envelope = try domainDecoder.decode(HQResponseEnvelope<HQTask>.self, from: Data(envelopeJSON.utf8))
        XCTAssertEqual(envelope.extensions[syntheticUnknownKey], syntheticUnknownValue)
        XCTAssertEqual(envelope.data?.extensions["taskFuture"], .string("kept"))
        XCTAssertEqual(try domainDecoder.decode(HQResponseEnvelope<HQTask>.self, from: JSONEncoder().encode(envelope)), envelope)
    }

    func testSyntheticAdversarialUnknownEnumsFieldsAndSupportedPrecisionRoundTrip() throws {
        // This payload is hand-authored adversarial data. It is intentionally
        // synthetic and must never be represented as a captured server fixture.
        let payload = Data(#"{"id":"US-003","title":"Domain","state":"queued-by-server","ownership":"delegated-by-policy","futureField":{"nested":[1,true]},"large":9007199254740993,"precise":0.1234567890123456789012345678,"nullable":null}"#.utf8)
        let task = try domainDecoder.decode(HQTask.self, from: payload)
        XCTAssertEqual(task.state, .unknown("queued-by-server"))
        XCTAssertEqual(task.ownership, .unknown("delegated-by-policy"))
        XCTAssertEqual(task.extensions["futureField"], .object(["nested": .array([.number(1), .bool(true)])]))
        XCTAssertEqual(task.extensions["large"], .number(Decimal(string: "9007199254740993")!))
        XCTAssertEqual(task.extensions["precise"], .number(Decimal(string: "0.1234567890123456789012345678")!))
        XCTAssertEqual(task.extensions["nullable"], .null)

        let reencoded = try JSONEncoder().encode(task)
        XCTAssertEqual(try domainDecoder.decode(HQTask.self, from: reencoded), task)

        let envelopePayload = Data(#"{"data":{"id":"US-003","title":"Domain","state":"queued-by-server"},"trace":"synthetic-adversarial"}"#.utf8)
        let envelope = try domainDecoder.decode(HQResponseEnvelope<HQTask>.self, from: envelopePayload)
        XCTAssertEqual(envelope.extensions["trace"], .string("synthetic-adversarial"))
        XCTAssertEqual(try domainDecoder.decode(HQResponseEnvelope<HQTask>.self, from: JSONEncoder().encode(envelope)), envelope)
    }

    func testRawResponseDecoderRejectsUnsupportedOpaqueNumberPrecisionLoudly() {
        func assertUnsupported(_ number: String, file: StaticString = #filePath, line: UInt = #line) {
            let payload = Data("{\"id\":\"US-003\",\"title\":\"Domain\",\"future\":\(number)}".utf8)
            XCTAssertThrowsError(try domainDecoder.decode(HQTask.self, from: payload), file: file, line: line) { error in
                XCTAssertEqual(error as? HQDomainJSONDecodingError, .unsupportedNumberPrecision(number), file: file, line: line)
            }
        }

        let tooManyDigits = "123456789012345678901234567890123456789"
        assertUnsupported(tooManyDigits)
        assertUnsupported("1e128")
        assertUnsupported("1e-129")
        assertUnsupported("0e128")
        assertUnsupported("0e-129")

        for supported in [
            "12345678901234567890123456789012345678",
            "1234567890123456789012345678901234567800",
            "1e127",
            "1e-128",
            "10e-129",
            "0.1e128",
            "0e127",
            "0e-128",
        ] {
            let payload = Data("{\"id\":\"US-003\",\"title\":\"Domain\",\"future\":\(supported)}".utf8)
            XCTAssertNoThrow(try domainDecoder.decode(HQTask.self, from: payload), "Supported Decimal boundary rejected: \(supported)")
        }

        let numberInsideString = Data("{\"id\":\"US-003\",\"title\":\"Domain\",\"future\":\"\(tooManyDigits)\"}".utf8)
        XCTAssertNoThrow(try domainDecoder.decode(HQTask.self, from: numberInsideString))

        let escapedNumberInsideString = Data(
            #"{"id":"US-003","title":"Domain","future":"escaped quote: \"123456789012345678901234567890123456789\"; escaped slash: \\123456789012345678901234567890123456789"}"#.utf8
        )
        XCTAssertNoThrow(try domainDecoder.decode(HQTask.self, from: escapedNumberInsideString))
    }

    func testAllForwardCompatibleWireEnumsRetainUnknownRawValues() throws {
        XCTAssertEqual(try domainDecoder.decode(HQWorkState.self, from: Data(#""future-work""#.utf8)), .unknown("future-work"))
        XCTAssertEqual(try domainDecoder.decode(HQOwnershipProvenance.self, from: Data(#""future-owner""#.utf8)), .unknown("future-owner"))
        XCTAssertEqual(try domainDecoder.decode(HQConnectionState.self, from: Data(#""future-connection""#.utf8)), .unknown("future-connection"))
        XCTAssertEqual(try domainDecoder.decode(HQCapabilityDisposition.self, from: Data(#""future-disposition""#.utf8)), .unknown("future-disposition"))
        XCTAssertEqual(try domainDecoder.decode(HQProjectStatus.self, from: Data(#""future-project""#.utf8)), .unknown("future-project"))
        XCTAssertEqual(try domainDecoder.decode(HQMeetingState.self, from: Data(#""future-meeting""#.utf8)), .unknown("future-meeting"))
        XCTAssertEqual(try domainDecoder.decode(HQMarketplaceListingStatus.self, from: Data(#""future-listing""#.utf8)), .unknown("future-listing"))
        XCTAssertEqual(try domainDecoder.decode(HQDeploymentStatus.self, from: Data(#""future-deployment""#.utf8)), .unknown("future-deployment"))
        XCTAssertEqual(try domainDecoder.decode(HQMembershipRole.self, from: Data(#""future-role""#.utf8)), .unknown("future-role"))
        XCTAssertEqual(try domainDecoder.decode(HQMembershipStatus.self, from: Data(#""future-membership""#.utf8)), .unknown("future-membership"))
    }

    func testSubjectScopedCachePurgesAcrossSwitchSignOutAndReactivation() {
        let first = HQSubject(id: "subject-one", extensions: ["plan": .string("original")])
        let refreshedFirst = HQSubject(id: "subject-one", extensions: ["plan": .string("updated")])
        let second = HQSubject(id: "subject-two")
        var cache = HQSubjectCache<String, String>(policy: HQAllowAuthenticatedSubjectCachePolicy())

        cache.activate(first)
        cache.store("protected-one", for: "inbox", subject: first)
        XCTAssertEqual(cache.value(for: "inbox", subject: first), "protected-one")
        cache.activate(refreshedFirst)
        XCTAssertEqual(
            cache.value(for: "inbox", subject: refreshedFirst),
            "protected-one",
            "Mutable response extensions must not change authenticated cache identity"
        )
        cache.store("updated-one", for: "inbox", subject: refreshedFirst)
        XCTAssertEqual(cache.value(for: "inbox", subject: first), "updated-one")
        XCTAssertNil(cache.value(for: "inbox", subject: second))

        cache.activate(second)
        cache.store("protected-two", for: "inbox", subject: second)
        cache.activate(first)
        XCTAssertNil(cache.value(for: "inbox", subject: first), "Switching back must not resurrect first-subject data")
        cache.activate(second)
        XCTAssertNil(cache.value(for: "inbox", subject: second), "Switching back must not resurrect second-subject data")

        cache.activate(first)
        cache.store("fresh-one", for: "inbox", subject: first)
        cache.signOut(first)
        cache.activate(first)
        XCTAssertNil(cache.value(for: "inbox", subject: first), "Signed-out data must remain purged after reactivation")
        cache.store("new-session", for: "inbox", subject: first)
        XCTAssertEqual(cache.value(for: "inbox", subject: first), "new-session")

        cache.signOut(second)
        cache.activate(first)
        XCTAssertNil(
            cache.value(for: "inbox", subject: first),
            "Sign-out must purge active protected state even when the caller supplies a stale subject"
        )

        cache.purgeAllProtectedState()
        cache.activate(first)
        XCTAssertNil(cache.value(for: "inbox", subject: first))
        cache.activate(second)
        XCTAssertNil(cache.value(for: "inbox", subject: second))
    }

    func testTwoReadOnlyRedactedCapturedShapesDecodeThroughTypedDTOsAndReencode() throws {
        let manifest = try loadCapturedFixtureManifest()

        let mobileFixture = try loadCapturedFixture(contractID: "mobile-config", from: manifest)
        let mobile = try domainDecoder.decode(HQMobileConfiguration.self, from: mobileFixture.data)
        XCTAssertFalse(mobile.features.agents)
        XCTAssertFalse(mobile.features.claudeAutoOpen)
        XCTAssertFalse(mobile.features.groupMessaging)
        XCTAssertFalse(mobile.features.pushPreviews)
        XCTAssertFalse(mobile.features.reactions)
        XCTAssertFalse(mobile.features.threadReplies)
        XCTAssertFalse(mobile.features.work)
        let reencodedMobile = try JSONEncoder().encode(mobile)
        XCTAssertEqual(try domainDecoder.decode(HQMobileConfiguration.self, from: reencodedMobile), mobile)
        try assertSemanticJSONParity(original: mobileFixture.data, reencoded: reencodedMobile)

        let membershipFixture = try loadCapturedFixture(contractID: "membership-me", from: manifest)
        var membershipDecoder = HQDomainJSONDecoder()
        membershipDecoder.dateDecodingStrategy = .iso8601
        let membership = try membershipDecoder.decode(HQMembershipResponse.self, from: membershipFixture.data)
        XCTAssertEqual(membership.memberships.count, 1)
        let capturedMembership = try XCTUnwrap(membership.memberships.first)
        let epoch = Date(timeIntervalSince1970: 0)
        XCTAssertEqual(capturedMembership.schemaVersion, 0)
        XCTAssertEqual(capturedMembership.role, .unknown("__redacted__"))
        XCTAssertEqual(capturedMembership.updatedAt, epoch)
        XCTAssertEqual(capturedMembership.acceptedAt, epoch)
        XCTAssertEqual(capturedMembership.invitedAt, epoch)
        XCTAssertEqual(capturedMembership.companyUID, "__redacted__")
        XCTAssertEqual(capturedMembership.invitationID, "__redacted__")
        XCTAssertEqual(capturedMembership.createdAt, epoch)
        XCTAssertEqual(capturedMembership.membershipKey, "__redacted__")
        XCTAssertEqual(capturedMembership.invitedBy, "__redacted__")
        XCTAssertEqual(capturedMembership.status, .unknown("__redacted__"))
        XCTAssertEqual(capturedMembership.personUID, "__redacted__")
        XCTAssertEqual(capturedMembership.companyName, "__redacted__")
        XCTAssertEqual(capturedMembership.companySlug, "__redacted__")
        XCTAssertEqual(capturedMembership.bucketName, "__redacted__")
        XCTAssertFalse(capturedMembership.fleetEnabled)
        XCTAssertFalse(capturedMembership.teamPlanEnabled)
        XCTAssertFalse(capturedMembership.brandingEnabled)
        let brand = try XCTUnwrap(capturedMembership.brand)
        XCTAssertEqual(brand.website, "https://example.invalid")
        XCTAssertEqual(brand.faviconURL, "https://example.invalid/favicon.png")

        let membershipEncoder = JSONEncoder()
        membershipEncoder.dateEncodingStrategy = .iso8601
        let reencodedMembership = try membershipEncoder.encode(membership)
        XCTAssertEqual(
            try membershipDecoder.decode(HQMembershipResponse.self, from: reencodedMembership),
            membership
        )
        try assertSemanticJSONParity(original: membershipFixture.data, reencoded: reencodedMembership)
    }

    func testGlobalContractFixtureRequirementRemainsBlockedBeyondTheTwoCapturedBaseShapes() throws {
        let manifest = try loadCapturedFixtureManifest()
        let cloudURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Contracts/cloud-routes.json")
        let root = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(contentsOf: cloudURL)) as? [String: Any])
        XCTAssertEqual(root["auditStatus"] as? String, "blocked")
        let fixturePolicy = try XCTUnwrap(root["fixturePolicy"] as? [String: Any])
        let capturedSourceKind = try XCTUnwrap(fixturePolicy["capturedSourceKind"] as? String)
        XCTAssertEqual(capturedSourceKind, "redacted-real-payload")
        XCTAssertTrue((fixturePolicy["completionRule"] as? String)?.localizedCaseInsensitiveContains("non-production") == true)
        XCTAssertTrue((root["captureRequirement"] as? String)?.localizedCaseInsensitiveContains("non-production") == true)
        for record in manifest.fixtures {
            XCTAssertEqual(record.sourceKind, capturedSourceKind)
            XCTAssertEqual(record.environmentClass, "production-read-only-operator")
            XCTAssertFalse(record.satisfiesGlobalAudit)
        }

        let contracts = try XCTUnwrap(root["contracts"] as? [[String: Any]])
        let fixtures = try contracts.map { try XCTUnwrap($0["fixture"] as? [String: Any]) }
        let missing = fixtures.filter { ($0["status"] as? String) == "missing" }
        XCTAssertFalse(missing.isEmpty, "US-001 remains blocked until every required contract has a redacted real fixture")

        let capturedContracts = contracts.filter {
            (($0["fixture"] as? [String: Any])?["status"] as? String) == "captured"
        }
        let capturedIDs = Set(capturedContracts.compactMap { $0["id"] as? String })
        XCTAssertTrue(Set(expectedCapturedFixtures.keys).isSubset(of: capturedIDs))

        for (contractID, expectation) in expectedCapturedFixtures {
            let contract = try XCTUnwrap(contracts.first { ($0["id"] as? String) == contractID })
            XCTAssertEqual(contract["method"] as? String, expectation.method)
            XCTAssertEqual(contract["path"] as? String, expectation.endpoint)
            let fixture = try XCTUnwrap(contract["fixture"] as? [String: Any])
            XCTAssertEqual(fixture["status"] as? String, "captured")
            XCTAssertEqual(fixture["redacted"] as? Bool, true)
            XCTAssertEqual(fixture["source"] as? String, "Contracts/Fixtures/\(expectation.filename)")
            XCTAssertEqual(fixture["manifest"] as? String, "Contracts/Fixtures/manifest.json")
            XCTAssertEqual(fixture["environmentClass"] as? String, "production-read-only-operator")
            XCTAssertEqual(fixture["satisfiesGlobalAudit"] as? Bool, false)

            let manifestRecord = try XCTUnwrap(manifest.fixtures.first { $0.contractID == contractID })
            XCTAssertEqual(manifestRecord.method, expectation.method)
            XCTAssertEqual(manifestRecord.endpoint, expectation.endpoint)
            XCTAssertEqual(manifestRecord.file, expectation.filename)
        }

        for fixture in fixtures where (fixture["status"] as? String) == "captured" {
            XCTAssertEqual(fixture["redacted"] as? Bool, true)
            let source = try XCTUnwrap(fixture["source"] as? String)
            XCTAssertNotEqual(source, "not-captured")
            XCTAssertFalse(source.localizedCaseInsensitiveContains("synthetic"))
        }
    }

    private func route(
        _ kind: HQRouteKind,
        file: StaticString = #filePath,
        line: UInt = #line
    ) throws -> HQRoute {
        try XCTUnwrap(HQRoute(kind: kind), "Expected a valid route kind", file: file, line: line)
    }

    @discardableResult
    private func assertUnknownFields<Value>(
        _ type: Value.Type,
        _ baseJSON: String,
        file: StaticString = #filePath,
        line: UInt = #line
    ) throws -> Value where Value: HQExtensibleResponseDTO & Codable & Equatable {
        let payload = addingSyntheticUnknownField(to: baseJSON)
        let decoded = try domainDecoder.decode(type, from: Data(payload.utf8))
        XCTAssertEqual(decoded.extensions[syntheticUnknownKey], syntheticUnknownValue, String(describing: type), file: file, line: line)
        let reencoded = try JSONEncoder().encode(decoded)
        XCTAssertEqual(try domainDecoder.decode(type, from: reencoded), decoded, String(describing: type), file: file, line: line)
        return decoded
    }

    private func addingSyntheticUnknownField(to objectJSON: String) -> String {
        precondition(objectJSON.last == "}")
        return String(objectJSON.dropLast()) + #", "syntheticFuture":{"nested":"kept"}}"#
    }

    private var domainDecoder: HQDomainJSONDecoder { HQDomainJSONDecoder() }
    private var syntheticUnknownKey: String { "syntheticFuture" }
    private var syntheticUnknownValue: HQJSONValue { .object(["nested": .string("kept")]) }

    private var fixturesDirectoryURL: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Contracts/Fixtures", isDirectory: true)
            .standardizedFileURL
    }

    private var expectedCapturedFixtures: [String: CapturedFixtureExpectation] {
        [
            "mobile-config": CapturedFixtureExpectation(
                method: "GET",
                endpoint: "/v1/mobile/config",
                filename: "mobile-config.redacted.json",
                sha256: "b7452cb1b3fb58d85ab8d97fde2bfeda67021f830d3418da8bbc4572b90d01ca"
            ),
            "membership-me": CapturedFixtureExpectation(
                method: "GET",
                endpoint: "/membership/me",
                filename: "membership-me.redacted.json",
                sha256: "246b659a4cfe0038324bb9c161a9f71df8ee8985bc3d1073d18589f93279e190"
            ),
        ]
    }

    private func loadCapturedFixtureManifest(
        file: StaticString = #filePath,
        line: UInt = #line
    ) throws -> CapturedFixtureManifest {
        let manifestData = try Data(contentsOf: fixturesDirectoryURL.appendingPathComponent("manifest.json"))
        XCTAssertEqual(
            sha256(manifestData),
            "31ab24b3e9159e7f940144782757820d42d7f29800d1eae9a2171faa8649bf6d",
            "Manifest bytes changed without updating the audited fixture binding",
            file: file,
            line: line
        )
        let manifest = try JSONDecoder().decode(CapturedFixtureManifest.self, from: manifestData)
        XCTAssertEqual(manifest.version, 1, file: file, line: line)
        XCTAssertEqual(manifest.company, "indigo", file: file, line: line)
        XCTAssertEqual(manifest.capturedAt, "2026-09-03T01:23:00Z", file: file, line: line)
        XCTAssertNotNil(ISO8601DateFormatter().date(from: manifest.capturedAt), file: file, line: line)
        XCTAssertTrue(manifest.capturePolicy.localizedCaseInsensitiveContains("production read-only"), file: file, line: line)
        XCTAssertTrue(manifest.capturePolicy.localizedCaseInsensitiveContains("shape"), file: file, line: line)
        XCTAssertTrue(manifest.capturePolicy.localizedCaseInsensitiveContains("do not satisfy"), file: file, line: line)
        XCTAssertTrue(manifest.capturePolicy.localizedCaseInsensitiveContains("non-production"), file: file, line: line)

        let contractIDs = manifest.fixtures.map(\.contractID)
        let filenames = manifest.fixtures.map(\.file)
        XCTAssertEqual(Set(contractIDs).count, contractIDs.count, file: file, line: line)
        XCTAssertEqual(Set(filenames).count, filenames.count, file: file, line: line)
        XCTAssertEqual(Set(contractIDs), Set(expectedCapturedFixtures.keys), file: file, line: line)

        for record in manifest.fixtures {
            let expectation = try XCTUnwrap(expectedCapturedFixtures[record.contractID], file: file, line: line)
            XCTAssertEqual(record.method, expectation.method, file: file, line: line)
            XCTAssertEqual(record.endpoint, expectation.endpoint, file: file, line: line)
            XCTAssertEqual(record.file, expectation.filename, file: file, line: line)
            XCTAssertEqual(record.sha256, expectation.sha256, file: file, line: line)
            XCTAssertTrue(record.redacted, file: file, line: line)
            XCTAssertEqual(record.sourceKind, "redacted-real-payload", file: file, line: line)
            XCTAssertFalse(record.sourceKind.localizedCaseInsensitiveContains("synthetic"), file: file, line: line)
            XCTAssertEqual(record.environmentClass, "production-read-only-operator", file: file, line: line)
            XCTAssertFalse(record.satisfiesGlobalAudit, file: file, line: line)
            if record.contractID == "membership-me" {
                XCTAssertTrue(record.scope?.contains("companySlug=indigo") == true, file: file, line: line)
            }
        }
        return manifest
    }

    private func loadCapturedFixture(
        contractID: String,
        from manifest: CapturedFixtureManifest,
        file: StaticString = #filePath,
        line: UInt = #line
    ) throws -> (record: CapturedFixtureRecord, data: Data) {
        let matches = manifest.fixtures.filter { $0.contractID == contractID }
        XCTAssertEqual(matches.count, 1, "Each captured contract must identify exactly one fixture", file: file, line: line)
        let record = try XCTUnwrap(matches.first, file: file, line: line)
        let expectation = try XCTUnwrap(expectedCapturedFixtures[contractID], file: file, line: line)

        guard record.file == URL(fileURLWithPath: record.file).lastPathComponent,
              !record.file.contains("\\")
        else {
            XCTFail("Unsafe captured fixture path: \(record.file)", file: file, line: line)
            throw CapturedFixtureTestError.unsafePath(record.file)
        }

        let fixtureURL = fixturesDirectoryURL.appendingPathComponent(record.file).standardizedFileURL
        guard fixtureURL.deletingLastPathComponent().path == fixturesDirectoryURL.path else {
            XCTFail("Captured fixture escaped its manifest directory: \(record.file)", file: file, line: line)
            throw CapturedFixtureTestError.unsafePath(record.file)
        }

        let data = try Data(contentsOf: fixtureURL)
        let digest = sha256(data)
        XCTAssertEqual(digest, record.sha256, "Fixture bytes do not match their manifest digest", file: file, line: line)
        XCTAssertEqual(
            digest,
            expectation.sha256,
            "Captured fixture bytes changed without updating the audited binding",
            file: file,
            line: line
        )
        return (record, data)
    }

    private func assertSemanticJSONParity(
        original: Data,
        reencoded: Data,
        file: StaticString = #filePath,
        line: UInt = #line
    ) throws {
        let originalTree = try domainDecoder.decode(HQJSONValue.self, from: original)
        let reencodedTree = try domainDecoder.decode(HQJSONValue.self, from: reencoded)
        XCTAssertEqual(reencodedTree, originalTree, file: file, line: line)
    }

    private func sha256(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}

private struct CapturedFixtureManifest: Decodable {
    let version: Int
    let capturedAt: String
    let company: String
    let capturePolicy: String
    let fixtures: [CapturedFixtureRecord]
}

private struct CapturedFixtureRecord: Decodable {
    let contractID: String
    let method: String
    let endpoint: String
    let file: String
    let sha256: String
    let redacted: Bool
    let sourceKind: String
    let environmentClass: String
    let satisfiesGlobalAudit: Bool
    let scope: String?

    private enum CodingKeys: String, CodingKey {
        case contractID = "contractId"
        case method
        case endpoint
        case file
        case sha256
        case redacted
        case sourceKind
        case environmentClass
        case satisfiesGlobalAudit
        case scope
    }
}

private struct CapturedFixtureExpectation {
    let method: String
    let endpoint: String
    let filename: String
    let sha256: String
}

private enum CapturedFixtureTestError: Error {
    case unsafePath(String)
}
