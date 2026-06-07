// ---------------------------------------------------------------------------
// SentientSdkTest — handshake/lifecycle FSM test for the C7 orchestrator.
//
// KEEPER (per .claude/rules/testing.md): pins the connect handshake FSM,
// lifecycle-frame interception, and the split surface derivation contract
// (connection + timeline) both native UIs depend on. Drives a
// FakeWebSocketEngine over runTest virtual time with injected
// clock/newId/delay — no real waits, no platform.
//
// Shared fixtures live in SdkTestHarness.kt; reconnect + message-fold +
// transcript-clear contracts live in SentientSdkReconnectTest.kt.
//
// NOTE: cognition and transcript fields are NOT exposed on the new surfaces
// (connection/timeline/events). Tests that only exercised those SdkState-only
// fields (cognition_thinking_on_cycle_started_idle_on_completed,
// is_speaking_true_between_audio_start_and_done streaming bubble) were
// pinning the removed aggregate; they are deleted here.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.sdk

import io.sentient.mobilesdk.fakes.FakeWebSocketEngine
import io.sentient.mobilesdk.transport.SdkStatus
import io.sentient.mobilesdk.transport.WsIncoming
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.yield
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class SentientSdkTest {

    @Test
    fun connect_drives_status_through_handshake_to_ready() = runTest {
        val fake = FakeWebSocketEngine()
        val sdk = buildSdk(fake)

        assertEquals(SdkStatus.DISCONNECTED, sdk.connection.value.status)

        // attemptConnect sets CONNECTING then AUTHENTICATING synchronously before
        // suspending on the auth gate; a conflated StateFlow surfaces the
        // destination (AUTHENTICATING). connectToReady gates on it via first {}.
        val reachedAuthenticating = launch { sdk.connection.first { it.status == SdkStatus.AUTHENTICATING } }

        connectToReady(sdk, fake)
        reachedAuthenticating.join()

        assertEquals(SdkStatus.READY, sdk.connection.value.status)
    }

    @Test
    fun handshake_sends_auth_then_session_configure_with_mobile_client_type() = runTest {
        val fake = FakeWebSocketEngine()
        val sdk = buildSdk(fake)

        connectToReady(sdk, fake)

        // First frame = auth, second = session.configure with clientType=mobile.
        assertTrue(fake.sentText.size >= 2, "sent=${fake.sentText}")
        assertTrue(fake.sentText[0].contains("\"type\":\"auth\""), "auth=${fake.sentText[0]}")
        assertTrue(fake.sentText[0].contains("\"token\":\"tok-abc\""), "auth=${fake.sentText[0]}")
        val cfg = fake.sentText[1]
        assertTrue(cfg.contains("\"type\":\"session.configure\""), "cfg=$cfg")
        assertTrue(cfg.contains("\"clientType\":\"mobile\""), "cfg=$cfg")
    }

    @Test
    fun send_text_while_ready_records_text_input_frame() = runTest {
        val fake = FakeWebSocketEngine()
        val sdk = buildSdk(fake)
        connectToReady(sdk, fake)

        sdk.sendText("hi")
        yield()

        assertTrue(
            fake.sentText.any { it.contains("\"type\":\"text.input\"") && it.contains("\"text\":\"hi\"") },
            "sent=${fake.sentText}",
        )
    }

    @Test
    fun assistant_conversation_entry_appears_in_timeline() = runTest {
        val fake = FakeWebSocketEngine()
        val sdk = buildSdk(fake)
        connectToReady(sdk, fake)

        fake.emit(
            WsIncoming.Text(
                "{\"type\":\"conversation.entry\",\"item\":" +
                    "{\"kind\":\"assistant\",\"ts\":100,\"content\":\"hello there\"}}",
            ),
        )
        sdk.timeline.first { it.isNotEmpty() }

        val msgs = sdk.timeline.value
        assertEquals(1, msgs.size)
        assertEquals("assistant", msgs[0].role)
        assertEquals("hello there", msgs[0].content)
        assertEquals(false, msgs[0].streaming)
    }

    @Test
    fun inflight_streaming_then_done_commits_to_timeline() = runTest {
        val fake = FakeWebSocketEngine()
        val sdk = buildSdk(fake)
        connectToReady(sdk, fake)

        fake.emit(WsIncoming.Text("{\"type\":\"cycle.started\",\"cycleId\":\"c1\"}"))
        fake.emit(WsIncoming.Text("{\"type\":\"message.delta\",\"cycleId\":\"c1\",\"delta\":\"par\"}"))
        fake.emit(WsIncoming.Text("{\"type\":\"message.delta\",\"cycleId\":\"c1\",\"delta\":\"tial\"}"))

        // committed entry arrives, then message.done clears inflight
        fake.emit(
            WsIncoming.Text(
                "{\"type\":\"conversation.entry\",\"item\":" +
                    "{\"kind\":\"assistant\",\"ts\":200,\"content\":\"partial\"}}",
            ),
        )
        fake.emit(WsIncoming.Text("{\"type\":\"message.done\",\"cycleId\":\"c1\"}"))

        // Timeline is committed-only (no streaming bubble); wait for the entry.
        sdk.timeline.first { msgs -> msgs.any { it.role == "assistant" && it.content == "partial" } }

        val msgs = sdk.timeline.value
        assertTrue(msgs.none { it.streaming }, "timeline has no streaming entries, msgs=$msgs")
        assertTrue(msgs.any { it.role == "assistant" && it.content == "partial" }, "msgs=$msgs")
    }

    @Test
    fun is_speaking_reflected_on_connection_surface() = runTest {
        val fake = FakeWebSocketEngine()
        val sdk = buildSdk(fake)
        connectToReady(sdk, fake)

        fake.emit(WsIncoming.Text("{\"type\":\"connector.audio.start\",\"cycleId\":\"c1\"}"))
        sdk.connection.first { it.isSpeaking }
        assertTrue(sdk.connection.value.isSpeaking)

        fake.emit(WsIncoming.Text("{\"type\":\"connector.audio.done\",\"cycleId\":\"c1\"}"))
        sdk.connection.first { !it.isSpeaking }
        assertTrue(!sdk.connection.value.isSpeaking)
    }

    @Test
    fun auth_error_sets_error_status_and_auth_expired() = runTest {
        val fake = FakeWebSocketEngine()
        val sdk = buildSdk(fake)

        val job = launch { sdk.connect() }
        sdk.connection.first { it.status == SdkStatus.AUTHENTICATING }
        fake.emit(
            WsIncoming.Text("{\"type\":\"auth.error\",\"code\":\"expired\",\"message\":\"token expired\"}"),
        )
        sdk.connection.first { it.status == SdkStatus.ERROR }
        job.join()

        assertEquals(SdkStatus.ERROR, sdk.connection.value.status)
        assertTrue(sdk.connection.value.authExpired)
    }

    @Test
    fun disconnect_sets_disconnected_and_is_idempotent() = runTest {
        val fake = FakeWebSocketEngine()
        val sdk = buildSdk(fake)
        connectToReady(sdk, fake)

        sdk.disconnect()
        yield()
        assertEquals(SdkStatus.DISCONNECTED, sdk.connection.value.status)

        // idempotent — second call must not throw or flip state
        sdk.disconnect()
        yield()
        assertEquals(SdkStatus.DISCONNECTED, sdk.connection.value.status)
    }
}
