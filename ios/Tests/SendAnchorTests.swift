import Testing
@testable import SentientApp

struct SendAnchorTests {
    @Test func emitsOnlyNewIdentity() {
        let (state, first) = reduceSendAnchor(SendAnchorState(), identities: [sendAnchorIdentity("p1")])
        #expect(first == "send-p1")
        let (_, repeatValue) = reduceSendAnchor(state, identities: [sendAnchorIdentity("p1")])
        #expect(repeatValue == nil)
    }

    @Test func assistantGrowthDoesNotMoveAnchor() {
        let (state, _) = reduceSendAnchor(SendAnchorState(), identities: [sendAnchorIdentity("p1")])
        let (_, next) = reduceSendAnchor(state, identities: [sendAnchorIdentity("p1")])
        #expect(next == nil)
    }

    @Test func batchedSendsChooseNewestChronologyIdentityAndObserveBoth() {
        let ids = [sendAnchorIdentity("p1"), sendAnchorIdentity("p2")]
        let (state, newest) = reduceSendAnchor(SendAnchorState(), identities: ids)
        #expect(newest == "send-p2")
        #expect(reduceSendAnchor(state, identities: ids).1 == nil)
    }

    @Test func pendingIdentityIsStableForCommittedEcho() {
        #expect(sendAnchorIdentity("p1") == "send-p1")
    }
}
