import type { ServerWebSocket } from "bun";
import { describe, expect, it, vi } from "vitest";
import { createDeviceAttachment } from "./device-attachment.js";

function makeMockWs() {
  return {
    send: vi.fn(),
  } as unknown as ServerWebSocket<unknown>;
}

describe("DeviceAttachment", () => {
  it("stringifies JSON payloads in send()", () => {
    const ws = makeMockWs();
    const a = createDeviceAttachment({
      attachmentId: "att-1",
      ws,
      sessionId: "sess-1",
      profile: "alice",
    });
    a.send({ type: "hello", n: 1 });
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: "hello", n: 1 }));
  });

  it("forwards binary payloads via sendBinary()", () => {
    const ws = makeMockWs();
    const a = createDeviceAttachment({
      attachmentId: "att-1",
      ws,
      sessionId: "sess-1",
      profile: "alice",
    });
    const bytes = new Uint8Array([1, 2, 3]);
    a.sendBinary(bytes);
    expect(ws.send).toHaveBeenCalledWith(bytes);
  });

  it("defaults ttsTarget=true and allows flipping", () => {
    const a = createDeviceAttachment({
      attachmentId: "att-1",
      ws: makeMockWs(),
      sessionId: "sess-1",
      profile: "alice",
    });
    expect(a.ttsTarget).toBe(true);
    a.ttsTarget = false;
    expect(a.ttsTarget).toBe(false);
  });

  it("exposes identity fields verbatim from init", () => {
    const ws = makeMockWs();
    const a = createDeviceAttachment({
      attachmentId: "att-1",
      ws,
      sessionId: "sess-1",
      profile: "alice",
    });
    expect(a.attachmentId).toBe("att-1");
    expect(a.sessionId).toBe("sess-1");
    expect(a.profile).toBe("alice");
    expect(a.ws).toBe(ws);
  });
});
