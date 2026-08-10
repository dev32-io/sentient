package io.sentient.android.chat

import io.sentient.mobilesdk.connectors.PermissionPrompt
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

// Pins ChatViewModel's local-timeout-fallback guard (design spec §7.1): the
// defensive job that clears a stale/lost permission prompt must never clobber a
// NEWER prompt that has since replaced the one it was armed for. Mirrors Task 9's
// iOS PermissionPromptFSMTests.localTimeoutFiredStaleIdIsNoOp / resolvedStaleIdIsNoOp.
private fun prompt(id: String) = PermissionPrompt(
    requestId = id,
    toolCallId = "call-$id",
    toolName = "assistant_signal_send_message",
    args = mapOf("body" to "On my way"),
    description = "Send a Signal message",
    expiresAtMs = 0,
)

class PermissionPromptGuardTest {

    @Test
    fun `matching requestId clears`() {
        assertTrue(shouldClearOnLocalTimeout(prompt("req-1"), "req-1"))
    }

    @Test
    fun `stale requestId does not clobber a newer pending request`() {
        assertFalse(shouldClearOnLocalTimeout(prompt("req-2"), "req-1"))
    }

    @Test
    fun `no pending request is never cleared by a late timeout fire`() {
        assertFalse(shouldClearOnLocalTimeout(null, "req-1"))
    }
}
