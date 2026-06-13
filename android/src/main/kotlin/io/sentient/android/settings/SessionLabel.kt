// ---------------------------------------------------------------------------
// SessionLabel — human-readable label for a vitals session row.
//
// The newest session is "This session"; older ones get a relative day prefix
// ("Today" / "Yesterday" / a short date) plus a wall-clock time ("9:43 PM").
// Pure over epoch-ms + the session info; formatting uses java.util.Calendar /
// SimpleDateFormat (android UI code, not commonMain — purity rule N/A here).
// ---------------------------------------------------------------------------
package io.sentient.android.settings

import io.sentient.mobilesdk.vitals.VitalsSessionInfo
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale

private const val DAY_MS = 86_400_000L
private const val THIS_SESSION = "This session"
private const val UNKNOWN = "Unknown time"

/**
 * Label for one session row. The newest ([isNewest]) renders "This session"; others
 * render "<Today|Yesterday|MMM d> <h:mm a>", e.g. "Yesterday 2:07 PM".
 */
fun sessionLabel(info: VitalsSessionInfo, nowMs: Long, isNewest: Boolean): String {
    if (isNewest) return THIS_SESSION
    val ms = info.sessionStartMs
    if (ms <= 0L) return UNKNOWN
    return "${dayPrefix(nowMs, ms)} ${timeFormat().format(Date(ms))}"
}

private fun dayPrefix(nowMs: Long, ms: Long): String {
    val today = dayIndex(nowMs)
    return when (dayIndex(ms)) {
        today -> "Today"
        today - 1 -> "Yesterday"
        else -> dateFormat().format(Date(ms))
    }
}

// Local-calendar day index so "Today"/"Yesterday" respect the device timezone
// (a raw ms/DAY_MS bucket would be UTC-based and wrong near midnight).
private fun dayIndex(ms: Long): Long {
    val cal = Calendar.getInstance().apply { timeInMillis = ms }
    val offsetMs = (cal.get(Calendar.ZONE_OFFSET) + cal.get(Calendar.DST_OFFSET)).toLong()
    return (ms + offsetMs) / DAY_MS
}

private fun timeFormat() = SimpleDateFormat("h:mm a", Locale.getDefault())

private fun dateFormat() = SimpleDateFormat("MMM d", Locale.getDefault())
