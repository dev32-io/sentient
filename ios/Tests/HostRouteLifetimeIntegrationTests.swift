import Combine
import Foundation
import MobileData
import XCTest
@testable import SentientApp

final class HostRouteLifetimeIntegrationTests: XCTestCase {
    @MainActor
    func testHistoryAndNewChatSaveLatestRevisionBeforeRetirement() async throws {
        for target in ["history-B", "new-chat"] {
            for superseded in [false, true] {
                try await withNativeSendFixture { fixture in
                    let lifetime = HostRouteLifetime()
                    let saving = expectation(description: "departing revision A held")
                    var release: CheckedContinuation<Void, Never>?
                    var hold = false
                    let vm = ChatViewModel(component: fixture.component, sessionId: "history-session",
                        saveDraftText: { id, session, text in
                            if hold && text == "A" {
                                hold = false
                                await withCheckedContinuation { release = $0; saving.fulfill() }
                            }
                            return try await fixture.drafts.saveText(draftId: id, sessionId: session, text: text)
                        })
                    defer { vm.retireEditor(); lifetime.retire() }
                    try await fixture.acknowledgeRoute(sessionId: "history-session")
                    vm.updateDraft("seed")
                    let seeded = await vm.saveDraftBeforeNavigation()
                    XCTAssertTrue(seeded)
                    let draftId = try XCTUnwrap(fixture.drafts.snapshot.value.drafts.first?.id)
                    lifetime.installEditor { vm.retireEditor() }
                    let intent = lifetime.begin()!
                    var selected = "history-session"
                    vm.updateDraft("A")
                    hold = true
                    let navigation = Task {
                        await completeSavedNavigation(
                            save: { await vm.saveAndRetireEditor { lifetime.accepts(intent) } },
                            isCurrent: { lifetime.accepts(intent) },
                            navigate: { lifetime.retireEditor(); selected = target })
                    }
                    await fulfillment(of: [saving], timeout: 3)
                    vm.updateDraft("B")
                    if superseded { _ = lifetime.begin() } // Settings keeps editor, cancels route intent.
                    release?.resume() // No debounce sleep: navigation must persist B itself.
                    let completed = await navigation.value
                    XCTAssertEqual(completed, !superseded)
                    XCTAssertEqual(selected, superseded ? "history-session" : target)
                    if superseded {
                        XCTAssertTrue(lifetime.hasEditor)
                        vm.updateDraft("C")
                        let saved = await vm.saveDraftBeforeNavigation()
                        XCTAssertTrue(saved)
                    } else {
                        XCTAssertFalse(lifetime.hasEditor)
                    }
                    let restored = ChatViewModel(component: fixture.component, sessionId: "history-session", draftId: draftId)
                    defer { restored.retireEditor() }
                    try await sendEventually("departing revision restored") {
                        restored.draftText == (superseded ? "C" : "B")
                    }
                }
            }
        }
    }

    @MainActor
    func testSettingsSupersessionPreservesOpenedCardClearRetryWithoutReactivation() async {
        let controller = NotificationResumeController()
        let destination = NotificationDestination(sessionId: "opened")!
        let failed = expectation(description: "clear failure")
        let cleared = expectation(description: "retry clear completed")
        var activations = 0
        let failureSubscription = controller.$state.first { $0 == .clearFailure(destination) }.sink { _ in failed.fulfill() }
        controller.resume(
            destination, accountFence: "account",
            activate: { _ in activations += 1; return .authorized },
            route: { _ in }, clear: { _ in false }
        )
        await fulfillment(of: [failed], timeout: 2)
        controller.supersedeNavigation()
        XCTAssertEqual(controller.state, .clearFailure(destination))
        let clearedSubscription = controller.$state.first { $0 == .idle }.sink { _ in cleared.fulfill() }
        controller.retryClear(destination, accountFence: "account", clear: { _ in true })
        await fulfillment(of: [cleared], timeout: 2)
        XCTAssertEqual(activations, 1)
        failureSubscription.cancel()
        clearedSubscription.cancel()
        controller.cancel()
    }

    @MainActor
    func testLateStartupRestoreCannotBindRealDefaultRouteBeforeOrAfterNotificationCompletion() async {
        // This exercises real ChatComponent binding if startup is admitted. The
        // controller validation seam is NOT proof of shared SDK READY/ACK handling.
        for restoreBeforeAck in [true, false] {
            let session = createUserSession(
                gatewayWsUrl: "wss://test.invalid/api/v1/ws", allowSelfSignedDevHost: false,
                authenticatedUserId: "route-startup-\(UUID().uuidString)",
                capabilities: [], devFaultsEnabled: false, onLoggedOut: {}
            )
            let lifetime = HostRouteLifetime()
            let controller = NotificationResumeController()
            let loadStarted = expectation(description: "restore suspended")
            let activationStarted = expectation(description: "activation suspended")
            let routed = expectation(description: "notification routed")
            var restoreCompletion: CheckedContinuation<Void, Never>?
            var ack: CheckedContinuation<NotificationSessionValidation, Never>?
            var defaultVM: ChatViewModel?
            let generation = session.component.outboundRouteGeneration.value
            let restoring = Task { @MainActor in
                await lifetime.restoreDefault(
                    load: { await withCheckedContinuation { restoreCompletion = $0; loadStarted.fulfill() } },
                    apply: { _ in defaultVM = ChatViewModel(component: session.component, sessionId: nil) }
                )
            }
            await fulfillment(of: [loadStarted], timeout: 2)
            let notification = lifetime.begin()!
            controller.resume(
                NotificationDestination(sessionId: "notification")!, accountFence: "account",
                activate: { _ in await withCheckedContinuation { ack = $0; activationStarted.fulfill() } },
                route: { _ in routed.fulfill() },
                isCurrent: { lifetime.accepts(notification) }
            )
            await fulfillment(of: [activationStarted], timeout: 2)
            if restoreBeforeAck {
                restoreCompletion?.resume()
                let applied = await restoring.value
                XCTAssertFalse(applied)
                ack?.resume(returning: .authorized)
                await fulfillment(of: [routed], timeout: 2)
            } else {
                ack?.resume(returning: .authorized)
                await fulfillment(of: [routed], timeout: 2)
                restoreCompletion?.resume()
                let applied = await restoring.value
                XCTAssertFalse(applied)
            }
            XCTAssertNil(defaultVM)
            XCTAssertEqual(session.component.outboundRouteGeneration.value, generation)
            defaultVM?.retireEditor()
            lifetime.retire()
            controller.cancel()
            session.close()
        }
    }

    @MainActor
    func testAuthRetirementInvalidatesHeldSaveWithoutChangingExpiryOrLogoutPolicy() async {
        for expires in [true, false] {
            let lifetime = HostRouteLifetime()
            let pending = PendingNotificationNavigation()
            let destination = NotificationDestination(sessionId: "target")!
            let intent = lifetime.begin()!
            var retired = false
            lifetime.installEditor { retired = true }
            _ = lifetime.begin() // auth-ending invalidates every suspended intent
            lifetime.retireEditor()
            if expires { pending.preserve(destination, for: "backend|account") }
            else { pending.receive(destination); pending.clear() }
            var navigated = false
            let completed = await completeSavedNavigation(
                save: { true }, isCurrent: { lifetime.accepts(intent) }, navigate: { navigated = true }
            )
            XCTAssertFalse(completed)
            XCTAssertFalse(navigated)
            XCTAssertTrue(retired)
            XCTAssertEqual(pending.take(accountFence: "backend|account"), expires ? destination : nil)
        }
    }

    @MainActor
    func testRealVMDelayedHistoryAndNewChatCannotReplaceNotification() async {
        for target in ["history-B", "new-chat"] {
            let session = createUserSession(
                gatewayWsUrl: "wss://test.invalid/api/v1/ws",
                allowSelfSignedDevHost: false,
                authenticatedUserId: "route-save-\(UUID().uuidString)",
                capabilities: [], devFaultsEnabled: false, onLoggedOut: {}
            )
            let lifetime = HostRouteLifetime()
            let started = expectation(description: "draft save entered")
            var completion: CheckedContinuation<NativeDraft?, Never>?
            let vm = ChatViewModel(
                component: session.component, sessionId: "A", activateOnInit: false,
                saveDraftText: { _, _, _ in
                    await withCheckedContinuation { completion = $0; started.fulfill() }
                }
            )
            lifetime.installEditor { [weak vm] in vm?.retireEditor() }
            let historyIntent = lifetime.begin()!
            var selected = "A"
            let navigation = Task { @MainActor in
                await completeSavedNavigation(
                    save: { await vm.saveAndRetireEditor { lifetime.accepts(historyIntent) } },
                    isCurrent: { lifetime.accepts(historyIntent) },
                    navigate: { selected = target }
                )
            }
            await fulfillment(of: [started], timeout: 2)
            _ = lifetime.begin() // notification ACK commits C before old save returns
            lifetime.retireEditor()
            selected = "C"
            completion?.resume(returning: NativeDraft(
                id: "A-draft", sessionId: "A", text: "", attachments: [],
                revision: 1, createdAt: 1, updatedAt: 1
            ))
            let navigated = await navigation.value
            XCTAssertFalse(navigated)
            XCTAssertEqual(selected, "C")
            lifetime.retire()
            session.close()
        }
    }

    @MainActor
    func testTrueRetirementReleasesRealVMCollectorsButSettingsDoesNotRetire() async {
        let session = createUserSession(
            gatewayWsUrl: "wss://test.invalid/api/v1/ws",
            allowSelfSignedDevHost: false,
            authenticatedUserId: "route-release-\(UUID().uuidString)",
            capabilities: [], devFaultsEnabled: false, onLoggedOut: {}
        )
        defer { session.close() }
        let lifetime = HostRouteLifetime()
        var vm: ChatViewModel? = ChatViewModel(component: session.component, sessionId: nil)
        weak var oldVM = vm
        lifetime.installEditor { [weak editor = vm] in editor?.retireEditor() }
        _ = lifetime.begin() // settings push: same editor remains live
        XCTAssertTrue(lifetime.hasEditor)
        XCTAssertNotNil(oldVM)
        lifetime.retireEditor() // same-session or A -> B -> A route replacement
        vm = nil
        // Let cancellation unwind real SKIE stream collectors and restore tasks.
        let released = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in oldVM == nil }, object: nil)
        await fulfillment(of: [released], timeout: 2)
        XCTAssertNil(oldVM, "true retirement must break VM/task collector retention")
        XCTAssertFalse(lifetime.hasEditor)
    }

    @MainActor
    func testSameSessionAndABARejectOldProducingRouteCallbacks() {
        let lifetime = HostRouteLifetime()
        var route = ChatRouteSelection()
        route.selectDraft("D", sessionId: "A")
        let old = route.viewIdentity
        route.selectDraft("D", sessionId: "A")
        XCTAssertFalse(lifetime.acceptsProducer(old, current: route.viewIdentity))
        let reopened = route.viewIdentity
        route.select("B")
        route.selectDraft("D", sessionId: "A")
        XCTAssertFalse(lifetime.acceptsProducer(reopened, current: route.viewIdentity))
        XCTAssertTrue(lifetime.acceptsProducer(route.viewIdentity, current: route.viewIdentity))
        lifetime.retire()
        XCTAssertFalse(lifetime.acceptsProducer(route.viewIdentity, current: route.viewIdentity))
    }

    @MainActor
    func testRetiredHostCannotConsumeSameAccountSuccessorNotification() {
        let pending = PendingNotificationNavigation()
        let old = HostRouteLifetime()
        let queuedTake = old.begin()!
        old.retire()
        let successor = HostRouteLifetime()
        pending.receive(NotificationDestination(sessionId: "successor")!, requiredAccountFence: "backend|account")
        if old.accepts(queuedTake) { _ = pending.take(accountFence: "backend|account") }
        XCTAssertEqual(pending.destination?.sessionId, "successor")
        XCTAssertFalse(successor.accepts(queuedTake))
        XCTAssertEqual(pending.take(accountFence: "backend|account")?.sessionId, "successor")
    }
}
