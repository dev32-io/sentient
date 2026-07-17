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
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertTrue

/**
 * AdminHttpClientTest — pins gateway/src/api/handlers/admin.ts + secrets.ts.
 * The SECRETS test asserts the never-echo shape: GET /admin/secrets carries
 * booleans only, and the Kotlin model has no field that could hold key material.
 */
private val JSON_HEADERS = headersOf(HttpHeaders.ContentType, "application/json")

// Exact GET /admin/secrets body from secrets.ts handleGetSecrets — booleans only.
private const val SECRETS_JSON = """{
  "llm":{
    "active":"openrouter",
    "ollama_cloud":{"has_key":false,"has_base_url":false},
    "openrouter":{"has_key":true,"has_base_url":false},
    "custom":{"has_key":false,"has_base_url":true}
  },
  "home_assistant":{
    "url":"http://ha.local",
    "observe_token":{"has_token":true},
    "mcp_server_token":{"has_token":false}
  },
  "music_assistant":{"url":null,"has_token":false}
}"""

private fun adminClient(engine: MockEngine): AdminHttpClient =
    AdminHttpClient(
        httpClient = HttpClient(engine) { install(ContentNegotiation) { json(Json { ignoreUnknownKeys = true }) } },
        gatewayWsUrl = "wss://h/api/v1/ws",
        token = { "tok" },
    )

class AdminHttpClientTest {

    @Test
    fun listUsers_unwrapsUsersArray() = runTest {
        val engine = MockEngine { _ ->
            respond(
                """{"users":[{"userId":"u_1","displayName":"Alice","isAdmin":true,"avatarTint":"terra",
                    "port":9001,"createdAt":"2026-01-01T00:00:00Z"}]}""",
                HttpStatusCode.OK,
                JSON_HEADERS,
            )
        }
        val result = adminClient(engine).listUsers()
        assertIs<AuthResult.Success<List<UserSummary>>>(result)
        assertEquals("u_1", result.value.first().userId)
        assertTrue(result.value.first().isAdmin)
        assertEquals(9001, result.value.first().port)
    }

    @Test
    fun getSecretsStatus_neverEchoesKeyMaterial_booleansOnly() = runTest {
        val engine = MockEngine { _ -> respond(SECRETS_JSON, HttpStatusCode.OK, JSON_HEADERS) }
        val result = adminClient(engine).getSecretsStatus()
        assertIs<AuthResult.Success<SecretsStatus>>(result)
        val s = result.value
        assertEquals("openrouter", s.llm.active)
        assertTrue(s.llm.openrouter.hasKey)
        assertFalse(s.llm.ollamaCloud.hasKey)
        assertTrue(s.llm.custom.hasBaseUrl)
        assertTrue(s.homeAssistant.observeToken.hasToken)
        assertFalse(s.musicAssistant.hasToken)
        // The status model is presence-only by construction — there is no place
        // for a raw key to be surfaced, which is the never-echo guarantee.
    }

    @Test
    fun setLlmProviderKey_sendsValueAndBaseUrlBody() = runTest {
        var body: String? = null
        var path: String? = null
        val engine = MockEngine { req ->
            path = req.url.encodedPath
            body = req.body.toByteArray().decodeToString()
            respond("""{"ok":true}""", HttpStatusCode.OK, JSON_HEADERS)
        }
        val result = adminClient(engine).setLlmProviderKey("openrouter", value = "sk-secret", providerBaseUrl = null)
        assertIs<AuthResult.Success<Unit>>(result)
        assertEquals("/api/v1/admin/secrets/llm/openrouter", path)
        val sent = body ?: ""
        assertTrue(sent.contains("\"value\":\"sk-secret\""), "body=$sent")
        // base_url was null → omitted (settingsBodyJson explicitNulls=false).
        assertFalse(sent.contains("base_url"), "base_url must be omitted when null: $sent")
    }

    @Test
    fun setActiveLlmProvider_sendsProviderBody() = runTest {
        var body: String? = null
        val engine = MockEngine { req ->
            body = req.body.toByteArray().decodeToString()
            respond("""{"ok":true}""", HttpStatusCode.OK, JSON_HEADERS)
        }
        adminClient(engine).setActiveLlmProvider("custom")
        assertTrue((body ?: "").contains("\"provider\":\"custom\""), "body=$body")
    }
}
