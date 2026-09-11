import XCTest
import UserNotifications
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
