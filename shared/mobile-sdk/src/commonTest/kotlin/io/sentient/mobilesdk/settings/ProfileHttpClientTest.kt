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

// A full ProfileV1 body exactly as `GET /profile/me` returns it TODAY
// (profile-types.ts) — post tools.enabled -> tools.permissions migration.
private const val PROFILE_JSON = """{
  "schemaVersion":1,
  "userId":"u_abc123",
  "model":{"provider":"openrouter","id":"google/gemini-2.5-flash"},
  "voice":{"provider":"local-tts","id":"default"},
  "audio":{"ttsEnabled":true,"channel":"voice"},
  "persona":{"template":"default","overrides":""},
  "tools":{"permissions":{"home-assistant":{"get_state":"allow","*":"ask"}},"toolsets":["memory","web"]},
  "compression":{"threshold":0.5},
  "advanced":{"extraSystemPrompt":"","maxTokens":1024,"reasoningEffort":"minimal"}
}"""

// A profile whose `tools` names NEITHER `permissions` NOR `toolsets` — the real shape of
// EVERY response now that `enabled` is retired (gateway's `permissions` field is
// `.optional()`; a never-configured account never had it). This is the "live break" this
// task fixes: a required-no-default `enabled` field used to throw on exactly this body.
private const val PROFILE_JSON_UNCONFIGURED_TOOLS = """{
  "schemaVersion":1,
  "userId":"u_abc123",
  "model":{"provider":"openrouter","id":"google/gemini-2.5-flash"},
  "voice":{"provider":"local-tts","id":"default"},
  "audio":{"ttsEnabled":true,"channel":"voice"},
  "persona":{"template":"default","overrides":""},
  "tools":{},
  "compression":{"threshold":0.5},
  "advanced":{"extraSystemPrompt":"","maxTokens":1024,"reasoningEffort":"minimal"}
}"""

// A full McpCatalogView body exactly as `GET /mcp-catalog` returns it TODAY
// (mcp-catalog.ts) — the endpoint this task added the most new required fields to.
// Includes one server with a settable, resolved tool + a wildcard, plus nativeTools'
// one settable:false entry (delegateTask, structurally unwritable via a PUT).
private const val MCP_CATALOG_JSON = """{
  "groups":{
    "home":{
      "tools":[
        {"name":"get_state","description":"Get entity state.","tier":"read","permission":"allow","settable":true,"dispatch":{"kind":"mcp","serverName":"home-assistant"}},
        {"name":"call_service","description":"Call a service.","tier":"write","permission":"ask","settable":true,"dispatch":{"kind":"native"}}
      ],
      "wildcardPermission":"ask",
      "defaultExposure":"standard",
      "description":"Home Assistant"
    }
  },
  "wildcardPermissionKey":"*",
  "hermesBuiltins":[
    {"name":"remember","description":"Save a memory.","toolset":"memory"}
  ]
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
        assertEquals(ToolPermission.ALLOW, p.tools.permissions?.get("home-assistant")?.get("get_state"))
        assertEquals(ToolPermission.ASK, p.tools.permissions?.get("home-assistant")?.get("*"))
        assertEquals("Bearer tok", auth)
    }

    // Self-review-mandated: pin the actual live break directly against a real decode of a
    // real response body — a hand-built fixture that happens to still carry a field proves
    // nothing about the shape the gateway sends TODAY. `tools:{}` (no `permissions`, no
    // `toolsets`) is every never-configured account's real response now that `enabled` is
    // retired; a required-no-default field here used to throw on exactly this body.
    @Test
    fun getMe_decodesWhenToolsNamesNeitherPermissionsNorToolsets() = runTest {
        val engine = MockEngine { _ -> respond(PROFILE_JSON_UNCONFIGURED_TOOLS, HttpStatusCode.OK, JSON_HEADERS) }
        val result = profileClient(engine).getMe()
        assertIs<AuthResult.Success<ProfileV1>>(result)
        assertNull(result.value.tools.permissions, "absent permissions must decode as null (never set), not throw")
        assertNull(result.value.tools.toolsets)
    }

    @Test
    fun updateMe_omitsNullOptionalFields_soZodOptionalValidates() = runTest {
        var body: String? = null
        val engine = MockEngine { req ->
            body = req.body.toByteArray().decodeToString()
            respond(PROFILE_JSON, HttpStatusCode.OK, JSON_HEADERS)
        }
        val profile = ProfileV1PutBody(
            schemaVersion = 1,
            userId = "u_x",
            model = ProfileModelRef("custom", "m"),
            voice = ProfileVoiceRef("local-tts", "default"),
            audio = ProfileAudio(ttsEnabled = false, channel = "text"),
            persona = ProfilePersona("default", ""),
            tools = ProfileToolsPatch(permissions = null, toolsets = null),
            compression = ProfileCompression(0.5),
            advanced = ProfileAdvanced("", 1024, "minimal"),
        )
        profileClient(engine).updateMe(profile)
        val sent = body ?: ""
        assertTrue(sent.contains("\"userId\":\"u_x\""), "body=$sent")
        // explicitNulls=false: null optionals must be ABSENT, never `null` (zod .optional() rejects null).
        assertFalse(sent.contains("toolsets"), "toolsets must be omitted: $sent")
        assertFalse(sent.contains("permissions"), "permissions must be omitted when unset: $sent")
    }

    // The self-review-mandated proof that a client CAN actually clear a stored key: a `null`
    // permission LEAF (inside the map, not the `tools` field itself) must survive
    // settingsBodyJson's explicitNulls=false, which only ever skips a null-valued CLASS
    // property — never a Map entry's value. If this ever regresses (e.g. a future
    // kotlinx.serialization upgrade changes Map-null encoding), a "reset to role default"
    // write would silently degrade into a no-op with no compile-time signal.
    @Test
    fun updateMe_encodesExplicitNullToolPermissionAsLiteralNull() = runTest {
        var body: String? = null
        val engine = MockEngine { req ->
            body = req.body.toByteArray().decodeToString()
            respond(PROFILE_JSON, HttpStatusCode.OK, JSON_HEADERS)
        }
        val profile = ProfileV1PutBody(
            schemaVersion = 1,
            userId = "u_x",
            model = ProfileModelRef("custom", "m"),
            voice = ProfileVoiceRef("local-tts", "default"),
            audio = ProfileAudio(ttsEnabled = false, channel = "text"),
            persona = ProfilePersona("default", ""),
            tools = ProfileToolsPatch(permissions = mapOf("home-assistant" to mapOf("*" to null)), toolsets = null),
            compression = ProfileCompression(0.5),
            advanced = ProfileAdvanced("", 1024, "minimal"),
        )
        profileClient(engine).updateMe(profile)
        val sent = body ?: ""
        assertTrue(sent.contains("\"*\":null"), "a clear must be encoded as a literal map-value null: $sent")
    }

    @Test
    fun updateMe_maps422UserIdMismatchToServerError() = runTest {
        val engine = MockEngine { _ ->
            respond("""{"error":"userId-mismatch"}""", HttpStatusCode.UnprocessableEntity, JSON_HEADERS)
        }
        val result = profileClient(engine).updateMe(
            ProfileV1PutBody(
                1, "u_x",
                ProfileModelRef("custom", "m"), ProfileVoiceRef("local-tts", "default"),
                ProfileAudio(true, "voice"), ProfilePersona("default", ""),
                ProfileToolsPatch(null, null), ProfileCompression(0.5),
                ProfileAdvanced("", 1024, "minimal"),
            ),
        )
        assertIs<AuthResult.Failure>(result)
        val err = result.error
        assertIs<AuthError.Server>(err)
        assertEquals(422, err.status)
        assertEquals("server-error", err.body)
        assertFalse(err.body.contains("userId-mismatch"))
    }

    // IMPORTANT-3-mandated: a real decode through the real client, not a hand-verified
    // shape comparison — an @SerialName typo or a gateway field rename must fail HERE, at
    // test time, not silently at decode time on a real device with zero compile-time signal.
    @Test
    fun getMcpCatalog_parsesFullShapeIncludingNativeToolsAndUnsettableEntry() = runTest {
        val engine = MockEngine { _ -> respond(MCP_CATALOG_JSON, HttpStatusCode.OK, JSON_HEADERS) }
        val result = profileClient(engine).getMcpCatalog()
        assertIs<AuthResult.Success<McpCatalogView>>(result)
        val view = result.value

        assertEquals("*", view.wildcardPermissionKey)

        val group = view.groups["home"]
        assertEquals(2, group?.tools?.size)
        val getState = group?.tools?.first { it.name == "get_state" }
        assertEquals(ImpactTier.READ, getState?.tier)
        assertEquals(ToolPermission.ALLOW, getState?.permission)
        assertEquals(true, getState?.settable)
        assertEquals(ToolDispatchKind.MCP, getState?.dispatch?.kind)
        assertEquals("home-assistant", getState?.dispatch?.serverName)
        assertEquals(ToolPermission.ASK, group?.wildcardPermission)
        assertEquals(ToolDefaultExposure.STANDARD, group?.defaultExposure)
        assertEquals("Home Assistant", group?.description)

        assertEquals(1, view.hermesBuiltins.size)
        assertEquals("memory", view.hermesBuiltins.first().toolset)
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
