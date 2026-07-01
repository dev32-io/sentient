# Voice Engine Consolidation — `VoiceAudio` one-engine design

**Status:** approved (design dialogue 2026-06-30) — pending spec review → plan → subagent-driven build.
**Branch:** `feature/mobile-audio-input-stt` (extends PR #15; the Slice-1 uplink work).
**Supersedes:** the two-engine iOS audio design (`SharedAudioEngine` + `StandalonePlaybackEngine`) and the split `MicSource` / `AudioPlaybackAdapter` interfaces.

## Problem

The mobile client toggles **mic** and **TTS** independently — four states: `(off,off)`, `(off,on)`, `(on,off)`, `(on,on)`. The current iOS design uses **two** `AVAudioEngine`s chosen at runtime by `SharedAudioEngine.isCaptureActive`:
- shared `.playAndRecord` (+ VPIO) for capture + voice-mode TTS,
- standalone `.playback` for text-chat TTS (no mic permission).

This split exists only for mic-permission/battery scoping, and its **transition** between the two engines over the single `AVAudioSession` is where hard bugs live:
- **Crash** — `AVAudioPlayerNode.play()` → `player started when in a disconnected state`, because the VP-off capture engine had no output graph (fixed interim in `2633b4e` by referencing `mainMixerNode`).
- **VPIO `StartIO` failure** — enabling VPIO on the `.playback → .playAndRecord` handoff (TTS-then-mic) fails (`AUIOClient_StartIO failed`, preceded by `-50` route-property errors).
- **Echo** — with VPIO off there is no AEC, so the mic captures the TTS output and STT transcribes the assistant (self-triggered phantom turns).

Full-duplex (mic open during TTS) + voice barge-in **requires** AEC. On iOS that is VPIO. VPIO works, but only starts cleanly on a single, well-owned engine + session — not across a two-engine straddle. Two near-duplicate engines are the root complexity.

## Decisions (locked)

- **D1 — mic permission up front.** The product is voice-first; requesting mic permission at first use is acceptable, so a single `.playAndRecord` engine can serve every state. Smooth UX beats a text-only no-permission path.
- **D2 — one engine, one interface (`VoiceAudio`).** A single boundary interface. Toggling mic/TTS is one idempotent `configure(mic, playback)` reconfig call; the interface emits readiness state. Callers never see `AVAudioEngine`/VPIO — full encapsulation, matching the SDK's black-box philosophy.
- **D3 — VPIO only in the `mic+TTS` cell.** AEC is enabled exactly when there is echo to cancel (both mic and playback active). Toggling TTS while the mic is on triggers a brief, deliberate engine reconfig (stop → set VPIO → start) — accepted, and far more robust than dynamic VPIO toggling on a running engine.
- **D4 — teardown at idle (battery).** `configure(false,false)` / `shutdown()` stops the engine and deactivates the session. No mic kept hot, no `.playAndRecord` cost outside active audio. No pre-warm.
- **D5 — clean reconfig, never a straddle.** Every capability change is a diff → stop → reconfigure the ONE engine graph (tap / player / VPIO) → `ensureRunning`. No second engine, no session handoff — the entire `StartIO`-on-dirty-session bug class is deleted by construction.

## The interface (commonMain — the single boundary)

```kotlin
package io.sentient.mobilesdk.voice.io

/** Reactive engine readiness for the UI + the SDK reconfig surface. */
data class VoiceAudioState(
    val phase: Phase,
    val micActive: Boolean,
    val playbackActive: Boolean,
) {
    enum class Phase { Idle, Configuring, Ready, Error }
    val errorReason: String? // set iff phase == Error
}

interface VoiceAudio {
    /** Continuous readiness state (StateFlow — conflation fine). UI: spinner on Configuring. */
    val state: StateFlow<VoiceAudioState>

    /** 16k mono PCM16 capture frames. Hot ONLY while micActive; bounded, producer drop-newest. */
    val micFrames: Flow<ShortArray>

    /** THE reconfig call. Idempotent — no-op if already in (mic, playback). Diffs + reconfigures
     *  the single engine. Suspends until the reconfigure settles (→ Ready) or fails (→ Error). */
    suspend fun configure(mic: Boolean, playback: Boolean)

    /** Downlink sink: one PCM16 LE frame → playback. No-op if playbackActive is false. */
    fun playFrame(pcm16: ByteArray)

    /** Flush queued playback (barge-in / interrupt drop-guard). */
    fun flushPlayback()

    /** Idle when no scheduled buffer remains (pipeline holds "speaking" until the tail drains). */
    val isPlaybackIdle: Boolean

    /** Terminal teardown: stop engine + deactivate session + release. */
    suspend fun shutdown()
}
```

The SDK's `startMic`/`stopMic`/`setTtsEnabled` translate to `configure(mic, playback)`. The UI binds to `state` (spinner on `Configuring`, mic-active on `Ready && micActive`). Errors surface as `Phase.Error` + reason — never thrown across the boundary.

## Internal one-engine state machine (iOS actual)

ONE `AVAudioEngine`, session `.playAndRecord` + `.voiceChat`, activated on the first non-idle `configure`, deactivated at idle/shutdown. `configure(mic, playback)` computes the desired graph and, if it differs from current, stops the engine, applies the diff, and restarts:

| (mic, tts) | input tap | player node | VPIO (AEC) | output graph | engine |
|---|---|---|---|---|---|
| off, off | — | — | — | — | **torn down**, session deactivated |
| off, on | — | ✓ | off | ✓ (mainMixer→out) | running |
| on, off | ✓ (16k conv) | — | off (no echo source) | ✓ | running |
| on, on | ✓ | ✓ | **on** | ✓ | running (full-duplex AEC) |

- **VPIO** = `input.setVoiceProcessingEnabled(true)` iff `mic && playback`; disabled otherwise. Enabling/disabling happens only inside a stop→reconfigure→start (never on a live engine), so it always starts on a clean session.
- **Output graph** = reference `mainMixerNode` whenever a player is (or will be) attached, so the player never starts "disconnected".
- **Input tap** = the proven convert-in-tap path (reused `Pcm16Converter`, 48k→16k), feeding `micFrames` via a bounded SUSPEND channel, drop-newest (from `IosMicSource`).
- **Player** = `AVAudioPlayerNode` → `mainMixerNode` (from `AudioPlaybackAdapter`), `playFrame` schedules PCM16→float buffers.
- No `isCaptureActive` chooser, no standalone engine, no `.playback` category, no straddle/`setActive(false)`-deferral.

## Android actual

Same `VoiceAudio` contract; internally wraps `AudioRecord` + `AudioTrack` (separate objects — Android has no shared-session fragility):
- mic → `AudioRecord`; source = `VOICE_COMMUNICATION` when `mic && playback` (built-in HW AEC), else `VOICE_RECOGNITION`/`MIC` (no stacked AEC) on the URGENT_AUDIO thread (from `AndroidMicSource`).
- playback → `AudioTrack` (from `AndroidAudioPlaybackAdapter`).
- `configure` opens/closes each as the matrix requires; VPIO-equivalent (VOICE_COMMUNICATION AEC) only in the `mic+TTS` cell. Same `state` phases.

## What it replaces (kills the duplication)

- Delete: `SharedAudioEngine.ios`, `StandalonePlaybackEngine.ios`, `IosMicSource`, `AudioPlaybackAdapter.ios` → **one** `VoiceAudio.ios`.
- Delete: `AndroidMicSource` (+ `MicAudioRecordSession`), `AndroidAudioPlaybackAdapter` → **one** `VoiceAudio.android`.
- Replace interfaces `MicSource` + `AudioPlaybackAdapter` → `VoiceAudio`. `PlatformBundle.mic`/`.playback` → `bundle.voiceAudio`.
- Rewire: `VoiceUplinkPipeline` consumes `voiceAudio.micFrames`; the downlink `AudioPipeline` feeds `voiceAudio.playFrame` / `flushPlayback` / reads `isPlaybackIdle`; `SdkVoice`/`SdkAudio` call `voiceAudio.configure(...)`.
- Keep: `Pcm16Converter`, `Pcm16Resampler`, `OpusUplinkEncoder`, `OggOpusDemuxer`/decoder, `AudioCodec`, `PcmConvert`, the `voice/` uplink pipeline (`Framer`/`OnsetDetector`/`VoiceFsm`/`VoiceUplinkPipeline`), `SdkVoice` actor.

## Control-plane / wire

Unchanged. `configure` is internal; the uplink still emits `audio.start` → N binary Opus → `audio.end`; the downlink still consumes `connector.audio.*`. `SdkVoice`'s ordered command actor still serializes start/stop; `setTtsEnabled` maps to a `configure(playback=…)` on the same serialized lane so mic/TTS reconfigs never race.

## Error / logging / testing

- No-crash contract: every failure path → `Phase.Error(reason)`, never a throw across `@ObjCExport`. Format guard before throwing AV calls; ObjC `@try/@catch` on engine prepare/start.
- Tagged logger `["sentient","mobile-sdk","voice","engine","ios|android"]`; log every `configure` diff + phase transition + VPIO on/off + teardown; lengths/counts only, never audio content (PrivacyGuard stays green).
- commonMain: the `configure`-diff decision (what graph each `(mic,tts)` needs) is a PURE function → unit-tested in commonTest against a `FakeVoiceAudio`; the pipelines test against the fake. Platform actuals are device-verified (sim has no mic).

## E2E matrix (INLINE — per `.claude/rules/e2e-testing.md`)

Agent runs the text-only + reconfig-observable cases on the iOS sim / JVM; **all mic-audible cases are USER device-owned** (sim has no mic; echo/AEC is audible-only).

| Case | Viewport | Pre-state | Action | Expected user-visible | Expected log trail |
|---|---|---|---|---|---|
| config-diff unit | JVM | — | `configure` each of 4 cells + transitions | pure diff returns correct graph per cell | n/a (unit) |
| text TTS only (agent) | iOS sim | connected, mic off | send text, TTS-enabled | reply streams + **audible**, no crash | `voice.engine.ios` phase Idle→Configuring→Ready, playbackActive, no Error |
| mic-only STT (USER) | device | mic off, TTS off | tap mic, speak | transcript near-instant, no delay | micActive, tap-buffer climbing, **no VPIO**, no frame-dropped |
| **full-duplex (USER)** | device | mic on, TTS on | speak, assistant replies with TTS | TTS audible **AND no echo/phantom-turn** (mic doesn't transcribe the assistant) | VPIO **on**, no `StartIO` failure, no self-turn |
| TTS-then-mic (USER) | device | text TTS just played | tap mic | mic starts clean, STT works | clean reconfig Idle/Configuring→Ready, **no `-50`/`StartIO` failure** |
| TTS toggle mid-voice (USER) | device | mic on | enable TTS | brief reconfig, VPIO comes on, next reply echo-free | one Configuring→Ready reconfig, VPIO on |
| rapid mic toggle (USER) | device | mic on | toggle mic fast | no stuck mic, no crash | serialized reconfigs (SdkVoice actor), no leaked engine |
| idle teardown (USER) | device | mic on, TTS on | mic off + TTS drains | engine stops | teardown log, session deactivated, battery quiescent |

## Migration / rollout

Single branch (extends PR #15). Old two-engine code deleted in the same slice (git history is the reference). Interim `2633b4e` (VP-off output-graph crash fix) is superseded by `VoiceAudio.ios`. Version bump on completion.
