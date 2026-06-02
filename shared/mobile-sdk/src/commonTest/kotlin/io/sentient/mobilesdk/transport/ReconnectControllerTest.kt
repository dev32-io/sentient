// ---------------------------------------------------------------------------
// ReconnectControllerTest — ports the attempt-loop FSM from web-sdk
// sdk-reconnect.ts runReconnectLoop(). This is an FSM/invariant contract
// (retry vs abort, maxAttempts ceiling, onAuthExpired/onConnectionLost
// signals) → a keeper per .claude/rules/testing.md.
//
// Time + randomness are injected: a recording delay fn replaces the real
// backoff sleep so tests assert the delay schedule without waiting, and a
// fixed jitter fn (0.0) makes computeBackoffMs deterministic.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.transport

import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class ReconnectControllerTest {
    private val cfg = ReconnectConfig(baseMs = 1_000L, maxMs = 30_000L, jitterMs = 0L, maxAttempts = 5)

    /** Records each injected-delay request so tests assert the backoff schedule. */
    private class DelayRecorder {
        val delays = mutableListOf<Long>()
        suspend fun delay(ms: Long) {
            delays += ms
        }
    }

    private class Signals {
        var authExpired = 0
        var connectionLost = 0
    }

    @Test
    fun succeeds_on_first_attempt_no_delay_no_signals() = runTest {
        val rec = DelayRecorder()
        val sig = Signals()
        var attempts = 0
        val ctrl = ReconnectController(
            config = cfg,
            delayFn = rec::delay,
            jitterFn = { 0.0 },
            connect = {
                attempts += 1
                ConnectResult.Success
            },
            onAuthExpired = { sig.authExpired += 1 },
            onConnectionLost = { sig.connectionLost += 1 },
        )

        ctrl.runReconnectLoop()

        assertEquals(1, attempts)
        assertTrue(rec.delays.isEmpty())
        assertEquals(0, sig.authExpired)
        assertEquals(0, sig.connectionLost)
    }

    @Test
    fun retries_network_failures_then_succeeds() = runTest {
        val rec = DelayRecorder()
        val sig = Signals()
        var attempts = 0
        val ctrl = ReconnectController(
            config = cfg,
            delayFn = rec::delay,
            jitterFn = { 0.0 },
            connect = {
                attempts += 1
                if (attempts < 3) ConnectResult.Failure(LastErrorKind.NETWORK) else ConnectResult.Success
            },
            onAuthExpired = { sig.authExpired += 1 },
            onConnectionLost = { sig.connectionLost += 1 },
        )

        ctrl.runReconnectLoop()

        assertEquals(3, attempts)
        // backoff after attempt 1 and attempt 2 (none after the successful 3rd)
        assertEquals(listOf(1_000L, 2_000L), rec.delays)
        assertEquals(0, sig.connectionLost)
        assertEquals(0, sig.authExpired)
    }

    @Test
    fun auth_failure_aborts_immediately_no_retry_signals_authExpired() = runTest {
        val rec = DelayRecorder()
        val sig = Signals()
        var attempts = 0
        val ctrl = ReconnectController(
            config = cfg,
            delayFn = rec::delay,
            jitterFn = { 0.0 },
            connect = {
                attempts += 1
                ConnectResult.Failure(LastErrorKind.AUTH)
            },
            onAuthExpired = { sig.authExpired += 1 },
            onConnectionLost = { sig.connectionLost += 1 },
        )

        ctrl.runReconnectLoop()

        assertEquals(1, attempts) // no retry on auth
        assertTrue(rec.delays.isEmpty())
        assertEquals(1, sig.authExpired)
        assertEquals(0, sig.connectionLost)
    }

    @Test
    fun exhausts_after_maxAttempts_signals_connectionLost() = runTest {
        val rec = DelayRecorder()
        val sig = Signals()
        var attempts = 0
        val ctrl = ReconnectController(
            config = cfg,
            delayFn = rec::delay,
            jitterFn = { 0.0 },
            connect = {
                attempts += 1
                ConnectResult.Failure(LastErrorKind.NETWORK)
            },
            onAuthExpired = { sig.authExpired += 1 },
            onConnectionLost = { sig.connectionLost += 1 },
        )

        ctrl.runReconnectLoop()

        assertEquals(cfg.maxAttempts, attempts)
        // delay after attempts 1..4 (no sleep after the final failed attempt 5)
        assertEquals(listOf(1_000L, 2_000L, 4_000L, 8_000L), rec.delays)
        assertEquals(1, sig.connectionLost)
        assertEquals(0, sig.authExpired)
    }

    @Test
    fun timeout_failure_retries_like_network() = runTest {
        val rec = DelayRecorder()
        val sig = Signals()
        var attempts = 0
        val ctrl = ReconnectController(
            config = cfg,
            delayFn = rec::delay,
            jitterFn = { 0.0 },
            connect = {
                attempts += 1
                if (attempts < 2) ConnectResult.Failure(LastErrorKind.TIMEOUT) else ConnectResult.Success
            },
            onAuthExpired = { sig.authExpired += 1 },
            onConnectionLost = { sig.connectionLost += 1 },
        )

        ctrl.runReconnectLoop()

        assertEquals(2, attempts)
        assertEquals(listOf(1_000L), rec.delays)
        assertEquals(0, sig.connectionLost)
    }

    @Test
    fun none_failure_retries_like_network_not_aborts() = runTest {
        // LastErrorKind.NONE (no classified error) must follow the RETRY path,
        // not the AUTH abort path — only AUTH is terminal. Pins that the
        // abort-vs-retry branch keys on AUTH alone.
        val rec = DelayRecorder()
        val sig = Signals()
        var attempts = 0
        val ctrl = ReconnectController(
            config = cfg,
            delayFn = rec::delay,
            jitterFn = { 0.0 },
            connect = {
                attempts += 1
                if (attempts < 2) ConnectResult.Failure(LastErrorKind.NONE) else ConnectResult.Success
            },
            onAuthExpired = { sig.authExpired += 1 },
            onConnectionLost = { sig.connectionLost += 1 },
        )

        ctrl.runReconnectLoop()

        assertEquals(2, attempts) // retried, did not abort
        assertEquals(listOf(1_000L), rec.delays) // backoff before the retry
        assertEquals(0, sig.authExpired) // NONE is not terminal
        assertEquals(0, sig.connectionLost)
    }

    @Test
    fun cancel_stops_loop_and_suppresses_connectionLost() = runTest {
        val rec = DelayRecorder()
        val sig = Signals()
        var attempts = 0
        lateinit var ctrl: ReconnectController
        ctrl = ReconnectController(
            config = cfg,
            delayFn = rec::delay,
            jitterFn = { 0.0 },
            connect = {
                attempts += 1
                ctrl.cancel() // consumer disconnect mid-flight
                ConnectResult.Failure(LastErrorKind.NETWORK)
            },
            onAuthExpired = { sig.authExpired += 1 },
            onConnectionLost = { sig.connectionLost += 1 },
        )

        ctrl.runReconnectLoop()

        assertEquals(1, attempts)
        assertTrue(rec.delays.isEmpty())
        assertEquals(0, sig.connectionLost)
        assertEquals(0, sig.authExpired)
    }

    @Test
    fun jitter_is_added_to_backoff_delay() = runTest {
        val rec = DelayRecorder()
        val jcfg = cfg.copy(jitterMs = 500L)
        var attempts = 0
        val ctrl = ReconnectController(
            config = jcfg,
            delayFn = rec::delay,
            jitterFn = { 1.0 }, // full jitter
            connect = {
                attempts += 1
                if (attempts < 2) ConnectResult.Failure(LastErrorKind.NETWORK) else ConnectResult.Success
            },
            onAuthExpired = {},
            onConnectionLost = {},
        )

        ctrl.runReconnectLoop()

        assertEquals(listOf(1_000L + 500L), rec.delays)
    }
}
