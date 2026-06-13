// ---------------------------------------------------------------------------
// WsTransport — the WS send/receive boundary over a WebSocketSession.
//
// Wraps one open [WebSocketSession] (B1) and demultiplexes its single
// [WsIncoming] stream into typed outbound flows:
//   - [events]   — ONE ordered stream of [WsEvent]: TEXT frames decoded to
//                  [ServerMessage] (WsEvent.Control) and BINARY frames passed
//                  through as raw ByteArray (WsEvent.Audio), interleaved in
//                  EXACT arrival order. Cross-stream order is part of the wire
//                  contract (trailing audio precedes `connector.audio.done`), so
//                  control and audio MUST share one channel from one pump — two
//                  channels drained by two collectors would race and let
//                  `audio.done` overtake the audio it terminates.
//   - [signals]  — Closed / Failure surfaced as [TransportSignal] for the
//                  reconnect layer (web-sdk's onclose / onerror split).
//
// A single pump coroutine drains session.incoming once (the underlying channel
// is single-consumer) and routes onto the completing channels, so each public
// flow terminates when the socket closes — `toList` does not hang.
//
// Per logging.md: incoming TEXT is logged at DEBUG (frame length only) so the
// diagnostic ring never captures chat content. Sends log type only, never the
// payload. If a protocol break needs the raw bytes, the gateway logs hold them.
// Per error-handling.md: failures are signals on [signals], never thrown.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.transport

import io.sentient.mobilesdk.dev.FaultHooks
import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.protocol.ClientMessage
import io.sentient.mobilesdk.protocol.ServerMessage
import io.sentient.mobilesdk.protocol.WireJson
import io.sentient.mobilesdk.result.SentientError
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.launch

/**
 * Send/receive wrapper over one open [WebSocketSession].
 *
 * @param session The open session from [WebSocketEngine.open].
 * @param scope Scope the demux pump runs in; tie it to the connect lifecycle so
 *   disconnect cancels the pump (coroutines-flow-surface: no GlobalScope).
 * @param onProtocolError Called with a [SentientError.Protocol] when a text
 *   frame fails JSON decoding. The pump skips the frame and continues — never
 *   throws. Null means no-op (default, for callers that don't need the hook).
 */
class WsTransport(
    private val session: WebSocketSession,
    scope: CoroutineScope,
    private val onProtocolError: ((SentientError) -> Unit)? = null,
    /** Debug-only fault hooks; null unless devFaultsEnabled. Consulted in routeText. */
    private val faultHooks: FaultHooks? = null,
) {
    private val log = createLogger("transport", "ws")

    private val eventChannel = Channel<WsEvent>(Channel.UNLIMITED)
    private val signalChannel = Channel<TransportSignal>(Channel.UNLIMITED)

    /**
     * One ordered stream of control + audio events in EXACT arrival order.
     * Completes when the socket closes or fails.
     */
    val events: Flow<WsEvent> = eventChannel.receiveAsFlow()

    /** Lifecycle signals (Closed / Failure) for the reconnect layer. */
    val signals: Flow<TransportSignal> = signalChannel.receiveAsFlow()

    init {
        scope.launch { pump() }
    }

    /** Encode [msg] via WireJson and send as a text frame. Logs type only. */
    suspend fun send(msg: ClientMessage) {
        val frame = WireJson.instance.encodeToString(ClientMessage.serializer(), msg)
        log.debug("send", mapOf("type" to msg::class.simpleName))
        session.sendText(frame)
    }

    /** Send raw audio/PCM [bytes] as a binary frame. */
    suspend fun sendBinary(bytes: ByteArray) {
        log.debug("send-binary", mapOf("bytes" to bytes.size))
        session.sendBinary(bytes)
    }

    private suspend fun pump() {
        try {
            session.incoming.collect { frame -> route(frame) }
        } finally {
            // Always close the outbound channels — normal upstream completion,
            // an explicit Closed/Failure frame, OR scope cancellation (the normal
            // disconnect() path, where CancellationException propagates out of
            // collect). Without finally a cancelled pump leaves the event/signal
            // channels open and any consumer collecting them in a different scope
            // hangs forever. closeChannels() is idempotent (Channel.close).
            closeChannels()
        }
    }

    private suspend fun route(frame: WsIncoming) {
        when (frame) {
            is WsIncoming.Text -> routeText(frame.data)
            is WsIncoming.Binary -> routeBinary(frame.data)
            is WsIncoming.Closed -> {
                log.info("recv-closed", mapOf("code" to frame.code, "reason" to frame.reason))
                signalChannel.send(TransportSignal.Closed(frame.code, frame.reason))
                closeChannels()
            }
            is WsIncoming.Failure -> {
                log.warn("recv-failure", mapOf("error" to frame.error))
                signalChannel.send(TransportSignal.Failure(frame.error))
                closeChannels()
            }
        }
    }

    /**
     * Peel the 9-byte gateway header off a binary frame and deliver ONLY the
     * payload as [WsEvent.Audio], tagged with the header seq for the resume
     * cursor. Without this peel the leading 9 bytes corrupt the Opus stream
     * (the mobile audio break from Task 3.5). A frame shorter than the header or
     * of an unknown type is logged and dropped — the audio pipeline stays clean.
     */
    private suspend fun routeBinary(data: ByteArray) {
        val parsed = parseBinaryFrame(data)
        if (parsed == null) {
            log.warn("recv-binary.too-short", mapOf("bytes" to data.size))
            return
        }
        if (parsed.type != BINARY_TYPE_AUDIO) {
            log.debug("recv-binary.unknown-type", mapOf("type" to parsed.type, "seq" to parsed.seq, "bytes" to data.size))
            return
        }
        log.debug("recv-binary", mapOf("seq" to parsed.seq, "payloadBytes" to parsed.payload.size, "frameBytes" to data.size))
        eventChannel.send(WsEvent.Audio(parsed.payload, parsed.seq))
    }

    private suspend fun routeText(raw: String) {
        // Log frame length only — never the content. Chat text must not enter the
        // diagnostic ring. The gateway logs hold raw bytes if a protocol break
        // needs them.
        log.debug("recv-text", mapOf("len" to raw.length))
        // DEBUG fault injection: if malformed-frame is armed, corrupt the payload so
        // decoding fails and the existing ProtocolError path fires. Arm via:
        //   adb shell am broadcast -a io.sentient.debug.FAULT --es kind malformed
        val effectiveRaw = if (faultHooks?.consumeMalformedFrame() == true) {
            log.warn("fault.malformed-frame", mapOf("reason" to "injected by FaultHooks"))
            "{__fault_injected_malformed__}"
        } else {
            raw
        }
        val result = WireJson.decodeServerMessageResult(effectiveRaw)
        result.fold(
            onSuccess = { msg ->
                // Peel the gateway's seq/epoch resume stamps off the raw JSON
                // (read generically, not added to every variant) so the SDK can
                // feed them to the ResumeCursor for replay dedup.
                val (seq, epoch) = WireJson.peelSeqEpoch(effectiveRaw)
                eventChannel.send(WsEvent.Control(msg, seq, epoch))
            },
            onFailure = { err ->
                log.warn("decode-failed", mapOf("reason" to (err.message ?: "parse error"), "frameLen" to effectiveRaw.length))
                onProtocolError?.invoke(SentientError.Protocol("decode failed", cause = err))
                // Skip the malformed frame; pump continues.
            },
        )
    }

    private fun closeChannels() {
        eventChannel.close()
        signalChannel.close()
    }
}
