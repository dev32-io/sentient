import { conversationFeedItemSchema } from "@sentient/protocol";
import { describe, expect, it } from "vitest";
import { toFeedItem } from "../cerebrum/conversation-feed.js";
import type { HermesRawMessage } from "../hermes-adapter-client/sessions-client.js";
import { hermesMessageToMirrorEntry } from "./hermes-message-to-mirror.js";

// ---------------------------------------------------------------------------
// Wire-contract guard for the Hermes-history resume path.
//
// `getMessages` returns untrusted plugin-sidecar JSON (no zod gate), so a
// message row may carry a missing / null / NaN `ts` at runtime despite its
// `number` TS type. The mapper MUST backfill the real timestamp when present
// (history ordering + date-grouping depend on it) and coerce a bad one to a
// non-negative int — never NaN, which serialises to `null` on the wire and
// crashes the strict KMP SDK decoder (`$.ts`).
//
// entryId is `${conversationId}:${rawIndex}` (deterministic, fetch-stable).
// ---------------------------------------------------------------------------

const raw = (over: Partial<HermesRawMessage> & { role: HermesRawMessage["role"] }): HermesRawMessage =>
  ({ ts: 1_717_000_000, content: "x", ...over }) as HermesRawMessage;

describe("hermesMessageToMirrorEntry", () => {
  it("preserves the real ts (Unix seconds -> ms) for a user message", () => {
    const entry = hermesMessageToMirrorEntry(raw({ role: "user", ts: 1_717_000_000, content: "hi" }), "conv-1", 0);
    expect(entry).toEqual({ entryId: "conv-1:0", kind: "user", ts: 1_717_000_000_000, channel: "text", content: "hi" });
  });

  it("passes through ts already in ms (above the seconds/ms threshold)", () => {
    const entry = hermesMessageToMirrorEntry(
      raw({ role: "assistant", ts: 1_717_000_000_000, content: "yo" }),
      "conv-1",
      1,
    );
    expect(entry?.ts).toBe(1_717_000_000_000);
    expect(entry?.entryId).toBe("conv-1:1");
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["NaN", Number.NaN],
    ["negative", -1],
  ])("backfills a non-negative numeric ts when raw ts is %s (never null/NaN)", (_label, badTs) => {
    const entry = hermesMessageToMirrorEntry(
      raw({ role: "user", ts: badTs as unknown as number, content: "hi" }),
      "conv-1",
      2,
    );
    if (entry === null) throw new Error("expected a rehydrated entry, got null");
    expect(Number.isNaN(entry.ts)).toBe(false);
    expect(entry.ts).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(entry.ts)).toBe(true);
    expect(entry.entryId).toBe("conv-1:2");
    // End-to-end: the rehydrated entry must produce a schema-valid feed item.
    const item = toFeedItem(entry);
    expect(conversationFeedItemSchema.safeParse(item).success).toBe(true);
    expect(JSON.parse(JSON.stringify(item)).ts).not.toBeNull();
  });

  it("drops tool / tool_call / tool_result / system roles", () => {
    for (const role of ["tool", "tool_call", "tool_result", "system"] as const) {
      expect(hermesMessageToMirrorEntry(raw({ role }), "conv-1", 0)).toBeNull();
    }
  });

  it("produces deterministic entryIds — same conversation + index = same id", () => {
    const m = raw({ role: "user", ts: 1_717_000_000, content: "hi" });
    const a = hermesMessageToMirrorEntry(m, "session-xyz", 3);
    const b = hermesMessageToMirrorEntry(m, "session-xyz", 3);
    expect(a?.entryId).toBe("session-xyz:3");
    expect(b?.entryId).toBe("session-xyz:3");
  });

  it("produces different entryIds for different indices in the same conversation", () => {
    const m = raw({ role: "user", ts: 1_717_000_000, content: "hi" });
    const a = hermesMessageToMirrorEntry(m, "session-abc", 0);
    const b = hermesMessageToMirrorEntry(m, "session-abc", 1);
    expect(a?.entryId).not.toBe(b?.entryId);
  });
});
