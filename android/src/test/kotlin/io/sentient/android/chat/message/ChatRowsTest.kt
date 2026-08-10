package io.sentient.android.chat.message

import io.sentient.mobilesdk.sdk.ChatMessage
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

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

    // MARK: replyId render-key guard tests (steered-turn regression)

    private fun assistantMsg(ts: Long, turnId: String?, replyId: String? = null,
                              entryId: String = "", streaming: Boolean = false) =
        ChatMessage(ts = ts, role = "assistant", content = "x", streaming = streaming,
                    turnId = turnId, replyId = replyId, entryId = entryId)

    @Test fun distinctReplyIdsProduceDistinctRowIds() {
        // With unique server replyIds, two assistant turns never share a row key.
        val keys = listOf(
            assistantMsg(1_700_000_001_000L, turnId = "1000", replyId = "r1000"),
            assistantMsg(1_700_000_002_000L, turnId = "2000", replyId = "r2000"),
        ).mapIndexed { i, m -> messageRowKey(m, i) }
        assertEquals(2, keys.size)
        assertEquals(2, keys.toSet().size) // no alias
    }

    @Test fun steeredTurnRowsAllUnique() {
        // Real steered-turn shape from device vitals: one turnId, two assistant
        // replies carrying DIFFERENT replyIds (a mid-turn steer rotates replyId),
        // bracketed by the two user messages that triggered them. Keying on
        // turnId alone (the pre-fix rule) collapses the two replies onto one
        // LazyColumn key — Compose throws on the duplicate. This is the pin: it
        // fails against the pre-fix turnId-first rule and passes against
        // replyId-first.
        val t0 = 1_700_000_000_000L
        val messages = listOf(
            m(t0).copy(entryId = "1819"),
            assistantMsg(t0 + 1_000, turnId = "T1", replyId = "R1", entryId = "e-R1"),
            m(t0 + 2_000).copy(entryId = "1827"),
            assistantMsg(t0 + 3_000, turnId = "T1", replyId = "R2", entryId = "e-R2"),
        )
        val ids = chatRows(messages, nowMs = t0)
            .filterIsInstance<ChatRow.Msg>()
            .map { messageRowKey(it.message, it.index) }
        assertEquals(4, ids.size)
        assertEquals(4, ids.toSet().size) // every row id unique
    }

    @Test fun steeredTurnRepliesCollideOnTurnIdAlone() {
        // Mutation check: proves the assertion above is not vacuous. Reproduces
        // the PRE-FIX rule (turn-<turnId> only) inline and shows it genuinely
        // collides for this exact steered-turn shape — only keying on replyId
        // first (the fixed rule, messageRowKey) tells the two replies apart.
        val reply1 = assistantMsg(1_700_000_001_000L, turnId = "T1", replyId = "R1", entryId = "e-R1")
        val reply2 = assistantMsg(1_700_000_003_000L, turnId = "T1", replyId = "R2", entryId = "e-R2")
        val preFixKey = { m: ChatMessage -> "turn-${m.turnId}" }
        assertEquals(preFixKey(reply1), preFixKey(reply2)) // pre-fix rule collides
        assertTrue(messageRowKey(reply1, 0) != messageRowKey(reply2, 1)) // fixed rule does not
    }

    @Test fun streamingToCommittedHandoffSameRowId() {
        // Streaming bubble (entryId empty) and its committed twin (entryId = R)
        // share replyId — must yield the SAME row key so the handoff never remounts.
        val streaming = assistantMsg(0L, turnId = null, replyId = "R9", entryId = "", streaming = true)
        val committed = assistantMsg(1_700_000_000_000L, turnId = null, replyId = "R9", entryId = "R9")
        assertEquals(messageRowKey(streaming, 0), messageRowKey(committed, 1))
    }
}
