import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthConfig } from "@sentient/config";
import { gatewayMessageSchema } from "@sentient/protocol";
import type { ServerWebSocket } from "bun";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type SessionManager, createSessionManager } from "../auth/session-manager.js";
import type { AuthService } from "../user-auth/auth-service.js";
import { createAuthService } from "../user-auth/auth-service.js";
import type { TokenPayload, TokenResult, UserRecord, UserStoreError } from "../user-auth/types.js";
import { handleAuthMessage, scheduleAuthTimeout } from "./ws-auth-gate.js";
import type { SessionData } from "./ws-helpers.js";

const AUTH_CONFIG: AuthConfig = {
  token_ttl_seconds: 3600,
  ws_auth_timeout_ms: 5000,
  argon2_memory_kb: 8192,
  argon2_iterations: 1,
  argon2_parallelism: 1,
};

interface FakeWs {
  data: SessionData;
  sent: unknown[];
  closeCode: number | null;
  send: (s: string) => void;
  close: (code: number, reason?: string) => void;
}

function fakeWs(): FakeWs {
  const data: SessionData = {
    sessionId: "test-session",
    conversationId: null,
    draftKey: null,
    authState: "pending",
    principal: null,
    authTimeout: null,
    grantedCapabilities: new Set(),
    clientType: "webui",
    attachment: null,
    runtime: null,
    permissions: null,
    stt: null,
    voicePrefs: null,
    journal: null,
    epoch: 0,
    replayLease: null,
  };
  const ws: FakeWs = {
    data,
    sent: [],
    closeCode: null,
    send(s) {
      ws.sent.push(JSON.parse(s));
    },
    close(code) {
      ws.closeCode = code;
    },
  };
  return ws;
}

/**
 * The auth gate is typed on the real Bun socket because it writes through
 * `sendGatewayFrame`, which reads `ws.data.journal` / `ws.data.epoch`. The fake
 * carries exactly the members that path touches; the cast is the deliberate
 * cost of typing on the transport instead of on a second structural stand-in.
 */
function asSocket(ws: FakeWs): ServerWebSocket<SessionData> {
  return ws as unknown as ServerWebSocket<SessionData>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Minimal AuthService double for the two atomicity/revival tests below, where
 * we need to control exactly when `tokens.validate` / `users.get` settle.
 * Every member not passed in throws if called, so an unwired path fails loud.
 */
function buildFakeAuth(opts: {
  validate: (token: string) => Promise<TokenResult<TokenPayload>>;
  getUser: (userId: string) => Promise<{ ok: true; value: UserRecord | null } | { ok: false; error: UserStoreError }>;
}): AuthService {
  const unused = async (): Promise<never> => {
    throw new Error("buildFakeAuth: this member was not wired for this test");
  };
  return {
    tokens: {
      validate: opts.validate,
      issue: async () => "unused-token",
      refresh: unused,
    },
    users: {
      get: opts.getUser,
      list: async () => ({ ok: true, value: [] }),
      add: async () => ({ ok: true, value: undefined }),
      update: async () => ({ ok: true, value: undefined }),
      remove: async () => ({ ok: true, value: undefined }),
    },
    config: AUTH_CONFIG,
    createUser: unused,
    authenticate: unused,
    listUsersPublic: async () => ({ ok: true, value: [] }),
    isFirstRun: async () => false,
    updateDisplayName: unused,
    changePin: unused,
  };
}

describe("ws auth gate", () => {
  let root: string;
  // Unlimited session manager for tests that don't exercise the per-user cap.
  const sessionManager = createSessionManager();

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sentient-wsg-"));
    process.env.SENTIENT_GATEWAY_ROOT = root;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    // biome-ignore lint/performance/noDelete: delete is the correct way to unset a process.env key
    delete process.env.SENTIENT_GATEWAY_ROOT;
  });

  it("authes the WS on a valid token, mints a frozen principal, sends auth.ok", async () => {
    const auth = await createAuthService(AUTH_CONFIG);
    await auth.createUser({
      userId: "u_a1b2c3d4",
      displayName: "Kevin",
      pin: "1234",
      isAdmin: true,
      avatarTint: "terra",
    });
    const r = await auth.authenticate("u_a1b2c3d4", "1234");
    if (!r.ok) throw new Error("seed failed");

    const ws = fakeWs();
    await handleAuthMessage(asSocket(ws), { type: "auth", token: r.value.token }, auth, sessionManager);
    expect(ws.data.authState).toBe("authed");
    expect(ws.data.principal?.userId).toBe("u_a1b2c3d4");
    expect(ws.data.principal?.role).toBe("adult");
    expect(ws.data.principal?.householdId).toBe("home");
    expect(Object.isFrozen(ws.data.principal)).toBe(true);
    expect(ws.sent).toEqual([
      {
        type: "auth.ok",
        user: { userId: "u_a1b2c3d4", displayName: "Kevin", isAdmin: true, avatarTint: "terra" },
      },
    ]);
    expect(ws.closeCode).toBeNull();
  });

  // CONTRACT (branch Global Constraint: every outbound frame is constructed and
  // validated through `gatewayMessageSchema`). Both halves matter: if the
  // schema and the sent shape drift apart again, `sendGatewayFrame` DROPS the
  // frame rather than writing it, and a client with no auth ack hangs at
  // connect — so "a frame was sent" and "it parses" are asserted together.
  it("CONTRACT: auth.ok and auth.error leave the socket validated under gatewayMessageSchema", async () => {
    const auth = await createAuthService(AUTH_CONFIG);
    await auth.createUser({
      userId: "u_a1b2c3d4",
      displayName: "Kevin",
      pin: "1234",
      isAdmin: true,
      avatarTint: "terra",
    });
    const r = await auth.authenticate("u_a1b2c3d4", "1234");
    if (!r.ok) throw new Error("seed failed");

    const okWs = fakeWs();
    await handleAuthMessage(asSocket(okWs), { type: "auth", token: r.value.token }, auth, sessionManager);
    const errWs = fakeWs();
    await handleAuthMessage(asSocket(errWs), { type: "auth", token: "garbage" }, auth, sessionManager);

    for (const frame of [okWs.sent[0], errWs.sent[0]]) {
      expect(frame).toBeDefined();
      expect(gatewayMessageSchema.safeParse(frame).success, JSON.stringify(frame)).toBe(true);
    }
  });

  it("rejects + closes on invalid token", async () => {
    const auth = await createAuthService(AUTH_CONFIG);
    const ws = fakeWs();
    await handleAuthMessage(asSocket(ws), { type: "auth", token: "garbage" }, auth, sessionManager);
    expect(ws.data.authState).toBe("rejected");
    expect(ws.data.principal).toBeNull();
    expect(ws.sent[0]).toMatchObject({ type: "auth.error" });
    expect(ws.closeCode).not.toBeNull();
  });

  it("rejects + closes when first message is not type:auth", async () => {
    const auth = await createAuthService(AUTH_CONFIG);
    const ws = fakeWs();
    await handleAuthMessage(asSocket(ws), { type: "session.configure" }, auth, sessionManager);
    expect(ws.data.authState).toBe("rejected");
    expect(ws.sent[0]).toMatchObject({ type: "auth.error", code: "auth-required" });
    expect(ws.closeCode).not.toBeNull();
  });

  it("rejects token whose user no longer exists", async () => {
    const auth = await createAuthService(AUTH_CONFIG);
    await auth.createUser({
      userId: "u_deadbeef",
      displayName: "Kevin",
      pin: "1234",
      isAdmin: true,
      avatarTint: "terra",
    });
    const r = await auth.authenticate("u_deadbeef", "1234");
    if (!r.ok) throw new Error("seed");
    await auth.users.remove("u_deadbeef");

    const ws = fakeWs();
    await handleAuthMessage(asSocket(ws), { type: "auth", token: r.value.token }, auth, sessionManager);
    expect(ws.data.authState).toBe("rejected");
    expect(ws.sent[0]).toMatchObject({ type: "auth.error" });
    expect(ws.closeCode).not.toBeNull();
  });

  it("rejects when user hits per-user session cap", async () => {
    const auth = await createAuthService(AUTH_CONFIG);
    await auth.createUser({
      userId: "u_cafe1234",
      displayName: "Kevin",
      pin: "1234",
      isAdmin: true,
      avatarTint: "terra",
    });
    const r = await auth.authenticate("u_cafe1234", "1234");
    if (!r.ok) throw new Error("seed failed");

    const cappedManager = createSessionManager({ perUserMaxSessions: 1 });
    // Bind one session manually to exhaust the cap.
    cappedManager.bindUser("pre-existing-session", "u_cafe1234");

    const ws = fakeWs();
    await handleAuthMessage(asSocket(ws), { type: "auth", token: r.value.token }, auth, cappedManager);
    expect(ws.data.authState).toBe("rejected");
    expect(ws.sent[0]).toMatchObject({ type: "auth.error", code: "session-limit" });
    expect(ws.closeCode).not.toBeNull();
  });

  it("claims the gate synchronously: a second in-flight auth frame is dropped, not rebound", async () => {
    // Frame A's token.validate is a deferred we control by hand — it won't
    // settle until resolveValidateA() below. Frame B's user resolves
    // immediately; if the race were still open, B would win the mint.
    let resolveValidateA: (r: TokenResult<TokenPayload>) => void = () => {};
    const validateAPromise = new Promise<TokenResult<TokenPayload>>((resolve) => {
      resolveValidateA = resolve;
    });

    const bindCalls: Array<[string, string]> = [];
    const baseManager = createSessionManager();
    const trackedManager: SessionManager = {
      ...baseManager,
      bindUser(sessionId, userId) {
        bindCalls.push([sessionId, userId]);
        return baseManager.bindUser(sessionId, userId);
      },
    };

    const auth = buildFakeAuth({
      validate: async (token) =>
        token === "token-a"
          ? validateAPromise
          : { ok: true, value: { userId: "u_bbbbbbbb", isAdmin: false, issuedAt: 0, expiresAt: 9_999_999_999 } },
      getUser: async (userId) => ({
        ok: true,
        value: { userId, displayName: "X", pinHash: "x", isAdmin: false, avatarTint: "terra", createdAt: "now" },
      }),
    });

    const ws = fakeWs();

    // Fire frame A but do NOT await it — it suspends inside `await auth.tokens.validate("token-a")`.
    const pendingA = handleAuthMessage(asSocket(ws), { type: "auth", token: "token-a" }, auth, trackedManager);
    // Frame B arrives synchronously while A is still suspended.
    const pendingB = handleAuthMessage(asSocket(ws), { type: "auth", token: "token-b" }, auth, trackedManager);
    await pendingB;

    // B must have been dropped by the synchronous claim — the gate is still held by A.
    expect(ws.data.authState).toBe("authenticating");
    expect(ws.sent).toEqual([]);
    expect(bindCalls).toEqual([]);

    resolveValidateA({
      ok: true,
      value: { userId: "u_aaaaaaaa", isAdmin: false, issuedAt: 0, expiresAt: 9_999_999_999 },
    });
    await pendingA;

    expect(ws.data.authState).toBe("authed");
    expect(ws.data.principal?.userId).toBe("u_aaaaaaaa");
    expect(ws.sent).toEqual([
      { type: "auth.ok", user: { userId: "u_aaaaaaaa", displayName: "X", isAdmin: false, avatarTint: "terra" } },
    ]);
    expect(bindCalls).toEqual([["test-session", "u_aaaaaaaa"]]);
  });

  it("does not revive a rejected socket when the auth-timeout fires mid-lookup", async () => {
    // users.get() hangs until resolveUsersGet() below — simulates the lookup
    // still being in flight when the auth-timeout fires.
    let resolveUsersGet: (r: { ok: true; value: UserRecord | null }) => void = () => {};
    const usersGetPromise = new Promise<{ ok: true; value: UserRecord | null }>((resolve) => {
      resolveUsersGet = resolve;
    });

    const bindCalls: Array<[string, string]> = [];
    const baseManager = createSessionManager();
    const trackedManager: SessionManager = {
      ...baseManager,
      bindUser(sessionId, userId) {
        bindCalls.push([sessionId, userId]);
        return baseManager.bindUser(sessionId, userId);
      },
    };

    const auth = buildFakeAuth({
      validate: async () => ({
        ok: true,
        value: { userId: "u_a1b2c3d4", isAdmin: false, issuedAt: 0, expiresAt: 9_999_999_999 },
      }),
      getUser: async () => usersGetPromise,
    });

    const ws = fakeWs();
    const TIMEOUT_MS = 15;
    ws.data.authTimeout = scheduleAuthTimeout(asSocket(ws), TIMEOUT_MS);

    const pending = handleAuthMessage(asSocket(ws), { type: "auth", token: "t" }, auth, trackedManager);

    // Let real wall-clock time pass the timeout window while users.get() is still hung.
    await sleep(TIMEOUT_MS + 35);

    expect(ws.data.authState).toBe("rejected");
    expect(ws.data.principal).toBeNull();
    expect(ws.closeCode).toBe(1008);
    expect(ws.sent).toEqual([{ type: "auth.error", code: "auth-timeout", message: expect.any(String) }]);

    // Now let the stale lookup resolve — the post-await re-check must no-op
    // instead of reviving the already-rejected, already-closed socket.
    resolveUsersGet({
      ok: true,
      value: {
        userId: "u_a1b2c3d4",
        displayName: "K",
        pinHash: "x",
        isAdmin: false,
        avatarTint: "terra",
        createdAt: "now",
      },
    });
    await pending;

    expect(ws.data.authState).toBe("rejected");
    expect(ws.data.principal).toBeNull();
    expect(ws.sent.some((f) => (f as { type: string }).type === "auth.ok")).toBe(false);
    expect(bindCalls).toEqual([]);
  });

  it("rejects cleanly instead of throwing when the stored userId fails assertUserId", async () => {
    const auth = await createAuthService(AUTH_CONFIG);
    // createUser performs no format validation — this simulates a legacy
    // install or hand-edited users.json with a non-conforming userId.
    await auth.createUser({
      userId: "kevin",
      displayName: "Kevin",
      pin: "1234",
      isAdmin: true,
      avatarTint: "terra",
    });
    const r = await auth.authenticate("kevin", "1234");
    if (!r.ok) throw new Error("seed failed");

    const ws = fakeWs();
    await expect(
      handleAuthMessage(asSocket(ws), { type: "auth", token: r.value.token }, auth, sessionManager),
    ).resolves.toBeUndefined();

    expect(ws.data.authState).toBe("rejected");
    expect(ws.data.principal).toBeNull();
    expect(ws.sent[0]).toMatchObject({ type: "auth.error", code: "invalid-user-record" });
    expect(ws.closeCode).not.toBeNull();
  });
});
