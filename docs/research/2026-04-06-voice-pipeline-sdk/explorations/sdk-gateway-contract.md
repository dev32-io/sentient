# SDK-to-Gateway Contract

## Current Protocol

### Client → Gateway (10 types, `messages.ts:53-64`)
| Type | Purpose | Payload |
|------|---------|---------|
| `auth` | Authenticate | `token: string` |
| `session.start` | Begin session | `encoding: "opus"|"pcm16"`, `pretriggerMs: number` |
| `audio.start` | Begin recording | (empty) |
| `audio.end` | End recording | (empty) |
| `text.input` | Text-only input | `text: string` |
| `barge_in` | Interrupt assistant | (empty) |
| `tool.confirm` | Confirm tool call | `toolCallId, approved` |
| `session.end` | End session | (empty) |
| `ping` | Keepalive | (empty) |
| `guest.auth` | Guest auth via PIN | `pin: string` |

### Gateway → Client (12 types, `messages.ts:130-143`)
| Type | Purpose | Payload |
|------|---------|---------|
| `auth.ok` | Auth success | `sessionId, role` |
| `transcript.partial` | Interim STT text | `text: string` — **defined but never sent** |
| `transcript.final` | Final STT text | `text: string` |
| `response.text.delta` | LLM token | `text: string` |
| `response.text.done` | LLM complete | (empty) |
| `response.audio.start` | TTS begin | (empty) |
| `response.audio.done` | TTS complete | (empty) |
| `barge_in.ack` | Barge-in confirmed | (empty) |
| `error` | Error | `code: ErrorType, message: string` |
| `pong` | Keepalive response | (empty) |
| `session.expired` | Session timeout | `reason: string` |
| `tool.confirm_request` | Tool confirmation | `toolCallId, toolName, args, description` |

### Binary Messages
- Client → Gateway: raw PCM16 audio chunks (no framing, no header)
- Gateway → Client: raw PCM16 audio chunks (no framing, no header)

### Unused / Dead Protocol Surface
| Message Type | Status | Notes |
|---|---|---|
| `session.start` | **DEFINED, UNUSED** | Client never sends; gateway ignores encoding field |
| `transcript.partial` | **DEFINED, UNUSED** | Gateway filters to `isFinal: true` only |
| `session.expired` | **DEFINED, UNUSED** | No session lifetime tracking implemented |
| `tool.confirm_request` / `tool.confirm` | **DEFINED, UNUSED** | No tool flow in LLM pipeline |
| `guest.auth` | **DEFINED, UNUSED** | 6-digit PIN auth not handled by gateway |

## Key Problems

1. **`transcript.partial` is defined but never sent.** `voice-session.ts:131-134` filters for `isFinal: true` only. Deepgram emits interim results (configured with `interim_results: "true"` in `deepgram-provider.ts:27`), but they're discarded by `readNextFinalTranscript()`.

2. **`session.start` encoding field is ignored.** Client sends `encoding: "pcm16"` but gateway hardcodes STT config from YAML (`stt-types.ts:19`: `encoding: "linear16"`). No negotiation happens.

3. **Binary audio has no framing.** Both directions send raw PCM with no metadata. Client assumes 48kHz capture, gateway assumes 16kHz for STT. Implicit conversion or STT handles rate mismatch.

4. **Error codes are inconsistent.** `errors.ts` defines `ERROR_TYPES` (auth_failed, session_limit, etc.) but `voice-handlers.ts:36` sends `"stt_error"` which is NOT in `ERROR_TYPES`. Error code field is `z.string()`, not validated against the enum.

5. **No message versioning.** No way to know if client speaks protocol v1 or v2.

6. **`audio.start`/`audio.end` are overloaded.** They serve as both "mic toggle" signals AND utterance boundary markers. In continuous mode, utterance boundaries should be explicit, independent of mic state.

7. **No processing state signals.** Client infers state from message types (transcript.final implies "thinking", response.text.delta implies "responding"). No explicit state indicators.

## Exact Message Sequence — Current System

### Normal Voice Turn
```
CLIENT                         SERVER                         PROVIDERS
───────────────────────────────────────────────────────────────────────

audio.start ─────────────────→ handleVoiceStart()
                               └→ sttProvider.connect()      → [Deepgram WS opens]

binary PCM frames ───────────→ sendAudio()                   → [Deepgram receives]
  (repeating ~20ms)

audio.end ───────────────────→ handleVoiceEnd()
                               └→ sttProvider.finalize()      → [Deepgram flushes]
                               └→ readNextFinalTranscript()   
                                  [WAIT 100–2000ms, NO TIMEOUT]
                                                              ← [STT final event]
                               
transcript.final ←─────────────── ws.send()
                               └→ history.push(user msg)

                               └→ runVoiceTurn()
                                  └→ llmProvider.stream()     → [OpenRouter starts]

response.text.delta ←──────────── ws.send() per token         ← [LLM tokens]
                                  overlap.process() feeds aggregator
                                  [WAIT for sentence boundary]
                                                              → [TTS synthesize]
                                  [WAIT 500–1500ms for first audio frame]

response.audio.start ←─────────── ws.send()
binary audio frames ←──────────── ws.sendBinary()             ← [TTS frames]
response.text.delta ←──────────── (more tokens interleaved)

response.text.done ←───────────── ws.send(fullText)
response.audio.done ←──────────── ws.send()
```

### Key Timing Gaps
1. **audio.end → transcript.final**: 100ms–2s, **unbounded** (no local timeout on STT read)
2. **transcript.final → first response.text.delta**: 50–500ms (LLM startup latency)
3. **first response.text.delta → response.audio.start**: 500–1500ms (sentence boundary + TTS startup)
4. **Text/audio interleaving**: text deltas and audio frames race — no guaranteed ordering within response

### Barge-In Sequence
```
CLIENT                         SERVER

[Response streaming in progress...]
response.text.delta ←────────── (tokens flowing)
response.audio.frame ←──────── (audio flowing)

barge_in ────────────────────→ session.bargeIn()
                               └→ activeTurnController.abort()
                               └→ [AbortSignal propagates to LLM + TTS]
barge_in.ack ←─────────────────── ws.send()
                               [No more text.delta, audio.frame, text.done, or audio.done sent]
                               [Response is silently truncated — no explicit terminator]

audio.start ─────────────────→ [New turn begins]
```

**Critical**: On barge-in, `response.text.done` and `response.audio.done` are **never sent**. Client receives partial message with no terminator. Must infer completion from `barge_in.ack`.

### Race Conditions
1. **audio.end before audio.start completes**: Bun processes WS messages concurrently. `handleVoiceEnd()` explicitly `await session.startRecording()` as guard.
2. **Text/audio ordering**: Text drain loop runs AFTER audio frame yield — text can lag behind audio for same sentence.
3. **STT stream death**: If Deepgram WS drops after `audio.end`, `readNextFinalTranscript()` hangs forever. Only `session.close()` AbortSignal can break it.

## Industry Protocol Patterns

### OpenAI Realtime API
- Pure JSON over WSS (audio base64-encoded — ~33% overhead)
- Session lifecycle: connect → server sends `session.created` → client sends `session.update` → server sends `session.updated`
- Audio buffer model: `input_audio_buffer.append` (base64) → `.commit` (when VAD off) → server VAD: `speech_started` / `speech_stopped`
- Response: `response.create` → `response.output_audio.delta` (base64) + `response.output_text.delta` → `response.done`
- Every event has `event_id`, response events carry `response_id` for correlation

### Deepgram Streaming
- Binary audio frames + JSON transcript responses (WS message type as mux)
- Config via query params on upgrade URL (encoding, sample_rate, etc.)
- Server events: `Results` (with `is_final`, `speech_final`), `SpeechStarted`, `UtteranceEnd`
- `UtteranceEnd` fires on silence gap ≥ `utterance_end_ms` — transcript-based, robust to noise

### LiveKit
- Protobuf binary protocol
- Separate signaling/media planes
- Declarative pipeline assembly with swappable plugins

### Common Patterns Across All
- **Binary/JSON mux via WS message type** (binary=audio, text=JSON) — zero overhead, no extra framing
- **Event IDs for correlation** — every request/response pair linked
- **Utterance lifecycle**: `speech_started → partial_transcript* → speech_ended → final_transcript`
- **Session lifecycle**: `connect → auth → session.created → session.configure → session.ready → stream`
- **Versioning**: URL path for major (`/v1/realtime`), subprotocol negotiation for minor

## Proposed Contract — Continuous Voice Mode

### Design Principles
1. **Binary/JSON mux via WS message type** — binary frames = audio, text frames = JSON. Zero overhead.
2. **Utterance lifecycle decoupled from mic state** — `utterance.start`/`.end` are speech boundaries, not button presses.
3. **Explicit state signals** — server tells client what phase it's in; client never infers.
4. **Event correlation** — `utteranceId` links utterance → transcript → response chain.
5. **Forward-compatible versioning** — subprotocol negotiation + additive-only message changes.

### Session Lifecycle
```
1. WS connect with auth token in header + subprotocol negotiation
   GET /v1/voice
   Authorization: Bearer <token>
   Sec-WebSocket-Protocol: sentient-voice-v1

2. Server confirms session
   → session.created { sessionId, role, protocol: "sentient-voice-v1" }

3. Client configures voice mode
   ← session.configure { 
       mode: "continuous" | "push-to-talk",
       encoding: "pcm16" | "opus",
       sampleRate: 48000,
       capabilities: ["vad", "barge-in"] 
     }

4. Server acknowledges or rejects
   → session.ready { encoding: "pcm16", sampleRate: 48000 }
   OR
   → error { code: "unsupported_config", message: "...", supported: {...} }

5. Voice streaming begins
   
6. Teardown
   ← session.end
   → session.ended { reason: "client_request" | "timeout" | "error" }
```

### Utterance Lifecycle (Client → Gateway)
```typescript
// Speech detected (VAD or button press)
utterance.start { utteranceId: string }

// Audio streams as binary frames (no JSON wrapper, no base64)
[binary: PCM16 audio chunks, ~20ms each]

// Speech ended (VAD silence threshold or button release)  
utterance.end { utteranceId: string }
```

**Key difference from current**: `utterance.start`/`.end` are speech boundary markers only. In continuous mode, mic stays open; multiple utterances can occur without mic toggle. In push-to-talk mode, each button press/release generates one utterance pair.

### Transcript Flow (Gateway → Client)
```typescript
// Partial transcripts stream during speech
transcript.partial { utteranceId: string, text: string }

// Final transcript after utterance.end + STT finalization
transcript.final { utteranceId: string, text: string }
```

**Implementation**: Remove the `isFinal: true` filter in `readNextFinalTranscript()`. Instead, relay all STT events:
- `isFinal: false` → send `transcript.partial`
- `isFinal: true` → send `transcript.final`

### Response Flow (Gateway → Client)
```typescript
// Processing started (fills the gap between transcript.final and first token)
response.start { utteranceId: string, responseId: string }

// LLM text tokens stream
response.text.delta { responseId: string, text: string }

// Full text finalized
response.text.done { responseId: string, text: string }

// TTS audio boundary markers
response.audio.start { responseId: string }
[binary: PCM16 audio frames]
response.audio.done { responseId: string }

// Entire response complete (text + audio)
response.done { responseId: string }
```

**New**: `response.start` provides explicit "thinking" signal. `response.done` is the ultimate terminator — client knows the full response lifecycle is complete.

### Barge-In (Redesigned)
```typescript
// Client initiates barge-in
← barge_in { responseId: string }

// Server acknowledges and guarantees no more events for this response
→ barge_in.ack { responseId: string, truncatedText: string }

// Client can immediately start new utterance
← utterance.start { utteranceId: "new-id" }
```

**Key improvement**: `barge_in.ack` includes `truncatedText` — the text that was sent before abort. Client can store partial response in history without ambiguity. The `responseId` makes it explicit which response was interrupted.

### Error Contract
```typescript
error {
  code: "auth_failed" | "session_limit" | "token_expired" 
      | "protocol_error" | "provider_error" | "utterance_failed"
      | "unsupported_config" | "rate_limited",
  message: string,           // human-readable, never technical
  utteranceId?: string,      // if error is utterance-scoped
  responseId?: string,       // if error is response-scoped
  recoverable: boolean       // client can auto-retry or needs user action
}
```

**Key improvement**: `recoverable` flag tells SDK whether to auto-retry (e.g., provider_error → retry) or surface to user (e.g., auth_failed → re-authenticate). Error codes validated against enum, not free-form strings.

### Versioning Strategy
1. **Major version in URL path**: `/v1/voice`, `/v2/voice`
2. **Minor version via subprotocol**: `Sec-WebSocket-Protocol: sentient-voice-v1.1`
3. **Forward compatibility**: Unknown fields ignored. Unknown message types trigger `protocol_error`.
4. **Version echo**: `session.created` includes `protocol` field confirming negotiated version.

### Binary Protocol
**Keep raw binary** — no framing header for v1. Session handshake (`session.configure` / `session.ready`) establishes the agreed encoding and sample rate. Both sides know the format from the handshake — no per-frame metadata needed.

Rationale: Adding a binary header saves nothing when both sides already agreed on format. The only case for headers is mid-stream codec switching, which is not a v1 requirement.

## Provider Leakage Analysis
| What client knows | Acceptable? | Notes |
|---|---|---|
| Audio encoding (PCM16/Opus) | Yes | Client capability, not provider detail |
| Sample rate (48kHz) | Yes | Client hardware property |
| Barge-in semantics | Yes | UX feature, not provider detail |
| "transcript.partial" exists | Yes | Feature, not implementation |
| STT provider identity | No | Client never learns it's Deepgram |
| TTS provider identity | No | Client never learns it's Fish Audio |
| LLM provider identity | No | Client never learns it's OpenRouter |
| STT config params | No | Gateway internal concern |
| Sample rate conversion | No | Gateway handles 48kHz→16kHz internally |

**Verdict**: The proposed contract maintains clean abstraction. The `session.configure` / `session.ready` handshake is the right level — client declares its capabilities, gateway adapts internally.

## Migration Path (v1 → v2 Protocol)

### Phase 1: Backward-Compatible Additions
- Add `transcript.partial` sending (currently defined, just never sent)
- Add `response.start` / `response.done` messages
- Add `recoverable` field to `error` messages
- Gateway detects client version from subprotocol header

### Phase 2: New Messages
- Add `utterance.start` / `utterance.end` alongside existing `audio.start` / `audio.end`
- Gateway treats both as equivalent internally
- Add `session.configure` / `session.ready` alongside existing `session.start`

### Phase 3: Deprecation
- Mark `audio.start` / `audio.end` as deprecated
- New SDK only sends `utterance.start` / `utterance.end`
- Gateway continues accepting both for one version cycle

## Codebase Integration Points
- `shared/protocol/src/messages.ts` — add new message types, validate error codes against enum
- `gateway/src/server/ws-server.ts:210` — handle `utterance.start`/`utterance.end`
- `gateway/src/pipeline/voice-session.ts` — `readNextFinalTranscript()` → relay partials too
- `gateway/src/server/voice-handlers.ts` — emit `response.start`/`response.done`, pass utteranceId through pipeline
- `web/src/hooks/use-messages.ts:59` — handle `transcript.partial`, `response.start`/`response.done`
- Auth: move token from first JSON message to HTTP `Authorization` header on WS upgrade

## Open Questions
1. **Should audio be base64 in JSON (like OpenAI) or raw binary (current)?** Raw binary is ~33% more efficient but prevents adding metadata per chunk. Recommendation: raw binary for v1 — session handshake establishes format.
2. **Should `utteranceId` be client-generated or server-assigned?** Client-generated allows pre-correlation; server-assigned guarantees uniqueness. Recommendation: client-generated UUID, server validates format.
3. **Multi-utterance overlap**: What if user starts utterance 2 while response to utterance 1 is still streaming? Current architecture aborts response 1. Should v2 support queuing? Recommendation: v1 aborts (barge-in semantics), v2 could add queuing.
4. **Text input in continuous mode**: Does `text.input` bypass the utterance lifecycle entirely? Recommendation: yes, text.input is a separate path that generates a response directly.
