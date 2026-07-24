// Regression test for the `text.input` / `interrupt` routing added to
// ws-handlers.ts (Plan 2 Task 10) — the WS message router's seam onto
// `ws.data.runtime` (SessionRuntime). Zero live-key cost — a FakeWs double
// (mirrors ws-auth-gate.test.ts's FakeWs pattern) plus a stub SessionRuntime;
// no real provider/network I/O, `services` is never touched by these two
// branches so a cast stub is sufficient.

import { describe, expect, it } from "bun:test";
import type { ServerWebSocket } from "bun";
import type { GatewayServices } from "../bootstrap/create-gateway-services.js";
import { createUserPrincipal } from "../identity/user-principal.js";
import type { SessionRuntime } from "../runtime/session-runtime.js";
import type { Stimulus } from "../runtime/stimulus.js";
import { handleWebSocketMessage } from "./ws-handlers.js";
import { type SessionData, createEmptySessionData } from "./ws-helpers.js";

interface FakeWs {
  data: SessionData;
  sent: unknown[];
  send: (s: string) => void;
}

function fakeAuthedWs(runtime: SessionRuntime | null): FakeWs {
  const data = createEmptySessionData();
  data.sessionId = "test-session";
  data.authState = "authed";
  data.principal = createUserPrincipal("u_deadbeef", "adult", "home");
  data.runtime = runtime;
  const ws: FakeWs = {
    data,
    sent: [],
    send(s) {
      ws.sent.push(JSON.parse(s));
    },
  };
  return ws;
}

interface StubRuntime {
  runtime: SessionRuntime;
  submitCalls: Stimulus[];
  interruptCallCount: () => number;
}

function stubRuntime(): StubRuntime {
  const submitCalls: Stimulus[] = [];
  let interruptCalls = 0;
  const runtime: SessionRuntime = {
    userId: "u_deadbeef" as SessionRuntime["userId"],
    submit: (s) => {
      submitCalls.push(s);
    },
    get running() {
      return false;
    },
    dispose: () => {},
    bargeIn: () => {},
    interrupt: () => {
      interruptCalls += 1;
    },
  };
  return { runtime, submitCalls, interruptCallCount: () => interruptCalls };
}

// `services` is never dereferenced by the `text.input` / `interrupt` cases —
// see ws-handlers.ts's switch. A cast stub keeps this test independent of
// GatewayServices' large surface without exercising any of it.
const unusedServices = {} as GatewayServices;

describe("ws-handlers routing — text.input", () => {
  it("submits a conversational stimulus with the message text when runtime is set", async () => {
    const { runtime, submitCalls } = stubRuntime();
    const ws = fakeAuthedWs(runtime);

    await handleWebSocketMessage(
      ws as unknown as ServerWebSocket<SessionData>,
      JSON.stringify({ type: "text.input", text: "hello there" }),
      unusedServices,
    );

    expect(submitCalls).toEqual([{ kind: "conversational", text: "hello there" }]);
  });

  it("calls runtime.submit exactly once per message", async () => {
    const { runtime, submitCalls } = stubRuntime();
    const ws = fakeAuthedWs(runtime);

    await handleWebSocketMessage(
      ws as unknown as ServerWebSocket<SessionData>,
      JSON.stringify({ type: "text.input", text: "one call only" }),
      unusedServices,
    );

    expect(submitCalls.length).toBe(1);
  });

  it("does not throw and emits orchestrator_unavailable when runtime is null (pre-configure)", async () => {
    const ws = fakeAuthedWs(null);

    await expect(
      handleWebSocketMessage(
        ws as unknown as ServerWebSocket<SessionData>,
        JSON.stringify({ type: "text.input", text: "no runtime yet" }),
        unusedServices,
      ),
    ).resolves.toBeUndefined();

    expect(ws.sent).toEqual([{ type: "error", code: "orchestrator_unavailable", message: expect.any(String) }]);
  });
});

describe("ws-handlers routing — interrupt", () => {
  it("calls runtime.interrupt() when runtime is set", async () => {
    const { runtime, interruptCallCount } = stubRuntime();
    const ws = fakeAuthedWs(runtime);

    await handleWebSocketMessage(
      ws as unknown as ServerWebSocket<SessionData>,
      JSON.stringify({ type: "interrupt" }),
      unusedServices,
    );

    expect(interruptCallCount()).toBe(1);
  });

  it("is a safe no-op (no throw, no frame) when runtime is null", async () => {
    const ws = fakeAuthedWs(null);

    await expect(
      handleWebSocketMessage(
        ws as unknown as ServerWebSocket<SessionData>,
        JSON.stringify({ type: "interrupt" }),
        unusedServices,
      ),
    ).resolves.toBeUndefined();

    expect(ws.sent).toEqual([]);
  });
});
