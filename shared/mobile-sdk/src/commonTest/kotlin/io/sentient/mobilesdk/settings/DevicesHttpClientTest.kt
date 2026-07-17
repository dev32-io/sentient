package io.sentient.mobilesdk.settings

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
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
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * DevicesHttpClientTest — pins the /api/v1/devices* wire shapes
 * (gateway/src/api/handlers/devices.ts): devices list (signal paired state,
 * including the snake_case account_masked / linked_at fields), signal link
 * start (qrDataUrl / expiresAt), link status (both the "linked"-from-profile
 * and coordinator-state shapes), link cancel, and unlink.
 */
private val JSON_HEADERS = headersOf(HttpHeaders.ContentType, "application/json")

private fun devicesClient(engine: MockEngine): DevicesHttpClient =
    DevicesHttpClient(
        httpClient = HttpClient(engine) { install(ContentNegotiation) { json(Json { ignoreUnknownKeys = true }) } },
        gatewayWsUrl = "wss://h/api/v1/ws",
        token = { "tok" },
    )

class DevicesHttpClientTest {

    @Test
    fun getDevices_parsesPairedSignal_withSnakeCaseFields() = runTest {
        var path: String? = null
        var method: HttpMethod? = null
        val engine = MockEngine { req ->
            path = req.url.encodedPath
            method = req.method
            respond(
                """{"platforms":{"signal":{"paired":true,"account_masked":"+1***1234",
                    "linked_at":"2026-07-01T12:00:00Z"}}}""",
                HttpStatusCode.OK,
                JSON_HEADERS,
            )
        }
        val result = devicesClient(engine).getDevices()
        assertIs<AuthResult.Success<DevicesResponse>>(result)
        assertEquals("/api/v1/devices", path)
        assertEquals(HttpMethod.Get, method)
        val signal = result.value.platforms.signal
        assertTrue(signal.paired)
        assertEquals("+1***1234", signal.accountMasked)
        assertEquals("2026-07-01T12:00:00Z", signal.linkedAt)
    }

    @Test
    fun getDevices_defaultsUnpairedSignal_whenPlatformsOmitted() = runTest {
        val engine = MockEngine { _ -> respond("""{"platforms":{}}""", HttpStatusCode.OK, JSON_HEADERS) }
        val result = devicesClient(engine).getDevices()
        assertIs<AuthResult.Success<DevicesResponse>>(result)
        val signal = result.value.platforms.signal
        assertFalse(signal.paired)
        assertNull(signal.accountMasked)
        assertNull(signal.linkedAt)
    }

    @Test
    fun signalLinkStart_parsesQrDataUrlAndExpiresAt() = runTest {
        var path: String? = null
        var method: HttpMethod? = null
        val engine = MockEngine { req ->
            path = req.url.encodedPath
            method = req.method
            respond(
                """{"qrDataUrl":"data:image/png;base64,iVBORw0KGgo=","expiresAt":1751000000000}""",
                HttpStatusCode.OK,
                JSON_HEADERS,
            )
        }
        val result = devicesClient(engine).signalLinkStart()
        assertIs<AuthResult.Success<SignalLinkStartResponse>>(result)
        assertEquals("/api/v1/devices/signal/link", path)
        assertEquals(HttpMethod.Post, method)
        assertEquals("data:image/png;base64,iVBORw0KGgo=", result.value.qrDataUrl)
        assertEquals(1751000000000L, result.value.expiresAt)
    }

    @Test
    fun signalLinkStatus_linkedFromProfile_carriesAccountMasked() = runTest {
        var path: String? = null
        val engine = MockEngine { req ->
            path = req.url.encodedPath
            respond("""{"state":"linked","account_masked":"+1***1234"}""", HttpStatusCode.OK, JSON_HEADERS)
        }
        val result = devicesClient(engine).signalLinkStatus()
        assertIs<AuthResult.Success<SignalLinkStatusResponse>>(result)
        assertEquals("/api/v1/devices/signal/link/status", path)
        assertEquals("linked", result.value.state)
        assertEquals("+1***1234", result.value.accountMasked)
        assertNull(result.value.error)
    }

    @Test
    fun signalLinkStatus_idle_hasNoAccountOrError() = runTest {
        val engine = MockEngine { _ -> respond("""{"state":"idle"}""", HttpStatusCode.OK, JSON_HEADERS) }
        val result = devicesClient(engine).signalLinkStatus()
        assertIs<AuthResult.Success<SignalLinkStatusResponse>>(result)
        assertEquals("idle", result.value.state)
        assertNull(result.value.accountMasked)
        assertNull(result.value.error)
    }

    @Test
    fun signalLinkStatus_coordinatorErrorState_carriesErrorField() = runTest {
        val engine = MockEngine { _ ->
            respond("""{"state":"failed","error":"signal-cli-timeout"}""", HttpStatusCode.OK, JSON_HEADERS)
        }
        val result = devicesClient(engine).signalLinkStatus()
        assertIs<AuthResult.Success<SignalLinkStatusResponse>>(result)
        assertEquals("failed", result.value.state)
        assertEquals("signal-cli-timeout", result.value.error)
    }

    @Test
    fun signalLinkCancel_ok_succeeds() = runTest {
        var path: String? = null
        var method: HttpMethod? = null
        val engine = MockEngine { req ->
            path = req.url.encodedPath
            method = req.method
            respond("""{"ok":true}""", HttpStatusCode.OK, JSON_HEADERS)
        }
        val result = devicesClient(engine).signalLinkCancel()
        assertIs<AuthResult.Success<Unit>>(result)
        assertEquals("/api/v1/devices/signal/link/cancel", path)
        assertEquals(HttpMethod.Post, method)
    }

    @Test
    fun signalUnlink_unlinked_succeeds() = runTest {
        var path: String? = null
        var method: HttpMethod? = null
        val engine = MockEngine { req ->
            path = req.url.encodedPath
            method = req.method
            respond("""{"status":"unlinked"}""", HttpStatusCode.OK, JSON_HEADERS)
        }
        val result = devicesClient(engine).signalUnlink()
        assertIs<AuthResult.Success<Unit>>(result)
        assertEquals("/api/v1/devices/signal/unlink", path)
        assertEquals(HttpMethod.Post, method)
    }
}
