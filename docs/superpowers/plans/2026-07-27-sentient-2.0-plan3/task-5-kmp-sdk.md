### Task 5: `shared/mobile-sdk` rebase — 2.0 turn wire, turn-queued audio, permission + delegation surface

**Spec:** §7 (client wire contract), §7.1 (permission-prompt UI), §7.2 (client audio queueing). Build-order slice 7, client-SDK half.
**Depends on:** Task 1 (the frozen wire contract — consumed verbatim, never renamed or extended here).
**Consumed by:** Task 8 (Android UI) and Task 9 (iOS UI) build their dialogs on the public surface this task produces.

`shared/mobile-sdk` compiles into **both** Android and iOS — it is the single writer for mobile wire types. Nobody else edits this module in Wave 2.

---

#### Files

**Create**
- `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/audioio/TurnAudioQueue.kt`
- `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/connectors/PermissionConnector.kt`
- `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/connectors/DelegationProgressConnector.kt`
- `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/connectors/TurnErrorConnector.kt` (replaces `CycleErrorConnector.kt`)
- `shared/mobile-sdk/src/commonTest/kotlin/io/sentient/mobilesdk/audioio/AudioPipelineTurnQueueTest.kt`
- `shared/mobile-sdk/src/commonTest/kotlin/io/sentient/mobilesdk/connectors/PermissionConnectorTest.kt`
- `shared/mobile-sdk/src/commonTest/kotlin/io/sentient/mobilesdk/connectors/DelegationProgressConnectorTest.kt`
- `shared/mobile-sdk/src/commonTest/kotlin/io/sentient/mobilesdk/connectors/TurnErrorConnectorTest.kt` (replaces `CycleErrorConnectorTest.kt`)

**Modify — `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/`**
- `protocol/ServerMessage.kt`, `protocol/ClientMessage.kt`, `protocol/ConversationFeedItem.kt`, `protocol/SdkEvent.kt`
- `connectors/AssistantAudioResponseConnector.kt`, `connectors/CognitionStatusConnector.kt`, `connectors/InFlightMessageConnector.kt`, `connectors/TaskStatusConnector.kt`, `connectors/ConversationHistoryConnector.kt`
- `audioio/AudioPipeline.kt`
- `sdk/AudioFsm.kt`, `sdk/SdkAudio.kt`, `sdk/SdkConnectors.kt`, `sdk/SdkLifecycle.kt`, `sdk/SdkState.kt`, `sdk/StateDeriver.kt`, `sdk/SentientSdk.kt`
- `shared/mobile-sdk/build.gradle.kts` (version bump)

**Modify — `shared/mobile-data/src/commonMain/kotlin/io/sentient/mobiledata/`**
- `di/ChatComponent.kt`, `usecase/RevealReducer.kt`, `usecase/ObserveChatUseCase.kt`
- `shared/mobile-data/build.gradle.kts` (version bump)

**Delete**
- `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/connectors/CycleErrorConnector.kt`
- `shared/mobile-sdk/src/commonTest/kotlin/io/sentient/mobilesdk/connectors/CycleErrorConnectorTest.kt`

**Tests updated by the rename sweep** (mechanical; no new assertions unless stated)
`shared/mobile-sdk/src/commonTest/kotlin/io/sentient/mobilesdk/` → `protocol/WireSerializationTest.kt`, `protocol/WireDecodeTest.kt`, `protocol/SdkEventTest.kt`, `connectors/InFlightMessageConnectorTest.kt`, `connectors/InFlightEventsTest.kt`, `connectors/TaskStatusConnectorTest.kt`, `connectors/TaskEventsTest.kt`, `connectors/AssistantAudioResponseConnectorTest.kt`, `connectors/CognitionStatusConnectorTest.kt`, `connectors/ConversationHistoryConnectorTest.kt`, `connectors/LifecycleEventsTest.kt`, `connectors/UserAudioInputConnectorTest.kt`, `transport/MessageRouterTest.kt`, `transport/WsTransportTest.kt`, `sdk/AudioFsmTest.kt`, `sdk/StateDeriverToolsTest.kt`, `sdk/LazyArmDownlinkTest.kt`, `sdk/SdkResumeCursorPersistenceTest.kt`, `sdk/SdkResumeReconciliationTest.kt`, `sdk/SentientSdkTest.kt`, `audioio/AudioPipelineTest.kt`, `audioio/AudioPipelineDownlinkTest.kt`, `audioio/AudioPipelineHoldTest.kt`, `vitals/PrivacyGuardTest.kt`.
`shared/mobile-data/src/commonTest/kotlin/io/sentient/mobiledata/` → `usecase/RevealReducerTest.kt`, `usecase/ObserveChatUseCaseTest.kt`, `model/ChatModelTest.kt`.

**Do NOT touch** `android/` or `ios/` — Tasks 8 and 9 own them.

---

#### Known breakage (read before you start)

This task deliberately breaks `:android` and the iOS app target: `ChatMessage.cycleId` → `ChatMessage.turnId` and `TaskSnapshotItem.cycleId` → `.turnId` are referenced by `android/src/main/kotlin/io/sentient/android/chat/message/ChatRows.kt`, `.../MessageList.kt`, `android/src/test/kotlin/io/sentient/android/chat/ChatViewModelTest.kt`, and the Swift files under `ios/App/Chat/`. Tasks 8/9 repair those in Wave 3. **Your verification gate is the two shared modules only:**

```
./gradlew :shared:mobile-sdk:testDebugUnitTest :shared:mobile-data:testDebugUnitTest
./gradlew :shared:mobile-sdk:compileKotlinIosSimulatorArm64 :shared:mobile-data:compileKotlinIosSimulatorArm64
```

Never run `./gradlew build` or `:android:*` in this task — a red `:android` is expected until Task 8 lands.

---

#### Interfaces

**Consumes (exists today / fixed by Task 1 — exact signatures)**

```kotlin
// shared/mobile-sdk/.../connectors/Connector.kt
interface Connector {
    val capability: String
    fun handle(msg: ServerMessage)
    fun handleBinary(bytes: ByteArray) {}
}

// shared/mobile-sdk/.../audioio/VoicePlaybackSink.kt — UNCHANGED by this task.
// A turn-agnostic byte pipe. Queueing lives ABOVE it, in commonMain.
interface VoicePlaybackSink {
    fun playFrame(pcm16: ByteArray)
    fun flushPlayback()
    val isPlaybackIdle: Boolean
}

// shared/mobile-sdk/.../audio/opus/OpusDecoderPort.kt
// decode(chunk): List<ByteArray>; reset(); close()   — ONE stateful decoder instance.

// shared/mobile-sdk/.../sdk/SentientSdk.kt (existing, unchanged shape)
val connection: StateFlow<ConnectionState>
val timeline: StateFlow<List<ChatMessage>>
val events: SharedFlow<SdkEvent>     // replay=0, extraBufferCapacity=EVENTS_BUFFER_CAPACITY, BufferOverflow.SUSPEND
private fun sendControl(msg: ClientMessage)
private fun emitEvent(event: SdkEvent)
```

Task 1's frozen gateway→client frames (`turn.started`, `turn.text.delta`, `turn.completed`, `turn.aborted`, `turn.tool.update`, `turn.audio.start`, `turn.audio.done`, `permission.request`, `permission.resolved`, `delegation.progress`, `playback.stop`) and client→gateway `permission.response { requestId, approved }`. Binary frames unchanged: 8-byte BE u64 seq + 1-byte type (`0x01` = audio) + payload; inbound = mic, outbound = TTS.

**Produces (public surface Tasks 8/9 rely on — exact names)**

```kotlin
// io.sentient.mobilesdk.connectors
data class PermissionPrompt(
    val requestId: String,
    val toolCallId: String,
    val toolName: String,
    val args: Map<String, String>,
    val description: String,
    val expiresAtMs: Long,
)
data class DelegationSnapshotItem(
    val taskId: String,
    val turnId: String,
    val agent: String,
    val status: String,
    val note: String? = null,
)
data class TaskSnapshotItem(               // rekeyed: identity is toolCallId, turnId replaces cycleId
    val toolCallId: String,
    val toolName: String,
    val turnId: String,
    val status: String,
    val argsPreview: String,
    val startedAtMs: Long,
    val endedAtMs: Long? = null,
    val taskId: String? = null,            // background tools only (delegateTask)
)

// io.sentient.mobilesdk.protocol
sealed class SdkEvent {
    data class MessageStarted(val turnId: String) : SdkEvent()
    data class MessageDelta(val turnId: String, val chunk: String) : SdkEvent()
    data class MessageCommitted(val message: ChatMessage) : SdkEvent()
    data class TaskUpserted(val task: TaskSnapshotItem) : SdkEvent()
    data class TranscriptUpdated(val text: String) : SdkEvent()
    data class TurnDone(val turnId: String) : SdkEvent()
    data class TurnAborted(val turnId: String, val cutoff: String) : SdkEvent()
    data class SessionSwitched(val sessionId: String) : SdkEvent()
    data class ProtocolError(val error: SentientError) : SdkEvent()
    data class PermissionRequested(val prompt: PermissionPrompt) : SdkEvent()
    data class PermissionResolved(val requestId: String, val outcome: String) : SdkEvent()
    data class DelegationProgressed(val task: DelegationSnapshotItem) : SdkEvent()
    data object ReopenFailed : SdkEvent()
}

// io.sentient.mobilesdk.sdk.SentientSdk
val permissions: StateFlow<List<PermissionPrompt>>          // cumulative open queue
val delegations: StateFlow<List<DelegationSnapshotItem>>
fun respondToPermission(requestId: String, approved: Boolean)

// io.sentient.mobilesdk.sdk.ChatMessage — `cycleId` renamed to `turnId` (same nullability)

// io.sentient.mobiledata.di.ChatComponent
val permissions: StateFlow<List<PermissionPrompt>>
val delegations: StateFlow<List<DelegationSnapshotItem>>
val permissionRequests: Flow<PermissionPrompt>
val permissionResolutions: Flow<SdkEvent.PermissionResolved>
fun respondToPermission(requestId: String, approved: Boolean)
```

**Surface-shape rule (`.claude/rules/mobile-sdk/coroutines-flow-surface.md`) — why both a StateFlow and events:**
a permission request is a **one-shot that must never be conflated away**, so arrival + resolution ride the buffered, suspend-on-overflow `events: SharedFlow<SdkEvent>`. `permissions: StateFlow<List<PermissionPrompt>>` is safe *because every emitted value carries every still-open prompt* — conflation can drop an intermediate list but never a prompt. Do **not** model this as `StateFlow<PermissionPrompt?>`; two requests landing back-to-back would silently lose the first.

---

#### Steps

##### A. Wire types — adopt the frozen 2.0 frame set

- [ ] **Step 1: Write the failing wire-contract test for the new gateway frames.**
  Append to `shared/mobile-sdk/src/commonTest/kotlin/io/sentient/mobilesdk/protocol/WireSerializationTest.kt`:

```kotlin
    // ── 2.0 frozen wire contract (design §7) ──────────────────────────────────

    @Test fun turn_started_decodes_with_trigger() {
        val s = """{"type":"turn.started","turnId":"t1","trigger":"background-completion"}"""
        val msg = WireJson.instance.decodeFromString(ServerMessage.serializer(), s) as ServerMessage.TurnStarted
        assertEquals("t1", msg.turnId)
        assertEquals("background-completion", msg.trigger)
    }

    @Test fun turn_text_delta_decodes_with_turn_id() {
        val s = """{"type":"turn.text.delta","turnId":"t1","text":"hel"}"""
        val msg = WireJson.instance.decodeFromString(ServerMessage.serializer(), s) as ServerMessage.TurnTextDelta
        assertEquals("t1", msg.turnId)
        assertEquals("hel", msg.text)
    }

    @Test fun turn_completed_and_aborted_decode() {
        val done = WireJson.instance.decodeFromString(
            ServerMessage.serializer(), """{"type":"turn.completed","turnId":"t1"}""",
        ) as ServerMessage.TurnCompleted
        assertEquals("t1", done.turnId)
        val aborted = WireJson.instance.decodeFromString(
            ServerMessage.serializer(), """{"type":"turn.aborted","turnId":"t2","cutoff":"barge-in"}""",
        ) as ServerMessage.TurnAborted
        assertEquals("barge-in", aborted.cutoff)
    }

    @Test fun turn_tool_update_decodes_with_optional_task_id() {
        val fg = """{"type":"turn.tool.update","turnId":"t1","toolCallId":"tc1","toolName":"readFile","status":"running","argsPreview":"a.txt","startedAtMs":10}"""
        val foreground = WireJson.instance.decodeFromString(ServerMessage.serializer(), fg) as ServerMessage.TurnToolUpdate
        assertEquals("tc1", foreground.toolCallId)
        assertEquals(null, foreground.taskId)
        assertEquals(null, foreground.endedAtMs)
        val bg = """{"type":"turn.tool.update","turnId":"t1","toolCallId":"tc2","toolName":"delegateTask","status":"done","taskId":"task-9","argsPreview":"hermes","startedAtMs":10,"endedAtMs":99}"""
        val background = WireJson.instance.decodeFromString(ServerMessage.serializer(), bg) as ServerMessage.TurnToolUpdate
        assertEquals("task-9", background.taskId)
        assertEquals(99L, background.endedAtMs)
    }

    @Test fun turn_audio_frames_decode() {
        val start = WireJson.instance.decodeFromString(
            ServerMessage.serializer(), """{"type":"turn.audio.start","turnId":"t1","encoding":"opus","sampleRate":48000}""",
        ) as ServerMessage.TurnAudioStart
        assertEquals("opus", start.encoding)
        assertEquals(48000, start.sampleRate)
        val done = WireJson.instance.decodeFromString(
            ServerMessage.serializer(), """{"type":"turn.audio.done","turnId":"t1"}""",
        ) as ServerMessage.TurnAudioDone
        assertEquals("t1", done.turnId)
    }

    @Test fun playback_stop_is_rekeyed_to_turn_id() {
        val s = """{"type":"playback.stop","turnId":"t1","reason":"interrupt"}"""
        val msg = WireJson.instance.decodeFromString(ServerMessage.serializer(), s) as ServerMessage.PlaybackStop
        assertEquals("t1", msg.turnId)
        assertEquals("interrupt", msg.reason)
    }

    @Test fun permission_request_decodes_with_arbitrary_args_object() {
        val s = """{"type":"permission.request","requestId":"r1","toolCallId":"tc1","toolName":"sendMessage","args":{"to":"mum","body":"hi"},"description":"Send a message to mum","expiresAtMs":1200}"""
        val msg = WireJson.instance.decodeFromString(ServerMessage.serializer(), s) as ServerMessage.PermissionRequest
        assertEquals("r1", msg.requestId)
        assertEquals("sendMessage", msg.toolName)
        assertEquals(2, msg.args.size)
        assertEquals(1200L, msg.expiresAtMs)
    }

    @Test fun permission_resolved_decodes_outcome() {
        val s = """{"type":"permission.resolved","requestId":"r1","outcome":"timeout"}"""
        val msg = WireJson.instance.decodeFromString(ServerMessage.serializer(), s) as ServerMessage.PermissionResolved
        assertEquals("timeout", msg.outcome)
    }

    @Test fun delegation_progress_decodes() {
        val s = """{"type":"delegation.progress","taskId":"task-9","turnId":"t1","agent":"hermes","status":"running"}"""
        val msg = WireJson.instance.decodeFromString(ServerMessage.serializer(), s) as ServerMessage.DelegationProgress
        assertEquals("task-9", msg.taskId)
        assertEquals("hermes", msg.agent)
        assertEquals(null, msg.note)
    }

    @Test fun permission_response_encodes_request_id_and_approved() {
        val json = WireJson.instance.encodeToString(
            ClientMessage.serializer(), ClientMessage.PermissionResponse(requestId = "r1", approved = false),
        )
        assertTrue(json.contains("\"type\":\"permission.response\""), json)
        assertTrue(json.contains("\"requestId\":\"r1\""), json)
        assertTrue(json.contains("\"approved\":false"), json)
    }
```

  Run: `./gradlew :shared:mobile-sdk:testDebugUnitTest --tests "io.sentient.mobilesdk.protocol.WireSerializationTest"`
  Expected failure: Kotlin **compilation** errors — `Unresolved reference: TurnStarted`, `Unresolved reference: TurnTextDelta`, … `Unresolved reference: PermissionResponse`.

- [ ] **Step 2: Replace the retired gateway frames in `protocol/ServerMessage.kt`.**
  Delete the `CycleStarted` / `CycleAborted` / `CycleCompleted` / `ConnectorAudioStart` / `ConnectorAudioDone` / `MessageDelta` / `MessageDone` / `TaskUpdate` blocks (lines 69–142 of the current file) and the old `PlaybackStop`. Add `import kotlinx.serialization.json.JsonObject` at the top. Replace with:

```kotlin
    // ── Turn lifecycle (design §7 — replaces the retired cycle.* / message.* frames) ──
    // Every non-identity field carries a default: a malformed frame degrades to a
    // harmless value instead of throwing MissingFieldException, which would drop the
    // WHOLE frame at WsTransport decode (a dropped turn.audio.start = silent TTS).

    @Serializable @SerialName("turn.started")
    data class TurnStarted(
        val turnId: String,
        /** "user" | "background-completion". */
        val trigger: String = "",
    ) : ServerMessage()

    @Serializable @SerialName("turn.text.delta")
    data class TurnTextDelta(val turnId: String, val text: String = "") : ServerMessage()

    @Serializable @SerialName("turn.completed")
    data class TurnCompleted(val turnId: String) : ServerMessage()

    @Serializable @SerialName("turn.aborted")
    data class TurnAborted(
        val turnId: String,
        /** "interrupt" | "barge-in"; "" only for a malformed frame. */
        val cutoff: String = "",
    ) : ServerMessage()

    /** Tool-call lifecycle. Identity is [toolCallId]; [taskId] is present only for a
     *  BACKGROUND tool (delegateTask), which returns a task handle immediately. */
    @Serializable @SerialName("turn.tool.update")
    data class TurnToolUpdate(
        val turnId: String,
        val toolCallId: String,
        val toolName: String = "",
        /** "running" | "done" | "error". */
        val status: String = "",
        val taskId: String? = null,
        val argsPreview: String = "",
        val startedAtMs: Long = 0L,
        val endedAtMs: Long? = null,
    ) : ServerMessage()

    // ── Turn audio (design §7.2) ──
    // A NEW turnId NEVER cancels in-flight audio — it queues behind it. See AudioPipeline.

    @Serializable @SerialName("turn.audio.start")
    data class TurnAudioStart(
        val turnId: String,
        /** "opus" | "pcm". */
        val encoding: String = "",
        val sampleRate: Int = 0,
    ) : ServerMessage()

    @Serializable @SerialName("turn.audio.done")
    data class TurnAudioDone(val turnId: String) : ServerMessage()

    /** Flush playback. Emitted ONLY for a user action — barge-in (mic onset) or
     *  interrupt (UI Stop). Never for a new turn. */
    @Serializable @SerialName("playback.stop")
    data class PlaybackStop(
        val turnId: String = "",
        /** "barge-in" | "interrupt". */
        val reason: String = "",
    ) : ServerMessage()

    // ── Permission mediation (design §7.1) ──

    /** L3 `confirm` decision awaiting the user. [args] is an arbitrary tool-argument
     *  object — it is USER CONTENT and must never be logged. */
    @Serializable @SerialName("permission.request")
    data class PermissionRequest(
        val requestId: String,
        val toolCallId: String,
        val toolName: String = "",
        val args: JsonObject = JsonObject(emptyMap()),
        val description: String = "",
        val expiresAtMs: Long = 0L,
    ) : ServerMessage()

    /** The gateway resolved the request first (user answered elsewhere, or the
     *  2-minute fail-closed timeout fired) — the client dismisses its dialog. */
    @Serializable @SerialName("permission.resolved")
    data class PermissionResolved(
        val requestId: String,
        /** "allowed" | "denied" | "timeout". */
        val outcome: String = "",
    ) : ServerMessage()

    // ── Delegation progress (design §5.4 / §7) ──

    @Serializable @SerialName("delegation.progress")
    data class DelegationProgress(
        val taskId: String,
        val turnId: String = "",
        val agent: String = "",
        /** "running" | "done" | "error". */
        val status: String = "",
        val note: String? = null,
    ) : ServerMessage()
```

  Also rekey the conversation frame — replace the `ConversationEntry` block:

```kotlin
    // `turnId` is the gateway-owned join key between this committed entry and its live
    // streaming bubble (carried on the FRAME; the item strips it). Read it straight
    // through — the client never invents/derives it. Null for user-echo / out-of-band
    // entries and for REST history (no live turn).
    @Serializable @SerialName("conversation.entry")
    data class ConversationEntry(
        val item: ConversationFeedItem,
        val turnId: String? = null,
    ) : ServerMessage()
```

- [ ] **Step 3: Replace `ClientMessage.ToolConfirm` with `PermissionResponse`.**
  In `protocol/ClientMessage.kt`, delete lines 70–71 and insert:

```kotlin
    /** User's Allow / Deny for an open [ServerMessage.PermissionRequest] (design §7.1).
     *  Replaces the retired `tool.confirm`. Keyed by requestId, NOT toolCallId — the
     *  PDP owns the request lifetime, and one tool call can be re-prompted. */
    @Serializable @SerialName("permission.response")
    data class PermissionResponse(val requestId: String, val approved: Boolean) : ClientMessage()
```

- [ ] **Step 4: Rekey `ConversationFeedItem.Assistant.cycleId` → `turnId`.**
  In `protocol/ConversationFeedItem.kt`, in the `Assistant` data class change `val cycleId: String? = null,` to `val turnId: String? = null,` and update its KDoc — replace every "cycleId"/"live cycle" mention with "turnId"/"live turn". `Cutoff(kind, cancelledTaskIds)` is **unchanged** — its `kind` values already match the gateway `CutoffKind` (`interrupt` | `barge-in`) exactly.

- [ ] **Step 5: Rewrite `protocol/SdkEvent.kt` for turn identity.**
  Replace the whole `sealed class SdkEvent` body's first block (leave `ReopenFailed` and its KDoc untouched at the bottom):

```kotlin
sealed class SdkEvent {
    data class MessageStarted(val turnId: String) : SdkEvent()
    data class MessageDelta(val turnId: String, val chunk: String) : SdkEvent()
    data class MessageCommitted(val message: ChatMessage) : SdkEvent()
    data class TaskUpserted(val task: TaskSnapshotItem) : SdkEvent()
    data class TranscriptUpdated(val text: String) : SdkEvent()
    data class TurnDone(val turnId: String) : SdkEvent()
    /** [cutoff] is the gateway CutoffKind: "interrupt" | "barge-in". */
    data class TurnAborted(val turnId: String, val cutoff: String) : SdkEvent()
    data class SessionSwitched(val sessionId: String) : SdkEvent()
    data class ProtocolError(val error: SentientError) : SdkEvent()
```

  (`CycleDone`/`CycleAborted` are gone — they named a retired construct. Permission + delegation events are added in Steps 22 and 25.)

- [ ] **Step 6: Rebase `connectors/AssistantAudioResponseConnector.kt` onto the turn audio frames.**
  Rename every `cycleId` identifier to `turnId` (constructor callbacks, `activeCycleId` → `activeTurnId`, log keys) and replace the `handle` body:

```kotlin
    override fun handle(msg: ServerMessage) {
        when (msg) {
            is ServerMessage.TurnAudioStart -> onStart(msg.turnId, msg.encoding, msg.sampleRate)
            is ServerMessage.TurnAudioDone -> onDone(msg.turnId)
            is ServerMessage.PlaybackStop -> onStop(msg.reason, msg.turnId)
            else -> Unit // not owned by this connector
        }
    }
```

  `onStart(turnId: String, encoding: String?, sampleRate: Int?)` and `onDone(turnId: String?)` keep their bodies verbatim. Update the file header comment: `connector.audio.start` → `turn.audio.start`, `connector.audio.done` → `turn.audio.done`.
  **Do not change the drop-guard** (`isReceiving && !isCancelled`) — barge-in still latches until the next `turn.audio.start`.
  Add this note to the header, because it is the invariant the queue depends on:

```kotlin
// TURN ATTRIBUTION: binary downlink frames carry NO turnId (9-byte header = seq +
// type only), so every frame is attributed to the most recent turn.audio.start.
// The gateway therefore MUST bracket each turn's audio strictly —
// start(t) … frames(t) … done(t) — before start(t+1). AudioPipeline's queue is
// defensive against an overlapping start, but it cannot re-attribute bytes.
```

- [ ] **Step 7: Rebase `connectors/CognitionStatusConnector.kt`.**

```kotlin
    override fun handle(msg: ServerMessage) {
        when (msg) {
            is ServerMessage.TurnStarted -> setState(CognitionState.THINKING, "turn.started", msg.turnId)
            is ServerMessage.TurnCompleted -> {
                setState(CognitionState.IDLE, "turn.completed", msg.turnId)
                onEvent?.invoke(SdkEvent.TurnDone(turnId = msg.turnId))
            }
            is ServerMessage.TurnAborted -> setState(CognitionState.IDLE, "turn.aborted", msg.turnId)
            else -> Unit // not owned by this connector
        }
    }
```

  Rename `setState(next, trigger, cycleId)` → `setState(next, trigger, turnId)` and its log key. Update the header comment's `cycle.*` table to `turn.*`.

- [ ] **Step 8: Replace `CycleErrorConnector` with `TurnErrorConnector`.**
  `git mv shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/connectors/CycleErrorConnector.kt shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/connectors/TurnErrorConnector.kt`, then rename the class, capability, and every `cycle` identifier. The classification logic is unchanged; only the frames and names move:

```kotlin
class TurnErrorConnector(
    private val onErrorChange: ((Boolean) -> Unit)? = null,
    private val onEvent: ((SdkEvent) -> Unit)? = null,
) : Connector {
    override val capability: String = CAPABILITY

    private val log = createLogger("connector", "turn-error")

    /** turnId of the active turn, or null when none is in flight. */
    private var activeTurnId: String? = null
    private var selfInitiated: Boolean = false
    private var sawDone: Boolean = false
    private var lastError: Boolean = false

    fun hasError(): Boolean = lastError

    override fun handle(msg: ServerMessage) {
        when (msg) {
            is ServerMessage.TurnStarted -> onTurnStarted(msg.turnId)
            is ServerMessage.TurnCompleted -> onSuccess(msg.turnId, "turn.completed")
            is ServerMessage.TurnAborted -> onAborted(msg.turnId, msg.cutoff)
            else -> Unit // not owned by this connector
        }
    }

    fun noteInterrupt(turnId: String?) = noteSelfInitiated(turnId, "interrupt")
    fun noteBargeIn(turnId: String?) = noteSelfInitiated(turnId, "barge-in")

    fun reset() {
        activeTurnId = null
        selfInitiated = false
        sawDone = false
        clearError("reset")
    }

    private fun onTurnStarted(turnId: String) {
        activeTurnId = turnId
        selfInitiated = false
        sawDone = false
        clearError("turn.started")
    }

    private fun onSuccess(turnId: String?, trigger: String) {
        if (turnId != null && activeTurnId != null && turnId != activeTurnId) return
        sawDone = true
        clearError(trigger)
    }

    private fun noteSelfInitiated(turnId: String?, gesture: String) {
        // A null turnId (no active turn on the gateway) still arms the latch: interrupt()
        // is sent with whatever turn is live, and a same-turn abort following it must be
        // classified self-initiated. Only ignore a note targeting a DIFFERENT turn.
        if (turnId != null && activeTurnId != null && turnId != activeTurnId) return
        selfInitiated = true
        log.info("note", mapOf("gesture" to gesture, "turnId" to (turnId ?: activeTurnId)))
    }

    private fun onAborted(turnId: String?, cutoff: String) {
        if (turnId != null && activeTurnId != null && turnId != activeTurnId) return
        val unsolicited = !selfInitiated && !sawDone
        val resolvedTurnId = turnId ?: activeTurnId
        log.info(
            "classify",
            mapOf(
                "turnId" to resolvedTurnId,
                "cutoff" to cutoff,
                "selfInitiated" to selfInitiated,
                "sawDone" to sawDone,
                "verdict" to if (unsolicited) "unsolicited(error)" else "self-initiated",
            ),
        )
        if (resolvedTurnId != null) onEvent?.invoke(SdkEvent.TurnAborted(turnId = resolvedTurnId, cutoff = cutoff))
        activeTurnId = null
        if (unsolicited) setError() else clearError("self-initiated-abort")
    }

    private fun setError() {
        if (lastError) return
        lastError = true
        onErrorChange?.invoke(true)
    }

    private fun clearError(trigger: String) {
        if (!lastError) return
        log.info("clear", mapOf("trigger" to trigger))
        lastError = false
        onErrorChange?.invoke(false)
    }

    companion object {
        const val CAPABILITY: String = "turn.error"
    }
}
```

  Update the file header: the retired `message.done` corroboration line becomes `turn.completed`, and the `reason=` discussion becomes `cutoff=`.

- [ ] **Step 9: Rebase `connectors/TaskStatusConnector.kt` onto `turn.tool.update`.**
  Replace `TaskSnapshotItem` and the handler:

```kotlin
/**
 * Immutable snapshot of one tool-call row. Built from [ServerMessage.TurnToolUpdate].
 *
 * IDENTITY IS [toolCallId] — one row per model-emitted tool call. [taskId] is present
 * only for a BACKGROUND tool (delegateTask), which returns a handle immediately and
 * completes later via a stimulus; a foreground tool has none.
 */
data class TaskSnapshotItem(
    val toolCallId: String,
    val toolName: String,
    val turnId: String,
    /** "running" | "done" | "error". */
    val status: String,
    /** Auto-derived short preview of the tool's args; "" when absent. USER CONTENT — never logged. */
    val argsPreview: String,
    val startedAtMs: Long,
    val endedAtMs: Long? = null,
    val taskId: String? = null,
)

class TaskStatusConnector(
    private val onUpdate: ((TaskSnapshotItem) -> Unit)? = null,
    private val onList: ((List<TaskSnapshotItem>) -> Unit)? = null,
    private val onEvent: ((SdkEvent) -> Unit)? = null,
) : Connector {
    override val capability: String = CAPABILITY

    private val log = createLogger("connector", "task-status")

    private val tasks = LinkedHashMap<String, TaskSnapshotItem>()

    /** All rows, ordered by startedAtMs ascending. Safe to read synchronously. */
    fun list(): List<TaskSnapshotItem> = tasks.values.sortedBy { it.startedAtMs }

    override fun handle(msg: ServerMessage) {
        when (msg) {
            is ServerMessage.TurnToolUpdate -> onToolUpdate(msg)
            else -> Unit // not owned by this connector
        }
    }

    private fun onToolUpdate(msg: ServerMessage.TurnToolUpdate) {
        val item = TaskSnapshotItem(
            toolCallId = msg.toolCallId,
            toolName = msg.toolName,
            turnId = msg.turnId,
            status = msg.status,
            argsPreview = msg.argsPreview,
            startedAtMs = msg.startedAtMs,
            endedAtMs = msg.endedAtMs,
            taskId = msg.taskId,
        )
        // argsPreview is user content — ids/status/timing only.
        log.info(
            "turn.tool.update",
            mapOf(
                "toolCallId" to item.toolCallId,
                "turnId" to item.turnId,
                "toolName" to item.toolName,
                "status" to item.status,
                "taskId" to item.taskId,
                "endedAtMs" to item.endedAtMs,
            ),
        )
        tasks[item.toolCallId] = item
        onEvent?.invoke(SdkEvent.TaskUpserted(item))
        onUpdate?.invoke(item)
        onList?.invoke(list())
    }

    fun clear() {
        log.info("clear", mapOf("count" to tasks.size))
        tasks.clear()
    }

    companion object {
        const val CAPABILITY: String = "task.status"
    }
}
```

- [ ] **Step 10: Rebase `connectors/InFlightMessageConnector.kt` onto the turn frames (frame swap only).**
  Keep the single-slot logic for now — the multi-turn rewrite is Step 20, driven by its own failing test. Rename `InFlightMessage.cycleId` → `turnId`, rename every local `cycleId` → `turnId`, and replace the handler:

```kotlin
    override fun handle(msg: ServerMessage) {
        when (msg) {
            is ServerMessage.TurnStarted -> onTurnStarted(msg.turnId)
            is ServerMessage.TurnTextDelta -> onDelta(msg.turnId, msg.text)
            is ServerMessage.TurnCompleted -> onDone(msg.turnId)
            is ServerMessage.TurnAborted -> onAborted(msg.turnId)
            else -> Unit // not owned by this connector
        }
    }
```

  Adjust `onTurnStarted(turnId: String)`, `onDelta(turnId: String, text: String)` (drop the null guards — the frame fields are non-null now; keep an `isEmpty()` guard), `onDone(turnId: String)`, `onAborted(turnId: String)` accordingly, and `ChatMessage(..., cycleId = ...)` → `turnId = ...`.

- [ ] **Step 11: Rebase `connectors/ConversationHistoryConnector.kt`.**
  In `onEntryFrame`, replace the enrich block and its log key:

```kotlin
        // Re-attach the gateway's frame turnId onto an assistant entry so the committed
        // twin can be suppressed by exact id while its live bubble reveals. The wire item
        // strips turnId; the frame carries it. No client-side derivation anywhere.
        val item = msg.item
        val enriched =
            if (item is ConversationFeedItem.Assistant && msg.turnId != null) item.copy(turnId = msg.turnId)
            else item
```

  and `"cycleId" to (msg.cycleId ?: "-")` → `"turnId" to (msg.turnId ?: "-")`. Update the surrounding comments (lines ~180–186) the same way.

- [ ] **Step 12: Rename the FSM inputs in `sdk/AudioFsm.kt` and pin the queue row.**
  Rename `AudioInput.CycleStart` → `AudioInput.TurnStart` and `AudioInput.CycleDone` → `AudioInput.TurnDone` (4 call sites inside the file), and update their KDoc (`cycle.started` → `turn.started`, `cycle.done` → `turn.completed`). **The transition table is PRESERVED, not superseded** — every row keeps its target state. Add the previously-unwritten row to the header table, directly under the `ASSISTANT_SPEAKING CycleDone` line:

```
//   ASSISTANT_SPEAKING TurnDone        → ASSISTANT_SPEAKING (audio still draining)
//   ASSISTANT_SPEAKING AudioStart      → ASSISTANT_SPEAKING (design §7.2: the next turn's
//                                        audio QUEUES BEHIND; it never restarts the state)
```

  and make that row explicit in `fromAssistantSpeaking` so the intent survives future edits:

```kotlin
    private fun fromAssistantSpeaking(input: AudioInput): AudioState = when (input) {
        is AudioInput.AudioDone -> AudioState.LISTENING
        is AudioInput.MicOnset -> AudioState.INTERRUPTING
        is AudioInput.Interrupt -> AudioState.INTERRUPTING
        // §7.2: a follow-up turn's audio.start queues behind the audio already playing —
        // it must NOT bounce the display state. Stay speaking.
        is AudioInput.AudioStart -> AudioState.ASSISTANT_SPEAKING
        else -> state // TurnDone stays: audio still physically draining.
    }
```

- [ ] **Step 13: Mechanical `cycleId` → `turnId` rename in `audioio/AudioPipeline.kt`.**
  Rename the parameters of `onAudioStart` / `onAudioFrame` / `onAudioDone` / `onPlaybackStop`, the field `activeCycleId` → `activeTurnId`, `transition(input, cycleId)` → `transition(input, turnId)`, and every `"cycleId" to …` log key → `"turnId" to …`. Also rename `AudioInput.CycleStart`/`CycleDone` references if any appear. **Behaviour is untouched in this step** — the supersede branch stays for now; Step 17 replaces it under a failing test.

- [ ] **Step 14: Rename the audio hook parameters in `sdk/SdkAudio.kt` and `sdk/SdkConnectors.kt`.**
  In `SdkConnectors.kt` rename `AudioDownlinkHooks`' lambda parameters `cycleId` → `turnId` (all four) and the `audioOutput` wiring lambdas. In `SdkAudio.kt` only comments change (`connector.audio.start` → `turn.audio.start`, "TTS cycle" → "TTS turn"). Also in `SdkConnectors.kt` rename the property `val cycleError = CycleErrorConnector(...)` → `val turnError = TurnErrorConnector(...)`, update the import, and update the `all` list entry.

- [ ] **Step 15: Rebase `sdk/SdkLifecycle.kt`.**
  Rename `LifecycleHooks.onCycleSettled()` → `onTurnSettled()` (update its KDoc: "A turn reached a natural boundary (completed / aborted)") and replace the intercept rows:

```kotlin
            // Turn boundary → coalesce the durable resume-cursor write (Task 4.7).
            is ServerMessage.TurnCompleted -> hooks.onTurnSettled()
            is ServerMessage.TurnAborted -> hooks.onTurnSettled()
```

- [ ] **Step 16: Rebase `sdk/SdkState.kt`, `sdk/StateDeriver.kt`, `sdk/SentientSdk.kt`.**
  - `SdkState.kt`: `ChatMessage.cycleId` → `turnId`; update the KDoc for `turnId` ("Turn that produced this assistant message (UI join key for tools). Null when unknown.") and for `tools` ("Tool rows grouped onto this message by shared turnId").
  - `StateDeriver.kt`: in `deriveMessages` and `committedMessage`, `inflight.cycleId` → `inflight.turnId`, `item.cycleId` → `item.turnId`, `ChatMessage(cycleId = …)` → `turnId = …`; rename the helper to `private fun toolsFor(turnId: String?, tasks: List<TaskSnapshotItem>) = if (turnId == null) emptyList() else tasks.filter { it.turnId == turnId }`. Rename the dead slice `var lastCycleError` → `var lastTurnError`.
  - `SentientSdk.kt`: `connectors.cycleError.*` → `connectors.turnError.*` (5 call sites: `interrupt()`, `newChat`, `switchSession`, `sendNewChat`, plus the `LifecycleHooks` object), and `override fun onCycleSettled()` → `override fun onTurnSettled()`.

- [ ] **Step 17: Sweep the commonTest fixtures onto the new frames.**
  Mechanical only — same assertions, new frame constructors. Apply across every file in the "Tests updated by the rename sweep" list:
  `ServerMessage.CycleStarted(cycleId = X, triggerKind = Y)` → `ServerMessage.TurnStarted(turnId = X, trigger = Y)`;
  `ServerMessage.MessageDelta(cycleId = X, delta = Y)` → `ServerMessage.TurnTextDelta(turnId = X, text = Y)`;
  `ServerMessage.MessageDone(cycleId = X)` and `ServerMessage.CycleCompleted(cycleId = X)` → `ServerMessage.TurnCompleted(turnId = X)`;
  `ServerMessage.CycleAborted(cycleId = X, reason = R)` → `ServerMessage.TurnAborted(turnId = X, cutoff = R)`;
  `ServerMessage.ConnectorAudioStart(cycleId = X, encoding = E, sampleRate = S)` → `ServerMessage.TurnAudioStart(turnId = X, encoding = E ?: "", sampleRate = S ?: 0)`;
  `ServerMessage.ConnectorAudioDone(cycleId = X)` → `ServerMessage.TurnAudioDone(turnId = X)`;
  `ServerMessage.TaskUpdate(taskId = T, toolName = N, cycleId = C, status = S, argsPreview = P, startedAtMs = A, endedAtMs = E)` → `ServerMessage.TurnToolUpdate(turnId = C, toolCallId = T, toolName = N, status = S, argsPreview = P, startedAtMs = A, endedAtMs = E)`;
  `ServerMessage.PlaybackStop(cycleId = X, reason = R)` → `ServerMessage.PlaybackStop(turnId = X ?: "", reason = R ?: "")`;
  `TaskSnapshotItem(taskId = …, cycleId = …)` → `TaskSnapshotItem(toolCallId = …, turnId = …)`;
  `SdkEvent.CycleDone(cycleId = X)` → `SdkEvent.TurnDone(turnId = X)`; `SdkEvent.CycleAborted(cycleId = X, kind = K)` → `SdkEvent.TurnAborted(turnId = X, cutoff = K ?: "")`;
  `ChatMessage(cycleId = …)` → `ChatMessage(turnId = …)`; `AudioInput.CycleStart/CycleDone` → `AudioInput.TurnStart/TurnDone`.
  Also: `git mv` `connectors/CycleErrorConnectorTest.kt` → `connectors/TurnErrorConnectorTest.kt`, rename the class + `CycleErrorConnector()` constructions to `TurnErrorConnector()`. In `WireDecodeTest.known_frame_decodes_to_typed_success`, use `{"type":"turn.completed","turnId":"t1"}` / `ServerMessage.TurnCompleted`. In `WireSerializationTest.gateway_push_frame_seq_epoch_are_peelable`, use `{"type":"turn.text.delta","turnId":"t1","text":"hi","seq":7,"epoch":2}`.

- [ ] **Step 18: Sweep `shared/mobile-data` onto the new names.**
  - `usecase/RevealReducer.kt`: `RevealBubble.cycleId` → `turnId`; `RevealBubble(e.cycleId, …)` → `RevealBubble(e.turnId, …)` (both sites); `upsert` de-dups on the new identity: `(list.filterNot { it.toolCallId == t.toolCallId } + t).sortedBy { it.startedAtMs }`.
  - `usecase/ObserveChatUseCase.kt`: `val liveCycleId = rs.bubble?.cycleId` → `val liveTurnId = rs.bubble?.turnId`; `committed.filter { it.cycleId != liveCycleId }` → `committed.filter { it.turnId != liveTurnId }`; `ChatMessage(… cycleId = it.cycleId)` → `turnId = it.turnId`; update the KDoc's "one-bubble-per-cycle" → "one-bubble-per-turn".
  - `commonTest/.../usecase/RevealReducerTest.kt`, `usecase/ObserveChatUseCaseTest.kt`, `model/ChatModelTest.kt`: same mechanical rename.

- [ ] **Step 19: Run the wire test, then the full shared gate, and commit.**

```
./gradlew :shared:mobile-sdk:testDebugUnitTest --tests "io.sentient.mobilesdk.protocol.WireSerializationTest"
./gradlew :shared:mobile-sdk:testDebugUnitTest :shared:mobile-data:testDebugUnitTest
./gradlew :shared:mobile-sdk:compileKotlinIosSimulatorArm64 :shared:mobile-data:compileKotlinIosSimulatorArm64
```

  All green. Commit:

```
git add -A shared/mobile-sdk shared/mobile-data
git commit -m "feat(mobile-sdk): adopt the 2.0 turn/permission/delegation wire frames"
```

##### B. Multi-turn in-flight text (fixes the single-current clobber)

- [ ] **Step 20: Write the failing multi-turn test.**
  Append to `shared/mobile-sdk/src/commonTest/kotlin/io/sentient/mobilesdk/connectors/InFlightMessageConnectorTest.kt`:

```kotlin
    // ── §7.2 multi-turn: two turns can be open at once; neither may clobber the other ──
    // Pins the FSM invariant: the per-turn buffer is keyed by turnId, so a follow-up
    // turn opening mid-stream never discards the earlier turn's accumulated text.

    @Test
    fun twoOpenTurns_accumulateIndependently_andCommitTheirOwnText() {
        val committed = mutableListOf<Pair<String?, String>>()
        val c = InFlightMessageConnector(
            onEvent = { e -> if (e is SdkEvent.MessageCommitted) committed += e.message.turnId to e.message.content },
        )

        c.handle(ServerMessage.TurnStarted(turnId = "t1"))
        c.handle(ServerMessage.TurnTextDelta(turnId = "t1", text = "one-"))
        c.handle(ServerMessage.TurnStarted(turnId = "t2"))
        c.handle(ServerMessage.TurnTextDelta(turnId = "t2", text = "two-"))
        c.handle(ServerMessage.TurnTextDelta(turnId = "t1", text = "tail"))
        c.handle(ServerMessage.TurnTextDelta(turnId = "t2", text = "tail"))

        assertEquals("t2", c.inflight()?.turnId, "the newest open turn renders the live bubble")

        c.handle(ServerMessage.TurnCompleted(turnId = "t1"))
        c.handle(ServerMessage.TurnCompleted(turnId = "t2"))

        assertEquals(listOf("t1" to "one-tail", "t2" to "two-tail"), committed)
        assertEquals(null, c.inflight(), "no buffer left open once both turns completed")
    }

    @Test
    fun abortOfOneTurn_leavesTheOtherTurnsBufferIntact() {
        val committed = mutableListOf<String>()
        val c = InFlightMessageConnector(
            onEvent = { e -> if (e is SdkEvent.MessageCommitted) committed += e.message.content },
        )

        c.handle(ServerMessage.TurnStarted(turnId = "t1"))
        c.handle(ServerMessage.TurnTextDelta(turnId = "t1", text = "keep-me"))
        c.handle(ServerMessage.TurnStarted(turnId = "t2"))
        c.handle(ServerMessage.TurnTextDelta(turnId = "t2", text = "drop-me"))
        c.handle(ServerMessage.TurnAborted(turnId = "t2", cutoff = "barge-in"))
        c.handle(ServerMessage.TurnCompleted(turnId = "t1"))

        assertEquals(listOf("keep-me"), committed, "aborting t2 must not touch t1's buffer")
    }
```

  Run: `./gradlew :shared:mobile-sdk:testDebugUnitTest --tests "io.sentient.mobilesdk.connectors.InFlightMessageConnectorTest"`
  Expected failure: `twoOpenTurns_accumulateIndependently_andCommitTheirOwnText` fails with `expected:<[(t1, one-tail), (t2, two-tail)]> but was:<[(t1, ), (t2, two-tail)]>` — the single `current` slot was replaced when `t2` started, so `t1`'s text was lost.

- [ ] **Step 21: Key the buffers by turnId — minimal implementation.**
  Replace the state + handlers in `connectors/InFlightMessageConnector.kt` (keep the file header, update its frame table to `turn.*`):

```kotlin
/** The streaming buffer for one in-flight turn. */
data class InFlightMessage(
    val turnId: String,
    val text: String,
)

class InFlightMessageConnector(
    private val onUpdate: ((InFlightMessage?) -> Unit)? = null,
    private val onEvent: ((SdkEvent) -> Unit)? = null,
) : Connector {
    override val capability: String = CAPABILITY

    private val log = createLogger("connector", "inflight-message")

    // ONE BUFFER PER TURN, in arrival order. A 2.0 follow-up turn (§4.5/§7.2) can open
    // while the previous turn's deltas are still landing; the pre-2.0 single `current`
    // slot silently DISCARDED the earlier turn's accumulated text. Insertion order makes
    // [inflight] the newest still-open turn — the one the live bubble renders.
    private val buffers = LinkedHashMap<String, InFlightMessage>()

    /** Newest still-open streaming buffer; null when no turn is mid-stream. */
    fun inflight(): InFlightMessage? = buffers.values.lastOrNull()

    override fun handle(msg: ServerMessage) {
        when (msg) {
            is ServerMessage.TurnStarted -> onTurnStarted(msg.turnId)
            is ServerMessage.TurnTextDelta -> onDelta(msg.turnId, msg.text)
            is ServerMessage.TurnCompleted -> onCompleted(msg.turnId)
            is ServerMessage.TurnAborted -> onAborted(msg.turnId, msg.cutoff)
            else -> Unit // not owned by this connector
        }
    }

    private fun onTurnStarted(turnId: String) {
        if (turnId.isEmpty()) return
        buffers[turnId] = InFlightMessage(turnId = turnId, text = "")
        log.info("seed", mapOf("turnId" to turnId, "open" to buffers.size))
        onUpdate?.invoke(inflight())
        onEvent?.invoke(SdkEvent.MessageStarted(turnId))
    }

    private fun onDelta(turnId: String, text: String) {
        if (turnId.isEmpty() || text.isEmpty()) return
        // Absent buffer → create: a delta may legitimately precede its turn.started on a
        // resume replay. Content is NEVER logged — lengths only (PrivacyGuardTest).
        val next = InFlightMessage(turnId = turnId, text = (buffers[turnId]?.text ?: "") + text)
        buffers[turnId] = next
        log.debug(
            "delta",
            mapOf("turnId" to turnId, "deltaLen" to text.length, "totalLen" to next.text.length, "open" to buffers.size),
        )
        onUpdate?.invoke(inflight())
        onEvent?.invoke(SdkEvent.MessageDelta(turnId = turnId, chunk = text)) // one event per chunk — never batched
    }

    private fun onCompleted(turnId: String) {
        // Unknown turn → no-op: committing "" here would drain ANOTHER turn's live bubble.
        val done = buffers.remove(turnId) ?: return
        log.info("done", mapOf("turnId" to turnId, "totalLen" to done.text.length, "open" to buffers.size))
        onUpdate?.invoke(inflight())
        // ts=0: clear-signal; committed text is authoritative via feed/timeline.
        onEvent?.invoke(
            SdkEvent.MessageCommitted(
                ChatMessage(ts = 0, role = "assistant", content = done.text, streaming = false, turnId = turnId),
            ),
        )
    }

    private fun onAborted(turnId: String, cutoff: String) {
        val dropped = buffers.remove(turnId) ?: return
        log.info(
            "aborted",
            mapOf("turnId" to turnId, "cutoff" to cutoff, "droppedLen" to dropped.text.length, "open" to buffers.size),
        )
        onUpdate?.invoke(inflight())
        // No MessageCommitted on abort; the abort surfaces as SdkEvent.TurnAborted (TurnErrorConnector).
    }

    companion object {
        const val CAPABILITY: String = "message.stream"
    }
}
```

  Run: `./gradlew :shared:mobile-sdk:testDebugUnitTest --tests "io.sentient.mobilesdk.connectors.InFlightMessageConnectorTest" --tests "io.sentient.mobilesdk.connectors.InFlightEventsTest" --tests "io.sentient.mobilesdk.vitals.PrivacyGuardTest"`
  Expected: green. Commit:

```
git add -A shared/mobile-sdk
git commit -m "fix(mobile-sdk): key in-flight assistant text by turnId so a follow-up turn cannot clobber it"
```

##### C. Audio queue inversion (§7.2 — the largest concrete gap)

- [ ] **Step 22: Write the failing turn-queue test.**
  Create `shared/mobile-sdk/src/commonTest/kotlin/io/sentient/mobilesdk/audioio/AudioPipelineTurnQueueTest.kt`:

```kotlin
// ---------------------------------------------------------------------------
// AudioPipelineTurnQueueTest — KEEPER (.claude/rules/testing.md): pins the design
// §7.2 invariant "the gateway never stops its own audio; a new turnId QUEUES BEHIND".
// Pre-2.0 the pipeline treated a different id as a SUPERSEDE and called flushPlayback(),
// cutting the tail off every self-initiated follow-up turn. That regression is invisible
// in unit-free code and expensive to catch on-device, so it is pinned here.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.audioio

import io.sentient.mobilesdk.fakes.FakeOpusDecoderPort
import io.sentient.mobilesdk.sdk.AudioFsm
import io.sentient.mobilesdk.sdk.AudioState
import io.sentient.mobilesdk.voice.io.FakeVoiceAudio
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class AudioPipelineTurnQueueTest {

    private fun pipeline(
        sink: FakeVoiceAudio,
        scope: CoroutineScope,
        fsm: AudioFsm = AudioFsm(),
        onStateChanged: (Boolean, AudioState) -> Unit = { _, _ -> },
        opusDecoder: io.sentient.mobilesdk.audio.opus.OpusDecoderPort = FakeOpusDecoderPort(),
    ): AudioPipeline = AudioPipeline(
        playback = sink,
        opusDecoder = opusDecoder,
        fsm = fsm,
        scope = scope,
        outputSampleRate = 24_000,
        onStateChanged = onStateChanged,
        playbackDrainSettleMs = 100,
        armPlayback = { sink.configure(mic = false, playback = true); true },
        disarmPlayback = { },
    )

    @Test
    fun followUpTurn_whilePriorTurnStillDraining_neverFlushes() = runTest {
        val sink = FakeVoiceAudio(initialPlaybackIdle = false)
        val p = pipeline(sink, this)

        p.onAudioStart("t1", encoding = "pcm16", sampleRate = 24_000)
        advanceUntilIdle()
        p.onAudioFrame(byteArrayOf(1), "t1")
        p.onAudioDone("t1") // gateway finished SENDING t1; the speaker is still draining

        // The follow-up turn's audio arrives while t1's tail is still in the player.
        p.onAudioStart("t2", encoding = "pcm16", sampleRate = 24_000)
        advanceUntilIdle()
        p.onAudioFrame(byteArrayOf(2), "t2")

        assertEquals(0, sink.flushCount, "a new turnId must NEVER flush in-flight audio (§7.2)")
        assertEquals(2, sink.playedFrames.size, "t2's frame is appended behind t1's, not instead of it")
        assertTrue(sink.playedFrames[0].contentEquals(byteArrayOf(1)), "t1's frame stays first")
        assertTrue(sink.playedFrames[1].contentEquals(byteArrayOf(2)), "t2's frame plays after it")
    }

    @Test
    fun overlappingTurn_buffersBehindHead_thenDrainsInOrderOnHeadDone() = runTest {
        val sink = FakeVoiceAudio()
        val p = pipeline(sink, this)

        p.onAudioStart("t1", encoding = "pcm16", sampleRate = 24_000)
        advanceUntilIdle()
        p.onAudioFrame(byteArrayOf(1), "t1")

        // t2 opens BEFORE t1 finished streaming → its bytes must wait, not interleave.
        p.onAudioStart("t2", encoding = "pcm16", sampleRate = 24_000)
        p.onAudioFrame(byteArrayOf(20), "t2")
        p.onAudioFrame(byteArrayOf(21), "t2")
        p.onAudioFrame(byteArrayOf(2), "t1")
        assertEquals(2, sink.playedFrames.size, "only the head turn's frames reach the player")

        p.onAudioDone("t1")
        advanceUntilIdle()
        assertEquals(0, sink.flushCount, "promotion is not a flush")
        assertEquals(
            listOf(1.toByte(), 2.toByte(), 20.toByte(), 21.toByte()),
            sink.playedFrames.map { it[0] },
            "t2's buffered frames drain after t1's, in arrival order",
        )
    }

    @Test
    fun speakingHeldAcrossTheQueue_clearsOnlyAfterTheLastTurnDrains() = runTest {
        var speaking = false
        var state = AudioState.INACTIVE
        val sink = FakeVoiceAudio(initialPlaybackIdle = false)
        val p = pipeline(sink, this, onStateChanged = { sp, st -> speaking = sp; state = st })

        p.onAudioStart("t1", encoding = "pcm16", sampleRate = 24_000)
        runCurrent()
        p.onAudioFrame(byteArrayOf(1), "t1")
        p.onAudioStart("t2", encoding = "pcm16", sampleRate = 24_000)
        p.onAudioFrame(byteArrayOf(2), "t2")
        p.onAudioDone("t1")
        advanceTimeBy(500)
        runCurrent()
        assertTrue(speaking, "speaking is held while a queued turn is still to play")

        p.onAudioDone("t2")
        advanceUntilIdle()
        sink.setPlaybackIdle(true)
        advanceTimeBy(50 + 100 + 20)
        runCurrent()
        assertTrue(!speaking, "speaking clears once the LAST queued turn physically drained")
        assertEquals(AudioState.LISTENING, state, "FSM leaves ASSISTANT_SPEAKING only at the end of the queue")
    }

    @Test
    fun playbackStop_flushesEverything_includingQueuedTurns() = runTest {
        val sink = FakeVoiceAudio()
        val p = pipeline(sink, this)

        p.onAudioStart("t1", encoding = "pcm16", sampleRate = 24_000)
        advanceUntilIdle()
        p.onAudioFrame(byteArrayOf(1), "t1")
        p.onAudioStart("t2", encoding = "pcm16", sampleRate = 24_000)
        p.onAudioFrame(byteArrayOf(2), "t2")

        p.onPlaybackStop(reason = "barge-in", turnId = "t1")
        assertEquals(1, sink.flushCount, "barge-in is the ONLY thing that flushes")

        // The queue is gone: a late frame for the dropped turn must not resurrect it.
        p.onAudioFrame(byteArrayOf(3), "t2")
        assertEquals(0, sink.playedFrames.size, "no audio survives a barge-in flush")
    }

    @Test
    fun queuedOpusTurn_isNotDecodedUntilPromoted() = runTest {
        val sink = FakeVoiceAudio()
        val dec = FakeOpusDecoderPort { chunk -> listOf(byteArrayOf(100, chunk.first())) }
        val p = pipeline(sink, this, opusDecoder = dec)

        p.onAudioStart("t1", encoding = "opus", sampleRate = 48_000)
        advanceUntilIdle()
        p.onAudioFrame(byteArrayOf(1), "t1")
        p.onAudioStart("t2", encoding = "opus", sampleRate = 48_000)
        p.onAudioFrame(byteArrayOf(2), "t2")

        assertEquals(1, dec.decodedChunks.size, "a queued turn's chunks must not enter the head turn's decoder")

        p.onAudioDone("t1")
        advanceUntilIdle()
        assertEquals(2, dec.decodedChunks.size, "the queued chunk decodes once its turn is promoted")
    }
}
```

  Run: `./gradlew :shared:mobile-sdk:testDebugUnitTest --tests "io.sentient.mobilesdk.audioio.AudioPipelineTurnQueueTest"`
  Expected failure: `followUpTurn_whilePriorTurnStillDraining_neverFlushes` fails with `expected:<0> but was:<1>` (the supersede branch called `flushPlayback()`), and `overlappingTurn_buffersBehindHead_thenDrainsInOrderOnHeadDone` fails with `expected:<2> but was:<3>` (t2's frame played immediately).

- [ ] **Step 23: Create the pure `TurnAudioQueue`.**
  Create `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/audioio/TurnAudioQueue.kt`:

```kotlin
// ---------------------------------------------------------------------------
// TurnAudioQueue — the per-turn downlink audio FIFO (design spec §7.2).
//
// The gateway NEVER stops its own audio (§4.6/§7.2): a self-initiated follow-up turn's
// TTS arrives while the previous turn's audio may still be playing, and it must QUEUE
// BEHIND it. Pre-2.0 the pipeline held ONE `activeCycleId` and treated a different id as
// a supersede — flushPlayback() + drop pending — which cut the tail off every follow-up
// turn. This structure replaces that single slot.
//
// One segment per turn, in arrival order. Only the HEAD segment streams into the player;
// a segment queued behind buffers its RAW WIRE bytes until promoted. Buffering the raw
// bytes (not decoded PCM) is what keeps the single stateful OGG-Opus decoder safe — a
// queued turn's chunks must never be fed through the decoder the head turn is using.
//
// Pure: no coroutines, no playback, no logging (AudioPipeline owns the log trail and the
// physical sink). Flushing is NOT this type's business — a flush is barge-in / interrupt
// only, and clears the whole queue via [clear].
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.audioio

/** One turn's downlink audio stream. [bufferedBytes] is non-zero only while queued behind. */
internal class TurnAudioSegment(val turnId: String, val opus: Boolean) {
    private val frames = ArrayDeque<ByteArray>()

    var bufferedBytes: Int = 0
        private set

    /** True once turn.audio.done landed — the gateway will send no more frames for it. */
    var streamDone: Boolean = false

    /** Depth of the deferred buffer (frames), for the log trail. */
    val depth: Int get() = frames.size

    /** Buffer one raw wire frame. Drops OLDEST past [maxBytes] (never the newest);
     *  returns the bytes dropped so the caller can log the degraded path. */
    fun buffer(frame: ByteArray, maxBytes: Int): Int {
        frames.addLast(frame)
        bufferedBytes += frame.size
        var dropped = 0
        while (bufferedBytes > maxBytes && frames.size > 1) {
            val old = frames.removeFirst()
            bufferedBytes -= old.size
            dropped += old.size
        }
        return dropped
    }

    /** Take every buffered frame in arrival order and empty the buffer. */
    fun takeBuffered(): List<ByteArray> {
        val out = frames.toList()
        frames.clear()
        bufferedBytes = 0
        return out
    }
}

/** FIFO of per-turn audio segments. [maxBufferedBytesPerTurn] bounds each queued turn's
 *  deferred buffer (drop-oldest), so a stalled head can never grow memory without limit. */
internal class TurnAudioQueue(private val maxBufferedBytesPerTurn: Int) {
    private val segments = ArrayDeque<TurnAudioSegment>()

    val head: TurnAudioSegment? get() = segments.firstOrNull()
    val depth: Int get() = segments.size
    val isEmpty: Boolean get() = segments.isEmpty()

    fun segmentFor(turnId: String): TurnAudioSegment? = segments.firstOrNull { it.turnId == turnId }

    fun isHead(turnId: String): Boolean = segments.firstOrNull()?.turnId == turnId

    /**
     * Open a segment for [turnId]. Returns true when it became the HEAD (nothing was
     * playing) and false when it queued BEHIND an in-flight turn. A duplicate
     * turn.audio.start never opens a second segment; it reports whether that turn is head.
     */
    fun open(turnId: String, opus: Boolean): Boolean {
        val existing = segmentFor(turnId)
        if (existing != null) return isHead(turnId)
        val fresh = segments.isEmpty()
        segments.addLast(TurnAudioSegment(turnId, opus))
        return fresh
    }

    /** Buffer a frame for a turn queued behind the head. Returns bytes dropped by the bound. */
    fun bufferBehind(turnId: String, frame: ByteArray): Int =
        segmentFor(turnId)?.buffer(frame, maxBufferedBytesPerTurn) ?: 0

    fun markStreamDone(turnId: String) {
        segmentFor(turnId)?.streamDone = true
    }

    /** Drop the head and return the next segment (now the head), or null when drained. */
    fun promote(): TurnAudioSegment? {
        segments.removeFirstOrNull()
        return segments.firstOrNull()
    }

    fun clear() = segments.clear()
}
```

- [ ] **Step 24: Replace the supersede branch in `AudioPipeline` with the queue.**
  In `audioio/AudioPipeline.kt`: rename the constant `DEFAULT_HOLD_BUFFER_MAX_BYTES` → `DEFAULT_DEFERRED_BUFFER_MAX_BYTES` (same value and rationale; it now bounds both the hold buffer and each queued turn's buffer — update its KDoc accordingly). Add the constructor param after `holdBufferMaxBytes`:

```kotlin
    private val holdBufferMaxBytes: Int = DEFAULT_DEFERRED_BUFFER_MAX_BYTES,
    /** Bound (bytes) on EACH queued-behind turn's deferred buffer (§7.2). Same drop-oldest
     *  rationale as the hold buffer; separate so a test can shrink one without the other. */
    queueBufferMaxBytes: Int = DEFAULT_DEFERRED_BUFFER_MAX_BYTES,
```

  Delete the fields `private var activeTurnId = ""` and `private var holdStreamDone = false`, and add:

```kotlin
    // Per-turn downlink FIFO (§7.2). Replaces the single activeTurnId slot: a NEW turn
    // queues BEHIND the audio already playing and NEVER flushes it. flushPlayback() is
    // reserved for the two user actions — barge-in and interrupt (onPlaybackStop) — plus
    // the transient teardown (suspendPlayback).
    private val queue = TurnAudioQueue(maxBufferedBytesPerTurn = queueBufferMaxBytes)

    // turnId of the most recent turn.audio.start; the id the drain-watch finalizes under
    // and the id stopLocal reports. Cleared with the queue.
    private var lastTurnId = ""
```

  Replace `onAudioStart`, `onAudioFrame`, `onAudioDone` and add the three helpers:

```kotlin
    /**
     * turn.audio.start. A FRESH head arms the decoder + LAZY-ARMS the engine for this turn.
     * A turn arriving while another is in flight QUEUES BEHIND it (design §7.2): no flush,
     * no decoder reset, no re-arm, no FSM transition — the pipeline is already speaking and
     * stays speaking. [encoding]/[sampleRate] come off the wire frame: opus decodes through
     * opusDecoder (libopus always outputs 48 kHz, ignoring the announced rate); pcm passes
     * through at the announced rate ([outputSampleRate] fallback — logging only).
     */
    fun onAudioStart(turnId: String, encoding: String? = null, sampleRate: Int? = null) {
        val opus = encoding.equals(ENCODING_OPUS, ignoreCase = true)
        val becameHead = queue.open(turnId, opus)
        lastTurnId = turnId
        if (!becameHead) {
            log.info(
                "downlink-queue-behind",
                mapOf("turnId" to turnId, "head" to (queue.head?.turnId ?: ""), "depth" to queue.depth, "opus" to opus),
            )
            return
        }
        // Fresh head: this turn owns the decoder, the arm, and the drain watch from here.
        drainJob?.cancel()
        framesDone = false
        opusMode = opus
        val playbackRate = if (opusMode) OPUS_DECODE_RATE_HZ else (sampleRate ?: outputSampleRate)
        log.info(
            "downlink-start",
            mapOf("turnId" to turnId, "opusMode" to opusMode, "playbackRate" to playbackRate, "depth" to queue.depth),
        )
        if (opusMode) opusDecoder.reset()
        // HOLD (spec §7.3): buffer only — do NOT flip speaking, do NOT arm playback, do NOT
        // transition the FSM. Frames accumulate in [pendingFrames] and flush on [endHold].
        if (holdDeferred) {
            log.info("downlink-hold-start", mapOf("turnId" to turnId, "opusMode" to opusMode))
            return
        }
        isSpeaking = true
        armPlaybackOnce()
        transition(AudioInput.AudioStart, turnId)
    }

    /**
     * Binary downlink frame. HEAD turn: decode (opus) or pass through (pcm) straight to the
     * ready/pending path. QUEUED turn: buffer the RAW bytes — decoding now would corrupt the
     * head turn's decoder state. Unknown turn (already drained / flushed): stale-drop.
     */
    fun onAudioFrame(frame: ByteArray, turnId: String) {
        if (playback == null) return
        if (queue.isHead(turnId)) {
            forwardFrame(frame, turnId)
            return
        }
        if (queue.segmentFor(turnId) != null) {
            val dropped = queue.bufferBehind(turnId, frame)
            if (dropped > 0) {
                log.warn(
                    "queue-buffer-overflow",
                    mapOf("reason" to "queue-buffer-overflow", "turnId" to turnId, "droppedBytes" to dropped),
                )
            }
            log.debug(
                "downlink-frame-queued",
                mapOf("bytes" to frame.size, "turnId" to turnId, "depth" to queue.depth),
            )
            return
        }
        log.debug(
            "downlink-frame-stale-drop",
            mapOf("frameTurn" to turnId, "head" to (queue.head?.turnId ?: ""), "reason" to "no-open-segment"),
        )
    }

    /** Decode-or-passthrough one raw frame for the turn currently streaming into the player. */
    private fun forwardFrame(frame: ByteArray, turnId: String) {
        if (!opusMode) {
            enqueueOrBuffer(frame, turnId)
            return
        }
        val decoded = opusDecoder.decode(frame)
        log.debug(
            "downlink-decode",
            mapOf("oggBytes" to frame.size, "pcmFrames" to decoded.size, "turnId" to turnId),
        )
        for (pcm in decoded) enqueueOrBuffer(pcm, turnId)
    }

    /**
     * turn.audio.done: the server finished SENDING this turn's frames — the player is still
     * playing its buffered tail. Mark the segment done; the HEAD then either promotes the
     * next queued turn or (queue empty) starts the physical-drain watch.
     */
    fun onAudioDone(turnId: String) {
        val segment = queue.segmentFor(turnId)
        if (segment == null) {
            log.debug(
                "downlink-done-stale-drop",
                mapOf("doneTurn" to turnId, "head" to (queue.head?.turnId ?: "")),
            )
            return
        }
        segment.streamDone = true
        log.info(
            "downlink-done",
            mapOf("turnId" to turnId, "isHead" to queue.isHead(turnId), "depth" to queue.depth),
        )
        if (!queue.isHead(turnId)) return // a queued turn finished early; promotion drains it
        if (opusMode) opusDecoder.reset()
        // HOLD (spec §7.3): nothing is playing, so there is nothing to drain. [endHold] arms
        // + flushes, and the post-flush hook settles the head from there.
        if (holdDeferred) {
            log.info("downlink-hold-done", mapOf("turnId" to turnId))
            return
        }
        finishHeadSegment()
    }

    /**
     * The head turn finished streaming. Promote queued turns (handing their buffered bytes
     * to the player, in order) until one is still streaming; when the queue drains, arm the
     * physical-drain watch. Deferred when bytes are still waiting on the lazy arm — a
     * pre-flush isPlaybackIdle=true would false-finalize and clear speaking early.
     */
    private fun finishHeadSegment() {
        if (promoteUntilStreaming() != null) return // a queued turn took over — keep speaking
        framesDone = true
        if (!playbackReady && pendingFrames.isNotEmpty()) {
            log.debug("drain-watch-deferred", mapOf("pending" to pendingFrames.size, "turnId" to lastTurnId))
            return
        }
        armDrainWatch(lastTurnId)
    }

    /** Pop the finished head and forward each queued turn's buffered bytes, in order, until
     *  one is still streaming. Returns that turn, or null once the queue is empty. */
    private fun promoteUntilStreaming(): TurnAudioSegment? {
        var next = queue.promote()
        while (next != null) {
            opusMode = next.opus
            if (opusMode) opusDecoder.reset()
            val buffered = next.takeBuffered()
            log.info(
                "downlink-promote",
                mapOf("turnId" to next.turnId, "frames" to buffered.size, "opusMode" to opusMode, "depth" to queue.depth),
            )
            for (raw in buffered) forwardFrame(raw, next.turnId)
            if (!next.streamDone) return next
            if (opusMode) opusDecoder.reset()
            next = queue.promote()
        }
        return null
    }
```

  In `armPlaybackOnce`'s post-flush block, replace the old `if (framesDone && activeTurnId.isNotEmpty()) armDrainWatch(activeTurnId)` with:

```kotlin
                // The buffered bytes are now in the player. Settle the head only AFTER the
                // flush — a pre-flush idle=true would false-finalize and clear speaking early.
                if (framesDone) armDrainWatch(lastTurnId)
                else if (queue.head?.streamDone == true) finishHeadSegment()
```

  In `finalizeDrain`, replace `activeTurnId = ""` with:

```kotlin
        queue.clear()
        lastTurnId = ""
```

  In `endHold`, drop the `holdStreamDone` bookkeeping and the pre-arm `framesDone = streamDone` (the post-flush hook now owns it):

```kotlin
    fun endHold() {
        if (!holdDeferred) return
        holdDeferred = false
        val hadBuffered = pendingFrames.isNotEmpty()
        val head = queue.head
        log.info(
            "hold-end",
            mapOf(
                "bufferedFrames" to pendingFrames.size,
                "bufferedBytes" to holdBufferedBytes,
                "streamDone" to (head?.streamDone ?: false),
                "turnId" to (head?.turnId ?: ""),
                "depth" to queue.depth,
            ),
        )
        if (head == null && !hadBuffered) return // nothing arrived during the hold
        isSpeaking = true
        // NEVER pre-set framesDone here (the pre-2.0 line was `framesDone = streamDone`).
        // The arm's post-flush hook settles the head once the buffered reply has actually
        // reached the player — a pre-flush isPlaybackIdle=true would false-finalize and
        // clear speaking early. Resetting to false also drops any stale flag from a turn
        // that ended before the hold began.
        framesDone = false
        armPlaybackOnce()
        transition(AudioInput.AudioStart, head?.turnId ?: "")
    }
```

  In `beginHold`, delete the `holdStreamDone = false` line (the flag is gone). In `stopLocal`, `onPlaybackStop` and `suspendPlayback`, replace every `activeTurnId` read/clear:

```kotlin
    fun stopLocal() {
        if (queue.isEmpty && !isSpeaking) return
        onPlaybackStop(reason = "interrupt-local", turnId = lastTurnId)
    }
```

```kotlin
    // inside onPlaybackStop, replacing `activeTurnId = ""`:
        queue.clear()
        lastTurnId = ""
```

```kotlin
    // inside suspendPlayback, alongside the existing resets:
        queue.clear()
        lastTurnId = ""
```

  Finally update the class KDoc: "reusable across cycles" → "reusable across turns", and add to the header block:

```kotlin
// TURN QUEUEING (design §7.2): audio is a FIFO of per-turn segments. A new turnId NEVER
// cancels, fades, or replaces in-flight audio — it plays after it. flushPlayback() is
// reserved for barge-in / interrupt (onPlaybackStop) and transient teardown
// (suspendPlayback). The tuned hold-defer / lazy-arm / drain-watch machinery is unchanged.
```

  Run: `./gradlew :shared:mobile-sdk:testDebugUnitTest --tests "io.sentient.mobilesdk.audioio.*"`
  Expected: `AudioPipelineTurnQueueTest` green; `AudioPipelineTest`, `AudioPipelineDownlinkTest`, `AudioPipelineHoldTest` **still green unchanged** apart from the Step-17 identifier renames — the hold tests are the proof that the tuned hold-defer behaviour was preserved.

- [ ] **Step 25: Retire the now-wrong supersede test and commit.**
  `AudioPipelineDownlinkTest.newerCycle_supersedesOld_flushesPlayback_andDropsStaleFrames` asserts the exact behaviour §7.2 forbids. Delete that test (its replacement is `AudioPipelineTurnQueueTest.followUpTurn_whilePriorTurnStillDraining_neverFlushes`) and update the file header bullet `- cycle supersede flushes playback + stale frames from the prior cycle are dropped.` → `- a frame for a turn with no open segment is stale-dropped (queueing lives in AudioPipelineTurnQueueTest).`

```
./gradlew :shared:mobile-sdk:testDebugUnitTest
git add -A shared/mobile-sdk
git commit -m "feat(mobile-sdk): queue downlink audio per turn instead of superseding the prior turn"
```

##### D. Permission surface

- [ ] **Step 26: Write the failing permission-connector test.**
  Create `shared/mobile-sdk/src/commonTest/kotlin/io/sentient/mobilesdk/connectors/PermissionConnectorTest.kt`:

```kotlin
// ---------------------------------------------------------------------------
// PermissionConnectorTest — KEEPER (.claude/rules/testing.md): security boundary.
// Pins (1) the outbound permission.response wire frame, (2) fail-closed dismissal —
// nothing is ever auto-approved locally, and (3) that tool ARGUMENT VALUES never reach
// the log (they are user content; the same boundary PrivacyGuardTest defends).
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.connectors

import io.sentient.mobilesdk.protocol.ClientMessage
import io.sentient.mobilesdk.protocol.SdkEvent
import io.sentient.mobilesdk.protocol.ServerMessage
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class PermissionConnectorTest {

    private fun request(requestId: String, body: String = "hi mum") = ServerMessage.PermissionRequest(
        requestId = requestId,
        toolCallId = "tc-$requestId",
        toolName = "sendMessage",
        args = JsonObject(mapOf("to" to JsonPrimitive("mum"), "body" to JsonPrimitive(body))),
        description = "Send a message",
        expiresAtMs = 120_000,
    )

    @Test fun request_opensAPrompt_andEmitsAOneShotEvent() {
        val events = mutableListOf<SdkEvent>()
        val c = PermissionConnector(send = { }, onEvent = { events += it })

        c.handle(request("r1"))

        assertEquals(1, c.pending().size)
        val prompt = c.pending().first()
        assertEquals("r1", prompt.requestId)
        assertEquals("sendMessage", prompt.toolName)
        assertEquals("mum", prompt.args["to"])
        assertEquals(120_000L, prompt.expiresAtMs)
        assertEquals(listOf(SdkEvent.PermissionRequested(prompt)), events)
    }

    @Test fun twoConcurrentRequests_bothStayOpen() {
        val c = PermissionConnector(send = { })
        c.handle(request("r1"))
        c.handle(request("r2"))
        assertEquals(listOf("r1", "r2"), c.pending().map { it.requestId })
    }

    @Test fun respond_sendsPermissionResponse_andDismissesLocally() {
        val sent = mutableListOf<ClientMessage>()
        val c = PermissionConnector(send = { sent += it })
        c.handle(request("r1"))

        c.respond("r1", approved = false)

        assertEquals(listOf(ClientMessage.PermissionResponse(requestId = "r1", approved = false)), sent)
        assertEquals(emptyList(), c.pending())
    }

    @Test fun serverResolved_dismissesTheDialog_andEmitsTheOutcome() {
        val events = mutableListOf<SdkEvent>()
        val c = PermissionConnector(send = { }, onEvent = { events += it })
        c.handle(request("r1"))

        c.handle(ServerMessage.PermissionResolved(requestId = "r1", outcome = "timeout"))

        assertEquals(emptyList(), c.pending())
        assertTrue(events.contains(SdkEvent.PermissionResolved(requestId = "r1", outcome = "timeout")))
    }

    @Test fun reset_dropsOpenPrompts_withoutSendingAnyApproval() {
        val sent = mutableListOf<ClientMessage>()
        val c = PermissionConnector(send = { sent += it })
        c.handle(request("r1"))

        c.reset()

        assertEquals(emptyList(), c.pending())
        assertEquals(emptyList(), sent, "fail-closed: dropping a prompt must never send an approval")
    }
}
```

  Also append the fourth case to `shared/mobile-sdk/src/commonTest/kotlin/io/sentient/mobilesdk/vitals/PrivacyGuardTest.kt` (add the imports `io.sentient.mobilesdk.connectors.PermissionConnector`, `kotlinx.serialization.json.JsonObject`, `kotlinx.serialization.json.JsonPrimitive`):

```kotlin
    /**
     * Permission prompts carry TOOL ARGUMENTS — the message body, the file path, the
     * search text. They are user content and must never reach the diagnostic ring.
     * The connector logs argKeys count only; the description is gateway-rendered from
     * the same arguments, so it is not logged either.
     */
    @Test fun permission_request_arguments_are_never_logged() {
        val secret = "tell Biscuit the vet appointment is at 4pm"
        val captured = StringBuilder()
        VitalsLogTap.register { _, tag, line -> captured.append(tag).append(' ').append(line).append('\n') }

        val c = PermissionConnector(send = { })
        c.handle(
            ServerMessage.PermissionRequest(
                requestId = "r-priv-1",
                toolCallId = "tc-priv-1",
                toolName = "sendMessage",
                args = JsonObject(mapOf("body" to JsonPrimitive(secret))),
                description = "Send: $secret",
                expiresAtMs = 120_000,
            ),
        )
        c.respond("r-priv-1", approved = true)

        assertTrue(!captured.toString().contains(secret), "tool arguments leaked into the diagnostic log:\n$captured")
    }
```

  Run: `./gradlew :shared:mobile-sdk:testDebugUnitTest --tests "io.sentient.mobilesdk.connectors.PermissionConnectorTest" --tests "io.sentient.mobilesdk.vitals.PrivacyGuardTest"`
  Expected failure: compilation — `Unresolved reference: PermissionConnector`, `Unresolved reference: PermissionRequested`.

- [ ] **Step 27: Implement `PermissionConnector`.**
  Create `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/connectors/PermissionConnector.kt`:

```kotlin
// ---------------------------------------------------------------------------
// PermissionConnector — the L3 `confirm` prompt seam (design §7.1).
//
//   permission.request  → open a prompt (keyed by requestId), fire a ONE-SHOT
//                         SdkEvent.PermissionRequested, publish the open list.
//   permission.response → outbound, carrying the user's Allow / Deny.
//   permission.resolved → the gateway resolved first (answered elsewhere, or the
//                         fail-closed 2-minute timeout) → dismiss + fire the outcome.
//
// FAIL-CLOSED: this connector never approves anything on its own. [reset] and a
// dropped socket drop the prompt locally; the gateway's own timer denies it server-side.
//
// PRIVACY: `args` and `description` are USER CONTENT (a message body, a file path).
// Log ids, tool name, and the argument-key COUNT only — never a value. Pinned by
// PrivacyGuardTest.permission_request_arguments_are_never_logged.
//
// Threading: single-threaded; the router drives handle() and the orchestrator drives
// respond() on the same dispatcher. The open map is owned here.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.connectors

import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.protocol.ClientMessage
import io.sentient.mobilesdk.protocol.SdkEvent
import io.sentient.mobilesdk.protocol.ServerMessage
import kotlinx.serialization.json.JsonPrimitive

/**
 * One open permission prompt, projected for the UI. [args] is flattened to a String map
 * so Compose and SwiftUI (via SKIE) render it without touching kotlinx JSON types:
 * a primitive contributes its unquoted content, a nested object/array its compact JSON.
 */
data class PermissionPrompt(
    val requestId: String,
    val toolCallId: String,
    val toolName: String,
    val args: Map<String, String>,
    val description: String,
    val expiresAtMs: Long,
)

class PermissionConnector(
    private val send: (ClientMessage) -> Unit,
    private val onPending: ((List<PermissionPrompt>) -> Unit)? = null,
    private val onEvent: ((SdkEvent) -> Unit)? = null,
) : Connector {
    override val capability: String = CAPABILITY

    private val log = createLogger("connector", "permission")

    private val open = LinkedHashMap<String, PermissionPrompt>()

    /** Every still-open prompt, in arrival order. Safe to read synchronously. */
    fun pending(): List<PermissionPrompt> = open.values.toList()

    override fun handle(msg: ServerMessage) {
        when (msg) {
            is ServerMessage.PermissionRequest -> onRequest(msg)
            is ServerMessage.PermissionResolved -> onResolved(msg.requestId, msg.outcome)
            else -> Unit // not owned by this connector
        }
    }

    /** User decision → permission.response. Dismisses locally; the gateway's
     *  permission.resolved echo is then a no-op (idempotent by requestId). */
    fun respond(requestId: String, approved: Boolean) {
        val known = open.remove(requestId) != null
        log.info(
            "respond",
            mapOf("requestId" to requestId, "approved" to approved, "known" to known, "open" to open.size),
        )
        send(ClientMessage.PermissionResponse(requestId = requestId, approved = approved))
        onPending?.invoke(pending())
    }

    /** Drop every open prompt (session switch / interrupt / logout). Fail-closed:
     *  nothing is auto-approved — the gateway denies on its own 2-minute timeout. */
    fun reset() {
        if (open.isEmpty()) return
        log.info("reset", mapOf("dropped" to open.size, "reason" to "session-scope-cleared"))
        open.clear()
        onPending?.invoke(pending())
    }

    private fun onRequest(msg: ServerMessage.PermissionRequest) {
        val prompt = PermissionPrompt(
            requestId = msg.requestId,
            toolCallId = msg.toolCallId,
            toolName = msg.toolName,
            args = msg.args.mapValues { (_, v) -> if (v is JsonPrimitive) v.content else v.toString() },
            description = msg.description,
            expiresAtMs = msg.expiresAtMs,
        )
        // argKeys COUNT only — argument values + the rendered description are user content.
        log.info(
            "request",
            mapOf(
                "requestId" to prompt.requestId,
                "toolCallId" to prompt.toolCallId,
                "toolName" to prompt.toolName,
                "argKeys" to prompt.args.size,
                "expiresAtMs" to prompt.expiresAtMs,
                "open" to open.size + 1,
            ),
        )
        open[prompt.requestId] = prompt
        onPending?.invoke(pending())
        onEvent?.invoke(SdkEvent.PermissionRequested(prompt))
    }

    private fun onResolved(requestId: String, outcome: String) {
        val known = open.remove(requestId) != null
        log.info(
            "resolved",
            mapOf("requestId" to requestId, "outcome" to outcome, "known" to known, "open" to open.size),
        )
        onPending?.invoke(pending())
        onEvent?.invoke(SdkEvent.PermissionResolved(requestId = requestId, outcome = outcome))
    }

    companion object {
        const val CAPABILITY: String = "permission.prompt"
    }
}
```

  Add the two events to `protocol/SdkEvent.kt` (import `io.sentient.mobilesdk.connectors.PermissionPrompt`):

```kotlin
    /**
     * One-shot: the gateway is asking the user to approve a side-effecting tool call
     * (design §7.1). Delivered on the no-loss [SentientSdk.events] SharedFlow, NEVER a
     * conflating StateFlow — two prompts landing back-to-back must both reach the UI.
     */
    data class PermissionRequested(val prompt: PermissionPrompt) : SdkEvent()

    /** One-shot: the request resolved — "allowed" | "denied" | "timeout". The UI dismisses. */
    data class PermissionResolved(val requestId: String, val outcome: String) : SdkEvent()
```

  Run the Step-26 commands. Expected: green.

##### E. Delegation progress

- [ ] **Step 28: Write the failing delegation-connector test.**
  Create `shared/mobile-sdk/src/commonTest/kotlin/io/sentient/mobilesdk/connectors/DelegationProgressConnectorTest.kt`:

```kotlin
// ---------------------------------------------------------------------------
// DelegationProgressConnectorTest — KEEPER: pins the delegation.progress wire
// contract (design §5.4/§7) that Tasks 8/9 render — upsert by taskId, terminal
// states retained, one no-loss event per update.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.connectors

import io.sentient.mobilesdk.protocol.SdkEvent
import io.sentient.mobilesdk.protocol.ServerMessage
import kotlin.test.Test
import kotlin.test.assertEquals

class DelegationProgressConnectorTest {

    @Test fun progressFrames_upsertByTaskId_andEmitOneEventEach() {
        val events = mutableListOf<SdkEvent>()
        val c = DelegationProgressConnector(onEvent = { events += it })

        c.handle(ServerMessage.DelegationProgress(taskId = "k1", turnId = "t1", agent = "hermes", status = "running"))
        c.handle(ServerMessage.DelegationProgress(taskId = "k2", turnId = "t1", agent = "hermes", status = "running"))
        c.handle(
            ServerMessage.DelegationProgress(
                taskId = "k1", turnId = "t1", agent = "hermes", status = "done", note = "found 3 results",
            ),
        )

        assertEquals(listOf("k1", "k2"), c.list().map { it.taskId }, "upsert in place, arrival order kept")
        assertEquals("done", c.list().first().status)
        assertEquals("found 3 results", c.list().first().note)
        assertEquals(3, events.count { it is SdkEvent.DelegationProgressed }, "one event per frame — never batched")
    }

    @Test fun clear_dropsEveryRow() {
        val c = DelegationProgressConnector()
        c.handle(ServerMessage.DelegationProgress(taskId = "k1", turnId = "t1", agent = "hermes", status = "running"))
        c.clear()
        assertEquals(emptyList(), c.list())
    }
}
```

  Run: `./gradlew :shared:mobile-sdk:testDebugUnitTest --tests "io.sentient.mobilesdk.connectors.DelegationProgressConnectorTest"`
  Expected failure: compilation — `Unresolved reference: DelegationProgressConnector`.

- [ ] **Step 29: Implement `DelegationProgressConnector`.**
  Create `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/connectors/DelegationProgressConnector.kt`:

```kotlin
// ---------------------------------------------------------------------------
// DelegationProgressConnector — live progress for BACKGROUND delegateTask work
// (design §5.4 / §7). Closest analog: TaskStatusConnector (same upsert-by-id shape),
// but a delegation row is agent-scoped and outlives the turn that dispatched it —
// its completion returns later as a stimulus, so terminal rows stay in the list and
// the UI filters if it wants.
//
// PRIVACY: `note` is worker-authored text (it can quote user content). Log its LENGTH
// only, never the note.
//
// Threading: single-threaded; the router drives handle() on the orchestrator's
// dispatcher. The mutable map is owned here.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.connectors

import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.protocol.SdkEvent
import io.sentient.mobilesdk.protocol.ServerMessage

/** Immutable snapshot of one delegated background task. */
data class DelegationSnapshotItem(
    val taskId: String,
    /** The turn that dispatched the delegation (join key for the UI's turn grouping). */
    val turnId: String,
    /** Worker identity, e.g. "hermes". */
    val agent: String,
    /** "running" | "done" | "error". */
    val status: String,
    /** Short worker-authored progress note; null when absent. USER-ADJACENT — never logged. */
    val note: String? = null,
)

class DelegationProgressConnector(
    private val onList: ((List<DelegationSnapshotItem>) -> Unit)? = null,
    private val onEvent: ((SdkEvent) -> Unit)? = null,
) : Connector {
    override val capability: String = CAPABILITY

    private val log = createLogger("connector", "delegation-progress")

    private val tasks = LinkedHashMap<String, DelegationSnapshotItem>()

    /** All delegation rows in arrival order. Terminal rows are retained. */
    fun list(): List<DelegationSnapshotItem> = tasks.values.toList()

    override fun handle(msg: ServerMessage) {
        when (msg) {
            is ServerMessage.DelegationProgress -> onProgress(msg)
            else -> Unit // not owned by this connector
        }
    }

    private fun onProgress(msg: ServerMessage.DelegationProgress) {
        val item = DelegationSnapshotItem(
            taskId = msg.taskId,
            turnId = msg.turnId,
            agent = msg.agent,
            status = msg.status,
            note = msg.note,
        )
        log.info(
            "delegation.progress",
            mapOf(
                "taskId" to item.taskId,
                "turnId" to item.turnId,
                "agent" to item.agent,
                "status" to item.status,
                "noteLen" to (item.note?.length ?: 0),
            ),
        )
        tasks[item.taskId] = item
        onEvent?.invoke(SdkEvent.DelegationProgressed(item))
        onList?.invoke(list())
    }

    /** Drop every row. Driven on newChat / switchSession by the orchestrator. */
    fun clear() {
        if (tasks.isEmpty()) return
        log.info("clear", mapOf("count" to tasks.size))
        tasks.clear()
        onList?.invoke(list())
    }

    companion object {
        const val CAPABILITY: String = "delegation.progress"
    }
}
```

  Add to `protocol/SdkEvent.kt` (import `io.sentient.mobilesdk.connectors.DelegationSnapshotItem`):

```kotlin
    /** One-shot: a background delegateTask reported progress (design §5.4). */
    data class DelegationProgressed(val task: DelegationSnapshotItem) : SdkEvent()
```

  Run the Step-28 command. Expected: green.

##### F. Wire the SDK surface

- [ ] **Step 30: Register both connectors in `sdk/SdkConnectors.kt`.**
  Add the imports (`PermissionConnector`, `PermissionPrompt`, `DelegationProgressConnector`, `DelegationSnapshotItem`), two constructor params after `onCognitionChanged`:

```kotlin
    private val onPermissionsChanged: (List<PermissionPrompt>) -> Unit = {},
    private val onDelegationsChanged: (List<DelegationSnapshotItem>) -> Unit = {},
```

  the two connectors after `audioOutput`:

```kotlin
    /** L3 confirm prompts (§7.1). The open list is published as continuous state; the
     *  arrival/resolution one-shots ride the SDK's no-loss event stream via [emitEvent]. */
    val permission = PermissionConnector(
        send = send,
        onPending = { prompts -> onPermissionsChanged(prompts) },
        onEvent = emitEvent,
    )

    val delegation = DelegationProgressConnector(
        onList = { list -> onDelegationsChanged(list) },
        onEvent = emitEvent,
    )
```

  and extend the broadcast list (this also merges both capability strings into `session.configure.capabilities.supports` automatically, since `capabilities` is derived from `all`):

```kotlin
    /** All connectors, broadcast targets for the MessageRouter. */
    val all: List<Connector> = listOf(
        text, history, inflight, cognition, turnError, preferences, tasks, sessions,
        audioInput, audioOutput, permission, delegation,
    )
```

- [ ] **Step 31: Expose `permissions`, `delegations`, and `respondToPermission` on `sdk/SentientSdk.kt`.**
  Add the imports (`PermissionPrompt`, `DelegationSnapshotItem`), the two state-holders next to `_timeline`:

```kotlin
    // Open L3 confirm prompts (§7.1). A StateFlow is conflation-SAFE here only because
    // every emitted value carries EVERY still-open prompt — never model this as a single
    // nullable prompt, or two back-to-back requests would lose the first. The arrival
    // one-shots ride [events] (buffered, suspend-on-overflow).
    private val _permissions = MutableStateFlow<List<PermissionPrompt>>(emptyList())
    val permissions: StateFlow<List<PermissionPrompt>> = _permissions.asStateFlow()

    /** Live background-delegation rows (§5.4). Same cumulative-list rationale. */
    private val _delegations = MutableStateFlow<List<DelegationSnapshotItem>>(emptyList())
    val delegations: StateFlow<List<DelegationSnapshotItem>> = _delegations.asStateFlow()
```

  wire them into the `SdkConnectors(...)` construction:

```kotlin
        onPermissionsChanged = { prompts -> _permissions.value = prompts },
        onDelegationsChanged = { list -> _delegations.value = list },
```

  add the public command next to `interrupt()`:

```kotlin
    /**
     * Answer an open permission prompt (design §7.1). Fail-closed by construction: NOT
     * calling this is never an approval — the gateway auto-denies at its 2-minute timeout
     * and echoes permission.resolved{outcome:"timeout"}.
     */
    fun respondToPermission(requestId: String, approved: Boolean) {
        log.info("permission.respond", mapOf("requestId" to requestId, "approved" to approved))
        markInteraction()
        connectors.permission.respond(requestId, approved)
    }
```

  and clear both on the session-scope boundaries: add `connectors.permission.reset()` to `clearActiveToIdle()` (which every interrupt / stuck-timeout / switch / new-chat path already routes through), and add `connectors.delegation.clear()` immediately after each existing `connectors.turnError.reset()` in `newChat`, `switchSession`, and `sendNewChat`:

```kotlin
    private fun clearActiveToIdle() {
        connectors.cognition.reset()  // currentState→IDLE + onCognitionChanged → deriver IDLE + refreshStuckWatch + emit
        connectors.permission.reset() // fail-closed: drop open prompts, never auto-approve
        audio.stopLocal()             // isSpeaking→false (if speaking) via onAudioStateChanged
        stuckWatchdog.disarm()
        emit()
    }
```

- [ ] **Step 32: Run the full shared gate and commit the permission + delegation surface.**

```
./gradlew :shared:mobile-sdk:testDebugUnitTest
./gradlew :shared:mobile-sdk:compileKotlinIosSimulatorArm64
git add -A shared/mobile-sdk
git commit -m "feat(mobile-sdk): add permission + delegation connectors and the respondToPermission surface"
```

##### G. mobile-data seam + version bump

- [ ] **Step 33: Add the permission + delegation passthroughs to `ChatComponent`.**
  In `shared/mobile-data/src/commonMain/kotlin/io/sentient/mobiledata/di/ChatComponent.kt`, add the imports (`io.sentient.mobilesdk.connectors.DelegationSnapshotItem`, `io.sentient.mobilesdk.connectors.PermissionPrompt`) and insert after the `reopenFailed` block:

```kotlin
    /**
     * Open L3 permission prompts (design §7.1) — the DI seam both platform ViewModels
     * wrap. Continuous state, so a StateFlow: every value carries every still-open
     * prompt, which makes conflation harmless. Thin passthrough, no accumulation.
     */
    val permissions: StateFlow<List<PermissionPrompt>> get() = sdk.permissions

    /** Live background-delegation rows (design §5.4). Thin passthrough. */
    val delegations: StateFlow<List<DelegationSnapshotItem>> get() = sdk.delegations

    /**
     * One-shot prompt arrivals off the SDK's NO-LOSS event stream. A VM that renders
     * dialogs from a queue collects this; a VM that renders "the current prompt" reads
     * [permissions]. Never fold a request away — a dropped prompt blocks a turn until
     * the gateway's 2-minute timeout denies it.
     */
    val permissionRequests: Flow<PermissionPrompt>
        get() = conversationRepository.liveEvents
            .filterIsInstance<SdkEvent.PermissionRequested>()
            .map { it.prompt }

    /** One-shot resolutions (allowed | denied | timeout) — the dismiss signal. */
    val permissionResolutions: Flow<SdkEvent.PermissionResolved>
        get() = conversationRepository.liveEvents.filterIsInstance<SdkEvent.PermissionResolved>()

    /** The user's Allow / Deny. Fail-closed: silence is never approval (§7.1). */
    fun respondToPermission(requestId: String, approved: Boolean) = sdk.respondToPermission(requestId, approved)
```

- [ ] **Step 34: Bump both shared module versions.**
  `shared/mobile-sdk/build.gradle.kts` — append to the version comment block and bump:

```kotlin
// Bumped to 0.3.0: Sentient 2.0 wire rebase — turn.*/permission.*/delegation.progress
// frames, cycleId→turnId across protocol/connectors/sdk, per-turn downlink audio queue
// (§7.2: a new turn queues behind, never flushes), permission + delegation connectors.
version = "0.3.0"
```

  `shared/mobile-data/build.gradle.kts`:

```kotlin
// Bumped to 0.3.0 in lockstep with shared/mobile-sdk: 2.0 wire rebase (turnId rename)
// + permission / delegation passthroughs on ChatComponent.
version = "0.3.0"
```

- [ ] **Step 35: Full gate, then commit.**

```
./gradlew :shared:mobile-sdk:testDebugUnitTest :shared:mobile-data:testDebugUnitTest
./gradlew :shared:mobile-sdk:compileKotlinIosSimulatorArm64 :shared:mobile-data:compileKotlinIosSimulatorArm64
./gradlew :shared:mobile-sdk:compileDebugKotlinAndroid :shared:mobile-data:compileDebugKotlinAndroid
```

  All green (`:android` and the iOS app target stay red until Tasks 8/9 — expected, see "Known breakage"). Commit:

```
git add -A shared/mobile-data shared/mobile-sdk/build.gradle.kts
git commit -m "feat(mobile-data): expose permission prompts and delegation progress on ChatComponent"
```

---

#### Decisions recorded (so Tasks 8/9 don't re-litigate them)

1. **AudioFsm transition table: PRESERVED, not superseded.** Every row `AudioFsmTest` pins keeps its target state. Two changes only: `AudioInput.CycleStart`/`CycleDone` renamed to `TurnStart`/`TurnDone` (identifier-only), and the previously-implicit `ASSISTANT_SPEAKING + AudioStart → ASSISTANT_SPEAKING` row made explicit (it was already the `else -> state` fallthrough). Rationale: with real queueing, a queued turn fires **no** `AudioStart` at all (the pipeline returns before `transition`), and a fresh turn arriving during the drain-watch must keep the display speaking rather than bounce it. `AudioInput` carries no turn id and does not need one — the pipeline owns turn identity and logs it; the FSM only drives the display axis.
2. **`VoicePlaybackSink` is untouched** — `playFrame` / `flushPlayback` / `isPlaybackIdle` remain a turn-agnostic byte pipe. All queueing lives in `commonMain` (`TurnAudioQueue` + `AudioPipeline`).
3. **`flushPlayback()` call sites after this task:** `AudioPipeline.onPlaybackStop` (barge-in / interrupt) and `AudioPipeline.suspendPlayback` (transient teardown). Nothing else. If a future change adds a third, it is almost certainly re-introducing the §7.2 bug.
4. **Binary frames carry no turnId**, so turn attribution is "most recent `turn.audio.start`". The gateway must bracket each turn's audio strictly. The queue is defensive against an overlapping start but cannot re-attribute bytes.
5. **A single live streaming bubble is retained** (`StateDeriver.inflight`), rendering the newest open turn; §7.2's "two bubbles" is satisfied by the two committed `conversation.entry` items, which already render independently. The per-turn buffer map exists so no turn's text is lost, not to render two live bubbles.

---

#### E2E coverage handoff

This task ships no user-visible surface on its own (the dialogs land in Tasks 8/9), so the rows below are **executed in Task 12** (native Maestro batch), not here. Listed inline so the matrix stays traceable to the code that enables it.

| Case | Viewport | Pre-state | Action | Expected user-visible | Expected log trail |
|---|---|---|---|---|---|
| `permission-confirm` (native tag) | Android + iOS device/sim | authed, chat open | ask for a side-effecting tool | permission dialog renders; Allow executes, Deny blocks | `connector permission request requestId=… argKeys=N` (no arg values); outbound `permission.response`; `permission resolved outcome=…` |
| `steer-followup-audio` (native tag) | Android + iOS device/sim | authed, TTS speaking a final answer | background task completes after the answer | second bubble appears; its audio plays AFTER the first finishes; the first is never cut | `downlink-queue-behind turnId=t2 head=t1`; `downlink-promote turnId=t2`; **zero** `downlink-stop` frames; `downlink-drained` once |
