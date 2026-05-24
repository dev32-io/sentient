# Refactor Probe: Voice Pipeline SDK Redesign

You have full autonomy. Do not ask questions. Use your best judgement.

**Do NOT invoke any skills or use the Skill tool.** Follow ONLY the task queue in progress.md.

A copy of the target codebase is at `/workspace/codebase/`. This is your primary reference — read it freely to understand patterns, find related code, and ground your explorations in reality.

## Goals

Redesign the Sentient voice assistant pipeline from a tightly-coupled push-to-talk system into a modular, continuous voice mode SDK with a clean gateway abstraction layer.

**Core principles:**

1. **SDK = magic black box.** A developer reads docs + contracts, plugs in the SDK, and has voice working in <50 lines. Zero internal knowledge required. The SDK handles transport, audio capture/playback, state management, and protocol details.

2. **Gateway = opaque service layer.** The client says "here's audio with start/end markers, give me transcripts and responses." Client never knows if it's Deepgram, Whisper, or anything else internally. Provider-specific edge cases are gateway-internal concerns.

3. **Client-side turn detection.** Speech start/end is detected client-side (VAD or user action). Client sends explicit utterance.start/utterance.end events with streamed audio. Gateway always receives clean, terminated audio segments.

4. **No component too small.** Extreme componentization for long-term extensibility. Adding a new state, provider, or pipeline stage should be 1-2 files, not a refactor. Every component is a stateless processor with typed in→out contract, wired by a central flow manager.

5. **Never break immersion.** Every pipeline state emits a user-visible signal. "Listening...", "Thinking...", "Speaking...". No moment where the user is left staring at nothing. Errors surface naturally — "sorry, pardon?" not stack traces.

6. **Zero-cost testing.** Every component testable in isolation with mock providers. Full pipeline testable without API keys. Contract tests verify SDK↔Gateway protocol.

**This is NOT a one-off refactor.** The architecture must support future features (tool calling, multi-modal, memory, classifier routing) with minimal changes.

## Codebase Context

**Monorepo structure:**
```
sentient/
├── gateway/          # Bun/TypeScript voice gateway (server)
├── web/              # Preact web client
├── shared/
│   ├── protocol/     # Message types, frames, errors, roles (Zod-validated)
│   ├── config/       # Config schemas + YAML loader
│   └── testing/      # Mock providers, audio fixtures, mock WS
└── package.json      # Bun workspaces: ["gateway", "web", "shared/*"]
```

**Current pipeline (push-to-talk):**
- Client: 4 hooks (useWebSocket 227 LOC, useAudioCapture 107 LOC, useAudioPlayback 87 LOC, useMessages 86 LOC) + app.tsx (153 LOC) manage all protocol/pipeline state
- Gateway: ws-server.ts routes messages → voice-handlers.ts orchestrates turn → voice-session.ts manages STT/TTS connections → voice-turn.ts runs LLM→TTS overlap → streaming-overlap.ts does parallel sentence aggregation
- Providers: Deepgram Nova-3 (STT, WebSocket), OpenRouter (LLM, HTTP/SSE), Fish Audio (TTS, WebSocket+MsgPack)
- Protocol: 10 client→gateway + 12 gateway→client message types, all Zod-validated

**Key existing code to reuse:**
- `shared/protocol/src/messages.ts` — all message schemas including `transcript.partial` (defined but never sent)
- `shared/protocol/src/frames.ts` — AudioFrame, TextFrame, TranscriptFrame (defined but pipeline bypasses them)
- `shared/testing/` — MockSTTProvider, MockTTSProvider, audio fixtures, MockWebSocket
- `gateway/src/providers/stt/deepgram-provider.ts` — already has `interim_results: "true"`, emits partial transcripts via `isFinal: boolean`
- `gateway/src/pipeline/processors/sentence-aggregator.ts` — sentence boundary detection works well
- `web/src/audio/capture-worklet.ts`, `playback-worklet.ts` — AudioWorklets work, reuse as platform adapter internals

**Key problems in current code:**
- `voice-session.ts:131-138` — `readNextFinalTranscript()` filters for `isFinal: true` only, discarding all partial transcripts
- `app.tsx` — knows about PCM16 codec, sample rates, barge-in semantics (pipeline knowledge leaks)
- Provider interfaces inconsistent: STT has full lifecycle, LLM has just `stream()`, no connect/disconnect
- Frame system exists but `voice-turn.ts` bypasses it with custom VoiceTurnEvent objects
- Early audio buffer leak if `connectPromise` fails (`voice-session.ts:50`)
- No test coverage for: STT drop mid-stream, TTS drop mid-synthesis, WS close mid-turn

**Provider interfaces (exact signatures):**
- STT: `connect(config, signal) → sendAudio(Uint8Array) → finalize() → transcripts(signal): AsyncGenerator<TranscriptEvent> → disconnect()`
- TTS: `connect(config, signal) → synthesize(text, signal): AsyncGenerator<TTSAudioChunk> → disconnect()`
- LLM: `stream(options): AsyncGenerator<string>` (stateless, no lifecycle)

## Workspace Structure

```
/workspace/
├── prompt.md                # this file (read-only reference)
├── progress.md              # scoreboard + task queue — your instruction sheet
├── expansion-loop.md        # how to handle Score tasks
├── scoring-rubric.md        # scoring dimensions for subagents
├── synthesis.md             # LIVING DOCUMENT — update at every Synthesize step
├── explorations/            # research + analysis per topic
│   ├── topic-name.md
│   └── ...
├── poc/                     # standalone sketch projects
│   ├── poc-name/
│   └── ...
├── risks.md                 # cross-cutting risks + mitigations
├── sources.md               # running bibliography
└── connections.md           # cross-topic patterns and dependencies
```

## How This Works

1. Read `/workspace/progress.md` and find the next unchecked item in the Task Queue
2. Do that ONE item
3. Check it off in progress.md
4. Output `TASK DONE`
5. Stop — you will be re-invoked automatically

When the task queue is empty, output `<promise>TASK DONE</promise>` instead.

## PoC Rules — CRITICAL

**Default: isolated sketch projects.** Build PoCs in `/workspace/poc/<name>/` as standalone minimal projects.

**PoCs MUST replicate the actual problem at small scale before solving it.** Read the real codebase to understand the debt/bug/pattern, then recreate it in a minimal standalone project. The PoC is an isolated copy of the problem — experiment and solve there.

**DO NOT modify the real codebase.** Read it freely for reference. Never write to files outside `/workspace/`. No exceptions.

**Scoring evaluates transferability**, not integration. The question is: "does this PoC approach look viable for the real codebase?" — not "did we apply it."

## Synthesize Step

When you reach a `Synthesize: update synthesis.md` task:

1. Read all explorations, scores, and PoC results so far
2. Re-read the Goals section above to stay anchored
3. Update `synthesis.md` with the current state of each topic:
   - Approaches explored with score breakdowns
   - PoC results with relative paths (e.g., `/workspace/poc/auth-migration/`)
   - Viability assessment: would this approach transfer to the real codebase?
   - Mark each topic's status: exploring / scored / concluded
4. Update `risks.md` with any cross-cutting risks discovered
5. Update `connections.md` with cross-topic dependencies and patterns

## Initial Topics

### 1. Client-Side VAD & Speech Boundary Detection (`client-vad`)
- How does the SDK detect speech start/end from mic input without user button press?
- WebAudio API energy-level detection vs lightweight VAD library
- Threshold tuning: sensitivity vs false positives
- Fallback: manual toggle mode for unreliable VAD environments
- Integration with AudioWorklet capture pipeline (existing capture-worklet.ts)
- Edge case: cough, background noise burst, brief pause mid-sentence

### 2. SDK State Machine — Complete States & Transitions (`sdk-state-machine`)
- Formal transition table with ALL states including: inactive, listening, user-speaking, processing, assistant-speaking, reconnecting, error
- Timeout guards on every waiting state (processing must not hang forever)
- Barge-in transitions: user speaks during assistant-speaking OR during processing (after speech_final, before first response token)
- Reconnection state: mic was on, WS dropped — what happens to buffered audio and in-flight transcript?
- Error state recovery paths: which errors auto-recover vs require user action?
- "Thinking"/"Processing" indicator states that always keep user informed
- Double utterance: user finishes one sentence, starts another before response begins
- State machine must be a pure function — no side effects, no I/O, just (state, event) → state

### 3. SDK-to-Gateway Contract (`sdk-gateway-contract`)
- Exact message types for utterance lifecycle: utterance.start, audio stream, utterance.end
- What the client sends, what it expects back — zero provider leakage
- How partial transcripts flow back (reuse existing `transcript.partial` message type)
- How response text + audio interleave over the wire
- Binary vs JSON message routing — should audio always be binary, control always JSON?
- Session lifecycle: connect → auth → voice mode on/off → disconnect
- Error message contract: what error codes exist, what they mean to the client (not to the provider)
- Versioning: how to handle SDK v2 client talking to v1 gateway

### 4. Gateway Pipeline — Stateless Stage Composition (`gateway-pipeline`)
- Replace monolithic voice-handlers.ts with composable stateless stages
- Each stage: typed input → typed output, no knowledge of neighbors
- Flow manager wires stages and owns all state (connections, history, abort controllers)
- ContinuousSession replacing VoiceSession: event-driven, relays partial transcripts, accumulates finals
- How `utterance.start`/`utterance.end` from client maps to STT provider lifecycle internally
- How LLM→SentenceAggregator→TTS overlap works as composable stages
- Provider-agnostic stage interfaces: swap Deepgram for Whisper = implement interface, nothing else changes

### 5. Audio Codec Negotiation (`codec-negotiation`)
- Currently hardcoded: client sends PCM16@48kHz, gateway sends PCM16@44.1kHz
- `session.start` message already has `encoding` field but gateway ignores it
- How to negotiate format at connection time (PCM16 vs Opus, sample rate)
- Gateway should honor client's requested format or reject with supported alternatives
- SDK AudioCodec module: pure functions for encode/decode, sample rate conversion
- What happens if negotiation fails — fallback format?

### 6. Integration Testing — Mock Provider Replay (`testing-strategy`)
- Test every component in isolation with mock input/output (zero API cost)
- Pipeline integration tests: real SentenceAggregator + real StreamingOverlap + MockSTT + MockTTS + MockLLM
- WebSocket contract tests: real Bun server + mock providers + real WS client
- SDK integration tests: real VoiceClient + mock transport + mock audio adapters
- Record/replay pattern: record one real provider session, replay in tests forever (~$0.01 one-time cost)
- Update MockSTTProvider to support imperative `emitEvent()` for continuous mode testing
- State machine tests: verify every transition, verify no dead states
- Edge case tests: STT drop mid-stream, TTS drop mid-synthesis, WS close mid-turn, auth timeout, double barge-in

### 7. Error UX — Graceful "Pardon?" Experience (`error-ux`)
- Every error maps to a user-visible state — never silent failure
- Session loss = "sorry, pardon?" — show friendly message, let user try again
- Provider timeout = "thinking..." indicator with eventual timeout message
- STT failure mid-utterance = "I didn't catch that, could you repeat?"
- No technical jargon in error surfaces — classify errors into user-actionable categories
- Recovery flow: which errors auto-recover (reconnect) vs require user action (re-speak)?
- How the state machine transitions on each error type
- Latency indicators: when to show "processing" vs when it's fast enough to skip
