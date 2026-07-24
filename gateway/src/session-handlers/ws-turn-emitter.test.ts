// Regression test for ws-turn-emitter.ts (Plan 2 Task 10) — the WS-layer
// TurnEmitter's outbound frame shapes. Pins the exact frame contract
// gateway/scripts/try-chat.ts:41-73 reads (response.text.delta / .text.done /
// .turn.started) so a future rename in ws-turn-emitter.ts breaks loudly here
// instead of silently in the dev harness. Zero live-key cost — a FakeWs
// double, no real provider/network I/O (mirrors ws-auth-gate.test.ts's
// FakeWs pattern).

import { describe, expect, it } from "bun:test";
import type { ServerWebSocket } from "bun";
import type { ToolUpdate } from "../runtime/react-loop.js";
import { type SessionData, createEmptySessionData } from "./ws-helpers.js";
import { createWsTurnEmitter } from "./ws-turn-emitter.js";

interface FakeWs {
  data: SessionData;
  sent: unknown[];
  send: (s: string) => void;
}

function fakeWs(): FakeWs {
  const data = createEmptySessionData();
  data.sessionId = "test-session";
  const ws: FakeWs = {
    data,
    sent: [],
    send(s) {
      ws.sent.push(JSON.parse(s));
    },
  };
  return ws;
}

function emitterFor(ws: FakeWs) {
  return createWsTurnEmitter(ws as unknown as ServerWebSocket<SessionData>);
}

describe("createWsTurnEmitter", () => {
  it("turnStarted sends exactly { type: response.turn.started, turnId }", () => {
    const ws = fakeWs();
    emitterFor(ws).turnStarted("turn-1");
    expect(ws.sent).toEqual([{ type: "response.turn.started", turnId: "turn-1" }]);
  });

  it("textDelta sends exactly { type: response.text.delta, text } — no turnId field", () => {
    const ws = fakeWs();
    emitterFor(ws).textDelta("turn-1", "hello");
    expect(ws.sent).toEqual([{ type: "response.text.delta", text: "hello" }]);
  });

  it("turnCompleted sends exactly { type: response.text.done, turnId }", () => {
    const ws = fakeWs();
    emitterFor(ws).turnCompleted("turn-1");
    expect(ws.sent).toEqual([{ type: "response.text.done", turnId: "turn-1" }]);
  });

  it("toolUpdate is log-only in Plan 2 — no frame reaches the client", () => {
    const ws = fakeWs();
    const update: ToolUpdate = { toolCallId: "c1", toolName: "delegateTask", status: "running" };
    emitterFor(ws).toolUpdate("turn-1", update);
    expect(ws.sent).toEqual([]);
  });

  it("turnAborted is log-only in Plan 2 — no frame reaches the client", () => {
    const ws = fakeWs();
    emitterFor(ws).turnAborted("turn-1", "interrupt");
    expect(ws.sent).toEqual([]);
  });

  it("a send failure (e.g. socket already closed) is caught, not thrown", () => {
    const ws = fakeWs();
    ws.send = () => {
      throw new Error("socket closed");
    };
    expect(() => emitterFor(ws).textDelta("turn-1", "x")).not.toThrow();
  });
});
