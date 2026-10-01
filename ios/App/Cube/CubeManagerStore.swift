import Foundation
import Security

/// Account-scoped, device-only authority. No iCloud synchronization or memory fallback.
struct CubeManagerStore {
    private let service = "io.dev32.sentient.cube.manager.v1"
    private let scopes: [String]
    private let keychain: Keychain

    /// Narrow Security boundary; tests inject synthetic items, never user Keychain state.
    struct Keychain {
        var copy: ([CFString: Any]) -> (OSStatus, CFTypeRef?) = { query in
            var result: CFTypeRef?
            let status = SecItemCopyMatching(query as CFDictionary, &result)
            return (status, result)
        }
        var update: ([CFString: Any], Data) -> OSStatus = { query, data in
            SecItemUpdate(query as CFDictionary, [kSecValueData: data] as CFDictionary)
        }
        var add: ([CFString: Any]) -> OSStatus = { SecItemAdd($0 as CFDictionary, nil) }
        var delete: ([CFString: Any]) -> OSStatus = { SecItemDelete($0 as CFDictionary) }
    }

    init(gatewayOrigin: URL, accountId: String, keychain: Keychain = Keychain()) throws {
        guard gatewayOrigin.scheme == "https", gatewayOrigin.host != nil,
              gatewayOrigin.user == nil, gatewayOrigin.password == nil,
              gatewayOrigin.query == nil, gatewayOrigin.fragment == nil,
              gatewayOrigin.path.isEmpty || gatewayOrigin.path == "/", !accountId.isEmpty
        else { throw CubeHardwareError.storage }
        var origins = [gatewayOrigin.absoluteString]
        if gatewayOrigin.port == nil || gatewayOrigin.port == 443 {
            guard var parts = URLComponents(url: gatewayOrigin, resolvingAgainstBaseURL: true) else {
                throw CubeHardwareError.storage
            }
            // Only port changes. Host spelling and trailing slash remain separate namespaces.
            parts.port = nil
            guard let omitted = parts.string else { throw CubeHardwareError.storage }
            parts.port = 443
            guard let explicit = parts.string else { throw CubeHardwareError.storage }
            origins = [omitted, explicit]
        }
        scopes = try origins.map {
            String(decoding: try JSONEncoder().encode([$0, accountId]), as: UTF8.self)
        }
        self.keychain = keychain
    }

    static func newSecret() throws -> String {
        var bytes = Data(count: 32)
        let status = bytes.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 32, $0.baseAddress!) }
        guard status == errSecSuccess else { throw CubeHardwareError.storage }
        return CubeSecret.encode(bytes)
    }

    func save(_ secret: String, deviceId: String) throws {
        guard CubeSecret.isCanonical(secret), UUID(uuidString: deviceId) != nil else {
            throw CubeHardwareError.invalidSecret
        }
        let items = try scopes.map { try query(scope: $0, deviceId: deviceId) }
        let existing = try items.map { try read($0).map(decodeSecret) }
        _ = try consistent(existing)
        try write(Data(secret.utf8), items: items, exists: existing.map { $0 != nil })
        guard try load(deviceId: deviceId) == secret else { throw CubeHardwareError.storage }
    }

    func load(deviceId: String) throws -> String? {
        try consistent(scopes.map { try read(query(scope: $0, deviceId: deviceId)).map(decodeSecret) })
    }

    /// Enumerate local authority without fetching secret values, including while gateway is offline.
    func deviceIds() throws -> [String] {
        var ids = Set<String>()
        for scope in scopes {
            for item in try enumerate(scope: scope, data: false) {
                guard let account = item[kSecAttrAccount] as? String,
                      let parts = try? JSONDecoder().decode([String].self, from: Data(account.utf8)),
                      parts.count == 2, parts[0] == scope, UUID(uuidString: parts[1]) != nil else { continue }
                ids.insert(parts[1])
            }
        }
        return ids.sorted()
    }

    func saveAttempt(_ attempt: CubeSetupAttempt) throws {
        let items = try scopes.map { try query(scope: $0, deviceId: attempt.deviceId, attempt: true) }
        let data = try JSONEncoder().encode(attempt)
        let existing = try items.map { item -> CubeSetupAttempt? in
            _ = try decodeAttempt(data, account: item[kSecAttrAccount] as? String, scope: item[kSecAttrLabel] as! String)
            return try read(item).map {
                try decodeAttempt($0, account: item[kSecAttrAccount] as? String, scope: item[kSecAttrLabel] as! String)
            }
        }
        _ = try consistent(existing)
        try write(data, items: items, exists: existing.map { $0 != nil })
        guard try attempts().contains(attempt) else { throw CubeHardwareError.storage }
    }

    func attempts() throws -> [CubeSetupAttempt] {
        var merged: [String: CubeSetupAttempt] = [:]
        for scope in scopes {
            for item in try enumerate(scope: scope, data: true) {
                guard let account = item[kSecAttrAccount] as? String else { throw CubeHardwareError.storage }
                guard account.hasSuffix(":attempt") else { continue }
                guard let data = item[kSecValueData] as? Data else { throw CubeHardwareError.storage }
                let attempt = try decodeAttempt(data, account: account, scope: scope)
                // decodeAttempt validated UUID identity; retain exact payload equality for conflicts.
                let deviceId = UUID(uuidString: attempt.deviceId)!.uuidString.lowercased()
                merged[deviceId] = try consistent([merged[deviceId], attempt])
            }
        }
        return merged.values.sorted { $0.deviceId < $1.deviceId }
    }

    func removeAttempt(deviceId: String) throws {
        try delete(scopes.map { try query(scope: $0, deviceId: deviceId, attempt: true) })
    }

    /// Caller must stop BLE first and surface failure before completing logout.
    func removeAccount() throws {
        try delete(scopes.map(namespace))
    }

    private func consistent<T: Equatable>(_ values: [T?]) throws -> T? {
        let present = values.compactMap { $0 }
        guard present.allSatisfy({ $0 == present.first }) else { throw CubeHardwareError.storage }
        return present.first
    }

    private func decodeSecret(_ data: Data) throws -> String {
        guard let secret = String(data: data, encoding: .utf8), CubeSecret.isCanonical(secret) else {
            throw CubeHardwareError.storage
        }
        return secret
    }

    private func decodeAttempt(_ data: Data, account: String?, scope: String) throws -> CubeSetupAttempt {
        guard let attempt = try? JSONDecoder().decode(CubeSetupAttempt.self, from: data),
              let deviceId = UUID(uuidString: attempt.deviceId), UUID(uuidString: attempt.attemptId) != nil,
              CubeSecret.isCanonical(attempt.enrollmentSecret),
              let account, account.hasSuffix(":attempt"),
              let parts = try? JSONDecoder().decode([String].self, from: Data(account.dropLast(8).utf8)),
              parts == [scope, deviceId.uuidString.lowercased()] else { throw CubeHardwareError.storage }
        return attempt
    }

    private func read(_ item: [CFString: Any]) throws -> Data? {
        var request = item
        request[kSecReturnData] = true
        request[kSecMatchLimit] = kSecMatchLimitOne
        let (status, result) = keychain.copy(request)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw CubeHardwareError.storage }
        return data
    }

    private func enumerate(scope: String, data: Bool) throws -> [[CFString: Any]] {
        var request = namespace(scope)
        request[kSecReturnAttributes] = true
        if data { request[kSecReturnData] = true }
        request[kSecMatchLimit] = kSecMatchLimitAll
        let (status, result) = keychain.copy(request)
        if status == errSecItemNotFound { return [] }
        guard status == errSecSuccess, let items = result as? [[CFString: Any]] else { throw CubeHardwareError.storage }
        return items
    }

    private func write(_ data: Data, items: [[CFString: Any]], exists: [Bool]) throws {
        // No migration or delete-before-write. Partial duplicate updates throw; later reads fail closed.
        if exists.contains(true) {
            for (item, present) in zip(items, exists) where present {
                guard keychain.update(item, data) == errSecSuccess else { throw CubeHardwareError.storage }
            }
        } else {
            var item = items[0]
            item[kSecValueData] = data
            item[kSecAttrAccessible] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
            guard keychain.add(item) == errSecSuccess else { throw CubeHardwareError.storage }
        }
    }

    private func delete(_ items: [[CFString: Any]]) throws {
        var failed = false
        for item in items {
            let status = keychain.delete(item)
            if status != errSecSuccess && status != errSecItemNotFound { failed = true }
        }
        if failed { throw CubeHardwareError.storage }
    }

    private func namespace(_ scope: String) -> [CFString: Any] {
        [kSecClass: kSecClassGenericPassword, kSecAttrService: service,
         kSecAttrLabel: scope, kSecAttrSynchronizable: false]
    }

    private func query(scope: String, deviceId: String, attempt: Bool = false) throws -> [CFString: Any] {
        guard let id = UUID(uuidString: deviceId) else { throw CubeHardwareError.storage }
        let account = String(decoding: try JSONEncoder().encode([scope, id.uuidString.lowercased()]), as: UTF8.self)
        var item = namespace(scope)
        item[kSecAttrAccount] = account + (attempt ? ":attempt" : "")
        return item
    }
}
