import { describe, expect, it } from "bun:test";
import type { SessionEntry } from "./entry-types.js";
import type { ChatMessage } from "./model-projection.js";
import { projectForModel } from "./model-projection.js";

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

/**
 * Structural validity for the OpenAI tool-call/tool-result contract:
 *  - no `tool_calls` array is ever empty
 *  - no `tool_calls` array has a duplicate id
 *  - every role:"tool" message belongs to the contiguous run immediately
 *    after the assistant message that declared its id (never a bare/orphan
 *    tool message, never out of position)
 *  - every id an assistant message declares is answered somewhere in that
 *    same contiguous run (no partially-answered block)
 */
function assertValidToolPairing(messages: ChatMessage[]): void {
  let i = 0;
  while (i < messages.length) {
    const m = messages[i];
    if (!m?.tool_calls) {
      expect(m?.role).not.toBe("tool"); // bare tool message with no declaring block
      i += 1;
      continue;
    }

    expect(m.tool_calls.length).toBeGreaterThan(0);
    const expectedIds = new Set(m.tool_calls.map((tc) => tc.id));
    expect(expectedIds.size).toBe(m.tool_calls.length); // no duplicate ids in one array

    let j = i + 1;
    const answeredIds = new Set<string>();
    while (j < messages.length && messages[j]?.role === "tool") {
      const id = messages[j]?.tool_call_id ?? "";
      expect(expectedIds.has(id)).toBe(true); // stray tool msg in this run
      answeredIds.add(id);
      j += 1;
    }
    expect(answeredIds).toEqual(expectedIds); // every declared id answered in-block

    i = j;
  }
}

describe("projectForModel", () => {
  it("maps user and assistant entries to chat messages", () => {
    const out = projectForModel([e({ kind: "user", text: "hello" }), e({ kind: "assistant", text: "hi there" })]);
    expect(out).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ]);
  });

  it("CONTRACT: emits a full tool round-trip (assistant tool_calls + role:tool result)", () => {
    const out = projectForModel([
      e({ kind: "user", text: "weather?" }),
      e({ kind: "tool_call", toolCallId: "call_1", toolName: "search", toolArgs: '{"q":"weather"}' }),
      e({ kind: "tool_result", toolCallId: "call_1", toolName: "search", toolArgs: '{"temp":"20C"}' }),
      e({ kind: "assistant", text: "It is 20C." }),
    ]);

    expect(out[1]).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_1", type: "function", function: { name: "search", arguments: '{"q":"weather"}' } }],
    });
    expect(out[2]).toEqual({
      role: "tool",
      tool_call_id: "call_1",
      content: '{"temp":"20C"}',
    });
    expect(out[3]).toEqual({ role: "assistant", content: "It is 20C." });
  });

  it("groups parallel tool calls from the same turn into one assistant message", () => {
    const out = projectForModel([
      e({ kind: "tool_call", turnId: "tp", toolCallId: "c1", toolName: "a", toolArgs: "{}" }),
      e({ kind: "tool_call", turnId: "tp", toolCallId: "c2", toolName: "b", toolArgs: "{}" }),
      e({ kind: "tool_result", turnId: "tp", toolCallId: "c1", toolName: "a", toolArgs: '"ra"' }),
      e({ kind: "tool_result", turnId: "tp", toolCallId: "c2", toolName: "b", toolArgs: '"rb"' }),
    ]);
    expect(out[0]?.tool_calls).toHaveLength(2);
    expect(out[1]).toEqual({ role: "tool", tool_call_id: "c1", content: '"ra"' });
    expect(out[2]).toEqual({ role: "tool", tool_call_id: "c2", content: '"rb"' });
  });

  it("COMPACTION: replays only from the latest compaction entry forward", () => {
    const out = projectForModel([
      e({ kind: "user", text: "ancient" }),
      e({ kind: "assistant", text: "old reply" }),
      e({ kind: "compaction", text: "Summary: user asked about X.", compactedThroughSeq: 2 }),
      e({ kind: "user", text: "recent" }),
    ]);
    expect(out).toEqual([
      { role: "system", content: "Summary: user asked about X." },
      { role: "user", content: "recent" },
    ]);
  });

  it("COMPACTION: drops a dangling tool_result with no tool_call in the slice", () => {
    const out = projectForModel([
      e({ kind: "tool_call", toolCallId: "orphan", toolName: "x", toolArgs: "{}" }),
      e({ kind: "compaction", text: "Summary.", compactedThroughSeq: 1 }),
      e({ kind: "tool_result", toolCallId: "orphan", toolName: "x", toolArgs: '"late"' }),
      e({ kind: "user", text: "next" }),
    ]);
    expect(out.some((m) => m.role === "tool")).toBe(false);
    expect(out).toEqual([
      { role: "system", content: "Summary." },
      { role: "user", content: "next" },
    ]);
  });

  it("renders a cutoff assistant entry as its partial text", () => {
    const out = projectForModel([e({ kind: "assistant", text: "I was saying", cutoff: "barge-in" })]);
    expect(out).toEqual([{ role: "assistant", content: "I was saying" }]);
  });

  it("ORPHAN GUARD: drops a tool_call that never got a result (abort mid-call)", () => {
    // Historical bug: aborting mid-tool-call committed the assistant entry with
    // tool_calls but never wrote the results, poisoning every later request.
    const out = projectForModel([
      e({ kind: "user", text: "do it" }),
      e({ kind: "tool_call", toolCallId: "never_replied", toolName: "search", toolArgs: "{}" }),
      e({ kind: "assistant", text: "stopped", cutoff: "interrupt" }),
    ]);
    expect(out.some((m) => m.tool_calls !== undefined)).toBe(false);
    expect(out).toEqual([
      { role: "user", content: "do it" },
      { role: "assistant", content: "stopped" },
    ]);
  });

  it("ORPHAN GUARD: keeps the replied call and drops the unreplied one", () => {
    const out = projectForModel([
      e({ kind: "tool_call", turnId: "tm", toolCallId: "ok", toolName: "a", toolArgs: "{}" }),
      e({ kind: "tool_call", turnId: "tm", toolCallId: "dead", toolName: "b", toolArgs: "{}" }),
      e({ kind: "tool_result", turnId: "tm", toolCallId: "ok", toolName: "a", toolArgs: '"r"' }),
    ]);
    expect(out[0]?.tool_calls).toHaveLength(1);
    expect(out[0]?.tool_calls?.[0]?.id).toBe("ok");
    expect(out[1]).toEqual({ role: "tool", tool_call_id: "ok", content: '"r"' });
  });

  it("INVARIANT: every emitted tool message has a parent and every tool_call has a reply", () => {
    // Messy input: compaction boundary, an orphan on each side, a valid pair.
    const out = projectForModel([
      e({ kind: "tool_call", toolCallId: "pre_boundary", toolName: "x", toolArgs: "{}" }),
      e({ kind: "compaction", text: "Summary.", compactedThroughSeq: 1 }),
      e({ kind: "tool_result", toolCallId: "pre_boundary", toolName: "x", toolArgs: '"late"' }),
      e({ kind: "tool_call", toolCallId: "unreplied", toolName: "y", toolArgs: "{}" }),
      e({ kind: "tool_call", toolCallId: "good", toolName: "z", toolArgs: "{}" }),
      e({ kind: "tool_result", toolCallId: "good", toolName: "z", toolArgs: '"ok"' }),
    ]);

    const declaredIds = new Set(out.flatMap((m) => m.tool_calls?.map((c) => c.id) ?? []));
    const repliedIds = out.filter((m) => m.role === "tool").map((m) => m.tool_call_id);

    // No tool message without a parent.
    for (const id of repliedIds) expect(declaredIds.has(id ?? "")).toBe(true);
    // No declared call without a reply.
    for (const id of declaredIds) expect(repliedIds).toContain(id);
    expect(declaredIds).toEqual(new Set(["good"]));
  });

  describe("BLOCK ADJACENCY: rejects membership-only pairing across position breaks", () => {
    // Set-membership pairing (old bug) matched any call id in the slice to any
    // reply id in the slice, regardless of position. OpenAI requires role:"tool"
    // to immediately follow the assistant that declared it, so any entry sitting
    // between a tool_call run and its tool_result run must break the pairing.

    it("drops a tool_result that arrives before its tool_call", () => {
      const out = projectForModel([
        e({ kind: "tool_result", toolCallId: "x1", toolName: "a", toolArgs: '"late"' }),
        e({ kind: "tool_call", toolCallId: "x1", toolName: "a", toolArgs: "{}" }),
      ]);
      assertValidToolPairing(out);
      expect(out.some((m) => m.role === "tool")).toBe(false);
    });

    it("drops both sides when a user entry splits a call from its result", () => {
      const out = projectForModel([
        e({ kind: "tool_call", toolCallId: "y1", toolName: "a", toolArgs: "{}" }),
        e({ kind: "user", text: "hold on" }),
        e({ kind: "tool_result", toolCallId: "y1", toolName: "a", toolArgs: '"r"' }),
      ]);
      assertValidToolPairing(out);
      expect(out.some((m) => m.role === "tool")).toBe(false);
      expect(out).toEqual([{ role: "user", content: "hold on" }]);
    });

    it("drops both sides when an assistant narration entry splits a call from its result", () => {
      const out = projectForModel([
        e({ kind: "tool_call", toolCallId: "z1", toolName: "a", toolArgs: "{}" }),
        e({ kind: "assistant", text: "checking…" }),
        e({ kind: "tool_result", toolCallId: "z1", toolName: "a", toolArgs: '"r"' }),
      ]);
      assertValidToolPairing(out);
      expect(out.some((m) => m.role === "tool")).toBe(false);
      expect(out).toEqual([{ role: "assistant", content: "checking…" }]);
    });

    it("keeps the in-block reply and drops the one separated by a system entry", () => {
      const out = projectForModel([
        e({ kind: "tool_call", toolCallId: "p1", toolName: "a", toolArgs: "{}" }),
        e({ kind: "tool_call", toolCallId: "p2", toolName: "b", toolArgs: "{}" }),
        e({ kind: "tool_result", toolCallId: "p1", toolName: "a", toolArgs: '"rp1"' }),
        e({ kind: "system", text: "bg done" }),
        e({ kind: "tool_result", toolCallId: "p2", toolName: "b", toolArgs: '"rp2"' }),
      ]);
      assertValidToolPairing(out);
      const declaredIds = new Set(out.flatMap((m) => m.tool_calls?.map((c) => c.id) ?? []));
      expect(declaredIds).toEqual(new Set(["p1"])); // p2 unanswered in its own run — dropped
    });

    it("drops the later out-of-block completion for a background delegation call", () => {
      const out = projectForModel([
        e({ kind: "user", text: "kick it off" }),
        e({ kind: "tool_call", toolCallId: "bg1", toolName: "delegateTask", toolArgs: "{}" }),
        e({ kind: "tool_result", toolCallId: "bg1", toolName: "delegateTask", toolArgs: '{"taskId":"t1"}' }),
        e({ kind: "assistant", text: "on it" }),
        e({ kind: "tool_result", toolCallId: "bg1", toolName: "delegateTask", toolArgs: '{"done":true}' }),
      ]);
      assertValidToolPairing(out);
      const toolMsgs = out.filter((m) => m.role === "tool");
      expect(toolMsgs).toHaveLength(1);
      expect(toolMsgs[0]).toEqual({ role: "tool", tool_call_id: "bg1", content: '{"taskId":"t1"}' });
    });

    it("dedupes a repeated tool_call id from accumulated streaming deltas", () => {
      const out = projectForModel([
        e({ kind: "tool_call", toolCallId: "d1", toolName: "search", toolArgs: '{"n":1}' }),
        e({ kind: "tool_call", toolCallId: "d1", toolName: "search", toolArgs: '{"n":2}' }),
        e({ kind: "tool_result", toolCallId: "d1", toolName: "search", toolArgs: '"r"' }),
      ]);
      assertValidToolPairing(out);
      expect(out[0]?.tool_calls).toHaveLength(1);
      expect(out[0]?.tool_calls?.[0]).toEqual({
        id: "d1",
        type: "function",
        function: { name: "search", arguments: '{"n":1}' },
      });
    });
  });

  it("COMPACTION: two markers — replays only from the LATEST one forward", () => {
    // Mutation guard: slicing from the FIRST compaction instead of the LAST
    // would keep "b" and both summaries; the correct behavior discards
    // everything up to and including the second marker.
    const out = projectForModel([
      e({ kind: "user", text: "a" }),
      e({ kind: "compaction", text: "S1", compactedThroughSeq: 1 }),
      e({ kind: "user", text: "b" }),
      e({ kind: "compaction", text: "S2", compactedThroughSeq: 3 }),
      e({ kind: "user", text: "c" }),
    ]);
    expect(out).toEqual([
      { role: "system", content: "S2" },
      { role: "user", content: "c" },
    ]);
  });
});
