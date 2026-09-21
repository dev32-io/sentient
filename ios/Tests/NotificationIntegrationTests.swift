import Combine
import XCTest
import UserNotifications
import MobileData
@testable import SentientApp

final class NotificationIntegrationTests: XCTestCase {
    func testAcknowledgedSameSessionReopenRecreatesChatWithoutAnotherActivation() {
        var route = ChatRouteSelection()
        route.select("B", acknowledged: true)
        let firstB = route
        route.select("B", acknowledged: true)
        XCTAssertNotEqual(firstB, route, "SwiftUI StateObject must get a new route identity")
        XCTAssertEqual(route.sessionId, "B")
        XCTAssertTrue(route.acknowledged, "VM must bind existing SDK proof, not activate again")
        route.select(nil)
        let firstDraft = route
        route.select(nil)
        XCTAssertNotEqual(firstDraft, route)
        XCTAssertFalse(route.acknowledged)

        route.selectNewDraft("draft-one")
        let localDraft = route
        route.selectNewDraft("draft-two")
        XCTAssertNotEqual(localDraft, route)
        XCTAssertEqual(route.draftId, "draft-two")
        XCTAssertNil(route.sessionId)
    }

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
        pending.bindPending(to: "backend|account-a")
        XCTAssertEqual(pending.take(accountFence: "backend|account-a")?.sessionId, "session-cold")
        XCTAssertNil(pending.take(accountFence: "backend|account-a"))
    }

    @MainActor
    func testPendingDestinationDropsOnDifferentAccountAndLatestIntentWins() {
        let pending = PendingNotificationNavigation()
        pending.receive(NotificationDestination(sessionId: "old")!)
        pending.bindPending(to: "backend|account-a")
        pending.receive(NotificationDestination(sessionId: "latest")!, requiredAccountFence: "backend|account-a")
        XCTAssertNil(pending.take(accountFence: "backend|account-b"))
        XCTAssertNil(pending.destination)
    }

    @MainActor
    func testExpiryPreservationKeepsNewerPendingIntentForSameAccount() {
        let pending = PendingNotificationNavigation()
        pending.receive(NotificationDestination(sessionId: "newer")!)
        pending.preserve(NotificationDestination(sessionId: "in-flight")!, for: "backend|account-a")
        XCTAssertEqual(pending.take(accountFence: "backend|account-a")?.sessionId, "newer")
    }

    @MainActor
    func testResumeControllerRoutesOnlyAfterAcknowledgedActivation() async {
        let started = expectation(description: "activation started")
        let activation = SuspendedNotificationValidation(started: started)
        let controller = NotificationResumeController()
        let destination = NotificationDestination(sessionId: "available")!
        let settled = expectation(description: "notification activation settled")
        var routed: String?
        controller.resume(
            destination,
            accountFence: "account-a",
            activate: { _ in await activation.wait() },
            route: { routed = $0 }
        )
        await fulfillment(of: [started], timeout: 2)
        XCTAssertNil(routed)
        XCTAssertEqual(controller.state, .pending(destination))

        let subscription = controller.$state.dropFirst().first { $0 == .idle }.sink { _ in settled.fulfill() }
        defer { subscription.cancel() }
        activation.complete(.authorized)
        await fulfillment(of: [settled], timeout: 2)
        XCTAssertEqual(routed, "available")
        XCTAssertEqual(controller.state, .idle)
    }

    @MainActor
    func testResumeControllerRoutesBeforeClearFailureAndRetryClearsWithoutReactivation() async {
        let controller = NotificationResumeController()
        let destination = NotificationDestination(sessionId: "available")!
        var events: [String] = []
        controller.resume(
            destination,
            accountFence: "account-a",
            activate: { _ in events.append("activate"); return .authorized },
            route: { _ in events.append("route") },
            clear: { _ in events.append("clear"); return false }
        )
        await Task.yield()
        await Task.yield()

        XCTAssertEqual(events, ["activate", "route", "clear"])
        XCTAssertEqual(controller.state, .clearFailure(destination))

        controller.retryClear(destination, accountFence: "account-a") { _ in
            events.append("retry-clear")
            return true
        }
        await Task.yield()
        XCTAssertEqual(events, ["activate", "route", "clear", "retry-clear"])
        XCTAssertEqual(controller.state, .idle)
    }

    @MainActor
    func testResumeControllerExposesUnavailableWithoutRouting() async {
        let controller = NotificationResumeController()
        let unavailable = NotificationDestination(sessionId: "missing")!
        controller.resume(unavailable, accountFence: "account-a", activate: { _ in .unavailable }, route: { _ in
            XCTFail("unavailable destination routed")
        })
        await Task.yield()
        XCTAssertEqual(controller.state, .unavailable(unavailable))
    }

    @MainActor
    func testResumeControllerLatestTapWinsOverLateOldAcknowledgement() async {
        let oldStarted = expectation(description: "old activation started")
        let latestStarted = expectation(description: "latest activation started")
        let old = SuspendedNotificationValidation(started: oldStarted)
        let latest = SuspendedNotificationValidation(started: latestStarted)
        let controller = NotificationResumeController()
        let latestRouted = expectation(description: "latest routed")
        var routed: [String] = []

        controller.resume(
            NotificationDestination(sessionId: "old")!,
            accountFence: "account-a",
            activate: { _ in await old.wait() },
            route: { routed.append($0) }
        )
        await fulfillment(of: [oldStarted], timeout: 2)
        controller.resume(
            NotificationDestination(sessionId: "latest")!,
            accountFence: "account-a",
            activate: { _ in await latest.wait() },
            route: { routed.append($0); latestRouted.fulfill() }
        )
        await fulfillment(of: [latestStarted], timeout: 2)

        old.complete(.authorized)
        latest.complete(.authorized)
        await fulfillment(of: [latestRouted], timeout: 2)
        XCTAssertEqual(routed, ["latest"])
    }

    @MainActor
    func testExpiryCancellationStopsLateRouteAndPreservesDestination() async {
        let started = expectation(description: "activation started")
        let activation = SuspendedNotificationValidation(started: started)
        let controller = NotificationResumeController()
        let pending = PendingNotificationNavigation()
        let destination = NotificationDestination(sessionId: "expiry-session")!
        var routed: String?
        controller.resume(
            destination,
            accountFence: "backend|account-a",
            activate: { _ in await activation.wait() },
            route: { routed = $0 }
        )
        await fulfillment(of: [started], timeout: 2)

        pending.preserve(controller.state.destination, for: "backend|account-a")
        controller.cancel()
        activation.complete(.authorized)
        await Task.yield()

        XCTAssertNil(routed)
        XCTAssertEqual(pending.take(accountFence: "backend|account-a"), destination)
    }

    @MainActor
    func testResumeControllerFencesSuspendedActivationAcrossAccountChange() async {
        let started = expectation(description: "activation started")
        let activation = SuspendedNotificationValidation(started: started)
        let controller = NotificationResumeController()
        var routed: String?
        controller.resume(
            NotificationDestination(sessionId: "old-session")!,
            accountFence: "account-old",
            activate: { _ in await activation.wait() },
            route: { routed = $0 }
        )
        await fulfillment(of: [started], timeout: 2)
        controller.setAccountFence("account-new")
        activation.complete(.authorized)
        await Task.yield()
        XCTAssertNil(routed)
        XCTAssertEqual(controller.state, .idle)
    }

    @MainActor
    func testForegroundPushInvalidatesOnlyCurrentBindingGenerationAndAccount() {
        let oldBinding = pushBinding(generation: 1)
        let oldLifecycle = FakeNativePushLifecycle(initialState: .linked(oldBinding, activationPending: false))
        let newBinding = pushBinding(generation: 2)
        let newLifecycle = FakeNativePushLifecycle(initialState: .linked(newBinding, activationPending: false))
        let coordinator = NativePushCoordinator(
            permissions: FakePermission(status: .authorized, granted: true),
            lifecycleFactory: { $0.fence == "account-old" ? oldLifecycle : newLifecycle }
        )
        coordinator.configure(account: account("account-old"))

        coordinator.receiveForeground(userInfo: foregroundPayload(binding: oldBinding))
        XCTAssertEqual(coordinator.foregroundInboxInvalidation?.accountFence, "account-old")
        let firstSequence = coordinator.foregroundInboxInvalidation?.sequence

        coordinator.receiveForeground(userInfo: foregroundPayload(binding: oldBinding, generation: 99))
        coordinator.receiveForeground(userInfo: foregroundPayload(binding: newBinding))
        XCTAssertEqual(coordinator.foregroundInboxInvalidation?.sequence, firstSequence)

        oldLifecycle.state = .unlinked
        coordinator.configure(account: account("account-new"))
        coordinator.receiveForeground(userInfo: foregroundPayload(binding: oldBinding))
        XCTAssertEqual(coordinator.foregroundInboxInvalidation?.sequence, firstSequence)
        coordinator.receiveForeground(userInfo: foregroundPayload(binding: newBinding))
        XCTAssertEqual(coordinator.foregroundInboxInvalidation?.accountFence, "account-new")
        XCTAssertNotEqual(coordinator.foregroundInboxInvalidation?.sequence, firstSequence)
        XCTAssertNil(coordinator.navigation.destination, "foreground invalidation must not enter tap navigation")
    }

    @MainActor
    func testForegroundRefreshCoalescesStormAndKeepsTrailingInvalidation() async {
        let firstStarted = expectation(description: "first refresh started")
        let trailingFinished = expectation(description: "trailing refresh finished")
        let refresh = SuspendedInboxRefresh(started: firstStarted)
        var calls = 0
        let controller = ForegroundInboxRefreshController(accountFence: "account-a") {
            calls += 1
            if calls == 1 { await refresh.wait() }
            if calls == 2 { trailingFinished.fulfill() }
        }

        controller.request(accountFence: "wrong-account")
        XCTAssertEqual(calls, 0)
        controller.request(accountFence: "account-a")
        await fulfillment(of: [firstStarted], timeout: 2)
        controller.request(accountFence: "account-a")
        controller.request(accountFence: "account-a")
        XCTAssertEqual(calls, 1)

        refresh.complete()
        await fulfillment(of: [trailingFinished], timeout: 2)
        XCTAssertEqual(calls, 2)
    }

    @MainActor
    func testInboxEntryOwnsExactlyOneRefresh() async {
        let finished = expectation(description: "entry refresh finished")
        var calls = 0
        let controller = ForegroundInboxRefreshController(accountFence: "account-a") {
            calls += 1
            finished.fulfill()
        }

        controller.request(accountFence: "account-a")

        await fulfillment(of: [finished], timeout: 2)
        XCTAssertEqual(calls, 1)
    }

    @MainActor
    func testForegroundRefreshCancelRestartKeepsNewTaskOwned() async {
        let oldStarted = expectation(description: "old refresh started")
        let newStarted = expectation(description: "new refresh started")
        let trailingStarted = expectation(description: "trailing refresh started")
        let refresh = SuspendedInboxRefreshes(starts: [oldStarted, newStarted, trailingStarted])
        let controller = ForegroundInboxRefreshController(accountFence: "account-a") { await refresh.run() }

        controller.request(accountFence: "account-a")
        await fulfillment(of: [oldStarted], timeout: 2)
        controller.cancel()
        controller.request(accountFence: "account-a")
        await fulfillment(of: [newStarted], timeout: 2)

        refresh.complete(0)
        await Task.yield()
        controller.request(accountFence: "account-a")
        XCTAssertEqual(refresh.calls, 2, "old cleanup must not release restarted task ownership")

        refresh.complete(1)
        await fulfillment(of: [trailingStarted], timeout: 2)
        refresh.complete(2)
    }

    @MainActor
    func testExpiryPreparationPreservesIntendedTarget() async {
        let coordinator = NativePushCoordinator(permissions: FakePermission(status: .denied, granted: false))
        coordinator.navigation.receive(
            NotificationDestination(sessionId: "intended")!,
            requiredAccountFence: "backend|account-a"
        )
        _ = await coordinator.prepareForLogout(preservingNavigationFor: "backend|account-a")
        coordinator.finalizeLogoutPreparation()
        XCTAssertEqual(coordinator.navigation.take(accountFence: "backend|account-a")?.sessionId, "intended")
    }

    @MainActor
    func testReauthenticationIntentUsesSessionOwnerNotRetiringPushOwner() async {
        let lifecycle = FakeNativePushLifecycle()
        let coordinator = NativePushCoordinator(
            permissions: FakePermission(status: .denied, granted: false),
            lifecycleFactory: { _ in lifecycle }
        )
        coordinator.configure(account: account("backend|retiring-push-owner"))
        coordinator.navigation.receive(NotificationDestination(sessionId: "intended")!)

        _ = await coordinator.prepareForLogout(preservingNavigationFor: "backend|authenticated-owner")
        coordinator.finalizeLogoutPreparation()

        XCTAssertEqual(
            coordinator.navigation.take(accountFence: "backend|authenticated-owner")?.sessionId,
            "intended"
        )
    }

    @MainActor
    func testLogoutPreparationClearsStaleAccountTargetImmediately() async {
        let coordinator = NativePushCoordinator(permissions: FakePermission(status: .denied, granted: false))
        coordinator.navigation.receive(NotificationDestination(sessionId: "old-account-session")!)
        _ = await coordinator.prepareForLogout()
        coordinator.finalizeLogoutPreparation()
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
        await fulfillment(of: [unlinkStarted], timeout: 2)
        lifecycle.completeUnlink(.success)
        await Task.yield()

        await coordinator.enable()
        coordinator.didRegister(deviceToken: Data([0x01, 0x02]))
        await fulfillment(of: [registered], timeout: 2)
        XCTAssertEqual(registrar.calls, 1)
        XCTAssertEqual(lifecycle.registerCalls, 1)
        XCTAssertFalse(lifecycle.closed)
        XCTAssertNotNil(coordinator.binding)
    }

    @MainActor
    func testFailedSettingsUnlinkCanPrepareLogoutWithoutWaitingForNetwork() async {
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
        await fulfillment(of: [unlinkStarted], timeout: 2)
        lifecycle.completeUnlink(.failure)
        await Task.yield()

        let prepared = await coordinator.prepareForLogout()
        XCTAssertTrue(prepared)
        XCTAssertEqual(lifecycle.prepareCalls, 1)
        coordinator.retryPendingUnlink()
        await fulfillment(of: [retryStarted], timeout: 2)
        lifecycle.completeRetry(.success)
        await Task.yield()
        XCTAssertTrue(lifecycle.closed)
    }

    @MainActor
    func testAccountReplacementWaitsForExactOldLifecycleAcknowledgement() async {
        let unlinkStarted = expectation(description: "old binding disable started")
        let replacementInstalled = expectation(description: "replacement lifecycle installed")
        let old = FakeNativePushLifecycle(
            unlinkStarted: unlinkStarted,
            initialState: .linked(pushBinding(generation: 1), activationPending: false)
        )
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
        await fulfillment(of: [unlinkStarted], timeout: 2)
        XCTAssertEqual(installed, ["account-old"])
        XCTAssertNotNil(coordinator.lifecycleWarning)

        old.completeUnlink(.success)
        await fulfillment(of: [replacementInstalled], timeout: 2)
        XCTAssertEqual(installed, ["account-old", "account-new"])
        XCTAssertTrue(old.closed)
    }

    @MainActor
    func testAccountReplacementDoesNotInstallOnNonterminalUnlinkSuccess() async {
        let unlinkStarted = expectation(description: "old unlink started")
        let old = FakeNativePushLifecycle(
            unlinkStarted: unlinkStarted,
            initialState: .linked(pushBinding(generation: 1), activationPending: false)
        )
        let replacement = FakeNativePushLifecycle()
        var installed: [String] = []
        let coordinator = NativePushCoordinator(
            permissions: FakePermission(status: .denied, granted: false),
            lifecycleFactory: { configuration in
                installed.append(configuration.fence)
                return configuration.fence == "account-new" ? replacement : old
            }
        )

        coordinator.configure(account: account("account-old"))
        coordinator.configure(account: account("account-new"))
        await fulfillment(of: [unlinkStarted], timeout: 2)
        old.completeUnlink(.success, resultingState: .pendingUnlink)
        await Task.yield()

        XCTAssertEqual(installed, ["account-old"])
        XCTAssertFalse(old.closed)
        XCTAssertNotNil(coordinator.lifecycleWarning)
    }

    @MainActor
    func testSameAccountLoginQueuesBehindPreparedLogoutAndInstallsOnce() async {
        let retryStarted = expectation(description: "pending unlink retry started")
        let replacementInstalled = expectation(description: "same-account replacement installed")
        let old = FakeNativePushLifecycle(retryStarted: retryStarted)
        let replacement = FakeNativePushLifecycle()
        var installed: [String] = []
        let coordinator = NativePushCoordinator(
            permissions: FakePermission(status: .denied, granted: false),
            lifecycleFactory: { configuration in
                installed.append(configuration.fence)
                if installed.count == 2 { replacementInstalled.fulfill(); return replacement }
                return old
            }
        )

        coordinator.configure(account: account("account-a"))
        let prepared = await coordinator.prepareForLogout()
        XCTAssertTrue(prepared)
        coordinator.retryPendingUnlink()
        await fulfillment(of: [retryStarted], timeout: 2)
        coordinator.configure(account: account("account-a"))
        coordinator.configure(account: account("account-a"))
        XCTAssertEqual(installed, ["account-a"])

        old.completeRetry(.success)
        await fulfillment(of: [replacementInstalled], timeout: 2)
        XCTAssertEqual(installed, ["account-a", "account-a"])
        XCTAssertTrue(old.closed)
    }

    @MainActor
    func testLoggedOutCleanupDoesNotCloseOnNonterminalRetrySuccess() async {
        let retryStarted = expectation(description: "pending retry started")
        let lifecycle = FakeNativePushLifecycle(retryStarted: retryStarted, initialState: .pendingUnlink)
        let coordinator = NativePushCoordinator(
            permissions: FakePermission(status: .denied, granted: false),
            lifecycleFactory: { _ in lifecycle }
        )

        coordinator.configureForLoggedOutCleanup(gatewayWsUrl: "wss://gateway.test", allowSelfSignedDevHost: false)
        await fulfillment(of: [retryStarted], timeout: 2)
        lifecycle.completeRetry(.success, resultingState: .pendingUnlink)
        await Task.yield()

        XCTAssertFalse(lifecycle.closed)
        XCTAssertNotNil(coordinator.lifecycleWarning)
    }

    @MainActor
    func testLoggedOutRestartRetriesPersistedRevokeWithoutCredentials() async {
        let retryStarted = expectation(description: "cleanup retry started")
        let lifecycle = FakeNativePushLifecycle(retryStarted: retryStarted, initialState: .pendingUnlink)
        var observedToken: String?
        let coordinator = NativePushCoordinator(
            permissions: FakePermission(status: .denied, granted: false),
            lifecycleFactory: { configuration in
                observedToken = configuration.token()
                return lifecycle
            }
        )

        coordinator.configureForLoggedOutCleanup(gatewayWsUrl: "wss://gateway.test", allowSelfSignedDevHost: false)
        await fulfillment(of: [retryStarted], timeout: 2)
        XCTAssertEqual(observedToken, "")
        XCTAssertEqual(lifecycle.retryCalls, 1)
        lifecycle.completeRetry(.failure)
    }

    @MainActor
    func testCancellationResistantRegistrationDoesNotDelayLocalLogoutPreparation() async {
        let registrationStarted = expectation(description: "registration started")
        let lifecycle = FakeNativePushLifecycle(registrationStarted: registrationStarted)
        let coordinator = NativePushCoordinator(
            permissions: FakePermission(status: .authorized, granted: true),
            lifecycleFactory: { _ in lifecycle }
        )
        coordinator.configure(account: account("account-a"))
        coordinator.didRegister(deviceToken: Data(repeating: 1, count: 32))
        await fulfillment(of: [registrationStarted], timeout: 2)

        let prepared = await coordinator.prepareForLogout()
        XCTAssertTrue(prepared)
        XCTAssertEqual(lifecycle.prepareCalls, 1)
        lifecycle.completeRegistration(pushBinding(generation: 2))
    }

    @MainActor
    func testLoggedOutCleanupFreezesLateLinkedGrantBeforeRetry() async {
        let retryStarted = expectation(description: "late grant retry started")
        let lifecycle = FakeNativePushLifecycle(retryStarted: retryStarted, initialState: .linked(pushBinding(generation: 2), activationPending: false))
        let coordinator = NativePushCoordinator(
            permissions: FakePermission(status: .denied, granted: false),
            lifecycleFactory: { _ in lifecycle }
        )

        coordinator.configureForLoggedOutCleanup(gatewayWsUrl: "wss://different-current.test", allowSelfSignedDevHost: false)
        await fulfillment(of: [retryStarted], timeout: 2)
        XCTAssertEqual(lifecycle.preparePersistedCalls, 1)
        lifecycle.completeRetry(.success)
    }

    @MainActor
    func testLoggedOutKeychainReadFailureKeepsExplicitWarningAndRetryLifecycle() async {
        let lifecycle = FakeNativePushLifecycle(initialState: .storageUnavailable, prepareResult: .failure)
        let coordinator = NativePushCoordinator(
            permissions: FakePermission(status: .denied, granted: false),
            lifecycleFactory: { _ in lifecycle }
        )

        coordinator.configureForLoggedOutCleanup(gatewayWsUrl: "wss://current.test", allowSelfSignedDevHost: false)
        await Task.yield()
        XCTAssertTrue(coordinator.lifecycleWarning?.contains("could not be read securely") == true)
        XCTAssertFalse(lifecycle.closed)
        XCTAssertEqual(lifecycle.retryCalls, 0)
    }

    @MainActor
    func testSessionLogoutBoundaryAwaitsPrepareButNotNetworkAndSerializesCallers() async {
        let prepareStarted = expectation(description: "prepare started")
        let preparation = SuspendedLogoutPreparation(started: prepareStarted)
        var events: [String] = []
        let boundary = SessionLogoutBoundary(
            prepare: { _ in await preparation.wait() },
            finalizePreparation: { _ in events.append("finalize") },
            clearAuth: { events.append("auth") },
            startRevoke: { events.append("revoke-started") }
        )

        boundary.run { events.append("teardown") }
        boundary.run { XCTFail("second logout teardown ran") }
        await fulfillment(of: [prepareStarted], timeout: 2)
        XCTAssertTrue(events.isEmpty)
        preparation.complete(true)
        await Task.yield()
        XCTAssertEqual(events, ["finalize", "teardown", "auth", "revoke-started"])
    }

    @MainActor
    func testExplicitLogoutDropsIntentArrivingDuringSuspendedPreparation() async {
        let prepareStarted = expectation(description: "prepare started")
        let authCleared = expectation(description: "auth cleared")
        let lifecycle = FakeNativePushLifecycle(prepareStarted: prepareStarted)
        let coordinator = NativePushCoordinator(
            permissions: FakePermission(status: .denied, granted: false),
            lifecycleFactory: { _ in lifecycle }
        )
        coordinator.configure(account: account("backend|account-a"))
        let boundary = SessionLogoutBoundary(
            prepare: { await coordinator.prepareForLogout(preservingNavigationFor: $0 ? "backend|account-a" : nil) },
            finalizePreparation: { coordinator.finalizeLogoutPreparation(timedOut: $0) },
            clearAuth: { authCleared.fulfill() },
            startRevoke: {}
        )

        boundary.run {}
        await fulfillment(of: [prepareStarted], timeout: 2)
        coordinator.navigation.receive(NotificationDestination(sessionId: "during-logout")!)
        lifecycle.completePreparation(.success)
        await fulfillment(of: [authCleared], timeout: 2)

        XCTAssertNil(coordinator.navigation.destination)
    }

    @MainActor
    func testAuthExpiryFencesLatestIntentArrivingDuringSuspendedPreparation() async {
        let prepareStarted = expectation(description: "prepare started")
        let authCleared = expectation(description: "auth cleared")
        let lifecycle = FakeNativePushLifecycle(prepareStarted: prepareStarted)
        let coordinator = NativePushCoordinator(
            permissions: FakePermission(status: .denied, granted: false),
            lifecycleFactory: { _ in lifecycle }
        )
        coordinator.configure(account: account("backend|account-a"))
        let boundary = SessionLogoutBoundary(
            prepare: { await coordinator.prepareForLogout(preservingNavigationFor: $0 ? "backend|account-a" : nil) },
            finalizePreparation: { coordinator.finalizeLogoutPreparation(timedOut: $0) },
            clearAuth: { authCleared.fulfill() },
            startRevoke: {}
        )

        boundary.run(preservingNavigation: true) {}
        await fulfillment(of: [prepareStarted], timeout: 2)
        coordinator.navigation.receive(NotificationDestination(sessionId: "latest")!)
        lifecycle.completePreparation(.success)
        await fulfillment(of: [authCleared], timeout: 2)

        XCTAssertEqual(coordinator.navigation.destination?.sessionId, "latest")
        XCTAssertNil(coordinator.navigation.take(accountFence: "backend|account-b"))
    }

    @MainActor
    func testLogoutTimeoutIgnoresLatePreparationAfterReplacement() async {
        let prepareStarted = expectation(description: "prepare started")
        let authCleared = expectation(description: "auth cleared")
        let latePreparationSettled = expectation(description: "late preparation settled")
        var teardownCount = 0
        var authClearCount = 0
        let old = FakeNativePushLifecycle(prepareStarted: prepareStarted)
        let replacement = FakeNativePushLifecycle()
        let coordinator = NativePushCoordinator(
            permissions: FakePermission(status: .denied, granted: false),
            lifecycleFactory: { $0.fence == "backend|account-a" ? old : replacement }
        )
        coordinator.configure(account: account("backend|account-a"))
        let boundary = SessionLogoutBoundary(
            prepare: {
                let result = await coordinator.prepareForLogout(preservingNavigationFor: $0 ? "backend|account-a" : nil)
                latePreparationSettled.fulfill()
                return result
            },
            finalizePreparation: { coordinator.finalizeLogoutPreparation(timedOut: $0) },
            clearAuth: {
                authClearCount += 1
                authCleared.fulfill()
            },
            startRevoke: {},
            preparationTimeout: .milliseconds(1)
        )

        boundary.run { teardownCount += 1 }
        await fulfillment(of: [prepareStarted, authCleared], timeout: 2)
        XCTAssertNotNil(coordinator.lifecycleWarning)
        coordinator.configure(account: account("backend|account-b"))
        coordinator.navigation.receive(NotificationDestination(sessionId: "new-account")!)
        boundary.run { XCTFail("A completed logout boundary must never clear a replacement account") }
        old.completePreparation(.success)
        await fulfillment(of: [latePreparationSettled], timeout: 2)

        XCTAssertEqual(coordinator.navigation.destination?.sessionId, "new-account")
        XCTAssertEqual(teardownCount, 1)
        XCTAssertEqual(authClearCount, 1)
        XCTAssertFalse(replacement.closed)
    }

    @MainActor
    func testFailedPreparationStillTearsDownAndClearsAuth() async {
        var events: [String] = []
        let boundary = SessionLogoutBoundary(
            prepare: { _ in false },
            clearAuth: { events.append("auth") },
            startRevoke: { events.append("revoke-started") }
        )
        boundary.run { events.append("teardown") }
        await Task.yield()
        XCTAssertEqual(events, ["teardown", "auth", "revoke-started"])
    }

    @MainActor
    func testStorageFailureStillAllowsTeardownAndKeepsWarning() async {
        let lifecycle = FakeNativePushLifecycle(prepareResult: .failure)
        let coordinator = NativePushCoordinator(
            permissions: FakePermission(status: .denied, granted: false),
            lifecycleFactory: { _ in lifecycle }
        )
        coordinator.configure(account: account("account-a"))

        let prepared = await coordinator.prepareForLogout()
        XCTAssertFalse(prepared)
        XCTAssertNotNil(coordinator.lifecycleWarning)
        XCTAssertEqual(lifecycle.retryCalls, 0)
    }

    @MainActor
    func testStaleOldBindingAcknowledgementKeepsReplacementFencedUntilRetrySucceeds() async {
        let unlinkStarted = expectation(description: "old unlink attempted")
        let retryStarted = expectation(description: "old unlink retried")
        let replacementInstalled = expectation(description: "replacement installed after retry")
        let old = FakeNativePushLifecycle(
            unlinkStarted: unlinkStarted,
            retryStarted: retryStarted,
            initialState: .linked(pushBinding(generation: 1), activationPending: false)
        )
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
        await fulfillment(of: [unlinkStarted], timeout: 2)
        old.completeUnlink(.failure) // Models the shared coordinator rejecting a stale acknowledgement.
        await Task.yield()
        XCTAssertEqual(installed, ["account-old"])
        XCTAssertNotNil(coordinator.lifecycleWarning)

        coordinator.retryPendingUnlink()
        await fulfillment(of: [retryStarted], timeout: 2)
        old.completeRetry(.success)
        await fulfillment(of: [replacementInstalled], timeout: 2)
        XCTAssertEqual(installed, ["account-old", "account-new"])
    }
}

@MainActor
private final class SuspendedInboxRefresh {
    private let started: XCTestExpectation
    private var continuation: CheckedContinuation<Void, Never>?

    init(started: XCTestExpectation) { self.started = started }
    func wait() async {
        started.fulfill()
        await withCheckedContinuation { continuation = $0 }
    }
    func complete() {
        continuation?.resume()
        continuation = nil
    }
}

@MainActor
private final class SuspendedInboxRefreshes {
    private let starts: [XCTestExpectation]
    private var continuations: [CheckedContinuation<Void, Never>?]
    private(set) var calls = 0

    init(starts: [XCTestExpectation]) {
        self.starts = starts
        continuations = Array(repeating: nil, count: starts.count)
    }

    func run() async {
        let index = calls
        calls += 1
        starts[index].fulfill()
        await withCheckedContinuation { continuations[index] = $0 }
    }

    func complete(_ index: Int) {
        continuations[index]?.resume()
        continuations[index] = nil
    }
}

@MainActor
private final class SuspendedLogoutPreparation {
    private let started: XCTestExpectation
    private var continuation: CheckedContinuation<Bool, Never>?

    init(started: XCTestExpectation) { self.started = started }
    func wait() async -> Bool {
        started.fulfill()
        return await withCheckedContinuation { continuation = $0 }
    }
    func complete(_ result: Bool) {
        continuation?.resume(returning: result)
        continuation = nil
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
    var state: NativePushLifecycleSnapshot
    private let prepareResult: NativePushLifecycleResult
    private let prepareStarted: XCTestExpectation?
    private let unlinkStarted: XCTestExpectation?
    private let retryStarted: XCTestExpectation?
    private let registrationStarted: XCTestExpectation?
    private var prepareContinuation: CheckedContinuation<NativePushLifecycleResult, Never>?
    private var unlinkContinuation: CheckedContinuation<NativePushLifecycleResult, Never>?
    private var retryContinuation: CheckedContinuation<NativePushLifecycleResult, Never>?
    private var registrationContinuation: CheckedContinuation<PushBinding?, Never>?
    private let registrationCompleted: XCTestExpectation?
    private(set) var closed = false
    private(set) var prepareCalls = 0
    private(set) var preparePersistedCalls = 0
    private(set) var unlinkCalls = 0
    private(set) var retryCalls = 0
    private(set) var registerCalls = 0

    init(
        prepareStarted: XCTestExpectation? = nil,
        unlinkStarted: XCTestExpectation? = nil,
        retryStarted: XCTestExpectation? = nil,
        registrationStarted: XCTestExpectation? = nil,
        registrationCompleted: XCTestExpectation? = nil,
        initialState: NativePushLifecycleSnapshot = .unlinked,
        prepareResult: NativePushLifecycleResult = .success
    ) {
        self.prepareStarted = prepareStarted
        self.unlinkStarted = unlinkStarted
        self.retryStarted = retryStarted
        self.registrationStarted = registrationStarted
        self.registrationCompleted = registrationCompleted
        self.state = initialState
        self.prepareResult = prepareResult
    }

    func prepareUnlink(ownerFence: String) async throws -> NativePushLifecycleResult {
        prepareCalls += 1
        let result: NativePushLifecycleResult
        if let prepareStarted {
            prepareStarted.fulfill()
            result = await withCheckedContinuation { prepareContinuation = $0 }
        } else {
            result = prepareResult
        }
        if case .success = result { state = .pendingUnlink }
        return result
    }

    func completePreparation(_ result: NativePushLifecycleResult) {
        prepareContinuation?.resume(returning: result)
        prepareContinuation = nil
    }

    func preparePersistedUnlink() async throws -> NativePushLifecycleResult {
        preparePersistedCalls += 1
        if case .success = prepareResult { state = .pendingUnlink }
        return prepareResult
    }

    func unlink(ownerFence: String) async throws -> NativePushLifecycleResult {
        unlinkCalls += 1
        state = .pendingUnlink
        unlinkStarted?.fulfill()
        return await withCheckedContinuation { unlinkContinuation = $0 }
    }

    func completeUnlink(
        _ result: NativePushLifecycleResult,
        resultingState: NativePushLifecycleSnapshot? = .unlinked
    ) {
        if case .success = result, let resultingState { state = resultingState }
        unlinkContinuation?.resume(returning: result)
        unlinkContinuation = nil
    }

    func retryPendingUnlink() async throws -> NativePushLifecycleResult {
        retryCalls += 1
        retryStarted?.fulfill()
        return await withCheckedContinuation { retryContinuation = $0 }
    }

    func completeRetry(
        _ result: NativePushLifecycleResult,
        resultingState: NativePushLifecycleSnapshot? = .unlinked
    ) {
        if case .success = result, let resultingState { state = resultingState }
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
        if let registrationStarted {
            registrationStarted.fulfill()
            return await withCheckedContinuation { registrationContinuation = $0 }
        }
        let value = pushBinding(generation: Int32(registerCalls))
        state = .linked(value, activationPending: false)
        registrationCompleted?.fulfill()
        return value
    }
    func completeRegistration(_ binding: PushBinding?) {
        if let binding { state = .linked(binding, activationPending: false) }
        registrationContinuation?.resume(returning: binding)
        registrationContinuation = nil
    }
    func close() { closed = true }
}

private func foregroundPayload(binding: PushBinding, generation: Int32? = nil) -> [AnyHashable: Any] {
    [
        "bindingId": binding.bindingId,
        "generation": generation ?? binding.generation,
        "sessionId": "scheduled-session",
    ]
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
