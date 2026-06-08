package io.sentient.android.splash

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class SplashGateTest {
    @Test
    fun visibleBeforeMinElapsed() {
        // 1999 ms elapsed — still under the 2000 ms floor → must stay visible.
        assertTrue(splashVisible(shownAtMs = 0L, nowMs = 1_999L, ready = true))
    }

    @Test
    fun hiddenAfterMinWhenReady() {
        // 2001 ms elapsed AND backend ready → overlay should dismiss.
        assertFalse(splashVisible(shownAtMs = 0L, nowMs = 2_001L, ready = true))
    }

    @Test
    fun stayVisibleWhileNotReadyPastMin() {
        // 5000 ms elapsed but backend NOT ready → must stay visible.
        assertTrue(splashVisible(shownAtMs = 0L, nowMs = 5_000L, ready = false))
    }
}
