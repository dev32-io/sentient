import Testing
@testable import SentientApp

struct SendAnchorTests {
    @Test func emitsOnlyNewIdentity() {
        let (state, first) = reduceSendAnchor(SendAnchorState(), identities: Set([sendAnchorIdentity("p1")]))
        #expect(first == "send-p1")
        let (_, repeatValue) = reduceSendAnchor(state, identities: Set([sendAnchorIdentity("p1")]))
        #expect(repeatValue == nil)
    }

    @Test func assistantGrowthDoesNotMoveAnchor() {
        let (state, _) = reduceSendAnchor(SendAnchorState(), identities: Set([sendAnchorIdentity("p1")]))
        let (_, next) = reduceSendAnchor(state, identities: Set([sendAnchorIdentity("p1")]))
        #expect(next == nil)
    }

    @Test func pendingIdentityIsStableForCommittedEcho() {
        #expect(sendAnchorIdentity("p1") == "send-p1")
    }
}
