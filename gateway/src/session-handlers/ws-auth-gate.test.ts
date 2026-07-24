import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthConfig } from "@sentient/config";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSessionManager } from "../auth/session-manager.js";
import { createAuthService } from "../user-auth/auth-service.js";
import { handleAuthMessage } from "./ws-auth-gate.js";
import type { ClientData } from "./ws-helpers.js";

const AUTH_CONFIG: AuthConfig = {
  token_ttl_seconds: 3600,
  ws_auth_timeout_ms: 5000,
  argon2_memory_kb: 8192,
  argon2_iterations: 1,
  argon2_parallelism: 1,
};

interface FakeWs {
  data: ClientData;
  sent: unknown[];
  closeCode: number | null;
  send: (s: string) => void;
  close: (code: number, reason?: string) => void;
}

function fakeWs(): FakeWs {
  const data: ClientData = {
    sessionId: "test-session",
    connectedAt: Date.now(),
    authState: "pending",
    userId: null,
    authTimeout: null,
    grantedCapabilities: new Set(),
    clientType: "webui",
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

  it("authes the WS on a valid token, sets userId, sends auth.ok", async () => {
    const auth = await createAuthService(AUTH_CONFIG);
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
    await handleAuthMessage(
      ws as unknown as { data: ClientData; send: (s: string) => void; close: (c: number) => void },
      { type: "auth", token: r.value.token },
      auth,
      sessionManager,
    );
    expect(ws.data.authState).toBe("authed");
    expect(ws.data.userId).toBe("kevin");
    expect(ws.sent).toEqual([
      {
        type: "auth.ok",
        user: { userId: "kevin", displayName: "Kevin", isAdmin: true, avatarTint: "terra" },
      },
    ]);
    expect(ws.closeCode).toBeNull();
  });

  it("rejects + closes on invalid token", async () => {
    const auth = await createAuthService(AUTH_CONFIG);
    const ws = fakeWs();
    await handleAuthMessage(
      ws as unknown as { data: ClientData; send: (s: string) => void; close: (c: number) => void },
      { type: "auth", token: "garbage" },
      auth,
      sessionManager,
    );
    expect(ws.data.authState).toBe("rejected");
    expect(ws.data.userId).toBeNull();
    expect(ws.sent[0]).toMatchObject({ type: "auth.error" });
    expect(ws.closeCode).not.toBeNull();
  });

  it("rejects + closes when first message is not type:auth", async () => {
    const auth = await createAuthService(AUTH_CONFIG);
    const ws = fakeWs();
    await handleAuthMessage(
      ws as unknown as { data: ClientData; send: (s: string) => void; close: (c: number) => void },
      { type: "session.configure" },
      auth,
      sessionManager,
    );
    expect(ws.data.authState).toBe("rejected");
    expect(ws.sent[0]).toMatchObject({ type: "auth.error", code: "auth-required" });
    expect(ws.closeCode).not.toBeNull();
  });

  it("rejects token whose user no longer exists", async () => {
    const auth = await createAuthService(AUTH_CONFIG);
    await auth.createUser({
      userId: "kevin",
      displayName: "Kevin",
      pin: "1234",
      isAdmin: true,
      avatarTint: "terra",
    });
    const r = await auth.authenticate("kevin", "1234");
    if (!r.ok) throw new Error("seed");
    await auth.users.remove("kevin");

    const ws = fakeWs();
    await handleAuthMessage(
      ws as unknown as { data: ClientData; send: (s: string) => void; close: (c: number) => void },
      { type: "auth", token: r.value.token },
      auth,
      sessionManager,
    );
    expect(ws.data.authState).toBe("rejected");
    expect(ws.sent[0]).toMatchObject({ type: "auth.error" });
    expect(ws.closeCode).not.toBeNull();
  });

  it("rejects when user hits per-user session cap", async () => {
    const auth = await createAuthService(AUTH_CONFIG);
    await auth.createUser({
      userId: "kevin",
      displayName: "Kevin",
      pin: "1234",
      isAdmin: true,
      avatarTint: "terra",
    });
    const r = await auth.authenticate("kevin", "1234");
    if (!r.ok) throw new Error("seed failed");

    const cappedManager = createSessionManager({ perUserMaxSessions: 1 });
    // Bind one session manually to exhaust the cap.
    cappedManager.bindUser("pre-existing-session", "kevin");

    const ws = fakeWs();
    await handleAuthMessage(
      ws as unknown as { data: ClientData; send: (s: string) => void; close: (c: number) => void },
      { type: "auth", token: r.value.token },
      auth,
      cappedManager,
    );
    expect(ws.data.authState).toBe("rejected");
    expect(ws.sent[0]).toMatchObject({ type: "auth.error", code: "session-limit" });
    expect(ws.closeCode).not.toBeNull();
  });
});
