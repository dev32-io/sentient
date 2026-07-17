package io.sentient.mobilesdk.settings

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import io.ktor.serialization.kotlinx.json.json
import io.sentient.mobilesdk.auth.AuthResult
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertTrue

/**
 * ServicesVersionsHttpClientTest — pins GET /api/v1/services/versions
 * (gateway/src/api/handlers/services-versions.ts), especially the
 * features.fish_browse_enabled flag mobile gates the Fish UI on.
 */
private val JSON_HEADERS = headersOf(HttpHeaders.ContentType, "application/json")

class ServicesVersionsHttpClientTest {

    private fun client(engine: MockEngine): ServicesVersionsHttpClient =
        ServicesVersionsHttpClient(
            httpClient = HttpClient(engine) { install(ContentNegotiation) { json(Json { ignoreUnknownKeys = true }) } },
            gatewayWsUrl = "wss://h/api/v1/ws",
            token = { "tok" },
        )

    @Test
    fun get_parsesVersionsAndFishFlag() = runTest {
        var path: String? = null
        val engine = MockEngine { req ->
            path = req.url.encodedPath
            respond(
                """{"gateway":"1.12.0","hermes":"0.9.1","stt_service":"0.2.0","tts_service":"0.3.0",
                    "features":{"fish_browse_enabled":true}}""",
                HttpStatusCode.OK,
                JSON_HEADERS,
            )
        }
        val result = client(engine).get()
        assertIs<AuthResult.Success<ServicesVersions>>(result)
        assertEquals("1.12.0", result.value.gateway)
        assertEquals("0.2.0", result.value.sttService)
        assertEquals("0.3.0", result.value.ttsService)
        assertTrue(result.value.features.fishBrowseEnabled)
        assertEquals("/api/v1/services/versions", path)
    }

    @Test
    fun get_defaultsFishFlagFalseWhenAbsent() = runTest {
        val engine = MockEngine { _ ->
            respond(
                """{"gateway":"1.12.0","hermes":"unknown","stt_service":"unknown","tts_service":"unknown",
                    "features":{}}""",
                HttpStatusCode.OK,
                JSON_HEADERS,
            )
        }
        val result = client(engine).get()
        assertIs<AuthResult.Success<ServicesVersions>>(result)
        assertEquals(false, result.value.features.fishBrowseEnabled)
    }
}
