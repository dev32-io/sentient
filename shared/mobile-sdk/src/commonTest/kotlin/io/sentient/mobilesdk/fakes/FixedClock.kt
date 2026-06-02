// ---------------------------------------------------------------------------
// FixedClock — Clock test double with a mutable nowMs.
//
// Lets tests advance time deterministically: set nowMs before calling the
// SUT, then assert time-dependent behavior without real delays.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.fakes

import io.sentient.mobilesdk.util.Clock

/**
 * Settable [Clock] for use in commonTest.
 *
 * @param initialMs Starting timestamp in milliseconds since the Unix epoch.
 *   Defaults to 0 so tests that don't care about the initial value still compile.
 *
 * Usage:
 * ```kotlin
 * val clock = FixedClock(1_000L)
 * val sut = MyComponent(clock)
 * clock.nowMs = 5_000L   // advance time
 * assertEquals(4_000L, sut.elapsedMs())
 * ```
 */
class FixedClock(initialMs: Long = 0L) : Clock {

    /** Mutable current time. Set this in tests to control the clock. */
    var nowMs: Long = initialMs

    override fun nowMs(): Long = nowMs

    /** Advances [nowMs] by [deltaMs] and returns the new value. */
    fun advance(deltaMs: Long): Long {
        nowMs += deltaMs
        return nowMs
    }
}
