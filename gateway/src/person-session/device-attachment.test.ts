import type { ServerWebSocket } from "bun";
import { describe, expect, it, vi } from "vitest";
import { createSessionReplayBuffer } from "../session-handlers/session-replay-buffer.js";
import { createDeviceAttachment } from "./device-attachment.js";

function makeMockWs() {
  return {
    send: vi.fn(),
  } as unknown as ServerWebSocket<unknown>;
}

function makeBuffer() {
  return createSessionReplayBuffer({ maxBytes: 64_000 });
}

function makeAttachment(ws: ServerWebSocket<unknown> = makeMockWs()) {
  const buffer = makeBuffer();
  const epoch = 42;
  const a = createDeviceAttachment({
    attachmentId: "att-1",
    ws,
    sessionId: "sess-1",
    profile: "alice",
    buffer,
    epoch,
  });
  return { a, buffer, epoch };
}

describe("DeviceAttachment", () => {
  it("send() delivers a seq/epoch-stamped JSON frame via the socket", () => {
    const ws = makeMockWs();
    const { a } = makeAttachment(ws);
    a.send({ type: "hello", n: 1 });
    expect(ws.send).toHaveBeenCalledTimes(1);
    const raw = (ws.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed).toMatchObject({ type: "hello", n: 1 });
    // seq and epoch are stamped by the FrameSequencer
    expect(parsed.seq).toBe(1);
    expect(parsed.epoch).toBe(42);
  });

  it("sendBinary() delivers a header-prefixed binary frame via the socket", () => {
    const ws = makeMockWs();
    const { a } = makeAttachment(ws);
    const payload = new Uint8Array([0xaa, 0xbb]);
    a.sendBinary(payload);
    expect(ws.send).toHaveBeenCalledTimes(1);
    const sent = (ws.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Uint8Array;
    expect(sent).toBeInstanceOf(Uint8Array);
    // 9-byte header: [8B seq][1B type][payload]
    expect(sent.byteLength).toBe(2 + 9);
  });

  it("outbound JSON frame is journaled in the replay buffer before socket write", () => {
    const ws = makeMockWs();
    const { a, buffer } = makeAttachment(ws);
    a.send({ type: "message.delta", delta: "hi" });
    expect(buffer.newestSeq).toBe(1);
    const frames = buffer.since(0);
    expect(frames).not.toBeNull();
    expect(frames?.length).toBe(1);
    expect(frames?.[0]?.kind).toBe("text");
  });

  it("outbound binary frame is journaled in the replay buffer before socket write", () => {
    const ws = makeMockWs();
    const { a, buffer } = makeAttachment(ws);
    a.sendBinary(new Uint8Array([1, 2, 3]));
    expect(buffer.newestSeq).toBe(1);
    const frames = buffer.since(0);
    expect(frames).not.toBeNull();
    expect(frames?.[0]?.kind).toBe("binary");
    // Buffered bytes include the 9-byte header
    expect(frames?.[0]?.bytes.byteLength).toBe(3 + 9);
  });

  it("send() swallows a throwing ws.send and the frame is still journaled", () => {
    const ws = {
      send: vi.fn(() => {
        throw new Error("socket closed");
      }),
    } as unknown as ServerWebSocket<unknown>;
    const { a, buffer } = makeAttachment(ws);
    // Must not throw
    expect(() => a.send({ type: "hello" })).not.toThrow();
    // Frame is already in the buffer despite the failed write
    expect(buffer.newestSeq).toBe(1);
  });

  it("sendBinary() swallows a throwing ws.send and the frame is still journaled", () => {
    const ws = {
      send: vi.fn(() => {
        throw new Error("socket closed");
      }),
    } as unknown as ServerWebSocket<unknown>;
    const { a, buffer } = makeAttachment(ws);
    expect(() => a.sendBinary(new Uint8Array([0xff]))).not.toThrow();
    expect(buffer.newestSeq).toBe(1);
  });

  it("seq is monotonic across mixed send/sendBinary calls", () => {
    const ws = makeMockWs();
    const { a, buffer } = makeAttachment(ws);
    a.send({ type: "a" });
    a.sendBinary(new Uint8Array([1]));
    a.send({ type: "b" });
    expect(buffer.newestSeq).toBe(3);
  });

  it("defaults ttsTarget=true and allows flipping", () => {
    const { a } = makeAttachment();
    expect(a.ttsTarget).toBe(true);
    a.ttsTarget = false;
    expect(a.ttsTarget).toBe(false);
  });

  it("exposes identity fields verbatim from init", () => {
    const ws = makeMockWs();
    const { a } = makeAttachment(ws);
    expect(a.attachmentId).toBe("att-1");
    expect(a.sessionId).toBe("sess-1");
    expect(a.profile).toBe("alice");
    expect(a.ws).toBe(ws);
  });

  // warn-once on repeated socket failures
  // The warn-once flag is a module-level closure variable — log-level capture
  // is not readily observable in Bun's native test runner without vi.mock
  // hoisting support. These cases cover the observable contract: repeated
  // failed sends must not throw and all frames must be journaled. The
  // warn-once/debug routing is verified by code review of the flag logic.

  it("send() warn-once: two failing writes both journal their frames and neither throws", () => {
    const ws = {
      send: vi.fn(() => {
        throw new Error("socket closed");
      }),
    } as unknown as ServerWebSocket<unknown>;
    const { a, buffer } = makeAttachment(ws);
    expect(() => a.send({ type: "first" })).not.toThrow();
    expect(() => a.send({ type: "second" })).not.toThrow();
    // Both frames are already in the buffer despite the failed writes
    expect(buffer.newestSeq).toBe(2);
  });

  it("sendBinary() warn-once: two failing writes both journal their frames and neither throws", () => {
    const ws = {
      send: vi.fn(() => {
        throw new Error("socket closed");
      }),
    } as unknown as ServerWebSocket<unknown>;
    const { a, buffer } = makeAttachment(ws);
    expect(() => a.sendBinary(new Uint8Array([0x01]))).not.toThrow();
    expect(() => a.sendBinary(new Uint8Array([0x02]))).not.toThrow();
    expect(buffer.newestSeq).toBe(2);
  });

  it("shared warn-once flag: mixed JSON + binary failures both journal and neither throws", () => {
    const ws = {
      send: vi.fn(() => {
        throw new Error("socket closed");
      }),
    } as unknown as ServerWebSocket<unknown>;
    const { a, buffer } = makeAttachment(ws);
    expect(() => a.send({ type: "json-frame" })).not.toThrow();
    expect(() => a.sendBinary(new Uint8Array([0xaa]))).not.toThrow();
    expect(buffer.newestSeq).toBe(2);
  });
});
