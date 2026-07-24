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
 *  returns (fire-and-steer). The runner owns everything about what
 *  completion means for its own tool: per the late-result constraint
 *  (spec §5.2/§5.4), a background tool's eventual result is appended as a
 *  fresh `system`/`trigger` entry, never a second `tool_result` for an
 *  already-answered call id — that's the runner's job, not the broker's. */
export interface BackgroundToolRunner {
  definition: ToolDefinition;
  run(inv: ToolInvocation, taskId: string): { cancel: () => void; result: Promise<ToolResult> };
}

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
    // says otherwise (Plan 2 default: always false).
    const reason = decision.reason ?? "confirmation required";
    const confirmed = await requestConfirm(inv, reason);
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

    // Fire-and-steer: never awaited before returning `{ taskId }`. The
    // runner is responsible for surfacing its own result to the store
    // (late-result constraint, see the BackgroundToolRunner doc comment);
    // the broker's only remaining job is freeing the concurrency slot.
    result
      .catch((err) => {
        log.warn("tool-broker.dispatch.background.runner-rejected", {
          sessionId,
          tool: inv.name,
          taskId,
          reason: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        background.complete(taskId);
        log.info("tool-broker.dispatch.background.completed", { sessionId, tool: inv.name, taskId });
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

  return { definitions, dispatch, background };
}
