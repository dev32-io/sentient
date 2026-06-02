import { conversationFeedItemSchema } from "@sentient/protocol";
import { describe, expect, it } from "vitest";
import { toFeed, toFeedItem } from "./conversation-feed.js";
import type { MirrorEntry } from "./conversation-mirror.js";

// ---------------------------------------------------------------------------
// These tests enforce the "internal plumbing does not leak to the wire"
// invariant: cycleId, taskId are stripped by the transformer.
// ---------------------------------------------------------------------------

describe("toFeedItem", () => {
  it("maps a user entry to the wire shape", () => {
    const entry: MirrorEntry = {
      ts: 123,
      kind: "user",
      channel: "text",
      content: "hello",
    };
    const item = toFeedItem(entry);
    expect(item).toEqual({ ts: 123, kind: "user", channel: "text", content: "hello" });
  });

  it("maps a trigger entry to the wire shape", () => {
    const entry: MirrorEntry = {
      ts: 456,
      kind: "trigger",
      source: "motion.kitchen",
      summary: "motion detected",
    };
    const item = toFeedItem(entry);
    expect(item).toEqual({ ts: 456, kind: "trigger", source: "motion.kitchen", summary: "motion detected" });
  });

  it("maps an assistant entry without cutoff", () => {
    const entry: MirrorEntry = {
      ts: 789,
      kind: "assistant",
      content: "Greeted back.",
    };
    const item = toFeedItem(entry);
    expect(item).toEqual({ ts: 789, kind: "assistant", content: "Greeted back." });
    expect((item as Record<string, unknown>).cutoff).toBeUndefined();
  });

  it("propagates a barge-in cutoff on the assistant item", () => {
    const entry: MirrorEntry = {
      ts: 789,
      kind: "assistant",
      content: "The moon is approximately...",
      cutoff: { kind: "barge-in" },
    };
    const item = toFeedItem(entry);
    expect(item).toEqual({
      ts: 789,
      kind: "assistant",
      content: "The moon is approximately...",
      cutoff: { kind: "barge-in" },
    });
  });

  it("propagates an interrupt cutoff with cancelledTaskIds", () => {
    const entry: MirrorEntry = {
      ts: 789,
      kind: "assistant",
      content: "Let me look that up for y",
      cutoff: { kind: "interrupt", cancelledTaskIds: ["t_042", "t_043"] },
    };
    const item = toFeedItem(entry);
    expect(item).toEqual({
      ts: 789,
      kind: "assistant",
      content: "Let me look that up for y",
      cutoff: { kind: "interrupt", cancelledTaskIds: ["t_042", "t_043"] },
    });
  });

  it("filters out length-cap cutoff (internal-only, not in wire protocol)", () => {
    const entry: MirrorEntry = {
      ts: 789,
      kind: "assistant",
      content: "Clean reply",
      cutoff: { kind: "length-cap" },
    };
    const item = toFeedItem(entry);
    expect((item as Record<string, unknown>).cutoff).toBeUndefined();
  });

  it("maps a tool entry and drops cycleId + taskId", () => {
    const entry: MirrorEntry = {
      ts: 100,
      kind: "tool",
      toolName: "speak",
      status: "finished",
      summary: "Said hi",
    };
    const item = toFeedItem(entry);
    expect(item).toEqual({
      ts: 100,
      kind: "tool",
      toolName: "speak",
      status: "finished",
      summary: "Said hi",
    });
    expect((item as Record<string, unknown>).cycleId).toBeUndefined();
    expect((item as Record<string, unknown>).taskId).toBeUndefined();
  });

  it("preserves each ConversationToolStatus value", () => {
    const statuses = ["finished", "cancelled", "failed"] as const;
    for (const status of statuses) {
      const entry: MirrorEntry = {
        ts: 0,
        kind: "tool",
        toolName: "speak",
        status,
        summary: "s",
      };
      expect((toFeedItem(entry) as { status: string }).status).toBe(status);
    }
  });

  // Contract guard: the wire schema requires `ts` to be a non-negative int.
  // On Hermes-history resume a MirrorEntry can carry a bad ts (NaN from a
  // missing Hermes timestamp); the transformer MUST coerce it, never emit
  // null/NaN, or strict SDK clients crash decoding `$.ts`.
  it("preserves a real ts and yields a schema-valid item", () => {
    const item = toFeedItem({ ts: 1717000000000, kind: "user", channel: "text", content: "hi" });
    expect(item.ts).toBe(1717000000000);
    expect(conversationFeedItemSchema.safeParse(item).success).toBe(true);
  });

  it("backstops a NaN ts to a non-negative number (never null/NaN)", () => {
    const item = toFeedItem({ ts: Number.NaN, kind: "user", channel: "text", content: "hi" });
    expect(Number.isNaN(item.ts)).toBe(false);
    expect(item.ts).toBeGreaterThanOrEqual(0);
    // JSON round-trip is what bites strict clients: NaN serialises to null.
    expect(JSON.parse(JSON.stringify(item)).ts).not.toBeNull();
    expect(conversationFeedItemSchema.safeParse(item).success).toBe(true);
  });

  it("backstops a null/undefined ts across every feed kind", () => {
    const kinds: MirrorEntry[] = [
      { ts: undefined as unknown as number, kind: "user", channel: "speech", content: "x" },
      { ts: null as unknown as number, kind: "assistant", content: "y" },
      { ts: Number.NaN, kind: "tool", toolName: "speak", status: "finished", summary: "z" },
      { ts: -5, kind: "trigger", source: "motion.kitchen", summary: "w" },
    ];
    for (const entry of kinds) {
      const item = toFeedItem(entry);
      expect(item.ts).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(item.ts)).toBe(true);
      expect(conversationFeedItemSchema.safeParse(item).success).toBe(true);
    }
  });
});

describe("toFeed", () => {
  it("maps an array of entries preserving order", () => {
    const entries: MirrorEntry[] = [
      { ts: 1, kind: "user", channel: "text", content: "hi" },
      { ts: 2, kind: "assistant", content: "hello" },
      {
        ts: 3,
        kind: "tool",
        toolName: "speak",
        status: "finished",
        summary: "said hi",
      },
    ];
    const feed = toFeed(entries);
    expect(feed).toHaveLength(3);
    expect(feed.map((i) => i.kind)).toEqual(["user", "assistant", "tool"]);
    expect(feed[0]?.ts).toBe(1);
    expect(feed[2]?.ts).toBe(3);
  });

  it("returns empty array for empty input", () => {
    expect(toFeed([])).toEqual([]);
  });
});
