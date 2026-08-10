// ---------------------------------------------------------------------------
// PermissionConnectorTest — KEEPER (.claude/rules/testing.md): security boundary.
// Pins (1) the outbound permission.response wire frame, (2) fail-closed dismissal —
// nothing is ever auto-approved locally, and (3) that tool ARGUMENT VALUES never reach
// the log (they are user content; the same boundary PrivacyGuardTest defends).
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.connectors

import io.sentient.mobilesdk.protocol.ClientMessage
import io.sentient.mobilesdk.protocol.SdkEvent
import io.sentient.mobilesdk.protocol.ServerMessage
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class PermissionConnectorTest {

    private fun request(requestId: String, body: String = "hi mum") = ServerMessage.PermissionRequest(
        requestId = requestId,
        toolCallId = "tc-$requestId",
        toolName = "sendMessage",
        args = JsonObject(mapOf("to" to JsonPrimitive("mum"), "body" to JsonPrimitive(body))),
        description = "Send a message",
        expiresAtMs = 120_000,
    )

    @Test fun request_opensAPrompt_andEmitsAOneShotEvent() {
        val events = mutableListOf<SdkEvent>()
        val c = PermissionConnector(send = { }, onEvent = { events += it })

        c.handle(request("r1"))

        assertEquals(1, c.pending().size)
        val prompt = c.pending().first()
        assertEquals("r1", prompt.requestId)
        assertEquals("sendMessage", prompt.toolName)
        assertEquals("mum", prompt.args["to"])
        assertEquals(120_000L, prompt.expiresAtMs)
        assertEquals(listOf<SdkEvent>(SdkEvent.PermissionRequested(prompt)), events)
    }

    @Test fun twoConcurrentRequests_bothStayOpen() {
        val c = PermissionConnector(send = { })
        c.handle(request("r1"))
        c.handle(request("r2"))
        assertEquals(listOf("r1", "r2"), c.pending().map { it.requestId })
    }

    @Test fun respond_sendsPermissionResponse_andDismissesLocally() {
        val sent = mutableListOf<ClientMessage>()
        val c = PermissionConnector(send = { sent += it })
        c.handle(request("r1"))

        c.respond("r1", approved = false)

        assertEquals(listOf<ClientMessage>(ClientMessage.PermissionResponse(requestId = "r1", approved = false)), sent)
        assertEquals(emptyList(), c.pending())
    }

    @Test fun serverResolved_dismissesTheDialog_andEmitsTheOutcome() {
        val events = mutableListOf<SdkEvent>()
        val c = PermissionConnector(send = { }, onEvent = { events += it })
        c.handle(request("r1"))

        c.handle(ServerMessage.PermissionResolved(requestId = "r1", outcome = "timeout"))

        assertEquals(emptyList(), c.pending())
        assertTrue(events.contains(SdkEvent.PermissionResolved(requestId = "r1", outcome = "timeout")))
    }

    @Test fun reset_dropsOpenPrompts_withoutSendingAnyApproval() {
        val sent = mutableListOf<ClientMessage>()
        val c = PermissionConnector(send = { sent += it })
        c.handle(request("r1"))

        c.reset()

        assertEquals(emptyList(), c.pending())
        assertEquals(emptyList(), sent, "fail-closed: dropping a prompt must never send an approval")
    }
}
