// ---------------------------------------------------------------------------
// WebSocketEngine.android.kt — OkHttp-backed WebSocket engine (Android).
//
// SECURITY: The `allowSelfSignedDevHost` bypass ONLY runs when the flag is
// true. No bypass code path executes in the false (release) branch. The flag
// is supplied by the app from a debug BuildConfig; it is never hardcoded true
// inside the SDK.
//
// The trust-all X509TrustManager and permissive HostnameVerifier are
// constructed inside the `if (allowSelfSignedDevHost)` block and are NEVER
// referenced when the flag is false — the release path uses the OkHttp
// default, which defers to the platform system trust store.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.transport

import io.ktor.client.HttpClient
import io.ktor.client.engine.okhttp.OkHttp
import io.ktor.client.plugins.websocket.WebSockets
import io.ktor.client.plugins.websocket.webSocketSession
import io.ktor.websocket.CloseReason
import io.ktor.websocket.DefaultWebSocketSession
import io.ktor.websocket.Frame
import io.ktor.websocket.close
import io.ktor.websocket.readBytes
import io.ktor.websocket.readReason
import io.ktor.websocket.readText
import io.sentient.mobilesdk.log.createLogger
import kotlinx.coroutines.channels.ClosedReceiveChannelException
import kotlinx.coroutines.flow.Flow
import java.net.URI
import java.util.Locale
import kotlinx.coroutines.flow.channelFlow
import okhttp3.OkHttpClient
import java.security.SecureRandom
import java.security.cert.X509Certificate
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager

private val log = createLogger("transport", "ws", "android")

private fun normalizedEndpointIdentity(raw: String): String = try {
    val uri = URI(raw)
    val scheme = uri.scheme?.lowercase(Locale.ROOT)
    val host = uri.host?.lowercase(Locale.ROOT)
    if (scheme !in setOf("ws", "wss") || host.isNullOrBlank()) return "invalid"
    val port = if (uri.port > 0) uri.port else if (scheme == "wss") 443 else 80
    val path = uri.rawPath.orEmpty().trimEnd('/').removeSuffix("/ws").ifEmpty { "/" }
    "$scheme|$host|$port|$path"
} catch (_: Throwable) {
    "invalid"
}

/**
 * Android production [WebSocketEngine] backed by Ktor's OkHttp engine.
 *
 * One [HttpClient] is constructed per [open] call so the TLS configuration
 * can be scoped precisely to the requested bypass flag. Clients are closed
 * when the session closes or fails.
 */
class AndroidWebSocketEngine : WebSocketEngine {

    override suspend fun open(url: String, allowSelfSignedDevHost: Boolean): WebSocketSession {
        val endpoint = normalizedEndpointIdentity(url)
        log.info("open", mapOf("endpoint" to endpoint, "allowSelfSignedDevHost" to allowSelfSignedDevHost))

        val okHttpClient = buildOkHttpClient(allowSelfSignedDevHost)
        val ktorClient = HttpClient(OkHttp) {
            engine { preconfigured = okHttpClient }
            install(WebSockets)
        }

        val session: DefaultWebSocketSession = try {
            ktorClient.webSocketSession(url)
        } catch (e: Exception) {
            log.error("connect-failed", mapOf("endpoint" to endpoint, "code" to TransportFailureCode.OPEN_FAILED.name))
            ktorClient.close()
            throw e
        }

        log.info("connected", mapOf("endpoint" to endpoint))
        return KtorWebSocketSession(session, ktorClient, endpoint)
    }

    // -----------------------------------------------------------------------
    // TLS configuration
    // -----------------------------------------------------------------------

    /**
     * Builds an [OkHttpClient].
     *
     * SECURITY GUARD: The trust-all branch is entered **only** when
     * [allowSelfSignedDevHost] is `true`. The release code path (false) calls
     * the zero-argument `OkHttpClient.Builder().build()`, which uses the
     * Android platform system trust store without modification.
     */
    private fun buildOkHttpClient(allowSelfSignedDevHost: Boolean): OkHttpClient {
        val builder = OkHttpClient.Builder()
        if (allowSelfSignedDevHost) {
            log.warn(
                "DEV-ONLY: TLS certificate validation disabled — self-signed cert trusted",
                mapOf("guard" to "allowSelfSignedDevHost=true"),
            )
            val trustAll = buildTrustAllManager()
            val sslContext = SSLContext.getInstance("TLS").also { ctx ->
                ctx.init(null, arrayOf<TrustManager>(trustAll), SecureRandom())
            }
            builder
                .sslSocketFactory(sslContext.socketFactory, trustAll)
                .hostnameVerifier { _, _ -> true }
        }
        return builder.build()
    }

    /** Constructs a trust-all [X509TrustManager]. Used only in the dev-only bypass branch. */
    private fun buildTrustAllManager(): X509TrustManager = object : X509TrustManager {
        override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) = Unit
        override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) = Unit
        override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
    }
}

// ---------------------------------------------------------------------------
// KtorWebSocketSession — adapts DefaultWebSocketSession → WebSocketSession.
// ---------------------------------------------------------------------------

private class KtorWebSocketSession(
    private val session: DefaultWebSocketSession,
    private val client: HttpClient,
    private val endpoint: String,
) : WebSocketSession {

    override val incoming: Flow<WsIncoming> = channelFlow {
        try {
            for (frame in session.incoming) {
                if (frame is Frame.Close) {
                    // Close frame received — log only; break and let closeReason.await()
                    // emit the single terminal WsIncoming.Closed.
                    val reason = frame.readReason()
                    val code = reason?.code?.toInt() ?: WS_NORMAL_CLOSURE
                    log.info(
                        "close-frame",
                        mapOf("code" to code, "reasonCode" to structuralCloseReason(code)),
                    )
                    break
                }
                val mapped = mapFrame(frame)
                if (mapped != null) {
                    log.debug("frame-received", mapOf("type" to mapped::class.simpleName))
                    send(mapped)
                }
            }
            // Single terminal emission for all clean-close paths (server Close frame OR
            // loop exhaustion with no explicit frame).  closeReason is set by Ktor when a
            // Close frame was exchanged; null means the channel ended without one.
            val closeReason = session.closeReason.await()
            if (closeReason != null) {
                val code = closeReason.code.toInt()
                log.info("closed-clean", mapOf("code" to code, "reasonCode" to structuralCloseReason(code)))
                send(WsIncoming.Closed(code, structuralCloseReason(code)))
            } else {
                log.info("closed-no-reason", mapOf("endpoint" to endpoint))
                send(WsIncoming.Closed(WS_NORMAL_CLOSURE, structuralCloseReason(WS_NORMAL_CLOSURE)))
            }
        } catch (e: ClosedReceiveChannelException) {
            // Normal close of the incoming channel — treat as clean closure.
            val closeReason = session.closeReason.await()
            val code = closeReason?.code?.toInt() ?: WS_NORMAL_CLOSURE
            log.info("closed-channel", mapOf("code" to code, "reasonCode" to structuralCloseReason(code)))
            send(WsIncoming.Closed(code, structuralCloseReason(code)))
        } catch (e: Exception) {
            log.error("session-failure", mapOf("endpoint" to endpoint, "code" to TransportFailureCode.RECEIVE_FAILED.name))
            send(WsIncoming.Failure(TransportFailureCode.RECEIVE_FAILED))
        } finally {
            client.close()
        }
    }

    override suspend fun sendText(text: String) {
        log.debug("send-text", mapOf("length" to text.length))
        session.send(Frame.Text(text))
    }

    override suspend fun sendBinary(bytes: ByteArray) {
        log.debug("send-binary", mapOf("bytes" to bytes.size))
        session.send(Frame.Binary(fin = true, data = bytes))
    }

    override suspend fun close(code: Int, reason: String) {
        val reasonCode = structuralCloseReason(code)
        log.info("close", mapOf("code" to code, "reasonCode" to reasonCode))
        session.close(CloseReason(code.toShort(), reasonCode))
    }

    // -----------------------------------------------------------------------
    // Frame mapping — Ktor Frame → WsIncoming.
    // -----------------------------------------------------------------------

    private fun mapFrame(frame: Frame): WsIncoming? = when (frame) {
        is Frame.Text -> WsIncoming.Text(frame.readText())
        is Frame.Binary -> WsIncoming.Binary(frame.readBytes())
        else -> {
            // Frame.Close is handled before mapFrame in the loop; Ping/Pong handled by Ktor.
            log.debug("frame-skip", mapOf("frameType" to frame.frameType.name))
            null
        }
    }
}
