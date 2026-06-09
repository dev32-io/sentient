// ---------------------------------------------------------------------------
// Clock — injectable wall-clock boundary for deterministic testing.
//
// Callers must NEVER use System.currentTimeMillis() / kotlin.time directly
// in business logic. Inject Clock and use nowMs() so commonTest can control
// time with FixedClock without platform dependencies.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.util

/**
 * Monotonic-safe wall-clock abstraction.
 *
 * Production: `Clock { System.currentTimeMillis() }` (or platform equivalent).
 * Test: [io.sentient.mobilesdk.fakes.FixedClock] with a settable [nowMs].
 *
 * Declared as a functional interface so a lambda can be used at call sites:
 * ```kotlin
 * val clock: Clock = Clock { System.currentTimeMillis() }
 * ```
 */
fun interface Clock {
    /** Returns current time in milliseconds since the Unix epoch. */
    fun nowMs(): Long
}
