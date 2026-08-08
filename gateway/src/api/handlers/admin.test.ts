import { describe, expect, it, vi } from "vitest";
import type {
  CreateError,
  DeleteError,
  ResetError,
  SetRoleError,
  UserProvisioner,
} from "../../admin/user-provisioner.js";
import { PROFILE_SCHEMA_VERSION } from "../../profile-store/profile-types.js";
import type { UserRecord } from "../../user-auth/types.js";
import type { UserStore } from "../../user-auth/user-store.js";
import { type AdminDeps, createAdminHandler } from "./admin.js";

// --- Log capture for security redaction tests ---------------------------------

const logCalls: Array<{ message: string; properties?: Record<string, unknown> }> = [];

function pushLog(message: string, properties?: Record<string, unknown>) {
  logCalls.push(properties ? { message, properties } : { message });
}

vi.mock("../../logging/logger.js", () => ({
  getLog: (_tags: string[]) => ({
    debug: (message: string, properties?: Record<string, unknown>) => pushLog(message, properties),
    info: (message: string, properties?: Record<string, unknown>) => pushLog(message, properties),
    warn: (message: string, properties?: Record<string, unknown>) => pushLog(message, properties),
    error: (message: string, properties?: Record<string, unknown>) => pushLog(message, properties),
  }),
}));

// --- Test fixtures -----------------------------------------------------------

const ADMIN_TOKEN = "test-admin-token";

function sampleUser(overrides?: Partial<UserRecord>): UserRecord {
  return {
    userId: "u_abc123",
    displayName: "Alice",
    pinHash: "$argon2id$fake",
    role: "admin",
    avatarTint: "terra",
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeUserStore(users: UserRecord[] = []): UserStore {
  return {
    list: vi.fn(async () => ({ ok: true as const, value: users })),
    get: vi.fn(async (id: string) => {
      const found = users.find((u) => u.userId === id) ?? null;
      return { ok: true as const, value: found };
    }),
    add: vi.fn(async () => ({ ok: true as const, value: undefined })),
    update: vi.fn(async () => ({ ok: true as const, value: undefined })),
    remove: vi.fn(async () => ({ ok: true as const, value: undefined })),
  };
}

function makeProvisioner(): UserProvisioner {
  return {
    createUser: vi.fn(async () => ({
      ok: true as const,
      value: {
        userId: "u_11111111",
        displayName: "Bob",
        role: "adult" as const,
        isAdmin: false,
        avatarTint: "sage" as const,
        createdAt: "2026-04-25T00:00:00Z",
      },
    })),
    deleteUser: vi.fn(async () => ({ ok: true as const, value: undefined })),
    resetPin: vi.fn(async () => ({ ok: true as const, value: undefined })),
    setRole: vi.fn(async () => ({ ok: true as const, value: undefined })),
  };
}

function makeDeps(overrides?: Partial<AdminDeps>): AdminDeps {
  return {
    adminToken: ADMIN_TOKEN,
    provisioner: makeProvisioner(),
    userStore: makeUserStore(),
    ...overrides,
  } as AdminDeps;
}

function authHeader(token = ADMIN_TOKEN): Headers {
  return new Headers({ authorization: `Bearer ${token}` });
}

function adminUrl(path: string): string {
  return `http://localhost${path}`;
}

/** Minimal valid profile body (no userId / schemaVersion — those are server-stamped). */
const SAMPLE_PROFILE = {
  model: { provider: "openrouter", id: "google/gemini-2.5-flash" },
  voice: { provider: "local-tts", id: "default" },
  persona: { template: "default", overrides: "" },
  tools: {
    enabled: { gateway: [] },
    toolsets: ["memory"],
  },
  compression: { threshold: 0.5 },
  advanced: { extraSystemPrompt: "", maxTokens: 1024, reasoningEffort: "minimal" },
};

// --- Tests -------------------------------------------------------------------

describe("GET /api/v1/admin/users", () => {
  it("returns users without leaking the pin hash", async () => {
    const alice = sampleUser();
    const deps = makeDeps({
      userStore: makeUserStore([alice]),
    });
    const handler = createAdminHandler(deps);

    const res = await handler(
      new Request(adminUrl("/api/v1/admin/users"), {
        headers: authHeader(),
      }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.users).toHaveLength(1);
    expect(body.users[0].userId).toBe("u_abc123");
    expect(body.users[0].pinHash).toBeUndefined();
  });

  it("returns 500 when userStore.list fails", async () => {
    const userStore = makeUserStore();
    (userStore.list as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, error: "io-error" });
    const deps = makeDeps({ userStore });
    const handler = createAdminHandler(deps);

    const res = await handler(
      new Request(adminUrl("/api/v1/admin/users"), {
        headers: authHeader(),
      }),
    );

    expect(res.status).toBe(500);
  });

  it("returns 401 when caller is not admin", async () => {
    const handler = createAdminHandler(makeDeps());

    const res = await handler(
      new Request(adminUrl("/api/v1/admin/users"), {
        headers: authHeader("wrong-token"),
      }),
    );

    expect(res.status).toBe(401);
  });
});

describe("POST /api/v1/admin/users", () => {
  it("returns 201 with the new user (no pinHash) when provisioner succeeds", async () => {
    const handler = createAdminHandler(makeDeps());

    const res = await handler(
      new Request(adminUrl("/api/v1/admin/users"), {
        method: "POST",
        headers: authHeader(),
        body: JSON.stringify({ displayName: "Bob", pin: "5678", isAdmin: false, profile: SAMPLE_PROFILE }),
      }),
    );

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.user.displayName).toBe("Bob");
    expect(body.user.pinHash).toBeUndefined();
    expect(body.user.pin).toBeUndefined();
  });

  it("passes schemaVersion and empty userId to provisioner (server-stamped)", async () => {
    const provisioner = makeProvisioner();
    const handler = createAdminHandler(makeDeps({ provisioner }));

    await handler(
      new Request(adminUrl("/api/v1/admin/users"), {
        method: "POST",
        headers: authHeader(),
        body: JSON.stringify({ displayName: "Bob", pin: "5678", isAdmin: false, profile: SAMPLE_PROFILE }),
      }),
    );

    const call = (provisioner.createUser as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(call?.profile?.schemaVersion).toBe(PROFILE_SCHEMA_VERSION);
    expect(call?.profile?.userId).toBe("");
  });

  // REGRESSION, and the shape is the live one: the web wizard's INITIAL_DRAFT
  // and mobile's templateMemberProfile both POST `tools: { enabled: {} }`. The
  // whole chain has to survive it — migration → applyProfileDefaults → what the
  // provisioner persists — because a break anywhere in it hands every new user
  // an assistant with no MCP tools at all, silently. The suite used to stub
  // this exact body and assert nothing about `tools`, which is why it shipped.
  it("REGRESSION: a wizard-shaped empty tools.enabled still seeds the starter permissions", async () => {
    const provisioner = makeProvisioner();
    const handler = createAdminHandler(makeDeps({ provisioner }));

    await handler(
      new Request(adminUrl("/api/v1/admin/users"), {
        method: "POST",
        headers: authHeader(),
        body: JSON.stringify({
          displayName: "Bob",
          pin: "5678",
          isAdmin: false,
          profile: { ...SAMPLE_PROFILE, tools: { enabled: {}, toolsets: [] } },
        }),
      }),
    );

    const call = (provisioner.createUser as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(call?.profile?.tools?.permissions).toEqual({
      home_assistant: {},
      gateway: {},
      music_assistant: {},
      searxng: {},
      fetch: {},
    });
  });

  it("REGRESSION: an EXPLICIT empty permissions map is preserved, not re-seeded", async () => {
    const provisioner = makeProvisioner();
    const handler = createAdminHandler(makeDeps({ provisioner }));

    await handler(
      new Request(adminUrl("/api/v1/admin/users"), {
        method: "POST",
        headers: authHeader(),
        body: JSON.stringify({
          displayName: "Bob",
          pin: "5678",
          isAdmin: false,
          // Not the wizard's "not configured yet" — a table naming no server,
          // i.e. somebody switched every one of them off. Must not collapse
          // into the case above.
          profile: { ...SAMPLE_PROFILE, tools: { permissions: {}, toolsets: [] } },
        }),
      }),
    );

    const call = (provisioner.createUser as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(call?.profile?.tools?.permissions).toEqual({});
  });

  it("returns 422 'schema' when displayName is empty", async () => {
    const handler = createAdminHandler(makeDeps());

    const res = await handler(
      new Request(adminUrl("/api/v1/admin/users"), {
        method: "POST",
        headers: authHeader(),
        body: JSON.stringify({ displayName: "", pin: "5678", isAdmin: false, profile: SAMPLE_PROFILE }),
      }),
    );

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe("schema");
  });

  it("returns 422 'schema' when pin is not 4 digits", async () => {
    const handler = createAdminHandler(makeDeps());

    const res = await handler(
      new Request(adminUrl("/api/v1/admin/users"), {
        method: "POST",
        headers: authHeader(),
        body: JSON.stringify({ displayName: "Bob", pin: "abc", isAdmin: false, profile: SAMPLE_PROFILE }),
      }),
    );

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe("schema");
  });

  it("returns 422 'schema' when profile is missing from body", async () => {
    const handler = createAdminHandler(makeDeps());

    const res = await handler(
      new Request(adminUrl("/api/v1/admin/users"), {
        method: "POST",
        headers: authHeader(),
        body: JSON.stringify({ displayName: "Bob", pin: "5678", isAdmin: false }),
      }),
    );

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe("schema");
  });

  it("returns 422 'schema' when profile has an invalid model provider", async () => {
    const handler = createAdminHandler(makeDeps());
    const badProfile = { ...SAMPLE_PROFILE, model: { provider: "unknown-provider", id: "some-model" } };

    const res = await handler(
      new Request(adminUrl("/api/v1/admin/users"), {
        method: "POST",
        headers: authHeader(),
        body: JSON.stringify({ displayName: "Bob", pin: "5678", isAdmin: false, profile: badProfile }),
      }),
    );

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe("schema");
  });

  it("returns 401 when caller is not admin", async () => {
    const handler = createAdminHandler(makeDeps());

    const res = await handler(
      new Request(adminUrl("/api/v1/admin/users"), {
        method: "POST",
        headers: authHeader("wrong-token"),
        body: JSON.stringify({ displayName: "Bob", pin: "5678", isAdmin: false, profile: SAMPLE_PROFILE }),
      }),
    );

    expect(res.status).toBe(401);
  });

  it("response body never echoes the input pin (regex check)", async () => {
    const handler = createAdminHandler(makeDeps());

    const res = await handler(
      new Request(adminUrl("/api/v1/admin/users"), {
        method: "POST",
        headers: authHeader(),
        body: JSON.stringify({ displayName: "Bob", pin: "5678", isAdmin: false, profile: SAMPLE_PROFILE }),
      }),
    );

    const text = await res.text();
    expect(text).not.toMatch(/5678/);
  });

  it("returns 502 'apply-error' when provisioner returns apply-error", async () => {
    const provisioner = makeProvisioner();
    (provisioner.createUser as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      error: "apply-error" as CreateError,
    });
    const handler = createAdminHandler(makeDeps({ provisioner }));

    const res = await handler(
      new Request(adminUrl("/api/v1/admin/users"), {
        method: "POST",
        headers: authHeader(),
        body: JSON.stringify({ displayName: "Bob", pin: "5678", isAdmin: false, profile: SAMPLE_PROFILE }),
      }),
    );

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe("apply-error");
  });

  it("returns 422 'schema' when body is not valid JSON", async () => {
    const handler = createAdminHandler(makeDeps());

    const res = await handler(
      new Request(adminUrl("/api/v1/admin/users"), {
        method: "POST",
        headers: authHeader(),
        body: "not-json",
      }),
    );

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe("schema");
  });
});

describe("DELETE /api/v1/admin/users/:id", () => {
  it("returns 204 on success", async () => {
    const handler = createAdminHandler(makeDeps());

    const res = await handler(
      new Request(adminUrl("/api/v1/admin/users/u_abc123"), {
        method: "DELETE",
        headers: authHeader(),
      }),
    );

    expect(res.status).toBe(204);
  });

  it("returns 404 when provisioner returns not-found", async () => {
    const provisioner = makeProvisioner();
    (provisioner.deleteUser as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      error: "not-found" as DeleteError,
    });
    const handler = createAdminHandler(makeDeps({ provisioner }));

    const res = await handler(
      new Request(adminUrl("/api/v1/admin/users/u_missing"), {
        method: "DELETE",
        headers: authHeader(),
      }),
    );

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("not-found");
  });

  it("returns 422 'last-admin' when guard trips", async () => {
    const provisioner = makeProvisioner();
    (provisioner.deleteUser as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      error: "last-admin" as DeleteError,
    });
    const handler = createAdminHandler(makeDeps({ provisioner }));

    const res = await handler(
      new Request(adminUrl("/api/v1/admin/users/u_only_admin"), {
        method: "DELETE",
        headers: authHeader(),
      }),
    );

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe("last-admin");
  });

  it("returns 500 on io-error", async () => {
    const provisioner = makeProvisioner();
    (provisioner.deleteUser as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      error: "io-error" as DeleteError,
    });
    const handler = createAdminHandler(makeDeps({ provisioner }));

    const res = await handler(
      new Request(adminUrl("/api/v1/admin/users/u_abc123"), {
        method: "DELETE",
        headers: authHeader(),
      }),
    );

    expect(res.status).toBe(500);
  });
});

describe("POST /api/v1/admin/users/:id/reset-pin", () => {
  it("returns 204 on success", async () => {
    const handler = createAdminHandler(makeDeps());

    const res = await handler(
      new Request(adminUrl("/api/v1/admin/users/u_abc123/reset-pin"), {
        method: "POST",
        headers: authHeader(),
        body: JSON.stringify({ pin: "9999" }),
      }),
    );

    expect(res.status).toBe(204);
  });

  it("returns 404 when provisioner returns not-found", async () => {
    const provisioner = makeProvisioner();
    (provisioner.resetPin as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      error: "not-found" as ResetError,
    });
    const handler = createAdminHandler(makeDeps({ provisioner }));

    const res = await handler(
      new Request(adminUrl("/api/v1/admin/users/u_missing/reset-pin"), {
        method: "POST",
        headers: authHeader(),
        body: JSON.stringify({ pin: "9999" }),
      }),
    );

    expect(res.status).toBe(404);
  });

  it("returns 422 'schema' when pin is not 4 digits", async () => {
    const handler = createAdminHandler(makeDeps());

    const res = await handler(
      new Request(adminUrl("/api/v1/admin/users/u_abc123/reset-pin"), {
        method: "POST",
        headers: authHeader(),
        body: JSON.stringify({ pin: "abc" }),
      }),
    );

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe("schema");
  });

  it("returns 500 on io-error", async () => {
    const provisioner = makeProvisioner();
    (provisioner.resetPin as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      error: "io-error" as ResetError,
    });
    const handler = createAdminHandler(makeDeps({ provisioner }));

    const res = await handler(
      new Request(adminUrl("/api/v1/admin/users/u_abc123/reset-pin"), {
        method: "POST",
        headers: authHeader(),
        body: JSON.stringify({ pin: "9999" }),
      }),
    );

    expect(res.status).toBe(500);
  });
});

describe("PATCH /api/v1/admin/users/:id", () => {
  it("returns 200 with the updated user when demoting a non-last admin", async () => {
    const alice = sampleUser({ role: "admin" });
    const bob = sampleUser({ userId: "u_bob00000", role: "admin" });
    const provisioner = makeProvisioner();
    const userStore = makeUserStore([alice, bob]);
    (userStore.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true as const,
      value: { ...alice, role: "adult" },
    });
    const handler = createAdminHandler(makeDeps({ provisioner, userStore }));

    const res = await handler(
      new Request(adminUrl("/api/v1/admin/users/u_abc123"), {
        method: "PATCH",
        headers: authHeader(),
        body: JSON.stringify({ isAdmin: false }),
      }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user.isAdmin).toBe(false);
    expect(body.user.pinHash).toBeUndefined();
  });

  it("returns 422 'last-admin' when demoting the only admin", async () => {
    const provisioner = makeProvisioner();
    (provisioner.setRole as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      error: "last-admin" as SetRoleError,
    });
    const handler = createAdminHandler(makeDeps({ provisioner }));

    const res = await handler(
      new Request(adminUrl("/api/v1/admin/users/u_abc123"), {
        method: "PATCH",
        headers: authHeader(),
        body: JSON.stringify({ isAdmin: false }),
      }),
    );

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe("last-admin");
  });

  it("returns 404 when user does not exist", async () => {
    const provisioner = makeProvisioner();
    (provisioner.setRole as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      error: "not-found" as SetRoleError,
    });
    const handler = createAdminHandler(makeDeps({ provisioner }));

    const res = await handler(
      new Request(adminUrl("/api/v1/admin/users/u_missing"), {
        method: "PATCH",
        headers: authHeader(),
        body: JSON.stringify({ isAdmin: true }),
      }),
    );

    expect(res.status).toBe(404);
  });

  it("returns 422 'schema' when body has invalid fields", async () => {
    const handler = createAdminHandler(makeDeps());

    const res = await handler(
      new Request(adminUrl("/api/v1/admin/users/u_abc123"), {
        method: "PATCH",
        headers: authHeader(),
        body: JSON.stringify({ isAdmin: "yes" }),
      }),
    );

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe("schema");
  });
});

describe("GET /api/v1/admin/ping", () => {
  it("returns pong", async () => {
    const handler = createAdminHandler(makeDeps());

    const res = await handler(
      new Request(adminUrl("/api/v1/admin/ping"), {
        headers: authHeader(),
      }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("pong");
  });
});

describe("Unknown admin path", () => {
  it("returns 404", async () => {
    const handler = createAdminHandler(makeDeps());

    const res = await handler(
      new Request(adminUrl("/api/v1/admin/unknown"), {
        headers: authHeader(),
      }),
    );

    expect(res.status).toBe(404);
  });
});
