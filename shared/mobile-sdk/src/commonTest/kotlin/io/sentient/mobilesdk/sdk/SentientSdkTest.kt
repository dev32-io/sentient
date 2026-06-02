// ---------------------------------------------------------------------------
// SentientSdkTest — integration/FSM test for the C7 orchestrator.
//
// KEEPER (per .claude/rules/testing.md): pins the connect handshake FSM,
// lifecycle-frame interception, and the single SdkState derivation contract
// both native UIs depend on. Drives a FakeWebSocketEngine over runTest virtual
// time with injected clock/newId/delay — no real waits, no platform.
//
// B1 caveat honored: FakeWebSocketEngine.open() returns `this` with a FRESH
// incoming channel each call; the SDK subscribes to the session returned by the
// open() it drives, so the test emits via the same fake the SDK opened.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.sdk

import io.sentient.mobilesdk.connectors.CognitionState
import io.sentient.mobilesdk.fakes.FakeWebSocketEngine
import io.sentient.mobilesdk.fakes.FixedClock
import io.sentient.mobilesdk.fakes.InMemorySessionIdStore
import io.sentient.mobilesdk.fakes.InMemoryTokenStore
import io.sentient.mobilesdk.transport.SdkStatus
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.yield
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class SentientSdkTest {

    // ── Fixtures ─────────────────────────────────────────────────────────────

    private val readyFrame =
        "{\"type\":\"session.ready\",\"sessionId\":\"s1\"," +
            "\"audioEncoding\":\"pcm\",\"inputSampleRate\":16000,\"outputSampleRate\":24000}"

    private fun TestScope.buildSdk(
        fake: FakeWebSocketEngine,
        tokenStore: InMemoryTokenStore = InMemoryTokenStore().apply { save("tok-abc") },
    ): SentientSdk {
        val bundle = PlatformBundle(
            engine = fake,
            tokenStore = tokenStore,
            sessionIdStore = InMemorySessionIdStore(),
            clock = FixedClock(0L),
            capture = null,
            playback = null,
        )
        return SentientSdk(
            config = SdkConfig(
                gatewayWsUrl = "wss://test/api/v1/ws",
                allowSelfSignedDevHost = false,
                capabilities = listOf("text.input", "conversation.history"),
            ),
            bundle = bundle,
            scope = backgroundScope,
            newId = run {
                var n = 0
                { "req-${n++}" }
            },
            // Park the idle tick far beyond the test horizon so the disconnect-on-idle
            // loop never races the assertions under runTest virtual time.
            idleTickMs = 1_000_000_000L,
        )
    }

    /** Drive the connect handshake to READY: connect, then emit auth.ok + session.ready. */
    private suspend fun TestScope.connectToReady(sdk: SentientSdk, fake: FakeWebSocketEngine) {
        val job = launch { sdk.connect() }
        // Let connect open the socket + send auth, then drive the server side.
        sdk.state.first { it.status == SdkStatus.AUTHENTICATING }
        fake.emit(io.sentient.mobilesdk.transport.WsIncoming.Text("{\"type\":\"auth.ok\",\"user\":{\"userId\":\"u1\",\"displayName\":\"U\"}}"))
        fake.emit(io.sentient.mobilesdk.transport.WsIncoming.Text(readyFrame))
        sdk.state.first { it.status == SdkStatus.READY }
        job.join()
    }

    // ── Tests ────────────────────────────────────────────────────────────────

    @Test
    fun connect_drives_status_through_handshake_to_ready() = runTest {
        val fake = FakeWebSocketEngine()
        val sdk = buildSdk(fake)

        assertEquals(SdkStatus.DISCONNECTED, sdk.state.value.status)

        // attemptConnect sets CONNECTING then AUTHENTICATING synchronously before
        // suspending on the auth gate; a conflated StateFlow surfaces the
        // destination (AUTHENTICATING). connectToReady gates on it via first {}.
        val reachedAuthenticating = launch { sdk.state.first { it.status == SdkStatus.AUTHENTICATING } }

        connectToReady(sdk, fake)
        reachedAuthenticating.join()

        assertEquals(SdkStatus.READY, sdk.state.value.status)
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
    fun assistant_conversation_entry_appears_in_state_messages() = runTest {
        val fake = FakeWebSocketEngine()
        val sdk = buildSdk(fake)
        connectToReady(sdk, fake)

        fake.emit(
            io.sentient.mobilesdk.transport.WsIncoming.Text(
                "{\"type\":\"conversation.entry\",\"item\":" +
                    "{\"kind\":\"assistant\",\"ts\":100,\"content\":\"hello there\"}}",
            ),
        )
        sdk.state.first { it.messages.isNotEmpty() }

        val msgs = sdk.state.value.messages
        assertEquals(1, msgs.size)
        assertEquals("assistant", msgs[0].role)
        assertEquals("hello there", msgs[0].content)
        assertEquals(false, msgs[0].streaming)
    }

    @Test
    fun inflight_streaming_then_done_reflects_in_state_messages() = runTest {
        val fake = FakeWebSocketEngine()
        val sdk = buildSdk(fake)
        connectToReady(sdk, fake)

        fake.emit(io.sentient.mobilesdk.transport.WsIncoming.Text("{\"type\":\"cycle.started\",\"cycleId\":\"c1\"}"))
        fake.emit(io.sentient.mobilesdk.transport.WsIncoming.Text("{\"type\":\"message.delta\",\"cycleId\":\"c1\",\"delta\":\"par\"}"))
        fake.emit(io.sentient.mobilesdk.transport.WsIncoming.Text("{\"type\":\"message.delta\",\"cycleId\":\"c1\",\"delta\":\"tial\"}"))
        // streaming bubble present
        sdk.state.first { st -> st.messages.any { it.streaming } }
        val streaming = sdk.state.value.messages.last()
        assertTrue(streaming.streaming, "expected streaming bubble, msgs=${sdk.state.value.messages}")
        assertEquals("partial", streaming.content)

        // committed entry arrives, then message.done clears inflight
        fake.emit(
            io.sentient.mobilesdk.transport.WsIncoming.Text(
                "{\"type\":\"conversation.entry\",\"item\":" +
                    "{\"kind\":\"assistant\",\"ts\":200,\"content\":\"partial\"}}",
            ),
        )
        fake.emit(io.sentient.mobilesdk.transport.WsIncoming.Text("{\"type\":\"message.done\",\"cycleId\":\"c1\"}"))
        sdk.state.first { st -> st.messages.none { it.streaming } }

        val msgs = sdk.state.value.messages
        assertTrue(msgs.none { it.streaming }, "inflight should be cleared, msgs=$msgs")
        assertTrue(msgs.any { it.role == "assistant" && it.content == "partial" }, "msgs=$msgs")
    }

    @Test
    fun cognition_thinking_on_cycle_started_idle_on_completed() = runTest {
        val fake = FakeWebSocketEngine()
        val sdk = buildSdk(fake)
        connectToReady(sdk, fake)

        fake.emit(io.sentient.mobilesdk.transport.WsIncoming.Text("{\"type\":\"cycle.started\",\"cycleId\":\"c1\"}"))
        sdk.state.first { it.cognition == CognitionState.THINKING }
        assertEquals(CognitionState.THINKING, sdk.state.value.cognition)

        fake.emit(io.sentient.mobilesdk.transport.WsIncoming.Text("{\"type\":\"cycle.completed\",\"cycleId\":\"c1\"}"))
        sdk.state.first { it.cognition == CognitionState.IDLE }
        assertEquals(CognitionState.IDLE, sdk.state.value.cognition)
    }

    @Test
    fun is_speaking_true_between_audio_start_and_done() = runTest {
        val fake = FakeWebSocketEngine()
        val sdk = buildSdk(fake)
        connectToReady(sdk, fake)

        fake.emit(io.sentient.mobilesdk.transport.WsIncoming.Text("{\"type\":\"connector.audio.start\",\"cycleId\":\"c1\"}"))
        sdk.state.first { it.isSpeaking }
        assertTrue(sdk.state.value.isSpeaking)

        fake.emit(io.sentient.mobilesdk.transport.WsIncoming.Text("{\"type\":\"connector.audio.done\",\"cycleId\":\"c1\"}"))
        sdk.state.first { !it.isSpeaking }
        assertTrue(!sdk.state.value.isSpeaking)
    }

    @Test
    fun auth_error_sets_error_status_and_auth_expired() = runTest {
        val fake = FakeWebSocketEngine()
        val sdk = buildSdk(fake)

        val job = launch { sdk.connect() }
        sdk.state.first { it.status == SdkStatus.AUTHENTICATING }
        fake.emit(
            io.sentient.mobilesdk.transport.WsIncoming.Text(
                "{\"type\":\"auth.error\",\"code\":\"expired\",\"message\":\"token expired\"}",
            ),
        )
        sdk.state.first { it.status == SdkStatus.ERROR }
        job.join()

        assertEquals(SdkStatus.ERROR, sdk.state.value.status)
        assertTrue(sdk.state.value.authExpired)
    }

    @Test
    fun disconnect_sets_disconnected_and_is_idempotent() = runTest {
        val fake = FakeWebSocketEngine()
        val sdk = buildSdk(fake)
        connectToReady(sdk, fake)

        sdk.disconnect()
        yield()
        assertEquals(SdkStatus.DISCONNECTED, sdk.state.value.status)

        // idempotent — second call must not throw or flip state
        sdk.disconnect()
        yield()
        assertEquals(SdkStatus.DISCONNECTED, sdk.state.value.status)
    }
}
