# SDK State Machine Alternative: Hierarchical Statechart with Reactive Event Streams

## Approach Summary

**Replace the flat reducer with a hierarchical statechart that models compound states and parallel regions.** Instead of a single `(state, event) → (state, effects)` function with 9 top-level states, use a statechart where related states are nested (e.g., `active.listening`, `active.user-speaking`, `active.processing`) and cross-cutting concerns (connection status, audio routing) run as parallel regions.

The runtime uses **reactive event streams** (observable-like pattern) instead of imperative `dispatch()`. Events flow through a typed event bus; the statechart subscribes to relevant events and emits state changes + effects as a stream. Side effects are executed by subscribers, not inline.

**Name: `statechart-reactive`**

## Architecture

### Hierarchical State Structure

```
voice
├── inactive
├── connecting
├── active                     ← compound state
│   ├── listening
│   ├── user-speaking
│   ├── processing
│   ├── assistant-speaking
│   └── interrupting
├── reconnecting
└── error
```

**Why hierarchy matters:** The current flat reducer has `WS_DROP` handling duplicated across 5 states (listening, user-speaking, processing, assistant-speaking, interrupting). In a statechart, `WS_DROP` is handled once at the `active` compound state level — any child state transitions to `reconnecting`. This eliminates ~15 lines of duplicated transition logic.

### Parallel Regions (Orthogonal States)

```
voice [parallel]
├── connection              ← region 1: transport lifecycle
│   ├── disconnected
│   ├── ws-opening
│   ├── authenticating
│   └── established
├── pipeline                ← region 2: voice pipeline phase
│   ├── idle
│   ├── listening
│   ├── capturing
│   ├── processing
│   ├── playing
│   └── interrupting
└── audio                   ← region 3: audio subsystem
    ├── mic-off
    ├── mic-active
    └── mic-suspended
```

**Key difference from Approach A:** The flat reducer collapses connection + pipeline + audio into a single state dimension (9 states = 1 axis). The parallel region approach tracks them independently, so `connection=established + pipeline=processing + audio=mic-off` is naturally representable without combinatorial explosion.

**Trade-off:** This is more expressive but harder to reason about — `3 × 6 × 3 = 54` theoretical combinations, though many are constrained by guards. Approach A's 9 flat states are simpler to enumerate and test exhaustively.

### Reactive Event Bus

```typescript
interface EventBus {
  // Push events into the system
  emit(event: VoiceEvent): void;
  
  // Subscribe to events (filtered by type)
  on<T extends VoiceEvent["type"]>(
    type: T,
    handler: (event: Extract<VoiceEvent, { type: T }>) => void
  ): Unsubscribe;
  
  // Observable-like: transform and compose event streams
  pipe<T>(
    source: EventStream,
    ...operators: Operator[]
  ): EventStream;
}
```

Instead of the synchronous `dispatch → transition → execute effects` loop, events flow through the bus:

```
User action / WebSocket message / Timer
  → EventBus.emit(event)
  → Statechart processes event, emits state change
  → Effect stream emits side effect commands
  → Effect subscribers execute (WS, audio, timers)
  → Resulting events fed back into EventBus
```

### Statechart Definition (Declarative)

```typescript
const voiceStatechart = defineStatechart({
  id: "voice",
  initial: "inactive",
  states: {
    inactive: {
      on: { CONNECT: "connecting" },
    },
    connecting: {
      entry: [effects.openWS, effects.sendAuth, effects.startTimeout("auth", 10_000)],
      on: {
        AUTH_OK: { target: "active", actions: [effects.cancelTimeout("auth")] },
        AUTH_FAILED: { target: "error", actions: [effects.cancelTimeout("auth")] },
        TIMEOUT: { target: "error", guard: (e) => e.context === "auth" },
        WS_DROP: "reconnecting",
      },
    },
    active: {
      // Compound state: WS_DROP handled once for ALL children
      initial: "listening",
      entry: [effects.startVAD],
      exit: [effects.stopVAD],
      on: {
        WS_DROP: { target: "reconnecting", actions: [effects.stopAudioStream, effects.stopPlayback] },
        DISCONNECT: "inactive",
      },
      states: {
        listening: {
          on: { SPEECH_START: "user-speaking" },
        },
        "user-speaking": {
          entry: [effects.sendUtteranceStart, effects.startAudioStream],
          exit: [effects.stopAudioStream],
          on: {
            SPEECH_END: "processing",
            CANCEL: { target: "listening", actions: [effects.sendUtteranceCancel] },
          },
        },
        processing: {
          entry: [effects.sendUtteranceEnd, effects.startTimeout("processing", 30_000)],
          exit: [effects.cancelTimeout("processing")],
          on: {
            RESPONSE_START: "assistant-speaking",
            TIMEOUT: { target: "#voice.error", guard: (e) => e.context === "processing" },
            SPEECH_START: { actions: [effects.logWarning("Speech during processing ignored")] },
          },
        },
        "assistant-speaking": {
          entry: [effects.startPlayback],
          exit: [effects.stopPlayback],
          on: {
            AUDIO_DONE: "listening",
            SPEECH_START: "interrupting",
          },
        },
        interrupting: {
          entry: [effects.clearPlayback, effects.sendBargeIn, effects.startTimeout("barge_in_ack", 3_000)],
          exit: [effects.cancelTimeout("barge_in_ack")],
          on: {
            BARGE_IN_ACK: "user-speaking",
            TIMEOUT: { target: "listening", guard: (e) => e.context === "barge_in_ack" },
          },
        },
      },
    },
    reconnecting: {
      entry: [effects.startReconnectBackoff],
      on: {
        RECONNECTED: "active", // re-enters "active.listening" (initial child)
        MAX_RETRIES: "error",
      },
    },
    error: {
      on: {
        RETRY: "connecting",
        DISMISS: "inactive",
      },
    },
  },
});
```

### Key Design Differences from Approach A

| Aspect | Approach A (flat reducer) | This approach (statechart-reactive) |
|--------|--------------------------|--------------------------------------|
| State representation | 9 flat string states | Hierarchical: compound `active` with 5 children + 2 top-level |
| WS_DROP handling | Duplicated in 5 states | Once on `active` compound state |
| Entry/exit effects | Inlined per transition | Declared per state (entry/exit actions) |
| Event flow | Synchronous dispatch loop | Async event bus with backpressure |
| Transition definition | Switch/case (imperative) | Declarative config object |
| Testing | Direct function call | Event stream assertion |
| Timeout management | Manual START/CANCEL pairs | Automatic: entry starts, exit cancels |
| Bundle size | ~2KB (zero deps) | ~5-8KB (statechart interpreter + event bus) |
| Devtools | Manual logging | Statechart visualizer (auto-generated from definition) |

## Comparison with Approach A (Pure-Function-Effects)

### Strengths

#### 1. Entry/exit actions eliminate effect pairing bugs
In Approach A, every transition that enters a timed state must include `START_TIMEOUT`, and every transition that leaves must include `CANCEL_TIMEOUT`. This is error-prone — missing a `CANCEL_TIMEOUT` on one exit path causes stale timer bugs.

Statecharts model this as state-level entry/exit actions. `processing.entry = startTimeout(30s)`, `processing.exit = cancelTimeout()`. **Every** exit path automatically cancels the timeout. This eliminates an entire class of bugs.

The current PoC has this risk: the `processing` state starts a timeout on entry (via SPEECH_END transition), but if a new transition is added later that also enters `processing`, the developer must remember to add the timeout. With entry actions, it's automatic.

#### 2. Compound states eliminate transition duplication
Approach A's `transition()` function has `WS_DROP` handling in `listening`, `user-speaking`, `processing`, `assistant-speaking`, and `interrupting`. Each has slightly different effects but the same destination. If a new "active" child state is added, the developer must remember to add `WS_DROP` handling.

Statechart: define `WS_DROP` once on `active`, it applies to all children. Adding a new child state automatically inherits `WS_DROP` handling.

**Quantified:** Current PoC has ~15 lines of WS_DROP handling across 5 states. Statechart reduces this to ~3 lines.

#### 3. Declarative definition enables visualization
The statechart definition object can be automatically rendered as a state diagram. This is valuable for:
- **Documentation:** Always-accurate diagram of the state machine
- **Review:** Non-engineers can review state transitions visually
- **Debugging:** Highlight current state + available transitions in real-time

Approach A requires manual diagram maintenance or custom tooling.

#### 4. Reactive event streams handle async naturally
Approach A's effect execution is imperative: iterate effects array, execute each. If an effect triggers a new event (e.g., `START_RECONNECT_BACKOFF` eventually fires `RECONNECTED`), it re-enters the dispatch loop. Reentrancy must be carefully managed.

Reactive streams handle this naturally: events flow through the bus asynchronously, no reentrancy concern. Backpressure prevents event flooding. Operators like `debounce`, `throttle`, `buffer` compose cleanly for edge cases:

```typescript
// Debounce rapid barge-in attempts (echo suppression)
eventBus.pipe(
  filter(e => e.type === "SPEECH_START"),
  debounce(300), // 300ms cooldown between barge-in triggers
).subscribe(e => statechart.send(e));
```

#### 5. Parallel regions model orthogonal concerns
The flat state machine can't represent "connection is reconnecting AND we were in the middle of processing." It transitions to `reconnecting` and loses context about where it was. Recovering from reconnect always goes to `listening`, even if the user was mid-sentence.

With parallel regions, the `connection` region can transition to `reconnecting` while the `pipeline` region remembers it was in `capturing`. On reconnect, the pipeline can resume capturing rather than going back to idle.

**Caveat:** This is a v2 capability. For v1, the simpler "reconnect → listening" behavior is probably fine.

### Weaknesses

#### 1. Higher complexity and learning curve
Approach A's `transition()` is a plain switch/case that any TypeScript developer can read and modify. Statecharts introduce concepts (compound states, parallel regions, guards, entry/exit actions, history states) that require understanding the statechart formalism.

**Impact on Goal #1 (SDK = magic black box):** The SDK consumer doesn't see the internals. But the SDK *maintainer* needs to understand statecharts. If the team doesn't have statechart experience, this is a real cost.

#### 2. Larger bundle size
Approach A: ~2KB minified (zero dependencies, plain TypeScript).
This approach: ~5-8KB for a minimal statechart interpreter + event bus. Using XState would be ~15-20KB.

**Mitigation:** Build a minimal statechart interpreter (~200-300 LOC) rather than depending on XState. This keeps bundle size under 5KB while getting the core benefits (hierarchy, entry/exit, guards).

#### 3. Testing is less direct
Approach A: `assert.equal(transition("listening", { type: "SPEECH_START" }).state, "user-speaking")` — one function call, pure input/output.

Statechart: must instantiate the interpreter, send event, check resulting state. Compound states add complexity: `assert.equal(state.value, { active: "user-speaking" })` — nested state values.

**Mitigation:** Wrap statechart in a test helper that flattens state for simple assertions:
```typescript
const machine = createTestMachine(voiceStatechart);
machine.send("SPEECH_START");
assert.equal(machine.flatState, "active.user-speaking");
```

#### 4. Reactive streams add indirection
The event bus + stream operators pattern is powerful but adds indirection. Debugging "why didn't this event trigger a transition?" requires tracing through the event bus, checking filters, guards, and debounce timers. Approach A's synchronous dispatch is trivially debuggable: step through the switch/case.

**Mitigation:** Event bus logging with correlation IDs. Every event gets a `traceId`; log shows `emit → filter → statechart → transition → effects` chain.

#### 5. Overkill for current requirements
9 states with ~22 transitions is well within the capability of a flat reducer. The statechart benefits (hierarchy, parallelism, history) shine at 15+ states. At 9 states, the ceremony-to-benefit ratio is high.

**Counter-argument:** The prompt says "this is NOT a one-off refactor" and must support future features (tool calling, multi-modal, memory, classifier routing). These will likely add states:
- Tool calling: `tool-executing`, `tool-result-received`
- Multi-modal: `screen-sharing`, `image-processing`
- Memory: `context-loading`, `memory-writing`

At 15+ states, hierarchy becomes essential. Starting with a statechart avoids a second migration.

#### 6. Effect execution ordering less explicit
Approach A returns effects in a deterministic array. The caller executes them in order. This makes effect ordering testable and predictable.

Reactive streams process effects asynchronously. If `STOP_PLAYBACK` must happen before `SEND_BARGE_IN`, the ordering depends on subscriber behavior, not the state machine. This can be mitigated by maintaining an ordered effects list within the statechart (same as Approach A), but the reactive pattern tempts developers toward unordered async execution.

## Edge Case Comparison

### Barge-in during processing (double utterance)
- **Approach A:** Handled by explicit `(processing, SPEECH_START) → processing [ignore]` transition.
- **Statechart:** Same — `processing` state has no `SPEECH_START` transition, event propagates to `active`, which also doesn't handle it. Unhandled = ignored.
- **Verdict:** Equivalent.

### WS drop during barge-in
- **Approach A:** Explicit `(interrupting, WS_DROP) → reconnecting` with `START_RECONNECT_BACKOFF` effect.
- **Statechart:** `interrupting` is a child of `active`. `active.on.WS_DROP → reconnecting` handles it. `interrupting.exit` automatically cancels the barge_in_ack timeout.
- **Verdict:** Statechart wins — exit action auto-cleanup prevents the "forgot to cancel timeout" bug.

### Rapid state changes (e.g., connect → auth_ok → speech_start in <100ms)
- **Approach A:** Synchronous dispatch handles each event sequentially. No batching concern.
- **Statechart reactive:** Events queue in the bus. Statechart processes them sequentially (single-threaded). But if operators (debounce/throttle) are in the pipeline, events might be dropped or delayed.
- **Verdict:** Approach A is safer for rapid sequences. Reactive streams need careful operator configuration to avoid dropping valid rapid events.

### State recovery after reconnect
- **Approach A:** Always returns to `listening` after reconnect. Previous pipeline state is lost.
- **Statechart:** Can use **history states** to return to the previous child of `active`. E.g., if the user was in `user-speaking` when WS dropped, reconnecting could resume to `user-speaking` (with audio buffer replay).
- **Verdict:** Statechart has a natural model for this. Approach A would need an explicit `previousState` field and custom recovery logic.

## Viability Assessment

**Would this approach transfer to the real codebase?**

Yes, with caveats. The hierarchical statechart model is architecturally sound and addresses real weaknesses in the flat reducer (transition duplication, entry/exit pairing bugs, no state hierarchy). However:

1. **For v1 with 9 states, the flat reducer is sufficient.** The statechart benefits don't justify the added complexity at current scale.
2. **For v2+ with 15+ states, hierarchy becomes essential.** If tool calling, multi-modal, and memory add states, the flat reducer's switch/case becomes unwieldy.
3. **The reactive event bus is the riskiest part.** It adds indirection and makes debugging harder. A statechart can be used with synchronous dispatch (like Approach A) — the reactive bus is optional.

**Recommended hybrid:** Use a hierarchical statechart definition for the transition logic (getting entry/exit actions and compound states) but keep synchronous dispatch semantics (not reactive streams). This gets 80% of the statechart benefit at 20% of the complexity cost.

## Implementation Considerations

### Minimal Statechart Interpreter (~250 LOC)

Don't depend on XState. Build a minimal interpreter that supports:
- Compound states (parent handles events children don't)
- Entry/exit actions
- Guards (conditional transitions)
- Flat state accessor (for simple consumer API)

Skip: parallel regions, history states, delayed transitions, invocations. These can be added if needed.

### Consumer API (Unchanged)

The consumer-facing API should be identical to Approach A:

```typescript
const client = new VoiceClient({ url: "wss://..." });
client.onStatusChange((status) => {
  console.log(status.label); // "Listening...", "Thinking...", etc.
});
client.connect();
```

The statechart is an internal implementation detail. The developer never sees hierarchical state values — `status.state` flattens to `"listening"`, `"processing"`, etc.

### Migration from Flat Reducer

If starting with Approach A and later needing hierarchy:
1. Convert the switch/case to a declarative config object (mechanical transformation)
2. Nest states under compound parents
3. Move duplicated transitions to parents
4. Move timeout start/cancel to entry/exit actions
5. Replace `dispatch()` with `interpret()` — same sync semantics

This migration is low-risk because the external API doesn't change.

## Open Questions

1. **Is the team familiar with statechart concepts?** If not, the flat reducer's readability advantage is significant.
2. **How many states will v2 add?** If <5 new states, the flat reducer scales fine. If >10, hierarchy is worth the upfront cost.
3. **Should the reactive event bus be a separate concern?** The statechart can use sync dispatch (like Approach A) while still getting hierarchy benefits. The reactive bus is a separate architectural decision.
4. **Would a "graduated" approach work?** Start with Approach A's flat reducer, but define transitions in a config object (not switch/case) so the shape is already statechart-compatible. When hierarchy is needed, the migration is trivial.
