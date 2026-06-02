// ---------------------------------------------------------------------------
// SessionResume — per-device "current session" pointer + stale-resume guard.
//
// Mirrors web-sdk sdk-reconnect.ts (buildConnectUrl / setCurrentSessionId /
// clearStaleResumeId / hasPendingResume). The connect URL IS the wire: the
// gateway reads `?session_id=` at the WS upgrade and runs its resume flow.
//
// Two divergences from the TS, both intentional and platform-driven:
//   - Storage is the injected [SessionIdStore] (Keychain / EncryptedSharedPrefs
//     on device), NOT sessionStorage. The pointer survives process death.
//   - Stale detection is Clock-driven, not setTimeout-driven. The orchestrator
//     (C7) calls [onSnapshot] when a conversation.snapshot arrives, then calls
//     [checkStaleResume] after [STALE_RESUME_CHECK_MS] has elapsed (it owns the
//     timer). This keeps commonMain free of real timers per commonMain-purity.
//
// Stale-resume rule (mirrors sentient-sdk.ts):
//   On a SUCCESSFUL resume the gateway sends `session.switched` BEFORE
//   `conversation.snapshot`. [setCurrentSessionId] clears pendingResume first,
//   so the subsequent [onSnapshot] sees no pending resume and does not arm the
//   timer. The 404 fallback sends snapshot ONLY (no switched) — pendingResume
//   is still set at snapshot time, the timer arms, and if no switched lands
//   within the window the stored id is dropped so the next connect starts a
//   fresh chain instead of hammering a deleted id forever.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.transport

import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.secure.SessionIdStore
import io.sentient.mobilesdk.util.Clock

private const val SESSION_ID_PARAM = "session_id"

/**
 * Owns the session-resume pointer and the snapshot-without-switched stale guard.
 *
 * Single-threaded use (driven by the orchestrator's coroutine). Not thread-safe.
 *
 * @param store Persistent pointer storage (injected; platform-encrypted on device).
 * @param clock Injected wall-clock for deterministic stale-window checks.
 */
class SessionResume(
    private val store: SessionIdStore,
    private val clock: Clock,
) {
    private val log = createLogger("transport", "resume")

    /** Set when [buildConnectUrl] attaches a stored id; cleared on switch or stale-clear. */
    private var pendingResume: String? = null

    /** Wall-clock ms at which [onSnapshot] armed the stale timer, or null when disarmed. */
    private var snapshotArmedAtMs: Long? = null

    /**
     * Build the WS connect URL from [base] plus the stored session id (when present).
     * Captures the id into [pendingResume] so [checkStaleResume] can detect a 404
     * fallback later. Idempotent — safe on every connect.
     */
    fun buildConnectUrl(base: String): String {
        val stored = store.get()
        if (stored.isNullOrEmpty()) {
            pendingResume = null
            return base
        }
        pendingResume = stored
        val url = appendQueryParam(base, SESSION_ID_PARAM, stored)
        log.debug("connect-url.resume-attached", mapOf("sessionId" to stored))
        return url
    }

    /**
     * Persist [sessionId] as the current pointer. Called on session.created /
     * session.switched. Clears [pendingResume] — the resume completed, so a
     * subsequent snapshot is NOT a 404 fallback signal. No-op for an empty id.
     */
    fun setCurrentSessionId(sessionId: String) {
        if (sessionId.isEmpty()) return
        store.set(sessionId)
        pendingResume = null
        snapshotArmedAtMs = null
        log.debug("pointer.set", mapOf("sessionId" to sessionId))
    }

    /**
     * Called when a conversation.snapshot arrives. Arms the stale timer ONLY if a
     * resume is still pending (no switched cleared it first). Records the arming
     * time so [checkStaleResume] can decide whether the window has elapsed.
     */
    fun onSnapshot() {
        if (pendingResume == null) {
            log.debug("snapshot.no-pending-resume")
            return
        }
        snapshotArmedAtMs = clock.nowMs()
        log.debug("snapshot.stale-timer-armed", mapOf("staleId" to pendingResume))
    }

    /**
     * Drop the stored id IFF a resume was pending, the stale timer was armed by a
     * snapshot, and [STALE_RESUME_CHECK_MS] has elapsed without a switched. The
     * orchestrator schedules this after the window; calling early is a safe no-op.
     */
    fun checkStaleResume() {
        val armedAt = snapshotArmedAtMs ?: return
        if (pendingResume == null) {
            snapshotArmedAtMs = null
            return
        }
        if (clock.nowMs() - armedAt < STALE_RESUME_CHECK_MS) return
        log.info(
            "fallback-cleared",
            mapOf("staleId" to pendingResume, "reason" to "snapshot-without-switched"),
        )
        store.clear()
        pendingResume = null
        snapshotArmedAtMs = null
    }

    /** True iff a resume id is in flight (URL-attached, not yet acknowledged). */
    fun hasPendingResume(): Boolean = pendingResume != null
}

/**
 * Append a `key=value` query param to [base], preserving any existing query
 * string. Avoids a platform URL type (commonMain purity) — a simple `?`/`&`
 * join is sufficient for the gateway's WS upgrade URL shape. Values are
 * assumed url-safe (gateway session ids are url-safe tokens).
 */
private fun appendQueryParam(base: String, key: String, value: String): String {
    val separator = if (base.contains('?')) '&' else '?'
    return "$base$separator$key=$value"
}
