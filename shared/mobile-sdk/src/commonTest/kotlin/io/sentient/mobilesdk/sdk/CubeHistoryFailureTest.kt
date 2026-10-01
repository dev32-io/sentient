package io.sentient.mobilesdk.sdk

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpStatusCode
import io.sentient.mobilesdk.connectors.SessionsRequestException
import io.sentient.mobilesdk.connectors.SessionsTransportException
import io.sentient.mobilesdk.fakes.FakeWebSocketEngine
import io.sentient.mobilesdk.sessions.SessionsHttpClient
import kotlinx.coroutines.test.runTest
import kotlin.coroutines.cancellation.CancellationException
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

class CubeHistoryFailureTest {
    @Test
    fun history_http_and_decode_failures_reach_sdk_caller_and_can_be_retried() = runTest {
        var status = HttpStatusCode.OK
        var body = ""
        HttpClient(MockEngine { respond(body, status) }).use { http ->
            val client = SessionsHttpClient(http, "wss://test/api/v1/ws", { "fixture-token" })
            val socket = FakeWebSocketEngine()
            val sdk = buildSdk(socket, sessionsHttpClient = client)
            val failures = listOf(
                Triple(HttpStatusCode.NotFound, "{}", "not_found"),
                Triple(HttpStatusCode.Unauthorized, "{}", "unauthorized"),
                Triple(HttpStatusCode.Forbidden, "{}", "forbidden"),
                Triple(HttpStatusCode.ServiceUnavailable, "{}", "unavailable"),
                Triple(HttpStatusCode.OK, "not-json", "invalid_response"),
                Triple(HttpStatusCode.OK, "{}", "invalid_response"),
                Triple(HttpStatusCode.OK, """{"items":{}}""", "invalid_response"),
                Triple(HttpStatusCode.OK, """{"items":[null]}""", "invalid_response"),
            )
            for ((responseStatus, responseBody, code) in failures) {
                status = responseStatus
                body = responseBody
                val failure = assertIs<SessionsRequestException>(
                    runCatching { sdk.cubeHistory("cube") }.exceptionOrNull(),
                )
                assertEquals(code, failure.code)
                assertEquals(emptyList(), client.getMessages("cube"), "Legacy fallback for $code")
            }
            status = HttpStatusCode.OK
            body = """{"items":[],"provenance":"cube","readOnly":true}"""
            assertTrue(sdk.cubeHistory("cube").isEmpty(), "Retry succeeds only on valid empty history")
            assertTrue(socket.sentText.isEmpty(), "Viewer never activates a session")
            assertNull(sdk.currentSessionId.value)
        }
    }

    @Test
    fun history_network_failure_is_typed_without_changing_legacy_fallback() = runTest {
        HttpClient(MockEngine { throw IllegalStateException("fixture transport failure") }).use { http ->
            val client = SessionsHttpClient(http, "wss://test/api/v1/ws", { "fixture-token" })
            val sdk = buildSdk(FakeWebSocketEngine(), sessionsHttpClient = client)
            assertIs<SessionsTransportException>(runCatching { sdk.cubeHistory("cube") }.exceptionOrNull())
            assertEquals(emptyList(), client.getMessages("cube"))
        }
    }

    @Test
    fun history_and_legacy_messages_preserve_cancellation() = runTest {
        val cancelled = CancellationException("fixture cancellation")
        HttpClient(MockEngine { throw cancelled }).use { http ->
            val client = SessionsHttpClient(http, "wss://test/api/v1/ws", { "fixture-token" })
            val sdk = buildSdk(FakeWebSocketEngine(), sessionsHttpClient = client)
            // Coroutine stacktrace recovery may copy exceptions across the HTTP boundary.
            val sdkFailure = assertIs<CancellationException>(runCatching { sdk.cubeHistory("cube") }.exceptionOrNull())
            val legacyFailure = assertIs<CancellationException>(runCatching { client.getMessages("cube") }.exceptionOrNull())
            assertEquals(cancelled.message, sdkFailure.message)
            assertEquals(cancelled.message, legacyFailure.message)
        }
    }
}
