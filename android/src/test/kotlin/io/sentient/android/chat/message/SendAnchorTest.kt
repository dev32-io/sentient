package io.sentient.android.chat.message

import kotlin.test.Test
import kotlin.test.assertEquals

class SendAnchorTest {
    @Test fun emitsOnlyNewSendIdentity() {
        val (s1, first) = reduceSendAnchor(SendAnchorState(), setOf(sendAnchorIdentity("p1")))
        assertEquals("send-p1", first)
        val (_, repeat) = reduceSendAnchor(s1, setOf(sendAnchorIdentity("p1")))
        assertEquals(null, repeat)
    }

    @Test fun assistantAndGrowthDoNotCreateAnchor() {
        val (s, _) = reduceSendAnchor(SendAnchorState(), setOf(sendAnchorIdentity("p1")))
        val (_, next) = reduceSendAnchor(s, setOf(sendAnchorIdentity("p1")))
        assertEquals(null, next)
    }

    @Test fun pendingAndCommittedEchoShareIdentity() {
        assertEquals(messageRowKey(
            io.sentient.mobilesdk.sdk.ChatMessage(ts = 1, role = "user", content = "hi", pendingId = "p1"), 0
        ), "send-p1")
    }
}
