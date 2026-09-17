package io.sentient.mobiledata.data.push

import io.sentient.mobiledata.result.SentientResult
import io.sentient.mobilesdk.auth.AuthError
import io.sentient.mobilesdk.auth.AuthResult
import io.sentient.mobilesdk.result.ErrorKind
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs

class PushErrorMapperTest {
    @Test fun `conflict uses push preference message`() {
        val result = AuthResult.Failure(AuthError.Server(409, """{"error":{"code":"conflict"}}""")).toPushResult<Unit>()
        val error = assertIs<SentientResult.Failure>(result).error
        assertEquals(ErrorKind.PROTOCOL, error.kind)
        assertEquals("Notification settings changed elsewhere. Review the latest settings and try again.", error.userMessage)
    }

    @Test fun `provider failure stays distinct from preference conflict`() {
        val result = AuthResult.Failure(AuthError.Server(503, """{"error":{"code":"provider_unavailable"}}""")).toPushResult<Unit>()
        val error = assertIs<SentientResult.Failure>(result).error
        assertEquals(ErrorKind.CONNECTION, error.kind)
        assertEquals("Push delivery provider is unavailable.", error.userMessage)
    }
}
