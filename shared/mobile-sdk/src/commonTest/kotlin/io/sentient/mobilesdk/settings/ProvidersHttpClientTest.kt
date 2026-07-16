package io.sentient.mobilesdk.settings

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import io.ktor.serialization.kotlinx.json.json
import io.sentient.mobilesdk.auth.AuthError
import io.sentient.mobilesdk.auth.AuthResult
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertTrue

/**
 * ProvidersHttpClientTest — pins GET /api/v1/providers/models
 * (gateway/src/api/handlers/providers.ts respondModels + providers/catalogs/types.ts
 * ModelEntry). Crucially covers the pricing polymorphism: `pricingPer1mPrompt` /
 * `pricingPer1mCompletion` are typed `number | "included"` on the wire — the Kotlin
 * model captures both shapes via a raw JsonPrimitive rather than failing to decode.
 */
private val JSON_HEADERS = headersOf(HttpHeaders.ContentType, "application/json")

private fun providersClient(engine: MockEngine): ProvidersHttpClient =
    ProvidersHttpClient(
        httpClient = HttpClient(engine) { install(ContentNegotiation) { json(Json { ignoreUnknownKeys = true }) } },
        gatewayWsUrl = "wss://h/api/v1/ws",
        token = { "tok" },
    )

class ProvidersHttpClientTest {

    @Test
    fun listModels_parsesPricingPolymorphism_numericAndIncluded() = runTest {
        var path: String? = null
        val engine = MockEngine { req ->
            path = req.url.encodedPath
            respond(
                """{"models":[
                    {"id":"openrouter/gpt-4o","provider":"openrouter","name":"GPT-4o",
                     "description":"Flagship multimodal model","contextLength":128000,
                     "pricingPer1mPrompt":2.5,"pricingPer1mCompletion":10,
                     "supportsTools":true,"supportsVision":true},
                    {"id":"ollama-cloud/llama3","provider":"ollama-cloud","name":"Llama 3",
                     "description":"Locally-hosted, no metered cost","contextLength":8192,
                     "pricingPer1mPrompt":"included","pricingPer1mCompletion":"included",
                     "supportsTools":false,"supportsVision":false}
                ],"stale":false}""",
                HttpStatusCode.OK,
                JSON_HEADERS,
            )
        }
        val result = providersClient(engine).listModels()
        assertIs<AuthResult.Success<ModelCatalog>>(result)
        assertEquals("/api/v1/providers/models", path)
        assertFalse(result.value.stale)

        val models = result.value.models
        assertEquals(2, models.size)

        val numeric = models[0]
        assertEquals("openrouter/gpt-4o", numeric.id)
        assertTrue(numeric.supportsTools)
        assertFalse(numeric.pricingPer1mPrompt.isString, "numeric pricing must not decode as a JSON string")
        assertEquals("2.5", numeric.pricingPer1mPrompt.content)
        assertFalse(numeric.pricingPer1mCompletion.isString)
        assertEquals("10", numeric.pricingPer1mCompletion.content)

        val included = models[1]
        assertEquals("ollama-cloud/llama3", included.id)
        assertTrue(included.pricingPer1mPrompt.isString, "included sentinel must decode as a JSON string")
        assertEquals("included", included.pricingPer1mPrompt.content)
        assertTrue(included.pricingPer1mCompletion.isString)
        assertEquals("included", included.pricingPer1mCompletion.content)
    }

    @Test
    fun listModels_staleTrue_isCarriedThrough() = runTest {
        val engine = MockEngine { _ ->
            respond("""{"models":[],"stale":true}""", HttpStatusCode.OK, JSON_HEADERS)
        }
        val result = providersClient(engine).listModels()
        assertIs<AuthResult.Success<ModelCatalog>>(result)
        assertTrue(result.value.stale)
        assertTrue(result.value.models.isEmpty())
    }

    @Test
    fun listModels_upstreamUnavailable_mapsToServer503() = runTest {
        val engine = MockEngine { _ ->
            respond("""{"error":"upstream-unavailable"}""", HttpStatusCode.ServiceUnavailable, JSON_HEADERS)
        }
        val result = providersClient(engine).listModels()
        assertIs<AuthResult.Failure>(result)
        val err = result.error
        assertIs<AuthError.Server>(err)
        assertEquals(503, err.status)
    }
}
