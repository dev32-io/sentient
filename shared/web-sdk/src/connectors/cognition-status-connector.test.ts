import { beforeEach, describe, expect, it } from "vitest";
import type { SentientSDKInternal } from "../connector-types.ts";
import { CognitionStatusConnector } from "./cognition-status-connector.ts";

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

describe("CognitionStatusConnector", () => {
  let connector: CognitionStatusConnector;
  let mock: ReturnType<typeof createMockSDK>;

  beforeEach(() => {
    connector = new CognitionStatusConnector();
    mock = createMockSDK();
    connector.attach(mock.sdk);
  });

  it("goes thinking on turn.started", () => {
    mock.emit("turn.started", { turnId: "t-1", trigger: "user" });
    expect(connector.state()).toBe("thinking");
  });

  it("stays thinking while a second turn is still open after the first completes", () => {
    mock.emit("turn.started", { turnId: "t-1", trigger: "user" });
    mock.emit("turn.started", { turnId: "t-2", trigger: "background-completion" });
    mock.emit("turn.completed", { turnId: "t-1" });
    expect(connector.state()).toBe("thinking");
  });

  it("returns to idle only once every turn has settled", () => {
    mock.emit("turn.started", { turnId: "t-1", trigger: "user" });
    mock.emit("turn.started", { turnId: "t-2", trigger: "background-completion" });
    mock.emit("turn.completed", { turnId: "t-1" });
    mock.emit("turn.aborted", { turnId: "t-2", cutoff: "interrupt" });
    expect(connector.state()).toBe("idle");
  });
});
