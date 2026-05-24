# Codec Negotiation — Boundary Leak Investigation

## Summary

The codebase has **pervasive codec/format knowledge leakage** across all component boundaries. Every layer — client, gateway, protocol, providers — hardcodes audio format assumptions that should be encapsulated. This investigation catalogs every leak, classifies its severity, and proposes containment boundaries.

## Leak Taxonomy

### Category 1: Client Knows Provider Formats (CRITICAL)

These are the most damaging leaks — the web client directly encodes/decodes in provider-specific formats.

| File | Line(s) | Leak | Severity |
|------|---------|------|----------|
| `web/src/constants.ts` | 7, 13 | Hardcoded `CAPTURE_SAMPLE_RATE = 48_000` and `AUDIO_SAMPLE_RATE = 44_100` — client must match STT/TTS provider expectations | CRITICAL |
| `web/src/audio/capture-worklet.ts` | 14-48 | Float32→Int16 PCM16 encoding with `INT16_MAX = 0x7fff` — client implements wire codec | CRITICAL |
| `web/src/audio/pcm-decoder.ts` | 8-15 | `pcm16BufferToFloat32()` — client assumes gateway always sends PCM16 | CRITICAL |
| `web/src/app.tsx` | 4, 48 | `import { pcm16BufferToFloat32 }` and direct call — app-level code knows wire encoding | HIGH |
| `web/src/hooks/use-audio-capture.ts` | 60, 65 | `sampleRate: CAPTURE_SAMPLE_RATE` in getUserMedia and AudioContext — locked to 48kHz | MEDIUM |
| `web/src/hooks/use-audio-playback.ts` | 25 | `new AudioContext({ sampleRate: AUDIO_SAMPLE_RATE })` — locked to 44.1kHz | MEDIUM |

**Impact**: Changing STT provider (e.g., Deepgram→Whisper at 16kHz) requires changes in 6+ client files. Client should only know "I capture audio and receive audio" — never the wire format.

### Category 2: Gateway Hardcodes Provider Config (HIGH)

| File | Line(s) | Leak | Severity |
|------|---------|------|----------|
| `gateway/src/index.ts` | 51 | `sampleRate: 48000` hardcoded for STT config | HIGH |
| `gateway/src/index.ts` | 62-63 | `format: "pcm"`, `sampleRate: 44100` hardcoded for TTS config | HIGH |
| `gateway/src/providers/stt/stt-types.ts` | 17-19 | `STT_DEFAULTS` with `sampleRate: 16000`, `encoding: "linear16"` — defaults don't match what gateway sends | HIGH |
| `gateway/src/providers/tts/tts-types.ts` | 13-17 | `TTS_DEFAULTS` with `format: "opus"`, `sampleRate: 48000` — default doesn't match what client expects | HIGH |

**Impact**: These mismatches create Bug 1 (STT rate mismatch) and Bug 2 (TTS encoding mismatch) documented in the exploration. The gateway should configure providers dynamically based on negotiated session format.

### Category 3: Pipeline Knows Provider Encodings (MEDIUM)

| File | Line(s) | Leak | Severity |
|------|---------|------|----------|
| `gateway/src/pipeline/processors/tts-processor.ts` | 8-14 | `mapEncoding()` maps `"pcm"→"pcm16"`, `"opus"→"opus"` — pipeline layer knows Fish Audio's format names | MEDIUM |
| `gateway/src/pipeline/processors/tts-processor.ts` | 22-23 | Propagates `chunk.encoding` and `chunk.sampleRate` from provider to AudioFrame | MEDIUM |

**Impact**: Adding a new TTS provider that uses different encoding names (e.g., `"raw"` instead of `"pcm"`) requires modifying `mapEncoding()` in the pipeline layer.

### Category 4: Protocol Exposes Format Unions (LOW-MEDIUM)

| File | Line(s) | Leak | Severity |
|------|---------|------|----------|
| `shared/protocol/src/frames.ts` | 25-26 | `AudioFrame.encoding: "opus" \| "pcm16"` — frame type hardcodes supported codecs | LOW |
| `shared/protocol/src/messages.ts` | 13 | `session.start.encoding: "opus" \| "pcm16"` — protocol limits codec set at schema level | LOW |

**Impact**: Adding a new codec (e.g., AAC for iOS) requires modifying shared protocol schemas, triggering rebuilds across all packages.

### Category 5: Server Entry Point as Config Source (MEDIUM)

| File | Line(s) | Leak | Severity |
|------|---------|------|----------|
| `gateway/src/server/ws-server.ts` | 160 | Comment: "Binary frames are raw PCM16 audio chunks from the web client's AudioWorklet" — assumption baked into routing logic | MEDIUM |
| `gateway/src/server/ws-server.ts` | 160-165 | `ws.data.voiceSession.sendAudio(new Uint8Array(message))` — forwards binary as-is with no format awareness | MEDIUM |

**Impact**: If client switches to Opus encoding, `ws-server.ts` binary handler continues forwarding raw bytes to STT which expects linear16 — silent corruption.

### Category 6: Test Code Hardcodes Formats (LOW)

| File | Line(s) | Leak | Severity |
|------|---------|------|----------|
| `gateway/src/server/ws-server-voice.test.ts` | 55-56 | Hardcoded `encoding: "pcm16"`, `sampleRate: 48000` | LOW |
| `gateway/src/server/ws-server-voice.test.ts` | 66-67 | Hardcoded `encoding: "linear16"`, `sampleRate: 16000` | LOW |
| `gateway/scripts/try-voice.ts` | 30-33 | `STT_SAMPLE_RATE = 16_000`, `TTS_SAMPLE_RATE = 24_000`, `BYTES_PER_SAMPLE = 2` | LOW |

**Impact**: Tests break when defaults change. Script assumptions diverge from production config.

## Cross-Boundary Dependency Map

```
capture-worklet.ts ──PCM16@48kHz──→ ws-server.ts ──raw bytes──→ voice-session.ts ──→ deepgram (expects linear16@16kHz)
       ↑                                                                                  ↑
  constants.ts:7                                                                   stt-types.ts:17-18
  (CAPTURE_SAMPLE_RATE)                                                            (STT_DEFAULTS)
       ↑                                                                                  ↑
  ┌────┴─── MISMATCH: 48kHz sent, 16kHz declared ──────────────────────────────────────────┘

fish-audio ──opus/pcm@48kHz──→ tts-processor.ts ──mapEncoding──→ ws-server.ts ──raw binary──→ pcm-decoder.ts
       ↑                             ↑                                                            ↑
  tts-types.ts:15                  knows "pcm"                                              assumes PCM16
  (default: "opus")                vs "pcm16"                                              (pcm16BufferToFloat32)
       ↑                                                                                          ↑
  ┌────┴─── MISMATCH: default is opus, client decodes as PCM16 ───────────────────────────────────┘
```

## Containment Boundaries (Proposed)

### Boundary 1: SDK Audio Abstraction
**Rule**: Client code never references PCM16, Int16, sample rates, or encoding names.
- `capture-worklet.ts` becomes a platform adapter behind `AudioCapture` interface
- `pcm-decoder.ts` becomes a platform adapter behind `AudioPlayback` interface
- `constants.ts` audio constants move into SDK config, derived from negotiation

### Boundary 2: Gateway Audio Middleware
**Rule**: Pipeline stages never see raw provider formats. Audio enters/exits pipeline as `AudioFrame` with canonical format.
- Inbound: `ws-server.ts` → `AudioMiddleware.decode(binary, sessionFormat)` → `AudioFrame` → STT
- Outbound: TTS → `AudioFrame` → `AudioMiddleware.encode(frame, sessionFormat)` → binary → client
- `mapEncoding()` moves into the Fish Audio provider adapter, not the pipeline

### Boundary 3: Provider Format Isolation
**Rule**: Provider-specific format names (`"linear16"`, Fish Audio's `"pcm"`) never appear outside provider adapter files.
- Each provider adapter converts between canonical `AudioFrame` format and provider-specific format
- `stt-types.ts` and `tts-types.ts` encoding unions are provider-internal, not shared

### Boundary 4: Negotiation as Single Source of Truth
**Rule**: All format decisions flow from the `session.start`/`session.ready` handshake.
- No hardcoded sample rates anywhere — derived from negotiated session config
- Gateway stores `NegotiatedFormat` on `ClientData`, passes to middleware and providers

## Leak Count Summary

| Category | Count | Severity |
|----------|-------|----------|
| Client knows provider formats | 6 locations | CRITICAL |
| Gateway hardcodes provider config | 4 locations | HIGH |
| Pipeline knows provider encodings | 2 locations | MEDIUM |
| Protocol exposes format unions | 2 locations | LOW-MEDIUM |
| Server assumes wire format | 2 locations | MEDIUM |
| Test hardcodes | 3 locations | LOW |
| **Total** | **19 locations** | — |

## Key Insight

The root cause is **no audio middleware layer**. Audio bytes flow from client→gateway→provider and back without any transformation or format awareness at the gateway level. The gateway is a transparent proxy for audio bytes, which means:

1. Client must encode in exactly the format STT expects
2. Client must decode in exactly the format TTS outputs
3. Changing any provider's format requirements cascades across the entire stack

The fix is a single insertion point: an `AudioMiddleware` at the gateway boundary that normalizes inbound audio to a canonical format (e.g., Float32 @ provider's expected rate) and encodes outbound audio to the client's negotiated format. This middleware is the only component that needs to know about both client and provider formats.
