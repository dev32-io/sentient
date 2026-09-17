package io.sentient.mobiledata.data.scheduling

import io.sentient.mobiledata.result.SentientResult
import io.sentient.mobilesdk.auth.AuthError
import io.sentient.mobilesdk.auth.AuthResult
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs

class ScheduleErrorMapperTest {
    @Test fun networkFailureDoesNotClaimMutationOutcome() {
        val result = AuthResult.Failure(AuthError.Network("response-lost")).toScheduleResult<Unit>()

        val message = assertIs<SentientResult.Failure>(result).error.userMessage
        assertEquals("Connection lost before the scheduling request outcome was confirmed. Reload to verify current state.", message)
        assertFalse(message.contains("not saved"))
        assertFalse(message.contains("not cleared"))
    }
}
