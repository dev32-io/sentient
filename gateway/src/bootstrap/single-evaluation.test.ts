import { describe, expect, it } from "vitest";
import { claimSingleEvaluation, describeHotReloadRefusal } from "./single-evaluation.ts";

const PID = 4242;

describe("claimSingleEvaluation", () => {
  // THE invariant this task exists for. `bun --hot` re-evaluates the module
  // graph INSIDE one process and tears nothing down, so a second evaluation
  // arms a second addon supervisor beside the first. Twelve of them once
  // spawned five whisper-stt children inside 10 ms, signalled each other's
  // children, and left the ports held by processes no supervisor owned.
  //
  // The stamp lives on `globalThis` because that is the only scope that tells
  // the two dev modes apart — measured: `bun --hot` PRESERVES globalThis across
  // reloads (eval count 1,2,3) while `bun --watch` resets it (1,1,1), and the
  // OS pid is identical under both, so a pid comparison cannot see this at all.
  it("INVARIANT: refuses a second evaluation inside one process", () => {
    const scope: Record<PropertyKey, unknown> = {};

    expect(claimSingleEvaluation(scope, PID, 1_000).ok).toBe(true);

    const second = claimSingleEvaluation(scope, PID, 9_000);
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("unreachable");
    expect(second.previous.pid).toBe(PID);
    expect(second.previous.at).toBe(1_000);
  });

  // A fresh process — which is what every `bun --watch` reload and every prod
  // launchd restart is — gets a clean scope and must be waved straight through.
  // Getting this backwards would refuse the supported dev command on its first
  // edit.
  it("INVARIANT: a fresh scope is always admitted", () => {
    for (const pid of [1, PID, 999_999]) {
      expect(claimSingleEvaluation({}, pid, 1_000).ok).toBe(true);
    }
  });

  // The refusal is only useful if the developer can act on it, so it must name
  // the broken command AND the one that replaces it.
  it("names both the offending command and its replacement", () => {
    const message = describeHotReloadRefusal({ pid: PID, at: 1_000 }, 4_000);
    expect(message).toContain("--hot");
    expect(message).toContain("--watch");
    expect(message).toContain(String(PID));
  });
});
