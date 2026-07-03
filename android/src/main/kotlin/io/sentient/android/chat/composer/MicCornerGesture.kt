// ---------------------------------------------------------------------------
// MicCornerGesture — pure gesture math for the corner mic control
// (hold-to-talk / drag-to-lock). Ports the webui FSM exactly:
// gateway/webui/src/components/dock/mic-corner-gesture.ts.
//
// The composable (MicCorner.kt) owns pointer plumbing; this file owns the FSM.
// Thresholds are pinned by MicCornerGestureTest — a drifted threshold silently
// turns push-to-talk into a stuck-open mic (or the reverse).
// ---------------------------------------------------------------------------
package io.sentient.android.chat.composer

/** Corner mic control mode. Mic on ⇔ [HOLD] or [LOCKED]. */
internal enum class MicCornerMode { IDLE, HOLD, LOCKED }

/** Fraction of the travel that arms the lock when releasing from a hold. */
internal const val LOCK_THRESHOLD = 0.4f

/** Fraction of the travel a locked control must be dragged back below to release. */
internal const val UNLOCK_THRESHOLD = 0.5f

/** Where the control settles when the pointer lifts. */
internal data class ReleaseOutcome(val mode: MicCornerMode, val drag: Float)

/** Clamp pointer movement into [0, travel] px toward the lock end (leftward). */
internal fun clampDrag(base: Float, startX: Float, currentX: Float, travel: Float): Float =
    (base + (startX - currentX)).coerceIn(0f, travel)

/** Resolve where the control settles when the pointer lifts. */
internal fun resolveRelease(origin: MicCornerMode, drag: Float, travel: Float): ReleaseOutcome {
    if (origin == MicCornerMode.LOCKED) {
        return if (drag <= travel * UNLOCK_THRESHOLD) {
            ReleaseOutcome(MicCornerMode.IDLE, 0f)
        } else {
            ReleaseOutcome(MicCornerMode.LOCKED, travel)
        }
    }
    return if (drag >= travel * LOCK_THRESHOLD) {
        ReleaseOutcome(MicCornerMode.LOCKED, travel)
    } else {
        ReleaseOutcome(MicCornerMode.IDLE, 0f)
    }
}

/** Whether the current drag position would arm the lock on release. */
internal fun isArmed(drag: Float, travel: Float): Boolean = drag >= travel * LOCK_THRESHOLD
