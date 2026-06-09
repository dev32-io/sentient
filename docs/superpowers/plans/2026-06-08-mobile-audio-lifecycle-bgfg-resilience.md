# Mobile Audio Lifecycle + Background/Foreground Resilience + UI polish

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (or executing-plans) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. Branch: `feature/mobile-client` (do NOT create new branches).

**Goal:** Stop the rapid background/foreground freeze + silent-TTS, make a brief backgrounding survive without a reload, encapsulate audio lifecycle behind a clear manager, and land four small iOS UI fixes.

**Architecture:** The freeze and silent TTS are one bug: `AudioPipeline.release()` `close()`s the long-lived opus decoder on every disconnect and never rebuilds it → `reset()`-after-`close()` aborts in native `OpusDecoder#ctl`; `decode()`-after-`close()` silently drops every TTS frame. We split audio teardown into **suspend** (transient, keep native) vs **dispose** (terminal, free native), encapsulated in `SdkAudio` as the audio lifecycle manager. The gateway keeps the per-user session + ACP wire alive on WS-detach and has no server ping/timeout, so a brief background should **not** drop the socket: keep it, and on foreground send a one-shot probe ping — reconnect (and `session.switch`-resume) only if the socket is genuinely dead.

**Tech Stack:** Kotlin Multiplatform (`shared/mobile-sdk` commonMain + iosMain), `shared/mobile-data` (DI/usecases), Android (Compose) + iOS (SwiftUI). kopus (libopus) downlink decoder. AVAudioSession (iosMain).

---

## E2E matrix (INLINE — run on the real local stack; Android = Maestro+adb, iOS = Maestro+simctl)

| Case | Viewport | Pre-state | Action | Expected user-visible | Expected log trail |
|------|----------|-----------|--------|------------------------|--------------------|
| bgfg-quick-survive | iOS + Android | In a chat with history, READY, TTS just played | Background app ~2s, foreground | Same chat, **no reload flash**, scroll stays at bottom, **no freeze** | `scene background` (no `disconnect`), `scene foreground → probe`, `probe.pong ok` (no `forceReconnect`, no `conversation.snapshot`) |
| bgfg-long-reconnect | iOS + Android | In a chat, READY | Background >60s (let OS kill socket), foreground | Brief reconnecting banner, **same chat restored**, snaps to bottom, no crash | `probe.timeout → forceReconnect`, `reconnect → session.switch(<uuid>)`, `conversation.snapshot`, bubble re-pinned |
| tts-after-reconnect | iOS + Android | Reconnected once (any path) | Send a message that yields a TTS reply | **TTS audio plays** (decoder survived), speaking effect matches audio | `downlink-start opusMode=true`, `downlink-decode pcmFrames>0` (NOT `closed`), no `OpusDecoder#ctl` abort |
| tts-speaker-route | iOS | Fresh launch, TTS reply | Listen to a TTS reply | Audio out the **loud bottom speaker**, not the earpiece; barge-in still cancels TTS | `session-active … override=speaker`, AEC/barge-in intact |
| switch-autosnap | iOS | Drawer open, ≥1 long past chat | Tap a past chat | History loads, list **snaps to bottom** (latest visible), composer stays live | `historyLoading true→false`, scroll-to-bottom fired post-snapshot |
| pill-bubble-cap | iOS | Assistant reply with ≥5 tool pills | View the bubble | Bubble **never exceeds screen width**; pills ellipsize within it | n/a (layout) |
| drawer-snap-origin | iOS | Drawer closed | Finger-drag drawer halfway, release | Snap animates **from the release point**, not from the edge | `snap dx=… frac=… → open` |
| drawer-top-inset | iOS | — | Open drawer | Header ("K · Kevin") sits **below** the status bar, not under the clock | n/a (layout) |
| reuse cases | both | — | — | Regression: `login→chat`, `send→reply`, `new-chat-empty`, `logout` all green | per testing-knowledge |

---

## Phase A — Decoder lifecycle hardening (fixes the freeze + silent TTS)

**Files:**
- Modify: `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/audio/opus/OpusDownlinkDecoder.kt`
- Modify: `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/audio/opus/LazyOpusDecoderPort.kt`
- Modify: `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/audioio/AudioPipeline.kt`
- Test: `shared/mobile-sdk/src/commonTest/kotlin/io/sentient/mobilesdk/audio/opus/DecoderLifecycleTest.kt` (new; uses a fake `OpusDecoderPort` — no native libopus on JVM)

- [ ] **A1 — Guard `OpusDownlinkDecoder.reset()` against use-after-close.** `decode()` already early-returns on `closed`; `reset()` does not, so `decoder.ctl(OPUS_RESET_STATE)` runs on a freed decoder → SIGABRT. Add the guard:

```kotlin
override fun reset() {
    if (closed) return            // <-- mirror decode()'s guard: ctl on a freed decoder aborts
    demuxer.reset()
    decoder.ctl(OPUS_RESET_STATE, 0)
    samplesToSkip = -1
    log.info("reset")
}
```

- [ ] **A2 — Make `LazyOpusDecoderPort` rebuild a fresh decoder after close.** Today once the delegate is closed it stays closed forever (decode → empty, reset → crash). The port must be able to re-arm. Replace the `by lazy` delegate with an explicit nullable that recreates on demand:

```kotlin
class LazyOpusDecoderPort(private val factory: () -> OpusDecoderPort) : OpusDecoderPort {
    private var delegate: OpusDecoderPort? = null

    private fun live(): OpusDecoderPort = delegate ?: factory().also { delegate = it }

    override fun decode(oggChunk: ByteArray): List<ByteArray> = live().decode(oggChunk)

    /** Reset the live decoder if one exists; no-op before first decode. */
    override fun reset() { delegate?.reset() }

    /** Free the native decoder AND drop the reference so the next decode() rebuilds a fresh one. */
    override fun close() {
        delegate?.close()
        delegate = null            // <-- key: a later decode() re-instantiates instead of hitting a dead decoder
    }
}
```

- [ ] **A3 — Split `AudioPipeline.release()` into `suspend()` (transient) and `dispose()` (terminal).** `release()` conflates a reconnect-disconnect (must keep the native decoder) with a logout (free it). Replace:

```kotlin
/** Transient teardown for a reconnect/idle disconnect: stop playback + RESET the decoder, keep native alive. */
fun suspendPlayback() {
    log.info("suspend")
    uplink.cancel()
    playbackReady = false
    pendingFrames.clear()
    if (opusMode) opusDecoder.reset()    // reset, NOT close — decoder must survive the reconnect
    if (playbackStarted) {
        playbackStarted = false
        scope.launch { playback?.stop() }
    }
}

/** Terminal teardown (logout/SDK close): suspend + free the native codecs. */
fun dispose() {
    log.info("dispose")
    suspendPlayback()
    opusDecoder.close()
    opusEncoder.close()
}
```

Keep the rest of `release()`'s body folded into `dispose()`. Update the single caller chain (Phase B wires which one each disconnect uses).

- [ ] **A4 — Test the lifecycle contract** (`DecoderLifecycleTest`, commonTest, fake port):
  - `reset_after_close_is_a_noop_not_a_crash` — close → reset → no exception (drive the real `OpusDownlinkDecoder` is not possible on JVM; instead assert the **LazyOpusDecoderPort** contract: close then reset does not touch a closed delegate, and a following decode rebuilds).
  - `decode_after_close_rebuilds_a_fresh_decoder` — given a counting factory, `decode → close → decode` instantiates the factory twice.
  - `suspend_keeps_decoder_then_resume_decodes` — pipeline `suspendPlayback()` does not close; a subsequent `onAudioFrame` still decodes (factory instantiated once).

- [ ] **A5 — Commit.** `git commit -m "fix(mobile-sdk): opus decoder survives reconnect (guard reset, rebuild after close, split pipeline suspend/dispose)"`

---

## Phase B — Audio lifecycle manager (encapsulation)

**Files:**
- Modify: `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/sdk/SdkAudio.kt`
- Modify: `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/sdk/SentientSdk.kt`

- [ ] **B1 — Make `SdkAudio` the explicit audio lifecycle manager.** Replace the single `release()` with named lifecycle ops mapping to Phase A:

```kotlin
/** Transient: connection dropped for a reconnect/idle — keep native codecs, stop playback. */
fun suspendForReconnect() = pipeline.suspendPlayback()

/** Re-arm after a reconnect — ensure the engine/session can run again on the next cycle. */
fun resumeAfterReconnect() { /* no-op today; SharedAudioEngine re-asserts setActive on retain */ }

/** Terminal: logout/SDK close — free native codecs. */
fun dispose() = pipeline.dispose()
```

Document on the class that audio teardown has exactly two flavors (transient vs terminal) and only `dispose()` frees native.

- [ ] **B2 — Wire `SentientSdk.disconnect(clearSession)` to the right flavor.** Replace `audio.release()`:

```kotlin
fun disconnect(clearSession: Boolean = true) {
    ...
    connectors.sessions.reset()
    if (clearSession) audio.dispose() else audio.suspendForReconnect()   // <-- transient vs terminal
    lifecycle.teardown()
    ...
}
```

`clearSession=false` (idle-disconnect, and the future probe-triggered reconnect) now keeps the decoder; `clearSession=true` (logout) frees it.

- [ ] **B3 — Commit.** `git commit -m "refactor(mobile-sdk): SdkAudio owns audio lifecycle (suspend vs dispose); disconnect picks by clearSession"`

---

## Phase C — Connection lifecycle: keep the socket on brief background, foreground-probe

**Files:**
- Modify: `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/sdk/SentientSdk.kt` (+ `SdkLifecycle.kt` hooks if needed)
- Modify: `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/sdk/SdkConfig.kt` (probe timeout tunable)
- Modify: `shared/mobile-data/.../di/IosUserSession.ios.kt` + `AndroidUserSession`/`UserSessionManager`
- Modify: `ios/App/Nav/UserSessionHost.swift`, `ios/App/Session/UserSession.swift`
- Modify: `android/.../di/UserSessionManager.kt`, `android/.../presence/PresenceCoordinator.kt`
- Modify rules: `.claude/rules/mobile-data/session-lifecycle.md`, `.claude/rules/mobile/mobile-lifecycle.md`
- Test: `shared/mobile-sdk/src/commonTest/.../sdk/ForegroundProbeTest.kt` (new)

- [ ] **C1 — Add a foreground probe to the SDK.** New public `fun onForeground()` (or `probeOrReconnect()`): if status is not READY, just `forceReconnect()`. If READY, send `ClientMessage.Ping`, await `ServerMessage.Pong` within `cfg.foregroundProbeTimeoutMs`; on timeout, `forceReconnect()`; on pong, no-op. Reuse the existing `Ping`/`Pong` frames and a one-shot `CompletableDeferred<Unit>`/`Channel` resolved by the pong handler. NO periodic heartbeat — fires once per foreground.

```kotlin
fun onForeground() {
    val st = deriver.status
    if (st != SdkStatus.READY) { log.info("foreground.not-ready → reconnect", mapOf("status" to st)); forceReconnect(); return }
    scope.launch {
        val ponged = probeOnce(cfg.foregroundProbeTimeoutMs)   // send Ping, await Pong or timeout
        if (!ponged) { log.warn("foreground.probe-timeout → reconnect", mapOf("timeoutMs" to cfg.foregroundProbeTimeoutMs)); forceReconnect() }
        else log.info("foreground.probe-pong (socket alive)")
    }
}
```

The pong handler resolves the in-flight probe deferred (route `ServerMessage.Pong` → `pendingProbe?.complete()`).

- [ ] **C2 — Config: `foregroundProbeTimeoutMs`.** Add to `SdkConfig` (default `3_000L`, valid ~1000–10000ms; one-shot so battery-cheap; tune later without rebuild). Inline comment per config rule. (Reuses the spirit of `ReconnectConfig.probePingTimeoutMs`; keep one source — prefer adding to the config the relay reads.)

- [ ] **C3 — iOS relay: stop dropping on background; probe on foreground.**
  - `IosUserSession.pause()` → **no-op** (drop the `sdk.disconnect`); keep `resume()` → `sdk.onForeground()` (was `forceReconnect()`).
  - `UserSession.pause()`/`resume()` forward unchanged to inner.
  - `UserSessionHost.onChange(scenePhase)`: `.background` → set `hasBackgrounded=true`, **do not** call pause's disconnect (call the now-noop pause or nothing); `.active` after background → `userSession.resume()` (probe). Keep the cold-start-skip.

- [ ] **C4 — Android relay: same.** `UserSessionManager`/`PresenceCoordinator`: background → no disconnect; foreground → `sdk.onForeground()`. Keep ProcessLifecycle cold-start-skip parity.

- [ ] **C5 — Update the lifecycle rules** to the new contract: brief background keeps the socket; foreground sends a one-shot probe; reconnect + `session.switch`-resume only when the probe fails / the socket is dead. Note the gateway keeps the session + ACP wire on detach and has no server ping/timeout (so the live socket is safe to keep).

- [ ] **C6 — Test `ForegroundProbeTest`** (commonTest, FakeWebSocketEngine): READY + pong-in-window → no reconnect, no new open; READY + no pong → forceReconnect (second open); not-READY → forceReconnect immediately.

- [ ] **C7 — Commit.** `git commit -m "feat(mobile): keep WS on brief background; foreground one-shot probe reconnects only if dead"`

---

## Phase D — Switch/resume autosnap (#4)

**Files:**
- Modify: `ios/App/Chat/message/MessageList.swift`

- [ ] **D1 — Snap to bottom when a snapshot finishes loading.** The "sometimes" miss is a `LazyVStack` + `scrollTo` race on a batch snapshot. Drive an explicit bottom-snap on the history-load completion edge, keeping the pin FSM. Add a `historyLoading: Bool` input to `MessageList` (from `vm.state.historyLoading`) and:

```swift
.onChange(of: historyLoading) { _, loading in
    if !loading {                       // snapshot just landed
        DispatchQueue.main.async { scrollToBottom(proxy, animated: false) }  // after the lazy layout pass
    }
}
```

Also keep the existing `onChange(of: messages.count)` pin. (With Phase C, quick bg/fg no longer reloads, so this is mainly the switch case.)

- [ ] **D2 — Commit.** `git commit -m "fix(ios): snap chat to bottom when a session snapshot finishes loading"`

---

## Phase E — Small UI: drawer top inset (#3) + speaker route (#6)

**Files:**
- Modify: `ios/App/Chat/drawer/SideDrawer.swift`
- Modify: `shared/mobile-sdk/src/iosMain/.../audioio/SharedAudioEngine.ios.kt`

- [ ] **E1 — Drawer content clears the status bar.** The drawer panel ignores the safe area on all edges, so the header renders under the clock. Bleed only the bottom:

```swift
drawer()
    .frame(width: drawerWidth)
    .frame(maxHeight: .infinity)
    .offset(x: drawerX)
    .gesture(closeDrag(drawerWidth: drawerWidth))
    .ignoresSafeArea(.container, edges: .bottom)   // was .ignoresSafeArea() — keep bottom bleed, respect top
```

Verify the full-bleed background still covers the status-bar strip (it is a separate `.background(DuskColors.bg.ignoresSafeArea())` in ChatView). If a gap appears at the very top, add `.padding(.top, geo.safeAreaInsets.top)` to the panel content instead.

- [ ] **E2 — Route TTS to the loud speaker (keep AEC).** `.voiceChat` mode overrides `defaultToSpeaker` → earpiece. After `setActive(true)`, force the speaker port (canonical speakerphone toggle; keeps voice-processing AEC):

```kotlin
import platform.AVFAudio.AVAudioSessionPortOverrideSpeaker
// ... in configureSession(), after a successful setActive(true):
val routed = session.overrideOutputAudioPort(AVAudioSessionPortOverrideSpeaker, errVar.ptr)
if (!routed) log.warn("session-speaker-override-failed", mapOf("error" to (errVar.value?.localizedDescription ?: "unknown")))
else log.debug("session-active", mapOf("override" to "speaker"))
```

Re-asserted every retain (configureSession runs each retain), so a route change after an interruption re-forces the speaker.

- [ ] **E3 — Commit.** `git commit -m "fix(ios): drawer clears status bar; route TTS to the loud speaker (keep AEC)"`

> #1 (pill bubble width cap) + #2 (drawer snap-from-release-point) are already implemented on this branch (uncommitted). Commit them as `fix(ios): cap bubble width to viewport so tool pills never overflow; drawer snaps from finger-release point` before/with Phase E.

---

## Phase F — Build + E2E both platforms

- [ ] **F1 — Quality gate (mobile):** mobile-sdk + mobile-data unit tests green; Android lint/build; iOS builds **signed** (NEVER `CODE_SIGNING_ALLOWED=NO`). Rebuild the XCFramework so iOS picks up the SDK changes.
- [ ] **F2 — Run the E2E matrix above** against the local Docker stack (`deploy/macos/`). Android = Maestro + adb logcat; iOS = Maestro + simctl + os_log. Capture evidence under the mobile QA dir.
- [ ] **F3 — Honest handover:** every row green or explicitly flagged (e.g. `bgfg-long-reconnect` needs a >60s background which Maestro can script via `pressKey`/background; if the harness can't kill the socket deterministically, verify manually + note it). No partial green claimed as green.

---

## Self-review notes
- Decoder fix (A) is the load-bearing change — it fixes TTS on **every** reconnect path, not just bg/fg. Land + verify it first.
- Phase C changes the documented `pause = drop socket` contract → rules updated in C5; keep web-sdk parity note (web has no app-lifecycle, so this is mobile-only).
- No tuned audio constants (echo/VAD thresholds, sample rates) are touched. Only the output **route** (E2) and the decoder **lifecycle** (A) change.
