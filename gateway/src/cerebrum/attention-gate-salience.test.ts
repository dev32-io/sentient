import { describe, expect, it } from "vitest";
import {
  accumulateSalience,
  findExceedingEffect,
  salienceKeyForInjectEvent,
  salienceKeyForMirrorEntry,
} from "./attention-gate-salience.js";
import type { SalienceMap } from "./short-term-context-types.js";
import type { ContextEvent } from "./short-term-context-types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const testMap: SalienceMap = {
  lookup(kind: string): Readonly<Record<string, number>> {
    if (kind === "conversation.user.speech") return { reply: 85 };
    if (kind === "conversation.user.text") return { reply: 120 };
    if (kind === "conversation.trigger") return { reply: 50 };
    return {};
  },
};

function makeContextEvent(overrides: Partial<ContextEvent> = {}): ContextEvent {
  return {
    seq: 1,
    ts: Date.now(),
    kind: "user.speech.final",
    source: "stt",
    class: "user-direct",
    signal: "phasic",
    urgency: "none",
    payload: {},
    ...overrides,
  };
}

const SESSION_CTX = { sessionId: "test-session", source: "test" };

// ---------------------------------------------------------------------------
// salienceKeyForMirrorEntry
// ---------------------------------------------------------------------------

describe("salienceKeyForMirrorEntry", () => {
  it("maps user text channel to conversation.user.text", () => {
    const entry = {
      id: "1",
      ts: 0,
      kind: "user" as const,
      channel: "text" as const,
      content: "hello",
    };
    expect(salienceKeyForMirrorEntry(entry)).toBe("conversation.user.text");
  });

  it("maps user speech channel to conversation.user.speech", () => {
    const entry = {
      id: "1",
      ts: 0,
      kind: "user" as const,
      channel: "speech" as const,
      content: "hello",
    };
    expect(salienceKeyForMirrorEntry(entry)).toBe("conversation.user.speech");
  });

  it("maps trigger entry to conversation.trigger", () => {
    const entry = {
      id: "1",
      ts: 0,
      kind: "trigger" as const,
      source: "sensor.temperature",
      summary: "22°C",
    };
    expect(salienceKeyForMirrorEntry(entry)).toBe("conversation.trigger");
  });

  it("returns null for assistant entry", () => {
    const entry = {
      id: "1",
      ts: 0,
      kind: "assistant" as const,
      cycleId: "c-1",
      content: "hello",
    };
    expect(salienceKeyForMirrorEntry(entry)).toBeNull();
  });

  it("returns null for tool entry", () => {
    const entry = {
      id: "1",
      ts: 0,
      kind: "tool" as const,
      cycleId: "c-1",
      taskId: "t-1",
      toolName: "search",
      status: "finished" as const,
      summary: "done",
    };
    expect(salienceKeyForMirrorEntry(entry)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// salienceKeyForInjectEvent
// ---------------------------------------------------------------------------

describe("salienceKeyForInjectEvent", () => {
  it("returns event.kind for user-direct events (no longer filtered — user events never arrive via STC)", () => {
    // User events now travel exclusively through ConversationHistory. If one
    // somehow arrived via STC inject it would not be double-counted because the
    // history path is the only real source. The guard is gone.
    const event = makeContextEvent({ class: "user-direct", kind: "sensor.temperature" });
    expect(salienceKeyForInjectEvent(event)).toBe("sensor.temperature");
  });

  it("returns event.kind for ambient events", () => {
    const event = makeContextEvent({ kind: "sensor.temperature", class: "ambient" });
    expect(salienceKeyForInjectEvent(event)).toBe("sensor.temperature");
  });

  it("returns event.kind for actionable events", () => {
    const event = makeContextEvent({ kind: "some.actionable.event", class: "actionable" });
    expect(salienceKeyForInjectEvent(event)).toBe("some.actionable.event");
  });
});

// ---------------------------------------------------------------------------
// accumulateSalience
// ---------------------------------------------------------------------------

describe("accumulateSalience", () => {
  it("adds salience weights from the salience map to the accumulator", () => {
    const acc: Record<string, number> = {};
    accumulateSalience(acc, "conversation.user.speech", testMap, SESSION_CTX);
    expect(acc.reply).toBe(85);
  });

  it("sums salience across multiple calls for the same key", () => {
    const acc: Record<string, number> = {};
    accumulateSalience(acc, "conversation.user.speech", testMap, SESSION_CTX);
    accumulateSalience(acc, "conversation.user.speech", testMap, SESSION_CTX);
    expect(acc.reply).toBe(170);
  });

  it("sums salience across different keys that map to the same effect", () => {
    const acc: Record<string, number> = {};
    accumulateSalience(acc, "conversation.user.speech", testMap, SESSION_CTX);
    accumulateSalience(acc, "conversation.trigger", testMap, SESSION_CTX);
    expect(acc.reply).toBe(135); // 85 + 50
  });

  it("does not mutate accumulator for unknown key (no effects)", () => {
    const acc: Record<string, number> = {};
    accumulateSalience(acc, "unknown.kind", testMap, SESSION_CTX);
    expect(Object.keys(acc)).toHaveLength(0);
  });

  it("returns the mutated accumulator for convenience", () => {
    const acc: Record<string, number> = {};
    const returned = accumulateSalience(acc, "conversation.user.speech", testMap, SESSION_CTX);
    expect(returned).toBe(acc);
  });
});

// ---------------------------------------------------------------------------
// findExceedingEffect
// ---------------------------------------------------------------------------

describe("findExceedingEffect", () => {
  it("returns effect name when value exceeds threshold", () => {
    expect(findExceedingEffect({ reply: 86 }, 85)).toBe("reply");
  });

  it("returns null when value equals threshold (not exceeding)", () => {
    expect(findExceedingEffect({ reply: 85 }, 85)).toBeNull();
  });

  it("returns null when value is below threshold", () => {
    expect(findExceedingEffect({ reply: 10 }, 50)).toBeNull();
  });

  it("returns null for empty accumulator", () => {
    expect(findExceedingEffect({}, 50)).toBeNull();
  });

  it("returns first exceeding effect when multiple are present", () => {
    const acc = { monitor: 5, reply: 90 };
    const result = findExceedingEffect(acc, 50);
    expect(result).not.toBeNull();
    expect(["monitor", "reply"]).toContain(result);
  });
});
