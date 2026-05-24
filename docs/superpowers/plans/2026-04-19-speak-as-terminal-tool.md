# Speak as Terminal Tool — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port TTS out of the auto-pipeline that consumes the LLM token stream and back into an explicit `speak` tool the model invokes. Introduces a `terminal: true` effect flag (loop ends when only terminal tools were called), a session-derived capability gate, a clean two-layer split between effect orchestration and TTS provider, and visibility filters that hide terminal tasks from task lists.

**Architecture:** `speak-effect.ts` orchestrates task lifecycle and audio framing. `TextStreamSynthesizer` is the swappable TTS interface (Layer 2). `FishAudioStreamSynthesizer` is the concrete implementation. The existing `PartialJsonFieldExtractor` + `StreamingEffectCoordinator` wire LLM tool-call argument deltas into the speak handler's `ctx.argStream`. `TaskManager` gains `cancelTerminal` (used by barge-in) and a snapshot accessor that hides terminal tasks. Capability gate at the wrapper short-circuits silently for terminal effects, returns a structured error for non-terminal effects.

**Tech Stack:** Bun, TypeScript (strict), Vitest, zod.

**Spec:** `docs/superpowers/specs/2026-04-19-speak-as-terminal-tool-design.md`

**Branch:** Work on a feature branch off `develop`. Per project rules: develop is the integration target, feature branches off develop, main is off-limits.

**IMPORTANT — environment setup before any command:**

Before running ANY command from this plan, source the project env:

```bash
source scripts/env.sh
```

This puts `bun` on PATH. Skip this and every command fails with "bun: command not found".

**IMPORTANT — testing rule:** Always use `bun run test` (Vitest), NEVER `bun test` (Bun's native runner — it breaks the jsdom + RTL setup).

---

## File Map

### Files created

| Path | Responsibility |
|---|---|
| `gateway/src/cerebrum/session-capabilities.ts` | Pure function `deriveSessionCapabilities(input)` that returns the current capability set from preferences + role + surfaces |
| `gateway/src/cerebrum/session-capabilities.test.ts` | Unit tests for the deriver |
| `gateway/src/tts/text-stream-synthesizer.ts` | Interface `TextStreamSynthesizer` + `AudioFrame` type. No logic. |
| `gateway/src/providers/tts/fish-audio-synthesizer.ts` | Concrete `createFishAudioSynthesizer()` — text stream → utterance aggregator → optional emotion tag → Fish Audio session → audio frames |
| `gateway/src/providers/tts/fish-audio-synthesizer.test.ts` | Tests with mocked `TTSProvider` |
| `gateway/src/effects/speak-effect.ts` | `speakHandler` + `createSpeakEffect()` — orchestration only, no TTS specifics |
| `gateway/src/effects/speak-effect.test.ts` | Tests with mocked `TextStreamSynthesizer` |

### Files modified

| Path | What changes |
|---|---|
| `shared/protocol/src/messages.ts` | Add `cancelledTaskIds: string[]` to `playbackStopSchema`. |
| `gateway/src/effects/effect-types.ts` | Add `terminal?: boolean` to `EffectDefinition`. |
| `gateway/src/cerebrum/task-manager.ts` | Add `terminal: boolean` to `TaskHandle`; add `cancelTerminal(reason)` method; add `snapshotForLLM(limit)` method; suppress lifecycle emission for terminal tasks. |
| `gateway/src/cerebrum/task-manager.test.ts` | Tests for the new behavior. |
| `gateway/src/effects/effect-wrapper.ts` | Change `grantedCapabilities` from a `ReadonlySet<string>` to `() => ReadonlySet<string>` getter. Differentiate capability-miss outcome by terminal flag. Set `terminal` on registered TaskHandle. |
| `gateway/src/effects/effect-wrapper.test.ts` | Update existing tests for getter signature; add new tests for terminal-skip vs non-terminal-error. |
| `gateway/src/cerebrum/cognitive-cycle.ts` | (a) `shouldContinue` ignores terminal effects. (b) Suppress tool-entry commit when wrapper returned the special "terminal-skipped" marker. (c) Remove all `contentTTS` / `ttsPipeline` plumbing. |
| `gateway/src/cerebrum/cognitive-cycle.test.ts` | Tests for shouldContinue + skipped-entry suppression. |
| `gateway/src/cerebrum/short-term-context.ts` | Switch `buildTaskTable` to call `taskManager.snapshotForLLM(window)` instead of `snapshot(window)`. |
| `gateway/src/cerebrum/context-assembler.ts` | Replace the obsolete "Use `speak` for what the user hears. Use `write` for what the user sees." block with the new two-channel guidance from the spec §3.4. |
| `gateway/src/cerebrum/context-assembler.test.ts` | Update assertions to match new system-prompt strings. |
| `gateway/src/session-handlers/session-audio-wire.ts` | `sendPlaybackStop(cycleId, reason, cancelledTaskIds)` — add the third parameter; emit it in the message. Drop the unused `sendAudioStart/Frame/Done` methods (the per-task connector handles audio now). |
| `gateway/src/session-handlers/session-audio-wire.test.ts` | Update assertions; drop tests for removed methods. |
| `gateway/src/session-handlers/barge-in-controller.ts` | Replace `ttsSlot.cancelCurrent` with `taskManager.cancelTerminal("barge-in")`. Drop the `cycleSlot.cancelCurrent` call (barge-in does not abort the cycle in the new world — but we KEEP it for now since the LLM stream consumes tokens; double-check by re-reading spec §6: barge-in does NOT touch cycle, only terminal tasks). Pass returned `cancelledTaskIds` to `wire.sendPlaybackStop`. Remove ttsSlot dependency. |
| `gateway/src/session-handlers/barge-in-controller.test.ts` | Update tests for the new behavior. |
| `gateway/src/session-handlers/interrupt-controller.ts` | Pass returned `cancelledTaskIds` from `taskManager.cancelInterruptable("interrupt")` to `wire.sendPlaybackStop`. (Also keeps existing onInterruptStaged.) |
| `gateway/src/session-handlers/interrupt-controller.test.ts` | Update tests. |
| `gateway/src/session-handlers/ws-session-configure.ts` | (a) Build session-capabilities getter; pass to `registerEffects`. (b) Add `createSpeakEffect` to the registered effects, wired with the synthesizer. (c) Remove the `services.contentTTSOptions` block from the cycle deps. (d) Drop `ttsSlot` creation if no longer used. (e) Update `bargeInController` deps (no ttsSlot). |
| `gateway/src/bootstrap/create-gateway-services.ts` | (a) Build a `TextStreamSynthesizer` from Fish Audio. (b) Drop the `contentTTSOptions` field. |
| `gateway/src/bootstrap/create-gateway-services.test.ts` | Update tests. |

### Files deleted

| Path | Why |
|---|---|
| `gateway/src/cerebrum/content-tts-pipeline.ts` | Replaced by speak-effect + FishAudioStreamSynthesizer. |
| `gateway/src/cerebrum/content-tts-pipeline.test.ts` | Same. |

### Files untouched but reused

- `gateway/src/cerebrum/partial-json-field-extractor.ts` — already exists, becomes the speak handler's first real consumer.
- `gateway/src/cerebrum/streaming-effect-coordinator.ts` — already wired to call wrapper.invoke with argStream.
- `gateway/src/effects/utterance-aggregator.ts` — moves logically inside `fish-audio-synthesizer` ownership; file path stays.
- `gateway/src/effects/emotion-tagger.ts` — same.
- `gateway/src/cerebrum/conversation-history.ts` — schema already supports tool entries with cutoff/status.

---

## Task 1: Protocol — add `cancelledTaskIds` to `playback.stop`

**Files:**
- Modify: `shared/protocol/src/messages.ts:232-236`
- Test: `shared/protocol/src/messages.test.ts`

- [ ] **Step 1: Source env**

```bash
source scripts/env.sh
```

- [ ] **Step 2: Look at the current schema (so you don't accidentally break it)**

Run: `grep -n "playbackStopSchema" shared/protocol/src/messages.ts`

Expected: line 232 in the file with `playbackStopSchema = z.object({...})`.

- [ ] **Step 3: Write a failing test for the new field**

Add to `shared/protocol/src/messages.test.ts` (find the existing playback.stop describe block; if absent, add at the bottom of the file before the final closing brace):

```ts
describe("playback.stop", () => {
  it("parses with cancelledTaskIds present", () => {
    const result = playbackStopSchema.safeParse({
      type: "playback.stop",
      cycleId: "C-1",
      reason: "interrupt",
      cancelledTaskIds: ["T-1", "T-2"],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.cancelledTaskIds).toEqual(["T-1", "T-2"]);
    }
  });

  it("parses with empty cancelledTaskIds", () => {
    const result = playbackStopSchema.safeParse({
      type: "playback.stop",
      cycleId: "C-1",
      reason: "barge-in",
      cancelledTaskIds: [],
    });
    expect(result.success).toBe(true);
  });

  it("rejects when cancelledTaskIds is missing", () => {
    const result = playbackStopSchema.safeParse({
      type: "playback.stop",
      cycleId: "C-1",
      reason: "barge-in",
    });
    expect(result.success).toBe(false);
  });
});
```

If `playbackStopSchema` is not already imported in the test file, add to imports at the top:

```ts
import { playbackStopSchema } from "./messages.ts";
```

- [ ] **Step 4: Run the test to verify it fails**

```bash
cd shared/protocol && bun run test src/messages.test.ts -t "playback.stop"
```

Expected: 2 tests fail (the missing-field test passes because the schema currently accepts no extra fields).

- [ ] **Step 5: Update the schema**

Edit `shared/protocol/src/messages.ts:232-236` from:

```ts
export const playbackStopSchema = z.object({
  type: z.literal("playback.stop"),
  cycleId: z.string(),
  reason: z.enum(["barge-in", "interrupt"]),
});
```

to:

```ts
export const playbackStopSchema = z.object({
  type: z.literal("playback.stop"),
  cycleId: z.string(),
  reason: z.enum(["barge-in", "interrupt"]),
  cancelledTaskIds: z.array(z.string()),
});
```

- [ ] **Step 6: Run the test to verify it passes**

```bash
cd shared/protocol && bun run test src/messages.test.ts -t "playback.stop"
```

Expected: all 3 tests pass.

- [ ] **Step 7: Run the full protocol test suite to make sure nothing else broke**

```bash
cd shared/protocol && bun run test
```

Expected: all tests pass.

- [ ] **Step 8: Commit**

From repo root:

```bash
git checkout -b feature/speak-as-terminal-tool
git add shared/protocol/src/messages.ts shared/protocol/src/messages.test.ts
git commit -m "feat(protocol): add cancelledTaskIds to playback.stop"
```

---

## Task 2: Add `terminal` flag to `EffectDefinition`

**Files:**
- Modify: `gateway/src/effects/effect-types.ts:7-49`

- [ ] **Step 1: Source env (always start fresh sessions with this)**

```bash
source scripts/env.sh
```

- [ ] **Step 2: Read the existing interface**

Run: `sed -n '7,49p' gateway/src/effects/effect-types.ts`

Expected: shows `EffectDefinition` interface with `name`, `description`, ..., `interruptable`, `serializing`, `providesContext`, `alwaysAvailable`, `streamingArgs`, `handler`.

- [ ] **Step 3: Add the `terminal` field**

Edit `gateway/src/effects/effect-types.ts`. Find the line containing `readonly alwaysAvailable?: boolean;` (currently line 38). Just BEFORE it, insert:

```ts
  /**
   * Mark this effect as a "terminal" tool. The cognitive cycle's ReAct
   * continuation rule treats terminal tool calls as non-continuation
   * signals — a cycle that emits ONLY terminal tool calls (or none)
   * ends the loop. Use for tools whose output is the final user-facing
   * action of the turn (`speak`, future `play_sound`, `show_image`).
   *
   * Terminal tasks are also hidden from the SDK task list and from the
   * LLM's task table — they communicate via their own first-class wire
   * signals (audio frames for speak), not via task-update events.
   */
  readonly terminal?: boolean;
```

- [ ] **Step 4: Typecheck**

```bash
cd gateway && bun run typecheck
```

Expected: passes (the field is optional, so all existing definitions remain valid).

- [ ] **Step 5: Commit**

From repo root:

```bash
git add gateway/src/effects/effect-types.ts
git commit -m "feat(effects): add terminal flag to EffectDefinition"
```

---

## Task 3: TaskManager — track `terminal`, add `cancelTerminal`, add `snapshotForLLM`, suppress lifecycle for terminal

**Files:**
- Modify: `gateway/src/cerebrum/task-manager.ts`
- Test: `gateway/src/cerebrum/task-manager.test.ts`

- [ ] **Step 1: Source env**

```bash
source scripts/env.sh
```

- [ ] **Step 2: Add `terminal: boolean` to `TaskHandle`**

Edit `gateway/src/cerebrum/task-manager.ts:5-16`. Change the `TaskHandle` interface from:

```ts
export interface TaskHandle {
  readonly taskId: string;
  readonly effectName: string;
  readonly cycleId: string;
  readonly summary: string;
  readonly providesContext: boolean;
  readonly args: unknown;
  startedAt: number;
  readonly abortController: AbortController;
  readonly interruptable: boolean;
  readonly onCancelled: () => void;
}
```

to:

```ts
export interface TaskHandle {
  readonly taskId: string;
  readonly effectName: string;
  readonly cycleId: string;
  readonly summary: string;
  readonly providesContext: boolean;
  readonly args: unknown;
  startedAt: number;
  readonly abortController: AbortController;
  readonly interruptable: boolean;
  /** Terminal tasks (e.g. `speak`) are user-facing output; barge-in
   *  cancels them via cancelTerminal(). They are hidden from
   *  snapshotForLLM() and skipped by the lifecycle event emitter. */
  readonly terminal: boolean;
  readonly onCancelled: () => void;
}
```

- [ ] **Step 3: Add `cancelTerminal` to the `TaskManager` interface**

In the same file, find the `TaskManager` interface (line 60). Add a new method declaration just after `cancelInterruptable`:

```ts
  /**
   * Cancel every `terminal:true` task currently running. Returns the list
   * of cancelled taskIds. Used by barge-in: mic-onset means "stop talking
   * at me"; non-terminal work (calendar reads, etc.) is unaffected.
   */
  cancelTerminal(reason: string): readonly string[];
  /**
   * Like `snapshot(limit)` but filters out tasks whose handle is
   * `terminal:true`. Used by ContextAssembler to render the LLM's task
   * table without confusing the model with its own pending speech.
   */
  snapshotForLLM(limit: number): ReadonlyArray<TaskTableRow>;
```

- [ ] **Step 4: Implement the new methods + add the lifecycle filter**

In the same file, locate the `createTaskManager` body. Inside the returned object, after the existing `cancelInterruptable`, add:

```ts
    cancelTerminal(reason: string): readonly string[] {
      const terminal = [...running.values()].filter((h) => h.terminal);

      log.info("cancel-terminal", {
        reason,
        totalRunning: running.size,
        terminalCount: terminal.length,
      });

      const cancelledIds: string[] = [];
      for (const handle of terminal) {
        cancelHandle(handle, reason);
        running.delete(handle.taskId);
        recordCompletion(handle, "aborted");
        cancelledIds.push(handle.taskId);
      }
      return cancelledIds;
    },
```

Now add the snapshot accessor. To avoid relying on `this`, extract the existing `snapshot` logic into a local helper function inside `createTaskManager` (just before the `return {` block), then have both `snapshot` and `snapshotForLLM` call it:

```ts
  function buildSnapshot(limit: number): ReadonlyArray<TaskTableRow> {
    const now = Date.now();
    const rows: TaskTableRow[] = [];

    for (const h of running.values()) {
      rows.push({
        taskId: h.taskId,
        effectName: h.effectName,
        cycleId: h.cycleId,
        status: "running",
        summary: h.summary,
        hasResult: h.providesContext,
        elapsedMs: now - h.startedAt,
      });
    }

    const slice = limit <= 0 ? [] : completions.slice(Math.max(0, completions.length - limit));
    for (const c of slice) {
      rows.push({
        taskId: c.taskId,
        effectName: c.effectName,
        cycleId: c.cycleId,
        status: c.status,
        summary: c.summary,
        hasResult: c.providesContext,
        elapsedMs: c.durationMs,
      });
    }
    return rows;
  }
```

Now REPLACE the existing `snapshot(limit: number)` method body inside the return object literal with a thin call to the helper:

```ts
    snapshot(limit: number): ReadonlyArray<TaskTableRow> {
      return buildSnapshot(limit);
    },
```

And add `snapshotForLLM` right after it:

```ts
    snapshotForLLM(limit: number): ReadonlyArray<TaskTableRow> {
      return buildSnapshot(limit).filter((row) => {
        // Look up the live handle to read its terminal flag. For COMPLETED
        // rows we can't look it up — but completions of terminal tasks are
        // also irrelevant to the LLM (the ConversationHistory tool entry
        // is the durable record). Filter by effectName as a proxy: any row
        // whose effectName matches an effect that ever registered as
        // terminal is dropped.
        const live = running.get(row.taskId);
        if (live) return !live.terminal;
        return !terminalEffectNames.has(row.effectName);
      });
    },
```

Add `terminalEffectNames` set just before the `return {` at line 153 of the manager. It tracks names of effects that have ever registered as terminal — built lazily on register:

```ts
  const terminalEffectNames = new Set<string>();
```

In the existing `register` method body (line 154–170), AFTER `running.set(h.taskId, h);`, add:

```ts
      if (h.terminal) terminalEffectNames.add(h.effectName);
```

Now suppress lifecycle emission for terminal tasks. Locate the `emit` helper at line 114, and find the two `emit({ kind: "started", ... })` (line 162) and `emit({ kind: "ended", ... })` (line 141 inside `recordCompletion`) call sites. Wrap both with a guard. The cleanest place: change `register` to skip the started emit, and `recordCompletion` to skip the ended emit, when `h.terminal` is true.

In `register` (line 162-169), change from:

```ts
      emit({
        kind: "started",
        taskId: h.taskId,
        effectName: h.effectName,
        cycleId: h.cycleId,
        summary: h.summary,
        startedAtMs: h.startedAt,
      });
```

to:

```ts
      if (!h.terminal) {
        emit({
          kind: "started",
          taskId: h.taskId,
          effectName: h.effectName,
          cycleId: h.cycleId,
          summary: h.summary,
          startedAtMs: h.startedAt,
        });
      }
```

In `recordCompletion` (line 128-150), change from:

```ts
    emit({
      kind: "ended",
      taskId: handle.taskId,
      effectName: handle.effectName,
      cycleId: handle.cycleId,
      summary: handle.summary,
      status,
      startedAtMs: handle.startedAt,
      endedAtMs: now,
    });
```

to:

```ts
    if (!handle.terminal) {
      emit({
        kind: "ended",
        taskId: handle.taskId,
        effectName: handle.effectName,
        cycleId: handle.cycleId,
        summary: handle.summary,
        status,
        startedAtMs: handle.startedAt,
        endedAtMs: now,
      });
    }
```

- [ ] **Step 5: Update existing tests to set `terminal: false` on test handles**

Run: `grep -n "terminal" gateway/src/cerebrum/task-manager.test.ts`

If there's any output, stop and read the test file to understand what's there. Otherwise: the test currently builds `TaskHandle` objects without the new field, which will fail typecheck.

Find the test file's helper that builds TaskHandle objects (likely a `makeHandle()` function near the top). Add `terminal: false` to its returned object literal. If there's no helper, search for `register({` in the test file:

```bash
grep -n "register({" gateway/src/cerebrum/task-manager.test.ts
```

For each register call, add `terminal: false,` to the handle literal.

- [ ] **Step 6: Add new tests for `cancelTerminal`, `snapshotForLLM`, and lifecycle suppression**

Add to `gateway/src/cerebrum/task-manager.test.ts` at the bottom, before the file's final closing brace:

```ts
describe("cancelTerminal", () => {
  it("cancels only terminal tasks; leaves non-terminal running", () => {
    const tm = createTaskManager();
    const a = makeHandle({ taskId: "T-A", interruptable: true, terminal: true });
    const b = makeHandle({ taskId: "T-B", interruptable: true, terminal: false });
    const c = makeHandle({ taskId: "T-C", interruptable: false, terminal: true });
    tm.register(a);
    tm.register(b);
    tm.register(c);

    const cancelled = tm.cancelTerminal("barge-in");

    expect(new Set(cancelled)).toEqual(new Set(["T-A", "T-C"]));
    expect(tm.listRunning().map((r) => r.taskId)).toEqual(["T-B"]);
  });

  it("returns empty array when no terminal tasks running", () => {
    const tm = createTaskManager();
    const a = makeHandle({ taskId: "T-A", terminal: false, interruptable: true });
    tm.register(a);
    expect(tm.cancelTerminal("barge-in")).toEqual([]);
    expect(tm.listRunning()).toHaveLength(1);
  });
});

describe("snapshotForLLM", () => {
  it("filters out terminal running tasks", () => {
    const tm = createTaskManager();
    tm.register(makeHandle({ taskId: "T-A", terminal: true, effectName: "speak" }));
    tm.register(makeHandle({ taskId: "T-B", terminal: false, effectName: "read_calendar" }));

    const rows = tm.snapshotForLLM(10);
    expect(rows.map((r) => r.taskId)).toEqual(["T-B"]);
  });

  it("filters out terminal completed tasks (matched by effectName)", () => {
    const tm = createTaskManager();
    tm.register(makeHandle({ taskId: "T-A", terminal: true, effectName: "speak" }));
    tm.deregister("T-A", "completed");
    tm.register(makeHandle({ taskId: "T-B", terminal: false, effectName: "read_calendar" }));
    tm.deregister("T-B", "completed");

    const rows = tm.snapshotForLLM(10);
    expect(rows.map((r) => r.taskId)).toEqual(["T-B"]);
  });
});

describe("lifecycle emission", () => {
  it("does NOT emit lifecycle events for terminal tasks", () => {
    const tm = createTaskManager();
    const events: Array<{ kind: string; taskId: string }> = [];
    tm.onLifecycle((e) => events.push({ kind: e.kind, taskId: e.taskId }));

    tm.register(makeHandle({ taskId: "T-A", terminal: true }));
    tm.deregister("T-A", "completed");

    expect(events).toEqual([]);
  });

  it("DOES emit lifecycle events for non-terminal tasks", () => {
    const tm = createTaskManager();
    const events: Array<{ kind: string; taskId: string }> = [];
    tm.onLifecycle((e) => events.push({ kind: e.kind, taskId: e.taskId }));

    tm.register(makeHandle({ taskId: "T-A", terminal: false }));
    tm.deregister("T-A", "completed");

    expect(events.map((e) => e.kind)).toEqual(["started", "ended"]);
  });
});
```

If the test file does not have a `makeHandle` helper, add this just below the imports at the top of the file:

```ts
function makeHandle(overrides: Partial<TaskHandle> & { taskId: string }): TaskHandle {
  return {
    taskId: overrides.taskId,
    effectName: overrides.effectName ?? "test_effect",
    cycleId: overrides.cycleId ?? "C-1",
    summary: overrides.summary ?? "test",
    providesContext: overrides.providesContext ?? false,
    args: overrides.args ?? {},
    startedAt: overrides.startedAt ?? Date.now(),
    abortController: overrides.abortController ?? new AbortController(),
    interruptable: overrides.interruptable ?? false,
    terminal: overrides.terminal ?? false,
    onCancelled: overrides.onCancelled ?? (() => {}),
  };
}
```

If `TaskHandle` is not already imported in the test file, also add it to the imports.

- [ ] **Step 7: Run task-manager tests**

```bash
cd gateway && bun run test src/cerebrum/task-manager.test.ts
```

Expected: all tests pass (existing + new).

- [ ] **Step 8: Typecheck the gateway**

```bash
cd gateway && bun run typecheck
```

Expected: passes.

- [ ] **Step 9: Commit**

From repo root:

```bash
git add gateway/src/cerebrum/task-manager.ts gateway/src/cerebrum/task-manager.test.ts
git commit -m "feat(cerebrum): TaskManager tracks terminal flag, adds cancelTerminal + snapshotForLLM"
```

---

## Task 4: SessionCapabilities deriver

**Files:**
- Create: `gateway/src/cerebrum/session-capabilities.ts`
- Test: `gateway/src/cerebrum/session-capabilities.test.ts`

- [ ] **Step 1: Source env**

```bash
source scripts/env.sh
```

- [ ] **Step 2: Write the failing test first**

Create `gateway/src/cerebrum/session-capabilities.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { deriveSessionCapabilities } from "./session-capabilities.ts";

describe("deriveSessionCapabilities", () => {
  it("grants audio.output when channel is 'auto' and base set has audio.output", () => {
    const caps = deriveSessionCapabilities({
      preferences: { language: "en", channel: "auto" },
      baseGranted: new Set(["audio.output"]),
    });
    expect(caps.has("audio.output")).toBe(true);
  });

  it("grants audio.output when channel is 'voice' and base set has audio.output", () => {
    const caps = deriveSessionCapabilities({
      preferences: { language: "en", channel: "voice" },
      baseGranted: new Set(["audio.output"]),
    });
    expect(caps.has("audio.output")).toBe(true);
  });

  it("REVOKES audio.output when channel is 'text' even if base set has it", () => {
    const caps = deriveSessionCapabilities({
      preferences: { language: "en", channel: "text" },
      baseGranted: new Set(["audio.output"]),
    });
    expect(caps.has("audio.output")).toBe(false);
  });

  it("does NOT grant audio.output when base set lacks it (regardless of channel)", () => {
    const caps = deriveSessionCapabilities({
      preferences: { language: "en", channel: "voice" },
      baseGranted: new Set([]),
    });
    expect(caps.has("audio.output")).toBe(false);
  });

  it("preserves other base capabilities unchanged", () => {
    const caps = deriveSessionCapabilities({
      preferences: { language: "en", channel: "text" },
      baseGranted: new Set(["audio.output", "image.display"]),
    });
    expect(caps.has("image.display")).toBe(true);
  });

  it("list() returns all granted capabilities", () => {
    const caps = deriveSessionCapabilities({
      preferences: { language: "en", channel: "voice" },
      baseGranted: new Set(["audio.output", "image.display"]),
    });
    expect(new Set(caps.list())).toEqual(new Set(["audio.output", "image.display"]));
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
cd gateway && bun run test src/cerebrum/session-capabilities.test.ts
```

Expected: import error / file not found.

- [ ] **Step 4: Create the implementation**

Create `gateway/src/cerebrum/session-capabilities.ts`:

```ts
import { getLog } from "../logging/logger.ts";
import type { SessionPreferences } from "./preferences.ts";

const log = getLog(["sentient", "cerebrum", "session-capabilities"]);

// ---------------------------------------------------------------------------
// SessionCapabilities — derives the session's runtime capability set from
// (a) the base capabilities granted at session.configure (which reflect the
// client's reported supports), (b) the session's current preferences, and
// (c) future surfaces / integrations (deferred).
//
// Two consumers:
//   1. The per-cycle effect list: only effects whose `capabilities ⊆ session
//      capabilities` are exposed to the LLM. (Filter at registration time.)
//   2. effect-wrapper's defense-in-depth gate: re-check at task spawn in
//      case the snapshot the LLM saw is stale (preference changed mid-cycle).
// ---------------------------------------------------------------------------

export interface SessionCapabilities {
  has(cap: string): boolean;
  list(): readonly string[];
}

export interface DeriveInput {
  readonly preferences: SessionPreferences;
  /**
   * Base set granted at session.configure time (mirrors what the client
   * reported it supports — e.g., audio.output if the device has speakers).
   * Preferences MAY remove capabilities from this set; they CANNOT add
   * capabilities the client doesn't support.
   */
  readonly baseGranted: ReadonlySet<string>;
}

export function deriveSessionCapabilities(input: DeriveInput): SessionCapabilities {
  const out = new Set<string>(input.baseGranted);

  // channel=text revokes audio.output even if the client supports it.
  // This is the user telling us "no audio right now" (quiet hours, library mode).
  if (input.preferences.channel === "text") {
    out.delete("audio.output");
  }

  log.debug("derive", {
    preferences: input.preferences,
    base: [...input.baseGranted],
    derived: [...out],
  });

  return {
    has(cap: string): boolean {
      return out.has(cap);
    },
    list(): readonly string[] {
      return [...out];
    },
  };
}
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd gateway && bun run test src/cerebrum/session-capabilities.test.ts
```

Expected: all 6 tests pass.

- [ ] **Step 6: Typecheck**

```bash
cd gateway && bun run typecheck
```

Expected: passes.

- [ ] **Step 7: Commit**

From repo root:

```bash
git add gateway/src/cerebrum/session-capabilities.ts gateway/src/cerebrum/session-capabilities.test.ts
git commit -m "feat(cerebrum): add SessionCapabilities deriver"
```

---

## Task 5: TextStreamSynthesizer interface

**Files:**
- Create: `gateway/src/tts/text-stream-synthesizer.ts`

This task creates the interface only — no logic, no test. Tests will exercise it through the concrete implementation in Task 6.

- [ ] **Step 1: Source env**

```bash
source scripts/env.sh
```

- [ ] **Step 2: Make the directory if it doesn't exist**

```bash
ls gateway/src/tts 2>/dev/null || mkdir -p gateway/src/tts
```

- [ ] **Step 3: Create the interface file**

Create `gateway/src/tts/text-stream-synthesizer.ts`:

```ts
// ---------------------------------------------------------------------------
// TextStreamSynthesizer — the swappable seam between the speak effect and
// the underlying TTS engine. Single function, two args, one return.
//
// Contract:
//   • Consume `textStream` (deltas of TTS-friendly text from the LLM).
//   • Yield audio frames as they're produced. Backpressure-aware via the
//     async iterator protocol — the consumer (speak-effect) controls pace.
//   • Respect `signal`. On abort: stop reading text, stop yielding frames,
//     release the underlying provider session. Do not throw.
//
// Implementations decide their own preprocessing — sentence aggregation,
// punctuation cleanup, emotion tagging — based on what their engine likes.
// The speak-effect knows nothing about it.
// ---------------------------------------------------------------------------

export interface TextStreamSynthesizer {
  synthesize(
    textStream: AsyncIterable<string>,
    signal: AbortSignal,
  ): AsyncIterable<AudioFrame>;
}

export interface AudioFrame {
  readonly data: Uint8Array;
  readonly encoding: string;
  readonly sampleRate: number;
}
```

- [ ] **Step 4: Typecheck**

```bash
cd gateway && bun run typecheck
```

Expected: passes.

- [ ] **Step 5: Commit**

From repo root:

```bash
git add gateway/src/tts/text-stream-synthesizer.ts
git commit -m "feat(tts): add TextStreamSynthesizer interface"
```

---

## Task 6: FishAudioStreamSynthesizer

**Files:**
- Create: `gateway/src/providers/tts/fish-audio-synthesizer.ts`
- Test: `gateway/src/providers/tts/fish-audio-synthesizer.test.ts`

**Background:** This concrete synthesizer reuses `aggregateUtterances` (paragraph splitter), optional `tagBlocks` (emotion tagger), and the existing `TTSProvider` (Fish Audio session). The shape is taken from the deleted `content-tts-pipeline.ts` — but stripped of the cycle-specific session-management concerns. It implements only the `TextStreamSynthesizer` contract.

- [ ] **Step 1: Source env**

```bash
source scripts/env.sh
```

- [ ] **Step 2: Read the existing TTSProvider interface so you know what you're calling**

Run: `sed -n '50,100p' gateway/src/providers/tts/tts-types.ts`

Expected: `TTSProvider` interface with `warmup`, `ready`, `pushText`, `audioFrames`, `endInput`, `dispose`, `endTurn`.

- [ ] **Step 3: Read aggregateUtterances + tagBlocks signatures**

```bash
grep -n "export function\|export async" gateway/src/effects/utterance-aggregator.ts gateway/src/effects/emotion-tagger.ts
```

Expected: `aggregateUtterances(source, opts, signal): AsyncGenerator<string>` and `tagBlocks(blocks, priorTurns, opts, signal): Promise<{tagged, nextTurns}>`.

- [ ] **Step 4: Write the failing test**

Create `gateway/src/providers/tts/fish-audio-synthesizer.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TTSProvider } from "./tts-types.ts";
import { createFishAudioSynthesizer } from "./fish-audio-synthesizer.ts";

interface MockTTSProvider extends TTSProvider {
  pushedTexts: string[];
  endInputCalled: boolean;
  disposeCalled: boolean;
  emitFrame: (data: Uint8Array, encoding?: string, sampleRate?: number) => void;
  closeFrames: () => void;
}

function makeMockProvider(): MockTTSProvider {
  const pushedTexts: string[] = [];
  let endInputCalled = false;
  let disposeCalled = false;
  let frameResolvers: Array<(v: IteratorResult<{ data: Uint8Array; encoding: "opus" | "pcm" | "mp3"; sampleRate: number; isFinal: boolean }>) => void> = [];
  const frameQueue: Array<{ data: Uint8Array; encoding: "opus" | "pcm" | "mp3"; sampleRate: number; isFinal: boolean }> = [];
  let closed = false;

  function deliver(): void {
    while (frameQueue.length > 0 && frameResolvers.length > 0) {
      const r = frameResolvers.shift();
      const v = frameQueue.shift();
      if (r && v) r({ value: v, done: false });
    }
    if (closed) {
      while (frameResolvers.length > 0) {
        const r = frameResolvers.shift();
        if (r) r({ value: undefined as never, done: true });
      }
    }
  }

  return {
    pushedTexts,
    get endInputCalled() {
      return endInputCalled;
    },
    get disposeCalled() {
      return disposeCalled;
    },
    warmup() {},
    async ready(_signal: AbortSignal) {},
    pushText(text: string) {
      pushedTexts.push(text);
    },
    endInput() {
      endInputCalled = true;
    },
    dispose() {
      disposeCalled = true;
    },
    async endTurn() {},
    audioFrames(signal: AbortSignal) {
      const onAbort = () => {
        closed = true;
        deliver();
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
      return {
        [Symbol.asyncIterator]() {
          return {
            next(): Promise<IteratorResult<{ data: Uint8Array; encoding: "opus" | "pcm" | "mp3"; sampleRate: number; isFinal: boolean }>> {
              if (frameQueue.length > 0) {
                const v = frameQueue.shift();
                return Promise.resolve({ value: v as never, done: false });
              }
              if (closed) return Promise.resolve({ value: undefined as never, done: true });
              return new Promise((resolve) => {
                frameResolvers.push(resolve);
              });
            },
          };
        },
      };
    },
    emitFrame(data: Uint8Array, encoding = "opus" as const, sampleRate = 48000) {
      frameQueue.push({ data, encoding, sampleRate, isFinal: false });
      deliver();
    },
    closeFrames() {
      closed = true;
      deliver();
    },
  } as MockTTSProvider;
}

async function* arrayToStream(items: string[]): AsyncIterable<string> {
  for (const it of items) yield it;
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of iter) out.push(v);
  return out;
}

describe("FishAudioStreamSynthesizer", () => {
  let provider: MockTTSProvider;

  beforeEach(() => {
    provider = makeMockProvider();
  });

  it("yields frames the provider emits", async () => {
    const synth = createFishAudioSynthesizer({
      sessionFactory: { createSession: async () => provider as TTSProvider },
      aggregator: () => ({ maxBlockChars: 200 }),
    });

    const text$ = arrayToStream(["Hello world.\n\n"]);
    const controller = new AbortController();

    const collectPromise = collect(synth.synthesize(text$, controller.signal));

    // Wait a tick for the producer to push text + the consumer to subscribe.
    await new Promise((r) => setTimeout(r, 10));

    provider.emitFrame(new Uint8Array([1, 2, 3]));
    provider.emitFrame(new Uint8Array([4, 5, 6]));
    provider.closeFrames();

    const frames = await collectPromise;
    expect(frames).toHaveLength(2);
    expect(frames[0]?.data).toEqual(new Uint8Array([1, 2, 3]));
    expect(frames[0]?.encoding).toBe("opus");
    expect(frames[0]?.sampleRate).toBe(48000);
  });

  it("calls endInput when text stream closes", async () => {
    const synth = createFishAudioSynthesizer({
      sessionFactory: { createSession: async () => provider as TTSProvider },
      aggregator: () => ({ maxBlockChars: 200 }),
    });

    const text$ = arrayToStream(["Hi.\n\n"]);
    const controller = new AbortController();

    const collectPromise = collect(synth.synthesize(text$, controller.signal));
    await new Promise((r) => setTimeout(r, 10));
    provider.closeFrames();
    await collectPromise;

    expect(provider.endInputCalled).toBe(true);
  });

  it("stops yielding frames after abort", async () => {
    const synth = createFishAudioSynthesizer({
      sessionFactory: { createSession: async () => provider as TTSProvider },
      aggregator: () => ({ maxBlockChars: 200 }),
    });

    const text$ = arrayToStream(["Hello.\n\n"]);
    const controller = new AbortController();

    const collectPromise = collect(synth.synthesize(text$, controller.signal));
    await new Promise((r) => setTimeout(r, 10));
    provider.emitFrame(new Uint8Array([1]));

    // Abort after first frame.
    await new Promise((r) => setTimeout(r, 10));
    controller.abort();
    provider.emitFrame(new Uint8Array([2])); // should not surface

    const frames = await collectPromise;
    expect(frames.length).toBeLessThanOrEqual(1);
  });

  it("pushes aggregated paragraph blocks to the provider", async () => {
    const synth = createFishAudioSynthesizer({
      sessionFactory: { createSession: async () => provider as TTSProvider },
      aggregator: () => ({ maxBlockChars: 200 }),
    });

    const text$ = arrayToStream(["Hello.\n", "Paragraph two.\n"]);
    const controller = new AbortController();

    const collectPromise = collect(synth.synthesize(text$, controller.signal));
    await new Promise((r) => setTimeout(r, 30));
    provider.closeFrames();
    await collectPromise;

    expect(provider.pushedTexts.length).toBeGreaterThanOrEqual(1);
    expect(provider.pushedTexts.join("")).toContain("Hello");
  });
});
```

- [ ] **Step 5: Run the test to verify it fails**

```bash
cd gateway && bun run test src/providers/tts/fish-audio-synthesizer.test.ts
```

Expected: import error.

- [ ] **Step 6: Create the implementation**

Create `gateway/src/providers/tts/fish-audio-synthesizer.ts`:

```ts
import { type EmotionTaggerOptions, type TagTurn, tagBlocks } from "../../effects/emotion-tagger.ts";
import { type UtteranceAggregatorOptions, aggregateUtterances } from "../../effects/utterance-aggregator.ts";
import { getLog } from "../../logging/logger.ts";
import type { AudioFrame, TextStreamSynthesizer } from "../../tts/text-stream-synthesizer.ts";
import type { TTSProvider } from "./tts-types.ts";

const log = getLog(["sentient", "providers", "tts", "fish-audio-synthesizer"]);

// ---------------------------------------------------------------------------
// FishAudioStreamSynthesizer — concrete TextStreamSynthesizer for Fish Audio.
//
// Pipeline inside:
//   text deltas → UtteranceAggregator → optional EmotionTagger → TTSProvider.pushText
// Concurrent: provider.audioFrames(signal) drains as frames are produced.
//
// The handler (speak-effect.ts) sees only frames in / frames out. Aggregation,
// tagging, paragraph separators, and provider-specific session management
// live entirely in this file.
// ---------------------------------------------------------------------------

export interface FishAudioSynthesizerDeps {
  readonly sessionFactory: TTSSessionFactory;
  /** Builds a per-session aggregator options bag. Called once per synthesize() run. */
  readonly aggregator: () => UtteranceAggregatorOptions;
  /** Optional emotion-tag preprocessor applied before pushText(). */
  readonly emotionTags?: EmotionTaggerOptions;
}

export interface TTSSessionFactory {
  createSession(): Promise<TTSProvider>;
}

export function createFishAudioSynthesizer(deps: FishAudioSynthesizerDeps): TextStreamSynthesizer {
  return {
    synthesize(textStream: AsyncIterable<string>, signal: AbortSignal): AsyncIterable<AudioFrame> {
      return synthesizeImpl(textStream, signal, deps);
    },
  };
}

async function* synthesizeImpl(
  textStream: AsyncIterable<string>,
  signal: AbortSignal,
  deps: FishAudioSynthesizerDeps,
): AsyncGenerator<AudioFrame> {
  log.info("synthesize-start");
  if (signal.aborted) {
    log.debug("aborted-before-start");
    return;
  }

  const session = await deps.sessionFactory.createSession();
  session.warmup();

  let blocksFed = 0;
  let frameCount = 0;

  // Background producer: aggregate text deltas → optional tag → pushText.
  // We don't await this here; we drain frames in the foreground.
  const producer = (async () => {
    try {
      const blocks = aggregateUtterances(textStream, deps.aggregator(), signal);
      let priorTurns: readonly TagTurn[] = [];
      let firstPush = true;

      for await (const rawBlock of blocks) {
        if (signal.aborted) break;

        const tagged = await tagIfEnabled(rawBlock, priorTurns, deps, signal);
        priorTurns = tagged.nextTurns;
        const cleaned = stripEdgePauses(tagged.text);
        if (cleaned.length === 0) {
          log.debug("block-skip-empty-after-strip", { blockIndex: blocksFed });
          continue;
        }

        if (firstPush) {
          try {
            await session.ready(signal);
          } catch (err: unknown) {
            log.error("session-ready-failed", {
              message: err instanceof Error ? err.message : String(err),
            });
            session.dispose();
            return;
          }
          firstPush = false;
        }

        // Re-introduce paragraph break Fish Audio uses for prosodic gap.
        const sent = `${cleaned}\n\n`;
        log.debug("block-push", {
          blockIndex: blocksFed,
          rawChars: rawBlock.length,
          sentChars: sent.length,
          preview: sent.length <= 120 ? sent : `${sent.slice(0, 120)}…`,
        });
        session.pushText(sent);
        blocksFed += 1;
      }
    } catch (err: unknown) {
      log.error("producer-error", {
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      session.endInput();
      log.debug("producer-end-input", { blocksFed });
    }
  })();

  try {
    for await (const chunk of session.audioFrames(signal)) {
      if (signal.aborted) break;
      const frame: AudioFrame = {
        data: chunk.data,
        encoding: chunk.encoding,
        sampleRate: chunk.sampleRate,
      };
      frameCount += 1;
      log.debug("frame-yield", { byteSize: frame.data.byteLength, encoding: frame.encoding });
      yield frame;
    }
  } finally {
    if (signal.aborted) {
      log.info("synthesize-aborted", { frameCount, blocksFed });
      session.dispose();
    } else {
      log.info("synthesize-done", { frameCount, blocksFed });
    }
    // Make sure producer exits. It listens to signal too.
    await producer.catch(() => {
      /* logged */
    });
  }
}

async function tagIfEnabled(
  rawBlock: string,
  priorTurns: readonly TagTurn[],
  deps: FishAudioSynthesizerDeps,
  signal: AbortSignal,
): Promise<{ text: string; nextTurns: readonly TagTurn[] }> {
  if (!deps.emotionTags) {
    return { text: rawBlock, nextTurns: priorTurns };
  }
  const result = await tagBlocks([rawBlock], priorTurns, deps.emotionTags, signal);
  return { text: result.tagged[0] ?? rawBlock, nextTurns: result.nextTurns };
}

// ---------------------------------------------------------------------------
// Defensive pause-tag stripping at block edges (copied from content-tts-pipeline
// — same rationale: emotion-tag prompt forbids them but the model can drift).
// ---------------------------------------------------------------------------

const PAUSE_TAG_NAME = /\[(?:pause|short pause|long pause|停顿|短停顿|长停顿)\]/i;
const LEADING_PAUSE_RE = new RegExp(`^(?:\\s*${PAUSE_TAG_NAME.source}\\s*)+`, "i");
const TRAILING_PAUSE_RE = new RegExp(`(?:\\s*${PAUSE_TAG_NAME.source}\\s*)+$`, "i");

function stripEdgePauses(s: string): string {
  return s.replace(LEADING_PAUSE_RE, "").replace(TRAILING_PAUSE_RE, "").trim();
}
```

- [ ] **Step 7: Run the test to verify it passes**

```bash
cd gateway && bun run test src/providers/tts/fish-audio-synthesizer.test.ts
```

Expected: all 4 tests pass.

- [ ] **Step 8: Typecheck**

```bash
cd gateway && bun run typecheck
```

Expected: passes.

- [ ] **Step 9: Commit**

From repo root:

```bash
git add gateway/src/providers/tts/fish-audio-synthesizer.ts gateway/src/providers/tts/fish-audio-synthesizer.test.ts
git commit -m "feat(providers/tts): add FishAudioStreamSynthesizer"
```

---

## Task 7: Effect-wrapper — getter for grantedCapabilities + terminal-aware capability gate

**Files:**
- Modify: `gateway/src/effects/effect-wrapper.ts`
- Modify: `gateway/src/effects/effect-wrapper.test.ts`

**Background:** Today the wrapper closes over a static `ReadonlySet<string>` for `grantedCapabilities`. The capability gate (Step 3, line 73-81) returns a generic `reject` on miss. We're changing two things:

1. `grantedCapabilities` becomes `() => ReadonlySet<string>` so it picks up live preference changes (configure tool flips channel mid-session).
2. On capability miss: terminal effects return `{ ok: true, data: { __skippedByCapability: true, reason } }` (silent skip; the cycle suppresses the tool entry); non-terminal effects return `{ ok: false, data: { error: "capability-missing", capability, hint } }` (surfaces as a failed tool result; LLM adapts on next cycle).

- [ ] **Step 1: Source env**

```bash
source scripts/env.sh
```

- [ ] **Step 2: Update `EffectWrapperDeps`**

Edit `gateway/src/effects/effect-wrapper.ts:20-25`. Change:

```ts
export interface EffectWrapperDeps {
  readonly taskManager: TaskManager;
  readonly grantedCapabilities: ReadonlySet<string>;
  readonly sessionRole: UserRole;
  readonly sessionId: string;
}
```

to:

```ts
export interface EffectWrapperDeps {
  readonly taskManager: TaskManager;
  /**
   * Returns the session's CURRENT capability set. Called on every
   * invoke() so live preference changes (e.g., configure tool flipping
   * channel from voice → text) take effect immediately.
   */
  readonly grantedCapabilities: () => ReadonlySet<string>;
  readonly sessionRole: UserRole;
  readonly sessionId: string;
}
```

- [ ] **Step 3: Update the capability check function**

Replace the existing `checkCapabilities` function at line 73-81 with:

```ts
function checkCapabilities(
  definition: DefinitionMeta,
  granted: ReadonlySet<string>,
  isTerminal: boolean,
): EffectResult | null {
  for (const cap of definition.capabilities) {
    if (!granted.has(cap)) {
      if (isTerminal) {
        log.warn("terminal-effect-blocked-by-capability", {
          effect: definition.name,
          missing: cap,
          reason: "model-drift: terminal tool called without required capability",
        });
        return {
          ok: true,
          data: { __skippedByCapability: true, reason: `capability-missing:${cap}` },
        };
      }
      return {
        ok: false,
        data: { error: "capability-missing", capability: cap },
      };
    }
  }
  log.debug("capability-check-passed", { effect: definition.name });
  return null;
}
```

- [ ] **Step 4: Update the gate call site**

In the `invoke` body around line 195, change:

```ts
      const capResult = checkCapabilities(definition, deps.grantedCapabilities);
      if (capResult) return capResult;
```

to:

```ts
      const capResult = checkCapabilities(definition, deps.grantedCapabilities(), definition.terminal === true);
      if (capResult) return capResult;
```

- [ ] **Step 5: Set `terminal` on the registered TaskHandle**

In the `invoke` body around line 213-224, find the `const handle = { ... }` literal. Add `terminal: definition.terminal === true,` after the existing `interruptable: definition.interruptable,` line:

Change:

```ts
      const handle = {
        taskId,
        effectName,
        cycleId,
        summary: argsSummary,
        providesContext: definition.providesContext,
        args,
        startedAt: startTime,
        abortController: taskAbortController,
        interruptable: definition.interruptable,
        onCancelled: () => connector.sendCancelled("task-cancelled"),
      };
```

to:

```ts
      const handle = {
        taskId,
        effectName,
        cycleId,
        summary: argsSummary,
        providesContext: definition.providesContext,
        args,
        startedAt: startTime,
        abortController: taskAbortController,
        interruptable: definition.interruptable,
        terminal: definition.terminal === true,
        onCancelled: () => connector.sendCancelled("task-cancelled"),
      };
```

- [ ] **Step 6: Update the existing wrapper tests for the new getter signature**

Run: `grep -n "grantedCapabilities" gateway/src/effects/effect-wrapper.test.ts`

For each occurrence where the test passes `grantedCapabilities: new Set([...])` to `wrapEffect(...)`, change it to a getter `grantedCapabilities: () => new Set([...])`.

For example, change patterns like:

```ts
wrapEffect(def, { taskManager, grantedCapabilities: new Set(["audio.output"]), sessionRole: "adult", sessionId: "S-1" })
```

to:

```ts
wrapEffect(def, { taskManager, grantedCapabilities: () => new Set(["audio.output"]), sessionRole: "adult", sessionId: "S-1" })
```

- [ ] **Step 7: Add new tests for terminal-skip vs non-terminal-error on capability miss**

Append to `gateway/src/effects/effect-wrapper.test.ts` (before the file's final closing brace). Adapt the helper imports / setup to match what's already in the file (look at how other tests build their `def` objects):

```ts
describe("capability gate — terminal vs non-terminal", () => {
  function makeBaseDef(extras: Partial<EffectDefinition>): EffectDefinition {
    return {
      name: "test_effect",
      description: "test",
      schema: { type: "object", properties: {}, additionalProperties: false },
      argsValidator: (raw) => raw,
      impact: "auto",
      rolesAllowed: ["adult"],
      capabilities: ["audio.output"],
      interruptable: true,
      providesContext: false,
      handler: async () => ({ ok: true, data: {} }),
      ...extras,
    } as EffectDefinition;
  }

  function makeDeps(grantedCaps: ReadonlySet<string>): EffectWrapperDeps {
    return {
      taskManager: createTaskManager(),
      grantedCapabilities: () => grantedCaps,
      sessionRole: "adult",
      sessionId: "S-1",
    };
  }

  function makeConnector(): ConnectorSink {
    return { send: () => {}, sendBinary: () => {}, sendCancelled: () => {} };
  }

  function makeAudit(): AuditLogger {
    return { start: () => {}, complete: () => {} };
  }

  it("terminal effect with missing capability returns silent-skip marker", async () => {
    const def = makeBaseDef({ name: "speak", terminal: true });
    const wrapped = wrapEffect(def, makeDeps(new Set([])));

    const result = await wrapped.invoke(
      "T-1",
      "C-1",
      {},
      new AbortController().signal,
      makeConnector(),
      makeAudit(),
    );

    expect(result.ok).toBe(true);
    expect((result.data as { __skippedByCapability?: boolean }).__skippedByCapability).toBe(true);
  });

  it("non-terminal effect with missing capability returns capability-missing error", async () => {
    const def = makeBaseDef({ name: "read_calendar", terminal: false, capabilities: ["calendar.read"] });
    const wrapped = wrapEffect(def, makeDeps(new Set([])));

    const result = await wrapped.invoke(
      "T-1",
      "C-1",
      {},
      new AbortController().signal,
      makeConnector(),
      makeAudit(),
    );

    expect(result.ok).toBe(false);
    expect((result.data as { error?: string; capability?: string }).error).toBe("capability-missing");
    expect((result.data as { capability?: string }).capability).toBe("calendar.read");
  });

  it("getter is called on every invoke (picks up live preference changes)", async () => {
    const def = makeBaseDef({ name: "speak", terminal: true });
    let grants = new Set<string>(["audio.output"]);
    const wrapped = wrapEffect(def, {
      taskManager: createTaskManager(),
      grantedCapabilities: () => grants,
      sessionRole: "adult",
      sessionId: "S-1",
    });

    const ok = await wrapped.invoke("T-1", "C-1", {}, new AbortController().signal, makeConnector(), makeAudit());
    expect(ok.ok).toBe(true);
    expect((ok.data as { __skippedByCapability?: boolean }).__skippedByCapability).toBeUndefined();

    grants = new Set<string>([]);
    const skipped = await wrapped.invoke("T-2", "C-1", {}, new AbortController().signal, makeConnector(), makeAudit());
    expect((skipped.data as { __skippedByCapability?: boolean }).__skippedByCapability).toBe(true);
  });
});
```

If imports for `EffectDefinition`, `EffectWrapperDeps`, `ConnectorSink`, `AuditLogger`, `createTaskManager`, `wrapEffect` are not present, add them at the top of the test file.

- [ ] **Step 8: Run the wrapper tests**

```bash
cd gateway && bun run test src/effects/effect-wrapper.test.ts
```

Expected: all tests pass (existing + new). If any old tests fail because they were checking the old reject shape (`{step: "capability-check", reason: "..."}`), update them to expect the new shape: terminal → `{ok: true, data: {__skippedByCapability: true, ...}}`; non-terminal → `{ok: false, data: {error: "capability-missing", ...}}`.

- [ ] **Step 9: Update OTHER consumers of the wrapper that pass a static set**

Run: `grep -rn "grantedCapabilities:" gateway/src/ | grep -v "grantedCapabilities()"`

Each call site that supplies `grantedCapabilities: <something>` needs to wrap it in an arrow `() => <something>`. Likely callers:

- `gateway/src/session-handlers/ws-session-configure.ts` (registerEffects, line 630)
- Test files in `gateway/src/session-handlers/*.test.ts`

For each, change `grantedCapabilities: capabilities` (or similar) to `grantedCapabilities: () => capabilities`. Don't worry about the actual session-derivation logic yet — that comes in Task 11. For now we just keep the static set wrapped in a getter to maintain behavior.

- [ ] **Step 10: Typecheck the gateway**

```bash
cd gateway && bun run typecheck
```

Expected: passes.

- [ ] **Step 11: Run the full gateway test suite to catch fallout**

```bash
cd gateway && bun run test
```

Expected: all tests pass. If the cognitive-cycle tests fail because of the TaskHandle `terminal` field (added in Task 3), find each test that registers a handle directly and add `terminal: false`. If anything else fails, read the failure carefully — most likely a test that constructed `EffectWrapperDeps` directly.

- [ ] **Step 12: Commit**

From repo root:

```bash
git add gateway/src/effects/effect-wrapper.ts gateway/src/effects/effect-wrapper.test.ts gateway/src/session-handlers/
git commit -m "feat(effects): wrapper takes capability getter; terminal-aware capability gate"
```

---

## Task 8: Speak effect — orchestration handler

**Files:**
- Create: `gateway/src/effects/speak-effect.ts`
- Test: `gateway/src/effects/speak-effect.test.ts`

- [ ] **Step 1: Source env**

```bash
source scripts/env.sh
```

- [ ] **Step 2: Write the failing test**

Create `gateway/src/effects/speak-effect.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import type { AudioFrame, TextStreamSynthesizer } from "../tts/text-stream-synthesizer.ts";
import { createSpeakEffect } from "./speak-effect.ts";
import type { ConnectorSink, EffectContext } from "./effect-types.ts";

function makeStaticSynth(frames: AudioFrame[]): TextStreamSynthesizer {
  return {
    async *synthesize(_textStream, signal) {
      for (const f of frames) {
        if (signal.aborted) return;
        yield f;
      }
    },
  };
}

function makeAbortableSynth(signalAfterFrames: number, frames: AudioFrame[]): TextStreamSynthesizer {
  return {
    async *synthesize(_textStream, signal) {
      let count = 0;
      for (const f of frames) {
        if (signal.aborted) return;
        count++;
        yield f;
        if (count === signalAfterFrames) {
          // wait one tick to let consumer side abort
          await new Promise((r) => setTimeout(r, 5));
          if (signal.aborted) return;
        }
      }
    },
  };
}

async function* arrayStream(arr: string[]): AsyncIterable<string> {
  for (const s of arr) yield s;
}

interface CapturedConnector {
  sink: ConnectorSink;
  messages: unknown[];
  binaryFrames: Array<{ data: Uint8Array; header: unknown }>;
  cancelled: string[];
}

function makeConnector(): CapturedConnector {
  const messages: unknown[] = [];
  const binaryFrames: Array<{ data: Uint8Array; header: unknown }> = [];
  const cancelled: string[] = [];
  const sink: ConnectorSink = {
    send: (m) => messages.push(m),
    sendBinary: (data, header) => binaryFrames.push({ data, header }),
    sendCancelled: (r) => cancelled.push(r),
  };
  return { sink, messages, binaryFrames, cancelled };
}

function makeCtx(overrides: Partial<EffectContext> & { taskId: string; cycleId: string; connector: ConnectorSink; abortSignal: AbortSignal }): EffectContext & { cycleId: string } {
  return {
    sessionId: "S-1",
    userRole: "adult" as const,
    audit: { start: () => {}, complete: () => {} },
    argStream: arrayStream(["Hello world."]),
    ...overrides,
  } as EffectContext & { cycleId: string };
}

describe("speak-effect", () => {
  it("emits audio.start, frames, audio.done in order on happy path", async () => {
    const frames: AudioFrame[] = [
      { data: new Uint8Array([1]), encoding: "opus", sampleRate: 48000 },
      { data: new Uint8Array([2]), encoding: "opus", sampleRate: 48000 },
    ];
    const synth = makeStaticSynth(frames);
    const def = createSpeakEffect({ synthesizer: synth });
    const conn = makeConnector();
    const ctx = makeCtx({
      taskId: "T-1",
      cycleId: "C-1",
      connector: conn.sink,
      abortSignal: new AbortController().signal,
    });

    const gen = def.handler({ text: "Hello world." }, ctx) as AsyncGenerator<unknown>;
    for await (const _f of gen) {
      /* drain */
    }

    expect(conn.messages[0]).toMatchObject({ type: "audio.start", cycleId: "C-1", taskId: "T-1" });
    expect(conn.binaryFrames.map((bf) => Array.from(bf.data))).toEqual([[1], [2]]);
    expect(conn.messages[conn.messages.length - 1]).toMatchObject({ type: "audio.done", cycleId: "C-1", taskId: "T-1" });
  });

  it("does NOT emit audio.done when aborted", async () => {
    const frames: AudioFrame[] = [
      { data: new Uint8Array([1]), encoding: "opus", sampleRate: 48000 },
      { data: new Uint8Array([2]), encoding: "opus", sampleRate: 48000 },
    ];
    const controller = new AbortController();
    const synth = makeAbortableSynth(1, frames);
    const def = createSpeakEffect({ synthesizer: synth });
    const conn = makeConnector();
    const ctx = makeCtx({
      taskId: "T-1",
      cycleId: "C-1",
      connector: conn.sink,
      abortSignal: controller.signal,
    });

    const gen = def.handler({ text: "Hello world." }, ctx) as AsyncGenerator<unknown>;
    const drainPromise = (async () => {
      for await (const _f of gen) {
        /* drain */
      }
    })();
    await new Promise((r) => setTimeout(r, 10));
    controller.abort("test-abort");
    await drainPromise;

    expect(conn.messages.find((m) => (m as { type: string }).type === "audio.done")).toBeUndefined();
  });

  it("returns immediately if already aborted before start", async () => {
    const synth = makeStaticSynth([{ data: new Uint8Array([1]), encoding: "opus", sampleRate: 48000 }]);
    const def = createSpeakEffect({ synthesizer: synth });
    const conn = makeConnector();
    const controller = new AbortController();
    controller.abort("pre-aborted");
    const ctx = makeCtx({
      taskId: "T-1",
      cycleId: "C-1",
      connector: conn.sink,
      abortSignal: controller.signal,
    });

    const gen = def.handler({ text: "hi" }, ctx) as AsyncGenerator<unknown>;
    for await (const _f of gen) {
      /* drain */
    }

    expect(conn.messages).toEqual([]);
    expect(conn.binaryFrames).toEqual([]);
  });

  it("definition has terminal: true, interruptable: true, streamingArgs.field='text'", () => {
    const synth = makeStaticSynth([]);
    const def = createSpeakEffect({ synthesizer: synth });
    expect(def.terminal).toBe(true);
    expect(def.interruptable).toBe(true);
    expect(def.streamingArgs?.field).toBe("text");
    expect(def.name).toBe("speak");
    expect(def.capabilities).toContain("audio.output");
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
cd gateway && bun run test src/effects/speak-effect.test.ts
```

Expected: import error.

- [ ] **Step 4: Create the implementation**

Create `gateway/src/effects/speak-effect.ts`:

```ts
import { z } from "zod";
import { getLog } from "../logging/logger.ts";
import type { TextStreamSynthesizer } from "../tts/text-stream-synthesizer.ts";
import type { EffectContext, EffectDefinition, EffectFrame } from "./effect-types.ts";

const log = getLog(["sentient", "effects", "speak"]);

// ---------------------------------------------------------------------------
// speak — terminal tool. The model calls this when it wants the user to
// HEAR something. The chat-bubble `content` stays display-only; speak's
// `text` argument is the TTS-friendly version of what should be spoken.
//
// This file is orchestration only:
//   • emits audio.start / frames / audio.done over the connector
//   • respects ctx.abortSignal
//   • streams ctx.argStream into the injected TextStreamSynthesizer
//
// It knows NOTHING about Fish Audio, sentence aggregation, emotion tagging,
// or any other provider specifics. Provider swap = swap synthesizer.
// ---------------------------------------------------------------------------

const speakArgsSchema = z.object({
  text: z.string().min(1, "text must be non-empty"),
});

export type SpeakArgs = z.infer<typeof speakArgsSchema>;

const SPEAK_DESCRIPTION = [
  "Speak text aloud to the user.",
  "",
  "The `text` argument must be TTS-friendly prose that mirrors the spoken",
  "essence of your `content` for this turn — strip markdown, fenced code,",
  "URLs, table layout, and any other elements that don't translate to",
  "speech, but preserve the meaning. Use natural punctuation (commas,",
  "periods, em-dashes, ellipses) to shape pacing and intonation; the TTS",
  "engine depends on it for smooth, lifelike output.",
  "",
  "Call this only when you've decided the user should *hear* what you're",
  "saying. Check the session preferences table — if `channel` is \"text\",",
  "do not call `speak`; if \"voice\", prefer it; if \"auto\", decide from",
  "context (short conversational reply → speak; a long markdown report",
  "the user is meant to read → skip). You may call `speak` multiple times",
  "per turn (e.g., a status line before a tool call, then a result line",
  "after). Each call queues independently and plays in order.",
].join("\n");

const SPEAK_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    text: {
      type: "string",
      minLength: 1,
      description:
        "TTS-friendly prose to speak aloud. No markdown, no code blocks, no URLs. Use punctuation for pacing.",
    },
  },
  required: ["text"],
};

export interface CreateSpeakEffectDeps {
  readonly synthesizer: TextStreamSynthesizer;
}

export function createSpeakEffect(deps: CreateSpeakEffectDeps): EffectDefinition<SpeakArgs> {
  return {
    name: "speak",
    description: SPEAK_DESCRIPTION,
    schema: SPEAK_SCHEMA,
    argsValidator: (raw: unknown) => speakArgsSchema.parse(raw),
    impact: "auto",
    rolesAllowed: ["adult", "child"],
    capabilities: ["audio.output"],
    interruptable: true,
    providesContext: false,
    terminal: true,
    streamingArgs: { field: "text" },
    handler: (args, ctx) => speakHandler(args, ctx, deps.synthesizer),
  };
}

async function* speakHandler(
  args: SpeakArgs,
  ctx: EffectContext,
  synth: TextStreamSynthesizer,
): AsyncGenerator<EffectFrame> {
  const taskId = ctx.taskId;
  // cycleId is on the per-task connector via the ws-session connector factory;
  // ctx itself doesn't carry cycleId (yet). We thread it via the audio.start
  // payload using the existing connector.send wrapper which appends cycleId.
  // The wrapper-built connector decorates messages with {cycleId, taskId}.
  if (ctx.abortSignal.aborted) {
    log.debug("aborted-before-start", { taskId });
    return;
  }

  log.info("speak-start", { taskId, textLength: args.text.length });

  // Prefer ctx.argStream (live LLM deltas). Fall back to a single-shot
  // stream of the full `args.text` for non-streaming invocations.
  const textStream: AsyncIterable<string> = ctx.argStream ?? singletonStream(args.text);

  ctx.connector.send({ type: "audio.start" });

  let frameCount = 0;
  try {
    for await (const frame of synth.synthesize(textStream, ctx.abortSignal)) {
      if (ctx.abortSignal.aborted) {
        log.debug("abort-mid-frames", { taskId, frameCount });
        break;
      }
      ctx.connector.sendBinary(frame.data, {
        encoding: frame.encoding,
        sampleRate: frame.sampleRate,
      });
      frameCount += 1;
      log.debug("audio-frame-yielded", { taskId, byteSize: frame.data.byteLength });
      yield { type: "audio", frame: frame.data };
    }
  } catch (err: unknown) {
    log.error("speak-handler-error", {
      taskId,
      message: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  if (!ctx.abortSignal.aborted) {
    ctx.connector.send({ type: "audio.done" });
    log.info("speak-done", { taskId, frameCount });
  } else {
    log.info("speak-aborted", { taskId, frameCount });
  }

  yield { type: "done" };
}

async function* singletonStream(text: string): AsyncIterable<string> {
  yield text;
}
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd gateway && bun run test src/effects/speak-effect.test.ts
```

Expected: all 4 tests pass.

- [ ] **Step 6: Typecheck**

```bash
cd gateway && bun run typecheck
```

Expected: passes.

- [ ] **Step 7: Commit**

From repo root:

```bash
git add gateway/src/effects/speak-effect.ts gateway/src/effects/speak-effect.test.ts
git commit -m "feat(effects): speak orchestration handler (terminal, streamingArgs)"
```

---

## Task 9: SessionAudioWire — sendPlaybackStop adds cancelledTaskIds; drop dead audio methods

**Files:**
- Modify: `gateway/src/session-handlers/session-audio-wire.ts`
- Modify: `gateway/src/session-handlers/session-audio-wire.test.ts`

- [ ] **Step 1: Source env**

```bash
source scripts/env.sh
```

- [ ] **Step 2: Write/update the failing test**

Open `gateway/src/session-handlers/session-audio-wire.test.ts`. Replace the file contents with:

```ts
import { describe, expect, it, vi } from "vitest";
import { createSessionAudioWire } from "./session-audio-wire.ts";

describe("SessionAudioWire", () => {
  it("sendPlaybackStop emits playback.stop with cancelledTaskIds", () => {
    const send = vi.fn();
    const wire = createSessionAudioWire({ wsSend: send });
    wire.sendPlaybackStop("C-1", "barge-in", ["T-1", "T-2"]);
    expect(send).toHaveBeenCalledWith({
      type: "playback.stop",
      cycleId: "C-1",
      reason: "barge-in",
      cancelledTaskIds: ["T-1", "T-2"],
    });
  });

  it("sendPlaybackStop emits empty cancelledTaskIds when none cancelled", () => {
    const send = vi.fn();
    const wire = createSessionAudioWire({ wsSend: send });
    wire.sendPlaybackStop("C-2", "interrupt", []);
    expect(send).toHaveBeenCalledWith({
      type: "playback.stop",
      cycleId: "C-2",
      reason: "interrupt",
      cancelledTaskIds: [],
    });
  });
});
```

- [ ] **Step 3: Run it — should fail (signature mismatch)**

```bash
cd gateway && bun run test src/session-handlers/session-audio-wire.test.ts
```

Expected: TypeScript error or test failure due to signature mismatch.

- [ ] **Step 4: Update the implementation**

Replace the entire `gateway/src/session-handlers/session-audio-wire.ts` with:

```ts
import { getLog } from "../logging/logger.js";

export interface SessionAudioWire {
  sendPlaybackStop(cycleId: string, reason: "barge-in" | "interrupt", cancelledTaskIds: readonly string[]): void;
}

export interface SessionAudioWireDeps {
  readonly wsSend: (msg: unknown) => void;
}

/**
 * The only component that writes session-level playback.stop wire messages.
 * Per-task audio frames flow through the per-task ConnectorSink (which carries
 * its own cycleId + taskId), not through this wire.
 */
export function createSessionAudioWire(deps: SessionAudioWireDeps): SessionAudioWire {
  const log = getLog(["sentient", "session-handlers", "audio-wire"]);
  return {
    sendPlaybackStop(cycleId, reason, cancelledTaskIds) {
      log.info("send-playback-stop", { cycleId, reason, cancelledCount: cancelledTaskIds.length });
      deps.wsSend({ type: "playback.stop", cycleId, reason, cancelledTaskIds: [...cancelledTaskIds] });
    },
  };
}
```

- [ ] **Step 5: Run the wire test**

```bash
cd gateway && bun run test src/session-handlers/session-audio-wire.test.ts
```

Expected: 2 tests pass.

- [ ] **Step 6: Typecheck — there will be call-site errors**

```bash
cd gateway && bun run typecheck
```

Expected: errors at the callers of `sendPlaybackStop`. The callers are `barge-in-controller.ts` and `interrupt-controller.ts`. Tasks 10 and 11 fix them. For now, keep the typecheck output for reference.

- [ ] **Step 7: Commit (the wire alone, with broken callers)**

It's fine to commit a known-broken intermediate state — the next two tasks fix it. But to keep the tree green, do NOT commit yet. Move directly to Task 10 and only commit after both controllers compile again.

---

## Task 10: BargeInController — switch to cancelTerminal, pass cancelledTaskIds

**Files:**
- Modify: `gateway/src/session-handlers/barge-in-controller.ts`
- Modify: `gateway/src/session-handlers/barge-in-controller.test.ts`

**Background:** Per spec §6, barge-in NO LONGER touches the cycle controller and NO LONGER touches a TTS-specific slot. Instead it asks `TaskManager` to `cancelTerminal("barge-in")`, takes the returned ids, and emits `playback.stop` with them.

The current controller had ttsSlot-tracked grace window (post-TTS-drain barge-in detection). With no central TTS pipeline, there's no single "TTS just ended" event — but each speak task ends individually. Simplest replacement: drop the grace window for now and just check whether any terminal task is currently running. If so, fire. If not, ignore.

(If the user wants a grace window later, we can subscribe to taskManager lifecycle events and track the last-ended terminal task. Out of scope for this plan.)

- [ ] **Step 1: Source env**

```bash
source scripts/env.sh
```

- [ ] **Step 2: Update the test FIRST**

Replace the contents of `gateway/src/session-handlers/barge-in-controller.test.ts` with:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBargeInController } from "./barge-in-controller.ts";

function makeWire() {
  return {
    sendPlaybackStop: vi.fn(),
  };
}

function makeTaskManager(terminalIds: string[]) {
  return {
    cancelTerminal: vi.fn().mockReturnValue(terminalIds),
    hasRunningTerminal: vi.fn().mockReturnValue(terminalIds.length > 0),
  };
}

describe("BargeInController", () => {
  it("cancels terminal tasks and emits playback.stop with the cancelled ids", () => {
    const wire = makeWire();
    const taskManager = makeTaskManager(["T-1", "T-2"]);
    const ctrl = createBargeInController({
      taskManager,
      wire,
      currentCycleId: () => "C-1",
    });

    ctrl.trigger();

    expect(taskManager.cancelTerminal).toHaveBeenCalledWith("barge-in");
    expect(wire.sendPlaybackStop).toHaveBeenCalledWith("C-1", "barge-in", ["T-1", "T-2"]);
  });

  it("no-ops when no terminal tasks are running", () => {
    const wire = makeWire();
    const taskManager = makeTaskManager([]);
    const ctrl = createBargeInController({
      taskManager,
      wire,
      currentCycleId: () => "C-1",
    });

    ctrl.trigger();

    expect(taskManager.cancelTerminal).not.toHaveBeenCalled();
    expect(wire.sendPlaybackStop).not.toHaveBeenCalled();
  });

  it("does not emit playback.stop when cycleId is unknown", () => {
    const wire = makeWire();
    const taskManager = makeTaskManager(["T-1"]);
    const ctrl = createBargeInController({
      taskManager,
      wire,
      currentCycleId: () => null,
    });

    ctrl.trigger();

    // Still cancels the tasks (the LLM should know they died).
    expect(taskManager.cancelTerminal).toHaveBeenCalledWith("barge-in");
    expect(wire.sendPlaybackStop).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run the test to confirm it fails**

```bash
cd gateway && bun run test src/session-handlers/barge-in-controller.test.ts
```

Expected: failures (signature mismatch).

- [ ] **Step 4: Replace the controller**

Replace the entire `gateway/src/session-handlers/barge-in-controller.ts` with:

```ts
import { getLog } from "../logging/logger.js";
import type { SessionAudioWire } from "./session-audio-wire.js";

export interface BargeInController {
  trigger(): void;
}

export interface BargeInControllerDeps {
  readonly taskManager: {
    cancelTerminal(reason: string): readonly string[];
    hasRunningTerminal(): boolean;
  };
  readonly wire: SessionAudioWire;
  /** Returns the cycleId to attach to playback.stop, or null if unknown. */
  readonly currentCycleId: () => string | null;
}

/**
 * Barge-in gesture: user speech detected during assistant audio output.
 * Cancels every running `terminal:true` task (today: speak) and emits
 * playback.stop. Does NOT abort the cycle and does NOT touch non-terminal
 * tasks — long-running calendar reads etc. survive.
 */
export function createBargeInController(deps: BargeInControllerDeps): BargeInController {
  const log = getLog(["sentient", "session-handlers", "barge-in"]);
  return {
    trigger(): void {
      if (!deps.taskManager.hasRunningTerminal()) {
        log.debug("skip-no-terminal-running");
        return;
      }
      const cycleId = deps.currentCycleId();
      const cancelledIds = deps.taskManager.cancelTerminal("barge-in");
      log.info("trigger", { cycleId, cancelledCount: cancelledIds.length });
      if (cycleId) deps.wire.sendPlaybackStop(cycleId, "barge-in", cancelledIds);
    },
  };
}
```

- [ ] **Step 5: Add `hasRunningTerminal()` to TaskManager**

This wasn't included in Task 3 because we didn't yet need it. Add it now.

Edit `gateway/src/cerebrum/task-manager.ts`. In the `TaskManager` interface (around line 60), add to the method list:

```ts
  /** Returns true iff any currently-running task has terminal:true. */
  hasRunningTerminal(): boolean;
```

In the `createTaskManager` returned object, add the implementation just BEFORE `cancelTerminal`:

```ts
    hasRunningTerminal(): boolean {
      for (const h of running.values()) if (h.terminal) return true;
      return false;
    },
```

- [ ] **Step 6: Run the controller test**

```bash
cd gateway && bun run test src/session-handlers/barge-in-controller.test.ts
```

Expected: 3 tests pass.

- [ ] **Step 7: Run the task-manager tests to make sure the new method didn't break anything**

```bash
cd gateway && bun run test src/cerebrum/task-manager.test.ts
```

Expected: all pass.

- [ ] **Step 8: Don't commit yet — Task 11 will commit the wire + both controllers together**

---

## Task 11: InterruptController — emit cancelledTaskIds on playback.stop

**Files:**
- Modify: `gateway/src/session-handlers/interrupt-controller.ts`
- Modify: `gateway/src/session-handlers/interrupt-controller.test.ts`

**Background:** Interrupt continues to:
- abort the cycle (`cycleSlot.cancelCurrent`)
- cancel all interruptable tasks (which by definition includes terminal tasks since speak is `interruptable: true`)
- clear conversation salience
- emit `playback.stop`

The only change here is passing the cancelledTaskIds through to `playback.stop`. We also drop the now-dead `ttsSlot.cancelCurrent` line (ttsSlot is going away in Task 12).

- [ ] **Step 1: Source env**

```bash
source scripts/env.sh
```

- [ ] **Step 2: Update the controller**

Replace the contents of `gateway/src/session-handlers/interrupt-controller.ts` with:

```ts
import type { TaskManager } from "../cerebrum/task-manager.js";
import { getLog } from "../logging/logger.js";
import type { AbortSlot } from "./abort-slot.js";
import type { SessionAudioWire } from "./session-audio-wire.js";

export interface InterruptController {
  trigger(): void;
}

export interface InterruptControllerDeps {
  readonly cycleSlot: AbortSlot;
  readonly taskManager: Pick<TaskManager, "cancelInterruptable">;
  readonly wire: SessionAudioWire;
  /**
   * Called after task cancellation completes, always — even when no tasks
   * were cancelled. Treat as the authoritative "interrupt committed" signal
   * regardless of task count.
   */
  readonly onInterruptStaged: (ids: readonly string[]) => void;
  /**
   * Narrow interface to the AttentionGate. Called unconditionally on every
   * interrupt to drop any queued conversation signals so they don't fire a
   * new cycle after the interrupt completes. Ambient/sensor signals are
   * preserved inside the gate — only conversation-sourced salience is dropped.
   */
  readonly attentionGate: { clearPendingConversationSalience(): void };
}

/**
 * Interrupt gesture: user Stop button or Esc. Hard stop.
 * Composition: cycle cancel + cancel all interruptable tasks (which
 * includes any running speak/terminal tasks since speak is interruptable)
 * + wire playback.stop with the cancelled ids. Stages cancelled task ids
 * for the cycle's commit cutoff marker.
 */
export function createInterruptController(deps: InterruptControllerDeps): InterruptController {
  const log = getLog(["sentient", "session-handlers", "interrupt"]);
  return {
    trigger(): void {
      const cycleId = deps.cycleSlot.currentId();
      // Abort cycle BEFORE cancelling tasks so AbortSignal propagation through
      // the cycle's async unwind runs before cancelInterruptable's task
      // deregistration — prevents a double-processing race on tasks.
      deps.cycleSlot.cancelCurrent("interrupt");
      const cancelled = deps.taskManager.cancelInterruptable("interrupt");
      // Drop queued conversation signals unconditionally so they don't fire
      // a new cycle after this interrupt. Ambient salience is preserved
      // inside the gate and may still dispatch if it exceeds threshold.
      deps.attentionGate.clearPendingConversationSalience();
      log.info("interrupt", { cycleId, cancelledCount: cancelled.length });
      deps.onInterruptStaged(cancelled);
      if (cycleId) deps.wire.sendPlaybackStop(cycleId, "interrupt", cancelled);
    },
  };
}
```

- [ ] **Step 3: Update the test**

Open `gateway/src/session-handlers/interrupt-controller.test.ts`. Find tests that check the `wire.sendPlaybackStop` call — update each call assertion to include the cancelled ids array as the 3rd arg. Specifically: each `expect(wire.sendPlaybackStop).toHaveBeenCalledWith(cycleId, "interrupt")` becomes `expect(wire.sendPlaybackStop).toHaveBeenCalledWith(cycleId, "interrupt", expect.any(Array))` for general cases, or use the actual array when the test set the cancelInterruptable mock return.

If the test references `ttsSlot`, remove that dependency from the dep object (the new controller doesn't take it).

Add a new test case at the bottom of the existing describe block:

```ts
it("forwards cancelInterruptable's returned ids into playback.stop", () => {
  const wire = { sendPlaybackStop: vi.fn() };
  const taskManager = { cancelInterruptable: vi.fn().mockReturnValue(["T-X", "T-Y"]) };
  const cycleSlot = { currentId: () => "C-9", cancelCurrent: vi.fn() } as unknown as AbortSlot;
  const stagedIds: string[][] = [];
  const ctrl = createInterruptController({
    cycleSlot,
    taskManager,
    wire: wire as SessionAudioWire,
    onInterruptStaged: (ids) => stagedIds.push([...ids]),
    attentionGate: { clearPendingConversationSalience: () => {} },
  });

  ctrl.trigger();

  expect(wire.sendPlaybackStop).toHaveBeenCalledWith("C-9", "interrupt", ["T-X", "T-Y"]);
  expect(stagedIds[0]).toEqual(["T-X", "T-Y"]);
});
```

If the test file isn't already importing `AbortSlot`, `SessionAudioWire`, `vi`, add them.

- [ ] **Step 4: Run the test**

```bash
cd gateway && bun run test src/session-handlers/interrupt-controller.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Run the wire + barge-in tests too (regression check)**

```bash
cd gateway && bun run test src/session-handlers/session-audio-wire.test.ts src/session-handlers/barge-in-controller.test.ts src/session-handlers/interrupt-controller.test.ts
```

Expected: all pass.

- [ ] **Step 6: Commit (wire + both controllers + task-manager hasRunningTerminal)**

From repo root:

```bash
git add gateway/src/session-handlers/session-audio-wire.ts gateway/src/session-handlers/session-audio-wire.test.ts gateway/src/session-handlers/barge-in-controller.ts gateway/src/session-handlers/barge-in-controller.test.ts gateway/src/session-handlers/interrupt-controller.ts gateway/src/session-handlers/interrupt-controller.test.ts gateway/src/cerebrum/task-manager.ts gateway/src/cerebrum/task-manager.test.ts
git commit -m "refactor(session): barge-in cancels terminal tasks; playback.stop carries cancelledTaskIds"
```

---

## Task 12: Cognitive cycle — strip content-TTS plumbing; shouldContinue ignores terminal; suppress skipped-terminal entries

**Files:**
- Modify: `gateway/src/cerebrum/cognitive-cycle.ts`
- Modify: `gateway/src/cerebrum/cognitive-cycle.test.ts`

**Background:** Three changes:

1. Remove all `contentTTS` / `ttsPipeline` plumbing (lines 8-9, 79, 104-119, 191-230, 376, 400-427).
2. `shouldContinue` ignores tool calls whose effect is `terminal: true`.
3. When the wrapper returns `{ ok: true, data: { __skippedByCapability: true } }` for a terminal effect, do NOT commit a tool entry.
4. The `cutoff` derivation no longer reads ttsController — barge-in does not abort the cycle anymore. Barge-in cutoff is now signaled differently (today, on the assistant entry, was for the auto-TTS scenario). With speak-as-tool, barge-in cutoff lives on the speak tool entry's status. For now, simplify: cycle's cutoff field is set ONLY when the cycle was hard-aborted (interrupt). Barge-in cutoffs surface on tool entries via `mapToolStatus` (already returns "cancelled" for aborted effects).

- [ ] **Step 1: Source env**

```bash
source scripts/env.sh
```

- [ ] **Step 2: Trim imports**

Edit `gateway/src/cerebrum/cognitive-cycle.ts`. Remove these imports at lines 8-9:

```ts
import type { ContentAudioSink, ContentTTSPipeline, ContentTTSPipelineOptions } from "./content-tts-pipeline.js";
import { startContentTTSPipeline } from "./content-tts-pipeline.js";
```

- [ ] **Step 3: Remove `contentTTS` from `CognitiveCycleDeps`**

In the same file, find the `CognitiveCycleDeps` interface (line 61). Delete the entire `contentTTS?: CognitiveCycleContentTTSDeps | undefined;` field (lines 72-79 of the original block — covers the JSDoc + the field itself).

Also delete the entire `CognitiveCycleContentTTSDeps` interface (lines 104-119).

The `grantedCapabilities: ReadonlySet<string>;` field on CognitiveCycleDeps is no longer used by the cycle (the wrapper handles the capability check now). Delete that field too.

- [ ] **Step 4: Remove ttsPipeline construction inside `runCognitiveCycle`**

Find the block at lines 191-230 (starts with `// Auto-TTS: per-cycle pipeline...`). Delete the entire block from `const ttsController = new AbortController();` through to the closing brace right before `// Determine how this cycle is ending:`. Keep the `// Determine ...` comment block.

After deletion, the `consumeStream` call (line 205) should no longer reference `ttsPipeline`. Update its signature: open `consumeStream`'s definition (line 350) and remove the `ttsPipeline: ContentTTSPipeline | null,` parameter and the `ttsPipeline?.pushDelta(chunk.content);` line inside the loop (line 376). Also update the `consume-stream-start` log line `ttsEnabled` field — just remove that field from the log payload.

The call site `await consumeStream(stream, coordinator, cycleId, deps.wsSend, ttsPipeline, abortSignal)` becomes `await consumeStream(stream, coordinator, cycleId, deps.wsSend, abortSignal)`.

- [ ] **Step 5: Remove `maybeStartContentTTS`**

Delete the entire function `maybeStartContentTTS` (lines 398-427).

- [ ] **Step 6: Update `determineCutoff`**

The cutoff function takes a `ttsSignal` arg that no longer exists. Change the function signature and body. Replace lines 317-334 with:

```ts
function determineCutoff(
  cycleSignal: AbortSignal,
  deps: CognitiveCycleDeps,
): AssistantCutoff | undefined {
  if (cycleSignal.aborted) {
    const cancelledTaskIds = deps.consumeInterruptCancelledTaskIds?.() ?? [];
    return { kind: "interrupt", cancelledTaskIds: [...cancelledTaskIds] };
  }
  return undefined;
}
```

Update the call site: `const cutoff = determineCutoff(abortSignal, ttsController.signal, deps);` becomes `const cutoff = determineCutoff(abortSignal, deps);`.

- [ ] **Step 7: Update `shouldContinue` to ignore terminal effects**

Around line 288, change:

```ts
    const shouldContinue = forceFinal ? false : effectResults.length > 0;
    if (shouldContinue) {
      log.debug("continuation-trigger", { cycleId, effectsInvoked: effectResults.length });
    }
```

to:

```ts
    const nonTerminalCount = countNonTerminalResults(effectResults, deps.effects);
    const shouldContinue = forceFinal ? false : nonTerminalCount > 0;
    if (shouldContinue) {
      log.debug("continuation-trigger", { cycleId, nonTerminalCount, totalResults: effectResults.length });
    }
```

Add a new helper at the bottom of the file (above the final `// Abort handling` block):

```ts
function countNonTerminalResults(
  results: readonly EffectDispatchResult[],
  effects: readonly EffectDefinition[],
): number {
  const terminalNames = new Set<string>();
  for (const e of effects) if (e.terminal === true) terminalNames.add(e.name);
  let count = 0;
  for (const r of results) if (!terminalNames.has(r.toolName)) count += 1;
  return count;
}
```

- [ ] **Step 8: Suppress tool entries for skipped-terminal results**

Find `appendToolEntries` (line 476). Update the loop to skip results whose `result.data.__skippedByCapability === true`:

```ts
function appendToolEntries(
  config: CognitiveCycleConfig,
  deps: CognitiveCycleDeps,
  effectResults: EffectDispatchResult[],
): void {
  const { cycleId } = config;
  for (const er of effectResults) {
    if (isSkippedByCapability(er)) {
      log.debug("skip-tool-entry-capability-skipped", {
        cycleId,
        toolName: er.toolName,
        taskId: er.taskId,
      });
      continue;
    }
    deps.conversationHistory.append({
      kind: "tool",
      cycleId,
      taskId: er.taskId,
      toolName: er.toolName,
      status: mapToolStatus(er),
      summary: summarizeToolArgs(er.toolName, er.args),
    });
  }
}

function isSkippedByCapability(er: EffectDispatchResult): boolean {
  if (!er.result || er.result.ok !== true) return false;
  const data = er.result.data as { __skippedByCapability?: boolean } | undefined;
  return data?.__skippedByCapability === true;
}
```

- [ ] **Step 9: Test the helper directly (cycle-level coverage handled by smoke test)**

Adding a full cycle-level test for the new `shouldContinue` rule is high-friction (the existing `cognitive-cycle.test.ts` fixtures don't easily admit a terminal-tool case). The integration smoke test in Task 16 covers the end-to-end behavior. For unit-level coverage of the rule itself, add a small test for the `countNonTerminalResults` helper. Append to `gateway/src/cerebrum/cognitive-cycle.test.ts` (before the file's final closing brace):

```ts
describe("countNonTerminalResults (helper)", () => {
  // The helper isn't exported. To test it we'd need to export it. Two options:
  //   A) export it from cognitive-cycle.ts (preferred — tiny surface, clear test)
  //   B) skip this unit test and rely on the integration smoke test
  // If you take A, add `export` to the helper definition in cognitive-cycle.ts
  // and import it here:
  //   import { countNonTerminalResults } from "./cognitive-cycle.ts";
  // Then add:
  //
  // it("counts only non-terminal effects", () => {
  //   const effects = [
  //     { name: "speak", terminal: true } as unknown as EffectDefinition,
  //     { name: "read", terminal: false } as unknown as EffectDefinition,
  //   ];
  //   const results = [
  //     { toolName: "speak", toolCallId: "T-1", taskId: "T-1", args: {}, result: { ok: true } },
  //     { toolName: "read", toolCallId: "T-2", taskId: "T-2", args: {}, result: { ok: true } },
  //   ] as unknown as EffectDispatchResult[];
  //   expect(countNonTerminalResults(results, effects)).toBe(1);
  // });
});
```

If you take option A, add `export` to the helper in `cognitive-cycle.ts` and uncomment the test body. Otherwise leave the file as-is and rely on Task 16's smoke test.

- [ ] **Step 10: Update other tests for the removed `grantedCapabilities` field on CognitiveCycleDeps**

Run: `grep -rn "grantedCapabilities" gateway/src/`

Each remaining occurrence on a `CognitiveCycleDeps` literal should be DELETED (the field is gone). Each occurrence on an `EffectWrapperDeps` literal must be a getter `() => set` (already done in Task 7).

- [ ] **Step 11: Update the consumer in ws-session-configure.ts**

Edit `gateway/src/session-handlers/ws-session-configure.ts`. In the `cycleDeps` literal (around line 358), DELETE these lines:

```ts
          grantedCapabilities: capSet,
```

```ts
          ...(services.contentTTSOptions
            ? {
                contentTTS: {
                  ...
                },
              }
            : {}),
```

(The whole spread object that builds `contentTTS`. Remove the entire `...(services.contentTTSOptions ...)` block.)

Also delete the helper function `shouldEmitAudio` (around line 577) and its callers — search for it: `grep -n "shouldEmitAudio" gateway/src/session-handlers/ws-session-configure.ts`. Remove the function and its import if separate.

Delete the `ttsSlot` creation (around line 301: `const ttsSlot = createAbortSlot("tts");`) and remove `ttsSlot` from `bargeInController` deps (around line 307).

Update `bargeInController` construction. Replace:

```ts
  const bargeInController = createBargeInController({
    cycleSlot,
    ttsSlot,
    wire,
    graceWindowMs: services.session.tts_drain_grace_ms,
  });
```

with:

```ts
  const bargeInController = createBargeInController({
    taskManager,
    wire,
    currentCycleId: () => cycleSlot.currentId(),
  });
```

Update `interruptController` construction. Replace:

```ts
  const interruptController = createInterruptController({
    cycleSlot,
    ttsSlot,
    taskManager,
    wire,
    onInterruptStaged: (ids) => stagedInterruptedTaskIds.push(...ids),
    attentionGate: attentionGateProxy,
  });
```

with (drop `ttsSlot`):

```ts
  const interruptController = createInterruptController({
    cycleSlot,
    taskManager,
    wire,
    onInterruptStaged: (ids) => stagedInterruptedTaskIds.push(...ids),
    attentionGate: attentionGateProxy,
  });
```

- [ ] **Step 12: Typecheck**

```bash
cd gateway && bun run typecheck
```

Expected: passes (after all the deletions). If you see errors about unused imports — remove them. If you see errors about `ContentAudioSink`, `ContentTTSPipelineOptions` still imported in ws-session-configure.ts — remove those too.

- [ ] **Step 13: Run the full gateway test suite**

```bash
cd gateway && bun run test
```

Expected: most tests pass. Some `cognitive-cycle.test.ts` tests may fail if they relied on the `grantedCapabilities` or `contentTTS` deps. Update those tests to remove the now-deleted fields.

- [ ] **Step 14: Commit**

From repo root:

```bash
git add gateway/src/cerebrum/cognitive-cycle.ts gateway/src/cerebrum/cognitive-cycle.test.ts gateway/src/session-handlers/ws-session-configure.ts
git commit -m "refactor(cerebrum): remove content-TTS plumbing; shouldContinue ignores terminal effects"
```

---

## Task 13: ContextAssembler — switch task table to snapshotForLLM, update system prompt

**Files:**
- Modify: `gateway/src/cerebrum/short-term-context.ts`
- Modify: `gateway/src/cerebrum/context-assembler.ts`
- Modify: `gateway/src/cerebrum/context-assembler.test.ts`

- [ ] **Step 1: Source env**

```bash
source scripts/env.sh
```

- [ ] **Step 2: Switch the task-table source**

Edit `gateway/src/cerebrum/short-term-context.ts:111`. Find `return taskManager.snapshot(window).map(...)` and change `snapshot` to `snapshotForLLM`:

```ts
return taskManager.snapshotForLLM(window).map((row) => ({
  // ...same shape as before...
}));
```

- [ ] **Step 3: Update the buildMemorySurfaceGuide system prompt**

Edit `gateway/src/cerebrum/context-assembler.ts`. Replace the `buildMemorySurfaceGuide` function (currently lines 80-112) with:

```ts
function buildMemorySurfaceGuide(): string {
  return [
    "# Your reply has two channels",
    "",
    "Each turn you produce both:",
    "",
    "- **content** (markdown, code blocks, tables, links): always rendered in",
    "  the chat surface. The user SEES this. Use it for rich text, code,",
    "  references — anything that benefits from being read.",
    "",
    "- **speak(text) tool**: the only way the user HEARS something. Call it",
    "  when audio is appropriate. Provide TTS-friendly prose that mirrors",
    "  the spoken essence of your `content` (strip markdown, code, URLs",
    "  — preserve meaning + good punctuation for natural pacing). You may",
    "  call speak multiple times per turn (status before tool, summary after).",
    "  speak is a *terminal* tool: a turn whose only tool calls are speak",
    "  (or no tool calls at all) ends the ReAct loop.",
    "",
    "Read the **Session Preferences** table in the per-cycle block below",
    "before deciding whether to call speak. The `channel` setting is",
    "authoritative: `text` = do not call speak; `voice` = prefer speak;",
    "`auto` = decide from context (short conversational reply → speak;",
    "long markdown report meant to be read → skip).",
    "",
    "# Your memory",
    "",
    "You have two session-memory surfaces.",
    "",
    "1. **Conversation History** (at the tail of this prompt): a timestamped timeline.",
    "   Each line: `[HH:MM:SS] [user/<channel>|trigger|assistant|tool] <content>`.",
    "   - `user/speech`, `user/text`, `user/barge-in`: what the user just did.",
    "   - `trigger`: non-user events (sensors — future).",
    "   - `assistant`: your prior cycle-level narrative.",
    "   - `tool`: actions you invoked, with `taskId`, `status`, `summary`.",
    "   This surface is complete for normal dialog.",
    "",
    "2. **Task Table** (in the per-cycle system block below): running and recently",
    "   completed *non-terminal* actions. Columns: `taskId | effect | status |",
    "   summary | has_result`. Terminal tasks like `speak` do NOT appear here —",
    "   their output is the audio the user heard, not a row to track.",
    "   When `has_result=yes`, the detailed output is available under Situation",
    "   Awareness, keyed by `taskId`. Look it up only when you need the detail.",
    "",
    "# How you act",
    "",
    "- Every tool call MUST include a `summary` argument: one short line (≤15 words)",
    "  describing what the action does. That summary is how you remember it next cycle.",
    "- Your top-level assistant content MUST be a brief one-sentence cycle narrative.",
    "  This becomes the `[assistant]` entry next turn — make it specific.",
    "- When anything is unclear, ask the user instead of guessing.",
  ].join("\n");
}
```

- [ ] **Step 4: Update the priority-template default**

In `gateway/src/session-handlers/ws-session-configure.ts:660`, find `priorityTemplate` default. Replace:

```ts
      cerebrum?.cycle.priority_template ??
      "You perceive new events since your last thought. Choose one or more " +
        "tool calls from the enabled tool list to respond appropriately. Speak " +
        "(the `speak` tool) only if you have something useful to say. Prefer " +
        "concise replies for voice.",
```

with:

```ts
      cerebrum?.cycle.priority_template ??
      "You perceive new events since your last thought. Choose one or more " +
        "tool calls from the enabled tool list to respond appropriately. Use " +
        "`speak` only when the user should HEAR your reply. Prefer concise " +
        "replies for voice.",
```

- [ ] **Step 5: Update assertions in `context-assembler.test.ts`**

Run: `grep -n "Use \`speak\`\|Use \`write\`\|memorySurface\|buildMemorySurface" gateway/src/cerebrum/context-assembler.test.ts`

For any assertion that matches the OLD strings (e.g., `Use \`speak\` for what the user hears`), update it to match the NEW strings introduced above. Adjust as needed; the tests should test stable invariants (e.g., "the system message contains a description of speak"), not exact strings — but if exact strings are asserted, update them.

- [ ] **Step 6: Run context-assembler tests**

```bash
cd gateway && bun run test src/cerebrum/context-assembler.test.ts src/cerebrum/short-term-context.test.ts
```

Expected: all pass. Update any assertions broken by the prompt changes.

- [ ] **Step 7: Commit**

From repo root:

```bash
git add gateway/src/cerebrum/short-term-context.ts gateway/src/cerebrum/context-assembler.ts gateway/src/cerebrum/context-assembler.test.ts gateway/src/session-handlers/ws-session-configure.ts
git commit -m "feat(cerebrum): two-channel system prompt; task table hides terminal tasks"
```

---

## Task 14: Bootstrap — wire FishAudioStreamSynthesizer; register speak effect; remove contentTTSOptions

**Files:**
- Modify: `gateway/src/bootstrap/create-gateway-services.ts`
- Modify: `gateway/src/bootstrap/create-gateway-services.test.ts`
- Modify: `gateway/src/session-handlers/ws-session-configure.ts`

- [ ] **Step 1: Source env**

```bash
source scripts/env.sh
```

- [ ] **Step 2: Read the existing bootstrap to understand what to replace**

```bash
sed -n '1,80p' gateway/src/bootstrap/create-gateway-services.ts
```

Note where `contentTTSOptions` is built. We're replacing it with a `textStreamSynthesizer` field.

- [ ] **Step 3: Update `GatewayServices` shape**

Edit `gateway/src/bootstrap/create-gateway-services.ts`. In the `GatewayServices` interface, REPLACE:

```ts
  readonly contentTTSOptions: ContentTTSPipelineOptions | null;
```

with:

```ts
  readonly textStreamSynthesizer: TextStreamSynthesizer | null;
```

Add the import at the top:

```ts
import type { TextStreamSynthesizer } from "../tts/text-stream-synthesizer.js";
import { createFishAudioSynthesizer } from "../providers/tts/fish-audio-synthesizer.js";
```

Remove the now-unused `ContentTTSPipelineOptions` import.

- [ ] **Step 4: Replace the `buildContentTTSOptions` call with synthesizer construction**

Find the line in `createGatewayServices` that builds `contentTTSOptions`:

```ts
const contentTTSOptions = buildContentTTSOptions(cfg, llmProvider, tts?.createTTSProvider ?? null);
```

Replace with:

```ts
const textStreamSynthesizer = buildTextStreamSynthesizer(cfg, tts?.createTTSProvider ?? null);
```

Replace the returned-services object's `contentTTSOptions` field with `textStreamSynthesizer`.

Find or create the `buildTextStreamSynthesizer` helper. Add it at the bottom of the file (or replace the existing `buildContentTTSOptions` function entirely):

```ts
function buildTextStreamSynthesizer(
  cfg: StartupConfig,
  createTTSProvider: (() => TTSProvider) | null,
): TextStreamSynthesizer | null {
  if (!createTTSProvider) return null;
  return createFishAudioSynthesizer({
    sessionFactory: { createSession: async () => createTTSProvider() },
    aggregator: () => ({ maxBlockChars: cfg.tts.utterance_max_block_chars }),
    // emotionTags: optionally wire if cfg has them; omit for now if not present.
  });
}
```

If the existing `buildContentTTSOptions` references emotion-tags config or different aggregator options, mirror those into the new helper. Look for the existing function body to copy the right config keys.

If the test file `create-gateway-services.test.ts` references `contentTTSOptions`, change those to `textStreamSynthesizer` (and update assertions: `null` checks stay; non-null shape is now an object with a `synthesize` function).

- [ ] **Step 5: Wire speak into registerEffects**

Edit `gateway/src/session-handlers/ws-session-configure.ts`. Find `registerEffects` (line 604).

Add an extra parameter for the synthesizer. Change the signature:

```ts
function registerEffects(
  capabilities: ReadonlySet<string>,
  taskManager: TaskManager,
  sessionId: string,
  services: GatewayServices,
  preferenceManager: PreferenceManager,
): { effects: EffectDefinition[]; wrappedEffects: Map<string, WrappedEffect> } {
```

stays the same. Inside the function body, around line 614 (the `registered` array), add `createSpeakEffect` AFTER configure if and only if `services.textStreamSynthesizer` is non-null:

```ts
  const registered: EffectDefinition[] = [
    createConfigureEffect({ preferenceManager }) as EffectDefinition,
    createCancelAllTasksEffect({
      cancelAllInterruptable: (reason) => taskManager.cancelInterruptable(reason),
    }) as EffectDefinition,
    createCancelTaskEffect({
      cancelTask: (taskId, reason) => taskManager.cancel(taskId, reason),
    }) as EffectDefinition,
  ];

  if (services.textStreamSynthesizer) {
    registered.push(
      createSpeakEffect({ synthesizer: services.textStreamSynthesizer }) as EffectDefinition,
    );
  }
```

Add the import at the top of the file:

```ts
import { createSpeakEffect } from "../effects/speak-effect.js";
```

- [ ] **Step 6: Wire the capability getter**

Still in `ws-session-configure.ts`, find the `wrapEffect` call inside `registerEffects` (around line 626). Change the static `grantedCapabilities: capabilities` to a getter that derives the live set from preferences each call.

First, add the import at the top:

```ts
import { deriveSessionCapabilities } from "../cerebrum/session-capabilities.js";
```

Then change the `wrapEffect(...)` call from:

```ts
      wrapEffect(def, {
        taskManager,
        grantedCapabilities: capabilities,
        sessionRole: "adult",
        sessionId,
      }),
```

to:

```ts
      wrapEffect(def, {
        taskManager,
        grantedCapabilities: () => deriveSessionCapabilities({
          preferences: preferenceManager.get(),
          baseGranted: capabilities,
        }),
        sessionRole: "adult",
        sessionId,
      }),
```

- [ ] **Step 7: Typecheck and test**

```bash
cd gateway && bun run typecheck
```

Expected: passes. If anything still references `contentTTSOptions`, fix it (search: `grep -rn contentTTSOptions gateway/src/`).

```bash
cd gateway && bun run test
```

Expected: tests pass. Some integration tests in `ws-session-configure` or `bootstrap` may need updates (the field renamed, the speak effect now appears in the effect list).

- [ ] **Step 8: Commit**

From repo root:

```bash
git add gateway/src/bootstrap/create-gateway-services.ts gateway/src/bootstrap/create-gateway-services.test.ts gateway/src/session-handlers/ws-session-configure.ts
git commit -m "feat(bootstrap): wire FishAudioStreamSynthesizer; register speak effect with capability getter"
```

---

## Task 15: Delete content-tts-pipeline

**Files:**
- Delete: `gateway/src/cerebrum/content-tts-pipeline.ts`
- Delete: `gateway/src/cerebrum/content-tts-pipeline.test.ts`

- [ ] **Step 1: Source env**

```bash
source scripts/env.sh
```

- [ ] **Step 2: Verify nothing imports it anymore**

```bash
grep -rn "content-tts-pipeline\|ContentTTSPipeline\|startContentTTSPipeline\|ContentAudioSink" gateway/src/
```

Expected: no results (everything was removed in Tasks 12 and 14). If any results appear, fix the importer first.

- [ ] **Step 3: Delete the files**

```bash
rm gateway/src/cerebrum/content-tts-pipeline.ts gateway/src/cerebrum/content-tts-pipeline.test.ts
```

- [ ] **Step 4: Typecheck and test**

```bash
cd gateway && bun run typecheck && bun run test
```

Expected: all pass.

- [ ] **Step 5: Commit**

From repo root:

```bash
git add -A gateway/src/cerebrum/
git commit -m "chore(cerebrum): delete content-tts-pipeline (replaced by speak effect)"
```

---

## Task 16: Final integration check + smoke test

**Files:**
- (No new files; this task verifies the whole stack.)

- [ ] **Step 1: Source env**

```bash
source scripts/env.sh
```

- [ ] **Step 2: Run the full local CI**

```bash
cd gateway && bun run ci
```

Expected: lint + typecheck + tests all pass. Fix any remaining issues. Common issues:

- A test still references `contentTTSOptions` in a fixture builder → rename to `textStreamSynthesizer`.
- A fixture handle for `TaskHandle` lacks `terminal: false` → add it.
- A test expects the old `playback.stop` shape (without `cancelledTaskIds`) → update to include the array.

- [ ] **Step 3: Run the entire workspace's tests**

From repo root:

```bash
bun run test
```

Expected: all packages pass (gateway, webui, web-sdk, protocol, etc.). The webui/web-sdk should NOT need any code changes — they already parse `connector.audio.start/frame/done { taskId }` and tolerate `playback.stop`'s extra `cancelledTaskIds` field as additive metadata. If they break, read the failure carefully — the SDK may have a strict schema parser that requires the new field. If it does, add `cancelledTaskIds: z.array(z.string())` (no default; required) to its schema.

- [ ] **Step 4: Manually smoke-test the speak path**

Per project rule: verify against real containers before claiming done. Steps:

```bash
# Stop any running sentient containers that might hold ports.
docker ps --format "table {{.Names}}\t{{.Ports}}" | grep sentient

# If any are running, stop them:
# docker stop <name> ...

cd deploy/docker
docker compose up -d --build
```

Tail the gateway logs:

```bash
docker logs -f sentient-gateway
```

In another terminal, open the webui (per the dev URL printed by docker — typically http://localhost:8888 or similar). Send a text or voice message that should produce a spoken reply.

Watch the logs for:

- `effect-wrapper register` with `effectName: "speak"` and `terminal: true`
- `speak speak-start` with a text length
- `fish-audio-synthesizer synthesize-start`
- `fish-audio-synthesizer frame-yield` (multiple)
- `speak speak-done`

Watch the browser for: audio plays end-to-end.

Test barge-in: speak a long reply, then start speaking yourself mid-playback. Confirm:
- Audio cuts off in the browser.
- Logs show `barge-in trigger` and `cancel-terminal` with the speak task id.
- `playback.stop` arrives at the client with `cancelledTaskIds: ["<speak task id>"]`.

Test text-only mode: in the UI, switch channel preference to `text` (via the configure tool, e.g., type "switch to text only"). Send another message that would normally produce speech. Confirm:
- No audio plays.
- Logs show `terminal-effect-blocked-by-capability` with `effect: "speak"`.
- No tool entry for the skipped speak shows up in the chat history.

- [ ] **Step 5: Commit any final fixes**

If the smoke test surfaced bugs, fix them and commit:

```bash
git add -A
git commit -m "fix(speak): <describe the fix>"
```

- [ ] **Step 6: Push the feature branch and open a PR to develop**

```bash
git push -u origin feature/speak-as-terminal-tool
```

PR title: `feat: speak as terminal tool — TTS as an LLM-callable effect`

PR body:

```
## Summary

- Ports TTS out of the auto-content pipeline into an explicit `speak` tool the model invokes per cycle.
- Introduces a `terminal: true` effect category — cycles with only terminal calls end the ReAct loop.
- Adds session-derived capability gate: `channel: text` revokes `audio.output`; speak is silently skipped with a WARN.
- Splits orchestration (`speak-effect.ts`) from TTS provider (`TextStreamSynthesizer` interface; Fish Audio implementation).
- TaskManager hides terminal tasks from SDK lifecycle events and from the LLM's task table.
- `playback.stop` carries `cancelledTaskIds` so client knows exactly which speeches were killed.

## Test plan

- [ ] `bun run ci` is green
- [ ] Speak path works end-to-end via webui (text + voice)
- [ ] Barge-in stops audio and emits playback.stop with the speak task id
- [ ] `channel: text` mode silently drops speak with a WARN log
- [ ] Multi-speak in one cycle plays in order
```

---

## Self-review checklist

Run after completing all tasks:

1. **Spec coverage:** Read `docs/superpowers/specs/2026-04-19-speak-as-terminal-tool-design.md` section by section. Tick off:
   - §3.1 terminal flag → Task 2
   - §3.2 speak definition → Task 8
   - §3.3 tool description → Task 8 (string content)
   - §3.4 system-prompt addition → Task 13
   - §4.1 capability model → Task 4
   - §4.2 dynamic tool list — NOTE: per-cycle filter not implemented (the wrapper's runtime check covers it; we did not filter the static effect list). If you want the dynamic list, additionally filter `effects` by `requires ⊆ session.capabilities()` inside `assemble()` of `context-assembler.ts`. Add as a follow-up task or here.
   - §4.3 capability miss behavior → Task 7
   - §5 two-layer split → Tasks 5, 6, 8
   - §6 cancellation primitives → Tasks 3, 10, 11
   - §7 ConversationHistory representation → Tasks 12 (skip-on-capability rule) + existing schema
   - §8.1 wire signals → Task 1, 9
   - §8.2 visibility filters → Task 3 (TaskManager methods), Task 13 (assembler switch)
   - §9 files added/modified/deleted → all tasks; final state matches.

2. **Placeholder scan:** No "TBD" / "TODO" / "implement later" anywhere in the implementation files. The plan above is concrete throughout.

3. **Type consistency:**
   - `TaskHandle.terminal: boolean` consistent across Tasks 3, 7, 10.
   - `TaskManager.cancelTerminal(reason)` returns `readonly string[]` consistent across Tasks 3, 10.
   - `wire.sendPlaybackStop(cycleId, reason, cancelledTaskIds)` consistent across Tasks 9, 10, 11.
   - `EffectWrapperDeps.grantedCapabilities: () => ReadonlySet<string>` consistent across Tasks 7, 14.
   - `TextStreamSynthesizer.synthesize(stream, signal): AsyncIterable<AudioFrame>` consistent across Tasks 5, 6, 8.
   - `__skippedByCapability: boolean` marker consistent across Tasks 7, 12.

4. **Open follow-up (NOT in this plan, may want a separate ticket):**
   - Dynamic effect-list filter inside `context-assembler.assemble()` for full §4.2 coverage. Today the wrapper's runtime gate is the only enforcement, which means a mis-channeled session wastes tokens describing speak in the system prompt. Cheap to add: filter `effects` by capability before `buildSalienceGatedTools`.
   - `spokenChars` field on the speak tool entry (spec §7) — would need plumbing from the synthesizer back through the handler. Not load-bearing for the core port; nice-to-have for diagnostics.
