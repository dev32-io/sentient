import Foundation
import Testing
import MobileData
@testable import SentientApp

struct CalendarSessionLifecycleTests {
    @Test func authenticatedIdentityIsStoredIndependentlyOfDisplayName() {
        let suite = "sentient.calendar.identity.tests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        let store = AuthenticatedIdentityStore(defaults: defaults)
        defer { defaults.removePersistentDomain(forName: suite) }

        store.save("server-user-42")
        #expect(store.load() == "server-user-42")
        store.save("  ")
        #expect(store.load() == nil)
    }

    @Test func backendNamespaceUsesExplicitIdentityAndNormalizedBackendOnly() {
        let first = iosCalendarNamespace(
            authenticatedUserId: "  user-a  ",
            gatewayWsUrl: "WSS://Example.COM:443/api/v1/ws"
        )
        let second = iosCalendarNamespace(
            authenticatedUserId: "user-b",
            gatewayWsUrl: "wss://example.com/api/v1/ws"
        )

        #expect(first.accountId == "user-a")
        #expect(first.backendId == "wss|example.com|443|api/v1")
        #expect(second.accountId == "user-b")
        #expect(first.backendId == second.backendId)
        #expect(!first.backendId.contains("token"))
    }

    @Test func databaseOpensInProtectedApplicationSupportAndReopens() {
        let factory = IosCalendarDatabaseDriverFactory()
        let first = factory.create()
        let firstStatus = factory.storageStatus()
        first.close()

        let reopened = factory.create()
        let reopenedStatus = factory.storageStatus()
        reopened.close()

        #expect(firstStatus.inApplicationSupport)
        #expect(firstStatus.excludedFromBackup)
        // The simulator host filesystem does not expose NSFileProtectionKey;
        // the iOS factory still verifies it on real device builds.
        #expect(firstStatus.protectionClass == nil || firstStatus.protectionClass == IOS_CALENDAR_FILE_PROTECTION)
        #expect(reopenedStatus.protectionClass == nil || reopenedStatus.protectionClass == IOS_CALENDAR_FILE_PROTECTION)
        #expect(factory.databasePath().contains("Application Support"))
    }

    @Test func missingAuthenticatedIdentityFailsClosedWithTypedState() async {
        let session = createUserSession(
            gatewayWsUrl: "ws://localhost/api/v1/ws",
            allowSelfSignedDevHost: true,
            authenticatedUserId: "   ",
            capabilities: [],
            devFaultsEnabled: false,
            onLoggedOut: {}
        )
        try? await session.awaitCalendarLifecycle()
        defer { session.close() }

        #expect(!session.calendarAvailability.isAvailable)
        #expect(session.calendarAvailability.unavailableReason == .missingAuthenticatedUserId)
        #expect(session.calendarExperience == nil)
        #expect(session.settings.calendarExperience == nil)
    }

    @Test func credentialBearingBackendFailsClosedWithoutEnteringNamespace() async {
        let session = createUserSession(
            gatewayWsUrl: "wss://user:token@example.com/api/v1/ws",
            allowSelfSignedDevHost: false,
            authenticatedUserId: "user-a",
            capabilities: [],
            devFaultsEnabled: false,
            onLoggedOut: {}
        )
        try? await session.awaitCalendarLifecycle()
        defer { session.close() }

        #expect(!session.calendarAvailability.isAvailable)
        #expect(session.calendarAvailability.unavailableReason == .invalidBackendIdentity)
        #expect(session.calendarNamespace == nil)
        #expect(session.calendarExperience == nil)
    }

    @Test func queryAndFragmentSecretsFailClosedBeforeNamespaceDerivation() async {
        let session = createUserSession(
            gatewayWsUrl: "wss://example.com/api/v1/ws?token=query-secret#fragment-secret",
            allowSelfSignedDevHost: false,
            authenticatedUserId: "user-a",
            capabilities: [],
            devFaultsEnabled: false,
            onLoggedOut: {}
        )
        try? await session.awaitCalendarLifecycle()
        defer { session.close() }

        #expect(!session.calendarAvailability.isAvailable)
        #expect(session.calendarAvailability.unavailableReason == .invalidBackendIdentity)
        #expect(session.calendarNamespace == nil)
        #expect(session.calendarExperience == nil)
    }

    @Test func sessionOwnsOneCalendarExperienceAcrossRouteReadsAndClosesOnDispose() async {
        let session = createUserSession(
            gatewayWsUrl: "ws://localhost/api/v1/ws",
            allowSelfSignedDevHost: true,
            authenticatedUserId: "route-user",
            capabilities: [],
            devFaultsEnabled: false,
            onLoggedOut: {}
        )
        try? await session.awaitCalendarLifecycle()
        defer { session.close() }

        let first = session.calendarExperience
        let second = session.calendarExperience
        #expect(first != nil)
        #expect(first === second)
        #expect(session.calendarNamespace?.accountId == "route-user")
        #expect(session.calendarAvailability.isAvailable)

        session.close()
        try? await session.awaitCalendarLifecycle()
        #expect(first?.isClosed == true)
    }

    @Test func connectivityEdgeOnlyMarksUnavailableToAvailableAsRecovery() {
        var edge = ConnectivityRecoveryEdge()

        #expect(edge.update(available: true).changed == false)
        #expect(edge.update(available: true).changed == false)
        let unavailable = edge.update(available: false)
        #expect(unavailable.changed && !unavailable.recovered)
        #expect(edge.update(available: false).changed == false)
        let recovered = edge.update(available: true)
        #expect(recovered.changed && recovered.recovered)
        #expect(edge.update(available: true).changed == false)
    }

    @Test @MainActor func sessionForwardsOneRecoveryAndFencesCallbacksAfterShutdown() async {
        let monitor = FakeNetworkPathMonitor()
        var recoveries = 0
        let session = UserSession(
            gatewayWsUrl: "ws://localhost/api/v1/ws",
            allowSelfSignedDevHost: true,
            authenticatedUserId: "recovery-user",
            onLoggedOut: {},
            networkMonitorFactory: NetworkPathMonitorFactory { handler in
                monitor.handler = handler
                return monitor
            },
            calendarRecoverySignal: { _ in recoveries += 1 }
        )
        await session.awaitCalendarLifecycle()
        #expect(monitor.starts == 1)

        monitor.emit(recovered: false)
        monitor.emit(recovered: true)
        await Task.yield()
        #expect(recoveries == 1)

        session.shutdown()
        await session.awaitCalendarLifecycle()
        #expect(monitor.cancels == 1)
        monitor.emit(recovered: true)
        await Task.yield()
        #expect(recoveries == 1)
    }

    @Test @MainActor func swiftUserSessionRetainsCalendarAboveRouteLifetime() async {
        let session = UserSession(
            gatewayWsUrl: "ws://localhost/api/v1/ws",
            allowSelfSignedDevHost: true,
            authenticatedUserId: "swift-user",
            onLoggedOut: {}
        )
        await session.awaitCalendarLifecycle()
        #expect(session.calendarNamespace?.accountId == "swift-user")
        let experience = session.calendarExperience
        #expect(experience != nil)
        session.shutdown()
        await session.awaitCalendarLifecycle()
        #expect(experience?.isClosed == true)
    }

    @Test func successorSessionCannotReadPredecessorNamespace() async {
        let first = createUserSession(
            gatewayWsUrl: "ws://localhost/api/v1/ws",
            allowSelfSignedDevHost: true,
            authenticatedUserId: "user-a",
            capabilities: [],
            devFaultsEnabled: false,
            onLoggedOut: {}
        )
        try? await first.awaitCalendarLifecycle()
        let firstNamespace = first.calendarNamespace
        first.close()
        try? await first.awaitCalendarLifecycle()

        let second = createUserSession(
            gatewayWsUrl: "ws://localhost/api/v1/ws",
            allowSelfSignedDevHost: true,
            authenticatedUserId: "user-b",
            capabilities: [],
            devFaultsEnabled: false,
            onLoggedOut: {}
        )
        try? await second.awaitCalendarLifecycle()

        #expect(firstNamespace?.accountId == "user-a")
        #expect(second.calendarNamespace?.accountId == "user-b")
        #expect(second.calendarNamespace?.accountId != firstNamespace?.accountId)
        #expect(second.calendarExperience?.isClosed == false)
        second.close()
        try? await second.awaitCalendarLifecycle()
    }
}

private final class FakeNetworkPathMonitor: NetworkPathMonitoring, @unchecked Sendable {
    var handler: (@Sendable (Bool) -> Void)?
    private(set) var starts = 0
    private(set) var cancels = 0

    func start() { starts += 1 }
    func cancel() { cancels += 1 }
    func emit(recovered: Bool) { handler?(recovered) }
}
