// ---------------------------------------------------------------------------
// ComposerSwipeGesture — pure accumulator for the composer's swipe-down to
// dismiss the keyboard. The composable (Composer.kt) owns pointer plumbing;
// this file owns the threshold bookkeeping, mirroring the MicCornerGesture /
// ComposerTaskStripLayout split.
//
// Why this exists instead of `detectVerticalDragGestures`: that built-in
// races a nested `Modifier.horizontalScroll` (the task strip) on RAW
// per-axis touch-slop distance — whichever of dx/dy independently crosses
// Android's ~8dp touch slop FIRST wins outright and consumes for the rest of
// the gesture; it is not a "which axis is more dominant" comparison despite
// the two detectors' own doc comments describing them as "coordinating."
// (Confirmed against AndroidX's TouchSlopDetector.getPostSlopOffset, which
// checks only the accumulated delta on ITS OWN axis against the shared
// threshold — see androidx.compose.foundation.gestures.DragGestureDetector.)
// A short or slightly diagonal swipe on the task strip's rightmost pills
// therefore loses that race often enough that the strip never visibly
// scrolls (the reported defect: 10+ swipes, zero measurable offset).
//
// The fix: never claim (consume) anything below the app-level dismiss
// threshold itself — well past the child's own ~8dp slop — so a
// horizontally-intending drag always has the chance to claim the gesture
// first via its own, unmodified `horizontalScroll`. Only a swipe that is
// ALREADY unambiguously a real vertical dismiss (net downward travel past
// the threshold, not merely a hair of accumulated dy) ever gets consumed
// here. See agents/docs/android/android-compose-details.md for the write-up.
// ---------------------------------------------------------------------------
package io.sentient.android.chat.composer

/** One step of the swipe-down accumulator: running total + whether it just fired. */
internal data class SwipeAccumulation(val netPx: Float, val triggered: Boolean)

/**
 * Accumulates a vertical drag's net downward travel and reports when it
 * crosses [thresholdPx], resetting the accumulator so one continuous touch
 * can re-trigger the dismiss more than once (e.g. a long drag-then-redrag).
 * Pure — no pointer/Compose types — so it is unit-testable directly.
 */
internal fun accumulateSwipeDown(currentPx: Float, deltaYPx: Float, thresholdPx: Float): SwipeAccumulation {
    val next = currentPx + deltaYPx
    return if (next > thresholdPx) {
        SwipeAccumulation(netPx = 0f, triggered = true)
    } else {
        SwipeAccumulation(netPx = next, triggered = false)
    }
}
