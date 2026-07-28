import { describe, expect, it } from "vitest";
import type { SentientSDKInternal } from "../connector-types.ts";
import { DelegationProgressConnector } from "./delegation-progress-connector.ts";

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

describe("DelegationProgressConnector", () => {
  it("records a running delegation from delegation.progress", () => {
    const connector = new DelegationProgressConnector();
    const mock = createMockSDK();
    connector.attach(mock.sdk);

    mock.emit("delegation.progress", {
      type: "delegation.progress",
      taskId: "task-1",
      turnId: "t-1",
      agent: "hermes",
      status: "running",
    });

    expect(connector.list()).toEqual([{ taskId: "task-1", turnId: "t-1", agent: "hermes", status: "running" }]);
  });

  it("dedups by taskId so a running row transitions in place and keeps the note", () => {
    const connector = new DelegationProgressConnector();
    const mock = createMockSDK();
    connector.attach(mock.sdk);

    mock.emit("delegation.progress", {
      type: "delegation.progress",
      taskId: "task-1",
      turnId: "t-1",
      agent: "hermes",
      status: "running",
    });
    mock.emit("delegation.progress", {
      type: "delegation.progress",
      taskId: "task-1",
      turnId: "t-1",
      agent: "hermes",
      status: "done",
      note: "drafted the packing list",
    });

    expect(connector.list()).toEqual([
      { taskId: "task-1", turnId: "t-1", agent: "hermes", status: "done", note: "drafted the packing list" },
    ]);
  });
});
