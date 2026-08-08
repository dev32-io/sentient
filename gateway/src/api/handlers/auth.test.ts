import type { Result, UserRole } from "@sentient/protocol";
import { describe, expect, it, vi } from "vitest";
import type { InstallStateData } from "../../admin/install-state.js";
import type { UserProvisioner, UserSummary } from "../../admin/user-provisioner.js";
import type { AuthError, AuthService, ChangePinError, UpdateDisplayNameError } from "../../user-auth/auth-service.js";
import type { TokenPayload, TokenResult, UserRecord } from "../../user-auth/types.js";
import { createAuthHandler } from "./auth.js";

function sampleUser(userId = "alice"): UserRecord {
  return {
    userId,
    displayName: "Alice",
    pinHash: "$argon2id$fake-hash",
    role: "adult",
    avatarTint: "sage",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeValidTokens(userId = "alice", role: UserRole = "adult") {
  return {
    validate: vi.fn(
      async (): Promise<TokenResult<TokenPayload>> => ({
        ok: true,
        value: { userId, role, issuedAt: 0, expiresAt: 9999999999 },
      }),
    ),
    refresh: vi.fn(async (): Promise<TokenResult<string>> => ({ ok: true, value: "refreshed-token" })),
    issue: vi.fn(async (): Promise<string> => "issued-token"),
  };
}

function makeInvalidTokens() {
  return {
    validate: vi.fn(
      async (): Promise<TokenResult<TokenPayload>> => ({
        ok: false,
        error: "signature-invalid" as const,
      }),
    ),
    refresh: vi.fn(async (): Promise<TokenResult<string>> => ({ ok: false, error: "signature-invalid" as const })),
    issue: vi.fn(async (): Promise<string> => "issued-token"),
  };
}

function makeDeps(
  tokensOverride?: ReturnType<typeof makeValidTokens>,
  userOverride?: UserRecord,
): { auth: Pick<AuthService, "tokens" | "users" | "updateDisplayName" | "changePin"> } {
  const user = userOverride ?? sampleUser();
  const tokens = tokensOverride ?? makeValidTokens();
  return {
    auth: {
      tokens,
      users: {
        get: vi.fn(async () => ({ ok: true as const, value: user })),
        list: vi.fn(async () => ({ ok: true as const, value: [user] })),
        add: vi.fn(async () => ({ ok: true as const, value: undefined })),
        update: vi.fn(async () => ({ ok: true as const, value: undefined })),
        remove: vi.fn(async () => ({ ok: true as const, value: undefined })),
      },
      updateDisplayName: vi.fn(
        async (): Promise<Result<UserRecord, UpdateDisplayNameError>> => ({ ok: true, value: user }),
      ),
      changePin: vi.fn(async (): Promise<Result<void, ChangePinError>> => ({ ok: true, value: undefined })),
    },
  };
}

function makePutMeRequest(body: unknown, bearerToken?: string): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (bearerToken !== undefined) headers.set("authorization", `Bearer ${bearerToken}`);
  return new Request("http://localhost/api/v1/auth/me", {
    method: "PUT",
    headers,
    body: JSON.stringify(body),
  });
}

function makePutPinRequest(body: unknown, bearerToken?: string): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (bearerToken !== undefined) headers.set("authorization", `Bearer ${bearerToken}`);
  return new Request("http://localhost/api/v1/auth/me/pin", {
    method: "PUT",
    headers,
    body: JSON.stringify(body),
  });
}

describe("PUT /api/v1/auth/me", () => {
  it("updates displayName on 200 and persists via authService", async () => {
    const updatedUser = { ...sampleUser(), displayName: "Alicia" };
    const deps = makeDeps(makeValidTokens(), sampleUser());
    deps.auth.updateDisplayName = vi.fn(async () => ({ ok: true as const, value: updatedUser }));
    const handler = createAuthHandler(deps as unknown as { auth: AuthService });

    const response = await handler(makePutMeRequest({ displayName: "Alicia" }, "valid-token"));

    expect(response.status).toBe(200);
    expect(deps.auth.updateDisplayName).toHaveBeenCalledWith("alice", "Alicia");
    const body = await response.json();
    expect(body.user.displayName).toBe("Alicia");
  });

  it("returns 401 without bearer token", async () => {
    const deps = makeDeps();
    const handler = createAuthHandler(deps as unknown as { auth: AuthService });

    const response = await handler(makePutMeRequest({ displayName: "Alicia" }));

    expect(response.status).toBe(401);
  });

  it("returns 422 when displayName is empty", async () => {
    const deps = makeDeps(makeValidTokens());
    const handler = createAuthHandler(deps as unknown as { auth: AuthService });

    const response = await handler(makePutMeRequest({ displayName: "" }, "valid-token"));

    expect(response.status).toBe(422);
  });

  it("returns 422 when displayName exceeds 64 characters", async () => {
    const deps = makeDeps(makeValidTokens());
    const handler = createAuthHandler(deps as unknown as { auth: AuthService });

    const response = await handler(makePutMeRequest({ displayName: "a".repeat(65) }, "valid-token"));

    expect(response.status).toBe(422);
  });

  it("returns 405 for non-PUT requests to /api/v1/auth/me when routed through a non-PUT path", async () => {
    const deps = makeDeps(makeValidTokens());
    const handler = createAuthHandler(deps as unknown as { auth: AuthService });
    const request = new Request("http://localhost/api/v1/auth/me", {
      method: "DELETE",
      headers: new Headers({ authorization: "Bearer valid-token" }),
    });

    const response = await handler(request);

    expect(response.status).toBe(405);
  });

  it("returns 401 when token is invalid", async () => {
    const deps = makeDeps(makeInvalidTokens());
    const handler = createAuthHandler(deps as unknown as { auth: AuthService });

    const response = await handler(makePutMeRequest({ displayName: "Alicia" }, "bad-token"));

    expect(response.status).toBe(401);
  });

  it("returns 500 when authService.updateDisplayName fails with io-error", async () => {
    const deps = makeDeps(makeValidTokens());
    deps.auth.updateDisplayName = vi.fn(
      async (): Promise<Result<UserRecord, UpdateDisplayNameError>> => ({ ok: false, error: "io-error" }),
    );
    const handler = createAuthHandler(deps as unknown as { auth: AuthService });

    const response = await handler(makePutMeRequest({ displayName: "Alicia" }, "valid-token"));

    expect(response.status).toBe(500);
  });

  it("returns 404 when authService.updateDisplayName returns not-found (user deleted)", async () => {
    const deps = makeDeps(makeValidTokens());
    deps.auth.updateDisplayName = vi.fn(
      async (): Promise<Result<UserRecord, UpdateDisplayNameError>> => ({ ok: false, error: "not-found" }),
    );
    const handler = createAuthHandler(deps as unknown as { auth: AuthService });

    const response = await handler(makePutMeRequest({ displayName: "Alicia" }, "valid-token"));

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe("not-found");
  });
});

describe("PUT /api/v1/auth/me/pin", () => {
  it("returns 200 when currentPin matches and newPin is valid", async () => {
    const deps = makeDeps(makeValidTokens());
    const handler = createAuthHandler(deps as unknown as { auth: AuthService });

    const response = await handler(makePutPinRequest({ currentPin: "1234", newPin: "5678" }, "valid-token"));

    expect(response.status).toBe(200);
    expect(deps.auth.changePin).toHaveBeenCalledWith("alice", "1234", "5678");
    const body = await response.json();
    expect(body.ok).toBe(true);
  });

  it("returns 401 when currentPin is wrong", async () => {
    const deps = makeDeps(makeValidTokens());
    deps.auth.changePin = vi.fn(async (): Promise<Result<void, ChangePinError>> => ({ ok: false, error: "wrong-pin" }));
    const handler = createAuthHandler(deps as unknown as { auth: AuthService });

    const response = await handler(makePutPinRequest({ currentPin: "9999", newPin: "5678" }, "valid-token"));

    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error).toBe("invalid-credentials");
  });

  it("returns 422 when newPin does not match /^\\d{4}$/ format", async () => {
    const deps = makeDeps(makeValidTokens());
    const handler = createAuthHandler(deps as unknown as { auth: AuthService });

    const response = await handler(makePutPinRequest({ currentPin: "1234", newPin: "abc" }, "valid-token"));
    expect(response.status).toBe(422);

    // 5-digit all-numeric: proves regex enforces exact length, not just digit-ness
    const response2 = await handler(makePutPinRequest({ currentPin: "1234", newPin: "12345" }, "valid-token"));
    expect(response2.status).toBe(422);
  });

  it("returns 422 when currentPin does not match /^\\d{4}$/ format (schema rejection, not auth)", async () => {
    const deps = makeDeps(makeValidTokens());
    const handler = createAuthHandler(deps as unknown as { auth: AuthService });

    // Non-numeric currentPin: schema rejects before auth check → 422, not 401
    const response = await handler(makePutPinRequest({ currentPin: "abc", newPin: "5678" }, "valid-token"));
    expect(response.status).toBe(422);

    // 5-digit currentPin: wrong length → 422
    const response2 = await handler(makePutPinRequest({ currentPin: "12345", newPin: "5678" }, "valid-token"));
    expect(response2.status).toBe(422);
  });

  it("returns 401 without bearer token", async () => {
    const deps = makeDeps();
    const handler = createAuthHandler(deps as unknown as { auth: AuthService });

    const response = await handler(makePutPinRequest({ currentPin: "1234", newPin: "5678" }));

    expect(response.status).toBe(401);
  });

  it("returns 405 for non-PUT requests to /api/v1/auth/me/pin", async () => {
    const deps = makeDeps(makeValidTokens());
    const handler = createAuthHandler(deps as unknown as { auth: AuthService });
    const request = new Request("http://localhost/api/v1/auth/me/pin", {
      method: "POST",
      headers: new Headers({ authorization: "Bearer valid-token" }),
      body: JSON.stringify({ currentPin: "1234", newPin: "5678" }),
    });

    const response = await handler(request);

    expect(response.status).toBe(405);
  });

  it("returns 401 when bearer token is invalid", async () => {
    const deps = makeDeps(makeInvalidTokens());
    const handler = createAuthHandler(deps as unknown as { auth: AuthService });

    const response = await handler(makePutPinRequest({ currentPin: "1234", newPin: "5678" }, "bad-token"));

    expect(response.status).toBe(401);
  });

  it("returns 500 when authService.changePin fails with io-error", async () => {
    const deps = makeDeps(makeValidTokens());
    deps.auth.changePin = vi.fn(async (): Promise<Result<void, ChangePinError>> => ({ ok: false, error: "io-error" }));
    const handler = createAuthHandler(deps as unknown as { auth: AuthService });

    const response = await handler(makePutPinRequest({ currentPin: "1234", newPin: "5678" }, "valid-token"));

    expect(response.status).toBe(500);
  });

  it("returns 404 when authService.changePin returns not-found (user deleted)", async () => {
    const deps = makeDeps(makeValidTokens());
    deps.auth.changePin = vi.fn(async (): Promise<Result<void, ChangePinError>> => ({ ok: false, error: "not-found" }));
    const handler = createAuthHandler(deps as unknown as { auth: AuthService });

    const response = await handler(makePutPinRequest({ currentPin: "1234", newPin: "5678" }, "valid-token"));

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe("not-found");
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/auth/setup — install-state cursor advance
// ---------------------------------------------------------------------------

function makeMockInstallState(initial: {
  wizard_cursor: string;
  bootstrap_complete?: boolean;
  unlock_verified?: boolean;
}) {
  let cursor = initial.wizard_cursor;
  return {
    load: async (): Promise<InstallStateData> => ({
      bootstrap_complete: initial.bootstrap_complete ?? false,
      unlock_verified: initial.unlock_verified ?? true,
      wizard_cursor: cursor as InstallStateData["wizard_cursor"],
      schema_version: "0.2.0",
      installed_version: "0.4.0",
      last_upgraded_from: null,
      last_upgraded_at: null,
    }),
    advanceCursor: vi.fn(async (_from: string, to: string) => {
      cursor = to;
      return { ok: true as const, value: undefined };
    }),
    retreatCursor: async () => ({ ok: true as const, value: undefined }),
    setUnlockVerified: async () => ({ ok: true as const, value: undefined }),
    finish: async () => ({ ok: true as const, value: undefined }),
    getCursor: () => cursor,
  };
}

function makeSetupAuthService(): AuthService {
  const user = sampleUser("u_00000001");
  return {
    tokens: makeValidTokens("u_00000001", "admin"),
    users: {
      get: vi.fn(async () => ({ ok: true as const, value: user })),
      list: vi.fn(async () => ({ ok: true as const, value: [user] })),
      add: vi.fn(async () => ({ ok: true as const, value: undefined })),
      update: vi.fn(async () => ({ ok: true as const, value: undefined })),
      remove: vi.fn(async () => ({ ok: true as const, value: undefined })),
    },
    config: {
      token_ttl_seconds: 3600,
      ws_auth_timeout_ms: 5000,
      argon2_memory_kb: 65536,
      argon2_iterations: 3,
      argon2_parallelism: 1,
    },
    createUser: vi.fn(async () => ({ ok: true as const, value: user })),
    authenticate: vi.fn(
      async (): Promise<Result<{ token: string; user: UserRecord }, AuthError>> => ({
        ok: true,
        value: { token: "setup-token", user },
      }),
    ),
    listUsersPublic: vi.fn(async () => ({ ok: true as const, value: [] })),
    isFirstRun: vi.fn(async () => true),
    updateDisplayName: vi.fn(async () => ({ ok: true as const, value: user })),
    changePin: vi.fn(async () => ({ ok: true as const, value: undefined })),
  };
}

function makeSetupProvisioner(): UserProvisioner {
  const summary: UserSummary = {
    userId: "u_00000001",
    displayName: "Admin",
    role: "admin",
    isAdmin: true,
    avatarTint: "sage",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  return {
    createUser: vi.fn(async () => ({ ok: true as const, value: summary })),
    deleteUser: vi.fn(async () => ({ ok: true as const, value: undefined })),
    resetPin: vi.fn(async () => ({ ok: true as const, value: undefined })),
    setRole: vi.fn(async () => ({ ok: true as const, value: undefined })),
  };
}

function makeSetupRequest(): Request {
  return new Request("http://localhost/api/v1/auth/setup", {
    method: "POST",
    headers: new Headers({ "content-type": "application/json" }),
    body: JSON.stringify({
      displayName: "Admin",
      pin: "1234",
      profile: {
        model: { provider: "ollama-cloud", id: "deepseek-v4-flash:cloud" },
        voice: { provider: "local-tts", id: "placeholder" },
        persona: { template: "default", overrides: "" },
        tools: { enabled: {}, toolsets: [] },
        compression: { threshold: 0.5 },
        advanced: { extraSystemPrompt: "", maxTokens: 1024, reasoningEffort: "minimal" },
      },
    }),
  });
}

// The FIRST-ADMIN path, which is the one every fresh install runs exactly once
// and which nothing else can compensate for afterwards. `makeSetupRequest`
// already carried the wizard's real `tools: { enabled: {} }` and asserted
// nothing about it, so a regression here was invisible.
const SEEDED_PERMISSIONS = {
  home_assistant: {},
  gateway: {},
  music_assistant: {},
  searxng: {},
  fetch: {},
};

describe("POST /api/v1/auth/setup — the first admin gets tools", () => {
  it("REGRESSION: seeds the starter permissions from the wizard's empty tools.enabled", async () => {
    const userProvisioner = makeSetupProvisioner();
    const handler = createAuthHandler({ auth: makeSetupAuthService(), userProvisioner });

    await handler(makeSetupRequest());

    const call = (userProvisioner.createUser as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(call?.profile?.tools?.permissions).toEqual(SEEDED_PERMISSIONS);
  });

  it("seeds them for a setup submitted with no profile at all", async () => {
    const userProvisioner = makeSetupProvisioner();
    const handler = createAuthHandler({ auth: makeSetupAuthService(), userProvisioner });

    // `buildDefaultProfileBody`'s output never passes through the schema, so it
    // never sees the enabled→permissions migration — it has to omit the field
    // itself rather than send `{}`, which would persist as "every server off".
    await handler(
      new Request("http://localhost/api/v1/auth/setup", {
        method: "POST",
        headers: new Headers({ "content-type": "application/json" }),
        body: JSON.stringify({ displayName: "Admin", pin: "1234" }),
      }),
    );

    const call = (userProvisioner.createUser as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(call?.profile?.tools?.permissions).toEqual(SEEDED_PERMISSIONS);
  });
});

describe("POST /api/v1/auth/setup — install-state cursor", () => {
  it("advances install-state cursor admin → finish on success", async () => {
    const installState = makeMockInstallState({ wizard_cursor: "admin", unlock_verified: true });
    const handler = createAuthHandler({
      auth: makeSetupAuthService(),
      userProvisioner: makeSetupProvisioner(),
      installState,
    });

    const response = await handler(makeSetupRequest());

    expect(response.status).toBe(200);
    expect(installState.advanceCursor).toHaveBeenCalledWith("admin", "finish");
    expect(installState.getCursor()).toBe("finish");
  });

  it("leaves cursor untouched when cursor !== admin", async () => {
    const installState = makeMockInstallState({ wizard_cursor: "voice", unlock_verified: true });
    const handler = createAuthHandler({
      auth: makeSetupAuthService(),
      userProvisioner: makeSetupProvisioner(),
      installState,
    });

    const response = await handler(makeSetupRequest());

    expect(response.status).toBe(200);
    expect(installState.advanceCursor).not.toHaveBeenCalled();
    expect(installState.getCursor()).toBe("voice");
  });
});
