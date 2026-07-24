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
    kind: "user",
    createdAt: 1000 + seq,
    text: null,
    toolCallId: null,
    toolName: null,
    toolArgs: null,
    cutoff: null,
    compactedThroughSeq: null,
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
});
