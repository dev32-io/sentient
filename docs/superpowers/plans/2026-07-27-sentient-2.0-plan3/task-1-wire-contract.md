### Task 1: Wire contract v2 — freeze the 2.0 gateway ↔ client seam

**Spec:** §7 (client wire contract), §7.1 (permission prompt), §7.2 (client audio queueing), §4.7 (cancellation cutoff kinds). **Build-order slice 6.**

This is the trunk. Every task after this one consumes these exact shapes as a fixed seam and **may not add or rename a frame**. Nothing here needs a live LLM key, a running gateway, or a device — it is pure schema + emitter work, fully covered by the unit suite.

**Two things change character in this task, on purpose:**

1. `TurnEmitter.toolUpdate` and `TurnEmitter.turnAborted` **stop being log-only.** Plan 2's `ws-turn-emitter.ts` deliberately swallowed both (see its file header). From this task on, both write a real client frame (`turn.tool.update`, `turn.aborted`). Their existing "is log-only" regression tests are inverted, not deleted.
2. Six brand-new emitter methods (`audioStart`, `audioFrame`, `audioDone`, `permissionRequest`, `permissionResolved`, `delegationProgress`) emit **real frames with no producer yet**. Task 2 wires the audio three; Task 6 wires the permission/delegation three. A method that is implemented-and-tested but not yet called is the expected, correct end state of this task — do **not** stub them out, and do not add callers.

#### Files

**Create**
- `gateway/src/session-handlers/ws-send.ts`

**Modify**
- `shared/protocol/src/messages.ts`
- `shared/protocol/src/conversation.ts`
- `shared/protocol/WIRE.md`
- `gateway/src/runtime/turn-emitter.ts`
- `gateway/src/runtime/session-runtime.ts`
- `gateway/src/runtime/react-loop.ts`
- `gateway/src/session-handlers/ws-turn-emitter.ts`
- `gateway/src/session-handlers/ws-handlers.ts`
- `gateway/src/bootstrap/native-brain-text.test.ts`
- `gateway/src/runtime/session-runtime.test.ts`
- `shared/web-sdk/src/connectors/task-status-connector.ts`
- `gateway/scripts/try-chat.ts`

**Delete**
- `gateway/scripts/smoke-cerebrum.ts`

**Test**
- `shared/protocol/src/messages.test.ts` (rewrite of the frame-shape blocks)
- `gateway/src/session-handlers/ws-turn-emitter.test.ts` (rewrite)

#### Interfaces

**Consumes (exists today — verified signatures, do not re-derive):**

```ts
// gateway/src/runtime/react-loop.ts
export type ToolUpdateStatus = "running" | "done" | "error";
export interface ToolUpdate {
  toolCallId: string;
  toolName: string;
  status: ToolUpdateStatus;
  taskId?: string;
}

// gateway/src/store/entry-types.ts
export type CutoffKind = "interrupt" | "barge-in";

// gateway/src/store/session-store.ts (SessionStore)
readSince(sessionId: string, afterSeq: number): SessionEntry[];

// gateway/src/runtime/stimulus.ts
export type Stimulus =
  | { kind: "conversational"; text: string }
  | { kind: "background-completion"; note: string };

// gateway/src/logging/logger.ts
export function getLog(tags: string[]): Logger; // .debug/.info/.warn/.error(msg, props)

// gateway/src/session-handlers/ws-helpers.ts
export interface SessionData { sessionId: string | null; /* … */ }
```

**Produces (later tasks rely on these exact exported names):**

```ts
// shared/protocol/src/messages.ts — gateway → client
turnStartedSchema, turnTextDeltaSchema, turnCompletedSchema, turnAbortedSchema,
turnToolUpdateSchema, turnAudioStartSchema, turnAudioDoneSchema,
permissionRequestSchema, permissionResolvedSchema, delegationProgressSchema,
playbackStopSchema (rekeyed), conversationEntrySchema (rekeyed)
turnTriggerSchema, turnCutoffSchema, turnToolStatusSchema,
turnAudioEncodingSchema, permissionOutcomeSchema, delegationStatusSchema

export type TurnTrigger        = "user" | "background-completion";
export type TurnCutoff         = "interrupt" | "barge-in";
export type TurnToolStatus     = "running" | "done" | "error";
export type TurnAudioEncoding  = "opus" | "pcm";
export type PermissionOutcome  = "allowed" | "denied" | "timeout";
export type DelegationStatus   = "running" | "done" | "error";
export type TurnStartedMessage, TurnTextDeltaMessage, TurnCompletedMessage,
            TurnAbortedMessage, TurnToolUpdateMessage, TurnAudioStartMessage,
            TurnAudioDoneMessage, PermissionRequestMessage,
            PermissionResolvedMessage, DelegationProgressMessage

// shared/protocol/src/messages.ts — client → gateway
permissionResponseSchema
export type PermissionResponse = { type: "permission.response"; requestId: string; approved: boolean };

// gateway/src/runtime/turn-emitter.ts
export type PermissionRequest    = Omit<PermissionRequestMessage, "type">;
export type PermissionResolution = Omit<PermissionResolvedMessage, "type">;
export type DelegationProgress   = Omit<DelegationProgressMessage, "type">;
export interface TurnEmitter { /* final 2.0 shape — 11 methods, see Step 8 */ }

// gateway/src/session-handlers/ws-send.ts
export function sendGatewayFrame(ws: ServerWebSocket<SessionData>, frame: GatewayMessage): boolean;
export function encodeAudioFrame(seq: number, payload: Uint8Array): Uint8Array;
export function sendAudioFrame(ws: ServerWebSocket<SessionData>, seq: number, payload: Uint8Array): boolean;

// gateway/src/runtime/react-loop.ts (additive)
export interface ToolUpdate { /* … */ argsPreview?: string }
```

---

#### Part A — `shared/protocol` (commit 1)

- [ ] **Step 1: Write the failing protocol test for the turn-lifecycle frames.**

Open `shared/protocol/src/messages.test.ts`. **Delete these `describe` blocks in full** — every frame they cover is retired by this task:

| Block | Approx. lines today |
|---|---|
| `describe("cycle.started", …)` | 220–239 |
| `describe("connector.cancelled", …)` | 241–252 |
| `describe("cycle.aborted", …)` | 254–263 |
| `describe("cycle.completed", …)` | 265–283 |
| `describe("connector.transcript.final", …)` | 285–305 |
| `describe("message.delta", …)` | 307–324 |
| `describe("message.done", …)` | 326–334 |
| `describe("connector.audio.start", …)` | 364–376 |
| `describe("connector.audio.done", …)` | 378–388 |
| `describe("cognition.status", …)` | 390–417 |
| `describe("task.update", …)` | 510–549 |

Then replace the whole import block at the top (lines 9–30) with:

```ts
import {
  audioStartSchema,
  clientMessageSchema,
  conversationEntrySchema,
  delegationProgressSchema,
  gatewayMessageSchema,
  permissionRequestSchema,
  permissionResolvedSchema,
  permissionResponseSchema,
  playbackStopSchema,
  sessionConfigureSchema,
  sessionReadySchema,
  streamResumedSchema,
  textInputSchema,
  turnAbortedSchema,
  turnAudioStartSchema,
  turnStartedSchema,
  turnTextDeltaSchema,
  turnToolUpdateSchema,
} from "./messages.ts";
import type { StreamResumed } from "./messages.ts";
```

Now append this new block at the end of the file:

```ts
// ---------------------------------------------------------------------------
// Wire contract v2 (spec §7) — the frozen 2.0 gateway → client frame set.
// These tests exist because four packages (gateway, web-sdk, webui, KMP SDK)
// decode these bytes at a process boundary; a silent rename here is a
// production-only failure. Pin the SHAPES, not the plumbing.
// ---------------------------------------------------------------------------

describe("turn lifecycle frames", () => {
  it("parses turn.started with a user trigger", () => {
    const result = turnStartedSchema.safeParse({ type: "turn.started", turnId: "t-1", trigger: "user" });
    expect(result.success).toBe(true);
  });

  it("parses turn.started with a background-completion trigger", () => {
    const result = turnStartedSchema.safeParse({
      type: "turn.started",
      turnId: "t-1",
      trigger: "background-completion",
    });
    expect(result.success).toBe(true);
  });

  it("rejects turn.started without a trigger", () => {
    expect(turnStartedSchema.safeParse({ type: "turn.started", turnId: "t-1" }).success).toBe(false);
  });

  it("rejects an unknown turn.started trigger", () => {
    expect(turnStartedSchema.safeParse({ type: "turn.started", turnId: "t-1", trigger: "ambient" }).success).toBe(
      false,
    );
  });

  it("turn.text.delta carries turnId — the field response.text.delta was missing", () => {
    expect(turnTextDeltaSchema.safeParse({ type: "turn.text.delta", turnId: "t-1", text: "hi" }).success).toBe(true);
    expect(turnTextDeltaSchema.safeParse({ type: "turn.text.delta", text: "hi" }).success).toBe(false);
  });

  it("parses turn.aborted for both cutoff kinds", () => {
    for (const cutoff of ["interrupt", "barge-in"]) {
      expect(turnAbortedSchema.safeParse({ type: "turn.aborted", turnId: "t-1", cutoff }).success).toBe(true);
    }
  });

  it("rejects an unknown turn.aborted cutoff", () => {
    expect(turnAbortedSchema.safeParse({ type: "turn.aborted", turnId: "t-1", cutoff: "timeout" }).success).toBe(false);
  });
});

describe("turn.tool.update", () => {
  const base = {
    type: "turn.tool.update",
    turnId: "t-1",
    toolCallId: "c-1",
    toolName: "delegateTask",
    status: "running",
    argsPreview: '{"agent":"hermes"}',
    startedAtMs: 1000,
  };

  it("parses a foreground running update (no taskId, no endedAtMs)", () => {
    expect(turnToolUpdateSchema.safeParse(base).success).toBe(true);
  });

  it("parses a background running update carrying taskId", () => {
    expect(turnToolUpdateSchema.safeParse({ ...base, taskId: "task-9" }).success).toBe(true);
  });

  it("parses a terminal update carrying endedAtMs", () => {
    expect(turnToolUpdateSchema.safeParse({ ...base, status: "done", endedAtMs: 1200 }).success).toBe(true);
  });

  it("requires argsPreview and startedAtMs", () => {
    for (const field of ["argsPreview", "startedAtMs"]) {
      const incomplete: Record<string, unknown> = { ...base };
      delete incomplete[field];
      expect(turnToolUpdateSchema.safeParse(incomplete).success, `missing ${field}`).toBe(false);
    }
  });

  it("rejects the retired task.update status vocabulary", () => {
    for (const status of ["finished", "cancelled", "failed"]) {
      expect(turnToolUpdateSchema.safeParse({ ...base, status }).success).toBe(false);
    }
  });
});

describe("turn.audio.start encoding", () => {
  it("accepts opus and pcm", () => {
    for (const encoding of ["opus", "pcm"]) {
      expect(
        turnAudioStartSchema.safeParse({ type: "turn.audio.start", turnId: "t-1", encoding, sampleRate: 48000 })
          .success,
      ).toBe(true);
    }
  });

  it("rejects pcm16 — the wire enum is exactly opus | pcm", () => {
    expect(
      turnAudioStartSchema.safeParse({ type: "turn.audio.start", turnId: "t-1", encoding: "pcm16", sampleRate: 48000 })
        .success,
    ).toBe(false);
  });

  it("rejects a non-positive sampleRate", () => {
    expect(
      turnAudioStartSchema.safeParse({ type: "turn.audio.start", turnId: "t-1", encoding: "opus", sampleRate: 0 })
        .success,
    ).toBe(false);
  });
});

describe("permission mediation frames (spec §7.1)", () => {
  it("parses permission.request with args and an expiry", () => {
    const result = permissionRequestSchema.safeParse({
      type: "permission.request",
      requestId: "r-1",
      toolCallId: "c-1",
      toolName: "sendMessage",
      args: { to: "+1555", body: "hi" },
      description: "Send a message to +1555",
      expiresAtMs: 1_700_000_000_000,
    });
    expect(result.success).toBe(true);
  });

  it("parses permission.resolved for every outcome — timeout included (fail-closed)", () => {
    for (const outcome of ["allowed", "denied", "timeout"]) {
      expect(permissionResolvedSchema.safeParse({ type: "permission.resolved", requestId: "r-1", outcome }).success).toBe(
        true,
      );
    }
  });

  it("rejects an unknown permission outcome", () => {
    expect(
      permissionResolvedSchema.safeParse({ type: "permission.resolved", requestId: "r-1", outcome: "expired" }).success,
    ).toBe(false);
  });

  it("clientMessageSchema accepts permission.response and rejects the retired tool.confirm", () => {
    expect(
      clientMessageSchema.safeParse({ type: "permission.response", requestId: "r-1", approved: true }).success,
    ).toBe(true);
    expect(
      clientMessageSchema.safeParse({ type: "tool.confirm", toolCallId: "c-1", approved: true }).success,
    ).toBe(false);
  });

  it("permission.response requires an explicit boolean — a missing decision is never an approval", () => {
    expect(permissionResponseSchema.safeParse({ type: "permission.response", requestId: "r-1" }).success).toBe(false);
  });
});

describe("delegation.progress (spec §5.4)", () => {
  it("parses a running update without a note", () => {
    const result = delegationProgressSchema.safeParse({
      type: "delegation.progress",
      taskId: "task-1",
      turnId: "t-1",
      agent: "hermes",
      status: "running",
    });
    expect(result.success).toBe(true);
  });

  it("parses a terminal update with a note", () => {
    const result = delegationProgressSchema.safeParse({
      type: "delegation.progress",
      taskId: "task-1",
      turnId: "t-1",
      agent: "hermes",
      status: "error",
      note: "provider timeout",
    });
    expect(result.success).toBe(true);
  });
});

describe("turnId rekey (cycleId is gone from the 2.0 wire)", () => {
  it("playback.stop is keyed by turnId", () => {
    expect(playbackStopSchema.safeParse({ type: "playback.stop", turnId: "t-1", reason: "barge-in" }).success).toBe(
      true,
    );
    expect(playbackStopSchema.safeParse({ type: "playback.stop", cycleId: "c-1", reason: "barge-in" }).success).toBe(
      false,
    );
  });

  it("conversation.entry carries an optional turnId on the FRAME, never on the item", () => {
    const item = { entryId: "e-1", ts: 1, kind: "assistant" as const, content: "hi" };
    const withTurn = conversationEntrySchema.safeParse({ type: "conversation.entry", turnId: "t-1", item });
    expect(withTurn.success).toBe(true);
    expect(withTurn.success && withTurn.data.turnId).toBe("t-1");

    // Absent on a user-echo / out-of-band entry.
    const without = conversationEntrySchema.safeParse({ type: "conversation.entry", item });
    expect(without.success).toBe(true);
    expect(without.success && without.data.turnId).toBeUndefined();
  });
});

describe("gatewayMessageSchema — the 2.0 union", () => {
  it("admits every new 2.0 frame", () => {
    const frames = [
      { type: "turn.started", turnId: "t-1", trigger: "user" },
      { type: "turn.text.delta", turnId: "t-1", text: "hi" },
      { type: "turn.completed", turnId: "t-1" },
      { type: "turn.aborted", turnId: "t-1", cutoff: "interrupt" },
      {
        type: "turn.tool.update",
        turnId: "t-1",
        toolCallId: "c-1",
        toolName: "search",
        status: "done",
        argsPreview: "{}",
        startedAtMs: 1,
        endedAtMs: 2,
      },
      { type: "turn.audio.start", turnId: "t-1", encoding: "opus", sampleRate: 48000 },
      { type: "turn.audio.done", turnId: "t-1" },
      {
        type: "permission.request",
        requestId: "r-1",
        toolCallId: "c-1",
        toolName: "sendMessage",
        args: {},
        description: "d",
        expiresAtMs: 1,
      },
      { type: "permission.resolved", requestId: "r-1", outcome: "denied" },
      { type: "delegation.progress", taskId: "task-1", turnId: "t-1", agent: "hermes", status: "running" },
      { type: "playback.stop", turnId: "t-1", reason: "interrupt" },
    ];
    for (const frame of frames) {
      expect(gatewayMessageSchema.safeParse(frame).success, `frame ${frame.type}`).toBe(true);
    }
  });

  it("rejects every retired pre-2.0 frame type", () => {
    const retired = [
      "cycle.started",
      "cycle.aborted",
      "cycle.completed",
      "message.delta",
      "message.done",
      "connector.audio.start",
      "connector.audio.done",
      "connector.cancelled",
      "connector.transcript.final",
      "task.update",
      "tool.confirm_request",
      "cognition.status",
    ];
    for (const type of retired) {
      expect(gatewayMessageSchema.safeParse({ type }).success, `retired ${type}`).toBe(false);
    }
  });

  // Reconciliation note (deliberate, reviewed): this file used to assert that
  // the literal "turn.started" was REJECTED — it was a pre-cerebrum frame
  // retired long ago. The 2.0 contract legitimately reuses that type string
  // for the native turn (spec §7: "cycle.* may become turn.* — not preserved
  // out of timidity"). The rejection that still matters is the old PAYLOAD:
  // `{ turnIdx }` with no turnId/trigger must not squeak through.
  it("accepts the 2.0 turn.started payload but still rejects the retired turnIdx payload", () => {
    expect(gatewayMessageSchema.safeParse({ type: "turn.started", turnId: "t-1", trigger: "user" }).success).toBe(true);
    expect(gatewayMessageSchema.safeParse({ type: "turn.started", turnIdx: 1 }).success).toBe(false);
  });

  it("rejects response.text.delta — Plan 2's interim frame, never a contract frame", () => {
    expect(gatewayMessageSchema.safeParse({ type: "response.text.delta", text: "hi" }).success).toBe(false);
  });

  it("rejects transcript.partial — no partial-transcript frame exists in 2.0", () => {
    expect(gatewayMessageSchema.safeParse({ type: "transcript.partial", text: "hi" }).success).toBe(false);
  });
});
```

Finally, rewrite the existing `describe("message.delta with seq/epoch (gateway push frames)", …)` block (approx. lines 629–697 today) onto the new frames — the seq/epoch contract itself is unchanged, only its carrier frame is:

```ts
describe("seq/epoch stamping on gateway push frames", () => {
  const delta = { type: "turn.text.delta", turnId: "t-1", text: "Hello" };

  it("parses a push frame WITHOUT seq/epoch (pre-sequencing frame)", () => {
    expect(gatewayMessageSchema.safeParse(delta).success).toBe(true);
  });

  it("parses a push frame WITH seq and epoch", () => {
    const result = gatewayMessageSchema.safeParse({ ...delta, seq: 42, epoch: 7 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.seq).toBe(42);
      expect(result.data.epoch).toBe(7);
    }
  });

  it("rejects negative seq", () => {
    expect(gatewayMessageSchema.safeParse({ ...delta, seq: -1, epoch: 0 }).success).toBe(false);
  });

  it("rejects fractional seq", () => {
    expect(gatewayMessageSchema.safeParse({ ...delta, seq: 1.5, epoch: 0 }).success).toBe(false);
  });

  it("parses auth.ok WITH seq/epoch", () => {
    const result = gatewayMessageSchema.safeParse({
      type: "auth.ok",
      sessionId: "s-1",
      role: "adult",
      seq: 0,
      epoch: 1,
    });
    expect(result.success).toBe(true);
  });

  it("parses turn.tool.update WITH seq/epoch", () => {
    const result = gatewayMessageSchema.safeParse({
      type: "turn.tool.update",
      turnId: "t-1",
      toolCallId: "c-1",
      toolName: "search",
      status: "running",
      argsPreview: "",
      startedAtMs: 1,
      seq: 100,
      epoch: 3,
    });
    expect(result.success).toBe(true);
  });
});
```

- [ ] **Step 2: Run the protocol test and watch it fail on the missing exports.**

```bash
source scripts/env.sh && cd shared/protocol && bunx vitest run src/messages.test.ts
```

Expected failure — the import block references schemas that do not exist yet, so the module never evaluates:

```
Error: [vitest] No "turnStartedSchema" export is defined on the "./messages.ts" mock
  … or …
SyntaxError: The requested module './messages.ts' does not provide an export named 'turnStartedSchema'
```

- [ ] **Step 3: Add the 2.0 gateway → client frames to `shared/protocol/src/messages.ts`.**

Replace everything from `// ─── Cycle Lifecycle ───` (line 221) through the end of `taskUpdateSchema` / `export type TaskUpdate` (line 341) — i.e. `cycleStartedSchema`, `connectorCancelledSchema`, `cycleAbortedSchema`, `cycleCompletedSchema`, `connectorTranscriptFinalSchema`, `connectorAudioStartSchema`, `connectorAudioDoneSchema`, `messageDeltaSchema`, `messageDoneSchema`, `cognitionStatusSchema`, `taskStatusSchema`, `TaskStatus`, `taskUpdateSchema`, `TaskUpdate` — with the block below. Keep `conversationSnapshotSchema` where it is (unchanged — it carries `items` only and has no cycle key), and keep `conversationEntrySchema` but rekeyed as shown.

```ts
// ─── Turn lifecycle (Sentient 2.0 native orchestrator, spec §7) ───
//
// A "turn" is one native ReAct run inside a `SessionRuntime`: stimulus in →
// zero or more tool round-trips → final text out. It replaces the pre-2.0
// "cycle", which was named for one Hermes round-trip — a unit the native
// brain no longer has. `turnId` is minted by `SessionRuntime`
// (crypto.randomUUID) and is the ONLY turn identity on the wire; there is no
// `cycleId` in 2.0.
//
// Turn frames NEVER imply audio control. Per spec §4.6/§7.2 the gateway does
// not stop its own TTS: a new `turn.started` must not cancel or replace
// in-flight audio — the client queues behind it. Only `playback.stop`
// (barge-in / interrupt) flushes audio.

export const turnTriggerSchema = z.enum(["user", "background-completion"]);
export type TurnTrigger = z.infer<typeof turnTriggerSchema>;

export const turnStartedSchema = z.object({
  type: z.literal("turn.started"),
  turnId: z.string(),
  /** What caused this turn: a person's message/utterance, or a background
   *  `delegateTask` completion arriving as a stimulus (spec §4.4). Clients
   *  use it to label the bubble; they never infer it. */
  trigger: turnTriggerSchema,
});
export type TurnStartedMessage = z.infer<typeof turnStartedSchema>;

export const turnTextDeltaSchema = z.object({
  type: z.literal("turn.text.delta"),
  /** REQUIRED. Plan 2's interim `response.text.delta` omitted this, which
   *  made two overlapping turns (§7.2's back-to-back follow-up) impossible to
   *  route to the right bubble. That was a bug; this frame fixes it. */
  turnId: z.string(),
  text: z.string(),
});
export type TurnTextDeltaMessage = z.infer<typeof turnTextDeltaSchema>;

export const turnCompletedSchema = z.object({
  type: z.literal("turn.completed"),
  turnId: z.string(),
});
export type TurnCompletedMessage = z.infer<typeof turnCompletedSchema>;

/** Why an assistant turn was cut short (spec §4.7). Mirrors the gateway's
 *  `CutoffKind` (gateway/src/store/entry-types.ts) and the cutoff marker
 *  stamped on the committed partial in the session store — one vocabulary,
 *  store and wire. */
export const turnCutoffSchema = z.enum(["interrupt", "barge-in"]);
export type TurnCutoff = z.infer<typeof turnCutoffSchema>;

export const turnAbortedSchema = z.object({
  type: z.literal("turn.aborted"),
  turnId: z.string(),
  cutoff: turnCutoffSchema,
});
export type TurnAbortedMessage = z.infer<typeof turnAbortedSchema>;

/** Tool-tile status. Deliberately NOT the retired `task.update` vocabulary
 *  ("finished"|"cancelled"|"failed") — the native loop only distinguishes
 *  in-flight, succeeded, and errored. */
export const turnToolStatusSchema = z.enum(["running", "done", "error"]);
export type TurnToolStatus = z.infer<typeof turnToolStatusSchema>;

export const turnToolUpdateSchema = z.object({
  type: z.literal("turn.tool.update"),
  turnId: z.string(),
  /** Provider-assigned id for this call; the client's dedupe key so one tile
   *  transitions in place instead of stacking. */
  toolCallId: z.string(),
  toolName: z.string(),
  status: turnToolStatusSchema,
  /** Present only on a BACKGROUND dispatch's "running" update (the
   *  `delegateTask` archetype). Its completion arrives later as a
   *  `delegation.progress` frame, never as a second `turn.tool.update`. */
  taskId: z.string().optional(),
  /** Short, already-truncated preview of the tool's arguments for the tile.
   *  Never the full argument object — clients render this verbatim. */
  argsPreview: z.string(),
  startedAtMs: z.number().int().nonnegative(),
  /** Present once the call reaches a terminal status. */
  endedAtMs: z.number().int().nonnegative().optional(),
});
export type TurnToolUpdateMessage = z.infer<typeof turnToolUpdateSchema>;

/** Wire encoding of the outbound TTS byte stream. Exactly two values — this
 *  is NOT the free-form `session.ready.audioEncoding` string. */
export const turnAudioEncodingSchema = z.enum(["opus", "pcm"]);
export type TurnAudioEncoding = z.infer<typeof turnAudioEncodingSchema>;

export const turnAudioStartSchema = z.object({
  type: z.literal("turn.audio.start"),
  turnId: z.string(),
  encoding: turnAudioEncodingSchema,
  sampleRate: z.number().int().positive(),
});
export type TurnAudioStartMessage = z.infer<typeof turnAudioStartSchema>;

export const turnAudioDoneSchema = z.object({
  type: z.literal("turn.audio.done"),
  turnId: z.string(),
});
export type TurnAudioDoneMessage = z.infer<typeof turnAudioDoneSchema>;

// ─── Permission mediation (spec §5.3 L3 PDP, §7.1 prompt UI) ───
//
// A `confirm` decision on a side-effecting tool blocks the turn until the
// user answers. The gateway sends `permission.request`; the client renders a
// real dialog and replies with `permission.response`. `permission.resolved`
// is the server's closing signal — it fires on EVERY resolution path,
// including the ones the client did not cause (2-minute timeout → auto-deny,
// or the turn being interrupted), so a dialog is never left orphaned on
// screen. Fail-closed: a timeout is a denial, never an implicit approval.

export const permissionRequestSchema = z.object({
  type: z.literal("permission.request"),
  /** Correlation id for this prompt. Distinct from `toolCallId`: one tool
   *  call yields at most one prompt, but the client answers by `requestId`
   *  so a late answer to a superseded prompt is trivially ignorable. */
  requestId: z.string(),
  toolCallId: z.string(),
  toolName: z.string(),
  /** The ACTUAL argument values the PDP is mediating (§2.2: authorization is
   *  value-aware). Rendered in the dialog so the user approves what will
   *  really happen, not a tool name. */
  args: z.record(z.unknown()),
  /** Human-readable one-line summary of the action, produced by the gateway. */
  description: z.string(),
  /** Absolute epoch-ms deadline. The client dismisses at this point without
   *  waiting for `permission.resolved`, so a dropped frame can't hang the UI. */
  expiresAtMs: z.number().int().nonnegative(),
});
export type PermissionRequestMessage = z.infer<typeof permissionRequestSchema>;

export const permissionOutcomeSchema = z.enum(["allowed", "denied", "timeout"]);
export type PermissionOutcome = z.infer<typeof permissionOutcomeSchema>;

export const permissionResolvedSchema = z.object({
  type: z.literal("permission.resolved"),
  requestId: z.string(),
  outcome: permissionOutcomeSchema,
});
export type PermissionResolvedMessage = z.infer<typeof permissionResolvedSchema>;

// ─── Delegation progress (spec §5.4) ───
//
// Background `delegateTask` work outlives the turn that dispatched it. This
// frame is the client's only live view of it; the eventual completion also
// re-enters the brain as a stimulus, producing a NEW turn (§4.5).

export const delegationStatusSchema = z.enum(["running", "done", "error"]);
export type DelegationStatus = z.infer<typeof delegationStatusSchema>;

export const delegationProgressSchema = z.object({
  type: z.literal("delegation.progress"),
  taskId: z.string(),
  /** The turn that DISPATCHED the task — not necessarily the turn that is
   *  live when this frame arrives. */
  turnId: z.string(),
  /** Delegated agent name, e.g. "hermes". */
  agent: z.string(),
  status: delegationStatusSchema,
  /** Short human-readable progress/failure note. Never the full result. */
  note: z.string().optional(),
});
export type DelegationProgressMessage = z.infer<typeof delegationProgressSchema>;
```

Next, rekey `conversationEntrySchema` (replace the existing block at lines ~306–316):

```ts
// `turnId` is the gateway-owned join key between a live streaming bubble
// (turn.text.delta) and its committed entry. It is carried on the FRAME, not
// on the item (the feed item deliberately strips turn/task plumbing — see
// conversation.ts). Clients read it here to render ONE bubble per reply
// instead of reverse-engineering it client-side. Optional because some
// entries have no originating turn (a user-input echo, an out-of-band
// activate entry).
export const conversationEntrySchema = z.object({
  type: z.literal("conversation.entry"),
  turnId: z.string().optional(),
  item: conversationFeedItemSchema,
});
```

Delete `toolConfirmRequestSchema` entirely (lines ~345–351) — `permission.request` replaces it.

Rekey `playbackStopSchema` (lines ~368–376):

```ts
// Tell the client to drop any playing/buffered audio for the named turn
// immediately. Fires on mic-onset (barge-in) and hard interrupt ONLY — never
// on a new turn (spec §4.6/§7.2: the gateway does not stop its own audio).
// The client filters further binary audio for a turn whose `playback.stop`
// it has already received.
export const playbackStopSchema = z.object({
  type: z.literal("playback.stop"),
  turnId: z.string(),
  reason: turnCutoffSchema,
});
export type PlaybackStopMessage = z.infer<typeof playbackStopSchema>;
```

Finally, rewrite the union (lines ~402–429):

```ts
export const gatewayMessageSchema = z.discriminatedUnion("type", [
  withSeqEpoch(authOkSchema),
  withSeqEpoch(sessionReadySchema),
  withSeqEpoch(turnStartedSchema),
  withSeqEpoch(turnTextDeltaSchema),
  withSeqEpoch(turnCompletedSchema),
  withSeqEpoch(turnAbortedSchema),
  withSeqEpoch(turnToolUpdateSchema),
  withSeqEpoch(turnAudioStartSchema),
  withSeqEpoch(turnAudioDoneSchema),
  withSeqEpoch(permissionRequestSchema),
  withSeqEpoch(permissionResolvedSchema),
  withSeqEpoch(delegationProgressSchema),
  withSeqEpoch(conversationSnapshotSchema),
  withSeqEpoch(conversationEntrySchema),
  withSeqEpoch(errorSchema),
  withSeqEpoch(pongSchema),
  withSeqEpoch(sessionExpiredSchema),
  withSeqEpoch(playbackStopSchema),
  withSeqEpoch(sessionsDeletedEventSchema),
  withSeqEpoch(sessionsRenamedEventSchema),
  withSeqEpoch(sessionCreatedEventSchema),
  withSeqEpoch(sessionSwitchedEventSchema),
  withSeqEpoch(sessionsErrorSchema),
  streamResumedSchema, // already wrapped with withSeq; epoch is required on this frame
]);
```

- [ ] **Step 4: Swap `tool.confirm` for `permission.response` on the client → gateway half.**

In `shared/protocol/src/messages.ts`, replace `toolConfirmSchema` (lines 155–159) with:

```ts
// Client → gateway answer to a `permission.request` (spec §7.1). Keyed by
// `requestId`, not `toolCallId`: the gateway may have already resolved the
// request (timeout, interrupt) by the time this lands, and matching on the
// prompt id makes that late answer a clean no-op instead of a stale approval
// applied to a different call. `approved` is REQUIRED — there is no
// "unanswered" wire value, because a missing decision must never read as yes.
export const permissionResponseSchema = z.object({
  type: z.literal("permission.response"),
  requestId: z.string(),
  approved: z.boolean(),
});
export type PermissionResponse = z.infer<typeof permissionResponseSchema>;
```

and update the union member at line 186: `toolConfirmSchema,` → `permissionResponseSchema,`.

- [ ] **Step 5: Update the stale `cycleId` prose in `shared/protocol/src/conversation.ts`.**

Replace lines 11–14 of the header comment:

```ts
// NOTE on turnId: it is stripped from the ITEM but carried on the
// `conversation.entry` FRAME (see messages.ts conversationEntrySchema). Clients
// re-attach the frame turnId to a live assistant entry so the committed twin
// joins its streaming bubble by id — the client never invents/derives the id.
```

And in the `conversationAssistantCutoffSchema` comment (lines 36–38), replace `cycle was hard-aborted` with `turn was hard-aborted`. Leave the schema shape itself alone — `barge-in` / `interrupt` already match `turnCutoffSchema`.

- [ ] **Step 6: Keep `shared/web-sdk` compiling — retarget the one typed import.**

`shared/web-sdk/src/connectors/task-status-connector.ts` imports the now-deleted `TaskStatus`. Task 4 rewrites this connector onto `turn.tool.update`; this task only keeps the package green. Change line 1 to:

```ts
import type { TurnToolStatus } from "@sentient/protocol";
```

then replace the two `TaskStatus` usages (lines 12 and 64) with `TurnToolStatus`, and replace the "Receives:" line in the class header comment (line 33) with:

```ts
//   - task.update  (RETIRED — the 2.0 gateway never emits this frame; Task 4
//                   rebases this connector onto `turn.tool.update`, keyed by
//                   toolCallId + turnId. Inert until then, by design.)
```

`gateway/webui` reads `TaskSnapshotItem["status"]` structurally (`tool-pill-strip.tsx` builds a CSS class from it; `app.tsx` compares to `"running"`), so no webui change is needed for this swap.

- [ ] **Step 7: Run the protocol + web-sdk suites to green, then commit.**

```bash
source scripts/env.sh && cd shared/protocol && bunx vitest run src/messages.test.ts
```

Expected: all tests pass (the file should end up around 90–100 assertions).

```bash
source scripts/env.sh && bun run --filter '@sentient/protocol' typecheck && bun run --filter '@sentient/web-sdk' typecheck
```

Expected: both clean.

```bash
git add shared/protocol/src/messages.ts shared/protocol/src/messages.test.ts shared/protocol/src/conversation.ts shared/web-sdk/src/connectors/task-status-connector.ts
git commit -m "feat(protocol): freeze the 2.0 turn/permission/delegation wire contract

Replaces the pre-2.0 cycle.* / message.* / connector.audio.* / task.update /
tool.confirm_request / cognition.status frames with the turn.* set, adds
permission.request/resolved + delegation.progress, and rekeys playback.stop
and conversation.entry from cycleId to turnId. Client -> gateway tool.confirm
becomes permission.response. Spec 7."
```

---

#### Part B — `TurnEmitter` final shape (commit 2)

- [ ] **Step 8: Rewrite `gateway/src/runtime/turn-emitter.ts` to the final 2.0 interface.**

This is the ONE edit this file gets. Tasks 2 and 6 wire producers to these methods and must not need to touch this file again. Replace the whole file:

```ts
// TurnEmitter (spec §7) — the outbound-frame seam between a turn's runtime
// callbacks and whatever transport sits on top of them. `SessionRuntime`
// drives turnStarted/textDelta/toolUpdate/turnCompleted; `cancellation.ts`
// drives turnAborted; the voice pipeline (Plan 3 Task 2) drives the audio
// three; the permission PDP and the delegation guard (Plan 3 Task 6) drive
// permissionRequest/permissionResolved/delegationProgress.
//
// This interface is the FINAL 2.0 shape, frozen alongside the wire contract
// in shared/protocol/src/messages.ts. Every method maps 1:1 onto exactly one
// frame in that contract — an emitter method with no frame, or a frame with
// no emitter method, is a contract break, not a feature.
//
// Two implementations exist: `createLoggingTurnEmitter` (below — a headless
// lifecycle trace for the dev harness and `@live` tests) and
// `createWsTurnEmitter` (session-handlers/ws-turn-emitter.ts — the real
// client socket).

import type {
  DelegationProgressMessage,
  PermissionRequestMessage,
  PermissionResolvedMessage,
  TurnAudioEncoding,
  TurnTrigger,
} from "@sentient/protocol";
import { getLog } from "../logging/logger.js";
import type { CutoffKind } from "../store/entry-types.js";
import type { ToolUpdate } from "./react-loop.js";

const log = getLog(["sentient", "runtime", "turn-emitter"]);

const TEXT_PREVIEW_LEN = 120;

/** Wire payloads minus the `type` discriminator — the emitter owns the frame
 *  type; callers supply only the domain fields. Derived from the protocol
 *  schemas by construction so a wire change can never silently diverge from
 *  the seam callers program against. */
export type PermissionRequest = Omit<PermissionRequestMessage, "type">;
export type PermissionResolution = Omit<PermissionResolvedMessage, "type">;
export type DelegationProgress = Omit<DelegationProgressMessage, "type">;

export interface TurnEmitter {
  turnStarted(turnId: string, trigger: TurnTrigger): void;
  textDelta(turnId: string, text: string): void;
  toolUpdate(turnId: string, u: ToolUpdate): void;
  turnCompleted(turnId: string): void;
  turnAborted(turnId: string, cutoff: CutoffKind): void;
  /** Announces the outbound TTS stream for `turnId`. Does NOT stop any
   *  previous turn's audio — per spec §4.6/§7.2 the gateway never interrupts
   *  its own playback; the client queues. */
  audioStart(turnId: string, encoding: TurnAudioEncoding, sampleRate: number): void;
  /** One encoded TTS chunk. Travels as a BINARY frame, not JSON. */
  audioFrame(turnId: string, bytes: Uint8Array): void;
  audioDone(turnId: string): void;
  permissionRequest(req: PermissionRequest): void;
  /** Fires on EVERY resolution path — user answer, 2-minute timeout
   *  auto-deny, or turn abort — so a client dialog is never orphaned. */
  permissionResolved(res: PermissionResolution): void;
  delegationProgress(p: DelegationProgress): void;
}

/**
 * Logging-only impl for headless use (dev harness, `@live` walks). Never
 * dumps full text or argument values (logging rule: previews only, ≤120
 * chars, no user content) — the store already holds the durable record; this
 * is a lifecycle trace, not a transport.
 */
export function createLoggingTurnEmitter(): TurnEmitter {
  return {
    turnStarted(turnId, trigger) {
      log.info("turn-emitter.turn-started", { turnId, trigger });
    },
    textDelta(turnId, text) {
      log.debug("turn-emitter.text-delta", {
        turnId,
        length: text.length,
        preview: text.slice(0, TEXT_PREVIEW_LEN),
      });
    },
    toolUpdate(turnId, u) {
      log.debug("turn-emitter.tool-update", {
        turnId,
        toolCallId: u.toolCallId,
        toolName: u.toolName,
        status: u.status,
        taskId: u.taskId,
      });
    },
    turnCompleted(turnId) {
      log.info("turn-emitter.turn-completed", { turnId });
    },
    turnAborted(turnId, cutoff) {
      log.info("turn-emitter.turn-aborted", { turnId, cutoff });
    },
    audioStart(turnId, encoding, sampleRate) {
      log.info("turn-emitter.audio-start", { turnId, encoding, sampleRate });
    },
    audioFrame(turnId, bytes) {
      log.debug("turn-emitter.audio-frame", { turnId, payloadBytes: bytes.byteLength });
    },
    audioDone(turnId) {
      log.info("turn-emitter.audio-done", { turnId });
    },
    permissionRequest(req) {
      // Argument VALUES are never logged — only which keys were mediated.
      log.info("turn-emitter.permission-request", {
        requestId: req.requestId,
        toolCallId: req.toolCallId,
        toolName: req.toolName,
        argKeys: Object.keys(req.args),
        expiresAtMs: req.expiresAtMs,
      });
    },
    permissionResolved(res) {
      log.info("turn-emitter.permission-resolved", { requestId: res.requestId, outcome: res.outcome });
    },
    delegationProgress(p) {
      log.info("turn-emitter.delegation-progress", {
        taskId: p.taskId,
        turnId: p.turnId,
        agent: p.agent,
        status: p.status,
      });
    },
  };
}
```

- [ ] **Step 9: Give `ToolUpdate` an `argsPreview` so the wire frame can be built honestly.**

`turn.tool.update` requires `argsPreview`, but today's `ToolUpdate` carries no argument data at all, so the emitter would have to invent an empty string forever. Add the field at the source, where the raw arguments are already in hand.

In `gateway/src/runtime/react-loop.ts`, add a constant next to `DEBUG_PREVIEW_LEN` (line 57):

```ts
/** Client-facing tool-tile preview budget (spec §7 `turn.tool.update`).
 *  Separate from DEBUG_PREVIEW_LEN: this one ships to a UI, not a log. */
const ARGS_PREVIEW_LEN = 120;
```

Extend the interface (lines 65–70):

```ts
export interface ToolUpdate {
  toolCallId: string;
  toolName: string;
  status: ToolUpdateStatus;
  taskId?: string;
  /** Truncated preview of the raw argument JSON for the client's tool tile.
   *  Optional so existing callers/fakes stay valid; the WS emitter falls back
   *  to "" when absent. */
  argsPreview?: string;
}
```

In `dispatchToolCalls`, add one line right after `const toolName = call.function.name;` (line 167):

```ts
    const argsPreview = call.function.arguments.slice(0, ARGS_PREVIEW_LEN);
```

and pass it at all three `onToolUpdate` call sites (lines 176, 193, 211):

```ts
    onToolUpdate(turnId, { toolCallId, toolName, status: "running", argsPreview });
    // …
      onToolUpdate(turnId, { toolCallId, toolName, status: "running", taskId: outcome.taskId, argsPreview });
    // …
    onToolUpdate(turnId, { toolCallId, toolName, status: outcome.isError ? "error" : "done", argsPreview });
```

- [ ] **Step 10: Thread `TurnTrigger` through `SessionRuntime`.**

`emitter.turnStarted` now needs a trigger, and `SessionRuntime` is the only place that knows one. Two edits, both narrow — do **not** touch `turnText`'s reset points, `onTurnCommitting`, the `startTurn` re-entrancy guard, or anything in `cancellation.ts`; those carry dedicated regression tests.

In `gateway/src/runtime/session-runtime.ts`, add the protocol import next to the existing `@sentient/config` import (line 55):

```ts
import type { OrchestratorConfig } from "@sentient/config";
import type { TurnTrigger } from "@sentient/protocol";
```

Replace `hasUnprocessedStimuli` (lines 199–201) with a trigger-returning version, and add the stimulus mapper next to the existing `stimulusEntryKind` (line 146):

```ts
function stimulusTrigger(stimulus: Stimulus): TurnTrigger {
  return stimulus.kind === "conversational" ? "user" : "background-completion";
}
```

```ts
  /** The trigger for the next back-to-back turn (spec §4.5), or null when
   *  nothing is pending. Same unprocessed-stimulus window the old
   *  `hasUnprocessedStimuli` read; a pending `user` entry outranks a
   *  `trigger` (background-completion) entry, because a person waiting on a
   *  reply is what the client should label the new bubble with. */
  function nextTurnTrigger(): TurnTrigger | null {
    const pending = store.readSince(sessionId, lastProcessedSeq).filter((e) => TURN_TRIGGER_KINDS.has(e.kind));
    if (pending.length === 0) return null;
    return pending.some((e) => e.kind === "user") ? "user" : "background-completion";
  }
```

In `onTurnSettled`, replace the follow-up block (lines 235–244):

```ts
    const trigger = nextTurnTrigger();
    if (trigger !== null) {
      const nextTurnId = crypto.randomUUID();
      log.info("session-runtime.turn.next-turn-trigger", {
        userId,
        sessionId,
        previousTurnId: turnId,
        nextTurnId,
        trigger,
      });
      startTurn(nextTurnId, trigger);
    }
```

Change `startTurn`'s signature (line 247) and its emitter call (line 263):

```ts
  function startTurn(turnId: string, trigger: TurnTrigger): void {
```

```ts
    emitter.turnStarted(turnId, trigger);
    log.info("session-runtime.turn.start", { userId, sessionId, turnId, trigger, lastProcessedSeq });
```

And in `submit` (line 339):

```ts
    startTurn(turnId, stimulusTrigger(stimulus));
```

- [ ] **Step 11: Update the two `TurnEmitter` test fakes so the gateway compiles.**

In `gateway/src/runtime/session-runtime.test.ts`, replace `recordingEmitter()` (lines 101–111):

```ts
function recordingEmitter(): RecordingEmitter {
  const events: RecordedEvent[] = [];
  return {
    events,
    turnStarted: (turnId) => events.push({ type: "turnStarted", turnId }),
    textDelta: (turnId) => events.push({ type: "textDelta", turnId }),
    toolUpdate: (turnId) => events.push({ type: "toolUpdate", turnId }),
    turnCompleted: (turnId) => events.push({ type: "turnCompleted", turnId }),
    turnAborted: (turnId) => events.push({ type: "turnAborted", turnId }),
    // Not driven by SessionRuntime — Task 2 (audio) and Task 6 (permission,
    // delegation) own these producers. Present so the fake satisfies the
    // final interface; recording them here would pin nothing.
    audioStart: () => {},
    audioFrame: () => {},
    audioDone: () => {},
    permissionRequest: () => {},
    permissionResolved: () => {},
    delegationProgress: () => {},
  };
}
```

Add the same six no-op members to the inline `emitter: RecordingEmitter` object literal in Case 5 (lines 542–561), immediately after its `turnAborted` member.

In `gateway/src/bootstrap/native-brain-text.test.ts`, add the same six no-op members to the object literal inside `recordingEmitter()` (after `turnAborted`, line 110).

- [ ] **Step 12: Typecheck the gateway and run the runtime suite.**

```bash
source scripts/env.sh && bun run --filter '@sentient/gateway' typecheck
```

Expected: clean.

```bash
source scripts/env.sh && cd gateway/src && bun test runtime/
```

Expected: all `react-loop.test.ts` + `session-runtime.test.ts` tests pass unchanged (the cancellation double-commit and terminal-completion-race regressions included).

- [ ] **Step 13: Commit the emitter interface change.**

```bash
git add gateway/src/runtime/turn-emitter.ts gateway/src/runtime/session-runtime.ts gateway/src/runtime/react-loop.ts gateway/src/runtime/session-runtime.test.ts gateway/src/bootstrap/native-brain-text.test.ts
git commit -m "feat(gateway): extend TurnEmitter to its final 2.0 shape

Adds trigger to turnStarted and the audio/permission/delegation methods that
map 1:1 onto the frozen wire contract, so Tasks 2 and 6 wire producers without
re-editing this seam. ToolUpdate gains argsPreview so turn.tool.update can be
built from real data. SessionRuntime derives the TurnTrigger from the pending
stimulus."
```

---

#### Part C — validated WS transport (commit 3)

- [ ] **Step 14: Rewrite `gateway/src/session-handlers/ws-turn-emitter.test.ts` to the new contract.**

This is the regression net for the whole task. Replace the file:

```ts
// Wire-contract regression test for ws-turn-emitter.ts (Plan 3 Task 1, spec
// §7). Pins the EXACT bytes the gateway puts on the client socket for every
// frame in the frozen 2.0 contract, at a real process boundary (four
// packages decode these). A FakeWs double — no provider, no network, no key.
//
// Note vs. Plan 2: `toolUpdate` and `turnAborted` used to be log-only here.
// They now emit real frames; the two "log-only" cases below are the inverted
// versions of the ones they replace.

import { describe, expect, it } from "bun:test";
import { gatewayMessageSchema } from "@sentient/protocol";
import type { ServerWebSocket } from "bun";
import type { ToolUpdate } from "../runtime/react-loop.js";
import { type SessionData, createEmptySessionData } from "./ws-helpers.js";
import { createWsTurnEmitter } from "./ws-turn-emitter.js";

const BINARY_HEADER_BYTES = 9;
const BINARY_TYPE_AUDIO = 0x01;

interface FakeWs {
  data: SessionData;
  sent: unknown[];
  binary: Uint8Array[];
  send: (data: string | Uint8Array) => void;
}

function fakeWs(): FakeWs {
  const data = createEmptySessionData();
  data.sessionId = "test-session";
  const ws: FakeWs = {
    data,
    sent: [],
    binary: [],
    send(payload) {
      if (typeof payload === "string") ws.sent.push(JSON.parse(payload));
      else ws.binary.push(payload);
    },
  };
  return ws;
}

function emitterFor(ws: FakeWs) {
  return createWsTurnEmitter(ws as unknown as ServerWebSocket<SessionData>);
}

describe("createWsTurnEmitter — turn lifecycle frames", () => {
  it("turnStarted sends { type: turn.started, turnId, trigger }", () => {
    const ws = fakeWs();
    emitterFor(ws).turnStarted("turn-1", "background-completion");
    expect(ws.sent).toEqual([{ type: "turn.started", turnId: "turn-1", trigger: "background-completion" }]);
  });

  it("textDelta sends { type: turn.text.delta, turnId, text } — turnId is present", () => {
    const ws = fakeWs();
    emitterFor(ws).textDelta("turn-1", "hello");
    expect(ws.sent).toEqual([{ type: "turn.text.delta", turnId: "turn-1", text: "hello" }]);
  });

  it("turnCompleted sends { type: turn.completed, turnId }", () => {
    const ws = fakeWs();
    emitterFor(ws).turnCompleted("turn-1");
    expect(ws.sent).toEqual([{ type: "turn.completed", turnId: "turn-1" }]);
  });

  it("turnAborted now REACHES the client (log-only in Plan 2)", () => {
    const ws = fakeWs();
    emitterFor(ws).turnAborted("turn-1", "barge-in");
    expect(ws.sent).toEqual([{ type: "turn.aborted", turnId: "turn-1", cutoff: "barge-in" }]);
  });
});

describe("createWsTurnEmitter — turn.tool.update (log-only in Plan 2)", () => {
  it("stamps startedAtMs on the running update and endedAtMs on the terminal one", () => {
    const ws = fakeWs();
    const emitter = emitterFor(ws);
    const running: ToolUpdate = {
      toolCallId: "c1",
      toolName: "search",
      status: "running",
      argsPreview: '{"q":"x"}',
    };
    emitter.toolUpdate("turn-1", running);
    emitter.toolUpdate("turn-1", { ...running, status: "done" });

    expect(ws.sent).toHaveLength(2);
    const [first, second] = ws.sent as Record<string, unknown>[];
    expect(first.type).toBe("turn.tool.update");
    expect(first.argsPreview).toBe('{"q":"x"}');
    expect(typeof first.startedAtMs).toBe("number");
    expect(first.endedAtMs).toBeUndefined();
    expect(second.status).toBe("done");
    // Terminal update reuses the running update's start stamp.
    expect(second.startedAtMs).toBe(first.startedAtMs);
    expect(typeof second.endedAtMs).toBe("number");
  });

  it("carries taskId on a background dispatch and defaults a missing argsPreview to empty", () => {
    const ws = fakeWs();
    emitterFor(ws).toolUpdate("turn-1", {
      toolCallId: "c1",
      toolName: "delegateTask",
      status: "running",
      taskId: "task-7",
    });
    const [frame] = ws.sent as Record<string, unknown>[];
    expect(frame.taskId).toBe("task-7");
    expect(frame.argsPreview).toBe("");
  });
});

describe("createWsTurnEmitter — audio", () => {
  it("audioStart / audioDone send the turn.audio.* frames", () => {
    const ws = fakeWs();
    const emitter = emitterFor(ws);
    emitter.audioStart("turn-1", "opus", 48000);
    emitter.audioDone("turn-1");
    expect(ws.sent).toEqual([
      { type: "turn.audio.start", turnId: "turn-1", encoding: "opus", sampleRate: 48000 },
      { type: "turn.audio.done", turnId: "turn-1" },
    ]);
  });

  it("audioFrame writes a binary frame: 8-byte BE seq starting at 1, type 0x01, then payload", () => {
    const ws = fakeWs();
    const emitter = emitterFor(ws);
    emitter.audioFrame("turn-1", new Uint8Array([0xaa, 0xbb]));
    emitter.audioFrame("turn-1", new Uint8Array([0xcc]));

    expect(ws.sent).toEqual([]); // binary path never touches the JSON channel
    expect(ws.binary).toHaveLength(2);

    const first = ws.binary[0] as Uint8Array;
    const view = new DataView(first.buffer, first.byteOffset, first.byteLength);
    expect(Number(view.getBigUint64(0, false))).toBe(1);
    expect(view.getUint8(8)).toBe(BINARY_TYPE_AUDIO);
    expect([...first.slice(BINARY_HEADER_BYTES)]).toEqual([0xaa, 0xbb]);

    const second = ws.binary[1] as Uint8Array;
    const view2 = new DataView(second.buffer, second.byteOffset, second.byteLength);
    expect(Number(view2.getBigUint64(0, false))).toBe(2);
  });
});

describe("createWsTurnEmitter — permission + delegation", () => {
  it("permissionRequest sends the full mediated payload", () => {
    const ws = fakeWs();
    emitterFor(ws).permissionRequest({
      requestId: "r-1",
      toolCallId: "c-1",
      toolName: "sendMessage",
      args: { to: "+1555" },
      description: "Send a message to +1555",
      expiresAtMs: 1_700_000_000_000,
    });
    expect(ws.sent).toEqual([
      {
        type: "permission.request",
        requestId: "r-1",
        toolCallId: "c-1",
        toolName: "sendMessage",
        args: { to: "+1555" },
        description: "Send a message to +1555",
        expiresAtMs: 1_700_000_000_000,
      },
    ]);
  });

  it("permissionResolved carries a timeout outcome (fail-closed resolution is still a resolution)", () => {
    const ws = fakeWs();
    emitterFor(ws).permissionResolved({ requestId: "r-1", outcome: "timeout" });
    expect(ws.sent).toEqual([{ type: "permission.resolved", requestId: "r-1", outcome: "timeout" }]);
  });

  it("delegationProgress sends the task/turn/agent triple", () => {
    const ws = fakeWs();
    emitterFor(ws).delegationProgress({ taskId: "task-1", turnId: "turn-1", agent: "hermes", status: "running" });
    expect(ws.sent).toEqual([
      { type: "delegation.progress", taskId: "task-1", turnId: "turn-1", agent: "hermes", status: "running" },
    ]);
  });
});

describe("createWsTurnEmitter — outbound validation", () => {
  it("every JSON frame it emits parses under gatewayMessageSchema", () => {
    const ws = fakeWs();
    const emitter = emitterFor(ws);
    emitter.turnStarted("turn-1", "user");
    emitter.textDelta("turn-1", "hi");
    emitter.toolUpdate("turn-1", { toolCallId: "c1", toolName: "search", status: "running", argsPreview: "{}" });
    emitter.toolUpdate("turn-1", { toolCallId: "c1", toolName: "search", status: "done", argsPreview: "{}" });
    emitter.audioStart("turn-1", "pcm", 48000);
    emitter.audioDone("turn-1");
    emitter.permissionRequest({
      requestId: "r-1",
      toolCallId: "c-1",
      toolName: "t",
      args: {},
      description: "d",
      expiresAtMs: 1,
    });
    emitter.permissionResolved({ requestId: "r-1", outcome: "allowed" });
    emitter.delegationProgress({ taskId: "task-1", turnId: "turn-1", agent: "hermes", status: "done" });
    emitter.turnAborted("turn-1", "interrupt");
    emitter.turnCompleted("turn-1");

    expect(ws.sent.length).toBeGreaterThan(0);
    for (const frame of ws.sent) {
      expect(gatewayMessageSchema.safeParse(frame).success, JSON.stringify(frame)).toBe(true);
    }
  });

  it("SECURITY/INVARIANT: an invalid frame is dropped, never sent and never thrown", () => {
    const ws = fakeWs();
    // sampleRate must be a positive int — this fails gatewayMessageSchema.
    expect(() => emitterFor(ws).audioStart("turn-1", "opus", 0)).not.toThrow();
    expect(ws.sent).toEqual([]);
  });

  it("a send failure (e.g. socket already closed) is caught, not thrown", () => {
    const ws = fakeWs();
    ws.send = () => {
      throw new Error("socket closed");
    };
    expect(() => emitterFor(ws).textDelta("turn-1", "x")).not.toThrow();
    expect(() => emitterFor(ws).audioFrame("turn-1", new Uint8Array([1]))).not.toThrow();
  });
});
```

- [ ] **Step 15: Run it and watch it fail against the Plan 2 emitter.**

```bash
source scripts/env.sh && cd gateway/src && bun test session-handlers/ws-turn-emitter.test.ts
```

Expected failure — the old emitter still writes the Plan 2 frame names and has none of the new methods:

```
error: expect(received).toEqual(expected)
  Expected: [{ type: "turn.started", turnId: "turn-1", trigger: "background-completion" }]
  Received: [{ type: "response.turn.started", turnId: "turn-1" }]
…
TypeError: emitter.audioStart is not a function
```

- [ ] **Step 16: Create the shared validated send helper `gateway/src/session-handlers/ws-send.ts`.**

```ts
// Outbound frame writer for the client WebSocket.
//
// Every gateway → client JSON frame goes through `sendGatewayFrame`, which
// parses it against `gatewayMessageSchema` BEFORE it hits the socket. Before
// this, ws-turn-emitter.ts hand-built object literals and called
// `ws.send(JSON.stringify(...))` with zero validation, which left the shared
// protocol schema decorative: a typo'd field name shipped happily and only
// surfaced as a silent client-side no-op in the browser. Parsing here also
// strips any stray key an object spread picked up, so the bytes on the wire
// are exactly the contract and nothing else.
//
// A validation failure LOGS AT ERROR AND DROPS THE FRAME. It never throws:
// these calls run inside a detached turn promise chain (session-runtime.ts
// never awaits `runTurn`), and a throw there would wedge the turn rather than
// lose one frame.
//
// Binary audio is a separate path — it carries the 9-byte header, not JSON,
// and is never routed through the JSON validator.

import { type GatewayMessage, gatewayMessageSchema } from "@sentient/protocol";
import type { ServerWebSocket } from "bun";
import { getLog } from "../logging/logger.js";
import type { SessionData } from "./ws-helpers.js";

const log = getLog(["sentient", "ws", "send"]);

const BINARY_HEADER_BYTES = 9;
const BINARY_TYPE_AUDIO = 0x01;
const REASON_PREVIEW_LEN = 120;

/** @returns true if the frame reached the socket. */
export function sendGatewayFrame(ws: ServerWebSocket<SessionData>, frame: GatewayMessage): boolean {
  const parsed = gatewayMessageSchema.safeParse(frame);
  if (!parsed.success) {
    log.error("ws-send.invalid-frame", {
      sessionId: ws.data.sessionId,
      frameType: frame.type,
      reason: parsed.error.message.slice(0, REASON_PREVIEW_LEN),
    });
    return false;
  }

  try {
    ws.send(JSON.stringify(parsed.data));
    return true;
  } catch (err) {
    // Bun's `ws.send` on a closed socket does not throw, but a frame can
    // still be in flight after session.end / a network drop; guard anyway per
    // the error-handling rule and log the degraded path with a reason.
    log.warn("ws-send.send-failed", {
      sessionId: ws.data.sessionId,
      frameType: frame.type,
      reason: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Prepends the 9-byte binary header the client SDKs peel:
 *   [8-byte BE u64 seq][1-byte type = 0x01 audio][payload]
 * Clients dedupe by `seq` and ignore `seq === 0`, so callers start at 1.
 */
export function encodeAudioFrame(seq: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(BINARY_HEADER_BYTES + payload.byteLength);
  const view = new DataView(out.buffer);
  view.setBigUint64(0, BigInt(seq), false);
  view.setUint8(8, BINARY_TYPE_AUDIO);
  out.set(payload, BINARY_HEADER_BYTES);
  return out;
}

/** @returns true if the frame reached the socket. */
export function sendAudioFrame(ws: ServerWebSocket<SessionData>, seq: number, payload: Uint8Array): boolean {
  try {
    ws.send(encodeAudioFrame(seq, payload));
    return true;
  } catch (err) {
    log.warn("ws-send.audio-send-failed", {
      sessionId: ws.data.sessionId,
      seq,
      payloadBytes: payload.byteLength,
      reason: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
```

- [ ] **Step 17: Rewrite `gateway/src/session-handlers/ws-turn-emitter.ts` onto the validated helper.**

Replace the whole file:

```ts
// WsTurnEmitter (Plan 3 Task 1, spec §7) — the real `TurnEmitter`, writing
// the frozen 2.0 wire contract to the client's WebSocket. Every JSON frame is
// constructed AND validated through `gatewayMessageSchema` via
// `sendGatewayFrame` (ws-send.ts); nothing here hand-builds an unvalidated
// object literal.
//
// Changed from Plan 2: `toolUpdate` and `turnAborted` are no longer log-only
// — they emit `turn.tool.update` and `turn.aborted`. The audio, permission,
// and delegation methods emit real frames too; their producers land in Task 2
// (voice) and Task 6 (permission PDP + delegation guard). An implemented
// method with no caller yet is the intended state, not a stub.

import type { GatewayMessage, TurnAudioEncoding, TurnTrigger } from "@sentient/protocol";
import type { ServerWebSocket } from "bun";
import { getLog } from "../logging/logger.js";
import type { ToolUpdate } from "../runtime/react-loop.js";
import type {
  DelegationProgress,
  PermissionRequest,
  PermissionResolution,
  TurnEmitter,
} from "../runtime/turn-emitter.js";
import type { CutoffKind } from "../store/entry-types.js";
import type { SessionData } from "./ws-helpers.js";
import { sendAudioFrame, sendGatewayFrame } from "./ws-send.js";

const log = getLog(["sentient", "ws", "turn-emitter"]);

const TEXT_PREVIEW_LEN = 120;

export function createWsTurnEmitter(ws: ServerWebSocket<SessionData>): TurnEmitter {
  const sessionId = ws.data.sessionId;

  // Per-connection monotonic binary-frame counter. Clients dedupe audio by
  // this seq and ignore seq 0, so the first frame is 1. JSON frames stay
  // unsequenced until Task 10 restores the replay journal.
  let audioSeq = 0;

  // toolCallId → startedAtMs. `ToolUpdate` (react-loop.ts) carries no
  // timestamps but `turn.tool.update` requires startedAtMs, so the first
  // "running" update for a call stamps it and the terminal update reads it
  // back — that is what makes a tool tile show a real duration instead of 0.
  // Cleared at turn end because a BACKGROUND call fires "running" twice and
  // never reaches a terminal status through this callback (its completion
  // arrives as `delegation.progress`), so its entry would otherwise leak.
  const toolStartedAtMs = new Map<string, number>();

  function send(frame: GatewayMessage): void {
    sendGatewayFrame(ws, frame);
  }

  return {
    turnStarted(turnId: string, trigger: TurnTrigger) {
      log.info("turn-emitter.turn-started", { sessionId, turnId, trigger });
      send({ type: "turn.started", turnId, trigger });
    },

    textDelta(turnId: string, text: string) {
      log.debug("turn-emitter.text-delta", {
        sessionId,
        turnId,
        length: text.length,
        preview: text.slice(0, TEXT_PREVIEW_LEN),
      });
      send({ type: "turn.text.delta", turnId, text });
    },

    toolUpdate(turnId: string, u: ToolUpdate) {
      const now = Date.now();
      const startedAtMs = toolStartedAtMs.get(u.toolCallId) ?? now;
      if (!toolStartedAtMs.has(u.toolCallId)) toolStartedAtMs.set(u.toolCallId, now);
      const isTerminal = u.status !== "running";
      if (isTerminal) toolStartedAtMs.delete(u.toolCallId);

      log.debug("turn-emitter.tool-update", {
        sessionId,
        turnId,
        toolCallId: u.toolCallId,
        toolName: u.toolName,
        status: u.status,
        taskId: u.taskId,
        elapsedMs: now - startedAtMs,
      });

      send({
        type: "turn.tool.update",
        turnId,
        toolCallId: u.toolCallId,
        toolName: u.toolName,
        status: u.status,
        ...(u.taskId !== undefined ? { taskId: u.taskId } : {}),
        argsPreview: u.argsPreview ?? "",
        startedAtMs,
        ...(isTerminal ? { endedAtMs: now } : {}),
      });
    },

    turnCompleted(turnId: string) {
      toolStartedAtMs.clear();
      log.info("turn-emitter.turn-completed", { sessionId, turnId });
      send({ type: "turn.completed", turnId });
    },

    turnAborted(turnId: string, cutoff: CutoffKind) {
      toolStartedAtMs.clear();
      log.info("turn-emitter.turn-aborted", { sessionId, turnId, cutoff });
      send({ type: "turn.aborted", turnId, cutoff });
    },

    audioStart(turnId: string, encoding: TurnAudioEncoding, sampleRate: number) {
      log.info("turn-emitter.audio-start", { sessionId, turnId, encoding, sampleRate });
      send({ type: "turn.audio.start", turnId, encoding, sampleRate });
    },

    audioFrame(turnId: string, bytes: Uint8Array) {
      audioSeq += 1;
      log.debug("turn-emitter.audio-frame", { sessionId, turnId, seq: audioSeq, payloadBytes: bytes.byteLength });
      sendAudioFrame(ws, audioSeq, bytes);
    },

    audioDone(turnId: string) {
      log.info("turn-emitter.audio-done", { sessionId, turnId, framesSent: audioSeq });
      send({ type: "turn.audio.done", turnId });
    },

    permissionRequest(req: PermissionRequest) {
      // Argument VALUES are never logged — only which keys were mediated.
      log.info("turn-emitter.permission-request", {
        sessionId,
        requestId: req.requestId,
        toolCallId: req.toolCallId,
        toolName: req.toolName,
        argKeys: Object.keys(req.args),
        expiresAtMs: req.expiresAtMs,
      });
      send({ type: "permission.request", ...req });
    },

    permissionResolved(res: PermissionResolution) {
      log.info("turn-emitter.permission-resolved", { sessionId, requestId: res.requestId, outcome: res.outcome });
      send({ type: "permission.resolved", ...res });
    },

    delegationProgress(p: DelegationProgress) {
      log.info("turn-emitter.delegation-progress", {
        sessionId,
        taskId: p.taskId,
        turnId: p.turnId,
        agent: p.agent,
        status: p.status,
      });
      send({ type: "delegation.progress", ...p });
    },
  };
}
```

> If `sessionId` reads as stale to you: `ws.data.sessionId` is assigned once in `openSession` (ws-handlers.ts) before any emitter exists, and cleared only in `cleanupSession`, after which no frames are emitted. Capturing it once is correct and keeps every log line cheap.

- [ ] **Step 18: Run the emitter test to green.**

```bash
source scripts/env.sh && cd gateway/src && bun test session-handlers/ws-turn-emitter.test.ts
```

Expected: all cases pass, including `an invalid frame is dropped, never sent and never thrown` (which exercises the `sendGatewayFrame` error path).

- [ ] **Step 19: Fix the stale `tool.confirm` reference in the message router.**

In `gateway/src/session-handlers/ws-handlers.ts`, replace the `default:` branch comment (lines 128–132):

```ts
    default:
      // audio.start / audio.end / permission.response / session.new /
      // conversation.activate are accepted by the schema but not yet routed:
      // voice is Task 2, permission mediation is Task 6, multi-conversation
      // routing is Task 10. Received and logged, never silently dropped.
      log.debug("message-unhandled", { type: msg.type, reason: "not yet wired in this slice" });
      return;
```

Also update the file-header paragraph (lines 44–49), replacing the last sentence with:

```ts
// audio.start / audio.end / permission.response / session.new /
// conversation.activate remain unhandled here — voice (Task 2), permission
// mediation (Task 6) and multi-conversation routing (Task 10) wire them.
```

- [ ] **Step 20: Full gateway suite + typecheck, then commit.**

```bash
source scripts/env.sh && bun run --filter '@sentient/gateway' typecheck && cd gateway/src && bun test
```

Expected: typecheck clean, whole gateway unit suite green.

```bash
git add gateway/src/session-handlers/ws-send.ts gateway/src/session-handlers/ws-turn-emitter.ts gateway/src/session-handlers/ws-turn-emitter.test.ts gateway/src/session-handlers/ws-handlers.ts
git commit -m "feat(gateway): validate every outbound frame through gatewayMessageSchema

WsTurnEmitter now writes the frozen 2.0 contract through a shared
sendGatewayFrame helper that parses each frame before it hits the socket and
drops (never throws on) an invalid one. toolUpdate and turnAborted stop being
log-only; audio, permission and delegation frames land ahead of their
producers in Tasks 2 and 6."
```

---

#### Part D — docs + dev harness (commits 4 and 5)

- [ ] **Step 21: Rewrite `shared/protocol/WIRE.md`.**

The current file documents the fully-retired pre-purge contract (`cycle.*`, `cognition.status`, `task.update`, `tool.confirm_request`, Hermes dashboard sidecar). Replace its entire contents:

````markdown
# Wire Contract (`@sentient/protocol`)

The authoritative gateway ↔ client (web / mobile / cube) wire contract for
**Sentient 2.0**. The zod schemas in `src/` are the source of truth; this file
documents what a reader can't infer at a glance. Keep it in lockstep with
`src/messages.ts`, `src/conversation.ts` and `src/sessions.ts`.

Design rationale: `docs/superpowers/specs/2026-07-23-sentient-2.0-native-orchestrator-design.md` §7.

## Turn identity — `turnId`, never `cycleId`

A **turn** is one native ReAct run inside a `SessionRuntime`: stimulus in →
zero or more tool round-trips → final text out. It replaced the pre-2.0
"cycle", which was named for one Hermes round-trip — a unit the native
orchestrator no longer has. The gateway mints `turnId` (`crypto.randomUUID()`)
and it is the only turn identity on the wire. **`cycleId` does not exist in
2.0.** Clients read `turnId` off the frame; they never derive, text-match, or
timestamp-window it.

## Transport boundary — WS vs REST

- **WebSocket** carries the **live chat session ONLY**: mic audio in, TTS audio
  out, the live turn stream (`turn.*`, `conversation.entry`),
  permission prompts, delegation progress, `ping`/`pong`, `interrupt`, and the
  resume handshake.
- **REST** carries everything client-driven and stateless: session list,
  conversation history (paginated), search, rename, delete, preferences. The
  client re-issues on demand; no resume/buffer semantics.

A lightweight WS `conversation.activate` control focuses the live stream and
carries **no history payload** — history loads over REST.

## Gateway → client frames

| Frame | Payload |
|---|---|
| `turn.started` | `{ turnId, trigger: "user" \| "background-completion" }` |
| `turn.text.delta` | `{ turnId, text }` |
| `turn.completed` | `{ turnId }` |
| `turn.aborted` | `{ turnId, cutoff: "interrupt" \| "barge-in" }` |
| `turn.tool.update` | `{ turnId, toolCallId, toolName, status: "running" \| "done" \| "error", taskId?, argsPreview, startedAtMs, endedAtMs? }` |
| `turn.audio.start` | `{ turnId, encoding: "opus" \| "pcm", sampleRate }` |
| `turn.audio.done` | `{ turnId }` |
| `permission.request` | `{ requestId, toolCallId, toolName, args, description, expiresAtMs }` |
| `permission.resolved` | `{ requestId, outcome: "allowed" \| "denied" \| "timeout" }` |
| `delegation.progress` | `{ taskId, turnId, agent, status: "running" \| "done" \| "error", note? }` |
| `playback.stop` | `{ turnId, reason: "barge-in" \| "interrupt" }` |

Retained unchanged: `auth.ok`, `session.ready`, `error`, `pong`,
`session.expired`, `sessions.*`, `stream.resumed`. `conversation.snapshot` and
`conversation.entry` are retained; `conversation.entry` is rekeyed
`cycleId → turnId`.

**Retired and never emitted by a 2.0 gateway:** `cycle.started`,
`cycle.aborted`, `cycle.completed`, `message.delta`, `message.done`,
`connector.audio.start`, `connector.audio.done`, `connector.cancelled`,
`connector.transcript.final`, `task.update`, `tool.confirm_request`,
`cognition.status`. A client that still listens for these is dead code.

## Client → gateway frames

| Frame | Payload |
|---|---|
| `permission.response` | `{ requestId, approved }` |

Retained unchanged: `session.configure` (incl. `resume`), `audio.start`
(`turnMode`), `audio.end`, `text.input`, `interrupt`, `session.end`, `ping`,
`session.new`, `conversation.activate`.

## Audio is queued, never replaced

Per spec §4.6/§7.2 the gateway **never stops its own TTS**. A self-initiated
follow-up turn produces a second `turn.audio.start` while the previous turn's
audio may still be playing. Clients MUST:

- **Queue, don't replace.** Play TTS as a sequential queue keyed by `turnId`.
  A new `turnId` does not cancel or fade the in-flight stream.
- **Render two bubbles.** Two consecutive assistant turns is a valid state.
- **Flush only on user action.** `playback.stop` (mic-onset barge-in, or UI
  Stop interrupt) is the *only* thing that drops queued/playing audio.

## Permission prompts are fail-closed

`permission.request` blocks the turn until answered. The client renders a real
dialog and replies with `permission.response`. The gateway sends
`permission.resolved` on **every** resolution path — user answer, 2-minute
timeout auto-deny, or turn abort — so a dialog is never orphaned. The client
also self-dismisses at `expiresAtMs` without waiting for the frame. A timeout
is a **denial**; the model receives a "permission request timed out" tool
result. There is no wire value meaning "unanswered."

## Sequenced push frames — `seq` / `epoch`

Every gateway → client JSON push frame optionally carries two top-level fields
stamped before send:

- **`seq`** — monotonic per-device-session frame counter within the current
  epoch. Doubles as the resume cursor (replay from `lastSeq + 1`) and the
  client mirror's ordering key.
- **`epoch`** — session-scoped counter that increments on each reconnect. Lets
  the client tell a true seq gap from a reconnect restart.

Both are non-negative integers; **absence means the frame is unsequenced**. The
client first learns the current `epoch` from `auth.ok` / `session.ready`, and
again from the `stream.resumed` reply after a reconnect.

## Binary frame header

Binary audio frames (gateway → client) carry `seq` in a fixed 9-byte header:

```
┌──────────────────────────────┬────────────┬──────────────────────┐
│  8 bytes (big-endian u64)    │  1 byte    │  N bytes             │
│  seq (monotonic counter)     │  type      │  payload             │
└──────────────────────────────┴────────────┴──────────────────────┘

  type 0x01 = audio (Opus / PCM payload)
```

`epoch` is **NOT** in the binary header — it travels on JSON frames only. The
client peels the 9-byte header, reads `seq`, dedupes by `seq` (ignoring `0`),
and hands the payload to the audio path.

Inbound binary is mic audio → STT, and outbound binary is TTS audio → client.
These are **separate paths**: inbound binary is never routed through the
outbound emitter.

## `session.configure` — resume-aware

First client → gateway frame after auth.

- **`deviceId`** (REQUIRED) — stable per-device identifier supplied on **every**
  connection; keys the per-device replay buffer, so a reconnect reuses it.
- **`surfaceId`** (optional) — one browser tab / one mobile app instance;
  layers on top of `deviceId`, does not replace it. Falls back to `deviceId`.
- **`resume`** (optional) — `{ epoch, lastSeq }`, present only on a reconnect
  with a non-zero cursor. Folded **into** `session.configure` (there is **no**
  separate `stream.resume` frame) so the gateway's resume decision is a
  synchronous read off one parsed message — no same-tick ordering race.

## `stream.resumed` — resume reply

```
{ type: "stream.resumed", recovered: boolean, epoch: number,
  fromSeq?: number, toSeq?: number }
```

- `recovered: true` — the buffer held frames in `[fromSeq, toSeq]` within the
  requested epoch; the gateway replays them in seq order, then goes live. The
  client applies them idempotently (dedupe by `seq`).
- `recovered: false` — epoch rolled over (gateway restart) or the buffer was
  empty / too old. The client treats it as a clean reconnect and
  **REST-refetches** history (no WS snapshot).

## `entryId` on committed entries

Each committed `conversation.entry` (live WS) and each REST history entry
carries a stable `entryId` — the client mirror's per-path upsert key. **Live
and REST use different namespaces**, so cross-path reconcile is
replace-on-REST-reload, not merge. Within each path `entryId` dedupes; the
resume replay dedupes by `seq`.

## `turnId` on the `conversation.entry` frame (live-bubble join key)

The `conversation.entry` FRAME carries an optional `turnId` (sibling of
`item`). It is **stripped from the item** (the item is a UI-display
projection) but present on the frame for assistant/tool entries. It is the
join key between a live streaming bubble (`turn.text.delta`) and its committed
entry: the client renders ONE bubble per reply by suppressing the committed
twin while its bubble reveals, matched by exact `turnId`. Absent on
user-echo / out-of-band entries and on REST history.

## Replay renders identically to live

`render(replay) == render(live)` is a protocol-contract invariant (spec §3.2).
There are no reload-only frames, and no frame may carry information the client
can only interpret while a turn is live.
````

- [ ] **Step 22: Commit the docs rewrite.**

```bash
git add shared/protocol/WIRE.md
git commit -m "docs(protocol): rewrite WIRE.md for the 2.0 turn contract

The file documented the fully-retired pre-purge contract (cycle.*,
cognition.status, task.update, tool.confirm_request). Replaces it with the
frozen turn/permission/delegation frame set, the audio-queueing rule, and the
fail-closed permission semantics."
```

- [ ] **Step 23: Point the dev harness at the new frames and delete the dead one.**

`gateway/scripts/try-chat.ts` still reads Plan 2's interim frame names, which no longer exist. Replace its three `case` labels in `ws.onmessage` (the `response.text.delta` / `response.text.done` cases) with:

```ts
    case "turn.text.delta":
      if (!isStreaming) {
        process.stdout.write("\x1b[33msentient:\x1b[0m ");
        isStreaming = true;
      }
      process.stdout.write(msg.text);
      break;

    case "turn.completed":
      process.stdout.write("\n\n");
      isStreaming = false;
      prompt();
      break;

    case "turn.aborted":
      process.stdout.write(`\n  \x1b[31m[cut off: ${msg.cutoff}]\x1b[0m\n\n`);
      isStreaming = false;
      prompt();
      break;
```

Then delete the dead pre-purge smoke script, which drives `cycle.*` against a
brain that no longer exists and is referenced by no package script:

```bash
git rm gateway/scripts/smoke-cerebrum.ts
```

- [ ] **Step 24: Full local CI, then commit.**

```bash
source scripts/env.sh && bun run lint && bun run typecheck && bun run test:unit
```

Expected: all three clean. `gateway/scripts/**` is excluded from biome and from the gateway `tsconfig` `include`, so `try-chat.ts` is not covered by the gate — verify it by eye against the frame table in Step 21.

```bash
git add gateway/scripts/try-chat.ts
git commit -m "chore(gateway): retire pre-2.0 frames from the dev harness

try-chat.ts reads turn.text.delta / turn.completed / turn.aborted; deletes
smoke-cerebrum.ts, which drove the purged cycle.* contract."
```

---

#### Definition of done

- `gatewayMessageSchema` contains exactly the frozen gateway → client set and rejects all twelve retired type strings.
- `clientMessageSchema` accepts `permission.response` and rejects `tool.confirm`.
- `TurnEmitter` has all eleven final methods; both implementations satisfy it; no later task needs to edit `turn-emitter.ts`.
- Every JSON frame `createWsTurnEmitter` emits round-trips through `gatewayMessageSchema` (pinned by a test), and an invalid frame is logged-and-dropped rather than thrown.
- `bun run lint && bun run typecheck && bun run test:unit` are clean at the root.
- `WIRE.md` describes only frames that exist.
