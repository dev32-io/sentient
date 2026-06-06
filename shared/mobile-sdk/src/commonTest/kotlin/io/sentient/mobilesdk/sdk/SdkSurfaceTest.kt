package io.sentient.mobilesdk.sdk

import io.sentient.mobilesdk.fakes.FixedClock
import io.sentient.mobilesdk.transport.SdkStatus
import kotlin.test.Test
import kotlin.test.assertEquals

class SdkSurfaceTest {
    @Test
    fun deriveConnection_projects_connection_axis() {
        val d = StateDeriver(FixedClock(1000L))
        d.status = SdkStatus.READY
        d.hasSession = true
        d.voiceMode = VoiceMode.ACTIVE
        val c = d.deriveConnection()
        assertEquals(SdkStatus.READY, c.status)
        assertEquals(true, c.hasSession)
        assertEquals(VoiceMode.ACTIVE, c.voiceMode)
    }
}
