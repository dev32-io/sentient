// ---------------------------------------------------------------------------
// RelativeTime — date-group + compact relative-time labels for session rows.
//
// Mirrors the webui sessions drawer's date-group-header.tsx grouping
// (Today / Yesterday / Last 7 days / Older) AND adds a compact per-row relative
// label ("2h ago", "3d ago") for the row's secondary line. Pure functions over
// epoch-ms; no platform clock import (commonMain-purity does not apply here —
// this is android UI code — but keeping it pure makes it trivially testable and
// matches the webui logic exactly).
// ---------------------------------------------------------------------------
package io.sentient.android.history

private const val DAY_MS = 86_400_000L
private const val HOUR_MS = 3_600_000L
private const val MINUTE_MS = 60_000L
private const val WEEK_DAYS = 7L

/**
 * Graceful-degradation label for a missing/invalid timestamp. A row whose ts is the
 * unknown sentinel (0L / non-positive) renders "-" rather than an epoch date or a
 * nonsense "55 years ago" — defense-in-depth against a malformed gateway frame.
 */
const val UNKNOWN_TIME = "-"

/** True when a timestamp is the unknown sentinel (0L) or otherwise non-positive. */
private fun isUnknownTs(ms: Long): Boolean = ms <= 0L

/** Date-bucket label for the list group header. Matches webui dateGroupLabel. */
fun dateGroupLabel(nowMs: Long, lastActiveMs: Long): String {
    if (isUnknownTs(lastActiveMs)) return UNKNOWN_TIME
    val today = nowMs / DAY_MS
    val day = lastActiveMs / DAY_MS
    return when {
        day == today -> "Today"
        day == today - 1 -> "Yesterday"
        today - day < WEEK_DAYS -> "Last 7 days"
        else -> "Older"
    }
}

/** Compact "x ago" label for a row's secondary line. */
fun relativeTime(nowMs: Long, lastActiveMs: Long): String {
    if (isUnknownTs(lastActiveMs)) return UNKNOWN_TIME
    val delta = (nowMs - lastActiveMs).coerceAtLeast(0)
    return when {
        delta < MINUTE_MS -> "just now"
        delta < HOUR_MS -> "${delta / MINUTE_MS}m ago"
        delta < DAY_MS -> "${delta / HOUR_MS}h ago"
        else -> "${delta / DAY_MS}d ago"
    }
}
