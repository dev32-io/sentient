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
