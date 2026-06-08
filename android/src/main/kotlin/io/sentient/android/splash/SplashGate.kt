// ---------------------------------------------------------------------------
// SplashGate — pure visibility predicate for the animated splash overlay.
//
// splashVisible returns true until BOTH conditions are met:
//   1. At least SPLASH_MIN_MS have elapsed since the splash was shown.
//   2. The backend is configured (ready = true).
//
// Keeping this logic in a pure function makes it trivially testable without
// any Compose or Android dependencies.
// ---------------------------------------------------------------------------
package io.sentient.android.splash

/** Minimum time (ms) the animated splash stays visible regardless of readiness. */
const val SPLASH_MIN_MS: Long = 2_000L

/**
 * Returns true when the animated splash overlay should remain visible.
 *
 * @param shownAtMs  System.currentTimeMillis() at the instant the splash started.
 * @param nowMs      Current System.currentTimeMillis().
 * @param minMs      Minimum display duration (default [SPLASH_MIN_MS]).
 * @param ready      Whether the backend is configured and the app can show content.
 */
fun splashVisible(
    shownAtMs: Long,
    nowMs: Long,
    minMs: Long = SPLASH_MIN_MS,
    ready: Boolean,
): Boolean = (nowMs - shownAtMs) < minMs || !ready
