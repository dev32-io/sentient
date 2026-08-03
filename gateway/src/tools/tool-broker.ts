// ToolBroker (Plan 2 Task 4, spec §5.3) — the single L3 permission-decision
// choke point every tool call passes through, foreground or background,
// before any side effect runs. Prior-art lesson (carried in the plan's
// Global Constraints): two dispatch paths means one silently skips the
// gate. `resolveDecision` below is called from exactly ONE place inside
// `dispatch` — both branches (foreground MCP call, background runner) flow
// through it first, so a `deny` or an unconfirmed `confirm` structurally
// cannot reach `mcp.callTool` or a `BackgroundToolRunner.run`.
//
// Fail-closed at both layers: `policy-engine.ts` classifies a tool that NO
// rule names as side-effecting and returns `confirm` (design §2.2), and this
// broker is what makes `confirm` mean something — it calls the injected
// `requestConfirm`, which the composition root binds to the SESSION's
// permission broker (runtime/session-permission-broker.ts's
// `createConfirmHook`), so an unconfirmed side-effecting tool is BLOCKED,
// never silently run. Three outcomes reach a two-valued seam: an explicit
// human answer from ANY window on the session RESOLVES true/false, and an
// UNANSWERABLE request (timeout, no window open, session teardown, turn abort)
// REJECTS with `ConfirmUnavailableError` whose message is forwarded to the
// model verbatim as the deny reason. Any other throw is a bug in the hook and
// stays opaque ("confirmation error"), so an internal error string never
// enters the model's context.
//
// `store: SessionStore` is accepted for interface parity with the wider
// deps-threading pattern (composition root, Task 9) but is NOT used to
// append tool_call/tool_result here. Per spec §4.3's loop steps and Task
// 6's brief ("for each call, broker.dispatch ... loop appends
// tool_call+tool_result"), that append is the ReAct loop's job — it owns
// turn semantics. `ToolInvocation` now carries `turnId`, but ONLY so
// background dispatch can key its `delegation.progress` frames to a turn;
// that field is read for frame correlation and never for a store write.
// Keeping the append in the loop keeps this file focused on the one thing
// it must get right: the PDP choke point.
//
// `sessionChannel` is hardcoded to "text": Plan 2 walks text-only
// end-to-end (voice/TTS lands in Plan 3). When a session gains a real
// channel, thread it through `createToolBroker`'s deps instead of the
// principal/config shape locked here.

import type { OrchestratorConfig } from "@sentient/config";
import type { Capability } from "../access/capability.js";
import type { UserPrincipal } from "../identity/user-principal.js";
import { getLog } from "../logging/logger.js";
import type { PolicyContext, PolicyEngine } from "../security/policy-engine.js";
import type { SessionStore } from "../store/session-store.js";
import type { UserId } from "../user-auth/user-id.js";
import { createBackgroundRegistry } from "./background-registry.js";
import type { BackgroundRegistry } from "./background-registry.js";
import type { McpClient } from "./mcp-client.js";
import { capToolResult } from "./tool-result-cap.js";
import { ConfirmUnavailableError } from "./tool-types.js";
import type { DelegationProgress, PdpDecision, ToolDefinition, ToolInvocation, ToolResult } from "./tool-types.js";

const log = getLog(["sentient", "tools", "tool-broker"]);

const TOO_MANY_BACKGROUND_TASKS = "too many running tasks";

/** Client-facing failure-note budget on a `delegation.progress` error frame.
 *  A tile shows a hint, never the delegated worker's full output. */
const NOTE_PREVIEW_LEN = 120;

/** `delegateTask`'s worker name; any other background tool reports under its
 *  own tool name. Never throws on a malformed `args` — the guard/runner is
 *  what rejects a bad agent, not this display-only derivation. */
/** What the model is told when a HUMAN answered the confirm prompt with "no".
 *
 *  It used to read `confirmation declined: <policy rationale>` — which names
 *  the policy, not the person, and reads like a rule the model might argue
 *  with or route around. A person said no. The system prompt promises the
 *  model "you receive a tool result saying so"; this is that result, and it
 *  has to be unambiguous about WHO decided. */
function userDeclinedReason(toolName: string): string {
  return `The user declined this ${toolName} call. Do not retry it; offer an alternative if one exists.`;
}

function delegationAgent(inv: ToolInvocation): string {
  const agent = inv.args.agent;
  return typeof agent === "string" && agent.length > 0 ? agent : inv.name;
}

/** A background tool's execution unit (e.g. `delegateTask`, Task 5). `run`
 *  starts the work immediately and returns a cancel handle (registered in
 *  `BackgroundRegistry`, invoked on interrupt) plus a result promise the
 *  broker observes off-turn — it is NEVER awaited before `dispatch`
 *  returns (fire-and-steer). The runner's only job is to settle `result`
 *  faithfully with the tool's final outcome; it does NOT touch the store
 *  itself. Per the late-result constraint (spec §5.2/§5.4), that result
 *  must eventually reach the model as a fresh `system`/`trigger` entry,
 *  never a second `tool_result` for an already-answered call id — the
 *  broker does that by observing this same promise in `dispatchBackground`
 *  and forwarding the settled outcome to `onBackgroundComplete` (see
 *  `setBackgroundCompletionSink` below), which the composition root binds
 *  to `SessionRuntime.submit({ kind: "background-completion", ... })`. */
export interface BackgroundToolRunner {
  definition: ToolDefinition;
  run(inv: ToolInvocation, taskId: string): { cancel: () => void; result: Promise<ToolResult> };
}

/** The settled outcome of a background tool run, handed to whatever sink
 *  `setBackgroundCompletionSink` installed. `toolName` + `taskId` + `request`
 *  let the sink build a stimulus note that identifies itself; `content`/
 *  `isError` are the runner's settled `ToolResult`, normalized (a rejected
 *  `result` promise becomes an `isError: true` entry here — the sink never
 *  has to handle a rejection itself). */
export interface BackgroundCompletionResult {
  taskId: string;
  toolName: string;
  /** The dispatching invocation's arguments, forwarded verbatim so the note
   *  can echo what was asked. Carried because a completion outlives the
   *  context that explains it: compaction summarises the dispatch away, and a
   *  bare taskId then binds to nothing — see background-completion-note.ts.
   *  Forwarded as the raw object rather than a distilled string so this file
   *  stays ignorant of any one tool's argument schema. */
  request: Record<string, unknown>;
  content: string;
  isError: boolean;
}

/** Late-bound completion callback (see `ToolBroker.setBackgroundCompletionSink`). */
export type BackgroundCompletionSink = (result: BackgroundCompletionResult) => void;

export interface ToolBroker {
  /** Whose authority this broker acts under — read from its `Capability` at
   *  construction, never from the `principal` dep (spec §3.2: a capability is
   *  the authorization input, `principal` is log correlation only). Exposed
   *  so a caller can confirm which identity a broker instance was actually
   *  built for, the same confused-deputy check `openSessionStore` makes for
   *  the store. */
  readonly ownerUserId: UserId;
  /** The session's full, immutable tool vocabulary (MCP-catalog tools +
   *  registered background tools). Computed once and cached — never
   *  mutated per turn (spec §4.6: hiding a tool is not a security
   *  boundary, L3 at the call is). */
  definitions(): ToolDefinition[];
  /** foreground → awaits the result; background → returns `{ taskId }`
   *  immediately without blocking on the runner. Every call passes the L3
   *  PDP check first, unconditionally. */
  dispatch(inv: ToolInvocation): Promise<ToolResult | { taskId: string }>;
  /**
   * Foreground calls currently awaiting a result. Read by the session
   * retention predicate (runtime/session-retention.ts): a session whose last
   * window closed mid-tool-call is still working, and a tool round-trip is the
   * one part of a turn that can outlive the socket that provoked it.
   */
  readonly foregroundInFlight: number;
  readonly background: BackgroundRegistry;
  /** Late-bound seam for the chicken-and-egg in the broker/runtime
   *  construction order (the broker is built BEFORE the `SessionRuntime`
   *  that owns `submit`, so the sink can't be a constructor dep). The
   *  composition root calls this once, right after `SessionRuntime` exists,
   *  binding it to `runtime.submit({ kind: "background-completion", ... })`
   *  (see `phase-services.ts`'s `buildCreateSessionRuntime`). Unset is a
   *  safe no-op — `dispatchBackground` just drops the settled result, same
   *  as before this seam existed. Not part of `ToolBrokerDeps`: that
   *  interface is fixed at construction time, before the runtime it would
   *  need to close over exists. */
  setBackgroundCompletionSink(sink: BackgroundCompletionSink): void;
}

export interface ToolBrokerDeps {
  mcp: McpClient;
  policy: PolicyEngine;
  store: SessionStore;
  /** The AUTHORIZATION input (spec §3.2). `broker.ownerUserId` and the PDP's
   *  `PolicyContext.userId` both read `capability.ownerUserId` — never
   *  `principal.userId` — so the broker's authority is exactly what its
   *  capability grants, not whatever principal happened to be threaded in
   *  alongside it. Mint from the same `AccessManager` that mints the
   *  session's own store capability. */
  capability: Capability;
  /** Log correlation ONLY (`role` is useful in a log line) — it must never be
   *  an input to a PDP decision. `mcp-policy.yaml` rules keyed on `role`
   *  (e.g. child/guest tiering) still read `principal.role`: role is not the
   *  identity this task's confused-deputy fix is about (a capability is
   *  always minted from the very principal whose role this is — see
   *  `AccessManager.grant` — so the two cannot diverge), and `Capability`
   *  carries no role of its own to substitute. */
  principal: UserPrincipal;
  /** The CONNECTION id (`ws.data.sessionId`), for log correlation and nothing
   *  else — every `tool-broker.*` line below carries it so a dispatch is
   *  traceable to the one socket that made it. It is NOT the durable
   *  conversation the session store partitions on: two connections to the
   *  same conversation (before and after a reload) must stay distinguishable
   *  here. See `SessionRuntimeRequest` in runtime/session-handles.ts. */
  sessionId: string;
  /** name → runner. `delegateTask` (Task 5) registers itself here. */
  backgroundTools: Map<string, BackgroundToolRunner>;
  config: OrchestratorConfig["tools"];
  /** Resolves an L3 `confirm` decision. The composition root binds this to the
   *  SESSION's permission broker (runtime/session-permission-broker.ts): it
   *  resolves `true`/`false` on the FIRST human answer from any attached
   *  window, and REJECTS with `ConfirmUnavailableError` when the prompt could
   *  not be answered at all — including "no window is open to show it".
   *  Either way the call fails closed — see `resolveDecision` below. */
  requestConfirm: (inv: ToolInvocation, reason: string) => Promise<boolean>;
  /** Fired at both ends of a background task's life (spec §5.4 / §7): once
   *  with `status: "running"` the moment `dispatch` hands back a `{taskId}`,
   *  and once with `done`/`error` when the runner's promise settles. The
   *  composition root binds this to the session's `TurnEmitter`, which puts
   *  it on the wire as `delegation.progress`. Optional for the same reason
   *  `setBackgroundCompletionSink` is late-bound — a headless/dev broker has
   *  no client — but an UNSET sink is logged once per task, never silent. */
  onDelegationProgress?: (p: DelegationProgress) => void;
}

export function createToolBroker(deps: ToolBrokerDeps): ToolBroker {
  const {
    mcp,
    policy,
    principal,
    capability,
    sessionId,
    backgroundTools,
    config,
    requestConfirm,
    onDelegationProgress,
  } = deps;
  const ownerUserId = capability.ownerUserId;
  const background = createBackgroundRegistry();
  // Late-bound (see `ToolBroker.setBackgroundCompletionSink`'s doc comment
  // for why this can't be a constructor dep). `null` until the composition
  // root binds it — dispatchBackground below tolerates that by just not
  // forwarding the settled result.
  let completionSink: BackgroundCompletionSink | null = null;
  // Foreground calls awaiting a result. A COUNTER, not a set: the retention
  // predicate only asks whether any call is outstanding, and the loop dispatches
  // a turn's tool calls concurrently.
  let foregroundInFlight = 0;

  // MCP tool listing is I/O (a round-trip to every configured server), so
  // it can't be resolved synchronously inside `definitions()`. It is
  // fetched exactly once per broker instance (memoized on this promise)
  // and cached; `dispatch` awaits the same promise before routing a
  // foreground call, so execution is always correct even if `definitions()`
  // is read before the very first warm-up completes.
  let mcpIndex: Map<string, string> | null = null; // toolName -> serverName
  let mcpDefs: ToolDefinition[] = [];
  let warmup: Promise<void> | null = null;

  function ensureMcpWarm(): Promise<void> {
    if (!warmup) {
      warmup = mcp
        .listTools()
        .then((refs) => {
          mcpIndex = new Map(refs.map((ref) => [ref.name, ref.serverName]));
          mcpDefs = refs.map((ref) => ({
            name: ref.name,
            description: ref.description,
            parameters: ref.inputSchema,
            category: "foreground" as const,
          }));
          log.info("tool-broker.mcp-warmup.ok", { sessionId, toolCount: refs.length });
        })
        .catch((err) => {
          mcpIndex = new Map();
          mcpDefs = [];
          log.warn("tool-broker.mcp-warmup.failed", {
            sessionId,
            reason: err instanceof Error ? err.message : String(err),
          });
        });
    }
    return warmup;
  }

  /** The ONE place `policy.evaluate` is called. Both dispatch branches
   *  (foreground, background) flow through this before any side effect —
   *  that is what makes the choke point structural rather than a
   *  convention two branches could independently drift from. */
  async function resolveDecision(inv: ToolInvocation): Promise<PdpDecision> {
    const ctx: PolicyContext = {
      tool: inv.name,
      userId: ownerUserId, // capability, not the ambient principal — spec §3.2.
      role: principal.role, // RBAC tier only; see ToolBrokerDeps.principal's doc comment.
      sessionChannel: "text", // Plan 2 is text-only; see file header.
      args: inv.args,
    };
    const decision = policy.evaluate(ctx);
    log.info("tool-broker.pdp.decision", {
      sessionId,
      tool: inv.name,
      toolCallId: inv.toolCallId,
      action: decision.action,
      reason: decision.reason,
      rule: decision.rule,
    });

    if (decision.action === "allow") return { action: "allow" };
    if (decision.action === "deny") {
      return { action: "deny", reason: decision.reason ?? "denied by policy" };
    }

    // action === "confirm" — fail-closed unless the injected confirm hook
    // says otherwise (Plan 2 default: always false). A confirm hook that
    // THROWS (Plan 3's real UI could) must still fail closed, and the broker's
    // contract is "never throw out of dispatch" — so a throw becomes a deny,
    // not a rejected promise the ReAct loop has to catch.
    const reason = decision.reason ?? "confirmation required";
    let confirmed: boolean;
    try {
      confirmed = await requestConfirm(inv, reason);
    } catch (err) {
      // Fail-closed either way — the ONLY difference is what the model is
      // told. `ConfirmUnavailableError` is the confirm hook's deliberate
      // "nobody could answer this" signal (timeout / no window open / session
      // closed / turn aborted, see runtime/permission-prompt.ts) and its message is
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
    log.info("tool-broker.pdp.confirm-resolved", {
      sessionId,
      tool: inv.name,
      toolCallId: inv.toolCallId,
      confirmed,
    });
    return confirmed ? { action: "allow" } : { action: "deny", reason: userDeclinedReason(inv.name) };
  }

  /** EXISTENCE, resolved before the PDP ever runs. Returns null for a tool
   *  name that is in neither the MCP catalog nor the background registry.
   *
   *  Order is the whole point. Observed live 3× in one day: the model called
   *  `ha_search`, the catalog has `ha_search_entities`, the PDP prompted the
   *  owner to authorize it, they approved — and only then did dispatch log
   *  `unknown-tool`. A permission prompt asserts that the thing being
   *  authorized is real; raising one for a hallucination spends the human's
   *  attention on nothing and teaches them to click through the prompts that
   *  DO guard something. A name that does not exist is a model error the loop
   *  absorbs, not a decision anyone should be asked to make. */
  async function resolveTarget(
    inv: ToolInvocation,
  ): Promise<{ kind: "background"; runner: BackgroundToolRunner } | { kind: "foreground"; serverName: string } | null> {
    const runner = backgroundTools.get(inv.name);
    if (runner) return { kind: "background", runner };
    await ensureMcpWarm();
    const serverName = mcpIndex?.get(inv.name);
    return serverName ? { kind: "foreground", serverName } : null;
  }

  /** The ONE place a tool result's size is bounded before it can reach the
   *  model (task 18, D17) — every result flowing through this function,
   *  whatever tool produced it, inherits the cap. See tool-result-cap.ts's
   *  file header for why this lives at the broker and not in any one tool. */
  function capResult(inv: ToolInvocation, result: ToolResult, logEvent: string): ToolResult {
    const limit = config.max_tool_result_chars;
    if (result.content.length <= limit) return result;
    const content = capToolResult(result.content, { limit });
    log.warn(logEvent, {
      sessionId,
      tool: inv.name,
      toolCallId: inv.toolCallId,
      originalLength: result.content.length,
      cappedLength: content.length,
      limit,
      reason:
        "tool result exceeded orchestrator.tools.max_tool_result_chars — truncated head+tail so it cannot alone exhaust the answer budget",
    });
    return { ...result, content };
  }

  async function dispatchForeground(inv: ToolInvocation, serverName: string): Promise<ToolResult> {
    // Plan 2: the foreground deadline is enforced per-server by the MCP client
    // (each catalog entry's `timeout`), which supersedes config.foreground_timeout_ms
    // at this layer. A broker-level per-call deadline (AbortSignal.timeout merged
    // with inv.signal) is a later hardening step if a single per-call bound is wanted.
    foregroundInFlight += 1;
    try {
      const raw = await mcp.callTool(serverName, inv.name, inv.args, inv.signal);
      const result = capResult(inv, raw, "tool-broker.dispatch.foreground.result-capped");
      log.info("tool-broker.dispatch.foreground.done", {
        sessionId,
        tool: inv.name,
        toolCallId: inv.toolCallId,
        isError: result.isError,
        contentLength: result.content.length,
      });
      return result;
    } finally {
      // `finally`, not a decrement after the await: a throwing or aborted call
      // that left the counter high would pin its session resident forever.
      foregroundInFlight -= 1;
    }
  }

  function dispatchBackground(inv: ToolInvocation, runner: BackgroundToolRunner): ToolResult | { taskId: string } {
    const cap = config.max_concurrent_background_tasks;
    const running = background.count();
    if (running >= cap) {
      log.warn("tool-broker.dispatch.background.cap-exceeded", {
        sessionId,
        tool: inv.name,
        toolCallId: inv.toolCallId,
        running,
        cap,
      });
      return { content: TOO_MANY_BACKGROUND_TASKS, isError: true };
    }

    const taskId = crypto.randomUUID();
    const { cancel, result } = runner.run(inv, taskId);
    background.register(taskId, cancel);
    log.info("tool-broker.dispatch.background.started", {
      sessionId,
      tool: inv.name,
      toolCallId: inv.toolCallId,
      taskId,
    });

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

    // Fire-and-steer: never awaited before returning `{ taskId }`. First
    // stage normalizes a rejected `result` into an isError ToolResult (a
    // runner's promise must never reach the second stage as a rejection,
    // per the BackgroundToolRunner contract); second stage always runs with
    // a settled ToolResult, frees the concurrency slot, and — this closes
    // the loop the file header describes — forwards the outcome to whatever
    // `setBackgroundCompletionSink` installed, so the delegated task's
    // output actually reaches the model instead of dead-ending here.
    result
      .then(
        (toolResult) => toolResult,
        (err): ToolResult => {
          const reason = err instanceof Error ? err.message : String(err);
          log.warn("tool-broker.dispatch.background.runner-rejected", {
            sessionId,
            tool: inv.name,
            taskId,
            reason,
          });
          return { content: `Background task failed: ${reason}`, isError: true };
        },
      )
      .then((raw) => {
        // Same cap as the foreground path — a delegated task's own settled
        // output reaches the model too (via the completion sink below), so
        // it can starve the answer just as surely as a big MCP tool result.
        const toolResult = capResult(inv, raw, "tool-broker.dispatch.background.result-capped");
        background.complete(taskId);
        onDelegationProgress?.({
          taskId,
          turnId: inv.turnId,
          agent,
          status: toolResult.isError ? "error" : "done",
          ...(toolResult.isError ? { note: toolResult.content.slice(0, NOTE_PREVIEW_LEN) } : {}),
        });
        log.info("tool-broker.dispatch.background.completed", {
          sessionId,
          tool: inv.name,
          taskId,
          isError: toolResult.isError,
          contentLength: toolResult.content.length,
        });
        if (!completionSink) {
          log.warn("tool-broker.dispatch.background.no-sink", {
            sessionId,
            tool: inv.name,
            taskId,
            reason: "setBackgroundCompletionSink was never bound — settled result dropped",
          });
          return;
        }
        completionSink({
          taskId,
          toolName: inv.name,
          request: inv.args,
          content: toolResult.content,
          isError: toolResult.isError,
        });
      });

    return { taskId };
  }

  function definitions(): ToolDefinition[] {
    void ensureMcpWarm(); // idempotent kick-off; definitions() itself stays synchronous
    const backgroundDefs = [...backgroundTools.values()].map((runner) => runner.definition);
    return [...mcpDefs, ...backgroundDefs];
  }

  async function dispatch(inv: ToolInvocation): Promise<ToolResult | { taskId: string }> {
    const target = await resolveTarget(inv);
    if (!target) {
      log.warn("tool-broker.dispatch.unknown-tool", {
        sessionId,
        tool: inv.name,
        toolCallId: inv.toolCallId,
        reason: "name is in neither the MCP catalog nor the background registry — answered before the PDP",
      });
      return { content: `Unknown tool: ${inv.name}`, isError: true };
    }

    const decision = await resolveDecision(inv);
    if (decision.action === "deny") {
      log.warn("tool-broker.dispatch.denied", {
        sessionId,
        tool: inv.name,
        toolCallId: inv.toolCallId,
        reason: decision.reason,
      });
      return { content: decision.reason, isError: true };
    }

    if (target.kind === "background") return dispatchBackground(inv, target.runner);
    return dispatchForeground(inv, target.serverName);
  }

  function setBackgroundCompletionSink(sink: BackgroundCompletionSink): void {
    completionSink = sink;
  }

  return {
    ownerUserId,
    definitions,
    dispatch,
    get foregroundInFlight() {
      return foregroundInFlight;
    },
    background,
    setBackgroundCompletionSink,
  };
}
