# Audio Codec Negotiation — Deep Exploration

## Current State Analysis

### The Full Audio Path (with exact file locations)

```
[Web Client]                    [Gateway]                      [Providers]
capture-worklet.ts              ws-server.ts:159-168           deepgram-provider.ts
  Float32 → Int16 PCM            Binary → voiceSession            expects linear16@16kHz
  @ 48kHz (constants.ts:7)        .sendAudio(Uint8Array)           (stt-types.ts:17-18)
  ↓                               ↓                               ↓
  raw binary WS frame    →    forwarded as-is (NO resample)  →  Deepgram gets 48kHz data
                                                                  told it's 16kHz → MISMATCH

[Providers]                     [Gateway]                      [Web Client]
fish-audio-provider.ts          voice-handlers.ts:75-77        pcm-decoder.ts
  outputs opus@48kHz              ws.send(event.payload)          Int16 → Float32
  (tts-types.ts:13-16)           raw binary, no header           @ 44.1kHz AudioContext
  ↓                               ↓                               ↓
  opus chunks             →    forwarded as-is              →  client decodes as PCM16 → MISMATCH
```

### Critical Bugs in Current Pipeline

**Bug 1: STT sample rate mismatch**
- Client sends PCM16 @ 48kHz (`CAPTURE_SAMPLE_RATE = 48_000`, `constants.ts:7`)
- Gateway tells Deepgram it's `linear16` @ `16000` (`STT_DEFAULTS`, `stt-types.ts:17`)
- Deepgram receives 48kHz audio but interprets as 16kHz → audio plays at 3x speed internally
- **Why it works anyway**: Deepgram Nova-3 likely auto-detects actual sample rate despite config. But this is undocumented behavior — fragile.

**Bug 2: TTS encoding mismatch**
- TTS defaults to `format: "opus"` (`TTS_DEFAULTS`, `tts-types.ts:15`)
- Client assumes all binary frames are PCM16, decodes via `pcm16BufferToFloat32()` (`app.tsx:48`)
- Opus bytes interpreted as PCM16 → noise/garbage audio
- **Why it might work anyway**: The test file uses `format: "pcm"` (`ws-server-voice.test.ts:52`), suggesting production config overrides the default to "pcm". But the default is wrong.

**Bug 3: Playback rate assumption**
- TTS outputs @ 48kHz (`TTS_DEFAULTS.sampleRate = 48000`)
- Client plays through AudioContext @ 44.1kHz (`AUDIO_SAMPLE_RATE = 44_100`, `constants.ts:13`)
- 48kHz PCM played at 44.1kHz = ~8.4% slower, lower pitched
- **Why it's subtle**: 8% pitch shift is noticeable but not obviously broken for speech.

### Dead Code: `session.start`

The `sessionStartSchema` is defined in `messages.ts:11-15` with `encoding` and `pretriggerMs` fields. It's part of the `clientMessageSchema` discriminated union (line 53). But in `ws-server.ts:159-234`, there is **no handler for `session.start`**. The message type falls through to line 234: `sendError(ws, "protocol_error", "Unsupported message type: session.start")`.

The `AudioFrame` type in `frames.ts:21-27` carries `encoding` and `sampleRate` metadata, but `voice-handlers.ts:75-77` strips it, sending only `event.payload` (raw `Uint8Array`).

## Design Space

### Approach A: Minimal — Fix the Mismatches, Add Negotiation

**What**: Fix the three bugs, implement session.start handler, add session.ready response.

1. **session.start handler**: Gateway reads `encoding` field, stores on `ClientData`
2. **session.ready message**: New gateway→client message confirming negotiated format
3. **Gateway-side resampling**: Resample 48kHz→16kHz before STT, resample TTS output→client's playback rate
4. **TTS format selection**: Use client's encoding preference to configure TTS format (pcm vs opus)

```typescript
// Extended session.start schema
export const sessionStartSchema = z.object({
  type: z.literal("session.start"),
  supportedEncodings: z.array(z.enum(["opus", "pcm16"])).min(1).default(["pcm16"]),
  preferredEncoding: z.enum(["opus", "pcm16"]).default("pcm16"),
  captureSampleRate: z.number().int().min(8000).max(96000).default(48000),
  playbackSampleRate: z.number().int().min(8000).max(96000).default(44100),
});

// New session.ready message
export const sessionReadySchema = z.object({
  type: z.literal("session.ready"),
  encoding: z.enum(["opus", "pcm16"]),
  captureSampleRate: z.number(),
  playbackSampleRate: z.number(),
});
```

**Gateway negotiation logic:**
```typescript
function negotiateCodec(clientPrefs: SessionStart): SessionReady {
  // Gateway supports pcm16 always, opus if client supports it
  const encoding = clientPrefs.supportedEncodings.includes(clientPrefs.preferredEncoding)
    ? clientPrefs.preferredEncoding
    : "pcm16"; // fallback

  return {
    type: "session.ready",
    encoding,
    captureSampleRate: clientPrefs.captureSampleRate,   // accept whatever client sends
    playbackSampleRate: clientPrefs.playbackSampleRate,  // gateway will resample
  };
}
```

**Pros**: Minimal change, fixes real bugs, backward compatible (defaults match current behavior)
**Cons**: Resampling is CPU work on RPi5, no Opus encoder/decoder on client yet

### Approach B: AudioCodec Module — Pure Function Layer

**What**: Build a standalone `AudioCodec` module with encode/decode/resample as pure functions. SDK uses it; gateway uses it.

```typescript
// shared/audio/src/codec.ts
interface AudioFormat {
  encoding: "pcm16" | "opus";
  sampleRate: number;
  channels: 1;  // mono only for voice
}

interface AudioCodec {
  encode(samples: Float32Array, format: AudioFormat): Uint8Array;
  decode(data: Uint8Array, format: AudioFormat): Float32Array;
}

// shared/audio/src/resample.ts
function resampleLinear(samples: Float32Array, fromRate: number, toRate: number): Float32Array;
function resamplePolyphase(samples: Float32Array, fromRate: number, toRate: number): Float32Array;
```

**PCM16 codec** is trivial (existing `pcm-decoder.ts` + capture-worklet encode logic).

**Opus codec** has two paths:
1. **WebCodecs API** (`AudioEncoder`/`AudioDecoder`) — Chrome 94+, Safari 16.4+, zero bundle cost. But: async, frame-based API doesn't map cleanly to streaming.
2. **WASM libopus** (e.g., `libopusjs`, `opus-stream-decoder`) — ~200-400KB WASM, works everywhere, sync API.

**Resampling** approaches:
1. **Linear interpolation** — Simple, fast, OK for 48→16kHz (downsampling). Bad for upsampling (aliasing).
2. **Polyphase filter** — Higher quality, more CPU. Libraries: none lightweight for Bun; must hand-roll or port.
3. **Gateway only**: Since STT needs 16kHz and TTS outputs 48kHz, gateway does all resampling. Client sends/receives at its native rates. This is the cleanest: client never needs to resample.

**Key insight**: If gateway does all resampling, the AudioCodec module only needs encode/decode on the client, and encode/decode + resample on the gateway. The shared part is just the format types.

### Approach C: Frame Metadata Wire Format

**What**: Instead of bare binary frames, prefix each binary frame with a small header.

```
Binary frame = [1 byte encoding][4 bytes sampleRate][N bytes audio data]
```

Or use the existing JSON `AudioFrame` fields and send audio as JSON+base64 (like OpenAI). But this adds ~33% bandwidth overhead.

**Better**: Keep binary=audio, but send a `response.audio.start` message BEFORE audio frames with codec metadata:

```json
{"type": "response.audio.start", "encoding": "pcm16", "sampleRate": 44100}
// ... binary frames follow with that format until ...
{"type": "response.audio.done"}
```

This is already half-implemented: `responseAudioStartSchema` exists (line 95-97 of messages.ts) but carries no metadata. Just add fields.

**Pros**: No binary framing overhead, uses existing message types, client knows format before first audio byte
**Cons**: If messages arrive out of order (unlikely with WS), could misinterpret

## Recommended Design

**Combine A + B + C** in a layered approach:

### Layer 1: Negotiation Protocol (session lifecycle)
- Extend `session.start` with supported encodings + sample rates
- Add `session.ready` response with agreed format
- Gateway stores negotiated format per session on `ClientData`

### Layer 2: Gateway Audio Middleware
- **Inbound resampler**: Resample client audio (any rate) → STT expected rate (16kHz)
  - Linear interpolation is fine for downsampling speech
  - ~140 bytes of code: iterate output samples, lerp between input samples
- **Outbound resampler**: Resample TTS output → client's playback rate
- **Outbound encoder**: If client wants PCM16 but TTS outputs Opus (or vice versa), transcode
- This middleware sits between `ws-server.ts` audio forwarding and the provider

### Layer 3: Metadata on Audio Start
- Extend `response.audio.start` with `{ encoding, sampleRate }` so client knows format
- Client configures decoder before first audio byte arrives

### Layer 4: SDK AudioCodec (future)
- PCM16 encode/decode: move existing `pcm-decoder.ts` + capture-worklet logic into shared module
- Opus encode/decode: add when bandwidth becomes a constraint (mobile clients)
- Expose as `AudioCodec` interface in SDK

## Sample Rate Conversion — Implementation Sketch

For 48kHz → 16kHz (3:1 integer ratio), simplest approach: take every 3rd sample. For non-integer ratios, linear interpolation:

```typescript
function resampleLinear(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const outputLength = Math.ceil(input.length / ratio);
  const output = new Float32Array(outputLength);
  for (let i = 0; i < outputLength; i++) {
    const srcIndex = i * ratio;
    const srcFloor = Math.floor(srcIndex);
    const frac = srcIndex - srcFloor;
    const a = input[srcFloor] ?? 0;
    const b = input[Math.min(srcFloor + 1, input.length - 1)] ?? 0;
    output[i] = a + frac * (b - a);
  }
  return output;
}
```

For 48→16kHz, should apply low-pass filter before decimation to avoid aliasing. Simple single-pole IIR:
```typescript
function lowpassBeforeDecimation(input: Float32Array, cutoffRatio: number): Float32Array {
  const alpha = cutoffRatio; // e.g., 16000/48000 = 0.333
  const output = new Float32Array(input.length);
  output[0] = input[0] ?? 0;
  for (let i = 1; i < input.length; i++) {
    output[i] = output[i-1]! + alpha * ((input[i] ?? 0) - output[i-1]!);
  }
  return output;
}
```

## Opus Considerations

**When Opus matters**: Mobile clients on cellular networks. PCM16 @ 48kHz mono = 96 KB/s. Opus @ 24kbps = ~3 KB/s. 32x bandwidth reduction.

**When Opus doesn't matter**: RPi5 on local WiFi with web client. Bandwidth is abundant, latency is king.

**Decision**: Start with PCM16 only. Add Opus support as an optional enhancement when mobile clients arrive. The negotiation protocol supports it from day one — the gateway just needs to learn to transcode.

## Backward Compatibility

Current clients send no `session.start` message. The gateway should:
1. If no `session.start` received before `audio.start`, assume defaults: PCM16, 48kHz capture, 44.1kHz playback
2. This exactly matches current behavior — zero breaking changes
3. New clients can send `session.start` to negotiate better formats

## What Exists to Reuse

| Asset | Location | Status |
|-------|----------|--------|
| `sessionStartSchema` | `messages.ts:11-15` | Has `encoding` field, needs extension |
| `AudioFrame` type | `frames.ts:21-27` | Has `encoding` + `sampleRate`, underused |
| `pcm16BufferToFloat32` | `pcm-decoder.ts:8-15` | Working PCM16 decode |
| Float32→Int16 encode | `capture-worklet.ts:40-42` | Working PCM16 encode |
| `tts-processor.ts` | `tts-processor.ts:11-15` | `mapEncoding()` already handles opus↔pcm16 mapping |
| `responseAudioStartSchema` | `messages.ts:95-97` | Exists, needs encoding/sampleRate fields |
| `ClientData` type | `ws-server.ts:135-140` | Needs `negotiatedFormat` field |

## What to Build

1. **Negotiation handler** in `ws-server.ts` for `session.start` (~30 LOC)
2. **`session.ready`** message schema + emission (~10 LOC)
3. **Extend `response.audio.start`** with encoding/sampleRate (~5 LOC)
4. **Resampler utility** — `resampleLinear()` + optional low-pass (~40 LOC)
5. **Audio middleware** in gateway: resample inbound (client→STT), resample outbound (TTS→client) (~50 LOC)
6. **`AudioCodec` interface** in shared/audio as foundation for SDK (~30 LOC)
7. **Fix STT config**: Either pass client's actual sample rate to Deepgram, or resample before forwarding

## Cross-Topic Dependencies

- **sdk-gateway-contract**: `session.start`/`session.ready` handshake is part of the session lifecycle protocol
- **gateway-pipeline**: Audio middleware (resample) is a pipeline stage between WS and providers
- **testing-strategy**: Codec negotiation needs contract tests (client sends format X, gateway responds Y)
- **client-vad**: VAD operates on raw audio before encoding — codec choice doesn't affect VAD, but sample rate does (VAD needs consistent frame sizes)
- **error-ux**: Negotiation failure → friendly error ("audio format not supported, trying default...")

## Open Questions

1. **RPi5 CPU budget for resampling**: 48→16kHz resampling on every audio chunk. At 48kHz mono, ~4800 samples/100ms. Linear interpolation is ~O(n) with tiny constant. Should be negligible, but worth benchmarking.
2. **Deepgram auto-detection**: Does Deepgram actually handle mismatched sample rates gracefully? If yes, we could skip inbound resampling and just tell Deepgram the real rate. Need to test.
3. **WebCodecs availability**: If targeting Safari < 16.4 or Firefox (no WebCodecs AudioEncoder), Opus requires WASM fallback. Worth checking browser support matrix.
