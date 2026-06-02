// ---------------------------------------------------------------------------
// ReconnectController — bounded-backoff reconnect loop.
//
// Ports the attempt loop from web-sdk sdk-reconnect.ts runReconnectLoop():
//   - attempt counter, 1-based, capped at config.maxAttempts
//   - each attempt runs the injected `connect` thunk (one connect/auth/ready cycle)
//   - on Success → stop, no signal
//   - on Failure(AUTH) → TERMINAL: stop immediately, NO retry, signal onAuthExpired
//     (the token won't get better with retries)
//   - on Failure(NETWORK | TIMEOUT | NONE) → retryable: backoff-sleep, retry
//   - after maxAttempts failed retryable attempts → stop, signal onConnectionLost
//   - cancel() (consumer disconnect) → stop, suppress onConnectionLost
//
// Time + randomness are injected per commonMain-purity: `delayFn` replaces the
// real backoff sleep (tests pass a recorder), `jitterFn` replaces Math.random
// (tests pass a constant). No kotlinx delay() / kotlin.random in here.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.transport

import io.sentient.mobilesdk.log.createLogger

/**
 * Drives the unexpected-close recovery loop with bounded exponential backoff.
 *
 * @param config Reconnect tunables (base/max/jitter/maxAttempts).
 * @param delayFn Suspending sleep, injected. Production wires kotlinx `delay`;
 *   tests record the requested durations without waiting.
 * @param jitterFn Returns a multiplier in [0.0, 1.0] applied to jitterMs.
 *   Production wires `Random.nextDouble()`; tests pass a constant.
 * @param connect One connect/auth/session.ready cycle. Returns [ConnectResult].
 *   Must not throw — wrap engine.open() failures into [ConnectResult.Failure].
 * @param onAuthExpired Fired once on a terminal auth failure.
 * @param onConnectionLost Fired once when retries exhaust without cancel.
 */
class ReconnectController(
    private val config: ReconnectConfig,
    private val delayFn: suspend (Long) -> Unit,
    private val jitterFn: () -> Double,
    private val connect: suspend () -> ConnectResult,
    private val onAuthExpired: () -> Unit,
    private val onConnectionLost: () -> Unit,
) {
    private val log = createLogger("transport", "reconnect")

    private var cancelled = false

    /**
     * Abort any in-flight or future loop iterations and suppress the
     * [onConnectionLost] signal. Called on consumer disconnect. Idempotent.
     */
    fun cancel() {
        cancelled = true
        log.debug("cancel")
    }

    /**
     * Run the reconnect attempt loop to a terminal outcome (success, auth-expired,
     * exhaustion, or cancel). Suspends across backoff delays via [delayFn].
     */
    suspend fun runReconnectLoop() {
        var attempt = 0
        while (!cancelled && attempt < config.maxAttempts) {
            attempt += 1
            log.info("attempt", mapOf("attempt" to attempt, "max" to config.maxAttempts))
            when (val result = connect()) {
                is ConnectResult.Success -> {
                    log.info("success", mapOf("attempt" to attempt))
                    return
                }
                is ConnectResult.Failure -> {
                    if (handleFailure(result.kind, attempt)) return
                }
            }
        }
        finishExhausted(attempt)
    }

    /** Returns true if the loop should stop after this failure. */
    private suspend fun handleFailure(kind: LastErrorKind, attempt: Int): Boolean {
        log.warn("attempt-failed", mapOf("attempt" to attempt, "kind" to kind))
        if (kind == LastErrorKind.AUTH) {
            log.warn("auth-expired-terminal")
            onAuthExpired()
            return true
        }
        if (cancelled) return true
        if (attempt >= config.maxAttempts) return false
        val delayMs = computeBackoffMs(attempt, config, jitterFn())
        log.debug("backoff", mapOf("delayMs" to delayMs))
        delayFn(delayMs)
        return false
    }

    private fun finishExhausted(attempts: Int) {
        if (cancelled) {
            log.debug("loop-cancelled", mapOf("attempts" to attempts))
            return
        }
        log.warn("exhausted", mapOf("attempts" to attempts))
        onConnectionLost()
    }
}
