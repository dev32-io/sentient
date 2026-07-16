// ---------------------------------------------------------------------------
// ProfileEditHttpClient — REST client for the SOUL / memory / personality
// surface (gateway/src/api/handlers/profile-edit.ts). Mirrors that module's own
// grouping: soul, memory, and personalities share the restart-on-write flow.
//
// Every write here (putSoul, putMemory, personality CRUD) triggers a Hermes
// restart and returns an [ApplyResult]; setActivePersonality is an imperative
// 204 no-op today (ACP has no /personality equivalent — the file lands on disk).
// The injected HttpClient needs a generous request timeout (writes block through
// the restart) — a platform-wiring concern, not set per-call here.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.settings

import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.HttpRequestBuilder
import io.ktor.client.request.delete
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.request.post
import io.ktor.client.request.put
import io.ktor.client.request.setBody
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.contentType
import io.ktor.http.encodeURLPathPart
import io.sentient.mobilesdk.auth.AuthResult
import io.sentient.mobilesdk.auth.deriveBaseUrl
import io.sentient.mobilesdk.log.createLogger
import kotlinx.serialization.Serializable

private const val PATH_SOUL = "/profile/soul"
private const val PATH_SOUL_DEFAULT = "/profile/soul/default"
private const val PATH_MEMORY = "/profile/memory/"
private const val PATH_PERSONALITIES = "/profile/personalities"
private const val PATH_ACTIVE_PERSONALITY = "/profile/active-personality"

@Serializable
private data class ContentBody(val content: String)

@Serializable
private data class PersonalityAddRequest(val name: String, val body: String)

@Serializable
private data class PersonalityBodyRequest(val body: String)

@Serializable
private data class ActivePersonalityRequest(val name: String)

/** REST client for `/api/v1/profile/{soul,memory,personalities,active-personality}`. */
open class ProfileEditHttpClient(
    private val httpClient: HttpClient,
    gatewayWsUrl: String,
    private val token: () -> String,
) {
    private val baseUrl = deriveBaseUrl(gatewayWsUrl)
    private val log = createLogger("settings", "profile-edit-http")

    // ── SOUL ──

    open suspend fun getSoul(): AuthResult<SoulDoc> = safeSettingsCall(log) {
        log.debug("getSoul")
        val resp = httpClient.get("$baseUrl$PATH_SOUL") { bearer() }
        mapSettingsResponse(log, resp) { it.body<SoulDoc>() }
    }

    open suspend fun getSoulDefault(): AuthResult<SoulDefaultDoc> = safeSettingsCall(log) {
        log.debug("getSoulDefault")
        val resp = httpClient.get("$baseUrl$PATH_SOUL_DEFAULT") { bearer() }
        mapSettingsResponse(log, resp) { it.body<SoulDefaultDoc>() }
    }

    open suspend fun putSoul(content: String): ApplyResult = safeApplyCall(log) {
        log.info("putSoul", mapOf("chars" to content.length))
        val resp = httpClient.put("$baseUrl$PATH_SOUL") { bearer(); jsonBody(ContentBody.serializer(), ContentBody(content)) }
        mapApplyResponse(log, resp, settingsBodyJson)
    }

    // ── Memory (MEMORY.md / USER.md) ──

    open suspend fun getMemory(slot: MemorySlot): AuthResult<MemoryDoc> = safeSettingsCall(log) {
        log.debug("getMemory", mapOf("slot" to slot.slug))
        val resp = httpClient.get("$baseUrl$PATH_MEMORY${slot.slug}") { bearer() }
        mapSettingsResponse(log, resp) { it.body<MemoryDoc>() }
    }

    open suspend fun putMemory(slot: MemorySlot, content: String): ApplyResult = safeApplyCall(log) {
        log.info("putMemory", mapOf("slot" to slot.slug, "chars" to content.length))
        val resp = httpClient.put("$baseUrl$PATH_MEMORY${slot.slug}") {
            bearer(); jsonBody(ContentBody.serializer(), ContentBody(content))
        }
        mapApplyResponse(log, resp, settingsBodyJson)
    }

    // ── Personalities ──

    open suspend fun listPersonalities(): AuthResult<PersonalityList> = safeSettingsCall(log) {
        log.debug("listPersonalities")
        val resp = httpClient.get("$baseUrl$PATH_PERSONALITIES") { bearer() }
        mapSettingsResponse(log, resp) { it.body<PersonalityList>() }
    }

    open suspend fun createPersonality(name: String, body: String): ApplyResult = safeApplyCall(log) {
        log.info("createPersonality", mapOf("nameLen" to name.length))
        val resp = httpClient.post("$baseUrl$PATH_PERSONALITIES") {
            bearer(); jsonBody(PersonalityAddRequest.serializer(), PersonalityAddRequest(name, body))
        }
        mapApplyResponse(log, resp, settingsBodyJson)
    }

    open suspend fun updatePersonality(name: String, body: String): ApplyResult = safeApplyCall(log) {
        log.info("updatePersonality", mapOf("nameLen" to name.length))
        val resp = httpClient.put("$baseUrl$PATH_PERSONALITIES/${name.encodeURLPathPart()}") {
            bearer(); jsonBody(PersonalityBodyRequest.serializer(), PersonalityBodyRequest(body))
        }
        mapApplyResponse(log, resp, settingsBodyJson)
    }

    open suspend fun deletePersonality(name: String): ApplyResult = safeApplyCall(log) {
        log.info("deletePersonality", mapOf("nameLen" to name.length))
        val resp = httpClient.delete("$baseUrl$PATH_PERSONALITIES/${name.encodeURLPathPart()}") { bearer() }
        mapApplyResponse(log, resp, settingsBodyJson)
    }

    /** POST /profile/active-personality → 204. Imperative (no restart). */
    open suspend fun setActivePersonality(name: String): AuthResult<Unit> = safeSettingsCall(log) {
        log.info("setActivePersonality", mapOf("nameLen" to name.length))
        val resp = httpClient.post("$baseUrl$PATH_ACTIVE_PERSONALITY") {
            bearer(); jsonBody(ActivePersonalityRequest.serializer(), ActivePersonalityRequest(name))
        }
        mapSettingsResponse(log, resp) { }
    }

    private fun HttpRequestBuilder.bearer() {
        header(HttpHeaders.Authorization, "Bearer ${token()}")
    }

    private fun <T> HttpRequestBuilder.jsonBody(serializer: kotlinx.serialization.KSerializer<T>, value: T) {
        contentType(ContentType.Application.Json)
        setBody(settingsBodyJson.encodeToString(serializer, value))
    }
}
