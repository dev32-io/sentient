// ---------------------------------------------------------------------------
// PrivacyGuardTest — privacy boundary: chat content must never appear in the
// captured diagnostic log. Two cases are pinned:
//
//   1. InFlightMessageConnector (streaming assistant text path): logs only
//      cycleId, deltaLen, totalLen — never the raw delta. This was the
//      original guard.
//
//   2. WsTransport recv path (NEW): the inbound TEXT-frame boundary was the
//      proven chat-content leak site (line 143 of WsTransport.kt logged `raw`
//      directly). This case drives the REAL WsTransport.routeText path via
//      FakeWebSocketEngine so the guard now exercises the actual leak vector
//      and will fail loudly if raw-frame logging is ever re-introduced.
//
// Why this test belongs here (.claude/rules/testing.md):
//   Security boundary — log content privacy is an explicit boundary concern.
//   The SDK's logging convention logs lengths/ids/types only, never message
//   content. This guard pins that property so any future change that starts
//   logging raw content fails loudly instead of silently leaking to disk.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.vitals

import io.sentient.mobilesdk.connectors.InFlightMessageConnector
import io.sentient.mobilesdk.fakes.FakeWebSocketEngine
import io.sentient.mobilesdk.log.LogConfig
import io.sentient.mobilesdk.log.LogLevel
import io.sentient.mobilesdk.protocol.ServerMessage
import io.sentient.mobilesdk.transport.WsIncoming
import io.sentient.mobilesdk.transport.WsTransport
import kotlinx.coroutines.flow.launchIn
import kotlinx.coroutines.test.runTest
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertTrue

class PrivacyGuardTest {

    @AfterTest fun reset() {
        VitalsLogTap.clear()
        LogConfig.minLevel = LogLevel.DEBUG
    }

    @Test fun captured_log_never_contains_chat_text() {
        val secret = "the capital of France is Paris and my dog is named Biscuit"
        val captured = StringBuilder()
        VitalsLogTap.register { _, tag, line ->
            captured.append(tag).append(' ').append(line).append('\n')
        }

        // Drive the REAL streaming path with the secret as the assistant delta text.
        // InFlightMessageConnector logs only cycleId, deltaLen, and totalLen — never
        // the raw delta — so the secret must not appear in the captured output.
        val c = InFlightMessageConnector()
        c.handle(ServerMessage.CycleStarted(cycleId = "c-priv-1", triggerKind = "text"))
        c.handle(ServerMessage.MessageDelta(cycleId = "c-priv-1", delta = secret))
        c.handle(ServerMessage.MessageDone(cycleId = "c-priv-1"))

        // Also exercise the abort (barge-in) path — in-flight content dropped mid-stream
        // is the primary case the diagnostic feature exists to debug and a plausible
        // future leak vector. The secret must not appear in abort logging either.
        c.handle(ServerMessage.CycleStarted(cycleId = "c-priv-2", triggerKind = "text"))
        c.handle(ServerMessage.MessageDelta(cycleId = "c-priv-2", delta = secret))
        c.handle(ServerMessage.CycleAborted(cycleId = "c-priv-2", reason = "barge-in"))

        val log = captured.toString()
        assertTrue(
            !log.contains(secret),
            "chat text leaked into the diagnostic log:\n$log",
        )
    }

    /**
     * Exercises the REAL WsTransport inbound TEXT-frame path — the proven
     * chat-content leak site (WsTransport.routeText logged `raw` directly before
     * the fix). A realistic assistant.message.delta JSON frame whose `delta` field
     * contains the secret is delivered through FakeWebSocketEngine so that
     * routeText runs and logs. The captured ring must contain ZERO chat text.
     *
     * Before fix: log.debug("recv-text", mapOf("raw" to raw)) → the first 120
     * chars of the frame body appear in the ring, leaking the delta text.
     * After fix:  log.debug("recv-text", mapOf("len" to raw.length)) → only an
     * integer length is captured; the secret cannot appear.
     */
    @Test fun ws_transport_recv_path_never_logs_frame_content() = runTest {
        val secret = "the capital of France is Paris and my dog is named Biscuit"
        val captured = StringBuilder()
        VitalsLogTap.register { _, tag, line ->
            captured.append(tag).append(' ').append(line).append('\n')
        }

        // Realistic assistant.message.delta wire frame — this is the exact JSON
        // shape the gateway sends. The `delta` field holds the chat content that
        // was leaking into the diagnostic ring.
        val frame = """{"type":"assistant.message.delta","cycleId":"c-ws-priv-1","delta":"$secret"}"""

        val fake = FakeWebSocketEngine()
        val session = fake.open("wss://test/ws", allowSelfSignedDevHost = false)
        // Drain events so the pump coroutine progresses — pump blocks on channel
        // send until a consumer reads, and backgroundScope ensures it's cleaned up.
        val transport = WsTransport(session, scope = backgroundScope)
        transport.events.launchIn(backgroundScope)

        // Deliver the secret-bearing text frame through the real transport recv path.
        fake.emit(WsIncoming.Text(frame))
        // Close the session so the pump drains and the log line is committed.
        fake.closeIncoming()

        val log = captured.toString()
        assertTrue(
            !log.contains(secret),
            "chat text from WS frame leaked into the diagnostic log:\n$log",
        )
    }
}
