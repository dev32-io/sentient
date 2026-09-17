package io.sentient.mobilesdk.sdk

import io.sentient.mobilesdk.connectors.CognitionState
import io.sentient.mobilesdk.connectors.SessionsRequestException
import io.sentient.mobilesdk.connectors.SessionsTimeoutException
import io.sentient.mobilesdk.protocol.SdkEvent
import io.sentient.mobilesdk.fakes.FakeWebSocketEngine
import io.sentient.mobilesdk.transport.SdkStatus
import io.sentient.mobilesdk.transport.WsIncoming
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

private fun switched(id: String) =
    WsIncoming.Text("{\"type\":\"session.switched\",\"sessionId\":\"$id\",\"ts\":1}")

private fun attached(id: String, generation: Int = 1) =
    WsIncoming.Text("{\"type\":\"session.attached\",\"sessionId\":\"$id\",\"generation\":$generation}")

private fun created(id: String) =
    WsIncoming.Text("{\"type\":\"session.created\",\"sessionId\":\"$id\",\"ts\":1}")

private fun conversationEntry(text: String) =
    WsIncoming.Text("{\"type\":\"conversation.entry\",\"item\":{\"kind\":\"assistant\",\"ts\":1,\"content\":\"$text\"}}")

private fun unavailable() =
    WsIncoming.Text("{\"type\":\"sessions.error\",\"code\":\"not_found\",\"message\":\"missing\"}")

private fun FakeWebSocketEngine.activationIds(): List<String> = sentText.mapNotNull { frame ->
    Regex("\\\"type\\\":\\\"conversation.activate\\\",\\\"sessionId\\\":\\\"([^\\\"]+)").find(frame)?.groupValues?.get(1)
}

private fun FakeWebSocketEngine.draftReply(key: String): WsIncoming.Text {
    val frame = kotlinx.serialization.json.Json.parseToJsonElement(sentText.last { it.contains("session.new") }) as kotlinx.serialization.json.JsonObject
    val requestId = (frame["requestId"] as kotlinx.serialization.json.JsonPrimitive).content
    return WsIncoming.Text("""{"type":"session.draft","requestId":"$requestId","draftKey":"$key","ts":1}""")
}

class SessionActivationTest {
    @Test
    fun prior_draft_mint_cannot_cross_new_chat_transport_boundary() = runTest {
        val fake = FakeWebSocketEngine().apply { beforeClose = { kotlinx.coroutines.awaitCancellation() } }
        val sdk = buildSdk(fake)
        connectToReady(sdk, fake)
        sdk.startFreshChat()
        runCurrent()
        fake.emit(fake.draftReply("D1"))
        runCurrent()
        val firstEpoch = sdk.outboundRouteGeneration.value
        sdk.sendText("first", "pending-D1")
        runCurrent()
        val old = fake.current!!
        assertTrue(old.sentText.any { it.contains("pending-D1") })

        sdk.startFreshChat()
        assertNull(sdk.outboundSessionId.value)
        assertTrue(sdk.outboundRouteGeneration.value != firstEpoch)
        runCurrent()
        old.emit(attached("late-D1"))
        old.emit(created("late-D1"))
        old.emit(conversationEntry("late"))
        runCurrent()
        assertNull(sdk.currentSessionId.value)
        assertTrue(sdk.timeline.value.isEmpty())

        fake.emit(WsIncoming.Text(AUTH_OK_FRAME))
        fake.emit(WsIncoming.Text(READY_FRAME))
        sdk.connection.first { it.status == SdkStatus.READY }
        runCurrent()
        fake.emit(attached("late-D1"))
        fake.emit(created("late-D1"))
        fake.emit(WsIncoming.Text("""{"type":"session.draft","draftKey":"unsolicited","ts":1}"""))
        runCurrent()
        assertNull(sdk.outboundSessionId.value)
        fake.emit(fake.draftReply("D2"))
        runCurrent()
        assertEquals("D2", sdk.outboundSessionId.value)
        val secondEpoch = sdk.outboundRouteGeneration.value
        sdk.sendText("second", "pending-D2")
        runCurrent()
        fake.emit(attached("mint-D2"))
        fake.emit(created("mint-D2"))
        runCurrent()
        assertEquals("mint-D2", sdk.outboundSessionId.value)
        assertEquals(secondEpoch, sdk.outboundRouteGeneration.value)
    }

    @Test
    fun failed_target_blocks_voice_and_control_but_attached_target_can_answer_permission() = runTest {
        val fake = FakeWebSocketEngine()
        val sdk = buildSdk(fake)
        connectToReady(sdk, fake)
        fake.emit(attached("A"))
        fake.emit(created("A"))
        runCurrent()
        sdk.beginSessionRoute("B")
        runCurrent()
        fake.emit(unavailable())
        runCurrent()
        val before = fake.sentText.size
        sdk.startMic()
        sdk.pressMic()
        sdk.lockMic()
        sdk.interrupt()
        sdk.respondToPermission("old-permission", true)
        sdk.setTtsEnabled(false)
        sdk.sendText("blocked", "blocked")
        runCurrent()
        assertEquals(before + 1, fake.sentText.size)
        assertTrue(fake.sentText.last().contains("user.preferences.patch"), "account preferences remain allowed")
        assertEquals(io.sentient.mobilesdk.voice.talk.TalkMode.Idle, sdk.talkMode.value)

        val retry = async { sdk.switchSession("B") }
        runCurrent()
        fake.emit(attached("B", 2))
        fake.emit(WsIncoming.Text("""{"type":"permission.request","requestId":"perm-B","toolCallId":"tool-B","toolName":"calendar","args":{},"description":"confirm","expiresAtMs":120000}"""))
        runCurrent()
        sdk.respondToPermission("perm-B", false)
        sdk.sendText("still blocked", "blocked-B")
        runCurrent()
        assertTrue(fake.sentText.last().contains("permission.response"))
        assertTrue(fake.sentText.last().contains("\"sessionId\":\"B\""))
        assertTrue(fake.sentText.none { it.contains("\"type\":\"text.input\"") })
        fake.emit(created("B"))
        runCurrent()
        assertNull(sdk.outboundSessionId.value, "created cannot substitute for switch acknowledgement")
        fake.emit(switched("B"))
        retry.await()
    }

    @Test
    fun pre_ready_activation_waits_for_ready_and_matching_ack() = runTest {
        val fake = FakeWebSocketEngine()
        val sdk = buildSdk(fake)
        val activation = async { sdk.switchSession("target") }
        runCurrent()
        assertTrue(fake.activationIds().isEmpty())

        connectToReady(sdk, fake)
        runCurrent()
        assertEquals(listOf("target"), fake.activationIds())
        assertTrue(!activation.isCompleted)

        fake.emit(attached("target"))
        fake.emit(switched("target"))
        activation.await()
        assertEquals("target", sdk.currentSessionId.value)
    }

    @Test
    fun anchored_session_after_drop_still_requires_ready_and_restoration_ack() = runTest {
        val fake = FakeWebSocketEngine()
        val sdk = buildSdk(fake)
        connectToReady(sdk, fake)
        fake.emit(created("anchor"))
        sdk.outboundSessionId.first { it == "anchor" }

        fake.failIncoming("drop")
        sdk.connection.first { it.status == SdkStatus.RECONNECTING }
        sdk.connection.first { fake.openedUrls.size == 2 }
        val activation = async { sdk.switchSession("anchor") }
        runCurrent()
        assertTrue(!activation.isCompleted)
        assertTrue(fake.activationIds().isEmpty())

        fake.emit(WsIncoming.Text(AUTH_OK_FRAME))
        fake.emit(WsIncoming.Text(READY_FRAME))
        sdk.connection.first { it.status == SdkStatus.READY }
        runCurrent()
        assertEquals(listOf("anchor"), fake.activationIds())
        assertTrue(!activation.isCompleted)

        fake.emit(attached("anchor"))
        fake.emit(switched("anchor"))
        activation.await()
        assertEquals("anchor", sdk.outboundSessionId.value)
    }

    @Test
    fun warm_and_current_session_activation_acknowledge_without_duplicate() = runTest {
        val fake = FakeWebSocketEngine()
        val sdk = buildSdk(fake)
        connectToReady(sdk, fake)

        val first = async { sdk.switchSession("target") }
        runCurrent()
        assertTrue(!first.isCompleted)
        fake.emit(attached("target"))
        fake.emit(switched("target"))
        first.await()
        val sent = fake.activationIds().size
        val firstRoute = sdk.outboundRouteGeneration.value

        sdk.switchSession("target")
        runCurrent()
        assertEquals(sent, fake.activationIds().size)
        assertTrue(
            (sdk.outboundRouteGeneration.value ?: 0) > (firstRoute ?: 0),
            "same-session route gets a fresh local identity",
        )
    }

    @Test
    fun latest_intent_drops_superseded_ack_before_global_state() = runTest {
        val fake = FakeWebSocketEngine()
        val sdk = buildSdk(fake)
        connectToReady(sdk, fake)

        val old = async { runCatching { sdk.switchSession("old") } }
        runCurrent()
        assertEquals(listOf("old"), fake.activationIds())
        val latest = async { sdk.switchSession("latest") }
        runCurrent()

        fake.emit(attached("old"))
        runCurrent()
        sdk.sendText("probe")
        runCurrent()
        assertTrue(fake.sentText.none { it.contains("\"type\":\"text.input\"") }, "pending route blocks text entirely")
        fake.emit(switched("old"))
        runCurrent()
        assertNull(sdk.currentSessionId.value)
        assertIs<SessionsRequestException>(old.await().exceptionOrNull())
        assertEquals(listOf("old", "latest"), fake.activationIds())

        fake.emit(attached("latest", generation = 2))
        fake.emit(switched("latest"))
        latest.await()
        assertEquals("latest", sdk.currentSessionId.value)
    }

    @Test
    fun fire_and_forget_route_failure_fences_old_chat_until_matching_retry_ack() = runTest {
        val fake = FakeWebSocketEngine()
        val sdk = buildSdk(fake)
        connectToReady(sdk, fake)
        fake.emit(created("A"))
        sdk.outboundSessionId.first { it == "A" }

        sdk.sendSwitchSession("B")
        assertNull(sdk.outboundSessionId.value)
        runCurrent()
        assertEquals(listOf("B"), fake.activationIds())
        fake.emit(conversationEntry("late-A"))
        fake.emit(unavailable())
        runCurrent()
        assertNull(sdk.outboundSessionId.value)
        assertEquals("A", sdk.currentSessionId.value)
        assertTrue(sdk.timeline.value.isEmpty(), "old-route payload stays quarantined")

        val retry = async { sdk.switchSession("B") }
        runCurrent()
        fake.emit(attached("A", generation = 2))
        fake.emit(switched("A"))
        runCurrent()
        assertNull(sdk.outboundSessionId.value)
        assertTrue(!retry.isCompleted)

        fake.emit(attached("B", generation = 3))
        fake.emit(switched("B"))
        retry.await()
        assertEquals("B", sdk.outboundSessionId.value)
    }

    @Test
    fun accepted_target_attachment_preserves_reconstruction_before_outbound_switch_ack() = runTest {
        val fake = FakeWebSocketEngine()
        val sdk = buildSdk(fake)
        connectToReady(sdk, fake)
        fake.emit(created("A"))
        sdk.outboundSessionId.first { it == "A" }

        val activation = async { sdk.switchSession("B") }
        runCurrent()
        fake.emit(conversationEntry("late-A"))
        runCurrent()
        assertTrue(sdk.timeline.value.isEmpty(), "old A payload stays quarantined")

        val targetDelta = async(start = CoroutineStart.UNDISPATCHED) {
            sdk.events.first { it is SdkEvent.MessageDelta } as SdkEvent.MessageDelta
        }
        fake.emit(attached("B", generation = 2))
        fake.emit(WsIncoming.Text("{\"type\":\"turn.started\",\"turnId\":\"turn-B\",\"trigger\":\"user\"}"))
        fake.emit(WsIncoming.Text("{\"type\":\"turn.text.delta\",\"turnId\":\"turn-B\",\"text\":\"target\"}"))
        fake.emit(WsIncoming.Text("{\"type\":\"tasklist.state\",\"turnId\":\"turn-B\",\"items\":[{\"id\":\"task-B\",\"toolName\":\"calendar\",\"status\":\"running\"}]}"))
        fake.emit(WsIncoming.Text("{\"type\":\"permission.request\",\"requestId\":\"perm-B\",\"toolCallId\":\"tool-B\",\"toolName\":\"calendar\",\"args\":{},\"description\":\"confirm\",\"expiresAtMs\":120000}"))
        runCurrent()

        assertEquals("target", targetDelta.await().chunk)
        assertEquals(CognitionState.THINKING, sdk.connection.value.cognition)
        assertEquals("task-B", sdk.tasks.value.single().id)
        assertEquals("perm-B", sdk.permissions.value.single().requestId)
        fake.emit(WsIncoming.Text("""{"type":"turn.audio.start","turnId":"turn-B","encoding":"pcm","sampleRate":24000}"""))
        sdk.connection.first { it.isSpeaking }
        assertTrue(sdk.connection.value.isSpeaking, "accepted B audio reconstruction precedes switch ack")
        fake.emit(WsIncoming.Text("""{"type":"turn.audio.done","turnId":"turn-B"}"""))
        sdk.connection.first { !it.isSpeaking }
        assertEquals("A", sdk.currentSessionId.value)
        assertNull(sdk.outboundSessionId.value, "attachment authorizes inbound only")
        assertTrue(!activation.isCompleted)

        fake.emit(switched("B"))
        activation.await()
        assertEquals("B", sdk.outboundSessionId.value)
    }

    @Test
    fun fresh_chat_cancels_activation_route_and_rejects_its_late_ack() = runTest {
        val fake = FakeWebSocketEngine()
        val sdk = buildSdk(fake)
        connectToReady(sdk, fake)
        fake.emit(created("A"))
        sdk.outboundSessionId.first { it == "A" }

        val activation = async { sdk.switchSession("B") }
        runCurrent()
        activation.cancel()
        sdk.startFreshChat()
        runCurrent()
        assertNull(sdk.currentSessionId.value)
        assertNull(sdk.outboundSessionId.value)

        fake.emit(attached("B", generation = 2))
        fake.emit(switched("B"))
        runCurrent()
        assertNull(sdk.currentSessionId.value, "cancelled B cannot reclaim fresh-chat route")
        assertNull(sdk.outboundSessionId.value)

        sdk.connection.first { fake.openedUrls.size == 2 }
        fake.emit(WsIncoming.Text(AUTH_OK_FRAME))
        fake.emit(WsIncoming.Text(READY_FRAME))
        sdk.connection.first { it.status == SdkStatus.READY }
        runCurrent()
        fake.emit(fake.draftReply("fresh"))
        runCurrent()
        assertEquals("fresh", sdk.outboundSessionId.value)
    }

    @Test
    fun uncorrelated_unavailable_fails_promptly() = runTest {
        val fake = FakeWebSocketEngine()
        val sdk = buildSdk(fake)
        connectToReady(sdk, fake)
        val activation = async { runCatching { sdk.switchSession("missing") } }
        runCurrent()

        fake.emit(unavailable())
        runCurrent()

        val failure = activation.await().exceptionOrNull()
        assertIs<SessionsRequestException>(failure)
        assertEquals("not_found", failure.code)
        assertNull(sdk.currentSessionId.value)
    }

    @Test
    fun transport_drop_retries_only_pending_activation_after_reconnect() = runTest {
        val fake = FakeWebSocketEngine()
        val sdk = buildSdk(fake)
        connectToReady(sdk, fake)
        val activation = async { sdk.switchSession("target") }
        runCurrent()
        assertEquals(listOf("target"), fake.activationIds())

        fake.failIncoming("drop")
        sdk.connection.first { it.status == SdkStatus.RECONNECTING }
        sdk.connection.first { fake.openedUrls.size == 2 }
        fake.emit(WsIncoming.Text(AUTH_OK_FRAME))
        fake.emit(WsIncoming.Text(READY_FRAME))
        sdk.connection.first { it.status == SdkStatus.READY }
        runCurrent()
        assertEquals(listOf("target"), fake.activationIds())

        fake.emit(attached("target"))
        fake.emit(switched("target"))
        activation.await()
        assertEquals("target", sdk.currentSessionId.value)
    }

    @Test
    fun dropped_reestablish_does_not_block_explicit_activation_on_next_transport() = runTest {
        val fake = FakeWebSocketEngine()
        val sdk = buildSdk(fake)
        connectToReady(sdk, fake)
        fake.emit(created("A"))
        sdk.outboundSessionId.first { it == "A" }

        fake.failIncoming("first-drop")
        sdk.connection.first { fake.openedUrls.size == 2 }
        fake.emit(WsIncoming.Text(AUTH_OK_FRAME))
        fake.emit(WsIncoming.Text(READY_FRAME))
        sdk.connection.first { it.status == SdkStatus.READY }
        runCurrent()
        assertEquals(listOf("A"), fake.activationIds())

        fake.failIncoming("second-drop-before-ack")
        sdk.connection.first { fake.openedUrls.size == 3 }
        val explicit = async { sdk.switchSession("B") }
        runCurrent()
        fake.emit(WsIncoming.Text(AUTH_OK_FRAME))
        fake.emit(WsIncoming.Text(READY_FRAME))
        sdk.connection.first { it.status == SdkStatus.READY }
        runCurrent()
        assertEquals(listOf("B"), fake.activationIds())

        fake.emit(attached("B", generation = 2))
        fake.emit(switched("B"))
        explicit.await()
        assertEquals("B", sdk.outboundSessionId.value)
    }

    @Test
    fun timeout_resets_transport_before_latest_target_can_be_poisoned_by_old_error() = runTest {
        val closeBlocker = CompletableDeferred<Unit>()
        val fake = FakeWebSocketEngine().apply { beforeClose = { closeBlocker.await() } }
        val sdk = buildSdk(fake)
        connectToReady(sdk, fake)
        val oldTransport = fake.current!!

        val old = async { runCatching { sdk.switchSession("A") } }
        runCurrent()
        advanceTimeBy(5_001)
        runCurrent()
        assertIs<SessionsTimeoutException>(old.await().exceptionOrNull())
        sdk.connection.first { fake.openedUrls.size == 2 }

        val latest = async { sdk.switchSession("B") }
        runCurrent()
        fake.emit(WsIncoming.Text(AUTH_OK_FRAME))
        fake.emit(WsIncoming.Text(READY_FRAME))
        sdk.connection.first { it.status == SdkStatus.READY }
        runCurrent()
        assertEquals(listOf("B"), fake.activationIds())

        oldTransport.emit(unavailable())
        runCurrent()
        assertTrue(!latest.isCompleted, "late error on detached transport cannot fail B")
        assertNull(sdk.outboundSessionId.value)

        fake.emit(attached("B"))
        fake.emit(switched("B"))
        latest.await()
        assertEquals("B", sdk.outboundSessionId.value)
        closeBlocker.complete(Unit)
    }

    @Test
    fun late_ack_after_timeout_cannot_change_global_session() = runTest {
        val fake = FakeWebSocketEngine()
        val sdk = buildSdk(fake)
        connectToReady(sdk, fake)
        val timedOut = async { runCatching { sdk.switchSession("late") } }
        runCurrent()

        advanceTimeBy(5_001)
        runCurrent()
        assertIs<SessionsTimeoutException>(timedOut.await().exceptionOrNull())
        fake.emit(attached("late"))
        fake.emit(switched("late"))
        runCurrent()
        assertNull(sdk.currentSessionId.value)
    }

    @Test
    fun offline_wait_is_bounded_and_a_later_retry_can_succeed() = runTest {
        val fake = FakeWebSocketEngine()
        val sdk = buildSdk(fake)
        val timedOut = async { runCatching { sdk.switchSession("target") } }
        runCurrent()
        advanceTimeBy(10_001)
        runCurrent()
        assertIs<SessionsTimeoutException>(timedOut.await().exceptionOrNull())
        assertTrue(fake.activationIds().isEmpty())

        connectToReady(sdk, fake)
        val retry = async { sdk.switchSession("target") }
        runCurrent()
        fake.emit(attached("target"))
        fake.emit(switched("target"))
        retry.await()
        assertEquals("target", sdk.currentSessionId.value)
    }

    @Test
    fun disconnect_cancels_undispatched_activation_registration() = runTest {
        val fake = FakeWebSocketEngine()
        val sdk = buildSdk(fake)
        val activation = async(start = CoroutineStart.UNDISPATCHED) {
            runCatching { sdk.switchSession("old-account") }
        }

        sdk.disconnect()
        sdk.beginSessionRoute("after-logout")
        sdk.beginFreshChatRoute()
        runCurrent()
        assertTrue(activation.await().isFailure)
        assertNull(sdk.outboundRouteGeneration.value)

        connectToReady(sdk, fake)
        runCurrent()
        assertTrue(fake.activationIds().isEmpty())
    }

    @Test
    fun logout_cancels_pre_ready_activation_without_late_send() = runTest {
        val fake = FakeWebSocketEngine()
        val sdk = buildSdk(fake)
        val activation = async { runCatching { sdk.switchSession("old-account") } }
        runCurrent()

        sdk.disconnect()
        runCurrent()
        assertTrue(activation.await().isFailure)

        val connect = launch { sdk.connect() }
        sdk.connection.first { it.status == SdkStatus.AUTHENTICATING }
        fake.emit(WsIncoming.Text(AUTH_OK_FRAME))
        fake.emit(WsIncoming.Text(READY_FRAME))
        connect.join()
        runCurrent()
        assertTrue(fake.activationIds().isEmpty())
    }
}
