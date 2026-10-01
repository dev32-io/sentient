import CoreBluetooth
import ESPProvision
import Foundation

/// One foreground BLE transaction at a time. No agent traffic or background polling.
@MainActor
final class CubeBLESession {
    var onDisconnect: (() -> Void)?
    private var device: ESPDevice?
    private var proof: CubeBLEProof?
    private var epoch = 0
    private var pending: ((Result<Data, Error>) -> Void)?
    private var deadline: Task<Void, Never>?

    private let createDevice: (String, @escaping (ESPDevice?, ESPDeviceCSSError?) -> Void) -> Void

    init(createDevice: @escaping (String, @escaping (ESPDevice?, ESPDeviceCSSError?) -> Void) -> Void = { name, completion in
        ESPProvisionManager.shared.createESPDevice(deviceName: name, transport: .ble,
            security: .secure2, completionHandler: completion)
    }) {
        self.createDevice = createDevice
    }

    deinit {
        deadline?.cancel()
        proof?.invalidate()
        // Deinit need not run on MainActor; SDK teardown must share its BLE queue.
        let device = device
        Task { @MainActor in device?.invalidate() }
        pending?(.failure(CubeHardwareError.cancelled))
    }

    func discover() async throws -> [String] {
        cancel()
        ESPProvisionManager.shared.enableLogs(false)
        let data = try await operation { ticket in
            ESPProvisionManager.shared.searchESPDevices(devicePrefix: "SC_", transport: .ble, security: .secure2) { [weak self] devices, error in
                Task { @MainActor in
                    guard let self, self.epoch == ticket, self.pending != nil else { return }
                    guard error == nil, let devices else {
                        self.finish(ticket, .failure(CubeHardwareError.unavailable)); return
                    }
                    let names = Array(Set(devices.map(\.name).filter(CubeSetupPayload.validLocator))).sorted()
                    self.finish(ticket, .success((try? JSONEncoder().encode(names)) ?? Data()))
                }
            }
        }
        ESPProvisionManager.shared.stopESPDevicesSearch()
        return try JSONDecoder().decode([String].self, from: data)
    }

    func connect(name: String, secret: String, bootstrap: Bool) async throws {
        guard CubeSecret.isCanonical(secret) else { throw CubeHardwareError.invalidSecret }
        guard pending == nil else { throw CubeHardwareError.busy }
        cancel()
        ESPProvisionManager.shared.enableLogs(false)
        let proof = CubeBLEProof(secret: secret, username: bootstrap ? "cube-bootstrap" : "cube-manager")
        self.proof = proof
        _ = try await operation { ticket in
            // Do not give upstream a proof before checking its unauthenticated version metadata.
            self.createDevice(name) { [weak self] found, error in
                Task { @MainActor in
                    guard let self, self.epoch == ticket, self.pending != nil else { return }
                    guard error == nil, let found, found.name == name else {
                        self.finish(ticket, .failure(CubeHardwareError.unavailable)); return
                    }
                    self.device = found
                    // Upstream reports post-handshake disconnects through bleDelegate, not connect's callback.
                    found.bleDelegate = CubeBLEEvents { [weak self, weak found] in
                        Task { @MainActor in
                            guard let found else { return }
                            self?.connectionEnded(found)
                        }
                    }
                    found.connect(delegate: proof) { [weak self, weak found] state in
                        Task { @MainActor in
                            guard let self, let found, self.device === found else { return }
                            if case .disconnected = state {
                                self.connectionEnded(found)
                                return
                            }
                            guard self.epoch == ticket, self.pending != nil else { return }
                            switch state {
                            case .connected:
                                guard CubeBLEProof.accepts(found.versionInfo), let security = found.securityLayer else {
                                    self.finish(ticket, .failure(CubeHardwareError.incompatible)); return
                                }
                                found.securityLayer = CubeBLEFrames(security)
                                self.finish(ticket, .success(Data()))
                            case .failedToConnect(let error):
#if DEBUG
                                // Numeric SDK category only; underlying errors can contain untrusted data.
                                if ProcessInfo.processInfo.arguments.contains("--qa-cube-setup") {
                                    print("CUBE_BLE connect-failed code=\(error.code)")
                                }
#endif
                                let failure: CubeHardwareError
                                switch error {
                                case .securityMismatch, .noPOP, .noUsername:
                                    failure = .incompatible
                                case .sessionInitError, .encryptionError:
                                    // SDK session-init errors conflate transport and SRP failures.
                                    // Neither proves that the saved manager credential is wrong.
                                    failure = .secureConnection
                                default:
                                    failure = .unavailable
                                }
                                self.finish(ticket, .failure(failure))
                            case .disconnected:
                                self.finish(ticket, .failure(CubeHardwareError.unavailable))
                            }
                        }
                    }
                }
            }
        }
    }

    /// Protected version-1 command endpoint; firmware validates each command's schema.
    func command(_ data: Data) async throws -> Data {
        guard !data.isEmpty, data.count <= 496 else { throw CubeHardwareError.incompatible }
        guard let device, device.isSessionEstablished() else { throw CubeHardwareError.unavailable }
        return try await operation { ticket in
            device.sendData(path: "cube-control", data: data) { [weak self] response, error in
                Task { @MainActor in
                    guard let self else { return }
                    guard error == nil, let response, response.count <= 2048 else {
                        self.finish(ticket, .failure(CubeHardwareError.unavailable)); return
                    }
                    self.finish(ticket, .success(response))
                }
            }
        }
    }

    /// Called on back/background/logout. Stale library callbacks cannot resume a new operation.
    func cancel() {
        epoch &+= 1
        deadline?.cancel()
        deadline = nil
        let callback = pending
        pending = nil
        proof?.invalidate()
        ESPProvisionManager.shared.stopESPDevicesSearch()
        device?.invalidate()
        device = nil
        proof = nil
        callback?(.failure(CubeHardwareError.cancelled))
    }

    private func connectionEnded(_ found: ESPDevice) {
        guard device === found else { return }
        finish(epoch, .failure(CubeHardwareError.unavailable))
        cancel()
        onDisconnect?()
    }

    private func operation(_ start: (Int) -> Void) async throws -> Data {
        guard pending == nil else { throw CubeHardwareError.busy }
        try Task.checkCancellation()
        epoch &+= 1
        let ticket = epoch
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                pending = { continuation.resume(with: $0) }
                deadline = Task { [weak self] in
                    do { try await Task.sleep(for: .seconds(20)) } catch { return }
                    self?.finish(ticket, .failure(CubeHardwareError.timeout))
                }
                start(ticket)
            }
        } onCancel: {
            Task { @MainActor [weak self] in
                guard let self, self.epoch == ticket else { return }
                self.cancel()
            }
        }
    }

    private func finish(_ ticket: Int, _ result: Result<Data, Error>) {
        guard epoch == ticket, let callback = pending else { return }
        pending = nil
        deadline?.cancel()
        deadline = nil
        if case .failure = result { cancel() }
        callback(result)
    }
}

private final class CubeBLEEvents: ESPBLEDelegate {
    let ended: () -> Void
    init(ended: @escaping () -> Void) { self.ended = ended }
    func peripheralConnected() {} // Transport connection alone is not authenticated.
    func peripheralDisconnected(peripheral: CBPeripheral, error: Error?) { ended() }
    func peripheralFailedToConnect(peripheral: CBPeripheral?, error: Error?) { ended() }
}

/// Upstream negotiates from untrusted metadata. Release proof only for Security2 patch 1;
/// also validate after handshake before sending any enrollment or network material.
final class CubeBLEProof: ESPDeviceConnectionDelegate {
    private let lock = NSLock()
    private var secret: String?
    private let username: String
    init(secret: String, username: String) { self.secret = secret; self.username = username }
    func invalidate() { lock.withLock { secret = nil } }

    static func accepts(_ info: NSDictionary?) -> Bool {
        guard let prov = info?["prov"] as? [String: Any],
              let version = prov["sec_ver"] as? Int, version == 2,
              let patch = prov["sec_patch_ver"] as? Int, patch == 1 else { return false }
        return true
    }

    func getProofOfPossesion(forDevice: ESPDevice, completionHandler: @escaping (String) -> Void) {
        let value = lock.withLock { Self.accepts(forDevice.versionInfo) ? (secret ?? "") : "" }
        completionHandler(value)
    }
    func getUsername(forDevice: ESPDevice, completionHandler: @escaping (String?) -> Void) {
        let value = lock.withLock { Self.accepts(forDevice.versionInfo) && secret != nil ? username : nil }
        completionHandler(value)
    }
}

/// Bound messages before upstream AES-GCM slices the 16-byte authentication tag.
/// Cryptography and nonce counters remain entirely in ESPProvision/CryptoKit.
final class CubeBLEFrames: ESPCodeable {
    let security: ESPCodeable
    init(_ security: ESPCodeable) { self.security = security }
    func getNextRequestInSession(data: Data?) throws -> Data? { throw CubeHardwareError.authentication }
    func encrypt(data: Data) -> Data? {
        guard data.count <= 496 else { return nil }
        return security.encrypt(data: data)
    }
    func decrypt(data: Data) -> Data? {
        guard (16...2064).contains(data.count) else { return nil }
        return security.decrypt(data: data)
    }
}
