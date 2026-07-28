import { beforeEach, describe, expect, it } from "vitest";
import type { SentientSDKInternal } from "../connector-types.ts";
import { type InFlightMessage, InFlightMessageConnector } from "./inflight-message-connector.ts";

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

describe("InFlightMessageConnector", () => {
  let connector: InFlightMessageConnector;
  let mock: ReturnType<typeof createMockSDK>;
  let updates: (readonly InFlightMessage[])[];

  beforeEach(() => {
    updates = [];
    connector = new InFlightMessageConnector({ onUpdate: (inflight) => updates.push(inflight) });
    mock = createMockSDK();
    connector.attach(mock.sdk);
  });

  it("seeds an empty buffer on turn.started so the UI can render the pre-first-token placeholder", () => {
    mock.emit("turn.started", { turnId: "t-1", trigger: "user" });
    expect(connector.list()).toEqual([{ turnId: "t-1", text: "" }]);
  });

  it("accumulates turn.text.delta into that turn's buffer", () => {
    mock.emit("turn.started", { turnId: "t-1", trigger: "user" });
    mock.emit("turn.text.delta", { turnId: "t-1", text: "Hello " });
    mock.emit("turn.text.delta", { turnId: "t-1", text: "world" });
    expect(connector.list()).toEqual([{ turnId: "t-1", text: "Hello world" }]);
  });

  it("holds TWO turns in flight concurrently — a follow-up turn never clobbers the open bubble (spec 7.2)", () => {
    mock.emit("turn.started", { turnId: "t-1", trigger: "user" });
    mock.emit("turn.text.delta", { turnId: "t-1", text: "first" });
    mock.emit("turn.started", { turnId: "t-2", trigger: "background-completion" });
    mock.emit("turn.text.delta", { turnId: "t-2", text: "second" });

    expect(connector.list()).toEqual([
      { turnId: "t-1", text: "first" },
      { turnId: "t-2", text: "second" },
    ]);
  });

  it("turn.completed clears only its own turn", () => {
    mock.emit("turn.text.delta", { turnId: "t-1", text: "first" });
    mock.emit("turn.text.delta", { turnId: "t-2", text: "second" });
    mock.emit("turn.completed", { turnId: "t-1" });
    expect(connector.list()).toEqual([{ turnId: "t-2", text: "second" }]);
  });

  it("turn.aborted clears only its own turn", () => {
    mock.emit("turn.text.delta", { turnId: "t-1", text: "first" });
    mock.emit("turn.text.delta", { turnId: "t-2", text: "second" });
    mock.emit("turn.aborted", { turnId: "t-2", cutoff: "barge-in" });
    expect(connector.list()).toEqual([{ turnId: "t-1", text: "first" }]);
  });

  it("detach drops every buffer and stops handling further frames", () => {
    mock.emit("turn.text.delta", { turnId: "t-1", text: "hi" });
    connector.detach();
    expect(connector.list()).toEqual([]);
    mock.emit("turn.text.delta", { turnId: "t-1", text: "more" });
    expect(connector.list()).toEqual([]);
  });
});
