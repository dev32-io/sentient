import Foundation

struct CubeSetupAttempt: Codable, Equatable, Identifiable {
    let deviceId: String
    let attemptId: String
    let enrollmentSecret: String
    var bootstrap: CubeSetupPayload?
    var generation: Int?
    var id: String { deviceId }
}

struct CubeStatus: Decodable, Equatable {
    let deviceId: String
    let attemptId: String
    let generation: Int
    let phase: String
    let wifiConnected: Bool
    let wifiState: String
    let ssid: String
    let gatewayConnected: Bool
    let accountAttention: Bool
    let lastError: String
    let firmware: String
    let batteryPercent: Int?
    let charging: Bool
    var ready: Bool { phase == "active" && gatewayConnected && !accountAttention }
}

enum CubeControl {
    static func encode(_ operation: String, fields: [String: Any] = [:]) throws -> Data {
        var body = fields
        body["version"] = 1
        body["op"] = operation
        let data = try JSONSerialization.data(withJSONObject: body, options: [.sortedKeys, .withoutEscapingSlashes])
        guard data.count <= 496 else { throw CubeHardwareError.payloadTooLarge }
        return data
    }

    static func enrollment(_ attempt: CubeSetupAttempt, manager: String, gateway: CubeGateway,
                           install: Bool, generation: Int) throws -> Data {
        var fields: [String: Any] = ["deviceId": attempt.deviceId, "attemptId": attempt.attemptId,
            "generation": generation, "enrollmentSecret": attempt.enrollmentSecret,
            "gatewayOrigin": gateway.origin.absoluteString, "gatewayWsPath": gateway.wsPath]
        if install { fields["managerSecret"] = manager }
        return try encode(install ? "install" : "enroll", fields: fields)
    }

    static func wifi(ssid: String, password: String) throws -> Data {
        let count = password.utf8.count
        guard (1...32).contains(ssid.utf8.count), !ssid.contains("\0"), !password.contains("\0"),
              count == 0 || (8...63).contains(count) ||
                (count == 64 && password.utf8.allSatisfy { (48...57).contains($0) || (65...70).contains($0) || (97...102).contains($0) })
        else { throw CubeHardwareError.invalidWifi }
        return try encode("wifi.set", fields: ["ssid": ssid, "password": password])
    }

    static func checked(_ data: Data) throws -> [String: Any] {
        guard data.count <= 2048, let body = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              body["version"] as? Int == 1, let ok = body["ok"] as? Bool else {
            throw CubeHardwareError.incompatible
        }
        guard ok else { throw CubeHardwareError.commandRejected }
        return body
    }

    static func status(_ data: Data, deviceId: String) throws -> CubeStatus {
        _ = try checked(data)
        let status = try JSONDecoder().decode(CubeStatus.self, from: data)
        guard status.deviceId == deviceId, ["bootstrap", "pending", "committed", "active"].contains(status.phase),
              ["offline", "joining", "connected", "failed"].contains(status.wifiState) else {
            throw CubeHardwareError.incompatible
        }
        return status
    }
}

extension CubeHardwareError: LocalizedError {
    var errorDescription: String? {
        switch self {
        case .payloadTooLarge: "This gateway address makes setup exceed Cube’s secure message limit. Use a shorter configured gateway address."
        case .invalidWifi: "Use a network name of 1–32 UTF-8 bytes and an empty, 8–63-byte, or 64-hex-digit password."
        case .wifiJoinFailed: "Cube couldn’t join Wi-Fi. Check the password, signal, and 2.4 GHz support. Cube is still paired."
        case .storage: "Couldn’t save or remove phone access securely. Unlock iPhone and try again."
        case .invalidSetupCode, .invalidSecret: "This Cube setup credential is not valid."
        case .authentication: "Couldn’t authenticate. Restore phone access or check your account."
        case .secureConnection: "Couldn’t establish a secure Bluetooth connection. Keep Cube nearby and try again."
        case .incompatible: "Cube or gateway returned an unsupported response."
        case .cancelled: "Setup paused. Your saved attempt is safe to resume."
        case .timeout: "Cube did not finish in time. Keep it nearby and refresh status."
        case .busy: "Another Cube operation is running."
        case .unavailable: "Cube is unavailable. Check power, Bluetooth permission, and proximity."
        case .commandRejected: "Cube rejected this change. Refresh status before retrying."
        case .registry(let code):
            switch code {
            case 401, 403: "Account access denied. Sign in again with the owning account."
            case 409: "Enrollment conflicts with retained ownership or another attempt. Resume the saved attempt."
            case 410: "Enrollment expired. Disable agent access before explicitly starting a new attempt."
            case 429: "Gateway is busy. Wait before trying again."
            default: "Gateway request failed. Check your connection, then retry the same attempt."
            }
        }
    }
}
