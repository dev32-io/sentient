package io.sentient.android.chat

import io.sentient.mobiledata.model.ChatModel
import io.sentient.mobiledata.outbox.MessageStatus
import io.sentient.mobiledata.outbox.PendingMessage
import io.sentient.mobiledata.result.SentientResult
import io.sentient.mobilesdk.result.SentientError
import io.sentient.mobilesdk.sdk.ChatMessage
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

class ChatViewModelTest {
    @Test
    fun success_replaces_model_and_clears_banner() {
        val model = ChatModel(
            committed = listOf(ChatMessage(ts = 1, role = "user", content = "hi")),
            pending = listOf(PendingMessage("p1", "later", MessageStatus.QUEUED)),
            live = ChatMessage(ts = 2, role = "assistant", content = "he", streaming = true, turnId = "t1"),
        )
        val ui = reduceChatUi(ChatUiState(banner = ErrorBanner("old", true)), SentientResult.Success(model))
        assertEquals(1, ui.model.committed.size)
        assertEquals(1, ui.model.pending.size)
        assertEquals("he", ui.model.live?.content)
        assertEquals(false, ui.isLoading)
        assertNull(ui.banner)
    }

    @Test
    fun failure_keeps_last_good_model_and_sets_retryable_banner() {
        val prior = ChatUiState(model = ChatModel(committed = listOf(ChatMessage(ts = 1, role = "user", content = "hi"))))
        val ui = reduceChatUi(prior, SentientResult.Failure(SentientError.Connection("lost")))
        assertEquals(1, ui.model.committed.size)         // last-good kept
        assertNotNull(ui.banner)
        assertEquals("lost", ui.banner!!.text)
        assertTrue(ui.banner!!.canRetry)                  // Connection → Internal retry (canRetry true)
    }

    @Test
    fun loading_with_partial_shows_partial_and_isLoading() {
        val partial = ChatModel(committed = listOf(ChatMessage(ts = 1, role = "user", content = "hi")))
        val ui = reduceChatUi(ChatUiState(), SentientResult.Loading(partial = partial))
        assertEquals(true, ui.isLoading)
        assertEquals(1, ui.model.committed.size)
    }
}
