import Testing
import MobileData
@testable import SentientApp

// Pins CycleErrorRecovery.lastUserText(in:) — the derivation that decides which
// message Retry resends (and whether Retry shows at all) when a cycle aborts
// unsolicited (SdkState.lastCycleError). The contract: the MOST RECENT user turn
// wins; assistant/tool entries are skipped; a blank-after-trim entry counts as
// "nothing to resend" (nil) so Retry never fires an empty send.
struct CycleErrorRecoveryTests {
    private func msg(_ role: String, _ content: String, ts: Int64 = 0) -> ChatMessage {
        ChatMessage(ts: ts, role: role, content: content, streaming: false,
                    cutoffKind: nil, turnId: nil, replyId: nil, pendingId: nil, entryId: "")
    }

    @Test func returnsLastUserText() {
        let messages = [
            msg("user", "first question"),
            msg("assistant", "first answer"),
            msg("user", "second question"),
        ]
        #expect(CycleErrorRecovery.lastUserText(in: messages) == "second question")
    }

    @Test func skipsTrailingAssistantTurn() {
        // The aborted cycle may have committed a partial assistant bubble; the
        // resend target is still the user turn that preceded it.
        let messages = [
            msg("user", "what's the weather"),
            msg("assistant", "partial..."),
        ]
        #expect(CycleErrorRecovery.lastUserText(in: messages) == "what's the weather")
    }

    @Test func trimsWhitespace() {
        #expect(CycleErrorRecovery.lastUserText(in: [msg("user", "  hi  ")]) == "hi")
    }

    @Test func blankUserTurnYieldsNil() {
        // A whitespace-only user entry is nothing to resend ⇒ Retry omitted.
        #expect(CycleErrorRecovery.lastUserText(in: [msg("user", "   ")]) == nil)
    }

    @Test func blankMostRecentUserTurnYieldsNilWithoutFallingThrough() {
        // The MOST RECENT user turn wins even when it's blank-after-trim: the
        // derivation returns on the first user hit in reverse and blank-trims to
        // nil. It must NOT skip past the blank turn to an earlier non-blank one.
        let messages = [
            msg("user", "real question"),
            msg("assistant", "..."),
            msg("user", "   "),
        ]
        #expect(CycleErrorRecovery.lastUserText(in: messages) == nil)
    }

    @Test func noUserTurnYieldsNil() {
        // Only assistant turns (or empty history) ⇒ no Retry.
        #expect(CycleErrorRecovery.lastUserText(in: [msg("assistant", "hi there")]) == nil)
        #expect(CycleErrorRecovery.lastUserText(in: []) == nil)
    }
}
