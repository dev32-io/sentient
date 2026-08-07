import { describe, expect, it } from "bun:test";
import { projectForClient } from "./client-projection.js";
import type { SessionEntry } from "./entry-types.js";

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

describe("projectForClient", () => {
  it("renders user and assistant entries as feed items", () => {
    const out = projectForClient([e({ kind: "user", text: "hello" }), e({ kind: "assistant", text: "hi" })]);
    expect(out.map((i) => [i.kind, i.text])).toEqual([
      ["user", "hello"],
      ["assistant", "hi"],
    ]);
  });

  it("folds a tool_call + tool_result pair into ONE tile", () => {
    const out = projectForClient([
      e({ kind: "tool_call", toolCallId: "c1", toolName: "search", toolArgs: "{}" }),
      e({ kind: "tool_result", toolCallId: "c1", toolName: "search", toolArgs: '"done"' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe("tool");
    expect(out[0]?.toolName).toBe("search");
  });

  it("folds every stretch of one reply into ONE item named by its replyId", () => {
    const out = projectForClient([
      e({ kind: "assistant", replyId: "r1", text: "Let me look. " }),
      e({ kind: "assistant", replyId: "r1", text: "It is 20C." }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.id).toBe("r1");
    expect(out[0]?.text).toBe("Let me look. It is 20C.");
  });

  it("folds stretches separated by a tool round trip — the ReAct shape", () => {
    // The store interleaves narration with the tool calls because the MODEL
    // projection needs dispatch order; the person saw one bubble that grew.
    const narration = e({ kind: "assistant", replyId: "r1", text: "Checking. " });
    const toolCall = e({ kind: "tool_call", toolCallId: "c1", toolName: "search", toolArgs: "{}" });
    const toolResult = e({ kind: "tool_result", toolCallId: "c1", toolName: "search", toolArgs: '"20C"' });
    const answer = e({ kind: "assistant", replyId: "r1", text: "It is 20C." });

    const out = projectForClient([narration, toolCall, toolResult, answer]);
    expect(out.map((i) => [i.kind, i.id, i.text])).toEqual([
      ["assistant", "r1", "Checking. It is 20C."],
      ["tool", String(toolCall.seq), '"20C"'],
    ]);
  });

  it("does NOT fold two replies: a rotated id is a new bubble", () => {
    const firstHalf = e({ kind: "assistant", replyId: "r1", text: "First half." });
    const interjection = e({ kind: "user", text: "actually, tomorrow" });
    const secondHalf = e({ kind: "assistant", replyId: "r2", text: "Second half." });

    const out = projectForClient([firstHalf, interjection, secondHalf]);
    expect(out.map((i) => [i.kind, i.id])).toEqual([
      ["assistant", "r1"],
      ["user", String(interjection.seq)],
      ["assistant", "r2"],
    ]);
  });

  it("keeps a null-replyId assistant entry on its own seq-named item", () => {
    // Nothing stamps a reply id on a compaction-era or cancellation entry, and
    // a null id must never collide two unrelated bubbles into one.
    const out = projectForClient([e({ kind: "assistant", text: "one" }), e({ kind: "assistant", text: "two" })]);
    expect(out).toHaveLength(2);
    expect(out.map((i) => i.text)).toEqual(["one", "two"]);
  });

  it("takes the LAST stretch's cutoff onto the folded item", () => {
    // A cutoff is stamped on the final partial of a cut-off reply.
    const out = projectForClient([
      e({ kind: "assistant", replyId: "r1", text: "Checking. " }),
      e({ kind: "assistant", replyId: "r1", text: "It is—", cutoff: "barge-in" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.cutoff).toBe("barge-in");
  });

  it("COMPACTION: still shows pre-compaction history (client sees everything)", () => {
    const out = projectForClient([
      e({ kind: "user", text: "ancient" }),
      e({ kind: "compaction", text: "Summary.", compactedThroughSeq: 1 }),
      e({ kind: "user", text: "recent" }),
    ]);
    const texts = out.map((i) => i.text);
    expect(texts).toContain("ancient");
    expect(texts).toContain("recent");
  });

  it("carries the cutoff kind on an interrupted assistant item", () => {
    const out = projectForClient([e({ kind: "assistant", text: "partial", cutoff: "interrupt" })]);
    expect(out[0]?.cutoff).toBe("interrupt");
  });

  it("does not render internal system entries", () => {
    const out = projectForClient([e({ kind: "system", text: "internal note" }), e({ kind: "user", text: "visible" })]);
    expect(out.map((i) => i.text)).toEqual(["visible"]);
  });

  it("renders a trigger entry as kind:trigger, not kind:user", () => {
    const out = projectForClient([e({ kind: "trigger", text: "cron fired: remind about pills" })]);
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe("trigger");
    expect(out[0]?.text).toBe("cron fired: remind about pills");
  });

  it("drops an entry with an unknown kind instead of rendering it as user", () => {
    const out = projectForClient([e({ kind: "bogus_future_kind" as SessionEntry["kind"], text: "corrupt row" })]);
    expect(out).toEqual([]);
  });

  it("drops a malformed tool_call missing toolCallId", () => {
    const out = projectForClient([e({ kind: "tool_call", toolCallId: null, toolName: "search" })]);
    expect(out).toEqual([]);
  });

  it("drops an orphan tool_result with no matching tool_call tile", () => {
    const out = projectForClient([e({ kind: "tool_result", toolCallId: "missing", toolArgs: '"done"' })]);
    expect(out).toEqual([]);
  });

  it("first-wins on duplicate toolCallId: keeps the first tile, drops the second call", () => {
    const out = projectForClient([
      e({ kind: "tool_call", toolCallId: "c1", toolName: "search", toolArgs: "{}" }),
      e({ kind: "tool_call", toolCallId: "c1", toolName: "search-again", toolArgs: "{}" }),
      e({ kind: "tool_result", toolCallId: "c1", toolArgs: '"done"' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.toolName).toBe("search");
    expect(out[0]?.text).toBe('"done"');
  });
});
