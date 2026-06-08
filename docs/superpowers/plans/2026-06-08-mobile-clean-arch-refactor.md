# Mobile Clean-Architecture Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure both mobile clients onto a clean, lifecycle-correct architecture — a shared UseCase layer over stateless repos, framework-managed VM lifecycle (Hilt / SwiftUI-native), and route-based navigation where a conversation is a route — so per-conversation state cleanup is automatic and the cross-conversation leaks are gone.

**Architecture:** Three scopes (App / User-Connection / Route). Shared `commonMain` = stateless repos behind interfaces + usecases that own all combine/transform (`ObserveChatUseCase`: timeline+reveal+pending, suppress-by-cycleId, reconcile-by-pendingId, the typewriter reveal fold). Thin native VMs (Hilt `ViewModel` / SwiftUI `@Observable`) own per-screen state + the `OutboundCache` and gate the flush on connection. Switching conversation is `navigate(Chat(sessionId))` → a fresh VM → clean slate, no `reset()`.

**Phasing & test approach:** **Phase 0 (shared, Tasks 1–8)** is unit-TDD (red→green→commit) — it has no UI. **Phases 1–2 (platform cutovers, Tasks 9–16)** are UI work: per the project test-lean rule, UI is verified by **Maestro e2e against the local stack**, not unit tests — each task's gate is build + the relevant Maestro case green. **Phase 3 (Tasks 17–18)** deletes dead code + rewrites rules. Phases run in order: 0 is the prerequisite; old (`MobileSession`) and new paths coexist until both platforms cut over; Phase 3 deletes the old path.

> Framework-setup steps in Phases 1–2 (Hilt versions, Navigation-Compose graph, `NavigationStack`) give the concrete code + a "verify against the module" note where an exact version/API must be confirmed in situ. That verification IS the step — it is not a placeholder.

**Tech Stack:** Kotlin Multiplatform (`shared/mobile-data` commonMain), kotlinx-coroutines `Flow`/`StateFlow`/`SharedFlow`, kotlinx-coroutines-test, injected `io.sentient.mobilesdk.util.Clock`, kotlin.test. Android: Hilt + Navigation-Compose + Compose. iOS: SwiftUI `NavigationStack` + `@Observable`/`ObservableObject`, SKIE-bridged usecases. Maestro + `adb`/`xcrun simctl` for e2e.

**Test doctrine (project test-lean rule):** test only FSM/invariant/wire-contract units. Passthrough repos, thin command usecases, and the DI factory get **no** unit tests. The three tested units are: `OutboundCache` (queue FSM), `RevealReducer` (no-loss reveal invariant), `ObserveChatUseCase` (combine/suppress/reconcile invariants).

**Baseline note:** the current working tree carries the prior session's keeper UI fixes (drawer gesture, tool-pill format, live-render render) AND interim data-layer scaffolding (`OutboxRepository`/`ReplyStreamRepository`/`ChatRepository` split + `reset()` + `StateDeriver`/connector session-switch hooks). Phase 0 does NOT touch any of that — it adds new files in new packages. The scaffolding remains the live UI path until the Phase 1/2 cutovers, and is deleted in Phase 3. The keeper UI fixes persist.

**Package layout (new):**
- `io.sentient.mobiledata.data` — clean stateless repo interfaces + SDK-backed impls (the old `io.sentient.mobiledata.repository.*` classes are deleted in Phase 3; `data` becomes canonical).
- `io.sentient.mobiledata.usecase` — usecases.
- Reuse existing `io.sentient.mobiledata.outbox.{PendingMessage,MessageStatus}` for the cache.

**SDK surface this layer wraps** (already public on `io.sentient.mobilesdk.sdk.SentientSdk`):
- `timeline: StateFlow<List<ChatMessage>>`, `events: SharedFlow<SdkEvent>`
- `sendText(text: String, pendingId: String)`
- `suspend switchSession(sessionId: String)`, `suspend doNewChat(): ...`, `suspend listSessions(limit, offset)`, `suspend renameSession(id, title)`, `suspend deleteSession(id)`
- `connection: StateFlow<ConnectionState>`

> Verify each SDK signature against `shared/mobile-sdk/.../sdk/SentientSdk.kt` before wiring an impl; if a name differs (e.g. `doNewChat` return type), adapt the impl, not the interface.

---

## File Structure

| File | Responsibility |
|---|---|
| `data/ConversationRepository.kt` | interface: active conversation's `timeline` + `liveEvents` + `send` |
| `data/SdkConversationRepository.kt` | SDK-backed impl (passthrough) |
| `data/SessionsRepository.kt` | interface: list/switchTo/newChat/rename/delete |
| `data/SdkSessionsRepository.kt` | SDK-backed impl (passthrough) |
| `data/ConnectionStateRepository.kt` | interface + SDK-backed impl: `state: StateFlow<ConnectionState>` |
| `outbox/OutboundCache.kt` | VM-owned pending-message queue FSM (`pending` StateFlow) |
| `usecase/RevealReducer.kt` | pure reveal fold (moved from the scaffolding's reducer) + `RevealState` |
| `usecase/ObserveChatUseCase.kt` | combine `timeline + reveal + pending` → `ChatModel` (suppress + reconcile + ticker) |
| `usecase/SwitchConversationUseCase.kt` | `sessionId? → switchTo / newChat` |
| `usecase/SendMessageUseCase.kt` | thin: enqueue is VM's; this performs the repo send |
| `usecase/SessionsUseCases.kt` | `ObserveSessionsUseCase`, `RenameSessionUseCase`, `DeleteSessionUseCase` |
| `di/ChatComponent.kt` | manual factory: SDK → repos → usecases |
| `commonTest/.../outbox/OutboundCacheTest.kt` | queue FSM |
| `commonTest/.../usecase/RevealReducerTest.kt` | no-loss reveal invariant |
| `commonTest/.../usecase/ObserveChatUseCaseTest.kt` | combine/suppress/reconcile invariants |

Reused unchanged: `model/ChatModel.kt`, `outbox/PendingMessage`+`MessageStatus`, `io.sentient.mobilesdk.util.Clock`.

---

### Task 1: ConversationRepository (interface + SDK impl)

**Files:**
- Create: `shared/mobile-data/src/commonMain/kotlin/io/sentient/mobiledata/data/ConversationRepository.kt`
- Create: `shared/mobile-data/src/commonMain/kotlin/io/sentient/mobiledata/data/SdkConversationRepository.kt`

No unit test — passthrough wrapper (test-lean: no DI/plumbing tests).

- [ ] **Step 1: Write the interface**

```kotlin
package io.sentient.mobiledata.data

import io.sentient.mobilesdk.protocol.SdkEvent
import io.sentient.mobilesdk.sdk.ChatMessage
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * Stateless read/command surface for the ACTIVE conversation. The SDK is on one
 * conversation at a time; switching is a [SessionsRepository] concern. No combine,
 * no accumulation, no connection gating — those belong to usecases / the VM.
 */
interface ConversationRepository {
    /** Committed history of the active conversation. */
    val timeline: StateFlow<List<ChatMessage>>

    /** No-loss event stream (deltas, task upserts, cycle/commit, session switch). */
    val liveEvents: SharedFlow<SdkEvent>

    /** Fire an outbound message with a client-generated pendingId (reconciliation key). */
    fun send(text: String, pendingId: String)
}
```

- [ ] **Step 2: Write the SDK-backed impl**

```kotlin
package io.sentient.mobiledata.data

import io.sentient.mobilesdk.protocol.SdkEvent
import io.sentient.mobilesdk.sdk.ChatMessage
import io.sentient.mobilesdk.sdk.SentientSdk
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow

/** SDK-backed [ConversationRepository]: pure passthrough to the blackbox SDK surfaces. */
class SdkConversationRepository(private val sdk: SentientSdk) : ConversationRepository {
    override val timeline: StateFlow<List<ChatMessage>> get() = sdk.timeline
    override val liveEvents: SharedFlow<SdkEvent> get() = sdk.events
    override fun send(text: String, pendingId: String) = sdk.sendText(text, pendingId)
}
```

- [ ] **Step 3: Compile**

Run: `source scripts/env.sh && ./gradlew :shared:mobile-data:compileKotlinIosSimulatorArm64`
Expected: `BUILD SUCCESSFUL`.

- [ ] **Step 4: Commit**

```bash
git add shared/mobile-data/src/commonMain/kotlin/io/sentient/mobiledata/data/ConversationRepository.kt shared/mobile-data/src/commonMain/kotlin/io/sentient/mobiledata/data/SdkConversationRepository.kt
git commit -m "feat(mobile-data): stateless ConversationRepository interface + SDK impl"
```

---

### Task 2: SessionsRepository (interface + SDK impl)

**Files:**
- Create: `shared/mobile-data/src/commonMain/kotlin/io/sentient/mobiledata/data/SessionsRepository.kt`
- Create: `shared/mobile-data/src/commonMain/kotlin/io/sentient/mobiledata/data/SdkSessionsRepository.kt`

No unit test — passthrough.

- [ ] **Step 1: Write the interface**

```kotlin
package io.sentient.mobiledata.data

/** A row in the session list, mapped from the SDK's SessionRow (UI-agnostic). */
data class SessionSummary(
    val id: String,
    val title: String,
    val updatedAtMs: Long,
)

/** Stateless session-management surface. Pure delegation to the SDK. */
interface SessionsRepository {
    suspend fun list(limit: Int, offset: Int): List<SessionSummary>
    suspend fun switchTo(sessionId: String)
    suspend fun newChat(): String
    suspend fun rename(sessionId: String, title: String)
    suspend fun delete(sessionId: String)
}
```

- [ ] **Step 2: Write the SDK-backed impl**

```kotlin
package io.sentient.mobiledata.data

import io.sentient.mobilesdk.sdk.SentientSdk

/** SDK-backed [SessionsRepository]: maps SDK SessionRow → [SessionSummary]; commands delegate. */
class SdkSessionsRepository(private val sdk: SentientSdk) : SessionsRepository {
    override suspend fun list(limit: Int, offset: Int): List<SessionSummary> =
        sdk.listSessions(limit = limit, offset = offset).items.map {
            SessionSummary(id = it.sessionId, title = it.title, updatedAtMs = it.lastActiveAt)
        }

    override suspend fun switchTo(sessionId: String) { sdk.switchSession(sessionId) }
    override suspend fun newChat(): String = sdk.doNewChat()
    override suspend fun rename(sessionId: String, title: String) { sdk.renameSession(sessionId, title) }
    override suspend fun delete(sessionId: String) { sdk.deleteSession(sessionId) }
}
```

> Adapt to the real SDK signatures (e.g. if `doNewChat()` returns Unit, fetch the id from the
> sessions-changed broadcast instead; if `renameSession`/`deleteSession` use named params, match them).

- [ ] **Step 3: Compile** — `./gradlew :shared:mobile-data:compileKotlinIosSimulatorArm64` → `BUILD SUCCESSFUL`.
- [ ] **Step 4: Commit**

```bash
git add shared/mobile-data/src/commonMain/kotlin/io/sentient/mobiledata/data/SessionsRepository.kt shared/mobile-data/src/commonMain/kotlin/io/sentient/mobiledata/data/SdkSessionsRepository.kt
git commit -m "feat(mobile-data): stateless SessionsRepository interface + SDK impl"
```

---

### Task 3: ConnectionStateRepository (interface + SDK impl)

**Files:**
- Create: `shared/mobile-data/src/commonMain/kotlin/io/sentient/mobiledata/data/ConnectionStateRepository.kt`

No unit test — passthrough. Named `ConnectionStateRepository` to avoid colliding with the legacy `io.sentient.mobiledata.repository.ConnectionRepository` (deleted in Phase 3).

- [ ] **Step 1: Write interface + impl**

```kotlin
package io.sentient.mobiledata.data

import io.sentient.mobilesdk.sdk.ConnectionState
import io.sentient.mobilesdk.sdk.SentientSdk
import kotlinx.coroutines.flow.StateFlow

/** Stateless connection-state surface (transport + voice axis). */
interface ConnectionStateRepository {
    val state: StateFlow<ConnectionState>
}

/** SDK-backed passthrough. */
class SdkConnectionStateRepository(private val sdk: SentientSdk) : ConnectionStateRepository {
    override val state: StateFlow<ConnectionState> get() = sdk.connection
}
```

- [ ] **Step 2: Compile** — `./gradlew :shared:mobile-data:compileKotlinIosSimulatorArm64` → `BUILD SUCCESSFUL`.
- [ ] **Step 3: Commit**

```bash
git add shared/mobile-data/src/commonMain/kotlin/io/sentient/mobiledata/data/ConnectionStateRepository.kt
git commit -m "feat(mobile-data): stateless ConnectionStateRepository interface + SDK impl"
```

---

### Task 4: OutboundCache (queue FSM) — TDD

**Files:**
- Create: `shared/mobile-data/src/commonMain/kotlin/io/sentient/mobiledata/outbox/OutboundCache.kt`
- Test: `shared/mobile-data/src/commonTest/kotlin/io/sentient/mobiledata/outbox/OutboundCacheTest.kt`

A VM-owned, in-memory queue. Holds queued→sent→failed state; knows NOTHING about connection. (The connection-gated flush lives in the VM, Phase 1/2.) Reuses `PendingMessage` + `MessageStatus`.

- [ ] **Step 1: Write the failing test**

```kotlin
package io.sentient.mobiledata.outbox

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class OutboundCacheTest {

    @Test
    fun enqueue_adds_queued() {
        val cache = OutboundCache()
        cache.enqueue("p1", "hi")
        val p = cache.pending.value
        assertEquals(1, p.size)
        assertEquals("p1", p[0].id)
        assertEquals("hi", p[0].text)
        assertEquals(MessageStatus.QUEUED, p[0].status)
    }

    @Test
    fun queued_lists_only_queued() {
        val cache = OutboundCache()
        cache.enqueue("p1", "a")
        cache.enqueue("p2", "b")
        cache.markSent("p1")
        assertEquals(listOf("p2"), cache.queued().map { it.id })
    }

    @Test
    fun markSent_then_remove_reconciles() {
        val cache = OutboundCache()
        cache.enqueue("p1", "hi")
        cache.markSent("p1")
        assertEquals(MessageStatus.SENT, cache.pending.value[0].status)
        cache.remove("p1")               // committed echo arrived
        assertTrue(cache.pending.value.isEmpty())
    }

    @Test
    fun markFailed_keeps_visible_and_retry_requeues() {
        val cache = OutboundCache()
        cache.enqueue("p1", "hi")
        cache.markFailed("p1")
        assertEquals(MessageStatus.FAILED, cache.pending.value[0].status)
        cache.retry("p1")
        assertEquals(MessageStatus.QUEUED, cache.pending.value[0].status)
    }

    @Test
    fun never_resurrects_a_non_queued_id_on_reenqueue() {
        val cache = OutboundCache()
        cache.enqueue("p1", "hi")
        cache.markSent("p1")
        cache.enqueue("p1", "hi")        // duplicate enqueue must NOT reset SENT→QUEUED
        assertEquals(MessageStatus.SENT, cache.pending.value[0].status)
    }
}
```

- [ ] **Step 2: Run, verify it fails**

Run: `source scripts/env.sh && ./gradlew :shared:mobile-data:testDebugUnitTest --tests '*OutboundCacheTest'`
Expected: FAIL — `OutboundCache` unresolved.

- [ ] **Step 3: Implement**

```kotlin
package io.sentient.mobiledata.outbox

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * In-memory optimistic-send queue for ONE conversation. Stateful by nature (it IS the
 * cache), so it is owned by the chat VM and dies with the conversation — no reset().
 * Knows nothing about the connection; the VM gates the flush on connection-ready.
 *
 * FSM per id: QUEUED → SENT (flushed) | FAILED (disconnect) → QUEUED (retry). A non-QUEUED
 * id is never resurrected by a duplicate enqueue, and never re-sent once SENT.
 */
class OutboundCache {
    private val queue = LinkedHashMap<String, PendingMessage>()
    private val _pending = MutableStateFlow<List<PendingMessage>>(emptyList())
    val pending: StateFlow<List<PendingMessage>> = _pending.asStateFlow()

    fun enqueue(id: String, text: String) {
        val existing = queue[id]
        if (existing != null && existing.status != MessageStatus.QUEUED) return
        queue[id] = PendingMessage(id, text, MessageStatus.QUEUED)
        publish()
    }

    /** All still-QUEUED entries — the VM flushes these on connection-ready. */
    fun queued(): List<PendingMessage> = queue.values.filter { it.status == MessageStatus.QUEUED }

    fun markSent(id: String) = transition(id) { it.copy(status = MessageStatus.SENT) }
    fun markFailed(id: String) = transition(id) {
        if (it.status == MessageStatus.QUEUED) it.copy(status = MessageStatus.FAILED) else it
    }
    fun retry(id: String) = transition(id) {
        if (it.status == MessageStatus.FAILED) it.copy(status = MessageStatus.QUEUED) else it
    }

    /** Drop a reconciled entry (its committed echo arrived). */
    fun remove(id: String) {
        if (queue.remove(id) != null) publish()
    }

    private fun transition(id: String, f: (PendingMessage) -> PendingMessage) {
        val cur = queue[id] ?: return
        queue[id] = f(cur)
        publish()
    }

    private fun publish() {
        _pending.value = queue.values.toList()
    }
}
```

- [ ] **Step 4: Run, verify pass**

Run: `./gradlew :shared:mobile-data:testDebugUnitTest --tests '*OutboundCacheTest'`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add shared/mobile-data/src/commonMain/kotlin/io/sentient/mobiledata/outbox/OutboundCache.kt shared/mobile-data/src/commonTest/kotlin/io/sentient/mobiledata/outbox/OutboundCacheTest.kt
git commit -m "feat(mobile-data): OutboundCache (VM-owned optimistic-send queue FSM)"
```

---

### Task 5: RevealReducer (pure reveal fold) — TDD

**Files:**
- Create: `shared/mobile-data/src/commonMain/kotlin/io/sentient/mobiledata/usecase/RevealReducer.kt`
- Test: `shared/mobile-data/src/commonTest/kotlin/io/sentient/mobiledata/usecase/RevealReducerTest.kt`

The typewriter accumulate + drain logic, as a pure reducer (no coroutines). `ObserveChatUseCase` (Task 6) drives it with a ticker. Reuses the pacing constants — copy `RevealRate` + `LivePhase` into this file so Phase 0 has no dependency on the interim scaffolding (`io.sentient.mobiledata.repository.Reveal.kt`), which is deleted in Phase 3.

- [ ] **Step 1: Write the failing test**

```kotlin
package io.sentient.mobiledata.usecase

import io.sentient.mobilesdk.connectors.TaskSnapshotItem
import io.sentient.mobilesdk.protocol.SdkEvent
import io.sentient.mobilesdk.sdk.ChatMessage
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class RevealReducerTest {
    private val C = "cycle-1"

    @Test fun delta_accumulates_full_reveal_lags() {
        var s = RevealReducer.reduce(RevealState(), SdkEvent.MessageStarted(C))
        s = RevealReducer.reduce(s, SdkEvent.MessageDelta(C, "Hello world"))
        assertEquals("Hello world", s.bubble?.fullContent)
        assertEquals(0, s.bubble?.revealed)
        assertEquals("", s.visibleContent())
    }

    @Test fun tick_advances_toward_full() {
        var s = RevealReducer.reduce(RevealState(), SdkEvent.MessageStarted(C))
        s = RevealReducer.reduce(s, SdkEvent.MessageDelta(C, "abcdefghij"))
        s = RevealReducer.reduce(s, RevealTick(1_000))
        s = RevealReducer.reduce(s, RevealTick(1_100))
        assertTrue((s.bubble?.revealed ?: 0) in 1..10)
        assertEquals(s.bubble?.revealed, s.visibleContent().length)
    }

    @Test fun commit_drains_then_nulls() {
        var s = RevealReducer.reduce(RevealState(), SdkEvent.MessageStarted(C))
        s = RevealReducer.reduce(s, SdkEvent.MessageDelta(C, "abcde"))
        s = RevealReducer.reduce(s, SdkEvent.MessageCommitted(ChatMessage(ts = 1, role = "assistant", content = "abcde", cycleId = C)))
        assertEquals(LivePhase.DRAINING, s.bubble?.phase)
        s = RevealReducer.reduce(s, RevealTick(1_000))
        s = RevealReducer.reduce(s, RevealTick(5_000))
        assertNull(s.bubble)
    }

    @Test fun tasks_survive_into_drain_cleared_after() {
        var s = RevealReducer.reduce(RevealState(), SdkEvent.MessageStarted(C))
        s = RevealReducer.reduce(s, SdkEvent.TaskUpserted(TaskSnapshotItem("t1", "search", C, "running", "", 1L)))
        s = RevealReducer.reduce(s, SdkEvent.MessageDelta(C, "x"))
        s = RevealReducer.reduce(s, SdkEvent.MessageCommitted(ChatMessage(ts = 1, role = "assistant", content = "x", cycleId = C)))
        assertEquals(1, s.tasks.size)
        s = RevealReducer.reduce(s, RevealTick(1_000))
        s = RevealReducer.reduce(s, RevealTick(5_000))
        assertNull(s.bubble)
        assertTrue(s.tasks.isEmpty())
    }
}
```

- [ ] **Step 2: Run, verify it fails** — `./gradlew :shared:mobile-data:testDebugUnitTest --tests '*RevealReducerTest'` → FAIL (unresolved).

- [ ] **Step 3: Implement**

```kotlin
package io.sentient.mobiledata.usecase

import io.sentient.mobilesdk.connectors.TaskSnapshotItem
import io.sentient.mobilesdk.protocol.SdkEvent

/** Phase of the live in-flight bubble. */
enum class LivePhase { STREAMING, DRAINING }

/** Ticker input for the reveal cursor (kept distinct from SdkEvent). */
data class RevealTick(val nowMs: Long)

/** Typewriter pacing — ports webui src/config/typewriter.ts. Pure. */
internal object RevealRate {
    const val BASE = 30.0
    const val MIN = 15.0
    const val MAX = 150.0
    const val GAP_GAIN = 0.02

    fun advance(revealed: Int, fullLen: Int, dtMs: Long, drain: Boolean): Int {
        if (revealed >= fullLen) return 0
        val gap = (fullLen - revealed).toDouble()
        val rate = if (drain) MAX else (BASE * (1 + gap * GAP_GAIN)).coerceIn(MIN, MAX)
        return (rate * dtMs / 1000.0).toInt().coerceAtMost(fullLen - revealed)
    }
}

data class RevealBubble(
    val cycleId: String,
    val fullContent: String,
    val revealed: Int,
    val phase: LivePhase,
)

data class RevealState(
    val bubble: RevealBubble? = null,
    val tasks: List<TaskSnapshotItem> = emptyList(),
    val lastTickMs: Long = 0,
) {
    fun visibleContent(): String = bubble?.let { it.fullContent.take(it.revealed) } ?: ""
}

/**
 * Pure reveal fold. No coroutines, no I/O. Accumulates deltas (no loss), advances the
 * cursor on ticks, drains after commit, drops everything on a session switch. The ticker
 * that emits [RevealTick] lives in [ObserveChatUseCase].
 */
object RevealReducer {
    fun reduce(s: RevealState, e: Any): RevealState = when (e) {
        is SdkEvent.MessageStarted ->
            s.copy(bubble = RevealBubble(e.cycleId, "", 0, LivePhase.STREAMING), tasks = emptyList())
        is SdkEvent.MessageDelta -> {
            val cur = s.bubble ?: RevealBubble(e.cycleId, "", 0, LivePhase.STREAMING)
            s.copy(bubble = cur.copy(fullContent = cur.fullContent + e.chunk))
        }
        is SdkEvent.TaskUpserted -> s.copy(tasks = upsert(s.tasks, e.task))
        is SdkEvent.MessageCommitted -> s.copy(bubble = s.bubble?.copy(phase = LivePhase.DRAINING))
        is SdkEvent.SessionSwitched -> RevealState()
        is RevealTick -> {
            val cur = s.bubble ?: return s
            val dt = if (s.lastTickMs == 0L) 0L else e.nowMs - s.lastTickMs
            val delta = RevealRate.advance(cur.revealed, cur.fullContent.length, dt, cur.phase == LivePhase.DRAINING)
            val revealed = cur.revealed + delta
            val done = cur.phase == LivePhase.DRAINING && revealed >= cur.fullContent.length
            s.copy(
                bubble = if (done) null else cur.copy(revealed = revealed),
                tasks = if (done) emptyList() else s.tasks,
                lastTickMs = e.nowMs,
            )
        }
        else -> s
    }

    private fun upsert(list: List<TaskSnapshotItem>, t: TaskSnapshotItem): List<TaskSnapshotItem> =
        (list.filterNot { it.taskId == t.taskId } + t).sortedBy { it.startedAtMs }
}
```

- [ ] **Step 4: Run, verify pass** — `./gradlew :shared:mobile-data:testDebugUnitTest --tests '*RevealReducerTest'` → PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add shared/mobile-data/src/commonMain/kotlin/io/sentient/mobiledata/usecase/RevealReducer.kt shared/mobile-data/src/commonTest/kotlin/io/sentient/mobiledata/usecase/RevealReducerTest.kt
git commit -m "feat(mobile-data): pure RevealReducer (typewriter fold + drain + switch-reset)"
```

---

### Task 6: ObserveChatUseCase (combine + reveal ticker) — TDD

**Files:**
- Create: `shared/mobile-data/src/commonMain/kotlin/io/sentient/mobiledata/usecase/ObserveChatUseCase.kt`
- Test: `shared/mobile-data/src/commonTest/kotlin/io/sentient/mobiledata/usecase/ObserveChatUseCaseTest.kt`

The core. Folds `liveEvents → RevealState` (ticking via injected `Clock`), combines committed `timeline` + the revealed bubble + the VM's `pending`, applies suppress-by-cycleId and reconcile-by-pendingId, emits `ChatModel`. The reveal ticker runs **inside** the returned flow (cancelled when collection stops → per-conversation, no leak).

- [ ] **Step 1: Write the failing test** (uses a fake repo + a manual clock)

```kotlin
package io.sentient.mobiledata.usecase

import io.sentient.mobiledata.data.ConversationRepository
import io.sentient.mobiledata.outbox.MessageStatus
import io.sentient.mobiledata.outbox.PendingMessage
import io.sentient.mobilesdk.protocol.SdkEvent
import io.sentient.mobilesdk.sdk.ChatMessage
import io.sentient.mobilesdk.util.Clock
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

private class FakeConversationRepository : ConversationRepository {
    val timelineState = MutableStateFlow<List<ChatMessage>>(emptyList())
    val events = MutableSharedFlow<SdkEvent>(extraBufferCapacity = 64)
    override val timeline: StateFlow<List<ChatMessage>> = timelineState
    override val liveEvents: SharedFlow<SdkEvent> = events
    val sent = mutableListOf<Pair<String, String>>()
    override fun send(text: String, pendingId: String) { sent.add(text to pendingId) }
}

class ObserveChatUseCaseTest {

    private fun useCase(repo: ConversationRepository, now: Long = 0L) =
        ObserveChatUseCase(repo, clock = Clock { now })

    @Test
    fun committed_twin_suppressed_while_live_same_cycle() = runTest(UnconfinedTestDispatcher()) {
        val repo = FakeConversationRepository()
        repo.timelineState.value = listOf(
            ChatMessage(ts = 1, role = "user", content = "hi"),
            ChatMessage(ts = 2, role = "assistant", content = "Hello", cycleId = "c1"),
        )
        repo.events.emit(SdkEvent.MessageStarted("c1"))
        repo.events.emit(SdkEvent.MessageDelta("c1", "Hello"))
        advanceUntilIdle()
        val m = useCase(repo).invoke(MutableStateFlow(emptyList())).first()
        // the committed c1 twin is hidden while the live bubble exists → one bubble
        assertEquals(1, m.committed.size)
        assertEquals("user", m.committed[0].role)
        assertEquals("c1", m.live?.cycleId)
    }

    @Test
    fun pending_reconciled_by_id() = runTest(UnconfinedTestDispatcher()) {
        val repo = FakeConversationRepository()
        repo.timelineState.value = listOf(ChatMessage(ts = 1, role = "user", content = "hi", pendingId = "p1"))
        val pending = MutableStateFlow(listOf(PendingMessage("p1", "hi", MessageStatus.SENT)))
        val m = useCase(repo).invoke(pending).first()
        assertTrue(m.pending.isEmpty())   // committed echo carries the same pendingId
        assertEquals(1, m.committed.size)
    }

    @Test
    fun session_switch_drops_live_bubble() = runTest(UnconfinedTestDispatcher()) {
        val repo = FakeConversationRepository()
        repo.events.emit(SdkEvent.MessageStarted("c1"))
        repo.events.emit(SdkEvent.MessageDelta("c1", "partial"))
        advanceUntilIdle()
        val uc = useCase(repo)
        // collect once with a bubble present
        assertTrue(uc.invoke(MutableStateFlow(emptyList())).first().live != null)
        repo.events.emit(SdkEvent.SessionSwitched("s2"))
        advanceUntilIdle()
        assertEquals(null, uc.invoke(MutableStateFlow(emptyList())).first().live)
    }
}
```

> Note: the live-bubble `content` equals the revealed slice; with `clock` fixed at `now=0` the
> first tick has `dt=0` so `revealed` may be 0 — assertions check identity/cycleId/role, not the
> exact revealed length. The reveal *advance* is pinned in `RevealReducerTest`.

- [ ] **Step 2: Run, verify it fails** — `./gradlew :shared:mobile-data:testDebugUnitTest --tests '*ObserveChatUseCaseTest'` → FAIL (unresolved `ObserveChatUseCase`).

- [ ] **Step 3: Implement**

```kotlin
package io.sentient.mobiledata.usecase

import io.sentient.mobiledata.data.ConversationRepository
import io.sentient.mobiledata.model.ChatModel
import io.sentient.mobiledata.outbox.PendingMessage
import io.sentient.mobilesdk.sdk.ChatMessage
import io.sentient.mobilesdk.util.Clock
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.scan
import kotlinx.coroutines.isActive
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.channelFlow
import kotlinx.coroutines.launch

/** Reveal ticker cadence — ~60fps feel without burning battery. */
private const val REVEAL_TICK_MS = 16L

/**
 * Projects the single chat list a screen renders for the ACTIVE conversation:
 * folds [ConversationRepository.liveEvents] → reveal (typewriter ticker runs inside this
 * flow), then combines committed [ConversationRepository.timeline] + the revealed bubble +
 * the VM's [pending] outbound cache. Applies one-bubble-per-cycle (suppress the committed
 * twin while its live bubble is on screen) and reconcile-by-pendingId.
 *
 * Per-conversation: the reveal fold + ticker live inside the returned flow, so they are
 * cancelled when collection stops (conversation switch / VM teardown). No reset() needed.
 */
class ObserveChatUseCase(
    private val conversation: ConversationRepository,
    private val clock: Clock,
) {
    operator fun invoke(pending: Flow<List<PendingMessage>>): Flow<ChatModel> {
        val reveal = revealFlow()
        return combine(conversation.timeline, reveal, pending) { committed, rs, pendingMsgs ->
            val committedPendingIds = committed.mapNotNull { it.pendingId }.toSet()
            val visiblePending = pendingMsgs.filter { it.id !in committedPendingIds }
            val liveCycleId = rs.bubble?.cycleId
            val visibleCommitted =
                if (liveCycleId == null) committed
                else committed.filter { it.cycleId != liveCycleId }
            val liveBubble = rs.bubble?.let {
                ChatMessage(ts = 0, role = "assistant", content = rs.visibleContent(), streaming = true, cycleId = it.cycleId)
            }
            ChatModel(
                committed = visibleCommitted,
                pending = visiblePending,
                live = liveBubble,
                tasks = rs.tasks,
            )
        }
    }

    /** Hot-ish reveal stream: folds events into [RevealState] and self-ticks while a bubble exists. */
    private fun revealFlow(): Flow<RevealState> = channelFlow {
        val state = MutableStateFlow(RevealState())
        launch {
            conversation.liveEvents.collect { state.value = RevealReducer.reduce(state.value, it) }
        }
        launch {
            while (isActive) {
                if (state.value.bubble != null) state.value = RevealReducer.reduce(state.value, RevealTick(clock.nowMs()))
                delay(REVEAL_TICK_MS)
            }
        }
        state.collect { send(it) }
    }
}
```

> `ObserveChatUseCase` returns `Flow<ChatModel>` (raw domain), NOT the result envelope — the VM
> wraps success/loading/failure (connection failures come from `ConnectionStateRepository`). This
> keeps the usecase pure-domain.

- [ ] **Step 4: Run, verify pass** — `./gradlew :shared:mobile-data:testDebugUnitTest --tests '*ObserveChatUseCaseTest'` → PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add shared/mobile-data/src/commonMain/kotlin/io/sentient/mobiledata/usecase/ObserveChatUseCase.kt shared/mobile-data/src/commonTest/kotlin/io/sentient/mobiledata/usecase/ObserveChatUseCaseTest.kt
git commit -m "feat(mobile-data): ObserveChatUseCase (timeline+reveal+pending combine, one-bubble-per-cycle)"
```

---

### Task 7: Command usecases (Switch / Send / Sessions)

**Files:**
- Create: `shared/mobile-data/src/commonMain/kotlin/io/sentient/mobiledata/usecase/SwitchConversationUseCase.kt`
- Create: `shared/mobile-data/src/commonMain/kotlin/io/sentient/mobiledata/usecase/SendMessageUseCase.kt`
- Create: `shared/mobile-data/src/commonMain/kotlin/io/sentient/mobiledata/usecase/SessionsUseCases.kt`

Thin delegations — no unit tests (test-lean: passthrough command usecases).

- [ ] **Step 1: SwitchConversationUseCase**

```kotlin
package io.sentient.mobiledata.usecase

import io.sentient.mobiledata.data.SessionsRepository

/** Make [sessionId] the active conversation; null starts a fresh one. Returns the active id. */
class SwitchConversationUseCase(private val sessions: SessionsRepository) {
    suspend operator fun invoke(sessionId: String?): String =
        if (sessionId == null) sessions.newChat() else { sessions.switchTo(sessionId); sessionId }
}
```

- [ ] **Step 2: SendMessageUseCase**

```kotlin
package io.sentient.mobiledata.usecase

import io.sentient.mobiledata.data.ConversationRepository

/** Fire an outbound message through the repo. Enqueue/optimism is the VM's OutboundCache. */
class SendMessageUseCase(private val conversation: ConversationRepository) {
    operator fun invoke(text: String, pendingId: String) = conversation.send(text, pendingId)
}
```

- [ ] **Step 3: SessionsUseCases**

```kotlin
package io.sentient.mobiledata.usecase

import io.sentient.mobiledata.data.SessionSummary
import io.sentient.mobiledata.data.SessionsRepository

class ObserveSessionsUseCase(private val sessions: SessionsRepository) {
    suspend operator fun invoke(limit: Int, offset: Int = 0): List<SessionSummary> =
        sessions.list(limit, offset)
}

class RenameSessionUseCase(private val sessions: SessionsRepository) {
    suspend operator fun invoke(sessionId: String, title: String) = sessions.rename(sessionId, title)
}

class DeleteSessionUseCase(private val sessions: SessionsRepository) {
    suspend operator fun invoke(sessionId: String) = sessions.delete(sessionId)
}
```

- [ ] **Step 4: Compile** — `./gradlew :shared:mobile-data:compileKotlinIosSimulatorArm64` → `BUILD SUCCESSFUL`.
- [ ] **Step 5: Commit**

```bash
git add shared/mobile-data/src/commonMain/kotlin/io/sentient/mobiledata/usecase/SwitchConversationUseCase.kt shared/mobile-data/src/commonMain/kotlin/io/sentient/mobiledata/usecase/SendMessageUseCase.kt shared/mobile-data/src/commonMain/kotlin/io/sentient/mobiledata/usecase/SessionsUseCases.kt
git commit -m "feat(mobile-data): Switch/Send/Sessions command usecases (thin delegations)"
```

---

### Task 8: ChatComponent factory (manual DI)

**Files:**
- Create: `shared/mobile-data/src/commonMain/kotlin/io/sentient/mobiledata/di/ChatComponent.kt`

Single hand-wired entry point: SDK → repos → usecases. The User scope (Hilt module on Android, `UserSession` on iOS) builds ONE of these per logged-in user; the VM pulls usecases from it. No unit test (DI wiring).

- [ ] **Step 1: Implement**

```kotlin
package io.sentient.mobiledata.di

import io.sentient.mobiledata.data.SdkConnectionStateRepository
import io.sentient.mobiledata.data.SdkConversationRepository
import io.sentient.mobiledata.data.SdkSessionsRepository
import io.sentient.mobiledata.usecase.DeleteSessionUseCase
import io.sentient.mobiledata.usecase.ObserveChatUseCase
import io.sentient.mobiledata.usecase.ObserveSessionsUseCase
import io.sentient.mobiledata.usecase.RenameSessionUseCase
import io.sentient.mobiledata.usecase.SendMessageUseCase
import io.sentient.mobiledata.usecase.SwitchConversationUseCase
import io.sentient.mobilesdk.sdk.SentientSdk
import io.sentient.mobilesdk.util.Clock
import kotlin.time.Clock as KtClock

/**
 * User/Connection-scoped component: one per logged-in user. Builds the stateless repos +
 * usecases over a single [SentientSdk]. Platform DI (Hilt / UserSession) owns the instance;
 * the chat VM resolves usecases from here, never the SDK directly.
 */
class ChatComponent(
    sdk: SentientSdk,
    clock: Clock = Clock { KtClock.System.now().toEpochMilliseconds() },
) {
    private val conversation = SdkConversationRepository(sdk)
    private val sessions = SdkSessionsRepository(sdk)
    val connection = SdkConnectionStateRepository(sdk)

    val observeChat = ObserveChatUseCase(conversation, clock)
    val switchConversation = SwitchConversationUseCase(sessions)
    val sendMessage = SendMessageUseCase(conversation)
    val observeSessions = ObserveSessionsUseCase(sessions)
    val renameSession = RenameSessionUseCase(sessions)
    val deleteSession = DeleteSessionUseCase(sessions)
}
```

- [ ] **Step 2: Compile** — `./gradlew :shared:mobile-data:compileKotlinIosSimulatorArm64` → `BUILD SUCCESSFUL`.
- [ ] **Step 3: Full shared test run**

Run: `./gradlew :shared:mobile-data:testDebugUnitTest`
Expected: `BUILD SUCCESSFUL` — the 3 new test classes pass alongside the existing suite.

- [ ] **Step 4: XCFramework smoke** (the new commonMain must export cleanly for iOS)

Run: `./gradlew :shared:mobile-data:assembleMobileDataXCFramework`
Expected: `BUILD SUCCESSFUL` — `xcframework successfully written out`.

- [ ] **Step 5: Commit**

```bash
git add shared/mobile-data/src/commonMain/kotlin/io/sentient/mobiledata/di/ChatComponent.kt
git commit -m "feat(mobile-data): ChatComponent factory (User-scope SDK→repos→usecases)"
```

---

# Phase 1 — Android cutover

UI work: each task's gate is **build green + the named Maestro case green** against the local Docker
stack (`deploy/macos/`), per the e2e-testing rule. No unit TDD for UI. Old `MobileSession` stays in
shared (iOS still uses it) until Phase 3.

### Task 9: Hilt + User-scope component (Android)

**Files:**
- Modify: `gradle/libs.versions.toml` (add `hilt`, `hilt-navigation-compose`, `ksp`)
- Modify: `android/build.gradle.kts` (apply `ksp` + `dagger.hilt.android.plugin`; deps)
- Create: `android/src/main/kotlin/io/sentient/android/SentientApp.kt`
- Modify: `android/src/main/AndroidManifest.xml` (`android:name=".SentientApp"`)
- Create: `android/src/main/kotlin/io/sentient/android/di/UserSessionManager.kt`

- [ ] **Step 1: Add Hilt to the version catalog + module.** Add catalog entries (`com.google.dagger:hilt-android`, `hilt-compiler` via KSP, `androidx.hilt:hilt-navigation-compose`) and apply the plugins. **Verify the Hilt version is compatible with the project's Kotlin/KSP versions in `libs.versions.toml` before pinning** (Hilt + KSP must match the Kotlin line).

```kotlin
// android/build.gradle.kts (plugins block) — add:
alias(libs.plugins.ksp)
alias(libs.plugins.hilt)
// dependencies — add:
implementation(libs.hilt.android)
ksp(libs.hilt.compiler)
implementation(libs.hilt.navigation.compose)
```

- [ ] **Step 2: Application class.**

```kotlin
package io.sentient.android

import android.app.Application
import dagger.hilt.android.HiltAndroidApp

@HiltAndroidApp
class SentientApp : Application() {
    override fun onCreate() {
        super.onCreate()
        MobileSdk.initAndroid(this) // existing init — keep; createPlatformBundle reads the Context
    }
}
```

Register in the manifest: `<application android:name=".SentientApp" ...>`.

- [ ] **Step 3: User-scope component manager.** The "logged-in user" scope is not a built-in Hilt scope; model it as a `@Singleton` manager owning a nullable `ChatComponent`, created on auth and cleared on logout. (It replaces `SdkSessionFactory`'s per-entry session.)

```kotlin
package io.sentient.android.di

import io.sentient.android.BuildConfig
import io.sentient.android.backend.BackendConfigHolder
import io.sentient.android.backend.ResolvedBackend
import io.sentient.android.backend.resolveBackend
import io.sentient.mobiledata.di.ChatComponent
import io.sentient.mobilesdk.sdk.SdkConfig
import io.sentient.mobilesdk.sdk.SentientSdk
import io.sentient.mobilesdk.sdk.createPlatformBundle
import io.sentient.mobilesdk.util.Clock
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import javax.inject.Inject
import javax.inject.Singleton

/**
 * User/Connection scope: one SDK + [ChatComponent] per logged-in user, surviving all in-app
 * navigation (conversation switch, history). Built lazily on first access after auth; [shutdown]
 * on logout closes the SDK + cancels the scope. NOT per chat entry — that was the old bug.
 */
@Singleton
class UserSessionManager @Inject constructor() {
    private var scope: CoroutineScope? = null
    private var sdk: SentientSdk? = null
    private var comp: ChatComponent? = null

    fun component(): ChatComponent = comp ?: build().also { comp = it }

    private fun build(): ChatComponent {
        val s = CoroutineScope(SupervisorJob() + Dispatchers.Default.limitedParallelism(1))
        val r = resolveBackend(
            override = BackendConfigHolder.store.config.value,
            buildTimeDefaultUrl = BuildConfig.GATEWAY_WS_URL,
            buildTimeAllowSelfSigned = BuildConfig.DEBUG,
        )
        require(r is ResolvedBackend.Configured) { "UserSessionManager built while backend unconfigured" }
        val sdkInst = SentientSdk(
            config = SdkConfig(r.gatewayWsUrl, r.allowSelfSignedDevHost, AppDependencies.capabilities, BuildConfig.DEBUG),
            bundle = createPlatformBundle(),
            scope = s,
        )
        scope = s; sdk = sdkInst
        s.launch { sdkInst.connect() } // background connect; UI usable immediately
        return ChatComponent(sdkInst, Clock { System.currentTimeMillis() })
    }

    fun shutdown() {
        sdk?.disconnect(clearSession = true)
        scope?.cancel()
        scope = null; sdk = null; comp = null
    }
}
```

> Confirm `SentientSdk.connect()` / `disconnect` signatures + `AppDependencies.capabilities` against
> the current `SdkSessionFactory.kt` (this manager subsumes it). Pause/resume on app background can be
> added later via the presence relay wired to `sdk`; not required for the cutover smoke.

- [ ] **Step 4: Build.** `source scripts/env.sh && ./gradlew :android:compileDebugKotlin` → `BUILD SUCCESSFUL`.
- [ ] **Step 5: Commit.** `git add` the above; `git commit -m "feat(android): Hilt + UserSessionManager (User-scope SDK + ChatComponent)"`.

### Task 10: Thin ChatViewModel (Android)

**Files:**
- Modify (rewrite): `android/src/main/kotlin/io/sentient/android/chat/ChatViewModel.kt`

The VM owns `currentSessionId` + `OutboundCache`, collects `observeChat(cache.pending)`, gates flush on connection, prunes the cache on committed echo. No SDK access.

- [ ] **Step 1: Rewrite the VM.**

```kotlin
package io.sentient.android.chat

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import io.sentient.android.di.UserSessionManager
import io.sentient.mobiledata.outbox.OutboundCache
import io.sentient.mobilesdk.sdk.ConnectionState
import io.sentient.mobilesdk.transport.SdkStatus
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.util.UUID
import javax.inject.Inject

@HiltViewModel
class ChatViewModel @Inject constructor(
    savedState: SavedStateHandle,
    userSession: UserSessionManager,
) : ViewModel() {
    private val sessionId: String? = savedState["sessionId"]
    private val c = userSession.component()
    private val cache = OutboundCache()

    private val _state = MutableStateFlow(ChatUiState())
    val state: StateFlow<ChatUiState> = _state.asStateFlow()
    val connection: StateFlow<ConnectionState> = c.connection.state

    init {
        viewModelScope.launch { c.switchConversation(sessionId) } // route arg → active conversation
        viewModelScope.launch {
            c.observeChat(cache.pending).collect { model ->
                model.committed.mapNotNull { it.pendingId }.forEach(cache::remove) // prune reconciled
                _state.value = ChatUiState(model = model)
            }
        }
        viewModelScope.launch {
            c.connection.state.collect { if (it.status == SdkStatus.READY) flush() }
        }
    }

    fun send(text: String) {
        val id = UUID.randomUUID().toString()
        cache.enqueue(id, text)
        if (connection.value.status == SdkStatus.READY) flush()
    }

    fun retry(pendingId: String) {
        cache.retry(pendingId)
        if (connection.value.status == SdkStatus.READY) flush()
    }

    private fun flush() = cache.queued().forEach { c.sendMessage(it.text, it.id); cache.markSent(it.id) }
}
```

> `ChatUiState` keeps its existing shape (model + loading + banner); adapt the constructor call. The
> connection-failure→banner / authExpired routing moves to the nav layer (Task 11).

- [ ] **Step 2: Build** → `BUILD SUCCESSFUL`. **Step 3: Commit** `feat(android): thin Hilt ChatViewModel (sessionId route arg + OutboundCache + connection-gated flush)`.

### Task 11: Navigation-Compose graph + cutover (Android)

**Files:**
- Create: `android/src/main/kotlin/io/sentient/android/nav/Routes.kt`
- Create: `android/src/main/kotlin/io/sentient/android/nav/AppNavHost.kt`
- Modify: `android/src/main/kotlin/io/sentient/android/MainActivity.kt` (`@AndroidEntryPoint`, `setContent { AppNavHost() }`)
- Modify: `android/src/main/kotlin/io/sentient/android/chat/ChatRoot.kt` (consume `hiltViewModel`)

- [ ] **Step 1: Routes.**

```kotlin
package io.sentient.android.nav

object Routes {
    const val SPLASH = "splash"
    const val SETUP = "setup"
    const val LOGIN = "login"
    const val CHAT = "chat?sessionId={sessionId}"   // sessionId optional → new chat
    const val HISTORY = "history"
    const val SETTINGS = "settings"
    fun chat(sessionId: String? = null) = if (sessionId == null) "chat" else "chat?sessionId=$sessionId"
}
```

- [ ] **Step 2: NavHost** — gate splash→setup/login/chat on the existing config+token state (now driving `navController.navigate` instead of a `when`-swap); `composable(Routes.CHAT)` reads `sessionId` arg; `hiltViewModel<ChatViewModel>()` is scoped to the back-stack entry → fresh per `sessionId`. History select → `navController.navigate(Routes.chat(id)){ popUpTo("chat"){inclusive=true} }`. New chat → `navigate(Routes.chat())`. Keep `HistoryDrawer` as the History-route presentation (spec default) OR a `composable(Routes.HISTORY)` page.

```kotlin
@Composable
fun AppNavHost() {
    val nav = rememberNavController()
    NavHost(nav, startDestination = Routes.SPLASH) {
        composable(Routes.SPLASH) { SplashGate(onConfigured = { nav.navigate(Routes.chat()) { popUpTo(Routes.SPLASH){inclusive=true} } }, onNeedsSetup = { nav.navigate(Routes.SETUP) }, onNeedsLogin = { nav.navigate(Routes.LOGIN) }) }
        composable(Routes.CHAT, arguments = listOf(navArgument("sessionId"){ nullable = true; defaultValue = null })) {
            val vm: ChatViewModel = hiltViewModel()
            ChatScreen(vm = vm, onOpenHistory = { nav.navigate(Routes.HISTORY) }, onNewChat = { nav.navigate(Routes.chat()) { popUpTo("chat"){inclusive=true} } }, onSettings = { nav.navigate(Routes.SETTINGS) })
        }
        composable(Routes.HISTORY) { HistoryScreen(onSelect = { id -> nav.navigate(Routes.chat(id)) { popUpTo("chat"){inclusive=true} } }) }
        composable(Routes.SETTINGS) { SettingsScreen(onLogout = { /* userSessionManager.shutdown(); nav→login */ }) }
        // setup/login destinations: reuse existing screens, drive nav on success.
    }
}
```

> `SplashGate` / `HistoryScreen` reuse the existing config/login/history composables — only their
> completion callbacks change from state-flips to `nav.navigate`. The `HistoryViewModel` is rewired to
> the new usecases (`observeSessions`/`rename`/`delete` from `UserSessionManager.component()`).

- [ ] **Step 3: Build** → `BUILD SUCCESSFUL`.
- [ ] **Step 4: Maestro smoke** (local Docker stack up). Run the cutover cases: cold-launch+login, **new-chat-empty**, **switch-session-clean**, **send→reveal→pills**, **resume-keeps-outbox** (background+foreground with a queued send). Drive via `qa/mobile/run-e2e.sh` (Android). All green; logcat shows no reconnect on conversation switch.
- [ ] **Step 5: Commit** `feat(android): route-based navigation (chat as sessionId route) + cutover to usecases`.

### Task 12: Remove old Android wiring

**Files:**
- Delete: `android/.../sdk/SdkSessionFactory.kt`; old state-gate root (`AppRoot`/`AppConfiguredRoot` swap logic) folded into `AppNavHost`.
- Modify: remove Android references to `MobileSession` (now via `UserSessionManager`/`ChatComponent`).

- [ ] **Step 1: Delete + adjust** so nothing on Android references `MobileSession` or `SdkSessionFactory`. (Shared `MobileSession` stays for iOS until Phase 3.)
- [ ] **Step 2: Build + full Android quality gate** (`./gradlew :android:assembleDebug :android:testDebugUnitTest`) → green. **Step 3: Maestro re-run** the smoke set → green. **Step 4: Commit** `refactor(android): delete SdkSessionFactory + state-gate root (superseded by Hilt + nav)`.

---

# Phase 2 — iOS cutover

Mirror of Phase 1 on SwiftUI-native primitives. Gate: build + the same Maestro cases (iOS driver).

### Task 13: ChatComponent factory + UserSession (iOS)

**Files:**
- Create: `shared/mobile-data/src/iosMain/kotlin/io/sentient/mobiledata/di/ChatComponentFactory.ios.kt`
- Create: `ios/App/Session/UserSession.swift`

- [ ] **Step 1: iosMain factory** (mirror `createMobileSession`, returns a `ChatComponent` + holds the SDK/scope for lifecycle).

```kotlin
package io.sentient.mobiledata.di

import io.sentient.mobilesdk.sdk.SdkConfig
import io.sentient.mobilesdk.sdk.SentientSdk
import io.sentient.mobilesdk.sdk.createPlatformBundle
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/** iOS handle: the User-scope SDK + ChatComponent + lifecycle, built once per logged-in user. */
class IosUserSession(gatewayWsUrl: String, allowSelfSignedDevHost: Boolean, capabilities: List<String>, devFaultsEnabled: Boolean) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default.limitedParallelism(1))
    private val sdk = SentientSdk(SdkConfig(gatewayWsUrl, allowSelfSignedDevHost, capabilities, devFaultsEnabled), createPlatformBundle(), scope)
    val component = ChatComponent(sdk)
    fun open() { scope.launch { sdk.connect() } }
    fun pause() { sdk.disconnect(clearSession = false) }
    fun resume() { sdk.forceReconnect() }
    fun close() { sdk.disconnect(clearSession = true); scope.cancel() }
}

fun createUserSession(gatewayWsUrl: String, allowSelfSignedDevHost: Boolean, capabilities: List<String> = emptyList(), devFaultsEnabled: Boolean = false) =
    IosUserSession(gatewayWsUrl, allowSelfSignedDevHost, capabilities, devFaultsEnabled)
```

- [ ] **Step 2: Swift `UserSession`** (authed-root `@StateObject`, holds the KMP `IosUserSession`, builds VMs).

```swift
import MobileData

@MainActor final class UserSession: ObservableObject {
    let inner: IosUserSession
    init(gatewayWsUrl: String, allowSelfSigned: Bool, capabilities: [String], devFaults: Bool) {
        inner = createUserSession(gatewayWsUrl: gatewayWsUrl, allowSelfSignedDevHost: allowSelfSigned, capabilities: capabilities, devFaultsEnabled: devFaults)
        inner.open()
    }
    func makeChatVM(sessionId: String?) -> ChatViewModel { ChatViewModel(component: inner.component, sessionId: sessionId) }
    deinit { inner.close() }
}
```

- [ ] **Step 3: Rebuild XCFramework** (`./gradlew :shared:mobile-data:assembleMobileDataXCFramework`) so iosMain exports. Build iOS (`xcodebuild build -scheme SentientApp ...`) → succeeds. **Step 4: Commit** `feat(ios): IosUserSession factory + UserSession @StateObject (User-scope ChatComponent)`.

### Task 14: Thin ChatViewModel (iOS)

**Files:**
- Modify (rewrite): `ios/App/Chat/ChatViewModel.swift`

- [ ] **Step 1: Rewrite** mirroring Android (cache + observeChat + connection-gated flush + prune). SKIE exposes `observeChat(pending:)` as a `SkieSwiftFlow`; `cache.pending` is a KMP `StateFlow` (iterate it for the input, or hold the cache and pass `cache.pending`).

```swift
import MobileData

@MainActor final class ChatViewModel: ObservableObject {
    @Published private(set) var state = ChatUiState()
    @Published private(set) var connection = makeDisconnectedConnection()
    private let c: ChatComponent
    private let cache = OutboundCache()
    private var tasks: [Task<Void, Never>] = []

    init(component: ChatComponent, sessionId: String?) {
        self.c = component
        tasks.append(Task { try? await c.switchConversation(sessionId: sessionId) })
        tasks.append(Task { for await m in c.observeChat(pending: cache.pending) {
            m.committed.compactMap { $0.pendingId }.forEach { cache.remove(id: $0) }
            self.state = ChatUiState(model: m)
        }})
        tasks.append(Task { for await conn in c.connection.state {
            self.connection = conn
            if conn.status == .ready { self.flush() }
        }})
    }
    func send(_ text: String) {
        let id = UUID().uuidString
        cache.enqueue(id: id, text: text)
        if connection.status == .ready { flush() }
    }
    func retry(_ id: String) { cache.retry(pendingId: id); if connection.status == .ready { flush() } }
    private func flush() { for m in cache.queued() { c.sendMessage(text: m.text, pendingId: m.id); cache.markSent(id: m.id) } }
    deinit { tasks.forEach { $0.cancel() } }
}
```

> Verify the SKIE-bridged names (`observeChat(pending:)`, `switchConversation(sessionId:)`, `cache.pending`
> as an async sequence) against the generated `MobileData` module; adjust labels if SKIE renames.

- [ ] **Step 2: Build iOS** → succeeds. **Step 3: Commit** `feat(ios): thin @Observable ChatViewModel (sessionId + OutboundCache + connection-gated flush)`.

### Task 15: NavigationStack + cutover (iOS)

**Files:**
- Create: `ios/App/Nav/Route.swift`
- Modify: the authed root view (replace the state-gate `Group` with `NavigationStack`); `ChatView` consumes the injected VM.

- [ ] **Step 1: Route + root.**

```swift
enum Route: Hashable { case history, settings }

struct AuthedRoot: View {
    @StateObject private var userSession: UserSession
    @State private var path: [Route] = []
    @State private var activeSessionId: String? = nil
    var body: some View {
        NavigationStack(path: $path) {
            ChatView(vm: userSession.makeChatVM(sessionId: activeSessionId),
                     onOpenHistory: { path.append(.history) },
                     onNewChat: { activeSessionId = nil; path.removeAll() })
                .id(activeSessionId)                       // ← fresh VM per conversation
                .navigationDestination(for: Route.self) { route in
                    switch route {
                    case .history: HistoryView(onSelect: { id in activeSessionId = id; path.removeAll() })
                    case .settings: SettingsSheet(...)
                    }
                }
        }
    }
}
```

> `.id(activeSessionId)` rebuilds the root `ChatView` + its `@StateObject` VM whenever the active
> conversation changes — the iOS analogue of Android recreating the VM on the route arg. `UserSession`
> (the SDK) sits above the stack, so history navigation + switches never drop the socket.

- [ ] **Step 2: Build iOS** → succeeds. **Step 3: Maestro smoke** (iOS driver, local stack): same case set as Android — new-chat-empty, switch-session-clean, send→reveal→pills, **resume-keeps-outbox**, plus **drawer-coexist** (the gesture fix) if the drawer remains the History presentation. All green; `os_log` shows no reconnect on switch.
- [ ] **Step 4: Commit** `feat(ios): NavigationStack route graph (chat root keyed on activeSessionId) + cutover`.

### Task 16: Remove old iOS wiring

**Files:**
- Modify: delete iOS references to `createMobileSession` / `MobileSession`; old state-gate `RootView` swap folded into `AuthedRoot`.

- [ ] **Step 1: Delete + adjust** so nothing on iOS references `MobileSession`. **Step 2: Build + Maestro re-run** → green. **Step 3: Commit** `refactor(ios): delete createMobileSession + state-gate root (superseded by NavigationStack + UserSession)`.

---

# Phase 3 — Delete dead code + rewrite rules

### Task 17: Delete the superseded shared data layer

**Files:**
- Delete: `shared/mobile-data/.../session/MobileSession.kt`, `.../session/MobileSessionFactory.ios.kt`, `android/.../sdk/SdkSessionFactory.kt` (if still present)
- Delete: `shared/mobile-data/.../repository/ChatRepository.kt`, `ConnectionRepository.kt`, `HistoryRepository.kt`, `OutboxRepository.kt`, `ReplyStreamRepository.kt`, `Reveal.kt` + their tests (`ChatRepositoryTest`, `OutboxRepositoryTest`, `ReplyStreamRepositoryTest`, `LiveRevealReducerTest`, `ConnectionRepositoryTest`)

- [ ] **Step 1: Delete** the files above. **KEEP** the SDK-internal session-switch fix
  (`StateDeriver.resetForSessionSwitch`, `ConversationHistoryConnector.onSwitch`, the `SdkConnectors`
  wire) — that is connection-scoped correctness (stale `cycleByTs` across conversations on the
  user-scoped SDK), independent of the VM lifecycle, and still needed. Migrate the `HistoryRepository`
  consumers to `SessionsRepository`/`ObserveSessionsUseCase` before deleting it.
- [ ] **Step 2: Build both platforms + full test run** (`./gradlew :shared:mobile-data:testDebugUnitTest :android:assembleDebug` + iOS `xcodebuild build` + XCFramework) → all green; no dangling references.
- [ ] **Step 3: Commit** `refactor(mobile): delete MobileSession + legacy/interim repos (superseded by usecase layer)`.

### Task 18: Rewrite the rules

**Files (rules — modify):** `.claude/rules/android/android-di.md`, `.claude/rules/ios/ios-architecture-mvvm.md`, `.claude/rules/android/android-architecture-mvi.md`, `.claude/rules/mobile/mobile-navigation.md`, `.claude/rules/mobile-data/repositories.md`, `.claude/rules/mobile-data/session-lifecycle.md`
**Files (details — modify):** the matching `agents/docs/**/-details.md` for each.

**Authoring constraint (MANDATORY — user-directed):** rule files are SHORT, generalized, pure-instruction
bullet points. They MUST NOT name any project, class, file, framework, or project-specific identifier —
write each so it could be shared across unrelated projects. ALL examples, project nouns, framework names
(Hilt, Koin, NavigationStack, Compose), and clarifications go in the matching `*-details.md`, never in
the rule itself.

- [ ] **Step 1: `android-di`** → generalize to: "Inject dependencies through a framework-managed graph; scope each holder to a real lifecycle (app / authenticated user / screen); construct screen state-holders via the platform's lifecycle-aware factory; never a process-wide mutable singleton for screen state." (Framework names → details.)
- [ ] **Step 2: `ios-architecture-mvvm` + `android-architecture-mvi`** → "One state-holder per screen, scoped to its navigation destination; business logic that combines/transforms multiple sources lives in usecases, not the state-holder or the data layer; per-screen and view-local state lives in the state-holder only; the data layer is reached only through usecases." (Hilt/@Observable specifics → details.)
- [ ] **Step 3: `mobile-navigation`** → "Navigate by typed routes; one screen per route; a screen re-initialises when its route argument changes; pass ids as route args and refetch — never large objects; long-lived connections are scoped above the route graph so navigation never tears them down." (Nav-Compose/NavigationStack → details.)
- [ ] **Step 4: `mobile-data/repositories`** → "Repositories are stateless, pure data-source mappers — data in, data out, no accumulation, no cross-source combine, no connection gating; define them behind interfaces so usecases test against fakes; stateful per-conversation caches belong to the screen state-holder, not a shared repository." (Class names → details.)
- [ ] **Step 5: `mobile-data/session-lifecycle`** → "Separate the connection scope (transport + data sources, alive while authenticated) from the screen scope (per-route state-holder); a conversation/context switch is a navigation event that recreates the screen scope, not an in-place mutation; the connection survives it." (Specifics → details.)
- [ ] **Step 6:** Update each `*-details.md` with the project nouns, framework names, file paths, and examples removed from the rules. **Step 7: Commit** `docs(rules): rewrite mobile DI/arch/nav/repo/lifecycle rules for the usecase + route-based architecture`.

---

## E2E matrix

The conversation-lifecycle e2e matrix (new-chat, switch-session, send→reveal→pills, resume-keeps-outbox,
history-route, drawer-coexist, tool-pill title) lives in the design spec
(`docs/superpowers/specs/2026-06-08-mobile-clean-architecture-refactor-design.md`) and is exercised at
the Phase 1/2 cutovers (Maestro), not in Phase 0. Phase 0 is unit-tested only (it has no UI); its
deliverable is "shared layer compiles, exports to the XCFramework, and the 3 invariant test classes pass."
