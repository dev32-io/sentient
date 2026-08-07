// ---------------------------------------------------------------------------
// ComposerTaskStripLayout — pure pill-width math for the task strip. Mirrors
// webui's `clamp(112px, 42cqw, 200px)` (components.css `.tool-pill`) and
// iOS's `ComposerLayout.taskPillMinWidth` exactly — keep all three in
// lockstep; a drifted constant here makes the same turn look inconsistent
// depending on which client renders it.
//
// The composable (ComposerTaskStrip.kt) owns measuring the strip's own width
// (via BoxWithConstraints) and applying the result; this file owns the pure
// formula so it is unit-testable without a Compose UI test harness.
// ---------------------------------------------------------------------------
package io.sentient.android.chat.composer

/** Task pill min-width floor (dp) — the readable floor on a narrow screen. */
internal const val TASK_PILL_MIN_WIDTH_FLOOR_DP = 112f

/**
 * Task pill min-width ceiling (dp) — also its hard max-width. A tool name
 * longer than this truncates via the pill's existing `maxLines = 1` +
 * `TextOverflow.Ellipsis`.
 */
internal const val TASK_PILL_MAX_WIDTH_DP = 200f

/**
 * Fraction of the strip's own width a pill's floor scales with — puts
 * roughly 2.4 pills in view at any width in the unclamped middle band
 * (stripWidth ~267–476dp); outside that band the floor/ceiling deliberately
 * trade pill-count consistency for a readable width.
 */
internal const val TASK_PILL_WIDTH_STRIP_FRACTION = 0.42f

/**
 * Derives a task pill's minimum width (dp) from the strip's OWN width, so
 * the same rough number of pills is visible regardless of screen size or how
 * many tasks exist.
 */
internal fun taskPillMinWidth(stripWidthDp: Float): Float =
    (stripWidthDp * TASK_PILL_WIDTH_STRIP_FRACTION).coerceIn(TASK_PILL_MIN_WIDTH_FLOOR_DP, TASK_PILL_MAX_WIDTH_DP)
