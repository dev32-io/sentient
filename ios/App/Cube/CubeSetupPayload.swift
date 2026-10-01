import Foundation

/// QR is a locator plus bootstrap proof, never permanent management authority.
struct CubeSetupPayload: Codable, Equatable {
    let version: Int
    let deviceId: String
    let name: String
    let transport: String
    let security: Int
    let username: String
    let pop: String

    static func locator(_ deviceId: String) -> String {
        "SC_" + deviceId.replacingOccurrences(of: "-", with: "").prefix(12)
    }

    static func validLocator(_ name: String) -> Bool {
        name.range(of: "^SC_[0-9a-f]{12}$", options: .regularExpression) != nil
    }

    static func manualSecret(_ text: String) throws -> String {
        let secret = text.filter { !$0.isWhitespace }
        guard CubeSecret.isCanonical(secret) else { throw CubeHardwareError.invalidSecret }
        return secret
    }

    static func parse(_ text: String) throws -> Self {
        guard text.utf8.count <= 512,
              let data = text.data(using: .utf8),
              let fields = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(fields.keys) == Set(["version", "deviceId", "name", "transport", "security", "username", "pop"])
        else { throw CubeHardwareError.invalidSetupCode }
        let value = try JSONDecoder().decode(Self.self, from: data)
        guard value.version == 1, value.transport == "ble", value.security == 2,
              value.username == "cube-bootstrap",
              UUID(uuidString: value.deviceId)?.uuidString.lowercased() == value.deviceId,
              value.name == "SC_" + value.deviceId.replacingOccurrences(of: "-", with: "").prefix(12),
              CubeSecret.isCanonical(value.pop)
        else { throw CubeHardwareError.invalidSetupCode }
        return value
    }
}

enum CubeHardwareError: Error, Equatable {
    case invalidSetupCode, invalidSecret, storage, unavailable, incompatible, authentication, cancelled, timeout, busy
    case payloadTooLarge, invalidWifi, wifiJoinFailed, commandRejected, secureConnection, registry(Int)
}

enum CubeSecret {
    static func encode(_ bytes: Data) -> String {
        bytes.base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }

    static func isCanonical(_ value: String) -> Bool {
        guard value.utf8.count == 43,
              let data = Data(base64Encoded: value.replacingOccurrences(of: "-", with: "+")
                .replacingOccurrences(of: "_", with: "/") + "="), data.count == 32 else { return false }
        return encode(data) == value
    }
}
