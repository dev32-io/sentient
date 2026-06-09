package io.sentient.mobilesdk.auth

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import io.ktor.serialization.kotlinx.json.json
import io.sentient.mobilesdk.log.Log
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs

/** No-op logger for tests — avoids platform log sink (android.util.Log) in unit tests. */
private val noOpLog = object : Log {
    override fun debug(message: String, props: Map<String, Any?>) = Unit
    override fun info(message: String, props: Map<String, Any?>) = Unit
    override fun warn(message: String, props: Map<String, Any?>) = Unit
    override fun error(message: String, props: Map<String, Any?>) = Unit
}

// ── Wire-contract constants (must match gateway auth.ts exactly) ──

private const val GATEWAY_WS_URL = "wss://gateway.local:3000/api/v1/ws"

// Expected derived base: https://gateway.local:3000/api/v1
private const val PATH_LIST_USERS = "/api/v1/auth/users"
private const val PATH_LOGIN = "/api/v1/auth/login"
private const val PATH_ME = "/api/v1/auth/me"

private val JSON_HEADERS = headersOf(HttpHeaders.ContentType, ContentType.Application.Json.toString())

/**
 * AuthClientTest — MockEngine contract test.
 *
 * Pins exact wire shapes against gateway/src/api/handlers/auth.ts:
 *
 * listUsers: GET /api/v1/auth/users → bare JSON array [{userId,displayName,avatarTint}]
 *   CORRECTION vs plan: handleListUsers returns Response.json(r.value) where r.value is
 *   PublicUser[] — so the body is a bare array NOT {users:[...]}.
 *
 * login: POST /api/v1/auth/login → {token,user:{userId,displayName,isAdmin,avatarTint}}
 *   On 401 → {"error":"invalid-credentials"} → typed AuthError.InvalidCredentials.
 *
 * me: GET /api/v1/auth/me with Authorization: Bearer <token>
 *   → {token,user:{userId,displayName,isAdmin,avatarTint}} where token is refreshed
 *   (auth.ts calls tokens.refresh(token) in handleMe — always issues a new token).
 *   On 401 (any reason) → typed AuthError.InvalidCredentials.
 */
class AuthClientTest {

    private fun buildClient(engine: MockEngine): AuthClient {
        val httpClient = HttpClient(engine) {
            install(ContentNegotiation) { json(Json { ignoreUnknownKeys = true }) }
        }
        return AuthClient(gatewayWsUrl = GATEWAY_WS_URL, httpClient = httpClient, log = noOpLog)
    }

    // ── listUsers ─────────────────────────────────────────────────────────────

    @Test
    fun listUsers_sendsGetToCorrectPath() = runTest {
        var capturedMethod: HttpMethod? = null
        var capturedPath: String? = null

        val engine = MockEngine { request ->
            capturedMethod = request.method
            capturedPath = request.url.encodedPath
            respond(
                content = """[{"userId":"u_abc123","displayName":"Alice","avatarTint":"terra"}]""",
                status = HttpStatusCode.OK,
                headers = JSON_HEADERS,
            )
        }

        buildClient(engine).listUsers()

        assertEquals(HttpMethod.Get, capturedMethod)
        assertEquals(PATH_LIST_USERS, capturedPath)
    }

    @Test
    fun listUsers_parsesBareArray() = runTest {
        val engine = MockEngine { _ ->
            respond(
                content = """[{"userId":"u_abc123","displayName":"Alice","avatarTint":"terra"}]""",
                status = HttpStatusCode.OK,
                headers = JSON_HEADERS,
            )
        }

        val result = buildClient(engine).listUsers()

        assertIs<AuthResult.Success<List<AuthUserLite>>>(result)
        val users = result.value
        assertEquals(1, users.size)
        assertEquals("u_abc123", users[0].userId)
        assertEquals("Alice", users[0].displayName)
        assertEquals("terra", users[0].avatarTint)
    }

    @Test
    fun listUsers_handlesEmptyArray() = runTest {
        val engine = MockEngine { _ ->
            respond(content = "[]", status = HttpStatusCode.OK, headers = JSON_HEADERS)
        }

        val result = buildClient(engine).listUsers()

        assertIs<AuthResult.Success<List<AuthUserLite>>>(result)
        assertEquals(0, result.value.size)
    }

    @Test
    fun listUsers_maps5xxToServerError() = runTest {
        val engine = MockEngine { _ ->
            respond(
                content = """{"error":"io-error"}""",
                status = HttpStatusCode.InternalServerError,
                headers = JSON_HEADERS,
            )
        }

        val result = buildClient(engine).listUsers()

        assertIs<AuthResult.Failure>(result)
        val error = result.error
        assertIs<AuthError.Server>(error)
        assertEquals(500, error.status)
    }

    // ── login ─────────────────────────────────────────────────────────────────

    @Test
    fun login_sendsPostWithCorrectPath() = runTest {
        var capturedMethod: HttpMethod? = null
        var capturedPath: String? = null

        val engine = MockEngine { request ->
            capturedMethod = request.method
            capturedPath = request.url.encodedPath
            respond(
                content = """{"token":"tok_xyz","user":{"userId":"u_abc123","displayName":"Alice","isAdmin":false,"avatarTint":"terra"}}""",
                status = HttpStatusCode.OK,
                headers = JSON_HEADERS,
            )
        }

        buildClient(engine).login(userId = "u_abc123", pin = "1234")

        assertEquals(HttpMethod.Post, capturedMethod)
        assertEquals(PATH_LOGIN, capturedPath)
    }

    @Test
    fun login_parsesAuthResponse() = runTest {
        val engine = MockEngine { _ ->
            respond(
                content = """{"token":"tok_xyz","user":{"userId":"u_abc123","displayName":"Alice","isAdmin":false,"avatarTint":"terra"}}""",
                status = HttpStatusCode.OK,
                headers = JSON_HEADERS,
            )
        }

        val result = buildClient(engine).login(userId = "u_abc123", pin = "1234")

        assertIs<AuthResult.Success<AuthResponse>>(result)
        val auth = result.value
        assertEquals("tok_xyz", auth.token)
        assertEquals("u_abc123", auth.user.userId)
        assertEquals("Alice", auth.user.displayName)
        assertEquals(false, auth.user.isAdmin)
        assertEquals("terra", auth.user.avatarTint)
    }

    @Test
    fun login_maps401ToInvalidCredentials() = runTest {
        // auth.ts handleLogin: on authenticate failure → jsonError(401, "invalid-credentials")
        val engine = MockEngine { _ ->
            respond(
                content = """{"error":"invalid-credentials"}""",
                status = HttpStatusCode.Unauthorized,
                headers = JSON_HEADERS,
            )
        }

        val result = buildClient(engine).login(userId = "u_abc123", pin = "0000")

        assertIs<AuthResult.Failure>(result)
        assertIs<AuthError.InvalidCredentials>(result.error)
    }

    @Test
    fun login_maps5xxToServerError() = runTest {
        val engine = MockEngine { _ ->
            respond(
                content = """{"error":"io-error"}""",
                status = HttpStatusCode.InternalServerError,
                headers = JSON_HEADERS,
            )
        }

        val result = buildClient(engine).login(userId = "u_abc123", pin = "1234")

        assertIs<AuthResult.Failure>(result)
        assertIs<AuthError.Server>(result.error)
    }

    // ── me ────────────────────────────────────────────────────────────────────

    @Test
    fun me_sendsGetWithBearerHeader() = runTest {
        var capturedMethod: HttpMethod? = null
        var capturedPath: String? = null
        var capturedAuth: String? = null

        val engine = MockEngine { request ->
            capturedMethod = request.method
            capturedPath = request.url.encodedPath
            capturedAuth = request.headers[HttpHeaders.Authorization]
            respond(
                content = """{"token":"tok_refreshed","user":{"userId":"u_abc123","displayName":"Alice","isAdmin":true,"avatarTint":"sage"}}""",
                status = HttpStatusCode.OK,
                headers = JSON_HEADERS,
            )
        }

        buildClient(engine).me(token = "tok_original")

        assertEquals(HttpMethod.Get, capturedMethod)
        assertEquals(PATH_ME, capturedPath)
        assertEquals("Bearer tok_original", capturedAuth)
    }

    @Test
    fun me_parsesRefreshedAuthResponse() = runTest {
        // auth.ts tokens.refresh issues a new token — so response token differs from request token
        val engine = MockEngine { _ ->
            respond(
                content = """{"token":"tok_refreshed","user":{"userId":"u_abc123","displayName":"Alice","isAdmin":true,"avatarTint":"sage"}}""",
                status = HttpStatusCode.OK,
                headers = JSON_HEADERS,
            )
        }

        val result = buildClient(engine).me(token = "tok_original")

        assertIs<AuthResult.Success<AuthResponse>>(result)
        val auth = result.value
        assertEquals("tok_refreshed", auth.token)
        assertEquals("u_abc123", auth.user.userId)
        assertEquals(true, auth.user.isAdmin)
        assertEquals("sage", auth.user.avatarTint)
    }

    @Test
    fun me_maps401MissingTokenToInvalidCredentials() = runTest {
        val engine = MockEngine { _ ->
            respond(
                content = """{"error":"missing-token"}""",
                status = HttpStatusCode.Unauthorized,
                headers = JSON_HEADERS,
            )
        }

        val result = buildClient(engine).me(token = "expired_tok")

        assertIs<AuthResult.Failure>(result)
        assertIs<AuthError.InvalidCredentials>(result.error)
    }

    @Test
    fun me_maps401ExpiredToInvalidCredentials() = runTest {
        // auth.ts tokens.validate returns "expired" error kind propagated verbatim
        val engine = MockEngine { _ ->
            respond(
                content = """{"error":"expired"}""",
                status = HttpStatusCode.Unauthorized,
                headers = JSON_HEADERS,
            )
        }

        val result = buildClient(engine).me(token = "expired_tok")

        assertIs<AuthResult.Failure>(result)
        assertIs<AuthError.InvalidCredentials>(result.error)
    }

}
