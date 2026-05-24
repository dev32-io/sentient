import { describe, expect, it, vi } from "vitest";
import { createConversationMirror } from "./conversation-mirror.js";
import type { MirrorEntry } from "./conversation-mirror.js";

describe("ConversationMirror", () => {
  it("appends and snapshots entries", () => {
    const m = createConversationMirror();
    m.append({ kind: "user", ts: 1, channel: "speech", content: "hi" });
    m.append({ kind: "assistant", ts: 2, content: "hello" });
    expect(m.snapshot()).toHaveLength(2);
  });

  it("caps at capacity with FIFO eviction", () => {
    const m = createConversationMirror(3);
    for (let i = 0; i < 5; i++) {
      m.append({ kind: "user", ts: i, channel: "text", content: String(i) });
    }
    const s = m.snapshot();
    expect(s).toHaveLength(3);
    const first = s[0] as Extract<MirrorEntry, { kind: "user" }>;
    expect(first.content).toBe("2");
    const last = s[2] as Extract<MirrorEntry, { kind: "user" }>;
    expect(last.content).toBe("4");
  });

  it("clears all entries", () => {
    const m = createConversationMirror();
    m.append({ kind: "user", ts: 1, channel: "text", content: "x" });
    m.clear();
    expect(m.snapshot()).toEqual([]);
    expect(m.size()).toBe(0);
  });

  it("reports size correctly", () => {
    const m = createConversationMirror();
    expect(m.size()).toBe(0);
    m.append({ kind: "user", ts: 1, channel: "text", content: "a" });
    expect(m.size()).toBe(1);
  });

  it("accepts assistant entry with barge-in cutoff", () => {
    const m = createConversationMirror();
    m.append({
      kind: "assistant",
      ts: 1,
      content: "half a reply",
      cutoff: { kind: "barge-in" },
    });
    const s = m.snapshot();
    const first = s[0] as Extract<MirrorEntry, { kind: "assistant" }>;
    expect(first.cutoff?.kind).toBe("barge-in");
  });

  it("accepts assistant entry with interrupt cutoff", () => {
    const m = createConversationMirror();
    m.append({
      kind: "assistant",
      ts: 1,
      content: "aborted",
      cutoff: { kind: "interrupt", cancelledTaskIds: ["t1", "t2"] },
    });
    const s = m.snapshot();
    const first = s[0] as Extract<MirrorEntry, { kind: "assistant" }>;
    expect(first.cutoff?.kind).toBe("interrupt");
  });

  it("accepts assistant entry with length-cap cutoff", () => {
    const m = createConversationMirror();
    m.append({
      kind: "assistant",
      ts: 1,
      content: "truncated",
      cutoff: { kind: "length-cap" },
    });
    const s = m.snapshot();
    const first = s[0] as Extract<MirrorEntry, { kind: "assistant" }>;
    expect(first.cutoff?.kind).toBe("length-cap");
  });

  it("accepts tool entry", () => {
    const m = createConversationMirror();
    m.append({ kind: "tool", ts: 1, toolName: "search", status: "finished", summary: "done" });
    const s = m.snapshot();
    const first = s[0] as Extract<MirrorEntry, { kind: "tool" }>;
    expect(first.toolName).toBe("search");
    expect(first.status).toBe("finished");
  });

  it("accepts trigger entry", () => {
    const m = createConversationMirror();
    m.append({ kind: "trigger", ts: 1, source: "sensor.door", summary: "door opened" });
    const s = m.snapshot();
    const first = s[0] as Extract<MirrorEntry, { kind: "trigger" }>;
    expect(first.source).toBe("sensor.door");
  });

  it("snapshot returns a copy (mutations do not affect mirror)", () => {
    const m = createConversationMirror();
    m.append({ kind: "user", ts: 1, channel: "text", content: "hi" });
    const snap = m.snapshot();
    (snap as MirrorEntry[]).push({ kind: "user", ts: 99, channel: "text", content: "injected" });
    expect(m.size()).toBe(1);
  });

  it("defaults capacity to 500", () => {
    const m = createConversationMirror();
    for (let i = 0; i < 501; i++) {
      m.append({ kind: "user", ts: i, channel: "text", content: String(i) });
    }
    expect(m.size()).toBe(500);
  });
});

describe("ConversationMirror.replaceAll", () => {
  it("emits onSnapshot exactly once and never onAppend", () => {
    const mirror = createConversationMirror(500);
    const onAppend = vi.fn();
    const onSnapshot = vi.fn();
    mirror.onAppend(onAppend);
    mirror.onSnapshot(onSnapshot);

    const entries: MirrorEntry[] = [
      { kind: "user", ts: 1, channel: "text", content: "hi" },
      { kind: "assistant", ts: 2, content: "hello" },
      { kind: "user", ts: 3, channel: "text", content: "how" },
    ];
    mirror.replaceAll(entries);

    expect(onAppend).not.toHaveBeenCalled();
    expect(onSnapshot).toHaveBeenCalledTimes(1);
    expect(onSnapshot).toHaveBeenCalledWith(entries);
  });

  it("trims to capacity, keeping the tail", () => {
    const mirror = createConversationMirror(2);
    mirror.replaceAll([
      { kind: "user", ts: 1, channel: "text", content: "a" },
      { kind: "user", ts: 2, channel: "text", content: "b" },
      { kind: "user", ts: 3, channel: "text", content: "c" },
    ]);
    expect(mirror.size()).toBe(2);
    expect(mirror.snapshot().map((e) => (e.kind === "user" ? e.content : ""))).toEqual(["b", "c"]);
  });

  it("after replaceAll, subsequent append still emits onAppend", () => {
    const mirror = createConversationMirror(500);
    const onAppend = vi.fn();
    mirror.onAppend(onAppend);
    mirror.replaceAll([{ kind: "user", ts: 1, channel: "text", content: "seeded" }]);
    mirror.append({ kind: "user", ts: 2, channel: "text", content: "new" });
    expect(onAppend).toHaveBeenCalledTimes(1);
  });

  it("replaceAll with empty array clears the buffer and emits empty snapshot", () => {
    const mirror = createConversationMirror(500);
    mirror.append({ kind: "user", ts: 1, channel: "text", content: "x" });
    const onSnapshot = vi.fn();
    mirror.onSnapshot(onSnapshot);
    mirror.replaceAll([]);
    expect(mirror.size()).toBe(0);
    expect(onSnapshot).toHaveBeenCalledWith([]);
  });
});
