# Cancel Primitives Cleanup — Implementation Plan (Phase 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `SessionAudioController` with five focused units (`AbortSlot`, `SessionAudioWire`, `BargeInController`, `InterruptController`, unchanged `TaskManager`). Rename the `interrupt` LLM tool to `cancel_all_tasks` with narrowed semantics. Add a `cancel_task` tool. Make voice barge-in abort the cycle's LLM stream. Thread `cycleId` through `TaskSnapshotItem`.

**Architecture:** Each cancel primitive does exactly one thing; composition happens at call sites. Cycle-abort authority moves out of the audio controller into a single-slot registry (`cycleSlot`). TTS abort authority moves into a matching `ttsSlot`. Wire-message emission lives in `SessionAudioWire`. `BargeInController` and `InterruptController` compose these primitives. The model-facing cancel tool no longer aborts the cycle — cycle winds down naturally after the model stops emitting.

**Tech Stack:** Bun + TypeScript strict, Vitest, zod, cockatiel (existing). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-04-18-cerebrum-ux-refresh-design.md` §3 (Phase 1).

**Branch:** `feature/cerebrum-ux-refresh` (already exists).

---

## File Map

### Create
- `gateway/src/session-handlers/abort-slot.ts` — generic single-slot registry
- `gateway/src/session-handlers/abort-slot.test.ts`
- `gateway/src/session-handlers/session-audio-wire.ts` — wire-message emitter
- `gateway/src/session-handlers/session-audio-wire.test.ts`
- `gateway/src/session-handlers/barge-in-controller.ts`
- `gateway/src/session-handlers/barge-in-controller.test.ts`
- `gateway/src/session-handlers/interrupt-controller.ts`
- `gateway/src/session-handlers/interrupt-controller.test.ts`
- `gateway/src/effects/cancel-all-tasks-effect.ts` (renamed from `interrupt-effect.ts`)
- `gateway/src/effects/cancel-all-tasks-effect.test.ts`
- `gateway/src/effects/cancel-task-effect.ts`
- `gateway/src/effects/cancel-task-effect.test.ts`

### Delete
- `gateway/src/session-handlers/session-audio-controller.ts`
- `gateway/src/session-handlers/session-audio-controller.test.ts` (if exists)
- `gateway/src/effects/interrupt-effect.ts`
- `gateway/src/effects/interrupt-effect.test.ts`

### Modify
- `shared/protocol/src/messages.ts` — add `cycleId` to `taskUpdateSchema`
- `shared/web-sdk/src/connectors/task-status-connector.ts` — add `cycleId` to `TaskSnapshotItem` + parser
- `gateway/src/cerebrum/task-manager.ts` — thread `cycleId` through register/snapshot/lifecycle
- `gateway/src/cerebrum/cognitive-cycle.ts` — register cycle's `AbortController` with `cycleSlot` at entry, complete at exit; pass `cycleId` into task dispatch context
- `gateway/src/cerebrum/cognitive-cycle-dispatch.ts` — thread `cycleId` when registering tasks
- `gateway/src/cerebrum/content-tts-pipeline.ts` — register TTS `AbortController` with `ttsSlot`
- `gateway/src/session-handlers/ws-handlers.ts` — route `{ type: "interrupt" }` to `InterruptController.trigger()`
- `gateway/src/session-handlers/ws-session-configure.ts` — route mic-onset to `BargeInController.trigger()`; wire the new components
- `gateway/config.yaml` — add `audio.ttsDrainGraceMs: 2000`
- Effect-registration call-site (grep `createInterruptEffect`) — replace with `createCancelAllTasksEffect` + `createCancelTaskEffect`
- Any system-prompt fragment referencing the `interrupt` tool name

---

## Tasks

### Task 1: Scaffold `AbortSlot`

**Files:**
- Create: `gateway/src/session-handlers/abort-slot.ts`
- Test: `gateway/src/session-handlers/abort-slot.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// gateway/src/session-handlers/abort-slot.test.ts
import { describe, expect, it, vi } from "vitest";
import { createAbortSlot } from "./abort-slot.js";

describe("AbortSlot", () => {
  it("returns null currentId when empty", () => {
    const slot = createAbortSlot("test");
    expect(slot.currentId()).toBeNull();
  });

  it("returns registered id from currentId", () => {
    const slot = createAbortSlot("test");
    slot.register("cycle-1", new AbortController());
    expect(slot.currentId()).toBe("cycle-1");
  });

  it("clears id on complete when id matches", () => {
    const slot = createAbortSlot("test");
    slot.register("cycle-1", new AbortController());
    slot.complete("cycle-1");
    expect(slot.currentId()).toBeNull();
  });

  it("ignores complete when id does not match current", () => {
    const slot = createAbortSlot("test");
    slot.register("cycle-1", new AbortController());
    slot.complete("cycle-2");
    expect(slot.currentId()).toBe("cycle-1");
  });

  it("cancelCurrent aborts controller and returns id", () => {
    const slot = createAbortSlot("test");
    const ctrl = new AbortController();
    slot.register("cycle-1", ctrl);
    const id = slot.cancelCurrent("reason-x");
    expect(id).toBe("cycle-1");
    expect(ctrl.signal.aborted).toBe(true);
  });

  it("cancelCurrent returns null when empty", () => {
    const slot = createAbortSlot("test");
    expect(slot.cancelCurrent("r")).toBeNull();
  });

  it("onComplete fires with id when complete is called", () => {
    const slot = createAbortSlot("test");
    const listener = vi.fn();
    slot.onComplete(listener);
    slot.register("cycle-1", new AbortController());
    slot.complete("cycle-1");
    expect(listener).toHaveBeenCalledWith("cycle-1");
  });

  it("onComplete does not fire on cancelCurrent", () => {
    const slot = createAbortSlot("test");
    const listener = vi.fn();
    slot.onComplete(listener);
    slot.register("cycle-1", new AbortController());
    slot.cancelCurrent("r");
    expect(listener).not.toHaveBeenCalled();
  });

  it("onComplete unsubscribe stops future notifications", () => {
    const slot = createAbortSlot("test");
    const listener = vi.fn();
    const unsub = slot.onComplete(listener);
    unsub();
    slot.register("cycle-1", new AbortController());
    slot.complete("cycle-1");
    expect(listener).not.toHaveBeenCalled();
  });

  it("register overwrites previous slot and logs warn", () => {
    const slot = createAbortSlot("test");
    const first = new AbortController();
    slot.register("cycle-1", first);
    slot.register("cycle-2", new AbortController());
    expect(slot.currentId()).toBe("cycle-2");
    // first controller left intact — caller's responsibility to clean up
    expect(first.signal.aborted).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```
cd gateway && bun test src/session-handlers/abort-slot.test.ts
```
Expected: FAIL — module `./abort-slot.js` not found.

- [ ] **Step 3: Implement `AbortSlot`**

```typescript
// gateway/src/session-handlers/abort-slot.ts
import { getLog } from "../logging/logger.js";

export interface AbortSlot {
  register(id: string, controller: AbortController): void;
  complete(id: string): void;
  cancelCurrent(reason: string): string | null;
  currentId(): string | null;
  onComplete(listener: (id: string) => void): () => void;
}

/**
 * Single-slot registry for an AbortController. One producer registers its
 * controller with an id at start; it (or someone else) calls `complete` at
 * natural end, or `cancelCurrent` to abort mid-flight. `onComplete` fires
 * only on natural completion — never on cancel.
 */
export function createAbortSlot(name: string): AbortSlot {
  const log = getLog(["sentient", "session-handlers", "abort-slot", name]);
  let currentId: string | null = null;
  let controller: AbortController | null = null;
  const listeners = new Set<(id: string) => void>();

  return {
    register(id, ctrl) {
      if (currentId !== null) {
        log.warn("register-over-existing", { previousId: currentId, newId: id });
      }
      currentId = id;
      controller = ctrl;
      log.debug("registered", { id });
    },
    complete(id) {
      if (currentId !== id) {
        log.debug("complete-id-mismatch", { currentId, requestedId: id });
        return;
      }
      const completedId = currentId;
      currentId = null;
      controller = null;
      log.debug("completed", { id: completedId });
      for (const l of listeners) l(completedId);
    },
    cancelCurrent(reason) {
      if (currentId === null || controller === null) return null;
      const cancelledId = currentId;
      log.info("cancel", { id: cancelledId, reason });
      controller.abort(reason);
      currentId = null;
      controller = null;
      return cancelledId;
    },
    currentId() {
      return currentId;
    },
    onComplete(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```
cd gateway && bun test src/session-handlers/abort-slot.test.ts
```
Expected: all 10 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add gateway/src/session-handlers/abort-slot.ts gateway/src/session-handlers/abort-slot.test.ts
git commit -m "feat(gateway): add AbortSlot single-slot registry"
```

---

### Task 2: Scaffold `SessionAudioWire`

**Files:**
- Create: `gateway/src/session-handlers/session-audio-wire.ts`
- Test: `gateway/src/session-handlers/session-audio-wire.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// gateway/src/session-handlers/session-audio-wire.test.ts
import { describe, expect, it, vi } from "vitest";
import { createSessionAudioWire } from "./session-audio-wire.js";

describe("SessionAudioWire", () => {
  it("sendAudioStart emits correct wire shape", () => {
    const send = vi.fn();
    const wire = createSessionAudioWire({ wsSend: send });
    wire.sendAudioStart("cycle-1");
    expect(send).toHaveBeenCalledWith({ type: "audio.start", cycleId: "cycle-1" });
  });

  it("sendAudioFrame emits frame with cycleId", () => {
    const send = vi.fn();
    const wire = createSessionAudioWire({ wsSend: send });
    const frame = new Uint8Array([1, 2, 3]);
    wire.sendAudioFrame("cycle-1", frame);
    expect(send).toHaveBeenCalledWith({ type: "audio.frame", cycleId: "cycle-1", frame });
  });

  it("sendAudioDone emits done", () => {
    const send = vi.fn();
    const wire = createSessionAudioWire({ wsSend: send });
    wire.sendAudioDone("cycle-1");
    expect(send).toHaveBeenCalledWith({ type: "audio.done", cycleId: "cycle-1" });
  });

  it("sendPlaybackStop emits with reason", () => {
    const send = vi.fn();
    const wire = createSessionAudioWire({ wsSend: send });
    wire.sendPlaybackStop("cycle-1", "barge-in");
    expect(send).toHaveBeenCalledWith({ type: "playback.stop", cycleId: "cycle-1", reason: "barge-in" });
  });

  it("sendPlaybackStop accepts interrupt reason", () => {
    const send = vi.fn();
    const wire = createSessionAudioWire({ wsSend: send });
    wire.sendPlaybackStop("cycle-2", "interrupt");
    expect(send).toHaveBeenCalledWith({ type: "playback.stop", cycleId: "cycle-2", reason: "interrupt" });
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```
cd gateway && bun test src/session-handlers/session-audio-wire.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `SessionAudioWire`**

```typescript
// gateway/src/session-handlers/session-audio-wire.ts
import { getLog } from "../logging/logger.js";

export interface SessionAudioWire {
  sendAudioStart(cycleId: string): void;
  sendAudioFrame(cycleId: string, frame: Uint8Array): void;
  sendAudioDone(cycleId: string): void;
  sendPlaybackStop(cycleId: string, reason: "barge-in" | "interrupt"): void;
}

export interface SessionAudioWireDeps {
  readonly wsSend: (msg: unknown) => void;
}

/**
 * The only component that writes audio-related wire messages. Components
 * that want to emit audio/playback.stop go through this; they do NOT hold
 * a direct reference to the WebSocket send.
 */
export function createSessionAudioWire(deps: SessionAudioWireDeps): SessionAudioWire {
  const log = getLog(["sentient", "session-handlers", "audio-wire"]);
  return {
    sendAudioStart(cycleId) {
      log.debug("send-audio-start", { cycleId });
      deps.wsSend({ type: "audio.start", cycleId });
    },
    sendAudioFrame(cycleId, frame) {
      deps.wsSend({ type: "audio.frame", cycleId, frame });
    },
    sendAudioDone(cycleId) {
      log.debug("send-audio-done", { cycleId });
      deps.wsSend({ type: "audio.done", cycleId });
    },
    sendPlaybackStop(cycleId, reason) {
      log.info("send-playback-stop", { cycleId, reason });
      deps.wsSend({ type: "playback.stop", cycleId, reason });
    },
  };
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```
cd gateway && bun test src/session-handlers/session-audio-wire.test.ts
```
Expected: 5 PASS.

- [ ] **Step 5: Commit**

```bash
git add gateway/src/session-handlers/session-audio-wire.ts gateway/src/session-handlers/session-audio-wire.test.ts
git commit -m "feat(gateway): add SessionAudioWire emitter"
```

---

### Task 3: Add `audio.ttsDrainGraceMs` to config

**Files:**
- Modify: `gateway/config.yaml`
- Modify: `gateway/src/config/config.ts` (or wherever the config schema is declared — grep `audio:` in `gateway/src/config/*.ts`)

- [ ] **Step 1: Add to config.yaml**

Find the existing `audio:` section in `gateway/config.yaml` (or create one if absent). Add:

```yaml
audio:
  # ... existing keys ...
  # Grace window between server TTS completion and the point where the client's
  # audio buffer is assumed drained. Mic-onset within this window still sends
  # playback.stop so the user can interrupt tail audio. WebRTC loopback buffers
  # 200–500ms depending on browser + network; 2000ms is safe.
  ttsDrainGraceMs: 2000
```

- [ ] **Step 2: Extend config schema**

Grep for the zod schema that validates `audio:` and add `ttsDrainGraceMs: z.number().int().positive()` in the same section. Keep the validator strict.

- [ ] **Step 3: Run typecheck + tests**

```
cd gateway && bun run typecheck && bun run test
```
Expected: all green; no new failures.

- [ ] **Step 4: Commit**

```bash
git add gateway/config.yaml gateway/src/config/
git commit -m "feat(config): add audio.ttsDrainGraceMs"
```

---

### Task 4: Scaffold `BargeInController`

**Files:**
- Create: `gateway/src/session-handlers/barge-in-controller.ts`
- Test: `gateway/src/session-handlers/barge-in-controller.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// gateway/src/session-handlers/barge-in-controller.test.ts
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createBargeInController } from "./barge-in-controller.js";
import { createAbortSlot } from "./abort-slot.js";

function fakeWire() {
  return {
    sendAudioStart: vi.fn(),
    sendAudioFrame: vi.fn(),
    sendAudioDone: vi.fn(),
    sendPlaybackStop: vi.fn(),
  };
}

describe("BargeInController", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("no-ops when no TTS active and not within grace window", () => {
    const cycleSlot = createAbortSlot("cycle");
    const ttsSlot = createAbortSlot("tts");
    const wire = fakeWire();
    const ctrl = createBargeInController({ cycleSlot, ttsSlot, wire, graceWindowMs: 1000 });

    ctrl.trigger();

    expect(wire.sendPlaybackStop).not.toHaveBeenCalled();
  });

  it("cancels cycle + TTS and sends playback.stop when TTS active", () => {
    const cycleSlot = createAbortSlot("cycle");
    const ttsSlot = createAbortSlot("tts");
    const wire = fakeWire();
    const ctrl = createBargeInController({ cycleSlot, ttsSlot, wire, graceWindowMs: 1000 });
    const cycleCtrl = new AbortController();
    const ttsCtrl = new AbortController();
    cycleSlot.register("cycle-1", cycleCtrl);
    ttsSlot.register("cycle-1", ttsCtrl);

    ctrl.trigger();

    expect(cycleCtrl.signal.aborted).toBe(true);
    expect(ttsCtrl.signal.aborted).toBe(true);
    expect(wire.sendPlaybackStop).toHaveBeenCalledWith("cycle-1", "barge-in");
  });

  it("within grace window after TTS completes: sends playback.stop, no slot cancels", () => {
    const cycleSlot = createAbortSlot("cycle");
    const ttsSlot = createAbortSlot("tts");
    const wire = fakeWire();
    const ctrl = createBargeInController({ cycleSlot, ttsSlot, wire, graceWindowMs: 1000 });

    ttsSlot.register("cycle-1", new AbortController());
    ttsSlot.complete("cycle-1");

    vi.advanceTimersByTime(500);
    ctrl.trigger();

    // cycle slot is empty — nothing to cancel there
    expect(wire.sendPlaybackStop).toHaveBeenCalledWith("cycle-1", "barge-in");
  });

  it("outside grace window: no-op", () => {
    const cycleSlot = createAbortSlot("cycle");
    const ttsSlot = createAbortSlot("tts");
    const wire = fakeWire();
    const ctrl = createBargeInController({ cycleSlot, ttsSlot, wire, graceWindowMs: 1000 });

    ttsSlot.register("cycle-1", new AbortController());
    ttsSlot.complete("cycle-1");

    vi.advanceTimersByTime(1500);
    ctrl.trigger();

    expect(wire.sendPlaybackStop).not.toHaveBeenCalled();
  });

  it("does not cancel tasks (no taskManager dep)", () => {
    // Structural test — the factory takes no taskManager. Compile-time safety.
    const cycleSlot = createAbortSlot("cycle");
    const ttsSlot = createAbortSlot("tts");
    const wire = fakeWire();
    const ctrl = createBargeInController({ cycleSlot, ttsSlot, wire, graceWindowMs: 1000 });
    expect(ctrl).toBeDefined();
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```
cd gateway && bun test src/session-handlers/barge-in-controller.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `BargeInController`**

```typescript
// gateway/src/session-handlers/barge-in-controller.ts
import { getLog } from "../logging/logger.js";
import type { AbortSlot } from "./abort-slot.js";
import type { SessionAudioWire } from "./session-audio-wire.js";

export interface BargeInController {
  trigger(): void;
  dispose(): void;
}

export interface BargeInControllerDeps {
  readonly cycleSlot: AbortSlot;
  readonly ttsSlot: AbortSlot;
  readonly wire: SessionAudioWire;
  readonly graceWindowMs: number;
}

/**
 * Barge-in gesture: user speech during TTS.
 * Composition: cycle cancel + TTS cancel + wire playback.stop.
 * Does NOT touch tasks — the user may still want them to complete.
 */
export function createBargeInController(deps: BargeInControllerDeps): BargeInController {
  const log = getLog(["sentient", "session-handlers", "barge-in"]);
  let lastTtsEndMs = 0;
  let lastTtsCycleId: string | null = null;

  const unsub = deps.ttsSlot.onComplete((id) => {
    lastTtsEndMs = Date.now();
    lastTtsCycleId = id;
  });

  return {
    trigger(): void {
      const activeTts = deps.ttsSlot.currentId() !== null;
      const withinGrace = Date.now() - lastTtsEndMs < deps.graceWindowMs;
      if (!activeTts && !withinGrace) {
        log.debug("barge-in-skipped-no-active-tts");
        return;
      }
      const cycleId = deps.ttsSlot.currentId() ?? lastTtsCycleId ?? deps.cycleSlot.currentId();
      log.info("barge-in", { cycleId, activeTts, withinGrace });
      deps.cycleSlot.cancelCurrent("barge-in");
      deps.ttsSlot.cancelCurrent("barge-in");
      if (cycleId) deps.wire.sendPlaybackStop(cycleId, "barge-in");
    },
    dispose(): void {
      unsub();
    },
  };
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```
cd gateway && bun test src/session-handlers/barge-in-controller.test.ts
```
Expected: 5 PASS.

- [ ] **Step 5: Commit**

```bash
git add gateway/src/session-handlers/barge-in-controller.ts gateway/src/session-handlers/barge-in-controller.test.ts
git commit -m "feat(gateway): add BargeInController"
```

---

### Task 5: Scaffold `InterruptController`

**Files:**
- Create: `gateway/src/session-handlers/interrupt-controller.ts`
- Test: `gateway/src/session-handlers/interrupt-controller.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// gateway/src/session-handlers/interrupt-controller.test.ts
import { describe, expect, it, vi } from "vitest";
import { createInterruptController } from "./interrupt-controller.js";
import { createAbortSlot } from "./abort-slot.js";

function fakeWire() {
  return {
    sendAudioStart: vi.fn(),
    sendAudioFrame: vi.fn(),
    sendAudioDone: vi.fn(),
    sendPlaybackStop: vi.fn(),
  };
}

function fakeTaskManager(cancelledIds: string[] = []) {
  return {
    cancelInterruptable: vi.fn(() => cancelledIds),
  };
}

describe("InterruptController", () => {
  it("aborts cycle + TTS + cancels tasks + sends playback.stop", () => {
    const cycleSlot = createAbortSlot("cycle");
    const ttsSlot = createAbortSlot("tts");
    const wire = fakeWire();
    const tm = fakeTaskManager(["t1", "t2"]);
    const onStaged = vi.fn();
    const cycleCtrl = new AbortController();
    const ttsCtrl = new AbortController();
    cycleSlot.register("cycle-1", cycleCtrl);
    ttsSlot.register("cycle-1", ttsCtrl);

    const ctrl = createInterruptController({
      cycleSlot,
      ttsSlot,
      taskManager: tm as never,
      wire,
      onInterruptStaged: onStaged,
    });

    ctrl.trigger();

    expect(cycleCtrl.signal.aborted).toBe(true);
    expect(ttsCtrl.signal.aborted).toBe(true);
    expect(tm.cancelInterruptable).toHaveBeenCalledWith("interrupt");
    expect(onStaged).toHaveBeenCalledWith(["t1", "t2"]);
    expect(wire.sendPlaybackStop).toHaveBeenCalledWith("cycle-1", "interrupt");
  });

  it("is idempotent when nothing active", () => {
    const cycleSlot = createAbortSlot("cycle");
    const ttsSlot = createAbortSlot("tts");
    const wire = fakeWire();
    const tm = fakeTaskManager();
    const ctrl = createInterruptController({
      cycleSlot,
      ttsSlot,
      taskManager: tm as never,
      wire,
      onInterruptStaged: vi.fn(),
    });

    ctrl.trigger();

    expect(wire.sendPlaybackStop).not.toHaveBeenCalled();
    expect(tm.cancelInterruptable).toHaveBeenCalledWith("interrupt");
  });

  it("stages empty cancelled list when no tasks running", () => {
    const cycleSlot = createAbortSlot("cycle");
    const ttsSlot = createAbortSlot("tts");
    const wire = fakeWire();
    const tm = fakeTaskManager([]);
    const onStaged = vi.fn();
    cycleSlot.register("cycle-1", new AbortController());
    const ctrl = createInterruptController({
      cycleSlot,
      ttsSlot,
      taskManager: tm as never,
      wire,
      onInterruptStaged: onStaged,
    });

    ctrl.trigger();

    expect(onStaged).toHaveBeenCalledWith([]);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```
cd gateway && bun test src/session-handlers/interrupt-controller.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `InterruptController`**

```typescript
// gateway/src/session-handlers/interrupt-controller.ts
import type { TaskManager } from "../cerebrum/task-manager.js";
import { getLog } from "../logging/logger.js";
import type { AbortSlot } from "./abort-slot.js";
import type { SessionAudioWire } from "./session-audio-wire.js";

export interface InterruptController {
  trigger(): void;
}

export interface InterruptControllerDeps {
  readonly cycleSlot: AbortSlot;
  readonly ttsSlot: AbortSlot;
  readonly taskManager: Pick<TaskManager, "cancelInterruptable">;
  readonly wire: SessionAudioWire;
  readonly onInterruptStaged: (ids: readonly string[]) => void;
}

/**
 * Interrupt gesture: user Stop button or Esc. Full hard stop.
 * Composition: cycle cancel + TTS cancel + task cancel + wire playback.stop.
 * Stages cancelled task ids for the cycle's commit cutoff marker.
 */
export function createInterruptController(deps: InterruptControllerDeps): InterruptController {
  const log = getLog(["sentient", "session-handlers", "interrupt"]);
  return {
    trigger(): void {
      const cycleId = deps.cycleSlot.currentId() ?? deps.ttsSlot.currentId();
      log.info("interrupt", { cycleId });
      deps.cycleSlot.cancelCurrent("interrupt");
      deps.ttsSlot.cancelCurrent("interrupt");
      const cancelled = deps.taskManager.cancelInterruptable("interrupt");
      deps.onInterruptStaged(cancelled);
      if (cycleId) deps.wire.sendPlaybackStop(cycleId, "interrupt");
    },
  };
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```
cd gateway && bun test src/session-handlers/interrupt-controller.test.ts
```
Expected: 3 PASS.

- [ ] **Step 5: Commit**

```bash
git add gateway/src/session-handlers/interrupt-controller.ts gateway/src/session-handlers/interrupt-controller.test.ts
git commit -m "feat(gateway): add InterruptController"
```

---

### Task 6: Add `cycleId` to wire protocol + SDK snapshot

**Files:**
- Modify: `shared/protocol/src/messages.ts:181-195` (taskUpdateSchema)
- Modify: `shared/web-sdk/src/connectors/task-status-connector.ts`

- [ ] **Step 1: Extend `taskUpdateSchema` in the protocol**

In `shared/protocol/src/messages.ts`, update `taskUpdateSchema` to include `cycleId`:

```typescript
export const taskUpdateSchema = z.object({
  type: z.literal("task.update"),
  taskId: z.string(),
  toolName: z.string(),
  cycleId: z.string(),    // NEW — owning cognitive cycle
  status: taskStatusSchema,
  argsPreview: z.string(),
  startedAtMs: z.number().int().nonnegative(),
  endedAtMs: z.number().int().nonnegative().optional(),
});
```

- [ ] **Step 2: Extend `TaskSnapshotItem` and the parser in the SDK**

In `shared/web-sdk/src/connectors/task-status-connector.ts`:

```typescript
export interface TaskSnapshotItem {
  readonly taskId: string;
  readonly toolName: string;
  readonly cycleId: string;         // NEW
  readonly status: TaskStatus;
  readonly argsPreview: string;
  readonly startedAtMs: number;
  readonly endedAtMs?: number;
}
```

And in the `attach` method's `task.update` parser, add `cycleId`:

```typescript
const m = msg as {
  taskId?: string;
  toolName?: string;
  cycleId?: string;
  status?: TaskStatus;
  argsPreview?: string;
  startedAtMs?: number;
  endedAtMs?: number;
};
if (!m.taskId || !m.toolName || !m.cycleId || !m.status || m.startedAtMs === undefined) return;
const item: TaskSnapshotItem = {
  taskId: m.taskId,
  toolName: m.toolName,
  cycleId: m.cycleId,
  status: m.status,
  argsPreview: m.argsPreview ?? "",
  startedAtMs: m.startedAtMs,
  ...(m.endedAtMs !== undefined ? { endedAtMs: m.endedAtMs } : {}),
};
```

- [ ] **Step 3: Run typecheck across the monorepo**

```
cd /Users/kevinye/Development/sentient && bun run --filter '*' typecheck
```
Expected: initial failures in gateway files that emit `task.update` without `cycleId`; those are fixed by Task 7.

- [ ] **Step 4: Commit**

```bash
git add shared/protocol/src/messages.ts shared/web-sdk/src/connectors/task-status-connector.ts
git commit -m "feat(protocol): add cycleId to task.update"
```

---

### Task 7: Thread `cycleId` through `TaskManager`

**Files:**
- Modify: `gateway/src/cerebrum/task-manager.ts`
- Modify: `gateway/src/cerebrum/task-manager.test.ts`
- Modify: `gateway/src/cerebrum/cognitive-cycle-dispatch.ts` (where tasks are registered)

- [ ] **Step 1: Extend `TaskHandle` with `cycleId`**

In `gateway/src/cerebrum/task-manager.ts`, add `cycleId` to `TaskHandle`:

```typescript
export interface TaskHandle {
  readonly taskId: string;
  readonly effectName: string;
  readonly cycleId: string;     // NEW
  readonly summary: string;
  readonly providesContext: boolean;
  readonly args: unknown;
  startedAt: number;
  readonly abortController: AbortController;
  readonly interruptable: boolean;
  readonly onCancelled: () => void;
}
```

Add `cycleId` to `TaskTableRow` and the lifecycle event, then thread it through register/snapshot/emit.

- [ ] **Step 2: Update lifecycle emission**

Wherever `task.update` wire messages are emitted (search for `task.update` in gateway; likely `task-manager.ts` emits a lifecycle event picked up by a subscriber that sends the wire message), include `cycleId` in the payload.

- [ ] **Step 3: Update call sites**

In `gateway/src/cerebrum/cognitive-cycle-dispatch.ts`, the registration call currently reads roughly:

```typescript
taskManager.register({
  taskId: toolCall.id,
  effectName: effect.name,
  // ...
});
```

Add `cycleId: config.cycleId` (or wherever the dispatch context carries it). Every existing call site that constructs a `TaskHandle` must add the field.

- [ ] **Step 4: Update tests**

In `task-manager.test.ts`, every construction of `TaskHandle` needs `cycleId: "cycle-test"` (or similar). Add one new test:

```typescript
it("snapshot rows include cycleId from registration", () => {
  const tm = createTaskManager(/* existing config */);
  tm.register({
    taskId: "t1",
    effectName: "echo",
    cycleId: "cycle-42",
    summary: "s",
    providesContext: false,
    args: {},
    startedAt: Date.now(),
    abortController: new AbortController(),
    interruptable: true,
    onCancelled: () => {},
  });
  const rows = tm.snapshot(10);
  expect(rows[0].cycleId).toBe("cycle-42");
});
```

- [ ] **Step 5: Run tests**

```
cd gateway && bun run test src/cerebrum/task-manager.test.ts
```
Expected: all tests pass with the new field threaded.

- [ ] **Step 6: Run full gateway typecheck**

```
cd gateway && bun run typecheck
```
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add gateway/src/cerebrum/task-manager.ts gateway/src/cerebrum/task-manager.test.ts gateway/src/cerebrum/cognitive-cycle-dispatch.ts
git commit -m "feat(gateway): thread cycleId through TaskManager"
```

---

### Task 8: Register cycle's `AbortController` with `cycleSlot`

**Files:**
- Modify: `gateway/src/cerebrum/cognitive-cycle.ts`
- Modify: `gateway/src/cerebrum/cognitive-cycle.test.ts`

- [ ] **Step 1: Add `cycleSlot` dep to the cycle config**

In `cognitive-cycle.ts`, the `CognitiveCycleDeps` (or whatever it's called) currently does not depend on `AbortSlot`. Add:

```typescript
import type { AbortSlot } from "../session-handlers/abort-slot.js";

export interface CognitiveCycleDeps {
  // ... existing ...
  readonly cycleSlot: AbortSlot;
}
```

- [ ] **Step 2: Register on entry, complete on exit**

At the start of `runCognitiveCycle`, after the `AbortController` is created (or received), register it:

```typescript
const abortController = /* existing creation or param */;
deps.cycleSlot.register(config.cycleId, abortController);
try {
  // ... existing body ...
  return result;
} finally {
  deps.cycleSlot.complete(config.cycleId);
}
```

- [ ] **Step 3: Update test**

In `cognitive-cycle.test.ts`, add a fake `cycleSlot` to the test setup and assert `register` + `complete` are called with `config.cycleId`.

- [ ] **Step 4: Run tests**

```
cd gateway && bun run test src/cerebrum/cognitive-cycle.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add gateway/src/cerebrum/cognitive-cycle.ts gateway/src/cerebrum/cognitive-cycle.test.ts
git commit -m "refactor(gateway): register cycle AbortController with cycleSlot"
```

---

### Task 9: Register TTS's `AbortController` with `ttsSlot`

**Files:**
- Modify: `gateway/src/cerebrum/content-tts-pipeline.ts`
- Modify: `gateway/src/cerebrum/content-tts-pipeline.test.ts`

- [ ] **Step 1: Accept `ttsSlot` as a dep**

Add `ttsSlot: AbortSlot` to the pipeline's dependency shape.

- [ ] **Step 2: Register on start, complete on natural end**

Where the TTS `AbortController` is created (inside `content-tts-pipeline.ts`), register with `ttsSlot` using the current `cycleId`:

```typescript
deps.ttsSlot.register(cycleId, ttsAbortController);
try {
  // ... stream audio frames ...
} finally {
  deps.ttsSlot.complete(cycleId);
}
```

- [ ] **Step 3: Update test**

Assert `ttsSlot.register/complete` called with correct id in the pipeline's lifecycle tests.

- [ ] **Step 4: Run tests**

```
cd gateway && bun run test src/cerebrum/content-tts-pipeline.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add gateway/src/cerebrum/content-tts-pipeline.ts gateway/src/cerebrum/content-tts-pipeline.test.ts
git commit -m "refactor(gateway): register TTS AbortController with ttsSlot"
```

---

### Task 10: Wire the new components into session bootstrap

**Files:**
- Modify: `gateway/src/session-handlers/ws-session-configure.ts`
- Modify: `gateway/src/session-handlers/ws-handlers.ts`

- [ ] **Step 1: Construct new components in place of `SessionAudioController`**

In `ws-session-configure.ts`, find the block that constructs `createSessionAudioController(...)`. Replace with:

```typescript
import { createAbortSlot } from "./abort-slot.js";
import { createSessionAudioWire } from "./session-audio-wire.js";
import { createBargeInController } from "./barge-in-controller.js";
import { createInterruptController } from "./interrupt-controller.js";

const cycleSlot = createAbortSlot("cycle");
const ttsSlot = createAbortSlot("tts");
const wire = createSessionAudioWire({ wsSend });
const bargeInController = createBargeInController({
  cycleSlot,
  ttsSlot,
  wire,
  graceWindowMs: config.session.tts_drain_grace_ms,
});
const stagedInterruptedTaskIds: string[] = [];
const interruptController = createInterruptController({
  cycleSlot,
  ttsSlot,
  taskManager,
  wire,
  onInterruptStaged: (ids) => {
    stagedInterruptedTaskIds.push(...ids);
  },
});
```

- [ ] **Step 2: Expose a one-shot consume hook for commit**

The cycle commit path currently reads `consumeInterruptCancelledTaskIds()` from the old controller. Replace with a local helper:

```typescript
function consumeStagedInterruptIds(): readonly string[] {
  const ids = [...stagedInterruptedTaskIds];
  stagedInterruptedTaskIds.length = 0;
  return ids;
}
```

Thread this into the cycle's commit logic (replace the old call).

- [ ] **Step 3: Wire mic-onset and `interrupt` message**

Replace the old `.bargeIn()` / `.interrupt()` calls:

```typescript
// mic-onset subscription (only during voice mode):
audioInputAdapter.setOnSpeechOnset(() => bargeInController.trigger());

// ws-handlers.ts — on { type: "interrupt" } message:
case "interrupt":
  interruptController.trigger();
  break;
```

- [ ] **Step 4: Pass `cycleSlot` + `ttsSlot` to cycle + TTS pipeline**

Wherever `runCognitiveCycle` or the TTS pipeline is set up, pass in the slots from bootstrap.

- [ ] **Step 5: Typecheck + run relevant tests**

```
cd gateway && bun run typecheck && bun run test src/session-handlers/
```

- [ ] **Step 6: Commit**

```bash
git add gateway/src/session-handlers/ws-session-configure.ts gateway/src/session-handlers/ws-handlers.ts
git commit -m "refactor(gateway): wire cancel primitives into session bootstrap"
```

---

### Task 11: Delete `SessionAudioController`

**Files:**
- Delete: `gateway/src/session-handlers/session-audio-controller.ts`
- Delete: `gateway/src/session-handlers/session-audio-controller.test.ts` (if it exists)

- [ ] **Step 1: Confirm no remaining imports**

```
cd gateway && grep -rn "session-audio-controller\|SessionAudioController\|createSessionAudioController" src/
```
Expected: zero matches (all replaced in Task 10).

- [ ] **Step 2: Delete files**

```bash
rm gateway/src/session-handlers/session-audio-controller.ts
rm -f gateway/src/session-handlers/session-audio-controller.test.ts
```

- [ ] **Step 3: Run gateway CI**

```
cd gateway && bun run ci
```
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add -A gateway/src/session-handlers/
git commit -m "refactor(gateway): remove SessionAudioController"
```

---

### Task 12: Rename `interrupt` effect → `cancel_all_tasks` (narrowed semantics)

**Files:**
- Create: `gateway/src/effects/cancel-all-tasks-effect.ts`
- Create: `gateway/src/effects/cancel-all-tasks-effect.test.ts`
- Delete: `gateway/src/effects/interrupt-effect.ts`
- Delete: `gateway/src/effects/interrupt-effect.test.ts`
- Modify: effect-registration call site (grep `createInterruptEffect`)

- [ ] **Step 1: Write failing test for the new effect**

```typescript
// gateway/src/effects/cancel-all-tasks-effect.test.ts
import { describe, expect, it, vi } from "vitest";
import { createCancelAllTasksEffect } from "./cancel-all-tasks-effect.js";

describe("cancel_all_tasks effect", () => {
  it("calls cancelAllInterruptable and returns ids", async () => {
    const cancelAllInterruptable = vi.fn(() => ["t1", "t2"]);
    const effect = createCancelAllTasksEffect({ cancelAllInterruptable });

    expect(effect.name).toBe("cancel_all_tasks");
    expect(effect.interruptable).toBe(false);

    const result = await effect.handler({}, { log: vi.fn() } as never);
    expect(cancelAllInterruptable).toHaveBeenCalledWith("cancel_all_tasks");
    expect(result).toEqual({ ok: true, data: { cancelled_task_ids: ["t1", "t2"] } });
  });

  it("does NOT accept any args", () => {
    const effect = createCancelAllTasksEffect({ cancelAllInterruptable: () => [] });
    expect(() => effect.argsValidator({ task_id: "x" })).toThrow();
  });
});
```

- [ ] **Step 2: Run test to confirm FAIL**

```
cd gateway && bun test src/effects/cancel-all-tasks-effect.test.ts
```

- [ ] **Step 3: Implement the effect (narrowed)**

```typescript
// gateway/src/effects/cancel-all-tasks-effect.ts
import { z } from "zod";
import { getLog } from "../logging/logger.js";
import type { EffectDefinition, EffectResult } from "./effect-types.js";

const log = getLog(["sentient", "effects", "cancel-all-tasks"]);

const argsSchema = z.object({}).strict();
type Args = z.infer<typeof argsSchema>;

const description =
  "Cancel every in-flight task you have running. Call this when the user " +
  "says to stop or abandon what's currently running. After calling, reply " +
  "with a brief acknowledgement. Does NOT stop the conversation — the user " +
  "can still hear your reply.";

export interface CreateCancelAllTasksEffectDeps {
  readonly cancelAllInterruptable: (reason: string) => readonly string[];
}

export function createCancelAllTasksEffect(
  deps: CreateCancelAllTasksEffectDeps,
): EffectDefinition<Args> {
  return {
    name: "cancel_all_tasks",
    description,
    schema: { type: "object", additionalProperties: false, properties: {} },
    argsValidator: (raw: unknown): Args => argsSchema.parse(raw),
    impact: "auto",
    rolesAllowed: ["adult", "child"],
    capabilities: [],
    interruptable: false,
    providesContext: false,
    alwaysAvailable: true,
    async handler(_args: Args): Promise<EffectResult> {
      const ids = deps.cancelAllInterruptable("cancel_all_tasks");
      log.info("cancel-all-tasks-invoked", { cancelledTaskIds: ids });
      return { ok: true, data: { cancelled_task_ids: ids } };
    },
  };
}
```

- [ ] **Step 4: Run test to confirm PASS**

```
cd gateway && bun test src/effects/cancel-all-tasks-effect.test.ts
```

- [ ] **Step 5: Delete old effect**

```bash
rm gateway/src/effects/interrupt-effect.ts gateway/src/effects/interrupt-effect.test.ts
```

- [ ] **Step 6: Update registration site**

Grep `createInterruptEffect`:

```
cd gateway && grep -rn "createInterruptEffect" src/
```

Replace the single call with:

```typescript
createCancelAllTasksEffect({
  cancelAllInterruptable: (reason) => taskManager.cancelInterruptable(reason),
}),
```

- [ ] **Step 7: Run gateway CI**

```
cd gateway && bun run ci
```

- [ ] **Step 8: Commit**

```bash
git add -A gateway/src/effects/ gateway/src/
git commit -m "refactor(gateway): rename interrupt effect to cancel_all_tasks with narrowed semantics"
```

---

### Task 13: Add `cancel_task` effect

**Files:**
- Create: `gateway/src/effects/cancel-task-effect.ts`
- Create: `gateway/src/effects/cancel-task-effect.test.ts`
- Modify: effect-registration site (add the new effect alongside `cancel_all_tasks`)

- [ ] **Step 1: Write failing test**

```typescript
// gateway/src/effects/cancel-task-effect.test.ts
import { describe, expect, it, vi } from "vitest";
import { createCancelTaskEffect } from "./cancel-task-effect.js";

describe("cancel_task effect", () => {
  it("calls cancelTask with id + reason", async () => {
    const cancelTask = vi.fn(() => true);
    const effect = createCancelTaskEffect({ cancelTask });

    expect(effect.name).toBe("cancel_task");
    expect(effect.interruptable).toBe(false);

    const args = effect.argsValidator({ task_id: "t-42" });
    const result = await effect.handler(args, { log: vi.fn() } as never);
    expect(cancelTask).toHaveBeenCalledWith("t-42", "cancel_task");
    expect(result).toEqual({ ok: true, data: { task_id: "t-42", cancelled: true } });
  });

  it("rejects missing task_id", () => {
    const effect = createCancelTaskEffect({ cancelTask: () => true });
    expect(() => effect.argsValidator({})).toThrow();
  });

  it("reports cancelled=false when task not found", async () => {
    const cancelTask = vi.fn(() => false);
    const effect = createCancelTaskEffect({ cancelTask });
    const args = effect.argsValidator({ task_id: "missing" });
    const result = await effect.handler(args, { log: vi.fn() } as never);
    expect(result).toEqual({ ok: true, data: { task_id: "missing", cancelled: false } });
  });
});
```

- [ ] **Step 2: Run test to confirm FAIL**

```
cd gateway && bun test src/effects/cancel-task-effect.test.ts
```

- [ ] **Step 3: Implement**

```typescript
// gateway/src/effects/cancel-task-effect.ts
import { z } from "zod";
import { getLog } from "../logging/logger.js";
import type { EffectDefinition, EffectResult } from "./effect-types.js";

const log = getLog(["sentient", "effects", "cancel-task"]);

const argsSchema = z.object({ task_id: z.string().min(1) }).strict();
type Args = z.infer<typeof argsSchema>;

const description =
  "Cancel a single in-flight task by its `task_id`. Use when you need to " +
  "abort a specific tool call without disturbing others.";

export interface CreateCancelTaskEffectDeps {
  readonly cancelTask: (taskId: string, reason: string) => boolean;
}

export function createCancelTaskEffect(deps: CreateCancelTaskEffectDeps): EffectDefinition<Args> {
  return {
    name: "cancel_task",
    description,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["task_id"],
      properties: { task_id: { type: "string" } },
    },
    argsValidator: (raw: unknown): Args => argsSchema.parse(raw),
    impact: "auto",
    rolesAllowed: ["adult", "child"],
    capabilities: [],
    interruptable: false,
    providesContext: false,
    alwaysAvailable: true,
    async handler(args: Args): Promise<EffectResult> {
      const cancelled = deps.cancelTask(args.task_id, "cancel_task");
      log.info("cancel-task-invoked", { taskId: args.task_id, cancelled });
      return { ok: true, data: { task_id: args.task_id, cancelled } };
    },
  };
}
```

Note: this requires `TaskManager.cancel` to return a `boolean`. Current signature is `cancel(taskId, reason): void`. Update the signature in `task-manager.ts` to return `true` when a task was found and cancelled, `false` otherwise. Add a test case for the negative path.

- [ ] **Step 4: Run test to confirm PASS**

```
cd gateway && bun test src/effects/cancel-task-effect.test.ts
```

- [ ] **Step 5: Register the effect at the call site**

```typescript
createCancelTaskEffect({
  cancelTask: (id, reason) => taskManager.cancel(id, reason),
}),
```

- [ ] **Step 6: Run gateway CI**

```
cd gateway && bun run ci
```

- [ ] **Step 7: Commit**

```bash
git add -A gateway/src/effects/ gateway/src/cerebrum/task-manager.ts gateway/src/cerebrum/task-manager.test.ts gateway/src/
git commit -m "feat(gateway): add cancel_task effect"
```

---

### Task 14: Grep for stale references and clean up

**Files:**
- Various — whatever the grep turns up.

- [ ] **Step 1: Grep for dead symbols**

```
cd /Users/kevinye/Development/sentient && grep -rn "SessionAudioController\|createSessionAudioController\|triggerInterrupt\|interrupt-effect\|cycleAbortRef" --include="*.ts" gateway/ shared/ | grep -v node_modules
```

Expected: zero matches in `gateway/` and `shared/` source. Any match is a leftover to delete or rename.

- [ ] **Step 2: Scan system-prompt fragments / effect references**

```
cd /Users/kevinye/Development/sentient && grep -rn '"interrupt"\|`interrupt`' gateway/src/ --include="*.ts" | grep -v -e "wire msg" -e "reason:" -e "cutoff" -e "\"type\"" | head
```

Any hits referring to the old **tool** name (as opposed to the wire message, cutoff kind, or `InterruptController`) need updating to `cancel_all_tasks`.

- [ ] **Step 3: Run full CI**

```
cd /Users/kevinye/Development/sentient && bun run ci
```

- [ ] **Step 4: Commit if edits made**

```bash
git add -A
git commit -m "chore(gateway): clean up stale interrupt/SessionAudioController references"
```

---

### Task 15: Manual smoke test (Phase 1 Definition of Done)

Per spec §3.10. Runs on the implementer's machine BEFORE handing off.

- [ ] **Step 1: Stop any local sentient containers**

```
docker ps --format "{{.Names}}" | grep -E "^sentient-" | xargs -r docker stop
```

- [ ] **Step 2: Build + run the Docker stack**

```
cd /Users/kevinye/Development/sentient/deploy/docker && docker compose up -d --build
```
Expected: gateway + ancillary services come up; `docker ps` shows healthy containers; `LOG_LEVEL=debug` active (per `feedback_docker_log_level` memory).

- [ ] **Step 3: Connect with the current webui (unchanged by Phase 1)**

Open `http://localhost:8888` (or whatever the configured gateway port is) in a browser. Send a text message that triggers a long response + tool call. Press the existing Interrupt button mid-stream.

**Verify in `gateway/logs/YYYY-MM-DD.log`:**
- `interrupt-controller` entry: `interrupt` with `cycleId`.
- `abort-slot cycle` entry: `cancel` with `reason: "interrupt"`.
- `abort-slot tts` entry: `cancel` with `reason: "interrupt"`.
- `task-manager` entries: each interruptable task transitioning to `cancelled`.
- `session-audio-wire` entry: `send-playback-stop reason=interrupt`.
- Committed assistant entry on the wire has `cutoff: { kind: "interrupt", cancelledTaskIds: [...] }`.

- [ ] **Step 4: Voice barge-in verification**

Enable voice mode, wait for assistant to start speaking, then speak over it.

**Verify:**
- `barge-in-controller` entry: `barge-in` with `cycleId`.
- `abort-slot cycle` entry: `cancel reason=barge-in` — **cycle aborts** (new behaviour).
- `abort-slot tts` entry: `cancel reason=barge-in`.
- `task-manager`: **no task cancellations** for this barge-in.
- `attention-gate` entry: new cycle fires from the user's STT-finalized speech.
- Committed assistant entry: `cutoff: { kind: "barge-in" }` with no `cancelledTaskIds`.

- [ ] **Step 5: Model-called `cancel_all_tasks` verification**

Prompt the assistant to call the tool (e.g. via a crafted user message that reliably triggers it; or add a temporary system-prompt nudge for the test).

**Verify:**
- Effect log: `cancel-all-tasks-invoked`.
- `task-manager`: interruptable tasks cancelled.
- **No cycle-abort** log. **No TTS-abort** log.
- Assistant's acknowledgement text streams after the tool call and the TTS plays it.
- Committed assistant entry has **no** `cutoff` (natural completion).

- [ ] **Step 6: Model-called `cancel_task` verification**

Same as Step 5 but targeting a single task id (observe a running task id from logs and have the model cancel that specific one).

**Verify:**
- `cancel-task-invoked` with that `taskId`.
- That one task transitions to `cancelled`; others keep running.

- [ ] **Step 7: End-to-end traceability scan**

```
tail -200 gateway/logs/$(date -u +%Y-%m-%d).log | grep -E "barge-in|interrupt|cancel-"
```

Every primitive invocation should be traceable from trigger → wire message → slot cancel → task transitions. If any step has no log, the logging rule isn't satisfied; add logs and retest.

- [ ] **Step 8: Tear down**

```
cd /Users/kevinye/Development/sentient/deploy/docker && docker compose down
```

- [ ] **Step 9: Push branch, open PR**

```
git push -u origin feature/cerebrum-ux-refresh
gh pr create --title "Phase 1: cerebrum cancel primitives cleanup" --body "$(cat <<'EOF'
## Summary
- Replace SessionAudioController with AbortSlot + SessionAudioWire + BargeInController + InterruptController.
- Rename `interrupt` effect to `cancel_all_tasks` (narrowed to task cancel only).
- Add `cancel_task { task_id }` effect.
- Barge-in now aborts cycle LLM stream + TTS (was TTS only).
- Thread `cycleId` through TaskSnapshotItem + task.update wire message.

## Test plan
- [x] bun run ci (lint + typecheck + tests)
- [x] Manual smoke test per spec §3.10 (steps 1–7 above)
- [ ] Review by maintainer

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Phase 1 Exit Criteria

- All 15 tasks complete.
- `bun run ci` green.
- Grep confirms zero references to `SessionAudioController`, `cycleAbortRef`, `interrupt-effect`, `triggerInterrupt`.
- Manual smoke test (Task 15) passes end-to-end with readable logs.
- PR open for review.

---

## Handoff to Phase 2

Once Phase 1 merges (or is merged into the branch), proceed to `docs/superpowers/plans/2026-04-18-webui-redesign.md` which consumes the protocol additions (`cycleId` on `TaskSnapshotItem`) introduced here.
