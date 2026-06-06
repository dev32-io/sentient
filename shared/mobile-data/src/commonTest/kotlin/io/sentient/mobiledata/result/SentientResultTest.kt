package io.sentient.mobiledata.result

import io.sentient.mobilesdk.result.SentientError
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class SentientResultTest {
    @Test
    fun loading_can_carry_partial() {
        val r: SentientResult<List<Int>> = SentientResult.Loading(partial = listOf(1, 2))
        assertEquals(listOf(1, 2), (r as SentientResult.Loading).partial)
    }

    @Test
    fun loading_partial_optional() {
        val r = SentientResult.Loading<List<Int>>()
        assertNull(r.partial)
    }

    @Test
    fun failure_holds_error() {
        val r: SentientResult<Int> = SentientResult.Failure(SentientError.Timeout("slow"))
        assertEquals("slow", (r as SentientResult.Failure).error.userMessage)
    }
}
