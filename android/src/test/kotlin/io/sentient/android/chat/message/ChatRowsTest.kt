package io.sentient.android.chat.message

import io.sentient.mobilesdk.sdk.ChatMessage
import kotlin.test.Test
import kotlin.test.assertEquals

class ChatRowsTest {
    private fun m(ts: Long) = ChatMessage(ts = ts, role = "user", content = "x")

    @Test fun sameDayOneDivider() {
        val day = 1_700_000_000_000L
        val rows = chatRows(listOf(m(day), m(day + 60_000)), nowMs = day)
        assertEquals(1, rows.count { it is ChatRow.Divider })
    }

    @Test fun twoDaysTwoDividers() {
        val d1 = 1_700_000_000_000L
        val d2 = d1 + 86_400_000L
        val rows = chatRows(listOf(m(d1), m(d2)), nowMs = d2)
        assertEquals(2, rows.count { it is ChatRow.Divider })
    }

    @Test fun emptyInputNoRows() {
        assertEquals(0, chatRows(emptyList(), nowMs = 1_700_000_000_000L).size)
    }
}
