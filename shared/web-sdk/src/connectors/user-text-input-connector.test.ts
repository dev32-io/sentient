import { describe, expect, it } from "vitest";
import type { SentientSDKInternal } from "../connector-types.ts";
import { UserTextInputConnector } from "./user-text-input-connector.ts";

// ---------------------------------------------------------------------------
// Mock SDK Internal
// ---------------------------------------------------------------------------

function createMockInternal(): SentientSDKInternal & { sentMessages: unknown[] } {
  const sentMessages: unknown[] = [];

  return {
    sentMessages,
    send(message: unknown) {
      sentMessages.push(message);
    },
    sendBinary() {},
    onMessage(_type: string, _handler: (msg: unknown) => void) {
      return () => {};
    },
    onBinary(_handler: (data: ArrayBuffer) => void) {
      return () => {};
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("UserTextInputConnector", () => {
  it("has capability text.input and kind input", () => {
    const connector = new UserTextInputConnector();
    expect(connector.capability).toBe("text.input");
    expect(connector.kind).toBe("input");
  });

  it("sends text.input message via SDK", () => {
    const connector = new UserTextInputConnector();
    const internal = createMockInternal();
    connector.attach(internal);

    connector.sendText("hello");

    expect(internal.sentMessages).toEqual([{ type: "text.input", text: "hello" }]);
  });

  it("does not send after detach", () => {
    const connector = new UserTextInputConnector();
    const internal = createMockInternal();
    connector.attach(internal);
    connector.detach();

    connector.sendText("should not send");

    expect(internal.sentMessages).toHaveLength(0);
  });
});
