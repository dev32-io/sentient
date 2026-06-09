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
// a resumed session whose ACP wire drops REMOTELY — abnormal close OR a remote
// 1000 (overlay restart) — must re-open + re-run `initialize` on the next
// dispatch send and keep dispatching. Only a local `dispose()` is terminal.
// Reconnect is bounded.
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

  it("re-attaches a CAPTURED conversation via session/load before the first post-reconnect prompt", async () => {
    // The overlay spawns a FRESH Hermes ACP child per WS connection — empty
    // in-process session state. A captured conversationId the prior child knew
    // is unknown to the new child, so the gateway must session/load it before
    // session/prompt or the prompt 404s ("session not found"). This is the
    // continuation case the single 1006 test missed (it did a fresh session/new).
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

    // Mint the conversation on the FIRST child (epoch 1) so it is "known" there.
    const first = sockets[0] as FakeWs;
    const newPromise = acpConn.newSession({});
    const newReq = await flushUntilMethod(first, "session/new");
    first.fire("message", {
      data: JSON.stringify({ jsonrpc: "2.0", id: newReq.id, result: { sessionId: "conv-1" } }),
    });
    await newPromise;

    // Wire flaps — abnormal close. The captured conversationId survives in the
    // dispatch layer (binding), but the next child will be brand-new.
    first.fire("close", { code: 1006, reason: "worker restart" });

    // Continuation: prompt on the SAME conversationId. The fresh child must
    // first receive session/load(conv-1), THEN session/prompt.
    const promptPromise = acpConn.sendUserMessage({ sessionId: "conv-1", text: "still there?" });
    await Promise.resolve();
    await Promise.resolve();
    expect(sockets).toHaveLength(2);
    const fresh = sockets[1] as FakeWs;
    await settleOpen(fresh);

    // First wire op on the fresh child is session/load, not session/prompt.
    const loadReq = await flushUntilMethod(fresh, "session/load");
    expect(loadReq.method).toBe("session/load");
    expect(
      (JSON.parse(fresh.sent[fresh.sent.length - 1] as string) as { params: { sessionId: string } }).params.sessionId,
    ).toBe("conv-1");
    fresh.fire("message", { data: JSON.stringify({ jsonrpc: "2.0", id: loadReq.id, result: {} }) });

    // Then the prompt lands and succeeds (no refusal / not-found).
    const promptReq = await flushUntilMethod(fresh, "session/prompt");
    expect(
      (JSON.parse(fresh.sent[fresh.sent.length - 1] as string) as { params: { sessionId: string } }).params.sessionId,
    ).toBe("conv-1");
    fresh.fire("message", {
      data: JSON.stringify({ jsonrpc: "2.0", id: promptReq.id, result: { stopReason: "end_turn" } }),
    });
    await expect(promptPromise).resolves.toMatchObject({ stopReason: "end_turn" });
  });

  it("rejects an in-flight prompt when the live socket closes ABNORMALLY (no hang)", async () => {
    // A session/prompt already on the wire when the worker dies mid-cycle must
    // REJECT — not hang forever. ManagedAcpSocket.onRemoteClose →
    // acpConn.rejectInflight rejects the pending request so the dispatcher can
    // surface a terminal error instead of blocking on a response that will
    // never arrive.
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
    const live = sockets[0] as FakeWs;

    // Attach the session on this child so the prompt goes straight out.
    const loadPromise = acpConn.loadSession({ sessionId: "conv-x" });
    const loadReq = await flushUntilMethod(live, "session/load");
    live.fire("message", { data: JSON.stringify({ jsonrpc: "2.0", id: loadReq.id, result: {} }) });
    await loadPromise;

    // Prompt goes on the wire — but NO response comes; instead the socket dies.
    const promptPromise = acpConn.sendUserMessage({ sessionId: "conv-x", text: "hello?" });
    await flushUntilMethod(live, "session/prompt");

    // Abnormal close while the prompt is in flight → reject, not hang.
    live.fire("close", { code: 1006, reason: "worker died mid-cycle" });
    await expect(promptPromise).rejects.toThrow(/acp-wire-flap|connection lost/);
  });

  it("RECONNECTS on a REMOTE 1000 close (overlay restart) so the next dispatch succeeds", async () => {
    // A genuine remote 1000 (overlay restart / transient) must NOT permanently
    // strand an active client. Only a local dispose() is terminal — a remote
    // 1000 flows through the same lazy-reconnect path as an abnormal close.
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

    // Remote normal-closure — wire goes dead, no eager reconnect yet.
    (sockets[0] as FakeWs).fire("close", { code: 1000, reason: "overlay restart" });

    // Next dispatch send (newSession) triggers re-open + re-initialize.
    const newSessionPromise = acpConn.newSession({});
    await Promise.resolve();
    await Promise.resolve();
    expect(sockets).toHaveLength(2);
    const fresh = sockets[1] as FakeWs;
    await settleOpen(fresh);
    const sessionNewReq = await flushUntilMethod(fresh, "session/new");
    expect(sessionNewReq.method).toBe("session/new");
    fresh.fire("message", {
      data: JSON.stringify({ jsonrpc: "2.0", id: sessionNewReq.id, result: { sessionId: "s-after-1000" } }),
    });

    await expect(newSessionPromise).resolves.toEqual({ sessionId: "s-after-1000" });
  });

  it("rejects an in-flight prompt when the live socket closes with a REMOTE 1000 (no hang)", async () => {
    // A remote 1000 mid-prompt is just as fatal to the in-flight request as an
    // abnormal close — the dead child will never answer it. onRemoteClose must
    // reject pending so the dispatcher surfaces a terminal error, not a hang.
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
    const live = sockets[0] as FakeWs;

    const loadPromise = acpConn.loadSession({ sessionId: "conv-y" });
    const loadReq = await flushUntilMethod(live, "session/load");
    live.fire("message", { data: JSON.stringify({ jsonrpc: "2.0", id: loadReq.id, result: {} }) });
    await loadPromise;

    const promptPromise = acpConn.sendUserMessage({ sessionId: "conv-y", text: "hello?" });
    await flushUntilMethod(live, "session/prompt");

    // Remote 1000 while the prompt is in flight → reject, not hang.
    live.fire("close", { code: 1000, reason: "overlay restart mid-cycle" });
    await expect(promptPromise).rejects.toThrow(/acp-wire-flap|connection lost/);
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

  it("remote 1000 then dispose(): reconnectable until dispose, then terminal with no new socket", async () => {
    // Interleaving the 2d8f6c4 rework reopened: a remote 1000 leaves the wire
    // DEAD-but-reconnectable (ws=null, not disposed). If the consumer then
    // dispose()s before any reconnect, dispose() must flip the wire terminal —
    // the next op rejects (connection-disposed) and dispose() opens NO new
    // socket (the dead handle is already gone, so there is nothing to close and
    // nothing to re-dial).
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
    expect(sockets).toHaveLength(1);

    // Remote normal-closure — wire dead but reconnectable, NOT disposed.
    (sockets[0] as FakeWs).fire("close", { code: 1000, reason: "overlay restart" });
    // No reconnect happens until the next send/dispose — still one socket.
    expect(sockets).toHaveLength(1);

    // Now the consumer disconnects BEFORE any reconnect send. This is terminal.
    dispose();
    await expect(acpConn.newSession({})).rejects.toThrow(/connection-disposed/);
    // dispose() over an already-dead wire opens no fresh socket.
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
