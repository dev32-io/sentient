import { describe, expect, it } from "bun:test";
import type { Result } from "@sentient/protocol";
import type { ExternalTool, ExternalToolError } from "../external-tools/external-tool.js";
import type { UserId } from "../user-auth/user-id.js";
import { createDelegateTaskRunner, delegateTaskDefinition } from "./delegate-task.js";
import type { DelegationDecision, DelegationGuard } from "./delegation-guard.js";
import type { HermesRunResult, HermesRunner } from "./hermes-runner.js";
import type { ToolInvocation } from "./tool-types.js";

const userId = "u_aaaaaaaa" as UserId;

function fakeGuard(
  decision: DelegationDecision,
): DelegationGuard & { calls: Array<{ agent: string; taskPrompt: string }> } {
  const calls: Array<{ agent: string; taskPrompt: string }> = [];
  return {
    calls,
    evaluate(agent, taskPrompt) {
      calls.push({ agent, taskPrompt });
      return decision;
    },
  };
}

function fakeHermesRunner(result: HermesRunResult): HermesRunner & { callCount: () => number } {
  let calls = 0;
  return {
    callCount: () => calls,
    async run() {
      calls += 1;
      return result;
    },
  };
}

function makeInvocation(
  args: Record<string, unknown>,
  signal: AbortSignal = new AbortController().signal,
): ToolInvocation {
  return { toolCallId: "call-1", name: "delegateTask", args, signal, turnId: "turn-1" };
}

describe("delegateTask definition", () => {
  it("registers as a background tool named delegateTask", () => {
    expect(delegateTaskDefinition.name).toBe("delegateTask");
    expect(delegateTaskDefinition.category).toBe("background");
  });
});

describe("delegateTask runner — guard gates every invocation before hermesRunner ever runs", () => {
  it("a deny decision surfaces as an isError result and never calls hermesRunner", async () => {
    const guard = fakeGuard({ action: "deny", reason: "unknown delegation agent" });
    const hermesRunner = fakeHermesRunner({ ok: true, output: "should never happen" });
    const runner = createDelegateTaskRunner({ guard, hermesRunner, userId });

    const { result } = runner.run(makeInvocation({ agent: "hermes", taskPrompt: "do it" }), "task-1");
    const toolResult = await result;

    expect(toolResult).toEqual({ content: "unknown delegation agent", isError: true });
    expect(hermesRunner.callCount()).toBe(0);
  });

  it("a confirm decision fails closed (no wired UI yet) and never calls hermesRunner", async () => {
    const guard = fakeGuard({ action: "confirm", reason: "task prompt flagged medium risk" });
    const hermesRunner = fakeHermesRunner({ ok: true, output: "should never happen" });
    const runner = createDelegateTaskRunner({ guard, hermesRunner, userId });

    const { result } = runner.run(makeInvocation({ agent: "hermes", taskPrompt: "do it" }), "task-1");
    const toolResult = await result;

    expect(toolResult).toEqual({ content: "task prompt flagged medium risk", isError: true });
    expect(hermesRunner.callCount()).toBe(0);
  });

  it("an allow decision runs hermesRunner and maps a success outcome to isError:false", async () => {
    const guard = fakeGuard({ action: "allow" });
    const hermesRunner = fakeHermesRunner({ ok: true, output: "the final answer" });
    const runner = createDelegateTaskRunner({ guard, hermesRunner, userId });

    const { result } = runner.run(makeInvocation({ agent: "hermes", taskPrompt: "do it" }), "task-1");
    const toolResult = await result;

    expect(toolResult).toEqual({ content: "the final answer", isError: false });
    expect(hermesRunner.callCount()).toBe(1);
    expect(guard.calls).toEqual([{ agent: "hermes", taskPrompt: "do it" }]);
  });

  it("an allow decision maps a hermesRunner failure outcome to isError:true", async () => {
    const guard = fakeGuard({ action: "allow" });
    const hermesRunner = fakeHermesRunner({ ok: false, error: "hermes exited non-zero" });
    const runner = createDelegateTaskRunner({ guard, hermesRunner, userId });

    const { result } = runner.run(makeInvocation({ agent: "hermes", taskPrompt: "do it" }), "task-1");
    const toolResult = await result;

    expect(toolResult).toEqual({ content: "hermes exited non-zero", isError: true });
  });

  it("rejects invalid args without ever evaluating the guard", async () => {
    const guard = fakeGuard({ action: "allow" });
    const hermesRunner = fakeHermesRunner({ ok: true, output: "x" });
    const runner = createDelegateTaskRunner({ guard, hermesRunner, userId });

    const { result } = runner.run(makeInvocation({ agent: "hermes" }), "task-1"); // missing taskPrompt
    const toolResult = await result;

    expect(toolResult.isError).toBe(true);
    expect(guard.calls).toHaveLength(0);
    expect(hermesRunner.callCount()).toBe(0);
  });

  // MINOR 2 hardening: parseArgs validates `agent` against SUPPORTED_AGENTS
  // itself (defense-in-depth alongside DelegationGuard's own frontmatter-map
  // allowlist) — a future N>1-agent state can't route an unsupported agent
  // string to hermesRunner.run just because it type-checks as a string.
  it("rejects an agent outside SUPPORTED_AGENTS without ever evaluating the guard", async () => {
    const guard = fakeGuard({ action: "allow" });
    const hermesRunner = fakeHermesRunner({ ok: true, output: "should never happen" });
    const runner = createDelegateTaskRunner({ guard, hermesRunner, userId });

    const { result } = runner.run(makeInvocation({ agent: "codex", taskPrompt: "do it" }), "task-1");
    const toolResult = await result;

    expect(toolResult.isError).toBe(true);
    expect(guard.calls).toHaveLength(0);
    expect(hermesRunner.callCount()).toBe(0);
  });

  it("cancel() aborts the signal passed into hermesRunner.run", async () => {
    let capturedSignal: AbortSignal | undefined;
    const hermesRunner: HermesRunner = {
      run: (_userId, _prompt, signal) => {
        capturedSignal = signal;
        return new Promise(() => {}); // never settles — cancel() is the assertion, not resolution
      },
    };
    const guard = fakeGuard({ action: "allow" });
    const runner = createDelegateTaskRunner({ guard, hermesRunner, userId });

    const { cancel } = runner.run(makeInvocation({ agent: "hermes", taskPrompt: "do it" }), "task-1");
    await settle(); // the setup phase runs off-turn; the spawn happens after it

    expect(capturedSignal?.aborted).toBe(false);
    cancel();
    expect(capturedSignal?.aborted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Dispatch-time setup phase (task 9g, owner's Correction 1)
// ---------------------------------------------------------------------------
// Task 9d provided the gateway's MCP entry once per user per boot. A user who
// edits their own profile at 10am then got a tool-less delegated agent until the
// next restart — D8's failure mode wearing a fourth hat. Providing it at the
// moment of use makes that drift structurally impossible.

/** Flush every pending microtask AND the timer queue, so assertions can see the
 *  off-turn setup phase complete without racing it. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function fakeExternalTool(outcome: Result<void, ExternalToolError>, log: string[]): ExternalTool {
  return {
    name: "hermes",
    async provide(id) {
      log.push(`provide:${id}`);
      return outcome;
    },
  };
}

function loggingRunner(log: string[], result: HermesRunResult): HermesRunner {
  return {
    async run(id) {
      log.push(`spawn:${id}`);
      return result;
    },
  };
}

describe("delegateTask runner — the dispatch-time setup phase", () => {
  const OK: Result<void, ExternalToolError> = { ok: true, value: undefined };

  // INVARIANT: ordering IS the requirement. Providing after the spawn is the
  // same as not providing at all — hermes reads its MCP config at startup.
  it("verifies and repairs the gateway MCP entry before spawning the agent", async () => {
    const order: string[] = [];
    const runner = createDelegateTaskRunner({
      guard: fakeGuard({ action: "allow" }),
      hermesRunner: loggingRunner(order, { ok: true, output: "done" }),
      userId,
      externalTool: fakeExternalTool(OK, order),
    });

    await runner.run(makeInvocation({ agent: "hermes", taskPrompt: "do it" }), "task-1").result;

    expect(order).toEqual([`provide:${userId}`, `spawn:${userId}`]);
  });

  // INVARIANT: degraded beats broken. A delegated agent with fewer tools still
  // does useful work; one that refuses to run is a user-visible failure caused
  // by our own bookkeeping.
  it("dispatches anyway when providing the entry fails", async () => {
    const order: string[] = [];
    const runner = createDelegateTaskRunner({
      guard: fakeGuard({ action: "allow" }),
      hermesRunner: loggingRunner(order, { ok: true, output: "done" }),
      userId,
      externalTool: fakeExternalTool({ ok: false, error: "cli-error" }, order),
    });

    const toolResult = await runner.run(makeInvocation({ agent: "hermes", taskPrompt: "do it" }), "task-1").result;

    expect(order).toEqual([`provide:${userId}`, `spawn:${userId}`]);
    expect(toolResult).toEqual({ content: "done", isError: false });
  });

  // Same invariant, harsher input: `provide` is contractually non-throwing, but
  // a throw escaping here would reject the runner's result promise and the
  // broker would report the whole delegation as failed.
  it("dispatches anyway when providing the entry throws", async () => {
    const order: string[] = [];
    const runner = createDelegateTaskRunner({
      guard: fakeGuard({ action: "allow" }),
      hermesRunner: loggingRunner(order, { ok: true, output: "done" }),
      userId,
      externalTool: {
        name: "hermes",
        provide() {
          order.push("provide:threw");
          return Promise.reject(new Error("boom"));
        },
      },
    });

    const toolResult = await runner.run(makeInvocation({ agent: "hermes", taskPrompt: "do it" }), "task-1").result;

    expect(order).toEqual(["provide:threw", `spawn:${userId}`]);
    expect(toolResult).toEqual({ content: "done", isError: false });
  });

  // A denied delegation must not touch the user's hermes profile at all.
  it("does not provide anything when the guard denies", async () => {
    const order: string[] = [];
    const runner = createDelegateTaskRunner({
      guard: fakeGuard({ action: "deny", reason: "nope" }),
      hermesRunner: loggingRunner(order, { ok: true, output: "done" }),
      userId,
      externalTool: fakeExternalTool(OK, order),
    });

    await runner.run(makeInvocation({ agent: "hermes", taskPrompt: "do it" }), "task-1").result;

    expect(order).toEqual([]);
  });
});
