# Explore: Codec Negotiation Presence Gaps

## Objective

Map the complete timeline from every user action to every system response involving codec negotiation, quantifying every silent gap. This extends the rethink analysis (`codec-negotiation-rethink-presence.md`) with precise code-level tracing through the actual codebase.

## Methodology

Traced every codec-related moment in the production code at `/workspace/codebase/sentient/`. Focused on the audio format boundary: where audio bytes are encoded, decoded, transmitted, or format-checked — and what the user sees at each point.

## Complete Timeline: Codec-Specific User Experience

### Segment A: Session Start — Format Lock-In

```
[User clicks "Start Voice"]
  │
  ├─ T0: useAudioCapture creates AudioContext (use-audio-capture.ts)
  │     → sampleRate locked to CAPTURE_SAMPLE_RATE = 48_000 (constants.ts:7)
  │     → capture-worklet.ts loaded into AudioWorklet
  │     → Client receives: getUserMedia permission prompt
  │     ⏱ 100-2000ms (permission + AudioContext + worklet compile)
  │
  ├─ T1: useAudioPlayback creates AudioContext (use-audio-playback.ts:25)
  │     → sampleRate locked to AUDIO_SAMPLE_RATE = 44_100 (constants.ts:13)
  │     → playback-worklet.ts loaded
  │     → Client receives: NOTHING
  │     ⏱ 50-200ms
  │
  ├─ T2: audio.start message sent (app.tsx:55 → onStarted callback)
  │     → NO session.start, NO format negotiation
  │     → Client has already locked its sample rates with NO gateway input
  │     → Client receives: NOTHING
  │     ⏱ ~0ms
  │
  └─ T3: Gateway receives audio.start → handleVoiceStart() (ws-server.ts:210-216)
       → STT provider connected with hardcoded config from index.ts:51
       → TTS provider connected with hardcoded config from index.ts:62-63
       → Client receives: NOTHING
       ⏱ 400-3000ms
```

**GAP A: Format lock-in without negotiation** — The entire connection phase proceeds with hardcoded sample rates on both sides, never exchanging format capabilities. Duration: entire session setup (500-5000ms).

**Key finding**: There is NO `session.start` handler in `ws-server.ts`. The `session.start` message type exists in the protocol schema (`messages.ts:11-15`) but falls through to `sendError(ws, "protocol_error", "Unsupported message type: session.start")` at line 234. The user never sees this error because no client sends `session.start`.

### Segment B: Audio Capture — Silent Encoding

```
[User speaks]
  │
  ├─ T4: capture-worklet.ts process() fires (every 128 samples @ 48kHz = ~2.67ms)
  │     → Float32 samples → Int16 PCM16 encoding (capture-worklet.ts:14-48)
  │     → Gain applied: CAPTURE_GAIN = 2.5 (constants.ts:9)
  │     → postMessage() sends buffer to main thread
  │     → Client receives: NOTHING (encoding is invisible)
  │
  ├─ T5: onAudioData callback fires → ws.sendBinary(data) (app.tsx:54)
  │     → Raw PCM16 bytes sent over WebSocket as binary frame
  │     → NO encoding metadata attached
  │     → NO format header
  │     → Client receives: NOTHING
  │
  ├─ T6: Gateway receives binary frame (ws-server.ts:163-165)
  │     → Comment says "raw PCM16 audio chunks" — HARDCODED ASSUMPTION
  │     → voiceSession.sendAudio(new Uint8Array(message))
  │     → Forwarded AS-IS to Deepgram — no format check, no resample
  │     → Client receives: NOTHING
  │
  └─ T7: Deepgram receives 48kHz audio, told it's 16kHz
       → STT_DEFAULTS says sampleRate: 16000 (stt-types.ts:17)
       → Gateway told Deepgram 16kHz at index.ts:51 but sends 48kHz
       → Deepgram auto-detects (undocumented) — fragile!
       → Client receives: NOTHING (no partials relayed)
```

**GAP B: Silent format mismatch** — 48kHz audio sent to a provider configured for 16kHz. No error, no warning, no detection. The mismatch is invisible because Deepgram silently compensates. Duration: entire speaking phase.

**Presence risk**: If Deepgram stops auto-detecting (API change, different model, rate limit), STT will silently produce garbage transcripts. User sees wrong text with no explanation — the worst kind of silent gap because it looks like the system is working.

### Segment C: Audio Playback — Silent Decoding Mismatch

```
[Gateway sends TTS audio]
  │
  ├─ T8: TTS provider outputs audio chunks
  │     → TTS_DEFAULTS: format "opus", sampleRate 48000 (tts-types.ts:13-17)
  │     → But production may override to "pcm" (ws-server-voice.test.ts:52)
  │     → Client receives: raw binary frames via WS
  │
  ├─ T9: app.tsx:48 handleBinaryMessage fires
  │     → pcm16BufferToFloat32(data) called UNCONDITIONALLY
  │     → If TTS actually sent Opus: decode produces NOISE
  │     → If TTS sent PCM @ 48kHz: played at 44.1kHz = 8.4% slow, lower pitch
  │     → Client receives: audio (possibly corrupted)
  │
  └─ T10: playback-worklet processes audio
       → Ring buffer at AUDIO_SAMPLE_RATE (44100) (constants.ts:13)
       → Playback rate mismatch creates subtle pitch shift
       → Client hears: slightly wrong audio — NOT silence, but wrong
```

**GAP C: Silent audio corruption** — Two sub-gaps:
1. **C1: Opus-as-PCM16** — If TTS default ("opus") is actually used, client hears noise/static. No error message. Duration: entire TTS playback.
2. **C2: Sample rate mismatch** — 48kHz audio played at 44.1kHz. 8.4% pitch shift. User hears "something off" but sees no indicator. Duration: entire TTS playback.

**Presence risk**: The user hears garbled or pitch-shifted audio but the UI shows "Speaking..." normally. There is zero codec error detection — `pcm16BufferToFloat32()` happily converts any bytes to Float32, even Opus packets. No validation, no range check, no error.

### Segment D: Mid-Session — No Renegotiation Path

```
[Network degrades / user switches audio device]
  │
  ├─ T11: User plugs in headset → browser may change AudioContext sampleRate
  │     → AudioContext is already created — sampleRate is IMMUTABLE after creation
  │     → New device may natively run at 44.1kHz but AudioContext resamples from 48kHz
  │     → Client receives: NOTHING — no device change detection
  │
  ├─ T12: Network bandwidth drops
  │     → PCM16 @ 48kHz = 96 KB/s upload, 96 KB/s download
  │     → No codec switching capability — cannot downgrade to Opus
  │     → Audio starts dropping WS frames
  │     → Client receives: NOTHING — choppy audio with no explanation
  │
  └─ T13: Provider changes format mid-stream (hypothetical)
       → No protocol for format change notification
       → No response.audio.start metadata (schema exists but empty)
       → Binary frames change format with no signal
       → Client receives: corrupted audio
```

**GAP D: No adaptation feedback** — When conditions change (device switch, bandwidth drop), there is no codec adaptation and no user feedback about audio quality degradation. Duration: indefinite.

**Presence risk**: On poor networks, audio becomes choppy. User sees "Speaking..." but hears gaps. No "poor connection" indicator exists. No bandwidth monitoring. No codec downgrade path.

### Segment E: Error Paths — Silent Codec Failures

```
[Codec-related error scenarios]
  │
  ├─ E1: Client sends non-PCM16 binary (e.g., browser extension injects data)
  │     → ws-server.ts:163 forwards blindly to STT
  │     → STT receives garbage → may error, may produce garbage transcript
  │     → Client receives: wrong transcript (silent corruption)
  │
  ├─ E2: TTS provider switches format mid-stream
  │     → Some TTS providers send a header frame before audio
  │     → pcm16BufferToFloat32 processes header as audio → click/pop
  │     → Client hears: artifact, then audio resumes
  │     → Client sees: NOTHING — no error indicator
  │
  ├─ E3: AudioContext creation fails (e.g., iOS auto-play policy)
  │     → useAudioPlayback:25 → new AudioContext() throws
  │     → guardStartTalk returns false (app.tsx:36-37)
  │     → handleError("Audio playback is not available")
  │     → Client sees: error message ✓ (this gap IS covered)
  │
  └─ E4: AudioWorklet fails to load
       → capture-worklet.ts compile error
       → useAudioCapture catches and calls onError
       → Client sees: error message ✓ (this gap IS covered)
```

**GAP E: Silent codec corruption** — Scenarios E1 and E2 produce corrupted audio with no user feedback. The system appears to work but output is wrong. Duration: until user manually retries or gives up.

## Gap Severity Matrix

| Gap | Segment | Duration | Frequency | User Impact | Detection | Mitigation Today |
|-----|---------|----------|-----------|-------------|-----------|-----------------|
| A: No negotiation | A | Session setup (500-5000ms) | Every session | Low (works by accident) | Not detectable — no protocol | None |
| B: STT rate mismatch | B | Entire speech | Every utterance | Low (Deepgram auto-detects) → Critical (if auto-detect fails) | Not detectable — no validation | None (fragile undocumented behavior) |
| C1: Opus-as-PCM16 | C | Entire playback | If TTS uses default format | Critical — noise/static | Detectable: amplitude analysis | None |
| C2: Playback pitch | C | Entire playback | Every utterance (if TTS≠44.1kHz) | Medium — 8% pitch shift | Not easily detectable | None |
| D: No adaptation | D | Indefinite | On device/network change | High — choppy/lost audio | Bandwidth monitoring possible | None |
| E1: Garbage input | E | Until retry | Rare | High — wrong transcript | STT error response possible | None |
| E2: Format switch | E | Brief (~100ms) | Rare | Low — brief artifact | Detectable: frame validation | None |

## Comparison with Gateway Pipeline Presence Gaps

The codec gaps differ fundamentally from gateway pipeline gaps:

| Dimension | Pipeline Gaps | Codec Gaps |
|-----------|--------------|------------|
| **Nature** | Silence (no output) | Corruption (wrong output) |
| **Detectability** | Easy — no message sent | Hard — bytes flow but are wrong |
| **User perception** | "Is it working?" | "Something sounds off..." |
| **Fix pattern** | Add status messages | Add validation + negotiation |
| **Duration** | Bounded (add timeouts) | Unbounded (persists entire session) |

**Key insight**: Codec presence gaps are qualitative, not temporal. The user doesn't experience silence — they experience wrongness. The pitch is off, the audio is garbled, or the transcript is inaccurate. These are harder to surface because the system appears functional.

## Worst-Case Codec Gap Chain

```
T0: User opens voice mode
    → AudioContext locked to 48kHz capture, 44.1kHz playback
    → No negotiation with gateway                              (Gap A)
    → User sees: "Connecting..." (covered by pipeline)

T3: User speaks
    → 48kHz PCM16 sent to Deepgram configured for 16kHz        (Gap B)
    → No format validation on gateway
    → User sees: NOTHING wrong — speech captured correctly (by luck)

T8: Gateway sends TTS audio
    → If Opus default used: NOISE plays                         (Gap C1)
    → If PCM16 at 48kHz: plays at 44.1kHz (8% slow/low)        (Gap C2)
    → User hears: garbled audio OR pitch-shifted voice
    → User sees: "Speaking..." (indicator lies about quality)

T12: User on spotty WiFi
    → 96 KB/s PCM16 can't sustain                               (Gap D)
    → Frames drop, audio chops
    → No codec downgrade, no quality indicator
    → User hears: stuttering audio
    → User sees: NOTHING about connection quality
```

**In the worst case, the user hears garbled TTS audio (Gap C1) with no error indicator, no way to fix it, and no understanding of what's wrong.** The UI says "Speaking..." while outputting noise.

## Proposed Presence Indicators for Codec Gaps

### 1. Negotiation Confirmation (fills Gap A)
```typescript
// After session.start/session.ready handshake:
{ type: "SHOW_INDICATOR", text: "Audio ready", style: "success", duration: 1500 }
// On negotiation failure:
{ type: "SHOW_INDICATOR", text: "Audio format issue — using default", style: "warning" }
```

### 2. Audio Quality Monitor (fills Gaps C1, C2, D)
```typescript
// SDK-side: analyze decoded audio for anomalies
interface AudioQualityCheck {
  // Detect Opus-as-PCM16: impossible amplitude values
  checkAmplitudeRange(samples: Float32Array): boolean;
  // Detect choppy audio: gap patterns in playback buffer
  checkContinuity(bufferLevel: number): "good" | "degraded" | "critical";
}

// When quality degrades:
{ type: "SHOW_INDICATOR", text: "Audio quality reduced", style: "warning" }
// When audio is garbage:
{ type: "SHOW_INDICATOR", text: "Audio issue — reconnecting...", style: "error" }
```

### 3. Format Validation at Boundaries (fills Gaps B, E1, E2)
```typescript
// Gateway inbound: validate audio before forwarding to STT
function validateAudioFrame(data: Uint8Array, expectedFormat: AudioFormat): ValidationResult {
  // PCM16: check for reasonable amplitude range
  // Check chunk size is even (PCM16 = 2 bytes per sample)
  // Check for all-zeros (silence) vs corrupt data
}

// On validation failure:
{ type: "SEND_ERROR", code: "audio_format_error", message: "Audio format mismatch" }
// Client shows: "I didn't catch that — try again"
```

### 4. Bandwidth/Connection Quality (fills Gap D)
```typescript
// Track WS frame delivery rate vs expected rate
// PCM16 @ 48kHz mono = ~93.75 KB/s expected
// If actual throughput < 75% expected for >2s:
{ type: "SHOW_INDICATOR", text: "Connection unstable", style: "warning" }
// If < 50% for >5s:
{ type: "SHOW_INDICATOR", text: "Poor connection — audio may be affected", style: "warning" }
```

## Gaps Covered vs Uncovered by Rethink

| Gap from Rethink | Covered Here | New Finding |
|-------------------|-------------|-------------|
| G1: WS connecting | Yes (reconfirmed) | — |
| G2: Negotiation in flight | Yes | session.start handler doesn't exist — this gap is currently impossible to even reach |
| G3: Codec init | Yes (negligible) | — |
| G4: getUserMedia | Yes | app.tsx actually handles this via guardStartTalk ✓ |
| G5: AudioContext | Yes | Immutable sampleRate means device change is unrecoverable |
| G6-G7: Timeout/error | Yes | — |
| G8-G9: Renegotiation | N/A | Renegotiation is impossible — no protocol for it |
| G10: Audio corruption | **Extended** | Root cause traced: pcm16BufferToFloat32 has zero validation |
| G11-G12: Error/disconnect | Yes | — |
| (new) STT rate mismatch | **New** | 48kHz→16kHz mismatch invisible, fragile auto-detect |
| (new) Playback pitch shift | **New** | 8.4% pitch error when TTS≠44.1kHz |
| (new) No bandwidth indicator | **New** | PCM16 requires 96KB/s, no degradation signal |

## Key Takeaways

1. **Codec gaps are corruption gaps, not silence gaps.** The system produces output, but it's wrong. This makes them harder to detect and surface to users than pipeline gaps (which are pure silence).

2. **The current system works by accident.** Deepgram's undocumented auto-detection masks the STT rate mismatch. Production config overrides mask the Opus default. A single provider API change could break audio quality with zero error messages.

3. **No validation exists at any audio boundary.** Binary frames flow through the entire pipeline with no format checking. The gateway comment "raw PCM16 audio chunks" at `ws-server.ts:160` is the only "validation" — a comment, not code.

4. **The rethink correctly identified the gaps but assumed negotiation exists.** The rethink file maps states like `negotiating` and `renegotiating`, but `session.start` is dead code — there is no negotiation handler. These states are aspirational, not actual.

5. **Audio quality monitoring is the key missing indicator.** Unlike pipeline gaps where adding `status.processing` messages fixes the problem, codec gaps need runtime audio analysis to detect corruption. This is a fundamentally different kind of presence.
