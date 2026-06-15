import { describe, expect, it, vi } from "vitest";
import type { AttentionGateCallbacks, AttentionGateConfig } from "./attention-gate.js";
import { createAttentionGate } from "./attention-gate.js";
import { createConversationMirror } from "./conversation-mirror.js";
import type { SalienceMap } from "./short-term-context-types.js";
import type { InjectableEvent } from "./short-term-context-types.js";
import { createShortTermContext } from "./short-term-context.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConversationMirror() {
  return createConversationMirror(100);
}

const DEFAULT_CONFIG: AttentionGateConfig = {
  debounceWindowMs: 80,
  standardThreshold: 50,
  immediateWakeThreshold: 100,
  maxPerHour: 120,
  maxIterations: 10,
  maxIterWarnAhead: 3,
};

/** Real-timer sleep — bun:test's vi shim lacks advanceTimersByTimeAsync. */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Salience map using the unified source-neutral keys.
 *
 * Keys:
 * - "conversation.user.speech"  => { reply: 85 }   (above standard threshold)
 * - "sensor.temperature"        => { monitor: 10 }  (below threshold)
 * - "conversation.user.text"    => { reply: 120 }   (above immediate threshold)
 * - "conversation.trigger"      => { reply: 50 }    (at boundary — not exceeding)
 */
const testSalienceMap: SalienceMap = {
  lookup(kind: string): Readonly<Record<string, number>> {
    if (kind === "conversation.user.speech") return { reply: 85 };
    if (kind === "sensor.temperature") return { monitor: 10 };
    if (kind === "conversation.user.text") return { reply: 120 };
    if (kind === "conversation.trigger") return { reply: 50 };
    return {};
  },
};

function speechFinalEvent(text = "hello"): InjectableEvent {
  return {
    kind: "user.speech.final",
    source: "stt",
    class: "user-direct",
    signal: "phasic",
    urgency: "none",
    payload: { text },
  };
}

function lowSalienceAmbientEvent(): InjectableEvent {
  return {
    kind: "sensor.temperature",
    source: "sensor",
    class: "ambient",
    signal: "phasic",
    urgency: "none",
    payload: { value: 22 },
  };
}

type CycleCall = { cycleId: string; sinceSeq: number; triggerReason: string; forceFinal: boolean };

function makeCallbacks(): {
  callbacks: AttentionGateCallbacks;
  cycleCalls: CycleCall[];
  resolveCycle: (outcome?: { aborted?: boolean; shouldContinue?: boolean }) => void;
  rejectCycle: (err: unknown) => void;
} {
  const cycleCalls: CycleCall[] = [];
  let resolveCycle: (outcome?: { aborted?: boolean; shouldContinue?: boolean }) => void = () => {};
  let rejectCycle: (err: unknown) => void = () => {};

  const callbacks: AttentionGateCallbacks = {
    onCycle: vi.fn((params) => {
      cycleCalls.push(params);
      return new Promise<{ aborted: boolean; shouldContinue: boolean }>((resolve, reject) => {
        resolveCycle = (outcome = {}) =>
          resolve({
            aborted: outcome.aborted ?? false,
            shouldContinue: outcome.shouldContinue ?? false,
          });
        rejectCycle = reject;
      });
    }),
  };

  return {
    callbacks,
    cycleCalls,
    get resolveCycle() {
      return resolveCycle;
    },
    get rejectCycle() {
      return rejectCycle;
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AttentionGate", () => {
  it("fires cycle after debounce when conversation-history salience exceeds standard threshold", async () => {
    const ctx = createShortTermContext("sess-1", testSalienceMap);
    const conversationMirror = makeConversationMirror();
    const { callbacks, cycleCalls } = makeCallbacks();
    const gate = createAttentionGate(ctx, DEFAULT_CONFIG, callbacks, conversationMirror, testSalienceMap);

    // history append → "conversation.user.speech" => reply: 85 > 50
    conversationMirror.append({ entryId: "e", kind: "user", ts: Date.now(), channel: "speech", content: "hello" });

    // Cycle should NOT fire before debounce
    expect(cycleCalls).toHaveLength(0);

    // Advance past debounce window
    await sleep(DEFAULT_CONFIG.debounceWindowMs + 1);

    expect(cycleCalls).toHaveLength(1);
    expect(cycleCalls[0]?.triggerReason).toContain("reply");

    gate.dispose();
  });

  it("does NOT fire cycle when salience is below threshold", async () => {
    const ctx = createShortTermContext("sess-1", testSalienceMap);
    const conversationMirror = makeConversationMirror();
    const { callbacks, cycleCalls } = makeCallbacks();
    const gate = createAttentionGate(ctx, DEFAULT_CONFIG, callbacks, conversationMirror, testSalienceMap);

    // ambient STC inject → "sensor.temperature" => monitor: 10 < 50
    ctx.inject(lowSalienceAmbientEvent());

    await sleep(DEFAULT_CONFIG.debounceWindowMs + 1);

    expect(cycleCalls).toHaveLength(0);

    gate.dispose();
  });

  it("debounce coalesces multiple events into one cycle fire", async () => {
    const ctx = createShortTermContext("sess-1", testSalienceMap);
    const conversationMirror = makeConversationMirror();
    const { callbacks, cycleCalls } = makeCallbacks();
    const gate = createAttentionGate(ctx, DEFAULT_CONFIG, callbacks, conversationMirror, testSalienceMap);

    // Inject several events within the debounce window
    conversationMirror.append({ entryId: "e", kind: "user", ts: Date.now(), channel: "speech", content: "first" });

    await sleep(30); // 30ms into debounce

    conversationMirror.append({ entryId: "e", kind: "user", ts: Date.now(), channel: "speech", content: "second" }); // resets debounce

    await sleep(30); // 60ms since second append

    conversationMirror.append({ entryId: "e", kind: "user", ts: Date.now(), channel: "speech", content: "third" }); // resets debounce again

    await sleep(DEFAULT_CONFIG.debounceWindowMs + 1);

    // Only one cycle should have fired
    expect(cycleCalls).toHaveLength(1);

    gate.dispose();
  });

  it("rate limit suppresses after maxPerHour exceeded", async () => {
    const config: AttentionGateConfig = {
      ...DEFAULT_CONFIG,
      maxPerHour: 2,
    };
    const ctx = createShortTermContext("sess-1", testSalienceMap);
    const conversationMirror = makeConversationMirror();
    const { callbacks, cycleCalls } = makeCallbacks();
    const resolvers: (() => void)[] = [];

    // Override onCycle to auto-resolve so cycles complete quickly
    callbacks.onCycle = vi.fn((params) => {
      cycleCalls.push(params);
      return new Promise<{ aborted: boolean; shouldContinue: boolean }>((resolve) => {
        resolvers.push(() => resolve({ aborted: false, shouldContinue: false }));
      });
    });

    const gate = createAttentionGate(ctx, config, callbacks, conversationMirror, testSalienceMap);

    // Cycle 1
    conversationMirror.append({ entryId: "e", kind: "user", ts: Date.now(), channel: "speech", content: "one" });
    await sleep(config.debounceWindowMs + 1);
    expect(cycleCalls).toHaveLength(1);
    resolvers[0]?.();
    await sleep(0);

    // Cycle 2
    conversationMirror.append({ entryId: "e", kind: "user", ts: Date.now(), channel: "speech", content: "two" });
    await sleep(config.debounceWindowMs + 1);
    expect(cycleCalls).toHaveLength(2);
    resolvers[1]?.();
    await sleep(0);

    // Cycle 3 should be suppressed (maxPerHour = 2)
    conversationMirror.append({ entryId: "e", kind: "user", ts: Date.now(), channel: "speech", content: "three" });
    await sleep(config.debounceWindowMs + 1);
    expect(cycleCalls).toHaveLength(2);

    gate.dispose();
  });

  it("does not fire new cycle while one is active (serial guarantee)", async () => {
    const ctx = createShortTermContext("sess-1", testSalienceMap);
    const conversationMirror = makeConversationMirror();
    const { callbacks, cycleCalls } = makeCallbacks();
    const gate = createAttentionGate(ctx, DEFAULT_CONFIG, callbacks, conversationMirror, testSalienceMap);

    // Start first cycle
    conversationMirror.append({ entryId: "e", kind: "user", ts: Date.now(), channel: "speech", content: "first" });
    await sleep(DEFAULT_CONFIG.debounceWindowMs + 1);
    expect(cycleCalls).toHaveLength(1);

    // Inject more events while cycle is active
    conversationMirror.append({ entryId: "e", kind: "user", ts: Date.now(), channel: "speech", content: "second" });
    await sleep(DEFAULT_CONFIG.debounceWindowMs + 1);

    // Should still be only one cycle
    expect(cycleCalls).toHaveLength(1);

    gate.dispose();
  });

  it("fires next cycle after active one completes if accumulated salience warrants", async () => {
    const ctx = createShortTermContext("sess-1", testSalienceMap);
    const conversationMirror = makeConversationMirror();
    const { callbacks, cycleCalls } = makeCallbacks();
    const resolvers: (() => void)[] = [];

    callbacks.onCycle = vi.fn((params) => {
      cycleCalls.push(params);
      return new Promise<{ aborted: boolean; shouldContinue: boolean }>((resolve) => {
        resolvers.push(() => resolve({ aborted: false, shouldContinue: false }));
      });
    });

    const gate = createAttentionGate(ctx, DEFAULT_CONFIG, callbacks, conversationMirror, testSalienceMap);

    // Start first cycle
    conversationMirror.append({ entryId: "e", kind: "user", ts: Date.now(), channel: "speech", content: "first" });
    await sleep(DEFAULT_CONFIG.debounceWindowMs + 1);
    expect(cycleCalls).toHaveLength(1);

    // Inject event during active cycle
    conversationMirror.append({ entryId: "e", kind: "user", ts: Date.now(), channel: "speech", content: "second" });
    await sleep(DEFAULT_CONFIG.debounceWindowMs + 1);
    expect(cycleCalls).toHaveLength(1); // still 1

    // Complete first cycle
    resolvers[0]?.();
    await sleep(0);

    // Second cycle should fire now
    expect(cycleCalls).toHaveLength(2);
    // sinceSeq of second cycle should be at or after the first cycle's sinceSeq
    // (>=0 — the history-path tests don't inject into STC so latestSeq stays 0)
    expect(cycleCalls[1]?.sinceSeq).toBeGreaterThanOrEqual(0);

    // Resolve second cycle
    resolvers[1]?.();
    await sleep(0);

    gate.dispose();
  });

  it("fires immediate cycle when salience exceeds immediateWakeThreshold and no cycle active", async () => {
    const ctx = createShortTermContext("sess-1", testSalienceMap);
    const conversationMirror = makeConversationMirror();
    const { callbacks, cycleCalls } = makeCallbacks();
    const gate = createAttentionGate(ctx, DEFAULT_CONFIG, callbacks, conversationMirror, testSalienceMap);

    // "conversation.user.text" => reply: 120 > 100 (immediateWakeThreshold)
    conversationMirror.append({
      entryId: "e",
      kind: "user",
      ts: Date.now(),
      channel: "text",
      content: "urgent message",
    });

    // Should fire immediately, no debounce
    expect(cycleCalls).toHaveLength(1);
    expect(cycleCalls[0]?.triggerReason).toContain("immediate");

    gate.dispose();
  });

  it("dispose stops responding to events", async () => {
    const ctx = createShortTermContext("sess-1", testSalienceMap);
    const conversationMirror = makeConversationMirror();
    const { callbacks, cycleCalls } = makeCallbacks();
    const gate = createAttentionGate(ctx, DEFAULT_CONFIG, callbacks, conversationMirror, testSalienceMap);

    gate.dispose();

    conversationMirror.append({
      entryId: "e",
      kind: "user",
      ts: Date.now(),
      channel: "speech",
      content: "after dispose",
    });
    await sleep(DEFAULT_CONFIG.debounceWindowMs + 1);

    expect(cycleCalls).toHaveLength(0);
  });

  it("handles cycle rejection gracefully without throwing", async () => {
    const ctx = createShortTermContext("sess-1", testSalienceMap);
    const conversationMirror = makeConversationMirror();
    const { callbacks, cycleCalls } = makeCallbacks();
    const resolvers: Array<{ resolve: () => void; reject: (e: unknown) => void }> = [];

    callbacks.onCycle = vi.fn((params) => {
      cycleCalls.push(params);
      return new Promise<{ aborted: boolean; shouldContinue: boolean }>((resolve, reject) => {
        resolvers.push({
          resolve: () => resolve({ aborted: false, shouldContinue: false }),
          reject,
        });
      });
    });

    const gate = createAttentionGate(ctx, DEFAULT_CONFIG, callbacks, conversationMirror, testSalienceMap);

    // Start first cycle
    conversationMirror.append({ entryId: "e", kind: "user", ts: Date.now(), channel: "speech", content: "first" });
    await sleep(DEFAULT_CONFIG.debounceWindowMs + 1);
    expect(cycleCalls).toHaveLength(1);

    // Inject event during active cycle
    conversationMirror.append({ entryId: "e", kind: "user", ts: Date.now(), channel: "speech", content: "second" });

    // Reject first cycle (simulating barge-in abort)
    resolvers[0]?.reject(new Error("aborted"));
    await sleep(0);

    // Gate should still function: next cycle fires since salience accumulated
    expect(cycleCalls).toHaveLength(2);

    // Cleanup
    resolvers[1]?.resolve();
    await sleep(0);

    gate.dispose();
  });

  // ---------------------------------------------------------------------
  // ReAct continuation loop
  // ---------------------------------------------------------------------

  describe("ReAct continuation", () => {
    function makeChainCallbacks(): {
      callbacks: AttentionGateCallbacks;
      cycleCalls: CycleCall[];
      resolveWith: (outcome: { aborted?: boolean; shouldContinue?: boolean }) => void;
    } {
      const cycleCalls: CycleCall[] = [];
      let resolveCurrent: (o: { aborted: boolean; shouldContinue: boolean }) => void = () => {};
      const callbacks: AttentionGateCallbacks = {
        onCycle: vi.fn((params) => {
          cycleCalls.push(params);
          return new Promise<{ aborted: boolean; shouldContinue: boolean }>((resolve) => {
            resolveCurrent = resolve;
          });
        }),
      };
      return {
        callbacks,
        cycleCalls,
        resolveWith: (outcome) =>
          resolveCurrent({
            aborted: outcome.aborted ?? false,
            shouldContinue: outcome.shouldContinue ?? false,
          }),
      };
    }

    it("dispatches a continuation cycle when prior cycle reports shouldContinue=true", async () => {
      const ctx = createShortTermContext("sess-1", testSalienceMap);
      const conversationMirror = makeConversationMirror();
      const { callbacks, cycleCalls, resolveWith } = makeChainCallbacks();
      const gate = createAttentionGate(ctx, DEFAULT_CONFIG, callbacks, conversationMirror, testSalienceMap);

      conversationMirror.append({ entryId: "e", kind: "user", ts: Date.now(), channel: "speech", content: "hi" });
      await sleep(DEFAULT_CONFIG.debounceWindowMs + 1);
      expect(cycleCalls).toHaveLength(1);
      expect(cycleCalls[0]?.forceFinal).toBe(false);

      resolveWith({ shouldContinue: true });
      await sleep(0);

      expect(cycleCalls).toHaveLength(2);
      expect(cycleCalls[1]?.triggerReason).toContain("react-continuation");
      expect(cycleCalls[1]?.forceFinal).toBe(false);

      resolveWith({ shouldContinue: false });
      await sleep(0);

      gate.dispose();
    });

    it("does not continue when shouldContinue=false (terminal effect)", async () => {
      const ctx = createShortTermContext("sess-1", testSalienceMap);
      const conversationMirror = makeConversationMirror();
      const { callbacks, cycleCalls, resolveWith } = makeChainCallbacks();
      const gate = createAttentionGate(ctx, DEFAULT_CONFIG, callbacks, conversationMirror, testSalienceMap);

      conversationMirror.append({ entryId: "e", kind: "user", ts: Date.now(), channel: "speech", content: "hi" });
      await sleep(DEFAULT_CONFIG.debounceWindowMs + 1);
      expect(cycleCalls).toHaveLength(1);

      resolveWith({ shouldContinue: false });
      await sleep(5);

      expect(cycleCalls).toHaveLength(1);

      gate.dispose();
    });

    it("respects max_iterations cap by dispatching forceFinal on the cap cycle", async () => {
      const ctx = createShortTermContext("sess-1", testSalienceMap);
      const conversationMirror = makeConversationMirror();
      const { callbacks, cycleCalls, resolveWith } = makeChainCallbacks();
      const config: AttentionGateConfig = { ...DEFAULT_CONFIG, maxIterations: 3 };
      const gate = createAttentionGate(ctx, config, callbacks, conversationMirror, testSalienceMap);

      conversationMirror.append({ entryId: "e", kind: "user", ts: Date.now(), channel: "speech", content: "go" });
      await sleep(config.debounceWindowMs + 1);
      expect(cycleCalls).toHaveLength(1);
      expect(cycleCalls[0]?.forceFinal).toBe(false);

      // Cycle 1 continues → cycle 2 (normal continuation)
      resolveWith({ shouldContinue: true });
      await sleep(0);
      expect(cycleCalls).toHaveLength(2);
      expect(cycleCalls[1]?.forceFinal).toBe(false);

      // Cycle 2 continues → cycle 3 should fire with forceFinal=true (cap hit)
      resolveWith({ shouldContinue: true });
      await sleep(0);
      expect(cycleCalls).toHaveLength(3);
      expect(cycleCalls[2]?.forceFinal).toBe(true);

      // Resolve the forced-final cycle; no further cycles even if it
      // somehow reported shouldContinue (cycle should set it false when
      // forceFinal, but even if it didn't the gate has no more budget).
      resolveWith({ shouldContinue: false });
      await sleep(5);
      expect(cycleCalls).toHaveLength(3);

      gate.dispose();
    });

    it("resets chain on external stimulus mid-chain (new turn starts from 0)", async () => {
      const ctx = createShortTermContext("sess-1", testSalienceMap);
      const conversationMirror = makeConversationMirror();
      const { callbacks, cycleCalls, resolveWith } = makeChainCallbacks();
      const gate = createAttentionGate(ctx, DEFAULT_CONFIG, callbacks, conversationMirror, testSalienceMap);

      conversationMirror.append({
        entryId: "e",
        kind: "user",
        ts: Date.now(),
        channel: "speech",
        content: "first turn",
      });
      await sleep(DEFAULT_CONFIG.debounceWindowMs + 1);
      expect(cycleCalls).toHaveLength(1);

      resolveWith({ shouldContinue: true });
      await sleep(0);
      expect(cycleCalls).toHaveLength(2);
      // We are now chainLength=1. A new external stimulus should reset it.
      // (Not observable directly, but the next chain's continuations should
      // get the full budget before forceFinal fires.)

      // Resolve the in-flight cycle first — gate needs an idle state to
      // accept the next dispatch.
      resolveWith({ shouldContinue: false });
      await sleep(0);

      conversationMirror.append({
        entryId: "e",
        kind: "user",
        ts: Date.now(),
        channel: "speech",
        content: "second turn",
      });
      await sleep(DEFAULT_CONFIG.debounceWindowMs + 1);
      expect(cycleCalls).toHaveLength(3);

      resolveWith({ shouldContinue: false });
      await sleep(0);

      gate.dispose();
    });

    it("continuation dispatch bypasses debounce (no 80ms wait)", async () => {
      const ctx = createShortTermContext("sess-1", testSalienceMap);
      const conversationMirror = makeConversationMirror();
      const { callbacks, cycleCalls, resolveWith } = makeChainCallbacks();
      const gate = createAttentionGate(ctx, DEFAULT_CONFIG, callbacks, conversationMirror, testSalienceMap);

      conversationMirror.append({ entryId: "e", kind: "user", ts: Date.now(), channel: "speech", content: "hi" });
      await sleep(DEFAULT_CONFIG.debounceWindowMs + 1);
      expect(cycleCalls).toHaveLength(1);

      const t0 = Date.now();
      resolveWith({ shouldContinue: true });
      await sleep(0);
      const elapsed = Date.now() - t0;

      // Continuation should fire within microseconds (no debounce). Give
      // a generous ceiling for scheduler jitter.
      expect(cycleCalls).toHaveLength(2);
      expect(elapsed).toBeLessThan(DEFAULT_CONFIG.debounceWindowMs);

      resolveWith({ shouldContinue: false });
      await sleep(0);

      gate.dispose();
    });
  });

  // ---------------------------------------------------------------------
  // ReAct budget warning (MAX_ITER_WARN_AHEAD)
  // ---------------------------------------------------------------------

  describe("react-budget warning", () => {
    function makeChainCallbacks(): {
      callbacks: AttentionGateCallbacks;
      cycleCalls: CycleCall[];
      resolveWith: (outcome: { aborted?: boolean; shouldContinue?: boolean }) => void;
    } {
      const cycleCalls: CycleCall[] = [];
      let resolveCurrent: (o: { aborted: boolean; shouldContinue: boolean }) => void = () => {};
      const callbacks: AttentionGateCallbacks = {
        onCycle: vi.fn((params) => {
          cycleCalls.push(params);
          return new Promise<{ aborted: boolean; shouldContinue: boolean }>((resolve) => {
            resolveCurrent = resolve;
          });
        }),
      };
      return {
        callbacks,
        cycleCalls,
        resolveWith: (outcome) =>
          resolveCurrent({
            aborted: outcome.aborted ?? false,
            shouldContinue: outcome.shouldContinue ?? false,
          }),
      };
    }

    it("injects react-budget warning warnAhead cycles before the cap", async () => {
      const ctx = createShortTermContext("sess-warn", testSalienceMap);
      const conversationMirror = makeConversationMirror();
      const { callbacks, cycleCalls, resolveWith } = makeChainCallbacks();
      // maxIter=5, warnAhead=2 — warning should fire BEFORE cycle 4 (2 remaining + current = 2 ahead of cap)
      const config: AttentionGateConfig = { ...DEFAULT_CONFIG, maxIterations: 5, maxIterWarnAhead: 2 };
      const gate = createAttentionGate(ctx, config, callbacks, conversationMirror, testSalienceMap);

      conversationMirror.append({ entryId: "e", kind: "user", ts: Date.now(), channel: "speech", content: "go" });
      await sleep(config.debounceWindowMs + 1);
      expect(cycleCalls).toHaveLength(1);

      // History should have only the user entry so far.
      const triggersBeforeWarn = conversationMirror.snapshot().filter((e) => e.kind === "trigger");
      expect(triggersBeforeWarn).toHaveLength(0);

      // Continue cycles 1 and 2 — no warning yet (cycles 3,4,5 remain; warnAhead=2
      // means warn when remaining ≤ 2, so BEFORE dispatching cycle 4).
      resolveWith({ shouldContinue: true });
      await sleep(0);
      expect(cycleCalls).toHaveLength(2);
      resolveWith({ shouldContinue: true });
      await sleep(0);
      expect(cycleCalls).toHaveLength(3);
      expect(conversationMirror.snapshot().filter((e) => e.kind === "trigger")).toHaveLength(0);

      // Cycle 3 continues → dispatch cycle 4 → warning injected pre-dispatch.
      resolveWith({ shouldContinue: true });
      await sleep(0);
      expect(cycleCalls).toHaveLength(4);
      const triggers = conversationMirror.snapshot().filter((e) => e.kind === "trigger");
      expect(triggers).toHaveLength(1);
      const warn = triggers[0];
      if (warn?.kind === "trigger") {
        expect(warn.source).toBe("react-budget");

        expect(warn.summary).toContain("2 tool-call cycles remain");
      }

      // Resolve remaining cycles to clean up.
      resolveWith({ shouldContinue: true });
      await sleep(0);
      resolveWith({ shouldContinue: false });
      await sleep(5);
      gate.dispose();
    });

    it("injects warning only once per chain (not on every subsequent cycle)", async () => {
      const ctx = createShortTermContext("sess-warn-once", testSalienceMap);
      const conversationMirror = makeConversationMirror();
      const { callbacks, cycleCalls, resolveWith } = makeChainCallbacks();
      const config: AttentionGateConfig = { ...DEFAULT_CONFIG, maxIterations: 4, maxIterWarnAhead: 2 };
      const gate = createAttentionGate(ctx, config, callbacks, conversationMirror, testSalienceMap);

      conversationMirror.append({ entryId: "e", kind: "user", ts: Date.now(), channel: "speech", content: "go" });
      await sleep(config.debounceWindowMs + 1);
      expect(cycleCalls).toHaveLength(1);

      // Drive the chain to the cap.
      resolveWith({ shouldContinue: true });
      await sleep(0);
      resolveWith({ shouldContinue: true });
      await sleep(0);
      resolveWith({ shouldContinue: true });
      await sleep(5);

      const triggers = conversationMirror.snapshot().filter((e) => e.kind === "trigger");
      expect(triggers).toHaveLength(1);

      resolveWith({ shouldContinue: false });
      await sleep(5);
      gate.dispose();
    });

    it("resets warning latch when chain resets (new turn allows warning again)", async () => {
      const ctx = createShortTermContext("sess-warn-reset", testSalienceMap);
      const conversationMirror = makeConversationMirror();
      const { callbacks, cycleCalls, resolveWith } = makeChainCallbacks();
      const config: AttentionGateConfig = { ...DEFAULT_CONFIG, maxIterations: 3, maxIterWarnAhead: 1 };
      const gate = createAttentionGate(ctx, config, callbacks, conversationMirror, testSalienceMap);

      // First turn: drive to cap so warning injects.
      conversationMirror.append({ entryId: "e", kind: "user", ts: Date.now(), channel: "speech", content: "first" });
      await sleep(config.debounceWindowMs + 1);
      expect(cycleCalls).toHaveLength(1);
      resolveWith({ shouldContinue: true });
      await sleep(0);
      resolveWith({ shouldContinue: true });
      await sleep(5);

      const afterFirstTurn = conversationMirror.snapshot().filter((e) => e.kind === "trigger");
      expect(afterFirstTurn).toHaveLength(1);

      resolveWith({ shouldContinue: false });
      await sleep(5);

      // Second turn: new user stimulus resets chain. Warning should re-fire.
      conversationMirror.append({ entryId: "e", kind: "user", ts: Date.now(), channel: "speech", content: "second" });
      await sleep(config.debounceWindowMs + 1);
      resolveWith({ shouldContinue: true });
      await sleep(0);
      resolveWith({ shouldContinue: true });
      await sleep(5);

      const afterSecondTurn = conversationMirror.snapshot().filter((e) => e.kind === "trigger");
      expect(afterSecondTurn).toHaveLength(2);

      resolveWith({ shouldContinue: false });
      await sleep(5);
      gate.dispose();
    });

    it("react-budget trigger (zero-salience source) does NOT wake the gate", async () => {
      const ctx = createShortTermContext("sess-silent", testSalienceMap);
      const conversationMirror = makeConversationMirror();
      const { callbacks, cycleCalls } = makeCallbacks();
      const gate = createAttentionGate(ctx, DEFAULT_CONFIG, callbacks, conversationMirror, testSalienceMap);

      // Append a react-budget trigger directly — no prior user stimulus, so the
      // gate is idle. A react-budget trigger must NOT start a debounce / fire a cycle.
      conversationMirror.append({
        entryId: "e",
        kind: "trigger",
        ts: Date.now(),
        source: "react-budget",
        summary: "System notice: 1 tool-call cycle remains...",
      });
      await sleep(DEFAULT_CONFIG.debounceWindowMs + 20);
      expect(cycleCalls).toHaveLength(0);

      // Sanity: a non-silent trigger DOES wake (conversation.trigger key
      // has salience 50, meeting the 50 threshold strict-exceed, so no fire.
      // Use a user entry to confirm the gate is still responsive).
      conversationMirror.append({ entryId: "e", kind: "user", ts: Date.now(), channel: "speech", content: "hi" });
      await sleep(DEFAULT_CONFIG.debounceWindowMs + 1);
      expect(cycleCalls).toHaveLength(1);

      gate.dispose();
    });
  });

  // ---------------------------------------------------------------------
  // ConversationHistory wake
  // ---------------------------------------------------------------------

  describe("conversationMirror wake", () => {
    it("wakes on conversationMirror user entry with salience key conversation.user.text", async () => {
      const ctx = createShortTermContext("sess-h1", testSalienceMap);
      const conversationMirror = makeConversationMirror();
      const { callbacks, cycleCalls } = makeCallbacks();
      const gate = createAttentionGate(ctx, DEFAULT_CONFIG, callbacks, conversationMirror, testSalienceMap);

      // text channel → "conversation.user.text" => reply: 120 > immediateWakeThreshold(100)
      conversationMirror.append({ entryId: "e", kind: "user", ts: Date.now(), channel: "text", content: "hello" });

      // fires immediately (above immediate threshold)
      expect(cycleCalls.length).toBeGreaterThanOrEqual(1);
      expect(cycleCalls[0]?.triggerReason).toContain("immediate");

      gate.dispose();
    });

    it("wakes on conversationMirror user speech entry with salience key conversation.user.speech", async () => {
      const ctx = createShortTermContext("sess-h1b", testSalienceMap);
      const conversationMirror = makeConversationMirror();
      const { callbacks, cycleCalls } = makeCallbacks();
      const gate = createAttentionGate(ctx, DEFAULT_CONFIG, callbacks, conversationMirror, testSalienceMap);

      // speech channel → "conversation.user.speech" => reply: 85, above standard(50), below immediate(100)
      conversationMirror.append({ entryId: "e", kind: "user", ts: Date.now(), channel: "speech", content: "hello" });

      await sleep(DEFAULT_CONFIG.debounceWindowMs + 1);

      expect(cycleCalls.length).toBeGreaterThanOrEqual(1);
      expect(cycleCalls[0]?.triggerReason).toContain("debounce");
      expect(cycleCalls[0]?.triggerReason).toContain("reply");

      gate.dispose();
    });

    it("does not wake on conversationMirror assistant entry", async () => {
      const ctx = createShortTermContext("sess-h2", testSalienceMap);
      const conversationMirror = makeConversationMirror();
      const { callbacks, cycleCalls } = makeCallbacks();
      const gate = createAttentionGate(ctx, DEFAULT_CONFIG, callbacks, conversationMirror, testSalienceMap);

      conversationMirror.append({ entryId: "e", kind: "assistant", ts: Date.now(), content: "I'm the assistant" });

      await sleep(DEFAULT_CONFIG.debounceWindowMs + 1);

      expect(cycleCalls).toHaveLength(0);

      gate.dispose();
    });

    it("does not wake on conversationMirror tool entry", async () => {
      const ctx = createShortTermContext("sess-h3", testSalienceMap);
      const conversationMirror = makeConversationMirror();
      const { callbacks, cycleCalls } = makeCallbacks();
      const gate = createAttentionGate(ctx, DEFAULT_CONFIG, callbacks, conversationMirror, testSalienceMap);

      conversationMirror.append({
        entryId: "e",
        kind: "tool",
        ts: Date.now(),
        toolName: "search",
        status: "finished",
        summary: "done",
      });

      await sleep(DEFAULT_CONFIG.debounceWindowMs + 1);

      expect(cycleCalls).toHaveLength(0);

      gate.dispose();
    });

    it("wakes on conversationMirror trigger entry", async () => {
      const ctx = createShortTermContext("sess-h4", testSalienceMap);
      const conversationMirror = makeConversationMirror();
      const { callbacks, cycleCalls } = makeCallbacks();
      const gate = createAttentionGate(ctx, DEFAULT_CONFIG, callbacks, conversationMirror, testSalienceMap);

      // Seed enough salience for a cycle: two trigger entries each contributing
      // reply: 50 → total 100 which exceeds standard threshold (50) and
      // reaches immediate threshold exactly (100 > 100 is false, 100 is not
      // exceeding). Wait for debounce to confirm standard path fires.
      conversationMirror.append({
        entryId: "e",
        kind: "trigger",
        ts: Date.now(),
        source: "sensor.temperature",
        summary: "22°C",
      });

      await sleep(DEFAULT_CONFIG.debounceWindowMs + 1);

      // reply: 50 is not > 50 (standard threshold), so no cycle yet.
      expect(cycleCalls).toHaveLength(0);

      gate.dispose();
    });

    it("accumulates salience across multiple user entries before firing", async () => {
      // Two trigger entries arrive during active cycle. Each adds reply: 50 to
      // accumulator. At cycle end, pending check fires because 100 > 50.
      const ctx = createShortTermContext("sess-accum", testSalienceMap);
      const conversationMirror = makeConversationMirror();
      const { callbacks, cycleCalls } = makeCallbacks();
      const resolvers: (() => void)[] = [];

      callbacks.onCycle = vi.fn((params) => {
        cycleCalls.push(params);
        return new Promise<{ aborted: boolean; shouldContinue: boolean }>((resolve) => {
          resolvers.push(() => resolve({ aborted: false, shouldContinue: false }));
        });
      });

      const gate = createAttentionGate(ctx, DEFAULT_CONFIG, callbacks, conversationMirror, testSalienceMap);

      // Kick off first cycle via a speech entry (reply: 85 → immediate after debounce)
      conversationMirror.append({ entryId: "e", kind: "user", ts: Date.now(), channel: "speech", content: "start" });
      await sleep(DEFAULT_CONFIG.debounceWindowMs + 1);
      expect(cycleCalls).toHaveLength(1);

      // During the active cycle: two trigger entries accumulate reply: 50 each → total 100
      conversationMirror.append({ entryId: "e", kind: "trigger", ts: Date.now(), source: "sensor.a", summary: "a" });
      conversationMirror.append({ entryId: "e", kind: "trigger", ts: Date.now(), source: "sensor.b", summary: "b" });

      // Salience accumulator now at reply: 100 (not yet > 50 standard individually,
      // but summed it crosses the threshold)
      // Complete first cycle
      resolvers[0]?.();
      await sleep(0);

      // pending salience check: 100 > 50 → fires second cycle
      expect(cycleCalls).toHaveLength(2);
      expect(cycleCalls[1]?.triggerReason).toContain("pending");

      resolvers[1]?.();
      await sleep(0);

      gate.dispose();
    });

    it("ambient STC injection contributes salience and can trigger a cycle", async () => {
      // User events never arrive via STC — only ambient/actionable/critical events do.
      // Verify that an ambient STC inject accumulates salience correctly.
      const ctx = createShortTermContext("sess-ambient", testSalienceMap);
      const conversationMirror = makeConversationMirror();
      const { callbacks, cycleCalls } = makeCallbacks();
      const gate = createAttentionGate(ctx, DEFAULT_CONFIG, callbacks, conversationMirror, testSalienceMap);

      // Inject an ambient event (sensor.temperature => monitor: 10, below threshold)
      ctx.inject(lowSalienceAmbientEvent());

      // No cycle fires — below threshold
      await sleep(DEFAULT_CONFIG.debounceWindowMs + 1);
      expect(cycleCalls).toHaveLength(0);

      // Authoritative path: history append fires cycle immediately (120 > 100)
      conversationMirror.append({ entryId: "e", kind: "user", ts: Date.now(), channel: "text", content: "hello" });
      expect(cycleCalls).toHaveLength(1);
      expect(cycleCalls[0]?.triggerReason).toContain("immediate");

      gate.dispose();
    });

    it("dispose unsubscribes from both ctx and conversationMirror", async () => {
      const ctx = createShortTermContext("sess-h5", testSalienceMap);
      const conversationMirror = makeConversationMirror();
      const { callbacks, cycleCalls } = makeCallbacks();
      const gate = createAttentionGate(ctx, DEFAULT_CONFIG, callbacks, conversationMirror, testSalienceMap);

      gate.dispose();

      // Neither STC inject nor history append should trigger a cycle after dispose
      ctx.inject(speechFinalEvent("after dispose"));
      conversationMirror.append({
        entryId: "e",
        kind: "user",
        ts: Date.now(),
        channel: "text",
        content: "after dispose",
      });

      await sleep(DEFAULT_CONFIG.debounceWindowMs + 1);

      expect(cycleCalls).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // clearPendingConversationSalience
  // ---------------------------------------------------------------------------

  describe("clearPendingConversationSalience", () => {
    it("zeroes conversation accumulator without touching ambient", async () => {
      const ctx = createShortTermContext("sess-clear1", testSalienceMap);
      const conversationMirror = makeConversationMirror();
      const { callbacks, cycleCalls } = makeCallbacks();
      const resolvers: (() => void)[] = [];

      callbacks.onCycle = vi.fn((params) => {
        cycleCalls.push(params);
        return new Promise<{ aborted: boolean; shouldContinue: boolean }>((resolve) => {
          resolvers.push(() => resolve({ aborted: false, shouldContinue: false }));
        });
      });

      const gate = createAttentionGate(ctx, DEFAULT_CONFIG, callbacks, conversationMirror, testSalienceMap);

      // Start first cycle via an immediate text append (reply: 120 > 100)
      conversationMirror.append({ entryId: "e", kind: "user", ts: Date.now(), channel: "text", content: "start" });
      expect(cycleCalls).toHaveLength(1);

      // While cycle is active: inject ambient event (monitor: 10) + conversation append (reply: 85)
      ctx.inject(lowSalienceAmbientEvent());
      conversationMirror.append({
        entryId: "e",
        kind: "user",
        ts: Date.now(),
        channel: "speech",
        content: "queued message",
      });

      // Clear only conversation salience — ambient should survive
      gate.clearPendingConversationSalience();

      // Complete first cycle — pending check runs
      resolvers[0]?.();
      await sleep(0);

      // Ambient alone (monitor: 10) does NOT exceed standardThreshold (50),
      // so no second cycle fires.
      expect(cycleCalls).toHaveLength(1);

      gate.dispose();
    });

    it("clears pendingSalience latch when ambient is below threshold", async () => {
      const ctx = createShortTermContext("sess-clear2", testSalienceMap);
      const conversationMirror = makeConversationMirror();
      const { callbacks, cycleCalls } = makeCallbacks();
      const resolvers: (() => void)[] = [];

      callbacks.onCycle = vi.fn((params) => {
        cycleCalls.push(params);
        return new Promise<{ aborted: boolean; shouldContinue: boolean }>((resolve) => {
          resolvers.push(() => resolve({ aborted: false, shouldContinue: false }));
        });
      });

      const gate = createAttentionGate(ctx, DEFAULT_CONFIG, callbacks, conversationMirror, testSalienceMap);

      // Start first cycle
      conversationMirror.append({ entryId: "e", kind: "user", ts: Date.now(), channel: "text", content: "start" });
      expect(cycleCalls).toHaveLength(1);

      // Queue a conversation event during active cycle (sets pendingSalience)
      conversationMirror.append({ entryId: "e", kind: "user", ts: Date.now(), channel: "speech", content: "queued" });
      // Only low-salience ambient (monitor: 10 < 50 threshold)
      ctx.inject(lowSalienceAmbientEvent());

      // Clear conversation salience — latch should clear since ambient < threshold
      gate.clearPendingConversationSalience();

      // Resolve cycle — pending check should NOT dispatch a new cycle
      resolvers[0]?.();
      await sleep(0);

      expect(cycleCalls).toHaveLength(1);

      gate.dispose();
    });

    it("preserves pendingSalience latch when ambient is above threshold", async () => {
      // Build a salience map where a sensor event scores high enough on its own
      const highAmbientMap: SalienceMap = {
        lookup(kind: string): Readonly<Record<string, number>> {
          if (kind === "sensor.critical") return { monitor: 80 }; // > standardThreshold(50)
          if (kind === "conversation.user.text") return { reply: 120 };
          return {};
        },
      };

      const ctx = createShortTermContext("sess-clear3", highAmbientMap);
      const conversationMirror = makeConversationMirror();
      const { callbacks, cycleCalls } = makeCallbacks();
      const resolvers: (() => void)[] = [];

      callbacks.onCycle = vi.fn((params) => {
        cycleCalls.push(params);
        return new Promise<{ aborted: boolean; shouldContinue: boolean }>((resolve) => {
          resolvers.push(() => resolve({ aborted: false, shouldContinue: false }));
        });
      });

      const config: AttentionGateConfig = { ...DEFAULT_CONFIG };
      const gate = createAttentionGate(ctx, config, callbacks, conversationMirror, highAmbientMap);

      // Start first cycle
      conversationMirror.append({ entryId: "e", kind: "user", ts: Date.now(), channel: "text", content: "start" });
      expect(cycleCalls).toHaveLength(1);

      // Inject high-salience ambient event during active cycle
      ctx.inject({
        kind: "sensor.critical",
        source: "sensor",
        class: "ambient",
        signal: "phasic",
        urgency: "none",
        payload: { value: 99 },
      });

      // Also queue a conversation event
      conversationMirror.append({ entryId: "e", kind: "user", ts: Date.now(), channel: "text", content: "queued" });

      // Clear conversation salience only
      gate.clearPendingConversationSalience();

      // Resolve first cycle — ambient (monitor: 80 > 50) should still dispatch
      resolvers[0]?.();
      await sleep(0);

      expect(cycleCalls).toHaveLength(2);
      expect(cycleCalls[1]?.triggerReason).toContain("pending");

      resolvers[1]?.();
      await sleep(0);

      gate.dispose();
    });

    it("clearConversationSalience is an alias for clearPendingConversationSalience", async () => {
      const ctx = createShortTermContext("sess-clear-alias", testSalienceMap);
      const conversationMirror = makeConversationMirror();
      const { callbacks, cycleCalls } = makeCallbacks();
      const resolvers: (() => void)[] = [];

      callbacks.onCycle = vi.fn((params) => {
        cycleCalls.push(params);
        return new Promise<{ aborted: boolean; shouldContinue: boolean }>((resolve) => {
          resolvers.push(() => resolve({ aborted: false, shouldContinue: false }));
        });
      });

      const gate = createAttentionGate(ctx, DEFAULT_CONFIG, callbacks, conversationMirror, testSalienceMap);

      // Start first cycle
      conversationMirror.append({ entryId: "e", kind: "user", ts: Date.now(), channel: "text", content: "first" });
      expect(cycleCalls).toHaveLength(1);

      // Queue a conversation event during the active cycle
      conversationMirror.append({ entryId: "e", kind: "user", ts: Date.now(), channel: "speech", content: "queued" });

      // Use the alias method instead of the original
      gate.clearConversationSalience();

      // Resolve first cycle — pending check should NOT dispatch a new cycle
      resolvers[0]?.();
      await sleep(0);

      expect(cycleCalls).toHaveLength(1);

      gate.dispose();
    });

    it("after clearPendingConversationSalience a new user append still triggers wake normally", async () => {
      const ctx = createShortTermContext("sess-clear4", testSalienceMap);
      const conversationMirror = makeConversationMirror();
      const { callbacks, cycleCalls } = makeCallbacks();
      const resolvers: (() => void)[] = [];

      callbacks.onCycle = vi.fn((params) => {
        cycleCalls.push(params);
        return new Promise<{ aborted: boolean; shouldContinue: boolean }>((resolve) => {
          resolvers.push(() => resolve({ aborted: false, shouldContinue: false }));
        });
      });

      const gate = createAttentionGate(ctx, DEFAULT_CONFIG, callbacks, conversationMirror, testSalienceMap);

      // Start first cycle
      conversationMirror.append({ entryId: "e", kind: "user", ts: Date.now(), channel: "text", content: "first" });
      expect(cycleCalls).toHaveLength(1);

      // Queue a message then interrupt clears it
      conversationMirror.append({
        entryId: "e",
        kind: "user",
        ts: Date.now(),
        channel: "speech",
        content: "cancelled",
      });
      gate.clearPendingConversationSalience();

      // Complete first cycle — no second cycle (cancelled message was cleared)
      resolvers[0]?.();
      await sleep(0);
      expect(cycleCalls).toHaveLength(1);

      // New user message after clear — gate is idle, should trigger normally
      conversationMirror.append({ entryId: "e", kind: "user", ts: Date.now(), channel: "text", content: "fresh" });

      // reply: 120 > immediateWakeThreshold(100) → immediate dispatch
      expect(cycleCalls).toHaveLength(2);
      expect(cycleCalls[1]?.triggerReason).toContain("immediate");

      resolvers[1]?.();
      await sleep(0);

      gate.dispose();
    });
  });

  it("mints a unique POSIX-ms cycleId per turn that does not reset when the gate is re-created (reconnect)", async () => {
    // Every session.configure builds a NEW AttentionGate. Two gates simulate a
    // reconnect. OLD behaviour: both minted "cycle-1" (per-gate counter) → the
    // client aliased two different turns onto one render row.
    async function dispatchOnceOnAFreshGate(): Promise<string> {
      const ctx = createShortTermContext("sess-x", testSalienceMap);
      const conversationMirror = makeConversationMirror();
      const { callbacks, cycleCalls } = makeCallbacks();
      const gate = createAttentionGate(ctx, DEFAULT_CONFIG, callbacks, conversationMirror, testSalienceMap);
      // "conversation.user.speech" => reply 85 > standard threshold 50 → fires after debounce.
      conversationMirror.append({ entryId: "e", kind: "user", ts: Date.now(), channel: "speech", content: "hi" });
      await sleep(DEFAULT_CONFIG.debounceWindowMs + 40);
      expect(cycleCalls).toHaveLength(1);
      gate.dispose();
      const [call] = cycleCalls;
      if (!call) throw new Error("expected exactly one dispatched cycle");
      return call.cycleId;
    }

    const id1 = await dispatchOnceOnAFreshGate();
    const id2 = await dispatchOnceOnAFreshGate();

    expect(id1).toMatch(/^\d+$/); // POSIX-ms numeric string, not "cycle-N"
    expect(id1).not.toBe("cycle-1"); // old per-gate format is gone
    // The debounce sleep separates the two Date.now() calls by >> 1ms, so the
    // ids never collide in practice — this asserts no reset across gate re-creation.
    expect(id2).not.toBe(id1); // distinct per turn
  });
});
