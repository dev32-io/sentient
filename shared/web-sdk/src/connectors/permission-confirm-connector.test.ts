import { describe, expect, it, vi } from "vitest";
import type { SentientSDKInternal } from "../connector-types.ts";
import { PermissionConfirmConnector } from "./permission-confirm-connector.ts";

function createMockSDK(): {
  sdk: SentientSDKInternal;
  sent: unknown[];
  emit: (type: string, msg: unknown) => void;
} {
  const handlers = new Map<string, ((msg: unknown) => void)[]>();
  const sent: unknown[] = [];
  return {
    sent,
    sdk: {
      send: (message: unknown) => {
        sent.push(message);
      },
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

function requestFrame(requestId: string) {
  return {
    type: "permission.request",
    requestId,
    toolCallId: `tc-${requestId}`,
    toolName: "home_assistant.call_service",
    args: { entity_id: "lock.front_door", service: "unlock" },
    description: "Unlock the front door",
    expiresAtMs: 1_800_000,
  };
}

describe("PermissionConfirmConnector", () => {
  it("surfaces a pending request from permission.request", () => {
    const onPending = vi.fn();
    const connector = new PermissionConfirmConnector({ onPending });
    const mock = createMockSDK();
    connector.attach(mock.sdk);

    mock.emit("permission.request", requestFrame("r-1"));

    expect(connector.pending()).toEqual([
      {
        requestId: "r-1",
        toolCallId: "tc-r-1",
        toolName: "home_assistant.call_service",
        args: { entity_id: "lock.front_door", service: "unlock" },
        description: "Unlock the front door",
        expiresAtMs: 1_800_000,
      },
    ]);
    expect(onPending).toHaveBeenCalledTimes(1);
  });

  it("sends permission.response with the requestId and the approval flag", () => {
    const connector = new PermissionConfirmConnector();
    const mock = createMockSDK();
    connector.attach(mock.sdk);

    mock.emit("permission.request", requestFrame("r-1"));
    connector.respond("r-1", true);

    expect(mock.sent).toEqual([{ type: "permission.response", requestId: "r-1", approved: true }]);
    expect(connector.pending()).toEqual([]);
  });

  it("dismisses the request when the gateway resolves it first (server-side timeout)", () => {
    const onResolved = vi.fn();
    const connector = new PermissionConfirmConnector({ onResolved });
    const mock = createMockSDK();
    connector.attach(mock.sdk);

    mock.emit("permission.request", requestFrame("r-1"));
    mock.emit("permission.resolved", { type: "permission.resolved", requestId: "r-1", outcome: "timeout" });

    expect(connector.pending()).toEqual([]);
    expect(onResolved).toHaveBeenCalledWith("r-1", "timeout");
  });

  it("never sends a response for a requestId it is not tracking", () => {
    const connector = new PermissionConfirmConnector();
    const mock = createMockSDK();
    connector.attach(mock.sdk);

    mock.emit("permission.request", requestFrame("r-1"));
    mock.emit("permission.resolved", { type: "permission.resolved", requestId: "r-1", outcome: "denied" });
    connector.respond("r-1", true); // stale dialog click, arriving after resolution

    expect(mock.sent).toEqual([]);
  });

  it("clears pending on detach so a dropped socket leaves no answerable dialog", () => {
    const onPending = vi.fn();
    const connector = new PermissionConfirmConnector({ onPending });
    const mock = createMockSDK();
    connector.attach(mock.sdk);

    mock.emit("permission.request", requestFrame("r-1"));
    connector.detach();

    expect(connector.pending()).toEqual([]);
    expect(onPending).toHaveBeenLastCalledWith([]);
  });
});
