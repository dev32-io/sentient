// ---------------------------------------------------------------------------
// UserAudioInputConnector — captures mic audio and streams it to the gateway.
//
// Mirrors web-sdk's user-audio-input-connector.ts VERBATIM:
//   capability = "audio.input"  (input-only on the control path; emits a binary
//                                uplink)
//   startStreaming() → send audio.start  (latched: no-op if already streaming)
//   sendAudioFrame(bytes) → sendBinary(bytes)  (dropped unless streaming)
//   stopStreaming() → send audio.end  (latched: no-op if not streaming)
//   connector.transcript.final → onTranscript(text)
//
// web-sdk reaches the wire via sdk.send (control) + sdk.sendBinary (PCM uplink);
// mobile-sdk injects BOTH lambdas so the orchestrator owns the transport. The
// E3 pipeline drives startStreaming → sendAudioFrame(frame)* → stopStreaming
// off the AudioCaptureAdapter + SpeechGate; this connector owns ONLY the
// isStreaming latch and the wire frames. No coroutines here — the pipeline owns
// the Flow plumbing (.claude/rules/mobile-sdk/coroutines-flow-surface.md).
//
// Threading: single-threaded; the orchestrator drives the public methods on its
// own dispatcher. The only mutable state is the isStreaming latch.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.connectors

import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.protocol.ClientMessage
import io.sentient.mobilesdk.protocol.ServerMessage
import io.sentient.mobilesdk.voice.talk.TurnMode

class UserAudioInputConnector(
    private val send: (ClientMessage) -> Unit,
    private val sendBinary: (ByteArray) -> Unit,
    private val onTranscript: ((String) -> Unit)? = null,
) : Connector {
    override val capability: String = CAPABILITY

    private val log = createLogger("connector", "user-audio-input")

    /** True while streaming uplink frames. Latch ported from web-sdk isStreaming. */
    private var isStreaming = false

    /**
     * Begin streaming audio to the gateway. Call after mic capture is started. [turnMode]
     * (design spec §4) rides the `audio.start` frame: null ⇒ field omitted ⇒ gateway defaults
     * to semantic (the continuous path + web parity, unchanged). Hold entry passes Manual,
     * Continuous entry passes Semantic.
     */
    fun startStreaming(turnMode: TurnMode? = null) {
        if (isStreaming) return
        isStreaming = true
        log.info(
            "transition",
            mapOf("from" to "idle", "to" to "streaming", "trigger" to "startStreaming", "turnMode" to (turnMode?.wireValue ?: "absent")),
        )
        send(ClientMessage.AudioStart(turnMode = turnMode?.wireValue))
    }

    /** Stop streaming audio to the gateway. */
    fun stopStreaming() {
        if (!isStreaming) return
        isStreaming = false
        log.info("transition", mapOf("from" to "streaming", "to" to "idle", "trigger" to "stopStreaming"))
        send(ClientMessage.AudioEnd)
    }

    /** Send a raw PCM16 LE frame to the gateway. Dropped silently unless streaming. */
    fun sendAudioFrame(frame: ByteArray) {
        if (!isStreaming) {
            log.debug("frame-dropped", mapOf("reason" to "not-streaming", "bytes" to frame.size))
            return
        }
        log.debug("uplink-frame", mapOf("bytes" to frame.size))
        sendBinary(frame)
    }

    /** Handles the inbound transcript frame; ignores every other type. */
    override fun handle(msg: ServerMessage) {
        when (msg) {
            is ServerMessage.ConnectorTranscriptFinal -> {
                log.info("transcript-final", mapOf("len" to msg.text.length, "language" to msg.language))
                onTranscript?.invoke(msg.text)
            }
            else -> Unit // not owned by this connector
        }
    }

    companion object {
        const val CAPABILITY: String = "audio.input"
    }
}
