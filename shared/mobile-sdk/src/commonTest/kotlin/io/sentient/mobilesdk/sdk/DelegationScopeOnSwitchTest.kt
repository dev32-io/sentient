// ---------------------------------------------------------------------------
// DelegationScopeOnSwitchTest — pins the SCOPE invariant for background-delegation
// rows (design §5.4 / §7): a delegation belongs to the CONVERSATION, not to the
// turn that dispatched it, and it must never outlive the conversation on screen.
//
// KEEPER (per .claude/rules/testing.md): invariant with a real failure mode. The
// rows are keyed by taskId alone and TERMINAL ROWS ARE RETAINED by design, so
// nothing else ever retires them — a missed clear on one entry point leaks
// conversation A's background tasks into conversation B's UI permanently (B never
// emits a delegation.progress of its own to overwrite them). The clear had been
// wired to the awaited `switchSession`, which no screen calls, while the path the
// UI actually takes (SwitchConversationUseCase → switchToFireAndForget →
// sendSwitchSession) skipped it. Both directions are pinned here: leaving the
// conversation clears, staying in it (interrupt) does NOT.
//
// Drives the REAL orchestrator over a FakeWebSocketEngine under runTest virtual
// time — no platform, no real waits.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.sdk

import io.sentient.mobilesdk.fakes.FakeWebSocketEngine
import io.sentient.mobilesdk.transport.WsIncoming
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals

class DelegationScopeOnSwitchTest {

    /** delegation.progress for an in-flight delegateTask dispatched by turn t1. */
    private fun progressFrame(taskId: String) =
        "{\"type\":\"delegation.progress\",\"taskId\":\"$taskId\",\"turnId\":\"t1\"," +
            "\"agent\":\"hermes\",\"status\":\"running\"}"

    /** Reach READY and land one running delegation row in the current conversation. */
    private suspend fun TestScope.readyWithDelegation(sdk: SentientSdk, fake: FakeWebSocketEngine) {
        connectToReady(sdk, fake)
        fake.emit(WsIncoming.Text(progressFrame("task-9")))
        sdk.delegations.first { it.isNotEmpty() }
        assertEquals("task-9", sdk.delegations.value.single().taskId, "precondition: conversation A has a delegation row")
    }

    @Test
    fun fire_and_forget_switch_drops_the_previous_conversations_delegation_rows() = runTest {
        val fake = FakeWebSocketEngine()
        val sdk = buildSdk(fake)
        readyWithDelegation(sdk, fake)

        // The path the session list actually takes when a DIFFERENT existing chat is tapped.
        sdk.sendSwitchSession("conv-b")

        assertEquals(emptyList(), sdk.delegations.value, "conversation A's delegation rows must not follow the switch")
    }

    @Test
    fun fire_and_forget_new_chat_drops_the_previous_conversations_delegation_rows() = runTest {
        val fake = FakeWebSocketEngine()
        val sdk = buildSdk(fake)
        readyWithDelegation(sdk, fake)

        sdk.sendNewChat()

        assertEquals(emptyList(), sdk.delegations.value, "a fresh chat starts with no background-task rows")
    }

    @Test
    fun interrupt_keeps_the_delegation_rows_of_the_conversation_it_stays_in() = runTest {
        val fake = FakeWebSocketEngine()
        val sdk = buildSdk(fake)
        readyWithDelegation(sdk, fake)

        // UI Stop clears TURN-scoped state only. Folding the delegation clear into
        // clearActiveToIdle (which interrupt and the stuck watchdog also drive) would
        // blank the rows of the conversation still on screen.
        sdk.interrupt()

        assertEquals("task-9", sdk.delegations.value.single().taskId, "interrupt is not a conversation change")
    }
}
