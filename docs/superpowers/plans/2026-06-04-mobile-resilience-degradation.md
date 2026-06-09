# Mobile Resilience & Graceful Degradation — spec

- **Date:** 2026-06-04
- **Branch:** `feature/mobile-client`
- **Author:** Kevin Ye (+ Claude)
- **Workflow:** subagent-driven-development (implementer + spec-review + quality-review per task)

## Context

Device testing of the iOS app against a matched-version local gateway surfaced three
classes of failure. Investigation (web-sdk parity study + gateway/overlay trace +
Android audit) showed they are **not** independent bugs but a small set of
architectural gaps:

1. **App freeze (iOS).** A `sessions.list` that returns `sessions.error code=internal`
   throws `SessionsRequestException` out of a `suspend` op. With **no `@Throws`**, that
   exception is **fatal at the Kotlin/Native→Swift (SKIE) boundary** — the existing
   Swift `do/catch` in `HistoryModel` never runs. Android catches the same exception
   fine (`runCatching`, JVM has no bridge gap), so this is iOS-only — but the missing
   contract is a latent SIGABRT for every throwing op.

2. **No TTS / no audio (iOS).** Assistant audio arrives but playback runs through the
   **mic-capable** shared `AVAudioEngine` (`.playAndRecord`/`voiceChat`,
   `SharedAudioEngine.ios.kt`). On a real device **without mic permission** (text+TTS
   chat never prompts), the record IO unit can't initialize → `engine.prepare()`
   asserts → every frame is dropped (`enqueue-no-player`). **Android is already
   decoupled** (`AudioTrack`, no record dependency) — iOS-only.

3. **Session dies on cross-device use (gateway).** Same user on two clients
   (mobile + webui) → the Hermes overlay enforces **one ACP WS per profile** and
   **evicts the prior wire with a clean 1000 close** (`deploy/hermes-overlay/acp_ws_server.py:254-259`).
   The gateway's `ManagedAcpSocket` **latches `cleanClosed=true` on any 1000 close and
   rejects forever** (`gateway/src/hermes-adapter-client/acp-wire-socket.ts:176,245`),
   never reset. The gateway opens **one wire per client WS** (no pooling,
   `ws-session-configure.ts:370`). Net: the 2nd connection silently kills the 1st's
   wire permanently; `cycle.aborted` + `sessions.error code=internal` follow, and
   **`newChat()` does not heal it** (hits the same dead wire).

## Goal

Mirror web-sdk's resilience contract on mobile, extend it where the user asked, and
fix the gateway collision that triggers the worst case:

- **The app never hangs or freezes** on any server error.
- **The gateway tolerates the same user on multiple devices** — no wire eviction, no
  permanent dead-wire latch.
- **A live connection drop auto-reconnects**, with a visible "reconnecting…" → "tap to
  reconnect" affordance (web-sdk parity).
- **A session/cycle error that the client did not cause** surfaces a recoverable
  affordance ("Couldn't get a response — Retry / Start a new chat"), not silence.
- **TTS plays in text-only chat** (no mic permission required) on iOS.

## Non-goals

- New transport (WS stays — pinned). Refine reconnect, don't rewrite.
- Server-initiated heartbeats (battery antipattern — visibility-driven probes only).
- Opus downlink decode (still deferred).
- Multi-active simultaneous voice on two devices (pooled wire shares one Hermes
  session; concurrent full-duplex voice from two devices is out of scope).

## Web-sdk contract being mirrored (reference)

- Sessions error → Promise reject → UI catch → error signal → "Couldn't load — Retry"
  + stale banner. No crash, no reconnect (WS is fine). (`sessions-connector.ts`,
  `use-sessions.ts:101-114`, `drawer.tsx:75-115`)
- WS unexpected close → `forceReconnect()`, exp backoff 1→2→4→8→16s ×5 → `onConnectionLost`
  → "Connection lost. Tap to reconnect" banner. Close **code is ignored**; decision is
  context (consumer-disconnect / idle / unexpected). (`sdk-reconnect.ts`,
  `sdk-close-handler.ts:109-136`, `app.tsx:338-357`)
- Auth terminal → `onAuthExpired` → logout.
- Current session deleted elsewhere → auto `newChat()`. (`use-sessions.ts:50-67`)
- Degradation: dead-WS send → drop + kick reconnect (no hang); playback init fail →
  silent.

Mobile already has the primitives: `ReconnectController` (backoff/terminal states),
`SdkStatus` (6 states), `SdkState.connectionLost` / `.authExpired`. **The gaps are
wiring + UI surfacing + the gateway collision + the iOS audio coupling** — not missing
machinery.

---

## Tasks

### Task 1 — Gateway: pool the ACP wire per user (ref-counted)

**Why:** The gateway opens one ACP wire per client WS; the overlay allows one per
profile and evicts the prior. Pooling one wire per `userId` across PersonSession
attachments removes the second dial → removes eviction. Matches the existing
multi-attachment PersonSession model (`ws-session-configure.ts:174-188`).

**Files:**
- `gateway/src/hermes-adapter-client/wire-bootstrap.ts` (`bootstrapAcpWire`)
- `gateway/src/session-handlers/ws-session-configure.ts:360-370` (the only bootstrap call site)
- `gateway/src/session-handlers/ws-handlers.ts:263` (`acpWireDispose` teardown)
- `gateway/src/hermes-adapter-client/session-attachment-ledger.ts` (re-attach mechanism)

**Change:**
- Introduce a per-`userId` ACP-wire registry (map `userId → { conn, refCount }`).
  `bootstrapAcpWire` for a user with an existing live wire **reuses** it and increments
  refCount instead of dialing a new overlay connection.
- `acpWireDispose` decrements refCount; dispose the underlying `ManagedAcpSocket` **only
  when refCount hits 0** (last attachment detaches). Mirrors PersonSession's
  zero-attachment archive policy.
- Preserve the `SessionAttachmentLedger` re-attach (`session/load` on epoch bump) so a
  newly-attached client syncs the shared session.
- Concurrency: bootstrap is async; guard against two attachments racing the first dial
  (single in-flight dial promise per userId).

**Acceptance:** Two `session.configure` for the same `userId` produce ONE overlay
connection (one `active_ws` at the overlay; no eviction log). Disposing one attachment
keeps the wire alive for the other; disposing the last disposes the wire.
**Unit test (gateway):** wire-registry ref-count — bootstrap×2 same user → one dial;
dispose×1 → wire live; dispose×2 → wire disposed. (Wire/process-boundary contract → keep.)

### Task 2 — Gateway: reconnect on a remote 1000 (drop the permanent latch)

**Why:** Even with pooling, a genuine remote 1000 (overlay restart, transient) must not
permanently strand an active client. The `cleanClosed` latch conflates *remote* 1000
with *local intentional* dispose.

**Files:** `gateway/src/hermes-adapter-client/acp-wire-socket.ts` (close listener
`:138-183`, `cleanClosed` `:176`, `ensureOpen` `:245`, `CLEAN_CLOSED_ERROR` `:112`,
`disposed` flag).

**Change:**
- A 1000 close of the live socket is treated like an abnormal close **unless `dispose()`
  initiated it**: drop the handle, reject in-flight requests, set
  `willReconnectOnNextSend = true`. Remove (or scope) the `cleanClosed` permanent latch
  so it is set ONLY inside `dispose()` (the genuine local-intent path keeps the
  `disposed` rejection — that already exists).
- Lazy reconnect on next `ensureOpen` re-dials; combined with the ledger re-attach the
  session resumes transparently.
- Keep an info log distinguishing remote-1000-reconnect from local dispose.

**Acceptance:** A remote 1000 close followed by a send → re-dials + succeeds (no
`CLEAN_CLOSED_ERROR`). A local `dispose()` → still terminal (`DISPOSED_ERROR`).
**Unit test (gateway):** managed-socket reconnect — inject remote 1000 → next send
reconnects; `dispose()` → next send rejects disposed. (Wire-resilience invariant → keep.)

> Tasks 1+2 together fully resolve the user's repro. Tasks 3–8 are the mobile-side
> resilience that keeps the app correct for *all* server errors (including ones the
> gateway can't prevent), per "never hang or freeze."

### Task 3 — mobile-sdk: `@Throws` on throwing public suspend ops

**Why:** Make the Kotlin→Swift error contract explicit so a thrown SDK exception
bridges to a catchable Swift error instead of SIGABRT. The enabler for graceful
degradation on iOS (Android already catches).

**Files:** `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/sdk/SentientSdk.kt:191-207`.

**Change:** Annotate the ops that can throw with
`@Throws(SessionsRequestException::class, SessionsTimeoutException::class, kotlinx.coroutines.CancellationException::class)`:
`listSessions`, `switchSession`, `newChat`, `deleteSession`, `renameSession`. (Verify
`setTtsEnabled`/`connect` truly can't throw — they currently can't; leave unannotated
unless that changes.) Confirm SKIE surfaces these as Swift `async throws` and the iOS
`do/catch` in `HistoryModel` now actually runs on a thrown error.

**Acceptance:** A forced `sessions.error` no longer crashes iOS — it lands in
`HistoryModel.loadSessions`'s `catch`, sets `error`. Rebuild XCFramework; smoke confirms
no SIGABRT.

### Task 4 — mobile-sdk: surface an unsolicited session/cycle error

**Why:** `cycle.aborted` is overloaded (UI-stop, barge-in, error). Today it silently
returns to IDLE — a wire-death cycle yields no answer and no indication. Surface a
recoverable error state **only** when the client did not initiate the abort.

**Files:**
- `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/sdk/SdkState.kt`
- `shared/mobile-sdk/src/commonMain/.../connectors/InFlightMessageConnector.kt` (`onAborted`, `:83`)
- `shared/mobile-sdk/src/commonMain/.../connectors/CognitionStatusConnector.kt` (`cycle.aborted`, `:51`)
- `shared/mobile-sdk/src/commonMain/.../sdk/StateDeriver.kt` (new slice)
- `shared/mobile-sdk/src/commonMain/.../sdk/SentientSdk.kt` (`interrupt()` `:152`; barge-in is in `AudioPipeline:175`)
- `shared/mobile-sdk/src/commonMain/.../protocol/ServerMessage.kt:60` (`CycleAborted.reason`)

**Change:**
- Add `SdkState.lastCycleError: Boolean = false` (or a small `CycleError?` value with a
  user-facing message). Folded by `StateDeriver`.
- Track **self-initiated termination per cycle**: set a flag when `interrupt()` is called
  or a barge-in onset fires for the active cycle. On `cycle.aborted`: if NOT
  self-initiated (and no committed assistant content for that cycle), set
  `lastCycleError = true`. If self-initiated, clear the flag, leave error unset.
- Cross-check the gateway's abort emission: confirm whether error-aborts carry a
  distinguishable `reason` / a separate error frame; prefer client-side self-initiation
  tracking (independent of gateway reason semantics), use `reason` only as corroboration.
- Clear `lastCycleError` on the next `cycle.started`, a successful cycle, `newChat()`, or
  `switchSession()`.
- Log the decision (`cycle.aborted` self-initiated vs unsolicited) per logging rule.

**Acceptance:** A UI-stop or barge-in abort does NOT set `lastCycleError`. An
unsolicited abort (simulate via a server error frame in a connector test) sets it; the
next cycle clears it.
**Unit test (commonTest):** feed `cycle.started` → `interrupt` → `cycle.aborted` ⇒ no
error; `cycle.started` → `cycle.aborted` (no local interrupt) ⇒ error; then
`cycle.started` ⇒ cleared. (FSM invariant → keep.)

### Task 5 — mobile-sdk (iOS): decouple TTS playback from the mic engine

**Why:** Text-chat TTS must not require mic permission. Use a standalone `.playback`
engine when capture isn't active; reserve the shared `.playAndRecord` engine for voice
mode (where AEC needs the shared render reference).

**Files:**
- `shared/mobile-sdk/src/iosMain/.../audioio/AudioPlaybackAdapter.ios.kt`
- `shared/mobile-sdk/src/iosMain/.../audioio/SharedAudioEngine.ios.kt`
- (new) a playback-only engine/session helper, or a mode flag on the shared holder.

**Change:**
- When playback starts and **capture is not active** (no voice mode / shared engine has
  zero capture users), run playback on a **private `AVAudioEngine` + `.playback`
  AVAudioSession category** — no mic, no permission gate. Selection signal: query the
  shared engine's active-capture state (expose a read-only `hasCapture`/user kind on
  `SharedAudioEngine`) or thread `voiceMode` to the adapter.
- When voice mode IS active, keep the shared `.playAndRecord` engine for full-duplex AEC
  (unchanged path).
- Preserve the NO-CRASH/no-throw ObjC-guard contract (`enginePrepareGuarded` /
  `engineStartGuarded`) on the new engine too. A start failure degrades silently
  (mirrors web-sdk `playback.init().catch`), never SIGABRT.
- Handle the voice-mode-starts-after-TTS edge: acceptable to keep it simple (common
  case is text-chat TTS on the standalone engine, voice on shared) — document the chosen
  behavior; do not regress barge-in/AEC in voice mode.

**Acceptance:** On a real device with mic permission **denied/undetermined**, text-chat
TTS plays (no `start-failed reason=shared engine unavailable`). Voice mode still does
AEC. (Device-verified — sim can't fully exercise the mic-route path.)

### Task 6 — iOS UI: connection-lost banner + reconnect CTA + auth-expired logout

**Files:** `ios/App/SDK/SdkStore.swift` (already exposes `SdkState`), `ios/App/RootView.swift`,
`ios/App/Chat/ChatView.swift`, `ios/App/Auth/AuthModel.swift`.

**Change:**
- Bind `SdkState.connectionLost`: render a banner "Connection lost. **Tap to reconnect**"
  → calls `sdk.forceReconnect()` (add a `SdkStore` passthrough if absent). While
  `status == .reconnecting` show a "Reconnecting…" affordance; disable the composer
  send while `status != .ready` (web-sdk `connectionReady`).
- Bind `SdkState.authExpired` → drive logout (`AuthModel`), mirroring web-sdk
  `authExpired → auth.logout()`.
- No server heartbeat; keep the existing visibility/foreground probe path.

**Acceptance:** Killing the gateway WS shows "Reconnecting…" then "Tap to reconnect" on
exhaustion; tapping reconnects when the gateway is back. Auth-expiry routes to login.

### Task 7 — iOS UI: sessions Retry + cycle-error recovery affordance

**Files:** `ios/App/History/HistorySidePanel.swift` (+ `HistoryModel.swift` already has
`error`), `ios/App/Chat/ChatView.swift` / `ChatPanelAlerts.swift`.

**Change:**
- Sessions list error: render "Couldn't load — **Retry**" (empty) and a stale banner +
  Retry when stale rows exist (web-sdk `drawer.tsx` parity). Retry calls
  `HistoryModel.refresh()`.
- `SdkState.lastCycleError` (Task 4): show an inline, dismissible chat affordance
  "Couldn't get a response — **Retry** · **Start a new chat**". Retry re-sends the last
  user message (or re-dispatches); "Start a new chat" calls `newChat()`. Auto-clears on
  the next cycle.

**Acceptance:** Forced sessions error shows Retry (no dead-end). An unsolicited
cycle-abort shows the recovery row; a normal interrupt/barge-in does NOT.

### Task 8 — Android UI: crash fix + banner + sessions Retry + cycle-error affordance

**Files:**
- `android/src/main/kotlin/io/sentient/android/sdk/SdkViewModel.kt` (`newChat` `:93`,
  `switchSession` `:88`, `setTtsEnabled` `:85`, `connect` `:55`)
- `android/.../MainActivity.kt:165` (chat-screen new-chat wiring)
- `android/.../history/HistoryDrawer.kt` (EMPTY_LOAD_FAIL → Retry)
- chat screen composables for the banner + cycle-error row.

**Change:**
- **Crash fix:** wrap `SdkViewModel.newChat()` (and siblings `switchSession`,
  `setTtsEnabled`, `connect` for defense-in-depth) in `runCatching { … }.onFailure { warn }`.
  Delete or protect dead `switchSession` if unused.
- Connection-lost banner + reconnect CTA bound to `SdkState.connectionLost` /
  `status`, disable composer while `!= READY`; `authExpired` → logout.
- Sessions Retry in the drawer (the VM already sets `error`).
- `lastCycleError` recovery row mirroring iOS Task 7.

**Acceptance:** Chat-screen "new chat" against an erroring gateway no longer crashes
(shows error/recovery). Banner + Retry + recovery row behave as iOS.

### Task 9 — e2e: full matrix, both platforms + manual device pass

Drive Maestro on iOS sim + Android emulator for the simulator-reachable cases; flag the
device-only cases for the manual pass. See the matrix below.

---

## E2E test matrix (inline — required)

| Case | Platform / Device | Pre-state | Action | Expected user-visible | Expected log trail |
|------|-------------------|-----------|--------|------------------------|--------------------|
| R1 sessions-error no-freeze | iOS sim (Maestro) | logged in, chat open | force `sessions.error` (point at gateway returning internal, or stub) → open history | History shows "Couldn't load — Retry"; app responsive | `connector.sessions: reject code=internal`; HistoryModel `load-failed`; **no** "Uncaught Kotlin exception" |
| R2 sessions Retry | iOS sim + Android emu | sessions-error shown | tap Retry after gateway healthy | list loads | `sessions: request` → `resolve`; `loaded count=N` |
| R3 connection-lost banner | iOS sim + Android emu | READY | kill gateway WS | "Reconnecting…" then "Connection lost. Tap to reconnect"; composer disabled | `transport.signal Closed`; `reconnect attempt 1..5`; `exhausted` → `connectionLost=true` |
| R4 tap-to-reconnect | iOS sim + Android emu | connection-lost banner | restart gateway, tap reconnect | returns to READY, composer enabled | `forceReconnect`; `attempt` → `success`; `status READY` |
| R5 cycle-error recovery | iOS sim + Android emu | READY, mid-chat | inject unsolicited `cycle.aborted` (server error frame) | "Couldn't get a response — Retry · Start a new chat" | `inflight: aborted`; `cycle.aborted unsolicited`; `lastCycleError=true` |
| R6 interrupt is NOT an error | iOS sim + Android emu | assistant streaming | tap Stop (interrupt) | stream stops, NO error row | `interrupt`; `cycle.aborted self-initiated`; `lastCycleError` stays false |
| R7 auth-expired logout | iOS sim + Android emu | READY | force terminal auth failure on reconnect | routed to login | `auth-expired-terminal`; `authExpired=true`; logout |
| R8 cross-device wire (gateway) | real iPhone + webui on Mac | iOS chatting vs local gateway | chat on webui (same user, other machine), return to iOS, send | iOS chat keeps working; no freeze; reply arrives | gateway: ONE overlay `active_ws` (no eviction); no `CLEAN_CLOSED_ERROR`; cycle completes |
| R9 TTS in text chat (no mic) | real iPhone (mic denied) | text chat, TTS on | send a message | assistant audio plays; speaking wave animates | `playback.ios session-open category=playback`; no `start-failed shared engine unavailable` |
| R10 voice-mode AEC intact | real iPhone (mic granted) | voice mode on | speak, assistant replies, barge-in | barge-in cuts TTS; no echo | shared `.playAndRecord` path; `barge-in mic-onset-while-speaking` |
| R11 setup-field typing | iOS device | setup page | type host/IP | no perceptible hang after first keystroke | (profile only; system keyboard warm-up if any) |

Cases R8–R11 are **device-only / gateway-integration** — run manually on the physical
iPhone + local Mac stack; not reachable by Maestro-on-sim. R1–R7 are agent-driven.

## Risks / notes

- **Branch scope:** Tasks 1–2 touch gateway TS + (verification of) the Python overlay;
  the rest is mobile. Kept on `feature/mobile-client` because mobile e2e depends on the
  gateway fix. Flag at merge if a split is preferred. (git-workflow: atomic concerns.)
- **Overlay:** the single-`active_ws` rule (`acp_ws_server.py:254-259`) stays — with
  per-user pooling the gateway only ever opens one wire per profile, so eviction never
  triggers. No overlay code change expected; verify the assumption in Task 1 smoke.
- **Local-stack smoke before any pi.** Boot `deploy/macos`, verify R1–R10 against the
  real local stack. No pi deploy without separate explicit approval.
- **Tuned constants** (VAD, echo gate, reconnect backoff) are user-tuned — do not change.
- **Setup typing hang (R11):** likely iOS keyboard first-responder warm-up, not app
  code. Profile; fix only if it's ours.
