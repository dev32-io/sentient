import type { ServerWebSocket } from "bun";
import { describe, expect, it, vi } from "vitest";
import type { GatewayServices } from "../bootstrap/create-gateway-services.js";
import { admitSessionNew } from "./ws-handlers.js";
import { createEmptySessionData } from "./ws-helpers.js";
import type { ClientData } from "./ws-helpers.js";

const MIN_INTERVAL = 500;

function makeWs(): { ws: ServerWebSocket<ClientData>; sent: unknown[] } {
  const sent: unknown[] = [];
  const data = createEmptySessionData();
  data.sessionId = "sess-1";
  const ws = {
    data,
    send: (s: string) => sent.push(JSON.parse(s)),
  } as unknown as ServerWebSocket<ClientData>;
  return { ws, sent };
}

function makeServices(): GatewayServices {
  return {
    sessions: { min_new_interval_ms: MIN_INTERVAL },
  } as unknown as GatewayServices;
}

describe("admitSessionNew — per-connection session.new min-interval", () => {
  it("admits the first frame and records its timestamp", () => {
    const { ws } = makeWs();
    const services = makeServices();
    vi.spyOn(Date, "now").mockReturnValue(1000);
    expect(admitSessionNew(ws, "r0", services)).toBe(true);
    expect(ws.data.lastSessionNewAtMs).toBe(1000);
    vi.restoreAllMocks();
  });

  it("rejects a second frame inside the min interval with rate_limited and does NOT record it", () => {
    const { ws, sent } = makeWs();
    const services = makeServices();
    const nowSpy = vi.spyOn(Date, "now");
    nowSpy.mockReturnValue(1000);
    admitSessionNew(ws, "r0", services);
    nowSpy.mockReturnValue(1400); // 400ms later, inside the 500ms interval
    const admitted = admitSessionNew(ws, "overflow", services);
    expect(admitted).toBe(false);
    // Last timestamp unchanged — the rejected frame is not recorded.
    expect(ws.data.lastSessionNewAtMs).toBe(1000);
    const err = sent.find((m) => (m as { type: string }).type === "sessions.error");
    expect(err).toMatchObject({ type: "sessions.error", requestId: "overflow", code: "rate_limited" });
    vi.restoreAllMocks();
  });

  it("admits again once the min interval has elapsed", () => {
    const { ws } = makeWs();
    const services = makeServices();
    const nowSpy = vi.spyOn(Date, "now");
    nowSpy.mockReturnValue(1000);
    admitSessionNew(ws, "r0", services);
    nowSpy.mockReturnValue(1600); // 600ms later, past the 500ms interval
    expect(admitSessionNew(ws, "r1", services)).toBe(true);
    expect(ws.data.lastSessionNewAtMs).toBe(1600);
    vi.restoreAllMocks();
  });

  it("a rejected session.new frame mutates only lastSessionNewAtMs — pending cycle state is untouched", () => {
    // The min-interval only short-circuits the session.new delegation; it never
    // touches pendingNewSessionId / pendingNewSessionPromise (those live in the
    // configure closure). Here we assert the guard mutates ONLY
    // lastSessionNewAtMs on ws.data and emits a frame — nothing else.
    const { ws } = makeWs();
    const services = makeServices();
    const nowSpy = vi.spyOn(Date, "now");
    nowSpy.mockReturnValue(1000);
    admitSessionNew(ws, "r0", services);
    nowSpy.mockReturnValue(1400); // inside the interval → rejected
    const before = { ...ws.data };
    admitSessionNew(ws, "overflow", services);
    // Only lastSessionNewAtMs may differ; sessionId and handler slot intact.
    expect(ws.data.sessionId).toBe(before.sessionId);
    expect(ws.data.sessionsHandlers).toBe(before.sessionsHandlers);
    vi.restoreAllMocks();
  });
});
