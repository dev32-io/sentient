import { describe, expect, it } from "bun:test";
import type { UserId } from "../user-auth/user-id.js";
import { type HermesProcess, type SpawnFn, createHermesRunner } from "./hermes-runner.js";

const userId = "u_aaaaaaaa" as UserId;

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
  it("maps a zero exit code to ok:true, capturing stdout, using the -p/-z argv shape", async () => {
    const calls: Array<{ argv: readonly string[]; cwd: string }> = [];
    const spawn: SpawnFn = (argv, opts) => {
      calls.push({ argv, cwd: opts.cwd });
      return fakeProcess({ stdout: "final answer" });
    };
    const runner = createHermesRunner({ resolveProfileDir: (u) => `/profiles/${u}`, timeoutMs: 5000, spawn });

    const result = await runner.run(userId, "summarize my day", new AbortController().signal);

    expect(result).toEqual({ ok: true, output: "final answer" });
    expect(calls).toEqual([{ argv: ["hermes", "-p", userId, "-z", "summarize my day"], cwd: `/profiles/${userId}` }]);
  });

  it("maps a non-zero exit code to ok:false with the captured stderr", async () => {
    const spawn: SpawnFn = () => fakeProcess({ exited: Promise.resolve(1), stderr: "boom" });
    const runner = createHermesRunner({ resolveProfileDir: () => "/profiles/x", timeoutMs: 5000, spawn });

    const result = await runner.run(userId, "do a thing", new AbortController().signal);

    expect(result).toEqual({ ok: false, error: "boom" });
  });

  it("falls back to stdout preview when stderr is empty on a non-zero exit", async () => {
    const spawn: SpawnFn = () => fakeProcess({ exited: Promise.resolve(1), stdout: "partial trace", stderr: "" });
    const runner = createHermesRunner({ resolveProfileDir: () => "/profiles/x", timeoutMs: 5000, spawn });

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
    const runner = createHermesRunner({ resolveProfileDir: () => "/profiles/x", timeoutMs: 5000, spawn });

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
    const runner = createHermesRunner({ resolveProfileDir: () => "/profiles/x", timeoutMs: 5000, spawn });
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
    const runner = createHermesRunner({ resolveProfileDir: () => "/profiles/x", timeoutMs: 5, spawn });

    const result = await runner.run(userId, "a very long task", new AbortController().signal);

    expect(killed).toBe(true);
    expect(result).toEqual({ ok: false, error: "hermes invocation timed out after 5ms" });
  });

  it("maps a synchronous spawn failure (e.g. ENOENT) to ok:false without throwing", async () => {
    const spawn: SpawnFn = () => {
      throw new Error("spawn hermes ENOENT");
    };
    const runner = createHermesRunner({ resolveProfileDir: () => "/profiles/x", timeoutMs: 5000, spawn });

    const result = await runner.run(userId, "task", new AbortController().signal);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("ENOENT");
  });
});
