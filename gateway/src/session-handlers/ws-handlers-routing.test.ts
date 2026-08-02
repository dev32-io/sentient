// Regression test for the `text.input` / `interrupt` routing added to
// ws-handlers.ts (Plan 2 Task 10) — the WS message router's seam onto
// `ws.data.runtime` (SessionRuntime). Zero live-key cost — a FakeWs double
// (mirrors ws-auth-gate.test.ts's FakeWs pattern) plus a stub SessionRuntime;
// no real provider/network I/O, `services` is never touched by these two
// branches so a cast stub is sufficient.

import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { gatewayMessageSchema } from "@sentient/protocol";
import type { ServerWebSocket } from "bun";
import { type AccessManager, createAccessManager } from "../access/access-manager.js";
import type { GatewayServices } from "../bootstrap/create-gateway-services.js";
import { createUserPrincipal } from "../identity/user-principal.js";
import type { PermissionBroker } from "../runtime/permission-broker.js";
import type { SessionRuntime } from "../runtime/session-runtime.js";
import type { Stimulus } from "../runtime/stimulus.js";
import { openSessionStore } from "../store/session-store.js";
import { createConversationRuntimeRegistry } from "./conversation-runtime-registry.js";
import { createFrameJournal } from "./frame-journal.js";
import { createReplayRegistry } from "./replay-registry.js";
import { mintDraftKey, mintSessionId } from "./session-id.js";
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
    emitConversationSnapshot: () => {},
  };
  return { runtime, submitCalls, interruptCallCount: () => interruptCalls };
}

// `services` is never dereferenced by the `text.input` / `interrupt` cases —
// see ws-handlers.ts's switch. A cast stub keeps this test independent of
// GatewayServices' large surface without exercising any of it.
const unusedServices = {} as GatewayServices;

/** A draft key shaped exactly as session-id.ts mints them (`d_` + 32 hex). */
const DRAFT_KEY = `d_${"ab".repeat(16)}`;

// --- conversation.activate fixtures ------------------------------------------
// A real, per-test-isolated AccessManager + store: handleConversationActivate
// does a genuine membership lookup (resolveSession over the caller's own
// store), so a cast stub cannot stand in the way it can for text.input/interrupt.

const ACTIVATE_ROOT = "/tmp/sentient-ws-conversation-activate-test";
mkdirSync(ACTIVATE_ROOT, { recursive: true });
afterAll(() => rmSync(ACTIVATE_ROOT, { recursive: true, force: true }));

let activateRunSeq = 0;

/** Services for conversation.activate: a fresh AccessManager over its own data
 *  root (no test can see another's rows), a working (stub) runtime factory so
 *  bindSessionRuntime succeeds, and a real ConversationRuntimeRegistry so
 *  live-rival-owner checks are genuine rather than assumed. */
function activateServices(): GatewayServices {
  activateRunSeq += 1;
  const accessManager = createAccessManager({ userDataRoot: `${ACTIVATE_ROOT}/run-${activateRunSeq}` });
  const runtimeStub = { emitConversationSnapshot: () => {}, dispose: () => {} } as unknown as SessionRuntime;
  return {
    accessManager,
    conversationRuntimes: createConversationRuntimeRegistry(),
    profileStore: { get: async () => ({ ok: false, error: "no profile in this test" }) },
    createSynthesizerFor: () => null,
    stt: null,
    createSessionRuntime: () => ({ runtime: runtimeStub, permissions: { denyAll: () => {} } }),
  } as unknown as GatewayServices;
}

/** Puts a real session with one entry in [userId]'s own store (opened through
 *  [accessManager]) and returns its id — the state a caller is in when
 *  activate should be able to resolve and reopen it. */
function seedActivatableSession(accessManager: AccessManager, userId: string): string {
  const store = openSessionStore(accessManager.grant(createUserPrincipal(userId, "adult", "home"), "session-store"));
  const sessionId = mintSessionId();
  store.createSession(sessionId, `mint-${sessionId}`);
  store.close();
  return sessionId;
}

// cleanupSession() dereferences sessionManager, replayRegistry, and (once
// session.configure has resolved a conversation) conversationRuntimes. Real
// (tiny) registries are cheaper and more honest than hand-rolled doubles.
const cleanupServices = {
  sessionManager: { unbindUser: () => {}, removeSession: () => {} },
  replayRegistry: createReplayRegistry({ maxBytesPerSurface: 65536, retentionMs: 1000 }),
  conversationRuntimes: createConversationRuntimeRegistry(),
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

// ---------------------------------------------------------------------------
// session.new / conversation.activate (defect D12). The wire contract being
// pinned at the process boundary: a client that asks for a chat GETS AN
// ANSWER. Both mobile SDKs gate their outbound queue on the id that answer
// carries (`SendMessageUseCase.flushIfReady` → `attachedId`), so silence here
// is not a missing nicety — it is every mobile text send dying on the device.
//
// `conversation.activate` used to be pinned as deliberately UNANSWERED: mobile's
// history connector treats a `session.switched` as "refetch over
// `GET /sessions/:id/messages`", and its 404 branch called
// `replaceMirror(emptyList())` — answering would have wiped the visible chat.
// That route now exists (api/handlers/sessions.ts, session-model plan task 4),
// which is what makes ws-conversation-activate.ts's answer safe. See that
// file's header for the full reasoning, and its membership/rival-owner checks.
// ---------------------------------------------------------------------------

describe("ws-handlers routing — session.new", () => {
  it("CONTRACT: an implicit session.new re-attaches the bound session instead of forking one", async () => {
    // Mobile fires this on EVERY launch, twice per launch. Answering it as a
    // new chat is what would hand every relaunch an empty conversation.
    const ws = fakeAuthedWs(null);
    ws.data.conversationId = "c::u_deadbeef::surface-a";
    ws.data.draftKey = DRAFT_KEY;

    await handleWebSocketMessage(
      ws as unknown as ServerWebSocket<SessionData>,
      JSON.stringify({ type: "session.new", requestId: "r1" }),
      unusedServices,
    );

    const reply = ws.sent.find((f) => (f as { type: string }).type === "session.created");
    expect(reply).toBeDefined();
    expect((reply as { sessionId: string }).sessionId).toBe("c::u_deadbeef::surface-a");
    // The frame must survive the outbound validator, not merely be constructed —
    // sendGatewayFrame DROPS anything gatewayMessageSchema rejects, which would
    // look exactly like the silence this case exists to remove.
    expect(gatewayMessageSchema.safeParse(reply).success).toBe(true);
  });

  it("CONTRACT: an explicit session.new unbinds the session and hands back a draft key", async () => {
    const ws = fakeAuthedWs(null);
    ws.data.conversationId = "c::u_deadbeef::surface-a";
    ws.data.draftKey = DRAFT_KEY;

    await handleWebSocketMessage(
      ws as unknown as ServerWebSocket<SessionData>,
      JSON.stringify({ type: "session.new", requestId: "r1", intent: "explicit" }),
      cleanupServices,
    );

    const reply = ws.sent.find((f) => (f as { type: string }).type === "session.draft");
    expect(reply).toBeDefined();
    expect(gatewayMessageSchema.safeParse(reply).success).toBe(true);
    // A fresh key, not the one the bound connection was carrying: reusing it
    // would let the next mint collide with a session this draft never owned.
    expect((reply as { draftKey: string }).draftKey).not.toBe(DRAFT_KEY);
    expect(ws.data.conversationId).toBeNull();
  });

  it("seq-stamps and journals the answer so a reconnect replays the anchor", async () => {
    const ws = fakeAuthedWs(null);
    ws.data.conversationId = "c::u_deadbeef::surface-a";
    ws.data.draftKey = DRAFT_KEY;
    const journal = createFrameJournal({ maxBytes: 65536 });
    ws.data.journal = journal;
    ws.data.epoch = 4;

    await handleWebSocketMessage(
      ws as unknown as ServerWebSocket<SessionData>,
      JSON.stringify({ type: "session.new", requestId: "r1" }),
      unusedServices,
    );

    expect(ws.sent).toEqual([
      { type: "session.created", sessionId: "c::u_deadbeef::surface-a", ts: expect.any(Number), seq: 1, epoch: 4 },
    ]);
    expect(journal.newestSeq).toBe(1);
  });

  it("answers sessions.error when the connection never configured, never silence", async () => {
    const ws = fakeAuthedWs(null);

    await handleWebSocketMessage(
      ws as unknown as ServerWebSocket<SessionData>,
      JSON.stringify({ type: "session.new", requestId: "r1" }),
      unusedServices,
    );

    expect(ws.sent).toEqual([
      { type: "sessions.error", requestId: "r1", code: "validation", message: expect.any(String) },
    ]);
  });
});

describe("ws-handlers routing — conversation.activate", () => {
  it("CONTRACT: activating a session the caller's store holds answers session.switched", async () => {
    const services = activateServices();
    const sessionId = seedActivatableSession(services.accessManager, "u_deadbeef");
    const ws = fakeAuthedWs(null);

    await handleWebSocketMessage(
      ws as unknown as ServerWebSocket<SessionData>,
      JSON.stringify({ type: "conversation.activate", sessionId }),
      services,
    );

    expect(ws.sent).toEqual([{ type: "session.switched", sessionId, ts: expect.any(Number) }]);
    expect(ws.data.conversationId).toBe(sessionId);
    // The frame must survive the outbound validator, not merely be constructed.
    expect(gatewayMessageSchema.safeParse(ws.sent[0]).success).toBe(true);
  });

  it("SECURITY: an id absent from the caller's store answers not_found, not session.switched", async () => {
    const services = activateServices();
    const ws = fakeAuthedWs(null);

    await handleWebSocketMessage(
      ws as unknown as ServerWebSocket<SessionData>,
      JSON.stringify({ type: "conversation.activate", sessionId: mintSessionId() }),
      services,
    );

    expect(ws.sent).toEqual([{ type: "sessions.error", code: "not_found", message: expect.any(String) }]);
    expect(ws.data.conversationId).toBeNull();
  });

  it("SECURITY: a draft key is refused rather than treated as a session id", async () => {
    const services = activateServices();
    const ws = fakeAuthedWs(null);

    await handleWebSocketMessage(
      ws as unknown as ServerWebSocket<SessionData>,
      JSON.stringify({ type: "conversation.activate", sessionId: mintDraftKey() }),
      services,
    );

    expect(ws.sent).toEqual([{ type: "sessions.error", code: "not_found", message: expect.any(String) }]);
  });

  it("INVARIANT: a session another live connection is serving is declined, not evicted", async () => {
    const services = activateServices();
    const sessionId = seedActivatableSession(services.accessManager, "u_deadbeef");
    // A rival owner is "live" purely by isAlive() — evict() is never expected
    // to run, so a stray call fails the test loudly rather than passing quietly.
    services.conversationRuntimes.claim(sessionId, "rival-connection", {
      isAlive: () => true,
      evict: () => {
        throw new Error("must not evict a live rival owner");
      },
    });
    const ws = fakeAuthedWs(null);

    await handleWebSocketMessage(
      ws as unknown as ServerWebSocket<SessionData>,
      JSON.stringify({ type: "conversation.activate", sessionId }),
      services,
    );

    expect(ws.sent).toEqual([{ type: "sessions.error", code: "switching", message: expect.any(String) }]);
    expect(ws.data.conversationId).toBeNull();
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
      conversationRuntimes: createConversationRuntimeRegistry(),
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
