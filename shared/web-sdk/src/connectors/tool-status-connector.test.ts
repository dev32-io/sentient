import { describe, expect, it } from "vitest";
import type { SentientSDKInternal } from "../connector-types.ts";
import { ToolStatusConnector } from "./tool-status-connector.ts";

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
        return () => {};
      },
      onBinary: () => () => {},
    },
    emit: (type, msg) => {
      for (const h of handlers.get(type) ?? []) h(msg);
    },
  };
}

describe("ToolStatusConnector", () => {
  it("records a running tool call from turn.tool.update", () => {
    const connector = new ToolStatusConnector();
    const mock = createMockSDK();
    connector.attach(mock.sdk);

    mock.emit("turn.tool.update", {
      turnId: "t-1",
      toolCallId: "tc-1",
      toolName: "home_assistant.get_state",
      status: "running",
      argsPreview: "entity=light.kitchen",
      startedAtMs: 1000,
    });

    expect(connector.list()).toEqual([
      {
        toolCallId: "tc-1",
        toolName: "home_assistant.get_state",
        turnId: "t-1",
        status: "running",
        argsPreview: "entity=light.kitchen",
        startedAtMs: 1000,
      },
    ]);
  });

  it("dedups by toolCallId so a running row transitions in place to done", () => {
    const connector = new ToolStatusConnector();
    const mock = createMockSDK();
    connector.attach(mock.sdk);

    const base = {
      turnId: "t-1",
      toolCallId: "tc-1",
      toolName: "search",
      argsPreview: "q=weather",
      startedAtMs: 1000,
    };
    mock.emit("turn.tool.update", { ...base, status: "running" });
    mock.emit("turn.tool.update", { ...base, status: "done", endedAtMs: 1400 });

    const list = connector.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.status).toBe("done");
    expect(list[0]?.endedAtMs).toBe(1400);
  });

  it("carries taskId through for background tools so the UI can join delegation.progress", () => {
    const connector = new ToolStatusConnector();
    const mock = createMockSDK();
    connector.attach(mock.sdk);

    mock.emit("turn.tool.update", {
      turnId: "t-1",
      toolCallId: "tc-bg",
      toolName: "delegateTask",
      status: "running",
      taskId: "task-42",
      argsPreview: "agent=hermes",
      startedAtMs: 2000,
    });

    expect(connector.list()[0]?.taskId).toBe("task-42");
  });

  // The reconnect FSM, same invariant ConversationHistoryConnector pins: a
  // `recovered:true` resume replays ONLY the frames the client missed, so a
  // connector that wipes its cache on re-attach loses every tile the gateway
  // will never re-send. It also desyncs the two tool-tile sources — the
  // committed mirror survives the same reconnect, and webui's cycle-helpers
  // joins the two per turn by dispatch position, so a truncated live list
  // makes a still-running call unrenderable.
  it("keeps live tool calls across a reconnect detach/attach cycle", () => {
    const connector = new ToolStatusConnector();
    const first = createMockSDK();
    connector.attach(first.sdk);
    first.emit("turn.tool.update", {
      turnId: "t-1",
      toolCallId: "tc-1",
      toolName: "get_weather",
      status: "done",
      argsPreview: "{}",
      startedAtMs: 1000,
    });

    connector.detach();
    const second = createMockSDK();
    connector.attach(second.sdk);
    second.emit("turn.tool.update", {
      turnId: "t-1",
      toolCallId: "tc-2",
      toolName: "set_lights",
      status: "running",
      argsPreview: "{}",
      startedAtMs: 1200,
    });

    expect(connector.list().map((c) => c.toolCallId)).toEqual(["tc-1", "tc-2"]);
  });

  it("reset() drops live tool calls on a session/identity teardown", () => {
    const connector = new ToolStatusConnector();
    const mock = createMockSDK();
    connector.attach(mock.sdk);
    mock.emit("turn.tool.update", {
      turnId: "t-1",
      toolCallId: "tc-1",
      toolName: "get_weather",
      status: "done",
      argsPreview: "{}",
      startedAtMs: 1000,
    });

    connector.reset();

    expect(connector.list()).toEqual([]);
  });
});
