package io.sentient.mobilesdk.sdk

import io.sentient.mobilesdk.log.createLogger
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

/**
 * Single supersede-able timer guarding against a "stuck" UI state (THINKING /
 * speaking) when the server end-signal never arrives (silent socket death).
 * arm() (re)starts the window; disarm() cancels it; on expiry onTimeout() fires
 * exactly once. Mirrors SentientSdk.onForeground's withTimeout/supersede pattern
 * but as a standalone, unit-testable unit.
 */
class StuckStateWatchdog(
    private val timeoutMs: Long,
    private val scope: CoroutineScope,
    private val delayFn: suspend (Long) -> Unit,
    private val onTimeout: () -> Unit,
) {
    private val log = createLogger("sdk", "stuck-watchdog")
    private var job: Job? = null

    fun arm() {
        job?.cancel()
        job = scope.launch {
            delayFn(timeoutMs)
            log.warn("stuck-timeout → reset", mapOf("timeoutMs" to timeoutMs))
            onTimeout()
        }
    }

    fun disarm() {
        job?.cancel()
        job = null
    }
}
