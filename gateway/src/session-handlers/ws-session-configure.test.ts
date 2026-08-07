// Journal lifecycle across a RE-`session.configure` (Plan 3 Task 10 residual).
//
// One invariant is pinned here: a second `session.configure` on a connection
// that is STILL OPEN and names the SAME surface must KEEP that connection's
// frame journal and epoch. Nothing was lost — the socket never closed — so
// minting a fresh journal would discard a live replay window and jump the
// client's epoch for no reason, which reads on the wire as a stream restart
// (`stream.resumed{recovered:false}` on the next reconnect, a full REST
// refetch, and every frame still in the old journal unreachable).
//
// The mirror case is pinned too: re-configuring onto a DIFFERENT surface is a
// genuine handover, so the old journal is parked and a fresh one is minted.
//
// The committed-feed handshake is pinned here too: every NON-recovered
// configure must end with a `conversation.snapshot`, and a recovered one must
// NOT send one (its verbatim replay already restores the client's mirror).
// Without the first half, every reload and every `recovered:false` reconnect
// renders an empty chat.
//
// Zero cost: a FakeWs double (mirrors ws-resume.test.ts) plus a real, tiny
// ReplayRegistry. No provider/network I/O; `createSessionRuntime: null` keeps
// the orchestrator branch out of the picture for the journal cases.

import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import type { OrchestratorConfig } from "@sentient/config";
import type { ServerWebSocket } from "bun";
import { type AccessManager, createAccessManager } from "../access/access-manager.js";
import type { GatewayServices } from "../bootstrap/create-gateway-services.js";
import { createUserPrincipal } from "../identity/user-principal.js";
import type { ProviderClient, ProviderRequest, ProviderStreamChunk } from "../provider/provider-client.js";
import type { SessionWorkSignals } from "../runtime/session-retention.js";
import { createSessionRuntime } from "../runtime/session-runtime.js";
import type { SessionRuntime } from "../runtime/session-runtime.js";
import { EMPTY_TURN_STATE } from "../runtime/turn-state-snapshot.js";
import { openSessionStore } from "../store/session-store.js";
import type { BackgroundRegistry } from "../tools/background-registry.js";
import type { ToolBroker } from "../tools/tool-broker.js";
import { type ReplayRegistry, createReplayRegistry } from "./replay-registry.js";
import { mintSessionId } from "./session-id.js";
import { createSessionRegistry } from "./session-registry.js";
import { cleanupSession, handleWebSocketMessage } from "./ws-handlers.js";
import { type SessionData, createEmptySessionData } from "./ws-helpers.js";
import { sendConnectionFrame } from "./ws-send.js";
import { handleSessionConfigure } from "./ws-session-configure.js";

/** A session that is doing nothing — every retention term false. These cases
 *  are about routing and residency counting, not about work; the derived
 *  retention predicate is pinned in runtime/session-retention.test.ts. */
const IDLE_WORK: SessionWorkSignals = {
  isTurnInFlight: false,
  hasPendingForegroundTool: false,
  hasOutstandingPrompt: false,
  hasAuxiliaryTaskInFlight: false,
  newestBackgroundTaskStartedAtMs: null,
};

const USER_ID: `u_${string}` = "u_deadbeef";
const OTHER_USER_ID: `u_${string}` = "u_aaaaaaaa";
const DEVICE_ID = "device-1";
const SURFACE_A = "surface-a";
const SURFACE_B = "surface-b";

const STORE_ROOT = "/tmp/sentient-ws-conversation-identity-test";
mkdirSync(STORE_ROOT, { recursive: true });
afterAll(() => rmSync(STORE_ROOT, { recursive: true, force: true }));

let storeSeq = 0;

/** A real AccessManager over a per-test data root, so no test can see the
 *  sessions another one seeded. */
function freshAccessManager(): AccessManager {
  storeSeq += 1;
  return createAccessManager({ userDataRoot: `${STORE_ROOT}/run-${storeSeq}` });
}

/** `ServerWebSocket.readyState`. The ownership guards in ws-handlers.ts read it
 *  to tell a LIVE rival connection from a dying one that simply has not had its
 *  close event processed yet, so the double has to carry it. */
const WS_OPEN = 1;
const WS_CLOSING = 2;
const WS_CLOSED = 3;

interface FakeWs {
  data: SessionData;
  sent: Record<string, unknown>[];
  send: (payload: string) => void;
  readyState: number;
  /** Bun's transport backlog. The fan-out reads it after every write to
   *  enforce `session.max_window_lag_bytes`, so a double that omits it is not
   *  a socket. */
  getBufferedAmount: () => number;
}

function fakeAuthedWs(connectionSessionId = "test-session"): FakeWs {
  const data = createEmptySessionData();
  data.sessionId = connectionSessionId;
  data.authState = "authed";
  data.principal = createUserPrincipal(USER_ID, "adult", "home");
  const ws: FakeWs = {
    data,
    sent: [],
    readyState: WS_OPEN,
    /** Bun's transport backlog. 0 — these doubles never apply backpressure. */
    getBufferedAmount: () => 0,
    send(payload) {
      ws.sent.push(JSON.parse(payload) as Record<string, unknown>);
    },
  };
  return ws;
}

/**
 * The socket dropped, and its close event has NOT been processed — so
 * `cleanupSession` has not run and this connection's runtime claim is still in
 * the registry. This is the state a client is retrying against, and the reason
 * the ownership guards key on liveness rather than on "is it claimed".
 */
function dropSocket(ws: FakeWs, readyState: number = WS_CLOSED): void {
  ws.readyState = readyState;
}

function asWs(ws: FakeWs): ServerWebSocket<SessionData> {
  return ws as unknown as ServerWebSocket<SessionData>;
}

function configure(ws: FakeWs, services: GatewayServices, surfaceId: string, conversationId?: string): void {
  handleSessionConfigure(asWs(ws), [], "en", services, "webui", DEVICE_ID, surfaceId, undefined, conversationId);
}

/**
 * Put a real session in [userId]'s own store and return its id — the state a
 * client is in when it presents an id that the membership lookup must ACCEPT.
 * Writes an entry too, so the reopened session has a feed to project.
 */
function seedSession(accessManager: AccessManager, userId: `u_${string}`, text: string): string {
  const store = openSessionStore(accessManager.grant(createUserPrincipal(userId, "adult", "home"), "session-store"));
  const sessionId = mintSessionId();
  store.createSession(sessionId, `mint-${sessionId}`);
  store.append({
    sessionId,
    turnId: "seed-turn",
    replyId: null,
    kind: "user",
    createdAt: Date.now(),
    text,
    toolCallId: null,
    toolName: null,
    toolArgs: null,
    cutoff: null,
    compactedThroughSeq: null,
    pendingId: null,
  });
  store.close();
  return sessionId;
}

function frameTypes(ws: FakeWs): string[] {
  return ws.sent.map((f) => f.type as string);
}

interface SnapshotSpy {
  services: GatewayServices;
  snapshotCalls: number;
}

/** Services whose runtime factory hands back a stub whose
 *  `emitConversationSnapshot` writes a real (empty) snapshot frame down the
 *  same validated send path the production feed uses — so the ORDER relative
 *  to session.ready is observable, not just the call count. Voice composition
 *  is short-circuited by `createSynthesizerFor: () => null`. */
function servicesWithRuntime(replayRegistry: ReplayRegistry, ws: FakeWs, accessManager: AccessManager): SnapshotSpy {
  const spy: SnapshotSpy = { snapshotCalls: 0, services: {} as GatewayServices };
  const runtime = {
    emitConversationSnapshot: () => {
      spy.snapshotCalls += 1;
      sendConnectionFrame(asWs(ws), { type: "conversation.snapshot", items: [] });
    },
    dispose: () => {},
    turnState: EMPTY_TURN_STATE,
  } as unknown as SessionRuntime;
  spy.services = {
    replayRegistry,
    sessionRegistry: createSessionRegistry(),
    webui: { playback: { min_eager_end_ms: 0, preempt_fadeout_ms: 0 } },
    session: { max_window_lag_bytes: 1_000_000 },
    profileStore: { get: async () => ({ ok: false, error: "no profile in this test" }) },
    createSynthesizerFor: () => null,
    stt: null,
    accessManager,
    createSessionRuntime: () => ({ runtime, permissions: { denyAll: () => {} }, work: IDLE_WORK }),
    // No policy passed, so the registry's default applies: dispose as soon as
    // nothing observable holds the session. These cases never give it work, so
    // it behaves as the old "last one out" did — which is what they were
    // written against.
  } as unknown as GatewayServices;
  return spy;
}

describe("handleSessionConfigure — the SESSION's journal across a re-configure", () => {
  it("keeps the same journal and epoch when a connection re-configures the same session", () => {
    // The journal follows the SESSION now, not the surface. A reload landing
    // back on the same conversation must continue its seq space, or the client
    // reads the epoch jump as a stream restart and refetches everything.
    const registry = createReplayRegistry({ maxBytesPerSession: 1_000_000, retentionMs: 60_000 });
    const ws = fakeAuthedWs();
    const accessManager = freshAccessManager();
    const spy = servicesWithRuntime(registry, ws, accessManager);
    const sessionId = seedSession(accessManager, USER_ID, "earlier turn");

    configure(ws, spy.services, SURFACE_A, sessionId);
    const firstJournal = ws.data.journal;
    const firstEpoch = ws.data.epoch;

    configure(ws, spy.services, SURFACE_A, sessionId);

    expect(firstJournal).not.toBeNull();
    expect(ws.data.journal).toBe(firstJournal);
    expect(ws.data.epoch).toBe(firstEpoch);
  });

  it("gives two SURFACES of one user on one session the SAME journal", () => {
    // The inversion this task made: `surfaceId` used to partition the journal,
    // which meant two windows on one conversation held two seq spaces over the
    // same frames.
    const registry = createReplayRegistry({ maxBytesPerSession: 1_000_000, retentionMs: 60_000 });
    const accessManager = freshAccessManager();
    const wsA = fakeAuthedWs("conn-a");
    const wsB = fakeAuthedWs("conn-b");
    const spy = servicesWithRuntime(registry, wsA, accessManager);
    const sessionId = seedSession(accessManager, USER_ID, "earlier turn");

    configure(wsA, spy.services, SURFACE_A, sessionId);
    configure(wsB, spy.services, SURFACE_B, sessionId);

    expect(wsB.data.journal).toBe(wsA.data.journal);
    expect(wsB.data.epoch).toBe(wsA.data.epoch);
  });

  it("hands a DIFFERENT session a different journal and epoch", () => {
    const registry = createReplayRegistry({ maxBytesPerSession: 1_000_000, retentionMs: 60_000 });
    const ws = fakeAuthedWs();
    const accessManager = freshAccessManager();
    const spy = servicesWithRuntime(registry, ws, accessManager);
    const first = seedSession(accessManager, USER_ID, "first");
    const second = seedSession(accessManager, USER_ID, "second");

    configure(ws, spy.services, SURFACE_A, first);
    const firstJournal = ws.data.journal;
    const firstEpoch = ws.data.epoch;

    configure(ws, spy.services, SURFACE_A, second);

    expect(ws.data.journal).not.toBe(firstJournal);
    expect(ws.data.epoch).not.toBe(firstEpoch);
  });

  it("leaves a DRAFT connection with no journal at all", () => {
    // A draft has no session, so there is no conversation to replay. The client
    // has no cursor at that point either, which is why an unsequenced draft
    // handshake is correct rather than a gap.
    const registry = createReplayRegistry({ maxBytesPerSession: 1_000_000, retentionMs: 60_000 });
    const ws = fakeAuthedWs();
    const spy = servicesWithRuntime(registry, ws, freshAccessManager());

    configure(ws, spy.services, SURFACE_A);

    expect(ws.data.journal).toBeNull();
    expect(ws.data.epoch).toBe(0);
    expect(registry.size).toBe(0);
  });
});

describe("handleSessionConfigure — committed-feed handshake", () => {
  it("CONTRACT: re-opening a session sends conversation.snapshot right after session.ready", () => {
    // Nothing else on the wire carries committed history: `turn.*` is a live
    // stream the client drops on turn.completed. Without this frame the chat
    // is empty on every reload.
    const registry = createReplayRegistry({ maxBytesPerSession: 1_000_000, retentionMs: 60_000 });
    const ws = fakeAuthedWs();
    const accessManager = freshAccessManager();
    const spy = servicesWithRuntime(registry, ws, accessManager);
    const sessionId = seedSession(accessManager, USER_ID, "earlier turn");

    configure(ws, spy.services, SURFACE_A, sessionId);

    expect(frameTypes(ws)).toEqual(["session.attached", "session.ready", "conversation.snapshot"]);
    expect(spy.snapshotCalls).toBe(1);
  });

  it("CONTRACT: a draft connection is told it is a draft — empty snapshot, then the key it will mint under", () => {
    // A draft has no row and no id, so there is no feed to project. The empty
    // snapshot is still mandatory: without it a reload right after "+" leaves
    // the previous session's bubbles on screen with nothing to clear them.
    // The `session.draft` key is what a client whose outbound queue gates on
    // "a conversation is attached" (mobile) holds so the queue can drain.
    const registry = createReplayRegistry({ maxBytesPerSession: 1_000_000, retentionMs: 60_000 });
    const ws = fakeAuthedWs();
    const spy = servicesWithRuntime(registry, ws, freshAccessManager());

    configure(ws, spy.services, SURFACE_A);

    expect(frameTypes(ws)).toEqual(["session.ready", "conversation.snapshot", "session.draft"]);
    expect(spy.snapshotCalls).toBe(0); // no runtime was built — there is no session
    expect(ws.data.conversationId).toBeNull();
    expect(ws.data.draftKey).toBe(ws.sent[2]?.draftKey as string);
  });

  it("CONTRACT: a RECOVERED resume sends no snapshot — the verbatim replay already restored the mirror", () => {
    const registry = createReplayRegistry({ maxBytesPerSession: 1_000_000, retentionMs: 60_000 });
    const ws = fakeAuthedWs();
    const accessManager = freshAccessManager();
    const spy = servicesWithRuntime(registry, ws, accessManager);
    const sessionId = seedSession(accessManager, USER_ID, "earlier turn");

    configure(ws, spy.services, SURFACE_A, sessionId);
    expect(spy.snapshotCalls).toBe(1);

    handleSessionConfigure(
      asWs(ws),
      [],
      "en",
      spy.services,
      "webui",
      DEVICE_ID,
      SURFACE_A,
      { epoch: ws.data.epoch, lastSeq: 0 },
      sessionId,
    );

    expect(ws.sent.some((f) => f.type === "stream.resumed" && f.recovered === true)).toBe(true);
    expect(spy.snapshotCalls).toBe(1); // unchanged
  });

  it("CONTRACT: a non-recovered resume sends stream.resumed, then session.ready, then the snapshot", () => {
    // recovered:false means the client resets its cursor and has no history —
    // the one reconnect path where the snapshot is the only way back.
    //
    // The ORDER is load-bearing, and for a reason no gateway file states on its
    // own: web-sdk attaches its ConversationHistoryConnector only when
    // `session.ready` lands (sdk-message-router.ts's `handleReady` →
    // `attachAll`), and `stream.resumed{recovered:false}` makes it synthesise a
    // `session.switched` that REST-refetches history and, on failure, replaces
    // the mirror with an EMPTY list. `GET /sessions/:id/messages` does not
    // exist in this gateway (sessions CRUD is later scope), so that refetch
    // would 404 and wipe the chat moments after the snapshot filled it. It does
    // not fire today only because the ack arrives BEFORE ready, while the
    // connector is still detached. Flip these two and the "reconnect yields an
    // empty chat" bug this handshake exists to close comes straight back.
    const registry = createReplayRegistry({ maxBytesPerSession: 1_000_000, retentionMs: 60_000 });
    const ws = fakeAuthedWs();
    const accessManager = freshAccessManager();
    const spy = servicesWithRuntime(registry, ws, accessManager);
    const sessionId = seedSession(accessManager, USER_ID, "earlier turn");

    handleSessionConfigure(
      asWs(ws),
      [],
      "en",
      spy.services,
      "webui",
      DEVICE_ID,
      SURFACE_A,
      { epoch: 999, lastSeq: 42 },
      sessionId,
    );

    expect(frameTypes(ws)).toEqual(["session.attached", "stream.resumed", "session.ready", "conversation.snapshot"]);
    expect(ws.sent[1]?.recovered).toBe(false);
    expect(spy.snapshotCalls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Session addressing (spec §3.5) — MEMBERSHIP, not derivation, not a prefix.
//
// The store partitions on the id this handler resolves, NOT on
// `ws.data.sessionId` — that one is minted per WEBSOCKET CONNECTION and dies
// with it, so keying the store on it opened a brand-new empty partition on
// every reload, reconnect and gateway restart: `conversation.snapshot` came
// back empty AND the model projection handed the LLM no history at all.
//
// What the redesign changes: the id is no longer DERIVED from the principal
// and the surface, and a presented id is no longer trusted for its SHAPE. It
// is looked up in the store the caller's own capability opens. An id that is
// not there is refused — the previous behaviour created an empty partition for
// any well-formed string, which is the junk-partition vector.
// ---------------------------------------------------------------------------

/** Records the partition id `handleSessionConfigure` hands the runtime factory. */
interface PartitionSpy {
  services: GatewayServices;
  partitionIds: string[];
}

function servicesRecordingPartition(
  replayRegistry: ReplayRegistry,
  ws: FakeWs,
  accessManager: AccessManager,
): PartitionSpy {
  const spy: PartitionSpy = { partitionIds: [], services: {} as GatewayServices };
  const runtime = {
    emitConversationSnapshot: () => sendConnectionFrame(asWs(ws), { type: "conversation.snapshot", items: [] }),
    dispose: () => {},
    turnState: EMPTY_TURN_STATE,
  } as unknown as SessionRuntime;
  spy.services = {
    replayRegistry,
    sessionRegistry: createSessionRegistry(),
    webui: { playback: { min_eager_end_ms: 0, preempt_fadeout_ms: 0 } },
    session: { max_window_lag_bytes: 1_000_000 },
    profileStore: { get: async () => ({ ok: false, error: "no profile in this test" }) },
    createSynthesizerFor: () => null,
    stt: null,
    accessManager,
    createSessionRuntime: ({ conversationId }: { conversationId: string }) => {
      spy.partitionIds.push(conversationId);
      return { runtime, permissions: { denyAll: () => {} }, work: IDLE_WORK };
    },
  } as unknown as GatewayServices;
  return spy;
}

describe("handleSessionConfigure — session addressing", () => {
  it("SECURITY: an id this user's store does not hold is refused, not created", () => {
    // The junk-partition vector: the previous handler honoured any
    // well-prefixed string and opened an empty partition for it, so a client
    // could fill a user's database with rows nothing can list, open or delete.
    const registry = createReplayRegistry({ maxBytesPerSession: 1_000_000, retentionMs: 60_000 });
    const ws = fakeAuthedWs();
    const accessManager = freshAccessManager();
    const spy = servicesRecordingPartition(registry, ws, accessManager);

    configure(ws, spy.services, SURFACE_A, mintSessionId());

    expect(spy.partitionIds).toEqual([]);
    expect(ws.data.conversationId).toBeNull();
    expect(frameTypes(ws)).toContain("session.draft");
    const store = openSessionStore(accessManager.grant(createUserPrincipal(USER_ID, "adult", "home"), "session-store"));
    expect(store.listSessionsWithMetadata()).toHaveLength(0);
    expect(store.listSessions()).toHaveLength(0);
    store.close();
  });

  it("SECURITY: another principal's session id is refused like any unknown id", () => {
    // The store is one DB per user opened through a Capability, so the id
    // simply is not there — which is exactly why membership is a stronger
    // check than the prefix parse it replaces, and why no code path needs to
    // read an owner out of an id's shape.
    const registry = createReplayRegistry({ maxBytesPerSession: 1_000_000, retentionMs: 60_000 });
    const accessManager = freshAccessManager();
    const foreignId = seedSession(accessManager, OTHER_USER_ID, "not yours");

    const ws = fakeAuthedWs();
    const spy = servicesRecordingPartition(registry, ws, accessManager);
    configure(ws, spy.services, SURFACE_A, foreignId);

    expect(spy.partitionIds).toEqual([]);
    expect(ws.data.conversationId).toBeNull();
  });

  it("INVARIANT: a connection that presents nothing leaves no row behind", () => {
    // "Ten opened tabs leave the session list unchanged" (spec §4.2). A draft
    // is not a session: no row, no id, nothing to list.
    const registry = createReplayRegistry({ maxBytesPerSession: 1_000_000, retentionMs: 60_000 });
    const accessManager = freshAccessManager();
    const spy = servicesRecordingPartition(registry, fakeAuthedWs(), accessManager);

    for (let i = 0; i < 10; i += 1) configure(fakeAuthedWs(`connection-${i}`), spy.services, `surface-${i}`);

    const store = openSessionStore(accessManager.grant(createUserPrincipal(USER_ID, "adult", "home"), "session-store"));
    expect(store.listSessionsWithMetadata()).toEqual([]);
    store.close();
    expect(spy.partitionIds).toEqual([]);
  });

  it("CONTRACT: an id this user's store holds is opened, and it is not the connection id", () => {
    const registry = createReplayRegistry({ maxBytesPerSession: 1_000_000, retentionMs: 60_000 });
    const ws = fakeAuthedWs("connection-1");
    const accessManager = freshAccessManager();
    const spy = servicesRecordingPartition(registry, ws, accessManager);
    const sessionId = seedSession(accessManager, USER_ID, "earlier turn");

    configure(ws, spy.services, SURFACE_A, sessionId);

    expect(spy.partitionIds).toEqual([sessionId]);
    expect(ws.data.conversationId).toBe(sessionId);
    expect(ws.data.sessionId).toBe("connection-1");
  });

  it("CONTRACT: two connections presenting one id open the SAME session, whatever their surfaces", () => {
    // Surfaces no longer partition anything (§3.4: surfaceId gates nothing).
    // ONE partition is opened, not two: the second connection attaches to the
    // session the first made resident rather than constructing a second
    // runtime over the same append-only log.
    const registry = createReplayRegistry({ maxBytesPerSession: 1_000_000, retentionMs: 60_000 });
    const first = fakeAuthedWs("connection-1");
    const accessManager = freshAccessManager();
    const spy = servicesRecordingPartition(registry, first, accessManager);
    const sessionId = seedSession(accessManager, USER_ID, "earlier turn");
    const second = fakeAuthedWs("connection-2");

    configure(first, spy.services, SURFACE_A, sessionId);
    configure(second, spy.services, SURFACE_B, sessionId);

    expect(spy.partitionIds).toEqual([sessionId]);
    expect(first.data.conversationId).toBe(sessionId);
    expect(second.data.conversationId).toBe(sessionId);
  });

  it("INVARIANT: a legacy c:: partition that holds entries is still addressable", () => {
    // Existing users' conversations are rows in their own store, reached
    // through the same membership lookup. Both shapes are handled identically
    // and the surfaceId inside a legacy id carries no authority.
    const registry = createReplayRegistry({ maxBytesPerSession: 1_000_000, retentionMs: 60_000 });
    const ws = fakeAuthedWs();
    const accessManager = freshAccessManager();
    const spy = servicesRecordingPartition(registry, ws, accessManager);
    const legacyId = `c::${USER_ID}::${SURFACE_A}`;
    const store = openSessionStore(accessManager.grant(createUserPrincipal(USER_ID, "adult", "home"), "session-store"));
    store.append({
      sessionId: legacyId,
      turnId: "legacy-turn",
      replyId: null,
      kind: "user",
      createdAt: Date.now(),
      text: "from before the redesign",
      toolCallId: null,
      toolName: null,
      toolArgs: null,
      cutoff: null,
      compactedThroughSeq: null,
      pendingId: null,
    });
    store.close();

    configure(ws, spy.services, SURFACE_B, legacyId);

    expect(spy.partitionIds).toEqual([legacyId]);
  });

  it("INVARIANT: a reconnect mid-draft stays on the same draft key", () => {
    // The draft key is the mint key. A reconnect that re-minted it would give
    // the retry of a first message a different key, and the lost-ack retry
    // would fork a second session — the exact failure §4.2 names.
    const registry = createReplayRegistry({ maxBytesPerSession: 1_000_000, retentionMs: 60_000 });
    const first = fakeAuthedWs("connection-1");
    const spy = servicesRecordingPartition(registry, first, freshAccessManager());

    configure(first, spy.services, SURFACE_A);
    const draftKey = first.data.draftKey as string;

    const second = fakeAuthedWs("connection-2");
    configure(second, spy.services, SURFACE_A, draftKey);

    expect(second.data.draftKey).toBe(draftKey);
    expect(second.data.conversationId).toBeNull();
    expect(spy.partitionIds).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// One live runtime per session, N connections attached to it.
//
// Making the conversation durable made it SHARED: two sockets can now name the
// same store partition. replay-registry.ts already documents the window that
// makes this routine rather than hypothetical — "a same-tab reload whose new
// session.configure lands before the old socket's close event, or a TCP/NAT
// drop Bun's idle timeout has not noticed yet" — and mints a fresh journal so
// the two never share a seq counter. The runtime needs coordination for a
// stronger reason: two live `SessionRuntime`s on one partition are two ReAct
// loops appending to one append-only log with different views of the prior
// context, plus two `bun:sqlite` handles on one WAL file.
//
// The REMEDY is what task 5 changed. The second connection used to WIN and the
// first was torn down; it now JOINS, and the runtime is released only when the
// last attachment leaves. These cases pin that at the handler level — the
// registry's own contract is session-registry.test.ts.
// ---------------------------------------------------------------------------

interface MintedRuntime {
  conversationId: string;
  connectionId: string;
  disposeCount: number;
}

interface LifecycleSpy {
  services: GatewayServices;
  /** One entry per mint, in call order. */
  minted: MintedRuntime[];
}

/** Services whose runtime factory hands back a fresh disposal-counting stub
 *  per call, so eviction is observable without a store or a provider. */
function servicesTrackingRuntimes(replayRegistry: ReplayRegistry, accessManager: AccessManager): LifecycleSpy {
  const spy: LifecycleSpy = { minted: [], services: {} as GatewayServices };
  spy.services = {
    replayRegistry,
    sessionRegistry: createSessionRegistry(),
    webui: { playback: { min_eager_end_ms: 0, preempt_fadeout_ms: 0 } },
    session: { max_window_lag_bytes: 1_000_000 },
    profileStore: { get: async () => ({ ok: false, error: "no profile in this test" }) },
    createSynthesizerFor: () => null,
    stt: null,
    accessManager,
    sessionManager: { unbindUser: () => {}, removeSession: () => {} },
    createSessionRuntime: ({ conversationId, connectionId }: { conversationId: string; connectionId: string }) => {
      const record: MintedRuntime = { conversationId, connectionId, disposeCount: 0 };
      spy.minted.push(record);
      const runtime = {
        emitConversationSnapshot: () => {},
        dispose: () => {
          record.disposeCount += 1;
        },
        turnState: EMPTY_TURN_STATE,
      } as unknown as SessionRuntime;
      return { runtime, permissions: { denyAll: () => {} }, work: IDLE_WORK };
    },
  } as unknown as GatewayServices;
  return spy;
}

describe("handleSessionConfigure — one live runtime per session", () => {
  it("INVARIANT: a second connection on a live session shares the runtime instead of evicting it", () => {
    const registry = createReplayRegistry({ maxBytesPerSession: 1_000_000, retentionMs: 60_000 });
    const accessManager = freshAccessManager();
    const spy = servicesTrackingRuntimes(registry, accessManager);
    const sessionId = seedSession(accessManager, USER_ID, "earlier turn");

    const first = fakeAuthedWs("connection-1");
    configure(first, spy.services, SURFACE_A, sessionId);
    const second = fakeAuthedWs("connection-2");
    configure(second, spy.services, SURFACE_A, sessionId);

    // ONE construction, shared: not one per connection, and not a teardown of
    // the window that got there first.
    expect(spy.minted).toHaveLength(1);
    expect(spy.minted[0]?.disposeCount).toBe(0);
    expect(second.data.runtime).toBe(first.data.runtime);
    // The prompts are the SESSION's, held once on its handles — no socket
    // carries a broker of its own any more (task 7).
    expect(spy.services.sessionRegistry.handlesFor(sessionId)?.permissions).toBeDefined();
    expect(spy.services.sessionRegistry.subscribers(sessionId)).toHaveLength(2);
  });

  it("keeps the runtime a re-configure on the SAME connection just minted", () => {
    const registry = createReplayRegistry({ maxBytesPerSession: 1_000_000, retentionMs: 60_000 });
    const accessManager = freshAccessManager();
    const spy = servicesTrackingRuntimes(registry, accessManager);
    const sessionId = seedSession(accessManager, USER_ID, "earlier turn");

    const ws = fakeAuthedWs("connection-1");
    configure(ws, spy.services, SURFACE_A, sessionId);
    configure(ws, spy.services, SURFACE_A, sessionId);

    // The handler disposes the prior runtime itself; the newly minted one must
    // not then be evicted by the claim it just made.
    expect(spy.minted[0]?.disposeCount).toBe(1);
    expect(spy.minted[1]?.disposeCount).toBe(0);
    expect(ws.data.runtime).not.toBeNull();
  });

  it("INVARIANT: a superseded connection's teardown cannot detach the live one", () => {
    // Mirrors replay-registry's stale-lease guard: the close event of the
    // socket a reload replaced lands AFTER the new socket configured. Detach
    // is keyed on the ATTACHMENT id, minted per attach, so the late close can
    // only ever remove its own membership.
    const registry = createReplayRegistry({ maxBytesPerSession: 1_000_000, retentionMs: 60_000 });
    const accessManager = freshAccessManager();
    const spy = servicesTrackingRuntimes(registry, accessManager);
    const sessionId = seedSession(accessManager, USER_ID, "earlier turn");

    const stale = fakeAuthedWs("connection-1");
    configure(stale, spy.services, SURFACE_A, sessionId);
    const live = fakeAuthedWs("connection-2");
    configure(live, spy.services, SURFACE_A, sessionId);
    const liveRuntime = live.data.runtime;

    cleanupSession(asWs(stale), spy.services);

    expect(spy.minted[0]?.disposeCount).toBe(0);
    expect(live.data.runtime).toBe(liveRuntime);
    expect(spy.services.sessionRegistry.subscribers(sessionId)).toHaveLength(1);
  });

  it("INVARIANT: the runtime is disposed when the LAST window leaves, not the first", () => {
    const registry = createReplayRegistry({ maxBytesPerSession: 1_000_000, retentionMs: 60_000 });
    const accessManager = freshAccessManager();
    const spy = servicesTrackingRuntimes(registry, accessManager);
    const sessionId = seedSession(accessManager, USER_ID, "earlier turn");

    const first = fakeAuthedWs("connection-1");
    configure(first, spy.services, SURFACE_A, sessionId);
    const second = fakeAuthedWs("connection-2");
    configure(second, spy.services, SURFACE_A, sessionId);

    cleanupSession(asWs(first), spy.services);
    expect(spy.minted[0]?.disposeCount).toBe(0);

    cleanupSession(asWs(second), spy.services);
    expect(spy.minted[0]?.disposeCount).toBe(1);
    expect(spy.services.sessionRegistry.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// End-to-end reload durability, over a REAL on-disk store and a real
// SessionRuntime (fake provider only — no network). This is spec §10
// acceptance #9: a reconnect rebuilds the full feed from the store AND the
// model projection carries the prior turn.
// ---------------------------------------------------------------------------

function testOrchestratorConfig(): OrchestratorConfig {
  return {
    provider: {
      base_url: "http://localhost:0",
      model: "test-model",
      max_output_tokens: 1024,
      request_timeout_ms: 120000,
      site_name: "Sentient",
      reasoning_effort: "low",
    },
    loop: { max_iterations: 4 },
    permission: { request_timeout_ms: 120000 },
    tools: {
      foreground_timeout_ms: 30000,
      max_concurrent_background_tasks: 50,
      background_completion_request_echo_chars: 240,
      max_tool_result_chars: 20000,
    },
    delegation: {
      frontmatter_dir: "./config/delegation",
      hermes_timeout_ms: 600000,
      hermes_source_profile: "default",
      hermes_delegation_profile: "default",
      hermes_profile_create_timeout_ms: 30000,
      hermes_mcp_register_timeout_ms: 30000,
    },
    auxiliary: {
      enabled: true,
      template_dir: "system_prompts/auxiliary",
      override_dir: "config/auxiliary",
      max_output_tokens: 200,
      input_truncation_chars: 4000,
      reasoning_effort: "none",
      title_word_target: 5,
      title_max_chars: 60,
    },
    compaction: {
      enabled: false,
      compact_threshold_tokens: 24000,
      keep_recent_turns: 4,
      summarizer_max_output_tokens: 4000,
      max_consecutive_failures: 3,
      max_backoff_turns: 16,
    },
  };
}

interface FakeProvider extends ProviderClient {
  calls: ProviderRequest[];
}

function fakeProvider(reply: string): FakeProvider {
  const calls: ProviderRequest[] = [];
  return {
    calls,
    stream(req) {
      calls.push(req);
      return (async function* (): AsyncGenerator<ProviderStreamChunk> {
        yield { type: "text", content: reply };
        yield { type: "done", finishReason: "stop" };
      })();
    },
  };
}

function noopBroker(): ToolBroker {
  const background: BackgroundRegistry = {
    count: () => 0,
    newestStartedAtMs: () => null,
    register: () => {},
    complete: () => {},
  };
  return {
    ownerUserId: "u_aaaaaaaa",
    foregroundInFlight: 0,
    ready: async () => {},
    definitions: () => [],
    dispatch: async () => {
      throw new Error("dispatch should never be called for a text-only response");
    },
    background,
    setBackgroundCompletionSink: () => {},
  };
}

function servicesWithStoreBackedRuntime(
  replayRegistry: ReplayRegistry,
  accessManager: AccessManager,
  provider: ProviderClient,
): GatewayServices {
  return {
    replayRegistry,
    sessionRegistry: createSessionRegistry(),
    webui: { playback: { min_eager_end_ms: 0, preempt_fadeout_ms: 0 } },
    session: { max_window_lag_bytes: 1_000_000 },
    profileStore: { get: async () => ({ ok: false, error: "no profile in this test" }) },
    createSynthesizerFor: () => null,
    stt: null,
    accessManager,
    // cleanupSession() is how a test models a socket closing: it detaches,
    // which is what disposes a session whose last window just left.
    sessionManager: { unbindUser: () => {}, removeSession: () => {} },
    createSessionRuntime: ({
      principal,
      conversationId,
      emitter,
    }: { principal: never; conversationId: string; emitter: never }) => ({
      runtime: createSessionRuntime({
        principal,
        sessionId: conversationId,
        accessManager,
        provider,
        broker: noopBroker(),
        emitter,
        timeZone: { zone: () => "UTC" },
        systemPrompt: "you are a test assistant",
        config: testOrchestratorConfig(),
      }),
      permissions: { denyAll: () => {} },
      work: IDLE_WORK,
    }),
  } as unknown as GatewayServices;
}

async function waitUntilIdle(runtime: SessionRuntime, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (runtime.running) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntilIdle: turn never settled");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Drive one `text.input` through the real router — the path that MINTS the
 *  session on a draft connection. Returns the id the mint broadcast carried.
 *  `pendingId` is threaded because it is the SECOND idempotency key: `mintKey`
 *  gives one session per draft, `pendingId` one entry per message, and a
 *  realistic retry carries both. */
async function sendFirstMessage(
  ws: FakeWs,
  services: GatewayServices,
  text: string,
  pendingId?: string,
): Promise<string> {
  const frame = { type: "text.input", text, ...(pendingId === undefined ? {} : { pendingId }) };
  await handleWebSocketMessage(asWs(ws), JSON.stringify(frame), services);
  const created = ws.sent.find((f) => f.type === "session.created");
  if (created === undefined) throw new Error("no session.created broadcast — the mint did not happen");
  return created.sessionId as string;
}

/** Every entry in one session's partition, read through a fresh handle. */
function entriesFor(accessManager: AccessManager, sessionId: string): { kind: string; text: string | null }[] {
  const store = openSessionStore(accessManager.grant(createUserPrincipal(USER_ID, "adult", "home"), "session-store"));
  const rows = store.readSession(sessionId).map((e) => ({ kind: e.kind, text: e.text }));
  store.close();
  return rows;
}

describe("handleSessionConfigure — reload rebuilds the conversation", () => {
  it("CONTRACT: a reload presenting the minted id replays the prior feed and a non-empty model projection", async () => {
    const registry = createReplayRegistry({ maxBytesPerSession: 1_000_000, retentionMs: 60_000 });
    const accessManager = freshAccessManager();
    const provider = fakeProvider("hello back");
    const services = servicesWithStoreBackedRuntime(registry, accessManager, provider);

    const first = fakeAuthedWs("connection-1");
    configure(first, services, SURFACE_A);
    // A draft: nothing exists until the first message allocates it.
    expect(first.data.conversationId).toBeNull();
    const sessionId = await sendFirstMessage(first, services, "remember the number 41");
    await waitUntilIdle(first.data.runtime as SessionRuntime);
    // The socket drops (reload) and its close event lands: the last window
    // detaches, so the session's runtime is disposed. The store is not.
    cleanupSession(asWs(first), services);

    const second = fakeAuthedWs("connection-2");
    configure(second, services, SURFACE_A, sessionId);

    const snapshot = second.sent.find((f) => f.type === "conversation.snapshot");
    const items = (snapshot?.items ?? []) as { kind: string; content?: string }[];
    expect(items.map((i) => i.kind)).toEqual(["user", "assistant"]);
    expect(items[0]?.content).toBe("remember the number 41");

    // …and the model sees it too: the next turn's request replays the prior
    // exchange, which is what "the assistant keeps context across a reload"
    // actually means.
    const secondRuntime = second.data.runtime as SessionRuntime;
    secondRuntime.submit({ kind: "conversational", text: "what number?" });
    await waitUntilIdle(secondRuntime);
    cleanupSession(asWs(second), services);
    // The SECOND LOOP call, selected rather than indexed: the same provider
    // now also serves auxiliary tasks (session titling, spec §6), whose calls
    // are interleaved with the loop's and are the only ones that set
    // `reasoningEffort`. `calls[1]` was the second turn until titling landed.
    const loopCalls = provider.calls.filter((c) => c.reasoningEffort === undefined);
    const replayed = loopCalls[1]?.messages ?? [];
    // Matched by containment: a stimulus is projected inside the envelope
    // carrying when it was sent (model-projection.ts's `stampedContent`).
    expect(replayed.some((m) => m.role === "user" && (m.content ?? "").includes("remember the number 41"))).toBe(true);
    expect(replayed.some((m) => m.role === "assistant" && m.content === "hello back")).toBe(true);
  });

  it("INVARIANT: a retried first message reaches ONE session and ONE entry", async () => {
    // The `session.created` ack cannot join the SQLite transaction that wrote
    // the row (spec §4.2). Commit lands, ack is lost, the client retries over a
    // NEW socket: the draft key is the same, so the retry must resolve to the
    // session already minted rather than fork a second one holding an
    // unreachable message.
    //
    // BOTH keys are asserted, because the guarantee is their composition and
    // the session count alone hides half of it: `mintKey` gives one session,
    // `pendingId` gives one entry. A retry carrying its pendingId — which every
    // shipped client sends — must not append the message twice or answer twice.
    const registry = createReplayRegistry({ maxBytesPerSession: 1_000_000, retentionMs: 60_000 });
    const accessManager = freshAccessManager();
    const services = servicesWithStoreBackedRuntime(registry, accessManager, fakeProvider("ok"));

    const first = fakeAuthedWs("connection-1");
    configure(first, services, SURFACE_A);
    const draftKey = first.data.draftKey as string;
    const sessionId = await sendFirstMessage(first, services, "hello", "pending-1");
    await waitUntilIdle(first.data.runtime as SessionRuntime);
    // The socket drops before the ack is read. Its close event has NOT been
    // processed, so the claim it took at mint time is still in the registry —
    // the exact window the takeover below has to beat.
    dropSocket(first);
    cleanupSession(asWs(first), services);

    // The retry arrives on a NEW socket carrying the same unspent draft key.
    const retry = fakeAuthedWs("connection-2");
    configure(retry, services, SURFACE_A, draftKey);
    expect(retry.data.conversationId).toBeNull();
    const retriedId = await sendFirstMessage(retry, services, "hello", "pending-1");
    await waitUntilIdle(retry.data.runtime as SessionRuntime);
    cleanupSession(asWs(retry), services);

    expect(retriedId).toBe(sessionId);
    const store = openSessionStore(accessManager.grant(createUserPrincipal(USER_ID, "adult", "home"), "session-store"));
    expect(store.listSessionsWithMetadata()).toHaveLength(1);
    store.close();
    expect(entriesFor(accessManager, sessionId)).toEqual([
      { kind: "user", text: "hello" },
      { kind: "assistant", text: "ok" },
    ]);
  });

  it("INVARIANT: a retry without a pendingId still reaches one session, and duplicates only the entry", async () => {
    // `textInputSchema.pendingId` is OPTIONAL, so this is the weaker half of
    // the guarantee, pinned rather than assumed. The §4.2 hazard is still
    // closed — one session, message reachable, no orphan partition — but the
    // message is committed twice and answered twice. Anything that made this
    // fork a SECOND session would be the real defect; anything that made it
    // stop duplicating would mean the wire began enforcing the key, and this
    // row is where that shows up instead of a stale comment claiming it does.
    const registry = createReplayRegistry({ maxBytesPerSession: 1_000_000, retentionMs: 60_000 });
    const accessManager = freshAccessManager();
    const services = servicesWithStoreBackedRuntime(registry, accessManager, fakeProvider("ok"));

    const first = fakeAuthedWs("connection-1");
    configure(first, services, SURFACE_A);
    const draftKey = first.data.draftKey as string;
    const sessionId = await sendFirstMessage(first, services, "hello");
    await waitUntilIdle(first.data.runtime as SessionRuntime);
    dropSocket(first);
    cleanupSession(asWs(first), services);

    const retry = fakeAuthedWs("connection-2");
    configure(retry, services, SURFACE_A, draftKey);
    expect(await sendFirstMessage(retry, services, "hello")).toBe(sessionId);
    await waitUntilIdle(retry.data.runtime as SessionRuntime);
    cleanupSession(asWs(retry), services);

    const store = openSessionStore(accessManager.grant(createUserPrincipal(USER_ID, "adult", "home"), "session-store"));
    expect(store.listSessionsWithMetadata()).toHaveLength(1);
    store.close();
    expect(entriesFor(accessManager, sessionId).filter((e) => e.kind === "user")).toHaveLength(2);
  });

  it("CONTRACT: a replayed mint re-projects the feed, so the earlier exchange is not invisible", async () => {
    // The retry connection was told at handshake time it was a draft and handed
    // an EMPTY committed feed. Without a snapshot here the client renders only
    // the retried message and its reply, and the earlier exchange stays hidden
    // until a reload — on the exact path this design exists to serve.
    const registry = createReplayRegistry({ maxBytesPerSession: 1_000_000, retentionMs: 60_000 });
    const accessManager = freshAccessManager();
    const services = servicesWithStoreBackedRuntime(registry, accessManager, fakeProvider("ok"));

    const first = fakeAuthedWs("connection-1");
    configure(first, services, SURFACE_A);
    const draftKey = first.data.draftKey as string;
    await sendFirstMessage(first, services, "hello", "pending-1");
    await waitUntilIdle(first.data.runtime as SessionRuntime);
    dropSocket(first);
    cleanupSession(asWs(first), services);

    const retry = fakeAuthedWs("connection-2");
    configure(retry, services, SURFACE_A, draftKey);
    // The draft handshake's own empty snapshot — the thing that would be left
    // standing if the replayed mint sent nothing.
    expect(retry.sent.filter((f) => f.type === "conversation.snapshot")).toHaveLength(1);
    await sendFirstMessage(retry, services, "hello", "pending-1");
    await waitUntilIdle(retry.data.runtime as SessionRuntime);
    cleanupSession(asWs(retry), services);

    const snapshots = retry.sent.filter((f) => f.type === "conversation.snapshot");
    expect(snapshots).toHaveLength(2);
    const items = (snapshots[1]?.items ?? []) as { kind: string; content?: string }[];
    expect(items.map((i) => i.kind)).toEqual(["user", "assistant"]);
    expect(items[0]?.content).toBe("hello");
  });

  it("INVARIANT: a bind that throws RELEASES the session journal instead of pinning it", async () => {
    // The journal is acquired BEFORE the handles are constructed, and the only
    // other release is the handles' own `dispose()` — on handles a throwing
    // build never returned. `acquire` adds a lease and clears `detachedAtMs`,
    // and the retention clock starts only when the lease set EMPTIES, so an
    // unreleased lease pins the entry (up to `replay_journal_max_bytes`) for
    // the life of the process, once per affected session.
    //
    // Observed through the sweep, which is what a leaked lease defeats: a
    // released entry is reclaimed once its retention window passes, a pinned
    // one never is. `acquire` sweeps first, so any later acquire is the probe.
    let clock = 1_000;
    const registry = createReplayRegistry({
      maxBytesPerSession: 1_000_000,
      retentionMs: 60_000,
      now: () => clock,
    });
    const accessManager = freshAccessManager();
    const services = servicesWithStoreBackedRuntime(registry, accessManager, fakeProvider("ok"));
    (services as { createSessionRuntime: unknown }).createSessionRuntime = () => {
      throw new Error("no active LLM key for this user");
    };

    const ws = fakeAuthedWs("connection-1");
    configure(ws, services, SURFACE_A);
    await handleWebSocketMessage(asWs(ws), JSON.stringify({ type: "text.input", text: "hello" }), services);
    expect(ws.data.runtime).toBeNull();
    expect(registry.size).toBe(1);

    clock += 60_001;
    registry.acquire("s_unrelated"); // any acquire sweeps first

    // Only the probe survives. A pinned entry would still be here, holding its
    // journal, with no lifecycle left that can ever release it.
    expect(registry.size).toBe(1);
  });

  it("INVARIANT: a failed bind leaves the connection retryable instead of wedged for its whole life", async () => {
    // `conversationId` is claimed only AFTER a successful bind. Setting it
    // first and failing would send every later `text.input` down the "bound,
    // but no runtime" branch, which never re-attempts the bind — the socket
    // would answer `orchestrator_unavailable` until it closed. The mint is
    // idempotent, so leaving it null costs nothing: the retry re-resolves the
    // SAME row under the same draft key.
    const registry = createReplayRegistry({ maxBytesPerSession: 1_000_000, retentionMs: 60_000 });
    const accessManager = freshAccessManager();
    const services = servicesWithStoreBackedRuntime(registry, accessManager, fakeProvider("ok"));
    let failNextBind = true;
    const workingFactory = services.createSessionRuntime;
    (services as { createSessionRuntime: unknown }).createSessionRuntime = (req: never) => {
      if (failNextBind) {
        failNextBind = false;
        throw new Error("no active LLM key for this user");
      }
      return (workingFactory as (r: never) => unknown)(req);
    };

    const ws = fakeAuthedWs("connection-1");
    configure(ws, services, SURFACE_A);
    const draftKey = ws.data.draftKey as string;

    await handleWebSocketMessage(asWs(ws), JSON.stringify({ type: "text.input", text: "hello" }), services);
    expect(ws.sent.some((f) => f.type === "error" && f.code === "orchestrator_unavailable")).toBe(true);
    expect(ws.data.conversationId).toBeNull();
    expect(ws.data.draftKey).toBe(draftKey);

    // Same socket, next message: the bind is retried and the session resolves
    // to the row the failed attempt already minted.
    const sessionId = await sendFirstMessage(ws, services, "hello", "pending-1");
    await waitUntilIdle(ws.data.runtime as SessionRuntime);

    expect(ws.data.conversationId).toBe(sessionId);
    const store = openSessionStore(accessManager.grant(createUserPrincipal(USER_ID, "adult", "home"), "session-store"));
    expect(store.listSessionsWithMetadata()).toHaveLength(1);
    store.close();
    cleanupSession(asWs(ws), services);
  });

  it("INVARIANT: a bind that fails at session.configure is retried on the next message, on the SAME session", async () => {
    // The second instance of the wedge, on the reload path rather than the mint
    // path: a connection re-opens an existing session, its runtime fails to
    // construct (no active LLM key), and `conversationId` is left set with no
    // runtime. Before the retry existed this branch logged and gave up, so a
    // key restored a second later changed nothing until the user reloaded.
    //
    // Re-binding, NOT clearing-and-minting: the id is the only record of which
    // session the client asked for, so a mint here would silently move them
    // into a brand-new conversation. The assertions below pin both halves —
    // the socket recovers, AND it recovers onto the session that was presented.
    const registry = createReplayRegistry({ maxBytesPerSession: 1_000_000, retentionMs: 60_000 });
    const accessManager = freshAccessManager();
    const services = servicesWithStoreBackedRuntime(registry, accessManager, fakeProvider("ok"));
    const sessionId = seedSession(accessManager, USER_ID, "from before the reload");

    let failNextBind = true;
    const workingFactory = services.createSessionRuntime;
    (services as { createSessionRuntime: unknown }).createSessionRuntime = (req: never) => {
      if (failNextBind) {
        failNextBind = false;
        throw new Error("no active LLM key for this user");
      }
      return (workingFactory as (r: never) => unknown)(req);
    };

    const ws = fakeAuthedWs("connection-1");
    configure(ws, services, SURFACE_A, sessionId);
    expect(ws.data.runtime).toBeNull();
    // The id is KEPT despite the failure — it is what the retry re-binds.
    expect(ws.data.conversationId).toBe(sessionId);
    // A failed handshake could project no feed, not even the draft's empty one.
    expect(ws.sent.filter((f) => f.type === "conversation.snapshot")).toHaveLength(0);

    await handleWebSocketMessage(asWs(ws), JSON.stringify({ type: "text.input", text: "still here?" }), services);
    await waitUntilIdle(ws.data.runtime as SessionRuntime);

    expect(ws.data.conversationId).toBe(sessionId);
    expect(ws.sent.some((f) => f.type === "error" && f.code === "orchestrator_unavailable")).toBe(false);
    // Recovered onto the presented session, not a fresh one: no second row, and
    // the message landed in the partition that already held the earlier turn.
    const store = openSessionStore(accessManager.grant(createUserPrincipal(USER_ID, "adult", "home"), "session-store"));
    expect(store.listSessionsWithMetadata()).toHaveLength(1);
    store.close();
    expect(entriesFor(accessManager, sessionId).map((e) => e.text)).toEqual([
      "from before the reload",
      "still here?",
      "ok",
    ]);
    // …and the late bind hands over the history the handshake never could.
    const snapshot = ws.sent.find((f) => f.type === "conversation.snapshot");
    expect(((snapshot?.items ?? []) as { content?: string }[])[0]?.content).toBe("from before the reload");
    cleanupSession(asWs(ws), services);
  });

  it("INVARIANT: a late bind JOINS the connection that took the session over meanwhile", async () => {
    // The hazard the late re-bind used to open, in its four steps:
    //   1. A opens session S; its bind fails transiently (secrets-store hiccup).
    //   2. A sits idle — the client is showing an error, or nobody has typed.
    //   3. B opens S after the condition clears and binds it.
    //   4. A finally sends a message.
    //
    // Under the single-owner registry, step 4 CLAIMED S and tore B down, so
    // this branch had to decline — a connection that failed early and recovered
    // late must not beat one that succeeded in between. Attaching removes the
    // conflict rather than arbitrating it: A joins B's runtime, both windows
    // are live in S, and A's message is served instead of refused.
    const registry = createReplayRegistry({ maxBytesPerSession: 1_000_000, retentionMs: 60_000 });
    const accessManager = freshAccessManager();
    const services = servicesWithStoreBackedRuntime(registry, accessManager, fakeProvider("ok"));
    const sessionId = seedSession(accessManager, USER_ID, "shared session");

    let failNextBind = true;
    const workingFactory = services.createSessionRuntime;
    (services as { createSessionRuntime: unknown }).createSessionRuntime = (req: never) => {
      if (failNextBind) {
        failNextBind = false;
        throw new Error("no active LLM key for this user");
      }
      return (workingFactory as (r: never) => unknown)(req);
    };

    // 1 + 2: A resolves S, its bind fails, nothing is claimed, and it idles.
    const a = fakeAuthedWs("connection-a");
    configure(a, services, SURFACE_A, sessionId);
    expect(a.data.runtime).toBeNull();
    expect(a.data.conversationId).toBe(sessionId);

    // 3: B opens the same session and binds successfully.
    const b = fakeAuthedWs("connection-b");
    configure(b, services, SURFACE_B, sessionId);
    const bRuntime = b.data.runtime as SessionRuntime;
    expect(bRuntime).not.toBeNull();

    // 4: A's first message is served — by B's runtime, not by a second one.
    await handleWebSocketMessage(asWs(a), JSON.stringify({ type: "text.input", text: "late" }), services);
    await waitUntilIdle(bRuntime);

    expect(b.data.runtime).toBe(bRuntime); // B was NOT torn down…
    expect(services.sessionRegistry.handlesFor(sessionId)?.permissions).toBeDefined();
    expect(a.data.runtime).toBe(bRuntime); // …and A shares it rather than forking one.
    expect(a.sent.some((f) => f.type === "error" && f.code === "orchestrator_unavailable")).toBe(false);
    expect(services.sessionRegistry.subscribers(sessionId)).toHaveLength(2);
    // One log, one loop: A's message landed in the session B was already on.
    expect(entriesFor(accessManager, sessionId).map((e) => e.text)).toEqual(["shared session", "late", "ok"]);
    cleanupSession(asWs(a), services);
    cleanupSession(asWs(b), services);
  });

  it("INVARIANT: two LIVE connections sharing one draft key land on ONE session and ONE runtime", async () => {
    // The duplicated-tab race, reachable without any drop at all.
    //
    // The draft key lives in per-tab sessionStorage
    // (`sentient.currentSessionId`, shared/web-sdk/src/sdk-reconnect.ts), and
    // sessionStorage is COPIED into a duplicated browsing context — an ordinary
    // browser "Duplicate Tab". A user mid-draft who duplicates the tab now has
    // two independently connected sockets presenting ONE draft key, both routed
    // onto that draft by `resolveConnectionSession`. Nothing is reconnecting and
    // nothing is dying. Whichever sends first mints; the other's first message
    // replays onto that same id.
    //
    // It used to be a race with a loser: the second mint CLAIMED the session
    // and evicted a fully live tab that might have been mid-conversation, and
    // `session.created` is a single-connection send, so the loser never learned
    // it had lost. Both tabs now attach to the one session the mint key
    // resolves to — which is the invariant that matters, since two runtimes
    // over that one partition would fork the append-only log.
    const registry = createReplayRegistry({ maxBytesPerSession: 1_000_000, retentionMs: 60_000 });
    const accessManager = freshAccessManager();
    const services = servicesWithStoreBackedRuntime(registry, accessManager, fakeProvider("ok"));

    const original = fakeAuthedWs("connection-original");
    configure(original, services, SURFACE_A);
    const draftKey = original.data.draftKey as string;

    // The duplicate carries the copied surfaceId too, which is why it is
    // SURFACE_A here and not a second surface.
    const duplicate = fakeAuthedWs("connection-duplicate");
    configure(duplicate, services, SURFACE_A, draftKey);
    expect(duplicate.data.draftKey).toBe(draftKey);

    const sessionId = await sendFirstMessage(original, services, "first tab types");
    const originalRuntime = original.data.runtime as SessionRuntime;
    await waitUntilIdle(originalRuntime);

    await handleWebSocketMessage(
      asWs(duplicate),
      JSON.stringify({ type: "text.input", text: "second tab types" }),
      services,
    );

    await waitUntilIdle(originalRuntime);

    expect(original.data.runtime).toBe(originalRuntime); // the live tab was NOT torn down…
    expect(services.sessionRegistry.handlesFor(sessionId)?.permissions).toBeDefined();
    expect(duplicate.data.runtime).toBe(originalRuntime); // …and the duplicate joined it.
    expect(duplicate.data.conversationId).toBe(sessionId);
    expect(duplicate.sent.some((f) => f.type === "error" && f.code === "orchestrator_unavailable")).toBe(false);
    // ONE partition, ONE loop: both tabs' messages are in the same log, in
    // order, with no forked session.
    expect(entriesFor(accessManager, sessionId).map((e) => e.text)).toEqual([
      "first tab types",
      "ok",
      "second tab types",
      "ok",
    ]);
    cleanupSession(asWs(duplicate), services);
    cleanupSession(asWs(original), services);
  });

  it("INVARIANT: a first-message retry over a new socket is served while the original is still CLOSING", async () => {
    // The wedge an ownership model has to keep answering for: the original
    // minted and dropped, but its close event has NOT been processed, so it is
    // still attached to the session. The old registry needed a liveness
    // predicate here — a corpse holding an exclusive claim would have refused
    // the retry outright. Attaching needs none: the retry joins the session
    // whatever state its peer is in, and the fan-out skips the socket that can
    // no longer be written to (fan-out-emitter.ts).
    const registry = createReplayRegistry({ maxBytesPerSession: 1_000_000, retentionMs: 60_000 });
    const accessManager = freshAccessManager();
    const services = servicesWithStoreBackedRuntime(registry, accessManager, fakeProvider("ok"));

    const first = fakeAuthedWs("connection-1");
    configure(first, services, SURFACE_A);
    const draftKey = first.data.draftKey as string;
    const sessionId = await sendFirstMessage(first, services, "hello", "pending-1");
    await waitUntilIdle(first.data.runtime as SessionRuntime);
    // Deliberately NOT cleaned up — only the transport is gone, so this
    // connection is still attached when the retry arrives.
    dropSocket(first, WS_CLOSING);

    const retry = fakeAuthedWs("connection-2");
    configure(retry, services, SURFACE_A, draftKey);
    const retriedId = await sendFirstMessage(retry, services, "hello", "pending-1");
    await waitUntilIdle(retry.data.runtime as SessionRuntime);

    expect(retriedId).toBe(sessionId);
    expect(retry.data.conversationId).toBe(sessionId);
    expect(retry.sent.some((f) => f.type === "error" && f.code === "orchestrator_unavailable")).toBe(false);
    // ONE runtime over the partition, shared with the dying original rather
    // than a second one racing it — two would fork the append-only log and put
    // two sqlite handles on one WAL.
    expect(retry.data.runtime).toBe(first.data.runtime);
    expect(entriesFor(accessManager, sessionId).map((e) => e.text)).toEqual(["hello", "ok"]);
    cleanupSession(asWs(retry), services);
    cleanupSession(asWs(first), services);
  });

  it("a connection that presents nothing starts clean — no other session bleeds in", async () => {
    const registry = createReplayRegistry({ maxBytesPerSession: 1_000_000, retentionMs: 60_000 });
    const accessManager = freshAccessManager();
    const services = servicesWithStoreBackedRuntime(registry, accessManager, fakeProvider("hello back"));

    const first = fakeAuthedWs("connection-1");
    configure(first, services, SURFACE_A);
    await sendFirstMessage(first, services, "private to the first session");
    await waitUntilIdle(first.data.runtime as SessionRuntime);
    cleanupSession(asWs(first), services);

    const second = fakeAuthedWs("connection-2");
    configure(second, services, SURFACE_B);

    const snapshot = second.sent.find((f) => f.type === "conversation.snapshot");
    expect(snapshot?.items).toEqual([]);
    expect(second.data.runtime).toBeNull();
  });
});
