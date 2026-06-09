// ---------------------------------------------------------------------------
// ReconnectBackoffTest — ports the backoff math from web-sdk sdk-reconnect.ts.
//
// Pins the invariant that computeBackoffMs mirrors the web-sdk formula:
//   base * 2^(attempt-1), capped at maxMs, plus additive jitter.
//
// Jitter is injected (0.0) for determinism. Production passes Random.nextDouble().
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.transport

import kotlin.test.Test
import kotlin.test.assertTrue

class ReconnectBackoffTest {
    private val cfg = ReconnectConfig() // defaults

    @Test
    fun backoff_is_exponential_capped() {
        assertTrue(computeBackoffMs(1, cfg, jitter = 0.0) == 1000L)
        assertTrue(computeBackoffMs(3, cfg, jitter = 0.0) == 4000L)
        assertTrue(computeBackoffMs(20, cfg, jitter = 0.0) == 30_000L)
    }

    @Test
    fun backoff_jitter_adds_to_capped_value() {
        // jitter=1.0 → adds full jitterMs (500 by default)
        val withJitter = computeBackoffMs(1, cfg, jitter = 1.0)
        assertTrue(withJitter == 1000L + cfg.jitterMs)
    }

    @Test
    fun backoff_attempt_2_doubles_base() {
        assertTrue(computeBackoffMs(2, cfg, jitter = 0.0) == 2000L)
    }

    @Test
    fun backoff_never_exceeds_maxMs() {
        // Large attempt always clamps
        val result = computeBackoffMs(100, cfg, jitter = 0.0)
        assertTrue(result == cfg.maxMs)
    }
}
