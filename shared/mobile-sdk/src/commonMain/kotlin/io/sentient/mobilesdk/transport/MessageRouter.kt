// ---------------------------------------------------------------------------
// MessageRouter — dispatches decoded gateway frames to registered connectors.
//
// Mirrors the dispatch model of web-sdk's sdk-message-router.ts: there, a
// decoded frame is fanned out to the set of handlers subscribed for its type,
// and binary frames go to the binary-handler set only (never the JSON path).
// The mobile-sdk collapses per-type subscription into one `handle(msg)` per
// connector — so the router BROADCASTS every [ServerMessage] to EVERY connector
// and each filters internally (the broadcast-and-filter model). Binary audio
// frames route to the single audio connector ONLY, never broadcast — matching
// web-sdk where only the audio connector subscribes to `onBinary`.
//
// Pure synchronous dispatch: the orchestrator owns the WsTransport Flow.collect
// that feeds [route] / [routeBinary]. No coroutines, no platform types here.
//
// Per logging.md: WsTransport already logs the raw incoming frame at decode, so
// this layer logs the DISPATCH DECISION only (frame type + connector count, or
// the binary byte count + whether an audio connector was wired) — never the
// payload. Unknown / unhandled frames are a no-op decision, DEBUG only.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.transport

import io.sentient.mobilesdk.connectors.Connector
import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.protocol.ServerMessage

/**
 * Routes decoded frames to connectors.
 *
 * @param connectors All registered connectors. Every [route] broadcasts to all
 *   of them; each connector filters internally via its own [Connector.handle].
 * @param audioConnector The connector that receives raw binary audio frames via
 *   [routeBinary]. Null when no audio connector is wired (binary is then a
 *   no-op). Must also appear in [connectors] if it consumes control frames; the
 *   router does not register it implicitly.
 */
class MessageRouter(
    private val connectors: List<Connector>,
    private val audioConnector: Connector? = null,
) {
    private val log = createLogger("transport", "router")

    /**
     * Broadcast a decoded control frame to every connector. Each connector
     * filters internally. [ServerMessage.Unknown] is dispatched like any other
     * frame (connectors ignore it) and never throws.
     */
    fun route(msg: ServerMessage) {
        val type = msg::class.simpleName
        if (msg is ServerMessage.Unknown) {
            log.debug("dispatch-unknown", mapOf("connectors" to connectors.size))
        } else {
            log.debug("dispatch", mapOf("type" to type, "connectors" to connectors.size))
        }
        for (connector in connectors) connector.handle(msg)
    }

    /**
     * Route a raw binary audio frame to the audio connector ONLY. No-op (DEBUG
     * log) when no audio connector is wired. Never broadcasts to other connectors.
     */
    fun routeBinary(bytes: ByteArray) {
        val target = audioConnector
        if (target == null) {
            log.debug("dispatch-binary-noaudio", mapOf("bytes" to bytes.size))
            return
        }
        log.debug("dispatch-binary", mapOf("bytes" to bytes.size, "capability" to target.capability))
        target.handleBinary(bytes)
    }
}
