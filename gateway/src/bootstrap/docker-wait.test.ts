import { describe, expect, it } from "bun:test";
import { waitForDocker } from "./docker-wait.js";

/** A fake docker pinger that tracks calls and returns canned outcomes. */
class FakePinger {
  readonly calls: number[] = [];
  private outcomes: Array<unknown | Error>;

  constructor(outcomes: Array<unknown | Error>) {
    this.outcomes = outcomes;
  }

  ping(): Promise<unknown> {
    this.calls.push(this.calls.length);
    const outcome = this.outcomes[Math.min(this.calls.length - 1, this.outcomes.length - 1)];
    if (outcome instanceof Error) return Promise.reject(outcome);
    return Promise.resolve(outcome);
  }
}

describe("waitForDocker", () => {
  it("resolves immediately (true) when ping succeeds on the first attempt", async () => {
    const docker = new FakePinger(["OK"]);
    const result = await waitForDocker({ docker, timeoutMs: 5000, pollMs: 100 });
    expect(result).toBe(true);
    expect(docker.calls.length).toBe(1);
  });

  it("resolves after N polls when ping fails then succeeds", async () => {
    const docker = new FakePinger([new Error("connect ECONNREFUSED"), new Error("connect ECONNREFUSED"), "OK"]);
    const result = await waitForDocker({ docker, timeoutMs: 5000, pollMs: 10 });
    expect(result).toBe(true);
    expect(docker.calls.length).toBe(3);
  });

  it("times out and returns false when ping always fails", async () => {
    const docker = new FakePinger([new Error("no daemon")]);
    // Short real timeout so the test is fast but exercises the loop.
    const result = await waitForDocker({ docker, timeoutMs: 50, pollMs: 10 });
    expect(result).toBe(false);
    expect(docker.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("returns true immediately with no ping when timeout is 0 (skip)", async () => {
    const docker = new FakePinger(["OK"]);
    const result = await waitForDocker({ docker, timeoutMs: 0, pollMs: 100 });
    expect(result).toBe(true);
    expect(docker.calls.length).toBe(0);
  });

  it("never throws — a ping that rejects is swallowed, not propagated", async () => {
    const docker = new FakePinger([new Error("fatal socket error")]);
    const result = await waitForDocker({ docker, timeoutMs: 30, pollMs: 10 });
    expect(result).toBe(false);
  });
});
