package io.sentient.mobiledata.di

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import io.sentient.mobilesdk.sessions.SessionsHttpClient
import kotlinx.coroutines.CompletableDeferred
import io.sentient.mobiledata.outbox.OutboundCache
import io.sentient.mobiledata.outbox.PendingDeliveryState
import io.sentient.mobilesdk.sdk.PlatformBundle
import io.sentient.mobilesdk.sdk.SdkConfig
import io.sentient.mobilesdk.sdk.SentientSdk
import io.sentient.mobilesdk.secure.DeviceIdStore
import io.sentient.mobilesdk.secure.SecureTokenStore
import io.sentient.mobilesdk.transport.SdkStatus
import io.sentient.mobilesdk.transport.WebSocketEngine
import io.sentient.mobilesdk.transport.WebSocketSession
import io.sentient.mobilesdk.transport.WsIncoming
import io.sentient.mobilesdk.util.Clock
import kotlinx.coroutines.async
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Real SDK -> ChatComponent -> VM-owned cache/collector, with socket/REST I/O faked. */
class RouteOutboxIntegrationTest {
    @Test
    fun fresh_restore_uses_semantic_identity_and_fences_stale_sibling_until_mint() = runTest {
        val fixture = RouteFixture(this)
        fixture.connect()
        val retained = OutboundCache()
        fixture.component.bindChatRoute(retained, null)
        runCurrent()
        suspend fun draft(key: String) {
            val request = fixture.socket.sent.last { it["type"]?.jsonPrimitive?.content == "session.new" }
            val id = request.getValue("requestId").jsonPrimitive.content
            fixture.socket.frame("""{"type":"session.draft","requestId":"$id","draftKey":"$key","ts":1}""")
            runCurrent()
        }
        draft("d_original")
        assertEquals("d_original", fixture.sdk.outboundSessionId.value)
        val existing = fixture.component.existingSessionId
        assertNull(existing)
        val sibling = OutboundCache()
        fixture.component.bindChatRoute(sibling, "d_original", activate = false)
        sibling.enqueue("stale", "synthetic")
        val oldGeneration = retained.routeGeneration
        val activation = async { fixture.sdk.switchSession("B") }
        runCurrent()
        fixture.socket.frame("""{"type":"session.attached","sessionId":"B","generation":1}""")
        fixture.socket.frame("""{"type":"session.switched","sessionId":"B","ts":1}""")
        activation.await()
        assertEquals("B", fixture.component.existingSessionId)
        fixture.component.restoreChatRoute(retained, existing, null)
        assertNull(fixture.component.existingSessionId, "old B acknowledgement cannot describe new route")
        assertTrue(retained.routeGeneration != oldGeneration)
        assertEquals(oldGeneration, sibling.routeGeneration)
        retained.enqueue("first", "synthetic")
        fixture.component.flushOutbound(retained)
        fixture.component.flushOutbound(sibling)
        runCurrent()
        assertTrue(fixture.socket.inputs().isEmpty())
        assertEquals(listOf("B"), fixture.socket.sent.filter {
            it["type"]?.jsonPrimitive?.content == "conversation.activate"
        }.map { it.getValue("sessionId").jsonPrimitive.content })
        draft("d_restored")
        assertNull(fixture.component.existingSessionId)
        fixture.component.flushOutbound(sibling)
        fixture.component.flushOutbound(retained)
        runCurrent()
        assertEquals(listOf("first"), fixture.socket.inputs())
        fixture.socket.frame("""{"type":"session.attached","sessionId":"minted","generation":2}""")
        runCurrent()
        assertNull(fixture.component.existingSessionId, "attachment alone does not acknowledge mint")
        fixture.socket.frame("""{"type":"session.created","sessionId":"minted","ts":2}""")
        runCurrent()
        assertEquals("minted", fixture.component.existingSessionId)
        fixture.component.flushOutbound(sibling)
        assertEquals(listOf("first"), fixture.socket.inputs())
        fixture.socket.incomingFrames.send(WsIncoming.Failure("drop"))
        fixture.sdk.connection.first { it.status == SdkStatus.RECONNECTING }
        assertNull(fixture.sdk.outboundSessionId.value)
        assertEquals("minted", fixture.component.existingSessionId, "semantic ACK survives transport loss")
    }

    @Test
    fun retained_editor_reclaims_original_route_without_borrowing_destination_or_reviving_sibling() = runTest {
        for (destination in listOf("A", "B")) {
            val fixture = RouteFixture(this)
            fixture.connect()
            val retained = OutboundCache()
            fixture.component.bindChatRoute(retained, "A")
            runCurrent()
            fixture.socket.frame("""{"type":"session.attached","sessionId":"A","generation":1}""")
            fixture.socket.frame("""{"type":"session.switched","sessionId":"A","ts":1}""")
            runCurrent()
            val sibling = OutboundCache()
            fixture.component.bindChatRoute(sibling, "A", activate = false)
            val originalGeneration = retained.routeGeneration
            retained.enqueue("retained", "synthetic")
            sibling.enqueue("stale", "synthetic")
            val activation = async { fixture.sdk.switchSession(destination) }
            runCurrent()
            if (destination == "B") {
                fixture.socket.frame("""{"type":"session.attached","sessionId":"B","generation":2}""")
                fixture.socket.frame("""{"type":"session.switched","sessionId":"B","ts":2}""")
            }
            activation.await()
            val destinationGeneration = fixture.sdk.outboundRouteGeneration.value
            fixture.component.flushOutbound(retained)
            assertTrue(fixture.socket.inputs().isEmpty())
            fixture.component.restoreChatRoute(retained, "A", null)
            assertTrue(retained.routeGeneration != originalGeneration)
            assertTrue(retained.routeGeneration != destinationGeneration)
            assertEquals(originalGeneration, sibling.routeGeneration)
            assertEquals(listOf("retained"), retained.pending.value.map { it.id })
            runCurrent()
            if (destination == "B") {
                fixture.component.flushOutbound(retained)
                assertTrue(fixture.socket.inputs().isEmpty(), "restoration must await original-route ACK")
                fixture.socket.frame("""{"type":"session.attached","sessionId":"A","generation":3}""")
                fixture.socket.frame("""{"type":"session.switched","sessionId":"A","ts":3}""")
                runCurrent()
            }
            fixture.component.flushOutbound(sibling)
            fixture.component.flushOutbound(retained)
            runCurrent()
            assertEquals(listOf("retained"), fixture.socket.inputs())
            assertEquals("A", fixture.sdk.currentSessionId.value)
            assertEquals("A", fixture.sdk.outboundSessionId.value)
            assertTrue(fixture.socket.sent.filter { it["type"]?.jsonPrimitive?.content == "text.input" }
                .all { it["sessionId"]?.jsonPrimitive?.content == "A" })
        }
    }

    @Test
    fun switch_collectors_preserve_pending_until_merged_live_or_rest_receipt_even_on_rest_failure() = runTest {
        for (historyFails in listOf(false, true)) {
            val started = CompletableDeferred<Unit>()
            val release = CompletableDeferred<Unit>()
            val rawHttp = HttpClient(MockEngine {
                started.complete(Unit)
                release.await()
                respond(
                    if (historyFails) "{}" else """{"items":[{"kind":"user","entryId":"e-rest","sessionId":"B","pendingId":"rest-only","ts":1,"channel":"text","content":"fixture"}],"total":1,"hasMore":false}""",
                    if (historyFails) HttpStatusCode.InternalServerError else HttpStatusCode.OK,
                    headersOf(HttpHeaders.ContentType, "application/json"),
                )
            })
            val http = SessionsHttpClient(rawHttp, "wss://test/api/v1/ws", { "fixture-token" })
            val fixture = RouteFixture(this, http)
            fixture.connect()
            val cache = OutboundCache()
            fixture.component.bindChatRoute(cache, "B")
            backgroundScope.launch { fixture.component.observeOutbound(cache).collect { fixture.component.flushOutbound(cache) } }
            backgroundScope.launch {
                fixture.component.observeChat.coldHistoryReplaceSignal().collect {
                    fixture.component.observeChat.onColdHistoryReplace(cache)
                }
            }
            backgroundScope.launch {
                fixture.component.observeChat(cache.pending).collect { model -> model.reconciledPendingIds.forEach(cache::remove) }
            }
            cache.enqueue("live", "fixture")
            cache.enqueue("rest-only", "fixture")
            runCurrent()
            fixture.socket.frame("""{"type":"session.attached","sessionId":"B","generation":1}""")
            fixture.socket.frame("""{"type":"session.switched","sessionId":"B","ts":1}""")
            started.await()
            runCurrent()
            assertEquals(listOf("live", "rest-only"), cache.pending.value.map { it.id })
            val receipt = """{"type":"conversation.entry","item":{"kind":"user","entryId":"e-live","sessionId":"B","pendingId":"live","ts":2,"channel":"text","content":"fixture"}}"""
            fixture.socket.frame(receipt)
            fixture.socket.frame(receipt)
            runCurrent()
            release.complete(Unit)
            fixture.sdk.timeline.first { rows -> rows.any { it.pendingId == "live" } }
            runCurrent()
            assertEquals(1, fixture.sdk.timeline.value.count { it.pendingId == "live" })
            assertEquals(if (historyFails) listOf("rest-only") else emptyList(), cache.pending.value.map { it.id })
            rawHttp.close()
        }
    }

    @Test
    fun lost_mint_completion_resolves_draft_on_configure_and_resends_once() = runTest {
        // A drop can precede attached too, or lose only the following created frame.
        for (attachedBeforeDrop in listOf(false, true)) {
            val fixture = RouteFixture(this)
            fixture.connect()
            val cache = OutboundCache()
            fixture.component.bindChatRoute(cache, null)
            backgroundScope.launch {
                fixture.component.observeOutbound(cache).collect { fixture.component.flushOutbound(cache) }
            }
            backgroundScope.launch {
                fixture.component.observeChat.coldHistoryReplaceSignal().collect {
                    fixture.component.observeChat.onColdHistoryReplace(cache)
                }
            }
            runCurrent()
            val request = fixture.socket.sent.last { it["type"]?.jsonPrimitive?.content == "session.new" }
            val requestId = request.getValue("requestId").jsonPrimitive.content
            fixture.socket.frame("""{"type":"session.draft","requestId":"$requestId","draftKey":"D","ts":1}""")
            runCurrent()
            cache.enqueue("P", "first message")
            runCurrent()
            val oldSocket = fixture.socket
            assertEquals(listOf("P"), oldSocket.inputs())
            val route = fixture.sdk.outboundRouteGeneration.value
            val transport = fixture.sdk.transportGeneration.value
            if (attachedBeforeDrop) {
                oldSocket.frame("""{"type":"session.attached","sessionId":"S","generation":1}""")
                runCurrent()
            }
            oldSocket.incomingFrames.send(WsIncoming.Failure("lost-created"))
            fixture.sdk.connection.first { it.status == SdkStatus.RECONNECTING }
            runCurrent()
            assertEquals("D", fixture.sdk.currentSessionId.value)
            assertNull(fixture.sdk.outboundSessionId.value)
            assertTrue(fixture.sdk.transportGeneration.value > transport)

            // Gateway configures by resolving D -> S: attached precedes ready, then
            // snapshot. No session.created or session.switched is emitted on this path.
            fixture.socket.frame("""{"type":"auth.ok","user":{"userId":"test","displayName":"Test"}}""")
            runCurrent()
            val configure = fixture.socket.sent.single { it["type"]?.jsonPrimitive?.content == "session.configure" }
            assertEquals("D", configure.getValue("conversationId").jsonPrimitive.content)
            fixture.socket.frame("""{"type":"session.attached","sessionId":"S","generation":2}""")
            runCurrent()
            assertTrue(fixture.socket.inputs().isEmpty(), "attachment cannot send before READY")
            fixture.socket.frame("""{"type":"session.ready","sessionId":"connection-2","audioEncoding":"pcm","inputSampleRate":16000,"outputSampleRate":24000}""")
            fixture.socket.frame("""{"type":"conversation.snapshot","items":[]}""")
            runCurrent()
            assertEquals("S", fixture.sdk.currentSessionId.value)
            assertEquals("S", fixture.sdk.outboundSessionId.value)
            assertEquals(route, fixture.sdk.outboundRouteGeneration.value)
            assertEquals(route, fixture.sdk.acknowledgedRoute.value?.generation)
            assertEquals(listOf("P"), fixture.socket.inputs())
            assertTrue(fixture.socket.sent.none { it["type"]?.jsonPrimitive?.content == "conversation.activate" })
            val resent = fixture.socket.sent.single { it["type"]?.jsonPrimitive?.content == "text.input" }
            assertEquals("S", resent.getValue("sessionId").jsonPrimitive.content)
            assertEquals("2", resent.getValue("attachmentGeneration").jsonPrimitive.content)
            fixture.socket.frame("""{"type":"session.attached","sessionId":"S","generation":2}""")
            runCurrent()
            assertEquals(listOf("P"), fixture.socket.inputs(), "same transport must not resend twice")
        }
    }

    @Test
    fun ready_switch_ack_drains_VM_cache_without_another_action() = runTest {
        val fixture = RouteFixture(this)
        fixture.connect()
        val cache = OutboundCache()
        fixture.component.bindChatRoute(cache, "B")
        backgroundScope.launch { fixture.component.observeOutbound(cache).collect { fixture.component.flushOutbound(cache) } }
        backgroundScope.launch {
            fixture.component.observeChat.coldHistoryReplaceSignal().collect {
                fixture.component.observeChat.onColdHistoryReplace(cache)
            }
        }
        cache.enqueue("pending-B", "message")
        runCurrent()
        assertTrue(fixture.socket.inputs().isEmpty())
        fixture.socket.frame("""{"type":"session.attached","sessionId":"B","generation":2}""")
        runCurrent()
        assertTrue(fixture.socket.inputs().isEmpty(), "attachment grants reconstruction, not sends")
        fixture.socket.frame("""{"type":"session.switched","sessionId":"B","ts":1}""")
        runCurrent()
        assertEquals(SdkStatus.READY, fixture.sdk.connection.value.status)
        assertEquals(listOf("pending-B"), fixture.socket.inputs())
        fixture.socket.frame("""{"type":"session.switched","sessionId":"B","ts":1}""")
        runCurrent()
        assertEquals(listOf("pending-B"), fixture.socket.inputs())
        assertEquals("pending-B", cache.pending.value.single().id, "switch is not acceptance")
        cache.enqueue("other-message", "fixture")
        // Rejections without an exact text-input identity cannot settle another row.
        fixture.socket.frame("""{"type":"command.rejected","command":"interrupt","reason":"session_busy","pendingId":"pending-B"}""")
        fixture.socket.frame("""{"type":"command.rejected","command":"text.input","reason":"session_busy"}""")
        runCurrent()
        assertEquals(PendingDeliveryState.ATTEMPTED, cache.pending.value.first().deliveryState)
        fixture.socket.frame("""{"type":"command.rejected","command":"text.input","reason":"session_busy","pendingId":"pending-B"}""")
        runCurrent()
        assertEquals(PendingDeliveryState.REJECTED, cache.pending.value.first().deliveryState)
        assertEquals("session_busy", cache.pending.value.first().rejectionReason)
        assertEquals(PendingDeliveryState.ATTEMPTED, cache.pending.value.last().deliveryState)
    }

    @Test
    fun acknowledged_route_binds_after_drop_then_automatically_sends_after_restoration() = runTest {
        val fixture = RouteFixture(this)
        fixture.connect()
        val activation = async { fixture.sdk.switchSession("B") }
        runCurrent()
        fixture.socket.frame("""{"type":"session.attached","sessionId":"B","generation":1}""")
        fixture.socket.frame("""{"type":"session.switched","sessionId":"B","ts":1}""")
        activation.await()
        val acknowledged = fixture.sdk.acknowledgedRoute.value!!
        fixture.socket.incomingFrames.send(WsIncoming.Failure("drop"))
        fixture.sdk.connection.first { it.status == SdkStatus.RECONNECTING }
        assertNull(fixture.sdk.outboundSessionId.value)

        val cache = OutboundCache()
        fixture.component.bindChatRoute(cache, "B", activate = false)
        assertEquals(acknowledged.generation, cache.routeGeneration)
        backgroundScope.launch { fixture.component.observeOutbound(cache).collect { fixture.component.flushOutbound(cache) } }
        cache.enqueue("after-drop", "message")
        runCurrent()
        fixture.ready()
        runCurrent()
        assertTrue(fixture.socket.inputs().isEmpty())
        fixture.socket.frame("""{"type":"session.attached","sessionId":"B","generation":2}""")
        fixture.socket.frame("""{"type":"session.switched","sessionId":"B","ts":1}""")
        runCurrent()
        assertEquals(listOf("after-drop"), fixture.socket.inputs())
        assertEquals(acknowledged, fixture.sdk.acknowledgedRoute.value)
    }

    @Test
    fun ready_draft_ack_and_mint_keep_pending_id_without_duplicate_send() = runTest {
        val fixture = RouteFixture(this)
        fixture.connect()
        val cache = OutboundCache()
        fixture.component.bindChatRoute(cache, null)
        backgroundScope.launch { fixture.component.observeOutbound(cache).collect { fixture.component.flushOutbound(cache) } }
        cache.enqueue("first-send", "message")
        runCurrent()
        val request = fixture.socket.sent.last { it["type"]?.jsonPrimitive?.content == "session.new" }
        val requestId = request.getValue("requestId").jsonPrimitive.content
        fixture.socket.frame("""{"type":"session.draft","requestId":"$requestId","draftKey":"draft","ts":1}""")
        runCurrent()
        assertEquals(listOf("first-send"), fixture.socket.inputs())
        val epoch = cache.routeGeneration
        fixture.socket.frame("""{"type":"session.attached","sessionId":"minted","generation":1}""")
        fixture.socket.frame("""{"type":"session.created","sessionId":"minted","ts":2}""")
        runCurrent()
        assertEquals(listOf("first-send"), fixture.socket.inputs())
        assertEquals(epoch, fixture.sdk.outboundRouteGeneration.value)
        cache.enqueue("next-send", "next")
        runCurrent()
        assertEquals(listOf("first-send", "next-send"), fixture.socket.inputs())
        assertEquals("minted", fixture.socket.sent.last().getValue("sessionId").jsonPrimitive.content)
    }
}

private class RouteFixture(private val scope: TestScope, historyClient: SessionsHttpClient? = null) {
    lateinit var socket: RouteSocket
    val sdk = SentientSdk(
        SdkConfig(gatewayWsUrl = "wss://test/api/v1/ws", allowSelfSignedDevHost = false, capabilities = emptyList()),
        PlatformBundle(
            engine = object : WebSocketEngine {
                override suspend fun open(url: String, allowSelfSignedDevHost: Boolean): WebSocketSession =
                    RouteSocket().also { socket = it }
            },
            tokenStore = object : SecureTokenStore {
                override fun load() = "test-token"
                override fun save(token: String) {}
                override fun clear() {}
            },
            deviceIdStore = object : DeviceIdStore {
                override fun load() = "test-device"
                override fun save(id: String) {}
            },
            clock = Clock { 0L },
        ),
        scope.backgroundScope,
        sessionsHttpClient = historyClient,
    )
    val component = ChatComponent(sdk)

    suspend fun connect() {
        val connecting = scope.launch { sdk.connect() }
        sdk.connection.first { it.status == SdkStatus.AUTHENTICATING }
        ready()
        connecting.join()
    }

    suspend fun ready() {
        socket.frame("""{"type":"auth.ok","user":{"userId":"test","displayName":"Test"}}""")
        socket.frame("""{"type":"session.ready","sessionId":"connection","audioEncoding":"pcm","inputSampleRate":16000,"outputSampleRate":24000}""")
        sdk.connection.first { it.status == SdkStatus.READY }
    }
}

private class RouteSocket : WebSocketSession {
    val incomingFrames = Channel<WsIncoming>(Channel.UNLIMITED)
    override val incoming = incomingFrames.receiveAsFlow()
    val sent = mutableListOf<kotlinx.serialization.json.JsonObject>()
    override suspend fun sendText(text: String) { sent += Json.parseToJsonElement(text).jsonObject }
    override suspend fun sendBinary(bytes: ByteArray) {}
    override suspend fun close(code: Int, reason: String) { incomingFrames.close() }
    suspend fun frame(json: String) { incomingFrames.send(WsIncoming.Text(json)) }
    fun inputs() = sent.filter { it["type"]?.jsonPrimitive?.content == "text.input" }
        .map { it.getValue("pendingId").jsonPrimitive.content }
}
