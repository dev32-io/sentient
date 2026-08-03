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
import type { SessionPermissionBroker } from "../runtime/session-permission-broker.js";
import type { SessionRuntime } from "../runtime/session-runtime.js";
import type { Stimulus } from "../runtime/stimulus.js";
import { EMPTY_TURN_STATE } from "../runtime/turn-state-snapshot.js";
import { openSessionStore } from "../store/session-store.js";
import { createFanOutTurnEmitter } from "./fan-out-emitter.js";
import { createFrameJournal } from "./frame-journal.js";
import { createReplayRegistry } from "./replay-registry.js";
import { bindSessionRuntime, detachSession } from "./session-binding.js";
import { mintDraftKey, mintSessionId } from "./session-id.js";
import { type SessionHandles, createSessionRegistry } from "./session-registry.js";
import { cleanupSession, handleWebSocketMessage } from "./ws-handlers.js";
import { type SessionData, createEmptySessionData } from "./ws-helpers.js";

interface FakeWs {
  data: SessionData;
  sent: unknown[];
  send: (s: string) => void;
  /** The fan-out skips a window that is not OPEN and reads the backlog after
   *  every write, so a double that omits either is not a socket. */
  readyState: number;
  getBufferedAmount: () => number;
}

/** `ServerWebSocket.readyState` OPEN. */
const WS_OPEN = 1;

function fakeAuthedWs(runtime: SessionRuntime | null): FakeWs {
  const data = createEmptySessionData();
  data.sessionId = "test-session";
  data.authState = "authed";
  data.principal = createUserPrincipal("u_deadbeef", "adult", "home");
  data.runtime = runtime;
  const ws: FakeWs = {
    data,
    sent: [],
    readyState: WS_OPEN,
    getBufferedAmount: () => 0,
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
    turnState: EMPTY_TURN_STATE,
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
 *  bindSessionRuntime succeeds, and a real SessionRegistry so attach/detach is
 *  genuine rather than assumed. */
function activateServices(): GatewayServices {
  activateRunSeq += 1;
  const accessManager = createAccessManager({ userDataRoot: `${ACTIVATE_ROOT}/run-${activateRunSeq}` });
  const runtimeStub = {
    emitConversationSnapshot: () => {},
    dispose: () => {},
    turnState: EMPTY_TURN_STATE,
  } as unknown as SessionRuntime;
  return {
    accessManager,
    sessionRegistry: createSessionRegistry(),
    replayRegistry: createReplayRegistry({ maxBytesPerSession: 65536, retentionMs: 60_000 }),
    session: { max_window_lag_bytes: 1_000_000 },
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
// session.configure has resolved a conversation) sessionRegistry. Real (tiny)
// registries are cheaper and more honest than hand-rolled doubles.
const cleanupServices = {
  sessionManager: { unbindUser: () => {}, removeSession: () => {} },
  replayRegistry: createReplayRegistry({ maxBytesPerSession: 65536, retentionMs: 1000 }),
  sessionRegistry: createSessionRegistry(),
} as unknown as GatewayServices;

interface StubPermissions extends SessionPermissionBroker {
  /** Every answer that reached the SESSION's broker, with the window it came
   *  from — the attribution `permission.response` now has to carry. */
  resolveCalls: Array<{ requestId: string; allow: boolean; attachmentId: string }>;
  denyAllCallCount: () => number;
}

function stubPermissions(matches = true): StubPermissions {
  const resolveCalls: Array<{ requestId: string; allow: boolean; attachmentId: string }> = [];
  let denyAllCalls = 0;
  return {
    resolveCalls,
    denyAllCallCount: () => denyAllCalls,
    request: async () => ({ allow: false }),
    resolve: (requestId, decision, attachmentId) => {
      resolveCalls.push({ requestId, allow: decision.allow, attachmentId });
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
// permission.response (Plan 3 Task 6, spec §7.1; session-model spec §2.4). The
// routing contract being pinned: an answer is settled against the SESSION this
// connection is attached to, naming the window it came from — and a connection
// with no attachment settles nothing, which is what preserves the isolation
// the old per-socket broker gave for free.
// ---------------------------------------------------------------------------

describe("ws-handlers routing — permission.response", () => {
  it("routes the client's decision into the SESSION's broker, naming the answering window", async () => {
    const permissions = stubPermissions();
    const services = attachedCleanupServices(permissions);
    const ws = fakeAuthedWs(null);
    attach(ws, services);

    await handleWebSocketMessage(
      ws as unknown as ServerWebSocket<SessionData>,
      JSON.stringify({ type: "permission.response", requestId: "req-1", approved: true }),
      services,
    );

    expect(permissions.resolveCalls).toEqual([
      { requestId: "req-1", allow: true, attachmentId: ws.data.attachment?.attachmentId ?? "" },
    ]);
    expect(ws.sent).toEqual([]);
  });

  it("does not throw or answer when no prompt is open under that requestId", async () => {
    const permissions = stubPermissions(false);
    const services = attachedCleanupServices(permissions);
    const ws = fakeAuthedWs(null);
    attach(ws, services);

    await expect(
      handleWebSocketMessage(
        ws as unknown as ServerWebSocket<SessionData>,
        JSON.stringify({ type: "permission.response", requestId: "someone-elses-request", approved: true }),
        services,
      ),
    ).resolves.toBeUndefined();

    expect(ws.sent).toEqual([]);
  });

  it("SECURITY: a connection that is not attached to a session settles nothing", async () => {
    // The isolation the per-socket broker used to give structurally: a socket
    // that has left (or never joined) must not be able to answer for a session
    // it is not a window on, even while it still remembers the id.
    const permissions = stubPermissions();
    const services = attachedCleanupServices(permissions);
    const ws = fakeAuthedWs(null);
    attach(ws, services);
    detachSession(ws as unknown as ServerWebSocket<SessionData>, services);

    await expect(
      handleWebSocketMessage(
        ws as unknown as ServerWebSocket<SessionData>,
        JSON.stringify({ type: "permission.response", requestId: "req-1", approved: true }),
        services,
      ),
    ).resolves.toBeUndefined();

    expect(permissions.resolveCalls).toEqual([]);
    expect(ws.sent).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// LANE discipline for the two frames this router emits — a wire-contract
// decision, and since task 6 one that is made per frame TYPE rather than per
// call site (frame-lanes.ts).
//
// Both are CONNECTION lane, and the reasoning inverted for one of them:
//
//   - `pong` always was. A transport-liveness ack carries no payload; a
//     periodic keepalive in the SESSION's shared seq space would burn seq
//     numbers for every window and evict real content from the byte-capped
//     journal.
//   - `error` used to be journaled, on the reasoning that
//     `orchestrator_unavailable` is the only signal a `text.input` went
//     nowhere, so a socket that drops before reading it must replay it. Under
//     one journal per session that reasoning INVERTS: the replay would reach
//     the wrong window, and telling a peer that someone else's request failed
//     is noise it cannot act on.
// ---------------------------------------------------------------------------

describe("ws-handlers outbound frames — lane discipline", () => {
  it("sends an error unstamped and unjournaled, so it reaches only the connection that asked", async () => {
    const ws = fakeAuthedWs(null);
    const journal = createFrameJournal({ sessionId: SESSION_ID, maxBytes: 65536 });
    ws.data.journal = journal;
    ws.data.epoch = 7;

    await handleWebSocketMessage(
      ws as unknown as ServerWebSocket<SessionData>,
      JSON.stringify({ type: "text.input", text: "no runtime yet" }),
      unusedServices,
    );

    expect(ws.sent).toEqual([{ type: "error", code: "orchestrator_unavailable", message: expect.any(String) }]);
    expect(journal.newestSeq).toBe(0);
  });

  it("sends pong unstamped and unjournaled so keepalives never consume the replay window", async () => {
    const ws = fakeAuthedWs(null);
    const journal = createFrameJournal({ sessionId: SESSION_ID, maxBytes: 65536 });
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

  it("answers on the CONNECTION lane, so the anchor never enters the session's seq space", async () => {
    // `session.created` answers the connection that pressed "+". Journaling it
    // would replay one window's anchor into another window's reconnect.
    const ws = fakeAuthedWs(null);
    ws.data.conversationId = "c::u_deadbeef::surface-a";
    ws.data.draftKey = DRAFT_KEY;
    const journal = createFrameJournal({ sessionId: SESSION_ID, maxBytes: 65536 });
    ws.data.journal = journal;
    ws.data.epoch = 4;

    await handleWebSocketMessage(
      ws as unknown as ServerWebSocket<SessionData>,
      JSON.stringify({ type: "session.new", requestId: "r1" }),
      unusedServices,
    );

    expect(ws.sent).toEqual([
      { type: "session.created", sessionId: "c::u_deadbeef::surface-a", ts: expect.any(Number) },
    ]);
    expect(journal.newestSeq).toBe(0);
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

  it("INVARIANT: a session another connection is serving is JOINED, not declined or evicted", async () => {
    // The behaviour change task 5 exists for. This used to answer
    // `sessions.error{code:"switching"}` because binding meant CLAIMING the
    // session from a single-owner registry, and the claim tore the incumbent
    // down. Opening a conversation that is already open elsewhere is the
    // feature now, so the incumbent keeps its runtime AND this connection gets
    // the same one — one ReAct loop over one append-only log, two windows.
    const services = activateServices();
    const sessionId = seedActivatableSession(services.accessManager, "u_deadbeef");
    const incumbentRuntime = {
      emitConversationSnapshot: () => {},
      turnState: EMPTY_TURN_STATE,
    } as unknown as SessionRuntime;
    const incumbentWs = fakeAuthedWs(incumbentRuntime);
    const journal = createFrameJournal({ sessionId, maxBytes: 65536 });
    const incumbent = services.sessionRegistry.attach(
      sessionId,
      "rival-connection",
      incumbentWs as unknown as ServerWebSocket<SessionData>,
      () =>
        ({
          runtime: incumbentRuntime,
          permissions: { denyAll: () => {} },
          voicePrefs: null,
          fanOut: createFanOutTurnEmitter({
            registry: services.sessionRegistry,
            sessionId,
            journal,
            epoch: 1,
            maxLagBytes: 1_000_000,
          }),
          journal,
          epoch: 1,
          replayLease: { sessionId, id: 1 },
          // A stray call fails the test loudly rather than passing quietly.
          dispose: () => {
            throw new Error("must not dispose a live incumbent");
          },
        }) as unknown as SessionHandles,
    );
    const ws = fakeAuthedWs(null);

    await handleWebSocketMessage(
      ws as unknown as ServerWebSocket<SessionData>,
      JSON.stringify({ type: "conversation.activate", sessionId }),
      services,
    );

    expect(ws.sent).toEqual([{ type: "session.switched", sessionId, ts: expect.any(Number) }]);
    expect(ws.data.conversationId).toBe(sessionId);
    // The INCUMBENT's runtime, not a second one built for this connection.
    expect(ws.data.runtime).toBe(incumbentRuntime);
    // The incumbent is still attached — nothing was evicted to make room.
    expect(services.sessionRegistry.subscribers(sessionId).map((a) => a.attachmentId)).toContain(
      incumbent.attachmentId,
    );
  });
});

/** A durable session id in `session-id.ts`'s minted shape. */
const SESSION_ID = `s_${"0".repeat(31)}1`;

/** `cleanupServices` plus a real `SessionRegistry` and a runtime factory that
 *  hands back [permissions], so a connection can attach for real and its
 *  cleanup genuinely detaches. */
function attachedCleanupServices(permissions: SessionPermissionBroker): GatewayServices {
  const runtimeStub = {
    dispose: () => {},
    emitConversationSnapshot: () => {},
    turnState: EMPTY_TURN_STATE,
  } as unknown as SessionRuntime;
  return {
    sessionManager: { unbindUser: () => {}, removeSession: () => {} },
    replayRegistry: createReplayRegistry({ maxBytesPerSession: 65536, retentionMs: 1000 }),
    sessionRegistry: createSessionRegistry(),
    session: { max_window_lag_bytes: 1_000_000 },
    profileStore: { get: async () => ({ ok: false, error: "no profile in this test" }) },
    createSynthesizerFor: () => null,
    stt: null,
    createSessionRuntime: () => ({ runtime: runtimeStub, permissions }),
  } as unknown as GatewayServices;
}

/** Attach [ws] to SESSION_ID through the real bind path. */
function attach(ws: FakeWs, services: GatewayServices): void {
  ws.data.conversationId = SESSION_ID;
  bindSessionRuntime(ws as unknown as ServerWebSocket<SessionData>, services, SESSION_ID);
}

describe("ws-handlers cleanup — outstanding permission prompts", () => {
  it("denies every open prompt when the LAST window on the session leaves", () => {
    // Each open prompt is a promise the ReAct loop is awaiting inside
    // `broker.dispatch`; an unsettled one parks that turn for the full
    // permission timeout after the socket is already gone. Since task 5 the
    // broker belongs to the SESSION, so the denial runs from the handles'
    // dispose — i.e. only when nothing is attached any more.
    const permissions = stubPermissions();
    const services = attachedCleanupServices(permissions);
    const ws = fakeAuthedWs(null);
    attach(ws, services);

    cleanupSession(ws as unknown as ServerWebSocket<SessionData>, services);

    expect(permissions.denyAllCallCount()).toBe(1);
    expect(ws.data.attachment).toBeNull();
  });

  it("INVARIANT: a closing window does not deny prompts another window can still answer", () => {
    // The eviction this task deleted, in its permission form: one socket's
    // close used to call `denyAll()` on the broker directly, which under N
    // windows would auto-deny a prompt a second window is looking at.
    const permissions = stubPermissions();
    const services = attachedCleanupServices(permissions);
    const survivor = fakeAuthedWs(null);
    attach(survivor, services);
    const leaving = fakeAuthedWs(null);
    attach(leaving, services);

    cleanupSession(leaving as unknown as ServerWebSocket<SessionData>, services);

    expect(permissions.denyAllCallCount()).toBe(0);
    // The survivor's window is still in the session, so the session's prompts
    // are still reachable — and reachable from IT, which is the whole point.
    expect(services.sessionRegistry.handlesFor(SESSION_ID)?.permissions).toBe(permissions);
    expect(survivor.data.attachment).not.toBeNull();
  });
});

describe("ws-handlers cleanup — the session journal", () => {
  it("drops this connection's HANDLE on the journal without destroying the journal", () => {
    // The journal is the SESSION's since task 6, so a closing window clears its
    // own reference and nothing more; releasing it is the session handles'
    // dispose, and the registry keeps it for the retention window after that.
    const registry = createReplayRegistry({ maxBytesPerSession: 65536, retentionMs: 60_000 });
    const services = {
      sessionManager: { unbindUser: () => {}, removeSession: () => {} },
      replayRegistry: registry,
      sessionRegistry: createSessionRegistry(),
    } as unknown as GatewayServices;

    const ws = fakeAuthedWs(null);
    const acquired = registry.acquire(SESSION_ID);
    acquired.journal.allocateText("turn.completed", (seq) => JSON.stringify({ seq }));
    ws.data.journal = acquired.journal;
    ws.data.epoch = acquired.epoch;

    cleanupSession(ws as unknown as ServerWebSocket<SessionData>, services);

    expect(ws.data.journal).toBeNull();
    expect(ws.data.epoch).toBe(0);
    // Still there, still at the same epoch — a reconnect resumes from it.
    const reconnect = registry.acquire(SESSION_ID);
    expect(reconnect.epoch).toBe(acquired.epoch);
    expect(reconnect.journal.newestSeq).toBe(1);
  });
});
