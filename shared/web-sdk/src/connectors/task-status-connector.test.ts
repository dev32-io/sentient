import { describe, expect, it, vi } from "vitest";
import type { SentientSDKInternal } from "../connector-types.ts";
import { TaskStatusConnector } from "./task-status-connector.ts";

function createMockInternal(): SentientSDKInternal & {
  messageHandlers: Map<string, (msg: unknown) => void>;
} {
  const messageHandlers = new Map<string, (msg: unknown) => void>();
  return {
    messageHandlers,
    send() {},
    sendBinary() {},
    onMessage(type: string, handler: (msg: unknown) => void) {
      messageHandlers.set(type, handler);
      return () => {
        messageHandlers.delete(type);
      };
    },
    onBinary(_handler: (data: ArrayBuffer) => void) {
      return () => {};
    },
  };
}

describe("TaskStatusConnector", () => {
  it("has capability task.status and kind status", () => {
    const connector = new TaskStatusConnector();
    expect(connector.capability).toBe("task.status");
    expect(connector.kind).toBe("status");
  });

  it("starts with an empty list", () => {
    const connector = new TaskStatusConnector();
    expect(connector.list()).toEqual([]);
  });

  it("parses task.update and threads cycleId into snapshot", () => {
    const onUpdate = vi.fn();
    const connector = new TaskStatusConnector({ onUpdate });
    const internal = createMockInternal();
    connector.attach(internal);

    internal.messageHandlers.get("task.update")?.({
      type: "task.update",
      taskId: "t-1",
      toolName: "search",
      cycleId: "cycle-1",
      status: "running",
      argsPreview: "query=hello",
      startedAtMs: 1000,
    });

    const items = connector.list();
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({
      taskId: "t-1",
      toolName: "search",
      cycleId: "cycle-1",
      status: "running",
      argsPreview: "query=hello",
      startedAtMs: 1000,
    });
    expect(onUpdate).toHaveBeenCalledWith(items[0]);
  });

  it("preserves distinct cycleIds across tasks from different cycles", () => {
    const internal = createMockInternal();
    const connector = new TaskStatusConnector();
    connector.attach(internal);
    const handler = internal.messageHandlers.get("task.update");
    if (!handler) throw new Error("no handler");

    handler({
      type: "task.update",
      taskId: "t1",
      toolName: "play_music",
      cycleId: "cycle-A",
      status: "running",
      argsPreview: "",
      startedAtMs: 100,
    });
    handler({
      type: "task.update",
      taskId: "t2",
      toolName: "run_scene",
      cycleId: "cycle-B",
      status: "running",
      argsPreview: "",
      startedAtMs: 200,
    });

    const items = connector.list();
    expect(items).toHaveLength(2);
    expect(items.find((t) => t.taskId === "t1")?.cycleId).toBe("cycle-A");
    expect(items.find((t) => t.taskId === "t2")?.cycleId).toBe("cycle-B");
  });

  it("requires cycleId and rejects missing field", () => {
    const onUpdate = vi.fn();
    const connector = new TaskStatusConnector({ onUpdate });
    const internal = createMockInternal();
    connector.attach(internal);

    internal.messageHandlers.get("task.update")?.({
      type: "task.update",
      taskId: "t-1",
      toolName: "search",
      status: "running",
      argsPreview: "query=hello",
      startedAtMs: 1000,
    });

    expect(connector.list()).toHaveLength(0);
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("updates tasks by taskId on subsequent updates", () => {
    const onUpdate = vi.fn();
    const onList = vi.fn();
    const connector = new TaskStatusConnector({ onUpdate, onList });
    const internal = createMockInternal();
    connector.attach(internal);

    internal.messageHandlers.get("task.update")?.({
      type: "task.update",
      taskId: "t-1",
      toolName: "search",
      cycleId: "cycle-1",
      status: "running",
      argsPreview: "query=hello",
      startedAtMs: 1000,
    });

    internal.messageHandlers.get("task.update")?.({
      type: "task.update",
      taskId: "t-1",
      toolName: "search",
      cycleId: "cycle-1",
      status: "finished",
      argsPreview: "query=hello",
      startedAtMs: 1000,
      endedAtMs: 2000,
    });

    expect(connector.list()).toHaveLength(1);
    expect(connector.list()[0]?.status).toBe("finished");
    expect(connector.list()[0]?.endedAtMs).toBe(2000);
    expect(onUpdate).toHaveBeenCalledTimes(2);
    expect(onList).toHaveBeenCalledTimes(2);
  });

  it("maintains insertion order by startedAtMs", () => {
    const connector = new TaskStatusConnector();
    const internal = createMockInternal();
    connector.attach(internal);

    internal.messageHandlers.get("task.update")?.({
      type: "task.update",
      taskId: "t-2",
      toolName: "tool2",
      cycleId: "cycle-1",
      status: "running",
      argsPreview: "",
      startedAtMs: 2000,
    });

    internal.messageHandlers.get("task.update")?.({
      type: "task.update",
      taskId: "t-1",
      toolName: "tool1",
      cycleId: "cycle-1",
      status: "running",
      argsPreview: "",
      startedAtMs: 1000,
    });

    const items = connector.list();
    expect(items).toHaveLength(2);
    expect(items[0]?.taskId).toBe("t-1");
    expect(items[1]?.taskId).toBe("t-2");
  });

  it("defaults argsPreview to empty string when missing", () => {
    const connector = new TaskStatusConnector();
    const internal = createMockInternal();
    connector.attach(internal);

    internal.messageHandlers.get("task.update")?.({
      type: "task.update",
      taskId: "t-1",
      toolName: "tool",
      cycleId: "cycle-1",
      status: "running",
      startedAtMs: 1000,
    });

    expect(connector.list()[0]?.argsPreview).toBe("");
  });

  it("clears list on detach", () => {
    const connector = new TaskStatusConnector();
    const internal = createMockInternal();
    connector.attach(internal);

    internal.messageHandlers.get("task.update")?.({
      type: "task.update",
      taskId: "t-1",
      toolName: "tool",
      cycleId: "cycle-1",
      status: "running",
      argsPreview: "",
      startedAtMs: 1000,
    });

    expect(connector.list()).toHaveLength(1);
    connector.detach();
    expect(connector.list()).toHaveLength(0);
  });
});
