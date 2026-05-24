# Cross-Cutting Risks

## R1: Sample Rate Mismatch — Silent Quality Degradation
**Impact**: Audio quality issues that are hard to diagnose.
**Current state**: Client captures at 48kHz, STT expects 16kHz, TTS outputs 48kHz, client plays at 44.1kHz. No explicit resampling anywhere. Three concrete bugs found: (1) Deepgram told 16kHz but receives 48kHz — works via undocumented auto-detection, (2) TTS defaults to Opus but client decodes as PCM16, (3) 48kHz PCM played at 44.1kHz = 8% pitch shift.
**Mitigation**: Codec negotiation handshake + gateway-side resampling stage. Fix STT config to declare true sample rate or resample before forwarding.
**Topics**: codec-negotiation, gateway-pipeline

## R2: No State Recovery on Connection Drop
**Impact**: User left in broken state if WS drops mid-turn.
**Current state**: `voice-session.ts` has no reconnection logic. Buffered audio is lost. In-flight transcript is lost. Client has reconnect-with-backoff but no "lost turn" notification.
**Mitigation**: State machine with explicit `reconnecting` state + "Sorry, could you repeat that?" notification when turn is lost during `processing`. Preserve conversation history across reconnect, discard in-flight turn.
**Topics**: sdk-state-machine, error-ux

## R3: MockSTT Limitations Block Continuous Mode Testing
**Impact**: Can't test partial transcript relay, mid-stream drops, or timing-dependent scenarios.
**Current state**: MockSTTProvider pre-loads events, can't emit imperatively. No MockLLMProvider exists (tests use generic `createMockStream`).
**Mitigation**: Enhanced MockSTTProvider with async queue + `emitEvent()`. New MockLLMProvider. AsyncQueue primitive as shared building block for all enhanced mocks.
**Topics**: testing-strategy, gateway-pipeline

## R4: Dead Protocol Code Creates False Confidence
**Impact**: `session.start`, `transcript.partial` appear functional in schema but are unused. Developers may assume they work.
**Current state**: 5 dead/unused message types: `session.start` (no handler), `transcript.partial` (never sent), `session.expired` (no lifetime tracking), `tool.confirm_request`/`tool.confirm` (no tool flow), `guest.auth` (not handled).
**Mitigation**: Activate `transcript.partial` and `session.start` as part of redesign. Remove or clearly mark remaining dead types.
**Topics**: sdk-gateway-contract, codec-negotiation

## R5: Error Code Inconsistency
**Impact**: Client can't reliably categorize errors for UX. Error classifier depends on stable error codes.
**Current state**: `ERROR_TYPES` defines 6 codes but `voice-handlers.ts` sends `"stt_error"` (not in enum). `ws-helpers.ts:sendError()` bypasses Zod validation. Error code field is `z.string()`, not validated against enum.
**Mitigation**: Validate error messages against schema before sending. Expand `ERROR_TYPES` to cover all provider errors. Gateway enforces enum, not free-form strings.
**Topics**: error-ux, sdk-gateway-contract

## R6: Processing State Hang — No Timeout
**Impact**: User stares at nothing indefinitely if gateway never responds.
**Current state**: Between `audio.end` and first `response.text.delta`, client has no timeout. If LLM hangs (`openrouter.ts:30-47` has no timeout), `readNextFinalTranscript()` also has no timeout. Two unbounded waits in sequence.
**Mitigation**: State machine `processing` state has 30s timeout. Gateway-side LLM stream must have its own timeout. Staged "thinking" indicators (2s/5s/15s/30s) keep user informed during wait.
**Topics**: sdk-state-machine, error-ux, gateway-pipeline

## R7: RPi5 Performance Budget
**Impact**: Target platform (RPi5 Chromium) has limited CPU budget. Silero VAD uses 31-47% of real-time budget per frame.
**Current state**: No performance profiling. Energy-based VAD is <0.1% budget. Silero is marginal on RPi5.
**Mitigation**: Ship energy-based VAD as default. Silero as opt-in only. Linear resampling is O(n) with tiny constant — needs benchmarking on RPi5. Pipeline stages add ~6 microtask hops per frame — negligible.
**Topics**: client-vad, codec-negotiation, gateway-pipeline

## R8: Barge-In Echo Loop
**Impact**: Bad echo cancellation causes VAD to trigger on assistant's own audio, creating infinite barge-in loop.
**Current state**: Browser `echoCancellation: true` varies by device. No barge-in debounce or cooldown.
**Mitigation**: State machine guard: after barge-in, require 300ms of confirmed speech before another. Cooldown after failed barge-in (1s). Mode switching to PTT if VAD false-trigger rate is high.
**Topics**: client-vad, sdk-state-machine

## R9: Abort vs Error Distinction
**Impact**: Barge-in abort could surface as error to user.
**Current state**: `voice-handlers.ts:50` correctly checks `signal.aborted` before sending error, but only in one location. Other error handlers don't distinguish abort from failure.
**Mitigation**: Every error handler in the pipeline must check `signal.aborted` before surfacing error. Deferred error propagation pattern (streaming-overlap.ts) already handles this well — preserve and extend.
**Topics**: error-ux, gateway-pipeline

## R10: Binary Audio Has No Framing
**Impact**: If encoding/rate changes mid-stream (future Opus support), receiver can't detect it.
**Current state**: Both directions send raw PCM with no header. Format implicit from session handshake.
**Mitigation**: For v1, session handshake establishes format — no per-frame metadata needed. For v2 (Opus), extend `response.audio.start` with `{ encoding, sampleRate }` metadata. No binary framing header unless mid-stream codec switching is needed.
**Topics**: codec-negotiation, sdk-gateway-contract

## R11: Type Safety Bypass in Test Infrastructure
**Impact**: Tests pass against phantom interfaces — contract drift between mocks and real providers goes undetected.
**Current state**: `as unknown as` casts in tests bypass TypeScript type checking. Mock providers can diverge from real provider interfaces without compiler errors. Most dangerous gap found in testing-strategy presence analysis.
**Mitigation**: Remove all `as unknown as` casts. Mocks must implement real provider interfaces. Add conformance suites (from protocol-contract-generative alternative) that verify mock behavior matches recorded real provider sessions.
**Topics**: testing-strategy, gateway-pipeline

## R12: Turn-Envelope vs Utterance-Lifecycle Protocol Decision
**Impact**: Protocol choice affects multi-turn overlap, tool calling, and testing ergonomics.
**Current state**: Primary approach uses `utteranceId + responseId` correlation. Alternative (turn-envelope) uses single `turnId` with sequence numbers. Turn-envelope dramatically improves test isolation (2→7) but blocks multi-turn overlap and may break for tool calls mid-response.
**Mitigation**: Evaluate tool-calling requirements before committing. If tool calls are v2+, turn-envelope is safer for v1. If tool calls are v1, utterance-lifecycle is required.
**Topics**: sdk-gateway-contract, gateway-pipeline, testing-strategy

## R13: Hybrid Approach Complexity
**Impact**: Combining primary + alternative approaches adds integration complexity.
**Current state**: 5 of 7 topics have recommended hybrid approaches (e.g., async generators + frame processors, classifier + reactive policies). Each hybrid needs clear boundary definition.
**Mitigation**: Implement primary approach in v1. Add alternative components only when concrete need arises (e.g., add reactive policies when temporal error correlation is needed, not speculatively). Use the hybrid as a migration path, not a day-1 requirement.
**Topics**: all

## R14: 7-Second Silent Gap in Worst-Case Pipeline
**Impact**: User stares at nothing for 7 seconds in worst case (3s connection + 2s STT + 2s LLM).
**Current state**: Presence gap analysis found sequential silent waits with no intermediate feedback. Only 1 timeout exists in entire current pipeline (sentence aggregator 2s flush).
**Mitigation**: State machine `processing` state emits staged indicators (2s/5s/15s/30s). Gateway emits `status.processing` immediately after `utterance.end`. Provider connection parallelized (STT+TTS connect simultaneously). Every async read has timeout guard.
**Topics**: gateway-pipeline, sdk-state-machine, error-ux
