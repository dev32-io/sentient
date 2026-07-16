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
import io.sentient.mobilesdk.auth.AuthError
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * FishHttpClientTest — pins the gated Fish browse/clone routes
 * (gateway/src/api/handlers/fish/fish-browse.ts + fish-clone.ts). Crucially
 * verifies the disabled-404 (plain body) → FishResult.FeatureDisabled mapping
 * vs a JSON error 404 → Failure.
 */
private val JSON_HEADERS = headersOf(HttpHeaders.ContentType, "application/json")
private val TEXT_HEADERS = headersOf(HttpHeaders.ContentType, "text/plain")

private fun fishClient(engine: MockEngine): FishHttpClient =
    FishHttpClient(
        httpClient = HttpClient(engine) { install(ContentNegotiation) { json(Json { ignoreUnknownKeys = true }) } },
        gatewayWsUrl = "wss://h/api/v1/ws",
        token = { "tok" },
    )

class FishHttpClientTest {

    @Test
    fun listVoices_parsesPageShape() = runTest {
        var query: String? = null
        val engine = MockEngine { req ->
            query = req.url.encodedQuery
            respond(
                """{"voices":[{"id":"f1","title":"Deep","description":"","languages":["en"],"tags":["male"],
                    "coverImageUrl":null,"previewAudioUrl":"https://x.fish.audio/a.mp3","visibility":"public",
                    "taskCount":3,"createdAt":"2026-01-01"}],"hasMore":true,"stale":false}""",
                HttpStatusCode.OK,
                JSON_HEADERS,
            )
        }
        val result = fishClient(engine).listVoices(title = "deep", page = 2)
        assertIs<FishResult.Success<FishVoicePage>>(result)
        assertEquals("f1", result.value.voices.first().id)
        assertEquals(listOf("en"), result.value.voices.first().languages)
        assertTrue(result.value.hasMore)
        assertTrue(query?.contains("title=deep") == true, "query=$query")
        assertTrue(query?.contains("page=2") == true, "query=$query")
    }

    @Test
    fun clone_success() = runTest {
        var path: String? = null
        var body: String? = null
        val engine = MockEngine { req ->
            path = req.url.encodedPath
            body = req.body.toByteArray().decodeToString()
            respond("""{"voiceId":"v9","name":"Cloned"}""", HttpStatusCode.OK, JSON_HEADERS)
        }
        val result = fishClient(engine).clone(
            "fish123",
            CloneFromFishRequest(name = "Cloned", description = "d", tags = listOf("x"), language = "en"),
        )
        assertIs<FishResult.Success<CloneFromFishResult>>(result)
        assertEquals("v9", result.value.voiceId)
        assertNull(result.value.warning)
        assertEquals("/api/v1/providers/voices/fish123/clone", path)
        assertTrue((body ?: "").contains("\"name\":\"Cloned\""), "body=$body")
    }

    @Test
    fun clone_partialSuccess_activateFailedWarning() = runTest {
        val engine = MockEngine { _ ->
            respond("""{"voiceId":"v9","name":"Cloned","warning":"not-activated"}""", HttpStatusCode.OK, JSON_HEADERS)
        }
        val result = fishClient(engine).clone("fish123", CloneFromFishRequest(name = "Cloned"))
        assertIs<FishResult.Success<CloneFromFishResult>>(result)
        assertEquals("not-activated", result.value.warning)
    }

    @Test
    fun list_featureDisabled_plainText404_mapsToFeatureDisabled() = runTest {
        val engine = MockEngine { _ -> respond("Not Found", HttpStatusCode.NotFound, TEXT_HEADERS) }
        val result = fishClient(engine).listVoices()
        assertIs<FishResult.FeatureDisabled>(result)
    }

    @Test
    fun clone_featureDisabled_plainText404_mapsToFeatureDisabled() = runTest {
        val engine = MockEngine { _ -> respond("Not Found", HttpStatusCode.NotFound, TEXT_HEADERS) }
        val result = fishClient(engine).clone("fish123", CloneFromFishRequest(name = "Cloned"))
        assertIs<FishResult.FeatureDisabled>(result)
    }

    @Test
    fun getVoice_jsonError404_mapsToFailure_notFeatureDisabled() = runTest {
        val engine = MockEngine { _ ->
            respond("""{"error":"voice-not-found"}""", HttpStatusCode.NotFound, JSON_HEADERS)
        }
        val result = fishClient(engine).getVoice("missing")
        assertIs<FishResult.Failure>(result)
        val err = result.error
        assertIs<AuthError.Server>(err)
        assertEquals(404, err.status)
    }
}
