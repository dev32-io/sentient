package io.sentient.mobilesdk.sdk

import io.sentient.mobilesdk.transport.SdkStatus
import kotlin.test.Test
import kotlin.test.assertEquals

class ConnectionStateTest {
    @Test
    fun defaults_are_disconnected_and_clean() {
        val c = ConnectionState()
        assertEquals(SdkStatus.DISCONNECTED, c.status)
        assertEquals(false, c.hasSession)
        assertEquals(false, c.connectionLost)
        assertEquals(false, c.authExpired)
        assertEquals(VoiceMode.OFF, c.voiceMode)
    }
}
