package io.sentient.mobiledata.di

import io.sentient.mobiledata.outbox.OutboundCache
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

/** Real SDK -> ChatComponent -> VM-owned cache/collector, with only socket I/O faked. */
class RouteOutboxIntegrationTest {
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

private class RouteFixture(private val scope: TestScope) {
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
