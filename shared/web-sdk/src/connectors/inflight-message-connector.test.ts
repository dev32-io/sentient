import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SentientSDKInternal } from "../connector-types.ts";
import { InFlightMessageConnector } from "./inflight-message-connector.ts";

function createMockSDK(): {
  sdk: SentientSDKInternal;
  emit: (type: string, msg: unknown) => void;
} {
  const handlers = new Map<string, ((msg: unknown) => void)[]>();
  return {
    sdk: {
      send: vi.fn(),
      sendBinary: vi.fn(),
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
  let updates: (unknown | null)[];

  beforeEach(() => {
    updates = [];
    connector = new InFlightMessageConnector({
      onUpdate: (inflight) => updates.push(inflight),
    });
    mock = createMockSDK();
    connector.attach(mock.sdk);
  });

  it("starts with null inflight", () => {
    expect(connector.inflight()).toBeNull();
  });

  it("seeds an empty buffer on cycle.started so the UI can render the pre-first-token placeholder", () => {
    mock.emit("cycle.started", { cycleId: "c-1", triggerReason: "test" });
    expect(connector.inflight()).toEqual({ cycleId: "c-1", text: "" });
    expect(updates[updates.length - 1]).toEqual({ cycleId: "c-1", text: "" });
  });

  it("transitions seed → text on the first delta without losing the cycleId", () => {
    mock.emit("cycle.started", { cycleId: "c-1", triggerReason: "test" });
    mock.emit("message.delta", { cycleId: "c-1", delta: "Hi" });
    expect(connector.inflight()).toEqual({ cycleId: "c-1", text: "Hi" });
  });

  it("clears the seed buffer on cycle.aborted before any delta", () => {
    mock.emit("cycle.started", { cycleId: "c-1", triggerReason: "test" });
    mock.emit("cycle.aborted", { cycleId: "c-1", reason: "barge-in" });
    expect(connector.inflight()).toBeNull();
  });

  it("accumulates deltas for a cycle", () => {
    mock.emit("message.delta", { cycleId: "c-1", delta: "Hello " });
    mock.emit("message.delta", { cycleId: "c-1", delta: "world" });
    expect(connector.inflight()).toEqual({ cycleId: "c-1", text: "Hello world" });
    expect(updates).toHaveLength(2);
  });

  it("clears inflight on message.done", () => {
    mock.emit("message.delta", { cycleId: "c-1", delta: "Hi" });
    mock.emit("message.done", { cycleId: "c-1" });
    expect(connector.inflight()).toBeNull();
    expect(updates[updates.length - 1]).toBeNull();
  });

  it("clears inflight on cycle.aborted", () => {
    mock.emit("message.delta", { cycleId: "c-1", delta: "Hi" });
    mock.emit("cycle.aborted", { cycleId: "c-1", reason: "barge-in" });
    expect(connector.inflight()).toBeNull();
  });

  it("ignores message.done for a different cycle", () => {
    mock.emit("message.delta", { cycleId: "c-1", delta: "Hi" });
    mock.emit("message.done", { cycleId: "c-2" });
    expect(connector.inflight()).toEqual({ cycleId: "c-1", text: "Hi" });
  });

  it("starts a fresh buffer when a new cycleId begins", () => {
    mock.emit("message.delta", { cycleId: "c-1", delta: "First" });
    mock.emit("message.done", { cycleId: "c-1" });
    mock.emit("message.delta", { cycleId: "c-2", delta: "Second" });
    expect(connector.inflight()).toEqual({ cycleId: "c-2", text: "Second" });
  });

  it("replaces buffer if a new cycleId arrives mid-stream (no lingering tail)", () => {
    mock.emit("message.delta", { cycleId: "c-1", delta: "Old" });
    mock.emit("message.delta", { cycleId: "c-2", delta: "New" });
    expect(connector.inflight()).toEqual({ cycleId: "c-2", text: "New" });
  });

  it("ignores malformed messages", () => {
    mock.emit("message.delta", {});
    mock.emit("message.delta", { cycleId: "c-1" });
    mock.emit("message.delta", { delta: "Hi" });
    expect(connector.inflight()).toBeNull();
  });

  it("detach clears buffer + stops handling further events", () => {
    mock.emit("message.delta", { cycleId: "c-1", delta: "Hi" });
    connector.detach();
    expect(connector.inflight()).toBeNull();
    mock.emit("message.delta", { cycleId: "c-1", delta: "more" });
    expect(connector.inflight()).toBeNull();
  });
});
