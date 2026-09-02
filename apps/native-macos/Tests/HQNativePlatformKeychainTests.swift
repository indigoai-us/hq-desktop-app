import Security
import XCTest
@testable import HQNative

@MainActor
final class HQNativePlatformKeychainTests: XCTestCase {
    func testReadReturnsDataAndBuildsGenericPasswordQuery() throws {
        let expectedData = Data([0x00, 0x01, 0x02])
        let driver = SecurityItemDriverSpy()
        driver.copyStatus = errSecSuccess
        driver.copyResult = expectedData as CFData
        let store = HQKeychainStore(security: driver)
        let key = HQCredentialKey(
            service: "ai.indigo.hq",
            account: "session",
            accessGroup: "TEAM.ai.indigo.shared"
        )

        let result = try store.data(for: key)

        XCTAssertEqual(result, expectedData)
        let query = try XCTUnwrap(driver.copyQueries.first)
        assertBaseQuery(query, key: key)
        XCTAssertEqual(query[kSecReturnData as String] as? Bool, true)
        XCTAssertEqual(
            query[kSecMatchLimit as String] as? String,
            kSecMatchLimitOne as String
        )
    }

    func testReadReturnsNilWhenItemDoesNotExist() throws {
        let driver = SecurityItemDriverSpy()
        driver.copyStatus = errSecItemNotFound
        let store = HQKeychainStore(security: driver)

        XCTAssertNil(try store.data(for: validKey))
    }

    func testReadRejectsUnexpectedResultType() {
        let driver = SecurityItemDriverSpy()
        driver.copyStatus = errSecSuccess
        driver.copyResult = "not-data" as CFString
        let store = HQKeychainStore(security: driver)

        XCTAssertThrowsError(try store.data(for: validKey)) { error in
            XCTAssertEqual(error as? HQKeychainError, .invalidResult)
        }
    }

    func testReadReportsUnexpectedSecurityStatus() {
        let driver = SecurityItemDriverSpy()
        driver.copyStatus = errSecAuthFailed
        let store = HQKeychainStore(security: driver)

        XCTAssertThrowsError(try store.data(for: validKey)) { error in
            XCTAssertEqual(
                error as? HQKeychainError,
                .unexpectedStatus(errSecAuthFailed)
            )
        }
    }

    func testSaveAddsDeviceOnlyGenericPassword() throws {
        let data = Data([0x03, 0x04])
        let driver = SecurityItemDriverSpy()
        driver.addStatus = errSecSuccess
        let store = HQKeychainStore(security: driver)

        try store.save(data, for: validKey)

        let attributes = try XCTUnwrap(driver.addedAttributes.first)
        assertBaseQuery(attributes, key: validKey)
        XCTAssertEqual(attributes[kSecValueData as String] as? Data, data)
        XCTAssertEqual(
            attributes[kSecAttrAccessible as String] as? String,
            kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String
        )
        XCTAssertEqual(attributes[kSecAttrSynchronizable as String] as? Bool, false)
        XCTAssertEqual(driver.updateCalls.count, 0)
    }

    func testSaveUpdatesExistingItemAfterDuplicate() throws {
        let data = Data([0x05, 0x06])
        let driver = SecurityItemDriverSpy()
        driver.addStatus = errSecDuplicateItem
        driver.updateStatus = errSecSuccess
        let store = HQKeychainStore(security: driver)

        try store.save(data, for: validKey)

        let call = try XCTUnwrap(driver.updateCalls.first)
        assertBaseQuery(call.query, key: validKey)
        XCTAssertEqual(call.attributes[kSecValueData as String] as? Data, data)
        XCTAssertEqual(
            call.attributes[kSecAttrAccessible as String] as? String,
            kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String
        )
    }

    func testSaveReportsAddFailure() {
        let driver = SecurityItemDriverSpy()
        driver.addStatus = errSecInteractionNotAllowed
        let store = HQKeychainStore(security: driver)

        XCTAssertThrowsError(try store.save(Data(), for: validKey)) { error in
            XCTAssertEqual(
                error as? HQKeychainError,
                .unexpectedStatus(errSecInteractionNotAllowed)
            )
        }
    }

    func testSaveReportsUpdateFailure() {
        let driver = SecurityItemDriverSpy()
        driver.addStatus = errSecDuplicateItem
        driver.updateStatus = errSecAuthFailed
        let store = HQKeychainStore(security: driver)

        XCTAssertThrowsError(try store.save(Data(), for: validKey)) { error in
            XCTAssertEqual(
                error as? HQKeychainError,
                .unexpectedStatus(errSecAuthFailed)
            )
        }
    }

    func testDeleteRemovesGenericPassword() throws {
        let driver = SecurityItemDriverSpy()
        driver.deleteStatus = errSecSuccess
        let store = HQKeychainStore(security: driver)

        try store.delete(validKey)

        let query = try XCTUnwrap(driver.deleteQueries.first)
        assertBaseQuery(query, key: validKey)
    }

    func testDeleteIsIdempotentWhenItemDoesNotExist() throws {
        let driver = SecurityItemDriverSpy()
        driver.deleteStatus = errSecItemNotFound
        let store = HQKeychainStore(security: driver)

        try store.delete(validKey)

        XCTAssertEqual(driver.deleteQueries.count, 1)
    }

    func testDeleteReportsUnexpectedSecurityStatus() {
        let driver = SecurityItemDriverSpy()
        driver.deleteStatus = errSecAuthFailed
        let store = HQKeychainStore(security: driver)

        XCTAssertThrowsError(try store.delete(validKey)) { error in
            XCTAssertEqual(
                error as? HQKeychainError,
                .unexpectedStatus(errSecAuthFailed)
            )
        }
    }

    func testRejectsBlankServiceBeforeCallingSecurity() {
        let driver = SecurityItemDriverSpy()
        let store = HQKeychainStore(security: driver)

        XCTAssertThrowsError(
            try store.data(for: HQCredentialKey(service: " \n", account: "account"))
        ) { error in
            XCTAssertEqual(error as? HQKeychainError, .invalidService)
        }
        XCTAssertEqual(driver.totalCallCount, 0)
    }

    func testRejectsBlankAccountBeforeCallingSecurity() {
        let driver = SecurityItemDriverSpy()
        let store = HQKeychainStore(security: driver)

        XCTAssertThrowsError(
            try store.save(
                Data(),
                for: HQCredentialKey(service: "ai.indigo.hq", account: "\t")
            )
        ) { error in
            XCTAssertEqual(error as? HQKeychainError, .invalidAccount)
        }
        XCTAssertEqual(driver.totalCallCount, 0)
    }

    func testRejectsBlankAccessGroupBeforeCallingSecurity() {
        let driver = SecurityItemDriverSpy()
        let store = HQKeychainStore(security: driver)

        XCTAssertThrowsError(
            try store.delete(
                HQCredentialKey(
                    service: "ai.indigo.hq",
                    account: "session",
                    accessGroup: " "
                )
            )
        ) { error in
            XCTAssertEqual(error as? HQKeychainError, .invalidAccessGroup)
        }
        XCTAssertEqual(driver.totalCallCount, 0)
    }

    func testLegacyCognitoCommandsRoundTripExactJSONThroughSecurityDriver()
        async throws
    {
        let secret =
            #"{"accessToken":"access","idToken":"identity","refreshToken":"refresh","expiresAt":1785123456000}"#
        let driver = SecurityItemDriverSpy()
        driver.addStatus = errSecSuccess
        driver.copyStatus = errSecSuccess
        driver.copyResult = Data(secret.utf8) as CFData
        driver.deleteStatus = errSecSuccess
        let appStore = makeAppStore(driver: driver)

        await appStore.perform(
            .nativeCommand(
                .keychainSet,
                payload: .object([
                    "service": .string("cognito"),
                    "account": .string("tokens"),
                    "secret": .string(secret),
                ])
            )
        )

        let attributes = try XCTUnwrap(driver.addedAttributes.first)
        assertBaseQuery(
            attributes,
            key: HQCredentialKey(service: "cognito", account: "tokens")
        )
        XCTAssertEqual(
            attributes[kSecValueData as String] as? Data,
            Data(secret.utf8)
        )
        XCTAssertEqual(appStore.lastNativeResult, .null)

        await appStore.perform(
            .nativeCommand(
                .keychainGet,
                payload: .object([
                    "service": .string("cognito"),
                    "account": .string("tokens"),
                ])
            )
        )

        XCTAssertEqual(appStore.lastNativeResult, .string(secret))
        XCTAssertEqual(driver.copyQueries.count, 1)

        await appStore.perform(
            .nativeCommand(
                .keychainDelete,
                payload: .object([
                    "service": .string("cognito"),
                    "account": .string("tokens"),
                ])
            )
        )

        XCTAssertEqual(appStore.lastNativeResult, .null)
        XCTAssertEqual(driver.deleteQueries.count, 1)
        assertBaseQuery(
            try XCTUnwrap(driver.deleteQueries.first),
            key: HQCredentialKey(service: "cognito", account: "tokens")
        )
    }

    func testLegacyCognitoSetAcceptsRFC3339Expiry() async {
        let secret =
            #"{"accessToken":"access","idToken":null,"refreshToken":"refresh","expiresAt":"2026-07-27T05:00:00.123Z"}"#
        let driver = SecurityItemDriverSpy()
        driver.addStatus = errSecSuccess
        let appStore = makeAppStore(driver: driver)

        await appStore.perform(
            .nativeCommand(
                .keychainSet,
                payload: .object([
                    "service": .string("cognito"),
                    "account": .string("tokens"),
                    "secret": .string(secret),
                ])
            )
        )

        XCTAssertEqual(driver.addedAttributes.count, 1)
        XCTAssertEqual(
            appStore.operationState,
            .success("Cognito tokens stored securely.")
        )
    }

    func testLegacyCognitoSetRejectsMalformedTokenShapesBeforeSecurity()
        async
    {
        let invalidSecrets = [
            #"{"idToken":"identity","refreshToken":"refresh","expiresAt":1785123456000}"#,
            #"{"accessToken":"access","idToken":1,"refreshToken":"refresh","expiresAt":1785123456000}"#,
            #"{"accessToken":"access","refreshToken":"refresh","expiresAt":1.5}"#,
            #"{"accessToken":"access","refreshToken":"refresh","expiresAt":"tomorrow"}"#,
        ]

        for secret in invalidSecrets {
            let driver = SecurityItemDriverSpy()
            let appStore = makeAppStore(driver: driver)

            await appStore.perform(
                .nativeCommand(
                    .keychainSet,
                    payload: .object([
                        "service": .string("cognito"),
                        "account": .string("tokens"),
                        "secret": .string(secret),
                    ])
                )
            )

            XCTAssertEqual(driver.totalCallCount, 0)
            XCTAssertEqual(
                appStore.operationState,
                .failure("invalid cognito token payload")
            )
        }
    }

    func testLegacyCognitoIdentifierRestrictionsPreserveCompatSemantics()
        async
    {
        let driver = SecurityItemDriverSpy()
        let appStore = makeAppStore(driver: driver)
        let unsupported = HQJSONValue.object([
            "service": .string("other"),
            "account": .string("tokens"),
        ])

        await appStore.perform(
            .nativeCommand(
                .keychainSet,
                payload: .object([
                    "service": .string("other"),
                    "account": .string("tokens"),
                    "secret": .string("{}"),
                ])
            )
        )
        XCTAssertEqual(
            appStore.operationState,
            .failure("unsupported compat keychain entry")
        )

        await appStore.perform(
            .nativeCommand(.keychainGet, payload: unsupported)
        )
        XCTAssertEqual(appStore.lastNativeResult, .null)
        XCTAssertEqual(
            appStore.operationState,
            .success("No compatible keychain value.")
        )

        await appStore.perform(
            .nativeCommand(.keychainDelete, payload: unsupported)
        )
        XCTAssertEqual(appStore.lastNativeResult, .null)
        XCTAssertEqual(
            appStore.operationState,
            .success("No compatible keychain value.")
        )
        XCTAssertEqual(driver.totalCallCount, 0)
    }

    func testLegacyCognitoGetRejectsInvalidStoredTokenResult() async {
        let driver = SecurityItemDriverSpy()
        driver.copyStatus = errSecSuccess
        driver.copyResult = Data(#"{"accessToken":"partial"}"#.utf8)
            as CFData
        let appStore = makeAppStore(driver: driver)

        await appStore.perform(
            .nativeCommand(
                .keychainGet,
                payload: .object([
                    "service": .string("cognito"),
                    "account": .string("tokens"),
                ])
            )
        )

        XCTAssertEqual(driver.copyQueries.count, 1)
        XCTAssertEqual(
            appStore.operationState,
            .failure("Stored cognito token payload is invalid.")
        )
    }

    private var validKey: HQCredentialKey {
        HQCredentialKey(service: "ai.indigo.hq", account: "session")
    }

    private func makeAppStore(
        driver: SecurityItemDriverSpy
    ) -> HQAppStore {
        HQAppStore(
            engine: KeychainCommandTestEngine(),
            launchMode: .live,
            keychainStore: HQKeychainStore(security: driver)
        )
    }

    private func assertBaseQuery(
        _ query: [String: Any],
        key: HQCredentialKey,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        XCTAssertEqual(
            query[kSecClass as String] as? String,
            kSecClassGenericPassword as String,
            file: file,
            line: line
        )
        XCTAssertEqual(
            query[kSecAttrService as String] as? String,
            key.service,
            file: file,
            line: line
        )
        XCTAssertEqual(
            query[kSecAttrAccount as String] as? String,
            key.account,
            file: file,
            line: line
        )
        XCTAssertEqual(
            query[kSecAttrAccessGroup as String] as? String,
            key.accessGroup,
            file: file,
            line: line
        )
    }
}

private actor KeychainCommandTestEngine: HQAppEngine {
    nonisolated let events = AsyncStream<HQEngineEvent> {
        $0.finish()
    }

    func start() async throws -> HQJSONValue {
        .object([:])
    }

    func request(
        _ method: String,
        params: HQJSONValue
    ) async throws -> HQJSONValue {
        .null
    }

    func stop() async {}
}

private struct SecurityUpdateCall {
    let query: [String: Any]
    let attributes: [String: Any]
}

@MainActor
private final class SecurityItemDriverSpy: HQSecurityItemDriving {
    var addStatus: OSStatus = errSecUnimplemented
    var updateStatus: OSStatus = errSecUnimplemented
    var copyStatus: OSStatus = errSecUnimplemented
    var deleteStatus: OSStatus = errSecUnimplemented
    var copyResult: CFTypeRef?
    private(set) var addedAttributes: [[String: Any]] = []
    private(set) var updateCalls: [SecurityUpdateCall] = []
    private(set) var copyQueries: [[String: Any]] = []
    private(set) var deleteQueries: [[String: Any]] = []

    var totalCallCount: Int {
        addedAttributes.count + updateCalls.count + copyQueries.count + deleteQueries.count
    }

    func add(_ attributes: [String: Any]) -> OSStatus {
        addedAttributes.append(attributes)
        return addStatus
    }

    func update(_ query: [String: Any], attributes: [String: Any]) -> OSStatus {
        updateCalls.append(SecurityUpdateCall(query: query, attributes: attributes))
        return updateStatus
    }

    func copyMatching(_ query: [String: Any], result: inout CFTypeRef?) -> OSStatus {
        copyQueries.append(query)
        result = copyResult
        return copyStatus
    }

    func delete(_ query: [String: Any]) -> OSStatus {
        deleteQueries.append(query)
        return deleteStatus
    }
}
