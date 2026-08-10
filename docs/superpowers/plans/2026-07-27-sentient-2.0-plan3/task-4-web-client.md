<!-- MERGED TASK: web-sdk rebase (4a) + webui permission dialog (4b) are ONE task, ONE commit series.
     Forced by lefthook pre-commit running repo-wide 'bun run --filter "*" typecheck', which includes
     @sentient/webui: the cycleId->turnId + connector renames break 5 webui files, so a web-sdk-only
     commit cannot pass the gate. Where 4a and 4b overlap on the audio queue, 4a's SDK-owned
     shared/web-sdk/src/turn-audio-queue.ts WINS and 4b DELETES gateway/webui/src/adapters/cycle-audio-queue.ts
     instead of rewriting it — this mirrors the KMP SDK, where queueing lives in commonMain, not the app. -->

## Part 4a — shared/web-sdk rebase

### Task 4: `shared/web-sdk` rebase onto the 2.0 wire — turn-keyed connectors, multi-turn bubbles, sequential audio queue, permission + delegation surfaces

**Implements:** spec §7 (client wire contract), §7.1 (permission-prompt UI — the SDK state surface half), §7.2 (client audio queueing + two bubbles). Build-order slice 7, client-SDK half.

**Why this task exists:** every connector in `shared/web-sdk` still parses the **retired** `cycle.*` / `message.*` / `connector.audio.*` / `task.update` dialect. The 2.0 gateway emits none of it. A message typed into the real webui today gets no reply because nothing in the SDK is listening for `turn.text.delta`. On top of the rename, two behaviours are actively wrong for 2.0: the in-flight text buffer is a single nullable slot (a second turn **clobbers** the first still-open bubble — §7.2 requires two), and the audio queue implements a **preempt** policy that fades out and replaces the running turn's audio (§7.2 requires strict FIFO append; the gateway never stops its own audio).

**Wave:** 2 — runs concurrently with T2 (gateway WS/runtime), T3 (gateway store/loop), T5 (`shared/mobile-sdk`). File sets are disjoint.

---

#### Files

**Create**
- `shared/web-sdk/src/turn-audio-queue.ts`
- `shared/web-sdk/src/turn-audio-queue.test.ts`
- `shared/web-sdk/src/connectors/tool-status-connector.ts`
- `shared/web-sdk/src/connectors/tool-status-connector.test.ts`
- `shared/web-sdk/src/connectors/permission-confirm-connector.ts`
- `shared/web-sdk/src/connectors/permission-confirm-connector.test.ts`
- `shared/web-sdk/src/connectors/delegation-progress-connector.ts`
- `shared/web-sdk/src/connectors/delegation-progress-connector.test.ts`

**Modify**
- `shared/web-sdk/src/connectors/inflight-message-connector.ts` + `.test.ts`
- `shared/web-sdk/src/connectors/cognition-status-connector.ts` + `.test.ts`
- `shared/web-sdk/src/connectors/assistant-audio-response-connector.ts` + `.test.ts`
- `shared/web-sdk/src/connectors/conversation-history-connector.ts` + `.test.ts`
- `shared/web-sdk/src/connector-types.ts`
- `shared/web-sdk/src/session-ready-handler.ts`
- `shared/web-sdk/src/index.ts`

**Delete**
- `shared/web-sdk/src/connectors/task-status-connector.ts`
- `shared/web-sdk/src/connectors/task-status-connector.test.ts`

**Do NOT touch (owned by other tasks)**
- `shared/protocol/**` — Task 1 is the single writer of `messages.ts`.
- `gateway/**` including `gateway/webui/**` — Task 7 rewires the webui and **deletes** `gateway/webui/src/adapters/cycle-audio-queue.ts` + `cycle-audio-queue.test.ts`. Do not edit, do not delete them here.
- `shared/mobile-sdk/**` — Task 5.

---

#### Interfaces

**Consumes — from Task 1 (`shared/protocol/src/messages.ts`, re-exported by `@sentient/protocol` via `export *`)**

Type aliases only. This task does **not** import zod schemas: connectors follow the established structural-cast pattern (`sdk.onMessage(type, (msg: unknown) => { const m = msg as {...} })`) because the SDK's router hands raw objects to per-type subscribers.

```ts
export type ToolUpdateStatus = "running" | "done" | "error";        // turn.tool.update.status
export type PermissionOutcome = "allowed" | "denied" | "timeout";   // permission.resolved.outcome
export type DelegationStatus = "running" | "done" | "error";        // delegation.progress.status
```

If Task 1 landed these under different alias names, fix the **import name** — never the literal unions, which are frozen by the wire contract.

**Consumes — existing, unchanged**

```ts
// shared/protocol/src/conversation.ts
export type ConversationFeedItem = /* discriminated union on `kind`: "user" | "assistant" | "tool" | "trigger" */;

// shared/web-sdk/src/connector-types.ts
export interface SentientSDKInternal {
  send(message: unknown): void;
  sendBinary(data: ArrayBuffer | Uint8Array): void;
  onMessage(type: string, handler: (msg: unknown) => void): () => void;
  onBinary(handler: (data: ArrayBuffer) => void): () => void;
}
export interface Connector {
  readonly capability: string;
  readonly kind: "input" | "output" | "status";
  attach(sdk: SentientSDKInternal): void;
  detach(): void;
  onCancelled?(): void;
}

// shared/web-sdk/src/logger.ts
export function createLogger(tags: readonly string[]): Log;

// shared/web-sdk/src/sessions-rest.ts
export interface SessionsRest { getMessages(sessionId: string): Promise<ConversationFeedItem[]>; /* … */ }
```

`shared/web-sdk/src/sdk-message-router.ts` needs **no change**: `routeMessage` dispatches by raw `type` string to whatever connectors subscribed, so new frame names work without touching the router.

**Produces — exported from `shared/web-sdk/src/index.ts` (Task 7 + Task 11 consume these verbatim)**

```ts
// turn-audio-queue.ts  — NEW. Replaces webui's createCycleAudioQueue (Task 7 deletes that file).
export interface TurnAudioPlayback {
  enqueue(samples: Float32Array): void;
  clear(): void;
  onDrain(handler: () => void): () => void;
}
export interface TurnAudioQueueOptions { playback: TurnAudioPlayback }
export interface TurnAudioQueue {
  onAudioStart(turnId: string): void;
  onAudioFrame(turnId: string, samples: Float32Array): void;
  onAudioDone(turnId: string): void;
  cancelAll(): void;
  depth(): number;
  dispose(): void;
}
export function createTurnAudioQueue(options: TurnAudioQueueOptions): TurnAudioQueue;

// inflight-message-connector.ts — SHAPE CHANGE: single slot → list
export interface InFlightMessage { readonly turnId: string; readonly text: string }
export interface InFlightMessageConnectorConfig {
  onUpdate?: (inflight: readonly InFlightMessage[]) => void;
}
export class InFlightMessageConnector implements Connector {
  list(): readonly InFlightMessage[];   // REPLACES inflight(): InFlightMessage | null
}

// tool-status-connector.ts — RENAMED from TaskStatusConnector (file + class + item type + capability)
export interface ToolCallSnapshotItem {
  readonly toolCallId: string; readonly toolName: string; readonly turnId: string;
  readonly status: ToolUpdateStatus; readonly argsPreview: string;
  readonly startedAtMs: number; readonly endedAtMs?: number; readonly taskId?: string;
}
export interface ToolStatusConnectorConfig {
  onUpdate?: (item: ToolCallSnapshotItem) => void;
  onList?: (items: readonly ToolCallSnapshotItem[]) => void;
}
export class ToolStatusConnector implements Connector { list(): readonly ToolCallSnapshotItem[] }

// permission-confirm-connector.ts — NEW
export interface PermissionRequestItem {
  readonly requestId: string; readonly toolCallId: string; readonly toolName: string;
  readonly args: Record<string, unknown>; readonly description: string; readonly expiresAtMs: number;
}
export interface PermissionConfirmConnectorConfig {
  onPending?: (pending: readonly PermissionRequestItem[]) => void;
  onResolved?: (requestId: string, outcome: PermissionOutcome) => void;
}
export class PermissionConfirmConnector implements Connector {
  pending(): readonly PermissionRequestItem[];
  respond(requestId: string, approved: boolean): void;
}

// delegation-progress-connector.ts — NEW
export interface DelegationProgressItem {
  readonly taskId: string; readonly turnId: string; readonly agent: string;
  readonly status: DelegationStatus; readonly note?: string;
}
export interface DelegationProgressConnectorConfig {
  onUpdate?: (item: DelegationProgressItem) => void;
  onList?: (items: readonly DelegationProgressItem[]) => void;
}
export class DelegationProgressConnector implements Connector { list(): readonly DelegationProgressItem[] }

// conversation-history-connector.ts — REKEYED
export type CommittedFeedItem = ConversationFeedItem & { readonly turnId?: string };  // was cycleId

// assistant-audio-response-connector.ts — REKEYED + format passthrough
export interface AssistantAudioResponseConfig {
  onAudioFrame?: (frame: Uint8Array, turnId: string) => void;
  onAudioStart?: (turnId: string, format?: { encoding: "opus" | "pcm"; sampleRate: number }) => void;
  onAudioDone?: (turnId: string) => void;
  onPlaybackStop?: (reason: "barge-in" | "interrupt", turnId: string) => void;
}

// connector-types.ts — FIELD REMOVED
export interface SessionReadyPayload {
  sessionId: string; audioEncoding: string;
  inputSampleRate: number; outputSampleRate: number; enabledEffects: string[];
  // `playback { minEagerEndMs, preemptFadeoutMs }` DELETED — see decision below.
}
```

**Removed exports (Task 7 must stop importing these):** `TaskStatusConnector`, `TaskSnapshotItem`, `TaskStatusConnectorConfig`, `InFlightMessageConnector#inflight()`, `SessionReadyPayload.playback`.

---

#### Decision: `SessionReadyPayload.playback` is deleted from the SDK

`{ minEagerEndMs, preemptFadeoutMs }` exist for exactly one purpose: tuning the **preempt** policy. Preemption is what §7.2 forbids. `createTurnAudioQueue` has zero tunables by design — sequential FIFO has nothing to tune — so both values are dead the moment this task lands.

- **This task:** delete the `playback` field from the `SessionReadyPayload` interface in `connector-types.ts` and stop destructuring it in `session-ready-handler.ts`. The handler keeps parsing against `sessionReadySchema`, so it is agnostic to whether Task 1 leaves the optional `playback` object in the schema.
- **Task 7 (webui):** deletes the now-dead `onSessionReady` block in `gateway/webui/src/hooks/use-voice-client.ts` (lines ~509–517, `if (payload.playback) { … cycleQueue.configure(…) }`), the `DEFAULT_MIN_EAGER_END_MS` / `DEFAULT_PREEMPT_FADEOUT_MS` constants, and `cycle-audio-queue.ts`.
- **Flagged residual for Task 1 / Task 6 (not this task):** the gateway still emits the field at `gateway/src/session-handlers/ws-session-configure.ts:124–127` from `services.webui.playback.{min_eager_end_ms,preempt_fadeout_ms}` in `gateway/config.yaml`. Whoever rewrites that emitter under the zod-validated-frames constraint should drop the field from the frame, from `sessionReadySchema`, and from the config block. Do not do it here — `messages.ts` has one writer.

**Known-red window (expected, plan-sanctioned):** `gateway/webui/**` will not typecheck at the end of this task. Renaming `InFlightMessage.cycleId → turnId`, `CommittedFeedItem.cycleId → turnId`, and `TaskSnapshotItem → ToolCallSnapshotItem` breaks `gateway/webui/src/hooks/cycle-helpers.ts`, `use-voice-client.ts`, `types.ts`, `components/chat/tool-pill-strip.tsx`, and `components/chat/tool-inline-detail.tsx`. **Task 7 closes it.** This task's gate is `shared/web-sdk` green (`test` + `typecheck`) plus repo-wide `lint`; do **not** patch webui to chase green.

---

#### Steps

- [ ] **Step 1: Baseline the package before touching anything.**

```bash
cd /Users/kevinye/Development/sentient && source scripts/env.sh
cd shared/web-sdk && bun run test && bun run typecheck
```

Expect all existing suites green. If anything is already red, stop and report — do not build on a red baseline.

---

##### Unit A — `turn-audio-queue.ts` (the §7.2 core)

- [ ] **Step 2: Write the failing FIFO test.** Create `shared/web-sdk/src/turn-audio-queue.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createTurnAudioQueue, type TurnAudioPlayback } from "./turn-audio-queue.ts";

function makeMockPlayback(): TurnAudioPlayback & {
  enqueued: Float32Array[];
  clearCalls: number;
  triggerDrain: () => void;
} {
  const drainHandlers = new Set<() => void>();
  const enqueued: Float32Array[] = [];
  let clearCalls = 0;
  return {
    enqueued,
    get clearCalls() {
      return clearCalls;
    },
    triggerDrain() {
      for (const h of [...drainHandlers]) h();
    },
    enqueue(samples: Float32Array) {
      enqueued.push(samples);
    },
    clear() {
      clearCalls++;
      enqueued.length = 0;
    },
    onDrain(handler: () => void) {
      drainHandlers.add(handler);
      return () => drainHandlers.delete(handler);
    },
  };
}

function frame(marker: number): Float32Array {
  return new Float32Array([marker]);
}

function markers(samples: readonly Float32Array[]): number[] {
  return samples.map((s) => s[0] ?? Number.NaN);
}

describe("TurnAudioQueue", () => {
  it("plays the head turn's frames straight through in arrival order", () => {
    const playback = makeMockPlayback();
    const queue = createTurnAudioQueue({ playback });

    queue.onAudioStart("turn-a");
    queue.onAudioFrame("turn-a", frame(1));
    queue.onAudioFrame("turn-a", frame(2));

    expect(markers(playback.enqueued)).toEqual([1, 2]);
    expect(playback.clearCalls).toBe(0);
  });

  it("queues a second turn BEHIND the first instead of preempting it (spec 7.2)", () => {
    const playback = makeMockPlayback();
    const queue = createTurnAudioQueue({ playback });

    queue.onAudioStart("turn-a");
    queue.onAudioFrame("turn-a", frame(1));
    queue.onAudioStart("turn-b");
    queue.onAudioFrame("turn-b", frame(9));

    // turn-b is buffered, NOT played, and turn-a was never cut.
    expect(markers(playback.enqueued)).toEqual([1]);
    expect(playback.clearCalls).toBe(0);
    expect(queue.depth()).toBe(2);

    queue.onAudioDone("turn-a");
    playback.triggerDrain();

    expect(markers(playback.enqueued)).toEqual([1, 9]);
    expect(queue.depth()).toBe(1);
  });

  it("never clears playback when a new turnId arrives — the gateway never stops its own audio", () => {
    const playback = makeMockPlayback();
    const queue = createTurnAudioQueue({ playback });

    queue.onAudioStart("turn-a");
    queue.onAudioFrame("turn-a", frame(1));
    queue.onAudioStart("turn-b");
    queue.onAudioFrame("turn-b", frame(2));
    queue.onAudioStart("turn-c");
    queue.onAudioFrame("turn-c", frame(3));

    expect(playback.clearCalls).toBe(0);
  });

  it("retires the head when turn.audio.done arrives AFTER playback already drained", () => {
    const playback = makeMockPlayback();
    const queue = createTurnAudioQueue({ playback });

    queue.onAudioStart("turn-a");
    queue.onAudioFrame("turn-a", frame(1));
    queue.onAudioStart("turn-b");
    queue.onAudioFrame("turn-b", frame(2));

    playback.triggerDrain(); // drains before done — head must NOT be retired yet
    expect(queue.depth()).toBe(2);

    queue.onAudioDone("turn-a"); // no further drain will ever fire; retire from here
    expect(markers(playback.enqueued)).toEqual([1, 2]);
    expect(queue.depth()).toBe(1);
  });

  it("cancelAll drops every queued turn and clears playback with no fade (barge-in / interrupt only)", () => {
    const playback = makeMockPlayback();
    const queue = createTurnAudioQueue({ playback });

    queue.onAudioStart("turn-a");
    queue.onAudioFrame("turn-a", frame(1));
    queue.onAudioStart("turn-b");
    queue.onAudioFrame("turn-b", frame(2));

    queue.cancelAll();

    expect(playback.clearCalls).toBe(1);
    expect(queue.depth()).toBe(0);
    expect(playback.enqueued).toHaveLength(0);
  });

  it("dispose releases the drain subscription and empties the queue", () => {
    const playback = makeMockPlayback();
    const queue = createTurnAudioQueue({ playback });

    queue.onAudioStart("turn-a");
    queue.onAudioFrame("turn-a", frame(1));
    queue.dispose();
    playback.triggerDrain(); // must not throw or resurrect a disposed queue

    expect(queue.depth()).toBe(0);
  });
});
```

- [ ] **Step 3: Run it and confirm it fails for the right reason.**

```bash
cd /Users/kevinye/Development/sentient && source scripts/env.sh
cd shared/web-sdk && bun run test src/turn-audio-queue.test.ts
```

Expected failure: `Error: Failed to resolve import "./turn-audio-queue.ts" from "src/turn-audio-queue.test.ts"` — the module does not exist yet.

- [ ] **Step 4: Implement the queue.** Create `shared/web-sdk/src/turn-audio-queue.ts`:

```ts
import { createLogger } from "./logger.ts";

const log = createLogger(["sentient", "sdk", "turn-audio-queue"]);

/**
 * Narrow playback port the queue drives. Deliberately smaller than
 * `AudioPlaybackAdapter`: the queue needs exactly three operations, so any
 * platform adapter (web AudioWorklet today, native later) can satisfy it
 * without the queue knowing anything about gain, AEC, or audio contexts.
 */
export interface TurnAudioPlayback {
  /** Hand Float32 samples to the output pipeline for immediate playback. */
  enqueue(samples: Float32Array): void;
  /** Drop everything queued or playing right now. No fade. */
  clear(): void;
  /** Fires when the output pipeline has physically drained. Returns unsubscribe. */
  onDrain(handler: () => void): () => void;
}

export interface TurnAudioQueueOptions {
  playback: TurnAudioPlayback;
}

/**
 * Strict sequential FIFO of assistant TTS audio, keyed by turnId (spec §7.2).
 *
 * INVARIANT — the whole point of this module: a new turnId NEVER cancels,
 * fades, or replaces in-flight audio. It is appended and plays only after the
 * current turn has physically drained. The gateway never stops its own audio
 * (§4.7), so `cancelAll()` — driven exclusively by barge-in (mic onset) or
 * interrupt (UI Stop) — is the ONLY flush path in this module.
 *
 * This replaces the retired webui `cycle-audio-queue`, whose ActiveCycle /
 * PendingCycle + `schedulePreempt` / `fadeOutAndClear` policy did the exact
 * opposite: it cut the running turn off once `minEagerEndMs` elapsed. There
 * are no tunables here — sequential playback has nothing to tune.
 */
export interface TurnAudioQueue {
  /** `turn.audio.start` — reserve this turn's slot at the tail of the FIFO. */
  onAudioStart(turnId: string): void;
  /** One audio frame for `turnId`. Plays now if head, buffers otherwise. */
  onAudioFrame(turnId: string, samples: Float32Array): void;
  /** `turn.audio.done` — no more frames will arrive for `turnId`. */
  onAudioDone(turnId: string): void;
  /** Barge-in / interrupt ONLY. Drops every turn and clears playback (no fade). */
  cancelAll(): void;
  /** FIFO depth, head included. Diagnostics + tests. */
  depth(): number;
  /** Release the playback drain subscription. */
  dispose(): void;
}

interface TurnSlot {
  readonly turnId: string;
  /** Frames received while this turn was NOT the head. Emptied on promotion. */
  buffered: Float32Array[];
  /** `turn.audio.done` seen — no further frames will arrive for this turn. */
  doneReceived: boolean;
}

export function createTurnAudioQueue(options: TurnAudioQueueOptions): TurnAudioQueue {
  const { playback } = options;

  /** FIFO. `queue[0]` is the turn currently feeding playback. */
  let queue: TurnSlot[] = [];
  /**
   * True between an `enqueue` and the drain that follows it. Closes the
   * done-after-drain race: if `turn.audio.done` lands AFTER playback already
   * drained, no further drain event will ever fire, so the head has to be
   * retired from the `onAudioDone` path instead of the drain handler.
   */
  let hasPendingAudio = false;

  function findSlot(turnId: string): TurnSlot | undefined {
    return queue.find((slot) => slot.turnId === turnId);
  }

  function appendSlot(turnId: string): TurnSlot {
    const slot: TurnSlot = { turnId, buffered: [], doneReceived: false };
    queue.push(slot);
    log.debug("slot-appended", { turnId, depth: queue.length });
    return slot;
  }

  function play(samples: Float32Array): void {
    hasPendingAudio = true;
    playback.enqueue(samples);
  }

  /**
   * Retire finished heads and promote the next turn. Terminates: each
   * iteration either shifts the queue or returns.
   *
   * `head.buffered` is always empty (frames for the head go straight to
   * playback, and a promoted slot is flushed on promotion), so "head is
   * finished" reduces to `doneReceived`.
   */
  function retireFinishedHeads(): void {
    while (queue.length > 0 && queue[0]?.doneReceived === true) {
      const retired = queue.shift();
      log.info("head-retired", { turnId: retired?.turnId ?? null, depth: queue.length });
      const next = queue[0];
      if (next === undefined) {
        log.debug("queue-idle", { reason: "all turns played out" });
        return;
      }
      const promoted = next.buffered;
      next.buffered = [];
      log.info("head-promoted", { turnId: next.turnId, bufferedFrames: promoted.length });
      for (const samples of promoted) play(samples);
      if (promoted.length > 0) return; // wait for this turn's own drain
    }
  }

  const unsubDrain = playback.onDrain(() => {
    hasPendingAudio = false;
    const head = queue[0];
    if (head === undefined) return;
    if (!head.doneReceived) {
      log.debug("drain-ignored", { reason: "head still producing frames", turnId: head.turnId });
      return;
    }
    retireFinishedHeads();
  });

  return {
    onAudioStart(turnId: string): void {
      if (findSlot(turnId) !== undefined) {
        log.debug("start-ignored", { reason: "turn already queued", turnId });
        return;
      }
      appendSlot(turnId);
    },

    onAudioFrame(turnId: string, samples: Float32Array): void {
      const head = queue[0];
      if (head === undefined) {
        appendSlot(turnId);
        play(samples);
        log.debug("frame-played", { reason: "queue was idle", turnId, samples: samples.length });
        return;
      }
      if (head.turnId === turnId) {
        play(samples);
        return;
      }
      const slot = findSlot(turnId) ?? appendSlot(turnId);
      slot.buffered.push(samples);
      log.debug("frame-buffered", {
        reason: "turn is queued behind the head",
        turnId,
        headTurnId: head.turnId,
        bufferedFrames: slot.buffered.length,
      });
    },

    onAudioDone(turnId: string): void {
      const slot = findSlot(turnId) ?? appendSlot(turnId);
      slot.doneReceived = true;
      log.debug("done-received", { turnId, isHead: queue[0]?.turnId === turnId, hasPendingAudio });
      if (queue[0] === slot && !hasPendingAudio) retireFinishedHeads();
    },

    cancelAll(): void {
      log.info("cancel-all", {
        reason: "barge-in-or-interrupt",
        depth: queue.length,
        headTurnId: queue[0]?.turnId ?? null,
      });
      queue = [];
      hasPendingAudio = false;
      playback.clear();
    },

    depth(): number {
      return queue.length;
    },

    dispose(): void {
      unsubDrain();
      queue = [];
      hasPendingAudio = false;
    },
  };
}
```

- [ ] **Step 5: Green + commit.**

```bash
cd /Users/kevinye/Development/sentient && source scripts/env.sh
cd shared/web-sdk && bun run test src/turn-audio-queue.test.ts
cd /Users/kevinye/Development/sentient
git add shared/web-sdk/src/turn-audio-queue.ts shared/web-sdk/src/turn-audio-queue.test.ts
git commit -m "feat(web-sdk): sequential turn-keyed TTS audio queue (spec 7.2)"
```

All 6 cases must pass.

---

##### Unit B — `InFlightMessageConnector`: multi-turn buffers

- [ ] **Step 6: Replace the test file with the 2.0 dialect + concurrency case.** Overwrite `shared/web-sdk/src/connectors/inflight-message-connector.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import type { SentientSDKInternal } from "../connector-types.ts";
import { InFlightMessageConnector, type InFlightMessage } from "./inflight-message-connector.ts";

function createMockSDK(): { sdk: SentientSDKInternal; emit: (type: string, msg: unknown) => void } {
  const handlers = new Map<string, ((msg: unknown) => void)[]>();
  return {
    sdk: {
      send: () => {},
      sendBinary: () => {},
      onMessage: (type, handler) => {
        const list = handlers.get(type) ?? [];
        list.push(handler);
        handlers.set(type, list);
        return () => {
          const current = handlers.get(type);
          if (!current) return;
          const idx = current.indexOf(handler);
          if (idx !== -1) current.splice(idx, 1);
        };
      },
      onBinary: () => () => {},
    },
    emit: (type, msg) => {
      for (const h of handlers.get(type) ?? []) h(msg);
    },
  };
}

describe("InFlightMessageConnector", () => {
  let connector: InFlightMessageConnector;
  let mock: ReturnType<typeof createMockSDK>;
  let updates: (readonly InFlightMessage[])[];

  beforeEach(() => {
    updates = [];
    connector = new InFlightMessageConnector({ onUpdate: (inflight) => updates.push(inflight) });
    mock = createMockSDK();
    connector.attach(mock.sdk);
  });

  it("seeds an empty buffer on turn.started so the UI can render the pre-first-token placeholder", () => {
    mock.emit("turn.started", { turnId: "t-1", trigger: "user" });
    expect(connector.list()).toEqual([{ turnId: "t-1", text: "" }]);
  });

  it("accumulates turn.text.delta into that turn's buffer", () => {
    mock.emit("turn.started", { turnId: "t-1", trigger: "user" });
    mock.emit("turn.text.delta", { turnId: "t-1", text: "Hello " });
    mock.emit("turn.text.delta", { turnId: "t-1", text: "world" });
    expect(connector.list()).toEqual([{ turnId: "t-1", text: "Hello world" }]);
  });

  it("holds TWO turns in flight concurrently — a follow-up turn never clobbers the open bubble (spec 7.2)", () => {
    mock.emit("turn.started", { turnId: "t-1", trigger: "user" });
    mock.emit("turn.text.delta", { turnId: "t-1", text: "first" });
    mock.emit("turn.started", { turnId: "t-2", trigger: "background-completion" });
    mock.emit("turn.text.delta", { turnId: "t-2", text: "second" });

    expect(connector.list()).toEqual([
      { turnId: "t-1", text: "first" },
      { turnId: "t-2", text: "second" },
    ]);
  });

  it("turn.completed clears only its own turn", () => {
    mock.emit("turn.text.delta", { turnId: "t-1", text: "first" });
    mock.emit("turn.text.delta", { turnId: "t-2", text: "second" });
    mock.emit("turn.completed", { turnId: "t-1" });
    expect(connector.list()).toEqual([{ turnId: "t-2", text: "second" }]);
  });

  it("turn.aborted clears only its own turn", () => {
    mock.emit("turn.text.delta", { turnId: "t-1", text: "first" });
    mock.emit("turn.text.delta", { turnId: "t-2", text: "second" });
    mock.emit("turn.aborted", { turnId: "t-2", cutoff: "barge-in" });
    expect(connector.list()).toEqual([{ turnId: "t-1", text: "first" }]);
  });

  it("detach drops every buffer and stops handling further frames", () => {
    mock.emit("turn.text.delta", { turnId: "t-1", text: "hi" });
    connector.detach();
    expect(connector.list()).toEqual([]);
    mock.emit("turn.text.delta", { turnId: "t-1", text: "more" });
    expect(connector.list()).toEqual([]);
  });
});
```

- [ ] **Step 7: Run and confirm failure.**

```bash
cd /Users/kevinye/Development/sentient && source scripts/env.sh
cd shared/web-sdk && bun run test src/connectors/inflight-message-connector.test.ts
```

Expected: TypeScript/runtime failure — `connector.list is not a function`, and every case failing because the connector still subscribes to `cycle.started` / `message.delta`.

- [ ] **Step 8: Rewrite the connector.** Overwrite `shared/web-sdk/src/connectors/inflight-message-connector.ts`:

```ts
import type { Connector, SentientSDKInternal } from "../connector-types.ts";
import { createLogger } from "../logger.ts";

const log = createLogger(["sentient", "sdk", "connectors", "inflight-message"]);

export interface InFlightMessage {
  readonly turnId: string;
  readonly text: string;
}

export interface InFlightMessageConnectorConfig {
  /** Called whenever ANY in-flight buffer changes (seed, delta, or clear). */
  onUpdate?: (inflight: readonly InFlightMessage[]) => void;
}

// ---------------------------------------------------------------------------
// InFlightMessageConnector — accumulates streaming assistant text for every
// turn that is still producing. Separate from committed conversation history.
//
// Capability: "message.stream"
// Direction: status (observer)
//
// Receives (2.0 wire contract):
//   - turn.started     — seed an EMPTY buffer so the UI can render its
//                        "thinking" placeholder BEFORE the first token. Without
//                        the seed the bubble stays absent through provider TFFT
//                        and the user stares at nothing.
//   - turn.text.delta  — append to that turn's buffer
//   - turn.completed   — drop that turn's buffer (committed entry follows via
//                        conversation.entry)
//   - turn.aborted     — drop that turn's buffer (the cutoff-stamped committed
//                        entry follows)
//
// MULTI-TURN (spec §7.2): the buffer is a MAP keyed by turnId, not a single
// slot. A self-initiated follow-up turn starts while the previous turn may
// still be open, and BOTH must render — two consecutive assistant bubbles with
// two turn ids is a valid, expected state. The previous single-slot design
// clobbered the still-open bubble; do not reintroduce it. Map insertion order
// IS render order.
// ---------------------------------------------------------------------------

export class InFlightMessageConnector implements Connector {
  readonly capability = "message.stream";
  readonly kind = "status" as const;

  private readonly config: InFlightMessageConnectorConfig;
  private unsubs: (() => void)[] = [];
  /** turnId → accumulated text. Insertion order IS render order. */
  private buffers = new Map<string, string>();

  constructor(config: InFlightMessageConnectorConfig = {}) {
    this.config = config;
  }

  /** Every turn currently mid-stream, oldest first. Empty when idle. */
  list(): readonly InFlightMessage[] {
    return [...this.buffers].map(([turnId, text]) => ({ turnId, text }));
  }

  attach(sdk: SentientSDKInternal): void {
    this.buffers = new Map();

    this.unsubs.push(
      sdk.onMessage("turn.started", (msg: unknown) => {
        const m = msg as { turnId?: string; trigger?: string };
        if (!m.turnId || this.buffers.has(m.turnId)) return;
        this.buffers.set(m.turnId, "");
        log.debug("turn-seeded", { turnId: m.turnId, trigger: m.trigger, inflight: this.buffers.size });
        this.emit();
      }),
    );

    this.unsubs.push(
      sdk.onMessage("turn.text.delta", (msg: unknown) => {
        const m = msg as { turnId?: string; text?: string };
        if (!m.turnId || typeof m.text !== "string") return;
        this.buffers.set(m.turnId, (this.buffers.get(m.turnId) ?? "") + m.text);
        this.emit();
      }),
    );

    this.unsubs.push(sdk.onMessage("turn.completed", (msg: unknown) => this.clearTurn(msg, "completed")));
    this.unsubs.push(sdk.onMessage("turn.aborted", (msg: unknown) => this.clearTurn(msg, "aborted")));
  }

  detach(): void {
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
    this.buffers = new Map();
  }

  private clearTurn(msg: unknown, reason: "completed" | "aborted"): void {
    const m = msg as { turnId?: string };
    if (!m.turnId) return;
    if (!this.buffers.delete(m.turnId)) return;
    log.debug("turn-cleared", { turnId: m.turnId, reason, inflight: this.buffers.size });
    this.emit();
  }

  private emit(): void {
    this.config.onUpdate?.(this.list());
  }
}
```

- [ ] **Step 9: Green + commit.**

```bash
cd /Users/kevinye/Development/sentient && source scripts/env.sh
cd shared/web-sdk && bun run test src/connectors/inflight-message-connector.test.ts
cd /Users/kevinye/Development/sentient
git add shared/web-sdk/src/connectors/inflight-message-connector.ts shared/web-sdk/src/connectors/inflight-message-connector.test.ts
git commit -m "feat(web-sdk): key in-flight assistant text by turnId, one buffer per concurrent turn"
```

---

##### Unit C — `CognitionStatusConnector`: active-turn set + real `acting`

- [ ] **Step 10: Replace the test file.** Overwrite `shared/web-sdk/src/connectors/cognition-status-connector.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import type { SentientSDKInternal } from "../connector-types.ts";
import { CognitionStatusConnector } from "./cognition-status-connector.ts";

function createMockSDK(): { sdk: SentientSDKInternal; emit: (type: string, msg: unknown) => void } {
  const handlers = new Map<string, ((msg: unknown) => void)[]>();
  return {
    sdk: {
      send: () => {},
      sendBinary: () => {},
      onMessage: (type, handler) => {
        const list = handlers.get(type) ?? [];
        list.push(handler);
        handlers.set(type, list);
        return () => {};
      },
      onBinary: () => () => {},
    },
    emit: (type, msg) => {
      for (const h of handlers.get(type) ?? []) h(msg);
    },
  };
}

describe("CognitionStatusConnector", () => {
  let connector: CognitionStatusConnector;
  let mock: ReturnType<typeof createMockSDK>;

  beforeEach(() => {
    connector = new CognitionStatusConnector();
    mock = createMockSDK();
    connector.attach(mock.sdk);
  });

  it("goes thinking on turn.started", () => {
    mock.emit("turn.started", { turnId: "t-1", trigger: "user" });
    expect(connector.state()).toBe("thinking");
  });

  it("stays thinking while a second turn is still open after the first completes", () => {
    mock.emit("turn.started", { turnId: "t-1", trigger: "user" });
    mock.emit("turn.started", { turnId: "t-2", trigger: "background-completion" });
    mock.emit("turn.completed", { turnId: "t-1" });
    expect(connector.state()).toBe("thinking");
  });

  it("returns to idle only once every turn has settled", () => {
    mock.emit("turn.started", { turnId: "t-1", trigger: "user" });
    mock.emit("turn.started", { turnId: "t-2", trigger: "background-completion" });
    mock.emit("turn.completed", { turnId: "t-1" });
    mock.emit("turn.aborted", { turnId: "t-2", cutoff: "interrupt" });
    expect(connector.state()).toBe("idle");
  });

  it("reports acting while a tool call is running and thinking again when it finishes", () => {
    mock.emit("turn.started", { turnId: "t-1", trigger: "user" });
    mock.emit("turn.tool.update", {
      turnId: "t-1",
      toolCallId: "tc-1",
      toolName: "home_assistant.get_state",
      status: "running",
      argsPreview: "entity=light.kitchen",
      startedAtMs: 1000,
    });
    expect(connector.state()).toBe("acting");

    mock.emit("turn.tool.update", {
      turnId: "t-1",
      toolCallId: "tc-1",
      toolName: "home_assistant.get_state",
      status: "done",
      argsPreview: "entity=light.kitchen",
      startedAtMs: 1000,
      endedAtMs: 1200,
    });
    expect(connector.state()).toBe("thinking");
  });

  it("does not pin acting when a background tool outlives its turn", () => {
    mock.emit("turn.started", { turnId: "t-1", trigger: "user" });
    mock.emit("turn.tool.update", {
      turnId: "t-1",
      toolCallId: "tc-bg",
      toolName: "delegateTask",
      status: "running",
      taskId: "task-1",
      argsPreview: "agent=hermes",
      startedAtMs: 1000,
    });
    mock.emit("turn.completed", { turnId: "t-1" });
    expect(connector.state()).toBe("idle");
  });
});
```

- [ ] **Step 11: Run and confirm failure.**

```bash
cd /Users/kevinye/Development/sentient && source scripts/env.sh
cd shared/web-sdk && bun run test src/connectors/cognition-status-connector.test.ts
```

Expected: every case fails with `expected 'idle' to be 'thinking'` — the connector still subscribes to `cycle.started` / `cycle.completed` / `cycle.aborted`.

- [ ] **Step 12: Rewrite the connector.** Overwrite `shared/web-sdk/src/connectors/cognition-status-connector.ts`:

```ts
import type { Connector, SentientSDKInternal } from "../connector-types.ts";
import { createLogger } from "../logger.ts";

const log = createLogger(["sentient", "sdk", "connectors", "cognition-status"]);

export type CognitionState = "idle" | "thinking" | "acting";

export interface CognitionStatusConfig {
  /** Called when the cognition state changes. Never fires on a no-op transition. */
  onStateChange?: (state: CognitionState) => void;
}

/** Reads a non-empty `turnId` off an untyped frame. */
function readTurnId(msg: unknown): string | null {
  const m = msg as { turnId?: unknown };
  return typeof m.turnId === "string" && m.turnId.length > 0 ? m.turnId : null;
}

// ---------------------------------------------------------------------------
// CognitionStatusConnector — collapses turn + tool lifecycle into one
// UI-facing state.
//
// Capability: "cognition.status"
// Direction: status
//
// Receives (2.0 wire contract):
//   turn.started / turn.completed / turn.aborted   → active-turn membership
//   turn.tool.update                               → running-tool membership
//
// State function (pure, recomputed on every event):
//   no active turns                    → "idle"
//   active turns + a running tool call → "acting"
//   active turns, no running tool      → "thinking"
//
// MULTI-TURN (spec §7.2): membership is a SET of turnIds, not a single flag.
// A follow-up turn can start before the previous one completes; going idle on
// the first `turn.completed` would blank the UI while a turn is still running.
// ---------------------------------------------------------------------------

export class CognitionStatusConnector implements Connector {
  readonly capability = "cognition.status";
  readonly kind = "status" as const;

  private readonly config: CognitionStatusConfig;
  private unsubs: (() => void)[] = [];
  private currentState: CognitionState = "idle";
  /** Turns that have started and not yet completed or aborted. */
  private activeTurns = new Set<string>();
  /** turnId → toolCallIds still running for that turn. */
  private runningTools = new Map<string, Set<string>>();

  constructor(config: CognitionStatusConfig = {}) {
    this.config = config;
  }

  /** Current cognition state. */
  state(): CognitionState {
    return this.currentState;
  }

  attach(sdk: SentientSDKInternal): void {
    this.currentState = "idle";
    this.activeTurns = new Set();
    this.runningTools = new Map();

    this.unsubs.push(
      sdk.onMessage("turn.started", (msg: unknown) => {
        const turnId = readTurnId(msg);
        if (turnId === null) return;
        this.activeTurns.add(turnId);
        this.recompute("turn.started", turnId);
      }),
    );

    this.unsubs.push(sdk.onMessage("turn.completed", (msg: unknown) => this.endTurn(msg, "turn.completed")));
    this.unsubs.push(sdk.onMessage("turn.aborted", (msg: unknown) => this.endTurn(msg, "turn.aborted")));

    this.unsubs.push(
      sdk.onMessage("turn.tool.update", (msg: unknown) => {
        const m = msg as { turnId?: unknown; toolCallId?: unknown; status?: unknown };
        const turnId = readTurnId(msg);
        if (turnId === null || typeof m.toolCallId !== "string" || typeof m.status !== "string") return;
        const tools = this.runningTools.get(turnId) ?? new Set<string>();
        if (m.status === "running") tools.add(m.toolCallId);
        else tools.delete(m.toolCallId);
        this.runningTools.set(turnId, tools);
        this.recompute("turn.tool.update", turnId);
      }),
    );
  }

  detach(): void {
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
    this.activeTurns = new Set();
    this.runningTools = new Map();
    this.currentState = "idle";
  }

  private endTurn(msg: unknown, trigger: string): void {
    const turnId = readTurnId(msg);
    if (turnId === null) return;
    this.activeTurns.delete(turnId);
    // Drop the turn's tool set outright. A BACKGROUND tool (delegateTask) can
    // still be running when its turn ends; keeping it here would pin cognition
    // at "acting" forever. Background work has its own surface —
    // DelegationProgressConnector.
    this.runningTools.delete(turnId);
    this.recompute(trigger, turnId);
  }

  private hasRunningTool(): boolean {
    for (const tools of this.runningTools.values()) {
      if (tools.size > 0) return true;
    }
    return false;
  }

  private computeState(): CognitionState {
    if (this.activeTurns.size === 0) return "idle";
    if (this.hasRunningTool()) return "acting";
    return "thinking";
  }

  private recompute(trigger: string, turnId: string): void {
    const next = this.computeState();
    if (next === this.currentState) return;
    log.debug("state-change", {
      from: this.currentState,
      to: next,
      trigger,
      turnId,
      activeTurns: this.activeTurns.size,
    });
    this.currentState = next;
    this.config.onStateChange?.(next);
  }
}
```

- [ ] **Step 13: Green + commit.**

```bash
cd /Users/kevinye/Development/sentient && source scripts/env.sh
cd shared/web-sdk && bun run test src/connectors/cognition-status-connector.test.ts
cd /Users/kevinye/Development/sentient
git add shared/web-sdk/src/connectors/cognition-status-connector.ts shared/web-sdk/src/connectors/cognition-status-connector.test.ts
git commit -m "feat(web-sdk): derive cognition state from the active-turn set and running tool calls"
```

---

##### Unit D — `TaskStatusConnector` → `ToolStatusConnector`

Rename rationale (state it in the commit body): the frame is now `turn.tool.update`, the dedup key moves from `taskId` to `toolCallId` (a `taskId` exists only for background tools), and the status union changes from `running|finished|cancelled|failed` to `running|done|error`. Keeping the old name would leave the class describing something that no longer exists.

- [ ] **Step 14: Create the new test file.** Create `shared/web-sdk/src/connectors/tool-status-connector.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { SentientSDKInternal } from "../connector-types.ts";
import { ToolStatusConnector } from "./tool-status-connector.ts";

function createMockSDK(): { sdk: SentientSDKInternal; emit: (type: string, msg: unknown) => void } {
  const handlers = new Map<string, ((msg: unknown) => void)[]>();
  return {
    sdk: {
      send: () => {},
      sendBinary: () => {},
      onMessage: (type, handler) => {
        const list = handlers.get(type) ?? [];
        list.push(handler);
        handlers.set(type, list);
        return () => {};
      },
      onBinary: () => () => {},
    },
    emit: (type, msg) => {
      for (const h of handlers.get(type) ?? []) h(msg);
    },
  };
}

describe("ToolStatusConnector", () => {
  it("records a running tool call from turn.tool.update", () => {
    const connector = new ToolStatusConnector();
    const mock = createMockSDK();
    connector.attach(mock.sdk);

    mock.emit("turn.tool.update", {
      turnId: "t-1",
      toolCallId: "tc-1",
      toolName: "home_assistant.get_state",
      status: "running",
      argsPreview: "entity=light.kitchen",
      startedAtMs: 1000,
    });

    expect(connector.list()).toEqual([
      {
        toolCallId: "tc-1",
        toolName: "home_assistant.get_state",
        turnId: "t-1",
        status: "running",
        argsPreview: "entity=light.kitchen",
        startedAtMs: 1000,
      },
    ]);
  });

  it("dedups by toolCallId so a running row transitions in place to done", () => {
    const connector = new ToolStatusConnector();
    const mock = createMockSDK();
    connector.attach(mock.sdk);

    const base = {
      turnId: "t-1",
      toolCallId: "tc-1",
      toolName: "search",
      argsPreview: "q=weather",
      startedAtMs: 1000,
    };
    mock.emit("turn.tool.update", { ...base, status: "running" });
    mock.emit("turn.tool.update", { ...base, status: "done", endedAtMs: 1400 });

    const list = connector.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.status).toBe("done");
    expect(list[0]?.endedAtMs).toBe(1400);
  });

  it("carries taskId through for background tools so the UI can join delegation.progress", () => {
    const connector = new ToolStatusConnector();
    const mock = createMockSDK();
    connector.attach(mock.sdk);

    mock.emit("turn.tool.update", {
      turnId: "t-1",
      toolCallId: "tc-bg",
      toolName: "delegateTask",
      status: "running",
      taskId: "task-42",
      argsPreview: "agent=hermes",
      startedAtMs: 2000,
    });

    expect(connector.list()[0]?.taskId).toBe("task-42");
  });
});
```

- [ ] **Step 15: Run and confirm failure.**

```bash
cd /Users/kevinye/Development/sentient && source scripts/env.sh
cd shared/web-sdk && bun run test src/connectors/tool-status-connector.test.ts
```

Expected: `Error: Failed to resolve import "./tool-status-connector.ts"`.

- [ ] **Step 16: Create the connector and delete the old one.** Create `shared/web-sdk/src/connectors/tool-status-connector.ts`:

```ts
import type { ToolUpdateStatus } from "@sentient/protocol";
import type { Connector, SentientSDKInternal } from "../connector-types.ts";
import { createLogger } from "../logger.ts";

const log = createLogger(["sentient", "sdk", "connectors", "tool-status"]);

export interface ToolCallSnapshotItem {
  /** Dedup key. The same id the loop and the PDP use for this call. */
  readonly toolCallId: string;
  readonly toolName: string;
  /** The turn that issued the call — used to group tool pills under a bubble. */
  readonly turnId: string;
  readonly status: ToolUpdateStatus;
  /** Short gateway-derived preview of the call's arguments. */
  readonly argsPreview: string;
  readonly startedAtMs: number;
  /** Present once the call reaches a terminal status. */
  readonly endedAtMs?: number;
  /** Present only for BACKGROUND tools (delegateTask). Joins to delegation.progress. */
  readonly taskId?: string;
}

export interface ToolStatusConnectorConfig {
  /** Called on every individual update. */
  onUpdate?: (item: ToolCallSnapshotItem) => void;
  /** Called whenever the list changes — ordered by startedAtMs ascending. */
  onList?: (items: readonly ToolCallSnapshotItem[]) => void;
}

// ---------------------------------------------------------------------------
// ToolStatusConnector — live per-tool-call status for the UI.
//
// Capability: "tool.status"
// Direction: status (observer; no outbound protocol from here)
//
// Receives: turn.tool.update (one on dispatch with status="running", one on
// settle with the terminal status; dedup by toolCallId so the row transitions
// in place). Terminal rows stay in the list — the UI filters if it wants only
// running calls.
//
// Replaces the retired TaskStatusConnector / task.update dialect: the key is
// now toolCallId (every call has one) and taskId is optional (background tools
// only).
// ---------------------------------------------------------------------------

export class ToolStatusConnector implements Connector {
  readonly capability = "tool.status";
  readonly kind = "status" as const;

  private readonly config: ToolStatusConnectorConfig;
  private unsubs: (() => void)[] = [];
  private calls = new Map<string, ToolCallSnapshotItem>();

  constructor(config: ToolStatusConnectorConfig = {}) {
    this.config = config;
  }

  list(): readonly ToolCallSnapshotItem[] {
    return [...this.calls.values()].sort((a, b) => a.startedAtMs - b.startedAtMs);
  }

  attach(sdk: SentientSDKInternal): void {
    this.calls = new Map();

    this.unsubs.push(
      sdk.onMessage("turn.tool.update", (msg: unknown) => {
        const m = msg as {
          turnId?: string;
          toolCallId?: string;
          toolName?: string;
          status?: ToolUpdateStatus;
          taskId?: string;
          argsPreview?: string;
          startedAtMs?: number;
          endedAtMs?: number;
        };
        if (!m.turnId || !m.toolCallId || !m.toolName || !m.status || m.startedAtMs === undefined) {
          log.warn("tool-update-dropped", {
            reason: "missing required field on turn.tool.update",
            toolCallId: m.toolCallId ?? null,
            turnId: m.turnId ?? null,
          });
          return;
        }
        const item: ToolCallSnapshotItem = {
          toolCallId: m.toolCallId,
          toolName: m.toolName,
          turnId: m.turnId,
          status: m.status,
          argsPreview: m.argsPreview ?? "",
          startedAtMs: m.startedAtMs,
          ...(m.endedAtMs !== undefined ? { endedAtMs: m.endedAtMs } : {}),
          ...(m.taskId !== undefined ? { taskId: m.taskId } : {}),
        };
        this.calls.set(item.toolCallId, item);
        log.debug("tool-update", {
          toolCallId: item.toolCallId,
          turnId: item.turnId,
          toolName: item.toolName,
          status: item.status,
        });
        this.config.onUpdate?.(item);
        this.config.onList?.(this.list());
      }),
    );
  }

  detach(): void {
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
    this.calls = new Map();
  }
}
```

Then delete the retired module:

```bash
cd /Users/kevinye/Development/sentient
rm shared/web-sdk/src/connectors/task-status-connector.ts shared/web-sdk/src/connectors/task-status-connector.test.ts
```

- [ ] **Step 17: Green + commit.**

```bash
cd /Users/kevinye/Development/sentient && source scripts/env.sh
cd shared/web-sdk && bun run test src/connectors/tool-status-connector.test.ts
cd /Users/kevinye/Development/sentient
git add -A shared/web-sdk/src/connectors/
git commit -m "feat(web-sdk): replace TaskStatusConnector with turnId/toolCallId-keyed ToolStatusConnector"
```

`index.ts` still exports the deleted module at this point — that is fixed in Step 37. The targeted test command above passes regardless.

---

##### Unit E — `AssistantAudioResponseConnector`

- [ ] **Step 18: Replace the test file.** Overwrite `shared/web-sdk/src/connectors/assistant-audio-response-connector.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import type { SentientSDKInternal } from "../connector-types.ts";
import { AssistantAudioResponseConnector } from "./assistant-audio-response-connector.ts";

function createMockSDK(): {
  sdk: SentientSDKInternal;
  emit: (type: string, msg: unknown) => void;
  emitBinary: (data: ArrayBuffer) => void;
} {
  const handlers = new Map<string, ((msg: unknown) => void)[]>();
  const binaryHandlers = new Set<(data: ArrayBuffer) => void>();
  return {
    sdk: {
      send: () => {},
      sendBinary: () => {},
      onMessage: (type, handler) => {
        const list = handlers.get(type) ?? [];
        list.push(handler);
        handlers.set(type, list);
        return () => {};
      },
      onBinary: (handler) => {
        binaryHandlers.add(handler);
        return () => binaryHandlers.delete(handler);
      },
    },
    emit: (type, msg) => {
      for (const h of handlers.get(type) ?? []) h(msg);
    },
    emitBinary: (data) => {
      for (const h of binaryHandlers) h(data);
    },
  };
}

function audioBytes(marker: number): ArrayBuffer {
  return new Uint8Array([marker]).buffer;
}

describe("AssistantAudioResponseConnector", () => {
  it("tags binary frames with the turnId from the preceding turn.audio.start", () => {
    const onAudioFrame = vi.fn();
    const connector = new AssistantAudioResponseConnector({ onAudioFrame });
    const mock = createMockSDK();
    connector.attach(mock.sdk);

    mock.emit("turn.audio.start", { turnId: "t-1", encoding: "opus", sampleRate: 48000 });
    mock.emitBinary(audioBytes(7));

    expect(onAudioFrame).toHaveBeenCalledTimes(1);
    expect(onAudioFrame.mock.calls[0]?.[1]).toBe("t-1");
  });

  it("passes encoding + sampleRate through from turn.audio.start", () => {
    const onAudioStart = vi.fn();
    const connector = new AssistantAudioResponseConnector({ onAudioStart });
    const mock = createMockSDK();
    connector.attach(mock.sdk);

    mock.emit("turn.audio.start", { turnId: "t-1", encoding: "pcm", sampleRate: 24000 });

    expect(onAudioStart).toHaveBeenCalledWith("t-1", { encoding: "pcm", sampleRate: 24000 });
  });

  it("reports turn.audio.done with its turnId", () => {
    const onAudioDone = vi.fn();
    const connector = new AssistantAudioResponseConnector({ onAudioDone });
    const mock = createMockSDK();
    connector.attach(mock.sdk);

    mock.emit("turn.audio.start", { turnId: "t-1", encoding: "opus", sampleRate: 48000 });
    mock.emit("turn.audio.done", { turnId: "t-1" });

    expect(onAudioDone).toHaveBeenCalledWith("t-1");
  });

  it("suppresses frames after playback.stop until the next turn.audio.start re-enables them", () => {
    const onAudioFrame = vi.fn();
    const onPlaybackStop = vi.fn();
    const connector = new AssistantAudioResponseConnector({ onAudioFrame, onPlaybackStop });
    const mock = createMockSDK();
    connector.attach(mock.sdk);

    mock.emit("turn.audio.start", { turnId: "t-1", encoding: "opus", sampleRate: 48000 });
    mock.emitBinary(audioBytes(1));
    mock.emit("playback.stop", { turnId: "t-1", reason: "barge-in" });
    mock.emitBinary(audioBytes(2));

    expect(onPlaybackStop).toHaveBeenCalledWith("barge-in", "t-1");
    expect(onAudioFrame).toHaveBeenCalledTimes(1);

    mock.emit("turn.audio.start", { turnId: "t-2", encoding: "opus", sampleRate: 48000 });
    mock.emitBinary(audioBytes(3));
    expect(onAudioFrame).toHaveBeenCalledTimes(2);
    expect(onAudioFrame.mock.calls[1]?.[1]).toBe("t-2");
  });
});
```

- [ ] **Step 19: Run and confirm failure.**

```bash
cd /Users/kevinye/Development/sentient && source scripts/env.sh
cd shared/web-sdk && bun run test src/connectors/assistant-audio-response-connector.test.ts
```

Expected: all four cases fail — the connector subscribes to `connector.audio.start` / `connector.audio.done` and `onAudioStart` currently takes only a cycleId.

- [ ] **Step 20: Rewrite the connector.** Overwrite `shared/web-sdk/src/connectors/assistant-audio-response-connector.ts`:

```ts
import type { Connector, SentientSDKInternal } from "../connector-types.ts";
import { createLogger } from "../logger.ts";

const log = createLogger(["sentient", "sdk", "connectors", "assistant-audio-response"]);

export interface AssistantAudioResponseConfig {
  /** One outbound audio frame (payload bytes, header already peeled by the
   *  router). `turnId` comes from the most recent `turn.audio.start` — the
   *  binary frame itself carries no turn id. */
  onAudioFrame?: (frame: Uint8Array, turnId: string) => void;
  /** A new audio stream started. `format` is omitted if the gateway did not
   *  send both fields — the connector never invents a codec or a rate. */
  onAudioStart?: (turnId: string, format?: { encoding: "opus" | "pcm"; sampleRate: number }) => void;
  /** The audio stream for this turn completed normally. */
  onAudioDone?: (turnId: string) => void;
  /** Gateway signalled a mid-stream playback halt. Drop queued audio NOW.
   *  Emitted ONLY on barge-in (mic onset) or interrupt (UI Stop) — a new
   *  turnId never produces this frame (spec §4.7 / §7.2). */
  onPlaybackStop?: (reason: "barge-in" | "interrupt", turnId: string) => void;
}

// ---------------------------------------------------------------------------
// AssistantAudioResponseConnector — receives assistant TTS audio.
//
// Capability: "audio.output"
// Direction: output
//
// Receives (2.0 wire contract):
//   turn.audio.start  → open a stream, remember its turnId
//   binary frames     → payload bytes attributed to the open stream
//   turn.audio.done   → close the stream
//   playback.stop     → user-initiated halt; suppress frames until the next start
//
// FRAME ATTRIBUTION CONTRACT: outbound binary audio carries no turn id, so
// the gateway emits one turn's audio at a time, delimited by
// turn.audio.start / turn.audio.done. Overlapping streams would make frames
// unattributable — the connector WARNs loudly rather than silently
// mislabelling the tail of the previous turn. Sequential EMISSION does not
// mean sequential PLAYBACK: the next turn's frames still arrive while the
// previous turn's audio is buffered in the output pipeline, which is exactly
// what TurnAudioQueue exists to serialize (§7.2).
// ---------------------------------------------------------------------------

export class AssistantAudioResponseConnector implements Connector {
  readonly capability = "audio.output";
  readonly kind = "output" as const;

  private readonly config: AssistantAudioResponseConfig;
  private unsubs: (() => void)[] = [];
  private isReceiving = false;
  private isCancelled = false;
  /** turnId the currently arriving binary frames belong to. */
  private activeTurnId = "";

  constructor(config: AssistantAudioResponseConfig = {}) {
    this.config = config;
  }

  attach(sdk: SentientSDKInternal): void {
    this.isCancelled = false;

    this.unsubs.push(
      sdk.onMessage("turn.audio.start", (msg: unknown) => {
        const m = msg as { turnId?: string; encoding?: string; sampleRate?: number };
        if (this.isReceiving) {
          log.warn("audio-start-while-receiving", {
            reason: "overlapping turn audio streams — frames cannot be attributed",
            previousTurnId: this.activeTurnId,
            turnId: m.turnId ?? "",
          });
        }
        this.activeTurnId = m.turnId ?? "";
        this.isReceiving = true;
        this.isCancelled = false;
        const format =
          (m.encoding === "opus" || m.encoding === "pcm") && typeof m.sampleRate === "number"
            ? { encoding: m.encoding, sampleRate: m.sampleRate }
            : undefined;
        log.debug("audio-start", { turnId: this.activeTurnId, encoding: m.encoding, sampleRate: m.sampleRate });
        this.config.onAudioStart?.(this.activeTurnId, format);
      }),
    );

    this.unsubs.push(
      sdk.onBinary((data: ArrayBuffer) => {
        if (!this.isReceiving || this.isCancelled) return;
        this.config.onAudioFrame?.(new Uint8Array(data), this.activeTurnId);
      }),
    );

    this.unsubs.push(
      sdk.onMessage("turn.audio.done", (msg: unknown) => {
        const m = msg as { turnId?: string };
        const doneTurnId = m.turnId ?? this.activeTurnId;
        this.isReceiving = false;
        log.debug("audio-done", { turnId: doneTurnId, suppressed: this.isCancelled });
        if (!this.isCancelled) this.config.onAudioDone?.(doneTurnId);
      }),
    );

    this.unsubs.push(
      sdk.onMessage("playback.stop", (msg: unknown) => {
        const m = msg as { turnId?: string; reason?: "barge-in" | "interrupt" };
        // Mark the stream dropped. `isReceiving` stays false until a fresh
        // turn.audio.start arrives — the next turn's audio re-enables playback
        // automatically.
        this.isCancelled = true;
        this.isReceiving = false;
        const reason = m.reason ?? "barge-in";
        log.info("playback-stop", { reason, turnId: m.turnId ?? "" });
        this.config.onPlaybackStop?.(reason, m.turnId ?? "");
      }),
    );
  }

  detach(): void {
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
    this.isReceiving = false;
    this.isCancelled = false;
    this.activeTurnId = "";
  }

  onCancelled(): void {
    this.isCancelled = true;
    this.isReceiving = false;
    this.activeTurnId = "";
  }
}
```

- [ ] **Step 21: Green + commit.**

```bash
cd /Users/kevinye/Development/sentient && source scripts/env.sh
cd shared/web-sdk && bun run test src/connectors/assistant-audio-response-connector.test.ts
cd /Users/kevinye/Development/sentient
git add shared/web-sdk/src/connectors/assistant-audio-response-connector.ts shared/web-sdk/src/connectors/assistant-audio-response-connector.test.ts
git commit -m "feat(web-sdk): re-point assistant audio connector at turn.audio.* and key streams by turnId"
```

---

##### Unit F — `ConversationHistoryConnector` rekey

- [ ] **Step 22: Update the two cycleId cases in the test.** In `shared/web-sdk/src/connectors/conversation-history-connector.test.ts`, replace the two tests at lines ~86–112 with:

```ts
  it("re-attaches the frame turnId to a committed assistant entry (no client-side id invention)", () => {
    const onEntry = vi.fn();
    const connector = new ConversationHistoryConnector({ onEntry });
    const internal = createMockInternal();
    connector.attach(internal);

    internal.messageHandlers.get("conversation.entry")?.({
      type: "conversation.entry",
      turnId: "t-1",
      item: assistantItem("hello"),
    });

    expect(connector.items()[0]?.turnId).toBe("t-1");
    expect(onEntry).toHaveBeenCalledWith(expect.objectContaining({ turnId: "t-1", kind: "assistant" }));
  });

  it("leaves turnId undefined for an entry with no originating turn (user echo)", () => {
    const connector = new ConversationHistoryConnector();
    const internal = createMockInternal();
    connector.attach(internal);

    internal.messageHandlers.get("conversation.entry")?.({
      type: "conversation.entry",
      item: userItem("hi"),
    });

    expect(connector.items()[0]?.turnId).toBeUndefined();
  });
```

Leave every other case in that file untouched — snapshot / `session.switched` / REST behaviour is unchanged by 2.0.

- [ ] **Step 23: Run and confirm failure.**

```bash
cd /Users/kevinye/Development/sentient && source scripts/env.sh
cd shared/web-sdk && bun run test src/connectors/conversation-history-connector.test.ts
```

Expected: `expected undefined to be 't-1'` on the first case — the connector still reads `m.cycleId`.

- [ ] **Step 24: Rekey the connector.** In `shared/web-sdk/src/connectors/conversation-history-connector.ts`, replace the `CommittedFeedItem` block (lines 8–18) with:

```ts
// ---------------------------------------------------------------------------
// CommittedFeedItem — a feed item plus the gateway-owned `turnId` carried on
// its conversation.entry FRAME. The wire item itself strips turn plumbing (see
// protocol/conversation.ts); we re-attach the frame's turnId here so the UI can
// join a committed assistant entry to its live streaming bubble WITHOUT
// inventing an id (no ts-window stamping, no position guessing). `turnId` is
// undefined for snapshot / REST-history items (historical entries have no live
// turn) and for user / trigger entries (no originating turn).
// ---------------------------------------------------------------------------

export type CommittedFeedItem = ConversationFeedItem & { readonly turnId?: string };
```

and replace the body of the `conversation.entry` handler (lines ~101–111) with:

```ts
      sdk.onMessage("conversation.entry", (msg: unknown) => {
        if (this.awaitingSnapshot) return; // drop straggler from prior generation
        const m = msg as { item?: ConversationFeedItem; turnId?: string };
        if (!m.item) return;
        // Re-attach the gateway's frame turnId to the committed item so the UI
        // joins it to the live bubble by id (never by ts-window guessing).
        const entry: CommittedFeedItem = m.turnId ? { ...m.item, turnId: m.turnId } : m.item;
        this.mirror = [...this.mirror, entry];
        this.config.onEntry?.(entry);
        this.config.onUpdate?.(this.mirror);
      }),
```

- [ ] **Step 25: Green + commit.**

```bash
cd /Users/kevinye/Development/sentient && source scripts/env.sh
cd shared/web-sdk && bun run test src/connectors/conversation-history-connector.test.ts
cd /Users/kevinye/Development/sentient
git add shared/web-sdk/src/connectors/conversation-history-connector.ts shared/web-sdk/src/connectors/conversation-history-connector.test.ts
git commit -m "refactor(web-sdk): rekey CommittedFeedItem join key from cycleId to turnId"
```

---

##### Unit G — `PermissionConfirmConnector` (new)

- [ ] **Step 26: Write the failing test.** Create `shared/web-sdk/src/connectors/permission-confirm-connector.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import type { SentientSDKInternal } from "../connector-types.ts";
import { PermissionConfirmConnector } from "./permission-confirm-connector.ts";

function createMockSDK(): {
  sdk: SentientSDKInternal;
  sent: unknown[];
  emit: (type: string, msg: unknown) => void;
} {
  const handlers = new Map<string, ((msg: unknown) => void)[]>();
  const sent: unknown[] = [];
  return {
    sent,
    sdk: {
      send: (message: unknown) => {
        sent.push(message);
      },
      sendBinary: () => {},
      onMessage: (type, handler) => {
        const list = handlers.get(type) ?? [];
        list.push(handler);
        handlers.set(type, list);
        return () => {};
      },
      onBinary: () => () => {},
    },
    emit: (type, msg) => {
      for (const h of handlers.get(type) ?? []) h(msg);
    },
  };
}

function requestFrame(requestId: string) {
  return {
    type: "permission.request",
    requestId,
    toolCallId: `tc-${requestId}`,
    toolName: "home_assistant.call_service",
    args: { entity_id: "lock.front_door", service: "unlock" },
    description: "Unlock the front door",
    expiresAtMs: 1_800_000,
  };
}

describe("PermissionConfirmConnector", () => {
  it("surfaces a pending request from permission.request", () => {
    const onPending = vi.fn();
    const connector = new PermissionConfirmConnector({ onPending });
    const mock = createMockSDK();
    connector.attach(mock.sdk);

    mock.emit("permission.request", requestFrame("r-1"));

    expect(connector.pending()).toEqual([
      {
        requestId: "r-1",
        toolCallId: "tc-r-1",
        toolName: "home_assistant.call_service",
        args: { entity_id: "lock.front_door", service: "unlock" },
        description: "Unlock the front door",
        expiresAtMs: 1_800_000,
      },
    ]);
    expect(onPending).toHaveBeenCalledTimes(1);
  });

  it("sends permission.response with the requestId and the approval flag", () => {
    const connector = new PermissionConfirmConnector();
    const mock = createMockSDK();
    connector.attach(mock.sdk);

    mock.emit("permission.request", requestFrame("r-1"));
    connector.respond("r-1", true);

    expect(mock.sent).toEqual([{ type: "permission.response", requestId: "r-1", approved: true }]);
    expect(connector.pending()).toEqual([]);
  });

  it("dismisses the request when the gateway resolves it first (server-side timeout)", () => {
    const onResolved = vi.fn();
    const connector = new PermissionConfirmConnector({ onResolved });
    const mock = createMockSDK();
    connector.attach(mock.sdk);

    mock.emit("permission.request", requestFrame("r-1"));
    mock.emit("permission.resolved", { type: "permission.resolved", requestId: "r-1", outcome: "timeout" });

    expect(connector.pending()).toEqual([]);
    expect(onResolved).toHaveBeenCalledWith("r-1", "timeout");
  });

  it("never sends a response for a requestId it is not tracking", () => {
    const connector = new PermissionConfirmConnector();
    const mock = createMockSDK();
    connector.attach(mock.sdk);

    mock.emit("permission.request", requestFrame("r-1"));
    mock.emit("permission.resolved", { type: "permission.resolved", requestId: "r-1", outcome: "denied" });
    connector.respond("r-1", true); // stale dialog click, arriving after resolution

    expect(mock.sent).toEqual([]);
  });

  it("clears pending on detach so a dropped socket leaves no answerable dialog", () => {
    const onPending = vi.fn();
    const connector = new PermissionConfirmConnector({ onPending });
    const mock = createMockSDK();
    connector.attach(mock.sdk);

    mock.emit("permission.request", requestFrame("r-1"));
    connector.detach();

    expect(connector.pending()).toEqual([]);
    expect(onPending).toHaveBeenLastCalledWith([]);
  });
});
```

- [ ] **Step 27: Run and confirm failure.**

```bash
cd /Users/kevinye/Development/sentient && source scripts/env.sh
cd shared/web-sdk && bun run test src/connectors/permission-confirm-connector.test.ts
```

Expected: `Error: Failed to resolve import "./permission-confirm-connector.ts"`.

- [ ] **Step 28: Implement the connector.** Create `shared/web-sdk/src/connectors/permission-confirm-connector.ts`:

```ts
import type { PermissionOutcome } from "@sentient/protocol";
import type { Connector, SentientSDKInternal } from "../connector-types.ts";
import { createLogger } from "../logger.ts";

const log = createLogger(["sentient", "sdk", "connectors", "permission-confirm"]);

export interface PermissionRequestItem {
  /** Correlation id for this decision. The ONLY id the response carries. */
  readonly requestId: string;
  /** The tool call the decision gates. */
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  /** Human-readable action summary supplied by the gateway PDP. */
  readonly description: string;
  /** Wall-clock ms after which the gateway auto-denies (fail-closed). */
  readonly expiresAtMs: number;
}

export interface PermissionConfirmConnectorConfig {
  /** Called whenever the pending set changes. Oldest request first. */
  onPending?: (pending: readonly PermissionRequestItem[]) => void;
  /** Called when the GATEWAY resolves a request — including its own timeout. */
  onResolved?: (requestId: string, outcome: PermissionOutcome) => void;
}

// ---------------------------------------------------------------------------
// PermissionConfirmConnector — the SDK state surface behind the L3 `confirm`
// dialog (spec §5.3 / §7.1).
//
// Capability: "permission.confirm"
// Direction: status — the request/response pair is one decision channel, and
// the UI binds to the pending SET (state-bound UX), not to an imperative call.
//
// Receives:
//   permission.request   → add to pending; the UI renders a dialog
//   permission.resolved  → remove from pending; the UI dismisses the dialog.
//                          Fires when the GATEWAY decided first — most
//                          importantly on its 2-minute fail-closed timeout, so
//                          a stale dialog cannot linger and cannot be answered
//                          after the decision was already made.
//
// Sends:
//   permission.response { requestId, approved }
//
// FAIL-CLOSED: this connector never approves anything on its own. It does not
// time out locally (the gateway owns the deadline), it refuses to answer a
// requestId it is not tracking, and on detach it drops every pending request —
// a socket that is gone cannot carry an approval, and the gateway will deny on
// timeout.
// ---------------------------------------------------------------------------

export class PermissionConfirmConnector implements Connector {
  readonly capability = "permission.confirm";
  readonly kind = "status" as const;

  private readonly config: PermissionConfirmConnectorConfig;
  private unsubs: (() => void)[] = [];
  private sdk: SentientSDKInternal | null = null;
  /** requestId → request. Insertion order IS dialog order. */
  private requests = new Map<string, PermissionRequestItem>();

  constructor(config: PermissionConfirmConnectorConfig = {}) {
    this.config = config;
  }

  /** Requests awaiting a user decision, oldest first. */
  pending(): readonly PermissionRequestItem[] {
    return [...this.requests.values()];
  }

  /** Answer a pending request. No-op for an unknown or already-resolved id. */
  respond(requestId: string, approved: boolean): void {
    if (this.sdk === null) {
      log.warn("respond-dropped", { reason: "connector detached", requestId });
      return;
    }
    if (!this.requests.has(requestId)) {
      log.warn("respond-dropped", { reason: "unknown or already-resolved requestId", requestId });
      return;
    }
    log.info("permission-response", { requestId, approved });
    this.sdk.send({ type: "permission.response", requestId, approved });
    this.requests.delete(requestId);
    this.emit();
  }

  attach(sdk: SentientSDKInternal): void {
    this.sdk = sdk;
    this.requests = new Map();

    this.unsubs.push(
      sdk.onMessage("permission.request", (msg: unknown) => {
        const m = msg as {
          requestId?: string;
          toolCallId?: string;
          toolName?: string;
          args?: Record<string, unknown>;
          description?: string;
          expiresAtMs?: number;
        };
        if (!m.requestId || !m.toolCallId || !m.toolName || m.expiresAtMs === undefined) {
          log.warn("permission-request-dropped", {
            reason: "missing required field on permission.request",
            requestId: m.requestId ?? null,
          });
          return;
        }
        const item: PermissionRequestItem = {
          requestId: m.requestId,
          toolCallId: m.toolCallId,
          toolName: m.toolName,
          args: m.args ?? {},
          description: m.description ?? "",
          expiresAtMs: m.expiresAtMs,
        };
        this.requests.set(item.requestId, item);
        log.info("permission-request", {
          requestId: item.requestId,
          toolCallId: item.toolCallId,
          toolName: item.toolName,
          pending: this.requests.size,
        });
        this.emit();
      }),
    );

    this.unsubs.push(
      sdk.onMessage("permission.resolved", (msg: unknown) => {
        const m = msg as { requestId?: string; outcome?: PermissionOutcome };
        if (!m.requestId || !m.outcome) return;
        const wasPending = this.requests.delete(m.requestId);
        log.info("permission-resolved", { requestId: m.requestId, outcome: m.outcome, wasPending });
        this.config.onResolved?.(m.requestId, m.outcome);
        if (wasPending) this.emit();
      }),
    );
  }

  detach(): void {
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
    this.sdk = null;
    if (this.requests.size > 0) {
      log.warn("pending-cleared-on-detach", {
        reason: "socket closed; an unanswered prompt cannot be answered — gateway fails it closed on timeout",
        pending: this.requests.size,
      });
    }
    this.requests = new Map();
    this.emit();
  }

  private emit(): void {
    this.config.onPending?.(this.pending());
  }
}
```

- [ ] **Step 29: Green + commit.**

```bash
cd /Users/kevinye/Development/sentient && source scripts/env.sh
cd shared/web-sdk && bun run test src/connectors/permission-confirm-connector.test.ts
cd /Users/kevinye/Development/sentient
git add shared/web-sdk/src/connectors/permission-confirm-connector.ts shared/web-sdk/src/connectors/permission-confirm-connector.test.ts
git commit -m "feat(web-sdk): add fail-closed PermissionConfirmConnector for L3 confirm prompts"
```

---

##### Unit H — `DelegationProgressConnector` (new)

- [ ] **Step 30: Write the failing test.** Create `shared/web-sdk/src/connectors/delegation-progress-connector.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { SentientSDKInternal } from "../connector-types.ts";
import { DelegationProgressConnector } from "./delegation-progress-connector.ts";

function createMockSDK(): { sdk: SentientSDKInternal; emit: (type: string, msg: unknown) => void } {
  const handlers = new Map<string, ((msg: unknown) => void)[]>();
  return {
    sdk: {
      send: () => {},
      sendBinary: () => {},
      onMessage: (type, handler) => {
        const list = handlers.get(type) ?? [];
        list.push(handler);
        handlers.set(type, list);
        return () => {};
      },
      onBinary: () => () => {},
    },
    emit: (type, msg) => {
      for (const h of handlers.get(type) ?? []) h(msg);
    },
  };
}

describe("DelegationProgressConnector", () => {
  it("records a running delegation from delegation.progress", () => {
    const connector = new DelegationProgressConnector();
    const mock = createMockSDK();
    connector.attach(mock.sdk);

    mock.emit("delegation.progress", {
      type: "delegation.progress",
      taskId: "task-1",
      turnId: "t-1",
      agent: "hermes",
      status: "running",
    });

    expect(connector.list()).toEqual([{ taskId: "task-1", turnId: "t-1", agent: "hermes", status: "running" }]);
  });

  it("dedups by taskId so a running row transitions in place and keeps the note", () => {
    const connector = new DelegationProgressConnector();
    const mock = createMockSDK();
    connector.attach(mock.sdk);

    mock.emit("delegation.progress", {
      type: "delegation.progress",
      taskId: "task-1",
      turnId: "t-1",
      agent: "hermes",
      status: "running",
    });
    mock.emit("delegation.progress", {
      type: "delegation.progress",
      taskId: "task-1",
      turnId: "t-1",
      agent: "hermes",
      status: "done",
      note: "drafted the packing list",
    });

    expect(connector.list()).toEqual([
      { taskId: "task-1", turnId: "t-1", agent: "hermes", status: "done", note: "drafted the packing list" },
    ]);
  });
});
```

- [ ] **Step 31: Run and confirm failure.**

```bash
cd /Users/kevinye/Development/sentient && source scripts/env.sh
cd shared/web-sdk && bun run test src/connectors/delegation-progress-connector.test.ts
```

Expected: `Error: Failed to resolve import "./delegation-progress-connector.ts"`.

- [ ] **Step 32: Implement the connector.** Create `shared/web-sdk/src/connectors/delegation-progress-connector.ts`:

```ts
import type { DelegationStatus } from "@sentient/protocol";
import type { Connector, SentientSDKInternal } from "../connector-types.ts";
import { createLogger } from "../logger.ts";

const log = createLogger(["sentient", "sdk", "connectors", "delegation-progress"]);

export interface DelegationProgressItem {
  /** Handle returned by the background tool. Dedup key. */
  readonly taskId: string;
  /** The turn that dispatched the delegation. */
  readonly turnId: string;
  /** Worker the task was delegated to (e.g. "hermes"). */
  readonly agent: string;
  readonly status: DelegationStatus;
  /** Optional short progress note from the worker. */
  readonly note?: string;
}

export interface DelegationProgressConnectorConfig {
  /** Called on every individual update. */
  onUpdate?: (item: DelegationProgressItem) => void;
  /** Called whenever the list changes — insertion order (dispatch order). */
  onList?: (items: readonly DelegationProgressItem[]) => void;
}

// ---------------------------------------------------------------------------
// DelegationProgressConnector — live status of BACKGROUND delegated work
// (spec §5.4 / §7).
//
// Capability: "delegation.progress"
// Direction: status (observer)
//
// Receives: delegation.progress — one frame per status transition of a
// `delegateTask` background task; dedup by taskId so a row transitions in
// place. The frame carries no timestamp, so ordering is insertion (dispatch)
// order. Terminal rows stay in the list; the UI filters if it wants only
// running work.
//
// Join key: `ToolCallSnapshotItem.taskId` (from turn.tool.update) is the same
// id, so the UI can attach progress to the tool pill that launched it.
// ---------------------------------------------------------------------------

export class DelegationProgressConnector implements Connector {
  readonly capability = "delegation.progress";
  readonly kind = "status" as const;

  private readonly config: DelegationProgressConnectorConfig;
  private unsubs: (() => void)[] = [];
  private tasks = new Map<string, DelegationProgressItem>();

  constructor(config: DelegationProgressConnectorConfig = {}) {
    this.config = config;
  }

  /** Every delegated task seen this session, in dispatch order. */
  list(): readonly DelegationProgressItem[] {
    return [...this.tasks.values()];
  }

  attach(sdk: SentientSDKInternal): void {
    this.tasks = new Map();

    this.unsubs.push(
      sdk.onMessage("delegation.progress", (msg: unknown) => {
        const m = msg as {
          taskId?: string;
          turnId?: string;
          agent?: string;
          status?: DelegationStatus;
          note?: string;
        };
        if (!m.taskId || !m.turnId || !m.agent || !m.status) {
          log.warn("delegation-progress-dropped", {
            reason: "missing required field on delegation.progress",
            taskId: m.taskId ?? null,
          });
          return;
        }
        const item: DelegationProgressItem = {
          taskId: m.taskId,
          turnId: m.turnId,
          agent: m.agent,
          status: m.status,
          ...(m.note !== undefined ? { note: m.note } : {}),
        };
        this.tasks.set(item.taskId, item);
        log.info("delegation-progress", {
          taskId: item.taskId,
          turnId: item.turnId,
          agent: item.agent,
          status: item.status,
        });
        this.config.onUpdate?.(item);
        this.config.onList?.(this.list());
      }),
    );
  }

  detach(): void {
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
    this.tasks = new Map();
  }
}
```

- [ ] **Step 33: Green + commit.**

```bash
cd /Users/kevinye/Development/sentient && source scripts/env.sh
cd shared/web-sdk && bun run test src/connectors/delegation-progress-connector.test.ts
cd /Users/kevinye/Development/sentient
git add shared/web-sdk/src/connectors/delegation-progress-connector.ts shared/web-sdk/src/connectors/delegation-progress-connector.test.ts
git commit -m "feat(web-sdk): add DelegationProgressConnector for background delegateTask status"
```

---

##### Unit I — kill the dead playback tunables

- [ ] **Step 34: Delete the field from `SessionReadyPayload`.** In `shared/web-sdk/src/connector-types.ts`, replace the `SessionReadyPayload` interface (lines 40–52) with:

```ts
/** Payload extracted from the `session.ready` message. */
export interface SessionReadyPayload {
  sessionId: string;
  audioEncoding: string;
  inputSampleRate: number;
  outputSampleRate: number;
  enabledEffects: string[];
}
```

The `playback { minEagerEndMs, preemptFadeoutMs }` pair existed only to tune the retired preempt policy. `createTurnAudioQueue` is a strict FIFO with no tunables (spec §7.2), so both values are dead. See the "Decision" section above for the gateway-side residual.

- [ ] **Step 35: Stop threading it through the handler.** In `shared/web-sdk/src/session-ready-handler.ts`, replace lines 22–25 with:

```ts
  if (!callback) return;
  // `rest` may still carry gateway fields the SDK does not surface (e.g. the
  // dead `playback` preempt tunables). Structural assignment drops them, and
  // NOT destructuring `playback` by name keeps this compiling whether or not
  // Task 1 leaves the optional field in `sessionReadySchema`.
  const { type: _type, ...rest } = parsed.data;
  callback(rest);
```

- [ ] **Step 36: Typecheck the package, then commit.**

```bash
cd /Users/kevinye/Development/sentient && source scripts/env.sh
cd shared/web-sdk && bun run typecheck
cd /Users/kevinye/Development/sentient
git add shared/web-sdk/src/connector-types.ts shared/web-sdk/src/session-ready-handler.ts
git commit -m "refactor(web-sdk): drop dead playback preempt tunables from SessionReadyPayload"
```

`shared/web-sdk` must typecheck clean. `gateway/webui` is expected red — see the known-red window above; do not chase it.

---

##### Unit J — public surface + full gate

- [ ] **Step 37: Update the barrel.** In `shared/web-sdk/src/index.ts`, replace the `TaskStatusConnector` export block (lines 58–59) with:

```ts
export { ToolStatusConnector } from "./connectors/tool-status-connector.ts";
export type { ToolCallSnapshotItem, ToolStatusConnectorConfig } from "./connectors/tool-status-connector.ts";

export { PermissionConfirmConnector } from "./connectors/permission-confirm-connector.ts";
export type {
  PermissionConfirmConnectorConfig,
  PermissionRequestItem,
} from "./connectors/permission-confirm-connector.ts";

export { DelegationProgressConnector } from "./connectors/delegation-progress-connector.ts";
export type {
  DelegationProgressConnectorConfig,
  DelegationProgressItem,
} from "./connectors/delegation-progress-connector.ts";
```

Then add the audio-queue export directly under the existing "Audio utilities" header (after the `AudioPlaybackAdapter` / `AudioCaptureAdapter` type exports, ~line 80):

```ts
// ---------------------------------------------------------------------------
// Turn-keyed TTS audio queue — strict sequential FIFO (spec §7.2). A new turn
// NEVER preempts, fades, or replaces in-flight audio; `cancelAll()` is the ONLY
// flush path and is driven exclusively by barge-in / interrupt.
// ---------------------------------------------------------------------------

export { createTurnAudioQueue } from "./turn-audio-queue.ts";
export type { TurnAudioPlayback, TurnAudioQueue, TurnAudioQueueOptions } from "./turn-audio-queue.ts";
```

- [ ] **Step 38: Full package gate.**

```bash
cd /Users/kevinye/Development/sentient && source scripts/env.sh
cd shared/web-sdk && bun run test && bun run typecheck
cd /Users/kevinye/Development/sentient && bun run lint
```

All three must be clean. If `bun run lint` reports formatting drift, run `bunx biome check --write shared/web-sdk` and re-run.

- [ ] **Step 39: Verify no retired dialect survives in the package.**

```bash
cd /Users/kevinye/Development/sentient
grep -rnE "cycleId|cycle\.(started|completed|aborted)|message\.(delta|done)|connector\.audio|task\.update|tool\.confirm" shared/web-sdk/src || echo "CLEAN"
```

Expected output: `CLEAN`. Any hit is an unfinished rename — fix it before committing.

- [ ] **Step 40: Commit the barrel + gate.**

```bash
cd /Users/kevinye/Development/sentient
git add shared/web-sdk/src/index.ts
git commit -m "feat(web-sdk): export turn audio queue, tool/permission/delegation connectors"
```

---

#### Handoff to Task 7 (webui)

`gateway/webui/**` does not typecheck until Task 7 lands. The exact work Task 7 inherits from this task:

1. Swap `createCycleAudioQueue` for `createTurnAudioQueue` in `gateway/webui/src/hooks/use-voice-client.ts`; **delete** `gateway/webui/src/adapters/cycle-audio-queue.ts` and `cycle-audio-queue.test.ts`. `FadeablePlaybackAdapter` structurally satisfies `TurnAudioPlayback` (it has `enqueue` / `clear` / `onDrain`) — no adapter change needed, and `fadeOutAndClear` loses its only caller (check whether anything else uses it before deleting it too).
2. Delete the `onSessionReady` playback block and the `DEFAULT_MIN_EAGER_END_MS` / `DEFAULT_PREEMPT_FADEOUT_MS` constants.
3. `cycle-helpers.ts`: `TaskSnapshotItem → ToolCallSnapshotItem`, `cycleId → turnId`, group tool pills by `turnId`, and render `InFlightMessageConnector.list()` as **N** streaming bubbles instead of one (`appendInflightMessage` becomes a loop) — that is the §7.2 "two bubbles" requirement on the UI side.
4. Render the permission dialog from `PermissionConfirmConnector.pending()` and call `respond(requestId, approved)`; register the connector with the SDK so `permission.confirm` lands in `session.configure.capabilities.supports`.
5. Register `DelegationProgressConnector` and surface `list()` (join to the tool pill via `taskId`).

#### E2E matrix rows this task unblocks

This task ships no UI, so it owns no E2E rows directly. It is the SDK precondition for `native-turn-happy`, `native-tool-call`, `delegate-hermes-bg`, `permission-confirm-web`, `steer-followup-audio`, and `barge-in` on the **web** surface (Task 11).

---

## Part 4b — gateway/webui permission dialog + rename sweep

### Task 7: Web UI — permission dialog, cycleId→turnId rename sweep, turn-ordered audio queue (spec §7.1/§7.2, build-order slice 7)

**Depends on:** Task 4 (web-sdk rebase) landed on this branch. **Touches:** `gateway/webui/` only. Never edits `shared/web-sdk` (Task 4's directory).

#### Scope note — why this task is bigger than "dialog + rename"

The orchestrator brief for this task says "(d) Verify (do not rewrite) that multi-bubble rendering already works... only the rename plus Task 4 per-turnId in-flight map," which reads as: no client-side audio-ordering work belongs here. Reading `docs/superpowers/specs/2026-07-23-sentient-2.0-native-orchestrator-design.md` §11 build-order point 7 directly contradicts that: *"Client UI: permission dialogs... **plus** TTS audio queueing by turn id + multi-bubble follow-up rendering, flush only on user interrupt (§7.2)."* Wave 3 in the plan header also confines T4 to `shared/web-sdk` (disjoint dirs, wave rule) — `gateway/webui/src/adapters/cycle-audio-queue.ts` isn't reachable from any task but this one. I read that file (below) and its current preempt/fade behavior actively **violates** Global Constraint #5 ("A new turnId must NEVER cancel, fade, or replace in-flight audio — it queues behind it") and would fail the `steer-followup-audio` E2E row in Task 11. Since no other task can reach this file, I've included the fix here as scope item **(e)**. Flagged in this plan's open questions for the plan owner to confirm against Task 4's actual landed scope (redundant-but-harmless if Task 4 also touches this at the SDK layer; a real gap if not).

#### Create

- `gateway/webui/src/hooks/permission-helpers.ts`
- `gateway/webui/src/hooks/permission-helpers.test.ts`
- `gateway/webui/src/adapters/turn-audio-queue.ts`
- `gateway/webui/src/adapters/turn-audio-queue.test.ts`
- `gateway/webui/src/components/permission/permission-dialog.tsx`
- `gateway/webui/src/components/permission/permission-dialog.css`

#### Delete

- `gateway/webui/src/adapters/cycle-audio-queue.ts` (replaced by `turn-audio-queue.ts`)
- `gateway/webui/src/adapters/cycle-audio-queue.test.ts` (replaced by `turn-audio-queue.test.ts`)

#### Modify

- `gateway/webui/src/types.ts`
- `gateway/webui/src/hooks/cycle-helpers.ts`
- `gateway/webui/src/hooks/use-voice-client.ts`
- `gateway/webui/src/components/chat/message-list.tsx`
- `gateway/webui/src/components/chat/chat-view.tsx`
- `gateway/webui/src/app.tsx`
- `gateway/webui/src/constants.ts`
- `gateway/webui/src/main.tsx`
- `agents/docs/gateway/webui/audio-cycle-serialization-details.md`

#### Not touched (verified, explicitly out of scope)

- `gateway/webui/src/components/chat/message-bubble.tsx` — the orchestrator brief names "message-bubble.tsx equality check," but I read the file and the `cycleId === currentCycleId` equality check lives in `message-list.tsx` (line 43), not here. `MessageBubble` never receives a turn id — only the already-resolved `avatarMode`. No change needed in this file.
- `gateway/webui/src/hooks/cycle-helpers.ts`'s `CycleStatus` type, `deriveCycleStatus` function, and `use-voice-client.ts`'s `cycleStatus` signal / `app.tsx`'s `activeCycleMode` — the rename sweep is `cycleId → turnId` (the identifier field, per Global Constraint #2), not a blanket "cycle → turn" wording pass. `deriveCycleStatus`'s inputs (`cognition`, `audioPlaying`, `runningTasks`, `awaitingResponse`) contain no `cycleId` reference at all — verified by reading the file in full.
- `gateway/webui/src/adapters/web-audio-playback.ts` (`FadeablePlaybackAdapter`, `fadeOutAndClear`) — `turn-audio-queue.ts` (below) stops calling `fadeOutAndClear`, but the method stays on the adapter: it's a generic, independently-tested playback capability (`web-audio-playback.test.ts`), not a stale reference to a purged concept, and removing it would pull in a second file+test pair unrelated to this task's rename/permission work.
- `gateway/webui/src/hooks/voice-messages.ts` — dead code (`createVoiceMessageStore` has zero call sites, verified via repo-wide grep), contains no `cycleId` reference either way.

#### Interfaces

**Consumes — from Task 4 (`@sentient/web-sdk`, already landed on this branch by the time this task runs):**

```ts
// Renamed fields (frozen wire contract: turn.* replaces cycle.*/message.*, turnId replaces cycleId)
export interface InFlightMessage {
  readonly turnId: string;
  readonly text: string;
}
export interface CommittedFeedItem {
  readonly kind: "user" | "assistant" | "tool" | "trigger";
  readonly ts: number;
  readonly content: string;
  readonly turnId?: string; // was cycleId
  readonly channel?: ConversationUserChannel; // user entries only, unchanged
  readonly cutoff?: ConversationAssistantCutoff; // unchanged
}
export interface TaskSnapshotItem {
  readonly taskId: string;
  readonly toolCallId: string; // new — turn.tool.update carries both
  readonly toolName: string;
  readonly turnId: string; // was cycleId
  readonly status: TaskStatus;
  readonly argsPreview: string;
  readonly startedAtMs: number;
  readonly endedAtMs?: number;
}

// New connector this task registers and drives the permission dialog from.
// Config-callback shape matches the existing PreferencesConnector /
// TaskStatusConnector pattern exactly (construct-time onX callbacks, no
// separate subscribe method).
export interface PermissionRequest {
  readonly requestId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly description: string;
  readonly expiresAtMs: number;
}
export type PermissionOutcome = "allowed" | "denied" | "timeout";
export interface PermissionConnectorConfig {
  onRequest?: (request: PermissionRequest) => void;
  onResolved?: (requestId: string, outcome: PermissionOutcome) => void;
}
export class PermissionConnector implements Connector {
  constructor(config?: PermissionConnectorConfig);
  /** Sends `permission.response { requestId, approved }` to the gateway. */
  respond(requestId: string, approved: boolean): void;
}
```

`AssistantAudioResponseConnector`'s callback signatures are unchanged in shape — only the parameter is now a `turnId` string (`onAudioStart?: (turnId: string) => void`, `onAudioFrame?: (frame: Uint8Array, turnId: string) => void`, `onAudioDone?: (turnId: string) => void`, `onPlaybackStop?: (reason: "barge-in" | "interrupt", turnId: string) => void`). This task never depends on the SDK doing any turn-level *ordering* — `turn-audio-queue.ts` (below) does that itself, so it's correct even if Task 4 only does the mechanical rename.

`EchoGate` (`shared/web-sdk/src/echo-gate.ts`) — untouched by this task either way: its methods take a positional `string` id argument; whatever Task 4 names that parameter internally doesn't affect call sites.

**Produces — for Task 11 (E2E web):**

- A blocking dialog with `role="dialog"`, `aria-modal="true"`, `aria-label="Permission requested"` (via the shared `Dialog` primitive), visible buttons with accessible names `"Allow"` and `"Deny"`.
- It renders exactly when `useVoiceClient(...).permissionRequest.value !== null`, and that signal is driven purely by `permission.request` / `permission.resolved` wire frames (state-bound-UX rule) — Playwright can drive the flow by triggering a `confirm`-classed tool call server-side and asserting the dialog's presence/absence + button click → `permission.response` frame.
- `useVoiceClient(...).respondToPermission(approved: boolean)` — callable directly from a test harness if a future test wants to bypass the DOM.

#### Design decisions (stated per house rule — no TBDs)

1. **ESC / backdrop dismiss → Deny, not suppressed.** `Dialog` (`components/common/dialog.tsx`) wires both ESC and backdrop-click to a single `onClose` prop with no way to disable just one. Rather than touch that shared primitive (used by rename/delete/voice dialogs too) to add a "non-dismissible" mode, `PermissionDialog` wires `onClose` straight to the same path as clicking Deny: it sends `permission.response { approved: false }`. This satisfies "blocks the turn until answered" literally — Deny **is** an answer; the dialog never closes without a wire response, and the fail-closed default (deny-on-ambiguity) matches the PDP's own timeout-denies-by-default posture (§7.1, Global Constraint #3).
2. **Button color: Deny = ghost, Allow = danger.** Mirrors `ConfirmDeleteDialog`'s ghost/danger pair (Cancel=ghost, Delete=danger) rather than `RenameDialog`'s ghost/primary pair (Cancel=ghost, Save=primary): granting a side-effecting tool call is the higher-consequence action here (the equivalent of "Delete" proceeding), not a neutral "Save."
3. **Mount point:** `app.tsx`, sibling to `<Drawer>` / `<ToastHost>`, gated on `client.permissionRequest.value`. Not the toast pattern (spec requires a blocking modal, and toasts auto-dismiss — wrong semantics for a decision the model is waiting on).
4. **`turn-audio-queue.ts` is a straight FIFO with no preemption.** The old `cycle-audio-queue.ts` cuts the active stream short (`fadeOutAndClear`) once `minEagerEndMs` elapses and a newer cycle arrives — that's exactly the behavior Global Constraint #5 forbids for 2.0. The replacement never cancels or fades an active turn; a new turn's audio only ever gets appended behind it, and the *only* way to stop mid-stream audio is `cancelAll()` (called from barge-in/interrupt). Because nothing preempts anymore, `minEagerEndMs` / `preemptFadeoutMs` / `configure()` have no remaining purpose and are deleted (not deprecated-in-place — Global Constraint says delete stale references as you go).

---

#### Steps

**Phase A — `cycleId` → `turnId` rename sweep**

- [ ] **Step 1: rename `ChatMessage.cycleId` in `types.ts`.**
  In `gateway/webui/src/types.ts`:
  ```ts
  // before
  /** Cycle that produced this assistant message, or triggered by this user message. */
  readonly cycleId?: string;
  ...
  /** Assistant messages only: tasks grouped onto this message by shared cycleId. */
  readonly tools?: readonly TaskSnapshotItem[];

  // after
  /** Turn that produced this assistant message, or triggered by this user message. */
  readonly turnId?: string;
  ...
  /** Assistant messages only: tasks grouped onto this message by shared turnId. */
  readonly tools?: readonly TaskSnapshotItem[];
  ```

- [ ] **Step 2: rename the tool-grouping helpers in `cycle-helpers.ts`.**
  In `gateway/webui/src/hooks/cycle-helpers.ts`, `findOrphanTarget` and `attachToolsToAssistantMessages`:
  ```ts
  function findOrphanTarget(messages: readonly ChatMessage[], startedAtMs: number): ChatMessage | null {
    for (const msg of messages) {
      if (msg.timestamp < startedAtMs) continue;
      if (msg.role === "user") return null;
      if (msg.role === "assistant" && msg.turnId !== undefined) return msg;
    }
    return null;
  }

  export function attachToolsToAssistantMessages(
    messages: readonly ChatMessage[],
    tasks: readonly TaskSnapshotItem[],
  ): ChatMessage[] {
    if (tasks.length === 0) return messages as ChatMessage[];

    const tasksByTurnId = new Map<string, TaskSnapshotItem[]>();
    for (const task of tasks) {
      const group = tasksByTurnId.get(task.turnId) ?? [];
      group.push(task);
      tasksByTurnId.set(task.turnId, group);
    }

    const matchedTurnIds = new Set<string>();

    const result = messages.map((msg): ChatMessage => {
      if (msg.role !== "assistant" || !msg.turnId) return msg;
      const group = tasksByTurnId.get(msg.turnId);
      if (!group || group.length === 0) return msg;
      matchedTurnIds.add(msg.turnId);
      const sorted = [...group].sort((a, b) => a.startedAtMs - b.startedAtMs);
      return { ...msg, tools: sorted };
    });

    const orphanedTasks: TaskSnapshotItem[] = [];
    for (const [turnId, group] of tasksByTurnId) {
      if (!matchedTurnIds.has(turnId)) {
        for (const task of group) orphanedTasks.push(task);
      }
    }
    if (orphanedTasks.length === 0) return result;

    const orphansByTarget = new Map<string, TaskSnapshotItem[]>();
    for (const task of orphanedTasks) {
      const target = findOrphanTarget(result, task.startedAtMs);
      if (!target) continue;
      const group = orphansByTarget.get(target.id) ?? [];
      group.push(task);
      orphansByTarget.set(target.id, group);
    }

    return result.map((msg): ChatMessage => {
      const extras = orphansByTarget.get(msg.id);
      if (!extras || extras.length === 0) return msg;
      const merged = [...(msg.tools ?? []), ...extras].sort((a, b) => a.startedAtMs - b.startedAtMs);
      return { ...msg, tools: merged };
    });
  }
  ```
  (Update the three doc-comment lines above `attachToolsToAssistantMessages` and above `findOrphanTarget` from "cycleId"/"cycles" to "turnId"/"turns" while you're in there.)

- [ ] **Step 3: rename `deriveMessages` / `appendCommittedItems` / `appendInflightMessage` / `buildAssistantMessage` in `cycle-helpers.ts`.**
  ```ts
  function buildAssistantMessage(id: string, item: CommittedFeedItem & { kind: "assistant" }): ChatMessage {
    return {
      id,
      role: "assistant",
      text: item.content,
      timestamp: item.ts,
      isStreaming: false,
      // turnId is the gateway-owned join key carried on the conversation.entry
      // frame (CommittedFeedItem) — read straight through, never invented client-side.
      ...(item.turnId ? { turnId: item.turnId } : {}),
      ...(item.cutoff ? { cutoff: item.cutoff } : {}),
    };
  }

  function appendCommittedItems(
    out: ChatMessage[],
    items: readonly CommittedFeedItem[],
    suppressAssistantTurnId?: string,
  ): void {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item) continue;
      const stableId = `feed-${item.ts}-${i}`;

      if (item.kind === "user") {
        if (item.content.length === 0) continue;
        out.push(buildUserMessage(stableId, item));
        continue;
      }

      if (item.kind === "assistant") {
        if (item.content.length === 0 && !item.cutoff) continue;
        const msg = buildAssistantMessage(stableId, item);
        if (suppressAssistantTurnId && msg.turnId === suppressAssistantTurnId) continue;
        out.push(msg);
      }
    }
  }

  function appendInflightMessage(out: ChatMessage[], inflight: InFlightMessage | null, visibleOverride?: string): void {
    if (!inflight) return;
    const text = visibleOverride ?? inflight.text;
    out.push({
      id: `inflight-${inflight.turnId}`,
      role: "assistant",
      text,
      timestamp: Date.now(),
      isStreaming: true,
      turnId: inflight.turnId,
    });
  }

  export function deriveMessages(
    items: readonly CommittedFeedItem[],
    inflight: InFlightMessage | null,
    visibleOverride?: string,
    suppressAssistantTurnId?: string,
  ): ChatMessage[] {
    const messages: ChatMessage[] = [];
    appendCommittedItems(messages, items, suppressAssistantTurnId);
    appendInflightMessage(messages, inflight, visibleOverride);
    return messages;
  }
  ```
  (`deriveCycleStatus` in this same file needs **no** change — see "Not touched" above.)

- [ ] **Step 4: rename the `currentCycleId` prop through `message-list.tsx` and `chat-view.tsx`.**
  In `gateway/webui/src/components/chat/message-list.tsx`:
  ```ts
  export interface MessageListProps {
    messages: readonly ChatMessage[];
    currentTurnId: string | null;
    activeCycleMode: SentientMarkMode;
    currentUser: CurrentUser;
  }
  ...
  export function MessageList({ messages, currentTurnId, activeCycleMode, currentUser }: MessageListProps): JSX.Element {
    ...
    const avatarMode: SentientMarkMode =
      m.role === "assistant" && m.turnId === currentTurnId ? activeCycleMode : "idle";
  ```
  In `gateway/webui/src/components/chat/chat-view.tsx`, rename the pass-through prop (`ChatViewProps.currentCycleId` → `currentTurnId`, the destructured param, and the `<MessageList currentTurnId={currentTurnId} .../>` call) — same three-line shape, `currentCycleId` → `currentTurnId` verbatim.

- [ ] **Step 5: rename the call site in `app.tsx`.**
  ```tsx
  // before
  currentCycleId={client.currentCycleId.value}
  // after
  currentTurnId={client.currentTurnId.value}
  ```

- [ ] **Step 6: rename `currentCycleId` and every dependent identifier in `use-voice-client.ts` (text/inflight path only — audio-queue identifiers are Phase B, permission wiring is Phase D).**
  ```ts
  // signal
  const currentTurnId = useSignal<string | null>(null);
  // typewriter drain tracking
  const typewriterTurnIdRef = useRef<string | null>(null);
  const drainCycleRef: { current: { turnId: string; snapshot: InFlightMessage } | null } = { current: null };
  ```
  And in `inflightMessageConnector`'s `onUpdate` handler:
  ```ts
  if (typewriterTurnIdRef.current !== inflight.turnId) {
    typewriterRef.current.reset();
    typewriterTurnIdRef.current = inflight.turnId;
    drainCycleRef.current = null;
  }
  typewriterRef.current.setBuffer(inflight.text);
  currentTurnId.value = inflight.turnId;
  inflightRef.current = inflight;
  ```
  and in the "no inflight" branch:
  ```ts
  if (inflightRef.current) {
    const fullText = inflightRef.current.text;
    const alreadyDrained = typewriterRef.current.visible.value.length >= fullText.length;
    if (!alreadyDrained) {
      drainCycleRef.current = {
        turnId: inflightRef.current.turnId,
        snapshot: inflightRef.current,
      };
    }
  }
  ```
  and in `refreshMessages()`:
  ```ts
  const base = deriveMessages(
    committedRef.current,
    effectiveInflight,
    effectiveInflight ? typewriterRef.current.visible.value : undefined,
    drainCycleRef.current?.turnId,
  );
  ```
  and `taskStatusConnector`'s `onList` handler (`latest.cycleId` → `latest.turnId`):
  ```ts
  const latest = items[items.length - 1];
  if (latest && !inflightRef.current) currentTurnId.value = latest.turnId;
  ```
  Finally, the hook's returned object: `currentCycleId,` → `currentTurnId,`.
  Sweep the handful of `cycleId`-mentioning comments in this stretch of the file (lines documenting `attachToolsToAssistantMessages (needs cycleId)`, "assistant entry for this cycleId", "Committed assistant entries already carry their gateway cycleId") to say `turnId`.

- [ ] **Step 7: typecheck the rename sweep (no new test — a botched rename fails the compiler, which is the correct signal here per the test-lean bar).**
  ```bash
  cd /Users/kevinye/Development/sentient && source scripts/env.sh && bun run typecheck
  ```
  Expect it to fail loudly if any `cycleId` reference was missed (TS2339 "Property 'cycleId' does not exist") — fix and re-run until clean. Note: this will show errors in Phase B/D areas too (`use-voice-client.ts`'s audio-queue block, the not-yet-created permission wiring) until those phases land — that's expected; re-run the full typecheck again at the end of the task (Step 17), not as a gate here.

- [ ] **Step 8: commit the rename sweep.**
  ```bash
  git add gateway/webui/src/types.ts gateway/webui/src/hooks/cycle-helpers.ts gateway/webui/src/hooks/use-voice-client.ts gateway/webui/src/components/chat/message-list.tsx gateway/webui/src/components/chat/chat-view.tsx gateway/webui/src/app.tsx
  git commit -m "$(cat <<'EOF'
  refactor(webui): rename cycleId to turnId across the chat feed

  2.0's wire contract has no cycleId — SessionRuntime mints turnId per
  turn. Sweeps the identifier through ChatMessage, the tool-grouping
  helpers, MessageList's active-avatar equality check, and the inflight
  signal. deriveCycleStatus/CycleStatus/activeCycleMode are untouched:
  they describe a coarse UI status, not the identifier.
  EOF
  )"
  ```

**Phase B — turn-ordered audio queue (scope item (e), see note above)**

- [ ] **Step 9: write the failing test for the new FIFO queue.**
  Create `gateway/webui/src/adapters/turn-audio-queue.test.ts`:
  ```ts
  import { describe, expect, it } from "vitest";
  import type { AudioPlaybackAdapter } from "@sentient/web-sdk";
  import { createTurnAudioQueue } from "./turn-audio-queue.ts";

  function makeMockPlayback(): AudioPlaybackAdapter & {
    enqueuedSamples: Float32Array[];
    cleared: number;
    triggerDrain: () => void;
  } {
    const drainHandlers = new Set<() => void>();
    const enqueuedSamples: Float32Array[] = [];
    let cleared = 0;
    return {
      enqueuedSamples,
      get cleared() {
        return cleared;
      },
      triggerDrain() {
        for (const h of drainHandlers) h();
      },
      init: async () => true,
      enqueue(samples) {
        enqueuedSamples.push(samples);
      },
      clear() {
        cleared++;
      },
      destroy() {},
      onStateChange: () => () => {},
      onDrain(handler) {
        drainHandlers.add(handler);
        return () => drainHandlers.delete(handler);
      },
    };
  }

  function makeSamples(length: number): Float32Array {
    return new Float32Array(length).fill(0.5);
  }

  describe("TurnAudioQueue — §7.2 never cancel/replace, queue behind", () => {
    it("forwards the first turn's frames straight to playback", () => {
      const playback = makeMockPlayback();
      const queue = createTurnAudioQueue({ playback });
      queue.onAudioStart("turn-1");
      const f1 = makeSamples(4);
      queue.onAudioFrame("turn-1", f1);
      expect(playback.enqueuedSamples).toEqual([f1]);
    });

    it("buffers a second turn's frames without touching playback while the first is still active", () => {
      const playback = makeMockPlayback();
      const queue = createTurnAudioQueue({ playback });
      queue.onAudioStart("turn-1");
      queue.onAudioFrame("turn-1", makeSamples(4));
      queue.onAudioStart("turn-2");
      queue.onAudioFrame("turn-2", makeSamples(4));
      expect(playback.enqueuedSamples).toHaveLength(1);
      expect(playback.cleared).toBe(0);
    });

    it("promotes the second turn only after the first turn's onAudioDone AND playback drains", () => {
      const playback = makeMockPlayback();
      const queue = createTurnAudioQueue({ playback });
      queue.onAudioStart("turn-1");
      queue.onAudioFrame("turn-1", makeSamples(4));
      queue.onAudioStart("turn-2");
      const f2 = makeSamples(4);
      queue.onAudioFrame("turn-2", f2);

      playback.triggerDrain();
      expect(playback.enqueuedSamples).toHaveLength(1);

      queue.onAudioDone("turn-1");
      playback.triggerDrain();
      expect(playback.enqueuedSamples).toHaveLength(2);
      expect(playback.enqueuedSamples[1]).toBe(f2);
    });

    it("a third turn queues behind the second — true FIFO, not a 2-slot pending", () => {
      const playback = makeMockPlayback();
      const queue = createTurnAudioQueue({ playback });
      queue.onAudioStart("turn-1");
      queue.onAudioDone("turn-1");
      queue.onAudioStart("turn-2");
      queue.onAudioStart("turn-3");
      const f3 = makeSamples(4);
      queue.onAudioFrame("turn-3", f3);

      playback.triggerDrain(); // promotes turn-2 (empty)
      queue.onAudioDone("turn-2");
      playback.triggerDrain(); // promotes turn-3, replays its buffered frame
      expect(playback.enqueuedSamples).toContainEqual(f3);
    });

    it("onAudioDone for a turn that hasn't started yet is ignored", () => {
      const playback = makeMockPlayback();
      const queue = createTurnAudioQueue({ playback });
      expect(() => queue.onAudioDone("never-started")).not.toThrow();
      expect(playback.cleared).toBe(0);
    });

    it("cancelAll hard-clears the queue and playback with no fade", () => {
      const playback = makeMockPlayback();
      const queue = createTurnAudioQueue({ playback });
      queue.onAudioStart("turn-1");
      queue.onAudioStart("turn-2");
      queue.cancelAll();
      expect(playback.cleared).toBe(1);
    });
  });
  ```

- [ ] **Step 10: run it, confirm it fails on the missing module.**
  ```bash
  cd /Users/kevinye/Development/sentient/gateway/webui && source ../../scripts/env.sh && bun run test src/adapters/turn-audio-queue.test.ts
  ```
  Expected failure: `Cannot find module './turn-audio-queue.ts'` (the file doesn't exist yet).

- [ ] **Step 11: implement `turn-audio-queue.ts`.**
  Create `gateway/webui/src/adapters/turn-audio-queue.ts`:
  ```ts
  import type { AudioPlaybackAdapter } from "@sentient/web-sdk";
  import { createLogger } from "@sentient/web-sdk";

  export interface TurnAudioQueueOptions {
    playback: AudioPlaybackAdapter;
  }

  export interface TurnAudioQueue {
    /** Called when a new TTS stream begins for the given turn. */
    onAudioStart(turnId: string): void;
    /** Called for each decoded PCM frame belonging to this turn. */
    onAudioFrame(turnId: string, samples: Float32Array): void;
    /** Called when the gateway has emitted all TTS frames for this turn. */
    onAudioDone(turnId: string): void;
    /** Barge-in / Stop only: immediately drop all state and clear playback (no fade). */
    cancelAll(): void;
  }

  interface QueuedTurn {
    turnId: string;
    queuedFrames: Float32Array[];
    doneReceived: boolean;
  }

  const log = createLogger(["sentient", "webui", "turn-audio-queue"]);

  /**
   * Strict FIFO turn-audio queue. Per spec §7.2 / Global Constraint #5, a new
   * turnId NEVER cancels, fades, or replaces the actively-playing turn — it
   * only ever queues behind it. The only path that clears mid-stream audio is
   * `cancelAll()`, called exclusively from barge-in / interrupt (§4.7).
   *
   * `active` is the turn currently sounding through `playback` — its frames
   * are forwarded live. `behind` holds every other tracked turn, in arrival
   * order, buffered until every turn ahead of it has fully drained.
   */
  export function createTurnAudioQueue(options: TurnAudioQueueOptions): TurnAudioQueue {
    const { playback } = options;

    let active: QueuedTurn | null = null;
    const behind: QueuedTurn[] = [];

    function findOrCreate(turnId: string): QueuedTurn {
      if (active?.turnId === turnId) return active;
      const existing = behind.find((t) => t.turnId === turnId);
      if (existing) return existing;
      const created: QueuedTurn = { turnId, queuedFrames: [], doneReceived: false };
      if (active === null) {
        active = created;
        log.debug("new-active: turn claimed (queue was empty)", { turnId });
      } else {
        behind.push(created);
        log.debug("buffered-behind: new turn queued", { turnId, aheadOf: active.turnId, depth: behind.length });
      }
      return created;
    }

    function promoteNext(): void {
      const next = behind.shift();
      if (!next) {
        active = null;
        log.debug("drain-idle: queue empty, going idle");
        return;
      }
      active = next;
      log.debug("promote: next turn promoted to active", {
        turnId: next.turnId,
        bufferedFrames: next.queuedFrames.length,
        remainingDepth: behind.length,
      });
      for (const samples of next.queuedFrames) playback.enqueue(samples);
      next.queuedFrames = [];
    }

    playback.onDrain(() => {
      if (!active) return;
      if (!active.doneReceived) {
        log.debug("drain: active turn not done yet, waiting for more frames", { turnId: active.turnId });
        return;
      }
      log.debug("drain: active turn fully played out", { turnId: active.turnId });
      promoteNext();
    });

    return {
      onAudioStart(turnId: string): void {
        findOrCreate(turnId);
      },

      onAudioFrame(turnId: string, samples: Float32Array): void {
        const turn = findOrCreate(turnId);
        if (turn === active) {
          playback.enqueue(samples);
          return;
        }
        turn.queuedFrames.push(samples);
        log.debug("frame: buffered for queued turn", { turnId, bufferedFrames: turn.queuedFrames.length });
      },

      onAudioDone(turnId: string): void {
        const turn = active?.turnId === turnId ? active : behind.find((t) => t.turnId === turnId);
        if (!turn) {
          log.debug("done: turnId not tracked (done-before-start), ignoring", { turnId });
          return;
        }
        turn.doneReceived = true;
        log.debug("done: turn marked done-received", { turnId, isActive: turn === active });
      },

      cancelAll(): void {
        log.debug("cancel-all: clearing active + queued + playback (no fade)", {
          activeTurnId: active?.turnId ?? null,
          queuedDepth: behind.length,
        });
        active = null;
        behind.length = 0;
        playback.clear();
      },
    };
  }
  ```

- [ ] **Step 12: run the test to green, then delete the superseded files.**
  ```bash
  cd /Users/kevinye/Development/sentient/gateway/webui && source ../../scripts/env.sh && bun run test src/adapters/turn-audio-queue.test.ts
  rm src/adapters/cycle-audio-queue.ts src/adapters/cycle-audio-queue.test.ts
  ```

- [ ] **Step 13: wire `turn-audio-queue.ts` into `use-voice-client.ts`, dropping the preempt config.**
  Replace the `cycleQueue` construction:
  ```ts
  // before
  const cycleQueue = createCycleAudioQueue({
    playback,
    minEagerEndMs: DEFAULT_MIN_EAGER_END_MS,
    preemptFadeoutMs: DEFAULT_PREEMPT_FADEOUT_MS,
  });

  // after
  const turnQueue = createTurnAudioQueue({ playback });
  ```
  Update the import (`createCycleAudioQueue` from `"../adapters/cycle-audio-queue.ts"` → `createTurnAudioQueue` from `"../adapters/turn-audio-queue.ts"`), and drop `DEFAULT_MIN_EAGER_END_MS, DEFAULT_PREEMPT_FADEOUT_MS` from the `constants.ts` import list.

  In the opus decoder + `AssistantAudioResponseConnector` wiring block:
  ```ts
  let activeTurnId = "";
  const opusDecoder = createOpusDecoder({
    targetSampleRate: AUDIO_SAMPLE_RATE,
    onFrame: (samples) => {
      if (activeTurnId) turnQueue.onAudioFrame(activeTurnId, samples);
    },
  });

  const audioResponseConnector = new AssistantAudioResponseConnector({
    onAudioStart: (turnId: string) => {
      isAudioPlayingRef.current = true;
      awaiting.onAudioStart();
      turnQueue.onAudioStart(turnId);
      echoGate.onPlaybackStart(turnId);
      refreshStatus();
      void opusDecoder.reset();
    },
    onAudioFrame: (frame: Uint8Array, turnId: string) => {
      activeTurnId = turnId;
      opusDecoder.decode(frame);
    },
    onAudioDone: (turnId: string) => {
      void opusDecoder.flush().then(() => {
        turnQueue.onAudioDone(turnId);
        refreshStatus();
      });
    },
    onPlaybackStop: (reason, turnId) => {
      log.debug("playback-stop", { reason, turnId });
      isAudioPlayingRef.current = false;
      awaiting.onPlaybackEnded();
      turnQueue.cancelAll();
      echoGate.onPlaybackCancel(turnId);
      refreshStatus();
      void opusDecoder.reset();
    },
  });

  audioResponseConnector.onCancelled = () => {
    isAudioPlayingRef.current = false;
    awaiting.onPlaybackEnded();
    turnQueue.cancelAll();
    echoGate.onPlaybackCancel("");
    refreshStatus();
  };
  ```
  Remove the `onSessionReady` handler's playback-tunable block entirely:
  ```ts
  // delete this whole branch — no more preempt tunables to apply
  // if (payload.playback) {
  //   log.debug("session.ready playback tunables", payload.playback);
  //   cycleQueue.configure({ minEagerEndMs: ..., preemptFadeoutMs: ... });
  // }
  ```
  Rename the two remaining call sites: the returned `resources` object's `cycleQueue,` → `turnQueue,`, and `interrupt()`'s `resources.cycleQueue.cancelAll()` → `resources.turnQueue.cancelAll()`.

- [ ] **Step 14: remove the dead constants and doc the new model.**
  In `gateway/webui/src/constants.ts`, delete:
  ```ts
  /** Cycle audio queue — preempt cap defaults (overridden via session.ready in Task 4). */
  export const DEFAULT_MIN_EAGER_END_MS = 3_000;
  export const DEFAULT_PREEMPT_FADEOUT_MS = 30;
  ```
  (That comment is itself a stale reference to an unrelated pre-2.0 "Task 4" — one more reason it goes.)

  Rewrite `agents/docs/gateway/webui/audio-cycle-serialization-details.md` to describe the FIFO model in place of the preempt one — same file, new body:
  ```markdown
  # Turn Audio Queue

  The webui's `TurnAudioQueue` enforces strict FIFO playback ordering across
  turns: at most one turn's audio plays at a time, and a new turn's audio is
  never cancelled, faded, or replaced by a later turn — it queues behind
  whatever is already playing (spec §7.2, Global Constraint #5). This
  replaced the pre-2.0 `CycleAudioQueue`, which preempted the active stream
  with a fade once a `minEagerEndMs` cap elapsed — that behavior is
  incompatible with 2.0's back-to-back follow-up turns (§4.5): a follow-up
  turn's audio must never cut off the turn that triggered it.

  ## State

  - `active: { turnId, queuedFrames, doneReceived } | null`
  - `behind: QueuedTurn[]` — arbitrary depth, not capped at one pending slot

  ## Rule

  - A turn becomes `active` immediately if the queue is idle; otherwise it's
    appended to the back of `behind` and its frames buffer there.
  - `playback.onDrain()` promotes the next entry in `behind` to `active` (FIFO)
    **only if** the current `active` turn's `doneReceived` flag is set —
    never on a timer, never because a newer turn arrived.
  - `cancelAll()` — the **only** path that clears an in-flight turn — wipes
    `active` + `behind` and calls `playback.clear()` (hard stop, no fade).
    Called exclusively from barge-in / interrupt (§4.7).

  ## Configuration

  None. There is nothing to tune — no preempt cap, no fade duration. If a
  gateway build still sends `session.ready.playback` (the pre-2.0
  `min_eager_end_ms` / `preempt_fadeout_ms` tunables), the webui client
  ignores it.

  ## Implementation

  - `gateway/webui/src/adapters/turn-audio-queue.ts` — the queue itself
  - `gateway/webui/src/adapters/web-audio-playback.ts` — `enqueue` / `clear` / `onDrain`
    (its `fadeOutAndClear` capability is unused by the queue now but stays on
    the adapter — it's independently tested and may still be useful elsewhere)
  ```

- [ ] **Step 15: commit the turn-audio-queue rewrite.**
  ```bash
  cd /Users/kevinye/Development/sentient
  git add gateway/webui/src/adapters/turn-audio-queue.ts gateway/webui/src/adapters/turn-audio-queue.test.ts gateway/webui/src/hooks/use-voice-client.ts gateway/webui/src/constants.ts agents/docs/gateway/webui/audio-cycle-serialization-details.md
  git rm gateway/webui/src/adapters/cycle-audio-queue.ts gateway/webui/src/adapters/cycle-audio-queue.test.ts
  git commit -m "$(cat <<'EOF'
  fix(webui): turn audio queue never cancels/replaces an in-flight turn

  CycleAudioQueue faded out the active stream once minEagerEndMs elapsed
  and a newer cycle arrived — exactly what 2.0 forbids (spec §7.2): a
  follow-up turn's audio must queue behind the turn that triggered it,
  never cut it off. Replaces it with a plain FIFO queue keyed by turnId;
  cancelAll() (barge-in/interrupt) remains the only hard-stop path.
  EOF
  )"
  ```

**Phase C — permission-prompt reducer (TDD)**

- [ ] **Step 16: write the failing test for the permission-prompt reducer.**
  Create `gateway/webui/src/hooks/permission-helpers.test.ts`:
  ```ts
  import { describe, expect, it } from "vitest";
  import type { PermissionRequest } from "@sentient/web-sdk";
  import { reducePermissionPrompt } from "./permission-helpers.ts";

  function makeRequest(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
    return {
      requestId: "req-1",
      toolCallId: "call-1",
      toolName: "write_file",
      args: { path: "/tmp/x" },
      description: "Write to /tmp/x",
      expiresAtMs: Date.now() + 120_000,
      ...overrides,
    };
  }

  describe("reducePermissionPrompt", () => {
    it("opens the dialog on a request event", () => {
      const request = makeRequest();
      const next = reducePermissionPrompt(null, { type: "request", request });
      expect(next).toBe(request);
    });

    it("closes the dialog when resolved matches the pending requestId", () => {
      const request = makeRequest();
      const opened = reducePermissionPrompt(null, { type: "request", request });
      const next = reducePermissionPrompt(opened, { type: "resolved", requestId: "req-1", outcome: "allowed" });
      expect(next).toBeNull();
    });

    it("closes the dialog on a server-driven timeout outcome with no prior user action", () => {
      const request = makeRequest();
      const opened = reducePermissionPrompt(null, { type: "request", request });
      const next = reducePermissionPrompt(opened, { type: "resolved", requestId: "req-1", outcome: "timeout" });
      expect(next).toBeNull();
    });

    it("ignores a resolved event for a requestId that isn't the pending one", () => {
      const request = makeRequest({ requestId: "req-1" });
      const opened = reducePermissionPrompt(null, { type: "request", request });
      const next = reducePermissionPrompt(opened, { type: "resolved", requestId: "req-stale", outcome: "timeout" });
      expect(next).toBe(opened);
    });

    it("a resolved event with no dialog open stays closed", () => {
      const next = reducePermissionPrompt(null, { type: "resolved", requestId: "req-1", outcome: "denied" });
      expect(next).toBeNull();
    });
  });
  ```

- [ ] **Step 17: run it, confirm it fails on the missing module.**
  ```bash
  cd /Users/kevinye/Development/sentient/gateway/webui && source ../../scripts/env.sh && bun run test src/hooks/permission-helpers.test.ts
  ```
  Expected failure: `Cannot find module './permission-helpers.ts'`.

- [ ] **Step 18: implement `permission-helpers.ts`.**
  Create `gateway/webui/src/hooks/permission-helpers.ts`:
  ```ts
  import type { PermissionOutcome, PermissionRequest } from "@sentient/web-sdk";

  export type PermissionPromptEvent =
    | { readonly type: "request"; readonly request: PermissionRequest }
    | { readonly type: "resolved"; readonly requestId: string; readonly outcome: PermissionOutcome };

  /**
   * Pure reducer for the permission-prompt dialog's visibility.
   *
   * Fail-closed invariant (spec §7.1 / §5.3): a "resolved" event only ever
   * clears the CURRENTLY shown request (matched by requestId) — a resolved
   * frame for a different or already-cleared requestId is ignored rather
   * than treated as an implicit dismissal. This is what lets the server
   * close the dialog on its own (2-minute timeout auto-deny) through the
   * exact same path a user's Allow/Deny click uses, with no separate
   * "server dismiss" branch to keep in sync.
   */
  export function reducePermissionPrompt(
    current: PermissionRequest | null,
    event: PermissionPromptEvent,
  ): PermissionRequest | null {
    if (event.type === "request") return event.request;
    if (!current || current.requestId !== event.requestId) return current;
    return null;
  }
  ```

- [ ] **Step 19: run to green.**
  ```bash
  cd /Users/kevinye/Development/sentient/gateway/webui && source ../../scripts/env.sh && bun run test src/hooks/permission-helpers.test.ts
  ```

- [ ] **Step 20: commit.**
  ```bash
  cd /Users/kevinye/Development/sentient
  git add gateway/webui/src/hooks/permission-helpers.ts gateway/webui/src/hooks/permission-helpers.test.ts
  git commit -m "$(cat <<'EOF'
  feat(webui): pure reducer for the permission-prompt dialog's visibility

  Server-driven timeout must close the dialog with no user click (§7.1,
  fail-closed). Routes both the user's Allow/Deny and the server's
  permission.resolved through one reducer keyed on requestId so a stale
  or mismatched resolved frame can never clobber a newer request.
  EOF
  )"
  ```

**Phase D — `PermissionConnector` wiring + `PermissionDialog` UI**

- [ ] **Step 21: register `PermissionConnector` in `use-voice-client.ts` and expose the signal + action.**
  Add to the imports: `PermissionConnector, type PermissionRequest` from `"@sentient/web-sdk"`, and `reducePermissionPrompt` from `"./permission-helpers.ts"`.
  Add the signal alongside the others near the top of the hook:
  ```ts
  const permissionRequest = useSignal<PermissionRequest | null>(null);
  ```
  Construct + register the connector inside the `resources` useMemo, next to `preferencesConnector`:
  ```ts
  const permissionConnector = new PermissionConnector({
    onRequest: (request) => {
      log.info("permission.request", {
        requestId: request.requestId,
        toolCallId: request.toolCallId,
        toolName: request.toolName,
      });
      permissionRequest.value = reducePermissionPrompt(permissionRequest.peek(), { type: "request", request });
    },
    onResolved: (requestId, outcome) => {
      const before = permissionRequest.peek();
      const next = reducePermissionPrompt(before, { type: "resolved", requestId, outcome });
      if (before && !next) {
        log.info("permission.resolved", { requestId, outcome });
      }
      permissionRequest.value = next;
    },
  });
  ```
  Register it: `sdk.register(permissionConnector);` (next to the other `sdk.register(...)` calls), and add `permissionConnector,` to the `resources` object's return value.
  Add to the hook's returned object (next to `patchPreferences`):
  ```ts
  permissionRequest,
  respondToPermission: (approved: boolean) => {
    const current = permissionRequest.peek();
    if (!current) return;
    log.info("permission.respond", { requestId: current.requestId, approved });
    resources.permissionConnector.respond(current.requestId, approved);
    permissionRequest.value = null;
  },
  ```

- [ ] **Step 22: build `PermissionDialog`.**
  Create `gateway/webui/src/components/permission/permission-dialog.tsx`:
  ```tsx
  import type { JSX } from "preact";
  import type { PermissionRequest } from "@sentient/web-sdk";
  import { Dialog } from "../common/dialog.tsx";

  export interface PermissionDialogProps {
    request: PermissionRequest;
    onRespond(approved: boolean): void;
  }

  const ARG_VALUE_MAX = 80;

  function formatArgValue(value: unknown): string {
    const raw = typeof value === "string" ? value : JSON.stringify(value);
    return raw.length > ARG_VALUE_MAX ? `${raw.slice(0, ARG_VALUE_MAX)}…` : raw;
  }

  function summarizeArgs(args: Record<string, unknown>): string {
    const entries = Object.entries(args);
    if (entries.length === 0) return "(no arguments)";
    return entries.map(([key, value]) => `${key}: ${formatArgValue(value)}`).join(", ");
  }

  export function PermissionDialog({ request, onRespond }: PermissionDialogProps): JSX.Element {
    // ESC / backdrop-click both route through Dialog's onClose. Per §7.1 the
    // prompt "blocks the turn until answered" — Deny IS an answer, so dismiss
    // routes to Deny instead of adding a suppression mode to the shared
    // Dialog primitive. The dialog never closes without a wire response.
    const deny = (): void => onRespond(false);
    return (
      <Dialog
        title="Permission requested"
        description={request.description}
        onClose={deny}
        footer={
          <>
            <button type="button" class="app-dialog__btn app-dialog__btn--ghost" onClick={deny}>
              Deny
            </button>
            <button
              type="button"
              class="app-dialog__btn app-dialog__btn--danger"
              onClick={() => onRespond(true)}
            >
              Allow
            </button>
          </>
        }
      >
        <div class="permission-dialog__tool">
          <span class="permission-dialog__tool-label">Tool</span>
          <span class="permission-dialog__tool-name">{request.toolName}</span>
        </div>
        <div class="permission-dialog__args">{summarizeArgs(request.args)}</div>
      </Dialog>
    );
  }
  ```

- [ ] **Step 23: add `permission-dialog.css` and register it in `main.tsx`.**
  Create `gateway/webui/src/components/permission/permission-dialog.css`:
  ```css
  .permission-dialog__tool {
    display: flex;
    align-items: baseline;
    gap: var(--space-sm);
    padding: var(--space-md);
    background: var(--color-bg-elev);
    border: 1px solid var(--color-line-soft);
    border-radius: var(--radius-md);
  }
  .permission-dialog__tool-label {
    font-size: var(--font-size-xs);
    font-weight: 600;
    color: var(--color-ink-3);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .permission-dialog__tool-name {
    font-family: monospace;
    font-size: var(--font-size-sm);
    font-weight: 600;
    color: var(--color-ink);
  }
  .permission-dialog__args {
    font-size: var(--font-size-sm);
    color: var(--color-ink-2);
    word-break: break-word;
    white-space: pre-wrap;
  }
  ```
  In `gateway/webui/src/main.tsx`, add the import after the other component CSS imports:
  ```ts
  import "./components/sessions/drawer.css";
  import "./components/permission/permission-dialog.css";
  ```

- [ ] **Step 24: mount `PermissionDialog` in `app.tsx`.**
  Add the import: `import { PermissionDialog } from "./components/permission/permission-dialog.tsx";`
  Mount it as a sibling to `<Drawer>` / `<ToastHost>` inside `AppInner`'s return, gated purely on the SDK-sourced signal:
  ```tsx
  <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />
  {connectionLost && <ConnectionLostBanner onReconnect={client.reconnect} />}
  {client.permissionRequest.value && (
    <PermissionDialog request={client.permissionRequest.value} onRespond={client.respondToPermission} />
  )}
  <ToastHost />
  ```

- [ ] **Step 25: verify (not rewrite) multi-bubble follow-up rendering.**
  No code change. Trace it once by hand against the already-committed `cycle-helpers.ts` (Phase A rename, unchanged logic): a follow-up turn only ever starts (`turn.started`) after the prior turn's `turn.completed` has already landed and been appended to the store — so by the time `InFlightMessageConnector` opens a new inflight slot for the follow-up turn, `ConversationHistoryConnector` has already delivered the prior turn as a committed entry. `appendCommittedItems` renders every committed entry (arbitrarily many), and `appendInflightMessage` renders exactly one more bubble for whatever's currently streaming — so two consecutive assistant bubbles (one committed, one inflight, two different `turnId`s) fall out of the existing logic with zero new code. `message-list.tsx`'s `m.turnId === currentTurnId` equality check (Phase A, step 4) only affects which bubble gets the "speaking" avatar pulse, not which bubbles render. This confirms scope item (d): the rename (Phase A) plus the turn-ordered audio queue (Phase B, which stops the SECOND bubble's audio from ever cutting off the FIRST bubble's still-playing audio) are the complete fix — no additional rendering logic needed.

- [ ] **Step 26: full verification gate + commit.**
  ```bash
  cd /Users/kevinye/Development/sentient && source scripts/env.sh
  bun run lint
  bun run typecheck
  bun run test
  ```
  All three must be clean before committing (this is the first point where the whole tree — Phases A through D together — typechecks cleanly; Step 7's typecheck run was expected to show now-resolved errors from Phases B/D).
  ```bash
  git add gateway/webui/src/hooks/use-voice-client.ts gateway/webui/src/components/permission/permission-dialog.tsx gateway/webui/src/components/permission/permission-dialog.css gateway/webui/src/main.tsx gateway/webui/src/app.tsx
  git commit -m "$(cat <<'EOF'
  feat(webui): permission-prompt dialog bound to the confirm wire frame

  Renders a blocking modal (existing Dialog primitive, ghost/danger button
  pattern) on permission.request; sends permission.response on Allow/Deny;
  ESC/backdrop dismiss routes to Deny (an answer, not a silent close);
  closes on a server-driven permission.resolved (incl. 2-minute timeout)
  with no user action, via the Phase-C reducer.
  EOF
  )"
  ```

---

#### E2E matrix rows this task makes reachable (owned by Task 11, listed here for traceability per the e2e-testing rule)

| Case | Viewport | Pre-state | Action | Expected user-visible | Expected log trail |
|---|---|---|---|---|---|
| permission-confirm-web | desktop 1280×900 + mobile 390×844 | authed | trigger a side-effecting tool | permission **dialog** shown (tool name, description, Allow/Deny); approve→executes, deny→blocked | `permission.request` in; `permission.response` out; dialog closes on `permission.resolved` |
| steer-followup-audio | desktop | authed, TTS speaking final answer | bg task completes after final answer | second bubble appears; its audio plays AFTER the first finishes; first never cut off | `turn.started` for the follow-up turn; no `playback.stop` frame; `turn-audio-queue` buffers behind the still-active turn, promotes only on drain+doneReceived |
