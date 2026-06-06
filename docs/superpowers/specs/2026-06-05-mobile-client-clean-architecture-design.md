# Mobile Client Clean-Architecture Refactor — Design Spec

- **Date:** 2026-06-05
- **Branch:** `feature/mobile-client`
- **Status:** Design (approved in brainstorming; pending spec review)
- **Scope:** Android app, iOS app, KMP mobile-sdk surface, new shared KMP repository module

---

## 1. Problem

The Android and iOS apps are thin reactive shells over a single process-wide `SentientSdk` instance whose **entire state is one conflated `StateFlow<SdkState>`**. This causes:

1. **No per-screen UIState / no repository layer.** `ChatScreen` (Android) and `ChatView` (iOS) read raw `SdkState` passthrough. SDK domain types leak into 15+ UI sites; any SDK shape change ripples everywhere.
2. **Lifecycle leaks.** WS, mic, and audio live app-wide and are never torn down on screen dismiss. `SdkHolder` (Android) and `SdkStore` (iOS) are process/app-scoped singletons holding all chat state forever.
3. **Load-blocking coupling.** The history drawer calls `refresh()` on open; if the SDK has not connected, a 12 s timeout fires and the drawer shows a dead error with no retry.
4. **"Whole message pops in."** Token streaming and task pills appear all-at-once instead of incrementally. Root cause is almost certainly **`StateFlow` conflation**: a burst of `message.delta` frames is processed before the UI collects the next frame, so the collector only ever sees the final accumulated state. (The SDK *does* emit per-token; the single conflated surface destroys event granularity.)
5. **No typed error backbone.** Failures (WS drop, auth expiry, decode failure, request timeout) throw into async tasks and are logged but not surfaced as typed, recoverable errors the UI can degrade against. Malformed frames are silently coerced/dropped today.

These block clean feature growth. This refactor re-founds the client architecture.

## 2. Goals / Non-Goals

**Goals**
- Treat the SDK as a **blackbox datasource** (remote data service / system-capability service).
- Introduce a **repository layer** that builds clean per-domain streams on top of the SDK.
- **Per-screen ViewModels** own `StateFlow<UiState>`, lifecycle-bound to the screen.
- **No process singleton.** SDK instance bound to the chat-feature scope; one tiny app-scoped `PresenceCoordinator` (presence signals only, zero chat state).
- **Seamless async UX**: chat usable immediately; init races hidden; send-while-connecting queues, never errors.
- **Live streaming**: tokens grow incrementally, task pills append one-by-one.
- **Typed Result envelope** (`Loading | Success | Failure(SentientError)`) threaded SDK→repo→VM→UI as the graceful-degradation backbone.
- **Agent-driven native E2E** (Maestro) covering every feature, including the full voice loop, as the acceptance gate.
- **Event-chain + lifecycle logging** at the new boundaries for end-to-end traceability.

**Non-Goals**
- No change to the gateway wire protocol or Hermes. WS transport stays pinned (refine reconnect, do not rewrite).
- No change to tuned audio/VAD constants.
- No offline-first persistence beyond an in-memory history cache (persisted cache is a later iteration).
- No navigation framework overhaul beyond what screen-scoped VMs require.

## 3. Locked Decisions

| Decision | Choice | Rationale |
|---|---|---|
| WS/SDK lifecycle scope | **Chat-feature scope** + tiny app-scoped `PresenceCoordinator` | Purest "no singleton"; matches mobile UX norms; session-resume + 30-min gateway archive make re-entry cheap |
| Repository placement | **Shared KMP module** (`shared/mobile-data`) on top of a pure-blackbox SDK; VMs native | Repo logic written once; zero cross-platform drift; SDK stays a thin transport blackbox |
| SDK surface | **Split** into `connection: StateFlow` + `events: SharedFlow` + `timeline: StateFlow` | Conflation kills token granularity; events need an un-conflated, ordered, no-loss tap |
| Result envelope | **`SentientResult<Loading\|Success\|Failure>`** with `SentientError` taxonomy | SDK is the source of truth for its own long calls and errors; backbone of graceful degradation |
| Rollout | **One plan, foundation-first**, fully agentic, gated by a comprehensive Maestro matrix | Contract before consumers; Android as reference, iOS as mirror |
| Voice E2E | **In scope** (real STT→LLM→TTS), audio injected via dev fixture hook, audio-out asserted via state+logs | Maestro cannot inject mic audio or capture waveforms |

## 4. Architecture

### 4.1 Layer model (per platform; repo shared)

```
 UI  (Compose / SwiftUI) — pure, stateless
   renders UiState ▼   emits intents ▲
 ─────────────────────────────────────────────
 ViewModel  (NATIVE, screen-scoped)
   ChatViewModel · HistoryViewModel · AuthViewModel
   owns StateFlow<XUiState>;  lifecycle = screen
   (Android viewModelScope · iOS @Observable @StateObject)
 ─────────────────────────────────────────────
 Repository  (SHARED KMP → shared/mobile-data, depends on mobile-sdk)
   ChatRepository · HistoryRepository · ConnectionRepository
   • splits SDK surface into per-domain streams
   • outbox (send-while-connecting)
   • history cache (instant drawer)
   • wraps every output in SentientResult<T>
 ─────────────────────────────────────────────
 SentientSdk  (KMP blackbox) — pure transport
   connection: StateFlow<ConnectionState>
   events:     SharedFlow<SdkEvent>     ← ordered, no-loss
   timeline:   StateFlow<List<ChatMessage>>
   methods: connect/disconnect/sendText/startMic/sessions...
 ─────────────────────────────────────────────
 PresenceCoordinator  (app-scoped, tiny, ZERO chat state)
   ProcessLifecycle / scenePhase + idle → connect/disconnect signal
```

### 4.2 SDK blackbox contract (the key change)

Today: one conflated `StateFlow<SdkState>`. Split by nature:

**`connection: StateFlow<ConnectionState>`** — slowly-changing snapshot; conflation fine.
```
ConnectionState { status, hasSession, connectionLost, authExpired,
                  prefs, voiceMode, isSpeaking, audioState }
```

**`events: SharedFlow<SdkEvent>`** — ordered, buffered, **no-loss** (`extraBufferCapacity = N`, `onBufferOverflow = SUSPEND`). The live tap.
```
sealed SdkEvent:
  MessageStarted(cycleId)
  MessageDelta(cycleId, chunk)        // per-token, never conflated away
  MessageCommitted(message)
  TaskUpserted(task)                  // pills appear one-by-one
  TranscriptUpdated(text)
  CycleDone(cycleId) / CycleAborted(cycleId, kind)
  SessionSwitched(sessionId)
  ProtocolError(SentientError)        // decode failure surfaced, NOT silently dropped
```

**`timeline: StateFlow<List<ChatMessage>>`** — committed messages for seed/replay on re-subscribe; conflation fine (committed messages need no token granularity).

The SDK gets *thinner*: it stops owning app-shaped aggregate state and exposes primitives. The repo owns the cache and the fold.

**Boundary mapping (catch at system boundaries only):** the SDK maps every raw `Throwable`, decode failure, and transport signal to a typed `SentientError` and either emits it (`ProtocolError` event) or reflects it in `connection` flags. **No raw `Throwable` ever crosses into the repo.** Today's lenient `coerceInputValues` drop-on-malformed is replaced by an explicit `ProtocolError` emission.

### 4.3 Data flow (happy path)

```
gateway frame → connector → SDK emits SdkEvent
   → ChatRepository folds events into ChatModel (its own cache)
   → ChatRepository.chatStream: Flow<SentientResult<ChatModel>>
   → ChatViewModel collects → builds ChatUiState (StateFlow)
   → Compose / SwiftUI renders growing bubble + pills one-by-one
```

### 4.4 Module / file layout

```
shared/mobile-sdk/        (existing — evolve public surface only)
  sdk/SentientSdk.kt        → expose connection/events/timeline; keep methods
  sdk/ConnectionState.kt    → NEW (extracted from SdkState)
  protocol/SdkEvent.kt      → NEW (sealed event taxonomy)
  result/SentientError.kt   → NEW (taxonomy; lives in sdk so boundary can map)
  ... dev fault hooks (debug-only source set)

shared/mobile-data/       (NEW KMP module — depends on mobile-sdk)
  result/SentientResult.kt
  repository/ChatRepository.kt
  repository/HistoryRepository.kt
  repository/ConnectionRepository.kt
  outbox/Outbox.kt
  cache/HistoryCache.kt
  model/ChatModel.kt, HistoryModel.kt
  log/ ... Result-aware tagged logging

android/ (app)
  chat/ChatViewModel.kt, ChatUiState.kt
  history/HistoryViewModel.kt
  presence/PresenceCoordinator.kt (ProcessLifecycleOwner)
  (delete SdkHolder singleton)

ios/App/
  Chat/ChatViewModel.swift (@Observable), ChatUiState.swift
  History/HistoryViewModel.swift
  Presence/PresenceCoordinator.swift (scenePhase)
  (delete SdkStore-as-singleton)
```

**iOS framework integration:** the published XCFramework is built from `mobile-data` (which transitively includes `mobile-sdk`). SKIE exports the repo surface, `SentientResult`, and `SentientError` as Swift enums with associated values. Apps depend on the repo layer, not the SDK directly.

## 5. Chat-session lifecycle (the "seamless" chain)

```
ChatViewModel.init(sessionId?)            ← screen opens
  └─ chatRepo.openSession(sessionId)
       └─ acquire SDK (build if needed) + sdk.connect()   [BACKGROUND]
  UiState = ready-to-type IMMEDIATELY      ← composer never blocks on WS

user types + sends  (WS maybe still CONNECTING)
  └─ chatRepo.send(text)
       ├─ optimistic: add user msg status=QUEUED → UiState shows it now
       └─ outbox.enqueue(text)
            └─ on connection==READY → flush → sdk.sendText → status=SENT → "thinking"

ChatViewModel.onCleared / view-disappear
  └─ chatRepo.closeSession() → sdk.disconnect (or hand to Presence for idle)
```

The user only ever sees **message queued → thinking**. Init races are hidden.

### 5.1 PresenceCoordinator (the one app-scoped piece)

Tiny. Holds a presence enum + a weak handle to the active connection. **No chat data.**
- background (ProcessLifecycle / scenePhase) → signal disconnect (battery/radio; honors the no-server-heartbeat rule)
- foreground → signal reconnect (session-resume)
- idle-timeout → disconnect per the device disconnect / PersonSession-archive contract

## 6. Outbox (send-while-connecting)

`ChatRepository` owns a FIFO outbox. Invariants (FSM-tested):
- enqueue while not-READY → message visible as `QUEUED`, never lost
- flush on `READY` in order
- dedup on reconnect (never double-send a flushed message)
- terminal failure (auth dead) → mark outbox `FAILED`, surface to UiState (never silent)

## 7. History cache

`HistoryRepository` holds a cached session list (in-memory now; persisted later).
```
drawer opens → VM reads cache → renders INSTANT (or empty + spinner)
            → repo refreshes via sdk.listSessions when READY [BACKGROUND]
            → success → update cache + flow → drawer fills
```
No hard dependency on connection. No blocking. Kills the 12 s-timeout-then-dead bug.

## 8. Result envelope + error taxonomy

```kotlin
sealed interface SentientResult<out T> {
  data class Loading<out T>(val partial: T? = null) : SentientResult<T>  // stale-while-loading
  data class Success<out T>(val data: T)            : SentientResult<T>
  data class Failure(val error: SentientError)      : SentientResult<Nothing>
}

sealed class SentientError(
  val kind: ErrorKind,            // Connection, Auth, Protocol, Timeout, Cycle, Outbox, Unknown
  val recoverable: Boolean,
  val retry: RetryPolicy,         // None | Internal(backoff) | UserPrompt
  val userMessage: String,        // sanitized, display-ready
  val cause: Throwable? = null,   // DEBUG only — never crosses to UI raw
)
```

- **Loading** carries optional `partial` for paging/seeding (connect handshake, `listSessions` paging, `switchSession`/`newChat`, history-feed seeding).
- **Failure** stays `Nothing` (clean variance). Stale-while-**error** is covered by the VM keeping last-good in UiState.
- **Two distinct axes:** `connection.status` (transport FSM) ≠ `Result.Loading` (per-operation in-flight). A `switchSession` emits `Loading→Success` even while `connection==READY`.

**Error birth → mapping**

| Source | New behavior |
|---|---|
| malformed frame JSON | `ProtocolError` event (not silent drop) |
| WS drop / signal | `ConnectionError(retry=Internal)` |
| auth expired | `AuthError(recoverable=false, retry=UserPrompt/None)` |
| listSessions/switch timeout | `Failure(TimeoutError(retry=UserPrompt))` |
| unsolicited cycle.aborted | `CycleError` |
| outbox send fail | `OutboxError` |

**Retry ownership = where degradation lives**
- `Internal` → repo/SDK retries (reconnect backoff, transient list). UI shows "retrying", no action.
- `UserPrompt` → repo surfaces Failure → UI shows retry button → VM re-invokes.
- `None` → terminal (auth dead) → hard error + re-login path.

**VM fold → UiState** (stale-while-error)
```
ChatUiState { messages /* last-good */, isLoading, banner: ErrorBanner? }
Loading(partial) → isLoading=true, render partial if present
Success(data)    → render data
Failure(error)   → keep last-good + banner(+retry per policy)
```
No screen ever blanks on a recoverable error.

## 9. Streaming fix

Root-cause candidate = conflated `StateFlow` (§1.4). New path:
- SDK `events: SharedFlow` carries each `MessageDelta` / `TaskUpserted` un-conflated.
- Repo accumulates → `ChatModel.liveBubble.content` grows per chunk; `tasks` append one-by-one.
- VM `StateFlow<ChatUiState>` emits each growth; the typewriter gets real cadence.

**Diagnostic gate first (Phase 0).** Before building, one live trace confirms whether the gateway flushes deltas incrementally or batches at `cycle.done`. If batched, the fix is gateway-side pacing, not just the SDK surface. The new architecture makes this observable either way; we do not guess-fix (debug-first rule).

## 10. Logging additions (event-chain + lifecycle)

SDK logging stays. New tagged loggers (hierarchy rule; IDs in every line; previews ≤120 chars). **These lines double as the E2E "expected log trail" assertions** (grepped from logcat / os_log).

| Tag | Logs |
|---|---|
| `[sentient,mobile,repo,chat]` | each `SentientResult` emit: `Loading(partial=n)→Success(data=n)→Failure(kind,recoverable,retry)` + cycleId/sessionId/requestId |
| `[sentient,mobile,repo,outbox]` | enqueue / flush / dedup / fail + msg id + connection status |
| `[sentient,mobile,repo,history]` | cache-hit render / bg-refresh start / refresh result |
| `[sentient,mobile,vm,chat]` | UiState transition (prev→new key fields), intent received |
| `[sentient,mobile,vm,history]` | same |
| `[sentient,mobile,lifecycle]` (INFO) | VM init/onCleared, repo open/closeSession, SDK build/teardown |
| `[sentient,mobile,presence]` (INFO) | foreground/background/idle transition + emitted signal |

## 11. Testing

**Unit (test-lean doctrine — defensive only):**
- wire/protocol contract (SDK↔gateway frames) — keep existing
- SDK boundary error mapping (raw→`SentientError`, malformed→`ProtocolError`) — new, security/robustness boundary
- outbox FSM (enqueue / flush-order / dedup / fail) — new, documented invariant
- history-cache (render-from-cache-then-refresh) — new
- streaming accumulation (events fold → growing bubble + ordered pills) — pins the bug
- Result fold (Loading/Success/Failure → UiState branches) — pins degradation invariant
- Skip: VM passthrough, UiState plumbing, types, DI wiring.

**E2E (Maestro, agent-driven):** see §12. Acceptance gate.

## 12. E2E matrix (Maestro + platform CLI)

Native, agent-driven. Maestro drives the Android emulator (primary, `adb`) and iOS simulator (parity, `xcrun simctl`) against the **local stack** (`deploy/macos`) with free creds. **Login PIN = `1234`** (local test). Log-trail asserted by greping `adb logcat` / `os_log` for the §10 tags.

Fault-injection cases use `adb` network toggles plus **dev-only fault hooks** in the SDK (compiled out of release): expired-token injection, malformed-frame injection, and a **fixture audio-injection hook** that feeds the capture adapter a recorded utterance.

**Voice loop note:** Maestro cannot inject mic audio or capture a waveform. The voice case taps mic via UI, the fixture hook supplies a recorded utterance, STT→LLM→TTS run **real** (Fish TTS + real LLM), and audio-out is asserted via SDK state (`isSpeaking`, `voiceMode`, `audioState`) + downlink playback log lines — not by capturing sound.

**Columns:** `Case | Plat | Pre-state | Action | Expected user-visible | Expected log trail`. Plat: A = Android emulator, i = iOS simulator. **Bold = the regressions/new behaviors this refactor must prove.**

| Case | Plat | Pre-state | Action | Expected user-visible | Expected log trail |
|---|---|---|---|---|---|
| backend-setup | A+i | fresh install, no config | enter host/port/TLS, save | routes to login | `lifecycle SDK build`, `connection CONNECTING` |
| login-happy | A+i | configured, logged out | pick avatar → PIN `1234` → submit | enters chat | `vm,chat init`, `connection AUTHENTICATING→READY` |
| login-bad-pin | A+i | configured | wrong PIN | AuthError banner, stay on login | `Failure(kind=Auth,retry=UserPrompt)` |
| send-connected | A+i | READY chat | type + send | user bubble → "thinking" | `outbox enqueue→flush`, `vm UiState thinking` |
| **send-while-connecting (outbox)** | A+i | chat open, WS still CONNECTING | type + send fast | bubble shows **QUEUED** → **SENT** → thinking | `outbox enqueue(status=queued)`, `connection READY`, `outbox flush dedup-ok` |
| **live-streaming** | A+i | READY | send msg with long reply | text **grows incrementally** (typewriter), no pop-in | repeated `MessageDelta chunk=…` then `MessageCommitted` |
| **task-pills-sequential** | A+i | READY | send msg triggering ≥2 tools | pills appear **one-by-one** | ordered `TaskUpserted status=running/finished` |
| interrupt | A+i | mid-stream | tap Stop | bubble cut, cutoffKind=interrupt | `CycleAborted kind=interrupt` |
| **voice-loop-full** | A+i | READY, paid creds on | tap mic, fixture utterance injected | transcript preview → assistant reply streams → **isSpeaking true** during TTS | `audio uplink start`, `TranscriptUpdated`, `connection isSpeaking=true`, `audio downlink playback start` |
| mic-toggle | A+i | READY | tap mic on then off | voiceMode ACTIVE→OFF | `voiceMode OFF→ACTIVE→OFF` |
| **drawer-cache** | A+i | session list cached, WS reconnecting | open drawer | list renders **instantly**, then refreshes | `history cache-hit render`, `history bg-refresh start→result` |
| switch-session | A+i | drawer open | tap a session | spinner (Loading) → feed seeds | `Loading→Success`, `SessionSwitched` |
| rename-session | A+i | drawer | rename | list updates | `Success`, cache update |
| delete-session | A+i | drawer | delete | row removed | `Success`, cache update |
| new-chat | A+i | chat | tap new | empty chat, fresh session | `newChat Loading→Success` |
| logout | A+i | chat | settings → logout | back to login, WS down | `lifecycle closeSession`, `connection DISCONNECTED` |
| **conn-lost-recover** | A+i | mid-chat | `adb` drop network | ConnectionError banner, **stale msgs kept**, auto-retry → recover | `Failure(kind=Connection,retry=Internal)`, `RECONNECTING→READY` |
| auth-expired | A+i | READY | inject expired token (dev hook) | hard error → re-login path | `Failure(kind=Auth,retry=None)` |
| list-timeout | A+i | drawer, gateway stalled | open drawer | Failure → **retry button** → retry works | `Failure(kind=Timeout)`, retry `Loading→Success` |
| malformed-frame | A+i | READY | inject bad JSON (dev hook) | UI graceful, no crash, no silent loss | `ProtocolError` logged (NOT silent drop) |
| **presence bg→fg** | A+i | READY chat | background app → foreground | reconnects with session-resume, history intact | `presence background→signal disconnect`, `foreground→reconnect`, `SessionResume` |
| idle-disconnect | A+i | READY, idle | wait idle threshold | WS drops silently | `presence idle→disconnect` per contract |

No case skipped. Any case unreachable on a given platform is flagged explicitly in handover.

## 13. Rollout plan (one plan, foundation-first, agentic)

Single end-to-end plan; agents execute and drive the Maestro matrix as the gate.

```
Phase 0  Streaming diagnostic — one live trace: incremental vs batch-at-cycle.done.
Phase 1  SDK contract — connection StateFlow + events SharedFlow + timeline;
         SentientError taxonomy + boundary mapping; ProtocolError emission;
         dev fault hooks (expired-token, malformed-frame, fixture-audio).
Phase 2  Shared KMP repo module (shared/mobile-data) — Chat/History/Connection
         repos · outbox · history-cache · SentientResult · Result-aware logging.
Phase 3  Android (reference) — native VMs · chat-scoped lifecycle ·
         PresenceCoordinator · delete SdkHolder · lifecycle/Result logging.
Phase 4  iOS (mirror) — @Observable VMs · scenePhase presence ·
         delete SdkStore-singleton · SKIE export of repo + Result.
Phase 5  Streaming live-confirm + degradation polish + FULL Maestro matrix green (A+i).
```

Each phase: build → defensive unit tests → Maestro subset → phase gate. Phase 5 = whole matrix green on both platforms.

## 14. Risks / Open Questions

- **Phase 0 outcome may widen scope.** If the gateway batches deltas at `cycle.done`, streaming needs gateway-side pacing in addition to the SDK surface split. Resolve before Phase 1 freezes the event contract.
- **SKIE export of generics.** `SentientResult<T>` and the `SdkEvent` sealed hierarchy must bridge cleanly to Swift enums with associated values. Verify SKIE handles the variance (`Loading<out T>` / `Failure : Nothing`) early in Phase 1; fall back to a non-generic per-domain result if needed.
- **Emulator audio injection.** The fixture-audio hook must feed the `AudioCaptureAdapter` deterministically in debug builds; confirm the hook path on both Android (`AudioRecord` shim) and iOS (`AVAudioEngine` shim).
- **Paid-credential burn in E2E.** Voice-loop cases burn Fish Audio + real LLM each run. Keep the voice subset runnable on demand, not on every micro-iteration.
- **Chat re-entry handshake cost.** Chat-scoped SDK means re-handshake on every chat open; relies on session-resume staying cheap. Validate latency in Phase 3.

## 15. E2E Matrix Reference

Reusable case bodies and new mobile cases are indexed in `agents/docs/testing-knowledge.md` by surface. This matrix is the inline source of truth for this refactor; do not scatter it into separate files.
