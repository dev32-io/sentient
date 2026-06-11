// ---------------------------------------------------------------------------
// ReconnectResumeDecision — the pure decision unit for the A1-vs-resume
// reconciliation (Task 3.10-mobile, Slice 3).
//
// THE BUG THIS GUARDS: the Slice-1 A1 path cleared cognition→IDLE + stopped
// audio UNCONDITIONALLY on every reconnect-to-READY, BEFORE the gateway's
// `stream.resumed` ack arrived. On a `recovered:true` resume (the gateway
// replays the in-flight cycle's frames to restore THINKING/speaking) the client
// had ALREADY cleared the very state the resume exists to preserve — an IDLE
// flash + a possible watchdog fire.
//
// THE FIX: split the decision across the two events that arrive in order on a
// reconnect:
//   1. READY rising edge ([decideOnReady]):
//        - resume WILL be attempted (reconnect AND cursor has seq) → DEFER:
//          send stream.resume (caller already did, in sendConfigure) but DO NOT
//          clear-to-idle and DO NOT re-activate. Wait for stream.resumed.
//        - NO resume possible (first connect, or reconnect with lastSeq==0) →
//          the existing A1 behavior: re-activate the anchored session + clear-
//          to-idle. No resume handshake is possible without a cursor.
//        - first connect → nothing to restore.
//   2. stream.resumed ack ([decideOnResumed]):
//        - recovered=true  → PRESERVE: the replayed frames re-establish the in-
//          flight THINKING/speaking; do not clear.
//        - recovered=false → the gateway could NOT resume: do the A1-equivalent
//          recovery now — clear-to-idle + REST-refetch history + re-activate.
//
// Pure: data in, decision out. No platform, no coroutines, no I/O. The
// orchestrator maps the decision onto its side effects (sendSwitchSession,
// clearActiveToIdle, refetchHistoryForSession). Unit-tested directly.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.sdk

/** What the orchestrator should do when a connect attempt reaches READY. */
enum class ReadyAction {
    /** First-ever connect — nothing to restore. */
    NOTHING_TO_RESTORE,

    /** Reconnect, no anchored session — nothing to re-establish. */
    NO_ANCHOR,

    /** Reconnect, a resume IS in flight (cursor has seq) — defer the clear/activate
     *  decision to [decideOnResumed] when `stream.resumed` lands. */
    DEFER_TO_RESUME,

    /** Reconnect, NO resume possible (cursor empty) — the legacy A1 path:
     *  re-activate the anchored session + clear stale active UI state to idle. */
    REESTABLISH_AND_CLEAR,
}

/** What the orchestrator should do when the `stream.resumed` ack arrives. */
enum class ResumedAction {
    /** recovered=true — the replayed frames re-establish in-flight state; preserve it. */
    PRESERVE_IN_FLIGHT,

    /** recovered=false — the gateway could not resume: clear-to-idle + refetch history
     *  + re-activate (the A1-equivalent recovery, now deferred to ack time). */
    RECOVER_TO_IDLE,
}

/**
 * Decide the READY-rising-edge action.
 *
 * @param wasReconnect false on the first-ever READY (nothing to restore); true on
 *   every subsequent READY (a reconnect).
 * @param hasAnchor true when a session uuid is anchored (re-establish target exists).
 * @param resumeWillBeAttempted true when resume was/will be carried in configure —
 *   i.e. the resume cursor has a seq (`lastSeq > 0`). MUST mirror the exact condition
 *   `resumeParams` uses so the defer decision is consistent with the wire.
 */
internal fun decideOnReady(
    wasReconnect: Boolean,
    hasAnchor: Boolean,
    resumeWillBeAttempted: Boolean,
): ReadyAction = when {
    !wasReconnect -> ReadyAction.NOTHING_TO_RESTORE
    !hasAnchor -> ReadyAction.NO_ANCHOR
    resumeWillBeAttempted -> ReadyAction.DEFER_TO_RESUME
    else -> ReadyAction.REESTABLISH_AND_CLEAR
}

/** Decide the `stream.resumed` ack action from the gateway's `recovered` flag. */
internal fun decideOnResumed(recovered: Boolean): ResumedAction =
    if (recovered) ResumedAction.PRESERVE_IN_FLIGHT else ResumedAction.RECOVER_TO_IDLE
