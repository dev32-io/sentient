# Hold-to-Talk / Toggle-to-Talk Split — Design Spec

- **Date:** 2026-07-17
- **Branch:** `feature/mobile-tts-playback-gain` (continues from the makeup-gain commits; rename or fresh branch at implementation start is fine)
- **Status:** Approved design, pre-implementation
- **Scope:** WhisperSTTService, gateway, `shared/web-sdk` (schema parity only), `shared/mobile-sdk`, iOS app, Android app.

## 1. Why (problem statement)

Native mobile TTS is quiet and the phone's volume buttons don't control it. Root cause chain:

1. The one-stable-session design (`.playAndRecord` + `.videoChat` on iOS; `USAGE_VOICE_COMMUNICATION` on Android) plays ALL TTS on the voice-call route: output ducked/capped below media loudness, volume buttons bound to the in-call stream (only adjustable mid-playback). PCM makeup gain (landed, ×5.5 iOS) lifts the floor but cannot beat a capped route.
2. Route-by-activity (`.playback` when mic-free) was tried twice and both times the mid-audio category handoff killed audio (2633b4e; re-confirmed 2026-07-17). On one engine it also structurally can't work: a live input unit under `.playback` starts dead.
3. VPIO ducking `.min` (iOS 17 API) was tried: no audible effect. Reverted.

The deeper fault is UX-architectural: **hold-to-talk and toggle-to-talk are conflated into one full-duplex pipeline.** Smart-Turn v3 can fire a semantic turn while the user is still holding the mic — an anti-pattern (interaction already defines the turn). And because the conflated pipeline must always be ready for full-duplex, every TTS pays the VoIP-route cost.

Splitting the two flows makes the audio problem dissolve **by construction**: in hold mode, mic and TTS are never simultaneous, so simple media playback / simple mic capture are safe, loud, and volume-button-controlled — the Fish voice page (`VoiceSamplePlayer` / `VoiceRecorder`, scoped `.playback` / record sessions) already proves this pattern on this app.

## 2. Goals / non-goals

**Goals**
- Two explicit, cleanly separated talk flows:
  - **Hold-to-talk (manual turn):** user interaction is the turn authority. Press ⇒ interrupt any active assistant turn. Hold ⇒ speaking; no turn may fire. Release ⇒ end of turn (client-driven flush).
  - **Toggle-to-talk / continuous (semantic turn):** Smart-Turn v3 authority, full-duplex VPIO + AEC — today's proven path, untouched.
- STT service supports per-stream turn-mode reconfiguration (semantic on/off).
- Hold mode audio = dumb media primitives: "play PCM frames from WS" / "relay mic frames to WS". Zero dependency on the VoIP/duplex pipeline.
- Every audio-path transition happens on a dead-audio boundary (guaranteed by the UX, not by timing tricks).
- Proactive TTS arriving during a hold: **buffer frames, defer arm+playback until release.** Never play during a hold; never drop (except bounded-overflow).
- Mode logic fully encapsulated in `shared/mobile-sdk` behind UI-agnostic intents — the UI may be redesigned soon; only intent emission may change.
- webui behavior unchanged (defaults preserve today's semantics end-to-end).

**Non-goals**
- No UI redesign in this feature (current corner-mic gesture stays; it already has hold / drag-to-lock).
- No change to the continuous-mode pipeline internals (VPIO graph, EchoGate, tuned constants).
- No TTS output normalization / per-voice gain (rejected: quiet voices are character).
- No barge-in-by-voice in hold mode (press IS the barge-in).
- ESP32/web clients: no behavior change this feature.

## 3. Mode model (encapsulated in mobile-sdk)

New commonMain `TalkMode` FSM owned by a `TalkModeController` in `shared/mobile-sdk`:

```
TalkMode: Idle | Hold | Continuous
```

UI emits **intents only** (stable contract for the future redesign):

| Intent | From | Effect |
|---|---|---|
| `pressMic()` | Idle | If a cycle/TTS is active: send `interrupt`, flush playback. Enter Hold: capture path on, `audio.start(turnMode=manual)`. |
| `releaseMic()` | Hold | `audio.end` (gateway flushes STT ⇒ turn finalizes). Capture path off. Enter Idle. Arm media playback; flush any deferred TTS buffer. |
| `lockMic()` | Hold | `audio.end` + `audio.start(turnMode=semantic)` back-to-back; frames keep flowing. Tear down hold capture path, bring up duplex path. Enter Continuous. |
| `stopContinuous()` | Continuous | `audio.end`. Duplex path down. Enter Idle. |

Mapping from today's `MicCornerGesture` states: `.hold` ⇒ Hold, `.locked` ⇒ Continuous, `.idle` ⇒ Idle. The gesture file only translates gestures → intents; all semantics live in the controller.

Invariants:
- In Hold, playback is NEVER armed. Downlink TTS frames buffer (bounded; see §6).
- In Hold, no turn is dispatched until `releaseMic()`/`lockMic()` (server side guaranteed by manual turn mode).
- Transitions Idle↔Hold and Hold→Continuous and Continuous→Idle all occur with no audio rendering (press killed TTS; hold has no TTS; continuous teardown after drain — same as today).

## 4. Wire protocol

**Client ⇒ gateway** — `audio.start` gains one optional field:

```json
{ "type": "audio.start", "turnMode": "manual" | "semantic" }
```

Default when absent: `"semantic"` (webui + old clients unchanged; back-compat). `audio.end`, `interrupt`, binary frames: unchanged. Slide-to-lock is exactly `audio.end` + `audio.start(semantic)` — no new frame types.

**Gateway ⇒ STT** — one new control message on the existing STT WS, sent at stream start (after `hello`) and on any mid-stream change:

```json
{ "type": "turn_mode", "semantic": false }
```

Default (never sent): `semantic: true`. `flush` unchanged.

**web-sdk:** schema parity only (`turnMode` optional on the frame type); web keeps sending semantic (or nothing). Mirror-contract rule satisfied with zero behavior change.

## 5. STT service changes (WhisperSTTService)

`turn_pipeline` gains a `semantic_turns: bool` (default `True`), settable via the new `turn_mode` message:

- `semantic_turns=True`: today's behavior, byte-for-byte.
- `semantic_turns=False` (manual): Smart-Turn v3 is **bypassed** (never invoked — no wasted inference); VAD still runs for pre-speech trim, pause metrics, and `vad_start`/`vad_end` events, but **no path finalizes a turn except**:
  - `flush` (client release → `client_flush`) — the normal manual end;
  - `max_turn_duration` guard — kept as a hard safety valve (prevents unbounded holds).
- Mid-stream mode flip (lock gesture): gateway sends `flush` (via `audio.end`) *before* `turn_mode semantic:true`, so the flip always lands between turns. The pipeline treats a mode flip with an open turn as: force-finalize first (`reason=mode_change`, WARN — should not happen), then switch.

Events/protocol otherwise unchanged. `smart_turn_eval` simply never appears in manual streams (assert in tests).

## 6. Gateway changes

- `audio.start` schema: optional `turnMode` (zod, default `semantic`).
- STT adapter (`local-stt-adapter.ts`): relay mode — send `turn_mode` after connect/`hello` when the session's mode ≠ semantic, and on every `audio.start` whose mode differs from the last-sent. `flush`-on-`audio.end` unchanged.
- Barge-in/interrupt semantics unchanged (`interrupt` already aborts cycle + TTS).
- No changes to TTS fork, AttentionGate, or cycle dispatch. Proactive cycles may still stream TTS during a hold — handled client-side (§7 buffering); the gateway does not need to know.

## 7. Mobile SDK changes

### 7.1 Audio path facade

`VoiceAudio` public surface (configure/playFrame/flushPlayback/micFrames/state) stays — SDK single-surface rule. Internally per platform, **two paths behind the facade**:

**iOS**
- `DuplexVoiceAudio` — the existing `IosVoiceAudio` engine, byte-for-byte (`.playAndRecord`+`.videoChat`, VPIO iff mic+playback, tap reinstall, gains). Used ONLY in Continuous.
- `MediaPlayback` — playback-only `AVAudioEngine` (player→mixer; **`inputNode` never touched**) on a scoped `.playback` session. Activate on arm, `setActive(false, notifyOthersOnDeactivation)` on drain-idle (mirrors `VoiceSamplePlayer`). Loud media route; volume buttons control media stream at any time.
- `MicCapture` — capture-only engine (input tap → 16k PCM16, `MIC_CAPTURE_GAIN`) on a scoped `.playAndRecord`+`.default` session, **no VPIO**. Mirrors today's tap code minus the duplex machinery.
- Selection by `TalkMode`: Hold ⇒ `MicCapture` (playback disarmed); Idle ⇒ `MediaPlayback` when TTS arrives; Continuous ⇒ `DuplexVoiceAudio`. The three never run concurrently; each transition crosses a dead-audio boundary and a full session deactivate.

**Android**
- Same facade split, cheap (independent AudioRecord/AudioTrack objects already):
  - Hold/Idle playback track: `USAGE_ASSISTANT` + `CONTENT_TYPE_SPEECH` (media volume stream).
  - Hold capture: `VOICE_RECOGNITION` source (no AEC — none needed).
  - Continuous: today's pair (`VOICE_COMMUNICATION` both sides) untouched.

### 7.2 Playback gains become per-path

| Path | iOS | Android |
|---|---|---|
| Media (hold/idle replies) | 1.0 | 1.0 |
| Duplex (continuous) | 5.5 (landed) | 3.0 (landed) |

Media route is loud; boosted PCM would clip. Constants stay in-file per the established `MIC_CAPTURE_GAIN` pattern.

### 7.3 Buffer-and-defer (proactive TTS during Hold)

Downlink frames arriving while `TalkMode == Hold` are appended to a bounded PCM buffer (reuse the existing lazy-arm pre-arm buffering in `AudioPipeline`; extend the bound to ~30 s). On `releaseMic()`: arm `MediaPlayback`, flush buffer in order, continue live. On overflow: drop-oldest + WARN (`reason=hold-buffer-overflow`, dropped byte count). On `lockMic()`: buffer flushes into the duplex path instead.

### 7.4 Logging (per logging rules)

Every mode transition: `talk-mode` INFO with `from`, `to`, `trigger`. Every path activation/teardown: engine tag + session shape. Buffered-defer: count + bytes at buffer start, on flush, on overflow. IDs (`cycleId`) where available.

## 8. UI wiring (thin)

- iOS `MicCornerGesture` / Android `MicCorner*`: translate gestures → controller intents. Remove any direct mic/audio toggling not routed through the controller.
- No visual redesign. `.hold`/`.locked` visuals unchanged.

## 9. Versions (+0.1.0 lockstep, per decision)

| Component | From | To |
|---|---|---|
| mobile (app + sdk lockstep) | 0.1.6/0.1.7 line | **0.2.0** (android versionCode +1, iOS bundle +1) |
| gateway | 1.12.1 | **1.13.0** |
| WhisperSTTService | 1.2.0 | **1.3.0** |
| web-sdk | current | minor bump (schema-only) |

## 10. Risks & mitigations

| Risk | Mitigation |
|---|---|
| iOS session transitions historically haunted (round-2-silent class) even at clean boundaries | Three fully separate engines; media/capture sessions are *scoped* (activate-use-deactivate, Fish-page pattern); duplex engine untouched; every transition in silence; multi-round device gate before anything stacks on it |
| Long hold ⇒ huge Whisper decode | Existing `max_turn_duration` guard retained in manual mode |
| Proactive TTS ordering after release | Buffer is FIFO; drain before live frames (single queue) |
| Old clients / webui | `turnMode` optional + defaults semantic end-to-end; STT default unchanged |
| Continuous regression | Zero diffs to duplex path; e2e rows pin it |

## 11. E2E matrix

Driver: native = Maestro tag-batch (`qa/mobile/run-e2e.sh --tags voice-mode`) + `logcat`/`os_log` trail; web = Playwright. **Loudness/volume-button rows are user-loop (agent cannot hear audio) — flagged U.**

| Case | Viewport | Pre-state | Action | Expected user-visible | Expected log trail |
|---|---|---|---|---|---|
| hold-basic | iPhone device | idle, voice ready | press-hold, speak, release | transcript appears; reply plays (media route) | `audio.start turnMode=manual` → frames → `flush reason=client_flush` → `turn_complete`; `talk-mode Idle→Hold→Idle`; media-engine arm |
| hold-no-premature-turn | iPhone device | idle | hold, speak, pause > silence-timeout, keep holding | NO reply until release | no `turn_complete`/`smart_turn_eval` before flush |
| hold-interrupt | iPhone device | TTS playing (media) | press mic mid-reply | TTS stops instantly; mic live | `interrupt` sent; `flush-playback`; capture-engine start |
| slide-lock | iPhone device | holding, mid-speech | slide to lock | first segment finalizes; continuous mode on | `audio.end`+`audio.start turnMode=semantic`; duplex engine start; `talk-mode Hold→Continuous` |
| continuous-turns | iPhone device | locked | speak naturally, multi-turn | turns fire on pauses (today's behavior); barge-in works | `smart_turn_eval` present; VPIO enabled |
| proactive-tts-hold | iPhone device | holding; second surface sends a message triggering TTS | silence during hold; buffered reply plays after release | buffer count logs; deferred arm on release; no player start during Hold |
| round-trip-stability | iPhone device | idle | 5× alternating hold-turns and replies, plus one lock/unlock cycle | every reply audible; mic live every round | no `engine-start-failed`/`session-activate-failed`; no silent round |
| android-parity | Android emulator+device | same as hold-basic / slide-lock | same | same | same trail, `USAGE_ASSISTANT` track in hold, voice-comm in locked |
| webui-regression | 1280×900 + 390×844 | web voice mode | toggle mic, speak, reply | unchanged behavior | `turnMode` absent or `semantic`; no STT `turn_mode` message |
| loudness-buttons **(U)** | iPhone device | idle | reply at ~50% media volume; press buttons during and between replies | comfortably audible; buttons adjust TTS both times | media-route session logs |
| aec-continuous **(U)** | iPhone device | locked, TTS playing | speak over TTS | no self-transcription | VPIO on; no echo-loop transcript |

## 12. Slices

1. **S1 — STT manual mode:** `turn_mode` message + `semantic_turns` gating + tests (unit: no smart-turn in manual; flush finalizes; mode-flip-with-open-turn WARN path). Version 1.3.0.
2. **S2 — Gateway relay:** `audio.start.turnMode` schema + adapter relay + unit tests (wire-contract mocks per testing rules). web-sdk schema parity. Gateway 1.13.0.
3. **S3 — SDK TalkModeController:** commonMain FSM + intents + buffer-and-defer + logging + commonTest (FakeVoiceAudio matrix).
4. **S4 — iOS paths:** `MediaPlayback` + `MicCapture` scoped engines behind the facade; per-path gain. **Device gate: hold-basic + round-trip-stability before proceeding.**
5. **S5 — Android paths:** per-mode attrs/source split. Emulator + device gate.
6. **S6 — UI intents:** gesture → controller wiring both apps.
7. **S7 — E2E + versions + docs:** full matrix run, version bumps, learnings/rules updates.
