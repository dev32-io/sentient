package io.sentient.android.chat

import io.sentient.android.chat.banner.CycleErrorRecovery
import io.sentient.mobilesdk.sdk.ChatMessage
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * Pins the cycle-error Retry derivation (parity with iOS
 * CycleErrorRecovery.lastUserText). Retry resends the most recent NON-BLANK user
 * turn; absence of one omits the Retry button so it never fires an empty send.
 */
class CycleErrorRecoveryTest {
    private fun user(ts: Long, content: String) = ChatMessage(ts = ts, role = "user", content = content)
    private fun assistant(ts: Long, content: String) =
        ChatMessage(ts = ts, role = "assistant", content = content)

    @Test fun `no messages yields null`() {
        assertNull(CycleErrorRecovery.lastUserText(emptyList()))
    }

    @Test fun `no user turn yields null`() {
        val msgs = listOf(assistant(1, "hi"), ChatMessage(ts = 2, role = "tool", content = "x"))
        assertNull(CycleErrorRecovery.lastUserText(msgs))
    }

    @Test fun `returns the most recent user turn`() {
        val msgs = listOf(user(1, "first"), assistant(2, "reply"), user(3, "second"))
        assertEquals("second", CycleErrorRecovery.lastUserText(msgs))
    }

    @Test fun `trims surrounding whitespace`() {
        assertEquals("hello", CycleErrorRecovery.lastUserText(listOf(user(1, "  hello \n"))))
    }

    @Test fun `blank-after-trim user turn yields null`() {
        // A whitespace-only last user turn counts as nothing to resend.
        assertNull(CycleErrorRecovery.lastUserText(listOf(user(1, "real"), user(2, "   "))))
    }

    @Test fun `ignores assistant turn after the user turn`() {
        val msgs = listOf(user(1, "ask"), assistant(2, "answer"))
        assertEquals("ask", CycleErrorRecovery.lastUserText(msgs))
    }
}
