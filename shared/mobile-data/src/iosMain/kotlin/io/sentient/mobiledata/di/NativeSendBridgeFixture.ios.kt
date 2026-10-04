@file:OptIn(io.ktor.utils.io.InternalAPI::class)

package io.sentient.mobiledata.di

import io.ktor.client.HttpClient
import io.ktor.client.engine.HttpClientEngineBase
import io.ktor.client.engine.HttpClientEngineConfig
import io.ktor.client.engine.callContext
import io.ktor.client.request.HttpRequestData
import io.ktor.client.request.HttpResponseData
import io.ktor.http.*
import io.ktor.util.date.GMTDate
import io.ktor.utils.io.ByteReadChannel
import io.sentient.mobiledata.draft.*
import io.sentient.mobilesdk.attachments.AttachmentsHttpClient
import io.sentient.mobilesdk.sdk.*
import io.sentient.mobilesdk.secure.DeviceIdStore
import io.sentient.mobilesdk.secure.SecureTokenStore
import io.sentient.mobilesdk.transport.*
import io.sentient.mobilesdk.util.Clock
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.*
import kotlinx.serialization.json.*

/** Explicit native test construction only. No platform transport, credentials, audio or service I/O.
 * Like the other iOS bridge probes this is exported for XCTest, never used by app composition.
 * All mutable transport controls run on Main; every held boundary has a deadline.
 */
class NativeSendBridgeFixture {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private val socket = FixtureSocket()
    private val driver = IosNativeDraftDatabaseDriverFactory().create()
    private val store = createNativeDraftStore(
        driver, IosNativeDraftFileStore(),
        NativeDraftScope("native-send-${platform.Foundation.NSUUID().UUIDString}", "https://fixture.invalid"),
    )
    private var heldList: CompletableDeferred<Unit>? = null
    val drafts = NativeDraftCoordinator(object : NativeDraftStore by store {
        override suspend fun list(): NativeDraftSnapshot {
            heldList?.await()
            return store.list()
        }
    }, driver)

    /** Deterministic mutex schedule at the injected store boundary; real SQL/files remain in use. */
    suspend fun retireMutexDelayedImport(draftId: String, source: NativeDraftAttachmentImport): Boolean =
        withContext(Dispatchers.Main) {
            withTimeout(5_000) {
                coroutineScope {
                    val release = CompletableDeferred<Unit>()
                    heldList = release
                    val blocker = async(start = CoroutineStart.UNDISPATCHED) { drafts.restore() }
                    val successor = async(start = CoroutineStart.UNDISPATCHED) {
                        drafts.saveEditorText("successor", draftId, "history-session", "B")
                    }
                    val oldImport = async(start = CoroutineStart.UNDISPATCHED) {
                        try {
                            drafts.importEditorAttachment("retired-import", draftId, "history-session", source)
                            false
                        } catch (_: CancellationException) { true }
                    }
                    drafts.retireEditor("retired-import")
                    heldList = null
                    release.complete(Unit)
                    blocker.await()
                    successor.await()
                    oldImport.await()
                }
            }
        }
    private val sdk = SentientSdk(
        SdkConfig("wss://fixture.invalid/api/v1/ws", false, capabilities = emptyList()),
        PlatformBundle(object : WebSocketEngine {
            override suspend fun open(url: String, allowSelfSignedDevHost: Boolean): WebSocketSession = socket
        }, object : SecureTokenStore {
            override fun load() = "fixture-token"
            override fun save(token: String) {}
            override fun clear() {}
        }, object : DeviceIdStore {
            override fun load() = "fixture-device"
            override fun save(id: String) {}
        }, Clock { 1L }), scope,
    )
    private val uploads = mutableListOf<CompletableDeferred<Boolean>>()
    private val uploadIds = mutableListOf<String>()
    private var acknowledgedCommandCount = 0
    private val engine = object : HttpClientEngineBase("native-send-fixture") {
        override val config = HttpClientEngineConfig()
        override val dispatcher = Dispatchers.Main
        override suspend fun execute(data: HttpRequestData): HttpResponseData = withContext(Dispatchers.Main) {
            check(data.method == HttpMethod.Post && data.url.encodedPath.endsWith("/attachments"))
            val query = data.url.parameters
            val fileId = requireNotNull(query["fileIdentity"])
            val release = CompletableDeferred<Boolean>()
            uploads += release
            uploadIds += fileId
            // Deliberately non-cooperative adapter completion exercises late-result fences.
            // Public XCUITest actions need accessibility IPC time; still bounded and synthetic-only.
            val success = withContext(NonCancellable) { withTimeout(20_000) { release.await() } }
            val body = if (success) buildJsonObject {
                put("attachmentId", "att_" + fileId.replace("-", ""))
                put("displayName", requireNotNull(query["displayName"]))
                put("contentType", requireNotNull(query["contentType"]))
                put("mediaKind", "file")
                put("size", data.body.contentLength ?: 0L)
            }.toString() else "{}"
            HttpResponseData(if (success) HttpStatusCode.Created else HttpStatusCode.InternalServerError,
                GMTDate(), headersOf(HttpHeaders.ContentType, "application/json"),
                HttpProtocolVersion.HTTP_1_1, ByteReadChannel(body), callContext())
        }
    }
    val component = ChatComponent(sdk, drafts = drafts,
        attachments = AttachmentsHttpClient(HttpClient(engine), "wss://fixture.invalid/api/v1/ws", { "fixture-token" }),
        attachmentBody = ::IosAttachmentUploadBody)

    suspend fun connect() = withContext(Dispatchers.Main) {
        withTimeout(5_000) {
            val connecting = scope.launch { sdk.connect() }
            sdk.connection.first { it.status == SdkStatus.AUTHENTICATING }
            socket.frame("""{"type":"auth.ok","user":{"userId":"fixture","displayName":"Fixture"}}""")
            socket.frame("""{"type":"session.ready","sessionId":"connection","audioEncoding":"pcm","inputSampleRate":16000,"outputSampleRate":24000}""")
            sdk.connection.first { it.status == SdkStatus.READY }
            connecting.join()
        }
    }

    /** Wait for actual binder command before issuing server attachment + switch acknowledgment. */
    suspend fun acknowledgeRoute(sessionId: String) = withContext(Dispatchers.Main) {
        withTimeout(5_000) {
            val commands = socket.sent.first { frames -> frames.drop(acknowledgedCommandCount).any {
                it["type"]?.jsonPrimitive?.content == "conversation.activate" &&
                    it["sessionId"]?.jsonPrimitive?.content == sessionId
            } }
            acknowledgedCommandCount = commands.size
            socket.frame("""{"type":"session.attached","sessionId":"$sessionId","generation":$acknowledgedCommandCount}""")
            socket.frame("""{"type":"session.switched","sessionId":"$sessionId","ts":1}""")
            sdk.acknowledgedRoute.first { it?.sessionId == sessionId }
        }
    }

    suspend fun freshRequestCount(): Int = withContext(Dispatchers.Main) {
        socket.sent.value.count { it["type"]?.jsonPrimitive?.content == "session.new" }
    }

    suspend fun activatedSessionIds(): List<String> = withContext(Dispatchers.Main) {
        socket.sent.value.filter { it["type"]?.jsonPrimitive?.content == "conversation.activate" }
            .map { it.getValue("sessionId").jsonPrimitive.content }
    }

    suspend fun acknowledgeDraft(draftKey: String) = withContext(Dispatchers.Main) {
        withTimeout(5_000) {
            val commands = socket.sent.first { frames -> frames.drop(acknowledgedCommandCount).any {
                it["type"]?.jsonPrimitive?.content == "session.new"
            } }
            val requestId = commands.last { it["type"]?.jsonPrimitive?.content == "session.new" }
                .getValue("requestId").jsonPrimitive.content
            acknowledgedCommandCount = commands.size
            socket.frame("""{"type":"session.draft","requestId":"$requestId","draftKey":"$draftKey","ts":1}""")
            sdk.acknowledgedRoute.first { it?.sessionId == draftKey }
        }
    }

    suspend fun mint(sessionId: String) = withContext(Dispatchers.Main) {
        withTimeout(5_000) {
            socket.frame("""{"type":"session.attached","sessionId":"$sessionId","generation":10}""")
            socket.frame("""{"type":"session.created","sessionId":"$sessionId","ts":2}""")
            sdk.acknowledgedRoute.first { it?.sessionId == sessionId }
        }
    }

    suspend fun rejectRoute(sessionId: String) = withContext(Dispatchers.Main) {
        withTimeout(5_000) {
            val commands = socket.sent.first { frames -> frames.drop(acknowledgedCommandCount).any {
                it["type"]?.jsonPrimitive?.content == "conversation.activate" &&
                    it["sessionId"]?.jsonPrimitive?.content == sessionId
            } }
            acknowledgedCommandCount = commands.size
            socket.frame("""{"type":"sessions.error","code":"not_found","message":"synthetic unavailable"}""")
        }
    }

    suspend fun uploadedFileIds(): List<String> = withContext(Dispatchers.Main) { uploadIds.toList() }
    suspend fun releaseUpload(index: Int, success: Boolean) = withContext(Dispatchers.Main) {
        check(uploads[index].complete(success))
    }
    suspend fun sentPendingIds(): List<String> = withContext(Dispatchers.Main) {
        socket.sent.value.filter { it["type"]?.jsonPrimitive?.content == "text.input" }
            .map { it.getValue("pendingId").jsonPrimitive.content }
    }
    /** Bound session stamps only; a draft's first text.input is intentionally unbound. */
    suspend fun sentSessionIds(): List<String> = withContext(Dispatchers.Main) {
        socket.sent.value.filter { it["type"]?.jsonPrimitive?.content == "text.input" }
            .mapNotNull { it["sessionId"]?.jsonPrimitive?.content }
    }
    suspend fun receipt(pendingId: String, sessionId: String) = withContext(Dispatchers.Main) {
        val item = buildJsonObject {
            put("kind", "user"); put("entryId", "entry-$pendingId"); put("sessionId", sessionId)
            put("pendingId", pendingId); put("ts", 2); put("channel", "text"); put("content", "fixture")
        }
        socket.frame(buildJsonObject { put("type", "conversation.entry"); put("item", item) }.toString())
    }
    suspend fun close() = withContext(Dispatchers.Main) {
        uploads.forEach { it.cancel() }
        component.close()
        engine.close() // HttpClient(engine) does not own its supplied engine.
        try {
            withTimeout(5_000) { sdk.disconnect(false) }
        } finally {
            scope.cancel()
            drafts.close()
        }
    }
}

private class FixtureSocket : WebSocketSession {
    private val frames = Channel<WsIncoming>(Channel.UNLIMITED)
    override val incoming = frames.receiveAsFlow()
    val sent = MutableStateFlow<List<JsonObject>>(emptyList())
    override suspend fun sendText(text: String) {
        val frame = Json.parseToJsonElement(text).jsonObject
        sent.value += frame
        if (frame["type"]?.jsonPrimitive?.content == "ping") frame("""{"type":"pong"}""")
    }
    override suspend fun sendBinary(bytes: ByteArray) { error("Text fixture cannot send audio") }
    override suspend fun close(code: Int, reason: String) { frames.close() }
    suspend fun frame(json: String) { frames.send(WsIncoming.Text(json)) }
}
