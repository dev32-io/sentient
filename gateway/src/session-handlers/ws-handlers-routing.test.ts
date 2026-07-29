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
import type { PermissionBroker } from "../runtime/permission-broker.js";
import type { SessionRuntime } from "../runtime/session-runtime.js";
import type { Stimulus } from "../runtime/stimulus.js";
import { createFrameJournal } from "./frame-journal.js";
import { createReplayRegistry } from "./replay-registry.js";
import { cleanupSession, handleWebSocketMessage } from "./ws-handlers.js";
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

// cleanupSession() dereferences sessionManager AND replayRegistry. A real
// (tiny) registry is cheaper and more honest than a hand-rolled double.
const cleanupServices = {
  sessionManager: { unbindUser: () => {}, removeSession: () => {} },
  replayRegistry: createReplayRegistry({ maxBytesPerSurface: 65536, retentionMs: 1000 }),
} as unknown as GatewayServices;

interface StubPermissions extends PermissionBroker {
  resolveCalls: Array<{ requestId: string; approved: boolean }>;
  denyAllCallCount: () => number;
}

function stubPermissions(matches = true): StubPermissions {
  const resolveCalls: Array<{ requestId: string; approved: boolean }> = [];
  let denyAllCalls = 0;
  return {
    resolveCalls,
    denyAllCallCount: () => denyAllCalls,
    request: async () => false,
    resolve: (requestId, approved) => {
      resolveCalls.push({ requestId, approved });
      return matches;
    },
    denyAll: () => {
      denyAllCalls += 1;
    },
    get pendingCount() {
      return 0;
    },
  };
}

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

// ---------------------------------------------------------------------------
// permission.response (Plan 3 Task 6, spec §7.1). The security boundary being
// pinned: the ONLY broker a frame can reach is the one on its OWN socket, so
// a requestId minted on another connection resolves nothing.
// ---------------------------------------------------------------------------

describe("ws-handlers routing — permission.response", () => {
  it("routes the client's decision into this connection's permission broker", async () => {
    const { runtime } = stubRuntime();
    const permissions = stubPermissions();
    const ws = fakeAuthedWs(runtime);
    ws.data.permissions = permissions;

    await handleWebSocketMessage(
      ws as unknown as ServerWebSocket<SessionData>,
      JSON.stringify({ type: "permission.response", requestId: "req-1", approved: true }),
      unusedServices,
    );

    expect(permissions.resolveCalls).toEqual([{ requestId: "req-1", approved: true }]);
    expect(ws.sent).toEqual([]);
  });

  it("does not throw or answer when the requestId matches nothing on this connection", async () => {
    const { runtime } = stubRuntime();
    const permissions = stubPermissions(false);
    const ws = fakeAuthedWs(runtime);
    ws.data.permissions = permissions;

    await expect(
      handleWebSocketMessage(
        ws as unknown as ServerWebSocket<SessionData>,
        JSON.stringify({ type: "permission.response", requestId: "someone-elses-request", approved: true }),
        unusedServices,
      ),
    ).resolves.toBeUndefined();

    expect(ws.sent).toEqual([]);
  });

  it("is a safe no-op when the connection has no permission broker", async () => {
    const ws = fakeAuthedWs(null);

    await expect(
      handleWebSocketMessage(
        ws as unknown as ServerWebSocket<SessionData>,
        JSON.stringify({ type: "permission.response", requestId: "req-1", approved: true }),
        unusedServices,
      ),
    ).resolves.toBeUndefined();

    expect(ws.sent).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Journal discipline for the two frames this router emits. Which send helper
// each one takes is a wire-contract decision, not style:
//
//   - `error` is the gateway's substantive answer to a client action — an
//     `orchestrator_unavailable` is the ONLY signal that a `text.input` went
//     nowhere. A socket that drops before the client reads it must replay it,
//     so it is seq-stamped AND journaled like every other content frame.
//   - `pong` is a transport-liveness ack carrying no payload. Replaying a
//     stale pong tells a reconnected client nothing (it re-pings on its own
//     schedule), and journaling a periodic keepalive would burn seq numbers
//     and evict real replayable content from the byte-capped journal. So it
//     is validated but neither stamped nor journaled — the same class as
//     `stream.resumed`.
// ---------------------------------------------------------------------------

describe("ws-handlers outbound frames — journal discipline", () => {
  it("seq-stamps and journals an error frame so a reconnect replays it", async () => {
    const ws = fakeAuthedWs(null);
    const journal = createFrameJournal({ maxBytes: 65536 });
    ws.data.journal = journal;
    ws.data.epoch = 7;

    await handleWebSocketMessage(
      ws as unknown as ServerWebSocket<SessionData>,
      JSON.stringify({ type: "text.input", text: "no runtime yet" }),
      unusedServices,
    );

    expect(ws.sent).toEqual([
      { type: "error", code: "orchestrator_unavailable", message: expect.any(String), seq: 1, epoch: 7 },
    ]);
    expect(journal.newestSeq).toBe(1);
  });

  it("sends pong unstamped and unjournaled so keepalives never consume the replay window", async () => {
    const ws = fakeAuthedWs(null);
    const journal = createFrameJournal({ maxBytes: 65536 });
    ws.data.journal = journal;
    ws.data.epoch = 7;

    await handleWebSocketMessage(
      ws as unknown as ServerWebSocket<SessionData>,
      JSON.stringify({ type: "ping" }),
      unusedServices,
    );

    expect(ws.sent).toEqual([{ type: "pong" }]);
    expect(journal.newestSeq).toBe(0);
  });
});

describe("ws-handlers cleanup — outstanding permission prompts", () => {
  it("denies every open prompt so a dropped socket never leaks a pending promise", () => {
    const { runtime } = stubRuntime();
    const permissions = stubPermissions();
    const ws = fakeAuthedWs(runtime);
    ws.data.permissions = permissions;

    cleanupSession(ws as unknown as ServerWebSocket<SessionData>, cleanupServices);

    expect(permissions.denyAllCallCount()).toBe(1);
    expect(ws.data.permissions).toBeNull();
  });
});

describe("ws-handlers cleanup — replay journal", () => {
  it("releases the surface journal into the registry instead of dropping it", () => {
    const registry = createReplayRegistry({ maxBytesPerSurface: 65536, retentionMs: 60_000 });
    const services = {
      sessionManager: { unbindUser: () => {}, removeSession: () => {} },
      replayRegistry: registry,
    } as unknown as GatewayServices;

    const ws = fakeAuthedWs(null);
    const acquired = registry.acquire("u_deadbeef::surface-a", undefined);
    ws.data.journal = acquired.journal;
    ws.data.epoch = acquired.epoch;
    ws.data.replayLease = acquired.lease;

    cleanupSession(ws as unknown as ServerWebSocket<SessionData>, services);

    expect(ws.data.journal).toBeNull();
    expect(ws.data.replayLease).toBeNull();
    // Parked, not destroyed — a reconnect at the same epoch still resumes.
    expect(registry.acquire("u_deadbeef::surface-a", acquired.epoch).resumed).toBe(true);
  });
});
