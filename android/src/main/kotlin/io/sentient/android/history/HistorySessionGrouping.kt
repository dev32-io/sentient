// ---------------------------------------------------------------------------
// History session grouping + the shared on-accent text color. Extracted from
// HistoryDrawer.kt to keep that file under the clean-code size limit. Groups the
// flat session list into day-labelled buckets (Today / Yesterday / weekday …)
// for the drawer's sectioned list; mirrors the webui .m-hx day grouping.
// ---------------------------------------------------------------------------
package io.sentient.android.history

import androidx.compose.ui.graphics.Color
import io.sentient.mobilesdk.protocol.SessionRow

/** Dark-terra text/icon color that reads on the terra accent fill (avatar, FAB). */
internal val HistoryOnAccent: Color = Color(0xFF2B1A10)

internal data class DateGroup(val label: String, val rows: List<SessionRow>)

/** Fold the (already time-sorted) rows into contiguous day-labelled groups. */
internal fun groupByDate(rows: List<SessionRow>, nowMs: Long): List<DateGroup> {
    val out = mutableListOf<DateGroup>()
    var current: MutableList<SessionRow>? = null
    var label = ""
    for (row in rows) {
        val l = dateGroupLabel(nowMs, row.lastActiveAt)
        if (current == null || l != label) {
            current = mutableListOf(row)
            label = l
            out.add(DateGroup(l, current))
        } else {
            current.add(row)
        }
    }
    return out
}
