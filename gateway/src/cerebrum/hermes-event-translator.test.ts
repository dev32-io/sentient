import { describe, expect, it } from "vitest";
import { createConversationMirror } from "./conversation-mirror.js";
import { translateHermesStream } from "./hermes-event-translator.js";
import type { HermesEvent } from "./hermes-event-types.js";
import { createTaskMirror } from "./task-mirror.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function* events(list: HermesEvent[]): AsyncGenerator<HermesEvent> {
  for (const ev of list) {
    yield ev;
  }
}

function makeContext() {
  return {
    sessionId: "s1",
    cycleId: "c1",
    userId: "u1",
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("translateHermesStream", () => {
  it("emits correct wire messages for text-only happy path", async () => {
    const ctx = makeContext();
    const mirror = createConversationMirror();
    const tasks = createTaskMirror();
    const emitted: Record<string, unknown>[] = [];
    let conversationId = "";

    const input: HermesEvent[] = [
      { type: "created", responseId: "r1", conversationId: "conv1" },
      { type: "text.delta", delta: "Hello " },
      { type: "text.delta", delta: "world" },
      { type: "completed", usage: { inputTokens: 10, outputTokens: 5 } },
    ];

    await translateHermesStream(
      events(input),
      ctx,
      mirror,
      tasks,
      (m) => {
        emitted.push(m);
      },
      (id) => {
        conversationId = id;
      },
    );

    expect(conversationId).toBe("conv1");

    // cycle.started → message.delta×2 → message.done → conversation.entry (assistant) → cycle.completed
    expect(emitted[0]).toEqual({
      type: "cycle.started",
      cycleId: "c1",
      triggerKind: "conversation.user",
      triggerSource: "u1",
    });
    expect(emitted[1]).toEqual({ type: "message.delta", cycleId: "c1", delta: "Hello " });
    expect(emitted[2]).toEqual({ type: "message.delta", cycleId: "c1", delta: "world" });
    expect(emitted[3]).toEqual({ type: "message.done", cycleId: "c1" });

    const entry4 = emitted[4] as Record<string, unknown>;
    expect(entry4.type).toBe("conversation.entry");
    expect(entry4.cycleId).toBe("c1");
    const entry = entry4.item as Record<string, unknown>;
    expect(entry.kind).toBe("assistant");
    expect(entry.content).toBe("Hello world");
    // entryId must be a non-empty string on every committed entry (Slice 3/4 dedupe).
    expect(typeof entry.entryId).toBe("string");
    expect((entry.entryId as string).length).toBeGreaterThan(0);

    expect(emitted[5]).toEqual({
      type: "cycle.completed",
      cycleId: "c1",
      effectsInvoked: [],
    });

    expect(mirror.size()).toBe(1);
    const snap = mirror.snapshot();
    const assistantEntry = snap[0] as Extract<(typeof snap)[0], { kind: "assistant" }>;
    expect(assistantEntry.content).toBe("Hello world");
    expect(typeof assistantEntry.entryId).toBe("string");
    expect(assistantEntry.entryId.length).toBeGreaterThan(0);
  });

  it("emits correct wire messages for tool call lifecycle", async () => {
    const ctx = makeContext();
    const mirror = createConversationMirror();
    const tasks = createTaskMirror();
    const emitted: Record<string, unknown>[] = [];
    let conversationId = "";

    const input: HermesEvent[] = [
      { type: "created", responseId: "r1", conversationId: "conv2" },
      { type: "tool.started", callId: "call1", toolName: "search", argsPreview: "weather" },
      { type: "tool.finished", callId: "call1", status: "ok", summary: "found results" },
      { type: "completed", usage: { inputTokens: 20, outputTokens: 10 } },
    ];

    await translateHermesStream(
      events(input),
      ctx,
      mirror,
      tasks,
      (m) => {
        emitted.push(m);
      },
      (id) => {
        conversationId = id;
      },
    );

    expect(conversationId).toBe("conv2");

    // cycle.started → task.update(running) → task.update(finished) → conversation.entry(tool) → message.done → cycle.completed
    expect(emitted[0]).toEqual({
      type: "cycle.started",
      cycleId: "c1",
      triggerKind: "conversation.user",
      triggerSource: "u1",
    });

    // task.update running
    const running = emitted[1] as Record<string, unknown>;
    expect(running.type).toBe("task.update");
    expect(running.taskId).toBe("call1");
    expect(running.toolName).toBe("search");
    expect(running.status).toBe("running");
    expect(running.cycleId).toBe("c1");
    expect(running.argsPreview).toBe("weather");

    // task.update finished
    const finished = emitted[2] as Record<string, unknown>;
    expect(finished.type).toBe("task.update");
    expect(finished.taskId).toBe("call1");
    expect(finished.status).toBe("finished");
    expect(finished.endedAtMs).toBeDefined();
    // argsPreview must persist on terminal updates — TaskStatusConnector
    // overwrites the snapshot wholesale; without this, the pill empties.
    expect(finished.argsPreview).toBe("weather");

    // conversation.entry (tool)
    const toolEntry = emitted[3] as Record<string, unknown>;
    expect(toolEntry.type).toBe("conversation.entry");
    expect(toolEntry.cycleId).toBe("c1");
    const toolData = toolEntry.item as Record<string, unknown>;
    expect(toolData.kind).toBe("tool");
    expect(toolData.toolName).toBe("search");
    expect(toolData.status).toBe("finished");
    expect(toolData.summary).toBe("found results");
    expect(typeof toolData.entryId).toBe("string");
    expect((toolData.entryId as string).length).toBeGreaterThan(0);

    // message.done (no assistant text, but still emitted)
    expect(emitted[4]).toEqual({ type: "message.done", cycleId: "c1" });

    // No assistant entry because assistantText is empty
    // cycle.completed
    const completed = emitted[5] as Record<string, unknown>;
    expect(completed.type).toBe("cycle.completed");
    expect(completed.cycleId).toBe("c1");
    expect(completed.effectsInvoked).toEqual(["search"]);

    expect(mirror.size()).toBe(1);
    expect(mirror.snapshot()[0]?.kind).toBe("tool");
  });

  it("handles error path with cycle.aborted and cutoff assistant entry", async () => {
    const ctx = makeContext();
    const mirror = createConversationMirror();
    const tasks = createTaskMirror();
    const emitted: Record<string, unknown>[] = [];

    const input: HermesEvent[] = [
      { type: "created", responseId: "r1", conversationId: "conv3" },
      { type: "text.delta", delta: "partial" },
      { type: "error", message: "model overloaded" },
    ];

    await translateHermesStream(
      events(input),
      ctx,
      mirror,
      tasks,
      (m) => {
        emitted.push(m);
      },
      () => {},
    );

    // cycle.started → message.delta → error → cycle.aborted → conversation.entry with cutoff
    expect(emitted[0]).toEqual({
      type: "cycle.started",
      cycleId: "c1",
      triggerKind: "conversation.user",
      triggerSource: "u1",
    });
    expect(emitted[1]).toEqual({ type: "message.delta", cycleId: "c1", delta: "partial" });
    expect(emitted[2]).toEqual({ type: "error", code: "hermes", message: "model overloaded" });
    expect(emitted[3]).toEqual({ type: "cycle.aborted", cycleId: "c1", reason: "error" });

    // Conversation entry with cutoff
    const entry = emitted[4] as Record<string, unknown>;
    expect(entry.type).toBe("conversation.entry");
    expect(entry.cycleId).toBe("c1");
    const entryData = entry.item as Record<string, unknown>;
    expect(entryData.kind).toBe("assistant");
    expect(entryData.content).toBe("partial");

    const cutoff = entryData.cutoff as Record<string, unknown>;
    expect(cutoff.kind).toBe("interrupt");
    expect(cutoff.cancelledTaskIds).toEqual([]);

    expect(mirror.size()).toBe(1);
  });

  it("handles iterator throw same as error event", async () => {
    const ctx = makeContext();
    const mirror = createConversationMirror();
    const tasks = createTaskMirror();
    const emitted: Record<string, unknown>[] = [];

    async function* throwingEvents(): AsyncGenerator<HermesEvent> {
      yield { type: "created", responseId: "r1", conversationId: "conv4" };
      yield { type: "text.delta", delta: "oops" };
      throw new Error("connection lost");
    }

    await translateHermesStream(
      throwingEvents(),
      ctx,
      mirror,
      tasks,
      (m) => {
        emitted.push(m);
      },
      () => {},
    );

    // cycle.started → message.delta → error (from throw) → cycle.aborted → conversation.entry with cutoff
    expect(emitted[0]).toEqual({
      type: "cycle.started",
      cycleId: "c1",
      triggerKind: "conversation.user",
      triggerSource: "u1",
    });
    expect(emitted[1]).toEqual({ type: "message.delta", cycleId: "c1", delta: "oops" });

    const errorMsg = emitted[2] as Record<string, unknown>;
    expect(errorMsg.type).toBe("error");
    expect(errorMsg.code).toBe("hermes");
    expect(errorMsg.message).toBe("connection lost");

    expect(emitted[3]).toEqual({ type: "cycle.aborted", cycleId: "c1", reason: "error" });

    const entry = emitted[4] as Record<string, unknown>;
    expect(entry.type).toBe("conversation.entry");
    const entryData = entry.item as Record<string, unknown>;
    expect(entryData.kind).toBe("assistant");
    expect(entryData.content).toBe("oops");
    const cutoff = entryData.cutoff as Record<string, unknown>;
    expect(cutoff.kind).toBe("interrupt");
  });

  it("deduplicates effectsInvoked on cycle.completed", async () => {
    const ctx = makeContext();
    const mirror = createConversationMirror();
    const tasks = createTaskMirror();
    const emitted: Record<string, unknown>[] = [];

    const input: HermesEvent[] = [
      { type: "created", responseId: "r1", conversationId: "conv5" },
      { type: "tool.started", callId: "c1", toolName: "search", argsPreview: "a" },
      { type: "tool.started", callId: "c2", toolName: "search", argsPreview: "b" },
      { type: "tool.finished", callId: "c1", status: "ok", summary: "done a" },
      { type: "tool.finished", callId: "c2", status: "ok", summary: "done b" },
      { type: "completed", usage: { inputTokens: 5, outputTokens: 5 } },
    ];

    await translateHermesStream(
      events(input),
      ctx,
      mirror,
      tasks,
      (m) => {
        emitted.push(m);
      },
      () => {},
    );

    const completed = emitted.find((m) => m.type === "cycle.completed") as Record<string, unknown>;
    expect(completed.effectsInvoked).toEqual(["search"]);
  });

  it("does not emit conversation.entry for assistant when text is empty on completed", async () => {
    const ctx = makeContext();
    const mirror = createConversationMirror();
    const tasks = createTaskMirror();
    const emitted: Record<string, unknown>[] = [];

    const input: HermesEvent[] = [
      { type: "created", responseId: "r1", conversationId: "conv6" },
      { type: "completed", usage: { inputTokens: 5, outputTokens: 0 } },
    ];

    await translateHermesStream(
      events(input),
      ctx,
      mirror,
      tasks,
      (m) => {
        emitted.push(m);
      },
      () => {},
    );

    // cycle.started → message.done → cycle.completed
    // No conversation.entry for assistant (no text)
    const entryMessages = emitted.filter((m) => m.type === "conversation.entry");
    expect(entryMessages).toHaveLength(0);
    expect(mirror.size()).toBe(0);
  });

  it("maps tool.finished failed status correctly", async () => {
    const ctx = makeContext();
    const mirror = createConversationMirror();
    const tasks = createTaskMirror();
    const emitted: Record<string, unknown>[] = [];

    const input: HermesEvent[] = [
      { type: "created", responseId: "r1", conversationId: "conv7" },
      { type: "tool.started", callId: "c1", toolName: "badtool", argsPreview: "x" },
      { type: "tool.finished", callId: "c1", status: "failed", summary: "exploded" },
      { type: "completed", usage: { inputTokens: 5, outputTokens: 3 } },
    ];

    await translateHermesStream(
      events(input),
      ctx,
      mirror,
      tasks,
      (m) => {
        emitted.push(m);
      },
      () => {},
    );

    const finished = emitted.find((m) => m.type === "task.update" && m.status === "failed") as Record<string, unknown>;
    expect(finished).toBeDefined();
    expect(finished.taskId).toBe("c1");

    const toolEntry = emitted.find((m) => m.type === "conversation.entry") as Record<string, unknown>;
    const entryData = toolEntry.item as Record<string, unknown>;
    expect(entryData.status).toBe("failed");
  });

  it("emits cycle.aborted with interrupt reason when stream ends without terminal event", async () => {
    // Wire-protocol contract: when the dispatcher's queue is finished
    // mid-flight (user.cancel → user-interrupt path post-c71bcd6), the
    // for-await loop exits without seeing `completed` or `error`. The
    // translator MUST emit `cycle.aborted` so the SDK's
    // InFlightMessageConnector clears its buffer; otherwise the
    // streaming bubble keeps rendering after a session switch.
    const ctx = makeContext();
    const mirror = createConversationMirror();
    const tasks = createTaskMirror();
    const emitted: Record<string, unknown>[] = [];

    const input: HermesEvent[] = [
      { type: "created", responseId: "r1", conversationId: "conv9" },
      { type: "text.delta", delta: "partial-mid-flight" },
      // No `completed` and no `error` — simulates queue.finish() from
      // WsHermesClient.dispatch's onAbort handler.
    ];

    await translateHermesStream(
      events(input),
      ctx,
      mirror,
      tasks,
      (m) => {
        emitted.push(m);
      },
      () => {},
    );

    const aborted = emitted.find((m) => m.type === "cycle.aborted") as Record<string, unknown>;
    expect(aborted).toBeDefined();
    expect(aborted.cycleId).toBe("c1");
    expect(aborted.reason).toBe("interrupt");

    // Partial assistant text gets committed with cutoff: interrupt so the
    // OLD session's history surfaces the truncated turn on re-fetch.
    const entry = emitted.find((m) => m.type === "conversation.entry") as Record<string, unknown>;
    expect(entry).toBeDefined();
    const item = entry.item as Record<string, unknown>;
    expect(item.kind).toBe("assistant");
    expect(item.content).toBe("partial-mid-flight");
    const cutoff = item.cutoff as Record<string, unknown>;
    expect(cutoff.kind).toBe("interrupt");
  });

  it("calls tasks.clearCycle on error path", async () => {
    const ctx = makeContext();
    const mirror = createConversationMirror();
    const tasks = createTaskMirror();
    const emitted: Record<string, unknown>[] = [];

    const input: HermesEvent[] = [
      { type: "created", responseId: "r1", conversationId: "conv8" },
      { type: "tool.started", callId: "c1", toolName: "search", argsPreview: "x" },
      { type: "error", message: "boom" },
    ];

    await translateHermesStream(
      events(input),
      ctx,
      mirror,
      tasks,
      (m) => {
        emitted.push(m);
      },
      () => {},
    );

    // Task that was started should now be cancelled by clearCycle
    const snap = tasks.snapshot();
    const task = snap.find((r) => r.taskId === "c1");
    expect(task?.status).toBe("cancelled");
  });

  it("two distinct commits get distinct entryIds", async () => {
    // Wire-protocol contract (Slice 3/4): each committed conversation.entry
    // carries a unique entryId so the client can dedupe on replay.
    const ctx = makeContext();
    const mirror = createConversationMirror();
    const tasks = createTaskMirror();
    const emitted: Record<string, unknown>[] = [];

    const input: HermesEvent[] = [
      { type: "created", responseId: "r1", conversationId: "conv-distinct" },
      { type: "tool.started", callId: "call1", toolName: "search", argsPreview: "x" },
      { type: "tool.finished", callId: "call1", status: "ok", summary: "done" },
      { type: "text.delta", delta: "hello" },
      { type: "completed", usage: { inputTokens: 5, outputTokens: 3 } },
    ];

    await translateHermesStream(
      events(input),
      ctx,
      mirror,
      tasks,
      (m) => {
        emitted.push(m);
      },
      () => {},
    );

    const entries = emitted
      .filter((m) => m.type === "conversation.entry")
      .map((m) => (m.item as Record<string, unknown>).entryId as string);

    expect(entries).toHaveLength(2); // tool + assistant
    expect(entries[0]).toBeDefined();
    expect(entries[1]).toBeDefined();
    expect(entries[0]).not.toBe(entries[1]);
  });
});
