package io.sentient.mobilesdk.sdk

import io.sentient.mobilesdk.connectors.InFlightMessage
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

    @Test
    fun deriveTimeline_excludes_live_inflight() {
        val d = StateDeriver(io.sentient.mobilesdk.fakes.FixedClock(1000L))
        d.inflight = InFlightMessage(cycleId = "c9", text = "streaming...")
        // timeline is committed-only: the live bubble text must not appear
        val timeline = d.deriveTimeline()
        assertEquals(false, timeline.any { it.content == "streaming..." && it.streaming })
    }
}
