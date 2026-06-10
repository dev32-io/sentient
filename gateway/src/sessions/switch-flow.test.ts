import { describe, expect, it, vi } from "vitest";
import { type SwitchFlowState, createSwitchFlow } from "./switch-flow.ts";

const noopMirror = {
  replaceAll: vi.fn(),
} as const;

describe("SwitchFlow", () => {
  it("starts in idle", () => {
    const f = createSwitchFlow({
      mirror: noopMirror,
      cancelCurrentCycle: () => Promise.resolve(),
      fetchHistory: async () => [],
      teardownTimeoutMs: 1000,
    });
    expect(f.state).toBe<SwitchFlowState>("idle");
  });

  it("happy path: idle -> cancelling -> fetching -> rehydrating -> ready", async () => {
    const seen: SwitchFlowState[] = [];
    const f = createSwitchFlow({
      mirror: noopMirror,
      cancelCurrentCycle: async () => {
        seen.push(f.state);
      },
      fetchHistory: async () => {
        seen.push(f.state);
        return [];
      },
      teardownTimeoutMs: 1000,
    });
    await f.switchTo("s1");
    expect(seen).toEqual(["cancelling", "fetching"]);
    expect(f.state).toBe<SwitchFlowState>("ready");
  });

  it("rejects user.message while not idle/ready", async () => {
    const f = createSwitchFlow({
      mirror: noopMirror,
      cancelCurrentCycle: () => new Promise((r) => setTimeout(r, 100)),
      fetchHistory: async () => [],
      teardownTimeoutMs: 1000,
    });
    const inFlight = f.switchTo("s1");
    expect(f.canAcceptUserMessage()).toBe(false);
    await inFlight;
    expect(f.canAcceptUserMessage()).toBe(true);
  });

  it("concurrent switches: latest wins, prior is aborted", async () => {
    const fetched: string[] = [];
    const f = createSwitchFlow({
      mirror: noopMirror,
      cancelCurrentCycle: async () => {},
      fetchHistory: async (id, signal) => {
        await new Promise((r) => setTimeout(r, 50));
        if (signal.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
        fetched.push(id);
        return [];
      },
      teardownTimeoutMs: 1000,
    });
    const a = f.switchTo("first");
    const b = f.switchTo("second");
    await Promise.allSettled([a, b]);
    expect(fetched).toEqual(["second"]);
  });

  it("teardown timeout: aborts wait, proceeds to fetch", async () => {
    const f = createSwitchFlow({
      mirror: noopMirror,
      cancelCurrentCycle: () =>
        new Promise(() => {
          /* never resolves */
        }),
      fetchHistory: async () => [],
      teardownTimeoutMs: 30,
    });
    await f.switchTo("s1");
    expect(f.state).toBe<SwitchFlowState>("ready");
  });

  it("calls mirror.replaceAll with fetched entries", async () => {
    const replaceAll = vi.fn();
    const f = createSwitchFlow({
      mirror: { replaceAll },
      cancelCurrentCycle: async () => {},
      fetchHistory: async () => [{ entryId: "e1", kind: "user", ts: 1, channel: "text", content: "hi" }],
      teardownTimeoutMs: 1000,
    });
    await f.switchTo("s1");
    expect(replaceAll).toHaveBeenCalledOnce();
    expect(replaceAll.mock.calls[0]?.[0]).toHaveLength(1);
  });
});
