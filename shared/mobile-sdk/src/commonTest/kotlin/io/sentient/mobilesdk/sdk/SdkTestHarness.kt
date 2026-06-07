// ---------------------------------------------------------------------------
// SdkTestHarness — shared fixtures for the C7 orchestrator tests.
//
// Builds a SentientSdk over a FakeWebSocketEngine with runTest virtual time and
// injected clock/newId — no real waits, no platform. The idle tick is parked far
// beyond the test horizon so the disconnect-on-idle loop never races assertions.
//
// B1 caveat: FakeWebSocketEngine mints a FRESH session per open(); the helpers
// drive the CURRENT session, so a reconnect's second open() is driven cleanly.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.sdk

import io.sentient.mobilesdk.fakes.FakeWebSocketEngine
import io.sentient.mobilesdk.fakes.FixedClock
import io.sentient.mobilesdk.fakes.InMemorySessionIdStore
import io.sentient.mobilesdk.fakes.InMemoryTokenStore
import io.sentient.mobilesdk.transport.SdkStatus
import io.sentient.mobilesdk.transport.WebSocketEngine
import io.sentient.mobilesdk.transport.WsIncoming
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope

/** session.ready frame with the negotiated audio tunables. */
internal const val READY_FRAME =
    "{\"type\":\"session.ready\",\"sessionId\":\"s1\"," +
        "\"audioEncoding\":\"pcm\",\"inputSampleRate\":16000,\"outputSampleRate\":24000}"

/** auth.ok frame for a known user. */
internal const val AUTH_OK_FRAME =
    "{\"type\":\"auth.ok\",\"user\":{\"userId\":\"u1\",\"displayName\":\"U\"}}"

/**
 * Build a SentientSdk wired to [engine] over the test's [backgroundScope].
 * Accepts the [WebSocketEngine] interface so tests can pass a FakeWebSocketEngine
 * or a wrapper (e.g. one that fails re-opens to drive reconnect exhaustion).
 */
internal fun TestScope.buildSdk(
    engine: WebSocketEngine,
    tokenStore: InMemoryTokenStore = InMemoryTokenStore().apply { save("tok-abc") },
): SentientSdk {
    val bundle = PlatformBundle(
        engine = engine,
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
internal suspend fun TestScope.connectToReady(sdk: SentientSdk, fake: FakeWebSocketEngine) {
    val job = launch { sdk.connect() }
    // Let connect open the socket + send auth, then drive the server side.
    sdk.connection.first { it.status == SdkStatus.AUTHENTICATING }
    fake.emit(WsIncoming.Text(AUTH_OK_FRAME))
    fake.emit(WsIncoming.Text(READY_FRAME))
    sdk.connection.first { it.status == SdkStatus.READY }
    job.join()
}
