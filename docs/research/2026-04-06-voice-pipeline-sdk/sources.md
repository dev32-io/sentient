# Sources

## Codebase (Primary)
- `/workspace/codebase/sentient/` — full monorepo source

## Key Files Referenced

### Protocol
- `shared/protocol/src/messages.ts` — 10 client→gateway + 12 gateway→client message schemas
- `shared/protocol/src/frames.ts` — AudioFrame, TextFrame, TranscriptFrame, SystemFrame, ControlFrame
- `shared/protocol/src/errors.ts` — CLOSE_CODES, ERROR_TYPES, createErrorMessage
- `shared/protocol/src/session.ts` — Session schema, TOKEN_CLAIMS_SCHEMA

### Gateway Pipeline
- `gateway/src/pipeline/voice-session.ts` — STT/TTS lifecycle, audio buffering, readNextFinalTranscript
- `gateway/src/pipeline/voice-turn.ts` — LLM→StreamingOverlap→TTS, custom VoiceTurnEvent types
- `gateway/src/pipeline/processors/streaming-overlap.ts` — parallel sentence→TTS processing
- `gateway/src/pipeline/processors/sentence-aggregator.ts` — token accumulation, sentence boundary detection
- `gateway/src/pipeline/processors/tts-processor.ts` — sentence → AudioFrame via TTSProvider
- `gateway/src/pipeline/frame-queue.ts` — priority-aware frame queue (underutilized)
- `gateway/src/pipeline/barge-in/barge-in-controller.ts` — AbortSignal-based barge-in

### Gateway Server
- `gateway/src/server/ws-server.ts` — Bun WS server, message routing, session lifecycle
- `gateway/src/server/voice-handlers.ts` — turn orchestration, transcript reading, WS message serialization

### Providers
- `gateway/src/providers/stt/stt-types.ts` — STTProvider interface, TranscriptEvent
- `gateway/src/providers/stt/deepgram-provider.ts` — Deepgram Nova-3 WebSocket client
- `gateway/src/providers/tts/tts-types.ts` — TTSProvider interface, TTSAudioChunk
- `gateway/src/providers/llm-provider.ts` — LLMProvider interface (stateless stream())

### Web Client
- `web/src/app.tsx` — AppWiring, AudioPipeline, handleToggleTalk
- `web/src/hooks/use-websocket.ts` — WS lifecycle, reconnect, ping/pong
- `web/src/hooks/use-audio-capture.ts` — mic capture via AudioWorklet
- `web/src/hooks/use-audio-playback.ts` — TTS playback via AudioWorklet
- `web/src/hooks/use-messages.ts` — chat message management
- `web/src/audio/capture-worklet.ts` — Float32→Int16 PCM capture processor
- `web/src/audio/playback-worklet.ts` — FIFO playback processor
- `web/src/types.ts` — ConnectionState, TalkState, PlaybackState, AuthState, ChatMessage
- `web/src/constants.ts` — sample rates, timeouts, buffer sizes

### Testing
- `shared/testing/src/mock-stt-provider.ts` — pre-loaded transcript events
- `shared/testing/src/mock-tts-provider.ts` — configurable chunk generation

### Config
- `shared/config/src/schema.ts` — STT/LLM/TTS/Gateway config schemas

---

## Landscape Survey (per topic)

### client-vad — Voice Activity Detection
- **@ricky0123/vad-web** — Silero VAD ONNX model (~2MB) via onnxruntime-web, Web Worker path. `MicVAD` API with `onSpeechStart`/`onSpeechEnd`. Requires `SharedArrayBuffer` (COOP/COEP headers). Processes 30ms frames minimum.
- **hark.js** — Energy-based (AnalyserNode FFT + volume threshold). Tiny, but noise-sensitive, needs manual threshold tuning.
- **Custom RMS in AudioWorklet** — Compute RMS per 128-sample frame, debounce transitions. Zero bundle cost, ~3ms latency. Fails in noisy environments.
- **Spectral-gated RMS** — Biquad bandpass 300–3400 Hz before RMS in AudioWorklet. Better voice discrimination, zero dependencies.
- **Industry**: LiveKit uses energy detector by default, optional Silero opt-in. Daily does server-side VAD. Twilio uses energy-based for `isSpeaking`.
- **Key tradeoff**: Silero = high accuracy + 2MB + CORS constraints vs energy/RMS = simple + zero-cost + noise-sensitive.

### sdk-state-machine — State Machine Patterns
- **XState v5** (~15KB) — Full actor model, excellent TS inference, inspector devtools. Heavy for SDK distribution.
- **@xstate/store** (~2KB) — Stripped to Redux-style reducer. Lighter but no devtools.
- **Robot** (~1KB) — Minimal FSM, sparse maintenance since 2022, weak TS generics.
- **Plain (state, event) → state reducer** — Zero deps, full TS exhaustiveness via `satisfies never`. Dominant pattern in production voice SDKs (LiveKit JS, Daily `call-machine`).
- **Industry voice states**: `idle → listening → processing → speaking → idle` with orthogonal `error` and `reconnecting` states. Discriminated union with `status` discriminant is standard.
- **Testing**: Exhaustive transition table (all state×event pairs), fast-check for random event sequences, BFS reachability for dead-state detection. 6×8 matrix = 48 assertions in <5ms.
- **Key tradeoff**: XState (powerful, heavy, application-grade) vs plain reducer (zero dep, SDK-grade, caller wraps in useReducer/Redux/EventEmitter).

### sdk-gateway-contract — Protocol Design
- **OpenAI Realtime API** — Pure JSON over WSS. `session.create/update`, `input_audio_buffer.append` (base64), `response.audio.delta` (base64). Auth via HTTP header at upgrade. Events carry `event_id` and `response_id` for correlation. VAD events: `speech_started`/`speech_stopped`. Sessions persist up to 60 min.
- **Deepgram Streaming** — Binary audio frames + JSON transcript responses. Config via query params on upgrade URL. Events: `Results` (with `is_final`, `speech_final`), `SpeechStarted`, `UtteranceEnd`. `UtteranceEnd` fires on silence gap ≥ `utterance_end_ms` (transcript-based, robust to noise).
- **Twilio Media Streams** — All JSON including audio (base64 in `media.payload`). ~33% overhead.
- **LiveKit** — Protobuf binary protocol. Separate signaling/media planes.
- **ElevenLabs Multi-Context WS** — Multiple contexts per connection via `context_id`. JSON text frames for all messages including audio (base64). `InitializeConnectionMulti`, `SendTextMulti`, `AudioOutputMulti`, `FinalOutputMulti`.
- **Together.ai Audio WS** — `input_text_buffer.append/commit/clear` pattern. Audio output as base64 WAV at 24kHz.
- **Binary/JSON multiplexing**: Best pattern = WS message type as mux (binary=audio, text=JSON). Zero overhead, no extra framing.
- **Utterance lifecycle**: `speech_started → partial_transcript* → speech_ended → final_transcript` is universal across all providers.
- **Session lifecycle**: `connect → auth (HTTP header) → server session.created → client session.configure → server session.ready → stream → session.end`.
- **Versioning**: URL path for major (`/v1/realtime`), `Sec-WebSocket-Protocol` subprotocol for minor, echo version in `session.created`. Unknown fields ignored for forward compatibility.
- **Event correlation**: Every request/response pair linked via IDs. OpenAI uses `event_id` + `response_id`. Critical for multiplexed scenarios.
- **Barge-in protocol gap**: Current system sends no terminator (text.done/audio.done) on barge-in. Industry standard is explicit acknowledgment with truncated content.

### gateway-pipeline — Composable Stage Architecture
- **Pipecat** (Python) — Gold standard. Typed `Frame` objects through `Processor` stages connected via async queues. Per-stage async tasks.
- **LiveKit Agents** — Swappable `Plugin` implementations behind stable interface. Declarative pipeline assembly.
- **Node.js Transform streams** — Native pull/push with backpressure. Weak typing, verbose API.
- **Async generator composition** — `async function* stage(input: AsyncIterable<In>): AsyncIterable<Out>`. Pure functions, zero shared state, compose as `tts(agg(llm(stt(audio))))`. Dominant pattern for Bun/TS.
- **Push at edges, pull internally**: WS callbacks → queue → async generators consume. Matches Pipecat's `asyncio.Queue` boundary.
- **Flow manager**: Central `PipelineRunner` owns connections, history, abort controllers. Stages are stateless functions, receive config at construction.
- **Provider-agnostic interfaces**: Define as `AsyncIterable<In> → AsyncIterable<Out>`. Swap = implement interface, nothing else changes.

### codec-negotiation — Audio Format Negotiation
- **Current state**: Client sends PCM16@48kHz, gateway sends PCM16@44.1kHz. `session.start` has `encoding` field but gateway ignores it.
- **Opus vs PCM16**: Opus ~12-40x bandwidth reduction but adds ~20ms latency + requires WebCodecs/WASM. PCM16 = zero-latency, zero-complexity.
- **Browser Opus**: WebCodecs `AudioEncoder` (Chrome 94+, Safari 16.4+), or WASM libopus (~200-400KB). MediaRecorder buffers into blobs (not suitable for streaming).
- **Negotiation protocol**: Client proposes `supportedEncodings[]` + sample rates in `session.start`. Gateway selects + echoes in `session.ready`. Reject with `unsupported_encoding` error + supported list.
- **Sample rate conversion**: Gateway owns all resampling (48kHz→16kHz for STT, 48kHz→44.1kHz for playback). Preserves "gateway = opaque" principle. `AudioFrame` already carries `sampleRate` field.
- **Industry**: OpenAI uses `session.update` with `input_audio_format`/`output_audio_format`. Deepgram uses query params. Twilio hardcodes mulaw 8kHz.

### testing-strategy — Mock Provider & Pipeline Testing
- **Record/replay**: No off-the-shelf tool for WS/audio streams. Hand-roll JSON fixture files (`{type, payload, delayMs}[]`) captured from real sessions, replay via `FixtureProvider`.
- **Imperative vs declarative mocks**: Imperative (`provider.emit()`) wins for continuous streaming — precise mid-stream injection, failure simulation. Declarative (pre-loaded arrays) for happy-path regression. Best: combine both.
- **WS contract testing**: Start real `Bun.serve()` on random port, connect test clients. No external tools needed. Validate both directions with Zod schemas.
- **State machine testing**: Exhaustive transition table + fast-check random event sequences + BFS reachability. `fc.assert(fc.asyncProperty(...))` integrates with Vitest.
- **Pipeline integration**: Wire `MockSTT → MockLLM → MockTTS` into real pipeline orchestrator. Assert on output events and final state. Zero API cost.
- **Edge cases**: `stt.dropConnection()`, `tts.stallChunk(n)`, `ws.closeAbruptly()`, double barge-in — all via imperative mock methods + `vi.useFakeTimers`.

### error-ux — Graceful Error Experience
- **Industry taxonomy**: Mishear ("didn't catch that"), intent-miss ("not sure how to help"), system fault ("something went wrong"). Never expose technical cause.
- **Error classification to user action**: STT low-confidence → re-speak, backend timeout → wait/retry, WS disconnect → auto-reconnect, TTS failure → text fallback, fatal (auth/quota) → escalate.
- **Recovery framework**: Auto-recover if transient + invisible (<2s). Require user action if user's turn data is ambiguous/lost.
- **Latency thresholds**: 0–400ms no indicator, 400ms–1.5s subtle animation, 1.5–4s text hint, >4s explicit message, >8s offer escape hatch. Never >400ms with zero feedback in voice mode.
- **Voice-specific**: STT silence = 2-stage timeout (soft 3s, hard 6s). TTS hang >1.5s = text fallback. WS drop during user speech = reconnect + re-speak prompt.
- **State machine integration**: Errors as states (not just transitions). Each error state owns its render, timer, and exit conditions. `[Error:Mishear]`, `[Error:Waiting]`, `[Error:Disconnected]` etc. Every error state emits visible signal within 400ms.
