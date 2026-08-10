import { describe, expect, it } from "bun:test";
import type { SessionEntry } from "./entry-types.js";
import { renderSessionExcerpt } from "./session-excerpt.js";

function entry(over: Partial<SessionEntry> & { seq: number; kind: SessionEntry["kind"] }): SessionEntry {
  return {
    sessionId: "s_1",
    turnId: "t_1",
    replyId: null,
    createdAt: 1_700_000_000_000 + over.seq,
    text: "",
    toolCallId: null,
    toolName: null,
    toolArgs: null,
    cutoff: null,
    compactedThroughSeq: null,
    pendingId: null,
    ...over,
  };
}

// A 7-entry session; seq 12 is a tool_call (must never render), so there are 6
// renderable entries at seqs 10,11,13,14,15,16.
const SESSION: SessionEntry[] = [
  entry({ seq: 10, kind: "user", text: "u0" }),
  entry({ seq: 11, kind: "assistant", text: "a0" }),
  entry({ seq: 12, kind: "tool_call", text: null, toolName: "get_weather" }),
  entry({ seq: 13, kind: "user", text: "u1" }),
  entry({ seq: 14, kind: "assistant", text: "a1" }),
  entry({ seq: 15, kind: "user", text: "u2" }),
  entry({ seq: 16, kind: "assistant", text: "a2" }),
];

describe("renderSessionExcerpt — visible-kind filter", () => {
  it("renders speaker-labeled lines with seq markers and drops non-renderable kinds", () => {
    const out = renderSessionExcerpt(SESSION, { contextEntries: 10 });
    expect(out).toContain("#10 User: u0");
    expect(out).toContain("#14 Assistant: a1");
    // tool_call / system / compaction never render.
    expect(out).not.toContain("get_weather");
    expect(out).not.toContain("#12");
  });

  it("labels a trigger entry as its own speaker", () => {
    const out = renderSessionExcerpt([entry({ seq: 1, kind: "trigger", text: "task done" })], { contextEntries: 2 });
    expect(out).toBe("#1 Trigger: task done");
  });

  it("returns empty string for a session with no renderable entries", () => {
    const out = renderSessionExcerpt([entry({ seq: 1, kind: "tool_result", text: null })], { contextEntries: 2 });
    expect(out).toBe("");
  });
});

describe("renderSessionExcerpt — around ± contextEntries window", () => {
  it("centers a ±contextEntries window on the entry at around and marks both clipped ends", () => {
    // around=14 is renderable index 3 (of 6). contextEntries=1 → indices 2..4,
    // i.e. seqs 13,14,15. Indices 0..1 clipped ahead, index 5 clipped after.
    const out = renderSessionExcerpt(SESSION, { around: 14, contextEntries: 1 });
    const lines = out.split("\n");
    expect(lines[0]).toContain("earlier");
    expect(lines[0]).toContain("omitted");
    expect(out).toContain("#13 User: u1");
    expect(out).toContain("#14 Assistant: a1");
    expect(out).toContain("#15 User: u2");
    expect(out).not.toContain("#11");
    expect(out).not.toContain("#16");
    expect(lines.at(-1)).toContain("later");
    expect(lines.at(-1)).toContain("offset");
  });

  it("centers on the nearest entry at or after around when around is not itself renderable", () => {
    // around=12 (the tool_call seq) resolves to the next renderable, seq 13.
    const out = renderSessionExcerpt(SESSION, { around: 12, contextEntries: 0 });
    expect(out).toContain("#13 User: u1");
    expect(out).not.toContain("#11");
    expect(out).not.toContain("#14");
  });

  it("shows the whole session with no markers when the window covers everything", () => {
    const out = renderSessionExcerpt(SESSION, { around: 13, contextEntries: 10 });
    expect(out).not.toContain("omitted");
    expect(out).toContain("#10 User: u0");
    expect(out).toContain("#16 Assistant: a2");
  });
});

describe("renderSessionExcerpt — offset paging", () => {
  it("starts at the offset-th renderable entry and prepends a continuation marker", () => {
    // offset=3 → renderable indices 3..5 = seqs 14,15,16.
    const out = renderSessionExcerpt(SESSION, { offset: 3, contextEntries: 2 });
    const lines = out.split("\n");
    expect(lines[0]).toContain("earlier");
    expect(lines[0]).toContain("omitted");
    expect(out).toContain("#14 Assistant: a1");
    expect(out).toContain("#16 Assistant: a2");
    expect(out).not.toContain("#13");
  });

  it("offset 0 is the whole session with no leading marker", () => {
    const out = renderSessionExcerpt(SESSION, { offset: 0, contextEntries: 2 });
    expect(out).not.toContain("omitted");
    expect(out).toContain("#10 User: u0");
  });
});
