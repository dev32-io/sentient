# Cross-Topic Connections

## C1: State Machine ↔ Error UX
The state machine defines *what states exist*. Error UX defines *how errors map to states*.
Every error category from `error-ux` must have a corresponding state transition in `sdk-state-machine`.
Both topics must agree on: which errors auto-recover (stay in pipeline) vs require user action (go to error state).
**Specific link**: Error classifier's 6 categories map to state transitions: `connection_lost → reconnecting`, `didnt_catch → listening`, `thinking_timeout → error`, `service_unavailable → error`, `auth_required → inactive`, `try_again → listening`.
**Specific link**: Staged processing timer (2s/5s/15s/30s) operates within the `processing` state — the TIMEOUT event at 30s triggers `processing → error`.

## C2: Client VAD ↔ SDK-Gateway Contract
VAD produces `speech.start` / `speech.end` events client-side. These feed the state machine, which emits `SEND_UTTERANCE_START` / `SEND_UTTERANCE_END` effects that map to protocol messages.
VAD and toggle-to-talk modes produce identical downstream protocol — gateway is mode-agnostic.
**Specific link**: `utterance.start { utteranceId }` is sent when state machine transitions `listening → user-speaking`. The `utteranceId` is generated at this point and threads through the entire turn lifecycle.

## C3: SDK-Gateway Contract ↔ Gateway Pipeline
The contract defines what messages flow over the wire. The pipeline defines how those messages are processed internally.
**Specific link**: `utterance.start`/`utterance.end` from client maps to FlowManager's `handleUtteranceStart()`/`handleUtteranceEnd()`, which control STT stage lifecycle.
**Specific link**: `transcript.partial` (currently dead) must flow from STT stage → FlowManager → WS → client. This requires removing the `isFinal: true` filter in `readNextFinalTranscript()`.
**Specific link**: New `response.start { utteranceId, responseId }` provides explicit "thinking" signal. FlowManager emits this before starting LLM stage.

## C4: Codec Negotiation ↔ SDK-Gateway Contract
Codec negotiation is a sub-protocol within the session handshake. `session.configure` (from contract) carries encoding preferences. `session.ready` (from contract) confirms negotiated format.
**Specific link**: `response.audio.start` extended with `{ encoding, sampleRate }` so client knows format before first audio byte.
**Specific link**: Backward compatibility: if no `session.configure` received before `utterance.start`, gateway assumes PCM16/48kHz — matches current behavior.

## C5: Gateway Pipeline ↔ Testing Strategy
The composable stage architecture directly enables isolation testing. Each stage `(AsyncIterable<In>, StageContext) → AsyncGenerator<Out>` is independently testable with mock input/output.
**Specific link**: Enhanced MockSTTProvider with async queue enables testing ContinuousSession's partial transcript relay — the pipeline integration test's most important scenario.
**Specific link**: FlowManager's `handleBargeIn()` tested via imperative mock: emit partial transcript → trigger barge-in → assert AbortSignal propagation through all stages.

## C6: State Machine ↔ Client VAD
The state machine must handle VAD-specific transitions (auto speech detection) differently from toggle transitions (user-initiated).
In VAD mode: `listening → user-speaking` is automatic (VAD `SPEECH_START`). In toggle mode: `listening → user-speaking` requires user action (button `SPEECH_START`).
Both converge at `processing` state. The state machine doesn't know or care about the source.
**Specific link**: Barge-in guard — VAD `SPEECH_START` during `assistant-speaking` requires 300ms confirmed speech before transitioning to `interrupting`. Prevents echo-triggered loops.

## C7: Error UX ↔ Testing Strategy
Every error category needs test coverage. The mapping from technical errors to user-facing categories is a pure function — ideal for unit testing.
**Specific link**: Edge case tests (STT drop, TTS drop, timeout) validate that error recovery flows work correctly. Each test asserts: error event sent, connection cleaned up, turn aborted, pipeline ready for next turn.
**Specific link**: State machine property-based tests (fast-check) verify no dead states and all error states have exit paths.

## C8: Codec Negotiation ↔ Gateway Pipeline
Audio middleware (resampling) sits between WS audio forwarding and provider stages.
**Specific link**: Inbound resampler (client rate → 16kHz for STT) is a pipeline stage before STT stage. Outbound resampler (TTS rate → client rate) is a pipeline stage after TTS stage.
**Specific link**: FlowManager stores negotiated format from `session.configure` and passes to resampling stages via `StageContext.config`.

## C9: Client VAD ↔ Codec Negotiation
VAD operates on raw PCM *before* encoding. Codec choice (PCM16 vs Opus) doesn't affect VAD.
**Specific link**: Audio pipeline order is: Mic → Worklet (PCM) → VAD (on PCM) → Encoder (if Opus) → WebSocket. VAD is always pre-encoding.
**Specific link**: Sample rate matters: VAD frame size depends on capture rate (512 samples @ 48kHz = 10.6ms). If capture rate changes via negotiation, VAD timing parameters adjust.

## C10: Error UX ↔ Codec Negotiation
Negotiation failure must surface as friendly error.
**Specific link**: If `session.configure` requests unsupported encoding, gateway sends `error { code: "unsupported_config", recoverable: true }`. Error classifier maps to `try_again` category with message "Audio format not supported, trying default..." SDK falls back to PCM16.

## C11: State Machine ↔ Codec Negotiation
Codec negotiation happens during `connecting → listening` transition.
**Specific link**: `session.configure` sent after `AUTH_OK` event. `session.ready` triggers final transition to `listening`. If negotiation fails, `TIMEOUT` or error transitions to `error` state.

## C12: Alternative Approaches — Cross-Topic Hybrids
Several alternative approaches reinforce each other:
- **Turn-envelope (contract) + property-based testing (testing)**: Sequence numbers enable deterministic replay testing. If turn-envelope is adopted, property-based conformance suites become much simpler.
- **Capability-profiles (codec) + turn-envelope (contract)**: Profile selection is a single field in the turn envelope header, eliminating per-field negotiation complexity.
- **Reactive error policies (error-ux) + statechart (state-machine)**: Hierarchical states with entry/exit actions pair naturally with reactive streams for error propagation. Both alternatives pull toward event-stream architecture.
- **Frame-processor (pipeline) + enhanced mocks (testing)**: Push-based frames are easier to inject imperatively than async generators, improving test ergonomics for failure injection scenarios.

## C13: Presence Gap → State Machine Feedback Loop
Presence gap analyses (gateway-pipeline, codec-negotiation, testing-strategy) all feed back into the state machine design:
- Every identified silence gap maps to a missing state transition or indicator effect
- The 7-second worst-case gap requires the state machine to emit intermediate indicators during `processing`
- Codec corruption gaps require the state machine to handle `CODEC_ERROR` events with user-visible "Audio issue, reconnecting..." messages
- Test infrastructure gaps require the test harness state machine to emit `STALL_WARNING` after 2s of no progress

## Dependency Order (Validated by Exploration)

```
                    ┌─────────────────┐
                    │ sdk-state-machine │  ← foundational
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
                    │sdk-gateway-contract│  ← wire protocol
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
                    │ gateway-pipeline │  ← server implementation
                    └────────┬────────┘
                             │
              ┌──────────────┼──────────────┐
              │                              │
     ┌────────▼────────┐           ┌────────▼────────┐
     │   client-vad    │           │codec-negotiation │  ← parallel
     └─────────────────┘           └─────────────────┘
                             │
                    ┌────────▼────────┐
                    │    error-ux     │  ← depends on state machine + contract
                    └─────────────────┘
                             │
                    ┌────────▼────────┐
                    │testing-strategy │  ← cross-cutting, evolves with all
                    └─────────────────┘
```
