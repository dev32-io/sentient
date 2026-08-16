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

/**
 * Stable per-message LazyColumn key — ONE row per logical BUBBLE across its
 * whole lifecycle. Keyed on replyId FIRST, not turnId: a mid-turn steer rotates
 * replyId, so one turnId can own TWO assistant bubbles (reply 1 answers the
 * first message, reply 2 answers the steer). Keying on turnId aliases both
 * replies onto the same LazyColumn key — worse than iOS here, Compose THROWS on
 * a duplicate key rather than just mis-animating.
 *
 * The live streaming bubble and its committed twin still share replyId
 * (ObserveChatUseCase builds the live bubble with replyId = it.replyId), so the
 * streaming→committed handoff is still the SAME row (grows in place, no
 * remount). replyId is constant across tokens same as turnId was, so unlike ts
 * it never churns mid-reveal.
 *
 * Entries with no replyId (user rows, REST history) key by their stable gateway
 * entryId. turnId is a fallback only for a gateway that does not stamp replyId.
 * Index is the last resort. Mirrors iOS ChatRow.
 */
internal fun messageRowKey(m: ChatMessage, index: Int): String = when {
    // The optimistic row and its live committed echo deliberately share identity.
    m.role == "user" && !m.pendingId.isNullOrEmpty() -> "send-${m.pendingId}"
    !m.replyId.isNullOrEmpty() -> "reply-${m.replyId}"
    m.entryId.isNotEmpty() -> "ent-${m.entryId}"
    !m.turnId.isNullOrEmpty() -> "turn-${m.turnId}"
    else -> "idx-$index"
}

fun chatRows(messages: List<ChatMessage>, nowMs: Long): List<ChatRow> {
    val out = ArrayList<ChatRow>(messages.size + 4)
    var lastKey: String? = null
    for ((i, m) in messages.withIndex()) {
        // Streaming messages have ts=0 (no real timestamp while in flight).
        // Never bucket them into a day-divider — ts=0/epoch would produce a
        // bogus "Thursday, Jan 1 1970" separator. The committed entry that
        // follows carries the real ts and its own divider. Mirrors iOS ChatRows.swift.
        if (!m.streaming) {
            val key = dayKey(m.ts)
            if (key != lastKey) { out.add(ChatRow.Divider(dividerLabel(m.ts, nowMs), key)); lastKey = key }
        }
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
