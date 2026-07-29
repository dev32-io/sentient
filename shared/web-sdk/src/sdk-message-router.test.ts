// ---------------------------------------------------------------------------
// sdk-message-router — wire-contract tests for:
//   1. Binary header peel (9-byte header stripped; payload delivered to handlers).
//   2. seq dedup on binary frames (cursor advances; replayed seq dropped).
//   3. seq dedup on JSON frames (handler not called on dup; called on new seq).
//   4. stream.resumed callback routing.
//   5. Auth-failure routing (`auth.error` / `error` while authenticating).
//
// Pins: wire/protocol contract at the gateway↔SDK boundary (binary header
// format, handshake failure frames) and FSM/invariant (seq dedup rule).
// ---------------------------------------------------------------------------

import { describe, expect, it, vi } from "vitest";
import type { Connector, SDKStatus } from "./connector-types.ts";
import { createResumeCursor } from "./resume-cursor.ts";
import { type MessageRouterDeps, dispatchMessage } from "./sdk-message-router.ts";
import { createSdkTimers } from "./sdk-timers.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDeps(overrides: Partial<MessageRouterDeps> = {}): MessageRouterDeps & {
  binaryHandlers: Set<(data: ArrayBuffer) => void>;
  messageHandlers: Map<string, Set<(msg: unknown) => void>>;
  streamResumedCalls: boolean[];
} {
  const binaryHandlers = new Set<(data: ArrayBuffer) => void>();
  const messageHandlers = new Map<string, Set<(msg: unknown) => void>>();
  const streamResumedCalls: boolean[] = [];

  const timers = createSdkTimers({
    onAuthTimeout: () => {},
    onReadyTimeout: () => {},
  });

  return {
    getStatus: () => "ready" as SDKStatus,
    setStatus: vi.fn(),
    setLastErrorKind: vi.fn(),
    timers,
    sendSessionConfigure: vi.fn(),
    onSessionReady: undefined,
    attachAll: vi.fn(),
    notifyPresence: vi.fn(),
    getMessageHandlers: () => messageHandlers,
    getBinaryHandlers: () => binaryHandlers,
    getConnectors: (): readonly Connector[] => [],
    cursor: createResumeCursor(),
    onStreamResumed: (recovered) => streamResumedCalls.push(recovered),
    binaryHandlers,
    messageHandlers,
    streamResumedCalls,
    ...overrides,
  };
}

/**
 * Build a binary frame with the 9-byte header prepended.
 * [8-byte BE u64 seq][1-byte type][payload]
 */
function makeBinaryFrame(seq: number, type: number, payload: Uint8Array): ArrayBuffer {
  const buf = new ArrayBuffer(9 + payload.byteLength);
  const view = new DataView(buf);
  // Write u64 BE seq as high+low u32.
  view.setUint32(0, Math.floor(seq / 2 ** 32), false);
  view.setUint32(4, seq >>> 0, false);
  view.setUint8(8, type);
  new Uint8Array(buf).set(payload, 9);
  return buf;
}

function makeMessageEvent(data: unknown): MessageEvent {
  return { data } as MessageEvent;
}

const NOOP = (): void => {};
const AUDIO_TYPE = 0x01;

// ---------------------------------------------------------------------------
// Binary header peel
// ---------------------------------------------------------------------------

describe("dispatchMessage — binary header peel", () => {
  it("delivers only the payload bytes (not the 9-byte header) to binary handlers", () => {
    const deps = makeDeps();
    const payload = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const received: Uint8Array[] = [];
    deps.binaryHandlers.add((data) => received.push(new Uint8Array(data)));

    const frame = makeBinaryFrame(1, AUDIO_TYPE, payload);
    dispatchMessage(deps, makeMessageEvent(frame), NOOP, NOOP);

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(payload);
  });

  it("delivers payload of length 0 (empty audio frame) correctly", () => {
    const deps = makeDeps();
    const received: ArrayBuffer[] = [];
    deps.binaryHandlers.add((data) => received.push(data));

    const frame = makeBinaryFrame(1, AUDIO_TYPE, new Uint8Array(0));
    dispatchMessage(deps, makeMessageEvent(frame), NOOP, NOOP);

    expect(received).toHaveLength(1);
    expect(received[0]?.byteLength).toBe(0);
  });

  it("drops frames shorter than 9 bytes (malformed)", () => {
    const deps = makeDeps();
    const received: ArrayBuffer[] = [];
    deps.binaryHandlers.add((data) => received.push(data));

    const tiny = new ArrayBuffer(5);
    dispatchMessage(deps, makeMessageEvent(tiny), NOOP, NOOP);

    expect(received).toHaveLength(0);
  });

  it("drops frames with unknown type byte (not 0x01)", () => {
    const deps = makeDeps();
    const received: ArrayBuffer[] = [];
    deps.binaryHandlers.add((data) => received.push(data));

    const frame = makeBinaryFrame(1, 0x02, new Uint8Array([1, 2, 3]));
    dispatchMessage(deps, makeMessageEvent(frame), NOOP, NOOP);

    expect(received).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Binary frame seq dedup
// ---------------------------------------------------------------------------

describe("dispatchMessage — binary seq cursor", () => {
  it("advances lastSeq to the frame's seq on first delivery", () => {
    const deps = makeDeps();
    deps.binaryHandlers.add(() => {});

    const frame = makeBinaryFrame(3, AUDIO_TYPE, new Uint8Array([1]));
    dispatchMessage(deps, makeMessageEvent(frame), NOOP, NOOP);

    expect(deps.cursor.cursor.lastSeq).toBe(3);
  });

  it("drops a replayed frame (seq <= lastSeq) and does not call handler", () => {
    const deps = makeDeps();
    const received: Uint8Array[] = [];
    deps.binaryHandlers.add((data) => received.push(new Uint8Array(data)));

    // First delivery — seq 5.
    dispatchMessage(deps, makeMessageEvent(makeBinaryFrame(5, AUDIO_TYPE, new Uint8Array([1]))), NOOP, NOOP);
    expect(received).toHaveLength(1);

    // Replay — same seq. Handler must NOT be called again.
    dispatchMessage(deps, makeMessageEvent(makeBinaryFrame(5, AUDIO_TYPE, new Uint8Array([2]))), NOOP, NOOP);
    expect(received).toHaveLength(1);

    // Even older seq.
    dispatchMessage(deps, makeMessageEvent(makeBinaryFrame(3, AUDIO_TYPE, new Uint8Array([3]))), NOOP, NOOP);
    expect(received).toHaveLength(1);

    expect(deps.cursor.cursor.lastSeq).toBe(5);
  });

  it("applies a higher seq after a replay attempt", () => {
    const deps = makeDeps();
    const received: Uint8Array[] = [];
    deps.binaryHandlers.add((data) => received.push(new Uint8Array(data)));

    dispatchMessage(deps, makeMessageEvent(makeBinaryFrame(4, AUDIO_TYPE, new Uint8Array([1]))), NOOP, NOOP);
    // Replay.
    dispatchMessage(deps, makeMessageEvent(makeBinaryFrame(4, AUDIO_TYPE, new Uint8Array([2]))), NOOP, NOOP);
    // New seq.
    dispatchMessage(deps, makeMessageEvent(makeBinaryFrame(7, AUDIO_TYPE, new Uint8Array([3]))), NOOP, NOOP);

    expect(received).toHaveLength(2);
    expect(received[1]).toEqual(new Uint8Array([3]));
    expect(deps.cursor.cursor.lastSeq).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// JSON frame seq dedup
// ---------------------------------------------------------------------------

describe("dispatchMessage — JSON seq dedup", () => {
  it("calls the handler for a new JSON frame and advances lastSeq", () => {
    const deps = makeDeps();
    const calls: unknown[] = [];
    deps.messageHandlers.set("test.event", new Set([(msg) => calls.push(msg)]));

    const msg = JSON.stringify({ type: "test.event", seq: 1 });
    dispatchMessage(deps, makeMessageEvent(msg), NOOP, NOOP);

    expect(calls).toHaveLength(1);
    expect(deps.cursor.cursor.lastSeq).toBe(1);
  });

  it("drops a JSON frame whose seq <= lastSeq (handler not called)", () => {
    const deps = makeDeps();
    const calls: unknown[] = [];
    deps.messageHandlers.set("test.event", new Set([(msg) => calls.push(msg)]));

    // First frame.
    dispatchMessage(deps, makeMessageEvent(JSON.stringify({ type: "test.event", seq: 5 })), NOOP, NOOP);
    expect(calls).toHaveLength(1);

    // Replay.
    dispatchMessage(deps, makeMessageEvent(JSON.stringify({ type: "test.event", seq: 5 })), NOOP, NOOP);
    expect(calls).toHaveLength(1);

    // Even older.
    dispatchMessage(deps, makeMessageEvent(JSON.stringify({ type: "test.event", seq: 3 })), NOOP, NOOP);
    expect(calls).toHaveLength(1);
  });

  it("passes through JSON frames without a seq field (legacy frames)", () => {
    const deps = makeDeps();
    const calls: unknown[] = [];
    deps.messageHandlers.set("no.seq", new Set([(msg) => calls.push(msg)]));

    dispatchMessage(deps, makeMessageEvent(JSON.stringify({ type: "no.seq" })), NOOP, NOOP);
    dispatchMessage(deps, makeMessageEvent(JSON.stringify({ type: "no.seq" })), NOOP, NOOP);

    expect(calls).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// stream.resumed routing
// ---------------------------------------------------------------------------

describe("dispatchMessage — stream.resumed", () => {
  it("calls onStreamResumed(true) when recovered is true", () => {
    const deps = makeDeps();
    const msg = JSON.stringify({ type: "stream.resumed", recovered: true, epoch: 1 });
    dispatchMessage(deps, makeMessageEvent(msg), NOOP, NOOP);

    expect(deps.streamResumedCalls).toEqual([true]);
  });

  it("calls onStreamResumed(false) when recovered is false", () => {
    const deps = makeDeps();
    const msg = JSON.stringify({ type: "stream.resumed", recovered: false, epoch: 1 });
    dispatchMessage(deps, makeMessageEvent(msg), NOOP, NOOP);

    expect(deps.streamResumedCalls).toEqual([false]);
  });
});

// ---------------------------------------------------------------------------
// Auth-failure routing
//
// Pins the gateway↔SDK wire contract for the handshake failure frame. The
// gateway's auth gate has always closed the socket with `auth.error`
// (`ws-auth-gate.ts`), and mobile decodes it — but this router only knew
// `error`, so on the browser an auth failure was dropped: connect() stayed
// pending until the unrelated 10s auth timeout, the real code/reason was lost,
// and the reconnect loop (which stops only on lastErrorKind === "auth") kept
// retrying a token that will never work.
// ---------------------------------------------------------------------------

describe("dispatchMessage — auth failure", () => {
  function authErrorDeps(): ReturnType<typeof makeDeps> {
    return makeDeps({ getStatus: () => "authenticating" as SDKStatus });
  }

  it("rejects connect with the server's reason when auth.error arrives", () => {
    const deps = authErrorDeps();
    const rejections: Error[] = [];

    dispatchMessage(
      deps,
      makeMessageEvent(
        JSON.stringify({ type: "auth.error", code: "token-validation-failed", message: "token expired" }),
      ),
      NOOP,
      (err) => rejections.push(err),
    );

    expect(rejections.map((e) => e.message)).toEqual(["token expired"]);
    expect(deps.setLastErrorKind).toHaveBeenCalledWith("auth");
    expect(deps.setStatus).toHaveBeenCalledWith("error");
  });

  it("still rejects when auth.error carries no message", () => {
    const deps = authErrorDeps();
    const rejections: Error[] = [];

    dispatchMessage(
      deps,
      makeMessageEvent(JSON.stringify({ type: "auth.error", code: "session-limit" })),
      NOOP,
      (err) => rejections.push(err),
    );

    expect(rejections).toHaveLength(1);
    expect(deps.setLastErrorKind).toHaveBeenCalledWith("auth");
  });

  it("keeps routing the post-auth `error` frame as an auth failure while authenticating", () => {
    const deps = authErrorDeps();
    const rejections: Error[] = [];

    dispatchMessage(
      deps,
      makeMessageEvent(JSON.stringify({ type: "error", code: "protocol_error", message: "Session not authenticated" })),
      NOOP,
      (err) => rejections.push(err),
    );

    expect(rejections.map((e) => e.message)).toEqual(["Session not authenticated"]);
  });

  it("does not hijack an auth.error that arrives after the session is ready", () => {
    const deps = makeDeps();
    const calls: unknown[] = [];
    deps.messageHandlers.set("auth.error", new Set([(msg) => calls.push(msg)]));

    dispatchMessage(deps, makeMessageEvent(JSON.stringify({ type: "auth.error", code: "auth-required" })), NOOP, NOOP);

    expect(calls).toHaveLength(1);
    expect(deps.setStatus).not.toHaveBeenCalled();
  });
});
