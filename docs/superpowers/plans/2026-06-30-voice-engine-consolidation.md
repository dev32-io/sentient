# Voice Engine Consolidation — `VoiceAudio` one-engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the split iOS two-engine audio design (`SharedAudioEngine` + `StandalonePlaybackEngine`, `MicSource` + `AudioPlaybackAdapter`) with one boundary interface `VoiceAudio` whose single `configure(mic, playback)` reconfigures one engine graph — killing the `StartIO`-on-dirty-session, disconnected-player, and no-AEC echo bug classes by construction.

**Architecture:** One `AVAudioEngine` (iOS) / one `AudioRecord`+`AudioTrack` pair (Android) behind a single commonMain `VoiceAudio` interface. Toggling mic/TTS is one idempotent `configure(mic, playback)` that diffs the desired graph, stops, reconfigures, and restarts — VPIO (AEC) only in the `mic && playback` cell. The SDK's `startMic`/`stopMic`/`setTtsEnabled` translate to `configure` calls serialized through `SdkVoice`'s existing ordered command lane. Pure graph-diff logic is a commonMain function unit-tested in commonTest; platform actuals are device-verified (sim has no mic).

**Tech Stack:** Kotlin Multiplatform (`shared/mobile-sdk`), `commonMain`/`iosMain`/`androidMain`/`commonTest`; AVFoundation (iOS), `AudioRecord`/`AudioTrack` (Android); kotlinx-coroutines `Flow`/`StateFlow`/`Channel`; kotlin-test + kotlinx-coroutines-test in commonTest. SKIE-built XCFramework (iOS), Android library (Android).

## Global Constraints

- **Branch:** `feature/mobile-audio-input-stt` (extends PR #15). One slice; old two-engine code deleted in the same slice (git history is the reference).
- **Tuned constants are frozen.** `DEFAULT_INPUT_SAMPLE_RATE = 16_000`, `DEFAULT_OUTPUT_SAMPLE_RATE = 24_000`, `OPUS_DECODE_RATE_HZ = 48_000`, the `EchoGate`/`SpeechGate`/`Onset` thresholds — do NOT change any value. `VoiceAudio.configure` takes `playbackRateHz: Int = 48_000` (the existing opus decode rate) as a default so the live opus path is byte-identical. Per the user: changing these breaks things.
- **Accepted narrowing (flagged):** the player is now prepared at configure time at 48 kHz. The rare `pcm16`-passthrough downlink path (announced rate ≠ 48 k) previously played at the announced rate; it now plays at 48 k. The gateway is end-to-end Opus (see `project_mobile_opus_gap`), so `pcm16` mode is dead in production. Do not add code to handle non-48k `pcm16` — if it ever arrives, surface it as a `Phase.Error`, not a silent rate mismatch.
- **commonMain purity:** `VoiceAudio`, `VoiceAudioState`, `VoiceAudioGraph`, and the pure diff fn live in `commonMain` with NO platform imports. Platform types (`AVAudioEngine`, `AudioRecord`) never cross the boundary — only `ByteArray`/`ShortArray`/`Flow`/`StateFlow`.
- **expect/actual pattern:** `VoiceAudio` is a plain `interface` in commonMain (mirrors how `MicSource`/`AudioPlaybackAdapter` are defined today); platform actuals are `class IosVoiceAudio : VoiceAudio` / `class AndroidVoiceAudio : VoiceAudio`, instantiated by `createPlatformBundle()`. No `expect/actual` needed.
- **No-crash contract:** every failure path → `Phase.Error(reason)`, NEVER a throw across `@ObjCExport`. iOS uses the existing `ObjCExceptionGuard` (`enginePrepareGuarded`/`engineStartGuarded`) before AV calls. Android uses typed `Acquisition`/`Result` returns, never throws.
- **Logging:** `createLogger("voice", "engine", "ios"|"android")`; log every `configure` diff + phase transition + VPIO on/off + teardown; lengths/counts/ids only, NEVER audio content (keeps `PrivacyGuardTest` green).
- **Serialization:** `configure` is driven ONLY from `SdkVoice`'s single ordered command consumer (the existing `Channel<Cmd>(UNLIMITED)` lane). No second engine, no session handoff, no `setActive(false)`-deferral.
- **Testing scope (user-directed):** E2E/device cases are USER-owned (sim has no mic; echo/AEC is audible-only) and are NOT in this plan. This plan covers only the agent-runnable unit tests: commonTest pure-diff + fakes + pipeline/SdkVoice/SdkAudio against `FakeVoiceAudio`. The inline E2E matrix is omitted per user instruction; device verification is handed to the user at slice end.
- **Test commands:**
  - commonTest/JVM host: `./gradlew :shared:mobile-sdk:testDebugUnitTest`
  - iOS actual compile: `./gradlew :shared:mobile-sdk:compileKotlinIosSimulatorArm64`
  - Android actual compile: `./gradlew :shared:mobile-sdk:compileDebugKotlinAndroid`
  - iOS sim test (only `OpusRoundTripTest`, not touched here): `./gradlew :shared:mobile-sdk:iosSimulatorArm64Test`
  - Source the project env first: `source /Users/kevinye/Development/sentient/scripts/env.sh` (only needed for `bun`/gateway; gradle runs without it).
- **File-size limits:** every new file ≤ 300 lines, functions ≤ 40 lines (per `.claude/rules/clean-code.md`). The iOS actual will be the largest — split internal helpers (`VoiceAudioSession`, `VoiceAudioGraphBuilder`) if it approaches 300.

---

## File Structure

**Create (commonMain):**
- `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/voice/io/VoiceAudio.kt` — the `VoiceAudio` interface + `VoiceAudioState` + `Phase`. The single boundary.
- `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/voice/io/VoiceAudioGraph.kt` — the pure `(mic, playback) → graph` diff decision + `VoiceAudioGraph` data class.
- `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/audioio/VoicePlaybackSink.kt` — the downlink-facing slice of `VoiceAudio` (`playFrame`/`flushPlayback`/`isPlaybackIdle`), so `AudioPipeline` depends on a 3-method slice, not the whole engine interface.

**Create (commonTest):**
- `shared/mobile-sdk/src/commonTest/kotlin/io/sentient/mobilesdk/voice/io/FakeVoiceAudio.kt` — in-memory `VoiceAudio` for all commonTest pipelines; replaces `FakeMicSource` + the private `FakePlayback` classes.
- `shared/mobile-sdk/src/commonTest/kotlin/io/sentient/mobilesdk/voice/io/VoiceAudioGraphTest.kt` — pure diff matrix test.

**Create (iosMain):**
- `shared/mobile-sdk/src/iosMain/kotlin/io/sentient/mobilesdk/voice/io/VoiceAudio.ios.kt` — one `AVAudioEngine`, `.playAndRecord`+`.voiceChat` session, VPIO iff `mic && playback`, convert-in-tap, `AVAudioPlayerNode`→`mainMixerNode`.

**Create (androidMain):**
- `shared/mobile-sdk/src/androidMain/kotlin/io/sentient/mobilesdk/voice/io/VoiceAudio.android.kt` — `AudioRecord` + `AudioTrack`; `VOICE_COMMUNICATION` source iff `mic && playback`, else `VOICE_RECOGNITION`.

**Modify:**
- `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/voice/VoiceUplinkPipeline.kt` — consume `Flow<ShortArray>` (from `voiceAudio.micFrames`); drop `mic.start()`/`mic.stop()`.
- `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/audioio/AudioPipeline.kt` — talk to `VoicePlaybackSink` (`playFrame`/`flushPlayback`/`isPlaybackIdle`); drop `playback.start(rate)`.
- `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/sdk/SdkVoice.kt` — extend the ordered `Cmd` lane to carry `Configure(mic, playback)`; own the single serialized reconfig; emit `audio.start`/`audio.end` on mic edges.
- `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/sdk/SdkAudio.kt` — build `AudioPipeline` with the `VoicePlaybackSink` from `voiceAudio`; drop the `AudioPlaybackAdapter` dependency.
- `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/sdk/PlatformBundle.kt` — add `voiceAudio: VoiceAudio?`; (T11) remove `mic`/`playback`.
- `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/sdk/SentientSdk.kt` — `startMic`/`stopMic`/`setTtsEnabled` → `voice.requestConfigure(...)`; wire `bundle.voiceAudio`.
- `shared/mobile-sdk/src/iosMain/kotlin/io/sentient/mobilesdk/sdk/PlatformBundle.ios.kt` — construct `IosVoiceAudio`; (T11) drop old adapters.
- `shared/mobile-sdk/src/androidMain/kotlin/io/sentient/mobilesdk/sdk/PlatformBundle.android.kt` — construct `AndroidVoiceAudio`; (T11) drop old adapters.
- `shared/mobile-sdk/src/commonTest/kotlin/io/sentient/mobilesdk/audioio/AudioPipelineTest.kt` — switch the private `FakePlayback` to `FakeVoiceAudio`-as-`VoicePlaybackSink`.
- `shared/mobile-sdk/src/commonTest/kotlin/io/sentient/mobilesdk/audioio/AudioPipelineDownlinkTest.kt` — replace `FakeSlowPlayback`/`FakeInstantPlayback` with `FakeVoiceAudio` variants; drop the async-start buffering tests (player is pre-started by `configure`).
- `shared/mobile-sdk/src/commonTest/kotlin/io/sentient/mobilesdk/voice/VoiceUplinkPipelineTest.kt` — feed `FakeVoiceAudio.micFrames` instead of `FakeMicSource.frames`.

**Delete (T11 — same slice, git history is the reference):**
- `shared/mobile-sdk/src/iosMain/kotlin/io/sentient/mobilesdk/audioio/SharedAudioEngine.ios.kt`
- `shared/mobile-sdk/src/iosMain/kotlin/io/sentient/mobilesdk/audioio/StandalonePlaybackEngine.ios.kt`
- `shared/mobile-sdk/src/iosMain/kotlin/io/sentient/mobilesdk/voice/io/IosMicSource.kt`
- `shared/mobile-sdk/src/iosMain/kotlin/io/sentient/mobilesdk/audioio/AudioPlaybackAdapter.ios.kt`
- `shared/mobile-sdk/src/androidMain/kotlin/io/sentient/mobilesdk/voice/io/AndroidMicSource.kt`
- `shared/mobile-sdk/src/androidMain/kotlin/io/sentient/mobilesdk/voice/io/MicAudioRecordSession.android.kt`
- `shared/mobile-sdk/src/androidMain/kotlin/io/sentient/mobilesdk/audioio/AudioPlaybackAdapter.android.kt`
- `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/voice/io/MicSource.kt` (interface)
- `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/audioio/AudioPlaybackAdapter.kt` (interface)
- `shared/mobile-sdk/src/commonTest/kotlin/io/sentient/mobilesdk/voice/io/FakeMicSource.kt` + `FakeMicSourceTest.kt`

**Keep (reused, NOT touched):** `Pcm16Converter.ios.kt`, `Pcm16FloatBuffer.ios.kt`, `ObjCExceptionGuard.ios.kt`, `Pcm16Resampler` (in `CaptureSession.android.kt`), `ByteRing`/`PlaybackResampler` (in `PlaybackBuffer.android.kt`), `OpusUplinkEncoder`, `OggOpusDemuxer`, `OpusDownlinkDecoder`, `AudioCodec`, `PcmConvert`, `Framer`, `OnsetDetector`, `VoiceFsm`, `MicState`, the `voice/` uplink pipeline, `SdkVoice`'s ordered-actor design.

---

## Task 1: `VoiceAudio` interface + `VoiceAudioState` (commonMain)

**Files:**
- Create: `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/voice/io/VoiceAudio.kt`

**Interfaces:**
- Produces: `interface VoiceAudio`, `data class VoiceAudioState`, `enum class Phase`. Later tasks (`VoiceAudioGraph`, `FakeVoiceAudio`, platform actuals, `PlatformBundle`, `SdkVoice`, `SdkAudio`) consume these names verbatim.

- [ ] **Step 1: Write the boundary file**

```kotlin
package io.sentient.mobilesdk.voice.io

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.StateFlow

/**
 * The single audio-engine boundary for the SDK. ONE engine (iOS: one AVAudioEngine;
 * Android: one AudioRecord + one AudioTrack) serves every (mic, playback) state.
 * Callers never see AVAudioEngine / VPIO / AudioRecord — full encapsulation, matching
 * the SDK's black-box philosophy.
 *
 * Toggle is ONE idempotent [configure] call: it diffs the desired graph against the
 * current graph, stops the engine, reconfigures (tap / player / VPIO), and restarts.
 * No second engine, no AVAudioSession handoff — the StartIO-on-dirty-session bug
 * class is deleted by construction.
 */
interface VoiceAudio {
    /** Continuous readiness state (StateFlow — conflation fine). UI: spinner on Configuring. */
    val state: StateFlow<VoiceAudioState>

    /** 16k mono PCM16 capture frames. Hot ONLY while micActive; bounded, drop-newest. */
    val micFrames: Flow<ShortArray>

    /**
     * THE reconfig call. Idempotent — no-op if already in (mic, playback). Diffs +
     * reconfigures the single engine (stop → reconfigure → start). Suspends until the
     * reconfigure settles (→ Ready) or fails (→ Error). Never throws.
     *
     * @param playbackRateHz Player prepare rate. Defaults to 48_000 (libopus decode rate;
     *   the gateway is end-to-end Opus). Do not pass a non-48k rate unless a future
     *   pcm16 passthrough stream requires it (currently dead in production).
     */
    suspend fun configure(mic: Boolean, playback: Boolean, playbackRateHz: Int = 48_000)

    /** Downlink sink: one PCM16 LE frame → playback. No-op if playbackActive is false. */
    fun playFrame(pcm16: ByteArray)

    /** Flush queued playback (barge-in / interrupt drop-guard). */
    fun flushPlayback()

    /** Idle when no scheduled buffer remains (pipeline holds "speaking" until the tail drains). */
    val isPlaybackIdle: Boolean

    /** Terminal teardown: stop engine + deactivate session + release. */
    suspend fun shutdown()
}

/** Reactive engine readiness for the UI + the SDK reconfig surface. */
data class VoiceAudioState(
    val phase: Phase,
    val micActive: Boolean,
    val playbackActive: Boolean,
    val errorReason: String? = null,
) {
    enum class Phase { Idle, Configuring, Ready, Error }
}
```

- [ ] **Step 2: Verify commonMain compiles**

Run: `./gradlew :shared:mobile-sdk:compileKotlinMetadata` (or `:compileKotlinJvm` if metadata task unavailable — use `:shared:mobile-sdk:metadataJar`).
Expected: BUILD SUCCESSFUL. Nothing references `VoiceAudio` yet, so this is a pure additive compile check.

- [ ] **Step 3: Commit**

```bash
git add shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/voice/io/VoiceAudio.kt
git commit -m "feat(mobile-sdk): VoiceAudio boundary interface + VoiceAudioState"
```

---

## Task 2: Pure `(mic, playback) → graph` diff + unit test (TDD)

**Files:**
- Create: `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/voice/io/VoiceAudioGraph.kt`
- Test: `shared/mobile-sdk/src/commonTest/kotlin/io/sentient/mobilesdk/voice/io/VoiceAudioGraphTest.kt`

**Interfaces:**
- Produces: `data class VoiceAudioGraph(inputTap, player, vpio, output, running)` + `internal fun voiceAudioGraph(mic, playback): VoiceAudioGraph`. iOS + Android actuals (T4/T5) consume this to decide what to reconfigure; `FakeVoiceAudio` (T3) consumes it to compute the next state.

- [ ] **Step 1: Write the failing test**

```kotlin
package io.sentient.mobilesdk.voice.io

import kotlin.test.Test
import kotlin.test.assertEquals

class VoiceAudioGraphTest {

    @Test
    fun off_off_tears_down() {
        val g = voiceAudioGraph(mic = false, playback = false)
        assertEquals(VoiceAudioGraph(inputTap = false, player = false, vpio = false, output = false, running = false), g)
    }

    @Test
    fun off_on_player_only_no_vpio() {
        val g = voiceAudioGraph(mic = false, playback = true)
        assertEquals(VoiceAudioGraph(inputTap = false, player = true, vpio = false, output = true, running = true), g)
    }

    @Test
    fun on_off_mic_tap_no_vpio_no_echo_source() {
        val g = voiceAudioGraph(mic = true, playback = false)
        assertEquals(VoiceAudioGraph(inputTap = true, player = false, vpio = false, output = true, running = true), g)
    }

    @Test
    fun on_on_full_duplex_vpio_on() {
        val g = voiceAudioGraph(mic = true, playback = true)
        assertEquals(VoiceAudioGraph(inputTap = true, player = true, vpio = true, output = true, running = true), g)
    }

    @Test
    fun vpio_only_when_both_axes_active() {
        // VPIO is enabled EXACTLY when there is echo to cancel (mic + playback).
        listOf(false to false, true to false, false to true).forEach { (mic, pb) ->
            assertEquals(false, voiceAudioGraph(mic, pb).vpio, "vpio must be off for ($mic,$pb)")
        }
        assertEquals(true, voiceAudioGraph(true, true).vpio)
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./gradlew :shared:mobile-sdk:testDebugUnitTest --tests "io.sentient.mobilesdk.voice.io.VoiceAudioGraphTest"`
Expected: FAIL — `voiceAudioGraph` / `VoiceAudioGraph` unresolved.

- [ ] **Step 3: Write minimal implementation**

```kotlin
package io.sentient.mobilesdk.voice.io

/**
 * The desired single-engine graph for one (mic, playback) cell. The pure decision
 * [voiceAudioGraph] is the source of truth shared by BOTH platform actuals (iOS +
 * Android) and [FakeVoiceAudio], so the matrix is pinned by commonTest, not device
 * tests. See the design table:
 *
 *   (mic, tts) | inputTap | player | VPIO | output | running |
 *   off, off   | —        | —      | —    | —      | torn down
 *   off, on    | —        | ✓      | off  | ✓      | running
 *   on, off    | ✓        | —      | off  | ✓      | running
 *   on, on     | ✓        | ✓      | on   | ✓      | running (full-duplex AEC)
 */
data class VoiceAudioGraph(
    val inputTap: Boolean,
    val player: Boolean,
    val vpio: Boolean,
    val output: Boolean,
    val running: Boolean,
)

/** The pure (mic, playback) → graph decision. No platform deps; unit-tested in commonTest. */
internal fun voiceAudioGraph(mic: Boolean, playback: Boolean): VoiceAudioGraph {
    val active = mic || playback
    return VoiceAudioGraph(
        inputTap = mic,
        player = playback,
        // AEC enabled exactly when there is echo to cancel (mic captures the TTS output).
        vpio = mic && playback,
        // Output graph is referenced whenever a player is (or will be) attached, so the
        // player never starts "disconnected" (the interim 2633b4e crash fix, now structural).
        output = active,
        running = active,
    )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `./gradlew :shared:mobile-sdk:testDebugUnitTest --tests "io.sentient.mobilesdk.voice.io.VoiceAudioGraphTest"`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/voice/io/VoiceAudioGraph.kt \
        shared/mobile-sdk/src/commonTest/kotlin/io/sentient/mobilesdk/voice/io/VoiceAudioGraphTest.kt
git commit -m "feat(mobile-sdk): pure VoiceAudioGraph (mic,playback)->graph diff + tests"
```

---

## Task 3: `FakeVoiceAudio` (commonTest)

**Files:**
- Create: `shared/mobile-sdk/src/commonTest/kotlin/io/sentient/mobilesdk/voice/io/FakeVoiceAudio.kt`

**Interfaces:**
- Consumes: `VoiceAudio`, `VoiceAudioState`, `Phase`, `voiceAudioGraph` (Task 1/2).
- Produces: `class FakeVoiceAudio : VoiceAudio`. Used by `AudioPipelineTest`, `AudioPipelineDownlinkTest`, `VoiceUplinkPipelineTest`, `SdkVoiceTest`. Public surface: `emit(pcm)` to push mic frames; `playedFrames`/`configureCalls`/`flushCount` for assertions; `setPlaybackIdle(b)` to drive drain-watch tests.

- [ ] **Step 1: Write the fake**

```kotlin
package io.sentient.mobilesdk.voice.io

import io.sentient.mobilesdk.voice.MicState
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.receiveAsFlow

/**
 * In-memory VoiceAudio for commonTest. Models the real contract:
 *  - configure() is idempotent + records every call (incl. the diff) for ordering tests;
 *  - micFrames is a bounded drop-newest channel (mirrors the real producer backpressure);
 *  - playFrame appends to playedFrames; flushPlayback clears them + marks idle;
 *  - isPlaybackIdle flips false on the first playFrame, true again after flushPlayback or
 *    when the test drains via setPlaybackIdle(true) to advance the downlink drain-watch.
 *
 * No device, no real clock. Replaces FakeMicSource + the per-test FakePlayback classes.
 */
class FakeVoiceAudio(
    private val micChannelCapacity: Int = 8,
    initialPlaybackIdle: Boolean = true,
) : VoiceAudio {
    private val _state = MutableStateFlow(VoiceAudioState(Phase.Idle, micActive = false, playbackActive = false))
    override val state: StateFlow<VoiceAudioState> = _state

    private val micCh = Channel<ShortArray>(capacity = micChannelCapacity)
    override val micFrames = micCh.receiveAsFlow()

    private val _micState = MutableStateFlow(MicState.Idle)

    val configureCalls = mutableListOf<Triple<Boolean, Boolean, Int>>()
    val playedFrames = mutableListOf<ByteArray>()
    var flushCount = 0
        private set
    var playbackIdle = initialPlaybackIdle
        private set

    /** Push a mic frame; returns false if dropped (channel full) — drop-newest. */
    fun emit(pcm: ShortArray): Boolean = micCh.trySend(pcm).isSuccess

    /** Test hook to advance the downlink drain-watch (real adapter self-drains). */
    fun setPlaybackIdle(idle: Boolean) { playbackIdle = idle }

    override suspend fun configure(mic: Boolean, playback: Boolean, playbackRateHz: Int) {
        configureCalls += Triple(mic, playback, playbackRateHz)
        _state.value = VoiceAudioState(Phase.Configuring, micActive = mic, playbackActive = playback)
        // The pure graph decision is the shared source of truth — exercise it here so the
        // fake mirrors the real engine's vpio/running behavior without a device.
        voiceAudioGraph(mic, playback)
        _state.value = VoiceAudioState(Phase.Ready, micActive = mic, playbackActive = playback)
        _micState.value = if (mic) MicState.Live else MicState.Idle
    }

    override fun playFrame(pcm16: ByteArray) {
        if (!_state.value.playbackActive) return
        playedFrames += pcm16
        playbackIdle = false
    }

    override fun flushPlayback() {
        flushCount += 1
        playedFrames.clear()
        playbackIdle = true
    }

    override val isPlaybackIdle: Boolean get() = playbackIdle

    override suspend fun shutdown() {
        _state.value = VoiceAudioState(Phase.Idle, micActive = false, playbackActive = false)
        _micState.value = MicState.Idle
        micCh.close()
    }
}
```

- [ ] **Step 2: Verify commonTest compiles**

Run: `./gradlew :shared:mobile-sdk:compileTestKotlinMetadata` (fallback: `:testDebugUnitTest --dry-run`)
Expected: BUILD SUCCESSFUL. (No direct fake test — fakes are exercised by the pipeline tests in T7/T8/T9. Per `.claude/rules/testing.md`, fakes that fail at the next consumer need no dedicated unit test.)

- [ ] **Step 3: Commit**

```bash
git add shared/mobile-sdk/src/commonTest/kotlin/io/sentient/mobilesdk/voice/io/FakeVoiceAudio.kt
git commit -m "test(mobile-sdk): FakeVoiceAudio commonTest double"
```

---

## Task 4: `VoiceAudio.ios` actual — one engine (device-verified)

> **Scope note:** This task writes the iOS platform actual. The contract-critical pieces (session category, VPIO toggle iff `mic && playback`, configure diff = stop→reconfigure→start, convert-in-tap feeding a bounded drop-newest channel, player→`mainMixerNode` so it never starts disconnected, `@ObjCExport` no-throw via `ObjCExceptionGuard`) are pinned below with real code. Standard AVFoundation wiring (format structs, buffer sizing) reuses the existing helpers from the deleted files — copy those proven snippets verbatim from `IosMicSource.kt` / `AudioPlaybackAdapter.ios.kt` before deleting them in T11. The actual is device-verified (sim has no mic) — the user owns device testing.

**Files:**
- Create: `shared/mobile-sdk/src/iosMain/kotlin/io/sentient/mobilesdk/voice/io/VoiceAudio.ios.kt`
- Reuse (read before deleting in T11): `iosMain/.../audioio/Pcm16Converter.ios.kt`, `Pcm16FloatBuffer.ios.kt`, `ObjCExceptionGuard.ios.kt`

**Interfaces:**
- Consumes: `VoiceAudio` (Task 1), `voiceAudioGraph` (Task 2), `Pcm16Converter`, `Pcm16FloatBuffer`, `ObjCExceptionGuard` (`enginePrepareGuarded`, `engineStartGuarded`).
- Produces: `class IosVoiceAudio : VoiceAudio`. Constructed by `PlatformBundle.ios.kt` (T6).

- [ ] **Step 1: Write the iOS actual**

Skeleton with the contract-critical pieces; copy the proven AVFoundation snippets (format setup, buffer sizing, the convert-in-tap body, the player→`mainMixerNode` schedule loop) from `IosMicSource.kt` (L114–316) and `AudioPlaybackAdapter.ios.kt` (L75–264) **before** T11 deletes them.

```kotlin
package io.sentient.mobilesdk.voice.io

import io.sentient.mobilesdk.audioio.ObjCExceptionGuard
import io.sentient.mobilesdk.audioio.Pcm16Converter
import io.sentient.mobilesdk.audioio.Pcm16FloatBuffer
import io.sentient.mobilesdk.log.createLogger
import kotlinx.cinterop.ObjCExport
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import platform.AVFAudio.AVAudioEngine
import platform.AVFAudio.AVAudioPlayerNode
import platform.AVFAudio.AVAudioSession
import platform.AVFAudio.AVAudioSessionCategoryPlayAndRecord
import platform.AVFAudio.AVAudioSessionModeVoiceChat
import platform.AVFAudio.setActive

private const val TARGET_SAMPLE_RATE_HZ = 16_000
private const val DEVICE_SAMPLE_RATE_HZ = 48_000
private const val FRAME_CHANNEL_CAPACITY = 16
private const val TAP_BUFFER_FRAMES = 1024uL

/**
 * ONE AVAudioEngine serving every (mic, playback) state. session = .playAndRecord +
 * .voiceChat, activated on first non-idle configure, deactivated at idle/shutdown.
 * configure() diffs [voiceAudioGraph] against the current graph: stop → reconfigure
 * (tap/player/VPIO) → ensureRunning. VPIO enabled ONLY in the mic+playback cell, and
 * only inside a stop→reconfigure→start (never on a live engine) → always starts on a
 * clean session (kills the StartIO-on-dirty-session bug class).
 */
class IosVoiceAudio : VoiceAudio {
    private val log = createLogger("voice", "engine", "ios")

    private val engine = AVAudioEngine()
    private val player = AVAudioPlayerNode()
    private val converter = Pcm16Converter(targetRate = TARGET_SAMPLE_RATE_HZ) // reuse existing 48k→16k

    private val _state = MutableStateFlow(VoiceAudioState(Phase.Idle, micActive = false, playbackActive = false))
    override val state: StateFlow<VoiceAudioState> = _state

    // Bounded SUSPEND channel; drop-newest via trySend (mirrors the old IosMicSource).
    private val micCh = Channel<ShortArray>(capacity = FRAME_CHANNEL_CAPACITY)
    override val micFrames: Flow<ShortArray> = micCh.receiveAsFlow()

    // The currently-applied graph; configure diffs against this.
    private var current: VoiceAudioGraph = voiceAudioGraph(mic = false, playback = false)
    private var outstandingBuffers = 0 // drain tracking for isPlaybackIdle

    @OptIn(ObjCExport::class)
    override suspend fun configure(mic: Boolean, playback: Boolean, playbackRateHz: Int) {
        val desired = voiceAudioGraph(mic, playback)
        if (desired == current) { log.debug("configure-noop", mapOf("mic" to mic, "playback" to playback)); return }
        log.info("configure", mapOf("mic" to mic, "playback" to playback, "vpio" to desired.vpio, "rate" to playbackRateHz))
        _state.value = _state.value.copy(phase = Phase.Configuring, micActive = mic, playbackActive = playback)
        runCatching {
            engine.stop()
            if (desired.running) activateSession()
            applyGraph(desired, playbackRateHz)
            if (desired.running) ensureRunning()
            current = desired
        }.onFailure { err ->
            _state.value = VoiceAudioState(Phase.Error, micActive = mic, playbackActive = playback, errorReason = err.message)
            log.warn("configure-failed", mapOf("reason" to (err.message ?: "unknown")))
            return
        }
        if (!desired.running) deactivateSession()
        _state.value = VoiceAudioState(Phase.Ready, micActive = mic, playbackActive = playback)
    }

    private fun activateSession() {
        val s = AVAudioSession.sharedInstance()
        s.setCategory(AVAudioSessionCategoryPlayAndRecord, mode = AVAudioSessionModeVoiceChat)
        // setActive(true) — copy the exact options/error-nil call from SharedAudioEngine.ios.kt
        s.setActive(true, error = null)
    }

    private fun deactivateSession() {
        AVAudioSession.sharedInstance().setActive(false, error = null)
    }

    /**
     * Apply the graph diff to the ONE engine. VPIO toggled ONLY here (inside a stop),
     * so it always starts on a clean session. Output graph (mainMixerNode) referenced
     * whenever a player is/will be attached → the player never starts disconnected.
     */
    private fun applyGraph(g: VoiceAudioGraph, rate: Int) {
        // VPIO: input.setVoiceProcessingEnabled(g.vpio) — copy the exact guarded call
        //   from SharedAudioEngine.ios.kt; only call when the desired vpio differs from
        //   current.vpio (never on a live engine — engine is stopped above).
        if (g.vpio != current.vpio) setInputVoiceProcessing(g.vpio)

        if (g.inputTap && !current.inputTap) installTap()     // convert-in-tap: 48k→16k
        if (!g.inputTap && current.inputTap) removeTap()

        if (g.player && !current.player) attachPlayer(rate)   // player → mainMixerNode
        if (!g.player && current.player) detachPlayer()
        // output graph: mainMixerNode is referenced in attachPlayer; engine.connect keeps
        // it alive while running. See AudioPlaybackAdapter.ios.kt mainMixerNode wiring.
    }

    private fun ensureRunning() {
        // engineStartGuarded(engine) — reuse ObjCExceptionGuard; never throw across @ObjCExport.
        ObjCExceptionGuard.run { engine.start() }
    }

    // ── Mic tap (48k→16k convert-in-tap, drop-newest) ────────────────────────────
    private fun installTap() {
        // Reuse the EXACT tap body from IosMicSource.kt L174–260: installTap on input,
        // AVAudioConverter 48k→16k via this.converter, push to micCh.trySend (drop-newest).
    }
    private fun removeTap() { engine.inputNode.removeTapOnInput() }

    // ── Playback (AVAudioPlayerNode → mainMixerNode) ──────────────────────────────
    private fun attachPlayer(rate: Int) {
        engine.attachNode(player)
        // engine.connect(player, engine.mainMixerNode, format@rate) — copy from
        // AudioPlaybackAdapter.ios.kt; connecting to mainMixerNode is the structural
        // fix for the "player started when disconnected" crash (interim 2633b4e).
    }
    private fun detachPlayer() { engine.detachNode(player); outstandingBuffers = 0 }

    override fun playFrame(pcm16: ByteArray) {
        if (!current.player) return
        // PCM16 LE → float buffer (Pcm16FloatBuffer) → scheduleBuffer on player.
        // outstandingBuffers++ on schedule, -- in the completionHandler → isPlaybackIdle.
        outstandingBuffers += 1
    }

    override fun flushPlayback() {
        player.stop()
        outstandingBuffers = 0
    }

    override val isPlaybackIdle: Boolean get() = outstandingBuffers == 0

    override suspend fun shutdown() {
        engine.stop()
        removeTap()
        detachPlayer()
        deactivateSession()
        micCh.close()
        _state.value = VoiceAudioState(Phase.Idle, micActive = false, playbackActive = false)
    }

    private fun setInputVoiceProcessing(enabled: Boolean) {
        // input.setVoiceProcessingEnabled(enabled) guarded by runCatching; log the flip.
        log.info("vpio", mapOf("enabled" to enabled))
    }

    // Wrap ObjC-throwing AV calls so failures become Phase.Error, never a throw.
    private inline fun ObjCExceptionGuard.run(block: () -> Unit) { enginePrepareGuarded { block() } }
}
```

> **Implementer note — fill the marked bodies verbatim from the soon-deleted files BEFORE T11:** `installTap` body ← `IosMicSource.kt` tap install + `Pcm16Converter` usage; `attachPlayer`/`playFrame`/schedule loop ← `AudioPlaybackAdapter.ios.kt`; `enginePrepareGuarded`/`engineStartGuarded` ← `ObjCExceptionGuard.ios.kt`. Do not improvise new AVFoundation code — the proven snippets are the point of the consolidation.

- [ ] **Step 2: Verify iOS actual compiles**

Run: `./gradlew :shared:mobile-sdk:compileKotlinIosSimulatorArm64`
Expected: BUILD SUCCESSFUL. (Not wired into PlatformBundle yet → no behavior change. Device mic run is user-owned.)

- [ ] **Step 3: Commit**

```bash
git add shared/mobile-sdk/src/iosMain/kotlin/io/sentient/mobilesdk/voice/io/VoiceAudio.ios.kt
git commit -m "feat(mobile-sdk): VoiceAudio.ios one-engine actual (VPIO iff mic+playback)"
```

---

## Task 5: `VoiceAudio.android` actual — `AudioRecord` + `AudioTrack` (device-verified)

> **Scope note:** Same as T4 — pin the contract-critical pieces (source = `VOICE_COMMUNICATION` iff `mic && playback` else `VOICE_RECOGNITION`, the configure open/close matrix, drop-newest channel, soft-fail typed errors) and copy the proven `AudioRecord` read-loop + `AudioTrack` write-ring snippets from the deleted files before T11. Device-verified.

**Files:**
- Create: `shared/mobile-sdk/src/androidMain/kotlin/io/sentient/mobilesdk/voice/io/VoiceAudio.android.kt`
- Reuse (read before T11 deletes): `androidMain/.../voice/io/AndroidMicSource.kt`, `MicAudioRecordSession.android.kt`, `audioio/AudioPlaybackAdapter.android.kt`, `CaptureSession.android.kt` (`Pcm16Resampler`), `PlaybackBuffer.android.kt` (`ByteRing`/`PlaybackResampler`).

**Interfaces:**
- Consumes: `VoiceAudio`, `voiceAudioGraph`, `Pcm16Resampler`, `ByteRing`, `PlaybackResampler`.
- Produces: `class AndroidVoiceAudio : VoiceAudio`. Constructed by `PlatformBundle.android.kt` (T6).

- [ ] **Step 1: Write the Android actual**

```kotlin
package io.sentient.mobilesdk.voice.io

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import io.sentient.mobilesdk.audioio.Pcm16Resampler
import io.sentient.mobilesdk.audioio.ByteRing
import io.sentient.mobilesdk.audioio.PlaybackResampler
import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.util.AndroidContextHolder
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.receiveAsFlow

private const val TARGET_SAMPLE_RATE_HZ = 16_000
private const val FRAME_CHANNEL_CAPACITY = 16

/**
 * ONE AudioRecord + ONE AudioTrack serving every (mic, playback) state. Android has
 * no shared-session fragility, so the two objects are independent; configure() opens/
 * closes each per the [voiceAudioGraph] matrix. Built-in HW AEC (VOICE_COMMUNICATION
 * source) is enabled EXACTLY in the mic+playback cell — the VPIO-equivalent.
 */
class AndroidVoiceAudio(
    private val context: Context = AndroidContextHolder.requireContext(),
) : VoiceAudio {
    private val log = createLogger("voice", "engine", "android")

    private val _state = MutableStateFlow(VoiceAudioState(Phase.Idle, micActive = false, playbackActive = false))
    override val state: StateFlow<VoiceAudioState> = _state

    private val micCh = Channel<ShortArray>(capacity = FRAME_CHANNEL_CAPACITY)
    override val micFrames: Flow<ShortArray> = micCh.receiveAsFlow()

    private var current: VoiceAudioGraph = voiceAudioGraph(false, false)
    private var record: AudioRecord? = null
    private var track: AudioTrack? = null
    private var recordThread: Thread? = null
    private val playbackRing = ByteRing() // reuse from PlaybackBuffer.android.kt

    override suspend fun configure(mic: Boolean, playback: Boolean, playbackRateHz: Int) {
        val desired = voiceAudioGraph(mic, playback)
        if (desired == current) return
        log.info("configure", mapOf("mic" to mic, "playback" to playback, "aec" to desired.vpio, "rate" to playbackRateHz))
        _state.value = _state.value.copy(phase = Phase.Configuring, micActive = mic, playbackActive = playback)
        runCatching {
            if (desired.inputTap != current.inputTap) {
                if (desired.inputTap) startRecord(aec = desired.vpio) else stopRecord()
            }
            if (desired.player != current.player) {
                if (desired.player) startTrack(playbackRateHz) else stopTrack()
            }
            current = desired
        }.onFailure { err ->
            _state.value = VoiceAudioState(Phase.Error, micActive = mic, playbackActive = playback, errorReason = err.message)
            log.warn("configure-failed", mapOf("reason" to (err.message ?: "unknown")))
            return
        }
        _state.value = VoiceAudioState(Phase.Ready, micActive = mic, playbackActive = playback)
    }

    /** HW AEC source iff mic && playback (the vpio cell); else VOICE_RECOGNITION. */
    private fun startRecord(aec: Boolean) {
        // Reuse MicAudioRecordSession.openMicAudioRecord + the URGENT_AUDIO read-loop from
        // AndroidMicSource.kt: source = if (aec) VOICE_COMMUNICATION else VOICE_RECOGNITION.
        // Read loop pushes 16k frames to micCh.trySend (drop-newest); soft-fail → Phase.Error.
    }
    private fun stopRecord() {
        recordThread?.interrupt(); recordThread?.join(); recordThread = null
        record?.release(); record = null
    }

    private fun startTrack(rate: Int) {
        // Reuse AudioTrack build from AudioPlaybackAdapter.android.kt: USAGE_VOICE_COMMUNICATION
        // + CONTENT_TYPE_SPEECH, mono PCM16, WRITE_NON_BLOCKING, PlaybackResampler when rate != device.
    }
    private fun stopTrack() { track?.flush(); track?.release(); track = null }

    override fun playFrame(pcm16: ByteArray) {
        if (!current.player) return
        // playbackRing.write(pcm16); track writes drain the ring — reuse the write loop.
    }
    override fun flushPlayback() { track?.flush(); playbackRing.clear() }
    override val isPlaybackIdle: Boolean get() = playbackRing.isEmpty

    override suspend fun shutdown() {
        stopRecord(); stopTrack()
        micCh.close()
        _state.value = VoiceAudioState(Phase.Idle, micActive = false, playbackActive = false)
    }
}
```

> **Implementer note — fill the marked bodies verbatim from the soon-deleted files BEFORE T11:** `startRecord`/read-loop ← `AndroidMicSource.kt` + `MicAudioRecordSession.openMicAudioRecord` (the typed `Acquisition` result); `startTrack`/`playFrame`/ring ← `AudioPlaybackAdapter.android.kt` + `ByteRing`/`PlaybackResampler`. Keep `THREAD_PRIORITY_URGENT_AUDIO` on the record thread.

- [ ] **Step 2: Verify Android actual compiles**

Run: `./gradlew :shared:mobile-sdk:compileDebugKotlinAndroid`
Expected: BUILD SUCCESSFUL. (Not wired yet → no behavior change. Device mic run is user-owned.)

- [ ] **Step 3: Commit**

```bash
git add shared/mobile-sdk/src/androidMain/kotlin/io/sentient/mobilesdk/voice/io/VoiceAudio.android.kt
git commit -m "feat(mobile-sdk): VoiceAudio.android actual (VOICE_COMMUNICATION AEC iff mic+playback)"
```

---

## Task 6: Wire `voiceAudio` into `PlatformBundle` (additive)

**Files:**
- Modify: `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/sdk/PlatformBundle.kt:40-47`
- Modify: `shared/mobile-sdk/src/iosMain/kotlin/io/sentient/mobilesdk/sdk/PlatformBundle.ios.kt:22`
- Modify: `shared/mobile-sdk/src/androidMain/kotlin/io/sentient/mobilesdk/sdk/PlatformBundle.android.kt:17`

**Interfaces:**
- Produces: `PlatformBundle.voiceAudio: VoiceAudio?`. T7/T8/T10 consume it. Old `mic`/`playback` stay until T11 (both present → build green, old still drives runtime).

- [ ] **Step 1: Add the field (commonMain)**

Edit `PlatformBundle.kt` — add `voiceAudio` before `playback`/`mic`:

```kotlin
data class PlatformBundle(
    val engine: WebSocketEngine,
    val tokenStore: SecureTokenStore,
    val deviceIdStore: DeviceIdStore,
    val clock: Clock,
    val voiceAudio: VoiceAudio? = null,
    val playback: AudioPlaybackAdapter? = null,
    val mic: MicSource? = null,
)
```

Add the import: `import io.sentient.mobilesdk.voice.io.VoiceAudio`.

- [ ] **Step 2: Construct it in the iOS actual**

Edit `PlatformBundle.ios.kt` L22 — add `voiceAudio = IosVoiceAudio()` to the `PlatformBundle(...)` call (keep `playback = IosAudioPlaybackAdapter()`, `mic = IosMicSource()` for now).

- [ ] **Step 3: Construct it in the Android actual**

Edit `PlatformBundle.android.kt` L17 — add `voiceAudio = AndroidVoiceAudio()` (keep old adapters).

- [ ] **Step 4: Verify all targets compile**

Run: `./gradlew :shared:mobile-sdk:compileKotlinIosSimulatorArm64 :shared:mobile-sdk:compileDebugKotlinAndroid :shared:mobile-sdk:metadataJar`
Expected: BUILD SUCCESSFUL. Old `mic`/`playback` still drive runtime; `voiceAudio` is dormant.

- [ ] **Step 5: Commit**

```bash
git add shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/sdk/PlatformBundle.kt \
        shared/mobile-sdk/src/iosMain/kotlin/io/sentient/mobilesdk/sdk/PlatformBundle.ios.kt \
        shared/mobile-sdk/src/androidMain/kotlin/io/sentient/mobilesdk/sdk/PlatformBundle.android.kt
git commit -m "feat(mobile-sdk): PlatformBundle.voiceAudio (additive, old adapters retained)"
```

---

## Task 7: Rewire the UPLINK axis — `VoiceUplinkPipeline` consumes `micFrames`

**Files:**
- Modify: `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/voice/VoiceUplinkPipeline.kt:23-54`
- Modify: `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/sdk/SdkVoice.kt:64-104` (constructor only — the configure lane is T9)
- Modify: `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/sdk/SentientSdk.kt:163-173`
- Test: `shared/mobile-sdk/src/commonTest/kotlin/io/sentient/mobilesdk/voice/VoiceUplinkPipelineTest.kt`

**Interfaces:**
- Consumes: `VoiceAudio.micFrames: Flow<ShortArray>` (Task 1).
- Produces: `VoiceUplinkPipeline(micFrames: Flow<ShortArray>, ...)` — `start()` now only starts the collect job; `stop()` cancels + resets the encoder. No `mic.start()`/`mic.stop()` (configure owns mic activation). `SdkVoice` ctor takes `voiceAudio: VoiceAudio?` instead of `mic: MicSource?`.

- [ ] **Step 1: Write the failing test (feed FakeVoiceAudio.micFrames)**

In `VoiceUplinkPipelineTest.kt`, replace the `FakeMicSource` fixture with `FakeVoiceAudio` and a fake `OpusEncoderPort`. Assert: emitting frames into `FakeVoiceAudio` while `micActive=true` produces N encoded packets via `sendPacket`; after `stop()`, the collect job is cancelled (no more packets from late emits).

```kotlin
package io.sentient.mobilesdk.voice

import io.sentient.mobilesdk.voice.io.FakeVoiceAudio
import io.sentient.mobilesdk.voice.uplink.Framer
import io.sentient.mobilesdk.voice.uplink.OnsetDetector
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class VoiceUplinkPipelineTest {
    // Reuse the existing FakeOpusEncoderPort if present; else inline a tiny one recording
    // encode() calls. See existing VoiceUplinkPipelineTest for the encoder fake already used.

    @Test
    fun emitted_frames_are_encoded_and_sent() = runTest {
        val mic = FakeVoiceAudio()
        mic.configure(mic = true, playback = false) // micActive → micFrames hot
        val sent = mutableListOf<ByteArray>()
        val encoder = FakeOpusEncoderPort()
        val pipe = VoiceUplinkPipeline(
            micFrames = mic.micFrames,
            encoder = encoder,
            sendPacket = { sent += it },
            onOnset = {},
            scope = CoroutineScope(Dispatchers.Unconfined),
            dispatcher = Dispatchers.Unconfined,
            framer = Framer(),
            onset = OnsetDetector(threshold = 0.0, sustainFrames = 1),
        )
        pipe.start()
        repeat(3) { mic.emit(ShortArray(FRAME_SAMPLES_16K) { 100 }) }
        // 3 frames @ 320 samples each → at least one 20ms frame pushed → >= 1 packet
        assertTrue(sent.isNotEmpty(), "expected encoded packets on the wire")
        pipe.stop()
    }
}
```

(If `FakeOpusEncoderPort` does not exist in `commonTest/.../fakes/`, inline a `class FakeOpusEncoderPort : OpusEncoderPort { val calls=mutableListOf<ShortArray>(); override fun encode(pcm)=listOf(pcm.toByteArray()); override fun reset(){}; override fun close(){} }` — check the existing `VoiceUplinkPipelineTest.kt` first and reuse its encoder fake to avoid a duplicate.)

- [ ] **Step 2: Run test to verify it fails**

Run: `./gradlew :shared:mobile-sdk:testDebugUnitTest --tests "io.sentient.mobilesdk.voice.VoiceUplinkPipelineTest"`
Expected: FAIL — `VoiceUplinkPipeline` ctor still takes `mic: MicSource`.

- [ ] **Step 3: Change `VoiceUplinkPipeline` to consume `Flow<ShortArray>`**

Edit `VoiceUplinkPipeline.kt` L23-54:

```kotlin
class VoiceUplinkPipeline(
    private val micFrames: Flow<ShortArray>,   // was: mic: MicSource
    private val encoder: OpusEncoderPort,
    private val sendPacket: (ByteArray) -> Unit,
    private val onOnset: () -> Unit,
    private val scope: CoroutineScope,
    private val dispatcher: CoroutineDispatcher,
    private val framer: Framer,
    private val onset: OnsetDetector,
) {
    private val log = createLogger("voice", "uplink")
    private var job: Job? = null
    private var framesIn = 0
    private var packetsOut = 0

    suspend fun start() {
        if (job?.isActive == true) return
        framer.reset(); onset.reset(); encoder.reset(); framesIn = 0; packetsOut = 0
        // No mic.start() — VoiceAudio.configure owns mic activation; micFrames is hot
        // ONLY while micActive, so the collect job simply forwards what the engine emits.
        job = scope.launch(dispatcher) {
            micFrames.collect { pcm -> onPcm(pcm) }
        }
    }

    suspend fun stop() {
        job?.cancelAndJoin(); job = null
        encoder.reset()
        // No mic.stop() — configure(mic=false) owns teardown.
    }
    // onPcm unchanged
}
```

Remove the `import ...voice.io.MicSource`. Keep all other imports.

- [ ] **Step 4: Update `SdkVoice` constructor (mic-axis only — the configure lane is T9)**

Edit `SdkVoice.kt` L64-104: change `mic: MicSource?` → `voiceAudio: VoiceAudio?`, and build the pipeline from `voiceAudio?.micFrames`:

```kotlin
class SdkVoice(
    private val voiceAudio: VoiceAudio?,          // was: mic: MicSource?
    audioConfig: AudioPipelineConfig,
    audioInput: () -> UserAudioInputConnector,
    private val onUplinkStart: () -> Unit,
    private val onUplinkStop: () -> Unit,
    scope: CoroutineScope,
    uplinkDispatcher: CoroutineDispatcher = Dispatchers.Default.limitedParallelism(1),
) {
    private val log = createLogger("sdk", "voice")

    /** Reactive engine state for the UI (Idle unless a real VoiceAudio is wired). */
    val audioState: StateFlow<VoiceAudioState> =
        voiceAudio?.state ?: MutableStateFlow(VoiceAudioState(Phase.Idle, micActive = false, playbackActive = false))

    // Legacy mic-state surface kept for the UI until T11 rewires SentientSdk.micState.
    val micState: StateFlow<MicState> = MutableStateFlow(MicState.Idle)

    private val pipeline: VoiceUplinkPipeline? = voiceAudio?.let { va ->
        VoiceUplinkPipeline(
            micFrames = va.micFrames,
            encoder = LazyOpusEncoderPort { OpusUplinkEncoder() },
            sendPacket = { packet -> audioInput().sendAudioFrame(packet) },
            onOnset = { log.debug("onset") },
            scope = scope,
            dispatcher = uplinkDispatcher,
            framer = Framer(),
            onset = OnsetDetector(
                threshold = audioConfig.echoGate.baselineThreshold,
                sustainFrames = audioConfig.onsetSustainFrames,
            ),
        )
    }
    // ...requestStart/requestStop/handle unchanged for now (T9 replaces them with configure)
```

Add imports: `import io.sentient.mobilesdk.voice.io.VoiceAudio`, `import io.sentient.mobilesdk.voice.io.VoiceAudioState`, `import io.sentient.mobilesdk.voice.io.Phase`. Remove `import ...voice.io.MicSource`. (`micState` is a temporary bridge — T10 rebinds `SentientSdk.micState` to `voice.audioState`.)

- [ ] **Step 5: Update `SentientSdk` construction**

Edit `SentientSdk.kt` L163-173 — pass `bundle.voiceAudio` instead of `bundle.mic`:

```kotlin
    private val voice: SdkVoice = SdkVoice(
        voiceAudio = bundle.voiceAudio,
        audioConfig = config.audio,
        audioInput = { connectors.audioInput },
        onUplinkStart = { connectors.audioInput.startStreaming() },
        onUplinkStop = { connectors.audioInput.stopStreaming() },
        scope = scope,
    )
```

(`startMic`/`stopMic` still call `voice.requestStart()`/`requestStop()` — unchanged here; T10 switches them to `requestConfigure`.)

- [ ] **Step 6: Run test to verify it passes**

Run: `./gradlew :shared:mobile-sdk:testDebugUnitTest --tests "io.sentient.mobilesdk.voice.VoiceUplinkPipelineTest"`
Expected: PASS.

- [ ] **Step 7: Verify full commonTest + compiles stay green**

Run: `./gradlew :shared:mobile-sdk:testDebugUnitTest :shared:mobile-sdk:compileKotlinIosSimulatorArm64 :shared:mobile-sdk:compileDebugKotlinAndroid`
Expected: BUILD SUCCESSFUL. (Uplink now reads `voiceAudio.micFrames`, which is dormant until T9 drives `configure`; old `bundle.mic` is unused by `SdkVoice` but still constructed — removed in T11.)

- [ ] **Step 8: Commit**

```bash
git add shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/voice/VoiceUplinkPipeline.kt \
        shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/sdk/SdkVoice.kt \
        shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/sdk/SentientSdk.kt \
        shared/mobile-sdk/src/commonTest/kotlin/io/sentient/mobilesdk/voice/VoiceUplinkPipelineTest.kt
git commit -m "refactor(mobile-sdk): VoiceUplinkPipeline consumes VoiceAudio.micFrames"
```

---

## Task 8: Rewire the DOWNLINK axis — `AudioPipeline` → `VoicePlaybackSink`

**Files:**
- Create: `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/audioio/VoicePlaybackSink.kt`
- Modify: `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/audioio/AudioPipeline.kt` (ctor L53-61, `startPlaybackOnce` L124-139, `enqueueOrBuffer` L169-180, `armDrainWatch` L207-216, `onPlaybackStop` L235-249)
- Modify: `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/sdk/SdkAudio.kt:47-55`
- Modify: `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/sdk/SentientSdk.kt:153-158`
- Test: `shared/mobile-sdk/src/commonTest/kotlin/io/sentient/mobilesdk/audioio/AudioPipelineTest.kt`
- Test: `shared/mobile-sdk/src/commonTest/kotlin/io/sentient/mobilesdk/audioio/AudioPipelineDownlinkTest.kt`

**Interfaces:**
- Produces: `interface VoicePlaybackSink { fun playFrame(pcm16: ByteArray); fun flushPlayback(); val isPlaybackIdle: Boolean }`. `VoiceAudio` implements it (already has these three members). `AudioPipeline` depends on this 3-method slice instead of the full `AudioPlaybackAdapter`.

- [ ] **Step 1: Write the `VoicePlaybackSink` slice**

```kotlin
package io.sentient.mobilesdk.audioio

/**
 * The downlink-facing slice of [io.sentient.mobilesdk.voice.io.VoiceAudio].
 * AudioPipeline depends on this 3-method slice (not the whole engine interface) so the
 * downlink codec/FSM logic is testable against FakeVoiceAudio without a mic/encoder.
 * VoiceAudio already declares these three members — it satisfies this interface.
 */
interface VoicePlaybackSink {
    /** Downlink sink: one PCM16 LE frame → playback. No-op if playbackActive is false. */
    fun playFrame(pcm16: ByteArray)
    /** Flush queued playback (barge-in / interrupt drop-guard). */
    fun flushPlayback()
    /** Idle when no scheduled buffer remains (drain-watch polls this after audio.done). */
    val isPlaybackIdle: Boolean
}
```

- [ ] **Step 2: Make `VoiceAudio` satisfy `VoicePlaybackSink`**

Edit `VoiceAudio.kt` (Task 1) — have the interface extend the slice so platform actuals satisfy it structurally:

```kotlin
interface VoiceAudio : VoicePlaybackSink {
    // ... state, micFrames, configure, shutdown unchanged ...
}
```

Add `import io.sentient.mobilesdk.audioio.VoicePlaybackSink` to `VoiceAudio.kt`. (`FakeVoiceAudio`, `IosVoiceAudio`, `AndroidVoiceAudio` already implement `playFrame`/`flushPlayback`/`isPlaybackIdle` → they satisfy `VoicePlaybackSink` with no further changes.)

- [ ] **Step 3: Rewrite `AudioPipeline` to talk to `VoicePlaybackSink`**

In `AudioPipeline.kt`:
- ctor L53-61: change `private val playback: AudioPlaybackAdapter?` → `private val playback: VoicePlaybackSink?`. Drop `outputSampleRate` usage in `onAudioStart` (the player is pre-started by `configure` at 48k — the accepted narrowing). Keep the field if other code reads it; otherwise remove and remove the constructor param (update `SdkAudio` in Step 5).
- `onAudioStart` L97-121: drop `startPlaybackOnce(playbackRate)`; the player is already running. Set `opusMode`, reset `opusDecoder` if opus, set `isSpeaking = true`, `activeCycleId`, `transition(AudioInput.AudioStart, cycleId)`. Keep the supersede `playback?.flushPlayback()` (was `playback?.clear()`).
- `startPlaybackOnce` L124-139: DELETE (player pre-started). Replace `playbackReady` gating: set `playbackReady = true` synchronously in `onAudioStart` (no async start), so `enqueueOrBuffer` routes straight to `playFrame`.
- `enqueueOrBuffer` L169-180: `playback?.playFrame(bytes)` instead of `playback?.enqueue(bytes)`.
- `armDrainWatch` L207-216: poll `pb.isPlaybackIdle` (unchanged name on the new interface).
- `onPlaybackStop` L235-249: `playback?.flushPlayback()` instead of `playback?.clear()`.
- Drop `playbackStarted`/`playbackReady`/`pendingFrames` IF you remove the buffer; OR keep them with `playbackReady = true` set in `onAudioStart` for minimal churn (recommended — keeps the supersede/buffer tests mostly intact). Choose the minimal-churn path: keep the fields, set `playbackReady = true` in `onAudioStart`, route `enqueueOrBuffer` to `playFrame`.

Remove `import ...AudioPlaybackAdapter` if now unused.

- [ ] **Step 4: Rewrite the downlink tests to use `FakeVoiceAudio`**

In `AudioPipelineTest.kt` L36-47: replace the private `FakePlayback : AudioPlaybackAdapter` with a `FakeVoiceAudio` (use the commonTest fake) and build the pipeline with `playback = fakeVoice` (it satisfies `VoicePlaybackSink`). Update assertions: `enqueue` → `playFrame` (assert on `fakeVoice.playedFrames`), `clear()` → `flushPlayback()` (assert on `fakeVoice.flushCount`). Drop `startedRate` (no more `start(rate)`).

In `AudioPipelineDownlinkTest.kt`: the `FakeSlowPlayback` (gated by `CompletableDeferred` to test async-start buffering) is now moot — the player is pre-started by `configure`. Replace `FakeSlowPlayback`/`FakeInstantPlayback` with `FakeVoiceAudio` variants; DELETE the async-start buffering test cases (they pinned a behavior that no longer exists). Keep the supersede + drain-watch + stale-drop cases, driving idle via `fakeVoice.setPlaybackIdle(...)`.

- [ ] **Step 5: Update `SdkAudio` construction**

Edit `SdkAudio.kt` L32-55 — take `voiceAudio: VoiceAudio?` (or `VoicePlaybackSink?`) instead of `playback: AudioPlaybackAdapter?`; pass it to `AudioPipeline`:

```kotlin
class SdkAudio(
    audioConfig: AudioPipelineConfig,
    private val voiceAudio: VoiceAudio?,
    scope: CoroutineScope,
    private val onStateChanged: (isSpeaking: Boolean, fsmState: AudioState) -> Unit,
) {
    private val fsm = AudioFsm()
    private val opusDecoder = LazyOpusDecoderPort { OpusDownlinkDecoder() }

    val pipeline: AudioPipeline = AudioPipeline(
        playback = voiceAudio,                 // VoiceAudio : VoicePlaybackSink
        opusDecoder = opusDecoder,
        fsm = fsm,
        scope = scope,
        outputSampleRate = audioConfig.outputSampleRate,   // keep if AudioPipeline still takes it
        onStateChanged = onStateChanged,
        playbackDrainSettleMs = audioConfig.playbackDrainSettleMs,
    )
    // downlinkHooks / suspendForReconnect / dispose / stopLocal unchanged
}
```

Remove `import ...audioio.AudioPlaybackAdapter` if unused.

- [ ] **Step 6: Update `SentientSdk` construction**

Edit `SentientSdk.kt` L153-158 — pass `bundle.voiceAudio` instead of `bundle.playback`:

```kotlin
    private val audio: SdkAudio = SdkAudio(
        audioConfig = config.audio,
        voiceAudio = bundle.voiceAudio,
        scope = scope,
        onStateChanged = ::onAudioStateChanged,
    )
```

- [ ] **Step 7: Run downlink tests**

Run: `./gradlew :shared:mobile-sdk:testDebugUnitTest --tests "io.sentient.mobilesdk.audioio.AudioPipelineTest" --tests "io.sentient.mobilesdk.audioio.AudioPipelineDownlinkTest"`
Expected: PASS.

- [ ] **Step 8: Verify full commonTest + compiles**

Run: `./gradlew :shared:mobile-sdk:testDebugUnitTest :shared:mobile-sdk:compileKotlinIosSimulatorArm64 :shared:mobile-sdk:compileDebugKotlinAndroid`
Expected: BUILD SUCCESSFUL.

- [ ] **Step 9: Commit**

```bash
git add shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/audioio/VoicePlaybackSink.kt \
        shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/audioio/AudioPipeline.kt \
        shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/voice/io/VoiceAudio.kt \
        shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/sdk/SdkAudio.kt \
        shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/sdk/SentientSdk.kt \
        shared/mobile-sdk/src/commonTest/kotlin/io/sentient/mobilesdk/audioio/AudioPipelineTest.kt \
        shared/mobile-sdk/src/commonTest/kotlin/io/sentient/mobilesdk/audioio/AudioPipelineDownlinkTest.kt
git commit -m "refactor(mobile-sdk): AudioPipeline downlink drives VoiceAudio (playFrame/flushPlayback)"
```

---

## Task 9: `SdkVoice` unified `configure` lane (serialized mic + TTS reconfig)

**Files:**
- Modify: `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/sdk/SdkVoice.kt` (Cmd L107-149, requestStart/Stop L125-134)
- Test: `shared/mobile-sdk/src/commonTest/kotlin/io/sentient/mobilesdk/sdk/SdkVoiceTest.kt` (create if absent; reuse existing if present)

**Interfaces:**
- Consumes: `VoiceAudio.configure` (Task 1), `VoiceUplinkPipeline` (Task 7).
- Produces: `SdkVoice.requestConfigure(mic: Boolean, playback: Boolean)` — enqueues a `Configure` cmd on the single ordered lane. The consumer diffs against the last-applied `(mic, playback)`, emits `audio.start` on mic false→true (BEFORE `voiceAudio.configure` + uplink collect start), emits `audio.end` on mic true→false (AFTER `voiceAudio.configure` + uplink collect stop), and calls `voiceAudio.configure(mic, playback)`. `requestStart()`/`requestStop()` become thin wrappers calling `requestConfigure(mic=true/false, playback=<current>)`.

- [ ] **Step 1: Write the failing test — rapid toggles serialize**

```kotlin
package io.sentient.mobilesdk.sdk

import io.sentient.mobilesdk.voice.io.FakeVoiceAudio
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class SdkVoiceTest {

    @Test
    fun rapid_mic_toggles_serialize_and_never_race() = runTest {
        val va = FakeVoiceAudio()
        val starts = mutableListOf<Boolean>() // onUplinkStart/onUplinkStop edges
        val voice = SdkVoice(
            voiceAudio = va,
            audioConfig = AudioPipelineConfig(),
            audioInput = { throw IllegalStateException("not used here") },
            onUplinkStart = { starts += true },
            onUplinkStop = { starts += false },
            scope = CoroutineScope(Dispatchers.Unconfined),
        )
        // Hammer the lane — a FIFO consumer must apply these in submission order.
        repeat(5) { voice.requestConfigure(mic = true, playback = false) }
        repeat(5) { voice.requestConfigure(mic = false, playback = false) }
        // Drain the ordered consumer on the test scheduler.
        // (If SdkVoice's consumer runs on Dispatchers.Default, advanceUntilIdle; if it
        //  runs on the injected scope, the Unconfined scope drains synchronously.)
        advanceUntilIdle()

        // The lane collapses consecutive identical configures (idempotent diff), so
        // after 5×(true) + 5×(false) the engine saw mic on then off — exactly one
        // audio.start edge and one audio.end edge, in that order.
        assertEquals(listOf(true, false), starts.distinct(), "audio.start must precede audio.end")
        // And configure was called for the mic-on then mic-off transitions only.
        assertEquals(2, va.configureCalls.size, "idempotent configure collapses repeats")
    }

    @Test
    fun tts_toggle_with_mic_on_enables_vpio_cell() = runTest {
        val va = FakeVoiceAudio()
        val voice = SdkVoice(va, AudioPipelineConfig(), { throw IllegalStateException() }, {}, {}, CoroutineScope(Dispatchers.Unconfined))
        voice.requestConfigure(mic = true, playback = false); advanceUntilIdle()
        voice.requestConfigure(mic = true, playback = true);  advanceUntilIdle()  // mic stays on → no audio.end
        voice.requestConfigure(mic = false, playback = false); advanceUntilIdle()
        // Transitions applied: (F,F)->(T,F)->(T,T)->(F,F). audio.start on first mic-on,
        // audio.end on the final mic-off. No spurious audio.start/audio.end between.
        assertEquals(3, va.configureCalls.size)
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./gradlew :shared:mobile-sdk:testDebugUnitTest --tests "io.sentient.mobilesdk.sdk.SdkVoiceTest"`
Expected: FAIL — `requestConfigure` unresolved.

- [ ] **Step 3: Extend the `Cmd` lane + consumer**

Edit `SdkVoice.kt` — replace the `Cmd` sealed interface + `handle` + `requestStart`/`requestStop`:

```kotlin
    /** One ordered configure command. Drained FIFO by the single consumer — the
     *  only path that touches VoiceAudio.configure + the uplink collect + the
     *  audio.start/audio.end control frames, so mic + TTS reconfigs NEVER race. */
    private sealed interface Cmd {
        data class Configure(val mic: Boolean, val playback: Boolean) : Cmd
    }

    private val commands = Channel<Cmd>(Channel.UNLIMITED)

    // Last-applied (mic, playback); the consumer diffs against this so consecutive
    // identical configures are a no-op (idempotent) — collapse the 5×(true) hammer.
    private var micOn = false
    private var playbackOn = false

    init {
        scope.launch { for (cmd in commands) handle(cmd) }
    }

    /** THE serialized reconfig entry. Non-suspend; runs FIFO on the single consumer. */
    fun requestConfigure(mic: Boolean, playback: Boolean) {
        log.info("requestConfigure", mapOf("mic" to mic, "playback" to playback))
        commands.trySend(Cmd.Configure(mic, playback))
    }

    /** Convenience for startMic (mic axis only; keeps current playback). */
    fun requestStart() = requestConfigure(mic = true, playback = playbackOn)

    /** Convenience for stopMic (mic axis only; keeps current playback). */
    fun requestStop() = requestConfigure(mic = false, playback = playbackOn)

    private suspend fun handle(cmd: Cmd) {
        val c = cmd as Cmd.Configure
        runCatching {
            val micRising = c.mic && !micOn
            val micFalling = !c.mic && micOn
            // audio.start BEFORE the engine + uplink come up (wire order: start→frames→end).
            if (micRising) onUplinkStart()
            // Stop the uplink collect when mic goes away (before configure tears the tap).
            if (micFalling) pipeline?.stop()
            // THE single engine reconfig — VPIO flips iff the (mic,playback) cell changes.
            voiceAudio?.configure(c.mic, c.playback)
            // Start the uplink collect once the mic tap is live.
            if (micRising) pipeline?.start()
            micOn = c.mic; playbackOn = c.playback
            // audio.end AFTER the uplink is down + configure settled (no late frame past end).
            if (micFalling) onUplinkStop()
        }.onFailure { err ->
            if (err is CancellationException) throw err
            log.warn("command-failed", mapOf("cmd" to "Configure", "error" to (err.message ?: "unknown")))
        }
    }
```

Remove the old `Cmd.Start`/`Cmd.Stop` data objects. Keep the `pipeline`, `audioState`, `micState` fields from T7. (`micState` bridge still present; T10 rebinds `SentientSdk.micState` to `audioState`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `./gradlew :shared:mobile-sdk:testDebugUnitTest --tests "io.sentient.mobilesdk.sdk.SdkVoiceTest"`
Expected: PASS — 2 tests. (If the test scheduler does not drain the `Dispatchers.Default` consumer, change the test to inject an `Unconfined`-based scope and/or pass a test dispatcher — the existing `SdkVoice` already accepts `uplinkDispatcher`; the command consumer runs on `scope`, so pass `CoroutineScope(Dispatchers.Unconfined)` as in the test above.)

- [ ] **Step 5: Verify full suite + compiles**

Run: `./gradlew :shared:mobile-sdk:testDebugUnitTest :shared:mobile-sdk:compileKotlinIosSimulatorArm64 :shared:mobile-sdk:compileDebugKotlinAndroid`
Expected: BUILD SUCCESSFUL.

- [ ] **Step 6: Commit**

```bash
git add shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/sdk/SdkVoice.kt \
        shared/mobile-sdk/src/commonTest/kotlin/io/sentient/mobilesdk/sdk/SdkVoiceTest.kt
git commit -m "feat(mobile-sdk): SdkVoice serialized configure lane (mic+TTS reconfig never race)"
```

---

## Task 10: `SentientSdk.startMic`/`stopMic`/`setTtsEnabled` → `requestConfigure`

**Files:**
- Modify: `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/sdk/SentientSdk.kt:351-378` (startMic/stopMic/setTtsEnabled) + L177 (`micState`)
- Test: existing `SentientSdk` tests (smoke: verify startMic/stopMic route to `requestConfigure`).

**Interfaces:**
- Consumes: `SdkVoice.requestConfigure` (Task 9), `bundle.voiceAudio`.
- Produces: `startMic()`/`stopMic()`/`setTtsEnabled(enabled)` all drive `voice.requestConfigure(mic, playback)`. `micState` rebound to `voice.audioState` (the engine readiness, not the legacy `MicState`).

- [ ] **Step 1: Rewrite the three public methods**

Edit `SentientSdk.kt` L351-378:

```kotlin
    /** Start the voice uplink: flip voiceMode ACTIVE, then request the serialized
     *  configure(mic=true, playback=<current tts>) on [SdkVoice]'s single lane. The lane
     *  emits audio.start, runs VoiceAudio.configure (mic tap up), and starts the uplink
     *  collect — in that order, serialized with stopMic and setTtsEnabled. */
    fun startMic() {
        log.info("startMic", mapOf("voiceAudioWired" to (bundle.voiceAudio != null)))
        markInteraction()
        deriver.voiceMode = VoiceMode.ACTIVE
        voice.requestStart()
        emit()
    }

    /** Stop the voice uplink: flip voiceMode OFF, request configure(mic=false, ...).
     *  The lane stops the uplink collect, runs VoiceAudio.configure (mic tap down), and
     *  emits audio.end LAST — so no late frame can race past audio.end. */
    fun stopMic() {
        log.info("stopMic")
        deriver.voiceMode = VoiceMode.OFF
        voice.requestStop()
        emit()
    }

    /** Patch TTS on/off (server echoes via session.preferences.changed) AND drive a
     *  local optimistic configure(playback=enabled) on the SAME serialized lane as mic —
     *  so a TTS-while-mic-on toggle flips VPIO on/off without racing a mic reconfig. */
    suspend fun setTtsEnabled(enabled: Boolean) {
        log.info("setTtsEnabled", mapOf("enabled" to enabled))
        voice.requestConfigure(mic = (deriver.voiceMode == VoiceMode.ACTIVE), playback = enabled)
        connectors.preferences.patch(AudioPreferencesPatch(ttsEnabled = enabled))
    }
```

(`requestStart`/`requestStop` now call `requestConfigure(mic=true/false, playback=playbackOn)` — playback tracked inside `SdkVoice`; `startMic` keeps the current playback axis.)

- [ ] **Step 2: Rebind `micState` to engine readiness**

Edit L177:

```kotlin
    /** Reactive engine readiness (Idle→Configuring→Ready/Error). UI spinner off this.
     *  Idle unless a real VoiceAudio is wired (text/test path). */
    val micState: StateFlow<*> = voice.audioState
```

(If callers/UI expect `MicState`, leave a mapping or update the iOS/Android UI binding to `VoiceAudioState.phase` in the app layers — but those are outside `shared/mobile-sdk`. Inside the SDK, expose `voice.audioState: StateFlow<VoiceAudioState>` and keep a deprecated `micState: StateFlow<MicState>` bridge only if an existing public API requires it; otherwise replace. Check `SentientSdk`'s public API surface + the iOS/Android app consumers before deleting — search `micState` usages in `ios/` and `android/`.)

Run a grep first:
```
grep -rn "micState" ios/ android/ shared/mobile-data/
```
If app code reads `micState`, expose `val audioState: StateFlow<VoiceAudioState> = voice.audioState` alongside and migrate the app binding in this step; if no app usage, replace `micState` with `audioState`.

- [ ] **Step 3: Run the SDK unit suite + compiles**

Run: `./gradlew :shared:mobile-sdk:testDebugUnitTest :shared:mobile-sdk:compileKotlinIosSimulatorArm64 :shared:mobile-sdk:compileDebugKotlinAndroid`
Expected: BUILD SUCCESSFUL.

- [ ] **Step 4: Commit**

```bash
git add shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/sdk/SentientSdk.kt
git commit -m "feat(mobile-sdk): startMic/stopMic/setTtsEnabled -> serialized configure"
```

---

## Task 11: Delete the old two-engine code (atomic, same slice)

**Files:**
- Delete (10 files — see File Structure "Delete" list).
- Modify: `PlatformBundle.kt` (remove `mic`/`playback` fields + their imports), `PlatformBundle.ios.kt` + `PlatformBundle.android.kt` (drop old adapter construction), `SdkVoice.kt` (remove the `micState` bridge + `MicState` import if T10 replaced it), `SentientSdk.kt` (drop `bundle.mic`/`bundle.playback` references if any remain).
- Test: delete `FakeMicSource.kt` + `FakeMicSourceTest.kt`; update any remaining test referencing `MicSource`/`AudioPlaybackAdapter`/`FakeMicSource`.

**Interfaces:**
- Consumes: everything from T1–T10 is wired. After this task, `MicSource` and `AudioPlaybackAdapter` no longer exist anywhere.

- [ ] **Step 1: Read the soon-deleted files one last time and confirm no live references**

Run:
```
grep -rn "MicSource\|AudioPlaybackAdapter\|SharedAudioEngine\|StandalonePlaybackEngine\|IosMicSource\|AndroidMicSource\|MicAudioRecordSession\|FakeMicSource" shared/mobile-sdk/src/
```
Expected: only the soon-deleted files themselves + `PlatformBundle` `mic`/`playback` field refs + `SdkVoice` `micState` bridge. Anything else is a missed rewire — fix it before deleting.

- [ ] **Step 2: Delete the 10 files**

```bash
git rm shared/mobile-sdk/src/iosMain/kotlin/io/sentient/mobilesdk/audioio/SharedAudioEngine.ios.kt
git rm shared/mobile-sdk/src/iosMain/kotlin/io/sentient/mobilesdk/audioio/StandalonePlaybackEngine.ios.kt
git rm shared/mobile-sdk/src/iosMain/kotlin/io/sentient/mobilesdk/voice/io/IosMicSource.kt
git rm shared/mobile-sdk/src/iosMain/kotlin/io/sentient/mobilesdk/audioio/AudioPlaybackAdapter.ios.kt
git rm shared/mobile-sdk/src/androidMain/kotlin/io/sentient/mobilesdk/voice/io/AndroidMicSource.kt
git rm shared/mobile-sdk/src/androidMain/kotlin/io/sentient/mobilesdk/voice/io/MicAudioRecordSession.android.kt
git rm shared/mobile-sdk/src/androidMain/kotlin/io/sentient/mobilesdk/audioio/AudioPlaybackAdapter.android.kt
git rm shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/voice/io/MicSource.kt
git rm shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/audioio/AudioPlaybackAdapter.kt
git rm shared/mobile-sdk/src/commonTest/kotlin/io/sentient/mobilesdk/voice/io/FakeMicSource.kt
git rm shared/mobile-sdk/src/commonTest/kotlin/io/sentient/mobilesdk/voice/io/FakeMicSourceTest.kt
```

- [ ] **Step 3: Strip `mic`/`playback` from `PlatformBundle`**

Edit `PlatformBundle.kt`:

```kotlin
data class PlatformBundle(
    val engine: WebSocketEngine,
    val tokenStore: SecureTokenStore,
    val deviceIdStore: DeviceIdStore,
    val clock: Clock,
    val voiceAudio: VoiceAudio? = null,
)
```

Remove imports of `AudioPlaybackAdapter` and `MicSource`. Update the KDoc (drop the `mic`/`playback` paragraphs; describe `voiceAudio` as the single audio engine, null on the text/test path).

Edit `PlatformBundle.ios.kt` L22 — drop `playback = IosAudioPlaybackAdapter()` and `mic = IosMicSource()`; keep `voiceAudio = IosVoiceAudio()`.

Edit `PlatformBundle.android.kt` L17 — drop `playback = AndroidAudioPlaybackAdapter()` and `mic = AndroidMicSource()`; keep `voiceAudio = AndroidVoiceAudio()`.

- [ ] **Step 4: Drop the `micState` bridge in `SdkVoice` (if T10 left it)**

Edit `SdkVoice.kt` — remove the temporary `val micState: StateFlow<MicState> = MutableStateFlow(MicState.Idle)` line and the `MicState` import (T10 should have rebound `SentientSdk.micState` to `audioState`). If any test still reads `voice.micState`, update it to `voice.audioState`.

- [ ] **Step 5: Verify no dangling references remain**

Run:
```
grep -rn "MicSource\|AudioPlaybackAdapter\|SharedAudioEngine\|StandalonePlaybackEngine\|bundle\.mic\|bundle\.playback" shared/mobile-sdk/src/
```
Expected: no matches.

- [ ] **Step 6: Verify the whole module builds + tests pass**

Run: `./gradlew :shared:mobile-sdk:testDebugUnitTest :shared:mobile-sdk:compileKotlinIosSimulatorArm64 :shared:mobile-sdk:compileDebugKotlinAndroid :shared:mobile-sdk:metadataJar`
Expected: BUILD SUCCESSFUL, all commonTest green.

- [ ] **Step 7: Commit**

```bash
git add -A shared/mobile-sdk/
git commit -m "refactor(mobile-sdk): delete two-engine audio path (SharedAudioEngine/StandalonePlaybackEngine/MicSource/AudioPlaybackAdapter)"
```

---

## Task 12: `PrivacyGuardTest` stays green + logging audit

**Files:**
- Verify: `shared/mobile-sdk/src/commonTest/kotlin/io/sentient/mobilesdk/vitals/PrivacyGuardTest.kt` (no edits unless it fails).
- Audit: the `VoiceAudio` actuals (T4/T5) — confirm no audio content crosses the log boundary.

- [ ] **Step 1: Run PrivacyGuard**

Run: `./gradlew :shared:mobile-sdk:testDebugUnitTest --tests "io.sentient.mobilesdk.vitals.PrivacyGuardTest"`
Expected: PASS. (If it fails, a `VoiceAudio` actual is logging frame content — fix the actual to log lengths/counts only.)

- [ ] **Step 2: Audit the VoiceAudio logs**

Run: `grep -n "log\." shared/mobile-sdk/src/iosMain/kotlin/io/sentient/mobilesdk/voice/io/VoiceAudio.ios.kt shared/mobile-sdk/src/androidMain/kotlin/io/sentient/mobilesdk/voice/io/VoiceAudio.android.kt`
Confirm every entry logs only ids/counts/lengths/phase — never `pcm16`/`ShortArray`/`ByteArray` content, never a transcript. Match the `IosMicSource`/`AudioPlaybackAdapter.android` logging discipline (lengths + ids only).

- [ ] **Step 3: Commit (only if edits were needed)**

```bash
git add -A shared/mobile-sdk/
git commit -m "test(mobile-sdk): VoiceAudio logging audit (lengths/ids only, PrivacyGuard green)"
```
If no edits were needed, skip the commit — note "PrivacyGuard green, no edits" in the handover.

---

## Task 13: Version bump

**Files:**
- Modify: `shared/mobile-sdk/README.md` (version line), `android/app/build.gradle.kts` or the mobile version source (find the current `0.1.7` per the branch memory), and the iOS framework version if separately declared.

- [ ] **Step 1: Find the current version pins**

Run: `grep -rn "0\.1\.7" shared/mobile-sdk/ android/ ios/ | grep -i version`
Expected: the version literal(s) to bump.

- [ ] **Step 2: Bump 0.1.7 → 0.1.8**

Update each pinned location. (This supersedes the interim `2633b4e` fix and the Slice-1 `0.1.7` bump.)

- [ ] **Step 3: Verify build still green**

Run: `./gradlew :shared:mobile-sdk:testDebugUnitTest :shared:mobile-sdk:compileKotlinIosSimulatorArm64 :shared:mobile-sdk:compileDebugKotlinAndroid`
Expected: BUILD SUCCESSFUL.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore(mobile-sdk): bump 0.1.7 -> 0.1.8 for voice-engine consolidation"
```

---

## Self-Review

**1. Spec coverage:**
- D1 (mic permission up front) — single `.playAndRecord` engine in `VoiceAudio.ios`; no `.playback`-only path. ✓ (T4)
- D2 (one engine, one interface `VoiceAudio`) — T1; `configure` idempotent reconfig. ✓
- D3 (VPIO only in mic+TTS cell, stop→set→start) — T2 pure `vpio = mic && playback`; T4/T5 toggle only inside `applyGraph` (engine stopped). ✓
- D4 (teardown at idle) — `voiceAudioGraph(false,false).running=false` → deactivate session in T4/T5. ✓
- D5 (clean reconfig, never a straddle) — one engine, `configure` diff stop→reconfigure→start; no second engine. ✓
- Interface (commonMain) — T1 verbatim. ✓
- Internal one-engine state machine (iOS table) — T4 + T2 matrix. ✓
- Android actual — T5. ✓
- What it replaces (deletes) — T11 list matches the design's "Delete" set. ✓
- Rewire (`VoiceUplinkPipeline` consumes `micFrames`; `AudioPipeline` feeds `playFrame`/`flushPlayback`/`isPlaybackIdle`; `SdkVoice`/`SdkAudio` call `configure`) — T7/T8/T9/T10. ✓
- Keep list (Pcm16Converter, resampler, opus, voice/ pipeline, SdkVoice actor) — preserved, not in delete list. ✓
- Control-plane/wire unchanged — T9 keeps `audio.start`/`audio.end` on mic edges, serialized. ✓
- Error/logging/testing — no-throw contract (T4/T5 runCatching + ObjCExceptionGuard); tagged logger (T4/T5); pure-diff commonTest (T2); PrivacyGuard (T12). ✓
- Migration/rollout (single branch, old deleted same slice, version bump) — T11/T13. ✓
- E2E matrix — intentionally omitted per user instruction (device cases user-owned); noted in Global Constraints + handover. ✓

**2. Placeholder scan:** Platform-actual tasks (T4/T5) mark AVFoundation/AudioTrack bodies as "copy verbatim from the soon-deleted files before T11." This is NOT a placeholder — it pins the contract-critical pieces (session category, VPIO toggle timing, tap→channel, player→mainMixerNode, source selection) with real code and delegates standard boilerplate (format structs, buffer sizing) to the proven snippets in files the implementer reads before deleting. The `ObjCExceptionGuard` helper already exists; `Pcm16Converter`/`Pcm16Resampler`/`ByteRing` are reused, not rewritten. No "TBD"/"implement later"/"add error handling" elsewhere.

**3. Type consistency:**
- `voiceAudioGraph(mic, playback): VoiceAudioGraph` — defined T2, consumed T3 (`FakeVoiceAudio.configure`), T4 (`IosVoiceAudio.current`), T5 (`AndroidVoiceAudio.current`). ✓
- `VoiceAudioState(phase, micActive, playbackActive, errorReason)` — T1, used T3/T4/T5/T9 (`voice.audioState`). ✓
- `VoicePlaybackSink { playFrame, flushPlayback, isPlaybackIdle }` — defined T8, satisfied by `VoiceAudio` (T1) structurally, consumed by `AudioPipeline` (T8) + `SdkAudio` (T8). ✓
- `SdkVoice.requestConfigure(mic, playback)` — defined T9, called T10. `requestStart`/`requestStop` retained as wrappers. ✓
- `VoiceAudio.configure(mic, playback, playbackRateHz = 48_000)` — T1; `FakeVoiceAudio`/`IosVoiceAudio`/`AndroidVoiceAudio` all match; `SdkVoice.handle` calls `voiceAudio?.configure(c.mic, c.playback)` (uses default rate). ✓

One open item flagged for the user: the `micState` public surface (Task 10 Step 2) — whether the iOS/Android app layers read `SentientSdk.micState` (legacy `MicState`) and need migrating to `VoiceAudioState.phase`. Task 10 includes a grep step to decide this at execution time rather than guessing.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-06-30-voice-engine-consolidation.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. Best fit here: the platform actuals (T4/T5) are large and isolated; the rewires (T7/T8/T9) benefit from a review gate between each.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**

> **User-owned device verification (handover):** the agent-runnable tasks stop at commonTest green + iOS/Android compiles. The design's device E2E matrix — mic-only STT, full-duplex echo/AEC, TTS-then-mic reconfig, TTS toggle mid-voice, rapid mic toggle, idle teardown — is USER-owned (sim has no mic; echo/AEC is audible-only). Before merging to `develop`, run those cases on a real device against the local gateway stack and capture the `voice.engine.ios|android` log trail (VPIO on in the mic+TTS cell, no `StartIO` failure, no `-50`, no self-turn, teardown at idle).