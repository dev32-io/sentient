# Client-Side VAD & Speech Boundary Detection — Deep Exploration

## Current State

The web client uses **push-to-talk** (toggle-to-talk) exclusively. Zero VAD logic anywhere in the client codebase.

**Audio capture pipeline:**
```
getUserMedia (48kHz, echoCancellation, noiseSuppression, autoGainControl)
  → GainNode (2.5x boost)
    → CaptureProcessor AudioWorklet (128-sample frames, batched to 512 = 10.6ms)
      → Float32→Int16 PCM conversion
        → postMessage to main thread
          → ws.sendBinary() raw ArrayBuffer
```

**Key files:**
- `web/src/audio/capture-worklet.ts` — CaptureProcessor: 4×128 sample batching, Float32→Int16
- `web/src/hooks/use-audio-capture.ts` — MediaStream lifecycle, `startCapture()`/`stopCapture()`, emits `audio.start`/`audio.end`
- `web/src/app.tsx:60-69` — `handleToggleTalk`: manual press starts/stops recording, sends `barge_in` on start
- `web/src/types.ts:7` — `TalkState = "idle" | "recording" | "processing"` (processing never used)
- `web/src/constants.ts` — `CAPTURE_SAMPLE_RATE = 48_000`, `CAPTURE_GAIN = 2.5`

**Protocol messages for speech boundaries:**
- Client→Gateway: `audio.start` (mic on), `audio.end` (mic off), `barge_in` (interrupt TTS)
- Gateway→Client: `transcript.partial` (defined but never sent), `transcript.final`

**Critical insight:** The gateway already has its own endpointing via Deepgram (`speech_final`, `UtteranceEnd`). Client-side VAD serves a *different* purpose: it controls (a) when audio *starts flowing* to the gateway, (b) user-visible feedback ("I'm listening"), and (c) barge-in detection during assistant speech.

## Architecture Decision: Client-Side vs Gateway-Side VAD

The existing STT strategy doc (`stt-strategy.md`) recommends **gateway-side Silero VAD** for endpointing (double-endpointing with Deepgram). This is about *utterance boundary detection* — when to flush transcript to LLM.

Client-side VAD is complementary and serves different needs:

| Concern | Client-side VAD | Gateway-side VAD |
|---------|----------------|-----------------|
| Purpose | UX feedback, barge-in trigger, bandwidth savings | Utterance boundary, STT endpointing |
| Latency requirement | <50ms (perceptual) | <300ms (conversational) |
| What it controls | When to start/stop sending audio | When to flush transcript to LLM |
| Failure mode | False start → minor bandwidth waste | False end → truncated utterance |
| Implementation target | SDK (per-platform) | Gateway (single implementation) |

**Key question: Does client-side VAD replace push-to-talk, or complement it?**

Answer: **Both modes must coexist.** VAD mode for hands-free continuous listening. Toggle mode as fallback for noisy environments or user preference. Same downstream protocol (`audio.start`/`audio.end`) regardless of trigger source.

## Approach A: Energy-Based VAD in AudioWorklet

**Concept:** Compute RMS energy per audio batch inside the existing CaptureProcessor worklet. Compare against adaptive threshold. Post speech start/end events alongside PCM data.

**Implementation sketch:**
```typescript
// Inside CaptureProcessor.process()
const rms = computeRMS(samples); // sqrt(sum(x²)/N)
const isSpeech = rms > this.threshold;

if (isSpeech && !this.speaking) {
  this.speechFrameCount++;
  if (this.speechFrameCount >= ONSET_FRAMES) { // e.g., 3 frames = 31.8ms
    this.speaking = true;
    this.port.postMessage({ type: "speech_start" });
  }
} else if (!isSpeech && this.speaking) {
  this.silenceFrameCount++;
  if (this.silenceFrameCount >= OFFSET_FRAMES) { // e.g., 50 frames = 531ms
    this.speaking = false;
    this.port.postMessage({ type: "speech_end" });
  }
} else {
  // Reset counter for the non-active condition
  if (isSpeech) this.silenceFrameCount = 0;
  else this.speechFrameCount = 0;
}
```

**Pros:**
- Zero dependencies, zero bundle cost
- Runs in worklet thread — real-time safe, doesn't block main thread
- <0.1ms per 512-sample batch — negligible CPU
- Trivial to implement — ~30 lines of code in existing worklet
- Works everywhere AudioWorklet works (all modern browsers)

**Cons:**
- Cannot distinguish speech from non-speech noise (cough, door slam, TV, typing)
- Threshold is environment-dependent — quiet room vs noisy kitchen
- Gain boost (2.5x) inflates all energy equally, including noise floor
- Adaptive threshold is hard: needs ambient noise estimation during non-speech
- No frequency discrimination — bass hum registers same as voice

**Improvement: Spectral-gated RMS:**
- Add BiquadFilterNode bandpass 300-3400 Hz before worklet (voice band)
- RMS computed on filtered signal discriminates voice from low-frequency rumble, fan noise, etc.
- Still fails on broadband noise (TV, music with vocals)
- Zero additional dependencies — BiquadFilterNode is WebAudio native

**Assessment:** Good enough for quiet environments. Inadequate for the target use case (family home with kids, TV, pets). Viable as a *fast gate* in hybrid approach.

## Approach B: ML VAD (@ricky0123/vad-web / Silero ONNX)

**Concept:** Run Silero VAD v5 ONNX model client-side via onnxruntime-web. Processes 30ms audio frames, outputs speech probability 0.0-1.0.

**@ricky0123/vad-web specifics:**
- Wraps Silero v5 ONNX model with Web Audio integration
- `MicVAD` API: `onSpeechStart(audio)`, `onSpeechEnd(audio)`, `onFrameProcessed(probs)`
- Processes 512 samples @ 16kHz (32ms) — needs downsampling from 48kHz capture
- Model size: ~2MB ONNX file loaded via onnxruntime-web WASM backend
- WASM runtime: ~4MB additional (onnxruntime-web)
- **Requires `SharedArrayBuffer`** — needs COOP/COEP headers (`Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`)
- Total bundle impact: ~6MB (model + WASM runtime)
- Processing time: ~3-5ms per 32ms frame on modern desktop, ~10-15ms on RPi5 browser

**Accuracy:** >95% speech vs non-speech on standard benchmarks. Handles:
- Coughs, sneezes — classified as non-speech
- Background music — mostly classified as non-speech (degrades with vocals)
- TV/radio — mixed results (speech content detected as speech)
- Typing, keyboard — classified as non-speech

**Integration architecture:**
```
getUserMedia → GainNode → CaptureProcessor (48kHz Int16 PCM)
                 ↓ (tee)
            Downsampler → VAD Worker (16kHz Float32 → Silero ONNX)
                              ↓
                         speech_start / speech_end events
                              ↓
                         Main thread: control audio.start/audio.end protocol
```

Two options for where VAD runs:
1. **Main thread via @ricky0123/vad-web** — simplest integration, but 3-5ms WASM execution blocks rendering briefly
2. **Dedicated Web Worker** — offloads ONNX inference, communicates via postMessage. More complex but zero main thread impact.

**Option 2 is better for SDK quality** — SDK should never block host app's rendering.

**Cons:**
- 6MB bundle increase (significant for PWA/mobile web)
- COOP/COEP headers required — may conflict with third-party embeds, iframes, CDN serving
- WASM initialization: 500ms-2s cold start for onnxruntime
- Downsampling needed: 48kHz→16kHz (Silero expects 16kHz)
- RPi5 browser performance: 10-15ms per 32ms frame = ~30-45% of real-time budget
- Library maintenance: @ricky0123/vad-web is a single-maintainer project

**Assessment:** Best accuracy, but heavyweight for an SDK. The COOP/COEP requirement is a significant integration friction point. Good for applications that control their own deployment, but SDK consumers may not be able to add those headers.

## Approach C: Hybrid — Energy Gate + ML Confirmation

**Concept:** Two-tier detection. Fast energy gate in AudioWorklet (~0ms) filters obvious silence. Only when energy exceeds threshold, forward frames to Silero VAD for confirmation (~5ms).

**Pipeline:**
```
CaptureProcessor (10.6ms batches)
  → RMS energy check (in worklet, <0.1ms)
    → Below threshold: silence, skip VAD
    → Above threshold: forward to VAD Worker
      → Silero inference (3-5ms on desktop, 10-15ms on RPi5)
        → speech_start / speech_end with ML confidence
```

**Benefits over pure ML:**
- Silero invocations reduced 60-80% (most silence skipped by energy gate)
- Battery/CPU savings proportional to silence ratio
- Energy gate provides instant feedback (<1ms); ML provides accurate confirmation

**Complexity cost:**
- Two detection systems to tune and maintain
- Energy threshold and ML threshold must be coordinated
- Edge case: energy barely above threshold but ML says non-speech (cough)
- Edge case: very quiet speech below energy threshold but ML would detect it

**Assessment:** Optimal for power-constrained environments (mobile, RPi5). Over-engineered if CPU budget isn't a concern. The coordination complexity is real — two systems means two sets of thresholds, two timing parameters, and interactions between them.

## Approach D: SDK-Abstracted VAD with Pluggable Detector

**Concept:** The SDK defines a `VoiceActivityDetector` interface. Ship with a simple energy-based default. Allow consumers to plug in Silero or any other detector. The SDK handles state machine transitions regardless of detector choice.

```typescript
interface VoiceActivityDetector {
  /** Start processing audio from the given source */
  start(source: AudioNode, context: AudioContext): void;
  /** Stop processing and release resources */
  stop(): void;
  /** Event callbacks */
  onSpeechStart: () => void;
  onSpeechEnd: () => void;
}

interface VoiceClientConfig {
  /** Detection mode: 'vad' | 'push-to-talk' | 'always-on' */
  mode: 'vad' | 'ptt' | 'continuous';
  /** Custom VAD detector (default: EnergyVAD) */
  vadDetector?: VoiceActivityDetector;
  /** VAD config */
  vad?: {
    /** Silence duration before speech_end (ms). Default: 700 */
    silenceTimeout: number;
    /** Minimum speech duration to trigger (ms). Default: 100 */
    minSpeechDuration: number;
    /** Energy threshold (0-1) for built-in detector. Default: 0.01 */
    energyThreshold: number;
  };
}
```

**Default implementation: EnergyVAD**
- Spectral-gated RMS (bandpass 300-3400Hz + RMS)
- Onset: 3 consecutive frames above threshold (~32ms)
- Offset: configurable silence timeout (default 700ms)
- Zero dependencies, ~50 lines

**Optional upgrade: SileroVAD**
```typescript
import { createSileroVAD } from '@sentient/vad-silero';
const client = new VoiceClient({
  mode: 'vad',
  vadDetector: createSileroVAD({ threshold: 0.5 }),
});
```

**This approach aligns with the SDK design principles:**
- SDK = magic black box with sensible defaults
- Developer can upgrade VAD without touching any other code
- Mode switching (VAD ↔ PTT) is a config change, not a code change
- Same downstream protocol regardless of detection method

**Assessment:** Best architecture for SDK distribution. Decouples VAD accuracy from SDK core. Lets the SDK ship lean (energy-based default) while supporting high-accuracy detection as an opt-in.

## Edge Cases — Deep Analysis

### 1. Cough/Sneeze During Silence
- **Energy VAD:** Triggers false speech_start (energy spike). Mitigated by onset debounce (require 3+ consecutive high-energy frames — coughs are 1-2 frames).
- **Silero VAD:** Correctly classifies as non-speech in >90% cases.
- **Impact:** False start → gateway receives short audio burst → Deepgram returns empty transcript → wasted round trip but no user-visible error.

### 2. Background TV/Music
- **Energy VAD:** Continuous false triggering. Essentially becomes always-on.
- **Silero VAD:** Detects speech content in TV audio as speech. Can't distinguish user from TV.
- **Neither approach solves this.** Mitigation: (a) echo cancellation from `getUserMedia` helps if assistant audio is playing, (b) directional mic/beamforming on hardware level, (c) user switches to PTT mode.
- **SDK response:** Expose mode switching. If VAD false-trigger rate exceeds threshold, suggest PTT mode.

### 3. Brief Pause Mid-Sentence
- "I want to... [500ms pause] ...go to the store"
- **Client VAD silence timeout must be longer than natural pause.**
- Typical intra-sentence pause: 200-500ms. Inter-sentence pause: 700-1500ms.
- Setting `silenceTimeout = 700ms` catches most mid-sentence pauses.
- But: gateway-side Deepgram endpointing (`endpointing=300`) is *independent* and may fire.
- **Resolution:** Client VAD controls audio flow start/stop. Gateway endpointing controls utterance boundary. These are different concerns. Client keeps sending audio through brief pauses; gateway decides when the *utterance* is complete.

### 4. Double Utterance (User speaks, pauses, speaks again before response)
- User: "What time is it?" [1s pause] "And what's the weather?"
- Client VAD: speech_start → speech_end (after 700ms silence) → speech_start → speech_end
- Client sends: `audio.start` → audio → `audio.end` → `audio.start` → audio → `audio.end`
- Gateway receives two separate utterances. First triggers LLM. Second queued or triggers barge-in.
- **Design decision:** Should client debounce and merge into single utterance, or let gateway handle?
- **Recommendation:** Let gateway handle. Client's job is accurate speech boundary detection. Gateway's job is utterance semantics. Over-merging on client side would delay response to first utterance.

### 5. Echo from Assistant Speaking
- Assistant speaks through speakers → mic picks up assistant audio → VAD triggers
- Browser `echoCancellation: true` handles most of this, but quality varies by device.
- **Additional mitigation:** When state machine is in `assistant-speaking` state, VAD speech_start triggers barge-in rather than new utterance. This is correct behavior — if user speaks over assistant, it *should* interrupt.
- **Risk:** Bad echo cancellation causes VAD to trigger on assistant's own audio = infinite barge-in loop.
- **Mitigation:** After barge-in, require minimum 300ms of confirmed speech before another barge-in. State machine guard.

### 6. Very Quiet Speech
- User whispers or speaks softly. Post-gain energy may still be below energy VAD threshold.
- Silero VAD handles this better (trained on varied volume levels).
- **Mitigation for energy VAD:** Adaptive threshold based on ambient noise floor. Floor = running minimum of 95th-percentile energy over last 5s. Threshold = floor × multiplier.

## Performance Budget (RPi5 Chromium)

| Component | Per-frame cost | Budget (10.6ms frame) | Viable? |
|-----------|---------------|----------------------|---------|
| Energy RMS | <0.01ms | <0.1% | Yes |
| Spectral RMS (bandpass) | ~0.05ms | ~0.5% | Yes |
| Silero ONNX (WASM) | 10-15ms | 94-141% | NO — exceeds budget |
| Silero ONNX (32ms frame, not per capture frame) | 10-15ms per 32ms | OK if amortized | Marginal |

**Silero on RPi5 browser is at the edge of viability.** 10-15ms processing per 32ms of audio = 31-47% utilization. This works for a single session but leaves little headroom. On desktop browsers it's comfortable (3-5ms per 32ms = 9-15%).

This reinforces **Approach D** — ship energy-based default, offer Silero as opt-in for environments where CPU budget allows.

## Interaction with State Machine

The VAD module feeds events into the SDK state machine (explored separately in `sdk-state-machine`):

```
VAD.speech_start → StateMachine.event("SPEECH_DETECTED")
  → if state == "listening": transition to "user-speaking", send audio.start
  → if state == "assistant-speaking": transition to "interrupting" (barge-in)
  → if state == "processing": queue or ignore (response already in flight)

VAD.speech_end → StateMachine.event("SPEECH_ENDED")
  → if state == "user-speaking": transition to "processing", send audio.end
  → if state == "interrupting": transition to "processing", send audio.end
```

**The VAD never directly sends protocol messages.** It feeds the state machine, which decides what to send. This keeps VAD purely responsible for detection, state machine for protocol semantics.

## Interaction with Codec Negotiation

VAD processes audio *before* encoding. If codec negotiation results in Opus encoding, VAD still operates on raw PCM from the AudioWorklet. The encoding step happens downstream:

```
Mic → Worklet (PCM) → VAD (on PCM) → Encoder (PCM→Opus) → WebSocket
```

No interaction with codec choice. VAD is always pre-encoding.

## Interaction with Gateway Pipeline

Client-side VAD is *complementary* to gateway-side endpointing:
- **Client VAD** → controls `audio.start`/`audio.end` (when audio flows)
- **Gateway Deepgram endpointing** → controls utterance flush (when transcript goes to LLM)
- **Gateway Silero VAD (Phase 2)** → augments Deepgram endpointing (double-endpointing)

These are independent systems solving different problems. Client VAD reduces bandwidth and provides UX feedback. Gateway endpointing determines semantic utterance boundaries.

## Recommendations

1. **Architecture: Approach D (pluggable detector interface).** Ship energy-based default, Silero as optional package. Mode switching (VAD/PTT/continuous) via config.

2. **Default detector: Spectral-gated RMS.** Bandpass 300-3400Hz via BiquadFilterNode, then RMS in AudioWorklet. Zero dependencies. Good enough for quiet environments.

3. **Silence timeout: 700ms default, configurable.** Longer than typical intra-sentence pause (500ms), shorter than Deepgram's `utteranceEndMs` (1000ms). Client VAD doesn't need to be the utterance boundary authority — that's the gateway's job.

4. **Mode coexistence:** VAD mode and PTT mode share identical downstream protocol. User can switch at runtime. SDK handles the mapping transparently.

5. **Barge-in integration:** VAD speech_start during assistant-speaking triggers barge-in path. Add debounce guard (300ms minimum speech) to prevent echo-triggered barge-in loops.

6. **PoC scope:** Build standalone project demonstrating:
   - EnergyVAD in AudioWorklet with spectral gating
   - Pluggable detector interface with mock SileroVAD
   - State transitions: silence → speech_start → speaking → speech_end → silence
   - Mode switching: VAD ↔ PTT ↔ continuous
   - Edge case: onset debounce, silence timeout, barge-in guard

## Open Questions

- What `silenceTimeout` value feels natural in user testing? 700ms is a guess from speech research. May need tuning per user preference.
- Should the SDK expose VAD confidence/energy levels to the host app for visualization (e.g., audio level meter)? This is useful for debugging and UX but increases API surface.
- Can we detect "bad echo cancellation" and auto-suggest PTT mode? Possible via comparing VAD triggers during assistant-speaking vs silence, but adds complexity.
- Should continuous mode (always sending audio, no VAD gating) be offered? Useful for development/testing. Bandwidth cost is ~96KB/s at 48kHz 16-bit mono — manageable on LAN, expensive on cellular.
