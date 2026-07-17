package io.sentient.mobilesdk.auth

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.engine.mock.toByteArray
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
import kotlin.test.assertTrue

/**
 * AuthClientSettingsTest — pins the Account-page auth mutations added for the
 * settings surface (gateway/src/api/handlers/auth.ts handleUpdateMe /
 * handleChangePin / handleLogout). Pin values are never logged (no-op logger here).
 */
private val noOpLog = object : Log {
    override fun debug(message: String, props: Map<String, Any?>) = Unit
    override fun info(message: String, props: Map<String, Any?>) = Unit
    override fun warn(message: String, props: Map<String, Any?>) = Unit
    override fun error(message: String, props: Map<String, Any?>) = Unit
}
private val JSON_HEADERS = headersOf(HttpHeaders.ContentType, ContentType.Application.Json.toString())

class AuthClientSettingsTest {

    private fun buildClient(engine: MockEngine): AuthClient {
        val http = HttpClient(engine) { install(ContentNegotiation) { json(Json { ignoreUnknownKeys = true }) } }
        return AuthClient(gatewayWsUrl = "wss://h:3000/api/v1/ws", httpClient = http, log = noOpLog)
    }

    @Test
    fun updateMe_putsDisplayName_returnsRefreshedUser() = runTest {
        var method: HttpMethod? = null
        var path: String? = null
        var body: String? = null
        val engine = MockEngine { req ->
            method = req.method
            path = req.url.encodedPath
            body = req.body.toByteArray().decodeToString()
            respond(
                """{"token":"tok_new","user":{"userId":"u_1","displayName":"Renamed","isAdmin":false,"avatarTint":"sage"}}""",
                HttpStatusCode.OK,
                JSON_HEADERS,
            )
        }
        val result = buildClient(engine).updateMe(token = "tok_old", displayName = "Renamed")
        assertIs<AuthResult.Success<AuthResponse>>(result)
        assertEquals("Renamed", result.value.user.displayName)
        assertEquals("tok_new", result.value.token)
        assertEquals(HttpMethod.Put, method)
        assertEquals("/api/v1/auth/me", path)
        assertTrue((body ?: "").contains("\"displayName\":\"Renamed\""), "body=$body")
    }

    @Test
    fun changePin_sendsCurrentAndNew_returnsUnitOnOk() = runTest {
        var path: String? = null
        var body: String? = null
        val engine = MockEngine { req ->
            path = req.url.encodedPath
            body = req.body.toByteArray().decodeToString()
            respond("""{"ok":true}""", HttpStatusCode.OK, JSON_HEADERS)
        }
        val result = buildClient(engine).changePin(token = "tok", currentPin = "1234", newPin = "5678")
        assertIs<AuthResult.Success<Unit>>(result)
        assertEquals("/api/v1/auth/me/pin", path)
        val sent = body ?: ""
        assertTrue(sent.contains("\"currentPin\":\"1234\""), "body=$sent")
        assertTrue(sent.contains("\"newPin\":\"5678\""), "body=$sent")
    }

    @Test
    fun changePin_wrongCurrent_401_mapsToInvalidCredentials() = runTest {
        // auth.ts handleChangePin: wrong-pin → jsonError(401, "invalid-credentials")
        val engine = MockEngine { _ ->
            respond("""{"error":"invalid-credentials"}""", HttpStatusCode.Unauthorized, JSON_HEADERS)
        }
        val result = buildClient(engine).changePin(token = "tok", currentPin = "0000", newPin = "5678")
        assertIs<AuthResult.Failure>(result)
        assertIs<AuthError.InvalidCredentials>(result.error)
    }

    @Test
    fun logout_postsToLogout_returnsUnit() = runTest {
        var method: HttpMethod? = null
        var path: String? = null
        val engine = MockEngine { req ->
            method = req.method
            path = req.url.encodedPath
            respond("""{"ok":true}""", HttpStatusCode.OK, JSON_HEADERS)
        }
        val result = buildClient(engine).logout(token = "tok")
        assertIs<AuthResult.Success<Unit>>(result)
        assertEquals(HttpMethod.Post, method)
        assertEquals("/api/v1/auth/logout", path)
    }
}
