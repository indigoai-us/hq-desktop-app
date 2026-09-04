import Security
import XCTest
@testable import HQIOS

@MainActor
final class HQAuthenticationTests: XCTestCase {
    func testPKCEUsesS256Base64URLWithoutPadding() {
        XCTAssertEqual(HQOAuthClient.pkceChallenge(for: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
    }

    func testCallbackShapeRejectsPathPortCredentialsAndFragment() {
        XCTAssertTrue(HQOAuthClient.isRegisteredCallback(URL(string: "hqmobile://auth?state=s&code=c")!))
        ["hqmobile://auth/path?state=s&code=c", "hqmobile://auth:44?state=s&code=c",
         "hqmobile://user@auth?state=s&code=c", "hqmobile://auth?state=s&code=c#fragment",
         "https://auth?state=s&code=c"].forEach { XCTAssertFalse(HQOAuthClient.isRegisteredCallback(URL(string: $0)!)) }
    }

    func testStrictCallbackAcceptsQueryOrderingAndProviderErrorIsActionable() {
        let client = HQOAuthClient()
        XCTAssertEqual(try client.authorizationCode(from: URL(string: "hqmobile://auth?code=code&state=expected")!, expectedState: "expected"), "code")
        XCTAssertThrowsError(try client.authorizationCode(from: URL(string: "hqmobile://auth?error=access_denied&error_description=User%20cancelled&state=expected")!, expectedState: "expected")) {
            XCTAssertEqual($0 as? HQOAuthError, .provider(code: "access_denied", description: "User cancelled"))
            XCTAssertTrue($0.localizedDescription.contains("access_denied"))
        }
    }

    func testStrictCallbackValidatesStateBeforeCodeOrProviderError() {
        let client = HQOAuthClient()
        for raw in ["hqmobile://auth?code=ok&state=wrong", "hqmobile://auth?error=denied&state=wrong"] {
            XCTAssertThrowsError(try client.authorizationCode(from: URL(string: raw)!, expectedState: "expected")) {
                XCTAssertEqual($0 as? HQOAuthError, .stateMismatch)
            }
        }
    }

    func testStrictCallbackRejectsDuplicatesConflictsBlankAndContaminatedValues() {
        let client = HQOAuthClient()
        let invalid = [
            "hqmobile://auth?state=s&state=s&code=c", "hqmobile://auth?state=s&code=c&code=d",
            "hqmobile://auth?state=s&code=c&error=denied", "hqmobile://auth?state=s",
            "hqmobile://auth?state=s&code=", "hqmobile://auth?state=%20&code=c",
            "hqmobile://auth?state=s&code=has%20space", "hqmobile://auth?state=s&error=bad%0Avalue",
            "hqmobile://auth?state&state=s&code=c", "hqmobile://auth?state=s&code&code=c",
        ]
        for raw in invalid {
            XCTAssertThrowsError(try client.authorizationCode(from: URL(string: raw)!, expectedState: "s"), raw)
        }
    }

    func testInboundURLClassifierDoesNotTreatNavigationAsAuthMismatch() {
        XCTAssertEqual(HQInboundURLClassifier.classify(URL(string: "hqmobile://auth?state=s&code=c")!), .authenticationCallback)
        XCTAssertEqual(HQInboundURLClassifier.classify(URL(string: "hqmobile://files/item")!), .appNavigation)
        XCTAssertEqual(HQInboundURLClassifier.classify(URL(string: "https://example.com")!), .unrelated)
    }

    func testAuthorizationURLUsesPublicClientPKCEAndExactCallback() {
        let client = HQOAuthClient()
        let url = client.authorizationURL(state: "state-value", verifier: String(repeating: "v", count: 64))
        let items = Dictionary(uniqueKeysWithValues: URLComponents(url: url, resolvingAgainstBaseURL: false)!.queryItems!.map { ($0.name, $0.value) })
        XCTAssertEqual(items["redirect_uri"], "hqmobile://auth")
        XCTAssertEqual(items["response_type"], "code")
        XCTAssertEqual(items["code_challenge_method"], "S256")
        XCTAssertNil(items["client_secret"] ?? nil)
    }

    func testRandomFailureStopsBeforeBrowserPresentation() async {
        let presenter = RecordingPresenter(callback: URL(string: "hqmobile://auth")!)
        let client = HQOAuthClient(presenter: presenter, random: FailingRandom())
        do { _ = try await client.authenticate(); XCTFail("Random failure must stop sign-in") }
        catch { XCTAssertEqual(error as? HQOAuthError, .randomGenerationFailed(-1)) }
        XCTAssertEqual(presenter.presentationCount, 0)
    }

    func testIndependentStateAndVerifierHaveRequiredLengthsAndTokenRequestHasNoClientSecretOrAuthHeader() async throws {
        let presenter = StateEchoPresenter()
        let transport = RecordingTransport(data: validTokenResponse(refresh: "refresh"))
        let client = HQOAuthClient(transport: transport, presenter: presenter,
                                   random: SequenceRandom(values: [Data(repeating: 1, count: 32), Data(repeating: 2, count: 64)]),
                                   idTokenValidator: AcceptingIDTokenValidator(),
                                   clock: { Date(timeIntervalSince1970: 100) })
        let tokens = try await client.authenticate()
        XCTAssertEqual(tokens.subjectID, "subject-a")
        XCTAssertEqual(presenter.states.count, 1)
        XCTAssertFalse(presenter.verifiers[0].isEmpty)
        XCTAssertTrue((43...128).contains(presenter.verifiers[0].count))
        XCTAssertNotEqual(presenter.states[0], presenter.verifiers[0])
        let recordedRequests = await transport.requests()
        let request = try XCTUnwrap(recordedRequests.first)
        XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
        XCTAssertFalse(String(data: request.httpBody!, encoding: .utf8)!.contains("client_secret"))
    }

    func testOAuthClientAllowsOnlyOneActiveInteractiveTransaction() async throws {
        let presenter = OAuthPresenterGate()
        let client = HQOAuthClient(transport: RecordingTransport(data: validTokenResponse(refresh: "refresh")), presenter: presenter,
                                   random: SequenceRandom(values: [Data(repeating: 1, count: 32), Data(repeating: 2, count: 64)]),
                                   idTokenValidator: AcceptingIDTokenValidator())
        let first = Task { try await client.authenticate() }
        await presenter.waitUntilStarted()
        do { _ = try await client.authenticate(); XCTFail("Concurrent sign-in was accepted") }
        catch { XCTAssertEqual(error as? HQOAuthError, .concurrentSignIn) }
        presenter.finish()
        _ = try await first.value
    }

    func testTokenResponseRejectsWhitespaceWrongBearerExpiryAndBlankSubject() async {
        let invalidBodies = [
            validTokenResponse(refresh: "bad token"), validTokenResponse(refresh: "refresh", tokenType: "bearer"),
            validTokenResponse(refresh: "refresh", expires: 0), validTokenResponse(refresh: "refresh", subject: " "),
        ]
        for body in invalidBodies {
            let client = HQOAuthClient(transport: RecordingTransport(data: body), presenter: RecordingPresenter(callback: URL(string: "hqmobile://auth")!), idTokenValidator: AcceptingIDTokenValidator())
            do { _ = try await client.refresh(refreshToken: "fallback"); XCTFail("Invalid token response accepted") }
            catch { XCTAssertTrue(error is HQOAuthError) }
        }
    }

    func testRefreshResponseMayOmitRefreshTokenAndPreservesExistingValue() async throws {
        let client = HQOAuthClient(transport: RecordingTransport(data: validTokenResponse(refresh: nil)), presenter: RecordingPresenter(callback: URL(string: "hqmobile://auth")!), idTokenValidator: AcceptingIDTokenValidator(), clock: { Date(timeIntervalSince1970: 100) })
        let tokens = try await client.refresh(refreshToken: "existing-refresh")
        XCTAssertEqual(tokens.refreshToken, "existing-refresh")
        XCTAssertEqual(tokens.expiresAt, Date(timeIntervalSince1970: 3_700))
    }

    func testControllerRejectsConcurrentSignInsAndLateSignInAfterSignOut() async {
        let interactive = InteractiveGate(tokens: replacementTokens)
        let store = MemoryTokenStore(tokens: nil)
        let controller = makeController(oauth: interactive, interactive: interactive, store: store)
        let first = Task { await controller.signIn() }
        await interactive.waitUntilAuthenticationStarted()
        await controller.signIn()
        let authenticationCount = interactive.authenticationCount()
        XCTAssertEqual(authenticationCount, 1)
        await controller.signOut()
        interactive.finishAuthentication()
        await first.value
        let storedAfterSignOut = await store.tokensValue()
        XCTAssertNil(storedAfterSignOut)
        XCTAssertNotEqual(controller.state, .signedIn(subjectID: replacementTokens.subjectID))
    }

    func testNearExpiryRefreshIsSingleFlightAndWaiterCancellationCannotStrandInstallation() async throws {
        let store = MemoryTokenStore(tokens: expiredTokens)
        let refresher = RefreshGate(result: freshTokens)
        let controller = makeController(oauth: refresher, store: store)
        let restoring = Task { await controller.restoreSession() }
        await refresher.waitUntilRefreshStarted()
        let cancelledWaiter = Task { try await controller.credentials().idToken }
        let second = Task { try await controller.credentials().idToken }
        cancelledWaiter.cancel()
        await refresher.finishRefresh()
        await restoring.value
        do { _ = try await cancelledWaiter.value; XCTFail("Cancelled waiter returned credentials") }
        catch { XCTAssertTrue(error is CancellationError) }
        let secondValue = try await second.value
        let refreshCount = await refresher.refreshCount()
        let saved = await store.tokensValue()
        XCTAssertEqual(secondValue, freshTokens.idToken)
        XCTAssertEqual(refreshCount, 1)
        XCTAssertEqual(saved, freshTokens)
        XCTAssertEqual(controller.state, .signedIn(subjectID: freshTokens.subjectID))
    }

    func testExpiredButAuthenticStoredIDTokenRefreshesBeforeSessionBecomesUsableAndClampsLegacyExpiry() async throws {
        let legacy = HQAuthTokens(idToken: "expired-authentic", accessToken: "old-access", refreshToken: "valid-refresh",
                                  tokenType: "Bearer", expiresAt: Date(timeIntervalSince1970: 9_999), subjectID: "subject-a")
        let store = MemoryTokenStore(tokens: legacy)
        let oauth = RecordingRefresher(result: freshTokens)
        let validator = RestoreAwareValidator(storedResult: .success(.init(subjectID: "subject-a", expiresAt: Date(timeIntervalSince1970: 10))),
                                              freshResult: .success(.init(subjectID: "subject-a", expiresAt: Date(timeIntervalSince1970: 1_000))))
        let controller = makeController(oauth: oauth, store: store, validator: validator)

        await controller.restoreSession()

        let credentials = try await controller.credentials()
        let refreshCount = await oauth.refreshCount()
        let refreshTokens = await oauth.refreshTokens()
        let saved = await store.tokensValue()
        XCTAssertEqual(controller.state, .signedIn(subjectID: "subject-a"))
        XCTAssertEqual(credentials.idToken, "fresh-id")
        XCTAssertEqual(refreshCount, 1)
        XCTAssertEqual(refreshTokens, ["valid-refresh"])
        XCTAssertEqual(saved, freshTokens)
    }

    func testInvalidStoredIdentityPurgesWithoutTryingRefresh() async {
        let store = MemoryTokenStore(tokens: expiredTokens)
        let oauth = RecordingRefresher(result: freshTokens)
        let validator = RestoreAwareValidator(storedResult: .failure(HQIDTokenValidationError.invalidSignature),
                                              freshResult: .success(.init(subjectID: "subject-a", expiresAt: .distantFuture)))
        let controller = makeController(oauth: oauth, store: store, validator: validator)

        await controller.restoreSession()

        let refreshCount = await oauth.refreshCount()
        let remaining = await store.tokensValue()
        XCTAssertEqual(refreshCount, 0)
        XCTAssertNil(remaining)
        if case .reauthenticationRequired = controller.state {} else { XCTFail("Invalid identity was not failed closed") }
    }

    func testRevokedStoredRefreshPurgesAndPresentsActionableReauthentication() async {
        let store = MemoryTokenStore(tokens: expiredTokens)
        let oauth = RecordingRefresher(result: freshTokens, refreshError: HQOAuthError.tokenExchangeFailed(statusCode: 400))
        let validator = RestoreAwareValidator(storedResult: .success(.init(subjectID: "subject-a", expiresAt: Date(timeIntervalSince1970: 10))),
                                              freshResult: .success(.init(subjectID: "subject-a", expiresAt: .distantFuture)))
        let controller = makeController(oauth: oauth, store: store, validator: validator)

        await controller.restoreSession()

        let remaining = await store.tokensValue()
        let refreshCount = await oauth.refreshCount()
        XCTAssertNil(remaining)
        XCTAssertEqual(refreshCount, 1)
        if case let .reauthenticationRequired(message) = controller.state {
            XCTAssertFalse(message.isEmpty)
            XCTAssertTrue(message.localizedCaseInsensitiveContains("sign-in") || message.localizedCaseInsensitiveContains("sign in"))
        } else { XCTFail("Revoked refresh did not require interactive sign-in") }
    }

    func testLateRefreshAfterSignOutCannotSaveOrRestoreState() async {
        let store = MemoryTokenStore(tokens: expiredTokens)
        let refresher = RefreshGate(result: freshTokens)
        let controller = makeController(oauth: refresher, store: store)
        let restore = Task { await controller.restoreSession() }
        await refresher.waitUntilRefreshStarted()
        await controller.signOut()
        await refresher.finishRefresh()
        await restore.value
        let storedAfterLateRefresh = await store.tokensValue()
        XCTAssertNil(storedAfterLateRefresh)
        XCTAssertNotEqual(controller.state, .signedIn(subjectID: freshTokens.subjectID))
    }

    func testSignOutPurgesEveryLocalStoreBeforeBestEffortRevocation() async {
        let events = EventLog()
        let store = MemoryTokenStore(tokens: validTokens, events: events)
        let domain = RecordingProtectedStore(events: events)
        let other = RecordingProtectedStore(events: events)
        let purger = HQProtectedStatePurger(stores: [domain, other])
        let oauth = RecordingRefresher(result: freshTokens, events: events, revokeError: HQOAuthError.tokenExchangeFailed(statusCode: 503))
        let controller = makeController(oauth: oauth, store: store, purger: purger)
        await controller.restoreSession()
        await events.clear()
        await controller.signOut()
        let orderedEvents = await events.values()
        let remaining = await store.tokensValue()
        XCTAssertEqual(orderedEvents, ["keychain.purge", "protected.purge", "protected.purge", "oauth.revoke"])
        XCTAssertNil(remaining)
        XCTAssertEqual(controller.state, .signedOut(message: "Signed out on this device. HQ could not revoke the remote session while offline."))
    }

    func testKeychainPurgeFailureArmsFenceAndNeverReportsSignedOutOrRevokes() async {
        let store = MemoryTokenStore(tokens: validTokens, purgeError: HQKeychainTokenStoreError.locked(errSecInteractionNotAllowed))
        let fence = MemoryFence()
        let oauth = RecordingRefresher(result: freshTokens)
        let protected = RecordingProtectedStore()
        let controller = makeController(oauth: oauth, store: store, purger: protected, fence: fence)
        await controller.restoreSession()
        await controller.signOut()
        let fenceArmed = await fence.isArmed()
        let revokeCount = await oauth.revokeCount()
        XCTAssertTrue(fenceArmed)
        XCTAssertEqual(revokeCount, 0)
        let protectedPurges = await protected.purgeCount()
        XCTAssertGreaterThanOrEqual(protectedPurges, 1)
        if case .securityResetRequired = controller.state {} else { XCTFail("Must expose actionable fail-closed state") }
    }

    func testArmedFenceOnRelaunchPurgesBeforeLoadAndNeverRecoversStaleCredentials() async {
        let events = EventLog()
        let store = MemoryTokenStore(tokens: validTokens, events: events)
        let fence = MemoryFence(armed: true)
        let controller = makeController(oauth: RecordingRefresher(result: freshTokens), store: store, fence: fence)
        await controller.restoreSession()
        let relaunchEvents = await events.values()
        let relaunchTokens = await store.tokensValue()
        let relaunchFence = await fence.isArmed()
        XCTAssertEqual(relaunchEvents, ["keychain.purge"])
        XCTAssertNil(relaunchTokens)
        XCTAssertFalse(relaunchFence)
        XCTAssertEqual(controller.state, .signedOut(message: "Sign-out was completed securely."))
    }

    func testUnsafeMutationNeverReplaysWhileSafeAndIdempotentPoliciesRetryOnce() async throws {
        for policy in [HQAuthorizationReplayPolicy.safeRead, .idempotentMutation] {
            let controller = makeController(oauth: RecordingRefresher(result: freshTokens), store: MemoryTokenStore(tokens: validTokens))
            await controller.restoreSession()
            var attempts = 0
            let value: String = try await controller.performAuthorized(replayPolicy: policy) { _ in
                attempts += 1
                return attempts == 1 ? .init(statusCode: 401, value: nil) : .init(statusCode: 200, value: "ok")
            }
            XCTAssertEqual(value, "ok"); XCTAssertEqual(attempts, 2)
        }
        let unsafe = makeController(oauth: RecordingRefresher(result: freshTokens), store: MemoryTokenStore(tokens: validTokens))
        await unsafe.restoreSession()
        var attempts = 0
        do {
            let _: String = try await unsafe.performAuthorized(replayPolicy: .unsafeMutation) { _ in
                attempts += 1; return .init(statusCode: 401, value: nil)
            }
            XCTFail("Unsafe mutation replayed")
        } catch { XCTAssertEqual(error as? HQSessionError, .unsafeReplayDenied) }
        XCTAssertEqual(attempts, 1)
    }

    func testSecond401PurgesAndRequiresInteractiveSignIn() async {
        let store = MemoryTokenStore(tokens: validTokens)
        let controller = makeController(oauth: RecordingRefresher(result: freshTokens), store: store)
        await controller.restoreSession()
        do {
            let _: String = try await controller.performAuthorized(replayPolicy: .safeRead) { _ in .init(statusCode: 401, value: nil) }
            XCTFail("Second 401 accepted")
        } catch { XCTAssertEqual(error as? HQSessionError, .unauthorizedAfterRetry) }
        let remaining = await store.tokensValue()
        XCTAssertNil(remaining)
        if case .reauthenticationRequired = controller.state {} else { XCTFail("Expected reauthentication") }
    }

    func testCompositeProtectedStatePurgerClearsAllRegisteredStores() async throws {
        let first = RecordingProtectedStore(); let second = RecordingProtectedStore()
        let purger = HQProtectedStatePurger(stores: [first])
        await purger.register(second)
        try await purger.purgeAllProtectedState()
        let firstCount = await first.purgeCount(); let secondCount = await second.purgeCount()
        XCTAssertEqual(firstCount, 1); XCTAssertEqual(secondCount, 1)
    }

    func testProductionPurgerClearsTheRealUS003SubjectCacheOwner() async throws {
        let subject = HQSubject(id: "subject-a")
        await HQSubjectCacheOwner.shared.activate(subject)
        await HQSubjectCacheOwner.shared.store(Data("protected".utf8), for: "inbox", subject: subject)
        let before = await HQSubjectCacheOwner.shared.value(for: "inbox", subject: subject)
        XCTAssertNotNil(before)
        try await HQProtectedStatePurger().purgeAllProtectedState()
        await HQSubjectCacheOwner.shared.activate(subject)
        let after = await HQSubjectCacheOwner.shared.value(for: "inbox", subject: subject)
        XCTAssertNil(after)
    }

    func testCredentialsExposeValidatedBearerIDTokenWithoutAccessOrRefreshToken() async throws {
        let controller = makeController(oauth: RecordingRefresher(result: freshTokens), store: MemoryTokenStore(tokens: validTokens))
        await controller.restoreSession()
        let credentials = try await controller.credentials()
        XCTAssertEqual(credentials, .init(tokenType: "Bearer", idToken: "valid-id"))
        XCTAssertEqual(credentials.authorizationHeaderValue, "Bearer valid-id")
        XCTAssertFalse(String(reflecting: credentials).contains("access"))
        XCTAssertFalse(String(reflecting: credentials).contains("refresh"))
    }

    func testAuthorizedOperationReceivesExactCredentialsOnInitialAttemptAndRetryWithoutOtherTokens() async throws {
        let initial = HQAuthTokens(idToken: "initial-id", accessToken: "ACCESS-SENTINEL", refreshToken: "REFRESH-SENTINEL",
                                   tokenType: "Bearer", expiresAt: Date(timeIntervalSince1970: 1_000), subjectID: "subject-a")
        let rotated = HQAuthTokens(idToken: "rotated-id", accessToken: "ROTATED-ACCESS-SENTINEL", refreshToken: "ROTATED-REFRESH-SENTINEL",
                                   tokenType: "Bearer", expiresAt: Date(timeIntervalSince1970: 1_000), subjectID: "subject-a")
        let controller = makeController(oauth: RecordingRefresher(result: rotated), store: MemoryTokenStore(tokens: initial))
        await controller.restoreSession()
        var received: [HQAuthorizationCredentials] = []
        let value: String = try await controller.performAuthorized(replayPolicy: .safeRead) { credentials in
            received.append(credentials)
            return received.count == 1 ? .init(statusCode: 401, value: nil) : .init(statusCode: 200, value: "ok")
        }
        XCTAssertEqual(value, "ok")
        XCTAssertEqual(received.map(\.authorizationHeaderValue), ["Bearer initial-id", "Bearer rotated-id"])
        let boundary = String(reflecting: received)
        XCTAssertFalse(boundary.contains("ACCESS-SENTINEL")); XCTAssertFalse(boundary.contains("REFRESH-SENTINEL"))
    }

    func testConcurrent401sRejectedFromSameCredentialRevisionShareOneForcedRefresh() async throws {
        let refresher = RefreshGate(result: freshTokens)
        let controller = makeController(oauth: refresher, store: MemoryTokenStore(tokens: validTokens))
        await controller.restoreSession()
        let firstCapture = CredentialAttemptCapture()
        let secondCapture = CredentialAttemptCapture()
        let first = Task { try await controller.performAuthorized(replayPolicy: .safeRead) { credentials in await firstCapture.response(for: credentials) } as String }
        await refresher.waitUntilRefreshStarted()
        let second = Task { try await controller.performAuthorized(replayPolicy: .safeRead) { credentials in await secondCapture.response(for: credentials) } as String }
        await secondCapture.waitUntilFirstAttempt()
        await refresher.finishRefresh()
        let firstValue = try await first.value; let secondValue = try await second.value
        XCTAssertEqual(firstValue, "ok")
        XCTAssertEqual(secondValue, "ok")
        let refreshes = await refresher.refreshCount()
        let firstHeaders = await firstCapture.headers(); let secondHeaders = await secondCapture.headers()
        XCTAssertEqual(refreshes, 1)
        XCTAssertEqual(firstHeaders, ["Bearer valid-id", "Bearer fresh-id"])
        XCTAssertEqual(secondHeaders, ["Bearer valid-id", "Bearer fresh-id"])
    }

    func testSaveStraddlingSignOutIsSerializedAndStaleSaveCleanupSucceeds() async {
        let store = GatedTokenStore(tokens: validTokens)
        let fence = MemoryFence()
        let interactive = ImmediateInteractive(tokens: replacementTokens)
        let controller = makeController(oauth: interactive, interactive: interactive, store: store, fence: fence)
        await controller.restoreSession()
        let signIn = Task { await controller.signIn() }
        await store.waitUntilSaveStarted()
        let signOut = Task { await controller.signOut() }
        await store.finishSave()
        await signIn.value; await signOut.value
        let remaining = await store.tokensValue(); let armed = await fence.isArmed()
        XCTAssertNil(remaining); XCTAssertFalse(armed)
        if case .signedOut = controller.state {} else { XCTFail("Serialized cleanup must end signed out") }
    }

    func testStaleSaveCleanupFailureLatchesSecurityStateAndRelaunchCompletesFence() async {
        let store = GatedTokenStore(tokens: validTokens)
        let fence = MemoryFence()
        let interactive = ImmediateInteractive(tokens: replacementTokens)
        let controller = makeController(oauth: interactive, interactive: interactive, store: store, fence: fence)
        await controller.restoreSession()
        let signIn = Task { await controller.signIn() }
        await store.waitUntilSaveStarted()
        await store.setPurgeError(TestAuthError.failure)
        let signOut = Task { await controller.signOut() }
        await store.finishSave()
        await signIn.value; await signOut.value
        if case .securityResetRequired = controller.state {} else { XCTFail("Cleanup failure must latch fail-closed state") }
        let failedFenceArmed = await fence.isArmed()
        XCTAssertTrue(failedFenceArmed)

        await store.setPurgeError(nil)
        let relaunched = makeController(oauth: RecordingRefresher(result: freshTokens), store: store, fence: fence)
        await relaunched.restoreSession()
        let relaunchedTokens = await store.tokensValue(); let relaunchedFence = await fence.isArmed()
        XCTAssertNil(relaunchedTokens)
        XCTAssertFalse(relaunchedFence)
        if case .signedOut = relaunched.state {} else { XCTFail("Relaunch must finish tombstoned purge") }
    }

    func testTombstoneArmAndClearFailuresNeverPublishSignedOut() async {
        let armStore = MemoryTokenStore(tokens: validTokens)
        let armFailure = makeController(oauth: RecordingRefresher(result: freshTokens), store: armStore,
                                        fence: MemoryFence(armError: TestAuthError.failure))
        await armFailure.restoreSession(); await armFailure.signOut()
        if case .securityResetRequired = armFailure.state {} else { XCTFail("Arm failure reported signed out") }
        let armFailureTokens = await armStore.tokensValue()
        XCTAssertNil(armFailureTokens, "Arm failure must still attempt exact credential deletion")

        let clearFence = MemoryFence(clearError: TestAuthError.failure)
        let clearFailure = makeController(oauth: RecordingRefresher(result: freshTokens), store: MemoryTokenStore(tokens: validTokens), fence: clearFence)
        await clearFailure.restoreSession(); await clearFailure.signOut()
        if case .securityResetRequired = clearFailure.state {} else { XCTFail("Clear failure reported signed out") }
        let clearStillArmed = await clearFence.isArmed()
        XCTAssertTrue(clearStillArmed)
    }

    func testTombstoneArmAndCredentialDeleteFailureLatchesHonestCrashRisk() async {
        let store = MemoryTokenStore(tokens: validTokens, purgeError: TestAuthError.failure)
        let fence = MemoryFence(armError: TestAuthError.failure)
        let controller = makeController(oauth: RecordingRefresher(result: freshTokens), store: store, fence: fence)
        await controller.restoreSession(); await controller.signOut()
        if case .securityResetRequired = controller.state {} else { XCTFail("Dual local failure reported signed out") }
        let remaining = await store.tokensValue(); let armed = await fence.isArmed()
        XCTAssertNotNil(remaining)
        XCTAssertFalse(armed, "If both Keychain writes fail, no durable tombstone can be claimed")
    }

    func testIndependentMarkerSurvivesKeychainArmAndCredentialDeleteFailureAcrossFreshProcessThenCleansUp() async {
        let store = MemoryTokenStore(tokens: validTokens, purgeError: TestAuthError.failure)
        let keychainFence = MemoryFence(armError: TestAuthError.failure)
        let appContainerFence = MemoryFence()
        let composite = HQCompositeSignOutFence(primary: keychainFence, secondary: appContainerFence)
        let firstProcess = makeController(oauth: RecordingRefresher(result: freshTokens), store: store, fence: composite)
        await firstProcess.restoreSession()
        await firstProcess.signOut()
        let fallbackArmed = await appContainerFence.isArmed()
        let failedPurgeTokens = await store.tokensValue()
        if case .securityResetRequired = firstProcess.state {} else { XCTFail("Dual local failure was reported as signed out") }
        XCTAssertTrue(fallbackArmed, "Independent app-container marker was not persisted")
        XCTAssertNotNil(failedPurgeTokens)

        await store.setPurgeError(nil)
        // Simulate the next process seeing Keychain available again; the
        // independent marker is what carries the interrupted purge across it.
        let freshProcessFence = HQCompositeSignOutFence(primary: MemoryFence(), secondary: appContainerFence)
        let freshProcess = makeController(oauth: RecordingRefresher(result: freshTokens), store: store, fence: freshProcessFence)
        await freshProcess.restoreSession()
        let remaining = await store.tokensValue()
        let cleanedFallback = await appContainerFence.isArmed()
        XCTAssertNil(remaining, "Fresh process restored credentials despite a surviving marker")
        XCTAssertFalse(cleanedFallback)
        if case .signedOut = freshProcess.state {} else { XCTFail("Later cleanup did not complete securely") }
    }

    func testSecondaryMarkerFailureWithKeychainSuccessRemainsFailClosedUntilFreshProcessCleanup() async {
        let store = MemoryTokenStore(tokens: validTokens)
        let keychainFence = MemoryFence()
        let unavailableSecondary = MemoryFence(armError: TestAuthError.failure)
        let controller = makeController(oauth: RecordingRefresher(result: freshTokens), store: store,
                                        fence: HQCompositeSignOutFence(primary: keychainFence, secondary: unavailableSecondary))
        await controller.restoreSession()
        await controller.signOut()
        let keychainArmed = await keychainFence.isArmed()
        let remaining = await store.tokensValue()
        XCTAssertTrue(keychainArmed)
        XCTAssertNil(remaining)
        if case .securityResetRequired = controller.state {} else { XCTFail("Secondary marker failure was hidden") }

        let healthySecondary = MemoryFence()
        let freshProcess = makeController(oauth: RecordingRefresher(result: freshTokens), store: store,
                                          fence: HQCompositeSignOutFence(primary: keychainFence, secondary: healthySecondary))
        await freshProcess.restoreSession()
        let cleanedKeychain = await keychainFence.isArmed()
        XCTAssertFalse(cleanedKeychain)
        if case .signedOut = freshProcess.state {} else { XCTFail("Keychain marker did not drive fresh-process cleanup") }
    }

    func testDualMarkerFailureStaysHonestSecurityResetAndStillAttemptsCredentialDeletion() async {
        let store = MemoryTokenStore(tokens: validTokens, purgeError: TestAuthError.failure)
        let primary = MemoryFence(armError: TestAuthError.failure)
        let secondary = MemoryFence(armError: TestAuthError.failure)
        let controller = makeController(oauth: RecordingRefresher(result: freshTokens), store: store,
                                        fence: HQCompositeSignOutFence(primary: primary, secondary: secondary))
        await controller.restoreSession()
        await controller.signOut()
        let remaining = await store.tokensValue()
        let primaryArmed = await primary.isArmed()
        let secondaryArmed = await secondary.isArmed()
        XCTAssertNotNil(remaining)
        XCTAssertFalse(primaryArmed)
        XCTAssertFalse(secondaryArmed)
        if case .securityResetRequired = controller.state {} else { XCTFail("Unprovable purge was reported as signed out") }
    }

    func testOlderQueuedPurgeCannotClearNewerGenerationFence() async throws {
        let store = MemoryTokenStore(tokens: validTokens)
        let fence = FirstArmGatedFence()
        let vault = HQLocalCredentialVault(tokenStore: store, fence: fence)
        let oldPurge = Task { try await vault.invalidateAndPurge(generation: 1) }
        await fence.waitUntilFirstArmStarted()
        let newPurge = Task { try await vault.invalidateAndPurge(generation: 2) }
        while !(await vault.hasInvalidated(through: 2)) { await Task.yield() }
        let staleClear = Task { try await vault.clearFence(generation: 1) }
        await fence.finishFirstArm()
        try await oldPurge.value
        try await newPurge.value
        do { try await staleClear.value; XCTFail("Older purge cleared a newer fence") }
        catch { XCTAssertEqual(error as? HQLocalCredentialVaultError, .staleSaveCleaned) }
        let newerFenceArmed = await fence.isArmed()
        XCTAssertTrue(newerFenceArmed)
        try await vault.clearFence(generation: 2)
        let cleared = await fence.isArmed()
        XCTAssertFalse(cleared)
    }

    func testCancellationAfterCallbackBeforeTokenExchangeCompletionCannotReturnTokens() async {
        let transport = GatedOAuthTransport(data: validTokenResponse(refresh: "refresh"))
        let client = HQOAuthClient(transport: transport, presenter: StateEchoPresenter(),
                                   random: SequenceRandom(values: [Data(repeating: 1, count: 32), Data(repeating: 2, count: 64)]),
                                   idTokenValidator: AcceptingIDTokenValidator())
        let authentication = Task { try await client.authenticate() }
        await transport.waitUntilStarted()
        authentication.cancel()
        await transport.finish()
        do { _ = try await authentication.value; XCTFail("Cancelled exchange returned tokens") }
        catch { XCTAssertTrue(error is CancellationError) }
    }

    func testOAuthExpiryIsClampedToSignedIDTokenExpiration() async throws {
        let validator = FixedIDTokenValidator(result: .init(subjectID: "subject-a", expiresAt: Date(timeIntervalSince1970: 500)))
        let client = HQOAuthClient(transport: RecordingTransport(data: validTokenResponse(refresh: nil)),
                                   presenter: RecordingPresenter(callback: URL(string: "hqmobile://auth")!),
                                   idTokenValidator: validator, clock: { Date(timeIntervalSince1970: 100) })
        let tokens = try await client.refresh(refreshToken: "existing-refresh")
        XCTAssertEqual(tokens.expiresAt, Date(timeIntervalSince1970: 500))
    }

    func testAccountSwitchPurgesProtectedStateBeforeSavingReplacement() async {
        let events = EventLog()
        let store = MemoryTokenStore(tokens: validTokens, events: events)
        let protected = RecordingProtectedStore(events: events)
        let interactive = ImmediateInteractive(tokens: replacementTokens)
        let controller = makeController(oauth: interactive, interactive: interactive, store: store, purger: protected)
        await controller.restoreSession()
        await events.clear()
        await controller.signIn()
        let stored = await store.tokensValue()
        let accountSwitchEvents = await events.values()
        XCTAssertEqual(stored, replacementTokens)
        XCTAssertEqual(accountSwitchEvents, ["protected.purge", "keychain.save"])
    }

    func testKeychainAdapterMapsStatusesAndEnforcesAttributesOnUpdateAndRecreate() async throws {
        let adapter = FakeSecurityAdapter()
        let store = HQKeychainTokenStore(security: adapter)
        await adapter.configure(add: [errSecDuplicateItem, errSecSuccess], update: [errSecSuccess])
        try await store.save(validTokens)
        let calls = await adapter.calls()
        XCTAssertEqual(calls.map(\.kind), ["add", "update"])
        XCTAssertTrue(calls.allSatisfy { $0.accessibility == kSecAttrAccessibleWhenUnlockedThisDeviceOnly as String && !$0.synchronizable })

        await adapter.configure(add: [errSecDuplicateItem, errSecSuccess], update: [errSecItemNotFound])
        try await store.save(validTokens)
        let recreatedCalls = await adapter.calls()
        XCTAssertEqual(Array(recreatedCalls.suffix(3)).map(\.kind), ["add", "update", "add"])

        await adapter.setCopy(status: errSecInteractionNotAllowed, data: nil)
        do { _ = try await store.load(); XCTFail("Locked status accepted") }
        catch { XCTAssertEqual(error as? HQKeychainTokenStoreError, .locked(errSecInteractionNotAllowed)) }
        await adapter.setCopy(status: errSecInternalError, data: nil)
        do { _ = try await store.load(); XCTFail("Other Keychain failure accepted") }
        catch { XCTAssertEqual(error as? HQKeychainTokenStoreError, .operationFailed(errSecInternalError)) }
        await adapter.setCopy(status: errSecSuccess, data: Data("corrupt".utf8))
        do { _ = try await store.load(); XCTFail("Corrupt Keychain data accepted") }
        catch { XCTAssertEqual(error as? HQKeychainTokenStoreError, .corrupt) }
    }

    func testIndependentFileMarkerIsAtomicCheckedDurableAcrossInstancesAndTreatsCorruptionAsArmed() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("hq-file-fence-tests", isDirectory: true)
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let marker = root.appendingPathComponent("pending-local-purge-v1")
        defer { try? FileManager.default.removeItem(at: root) }

        let firstProcess = HQFileSignOutFence(markerURL: marker)
        try await firstProcess.arm()
        let relaunched = HQFileSignOutFence(markerURL: marker)
        let persisted = try await relaunched.isArmed()
        XCTAssertTrue(persisted)
        try await relaunched.clear()
        let cleared = try await firstProcess.isArmed()
        XCTAssertFalse(cleared)

        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try Data("not-a-valid-marker".utf8).write(to: marker, options: .atomic)
        let corruptMarkerIsArmed = try await HQFileSignOutFence(markerURL: marker).isArmed()
        XCTAssertTrue(corruptMarkerIsArmed)
    }

    func testMalformedKeychainMarkerIsFailClosedArmed() async throws {
        let security = StatefulSecurityAdapter(items: [
            .init(service: HQKeychainSignOutFence.service, account: HQKeychainSignOutFence.account): Data("malformed".utf8),
        ])
        let fence = HQKeychainSignOutFence(security: security)
        let isArmed = try await fence.isArmed()
        XCTAssertTrue(isArmed)
    }

    func testCompositeFenceTreatsEitherSoleMalformedMarkerAsArmed() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("hq-composite-malformed-tests", isDirectory: true)
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let marker = root.appendingPathComponent("pending-local-purge-v1")
        defer { try? FileManager.default.removeItem(at: root) }

        let keychainSecurity = StatefulSecurityAdapter(items: [
            .init(service: HQKeychainSignOutFence.service, account: HQKeychainSignOutFence.account): Data("malformed".utf8),
        ])
        let malformedKeychain = HQCompositeSignOutFence(
            primary: HQKeychainSignOutFence(security: keychainSecurity),
            secondary: HQFileSignOutFence(markerURL: marker)
        )
        let malformedKeychainIsArmed = try await malformedKeychain.isArmed()
        XCTAssertTrue(malformedKeychainIsArmed)

        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try Data("malformed".utf8).write(to: marker, options: .atomic)
        let malformedFile = HQCompositeSignOutFence(
            primary: HQKeychainSignOutFence(security: StatefulSecurityAdapter()),
            secondary: HQFileSignOutFence(markerURL: marker)
        )
        let malformedFileIsArmed = try await malformedFile.isArmed()
        XCTAssertTrue(malformedFileIsArmed)
    }

    func testSoleMalformedKeychainMarkerPurgesClearsAndNextLaunchRecovers() async throws {
        let security = StatefulSecurityAdapter(items: [
            .init(service: HQKeychainSignOutFence.service, account: HQKeychainSignOutFence.account): Data("malformed".utf8),
        ])
        let store = MemoryTokenStore(tokens: validTokens)
        let protected = RecordingProtectedStore()
        let firstProcess = makeController(
            oauth: RecordingRefresher(result: freshTokens), store: store, purger: protected,
            fence: HQKeychainSignOutFence(security: security)
        )
        await firstProcess.restoreSession()

        let remainingTokens = await store.tokensValue()
        let purgeCount = await protected.purgeCount()
        let markerStillArmed = try await HQKeychainSignOutFence(security: security).isArmed()
        XCTAssertNil(remainingTokens)
        XCTAssertEqual(purgeCount, 1)
        XCTAssertFalse(markerStillArmed)
        if case .signedOut = firstProcess.state {} else { XCTFail("Malformed Keychain marker did not complete cleanup") }

        let nextLaunch = makeController(
            oauth: RecordingRefresher(result: freshTokens), store: store,
            fence: HQKeychainSignOutFence(security: security)
        )
        await nextLaunch.restoreSession()
        if case .signedOut = nextLaunch.state {} else { XCTFail("Fresh launch did not recover after Keychain cleanup") }
        XCTAssertTrue(nextLaunch.canStartSignIn)
    }

    func testSoleMalformedFileMarkerPurgesClearsAndNextLaunchRecovers() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("hq-file-malformed-relaunch-tests", isDirectory: true)
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let marker = root.appendingPathComponent("pending-local-purge-v1")
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try Data("malformed".utf8).write(to: marker, options: .atomic)

        let store = MemoryTokenStore(tokens: validTokens)
        let protected = RecordingProtectedStore()
        let firstProcess = makeController(
            oauth: RecordingRefresher(result: freshTokens), store: store, purger: protected,
            fence: HQFileSignOutFence(markerURL: marker)
        )
        await firstProcess.restoreSession()

        let remainingTokens = await store.tokensValue()
        let purgeCount = await protected.purgeCount()
        XCTAssertNil(remainingTokens)
        XCTAssertEqual(purgeCount, 1)
        XCTAssertFalse(FileManager.default.fileExists(atPath: marker.path))
        if case .signedOut = firstProcess.state {} else { XCTFail("Malformed file marker did not complete cleanup") }

        let nextLaunch = makeController(
            oauth: RecordingRefresher(result: freshTokens), store: store,
            fence: HQFileSignOutFence(markerURL: marker)
        )
        await nextLaunch.restoreSession()
        if case .signedOut = nextLaunch.state {} else { XCTFail("Fresh launch did not recover after file-marker cleanup") }
        XCTAssertTrue(nextLaunch.canStartSignIn)
    }

    func testRealSimulatorKeychainLifecyclePersistsAcrossStoreRelaunchAndHandlesCorruption() async throws {
        let service = "com.hqforwork.mobile.tests.\(UUID().uuidString)"
        let store = HQKeychainTokenStore(service: service)
        defer { SecItemDelete([kSecClass: kSecClassGenericPassword, kSecAttrService: service] as CFDictionary) }
        try await store.save(validTokens)
        let relaunchedStore = HQKeychainTokenStore(service: service)
        let initialLoad = try await relaunchedStore.load()
        XCTAssertEqual(initialLoad, validTokens)
        try await relaunchedStore.save(freshTokens)
        let secondRelaunch = HQKeychainTokenStore(service: service)
        let updatedLoad = try await secondRelaunch.load()
        XCTAssertEqual(updatedLoad, freshTokens)
        try await secondRelaunch.purge()
        let purgedLoad = try await HQKeychainTokenStore(service: service).load()
        XCTAssertNil(purgedLoad)

        let status = SecItemAdd([kSecClass: kSecClassGenericPassword, kSecAttrService: service,
                                 kSecAttrAccount: "oauth-session-v1", kSecValueData: Data("corrupt".utf8),
                                 kSecAttrAccessible: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
                                 kSecAttrSynchronizable: kCFBooleanFalse as Any] as CFDictionary, nil)
        XCTAssertEqual(status, errSecSuccess)
        do { _ = try await HQKeychainTokenStore(service: service).load(); XCTFail("Corrupt data accepted") }
        catch { XCTAssertEqual(error as? HQKeychainTokenStoreError, .corrupt) }
        let afterCorrupt = try await HQKeychainTokenStore(service: service).load()
        XCTAssertNil(afterCorrupt)
    }

    private func makeController(oauth: any HQTokenRefreshing,
                                interactive: (any HQInteractiveOAuthAuthenticating)? = nil,
                                store: any HQTokenStoring,
                                purger: any HQProtectedStatePurging = RecordingProtectedStore(),
                                fence: any HQSignOutFenceStoring = MemoryFence(),
                                validator: any HQIDTokenValidating = AcceptingIDTokenValidator()) -> HQSessionController {
        HQSessionController(oauth: oauth, interactiveOAuth: interactive, tokenStore: store, protectedState: purger,
                            signOutFence: fence, idTokenValidator: validator, clock: { Date(timeIntervalSince1970: 100) })
    }

    private var validTokens: HQAuthTokens { .init(idToken: "valid-id", accessToken: "access", refreshToken: "refresh", tokenType: "Bearer", expiresAt: Date(timeIntervalSince1970: 1_000), subjectID: "subject-a") }
    private var expiredTokens: HQAuthTokens { .init(idToken: "expired-id", accessToken: "access", refreshToken: "refresh", tokenType: "Bearer", expiresAt: Date(timeIntervalSince1970: 10), subjectID: "subject-a") }
    private var freshTokens: HQAuthTokens { .init(idToken: "fresh-id", accessToken: "access", refreshToken: "rotated-refresh", tokenType: "Bearer", expiresAt: Date(timeIntervalSince1970: 1_000), subjectID: "subject-a") }
    private var replacementTokens: HQAuthTokens { .init(idToken: "new-id", accessToken: "new-access", refreshToken: "new-refresh", tokenType: "Bearer", expiresAt: Date(timeIntervalSince1970: 1_000), subjectID: "subject-b") }
}

private func validTokenResponse(refresh: String?, tokenType: String = "Bearer", expires: Int = 3_600, subject: String = "subject-a") -> Data {
    let payload = try! JSONSerialization.data(withJSONObject: ["sub": subject]).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    var body: [String: Any] = ["id_token": "e30.\(payload).sig", "access_token": "access", "token_type": tokenType, "expires_in": expires]
    if let refresh { body["refresh_token"] = refresh }
    return try! JSONSerialization.data(withJSONObject: body)
}

private struct FailingRandom: HQRandomByteGenerating { func bytes(count: Int) throws -> Data { throw HQOAuthError.randomGenerationFailed(-1) } }
private final class SequenceRandom: HQRandomByteGenerating, @unchecked Sendable {
    private var values: [Data]; private let lock = NSLock()
    init(values: [Data]) { self.values = values }
    func bytes(count: Int) throws -> Data { lock.withLock { values.removeFirst() } }
}

@MainActor private final class RecordingPresenter: HQWebAuthenticationPresenting {
    let callback: URL; var presentationCount = 0
    init(callback: URL) { self.callback = callback }
    func authenticate(url: URL, callbackScheme: String) async throws -> URL { presentationCount += 1; return callback }
}

@MainActor private final class StateEchoPresenter: HQWebAuthenticationPresenting {
    var states: [String] = []; var verifiers: [String] = []
    func authenticate(url: URL, callbackScheme: String) async throws -> URL {
        let items = Dictionary(uniqueKeysWithValues: URLComponents(url: url, resolvingAgainstBaseURL: false)!.queryItems!.map { ($0.name, $0.value!) })
        states.append(items["state"]!); verifiers.append(items["code_challenge"]!)
        return URL(string: "hqmobile://auth?code=code&state=\(items["state"]!)")!
    }
}

@MainActor private final class OAuthPresenterGate: HQWebAuthenticationPresenting {
    private var continuation: CheckedContinuation<URL, Error>?
    private var state: String?
    func authenticate(url: URL, callbackScheme: String) async throws -> URL {
        let items = Dictionary(uniqueKeysWithValues: URLComponents(url: url, resolvingAgainstBaseURL: false)!.queryItems!.map { ($0.name, $0.value!) })
        state = items["state"]
        return try await withCheckedThrowingContinuation { continuation = $0 }
    }
    func waitUntilStarted() async { while continuation == nil { await Task.yield() } }
    func finish() { continuation?.resume(returning: URL(string: "hqmobile://auth?state=\(state!)&code=code")!); continuation = nil }
}

private actor RecordingTransport: HQOAuthTransport {
    let data: Data; var sent: [URLRequest] = []
    init(data: Data) { self.data = data }
    func send(_ request: URLRequest) -> (Data, HTTPURLResponse) {
        sent.append(request)
        return (data, HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
    }
    func requests() -> [URLRequest] { sent }
}

private actor EventLog {
    var events: [String] = []
    func append(_ event: String) { events.append(event) }
    func values() -> [String] { events }
    func clear() { events.removeAll() }
}

private actor MemoryTokenStore: HQTokenStoring {
    var tokens: HQAuthTokens?; var purgeError: Error?; let events: EventLog?
    init(tokens: HQAuthTokens?, events: EventLog? = nil, purgeError: Error? = nil) { self.tokens = tokens; self.events = events; self.purgeError = purgeError }
    func load() -> HQAuthTokens? { tokens }
    func save(_ tokens: HQAuthTokens) async { self.tokens = tokens; await events?.append("keychain.save") }
    func purge() async throws { await events?.append("keychain.purge"); if let purgeError { throw purgeError }; tokens = nil }
    func tokensValue() -> HQAuthTokens? { tokens }
    func setPurgeError(_ error: Error?) { purgeError = error }
}

private actor MemoryFence: HQSignOutFenceStoring {
    var armed: Bool
    let armError: Error?
    let clearError: Error?
    init(armed: Bool = false, armError: Error? = nil, clearError: Error? = nil) {
        self.armed = armed; self.armError = armError; self.clearError = clearError
    }
    func isArmed() -> Bool { armed }
    func arm() throws { if let armError { throw armError }; armed = true }
    func clear() throws { if let clearError { throw clearError }; armed = false }
}

private actor FirstArmGatedFence: HQSignOutFenceStoring {
    private var armed = false
    private var armCount = 0
    private var firstArmStarted = false
    private var firstArmContinuation: CheckedContinuation<Void, Never>?
    func isArmed() -> Bool { armed }
    func arm() async {
        armCount += 1
        if armCount == 1 {
            firstArmStarted = true
            await withCheckedContinuation { firstArmContinuation = $0 }
        }
        armed = true
    }
    func clear() { armed = false }
    func waitUntilFirstArmStarted() async { while !firstArmStarted { await Task.yield() } }
    func finishFirstArm() { firstArmContinuation?.resume(); firstArmContinuation = nil }
}

private struct AcceptingIDTokenValidator: HQIDTokenValidating {
    func validate(_ token: String, now: Date) async throws -> HQValidatedIDToken {
        if token == "new-id" { return .init(subjectID: "subject-b", expiresAt: .distantFuture) }
        let parts = token.split(separator: ".", omittingEmptySubsequences: false)
        if parts.count == 3, let data = Data(hqBase64URL: String(parts[1])),
           let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let subject = object["sub"] as? String {
            guard !subject.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw HQIDTokenValidationError.invalidSubject }
            return .init(subjectID: subject, expiresAt: .distantFuture)
        }
        return .init(subjectID: "subject-a", expiresAt: .distantFuture)
    }
}

private struct FixedIDTokenValidator: HQIDTokenValidating {
    let result: HQValidatedIDToken
    func validate(_ token: String, now: Date) async throws -> HQValidatedIDToken { result }
}

private struct RestoreAwareValidator: HQIDTokenValidating, @unchecked Sendable {
    let storedResult: Result<HQValidatedIDToken, Error>
    let freshResult: Result<HQValidatedIDToken, Error>
    func validate(_ token: String, now: Date) async throws -> HQValidatedIDToken { try freshResult.get() }
    func validateStoredIdentity(_ token: String, now: Date) async throws -> HQValidatedIDToken { try storedResult.get() }
}

private actor RecordingProtectedStore: HQProtectedStateStore, HQProtectedStatePurging {
    let events: EventLog?; var count = 0
    init(events: EventLog? = nil) { self.events = events }
    func purgeProtectedState() async { count += 1; await events?.append("protected.purge") }
    func purgeAllProtectedState() async { await purgeProtectedState() }
    func purgeCount() -> Int { count }
}

private actor RecordingRefresher: HQTokenRefreshing {
    let result: HQAuthTokens; let events: EventLog?; let refreshError: Error?; let revokeError: Error?
    var revokes = 0; var refreshes: [String] = []
    init(result: HQAuthTokens, events: EventLog? = nil, refreshError: Error? = nil, revokeError: Error? = nil) {
        self.result = result; self.events = events; self.refreshError = refreshError; self.revokeError = revokeError
    }
    func refresh(refreshToken: String) throws -> HQAuthTokens {
        refreshes.append(refreshToken)
        if let refreshError { throw refreshError }
        return result
    }
    func revoke(refreshToken: String) async throws { revokes += 1; await events?.append("oauth.revoke"); if let revokeError { throw revokeError } }
    func revokeCount() -> Int { revokes }
    func refreshCount() -> Int { refreshes.count }
    func refreshTokens() -> [String] { refreshes }
}

private actor RefreshGate: HQTokenRefreshing {
    let result: HQAuthTokens; var count = 0; var continuation: CheckedContinuation<HQAuthTokens, Error>?
    init(result: HQAuthTokens) { self.result = result }
    func refresh(refreshToken: String) async throws -> HQAuthTokens { count += 1; return try await withCheckedThrowingContinuation { continuation = $0 } }
    func revoke(refreshToken: String) {}
    func waitUntilRefreshStarted() async { while continuation == nil { await Task.yield() } }
    func finishRefresh() { continuation?.resume(returning: result); continuation = nil }
    func refreshCount() -> Int { count }
}

private actor CredentialAttemptCapture {
    private var captured: [HQAuthorizationCredentials] = []
    func response(for credentials: HQAuthorizationCredentials) -> HQAuthorizedResponse<String> {
        captured.append(credentials)
        return captured.count == 1 ? .init(statusCode: 401, value: nil) : .init(statusCode: 200, value: "ok")
    }
    func waitUntilFirstAttempt() async { while captured.isEmpty { await Task.yield() } }
    func headers() -> [String] { captured.map(\.authorizationHeaderValue) }
}

private enum TestAuthError: Error { case failure }

private actor GatedTokenStore: HQTokenStoring {
    private var tokens: HQAuthTokens?
    private var saveContinuation: CheckedContinuation<Void, Never>?
    private var pendingTokens: HQAuthTokens?
    private var purgeError: Error?
    init(tokens: HQAuthTokens?) { self.tokens = tokens }
    func load() -> HQAuthTokens? { tokens }
    func save(_ tokens: HQAuthTokens) async {
        pendingTokens = tokens
        await withCheckedContinuation { saveContinuation = $0 }
        self.tokens = pendingTokens
        pendingTokens = nil
    }
    func purge() throws { if let purgeError { throw purgeError }; tokens = nil; pendingTokens = nil }
    func waitUntilSaveStarted() async { while saveContinuation == nil { await Task.yield() } }
    func finishSave() { saveContinuation?.resume(); saveContinuation = nil }
    func setPurgeError(_ error: Error?) { purgeError = error }
    func tokensValue() -> HQAuthTokens? { tokens }
}

private actor GatedOAuthTransport: HQOAuthTransport {
    let data: Data
    private var request: URLRequest?
    private var continuation: CheckedContinuation<Void, Never>?
    init(data: Data) { self.data = data }
    func send(_ request: URLRequest) async -> (Data, HTTPURLResponse) {
        self.request = request
        await withCheckedContinuation { continuation = $0 }
        return (data, HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
    }
    func waitUntilStarted() async { while continuation == nil { await Task.yield() } }
    func finish() { continuation?.resume(); continuation = nil }
}

@MainActor private final class InteractiveGate: HQInteractiveOAuthAuthenticating {
    let tokens: HQAuthTokens; var count = 0; var continuation: CheckedContinuation<HQAuthTokens, Error>?
    init(tokens: HQAuthTokens) { self.tokens = tokens }
    func authenticate() async throws -> HQAuthTokens { count += 1; return try await withCheckedThrowingContinuation { continuation = $0 } }
    func refresh(refreshToken: String) async throws -> HQAuthTokens { tokens }
    func revoke(refreshToken: String) async throws {}
    func waitUntilAuthenticationStarted() async { while continuation == nil { await Task.yield() } }
    func finishAuthentication() { continuation?.resume(returning: tokens); continuation = nil }
    func authenticationCount() -> Int { count }
}

@MainActor private final class ImmediateInteractive: HQInteractiveOAuthAuthenticating {
    let tokens: HQAuthTokens
    init(tokens: HQAuthTokens) { self.tokens = tokens }
    func authenticate() async throws -> HQAuthTokens { tokens }
    func refresh(refreshToken: String) async throws -> HQAuthTokens { tokens }
    func revoke(refreshToken: String) async throws {}
}

private struct SecurityCall: Sendable { let kind: String; let accessibility: String; let synchronizable: Bool }
private struct StatefulSecurityKey: Hashable, Sendable {
    let service: String
    let account: String
}
private final class StatefulSecurityAdapter: HQSecurityAdapting, @unchecked Sendable {
    private let lock = NSLock()
    private var items: [StatefulSecurityKey: Data]

    init(items: [StatefulSecurityKey: Data] = [:]) { self.items = items }

    func copy(service: String, account: String) -> (OSStatus, Data?) {
        lock.withLock {
            guard let data = items[.init(service: service, account: account)] else { return (errSecItemNotFound, nil) }
            return (errSecSuccess, data)
        }
    }

    func add(service: String, account: String, data: Data, accessibility: CFString, synchronizable: Bool) -> OSStatus {
        lock.withLock {
            let key = StatefulSecurityKey(service: service, account: account)
            guard items[key] == nil else { return errSecDuplicateItem }
            items[key] = data
            return errSecSuccess
        }
    }

    func update(service: String, account: String, data: Data, accessibility: CFString, synchronizable: Bool) -> OSStatus {
        lock.withLock {
            let key = StatefulSecurityKey(service: service, account: account)
            guard items[key] != nil else { return errSecItemNotFound }
            items[key] = data
            return errSecSuccess
        }
    }

    func delete(service: String, account: String) -> OSStatus {
        lock.withLock {
            items.removeValue(forKey: .init(service: service, account: account)) == nil
                ? errSecItemNotFound : errSecSuccess
        }
    }
}
private actor FakeSecurityState {
    var adds: [OSStatus] = []; var updates: [OSStatus] = []; var copyStatus: OSStatus = errSecItemNotFound; var copyData: Data?; var recorded: [SecurityCall] = []
}
private final class FakeSecurityAdapter: HQSecurityAdapting, @unchecked Sendable {
    let state = FakeSecurityState()
    func configure(add: [OSStatus], update: [OSStatus]) async { await state.set(add: add, update: update) }
    func setCopy(status: OSStatus, data: Data?) async { await state.setCopy(status: status, data: data) }
    func calls() async -> [SecurityCall] { await state.calls() }
    func copy(service: String, account: String) -> (OSStatus, Data?) { semaphore { [self] in await self.state.copy() } }
    func add(service: String, account: String, data: Data, accessibility: CFString, synchronizable: Bool) -> OSStatus {
        let accessibilityName = accessibility as String
        return semaphore { [self] in await self.state.nextAdd(accessibility: accessibilityName, synchronizable: synchronizable) }
    }
    func update(service: String, account: String, data: Data, accessibility: CFString, synchronizable: Bool) -> OSStatus {
        let accessibilityName = accessibility as String
        return semaphore { [self] in await self.state.nextUpdate(accessibility: accessibilityName, synchronizable: synchronizable) }
    }
    func delete(service: String, account: String) -> OSStatus { errSecSuccess }
    private func semaphore<T: Sendable>(_ operation: @escaping @Sendable () async -> T) -> T {
        let semaphore = DispatchSemaphore(value: 0); let box = SendableBox<T>()
        Task { box.value = await operation(); semaphore.signal() }; semaphore.wait(); return box.value!
    }
}
private final class SendableBox<T: Sendable>: @unchecked Sendable { var value: T? }
private extension FakeSecurityState {
    func set(add: [OSStatus], update: [OSStatus]) { adds = add; updates = update }
    func setCopy(status: OSStatus, data: Data?) { copyStatus = status; copyData = data }
    func calls() -> [SecurityCall] { recorded }
    func copy() -> (OSStatus, Data?) { (copyStatus, copyData) }
    func nextAdd(accessibility: String, synchronizable: Bool) -> OSStatus { recorded.append(.init(kind: "add", accessibility: accessibility, synchronizable: synchronizable)); return adds.removeFirst() }
    func nextUpdate(accessibility: String, synchronizable: Bool) -> OSStatus { recorded.append(.init(kind: "update", accessibility: accessibility, synchronizable: synchronizable)); return updates.removeFirst() }
}
