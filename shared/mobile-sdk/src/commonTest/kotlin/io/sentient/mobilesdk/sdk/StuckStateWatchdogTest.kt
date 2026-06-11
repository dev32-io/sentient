package io.sentient.mobilesdk.sdk

import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlin.test.Test
import kotlin.test.assertEquals

class StuckStateWatchdogTest {
    @Test
    fun fires_after_timeout_when_armed() = runTest {
        var fired = 0
        val wd = StuckStateWatchdog(
            timeoutMs = 8_000L,
            scope = backgroundScope,
            delayFn = { kotlinx.coroutines.delay(it) },
            onTimeout = { fired++ },
        )
        wd.arm()
        advanceTimeBy(7_999L); runCurrent()
        assertEquals(0, fired)
        advanceTimeBy(2L); runCurrent()
        assertEquals(1, fired)
    }

    @Test
    fun disarm_cancels_before_timeout() = runTest {
        var fired = 0
        val wd = StuckStateWatchdog(8_000L, backgroundScope, { kotlinx.coroutines.delay(it) }) { fired++ }
        wd.arm()
        advanceTimeBy(5_000L); runCurrent()
        wd.disarm()
        advanceTimeBy(10_000L); runCurrent()
        assertEquals(0, fired)
    }

    @Test
    fun re_arm_supersedes_prior_timer() = runTest {
        var fired = 0
        val wd = StuckStateWatchdog(8_000L, backgroundScope, { kotlinx.coroutines.delay(it) }) { fired++ }
        wd.arm()
        advanceTimeBy(6_000L); runCurrent()
        wd.arm() // supersede: restarts the 8s window
        advanceTimeBy(6_000L); runCurrent()
        assertEquals(0, fired) // prior timer must NOT have fired
        advanceTimeBy(2_001L); runCurrent()
        assertEquals(1, fired)
    }
}
