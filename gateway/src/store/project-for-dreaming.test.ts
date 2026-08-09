import { describe, expect, it } from "bun:test";
import type { EntryKind, SessionEntry } from "./entry-types.js";
import { projectForDreaming } from "./project-for-dreaming.js";

let seq = 0;
function e(partial: Partial<SessionEntry>): SessionEntry {
  seq += 1;
  return {
    seq,
    sessionId: "s1",
    turnId: "t1",
    replyId: null,
    kind: "user",
    createdAt: 1000 + seq,
    text: null,
    toolCallId: null,
    toolName: null,
    toolArgs: null,
    cutoff: null,
    compactedThroughSeq: null,
    pendingId: null,
    ...partial,
  };
}

/** A window that admits every seq the factory hands out. */
const ALL = { from: 0, to: Number.MAX_SAFE_INTEGER };

describe("projectForDreaming — provenance taint (spec §3.1)", () => {
  it("taints a window containing a tool_result", () => {
    const out = projectForDreaming(
      [
        e({ kind: "user", text: "what's the weather" }),
        e({ kind: "tool_call", toolCallId: "c1", toolName: "weather", toolArgs: "{}" }),
        e({ kind: "tool_result", toolCallId: "c1", toolName: "weather", toolArgs: '"20C sunny"' }),
        e({ kind: "assistant", text: "It's 20C and sunny." }),
      ],
      ALL.from,
      ALL.to,
    );
    expect(out.sessions).toHaveLength(1);
    expect(out.sessions[0]?.containsToolDerived).toBe(true);
  });

  it("TAINTS a trigger-only window — background-completion payloads never launder to trusted", () => {
    // THE laundering case. A `trigger` is a background delegation completing —
    // untrusted, web-facing origin. Classified user-speech it would poison
    // memory as if the person had said it. It must taint even with no tool_result
    // anywhere in the window.
    const out = projectForDreaming([e({ kind: "trigger", text: "delegated research says X" })], ALL.from, ALL.to);
    expect(out.sessions[0]?.containsToolDerived).toBe(true);
  });

  it("does NOT taint a window of only user + assistant entries", () => {
    const out = projectForDreaming(
      [e({ kind: "user", text: "hi" }), e({ kind: "assistant", text: "hello" })],
      ALL.from,
      ALL.to,
    );
    expect(out.sessions[0]?.containsToolDerived).toBe(false);
  });

  it("does NOT taint a window whose only tool entry is a tool_call (the result carries taint, not the call)", () => {
    const out = projectForDreaming(
      [e({ kind: "user", text: "go" }), e({ kind: "tool_call", toolCallId: "c1", toolName: "search", toolArgs: "{}" })],
      ALL.from,
      ALL.to,
    );
    expect(out.sessions[0]?.containsToolDerived).toBe(false);
  });

  it("fails conservative on an unknown kind — taints and WARNs", () => {
    const out = projectForDreaming(
      [e({ kind: "mystery" as unknown as EntryKind, text: "corrupt row" })],
      ALL.from,
      ALL.to,
    );
    expect(out.sessions[0]?.containsToolDerived).toBe(true);
  });
});

describe("projectForDreaming — skipped kinds", () => {
  it("skips system and compaction entries from BOTH text and taint", () => {
    const out = projectForDreaming(
      [
        e({ kind: "system", text: "system note" }),
        e({ kind: "compaction", text: "SUMMARY of earlier turns", compactedThroughSeq: 1 }),
        e({ kind: "user", text: "still here" }),
      ],
      ALL.from,
      ALL.to,
    );
    expect(out.sessions[0]?.containsToolDerived).toBe(false);
    expect(out.sessions[0]?.text).not.toContain("system note");
    expect(out.sessions[0]?.text).not.toContain("SUMMARY of earlier turns");
    expect(out.sessions[0]?.text).toContain("still here");
  });

  it("emits a session with empty text but no taint when only system/compaction entries are present", () => {
    const out = projectForDreaming([e({ kind: "system", text: "x" })], ALL.from, ALL.to);
    expect(out.sessions[0]?.text).toBe("");
    expect(out.sessions[0]?.containsToolDerived).toBe(false);
  });
});

describe("projectForDreaming — text rendering", () => {
  it("labels speakers and marks each line with its seq", () => {
    const out = projectForDreaming(
      [e({ kind: "user", text: "hi", seq: 5 }), e({ kind: "assistant", text: "hello", seq: 6 })],
      ALL.from,
      ALL.to,
    );
    expect(out.sessions[0]?.text).toBe("#5 User: hi\n#6 Assistant: hello");
  });

  it("collapses a tool round-trip to a labeled digest carrying the result text", () => {
    const out = projectForDreaming(
      [
        e({ kind: "tool_call", toolCallId: "c1", toolName: "search", toolArgs: '{"q":"cats"}' }),
        e({ kind: "tool_result", toolCallId: "c1", toolName: "search", toolArgs: "found", seq: 42 }),
      ],
      ALL.from,
      ALL.to,
    );
    // tool_call renders nothing standalone; the result carries the digest + text.
    expect(out.sessions[0]?.text).toBe("#42 [tool search → 5 chars] found");
  });

  it("marks interrupted assistant output with its cutoff kind", () => {
    const out = projectForDreaming(
      [e({ kind: "assistant", text: "I was say", cutoff: "barge-in", seq: 9 })],
      ALL.from,
      ALL.to,
    );
    expect(out.sessions[0]?.text).toBe("#9 Assistant: I was say [cut off: barge-in]");
  });

  it("labels a trigger line as Trigger even though it taints", () => {
    const out = projectForDreaming([e({ kind: "trigger", text: "task done", seq: 3 })], ALL.from, ALL.to);
    expect(out.sessions[0]?.text).toBe("#3 Trigger: task done");
    expect(out.sessions[0]?.containsToolDerived).toBe(true);
  });
});

describe("projectForDreaming — window bounds (fromSeq, toSeq]", () => {
  it("excludes seq <= fromSeq and includes seq == toSeq (half-open lower, closed upper)", () => {
    const out = projectForDreaming(
      [
        e({ kind: "user", text: "before", seq: 10 }),
        e({ kind: "user", text: "lower-boundary", seq: 11 }),
        e({ kind: "user", text: "inside", seq: 12 }),
        e({ kind: "user", text: "upper-boundary", seq: 13 }),
        e({ kind: "user", text: "after", seq: 14 }),
      ],
      11,
      13,
    );
    const text = out.sessions[0]?.text ?? "";
    expect(text).not.toContain("before");
    expect(text).not.toContain("lower-boundary"); // seq == fromSeq is excluded
    expect(text).toContain("inside");
    expect(text).toContain("upper-boundary"); // seq == toSeq is included
    expect(text).not.toContain("after");
  });

  it("excludes an out-of-window tool_result from the taint bit", () => {
    const out = projectForDreaming(
      [
        e({ kind: "user", text: "in", seq: 20 }),
        e({ kind: "tool_result", toolName: "search", toolArgs: "leaked", seq: 30 }),
      ],
      19,
      25,
    );
    // The tool_result at seq 30 is past toSeq — it must not taint the window.
    expect(out.sessions[0]?.containsToolDerived).toBe(false);
  });
});

describe("projectForDreaming — grouping", () => {
  it("groups entries by sessionId in first-appearance order, append order within each", () => {
    const out = projectForDreaming(
      [
        e({ kind: "user", text: "a1", sessionId: "sA", seq: 1 }),
        e({ kind: "user", text: "b1", sessionId: "sB", seq: 2 }),
        e({ kind: "user", text: "a2", sessionId: "sA", seq: 3 }),
      ],
      0,
      ALL.to,
    );
    expect(out.sessions.map((s) => s.sessionId)).toEqual(["sA", "sB"]);
    expect(out.sessions[0]?.text).toBe("#1 User: a1\n#3 User: a2");
    expect(out.sessions[1]?.text).toBe("#2 User: b1");
  });

  it("taints only the session that held the tool-derived entry", () => {
    const out = projectForDreaming(
      [
        e({ kind: "assistant", text: "clean", sessionId: "sA", seq: 1 }),
        e({ kind: "tool_result", toolName: "x", toolArgs: "r", sessionId: "sB", seq: 2 }),
      ],
      0,
      ALL.to,
    );
    const byId = new Map(out.sessions.map((s) => [s.sessionId, s.containsToolDerived]));
    expect(byId.get("sA")).toBe(false);
    expect(byId.get("sB")).toBe(true);
  });
});

describe("projectForDreaming — determinism", () => {
  it("returns byte-identical output for the same input", () => {
    const entries = [
      e({ kind: "user", text: "q", sessionId: "sA", seq: 1 }),
      e({ kind: "tool_call", toolCallId: "c1", toolName: "search", toolArgs: "{}", sessionId: "sA", seq: 2 }),
      e({ kind: "tool_result", toolCallId: "c1", toolName: "search", toolArgs: "res", sessionId: "sA", seq: 3 }),
      e({ kind: "assistant", text: "ans", sessionId: "sA", seq: 4 }),
      e({ kind: "trigger", text: "bg", sessionId: "sB", seq: 5 }),
    ];
    const a = projectForDreaming(entries, 0, ALL.to);
    const b = projectForDreaming(entries, 0, ALL.to);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("does not mutate the input entries", () => {
    const entries = [e({ kind: "user", text: "hi" })];
    const snapshot = JSON.stringify(entries);
    projectForDreaming(entries, 0, ALL.to);
    expect(JSON.stringify(entries)).toBe(snapshot);
  });
});
