### Task 6: Permission round-trip + remaining frame producers

**Spec:** §5.3 (tool execution + PDP, `confirm` becomes a real prompt), §7.1 (permission-prompt UI contract: 2-minute timeout → auto-deny, fail-closed), §4.7 (cutoff → `turn.aborted`), §5.2/§5.4 (background delegation lifecycle). **Build-order slices 6 + 7 (gateway half).**

**What is broken today, concretely:** `gateway/src/bootstrap/phase-services.ts:787` wires `requestConfirm: async () => false`. Every `confirm`-class tool call is therefore silently denied with zero client involvement — the dialog spec §7.1 calls "required for the skeleton to walk" does not exist on the wire at all. `ws-handlers.ts` has no `permission.response` case (it falls into `default:` and logs `message-unhandled`). And three frames Task 1 put on the emitter have no producer calling them: `turn.tool.update` lacks the payload fields the frame requires, `delegation.progress` has no caller anywhere, and `turn.aborted` — which `cancellation.ts` *does* call — has never been proven to reach a socket.

---

#### Files

**Create**
- `gateway/src/runtime/permission-broker.ts`
- `gateway/src/runtime/permission-broker.test.ts`
- `gateway/src/runtime/session-handles.ts`

**Modify**
- `shared/config/src/schemas/orchestrator-config.ts`
- `gateway/config.yaml`
- `gateway/mcp-policy.yaml`
- `gateway/src/tools/tool-types.ts`
- `gateway/src/tools/tool-broker.ts`
- `gateway/src/runtime/react-loop.ts`
- `gateway/src/bootstrap/phase-services.ts`
- `gateway/src/bootstrap/create-gateway-services.ts`
- `gateway/src/session-handlers/ws-helpers.ts`
- `gateway/src/session-handlers/ws-session-configure.ts`
- `gateway/src/session-handlers/ws-handlers.ts`

**Test (modify)**
- `gateway/src/tools/tool-broker.test.ts`
- `gateway/src/tools/delegate-task.test.ts`
- `gateway/src/runtime/react-loop.test.ts`
- `gateway/src/runtime/session-runtime.test.ts`
- `gateway/src/session-handlers/ws-handlers-routing.test.ts`
- `gateway/src/bootstrap/native-brain-text.test.ts`

**Do NOT touch:** `gateway/src/runtime/cancellation.ts` (its abort mechanics and the `signal.aborted || turn.settled` double-commit guard are locked — Global Constraints), `gateway/src/adapters/stt/*` (tuned constants), `cerebrum:` in `gateway/config.yaml` (that block's own comment forbids new keys).

---

#### Five locked design decisions (read these before writing any code)

1. **`requestConfirm` keeps its exact signature `(inv: ToolInvocation, reason: string) => Promise<boolean>`.** Three outcomes must reach the model, but the seam returns two values, so: an explicit human answer **resolves** (`true` = allow, `false` = deny), and an *unanswerable* request (timeout, socket close, turn aborted) **rejects** with `ConfirmUnavailableError`. `tool-broker.ts` already treats a throw as a deny (Global Constraints: preserve that); this task only makes the thrown *message* the model-visible deny reason, so §7.1's required `"permission request timed out"` tool result actually lands. Any other throw stays an opaque `"confirmation error"` — a buggy hook must never leak internals to the model.
2. **`PermissionBroker` lives in `gateway/src/runtime/`, not `session-handlers/`.** It is L3 mediation state, not transport state. It depends only on the emitter's two permission methods (structurally typed — see decision 5) and `ToolInvocation`. `ws-handlers.ts` merely routes a frame into it.
3. **The broker is connection-scoped.** One per WS connection, created next to that connection's `SessionRuntime`, held on `ws.data.permissions`, and `denyAll()`-ed in `cleanupSession`. A `permission.response` can therefore only ever settle a request issued on *the same socket* — cross-user resolution is structurally impossible, not a check that can be forgotten. This is a security boundary and gets a test.
4. **The factory now returns a pair.** `createSessionRuntime(principal, sessionId, emitter)` returns `SessionHandles { runtime, permissions }` instead of a bare `SessionRuntime`. The broker needs `orchestratorCfg.permission.request_timeout_ms` and the emitter, both of which are in scope only inside `buildCreateSessionRuntime` — returning it is cheaper than plumbing the whole orchestrator config out to the WS layer.
5. **Cross-task types are matched structurally, not by import.** `permission-broker.ts` declares its own `PermissionEmitter` interface (two methods) rather than `Pick<TurnEmitter, ...>`, and `DelegationProgress` is declared in `tools/tool-types.ts`. Task 1's `TurnEmitter` satisfies both by shape. This keeps `tools/` from importing `runtime/` (react-loop already imports `tools/` — an import back would be a cycle) and makes this task compile regardless of what Task 1 named its payload types.

---

#### Interfaces

**Consumes — from Task 1 (the frozen wire contract). Verify these in Step 1 before writing code.**

```ts
// shared/protocol/src/messages.ts — client → gateway, added to clientMessageSchema
export const permissionResponseSchema = z.object({
  type: z.literal("permission.response"),
  requestId: z.string(),
  approved: z.boolean(),
});

// gateway/src/runtime/turn-emitter.ts — TurnEmitter gains (names + shapes are what matter):
permissionRequest(req: {
  requestId: string; toolCallId: string; toolName: string;
  args: Record<string, unknown>; description: string; expiresAtMs: number;
}): void;                                                        // → permission.request
permissionResolved(requestId: string, outcome: "allowed" | "denied" | "timeout"): void;
                                                                 // → permission.resolved
delegationProgress(p: {
  taskId: string; turnId: string; agent: string;
  status: "running" | "done" | "error"; note?: string;
}): void;                                                        // → delegation.progress
toolUpdate(turnId: string, u: ToolUpdate): void;                 // → turn.tool.update
turnAborted(turnId: string, cutoff: CutoffKind): void;           // → turn.aborted
```

**Consumes — existing code (verified in the tree at time of writing):**

```ts
// gateway/src/tools/tool-types.ts
export interface ToolInvocation { toolCallId: string; name: string; args: Record<string, unknown>; signal: AbortSignal; }
export interface ToolResult { content: string; isError: boolean; }

// gateway/src/tools/tool-broker.ts
export interface ToolBrokerDeps { mcp; policy; store; principal; sessionId; backgroundTools; config;
  requestConfirm: (inv: ToolInvocation, reason: string) => Promise<boolean>; }
export function createToolBroker(deps: ToolBrokerDeps): ToolBroker;

// gateway/src/runtime/react-loop.ts
export interface ToolUpdate { toolCallId: string; toolName: string; status: "running" | "done" | "error"; taskId?: string; }

// gateway/src/runtime/session-runtime.ts
export function createSessionRuntime(deps: SessionRuntimeDeps): SessionRuntime;

// gateway/src/session-handlers/ws-helpers.ts
export interface SessionData { sessionId; authState; principal; authTimeout; grantedCapabilities; clientType; runtime; }
export function createEmptySessionData(): SessionData;

// gateway/src/logging/logger.ts
export function getLog(tags: string[]): Log;
```

**Produces — later tasks (T7 webui, T8 Android, T9 iOS, T10 replay, T11/T12 E2E) rely on exactly these:**

```ts
// gateway/src/runtime/permission-broker.ts
export type PermissionOutcome = "allowed" | "denied" | "timeout";
export interface PermissionPrompt {
  requestId: string; toolCallId: string; toolName: string;
  args: Record<string, unknown>; description: string; expiresAtMs: number;
}
export interface PermissionEmitter {
  permissionRequest(req: PermissionPrompt): void;
  permissionResolved(requestId: string, outcome: PermissionOutcome): void;
}
export interface PermissionBroker {
  request(inv: ToolInvocation, reason: string): Promise<boolean>;
  resolve(requestId: string, approved: boolean): boolean;
  denyAll(): void;
  readonly pendingCount: number;
}
export interface PermissionBrokerDeps { emitter: PermissionEmitter; sessionId: string; userId: string; timeoutMs: number; }
export function createPermissionBroker(deps: PermissionBrokerDeps): PermissionBroker;

// gateway/src/runtime/session-handles.ts
export interface SessionHandles { runtime: SessionRuntime; permissions: PermissionBroker; }

// gateway/src/tools/tool-types.ts
export class ConfirmUnavailableError extends Error {}
export interface DelegationProgress {
  taskId: string; turnId: string; agent: string;
  status: "running" | "done" | "error"; note?: string;
}
export interface ToolInvocation { toolCallId: string; name: string; args: Record<string, unknown>;
  signal: AbortSignal; turnId: string; }              // turnId ADDED by this task

// gateway/src/runtime/react-loop.ts
export interface ToolUpdate { toolCallId: string; toolName: string; status: "running" | "done" | "error";
  taskId?: string; argsPreview: string; startedAtMs: number; endedAtMs?: number; }   // last three ADDED

// gateway/src/tools/tool-broker.ts
export interface ToolBrokerDeps { /* …unchanged… */ onDelegationProgress?: (p: DelegationProgress) => void; }

// gateway/src/session-handlers/ws-helpers.ts
export interface SessionData { /* …unchanged… */ permissions: PermissionBroker | null; }

// gateway/src/bootstrap/create-gateway-services.ts
readonly createSessionRuntime:
  | ((principal: UserPrincipal, sessionId: string, emitter: TurnEmitter) => SessionHandles)
  | null;

// shared/config/src/schemas/orchestrator-config.ts
OrchestratorConfig["permission"] = { request_timeout_ms: number };
```

---

#### Steps

- [ ] **Step 1: Pre-flight — confirm Task 1's emitter surface and the two fields it may have already added.**

  ```bash
  cd /Users/kevinye/Development/sentient
  grep -n "permissionRequest\|permissionResolved\|delegationProgress\|turnAborted" gateway/src/runtime/turn-emitter.ts
  grep -n "argsPreview\|startedAtMs\|endedAtMs" gateway/src/runtime/react-loop.ts
  grep -n "permission.response\|permissionResponseSchema" shared/protocol/src/messages.ts
  ```
  Expect: the first grep prints all four method names on `TurnEmitter` (Task 1 added them). The third prints `permissionResponseSchema`. The **second may print nothing** — if so, Step 14 adds those three fields; if Task 1 already added them, Step 14 is a no-op and you skip straight to Step 15. Nothing else in this task changes based on the result. If the first or third grep comes back empty, **stop** — Task 1 has not landed and this task cannot proceed.

- [ ] **Step 2: Add the permission timeout to the orchestrator config schema.**

  In `shared/config/src/schemas/orchestrator-config.ts`, add a `permission` block after `loop`:

  ```ts
    permission: z
      .object({
        // Wall-clock deadline for a human answer to an L3 `confirm` prompt
        // (ms). On expiry the request AUTO-DENIES (spec §7.1 — a timeout is
        // never an implicit approval) and the model receives a "permission
        // request timed out" tool result. 5000-600000; spec default 120000
        // (2 minutes).
        request_timeout_ms: z.number().int().min(5000).max(600000).default(120000),
      })
      // Block-level default: operator configs (`~/.sentient/gateway/config/config.yaml`)
      // are edited in place and predate this key — a missing block must never
      // brick boot for a gateway that was working yesterday.
      .default({}),
  ```

- [ ] **Step 3: Add the matching key to `gateway/config.yaml`.**

  Under `orchestrator:`, between the `loop:` and `tools:` blocks (config.yaml lines 124-126):

  ```yaml
    permission:
      request_timeout_ms: 120000             # confirm-prompt deadline before auto-deny (5000-600000)
  ```

- [ ] **Step 4: Commit the config seam.**

  ```bash
  cd /Users/kevinye/Development/sentient
  git add shared/config/src/schemas/orchestrator-config.ts gateway/config.yaml
  git commit -m "feat(config): add orchestrator.permission.request_timeout_ms for the L3 confirm prompt"
  ```

- [ ] **Step 5: Add `ConfirmUnavailableError`, `DelegationProgress`, and `ToolInvocation.turnId` to the tool vocabulary.**

  In `gateway/src/tools/tool-types.ts`, change `ToolInvocation` and append the two new exports:

  ```ts
  /** A single in-flight tool call, as dispatched by the loop to a broker. */
  export interface ToolInvocation {
    toolCallId: string;
    name: string;
    args: Record<string, unknown>;
    signal: AbortSignal;
    /** The turn this call belongs to. Carried so background dispatch can
     *  key its `delegation.progress` frames to a turn (spec §7). This does
     *  NOT reopen "who appends to the store" — tool_call/tool_result appends
     *  stay in react-loop.ts (see tool-broker.ts's file header); the broker
     *  reads this field for frame correlation only. */
    turnId: string;
  }

  /** Thrown by a `requestConfirm` implementation when the permission request
   *  could not be ANSWERED at all — timed out, the socket closed, or the turn
   *  was aborted underneath it. `tool-broker.ts` turns it into a deny whose
   *  `message` reaches the model verbatim as the tool result, so the model can
   *  adapt ("permission request timed out") instead of seeing a generic error.
   *  Any OTHER throw out of the hook stays an opaque "confirmation error":
   *  a buggy hook must never leak internals into the model's context. */
  export class ConfirmUnavailableError extends Error {}

  /** Lifecycle of one background (delegated) task, as surfaced to the client
   *  via the `delegation.progress` frame (spec §5.4/§7). `agent` is the
   *  delegated worker's name (`delegateTask`'s `agent` argument), falling back
   *  to the tool name for a background tool that has no `agent` arg. `note`
   *  carries a short failure reason on `status: "error"` only. */
  export interface DelegationProgress {
    taskId: string;
    turnId: string;
    agent: string;
    status: "running" | "done" | "error";
    note?: string;
  }
  ```

- [ ] **Step 6: Write the failing test for the typed-error deny reason.**

  Append to `gateway/src/tools/tool-broker.test.ts` (after the existing confirm cases). First update the shared fixture at line 65 so every invocation carries the new field:

  ```ts
  function makeInvocation(overrides: Partial<ToolInvocation> = {}): ToolInvocation {
    return {
      toolCallId: "call-1",
      name: "get_weather",
      args: {},
      signal: new AbortController().signal,
      turnId: "turn-1",
      ...overrides,
    };
  }
  ```

  then add:

  ```ts
  describe("ToolBroker — unanswerable confirm (fail-closed reason passthrough)", () => {
    it("surfaces a ConfirmUnavailableError message to the model verbatim as the deny reason", async () => {
      const mcp = fakeMcp([weatherTool]);
      const broker = createToolBroker({
        mcp,
        policy: fakePolicy({ action: "confirm", reason: "side-effecting" }),
        store: fakeStore(),
        principal,
        sessionId: "session-1",
        backgroundTools: new Map(),
        config: toolsConfig,
        requestConfirm: async () => {
          throw new ConfirmUnavailableError("permission request timed out");
        },
      });

      const result = await broker.dispatch(makeInvocation());

      if ("taskId" in result) throw new Error("expected a ToolResult, got a background handle");
      expect(result).toEqual({ content: "permission request timed out", isError: true });
      expect(mcp.callToolCalls).toHaveLength(0);
    });

    it("keeps any other throw opaque — a buggy hook never leaks internals to the model", async () => {
      const mcp = fakeMcp([weatherTool]);
      const broker = createToolBroker({
        mcp,
        policy: fakePolicy({ action: "confirm", reason: "side-effecting" }),
        store: fakeStore(),
        principal,
        sessionId: "session-1",
        backgroundTools: new Map(),
        config: toolsConfig,
        requestConfirm: async () => {
          throw new Error("ECONNREFUSED /var/run/internal.sock");
        },
      });

      const result = await broker.dispatch(makeInvocation());

      if ("taskId" in result) throw new Error("expected a ToolResult, got a background handle");
      expect(result).toEqual({ content: "confirmation error", isError: true });
      expect(mcp.callToolCalls).toHaveLength(0);
    });
  });
  ```

  Add `ConfirmUnavailableError` to the existing type-only import at the top of the file, splitting it into a value import:

  ```ts
  import { ConfirmUnavailableError } from "./tool-types.js";
  import type { ToolInvocation } from "./tool-types.js";
  ```

- [ ] **Step 7: Run it — expect a failure on the first case only.**

  ```bash
  cd /Users/kevinye/Development/sentient && source scripts/env.sh && cd gateway/src && bun test tools/tool-broker.test.ts
  ```
  Expected: `surfaces a ConfirmUnavailableError message …` fails with `Expected: {"content": "permission request timed out"} Received: {"content": "confirmation error"}`. The second case passes already (that is today's behavior, and it must stay true).

- [ ] **Step 8: Make it pass — one branch in `resolveDecision`.**

  In `gateway/src/tools/tool-broker.ts`, replace the `catch` inside `resolveDecision` (currently lines 200-208):

  ```ts
    let confirmed: boolean;
    try {
      confirmed = await requestConfirm(inv, reason);
    } catch (err) {
      // Fail-closed either way — the ONLY difference is what the model is
      // told. `ConfirmUnavailableError` is the confirm hook's deliberate
      // "nobody could answer this" signal (timeout / socket closed / turn
      // aborted, see runtime/permission-broker.ts) and its message is
      // model-facing copy by design. Every other throw is a bug in the hook:
      // report it opaquely so an internal error string never enters the
      // model's context.
      const denyReason = err instanceof ConfirmUnavailableError ? err.message : "confirmation error";
      log.warn("tool-broker.pdp.confirm-error", {
        sessionId,
        tool: inv.name,
        toolCallId: inv.toolCallId,
        unavailable: err instanceof ConfirmUnavailableError,
        reason: denyReason,
      });
      return { action: "deny", reason: denyReason };
    }
  ```

  and extend the imports at the top of the file:

  ```ts
  import { ConfirmUnavailableError } from "./tool-types.js";
  import type { DelegationProgress, PdpDecision, ToolDefinition, ToolInvocation, ToolResult } from "./tool-types.js";
  ```

- [ ] **Step 9: Run to green.**

  ```bash
  cd /Users/kevinye/Development/sentient && source scripts/env.sh && cd gateway/src && bun test tools/tool-broker.test.ts
  ```
  Expected: all cases in the file pass.

- [ ] **Step 10: Write the failing test for `delegation.progress` producer wiring.**

  Append to `gateway/src/tools/tool-broker.test.ts`:

  ```ts
  describe("ToolBroker — delegation.progress producer", () => {
    function progressRunner(settle: (r: ToolResult) => void): BackgroundToolRunner {
      return {
        definition: {
          name: "delegateTask",
          description: "delegates",
          parameters: { type: "object", properties: {} },
          category: "background",
        },
        run: () => ({ cancel: () => {}, result: new Promise<ToolResult>((res) => settle(res)) }),
      };
    }

    it("emits running on dispatch and done on settle, keyed by taskId + turnId + agent", async () => {
      const progress: DelegationProgress[] = [];
      let finish: (r: ToolResult) => void = () => {};
      const broker = createToolBroker({
        mcp: fakeMcp([]),
        policy: fakePolicy({ action: "allow" }),
        store: fakeStore(),
        principal,
        sessionId: "session-1",
        backgroundTools: new Map([["delegateTask", progressRunner((res) => { finish = res; })]]),
        config: toolsConfig,
        requestConfirm: async () => false,
        onDelegationProgress: (p) => progress.push(p),
      });

      const dispatched = await broker.dispatch(
        makeInvocation({ name: "delegateTask", args: { agent: "hermes", taskPrompt: "go" }, turnId: "turn-9" }),
      );
      if (!("taskId" in dispatched)) throw new Error("expected a background handle");

      expect(progress).toEqual([
        { taskId: dispatched.taskId, turnId: "turn-9", agent: "hermes", status: "running" },
      ]);

      finish({ content: "all done", isError: false });
      await Promise.resolve();
      await Promise.resolve();

      expect(progress[1]).toEqual({
        taskId: dispatched.taskId,
        turnId: "turn-9",
        agent: "hermes",
        status: "done",
      });
    });

    it("reports an errored background task as status error with a truncated note", async () => {
      const progress: DelegationProgress[] = [];
      let finish: (r: ToolResult) => void = () => {};
      const broker = createToolBroker({
        mcp: fakeMcp([]),
        policy: fakePolicy({ action: "allow" }),
        store: fakeStore(),
        principal,
        sessionId: "session-1",
        backgroundTools: new Map([["delegateTask", progressRunner((res) => { finish = res; })]]),
        config: toolsConfig,
        requestConfirm: async () => false,
        onDelegationProgress: (p) => progress.push(p),
      });

      await broker.dispatch(makeInvocation({ name: "delegateTask", args: { agent: "hermes" }, turnId: "turn-9" }));
      finish({ content: "hermes exited 1", isError: true });
      await Promise.resolve();
      await Promise.resolve();

      expect(progress[1]).toMatchObject({ status: "error", note: "hermes exited 1" });
    });
  });
  ```

  Add the needed imports at the top of the file:

  ```ts
  import type { DelegationProgress, ToolInvocation, ToolResult } from "./tool-types.js";
  ```

- [ ] **Step 11: Run it — expect failure.**

  ```bash
  cd /Users/kevinye/Development/sentient && source scripts/env.sh && cd gateway/src && bun test tools/tool-broker.test.ts
  ```
  Expected: a TypeScript/runtime failure that `onDelegationProgress` is not a known property of `ToolBrokerDeps`, or (if bun strips the type error) `expect(progress).toEqual([...])` receiving `[]`.

- [ ] **Step 12: Implement the producer in `dispatchBackground`.**

  In `gateway/src/tools/tool-broker.ts`, add the optional dep to `ToolBrokerDeps` (after `requestConfirm`):

  ```ts
    /** Fired at both ends of a background task's life (spec §5.4 / §7): once
     *  with `status: "running"` the moment `dispatch` hands back a `{taskId}`,
     *  and once with `done`/`error` when the runner's promise settles. The
     *  composition root binds this to the session's `TurnEmitter`, which puts
     *  it on the wire as `delegation.progress`. Optional for the same reason
     *  `setBackgroundCompletionSink` is late-bound — a headless/dev broker has
     *  no client — but an UNSET sink is logged once per task, never silent. */
    onDelegationProgress?: (p: DelegationProgress) => void;
  ```

  destructure it (line 120) and add a module constant + helper near `TOO_MANY_BACKGROUND_TASKS`:

  ```ts
  const NOTE_PREVIEW_LEN = 120;

  /** `delegateTask`'s worker name; any other background tool reports under its
   *  own tool name. Never throws on a malformed `args` — the guard/runner is
   *  what rejects a bad agent, not this display-only derivation. */
  function delegationAgent(inv: ToolInvocation): string {
    const agent = inv.args.agent;
    return typeof agent === "string" && agent.length > 0 ? agent : inv.name;
  }
  ```

  ```ts
  const { mcp, policy, principal, sessionId, backgroundTools, config, requestConfirm, onDelegationProgress } = deps;
  ```

  then inside `dispatchBackground`, right after `log.info("tool-broker.dispatch.background.started", …)`:

  ```ts
    const agent = delegationAgent(inv);
    if (onDelegationProgress) {
      onDelegationProgress({ taskId, turnId: inv.turnId, agent, status: "running" });
    } else {
      log.warn("tool-broker.dispatch.background.no-progress-sink", {
        sessionId,
        tool: inv.name,
        taskId,
        reason: "onDelegationProgress was not wired — client sees no delegation tile for this task",
      });
    }
  ```

  and inside the second `.then((toolResult) => { … })` stage, immediately after `background.complete(taskId);`:

  ```ts
      onDelegationProgress?.({
        taskId,
        turnId: inv.turnId,
        agent,
        status: toolResult.isError ? "error" : "done",
        ...(toolResult.isError ? { note: toolResult.content.slice(0, NOTE_PREVIEW_LEN) } : {}),
      });
  ```

  Note the cap-exceeded early return above stays untouched: no `taskId` was minted, so no progress frame is correct.

- [ ] **Step 13: Run to green, fix the one other `ToolInvocation` fixture, and commit.**

  `gateway/src/tools/delegate-task.test.ts:38` builds an invocation literal — add the field:

  ```ts
    return { toolCallId: "call-1", name: "delegateTask", args, signal, turnId: "turn-1" };
  ```

  ```bash
  cd /Users/kevinye/Development/sentient && source scripts/env.sh && cd gateway/src && bun test tools/
  cd /Users/kevinye/Development/sentient/gateway && bun run typecheck
  ```
  Expected: all `tools/` tests pass. `typecheck` still reports errors in `runtime/react-loop.ts` (it constructs a `ToolInvocation` without `turnId`) — that is Step 20's job; do not fix it here.

  ```bash
  cd /Users/kevinye/Development/sentient
  git add gateway/src/tools/
  git commit -m "feat(tools): fail-closed confirm reason passthrough + delegation.progress producer"
  ```

- [ ] **Step 14: Write the failing test for the permission round-trip FSM.**

  Create `gateway/src/runtime/permission-broker.test.ts`:

  ```ts
  // Permission round-trip contract (spec §5.3/§7.1, Plan 3 Task 6). Pins the
  // FSM every surface's dialog depends on AND the fail-closed security
  // boundary: nothing but an explicit `approved: true` from THIS connection
  // ever resolves to allow. Zero-cost — hand-rolled emitter double, no I/O.

  import { describe, expect, it } from "bun:test";
  import { ConfirmUnavailableError } from "../tools/tool-types.js";
  import type { ToolInvocation } from "../tools/tool-types.js";
  import type { PermissionEmitter, PermissionOutcome, PermissionPrompt } from "./permission-broker.js";
  import { createPermissionBroker } from "./permission-broker.js";

  interface RecordingEmitter extends PermissionEmitter {
    requests: PermissionPrompt[];
    resolutions: Array<{ requestId: string; outcome: PermissionOutcome }>;
  }

  function recordingEmitter(): RecordingEmitter {
    const requests: PermissionPrompt[] = [];
    const resolutions: Array<{ requestId: string; outcome: PermissionOutcome }> = [];
    return {
      requests,
      resolutions,
      permissionRequest: (req) => requests.push(req),
      permissionResolved: (requestId, outcome) => resolutions.push({ requestId, outcome }),
    };
  }

  function makeBroker(emitter: PermissionEmitter, timeoutMs = 60000) {
    return createPermissionBroker({ emitter, sessionId: "session-1", userId: "u_aaaaaaaa", timeoutMs });
  }

  function invocation(signal = new AbortController().signal): ToolInvocation {
    return {
      toolCallId: "call-1",
      name: "ha_call_service",
      args: { domain: "light", service: "turn_on" },
      signal,
      turnId: "turn-1",
    };
  }

  describe("PermissionBroker — the confirm round-trip", () => {
    it("emits one permission.request carrying the PDP reason as the description and a future expiry", () => {
      const emitter = recordingEmitter();
      const broker = makeBroker(emitter);
      const before = Date.now();

      void broker.request(invocation(), "Calling a Home Assistant service changes device state");

      expect(emitter.requests).toHaveLength(1);
      const req = emitter.requests[0];
      expect(req).toMatchObject({
        toolCallId: "call-1",
        toolName: "ha_call_service",
        args: { domain: "light", service: "turn_on" },
        description: "Calling a Home Assistant service changes device state",
      });
      expect(req?.requestId.length).toBeGreaterThan(0);
      expect(req?.expiresAtMs).toBeGreaterThan(before);
      expect(broker.pendingCount).toBe(1);
    });

    it("resolves true and emits permission.resolved allowed when the user approves", async () => {
      const emitter = recordingEmitter();
      const broker = makeBroker(emitter);
      const pending = broker.request(invocation(), "why");
      const requestId = emitter.requests[0]?.requestId ?? "";

      expect(broker.resolve(requestId, true)).toBe(true);

      await expect(pending).resolves.toBe(true);
      expect(emitter.resolutions).toEqual([{ requestId, outcome: "allowed" }]);
      expect(broker.pendingCount).toBe(0);
    });

    it("resolves false and emits permission.resolved denied when the user declines", async () => {
      const emitter = recordingEmitter();
      const broker = makeBroker(emitter);
      const pending = broker.request(invocation(), "why");
      const requestId = emitter.requests[0]?.requestId ?? "";

      broker.resolve(requestId, false);

      await expect(pending).resolves.toBe(false);
      expect(emitter.resolutions).toEqual([{ requestId, outcome: "denied" }]);
    });

    it("auto-denies on timeout — never an implicit approval — and tells the model why", async () => {
      const emitter = recordingEmitter();
      const broker = makeBroker(emitter, 20);
      const pending = broker.request(invocation(), "why");
      const requestId = emitter.requests[0]?.requestId ?? "";

      await expect(pending).rejects.toThrow(ConfirmUnavailableError);
      await expect(pending).rejects.toThrow("permission request timed out");
      expect(emitter.resolutions).toEqual([{ requestId, outcome: "timeout" }]);
      expect(broker.pendingCount).toBe(0);
    });

    it("ignores an unknown requestId — no throw, no frame, no settle", () => {
      const emitter = recordingEmitter();
      const broker = makeBroker(emitter);
      void broker.request(invocation(), "why");

      expect(broker.resolve("not-a-real-request-id", true)).toBe(false);
      expect(emitter.resolutions).toEqual([]);
      expect(broker.pendingCount).toBe(1);
    });

    it("ignores a duplicate response — the first answer wins", async () => {
      const emitter = recordingEmitter();
      const broker = makeBroker(emitter);
      const pending = broker.request(invocation(), "why");
      const requestId = emitter.requests[0]?.requestId ?? "";

      expect(broker.resolve(requestId, false)).toBe(true);
      expect(broker.resolve(requestId, true)).toBe(false);

      await expect(pending).resolves.toBe(false);
      expect(emitter.resolutions).toEqual([{ requestId, outcome: "denied" }]);
    });

    it("ignores a response that lands after the timeout already fired", async () => {
      const emitter = recordingEmitter();
      const broker = makeBroker(emitter, 20);
      const pending = broker.request(invocation(), "why");
      const requestId = emitter.requests[0]?.requestId ?? "";

      await expect(pending).rejects.toThrow(ConfirmUnavailableError);
      expect(broker.resolve(requestId, true)).toBe(false);
      expect(emitter.resolutions).toEqual([{ requestId, outcome: "timeout" }]);
    });

    it("denyAll settles every outstanding request instead of leaking a pending promise", async () => {
      const emitter = recordingEmitter();
      const broker = makeBroker(emitter);
      const a = broker.request(invocation(), "why");
      const b = broker.request(invocation(), "why");
      expect(broker.pendingCount).toBe(2);

      broker.denyAll();

      await expect(a).rejects.toThrow(ConfirmUnavailableError);
      await expect(b).rejects.toThrow("client disconnected");
      expect(broker.pendingCount).toBe(0);
      // The socket is gone — emitting permission.resolved into it is pointless.
      expect(emitter.resolutions).toEqual([]);
    });

    it("settles as denied when the turn is aborted underneath an open prompt", async () => {
      const emitter = recordingEmitter();
      const broker = makeBroker(emitter);
      const controller = new AbortController();
      const pending = broker.request(invocation(controller.signal), "why");
      const requestId = emitter.requests[0]?.requestId ?? "";

      controller.abort();

      await expect(pending).rejects.toThrow(ConfirmUnavailableError);
      // "aborted" is not on the frozen wire — it maps to denied so the client
      // dismisses the dialog fail-closed.
      expect(emitter.resolutions).toEqual([{ requestId, outcome: "denied" }]);
      expect(broker.pendingCount).toBe(0);
    });
  });
  ```

- [ ] **Step 15: Run it — expect a module-not-found failure.**

  ```bash
  cd /Users/kevinye/Development/sentient && source scripts/env.sh && cd gateway/src && bun test runtime/permission-broker.test.ts
  ```
  Expected: `error: Cannot find module './permission-broker.js'`.

- [ ] **Step 16: Implement `gateway/src/runtime/permission-broker.ts`.**

  ```ts
  // PermissionBroker (spec §5.3 / §7.1, Plan 3 Task 6) — the L3 `confirm`
  // round-trip. The PDP asks, a human answers, the tool runs or doesn't.
  //
  // Shape of the seam (locked, do not "improve"): `request()` is bound to
  // `ToolBrokerDeps.requestConfirm`, whose signature is
  // `(inv, reason) => Promise<boolean>`. Two return values, three real
  // outcomes — so an explicit human answer RESOLVES (true = allow, false =
  // deny) and an UNANSWERABLE request REJECTS with `ConfirmUnavailableError`.
  // tool-broker.ts already treats a throw as a deny (fail-closed), and now
  // forwards that error's message to the model verbatim, which is how spec
  // §7.1's required "permission request timed out" tool result reaches the
  // model. A timeout is NEVER an implicit approval.
  //
  // One broker per WS connection, held on `ws.data.permissions`. That scoping
  // IS the isolation boundary: a `permission.response` frame can only ever
  // settle a request minted on the same socket, so cross-user/cross-session
  // resolution is structurally impossible rather than a check someone can
  // forget. `cleanupSession` calls `denyAll()`, so a socket that drops with a
  // dialog open never leaves a pending promise (and therefore a wedged ReAct
  // turn) behind.
  //
  // Four ways a request settles, all funnelled through the single `settle()`
  // below so "first settle wins" is structural: user answer, timeout,
  // turn abort (the turn's AbortSignal fired while the dialog was open —
  // without this the loop would sit on an awaited dispatch for the full
  // timeout after an interrupt), and connection close.

  import { getLog } from "../logging/logger.js";
  import { ConfirmUnavailableError } from "../tools/tool-types.js";
  import type { ToolInvocation } from "../tools/tool-types.js";

  const log = getLog(["sentient", "runtime", "permission-broker"]);

  /** Model-facing copy. These strings land in the model's context as the tool
   *  result on a fail-closed deny (see tool-broker.ts's `resolveDecision`), so
   *  they are written for the model to reason about, not for a log grep. */
  const TIMEOUT_MESSAGE = "permission request timed out";
  const CLOSED_MESSAGE = "permission request cancelled: client disconnected";
  const ABORTED_MESSAGE = "permission request cancelled: turn aborted";

  /** Outcome as it appears on the `permission.resolved` frame. */
  export type PermissionOutcome = "allowed" | "denied" | "timeout";

  /** Everything the client needs to render one permission dialog. Mirrors the
   *  `permission.request` frame payload (Task 1's frozen wire contract). */
  export interface PermissionPrompt {
    requestId: string;
    toolCallId: string;
    toolName: string;
    args: Record<string, unknown>;
    description: string;
    expiresAtMs: number;
  }

  /** The two emitter methods this module needs. Declared structurally rather
   *  than as `Pick<TurnEmitter, …>` so `runtime/` owns no import cycle and this
   *  module is testable against a two-method double. Task 1's `TurnEmitter`
   *  satisfies it by shape. */
  export interface PermissionEmitter {
    permissionRequest(req: PermissionPrompt): void;
    permissionResolved(requestId: string, outcome: PermissionOutcome): void;
  }

  export interface PermissionBroker {
    /** Emits `permission.request` and returns the promise `ToolBroker.dispatch`
     *  awaits. Resolves `true`/`false` on a human answer; rejects with
     *  `ConfirmUnavailableError` when the request cannot be answered. */
    request(inv: ToolInvocation, reason: string): Promise<boolean>;
    /** Settles a pending request from a client `permission.response` frame.
     *  Returns `false` (and only logs) for an unknown, duplicate, or
     *  already-timed-out requestId — never throws, never double-settles. */
    resolve(requestId: string, approved: boolean): boolean;
    /** Settles every outstanding request as unanswerable. Idempotent. Called
     *  on socket close / session teardown. Emits no frame — the socket is gone. */
    denyAll(): void;
    /** Outstanding prompts. Exposed so teardown paths can assert no leak. */
    readonly pendingCount: number;
  }

  export interface PermissionBrokerDeps {
    emitter: PermissionEmitter;
    sessionId: string;
    userId: string;
    /** `orchestrator.permission.request_timeout_ms` — never a literal here. */
    timeoutMs: number;
  }

  type SettleReason = "allowed" | "denied" | "timeout" | "aborted" | "closed";

  /** How each internal settle reason appears on the wire. `aborted` has no
   *  frozen-contract outcome of its own, so it reports as `denied` — the
   *  fail-closed reading, and the one that makes the client dismiss the
   *  dialog. `closed` emits nothing (there is no socket left to tell). */
  const WIRE_OUTCOME: Record<Exclude<SettleReason, "closed">, PermissionOutcome> = {
    allowed: "allowed",
    denied: "denied",
    timeout: "timeout",
    aborted: "denied",
  };

  interface PendingPermission {
    toolCallId: string;
    toolName: string;
    timer: ReturnType<typeof setTimeout>;
    detach: () => void;
    finish: (reason: SettleReason) => void;
  }

  export function createPermissionBroker(deps: PermissionBrokerDeps): PermissionBroker {
    const { emitter, sessionId, userId, timeoutMs } = deps;
    const pending = new Map<string, PendingPermission>();

    /** The ONE place a request leaves the pending map. Everything else
     *  (timeout, abort, client answer, teardown) routes through here, which is
     *  what makes "first settle wins" a structural property instead of four
     *  independent guards that can drift. */
    function settle(requestId: string, reason: SettleReason): void {
      const entry = pending.get(requestId);
      if (!entry) return;
      pending.delete(requestId);
      clearTimeout(entry.timer);
      entry.detach();

      if (reason !== "closed") {
        emitter.permissionResolved(requestId, WIRE_OUTCOME[reason]);
      }
      log.info("permission-broker.settled", {
        userId,
        sessionId,
        requestId,
        toolCallId: entry.toolCallId,
        toolName: entry.toolName,
        reason,
        pending: pending.size,
      });
      entry.finish(reason);
    }

    function request(inv: ToolInvocation, reason: string): Promise<boolean> {
      const requestId = crypto.randomUUID();
      const expiresAtMs = Date.now() + timeoutMs;

      let resolveFn: (approved: boolean) => void = () => {};
      let rejectFn: (err: unknown) => void = () => {};
      const promise = new Promise<boolean>((res, rej) => {
        resolveFn = res;
        rejectFn = rej;
      });

      const timer = setTimeout(() => settle(requestId, "timeout"), timeoutMs);
      const onAbort = () => settle(requestId, "aborted");
      inv.signal.addEventListener("abort", onAbort, { once: true });

      pending.set(requestId, {
        toolCallId: inv.toolCallId,
        toolName: inv.name,
        timer,
        detach: () => inv.signal.removeEventListener("abort", onAbort),
        finish: (settleReason) => {
          if (settleReason === "allowed") return resolveFn(true);
          if (settleReason === "denied") return resolveFn(false);
          if (settleReason === "timeout") return rejectFn(new ConfirmUnavailableError(TIMEOUT_MESSAGE));
          if (settleReason === "aborted") return rejectFn(new ConfirmUnavailableError(ABORTED_MESSAGE));
          return rejectFn(new ConfirmUnavailableError(CLOSED_MESSAGE));
        },
      });

      // Argument KEYS only — the values go on the wire to the user's own
      // dialog, but they must never enter the log (logging rule: no raw
      // content, ids/lengths/types only).
      log.info("permission-broker.request", {
        userId,
        sessionId,
        requestId,
        toolCallId: inv.toolCallId,
        toolName: inv.name,
        turnId: inv.turnId,
        argKeys: Object.keys(inv.args),
        timeoutMs,
        pending: pending.size,
      });

      emitter.permissionRequest({
        requestId,
        toolCallId: inv.toolCallId,
        toolName: inv.name,
        args: inv.args,
        description: reason,
        expiresAtMs,
      });

      return promise;
    }

    function resolve(requestId: string, approved: boolean): boolean {
      if (!pending.has(requestId)) {
        log.warn("permission-broker.resolve.unmatched", {
          userId,
          sessionId,
          requestId,
          approved,
          pending: pending.size,
          reason: "no pending prompt for this requestId — already answered, timed out, or never issued on this connection",
        });
        return false;
      }
      settle(requestId, approved ? "allowed" : "denied");
      return true;
    }

    function denyAll(): void {
      const requestIds = [...pending.keys()];
      for (const requestId of requestIds) settle(requestId, "closed");
      log.info("permission-broker.deny-all", { userId, sessionId, count: requestIds.length });
    }

    return {
      request,
      resolve,
      denyAll,
      get pendingCount() {
        return pending.size;
      },
    };
  }
  ```

- [ ] **Step 17: Run to green.**

  ```bash
  cd /Users/kevinye/Development/sentient && source scripts/env.sh && cd gateway/src && bun test runtime/permission-broker.test.ts
  ```
  Expected: all 9 cases pass.

- [ ] **Step 18: Commit the broker.**

  ```bash
  cd /Users/kevinye/Development/sentient
  git add gateway/src/runtime/permission-broker.ts gateway/src/runtime/permission-broker.test.ts
  git commit -m "feat(runtime): add PermissionBroker for the fail-closed L3 confirm round-trip"
  ```

- [ ] **Step 19: Add the `SessionHandles` pair type.**

  Create `gateway/src/runtime/session-handles.ts`:

  ```ts
  // The pair a session's composition root hands back (Plan 3 Task 6). Both
  // objects are connection-scoped and torn down together: `runtime.dispose()`
  // aborts the in-flight turn and closes the store handle;
  // `permissions.denyAll()` settles any open permission prompt so a dropped
  // socket cannot leave a ReAct turn awaiting an answer that will never come.

  import type { PermissionBroker } from "./permission-broker.js";
  import type { SessionRuntime } from "./session-runtime.js";

  export interface SessionHandles {
    runtime: SessionRuntime;
    permissions: PermissionBroker;
  }
  ```

- [ ] **Step 20: Wire the broker into the composition root and give `ToolInvocation` its `turnId`.**

  In `gateway/src/bootstrap/phase-services.ts`:

  (a) imports:

  ```ts
  import { createPermissionBroker } from "../runtime/permission-broker.js";
  import type { SessionHandles } from "../runtime/session-handles.js";
  ```

  (b) `OrchestratorServices.createSessionRuntime` (line 562):

  ```ts
    createSessionRuntime: ((principal: UserPrincipal, sessionId: string, emitter: TurnEmitter) => SessionHandles) | null;
  ```

  (c) `buildCreateSessionRuntime`'s return type (line ~730):

  ```ts
  function buildCreateSessionRuntime(
    deps: CreateSessionRuntimeFactoryDeps,
  ): (principal: UserPrincipal, sessionId: string, emitter: TurnEmitter) => SessionHandles {
  ```

  (d) inside the returned closure, right after the `if (!provider) { … throw … }` block:

  ```ts
      // Connection-scoped permission mediation (spec §5.3/§7.1). Created here
      // because this is the only scope holding BOTH the session's emitter and
      // the orchestrator config; `ws-session-configure.ts` receives it back on
      // `SessionHandles` and parks it on `ws.data.permissions` so
      // `permission.response` can route into it.
      const permissions = createPermissionBroker({
        emitter,
        sessionId,
        userId: principal.userId,
        timeoutMs: orchestratorCfg.permission.request_timeout_ms,
      });
  ```

  (e) replace the stub at line 787 and add the progress sink:

  ```ts
      requestConfirm: (inv, reason) => permissions.request(inv, reason),
      onDelegationProgress: (p) => emitter.delegationProgress(p),
  ```

  (f) delete the now-stale comment above that line (the two-line "Plan 2 default: deny every unconfirmed side-effecting call. Plan 3 wires a real client permission-prompt UI without touching this file" block) and replace it with:

  ```ts
      // Real L3 confirm round-trip (spec §5.3): emits `permission.request` to
      // this connection and blocks the dispatch until the user answers, the
      // 2-minute config timeout fires (auto-deny), or the socket drops.
  ```

  (g) the closure's return:

  ```ts
      return { runtime, permissions };
  ```

  Then in `gateway/src/runtime/react-loop.ts`'s `dispatchToolCalls`, add `turnId` to the invocation literal:

  ```ts
      const invocation: ToolInvocation = { toolCallId, name: toolName, args, signal, turnId };
  ```

  And in `gateway/src/bootstrap/create-gateway-services.ts`, swap the field type (line 144) and its import:

  ```ts
  import type { SessionHandles } from "../runtime/session-handles.js";
  ```
  ```ts
    readonly createSessionRuntime:
      | ((principal: UserPrincipal, sessionId: string, emitter: TurnEmitter) => SessionHandles)
      | null;
  ```

  (`SessionRuntime` stays imported there only if still referenced; remove the import if `bun run typecheck` flags it as unused — no unused imports, per the clean-code rule.)

- [ ] **Step 21: Update the `@live` harness for the new factory return.**

  In `gateway/src/bootstrap/native-brain-text.test.ts` (line 187):

  ```ts
        const { runtime } = orchestratorServices.createSessionRuntime(alice, TEST_SESSION_ID, emitter);
  ```

- [ ] **Step 22: Write the failing test for `permission.response` routing + teardown.**

  Append to `gateway/src/session-handlers/ws-handlers-routing.test.ts`:

  ```ts
  interface StubPermissions extends PermissionBroker {
    resolveCalls: Array<{ requestId: string; approved: boolean }>;
    denyAllCallCount: () => number;
  }

  function stubPermissions(matches = true): StubPermissions {
    const resolveCalls: Array<{ requestId: string; approved: boolean }> = [];
    let denyAllCalls = 0;
    return {
      resolveCalls,
      denyAllCallCount: () => denyAllCalls,
      request: async () => false,
      resolve: (requestId, approved) => {
        resolveCalls.push({ requestId, approved });
        return matches;
      },
      denyAll: () => {
        denyAllCalls += 1;
      },
      get pendingCount() {
        return 0;
      },
    };
  }

  describe("ws-handlers routing — permission.response", () => {
    it("routes the client's decision into this connection's permission broker", async () => {
      const { runtime } = stubRuntime();
      const permissions = stubPermissions();
      const ws = fakeAuthedWs(runtime);
      ws.data.permissions = permissions;

      await handleWebSocketMessage(
        ws as unknown as ServerWebSocket<SessionData>,
        JSON.stringify({ type: "permission.response", requestId: "req-1", approved: true }),
        unusedServices,
      );

      expect(permissions.resolveCalls).toEqual([{ requestId: "req-1", approved: true }]);
      expect(ws.sent).toEqual([]);
    });

    it("does not throw or answer when the requestId matches nothing on this connection", async () => {
      const { runtime } = stubRuntime();
      const permissions = stubPermissions(false);
      const ws = fakeAuthedWs(runtime);
      ws.data.permissions = permissions;

      await expect(
        handleWebSocketMessage(
          ws as unknown as ServerWebSocket<SessionData>,
          JSON.stringify({ type: "permission.response", requestId: "someone-elses-request", approved: true }),
          unusedServices,
        ),
      ).resolves.toBeUndefined();

      expect(ws.sent).toEqual([]);
    });

    it("is a safe no-op when the connection has no permission broker", async () => {
      const ws = fakeAuthedWs(null);

      await expect(
        handleWebSocketMessage(
          ws as unknown as ServerWebSocket<SessionData>,
          JSON.stringify({ type: "permission.response", requestId: "req-1", approved: true }),
          unusedServices,
        ),
      ).resolves.toBeUndefined();

      expect(ws.sent).toEqual([]);
    });
  });

  describe("ws-handlers cleanup — outstanding permission prompts", () => {
    it("denies every open prompt so a dropped socket never leaks a pending promise", () => {
      const { runtime } = stubRuntime();
      const permissions = stubPermissions();
      const ws = fakeAuthedWs(runtime);
      ws.data.permissions = permissions;

      cleanupSession(ws as unknown as ServerWebSocket<SessionData>, cleanupServices);

      expect(permissions.denyAllCallCount()).toBe(1);
      expect(ws.data.permissions).toBeNull();
    });
  });
  ```

  Add to that file's imports and fixtures:

  ```ts
  import type { PermissionBroker } from "../runtime/permission-broker.js";
  import { cleanupSession, handleWebSocketMessage } from "./ws-handlers.js";

  // cleanupSession() DOES dereference services (sessionManager) — unlike the
  // text.input/interrupt cases, so it gets a real two-method stub.
  const cleanupServices = {
    sessionManager: { unbindUser: () => {}, removeSession: () => {} },
  } as unknown as GatewayServices;
  ```

  and set `data.permissions = null;` in `fakeAuthedWs` (it comes from `createEmptySessionData()`, so this is only needed if you assign a stub afterwards — leave the default as-is).

- [ ] **Step 23: Run it — expect failure.**

  ```bash
  cd /Users/kevinye/Development/sentient && source scripts/env.sh && cd gateway/src && bun test session-handlers/ws-handlers-routing.test.ts
  ```
  Expected: failures because `SessionData` has no `permissions` property and `permission.response` is not routed (`resolveCalls` stays `[]`).

- [ ] **Step 24: Add `permissions` to `SessionData`.**

  In `gateway/src/session-handlers/ws-helpers.ts`, add the import and the field:

  ```ts
  import type { PermissionBroker } from "../runtime/permission-broker.js";
  ```
  ```ts
    /**
     * This connection's L3 permission round-trip (Plan 3 Task 6, spec §7.1).
     * Minted alongside `runtime` in `handleSessionConfigure`; null until then
     * and for the lifetime of a session whose orchestrator is unconfigured.
     * Connection-scoped ON PURPOSE — a `permission.response` frame can only
     * settle a prompt this same socket issued, which is what makes cross-user
     * resolution structurally impossible rather than a check to remember.
     * `cleanupSession` calls `denyAll()` so a dropped socket never strands a
     * ReAct turn awaiting an answer.
     */
    permissions: PermissionBroker | null;
  ```

  and in `createEmptySessionData()`:

  ```ts
      permissions: null,
  ```

- [ ] **Step 25: Route `permission.response` and deny-all on teardown.**

  In `gateway/src/session-handlers/ws-handlers.ts`, add a case before `default:`:

  ```ts
      case "permission.response":
        // Fail-closed by construction: an unknown/duplicate/expired requestId
        // just returns false here — the PDP already denied (or is about to
        // auto-deny) and nothing is re-opened. Only a prompt THIS connection
        // issued can be settled, so a frame naming another user's requestId
        // resolves nothing.
        if (!ws.data.permissions?.resolve(msg.requestId, msg.approved)) {
          log.warn("permission.response.unmatched", {
            sessionId: ws.data.sessionId,
            requestId: msg.requestId,
            reason: "no pending permission prompt on this connection for that requestId",
          });
        }
        return;
  ```

  In `cleanupSession`, immediately before the existing `ws.data.runtime?.dispose();`:

  ```ts
    // Settle every open permission prompt BEFORE disposing the runtime: each
    // one is a promise the ReAct loop is awaiting inside `broker.dispatch`,
    // and an unsettled one would keep that turn parked for the full
    // permission timeout after the socket is already gone.
    ws.data.permissions?.denyAll();
    ws.data.permissions = null;
  ```

  Update this file's routing comment block (lines 38-50) — it currently says `tool.confirm` "belongs to Plan 3". Replace the `tool.confirm` mention in the `default:` case comment with:

  ```ts
      default:
        // audio.start / audio.end / session.new / conversation.activate still
        // require the voice + multi-conversation wiring landing in their own
        // Plan 3 tasks. Received but unhandled.
        log.debug("message-unhandled", { type: msg.type, reason: "not yet wired" });
        return;
  ```

- [ ] **Step 26: Hand the broker to the WS layer in `session.configure`.**

  In `gateway/src/session-handlers/ws-session-configure.ts`, replace the runtime-mint block (lines 69-99):

  ```ts
    // A repeat session.configure on the same connection (e.g. a future
    // reconnect/resume flow) must not leak the previous runtime's store handle
    // or strand its open permission prompts — tear both down before minting a
    // fresh pair.
    if (ws.data.runtime) {
      log.info("session-configure.reconfigure", { sessionId, userId, reason: "disposing prior runtime" });
      ws.data.permissions?.denyAll();
      ws.data.permissions = null;
      ws.data.runtime.dispose();
      ws.data.runtime = null;
    }

    if (services.createSessionRuntime) {
      try {
        const emitter = createWsTurnEmitter(ws);
        const handles = services.createSessionRuntime(principal, sessionId, emitter);
        ws.data.runtime = handles.runtime;
        ws.data.permissions = handles.permissions;
      } catch (err) {
  ```

  (the `catch` body and everything after it are unchanged.)

- [ ] **Step 27: Run to green.**

  ```bash
  cd /Users/kevinye/Development/sentient && source scripts/env.sh && cd gateway/src && bun test session-handlers/
  ```
  Expected: all `session-handlers/` tests pass.

- [ ] **Step 28: Commit the WS wiring.**

  ```bash
  cd /Users/kevinye/Development/sentient
  git add gateway/src/runtime/session-handles.ts gateway/src/bootstrap/ gateway/src/session-handlers/
  git commit -m "feat(gateway): wire the permission round-trip through session.configure and ws-handlers"
  ```

- [ ] **Step 29: Give `ToolUpdate` the fields `turn.tool.update` requires.**

  *(Skip if Step 1's second grep already found `argsPreview` in `react-loop.ts`.)* In `gateway/src/runtime/react-loop.ts`, extend the interface:

  ```ts
  /** Fed to `onToolUpdate` for the client's running/done tool tiles (spec §7,
   *  frame `turn.tool.update`). `taskId` is present only on a background
   *  dispatch's single "running" update — its eventual completion arrives later
   *  as a stimulus, never as a second update through this callback.
   *  `startedAtMs`/`endedAtMs` let the client render elapsed time without
   *  guessing from frame arrival order; `argsPreview` is a truncated preview of
   *  the RAW argument JSON (never the parsed object — the tile shows a hint,
   *  not a payload). */
  export interface ToolUpdate {
    toolCallId: string;
    toolName: string;
    status: ToolUpdateStatus;
    taskId?: string;
    argsPreview: string;
    startedAtMs: number;
    endedAtMs?: number;
  }
  ```

  and populate them at the three `onToolUpdate` call sites in `dispatchToolCalls`:

  ```ts
      const toolCallId = call.id;
      const toolName = call.function.name;
      const argsPreview = call.function.arguments.slice(0, DEBUG_PREVIEW_LEN);
      const startedAtMs = Date.now();

      store.append({ /* …unchanged tool_call append… */ });
      onToolUpdate(turnId, { toolCallId, toolName, status: "running", argsPreview, startedAtMs });
  ```
  ```ts
      if ("taskId" in outcome) {
        store.append({ /* …unchanged system "Task started" append… */ });
        onToolUpdate(turnId, {
          toolCallId,
          toolName,
          status: "running",
          taskId: outcome.taskId,
          argsPreview,
          startedAtMs,
        });
  ```
  ```ts
      onToolUpdate(turnId, {
        toolCallId,
        toolName,
        status: outcome.isError ? "error" : "done",
        argsPreview,
        startedAtMs,
        endedAtMs: Date.now(),
      });
  ```

- [ ] **Step 30: Update the two test fixtures the new fields break.**

  `gateway/src/runtime/react-loop.test.ts` — the dispatch-shape assertion (line ~202) and the tool-update assertion (line ~217):

  ```ts
      expect(broker.dispatchCalls).toEqual([
        { toolCallId: "call_1", name: "get_weather", args: { city: "NYC" }, signal: expect.anything(), turnId: "turn-2" },
      ]);
  ```
  ```ts
      expect(toolUpdates).toEqual([
        {
          toolCallId: "call_1",
          toolName: "get_weather",
          status: "running",
          argsPreview: expect.any(String),
          startedAtMs: expect.any(Number),
        },
        {
          toolCallId: "call_1",
          toolName: "get_weather",
          status: "done",
          argsPreview: expect.any(String),
          startedAtMs: expect.any(Number),
          endedAtMs: expect.any(Number),
        },
      ]);
  ```

  `gateway/src/runtime/session-runtime.test.ts` — `testConfig()` builds an `OrchestratorConfig` literal, which now needs the new block (line ~36):

  ```ts
      loop: { max_iterations: maxIterations },
      permission: { request_timeout_ms: 120000 },
      tools: { foreground_timeout_ms: 30000, max_concurrent_background_tasks: 50 },
  ```

- [ ] **Step 31: Write the failing test proving `turn.aborted` reaches the emitter on interrupt.**

  `cancellation.ts` calls `emitter.turnAborted` and Task 1 gave it a frame — this pins the producer end so a future refactor of the cutoff path cannot silently go log-only again. In `gateway/src/runtime/session-runtime.test.ts`, first extend the recording emitter so cutoff kind is captured:

  ```ts
  interface RecordedEvent {
    type: "turnStarted" | "textDelta" | "toolUpdate" | "turnCompleted" | "turnAborted";
    turnId: string;
    cutoff?: CutoffKind;
  }
  ```
  ```ts
      turnAborted: (turnId, cutoff) => events.push({ type: "turnAborted", turnId, cutoff }),
  ```
  (add `import type { CutoffKind } from "../store/entry-types.js";`)

  then append a case:

  ```ts
  describe("SessionRuntime — turn.aborted producer", () => {
    it("fires turnAborted exactly once with cutoff=interrupt for the in-flight turn", async () => {
      const am = createAccessManager({ userDataRoot: `${ROOT}/abort-frame` });
      const alice = createUserPrincipal("u_aaaaaaaa", "adult", "home");
      mkdirSync(am.userHomeDir(alice), { recursive: true });

      // A provider that streams one delta then hangs, so the turn is reliably
      // mid-flight when interrupt() lands.
      const provider = fakeProvider(async function* () {
        yield { type: "text", content: "thinking" } as ProviderStreamChunk;
        await new Promise(() => {});
      });
      const emitter = recordingEmitter();
      const runtime = createSessionRuntime({
        principal: alice,
        sessionId: "session-abort",
        accessManager: am,
        provider,
        broker: noopBroker(),
        emitter,
        systemPrompt: "test",
        config: testConfig(),
      });

      runtime.submit({ kind: "conversational", text: "hello" });
      await waitFor(() => emitter.events.some((e) => e.type === "textDelta"));

      runtime.interrupt();
      runtime.interrupt(); // idempotent — must NOT produce a second frame

      const aborted = emitter.events.filter((e) => e.type === "turnAborted");
      expect(aborted).toHaveLength(1);
      expect(aborted[0]?.cutoff).toBe("interrupt");
      expect(emitter.events.filter((e) => e.type === "turnCompleted")).toHaveLength(0);

      runtime.dispose();
    });
  });
  ```

- [ ] **Step 32: Run the runtime suite to green.**

  ```bash
  cd /Users/kevinye/Development/sentient && source scripts/env.sh && cd gateway/src && bun test runtime/
  ```
  Expected: everything in `runtime/` passes, including the two pre-existing cancellation regression cases (they must not have changed behavior — if either fails, revert whatever touched `cancellation.ts` and re-read the Global Constraints).

- [ ] **Step 33: Make the confirm path reachable — add one `confirm` policy rule.**

  `gateway/mcp-policy.yaml` has no `confirm` rule today, so the whole round-trip is dead code until an operator writes one. Append (first match wins, so order matters — this goes last):

  ```yaml
    # Side-effecting Home Assistant call → real permission prompt (spec §2.2's
    # write/side-effecting tier). This is the rule the permission E2E cases
    # drive; `ha_get_*` reads stay in the low-risk allow tier with no rule.
    - name: confirm_ha_service_call
      tool: ha_call_service
      condition: 'tool == "ha_call_service"'
      action: confirm
      reason: "Calling a Home Assistant service changes device state"
  ```

- [ ] **Step 34: Full quality gate.**

  ```bash
  cd /Users/kevinye/Development/sentient && source scripts/env.sh && bun run ci
  ```
  Expected: lint clean, typecheck clean across every workspace, all unit suites green. Fix anything that surfaces — in particular any remaining `ToolInvocation` literal missing `turnId`, or an unused `SessionRuntime` import left in `create-gateway-services.ts`.

- [ ] **Step 35: Commit the producers and the policy rule.**

  ```bash
  cd /Users/kevinye/Development/sentient
  git add gateway/src/runtime/react-loop.ts gateway/src/runtime/react-loop.test.ts \
          gateway/src/runtime/session-runtime.test.ts gateway/mcp-policy.yaml
  git commit -m "feat(runtime): populate turn.tool.update payload fields and pin the turn.aborted producer"
  ```

---

#### E2E matrix (inline, per `.claude/rules/e2e-testing.md`)

These rows are executed by **T11 (web / Playwright MCP)** and **T12 (native / Maestro)** — they need T7/T8/T9's dialog UI to be user-visible. Task 6's own acceptance gate is `bun run ci` green plus the log trail below observed against the local stack (`deploy/macos/`, gateway on `:8888`).

| Case | Viewport | Pre-state | Action | Expected user-visible | Expected log trail |
|---|---|---|---|---|---|
| permission-confirm-approve | desktop 1280×900 + mobile 390×844 | authed, HA MCP reachable | ask the assistant to turn on a light (routes to `ha_call_service`) | permission dialog with tool name, arg summary, Allow/Deny; Allow → tool runs, answer streams | `tool-broker.pdp.decision action=confirm`; `permission-broker.request`; `permission-broker.settled reason=allowed`; `tool-broker.pdp.confirm-resolved confirmed=true`; `tool-broker.dispatch.foreground.done` |
| permission-confirm-deny | desktop 1280×900 | dialog open from the row above | press Deny | dialog dismisses; assistant explains it was not permitted and adapts | `permission-broker.settled reason=denied`; `tool-broker.dispatch.denied reason="confirmation declined: …"`; no `mcp.callTool` |
| permission-timeout | desktop 1280×900 | dialog open; `orchestrator.permission.request_timeout_ms` lowered to 5000 in the LOCAL operator config (`~/.sentient/gateway/config/config.yaml`, edited in place, restored after) | wait past the deadline without answering | dialog auto-dismisses; assistant says the request timed out | `permission-broker.settled reason=timeout`; `permission.resolved outcome=timeout` frame out; `tool-broker.pdp.confirm-error unavailable=true reason="permission request timed out"`; tool result content is that same string |
| permission-socket-close | desktop 1280×900 | dialog open | close the browser tab | (no UI) reconnect works normally; no wedged session | `permission-broker.deny-all count=1`; `session-cleanup`; no `permission-broker.settled reason=timeout` afterwards |
| permission-cross-connection | desktop 1280×900, two tabs / two users | tab A has a dialog open | tab B sends a `permission.response` carrying tab A's requestId (via the console) | tab A's dialog stays open and eventually times out | `permission.response.unmatched` on B's socket; A's prompt still pending |
| delegation-progress | desktop 1280×900 | authed | ask for a long/complex task → `delegateTask("hermes", …)` | delegation tile appears running, flips to done when the worker returns; assistant keeps talking meanwhile | `tool-broker.dispatch.background.started`; `delegation.progress status=running`; later `delegation.progress status=done`; `background-registry.completed` |
| tool-tile-timing | desktop 1280×900 | authed | ask something needing one foreground MCP read | tool tile shows running → done with an elapsed time and an args hint | `turn.tool.update` frames carrying `argsPreview`, `startedAtMs`, and `endedAtMs` on the terminal one |
| turn-aborted-frame | desktop 1280×900 | assistant mid-stream | press Stop | bubble stops and renders as interrupted; any background task is cancelled | `cancellation.abort cutoff=interrupt`; `turn.aborted` frame out exactly once; `cancellation.background.cancel-all` |

---

#### Notes, non-goals, and the one asynchrony to respect

- **`cancellation.ts` is not modified.** It already commits the cutoff-stamped entry and calls `emitter.turnAborted`; this task only proves the frame lands and that a double `interrupt()` still produces exactly one. The `signal.aborted || turn.settled` double-commit guard and `interrupt()`'s unconditional `cancelAll()` stay exactly as they are.
- **`playback.stop` is not this task's frame.** Flushing client audio on barge-in/interrupt belongs with the voice wiring (T2). Do not add an audio-flush call here.
- **Background cancel is best-effort and settles asynchronously.** `BackgroundRegistry.cancelAll()` is synchronous fire-and-forget: it invokes each `cancel` handle and clears its map immediately, but the underlying runner's promise settles later, and the registry slot is only *formally* freed by `dispatchBackground`'s `.then()` continuation — which then also fires the `done`/`error` `delegation.progress` frame and the completion sink. Therefore: never assert "the background task is fully stopped" synchronously after an interrupt, and expect a terminal `delegation.progress` for a cancelled task to arrive *after* `turn.aborted`. That ordering is correct, not a bug.
- **`ToolInvocation.turnId` does not move the append responsibility.** Store appends stay in `react-loop.ts` (it owns turn semantics); the broker reads `turnId` purely to key an outbound frame. Do not add a `store.append` to `tool-broker.ts` — `ToolBrokerDeps.store` is still the interface-parity stub that throws on use.
- **Never add config keys under `cerebrum:`.** The new key is `orchestrator.permission.request_timeout_ms`; the `cerebrum:` block's own comment forbids additions and it is scheduled for deletion.
- **Log hygiene:** `permission-broker.ts` logs argument *keys*, never values, even though the values legitimately go on the wire to the user's own dialog.
