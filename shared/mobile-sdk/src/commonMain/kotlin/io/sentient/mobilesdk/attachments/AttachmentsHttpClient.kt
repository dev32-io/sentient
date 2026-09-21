package io.sentient.mobilesdk.attachments

import io.ktor.client.HttpClient
import io.ktor.client.plugins.onUpload
import io.ktor.client.request.delete
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsChannel
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.content.OutgoingContent
import io.ktor.http.encodeURLQueryComponent
import io.ktor.http.isSuccess
import io.ktor.utils.io.ByteWriteChannel
import io.ktor.utils.io.readAvailable
import io.sentient.mobilesdk.auth.deriveBaseUrl
import io.sentient.mobilesdk.protocol.WireJson
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.cancel
import kotlinx.coroutines.withTimeoutOrNull

private const val SMALL_REQUEST_TIMEOUT_MS = 30_000L

interface AttachmentUploadBody {
    val size: Long
    suspend fun writeTo(channel: ByteWriteChannel)
}

interface AttachmentDownloadSink {
    suspend fun write(bytes: ByteArray)
}

class AttachmentRequestException(val status: Int, val code: String) : Exception(code)

class AttachmentsHttpClient(
    private val httpClient: HttpClient,
    gatewayWsUrl: String,
    private val token: () -> String,
    private val timeoutMs: Long = 15 * 60_000L,
) {
    private val baseUrl = deriveBaseUrl(gatewayWsUrl)

    suspend fun upload(
        sendAttemptId: String,
        fileIdentity: String,
        displayName: String,
        contentType: String,
        body: AttachmentUploadBody,
        onProgress: (Long, Long) -> Unit = { _, _ -> },
    ): AttachmentRef = bounded {
        val query = listOf(
            "sendAttemptId" to sendAttemptId,
            "fileIdentity" to fileIdentity,
            "displayName" to displayName,
            "contentType" to contentType,
        ).joinToString("&") { (key, value) -> "$key=${value.encodeURLQueryComponent()}" }
        val response = httpClient.post("$baseUrl/attachments?$query") {
            header(HttpHeaders.Authorization, "Bearer ${token()}")
            header(HttpHeaders.ContentType, contentType)
            setBody(object : OutgoingContent.WriteChannelContent() {
                override val contentType: ContentType? = ContentType.parse(contentType)
                override val contentLength: Long = body.size
                override suspend fun writeTo(channel: ByteWriteChannel) = body.writeTo(channel)
            })
            onUpload { sent, total -> onProgress(sent, total ?: body.size) }
        }
        if (!response.status.isSuccess()) throw responseError(response.status.value, response.bodyAsText())
        try {
            WireJson.instance.decodeFromString(AttachmentRef.serializer(), response.bodyAsText())
        } catch (_: Throwable) {
            throw AttachmentRequestException(response.status.value, "invalid_response")
        }
    }

    suspend fun preview(attachmentId: String, maxBytes: Int = 5 * 1024 * 1024): ByteArray = bounded(minOf(timeoutMs, SMALL_REQUEST_TIMEOUT_MS)) {
        require(maxBytes > 0)
        val response = authenticatedGet("${itemUrl(attachmentId)}/preview")
        val declared = response.headers[HttpHeaders.ContentLength]?.toLongOrNull()
        if (declared != null && declared > maxBytes) throw AttachmentRequestException(0, "preview_too_large")
        val chunks = mutableListOf<ByteArray>()
        var size = 0
        val channel = response.bodyAsChannel()
        while (!channel.isClosedForRead) {
            val buffer = ByteArray(minOf(8192, maxBytes - size + 1))
            val read = channel.readAvailable(buffer)
            if (read < 0) break
            size += read
            if (size > maxBytes) {
                channel.cancel(null)
                throw AttachmentRequestException(0, "preview_too_large")
            }
            chunks += buffer.copyOf(read)
        }
        ByteArray(size).also { output ->
            var offset = 0
            chunks.forEach { chunk -> chunk.copyInto(output, offset).also { offset += chunk.size } }
        }
    }

    suspend fun download(attachmentId: String, sink: AttachmentDownloadSink) = bounded {
        val response = authenticatedGet(itemUrl(attachmentId))
        val channel = response.bodyAsChannel()
        val buffer = ByteArray(64 * 1024)
        while (!channel.isClosedForRead) {
            val read = channel.readAvailable(buffer)
            if (read < 0) break
            if (read > 0) sink.write(buffer.copyOf(read))
        }
    }

    suspend fun delete(attachmentId: String) = bounded(minOf(timeoutMs, SMALL_REQUEST_TIMEOUT_MS)) {
        val response = httpClient.delete(itemUrl(attachmentId)) {
            header(HttpHeaders.Authorization, "Bearer ${token()}")
        }
        if (!response.status.isSuccess()) throw responseError(response.status.value, response.bodyAsText())
    }

    fun close() {
        httpClient.coroutineContext.cancel()
        httpClient.close()
    }

    private fun itemUrl(id: String) = "$baseUrl/attachments/${id.encodeURLQueryComponent()}"

    private suspend fun authenticatedGet(url: String) = httpClient.get(url) {
        header(HttpHeaders.Authorization, "Bearer ${token()}")
    }.also { response ->
        if (!response.status.isSuccess()) throw responseError(response.status.value, response.bodyAsText())
    }

    private suspend fun <T> bounded(deadlineMs: Long = timeoutMs, block: suspend () -> T): T = try {
        withTimeoutOrNull(deadlineMs) { block() } ?: throw AttachmentRequestException(0, "timeout")
    } catch (cancelled: CancellationException) {
        throw cancelled
    } catch (failure: AttachmentRequestException) {
        throw failure
    } catch (_: Throwable) {
        throw AttachmentRequestException(0, "network_error")
    }

    private fun responseError(status: Int, body: String): AttachmentRequestException {
        val code = Regex("\\\"error\\\"\\s*:\\s*\\\"([^\\\"]+)\\\"").find(body)?.groupValues?.get(1)
            ?: "unknown_error"
        return AttachmentRequestException(status, code)
    }
}
