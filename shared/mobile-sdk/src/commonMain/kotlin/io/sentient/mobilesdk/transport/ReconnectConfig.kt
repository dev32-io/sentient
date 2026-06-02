// ---------------------------------------------------------------------------
// ReconnectConfig — reconnect tunables + backoff math.
//
// Mirrors web-sdk connector-types.ts ReconnectConfig interface and the
// DEFAULT_RECONNECT constant in sentient-sdk.ts. Default values must stay
// in sync with those defaults; any divergence will desync the reconnect
// behavior between web and mobile clients.
//
// Formula (matches sdk-reconnect.ts computeBackoffMs):
//   delay = min(baseMs * 2^(attempt-1), maxMs) + jitter * jitterMs
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.transport

/**
 * Reconnect / probe tunables.
 *
 * Defaults mirror [sentient-sdk.ts DEFAULT_RECONNECT]:
 *   baseMs=1_000, maxMs=30_000, jitterMs=500, maxAttempts=5, probePingTimeoutMs=2_000
 *
 * @param baseMs First retry delay (ms). Subsequent attempts double until [maxMs].
 * @param maxMs Cap on the exponential backoff delay.
 * @param jitterMs Random jitter range (ms) added to each computed delay to spread retries.
 * @param maxAttempts Max attempts before surrendering and emitting onConnectionLost.
 * @param probePingTimeoutMs Ms to wait for a pong after sending a ping probe before
 *   treating WS as dead.
 */
data class ReconnectConfig(
    val baseMs: Long = 1_000L,
    val maxMs: Long = 30_000L,
    val jitterMs: Long = 500L,
    val maxAttempts: Int = 5,
    val probePingTimeoutMs: Long = 2_000L,
)

/**
 * Compute the backoff delay for a given attempt.
 *
 * Formula: `min(baseMs * 2^(attempt-1), maxMs) + jitter * jitterMs`
 *
 * Mirrors web-sdk `sdk-reconnect.ts computeBackoffMs`. The [jitter] parameter
 * is injectable so tests can pass `0.0` for determinism; production code
 * passes `kotlin.random.Random.nextDouble()`.
 *
 * @param attempt 1-based attempt counter.
 * @param cfg Reconnect tunables.
 * @param jitter Random multiplier in [0.0, 1.0] applied to [ReconnectConfig.jitterMs].
 * @return Delay in milliseconds.
 */
fun computeBackoffMs(attempt: Int, cfg: ReconnectConfig, jitter: Double): Long {
    val exp = cfg.baseMs * (1L shl (attempt - 1).coerceIn(0, 30))
    val capped = minOf(exp, cfg.maxMs)
    return capped + (jitter * cfg.jitterMs).toLong()
}
