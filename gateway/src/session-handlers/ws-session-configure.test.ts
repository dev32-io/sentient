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

import { describe, expect, it } from "bun:test";
import type { ServerWebSocket } from "bun";
import type { GatewayServices } from "../bootstrap/create-gateway-services.js";
import { createUserPrincipal } from "../identity/user-principal.js";
import type { SessionRuntime } from "../runtime/session-runtime.js";
import { type ReplayRegistry, createReplayRegistry } from "./replay-registry.js";
import { type SessionData, createEmptySessionData } from "./ws-helpers.js";
import { sendGatewayFrame } from "./ws-send.js";
import { handleSessionConfigure } from "./ws-session-configure.js";

const USER_ID = "u_deadbeef";
const DEVICE_ID = "device-1";
const SURFACE_A = "surface-a";
const SURFACE_B = "surface-b";

interface FakeWs {
  data: SessionData;
  sent: Record<string, unknown>[];
  send: (payload: string) => void;
}

function fakeAuthedWs(): FakeWs {
  const data = createEmptySessionData();
  data.sessionId = "test-session";
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

/** Only the two fields `handleSessionConfigure` reads on the no-orchestrator
 *  path: the registry it acquires from, and the playback block session.ready
 *  carries. */
function servicesWith(replayRegistry: ReplayRegistry): GatewayServices {
  return {
    replayRegistry,
    webui: { playback: { min_eager_end_ms: 0, preempt_fadeout_ms: 0 } },
    createSessionRuntime: null,
  } as unknown as GatewayServices;
}

function configure(ws: FakeWs, services: GatewayServices, surfaceId: string): void {
  handleSessionConfigure(asWs(ws), [], "en", services, "webui", DEVICE_ID, surfaceId, undefined, undefined);
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
function servicesWithRuntime(replayRegistry: ReplayRegistry, ws: FakeWs): SnapshotSpy {
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
    webui: { playback: { min_eager_end_ms: 0, preempt_fadeout_ms: 0 } },
    profileStore: { get: async () => ({ ok: false, error: "no profile in this test" }) },
    createSynthesizerFor: () => null,
    stt: null,
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

    const readies = ws.sent.filter((f) => f.type === "session.ready");
    expect(readies.map((f) => f.seq)).toEqual([1, 2]);
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
    expect(reconnect.journal.newestSeq).toBe(2);
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
    expect(ws.data.journal?.newestSeq).toBe(1);
  });
});

describe("handleSessionConfigure — committed-feed handshake", () => {
  it("CONTRACT: a fresh configure sends conversation.snapshot right after session.ready", () => {
    // Nothing else on the wire carries committed history: `turn.*` is a live
    // stream the client drops on turn.completed. Without this frame the chat
    // is empty on every reload.
    const registry = createReplayRegistry({ maxBytesPerSurface: 1_000_000, retentionMs: 60_000 });
    const ws = fakeAuthedWs();
    const spy = servicesWithRuntime(registry, ws);

    configure(ws, spy.services, SURFACE_A);

    expect(ws.sent.map((f) => f.type)).toEqual(["session.ready", "conversation.snapshot"]);
    expect(spy.snapshotCalls).toBe(1);
  });

  it("CONTRACT: a RECOVERED resume sends no snapshot — the verbatim replay already restored the mirror", () => {
    const registry = createReplayRegistry({ maxBytesPerSurface: 1_000_000, retentionMs: 60_000 });
    const ws = fakeAuthedWs();
    const spy = servicesWithRuntime(registry, ws);

    configure(ws, spy.services, SURFACE_A);
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
      undefined,
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
    const spy = servicesWithRuntime(registry, ws);

    handleSessionConfigure(
      asWs(ws),
      [],
      "en",
      spy.services,
      "webui",
      DEVICE_ID,
      SURFACE_A,
      { epoch: 999, lastSeq: 42 },
      undefined,
    );

    expect(ws.sent.map((f) => f.type)).toEqual(["stream.resumed", "session.ready", "conversation.snapshot"]);
    expect(ws.sent[0]?.recovered).toBe(false);
    expect(spy.snapshotCalls).toBe(1);
  });
});
