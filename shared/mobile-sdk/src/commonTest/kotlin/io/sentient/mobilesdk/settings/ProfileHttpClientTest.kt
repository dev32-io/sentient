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
import io.sentient.mobilesdk.auth.AuthResult
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * ProfileHttpClientTest — MockEngine wire-contract tests pinning the exact JSON
 * shapes of gateway/src/api/handlers/profile.ts + profile-edit.ts.
 */
private val JSON_HEADERS = headersOf(HttpHeaders.ContentType, "application/json")

// A full ProfileV1 body exactly as `GET /profile/me` returns it (profile-types.ts).
private const val PROFILE_JSON = """{
  "schemaVersion":1,
  "userId":"u_abc123",
  "model":{"provider":"openrouter","id":"google/gemini-2.5-flash"},
  "voice":{"provider":"local-tts","id":"default"},
  "audio":{"ttsEnabled":true,"channel":"voice"},
  "persona":{"template":"default","overrides":""},
  "tools":{"enabled":{"home-assistant":[]},"toolsets":["memory","web"]},
  "compression":{"threshold":0.5},
  "advanced":{"extraSystemPrompt":"","maxTokens":1024,"reasoningEffort":"minimal"},
  "devices":{"signal":{"paired":true,"account_masked":"+1•••••1234","linked_at":"2026-07-01T00:00:00Z"}}
}"""

private fun profileClient(engine: MockEngine): ProfileHttpClient =
    ProfileHttpClient(
        httpClient = HttpClient(engine) { install(ContentNegotiation) { json(Json { ignoreUnknownKeys = true }) } },
        gatewayWsUrl = "wss://h/api/v1/ws",
        token = { "tok" },
    )

private fun editClient(engine: MockEngine): ProfileEditHttpClient =
    ProfileEditHttpClient(
        httpClient = HttpClient(engine) { install(ContentNegotiation) { json(Json { ignoreUnknownKeys = true }) } },
        gatewayWsUrl = "wss://h/api/v1/ws",
        token = { "tok" },
    )

class ProfileHttpClientTest {

    @Test
    fun getMe_parsesFullProfileAndSendsBearer() = runTest {
        var auth: String? = null
        val engine = MockEngine { req ->
            auth = req.headers[HttpHeaders.Authorization]
            respond(PROFILE_JSON, HttpStatusCode.OK, JSON_HEADERS)
        }
        val result = profileClient(engine).getMe()
        assertIs<AuthResult.Success<ProfileV1>>(result)
        val p = result.value
        assertEquals(1, p.schemaVersion)
        assertEquals("u_abc123", p.userId)
        assertEquals("openrouter", p.model.provider)
        assertEquals("local-tts", p.voice.provider)
        assertEquals(listOf("memory", "web"), p.tools.toolsets)
        assertEquals("+1•••••1234", p.devices?.signal?.accountMasked)
        assertEquals("Bearer tok", auth)
    }

    @Test
    fun updateMe_omitsNullOptionalFields_soZodOptionalValidates() = runTest {
        var body: String? = null
        val engine = MockEngine { req ->
            body = req.body.toByteArray().decodeToString()
            respond(PROFILE_JSON, HttpStatusCode.OK, JSON_HEADERS)
        }
        val profile = ProfileV1(
            schemaVersion = 1,
            userId = "u_x",
            model = ProfileModelRef("custom", "m"),
            voice = ProfileVoiceRef("local-tts", "default"),
            audio = ProfileAudio(ttsEnabled = false, channel = "text"),
            persona = ProfilePersona("default", ""),
            tools = ProfileTools(enabled = emptyMap(), toolsets = null),
            compression = ProfileCompression(0.5),
            advanced = ProfileAdvanced("", 1024, "minimal"),
            devices = null,
        )
        profileClient(engine).updateMe(profile)
        val sent = body ?: ""
        assertTrue(sent.contains("\"userId\":\"u_x\""), "body=$sent")
        // explicitNulls=false: null optionals must be ABSENT, never `null` (zod .optional() rejects null).
        assertFalse(sent.contains("toolsets"), "toolsets must be omitted: $sent")
        assertFalse(sent.contains("devices"), "devices must be omitted: $sent")
    }

    @Test
    fun updateMe_maps422UserIdMismatchToServerError() = runTest {
        val engine = MockEngine { _ ->
            respond("""{"error":"userId-mismatch"}""", HttpStatusCode.UnprocessableEntity, JSON_HEADERS)
        }
        val result = profileClient(engine).updateMe(
            ProfileV1(
                1, "u_x",
                ProfileModelRef("custom", "m"), ProfileVoiceRef("local-tts", "default"),
                ProfileAudio(true, "voice"), ProfilePersona("default", ""),
                ProfileTools(emptyMap(), null), ProfileCompression(0.5),
                ProfileAdvanced("", 1024, "minimal"), null,
            ),
        )
        assertIs<AuthResult.Failure>(result)
        val err = result.error
        assertIs<AuthError.Server>(err)
        assertEquals(422, err.status)
        assertTrue(err.body.contains("userId-mismatch"))
    }

    @Test
    fun apply_maps429ToInProgress() = runTest {
        val engine = MockEngine { _ ->
            respond(
                """{"error":"apply-in-progress","reason":"another apply is already running"}""",
                HttpStatusCode.TooManyRequests,
                JSON_HEADERS,
            )
        }
        val result = profileClient(engine).apply()
        assertIs<ApplyResult.InProgress>(result)
    }

    @Test
    fun apply_maps200ReadyWithElapsedMs() = runTest {
        val engine = MockEngine { _ ->
            respond("""{"status":"ready","elapsedMs":4321}""", HttpStatusCode.OK, JSON_HEADERS)
        }
        val result = profileClient(engine).apply()
        assertIs<ApplyResult.Ready>(result)
        assertEquals(4321L, result.elapsedMs)
    }

    @Test
    fun getMemory_carriesCharLimit() = runTest {
        val engine = MockEngine { _ ->
            respond("""{"content":"hi","lastModified":null,"charLimit":12000}""", HttpStatusCode.OK, JSON_HEADERS)
        }
        val result = editClient(engine).getMemory(MemorySlot.MEMORY)
        assertIs<AuthResult.Success<MemoryDoc>>(result)
        assertEquals(12000, result.value.charLimit)
        assertEquals("hi", result.value.content)
        assertNull(result.value.lastModified)
    }

    @Test
    fun putSoul_maps200RestartOutcomeToReady() = runTest {
        var path: String? = null
        val engine = MockEngine { req ->
            path = req.url.encodedPath
            respond("""{"state":"ready","elapsedMs":900}""", HttpStatusCode.OK, JSON_HEADERS)
        }
        val result = editClient(engine).putSoul("new soul text")
        assertIs<ApplyResult.Ready>(result)
        assertEquals(900L, result.elapsedMs)
        assertEquals("/api/v1/profile/soul", path)
    }

    @Test
    fun createPersonality_nameConflictMapsToFailed409() = runTest {
        val engine = MockEngine { _ ->
            respond("""{"error":"name-conflict"}""", HttpStatusCode.Conflict, JSON_HEADERS)
        }
        val result = editClient(engine).createPersonality("Nova", "be helpful")
        assertIs<ApplyResult.Failed>(result)
        assertEquals(409, result.status)
        assertEquals("name-conflict", result.code)
    }
}
