import { describe, expect, it } from "vitest";
import { type AcpWsLike, bootstrapAcpWire, deriveAcpUrl } from "./wire-bootstrap.js";

// Wire-bootstrap is the WS-layer glue that connects acp_ws_server.py to the
// AcpPerProfileConnection. These tests exercise the URL rewrite, the open
// handshake driving `initialize`, and the failure paths (timeout / pre-open
// close / failed initialize) — all without dialing real sockets.

interface FakeWs {
  readonly base: AcpWsLike;
  /** Synchronously fire each listener registered for `type`. */
  fire(type: "open"): void;
  fire(type: "close", e: { code: number; reason: string }): void;
  fire(type: "error", e: unknown): void;
  fire(type: "message", e: { data: string }): void;
  /** Captured `send(data)` payloads. */
  readonly sent: string[];
  closed: boolean;
}

function fakeWs(initialReadyState = 0): FakeWs {
  const openListeners: Array<() => void> = [];
  const closeListeners: Array<(e: { code: number; reason: string }) => void> = [];
  const errorListeners: Array<(e: unknown) => void> = [];
  const messageListeners: Array<(e: { data: string }) => void> = [];

  let readyState = initialReadyState;
  const sent: string[] = [];
  const out: FakeWs = {
    base: {
      get readyState() {
        return readyState;
      },
      send(data: string) {
        sent.push(data);
      },
      close() {
        readyState = 3;
        out.closed = true;
      },
      addEventListener(type: string, listener: unknown) {
        if (type === "open") openListeners.push(listener as () => void);
        else if (type === "close") closeListeners.push(listener as (e: { code: number; reason: string }) => void);
        else if (type === "error") errorListeners.push(listener as (e: unknown) => void);
        else if (type === "message") messageListeners.push(listener as (e: { data: string }) => void);
      },
    } as AcpWsLike,
    fire(type: string, evt?: unknown): void {
      if (type === "open") {
        readyState = 1;
        for (const l of openListeners) l();
      } else if (type === "close") {
        for (const l of closeListeners) l(evt as { code: number; reason: string });
      } else if (type === "error") {
        for (const l of errorListeners) l(evt);
      } else if (type === "message") {
        for (const l of messageListeners) l(evt as { data: string });
      }
    },
    sent,
    closed: false,
  };
  return out;
}

describe("deriveAcpUrl", () => {
  it("rewrites a trailing /ws to /acp", () => {
    expect(deriveAcpUrl("ws://hermes:8765/ws")).toBe("ws://hermes:8765/acp");
    expect(deriveAcpUrl("wss://hermes.example/ws")).toBe("wss://hermes.example/acp");
  });

  it("appends /acp when no /ws suffix is present", () => {
    expect(deriveAcpUrl("ws://hermes:8765")).toBe("ws://hermes:8765/acp");
    expect(deriveAcpUrl("ws://hermes:8765/")).toBe("ws://hermes:8765/acp");
  });
});

describe("bootstrapAcpWire", () => {
  it("opens the WS, runs initialize, returns a working acpConn", async () => {
    const ws = fakeWs();
    const promise = bootstrapAcpWire({
      wsUrl: "ws://hermes:8765/ws",
      token: "tok",
      wsFactory: () => ws.base,
    });

    // Open the socket → acpConn.initialize fires.
    ws.fire("open");
    // Wait a microtask so the initialize() request is sent.
    await Promise.resolve();
    await Promise.resolve();

    expect(ws.sent).toHaveLength(1);
    const req = JSON.parse(ws.sent[0] ?? "{}") as { id: number; method: string };
    expect(req.method).toBe("initialize");

    // Reply with a valid initialize result → bootstrap resolves.
    ws.fire("message", {
      data: JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { protocolVersion: 1 } }),
    });

    const result = await promise;
    expect(result.acpConn).toBeDefined();
    expect(typeof result.dispose).toBe("function");

    result.dispose();
    expect(ws.closed).toBe(true);
  });

  it("rejects when the WS closes before opening", async () => {
    const ws = fakeWs();
    const promise = bootstrapAcpWire({
      wsUrl: "ws://hermes:8765/ws",
      token: "tok",
      wsFactory: () => ws.base,
    });
    ws.fire("close", { code: 1006, reason: "transport failure" });
    await expect(promise).rejects.toThrow(/closed-before-open/);
  });

  it("rejects when initialize returns an invalid response", async () => {
    const ws = fakeWs();
    const promise = bootstrapAcpWire({
      wsUrl: "ws://hermes:8765/ws",
      token: "tok",
      wsFactory: () => ws.base,
    });
    ws.fire("open");
    await Promise.resolve();
    await Promise.resolve();

    const req = JSON.parse(ws.sent[0] ?? "{}") as { id: number };
    ws.fire("message", {
      data: JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { protocolVersion: -5 } }),
    });

    await expect(promise).rejects.toThrow(/initialize.*validation failed/i);
    expect(ws.closed).toBe(true);
  });

  it("times out and closes the socket when open never fires", async () => {
    const ws = fakeWs();
    const promise = bootstrapAcpWire({
      wsUrl: "ws://hermes:8765/ws",
      token: "tok",
      wsFactory: () => ws.base,
      openTimeoutMs: 5,
    });
    await expect(promise).rejects.toThrow(/open-timeout/);
    expect(ws.closed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Reconnect / re-bootstrap resilience — the FSM invariant this fix pins:
// a resumed session whose ACP wire flaps (abnormal close) must re-open + re-run
// `initialize` on the next dispatch send and keep dispatching. A clean close
// (1000 / teardown) must NOT reconnect. Reconnect is bounded.
// ---------------------------------------------------------------------------

/** Reply to the most recent request on a socket with a valid result. */
function replyInitialize(ws: FakeWs): void {
  const last = ws.sent[ws.sent.length - 1];
  const req = JSON.parse(last ?? "{}") as { id: number; method: string };
  ws.fire("message", {
    data: JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { protocolVersion: 1 } }),
  });
}

/** Drive open → initialize on a freshly handed-out socket so the wire is live. */
async function settleOpen(ws: FakeWs): Promise<void> {
  ws.fire("open");
  await Promise.resolve();
  await Promise.resolve();
  replyInitialize(ws);
  await Promise.resolve();
}

/** Flush microtasks until a frame with `method` lands on the socket, or give up. */
async function flushUntilMethod(ws: FakeWs, method: string): Promise<{ id: number; method: string }> {
  for (let i = 0; i < 20; i++) {
    const last = ws.sent[ws.sent.length - 1];
    if (last !== undefined) {
      const frame = JSON.parse(last) as { id: number; method: string };
      if (frame.method === method) return frame;
    }
    await Promise.resolve();
  }
  const last = ws.sent[ws.sent.length - 1];
  return JSON.parse(last ?? "{}") as { id: number; method: string };
}

describe("bootstrapAcpWire — reconnect on abnormal close", () => {
  it("re-bootstraps the wire on a 1006 close so the next dispatch succeeds", async () => {
    const sockets: FakeWs[] = [];
    const factory = (): AcpWsLike => {
      const w = fakeWs();
      sockets.push(w);
      return w.base;
    };
    const promise = bootstrapAcpWire({
      wsUrl: "ws://hermes:8765/ws",
      token: "tok",
      wsFactory: factory,
      reconnect: { baseMs: 0, maxMs: 0, jitterMs: 0, maxAttempts: 3 },
      sleep: () => Promise.resolve(),
    });
    await settleOpen(sockets[0] as FakeWs);
    const { acpConn } = await promise;
    expect(sockets).toHaveLength(1);

    // Abnormal close — wire goes dead, no eager reconnect yet.
    (sockets[0] as FakeWs).fire("close", { code: 1006, reason: "Connection ended" });

    // Next dispatch send (newSession) triggers re-open + re-initialize.
    const newSessionPromise = acpConn.newSession({});
    await Promise.resolve();
    await Promise.resolve();
    expect(sockets).toHaveLength(2);
    const fresh = sockets[1] as FakeWs;
    // The fresh socket re-runs initialize first, then the session/new send.
    await settleOpen(fresh);
    // After initialize resolves the queued session/new send flushes — give the
    // ensureOpen→send promise chain a few microtasks to land the frame.
    const sessionNewReq = await flushUntilMethod(fresh, "session/new");
    expect(sessionNewReq.method).toBe("session/new");
    fresh.fire("message", {
      data: JSON.stringify({ jsonrpc: "2.0", id: sessionNewReq.id, result: { sessionId: "s-reconnected" } }),
    });

    await expect(newSessionPromise).resolves.toEqual({ sessionId: "s-reconnected" });
  });

  it("does NOT reconnect on a clean 1000 close (deliberate teardown)", async () => {
    const sockets: FakeWs[] = [];
    const factory = (): AcpWsLike => {
      const w = fakeWs();
      sockets.push(w);
      return w.base;
    };
    const promise = bootstrapAcpWire({
      wsUrl: "ws://hermes:8765/ws",
      token: "tok",
      wsFactory: factory,
      reconnect: { baseMs: 0, maxMs: 0, jitterMs: 0, maxAttempts: 3 },
      sleep: () => Promise.resolve(),
    });
    await settleOpen(sockets[0] as FakeWs);
    const { acpConn } = await promise;

    // Normal closure — must not reconnect. The next send rejects instead of
    // re-opening (no new socket handed out).
    (sockets[0] as FakeWs).fire("close", { code: 1000, reason: "session end" });
    await expect(acpConn.newSession({})).rejects.toThrow(/closed cleanly|reconnect blocked/);
    expect(sockets).toHaveLength(1);
  });

  it("does NOT reconnect after dispose() (consumer disconnect)", async () => {
    const sockets: FakeWs[] = [];
    const factory = (): AcpWsLike => {
      const w = fakeWs();
      sockets.push(w);
      return w.base;
    };
    const promise = bootstrapAcpWire({
      wsUrl: "ws://hermes:8765/ws",
      token: "tok",
      wsFactory: factory,
      reconnect: { baseMs: 0, maxMs: 0, jitterMs: 0, maxAttempts: 3 },
      sleep: () => Promise.resolve(),
    });
    await settleOpen(sockets[0] as FakeWs);
    const { acpConn, dispose } = await promise;

    dispose();
    await expect(acpConn.newSession({})).rejects.toThrow();
    expect(sockets).toHaveLength(1);
  });

  it("bounds reconnect: surfaces an error after exhausting attempts on persistent failure", async () => {
    const sockets: FakeWs[] = [];
    const factory = (): AcpWsLike => {
      const w = fakeWs();
      sockets.push(w);
      return w.base;
    };
    const promise = bootstrapAcpWire({
      wsUrl: "ws://hermes:8765/ws",
      token: "tok",
      wsFactory: factory,
      reconnect: { baseMs: 0, maxMs: 0, jitterMs: 0, maxAttempts: 3 },
      sleep: () => Promise.resolve(),
    });
    await settleOpen(sockets[0] as FakeWs);
    const { acpConn } = await promise;

    // Abnormal close, then EVERY re-open attempt also fails (close-before-open).
    (sockets[0] as FakeWs).fire("close", { code: 1006, reason: "Connection ended" });
    const sendPromise = acpConn.newSession({});

    // Drive each reconnect attempt's socket to fail to open. The backoff sleep
    // is faked to resolve immediately, so a microtask flush advances attempts.
    for (let i = 0; i < 10; i++) {
      const latest = sockets[sockets.length - 1];
      if (latest && !latest.closed) latest.fire("close", { code: 1006, reason: "still down" });
      await Promise.resolve();
      await Promise.resolve();
    }

    await expect(sendPromise).rejects.toThrow(/reconnect-exhausted|closed-before-open|not open/);
    // 1 initial + 3 reconnect attempts (maxAttempts=3).
    expect(sockets.length).toBeGreaterThanOrEqual(2);
    expect(sockets.length).toBeLessThanOrEqual(4);
  });
});
