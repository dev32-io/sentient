import { describe, expect, it } from "bun:test";
import type { SessionEntry } from "./entry-types.js";
import type { ChatMessage } from "./model-projection.js";
import { BACKGROUND_COMPLETION_INSTRUCTION, projectForModel } from "./model-projection.js";

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
    pendingId: null,
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

  // D16. A `trigger` entry is a stimulus nobody typed — a background task
  // completing today, a sensor reading or a scheduled wake later. Projected as
  // role:"user" the model reads it as the person pasting a result into the
  // chat and answers the person ("Great! Let me know if you'd like to use that
  // description somewhere.") instead of relaying what came back. Observed live
  // twice; the delegated content never reached the human at all.
  it("INVARIANT: a background completion projects as system, never as the user", () => {
    const out = projectForModel([
      e({ kind: "user", text: "do the thing" }),
      e({ kind: "trigger", text: "Background task t1 (delegateTask) completed." }),
    ]);
    const completion = out.at(-2);
    expect(completion?.role).toBe("system");
    expect(completion?.content).toContain("t1");
  });

  // D16, second half (task 8b). role:"system" is right and stays, but these
  // models will not VOLUNTEER a reply to a system message — they answer users.
  // Measured: 0/9 relays on gpt-oss:20b, and `completionTokens=1 textLength=0`
  // on deepseek-v4-flash. So the completion is followed by a fixed instruction
  // in the user role: the harness speaking, carrying none of the payload.
  it("INVARIANT: a background completion is followed by a user-role instruction, and the payload stays in the system message", () => {
    const out = projectForModel([
      e({ kind: "user", text: "delegate the thing" }),
      e({ kind: "trigger", text: "Delegated task t1 … completed: PAYLOAD" }),
    ]);
    const last = out.at(-1);
    expect(last?.role).toBe("user");
    expect(last?.content).toBe(BACKGROUND_COMPLETION_INSTRUCTION);
    expect(out.at(-2)?.role).toBe("system");
    expect(out.at(-2)?.content).toContain("PAYLOAD");
    // The trust boundary, not a style check: a delegated agent reads the open
    // web, so its output is the lowest-trust input there is. Promoting any of
    // it into the user's voice is the injection surface this shape avoids.
    expect(last?.content).not.toContain("PAYLOAD");
  });

  it("INVARIANT: the instruction is emitted only alongside a completion, never alone", () => {
    const out = projectForModel([e({ kind: "user", text: "hello" })]);
    expect(out.filter((m) => m.content === BACKGROUND_COMPLETION_INSTRUCTION)).toHaveLength(0);
  });

  it("INVARIANT: two completions get two instructions, each after its own payload", () => {
    // One instruction covering both payloads leaves the model no way to say
    // which it is answering — the reason the note echoes a task id at all.
    const out = projectForModel([
      e({ kind: "user", text: "delegate two things" }),
      e({ kind: "trigger", text: "task t1 completed: FIRST" }),
      e({ kind: "trigger", text: "task t2 completed: SECOND" }),
    ]);
    expect(out).toEqual([
      { role: "user", content: "delegate two things" },
      { role: "system", content: "task t1 completed: FIRST" },
      { role: "user", content: BACKGROUND_COMPLETION_INSTRUCTION },
      { role: "system", content: "task t2 completed: SECOND" },
      { role: "user", content: BACKGROUND_COMPLETION_INSTRUCTION },
    ]);
  });

  // CACHE STABILITY (spec §3.2): the model projection's prefix must never be
  // rewritten by a later turn. The instruction is appended immediately after
  // the completion it belongs to, so a second completion landing later extends
  // the array and touches nothing before it.
  it("INVARIANT: a later completion only appends — the earlier prefix is byte-identical", () => {
    const first = [e({ kind: "user", text: "go" }), e({ kind: "trigger", text: "task t1 completed: FIRST" })];
    const before = projectForModel(first);
    const after = projectForModel([
      ...first,
      e({ kind: "assistant", text: "here is the first" }),
      e({ kind: "trigger", text: "task t2 completed: SECOND" }),
    ]);
    expect(after.slice(0, before.length)).toEqual(before);
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
    // to immediately follow the assistant that declared it, so an entry sitting
    // between a tool_call run and its tool_result run must break the pairing —
    // with one exception, spelled out below: an external STIMULUS (user /
    // trigger) is deferred past the block rather than closing it, because the
    // store's tail is legitimately split open across the tool's own await.

    it("drops a tool_result that arrives before its tool_call", () => {
      const out = projectForModel([
        e({ kind: "tool_result", toolCallId: "x1", toolName: "a", toolArgs: '"late"' }),
        e({ kind: "tool_call", toolCallId: "x1", toolName: "a", toolArgs: "{}" }),
      ]);
      assertValidToolPairing(out);
      expect(out.some((m) => m.role === "tool")).toBe(false);
    });

    it("CONTRACT: a user message landing mid-dispatch is deferred, not allowed to break the round trip", () => {
      // `dispatchToolCalls` appends the tool_call, awaits the tool, THEN appends
      // the result — so the store's tail is split open for the whole call, and
      // that is exactly the window spec §4.5's steer seam appends into.
      // Dropping both halves here made the next iteration's messages[] hold no
      // record the tool had ever run, and the model re-issued the identical
      // call: the light switched twice.
      const out = projectForModel([
        e({ kind: "tool_call", toolCallId: "y1", toolName: "a", toolArgs: "{}" }),
        e({ kind: "user", text: "hold on" }),
        e({ kind: "tool_result", toolCallId: "y1", toolName: "a", toolArgs: '"r"' }),
      ]);
      assertValidToolPairing(out);
      expect(out).toEqual([
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "y1", type: "function", function: { name: "a", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "y1", content: '"r"' },
        { role: "user", content: "hold on" },
      ]);
    });

    it("CONTRACT: a background completion landing mid-dispatch is deferred the same way", () => {
      const out = projectForModel([
        e({ kind: "tool_call", toolCallId: "y2", toolName: "a", toolArgs: "{}" }),
        e({ kind: "trigger", text: "task t1 finished" }),
        e({ kind: "tool_result", toolCallId: "y2", toolName: "a", toolArgs: '"r"' }),
      ]);
      assertValidToolPairing(out);
      expect(out.filter((m) => m.role === "tool")).toHaveLength(1);
      // D16 applies on the DEFERRED path too — and this is the path a
      // completion takes whenever a second delegation is still mid-dispatch,
      // i.e. every concurrent case. Fixing only the straight-line branch
      // leaves the concurrent case projecting the task as the person.
      expect(out.at(-2)).toEqual({ role: "system", content: "task t1 finished" });
    });

    it("INVARIANT: a completion deferred past a tool block still gets its user-role instruction", () => {
      // Written as its own case through the DEFERRED path rather than as an
      // assertion on the shared helper: wave 1 shipped a one-line D16 fix that
      // covered the straight-line branch only, and this is the branch every
      // concurrent delegation takes.
      const out = projectForModel([
        e({ kind: "tool_call", toolCallId: "y4", toolName: "a", toolArgs: "{}" }),
        e({ kind: "trigger", text: "task t1 completed: PAYLOAD" }),
        e({ kind: "tool_result", toolCallId: "y4", toolName: "a", toolArgs: '"r"' }),
      ]);
      assertValidToolPairing(out);
      const last = out.at(-1);
      expect(last).toEqual({ role: "user", content: BACKGROUND_COMPLETION_INSTRUCTION });
      expect(last?.content).not.toContain("PAYLOAD");
      expect(out.at(-2)?.content).toContain("PAYLOAD");
    });

    it("INVARIANT: a user message deferred past a tool block gets no instruction", () => {
      // The instruction belongs to a `trigger`, not to every deferred stimulus.
      const out = projectForModel([
        e({ kind: "tool_call", toolCallId: "y5", toolName: "a", toolArgs: "{}" }),
        e({ kind: "user", text: "hold on" }),
        e({ kind: "tool_result", toolCallId: "y5", toolName: "a", toolArgs: '"r"' }),
      ]);
      expect(out.filter((m) => m.content === BACKGROUND_COMPLETION_INSTRUCTION)).toHaveLength(0);
    });

    it("does not defer a stimulus past a block whose calls are all already answered", () => {
      const out = projectForModel([
        e({ kind: "tool_call", toolCallId: "y3", toolName: "a", toolArgs: "{}" }),
        e({ kind: "tool_result", toolCallId: "y3", toolName: "a", toolArgs: '"r"' }),
        e({ kind: "user", text: "and now this" }),
        e({ kind: "assistant", text: "done" }),
      ]);
      assertValidToolPairing(out);
      expect(out.map((m) => m.role)).toEqual(["assistant", "tool", "user", "assistant"]);
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

    it("keeps the first tool_result content when a call id has two results in one block", () => {
      // Mutation guard: a last-wins map would emit "second" here instead of
      // "first" — kills that mutant.
      const out = projectForModel([
        e({ kind: "tool_call", toolCallId: "bg1", toolName: "delegateTask", toolArgs: "{}" }),
        e({ kind: "tool_result", toolCallId: "bg1", toolName: "delegateTask", toolArgs: '"first"' }),
        e({ kind: "tool_result", toolCallId: "bg1", toolName: "delegateTask", toolArgs: '"second"' }),
      ]);
      assertValidToolPairing(out);
      const toolMsgs = out.filter((m) => m.role === "tool");
      expect(toolMsgs).toHaveLength(1);
      expect(toolMsgs[0]).toEqual({ role: "tool", tool_call_id: "bg1", content: '"first"' });
    });

    it("emits tool messages in call-declaration order, not result-arrival order", () => {
      // Results for a and b arrive reversed (b then a); the emitted tool
      // messages must still follow declaration order (a then b) — pins the
      // ordering the fix in emitToolBlock depends on for validity.
      const out = projectForModel([
        e({ kind: "tool_call", turnId: "tr", toolCallId: "a", toolName: "x", toolArgs: "{}" }),
        e({ kind: "tool_call", turnId: "tr", toolCallId: "b", toolName: "y", toolArgs: "{}" }),
        e({ kind: "tool_result", turnId: "tr", toolCallId: "b", toolName: "y", toolArgs: '"rb"' }),
        e({ kind: "tool_result", turnId: "tr", toolCallId: "a", toolName: "x", toolArgs: '"ra"' }),
      ]);
      assertValidToolPairing(out);
      const toolMsgs = out.filter((m) => m.role === "tool");
      expect(toolMsgs).toEqual([
        { role: "tool", tool_call_id: "a", content: '"ra"' },
        { role: "tool", tool_call_id: "b", content: '"rb"' },
      ]);
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

// ---------------------------------------------------------------------------
// Message stamps. Without them the model cannot tell a reply three seconds
// later from one the next morning, and answers every dated question from a
// training cutoff it cannot locate itself relative to.
// ---------------------------------------------------------------------------

describe("projectForModel — message stamps", () => {
  const AT = Date.UTC(2026, 7, 5, 13, 12, 3);

  it("wraps a stimulus in an envelope carrying an offset-bearing ISO instant", () => {
    const [message] = projectForModel([e({ kind: "user", text: "what is the news", createdAt: AT })], {
      timeZone: "UTC",
    });

    expect(message?.role).toBe("user");
    expect(message?.content).toBe('<msg at="2026-08-05T13:12:03+00:00">\nwhat is the news\n</msg>');
  });

  it("renders the stamp in the supplied zone, with that zone's offset", () => {
    const [message] = projectForModel([e({ kind: "user", text: "hi", createdAt: AT })], {
      timeZone: "America/Toronto",
    });

    // The SAME instant, in the zone the household is in. An explicit offset is
    // what lets a later zone change leave this message's stamp still true.
    expect(message?.content).toContain('at="2026-08-05T09:12:03-04:00"');
  });

  it("leaves the assistant's own messages unstamped", () => {
    const messages = projectForModel(
      [e({ kind: "user", text: "hello", createdAt: AT }), e({ kind: "assistant", text: "hi there", createdAt: AT })],
      { timeZone: "UTC" },
    );

    expect(messages[1]).toEqual({ role: "assistant", content: "hi there" });
  });

  it("omits the envelope entirely when no zone is supplied", () => {
    const [message] = projectForModel([e({ kind: "user", text: "plain", createdAt: AT })]);

    expect(message?.content).toBe("plain");
  });
});
