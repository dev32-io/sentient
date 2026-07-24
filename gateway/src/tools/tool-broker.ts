// ToolBroker (Plan 2 Task 4, spec §5.3) — the single L3 permission-decision
// choke point every tool call passes through, foreground or background,
// before any side effect runs. Prior-art lesson (carried in the plan's
// Global Constraints): two dispatch paths means one silently skips the
// gate. `resolveDecision` below is called from exactly ONE place inside
// `dispatch` — both branches (foreground MCP call, background runner) flow
// through it first, so a `deny` or an unconfirmed `confirm` structurally
// cannot reach `mcp.callTool` or a `BackgroundToolRunner.run`.
//
// Fail-closed: `policy-engine.ts` itself fails OPEN (no matching rule →
// allow) and treats `confirm` as an implementation detail with no UI behind
// it yet. This broker closes that gap for `confirm` — it calls the injected
// `requestConfirm`, and Plan 2's composition root wires a default that
// always returns `false` (deny), so an unconfirmed side-effecting tool is
// BLOCKED, never silently run. Plan 3 replaces that default with a real
// permission-prompt UI without touching this file.
//
// `store: SessionStore` is accepted for interface parity with the wider
// deps-threading pattern (composition root, Task 9) but is NOT used to
// append tool_call/tool_result here. Per spec §4.3's loop steps and Task
// 6's brief ("for each call, broker.dispatch ... loop appends
// tool_call+tool_result"), that append is the ReAct loop's job — it owns
// `turnId`, which `ToolInvocation` (Task 3, locked) does not carry and
// which `SessionEntry` requires on every row. Giving the append to the
// loop also keeps this file focused on the one thing it must get right:
// the PDP choke point.
//
// `sessionChannel` is hardcoded to "text": Plan 2 walks text-only
// end-to-end (voice/TTS lands in Plan 3). When a session gains a real
// channel, thread it through `createToolBroker`'s deps instead of the
// principal/config shape locked here.

import type { OrchestratorConfig } from "@sentient/config";
import type { UserPrincipal } from "../identity/user-principal.js";
import { getLog } from "../logging/logger.js";
import type { PolicyContext, PolicyEngine } from "../security/policy-engine.js";
import type { SessionStore } from "../store/session-store.js";
import { createBackgroundRegistry } from "./background-registry.js";
import type { BackgroundRegistry } from "./background-registry.js";
import type { McpClient } from "./mcp-client.js";
import type { PdpDecision, ToolDefinition, ToolInvocation, ToolResult } from "./tool-types.js";

const log = getLog(["sentient", "tools", "tool-broker"]);

const TOO_MANY_BACKGROUND_TASKS = "too many running tasks";

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
 *  `setBackgroundCompletionSink` installed. `toolName` + `taskId` let the
 *  sink build a readable stimulus note; `content`/`isError` are the
 *  runner's settled `ToolResult`, normalized (a rejected `result` promise
 *  becomes an `isError: true` entry here — the sink never has to handle a
 *  rejection itself). */
export interface BackgroundCompletionResult {
  taskId: string;
  toolName: string;
  content: string;
  isError: boolean;
}

/** Late-bound completion callback (see `ToolBroker.setBackgroundCompletionSink`). */
export type BackgroundCompletionSink = (result: BackgroundCompletionResult) => void;

export interface ToolBroker {
  /** The session's full, immutable tool vocabulary (MCP-catalog tools +
   *  registered background tools). Computed once and cached — never
   *  mutated per turn (spec §4.6: hiding a tool is not a security
   *  boundary, L3 at the call is). */
  definitions(): ToolDefinition[];
  /** foreground → awaits the result; background → returns `{ taskId }`
   *  immediately without blocking on the runner. Every call passes the L3
   *  PDP check first, unconditionally. */
  dispatch(inv: ToolInvocation): Promise<ToolResult | { taskId: string }>;
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
  principal: UserPrincipal;
  sessionId: string;
  /** name → runner. `delegateTask` (Task 5) registers itself here. */
  backgroundTools: Map<string, BackgroundToolRunner>;
  config: OrchestratorConfig["tools"];
  /** Resolves an L3 `confirm` decision. Plan 3 wires real client UI; Plan
   *  2's default always resolves `false` (deny) — see the file header. */
  requestConfirm: (inv: ToolInvocation, reason: string) => Promise<boolean>;
}

export function createToolBroker(deps: ToolBrokerDeps): ToolBroker {
  const { mcp, policy, principal, sessionId, backgroundTools, config, requestConfirm } = deps;
  const background = createBackgroundRegistry();
  // Late-bound (see `ToolBroker.setBackgroundCompletionSink`'s doc comment
  // for why this can't be a constructor dep). `null` until the composition
  // root binds it — dispatchBackground below tolerates that by just not
  // forwarding the settled result.
  let completionSink: BackgroundCompletionSink | null = null;

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
      userId: principal.userId,
      role: principal.role,
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
    } catch {
      log.warn("tool-broker.pdp.confirm-error", {
        sessionId,
        tool: inv.name,
        toolCallId: inv.toolCallId,
        reason: "confirm hook threw — failing closed",
      });
      return { action: "deny", reason: "confirmation error" };
    }
    log.info("tool-broker.pdp.confirm-resolved", {
      sessionId,
      tool: inv.name,
      toolCallId: inv.toolCallId,
      confirmed,
    });
    return confirmed ? { action: "allow" } : { action: "deny", reason: `confirmation declined: ${reason}` };
  }

  async function dispatchForeground(inv: ToolInvocation): Promise<ToolResult> {
    await ensureMcpWarm();
    const serverName = mcpIndex?.get(inv.name);
    if (!serverName) {
      log.warn("tool-broker.dispatch.unknown-tool", { sessionId, tool: inv.name, toolCallId: inv.toolCallId });
      return { content: `Unknown tool: ${inv.name}`, isError: true };
    }
    // Plan 2: the foreground deadline is enforced per-server by the MCP client
    // (each catalog entry's `timeout`), which supersedes config.foreground_timeout_ms
    // at this layer. A broker-level per-call deadline (AbortSignal.timeout merged
    // with inv.signal) is a later hardening step if a single per-call bound is wanted.
    const result = await mcp.callTool(serverName, inv.name, inv.args, inv.signal);
    log.info("tool-broker.dispatch.foreground.done", {
      sessionId,
      tool: inv.name,
      toolCallId: inv.toolCallId,
      isError: result.isError,
      contentLength: result.content.length,
    });
    return result;
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
      .then((toolResult) => {
        background.complete(taskId);
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
        completionSink({ taskId, toolName: inv.name, content: toolResult.content, isError: toolResult.isError });
      });

    return { taskId };
  }

  function definitions(): ToolDefinition[] {
    void ensureMcpWarm(); // idempotent kick-off; definitions() itself stays synchronous
    const backgroundDefs = [...backgroundTools.values()].map((runner) => runner.definition);
    return [...mcpDefs, ...backgroundDefs];
  }

  async function dispatch(inv: ToolInvocation): Promise<ToolResult | { taskId: string }> {
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

    const runner = backgroundTools.get(inv.name);
    if (runner) return dispatchBackground(inv, runner);
    return dispatchForeground(inv);
  }

  function setBackgroundCompletionSink(sink: BackgroundCompletionSink): void {
    completionSink = sink;
  }

  return { definitions, dispatch, background, setBackgroundCompletionSink };
}
