import type { Result } from "@sentient/protocol";
import { describe, expect, it, vi } from "vitest";
import type { ProfileStore, ProfileStoreError } from "../../profile-store/profile-store.js";
import type { ProfileV1 } from "../../profile-store/profile-types.js";
import type { TokenPayload, TokenResult } from "../../user-auth/types.js";
import { createProfileHandler } from "./profile.js";

function sampleProfile(userId = "alice"): ProfileV1 {
  return {
    schemaVersion: 1,
    userId,
    model: { provider: "openrouter", id: "google/gemini-2.5-flash" },
    voice: { provider: "local-tts", id: "voice-abc" },
    audio: { ttsEnabled: true, channel: "voice" as const },
    persona: { template: "default", overrides: "" },
    tools: { permissions: {} },
    compression: { threshold: 0.5 },
    advanced: { extraSystemPrompt: "", maxTokens: 1024, reasoningEffort: "minimal" },
  };
}

function makeTokens(userId = "alice", isAdmin = false) {
  return {
    validate: vi.fn(
      async (): Promise<TokenResult<TokenPayload>> => ({
        ok: true,
        value: { userId, isAdmin, issuedAt: 0, expiresAt: 9999999999 },
      }),
    ),
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
  };
}

function makeProfileStore(profile: ProfileV1 = sampleProfile()): ProfileStore {
  const getOk: Result<ProfileV1, ProfileStoreError> = { ok: true, value: profile };
  const saveOk: Result<void, ProfileStoreError> = { ok: true, value: undefined };
  return {
    get: vi.fn(async () => getOk),
    save: vi.fn(async () => saveOk),
    remove: vi.fn(async () => saveOk as Result<void, ProfileStoreError>),
  };
}

function makeDeps(tokensOverride?: ReturnType<typeof makeTokens>, profileStoreOverride?: ProfileStore) {
  return {
    tokens: tokensOverride ?? makeTokens(),
    profileStore: profileStoreOverride ?? makeProfileStore(),
    runApply: vi.fn(async () => ({ ok: true as const, value: { state: "ready" as const, elapsedMs: 0 } })),
    handleEdit: vi.fn(async (_req: Request) => new Response("not exercised", { status: 501 })),
  };
}

function makeGetRequest(bearerToken?: string): Request {
  const headers = new Headers();
  if (bearerToken !== undefined) headers.set("authorization", `Bearer ${bearerToken}`);
  return new Request("http://localhost/api/v1/profile/me", { method: "GET", headers });
}

function makePutRequest(body: unknown, bearerToken?: string): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (bearerToken !== undefined) headers.set("authorization", `Bearer ${bearerToken}`);
  return new Request("http://localhost/api/v1/profile/me", {
    method: "PUT",
    headers,
    body: JSON.stringify(body),
  });
}

describe("GET /api/v1/profile/me", () => {
  it("returns the user's profile on 200 with a valid bearer token", async () => {
    const profile = sampleProfile("alice");
    const deps = makeDeps(makeTokens("alice"), makeProfileStore(profile));
    const handler = createProfileHandler(deps);

    const response = await handler(makeGetRequest("valid-token"));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual(profile);
  });

  it("returns 401 when the bearer token is missing or invalid", async () => {
    const missingDeps = makeDeps(makeTokens());
    const missingHandler = createProfileHandler(missingDeps);
    const missingResponse = await missingHandler(makeGetRequest());
    expect(missingResponse.status).toBe(401);

    const invalidDeps = makeDeps(makeInvalidTokens());
    const invalidHandler = createProfileHandler(invalidDeps);
    const invalidResponse = await invalidHandler(makeGetRequest("bad-token"));
    expect(invalidResponse.status).toBe(401);
  });

  it("returns 404 when profile is missing (profile is always provisioner-supplied; missing = corruption)", async () => {
    const profileStore = makeProfileStore();
    profileStore.get = vi.fn(
      async (): Promise<Result<ProfileV1, ProfileStoreError>> => ({ ok: false, error: "not-found" }),
    );
    const deps = makeDeps(makeTokens("alice"), profileStore);
    const handler = createProfileHandler(deps);

    const response = await handler(makeGetRequest("valid-token"));

    expect(response.status).toBe(404);
  });

  it("returns 500 when ProfileStore.get fails with io-error (infrastructure failure)", async () => {
    const profileStore = makeProfileStore();
    profileStore.get = vi.fn(
      async (): Promise<Result<ProfileV1, ProfileStoreError>> => ({ ok: false, error: "io-error" }),
    );
    const deps = makeDeps(makeTokens("alice"), profileStore);
    const handler = createProfileHandler(deps);

    const response = await handler(makeGetRequest("valid-token"));

    expect(response.status).toBe(500);
  });

  it("returns 405 for non-GET methods (only GET and PUT are accepted)", async () => {
    const deps = makeDeps();
    const handler = createProfileHandler(deps);
    const request = new Request("http://localhost/api/v1/profile/me", {
      method: "DELETE",
      headers: new Headers({ authorization: "Bearer valid-token" }),
    });

    const response = await handler(request);

    expect(response.status).toBe(405);
  });
});

describe("PUT /api/v1/profile/me", () => {
  it("validates the body against ProfileV1 schema and returns 422 on parse failure", async () => {
    const deps = makeDeps(makeTokens("alice"));
    const handler = createProfileHandler(deps);

    const response = await handler(makePutRequest({ invalid: "body" }, "valid-token"));

    expect(response.status).toBe(422);
  });

  it("forces the body's userId to match the bearer claim (rejects mismatched userId with 422)", async () => {
    const deps = makeDeps(makeTokens("alice"));
    const handler = createProfileHandler(deps);
    const profileWithWrongUser = sampleProfile("bob");

    const response = await handler(makePutRequest(profileWithWrongUser, "valid-token"));

    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body.error).toBe("userId-mismatch");
  });

  it("persists via profileStore.save and returns the saved profile on 200", async () => {
    const profile = sampleProfile("alice");
    const profileStore = makeProfileStore(profile);
    const deps = makeDeps(makeTokens("alice"), profileStore);
    const handler = createProfileHandler(deps);

    const response = await handler(makePutRequest(profile, "valid-token"));

    expect(response.status).toBe(200);
    expect(profileStore.save).toHaveBeenCalledWith(profile);
    const body = await response.json();
    expect(body).toEqual(profile);
  });

  it("returns 401 when token is invalid", async () => {
    const deps = makeDeps(makeInvalidTokens());
    const handler = createProfileHandler(deps);

    const response = await handler(makePutRequest(sampleProfile("alice"), "bad-token"));

    expect(response.status).toBe(401);
  });

  it("returns 401 when bearer token is missing entirely", async () => {
    const deps = makeDeps(makeTokens("alice"));
    const handler = createProfileHandler(deps);

    const response = await handler(makePutRequest(sampleProfile("alice")));

    expect(response.status).toBe(401);
  });

  it("returns 500 when profileStore.save fails with io-error (infrastructure failure)", async () => {
    const profile = sampleProfile("alice");
    const profileStore = makeProfileStore(profile);
    profileStore.save = vi.fn(async (): Promise<Result<void, ProfileStoreError>> => ({ ok: false, error: "io-error" }));
    const deps = makeDeps(makeTokens("alice"), profileStore);
    const handler = createProfileHandler(deps);

    const response = await handler(makePutRequest(profile, "valid-token"));

    expect(response.status).toBe(500);
  });
});
