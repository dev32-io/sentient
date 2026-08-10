import { describe, expect, it, vi } from "vitest";
import type { SentientSDKInternal } from "../connector-types.ts";
import { TaskListConnector } from "./task-list-connector.ts";

function createMockSDK(): { sdk: SentientSDKInternal; emit: (type: string, msg: unknown) => void } {
  const handlers = new Map<string, ((msg: unknown) => void)[]>();
  return {
    sdk: {
      send: () => {},
      sendBinary: () => {},
      onMessage: (type, handler) => {
        const list = handlers.get(type) ?? [];
        list.push(handler);
        handlers.set(type, list);
        return () => {
          const current = handlers.get(type);
          if (!current) return;
          const idx = current.indexOf(handler);
          if (idx !== -1) current.splice(idx, 1);
        };
      },
      onBinary: () => () => {},
    },
    emit: (type, msg) => {
      for (const h of handlers.get(type) ?? []) h(msg);
    },
  };
}

describe("TaskListConnector", () => {
  it("declares the tasklist capability", () => {
    expect(new TaskListConnector().capability).toBe("tasklist");
  });

  it("has kind status", () => {
    expect(new TaskListConnector().kind).toBe("status");
  });

  it("starts with an empty list and a null turn", () => {
    const connector = new TaskListConnector();
    expect(connector.list()).toEqual([]);
    expect(connector.turnId()).toBeNull();
  });

  it("replaces the whole list on every frame — no merge, no dedupe", () => {
    const onUpdate = vi.fn();
    const connector = new TaskListConnector({ onUpdate });
    const mock = createMockSDK();
    connector.attach(mock.sdk);

    mock.emit("tasklist.state", {
      type: "tasklist.state",
      turnId: "t1",
      items: [
        {
          id: "a",
          toolName: "x",
          kind: "foreground",
          status: "running",
          argsPreview: "{}",
          startedAtMs: 1,
        },
      ],
    });
    expect(connector.list()).toHaveLength(1);
    expect(connector.turnId()).toBe("t1");
    expect(onUpdate).toHaveBeenCalledWith("t1", connector.list());

    mock.emit("tasklist.state", { type: "tasklist.state", turnId: null, items: [] });
    expect(connector.list()).toEqual([]);
    expect(connector.turnId()).toBeNull();
    expect(onUpdate).toHaveBeenCalledTimes(2);
  });

  it("carries background rows whose turn already finished (turnId null, items non-empty)", () => {
    const connector = new TaskListConnector();
    const mock = createMockSDK();
    connector.attach(mock.sdk);

    mock.emit("tasklist.state", {
      type: "tasklist.state",
      turnId: null,
      items: [
        {
          id: "task-42",
          toolName: "delegateTask",
          kind: "background",
          status: "running",
          argsPreview: "agent=hermes",
          startedAtMs: 5,
        },
      ],
    });

    expect(connector.turnId()).toBeNull();
    expect(connector.list()).toHaveLength(1);
    expect(connector.list()[0]?.id).toBe("task-42");
  });

  it("detach stops delivering frames", () => {
    const connector = new TaskListConnector();
    const mock = createMockSDK();
    connector.attach(mock.sdk);
    connector.detach();

    mock.emit("tasklist.state", {
      type: "tasklist.state",
      turnId: "t1",
      items: [{ id: "a", toolName: "x", kind: "foreground", status: "running", argsPreview: "{}", startedAtMs: 1 }],
    });

    expect(connector.list()).toEqual([]);
    expect(connector.turnId()).toBeNull();
  });

  it("clear() drops the list at a conversation boundary, and keeps listening", () => {
    // A conversation switch / "+" is not teardown: the socket and this
    // connector live on. The rows belong to the conversation the pane left —
    // a background delegateTask row is keyed by taskId and retained by design,
    // so nothing on the server side ever retires it for the new pane.
    const onUpdate = vi.fn();
    const connector = new TaskListConnector({ onUpdate });
    const mock = createMockSDK();
    connector.attach(mock.sdk);

    mock.emit("tasklist.state", {
      type: "tasklist.state",
      turnId: null,
      items: [
        {
          id: "task-42",
          toolName: "delegateTask",
          kind: "background",
          status: "running",
          argsPreview: "",
          startedAtMs: 5,
        },
      ],
    });

    connector.clear();

    expect(connector.list()).toEqual([]);
    expect(connector.turnId()).toBeNull();
    expect(onUpdate).toHaveBeenLastCalledWith(null, []);

    // Still attached — the next conversation's own frames must land.
    mock.emit("tasklist.state", {
      type: "tasklist.state",
      turnId: "t2",
      items: [{ id: "b", toolName: "y", kind: "foreground", status: "running", argsPreview: "", startedAtMs: 9 }],
    });
    expect(connector.list()).toHaveLength(1);
  });

  it("reset() drops the list on a session/identity teardown", () => {
    const onUpdate = vi.fn();
    const connector = new TaskListConnector({ onUpdate });
    const mock = createMockSDK();
    connector.attach(mock.sdk);

    mock.emit("tasklist.state", {
      type: "tasklist.state",
      turnId: "t1",
      items: [{ id: "a", toolName: "x", kind: "foreground", status: "running", argsPreview: "{}", startedAtMs: 1 }],
    });

    connector.reset();

    expect(connector.list()).toEqual([]);
    expect(connector.turnId()).toBeNull();
    expect(onUpdate).toHaveBeenLastCalledWith(null, []);
  });
});
