// ---------------------------------------------------------------------------
// VoicesHttpClient — REST client for the shared household voice library
// (gateway/src/api/handlers/voices.ts + voices-create-form.ts + voices-preview.ts).
//
// list → {voices}. create → multipart (name/description/tags*/language/audio).
// delete → {voiceId, warning?}. preview → raw WAV bytes.
//
// NEVER log audio bytes or metadata content — byte counts / lengths / ids only.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.settings

import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.HttpRequestBuilder
import io.ktor.client.request.delete
import io.ktor.client.request.forms.MultiPartFormDataContent
import io.ktor.client.request.forms.formData
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.readRawBytes
import io.ktor.http.Headers
import io.ktor.http.HttpHeaders
import io.ktor.http.encodeURLPathPart
import io.ktor.http.encodeURLQueryComponent
import io.sentient.mobilesdk.auth.AuthResult
import io.sentient.mobilesdk.auth.deriveBaseUrl
import io.sentient.mobilesdk.log.createLogger

private const val PATH_VOICES = "/voices"
private const val AUDIO_FILENAME = "reference.wav"
private const val AUDIO_CONTENT_TYPE = "audio/wav"

/** REST client for `/api/v1/voices*`. */
open class VoicesHttpClient(
    private val httpClient: HttpClient,
    gatewayWsUrl: String,
    private val token: () -> String,
) {
    private val baseUrl = deriveBaseUrl(gatewayWsUrl)
    private val log = createLogger("settings", "voices-http")

    /** GET /voices → the shared voice-pack list. */
    open suspend fun list(): AuthResult<List<VoiceSummary>> = safeSettingsCall(log) {
        log.debug("list")
        val resp = httpClient.get("$baseUrl$PATH_VOICES") { bearer() }
        mapSettingsResponse(log, resp) { it.body<VoiceListResponse>().voices }
    }

    /**
     * POST /voices (multipart) → {voiceId, name, warning?}. Creating a voice
     * ACTIVATES it server-side. Over-cap name/description/tags TRUNCATE
     * server-side (see [VoiceFieldCaps]); only a missing name/audio 422s.
     *
     * @param audioWav WAV-encoded reference clip bytes (mobile uploads WAV; the
     *   service decodes wav/mp3/ogg/flac via libsndfile).
     */
    open suspend fun create(
        name: String,
        audioWav: ByteArray,
        description: String,
        tags: List<String>,
        language: String,
    ): AuthResult<VoiceCreateResult> = safeSettingsCall(log) {
        log.info("create", mapOf("nameLen" to name.length, "audioBytes" to audioWav.size, "tagCount" to tags.size))
        val parts = formData {
            append("name", name)
            append("description", description)
            for (tag in tags) append("tags", tag)
            append("language", language)
            append(
                "audio",
                audioWav,
                Headers.build {
                    append(HttpHeaders.ContentType, AUDIO_CONTENT_TYPE)
                    append(HttpHeaders.ContentDisposition, "filename=\"$AUDIO_FILENAME\"")
                },
            )
        }
        val resp = httpClient.post("$baseUrl$PATH_VOICES") {
            bearer()
            setBody(MultiPartFormDataContent(parts))
        }
        mapSettingsResponse(log, resp) { it.body<VoiceCreateResult>() }
    }

    /** DELETE /voices/:id → {voiceId, warning?}. */
    open suspend fun delete(voiceId: String): AuthResult<VoiceDeleteResult> = safeSettingsCall(log) {
        log.info("delete", mapOf("voiceId" to voiceId))
        val resp = httpClient.delete("$baseUrl$PATH_VOICES/${voiceId.encodeURLPathPart()}") { bearer() }
        mapSettingsResponse(log, resp) { it.body<VoiceDeleteResult>() }
    }

    /** POST /voices/:id/preview?lang=<lang> → raw WAV bytes (audio/wav) on 200. */
    open suspend fun preview(voiceId: String, lang: String): AuthResult<ByteArray> = safeSettingsCall(log) {
        log.info("preview", mapOf("voiceId" to voiceId, "lang" to (lang.ifEmpty { "(unset)" })))
        val url = "$baseUrl$PATH_VOICES/${voiceId.encodeURLPathPart()}/preview?lang=${lang.encodeURLQueryComponent()}"
        val resp = httpClient.post(url) { bearer() }
        mapSettingsResponse(log, resp) {
            val bytes = it.readRawBytes()
            log.info("preview.ok", mapOf("voiceId" to voiceId, "bytes" to bytes.size))
            bytes
        }
    }

    private fun HttpRequestBuilder.bearer() {
        header(HttpHeaders.Authorization, "Bearer ${token()}")
    }
}
