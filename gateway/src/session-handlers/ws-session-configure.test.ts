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
import { createSessionRuntime } from "../runtime/session-runtime.js";
import type { SessionRuntime } from "../runtime/session-runtime.js";
import { openSessionStore } from "../store/session-store.js";
import type { BackgroundRegistry } from "../tools/background-registry.js";
import type { ToolBroker } from "../tools/tool-broker.js";
import { createConversationRuntimeRegistry } from "./conversation-runtime-registry.js";
import { type ReplayRegistry, createReplayRegistry } from "./replay-registry.js";
import { mintSessionId } from "./session-id.js";
import { cleanupSession, handleWebSocketMessage } from "./ws-handlers.js";
import { type SessionData, createEmptySessionData } from "./ws-helpers.js";
import { sendGatewayFrame } from "./ws-send.js";
import { handleSessionConfigure } from "./ws-session-configure.js";

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

interface FakeWs {
  data: SessionData;
  sent: Record<string, unknown>[];
  send: (payload: string) => void;
}

function fakeAuthedWs(connectionSessionId = "test-session"): FakeWs {
  const data = createEmptySessionData();
  data.sessionId = connectionSessionId;
  data.authState = "authed";
  data.principal = createUserPrincipal(USER_ID, "adult", "home");
  const ws: FakeWs = {
    data,
    sent: [],
    send(payload) {
      ws.sent.push(JSON.parse(payload) as Record<string, unknown>);
    },
  };
  return ws;
}

function asWs(ws: FakeWs): ServerWebSocket<SessionData> {
  return ws as unknown as ServerWebSocket<SessionData>;
}

/** Only the three fields `handleSessionConfigure` reads on the no-orchestrator
 *  path: the registry it acquires from, the playback block session.ready
 *  carries, and (when the client presents an id) the AccessManager whose
 *  capability selects the store the membership lookup runs against. */
function servicesWith(replayRegistry: ReplayRegistry, accessManager?: AccessManager): GatewayServices {
  return {
    replayRegistry,
    conversationRuntimes: createConversationRuntimeRegistry(),
    webui: { playback: { min_eager_end_ms: 0, preempt_fadeout_ms: 0 } },
    accessManager,
    createSessionRuntime: null,
  } as unknown as GatewayServices;
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
      sendGatewayFrame(asWs(ws), { type: "conversation.snapshot", items: [] });
    },
    dispose: () => {},
  } as unknown as SessionRuntime;
  spy.services = {
    replayRegistry,
    conversationRuntimes: createConversationRuntimeRegistry(),
    webui: { playback: { min_eager_end_ms: 0, preempt_fadeout_ms: 0 } },
    profileStore: { get: async () => ({ ok: false, error: "no profile in this test" }) },
    createSynthesizerFor: () => null,
    stt: null,
    accessManager,
    createSessionRuntime: () => ({ runtime, permissions: { denyAll: () => {} } }),
  } as unknown as GatewayServices;
  return spy;
}

describe("handleSessionConfigure — journal across a re-configure", () => {
  it("keeps the same journal and epoch when a still-open connection re-configures the same surface", () => {
    const registry = createReplayRegistry({ maxBytesPerSurface: 1_000_000, retentionMs: 60_000 });
    const services = servicesWith(registry);
    const ws = fakeAuthedWs();

    configure(ws, services, SURFACE_A);
    const firstJournal = ws.data.journal;
    const firstEpoch = ws.data.epoch;

    configure(ws, services, SURFACE_A);

    expect(ws.data.journal).toBe(firstJournal);
    expect(ws.data.epoch).toBe(firstEpoch);
  });

  it("continues the same seq space across that re-configure, so the client sees no restart", () => {
    const registry = createReplayRegistry({ maxBytesPerSurface: 1_000_000, retentionMs: 60_000 });
    const services = servicesWith(registry);
    const ws = fakeAuthedWs();

    configure(ws, services, SURFACE_A);
    configure(ws, services, SURFACE_A);

    // Three frames per draft handshake (ready, empty snapshot, draft key), so
    // the second ready lands at seq 4 — contiguous, no restart.
    const readies = ws.sent.filter((f) => f.type === "session.ready");
    expect(readies.map((f) => f.seq)).toEqual([1, 4]);
    expect(readies.map((f) => f.epoch)).toEqual([readies[0]?.epoch, readies[0]?.epoch]);
  });

  it("leaves the surface attached, so a later reconnect at that epoch still resumes", () => {
    const registry = createReplayRegistry({ maxBytesPerSurface: 1_000_000, retentionMs: 60_000 });
    const services = servicesWith(registry);
    const ws = fakeAuthedWs();

    configure(ws, services, SURFACE_A);
    configure(ws, services, SURFACE_A);
    const epoch = ws.data.epoch;
    const lease = ws.data.replayLease;
    expect(lease).not.toBeNull();

    registry.release(lease as NonNullable<typeof lease>);
    const reconnect = registry.acquire(`${USER_ID}::${SURFACE_A}`, epoch);

    expect(reconnect.resumed).toBe(true);
    expect(reconnect.journal.newestSeq).toBe(6);
    expect(registry.size).toBe(1);
  });

  it("mints a fresh journal and epoch when the same connection re-configures a DIFFERENT surface", () => {
    const registry = createReplayRegistry({ maxBytesPerSurface: 1_000_000, retentionMs: 60_000 });
    const services = servicesWith(registry);
    const ws = fakeAuthedWs();

    configure(ws, services, SURFACE_A);
    const firstJournal = ws.data.journal;
    const firstEpoch = ws.data.epoch;

    configure(ws, services, SURFACE_B);

    expect(ws.data.journal).not.toBe(firstJournal);
    expect(ws.data.epoch).not.toBe(firstEpoch);
    expect(ws.data.journal?.newestSeq).toBe(3);
  });
});

describe("handleSessionConfigure — committed-feed handshake", () => {
  it("CONTRACT: re-opening a session sends conversation.snapshot right after session.ready", () => {
    // Nothing else on the wire carries committed history: `turn.*` is a live
    // stream the client drops on turn.completed. Without this frame the chat
    // is empty on every reload.
    const registry = createReplayRegistry({ maxBytesPerSurface: 1_000_000, retentionMs: 60_000 });
    const ws = fakeAuthedWs();
    const accessManager = freshAccessManager();
    const spy = servicesWithRuntime(registry, ws, accessManager);
    const sessionId = seedSession(accessManager, USER_ID, "earlier turn");

    configure(ws, spy.services, SURFACE_A, sessionId);

    expect(frameTypes(ws)).toEqual(["session.ready", "conversation.snapshot"]);
    expect(spy.snapshotCalls).toBe(1);
  });

  it("CONTRACT: a draft connection is told it is a draft — empty snapshot, then the key it will mint under", () => {
    // A draft has no row and no id, so there is no feed to project. The empty
    // snapshot is still mandatory: without it a reload right after "+" leaves
    // the previous session's bubbles on screen with nothing to clear them.
    // The `session.draft` key is what a client whose outbound queue gates on
    // "a conversation is attached" (mobile) holds so the queue can drain.
    const registry = createReplayRegistry({ maxBytesPerSurface: 1_000_000, retentionMs: 60_000 });
    const ws = fakeAuthedWs();
    const spy = servicesWithRuntime(registry, ws, freshAccessManager());

    configure(ws, spy.services, SURFACE_A);

    expect(frameTypes(ws)).toEqual(["session.ready", "conversation.snapshot", "session.draft"]);
    expect(spy.snapshotCalls).toBe(0); // no runtime was built — there is no session
    expect(ws.data.conversationId).toBeNull();
    expect(ws.data.draftKey).toBe(ws.sent[2]?.draftKey as string);
  });

  it("CONTRACT: a RECOVERED resume sends no snapshot — the verbatim replay already restored the mirror", () => {
    const registry = createReplayRegistry({ maxBytesPerSurface: 1_000_000, retentionMs: 60_000 });
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
    const registry = createReplayRegistry({ maxBytesPerSurface: 1_000_000, retentionMs: 60_000 });
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

    expect(frameTypes(ws)).toEqual(["stream.resumed", "session.ready", "conversation.snapshot"]);
    expect(ws.sent[0]?.recovered).toBe(false);
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
    emitConversationSnapshot: () => sendGatewayFrame(asWs(ws), { type: "conversation.snapshot", items: [] }),
    dispose: () => {},
  } as unknown as SessionRuntime;
  spy.services = {
    replayRegistry,
    conversationRuntimes: createConversationRuntimeRegistry(),
    webui: { playback: { min_eager_end_ms: 0, preempt_fadeout_ms: 0 } },
    profileStore: { get: async () => ({ ok: false, error: "no profile in this test" }) },
    createSynthesizerFor: () => null,
    stt: null,
    accessManager,
    createSessionRuntime: ({ conversationId }: { conversationId: string }) => {
      spy.partitionIds.push(conversationId);
      return { runtime, permissions: { denyAll: () => {} } };
    },
  } as unknown as GatewayServices;
  return spy;
}

describe("handleSessionConfigure — session addressing", () => {
  it("SECURITY: an id this user's store does not hold is refused, not created", () => {
    // The junk-partition vector: the previous handler honoured any
    // well-prefixed string and opened an empty partition for it, so a client
    // could fill a user's database with rows nothing can list, open or delete.
    const registry = createReplayRegistry({ maxBytesPerSurface: 1_000_000, retentionMs: 60_000 });
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
    const registry = createReplayRegistry({ maxBytesPerSurface: 1_000_000, retentionMs: 60_000 });
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
    const registry = createReplayRegistry({ maxBytesPerSurface: 1_000_000, retentionMs: 60_000 });
    const accessManager = freshAccessManager();
    const spy = servicesRecordingPartition(registry, fakeAuthedWs(), accessManager);

    for (let i = 0; i < 10; i += 1) configure(fakeAuthedWs(`connection-${i}`), spy.services, `surface-${i}`);

    const store = openSessionStore(accessManager.grant(createUserPrincipal(USER_ID, "adult", "home"), "session-store"));
    expect(store.listSessionsWithMetadata()).toEqual([]);
    store.close();
    expect(spy.partitionIds).toEqual([]);
  });

  it("CONTRACT: an id this user's store holds is opened, and it is not the connection id", () => {
    const registry = createReplayRegistry({ maxBytesPerSurface: 1_000_000, retentionMs: 60_000 });
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
    const registry = createReplayRegistry({ maxBytesPerSurface: 1_000_000, retentionMs: 60_000 });
    const first = fakeAuthedWs("connection-1");
    const accessManager = freshAccessManager();
    const spy = servicesRecordingPartition(registry, first, accessManager);
    const sessionId = seedSession(accessManager, USER_ID, "earlier turn");

    configure(first, spy.services, SURFACE_A, sessionId);
    configure(fakeAuthedWs("connection-2"), spy.services, SURFACE_B, sessionId);

    expect(spy.partitionIds).toEqual([sessionId, sessionId]);
  });

  it("INVARIANT: a legacy c:: partition that holds entries is still addressable", () => {
    // Existing users' conversations are rows in their own store, reached
    // through the same membership lookup. Both shapes are handled identically
    // and the surfaceId inside a legacy id carries no authority.
    const registry = createReplayRegistry({ maxBytesPerSurface: 1_000_000, retentionMs: 60_000 });
    const ws = fakeAuthedWs();
    const accessManager = freshAccessManager();
    const spy = servicesRecordingPartition(registry, ws, accessManager);
    const legacyId = `c::${USER_ID}::${SURFACE_A}`;
    const store = openSessionStore(accessManager.grant(createUserPrincipal(USER_ID, "adult", "home"), "session-store"));
    store.append({
      sessionId: legacyId,
      turnId: "legacy-turn",
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
    const registry = createReplayRegistry({ maxBytesPerSurface: 1_000_000, retentionMs: 60_000 });
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
// One live runtime per conversation.
//
// Making the conversation durable made it SHARED: two sockets can now name the
// same store partition. replay-registry.ts already documents the window that
// makes this routine rather than hypothetical — "a same-tab reload whose new
// session.configure lands before the old socket's close event, or a TCP/NAT
// drop Bun's idle timeout has not noticed yet" — and mints a fresh journal so
// the two never share a seq counter. The runtime needs the same treatment for
// a stronger reason: two live `SessionRuntime`s on one partition are two ReAct
// loops appending to one append-only log with different views of the prior
// context, plus two `bun:sqlite` handles on one WAL file.
//
// Newest connection wins, matching the registry's own stance on the same race.
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
    conversationRuntimes: createConversationRuntimeRegistry(),
    webui: { playback: { min_eager_end_ms: 0, preempt_fadeout_ms: 0 } },
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
      } as unknown as SessionRuntime;
      return { runtime, permissions: { denyAll: () => {} } };
    },
  } as unknown as GatewayServices;
  return spy;
}

describe("handleSessionConfigure — one live runtime per session", () => {
  it("CONTRACT: a new connection on a live session evicts the previous connection's runtime", () => {
    const registry = createReplayRegistry({ maxBytesPerSurface: 1_000_000, retentionMs: 60_000 });
    const accessManager = freshAccessManager();
    const spy = servicesTrackingRuntimes(registry, accessManager);
    const sessionId = seedSession(accessManager, USER_ID, "earlier turn");

    const stale = fakeAuthedWs("connection-1");
    configure(stale, spy.services, SURFACE_A, sessionId);
    const fresh = fakeAuthedWs("connection-2");
    configure(fresh, spy.services, SURFACE_A, sessionId);

    expect(spy.minted[0]?.disposeCount).toBe(1);
    expect(stale.data.runtime).toBeNull();
    expect(stale.data.permissions).toBeNull();
    expect(spy.minted[1]?.disposeCount).toBe(0);
    expect(fresh.data.runtime).not.toBeNull();
  });

  it("leaves a live runtime on a DIFFERENT session alone", () => {
    const registry = createReplayRegistry({ maxBytesPerSurface: 1_000_000, retentionMs: 60_000 });
    const accessManager = freshAccessManager();
    const spy = servicesTrackingRuntimes(registry, accessManager);
    const firstId = seedSession(accessManager, USER_ID, "one");
    const secondId = seedSession(accessManager, USER_ID, "two");

    const first = fakeAuthedWs("connection-1");
    configure(first, spy.services, SURFACE_A, firstId);
    const second = fakeAuthedWs("connection-2");
    configure(second, spy.services, SURFACE_B, secondId);

    expect(spy.minted[0]?.disposeCount).toBe(0);
    expect(first.data.runtime).not.toBeNull();
  });

  it("keeps the runtime a re-configure on the SAME connection just minted", () => {
    const registry = createReplayRegistry({ maxBytesPerSurface: 1_000_000, retentionMs: 60_000 });
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

  it("CONTRACT: a superseded connection's teardown cannot deregister the live one", () => {
    // Mirrors replay-registry's stale-lease guard: the close event of the
    // socket a reload replaced lands AFTER the new socket configured.
    const registry = createReplayRegistry({ maxBytesPerSurface: 1_000_000, retentionMs: 60_000 });
    const accessManager = freshAccessManager();
    const spy = servicesTrackingRuntimes(registry, accessManager);
    const sessionId = seedSession(accessManager, USER_ID, "earlier turn");

    const stale = fakeAuthedWs("connection-1");
    configure(stale, spy.services, SURFACE_A, sessionId);
    const live = fakeAuthedWs("connection-2");
    configure(live, spy.services, SURFACE_A, sessionId);

    cleanupSession(asWs(stale), spy.services);

    // The live connection is still the registered owner, so a THIRD connection
    // still evicts it — which it could not do if the stale teardown had
    // dropped the entry.
    const third = fakeAuthedWs("connection-3");
    configure(third, spy.services, SURFACE_A, sessionId);
    expect(spy.minted[1]?.disposeCount).toBe(1);
    expect(live.data.runtime).toBeNull();
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
    register: () => {},
    complete: () => {},
    cancelAll: () => {},
  };
  return {
    ownerUserId: "u_aaaaaaaa",
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
    conversationRuntimes: createConversationRuntimeRegistry(),
    webui: { playback: { min_eager_end_ms: 0, preempt_fadeout_ms: 0 } },
    profileStore: { get: async () => ({ ok: false, error: "no profile in this test" }) },
    createSynthesizerFor: () => null,
    stt: null,
    accessManager,
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
        systemPrompt: "you are a test assistant",
        config: testOrchestratorConfig(),
      }),
      permissions: { denyAll: () => {} },
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
    const registry = createReplayRegistry({ maxBytesPerSurface: 1_000_000, retentionMs: 60_000 });
    const accessManager = freshAccessManager();
    const provider = fakeProvider("hello back");
    const services = servicesWithStoreBackedRuntime(registry, accessManager, provider);

    const first = fakeAuthedWs("connection-1");
    configure(first, services, SURFACE_A);
    // A draft: nothing exists until the first message allocates it.
    expect(first.data.conversationId).toBeNull();
    const sessionId = await sendFirstMessage(first, services, "remember the number 41");
    const firstRuntime = first.data.runtime as SessionRuntime;
    await waitUntilIdle(firstRuntime);
    // The socket drops (reload): the runtime is disposed, the store is not.
    firstRuntime.dispose();

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
    const replayed = provider.calls[1]?.messages ?? [];
    expect(replayed.some((m) => m.role === "user" && m.content === "remember the number 41")).toBe(true);
    expect(replayed.some((m) => m.role === "assistant" && m.content === "hello back")).toBe(true);
    secondRuntime.dispose();
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
    const registry = createReplayRegistry({ maxBytesPerSurface: 1_000_000, retentionMs: 60_000 });
    const accessManager = freshAccessManager();
    const services = servicesWithStoreBackedRuntime(registry, accessManager, fakeProvider("ok"));

    const first = fakeAuthedWs("connection-1");
    configure(first, services, SURFACE_A);
    const draftKey = first.data.draftKey as string;
    const sessionId = await sendFirstMessage(first, services, "hello", "pending-1");
    await waitUntilIdle(first.data.runtime as SessionRuntime);
    (first.data.runtime as SessionRuntime).dispose();

    // The retry arrives on a NEW socket carrying the same unspent draft key.
    const retry = fakeAuthedWs("connection-2");
    configure(retry, services, SURFACE_A, draftKey);
    expect(retry.data.conversationId).toBeNull();
    const retriedId = await sendFirstMessage(retry, services, "hello", "pending-1");
    await waitUntilIdle(retry.data.runtime as SessionRuntime);
    (retry.data.runtime as SessionRuntime).dispose();

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
    const registry = createReplayRegistry({ maxBytesPerSurface: 1_000_000, retentionMs: 60_000 });
    const accessManager = freshAccessManager();
    const services = servicesWithStoreBackedRuntime(registry, accessManager, fakeProvider("ok"));

    const first = fakeAuthedWs("connection-1");
    configure(first, services, SURFACE_A);
    const draftKey = first.data.draftKey as string;
    const sessionId = await sendFirstMessage(first, services, "hello");
    await waitUntilIdle(first.data.runtime as SessionRuntime);
    (first.data.runtime as SessionRuntime).dispose();

    const retry = fakeAuthedWs("connection-2");
    configure(retry, services, SURFACE_A, draftKey);
    expect(await sendFirstMessage(retry, services, "hello")).toBe(sessionId);
    await waitUntilIdle(retry.data.runtime as SessionRuntime);
    (retry.data.runtime as SessionRuntime).dispose();

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
    const registry = createReplayRegistry({ maxBytesPerSurface: 1_000_000, retentionMs: 60_000 });
    const accessManager = freshAccessManager();
    const services = servicesWithStoreBackedRuntime(registry, accessManager, fakeProvider("ok"));

    const first = fakeAuthedWs("connection-1");
    configure(first, services, SURFACE_A);
    const draftKey = first.data.draftKey as string;
    await sendFirstMessage(first, services, "hello", "pending-1");
    await waitUntilIdle(first.data.runtime as SessionRuntime);
    (first.data.runtime as SessionRuntime).dispose();

    const retry = fakeAuthedWs("connection-2");
    configure(retry, services, SURFACE_A, draftKey);
    // The draft handshake's own empty snapshot — the thing that would be left
    // standing if the replayed mint sent nothing.
    expect(retry.sent.filter((f) => f.type === "conversation.snapshot")).toHaveLength(1);
    await sendFirstMessage(retry, services, "hello", "pending-1");
    await waitUntilIdle(retry.data.runtime as SessionRuntime);
    (retry.data.runtime as SessionRuntime).dispose();

    const snapshots = retry.sent.filter((f) => f.type === "conversation.snapshot");
    expect(snapshots).toHaveLength(2);
    const items = (snapshots[1]?.items ?? []) as { kind: string; content?: string }[];
    expect(items.map((i) => i.kind)).toEqual(["user", "assistant"]);
    expect(items[0]?.content).toBe("hello");
  });

  it("INVARIANT: a failed bind leaves the connection retryable instead of wedged for its whole life", async () => {
    // `conversationId` is claimed only AFTER a successful bind. Setting it
    // first and failing would send every later `text.input` down the "bound,
    // but no runtime" branch, which never re-attempts the bind — the socket
    // would answer `orchestrator_unavailable` until it closed. The mint is
    // idempotent, so leaving it null costs nothing: the retry re-resolves the
    // SAME row under the same draft key.
    const registry = createReplayRegistry({ maxBytesPerSurface: 1_000_000, retentionMs: 60_000 });
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
    (ws.data.runtime as SessionRuntime).dispose();

    expect(ws.data.conversationId).toBe(sessionId);
    const store = openSessionStore(accessManager.grant(createUserPrincipal(USER_ID, "adult", "home"), "session-store"));
    expect(store.listSessionsWithMetadata()).toHaveLength(1);
    store.close();
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
    const registry = createReplayRegistry({ maxBytesPerSurface: 1_000_000, retentionMs: 60_000 });
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
    (ws.data.runtime as SessionRuntime).dispose();

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
  });

  it("INVARIANT: a late bind never evicts a live connection that took the session over meanwhile", async () => {
    // The hazard the late re-bind opens, in its four steps:
    //   1. A opens session S; its bind fails transiently (secrets-store hiccup).
    //   2. A sits idle — the client is showing an error, or nobody has typed.
    //   3. B opens S after the condition clears, binds, and CLAIMS it.
    //   4. A finally sends a message.
    //
    // Step 4 must not evict B. `claim` decides "newest wins" by call time,
    // which equals connection recency only while every connection claims during
    // its own handshake — and A, by definition, did not. Without the guard, a
    // connection that failed early and recovered late beats one that succeeded
    // in between, inverting the registry's own stated invariant and discarding
    // whatever B had in flight.
    const registry = createReplayRegistry({ maxBytesPerSurface: 1_000_000, retentionMs: 60_000 });
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

    // 4: A's first message must be refused rather than served by theft.
    await handleWebSocketMessage(asWs(a), JSON.stringify({ type: "text.input", text: "late" }), services);

    expect(b.data.runtime).toBe(bRuntime); // B was NOT evicted…
    expect(b.data.permissions).not.toBeNull();
    expect(a.data.runtime).toBeNull(); // …and A did not take the session over.
    expect(a.sent.some((f) => f.type === "error" && f.code === "orchestrator_unavailable")).toBe(true);
    bRuntime.dispose();
  });

  it("a connection that presents nothing starts clean — no other session bleeds in", async () => {
    const registry = createReplayRegistry({ maxBytesPerSurface: 1_000_000, retentionMs: 60_000 });
    const accessManager = freshAccessManager();
    const services = servicesWithStoreBackedRuntime(registry, accessManager, fakeProvider("hello back"));

    const first = fakeAuthedWs("connection-1");
    configure(first, services, SURFACE_A);
    await sendFirstMessage(first, services, "private to the first session");
    const firstRuntime = first.data.runtime as SessionRuntime;
    await waitUntilIdle(firstRuntime);
    firstRuntime.dispose();

    const second = fakeAuthedWs("connection-2");
    configure(second, services, SURFACE_B);

    const snapshot = second.sent.find((f) => f.type === "conversation.snapshot");
    expect(snapshot?.items).toEqual([]);
    expect(second.data.runtime).toBeNull();
  });
});
