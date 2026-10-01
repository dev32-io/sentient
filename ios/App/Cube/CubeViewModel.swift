import Foundation
import Observation

@MainActor protocol CubeBLETransport: AnyObject {
    var onDisconnect: (() -> Void)? { get set }
    func discover() async throws -> [String]
    func connect(name: String, secret: String, bootstrap: Bool) async throws
    func command(_ data: Data) async throws -> Data
    func cancel()
}
extension CubeBLESession: CubeBLETransport {}

@MainActor protocol CubeRegistryServing {
    var gateway: CubeGateway { get }
    func list() async throws -> [CubeRegistryRecord]
    func mutate(_ operation: String, deviceId: String, attempt: CubeSetupAttempt?, managerSecret: String?) async throws -> CubeRegistryRecord
}
extension CubeRegistry: CubeRegistryServing {}

protocol CubeStoring {
    func load(deviceId: String) throws -> String?
    func save(_ secret: String, deviceId: String) throws
    func attempts() throws -> [CubeSetupAttempt]
    func deviceIds() throws -> [String]
    func saveAttempt(_ attempt: CubeSetupAttempt) throws
    func removeAttempt(deviceId: String) throws
    func removeAccount() throws
}
extension CubeManagerStore: CubeStoring {}

/// Account-scoped hardware owner. Every async publication and durable write is cancellation-fenced.
@MainActor @Observable
final class CubeViewModel {
    enum RegistryState: Equatable {
        case idle, loading, loaded, failed(String)
    }
    private(set) var registryState: RegistryState = .idle
    private var registryWork: Task<Void, Never>?
    private var registryEpoch = 0
    private var hasLoadedRegistry = false

    private(set) var pairingLocators: [String] = []
    private(set) var records: [CubeRegistryRecord] = []
    private(set) var attempts: [CubeSetupAttempt] = []
    private(set) var localDeviceIds: [String] = []
    private(set) var selected: String?
    private(set) var status: CubeStatus?
    private(set) var nearby = false
    private(set) var connecting = false
    private(set) var needsPhoneAccess = false
    private var attemptedHubEntry = false
    private(set) var checkedAt: Date?
    private(set) var busy = false
    // Presentation before enrollment has saved its durable attempt; never transport authority.
    private(set) var preparingSetup = false
    private(set) var message: String?
    private(set) var progress = ""
    private let registry: any CubeRegistryServing
    private let store: any CubeStoring
    private let ble: any CubeBLETransport
    private var work: Task<Void, Never>?
    private var epoch = 0

    init(registry: any CubeRegistryServing, store: any CubeStoring, ble: any CubeBLETransport) {
        self.registry = registry; self.store = store; self.ble = ble
        ble.onDisconnect = { [weak self] in self?.nearby = false }
    }

    var hardwareAvailable: Bool { nearby && status?.deviceId == selected && selected != nil }

    /// One foreground attempt per selection, not per SwiftUI appearance or child-pop.
    func enterHub() {
        guard selected != nil, !attemptedHubEntry else { return }
        attemptedHubEntry = true
        guard !busy, !hardwareAvailable else { return }
        connectNearby()
    }

    var selectedRecord: CubeRegistryRecord? { records.first { $0.deviceId == selected } }
    var selectedAttempt: CubeSetupAttempt? { attempts.first { $0.deviceId == selected } }
    var needsSetup: Bool {
        preparingSetup || selectedAttempt != nil ||
            (["pending", "committed"].contains(selectedRecord?.status ?? "") && status?.ready != true)
    }

    /// Header pop and interactive pop both arrive through the stack's path change.
    /// Child-to-child navigation retains active hardware work; exiting its flow cancels it.
    func navigationChanged(from old: CubePage?, to new: CubePage?) {
        guard old != nil else { return }
        // Finished feedback belongs to the leaf where it completed. Live work and errors survive.
        if old != new, !busy { progress = "" }
        if new == nil || new == .devices || new == .setup {
            select(nil)
        } else if old == .manual && new != .hub {
            pause()
        }
    }

    func select(_ deviceId: String?) {
        pause()
        selected = deviceId
        attemptedHubEntry = false
        needsPhoneAccess = false
        status = nil
        checkedAt = nil
        progress = ""
        message = nil
    }

    /// Registry presence is not hardware connectivity. Keep this independent of BLE progress.
    var deviceIds: [String] {
        var seen = Set<String>()
        return (records.map(\.deviceId) + attempts.map(\.deviceId) + localDeviceIds)
            .filter { seen.insert($0).inserted }
    }

    var confirmedEmpty: Bool {
        deviceIds.isEmpty && (registryState == .loaded || (registryState == .loading && hasLoadedRegistry))
    }

    func displayIdentifier(_ id: String) -> String {
        let compact = id.replacingOccurrences(of: "-", with: "")
        let others = deviceIds.filter { $0 != id }.map { $0.replacingOccurrences(of: "-", with: "") }
        for length in min(4, compact.count)...compact.count {
            let prefix = String(compact.prefix(length))
            if !others.contains(where: { $0.hasPrefix(prefix) }) { return prefix }
        }
        return compact
    }

    func inventoryLabel(_ id: String) -> String {
        if let record = records.first(where: { $0.deviceId == id }) {
            switch record.status {
            case "disabled": return "Agent access disabled"
            case "active": return "Paired"
            case "committed": return "Activation unfinished"
            default: return "Setup pending"
            }
        }
        return attempts.contains { $0.deviceId == id } ? "Saved setup · resume nearby" : "Saved phone access · ownership not checked"
    }

    func refreshRegistry() {
        guard registryWork == nil, !busy else { return }
        registryEpoch &+= 1
        let ticket = registryEpoch
        registryState = .loading
        registryWork = Task { [weak self] in
            guard let self, ticket == self.registryEpoch, !Task.isCancelled else { return }
            // Stage local inventory until the remote result settles. Publishing it first
            // briefly renders different row labels/order and replaces the cold entry layout.
            var localDeviceIds = self.localDeviceIds
            var attempts = self.attempts
            do {
                localDeviceIds = try self.store.deviceIds()
                attempts = try self.store.attempts()
                let records = try await self.registry.list()
                try Task.checkCancellation()
                guard ticket == self.registryEpoch else { return }
                self.records = records
                self.hasLoadedRegistry = true
                self.registryState = .loaded
            } catch {
                guard ticket == self.registryEpoch, !Task.isCancelled else { return }
                self.registryState = .failed((error as? CubeHardwareError)?.errorDescription
                    ?? "Couldn’t load owned Cubes. Check your connection and retry.")
            }
            guard ticket == self.registryEpoch else { return }
            // Also publish local recovery on failure; never discard saved phone access.
            self.localDeviceIds = localDeviceIds
            self.attempts = attempts
            self.registryWork = nil
        }
    }

    private func cancelRegistryRefresh() {
        registryEpoch &+= 1
        registryWork?.cancel(); registryWork = nil
        if registryState == .loading { registryState = .idle }
    }

    func setup(_ payload: CubeSetupPayload) {
        select(payload.deviceId)
        preparingSetup = true
        run("Saving setup attempt…") { try await self.prepareSetup(payload) }
    }

    func discoverPairingCubes() {
        pause()
        pairingLocators = []
        run("Looking for nearby Cubes…") {
            let names = try await self.ble.discover()
            try Task.checkCancellation()
            self.pairingLocators = names
            self.progress = names.isEmpty ? "No Cubes found. Check power and Bluetooth permission." : "Choose the locator shown on your Cube."
        }
    }

    func setupManual(locator: String, code: String) {
        guard !busy else { return }
        run("Authenticating pairing code…") {
            guard self.pairingLocators.contains(locator), CubeSetupPayload.validLocator(locator) else {
                throw CubeHardwareError.invalidSetupCode
            }
            let secret = try CubeSetupPayload.manualSecret(code)
            try await self.ble.connect(name: locator, secret: secret, bootstrap: true)
            let data = try await self.ble.command(CubeControl.encode("status"))
            try Task.checkCancellation()
            _ = try CubeControl.checked(data)
            let identity = try JSONDecoder().decode(CubeStatus.self, from: data)
            guard UUID(uuidString: identity.deviceId)?.uuidString.lowercased() == identity.deviceId,
                  CubeSetupPayload.locator(identity.deviceId) == locator else { throw CubeHardwareError.authentication }
            let snapshot = try CubeControl.status(data, deviceId: identity.deviceId)
            guard snapshot.phase == "bootstrap" else { throw CubeHardwareError.authentication }
            let payload = CubeSetupPayload(version: 1, deviceId: snapshot.deviceId, name: locator,
                transport: "ble", security: 2, username: "cube-bootstrap", pop: secret)
            self.selected = snapshot.deviceId
            try await self.prepareSetup(payload)
        }
    }

    private func prepareSetup(_ payload: CubeSetupPayload) async throws {
        try Task.checkCancellation()
        let retained = try self.store.attempts().first { $0.deviceId == payload.deviceId }
        let manager = try self.store.load(deviceId: payload.deviceId) ?? CubeManagerStore.newSecret()
        var attempt = try retained ?? CubeSetupAttempt(deviceId: payload.deviceId,
            attemptId: UUID().uuidString.lowercased(), enrollmentSecret: CubeManagerStore.newSecret(),
            bootstrap: payload, generation: nil)
        attempt.bootstrap = payload
        // Reserve enough room for any firmware generation BEFORE taking gateway ownership.
        _ = try CubeControl.enrollment(attempt, manager: manager, gateway: self.registry.gateway,
            install: true, generation: Int(UInt32.max))
        try self.store.save(manager, deviceId: payload.deviceId)
        try self.store.saveAttempt(attempt)
        self.attempts = try self.store.attempts()
        try await self.resume(attempt, manager: manager)
    }

    func resumeSetup() {
        guard let attempt = selectedAttempt else { return }
        run("Resuming saved setup…") {
            guard let secret = try self.store.load(deviceId: attempt.deviceId) else { throw CubeHardwareError.storage }
            try await self.resume(attempt, manager: secret)
        }
    }

    private func resume(_ saved: CubeSetupAttempt, manager: String) async throws {
        var attempt = saved
        var bootstrapAuthenticated = false
        progress = "Authenticating nearby Cube…"
        // A QR is untrusted input. Prove physical access before reserving gateway ownership.
        // Manager first also covers lost install replies and process death after durable install.
        do { try await connectManager(attempt.deviceId, manager: manager) }
        catch {
            try Task.checkCancellation()
            guard let bootstrap = attempt.bootstrap else { throw error }
            try await ble.connect(name: bootstrap.name, secret: bootstrap.pop, bootstrap: true)
            let snapshot = try await readStatus(attempt.deviceId)
            guard snapshot.phase == "bootstrap" else { throw CubeHardwareError.authentication }
            bootstrapAuthenticated = true
        }
        if attempt.generation == nil {
            progress = "Reserving Cube with your account…"
            let record = try await registry.mutate("enroll", deviceId: attempt.deviceId, attempt: attempt, managerSecret: manager)
            try Task.checkCancellation()
            guard record.attemptId == attempt.attemptId, record.status != "disabled" else { throw CubeHardwareError.incompatible }
            attempt.generation = record.generation
            try store.saveAttempt(attempt)
            attempts = try store.attempts()
            upsert(record)
        }
        if bootstrapAuthenticated {
            progress = "Installing saved account and manager credentials…"
            let command = try CubeControl.enrollment(attempt, manager: manager, gateway: registry.gateway,
                install: true, generation: attempt.generation!)
            // A transport failure may mean durable install succeeded. Never generate replacement secrets.
            do { _ = try CubeControl.checked(await ble.command(command)) }
            catch { try Task.checkCancellation() }
            ble.cancel()
            try await connectManager(attempt.deviceId, manager: manager)
        }
        try Task.checkCancellation()
        guard let snapshot = status else { throw CubeHardwareError.unavailable }
        if snapshot.attemptId != attempt.attemptId || snapshot.generation != attempt.generation {
            let command = try CubeControl.enrollment(attempt, manager: manager, gateway: registry.gateway,
                install: false, generation: attempt.generation!)
            _ = try CubeControl.checked(await ble.command(command))
            try Task.checkCancellation()
        }
        status = try await readStatus(attempt.deviceId)
        nearby = true
        progress = "Phone access saved. Connect Cube to Wi-Fi."
        try finishIfReady()
    }

    func connectNearby() {
        guard let id = selected, !busy else { return }
        attemptedHubEntry = true
        connecting = true
        nearby = false
        needsPhoneAccess = false
        run("Connecting nearby…") {
            guard let manager = try self.store.load(deviceId: id) else {
                self.needsPhoneAccess = true
                self.progress = ""
                self.nearby = false
                self.ble.cancel()
                return
            }
            try await self.connectManager(id, manager: manager)
            self.progress = ""
            try self.finishIfReady()
        }
    }

    func recover() {
        guard let id = selected else { return }
        run("Restoring phone access…") {
            let record = try await self.registry.mutate("recover", deviceId: id, attempt: nil, managerSecret: nil)
            try Task.checkCancellation()
            guard let secret = record.managerSecret, CubeSecret.isCanonical(secret) else { throw CubeHardwareError.invalidSecret }
            if let old = try self.store.load(deviceId: id), old != secret { throw CubeHardwareError.authentication }
            try self.store.save(secret, deviceId: id)
            self.needsPhoneAccess = false
            self.upsert(record)
            self.progress = "Phone access restored. Agent access is unchanged."
        }
    }

    func disable() {
        guard let id = selected else { return }
        pause()
        run("Disabling agent access…") {
            let record = try await self.registry.mutate("disable", deviceId: id, attempt: nil, managerSecret: nil)
            try Task.checkCancellation()
            self.upsert(record)
            self.status = nil
            self.progress = "Agent access disabled. Ownership and local Bluetooth access are retained."
        }
    }

    func reenroll() {
        guard let id = selected, selectedRecord?.status == "disabled", !busy else { return }
        preparingSetup = true
        run("Starting a new enrollment…") {
            guard let manager = try self.store.load(deviceId: id) else { throw CubeHardwareError.authentication }
            // Expiry can precede install: prove either retained bootstrap or current manager.
            let bootstrap = self.selectedAttempt?.bootstrap
            do { try await self.connectManager(id, manager: manager) }
            catch {
                try Task.checkCancellation()
                guard let bootstrap else { throw error }
                try await self.ble.connect(name: bootstrap.name, secret: bootstrap.pop, bootstrap: true)
                let snapshot = try await self.readStatus(id)
                guard snapshot.phase == "bootstrap" else { throw CubeHardwareError.authentication }
            }
            let attempt = CubeSetupAttempt(deviceId: id, attemptId: UUID().uuidString.lowercased(),
                enrollmentSecret: try CubeManagerStore.newSecret(), bootstrap: bootstrap, generation: nil)
            _ = try CubeControl.enrollment(attempt, manager: manager, gateway: self.registry.gateway,
                install: bootstrap != nil, generation: Int(UInt32.max))
            try self.store.saveAttempt(attempt)
            self.attempts = try self.store.attempts()
            try await self.resume(attempt, manager: manager)
        }
    }

    func setWifi(ssid: String, password: String) {
        guard let id = selected, allowHardwareAction() else { return }
        run("Sending Wi-Fi settings…") {
            let command = try CubeControl.wifi(ssid: ssid, password: password)
            guard let manager = try self.store.load(deviceId: id) else { throw CubeHardwareError.authentication }
            try await self.connectManager(id, manager: manager)
            _ = try CubeControl.checked(await self.ble.command(command))
            try Task.checkCancellation()
            self.ble.cancel()
            self.nearby = false
            try await self.connectManager(id, manager: manager)
            let managementOnly = self.status?.phase == "active" || self.selectedRecord?.status == "disabled"
            try await self.waitForReady(id, wifiOnlySSID: managementOnly ? ssid : nil)
        }
    }

    func checkUntilReady() {
        guard let id = selected, allowHardwareAction() else { return }
        run("Checking Cube connection…") {
            guard let manager = try self.store.load(deviceId: id) else { throw CubeHardwareError.authentication }
            try await self.connectManager(id, manager: manager)
            _ = try CubeControl.checked(await self.ble.command(CubeControl.encode("retry")))
            try await self.waitForReady(id)
        }
    }

    private func allowHardwareAction() -> Bool {
        guard !busy else { return false }
        guard hardwareAvailable else {
            message = "Cube is not connected nearby. Retry the Bluetooth connection before changing hardware settings."
            return false
        }
        return true
    }

    private func waitForReady(_ id: String, wifiOnlySSID: String? = nil) async throws {
        // Polling interval is not a success timer: only authenticated hardware status completes setup.
        for _ in 0..<30 {
            let snapshot = try await readStatus(id)
            status = snapshot
            if let wifiOnlySSID, snapshot.wifiConnected, snapshot.ssid == wifiOnlySSID {
                progress = "Wi-Fi updated. Sentient status is shown separately."
                return
            }
            if snapshot.ready { try finishIfReady(); return }
            if snapshot.accountAttention { throw CubeHardwareError.authentication }
            if snapshot.wifiState == "failed" { throw CubeHardwareError.wifiJoinFailed }
            progress = snapshot.wifiConnected ? "Wi-Fi connected. Waiting for account and Sentient…" : "Waiting for Wi-Fi…"
            try await Task.sleep(for: .seconds(2))
        }
        throw CubeHardwareError.timeout
    }

    private func connectManager(_ id: String, manager: String) async throws {
        try Task.checkCancellation()
        nearby = false
        try await ble.connect(name: "SC_" + id.replacingOccurrences(of: "-", with: "").prefix(12), secret: manager, bootstrap: false)
        try Task.checkCancellation()
        let snapshot = try await readStatus(id)
        try Task.checkCancellation()
        guard selected == id else { throw CancellationError() }
        status = snapshot
        nearby = true
    }

    private func readStatus(_ id: String) async throws -> CubeStatus {
        let data = try await ble.command(CubeControl.encode("status"))
        try Task.checkCancellation()
        let snapshot = try CubeControl.status(data, deviceId: id)
#if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--qa-cube-setup") {
            let known = ["", "storage", "wifi-storage", "hardware-unavailable", "ble-unavailable",
                         "clock-unavailable", "denied", "expired", "conflict", "unavailable"]
            let reason = known.contains(snapshot.lastError) ? snapshot.lastError : "unknown"
            print("CUBE_STATUS phase=\(snapshot.phase) wifi=\(snapshot.wifiState) gateway=\(snapshot.gatewayConnected) attention=\(snapshot.accountAttention) reason=\(reason)")
        }
#endif
        checkedAt = Date()
        return snapshot
    }

    private func finishIfReady() throws {
        guard let status, status.ready, selectedRecord?.status != "disabled" else { return }
        if let attempt = selectedAttempt {
            guard status.attemptId == attempt.attemptId, status.generation == attempt.generation else {
                throw CubeHardwareError.incompatible
            }
            try store.removeAttempt(deviceId: status.deviceId)
            attempts = try store.attempts()
            progress = "Cube connected. Tap to wake, then hold the screen to talk."
        } else {
            progress = ""
        }
    }

    private func upsert(_ record: CubeRegistryRecord) {
        var safe = record
        safe.managerSecret = nil
        records.removeAll { $0.deviceId == record.deviceId }
        records.append(safe)
    }

    private func run(_ progress: String, operation: @escaping @MainActor () async throws -> Void) {
        guard !busy else { return }
        cancelRegistryRefresh() // An older list must not overwrite a new enrollment or disable.
        epoch &+= 1
        let ticket = epoch
        busy = true; message = nil; self.progress = progress
        work = Task { [weak self] in
            guard let self, ticket == self.epoch, !Task.isCancelled else { return }
            do { try await operation() }
            catch {
                guard ticket == self.epoch, !Task.isCancelled else { return }
                self.message = (error as? CubeHardwareError)?.errorDescription ?? "Couldn’t reach Cube or gateway. Check your connection and retry."
                self.progress = ""
                self.ble.cancel()
                self.nearby = false
            }
            guard ticket == self.epoch else { return }
            self.busy = false
            self.connecting = false
            self.preparingSetup = false
            self.work = nil
        }
    }

    func pause() {
        cancelRegistryRefresh()
        epoch &+= 1
        work?.cancel(); work = nil
        ble.cancel(); nearby = false
        if busy {
            progress = connecting ? "Connection paused. Retry when Cube is nearby." : "Setup paused. Resume when Cube is nearby."
        }
        busy = false
        connecting = false
        preparingSetup = false
    }

    func clearForLogout() throws {
        pause()
        try store.removeAccount()
        registryState = .idle
        hasLoadedRegistry = false
        attemptedHubEntry = false
        needsPhoneAccess = false
        attempts = []; localDeviceIds = []; records = []; status = nil; checkedAt = nil; selected = nil
    }
}
