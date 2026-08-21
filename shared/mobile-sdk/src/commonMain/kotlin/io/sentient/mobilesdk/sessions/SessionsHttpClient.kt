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

// ── Response envelope field names ──
// GET /api/v1/sessions answers {sessions: SessionMetadata[]} (gateway
// api/handlers/sessions.ts) — a DIFFERENT top-level key from every other
// list-shaped response here, which still answers {items: [...]}. Not yet
// implemented server-side: search/rename/delete stay on the {items:[...]}
// shape they were speculatively written against; those calls 404 today and
// safeGet/safeBoolean degrade them to an empty list / false, same as before
// this route existed.
private const val FIELD_ITEMS = "items"
private const val FIELD_SESSIONS = "sessions"

// ── Response DTOs ──

@Serializable
private data class RenameRequest(val title: String)

/**
 * Wire shape of one row in GET /api/v1/sessions (gateway's SessionMetadata,
 * store/session-metadata.ts, JSON-serialized). Deliberately NOT [SessionRow]:
 * that is this SDK's client-facing row shape, carrying fields (rootId,
 * messageCount, isActive) the gateway's session metadata table does not
 * track — mapped in [toSessionRow] rather than shared across the
 * server/client boundary.
 */
@Serializable
private data class SessionMetadataDto(
    val sessionId: String,
    val createdAt: Long = 0L,
    val updatedAt: Long = 0L,
    val title: String? = null,
    val titleProvenance: String? = null,
    val version: Int = 0,
)

// Matches web-sdk's sessions-rest.ts UNTITLED_SESSION_TITLE and webui's
// use-sessions.ts DEFAULT_NEW_CHAT_TITLE — a session with no title yet
// (nothing has generated or set one) still needs row text to render.
private const val UNTITLED_SESSION_TITLE = "New chat"

/** [SessionSummary.toSessionRow] downstream (HistoryViewModel) reads only
 *  sessionId/title/lastActiveAt off the result, same as web's mapping —
 *  rootId/messageCount/isActive are honest placeholders, not a lossy mapping
 *  of a value that exists elsewhere. */
private fun SessionMetadataDto.toSessionRow(): SessionRow = SessionRow(
    sessionId = sessionId,
    rootId = sessionId,
    title = title ?: UNTITLED_SESSION_TITLE,
    startedAt = createdAt,
    lastActiveAt = updatedAt,
    messageCount = 0,
    isActive = false,
)

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
     * The gateway does not paginate yet — it returns the caller's whole list,
     * newest-updated first; limit/offset still ride the URL for forward
     * compatibility (an unknown query param is a no-op server-side).
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
            val dtos = parseArrayField<SessionMetadataDto>(
                text,
                rowJson,
                SessionMetadataDto.serializer(),
                FIELD_SESSIONS,
            )
            val items = dtos.map { it.toSessionRow() }
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
            val items = parseArrayField<ConversationFeedItem>(
                text,
                WireJson.instance,
                ConversationFeedItem.serializer(),
                FIELD_ITEMS,
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
            val items = parseArrayField<SessionRow>(text, rowJson, SessionRow.serializer(), FIELD_ITEMS)
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
     * Parse a response body shaped `{[field]: [...]}`: extracts the [field]
     * array and deserializes each element using [json] and [elementSerializer].
     * Returns empty on any parse error so a malformed response never crashes
     * the app. [field] is explicit rather than defaulted to `"items"` because
     * GET /api/v1/sessions is the one caller that answers a different key
     * (`"sessions"`, gateway api/handlers/sessions.ts) — see FIELD_SESSIONS.
     */
    private fun <T> parseArrayField(
        body: String,
        json: Json,
        elementSerializer: kotlinx.serialization.KSerializer<T>,
        field: String,
    ): List<T> = runCatching {
        val root: JsonObject = json.parseToJsonElement(body).jsonObject
        val array = root[field]?.jsonArray ?: return emptyList()
        json.decodeFromJsonElement(ListSerializer(elementSerializer), array)
    }.getOrElse {
        log.warn("parse.error", mapOf("code" to "decode-failure"))
        emptyList()
    }

    private suspend fun <T> safeGet(block: suspend () -> T): T where T : List<*> {
        @Suppress("UNCHECKED_CAST")
        return runCatching { block() }.getOrElse {
            log.warn("network.error", mapOf("code" to "transport-failure"))
            emptyList<Nothing>() as T
        }
    }

    private suspend fun safeBoolean(block: suspend () -> Boolean): Boolean =
        runCatching { block() }.getOrElse {
            log.warn("network.error", mapOf("code" to "transport-failure"))
            false
        }

    companion object {
        private const val DEFAULT_MESSAGES_LIMIT = 200
        private const val DEFAULT_SEARCH_LIMIT = 20
        private const val PREVIEW_LEN = 60
    }
}
