package io.sentient.mobiledata.di

import io.sentient.mobilesdk.protocol.SdkEvent
import io.sentient.mobilesdk.sdk.PlatformBundle
import io.sentient.mobilesdk.sdk.SdkConfig
import io.sentient.mobilesdk.sdk.SentientSdk
import io.sentient.mobilesdk.sdk.VoiceMode
import io.sentient.mobilesdk.secure.DeviceIdStore
import io.sentient.mobilesdk.secure.SecureTokenStore
import io.sentient.mobilesdk.transport.SdkStatus
import io.sentient.mobilesdk.transport.WebSocketEngine
import io.sentient.mobilesdk.transport.WebSocketSession
import io.sentient.mobilesdk.transport.WsIncoming
import io.sentient.mobilesdk.util.Clock
import io.sentient.mobilesdk.voice.io.VoiceAudio
import io.sentient.mobilesdk.voice.io.VoiceAudioState
import io.sentient.mobilesdk.voice.io.VoiceAudioState.Phase
import io.sentient.mobilesdk.voice.talk.TalkMode
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.FlowCollector
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** Real SDK observer + lane + component event bridge. No PCM, native codec, or network. */
class CaptureStartFailureIntegrationTest {
    @Test
    fun observer_first_failure_delivers_typed_notice_discards_and_retries() = scenario(observerFirst = true)

    @Test
    fun handler_first_failure_delivers_typed_notice_discards_and_retries() = scenario(observerFirst = false)

    @Test
    fun conflated_error_still_resets_mode_before_notice_and_accepts_retry() =
        scenario(observerFirst = false, conflateError = true)

    private fun scenario(observerFirst: Boolean, conflateError: Boolean = false) = runTest {
        withContext(Dispatchers.Default) {
            withTimeout(10_000) {
                val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
                val audio = GatedAudio(observerFirst, conflateError)
                val socket = Socket()
                val sdk = SentientSdk(
                    SdkConfig(gatewayWsUrl = "wss://test.invalid/api/v1/ws", allowSelfSignedDevHost = false, capabilities = listOf("audio.input")),
                    PlatformBundle(
                        engine = object : WebSocketEngine {
                            override suspend fun open(url: String, allowSelfSignedDevHost: Boolean) = socket
                        },
                        tokenStore = object : SecureTokenStore {
                            override fun load() = "fixture-token"
                            override fun save(token: String) {}
                            override fun clear() {}
                        },
                        deviceIdStore = object : DeviceIdStore {
                            override fun load() = "fixture-device"
                            override fun save(id: String) {}
                        },
                        clock = Clock { 0L }, voiceAudio = audio,
                    ), scope,
                )
                val component = ChatComponent(sdk)
                val notices = Channel<SdkEvent.CaptureStartFailed>(Channel.UNLIMITED)
                val collector = scope.launch(start = CoroutineStart.UNDISPATCHED) {
                    component.captureStartFailures.collect { notices.send(it) }
                }
                try {
                    val connecting = scope.async { sdk.connect() }
                    sdk.connection.first { it.status == SdkStatus.AUTHENTICATING }
                    socket.frame("""{"type":"auth.ok","user":{"userId":"fixture","displayName":"Fixture"}}""")
                    socket.frame("""{"type":"session.ready","sessionId":"fixture-session","audioEncoding":"pcm","inputSampleRate":16000,"outputSampleRate":24000}""")
                    connecting.await()
                    component.holdStart()
                    val start = socket.controls.receive()
                    assertEquals("audio.start", start.first)
                    audio.entered.await()
                    assertEquals(TalkMode.Hold, component.talkMode.value, "Configuring mic=false is not failure")
                    audio.fail.complete(Unit)
                    if (observerFirst) {
                        // Observer claims terminal before configure returns.
                        component.talkMode.first { it == TalkMode.Idle }
                    }
                    if (!conflateError) audio.errorObserved.await()
                    audio.finish.complete(Unit)
                    assertEquals("audio.cancel" to start.second, socket.controls.receive())
                    val notice = notices.receive()
                    assertEquals(start.second, notice.captureId)
                    assertTrue(component.isCaptureStartFailureCurrent(notice))
                    assertFalse(component.isCaptureStartFailureCurrent(notice.copy(routeGeneration = (notice.routeGeneration ?: 0) + 1)))
                    assertFalse(component.isCaptureStartFailureCurrent(notice.copy(captureGeneration = notice.captureGeneration + 1)))
                    assertEquals(SdkStatus.READY, component.connection.state.value.status)
                    assertEquals(TalkMode.Idle, component.talkMode.value, "notice must be actionable")
                    assertEquals(VoiceMode.OFF, sdk.connection.value.voiceMode)
                    sdk.sendText("fixture text", pendingId = "fixture-pending")
                    assertEquals("fixture-pending", socket.textInputs.receive())
                    // Retry at notice delivery, without releasing the old Error observer.
                    component.holdStart()
                    val retry = socket.controls.receive()
                    assertEquals("audio.start", retry.first)
                    assertTrue(retry.second != start.second)
                    audio.retryEntered.await()
                    // New capture is accepted but configure has not replaced the old Error.
                    // Checking only state === audioState.value cannot fence this delivery.
                    assertEquals(Phase.Error, audio.state.value.phase)
                    if (!conflateError) {
                        audio.allowObserver.complete(Unit)
                        audio.errorDelivered.await()
                        assertEquals(TalkMode.Hold, component.talkMode.value, "old Error must not cancel successor")
                    }
                    audio.allowRetry.complete(Unit)
                    audio.retryReady.await()
                    audio.startObserving.complete(Unit)
                    audio.readyDelivered.await()
                    assertEquals(TalkMode.Hold, component.talkMode.value)
                    assertFalse(component.isCaptureStartFailureCurrent(notice), "retry fences buffered notice")
                    component.lifecycleCancel()
                    component.lifecycleCancel()
                    assertEquals("audio.cancel" to retry.second, socket.controls.receive())
                    assertTrue(notices.tryReceive().isFailure, "exactly one failure notice")
                    assertTrue(socket.controls.tryReceive().isFailure, "no Send/Commit or duplicate discard")
                } finally {
                    audio.allowObserver.complete(Unit)
                    audio.startObserving.complete(Unit)
                    audio.allowRetry.complete(Unit)
                    audio.fail.complete(Unit)
                    audio.finish.complete(Unit)
                    sdk.disconnect()
                    collector.cancel()
                    component.close()
                    scope.cancel()
                }
            }
        }
    }

    private class GatedAudio(observerFirst: Boolean, conflateError: Boolean) : VoiceAudio {
        private val projected = MutableStateFlow(VoiceAudioState(Phase.Idle, false, false))
        val startObserving = CompletableDeferred<Unit>().apply { if (!conflateError) complete(Unit) }
        val errorObserved = CompletableDeferred<Unit>()
        val readyDelivered = CompletableDeferred<Unit>()
        val retryReady = CompletableDeferred<Unit>()
        val retryEntered = CompletableDeferred<Unit>()
        val allowRetry = CompletableDeferred<Unit>()
        val errorDelivered = CompletableDeferred<Unit>()
        val allowObserver = CompletableDeferred<Unit>().apply { if (observerFirst) complete(Unit) }
        override val state: StateFlow<VoiceAudioState> = object : StateFlow<VoiceAudioState> by projected {
            override suspend fun collect(collector: FlowCollector<VoiceAudioState>): Nothing {
                startObserving.await()
                projected.collect {
                    if (it.phase == Phase.Error) {
                        errorObserved.complete(Unit)
                        allowObserver.await()
                    }
                    collector.emit(it)
                    if (it.phase == Phase.Error) errorDelivered.complete(Unit)
                    if (it.phase == Phase.Ready && it.micActive) readyDelivered.complete(Unit)
                }
            }
        }
        override val micFrames = emptyFlow<ShortArray>()
        val entered = CompletableDeferred<Unit>()
        val fail = CompletableDeferred<Unit>()
        val finish = CompletableDeferred<Unit>()
        private var failed = false
        override suspend fun configure(mic: Boolean, playback: Boolean, playbackRateHz: Int) {
            if (mic && !failed) {
                failed = true
                projected.value = VoiceAudioState(Phase.Configuring, false, playback)
                entered.complete(Unit)
                fail.await()
                projected.value = VoiceAudioState(Phase.Error, true, playback, "engine-start-failed")
                finish.await()
            } else {
                if (mic) {
                    retryEntered.complete(Unit)
                    allowRetry.await()
                }
                projected.value = VoiceAudioState(Phase.Ready, mic, playback)
                if (mic) retryReady.complete(Unit)
            }
        }
        override fun playFrame(pcm16: ByteArray) = error("no playback")
        override fun flushPlayback() {}
        override val isPlaybackIdle = true
        override suspend fun shutdown() { projected.value = VoiceAudioState(Phase.Idle, false, false) }
    }

    private class Socket : WebSocketSession {
        private val frames = Channel<WsIncoming>(Channel.UNLIMITED)
        override val incoming = frames.receiveAsFlow()
        val textInputs = Channel<String>(Channel.UNLIMITED)
        val controls = Channel<Pair<String, String>>(Channel.UNLIMITED)
        override suspend fun sendText(text: String) {
            val message = Json.parseToJsonElement(text).jsonObject
            val type = message.getValue("type").jsonPrimitive.content
            if (type == "text.input") textInputs.send(message.getValue("pendingId").jsonPrimitive.content)
            if (type.startsWith("audio.")) controls.send(type to message.getValue("captureId").jsonPrimitive.content)
        }
        override suspend fun sendBinary(bytes: ByteArray) = error("no PCM")
        override suspend fun close(code: Int, reason: String) { frames.close() }
        suspend fun frame(json: String) { frames.send(WsIncoming.Text(json)) }
    }
}
