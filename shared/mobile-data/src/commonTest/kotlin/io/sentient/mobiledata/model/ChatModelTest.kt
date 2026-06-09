package io.sentient.mobiledata.model

import io.sentient.mobilesdk.sdk.ChatMessage
import kotlin.test.Test
import kotlin.test.assertEquals

class ChatModelTest {
    @Test
    fun messagesForUi_appends_live_bubble_after_committed() {
        val committed = listOf(ChatMessage(ts = 1, role = "user", content = "hi"))
        val live = ChatMessage(ts = 2, role = "assistant", content = "he", streaming = true, cycleId = "c1")
        val m = ChatModel(committed = committed, live = live, tasks = emptyList())
        val ui = m.messagesForUi()
        assertEquals(2, ui.size)
        assertEquals("he", ui.last().content)
        assertEquals(true, ui.last().streaming)
    }

    @Test
    fun messagesForUi_is_committed_only_when_no_live() {
        val committed = listOf(ChatMessage(ts = 1, role = "user", content = "hi"))
        val m = ChatModel(committed = committed, live = null, tasks = emptyList())
        assertEquals(1, m.messagesForUi().size)
    }
}
