// ---------------------------------------------------------------------------
// FishHttpClient — REST client for the gated Fish Audio voice-library browse +
// clone routes (gateway/src/api/handlers/fish/fish-browse.ts + fish-clone.ts).
//
// Every route 404s when the feature is disabled. The gateway's disabled-404
// carries a PLAIN body ("Not Found"); a real error 404 (voice-not-found) carries
// a JSON {error:...} body. mapFishResponse distinguishes them → the disabled
// case becomes the typed [FishResult.FeatureDisabled], never a generic error.
// Mobile also gates the UI up front on services/versions fish_browse_enabled.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.settings

import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.HttpRequestBuilder
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.contentType
import io.ktor.http.encodeURLPathPart
import io.ktor.http.encodeURLQueryComponent
import io.ktor.http.isSuccess
import io.sentient.mobilesdk.auth.AuthError
import io.sentient.mobilesdk.auth.deriveBaseUrl
import io.sentient.mobilesdk.log.Log
import io.sentient.mobilesdk.log.createLogger

private const val PATH_FISH_VOICES = "/providers/voices"
private const val CLONE_SUFFIX = "/clone"
private const val HTTP_NOT_FOUND = 404

/** REST client for the gated `/api/v1/providers/voices*` Fish routes. */
open class FishHttpClient(
    private val httpClient: HttpClient,
    gatewayWsUrl: String,
    private val token: () -> String,
) {
    private val baseUrl = deriveBaseUrl(gatewayWsUrl)
    private val log = createLogger("settings", "fish-http")

    /** GET /providers/voices?title=&page= → {voices, hasMore, stale}. */
    open suspend fun listVoices(title: String? = null, page: Int? = null): FishResult<FishVoicePage> =
        safeFishCall(log) {
            log.debug("listVoices", mapOf("hasTitle" to (title?.isNotEmpty() == true), "page" to (page ?: 1)))
            val resp = httpClient.get("$baseUrl$PATH_FISH_VOICES${listQuery(title, page)}") { bearer() }
            mapFishResponse(log, resp) { it.body<FishVoicePage>() }
        }

    /** GET /providers/voices/:id → {voice}. */
    open suspend fun getVoice(id: String): FishResult<FishVoiceEntry> = safeFishCall(log) {
        log.debug("getVoice", mapOf("idLen" to id.length))
        val resp = httpClient.get("$baseUrl$PATH_FISH_VOICES/${id.encodeURLPathPart()}") { bearer() }
        mapFishResponse(log, resp) { it.body<FishVoiceEnvelope>().voice }
    }

    /** POST /providers/voices/:fishVoiceId/clone → {voiceId, name, warning?}. */
    open suspend fun clone(fishVoiceId: String, request: CloneFromFishRequest): FishResult<CloneFromFishResult> =
        safeFishCall(log) {
            log.info("clone", mapOf("idLen" to fishVoiceId.length, "nameLen" to request.name.length))
            val resp = httpClient.post("$baseUrl$PATH_FISH_VOICES/${fishVoiceId.encodeURLPathPart()}$CLONE_SUFFIX") {
                bearer()
                contentType(ContentType.Application.Json)
                setBody(settingsBodyJson.encodeToString(CloneFromFishRequest.serializer(), request))
            }
            mapFishResponse(log, resp) { it.body<CloneFromFishResult>() }
        }

    private fun listQuery(title: String?, page: Int?): String {
        val params = buildList {
            if (!title.isNullOrEmpty()) add("title=${title.encodeURLQueryComponent()}")
            if (page != null && page > 1) add("page=$page")
        }
        return if (params.isEmpty()) "" else "?${params.joinToString("&")}"
    }

    private fun HttpRequestBuilder.bearer() {
        header(HttpHeaders.Authorization, "Bearer ${token()}")
    }
}

/** True when a 404 body is JSON (a real error like voice-not-found), not the plain disabled-404. */
private fun looksLikeJsonError(body: String): Boolean = body.trimStart().startsWith("{")

/** Maps a settled Fish response: 2xx → Success; plain 404 → FeatureDisabled; else Failure. */
internal suspend fun <T> mapFishResponse(
    log: Log,
    response: HttpResponse,
    parse: suspend (HttpResponse) -> T,
): FishResult<T> {
    if (response.status.isSuccess()) {
        return runCatching { FishResult.Success(parse(response)) }
            .getOrElse { e ->
                log.warn("fish.parse-error", mapOf("cause" to (e.message ?: "unknown")))
                FishResult.Failure(AuthError.Unknown(cause = e.message ?: "parse error"))
            }
    }
    val status = response.status.value
    val body = runCatching { response.bodyAsText() }.getOrDefault("")
    if (status == HTTP_NOT_FOUND && !looksLikeJsonError(body)) {
        log.info("fish.feature-disabled", mapOf("status" to status))
        return FishResult.FeatureDisabled
    }
    log.warn("fish.http-error", mapOf("status" to status))
    return FishResult.Failure(AuthError.Server(status = status, body = body))
}

/** Wraps a Fish call so a transport failure becomes FishResult.Failure(Network), never a throw. */
internal suspend fun <T> safeFishCall(log: Log, block: suspend () -> FishResult<T>): FishResult<T> =
    runCatching { block() }.getOrElse { e ->
        log.warn("fish.network-error", mapOf("cause" to (e.message ?: "unknown")))
        FishResult.Failure(AuthError.Network(cause = e.message ?: "network error"))
    }
