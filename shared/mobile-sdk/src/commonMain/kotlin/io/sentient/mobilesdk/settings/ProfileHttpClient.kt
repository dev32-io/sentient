// ---------------------------------------------------------------------------
// ProfileHttpClient — REST client for the core profile surface: GET/PUT
// /profile/me, POST /profile/apply, GET /mcp-catalog.
//
// Conventions (identical to AuthClient / SessionsHttpClient): injected
// HttpClient, WS URL derived to the HTTP base, bearer token per call, typed
// results that never throw. Request bodies serialize through settingsBodyJson
// (omits nulls) so zod `.optional()` fields validate.
//
// NOTE: apply blocks THROUGH a Hermes restart (multi-second). The injected
// HttpClient MUST be configured with a request timeout generous enough to cover
// a worker restart — timeout policy is a platform-wiring concern (see P2), not
// set per-call here (mirrors the sibling clients).
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.settings

import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.HttpRequestBuilder
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.request.post
import io.ktor.client.request.put
import io.ktor.client.request.setBody
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.contentType
import io.sentient.mobilesdk.auth.AuthResult
import io.sentient.mobilesdk.auth.deriveBaseUrl
import io.sentient.mobilesdk.log.createLogger

private const val PATH_PROFILE_ME = "/profile/me"
private const val PATH_PROFILE_APPLY = "/profile/apply"
private const val PATH_MCP_CATALOG = "/mcp-catalog"

/**
 * REST client for the core `/api/v1/profile` routes + the MCP catalog.
 *
 * @param httpClient Ktor client with ContentNegotiation(Json{ignoreUnknownKeys})
 *   installed; platform engine + timeout policy injected by the SDK factory.
 * @param gatewayWsUrl Full WS URL; the REST base is derived via [deriveBaseUrl].
 * @param token Supplier of the current PASETO token — read on every request.
 */
open class ProfileHttpClient(
    private val httpClient: HttpClient,
    gatewayWsUrl: String,
    private val token: () -> String,
) {
    private val baseUrl = deriveBaseUrl(gatewayWsUrl)
    private val log = createLogger("settings", "profile-http")

    /** GET /profile/me → the caller's full ProfileV1. */
    open suspend fun getMe(): AuthResult<ProfileV1> = safeSettingsCall(log) {
        log.debug("getMe")
        val resp = httpClient.get("$baseUrl$PATH_PROFILE_ME") { bearer() }
        mapSettingsResponse(log, resp) { it.body<ProfileV1>() }
    }

    /**
     * PUT /profile/me → the saved ProfileV1. A 422 body {error:"userId-mismatch"}
     * surfaces as AuthError.Server(422, ...) — the repo branches on the status.
     *
     * Takes [ProfileV1PutBody], NOT [ProfileV1] — the PATCH-shaped `tools`
     * (leaves may be `null` to clear a stored permission) is the wire body a
     * PUT actually needs; see that type's doc comment. Build one from a loaded
     * profile via `ProfileV1.toPutBody()`.
     */
    open suspend fun updateMe(profile: ProfileV1PutBody): AuthResult<ProfileV1> = safeSettingsCall(log) {
        log.debug("updateMe", mapOf("userId" to profile.userId))
        val resp = httpClient.put("$baseUrl$PATH_PROFILE_ME") {
            bearer()
            contentType(ContentType.Application.Json)
            setBody(settingsBodyJson.encodeToString(ProfileV1PutBody.serializer(), profile))
        }
        mapSettingsResponse(log, resp) { it.body<ProfileV1>() }
    }

    /**
     * POST /profile/apply → [ApplyResult]. 429 apply-in-progress is surfaced as
     * [ApplyResult.InProgress], not an error. Blocks through the Hermes restart.
     */
    open suspend fun apply(): ApplyResult = safeApplyCall(log) {
        log.info("apply.request")
        val resp = httpClient.post("$baseUrl$PATH_PROFILE_APPLY") { bearer() }
        mapApplyResponse(log, resp, settingsBodyJson)
    }

    /** GET /mcp-catalog → operator MCP servers + Hermes built-in tools. */
    open suspend fun getMcpCatalog(): AuthResult<McpCatalogView> = safeSettingsCall(log) {
        log.debug("getMcpCatalog")
        val resp = httpClient.get("$baseUrl$PATH_MCP_CATALOG") { bearer() }
        mapSettingsResponse(log, resp) { it.body<McpCatalogView>() }
    }

    private fun HttpRequestBuilder.bearer() {
        header(HttpHeaders.Authorization, "Bearer ${token()}")
    }
}
