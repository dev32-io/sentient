import { describe, expect, it } from "bun:test";
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

  it("cancel() aborts the signal passed into hermesRunner.run", () => {
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

    expect(capturedSignal?.aborted).toBe(false);
    cancel();
    expect(capturedSignal?.aborted).toBe(true);
  });
});
