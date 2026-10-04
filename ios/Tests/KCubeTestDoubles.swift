// Shared in-memory Cube doubles; no hardware, network or Keychain access.
import Foundation
#if !K_NATIVE_FIXTURE
@testable import SentientApp
#endif

final class MemoryCubeStore: CubeStoring {
    var secrets: [String: String] = [:]
    var saved: [CubeSetupAttempt] = []
    var beforeRemove: (() -> Void)?
    func load(deviceId: String) throws -> String? { secrets[deviceId] }
    func save(_ secret: String, deviceId: String) throws { secrets[deviceId] = secret }
    func attempts() throws -> [CubeSetupAttempt] { saved }
    func deviceIds() throws -> [String] { secrets.keys.sorted() }
    func saveAttempt(_ attempt: CubeSetupAttempt) throws {
        saved.removeAll { $0.deviceId == attempt.deviceId }; saved.append(attempt)
    }
    func removeAttempt(deviceId: String) throws { saved.removeAll { $0.deviceId == deviceId } }
    func removeAccount() throws { beforeRemove?(); saved = []; secrets = [:] }
}

@MainActor final class FakeCubeRegistry: CubeRegistryServing {
    let gateway: CubeGateway
    var operations: [String] = []
    var attempt: CubeSetupAttempt?
    var recordStatus = "pending"
    var manager: String?
    var hold = false
    var holdList = false
    var pendingList: CheckedContinuation<Void, Never>?
    var offline = false
    var listed: [CubeRegistryRecord] = []
    var listCalls = 0
    var pending: CheckedContinuation<Void, Never>?
    init(wsURL: String = "wss://cube.test/api/v1/ws") { gateway = try! CubeGateway(wsURL: wsURL) }
    func list() async throws -> [CubeRegistryRecord] {
        listCalls += 1
        if holdList { await withCheckedContinuation { pendingList = $0 } }
        if offline { throw CubeHardwareError.unavailable }
        return listed
    }
    func mutate(_ operation: String, deviceId: String, attempt: CubeSetupAttempt?, managerSecret: String?) async throws -> CubeRegistryRecord {
        operations.append(operation)
        self.attempt = attempt
        if hold { await withCheckedContinuation { pending = $0 } }
        return CubeRegistryRecord(version: 1, deviceId: deviceId,
            attemptId: attempt?.attemptId ?? "22345678-1234-4234-8234-123456789abc", generation: 1,
            deviceClass: "cube", status: recordStatus, expiresAt: 1_900_000_000_000, managerSecret: manager)
    }
    func release() { pending?.resume(); pending = nil }
    func releaseList() { holdList = false; pendingList?.resume(); pendingList = nil }
}

@MainActor final class FakeCubeBLE: CubeBLETransport {
    var onDisconnect: (() -> Void)?
    let deviceId: String
    var statusDeviceId: String?
    var installed = false
    var active = false
    var batteryPercent: Int? = 50
    var accountAttention = false
    var discoveryError: CubeHardwareError?
    var wifiSSID = ""
    var loseInstallReply = false
    var rejectProof = false
    var expectedBootstrap: String?
    var connections: [Bool] = []
    var connectionNames: [String] = []
    var commands: [String] = []
    var holdNextStatus = false
    var pendingStatus: CheckedContinuation<Void, Never>?
    var cancelCount = 0
    var attemptId = ""
    var generation = 0
    init(deviceId: String) { self.deviceId = deviceId }
    var discoveryCalls = 0
    func discover() async throws -> [String] {
        discoveryCalls += 1
        if let discoveryError { throw discoveryError }
        return [CubeSetupPayload.locator(deviceId)]
    }
    func connect(name: String, secret: String, bootstrap: Bool) async throws {
        connections.append(bootstrap)
        connectionNames.append(name)
        if bootstrap, let expectedBootstrap, secret != expectedBootstrap { throw CubeHardwareError.authentication }
        if rejectProof || bootstrap == installed { throw CubeHardwareError.authentication }
    }
    func command(_ data: Data) async throws -> Data {
        let fields = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        let operation = fields["op"] as? String ?? ""
        commands.append(operation)
        switch operation {
        case "status":
            let result = try snapshot()
            if holdNextStatus {
                holdNextStatus = false
                await withCheckedContinuation { pendingStatus = $0 }
            }
            return result
        case "wifi.set": wifiSSID = fields["ssid"] as! String
        case "install", "enroll":
            installed = true
            attemptId = fields["attemptId"] as! String
            generation = fields["generation"] as! Int
            if loseInstallReply { loseInstallReply = false; throw CubeHardwareError.unavailable }
        default: break
        }
        return Data("{\"version\":1,\"ok\":true}".utf8)
    }
    func snapshot() throws -> Data {
        var fields: [String: Any] = ["version": 1, "ok": true, "deviceId": statusDeviceId ?? deviceId,
            "attemptId": attemptId, "generation": generation, "phase": active ? "active" : installed ? "pending" : "bootstrap",
            "wifiConnected": active || !wifiSSID.isEmpty, "wifiState": active || !wifiSSID.isEmpty ? "connected" : "offline", "ssid": wifiSSID,
            "gatewayConnected": active, "accountAttention": accountAttention, "lastError": "", "firmware": "test",
            "charging": false]
        if let batteryPercent { fields["batteryPercent"] = batteryPercent }
        return try JSONSerialization.data(withJSONObject: fields)
    }
    func releaseStatus() { pendingStatus?.resume(); pendingStatus = nil }
    func cancel() { cancelCount += 1 }
}
