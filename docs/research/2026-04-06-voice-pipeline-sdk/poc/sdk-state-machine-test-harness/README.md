# SDK State Machine — Isolation Test Harness

PoC testing the pure `transition()` function and `VoiceClient` wrapper
with zero external dependencies (no network, no audio, no DOM).

## What This Tests

### 1. Pure Transition Function (`transition()`)
- **Per-state valid transitions**: every handled (state, event) pair produces correct new state + effects
- **Happy path**: full voice turn cycle (connect → speak → process → respond → listen)
- **Timeout guards**: every waiting state (connecting, processing, interrupting) has a timeout that fires
- **Timeout cleanup**: leaving a timed state always cancels its timer
- **WS_DROP resilience**: all 6 active states handle connection loss → reconnecting
- **No dead states**: every state has at least one exit transition
- **Determinism**: same (state, event) always produces identical output
- **Unhandled events**: produce LOG_WARNING, no state change
- **SESSION_END**: global escape hatch from any state

### 2. Multi-Step Scenarios (sequence walks)
- Double turn (two full speak→response cycles)
- Barge-in flow (interrupt → ack → new turn)
- Barge-in timeout (graceful fallback to listening)
- Cancel mid-utterance
- Reconnect recovery (WS drop → reconnect → resume)
- Max retries → error → retry → success
- Processing timeout → error → retry → full turn
- Partial transcripts during processing

### 3. VoiceClient Wrapper
- Initial state correctness
- Status labels for all 9 states
- `canSpeak` flag (true only in listening + assistant-speaking)
- `isActive` flag (false only in inactive + error)
- Effect dispatch ordering
- Listener notification on state change only
- Unsubscribe works
- Transcript tracking (partial + final)
- Error tracking (auth failed, timeout, max retries) + error clearing
- Convenience methods (connect, disconnect, retry, dismiss)

### 4. Reachability
- Every state reachable from inactive via a known event sequence

### 5. Exhaustive Matrix
- Every (state × event) pair produces a valid result
- 9 states × 22 events = 198 combinations verified

## Run

```bash
cd /workspace/poc/sdk-state-machine-test-harness
bun test
```

## Key Design Decision: No Mocks Needed

The state machine is a **pure function**: `(state, event) → { state, effects }`.
No mocks, stubs, or fakes required — just call the function with inputs and assert outputs.
This is the ideal testing surface: zero setup, instant execution, fully deterministic.
