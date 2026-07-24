// delegateTask (Plan 2 Task 5, spec §5.4) — the single immutable background
// tool slot that collapses every present/future delegated worker behind one
// enum value + one DelegationGuard frontmatter entry. v1 wires exactly
// `agent: "hermes"`; adding `codex`/`opencode` later is a new frontmatter
// file + a new DelegationGuard map entry, not a new tool slot.
//
// Registers under the `BackgroundToolRunner` shape `tool-broker.ts` expects
// (matched from that file, not re-derived): `definition: ToolDefinition` +
// `run(inv, taskId): { cancel: () => void; result: Promise<ToolResult> }`.
// `run` starts the guard evaluation + (if allowed) the Hermes invocation
// immediately and returns synchronously — the broker never awaits `result`
// before `dispatch` returns (fire-and-steer, spec §5.2).
//
// Late-result note (load-bearing, spec §5.2/§5.4): the `result` promise this
// runner returns settles with the FINAL ToolResult, but nothing in this file
// appends it to the store. `ToolInvocation` carries no `turnId` (see
// tool-broker.ts's header for why), so the append — as a fresh
// `system`/`trigger` entry, NEVER a second `tool_result` for
// `inv.toolCallId` — is owned by the SessionRuntime layer (Task 7), which
// observes this same `result` promise and holds the turnId context this
// file does not.

import { getLog } from "../logging/logger.js";
import type { UserId } from "../user-auth/user-id.js";
import type { DelegationGuard } from "./delegation-guard.js";
import type { HermesRunner } from "./hermes-runner.js";
import type { BackgroundToolRunner } from "./tool-broker.js";
import type { ToolDefinition, ToolInvocation, ToolResult } from "./tool-types.js";

const log = getLog(["sentient", "tools", "delegate-task"]);

const TOOL_NAME = "delegateTask";
const SUPPORTED_AGENTS = ["hermes"] as const;
const BAD_ARGS_MESSAGE = "delegateTask requires string arguments { agent, taskPrompt }";

export const delegateTaskDefinition: ToolDefinition = {
  name: TOOL_NAME,
  description: `Delegate a free-form task to a background worker agent. Returns immediately; the worker runs off-loop and its result arrives later as a stimulus. Supported agents: ${SUPPORTED_AGENTS.join(", ")}.`,
  parameters: {
    type: "object",
    properties: {
      agent: { type: "string", enum: [...SUPPORTED_AGENTS], description: "Which delegated worker to invoke." },
      taskPrompt: { type: "string", description: "Free-form instructions for the delegated worker." },
    },
    required: ["agent", "taskPrompt"],
  },
  category: "background",
};

export interface DelegateTaskDeps {
  guard: DelegationGuard;
  hermesRunner: HermesRunner;
  /** The session's principal — delegated to Hermes as `-p <userId>`. */
  userId: UserId;
}

function parseArgs(args: Record<string, unknown>): { agent: string; taskPrompt: string } | null {
  const { agent, taskPrompt } = args;
  if (typeof agent !== "string" || typeof taskPrompt !== "string") return null;
  return { agent, taskPrompt };
}

function errorResult(content: string): ToolResult {
  return { content, isError: true };
}

export function createDelegateTaskRunner(deps: DelegateTaskDeps): BackgroundToolRunner {
  const { guard, hermesRunner, userId } = deps;

  function run(inv: ToolInvocation, taskId: string): { cancel: () => void; result: Promise<ToolResult> } {
    const parsed = parseArgs(inv.args);
    if (!parsed) {
      log.warn("delegate-task.run.bad-args", { taskId, toolCallId: inv.toolCallId });
      return { cancel: () => {}, result: Promise.resolve(errorResult(BAD_ARGS_MESSAGE)) };
    }

    const { agent, taskPrompt } = parsed;
    const decision = guard.evaluate(agent, taskPrompt);
    log.info("delegate-task.run.guard-decision", { taskId, agent, action: decision.action });

    if (decision.action !== "allow") {
      // No wired confirm-UI seam for delegation yet (Plan 3) — `confirm`
      // fails closed exactly like `deny`, mirroring tool-broker.ts's own
      // Plan 2 default (see that file's header).
      return { cancel: () => {}, result: Promise.resolve(errorResult(decision.reason)) };
    }

    const controller = new AbortController();
    const onInvAbort = () => controller.abort();
    inv.signal.addEventListener("abort", onInvAbort, { once: true });

    const result = hermesRunner.run(userId, taskPrompt, controller.signal).then((outcome): ToolResult => {
      inv.signal.removeEventListener("abort", onInvAbort);
      if (outcome.ok) {
        log.info("delegate-task.run.ok", { taskId, agent, outputLength: outcome.output.length });
        return { content: outcome.output, isError: false };
      }
      log.warn("delegate-task.run.failed", { taskId, agent, reason: outcome.error });
      return { content: outcome.error, isError: true };
    });

    return { cancel: () => controller.abort(), result };
  }

  return { definition: delegateTaskDefinition, run };
}
