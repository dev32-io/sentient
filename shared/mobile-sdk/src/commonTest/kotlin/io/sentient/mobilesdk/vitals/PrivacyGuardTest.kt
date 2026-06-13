// ---------------------------------------------------------------------------
// PrivacyGuardTest — privacy boundary: chat content must never appear in the
// captured diagnostic log. Drives the REAL streaming assistant-text path
// (InFlightMessageConnector handling CycleStarted → MessageDelta → MessageDone)
// with a VitalsLogTap sink registered, then asserts the secret delta text is
// absent from every captured line.
//
// Why this test belongs here (.claude/rules/testing.md):
//   Security boundary — log content privacy is an explicit boundary concern.
//   The SDK's logging convention logs deltaLen/totalLen only, never the delta
//   text. This guard pins that property so any future change that starts
//   logging raw content fails loudly instead of silently leaking to disk.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.vitals

import io.sentient.mobilesdk.connectors.InFlightMessageConnector
import io.sentient.mobilesdk.protocol.ServerMessage
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertTrue

class PrivacyGuardTest {

    @AfterTest fun reset() { VitalsLogTap.clear() }

    @Test fun captured_log_never_contains_chat_text() {
        val secret = "MY_SECRET_FAVORITE_NUMBER_IS_42"
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

        val log = captured.toString()
        assertTrue(
            !log.contains(secret),
            "chat text leaked into the diagnostic log:\n$log",
        )
    }
}
