# Error UX — Alternative Approach: Reactive Error Stream with Policy-Based Recovery

## Why an Alternative?

The current "error-classifier-recovery" approach (centralized pure-function classifier → recovery resolver → state integration) scores well on boundary clarity (6) and user presence (6) but poorly on test isolation (1) and state completeness (5). The main weaknesses:

1. **Test isolation is nearly absent** — the classifier is a single pure function, easy to unit test, but the *integration* of classifier → recovery → state machine → user feedback is untested. The pipeline of transformations is validated piece by piece but never as a composed flow.
2. **State completeness gaps** — the error state machine has 7 states but recovery timeout and escalation paths depend on external timers that aren't modeled as first-class state transitions.
3. **Double-error problem unsolved** — if STT fails, then reconnect also fails, two separate error categories fire. The current classifier handles them independently with no coordination.

## Alternative: Reactive Error Stream + Declarative Recovery Policies

### Core Idea

Instead of a centralized classifier function, errors flow as **typed events into an error stream**. Recovery is handled by **declarative policy objects** that match error patterns and define recovery workflows. The stream provides built-in operators for deduplication, debouncing, and escalation.

### Key Differences from Current Approach

| Aspect | Classifier (Current) | Reactive Stream (Alternative) |
|--------|----------------------|-------------------------------|
| Error routing | Single function maps error → category | Policy objects match on error patterns |
| Recovery | Deterministic: category → action | Stateful: policies track retry count, timing |
| Composition | Sequential: classify → resolve → transition | Stream: errors flow through policy pipeline |
| Double errors | Two independent classifications | Policies can correlate errors across time window |
| Testing | Test classifier + resolver separately | Test each policy in isolation + compose in integration |
| Extensibility | Add case to switch | Add new policy object |

### Architecture

```
                        ┌─────────────┐
  STT error ──────────→ │             │     ┌──────────────────┐
  LLM error ──────────→ │ Error Stream│────→│ Policy Pipeline  │
  TTS error ──────────→ │ (EventBus)  │     │                  │
  Network error ──────→ │             │     │ ┌──────────────┐ │
  Auth error ─────────→ │             │     │ │ RetryPolicy  │ │
                        └─────────────┘     │ ├──────────────┤ │
                                            │ │ DedupePolicy │ │
                                            │ ├──────────────┤ │
                                            │ │ EscalatePolicy│ │
                                            │ ├──────────────┤ │
                                            │ │ NotifyPolicy │ │
                                            │ └──────────────┘ │
                                            └────────┬─────────┘
                                                     │
                                            ┌────────▼─────────┐
                                            │ Recovery Actions  │
                                            │ (Effects Emitted) │
                                            └──────────────────┘
```

### Core Types

```typescript
// Structured error event — emitted by any pipeline component
interface ErrorEvent {
  readonly id: string;           // unique error instance ID
  readonly source: ErrorSource;  // 'stt' | 'llm' | 'tts' | 'network' | 'auth'
  readonly phase: ErrorPhase;    // 'connecting' | 'streaming' | 'finalizing'
  readonly timestamp: number;
  readonly originalError: unknown;
  readonly context?: Record<string, unknown>; // e.g., { utteranceId, retryCount }
}

// Recovery policy interface — each policy handles a specific error pattern
interface RecoveryPolicy {
  readonly name: string;
  
  // Does this policy handle this error?
  matches(event: ErrorEvent): boolean;
  
  // What should happen? Returns effects, not side effects.
  handle(event: ErrorEvent, history: ReadonlyArray<ErrorEvent>): PolicyResult;
}

// Policy result — declarative effects
type PolicyResult = {
  readonly handled: boolean;      // true = stop propagating to next policy
  readonly effects: RecoveryEffect[];
};

type RecoveryEffect =
  | { type: 'notify_user'; message: string; severity: 'info' | 'warning' | 'error' }
  | { type: 'retry'; delay_ms: number; max_attempts: number }
  | { type: 'transition'; target_state: string }
  | { type: 'escalate'; from_category: string; to_category: string }
  | { type: 'suppress' }  // e.g., deduplication
  | { type: 'log'; level: string; message: string };
```

### Policy Examples

```typescript
// Policy: STT errors during streaming → "didn't catch that"
const sttStreamingPolicy: RecoveryPolicy = {
  name: 'stt-streaming-recovery',
  matches: (e) => e.source === 'stt' && e.phase === 'streaming',
  handle: (event, history) => ({
    handled: true,
    effects: [
      { type: 'notify_user', message: "I didn't catch that. Could you repeat?", severity: 'info' },
      { type: 'transition', target_state: 'listening' },
    ],
  }),
};

// Policy: Deduplication — suppress errors within 2s of same source
const deduplicationPolicy: RecoveryPolicy = {
  name: 'dedup',
  matches: (_) => true, // runs on all errors
  handle: (event, history) => {
    const recent = history.filter(
      h => h.source === event.source && event.timestamp - h.timestamp < 2000
    );
    if (recent.length > 0) {
      return { handled: true, effects: [{ type: 'suppress' }] };
    }
    return { handled: false, effects: [] };
  },
};

// Policy: Escalation — 3+ errors from same source in 30s → service_unavailable
const escalationPolicy: RecoveryPolicy = {
  name: 'escalation',
  matches: (_) => true,
  handle: (event, history) => {
    const recentSameSource = history.filter(
      h => h.source === event.source && event.timestamp - h.timestamp < 30_000
    );
    if (recentSameSource.length >= 2) { // this is the 3rd
      return {
        handled: true,
        effects: [
          { type: 'notify_user', message: "I'm having trouble right now. Try again in a moment.", severity: 'error' },
          { type: 'transition', target_state: 'error' },
          { type: 'escalate', from_category: event.source, to_category: 'service_unavailable' },
        ],
      };
    }
    return { handled: false, effects: [] };
  },
};
```

### Error Stream (Pipeline Runner)

```typescript
class ErrorPipeline {
  private policies: RecoveryPolicy[];
  private history: ErrorEvent[] = [];
  private effectHandler: (effect: RecoveryEffect) => void;

  constructor(
    policies: RecoveryPolicy[],
    effectHandler: (effect: RecoveryEffect) => void,
  ) {
    // Policy order matters: dedup runs first, then escalation, then specific handlers
    this.policies = policies;
    this.effectHandler = effectHandler;
  }

  process(event: ErrorEvent): RecoveryEffect[] {
    this.history.push(event);
    // Keep only last 60s of history
    const cutoff = Date.now() - 60_000;
    this.history = this.history.filter(e => e.timestamp > cutoff);

    const allEffects: RecoveryEffect[] = [];
    for (const policy of this.policies) {
      if (!policy.matches(event)) continue;
      const result = policy.handle(event, this.history);
      allEffects.push(...result.effects);
      if (result.handled) break; // stop propagating
    }

    // Execute effects
    for (const effect of allEffects) {
      this.effectHandler(effect);
    }

    return allEffects;
  }
}
```

### Processing Timer as a Policy

The staged processing indicator (2s → thinking, 5s → still thinking, 30s → timeout) is modeled as a **timeout policy** rather than a separate timer module:

```typescript
// Not an error policy per se, but uses the same effect system
class ProcessingTimeoutPolicy {
  private stages = [
    { delay: 2000, message: 'Thinking...', severity: 'info' as const },
    { delay: 5000, message: 'Still thinking...', severity: 'info' as const },
    { delay: 15000, message: 'Taking longer than usual...', severity: 'warning' as const },
    { delay: 30000, message: 'Sorry, I\'m having trouble. Could you try again?', severity: 'error' as const },
  ];

  start(effectHandler: (effect: RecoveryEffect) => void): () => void {
    const timers = this.stages.map(stage =>
      setTimeout(() => {
        effectHandler({
          type: 'notify_user',
          message: stage.message,
          severity: stage.severity,
        });
        if (stage.severity === 'error') {
          effectHandler({ type: 'transition', target_state: 'listening' });
        }
      }, stage.delay)
    );
    // Returns cancel function
    return () => timers.forEach(clearTimeout);
  }
}
```

### Consumer API (Developer Experience)

```typescript
import { ErrorPipeline, createDefaultPolicies } from '@sentient/error-ux';

// 1. Create pipeline with default policies
const errorPipeline = new ErrorPipeline(
  createDefaultPolicies(),
  (effect) => {
    switch (effect.type) {
      case 'notify_user':
        ui.showMessage(effect.message, effect.severity);
        break;
      case 'transition':
        stateMachine.send({ type: 'TRANSITION', target: effect.target_state });
        break;
      case 'retry':
        scheduleRetry(effect.delay_ms, effect.max_attempts);
        break;
    }
  }
);

// 2. Any component emits errors — zero coupling to UX layer
sttProvider.on('error', (err) => {
  errorPipeline.process({
    id: crypto.randomUUID(),
    source: 'stt',
    phase: 'streaming',
    timestamp: Date.now(),
    originalError: err,
  });
});

// 3. Add custom policy for app-specific behavior
errorPipeline.addPolicy({
  name: 'custom-stt-fallback',
  matches: (e) => e.source === 'stt',
  handle: () => ({
    handled: true,
    effects: [
      { type: 'notify_user', message: 'Switching to text input...', severity: 'info' },
      { type: 'transition', target_state: 'text_mode' },
    ],
  }),
});
```

## Comparison with Current Approach

### Strengths of Reactive Stream

1. **Test isolation is dramatically better.** Each policy is a pure function testable in complete isolation. The ErrorPipeline itself is testable with mock policies. Integration tests compose real policies and verify effect output — no timers, no I/O, just `process(event) → effects[]`.

2. **Double-error problem solved.** The deduplication policy inspects history and suppresses duplicate errors. The escalation policy detects repeated failures and upgrades severity. This is impossible with a stateless classifier.

3. **Extensibility is 1 file.** Adding a new error handling behavior = create a new policy object, register it. No switch statement to update, no classifier to modify.

4. **Temporal reasoning.** Policies see error history. They can reason about patterns over time: "3 STT errors in 30s", "network flapping", "degraded but not dead". The centralized classifier has no memory.

5. **Policy ordering.** Dedup runs before specific handlers. Escalation can override specific handlers. The pipeline gives explicit control over priority.

### Weaknesses of Reactive Stream

1. **More complex mental model.** A developer must understand policy ordering, the `handled` flag for short-circuiting, and the history window. The centralized classifier is simpler: one function, one mapping.

2. **Effect interpretation is external.** The pipeline emits effects but doesn't execute them. The consumer must wire up effect handling. This is good for testing but adds integration complexity.

3. **Policy ordering bugs.** If dedup runs after specific handlers, a duplicate error gets two user notifications. Policy ordering is a source of subtle bugs.

4. **History management.** The sliding window (60s) must be tuned. Too short = escalation misses patterns. Too long = memory grows, stale errors influence decisions.

## Codebase Integration Analysis

### Where This Maps to Real Code

1. **Error emission points** — same as current: `voice-handlers.ts:36`, `voice-handlers.ts:51`, `streaming-overlap.ts:26-54`. Each emits an `ErrorEvent` instead of calling `sendError()` directly.

2. **Policy registration** — new file: `gateway/src/pipeline/error-policies/` with one file per policy. Flow manager registers policies at startup.

3. **Effect handler** — in `ws-helpers.ts` or a new `error-effect-handler.ts`. Maps `RecoveryEffect` → WebSocket messages + state transitions.

4. **Existing deferred error propagation** (`streaming-overlap.ts:26-54`) — preserved naturally. The LLM error is captured, TTS drains, then the error event is emitted to the pipeline. The timing of emission is the component's responsibility; the pipeline handles classification and recovery.

5. **Processing timeout** — the `ProcessingTimeoutPolicy` replaces the ad-hoc timer. It uses the same effect system, making it testable with the same mock effect handler.

### Compatibility with Existing Patterns

- **AsyncGenerator pipeline**: Each generator stage wraps its `catch` to emit `ErrorEvent` to the pipeline. The generator can continue (degraded) or terminate.
- **AbortSignal**: Abort events are NOT errors — policies must NOT fire on abort. The `ErrorEvent` should not be emitted when `signal.aborted` is true. This matches the existing pattern in `voice-handlers.ts:50`.
- **Result type** (auth): Auth errors already return `Result<T>`. The error pipeline sits at a higher level — when auth fails, the handler creates an `ErrorEvent` from the Result's error. No conflict.

## State Table for Policy Pipeline

| State | Event | Next State | Effects |
|-------|-------|------------|---------|
| idle | error_received | matching | — |
| matching | policy_matches | evaluating | — |
| matching | no_match + more_policies | matching (next) | — |
| matching | no_match + no_more | fallback | — |
| evaluating | handled=true | done | emit effects |
| evaluating | handled=false | matching (next) | emit effects (partial) |
| fallback | — | done | emit default "try_again" effect |
| done | — | idle | — |

The pipeline itself is synchronous — `process()` runs policies in order and returns. No async state to manage, no stuck states possible.

## Testing Strategy

```typescript
// Each policy testable in complete isolation
describe('sttStreamingPolicy', () => {
  it('matches STT streaming errors', () => {
    const event = createErrorEvent({ source: 'stt', phase: 'streaming' });
    expect(sttStreamingPolicy.matches(event)).toBe(true);
  });

  it('emits user notification + state transition', () => {
    const event = createErrorEvent({ source: 'stt', phase: 'streaming' });
    const result = sttStreamingPolicy.handle(event, []);
    expect(result.handled).toBe(true);
    expect(result.effects).toContainEqual({
      type: 'notify_user',
      message: "I didn't catch that. Could you repeat?",
      severity: 'info',
    });
    expect(result.effects).toContainEqual({
      type: 'transition',
      target_state: 'listening',
    });
  });
});

// Pipeline composition testable without I/O
describe('ErrorPipeline', () => {
  it('deduplicates errors within 2s window', () => {
    const effects: RecoveryEffect[] = [];
    const pipeline = new ErrorPipeline(
      [deduplicationPolicy, sttStreamingPolicy],
      (e) => effects.push(e),
    );
    const e1 = createErrorEvent({ source: 'stt', phase: 'streaming', timestamp: 1000 });
    const e2 = createErrorEvent({ source: 'stt', phase: 'streaming', timestamp: 2500 });
    pipeline.process(e1);
    effects.length = 0;
    pipeline.process(e2);
    expect(effects).toContainEqual({ type: 'suppress' });
  });

  it('escalates after 3 errors from same source', () => {
    const effects: RecoveryEffect[] = [];
    const pipeline = new ErrorPipeline(
      [escalationPolicy, sttStreamingPolicy],
      (e) => effects.push(e),
    );
    for (let i = 0; i < 3; i++) {
      pipeline.process(createErrorEvent({ source: 'stt', phase: 'streaming', timestamp: i * 5000 }));
    }
    expect(effects.some(e => e.type === 'escalate')).toBe(true);
  });
});
```

## Assessment

This approach is viable for the real codebase. The key trade-off: more moving parts (policies, pipeline, effect handler) vs. the current approach's simplicity (one classifier function). The payoff is dramatically better test isolation, temporal error reasoning, and extensibility. The risk is policy ordering bugs — mitigated by convention (dedup → escalation → specific → fallback) and integration tests that verify the full pipeline.

For a voice SDK where errors are frequent, correlated, and time-sensitive (network flapping, provider degradation), the reactive stream approach handles real-world error patterns that a stateless classifier cannot.
