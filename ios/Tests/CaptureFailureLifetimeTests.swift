import Foundation

import MobileData
import Testing
@testable import SentientApp

@MainActor
struct CaptureFailureLifetimeTests {
    @Test func typedFlowCrossesSkieAndProductionConsumerRejectsStaleEvents() async {
        let session = unopenedSession()
        defer { session.close() }
        let vm = ChatViewModel(component: session.component, sessionId: nil,
                               activateOnInit: false, observeChatOnInit: false)
        var ids: [String] = []
        for await failure in captureStartFailureBridgeProbe() {
            ids.append(failure.captureId)
            #expect(failure.captureGeneration == Int64(ids.count))
            if ids.count == 1 {
                #expect(failure.routeGeneration?.int64Value == 7)
            } else {
                #expect(failure.routeGeneration == nil)
            }
            // No capture has run: the real SDK predicate must reject both.
            #expect(!session.component.isCaptureStartFailureCurrent(event: failure))
            vm.applyCaptureFailure(failure)
            #expect(vm.captureFailureId == nil)
        }
        #expect(ids == ["bridge-capture", "bridge-unbound"])
    }

    @Test func routeAuthorityRevokesAlreadyPresentedFailure() async {
        let session = unopenedSession()
        defer { session.close() }
        let vm = ChatViewModel(component: session.component, sessionId: nil,
                               activateOnInit: false, observeChatOnInit: false)
        let oldRoute = session.component.outboundRouteGeneration.value
        // Seed a previously presented projection, NOT a claim of SDK delivery.
        vm.captureFailure = SdkEvent.CaptureStartFailed(
            captureId: "previously-presented", captureGeneration: 1, routeGeneration: oldRoute)
        #expect(vm.captureFailureId == "previously-presented")
        session.component.bindChatRoute(cache: createOutboundCache(), sessionId: nil,
                                        draftId: nil, activate: true)
        #expect(session.component.outboundRouteGeneration.value != oldRoute)
        let deadline = ContinuousClock.now + .seconds(3)
        while vm.captureFailureId != nil, ContinuousClock.now < deadline { await Task.yield() }
        #expect(vm.captureFailureId == nil)
    }

    private func unopenedSession() -> IosUserSession {
        createUserSession(gatewayWsUrl: "ws://127.0.0.1:9/api/v1/ws",
                          allowSelfSignedDevHost: false,
                          authenticatedUserId: "capture-lifetime-\(UUID().uuidString)",
                          capabilities: [], devFaultsEnabled: false, onLoggedOut: {})
    }
}
