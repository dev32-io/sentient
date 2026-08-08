import { type McpCatalog, mcpCatalogSchema } from "@sentient/config";
import type { Result, UserRole } from "@sentient/protocol";
import { describe, expect, it, vi } from "vitest";
import type { ProfileStore, ProfileStoreError } from "../../profile-store/profile-store.js";
import type { ProfileV1 } from "../../profile-store/profile-types.js";
import { defaultPermissionsFor } from "../../tools/role-defaults.js";
import { NEVER_REVOKED } from "../../user-auth/credential-floor.js";
import type { TokenPayload, TokenResult, UserRecord } from "../../user-auth/types.js";
import { createProfileHandler } from "./profile.js";

/** One tool per tier, so a seeded table differs by role. */
const CATALOG: McpCatalog = mcpCatalogSchema.parse({
  household: {
    transport: "http",
    url: "http://127.0.0.1:9000/mcp",
    tools: {
      include: [
        { name: "look_up", tier: "read" },
        { name: "add_to_list", tier: "write" },
        { name: "unlock_door", tier: "confirm" },
      ],
    },
  },
});

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

function makeUsers(role: UserRole = "adult", userId = "alice") {
  const record: UserRecord = {
    userId,
    displayName: "Alice",
    pinHash: "$argon2id$fake-hash",
    role,
    avatarTint: "sage",
    createdAt: "2026-01-01T00:00:00.000Z",
    credentialsValidFrom: NEVER_REVOKED,
  };
  return { get: vi.fn(async () => ({ ok: true as const, value: record })) };
}

function makeTokens(userId = "alice") {
  return {
    validate: vi.fn(
      async (): Promise<TokenResult<TokenPayload>> => ({
        ok: true,
        value: { userId, issuedAt: 0, expiresAt: 9999999999 },
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

function makeDeps(
  tokensOverride?: ReturnType<typeof makeTokens>,
  profileStoreOverride?: ProfileStore,
  usersOverride?: ReturnType<typeof makeUsers>,
) {
  return {
    tokens: tokensOverride ?? makeTokens(),
    profileStore: profileStoreOverride ?? makeProfileStore(),
    users: usersOverride ?? makeUsers(),
    mcpCatalog: CATALOG,
    runApply: vi.fn(async () => ({ ok: true as const, value: { state: "ready" as const, elapsedMs: 0 } })),
    handleEdit: vi.fn(async (_req: Request) => new Response("not exercised", { status: 501 })),
  };
}

/** The profile handed to `profileStore.save`, which is the only thing that
 *  outlives the request. */
function savedProfile(profileStore: ProfileStore): ProfileV1 {
  return (profileStore.save as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as ProfileV1;
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

// ---------------------------------------------------------------------------
// PUT WIRING. What a partial body MEANS is pinned in profile-update.test.ts,
// against the pure function; these are the four things only the handler can get
// wrong — does it pass the stored profile, does it pass the role template, does
// it get the role from the RECORD, and does it fail closed when it cannot read.
// ---------------------------------------------------------------------------
describe("PUT /api/v1/profile/me — partial permission tables", () => {
  const storedTable = {
    household: { look_up: "allow" as const, add_to_list: "ask" as const },
    workshop: { solder: "deny" as const },
  };

  function storedWith(permissions: ProfileV1["tools"]["permissions"]): ProfileStore {
    const profile = sampleProfile("alice");
    return makeProfileStore({ ...profile, tools: { ...profile.tools, permissions } });
  }

  it("applies the body as a delta over the STORED table, not over nothing", async () => {
    const profileStore = storedWith(storedTable);
    const handler = createProfileHandler(makeDeps(makeTokens("alice"), profileStore));
    const body = sampleProfile("alice");

    const response = await handler(
      makePutRequest({ ...body, tools: { ...body.tools, permissions: { household: { look_up: "off" } } } }, "t"),
    );

    expect(response.status).toBe(200);
    expect(savedProfile(profileStore).tools.permissions).toEqual({
      household: { look_up: "off", add_to_list: "ask" },
      workshop: { solder: "deny" },
    });
  });

  it("seeds the template for the role on the RECORD, not a fixed one", async () => {
    const profileStore = storedWith(undefined);
    const handler = createProfileHandler(makeDeps(makeTokens("alice"), profileStore, makeUsers("child")));
    const body = sampleProfile("alice");

    await handler(makePutRequest({ ...body, tools: { toolsets: ["memory"] } }, "t"));

    // The confirm-tier tool is absent and the two tiers a child does reach are
    // present — an adult's template would carry all three.
    expect(savedProfile(profileStore).tools.permissions).toEqual(defaultPermissionsFor("child", CATALOG));
    expect(savedProfile(profileStore).tools.permissions?.household?.unlock_door).toBeUndefined();
    expect(savedProfile(profileStore).tools.permissions?.household?.look_up).toBe("allow");
  });

  // THE ORDERING, end to end. Seeding runs BEFORE the delta, so a body naming
  // one permission comes out complete. The other order — merge, then seed only
  // if the result is still absent — leaves a one-entry table and no template,
  // permanently, and a partial body is the shape the settings panes send.
  it("seeds the WHOLE template and puts a partial body on top of it", async () => {
    const profileStore = storedWith(undefined);
    const handler = createProfileHandler(makeDeps(makeTokens("alice"), profileStore, makeUsers("adult")));
    const body = sampleProfile("alice");

    await handler(
      makePutRequest({ ...body, tools: { ...body.tools, permissions: { household: { look_up: "off" } } } }, "t"),
    );

    const saved = savedProfile(profileStore).tools.permissions;
    // The body's one opinion…
    expect(saved?.household?.look_up).toBe("off");
    // …and every OTHER tool an adult reaches, which merge-then-seed dropped.
    expect(saved).toEqual({
      ...defaultPermissionsFor("adult", CATALOG),
      household: { ...defaultPermissionsFor("adult", CATALOG).household, look_up: "off" },
    });
    expect(Object.keys(saved ?? {})).toEqual(Object.keys(defaultPermissionsFor("adult", CATALOG)));
  });

  // Seeding fills PERMISSIONS and nothing else. `applyProfileDefaults` also
  // refills `tools.toolsets` whenever it is empty, and an empty toolsets list
  // is legal and meaningful — "no built-ins, MCP-only" — so routing this path
  // through it would hand four Hermes toolsets back to somebody who had just
  // turned them all off.
  it("seeds permissions without refilling an explicitly empty toolsets list", async () => {
    const profileStore = storedWith(undefined);
    const handler = createProfileHandler(makeDeps(makeTokens("alice"), profileStore, makeUsers("adult")));
    const body = sampleProfile("alice");

    await handler(makePutRequest({ ...body, tools: { toolsets: [] } }, "t"));

    expect(savedProfile(profileStore).tools.toolsets).toEqual([]);
    expect(savedProfile(profileStore).tools.permissions).toEqual(defaultPermissionsFor("adult", CATALOG));
  });

  it("refuses the save when the stored profile cannot be read, rather than merging onto nothing", async () => {
    const profileStore = makeProfileStore();
    profileStore.get = vi.fn(
      async (): Promise<Result<ProfileV1, ProfileStoreError>> => ({ ok: false, error: "corrupt-file" }),
    );
    const handler = createProfileHandler(makeDeps(makeTokens("alice"), profileStore));
    const body = sampleProfile("alice");

    const response = await handler(
      makePutRequest({ ...body, tools: { ...body.tools, permissions: { household: { look_up: "off" } } } }, "t"),
    );

    // A table may well exist that this read could not see; writing the body's
    // three keys over it would delete settings the person can still see in
    // another window.
    expect(response.status).toBe(500);
    expect(profileStore.save).not.toHaveBeenCalled();
  });

  it("saves normally when there is simply no profile stored yet", async () => {
    const profileStore = makeProfileStore();
    profileStore.get = vi.fn(
      async (): Promise<Result<ProfileV1, ProfileStoreError>> => ({ ok: false, error: "not-found" }),
    );
    const handler = createProfileHandler(makeDeps(makeTokens("alice"), profileStore, makeUsers("adult")));
    const body = sampleProfile("alice");

    const response = await handler(makePutRequest({ ...body, tools: { toolsets: ["memory"] } }, "t"));

    expect(response.status).toBe(200);
    expect(savedProfile(profileStore).tools.permissions).toEqual(defaultPermissionsFor("adult", CATALOG));
  });

  it("saves the profile unchanged when the account's role cannot be read", async () => {
    const profileStore = storedWith(undefined);
    const users = { get: vi.fn(async () => ({ ok: false as const, error: "io-error" as const })) };
    const handler = createProfileHandler(
      makeDeps(makeTokens("alice"), profileStore, users as unknown as ReturnType<typeof makeUsers>),
    );
    const body = sampleProfile("alice");

    const response = await handler(makePutRequest({ ...body, tools: { toolsets: ["memory"] } }, "t"));

    // Seeding is a repair, not a grant: failing it leaves the profile exactly
    // as complete as it already was and grants nothing, so it must not cost
    // the person the voice change they came here to make.
    expect(response.status).toBe(200);
    expect(savedProfile(profileStore).tools.permissions).toBeUndefined();
  });
});
