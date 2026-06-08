// ChatRows — fold messages into a render list with day dividers (webui .day-divider).
// A divider precedes the first message of each calendar day; label = day + first ts.
package io.sentient.android.chat.message

import io.sentient.mobiledata.outbox.PendingMessage
import io.sentient.mobilesdk.sdk.ChatMessage
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale

sealed interface ChatRow {
    data class Divider(val label: String, val key: String) : ChatRow
    data class Msg(val message: ChatMessage, val index: Int) : ChatRow

    /**
     * An optimistic pending user message from the outbox — shown with a status chip
     * (QUEUED / SENT / FAILED) until the gateway echoes the committed entry back and
     * ChatRepository reconciles it away by pendingId.
     */
    data class Pending(val msg: PendingMessage) : ChatRow
}

fun chatRows(messages: List<ChatMessage>, nowMs: Long): List<ChatRow> {
    val out = ArrayList<ChatRow>(messages.size + 4)
    var lastKey: String? = null
    for ((i, m) in messages.withIndex()) {
        val key = dayKey(m.ts)
        if (key != lastKey) { out.add(ChatRow.Divider(dividerLabel(m.ts, nowMs), key)); lastKey = key }
        out.add(ChatRow.Msg(m, i))
    }
    return out
}

private fun dayKey(ts: Long): String {
    val c = Calendar.getInstance().apply { timeInMillis = ts }
    return "${c.get(Calendar.YEAR)}-${c.get(Calendar.DAY_OF_YEAR)}"
}

private fun dividerLabel(ts: Long, nowMs: Long): String {
    // Calendar-based yesterday (DST-aware) — a raw `nowMs - 86_400_000L` mislabels
    // the boundary on 23h/25h DST-transition days. Mirrors iOS isDateInYesterday.
    val yesterdayMs = Calendar.getInstance().apply { timeInMillis = nowMs; add(Calendar.DATE, -1) }.timeInMillis
    val day = when (dayKey(ts)) {
        dayKey(nowMs) -> "Today"
        dayKey(yesterdayMs) -> "Yesterday"
        else -> SimpleDateFormat("EEEE", Locale.getDefault()).format(Date(ts))
    }
    val time = SimpleDateFormat("h:mm a", Locale.getDefault()).format(Date(ts))
    return "$day · $time"
}
