# SDK State Machine — Complete States & Transitions

## Current State

The web client has **multiple ad-hoc state machines** that are not formalized:
- `web/src/types.ts:4` — `ConnectionState = "disconnected" | "connecting" | "authenticating" | "connected" | "reconnecting"`
- `web/src/types.ts:7` — `TalkState = "idle" | "recording" | "processing"`
- `web/src/types.ts:25` — `PlaybackState = "idle" | "playing" | "barge-in"`
- `web/src/types.ts:19-22` — `AuthState` — union type with `pending | authenticated | failed`

These are **independent Preact signals**, not a unified state machine. Transitions are implicit in callback logic spread across 4 hooks + app.tsx.

### Gateway-Side Implicit State
`voice-session.ts` has closure-scoped booleans (`isClosed`, `sttConnected`, `ttsConnected`) and nullable AbortControllers — an informal state machine without explicit states. `BargeInController` exists but is **unused** in current flow.

### Key Problems

1. **No single source of truth.** 4 independent signals with 4×3×3×3 = 108 possible combinations, most invalid. No enforcement of valid combinations.
2. **No formal transition table.** State changes scattered across `use-websocket.ts` callbacks, `use-audio-capture.ts`, `use-audio-playback.ts`, and `app.tsx:60-69`.
3. **No timeout guards on waiting states.** `processing` state (after `audio.end`, awaiting response) has no timeout — if gateway never responds, client hangs forever.
4. **No error recovery model.** Connection drop during recording → audio buffered in worklet but no flush/discard path.
5. **Barge-in orchestration leaks into app.tsx.** `handleToggleTalk` sends `barge_in` + clears playback + starts capture — three side effects in one callback.
6. **Gateway BargeInController unused.** Well-designed component exists (`barge-in-controller.ts`) but `voice-session.ts` uses raw `activeTurnController?.abort()` instead.
7. **No guards against impossible transitions.** Nothing prevents `audio.end` being sent when not recording, or `barge_in` when not in assistant-speaking.

## Proposed Unified State Machine

### States

```
inactive           — SDK created, not connected
connecting         — WebSocket opening + authenticating
listening          — Connected, VAD active or ready for PTT press
user-speaking      — Speech detected/button pressed, audio streaming to gateway
processing         — audio.end sent, awaiting transcript + response
assistant-speaking — Receiving and playing TTS audio from gateway
interrupting       — User barged in, awaiting barge_in.ack before resuming mic
reconnecting       — Connection lost, auto-reconnecting with backoff
error              — Unrecoverable error requiring user action
```

### Why These States

- **`inactive`** — Clean separation of "SDK exists" vs "SDK is active". Allows pre-configuration before connecting.
- **`connecting`** — Collapses WS open + auth into one opaque state. User sees "Connecting..." not two different spinners.
- **`listening`** — The steady state. User sees "Listening..." indicator. VAD is active. This is where the pipeline spends most time.
- **`user-speaking`** — Audio is actively flowing to gateway. User sees mic animation/waveform. Separate from listening because side effects differ (audio.start sent, audio streaming).
- **`processing`** — Critical "thinking..." state. Gateway has received audio, client awaits transcript + response. Must have timeout guard — this is where the current system can hang.
- **`assistant-speaking`** — TTS audio is being played. User sees "Speaking..." indicator. Barge-in is allowed from this state.
- **`interrupting`** — Transient state between barge-in trigger and ack. Needed because: (a) playback must stop immediately, (b) but new audio shouldn't stream until gateway confirms abort. Without this state, there's a race where client sends new audio while gateway is still streaming old response.
- **`reconnecting`** — Separate from `connecting` because recovery semantics differ: buffered audio may exist, previous conversation context persists, UI shows "Reconnecting..." not "Connecting..."
- **`error`** — Terminal-ish state. Some errors auto-recover (via `reconnecting`), others require explicit user action (auth failure, session limit).

### Formal Transition Table

```
(state,                 event)              → new_state         [side effects]

(inactive,              CONNECT)            → connecting         [open WS, send auth]
(connecting,            AUTH_OK)            → listening           [emit connected, start VAD]
(connecting,            AUTH_FAILED)        → error              [emit error: auth failed]
(connecting,            TIMEOUT)            → error              [emit error: connection timeout]
(connecting,            WS_CLOSE)           → reconnecting       [start backoff timer]
(listening,             SPEECH_START)       → user-speaking       [send utterance.start, stream audio]
(listening,             DISCONNECT)         → inactive           [cleanup]
(listening,             WS_DROP)            → reconnecting        [pause VAD]
(user-speaking,         SPEECH_END)         → processing          [send utterance.end, show "Thinking..."]
(user-speaking,         WS_DROP)            → reconnecting        [buffer unsent audio]
(user-speaking,         CANCEL)             → listening           [send utterance.cancel, discard audio]
(processing,            TRANSCRIPT_PARTIAL) → processing          [update UI with partial transcript]
(processing,            TRANSCRIPT_FINAL)   → processing          [update UI with final transcript]
(processing,            RESPONSE_START)     → assistant-speaking  [begin playback, show "Speaking..."]
(processing,            TIMEOUT)            → error              [emit timeout error, recovery: retry or dismiss]
(processing,            WS_DROP)            → reconnecting        [mark in-flight turn as lost]
(processing,            SPEECH_START)       → processing          [ignore — response in flight, Option B]
(assistant-speaking,    AUDIO_DONE)         → listening           [stop playback, resume VAD]
(assistant-speaking,    SPEECH_START)       → interrupting        [stop playback, send barge_in]
(assistant-speaking,    WS_DROP)            → reconnecting        [stop playback]
(assistant-speaking,    RESPONSE_TEXT_DONE) → assistant-speaking  [internal: text stream complete]
(interrupting,          BARGE_IN_ACK)       → user-speaking       [begin streaming new audio]
(interrupting,          TIMEOUT)            → listening           [fallback: assume ack lost, resume]
(interrupting,          WS_DROP)            → reconnecting        []
(reconnecting,          RECONNECTED)        → listening           [flush context, resume VAD]
(reconnecting,          MAX_RETRIES)        → error              [emit error: connection lost]
(error,                 RETRY)              → connecting          [fresh connection attempt]
(error,                 DISMISS)            → inactive            [full cleanup]
(*,                     SESSION_END)        → inactive            [full cleanup]
```

### Invalid Transitions (Must Be Rejected)

The state machine must be strict — any event not in the transition table for the current state is **ignored with a warning log**, not silently swallowed:

- `SPEECH_END` when not `user-speaking` → log warning, ignore
- `BARGE_IN_ACK` when not `interrupting` → log warning, ignore
- `AUDIO_DONE` when not `assistant-speaking` → log warning, ignore
- `CONNECT` when not `inactive` → ignore (idempotent)

## Pure Function Design

### Core Transition Function

```typescript
type VoiceState =
  | "inactive"
  | "connecting"
  | "listening"
  | "user-speaking"
  | "processing"
  | "assistant-speaking"
  | "interrupting"
  | "reconnecting"
  | "error";

type VoiceEvent =
  | { type: "CONNECT" }
  | { type: "AUTH_OK"; sessionId: string }
  | { type: "AUTH_FAILED"; reason: string }
  | { type: "TIMEOUT"; context: string }
  | { type: "SPEECH_START" }
  | { type: "SPEECH_END" }
  | { type: "CANCEL" }
  | { type: "TRANSCRIPT_PARTIAL"; text: string }
  | { type: "TRANSCRIPT_FINAL"; text: string }
  | { type: "RESPONSE_START" }
  | { type: "AUDIO_DONE" }
  | { type: "RESPONSE_TEXT_DONE" }
  | { type: "BARGE_IN_ACK" }
  | { type: "WS_CLOSE" }
  | { type: "WS_DROP" }
  | { type: "RECONNECTED" }
  | { type: "MAX_RETRIES" }
  | { type: "RETRY" }
  | { type: "DISMISS" }
  | { type: "DISCONNECT" }
  | { type: "SESSION_END" };

interface TransitionResult {
  state: VoiceState;
  effects: SideEffect[];
}

type SideEffect =
  | { type: "OPEN_WS"; url: string }
  | { type: "SEND_AUTH"; token: string }
  | { type: "SEND_UTTERANCE_START" }
  | { type: "SEND_UTTERANCE_END" }
  | { type: "SEND_UTTERANCE_CANCEL" }
  | { type: "SEND_BARGE_IN" }
  | { type: "START_VAD" }
  | { type: "STOP_VAD" }
  | { type: "START_AUDIO_STREAM" }
  | { type: "STOP_AUDIO_STREAM" }
  | { type: "START_PLAYBACK" }
  | { type: "STOP_PLAYBACK" }
  | { type: "CLEAR_PLAYBACK" }
  | { type: "START_TIMEOUT"; key: string; ms: number }
  | { type: "CANCEL_TIMEOUT"; key: string }
  | { type: "START_RECONNECT_BACKOFF" }
  | { type: "CLEANUP" }
  | { type: "EMIT_STATE_CHANGE"; from: VoiceState; to: VoiceState }
  | { type: "LOG_WARNING"; message: string };

function transition(state: VoiceState, event: VoiceEvent): TransitionResult {
  // Pure function — no I/O, no side effects
  // Returns new state + declarative side effects
  // Caller is responsible for executing effects
}
```

### Why Pure Function + Effects Pattern

1. **Testable.** `assert.equal(transition("listening", { type: "SPEECH_START" }).state, "user-speaking")` — no mocks needed.
2. **Portable.** Same state machine works in Preact (web), React Native (mobile), Node (testing). Only the effect executor differs per platform.
3. **Debuggable.** Log every `(state, event) → (newState, effects)` triple. Full state history for replay.
4. **No race conditions in state logic.** All state mutations are synchronous. Async behavior is in the effect executor, not the state machine.

### Effect Execution Layer

```typescript
class VoiceStateMachine {
  private state: VoiceState = "inactive";
  private effectExecutor: EffectExecutor;
  private listeners: Set<(state: VoiceState) => void>;

  dispatch(event: VoiceEvent): void {
    const result = transition(this.state, event);
    const prev = this.state;
    this.state = result.state;

    // Execute side effects
    for (const effect of result.effects) {
      this.effectExecutor.execute(effect);
    }

    // Notify observers
    if (prev !== this.state) {
      for (const listener of this.listeners) {
        listener(this.state);
      }
    }
  }
}
```

The `EffectExecutor` is platform-specific:
- **Web:** Uses WebSocket, AudioWorklet, AudioContext
- **React Native:** Uses native audio APIs
- **Test:** Records effects for assertion

## Timeout Guards

Every waiting state must have a timeout to prevent indefinite hangs:

| State | Timeout | Value | Recovery |
|-------|---------|-------|----------|
| `connecting` | AUTH_TIMEOUT | 10s | → `error` (matches current `AUTH_TIMEOUT_MS`) |
| `processing` | RESPONSE_TIMEOUT | 30s | → `error` with "sorry, still thinking..." then retry option |
| `interrupting` | BARGE_IN_ACK_TIMEOUT | 3s | → `listening` (assume ack lost, safe fallback) |
| `reconnecting` | per-attempt | exponential backoff 1s→30s | → `error` after max retries (5) |

Timeouts are modeled as side effects: `{ type: "START_TIMEOUT", key: "processing", ms: 30000 }`. When the timer fires, it dispatches `{ type: "TIMEOUT", context: "processing" }` into the state machine. The transition function handles it based on current state.

**Timeout cancellation:** Every transition out of a timed state includes `{ type: "CANCEL_TIMEOUT", key }` in its effects. This prevents stale timeouts from firing after the state has moved on.

## Barge-In — Detailed Flow

### Current Problems
1. Barge-in logic is in `app.tsx` — sends message, clears playback, starts capture in one callback
2. `voice-session.ts:bargeIn()` just does `activeTurnController?.abort()` — no state tracking
3. `BargeInController` exists with proper lifecycle but is unused
4. No guard against barge-in during non-speaking states
5. No debounce — rapid barge-in during echo could loop

### Proposed Barge-In Flow

```
State: assistant-speaking
  User speaks (VAD speech_start or PTT press)
  → dispatch(SPEECH_START)
  → transition: assistant-speaking → interrupting
  → effects: [STOP_PLAYBACK, CLEAR_PLAYBACK, SEND_BARGE_IN, START_TIMEOUT("barge_in_ack", 3000)]

State: interrupting
  Gateway sends barge_in.ack
  → dispatch(BARGE_IN_ACK)
  → transition: interrupting → user-speaking
  → effects: [CANCEL_TIMEOUT("barge_in_ack"), SEND_UTTERANCE_START, START_AUDIO_STREAM]

State: interrupting (timeout — ack never arrived)
  Timer fires
  → dispatch(TIMEOUT, "barge_in_ack")
  → transition: interrupting → listening
  → effects: [LOG_WARNING("barge_in ack timeout"), STOP_AUDIO_STREAM]
```

### Barge-In Guards

1. **Minimum speech duration.** After barge-in completes, require 300ms of confirmed speech before allowing another barge-in. Prevents echo-triggered barge-in loops.
   - Implemented as: `SPEECH_START` during `assistant-speaking` checks `timeSinceLastBargeIn > 300ms` before transitioning. Otherwise ignored.

2. **State guard.** `SPEECH_START` only triggers barge-in from `assistant-speaking`. From other states it has different semantics (start new utterance from `listening`, ignore from `processing`).

3. **Cooldown after error.** If barge-in fails (timeout), add 1s cooldown before next barge-in attempt.

## Double Utterance Handling

User finishes one sentence, starts another before response arrives:

```
listening → user-speaking → processing → [user speaks again]
```

### Options Analysis

| Option | Behavior | Complexity | UX | Risk |
|--------|----------|------------|-----|------|
| A: Queue | Buffer second utterance, process after first response | High — need utterance queue, ordering guarantees | Best — both utterances handled | Queue management, memory pressure |
| B: Ignore | Ignore SPEECH_START during processing | Minimal | Acceptable — user re-speaks after response | User frustration if they think they were heard |
| C: Cancel + restart | Abort processing, start new turn with combined context | Medium — need abort + restart logic | Mixed — first response lost | Context loss, wasted compute |
| D: Append | Keep processing, append new audio to same turn | Medium — need STT re-open or persistent stream | Good — natural continuation | Complicates turn boundaries |

### Recommendation: Option B for v1, Option D for v2

**v1:** `processing` state ignores `SPEECH_START`. Simple, predictable, safe. User quickly learns the pattern: wait for response, then speak again.

**v2:** With continuous STT connection, second utterance can be appended to the turn context. Gateway accumulates transcripts. This requires `gateway-pipeline` redesign (ContinuousSession) which is a separate topic.

The transition table above implements Option B: `(processing, SPEECH_START) → processing [ignore]`.

## Reconnection — State Preservation

### What to Preserve Across Reconnect
- Conversation history (already in memory)
- Current UI state (messages displayed)
- VAD configuration (mode, thresholds)
- Audio context (already initialized)

### What to Discard
- In-flight turn (if `processing`, the turn is lost — notify user)
- Early audio buffer (pre-connection audio is stale after reconnect)
- STT/TTS connections (gateway-side, re-established on next turn)

### Reconnection Flow

```
State: any-active-state
  WS connection drops
  → dispatch(WS_DROP)
  → transition: * → reconnecting
  → effects: [STOP_VAD, STOP_AUDIO_STREAM, STOP_PLAYBACK, START_RECONNECT_BACKOFF]

State: reconnecting
  WS reconnects + re-authenticates
  → dispatch(RECONNECTED)
  → transition: reconnecting → listening
  → effects: [START_VAD, EMIT_STATE_CHANGE]

State: reconnecting
  Max retries exhausted
  → dispatch(MAX_RETRIES)
  → transition: reconnecting → error
  → effects: [EMIT_STATE_CHANGE]
```

**User experience during reconnect:** "Reconnecting..." indicator. If reconnect succeeds, seamless return to listening. If it fails, "Connection lost — tap to retry" with explicit retry button.

**Lost turn notification:** If `WS_DROP` occurs during `processing`, the effect executor should add a system message: "Sorry, I lost track of what you said. Could you repeat that?"

## Error Classification & Recovery

### Error Types Mapped to States

| Error | From State | To State | User Message | Recovery |
|-------|-----------|----------|--------------|----------|
| Auth failed | `connecting` | `error` | "Couldn't sign in" | RETRY → connecting |
| Auth timeout | `connecting` | `error` | "Connection timed out" | RETRY → connecting |
| Session limit | `connecting` | `error` | "Too many sessions" | DISMISS → inactive |
| Response timeout | `processing` | `error` | "Sorry, still thinking..." | RETRY → connecting (new session) |
| Provider error (STT) | `user-speaking` | `error` | "Didn't catch that" | RETRY → listening |
| Provider error (LLM) | `processing` | `error` | "Having trouble thinking" | RETRY → listening |
| Provider error (TTS) | `assistant-speaking` | `listening` | Show text, skip audio | Auto-recover |
| WS drop | any active | `reconnecting` | "Reconnecting..." | Auto-recover |
| Max retries | `reconnecting` | `error` | "Connection lost" | RETRY → connecting |

### Auto-Recovery vs User Action

- **Auto-recover:** WS drop (reconnect), TTS failure (show text instead), transient provider errors
- **User action required:** Auth failure, session limit, persistent connection loss, response timeout

## Interaction with Other Topics

### → client-vad
VAD produces `SPEECH_START`/`SPEECH_END` events that feed into this state machine. The state machine never calls VAD directly — it only consumes events. VAD mode vs PTT mode simply changes the *source* of these events, not the state machine logic.

### → sdk-gateway-contract
The state machine's side effects (`SEND_UTTERANCE_START`, `SEND_UTTERANCE_END`, `SEND_BARGE_IN`) map to protocol messages. The contract defines the exact wire format; the state machine defines *when* they're sent.

### → gateway-pipeline
Gateway has its own internal state (ContinuousSession). The SDK state machine and gateway state are **independent** — connected only by protocol messages. SDK doesn't know about STT/TTS/LLM stages. Gateway doesn't know about VAD/playback/UI states.

### → error-ux
The state machine emits `EMIT_STATE_CHANGE` effects. The UI layer maps states to user-visible indicators:
- `listening` → "Listening..." with pulse animation
- `user-speaking` → mic waveform animation
- `processing` → "Thinking..." spinner
- `assistant-speaking` → "Speaking..." with audio visualizer
- `reconnecting` → "Reconnecting..." banner
- `error` → error card with retry/dismiss buttons

### → codec-negotiation
Codec negotiation happens during `connecting` → `listening` transition. The `AUTH_OK` event could carry negotiated codec info. State machine doesn't care about codec details — that's the audio subsystem's concern.

## Testing Strategy

### Property-Based Tests
- **No dead states:** From every state, there exists at least one event leading to another state.
- **No stuck states:** `error` has `RETRY`/`DISMISS`. `reconnecting` has `RECONNECTED`/`MAX_RETRIES`. Every waiting state has a timeout.
- **Deterministic:** Same `(state, event)` always produces same `(newState, effects)`.
- **Valid effects:** Effects emitted in a transition are appropriate for the state change (e.g., `STOP_PLAYBACK` only emitted when leaving `assistant-speaking` or `interrupting`).

### Scenario Tests
- **Happy path:** inactive → connecting → listening → user-speaking → processing → assistant-speaking → listening
- **Barge-in:** assistant-speaking → interrupting → user-speaking → processing → ...
- **Reconnect during processing:** processing → reconnecting → listening (with "lost turn" notification)
- **Double timeout:** processing timeout → error → retry → connecting → auth timeout → error
- **Rapid barge-in:** assistant-speaking → interrupting → user-speaking → processing → assistant-speaking → interrupting (tests cooldown guard)
- **WS drop during barge-in:** interrupting → reconnecting → listening

### Effect Assertion Pattern
```typescript
const result = transition("assistant-speaking", { type: "SPEECH_START" });
assert.equal(result.state, "interrupting");
assert.deepInclude(result.effects, { type: "STOP_PLAYBACK" });
assert.deepInclude(result.effects, { type: "CLEAR_PLAYBACK" });
assert.deepInclude(result.effects, { type: "SEND_BARGE_IN" });
```

## Implementation Considerations

### State Machine as Shared Module
The state machine should live in `shared/` (not `web/` or `gateway/`):
- Same state machine can drive web client, mobile clients, and test harnesses
- Only the `EffectExecutor` is platform-specific
- Protocol message schemas also in `shared/` — natural pairing

### Gradual Migration Path
1. Implement `transition()` as pure function in `shared/sdk/state-machine.ts`
2. Create `VoiceStateMachine` wrapper with effect execution
3. In web client, wire `VoiceStateMachine` to replace the 4 separate signals
4. Hooks become thin adapters: `useVoiceState()` returns current state + dispatch function
5. `app.tsx` becomes trivially simple: render based on state, dispatch events on user action

### Bundle Size Impact
The state machine is pure TypeScript — no dependencies. The transition function and type definitions add <2KB minified. The effect executor for web reuses existing WebSocket/AudioWorklet code.

## Open Questions

1. **Should the state machine track sub-states?** E.g., `processing` could have sub-states: `awaiting-transcript`, `awaiting-response-start`, `streaming-response`. This adds precision but complexity. Recommendation: flat states for v1, sub-states if needed for debugging.

2. **Should the gateway have its own state machine?** Currently gateway state is implicit in closures. A formal gateway state machine would improve debuggability but adds complexity. The gateway is more event-driven (handles messages as they arrive) vs the client which has clear UX states.

3. **Event ordering guarantees.** If two events arrive in the same tick (e.g., `TRANSCRIPT_FINAL` + `RESPONSE_START`), processing order matters. The dispatch function must be synchronous and non-reentrant to prevent ordering issues.

4. **State persistence across page reload.** Should the SDK persist state to sessionStorage for seamless reload? Would require re-establishing WS and resuming conversation. Complex but good UX.
