import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type McpCatalog, loadConfig, mcpCatalogSchema } from "@sentient/config";
import type { Result } from "@sentient/protocol";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { InstallStateData } from "../../admin/install-state.js";
import type { UserProvisioner, UserSummary } from "../../admin/user-provisioner.js";
import { defaultPermissionsFor } from "../../tools/role-defaults.js";
import type { AuthError, AuthService, ChangePinError, UpdateDisplayNameError } from "../../user-auth/auth-service.js";
import { NEVER_REVOKED } from "../../user-auth/credential-floor.js";
import type { TokenPayload, TokenResult, UserRecord } from "../../user-auth/types.js";
import { type AuthHandlerDeps, createAuthHandler } from "./auth.js";

function sampleUser(userId = "alice"): UserRecord {
  return {
    userId,
    displayName: "Alice",
    pinHash: "$argon2id$fake-hash",
    role: "adult",
    avatarTint: "sage",
    createdAt: "2026-01-01T00:00:00.000Z",
    credentialsValidFrom: NEVER_REVOKED,
  };
}

function makeValidTokens(userId = "alice") {
  return {
    validate: vi.fn(
      async (): Promise<TokenResult<TokenPayload>> => ({
        ok: true,
        value: { userId, issuedAt: 0, expiresAt: 9999999999 },
      }),
    ),
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
    issue: vi.fn(async (): Promise<string> => "issued-token"),
  };
}

function makeDeps(
  tokensOverride?: ReturnType<typeof makeValidTokens>,
  userOverride?: UserRecord,
): { auth: Pick<AuthService, "tokens" | "users" | "updateDisplayName" | "changePin">; mcpCatalog: McpCatalog } {
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
    mcpCatalog: shippedCatalog,
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

function makeGetMeRequest(bearerToken?: string): Request {
  const headers = new Headers();
  if (bearerToken !== undefined) headers.set("authorization", `Bearer ${bearerToken}`);
  return new Request("http://localhost/api/v1/auth/me", { method: "GET", headers });
}

// ---------------------------------------------------------------------------
// /auth/me RENEWS A CREDENTIAL, AND A CREDENTIAL CARRIES NO AUTHORITY.
//
// The token it hands back names a user and nothing else (owner ruling,
// 2026-08-07). An intermediate revision minted a `role` claim here and had to
// work to keep it fresh; that whole problem is deleted rather than narrowed —
// there is no authority in the token to go stale.
//
// The `role`/`isAdmin` in the BODY is different in kind: it is display data,
// read off the record on this request, so the client knows whether to draw the
// admin section. A client rendering a stale copy of it cannot turn that into
// access, because every route re-resolves the role from the record anyway
// (`require-admin-auth.test.ts` pins that).
// ---------------------------------------------------------------------------
describe("GET /api/v1/auth/me", () => {
  it("mints an identity-only token — no role, no authority of any kind", async () => {
    const tokens = makeValidTokens("alice");
    const deps = makeDeps(tokens, { ...sampleUser(), role: "admin" as const });
    const handler = createAuthHandler(deps as unknown as AuthHandlerDeps);

    const response = await handler(makeGetMeRequest("her-token"));

    expect(response.status).toBe(200);
    // Exactly `{userId}` — an extra property here would be a claim, and a
    // claim is a grant that outlives the record it came from.
    expect(tokens.issue).toHaveBeenCalledWith({ userId: "alice" });
  });

  it("reports the record's CURRENT role in the body, for rendering", async () => {
    const demoted = { ...sampleUser(), role: "adult" as const };
    const deps = makeDeps(makeValidTokens("alice"), demoted);
    const handler = createAuthHandler(deps as unknown as AuthHandlerDeps);

    const body = await (await handler(makeGetMeRequest("her-token"))).json();

    expect(body.user.role).toBe("adult");
    expect(body.user.isAdmin).toBe(false);
    expect(body.token).toBe("issued-token");
  });

  it("reports a promotion on the next visit, with no re-login", async () => {
    const deps = makeDeps(makeValidTokens("alice"), { ...sampleUser(), role: "admin" as const });
    const handler = createAuthHandler(deps as unknown as AuthHandlerDeps);

    const body = await (await handler(makeGetMeRequest("her-token"))).json();

    expect(body.user.role).toBe("admin");
    expect(body.user.isAdmin).toBe(true);
  });

  it("returns 401 without a bearer token", async () => {
    const deps = makeDeps();
    const handler = createAuthHandler(deps as unknown as AuthHandlerDeps);

    expect((await handler(makeGetMeRequest())).status).toBe(401);
  });

  it("returns 401 and mints nothing when the token does not validate", async () => {
    const tokens = makeInvalidTokens();
    const deps = makeDeps(tokens as unknown as ReturnType<typeof makeValidTokens>);
    const handler = createAuthHandler(deps as unknown as AuthHandlerDeps);

    expect((await handler(makeGetMeRequest("bad-token"))).status).toBe(401);
    expect(tokens.issue).not.toHaveBeenCalled();
  });
});

describe("PUT /api/v1/auth/me", () => {
  it("updates displayName on 200 and persists via authService", async () => {
    const updatedUser = { ...sampleUser(), displayName: "Alicia" };
    const deps = makeDeps(makeValidTokens(), sampleUser());
    deps.auth.updateDisplayName = vi.fn(async () => ({ ok: true as const, value: updatedUser }));
    const handler = createAuthHandler(deps as unknown as AuthHandlerDeps);

    const response = await handler(makePutMeRequest({ displayName: "Alicia" }, "valid-token"));

    expect(response.status).toBe(200);
    expect(deps.auth.updateDisplayName).toHaveBeenCalledWith("alice", "Alicia");
    const body = await response.json();
    expect(body.user.displayName).toBe("Alicia");
  });

  it("returns 401 without bearer token", async () => {
    const deps = makeDeps();
    const handler = createAuthHandler(deps as unknown as AuthHandlerDeps);

    const response = await handler(makePutMeRequest({ displayName: "Alicia" }));

    expect(response.status).toBe(401);
  });

  it("returns 422 when displayName is empty", async () => {
    const deps = makeDeps(makeValidTokens());
    const handler = createAuthHandler(deps as unknown as AuthHandlerDeps);

    const response = await handler(makePutMeRequest({ displayName: "" }, "valid-token"));

    expect(response.status).toBe(422);
  });

  it("returns 422 when displayName exceeds 64 characters", async () => {
    const deps = makeDeps(makeValidTokens());
    const handler = createAuthHandler(deps as unknown as AuthHandlerDeps);

    const response = await handler(makePutMeRequest({ displayName: "a".repeat(65) }, "valid-token"));

    expect(response.status).toBe(422);
  });

  it("returns 405 for non-PUT requests to /api/v1/auth/me when routed through a non-PUT path", async () => {
    const deps = makeDeps(makeValidTokens());
    const handler = createAuthHandler(deps as unknown as AuthHandlerDeps);
    const request = new Request("http://localhost/api/v1/auth/me", {
      method: "DELETE",
      headers: new Headers({ authorization: "Bearer valid-token" }),
    });

    const response = await handler(request);

    expect(response.status).toBe(405);
  });

  it("returns 401 when token is invalid", async () => {
    const deps = makeDeps(makeInvalidTokens());
    const handler = createAuthHandler(deps as unknown as AuthHandlerDeps);

    const response = await handler(makePutMeRequest({ displayName: "Alicia" }, "bad-token"));

    expect(response.status).toBe(401);
  });

  it("returns 500 when authService.updateDisplayName fails with io-error", async () => {
    const deps = makeDeps(makeValidTokens());
    deps.auth.updateDisplayName = vi.fn(
      async (): Promise<Result<UserRecord, UpdateDisplayNameError>> => ({ ok: false, error: "io-error" }),
    );
    const handler = createAuthHandler(deps as unknown as AuthHandlerDeps);

    const response = await handler(makePutMeRequest({ displayName: "Alicia" }, "valid-token"));

    expect(response.status).toBe(500);
  });

  it("returns 404 when authService.updateDisplayName returns not-found (user deleted)", async () => {
    const deps = makeDeps(makeValidTokens());
    deps.auth.updateDisplayName = vi.fn(
      async (): Promise<Result<UserRecord, UpdateDisplayNameError>> => ({ ok: false, error: "not-found" }),
    );
    const handler = createAuthHandler(deps as unknown as AuthHandlerDeps);

    const response = await handler(makePutMeRequest({ displayName: "Alicia" }, "valid-token"));

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe("not-found");
  });
});

describe("PUT /api/v1/auth/me/pin", () => {
  it("returns 200 when currentPin matches and newPin is valid", async () => {
    const deps = makeDeps(makeValidTokens());
    const handler = createAuthHandler(deps as unknown as AuthHandlerDeps);

    const response = await handler(makePutPinRequest({ currentPin: "1234", newPin: "5678" }, "valid-token"));

    expect(response.status).toBe(200);
    expect(deps.auth.changePin).toHaveBeenCalledWith("alice", "1234", "5678");
    const body = await response.json();
    expect(body.ok).toBe(true);
  });

  it("returns 401 when currentPin is wrong", async () => {
    const deps = makeDeps(makeValidTokens());
    deps.auth.changePin = vi.fn(async (): Promise<Result<void, ChangePinError>> => ({ ok: false, error: "wrong-pin" }));
    const handler = createAuthHandler(deps as unknown as AuthHandlerDeps);

    const response = await handler(makePutPinRequest({ currentPin: "9999", newPin: "5678" }, "valid-token"));

    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error).toBe("invalid-credentials");
  });

  it("returns 422 when newPin does not match /^\\d{4}$/ format", async () => {
    const deps = makeDeps(makeValidTokens());
    const handler = createAuthHandler(deps as unknown as AuthHandlerDeps);

    const response = await handler(makePutPinRequest({ currentPin: "1234", newPin: "abc" }, "valid-token"));
    expect(response.status).toBe(422);

    // 5-digit all-numeric: proves regex enforces exact length, not just digit-ness
    const response2 = await handler(makePutPinRequest({ currentPin: "1234", newPin: "12345" }, "valid-token"));
    expect(response2.status).toBe(422);
  });

  it("returns 422 when currentPin does not match /^\\d{4}$/ format (schema rejection, not auth)", async () => {
    const deps = makeDeps(makeValidTokens());
    const handler = createAuthHandler(deps as unknown as AuthHandlerDeps);

    // Non-numeric currentPin: schema rejects before auth check → 422, not 401
    const response = await handler(makePutPinRequest({ currentPin: "abc", newPin: "5678" }, "valid-token"));
    expect(response.status).toBe(422);

    // 5-digit currentPin: wrong length → 422
    const response2 = await handler(makePutPinRequest({ currentPin: "12345", newPin: "5678" }, "valid-token"));
    expect(response2.status).toBe(422);
  });

  it("returns 401 without bearer token", async () => {
    const deps = makeDeps();
    const handler = createAuthHandler(deps as unknown as AuthHandlerDeps);

    const response = await handler(makePutPinRequest({ currentPin: "1234", newPin: "5678" }));

    expect(response.status).toBe(401);
  });

  it("returns 405 for non-PUT requests to /api/v1/auth/me/pin", async () => {
    const deps = makeDeps(makeValidTokens());
    const handler = createAuthHandler(deps as unknown as AuthHandlerDeps);
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
    const handler = createAuthHandler(deps as unknown as AuthHandlerDeps);

    const response = await handler(makePutPinRequest({ currentPin: "1234", newPin: "5678" }, "bad-token"));

    expect(response.status).toBe(401);
  });

  it("returns 500 when authService.changePin fails with io-error", async () => {
    const deps = makeDeps(makeValidTokens());
    deps.auth.changePin = vi.fn(async (): Promise<Result<void, ChangePinError>> => ({ ok: false, error: "io-error" }));
    const handler = createAuthHandler(deps as unknown as AuthHandlerDeps);

    const response = await handler(makePutPinRequest({ currentPin: "1234", newPin: "5678" }, "valid-token"));

    expect(response.status).toBe(500);
  });

  it("returns 404 when authService.changePin returns not-found (user deleted)", async () => {
    const deps = makeDeps(makeValidTokens());
    deps.auth.changePin = vi.fn(async (): Promise<Result<void, ChangePinError>> => ({ ok: false, error: "not-found" }));
    const handler = createAuthHandler(deps as unknown as AuthHandlerDeps);

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
    tokens: makeValidTokens("u_00000001"),
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
//
// Asserted against the SHIPPED catalog, not a fixture: the bug this guards is
// "a genuinely fresh account came out with no tools", and a fixture catalog
// would have been just as green while the real one seeded nothing.
const shippedCatalog = loadConfig(
  readFileSync(join(import.meta.dir, "../../../config.yaml"), "utf-8"),
  z.object({ mcp_catalog: mcpCatalogSchema }),
).mcp_catalog;

function seededPermissions(userProvisioner: UserProvisioner): Record<string, Record<string, string>> | undefined {
  const call = (userProvisioner.createUser as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
  return call?.profile?.tools?.permissions;
}

describe("POST /api/v1/auth/setup — the first admin gets tools", () => {
  it("REGRESSION: seeds the starter permissions from the wizard's empty tools.enabled", async () => {
    const userProvisioner = makeSetupProvisioner();
    const handler = createAuthHandler({
      auth: makeSetupAuthService(),
      userProvisioner,
      mcpCatalog: shippedCatalog,
    });

    await handler(makeSetupRequest());

    const permissions = seededPermissions(userProvisioner);
    expect(permissions?.gateway).toEqual({
      identify_user: "allow",
      pause_audio: "allow",
      resume_audio: "allow",
      update_user_settings: "allow",
    });
    // The first admin is the household's operator: the confirm tier is theirs,
    // and it arrives as a prompt rather than as silence in either direction.
    expect(permissions?.home_assistant?.ha_call_service).toBe("ask");
    expect(permissions?.home_assistant?.ha_get_state).toBe("allow");
  });

  it("seeds them for a setup submitted with no profile at all", async () => {
    const userProvisioner = makeSetupProvisioner();
    const handler = createAuthHandler({
      auth: makeSetupAuthService(),
      userProvisioner,
      mcpCatalog: shippedCatalog,
    });

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

    const permissions = seededPermissions(userProvisioner);
    expect(permissions?.home_assistant?.ha_call_service).toBe("ask");
    expect(permissions?.gateway?.identify_user).toBe("allow");
  });

  it("seeds the ADMIN role's table — every curated tool, none withheld", async () => {
    const userProvisioner = makeSetupProvisioner();
    const handler = createAuthHandler({
      auth: makeSetupAuthService(),
      userProvisioner,
      mcpCatalog: shippedCatalog,
    });

    await handler(makeSetupRequest());

    // The operator reaches every tier, so their table is the whole catalog —
    // seeding this account as anything less privileged would show up here as a
    // missing tool rather than as a mystery months later.
    expect(seededPermissions(userProvisioner)).toEqual(defaultPermissionsFor("admin", shippedCatalog));
    expect(seededPermissions(userProvisioner)).not.toEqual(defaultPermissionsFor("guest", shippedCatalog));
  });
});

describe("POST /api/v1/auth/setup — install-state cursor", () => {
  it("advances install-state cursor admin → finish on success", async () => {
    const installState = makeMockInstallState({ wizard_cursor: "admin", unlock_verified: true });
    const handler = createAuthHandler({
      auth: makeSetupAuthService(),
      userProvisioner: makeSetupProvisioner(),
      installState,
      mcpCatalog: shippedCatalog,
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
      mcpCatalog: shippedCatalog,
    });

    const response = await handler(makeSetupRequest());

    expect(response.status).toBe(200);
    expect(installState.advanceCursor).not.toHaveBeenCalled();
    expect(installState.getCursor()).toBe("voice");
  });
});
