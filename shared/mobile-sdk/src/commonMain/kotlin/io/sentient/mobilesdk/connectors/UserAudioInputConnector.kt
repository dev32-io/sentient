package io.sentient.mobilesdk.connectors

import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.protocol.ClientMessage
import io.sentient.mobilesdk.protocol.ServerMessage
import io.sentient.mobilesdk.voice.talk.TurnMode
import kotlin.concurrent.Volatile
import kotlin.uuid.ExperimentalUuidApi
import kotlin.uuid.Uuid

internal data class CaptureToken(val id: String, val generation: Long)
internal enum class CaptureTerminal { Commit, Cancel }

/** Capture-aware audio uplink. All calls are made on SdkVoice's serialized lane. */
class UserAudioInputConnector(
    private val send: (ClientMessage) -> Unit,
    private val sendBinary: (ByteArray) -> Unit,
    private val onTranscript: ((String) -> Unit)? = null,
    private val createCaptureId: () -> String = { randomCaptureId() },
) : Connector {
    override val capability: String = CAPABILITY
    private val log = createLogger("connector", "user-audio-input")

    private enum class Phase { Streaming, Terminating }
    private data class Active(val token: CaptureToken, var phase: Phase)

    @Volatile private var active: Active? = null
    @Volatile private var forceClosedThroughGeneration = 0L
    internal val hasActiveCapture: Boolean get() = active != null
    private var nextGeneration = 0L
    private val usedIds = mutableSetOf<String>()

    /** Allocates an identity for a serialized future start without opening the wire capture. */
    internal fun newCaptureToken(): CaptureToken? {
        val id = createCaptureId()
        if (id.isBlank() || id in usedIds) return null
        return CaptureToken(id, ++nextGeneration)
    }

    /** Emits start only when terminal cleanup of the previous capture has completed. */
    internal fun startStreaming(token: CaptureToken, turnMode: TurnMode): Boolean {
        if (token.generation <= forceClosedThroughGeneration || active != null || token.id.isBlank() || !usedIds.add(token.id)) return false
        active = Active(token, Phase.Streaming)
        send(ClientMessage.AudioStart(token.id, turnMode.wireValue))
        log.info("transition", mapOf("from" to "idle", "to" to "streaming", "generation" to token.generation, "turnMode" to turnMode.wireValue))
        return true
    }

    /** Compatibility entry used by existing shared callers: starts one semantic capture. */
    fun startStreaming(turnMode: TurnMode? = null): String? {
        if (active != null) return null
        val token = newCaptureToken() ?: return null
        return if (startStreaming(token, turnMode ?: TurnMode.Semantic)) token.id else null
    }

    /** Invalidates frame callbacks before pipeline stop/join begins. */
    internal fun beginTerminal(token: CaptureToken): Boolean {
        val record = active ?: return false
        if (record.token != token || record.phase != Phase.Streaming) return false
        record.phase = Phase.Terminating
        return true
    }

    /** Emits exactly one matching terminal after the producer has stopped. */
    internal fun completeTerminal(token: CaptureToken, terminal: CaptureTerminal) {
        val record = active ?: return
        if (record.token != token || record.phase != Phase.Terminating) return
        active = null
        when (terminal) {
            CaptureTerminal.Commit -> send(ClientMessage.AudioEnd(token.id))
            CaptureTerminal.Cancel -> send(ClientMessage.AudioCancel(token.id))
        }
        log.info("transition", mapOf("from" to "terminating", "to" to "idle", "generation" to token.generation, "terminal" to terminal.name))
    }

    /**
     * Timeout fallback for terminal SDK teardown. The serialized lane normally emits the
     * terminal before clearing this record. If an audio adapter never returns, clearing the
     * local generation still closes the frame gate immediately; a late lane completion then
     * observes no matching record and cannot emit a second terminal.
     */
    internal fun forceLocalTerminalCleanup(throughGeneration: Long) {
        forceClosedThroughGeneration = maxOf(forceClosedThroughGeneration, throughGeneration)
        active = null
    }

    /** Existing release behavior remains a commit. */
    fun stopStreaming() {
        val token = active?.token ?: return
        if (beginTerminal(token)) completeTerminal(token, CaptureTerminal.Commit)
    }

    fun cancelStreaming() {
        val token = active?.token ?: return
        if (beginTerminal(token)) completeTerminal(token, CaptureTerminal.Cancel)
    }

    internal fun frameSender(token: CaptureToken): (ByteArray) -> Unit = { frame -> sendAudioFrame(frame, token) }

    internal fun sendAudioFrame(frame: ByteArray, token: CaptureToken) {
        val record = active
        if (record?.token != token || record.phase != Phase.Streaming) {
            log.debug("frame-dropped", mapOf("reason" to "stale-generation", "bytes" to frame.size))
        } else {
            sendBinary(frame)
        }
    }

    /** Compatibility frame path targets only the currently streaming generation. */
    fun sendAudioFrame(frame: ByteArray) {
        val token = active?.takeIf { it.phase == Phase.Streaming }?.token ?: return
        sendAudioFrame(frame, token)
    }

    override fun handle(msg: ServerMessage) {
        if (msg is ServerMessage.ConnectorTranscriptFinal) onTranscript?.invoke(msg.text)
    }

    companion object {
        const val CAPABILITY: String = "audio.input"

        @OptIn(ExperimentalUuidApi::class)
        private fun randomCaptureId(): String = Uuid.random().toString()
    }
}
