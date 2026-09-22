package io.sentient.mobilesdk.attachments

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import io.ktor.utils.io.ByteWriteChannel
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class AttachmentsHttpClientTest {
    @Test
    fun upload_uses_authenticated_raw_body_contract_and_decodes_ref() = runBlocking {
        val engine = MockEngine { request ->
            assertEquals("Bearer token", request.headers[HttpHeaders.Authorization])
            assertEquals("attempt-1", request.url.parameters["sendAttemptId"])
            assertEquals("file-1", request.url.parameters["fileIdentity"])
            assertEquals("fixture name.pdf", request.url.parameters["displayName"])
            assertEquals("application/pdf", request.url.parameters["contentType"])
            respond(
                """{"attachmentId":"att_0123456789abcdef0123456789abcdef","displayName":"fixture name.pdf","contentType":"application/pdf","mediaKind":"pdf","size":3}""",
                HttpStatusCode.Created,
                headersOf(HttpHeaders.ContentType, "application/json"),
            )
        }
        val client = AttachmentsHttpClient(HttpClient(engine), "wss://example.test/api/v1/ws", { "token" })
        val ref = client.upload(
            sendAttemptId = "attempt-1",
            fileIdentity = "file-1",
            displayName = "fixture name.pdf",
            contentType = "application/pdf",
            body = object : AttachmentUploadBody {
                override val size = 3L
                override suspend fun writeTo(channel: ByteWriteChannel) = Unit
            },
        )
        assertEquals("att_0123456789abcdef0123456789abcdef", ref.attachmentId)
        client.close()
    }

    @Test
    fun timed_out_request_terminates_before_retry() = runBlocking {
        val started = CompletableDeferred<Unit>()
        val terminated = CompletableDeferred<Unit>()
        var requests = 0
        val engine = MockEngine {
            requests++
            if (requests == 1) {
                started.complete(Unit)
                try {
                    awaitCancellation()
                } finally {
                    terminated.complete(Unit)
                }
            }
            respond(
                """{"attachmentId":"att_0123456789abcdef0123456789abcdef","displayName":"fixture.txt","contentType":"text/plain","mediaKind":"text","size":3}""",
                HttpStatusCode.OK,
                headersOf(HttpHeaders.ContentType, "application/json"),
            )
        }
        val client = AttachmentsHttpClient(HttpClient(engine), "wss://example.test/api/v1/ws", { "token" }, timeoutMs = 50)
        val first = async { runCatching { uploadFixture(client) } }

        started.await()
        assertEquals("timeout", first.await().exceptionOrNull()?.let { it as AttachmentRequestException }?.code)
        withTimeout(1_000) { terminated.await() }
        assertEquals("att_0123456789abcdef0123456789abcdef", uploadFixture(client).attachmentId)
        client.close()
    }

    @Test
    fun close_terminates_active_request() = runBlocking {
        val started = CompletableDeferred<Unit>()
        val terminated = CompletableDeferred<Unit>()
        val engine = MockEngine {
            started.complete(Unit)
            try {
                awaitCancellation()
            } finally {
                terminated.complete(Unit)
            }
        }
        val client = AttachmentsHttpClient(HttpClient(engine), "wss://example.test/api/v1/ws", { "token" }, timeoutMs = 10_000)
        val request = async { runCatching { uploadFixture(client) } }

        started.await()
        client.close()
        withTimeout(1_000) { terminated.await() }
        withTimeout(1_000) { request.await() }
        Unit
    }

    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    @Test
    fun preview_and_delete_cancel_at_small_request_deadline_while_upload_stays_active() = runTest {
        val previewStarted = CompletableDeferred<Unit>()
        val previewTerminated = CompletableDeferred<Unit>()
        val deleteStarted = CompletableDeferred<Unit>()
        val deleteTerminated = CompletableDeferred<Unit>()
        val uploadStarted = CompletableDeferred<Unit>()
        val uploadTerminated = CompletableDeferred<Unit>()
        val engine = MockEngine { request ->
            val (started, terminated) = when {
                request.url.encodedPath.endsWith("/preview") -> previewStarted to previewTerminated
                request.method.value == "DELETE" -> deleteStarted to deleteTerminated
                else -> uploadStarted to uploadTerminated
            }
            started.complete(Unit)
            try {
                awaitCancellation()
            } finally {
                terminated.complete(Unit)
            }
        }
        val client = AttachmentsHttpClient(
            HttpClient(engine),
            "wss://example.test/api/v1/ws",
            { "token" },
            timeoutMs = 15 * 60_000L,
        )
        val preview = async { runCatching { client.preview("preview") } }
        val delete = async { runCatching { client.delete("delete") } }
        val upload = async { runCatching { uploadFixture(client) } }
        previewStarted.await()
        deleteStarted.await()
        uploadStarted.await()

        advanceTimeBy(30_000)
        runCurrent()

        assertEquals("timeout", (preview.await().exceptionOrNull() as AttachmentRequestException).code)
        assertEquals("timeout", (delete.await().exceptionOrNull() as AttachmentRequestException).code)
        assertTrue(previewTerminated.isCompleted)
        assertTrue(deleteTerminated.isCompleted)
        assertFalse(upload.isCompleted)
        assertFalse(uploadTerminated.isCompleted)
        upload.cancel()
        upload.join()
        client.close()
    }

    @Test
    fun preview_is_authenticated_bounded_and_uses_preview_route() = runBlocking {
        val png = byteArrayOf(1, 2, 3, 4)
        val engine = MockEngine { request ->
            assertEquals("Bearer token", request.headers[HttpHeaders.Authorization])
            assertEquals("/api/v1/attachments/att/preview", request.url.encodedPath)
            respond(png, HttpStatusCode.OK, headersOf(HttpHeaders.ContentLength, png.size.toString()))
        }
        val client = AttachmentsHttpClient(HttpClient(engine), "wss://example.test/api/v1/ws", { "token" })
        assertContentEquals(png, client.preview("att", maxBytes = png.size))
        client.close()
    }

    @Test
    fun preview_rejects_response_over_byte_cap() = runBlocking {
        val engine = MockEngine { respond(ByteArray(5), HttpStatusCode.OK) }
        val client = AttachmentsHttpClient(HttpClient(engine), "wss://example.test/api/v1/ws", { "token" })
        assertEquals(
            "preview_too_large",
            assertFailsWith<AttachmentRequestException> { client.preview("att", maxBytes = 4) }.code,
        )
        client.close()
    }

    private suspend fun uploadFixture(client: AttachmentsHttpClient) = client.upload(
        sendAttemptId = "attempt-1",
        fileIdentity = "file-1",
        displayName = "fixture.txt",
        contentType = "text/plain",
        body = object : AttachmentUploadBody {
            override val size = 3L
            override suspend fun writeTo(channel: ByteWriteChannel) = Unit
        },
    )

    @Test
    fun original_download_streams_into_caller_owned_sink() = runBlocking {
        val original = ByteArray(130_000) { (it % 251).toByte() }
        val engine = MockEngine { respond(original, HttpStatusCode.OK) }
        val client = AttachmentsHttpClient(HttpClient(engine), "wss://example.test/api/v1/ws", { "token" })
        val chunks = mutableListOf<ByteArray>()
        client.download("att", object : AttachmentDownloadSink {
            override suspend fun write(bytes: ByteArray) { chunks += bytes }
        })
        assertContentEquals(original, chunks.fold(ByteArray(0)) { all, chunk -> all + chunk })
        assertTrue(chunks.size > 1)
        client.close()
    }
}
