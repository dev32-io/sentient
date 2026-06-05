package io.sentient.android.chat

import io.sentient.mobilesdk.transport.SdkStatus
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * Pins the connection-banner FSM (parity with iOS ConnectionBannerState.derive).
 * The mobile-sdk keeps `connectionLost` true through the entire reconnect loop
 * (cleared only on READY), so STATUS — not connectionLost — discriminates
 * "reconnecting" (mid-backoff) from "lost" (exhausted / terminal).
 */
class ConnectionBannerStateTest {
    private fun derive(status: SdkStatus, lost: Boolean) =
        ConnectionBannerState.derive(status, lost)

    @Test fun `healthy ready with no drop shows no banner`() {
        assertNull(derive(SdkStatus.READY, lost = false))
    }

    @Test fun `first connect in flight without a drop shows no banner`() {
        // connectionLost is false on a normal first connect, so no banner even
        // though status is mid-handshake.
        assertNull(derive(SdkStatus.CONNECTING, lost = false))
        assertNull(derive(SdkStatus.AUTHENTICATING, lost = false))
    }

    @Test fun `mid-backoff statuses while lost show Reconnecting`() {
        assertEquals(ConnectionBannerState.RECONNECTING, derive(SdkStatus.RECONNECTING, lost = true))
        assertEquals(ConnectionBannerState.RECONNECTING, derive(SdkStatus.CONNECTING, lost = true))
        assertEquals(ConnectionBannerState.RECONNECTING, derive(SdkStatus.AUTHENTICATING, lost = true))
    }

    @Test fun `disconnected while lost is reconnect-exhausted and shows Lost`() {
        assertEquals(ConnectionBannerState.LOST, derive(SdkStatus.DISCONNECTED, lost = true))
    }

    @Test fun `error status shows Lost even when connectionLost is false`() {
        // Terminal ERROR (auth failure / ready timeout) is unhealthy on its own.
        assertEquals(ConnectionBannerState.LOST, derive(SdkStatus.ERROR, lost = false))
        assertEquals(ConnectionBannerState.LOST, derive(SdkStatus.ERROR, lost = true))
    }

    @Test fun `ready clears the banner even if lost is still latched`() {
        // setStatus(READY) clears connectionLost, but defend the mapping anyway.
        assertNull(derive(SdkStatus.READY, lost = true))
    }
}
