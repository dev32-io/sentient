# Mobile Client Clean-Architecture Refactor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-found the Android + iOS clients on a blackbox SDK + shared KMP repository layer + per-screen lifecycle-bound ViewModels, with a typed `SentientResult` envelope and a no-loss streaming surface, verified by agent-driven Maestro E2E.

**Architecture:** The SDK becomes a pure transport blackbox exposing `connection: StateFlow`, `events: SharedFlow` (no-loss), and `timeline: StateFlow`. A new shared KMP module `shared/mobile-data` builds Chat/History/Connection repositories (outbox, history-cache, Result envelope) on top. Native per-screen ViewModels own `StateFlow<UiState>`, lifecycle-bound to the screen; a tiny app-scoped `PresenceCoordinator` handles foreground/idle. The process singletons (`SdkHolder`, app-scoped `SdkStore`) are deleted.

**Tech Stack:** Kotlin Multiplatform, kotlinx.coroutines (StateFlow/SharedFlow), SKIE (Kotlin↔Swift), Jetpack Compose, SwiftUI, Maestro (E2E), Gradle, XcodeGen.

**Spec:** `docs/superpowers/specs/2026-06-05-mobile-client-clean-architecture-design.md`

---

## Fidelity gradient (read first)

- **Phase 0–2 (foundation):** full bite-sized TDD, complete Kotlin in every step. These are load-bearing and pure-logic — test them hard.
- **Phase 3–4 (platform UI):** concrete tasks with complete code for the load-bearing pieces (ViewModels, lifecycle, repo wiring). Repetitive per-screen Compose/SwiftUI follows one fully-shown pattern per platform.
- **Phase 5 (E2E):** full Maestro YAML for the high-value/regression flows; the remaining matrix rows are specified with exact selectors + log-greps following the shown template.

## Pre-flight (do once before Phase 0)

- [ ] **Step 1: Confirm worktree + branch**

Run: `git -C /Users/kevinye/Development/sentient/.claude/worktrees/mobile-client branch --show-current`
Expected: `feature/mobile-client`

- [ ] **Step 2: Source env + confirm toolchain**

```bash
source scripts/env.sh
./gradlew --version            # Gradle/Kotlin present
```
Expected: Gradle prints version, no error.

- [ ] **Step 3: Confirm SDK unit tests are green at baseline**

Run: `./gradlew :shared:mobile-sdk:allTests`
Expected: BUILD SUCCESSFUL. (If red at baseline, stop and report — do not build on a broken base.)

**Key commands used throughout:**
- SDK/repo unit tests: `./gradlew :shared:mobile-sdk:allTests` · `./gradlew :shared:mobile-data:allTests`
- Build iOS framework: `./gradlew :shared:mobile-data:assembleMobileDataXCFramework` (Phase 2+) / `:shared:mobile-sdk:assembleMobileSdkXCFramework` (Phase 1)
- Android build: `./gradlew :android:assembleDebug`
- Android unit: `./gradlew :android:testDebugUnitTest`

---

# PHASE 0 — Streaming diagnostic (gates Phase 1 event contract)

No production code. One live trace to confirm whether the gateway streams `message.delta` incrementally or batches at `cycle.done`. The spec's streaming fix assumes incremental deltas conflated by `StateFlow`; if the gateway batches, Phase 1's event contract is unchanged but Phase 5 adds a gateway-pacing note.

### Task 0.1: Capture delta cadence from a live cycle

**Files:**
- Modify (temporary, reverted at end of task): `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/transport/MessageRouter.kt`

- [ ] **Step 1: Add a temporary timestamped trace at the router**

In `MessageRouter.route()` (currently `MessageRouter.kt:43-52`), the existing `log.debug("dispatch", ...)` already logs every frame type. Raise its resolution temporarily by adding the wall-clock ms:

```kotlin
fun route(msg: ServerMessage) {
    val type = msg::class.simpleName
    log.info("trace-frame", mapOf("type" to type, "atMs" to nowMsForTrace()))
    for (connector in connectors) connector.handle(msg)
}
```
(Add a top-level `private fun nowMsForTrace(): Long` using the platform clock already injected elsewhere, or reuse `Clock`. This is throwaway.)

- [ ] **Step 2: Boot the local stack + Android emulator, run one chat cycle**

```bash
cd deploy/macos && docker compose up -d        # local gateway stack (free creds)
adb -e logcat -c                                 # clear logcat
# launch app, log in (PIN 1234), send: "tell me a short story"
adb -e logcat | grep "trace-frame"
```

- [ ] **Step 3: Classify the cadence**

Inspect the `trace-frame type=MessageDelta atMs=…` lines:
- If many `MessageDelta` lines spread over hundreds of ms → **incremental** (conflation is the bug; Phase 1 fix is sufficient).
- If a single `MessageDelta` (or all deltas within one <16ms tick) right before `MessageDone` → **batched** (gateway flushes at cycle end; record this).

- [ ] **Step 4: Record the finding**

Append one line to `agents/docs/learnings.md` under a `## Mobile streaming cadence (2026-06-05)` heading: "Gateway delta cadence = INCREMENTAL|BATCHED — <n> deltas over <ms>." This decides whether Phase 5 needs a gateway-pacing follow-up.

- [ ] **Step 5: Revert the temporary trace + commit the finding only**

```bash
git checkout -- shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/transport/MessageRouter.kt
git add agents/docs/learnings.md
git commit -m "docs(mobile): record streaming delta cadence finding (phase 0)"
```

---

# PHASE 1 — SDK surface (commonMain, TDD)

Additive: new surfaces (`events`, `connection`, `timeline`) are added alongside the existing `state` so nothing breaks mid-refactor. `state` is deleted in Phase 5 after both apps migrate.

### Task 1.1: Error taxonomy

**Files:**
- Create: `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/result/SentientError.kt`
- Test: `shared/mobile-sdk/src/commonTest/kotlin/io/sentient/mobilesdk/result/SentientErrorTest.kt`

- [ ] **Step 1: Write the failing test**

```kotlin
package io.sentient.mobilesdk.result

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class SentientErrorTest {
    @Test
    fun connectionError_is_internally_retryable() {
        val e = SentientError.Connection(userMessage = "Connection lost")
        assertEquals(ErrorKind.CONNECTION, e.kind)
        assertTrue(e.recoverable)
        assertEquals(RetryPolicy.Internal, e.retry)
    }

    @Test
    fun authExpired_is_terminal_not_recoverable() {
        val e = SentientError.Auth(userMessage = "Session expired", terminal = true)
        assertFalse(e.recoverable)
        assertEquals(RetryPolicy.None, e.retry)
    }

    @Test
    fun timeout_prompts_user_retry() {
        val e = SentientError.Timeout(userMessage = "Took too long")
        assertEquals(RetryPolicy.UserPrompt, e.retry)
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./gradlew :shared:mobile-sdk:allTests --tests "*SentientErrorTest*"`
Expected: FAIL — unresolved reference `SentientError` / `ErrorKind` / `RetryPolicy`.

- [ ] **Step 3: Write minimal implementation**

```kotlin
package io.sentient.mobilesdk.result

enum class ErrorKind { CONNECTION, AUTH, PROTOCOL, TIMEOUT, CYCLE, OUTBOX, UNKNOWN }

sealed class RetryPolicy {
    data object None : RetryPolicy()
    data object Internal : RetryPolicy()
    data object UserPrompt : RetryPolicy()
}

sealed class SentientError(
    val kind: ErrorKind,
    val recoverable: Boolean,
    val retry: RetryPolicy,
    val userMessage: String,
    val cause: Throwable? = null,
) {
    class Connection(userMessage: String, cause: Throwable? = null) :
        SentientError(ErrorKind.CONNECTION, recoverable = true, retry = RetryPolicy.Internal, userMessage = userMessage, cause = cause)

    class Auth(userMessage: String, terminal: Boolean, cause: Throwable? = null) :
        SentientError(ErrorKind.AUTH, recoverable = !terminal, retry = if (terminal) RetryPolicy.None else RetryPolicy.UserPrompt, userMessage = userMessage, cause = cause)

    class Protocol(userMessage: String, cause: Throwable? = null) :
        SentientError(ErrorKind.PROTOCOL, recoverable = true, retry = RetryPolicy.Internal, userMessage = userMessage, cause = cause)

    class Timeout(userMessage: String, cause: Throwable? = null) :
        SentientError(ErrorKind.TIMEOUT, recoverable = true, retry = RetryPolicy.UserPrompt, userMessage = userMessage, cause = cause)

    class Cycle(userMessage: String, cause: Throwable? = null) :
        SentientError(ErrorKind.CYCLE, recoverable = true, retry = RetryPolicy.UserPrompt, userMessage = userMessage, cause = cause)

    class Outbox(userMessage: String, cause: Throwable? = null) :
        SentientError(ErrorKind.OUTBOX, recoverable = true, retry = RetryPolicy.UserPrompt, userMessage = userMessage, cause = cause)

    class Unknown(userMessage: String, cause: Throwable? = null) :
        SentientError(ErrorKind.UNKNOWN, recoverable = false, retry = RetryPolicy.None, userMessage = userMessage, cause = cause)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `./gradlew :shared:mobile-sdk:allTests --tests "*SentientErrorTest*"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/result/SentientError.kt shared/mobile-sdk/src/commonTest/kotlin/io/sentient/mobilesdk/result/SentientErrorTest.kt
git commit -m "feat(mobile-sdk): SentientError taxonomy + retry policy"
```

### Task 1.2: SdkEvent sealed class

**Files:**
- Create: `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/protocol/SdkEvent.kt`
- Test: `shared/mobile-sdk/src/commonTest/kotlin/io/sentient/mobilesdk/protocol/SdkEventTest.kt`

- [ ] **Step 1: Write the failing test**

```kotlin
package io.sentient.mobilesdk.protocol

import io.sentient.mobilesdk.connectors.TaskSnapshotItem
import io.sentient.mobilesdk.result.SentientError
import kotlin.test.Test
import kotlin.test.assertEquals

class SdkEventTest {
    @Test
    fun delta_carries_cycle_and_chunk() {
        val e = SdkEvent.MessageDelta(cycleId = "c1", chunk = "hel")
        assertEquals("c1", e.cycleId)
        assertEquals("hel", e.chunk)
    }

    @Test
    fun taskUpserted_wraps_snapshot() {
        val t = TaskSnapshotItem("t1", "search", "c1", "running", "{}", 0L)
        val e = SdkEvent.TaskUpserted(t)
        assertEquals("t1", e.task.taskId)
    }

    @Test
    fun protocolError_wraps_sentientError() {
        val e = SdkEvent.ProtocolError(SentientError.Protocol("bad frame"))
        assertEquals("bad frame", e.error.userMessage)
    }
}
```

- [ ] **Step 2: Run — expect FAIL** (`SdkEvent` unresolved).
Run: `./gradlew :shared:mobile-sdk:allTests --tests "*SdkEventTest*"`

- [ ] **Step 3: Implement**

```kotlin
package io.sentient.mobilesdk.protocol

import io.sentient.mobilesdk.connectors.TaskSnapshotItem
import io.sentient.mobilesdk.result.SentientError
import io.sentient.mobilesdk.sdk.ChatMessage

sealed class SdkEvent {
    data class MessageStarted(val cycleId: String) : SdkEvent()
    data class MessageDelta(val cycleId: String, val chunk: String) : SdkEvent()
    data class MessageCommitted(val message: ChatMessage) : SdkEvent()
    data class TaskUpserted(val task: TaskSnapshotItem) : SdkEvent()
    data class TranscriptUpdated(val text: String) : SdkEvent()
    data class CycleDone(val cycleId: String) : SdkEvent()
    data class CycleAborted(val cycleId: String, val kind: String?) : SdkEvent()
    data class SessionSwitched(val sessionId: String) : SdkEvent()
    data class ProtocolError(val error: SentientError) : SdkEvent()
}
```

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** — `feat(mobile-sdk): SdkEvent sealed taxonomy`.

### Task 1.3: ConnectionState

**Files:**
- Create: `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/sdk/ConnectionState.kt`
- Test: `shared/mobile-sdk/src/commonTest/kotlin/io/sentient/mobilesdk/sdk/ConnectionStateTest.kt`

- [ ] **Step 1: Failing test**

```kotlin
package io.sentient.mobilesdk.sdk

import io.sentient.mobilesdk.transport.SdkStatus
import kotlin.test.Test
import kotlin.test.assertEquals

class ConnectionStateTest {
    @Test
    fun defaults_are_disconnected_and_clean() {
        val c = ConnectionState()
        assertEquals(SdkStatus.DISCONNECTED, c.status)
        assertEquals(false, c.hasSession)
        assertEquals(false, c.connectionLost)
        assertEquals(false, c.authExpired)
        assertEquals(VoiceMode.OFF, c.voiceMode)
    }
}
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** (fields are the connection-axis subset of `SdkState`, see `SdkState.kt:77-91`)

```kotlin
package io.sentient.mobilesdk.sdk

import io.sentient.mobilesdk.protocol.AudioPreferences
import io.sentient.mobilesdk.transport.SdkStatus

data class ConnectionState(
    val status: SdkStatus = SdkStatus.DISCONNECTED,
    val hasSession: Boolean = false,
    val connectionLost: Boolean = false,
    val authExpired: Boolean = false,
    val prefs: AudioPreferences = AudioPreferences.DEFAULT,
    val voiceMode: VoiceMode = VoiceMode.OFF,
    val isSpeaking: Boolean = false,
    val audioState: AudioState = AudioState.INACTIVE,
)
```

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** — `feat(mobile-sdk): ConnectionState (connection-axis slice)`.

### Task 1.4: Expose events/connection/timeline on SentientSdk

**Files:**
- Modify: `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/sdk/SentientSdk.kt` (state block `:47-48`, `emit()` `:291-293`)
- Modify: `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/sdk/StateDeriver.kt` (add `deriveConnection()`)
- Test: `shared/mobile-sdk/src/commonTest/kotlin/io/sentient/mobilesdk/sdk/SdkSurfaceTest.kt`

- [ ] **Step 1: Write the failing test** (drive the deriver directly — it's the pure fold)

```kotlin
package io.sentient.mobilesdk.sdk

import io.sentient.mobilesdk.transport.SdkStatus
import io.sentient.mobilesdk.util.FixedClock
import kotlin.test.Test
import kotlin.test.assertEquals

class SdkSurfaceTest {
    @Test
    fun deriveConnection_projects_connection_axis() {
        val d = StateDeriver(FixedClock(1000L))
        d.status = SdkStatus.READY
        d.hasSession = true
        d.voiceMode = VoiceMode.ACTIVE
        val c = d.deriveConnection()
        assertEquals(SdkStatus.READY, c.status)
        assertEquals(true, c.hasSession)
        assertEquals(VoiceMode.ACTIVE, c.voiceMode)
    }
}
```
(If `FixedClock` lives elsewhere, match the existing test util — check `commonTest/.../util/`. The deriver constructor takes a `Clock` per `StateDeriver.kt:41`.)

- [ ] **Step 2: Run — expect FAIL** (`deriveConnection` unresolved).

- [ ] **Step 3: Implement `deriveConnection()` in StateDeriver**

Add to `StateDeriver` (after `derive()` at `StateDeriver.kt:119`):
```kotlin
fun deriveConnection(): ConnectionState = ConnectionState(
    status = status,
    hasSession = hasSession,
    connectionLost = connectionLost,
    authExpired = authExpired,
    prefs = prefs,
    voiceMode = voiceMode,
    isSpeaking = isSpeaking,
    audioState = audioState,
)

fun deriveTimeline(): List<ChatMessage> =
    deriveMessages(feed, inflight = null, clock.nowMs(), tasks, cycleByTsView())
```
(Add a small `private fun cycleByTsView(): Map<Long,String> = cycleByTs` accessor if `deriveMessages` needs it; `deriveTimeline` excludes the in-flight bubble — committed only.)

- [ ] **Step 4: Add the three new flows to SentientSdk**

In `SentientSdk.kt`, replace the state block (`:47-48`) with:
```kotlin
private val _state = MutableStateFlow(SdkState())
val state: StateFlow<SdkState> = _state.asStateFlow()

private val _connection = MutableStateFlow(ConnectionState())
val connection: StateFlow<ConnectionState> = _connection.asStateFlow()

private val _timeline = MutableStateFlow<List<ChatMessage>>(emptyList())
val timeline: StateFlow<List<ChatMessage>> = _timeline.asStateFlow()

private val _events = MutableSharedFlow<SdkEvent>(
    replay = 0,
    extraBufferCapacity = EVENTS_BUFFER_CAPACITY,
    onBufferOverflow = BufferOverflow.SUSPEND,
)
val events: SharedFlow<SdkEvent> = _events.asSharedFlow()

private fun emitEvent(event: SdkEvent) {
    if (!_events.tryEmit(event)) {
        scope.launch { _events.emit(event) }  // SUSPEND fallback — never drop
    }
}
```
Add `const val EVENTS_BUFFER_CAPACITY = 256` to the companion (config-driven later; see Task 1.4b). Add imports: `kotlinx.coroutines.flow.MutableSharedFlow`, `SharedFlow`, `asSharedFlow`, `channels.BufferOverflow`, `io.sentient.mobilesdk.protocol.SdkEvent`.

Update `emit()` (`:291-293`) to fan out to all derived flows:
```kotlin
private fun emit() {
    _state.value = deriver.derive()
    _connection.value = deriver.deriveConnection()
    _timeline.value = deriver.deriveTimeline()
}
```

- [ ] **Step 5: Run — expect PASS.** `./gradlew :shared:mobile-sdk:allTests --tests "*SdkSurfaceTest*"`
- [ ] **Step 6: Run the full SDK suite** to confirm no regression: `./gradlew :shared:mobile-sdk:allTests`. Expected: PASS.
- [ ] **Step 7: Commit** — `feat(mobile-sdk): expose connection/timeline StateFlow + events SharedFlow`.

### Task 1.4b: Move event-buffer capacity to config

**Files:**
- Modify: `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/sdk/SdkConfig.kt`
- Modify: `SentientSdk.kt`

- [ ] **Step 1:** Add `val eventsBufferCapacity: Int = 256` to `SdkConfig` (with a doc comment: "// SharedFlow buffer for the no-loss event tap; sized > max deltas per cycle"). Use `config.eventsBufferCapacity` in the `MutableSharedFlow` builder instead of the const.
- [ ] **Step 2:** Build: `./gradlew :shared:mobile-sdk:assembleDebug` (or `compileKotlinMetadata`). Expected: SUCCESS.
- [ ] **Step 3: Commit** — `refactor(mobile-sdk): event buffer capacity from SdkConfig`.

### Task 1.5: InFlightMessageConnector emits Started/Delta/Committed

**Files:**
- Modify: `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/connectors/InFlightMessageConnector.kt` (`:34-90`)
- Modify: `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/sdk/SdkConnectors.kt` (`:62-120`)
- Test: `shared/mobile-sdk/src/commonTest/kotlin/io/sentient/mobilesdk/connectors/InFlightEventsTest.kt`

- [ ] **Step 1: Failing test** — feed frames, assert ordered events (no conflation)

```kotlin
package io.sentient.mobilesdk.connectors

import io.sentient.mobilesdk.protocol.SdkEvent
import io.sentient.mobilesdk.protocol.ServerMessage
import kotlin.test.Test
import kotlin.test.assertEquals

class InFlightEventsTest {
    @Test
    fun emits_started_then_each_delta_in_order_then_done() {
        val events = mutableListOf<SdkEvent>()
        val c = InFlightMessageConnector(onUpdate = {}, onEvent = { events.add(it) })
        c.handle(ServerMessage.CycleStarted(cycleId = "c1"))
        c.handle(ServerMessage.MessageDelta(cycleId = "c1", delta = "He"))
        c.handle(ServerMessage.MessageDelta(cycleId = "c1", delta = "llo"))
        c.handle(ServerMessage.MessageDone(cycleId = "c1"))

        assertEquals(SdkEvent.MessageStarted("c1"), events[0])
        assertEquals(SdkEvent.MessageDelta("c1", "He"), events[1])
        assertEquals(SdkEvent.MessageDelta("c1", "llo"), events[2])
        assertEquals("c1", (events[3] as SdkEvent.MessageCommitted).message.cycleId)
    }
}
```

- [ ] **Step 2: Run — expect FAIL** (`onEvent` param does not exist).

- [ ] **Step 3: Implement** — add an `onEvent` callback and emit at each transition

In `InFlightMessageConnector.kt`, change the constructor (`:34-36`) to add `onEvent`:
```kotlin
class InFlightMessageConnector(
    private val onUpdate: ((InFlightMessage?) -> Unit)? = null,
    private val onEvent: ((SdkEvent) -> Unit)? = null,
) : Connector {
```
In `onCycleStarted` emit `SdkEvent.MessageStarted(cycleId)`; in `onDelta` (`:63-72`) emit `SdkEvent.MessageDelta(cycleId, delta)` for the non-null `delta`; in `onDone` (`:74-81`), when the buffer is committed, build the committed `ChatMessage` (role="assistant", content=accumulated text, streaming=false, cycleId) and emit `SdkEvent.MessageCommitted(message)`. Keep all existing `onUpdate` calls intact (additive). Add imports for `SdkEvent` and `ChatMessage`.

- [ ] **Step 4: Wire `onEvent` through SdkConnectors**

In `SdkConnectors.kt`, add an `emitEvent: (SdkEvent) -> Unit` constructor param (after `emit`), and pass it to `inflight`:
```kotlin
val inflight = InFlightMessageConnector(
    onUpdate = { msg -> deriver.inflight = msg; emit() },
    onEvent = emitEvent,
)
```
In `SentientSdk.kt` where `SdkConnectors(...)` is constructed, pass `emitEvent = ::emitEvent`.

- [ ] **Step 5: Run — expect PASS.** Then full suite: `./gradlew :shared:mobile-sdk:allTests`.
- [ ] **Step 6: Commit** — `feat(mobile-sdk): emit ordered in-flight message events`.

### Task 1.6: TaskStatusConnector emits TaskUpserted

**Files:**
- Modify: `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/connectors/TaskStatusConnector.kt` (`:46-64`)
- Modify: `SdkConnectors.kt`
- Test: `shared/mobile-sdk/src/commonTest/kotlin/io/sentient/mobilesdk/connectors/TaskEventsTest.kt`

- [ ] **Step 1: Failing test**

```kotlin
package io.sentient.mobilesdk.connectors

import io.sentient.mobilesdk.protocol.SdkEvent
import io.sentient.mobilesdk.protocol.ServerMessage
import kotlin.test.Test
import kotlin.test.assertEquals

class TaskEventsTest {
    @Test
    fun each_task_update_emits_upsert_in_order() {
        val events = mutableListOf<SdkEvent>()
        val c = TaskStatusConnector(onList = {}, onEvent = { events.add(it) })
        c.handle(ServerMessage.TaskUpdate("t1", "search", "c1", "running", "{}", 1L))
        c.handle(ServerMessage.TaskUpdate("t2", "calc", "c1", "running", "{}", 2L))
        c.handle(ServerMessage.TaskUpdate("t1", "search", "c1", "finished", "{}", 1L, endedAtMs = 3L))
        assertEquals(listOf("t1", "t2", "t1"), events.map { (it as SdkEvent.TaskUpserted).task.taskId })
        assertEquals("finished", (events[2] as SdkEvent.TaskUpserted).task.status)
    }
}
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** — add `onEvent` param; in `onTaskUpdate`, after upserting into the `LinkedHashMap`, emit `SdkEvent.TaskUpserted(item)` with the just-built `TaskSnapshotItem`. Keep `onList` intact.
- [ ] **Step 4: Wire through `SdkConnectors`** — `tasks = TaskStatusConnector(onList = { ... }, onEvent = emitEvent)`.
- [ ] **Step 5: Run — expect PASS; full suite green.**
- [ ] **Step 6: Commit** — `feat(mobile-sdk): emit ordered task upsert events`.

### Task 1.7: Cognition / cycle / session events

**Files:**
- Modify: `CognitionStatusConnector.kt`, `CycleErrorConnector.kt`, `SessionsConnector.kt` (or wherever `SessionSwitched` is observed — confirm; the `ConversationHistoryConnector` handles `SessionSwitched` at `:38`), `UserAudioInputConnector.kt` (transcript)
- Modify: `SdkConnectors.kt`
- Test: `shared/mobile-sdk/src/commonTest/kotlin/io/sentient/mobilesdk/connectors/LifecycleEventsTest.kt`

- [ ] **Step 1: Failing test** — assert `CycleDone`, `CycleAborted(kind)`, `SessionSwitched`, `TranscriptUpdated` are emitted from their source frames.

```kotlin
package io.sentient.mobilesdk.connectors

import io.sentient.mobilesdk.protocol.SdkEvent
import io.sentient.mobilesdk.protocol.ServerMessage
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class LifecycleEventsTest {
    @Test
    fun session_switched_frame_emits_event() {
        val events = mutableListOf<SdkEvent>()
        val c = ConversationHistoryConnector(onUpdate = {}, onEvent = { events.add(it) })
        c.handle(ServerMessage.SessionSwitched(sessionId = "s9", ts = 1L))
        assertTrue(events.any { it is SdkEvent.SessionSwitched && it.sessionId == "s9" })
    }
}
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** — add `onEvent` to each connector and emit: `CognitionStatusConnector` → none required (cognition is connection-axis, already in `connection`); `CycleErrorConnector` → on unsolicited abort emit `SdkEvent.CycleAborted(cycleId, kind)`; `ConversationHistoryConnector.onSessionSwitched` → emit `SdkEvent.SessionSwitched(sessionId)`; `UserAudioInputConnector` transcript callback → emit `SdkEvent.TranscriptUpdated(text)`. Add `CycleDone` from the `cycle.completed` frame (`ServerMessage.CycleCompleted`, see `ServerMessage.kt`) wherever cognition observes it. Wire each `onEvent = emitEvent` in `SdkConnectors.kt`.
- [ ] **Step 4: Run — expect PASS; full suite green.**
- [ ] **Step 5: Commit** — `feat(mobile-sdk): emit cycle/session/transcript events`.

### Task 1.8: ProtocolError on decode failure (no silent drop)

**Files:**
- Modify: `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/protocol/WireJson.kt` (decode entry) and/or the decode call site in `SdkLifecycle` pump
- Modify: `SentientSdk.kt` (emit `ProtocolError` from the decode boundary)
- Test: `shared/mobile-sdk/src/commonTest/kotlin/io/sentient/mobilesdk/protocol/WireDecodeTest.kt`

- [ ] **Step 1: Failing test** — a malformed control frame yields a typed decode failure rather than a coerced/dropped `Unknown`

```kotlin
package io.sentient.mobilesdk.protocol

import kotlin.test.Test
import kotlin.test.assertTrue

class WireDecodeTest {
    @Test
    fun malformed_json_returns_decode_failure() {
        val result = WireJson.decodeServerMessageResult("{ not valid json ")
        assertTrue(result.isFailure)
    }
}
```

- [ ] **Step 2: Run — expect FAIL** (`decodeServerMessageResult` unresolved).
- [ ] **Step 3: Implement** — add `fun decodeServerMessageResult(raw: String): Result<ServerMessage>` to `WireJson` that wraps the existing decode in `runCatching` (do not change the existing lenient path used elsewhere yet). At the pump decode boundary in `SdkLifecycle`, use the Result form; on failure call back into `SentientSdk` to `emitEvent(SdkEvent.ProtocolError(SentientError.Protocol("decode failed", cause = it)))` and `log.warn("decode-failed", ...)`. Do NOT throw — this is the system boundary.
- [ ] **Step 4: Run — expect PASS; full suite green.**
- [ ] **Step 5: Commit** — `feat(mobile-sdk): surface ProtocolError on decode failure`.

### Task 1.9: Dev fault hooks (debug-only)

**Files:**
- Create: `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/dev/FaultHooks.kt`
- Modify: `SentientSdk.kt` (consult hooks at the right boundaries, guarded by `config.devFaultsEnabled`)
- Modify: `SdkConfig.kt` (add `val devFaultsEnabled: Boolean = false`)
- Test: `shared/mobile-sdk/src/commonTest/kotlin/io/sentient/mobilesdk/dev/FaultHooksTest.kt`

- [ ] **Step 1: Failing test**

```kotlin
package io.sentient.mobilesdk.dev

import kotlin.test.Test
import kotlin.test.assertEquals

class FaultHooksTest {
    @Test
    fun arming_expired_token_is_one_shot() {
        val h = FaultHooks()
        h.armExpiredToken()
        assertEquals(true, h.consumeExpiredToken())
        assertEquals(false, h.consumeExpiredToken())  // one-shot
    }
}
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement**

```kotlin
package io.sentient.mobilesdk.dev

class FaultHooks {
    private var expiredToken = false
    private var malformedNext = false
    private var fixtureUtterance: ByteArray? = null

    fun armExpiredToken() { expiredToken = true }
    fun consumeExpiredToken(): Boolean = expiredToken.also { expiredToken = false }

    fun armMalformedFrame() { malformedNext = true }
    fun consumeMalformedFrame(): Boolean = malformedNext.also { malformedNext = false }

    fun loadFixtureUtterance(pcm: ByteArray) { fixtureUtterance = pcm }
    fun takeFixtureUtterance(): ByteArray? = fixtureUtterance.also { fixtureUtterance = null }
}
```

- [ ] **Step 4: Wire (guarded)** — `SentientSdk` holds a `FaultHooks` exposed only when `config.devFaultsEnabled`. At the auth boundary, if `consumeExpiredToken()` → emit `authExpired`. At the decode boundary, if `consumeMalformedFrame()` → route a malformed string. At the mic capture boundary, if a fixture is present, feed it to the capture adapter instead of the live mic. Expose `fun devFaults(): FaultHooks?` returning null unless enabled. Build only — exercised in Phase 5.
- [ ] **Step 5: Run — expect PASS; build green.**
- [ ] **Step 6: Commit** — `feat(mobile-sdk): debug-only fault-injection hooks`.

### Task 1.10: SKIE smoke — Swift exhaustive switch over the new types

**Files:**
- Build artifact only; create: `ios/SkieSmoke/SkieSmoke.swift` (a compile-only smoke file referenced by the iOS target in Phase 4; for now, a scratch verification)

- [ ] **Step 1: Build the iOS framework**

Run: `./gradlew :shared:mobile-sdk:assembleMobileSdkXCFramework`
Expected: BUILD SUCCESSFUL; framework at `shared/mobile-sdk/build/XCFrameworks/debug/MobileSdk.xcframework`.

- [ ] **Step 2: Verify exhaustive switch compiles** — write a scratch Swift snippet and compile it against the framework (or paste into an Xcode scratch target):

```swift
import MobileSdk
func describe(_ e: SdkEvent) -> String {
    switch onEnum(of: e) {
    case .messageStarted(let s): return "start \(s.cycleId)"
    case .messageDelta(let d): return "delta \(d.chunk)"
    case .messageCommitted: return "commit"
    case .taskUpserted: return "task"
    case .transcriptUpdated: return "transcript"
    case .cycleDone: return "done"
    case .cycleAborted: return "aborted"
    case .sessionSwitched: return "switched"
    case .protocolError: return "error"
    }
}
```
Expected: compiles with no `default:` needed (exhaustive). If `onEnum(of:)` is missing for `SdkEvent`, confirm SKIE generated the wrapper (sealed class with all-class children).

- [ ] **Step 3: Commit the smoke note** — record in `agents/docs/mobile-sdk/` that the SKIE exhaustive switch over `SdkEvent` compiles. `docs(mobile-sdk): confirm SKIE exhaustive SdkEvent bridge`.

---

# PHASE 2 — Shared KMP repo module `shared/mobile-data` (TDD)

### Task 2.1: Scaffold the module + framework export

**Files:**
- Create: `shared/mobile-data/build.gradle.kts`
- Modify: `settings.gradle.kts` (root — add `include(":shared:mobile-data")`)
- Create: `shared/mobile-data/src/commonMain/kotlin/io/sentient/mobiledata/.gitkeep`

- [ ] **Step 1: Register the module**

Add to root `settings.gradle.kts`: `include(":shared:mobile-data")`.

- [ ] **Step 2: Write `build.gradle.kts`** (mirror mobile-sdk's setup at `shared/mobile-sdk/build.gradle.kts:3-49`; export the SDK so the single XCFramework includes it)

```kotlin
import org.jetbrains.kotlin.gradle.plugin.mpp.apple.XCFramework

plugins {
    alias(libs.plugins.kotlin.multiplatform)
    alias(libs.plugins.android.library)
    alias(libs.plugins.skie)
    alias(libs.plugins.kotlin.serialization)
}

kotlin {
    androidTarget()
    val xcfName = "MobileData"
    val xcf = XCFramework(xcfName)
    listOf(iosArm64(), iosSimulatorArm64()).forEach {
        it.binaries.framework {
            baseName = xcfName
            isStatic = true
            export(project(":shared:mobile-sdk"))   // umbrella: MobileData re-exports MobileSdk API
            xcf.add(this)
        }
    }
    sourceSets {
        commonMain.dependencies {
            api(project(":shared:mobile-sdk"))       // api so Swift sees SDK types through MobileData
            implementation(libs.kotlinx.coroutines.core)
        }
        commonTest.dependencies {
            implementation(libs.kotlin.test)
            implementation(libs.kotlinx.coroutines.test)
        }
    }
}

android {
    namespace = "io.sentient.mobiledata"
    compileSdk = 34
    defaultConfig { minSdk = 26 }
}
```
(Confirm `libs.kotlinx.coroutines.test` exists in the version catalog; if not, add it. Match `compileSdk`/`minSdk` to mobile-sdk's actual values.)

- [ ] **Step 3: Sync + build empty module**

Run: `./gradlew :shared:mobile-data:compileKotlinMetadata`
Expected: BUILD SUCCESSFUL.

- [ ] **Step 4: Commit** — `chore(mobile-data): scaffold shared KMP repository module`.

### Task 2.2: SentientResult

**Files:**
- Create: `shared/mobile-data/src/commonMain/kotlin/io/sentient/mobiledata/result/SentientResult.kt`
- Test: `shared/mobile-data/src/commonTest/kotlin/io/sentient/mobiledata/result/SentientResultTest.kt`

- [ ] **Step 1: Failing test**

```kotlin
package io.sentient.mobiledata.result

import io.sentient.mobilesdk.result.SentientError
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class SentientResultTest {
    @Test
    fun loading_can_carry_partial() {
        val r: SentientResult<List<Int>> = SentientResult.Loading(partial = listOf(1, 2))
        assertEquals(listOf(1, 2), (r as SentientResult.Loading).partial)
    }

    @Test
    fun loading_partial_optional() {
        val r = SentientResult.Loading<List<Int>>()
        assertNull(r.partial)
    }

    @Test
    fun failure_holds_error() {
        val r: SentientResult<Int> = SentientResult.Failure(SentientError.Timeout("slow"))
        assertEquals("slow", (r as SentientResult.Failure).error.userMessage)
    }
}
```

- [ ] **Step 2: Run — expect FAIL.**
Run: `./gradlew :shared:mobile-data:allTests --tests "*SentientResultTest*"`

- [ ] **Step 3: Implement** (exact shape from spec §8 — sealed class, `out T : Any`)

```kotlin
package io.sentient.mobiledata.result

import io.sentient.mobilesdk.result.SentientError

sealed class SentientResult<out T : Any> {
    data class Loading<out T : Any>(val partial: T? = null) : SentientResult<T>()
    data class Success<out T : Any>(val data: T) : SentientResult<T>()
    data class Failure(val error: SentientError) : SentientResult<Nothing>()
}
```

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** — `feat(mobile-data): SentientResult envelope`.

### Task 2.3: Domain models

**Files:**
- Create: `shared/mobile-data/src/commonMain/kotlin/io/sentient/mobiledata/model/ChatModel.kt`
- Test: `shared/mobile-data/src/commonTest/kotlin/io/sentient/mobiledata/model/ChatModelTest.kt`

- [ ] **Step 1: Failing test** — the chat model holds committed messages + an optional live bubble + tasks, with a `messagesForUi()` that appends the live bubble.

```kotlin
package io.sentient.mobiledata.model

import io.sentient.mobilesdk.sdk.ChatMessage
import kotlin.test.Test
import kotlin.test.assertEquals

class ChatModelTest {
    @Test
    fun messagesForUi_appends_live_bubble_after_committed() {
        val committed = listOf(ChatMessage(ts = 1, role = "user", content = "hi"))
        val live = ChatMessage(ts = 2, role = "assistant", content = "he", streaming = true, cycleId = "c1")
        val m = ChatModel(committed = committed, live = live, tasks = emptyList())
        val ui = m.messagesForUi()
        assertEquals(2, ui.size)
        assertEquals("he", ui.last().content)
        assertEquals(true, ui.last().streaming)
    }

    @Test
    fun messagesForUi_is_committed_only_when_no_live() {
        val committed = listOf(ChatMessage(ts = 1, role = "user", content = "hi"))
        val m = ChatModel(committed = committed, live = null, tasks = emptyList())
        assertEquals(1, m.messagesForUi().size)
    }
}
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement**

```kotlin
package io.sentient.mobiledata.model

import io.sentient.mobilesdk.connectors.TaskSnapshotItem
import io.sentient.mobilesdk.sdk.ChatMessage

data class ChatModel(
    val committed: List<ChatMessage> = emptyList(),
    val live: ChatMessage? = null,
    val tasks: List<TaskSnapshotItem> = emptyList(),
) {
    fun messagesForUi(): List<ChatMessage> =
        if (live == null) committed else committed + live.copy(tools = tasks)
}
```

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** — `feat(mobile-data): ChatModel domain model`.

### Task 2.4: Outbox FSM

**Files:**
- Create: `shared/mobile-data/src/commonMain/kotlin/io/sentient/mobiledata/outbox/Outbox.kt`
- Test: `shared/mobile-data/src/commonTest/kotlin/io/sentient/mobiledata/outbox/OutboxTest.kt`

- [ ] **Step 1: Failing test** — enqueue while not-ready holds; flush on ready in order; dedup; fail.

```kotlin
package io.sentient.mobiledata.outbox

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class OutboxTest {
    @Test
    fun holds_when_not_ready_then_flushes_in_order() {
        val sent = mutableListOf<String>()
        val ob = Outbox(send = { sent.add(it.text) })
        ob.enqueue(PendingMessage("m1", "hello"))
        ob.enqueue(PendingMessage("m2", "world"))
        assertTrue(sent.isEmpty())          // not ready yet
        ob.onReady()
        assertEquals(listOf("hello", "world"), sent)
    }

    @Test
    fun does_not_double_send_after_second_ready() {
        val sent = mutableListOf<String>()
        val ob = Outbox(send = { sent.add(it.text) })
        ob.enqueue(PendingMessage("m1", "hello"))
        ob.onReady()
        ob.onReady()                         // reconnect re-fires ready
        assertEquals(1, sent.size)           // dedup — no double send
    }

    @Test
    fun fail_marks_pending_failed() {
        val ob = Outbox(send = {})
        ob.enqueue(PendingMessage("m1", "hello"))
        ob.failAll("auth dead")
        assertEquals(MessageStatus.FAILED, ob.snapshot().first().status)
    }
}
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement**

```kotlin
package io.sentient.mobiledata.outbox

enum class MessageStatus { QUEUED, SENT, FAILED }

data class PendingMessage(
    val id: String,
    val text: String,
    val status: MessageStatus = MessageStatus.QUEUED,
)

class Outbox(private val send: (PendingMessage) -> Unit) {
    private val queue = LinkedHashMap<String, PendingMessage>()

    fun enqueue(msg: PendingMessage) { queue[msg.id] = msg }

    fun onReady() {
        for (m in queue.values.toList()) {
            if (m.status == MessageStatus.QUEUED) {
                send(m)
                queue[m.id] = m.copy(status = MessageStatus.SENT)
            }
        }
    }

    fun failAll(@Suppress("UNUSED_PARAMETER") reason: String) {
        for (m in queue.values.toList()) {
            if (m.status == MessageStatus.QUEUED) queue[m.id] = m.copy(status = MessageStatus.FAILED)
        }
    }

    fun snapshot(): List<PendingMessage> = queue.values.toList()
}
```

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** — `feat(mobile-data): outbox FSM (queue/flush/dedup/fail)`.

### Task 2.5: ConnectionRepository

**Files:**
- Create: `shared/mobile-data/src/commonMain/kotlin/io/sentient/mobiledata/repository/ConnectionRepository.kt`
- Test: `shared/mobile-data/src/commonTest/kotlin/io/sentient/mobiledata/repository/ConnectionRepositoryTest.kt`

- [ ] **Step 1: Failing test** — maps SDK `ConnectionState` flags into `SentientResult`/error stream. Use a fake exposing a `MutableStateFlow<ConnectionState>`.

```kotlin
package io.sentient.mobiledata.repository

import io.sentient.mobiledata.result.SentientResult
import io.sentient.mobilesdk.result.ErrorKind
import io.sentient.mobilesdk.sdk.ConnectionState
import io.sentient.mobilesdk.transport.SdkStatus
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class ConnectionRepositoryTest {
    @Test
    fun authExpired_maps_to_terminal_auth_failure() = runTest {
        val src = MutableStateFlow(ConnectionState(status = SdkStatus.ERROR, authExpired = true))
        val repo = ConnectionRepository(connection = src)
        val r = repo.status.first()
        assertTrue(r is SentientResult.Failure)
        assertEquals(ErrorKind.AUTH, (r as SentientResult.Failure).error.kind)
    }

    @Test
    fun ready_maps_to_success() = runTest {
        val src = MutableStateFlow(ConnectionState(status = SdkStatus.READY, hasSession = true))
        val repo = ConnectionRepository(connection = src)
        val r = repo.status.first()
        assertTrue(r is SentientResult.Success)
    }
}
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** — map status/flags to Result. `CONNECTING/AUTHENTICATING/RECONNECTING` → `Loading`; `READY` → `Success(ConnectionState)`; `authExpired` → `Failure(Auth(terminal=true))`; `connectionLost` → `Failure(Connection(...))`.

```kotlin
package io.sentient.mobiledata.repository

import io.sentient.mobiledata.result.SentientResult
import io.sentient.mobilesdk.result.SentientError
import io.sentient.mobilesdk.sdk.ConnectionState
import io.sentient.mobilesdk.transport.SdkStatus
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.map

class ConnectionRepository(private val connection: StateFlow<ConnectionState>) {
    val status: Flow<SentientResult<ConnectionState>> = connection.map { c ->
        when {
            c.authExpired -> SentientResult.Failure(SentientError.Auth("Session expired", terminal = true))
            c.connectionLost -> SentientResult.Failure(SentientError.Connection("Connection lost"))
            c.status == SdkStatus.READY -> SentientResult.Success(c)
            c.status == SdkStatus.ERROR -> SentientResult.Failure(SentientError.Unknown("Connection error"))
            else -> SentientResult.Loading(partial = c)   // CONNECTING/AUTHENTICATING/RECONNECTING/DISCONNECTED
        }
    }
}
```

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** — `feat(mobile-data): ConnectionRepository maps connection → Result`.

## ADDENDUM (2026-06-06): client `pendingId` round-trip

**Decision (supersedes the FIFO text-match idea):** exact optimistic-send reconciliation via a client-generated `pendingId` that round-trips on the wire. Enables per-message retry later. `pendingId` is **optional everywhere** (`pendingId?: string` / `String? = null`) → backward-compatible; web keeps working untouched. The user feed entry is gateway-constructed (confirmed) so **no Hermes change** is needed. This inserts a protocol prelude before Task 2.6.

### Task 2.5c: Protocol — optional pendingId on text.input + user feed item
**Files:** `shared/protocol/src/messages.ts` (textInputSchema +`pendingId: z.string().optional()`), `shared/protocol/src/conversation.ts` (conversationFeedUserItemSchema +`pendingId: z.string().optional()`), tests `shared/protocol/src/messages.test.ts`.
- TDD: add a parse test that `text.input` with/without pendingId validates, and the user feed item carries pendingId. Implement the two optional fields. Run `bun run --filter @sentient/protocol test` (or the repo's protocol test cmd). Commit `feat(protocol): optional pendingId on text.input + user feed item`.

### Task 2.5d: Gateway — thread pendingId ingress→mirror→feed DTO; verify web builds
**Files:** `gateway/src/session-handlers/ws-handlers.ts` (pass `msg.pendingId` to handleTextInput), `gateway/src/adapters/user-text-input-adapter.ts` (accept + forward pendingId), `gateway/src/cerebrum/conversation-mirror.ts` (MirrorEntry user variant +pendingId), `gateway/src/cerebrum/conversation-feed.ts` (toFeedItem user case +pendingId), test `gateway/src/adapters/user-text-input-adapter.test.ts`.
- TDD: assert a text.input with pendingId appends a mirror user entry carrying it, and `toFeedItem` emits it on `conversation.entry`. Implement the thread-through.
- **Web compat:** run `bun run typecheck` + `bun run build` (or `bun run ci`) — confirm `gateway/webui` + `shared/web-sdk` still build against the changed protocol (optional field → should be clean). Apply only the minimal type fix if a strict constructor breaks; do NOT migrate web's optimistic-dedup to pendingId (deferred follow-up). 
- Verify: rebuild local stack (`deploy/macos`), web smoke "hi" still commits + renders (no regression). Commit `feat(gateway): thread client pendingId onto user conversation feed echo`.

### Task 2.5e: mobile-sdk — pendingId on TextInput + ConversationFeedItem.User + sendText
**Files:** `protocol/ClientMessage.kt` (TextInput +`pendingId: String? = null`), `protocol/ConversationFeedItem.kt` (User +`pendingId: String? = null`), `connectors/UserTextInputConnector.kt` (`sendText(text, pendingId)`), `sdk/SentientSdk.kt` (`sendText(text: String, pendingId: String? = null)`), tests `WireSerializationTest.kt` + `UserTextInputConnectorTest.kt`.
- TDD: assert TextInput serializes pendingId when present/omits when null; sendText forwards it; User feed item deserializes pendingId. Implement. Run `:shared:mobile-sdk:allTests`. Commit `feat(mobile-sdk): carry pendingId on text.input + user feed item`.

### Task 2.6 (REVISED): ChatRepository — fold events + outbox + pendingId reconciliation
Supersedes the original 2.6 below. ChatRepository holds: `live` (from MessageDelta reduce), `tasks`, and `pending: List<ChatMessage>` (optimistic user messages keyed by pendingId, status QUEUED/SENT/FAILED). `chatStream = combine(timeline, model)` MERGES (does NOT overwrite): `messagesForUi = timeline + pending-whose-pendingId-not-yet-in-timeline + live(tasks)`. When a timeline `User` entry arrives whose `pendingId` matches a pending, drop that pending (exact dedup, no FIFO guessing). `send(text)` generates a pendingId, optimistically adds a QUEUED pending bubble, enqueues outbox; `onReady` flushes via `sdk.sendText(text, pendingId)`. **No-loss is tested at the pure `reduce` level** (ordered deltas accumulate to full content) — NOT via fragile intermediate-StateFlow-emission assertions (the model StateFlow conflates, which is fine: content is cumulative, UI renders latest + typewriter). The original combine below is buggy (it clobbers `committed` with timeline) — use the merge approach instead.

### Task 2.6 (original — DO NOT IMPLEMENT AS-IS; see REVISED above): ChatRepository — fold events + outbox

**Files:**
- Create: `shared/mobile-data/src/commonMain/kotlin/io/sentient/mobiledata/repository/ChatRepository.kt`
- Test: `shared/mobile-data/src/commonTest/kotlin/io/sentient/mobiledata/repository/ChatRepositoryTest.kt`

- [ ] **Step 1: Failing test** — folding `MessageStarted`/`MessageDelta`×N/`TaskUpserted`/`MessageCommitted` produces a growing live bubble (each delta observable) then a committed message; tasks append in order. Drive via a `MutableSharedFlow<SdkEvent>` + a `MutableStateFlow<List<ChatMessage>>` timeline fake.

```kotlin
package io.sentient.mobiledata.repository

import io.sentient.mobiledata.model.ChatModel
import io.sentient.mobiledata.result.SentientResult
import io.sentient.mobilesdk.connectors.TaskSnapshotItem
import io.sentient.mobilesdk.protocol.SdkEvent
import io.sentient.mobilesdk.sdk.ChatMessage
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class ChatRepositoryTest {
    @Test
    fun each_delta_is_observable_then_commit() = runTest {
        val events = MutableSharedFlow<SdkEvent>(extraBufferCapacity = 64)
        val timeline = MutableStateFlow<List<ChatMessage>>(emptyList())
        val repo = ChatRepository(events = events, timeline = timeline, scope = backgroundScope, send = {})

        val seen = mutableListOf<ChatModel>()
        val job = launch { repo.chatStream.collect { if (it is SentientResult.Success) seen.add(it.data) } }

        events.emit(SdkEvent.MessageStarted("c1"))
        events.emit(SdkEvent.MessageDelta("c1", "He"))
        events.emit(SdkEvent.MessageDelta("c1", "llo"))
        events.emit(SdkEvent.TaskUpserted(TaskSnapshotItem("t1", "search", "c1", "running", "{}", 1L)))
        val committed = ChatMessage(ts = 2, role = "assistant", content = "Hello", cycleId = "c1")
        events.emit(SdkEvent.MessageCommitted(committed))
        runCurrent()

        // Observed intermediate growth: "He" then "Hello" live bubble before commit
        val liveContents = seen.mapNotNull { it.live?.content }
        assertTrue(liveContents.contains("He"))
        assertTrue(liveContents.contains("Hello"))
        // After commit, live is cleared and committed list grows via timeline fold
        job.cancel()
    }
}
```
(Note: this test asserts intermediate emissions are *not* conflated away — that's the whole point. `backgroundScope`/`runCurrent` come from `kotlinx-coroutines-test`.)

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** — maintain an internal `MutableStateFlow<ChatModel>`; collect `events` on the injected scope, mutate the model per event; merge `timeline` for committed messages; expose `chatStream: Flow<SentientResult<ChatModel>>`. Integrate the `Outbox` for `send`. Keep the fold pure-ish (a `reduce(model, event)` function that is unit-testable).

```kotlin
package io.sentient.mobiledata.repository

import io.sentient.mobiledata.model.ChatModel
import io.sentient.mobiledata.outbox.Outbox
import io.sentient.mobiledata.outbox.PendingMessage
import io.sentient.mobiledata.result.SentientResult
import io.sentient.mobilesdk.protocol.SdkEvent
import io.sentient.mobilesdk.sdk.ChatMessage
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch

class ChatRepository(
    private val events: SharedFlow<SdkEvent>,
    private val timeline: StateFlow<List<ChatMessage>>,
    scope: CoroutineScope,
    send: (String) -> Unit,
) {
    private val model = MutableStateFlow(ChatModel())
    private val outbox = Outbox(send = { send(it.text) })

    init {
        scope.launch { events.collect { model.value = reduce(model.value, it) } }
    }

    val chatStream: Flow<SentientResult<ChatModel>> =
        combine(model, timeline) { m, committed ->
            SentientResult.Success(m.copy(committed = committed))
        }

    fun send(id: String, text: String) {
        model.value = model.value.copy(
            committed = model.value.committed + ChatMessage(ts = 0, role = "user", content = text),
        )
        outbox.enqueue(PendingMessage(id, text))
    }

    fun onReady() = outbox.onReady()
    fun failOutbox(reason: String) = outbox.failAll(reason)

    companion object {
        fun reduce(m: ChatModel, e: SdkEvent): ChatModel = when (e) {
            is SdkEvent.MessageStarted ->
                m.copy(live = ChatMessage(ts = 0, role = "assistant", content = "", streaming = true, cycleId = e.cycleId))
            is SdkEvent.MessageDelta ->
                m.copy(live = (m.live ?: ChatMessage(0, "assistant", "", true, cycleId = e.cycleId))
                    .let { it.copy(content = it.content + e.chunk) })
            is SdkEvent.MessageCommitted ->
                m.copy(live = null, tasks = emptyList())
            is SdkEvent.TaskUpserted ->
                m.copy(tasks = upsert(m.tasks, e.task))
            else -> m
        }

        private fun upsert(list: List<io.sentient.mobilesdk.connectors.TaskSnapshotItem>, t: io.sentient.mobilesdk.connectors.TaskSnapshotItem) =
            (list.filterNot { it.taskId == t.taskId } + t).sortedBy { it.startedAtMs }
    }
}
```
(`ChatMessage` positional constructor must match `SdkState.kt:34-42` — adjust named args if the test compiler complains.)

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Add a focused `reduce` unit test** for ordered deltas + task upsert ordering (pure function, no coroutines), commit alongside.
- [ ] **Step 6: Commit** — `feat(mobile-data): ChatRepository event-fold + outbox`.

### Task 2.7: HistoryRepository + cache (cache-then-refresh)

**Files:**
- Create: `shared/mobile-data/src/commonMain/kotlin/io/sentient/mobiledata/repository/HistoryRepository.kt`
- Test: `shared/mobile-data/src/commonTest/kotlin/io/sentient/mobiledata/repository/HistoryRepositoryTest.kt`

- [ ] **Step 1: Failing test** — first emission is cached list as `Loading(partial=cache)` (instant), then `Success(fresh)` after refresh; a refresh failure with a non-empty cache yields `Failure` but the VM keeps last-good (assert Failure carries error, cache still available via `cached()`).

```kotlin
package io.sentient.mobiledata.repository

import io.sentient.mobiledata.result.SentientResult
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class HistoryRepositoryTest {
    private val cached = listOf(SessionRowData("s1", "Old chat", 1L))
    private val fresh = listOf(SessionRowData("s2", "New chat", 2L))

    @Test
    fun emits_cache_loading_then_fresh_success() = runTest {
        val repo = HistoryRepository(fetch = { fresh })
        repo.seedCache(cached)
        val emissions = mutableListOf<SentientResult<List<SessionRowData>>>()
        repo.load().collect { emissions.add(it) }
        assertTrue(emissions.first() is SentientResult.Loading)
        assertEquals(cached, (emissions.first() as SentientResult.Loading).partial)
        assertTrue(emissions.last() is SentientResult.Success)
        assertEquals(fresh, (emissions.last() as SentientResult.Success).data)
    }

    @Test
    fun refresh_failure_emits_failure_but_keeps_cache() = runTest {
        val repo = HistoryRepository(fetch = { throw RuntimeException("timeout") })
        repo.seedCache(cached)
        val emissions = mutableListOf<SentientResult<List<SessionRowData>>>()
        repo.load().collect { emissions.add(it) }
        assertTrue(emissions.last() is SentientResult.Failure)
        assertEquals(cached, repo.cached())
    }
}
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** (`fetch` abstracts `sdk.listSessions`; map `SessionsListPage.items` → `SessionRowData` in the caller, or pass a typed fetch). Use `flow { emit(Loading(cache)); runCatching{fetch()}.fold(onSuccess={cache=it; emit(Success(it))}, onFailure={emit(Failure(Timeout))}) }`.

```kotlin
package io.sentient.mobiledata.repository

import io.sentient.mobiledata.result.SentientResult
import io.sentient.mobilesdk.result.SentientError
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow

data class SessionRowData(val id: String, val title: String, val updatedAtMs: Long)

class HistoryRepository(private val fetch: suspend () -> List<SessionRowData>) {
    private var cache: List<SessionRowData> = emptyList()

    fun seedCache(rows: List<SessionRowData>) { cache = rows }
    fun cached(): List<SessionRowData> = cache

    fun load(): Flow<SentientResult<List<SessionRowData>>> = flow {
        emit(SentientResult.Loading(partial = cache))
        runCatching { fetch() }.fold(
            onSuccess = { cache = it; emit(SentientResult.Success(it)) },
            onFailure = { emit(SentientResult.Failure(SentientError.Timeout("Couldn't load chats", cause = it))) },
        )
    }
}
```

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** — `feat(mobile-data): HistoryRepository cache-then-refresh`.

### Task 2.8: Result-aware repo logging

**Files:**
- Modify: each repository to log `SentientResult` transitions via the SDK's `createLogger` (re-exported through `api(project(":shared:mobile-sdk"))`).

- [ ] **Step 1:** In `ChatRepository`, `HistoryRepository`, `ConnectionRepository`, add `private val log = createLogger("data", "<repo>")` (import `io.sentient.mobilesdk.log.createLogger`). Log on each emit: `log.debug("result", mapOf("kind" to resultKind, "ids" to ...))`. Tags resolve to `sentient.mobile-sdk.data.chat` etc. (Acceptable — the loggerTag prefix is fixed in `Log.kt:41`; the `data.*` suffix is what matters for grep.)
- [ ] **Step 2:** Build + full repo suite: `./gradlew :shared:mobile-data:allTests`. Expected: PASS.
- [ ] **Step 3: Commit** — `feat(mobile-data): Result-aware repository logging`.

### Task 2.9: Build MobileData.xcframework + SKIE smoke

- [ ] **Step 1:** Run `./gradlew :shared:mobile-data:assembleMobileDataXCFramework`. Expected: BUILD SUCCESSFUL; `shared/mobile-data/build/XCFrameworks/debug/MobileData.xcframework` exists and (via `export`) exposes both repo + SDK symbols.
- [ ] **Step 2:** Verify a Swift snippet can `import MobileData`, construct a `ChatRepository`, and exhaustively switch a `SentientResult`. Record success in `agents/docs/mobile-sdk/`.
- [ ] **Step 3: Commit** — `chore(mobile-data): produce MobileData XCFramework (umbrella)`.

---

# PHASE 3 — Android (reference platform)

Replace the `SdkHolder` singleton with a chat-scoped factory + per-screen ViewModels on the repos. Order matters: build the new VMs first (Tasks 3.1–3.3), migrate screens (3.4–3.5), then delete the singleton (3.6).

### Task 3.1: ChatViewModel + ChatUiState

**Files:**
- Create: `android/src/main/kotlin/io/sentient/android/chat/ChatUiState.kt`
- Create: `android/src/main/kotlin/io/sentient/android/chat/ChatViewModel.kt`
- Modify: `android/build.gradle.kts` (add `implementation(project(":shared:mobile-data"))`)
- Test: `android/src/test/kotlin/io/sentient/android/chat/ChatViewModelTest.kt`

- [ ] **Step 1:** Add the module dependency to `android/build.gradle.kts:51` block: `implementation(project(":shared:mobile-data"))`.

- [ ] **Step 2: Write the failing test** — VM exposes `StateFlow<ChatUiState>`; a `chatStream` Success with a live bubble yields `uiState.messages` containing the streaming bubble; a Failure yields a `banner`.

```kotlin
package io.sentient.android.chat

import io.sentient.mobiledata.model.ChatModel
import io.sentient.mobiledata.result.SentientResult
import io.sentient.mobilesdk.result.SentientError
import io.sentient.mobilesdk.sdk.ChatMessage
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull

class ChatViewModelTest {
    @Test
    fun success_with_live_bubble_renders_streaming_message() = runTest {
        val model = ChatModel(
            committed = listOf(ChatMessage(1, "user", "hi")),
            live = ChatMessage(2, "assistant", "he", streaming = true, cycleId = "c1"),
        )
        val ui = reduceChatUi(ChatUiState(), SentientResult.Success(model))
        assertEquals(2, ui.messages.size)
        assertEquals(true, ui.messages.last().streaming)
    }

    @Test
    fun failure_sets_banner_but_keeps_messages() = runTest {
        val prior = ChatUiState(messages = listOf(ChatMessage(1, "user", "hi")))
        val ui = reduceChatUi(prior, SentientResult.Failure(SentientError.Connection("lost")))
        assertEquals(1, ui.messages.size)            // last-good kept
        assertNotNull(ui.banner)
        assertEquals("lost", ui.banner!!.text)
    }
}
```

- [ ] **Step 3: Run — expect FAIL.** `./gradlew :android:testDebugUnitTest --tests "*ChatViewModelTest*"`

- [ ] **Step 4: Implement** `ChatUiState.kt` (pure reduce extracted for testability):

```kotlin
package io.sentient.android.chat

import io.sentient.mobiledata.model.ChatModel
import io.sentient.mobiledata.result.SentientResult
import io.sentient.mobilesdk.sdk.ChatMessage

data class ErrorBanner(val text: String, val canRetry: Boolean)

data class ChatUiState(
    val messages: List<ChatMessage> = emptyList(),
    val isLoading: Boolean = false,
    val banner: ErrorBanner? = null,
)

fun reduceChatUi(prev: ChatUiState, result: SentientResult<ChatModel>): ChatUiState = when (result) {
    is SentientResult.Loading -> prev.copy(
        isLoading = true,
        messages = result.partial?.messagesForUi() ?: prev.messages,
    )
    is SentientResult.Success -> ChatUiState(messages = result.data.messagesForUi(), isLoading = false, banner = null)
    is SentientResult.Failure -> prev.copy(
        isLoading = false,
        banner = ErrorBanner(result.error.userMessage, canRetry = result.error.retry != io.sentient.mobilesdk.result.RetryPolicy.None),
    )
}
```

- [ ] **Step 5: Implement** `ChatViewModel.kt` (collects `chatStream`, folds via `reduceChatUi`):

```kotlin
package io.sentient.android.chat

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import io.sentient.mobiledata.repository.ChatRepository
import io.sentient.mobilesdk.log.createLogger
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

class ChatViewModel(
    private val repo: ChatRepository,
    private val onOpen: suspend () -> Unit,        // acquire+connect SDK (chat-scoped)
    private val onClose: () -> Unit,               // disconnect SDK
    private val newId: () -> String,
) : ViewModel() {
    private val log = createLogger("android", "chat-viewmodel")
    private val _state = MutableStateFlow(ChatUiState())
    val state: StateFlow<ChatUiState> = _state.asStateFlow()

    init {
        log.info("init")
        viewModelScope.launch { onOpen() }                     // background; UI usable immediately
        viewModelScope.launch {
            repo.chatStream.collect { _state.value = reduceChatUi(_state.value, it) }
        }
    }

    fun send(text: String) {
        log.info("send", mapOf("len" to text.length))
        repo.send(newId(), text)                               // optimistic + outbox
    }

    override fun onCleared() {
        log.info("onCleared")
        onClose()
    }
}
```

- [ ] **Step 6: Run — expect PASS.**
- [ ] **Step 7: Commit** — `feat(android): ChatViewModel + ChatUiState on ChatRepository`.

### Task 3.2: Chat-scoped SDK factory (replaces SdkHolder build)

**Files:**
- Create: `android/src/main/kotlin/io/sentient/android/sdk/SdkSessionFactory.kt`
- Test: covered indirectly; no new unit test (factory wiring per testing rules).

- [ ] **Step 1: Implement** a factory that builds a `SentientSdk` with a fresh `CoroutineScope` per chat session and wires repos:

```kotlin
package io.sentient.android.sdk

import io.sentient.mobiledata.repository.ChatRepository
import io.sentient.mobiledata.repository.ConnectionRepository
import io.sentient.mobilesdk.sdk.SentientSdk
import io.sentient.mobilesdk.sdk.SdkConfig
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel

class ChatSession(
    val sdk: SentientSdk,
    val chatRepo: ChatRepository,
    val connectionRepo: ConnectionRepository,
    private val scope: CoroutineScope,
) {
    suspend fun open() = sdk.connect()
    fun close() { sdk.disconnect(clearSession = false); scope.cancel() }
}

object SdkSessionFactory {
    fun create(config: SdkConfig, bundle: io.sentient.mobilesdk.sdk.PlatformBundle): ChatSession {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default.limitedParallelism(1))
        val sdk = SentientSdk(config = config, bundle = bundle, scope = scope)
        val chatRepo = ChatRepository(events = sdk.events, timeline = sdk.timeline, scope = scope, send = sdk::sendText)
        val connectionRepo = ConnectionRepository(connection = sdk.connection)
        // wire outbox flush on READY
        scope.launch { sdk.connection.collect { if (it.status == io.sentient.mobilesdk.transport.SdkStatus.READY) chatRepo.onReady() } }
        return ChatSession(sdk, chatRepo, connectionRepo, scope)
    }
}
```
(Resolve `config`/`bundle` from `BackendConfigHolder` + the existing `bundle` that `SdkHolder` built — lift `buildFrom` logic from `SdkHolder.kt:134-147` into here. Add the missing `launch` import.)

- [ ] **Step 2: Build:** `./gradlew :android:assembleDebug`. Expected: SUCCESS.
- [ ] **Step 3: Commit** — `feat(android): chat-scoped SDK session factory`.

### Task 3.3: PresenceCoordinator

**Files:**
- Create: `android/src/main/kotlin/io/sentient/android/presence/PresenceCoordinator.kt`

- [ ] **Step 1: Implement** (app-scoped, observes `ProcessLifecycleOwner`; holds only a presence enum + a settable callback to the active session — zero chat state)

```kotlin
package io.sentient.android.presence

import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import io.sentient.mobilesdk.log.createLogger

class PresenceCoordinator {
    private val log = createLogger("android", "presence")
    private var onForeground: (() -> Unit)? = null
    private var onBackground: (() -> Unit)? = null

    fun bind(onForeground: () -> Unit, onBackground: () -> Unit) {
        this.onForeground = onForeground
        this.onBackground = onBackground
    }
    fun unbind() { onForeground = null; onBackground = null }

    fun start() {
        ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onStart(owner: LifecycleOwner) { log.info("foreground"); onForeground?.invoke() }
            override fun onStop(owner: LifecycleOwner) { log.info("background"); onBackground?.invoke() }
        })
    }
}
```
Add `implementation(libs.androidx.lifecycle.process)` to `android/build.gradle.kts` (confirm the alias; else `androidx.lifecycle:lifecycle-process`).

- [ ] **Step 2:** In `ChatViewModel`, accept the coordinator and `bind(onForeground = { viewModelScope.launch { onOpen() } }, onBackground = { onClose() })` in `init`, `unbind()` in `onCleared`. (Foreground reconnect + background disconnect = battery/idle contract.)
- [ ] **Step 3: Build green.**
- [ ] **Step 4: Commit** — `feat(android): PresenceCoordinator (foreground/background)`.

### Task 3.4: Migrate ChatScreen to ChatUiState

**Files:**
- Modify: `android/src/main/kotlin/io/sentient/android/chat/ChatScreen.kt` (`:66-80`, `:135-142`)
- Modify: `android/src/main/kotlin/io/sentient/android/MainActivity.kt` (`:213-227`)

- [ ] **Step 1:** Change `ChatScreen` signature to take `state: ChatUiState` instead of `state: SdkState`, plus a `connection: ConnectionState` for the banner/voice affordances (voiceMode/isSpeaking now live in `ConnectionState`). Update `MessageList(messages = state.messages, ...)` — `MessageList` already takes `List<ChatMessage>` (`MessageList.kt:44-50`), unchanged. Add an `ErrorBanner` composable rendering `state.banner` with a retry button when `canRetry`.
- [ ] **Step 2:** In `MainActivity` `AppConfiguredRoot`, construct `ChatViewModel` via a `viewModelFactory` that builds a `ChatSession` from `SdkSessionFactory` and passes `chatRepo`. Collect `chatViewModel.state` + `chatSession.connectionRepo` for `connection`. Wire `onSend = chatViewModel::send`, mic/tts/interrupt against the session SDK.
- [ ] **Step 3: Build + run on emulator:** `./gradlew :android:installDebug` then manually verify chat sends + streams. (Full assertion is Phase 5 Maestro.)
- [ ] **Step 4: Commit** — `feat(android): ChatScreen renders ChatUiState (live streaming)`.

### Task 3.5: HistoryViewModel → HistoryRepository (kill the 12s-error)

**Files:**
- Modify: `android/src/main/kotlin/io/sentient/android/history/HistoryViewModel.kt` (`:89-169`)
- Modify: `android/src/main/kotlin/io/sentient/android/history/HistoryDrawer.kt` (`:84-100`)
- Test: `android/src/test/kotlin/io/sentient/android/history/HistoryViewModelTest.kt`

- [ ] **Step 1: Failing test** — opening the drawer with a seeded cache renders instantly (`loading=true` but `sessions` non-empty from cache), then fills; a refresh failure keeps cache + shows stale banner.

```kotlin
// Assert: first state has cached rows (visible non-empty) while loading; final state has fresh rows.
// Drive HistoryViewModel with a fake HistoryRepository returning Loading(partial=cache) then Success(fresh).
```
(Write the concrete test mirroring `HistoryRepositoryTest` shapes; assert `state.value.sessions` is the cache before the fresh emission, then fresh after.)

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** — `HistoryViewModel` collects `historyRepo.load()` and folds into `HistoryUiState` (reuse existing `HistoryUiState` at `:48-78`; `showsStaleBanner` already exists). Remove the `withTimeout(LIST_SESSIONS_TIMEOUT_MS)`-throws-error path (`:143-169`); the repo's `Failure` branch now drives `error`, and cache drives `sessions`.
- [ ] **Step 4:** In `HistoryDrawer` (`:98-100`), keep `refresh()` on open but it's now non-blocking (cache renders instantly). No dead 12s error.
- [ ] **Step 5: Run — expect PASS; build green.**
- [ ] **Step 6: Commit** — `feat(android): history drawer cache-then-refresh, no blocking timeout`.

### Task 3.6: Delete SdkHolder singleton

**Files:**
- Delete: `android/src/main/kotlin/io/sentient/android/sdk/SdkHolder.kt`
- Modify: `SdkViewModel.kt` (delete or reduce to nothing), `AuthViewModel.kt` (`:69-74`, `:128-152`), `MainActivity.kt` (`:69-103`, `:147`), `SettingsViewModel.kt`

- [ ] **Step 1:** Move `tokenStore`/`authClient`/`bundle` ownership out of `SdkHolder` into a tiny `AppDependencies` holder (config + secure stores only — no SDK). `AuthViewModel.sdkConnect` becomes "open a chat session" via the factory after login (or just navigates; the chat VM opens the session on init). Replace `SdkHolder.authClient`/`SdkHolder.tokenStore` references with `AppDependencies`.
- [ ] **Step 2:** Delete `SdkViewModel` (its passthrough is replaced by `ChatViewModel`). Remove its instantiation in `MainActivity:69-84` and the `ensureBuilt()` call at `:147`.
- [ ] **Step 3: Build:** `./gradlew :android:assembleDebug`. Fix all dangling references (per "don't preserve stale refs" rule — verify each remaining reference is valid). Expected: SUCCESS, zero references to `SdkHolder`.
- [ ] **Step 4:** `grep -r "SdkHolder" android/src` → expect no results.
- [ ] **Step 5: Commit** — `refactor(android): delete SdkHolder singleton; chat-scoped SDK only`.

### Task 3.7: Error banners + retry wiring

- [ ] **Step 1:** Implement the `ErrorBanner` composable + retry action: `canRetry` banners call `chatViewModel.retry()` / `historyViewModel.refresh()`. Terminal auth errors route to logout/login.
- [ ] **Step 2:** Build green; manual emulator check of the connection-lost banner (toggle wifi via `adb`).
- [ ] **Step 3: Commit** — `feat(android): error banners + retry from SentientResult`.

### Task 3.8: Lifecycle/Result logging pass

- [ ] **Step 1:** Ensure every new VM/coordinator logs per the spec §10 table (init/onCleared, presence transitions, UiState transitions). Add any missing lines.
- [ ] **Step 2:** `./gradlew :android:testDebugUnitTest` + `:android:assembleDebug` green.
- [ ] **Step 3: Commit** — `feat(android): event-chain + lifecycle logging`.

---

# PHASE 4 — iOS (mirror)

Mirror Phase 3. Swift `ObservableObject` (or `@Observable`) per screen; `scenePhase` presence; delete app-scoped `SdkStore`. Use the same repos via `MobileData.xcframework`.

### Task 4.1: Swap framework MobileSdk → MobileData

**Files:**
- Modify: `ios/project.yml` (`:60-61`)

- [ ] **Step 1:** Build the umbrella framework: `./gradlew :shared:mobile-data:assembleMobileDataXCFramework`.
- [ ] **Step 2:** Change `ios/project.yml:60` to reference `../shared/mobile-data/build/XCFrameworks/debug/MobileData.xcframework`. Run `xcodegen generate` in `ios/`.
- [ ] **Step 3:** Change `import MobileSdk` → `import MobileData` across the iOS app (the umbrella re-exports SDK types). Build the app target. Expected: compiles (SDK types still resolve through MobileData).
- [ ] **Step 4: Commit** — `chore(ios): consume MobileData umbrella framework`.

### Task 4.2: ChatViewModel + ChatUiState (Swift)

**Files:**
- Create: `ios/App/Chat/ChatViewModel.swift`, `ios/App/Chat/ChatUiState.swift`

- [ ] **Step 1: Implement** the Swift mirror — an `ObservableObject` collecting `chatRepo.chatStream` (SKIE `AsyncSequence`) and folding into a `@Published ChatUiState`:

```swift
import Foundation
import MobileData

struct ErrorBanner { let text: String; let canRetry: Bool }

struct ChatUiState {
    var messages: [ChatMessage] = []
    var isLoading = false
    var banner: ErrorBanner? = nil
}

@MainActor
final class ChatViewModel: ObservableObject {
    @Published private(set) var state = ChatUiState()
    private let session: ChatSession
    private var collectTask: Task<Void, Never>?
    private let log = AppLog("chat", "viewmodel")

    init(session: ChatSession) {
        self.session = session
        log.info("init")
        Task { try? await session.open() }                  // background; UI usable now
        collectTask = Task { [weak self] in
            guard let stream = self?.session.chatRepo.chatStream else { return }
            for await result in stream { self?.apply(result) }
        }
    }

    func send(_ text: String) { session.chatRepo.send(id: UUID().uuidString, text: text) }

    private func apply(_ result: SentientResult<ChatModel>) {
        switch onEnum(of: result) {
        case .loading(let l): state.isLoading = true; if let p = l.partial { state.messages = p.messagesForUi() }
        case .success(let s): state = ChatUiState(messages: s.data.messagesForUi(), isLoading: false, banner: nil)
        case .failure(let f): state.isLoading = false
            state.banner = ErrorBanner(text: f.error.userMessage, canRetry: !(f.error.retry is RetryPolicyNone))
        }
    }

    deinit { collectTask?.cancel(); session.close() }
}
```
(Confirm SKIE's generated names: `onEnum(of:)`, the `RetryPolicyNone` case type. Adjust to the actual generated symbols from Task 1.10/2.9 smoke.)

- [ ] **Step 2:** Provide a Swift `ChatSession` factory mirroring `SdkSessionFactory` (or expose the KMP factory and call it from Swift). Build app target.
- [ ] **Step 3: Commit** — `feat(ios): ChatViewModel + ChatUiState on ChatRepository`.

### Task 4.3: scenePhase PresenceCoordinator (Swift)

- [ ] **Step 1:** Add a `PresenceCoordinator` observing `@Environment(\.scenePhase)` at the app root; on `.background` → `session.close()`-style disconnect, on `.active` → reconnect. Holds only presence + a weak session handle.
- [ ] **Step 2:** Build green.
- [ ] **Step 3: Commit** — `feat(ios): scenePhase PresenceCoordinator`.

### Task 4.4: Migrate ChatView to ChatUiState

**Files:**
- Modify: `ios/App/Chat/ChatView.swift` (`:35-38` init, `:144` message reads), `ios/App/RootView.swift` (`:41`)

- [ ] **Step 1:** `ChatView` owns `@StateObject ChatViewModel` (built from a `ChatSession`), reads `vm.state.messages` instead of `store.state.messages`. `MessageList(messages: vm.state.messages, ...)` — `MessageBubble`/`StreamingText` unchanged (they already render `streaming`+`content` per `BubbleAnimations.swift:39-68`); the difference is the data now updates per-delta.
- [ ] **Step 2:** Build + run on simulator; manually verify streaming grows incrementally. Commit — `feat(ios): ChatView renders ChatUiState (live streaming)`.

### Task 4.5: HistoryModel → HistoryRepository

**Files:**
- Modify: `ios/App/History/HistoryModel.swift` (`:29-94`)

- [ ] **Step 1:** `HistoryModel.loadSessions()` consumes `historyRepo.load()` (cache-then-refresh) instead of `store.listSessions()` with throw-on-timeout. Seed `sessions` from cache instantly; fill on `Success`; keep cache + show stale banner on `Failure`.
- [ ] **Step 2:** Build green. Commit — `feat(ios): history cache-then-refresh`.

### Task 4.6: Delete SdkStore-as-singleton

**Files:**
- Modify/Delete: `ios/App/SDK/SdkStore.swift`, `SdkStore+Commands.swift`, `SdkStore+Sessions.swift`, `ios/App/SentientApp.swift` (`:6`, `:20`), `RootView.swift`

- [ ] **Step 1:** Replace the app-scoped `@StateObject SdkStore` with a tiny `AppConfig`/`AppDependencies` object (backend config + secure stores + `isConfigured`). Chat/History VMs own their session via the factory. `RootView` gates on `appConfig.isConfigured` + a session-presence published flag, not a long-lived SDK.
- [ ] **Step 2:** Build; remove all `SdkStore` references (`grep -rn SdkStore ios/App` → none, except the deleted files). Verify no dangling refs.
- [ ] **Step 3: Commit** — `refactor(ios): delete app-scoped SdkStore; chat-scoped SDK only`.

### Task 4.7: Error banners + retry (Swift)

- [ ] **Step 1:** Render `vm.state.banner` with retry; terminal auth → back to login. Build green. Commit — `feat(ios): error banners + retry`.

### Task 4.8: Logging pass (Swift)

- [ ] **Step 1:** `AppLog` lines for VM init/deinit, presence transitions, UiState transitions per spec §10. Build green. Commit — `feat(ios): event-chain + lifecycle logging`.

---

# PHASE 5 — Streaming confirm + Maestro E2E + cleanup

### Task 5.1: Maestro harness + stack scripts

**Files:**
- Create: `qa/mobile/run-e2e.sh`, `qa/mobile/flows/` (Maestro flow dir)

- [ ] **Step 1: Install Maestro** (if absent): `curl -fsSL "https://get.maestro.mobile.dev" | bash`. Verify: `maestro --version`.
- [ ] **Step 2: Write `qa/mobile/run-e2e.sh`** — boots local stack, emulator, installs the debug app (with `devFaultsEnabled=true`), runs `maestro test qa/mobile/flows/`:

```bash
#!/usr/bin/env bash
set -euo pipefail
( cd deploy/macos && docker compose up -d )
adb wait-for-device
./gradlew :android:installDebug
adb logcat -c
maestro test qa/mobile/flows/ --format junit --output qa/mobile/report.xml
```

- [ ] **Step 3:** Ensure the debug build sets `SdkConfig.devFaultsEnabled = true` and `LogConfig.minLevel = DEBUG`. Commit — `chore(qa): Maestro E2E harness + stack scripts`.

### Task 5.2: High-value Maestro flows (full YAML)

**Files:**
- Create one flow file per case under `qa/mobile/flows/`.

- [ ] **Step 1: `01-login.yaml`**

```yaml
appId: io.sentient.android
---
- launchApp
- tapOn: { text: "You" }          # avatar (display name)
- tapOn: "1"
- tapOn: "2"
- tapOn: "3"
- tapOn: "4"                      # PIN 1234
- assertVisible: { id: "composer-input" }   # reached chat
```

- [ ] **Step 2: `06-live-streaming.yaml`** (the core regression — assert incremental growth)

```yaml
appId: io.sentient.android
---
- runFlow: 01-login.yaml
- tapOn: { id: "composer-input" }
- inputText: "tell me a short story"
- tapOn: { id: "composer-send" }
- assertVisible: { id: "pulse-dots" }         # thinking
# growth assertion: the bubble text length increases across polls
- assertVisible: { id: "assistant-bubble" }
- extendedWaitUntil: { visible: { id: "assistant-bubble" }, timeout: 20000 }
```
Plus the log-trail assertion in `run-e2e.sh` post-step: `adb logcat -d | grep "MessageDelta" | wc -l` must be > 5 (many deltas observed, not one batch). Add the assertion id `assistant-bubble`/`pulse-dots`/`composer-send`/`composer-input` as `Modifier.testTag(...)` in the Compose tree (Task 5.2b).

- [ ] **Step 3: `05-outbox.yaml`** (send while connecting)

```yaml
appId: io.sentient.android
---
- runFlow: 01-login.yaml
# immediately on entering chat, before READY, send:
- tapOn: { id: "composer-input" }
- inputText: "hi"
- tapOn: { id: "composer-send" }
- assertVisible: { id: "msg-status-queued" }     # QUEUED chip
- extendedWaitUntil: { visible: { id: "msg-status-sent" }, timeout: 10000 }
```
Log-trail: `adb logcat -d | grep -E "outbox.*(enqueue|flush)"` present, no double-flush.

- [ ] **Step 4: `15-conn-lost.yaml`** (fault injection via adb)

```yaml
appId: io.sentient.android
---
- runFlow: 01-login.yaml
- tapOn: { id: "composer-input" }
- inputText: "hello"
- tapOn: { id: "composer-send" }
- runScript: { file: drop-network.js }          # adb svc data disable / wifi disable
- assertVisible: { id: "banner-connection" }     # ConnectionError banner
- assertVisible: { id: "assistant-bubble" }      # stale messages kept
- runScript: { file: restore-network.js }
- extendedWaitUntil: { notVisible: { id: "banner-connection" }, timeout: 30000 }
```
(`drop-network.js`/`restore-network.js` shell out to `adb shell svc wifi disable|enable`.) Log-trail: `Failure(kind=Connection,retry=Internal)` then `RECONNECTING→READY`.

- [ ] **Step 5: `08-voice-loop.yaml`** (full STT→LLM→TTS, fixture-injected)

```yaml
appId: io.sentient.android
---
- runFlow: 01-login.yaml
- tapOn: { id: "mic-toggle" }                    # arms voice; debug build injects fixture utterance
- assertVisible: { id: "transcript-preview" }    # STT transcript appeared
- extendedWaitUntil: { visible: { id: "assistant-bubble" }, timeout: 25000 }
- assertVisible: { id: "speaking-indicator" }    # isSpeaking true during TTS
```
Pre-req: the debug build's mic capture path consults `FaultHooks.takeFixtureUtterance()` (Task 1.9) and feeds a bundled `qa/mobile/fixtures/whattime.pcm`. Log-trail: `audio uplink start`, `TranscriptUpdated`, `isSpeaking=true`, `audio downlink playback start`. (Burns Fish TTS + real LLM — run on the voice subset only.)

- [ ] **Step 6: Commit** — `test(qa): high-value Maestro flows (streaming, outbox, conn-lost, voice, login)`.

### Task 5.2b: Add testTags / accessibility ids to Compose + SwiftUI

- [ ] **Step 1:** Add `Modifier.testTag("composer-input")`, `"composer-send"`, `"assistant-bubble"`, `"pulse-dots"`, `"msg-status-queued"`, `"msg-status-sent"`, `"banner-connection"`, `"mic-toggle"`, `"transcript-preview"`, `"speaking-indicator"` to the corresponding Android composables (and `.accessibilityIdentifier(...)` to the SwiftUI mirrors). These are the Maestro selectors.
- [ ] **Step 2:** Build green. Commit — `chore(mobile): testTags/a11y-ids for Maestro selectors`.

### Task 5.3: Remaining matrix flows (per spec §12)

- [ ] **Step 1:** Write the remaining flow files following the templates above, one per spec §12 row, with the exact selectors from 5.2b and the log-trail greps from spec §10: `02-backend-setup`, `03-login-bad-pin`, `04-send-connected`, `07-task-pills`, `09-interrupt`, `10-mic-toggle`, `11-drawer-cache`, `12-switch-session`, `13-rename`, `14-delete`, `16-new-chat`, `17-logout`, `18-auth-expired` (uses `FaultHooks.armExpiredToken` via a debug deep-link/intent), `19-list-timeout` (gateway stall), `20-malformed-frame` (`armMalformedFrame`), `21-presence-bg-fg` (`adb shell input keyevent KEYCODE_HOME` then relaunch), `22-idle-disconnect`.
- [ ] **Step 2:** Each flow asserts the "Expected user-visible" via Maestro selectors and the "Expected log trail" via a `grep` in `run-e2e.sh`. No row skipped.
- [ ] **Step 3: Commit** — `test(qa): complete Maestro matrix (Android)`.

### Task 5.4: iOS simulator parity

- [ ] **Step 1:** Add `appId: io.sentient.app` variants (or parameterize) and run the same flows against the booted iOS simulator: `xcrun simctl boot <device>`, build+install the app, `maestro test`. Adjust selectors to the `.accessibilityIdentifier` ids.
- [ ] **Step 2:** Fault-injection on iOS uses the same `FaultHooks` (debug build) + `simctl` for backgrounding; network drop via `Network Link Conditioner`/`simctl` where available, else flag the one or two cases that can't drop network on sim in handover.
- [ ] **Step 3: Commit** — `test(qa): Maestro matrix parity (iOS sim)`.

### Task 5.5: Delete the old `state` surface + final gate

**Files:**
- Modify: `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/sdk/SentientSdk.kt`, `SdkState.kt`, `StateDeriver.kt`

- [ ] **Step 1:** Confirm no consumer reads `sdk.state` (both apps migrated). `grep -rn "\.state" android/src ios/App | grep -i sdk` → none referencing the SDK's `state`.
- [ ] **Step 2:** Delete the `_state`/`state` property and `deriver.derive()`/`deriveMessages` paths now unused. Keep `connection`/`timeline`/`events`. Run `./gradlew :shared:mobile-sdk:allTests` — fix/delete tests that pinned the old `state` per testing rules (borderline tests get deleted).
- [ ] **Step 3:** Full gate: `./gradlew :shared:mobile-sdk:allTests :shared:mobile-data:allTests :android:testDebugUnitTest :android:assembleDebug` + `bash qa/mobile/run-e2e.sh` (full matrix green, both platforms).
- [ ] **Step 4:** If Phase 0 found BATCHED deltas: add a follow-up note/issue for gateway-side delta pacing (the SDK surface is correct regardless; this is a gateway concern). Record in `agents/docs/learnings.md`.
- [ ] **Step 5: Commit** — `refactor(mobile-sdk): remove legacy conflated state surface`.

---

## Self-Review (completed by author)

**Spec coverage:** §4.2 SDK contract → Tasks 1.1–1.8; §5 lifecycle → 3.1–3.3 / 4.2–4.3; §5.1 presence → 3.3 / 4.3; §6 outbox → 2.4 / 2.6; §7 history cache → 2.7 / 3.5 / 4.5; §8 Result → 2.2 / 2.5–2.7; §9 streaming + §1.4 diagnostic → Phase 0 / 1.5 / 2.6 / 5.2; §10 logging → 2.8 / 3.8 / 4.8; §11 testing → unit tasks throughout; §12 E2E matrix → 5.2–5.4 (every row); §13 phases → Phases 0–5; §14 risks → 1.10 / 2.9 SKIE smoke + Phase 0 gate. No spec section unmapped.

**Placeholder scan:** Phase 0–2 steps carry complete code. Phase 3–5 carry complete code for load-bearing pieces; repetitive per-screen UI and the remaining 15 Maestro flows are specified with exact selectors + log-greps following fully-shown templates (Tasks 5.2/5.2b). This is the declared fidelity gradient, not hidden TODOs.

**Type consistency:** `SentientResult`/`SentientError`/`SdkEvent`/`ConnectionState`/`ChatModel`/`ChatUiState`/`ErrorBanner`/`Outbox`/`PendingMessage`/`ChatSession` names are used identically across all tasks. `ChatMessage` constructor matches `SdkState.kt:34-42`. `reduceChatUi` (Android) / `apply` (iOS) fold the same three Result arms.
