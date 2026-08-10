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

  // The reconnect FSM, identical to the one ConversationHistoryConnector
  // pins: a `recovered:true` resume replays ONLY
  // the frames the client missed, so a connector that wipes its state on
  // re-attach loses every row the gateway will never re-send. Delegated work
  // is the longest-lived thing on this wire — a Hermes task easily outlives the
  // reconnect that killed its row — so a wipe here strands running work with no
  // UI at all until it completes.
  it("keeps delegation rows across a reconnect detach/attach cycle", () => {
    const connector = new DelegationProgressConnector();
    const first = createMockSDK();
    connector.attach(first.sdk);
    first.emit("delegation.progress", { taskId: "task-1", turnId: "t-1", agent: "hermes", status: "running" });

    connector.detach();
    const second = createMockSDK();
    connector.attach(second.sdk);
    second.emit("delegation.progress", { taskId: "task-2", turnId: "t-1", agent: "hermes", status: "running" });

    expect(connector.list().map((d) => d.taskId)).toEqual(["task-1", "task-2"]);
  });

  it("reset() drops delegation rows on a session/identity teardown", () => {
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

    connector.reset();

    expect(connector.list()).toEqual([]);
  });
});
