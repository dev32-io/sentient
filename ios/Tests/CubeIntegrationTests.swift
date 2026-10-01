import Foundation
import SwiftUI
import XCTest
import Vision
@testable import SentientApp

@MainActor
final class CubeIntegrationTests: XCTestCase {
    private let id = "12345678-1234-4234-8234-123456789abc"
    private let secret = CubeSecret.encode(Data(repeating: 9, count: 32))

    func testLostInstallReplyResumesWithDurableManagerAndWaitsForRealStatus() async throws {
        let store = MemoryCubeStore()
        let registry = FakeCubeRegistry()
        let ble = FakeCubeBLE(deviceId: id)
        ble.loseInstallReply = true
        let model = CubeViewModel(registry: registry, store: store, ble: ble)
        model.setup(payload())
        await idle(model)
        XCTAssertNil(model.message)
        XCTAssertEqual(registry.operations, ["enroll"])
        XCTAssertEqual(ble.connections, [false, true, false])
        XCTAssertNotNil(store.secrets[id])
        XCTAssertEqual(store.saved.count, 1)
        XCTAssertFalse(try XCTUnwrap(model.status).ready)
        let retained = try XCTUnwrap(store.saved.first)
        XCTAssertEqual(retained.attemptId, registry.attempt?.attemptId)

        model.pause()
        model.resumeSetup()
        await idle(model)
        XCTAssertEqual(registry.operations, ["enroll"], "Do not mint another attempt after restart")
        XCTAssertEqual(store.saved.first, retained)
        XCTAssertFalse(model.status!.ready, "Acknowledgement is not success")

        ble.active = true
        model.connectNearby()
        await idle(model)
        XCTAssertTrue(model.status!.ready)
        XCTAssertTrue(store.saved.isEmpty)
        XCTAssertFalse(model.needsSetup)
        XCTAssertTrue(model.progress.contains("Tap to wake"), "Actual setup completion keeps onboarding instructions")
        model.connectNearby()
        await idle(model)
        XCTAssertTrue(model.progress.isEmpty, "Ordinary refresh uses status/timestamp, not onboarding instructions")
        XCTAssertNotNil(store.secrets[id], "Ready removes attempt, not management authority")
        ble.onDisconnect?()
        XCTAssertFalse(model.nearby)
        XCTAssertNotNil(model.checkedAt, "Disconnected status remains a dated snapshot, not live presence")
    }

    func testOversizedSetupRejectedBeforeReservingOwnershipOrSavingCredentials() async throws {
        let store = MemoryCubeStore()
        let registry = FakeCubeRegistry(wsURL: "wss://" + String(repeating: "a", count: 63) + "." + String(repeating: "b", count: 63) + "." + String(repeating: "c", count: 40) + ".test/api/v1/ws")
        let model = CubeViewModel(registry: registry, store: store, ble: FakeCubeBLE(deviceId: id))
        model.setup(payload())
        await idle(model)
        XCTAssertEqual(model.message, CubeHardwareError.payloadTooLarge.errorDescription)
        XCTAssertTrue(registry.operations.isEmpty)
        XCTAssertTrue(store.secrets.isEmpty)
        XCTAssertTrue(store.saved.isEmpty)
    }

    func testWrongBootstrapProofCannotReserveGatewayOwnership() async {
        let store = MemoryCubeStore()
        let registry = FakeCubeRegistry()
        let ble = FakeCubeBLE(deviceId: id)
        ble.rejectProof = true
        let model = CubeViewModel(registry: registry, store: store, ble: ble)
        model.setup(payload())
        await idle(model)
        XCTAssertNotNil(model.message)
        XCTAssertTrue(registry.operations.isEmpty)
        XCTAssertFalse(ble.installed)
        XCTAssertNotNil(store.saved.first, "A retry keeps identical saved credentials")
    }

    func testImmediateLogoutBeforeQueuedSetupCannotRecreateKeychainCredentials() async throws {
        let store = try CubeManagerStore(gatewayOrigin: URL(string: "https://cube-unit.invalid")!,
            accountId: UUID().uuidString)
        defer { try? store.removeAccount() }
        let registry = FakeCubeRegistry()
        let ble = FakeCubeBLE(deviceId: id)
        let model = CubeViewModel(registry: registry, store: store, ble: ble)
        model.setup(payload())
        try model.clearForLogout()
        // Drain the queued MainActor work, not model.busy (logout already cleared it).
        await Task { @MainActor in }.value
        XCTAssertTrue(try store.deviceIds().isEmpty)
        XCTAssertTrue(try store.attempts().isEmpty)
        XCTAssertTrue(ble.connections.isEmpty)
        XCTAssertTrue(registry.operations.isEmpty)
    }

    func testCorrectedQRAndManualProofPreserveInterruptedAttemptSecrets() async throws {
        for manual in [false, true] {
            let store = MemoryCubeStore()
            let registry = FakeCubeRegistry()
            let ble = FakeCubeBLE(deviceId: id)
            ble.expectedBootstrap = secret
            let model = CubeViewModel(registry: registry, store: store, ble: ble)
            let wrong = CubeSetupPayload(version: 1, deviceId: id, name: CubeSetupPayload.locator(id),
                transport: "ble", security: 2, username: "cube-bootstrap",
                pop: CubeSecret.encode(Data(repeating: 8, count: 32)))
            model.setup(wrong)
            await idle(model)
            XCTAssertNotNil(model.message)
            XCTAssertTrue(registry.operations.isEmpty)
            let retained = try XCTUnwrap(store.saved.first)
            let manager = try XCTUnwrap(store.secrets[id])
            if manual {
                model.discoverPairingCubes()
                await idle(model)
                model.setupManual(locator: CubeSetupPayload.locator(id), code: secret)
            } else {
                model.setup(payload())
            }
            await idle(model)
            XCTAssertNil(model.message)
            XCTAssertTrue(ble.installed)
            XCTAssertEqual(registry.operations, ["enroll"])
            let corrected = try XCTUnwrap(store.saved.first)
            XCTAssertTrue(corrected.bootstrap == payload(), "Corrected bootstrap proof must replace retained proof")
            XCTAssertEqual(corrected.attemptId, retained.attemptId)
            XCTAssertTrue(corrected.enrollmentSecret == retained.enrollmentSecret, "Enrollment secret must remain stable")
            XCTAssertTrue(store.secrets[id] == manager, "Manager secret must remain stable")
        }
    }

    func testRecoveryKeepsDisabledStatusAndNeverCallsEnroll() async throws {
        let store = MemoryCubeStore()
        let registry = FakeCubeRegistry()
        registry.recordStatus = "disabled"
        registry.manager = secret
        let model = CubeViewModel(registry: registry, store: store, ble: FakeCubeBLE(deviceId: id))
        model.select(id)
        model.recover()
        await idle(model)
        XCTAssertEqual(store.secrets[id], secret)
        XCTAssertEqual(model.selectedRecord?.status, "disabled")
        XCTAssertNil(model.selectedRecord?.managerSecret, "Do not retain escrow in presentation state")
        XCTAssertEqual(registry.operations, ["recover"])
        XCTAssertNil(model.status)
    }

    func testCancellationFencesLateEnrollmentAndLogoutStopsBLEBeforeErasing() async throws {
        let store = MemoryCubeStore()
        let registry = FakeCubeRegistry()
        registry.hold = true
        let ble = FakeCubeBLE(deviceId: id)
        let model = CubeViewModel(registry: registry, store: store, ble: ble)
        model.setup(payload())
        let deadline = ContinuousClock.now + .seconds(3)
        while registry.pending == nil && ContinuousClock.now < deadline { await Task.yield() }
        XCTAssertNotNil(registry.pending)
        model.pause()
        registry.release()
        for _ in 0..<20 { await Task.yield() }
        XCTAssertNil(store.saved.first?.generation)
        XCTAssertFalse(ble.installed, "Cancellation must fence firmware install after a late gateway reply")
        store.beforeRemove = { XCTAssertGreaterThan(ble.cancelCount, 0) }
        try model.clearForLogout()
        XCTAssertTrue(store.saved.isEmpty)
        XCTAssertTrue(store.secrets.isEmpty)
    }

    func testDisabledCubeWifiManagementDoesNotRequireAgentReactivation() async throws {
        let store = MemoryCubeStore()
        let registry = FakeCubeRegistry()
        registry.recordStatus = "disabled"
        registry.manager = secret
        let ble = FakeCubeBLE(deviceId: id)
        ble.installed = true
        let model = CubeViewModel(registry: registry, store: store, ble: ble)
        model.select(id)
        model.recover()
        await idle(model)
        model.enterHub()
        await idle(model)
        model.setWifi(ssid: "Replacement", password: "password")
        await idle(model)
        XCTAssertNil(model.message)
        XCTAssertEqual(model.status?.ssid, "Replacement")
        XCTAssertEqual(model.status?.wifiConnected, true)
        XCTAssertFalse(model.status!.ready)
        XCTAssertEqual(registry.operations, ["recover"])
        XCTAssertEqual(model.progress, "Wi-Fi updated. Sentient status is shown separately.")
    }

    func testLocalManagerRemainsDiscoverableWhenRegistryIsOffline() async throws {
        let store = MemoryCubeStore()
        store.secrets[id] = secret
        let registry = FakeCubeRegistry()
        registry.offline = true
        let model = CubeViewModel(registry: registry, store: store, ble: FakeCubeBLE(deviceId: id))
        model.refreshRegistry()
        await idle(model)
        XCTAssertEqual(model.localDeviceIds, [id])
        guard case .failed = model.registryState else { return XCTFail("Offline registry must not be empty") }
        XCTAssertTrue(model.progress.isEmpty, "Registry refresh must not use hardware progress")
    }

    func testKeychainAttemptSurvivesStoreRecreationAndIsAccountScoped() throws {
        let gateway = URL(string: "https://cube-unit.invalid")!
        let account = UUID().uuidString
        let store = try CubeManagerStore(gatewayOrigin: gateway, accountId: account)
        defer { try? store.removeAccount() }
        let attempt = CubeSetupAttempt(deviceId: id, attemptId: UUID().uuidString.lowercased(),
            enrollmentSecret: secret, bootstrap: payload(), generation: nil)
        try store.save(secret, deviceId: id)
        try store.saveAttempt(attempt)
        let reopened = try CubeManagerStore(gatewayOrigin: gateway, accountId: account)
        XCTAssertEqual(try reopened.load(deviceId: id), secret)
        XCTAssertEqual(try reopened.deviceIds(), [id])
        XCTAssertEqual(try reopened.attempts(), [attempt])
        let foreign = try CubeManagerStore(gatewayOrigin: gateway, accountId: UUID().uuidString)
        XCTAssertNil(try foreign.load(deviceId: id))
        XCTAssertTrue(try foreign.attempts().isEmpty)
        try reopened.removeAccount()
        XCTAssertTrue(try reopened.attempts().isEmpty)
        XCTAssertNil(try reopened.load(deviceId: id))
    }

    func testRegistryUsesCurrentHumanBearerAndHonorsRateLimitWithoutRetryingMutation() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [CubeHTTPFixture.self]
        let registry = CubeRegistry(gateway: try CubeGateway(wsURL: "wss://cube-unit.invalid/api/v1/ws"),
            allowSelfSignedDevHost: false, configuration: configuration, token: { "synthetic-human-token" })
        var calls = 0
        CubeHTTPFixture.respond = { request in
            calls += 1
            XCTAssertEqual(request.url?.absoluteString, "https://cube-unit.invalid/api/v1/devices/disable")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer synthetic-human-token")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
            XCTAssertEqual(request.httpMethod, "POST")
            return (429, ["Retry-After": "30"], Data("{\"error\":\"rate-limited\",\"retryable\":true}".utf8))
        }
        defer { CubeHTTPFixture.respond = nil }
        for _ in 0..<2 {
            do {
                _ = try await registry.mutate("disable", deviceId: id)
                XCTFail("Rate-limited mutation must fail")
            } catch { XCTAssertEqual(error as? CubeHardwareError, .registry(429)) }
        }
        XCTAssertEqual(calls, 1)
    }

    func testWireBoundsWifiValidationAndCompletionPredicate() throws {
        let gateway = try CubeGateway(wsURL: "wss://cube.test/api/v1/ws")
        XCTAssertEqual(gateway.registryURL.absoluteString, "https://cube.test/api/v1/devices")
        for invalid in ["ws://cube.test/api/v1/ws", "wss://user:pass@cube.test/api/v1/ws", "wss://cube.test/api/v1/ws?token=x"] {
            XCTAssertThrowsError(try CubeGateway(wsURL: invalid))
        }
        XCTAssertNoThrow(try CubeControl.wifi(ssid: "Home", password: ""))
        XCTAssertNoThrow(try CubeControl.wifi(ssid: String(repeating: "é", count: 16), password: String(repeating: "a", count: 64)))
        for (ssid, password) in [("", ""), (String(repeating: "é", count: 17), "password"), ("Home", "short"), ("Home", String(repeating: "z", count: 64)), ("Home\0", "password")] {
            XCTAssertThrowsError(try CubeControl.wifi(ssid: ssid, password: password))
        }
        let ble = FakeCubeBLE(deviceId: id)
        let pending = try CubeControl.status(ble.snapshot(), deviceId: id)
        XCTAssertFalse(pending.ready)
        ble.active = true
        XCTAssertTrue(try CubeControl.status(ble.snapshot(), deviceId: id).ready)
        XCTAssertThrowsError(try CubeControl.status(ble.snapshot(), deviceId: UUID().uuidString))
    }

    func testManualPairingValidatesChoiceProofAndUsesCommonEnrollment() async throws {
        for mode in ["valid", "invalid", "wrong", "choice", "mismatch"] {
            let store = MemoryCubeStore()
            let registry = FakeCubeRegistry()
            let ble = FakeCubeBLE(deviceId: id)
            ble.rejectProof = mode == "wrong"
            if mode == "mismatch" { ble.statusDeviceId = "00000000-1234-4234-8234-123456789abc" }
            let model = CubeViewModel(registry: registry, store: store, ble: ble)
            model.discoverPairingCubes()
            await idle(model)
            model.setupManual(locator: mode == "choice" ? "SC_000000000000" : CubeSetupPayload.locator(id),
                code: mode == "invalid" ? "short" : String(secret.prefix(20)) + " \n" + secret.dropFirst(20))
            await idle(model)
            if mode == "valid" {
                XCTAssertNil(model.message)
                XCTAssertEqual(registry.operations, ["enroll"])
                XCTAssertEqual(ble.connections.first, true)
                XCTAssertTrue(ble.installed)
            } else {
                XCTAssertNotNil(model.message)
                XCTAssertTrue(registry.operations.isEmpty)
                XCTAssertTrue(store.saved.isEmpty)
            }
        }
        XCTAssertThrowsError(try CubeSetupPayload.manualSecret(secret + "!"))
    }

    func testManualCancellationCannotInstallAfterLateEnrollment() async {
        let store = MemoryCubeStore()
        let registry = FakeCubeRegistry()
        registry.hold = true
        let ble = FakeCubeBLE(deviceId: id)
        let model = CubeViewModel(registry: registry, store: store, ble: ble)
        model.discoverPairingCubes()
        await idle(model)
        model.setupManual(locator: CubeSetupPayload.locator(id), code: secret)
        let deadline = ContinuousClock.now + .seconds(3)
        while registry.pending == nil && ContinuousClock.now < deadline { await Task.yield() }
        XCTAssertNotNil(registry.pending)
        model.pause()
        registry.release()
        for _ in 0..<20 { await Task.yield() }
        XCTAssertFalse(ble.installed)
        XCTAssertNil(store.saved.first?.generation)
    }

    func testRegistryLoadingEmptyFailureAndLocalInventoryStaySeparateFromHardware() async throws {
        let store = MemoryCubeStore()
        let registry = FakeCubeRegistry()
        let ble = FakeCubeBLE(deviceId: id)
        let model = CubeViewModel(registry: registry, store: store, ble: ble)
        XCTAssertFalse(model.confirmedEmpty)
        registry.holdList = true
        model.refreshRegistry()
        await waitForList(registry)
        XCTAssertEqual(model.registryState, .loading)
        XCTAssertFalse(model.busy)
        XCTAssertTrue(model.progress.isEmpty)
        XCTAssertFalse(model.confirmedEmpty)
        XCTAssertEqual(ble.cancelCount, 0)
        registry.releaseList()
        await idle(model)
        XCTAssertTrue(model.confirmedEmpty)

        registry.offline = true
        model.refreshRegistry()
        await idle(model)
        XCTAssertFalse(model.confirmedEmpty)
        guard case .failed = model.registryState else { return XCTFail("Failure must not become empty") }

        let localOnly = "00000000-1234-4234-8234-123456789abc"
        let attemptOnly = "11111111-1234-4234-8234-123456789abc"
        store.secrets = [id: secret, localOnly: secret]
        store.saved = [CubeSetupAttempt(deviceId: id, attemptId: UUID().uuidString,
            enrollmentSecret: secret, bootstrap: nil, generation: nil),
            CubeSetupAttempt(deviceId: attemptOnly, attemptId: UUID().uuidString,
                enrollmentSecret: secret, bootstrap: nil, generation: nil)]
        model.refreshRegistry()
        await idle(model)
        XCTAssertEqual(Set(model.deviceIds), Set([id, localOnly, attemptOnly]))
        registry.offline = false
        registry.listed = [record(status: "disabled")]
        model.refreshRegistry()
        await idle(model)
        XCTAssertEqual(model.deviceIds.count, 3, "Registry, attempt and local key must deduplicate by full identity")
        XCTAssertEqual(model.deviceIds.first, id)
        XCTAssertEqual(model.records.first?.status, "disabled")
        XCTAssertFalse(model.nearby, "Registry is not live connectivity")
        XCTAssertNil(model.status)
        XCTAssertFalse(model.confirmedEmpty)
    }

    func testChildNavigationRetainsOperationButBothExitPathsFenceLateCompletion() async throws {
        for exit: CubePage? in [.devices, nil] {
            let store = MemoryCubeStore()
            let registry = FakeCubeRegistry()
            registry.hold = true
            let ble = FakeCubeBLE(deviceId: id)
            let model = CubeViewModel(registry: registry, store: store, ble: ble)
            model.setup(payload())
            let deadline = ContinuousClock.now + .seconds(3)
            while registry.pending == nil && ContinuousClock.now < deadline { await Task.yield() }
            XCTAssertNotNil(registry.pending)
            let cancellations = ble.cancelCount
            let connections = ble.connections.count
            model.enterHub()
            XCTAssertEqual(ble.connections.count, connections, "Entry cannot replace active setup")
            model.navigationChanged(from: .hub, to: .wifi)
            model.navigationChanged(from: .wifi, to: .hub)
            XCTAssertTrue(model.busy)
            XCTAssertEqual(model.selected, id)
            XCTAssertEqual(ble.cancelCount, cancellations)
            model.navigationChanged(from: .hub, to: exit)
            XCTAssertFalse(model.busy)
            XCTAssertNil(model.selected)
            XCTAssertGreaterThan(ble.cancelCount, cancellations)
            registry.release()
            await Task { @MainActor in }.value
            XCTAssertFalse(ble.installed)
            XCTAssertNil(store.saved.first?.generation)
        }
    }

    func testLateRegistryResponseCannotOverwriteMutationOrRepopulateLoggedOutOwner() async throws {
        let registry = FakeCubeRegistry()
        registry.listed = [record(status: "active")]
        registry.holdList = true
        let model = CubeViewModel(registry: registry, store: MemoryCubeStore(), ble: FakeCubeBLE(deviceId: id))
        model.select(id)
        model.refreshRegistry()
        await waitForList(registry)
        registry.recordStatus = "disabled"
        model.disable()
        await idle(model)
        registry.releaseList()
        await Task { @MainActor in }.value
        XCTAssertEqual(model.selectedRecord?.status, "disabled")
        registry.holdList = true
        model.refreshRegistry()
        await waitForList(registry)
        try model.clearForLogout()
        registry.releaseList()
        await Task { @MainActor in }.value
        XCTAssertTrue(model.deviceIds.isEmpty)
        XCTAssertEqual(model.registryState, .idle)
        XCTAssertNil(model.selected)
    }

    func testAutomaticEntryIsOneReadAttemptAcrossInflightAndChildNavigation() async throws {
        let registry = FakeCubeRegistry()
        let store = MemoryCubeStore()
        store.secrets[id] = secret
        let ble = FakeCubeBLE(deviceId: id)
        ble.installed = true
        ble.active = true
        ble.holdNextStatus = true
        let model = CubeViewModel(registry: registry, store: store, ble: ble)
        model.select(id)
        model.enterHub()
        try await waitUntil { ble.pendingStatus != nil }
        defer { model.pause(); ble.releaseStatus() }
        XCTAssertTrue(model.connecting)
        XCTAssertFalse(model.hardwareAvailable, "Transport connection alone cannot enable controls")
        model.enterHub()
        model.navigationChanged(from: .hub, to: .details)
        model.navigationChanged(from: .details, to: .hub)
        model.enterHub()
        XCTAssertEqual(ble.connections, [false])
        ble.releaseStatus()
        await idle(model)
        XCTAssertTrue(model.hardwareAvailable)
        XCTAssertFalse(model.connecting)
        model.enterHub()
        XCTAssertEqual(ble.commands, ["status"])
        XCTAssertTrue(registry.operations.isEmpty, "Entry never recovers, enrolls, or changes ownership")
        ble.onDisconnect?()
        model.navigationChanged(from: .hub, to: .wifi)
        model.navigationChanged(from: .wifi, to: .hub)
        model.enterHub()
        XCTAssertEqual(ble.connections.count, 1, "Child return does not start an unrequested retry loop")
        model.connectNearby()
        await idle(model)
        XCTAssertEqual(ble.connections.count, 2, "Explicit Retry remains available")

        ble.holdNextStatus = true
        model.setWifi(ssid: "Synthetic", password: "password")
        try await waitUntil { ble.pendingStatus != nil }
        let wifiConnections = ble.connections.count
        let cancellations = ble.cancelCount
        model.navigationChanged(from: .hub, to: .wifi)
        model.navigationChanged(from: .wifi, to: .hub)
        model.enterHub()
        XCTAssertTrue(model.busy)
        XCTAssertEqual(ble.connections.count, wifiConnections)
        XCTAssertEqual(ble.cancelCount, cancellations, "Entry cannot cancel an active Wi-Fi change")
        ble.releaseStatus()
        await idle(model)
        XCTAssertEqual(model.status?.ssid, "Synthetic")
        XCTAssertNil(model.message)

        ble.rejectProof = true
        model.select(id)
        model.enterHub()
        await idle(model)
        let failedConnections = ble.connections.count
        XCTAssertNotNil(model.message)
        model.enterHub()
        XCTAssertEqual(ble.connections.count, failedConnections, "Failed entry does not automatically retry")
    }

    func testAutomaticEntryLateReplyCannotCrossSelectionExitOrLogout() async throws {
        for ending in ["selection", "exit", "logout"] {
            let store = MemoryCubeStore()
            store.secrets[id] = secret
            let second = "00000000-1234-4234-8234-123456789abc"
            store.secrets[second] = secret
            let ble = FakeCubeBLE(deviceId: id)
            ble.installed = true
            ble.active = true
            ble.holdNextStatus = true
            let model = CubeViewModel(registry: FakeCubeRegistry(), store: store, ble: ble)
            defer { model.pause(); ble.releaseStatus() }
            model.select(id)
            model.enterHub()
            try await waitUntil { ble.pendingStatus != nil }
            if ending == "selection" {
                model.select(second)
                ble.statusDeviceId = second
                model.enterHub()
                await idle(model)
                XCTAssertEqual(model.status?.deviceId, second)
            } else if ending == "exit" {
                model.navigationChanged(from: .hub, to: nil)
            } else {
                try model.clearForLogout()
            }
            ble.releaseStatus()
            await Task { @MainActor in }.value
            XCTAssertFalse(model.connecting)
            if ending == "selection" {
                XCTAssertEqual(model.selected, second)
                XCTAssertEqual(model.status?.deviceId, second)
                XCTAssertEqual(ble.connectionNames, [CubeSetupPayload.locator(id), CubeSetupPayload.locator(second)])
                XCTAssertTrue(model.hardwareAvailable)
            } else {
                XCTAssertNil(model.selected)
                XCTAssertNil(model.status)
                XCTAssertNil(model.checkedAt)
                XCTAssertFalse(model.hardwareAvailable)
            }
        }
    }

    func testOfflineHardwareActionsBlockedButExplicitRecoveryRemainsAvailable() async throws {
        let store = MemoryCubeStore()
        let registry = FakeCubeRegistry()
        registry.manager = secret
        registry.recordStatus = "disabled"
        let ble = FakeCubeBLE(deviceId: id)
        ble.installed = true
        let model = CubeViewModel(registry: registry, store: store, ble: ble)
        model.select(id)
        model.enterHub()
        await idle(model)
        XCTAssertTrue(model.needsPhoneAccess)
        XCTAssertNil(model.message, "Missing local authority is recovery guidance, not proof of invalid credentials")
        XCTAssertTrue(ble.connections.isEmpty)
        model.setWifi(ssid: "Synthetic", password: "password")
        model.checkUntilReady()
        XCTAssertFalse(model.busy)
        XCTAssertTrue(ble.commands.isEmpty)
        XCTAssertTrue(ble.connections.isEmpty)
        model.recover()
        await idle(model)
        XCTAssertFalse(model.needsPhoneAccess)
        XCTAssertFalse(model.hardwareAvailable, "Recovery does not connect or re-enable agent access")
        XCTAssertEqual(registry.operations, ["recover"])
        model.connectNearby()
        await idle(model)
        XCTAssertTrue(model.hardwareAvailable)
        ble.onDisconnect?()
        let commands = ble.commands
        model.setWifi(ssid: "Synthetic", password: "password")
        model.checkUntilReady()
        XCTAssertEqual(ble.commands, commands, "A dated snapshot cannot authorize hardware actions")
        model.disable()
        await idle(model)
        XCTAssertEqual(registry.operations, ["recover", "disable"])
    }

    func testAutomaticEntryConnectingAndMissingAccessFixtures() async throws {
        let registry = FakeCubeRegistry()
        registry.manager = secret
        registry.recordStatus = "active"
        let ble = FakeCubeBLE(deviceId: id)
        ble.installed = true
        ble.active = true
        let model = CubeViewModel(registry: registry, store: MemoryCubeStore(), ble: ble)
        model.select(id)
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = mount(CubeScreen(model: model, page: .hub, onBack: {}), in: scene)
        defer { model.pause(); ble.releaseStatus(); window.isHidden = true; window.rootViewController = nil }
        try await waitUntil { model.needsPhoneAccess && !model.busy }
        XCTAssertTrue(ble.connections.isEmpty)
        _ = try await captureRendered(window, name: "cube-hub-restore-phone-access",
            containing: ["Restore phone access", "Retry connection"])
        model.recover() // Explicit owner recovery, never an effect of opening the hub.
        await idle(model)
        ble.holdNextStatus = true
        model.connectNearby()
        try await waitUntil { ble.pendingStatus != nil }
        XCTAssertFalse(model.hardwareAvailable)
        let connecting = try await captureRendered(window, name: "cube-hub-authenticating",
            containing: ["Connecting nearby", "Unavailable"], excluding: ["Keep Cube and iPhone nearby", "Pause"])
        XCTAssertEqual(connecting.filter { $0.text.localizedCaseInsensitiveContains("Connecting") }.count, 1,
            "Automatic progress belongs in one existing status area, not a second panel")
        ble.releaseStatus()
        await idle(model)
        XCTAssertTrue(model.hardwareAvailable)
        XCTAssertEqual(ble.commands, ["status"])
        _ = try await captureRendered(window, name: "cube-hub-authenticated",
            containing: ["Connected at last check", "Battery"])
        ble.onDisconnect?()
        XCTAssertNotNil(model.status, "Snapshot retained, but no longer authorizes live controls")
        XCTAssertFalse(model.hardwareAvailable)
        _ = try await captureRendered(window, name: "cube-hub-disconnected-unavailable",
            containing: ["Unavailable", "Retry connection"])
    }

    func testCompactIdentifiersDisambiguateLocalAndRegistryCollisions() async {
        let registry = FakeCubeRegistry()
        let store = MemoryCubeStore()
        let collision = "12345679-1234-4234-8234-123456789abc"
        registry.listed = [record(status: "active")]
        store.secrets[collision] = secret
        let model = CubeViewModel(registry: registry, store: store, ble: FakeCubeBLE(deviceId: id))
        model.refreshRegistry()
        await idle(model)
        XCTAssertEqual(model.displayIdentifier(id), "12345678")
        XCTAssertEqual(model.displayIdentifier(collision), "12345679")
        XCTAssertNotEqual(model.displayIdentifier(id), model.displayIdentifier(collision))
        XCTAssertEqual(model.records.first?.deviceId, id, "Presentation must not alter authority identity")
    }

    func testFinishedFeedbackStaysOnItsLeafWhileLiveProgressAndErrorsSurviveNavigation() async {
        let registry = FakeCubeRegistry()
        let store = MemoryCubeStore()
        let ble = FakeCubeBLE(deviceId: id)
        let model = CubeViewModel(registry: registry, store: store, ble: ble)
        model.setup(payload())
        await idle(model)
        XCTAssertFalse(model.progress.isEmpty, "Setup result remains visible until navigation")
        model.navigationChanged(from: .hub, to: .wifi)
        XCTAssertTrue(model.progress.isEmpty)
        ble.active = true
        model.setWifi(ssid: "Synthetic", password: "password")
        await idle(model)
        XCTAssertNil(model.message)
        XCTAssertFalse(model.progress.isEmpty, "Wi-Fi success must not be discarded on completion")
        model.navigationChanged(from: .wifi, to: .wifi)
        XCTAssertFalse(model.progress.isEmpty, "Re-rendering the same leaf retains its result")
        model.navigationChanged(from: .wifi, to: .access)
        XCTAssertTrue(model.progress.isEmpty)
        ble.rejectProof = true
        model.connectNearby()
        await idle(model)
        let failure = model.message
        XCTAssertNotNil(failure)
        model.navigationChanged(from: .access, to: .recovery)
        XCTAssertEqual(model.message, failure)
        registry.hold = true
        model.recover()
        let deadline = ContinuousClock.now + .seconds(3)
        while registry.pending == nil && ContinuousClock.now < deadline { await Task.yield() }
        XCTAssertNotNil(registry.pending)
        let liveProgress = model.progress
        model.navigationChanged(from: .recovery, to: .hub)
        XCTAssertTrue(model.busy)
        XCTAssertEqual(model.progress, liveProgress)
        model.pause()
        registry.release()
        await Task { @MainActor in }.value
    }

    func testCubePageAccessibilityLayoutAndSyntheticStates() async throws {
        let registry = FakeCubeRegistry()
        let store = MemoryCubeStore()
        let ble = FakeCubeBLE(deviceId: id)
        let model = CubeViewModel(registry: registry, store: store, ble: ble)
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        var window: UIWindow?
        defer { window?.isHidden = true; window?.rootViewController = nil }
        var previousPage: CubePage?
        func show(_ page: CubePage, _ name: String, large: Bool = false,
                  rendered: [String], expected: () -> Bool) async throws {
            window?.isHidden = true
            window?.rootViewController = nil
            model.navigationChanged(from: previousPage, to: page)
            previousPage = page
            // Exercise the production entry boundary before choosing a stable capture state.
            // The mounted page's task calls it again; its selection-scoped latch must be a no-op.
            if page == .hub { model.enterHub(); await idle(model) }
            let listCalls = registry.listCalls
            let discoveryCalls = ble.discoveryCalls
            let screen = CubeScreen(model: model, page: page, fixturePairingCode: secret,
                fixtureSSID: "Synthetic network", fixturePassword: "synthetic-password")
            let current = mount(screen, in: scene, large: large)
            window = current
            // Do not mistake the previous fixture's idle/loaded state for this mount's .task.
            try await waitUntil {
                (page != .devices || registry.listCalls > listCalls) &&
                (page != .manual || ble.discoveryCalls > discoveryCalls) &&
                !model.busy && model.registryState != .loading && expected()
            }
            XCTAssertTrue(expected(), name)
            _ = try await captureRendered(current, name: name, containing: rendered,
                excluding: page == .devices && model.registryState == .loaded ? ["Loading your Cubes", "Cubes not checked", "load Cubes"] : [])
            if large, let scroll = scrollView(in: current.rootViewController!.view) {
                scroll.setContentOffset(CGPoint(x: 0, y: max(0, scroll.contentSize.height + scroll.adjustedContentInset.bottom - scroll.bounds.height)), animated: false)
                if page == .devices, model.deviceIds.count > 1 {
                    // Full-width recovery summary must remain readable as words at 320pt/accessibility5.
                    _ = try await captureRendered(current, name: name + "-bottom",
                        containing: ["Saved phone access", "ownership not checked"])
                } else {
                    try await DisplayFrameWaiter.next()
                    capture(current, name: name + "-bottom")
                }
            }
        }
        try await show(.devices, "cube-confirmed-empty", rendered: ["Set up Cube"]) { model.confirmedEmpty }
        try await show(.devices, "cube-confirmed-empty-accessibility5", large: true,
            rendered: ["Scan Cube"]) { model.confirmedEmpty }
        try await show(.manual, "cube-manual-accessibility5", large: true,
            rendered: ["Pairing info"]) { model.pairingLocators == [CubeSetupPayload.locator(self.id)] }
        registry.offline = true
        try await show(.devices, "cube-registry-error", rendered: ["load Cubes"]) {
            if case .failed = model.registryState { return true }; return false
        }
        registry.offline = false
        registry.listed = [record(status: "active")]
        store.secrets[id] = secret
        try await show(.devices, "cube-one-device-list", rendered: ["Paired", "1234"]) {
            model.registryState == .loaded && model.deviceIds == [self.id]
        }
        let localOnly = "00000000-1234-4234-8234-123456789abc"
        store.secrets[localOnly] = secret
        try await show(.devices, "cube-owned-and-local-list", rendered: ["1234", "0000"]) {
            model.registryState == .loaded && model.deviceIds.count == 2
        }
        let pendingId = "11111111-1234-4234-8234-123456789abc"
        registry.listed.append(CubeRegistryRecord(version: 1, deviceId: pendingId,
            attemptId: pendingId, generation: 1, deviceClass: "cube", status: "pending",
            expiresAt: 1_900_000_000_000, managerSecret: nil))
        try await show(.devices, "cube-many-and-pending-list-accessibility5", large: true,
            rendered: ["1234", "Paired"]) { model.registryState == .loaded && model.deviceIds.count == 3 }
        model.select(id)
        try await show(.hub, "cube-hub-connection-failed", rendered: ["Not connected nearby", "Retry connection"]) { model.status == nil && model.message != nil }
        ble.installed = true
        ble.active = true
        model.connectNearby()
        await idle(model)
        for page: CubePage in [.hub, .wifi, .details, .access, .recovery] {
            let text = page == .hub ? "Connected at last check" : page.title
            try await show(page, "cube-\(page)-checked", rendered: [text]) { model.status?.ready == true }
            try await show(page, "cube-\(page)-accessibility5", large: true, rendered: [text]) { model.status?.ready == true }
            if page != .hub { XCTAssertTrue(model.progress.isEmpty, "Completed hub feedback must not leak to another leaf") }
        }
        ble.onDisconnect?()
        try await show(.hub, "cube-hub-dated-disconnected", rendered: ["Not connected nearby"]) {
            !model.nearby && model.checkedAt != nil
        }
        ble.rejectProof = true
        model.connectNearby()
        await idle(model)
        try await show(.wifi, "cube-wifi-authentication-error-accessibility5", large: true,
            rendered: ["Wi-Fi"]) { model.message != nil }
        ble.rejectProof = false
        registry.recordStatus = "disabled"
        model.disable()
        await idle(model)
        try await show(.hub, "cube-hub-disabled", rendered: ["Agent access disabled"]) {
            model.selectedRecord?.status == "disabled" && model.status == nil
        }
        try await show(.access, "cube-access-disabled", rendered: ["Re-enable"]) {
            model.selectedRecord?.status == "disabled" && model.progress.isEmpty
        }

        registry.hold = true
        defer { model.pause(); registry.release() }
        model.reenroll()
        let deadline = ContinuousClock.now + .seconds(3)
        while registry.pending == nil && ContinuousClock.now < deadline { await Task.yield() }
        XCTAssertNotNil(registry.pending)
        window?.isHidden = true
        window?.rootViewController = nil
        let progressWindow = mount(CubeScreen(model: model, page: .hub, onBack: {}), in: scene)
        window = progressWindow
        model.navigationChanged(from: previousPage, to: .hub)
        XCTAssertTrue(model.busy)
        XCTAssertEqual(model.progress, "Reserving Cube with your account…")
        XCTAssertTrue(model.needsSetup)
        _ = try await captureRendered(progressWindow, name: "cube-enrollment-progress",
            containing: ["Connecting", "Reserving Cube", "Pause", "Connect Wi-Fi"], excluding: ["Battery", "Device details"])
        model.pause()
        registry.release()
        await Task { @MainActor in }.value
        XCTAssertTrue(model.needsSetup)
        XCTAssertNotNil(model.selectedAttempt)
        _ = try await captureRendered(progressWindow, name: "cube-enrollment-paused",
            containing: ["Finish setup", "Setup paused", "Resume saved setup", "Connect Wi-Fi"], excluding: ["Battery"])
        ble.rejectProof = true
        model.resumeSetup()
        await idle(model)
        XCTAssertNotNil(model.message)
        XCTAssertTrue(model.needsSetup)
        _ = try await captureRendered(progressWindow, name: "cube-enrollment-error",
            containing: ["Finish setup", "authenticate", "Resume saved setup", "Connect Wi-Fi"], excluding: ["Battery"])
        model.navigationChanged(from: .hub, to: .devices)
        model.select(id)
        model.navigationChanged(from: .devices, to: .hub)
        ble.rejectProof = false
        model.enterHub()
        await idle(model)
        XCTAssertNotNil(model.selectedAttempt, "Leaving and reopening must retain interrupted setup")
        XCTAssertTrue(model.needsSetup)
        _ = try await captureRendered(progressWindow, name: "cube-enrollment-interrupted",
            containing: ["Finish setup", "Resume saved setup", "Connect Wi-Fi"], excluding: ["Battery", "Setup paused"])

        // Replacement phone: pending registry ownership without a local saved attempt.
        let pendingRegistry = FakeCubeRegistry()
        pendingRegistry.listed = [record(status: "pending")]
        let pending = CubeViewModel(registry: pendingRegistry, store: MemoryCubeStore(), ble: FakeCubeBLE(deviceId: id))
        pending.refreshRegistry()
        await idle(pending)
        pending.select(id)
        pending.navigationChanged(from: .devices, to: .hub)
        pending.enterHub()
        await idle(pending)
        XCTAssertTrue(pending.needsPhoneAccess)
        XCTAssertTrue(pending.needsSetup)
        XCTAssertNil(pending.selectedAttempt)
        window?.isHidden = true
        window?.rootViewController = nil
        let pendingWindow = mount(CubeScreen(model: pending, page: .hub, onBack: {}), in: scene)
        window = pendingWindow
        _ = try await captureRendered(pendingWindow, name: "cube-pending-replacement-phone",
            containing: ["Finish setup", "Connect Wi-Fi", "Restore phone access"], excluding: ["Battery", "Resume saved setup"])

    }

    func testHeldRegistryLoadingFixtureDoesNotEnterHardwareOperation() async throws {
        let registry = FakeCubeRegistry()
        registry.holdList = true
        let model = CubeViewModel(registry: registry, store: MemoryCubeStore(), ble: FakeCubeBLE(deviceId: id))
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = mount(CubeScreen(model: model, onBack: {}), in: scene)
        defer { model.pause(); registry.releaseList(); window.isHidden = true; window.rootViewController = nil }
        await waitForList(registry)
        let held = try await captureRendered(window, name: "cube-entry-held-registry", containing: ["Loading your Cubes"], excluding: ["Scan Cube", "Already paired?", "Set up Cube", "Pause"])
        XCTAssertFalse(model.busy, "Registry cannot show hardware spinner or Pause above entry")
        XCTAssertTrue(model.progress.isEmpty)
        registry.releaseList()
        await idle(model)
        XCTAssertTrue(model.confirmedEmpty)
        let released = try await captureRendered(window, name: "cube-entry-released-empty", containing: ["Set up Cube", "Scan Cube"])
        // Unknown inventory has no setup actions; only the native header persists.
        let before = try XCTUnwrap(held.first { $0.text == "Cubes" }?.bounds)
        let after = try XCTUnwrap(released.first { $0.text == "Cubes" }?.bounds)
        XCTAssertEqual(before.midY, after.midY, accuracy: 1 / window.bounds.height)
        XCTAssertEqual(before.midX, after.midX, accuracy: 1 / window.bounds.width)

        registry.holdList = true
        model.refreshRegistry()
        await waitForList(registry)
        XCTAssertTrue(model.confirmedEmpty, "Warm refresh retains the previously confirmed empty presentation")
        let warm = try await captureRendered(window, name: "cube-empty-warm-refresh",
            containing: ["Set up Cube", "Scan Cube", "Already paired?"], excluding: ["Loading your Cubes"])
        for label in ["Cubes", "Scan Cube", "Already paired?"] {
            let before = try XCTUnwrap(released.first { $0.text == label }?.bounds)
            let after = try XCTUnwrap(warm.first { $0.text == label }?.bounds)
            XCTAssertEqual(before.midY, after.midY, accuracy: 1 / window.bounds.height, label)
            XCTAssertEqual(before.midX, after.midX, accuracy: 1 / window.bounds.width, label)
        }
    }

    func testColdLocalAndRemoteInventoryPublishesOnceWithoutReplacingRootGeometry() async throws {
        let registry = FakeCubeRegistry()
        registry.holdList = true
        registry.listed = [record(status: "active")]
        let localOnly = "00000000-1234-4234-8234-123456789abc"
        let store = MemoryCubeStore()
        store.secrets[id] = secret
        store.secrets[localOnly] = secret
        let model = CubeViewModel(registry: registry, store: store, ble: FakeCubeBLE(deviceId: id))
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = mount(CubeScreen(model: model, onBack: {}), in: scene)
        defer { model.pause(); registry.releaseList(); window.isHidden = true; window.rootViewController = nil }
        await waitForList(registry)
        XCTAssertTrue(model.deviceIds.isEmpty, "Cold local rows must not flash before remote labels/order are known")
        let held = try await captureRendered(window, name: "cube-cold-local-remote-loading",
            containing: ["Loading your Cubes"], excluding: ["1234", "0000", "Scan Cube", "Already paired?", "Add Cube"])
        let rootScroll = try XCTUnwrap(scrollView(in: window.rootViewController!.view))
        registry.releaseList()
        await idle(model)
        XCTAssertEqual(model.deviceIds, [id, localOnly])
        let loaded = try await captureRendered(window, name: "cube-cold-local-remote-loaded",
            containing: ["Paired", "Saved phone access", "1234", "0000", "Add Cube"], excluding: ["Loading your Cubes", "Scan Cube"])
        XCTAssertTrue(rootScroll === scrollView(in: window.rootViewController!.view), "Cold completion retains root scroll/header composition")
        let coldHeader = try XCTUnwrap(held.first { $0.text == "Cubes" }?.bounds)
        let loadedHeader = try XCTUnwrap(loaded.first { $0.text == "Cubes" }?.bounds)
        XCTAssertEqual(coldHeader.midY, loadedHeader.midY, accuracy: 1 / window.bounds.height)
        XCTAssertEqual(coldHeader.midX, loadedHeader.midX, accuracy: 1 / window.bounds.width)

        // A warm refresh retains the settled rows, even when local inventory has changed.
        store.secrets["ffffffff-1234-4234-8234-123456789abc"] = secret
        registry.holdList = true
        model.refreshRegistry()
        await waitForList(registry)
        XCTAssertEqual(model.deviceIds, [id, localOnly])
        let refreshing = try await captureRendered(window, name: "cube-warm-local-remote-refresh",
            containing: ["Paired", "1234", "0000", "Add Cube"], excluding: ["ffff", "Loading your Cubes", "Scan Cube"])
        for label in ["Cubes", "1234", "0000", "Add Cube"] {
            let before = try XCTUnwrap(loaded.first { $0.text == label }?.bounds)
            let after = try XCTUnwrap(refreshing.first { $0.text == label }?.bounds)
            XCTAssertEqual(before.midY, after.midY, accuracy: 1 / window.bounds.height, label)
            XCTAssertEqual(before.midX, after.midX, accuracy: 1 / window.bounds.width, label)
        }
        registry.offline = true
        registry.releaseList()
        await idle(model)
        XCTAssertEqual(model.deviceIds, [id, localOnly, "ffffffff-1234-4234-8234-123456789abc"])
        guard case .failed = model.registryState else { return XCTFail("Failed refresh must retain cached and local recovery rows") }
    }

    func testDetailsUsesCompactIdentifierWithoutFooterAtOrdinaryWidth() async throws {
        let model = CubeViewModel(registry: FakeCubeRegistry(), store: MemoryCubeStore(), ble: FakeCubeBLE(deviceId: id))
        model.select(id)
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = mount(CubeScreen(model: model, page: .details, onBack: {}), in: scene)
        defer { window.isHidden = true; window.rootViewController = nil }
        let text = try await captureRendered(window, name: "cube-details-compact-identifier",
            containing: ["Device details", "1234", "Firmware"],
            excluding: [id, "Hardware details reflect", "top buttons", "Firmware updates"])
        let label = try XCTUnwrap(text.first { $0.text == "Device" }?.bounds)
        let identifier = try XCTUnwrap(text.first { $0.text == "1234" }?.bounds)
        XCTAssertEqual(label.midY, identifier.midY, accuracy: max(label.height, identifier.height) / 2,
            "Identifier stays beside its label, not on a second ordinary-width line")
    }

    private func waitUntil(_ condition: () -> Bool) async throws {
        let deadline = ContinuousClock.now + .seconds(5)
        while !condition(), ContinuousClock.now < deadline { try await DisplayFrameWaiter.next() }
        XCTAssertTrue(condition(), "Fixture did not reach its named model state")
        if !condition() { throw CubeFixtureError.stateUnavailable }
    }

    private struct RenderedText {
        let text: String
        let bounds: CGRect
    }

    /// OCR validates the real rendered surface, including SwiftUI's deferred observation/layout.
    /// Native Vision only; no golden pixels, accessibility-private APIs or production test hooks.
    private func captureRendered(_ window: UIWindow, name: String, containing expected: [String], excluding excluded: [String] = []) async throws -> [RenderedText] {
        let deadline = ContinuousClock.now + .seconds(5)
        // Text can update before the asynchronous Canvas material has finished transitioning.
        // Keep animations real; require matching content across the canonical material interval.
        let settling = Duration.seconds(DesignCanvasTransition.material.duration(reduceMotion: false) ?? 0)
        var matchingSince: ContinuousClock.Instant?
        repeat {
            try await DisplayFrameWaiter.next()
            window.rootViewController?.view.setNeedsLayout()
            window.rootViewController?.view.layoutIfNeeded()
            let capturedAt = ContinuousClock.now
            let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
                window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
            }
            let request = VNRecognizeTextRequest()
            request.recognitionLevel = .accurate
            request.recognitionLanguages = ["en-US"]
            try VNImageRequestHandler(cgImage: XCTUnwrap(image.cgImage)).perform([request])
            let text = (request.results ?? []).compactMap { observation -> RenderedText? in
                guard let candidate = observation.topCandidates(1).first else { return nil }
                return RenderedText(text: candidate.string, bounds: observation.boundingBox)
            }
            let joined = text.map(\.text).joined(separator: " ").lowercased()
            if expected.allSatisfy({ joined.contains($0.lowercased()) }) && !excluded.contains(where: { joined.contains($0.lowercased()) }) {
                if matchingSince == nil { matchingSince = capturedAt }
                guard let matchingSince, capturedAt - matchingSince >= settling else { continue }
                let attachment = XCTAttachment(image: image)
                attachment.name = name
                attachment.lifetime = .keepAlways
                add(attachment)
                return text
            } else {
                matchingSince = nil
            }
        } while ContinuousClock.now < deadline
        capture(window, name: name + "-unexpected-render")
        XCTFail("Rendered fixture did not contain expected content: \(name)")
        throw CubeFixtureError.stateUnavailable
    }

    private func record(status: String) -> CubeRegistryRecord {
        CubeRegistryRecord(version: 1, deviceId: id, attemptId: "22345678-1234-4234-8234-123456789abc",
            generation: 1, deviceClass: "cube", status: status, expiresAt: 1_900_000_000_000, managerSecret: nil)
    }

    private func waitForList(_ registry: FakeCubeRegistry) async {
        let deadline = ContinuousClock.now + .seconds(3)
        while registry.pendingList == nil && ContinuousClock.now < deadline { await Task.yield() }
        XCTAssertNotNil(registry.pendingList)
    }

    private func mount(_ screen: CubeScreen, in scene: UIWindowScene, large: Bool = false) -> UIWindow {
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: large ? 320 : 390, height: large ? 667 : 844)
        window.rootViewController = UIHostingController(rootView: NavigationStack {
            screen.environment(\.dynamicTypeSize, large ? .accessibility5 : .large)
                // Standalone hosting controllers do not inherit WindowGroup's scene phase.
                .environment(\.scenePhase, .active)
        })
        window.makeKeyAndVisible()
        return window
    }

    private func scrollView(in view: UIView) -> UIScrollView? {
        if let scroll = view as? UIScrollView, scroll.contentSize.height > 0 { return scroll }
        return view.subviews.lazy.compactMap { self.scrollView(in: $0) }.first
    }

    @discardableResult
    private func capture(_ window: UIWindow, name: String) -> UIImage {
        window.rootViewController?.view.setNeedsLayout()
        window.rootViewController?.view.layoutIfNeeded()
        window.layoutIfNeeded()
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        let attachment = XCTAttachment(image: image)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        return image
    }

    private func payload() -> CubeSetupPayload {
        CubeSetupPayload(version: 1, deviceId: id, name: "SC_123456781234", transport: "ble", security: 2,
            username: "cube-bootstrap", pop: secret)
    }

    private func idle(_ model: CubeViewModel) async {
        let deadline = ContinuousClock.now + .seconds(3)
        while (model.busy || model.registryState == .loading) && ContinuousClock.now < deadline { await Task.yield() }
        XCTAssertFalse(model.busy)
        XCTAssertNotEqual(model.registryState, .loading)
    }
}

private final class MemoryCubeStore: CubeStoring {
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

@MainActor private final class FakeCubeRegistry: CubeRegistryServing {
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

@MainActor private final class FakeCubeBLE: CubeBLETransport {
    var onDisconnect: (() -> Void)?
    let deviceId: String
    var statusDeviceId: String?
    var installed = false
    var active = false
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
    func discover() async throws -> [String] { discoveryCalls += 1; return [CubeSetupPayload.locator(deviceId)] }
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
        try JSONSerialization.data(withJSONObject: ["version": 1, "ok": true, "deviceId": statusDeviceId ?? deviceId,
            "attemptId": attemptId, "generation": generation, "phase": active ? "active" : installed ? "pending" : "bootstrap",
            "wifiConnected": active || !wifiSSID.isEmpty, "wifiState": active || !wifiSSID.isEmpty ? "connected" : "offline", "ssid": wifiSSID,
            "gatewayConnected": active, "accountAttention": false, "lastError": "", "firmware": "test",
            "batteryPercent": 50, "charging": false])
    }
    func releaseStatus() { pendingStatus?.resume(); pendingStatus = nil }
    func cancel() { cancelCount += 1 }
}

private final class CubeHTTPFixture: URLProtocol {
    static var respond: ((URLRequest) -> (Int, [String: String], Data))?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        guard let respond = Self.respond else { return }
        let (status, headers, body) = respond(request)
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status,
            httpVersion: "HTTP/1.1", headerFields: headers)!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

private enum CubeFixtureError: Error { case stateUnavailable }
