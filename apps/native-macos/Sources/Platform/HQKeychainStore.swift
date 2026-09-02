import Foundation
import Security

struct HQCredentialKey: Equatable, Hashable, Sendable {
    let service: String
    let account: String
    let accessGroup: String?

    init(service: String, account: String, accessGroup: String? = nil) {
        self.service = service
        self.account = account
        self.accessGroup = accessGroup
    }
}

enum HQKeychainError: Error, Equatable {
    case invalidService
    case invalidAccount
    case invalidAccessGroup
    case invalidResult
    case unexpectedStatus(OSStatus)
}

@MainActor
protocol HQSecurityItemDriving {
    func add(_ attributes: [String: Any]) -> OSStatus
    func update(_ query: [String: Any], attributes: [String: Any]) -> OSStatus
    func copyMatching(_ query: [String: Any], result: inout CFTypeRef?) -> OSStatus
    func delete(_ query: [String: Any]) -> OSStatus
}

@MainActor
final class HQSystemSecurityItemDriver: HQSecurityItemDriving {
    func add(_ attributes: [String: Any]) -> OSStatus {
        SecItemAdd(attributes as CFDictionary, nil)
    }

    func update(_ query: [String: Any], attributes: [String: Any]) -> OSStatus {
        SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
    }

    func copyMatching(_ query: [String: Any], result: inout CFTypeRef?) -> OSStatus {
        SecItemCopyMatching(query as CFDictionary, &result)
    }

    func delete(_ query: [String: Any]) -> OSStatus {
        SecItemDelete(query as CFDictionary)
    }
}

@MainActor
final class HQKeychainStore {
    private let security: any HQSecurityItemDriving

    init(security: any HQSecurityItemDriving = HQSystemSecurityItemDriver()) {
        self.security = security
    }

    func data(for key: HQCredentialKey) throws -> Data? {
        var query = try baseQuery(for: key)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var result: CFTypeRef?
        let status = security.copyMatching(query, result: &result)

        switch status {
        case errSecSuccess:
            guard let data = result as? Data else {
                throw HQKeychainError.invalidResult
            }
            return data
        case errSecItemNotFound:
            return nil
        default:
            throw HQKeychainError.unexpectedStatus(status)
        }
    }

    func save(_ data: Data, for key: HQCredentialKey) throws {
        let query = try baseQuery(for: key)
        var attributes = query
        attributes[kSecValueData as String] = data
        attributes[kSecAttrAccessible as String] =
            kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        attributes[kSecAttrSynchronizable as String] = false

        let addStatus = security.add(attributes)
        switch addStatus {
        case errSecSuccess:
            return
        case errSecDuplicateItem:
            let updates: [String: Any] = [
                kSecValueData as String: data,
                kSecAttrAccessible as String:
                    kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
            ]
            let updateStatus = security.update(query, attributes: updates)
            guard updateStatus == errSecSuccess else {
                throw HQKeychainError.unexpectedStatus(updateStatus)
            }
        default:
            throw HQKeychainError.unexpectedStatus(addStatus)
        }
    }

    func delete(_ key: HQCredentialKey) throws {
        let status = security.delete(try baseQuery(for: key))
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw HQKeychainError.unexpectedStatus(status)
        }
    }

    private func baseQuery(for key: HQCredentialKey) throws -> [String: Any] {
        guard !key.service.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw HQKeychainError.invalidService
        }
        guard !key.account.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw HQKeychainError.invalidAccount
        }
        if let accessGroup = key.accessGroup,
           accessGroup.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        {
            throw HQKeychainError.invalidAccessGroup
        }

        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: key.service,
            kSecAttrAccount as String: key.account,
        ]
        if let accessGroup = key.accessGroup {
            query[kSecAttrAccessGroup as String] = accessGroup
        }
        return query
    }
}
