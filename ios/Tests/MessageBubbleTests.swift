import Testing
@testable import SentientApp

struct MessageBubbleTests {
    @Test func cutoffCopyKeepsInterruptAndBargeInDistinct() {
        #expect(messageCutoffLabel(for: "interrupt") == "interrupted")
        #expect(messageCutoffLabel(for: "barge-in") == "barge-in")
    }

    @Test func unknownCutoffDoesNotCreateAnErrorMarker() {
        #expect(messageCutoffLabel(for: nil) == nil)
        #expect(messageCutoffLabel(for: "server-error") == nil)
    }
}
