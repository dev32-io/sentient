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
    func testResumeControllerExposesUnavailableAndActivatesOnlyAuthorizedSession() async {
        let controller = NotificationResumeController()
        let unavailable = NotificationDestination(sessionId: "missing")!
        controller.resume(unavailable, accountFence: "account-a", validate: { _ in .unavailable }, activate: { _ in
            XCTFail("unavailable destination activated")
        })
        await Task.yield()
        XCTAssertEqual(controller.state, .unavailable(unavailable))

        let available = NotificationDestination(sessionId: "available")!
        var activated: String?
        controller.resume(available, accountFence: "account-a", validate: { _ in .authorized }, activate: { activated = $0 })
        await Task.yield()
        XCTAssertEqual(activated, "available")
        XCTAssertEqual(controller.state, .idle)
    }

    @MainActor
    func testResumeControllerFencesSuspendedValidationAcrossAccountChange() async {
        let started = expectation(description: "validation started")
        let validation = SuspendedNotificationValidation(started: started)
        let controller = NotificationResumeController()
        var activated: String?
        controller.resume(
            NotificationDestination(sessionId: "old-session")!,
            accountFence: "account-old",
            validate: { _ in await validation.wait() },
            activate: { activated = $0 }
        )
        await fulfillment(of: [started])
        controller.setAccountFence("account-new")
        validation.complete(.authorized)
        await Task.yield()
        XCTAssertNil(activated)
        XCTAssertEqual(controller.state, .idle)
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
    func testSettingsUnlinkThenExplicitEnableRegistersExactlyOnceWithoutReplacingLifecycle() async {
        let unlinkStarted = expectation(description: "settings unlink started")
        let registered = expectation(description: "fresh binding registered")
        let lifecycle = FakeNativePushLifecycle(unlinkStarted: unlinkStarted, registrationCompleted: registered)
        let registrar = FakeRegistrar()
        let coordinator = NativePushCoordinator(
            permissions: FakePermission(status: .authorized, granted: true),
            registrar: registrar,
            lifecycleFactory: { _ in lifecycle }
        )
        coordinator.configure(account: account("account-a"))
        coordinator.unlinkFromSettings()
        await fulfillment(of: [unlinkStarted])
        lifecycle.completeUnlink(.success)
        await Task.yield()

        await coordinator.enable()
        coordinator.didRegister(deviceToken: Data([0x01, 0x02]))
        await fulfillment(of: [registered])
        XCTAssertEqual(registrar.calls, 1)
        XCTAssertEqual(lifecycle.registerCalls, 1)
        XCTAssertFalse(lifecycle.closed)
        XCTAssertNotNil(coordinator.binding)
    }

    @MainActor
    func testFailedSettingsUnlinkRetryFencesEnableAndLogoutStillTearsDown() async {
        let unlinkStarted = expectation(description: "settings unlink started")
        let retryStarted = expectation(description: "settings retry started")
        let lifecycle = FakeNativePushLifecycle(unlinkStarted: unlinkStarted, retryStarted: retryStarted)
        let coordinator = NativePushCoordinator(
            permissions: FakePermission(status: .authorized, granted: true),
            registrar: FakeRegistrar(),
            lifecycleFactory: { _ in lifecycle }
        )
        coordinator.configure(account: account("account-a"))
        coordinator.unlinkFromSettings()
        await fulfillment(of: [unlinkStarted])
        lifecycle.completeUnlink(.failure)
        await Task.yield()

        await coordinator.enable()
        coordinator.didRegister(deviceToken: Data([0x03]))
        XCTAssertEqual(lifecycle.registerCalls, 0)
        coordinator.retryPendingUnlink()
        await fulfillment(of: [retryStarted])
        coordinator.unlinkForLogout()
        lifecycle.completeRetry(.success)
        await Task.yield()
        XCTAssertTrue(lifecycle.closed)
        XCTAssertEqual(lifecycle.registerCalls, 0)
        XCTAssertNil(coordinator.binding)
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
    func testLogoutThenLoginSerializesUnlinkBeforeInstallingReplacement() async {
        let unlinkStarted = expectation(description: "logout unlink started")
        let replacementInstalled = expectation(description: "replacement installed")
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
        coordinator.unlinkForLogout()
        await fulfillment(of: [unlinkStarted])
        coordinator.configure(account: account("account-new"))
        XCTAssertEqual(old.unlinkCalls, 1)
        XCTAssertEqual(installed, ["account-old"])

        old.completeUnlink(.success)
        await fulfillment(of: [replacementInstalled])
        XCTAssertEqual(old.unlinkCalls, 1)
        XCTAssertEqual(installed, ["account-old", "account-new"])
        XCTAssertTrue(old.closed)
    }

    @MainActor
    func testConfigurationAndLogoutDuringRetryRemainSerializedBehindOldAcknowledgement() async {
        let unlinkStarted = expectation(description: "logout unlink started")
        let retryStarted = expectation(description: "pending unlink retry started")
        let replacementInstalled = expectation(description: "replacement installed")
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
        coordinator.unlinkForLogout()
        await fulfillment(of: [unlinkStarted])
        old.completeUnlink(.failure)
        await Task.yield()

        coordinator.retryPendingUnlink()
        await fulfillment(of: [retryStarted])
        coordinator.configure(account: account("account-new"))
        coordinator.unlinkForLogout() // Local teardown must not start a competing old-account operation.
        XCTAssertEqual(old.unlinkCalls, 1)
        XCTAssertEqual(old.retryCalls, 1)
        XCTAssertFalse(old.closed)
        XCTAssertEqual(installed, ["account-old"])
        XCTAssertNotNil(coordinator.lifecycleWarning)

        old.completeRetry(.success)
        await fulfillment(of: [replacementInstalled])
        XCTAssertEqual(old.unlinkCalls, 1)
        XCTAssertEqual(old.retryCalls, 1)
        XCTAssertTrue(old.closed)
        XCTAssertEqual(installed, ["account-old", "account-new"])
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

@MainActor
private final class SuspendedNotificationValidation {
    private let started: XCTestExpectation
    private var continuation: CheckedContinuation<NotificationSessionValidation, Never>?

    init(started: XCTestExpectation) { self.started = started }
    func wait() async -> NotificationSessionValidation {
        started.fulfill()
        return await withCheckedContinuation { continuation = $0 }
    }
    func complete(_ result: NotificationSessionValidation) {
        continuation?.resume(returning: result)
        continuation = nil
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
    private let registrationCompleted: XCTestExpectation?
    private(set) var closed = false
    private(set) var unlinkCalls = 0
    private(set) var retryCalls = 0
    private(set) var registerCalls = 0

    init(
        unlinkStarted: XCTestExpectation? = nil,
        retryStarted: XCTestExpectation? = nil,
        registrationCompleted: XCTestExpectation? = nil
    ) {
        self.unlinkStarted = unlinkStarted
        self.retryStarted = retryStarted
        self.registrationCompleted = registrationCompleted
    }

    func unlink(ownerFence: String) async throws -> NativePushLifecycleResult {
        unlinkCalls += 1
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
        retryCalls += 1
        retryStarted?.fulfill()
        return await withCheckedContinuation { retryContinuation = $0 }
    }

    func completeRetry(_ result: NativePushLifecycleResult) {
        if case .success = result { state = .unlinked }
        retryContinuation?.resume(returning: result)
        retryContinuation = nil
    }

    func reconcileActivation(ownerFence: String) async throws -> NativePushLifecycleResult { .success }
    func makeRegistration(deviceToken: String, replacing: PushBinding?) -> PushRegistrationRequest {
        PushRegistrationRequest(
            idempotencyKey: "test-registration",
            installationId: "installation",
            platform: "ios",
            apnsDeviceToken: deviceToken,
            replaces: nil
        )
    }
    func register(ownerFence: String, request: PushRegistrationRequest) async throws -> PushBinding? {
        registerCalls += 1
        let value = pushBinding(generation: Int32(registerCalls))
        state = .linked(value, activationPending: false)
        registrationCompleted?.fulfill()
        return value
    }
    func close() { closed = true }
}

private func pushBinding(generation: Int32) -> PushBinding {
    PushBinding(
        bindingId: "binding-\(generation)",
        installationId: "installation",
        platform: "ios",
        generation: generation,
        state: .active,
        replaces: nil,
        preferences: PushPreferences(enabled: true, previewMode: .hidden, revision: 1),
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z"
    )
}
