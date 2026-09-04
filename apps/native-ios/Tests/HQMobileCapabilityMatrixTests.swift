import Foundation
import XCTest

/// Deterministic US-001 contract checks. Live payload capture remains an external
/// gate, but the ledger coverage and the known wire seams are executable now.
final class HQMobileCapabilityMatrixTests: XCTestCase {
    private let expectedDispositions: Set<String> = [
        "cloud-backed-native",
        "ios-adapted",
        "degraded-read-only",
        "device-unavailable",
        "blocked-missing-external-backend",
    ]

    func testCapabilityIDsExactlyMatchSourceLedgers() throws {
        let matrix = try loadJSON(iosRoot.appendingPathComponent("Contracts/mobile-capabilities.json"))
        let audit = try dictionary(matrix, key: "audit")
        let sourceLedgers = try dictionary(audit, key: "sourceLedgers")
        XCTAssertEqual(sourceLedgers["routes"] as? String, "apps/native-macos/Parity/routes.json")
        XCTAssertEqual(sourceLedgers["secondarySurfaces"] as? String, "apps/native-macos/Parity/windows.json")

        let routeLedger = try loadJSON(repositoryRoot.appendingPathComponent(try string(sourceLedgers, key: "routes")))
        let windowLedger = try loadJSON(repositoryRoot.appendingPathComponent(try string(sourceLedgers, key: "secondarySurfaces")))
        let expectedRouteIDs = try ids(try array(routeLedger, key: "routes"))
        let expectedSurfaceIDs = try ids(try array(windowLedger, key: "windows"))
        let actualRouteIDs = try ids(try array(matrix, key: "routeCapabilities"))
        let actualSurfaceIDs = try ids(try array(matrix, key: "secondarySurfaceCapabilities"))

        XCTAssertEqual(expectedRouteIDs.count, 30)
        XCTAssertEqual(expectedSurfaceIDs.count, 17)
        XCTAssertEqual(actualRouteIDs, expectedRouteIDs, "Route order and identity must remain source-ledger exact")
        XCTAssertEqual(actualSurfaceIDs, expectedSurfaceIDs, "Mapped surface order and identity must remain source-ledger exact")
        XCTAssertEqual(Set(actualRouteIDs).count, actualRouteIDs.count)
        XCTAssertEqual(Set(actualSurfaceIDs).count, actualSurfaceIDs.count)
    }

    func testEveryCapabilityAndActionUsesTheHardcodedDispositionVocabulary() throws {
        let matrix = try loadJSON(iosRoot.appendingPathComponent("Contracts/mobile-capabilities.json"))
        let audit = try dictionary(matrix, key: "audit")
        let declared = Set(try XCTUnwrap(audit["allowedDispositions"] as? [String]))
        XCTAssertEqual(declared, expectedDispositions)
        XCTAssertEqual(declared.count, 5)

        for capability in try capabilities(matrix) {
            let capabilityID = try string(capability, key: "id")
            XCTAssertTrue(expectedDispositions.contains(try string(capability, key: "disposition")), capabilityID)
            let actions = try array(capability, key: "actions")
            XCTAssertFalse(actions.isEmpty, "\(capabilityID) must classify concrete actions")
            let actionIDs = try ids(actions)
            XCTAssertEqual(Set(actionIDs).count, actionIDs.count, "Duplicate action in \(capabilityID)")

            for action in actions {
                let actionID = try string(action, key: "id")
                XCTAssertNotEqual(actionID, "open", "Generic open actions do not document product capability")
                let disposition = try string(action, key: "disposition")
                XCTAssertTrue(expectedDispositions.contains(disposition), "\(capabilityID).\(actionID)")
                if disposition == "device-unavailable" || disposition == "blocked-missing-external-backend" {
                    XCTAssertFalse(try string(action, key: "evidence").isEmpty, "\(capabilityID).\(actionID) needs evidence")
                }
                if disposition == "cloud-backed-native" {
                    let refs = contractReferences(action)
                    XCTAssertFalse(refs.isEmpty, "\(capabilityID).\(actionID) must name its cloud contract")
                }
            }
        }
    }

    func testCloudReferencesResolveAndEveryContractDeclaresRequiredFields() throws {
        let matrix = try loadJSON(iosRoot.appendingPathComponent("Contracts/mobile-capabilities.json"))
        let cloud = try loadJSON(iosRoot.appendingPathComponent("Contracts/cloud-routes.json"))
        let contracts = try array(cloud, key: "contracts")
        let contractIDs = try ids(contracts)
        XCTAssertEqual(Set(contractIDs).count, contractIDs.count, "Cloud contract IDs must be unique")
        let knownIDs = Set(contractIDs)

        var referencedIDs = Set<String>()
        for capability in try capabilities(matrix) {
            referencedIDs.formUnion(contractReferences(capability))
            if try string(capability, key: "disposition") == "cloud-backed-native" {
                XCTAssertFalse(contractReferences(capability).isEmpty, "Cloud-backed capability must name a default contract")
            }
            for action in try array(capability, key: "actions") {
                referencedIDs.formUnion(contractReferences(action))
            }
        }
        XCTAssertTrue(referencedIDs.isSubset(of: knownIDs), "Missing contracts: \(referencedIDs.subtracting(knownIDs).sorted())")

        let allowedMethods: Set<String> = ["GET", "POST", "PUT", "PATCH", "DELETE"]
        for contract in contracts {
            let contractID = try string(contract, key: "id")
            XCTAssertTrue(allowedMethods.contains(try string(contract, key: "method")), contractID)
            XCTAssertTrue(try string(contract, key: "path").hasPrefix("/"), contractID)
            let expectedAuth = ["cognito-token", "cognito-revoke"].contains(contractID)
                ? "none-public-oauth-client"
                : "cognito-id-token"
            XCTAssertEqual(contract["auth"] as? String, expectedAuth, contractID)
            XCTAssertFalse(try string(contract, key: "permission").isEmpty, contractID)
            XCTAssertNotNil(contract["request"], contractID)
            XCTAssertFalse(try string(contract, key: "response").isEmpty, contractID)
            XCTAssertFalse(try string(contract, key: "pagination").isEmpty, contractID)
            XCTAssertFalse(try XCTUnwrap(contract["errors"] as? [String]).isEmpty, contractID)
            XCTAssertFalse(try string(contract, key: "source").isEmpty, contractID)
            XCTAssertNotNil(contract["fixture"] as? [String: Any], contractID)
        }
    }

    func testKnownAuthenticationRealtimePushAndMessagingWireSeams() throws {
        let cloud = try loadJSON(iosRoot.appendingPathComponent("Contracts/cloud-routes.json"))
        let authorization = try dictionary(cloud, key: "authorization")
        XCTAssertEqual(authorization["header"] as? String, "Authorization")
        XCTAssertEqual(authorization["value"] as? String, "<tokenType> <idToken>")
        XCTAssertEqual(authorization["tokenSource"] as? String, "Cognito ID token")
        XCTAssertEqual(authorization["accessTokenAllowed"] as? Bool, false)

        let contracts = try contractsByID(cloud)
        let oauth = try dictionary(cloud, key: "oauth")
        XCTAssertEqual(oauth["hostedDomain"] as? String, "https://vault-indigo-hq-prod.auth.us-east-1.amazoncognito.com")
        XCTAssertEqual(oauth["clientId"] as? String, "7acei2c8v870enheptb1j5foln")
        XCTAssertEqual(oauth["callback"] as? String, "hqmobile://auth")
        XCTAssertEqual(oauth["scopes"] as? [String], ["openid", "email", "profile"])
        XCTAssertEqual(oauth["authorizationFlow"] as? String, "authorization_code")
        XCTAssertEqual(oauth["pkceChallengeMethod"] as? String, "S256")
        XCTAssertEqual(oauth["clientAuthentication"] as? String, "public-client-no-secret")

        let token = try contract(contracts, id: "cognito-token")
        XCTAssertEqual(token["method"] as? String, "POST")
        XCTAssertEqual(token["path"] as? String, "/oauth2/token")
        XCTAssertEqual(token["auth"] as? String, "none-public-oauth-client")
        let tokenRequest = try dictionary(token, key: "request")
        XCTAssertEqual(tokenRequest["contentType"] as? String, "application/x-www-form-urlencoded")
        XCTAssertEqual(
            Set(try XCTUnwrap(tokenRequest["authorizationCodeFields"] as? [String])),
            ["grant_type=authorization_code", "client_id", "code", "redirect_uri=hqmobile://auth", "code_verifier"]
        )
        XCTAssertEqual(
            Set(try XCTUnwrap(tokenRequest["refreshTokenFields"] as? [String])),
            ["grant_type=refresh_token", "client_id", "refresh_token"]
        )

        let revoke = try contract(contracts, id: "cognito-revoke")
        XCTAssertEqual(revoke["method"] as? String, "POST")
        XCTAssertEqual(revoke["path"] as? String, "/oauth2/revoke")
        XCTAssertEqual(revoke["auth"] as? String, "none-public-oauth-client")
        let revokeRequest = try dictionary(revoke, key: "request")
        XCTAssertEqual(revokeRequest["contentType"] as? String, "application/x-www-form-urlencoded")
        XCTAssertEqual(Set(try XCTUnwrap(revokeRequest["fields"] as? [String])), ["token", "client_id"])
        XCTAssertEqual(revokeRequest["tokenKind"] as? String, "refresh_token")

        try assertContract(contracts, "mobile-config", method: "GET", path: "/v1/mobile/config")
        try assertContract(contracts, "membership-me", method: "GET", path: "/membership/me")

        let realtime = try contract(contracts, id: "realtime-credentials")
        XCTAssertEqual(realtime["method"] as? String, "POST")
        XCTAssertEqual(realtime["path"] as? String, "/v1/realtime/credentials")
        let realtimeRequest = try dictionary(realtime, key: "request")
        let realtimeBody = try dictionary(realtimeRequest, key: "body")
        XCTAssertEqual(realtimeBody.count, 1)
        XCTAssertEqual(realtimeBody["contractVersion"] as? Int, 2)
        XCTAssertEqual(realtimeRequest["exactKeys"] as? [String], ["contractVersion"])
        let realtimeTransport = try dictionary(cloud, key: "realtimeTransport")
        XCTAssertEqual(realtimeTransport["service"] as? String, "iotdevicegateway")
        XCTAssertEqual(realtimeTransport["qos"] as? Int, 1)
        let signing = try string(realtimeTransport, key: "signing")
        XCTAssertTrue(signing.contains("without X-Amz-Security-Token"))
        XCTAssertTrue(signing.contains("append"))
        XCTAssertTrue(try string(realtimeTransport, key: "hydrateRule").contains("identifiers only"))

        let registration = try contract(contracts, id: "push-device-register")
        XCTAssertEqual(registration["method"] as? String, "POST")
        XCTAssertEqual(registration["path"] as? String, "/v1/realtime/devices")
        let registrationRequest = try dictionary(registration, key: "request")
        let registrationBody = try dictionary(registrationRequest, key: "body")
        XCTAssertEqual(registrationBody["platform"] as? String, "apns")
        XCTAssertEqual(registrationBody["preview"] as? String, "full|sender|generic")
        XCTAssertNil(registrationBody["notificationPreview"])
        XCTAssertEqual(Set(try XCTUnwrap(registrationRequest["requiredKeys"] as? [String])), ["deviceId", "platform", "deviceToken"])
        XCTAssertEqual(registrationRequest["optionalKeys"] as? [String], ["preview"])
        try assertContract(contracts, "push-device-remove", method: "DELETE", path: "/v1/realtime/devices/{deviceId}")

        try assertContract(contracts, "dm-send", method: "POST", path: "/v1/notify/dm")
        XCTAssertTrue(try string(try contract(contracts, id: "dm-send"), key: "request").contains("never POST /v1/notify/dm/{uid}"))
        XCTAssertTrue(try string(try contract(contracts, id: "dm-thread"), key: "path").hasPrefix("/v1/notify/thread?"))
        XCTAssertTrue(try string(try contract(contracts, id: "reply-threads"), key: "path").hasPrefix("/v1/notify/threads?"))
        try assertContract(contracts, "channel-create", method: "POST", path: "/v1/notify/channels")
        XCTAssertTrue(try string(try contract(contracts, id: "channel-directory"), key: "path").hasPrefix("/v1/notify/channels?"))
        XCTAssertTrue(try string(try contract(contracts, id: "channel-messages"), key: "path").hasPrefix("/v1/notify/channels/{channelId}/messages?"))
        try assertContract(contracts, "channel-send", method: "POST", path: "/v1/notify/channels/{channelId}/messages")
        try assertContract(contracts, "dm-reply", method: "POST", path: "/v1/notify/dm")
        try assertContract(contracts, "channel-reply", method: "POST", path: "/v1/notify/channels/{channelId}/messages")
        try assertContract(contracts, "reactions-fetch", method: "GET", pathPrefix: "/v1/notify/reactions?")
        try assertContract(contracts, "reaction-add", method: "POST", path: "/v1/notify/reactions")
        try assertContract(contracts, "reaction-remove", method: "DELETE", path: "/v1/notify/reactions")
        XCTAssertFalse(contracts.values.contains { (($0["path"] as? String) ?? "").contains("/project-channel") })
    }

    func testFixtureStatusAndSourceInvariantsPermitFutureVerification() throws {
        let cloud = try loadJSON(iosRoot.appendingPathComponent("Contracts/cloud-routes.json"))
        let policy = try dictionary(cloud, key: "fixturePolicy")
        let missingSource = try string(policy, key: "missingSource")
        XCTAssertEqual(Set(try XCTUnwrap(policy["requiredVariants"] as? [String])), ["content", "empty", "partial", "unknown-enum", "error"])

        var missingCount = 0
        for contract in try array(cloud, key: "contracts") {
            let fixture = try dictionary(contract, key: "fixture")
            let status = try string(fixture, key: "status")
            XCTAssertTrue(["missing", "captured"].contains(status))
            let source = try string(fixture, key: "source")
            if status == "missing" {
                missingCount += 1
                XCTAssertEqual(source, missingSource)
                XCTAssertEqual(fixture["redacted"] as? Bool, false)
            } else {
                XCTAssertNotEqual(source, missingSource)
                XCTAssertFalse(source.isEmpty)
                XCTAssertEqual(fixture["redacted"] as? Bool, true)
            }
        }

        let status = try string(cloud, key: "auditStatus")
        XCTAssertTrue(["blocked", "verified"].contains(status))
        if missingCount > 0 {
            XCTAssertEqual(status, "blocked")
            XCTAssertFalse(try string(cloud, key: "captureRequirement").isEmpty)
        } else {
            XCTAssertEqual(status, "verified")
        }
    }

    func testMissingExternalCapabilitiesBlockDependentsWithoutAFixtureShortcut() throws {
        let matrix = try loadJSON(iosRoot.appendingPathComponent("Contracts/mobile-capabilities.json"))
        let audit = try dictionary(matrix, key: "audit")
        let blocked = try capabilities(matrix).contains {
            ($0["disposition"] as? String) == "blocked-missing-external-backend"
                || ((try? array($0, key: "actions")) ?? []).contains { ($0["disposition"] as? String) == "blocked-missing-external-backend" }
        }
        let verification = try string(audit, key: "verification")
        XCTAssertTrue(["blocked", "verified"].contains(verification))
        XCTAssertEqual(audit["noFixtureOnlyCompletion"] as? Bool, true)
        if blocked {
            XCTAssertEqual(verification, "blocked")
            XCTAssertFalse(try string(audit, key: "blocker").isEmpty)
            XCTAssertFalse(try XCTUnwrap(audit["dependentStoriesBlocked"] as? [String]).isEmpty)
        } else {
            XCTAssertEqual(verification, "verified")
        }
    }

    private var iosRoot: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
    }

    private var repositoryRoot: URL {
        iosRoot.deletingLastPathComponent().deletingLastPathComponent()
    }

    private func capabilities(_ matrix: [String: Any]) throws -> [[String: Any]] {
        try array(matrix, key: "routeCapabilities") + array(matrix, key: "secondarySurfaceCapabilities")
    }

    private func contractsByID(_ cloud: [String: Any]) throws -> [String: [String: Any]] {
        try Dictionary(uniqueKeysWithValues: array(cloud, key: "contracts").map { (try string($0, key: "id"), $0) })
    }

    private func contract(_ contracts: [String: [String: Any]], id: String) throws -> [String: Any] {
        try XCTUnwrap(contracts[id], "Missing contract \(id)")
    }

    private func assertContract(
        _ contracts: [String: [String: Any]],
        _ id: String,
        method: String,
        path: String
    ) throws {
        let value = try contract(contracts, id: id)
        XCTAssertEqual(value["method"] as? String, method, id)
        XCTAssertEqual(value["path"] as? String, path, id)
    }

    private func assertContract(
        _ contracts: [String: [String: Any]],
        _ id: String,
        method: String,
        pathPrefix: String
    ) throws {
        let value = try contract(contracts, id: id)
        XCTAssertEqual(value["method"] as? String, method, id)
        XCTAssertTrue(try string(value, key: "path").hasPrefix(pathPrefix), id)
    }

    private func contractReferences(_ value: [String: Any]) -> Set<String> {
        Set((value["contracts"] as? [String]) ?? [])
    }

    private func loadJSON(_ url: URL) throws -> [String: Any] {
        let data = try Data(contentsOf: url)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func ids(_ values: [[String: Any]]) throws -> [String] {
        try values.map { try string($0, key: "id") }
    }

    private func string(_ dictionary: [String: Any], key: String) throws -> String {
        try XCTUnwrap(dictionary[key] as? String, "Missing string field \(key)")
    }

    private func dictionary(_ dictionary: [String: Any], key: String) throws -> [String: Any] {
        try XCTUnwrap(dictionary[key] as? [String: Any], "Missing object field \(key)")
    }

    private func array(_ dictionary: [String: Any], key: String) throws -> [[String: Any]] {
        try XCTUnwrap(dictionary[key] as? [[String: Any]], "Missing array field \(key)")
    }
}
