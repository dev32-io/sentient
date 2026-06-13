// ---------------------------------------------------------------------------
// SessionsHttpClient — Ktor REST client for session query/mutation operations.
//
// Mirrors the gateway REST API at /api/v1/sessions/*.  All WS query RPCs
// (sessions.list/search/delete/rename) were removed in protocol Task 2.1;
// this client replaces them with REST calls authenticated via PASETO Bearer.
//
// Engine injection: the HttpClient is injected by the platform caller
// (SentientSdk / factories) so the engine + TLS policy are platform-specific
// (OkHttp on Android, Darwin on iOS), matching the existing AuthClient pattern.
//
// JSON decoding for ConversationFeedItem uses WireJson.instance because that
// hierarchy has @JsonClassDiscriminator("kind") — different from the default
// "type" discriminator.  SessionRow uses the injected ContentNegotiation Json.
//
// list/search/getMessages return empty on 4xx/5xx; delete/rename return Boolean
// (true = 2xx success, false = failure) — never throw from business logic.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.sessions

import io.ktor.client.HttpClient
import io.ktor.client.request.delete
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.request.patch
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.contentType
import io.ktor.http.encodeURLQueryComponent
import io.ktor.http.isSuccess
import io.sentient.mobilesdk.auth.deriveBaseUrl
import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.protocol.ConversationFeedItem
import io.sentient.mobilesdk.protocol.SessionRow
import io.sentient.mobilesdk.protocol.WireJson
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject

// ── Path constants (relative to /api/v1 base) ──
private const val PATH_SESSIONS = "/sessions"
private const val PATH_MESSAGES_SUFFIX = "/messages"

// ── Response DTOs ──

@Serializable
private data class RenameRequest(val title: String)

// Lenient Json for session rows (no polymorphism needed).
private val rowJson = Json { ignoreUnknownKeys = true }

/**
 * REST client for gateway session operations.
 *
 * @param httpClient Ktor HttpClient with ContentNegotiation(Json) installed.
 *   Engine and TLS policy are platform-specific; injected by the SDK factory.
 *   The caller owns the client lifecycle.
 * @param gatewayWsUrl Full WS URL (e.g. `wss://host/api/v1/ws`); the base
 *   REST URL is derived via [deriveBaseUrl].
 * @param token Supplier returning the current PASETO session token.
 *   Called on every request so token rotation is transparent.
 */
open class SessionsHttpClient(
    private val httpClient: HttpClient,
    gatewayWsUrl: String,
    private val token: () -> String,
) {
    private val baseUrl = deriveBaseUrl(gatewayWsUrl)
    private val log = createLogger("sessions", "http-client")

    // ── list ──────────────────────────────────────────────────────────────────

    /**
     * GET /api/v1/sessions?limit=&offset=
     *
     * Returns an empty list on any non-2xx response.
     */
    open suspend fun list(limit: Int, offset: Int): List<SessionRow> {
        log.debug("list", mapOf("limit" to limit, "offset" to offset))
        return safeGet {
            val resp = httpClient.get("$baseUrl$PATH_SESSIONS?limit=$limit&offset=$offset") {
                header(HttpHeaders.Authorization, "Bearer ${token()}")
            }
            if (!resp.status.isSuccess()) {
                log.warn("list.error", mapOf("status" to resp.status.value))
                return@safeGet emptyList()
            }
            val text = resp.bodyAsText()
            val items = parseItemsArray<SessionRow>(text, rowJson, SessionRow.serializer())
            log.debug("list.ok", mapOf("count" to items.size))
            items
        }
    }

    // ── getMessages ───────────────────────────────────────────────────────────

    /**
     * GET /api/v1/sessions/:id/messages?limit=&offset=
     *
     * Returns ConversationFeedItem[] already mapped server-side — same shape
     * the old WS snapshot had. Returns an empty list on non-2xx.
     */
    open suspend fun getMessages(
        sessionId: String,
        limit: Int = DEFAULT_MESSAGES_LIMIT,
        offset: Int = 0,
    ): List<ConversationFeedItem> {
        log.debug("getMessages", mapOf("sessionId" to sessionId, "limit" to limit))
        return safeGet {
            val resp = httpClient.get(
                "$baseUrl$PATH_SESSIONS/$sessionId$PATH_MESSAGES_SUFFIX?limit=$limit&offset=$offset",
            ) {
                header(HttpHeaders.Authorization, "Bearer ${token()}")
            }
            if (!resp.status.isSuccess()) {
                log.warn("getMessages.error", mapOf("sessionId" to sessionId, "status" to resp.status.value))
                return@safeGet emptyList()
            }
            val text = resp.bodyAsText()
            // ConversationFeedItem uses @JsonClassDiscriminator("kind") — use WireJson.
            val items = parseItemsArray<ConversationFeedItem>(
                text,
                WireJson.instance,
                ConversationFeedItem.serializer(),
            )
            log.debug("getMessages.ok", mapOf("sessionId" to sessionId, "count" to items.size))
            items
        }
    }

    // ── search ────────────────────────────────────────────────────────────────

    /**
     * GET /api/v1/sessions/search?q=&limit=
     *
     * Returns an empty list on non-2xx.
     */
    open suspend fun search(q: String, limit: Int = DEFAULT_SEARCH_LIMIT): List<SessionRow> {
        val encodedQ = q.encodeURLQueryComponent()
        log.debug("search", mapOf("qLen" to q.length, "limit" to limit))
        return safeGet {
            val resp = httpClient.get(
                "$baseUrl$PATH_SESSIONS/search?q=$encodedQ&limit=$limit",
            ) {
                header(HttpHeaders.Authorization, "Bearer ${token()}")
            }
            if (!resp.status.isSuccess()) {
                log.warn("search.error", mapOf("status" to resp.status.value))
                return@safeGet emptyList()
            }
            val text = resp.bodyAsText()
            val items = parseItemsArray<SessionRow>(text, rowJson, SessionRow.serializer())
            log.debug("search.ok", mapOf("count" to items.size))
            items
        }
    }

    // ── rename ────────────────────────────────────────────────────────────────

    /**
     * PATCH /api/v1/sessions/:id  body: {title}
     *
     * Returns true on 2xx success, false on any non-2xx or network error.
     */
    open suspend fun rename(sessionId: String, title: String): Boolean {
        log.debug("rename", mapOf("sessionId" to sessionId))
        return safeBoolean {
            val resp = httpClient.patch("$baseUrl$PATH_SESSIONS/$sessionId") {
                header(HttpHeaders.Authorization, "Bearer ${token()}")
                contentType(ContentType.Application.Json)
                setBody(rowJson.encodeToString(RenameRequest.serializer(), RenameRequest(title = title)))
            }
            if (!resp.status.isSuccess()) {
                log.warn("rename.error", mapOf("sessionId" to sessionId, "status" to resp.status.value))
                false
            } else {
                log.debug("rename.ok", mapOf("sessionId" to sessionId))
                true
            }
        }
    }

    // ── delete ────────────────────────────────────────────────────────────────

    /**
     * DELETE /api/v1/sessions/:id
     *
     * Returns true on 2xx success, false on any non-2xx or network error.
     */
    open suspend fun delete(sessionId: String): Boolean {
        log.debug("delete", mapOf("sessionId" to sessionId))
        return safeBoolean {
            val resp = httpClient.delete("$baseUrl$PATH_SESSIONS/$sessionId") {
                header(HttpHeaders.Authorization, "Bearer ${token()}")
            }
            if (!resp.status.isSuccess()) {
                log.warn("delete.error", mapOf("sessionId" to sessionId, "status" to resp.status.value))
                false
            } else {
                log.debug("delete.ok", mapOf("sessionId" to sessionId))
                true
            }
        }
    }

    // ── Internal helpers ──────────────────────────────────────────────────────

    /**
     * Parse a paginated response body: extracts `items` array and deserializes
     * each element using [json] and [elementSerializer]. Returns empty on any
     * parse error so a malformed response never crashes the app.
     */
    private fun <T> parseItemsArray(
        body: String,
        json: Json,
        elementSerializer: kotlinx.serialization.KSerializer<T>,
    ): List<T> = runCatching {
        val root: JsonObject = json.parseToJsonElement(body).jsonObject
        val array = root["items"]?.jsonArray ?: return emptyList()
        json.decodeFromJsonElement(ListSerializer(elementSerializer), array)
    }.getOrElse { e ->
        log.warn("parse.error", mapOf("cause" to (e.message?.take(PREVIEW_LEN) ?: "unknown")))
        emptyList()
    }

    private suspend fun <T> safeGet(block: suspend () -> T): T where T : List<*> {
        @Suppress("UNCHECKED_CAST")
        return runCatching { block() }.getOrElse { e ->
            log.warn("network.error", mapOf("cause" to (e.message ?: "unknown")))
            emptyList<Nothing>() as T
        }
    }

    private suspend fun safeBoolean(block: suspend () -> Boolean): Boolean =
        runCatching { block() }.getOrElse { e ->
            log.warn("network.error", mapOf("cause" to (e.message ?: "unknown")))
            false
        }

    companion object {
        private const val DEFAULT_MESSAGES_LIMIT = 200
        private const val DEFAULT_SEARCH_LIMIT = 20
        private const val PREVIEW_LEN = 60
    }
}
