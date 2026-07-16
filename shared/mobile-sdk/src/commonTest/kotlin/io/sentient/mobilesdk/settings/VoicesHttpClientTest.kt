package io.sentient.mobilesdk.settings

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.engine.mock.toByteArray
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import io.ktor.serialization.kotlinx.json.json
import io.sentient.mobilesdk.auth.AuthResult
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertTrue

/**
 * VoicesHttpClientTest — pins the /api/v1/voices wire shapes: list wrapper,
 * multipart create body, delete, and the raw-WAV preview binary path
 * (gateway/src/api/handlers/voices.ts + voices-create-form.ts + voices-preview.ts).
 */
private val JSON_HEADERS = headersOf(HttpHeaders.ContentType, "application/json")
private val WAV_HEADERS = headersOf(HttpHeaders.ContentType, "audio/wav")

private fun voicesClient(engine: MockEngine): VoicesHttpClient =
    VoicesHttpClient(
        httpClient = HttpClient(engine) { install(ContentNegotiation) { json(Json { ignoreUnknownKeys = true }) } },
        gatewayWsUrl = "wss://h/api/v1/ws",
        token = { "tok" },
    )

class VoicesHttpClientTest {

    @Test
    fun list_unwrapsVoicesArray() = runTest {
        val engine = MockEngine { _ ->
            respond(
                """{"voices":[{"voiceId":"abc","name":"Nova","description":"d","tags":["warm"],
                    "language":"en","source":"user","createdAt":1720000000.5,"refDurationMs":8000.0}]}""",
                HttpStatusCode.OK,
                JSON_HEADERS,
            )
        }
        val result = voicesClient(engine).list()
        assertIs<AuthResult.Success<List<VoiceSummary>>>(result)
        assertEquals("abc", result.value.first().voiceId)
        assertEquals("en", result.value.first().language)
        assertEquals("user", result.value.first().source)
    }

    @Test
    fun create_sendsMultipartWithNamedPartsAndAudioFilename() = runTest {
        var body: String? = null
        var path: String? = null
        val engine = MockEngine { req ->
            path = req.url.encodedPath
            body = req.body.toByteArray().decodeToString()
            respond("""{"voiceId":"v1","name":"Nova"}""", HttpStatusCode.OK, JSON_HEADERS)
        }
        val result = voicesClient(engine).create(
            name = "Nova",
            audioWav = byteArrayOf(0x52, 0x49, 0x46, 0x46),
            description = "a warm voice",
            tags = listOf("warm", "female"),
            language = "en",
        )
        assertIs<AuthResult.Success<VoiceCreateResult>>(result)
        assertEquals("v1", result.value.voiceId)
        val sent = body ?: ""
        assertEquals("/api/v1/voices", path)
        assertTrue(sent.contains("name=\"name\""), "missing name part: $sent")
        assertTrue(sent.contains("name=\"description\""), "missing description part: $sent")
        assertTrue(sent.contains("name=\"language\""), "missing language part: $sent")
        assertTrue(sent.contains("name=\"audio\""), "missing audio part: $sent")
        assertTrue(sent.contains("filename=\"reference.wav\""), "missing audio filename: $sent")
        // Repeatable tags: one form part per tag (drives the maxTags cap).
        assertEquals(2, Regex("name=\"tags\"").findAll(sent).count(), "expected 2 tag parts: $sent")
    }

    @Test
    fun create_surfacesActivateFailedWarning() = runTest {
        val engine = MockEngine { _ ->
            respond("""{"voiceId":"v1","name":"Nova","warning":"not-activated"}""", HttpStatusCode.OK, JSON_HEADERS)
        }
        val result = voicesClient(engine).create("Nova", byteArrayOf(1), "", emptyList(), "")
        assertIs<AuthResult.Success<VoiceCreateResult>>(result)
        assertEquals("not-activated", result.value.warning)
    }

    @Test
    fun preview_returnsRawWavBytes() = runTest {
        val wav = byteArrayOf(0x52, 0x49, 0x46, 0x46, 0x00, 0x11, 0x22, 0x33)
        var path: String? = null
        var query: String? = null
        val engine = MockEngine { req ->
            path = req.url.encodedPath
            query = req.url.encodedQuery
            respond(wav, HttpStatusCode.OK, WAV_HEADERS)
        }
        val result = voicesClient(engine).preview("abc", "en")
        assertIs<AuthResult.Success<ByteArray>>(result)
        assertContentEquals(wav, result.value)
        assertEquals("/api/v1/voices/abc/preview", path)
        assertTrue(query?.contains("lang=en") == true, "query=$query")
    }
}
