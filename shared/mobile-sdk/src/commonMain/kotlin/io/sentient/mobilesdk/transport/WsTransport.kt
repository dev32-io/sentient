// ---------------------------------------------------------------------------
// WsTransport — the WS send/receive boundary over a WebSocketSession.
//
// Wraps one open [WebSocketSession] (B1) and demultiplexes its single
// [WsIncoming] stream into three typed outbound flows, mirroring how
// sentient-sdk.ts splits binary (audio) from JSON (control) on `onmessage`:
//   - [incoming]    — TEXT frames decoded to [ServerMessage] via WireJson.
//   - [audioFrames] — BINARY frames passed through as raw ByteArray (audio path).
//   - [signals]     — Closed / Failure surfaced as [TransportSignal] for the
//                     reconnect layer (web-sdk's onclose / onerror split).
//
// A single pump coroutine drains session.incoming once (the underlying channel
// is single-consumer) and fans out to three completing channels, so each public
// flow terminates when the socket closes — `toList` does not hang.
//
// Per logging.md: raw incoming TEXT is logged at DEBUG (truncated by the logger)
// at the decode boundary BEFORE decoding, so frames that fall through to
// ServerMessage.Unknown stay traceable. Sends log type only, never the payload.
// Per error-handling.md: failures are signals on [signals], never thrown.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.transport

import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.protocol.ClientMessage
import io.sentient.mobilesdk.protocol.ServerMessage
import io.sentient.mobilesdk.protocol.WireJson
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
 */
class WsTransport(
    private val session: WebSocketSession,
    scope: CoroutineScope,
) {
    private val log = createLogger("transport", "ws")

    private val messageChannel = Channel<ServerMessage>(Channel.UNLIMITED)
    private val audioChannel = Channel<ByteArray>(Channel.UNLIMITED)
    private val signalChannel = Channel<TransportSignal>(Channel.UNLIMITED)

    /** Decoded control frames. Completes when the socket closes or fails. */
    val incoming: Flow<ServerMessage> = messageChannel.receiveAsFlow()

    /** Raw binary audio frames. Completes when the socket closes or fails. */
    val audioFrames: Flow<ByteArray> = audioChannel.receiveAsFlow()

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
            // collect). Without finally a cancelled pump leaves the fan-out
            // channels open and any consumer collecting them in a different scope
            // hangs forever. closeChannels() is idempotent (Channel.close).
            closeChannels()
        }
    }

    private suspend fun route(frame: WsIncoming) {
        when (frame) {
            is WsIncoming.Text -> routeText(frame.data)
            is WsIncoming.Binary -> {
                log.debug("recv-binary", mapOf("bytes" to frame.data.size))
                audioChannel.send(frame.data)
            }
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

    private suspend fun routeText(raw: String) {
        // Log the raw frame BEFORE decoding so Unknown-decoding frames stay
        // traceable (logger truncates the preview).
        log.debug("recv-text", mapOf("raw" to raw))
        val msg = WireJson.instance.decodeFromString(ServerMessage.serializer(), raw)
        messageChannel.send(msg)
    }

    private fun closeChannels() {
        messageChannel.close()
        audioChannel.close()
        signalChannel.close()
    }
}
