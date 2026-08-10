import { describe, expect, it } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import type { UserId } from "../user-auth/user-id.js";
import { type HermesProcess, type SpawnFn, createHermesRunner } from "./hermes-runner.js";

const userId = "u_aaaaaaaa" as UserId;
// `orchestrator.delegation.hermes_delegation_profile`. Deliberately NOT the
// userId: the per-user clones drift (one of three was answering HTTP 401 on
// 2026-07-31 because `--clone-from` copies a credential at a point in time and
// nothing re-syncs it), so a delegation runs on the operator's own profile.
const DELEGATION_PROFILE = "default";

function fakeProcess(overrides: Partial<HermesProcess> = {}): HermesProcess {
  return {
    exited: Promise.resolve(0),
    stdout: "hermes output",
    stderr: "",
    kill: () => {},
    ...overrides,
  };
}

describe("HermesRunner — never spawns a real hermes; spawn is always the injected fake", () => {
  it("runs the delegation profile but keeps the caller's own profile dir as cwd", async () => {
    const calls: Array<{ argv: readonly string[]; cwd: string }> = [];
    const spawn: SpawnFn = (argv, opts) => {
      calls.push({ argv, cwd: opts.cwd });
      return fakeProcess({ stdout: "final answer" });
    };
    const runner = createHermesRunner({
      profile: DELEGATION_PROFILE,
      resolveProfileDir: (u) => `/profiles/${u}`,
      timeoutMs: 5000,
      spawn,
    });

    const result = await runner.run(userId, "summarize my day", new AbortController().signal);

    expect(result).toEqual({ ok: true, output: "final answer" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.cwd).toBe(`/profiles/${userId}`);
    expect(calls[0]?.argv.slice(0, 3)).toEqual(["hermes", "-p", DELEGATION_PROFILE]);
    expect(calls[0]?.argv.slice(-2)).toEqual(["-z", "summarize my day"]);
  });

  it("maps a non-zero exit code to ok:false with the captured stderr", async () => {
    const spawn: SpawnFn = () => fakeProcess({ exited: Promise.resolve(1), stderr: "boom" });
    const runner = createHermesRunner({
      profile: DELEGATION_PROFILE,
      resolveProfileDir: () => "/profiles/x",
      timeoutMs: 5000,
      spawn,
    });

    const result = await runner.run(userId, "do a thing", new AbortController().signal);

    expect(result).toEqual({ ok: false, error: "boom" });
  });

  it("falls back to stdout preview when stderr is empty on a non-zero exit", async () => {
    const spawn: SpawnFn = () => fakeProcess({ exited: Promise.resolve(1), stdout: "partial trace", stderr: "" });
    const runner = createHermesRunner({
      profile: DELEGATION_PROFILE,
      resolveProfileDir: () => "/profiles/x",
      timeoutMs: 5000,
      spawn,
    });

    const result = await runner.run(userId, "do a thing", new AbortController().signal);

    expect(result).toEqual({ ok: false, error: "partial trace" });
  });

  it("kills the process and resolves ok:false when the signal aborts mid-run", async () => {
    let killed = false;
    let resolveExit: (code: number) => void = () => {};
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    const spawn: SpawnFn = () =>
      fakeProcess({
        exited,
        kill: () => {
          killed = true;
          resolveExit(143);
        },
      });
    const runner = createHermesRunner({
      profile: DELEGATION_PROFILE,
      resolveProfileDir: () => "/profiles/x",
      timeoutMs: 5000,
      spawn,
    });

    const controller = new AbortController();
    const pending = runner.run(userId, "a long task", controller.signal);
    controller.abort();
    const result = await pending;

    expect(killed).toBe(true);
    expect(result).toEqual({ ok: false, error: "aborted" });
  });

  it("does not spawn when the signal is already aborted before the call", async () => {
    let spawnCalls = 0;
    const spawn: SpawnFn = () => {
      spawnCalls += 1;
      return fakeProcess();
    };
    const runner = createHermesRunner({
      profile: DELEGATION_PROFILE,
      resolveProfileDir: () => "/profiles/x",
      timeoutMs: 5000,
      spawn,
    });
    const controller = new AbortController();
    controller.abort();

    const result = await runner.run(userId, "task", controller.signal);

    expect(spawnCalls).toBe(0);
    expect(result).toEqual({ ok: false, error: "aborted before start" });
  });

  it("kills the process and resolves ok:false with a timeout reason when the deadline elapses", async () => {
    let killed = false;
    let resolveExit: (code: number) => void = () => {};
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    const spawn: SpawnFn = () =>
      fakeProcess({
        exited,
        kill: () => {
          killed = true;
          resolveExit(124);
        },
      });
    const runner = createHermesRunner({
      profile: DELEGATION_PROFILE,
      resolveProfileDir: () => "/profiles/x",
      timeoutMs: 5,
      spawn,
    });

    const result = await runner.run(userId, "a very long task", new AbortController().signal);

    expect(killed).toBe(true);
    expect(result).toEqual({ ok: false, error: "hermes invocation timed out after 5ms" });
  });

  it("maps a synchronous spawn failure (e.g. ENOENT) to ok:false without throwing", async () => {
    const spawn: SpawnFn = () => {
      throw new Error("spawn hermes ENOENT");
    };
    const runner = createHermesRunner({
      profile: DELEGATION_PROFILE,
      resolveProfileDir: () => "/profiles/x",
      timeoutMs: 5000,
      spawn,
    });

    const result = await runner.run(userId, "task", new AbortController().signal);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("ENOENT");
  });
});

// ---------------------------------------------------------------------------
// WIRE CONTRACT at a process boundary — how a hermes one-shot reports failure.
//
// It does NOT report it through the exit code. Measured 2026-07-31 against
// hermes v0.19.0: a dead profile printed `HTTP 401: User not found.` on stdout,
// wrote NOTHING to stderr, and exited **0**. So `delegate-task` logged
// `run.ok outputLength=26` for a delegation that never ran.
//
// The channel chosen is `--usage-file`, whose own help text promises the report
// "is written even when the run fails". It is the tool's explicit verdict —
// `{"completed": false, "failed": true}` — rather than something inferred, which
// matters because the tempting inference is WRONG: the same run that failed
// produced 26 characters, and a successful `hermes -p default -z "Reply with the
// single word: yes"` produced **3** ("yes"). Output length carries no signal at
// all and no threshold over it can be correct.
// ---------------------------------------------------------------------------

/** Fake hermes that writes the usage report it was asked for, at the path it
 *  was given, exactly as the real CLI does. Keeps the read + unlink path real. */
function spawnWritingUsage(report: unknown, stdout: string): { spawn: SpawnFn; usagePathOf: () => string } {
  let usagePath = "";
  const spawn: SpawnFn = (argv) => {
    const at = argv.indexOf("--usage-file");
    if (at < 0) throw new Error("hermes was spawned without --usage-file, so failure is undetectable");
    usagePath = argv[at + 1] ?? "";
    writeFileSync(usagePath, JSON.stringify(report), "utf8");
    return fakeProcess({ stdout });
  };
  return { spawn, usagePathOf: () => usagePath };
}

describe("HermesRunner — failure is read from the usage report, never from the exit code", () => {
  it("reports a run the report marks failed, even though hermes exited 0", async () => {
    const { spawn } = spawnWritingUsage(
      { api_calls: 1, model: null, completed: false, failed: true },
      "HTTP 401: User not found.",
    );
    const runner = createHermesRunner({
      profile: DELEGATION_PROFILE,
      resolveProfileDir: () => "/profiles/x",
      timeoutMs: 5000,
      spawn,
    });

    const result = await runner.run(userId, "say yes", new AbortController().signal);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("HTTP 401");
  });

  it("keeps a three-character answer a success — output length is not a verdict", async () => {
    const { spawn } = spawnWritingUsage(
      { api_calls: 1, model: "deepseek-v4-flash", completed: true, failed: false },
      "yes",
    );
    const runner = createHermesRunner({
      profile: DELEGATION_PROFILE,
      resolveProfileDir: () => "/profiles/x",
      timeoutMs: 5000,
      spawn,
    });

    expect(await runner.run(userId, "say yes", new AbortController().signal)).toEqual({ ok: true, output: "yes" });
  });

  it("removes the usage report it asked for", async () => {
    const { spawn, usagePathOf } = spawnWritingUsage({ completed: true, failed: false }, "done");
    const runner = createHermesRunner({
      profile: DELEGATION_PROFILE,
      resolveProfileDir: () => "/profiles/x",
      timeoutMs: 5000,
      spawn,
    });

    await runner.run(userId, "task", new AbortController().signal);

    expect(existsSync(usagePathOf())).toBe(false);
  });
});
