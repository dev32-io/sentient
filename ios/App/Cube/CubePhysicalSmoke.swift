#if DEBUG
import CoreBluetooth
import ESPProvision
import SwiftUI

/// Opt-in physical probe. Never mounts account state, diagnostics upload, or chat.
/// Credentials arrive through the debug launch environment, never arguments/logs.
@MainActor
struct CubePhysicalSmoke: View {
    @State private var result = "Starting physical BLE check"
    @State private var session = CubeBLESession()
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        VStack(spacing: 20) {
            Text("Cube physical check").font(.title)
            Text(result).accessibilityIdentifier("cube-physical-result")
        }
        .padding()
        .task { await run() }
        .onDisappear { session.cancel() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .background { session.cancel() }
        }
    }

    private func record(_ value: String) {
        result = value
        // Only fixed stage names, booleans, counts and timings. Never error descriptions.
        print("CUBE_PHYSICAL \(value)")
    }

    private func run() async {
        ESPProvisionManager.shared.enableLogs(false)
        record("scan-start authorization=\(CBManager.authorization.rawValue)")
        let count: Int = await withCheckedContinuation { continuation in
            ESPProvisionManager.shared.searchESPDevices(devicePrefix: "SC_", transport: .ble, security: .secure2) { devices, _ in
                continuation.resume(returning: devices?.count ?? 0)
            }
        }
        record("scan-complete matches=\(count) authorization=\(CBManager.authorization.rawValue)")
        guard let text = ProcessInfo.processInfo.environment["CUBE_SMOKE_QR"] else { return }
        do {
            let payload = try CubeSetupPayload.parse(text)
            let start = Date()
            record("bootstrap-connect-start")
            try await session.connect(name: payload.name, secret: payload.pop, bootstrap: true)
            record("bootstrap-authenticated milliseconds=\(Int(Date().timeIntervalSince(start) * 1000))")
            let status = try CubeControl.status(await session.command(CubeControl.encode("status")), deviceId: payload.deviceId)
            record("protected-status phase=\(status.phase) wifi=\(status.wifiConnected) gateway=\(status.gatewayConnected)")
            session.cancel()
            record("wrong-proof-start")
            do {
                try await session.connect(name: payload.name, secret: CubeManagerStore.newSecret(), bootstrap: true)
                record("FAIL wrong-proof-accepted")
            } catch CubeHardwareError.authentication {
                record("wrong-proof-rejected")
            }
            session.cancel()
            try await session.connect(name: payload.name, secret: payload.pop, bootstrap: true)
            _ = try CubeControl.status(await session.command(CubeControl.encode("status")), deviceId: payload.deviceId)
            record("bootstrap-reconnect-protected-status-pass")
            session.cancel()
        } catch {
            session.cancel()
            let code: String
            switch error {
            case CubeHardwareError.timeout: code = "timeout"
            case CubeHardwareError.authentication: code = "authentication"
            case CubeHardwareError.unavailable: code = "unavailable"
            case CubeHardwareError.cancelled: code = "cancelled"
            case CubeHardwareError.incompatible: code = "incompatible"
            default: code = "validation-or-command"
            }
            record("FAIL stage-error=\(code)")
        }
    }
}
#endif
