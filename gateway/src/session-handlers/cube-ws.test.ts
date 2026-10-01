import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inboundScanConfigSchema, orchestratorConfigSchema, riskConfigSchema } from "@sentient/config";
import type { ServerWebSocket } from "bun";
import { createAccessManager } from "../access/access-manager.js";
import type { STTAdapter, STTEvent } from "../adapters/stt/stt-adapter-types.js";
import { archiveUserDir } from "../admin/archive-user-dir.js";
import { createUserLifecycle } from "../admin/user-lifecycle.js";
import { type UserProvisionerDeps, createUserProvisioner } from "../admin/user-provisioner.js";
import { createSessionManager } from "../auth/session-manager.js";
import type { GatewayServices } from "../bootstrap/create-gateway-services.js";
import { createUserPrincipal } from "../identity/user-principal.js";
import type { ProviderClient, ProviderRequest } from "../provider/provider-client.js";
import type { SessionRuntimeRequest } from "../runtime/session-handles.js";
import { createSessionPermissionBroker } from "../runtime/session-permission-broker.js";
import { type SessionRuntime, createSessionRuntime } from "../runtime/session-runtime.js";
import { createInboundGate } from "../security/inbound-gate.js";
import { createRiskAccumulator } from "../security/risk-accumulator.js";
import { openSessionStore } from "../store/session-store.js";
import { composeBackgroundCompletionNote } from "../tools/background-completion-note.js";
import { createToolBroker } from "../tools/tool-broker.js";
import type { TextStreamSynthesizer } from "../tts/text-stream-synthesizer.js";
import type { AuthService } from "../user-auth/auth-service.js";
import { createCredentialFloor } from "../user-auth/credential-floor.js";
import { type DeviceProof, createDeviceRegistry } from "../user-auth/device-registry.js";
import { createTokenService } from "../user-auth/token-service.js";
import { createUserStore } from "../user-auth/user-store.js";
import { createAuthenticatedSockets } from "./authenticated-sockets.js";
import { retireCubeExecutions } from "./cube-lifecycle.js";
import { createReplayRegistry } from "./replay-registry.js";
import { finishSessionDeletion } from "./session-deletion.js";
import { createSessionRegistry } from "./session-registry.js";
import { handleWebSocketMessage } from "./ws-handlers.js";
import { type SessionData, createEmptySessionData } from "./ws-helpers.js";

function value<T>(r: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!r.ok) throw new Error(r.error);
  return r.value;
}
async function until(check: () => boolean) {
  for (let n = 0; n < 400; n++) {
    if (check()) return;
    await Bun.sleep(5);
  }
  throw new Error("synthetic boundary did not settle");
}
function channel() {
  const queued: STTEvent[] = [];
  let deliver: ((event: STTEvent | null) => void) | null = null;
  let stopped = false;
  let bytes = 0;
  const adapter: STTAdapter = {
    async open() {},
    send(frame) {
      bytes += frame.byteLength;
    },
    endUtterance() {},
    setTurnMode() {},
    suppressInputFor() {},
    async close() {
      stopped = true;
      deliver?.(null);
    },
    async *events() {
      while (!stopped) {
        const event =
          queued.shift() ??
          (await new Promise<STTEvent | null>((resolve) => {
            deliver = resolve;
          }));
        if (!event) return;
        yield event;
      }
    },
  };
  return {
    adapter,
    get bytes() {
      return bytes;
    },
    emit(event: STTEvent) {
      if (deliver) {
        const send = deliver;
        deliver = null;
        send(event);
      } else queued.push(event);
    },
  };
}
const owner = createUserPrincipal("u_00000001", "adult", "home");
const config = orchestratorConfigSchema.parse({
  provider: { model: "synthetic" },
  tools: {},
  delegation: {},
  memory: { enabled: false },
  auxiliary: { enabled: false },
  compaction: { enabled: false },
});
let root: string;
let previousRoot: string | undefined;
let services: GatewayServices;
let users: ReturnType<typeof createUserStore>;
let registry: ReturnType<typeof createDeviceRegistry>;
let runtimeRequests: SessionRuntimeRequest[];
let runtimes: SessionRuntime[];
let brokers: ReturnType<typeof createToolBroker>[];
let stores: ReturnType<typeof openSessionStore>[];
let calls: ProviderRequest[];
let pause: Promise<void> | null;
let audio: ReturnType<typeof channel>;
let synthCalls: number;
let toolCalls: number;
let backgroundResult: Promise<{ content: string; isError: boolean }>;
let completions: number;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "cube-ws-"));
  previousRoot = process.env.SENTIENT_GATEWAY_ROOT;
  process.env.SENTIENT_GATEWAY_ROOT = root;
  users = createUserStore();
  value(
    await users.add({
      userId: owner.userId,
      role: owner.role,
      displayName: "Synthetic",
      pinHash: "unused",
      avatarTint: "sage",
      createdAt: new Date().toISOString(),
      credentialsValidFrom: "1970-01-01T00:00:00.000Z",
    }),
  );
  const accessManager = createAccessManager({ userDataRoot: root });
  mkdirSync(accessManager.userHomeDir(owner), { recursive: true });
  const sessionRegistry = createSessionRegistry();
  const authenticatedSockets = createAuthenticatedSockets();
  const key = randomBytes(32);
  const retire = (principal: typeof owner) =>
    retireCubeExecutions({ accessManager, sessionRegistry, authenticatedSockets }, principal);
  registry = createDeviceRegistry({
    path: join(root, "devices.db"),
    users,
    accessKey: key,
    escrowKey: randomBytes(32),
    accessTtlSeconds: 604800,
    attemptTtlSeconds: 60,
    onRetire: retire,
  });
  users.onAuthorityChanging?.((user) => registry.retireOwner(createUserPrincipal(user.userId, user.role, "home")));
  calls = [];
  runtimeRequests = [];
  runtimes = [];
  brokers = [];
  stores = [];
  pause = null;
  synthCalls = 0;
  toolCalls = 0;
  completions = 0;
  backgroundResult = new Promise(() => {});
  audio = channel();
  const provider: ProviderClient = {
    async *stream(request) {
      calls.push(request);
      if (pause) await pause; // Ignores abort deliberately: buffered external results can arrive late.
      yield { type: "text", content: "synthetic answer" };
      yield { type: "done", finishReason: "stop" };
    },
  };
  const auth = {
    users,
    tokens: createTokenService({ secret: key, ttlSeconds: 604800, credentialFloor: createCredentialFloor(users) }),
  } as AuthService;
  services = {
    accessManager,
    auth,
    devices: registry,
    sessionRegistry,
    authenticatedSockets,
    cubeDreamerHour: 3,
    sessionManager: createSessionManager({ maxSessions: 50 }),
    replayRegistry: createReplayRegistry({ maxBytesPerSession: 65536, retentionMs: 60000 }),
    session: { max_window_lag_bytes: 1000000, input_arbitration_window_ms: 0 },
    webui: { playback: { min_eager_end_ms: 3000, preempt_fadeout_ms: 30 } },
    profileStore: {
      get: async () => ({ ok: true, value: { audio: { ttsEnabled: false, channel: "text" }, voice: { id: "test" } } }),
    },
    createSynthesizerFor: (): TextStreamSynthesizer => ({
      async *synthesize(stream, signal) {
        synthCalls++;
        for await (const _chunk of stream) {
          if (signal.aborted) return;
          yield { data: new Uint8Array([0]), encoding: "opus", sampleRate: 24000 };
        }
      },
    }),
    stt: {
      adapterFactory: () => audio.adapter,
      adapterConfig: {
        url: "ws://localhost:0",
        language: "auto",
        pauseRenderLanguage: "en",
        inputSampleRate: 48000,
        ttsEchoCooldownMs: 0,
        connectTimeoutMs: 10,
        audioFormat: "opus",
      },
    },
    createSessionRuntime(request: SessionRuntimeRequest) {
      runtimeRequests.push(request);
      const store = openSessionStore(accessManager.grant(request.principal, "session-store"));
      stores.push(store);
      const permissions = createSessionPermissionBroker({
        emitter: request.emitter,
        sessionId: request.conversationId,
        userId: owner.userId,
        attachedWindows: request.attachedWindows,
      });
      const inboundGate = createInboundGate(
        inboundScanConfigSchema.parse({}),
        createRiskAccumulator(riskConfigSchema.parse({})),
      );
      const broker = createToolBroker({
        inboundGate,
        mcp: {
          listTools: async () => [],
          callTool: async () => {
            throw new Error("no MCP");
          },
          close: async () => {},
        },
        store,
        capability: accessManager.grant(request.principal, "tool-broker"),
        catalog: {},
        sessionId: request.conversationId,
        config: config.tools,
        backgroundTools: new Map([
          [
            "deferred",
            {
              definition: {
                name: "deferred",
                description: "test",
                parameters: {},
                category: "background",
                tier: "read",
              },
              run: () => ({ cancel() {}, result: backgroundResult }),
            },
          ],
        ]),
        requestConfirm: async () => false,
        toolPermissions: async () => ({ cube: { probe: "allow", deferred: "allow" } }),
        authorizeExecution: async () => (request.deviceCredential ? request.deviceCredential.current() : true),
        executionAllowed: () =>
          store.getSessionExecutionStatus(request.conversationId) === "open" &&
          (request.deviceCredential?.live() ?? true),
        nativeTools: new Map([
          [
            "probe",
            {
              definition: { name: "probe", description: "test", parameters: {}, category: "foreground", tier: "read" },
              run: async () => {
                toolCalls++;
                return { content: "test", isError: false };
              },
            },
          ],
        ]),
      });
      brokers.push(broker);
      const runtime = createSessionRuntime({
        principal: request.principal,
        ...(request.deviceCredential ? { deviceCredential: request.deviceCredential } : {}),
        sessionId: request.conversationId,
        accessManager,
        provider,
        broker,
        emitter: request.emitter,
        voice: request.voice ?? null,
        config,
        timeZone: { zone: () => "UTC" },
        systemPrompt: "test",
      });
      broker.setBackgroundCompletionSink((result) => {
        const note = composeBackgroundCompletionNote({
          ...result,
          output: result.content,
          inboundGate,
          requestEchoChars: config.tools.background_completion_request_echo_chars,
          sessionId: request.conversationId,
        });
        runtime.submit({ kind: "background-completion", note });
        completions++;
      });
      runtimes.push(runtime);
      return {
        runtime,
        permissions,
        work: {
          get isTurnInFlight() {
            return runtime.running;
          },
          hasPendingForegroundTool: false,
          hasOutstandingPrompt: false,
          hasAuxiliaryTaskInFlight: false,
          newestBackgroundTaskStartedAtMs: null,
        },
      };
    },
  } as unknown as GatewayServices;
});
afterEach(async () => {
  await audio.adapter.close();
  for (const runtime of runtimes) runtime.dispose();
  for (const store of stores) store.close();
  registry.close();
  if (previousRoot === undefined) {
    // biome-ignore lint/performance/noDelete: restore environment
    delete process.env.SENTIENT_GATEWAY_ROOT;
  } else process.env.SENTIENT_GATEWAY_ROOT = previousRoot;
  rmSync(root, { recursive: true, force: true });
});
const secret = () => randomBytes(32).toString("base64url");
async function enroll() {
  const input = {
    version: 1 as const,
    deviceId: randomUUID(),
    attemptId: randomUUID(),
    enrollmentSecret: secret(),
    managerSecret: secret(),
  };
  const begun = value(await registry.begin(services.accessManager.grant(owner, "device-registry"), input));
  const proof: DeviceProof = {
    version: 1,
    deviceId: input.deviceId,
    attemptId: input.attemptId,
    generation: begun.generation,
    renewalSecret: secret(),
  };
  value(await registry.redeem({ ...proof, enrollmentSecret: input.enrollmentSecret }));
  return { input, proof, token: value(await registry.activate(proof)).token };
}
function socket() {
  const data = createEmptySessionData();
  data.sessionId = value(services.sessionManager.createSession()).sessionId;
  const frames: Array<Record<string, unknown>> = [];
  const closes: number[] = [];
  const ws = {
    data,
    readyState: 1,
    getBufferedAmount: () => 0,
    send(frame: string | Uint8Array) {
      if (typeof frame === "string") frames.push(JSON.parse(frame));
    },
    close(code: number) {
      closes.push(code);
    },
  } as unknown as ServerWebSocket<SessionData>;
  return { ws, frames, closes, route: (frame: unknown) => handleWebSocketMessage(ws, JSON.stringify(frame), services) };
}
async function connect(token: string, conversationId?: string) {
  const conn = socket();
  await conn.route({ type: "auth", token });
  await conn.route({
    type: "session.configure",
    capabilities: { supports: ["text", "audio"] },
    clientType: "webui",
    deviceId: "spoofed-metadata",
    surfaceId: "spoofed-surface",
    conversationId,
  });
  return conn;
}
function store() {
  return openSessionStore(services.accessManager.grant(owner, "session-store"));
}
async function text(conn: ReturnType<typeof socket>, pendingId: string = randomUUID()) {
  await conn.route({ type: "text.input", text: "synthetic input", pendingId });
}

function provisioner(archive = archiveUserDir) {
  return createUserProvisioner({
    userStore: users,
    archiveUserDir: archive,
    userLifecycle: createUserLifecycle(),
  } as UserProvisionerDeps);
}

describe("native Cube WS integration", () => {
  for (const failure of ["synthesizer", "construction"] as const) {
    it(`${failure} failure reports unavailable after durable input; replay never executes twice`, async () => {
      const device = await enroll();
      const conn = await connect(device.token);
      const original = services;
      services =
        failure === "synthesizer"
          ? { ...services, createSynthesizerFor: () => null }
          : {
              ...services,
              createSessionRuntime: () => {
                throw new Error("synthetic internal detail");
              },
            };
      await text(conn, "failed-input");
      expect(conn.frames.filter((frame) => frame.type === "error")).toContainEqual(
        expect.objectContaining({ code: "orchestrator_unavailable" }),
      );
      expect(JSON.stringify(conn.frames)).not.toContain("synthetic internal detail");
      const db = store();
      const id = db.getCurrentCubeSessionId() ?? "";
      expect(db.readSession(id).filter((entry) => entry.kind === "user")).toHaveLength(1);
      expect(calls).toHaveLength(0);
      services = original;
      await text(conn, "failed-input");
      expect(calls).toHaveLength(0);
      await text(conn, "fresh-input");
      await until(() => calls.length === 1 && !runtimes.at(-1)?.running);
      expect(db.readSession(id).filter((entry) => entry.kind === "user")).toHaveLength(2);
      db.close();
    });
  }

  it("provisioner retires resident and dormant original stores before real archive, without recreating home", async () => {
    const device = await enroll();
    const conn = await connect(device.token);
    await text(conn);
    await until(() => calls.length === 1 && !runtimes[0]?.running);
    const db = store();
    const id = conn.ws.data.conversationId ?? "";
    const entry = db.readSession(id)[0];
    if (!entry) throw new Error("missing input");
    const dormant = db.admitCubeInput({
      inputId: randomUUID(),
      expectedFence: db.getCubeAdmissionFence(),
      now: Date.now() + 86400000,
      dreamerHour: 3,
      entry,
    });
    if (dormant.status !== "accepted") throw new Error("missing dormant session");
    value(
      await provisioner(async (userId) => {
        expect(db.getSessionExecutionStatus(id)).toBe("closed");
        expect(db.getSessionExecutionStatus(dormant.sessionId)).toBe("closed");
        expect(runtimes[0]?.executionAvailable).toBe(false);
        expect(value(await users.get(userId))).toBeNull();
        return archiveUserDir(userId);
      }).deleteUser(owner.userId),
    );
    db.close();
    expect(existsSync(join(root, owner.userId))).toBe(false);
    const archived = readdirSync(join(root, "_archive"))[0];
    if (!archived) throw new Error("missing archive");
    const archiveAccess = createAccessManager({ userDataRoot: join(root, "_archive") });
    // Archive name is a filesystem location, not a new owner identity.
    const cap = { ...archiveAccess.grant(owner, "session-store"), rootPath: join(root, "_archive", archived) };
    const saved = openSessionStore(cap);
    expect(saved.getSessionExecutionStatus(id)).toBe("closed");
    expect(saved.getSessionExecutionStatus(dormant.sessionId)).toBe("closed");
    expect(saved.readSession(id).length).toBeGreaterThan(0);
    saved.close();
    expect(value(await users.get(owner.userId))).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("retirement failure prevents archive/account mutation; archive failure preserves account", async () => {
    await enroll();
    let archives = 0;
    const admin = provisioner(async () => {
      archives++;
      return { ok: false, error: "io-error" };
    });
    expect(await admin.deleteUser(owner.userId)).toEqual({ ok: false, error: "io-error" });
    expect(value(await users.get(owner.userId))).not.toBeNull();
    expect(existsSync(join(root, owner.userId))).toBe(true);
    users.onAuthorityChanging?.(() => {
      throw new Error("retirement failed");
    });
    expect(await admin.deleteUser(owner.userId)).toEqual({ ok: false, error: "io-error" });
    expect(archives).toBe(1);
    expect(value(await users.get(owner.userId))).not.toBeNull();
  });

  for (const change of ["revoke", "delete", "account-delete", "expire", "live"] as const) {
    it(`real deferred broker completion after ${change} cannot leak into replacement execution`, async () => {
      let release!: (result: { content: string; isError: boolean }) => void;
      backgroundResult = new Promise((resolve) => {
        release = resolve;
      });
      const device = await enroll();
      const conn = await connect(device.token);
      await text(conn);
      await until(() => calls.length === 1 && !runtimes[0]?.running);
      const broker = brokers[0];
      const id = conn.ws.data.conversationId ?? "";
      const db = store();
      expect(
        await broker?.dispatch({
          toolCallId: "deferred",
          name: "deferred",
          args: {},
          signal: new AbortController().signal,
          turnId: "synthetic",
        }),
      ).toHaveProperty("taskId");
      expect(broker?.background.count()).toBe(1);
      if (change === "revoke") {
        const other = await enroll();
        value(await registry.disable(services.accessManager.grant(owner, "device-registry"), device.input.deviceId));
        const fresh = await connect(other.token);
        await text(fresh);
        expect(fresh.ws.data.conversationId).not.toBe(id);
      } else if (change === "delete") {
        db.deleteSession(id);
        finishSessionDeletion(services, owner, id);
        await text(conn);
        expect(conn.ws.data.conversationId).not.toBe(id);
      } else if (change === "account-delete") {
        value(await provisioner().deleteUser(owner.userId));
      } else if (change === "expire") {
        const clock = spyOn(Date, "now").mockReturnValue((conn.ws.data.tokenExpiresAtMs ?? 0) + 1);
        try {
          expect(runtimes[0]?.executionAvailable).toBe(false);
        } finally {
          clock.mockRestore();
        }
        const token = value(await registry.renew(device.proof)).token;
        if (!token) throw new Error("missing renewal");
        const fresh = await connect(token);
        await text(fresh);
        expect(fresh.ws.data.conversationId).toBe(id);
        expect(runtimes.at(-1)).not.toBe(runtimes[0]);
      }
      await until(() => !runtimes.at(-1)?.running);
      const before = db.listSessions().map((session) => db.readSession(session.sessionId));
      const beforeCalls = calls.length;
      release({ content: "synthetic deferred result", isError: false });
      await until(() => completions === 1 && runtimes.every((runtime) => !runtime.running));
      expect(broker?.background.count()).toBe(0);
      if (change === "live") {
        expect(calls).toHaveLength(beforeCalls + 1);
        expect(db.readSession(id).filter((entry) => entry.kind === "trigger")).toHaveLength(1);
      } else {
        expect(calls).toHaveLength(beforeCalls);
        expect(db.listSessions().map((session) => db.readSession(session.sessionId))).toEqual(before);
      }
      if (change === "account-delete") expect(existsSync(join(root, owner.userId))).toBe(false);
      db.close();
    });
  }

  it("registry grant drives real native turn and mandatory TTS despite human text preferences; retry/reconnect do not duplicate", async () => {
    const device = await enroll();
    const conn = await connect(device.token);
    const db = store();
    expect(db.listSessions()).toHaveLength(0);
    expect(conn.ws.data.principal?.origin).toEqual({ kind: "cube", deviceId: device.input.deviceId, generation: 1 });
    expect(Object.isFrozen(conn.ws.data.principal)).toBe(true);
    const duplicate = await connect(device.token);
    await Promise.all([text(conn, "same-input"), text(duplicate, "same-input")]);
    await until(() => calls.length === 1 && !runtimes[0]?.running && synthCalls > 0);
    const id = conn.ws.data.conversationId;
    expect(id).toMatch(/^s_[0-9a-f]{32}$/);
    expect(runtimeRequests[0]?.principal).toBe(conn.ws.data.principal ?? undefined);
    expect(await runtimeRequests[0]?.audioPolicy?.shouldSpeak()).toBe(true);
    expect(db.getSession(id ?? "")?.provenance).toBe("cube");
    expect(db.readSession(id ?? "").filter((entry) => entry.kind === "user")).toHaveLength(1);
    await text(conn, "same-input");
    // Process-restart equivalent: dispose transport/runtime state, retain the database.
    services.sessionRegistry.disposeDeletedSession(owner.userId, id ?? "");
    const reconnected = await connect(device.token, "s_untrusted_anchor");
    expect(reconnected.ws.data.runtime).toBeNull();
    await text(reconnected, "same-input");
    expect(calls).toHaveLength(1);
    expect(db.listSessions()).toHaveLength(1);
    await text(reconnected, "next-input");
    await until(() => calls.length === 2 && !runtimes[0]?.running);
    expect(reconnected.ws.data.conversationId).toBe(id);
    db.close();
  });

  it("voice-first draft uses real STT admission and speaks with muted profile", async () => {
    const device = await enroll();
    const conn = await connect(device.token);
    // Native mic frames can immediately follow start; authorization must not
    // await a file read and lose the opening frames before capture exists.
    const starting = conn.route({ type: "audio.start", captureId: "voice", turnMode: "manual" });
    expect(conn.ws.data.audioCapture?.id).toBe("voice");
    await starting; // Let the existing asynchronous STT adapter connect.
    await handleWebSocketMessage(conn.ws, Buffer.from([1, 2]), services);
    await conn.route({ type: "audio.end", captureId: "voice" });
    audio.emit({ type: "transcript", turnIdx: 1, text: "synthetic voice" });
    await until(() => calls.length === 1 && !runtimes[0]?.running && synthCalls > 0);
    expect(audio.bytes).toBe(2);
    const db = store();
    expect(db.readSession(conn.ws.data.conversationId ?? "").filter((entry) => entry.kind === "user")).toHaveLength(1);
    db.close();
  });

  for (const change of ["disable", "role", "delete"] as const) {
    it(`${change} closes shared stores, sockets, late turns and dispatch; stale tokens cannot mint replacement`, async () => {
      const first = await enroll();
      const second = await enroll();
      const a = await connect(first.token);
      const b = await connect(second.token);
      let release!: () => void;
      pause = new Promise<void>((resolve) => {
        release = resolve;
      });
      await text(a);
      await until(() => calls.length === 1);
      const id = a.ws.data.conversationId ?? "";
      await text(b);
      const original = runtimes[0];
      const db = store();
      const entry = db.readSession(id)[0];
      if (!entry) throw new Error("missing initial entry");
      const dormant = db.admitCubeInput({
        inputId: randomUUID(),
        expectedFence: db.getCubeAdmissionFence(),
        dreamerHour: 3,
        now: Date.now() + 86400000,
        entry,
      });
      if (dormant.status !== "accepted") throw new Error("missing dormant session");
      const invocation = {
        toolCallId: "probe",
        name: "probe",
        args: {},
        signal: new AbortController().signal,
        turnId: "test",
      };
      expect(await brokers[0]?.dispatch(invocation)).toEqual({ content: "test", isError: false });
      const originalGet = users.get.bind(users);
      let lookups = 0;
      let releasePolicy!: () => void;
      let policyWaiting = false;
      const lookup = spyOn(users, "get").mockImplementation(async (userId) => {
        const result = await originalGet(userId);
        if (++lookups === 1) {
          policyWaiting = true;
          await new Promise<void>((resolve) => {
            releasePolicy = resolve;
          });
        }
        return result;
      });
      const racingDispatch = brokers[0]?.dispatch(invocation);
      await until(() => policyWaiting);
      if (change === "disable")
        value(await registry.disable(services.accessManager.grant(owner, "device-registry"), first.input.deviceId));
      if (change === "role") value(await users.update(owner.userId, { role: "child" }));
      if (change === "delete") value(await users.remove(owner.userId));
      releasePolicy();
      expect(await racingDispatch).toEqual({ content: "Session execution is closed", isError: true });
      lookup.mockRestore();
      expect(a.closes).toContain(1008);
      expect(b.closes).toContain(1008);
      expect(db.getSessionExecutionStatus(id)).toBe("closed");
      expect(db.getSessionExecutionStatus(dormant.sessionId)).toBe("closed");
      expect(await brokers[0]?.dispatch(invocation)).toEqual({ content: "Session execution is closed", isError: true });
      original?.submit({ kind: "background-completion", note: "late synthetic result" });
      release();
      pause = null;
      await until(() => !original?.running);
      expect(toolCalls).toBe(1);
      expect(db.readSession(id).filter((entry) => entry.kind === "assistant")).toHaveLength(0);
      const rejected = await connect(first.token, id);
      expect(rejected.ws.data.authState).toBe("rejected");
      await text(rejected);
      expect(db.listSessions()).toHaveLength(2);
      expect(calls).toHaveLength(1);
      if (change === "disable") {
        const fresh = await connect(second.token, id);
        await text(fresh);
        await until(() => calls.length === 2);
        expect(fresh.ws.data.conversationId).not.toBe(id);
      }
      db.close();
    });
  }

  it("active turn stays across daily boundary; next idle input rolls, without replay forking history", async () => {
    const device = await enroll();
    const conn = await connect(device.token);
    const boundary = new Date();
    boundary.setDate(boundary.getDate() + 1);
    boundary.setHours(3, 0, 0, 0);
    const clock = spyOn(Date, "now").mockReturnValue(boundary.getTime() - 1);
    let release!: () => void;
    try {
      pause = new Promise<void>((resolve) => {
        release = resolve;
      });
      await text(conn, "before");
      await until(() => calls.length === 1);
      const original = conn.ws.data.conversationId;
      clock.mockReturnValue(boundary.getTime() + 1);
      await text(conn, "steering");
      expect(conn.ws.data.conversationId).toBe(original);
      release();
      pause = null;
      await until(() => !runtimes[0]?.running);
      const beforeRollover = calls.length;
      await text(conn, "after");
      await until(() => calls.length === beforeRollover + 1 && !runtimes.at(-1)?.running);
      expect(conn.ws.data.conversationId).not.toBe(original);
      await text(conn, "before");
      const db = store();
      expect(db.listSessions()).toHaveLength(2);
      db.close();
      expect(calls).toHaveLength(beforeRollover + 1);
    } finally {
      release?.();
      clock.mockRestore();
    }
  });
  it("human tokens cannot choose Cube authority or mutate Cube history, while ordinary chat still works", async () => {
    const device = await enroll();
    const cube = await connect(device.token);
    await text(cube);
    await until(() => !runtimes[0]?.running);
    const id = cube.ws.data.conversationId;
    const token = await services.auth.tokens.issue({ userId: owner.userId });
    const human = socket();
    await human.route({
      type: "auth",
      token,
      origin: { kind: "cube", deviceId: device.input.deviceId, generation: 1 },
    });
    expect(human.ws.data.principal?.origin).toBeUndefined();
    await human.route({
      type: "session.configure",
      capabilities: { supports: ["text"] },
      clientType: "cube",
      deviceId: device.input.deviceId,
      conversationId: id,
    });
    expect(human.closes).toContain(1008);
    for (const frame of [
      { type: "text.input", text: "denied", pendingId: "denied" },
      { type: "audio.start" },
      { type: "interrupt" },
      { type: "permission.response", requestId: "denied", approved: true },
      { type: "session.new" },
    ])
      await human.route(frame);
    expect(calls).toHaveLength(1);
    const ordinary = await connect(token);
    await text(ordinary);
    await until(() => calls.length === 2 && !runtimes.at(-1)?.running);
    expect(ordinary.ws.data.principal?.origin).toBeUndefined();
    expect(await runtimeRequests.at(-1)?.audioPolicy?.shouldSpeak()).toBe(false);
    const db = store();
    expect(db.getSession(ordinary.ws.data.conversationId ?? "")?.provenance).toBe("human");
    expect(db.readSession(id ?? "").filter((entry) => entry.kind === "user")).toHaveLength(1);
    db.close();
  });

  it("a captured admission fence cannot mint after history deletion, even when delayed owner lookup succeeds", async () => {
    const device = await enroll();
    const conn = await connect(device.token);
    await text(conn);
    await until(() => calls.length === 1 && !runtimes[0]?.running);
    const id = conn.ws.data.conversationId ?? "";
    const originalGet = users.get.bind(users);
    let release!: () => void;
    let waiting = false;
    const lookup = spyOn(users, "get").mockImplementation(async (userId) => {
      const result = await originalGet(userId);
      waiting = true;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return result;
    });
    const delayed = text(conn, "delayed");
    await until(() => waiting);
    const db = store();
    db.deleteSession(id); // Keep socket draft key unchanged to specifically test the durable fence.
    release();
    await delayed;
    lookup.mockRestore();
    expect(db.listSessions()).toHaveLength(0);
    expect(calls).toHaveLength(1);
    runtimes[0]?.submit({ kind: "background-completion", note: "late" });
    finishSessionDeletion(services, owner, id);
    await text(conn, "fresh");
    await until(() => calls.length === 2);
    expect(conn.ws.data.conversationId).not.toBe(id);
    expect(db.getSessionExecutionStatus(id)).toBe("deleted");
    db.close();
  });

  it("PIN updates preserve device access; generation change and expiration do not", async () => {
    const device = await enroll();
    const conn = await connect(device.token);
    value(await users.update(owner.userId, { pinHash: "changed", credentialsValidFrom: new Date().toISOString() }));
    await text(conn);
    await until(() => calls.length === 1 && !runtimes[0]?.running);
    value(await registry.disable(services.accessManager.grant(owner, "device-registry"), device.input.deviceId));
    const nextInput = { ...device.input, attemptId: randomUUID(), enrollmentSecret: secret() };
    const begun = value(await registry.begin(services.accessManager.grant(owner, "device-registry"), nextInput));
    const proof = {
      ...device.proof,
      attemptId: nextInput.attemptId,
      generation: begun.generation,
      renewalSecret: secret(),
    };
    value(await registry.redeem({ ...proof, enrollmentSecret: nextInput.enrollmentSecret }));
    const renewed = value(await registry.activate(proof));
    const old = await connect(device.token);
    expect(old.closes).toContain(1008);
    const fresh = await connect(renewed.token);
    expect(fresh.ws.data.principal?.origin?.generation).toBe(2);
    await text(fresh);
    await until(() => calls.length === 2 && !runtimes.at(-1)?.running);
    const expires = fresh.ws.data.tokenExpiresAtMs ?? 0;
    const clock = spyOn(Date, "now").mockReturnValue(expires + 1);
    try {
      await text(fresh);
      expect(fresh.closes).toContain(1008);
      expect(runtimes.at(-1)?.executionAvailable).toBe(false);
      runtimes.at(-1)?.submit({ kind: "background-completion", note: "expired" });
      expect(calls).toHaveLength(2);
    } finally {
      clock.mockRestore();
    }
    const oldId = fresh.ws.data.conversationId;
    const renewedToken = value(await registry.renew(proof)).token;
    if (!renewedToken) throw new Error("renewal failed");
    const resumed = await connect(renewedToken);
    await text(resumed);
    await until(() => calls.length === 3);
    expect(resumed.ws.data.conversationId).toBe(oldId);
  });

  it("renewal resumes the open daily store but expired runtime cannot write buffered results into its replacement", async () => {
    const device = await enroll();
    const old = await connect(device.token);
    let release!: () => void;
    pause = new Promise<void>((resolve) => {
      release = resolve;
    });
    await text(old);
    await until(() => calls.length === 1);
    const oldRuntime = runtimes[0];
    const id = old.ws.data.conversationId;
    const clock = spyOn(Date, "now").mockReturnValue((old.ws.data.tokenExpiresAtMs ?? 0) + 1);
    try {
      expect(oldRuntime?.executionAvailable).toBe(false);
    } finally {
      clock.mockRestore();
    }
    pause = null;
    const token = value(await registry.renew(device.proof)).token;
    if (!token) throw new Error("renewal failed");
    const fresh = await connect(token);
    await text(fresh);
    await until(() => calls.length === 2 && !runtimes.at(-1)?.running);
    expect(fresh.ws.data.conversationId).toBe(id);
    expect(runtimes.at(-1)).not.toBe(oldRuntime);
    release();
    await until(() => !oldRuntime?.running);
    oldRuntime?.submit({ kind: "background-completion", note: "late expired completion" });
    const db = store();
    expect(db.getSessionExecutionStatus(id ?? "")).toBe("open");
    expect(db.readSession(id ?? "").filter((entry) => entry.kind === "assistant")).toHaveLength(1);
    expect(db.readSession(id ?? "").filter((entry) => entry.kind === "trigger")).toHaveLength(0);
    expect(calls).toHaveLength(2);
    db.close();
  });
  it("owner mutation fences first enrollment holding a stale owner snapshot", async () => {
    const originalGet = users.get.bind(users);
    let release!: () => void;
    let waiting = false;
    const lookup = spyOn(users, "get").mockImplementation(async (userId) => {
      const result = await originalGet(userId);
      waiting = true;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return result;
    });
    const pending = registry.begin(services.accessManager.grant(owner, "device-registry"), {
      version: 1,
      deviceId: randomUUID(),
      attemptId: randomUUID(),
      enrollmentSecret: secret(),
      managerSecret: secret(),
    });
    await until(() => waiting);
    value(await users.update(owner.userId, { role: "child" }));
    release();
    expect(await pending).toEqual({ ok: false, error: "denied" });
    lookup.mockRestore();
    expect(
      value(
        await registry.list(
          services.accessManager.grant(createUserPrincipal(owner.userId, "child", "home"), "device-registry"),
        ),
      ),
    ).toHaveLength(0);
  });
});
