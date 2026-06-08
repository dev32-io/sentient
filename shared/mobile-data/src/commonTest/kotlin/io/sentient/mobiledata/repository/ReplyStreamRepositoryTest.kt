package io.sentient.mobiledata.repository

import io.sentient.mobilesdk.connectors.TaskSnapshotItem
import io.sentient.mobilesdk.protocol.SdkEvent
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * ReplyStreamRepository — the conversation-switch reset of the live in-flight reply.
 * (The reveal/drain mechanics themselves are pinned in [LiveRevealReducerTest].)
 * Pins: a session switch drops the in-flight reply so it never leaks into the next
 * conversation, and the coordinator is notified to clear sibling state.
 */
class ReplyStreamRepositoryTest {

    // ── Session switch — drop the in-flight reply (the leak fix) ──────────────

    @Test
    fun reduce_session_switched_drops_live_and_tasks() {
        var s = LiveState()
        s = ReplyStreamRepository.reduce(s, SdkEvent.MessageStarted("c1"))
        s = ReplyStreamRepository.reduce(s, SdkEvent.MessageDelta("c1", "partial reply"))
        s = ReplyStreamRepository.reduce(s, SdkEvent.TaskUpserted(TaskSnapshotItem("t1", "search", "c1", "running", "{}", 1L)))
        assertTrue(s.live != null)
        assertEquals(1, s.tasks.size)
        // conversation switches mid-reply → the whole live bubble + tasks are dropped
        s = ReplyStreamRepository.reduce(s, SdkEvent.SessionSwitched("session-2"))
        assertNull(s.live)
        assertTrue(s.tasks.isEmpty())
    }

    // ── Flow integration — session switch resets live + notifies coordinator ──

    @Test
    fun session_switched_event_resets_live_and_fires_callback() = runTest(UnconfinedTestDispatcher()) {
        val events = MutableSharedFlow<SdkEvent>(extraBufferCapacity = 64)
        var switchedCount = 0
        val repo = ReplyStreamRepository(
            events = events,
            scope = backgroundScope,
            onSessionSwitched = { switchedCount++ },
        )
        events.emit(SdkEvent.MessageStarted("c1"))
        events.emit(SdkEvent.MessageDelta("c1", "partial"))
        advanceUntilIdle()
        assertTrue(repo.live.value.live != null, "live bubble should exist mid-reply")

        events.emit(SdkEvent.SessionSwitched("session-2"))
        advanceUntilIdle()
        assertNull(repo.live.value.live, "live must reset on session switch")
        assertEquals(1, switchedCount, "coordinator must be notified to clear sibling state")
    }
}
