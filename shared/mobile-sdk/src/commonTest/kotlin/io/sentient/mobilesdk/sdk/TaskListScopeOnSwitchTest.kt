// ---------------------------------------------------------------------------
// TaskListScopeOnSwitchTest — pins the SCOPE invariant for the composer task
// strip's mirror (SentientSdk.tasks): rows belong to the CONVERSATION on
// screen and must not survive a switch to another one.
//
// KEEPER (per .claude/rules/testing.md): invariant with a real, gateway-traced
// failure mode. The gateway's `tasklist.state` is a per-SessionRuntime
// projector (gateway/src/runtime/session-runtime.ts) that only re-emits on
// its OWN mutations (turn start / tool update / delegation progress / turn
// end) — `conversation.activate` triggers no resync push. Without a clear on
// every leave-the-conversation entry point, switching to a conversation with
// no task activity of its own leaves the client holding the PREVIOUS
// conversation's last-known rows forever — the exact bug class
// DelegationScopeOnSwitchTest pins for delegation rows, now closed the same
// way for tasks (TaskListConnector.clear(), called from
// SentientSdk.clearConversationScopedState alongside connectors.delegation.clear()).
//
// Drives the REAL orchestrator over a FakeWebSocketEngine under runTest
// virtual time — no platform, no real waits.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.sdk

import io.sentient.mobilesdk.fakes.FakeWebSocketEngine
import io.sentient.mobilesdk.transport.WsIncoming
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals

class TaskListScopeOnSwitchTest {

    /** tasklist.state carrying one running row for the current turn. */
    private fun taskListFrame(id: String) =
        "{\"type\":\"tasklist.state\",\"turnId\":\"t1\",\"items\":[" +
            "{\"id\":\"$id\",\"toolName\":\"search\",\"status\":\"running\"}]}"

    /** Reach READY and land one running task row in the current conversation. */
    private suspend fun TestScope.readyWithTask(sdk: SentientSdk, fake: FakeWebSocketEngine) {
        connectToReady(sdk, fake)
        fake.emit(WsIncoming.Text(taskListFrame("call-9")))
        sdk.tasks.first { it.isNotEmpty() }
        assertEquals("call-9", sdk.tasks.value.single().id, "precondition: conversation A has a task row")
    }

    @Test
    fun fire_and_forget_switch_drops_the_previous_conversations_task_rows() = runTest {
        val fake = FakeWebSocketEngine()
        val sdk = buildSdk(fake)
        readyWithTask(sdk, fake)

        // The path the session list actually takes when a DIFFERENT existing chat is tapped.
        sdk.sendSwitchSession("conv-b")

        assertEquals(emptyList(), sdk.tasks.value, "conversation A's task rows must not follow the switch")
    }

    @Test
    fun fire_and_forget_new_chat_drops_the_previous_conversations_task_rows() = runTest {
        val fake = FakeWebSocketEngine()
        val sdk = buildSdk(fake)
        readyWithTask(sdk, fake)

        sdk.sendNewChat()

        assertEquals(emptyList(), sdk.tasks.value, "a fresh chat starts with no task rows")
    }

    @Test
    fun interrupt_keeps_the_task_rows_of_the_conversation_it_stays_in() = runTest {
        val fake = FakeWebSocketEngine()
        val sdk = buildSdk(fake)
        readyWithTask(sdk, fake)

        // UI Stop clears TURN-scoped state only. Folding the task-list clear into
        // clearActiveToIdle (which interrupt and the stuck watchdog also drive) would
        // blank the strip of the conversation still on screen.
        sdk.interrupt()

        assertEquals("call-9", sdk.tasks.value.single().id, "interrupt is not a conversation change")
    }
}
