package io.sentient.mobiledata.usecase

import io.sentient.mobilesdk.protocol.SdkEvent
import io.sentient.mobilesdk.sdk.ChatMessage
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class RevealReducerTest {
    private val C = "turn-1"

    @Test fun delta_accumulates_full_reveal_lags() {
        var s = RevealReducer.reduce(RevealState(), SdkEvent.MessageStarted(C))
        s = RevealReducer.reduce(s, SdkEvent.MessageDelta(C, "Hello world"))
        assertEquals("Hello world", s.bubble?.fullContent)
        assertEquals(0, s.bubble?.revealed)
        assertEquals("", s.visibleContent())
    }

    @Test fun tick_advances_toward_full() {
        var s = RevealReducer.reduce(RevealState(), SdkEvent.MessageStarted(C))
        s = RevealReducer.reduce(s, SdkEvent.MessageDelta(C, "abcdefghij"))
        s = RevealReducer.reduce(s, RevealTick(1_000))
        s = RevealReducer.reduce(s, RevealTick(1_100))
        assertTrue((s.bubble?.revealed ?: 0) in 1..10)
        assertEquals(s.bubble?.revealed, s.visibleContent().length)
    }

    @Test fun commit_drains_then_nulls() {
        var s = RevealReducer.reduce(RevealState(), SdkEvent.MessageStarted(C))
        s = RevealReducer.reduce(s, SdkEvent.MessageDelta(C, "abcde"))
        s = RevealReducer.reduce(s, SdkEvent.MessageCommitted(ChatMessage(ts = 1, role = "assistant", content = "abcde", turnId = C)))
        assertEquals(LivePhase.DRAINING, s.bubble?.phase)
        s = RevealReducer.reduce(s, RevealTick(1_000))
        s = RevealReducer.reduce(s, RevealTick(5_000))
        assertNull(s.bubble)
    }

    @Test fun multiple_deltas_accumulate_without_loss() {
        var s = RevealReducer.reduce(RevealState(), SdkEvent.MessageStarted(C))
        s = RevealReducer.reduce(s, SdkEvent.MessageDelta(C, "He"))
        s = RevealReducer.reduce(s, SdkEvent.MessageDelta(C, "llo "))
        s = RevealReducer.reduce(s, SdkEvent.MessageDelta(C, "world"))
        assertEquals("Hello world", s.bubble?.fullContent)
    }

    // -----------------------------------------------------------------------
    // Termination. ObserveChatUseCase hides the one committed row whose replyId
    // matches the live bubble's, so a bubble that cannot reach null hides that
    // reply's durable history — its text and its interrupted marker — for as
    // long as the screen lives. These pin the exits.
    // -----------------------------------------------------------------------

    /** The reveal must not stall. At a 16 ms tick the streaming rate is worth
     *  well under one character, and truncating that to an Int per tick earned
     *  a permanent zero once the gap closed — the bubble froze mid-sentence in
     *  STREAMING, where `done` is unreachable, and never cleared. */
    @Test fun reveal_progresses_on_ticks_shorter_than_one_character() {
        var s = RevealReducer.reduce(RevealState(), SdkEvent.MessageStarted(C))
        s = RevealReducer.reduce(s, SdkEvent.MessageDelta(C, "a".repeat(80)))
        // One coarse tick closes most of the gap, so the rate that follows is
        // below the ~62.5 chars/s a 16 ms tick needs to earn a whole character.
        // (The FIRST tick is always dt=0 — lastTickMs starts at 0 — so both of
        // these carry a non-zero clock or nothing advances at all.)
        s = RevealReducer.reduce(s, RevealTick(1_000))
        s = RevealReducer.reduce(s, RevealTick(1_400))
        val stalled = s.bubble?.revealed ?: 0
        assertTrue(stalled in 1..79, "expected a partial reveal, got $stalled")

        // 16 ms ticks from here each earn a fraction of a character.
        var now = 1_400L
        repeat(200) {
            now += 16
            s = RevealReducer.reduce(s, RevealTick(now))
        }
        assertTrue((s.bubble?.revealed ?: 0) > stalled, "reveal stalled at $stalled")
    }

    /** An aborted turn emits no MessageCommitted at all (see
     *  InFlightMessageConnector.onAborted), so without its own case the bubble
     *  never entered DRAINING and never cleared. */
    @Test fun abort_clears_the_bubble() {
        var s = RevealReducer.reduce(RevealState(), SdkEvent.MessageStarted(C))
        s = RevealReducer.reduce(s, SdkEvent.MessageDelta(C, "half a sen"))
        s = RevealReducer.reduce(s, SdkEvent.TurnAborted(C, "interrupt"))
        assertNull(s.bubble)
    }

    @Test fun abort_of_another_turn_leaves_this_bubble_alone() {
        var s = RevealReducer.reduce(RevealState(), SdkEvent.MessageStarted(C))
        s = RevealReducer.reduce(s, SdkEvent.MessageDelta(C, "mine"))
        s = RevealReducer.reduce(s, SdkEvent.TurnAborted("turn-other", "interrupt"))
        assertEquals("mine", s.bubble?.fullContent)
    }

    /** TurnDone rides the same turn.completed frame from a different connector,
     *  so it drains even when InFlightMessageConnector held no buffer to commit. */
    @Test fun turn_done_drains_when_message_committed_never_arrives() {
        var s = RevealReducer.reduce(RevealState(), SdkEvent.MessageStarted(C))
        s = RevealReducer.reduce(s, SdkEvent.MessageDelta(C, "abcde"))
        s = RevealReducer.reduce(s, SdkEvent.TurnDone(C))
        assertEquals(LivePhase.DRAINING, s.bubble?.phase)
        s = RevealReducer.reduce(s, RevealTick(1_000))
        s = RevealReducer.reduce(s, RevealTick(5_000))
        assertNull(s.bubble)
    }
}
