# Mobile Fire-and-Forget Session Lifecycle — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore fire-and-forget session create/switch on mobile so the UI and typing NEVER block on a backend session round-trip, the cold-start phantom-resume churn is eliminated, and no coroutine throw can crash the app (auth → login route, transient → retry).

**Architecture:** A conversation command (new / switch) is fired and forgotten; the gateway buffers `user.message` behind the pending session mint, so the client only ever surfaces a message as `queued → sent`. The SDK owns session continuity (tracks the active ACP session id, re-establishes it after a reconnect); the client drops the persistent connect-URL resume entirely. Business logic lives in usecases (`SwitchConversationUseCase` fires the command; `SendMessageUseCase` owns the queued-message consume decision). Every connection-scope coroutine is guarded so a throw is logged + recovered or routed to login, never `abort()`.

**Tech Stack:** Kotlin Multiplatform (`shared/mobile-sdk`, `shared/mobile-data`), Koin DI on Android, SwiftUI + SKIE on iOS, Navigation-Compose / NavigationStack, Maestro for native E2E.

---

## Background — the bug being fixed (evidence-backed)

The clean-arch refactor made `ChatViewModel.init` **block** on `switchConversation → newChat()`, which awaits `session.created` with a hardcoded 5s timeout. The gateway emits `session.created` only after a deliberately-slow ACP mint (`session.new` is a pre-warm designed to be fired and forgotten — webui does `void newChat()`). Result on every cold start: a phantom session, a 5s stall, and on iOS an **uncaught Kotlin coroutine exception → SIGABRT** (the connection scope has no `CoroutineExceptionHandler`; `IosUserSession.ios.kt:48`). Additionally, `SdkLifecycle.finishReady` stores the gateway **connection id** (`s-…`) as the resume pointer, which the next connect replays and the gateway rejects `forbidden "session not owned by current"`.

## Gateway contract (do not change — the client adapts to it)

- `session.new` → gateway `switchTo("")` emits `session.switched` + `conversation.snapshot([])` immediately (pane clears), then background `acpConn.newSession()` emits `session.created` when minted. First `user.message` awaits the pending mint. (`gateway/src/session-handlers/sessions-handlers.ts:170`)
- `session.switch` → ownership check → emits `session.switched(id)` + `conversation.snapshot(entries)`. No `session.created`.
- WebSocket preserves frame order: a switch/new frame sent before `user.message` on the same socket routes the message to the right session.

---

## Phase A — SDK session lifecycle

### Task A1: Track the active ACP session id + drop connect-URL resume

**Files:**
- Modify: `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/sdk/SdkLifecycle.kt`
- Modify: `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/transport/SessionResume.kt`
- Modify: `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/sdk/SentientSdk.kt`
- Test: `shared/mobile-sdk/src/commonTest/kotlin/io/sentient/mobilesdk/sdk/SdkReconnectResumeTest.kt` (new)

**Design:**
- Introduce a `currentSessionId: MutableStateFlow<String?>` owned by the orchestrator (`SentientSdk`), set ONLY from `ServerMessage.SessionSwitched` / `SessionCreated` (the ACP uuid), cleared on `disconnect(clearSession = true)` and on an explicit new-chat command before the first mint.
- `SdkLifecycle.attemptConnect()` connects with the BASE url (no `?session_id=`). Remove `resume.buildConnectUrl` usage and the `armStaleResume` / `checkStaleResume` snapshot-fallback path (no connect-URL resume → no 404-fallback to guard). Keep `SessionResume` only if still needed for the pointer; otherwise delete it and its store wiring in a later cleanup task.
- `finishReady(sessionId)` MUST NOT store `sessionId` as the resume pointer (it is the gateway connection id). It still calls `hooks.onReady(sessionId)`.
- **Reconnect re-establish:** after a *reconnect* reaches READY, if `currentSessionId.value != null`, fire `session.switch(currentSessionId)` (fire-and-forget) to restore server context. Distinguish first-connect (currentSessionId null → nothing to restore) from reconnect.

**Steps:**
- [ ] Add `currentSessionId` StateFlow to `SentientSdk`; expose it on the public surface. Wire `onFrame` (SdkLifecycle) `SessionSwitched`/`SessionCreated` → `hooks.onSessionAnchored(msg.sessionId)` → orchestrator sets `currentSessionId`.
- [ ] Change `attemptConnect` to use `gatewayWsUrl` directly; delete `resume.buildConnectUrl`, `armStaleResume`, `checkStaleResume`, and the `SessionsError forbidden` resume branch.
- [ ] In `finishReady`, drop `resume.setCurrentSessionId(sessionId)`. Add a `wasReconnect` signal (the lifecycle already distinguishes RECONNECTING) → on reconnect READY with non-null `currentSessionId`, call the SDK's fire-and-forget `sendSwitchSession(currentSessionId)` (Task A2).
- [ ] Write `SdkReconnectResumeTest`: (a) first connect with no anchor sends no switch; (b) after `SessionCreated(uuid)`, a simulated reconnect-to-READY fires `session.switch(uuid)`; (c) connect URL never contains `session_id`.
- [ ] Run the test; commit `fix(mobile-sdk): drop connect-URL resume, track ACP session id, re-establish on reconnect`.

### Task A2: Fire-and-forget session commands + mint debounce

**Files:**
- Modify: `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/connectors/SessionsConnector.kt`
- Modify: `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/sdk/SentientSdk.kt`
- Modify: `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/sdk/SdkConfig.kt` (add `mintDebounceMs`)
- Test: `shared/mobile-sdk/src/commonTest/kotlin/io/sentient/mobilesdk/connectors/SessionsConnectorFireAndForgetTest.kt` (new)

**Design — add to `SessionsConnector` (inject `clock: Clock`, `mintDebounceMs: Long`):**

```kotlin
// Fire-and-forget: send the frame and return; broadcasts (session.created/switched)
// still flow to listeners + the SDK anchor. No await, no timeout, never throws.
private var lastMintAtMs: Long? = null

fun sendNew() {
    val now = clock.nowMs()
    val inFlight = lastMintAtMs
    if (inFlight != null && now - inFlight < mintDebounceMs) {
        log.info("sendNew.debounced", mapOf("sinceMs" to (now - inFlight)))
        return
    }
    lastMintAtMs = now
    log.info("sendNew", mapOf("requestId" to newId()))
    send(ClientMessage.SessionNew(requestId = newId()))
}

fun sendSwitch(sessionId: String) {
    log.info("sendSwitch", mapOf("sessionId" to sessionId))
    send(ClientMessage.SessionSwitch(requestId = newId(), sessionId = sessionId))
}
```

- `onCreated` clears `lastMintAtMs = null` (mint complete → next mint allowed).
- `reset()` clears `lastMintAtMs = null` (disconnect → new connection → fresh mint allowed) — this makes the debounce connection-scoped without threading a connection id.
- Keep the existing suspend `newChat()` / `switchTo()` for any non-UI caller, OR delete if unused after Phase B/D/E (verify with grep before deleting).

**Steps:**
- [ ] Add `mintDebounceMs` to `gateway`-style config surface for the SDK (`SdkConfig`), default in config with inline comment (range ~1000–5000ms; default 3000).
- [ ] Add `sendNew()` / `sendSwitch(id)` + the debounce; clear in `onCreated` + `reset`.
- [ ] Surface on `SentientSdk`: `fun sendNewChat()` / `fun sendSwitchSession(id: String)` (non-suspend, never throw).
- [ ] Test: rapid `sendNew()` ×3 within the window emits ONE `SessionNew`; after `onCreated` a new `sendNew()` emits again; after `reset()` a new `sendNew()` emits again; `sendSwitch` always emits.
- [ ] Commit `feat(mobile-sdk): fire-and-forget session commands + mint debounce`.

---

## Phase B — mobile-data usecases + model

### Task B1: SwitchConversationUseCase → fire-and-forget

**Files:**
- Modify: `shared/mobile-data/src/commonMain/kotlin/io/sentient/mobiledata/usecase/SwitchConversationUseCase.kt`
- Modify: `shared/mobile-data/src/commonMain/kotlin/io/sentient/mobiledata/data/SessionsRepository.kt` + `SdkSessionsRepository.kt`

**Design:** `invoke(sessionId: String?)` returns `Unit`, no `suspend` await of created/switched:
```kotlin
class SwitchConversationUseCase(private val sessions: SessionsRepository) {
    operator fun invoke(sessionId: String?) {
        if (sessionId == null) sessions.newChatFireAndForget()
        else sessions.switchToFireAndForget(sessionId)
    }
}
```
- `SessionsRepository`: add `fun newChatFireAndForget()` / `fun switchToFireAndForget(id: String)` mapping to `sdk.sendNewChat()` / `sdk.sendSwitchSession(id)`. Keep the suspend `newChat()/switchTo()` only if still used elsewhere.

**Steps:**
- [ ] Add the fire-and-forget repo methods + SDK passthrough.
- [ ] Make `SwitchConversationUseCase.invoke` non-suspend, fire-and-forget.
- [ ] Commit `refactor(mobile-data): switch-conversation usecase is fire-and-forget`.

### Task B2: SendMessageUseCase owns the gated consume + reconnect re-fire

**Files:**
- Modify: `shared/mobile-data/src/commonMain/kotlin/io/sentient/mobiledata/usecase/SendMessageUseCase.kt`
- Modify: `shared/mobile-data/src/commonMain/kotlin/io/sentient/mobiledata/data/ConnectionStateRepository.kt` (read `status`)
- Test: `shared/mobile-data/src/commonTest/kotlin/io/sentient/mobiledata/usecase/SendMessageUseCaseTest.kt` (new)

**Design:** the usecase decides WHEN to consume queued entries. The `OutboundCache` stays VM-owned and is passed in.
```kotlin
class SendMessageUseCase(private val conversation: ConversationRepository) {
    /** Drain still-QUEUED entries iff transport is ready. Echo reconciles by id later. */
    fun flushIfReady(cache: OutboundCache, status: SdkStatus) {
        if (status != SdkStatus.READY) return
        for (m in cache.queued()) {
            conversation.send(m.text, m.id)
            cache.markSent(m.id)
        }
    }
}
```
- Reconnect re-establish of the session is owned by the SDK (Task A1), so the usecase only gates on READY. The VM observes the READY rising edge and calls `flushIfReady`. `retry(id)` lives in the VM (re-queue + optional `forceReconnect` if not READY) but delegates the drain to `flushIfReady`.

**Steps:**
- [ ] Implement `flushIfReady`.
- [ ] Test: QUEUED entries drain only when status == READY; non-READY is a no-op; SENT entries are not re-sent.
- [ ] Commit `feat(mobile-data): send usecase owns the ready-gated outbox flush`.

### Task B3: ObserveChatUseCase emits a history-loading flag

**Files:**
- Modify: `shared/mobile-data/src/commonMain/kotlin/io/sentient/mobiledata/usecase/ObserveChatUseCase.kt`
- Modify: `shared/mobile-data/src/commonMain/kotlin/io/sentient/mobiledata/model/ChatModel.kt` (add `historyLoading: Boolean`)
- Test: `shared/mobile-data/src/commonTest/kotlin/io/sentient/mobiledata/usecase/ObserveChatUseCaseTest.kt` (extend)

**Design:** `historyLoading` is true after a `SessionSwitched` (existing session) until the next `ConversationSnapshot`; false for a brand-new chat (snapshot is empty / arrives immediately). Fold it inside the reveal/scan state or a parallel small flow keyed off `liveEvents`. Composer is never gated on it — purely a message-list spinner.

**Steps:**
- [ ] Add `historyLoading` to `ChatModel` (default false).
- [ ] Derive it in `ObserveChatUseCase` from `SessionSwitched` → true, `ConversationSnapshot` → false.
- [ ] Test: switched-without-snapshot ⇒ historyLoading true; snapshot ⇒ false; new chat ⇒ stays false.
- [ ] Commit `feat(mobile-data): observe-chat surfaces history-loading for switch spinner`.

---

## Phase C — crash resilience + auth routing (both scopes)

### Task C1: CoroutineExceptionHandler on the connection scope

**Files:**
- Modify: `shared/mobile-data/src/iosMain/kotlin/io/sentient/mobiledata/di/IosUserSession.ios.kt`
- Modify: `android/src/main/kotlin/io/sentient/android/di/UserSessionManager.kt`
- Reference: `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/sdk/AuthErrorClass.kt` (existing classifier)

**Design:** add a `CoroutineExceptionHandler` to BOTH session scopes' context:
```kotlin
private val handler = CoroutineExceptionHandler { _, e ->
    if (AuthErrorClass.isAuth(e)) {
        log.warn("scope.auth-failure → login", ...)
        sdk.signalAuthExpired()        // sets ConnectionState.authExpired → nav routes to login
    } else {
        log.warn("scope.transient-caught (recovered)", mapOf("error" to e.message))
        // reconnect supervisor handles recovery; do NOT rethrow
    }
}
private val scope = CoroutineScope(SupervisorJob() + dispatcher + handler)
```
- Add `SentientSdk.signalAuthExpired()` that flips `ConnectionState.authExpired = true` (the existing `onAuthFailed` path already does this — reuse it).
- Wrap the `scope.launch { sdk.connect() }` body in try/catch as a belt-and-braces guard too.

**Steps:**
- [ ] Add `signalAuthExpired()` to `SentientSdk` (reuse `onAuthFailed`).
- [ ] Add the handler to `IosUserSession` scope + guard `open()`'s launch.
- [ ] Add the same handler to `UserSessionManager` scope + guard its connect launch.
- [ ] Commit `fix(mobile): guard connection-scope coroutines — auth→login, transient→recover, never abort`.

---

## Phase D — Android VM + UI

### Task D1: ChatViewModel thin, fire-and-forget

**Files:**
- Modify: `android/src/main/kotlin/io/sentient/android/chat/ChatViewModel.kt`
- Modify: `android/src/main/kotlin/io/sentient/android/chat/ChatUiState.kt` (carry `historyLoading`)

**Design:** init fires the command (no await/runCatching around a non-throwing call); observe folds `ChatModel` (incl. `historyLoading`) → `ChatUiState`; the connection collector calls `sendUseCase.flushIfReady(cache, status)` on READY. `send`/`retry` enqueue + `flushIfReady`; `retry` adds `forceReconnect` when not READY.

**Steps:**
- [ ] Replace the blocking `runCatching { component.switchConversation(sessionId) }` with `component.switchConversation(sessionId)` (now fire-and-forget, returns Unit).
- [ ] Route flush through `SendMessageUseCase.flushIfReady`.
- [ ] Carry `historyLoading` into `ChatUiState`.
- [ ] Commit `refactor(android): chat VM fire-and-forget load + ready-gated send`.

### Task D2: History-loading spinner in the message list

**Files:**
- Modify: `android/src/main/kotlin/io/sentient/android/chat/message/MessageList.kt` (or `LoadingState.kt`)
- Modify: `android/src/main/kotlin/io/sentient/android/chat/ChatContent.kt`

**Steps:**
- [ ] Show a centered spinner over the (cleared) list while `historyLoading`; keep the composer enabled.
- [ ] Commit `feat(android): switch shows history-loading spinner, composer stays live`.

---

## Phase E — iOS VM + UI

### Task E1: ChatViewModel thin, fire-and-forget

**Files:**
- Modify: `ios/App/Chat/ChatViewModel.swift`
- Modify: `ios/App/Chat/ChatUiState.swift` (or wherever the state struct lives)

**Steps:**
- [ ] Replace the `do { try await component.switchConversation.invoke(...) } catch` with the fire-and-forget `component.switchConversation.invoke(sessionId:)` (now non-throwing Unit).
- [ ] Route flush through `SendMessageUseCase.flushIfReady` on the READY edge; `retry` adds `forceReconnect`.
- [ ] Carry `historyLoading` into the published state.
- [ ] Commit `refactor(ios): chat VM fire-and-forget load + ready-gated send`.

### Task E2: History-loading spinner

**Files:**
- Modify: `ios/App/Chat/MessageList.swift`
- Modify: `ios/App/Chat/ChatView.swift`

**Steps:**
- [ ] Spinner over the list while `historyLoading`; composer stays live.
- [ ] Commit `feat(ios): switch shows history-loading spinner, composer stays live`.

---

## Phase F — E2E + capture (agent-driven, both platforms)

Run against the live local Docker stack (`sentient-gateway` healthy). Android = Maestro + adb on emulator-5554; iOS = Maestro + simctl on the booted simulator (SIGNED build, never `CODE_SIGNING_ALLOWED=NO`). Capture logcat/os_log + screenshots under `qa/mobile/logs` + `qa/mobile/screens` (gitignored).

### E2E matrix (one row per behaviour; both platforms unless noted)

| Case | Pre-state | Action | Expected user-visible | Expected log trail |
|---|---|---|---|---|
| new-chat-send | cold start, new chat | type + send | bubble `queued`→`sent`, reply streams; **no 5s stall** | `sendNew` fired; user.message drains on READY; NO `timeout waiting for session.created` |
| switch-loads | ≥2 sessions | drawer → tap old | spinner in list → history renders; **composer typeable throughout** | `sendSwitch`; `historyLoading` true→false on `conversation.snapshot` |
| switch-type-midload | switching | type while spinner up | input accepted; queued; sends after snapshot | message drains post-snapshot, correct session |
| send-offline | socket down | send | `queued`, no error dialog | drains on reconnect READY |
| retry-stuck | queued, stuck | tap retry | reconnects + sends | `forceReconnect` + `flushIfReady` drains |
| cold-start-clean | logged in, prior run | relaunch | lands new chat, no ghost | **no `forbidden`/`resume-` / `session not owned`**; ONE `sendNew` |
| mint-debounce | new chat | rapid double new-chat | one empty session | ONE `session.new:acp-minted` in gateway log; `sendNew.debounced` on the 2nd |
| reconnect-keeps-context | mid-conversation | drop+restore socket | same convo, next msg has context | reconnect READY → SDK fires `session.switch(currentSessionId)` |
| auth-expiry→login | active session | force auth-expire (fault) | routes to login, **no crash** | handler classifies auth → `authExpired` → login route |
| transient-throw-no-crash | cold connect race | hammer cold-start/new-chat ×N | never aborts; retry offered | exception handler logs `transient-caught`; **zero SIGABRT** |

### Capture step (resilience proof)
- [ ] iOS: run a continuous `xcrun simctl spawn booted log stream` filtered to the app subsystem while hammering cold-start + new-chat ×20; assert ZERO new `.ips` crash reports in `~/Library/Logs/DiagnosticReports/` and zero `processUnhandledException`.
- [ ] Gateway: `docker logs sentient-gateway` shows no `forbidden` / `resume-` after the change; one `acp-minted` per explicit new-chat (not per launch/reconnect).

### Pre-handover gate
- [ ] Every E2E case green on BOTH platforms (or flagged with a harness-artifact justification per the e2e rules).
- [ ] `:shared:mobile-sdk` + `:shared:mobile-data` unit tests green; Android `assembleDebug` + iOS SIGNED build succeed.
- [ ] Evidence (screenshots + log slices) captured under `qa/mobile/`.

---

## Self-review notes
- Spec coverage: fire-and-forget (B1/D1/E1), gated send (B2), switch spinner (B3/D2/E2), cold-start-no-phantom + reconnect-resume (A1), debounce (A2), crash guard + auth route (C1) — all map to tasks.
- Type consistency: `sendNewChat()`/`sendSwitchSession(id)` on `SentientSdk`; `newChatFireAndForget()`/`switchToFireAndForget(id)` on `SessionsRepository`; `flushIfReady(cache, status)` on `SendMessageUseCase`; `historyLoading: Boolean` on `ChatModel`/`ChatUiState`.
- Risk: removing `SessionResume`/stale-resume guard is a real SDK surface change — gate behind A1's tests + the `cold-start-clean` + `reconnect-keeps-context` E2E rows before deleting dead code.
