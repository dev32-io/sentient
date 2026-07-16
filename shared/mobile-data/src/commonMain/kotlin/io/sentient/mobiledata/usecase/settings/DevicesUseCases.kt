// ---------------------------------------------------------------------------
// DevicesUseCases — Signal device-linking ops + the status-poll loop.
//
// The poll is a cold [Flow] driven by an INJECTED [delayFn] so commonTest can
// advance virtual time (no real sleeps). It emits each status and STOPS on a
// terminal state (linked, or an error surfaced by the pairing coordinator); a
// transient poll failure (SentientError.recoverable) is emitted but the loop
// keeps retrying, while a non-recoverable failure (e.g. session expiry) is
// emitted once and stops the loop — never spins forever against a dead auth
// session. The collector (VM) owns the lifecycle — cancelling collection
// (navigate away / QR expiry) stops the poll.
// ---------------------------------------------------------------------------
package io.sentient.mobiledata.usecase.settings

import io.sentient.mobiledata.data.settings.DevicesRepository
import io.sentient.mobiledata.result.SentientResult
import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.settings.DevicesResponse
import io.sentient.mobilesdk.settings.SignalLinkStartResponse
import io.sentient.mobilesdk.settings.SignalLinkStatusResponse
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow

private const val LINK_STATE_LINKED = "linked"

class DevicesUseCases(
    private val devices: DevicesRepository,
    private val delayFn: suspend (Long) -> Unit = { delay(it) },
) {
    private val log = createLogger("data", "settings", "devices")

    suspend fun getDevices(): SentientResult<DevicesResponse> = devices.getDevices()

    suspend fun linkStart(): SentientResult<SignalLinkStartResponse> = devices.signalLinkStart()

    suspend fun linkCancel(): SentientResult<Unit> = devices.signalLinkCancel()

    suspend fun unlink(): SentientResult<Unit> = devices.signalUnlink()

    /**
     * Poll link status every [intervalMs] until a terminal state or the collector cancels.
     * A non-recoverable failure (session expiry, etc.) is terminal too — it is emitted once
     * and the loop stops rather than spinning forever against a dead auth session.
     */
    fun pollLinkStatus(intervalMs: Long): Flow<SentientResult<SignalLinkStatusResponse>> = flow {
        log.info("poll.start", mapOf("intervalMs" to intervalMs))
        while (true) {
            val r = devices.signalLinkStatus()
            emit(r)
            if (isPollTerminal(r)) break
            delayFn(intervalMs)
        }
    }

    /** True (and logged) when the poll must stop: a linked/error status, or a dead-end failure. */
    private fun isPollTerminal(r: SentientResult<SignalLinkStatusResponse>): Boolean = when {
        r is SentientResult.Success && isTerminalLinkState(r.data) -> {
            log.info("poll.terminal", mapOf("state" to r.data.state, "hasError" to (r.data.error != null)))
            true
        }
        r is SentientResult.Failure && !r.error.recoverable -> {
            log.warn("poll.terminal", mapOf("reason" to "non-recoverable", "kind" to r.error.kind.name))
            true
        }
        r is SentientResult.Failure -> {
            log.debug("poll.retry", mapOf("reason" to "transient-failure", "kind" to r.error.kind.name))
            false
        }
        else -> false
    }
}

/** Terminal when the account is linked or the coordinator reported an error. */
internal fun isTerminalLinkState(status: SignalLinkStatusResponse): Boolean =
    status.error != null || status.state == LINK_STATE_LINKED
