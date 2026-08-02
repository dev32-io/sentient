import { describe, expect, it } from "vitest";
import {
  type ApplyDeps,
  type ApplyOutcome,
  type PendingOp,
  applyButtonLabel,
  isDirty,
  runApply,
} from "./apply-bar-machine.ts";

describe("applyButtonLabel", () => {
  it("returns 'Apply' when all pending ops are fast", () => {
    const pending: PendingOp[] = [{ key: "personalities.active", kind: "fast" }];
    expect(applyButtonLabel(pending)).toBe("Apply");
  });

  it("returns 'Apply' when a pending op is slow too — nothing restarts, so the label doesn't vary", () => {
    const pending: PendingOp[] = [
      { key: "personalities.active", kind: "fast" },
      { key: "profile.voice", kind: "slow" },
    ];
    expect(applyButtonLabel(pending)).toBe("Apply");
  });

  it("returns 'Apply' for empty pending list (degenerate; bar should be hidden in this state)", () => {
    expect(applyButtonLabel([])).toBe("Apply");
  });
});

describe("isDirty", () => {
  it("returns false for empty pending list", () => {
    expect(isDirty([])).toBe(false);
  });

  it("returns true when at least one op is pending", () => {
    expect(isDirty([{ key: "x", kind: "fast" }])).toBe(true);
  });
});

function fakeDeps(overrides?: Partial<ApplyDeps>): ApplyDeps {
  return {
    saveSoul: async () => ({ ok: true, elapsedMs: 50 }),
    saveMemoryDoc: async () => ({ ok: true, elapsedMs: 30 }),
    saveProfile: async () => ({ ok: true, elapsedMs: 80 }),
    savePersonalityActive: async () => ({ ok: true, elapsedMs: 5 }),
    savePersonalityBody: async () => ({ ok: true, elapsedMs: 60 }),
    savePersonalityCreate: async () => ({ ok: true, elapsedMs: 60 }),
    savePersonalityDelete: async () => ({ ok: true, elapsedMs: 40 }),
    waitForRestart: async () => ({ state: "ready", elapsedMs: 1500 }),
    ...overrides,
  };
}

describe("runApply", () => {
  it("emits idle → saving → ready when only fast ops are pending", async () => {
    const states: string[] = [];
    const deps = fakeDeps();
    const outcome: ApplyOutcome = await runApply(
      [{ key: "personalities.active", kind: "fast", payload: { name: "Calm Companion" } }],
      deps,
      (s) => states.push(s.phase),
    );
    expect(states).toEqual(["saving", "ready"]);
    expect(outcome.ok).toBe(true);
  });

  it("emits idle → saving → restarting → ready when any slow op is pending", async () => {
    const states: string[] = [];
    const deps = fakeDeps();
    await runApply(
      [
        { key: "personalities.active", kind: "fast", payload: { name: "X" } },
        { key: "profile.voice", kind: "slow", payload: { voice: "Hazel" } },
      ],
      deps,
      (s) => states.push(s.phase),
    );
    expect(states).toEqual(["saving", "restarting", "ready"]);
  });

  it("emits failed when a save returns ok=false", async () => {
    const states: string[] = [];
    const deps = fakeDeps({
      saveProfile: async () => ({ ok: false, errorMessage: "network error" }),
    });
    const outcome = await runApply([{ key: "profile.voice", kind: "slow", payload: { voice: "Hazel" } }], deps, (s) =>
      states.push(s.phase),
    );
    expect(outcome.ok).toBe(false);
    expect(states[states.length - 1]).toBe("failed");
  });

  it("emits failed when waitForRestart returns failed", async () => {
    const states: string[] = [];
    const deps = fakeDeps({
      waitForRestart: async () => ({ state: "failed", elapsedMs: 30000 }),
    });
    const outcome = await runApply([{ key: "profile.voice", kind: "slow", payload: { voice: "Hazel" } }], deps, (s) =>
      states.push(s.phase),
    );
    expect(outcome.ok).toBe(false);
    expect(states[states.length - 1]).toBe("failed");
  });
});
