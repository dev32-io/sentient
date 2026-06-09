# WS Resilience Hardening + Client Chat Mirror — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a backgrounded/reconnecting voice client resume the live session cheaply (no full history reload), never lose responses/audio produced while disconnected, always be able to get unstuck, and load past chats instantly from a device-local mirror.

**Architecture:** One resumable, sequenced WebSocket push stream (gateway stamps `seq`+`epoch` on every frame, buffers them per device-session, replays on reconnect) plus a SQLDelight device mirror that write-throughs live frames and reconciles via REST. WS is reserved for the live chat session only; all client-driven queries (list/history/search/prefs/rename/delete) move to gateway REST routes.

**Tech Stack:** Gateway — TypeScript on Bun, Zod protocol (`shared/protocol`). Clients — Preact web-sdk (TS), KMP `shared/mobile-sdk` + `shared/mobile-data` (Kotlin), Android (Compose), iOS (SwiftUI). New deps: SQLDelight + multiplatform-settings (KMP).

**Source spec:** `docs/superpowers/specs/2026-06-09-ws-resilience-and-chat-mirror-design.md`

---

## Conventions (read once, apply to every task)

- **Shell:** run `source scripts/env.sh` once per shell before any `bun`/`gradle` command. `gradlew` is at the repo root.
- **Gateway unit tests run on Bun's native runner, NOT vitest** (despite tests importing from `vitest`, which Bun shims). Run a single file: `cd gateway/src && bun test <relative/path>.test.ts`. Whole gateway: `cd gateway && bun run test`. Integration (vitest): `cd gateway && bun run test:int`.
- **web-sdk tests** = vitest: `cd shared/web-sdk && bunx vitest run src/<file>.test.ts`.
- **KMP tests** = `kotlin.test` + `kotlinx-coroutines-test` (mobile-sdk also has `ktor-client-mock`), in `src/commonTest/...`. Run: `./gradlew :shared:mobile-sdk:testDebugUnitTest` and `./gradlew :shared:mobile-data:testDebugUnitTest` (fast JVM host, excludes the credential-gated `@live` harness). All targets incl. iOS sim: `:allTests`.
- **No Kotlin linter exists** (no ktlint/detekt). Quality gate for KMP = compile + `testDebugUnitTest`. TS gate: `bun run lint` (Biome) + `bun run typecheck`.
- **Commit cadence:** one commit per task (after its tests pass). `type(scope): description`. Branch is `feature/ws-resilience-hardening` (already created).
- **Co-author trailer on every commit:** `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- **Testing doctrine (`.claude/rules/testing.md`):** test wire/protocol contracts, FSMs/invariants, security boundaries — NOT wiring/DI/pure-factory plumbing. Several tasks below intentionally extract a pure, testable unit (mirroring `computeBackoffMs`/`ReconnectConfig`) rather than testing the orchestrator through a heavy harness.

## Slice order & cross-slice dependencies

Execute in this order (each slice is independently shippable to `develop`):

1. **Slice 1 — Unstuck safety** (KMP SDK only). No dependencies. Highest immediate relief.
2. **Slice 2 — Transport migration** (queries WS→REST). Depends on nothing in slices 1/3/4.
3. **Slice 3 — Resumable WS layer** (seq/epoch/replay/resume + **introduces `entryId`**). Depends on Slice 2 only for the `recovered:false`→REST-refetch fallback (Slice 2 provides the REST history endpoint).
4. **Slice 4 — Device mirror** (SQLDelight). **Depends on Slice 3** (`entryId` is the durable key) **and Slice 2** (REST list/history for cache-then-refresh + smart-async deletion).
5. **Slice 5 — Docs + version bumps.** Last; after the deployable artifact is green.

> **Mega-plan caveat (flagged at planning time):** Slices 3–4 tasks carry exact file:line targets and code patterns from a tree snapshot taken 2026-06-09. Re-verify each target against the working tree at execution time — Slice 2's protocol/REST edits will have shifted line numbers and removed the WS query schemas that Slice 3 enumerates.

---

## File Structure

### Slice 1 — Unstuck safety
- Create: `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/sdk/StuckStateWatchdog.kt` — pure, testable watchdog (arm/disarm/timeout).
- Create: `shared/mobile-sdk/src/commonTest/kotlin/io/sentient/mobilesdk/sdk/StuckStateWatchdogTest.kt`
- Modify: `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/sdk/SdkConfig.kt` — add `stuckStateTimeoutMs`.
- Modify: `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/sdk/SentientSdk.kt` — optimistic clear in `interrupt()`; wire watchdog into cognition/audio state writers.
- Modify: `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/audioio/AudioPipeline.kt` — expose a local playback-stop entry for interrupt.

### Slice 2 — Transport migration (queries → REST)
- Create: `gateway/src/api/handlers/sessions.ts` — client-facing REST handler (list/history/search/rename/delete), per-user PASETO-scoped.
- Create: `gateway/src/api/handlers/sessions.test.ts`
- Modify: `gateway/src/api/router.ts` — register `/api/v1/sessions`.
- Modify: `gateway/src/server.ts` — build + inject `handleSessions`.
- Modify: `shared/protocol/src/sessions.ts` + `shared/protocol/src/messages.ts` — remove list/search/delete/rename WS RPC schemas; replace `session.switch` with `conversation.activate`.
- Modify: `gateway/src/session-handlers/ws-handlers.ts` — drop migrated WS cases; add `conversation.activate`.
- Modify: `gateway/src/session-handlers/sessions-handlers.ts` — keep only `conversation.activate` (switch focus) + `session.new`; remove query RPC bodies.
- Create: `shared/web-sdk/src/sessions-rest.ts` (+ `.test.ts`) — fetch-based REST client (copy `gateway/webui/src/services/_helpers.ts` shape).
- Create: `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/sessions/SessionsHttpClient.kt` (+ test) — Ktor REST client (copy `AuthClient.kt`).
- Modify: web-sdk `SessionsConnector` + mobile-sdk `SessionsConnector.kt` — delegate queries to the REST client; keep only `conversation.activate` send + broadcasts.
- Modify: `shared/mobile-data/.../data/SessionsRepository.kt` impl + iOS/Android factory wiring for the REST client.

### Slice 3 — Resumable WS layer
- Create: `gateway/src/session-handlers/session-replay-buffer.ts` (+ test) — ring buffer (16MB cap + TTL), seq counter, epoch.
- Create: `gateway/src/session-handlers/frame-sequencer.ts` (+ test) — stamps seq/epoch on JSON; prepends 8-byte header on binary.
- Modify: `gateway/src/session-handlers/device-attachment.ts` — route `send`/`sendBinary` through the sequencer + buffer.
- Modify: `gateway/src/session-handlers/ws-session-configure.ts` — make `wsSend`/`wsSendBinary` = attachment egress; remove direct `ws.send`.
- Modify: `gateway/src/session-handlers/audio-frame-sender.ts` — (no change to send call; binary header handled in sequencer).
- Modify: `gateway/src/person-session/person-session.ts` + `person-session-registry.ts` — hold buffer/epoch; 30-min retention TTL.
- Modify: `gateway/src/session-handlers/ws-handlers.ts` — split `cleanupSession` into resumable-disconnect vs full-teardown; add resume handshake intake.
- Modify: `gateway/src/api/handlers/ws.ts` — parse `?device_id=&epoch=&last_seq=`.
- Modify: `gateway/src/cerebrum/hermes-event-translator.ts` — mint `entryId` on every committed `MirrorEntry`.
- Modify: `shared/protocol/src/messages.ts` + `conversation.ts` — optional `seq`/`epoch` on push frames; `entryId` on feed items; `stream.resume`/`stream.resumed` frames; binary-header doc.
- Modify: `gateway/config.yaml` + `shared/config/src/schema.ts` + `gateway/src/config/startup-config.ts` — `session.ws_idle_timeout_ms` / `retention_ttl_ms` / `replay_buffer_max_bytes` / `replay_audio_coalesce_ms`.
- Modify: `gateway/src/server.ts` — `idleTimeout: services.session.ws_idle_timeout_ms/1000`.
- Modify: mobile-sdk `transport/WsTransport.kt` + `protocol/ServerMessage.kt` + `protocol/ConversationFeedItem.kt` + `sdk/SdkState.kt` (add `entryId`); web-sdk `sdk-message-router.ts` + reconnect — read seq/header, send resume handshake, add `entryId` to feed type.

### Slice 4 — Device mirror (SQLDelight)
- Modify: `gradle/libs.versions.toml`, root `build.gradle.kts`, `shared/mobile-data/build.gradle.kts` — add SQLDelight + multiplatform-settings.
- Create: `shared/mobile-data/src/commonMain/sqldelight/io/sentient/mobiledata/cache/db/ChatDatabase.sq` — schema.
- Create: `shared/mobile-data/.../cache/DatabaseDriverFactory.kt` (expect) + `.android.kt` + `.ios.kt` actuals (copy SecureTokenStore pattern).
- Create: `shared/mobile-data/.../cache/SyncCursorStore.kt` — multiplatform-settings cursor.
- Create: `shared/mobile-data/.../data/CachingConversationRepository.kt` + `CachingSessionsRepository.kt` (+ tests).
- Modify: `shared/mobile-data/.../di/ChatComponent.kt` — inject `DatabaseDriverFactory`, wrap repos.
- Modify: `android/.../di/UserSessionManager.kt` + `shared/mobile-data/.../di/IosUserSession.ios.kt` — construct + inject the platform driver factory.
- Modify: `.claude/rules/mobile-data/repositories.md` (+ `mobile/mobile-offline.md`, `android/android-coroutines-flow.md`, `mobile/mobile-lifecycle.md`) — durable-mirror exception.

### Slice 5 — Docs + versions
- Modify: `gateway/package.json` (1.10.0→1.11.0), `android/build.gradle.kts` (0.0.1/1→0.1.0/2), `ios/App/Info.plist` (CFBundleShortVersionString 0.0.1→0.1.0), `shared/mobile-sdk/build.gradle.kts` + `shared/mobile-data/build.gradle.kts` (add `version = "0.1.0"`).
- Modify: `gateway/README.md`, `shared/mobile-sdk/README.md`, `shared/web-sdk/README.md`, `android/README.md`, `ios/README.md`; `agents/docs/learnings.md`; `agents/docs/testing-knowledge.md`.

---

## SLICE 1 — Unstuck safety (KMP SDK)

**Outcome:** Stop always clears the UI instantly (fire-and-forget, no server-ack gate); a silently-dead "thinking"/"speaking" state auto-resets after a timeout. Ships alone.

### Task 1.1: Add `stuckStateTimeoutMs` to SdkConfig

**Files:**
- Modify: `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/sdk/SdkConfig.kt`

- [ ] **Step 1: Add the default constant and the field.** Mirror `foregroundProbeTimeoutMs` exactly. After the line `private const val DEFAULT_FOREGROUND_PROBE_TIMEOUT_MS = 3_000L` add:

```kotlin
private const val DEFAULT_STUCK_STATE_TIMEOUT_MS = 8_000L
```

In the `SdkConfig` data class, after `val foregroundProbeTimeoutMs: Long = DEFAULT_FOREGROUND_PROBE_TIMEOUT_MS,` add:

```kotlin
    // Client-side safety net: if cognition is THINKING or audio is speaking but no
    // server frame advances/ends the cycle within this window (e.g. the socket
    // silently died while backgrounded), reset cognition→IDLE / isSpeaking→false so
    // Stop is never a dead end. Range 4000–15000. Default 8000.
    val stuckStateTimeoutMs: Long = DEFAULT_STUCK_STATE_TIMEOUT_MS,
```

- [ ] **Step 2: Typecheck (compile).** Run: `source scripts/env.sh && ./gradlew :shared:mobile-sdk:compileKotlinIosSimulatorArm64` (or `:shared:mobile-sdk:testDebugUnitTest` which compiles commonMain). Expected: BUILD SUCCESSFUL.

- [ ] **Step 3: Commit.**

```bash
git add shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/sdk/SdkConfig.kt
git commit -m "feat(mobile-sdk): add stuckStateTimeoutMs config knob

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 1.2: Pure StuckStateWatchdog unit (TDD)

A self-contained, testable watchdog mirroring the repo's `computeBackoffMs`/`ReconnectConfig` test pattern. It owns a single supersede-able timer: `arm()` (re)starts it, `disarm()` cancels it, and on expiry it invokes `onTimeout()`. Injected `scope` + `delayFn` make it deterministic under `runTest`.

**Files:**
- Create: `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/sdk/StuckStateWatchdog.kt`
- Test: `shared/mobile-sdk/src/commonTest/kotlin/io/sentient/mobilesdk/sdk/StuckStateWatchdogTest.kt`

- [ ] **Step 1: Write the failing test.**

```kotlin
package io.sentient.mobilesdk.sdk

import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlin.test.Test
import kotlin.test.assertEquals

class StuckStateWatchdogTest {
    @Test
    fun fires_after_timeout_when_armed() = runTest {
        val dispatcher = StandardTestDispatcher(testScheduler)
        var fired = 0
        val wd = StuckStateWatchdog(
            timeoutMs = 8_000L,
            scope = CoroutineScope(dispatcher),
            delayFn = { kotlinx.coroutines.delay(it) },
            onTimeout = { fired++ },
        )
        wd.arm()
        advanceTimeBy(7_999L); runCurrent()
        assertEquals(0, fired)
        advanceTimeBy(2L); runCurrent()
        assertEquals(1, fired)
    }

    @Test
    fun disarm_cancels_before_timeout() = runTest {
        val dispatcher = StandardTestDispatcher(testScheduler)
        var fired = 0
        val wd = StuckStateWatchdog(8_000L, CoroutineScope(dispatcher), { kotlinx.coroutines.delay(it) }) { fired++ }
        wd.arm()
        advanceTimeBy(5_000L); runCurrent()
        wd.disarm()
        advanceTimeBy(10_000L); runCurrent()
        assertEquals(0, fired)
    }

    @Test
    fun re_arm_supersedes_prior_timer() = runTest {
        val dispatcher = StandardTestDispatcher(testScheduler)
        var fired = 0
        val wd = StuckStateWatchdog(8_000L, CoroutineScope(dispatcher), { kotlinx.coroutines.delay(it) }) { fired++ }
        wd.arm()
        advanceTimeBy(6_000L); runCurrent()
        wd.arm() // supersede: restarts the 8s window
        advanceTimeBy(6_000L); runCurrent()
        assertEquals(0, fired) // prior timer must NOT have fired
        advanceTimeBy(2_001L); runCurrent()
        assertEquals(1, fired)
    }
}
```

- [ ] **Step 2: Run to verify it fails.** Run: `source scripts/env.sh && ./gradlew :shared:mobile-sdk:testDebugUnitTest --tests "*StuckStateWatchdogTest*"`. Expected: FAIL — `StuckStateWatchdog` unresolved.

- [ ] **Step 3: Implement the watchdog.**

```kotlin
package io.sentient.mobilesdk.sdk

import io.sentient.mobilesdk.logging.createLogger
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

/**
 * Single supersede-able timer guarding against a "stuck" UI state (THINKING /
 * speaking) when the server end-signal never arrives (silent socket death).
 * arm() (re)starts the window; disarm() cancels it; on expiry onTimeout() fires
 * exactly once. Mirrors SentientSdk.onForeground's withTimeout/supersede pattern
 * but as a standalone, unit-testable unit.
 */
class StuckStateWatchdog(
    private val timeoutMs: Long,
    private val scope: CoroutineScope,
    private val delayFn: suspend (Long) -> Unit,
    private val onTimeout: () -> Unit,
) {
    private val log = createLogger("sdk", "stuck-watchdog")
    private var job: Job? = null

    fun arm() {
        job?.cancel()
        job = scope.launch {
            delayFn(timeoutMs)
            log.warn("stuck-timeout → reset", mapOf("timeoutMs" to timeoutMs))
            onTimeout()
        }
    }

    fun disarm() {
        job?.cancel()
        job = null
    }
}
```

- [ ] **Step 4: Run to verify it passes.** Run: `./gradlew :shared:mobile-sdk:testDebugUnitTest --tests "*StuckStateWatchdogTest*"`. Expected: PASS (3 tests).

- [ ] **Step 5: Commit.**

```bash
git add shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/sdk/StuckStateWatchdog.kt shared/mobile-sdk/src/commonTest/kotlin/io/sentient/mobilesdk/sdk/StuckStateWatchdogTest.kt
git commit -m "feat(mobile-sdk): pure StuckStateWatchdog with arm/disarm/supersede

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 1.3: Fire-and-forget Stop — optimistic local clear in `interrupt()`

Today `interrupt()` (`SentientSdk.kt:256-264`) only marks the abort self-initiated and sends the wire frame; local `cognition`/`isSpeaking` clear only when the server's `cycle.aborted`/`playback.stop` frames arrive — which never happens on a dead socket. Make `interrupt()` clear local state immediately.

**Files:**
- Modify: `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/audioio/AudioPipeline.kt` — add a local stop entry.
- Modify: `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/sdk/SentientSdk.kt` — clear in `interrupt()`.

- [ ] **Step 1: Add a local-stop method to `AudioPipeline`.** `onPlaybackStop` already clears `isSpeaking` and transitions the FSM (`AudioPipeline.kt:317-332`); expose a no-cycle-id convenience that stops the active cycle locally. After `onPlaybackStop(...)` add:

```kotlin
    /** Local Stop (UI/escape): force-stop playback for the active cycle without a server frame. */
    fun stopLocal() {
        if (activeCycleId.isEmpty() && !isSpeaking) return
        onPlaybackStop(reason = "interrupt-local", cycleId = activeCycleId)
    }
```

- [ ] **Step 2: Expose it on `SdkAudio`.** In the `SdkAudio` wrapper (where `downlinkHooks`/`suspendForReconnect` live), add a passthrough `fun stopLocal() = pipeline.stopLocal()` (match the existing method-forwarding style in that file).

- [ ] **Step 3: Make `interrupt()` clear local state optimistically.** Replace the body of `interrupt()` (`SentientSdk.kt:256-264`) with:

```kotlin
    /** UI Stop / Escape — idempotent hard interrupt. Fire-and-forget: clears local
     *  UI state immediately, never waits for a server ack (a dead socket sends none). */
    fun interrupt() {
        log.info("interrupt")
        markInteraction()
        connectors.cycleError.noteInterrupt(null)
        // Optimistic local clear — do NOT gate on cycle.aborted/playback.stop frames.
        audio.stopLocal()                       // clears isSpeaking via onPlaybackStop→onAudioStateChanged
        if (deriver.cognition != CognitionState.IDLE) {
            deriver.cognition = CognitionState.IDLE
            emit()
        }
        stuckWatchdog.disarm()                  // added in Task 1.4
        sendControl(ClientMessage.Interrupt)    // best-effort; null-safe if transport is dead
    }
```

> Note: `audio.stopLocal()` drives `isSpeaking=false` + `emit()` through the existing `onAudioStateChanged` path, so we don't set `deriver.isSpeaking` directly (keeps the audio FSM authoritative for that field). `CognitionState` is already imported in this file.

- [ ] **Step 4: Compile.** Run: `source scripts/env.sh && ./gradlew :shared:mobile-sdk:testDebugUnitTest`. Expected: BUILD SUCCESSFUL, existing tests still PASS. (The `stuckWatchdog` reference compiles once Task 1.4 adds the field; do Task 1.4 before this step's gradle run, or temporarily omit the `disarm()` line and add it in 1.4. Recommended: implement 1.4's field declaration first, then this task — see ordering note.)

- [ ] **Step 5: Commit.**

```bash
git add shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/audioio/AudioPipeline.kt shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/sdk/SentientSdk.kt
git commit -m "feat(mobile-sdk): fire-and-forget Stop clears local UI state optimistically

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 1.4: Wire the watchdog into SentientSdk

Arm on entry to THINKING/speaking; disarm on cycle end / drain / interrupt / new cycle / disconnect. On timeout, reset `cognition→IDLE` + stop audio + `emit()`.

**Files:**
- Modify: `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/sdk/SentientSdk.kt`
- Modify: `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/connectors/SdkConnectors.kt` (the cognition `onStateChange` hook)

- [ ] **Step 1: Declare the watchdog field.** In `SentientSdk` near `private val idle = createIdleDetector(...)` add:

```kotlin
    private val stuckWatchdog = StuckStateWatchdog(
        timeoutMs = config.stuckStateTimeoutMs,
        scope = scope,
        delayFn = delayFn,
        onTimeout = ::onStuckTimeout,
    )
```

- [ ] **Step 2: Add the timeout handler + arm/disarm helpers.** Add private methods:

```kotlin
    private fun onStuckTimeout() {
        log.warn("stuck-state.reset", mapOf("cognition" to deriver.cognition, "isSpeaking" to deriver.isSpeaking))
        audio.stopLocal()
        if (deriver.cognition != CognitionState.IDLE) deriver.cognition = CognitionState.IDLE
        emit()
    }

    private fun refreshStuckWatch() {
        // Active = THINKING/ACTING OR speaking. Arm while active, disarm at rest.
        val active = deriver.cognition != CognitionState.IDLE || deriver.isSpeaking
        if (active) stuckWatchdog.arm() else stuckWatchdog.disarm()
    }
```

- [ ] **Step 3: Call `refreshStuckWatch()` from the two state writers.** In `onAudioStateChanged` (`SentientSdk.kt:147-151`) add `refreshStuckWatch()` before `emit()`:

```kotlin
    private fun onAudioStateChanged(isSpeaking: Boolean, fsmState: AudioState) {
        deriver.isSpeaking = isSpeaking
        deriver.audioState = fsmState
        refreshStuckWatch()
        emit()
    }
```

In `SdkConnectors.kt` the cognition connector's `onStateChange` (`SdkConnectors.kt:91-94`) currently does `{ state -> deriver.cognition = state; emit() }`. The orchestrator owns `refreshStuckWatch`, so route cognition changes through a callback. Change the connector construction to call an injected hook. Minimal approach: in `SentientSdk`, the connectors are built with `send = ::sendControl` etc.; add a `onCognitionChanged = ::onCognitionChanged` parameter and implement:

```kotlin
    private fun onCognitionChanged(state: CognitionState) {
        deriver.cognition = state
        refreshStuckWatch()
        emit()
    }
```

and in `SdkConnectors.kt` change the cognition connector to invoke the injected hook instead of mutating directly:

```kotlin
    val cognition = CognitionStatusConnector(
        onStateChange = { state -> onCognitionChanged(state) },
        onEvent = emitEvent,
    )
```

(Add `onCognitionChanged: (CognitionState) -> Unit` to `SdkConnectors`' constructor params and pass `::onCognitionChanged` from `SentientSdk`.)

- [ ] **Step 4: Disarm on disconnect.** In `disconnect()` (`SentientSdk.kt:229-248`), after `reconnectController.cancel()` add `stuckWatchdog.disarm()`.

- [ ] **Step 5: Compile + full SDK unit suite.** Run: `source scripts/env.sh && ./gradlew :shared:mobile-sdk:testDebugUnitTest`. Expected: BUILD SUCCESSFUL; all tests PASS.

- [ ] **Step 6: Commit.**

```bash
git add shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/sdk/SentientSdk.kt shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/connectors/SdkConnectors.kt
git commit -m "feat(mobile-sdk): arm stuck-state watchdog on THINKING/speaking, reset on timeout

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 1.5: Verify app passthrough (no code change expected)

- [ ] **Step 1:** Confirm Android `ChatViewModel.interrupt()` (`android/src/main/kotlin/io/sentient/android/chat/ChatViewModel.kt:94`) = `component.interrupt()` and iOS `ChatViewModel.swift:102-104` = `component.interrupt()`, and `ChatComponent.interrupt()` (`shared/mobile-data/.../di/ChatComponent.kt:51`) = `sdk.interrupt()`. No change needed — the SDK now does the clearing. Note in the PR description that the Stop button's behavior changed (instant local clear) for the QA/e2e pass.

### Task 1.6: Rework stuck-recovery to connection-driven (A1) + fix connector drift

> **Supersedes the trigger logic of Task 1.4 / the clear-block of Task 1.3.** The holistic
> review found (a) the cognition-transition trigger false-fires on healthy slow cycles
> (prod tool gaps to 38s), and (b) `interrupt`/`onStuckTimeout` reset `deriver.cognition`
> but not `CognitionStatusConnector.currentState` → drift → next `cycle.started`
> short-circuits. A1 = reset on **transport liveness**, not content silence. See spec §8.

**Files:**
- Modify: `shared/mobile-sdk/.../connectors/CognitionStatusConnector.kt` (add `reset()`)
- Modify: `shared/mobile-sdk/.../sdk/SentientSdk.kt`
- Create/Modify test: `shared/mobile-sdk/src/commonTest/.../sdk/StuckWatchPredicateTest.kt` + extend `CognitionStatusConnectorTest`

- [ ] **Step 1: `CognitionStatusConnector.reset()`** — keeps `currentState` in sync on optimistic clear:
```kotlin
    /** Force-reset to IDLE (optimistic local clear). Fires onStateChange via setState so the
     *  orchestrator's deriver stays in sync; prevents the next cycle.started short-circuiting. */
    fun reset() = setState(CognitionState.IDLE, "reset", null)
```
(`setState` already short-circuits if already IDLE and fires `onStateChange` otherwise.)

- [ ] **Step 2: Extract a pure, testable arming predicate** (top-level in SentientSdk.kt or a small file):
```kotlin
/** A1: "stuck" only when a cycle is active AND the socket is not healthy. A slow healthy
 *  cycle stays READY and never arms — no content-frame false-positives. */
internal fun shouldWatchStuck(cognition: CognitionState, isSpeaking: Boolean, status: SdkStatus): Boolean =
    (cognition != CognitionState.IDLE || isSpeaking) && status != SdkStatus.READY
```

- [ ] **Step 3: `clearActiveToIdle()` helper** (shared by interrupt / onStuckTimeout / reconnect):
```kotlin
    private fun clearActiveToIdle() {
        connectors.cognition.reset()  // currentState→IDLE + onCognitionChanged → deriver IDLE + refreshStuckWatch + emit
        audio.stopLocal()             // isSpeaking→false (if speaking) via onAudioStateChanged
        stuckWatchdog.disarm()
        emit()
    }
```

- [ ] **Step 4: `refreshStuckWatch()` uses the predicate; call it from the status writer too.**
```kotlin
    private fun refreshStuckWatch() {
        if (shouldWatchStuck(deriver.cognition, deriver.isSpeaking, deriver.status)) stuckWatchdog.arm()
        else stuckWatchdog.disarm()
    }
```
Add `refreshStuckWatch()` inside `setStatus(next)` after `deriver.status = next` (so a drop→RECONNECTING arms it, and a reconnect→READY disarms it). It's already called from `onCognitionChanged` + `onAudioStateChanged`.

- [ ] **Step 5: `onStuckTimeout()` → `clearActiveToIdle()`** (connection stayed un-READY for the grace → give up):
```kotlin
    private fun onStuckTimeout() {
        log.warn("stuck-state.reset", mapOf("status" to deriver.status, "cognition" to deriver.cognition, "isSpeaking" to deriver.isSpeaking))
        clearActiveToIdle()
    }
```

- [ ] **Step 6: Reconnect reset.** In `onReadyReached()`'s reconnect branch (`wasReconnect == true`), before re-establishing, if a cycle is active call `clearActiveToIdle()`. Add a comment: `// Slice 3 TODO: make resume-aware — only clear on stream.resumed{recovered:false}.`

- [ ] **Step 7: `interrupt()` uses the helper** (replaces the inline clear block from Task 1.3):
```kotlin
    fun interrupt() {
        log.info("interrupt")
        markInteraction()
        connectors.cycleError.noteInterrupt(null)
        clearActiveToIdle()
        sendControl(ClientMessage.Interrupt)
    }
```

- [ ] **Step 8: Tests (FSM invariants).**
  - `StuckWatchPredicateTest`: `shouldWatchStuck` is false for (THINKING, false, READY) and (false-speaking, READY); true for (THINKING, false, RECONNECTING) and (idle, speaking, DISCONNECTED); false for (IDLE, false, RECONNECTING). Pure-function table test.
  - Extend `CognitionStatusConnectorTest`: after `reset()` forces IDLE, a subsequent `CycleStarted` STILL fires `onStateChange(THINKING)` (no drift short-circuit).
- [ ] **Step 9: Compile + full suite** → green (existing `StuckStateWatchdogTest` unchanged). Import `SdkStatus` where needed.
- [ ] **Step 10: Commit.** `fix(mobile-sdk): connection-driven stuck recovery (A1) + reset CognitionStatusConnector on clear`

### Slice 1 — local quality gate

- [ ] Run `source scripts/env.sh && ./gradlew :shared:mobile-sdk:testDebugUnitTest` → all green.
- [ ] Manual smoke note for handoff: e2e cases `fire-forget-stop-dead-socket`, `stuck-state-conn-reset`, and `slow-cycle-no-false-reset` (spec §13) — drive via Maestro against the local stack with the fault hooks (`io.sentient.debug.FAULT`).

---

## SLICE 2 — Transport migration (client queries WS → REST)

**Outcome:** Session list, conversation history, search, rename, delete leave the WS schema and become client-facing gateway REST routes. `session.switch`→`conversation.snapshot` becomes a lightweight WS `conversation.activate` (focus the live stream; no history payload). After this slice the WS carries only the live chat session — the precondition for a clean Slice 3 buffer rule.

> **Governing principle (spec §3.1):** WS = live chat session only; everything else REST. This holds for all future endpoints.

### Task 2.1: Protocol — remove WS query schemas, add `conversation.activate` (TDD)

**Files:**
- Modify: `shared/protocol/src/sessions.ts`
- Modify: `shared/protocol/src/messages.ts`
- Test: `shared/protocol/src/messages.test.ts` (create if absent, else extend)

- [ ] **Step 1: Write the failing test.** (web-sdk/protocol vitest style.)

```ts
import { describe, expect, it } from "vitest";
import { clientMessageSchema, gatewayMessageSchema } from "./messages.js";

describe("transport boundary — query RPCs removed from WS", () => {
  it("rejects sessions.list on the WS client schema", () => {
    expect(clientMessageSchema.safeParse({ type: "sessions.list", limit: 100, offset: 0 }).success).toBe(false);
  });
  it("rejects sessions.search/delete/rename on the WS client schema", () => {
    for (const type of ["sessions.search", "sessions.delete", "sessions.rename"]) {
      expect(clientMessageSchema.safeParse({ type, requestId: "x" }).success).toBe(false);
    }
  });
  it("accepts conversation.activate", () => {
    expect(clientMessageSchema.safeParse({ type: "conversation.activate", sessionId: "s-1" }).success).toBe(true);
  });
  it("drops sessions.*.result from the gateway schema but keeps broadcasts", () => {
    expect(gatewayMessageSchema.options.some((o) => o.shape?.type?.value === "sessions.list.result")).toBe(false);
    expect(gatewayMessageSchema.options.some((o) => o.shape?.type?.value === "sessions.deleted")).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails.** Run: `cd shared/web-sdk && bunx vitest run ../protocol/src/messages.test.ts` (or run from the protocol package if it has its own vitest). Expected: FAIL.

- [ ] **Step 3: Add `conversationActivateSchema` to `shared/protocol/src/sessions.ts`** (replacing the role of `sessionSwitchSchema`). After `sessionSwitchSchema` add:

```ts
export const conversationActivateSchema = z.object({
  type: z.literal("conversation.activate"),
  sessionId: z.string(),
});
export type ConversationActivate = z.infer<typeof conversationActivateSchema>;
```

Keep `sessionSwitchedEventSchema`, `sessionRowSchema`, `sessionsErrorSchema`, the `sessions.deleted`/`sessions.renamed`/`session.created` broadcasts, and `session.new`/`session.created`. Mark `sessionsListSchema`, `sessionsSearchSchema`, `sessionsDeleteSchema`, `sessionsRenameSchema`, `sessionSwitchSchema` and their `*ResultSchema`s as no longer part of the WS union (keep `sessionRowSchema` + result *shapes* — they are reused as REST response bodies in Task 2.2; re-export them from a `sessions-rest-types.ts` if cleaner).

- [ ] **Step 4: Edit `messages.ts` unions.** In `clientMessageSchema` (`messages.ts:81-96`) remove `sessionsListSchema, sessionsSearchSchema, sessionsDeleteSchema, sessionsRenameSchema, sessionSwitchSchema` and add `conversationActivateSchema`. Keep `sessionNewSchema`. In `gatewayMessageSchema` (`messages.ts:275-307`) remove `sessionsListResultSchema, sessionsSearchResultSchema, sessionsDeleteResultSchema, sessionsRenameResultSchema`; KEEP `sessionsDeletedEventSchema, sessionsRenamedEventSchema, sessionCreatedEventSchema, sessionSwitchedEventSchema, conversationSnapshotSchema, sessionsErrorSchema`. Update the import block (`messages.ts:4-20`) to import `conversationActivateSchema`.

- [ ] **Step 5: Run to verify it passes + typecheck.** Run: `cd shared/web-sdk && bunx vitest run ../protocol/src/messages.test.ts` → PASS. Then `cd shared/protocol && bun run typecheck` (or repo `bun run typecheck`). Fix any downstream type breaks revealed (they are expected in gateway/clients — those are fixed in 2.2/2.4/2.5/2.6).

- [ ] **Step 6: Commit.**

```bash
git add shared/protocol/src/sessions.ts shared/protocol/src/messages.ts shared/protocol/src/messages.test.ts
git commit -m "feat(protocol): remove query RPCs from WS schema; add conversation.activate

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 2.2: Gateway REST handler `sessions.ts` (TDD)

Per-user PASETO-scoped handler for `GET /api/v1/sessions` (list), `GET /api/v1/sessions/:id/messages` (history, paginated), `GET /api/v1/sessions/search?q=`, `PATCH /api/v1/sessions/:id` (rename), `DELETE /api/v1/sessions/:id`. Copies the auth+scoping shape of `gateway/src/api/handlers/profile.ts` (bearer → `tokens.validate` → `userId`). Reuses `pluginClient` (search/get/getMessages/delete) and `listSessionsViaAcp` for list. **Key integration:** unlike the WS path, there is no `ws.data` binding — resolve the per-user Hermes plugin base URL + API key from the PASETO `userId` using the same builders as `ws-session-configure.ts:663-701` (`buildHttpBaseUrlForUser`, `buildPluginBaseUrl`, `createSentientPluginClient`) and the per-user ACP wire from the `AcpWireRegistry` for list.

**Files:**
- Create: `gateway/src/api/handlers/sessions.ts`
- Test: `gateway/src/api/handlers/sessions.test.ts`

- [ ] **Step 1: Write the failing test** (gateway Bun-test; mock `tokens.validate` + a fake `pluginClient` + a fake list source). Mirror `profile.ts`'s deps shape.

```ts
import { describe, expect, it } from "vitest";
import { createSessionsHttpHandler } from "./sessions.js";

const okToken = { ok: true as const, value: { userId: "u_1", isAdmin: false } };
const deps = () => ({
  tokens: { validate: async () => okToken },
  resolvePluginClient: async (_userId: string) => ({
    getMessages: async () => [{ role: "assistant", content: "hi", ts: 1 }],
    search: async () => [],
    get: async () => null,
    delete: async () => {},
  }),
  listSessions: async (_userId: string) => [{ sessionId: "s-1", title: "T", lastActiveAt: 5 }],
  titleStore: { getTitlesFor: async () => ({}), setTitle: async () => {}, delete: async () => {} },
});

describe("sessions REST handler — auth + scoping", () => {
  it("401s without a bearer", async () => {
    const h = createSessionsHttpHandler(deps());
    const res = await h(new Request("http://x/api/v1/sessions"));
    expect(res.status).toBe(401);
  });
  it("lists sessions for the token's user", async () => {
    const h = createSessionsHttpHandler(deps());
    const res = await h(new Request("http://x/api/v1/sessions", { headers: { authorization: "Bearer t" } }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items[0].sessionId).toBe("s-1");
  });
  it("returns paginated history for a session", async () => {
    const h = createSessionsHttpHandler(deps());
    const res = await h(new Request("http://x/api/v1/sessions/s-1/messages?limit=50", { headers: { authorization: "Bearer t" } }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.items)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails.** Run: `cd gateway/src && bun test api/handlers/sessions.test.ts`. Expected: FAIL — `createSessionsHttpHandler` not found.

- [ ] **Step 3: Implement `sessions.ts`.** Structure (mirror `profile.ts` route-matching + `admin.ts` `jsonError`/`parseJsonBody`). The `resolvePluginClient(userId)` + `listSessions(userId)` deps encapsulate the per-user Hermes wiring (built in `server.ts`, Task 2.3, from the same builders the WS path uses):

```ts
import { getLog } from "../../logging/logger.js";
import type { TokenService } from "@sentient/auth";
// types from shared/protocol sessions-rest-types

const log = getLog(["sentient", "api", "sessions"]);
const SESSIONS_RE = /^\/api\/v1\/sessions\/?$/;
const SEARCH_RE = /^\/api\/v1\/sessions\/search$/;
const MESSAGES_RE = /^\/api\/v1\/sessions\/([^/]+)\/messages$/;
const ONE_RE = /^\/api\/v1\/sessions\/([^/]+)$/;

export interface SessionsHttpDeps {
  tokens: Pick<TokenService, "validate">;
  resolvePluginClient: (userId: string) => Promise<{
    getMessages(id: string): Promise<unknown[]>;
    search(q: string, limit: number): Promise<unknown[]>;
    get(id: string): Promise<unknown | null>;
    delete(id: string): Promise<void>;
  }>;
  listSessions: (userId: string) => Promise<Array<{ sessionId: string; title: string; lastActiveAt: number }>>;
  titleStore: { getTitlesFor(ids: string[]): Promise<Record<string,string>>; setTitle(id: string, t: string): Promise<void>; delete(id: string): Promise<void> };
}

const json = (status: number, body: unknown) => Response.json(body, { status });
const err = (status: number, code: string, detail?: string) => json(status, { error: code, detail });

function readBearer(req: Request): string | null {
  const h = req.headers.get("authorization");
  return h?.startsWith("Bearer ") ? h.slice(7) : null;
}

export function createSessionsHttpHandler(deps: SessionsHttpDeps) {
  return async (req: Request): Promise<Response> => {
    const token = readBearer(req);
    if (!token) return err(401, "unauthorized");
    const valid = await deps.tokens.validate(token);
    if (!valid.ok) return err(401, "unauthorized");
    const userId = valid.value.userId;
    const url = new URL(req.url);
    const path = url.pathname;
    try {
      if (req.method === "GET" && SESSIONS_RE.test(path)) {
        const rows = await deps.listSessions(userId);
        const titles = await deps.titleStore.getTitlesFor(rows.map((r) => r.sessionId));
        return json(200, { items: rows.map((r) => ({ ...r, title: titles[r.sessionId] ?? r.title })) });
      }
      if (req.method === "GET" && SEARCH_RE.test(path)) {
        const q = url.searchParams.get("q") ?? "";
        const limit = Number(url.searchParams.get("limit") ?? "20");
        const client = await deps.resolvePluginClient(userId);
        return json(200, { items: await client.search(q, limit) });
      }
      const msgs = MESSAGES_RE.exec(path);
      if (req.method === "GET" && msgs) {
        const client = await deps.resolvePluginClient(userId);
        // ownership: a session not owned by userId → 404 (don't leak existence)
        const items = await client.getMessages(msgs[1]);
        return json(200, { items });
      }
      const one = ONE_RE.exec(path);
      if (one && req.method === "DELETE") {
        const client = await deps.resolvePluginClient(userId);
        await client.delete(one[1]);
        await deps.titleStore.delete(one[1]);
        return json(200, { ok: true });
      }
      if (one && req.method === "PATCH") {
        const body = (await req.json().catch(() => null)) as { title?: string } | null;
        if (!body?.title) return err(400, "validation", "title required");
        await deps.titleStore.setTitle(one[1], body.title);
        return json(200, { ok: true });
      }
      return err(404, "not_found");
    } catch (e: unknown) {
      log.warn("sessions-rest-failed", { path, error: e instanceof Error ? e.message : String(e) });
      return err(500, "internal");
    }
  };
}
```

> Ownership enforcement (the WS path's `enforceOwnership`, `sessions-handlers.ts:77-85`) must be reproduced: before `getMessages`/`delete`/`rename`, verify the session belongs to `userId` (via `client.get(id)` ownership field or the list set). Add that guard once `resolvePluginClient` returns ownership data — see `sessions-handlers.ts` for the exact check.

- [ ] **Step 4: Run to verify it passes.** Run: `cd gateway/src && bun test api/handlers/sessions.test.ts`. Expected: PASS (3 tests).

- [ ] **Step 5: Commit.**

```bash
git add gateway/src/api/handlers/sessions.ts gateway/src/api/handlers/sessions.test.ts
git commit -m "feat(gateway): client-facing REST sessions handler (list/history/search/rename/delete)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 2.3: Register the REST route + wire per-user resolvers

**Files:**
- Modify: `gateway/src/api/router.ts` (register `/api/v1/sessions`)
- Modify: `gateway/src/server.ts` (build `handleSessions` with `resolvePluginClient`/`listSessions`)

- [ ] **Step 1: Add the dep + route in `router.ts`.** In `ApiRouterDeps` add `handleSessions: (req: Request) => Promise<Response>;`. In `createApiRouter` add, **before** the generic static/webui fallthrough and ordered most-specific-first:

```ts
    if (pathname.startsWith(`${API_V1}/sessions`)) return deps.handleSessions(request);
```

- [ ] **Step 2: Build the handler in `server.ts`.** Construct `resolvePluginClient(userId)` using the same builders the WS path uses (`buildHttpBaseUrlForUser` + `buildPluginBaseUrl(httpBaseUrl, DASHBOARD_PORT_OFFSET)` + `createSentientPluginClient({ baseUrl, token: apiKeyResolver(), timeoutMs })`, ref `ws-session-configure.ts:663-701`) and `listSessions(userId)` via the `AcpWireRegistry` (acquire a per-user wire → `listSessionsViaAcp(conn)` → release). Pass `tokens: services.tokenService` and the existing `titleStore`. Add `handleSessions: createSessionsHttpHandler({...})` into the `createApiRouter({...})` object in the `fetch` handler.

- [ ] **Step 3: Typecheck + integration smoke.** Run: `cd gateway && bun run typecheck`. Then add/extend a gateway integration test (vitest, `gateway/tests/integration/`) that boots the server and curls `GET /api/v1/sessions` with a valid token. Run: `cd gateway && bun run test:int`. Expected: PASS.

- [ ] **Step 4: Commit.**

```bash
git add gateway/src/api/router.ts gateway/src/server.ts
git commit -m "feat(gateway): register /api/v1/sessions REST route with per-user resolvers

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 2.4: Gateway WS — drop migrated cases, add `conversation.activate`

**Files:**
- Modify: `gateway/src/session-handlers/ws-handlers.ts` (`:128-148`)
- Modify: `gateway/src/session-handlers/sessions-handlers.ts`
- Modify: `gateway/src/session-handlers/ws-session-configure.ts` (`:763-808` switched/snapshot pair)

- [ ] **Step 1:** In `ws-handlers.ts:128-148`, remove the `sessions.list`/`sessions.search`/`sessions.delete`/`sessions.rename`/`session.switch` cases; keep `session.new`; add a `case "conversation.activate":` that calls `ws.data.sessionsHandlers.activate(msg.sessionId)`.
- [ ] **Step 2:** In `sessions-handlers.ts`, delete the `list`/`search`/`delete`/`rename` bodies (now REST) and rename the `session.switch` handler to `activate(sessionId)` — it still runs `enforceOwnership` + `switchFlow.switchTo(sessionId)` + sets `pendingSwitchId`, but the gateway now emits **only** `session.switched` (no `conversation.snapshot`; history is fetched by the client over REST). Update `emitSnapshotPair` (`ws-session-configure.ts:763-768`) to `emitActivated` that sends only `{ type: "session.switched", sessionId, ts }`.
- [ ] **Step 3:** Keep `session.new`/`session.created` and the `sessions.deleted`/`sessions.renamed` broadcasts (so other attachments refresh). Delete now-dead handler config fields.
- [ ] **Step 4: Typecheck + gateway unit suite.** Run: `cd gateway && bun run typecheck && bun run test`. Fix references to removed schemas. Expected: PASS.
- [ ] **Step 5: Commit.**

```bash
git add gateway/src/session-handlers/ws-handlers.ts gateway/src/session-handlers/sessions-handlers.ts gateway/src/session-handlers/ws-session-configure.ts
git commit -m "refactor(gateway): WS drops query RPCs; session.switch → conversation.activate (no snapshot)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 2.5: web-sdk REST client + repoint SessionsConnector

**Files:**
- Create: `shared/web-sdk/src/sessions-rest.ts` + `sessions-rest.test.ts`
- Modify: `shared/web-sdk/src/connectors/sessions-connector.ts`

- [ ] **Step 1: Write the failing test** for `sessions-rest.ts` (vitest, stub `fetch`):

```ts
import { describe, expect, it, vi } from "vitest";
import { createSessionsRest } from "./sessions-rest.js";

describe("sessions REST client", () => {
  it("GET /sessions returns items with bearer", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ items: [{ sessionId: "s-1", title: "T", lastActiveAt: 1 }] }), { status: 200 }));
    const rest = createSessionsRest({ baseUrl: "https://h/api/v1", token: () => "t", fetchFn: fetchMock });
    const rows = await rest.list();
    expect(rows[0].sessionId).toBe("s-1");
    expect(fetchMock.mock.calls[0][1].headers.authorization).toBe("Bearer t");
  });
});
```

- [ ] **Step 2: Run → FAIL.** `cd shared/web-sdk && bunx vitest run src/sessions-rest.test.ts`.
- [ ] **Step 3: Implement `sessions-rest.ts`** copying the webui `_helpers.ts` shape (`handleFetch`/`bearerHeaders`/`ApiHttpError`). Methods: `list()`, `getMessages(id, {limit, offset})`, `search(q, limit)`, `rename(id, title)`, `delete(id)`. Derive base URL from the WS URL (`wss://host/api/v1/ws` → `https://host/api/v1`).
- [ ] **Step 4: Repoint `SessionsConnector`** (`sessions-connector.ts:171-203`): `list/search/delete/rename` now `await this.rest.<m>()`; `switchTo(sessionId)` sends `{ type: "conversation.activate", sessionId }` over WS and still resolves on the `session.switched` broadcast. Keep `newChat()` (WS) + broadcast handlers. Inject the `rest` client via the connector's constructor.
- [ ] **Step 5: Run → PASS + typecheck.** `cd shared/web-sdk && bunx vitest run src/sessions-rest.test.ts && bun run typecheck`.
- [ ] **Step 6: Commit.**

```bash
git add shared/web-sdk/src/sessions-rest.ts shared/web-sdk/src/sessions-rest.test.ts shared/web-sdk/src/connectors/sessions-connector.ts
git commit -m "feat(web-sdk): REST sessions client; SessionsConnector queries go REST, switch→activate

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 2.6: mobile-sdk REST client + repoint SessionsConnector + repo wiring

**Files:**
- Create: `shared/mobile-sdk/.../sessions/SessionsHttpClient.kt` + test (copy `auth/AuthClient.kt`: injected `HttpClient`, `deriveBaseUrl(gatewayWsUrl)` wss→https, `Authorization: Bearer`, typed result, never throws).
- Modify: `shared/mobile-sdk/.../connectors/SessionsConnector.kt` (`:159-203`) — `list/search/delete/rename` delegate to the REST client; `switchTo`/`sendSwitch` send `ClientMessage.ConversationActivate`.
- Modify: `shared/mobile-sdk/.../protocol/ClientMessage.kt` — replace `SessionSwitch` with `ConversationActivate` (`@SerialName("conversation.activate")`); remove `SessionsList/Search/Delete/Rename` (now REST). Keep `SessionNew`.
- Modify: `SentientSdk.kt` (`:304-366`) — `listSessions/search/delete/rename` route to the REST client; `switchSession`/`sendSwitchSession` send activate.
- Modify: `shared/mobile-data/.../data/SdkSessionsRepository.kt` — unchanged surface (still calls `sdk.listSessions` etc.); the SDK now fulfills those via REST.
- Modify: platform `HttpClient` factories (`AuthClientFactory.ios.kt` + Android `WebSocketEngine.android.kt`/equivalent) — reuse/extend the JSON `HttpClient` for `SessionsHttpClient`.

- [ ] **Step 1: Write the failing test** for `SessionsHttpClient` using `ktor-client-mock` (the dep is already in `commonTest`):

```kotlin
package io.sentient.mobilesdk.sessions
import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.*
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals

class SessionsHttpClientTest {
    @Test
    fun list_parses_items_and_sends_bearer() = runTest {
        var authHeader: String? = null
        val engine = MockEngine { req ->
            authHeader = req.headers[HttpHeaders.Authorization]
            respond("""{"items":[{"sessionId":"s-1","title":"T","lastActiveAt":1}]}""",
                HttpStatusCode.OK, headersOf(HttpHeaders.ContentType, "application/json"))
        }
        val client = SessionsHttpClient(HttpClient(engine), gatewayWsUrl = "wss://h/api/v1/ws", token = { "t" })
        val rows = client.list(limit = 100, offset = 0)
        assertEquals("s-1", rows.first().sessionId)
        assertEquals("Bearer t", authHeader)
    }
}
```

- [ ] **Step 2: Run → FAIL.** `source scripts/env.sh && ./gradlew :shared:mobile-sdk:testDebugUnitTest --tests "*SessionsHttpClientTest*"`.
- [ ] **Step 3: Implement `SessionsHttpClient.kt`** copying `AuthClient.kt` (`deriveBaseUrl`, content-negotiation JSON, `Authorization` header, typed return). Methods: `list`, `getMessages`, `search`, `rename`, `delete`.
- [ ] **Step 4: Repoint connectors + ClientMessage + SentientSdk** as listed in Files.
- [ ] **Step 5: Run → PASS + compile both modules.** `./gradlew :shared:mobile-sdk:testDebugUnitTest :shared:mobile-data:testDebugUnitTest`.
- [ ] **Step 6: Commit.**

```bash
git add shared/mobile-sdk/src shared/mobile-data/src
git commit -m "feat(mobile-sdk): REST SessionsHttpClient; queries go REST, switch→conversation.activate

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Slice 2 — quality gate

- [ ] `cd gateway && bun run ci` (lint + typecheck + unit) → green.
- [ ] `./gradlew :shared:mobile-sdk:testDebugUnitTest :shared:mobile-data:testDebugUnitTest` → green.
- [ ] Boot local stack (`deploy/macos`), smoke: web + Maestro — open drawer (REST list), open a past chat (REST history paints, `conversation.activate` focuses live), rename/delete (REST + broadcast refresh). Spec §13 cases `instant-paint-past-chat` (REST reconcile), `query-not-buffered`.

---

## SLICE 3 — Resumable WS layer (seq/epoch/replay/resume + entryId)

**Outcome:** Every outbound WS push frame carries a monotonic `seq` (binary frames via a 9-byte header `[8B BE seq][1B type]`); the gateway buffers them per device-session (16 MB cap + 30-min retention TTL surviving disconnect); on reconnect the client resumes from `lastSeq` (`recovered:true`) or falls back to REST history (`recovered:false`); the in-flight cycle keeps running and journaling on disconnect. Introduces the stable `entryId` that Slice 4 keys on.

**Wire identity decisions (fixed for this slice):** `seq` = per-device-session monotonic `u64`, starts at 1. `epoch` = per-device-session generation, an integer bumped on each fresh (non-resumed) connect generation. `entryId` = gateway-minted stable id on each committed conversation entry (`${conversationId}:${seq}` of the commit frame, or a ULID — pick ULID for stability across re-commits). Binary header = `[8-byte BE u64 seq][1-byte type]` (type `0x01` = audio), payload follows.

### Task 3.1: Config knobs + Bun idleTimeout

**Files:**
- Modify: `gateway/config.yaml` (`session:` block, `:63-80`)
- Modify: `shared/config/src/schema.ts` (the `SessionConfig` zod schema)
- Modify: `gateway/src/config/startup-config.ts` (`:43,128`) — forwarded via `cfg.session`
- Modify: `gateway/src/server.ts` (`:140`) — `idleTimeout`

- [ ] **Step 1: Add to `gateway/config.yaml` under `session:`** (every value commented per the config rule):

```yaml
  # WS resilience (resumable sequenced stream + replay buffer)
  ws_idle_timeout_ms: 255000         # Bun WS socket idle close. Bun's idleTimeout takes SECONDS, cap 255; gateway converts ms→s.
  retention_ttl_ms: 1800000          # 30 min — PersonSession + per-device replay buffer survive disconnect this long, then evict.
  replay_buffer_max_bytes: 16777216  # 16 MB per device-session ring cap (evict-oldest). Safety headroom; TTL frees first.
  replay_audio_coalesce_ms: 1000     # coalesce audio into ~1s segments before buffering to bound object count.
```

- [ ] **Step 2: Extend `SessionConfig` schema** in `shared/config/src/schema.ts` with the four fields (numbers, no defaults in code — YAML is the source; fail loudly if missing, per config rule). Add a unit test in that package asserting a config missing `retention_ttl_ms` fails validation.
- [ ] **Step 3: Thread to `server.ts`.** `cfg.session` already forwards (`startup-config.ts:128`). In `Bun.serve({...})` (`server.ts:140`), add as a sibling of `websocket:` — `idleTimeout: Math.round(services.session.ws_idle_timeout_ms / 1000),`.
- [ ] **Step 4: Typecheck + config test.** `cd gateway && bun run typecheck`; run the config package test. Expected: PASS.
- [ ] **Step 5: Commit.** `chore(gateway): config knobs for WS resilience + Bun idleTimeout 255s`.

### Task 3.2: SessionReplayBuffer (pure unit, TDD)

Ring of `{ seq, frame }` bounded by total bytes (evict-oldest when over cap). Owns the seq counter + epoch + lastSeq. `append(frame)→seq`, `since(lastSeq)→frames[]` (or `null` if `lastSeq` < oldest retained ⇒ caller returns `recovered:false`), `oldestSeq`/`newestSeq`.

**Files:**
- Create: `gateway/src/session-handlers/session-replay-buffer.ts`
- Test: `gateway/src/session-handlers/session-replay-buffer.test.ts`

- [ ] **Step 1: Write the failing test** (gateway bun-test):

```ts
import { describe, expect, it } from "vitest";
import { createReplayBuffer } from "./session-replay-buffer.js";

const f = (n: number) => ({ bytes: new Uint8Array(n) });

describe("SessionReplayBuffer", () => {
  it("assigns monotonic seq from 1", () => {
    const b = createReplayBuffer({ maxBytes: 1000 });
    expect(b.append(f(10))).toBe(1);
    expect(b.append(f(10))).toBe(2);
    expect(b.newestSeq).toBe(2);
  });
  it("since() returns frames after lastSeq", () => {
    const b = createReplayBuffer({ maxBytes: 1000 });
    b.append(f(10)); b.append(f(10)); b.append(f(10));
    const got = b.since(1);
    expect(got?.map((x) => x.seq)).toEqual([2, 3]);
  });
  it("evicts oldest when over byte cap and since(evicted) → null (force snapshot)", () => {
    const b = createReplayBuffer({ maxBytes: 25 });
    b.append(f(10)); // seq1
    b.append(f(10)); // seq2
    b.append(f(10)); // seq3 → total 30 > 25 → evict seq1
    expect(b.oldestSeq).toBe(2);
    expect(b.since(1)).toBeNull(); // client's lastSeq=1 was evicted → recovered:false
    expect(b.since(2)?.map((x) => x.seq)).toEqual([3]);
  });
});
```

- [ ] **Step 2: Run → FAIL.** `cd gateway/src && bun test session-handlers/session-replay-buffer.test.ts`.
- [ ] **Step 3: Implement.**

```ts
export interface ReplayFrame { seq: number; bytes: Uint8Array }
export interface ReplayBuffer {
  append(frame: { bytes: Uint8Array }): number;
  since(lastSeq: number): ReplayFrame[] | null;
  readonly oldestSeq: number;
  readonly newestSeq: number;
}

export function createReplayBuffer(opts: { maxBytes: number }): ReplayBuffer {
  const frames: ReplayFrame[] = [];
  let seq = 0;
  let bytes = 0;
  return {
    append(frame) {
      seq += 1;
      const f: ReplayFrame = { seq, bytes: frame.bytes };
      frames.push(f);
      bytes += f.bytes.byteLength;
      while (bytes > opts.maxBytes && frames.length > 1) {
        const dropped = frames.shift();
        if (dropped) bytes -= dropped.bytes.byteLength;
      }
      return seq;
    },
    since(lastSeq) {
      if (frames.length === 0) return lastSeq === seq ? [] : null;
      if (lastSeq < frames[0].seq - 1) return null; // gap: evicted → snapshot
      return frames.filter((f) => f.seq > lastSeq);
    },
    get oldestSeq() { return frames.length ? frames[0].seq : seq + 1; },
    get newestSeq() { return seq; },
  };
}
```

- [ ] **Step 4: Run → PASS.** Same command. Expected: 3 PASS.
- [ ] **Step 5: Commit.** `feat(gateway): SessionReplayBuffer ring with byte-cap eviction + since() gap detection`.

### Task 3.3: FrameSequencer (pure unit, TDD)

Stamps `seq`+`epoch` onto JSON frames; prepends the 9-byte header onto binary frames; appends each to the replay buffer. One per device-session.

**Files:**
- Create: `gateway/src/session-handlers/frame-sequencer.ts`
- Test: `gateway/src/session-handlers/frame-sequencer.test.ts`

- [ ] **Step 1: Write the failing test:**

```ts
import { describe, expect, it } from "vitest";
import { createFrameSequencer, BINARY_TYPE_AUDIO } from "./frame-sequencer.js";
import { createReplayBuffer } from "./session-replay-buffer.js";

describe("FrameSequencer", () => {
  it("stamps seq+epoch on JSON and buffers it", () => {
    const buf = createReplayBuffer({ maxBytes: 10_000 });
    const sent: string[] = [];
    const seq = createFrameSequencer({ epoch: 7, buffer: buf, sendJson: (s) => sent.push(s), sendBinary: () => {} });
    seq.json({ type: "message.delta", cycleId: "c1", delta: "hi" });
    const out = JSON.parse(sent[0]);
    expect(out.seq).toBe(1);
    expect(out.epoch).toBe(7);
    expect(buf.newestSeq).toBe(1);
  });
  it("prepends 9-byte header [u64 seq][type] on binary", () => {
    const buf = createReplayBuffer({ maxBytes: 10_000 });
    const sentBin: Uint8Array[] = [];
    const seq = createFrameSequencer({ epoch: 7, buffer: buf, sendJson: () => {}, sendBinary: (b) => sentBin.push(b) });
    seq.binary(new Uint8Array([0xaa, 0xbb]), BINARY_TYPE_AUDIO);
    const framed = sentBin[0];
    const view = new DataView(framed.buffer, framed.byteOffset, framed.byteLength);
    expect(Number(view.getBigUint64(0))).toBe(1); // seq
    expect(framed[8]).toBe(BINARY_TYPE_AUDIO);     // type byte
    expect(framed[9]).toBe(0xaa); expect(framed[10]).toBe(0xbb);
  });
});
```

- [ ] **Step 2: Run → FAIL.** `cd gateway/src && bun test session-handlers/frame-sequencer.test.ts`.
- [ ] **Step 3: Implement.**

```ts
import type { ReplayBuffer } from "./session-replay-buffer.js";

export const BINARY_TYPE_AUDIO = 0x01;
const HEADER_BYTES = 9; // 8-byte BE u64 seq + 1-byte type

export interface FrameSequencer {
  json(frame: Record<string, unknown>): void;
  binary(payload: Uint8Array, type: number): void;
}

export function createFrameSequencer(deps: {
  epoch: number;
  buffer: ReplayBuffer;
  sendJson: (s: string) => void;
  sendBinary: (b: Uint8Array) => void;
}): FrameSequencer {
  const encode = (s: string) => new TextEncoder().encode(s);
  return {
    json(frame) {
      const seq = deps.buffer.append({ bytes: encode(JSON.stringify({ ...frame, seq: 0, epoch: deps.epoch })) });
      const stamped = JSON.stringify({ ...frame, seq, epoch: deps.epoch });
      // replace the buffered placeholder bytes with the final stamped bytes:
      // (simpler: append the final stamped bytes; the placeholder above is only for seq allocation)
      deps.sendJson(stamped);
    },
    binary(payload, type) {
      const framed = new Uint8Array(HEADER_BYTES + payload.byteLength);
      const view = new DataView(framed.buffer);
      // seq assigned by buffering the framed bytes; but seq must be in the header → allocate first:
      const seq = deps.buffer.append({ bytes: framed }); // placeholder length is correct
      view.setBigUint64(0, BigInt(seq));
      framed[8] = type;
      framed.set(payload, HEADER_BYTES);
      deps.sendBinary(framed);
    },
  };
}
```

> Implementation note for the engineer: the seq must be known *before* writing the header/JSON, but the buffer assigns seq on append. Resolve by splitting `buffer.append` into `nextSeq()` + `store(seq, bytes)`, OR append a placeholder then overwrite — pick `nextSeq()`+`store()` for cleanliness and update Task 3.2's interface + tests accordingly (add a `nextSeq()` test). Do that refactor as the first step here if the two-phase shape is cleaner than the placeholder shown.

- [ ] **Step 4: Run → PASS.** Adjust per the note above; both files green.
- [ ] **Step 5: Commit.** `feat(gateway): FrameSequencer stamps seq/epoch (JSON) + 9-byte header (binary)`.

### Task 3.4: Mint stable `entryId` on committed entries (TDD)

**Files:**
- Modify: `gateway/src/cerebrum/hermes-event-translator.ts` (`:294-298`, +tool `:276`, +error `:122`, +interrupt `:148`)
- Modify: `gateway/src/cerebrum/conversation-mirror.ts` (`MirrorEntry` gains `entryId`)
- Modify: `shared/protocol/src/conversation.ts` (`conversationFeedItemSchema` gains `entryId`)
- Test: extend `hermes-event-translator`'s existing test (or `conversation-mirror.test.ts`)

- [ ] **Step 1: Failing test** — assert the committed `conversation.entry` carries a non-empty stable `entryId`, and two commits get distinct ids.
- [ ] **Step 2: Implement** — add `entryId: string` to `MirrorEntry`; mint a ULID (add a tiny `newEntryId()` helper, or reuse an existing id mint) at each `MirrorEntry` creation site (assistant `:294`, tool `:276`, error-partial `:122`, interrupt-partial `:148`). Add `entryId: z.string()` to `conversationFeedItemSchema` and carry it through `toFeedItem` (`conversation-feed.ts`).
- [ ] **Step 3: Run → PASS** (`cd gateway/src && bun test cerebrum/hermes-event-translator.test.ts`) + `bun run typecheck`.
- [ ] **Step 4: Commit.** `feat(gateway,protocol): stable entryId on committed conversation entries`.

### Task 3.5: Funnel all egress through the sequencer (per device-session)

**Files:**
- Modify: `gateway/src/session-handlers/device-attachment.ts` (`:40-65`)
- Modify: `gateway/src/session-handlers/ws-session-configure.ts` (`:124,128-133,224-252,402-406,765,768,815-825,851-856`)

- [ ] **Step 1:** Give `DeviceAttachment` a `FrameSequencer` (constructed from the PersonSession's per-device buffer + epoch — Task 3.6). Change `send(msg)` → `sequencer.json(msg)` and `sendBinary(data)` → `sequencer.binary(data, BINARY_TYPE_AUDIO)`.
- [ ] **Step 2:** In `ws-session-configure.ts`, set `wsSend = (m) => attachment.send(m)` and `wsSendBinary = (d) => attachment.sendBinary(d)` (replacing the raw `ws.send` closures at `:128-133`), and replace every inline `ws.send(JSON.stringify(...))` (the 6 sites listed in Files) with `attachment.send(...)`. This makes the attachment the **sole egress** so every frame is sequenced + buffered.
- [ ] **Step 3: Typecheck + gateway unit suite.** `cd gateway && bun run typecheck && bun run test`. Expected: PASS (existing wire tests now see `seq`/`epoch` fields — update any exact-frame assertions that broke to allow the new optional fields).
- [ ] **Step 4: Commit.** `refactor(gateway): route all WS egress through the per-device FrameSequencer`.

### Task 3.6: PersonSession holds per-device buffer + epoch; registry retention TTL

**Files:**
- Modify: `gateway/src/person-session/person-session.ts` (`:36-69,101-148`)
- Modify: `gateway/src/person-session/person-session-registry.ts` (`:82-128`)

- [ ] **Step 1:** Add to `PersonSession` a `Map<deviceId, { buffer: ReplayBuffer; epoch: number; detachedAtMs: number | null }>`. On `attach`, get-or-create the device entry: if a matching `deviceId` exists with a live (un-evicted) buffer and the client presents the same epoch on resume → reuse (resume); else bump epoch + fresh buffer. On `detach`, set `detachedAtMs = Date.now()` (start the TTL) but keep the buffer. Expose `bufferFor(deviceId)`, `epochFor(deviceId)`.
- [ ] **Step 2:** Add a retention sweep: a `setInterval` in the registry (or a self-arming timer on PersonSession) that, every `retention_ttl_ms/6`, evicts device entries with `detachedAtMs` older than `retention_ttl_ms`, and removes a PersonSession from the registry Map once it has zero attachments AND zero retained buffers. Wire `retention_ttl_ms` from config.
- [ ] **Step 3: Test** the eviction predicate as a pure helper (e.g. `shouldEvict(detachedAtMs, now, ttl)`) + a test that a swept registry drops an idle session. `cd gateway/src && bun test person-session/...`.
- [ ] **Step 4: Commit.** `feat(gateway): per-device replay buffer + epoch on PersonSession; 30-min retention sweep`.

### Task 3.7: Split `cleanupSession` — resumable disconnect vs full teardown

**Files:**
- Modify: `gateway/src/session-handlers/ws-handlers.ts` (`:214-218` session.end, `:220-292` cleanupSession, `close` path)

- [ ] **Step 1:** Distinguish a **transport disconnect** (Bun `close`, resumable) from an explicit **`session.end`** / logout (full teardown). On a resumable disconnect when the client advertised `stream.resume`: SKIP `attentionGate.dispose()` (keep the in-flight cycle running → its frames keep journaling into the device buffer), SKIP the ACP wire release + `sessionManager.removeSession`, and call `personSession.detach(attachment)` (which starts the retention TTL, Task 3.6) — but keep the buffer. On `session.end`/logout: full teardown as today.
- [ ] **Step 2:** When the cycle keeps running with no live socket, the sequencer's `sendJson`/`sendBinary` must no-op the socket write (socket is closed) but STILL append to the buffer. Ensure the sequencer buffers even when the underlying `ws.send` throws/no-ops (wrap the socket write in try/catch; always buffer first).
- [ ] **Step 3: Test** (gateway integration, vitest): open → start a cycle → simulate transport close → assert the cycle still completes and frames are in the device buffer (assert via a test seam exposing `bufferFor(deviceId).newestSeq`). `cd gateway && bun run test:int`.
- [ ] **Step 4: Commit.** `feat(gateway): resumable disconnect keeps cycle running + journaling; full teardown only on session.end`.

### Task 3.8: Resume handshake intake

**Files:**
- Modify: `gateway/src/api/handlers/ws.ts` (`:9-29`) — parse `?device_id=&epoch=&last_seq=`
- Modify: `gateway/src/session-handlers/ws-helpers.ts` (`ClientData` gains `resumeDeviceId`/`resumeEpoch`/`resumeLastSeq`)
- Modify: `gateway/src/session-handlers/ws-session-configure.ts` (post-configure: attempt replay)

- [ ] **Step 1:** Parse the three query params in the upgrade handler (alongside the existing `session_id`), stash on `ClientData`.
- [ ] **Step 2:** After session configure, if `resumeDeviceId` present and the PersonSession has a matching device buffer with `epoch === resumeEpoch` and `buffer.since(resumeLastSeq) !== null`: replay those frames in order over the (new) socket, then emit `{ type: "stream.resumed", recovered: true, fromSeq, toSeq, epoch }` and go live — and SKIP the empty/snapshot path. Else emit `{ type: "stream.resumed", recovered: false, epoch }` and let the client REST-refetch (Slice 2). The new connection generation gets the existing buffer (resume) or a fresh epoch+buffer (recovered:false).
- [ ] **Step 3: Test** (integration): connect → buffer frames → close → reconnect with `last_seq` → assert replayed frames + `recovered:true`; reconnect with a stale `last_seq` → `recovered:false`. `cd gateway && bun run test:int`.
- [ ] **Step 4: Commit.** `feat(gateway): WS resume handshake — replay since lastSeq or recovered:false`.

### Task 3.9: Protocol — optional seq/epoch + resume frames (TDD)

**Files:**
- Modify: `shared/protocol/src/messages.ts` (push frames + new `streamResumeSchema`/`streamResumedSchema`)
- Test: `shared/protocol/src/messages.test.ts`

- [ ] **Step 1: Failing test** — `gatewayMessageSchema` accepts a `message.delta` with `seq`/`epoch`; `clientMessageSchema` accepts `stream.resume`; `stream.resumed` parses with `recovered`.
- [ ] **Step 2: Implement** — add `seq: z.number().int().nonnegative().optional()` + `epoch: z.number().int().nonnegative().optional()` to each push-frame schema (enumerate: `sessionReadySchema, cycleStartedSchema, cycleAbortedSchema, cycleCompletedSchema, connectorAudioStartSchema, connectorAudioDoneSchema, messageDeltaSchema, messageDoneSchema, cognitionStatusSchema, conversationEntrySchema, taskUpdateSchema, playbackStopSchema` and the kept session broadcasts) — optional keeps old clients valid. Add `streamResumeSchema` (`{type:"stream.resume", epoch:number, lastSeq:number, deviceId:string}`) to `clientMessageSchema`, and `streamResumedSchema` (`{type:"stream.resumed", recovered:boolean, fromSeq?:number, toSeq?:number, epoch:number}`) to `gatewayMessageSchema`. Document the binary header layout in a comment block at the top of `messages.ts`.
- [ ] **Step 3: Run → PASS + typecheck.** `cd shared/web-sdk && bunx vitest run ../protocol/src/messages.test.ts && cd ../.. && bun run typecheck`.
- [ ] **Step 4: Commit.** `feat(protocol): optional seq/epoch on push frames; stream.resume/stream.resumed; binary header`.

### Task 3.10: Clients — read seq/header, send resume, add `entryId`

**Files (mobile):** `transport/WsTransport.kt` (`:102-144`), `protocol/ServerMessage.kt`, `protocol/ConversationFeedItem.kt`, `sdk/SdkState.kt` (ChatMessage gains `entryId`), `transport/ReconnectController.kt` / `sdk/SdkLifecycle.kt:138` / `SentientSdk.kt` (send resume on reconnect; persist `{epoch,lastSeq,deviceId}`), capabilities add `"stream.resume"`.
**Files (web):** `sdk-message-router.ts` (`:40-64`), `sdk-reconnect.ts` (`:74-92`), `sentient-sdk.ts` (`:102,118-131,324`), the feed item type (+`entryId`).

- [ ] **Step 1 (mobile, TDD):** In `WsTransport.routeText`, read `seq`/`epoch` off the decoded `ServerMessage` (add the fields to each `ServerMessage` data class — additive, `ignoreUnknownKeys=true` keeps old frames safe). In `route` for `WsIncoming.Binary`, peel the 9-byte header: `seq = u64(bytes[0..7])`, `type = bytes[8]`, payload = `bytes[9..]`; pass payload as `WsEvent.Audio` and the seq to the cursor tracker. Add `entryId` to `ConversationFeedItem.Assistant/Tool/User` and `ChatMessage`. Unit-test the binary-header peel (a pure `parseBinaryFrame(bytes)` helper) and a `ServerMessage` decode carrying `seq`.
- [ ] **Step 2 (mobile):** Track `lastSeq` (the max applied seq) + `epoch` per conversation; persist via the cursor store (Slice 4 provides durable storage; until then keep in-memory). Generate + persist a stable `deviceId` (reuse/extend `SecureTokenStore` or a new `multiplatform-settings` key — Slice 4). On reconnect success, send `ClientMessage.StreamResume(epoch, lastSeq, deviceId)` instead of unconditionally re-issuing activate; on `ServerMessage.StreamResumed(recovered=false)`, REST-refetch history (Slice 2). Add `"stream.resume"` to the merged capabilities (`SdkConfig.kt:124` / `SdkConnectors.kt` / `SentientSdk.kt`).
- [ ] **Step 3 (web, TDD):** In `sdk-message-router.dispatchMessage`, read `msg.seq`/`msg.epoch` after `JSON.parse`; for the `ArrayBuffer` branch peel the 9-byte header before handing the payload to binary handlers. Add `entryId` to the feed item type. Track `{epoch,lastSeq}` (sessionStorage); send `stream.resume` on (re)connect via `buildConnectUrl` query params or an `onopen` control frame; on `recovered:false` REST-refetch. Add `"stream.resume"` to `this.capabilities`. Unit-test the header peel + seq read.
- [ ] **Step 4: Run tests + compile both stacks.** `cd shared/web-sdk && bunx vitest run` ; `./gradlew :shared:mobile-sdk:testDebugUnitTest`.
- [ ] **Step 5: Commit.** `feat(sdk): clients read seq + binary header, send resume handshake, carry entryId`.

### Slice 3 — quality gate

- [ ] `cd gateway && bun run ci` + `bun run test:int` → green.
- [ ] `./gradlew :shared:mobile-sdk:testDebugUnitTest` + `cd shared/web-sdk && bunx vitest run` → green.
- [ ] Local stack smoke (web + Maestro), spec §13: `resume-within-window`, `resume-beyond-window`, `background-mid-response-text`, `background-mid-speech-audio`, `reconnect-flap` (no dup `entryId`), `epoch-mismatch-restart`.

---

## SLICE 4 — Device mirror (SQLDelight)

**Outcome:** A device-local, write-through transcript cache (keyed by the `entryId` from Slice 3) that paints instantly on conversation-open/foreground and reconciles via REST (Slice 2), plus server-list-authoritative smart-async deletion. Behind the existing `ConversationRepository`/`SessionsRepository` interfaces — ViewModels unchanged.

> **Depends on Slice 3** (`entryId` on `ChatMessage`/feed) **and Slice 2** (REST list/history).

### Task 4.1: Add SQLDelight + multiplatform-settings to the build

**Files:**
- Modify: `gradle/libs.versions.toml`
- Modify: root `build.gradle.kts` (`:1-8`)
- Modify: `shared/mobile-data/build.gradle.kts`

- [ ] **Step 1: VERIFY versions first (per `verify-pinned-versions`).** Kotlin is pinned `2.3.10` (SKIE ceiling). Check the latest **SQLDelight** release that supports Kotlin 2.3.10 / K2 (releases page) and the latest **multiplatform-settings**. Pin those exact versions — do not guess. Record them in `[versions]`.
- [ ] **Step 2: Add to `gradle/libs.versions.toml`.** In `[versions]` (near `:44`): `sqldelight = "<verified>"`, `multiplatform-settings = "<verified>"`. In `[libraries]`: `sqldelight-runtime`, `sqldelight-coroutines-extensions`, `sqldelight-android-driver` (`app.cash.sqldelight:android-driver`), `sqldelight-native-driver` (`app.cash.sqldelight:native-driver`), `sqldelight-sqlite-driver` (JVM, for commonTest), `multiplatform-settings` (`com.russhwolf:multiplatform-settings`), `multiplatform-settings-coroutines`. In `[plugins]`: `sqldelight = { id = "app.cash.sqldelight", version.ref = "sqldelight" }`.
- [ ] **Step 3: Root `build.gradle.kts`** — add `alias(libs.plugins.sqldelight) apply false` to the plugins block.
- [ ] **Step 4: `shared/mobile-data/build.gradle.kts`** — add `alias(libs.plugins.sqldelight)` to `plugins {}`; add a top-level `sqldelight { databases { create("ChatDatabase") { packageName.set("io.sentient.mobiledata.cache.db") } } }` block; add to `commonMain.dependencies`: `implementation(libs.sqldelight.runtime)`, `implementation(libs.sqldelight.coroutines.extensions)`, `implementation(libs.multiplatform.settings)`; ADD source-set blocks (currently absent here — model on mobile-sdk `:55-56`): `androidMain.dependencies { implementation(libs.sqldelight.android.driver) }`, `iosMain.dependencies { implementation(libs.sqldelight.native.driver) }`; add to `commonTest.dependencies`: `implementation(libs.sqldelight.sqlite.driver)` (JVM in-memory driver for host tests).
- [ ] **Step 5: Verify the build resolves.** `source scripts/env.sh && ./gradlew :shared:mobile-data:compileKotlinIosSimulatorArm64`. Expected: BUILD SUCCESSFUL (no `.sq` yet → empty DB OK).
- [ ] **Step 6: Commit.** `chore(mobile-data): add SQLDelight + multiplatform-settings deps`.

### Task 4.2: Schema `ChatDatabase.sq`

**Files:**
- Create: `shared/mobile-data/src/commonMain/sqldelight/io/sentient/mobiledata/cache/db/ChatDatabase.sq`

- [ ] **Step 1: Write the schema + queries.**

```sql
CREATE TABLE message (
  entry_id TEXT NOT NULL PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  ts INTEGER NOT NULL,
  cutoff_kind TEXT
);
CREATE INDEX message_by_conversation ON message(conversation_id, seq);

CREATE TABLE session (
  id TEXT NOT NULL PRIMARY KEY,
  title TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

upsertMessage:
INSERT INTO message(entry_id, conversation_id, seq, role, content, ts, cutoff_kind)
VALUES (?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(entry_id) DO UPDATE SET content=excluded.content, seq=excluded.seq, cutoff_kind=excluded.cutoff_kind;

messagesFor:
SELECT * FROM message WHERE conversation_id = ? ORDER BY seq ASC;

deleteConversation:
DELETE FROM message WHERE conversation_id = ?;

upsertSession:
INSERT INTO session(id, title, updated_at) VALUES (?, ?, ?)
ON CONFLICT(id) DO UPDATE SET title=excluded.title, updated_at=excluded.updated_at;

allSessions:
SELECT * FROM session ORDER BY updated_at DESC;

deleteSession:
DELETE FROM session WHERE id = ?;

allSessionIds:
SELECT id FROM session;
```

- [ ] **Step 2: Generate + compile.** `./gradlew :shared:mobile-data:generateCommonMainChatDatabaseInterface :shared:mobile-data:compileKotlinIosSimulatorArm64`. Expected: BUILD SUCCESSFUL; `ChatDatabase` type generated.
- [ ] **Step 3: Commit.** `feat(mobile-data): SQLDelight ChatDatabase schema (message/session/cursor)`.

### Task 4.3: DatabaseDriverFactory expect/actual

**Files:**
- Create: `shared/mobile-data/src/commonMain/kotlin/io/sentient/mobiledata/cache/DatabaseDriverFactory.kt` (expect)
- Create: `.../cache/DatabaseDriverFactory.android.kt` (actual — needs `Context` via `AndroidContextHolder.requireContext()`, mirror `SecureTokenStore.android.kt`)
- Create: `.../cache/DatabaseDriverFactory.ios.kt` (actual — `NativeSqliteDriver(ChatDatabase.Schema, "chat.db")`, no context)

- [ ] **Step 1:** commonMain: `expect class DatabaseDriverFactory { fun create(): SqlDriver }`.
- [ ] **Step 2:** androidMain actual: `AndroidSqliteDriver(ChatDatabase.Schema, AndroidContextHolder.requireContext(), "chat.db")`. iosMain actual: `NativeSqliteDriver(ChatDatabase.Schema, "chat.db")`.
- [ ] **Step 3: Compile both targets.** `./gradlew :shared:mobile-data:compileDebugKotlinAndroid :shared:mobile-data:compileKotlinIosSimulatorArm64`. Expected: SUCCESSFUL.
- [ ] **Step 4: Commit.** `feat(mobile-data): platform DatabaseDriverFactory (Android/iOS)`.

### Task 4.4: SyncCursorStore (multiplatform-settings)

**Files:**
- Create: `.../cache/SyncCursorStore.kt` (+ test) — `get(conversationId): {epoch, lastSeq}?`, `set(conversationId, epoch, lastSeq)`, `deviceId(): String` (generate+persist if absent).

- [ ] **Step 1: Failing test** — round-trip `set`/`get`; `deviceId()` is stable across calls. Use multiplatform-settings' `MapSettings` (in-memory, test impl).
- [ ] **Step 2: Implement** over `com.russhwolf.settings.Settings` (injected; platform provides the real backing in the factories).
- [ ] **Step 3: Run → PASS.** `./gradlew :shared:mobile-data:testDebugUnitTest --tests "*SyncCursorStoreTest*"`.
- [ ] **Step 4: Commit.** `feat(mobile-data): SyncCursorStore (epoch/lastSeq cursor + deviceId)`.

### Task 4.5: CachingConversationRepository (write-through + cache-then-refresh, TDD)

Decorates `SdkConversationRepository`. On switch/open: emit cached `messagesFor(conversationId)` instantly, then collect `sdk.timeline` and `liveEvents`, write-through `upsertMessage` by `entryId` on every emission, and keep its own `MutableStateFlow` as the surface. Requires the session scope (injected).

**Files:**
- Create: `.../data/CachingConversationRepository.kt`
- Test: `.../commonTest/.../data/CachingConversationRepositoryTest.kt` (use the JVM `JdbcSqliteDriver(IN_MEMORY)` from `sqldelight-sqlite-driver`, a `TestScope`, and a fake `ConversationRepository` with a controllable `MutableStateFlow<List<ChatMessage>>`/`MutableSharedFlow<SdkEvent>`).

- [ ] **Step 1: Failing test** — assert: (a) a `ChatMessage` with `entryId="e1"` flowing through `sdk.timeline` results in a row in `message` (write-through), (b) opening a conversation with a pre-seeded cached row emits that row before any sdk emission (instant paint), (c) re-emitting the same `entryId` with new content updates (no dup row).
- [ ] **Step 2: Implement** the decorator: ctor `(inner: ConversationRepository, db: ChatDatabase, cursor: SyncCursorStore, scope: CoroutineScope)`. `timeline` = own `MutableStateFlow` seeded from `db` for the active conversation, then `scope.launch { inner.timeline.collect { list -> list.forEach { db upsert by entryId }; _timeline.value = list } }`. `send` delegates to `inner`. (Active-conversation tracking comes from the `conversation.activate`/`SessionSwitched` event.)
- [ ] **Step 3: Run → PASS.** `./gradlew :shared:mobile-data:testDebugUnitTest --tests "*CachingConversationRepositoryTest*"`.
- [ ] **Step 4: Commit.** `feat(mobile-data): write-through caching ConversationRepository (cache-then-refresh)`.

### Task 4.6: CachingSessionsRepository + smart-async deletion (TDD)

Decorates `SdkSessionsRepository`. `list()` emits cached `allSessions()` then refreshes via the SDK's REST-backed `list()`; on refresh, **diff vs cache and background-delete sessions absent from the full server list** (cascade `deleteConversation`). `delete(id)` evicts cache + messages.

**Files:**
- Create: `.../data/CachingSessionsRepository.kt`
- Test: `.../commonTest/.../data/CachingSessionsRepositoryTest.kt`

- [ ] **Step 1: Failing test** — (a) `list()` returns cached rows first then server rows; (b) a cached session ABSENT from the (full) server list is deleted locally (and its messages cascade-deleted); (c) a session present only in a PARTIAL list (when `fullFetch=false`) is NOT deleted (pagination guard); (d) the active/just-created conversation is never deleted.
- [ ] **Step 2: Implement.** Add a `fullFetch` flag to the reconcile path; only delete-by-absence when the complete id set was fetched (`allSessionIds()` diff). Background-delete on the injected `scope` (low priority). Drive deletion off server **absence**, never a client-side age rule (no hardcoded 90 days).
- [ ] **Step 3: Run → PASS.** `./gradlew :shared:mobile-data:testDebugUnitTest --tests "*CachingSessionsRepositoryTest*"`.
- [ ] **Step 4: Commit.** `feat(mobile-data): caching SessionsRepository + server-authoritative smart-async deletion`.

### Task 4.7: Wire into ChatComponent + platform factories

**Files:**
- Modify: `shared/mobile-data/.../di/ChatComponent.kt` (`:21-26`)
- Modify: `android/.../di/UserSessionManager.kt` (`:84` construction site)
- Modify: `shared/mobile-data/.../di/IosUserSession.ios.kt` (`:89` construction site)

- [ ] **Step 1:** `ChatComponent` ctor gains `databaseDriverFactory: DatabaseDriverFactory`, `settings: Settings`, and a `scope: CoroutineScope`. Build `val db = ChatDatabase(databaseDriverFactory.create())`, `val cursor = SyncCursorStore(settings)`, then wrap: `private val conversation = CachingConversationRepository(SdkConversationRepository(sdk), db, cursor, scope)` and `private val sessions = CachingSessionsRepository(SdkSessionsRepository(sdk), db, scope)`. `observeChat`/`observeSessions` consume the wrapped repos unchanged.
- [ ] **Step 2:** Android `UserSessionManager.component()` (`:84`): `ChatComponent(newSdk, AndroidDatabaseDriverFactory(), AndroidSettingsFactory(), sessionScope)`. iOS `IosUserSession` (`:89`): `ChatComponent(sdk, IosDatabaseDriverFactory(), IosSettingsFactory(), scope)`. (Settings factories: `SharedPreferencesSettings`/`NSUserDefaultsSettings` from multiplatform-settings — or its `Settings()` no-arg where available.)
- [ ] **Step 3: Compile all + both module unit suites.** `./gradlew :shared:mobile-data:testDebugUnitTest :android:compileDebugKotlin :shared:mobile-data:compileKotlinIosSimulatorArm64`.
- [ ] **Step 4: Reconcile `ObserveChatUseCase.historyLoadingFlow`** (`ObserveChatUseCase.kt:79-94`): the instant cached paint may flip the spinner OFF before the server reconcile. Verify/adjust so the spinner reflects REST-reconcile-in-flight, not the cached paint. Add/adjust the usecase test.
- [ ] **Step 5: Commit.** `feat(mobile-data): wire persistent chat mirror into ChatComponent + platform factories`.

### Task 4.8: Amend the rules for the stateful-mirror exception

**Files:**
- Modify: `.claude/rules/mobile-data/repositories.md` (`:10,13,14,15`)
- Modify: `.claude/rules/mobile/mobile-offline.md`, `.claude/rules/android/android-coroutines-flow.md`, `.claude/rules/mobile/mobile-lifecycle.md` ("not yet durable" lines)

- [ ] **Step 1:** In `repositories.md`, add a bounded exception: a **connection-scoped device-local mirror** (SQLDelight, write-through, keyed by server `entryId`) is a permitted stateful repository decorator — distinct from a per-screen cache. Update the "STATELESS mappers" / "no caching" lines to reference this exception and point to this spec.
- [ ] **Step 2:** Flip the "in-memory; not yet durable" notes in the three cross-cutting rules to "durable mirror landed (SQLDelight); see `docs/superpowers/specs/2026-06-09-ws-resilience-and-chat-mirror-design.md`."
- [ ] **Step 3: Commit.** `docs(rules): permit connection-scoped durable chat mirror (mobile-data exception)`.

### Slice 4 — quality gate

- [ ] `./gradlew :shared:mobile-data:testDebugUnitTest :shared:mobile-sdk:testDebugUnitTest` → green; both platform targets compile.
- [ ] Local stack smoke (Maestro), spec §13: `instant-paint-past-chat` (paints from SQLDelight before REST reconcile), `smart-async-deletion` (pruned sessions vanish, messages cascade), `history-rest-live-ws`.

---

## SLICE 5 — Docs + version bumps

Do last, once the deployable artifact is green.

### Task 5.1: Version bumps (+0.1.0)

- [ ] `gateway/package.json:3` — `"1.10.0"` → `"1.11.0"`.
- [ ] `android/build.gradle.kts:27` — `versionCode = 1; versionName = "0.0.1"` → `versionCode = 2; versionName = "0.1.0"`.
- [ ] `ios/App/Info.plist:19-20` — `CFBundleShortVersionString` `0.0.1` → `0.1.0` (build `CFBundleVersion` `1`→`2` optional). (No pbxproj; XcodeGen reads this committed plist.)
- [ ] `shared/mobile-sdk/build.gradle.kts` + `shared/mobile-data/build.gradle.kts` — add `version = "0.1.0"` right after the `plugins {}` block (neither declares one today).
- [ ] **Verify:** `cd gateway && bun run typecheck` ; `./gradlew :shared:mobile-sdk:compileKotlinIosSimulatorArm64`. Commit: `chore: bump gateway 1.11.0, mobile apps + shared src 0.1.0`.

### Task 5.2: Docs + contracts

- [ ] **`shared/protocol`** — document (in the package README or a `WIRE.md`) the `seq`/`epoch` envelope fields, `entryId` on conversation entries, the 9-byte binary header `[8B BE seq][1B type]`, the `stream.resume`/`stream.resumed` frames, `conversation.activate`, and the WS-vs-REST boundary (WS = live chat session only; everything else REST).
- [ ] **`gateway/README.md`** — resumable stream, replay buffer + 30-min retention TTL, the two-timer model (255s socket vs 30-min session TTL), the new `/api/v1/sessions` REST routes.
- [ ] **`shared/mobile-sdk/README.md`** — resume handshake, device cursor + `deviceId`, fire-and-forget Stop + stuck-state watchdog, REST `SessionsHttpClient`.
- [ ] **`shared/web-sdk/README.md`** — resume parity + REST sessions client.
- [ ] **`android/README.md`, `ios/README.md`** — SQLDelight local mirror, smart-async deletion, version note.
- [ ] **`agents/docs/learnings.md`** — add: resume protocol design (Centrifuge offset+epoch+recovered), the audio object-count footgun (coalesce), Bun idleTimeout 255s cap, the no-stable-id gap solved by `entryId`.
- [ ] **`agents/docs/testing-knowledge.md`** — add the 14 reusable e2e cases (spec §13) indexed by surface (Maestro mobile / Playwright web).
- [ ] Commit: `docs: WS-resilience + chat-mirror contracts, READMEs, learnings, test cases`.

---

## Self-Review

**Spec coverage** — every spec section maps to a task:
- §3 keystone `seq`/`epoch`/`entryId` → Tasks 3.2, 3.3, 3.4. §3.1 transport boundary → Slice 2. §4 G1–G7 → 3.1 (G7), 3.3/3.5 (G1), 3.6 (G2/G3), 3.7 (G4), 3.8 (G5), 3.4 (G6). §5 protocol → 2.1, 3.9. §6 client resume → 3.10. §7 mirror → Slice 4. §8 unstuck → Slice 1. §9 footguns → 3.3 note (audio coalesce), 3.6 (TTL), 3.10 (idempotent entryId). §10 config → 3.1. §11 open items → flagged in 4.1 (SQLDelight version verify), 3.x (device-id, Hermes retention not depended on). §12 build order → slice order. §13 e2e matrix → per-slice quality gates. §14 docs/versions → Slice 5.

**Placeholder scan** — code steps carry real code; mechanical wiring steps carry exact file:line targets + commands. The one deferred concrete value is the SQLDelight/multiplatform-settings version (Task 4.1 Step 1 verifies + pins it against Kotlin 2.3.10 rather than guessing a possibly-incompatible literal — a deliberate verification step, not a placeholder).

**Type consistency** — `entryId: string` is introduced in 3.4 (gateway `MirrorEntry` + protocol feed item) and consumed identically in 3.10 (client `ChatMessage`/feed) and Slice 4 (`message.entry_id` PK). `seq`/`epoch` are `number` everywhere (protocol optional fields, client cursor, buffer). `conversation.activate` replaces `session.switch` consistently across 2.1 (protocol), 2.4 (gateway), 2.5/2.6 (clients). `ReplayBuffer` interface in 3.2 is consumed by `FrameSequencer` in 3.3 (note the `nextSeq()`/`store()` two-phase refactor called out in 3.3 must be applied back to 3.2's interface + tests).

**Known mega-plan risk (re-stated):** Slices 3–4 reference a 2026-06-09 tree snapshot; Slice 2 shifts line numbers and removes the WS query schemas Slice 3 enumerates. Re-verify targets at execution time per the caveat at the top.
