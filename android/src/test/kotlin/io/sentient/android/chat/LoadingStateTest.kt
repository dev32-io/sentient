package io.sentient.android.chat

import io.sentient.mobilesdk.transport.SdkStatus
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * Pins the loading-affordance policy: what the inline LoadingPill shows vs.
 * when the ConnectionBanner owns the reconnect UX.
 */
class LoadingStateTest {

    @Test fun `connectingWhenNotReadyNoBanner`() {
        assertEquals(
            LoadingAffordance.CONNECTING,
            loadingAffordance(
                status = SdkStatus.CONNECTING,
                connectionLost = false,
                hasPending = false,
            ),
        )
    }

    @Test fun `sendingWhenPending`() {
        // hasPending=true overrides status — any status yields SENDING.
        assertEquals(
            LoadingAffordance.SENDING,
            loadingAffordance(
                status = SdkStatus.CONNECTING,
                connectionLost = false,
                hasPending = true,
            ),
        )
    }

    @Test fun `noneWhenReadyIdle`() {
        assertEquals(
            LoadingAffordance.NONE,
            loadingAffordance(
                status = SdkStatus.READY,
                connectionLost = false,
                hasPending = false,
            ),
        )
    }

    @Test fun `bannerOwnsReconnect`() {
        // When connectionLost=true, ConnectionBanner shows RECONNECTING — we return NONE.
        assertEquals(
            LoadingAffordance.NONE,
            loadingAffordance(
                status = SdkStatus.RECONNECTING,
                connectionLost = true,
                hasPending = false,
            ),
        )
    }
}
