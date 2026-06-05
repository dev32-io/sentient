// ChatRows — fold messages into a render list with day dividers (webui .day-divider).
// A divider precedes the first message of each calendar day; label = day + first ts.
package io.sentient.android.chat

import io.sentient.mobilesdk.sdk.ChatMessage
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale

sealed interface ChatRow {
    data class Divider(val label: String, val key: String) : ChatRow
    data class Msg(val message: ChatMessage, val index: Int) : ChatRow
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
    val day = when (dayKey(ts)) {
        dayKey(nowMs) -> "Today"
        dayKey(nowMs - 86_400_000L) -> "Yesterday"
        else -> SimpleDateFormat("EEEE", Locale.getDefault()).format(Date(ts))
    }
    val time = SimpleDateFormat("h:mm a", Locale.getDefault()).format(Date(ts))
    return "$day · $time"
}
