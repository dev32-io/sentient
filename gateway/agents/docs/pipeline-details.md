# Cerebrum Pipeline — Details & Examples

## Core Model

Three components own lifecycle. Everything else is stateless or delegates to these:

| Component | File | Owns |
|---|---|---|
| `AttentionGate` | `cerebrum/attention-gate.ts` | Cycle dispatch. The only code path that fires cycles. |
| `SessionAudioController` | `session-handlers/session-audio-controller.ts` | Session-level TTS pipeline reference + cycle `AbortController` reference + cancel primitives. |
| `TaskManager` | `cerebrum/task-manager.ts` | Tool invocation lifecycle. Registers / cancels / counts tasks. |

The **cognitive cycle** (`cerebrum/cognitive-cycle.ts`) is the atom of work: one LLM request → streamed tokens → tool dispatch → streaming TTS → commit to `ConversationHistory`. Identified by `cycleId`. Takes a single `AbortSignal` from the session. Returns `CycleResult { aborted, shouldContinue, cutoff? }`.

## Cycle Atomicity

The attention gate enforces "at most one active cycle per session" structurally:

```typescript
function dispatchCycle(triggerReason: string, forceFinal: boolean): void {
  if (activeCyclePromise !== null) {
    pendingSalience = true;   // accumulate — do not dispatch concurrent cycle
    return;
  }
  // ... fire cycle ...
  activeCyclePromise = callbacks.onCycle(...).then((outcome) => onCycleComplete(...));
}
```

External events arriving during an active cycle land in `ShortTermContext` like any other event; the gate also flips `pendingSalience = true` so it remembers to re-evaluate when the cycle ends:

```typescript
function onCycleComplete(cycleId, outcome): void {
  activeCyclePromise = null;
  if (outcome.shouldContinue && !outcome.aborted) {
    dispatchCycle("react-continuation", false); // ReAct chain, bounded by maxIterations
    return;
  }
  resetChain("natural-end");
  maybeHandlePendingSalience();  // may fire the next cycle with accumulated events
}
```

Result: new user input during an active cycle NEVER starts a concurrent cycle. It lands in short-term context, and the next cycle picks up everything since `lastCycleEndSeq`.

## Three Cancel Primitives

`SessionAudioController` owns three primitives. Each maps to one concern.

### `bargeIn()` — voice-first, keep tasks

Fired by mic-onset (speech VAD) during active TTS.

```typescript
bargeIn(): void {
  if (!hasActiveTts()) return;                             // no-op outside TTS window
  sendWireMessage({ type: "playback.stop", reason: "barge-in" });
  activeTtsAbortController?.abort("barge-in");
  cycleAbortRef.current?.abort("barge-in");                // NEW: kill LLM stream too
  // tasks untouched — user may still want them to complete
}
```

Why abort the cycle: otherwise the LLM keeps generating tokens (billed, discarded) until natural end, and the `pendingSalience` check can't fire the next cycle until that finishes. User's new speech becomes the next turn much faster when the cycle is aborted.

### `interrupt()` — explicit user stop, full cancel

Fired by `{ type: "interrupt" }` wire message (UI Stop button / Esc).

```typescript
interrupt(): void {
  sendWireMessage({ type: "playback.stop", reason: "interrupt" });
  activeTtsAbortController?.abort("interrupt");
  taskManager.cancelInterruptable("interrupt");
  cycleAbortRef.current?.abort("interrupt");
  stageCancelledTaskIdsForCommit();
}
```

Full hard stop. Cycle's commit records `cutoff: { kind: "interrupt", cancelledTaskIds }`.

### `cancelTask(taskId)` / `cancelInterruptable(reason)` — task only

Fired by the `cancel_task` / `cancel_all_tasks` effects. Touches tasks only — cycle and TTS keep running so the model can emit an acknowledgement.

```typescript
cancelTask(taskId: string, reason: string): void {
  taskManager.cancel(taskId, reason);
}
```

### Composition Is Explicit

There is no `stopEverything()` convenience. When a caller wants response + tasks cancelled (the Stop button), it calls `interrupt()` which internally runs all four steps. When the model calls `cancel_all_tasks`, only `taskManager.cancelInterruptable(...)` runs — not the others. No hidden fan-out, no hidden flags.

## Wire Messages

### Client → Server

| Message | Handler | Effect |
|---|---|---|
| `{ type: "interrupt" }` | `ws-handlers.ts` | Calls `SessionAudioController.interrupt()` |
| `{ type: "text.input", text }` | `ws-handlers.ts` | Injects into `ShortTermContext`; attention gate decides |
| Audio frames | `ws-session-configure.ts` | STT; speech onset fires `bargeIn()`, speech-final injects into context |

### Server → Client

| Message | Source | When |
|---|---|---|
| `{ type: "playback.stop", cycleId, reason: "interrupt" \| "barge-in" }` | `SessionAudioController` | On either cancel primitive that touches TTS |
| `{ type: "cycle.aborted", cycleId, reason }` | `cognitive-cycle.ts` | Cycle AbortSignal tripped |
| `{ type: "message.done", cycleId }` | `cognitive-cycle.ts` | Token stream ended, TTS draining |
| `{ type: "conversation.entry", item }` | `cognitive-cycle.ts` | Assistant entry committed; `cutoff: { kind: "interrupt" \| "barge-in", cancelledTaskIds? }` if applicable |

## Effect Definition

Every LLM-callable tool is an `EffectDefinition` under `gateway/src/effects/`. Contract:

```typescript
interface EffectDefinition<Args> {
  name: string;                // LLM-facing tool name
  description: string;         // LLM-facing description
  schema: JSONSchema;          // for LLM tool-call validation
  argsValidator: (raw: unknown) => Args;  // runtime validation
  impact: "auto" | "requires-confirm" | ...;
  rolesAllowed: UserRole[];    // capability gate
  capabilities: Capability[];  // required session capabilities
  interruptable: boolean;      // false = survives `interrupt()`
  providesContext: boolean;    // true = afferent injection
  alwaysAvailable: boolean;    // exposed even with no matching capability
  handler: (args: Args, ctx: EffectContext) => Promise<EffectResult>;
}
```

Always register effects through `effect-wrapper.ts` — never invoke `handler` directly.

### Effects That Orchestrate Cancellation

Both cancellation effects are `interruptable: false` so they survive the cascade they trigger:

```typescript
// cancel_all_tasks (renamed from the old `interrupt` effect)
createCancelAllTasksEffect({ taskManager }): EffectDefinition<{}> {
  return {
    name: "cancel_all_tasks",
    description: "Cancel every in-flight task you have running. Call this when the user says 'stop' or 'never mind'. After calling, reply with a brief acknowledgement.",
    interruptable: false,  // must not self-cancel
    async handler() {
      taskManager.cancelInterruptable("cancel_all_tasks");
      return { ok: true, data: { cancelled: true } };
    },
  };
}

// cancel_task — fine-grained variant
createCancelTaskEffect({ taskManager }): EffectDefinition<{ task_id: string }> {
  return {
    name: "cancel_task",
    description: "Cancel a single in-flight task by its task_id.",
    interruptable: false,
    async handler({ task_id }) {
      taskManager.cancel(task_id, "cancel_task");
      return { ok: true, data: { task_id } };
    },
  };
}
```

Neither effect aborts the cycle or TTS. The model's acknowledgement text streams naturally after the tool call completes.

## ReAct Continuation & Chain Reset

A cycle can report `shouldContinue: true` (set by effects that ask the model to see the result and continue). The gate dispatches the next cycle immediately, bounded by `maxIterations`. The chain counter:

- Resets on any external stimulus (`resetChain("external-stimulus")` in `handleInject`).
- Resets on barge-in (barge-in counts as external stimulus — the user's new speech will reset once STT finalizes it).
- Resets on natural chain end (cycle reports `shouldContinue: false`).
- Resets on aborted cycle (defensive, in `onCycleComplete`).

When the chain hits `maxIterations - 1`, the gate fires ONE more cycle with `forceFinal: true`: the model is forced to produce a content-only closing reply, no tools. Prevents silent mid-chain cutoff.

## Echo Suppression

Echo suppression is a mic-level concern in `ws-session-configure.ts` — it gates STT input based on whether assistant audio is currently playing. It's NOT a cycle or turn concern; no "cooldown after audio.done" hack is needed because the gate is keyed on live audio lifecycle, not a timer.

## What Changed from the Pre-Cerebrum Architecture

For historical context only — do not reintroduce any of these:

- `ContinuousSession` / `TurnController` — removed. Replaced by `AttentionGate` + `SessionAudioController` + cognitive cycles.
- Three-tier frame hierarchy (`SystemFrame` / `DataFrame` / `ControlFrame`), `InterruptionFrame`, `UninterruptibleFrame` — removed. Frames-as-messages was the Pipecat-style model; cerebrum uses async generators directly plus the effects system for tool-level semantics.
- `SentenceAggregator` as a pipeline processor — replaced by `content-tts-pipeline.ts` + `utterance-aggregator.ts` effect.
- Dual-path barge-in (client VAD message + server confidence gate) — removed. Barge-in is now a single path: mic-onset in speech mode fires `SessionAudioController.bargeIn()`.
- Echo suppression cooldown timer — removed. Mic suppression is keyed on live audio lifecycle.

## Drift Risk

If you find code that references `TurnController`, `ContinuousSession`, `InterruptionFrame`, `UninterruptibleFrame`, `activeTurn`, or `deepgramVadActive`, that code is stale and needs cleanup. Report it.
