package io.sentient.mobilesdk.sessions

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.engine.mock.toByteArray
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import io.ktor.serialization.kotlinx.json.json
import io.sentient.mobilesdk.protocol.ConversationFeedItem
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs

private fun buildClient(engine: MockEngine, token: String = "t"): SessionsHttpClient =
    SessionsHttpClient(
        httpClient = HttpClient(engine) {
            install(ContentNegotiation) { json(Json { ignoreUnknownKeys = true }) }
        },
        gatewayWsUrl = "wss://h/api/v1/ws",
        token = { token },
    )

class SessionsHttpClientTest {

    @Test
    fun list_parses_items_and_sends_bearer() = runTest {
        var authHeader: String? = null
        val engine = MockEngine { req ->
            authHeader = req.headers[HttpHeaders.Authorization]
            respond(
                """{"items":[{"sessionId":"s-1","title":"T","lastActiveAt":1}],"total":1,"hasMore":false}""",
                HttpStatusCode.OK,
                headersOf(HttpHeaders.ContentType, "application/json"),
            )
        }
        val rows = buildClient(engine).list(limit = 100, offset = 0)
        assertEquals("s-1", rows.first().sessionId)
        assertEquals("Bearer t", authHeader)
    }

    @Test
    fun list_sends_limit_and_offset_params() = runTest {
        var capturedUrl: String? = null
        val engine = MockEngine { req ->
            capturedUrl = req.url.toString()
            respond(
                """{"items":[],"total":0,"hasMore":false}""",
                HttpStatusCode.OK,
                headersOf(HttpHeaders.ContentType, "application/json"),
            )
        }
        buildClient(engine).list(limit = 50, offset = 25)
        assertEquals(true, capturedUrl?.contains("limit=50") == true, "url=$capturedUrl")
        assertEquals(true, capturedUrl?.contains("offset=25") == true, "url=$capturedUrl")
    }

    @Test
    fun getMessages_parses_feed_items() = runTest {
        val engine = MockEngine { _ ->
            respond(
                """{"items":[{"kind":"user","ts":100,"channel":"text","content":"hello"}],"total":1,"hasMore":false}""",
                HttpStatusCode.OK,
                headersOf(HttpHeaders.ContentType, "application/json"),
            )
        }
        val items = buildClient(engine).getMessages("s-1")
        assertEquals(1, items.size)
        val item = items[0]
        assertIs<ConversationFeedItem.User>(item)
        assertEquals("hello", item.content)
        assertEquals(100L, item.ts)
    }

    @Test
    fun search_sends_query_and_parses_rows() = runTest {
        var capturedUrl: String? = null
        val engine = MockEngine { req ->
            capturedUrl = req.url.toString()
            respond(
                """{"items":[{"sessionId":"s-2","title":"found","lastActiveAt":2}],"total":1,"hasMore":false}""",
                HttpStatusCode.OK,
                headersOf(HttpHeaders.ContentType, "application/json"),
            )
        }
        val rows = buildClient(engine).search(q = "find me", limit = 10)
        assertEquals("s-2", rows.first().sessionId)
        val urlContainsQuery = capturedUrl?.contains("q=find+me") == true ||
            capturedUrl?.contains("q=find%20me") == true
        assertEquals(true, urlContainsQuery, "url=$capturedUrl")
    }

    @Test
    fun rename_sends_patch_with_title() = runTest {
        var capturedBody: String? = null
        var capturedPath: String? = null
        val engine = MockEngine { req ->
            capturedPath = req.url.encodedPath
            capturedBody = req.body.toByteArray().decodeToString()
            respond("{}", HttpStatusCode.OK, headersOf(HttpHeaders.ContentType, "application/json"))
        }
        buildClient(engine).rename("s-3", "New Name")
        assertEquals(true, capturedPath?.endsWith("/s-3") == true, "path=$capturedPath")
        assertEquals(true, capturedBody?.contains("New Name") == true, "body=$capturedBody")
    }

    @Test
    fun delete_sends_delete_to_session_path() = runTest {
        var capturedPath: String? = null
        val engine = MockEngine { req ->
            capturedPath = req.url.encodedPath
            respond("{}", HttpStatusCode.OK, headersOf(HttpHeaders.ContentType, "application/json"))
        }
        buildClient(engine).delete("s-99")
        assertEquals(true, capturedPath?.endsWith("/s-99") == true, "path=$capturedPath")
    }

    @Test
    fun list_returns_empty_on_4xx() = runTest {
        val engine = MockEngine { _ ->
            respond(
                """{"error":"forbidden"}""",
                HttpStatusCode.Forbidden,
                headersOf(HttpHeaders.ContentType, "application/json"),
            )
        }
        val rows = buildClient(engine).list(limit = 20, offset = 0)
        assertEquals(emptyList(), rows)
    }
}
