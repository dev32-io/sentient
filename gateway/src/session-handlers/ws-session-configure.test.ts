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
import type { BackgroundRegistry } from "../tools/background-registry.js";
import type { ToolBroker } from "../tools/tool-broker.js";
import { createConversationRuntimeRegistry } from "./conversation-runtime-registry.js";
import { type ReplayRegistry, createReplayRegistry } from "./replay-registry.js";
import { cleanupSession } from "./ws-handlers.js";
import { type SessionData, createEmptySessionData } from "./ws-helpers.js";
import { sendGatewayFrame } from "./ws-send.js";
import { handleSessionConfigure } from "./ws-session-configure.js";

const USER_ID = "u_deadbeef";
const OTHER_USER_ID = "u_aaaaaaaa";
const DEVICE_ID = "device-1";
const SURFACE_A = "surface-a";
const SURFACE_B = "surface-b";

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

/** Only the two fields `handleSessionConfigure` reads on the no-orchestrator
 *  path: the registry it acquires from, and the playback block session.ready
 *  carries. */
function servicesWith(replayRegistry: ReplayRegistry): GatewayServices {
  return {
    replayRegistry,
    conversationRuntimes: createConversationRuntimeRegistry(),
    webui: { playback: { min_eager_end_ms: 0, preempt_fadeout_ms: 0 } },
    createSessionRuntime: null,
  } as unknown as GatewayServices;
}

function configure(ws: FakeWs, services: GatewayServices, surfaceId: string, conversationId?: string): void {
  handleSessionConfigure(asWs(ws), [], "en", services, "webui", DEVICE_ID, surfaceId, undefined, conversationId);
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
    conversationRuntimes: createConversationRuntimeRegistry(),
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

// ---------------------------------------------------------------------------
// Durable conversation identity (spec §10 acceptance #9).
//
// The store partitions on the id this handler resolves, NOT on
// `ws.data.sessionId` — that one is minted per WEBSOCKET CONNECTION and dies
// with it, so keying the store on it opened a brand-new empty partition on
// every reload, reconnect and gateway restart: `conversation.snapshot` came
// back empty AND the model projection handed the LLM no history at all.
// ---------------------------------------------------------------------------

/** Records the partition id `handleSessionConfigure` hands the runtime factory. */
interface PartitionSpy {
  services: GatewayServices;
  partitionIds: string[];
}

function servicesRecordingPartition(replayRegistry: ReplayRegistry, ws: FakeWs): PartitionSpy {
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
    createSessionRuntime: ({ conversationId }: { conversationId: string }) => {
      spy.partitionIds.push(conversationId);
      return { runtime, permissions: { denyAll: () => {} } };
    },
  } as unknown as GatewayServices;
  return spy;
}

describe("handleSessionConfigure — durable conversation identity", () => {
  it("CONTRACT: two connections on the same surface resolve the SAME store partition", () => {
    const registry = createReplayRegistry({ maxBytesPerSurface: 1_000_000, retentionMs: 60_000 });
    const first = fakeAuthedWs("connection-1");
    const spy = servicesRecordingPartition(registry, first);

    configure(first, spy.services, SURFACE_A);
    const second = fakeAuthedWs("connection-2");
    configure(second, spy.services, SURFACE_A);

    expect(spy.partitionIds).toHaveLength(2);
    expect(spy.partitionIds[0]).toBe(spy.partitionIds[1] as string);
  });

  it("CONTRACT: the partition is NOT the per-connection sessionId", () => {
    const registry = createReplayRegistry({ maxBytesPerSurface: 1_000_000, retentionMs: 60_000 });
    const ws = fakeAuthedWs("connection-1");
    const spy = servicesRecordingPartition(registry, ws);

    configure(ws, spy.services, SURFACE_A);

    expect(spy.partitionIds[0]).not.toBe("connection-1");
    expect(ws.data.conversationId).toBe(spy.partitionIds[0] as string);
    expect(ws.data.sessionId).toBe("connection-1");
  });

  it("gives a different surface its own partition", () => {
    const registry = createReplayRegistry({ maxBytesPerSurface: 1_000_000, retentionMs: 60_000 });
    const ws = fakeAuthedWs();
    const spy = servicesRecordingPartition(registry, ws);

    configure(ws, spy.services, SURFACE_A);
    configure(ws, spy.services, SURFACE_B);

    expect(spy.partitionIds[0]).not.toBe(spy.partitionIds[1] as string);
  });

  it("honours a conversationId that is scoped to this principal", () => {
    const registry = createReplayRegistry({ maxBytesPerSurface: 1_000_000, retentionMs: 60_000 });
    const ws = fakeAuthedWs();
    const spy = servicesRecordingPartition(registry, ws);

    // The id this principal was anchored to on an earlier surface.
    configure(ws, spy.services, SURFACE_B);
    const ownId = spy.partitionIds[0] as string;

    const other = fakeAuthedWs("connection-2");
    configure(other, spy.services, SURFACE_A, ownId);

    expect(spy.partitionIds[1]).toBe(ownId);
  });

  it("SECURITY: refuses a conversationId scoped to another principal", () => {
    // The store is already one DB per user, so the blast radius is bounded —
    // but a client-supplied string must never become the partition key on
    // trust alone. The presented id is accepted only when it is namespaced to
    // the AUTHENTICATED principal; anything else falls back to this
    // principal's own surface partition.
    const registry = createReplayRegistry({ maxBytesPerSurface: 1_000_000, retentionMs: 60_000 });
    const ws = fakeAuthedWs();
    const spy = servicesRecordingPartition(registry, ws);

    configure(ws, spy.services, SURFACE_A);
    const ownId = spy.partitionIds[0] as string;
    const foreignId = ownId.replace(USER_ID, OTHER_USER_ID);

    const attacker = fakeAuthedWs("connection-2");
    configure(attacker, spy.services, SURFACE_B, foreignId);

    expect(spy.partitionIds[1]).not.toBe(foreignId);
    expect(spy.partitionIds[1]).toContain(USER_ID);
    expect(spy.partitionIds[1]).not.toContain(OTHER_USER_ID);
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
function servicesTrackingRuntimes(replayRegistry: ReplayRegistry): LifecycleSpy {
  const spy: LifecycleSpy = { minted: [], services: {} as GatewayServices };
  spy.services = {
    replayRegistry,
    conversationRuntimes: createConversationRuntimeRegistry(),
    webui: { playback: { min_eager_end_ms: 0, preempt_fadeout_ms: 0 } },
    profileStore: { get: async () => ({ ok: false, error: "no profile in this test" }) },
    createSynthesizerFor: () => null,
    stt: null,
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

describe("handleSessionConfigure — one live runtime per conversation", () => {
  it("CONTRACT: a new connection on a live conversation evicts the previous connection's runtime", () => {
    const registry = createReplayRegistry({ maxBytesPerSurface: 1_000_000, retentionMs: 60_000 });
    const spy = servicesTrackingRuntimes(registry);

    const stale = fakeAuthedWs("connection-1");
    configure(stale, spy.services, SURFACE_A);
    const fresh = fakeAuthedWs("connection-2");
    configure(fresh, spy.services, SURFACE_A);

    expect(spy.minted[0]?.disposeCount).toBe(1);
    expect(stale.data.runtime).toBeNull();
    expect(stale.data.permissions).toBeNull();
    expect(spy.minted[1]?.disposeCount).toBe(0);
    expect(fresh.data.runtime).not.toBeNull();
  });

  it("leaves a live runtime on a DIFFERENT conversation alone", () => {
    const registry = createReplayRegistry({ maxBytesPerSurface: 1_000_000, retentionMs: 60_000 });
    const spy = servicesTrackingRuntimes(registry);

    const first = fakeAuthedWs("connection-1");
    configure(first, spy.services, SURFACE_A);
    const second = fakeAuthedWs("connection-2");
    configure(second, spy.services, SURFACE_B);

    expect(spy.minted[0]?.disposeCount).toBe(0);
    expect(first.data.runtime).not.toBeNull();
  });

  it("keeps the runtime a re-configure on the SAME connection just minted", () => {
    const registry = createReplayRegistry({ maxBytesPerSurface: 1_000_000, retentionMs: 60_000 });
    const spy = servicesTrackingRuntimes(registry);

    const ws = fakeAuthedWs("connection-1");
    configure(ws, spy.services, SURFACE_A);
    configure(ws, spy.services, SURFACE_A);

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
    const spy = servicesTrackingRuntimes(registry);

    const stale = fakeAuthedWs("connection-1");
    configure(stale, spy.services, SURFACE_A);
    const live = fakeAuthedWs("connection-2");
    configure(live, spy.services, SURFACE_A);

    cleanupSession(asWs(stale), spy.services);

    // The live connection is still the registered owner, so a THIRD connection
    // still evicts it — which it could not do if the stale teardown had
    // dropped the entry.
    const third = fakeAuthedWs("connection-3");
    configure(third, spy.services, SURFACE_A);
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

const STORE_ROOT = "/tmp/sentient-ws-conversation-identity-test";
mkdirSync(STORE_ROOT, { recursive: true });
afterAll(() => rmSync(STORE_ROOT, { recursive: true, force: true }));

function testOrchestratorConfig(): OrchestratorConfig {
  return {
    provider: {
      base_url: "http://localhost:0",
      model: "test-model",
      max_output_tokens: 1024,
      request_timeout_ms: 120000,
      site_name: "Sentient",
    },
    loop: { max_iterations: 4 },
    permission: { request_timeout_ms: 120000 },
    tools: { foreground_timeout_ms: 30000, max_concurrent_background_tasks: 50 },
    delegation: { frontmatter_dir: "./config/delegation", hermes_timeout_ms: 600000 },
    compaction: { enabled: false, compact_threshold_tokens: 24000, keep_recent_turns: 4 },
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

describe("handleSessionConfigure — reload rebuilds the conversation", () => {
  it("CONTRACT: a reconnect on the same surface replays the prior feed and a non-empty model projection", async () => {
    const registry = createReplayRegistry({ maxBytesPerSurface: 1_000_000, retentionMs: 60_000 });
    const accessManager = createAccessManager({ userDataRoot: `${STORE_ROOT}/reload` });
    const provider = fakeProvider("hello back");
    const services = servicesWithStoreBackedRuntime(registry, accessManager, provider);

    const first = fakeAuthedWs("connection-1");
    configure(first, services, SURFACE_A);
    const firstRuntime = first.data.runtime as SessionRuntime;
    firstRuntime.submit({ kind: "conversational", text: "remember the number 41" });
    await waitUntilIdle(firstRuntime);
    // The socket drops (reload): the runtime is disposed, the store is not.
    firstRuntime.dispose();

    const second = fakeAuthedWs("connection-2");
    configure(second, services, SURFACE_A);

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

  it("a fresh surface starts clean — no other conversation bleeds in", async () => {
    const registry = createReplayRegistry({ maxBytesPerSurface: 1_000_000, retentionMs: 60_000 });
    const accessManager = createAccessManager({ userDataRoot: `${STORE_ROOT}/fresh` });
    const provider = fakeProvider("hello back");
    const services = servicesWithStoreBackedRuntime(registry, accessManager, provider);

    const first = fakeAuthedWs("connection-1");
    configure(first, services, SURFACE_A);
    const firstRuntime = first.data.runtime as SessionRuntime;
    firstRuntime.submit({ kind: "conversational", text: "private to surface A" });
    await waitUntilIdle(firstRuntime);
    firstRuntime.dispose();

    const second = fakeAuthedWs("connection-2");
    configure(second, services, SURFACE_B);

    const snapshot = second.sent.find((f) => f.type === "conversation.snapshot");
    expect(snapshot?.items).toEqual([]);
    (second.data.runtime as SessionRuntime).dispose();
  });
});
