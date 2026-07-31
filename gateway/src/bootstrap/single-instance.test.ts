import { describe, expect, it } from "vitest";
import { type SingleInstanceIo, acquireSingleInstance } from "./single-instance.ts";

const PATH = "/tmp/test/gateway.pid";

function io(overrides: Partial<SingleInstanceIo> & { store?: Map<string, string> }): SingleInstanceIo {
  const store = overrides.store ?? new Map<string, string>();
  return {
    readClaim: (p) => store.get(p) ?? null,
    writeClaim: (p, b) => void store.set(p, b),
    removeClaim: (p) => void store.delete(p),
    isAlive: () => false,
    now: () => 1_000_000,
    selfPid: 4242,
    ...overrides,
  };
}

describe("acquireSingleInstance", () => {
  // THE invariant: one gateway per machine. Two instances fight over the
  // per-user tool sockets, the SQLite stores and the addon supervisor, and the
  // damage shows up indirectly — never as "two servers are running".
  it("INVARIANT: refuses to start while another instance is alive", () => {
    const store = new Map([[PATH, JSON.stringify({ pid: 99, port: 8888, startedAt: 900_000 })]]);
    const result = acquireSingleInstance(PATH, 8888, io({ store, isAlive: () => true }));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.heldBy.pid).toBe(99);
    // the loser must not clobber the winner's claim on its way out
    expect(JSON.parse(store.get(PATH) as string).pid).toBe(99);
  });

  // A SIGKILL or a crash leaves the file behind. Refusing on mere existence
  // would turn every hard kill into a manual cleanup step.
  it("INVARIANT: takes over a claim whose process is gone", () => {
    const store = new Map([[PATH, JSON.stringify({ pid: 99, port: 8888, startedAt: 900_000 })]]);
    const result = acquireSingleInstance(PATH, 8888, io({ store, isAlive: () => false }));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.tookOverStale).toBe(true);
    expect(JSON.parse(store.get(PATH) as string).pid).toBe(4242);
  });

  // pid 0 and negatives address process GROUPS, and `-0 === 0` in JS, so a
  // sign-flipped 0 signals the caller's own group. A claim holding either is
  // corrupt input, not a live instance — and must never be probed for liveness.
  it("SECURITY: a claim with an implausible pid is corrupt, not a live holder", () => {
    for (const pid of [0, -1, -0]) {
      const store = new Map([[PATH, JSON.stringify({ pid, port: 8888, startedAt: 1 })]]);
      let probed = false;
      const result = acquireSingleInstance(
        PATH,
        8888,
        io({
          store,
          isAlive: () => {
            probed = true;
            return true;
          },
        }),
      );
      expect(result.ok).toBe(true);
      expect(probed).toBe(false);
    }
  });

  it("INVARIANT: release does not delete a claim a successor already wrote", () => {
    const store = new Map<string, string>();
    const result = acquireSingleInstance(PATH, 8888, io({ store }));
    if (!result.ok) throw new Error("unreachable");

    // a successor takes the slot before this process finishes shutting down
    store.set(PATH, JSON.stringify({ pid: 7777, port: 8888, startedAt: 2 }));
    result.release();

    expect(JSON.parse(store.get(PATH) as string).pid).toBe(7777);
  });

  it("INVARIANT: a corrupt claim file does not wedge startup", () => {
    const store = new Map([[PATH, "{not json"]]);
    const result = acquireSingleInstance(PATH, 8888, io({ store }));
    expect(result.ok).toBe(true);
  });
});
