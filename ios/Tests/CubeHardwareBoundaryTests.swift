@testable import ESPProvision
import Foundation
import XCTest
@testable import SentientApp

final class CubeHardwareBoundaryTests: XCTestCase {
    #if DEBUG
    func testLocalLoginRequiresExplicitApprovedOrigin() throws {
        let raw = #"{"gatewayWsURL":"wss://192.168.1.2:8443/api/v1/ws","userId":"disposable","pin":"1234","allowSelfSigned":true}"#
        var environment = ["CUBE_QA_LOGIN_JSON": raw]
        XCTAssertThrowsError(try CubeLocalLogin.parse(environment: environment))
        environment["CUBE_QA_LOCAL_ORIGIN"] = "https://other.example"
        XCTAssertThrowsError(try CubeLocalLogin.parse(environment: environment))
        environment["CUBE_QA_LOCAL_ORIGIN"] = "https://192.168.1.2:8443"
        XCTAssertEqual(try CubeLocalLogin.parse(environment: environment).userId, "disposable")
        environment["CUBE_QA_LOGIN_JSON"] = raw.replacingOccurrences(of: "wss://", with: "ws://")
        XCTAssertThrowsError(try CubeLocalLogin.parse(environment: environment))
    }
    #endif

    private let secret = CubeSecret.encode(Data(repeating: 7, count: 32))

    func testSetupCodeRejectsDowngradeAndNoncanonicalAuthority() throws {
        let fields: [String: Any] = ["version": 1, "deviceId": "12345678-1234-4234-8234-123456789abc",
            "name": "SC_123456781234", "security": 2, "transport": "ble", "username": "cube-bootstrap", "pop": secret]
        func parse(_ value: [String: Any]) throws -> CubeSetupPayload {
            try CubeSetupPayload.parse(String(decoding: JSONSerialization.data(withJSONObject: value), as: UTF8.self))
        }
        XCTAssertEqual(try parse(fields).pop, secret)
        for (key, value) in [("version", 2 as Any), ("security", 1), ("transport", "softap"),
                             ("username", "cube-manager"), ("pop", secret + "="),
                             ("deviceId", "not-a-uuid"), ("name", "SC_other"), ("extra", true)] {
            var invalid = fields
            invalid[key] = value
            XCTAssertThrowsError(try parse(invalid), key)
        }
        XCTAssertThrowsError(try CubeSetupPayload.parse(String(repeating: "x", count: 513)))
    }

    func testBootstrapProofNeverReleasedToDowngradedOrUnpatchedPeer() {
        let delegate = CubeBLEProof(secret: secret, username: "cube-bootstrap")
        let device = ESPDevice(name: "test", security: .secure2, transport: .ble)
        for version in [0, 1, 2, 3] {
            for patch in [0, 1, 2] {
                device.versionInfo = ["prov": ["sec_ver": version, "sec_patch_ver": patch]]
                let accepted = version == 2 && patch == 1
                delegate.getProofOfPossesion(forDevice: device) { value in
                    XCTAssertEqual(value, accepted ? self.secret : "")
                }
                delegate.getUsername(forDevice: device) { value in
                    XCTAssertEqual(value, accepted ? "cube-bootstrap" : nil)
                }
            }
        }
        XCTAssertFalse(CubeBLEProof.accepts(nil))
        device.versionInfo = ["prov": ["sec_ver": 2, "sec_patch_ver": 1]]
        delegate.invalidate()
        delegate.getProofOfPossesion(forDevice: device) { XCTAssertEqual($0, "") }
        delegate.getUsername(forDevice: device) { XCTAssertNil($0) }
    }

    @MainActor
    func testNativeConnectionFailuresDoNotInventCredentialRejection() async throws {
        let transportError = NSError(domain: "synthetic.transport", code: 1)
        let cases: [(ESPSessionError, CubeHardwareError)] = [
            (.bleFailedToConnect, .unavailable),
            (.versionInfoError(transportError), .unavailable),
            (.sendDataError(transportError), .unavailable),
            (.securityMismatch, .incompatible),
            (.noPOP, .incompatible),
            (.noUsername, .incompatible),
            (.sessionInitError, .secureConnection),
            (.encryptionError, .secureConnection),
        ]
        for (reported, expected) in cases {
            var device: CallbackCubeDevice?
            let session = CubeBLESession { name, completion in
                let found = CallbackCubeDevice(name: name, security: .secure2, transport: .ble)
                device = found
                completion(found, nil)
            }
            let connection = Task { try await session.connect(name: "test", secret: secret, bootstrap: false) }
            let deadline = ContinuousClock.now + .seconds(3)
            while device?.bleConnectionStatusHandler == nil && ContinuousClock.now < deadline { await Task.yield() }
            guard let callback = device?.bleConnectionStatusHandler else {
                session.cancel()
                return XCTFail("Connect did not start")
            }
            callback(.failedToConnect(reported))
            do { try await connection.value; XCTFail("Failed connection succeeded") }
            catch { XCTAssertEqual(error as? CubeHardwareError, expected) }
            XCTAssertNil(device?.delegate, "Failure must retire proof and transport")
        }
    }

    @MainActor
    func testCancelledNativeCallbacksCannotCompleteOrDisconnectReplacement() async throws {
        var devices: [CallbackCubeDevice] = []
        let session = CubeBLESession { name, completion in
            let device = CallbackCubeDevice(name: name, security: .secure2, transport: .ble)
            devices.append(device)
            completion(device, nil)
        }
        let first = Task { try await session.connect(name: "test", secret: secret, bootstrap: true) }
        var deadline = ContinuousClock.now + .seconds(3)
        while devices.first?.bleConnectionStatusHandler == nil && ContinuousClock.now < deadline { await Task.yield() }
        guard devices.first?.bleConnectionStatusHandler != nil else { return XCTFail("Connect did not start") }
        let old = devices[0]
        let lateCallback = try XCTUnwrap(old.bleConnectionStatusHandler)
        session.cancel()
        do { try await first.value; XCTFail("Cancelled connect succeeded") }
        catch { XCTAssertEqual(error as? CubeHardwareError, .cancelled) }
        XCTAssertNil(old.delegate)
        XCTAssertNil(old.bleConnectionStatusHandler)
        let replacement = Task { try await session.connect(name: "test", secret: secret, bootstrap: true) }
        deadline = ContinuousClock.now + .seconds(3)
        while (devices.count < 2 || devices[1].bleConnectionStatusHandler == nil) && ContinuousClock.now < deadline { await Task.yield() }
        guard devices.count == 2, devices[1].bleConnectionStatusHandler != nil else { return XCTFail("Replacement did not start") }
        var disconnects = 0
        session.onDisconnect = { disconnects += 1 }
        lateCallback(.connected)
        lateCallback(.disconnected)
        await Task { @MainActor in }.value
        XCTAssertEqual(disconnects, 0)
        let current = devices[1]
        current.versionInfo = ["prov": ["sec_ver": 2, "sec_patch_ver": 1]]
        current.securityLayer = FrameSpy()
        current.bleConnectionStatusHandler?(.connected)
        try await replacement.value
        XCTAssertNotNil(current.securityLayer)
        session.cancel()
        XCTAssertNil(current.securityLayer)
        XCTAssertNil(current.delegate)
    }

    @MainActor
    func testNativeOwnerDeinitInvalidatesCredentialsWithoutExplicitCancel() async throws {
        let device = CallbackCubeDevice(name: "test", security: .secure2, transport: .ble)
        var owner: CubeBLESession? = CubeBLESession { _, completion in completion(device, nil) }
        weak var releasedOwner = owner
        let connection = Task { [owner] in try await owner?.connect(name: "test", secret: secret, bootstrap: true) }
        let deadline = ContinuousClock.now + .seconds(3)
        while device.bleConnectionStatusHandler == nil && ContinuousClock.now < deadline { await Task.yield() }
        let callback = try XCTUnwrap(device.bleConnectionStatusHandler)
        device.versionInfo = ["prov": ["sec_ver": 2, "sec_patch_ver": 1]]
        device.securityLayer = FrameSpy()
        callback(.connected)
        try await connection.value
        weak var releasedProof = device.delegate as? CubeBLEProof
        owner = nil
        await Task { @MainActor in }.value
        XCTAssertNil(releasedOwner)
        XCTAssertNil(releasedProof)
        XCTAssertNil(device.securityLayer)
        XCTAssertNil(device.delegate)
        XCTAssertNil(device.bleConnectionStatusHandler)
    }

    @MainActor
    func testRepeatedNativeTeardownReleasesSecuritySessionAndTransport() {
        ESPProvisionManager.shared.enableLogs(false)
        for _ in 0..<20 {
            weak var releasedDevice: ESPDevice?
            weak var releasedTransport: ESPBleTransport?
            weak var releasedSecurity: ESPSecurity2?
            weak var releasedSession: ESPSession?
            weak var releasedProof: CubeBLEProof?
            autoreleasepool {
                let device = ESPDevice(name: "test", security: .secure2, transport: .ble,
                    proofOfPossession: secret, username: "cube-bootstrap")
                let transport = ESPBleTransport(scanTimeout: 0, deviceNamePrefix: "test",
                    proofOfPossession: secret, username: "cube-bootstrap")
                let security = ESPSecurity2(username: "cube-bootstrap", password: secret, useCounterFlag: true)
                let proof = CubeBLEProof(secret: secret, username: "cube-bootstrap")
                device.delegate = proof
                device.espBleTransport = transport
                transport.bleStatusDelegate = device
                transport.bleConnectTimer = Timer.scheduledTimer(timeInterval: 60, target: transport,
                    selector: #selector(ESPBleTransport.bleConnectionTimeout), userInfo: nil, repeats: false)
                device.securityLayer = CubeBLEFrames(security)
                device.session = ESPSession(transport: transport, security: security)
                // Reproduce upstream in-flight handshake and connect callback ownership.
                device.bleConnectionStatusHandler = { _ in _ = device.name }
                transport.currentRequestCompletionHandler = { _, _ in _ = device.session }
                releasedDevice = device
                releasedTransport = transport
                releasedSecurity = security
                releasedSession = device.session
                releasedProof = proof
                device.invalidate()
                device.invalidate() // Idempotent even before connect or after cancellation.
                XCTAssertNil(device.proofOfPossession)
                XCTAssertNil(device.username)
                XCTAssertNil(device.delegate)
                XCTAssertNil(device.securityLayer)
                XCTAssertNil(device.session)
                XCTAssertNil(transport.bleStatusDelegate)
                XCTAssertNil(transport.currentRequestCompletionHandler)
                XCTAssertNil(transport.proofOfPossession)
                XCTAssertNil(transport.username)
                XCTAssertNil(transport.centralManager.delegate)
                // Simulate version metadata work queued before logout.
                device.versionInfo = ["prov": ["sec_ver": 2, "sec_patch_ver": 1]]
                device.initialiseSession(sessionPath: nil) { state in
                    guard case .failedToConnect = state else { return XCTFail("Terminal device reopened") }
                }
                XCTAssertNil(device.securityLayer)
            }
            XCTAssertNil(releasedDevice)
            XCTAssertNil(releasedTransport)
            XCTAssertNil(releasedSecurity)
            XCTAssertNil(releasedSession)
            XCTAssertNil(releasedProof)
        }
    }

    func testEncryptedFrameBoundsPrecedeLibraryTagSlicing() {
        let security = FrameSpy()
        let frames = CubeBLEFrames(security)
        for count in [0, 1, 15, 2065] {
            XCTAssertNil(frames.decrypt(data: Data(count: count)))
        }
        XCTAssertEqual(security.decryptCalls, 0)
        XCTAssertNotNil(frames.decrypt(data: Data(count: 16)))
        XCTAssertNotNil(frames.decrypt(data: Data(count: 2064)))
        XCTAssertEqual(security.decryptCalls, 2)
        XCTAssertNotNil(frames.encrypt(data: Data(count: 496)))
        XCTAssertNil(frames.encrypt(data: Data(count: 497)))
        XCTAssertThrowsError(try frames.getNextRequestInSession(data: nil))
    }
}

private final class FrameSpy: ESPCodeable {
    var decryptCalls = 0
    func getNextRequestInSession(data: Data?) throws -> Data? { nil }
    func encrypt(data: Data) -> Data? { data }
    func decrypt(data: Data) -> Data? { decryptCalls += 1; return data }
}

private final class CallbackCubeDevice: ESPDevice {
    override func connect(delegate: ESPDeviceConnectionDelegate? = nil,
                          completionHandler: @escaping (ESPSessionStatus) -> Void) {
        self.delegate = delegate
        bleConnectionStatusHandler = completionHandler
    }
}
