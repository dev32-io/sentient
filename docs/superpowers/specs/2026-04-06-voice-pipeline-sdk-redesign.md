# Voice Pipeline SDK Redesign

## Context

The current voice pipeline is a tightly-coupled push-to-talk system where the web client manages protocol details (PCM16 codec, sample rates, barge-in semantics) across 4 hooks totaling ~500 LOC. None of this is reusable for mobile. The gateway mixes provider-specific concerns into handler logic. State is scattered across boolean flags and disconnected signals.

This redesign shifts to a **continuous voice mode SDK** with a clean gateway abstraction layer. The SDK is a magic black box — a developer reads docs, plugs it in, and has voice working in <50 lines. The gateway is an opaque service — the client sends audio segments with start/end markers and gets transcripts and responses back, never knowing what providers run internally.

**Validated by**: 85-iteration offline research session producing 11,449 LOC across 11 PoCs with formal state tables, exhaustive test harnesses, and consumer API proofs. Research output: `docs/research/2026-04-06-voice-pipeline-sdk/`.

## Core Principles

1. **SDK = magic black box.** Developer sees one `VoiceStatus` object. Zero internal knowledge required. VAD, error recovery, transport — all hidden.
2. **Gateway = opaque service.** Client sends audio with utterance start/end markers. Gateway returns transcripts and responses. Provider-specific edge cases are gateway-internal.
3. **Client-side turn detection.** Speech start/end detected client-side via VAD in AudioWorklet. Gateway always receives clean, terminated audio segments.
4. **No component too small.** Every component is a stateless processor with typed in→out contract. Adding a new state, provider, or pipeline stage = 1-2 files.
5. **Never break immersion.** Every pipeline state emits a user-visible signal. No silent gaps. Errors surface naturally.
6. **Zero-cost testing.** Every component testable in isolation. Full pipeline testable without API keys.

## Architecture

### Package Structure

```
sentient/
├── shared/
│   ├── protocol/           # message schemas, frames (MODIFIED)
│   ├── config/             # config schemas (UNCHANGED)
│   ├── testing/            # mocks, fixtures (ENHANCED)
│   └── web-sdk/            # NEW — platform-agnostic voice client
├── gateway/                # MODIFIED — continuous mode pipeline
└── web/                    # SIMPLIFIED — thin UI over SDK
```

Dependency flow: `web → web-sdk → protocol`. `gateway → protocol, config, testing`. SDK never depends on gateway or web.

### State Machines

Three pure reducer state machines inside the SDK. All follow `(state, event) → { state, effects[] }`. Only the Voice machine is exposed to the developer.

**Voice State Machine (public — 9 states)**

The developer-facing machine. 9 states, ~22 event types, ~20 transitions.

```
States: inactive | connecting | listening | user-speaking |
        processing | assistant-speaking | interrupting |
        reconnecting | error
```

- `SPEECH_START`/`SPEECH_END` received from internal VAD machine
- `processing` starts staged timer: 2s "Thinking...", 5s "Still thinking..."
- `assistant-speaking` allows barge-in via `SPEECH_START` → `interrupting`
- `WS_DROP` from any active state → `reconnecting` (3 retry budget)
- Timeout guards: connecting (10s), processing (30s), interrupting (3s)

PoC reference: `docs/research/2026-04-06-voice-pipeline-sdk/poc/sdk-state-machine-consumer-api/state-machine.ts`

**VAD State Machine (internal — 11 states)**

Hidden inside SDK. Receives worklet `vad` events, outputs `SPEECH_START`/`SPEECH_END` to Voice machine.

```
States: inactive | requesting-mic | listening | speech-detected |
        user-speaking | trailing-silence | processing |
        assistant-speaking | interrupting | error | disposed
```

- Onset debounce: 32ms (filter coughs/noise)
- Trailing silence: 700ms (allow mid-sentence breath)
- Barge-in confirm: 300ms (prevent echo loops)
- Supports vad/ptt/continuous detection modes, all produce same output events

PoC reference: `docs/research/2026-04-06-voice-pipeline-sdk/poc/client-vad-state-table/vad-state-machine.ts`

**Error UX State Machine (internal — 7 states)**

Hidden inside SDK. Receives raw errors, outputs recovery actions + user messages to Voice machine.

```
States: nominal | error-detected | user-notified |
        auto-recovering | awaiting-user | recovery-timeout | escalated
```

- 6 error categories: connection_lost, didnt_catch, thinking_timeout, service_unavailable, auth_required, try_again
- 6 recovery strategies: auto_reconnect, reset_to_listening, retry_once, wait_and_retry, require_auth, prompt_retry
- Max 2 retries before escalation
- Classifier and resolver are pure functions

PoC references: `docs/research/2026-04-06-voice-pipeline-sdk/poc/error-ux-consumer-api/src/error-classifier.ts`, `docs/research/2026-04-06-voice-pipeline-sdk/poc/error-ux-state-table/`

**Composition model:**

```
Worklet vad event → VAD machine → SPEECH_START/END → Voice machine → effects → Transport/Playback/VAD
Transport error   → Error machine → recovery action → Voice machine → effects → Transport (reconnect/retry)
```

Developer sees only:

```typescript
interface VoiceStatus {
  state: VoiceState
  label: string              // "Listening..." | "Thinking..." | etc.
  canSpeak: boolean
  isActive: boolean
  transcript?: string
  response?: string
  error?: string
}
```

### Protocol Changes

**New client → gateway messages:**

```typescript
utterance.start   { utteranceId: string }
utterance.end     { utteranceId: string }
utterance.cancel  { utteranceId: string }
session.configure { supportedEncodings, preferredEncoding, captureSampleRate, playbackSampleRate }
```

**New gateway → client messages:**

```typescript
status.processing  { utteranceId: string }
session.ready      { encoding, captureSampleRate, playbackSampleRate }
response.start     { utteranceId: string, responseId: string }
```

**Modified gateway → client messages (add correlation IDs):**

```typescript
transcript.partial  { utteranceId, text }      // was: never sent
transcript.final    { utteranceId, text }       // was: no utteranceId
response.text.delta { responseId, text }       // was: no responseId
response.text.done  { responseId }
response.audio.start { responseId }
response.audio.done  { responseId }
barge_in.ack        { responseId }             // was: no responseId
tool.confirm_request { responseId, toolCallId, toolName, args, description }
```

**Semantic shifts:**

- `audio.start` = "enter voice mode" (was: "I pressed the button")
- `audio.end` = "exit voice mode" (was: "I released the button")

**Correlation IDs:**

- `utteranceId` — client-generated, tracks user input from `utterance.start` through `transcript.final`
- `responseId` — gateway-generated, tracks assistant output from `response.start` through `response.audio.done`
- Linked: `response.start` carries both. Separate because one utterance may trigger multiple responses (tool calls).

PoC reference: `docs/research/2026-04-06-voice-pipeline-sdk/poc/sdk-gateway-contract-state-table/contract-state-machine.ts`

### Codec Negotiation

Fixes 3 existing bugs (R1 in research risks):
1. Deepgram told 16kHz but receives 48kHz — works by accident
2. TTS defaults to Opus but client decodes as PCM16
3. 48kHz PCM played at 44.1kHz = 8% pitch shift

Protocol handshake:

```
Client: session.configure { supportedEncodings: ["pcm16"], preferredEncoding: "pcm16",
                            captureSampleRate: 48000, playbackSampleRate: 44100 }
Gateway: session.ready    { encoding: "pcm16", captureSampleRate: 48000,
                            playbackSampleRate: 44100 }
```

- v1: PCM16 only. Codec abstraction in SDK supports future Opus.
- Gateway owns all resampling (client→STT rate, TTS→client rate).
- Audio middleware stage inserted between WS audio forwarding and provider stages.
- Fallback: if no `session.configure` before `utterance.start`, gateway assumes PCM16/48kHz (backward compatible).

PoC reference: `docs/research/2026-04-06-voice-pipeline-sdk/poc/codec-negotiation-consumer-api/`

### Gateway Pipeline

Replaces monolithic `voice-handlers.ts` with ContinuousSession and composable stages.

**ContinuousSession** (replaces `voice-session.ts`):

- Event-driven, relays ALL transcript events (partials + finals)
- On `utterance.start`: forward audio to STT, relay `transcript.partial` back to client
- On `utterance.end`: emit `status.processing` immediately, finalize STT, send `transcript.final`, generate `responseId`, kick off LLM→TTS pipeline
- After response completes: session stays alive, STT stays connected, ready for next utterance
- AbortController per turn, early audio buffering — same patterns as current `voice-session.ts`

**Stage composition:**

```typescript
const llmTokens = llmProvider.stream(messages, signal)
const sentences = sentenceAggregatorStage(llmTokens, signal)
const audioFrames = ttsStage(sentences, signal)
```

Each stage: `(AsyncIterable<In>, AbortSignal) → AsyncGenerator<Out>`. FlowManager taps streams to relay events to client.

**Existing code reuse:**

- `sentence-aggregator.ts`, `sentence-boundary.ts` — reused, wrapped as stage
- `tts-processor.ts` — reused as stage wrapper
- Provider implementations (Deepgram, OpenRouter, Fish Audio) — unchanged
- AbortController rotation, early audio buffering — patterns preserved

**Timeout guards (gateway):**

- STT finalization: 5s
- LLM stream: 30s
- Provider reconnect: 10s, 3 retry budget

PoC references: `docs/research/2026-04-06-voice-pipeline-sdk/poc/gateway-pipeline-consumer-api/pipeline-sdk.ts`, `docs/research/2026-04-06-voice-pipeline-sdk/poc/gateway-pipeline-state-table/pipeline-state-machine.ts`

### Web Client

Becomes a thin UI layer over the SDK.

**AudioWorklet modification** (`capture-worklet.ts`): Add RMS energy calculation (~5 lines) to existing `process()` loop. Posts two message types: `pcm` (audio data) and `vad` (speech boolean). VAD compute happens on audio thread, main thread receives boolean only.

**Web audio adapters**: `web-audio-capture.ts` implements `AudioCaptureAdapter`, `web-audio-playback.ts` implements `AudioPlaybackAdapter`. Extracted from existing hooks, same getUserMedia setup and worklet loading.

**Preact bridge** (`use-voice-client.ts` ~50 LOC): Creates adapters + VoiceClient, wires SDK events to Preact Signals.

**App.tsx** (rewrite ~40 LOC): Zero protocol, audio, or codec knowledge. Just SDK + UI.

**New components**: `voice-mode-button.tsx` (~40 LOC), `live-transcript.tsx` (~30 LOC).

**Deleted after migration**: `use-websocket.ts`, `use-audio-capture.ts`, `use-audio-playback.ts`, `use-messages.ts`, `toggle-talk-button.tsx` (all + tests).

### Developer Experience

```typescript
// Web
const client = useVoiceClient({ wsUrl: WS_URL, token })
// client.status  → VoiceStatus signal
// client.messages → ChatMessage[] signal
// client.startVoiceMode() / client.stopVoiceMode() / client.sendText()

// Future mobile (same SDK, different adapters)
val client = VoiceClient(wsUrl, token, AndroidCapture(ctx), AndroidPlayback(ctx))
client.onStatusChange { status -> /* same VoiceStatus */ }
```

## Testing Strategy

Five layers, all zero API cost.

**Layer 1: Pure State Machine Tests.** Exhaustive transition tests per machine. Every state reachable, every state has exit, every waiting state has timeout guard. Pattern: `docs/research/2026-04-06-voice-pipeline-sdk/poc/sdk-state-machine-test-harness/`.

**Layer 2: Component Isolation Tests.** Each SDK component tested with mock inputs. Transport, MessageStore, TranscriptAccumulator, ProcessingTimer, ErrorClassifier, RecoveryResolver, AudioCodec.

**Layer 3: SDK Integration Tests.** VoiceClient with MockTransport + MockCaptureAdapter. Full turn cycles, barge-in, reconnect, error recovery.

**Layer 4: Gateway Pipeline Integration Tests.** Real ContinuousSession + real stages, mock providers. Pattern: `docs/research/2026-04-06-voice-pipeline-sdk/poc/gateway-pipeline-test-harness/`.

**Layer 5: WebSocket Contract Tests.** Real Bun server + mock providers + real WS client. Full protocol verification including utteranceId/responseId correlation.

**Test philosophy:**

1. Test behavior through contracts, not internals
2. Pure functions don't need mocks
3. Every waiting state must have a timeout test
4. Zero-cost by default — no API keys ever
5. Test sad paths harder than happy path
6. Exhaustiveness over coverage percentage

**Mock enhancements needed:**

- `MockSTTProvider` — add `emitEvent()`, `simulateDisconnect()`
- `MockTTSProvider` — add `failAfterChunks`, `stallAfterChunks`
- New `MockLLMProvider` — configurable token stream with failure injection
- New `MockTransport`, `MockCaptureAdapter`, `MockPlaybackAdapter`

## Implementation Phases

**Phase 1: SDK Foundation** — no existing code touched

```
shared/web-sdk/package.json, tsconfig.json
shared/web-sdk/src/
  event-emitter.ts              + test
  voice-state-machine.ts        + test    PoC: sdk-state-machine-consumer-api
  vad-state-machine.ts          + test    PoC: client-vad-state-table
  error-state-machine.ts        + test    PoC: error-ux-state-table
  error-classifier.ts           + test    PoC: error-ux-consumer-api
  recovery-resolver.ts          + test    PoC: error-ux-consumer-api
  processing-timer.ts           + test
  transport.ts                  + test    extracted from use-websocket.ts
  message-store.ts              + test    extracted from use-messages.ts
  transcript-accumulator.ts     + test
  audio-capture-adapter.ts               interface only
  audio-playback-adapter.ts              interface only
  audio-codec.ts                + test
  voice-client.ts               + test    orchestrator
  index.ts
```

16 source files, 13 test files. ~4,400 LOC.

**Phase 2: Protocol + Codec** — additive changes to shared packages

```
shared/protocol/src/messages.ts          MODIFIED
shared/testing/src/mock-stt-provider.ts  MODIFIED
shared/testing/src/mock-tts-provider.ts  MODIFIED
shared/testing/src/mock-llm-provider.ts  NEW
shared/testing/src/mock-transport.ts     NEW
shared/testing/src/mock-audio-adapter.ts NEW
shared/testing/src/index.ts              MODIFIED
```

~400 LOC.

**Phase 3: Gateway Continuous Mode** — additive, old code stays

```
gateway/src/pipeline/continuous-session.ts                  + test
gateway/src/server/continuous-voice-handler.ts              + test
gateway/src/server/ws-server.ts                             MODIFIED
gateway/src/server/ws-helpers.ts                            MODIFIED
gateway/src/pipeline/__tests__/continuous-session.integration.test.ts
gateway/src/server/__tests__/continuous-voice.integration.test.ts
```

~800 LOC.

**Phase 4: Web Client Migration** — one PR swap

```
web/src/audio/capture-worklet.ts           MODIFIED (add VAD ~5 lines)
web/src/adapters/web-audio-capture.ts      + test
web/src/adapters/web-audio-playback.ts     + test
web/src/hooks/use-voice-client.ts          + test
web/src/components/voice-mode-button.tsx   + test
web/src/components/live-transcript.tsx     + test
web/src/app.tsx                            REWRITE
web/src/components/chat-screen.tsx         MODIFIED
```

~500 LOC.

**Phase 5: Cleanup**

Delete old hooks (5 files + tests), deprecate `voice-session.ts` and `voice-handlers.ts`. Net -1,000 LOC.

## Risks & Mitigations

| Risk | Mitigation | Research Ref |
|------|-----------|-------------|
| 7s silent gap between speech end and first response | `status.processing` emitted immediately + staged timer (2s/5s/15s/30s) | R14 |
| Sample rate bugs (3 active) | Codec negotiation in Phase 2, gateway-side resampling | R1 |
| Barge-in echo loop | 300ms confirmed speech before barge-in, cooldown after failed attempt | R8 |
| MockSTT can't test continuous mode | Enhanced with `emitEvent()` and `simulateDisconnect()` | R3 |
| No timeout on processing state | 30s guard on SDK, 30s on LLM stream, 5s on STT finalization | R6 |
| Error codes inconsistent | Validate against schema, expand ERROR_TYPES enum | R5 |
| Dead protocol code | Activate `transcript.partial`, `session.start`. Mark remaining as future. | R4 |
| Type safety bypass in tests | Remove `as unknown as` casts, mocks implement real interfaces | R11 |

## Existing Code Reuse

| Component | Strategy |
|-----------|----------|
| `sentence-aggregator.ts` | Wrap as async generator stage |
| `sentence-boundary.ts` | Direct reuse, no changes |
| `tts-processor.ts` | Wrap as stage |
| Provider implementations | Unchanged |
| `capture-worklet.ts` | Add VAD RMS, keep PCM encoding |
| `playback-worklet.ts` | Reuse as-is |
| `mock-stt-provider.ts` | Enhance with async queue |
| `mock-tts-provider.ts` | Enhance with failure modes |
| `audio-fixtures.ts` | Extend for multi-utterance |

## Verification

1. `bun run test:unit` — all state machine + component tests pass
2. `bun run test:int` — pipeline + WebSocket contract tests pass with mock providers
3. `bun run typecheck` — passes
4. `bun run lint` — passes
5. Manual E2E: `bun run dev`, toggle voice mode, speak, verify partial transcripts stream, response arrives as text + audio, mic stays active for next utterance, toggle off returns to text mode
