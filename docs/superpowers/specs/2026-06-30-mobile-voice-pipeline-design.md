# Mobile Voice Pipeline — Design Spec

- **Date:** 2026-06-30
- **Branch (current):** `feature/mobile-audio-input-stt` (the dead-mic + converter fixes already landed here; this refactor continues from it or a fresh `feature/mobile-voice-pipeline`)
- **Status:** Approved design, pre-implementation
- **Scope:** `shared/mobile-sdk` (KMP) + thin iOS/Android client wiring. Gateway wire protocol is **unchanged**.

## 1. Why (problem statement)

The mobile voice path was a sequence of whack-a-mole device bugs (empty-graph `engine.prepare()`, `vpio render err -1`, dead input tap, `AVAudioConverter` `EndOfStream` terminal bug) — all symptoms of a **wrong foundation**, not isolated defects. The decisive evidence: with capture finally delivering frames, a "Hello." showed up **~10s late** with a **phantom barge-in**, while webui on the same gateway was fine. Gateway logs proved STT was instant (`transcript` == `speech-final` timestamp); the delay was entirely in **getting audio to the server**.

Two root architectural faults:
1. **Audio ran on the SDK orchestrator coroutine** (the "control plane"): capture→encode→send competed with WS-recv + state + a UI re-render storm, so it fell behind realtime.
2. **A 6.4s `DROP_OLDEST` capture channel** masked the lag, then bled stale audio as a long tail → late transcripts + phantom turns (textbook anti-pattern: a large drop-oldest queue breaks server VAD timing).

Production research (LiveKit, Pipecat, OpenAI Realtime, WebRTC/NetEQ, Twilio, Deepgram/AssemblyAI; plus our own web-sdk) converges on one principle: **a voice client is two clocks that must never drift** — mic produces at 1× realtime, speaker consumes at 1× realtime; send is paced 1:1 with capture; receive is smoothed by a *small adaptive* jitter buffer. The audio plane must be **decoupled from the control plane** onto dedicated realtime threads with **bounded** queues.

## 2. Goals / non-goals

**Goals**
- Real-time uplink: each ~20ms frame sent as captured, paced 1:1, no multi-second buffer.
- Audio plane fully decoupled from the WS/state coroutine (dedicated realtime threads + bounded handoff).
- Full-duplex with barge-in (mic open while TTS plays; AEC always-on for the voice session).
- Smooth TTS playback via a small adaptive jitter buffer.
- Instant-feeling tap-to-talk via off-main start + explicit `MicState` (spinner → live), without idle battery/mic-indicator cost.
- Mirror web-sdk's **role/shape** (decoupled audio, per-frame WS send, same wire frames, server-owned VAD).
- KMP: pure pipeline in `commonMain`; only OS primitives behind `expect/actual`.

**Non-goals**
- No WebRTC/LiveKit SDK adoption (we keep persistent-WS transport; we copy their *patterns*).
- No Oboe on Android (network latency dominates; Oboe's fast path disables the AEC we need + adds JNI hostile to KMP).
- No client-side VAD/endpointing authority (server owns it). No on-device wake word.
- No general-purpose media `audio/` player (this is `voice/`; `audio/` reserved for future).

## 3. Locked decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | **Full-duplex + barge-in** | Product is realtime voice; barge-in is the point. Drives AEC + shared-engine design. |
| D2 | **Continuous 1:1 streaming, thin onset detector only** — no client drop-gates | Server owns VAD; AEC handles echo; client gates clip onsets + caused phantom turns; matches Whisper less-DSP direction. |
| D3 | **Hybrid rebuild** | New clean `voice/` plane + engine/lifecycle layer; reuse proven Opus/converter/kopus + pure logic; delete the broken `SharedAudioEngine`/`UplinkPump` path. |
| D4 | Package name **`voice/`** (`io.sentient.mobilesdk.voice`) | Reserve `audio/` for a future media player. |
| D5 | **Mic-on-tap, off-main start**, with explicit `MicState` (`idle → initializing → live`) | No idle mic-dot/battery; spinner conveys init; off-main kills the 2s freeze. |
| D6 | **Engine lifecycle bound to foreground + voice-screen** — hard teardown on background, rebuild off-main on foreground | Avoids the webui kept-alive-across-background disaster. |
| D7 | **AEC (iOS VPIO / Android VOICE_COMMUNICATION) always-on for the voice session**, runtime-bypass for headphones, never per-TTS toggle | VPIO needs a live duplex graph (why capture-only-VP failed); toggling restarts the engine + glitches. |
| D8 | **Wire protocol unchanged** (`audio.start`/`audio.end`/binary opus) | Gateway is the contract; mirror web-sdk. |

## 4. Architecture & threading boundary

```
CONTROL PLANE  (existing SDK orchestrator coroutine)
  session FSM · WS send/recv · state surface · reconnect · barge-in/interrupt controllers
      ▲ events (micState, onset, playbackDrain, underrun, fsm)     │ commands (start/stop/gate/flush)
      │                                                            ▼
──────────── VOICE PLANE  (dedicated realtime threads + bounded queues) ────────────
 UPLINK:   MicSource(realtime thread): capture → resample 48→16k → 16k PCM16
           (tap does copy-to-ring + return ONLY)
              └─ trySend → [bounded mic Channel, drop-NEWEST]
           VoicePipeline(dedicated single-thread dispatcher):
              collect → Framer(20ms/320-sample) → OnsetDetector(RMS on AEC'd mic → barge-in flag)
                      → OpusUplinkEncoder(reuse, 24kbps VOIP) → UplinkSender → ws.sendBinary (1:1)
 DOWNLINK: ws audio → [JitterBuffer ~150ms adaptive] → OpusDownlinkDecoder
                    → PlaybackScheduler → Speaker.enqueue(scheduled) ; underrun → silence (never repeat)
           iOS: same shared AVAudioEngine as capture (AEC reference)
```

### Module layout
```
commonMain/.../voice/
  VoicePipeline.kt          coordinator: owns uplink+downlink; start/stop/setMicGateOpen; event flows
  VoiceFsm.kt               states: INACTIVE · INITIALIZING · LISTENING · USER_SPEAKING · PROCESSING ·
                            ASSISTANT_SPEAKING · INTERRUPTING (ported + INITIALIZING added)
  BoundedRing.kt            pre-allocated SPSC ring
  uplink/Framer.kt          accumulate → exact 20ms frames
  uplink/OnsetDetector.kt   RMS onset (barge-in flag only; never drops frames)
  uplink/UplinkSender.kt    bounded, drop-newest, 1:1 paced; emits dropped-count WARN
  downlink/JitterBuffer.kt  adaptive target depth, release timing, underrun→silence (pure policy)
  downlink/PlaybackScheduler.kt
  audio.opus.*              OpusUplinkEncoder / decoder — REUSE existing (kopus)
commonMain/.../voice/io/
  expect MicSource          16k mono PCM16 frames on a realtime thread; prewarm(); start()/stop(); setGateOpen()
  expect Speaker            enqueue(pcm) scheduled; flush(); start()/stop(); drain/underrun callbacks
iosMain/.../voice/io/       ONE shared AVAudioEngine (VPIO always-on); inputNode tap→ring→consumer;
                            playerNode→mainMixer→output; reused AVAudioConverter (block API, .noDataNow)
androidMain/.../voice/io/   AudioRecord(VOICE_COMMUNICATION) thread @ URGENT_AUDIO + AudioTrack(MODE_STREAM) thread
```

### Threading contract (the heart of the fix)
- Platform `MicSource`/`Speaker` own **dedicated realtime threads**. The iOS tap / Android `read()` does **only copy-to-ring + return** — no alloc, no lock, no I/O, no coroutine hop.
- Bridge to `commonMain` via **bounded `Channel`s** (`trySend`, drop-newest). Never the orchestrator coroutine, never `Dispatchers.Default/IO` for the hot path.
- `VoicePipeline` runs on **one dedicated single-thread dispatcher**, separate from the orchestrator. Encode (light, 20ms Opus) + `ws.sendBinary` happen there.
- Control plane ↔ voice plane communicate **only** via events/commands. The orchestrator never touches a frame.
- **No per-frame allocation** on the hot path — reuse buffers (small pool).

## 5. Uplink pipeline

- Resampling lives in the **platform `MicSource`** (iOS reused `AVAudioConverter`, block `convert(to:error:withInputFrom:)`, return `.noDataNow` not `.endOfStream`; Android records at 16k native or linear-resamples). `commonMain` receives 16k mono PCM16 and stays codec-only.
- `Framer` slices exact 20ms / 320-sample frames (tap buffer size is a hint; iOS often gives ~4800 frames — accumulate + slice downstream).
- `OnsetDetector` computes RMS on the **AEC'd** mic and raises a barge-in flag; it **never drops** frames.
- `OpusUplinkEncoder` (reuse): 16kHz mono, VOIP, 24kbps, 20ms.
- `UplinkSender`: `ws.sendBinary` one packet per frame, paced 1:1 by the capture clock. Backpressure = a tiny bounded buffer (a few frames) + drop-newest on sustained slowness, with a throttled `WARN` carrying the dropped count. **Never** a large drop-oldest backlog.

## 6. Downlink pipeline + shared full-duplex engine + AEC

- `JitterBuffer`: prebuffer ~150ms before first playout; adaptive target depth (grow under jitter, shrink when stable); on underrun **emit silence / PLC, never repeat the last buffer**.
- iOS: **ONE shared `AVAudioEngine`**. `setVoiceProcessingEnabled(true)` on input + output nodes, **once** before going live. `inputNode` tap (capture) and `playerNode → mainMixerNode → outputNode` (playback) live in the same graph so AEC always has its loudspeaker reference (this is *why* capture-only-VP failed). Observe `AVAudioEngineConfigurationChange` → restart. Drop AEC for headphones via runtime **bypass**, never a VP toggle.
  - **No-mic / text-chat TTS:** the shared VPIO engine requires mic permission, so retain a **standalone `.playback` engine** (existing `StandalonePlaybackEngine`) for TTS when capture is inactive. Full-duplex shared engine only when the mic is live.
- Android: `AudioTrack` `MODE_STREAM` / `USAGE_VOICE_COMMUNICATION`, fed from the jitter buffer on its own thread. Built-in AEC via `VOICE_COMMUNICATION` capture; **no** stacked `AcousticEchoCanceler`/`NoiseSuppressor`/`AGC`.
- Playback scheduling is platform (`AVAudioPlayerNode.scheduleBuffer(.dataPlayedBack)` keep-fed; AudioTrack write loop). Jitter-buffer **policy** is pure `commonMain`.

## 7. Mic lifecycle, pre-warm & reactive states

- **Mic-on-tap, off-main start.** The engine graph + converter + buffers are pre-built cheaply, but mic capture is **not** active until tap. No idle mic-indicator, no idle battery.
- On tap: `MicState` → **`initializing`** (UI swaps the mic button for a spinner) → start the engine + capture **off the main thread** → when frames flow → **`live`** (listening). On stop → `idle`.
- The user waits for the `live` cue before speaking (standard voice UX), so the small async start cost never clips the first word.
- **App lifecycle (D6):** engine lifecycle bound to foreground + voice-screen presence. On **background/blur**: full teardown (`setActive(false)`, stop, release). On **foreground**: rebuild off-main (before any tap). **Never** kept alive across background. The WS socket itself is kept per the mobile-lifecycle rule; only the audio engine is town down.

## 8. Barge-in coordination

- **Client onset = instant local duck only.** `OnsetDetector` (on the AEC'd mic) → existing `bargeInController` → instantly `JitterBuffer.flush()` + `Speaker.flush()` (kill assistant audio in ≤1 frame) while the mic keeps streaming.
- **Server VAD = authoritative commit.** Gateway `turn_started`/`speech-final` drives the real cycle cancel (Hermes task-cancel via today's path). Raw client energy never cancels a cycle (prevents the phantom-turn class).
- Preserves the project split: `bargeInController` (mic-onset) vs `interruptController` (UI Stop). The voice pipeline only *feeds onset*.

## 9. Control-plane integration

- `VoicePipeline` surface: `start()`, `stop()`, `setMicGateOpen(Boolean)`; event flows: `micState`, `onset`, `playbackDrain`, `underrun`, FSM transitions.
- `startMic` → `setMicGateOpen(true)` + send `audio.start`; the pipeline sends binary opus **from its own dispatcher**; `stopMic` → gate closed + `audio.end`. **Wire frames identical.**
- `VoiceFsm` keeps existing states + adds `INITIALIZING`; the SDK public state surface (StateFlow) gains the `MicState` for reactive UI but otherwise unchanged.
- `ws.sendBinary` must be safe to call from the dedicated audio dispatcher (ktor WS session send is suspend/thread-safe).

## 10. Constants (reuse web-sdk values)

- Uplink Opus: 16kHz mono, VOIP, **24kbps**, **20ms** frames, raw TOC packets (no OGG).
- Capture hardware rate 48k → resample to 16k in `MicSource`.
- Jitter prebuffer ~**150ms** initial, adaptive 80–150ms band; never 500ms.
- All tunables live in config where the SDK reads them (session.ready tunables / constants) per the config rule — no magic numbers in hot code.

## 11. Error handling

- No throw across the `@ObjCExport` boundary (keep the ObjC `@try/@catch` guard). Engine/format/permission failures degrade to a logged soft-fail + a `MicState`/event, never a crash.
- Timeout/guard the engine start; on failure emit `MicState.error` so the UI can recover.

## 12. Logging (throttled + private)

- Boundary logs only, **throttled** (first-N + every-Nth). **Never per-frame at INFO.** Keep the `tap/convert/pump/encode/send` trace shape but throttled.
- Lengths/counts/RMS/ids only — **never content** (`PrivacyGuardTest` stays green; vitals ring not flooded).
- Every state transition (incl. `MicState`, engine teardown/rebuild) logged as a structured event.

## 13. Testing

- `commonTest` (no device) covers all pure pieces with fakes: `BoundedRing`, `Framer`, `OnsetDetector`, `JitterBuffer` policy, `VoiceFsm`, Opus encode→decode round-trip, `UplinkSender` drop-newest behaviour.
- Platform `io` (`MicSource`/`Speaker`) get fake doubles for `commonTest`.
- Real-device behaviour is e2e only (simulator has no mic).

## 14. Migration

- **Delete:** `SharedAudioEngine` capture-only contortion, `UplinkPump` (orchestrator-coupled), old `AudioCaptureAdapter`/`AudioPlaybackAdapter` wiring, client drop-gate (`SpeechGate`/`EchoGate`) frame-dropping usage.
- **Reuse:** `OpusUplinkEncoder`, fixed `Pcm16Converter`, kopus, onset logic, `StandalonePlaybackEngine` (text-chat TTS).
- **Bump** `mobile-sdk` + app versions (sdk/app lockstep) when landed.

## 15. E2E matrix (inline)

**Ownership:** mic/voice cases require a human speaking → **user-owned**. The agent runs **text-chat smoke only** (no mic) to verify wiring doesn't crash + control plane works.

| Case | Owner | Device | Pre-state | Action | Expected user-visible | Expected log trail |
|---|---|---|---|---|---|---|
| Text chat smoke | **agent** | iOS+Android | launched | send text msg | reply renders; TTS plays via standalone engine | connect→session.ready→send→cycle→entry; no crash; standalone .playback |
| Background/resume (text) | **agent** | real | mid text session | background then foreground | session intact; reply still works | socket kept; engine teardown→rebuild off-main; no stuck state |
| Instant tap-talk | user | real | chat ready | tap → wait for `live` cue → speak | spinner→listening fast; first word captured; transcript ≤~1.5s | micState init→live; uplink 1:1; speech-final fast; no freeze |
| Real-time delivery | user | real | mic live | speak 5s, stop | transcript ends when you stop; one turn | continuous uplink-frame; no backlog-drop; single turn |
| Full-duplex barge-in | user | real | assistant TTS playing | speak over it | TTS ducks instantly; reply cancels | onset→barge-in→flush; server new turn |
| TTS smoothness | user | real | reply w/ TTS | listen | smooth, no stutter/underrun | jitter prebuffer→scheduled; no underrun-repeat |
| Headphones | user | real | BT/wired plugged | converse | no echo; AEC bypassed | vp-bypass engaged; no restart |
| Slow network (sad) | user | real | throttled | speak | brief catch-up, no growing lag | bounded drop-newest WARN; recovers |

## 16. Risks / open questions

- iOS VPIO `AVAudioEngineConfigurationChange` restart races during route changes (headphones plug mid-utterance) — needs careful restart handling + test.
- Android device variance in `VOICE_COMMUNICATION` AEC quality — escalation path is WebRTC software APM if OEM AEC proves weak (out of scope now; noted).
- `ws.sendBinary` from a non-orchestrator dispatcher must be verified thread-safe in the ktor WS engine.
- Exact `MicState` enum + how the iOS/Android UI binds the spinner (UI-layer work, follows the SDK surface).
