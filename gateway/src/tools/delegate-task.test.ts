import { describe, expect, it } from "bun:test";
import type { Result } from "@sentient/protocol";
import { type ExternalToolSlot, createExternalToolSlot } from "../external-tools/external-tool-slot.js";
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

  // -------------------------------------------------------------------------
  // THE CONTRACT (CLAUDE.md, spec §4.7): a background task OUTLIVES the turn
  // that spawned it, in every case.
  //
  // The runner used to subscribe its controller to `inv.signal`, which
  // react-loop.ts builds from the TURN's `AbortController`. Barge-in aborts the
  // turn — so barge-in killed the delegation, in flat contradiction of the
  // documented contract, and interrupt killed it twice over. The old guard
  // asserted `cancelAll()` was not called; that was true and irrelevant,
  // because the task died down the other path. These two pin the PROPERTY.
  // -------------------------------------------------------------------------

  it("INVARIANT: aborting the TURN does not abort the delegation — barge-in leaves it running", async () => {
    const turn = new AbortController();
    let capturedSignal: AbortSignal | undefined;
    const hermesRunner: HermesRunner = {
      run: (_userId, _prompt, signal) => {
        capturedSignal = signal;
        return new Promise(() => {}); // never settles — the worker is still working
      },
    };
    const runner = createDelegateTaskRunner({ guard: fakeGuard({ action: "allow" }), hermesRunner, userId });

    runner.run(makeInvocation({ agent: "hermes", taskPrompt: "do it" }, turn.signal), "task-1");
    await settle();

    turn.abort();

    expect(capturedSignal?.aborted).toBe(false);
  });

  it("INVARIANT: a turn aborted BEFORE the spawn still spawns — the task was already the turn's successor", async () => {
    // The abort can land inside the off-turn setup phase, before hermes is
    // ever exec'd. Skipping the spawn there would make the contract hold only
    // for delegations lucky enough to have started.
    const order: string[] = [];
    const turn = new AbortController();
    const slot = createExternalToolSlot();
    const runner = createDelegateTaskRunner({
      guard: fakeGuard({ action: "allow" }),
      hermesRunner: loggingRunner(order, { ok: true, output: "done" }),
      userId,
      externalTool: slot,
    });

    const { result } = runner.run(makeInvocation({ agent: "hermes", taskPrompt: "do it" }, turn.signal), "task-1");
    await settle();
    turn.abort();
    slot.set(fakeExternalTool({ ok: true, value: undefined }, order));

    expect(await result).toEqual({ content: "done", isError: false });
    expect(order).toEqual([`provide:${userId}`, `spawn:${userId}`]);
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

/** The steady state after boot: a real slot, already settled with `tool`. */
function settledSlot(tool: ExternalTool): ExternalToolSlot {
  const slot = createExternalToolSlot();
  slot.set(tool);
  return slot;
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
      externalTool: settledSlot(fakeExternalTool(OK, order)),
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
      externalTool: settledSlot(fakeExternalTool({ ok: false, error: "cli-error" }, order)),
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
      externalTool: settledSlot({
        name: "hermes",
        provide() {
          order.push("provide:threw");
          return Promise.reject(new Error("boom"));
        },
      }),
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
      externalTool: settledSlot(fakeExternalTool(OK, order)),
    });

    await runner.run(makeInvocation({ agent: "hermes", taskPrompt: "do it" }), "task-1").result;

    expect(order).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Boot ordering — the slot is read at DISPATCH, never snapshotted per session
// ---------------------------------------------------------------------------
// `Bun.serve()` accepts connections synchronously, and a connection is what
// builds this runner. An earlier shape captured `slot.get()` once, at session
// creation: a client that reconnected inside the gateway's boot window baked a
// permanent `null` into its runner and every delegation on that socket silently
// skipped verify-and-repair for the life of the session, with no self-heal.
// These pin the read side of that fix; `main.ts` closes the window itself by
// settling the slot before it starts serving.

describe("delegateTask runner — the external tool is resolved per dispatch", () => {
  const OK: Result<void, ExternalToolError> = { ok: true, value: undefined };

  // INVARIANT: a session built before boot settled the slot still provides.
  it("waits for an unsettled slot rather than dispatching as if there were no external tool", async () => {
    const order: string[] = [];
    const slot = createExternalToolSlot();
    const runner = createDelegateTaskRunner({
      guard: fakeGuard({ action: "allow" }),
      hermesRunner: loggingRunner(order, { ok: true, output: "done" }),
      userId,
      externalTool: slot,
    });

    const { result } = runner.run(makeInvocation({ agent: "hermes", taskPrompt: "do it" }), "task-1");
    await settle();
    expect(order).toEqual([]); // neither provided nor spawned while the slot is pending

    slot.set(fakeExternalTool(OK, order));
    await result;

    expect(order).toEqual([`provide:${userId}`, `spawn:${userId}`]);
  });

  // INVARIANT: every boot path settles, so "no external tool in this config"
  // is a fast null and never an indefinite wait.
  it("dispatches immediately when boot sealed the slot empty", async () => {
    const order: string[] = [];
    const slot = createExternalToolSlot();
    slot.sealEmpty("no hermes: block in this configuration");
    const runner = createDelegateTaskRunner({
      guard: fakeGuard({ action: "allow" }),
      hermesRunner: loggingRunner(order, { ok: true, output: "done" }),
      userId,
      externalTool: slot,
    });

    const toolResult = await runner.run(makeInvocation({ agent: "hermes", taskPrompt: "do it" }), "task-1").result;

    expect(order).toEqual([`spawn:${userId}`]);
    expect(toolResult).toEqual({ content: "done", isError: false });
  });

  // INVARIANT: the wait is cancellable. A wedged boot must never become a
  // delegation that cannot be aborted.
  it("stops waiting on a slot that never settles when the delegation is cancelled", async () => {
    const order: string[] = [];
    const runner = createDelegateTaskRunner({
      guard: fakeGuard({ action: "allow" }),
      hermesRunner: loggingRunner(order, { ok: true, output: "done" }),
      userId,
      externalTool: createExternalToolSlot(), // never settled
    });

    const { cancel, result } = runner.run(makeInvocation({ agent: "hermes", taskPrompt: "do it" }), "task-1");
    await settle();
    expect(order).toEqual([]);

    cancel();
    await result;

    expect(order).toEqual([`spawn:${userId}`]); // released, and the profile was never touched
  });
});
