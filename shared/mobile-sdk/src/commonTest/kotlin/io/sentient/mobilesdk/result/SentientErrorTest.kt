package io.sentient.mobilesdk.result

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class SentientErrorTest {
    @Test
    fun connectionError_is_internally_retryable() {
        val e = SentientError.Connection(userMessage = "Connection lost")
        assertEquals(ErrorKind.CONNECTION, e.kind)
        assertTrue(e.recoverable)
        assertEquals(RetryPolicy.Internal, e.retry)
    }

    @Test
    fun authExpired_is_terminal_not_recoverable() {
        val e = SentientError.Auth(userMessage = "Session expired", terminal = true)
        assertFalse(e.recoverable)
        assertEquals(RetryPolicy.None, e.retry)
    }

    @Test
    fun timeout_prompts_user_retry() {
        val e = SentientError.Timeout(userMessage = "Took too long")
        assertEquals(RetryPolicy.UserPrompt, e.retry)
    }
}
