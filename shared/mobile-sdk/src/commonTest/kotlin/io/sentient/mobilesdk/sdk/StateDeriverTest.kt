// ---------------------------------------------------------------------------
// StateDeriverTest — pendingId read-through in StateDeriver.
//
// The committed/live tile-merge this file used to pin (StateDeriverToolsTest)
// was retired by the tile-derivation-strip task: tool activity no longer folds
// into the chat list at all — it renders in the composer task strip off
// `tasklist.state` (TaskListConnector). The follow-on pin that a committed
// kind:"tool" feed item produced no row went with the feed item itself: there
// is no tool item on the wire any more, so there is nothing left to exclude.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.sdk

import io.sentient.mobilesdk.connectors.CognitionState
import io.sentient.mobilesdk.connectors.InFlightMessage
import io.sentient.mobilesdk.protocol.ConversationFeedItem
import kotlin.test.Test
import kotlin.test.assertEquals

class StateDeriverTest {
    @Test
    fun deriveMessages_propagates_pendingId_on_user_entries() {
        val d = StateDeriver(io.sentient.mobilesdk.fakes.FixedClock(1000L))
        d.applyFeed(listOf(
            ConversationFeedItem.User(ts = 1L, channel = "text", content = "hi", pendingId = "p1"),
        ))
        val msgs = d.deriveTimeline()
        val user = msgs.first { it.role == "user" }
        assertEquals("p1", user.pendingId)
    }

    @Test
    fun assistantActivity_covers_preToken_stream_and_committedTtsTail() {
        val d = StateDeriver(io.sentient.mobilesdk.fakes.FixedClock(1000L))

        d.applyInflight(InFlightMessage("t1", ""))
        d.applyCognitionActivity(CognitionState.THINKING, "t1")
        assertEquals(AssistantActivityState(AssistantActivityPhase.THINKING, "t1", null), d.deriveAssistantActivity())

        d.applyInflight(InFlightMessage("t1", "hello", "r1"))
        assertEquals(AssistantActivityState(AssistantActivityPhase.RESPONDING, "t1", "r1"), d.deriveAssistantActivity())

        d.applyFeed(listOf(ConversationFeedItem.Assistant(content = "hello", turnId = "t1", replyId = "r1")))
        d.applyInflight(null)
        d.applyCognitionActivity(CognitionState.IDLE, null)
        d.isSpeaking = true
        d.applyAudioTurn("t1")
        assertEquals(AssistantActivityState(AssistantActivityPhase.RESPONDING, "t1", "r1"), d.deriveAssistantActivity())
    }

    @Test
    fun committed_older_reply_does_not_replace_newer_inflight_reply_in_same_turn() {
        val d = StateDeriver(io.sentient.mobilesdk.fakes.FixedClock(1000L))
        d.applyCognitionActivity(CognitionState.THINKING, "t1")
        d.applyInflight(InFlightMessage("t1", "new", "r2"))

        d.applyFeed(listOf(
            ConversationFeedItem.Assistant(content = "old", turnId = "t1", replyId = "r1"),
        ))
        d.applyInflight(null)
        d.applyCognitionActivity(CognitionState.IDLE, null)
        d.isSpeaking = true
        d.applyAudioTurn("t1")

        assertEquals(AssistantActivityState(AssistantActivityPhase.RESPONDING, "t1", "r2"), d.deriveAssistantActivity())

        d.applyFeed(listOf(
            ConversationFeedItem.Assistant(content = "old", turnId = "t1", replyId = "r1"),
            ConversationFeedItem.Assistant(content = "new", turnId = "t1", replyId = "r2"),
        ))
        assertEquals(AssistantActivityState(AssistantActivityPhase.RESPONDING, "t1", "r2"), d.deriveAssistantActivity())
    }

    @Test
    fun newerCognition_suppresses_oldAudio_and_fences_after_clear() {
        val d = StateDeriver(io.sentient.mobilesdk.fakes.FixedClock(1000L))
        d.applyInflight(InFlightMessage("t1", "old", "r1"))
        d.isSpeaking = true
        d.applyAudioTurn("t1")

        d.applyInflight(InFlightMessage("t2", ""))
        d.applyCognitionActivity(CognitionState.THINKING, "t2")
        assertEquals(AssistantActivityState(AssistantActivityPhase.THINKING, "t2", null), d.deriveAssistantActivity())

        d.applyCognitionActivity(CognitionState.IDLE, null)
        assertEquals(AssistantActivityState(), d.deriveAssistantActivity(), "old t1 audio cannot reclaim newer t2")

        d.clearAssistantActivity()
        assertEquals(AssistantActivityState(), d.deriveAssistantActivity(), "interrupt/reconnect/session fence clears owner")
    }
}
