# Mobile Voice Pipeline — Slice 1: Real-time Uplink — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the orchestrator-coupled mic path with a decoupled, real-time `voice/` uplink pipeline that streams 20ms Opus frames 1:1 with capture — killing the 10s delay + phantom-turn class.

**Architecture:** Platform `MicSource` (`expect/actual`) captures + resamples to 16k PCM16 on a dedicated realtime thread and hands frames into `commonMain` via a small **bounded, drop-newest** `Channel`. A `VoiceUplinkPipeline` running on a **dedicated single-thread dispatcher** (never the SDK orchestrator) frames → onset-detects → Opus-encodes → sends 1:1 to the WS. A `VoiceFsm` + `MicState` drive reactive UI. This slice is uplink-only; downlink/full-duplex/barge-in/lifecycle are later slices. The shared full-duplex engine is built here (iOS needs an output graph for VPIO), but TTS playback wiring is deferred.

**Tech Stack:** Kotlin Multiplatform (commonMain + iosMain + androidMain), kotlinx.coroutines (Channel/Flow + dedicated dispatcher), kopus (Opus), iOS AVAudioEngine + AVAudioConverter, Android AudioRecord.

## Global Constraints

- Wire protocol UNCHANGED: `audio.start` / `audio.end` control frames + one raw Opus packet per binary WS frame. Cross-check `shared/web-sdk` before touching a frame.
- Opus uplink: 16kHz mono, VOIP, 24000 bps, 320-sample (20ms) frames, raw TOC packets (reuse `OpusUplinkEncoder`).
- commonMain purity: NO `platform.*` / `android.*` / `java.*` in commonMain; platform capability only via `expect`/injected interface. Inject a `Clock` — never `Date()`/`currentTimeMillis()`.
- Hot path: no per-frame allocation beyond the frame buffer; no logging at INFO per-frame (throttle first-N + every-Nth); lengths/counts/RMS only, never content (PrivacyGuard stays green).
- Files <300 lines (split at 250); functions <40 lines (extract at 30); max nesting 3.
- Audio NEVER runs on the SDK orchestrator coroutine. Platform capture on a dedicated realtime thread; `VoiceUplinkPipeline` on its own single-thread dispatcher.
- Backpressure = bounded channel + drop-NEWEST (`BufferOverflow.DROP_LATEST`), never a large drop-oldest backlog. Emit a throttled WARN with dropped count.
- Tests: `bun run test` is irrelevant here; use Gradle. commonMain pure units are TDD'd in `commonTest` with fakes (no device). Platform `actual`s are device-verified (sim has no mic).
- Logger tag root `["sentient","mobile-sdk",...]`; tagged logger only, no bare prints.

---

### Task 1: Scaffold `voice/` package — `MicState` + `VoiceFrame`

**Files:**
- Create: `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/voice/MicState.kt`
- Test: `shared/mobile-sdk/src/commonTest/kotlin/io/sentient/mobilesdk/voice/MicStateTest.kt`

**Interfaces:**
- Produces: `sealed interface MicState { Idle; Initializing; Live; data class Error(val reason: String) }`; `const val FRAME_SAMPLES_16K = 320`.

- [ ] **Step 1: Write the failing test**
```kotlin
package io.sentient.mobilesdk.voice
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class MicStateTest {
    @Test fun frame_samples_is_20ms_at_16k() {
        assertEquals(320, FRAME_SAMPLES_16K) // 16000 * 0.020
    }
    @Test fun error_carries_reason() {
        val s: MicState = MicState.Error("engine-start-failed")
        assertTrue(s is MicState.Error && s.reason == "engine-start-failed")
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./gradlew :shared:mobile-sdk:compileTestKotlinIosSimulatorArm64` (or `jvmTest` if a JVM test target exists)
Expected: FAIL — `MicState` / `FRAME_SAMPLES_16K` unresolved.

- [ ] **Step 3: Write minimal implementation**
```kotlin
package io.sentient.mobilesdk.voice

/** 20ms of 16kHz mono PCM = 320 samples — the uplink frame quantum + Opus frame size. */
const val FRAME_SAMPLES_16K = 320

/** Reactive mic-engine state for the UI (spinner on Initializing, mic-active on Live). */
sealed interface MicState {
    data object Idle : MicState
    data object Initializing : MicState
    data object Live : MicState
    data class Error(val reason: String) : MicState
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: the test target from Step 2.
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/voice/MicState.kt \
        shared/mobile-sdk/src/commonTest/kotlin/io/sentient/mobilesdk/voice/MicStateTest.kt
git commit -m "feat(mobile-sdk): voice MicState + frame quantum"
```

---

### Task 2: `Framer` — slice variable PCM into exact 20ms frames

**Files:**
- Create: `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/voice/uplink/Framer.kt`
- Test: `shared/mobile-sdk/src/commonTest/kotlin/io/sentient/mobilesdk/voice/uplink/FramerTest.kt`

**Interfaces:**
- Produces: `class Framer(val frameSamples: Int = FRAME_SAMPLES_16K) { fun push(pcm: ShortArray): List<ShortArray>; fun reset() }`. Each returned `ShortArray` is exactly `frameSamples` long; a sub-frame remainder is carried to the next `push`.

- [ ] **Step 1: Write the failing test**
```kotlin
package io.sentient.mobilesdk.voice.uplink
import kotlin.test.Test
import kotlin.test.assertEquals

class FramerTest {
    @Test fun slices_exact_frames_and_carries_remainder() {
        val f = Framer(frameSamples = 4)
        assertEquals(0, f.push(shortArrayOf(1, 2, 3)).size)        // buffered, no full frame
        val out = f.push(shortArrayOf(4, 5, 6, 7, 8))              // total 8 → two frames of 4
        assertEquals(2, out.size)
        assertEquals(listOf<Short>(1,2,3,4), out[0].toList())
        assertEquals(listOf<Short>(5,6,7,8), out[1].toList())
    }
    @Test fun reset_drops_remainder() {
        val f = Framer(frameSamples = 4)
        f.push(shortArrayOf(1, 2))
        f.reset()
        assertEquals(0, f.push(shortArrayOf(3, 4)).size) // remainder gone → only 2 buffered
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./gradlew :shared:mobile-sdk:compileTestKotlinIosSimulatorArm64`
Expected: FAIL — `Framer` unresolved.

- [ ] **Step 3: Write minimal implementation**
```kotlin
package io.sentient.mobilesdk.voice.uplink

import io.sentient.mobilesdk.voice.FRAME_SAMPLES_16K

/**
 * Accumulates variable-length 16k mono PCM and emits exact [frameSamples]-sample frames.
 * The platform tap hands variable buffers (iOS often ~4800 frames); downstream needs
 * exact 20ms frames. Sub-frame remainder is carried to the next push. Single-thread
 * (the pipeline dispatcher); not thread-safe by design.
 */
class Framer(private val frameSamples: Int = FRAME_SAMPLES_16K) {
    private var carry = ShortArray(0)

    fun push(pcm: ShortArray): List<ShortArray> {
        val joined = if (carry.isEmpty()) pcm else carry + pcm
        val full = joined.size / frameSamples
        if (full == 0) {
            carry = joined
            return emptyList()
        }
        val out = ArrayList<ShortArray>(full)
        for (i in 0 until full) {
            out.add(joined.copyOfRange(i * frameSamples, (i + 1) * frameSamples))
        }
        carry = joined.copyOfRange(full * frameSamples, joined.size)
        return out
    }

    fun reset() { carry = ShortArray(0) }
}
```

- [ ] **Step 4: Run test to verify it passes** — Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/voice/uplink/Framer.kt \
        shared/mobile-sdk/src/commonTest/kotlin/io/sentient/mobilesdk/voice/uplink/FramerTest.kt
git commit -m "feat(mobile-sdk): voice Framer (exact 20ms slicing)"
```

---

### Task 3: `OnsetDetector` — RMS onset flag (barge-in trigger only)

**Files:**
- Create: `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/voice/uplink/OnsetDetector.kt`
- Test: `shared/mobile-sdk/src/commonTest/kotlin/io/sentient/mobilesdk/voice/uplink/OnsetDetectorTest.kt`

**Interfaces:**
- Consumes: `computeRms` exists in `io.sentient.mobilesdk.audio` (reuse) — `fun computeRms(pcm: ShortArray): Double` returns normalized [0,1].
- Produces: `class OnsetDetector(val threshold: Double, val sustainFrames: Int) { fun observe(frame: ShortArray): Boolean /* true exactly on the reject→speak onset edge */; fun reset() }`. Never drops frames; pure flag.

- [ ] **Step 1: Write the failing test**
```kotlin
package io.sentient.mobilesdk.voice.uplink
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class OnsetDetectorTest {
    private fun loud(n: Int = 320) = ShortArray(n) { 8000 }
    private fun quiet(n: Int = 320) = ShortArray(n) { 0 }

    @Test fun fires_once_on_sustained_onset_edge() {
        val d = OnsetDetector(threshold = 0.05, sustainFrames = 2)
        assertFalse(d.observe(quiet()))
        assertFalse(d.observe(loud()))   // 1 loud — not yet sustained
        assertTrue(d.observe(loud()))    // 2 loud — onset edge fires
        assertFalse(d.observe(loud()))   // still speaking — no re-fire
    }
    @Test fun rearms_after_silence() {
        val d = OnsetDetector(threshold = 0.05, sustainFrames = 1)
        assertTrue(d.observe(loud()))
        assertFalse(d.observe(quiet()))
        assertTrue(d.observe(loud()))    // re-armed → fires again
    }
}
```

- [ ] **Step 2: Run test to verify it fails** — Expected: FAIL, `OnsetDetector` unresolved.

- [ ] **Step 3: Write minimal implementation**
```kotlin
package io.sentient.mobilesdk.voice.uplink

import io.sentient.mobilesdk.audio.computeRms

/**
 * Detects the speech-onset EDGE on the (AEC'd) mic for instant local barge-in ducking.
 * Returns true exactly once per quiet→speech transition after [sustainFrames] consecutive
 * above-threshold frames. NEVER gates/drops audio — the server owns endpointing.
 */
class OnsetDetector(private val threshold: Double, private val sustainFrames: Int) {
    private var consecutive = 0
    private var speaking = false

    fun observe(frame: ShortArray): Boolean {
        val loud = computeRms(frame) >= threshold
        if (!loud) { consecutive = 0; speaking = false; return false }
        consecutive += 1
        if (!speaking && consecutive >= sustainFrames) { speaking = true; return true }
        return false
    }

    fun reset() { consecutive = 0; speaking = false }
}
```
> If `computeRms` is not already public in `io.sentient.mobilesdk.audio`, confirm its signature in `AudioCodec.kt` and adjust the import; do not duplicate the RMS math.

- [ ] **Step 4: Run test to verify it passes** — Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/voice/uplink/OnsetDetector.kt \
        shared/mobile-sdk/src/commonTest/kotlin/io/sentient/mobilesdk/voice/uplink/OnsetDetectorTest.kt
git commit -m "feat(mobile-sdk): voice OnsetDetector (barge-in edge flag)"
```

---

### Task 4: `VoiceFsm` — uplink states incl. `INITIALIZING`

**Files:**
- Create: `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/voice/VoiceFsm.kt`
- Test: `shared/mobile-sdk/src/commonTest/kotlin/io/sentient/mobilesdk/voice/VoiceFsmTest.kt`

**Interfaces:**
- Produces: `enum class VoicePhase { INACTIVE, INITIALIZING, LISTENING, USER_SPEAKING, PROCESSING, ASSISTANT_SPEAKING, INTERRUPTING }`; `sealed interface VoiceInput { TapOn; CaptureLive; CaptureFailed; MicOnset; Deactivate; ... }`; `class VoiceFsm { val phase: VoicePhase; fun apply(input: VoiceInput): VoicePhase }`. (Mirror the transitions the existing `AudioPipeline` FSM used; this slice needs INACTIVE→INITIALIZING→LISTENING→USER_SPEAKING→INACTIVE.)

- [ ] **Step 1: Write the failing test**
```kotlin
package io.sentient.mobilesdk.voice
import kotlin.test.Test
import kotlin.test.assertEquals

class VoiceFsmTest {
    @Test fun tap_goes_through_initializing_to_listening() {
        val fsm = VoiceFsm()
        assertEquals(VoicePhase.INACTIVE, fsm.phase)
        assertEquals(VoicePhase.INITIALIZING, fsm.apply(VoiceInput.TapOn))
        assertEquals(VoicePhase.LISTENING, fsm.apply(VoiceInput.CaptureLive))
        assertEquals(VoicePhase.USER_SPEAKING, fsm.apply(VoiceInput.MicOnset))
        assertEquals(VoicePhase.INACTIVE, fsm.apply(VoiceInput.Deactivate))
    }
    @Test fun capture_failure_returns_to_inactive() {
        val fsm = VoiceFsm()
        fsm.apply(VoiceInput.TapOn)
        assertEquals(VoicePhase.INACTIVE, fsm.apply(VoiceInput.CaptureFailed))
    }
}
```

- [ ] **Step 2: Run test to verify it fails** — Expected: FAIL.

- [ ] **Step 3: Write minimal implementation**
```kotlin
package io.sentient.mobilesdk.voice

enum class VoicePhase { INACTIVE, INITIALIZING, LISTENING, USER_SPEAKING, PROCESSING, ASSISTANT_SPEAKING, INTERRUPTING }

sealed interface VoiceInput {
    data object TapOn : VoiceInput
    data object CaptureLive : VoiceInput
    data object CaptureFailed : VoiceInput
    data object MicOnset : VoiceInput
    data object Deactivate : VoiceInput
}

/** Uplink-phase state machine. Pure; single-thread (pipeline dispatcher). */
class VoiceFsm {
    var phase: VoicePhase = VoicePhase.INACTIVE
        private set

    fun apply(input: VoiceInput): VoicePhase {
        phase = when (input) {
            VoiceInput.TapOn -> if (phase == VoicePhase.INACTIVE) VoicePhase.INITIALIZING else phase
            VoiceInput.CaptureLive -> if (phase == VoicePhase.INITIALIZING) VoicePhase.LISTENING else phase
            VoiceInput.CaptureFailed -> VoicePhase.INACTIVE
            VoiceInput.MicOnset -> if (phase == VoicePhase.LISTENING) VoicePhase.USER_SPEAKING else phase
            VoiceInput.Deactivate -> VoicePhase.INACTIVE
        }
        return phase
    }
}
```

- [ ] **Step 4: Run test to verify it passes** — Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/voice/VoiceFsm.kt \
        shared/mobile-sdk/src/commonTest/kotlin/io/sentient/mobilesdk/voice/VoiceFsmTest.kt
git commit -m "feat(mobile-sdk): voice FSM with INITIALIZING phase"
```

---

### Task 5: `MicSource` expect interface + `FakeMicSource` double

**Files:**
- Create: `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/voice/io/MicSource.kt`
- Create: `shared/mobile-sdk/src/commonTest/kotlin/io/sentient/mobilesdk/voice/io/FakeMicSource.kt`
- Test: `shared/mobile-sdk/src/commonTest/kotlin/io/sentient/mobilesdk/voice/io/FakeMicSourceTest.kt`

**Interfaces:**
- Produces: `interface MicSource { val frames: Flow<ShortArray> /* 16k mono PCM16, variable length */; val state: StateFlow<MicState>; suspend fun start(); suspend fun stop() }`. (Plain `interface`, not `expect` — the platform `actual`s are concrete classes that implement it and are injected via the bundle, mirroring the existing `AudioCaptureAdapter` injection. This keeps commonTest able to substitute `FakeMicSource`.)
- `FakeMicSource` exposes `suspend fun emit(pcm: ShortArray)` and a settable state for tests.

- [ ] **Step 1: Write the failing test**
```kotlin
package io.sentient.mobilesdk.voice.io
import io.sentient.mobilesdk.voice.MicState
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals

class FakeMicSourceTest {
    @Test fun emits_frames_and_state() = runTest {
        val mic = FakeMicSource()
        mic.start()
        assertEquals(MicState.Live, mic.state.value)
        mic.emit(shortArrayOf(1, 2, 3))
        assertEquals(listOf<Short>(1, 2, 3), mic.frames.first().toList())
    }
}
```

- [ ] **Step 2: Run test to verify it fails** — Expected: FAIL.

- [ ] **Step 3: Write the interface + fake**
```kotlin
// MicSource.kt
package io.sentient.mobilesdk.voice.io
import io.sentient.mobilesdk.voice.MicState
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.StateFlow

/**
 * Platform mic capture primitive. Captures + resamples to 16k mono PCM16 on a dedicated
 * realtime thread and exposes frames as a cold-ish Flow backed by a bounded drop-newest
 * channel. Owns device + (iOS) the shared full-duplex engine. Never runs on the SDK
 * orchestrator coroutine.
 */
interface MicSource {
    val frames: Flow<ShortArray>
    val state: StateFlow<MicState>
    suspend fun start()
    suspend fun stop()
}
```
```kotlin
// FakeMicSource.kt (commonTest)
package io.sentient.mobilesdk.voice.io
import io.sentient.mobilesdk.voice.MicState
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.receiveAsFlow

class FakeMicSource(channelCapacity: Int = 8) : MicSource {
    private val ch = Channel<ShortArray>(capacity = channelCapacity, onBufferOverflow = BufferOverflow.DROP_LATEST)
    private val _state = MutableStateFlow<MicState>(MicState.Idle)
    override val frames = ch.receiveAsFlow()
    override val state: StateFlow<MicState> = _state
    override suspend fun start() { _state.value = MicState.Live }
    override suspend fun stop() { _state.value = MicState.Idle }
    /** Push a frame; returns false if dropped (channel full). */
    fun emit(pcm: ShortArray): Boolean = ch.trySend(pcm).isSuccess
}
```

- [ ] **Step 4: Run test to verify it passes** — Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/voice/io/MicSource.kt \
        shared/mobile-sdk/src/commonTest/kotlin/io/sentient/mobilesdk/voice/io/FakeMicSource.kt \
        shared/mobile-sdk/src/commonTest/kotlin/io/sentient/mobilesdk/voice/io/FakeMicSourceTest.kt
git commit -m "feat(mobile-sdk): MicSource interface + fake double"
```

---

### Task 6: `VoiceUplinkPipeline` coordinator

**Files:**
- Create: `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/voice/VoiceUplinkPipeline.kt`
- Test: `shared/mobile-sdk/src/commonTest/kotlin/io/sentient/mobilesdk/voice/VoiceUplinkPipelineTest.kt`

**Interfaces:**
- Consumes: `MicSource` (Task 5), `Framer` (Task 2), `OnsetDetector` (Task 3), `VoiceFsm` (Task 4), `OpusEncoderPort` (existing: `fun encode(pcm: ShortArray): List<ByteArray>`, `fun reset()`).
- Produces: `class VoiceUplinkPipeline(mic, encoder, sendPacket: (ByteArray)->Unit, onOnset: ()->Unit, scope: CoroutineScope, dispatcher: CoroutineDispatcher, framer, onset)` with `suspend fun start()` / `suspend fun stop()`. Collects `mic.frames` on `dispatcher` (NOT the orchestrator), frames → onset (calls `onOnset` on edge) → encode → `sendPacket` 1:1.

- [ ] **Step 1: Write the failing test**
```kotlin
package io.sentient.mobilesdk.voice
import io.sentient.mobilesdk.audio.opus.OpusEncoderPort
import io.sentient.mobilesdk.voice.io.FakeMicSource
import io.sentient.mobilesdk.voice.uplink.Framer
import io.sentient.mobilesdk.voice.uplink.OnsetDetector
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlin.test.Test
import kotlin.test.assertTrue

private class FakeEncoder : OpusEncoderPort {
    override fun encode(pcm: ShortArray): List<ByteArray> = listOf(ByteArray(4) { 9 }) // 1 packet/frame
    override fun reset() {}
}

class VoiceUplinkPipelineTest {
    @Test fun frames_become_packets_sent_1_to_1() = runTest {
        val mic = FakeMicSource()
        val sent = mutableListOf<ByteArray>()
        val d = UnconfinedTestDispatcher(testScheduler)
        val pipe = VoiceUplinkPipeline(
            mic = mic, encoder = FakeEncoder(), sendPacket = { sent.add(it) }, onOnset = {},
            scope = this, dispatcher = d, framer = Framer(4), onset = OnsetDetector(0.05, 1),
        )
        pipe.start()
        mic.start()
        mic.emit(ShortArray(8) { 8000 }) // 8 samples → 2 frames of 4 → 2 packets
        testScheduler.advanceUntilIdle()
        assertTrue(sent.size == 2)
        pipe.stop()
    }
}
```

- [ ] **Step 2: Run test to verify it fails** — Expected: FAIL.

- [ ] **Step 3: Write minimal implementation**
```kotlin
package io.sentient.mobilesdk.voice

import io.sentient.mobilesdk.audio.opus.OpusEncoderPort
import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.voice.io.MicSource
import io.sentient.mobilesdk.voice.uplink.Framer
import io.sentient.mobilesdk.voice.uplink.OnsetDetector
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch

private const val TRACE_FIRST = 5
private const val TRACE_EVERY = 50

/**
 * Real-time uplink: mic.frames (16k PCM16) → Framer (20ms) → OnsetDetector (barge-in edge)
 * → Opus encode → sendPacket 1:1. Runs on [dispatcher] (a dedicated single thread), NEVER
 * the SDK orchestrator. sendPacket is the WS binary sink (paced by the capture clock).
 */
class VoiceUplinkPipeline(
    private val mic: MicSource,
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
        mic.start()
        job = scope.launch(dispatcher) {
            mic.frames.collect { pcm -> onPcm(pcm) }
        }
    }

    suspend fun stop() {
        job?.cancel(); job = null
        encoder.reset()
        mic.stop()
    }

    private fun onPcm(pcm: ShortArray) {
        for (frame in framer.push(pcm)) {
            framesIn += 1
            if (onset.observe(frame)) onOnset()
            for (packet in encoder.encode(frame)) {
                sendPacket(packet)
                packetsOut += 1
            }
        }
        if (framesIn <= TRACE_FIRST || framesIn % TRACE_EVERY == 0) {
            log.debug("uplink", mapOf("framesIn" to framesIn, "packetsOut" to packetsOut))
        }
    }
}
```

- [ ] **Step 4: Run test to verify it passes** — Expected: PASS.

- [ ] **Step 5: Add a drop-newest backpressure test (fake mic overflow)**
```kotlin
@Test fun mic_channel_drops_newest_not_oldest_under_flood() = runTest {
    val mic = FakeMicSource(channelCapacity = 2)
    mic.start()
    val ok = (1..5).map { mic.emit(shortArrayOf(it.toShort(), 0, 0, 0)) }
    // first 2 buffered, rest dropped-newest while unconsumed
    assertTrue(ok.take(2).all { it } && ok.drop(2).any { !it })
}
```
Run the test target; Expected: PASS (documents the bounded drop-newest contract at the mic boundary).

- [ ] **Step 6: Commit**
```bash
git add shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/voice/VoiceUplinkPipeline.kt \
        shared/mobile-sdk/src/commonTest/kotlin/io/sentient/mobilesdk/voice/VoiceUplinkPipelineTest.kt
git commit -m "feat(mobile-sdk): VoiceUplinkPipeline (decoupled 1:1 real-time send)"
```

---

### Task 7: iOS `MicSource` actual — shared full-duplex engine, tap→ring→consumer

**Files:**
- Create: `shared/mobile-sdk/src/iosMain/kotlin/io/sentient/mobilesdk/voice/io/IosMicSource.kt`
- Reuse: `Pcm16Converter.ios.kt` (the fixed `.noDataNow` converter), `ObjCExceptionGuard.ios.kt`.
- Modify (or replace): `SharedAudioEngine.ios.kt` — keep ONE engine, VPIO always-on, output graph present (the playerNode is added in Slice 2; for Slice 1 reference `mainMixerNode` so VPIO has its output half, as proven in `aa44502`).

**Interfaces:**
- Produces: `class IosMicSource(clock, scope) : MicSource` per Task 5. `start()` (off main): set `MicState.Initializing` → activate session + start engine + install tap on a dedicated consumer → on first delivered frame set `MicState.Live`. Tap callback does **only** copy float samples into a pre-allocated ring + signal; the consumer (a `DispatchQueue`/dedicated thread) runs `Pcm16Converter.convert` (48k→16k) and `trySend`s 16k `ShortArray` into the bounded frames channel (`BufferOverflow.DROP_LATEST`).

This task is **device-verified**, not unit-tested (sim has no mic). Key constraints baked in from the saga:
- VPIO is enabled ONCE for the session; the engine has a live output graph (`mainMixerNode` referenced) so VPIO renders — never capture-only-VP.
- Tap block: copy + return only. No alloc/lock/log/`Task`/await in the tap.
- One long-lived consumer drains the ring; resample with the reused converter (`.noDataNow`); read input format AFTER enabling VP; bind tap + converter to that format.
- Engine start runs OFF the main thread; `MicState` transitions emitted for the UI.
- Observe `AVAudioEngineConfigurationChange` → restart.

- [ ] **Step 1: Implement `IosMicSource`** skeleton wiring the above (reuse `SharedAudioEngine` retain/ensureRunning + `Pcm16Converter`; expose `frames`/`state` per `MicSource`). Keep functions <40 lines; the tap block is its own function that only copies to the ring.

- [ ] **Step 2: Build the debug XCFramework**

Run: `source scripts/env.sh && ./scripts/ios-setup.sh`
Expected: BUILD SUCCESSFUL; project regenerated.

- [ ] **Step 3: Device verification (developer runs from Xcode, attached)** — tap mic, speak. Console must show: `voice.uplink` framesIn climbing, `MicState` Initializing→Live, and the gateway transcribes within ~1.5s with NO multi-second delay and a single turn. Capture the trail.

- [ ] **Step 4: Commit**
```bash
git add shared/mobile-sdk/src/iosMain/kotlin/io/sentient/mobilesdk/voice/io/IosMicSource.kt \
        shared/mobile-sdk/src/iosMain/kotlin/io/sentient/mobilesdk/audioio/SharedAudioEngine.ios.kt
git commit -m "feat(mobile-sdk): iOS MicSource (shared full-duplex engine, tap→ring→consumer)"
```

---

### Task 8: Android `MicSource` actual — `AudioRecord` VOICE_COMMUNICATION thread

**Files:**
- Create: `shared/mobile-sdk/src/androidMain/kotlin/io/sentient/mobilesdk/voice/io/AndroidMicSource.kt`
- Reuse: existing resampler in `CaptureSession.android.kt` if 16k native is rejected.

**Interfaces:**
- Produces: `class AndroidMicSource(context, clock, scope) : MicSource`. `start()` (off main): `MicState.Initializing` → open `AudioRecord(VOICE_COMMUNICATION, 16000, MONO, PCM16, PERFORMANCE_MODE_LOW_LATENCY)` on a dedicated `Thread` at `THREAD_PRIORITY_URGENT_AUDIO` → blocking `read()` loop → `trySend` 16k `ShortArray` into the bounded frames channel → `MicState.Live` on first frame. NO stacked `AcousticEchoCanceler`/`NoiseSuppressor` (VOICE_COMMUNICATION provides AEC). Permission checked; failure → `MicState.Error`.

This task is **device/emulator-verified** (emulator mic via host).

- [ ] **Step 1: Implement `AndroidMicSource`** per above; read loop on the dedicated thread, hand off via bounded `Channel` (`DROP_LATEST`); no per-frame allocation beyond the read buffer + emitted copy.

- [ ] **Step 2: Build** — Run: `./gradlew :shared:mobile-sdk:assembleDebug` — Expected: BUILD SUCCESSFUL.

- [ ] **Step 3: Device/emulator verification** — `./scripts/build-android.sh`, install, tap mic, speak; logcat shows `voice.uplink` framesIn climbing + transcript fast.

- [ ] **Step 4: Commit**
```bash
git add shared/mobile-sdk/src/androidMain/kotlin/io/sentient/mobilesdk/voice/io/AndroidMicSource.kt
git commit -m "feat(mobile-sdk): Android MicSource (AudioRecord VOICE_COMMUNICATION thread)"
```

---

### Task 9: Control-plane integration in `SentientSdk`

**Files:**
- Modify: `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/sdk/SentientSdk.kt` (`startMic`/`stopMic`, ~341-358)
- Modify: the SDK bundle/DI that injects capture (where `bundle.capture` is wired) → inject `MicSource` + build `VoiceUplinkPipeline` with a dedicated dispatcher (`newSingleThreadContext("voice-uplink")` or platform equivalent).
- Test: `shared/mobile-sdk/src/commonTest/kotlin/io/sentient/mobilesdk/voice/UplinkWireContractTest.kt`

**Interfaces:**
- Consumes: `VoiceUplinkPipeline` (Task 6), `UserAudioInputConnector` (existing: `startStreaming()` sends `audio.start`, `stopStreaming()` sends `audio.end`, `sendAudioFrame(ByteArray)` → binary). `sendPacket` for the pipeline = `connectors.audioInput::sendAudioFrame`.
- Produces: `SentientSdk.startMic()` now: mark interaction → `connectors.audioInput.startStreaming()` (audio.start) → `voiceUplink.start()` (pipeline drives MicSource; engine starts off-main) → expose `micState` on the SDK state surface. `stopMic()` → `voiceUplink.stop()` → `connectors.audioInput.stopStreaming()` (audio.end).

- [ ] **Step 1: Write the failing wire-contract test** (fake connector records sends; fake mic emits; assert exactly `audio.start`, then N binary packets, then `audio.end`, all via the connector — proving the wire shape is unchanged and the pipeline drives it).
```kotlin
// Use FakeMicSource + a fake UserAudioInputConnector recording calls.
// assert order: startStreaming() → sendAudioFrame()×N → stopStreaming()
```
(Write the concrete fake + assertions against the real `UserAudioInputConnector` interface.)

- [ ] **Step 2: Run** — Expected: FAIL.

- [ ] **Step 3: Wire `startMic`/`stopMic` to the pipeline** (remove the old `audio.startUplink()`/`UplinkPump` call path; route through `voiceUplink`). Emit `micState` from `MicSource.state`.

- [ ] **Step 4: Run** — Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/sdk/SentientSdk.kt \
        shared/mobile-sdk/src/commonTest/kotlin/io/sentient/mobilesdk/voice/UplinkWireContractTest.kt
git commit -m "feat(mobile-sdk): drive uplink via VoiceUplinkPipeline (wire unchanged)"
```

---

### Task 10: Migration — remove the orchestrator-coupled capture path

**Files:**
- Delete: `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/audioio/UplinkPump.kt`
- Delete (capture half only): old `AudioCaptureAdapter` (common + ios + android) + `FaultAwareCaptureAdapter.kt` once `MicSource` fully replaces them. KEEP: `AudioPipeline.kt` downlink bits, `AudioPlaybackAdapter`, `StandalonePlaybackEngine` (Slice 2), `OpusUplinkEncoder`, `Pcm16Converter`, `audio/opus/*`, `audio/AudioCodec.kt`.
- Remove now-unused client drop-gate wiring from the uplink path: `SpeechGate`/`EchoGate` are no longer in the uplink (Decision D2). Leave the files for now (Slice 2 may reuse EchoGate's playback-window signal); just ensure nothing in the uplink imports them.

- [ ] **Step 1: Delete `UplinkPump.kt` + old capture adapters**; fix all references (compile-driven).
- [ ] **Step 2: Build all targets** — Run: `./gradlew :shared:mobile-sdk:compileKotlinIosArm64 :shared:mobile-sdk:assembleDebug` — Expected: BUILD SUCCESSFUL (no dangling refs).
- [ ] **Step 3: Run the full commonTest suite** — Run: `./gradlew :shared:mobile-sdk:iosSimulatorArm64Test` (or the configured unit target) — Expected: all green; deleted-feature tests (`AudioPipelineTest` uplink portions, `UplinkPump`-related) removed in the same commit.
- [ ] **Step 4: Commit**
```bash
git add -A shared/mobile-sdk
git commit -m "refactor(mobile-sdk): delete orchestrator-coupled UplinkPump + old capture path"
```

---

### Task 11: Version bump + text-chat smoke + device handoff

**Files:**
- Modify: `shared/mobile-sdk/build.gradle.kts` (version changelog + bump), `android/build.gradle.kts` (versionCode/versionName), `ios/project.yml` (CFBundle*).

- [ ] **Step 1: Bump versions** (sdk + app lockstep, e.g. 0.1.6 → 0.1.7; android versionCode +1; iOS CFBundleVersion +1) with a changelog line: "voice uplink refactor (real-time decoupled pipeline)".
- [ ] **Step 2: Agent text-chat smoke (no mic)** — boot the local stack per e2e rules; on iOS sim/Android emulator: launch, connect, send a TEXT message, get a reply, background→foreground keeps the socket. Confirm no crash and control plane intact. (Mic cases are user-owned — see spec §15.)
- [ ] **Step 3: Build deployable debug artifacts** — `./scripts/ios-setup.sh` + `./scripts/build-android.sh`.
- [ ] **Step 4: Hand off to user for the 6 mic e2e cases** (instant tap-talk, real-time delivery, slow-network) with the trail to capture.
- [ ] **Step 5: Commit**
```bash
git add shared/mobile-sdk/build.gradle.kts android/build.gradle.kts ios/project.yml
git commit -m "chore(mobile): bump versions for voice uplink slice"
```

---

## Self-Review

**Spec coverage (Slice 1 portion):** §4 module structure → Tasks 1-8; §5 uplink → Tasks 2,3,6,7,8; §7 mic-on-tap + MicState → Tasks 1,4,7,8; §9 control-plane wire-unchanged → Task 9; §12 logging throttled → Task 6 (TRACE_FIRST/EVERY); §13 testing → Tasks 1-6,9; §14 migration → Task 10. Deferred to later slices (called out): §6 downlink/jitter/playback, §8 barge-in commit (only the onset *flag* is here), full §7 lifecycle teardown/rebuild, headphones VP-bypass.

**Placeholder scan:** Tasks 7 & 8 (platform actuals) intentionally specify structure + constraints + device-verification instead of full cinterop/Android code — these are device-iterated and cannot be honestly pre-scripted line-for-line; the critical learned constraints (VPIO duplex graph, tap copy-only, `.noDataNow`, post-VP format, dedicated URGENT_AUDIO thread, no stacked AEC) are explicit. All commonMain tasks have complete code.

**Type consistency:** `MicSource.frames: Flow<ShortArray>`, `.state: StateFlow<MicState>` consistent across Tasks 5/6/7/8/9. `OpusEncoderPort.encode(ShortArray): List<ByteArray>` matches existing usage. `FRAME_SAMPLES_16K=320` used in Framer default. `VoiceInput`/`VoicePhase` consistent in Task 4.

**Note on test runner:** the exact Gradle unit-test target (`iosSimulatorArm64Test` vs a JVM target) must be confirmed against `shared/mobile-sdk/build.gradle.kts` at execution start; the commands above assume the iOS sim test target the module already uses for `OpusRoundTripTest`.
