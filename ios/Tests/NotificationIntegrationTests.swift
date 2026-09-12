import XCTest
import UserNotifications
import MobileData
@testable import SentientApp

final class NotificationIntegrationTests: XCTestCase {
    func testDestinationParserAcceptsOnlySupportedSessionTargets() {
        XCTAssertEqual(NotificationDestination(sessionId: "session-123")?.sessionId, "session-123")
        XCTAssertEqual(NotificationDestination(url: URL(string: "sentient://session/session-123")!)?.sessionId, "session-123")
        XCTAssertNil(NotificationDestination(url: URL(string: "https://gateway.test/session/session-123")!))
        XCTAssertNil(NotificationDestination(url: URL(string: "sentient://session/a/b")!))
        XCTAssertNil(NotificationDestination(userInfo: ["gatewayUrl": "https://attacker.test", "sessionId": "../admin"]))
    }

    @MainActor
    func testPendingDestinationSurvivesLoginBoundaryAndIsConsumedOnce() {
        let pending = PendingNotificationNavigation()
        pending.receive(NotificationDestination(sessionId: "session-cold")!)
        XCTAssertEqual(pending.destination?.sessionId, "session-cold")
        XCTAssertEqual(pending.take()?.sessionId, "session-cold")
        XCTAssertNil(pending.take())
    }

    func testDestinationRequiresCurrentAccountSessionMembership() {
        let destination = NotificationDestination(sessionId: "session-a")!
        XCTAssertTrue(canResumeNotificationDestination(destination, sessionIds: ["session-a", "session-b"]))
        XCTAssertFalse(canResumeNotificationDestination(destination, sessionIds: ["replacement-account-session"]))
    }

    @MainActor
    func testLogoutClearsStaleAccountTargetImmediately() {
        let coordinator = NativePushCoordinator(permissions: FakePermission(status: .denied, granted: false))
        coordinator.navigation.receive(NotificationDestination(sessionId: "old-account-session")!)
        coordinator.unlinkForLogout()
        XCTAssertNil(coordinator.navigation.destination)
    }

    @MainActor
    func testRefreshingAuthorizedPermissionDoesNotReenableUnlinkedPush() async {
        let registrar = FakeRegistrar()
        let coordinator = NativePushCoordinator(
            permissions: FakePermission(status: .authorized, granted: true),
            registrar: registrar
        )
        await coordinator.refreshPermission()
        XCTAssertEqual(coordinator.permission, .authorized)
        XCTAssertEqual(registrar.calls, 0)
        XCTAssertFalse(coordinator.registrationPending)
    }

    func testAuthorizedUnboundDeviceIsOfferedExplicitReenable() {
        XCTAssertTrue(canOfferPushEnable(permission: .authorized, hasBinding: false))
        XCTAssertTrue(canOfferPushEnable(permission: .provisional, hasBinding: false))
        XCTAssertFalse(canOfferPushEnable(permission: .authorized, hasBinding: true))
        XCTAssertFalse(canOfferPushEnable(permission: .denied, hasBinding: false))
    }

    @MainActor
    func testPermissionGrantRegistersWithAPNsAndTokenCallbackIsObservable() async {
        let registrar = FakeRegistrar()
        let coordinator = NativePushCoordinator(
            permissions: FakePermission(status: .notDetermined, granted: true),
            registrar: registrar
        )
        await coordinator.enable()
        XCTAssertEqual(registrar.calls, 1)
        XCTAssertTrue(coordinator.registrationPending)
        coordinator.didRegister(deviceToken: Data([0x01, 0xab]))
        XCTAssertTrue(coordinator.tokenAvailable)
    }

    @MainActor
    func testDeniedPermissionAndRegistrationFailureRemainAccurate() async {
        let permissions = FakePermission(status: .denied, granted: false)
        let coordinator = NativePushCoordinator(permissions: permissions)
        await coordinator.refreshPermission()
        XCTAssertEqual(coordinator.permission, .denied)
        await coordinator.enable()
        XCTAssertEqual(coordinator.permission, .denied)
        coordinator.didFailRegistration()
        XCTAssertEqual(coordinator.permission, .error)
        XCTAssertFalse(coordinator.tokenAvailable)
        XCTAssertFalse(coordinator.registrationPending)
    }

    @MainActor
    func testAccountReplacementWaitsForExactOldLifecycleAcknowledgement() async {
        let unlinkStarted = expectation(description: "old binding disable started")
        let replacementInstalled = expectation(description: "replacement lifecycle installed")
        let old = FakeNativePushLifecycle(unlinkStarted: unlinkStarted)
        let replacement = FakeNativePushLifecycle()
        var installed: [String] = []
        let coordinator = NativePushCoordinator(
            permissions: FakePermission(status: .denied, granted: false),
            lifecycleFactory: { configuration in
                installed.append(configuration.fence)
                if configuration.fence == "account-new" { replacementInstalled.fulfill(); return replacement }
                return old
            }
        )

        coordinator.configure(account: account("account-old"))
        coordinator.configure(account: account("account-new"))
        await fulfillment(of: [unlinkStarted])
        XCTAssertEqual(installed, ["account-old"])
        XCTAssertNotNil(coordinator.lifecycleWarning)

        old.completeUnlink(.success)
        await fulfillment(of: [replacementInstalled])
        XCTAssertEqual(installed, ["account-old", "account-new"])
        XCTAssertTrue(old.closed)
    }

    @MainActor
    func testStaleOldBindingAcknowledgementKeepsReplacementFencedUntilRetrySucceeds() async {
        let unlinkStarted = expectation(description: "old unlink attempted")
        let retryStarted = expectation(description: "old unlink retried")
        let replacementInstalled = expectation(description: "replacement installed after retry")
        let old = FakeNativePushLifecycle(unlinkStarted: unlinkStarted, retryStarted: retryStarted)
        let replacement = FakeNativePushLifecycle()
        var installed: [String] = []
        let coordinator = NativePushCoordinator(
            permissions: FakePermission(status: .denied, granted: false),
            lifecycleFactory: { configuration in
                installed.append(configuration.fence)
                if configuration.fence == "account-new" { replacementInstalled.fulfill(); return replacement }
                return old
            }
        )

        coordinator.configure(account: account("account-old"))
        coordinator.configure(account: account("account-new"))
        await fulfillment(of: [unlinkStarted])
        old.completeUnlink(.failure) // Models the shared coordinator rejecting a stale acknowledgement.
        await Task.yield()
        XCTAssertEqual(installed, ["account-old"])
        XCTAssertNotNil(coordinator.lifecycleWarning)

        coordinator.retryPendingUnlink()
        await fulfillment(of: [retryStarted])
        old.completeRetry(.success)
        await fulfillment(of: [replacementInstalled])
        XCTAssertEqual(installed, ["account-old", "account-new"])
    }
}

private func account(_ fence: String) -> NativePushAccountConfiguration {
    NativePushAccountConfiguration(fence: fence, gatewayWsUrl: "wss://gateway.test", allowSelfSignedDevHost: false, token: { "" })
}

private final class FakeRegistrar: RemoteNotificationRegistering {
    private(set) var calls = 0
    func register() { calls += 1 }
}

private final class FakePermission: NotificationPermissionProviding {
    let status: UNAuthorizationStatus
    let granted: Bool
    init(status: UNAuthorizationStatus, granted: Bool) { self.status = status; self.granted = granted }
    func authorizationStatus() async -> UNAuthorizationStatus { status }
    func requestAuthorization() async throws -> Bool { granted }
}

@MainActor
private final class FakeNativePushLifecycle: NativePushLifecycleClient {
    var state: NativePushLifecycleSnapshot = .unlinked
    private let unlinkStarted: XCTestExpectation?
    private let retryStarted: XCTestExpectation?
    private var unlinkContinuation: CheckedContinuation<NativePushLifecycleResult, Never>?
    private var retryContinuation: CheckedContinuation<NativePushLifecycleResult, Never>?
    private(set) var closed = false

    init(unlinkStarted: XCTestExpectation? = nil, retryStarted: XCTestExpectation? = nil) {
        self.unlinkStarted = unlinkStarted
        self.retryStarted = retryStarted
    }

    func unlink(ownerFence: String) async throws -> NativePushLifecycleResult {
        state = .pendingUnlink
        unlinkStarted?.fulfill()
        return await withCheckedContinuation { unlinkContinuation = $0 }
    }

    func completeUnlink(_ result: NativePushLifecycleResult) {
        if case .success = result { state = .unlinked }
        unlinkContinuation?.resume(returning: result)
        unlinkContinuation = nil
    }

    func retryPendingUnlink() async throws -> NativePushLifecycleResult {
        retryStarted?.fulfill()
        return await withCheckedContinuation { retryContinuation = $0 }
    }

    func completeRetry(_ result: NativePushLifecycleResult) {
        if case .success = result { state = .unlinked }
        retryContinuation?.resume(returning: result)
        retryContinuation = nil
    }

    func reconcileActivation(ownerFence: String) async throws -> NativePushLifecycleResult { .success }
    func makeRegistration(deviceToken: String, replacing: PushBinding?) -> PushRegistrationRequest { fatalError("unused") }
    func register(ownerFence: String, request: PushRegistrationRequest) async throws -> PushBinding? { nil }
    func close() { closed = true }
}
