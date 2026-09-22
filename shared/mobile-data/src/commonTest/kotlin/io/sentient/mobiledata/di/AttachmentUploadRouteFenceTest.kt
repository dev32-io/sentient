package io.sentient.mobiledata.di

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import io.sentient.mobiledata.draft.NativeDeleteIntent
import io.sentient.mobiledata.draft.NativeDraft
import io.sentient.mobiledata.draft.NativeDraftAttachment
import io.sentient.mobiledata.draft.NativeDraftAttachmentImport
import io.sentient.mobiledata.draft.NativeDraftCoordinator
import io.sentient.mobiledata.draft.NativeDraftSnapshot
import io.sentient.mobiledata.draft.NativeDraftStore
import io.sentient.mobiledata.draft.NativeDraftWrite
import io.sentient.mobiledata.draft.NativePendingSend
import io.sentient.mobiledata.draft.NativeSendReconciliation
import io.sentient.mobiledata.draft.NativeSendAnchorUnavailableException
import io.sentient.mobiledata.draft.NativeSendReconciliationResult
import io.sentient.mobiledata.outbox.OutboundCache
import io.sentient.mobilesdk.attachments.AttachmentRequestException
import io.sentient.mobilesdk.attachments.AttachmentUploadBody
import io.sentient.mobilesdk.attachments.AttachmentsHttpClient
import io.sentient.mobilesdk.sdk.PlatformBundle
import io.sentient.mobilesdk.sdk.SdkConfig
import io.sentient.mobilesdk.sdk.SentientSdk
import io.sentient.mobilesdk.secure.DeviceIdStore
import io.sentient.mobilesdk.secure.SecureTokenStore
import io.sentient.mobilesdk.transport.WebSocketEngine
import io.sentient.mobilesdk.transport.WebSocketSession
import io.sentient.mobilesdk.util.Clock
import io.ktor.utils.io.ByteWriteChannel
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertSame
import kotlin.test.assertTrue

class AttachmentUploadRouteFenceTest {
    @Test
    fun offline_anchor_wait_is_bounded_without_blocking_draft_restore() = runBlocking {
        val http = AttachmentsHttpClient(
            HttpClient(MockEngine { error("request must not start") }),
            "wss://test/api/v1/ws",
            { "token" },
        )
        val coordinator = NativeDraftCoordinator(PendingStore(null)).also { it.restore() }
        val component = component(http, coordinator)
        val cache = OutboundCache()
        component.bindChatRoute(cache, null)
        val generation = component.outboundRouteGeneration.value

        val anchor = async {
            try {
                component.awaitDraftSendAnchor(generation)
                null
            } catch (failure: Throwable) {
                failure
            }
        }
        val restore = async { coordinator.restore() }
        withTimeout(500) { restore.await() }
        val failure = withTimeout(4_000) { anchor.await() }

        assertTrue(failure is NativeSendAnchorUnavailableException)
        component.close()
    }

    @Test
    fun remote_delete_mid_upload_retains_idempotent_staging_and_returns_no_refs() = runBlocking {
        val started = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        var deletes = 0
        val http = AttachmentsHttpClient(
            HttpClient(MockEngine { request ->
                when (request.method.value) {
                    "POST" -> {
                        started.complete(Unit)
                        release.await()
                        respond(
                            """{"attachmentId":"att_0123456789abcdef0123456789abcdef","displayName":"fixture.txt","contentType":"text/plain","mediaKind":"text","size":3}""",
                            HttpStatusCode.Created,
                            headersOf(HttpHeaders.ContentType, "application/json"),
                        )
                    }
                    "DELETE" -> {
                        deletes++
                        respond("", HttpStatusCode.NoContent)
                    }
                    else -> error("unexpected request")
                }
            }),
            "wss://test/api/v1/ws",
            { "token" },
        )
        val pending = NativePendingSend(
            pendingId = "pending", mintKey = "d_0123456789abcdef0123456789abcdef", surfaceId = "device", // gitleaks:allow — synthetic draft/session handle, not an authentication secret
            draftId = "11111111-1111-4111-8111-111111111111", draftRevision = 1, sessionId = "session",
            text = "fixture", attachments = listOf(NativeDraftAttachment("file", "fixture.txt", "text/plain", 3, "/fixture")),
            createdAt = 1,
        )
        val store = PendingStore(pending)
        val coordinator = NativeDraftCoordinator(store)
        coordinator.restore()
        val component = component(http, coordinator)

        val upload = async { component.uploadPendingAttachments(pending, null) { _, _, _ -> } }
        started.await()
        coordinator.detachDeletedSession("session")
        release.complete(Unit)

        assertFailsWith<CancellationException> { upload.await() }
        assertEquals(0, deletes)
        component.close()
    }

    @Test
    fun cancelled_attempt_cannot_delete_refs_reused_by_retry() = runBlocking {
        val blockedAttempt = CompletableDeferred<Unit>()
        val releaseBlockedAttempt = CompletableDeferred<Unit>()
        val retryReusedFirstRef = CompletableDeferred<Unit>()
        val releaseRetryAdmission = CompletableDeferred<Unit>()
        var firstFileRequests = 0
        var secondFileRequests = 0
        var deletes = 0
        val firstRef = "att_0123456789abcdef0123456789abcdef"
        val secondRef = "att_fedcba9876543210fedcba9876543210"
        fun ref(id: String, name: String) =
            """{"attachmentId":"$id","displayName":"$name","contentType":"text/plain","mediaKind":"text","size":3}"""
        val http = AttachmentsHttpClient(
            HttpClient(MockEngine { request ->
                when (request.method.value) {
                    "DELETE" -> {
                        deletes++
                        respond("", HttpStatusCode.NoContent)
                    }
                    "POST" -> when (request.url.parameters["fileIdentity"]) {
                        "file-1" -> {
                            firstFileRequests++
                            if (firstFileRequests == 2) retryReusedFirstRef.complete(Unit)
                            respond(ref(firstRef, "one.txt"), HttpStatusCode.OK, headersOf(HttpHeaders.ContentType, "application/json"))
                        }
                        "file-2" -> {
                            secondFileRequests++
                            if (secondFileRequests == 1) {
                                blockedAttempt.complete(Unit)
                                withContext(NonCancellable) { releaseBlockedAttempt.await() }
                                respond("""{"error":"unavailable"}""", HttpStatusCode.ServiceUnavailable)
                            } else {
                                releaseRetryAdmission.await()
                                respond(ref(secondRef, "two.txt"), HttpStatusCode.OK, headersOf(HttpHeaders.ContentType, "application/json"))
                            }
                        }
                        else -> error("unexpected file")
                    }
                    else -> error("unexpected request")
                }
            }),
            "wss://test/api/v1/ws", { "token" },
        )
        val pending = pending().copy(
            attachments = listOf(
                NativeDraftAttachment("file-1", "one.txt", "text/plain", 3, "/one"),
                NativeDraftAttachment("file-2", "two.txt", "text/plain", 3, "/two"),
            ),
        )
        val coordinator = NativeDraftCoordinator(PendingStore(pending)).also { it.restore() }
        val component = component(http, coordinator)

        val oldAttempt = async { component.uploadPendingAttachments(pending, null) { _, _, _ -> } }
        blockedAttempt.await()
        oldAttempt.cancel()
        val retry = async { component.uploadPendingAttachments(pending, null) { _, _, _ -> } }
        retryReusedFirstRef.await()
        releaseBlockedAttempt.complete(Unit)
        assertFailsWith<CancellationException> { oldAttempt.await() }
        assertEquals(0, deletes)
        releaseRetryAdmission.complete(Unit)

        assertEquals(listOf(firstRef, secondRef), retry.await().map { it.attachmentId })
        assertEquals(0, deletes)
        component.close()
    }

    @Test
    fun unreadable_local_file_settles_as_typed_upload_failure() = runBlocking {
        val pending = pending()
        val coordinator = NativeDraftCoordinator(PendingStore(pending)).also { it.restore() }
        val http = AttachmentsHttpClient(
            HttpClient(MockEngine { error("request must not start") }),
            "wss://test/api/v1/ws",
            { "token" },
        )
        val component = component(http, coordinator) { error("file unavailable") }

        val failure = assertFailsWith<AttachmentRequestException> {
            component.uploadPendingAttachments(pending, null) { _, _, _ -> }
        }

        assertEquals("local_file_error", failure.code)
        component.close()
    }

    @Test
    fun unreadable_local_file_settles_cancel_as_typed_failure_without_unfreezing() = runBlocking {
        var requests = 0
        val pending = pending()
        val store = PendingStore(pending)
        val coordinator = NativeDraftCoordinator(store).also { it.restore() }
        val http = AttachmentsHttpClient(
            HttpClient(MockEngine {
                requests++
                error("request must not start")
            }),
            "wss://test/api/v1/ws",
            { "token" },
        )
        val component = component(http, coordinator) { error("file unavailable") }

        val failure = assertFailsWith<AttachmentRequestException> { component.cancelPendingSend(pending) }

        assertEquals("local_file_error", failure.code)
        assertEquals(0, requests)
        assertEquals(null, store.reconciliation)
        assertEquals(listOf(pending), coordinator.snapshot.value.pendingSends)
        component.close()
    }

    @Test
    fun attachment_exports_preserve_request_failures_and_map_local_failures() = runBlocking {
        val remote = AttachmentRequestException(404, "not_found")
        val http = AttachmentsHttpClient(
            HttpClient(MockEngine { throw remote }),
            "wss://test/api/v1/ws",
            { "token" },
        )
        val draftStore = PendingStore(null) { _, _ -> error("missing local file") }
        val coordinator = NativeDraftCoordinator(draftStore).also { it.restore() }
        val component = component(http, coordinator, download = { _, _ -> error("destination unavailable") })

        assertSame(
            remote,
            assertFailsWith<AttachmentRequestException> {
                component.previewAttachment("att_0123456789abcdef0123456789abcdef")
            },
        )
        assertEquals(
            "local_file_error",
            assertFailsWith<AttachmentRequestException> {
                component.previewDraftAttachment("22222222-2222-4222-8222-222222222222", 640)
            }.code,
        )
        assertEquals(
            "local_file_error",
            assertFailsWith<AttachmentRequestException> { component.downloadAttachment("attachment", "file") }.code,
        )
        component.close()
    }

    @Test
    fun attachment_exports_preserve_cancellation() = runBlocking {
        val remoteCancellation = CancellationException("remote preview cancelled")
        val draftCancellation = CancellationException("draft preview cancelled")
        val downloadCancellation = CancellationException("download cancelled")
        val http = AttachmentsHttpClient(
            HttpClient(MockEngine { throw remoteCancellation }),
            "wss://test/api/v1/ws",
            { "token" },
        )
        val coordinator = NativeDraftCoordinator(PendingStore(null) { _, _ -> throw draftCancellation })
            .also { it.restore() }
        val component = component(http, coordinator, download = { _, _ -> throw downloadCancellation })

        assertEquals(
            remoteCancellation.message,
            assertFailsWith<CancellationException> {
                component.previewAttachment("att_0123456789abcdef0123456789abcdef")
            }.message,
        )
        assertSame(
            draftCancellation,
            assertFailsWith<CancellationException> {
                component.previewDraftAttachment("22222222-2222-4222-8222-222222222222", 640)
            },
        )
        assertSame(
            downloadCancellation,
            assertFailsWith<CancellationException> { component.downloadAttachment("attachment", "file") },
        )
        component.close()
    }

    @Test
    fun existing_session_pending_binds_session_route_not_fresh_mint_recovery() = runBlocking {
        val pending = pending()
        val coordinator = NativeDraftCoordinator(PendingStore(pending)).also { it.restore() }
        val http = AttachmentsHttpClient(
            HttpClient(MockEngine { error("request must not start") }),
            "wss://test/api/v1/ws",
            { "token" },
        )
        val component = component(http, coordinator)
        val cache = OutboundCache()

        component.bindChatRoute(cache, pending.sessionId, pending.draftId)

        assertNull(component.currentSessionId.value, "existing session must not be treated as a draft mint key")
        assertEquals(component.outboundRouteGeneration.value, cache.routeGeneration)
        component.close()
    }

    @Test
    fun staged_delete_fence_thaws_confirmed_uncommitted_attempt() = runBlocking {
        var deletes = 0
        val http = AttachmentsHttpClient(
            HttpClient(MockEngine { request ->
                if (request.method.value == "DELETE") {
                    deletes++
                    respond("", HttpStatusCode.NoContent)
                } else {
                    respond(
                        """{"attachmentId":"att_0123456789abcdef0123456789abcdef","displayName":"fixture.txt","contentType":"text/plain","mediaKind":"text","size":3}""",
                        HttpStatusCode.OK,
                        headersOf(HttpHeaders.ContentType, "application/json"),
                    )
                }
            }),
            "wss://test/api/v1/ws", { "token" },
        )
        val pending = pending()
        val store = PendingStore(pending)
        val coordinator = NativeDraftCoordinator(store)
        coordinator.restore()
        val component = component(http, coordinator)

        assertEquals(pending.draftId, component.cancelPendingSend(pending).id)
        assertEquals(1, deletes)
        assertEquals(NativeSendReconciliation.NOT_COMMITTED, store.reconciliation)
        assertEquals(0, coordinator.snapshot.value.pendingSends.size)
        component.close()
    }

    @Test
    fun committed_or_ambiguous_attempt_stays_frozen_when_delete_cannot_confirm() = runBlocking {
        val http = AttachmentsHttpClient(
            HttpClient(MockEngine { request ->
                if (request.method.value == "DELETE") respond("""{"error":"not_found"}""", HttpStatusCode.NotFound)
                else respond(
                    """{"attachmentId":"att_0123456789abcdef0123456789abcdef","displayName":"fixture.txt","contentType":"text/plain","mediaKind":"text","size":3}""",
                    HttpStatusCode.OK,
                    headersOf(HttpHeaders.ContentType, "application/json"),
                )
            }),
            "wss://test/api/v1/ws", { "token" },
        )
        val pending = pending()
        val store = PendingStore(pending)
        val coordinator = NativeDraftCoordinator(store)
        coordinator.restore()
        val component = component(http, coordinator)

        assertFailsWith<AttachmentRequestException> { component.cancelPendingSend(pending) }
        assertEquals(null, store.reconciliation)
        assertEquals(listOf(pending), coordinator.snapshot.value.pendingSends)
        component.close()
    }

    private fun pending() = NativePendingSend(
        pendingId = "pending", mintKey = "d_0123456789abcdef0123456789abcdef", surfaceId = "device", // gitleaks:allow — synthetic draft/session handle, not an authentication secret
        draftId = "11111111-1111-4111-8111-111111111111", draftRevision = 1, sessionId = "session",
        text = "fixture", attachments = listOf(NativeDraftAttachment("file", "fixture.txt", "text/plain", 3, "/fixture")),
        createdAt = 1,
    )

    private fun component(
        http: AttachmentsHttpClient,
        coordinator: NativeDraftCoordinator,
        download: suspend (String, String) -> String = { _, _ -> error("unused") },
        body: (String) -> AttachmentUploadBody = { object : AttachmentUploadBody {
            override val size = 3L
            override suspend fun writeTo(channel: ByteWriteChannel) = Unit
        } },
    ): ChatComponent {
        val sdk = SentientSdk(
            SdkConfig("wss://test/api/v1/ws", false, emptyList()),
            PlatformBundle(
                engine = object : WebSocketEngine {
                    override suspend fun open(url: String, allowSelfSignedDevHost: Boolean): WebSocketSession =
                        object : WebSocketSession {
                            override val incoming = emptyFlow<io.sentient.mobilesdk.transport.WsIncoming>()
                            override suspend fun sendText(text: String) = Unit
                            override suspend fun sendBinary(bytes: ByteArray) = Unit
                            override suspend fun close(code: Int, reason: String) = Unit
                        }
                },
                tokenStore = object : SecureTokenStore {
                    override fun load() = "token"
                    override fun save(token: String) = Unit
                    override fun clear() = Unit
                },
                deviceIdStore = object : DeviceIdStore {
                    override fun load() = "device"
                    override fun save(id: String) = Unit
                },
                clock = Clock { 0 },
            ),
            CoroutineScope(SupervisorJob() + Dispatchers.Default),
        )
        return ChatComponent(
            sdk = sdk,
            drafts = coordinator,
            attachments = http,
            attachmentBody = body,
            attachmentDownload = download,
        )
    }
}

private class PendingStore(
    private var pending: NativePendingSend?,
    private val preview: suspend (String, Int) -> ByteArray? = { _, _ -> error("unused") },
) : NativeDraftStore {
    var reconciliation: NativeSendReconciliation? = null
    override suspend fun list() = NativeDraftSnapshot(emptyList(), listOfNotNull(pending), emptyList())
    override suspend fun detachDeletedSession(sessionId: String) { pending = null }
    override suspend fun save(write: NativeDraftWrite, expectedRevision: Long?): NativeDraft = error("unused")
    override suspend fun importAttachment(draftId: String, expectedRevision: Long, source: NativeDraftAttachmentImport): NativeDraft = error("unused")
    override suspend fun remove(draftId: String, expectedRevision: Long) = error("unused")
    override suspend fun previewAttachment(attachmentId: String, maxPixelSize: Int): ByteArray? =
        preview(attachmentId, maxPixelSize)
    override suspend fun beginSend(draftId: String, expectedRevision: Long, mintKey: String, surfaceId: String): NativePendingSend = error("unused")
    override suspend fun reconcileSend(
        pendingId: String,
        result: NativeSendReconciliation,
        acknowledgedSessionId: String?,
    ): NativeSendReconciliationResult {
        reconciliation = result
        val current = pending
        val found = current?.pendingId == pendingId
        if (found) pending = null
        val restored = current?.let {
            NativeDraft(it.draftId, it.sessionId, it.text, it.attachments, it.draftRevision, it.createdAt, it.createdAt)
        }
        return NativeSendReconciliationResult(
            found = found,
            restoredDraft = restored.takeIf { result == NativeSendReconciliation.NOT_COMMITTED },
        )
    }
    override suspend fun saveDeleteIntent(sessionId: String, failureCode: String?): NativeDeleteIntent = error("unused")
    override suspend fun removeDeleteIntent(sessionId: String) = error("unused")
}
