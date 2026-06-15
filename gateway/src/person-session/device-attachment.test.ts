import type { ServerWebSocket } from "bun";
import { describe, expect, it, vi } from "vitest";
import { createSessionReplayBuffer } from "../session-handlers/session-replay-buffer.js";
import { createDeviceAttachment } from "./device-attachment.js";
import type { DeviceSocketRef } from "./device-buffer-store.js";

function makeMockWs() {
  return {
    send: vi.fn(),
  } as unknown as ServerWebSocket<unknown>;
}

function makeBuffer() {
  return createSessionReplayBuffer({ maxBytes: 64_000 });
}

function makeNopClock() {
  return {
    touch: (_source: string) => {},
    idleMs: (_nowMs: number) => 0,
    lastActivityMs: () => 0,
  };
}

function makeAttachment(
  ws: ServerWebSocket<unknown> = makeMockWs(),
  liveSocket: DeviceSocketRef = { current: null },
  buffer = makeBuffer(),
  live = true,
) {
  const epoch = 42;
  const a = createDeviceAttachment({
    attachmentId: "att-1",
    deviceId: "dev-1",
    ws,
    sessionId: "sess-1",
    profile: "alice",
    buffer,
    epoch,
    liveSocket,
    clock: makeNopClock(),
  } as never);
  // Most tests want a live socket; the resume-gating tests pass live=false.
  if (live) a.goLive();
  return { a, buffer, epoch, liveSocket };
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
    expect(a.deviceId).toBe("dev-1");
    expect(a.sessionId).toBe("sess-1");
    expect(a.profile).toBe("alice");
    expect(a.ws).toBe(ws);
  });

  // ── Live-socket retarget (resume in-flight cycle fix) ─────────────────────

  it("does NOT claim the live socket until goLive() (resume defers it past the replay)", () => {
    const ws = makeMockWs();
    const liveSocket: DeviceSocketRef = { current: null };
    const { a } = makeAttachment(ws, liveSocket, makeBuffer(), /* live */ false);
    expect(liveSocket.current).toBeNull();
    a.goLive();
    expect(liveSocket.current).not.toBeNull();
  });

  it("send() journals but does NOT write to the socket before goLive()", () => {
    const ws = makeMockWs();
    const liveSocket: DeviceSocketRef = { current: null };
    const { a, buffer } = makeAttachment(ws, liveSocket, makeBuffer(), /* live */ false);
    a.send({ type: "delta", delta: "pre-live" });
    expect(ws.send).not.toHaveBeenCalled();
    expect(buffer.newestSeq).toBe(1); // still journaled for the replay window
  });

  it("a STALE attachment's send follows the live ref to the NEW socket after a resume", () => {
    // Shared per-device ref + buffer survive the reconnect.
    const liveSocket: DeviceSocketRef = { current: null };
    const buffer = makeBuffer();
    const oldWs = makeMockWs();
    const newWs = makeMockWs();

    // Old connection.
    const { a: oldAtt } = makeAttachment(oldWs, liveSocket, buffer);
    // New connection (resume) takes over the live ref — same buffer, continued seq.
    makeAttachment(newWs, liveSocket, buffer);

    // The in-flight cycle still drives the OLD attachment. Its frame must land
    // on the NEW socket, not the dead old one.
    oldAtt.send({ type: "cycle.done", cycleId: "1" });
    expect(oldWs.send).not.toHaveBeenCalled();
    expect(newWs.send).toHaveBeenCalledTimes(1);
    // Still journaled (seq continues on the shared buffer).
    expect(buffer.newestSeq).toBe(1);
  });

  it("releaseSocket() nulls the ref only when this attachment still holds it", () => {
    const liveSocket: DeviceSocketRef = { current: null };
    const { a } = makeAttachment(makeMockWs(), liveSocket);
    expect(liveSocket.current).not.toBeNull();
    a.releaseSocket();
    expect(liveSocket.current).toBeNull();
  });

  it("releaseSocket() is a no-op once a newer attachment has taken over (handover guard)", () => {
    const liveSocket: DeviceSocketRef = { current: null };
    const buffer = makeBuffer();
    const { a: oldAtt } = makeAttachment(makeMockWs(), liveSocket, buffer);
    makeAttachment(makeMockWs(), liveSocket, buffer); // new takes over
    const afterTakeover = liveSocket.current;
    oldAtt.releaseSocket(); // old teardown must NOT clobber the new writer
    expect(liveSocket.current).toBe(afterTakeover);
    expect(liveSocket.current).not.toBeNull();
  });

  it("send() no-ops cleanly (still journals) while the device is disconnected (ref null)", () => {
    const liveSocket: DeviceSocketRef = { current: null };
    const { a, buffer } = makeAttachment(makeMockWs(), liveSocket);
    a.releaseSocket(); // simulate disconnect
    expect(() => a.send({ type: "delta" })).not.toThrow();
    // Frame still journaled for replay on the next resume.
    expect(buffer.newestSeq).toBe(1);
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

  it("touches ws.out on every outbound frame", () => {
    const touches: string[] = [];
    const clock = {
      touch: (s: string) => touches.push(s),
      idleMs: (_nowMs: number) => 0,
      lastActivityMs: () => 0,
    };
    const ws = makeMockWs();
    const liveSocket: DeviceSocketRef = { current: null };
    const buffer = makeBuffer();
    const a = createDeviceAttachment({
      attachmentId: "att-1",
      deviceId: "dev-1",
      ws,
      sessionId: "sess-1",
      profile: "alice",
      buffer,
      epoch: 42,
      liveSocket,
      clock,
    } as never);
    a.goLive();
    a.send({ type: "x" });
    expect(touches).toContain("ws.out");
  });

  it("touches ws.out on outbound binary frame", () => {
    const touches: string[] = [];
    const clock = {
      touch: (s: string) => touches.push(s),
      idleMs: (_nowMs: number) => 0,
      lastActivityMs: () => 0,
    };
    const ws = makeMockWs();
    const liveSocket: DeviceSocketRef = { current: null };
    const buffer = makeBuffer();
    const a = createDeviceAttachment({
      attachmentId: "att-1",
      deviceId: "dev-1",
      ws,
      sessionId: "sess-1",
      profile: "alice",
      buffer,
      epoch: 42,
      liveSocket,
      clock,
    } as never);
    a.goLive();
    a.sendBinary(new Uint8Array([0xab]));
    expect(touches).toContain("ws.out");
  });
});
