import { ALL_TOOLS_PERMISSION_KEY, type HermesBuiltinTools, type McpCatalog, mcpCatalogSchema } from "@sentient/config";
import type { Result, UserRole } from "@sentient/protocol";
import { describe, expect, it, vi } from "vitest";
import { createAccessManager } from "../../access/access-manager.js";
import { createUserPrincipal } from "../../identity/user-principal.js";
import type { ProfileStore, ProfileStoreError } from "../../profile-store/profile-store.js";
import type { ProfileV1 } from "../../profile-store/profile-types.js";
import type { McpClient, McpToolRef } from "../../tools/mcp-client.js";
import { createToolBroker } from "../../tools/tool-broker.js";
import { NEVER_REVOKED } from "../../user-auth/credential-floor.js";
import type { TokenPayload, TokenResult, UserRecord } from "../../user-auth/types.js";
import type { UserStore } from "../../user-auth/user-store.js";
import { type McpCatalogView, createMcpCatalogHandler } from "./mcp-catalog.js";

/**
 * One server with one tool per tier plus a second write-tier tool (`wipe_data`,
 * used by the broker-agreement suite to exercise a stored `off`), and one
 * `stdio` server — the shape `gateway/config.yaml#mcp_catalog`'s real
 * `gateway:` entry has — so the exclusion decision is exercised against a
 * catalog, not just documented in prose.
 */
const CATALOG: McpCatalog = mcpCatalogSchema.parse({
  household: {
    transport: "http",
    url: "http://127.0.0.1:9000/mcp",
    tools: {
      include: [
        { name: "look_up", tier: "read", description: "looks something up" },
        { name: "add_to_list", tier: "write", description: "adds an item to a list" },
        { name: "wipe_data", tier: "write", description: "wipes household data" },
        { name: "unlock_door", tier: "confirm", description: "unlocks the front door" },
      ],
    },
  },
  gateway: {
    transport: "stdio",
    command: "nc",
    args: ["-U", "/tmp/mcp.sock"],
    tools: {
      include: [{ name: "identify_user", tier: "read", description: "identifies the caller" }],
    },
  },
});

function sampleProfile(userId: string, permissions?: ProfileV1["tools"]["permissions"]): ProfileV1 {
  return {
    schemaVersion: 1,
    userId,
    model: { provider: "openrouter", id: "google/gemini-2.5-flash" },
    voice: { provider: "local-tts", id: "default" },
    audio: { ttsEnabled: true, channel: "voice" as const },
    persona: { template: "default", overrides: "" },
    tools: { permissions, toolsets: [] },
    compression: { threshold: 0.5 },
    advanced: { extraSystemPrompt: "", maxTokens: 1024, reasoningEffort: "minimal" },
  };
}

function makeUsers(role: UserRole = "adult", userId = "alice"): Pick<UserStore, "get"> {
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
      async (): Promise<TokenResult<TokenPayload>> => ({ ok: false, error: "signature-invalid" as const }),
    ),
  };
}

function makeProfileStore(profile: ProfileV1): ProfileStore {
  const getOk: Result<ProfileV1, ProfileStoreError> = { ok: true, value: profile };
  return {
    get: vi.fn(async () => getOk),
    save: vi.fn(async () => ({ ok: true as const, value: undefined })),
    remove: vi.fn(async () => ({ ok: true as const, value: undefined })),
  };
}

/** Answers `get` from a queue, one result per call, holding the last result
 *  for any call past the end of the queue — for exercising "a read that
 *  SUCCEEDED, then later fails" across multiple requests through the SAME
 *  handler instance. */
function profileStoreReturning(...results: Array<Result<ProfileV1, ProfileStoreError>>): ProfileStore {
  let i = 0;
  const refuse = (): never => {
    throw new Error("not used by this test");
  };
  return {
    get: vi.fn(async () => results[Math.min(i++, results.length - 1)] as Result<ProfileV1, ProfileStoreError>),
    save: refuse,
    remove: refuse,
  };
}

const NO_HERMES_BUILTINS: HermesBuiltinTools = [];

function makeDeps(opts: {
  role?: UserRole;
  permissions?: ProfileV1["tools"]["permissions"];
  catalog?: McpCatalog;
  tokens?: ReturnType<typeof makeTokens>;
  users?: Pick<UserStore, "get">;
  profileStore?: ProfileStore;
}) {
  return {
    tokens: opts.tokens ?? makeTokens(),
    catalog: opts.catalog ?? CATALOG,
    hermesBuiltinTools: NO_HERMES_BUILTINS,
    users: opts.users ?? makeUsers(opts.role ?? "adult"),
    profileStore: opts.profileStore ?? makeProfileStore(sampleProfile("alice", opts.permissions)),
  };
}

function makeGetRequest(bearerToken?: string): Request {
  const headers = new Headers();
  if (bearerToken !== undefined) headers.set("authorization", `Bearer ${bearerToken}`);
  return new Request("http://localhost/api/v1/mcp-catalog", { method: "GET", headers });
}

/** Tool names present in a projected server's `tools`, for order-independent
 *  presence assertions. */
function names(view: McpCatalogView, server: string): string[] {
  return (view.servers[server]?.tools ?? []).map((t) => t.name).sort();
}

function permissionOf(view: McpCatalogView, server: string, tool: string) {
  return view.servers[server]?.tools.find((t) => t.name === tool)?.permission;
}

/** A native tool by name — the projection carries several now (five skill tools
 *  plus `delegateTask`), so index-based lookups are no longer stable. */
function nativeTool(view: McpCatalogView, name: string) {
  return view.nativeTools.find((t) => t.name === name);
}

function nativeToolNames(view: McpCatalogView): string[] {
  return view.nativeTools.map((t) => t.name).sort();
}

describe("GET /api/v1/mcp-catalog — auth", () => {
  it("returns 401 when the bearer token is missing", async () => {
    const handler = createMcpCatalogHandler(makeDeps({}));
    const response = await handler(makeGetRequest());
    expect(response.status).toBe(401);
  });

  it("returns 401 when the bearer token is invalid", async () => {
    const handler = createMcpCatalogHandler(makeDeps({ tokens: makeInvalidTokens() }));
    const response = await handler(makeGetRequest("bad-token"));
    expect(response.status).toBe(401);
  });

  it("returns 405 for non-GET methods", async () => {
    const handler = createMcpCatalogHandler(makeDeps({}));
    const response = await handler(new Request("http://localhost/api/v1/mcp-catalog", { method: "POST" }));
    expect(response.status).toBe(405);
  });

  it("returns 500 with 'role-unavailable' when the account's role record cannot be read", async () => {
    const users: Pick<UserStore, "get"> = {
      get: vi.fn(async () => ({ ok: false as const, error: "io-error" as const })),
    };
    const handler = createMcpCatalogHandler(makeDeps({ users }));

    const response = await handler(makeGetRequest("valid-token"));

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toBe("role-unavailable");
  });
});

describe("GET /api/v1/mcp-catalog — the permission reader persists per user (matches the ToolBroker's own reader contract)", () => {
  it("serves the LAST-KNOWN-GOOD table on a later transient read failure, not a fresh empty one", async () => {
    // Same failure-CLASS distinction `user-tool-permissions.ts` itself
    // documents: a read that already succeeded outranks the error class on
    // every later call. `createMcpCatalogHandler` must hold ONE reader per
    // user across requests for that contract to reach this endpoint at all —
    // a fresh `createToolPermissionsReader` per request has no memory of the
    // first call's success and would fail-closed all the way to "off".
    const profileStore = profileStoreReturning(
      { ok: true, value: sampleProfile("alice", { household: { add_to_list: "deny" } }) },
      { ok: false, error: "io-error" },
    );
    const handler = createMcpCatalogHandler(makeDeps({ role: "adult", profileStore }));

    const first = (await (await handler(makeGetRequest("valid-token"))).json()) as McpCatalogView;
    const second = (await (await handler(makeGetRequest("valid-token"))).json()) as McpCatalogView;

    expect(permissionOf(first, "household", "add_to_list")).toBe("deny");
    // The second call's underlying read failed — if this fell back to a
    // fresh DENY_EVERY_SERVER table instead of the first call's success,
    // `look_up` would come back "off" here instead of its stored/template
    // answer, and every tool would swing to "off" on a transient hiccup.
    expect(permissionOf(second, "household", "add_to_list")).toBe("deny");
    expect(permissionOf(second, "household", "look_up")).toBe("allow");
  });

  it("keeps readers SEPARATE per user — one user's success or failure never leaks into another's on the SAME handler", async () => {
    // One handler instance serving two different accounts, as it does in
    // production (`createMcpCatalogHandler` is built once at server start).
    const userRecordFor = (userId: string): UserRecord => ({
      userId,
      displayName: userId,
      pinHash: "$argon2id$fake-hash",
      role: "adult",
      avatarTint: "sage",
      createdAt: "2026-01-01T00:00:00.000Z",
      credentialsValidFrom: NEVER_REVOKED,
    });
    const deps = {
      tokens: {
        validate: vi.fn(async (token: string): Promise<TokenResult<TokenPayload>> => {
          const userId = token === "alice-token" ? "alice" : "bob";
          return { ok: true, value: { userId, issuedAt: 0, expiresAt: 9999999999 } };
        }),
      },
      catalog: CATALOG,
      hermesBuiltinTools: NO_HERMES_BUILTINS,
      users: { get: vi.fn(async (userId: string) => ({ ok: true as const, value: userRecordFor(userId) })) },
      profileStore: {
        get: vi.fn(async (userId: string): Promise<Result<ProfileV1, ProfileStoreError>> => {
          if (userId === "alice")
            return { ok: true, value: sampleProfile("alice", { household: { add_to_list: "deny" } }) };
          return { ok: false, error: "io-error" };
        }),
        save: vi.fn(),
        remove: vi.fn(),
      } satisfies ProfileStore,
    };
    const handler = createMcpCatalogHandler(deps);

    const aliceFirst = (await (await handler(makeGetRequest("alice-token"))).json()) as McpCatalogView;
    const bob = (await (await handler(makeGetRequest("bob-token"))).json()) as McpCatalogView;
    const aliceSecond = (await (await handler(makeGetRequest("alice-token"))).json()) as McpCatalogView;

    expect(permissionOf(aliceFirst, "household", "add_to_list")).toBe("deny");
    // bob's own reader has NEVER succeeded — it must not inherit alice's
    // cached table just because her reader (in the same handler) has one.
    expect(permissionOf(bob, "household", "look_up")).toBe("off");
    // …and alice's own answer is unaffected by bob's failure on the same handler.
    expect(permissionOf(aliceSecond, "household", "add_to_list")).toBe("deny");
  });
});

describe("GET /api/v1/mcp-catalog — every tool carries a real permission and tier", () => {
  it("projects the ROLE TEMPLATE's answer for an account with NO permission table at all (every account on disk today)", async () => {
    // `permissions` is genuinely UNSET here — not `{}` — which is the actual
    // shape of every profile that predates per-tool permissions.
    const handler = createMcpCatalogHandler(makeDeps({ role: "adult", permissions: undefined }));

    const response = await handler(makeGetRequest("valid-token"));
    const view = (await response.json()) as McpCatalogView;

    expect(response.status).toBe(200);
    const tools = view.servers.household?.tools ?? [];
    expect(tools.find((t) => t.name === "look_up")).toEqual({
      name: "look_up",
      description: "looks something up",
      tier: "read",
      permission: "allow",
      settable: true,
    });
    expect(tools.find((t) => t.name === "add_to_list")).toMatchObject({ tier: "write", permission: "ask" });
    expect(tools.find((t) => t.name === "unlock_door")).toMatchObject({ tier: "confirm", permission: "ask" });
  });

  it("marks every catalog tool 'settable' — a stored table CAN address it", async () => {
    const handler = createMcpCatalogHandler(makeDeps({ role: "adult" }));

    const view = (await (await handler(makeGetRequest("valid-token"))).json()) as McpCatalogView;

    for (const tool of view.servers.household?.tools ?? []) {
      expect(tool.settable).toBe(true);
    }
  });

  it("an empty table ({}) is a DIFFERENT case — every catalog tool resolves 'off', not the template", async () => {
    const handler = createMcpCatalogHandler(makeDeps({ role: "adult", permissions: {} }));

    const view = (await (await handler(makeGetRequest("valid-token"))).json()) as McpCatalogView;

    expect(permissionOf(view, "household", "look_up")).toBe("off");
    expect(permissionOf(view, "household", "add_to_list")).toBe("off");
    expect(permissionOf(view, "household", "unlock_door")).toBe("off");
  });

  it("projects the person's OWN stored override ahead of the role template", async () => {
    const handler = createMcpCatalogHandler(
      makeDeps({ role: "adult", permissions: { household: { add_to_list: "deny" } } }),
    );

    const view = (await (await handler(makeGetRequest("valid-token"))).json()) as McpCatalogView;

    expect(permissionOf(view, "household", "add_to_list")).toBe("deny");
    // The rest of the server still falls to the template — one stored key
    // must not silently answer for its neighbours.
    expect(permissionOf(view, "household", "look_up")).toBe("allow");
  });

  it("keeps an explicitly 'off' tool LISTED (it is a real, person-editable state, not a locked row)", async () => {
    const handler = createMcpCatalogHandler(makeDeps({ role: "adult", permissions: { household: { "*": "off" } } }));

    const view = (await (await handler(makeGetRequest("valid-token"))).json()) as McpCatalogView;

    expect(names(view, "household")).toEqual(["add_to_list", "look_up", "unlock_door", "wipe_data"]);
    expect(permissionOf(view, "household", "look_up")).toBe("off");
  });
});

describe("GET /api/v1/mcp-catalog — the server-level wildcard is expressible and obvious", () => {
  it("reports the top-level sentinel key so a client never hardcodes the literal '*'", async () => {
    const handler = createMcpCatalogHandler(makeDeps({ role: "adult" }));

    const view = (await (await handler(makeGetRequest("valid-token"))).json()) as McpCatalogView;

    expect(view.wildcardPermissionKey).toBe(ALL_TOOLS_PERMISSION_KEY);
  });

  it("reports null when the person has not set a wildcard — distinct from a wildcard set to a value", async () => {
    const unsetView = (await (
      await createMcpCatalogHandler(makeDeps({ role: "adult", permissions: undefined }))(makeGetRequest("valid-token"))
    ).json()) as McpCatalogView;
    const setView = (await (
      await createMcpCatalogHandler(makeDeps({ role: "adult", permissions: { household: { "*": "deny" } } }))(
        makeGetRequest("valid-token"),
      )
    ).json()) as McpCatalogView;

    expect(unsetView.servers.household?.wildcardPermission).toBeNull();
    expect(setView.servers.household?.wildcardPermission).toBe("deny");
  });

  it("does NOT report a wildcard for a server that is merely absent from the stored table (a different mechanism)", async () => {
    // The table names a DIFFERENT server, so `household` is absent from it —
    // the absent-server rule resolves every household tool to "off", but
    // nobody set household's own "*" key, and `wildcardPermission` must say so.
    const handler = createMcpCatalogHandler(makeDeps({ role: "adult", permissions: { "other-server": {} } }));

    const view = (await (await handler(makeGetRequest("valid-token"))).json()) as McpCatalogView;

    expect(permissionOf(view, "household", "look_up")).toBe("off");
    expect(view.servers.household?.wildcardPermission).toBeNull();
  });
});

describe("GET /api/v1/mcp-catalog — role-based omission", () => {
  it("a guest sees only the read-tier tool, never a write- or confirm-tier one", async () => {
    const handler = createMcpCatalogHandler(makeDeps({ role: "guest" }));

    const view = (await (await handler(makeGetRequest("valid-token"))).json()) as McpCatalogView;

    // Pin what IS present alongside what is absent — an absence-only assertion
    // would also pass if the whole server silently vanished.
    expect(names(view, "household")).toEqual(["look_up"]);
    expect(permissionOf(view, "household", "look_up")).toBe("allow");
  });

  it("also narrows defaultInclude by role — it must not hand back a name the role gate withholds everywhere else", async () => {
    const guestView = (await (
      await createMcpCatalogHandler(makeDeps({ role: "guest" }))(makeGetRequest("valid-token"))
    ).json()) as McpCatalogView;
    const adultView = (await (
      await createMcpCatalogHandler(makeDeps({ role: "adult" }))(makeGetRequest("valid-token"))
    ).json()) as McpCatalogView;

    expect(guestView.servers.household?.defaultInclude).toEqual(["look_up"]);
    // Pinned alongside: an adult's defaultInclude still carries every curated
    // name, so this isn't just an always-empty/always-one-item coincidence.
    expect(adultView.servers.household?.defaultInclude).toEqual(["look_up", "add_to_list", "wipe_data", "unlock_door"]);
  });

  it("a child reaches read and write, never confirm", async () => {
    const handler = createMcpCatalogHandler(makeDeps({ role: "child" }));

    const view = (await (await handler(makeGetRequest("valid-token"))).json()) as McpCatalogView;

    expect(names(view, "household")).toEqual(["add_to_list", "look_up", "wipe_data"]);
  });

  it("an adult reaches every tier this catalog uses, including confirm", async () => {
    const handler = createMcpCatalogHandler(makeDeps({ role: "adult" }));

    const view = (await (await handler(makeGetRequest("valid-token"))).json()) as McpCatalogView;

    expect(names(view, "household")).toEqual(["add_to_list", "look_up", "unlock_door", "wipe_data"]);
  });
});

describe("GET /api/v1/mcp-catalog — gateway-hosted (stdio) tools are excluded", () => {
  it("omits the stdio server entirely, while an http server on the same catalog is still projected", async () => {
    const handler = createMcpCatalogHandler(makeDeps({ role: "adult" }));

    const view = (await (await handler(makeGetRequest("valid-token"))).json()) as McpCatalogView;

    expect(view.servers.gateway).toBeUndefined();
    expect(view.servers.household).toBeDefined();
  });
});

describe("GET /api/v1/mcp-catalog — delegateTask (decision: it IS projected)", () => {
  it("appears for a role that reaches 'confirm', with its own declared tier and the role template's permission", async () => {
    const handler = createMcpCatalogHandler(makeDeps({ role: "adult" }));

    const view = (await (await handler(makeGetRequest("valid-token"))).json()) as McpCatalogView;

    expect(nativeTool(view, "delegateTask")).toMatchObject({ name: "delegateTask", tier: "confirm", permission: "ask" });
  });

  it("projects 'settable: false' — the wire signal a client must render read-only, since servers[x].tools carries the identical shape", async () => {
    const handler = createMcpCatalogHandler(makeDeps({ role: "adult" }));

    const view = (await (await handler(makeGetRequest("valid-token"))).json()) as McpCatalogView;

    expect(nativeTool(view, "delegateTask")?.settable).toBe(false);
  });

  it("is absent for roles that never reach 'confirm' (child, guest) — paired with the household check above", async () => {
    const childView = (await (
      await createMcpCatalogHandler(makeDeps({ role: "child" }))(makeGetRequest("valid-token"))
    ).json()) as McpCatalogView;
    const guestView = (await (
      await createMcpCatalogHandler(makeDeps({ role: "guest" }))(makeGetRequest("valid-token"))
    ).json()) as McpCatalogView;

    expect(nativeTool(childView, "delegateTask")).toBeUndefined();
    expect(nativeTool(guestView, "delegateTask")).toBeUndefined();
  });

  it("cannot be moved off its role-template answer by ANY stored table — no server key ever addresses it", async () => {
    const handler = createMcpCatalogHandler(
      makeDeps({ role: "adult", permissions: { delegateTask: { delegateTask: "deny" }, household: {} } }),
    );

    const view = (await (await handler(makeGetRequest("valid-token"))).json()) as McpCatalogView;

    expect(nativeTool(view, "delegateTask")?.permission).toBe("ask");
  });
});

describe("GET /api/v1/mcp-catalog — the five skill tools are native, settable, and role-gated", () => {
  it("an adult sees all five, each 'settable', with read tools 'allow' and mutating tools 'ask'", async () => {
    const view = (await (
      await createMcpCatalogHandler(makeDeps({ role: "adult" }))(makeGetRequest("valid-token"))
    ).json()) as McpCatalogView;

    // All five present alongside delegateTask.
    expect(nativeToolNames(view)).toEqual([
      "delegateTask",
      "skill_create",
      "skill_delete",
      "skill_list",
      "skill_update",
      "skill_use",
    ]);
    // Read tools: friction-free.
    expect(nativeTool(view, "skill_list")).toMatchObject({ tier: "read", permission: "allow", settable: true });
    expect(nativeTool(view, "skill_use")).toMatchObject({ tier: "read", permission: "allow", settable: true });
    // Mutating tools: confirm tier, prompt by default, and STILL settable
    // (unlike delegateTask) — they live under the "native" namespace a client
    // can address.
    expect(nativeTool(view, "skill_create")).toMatchObject({ tier: "confirm", permission: "ask", settable: true });
    expect(nativeTool(view, "skill_update")).toMatchObject({ tier: "confirm", permission: "ask", settable: true });
    expect(nativeTool(view, "skill_delete")).toMatchObject({ tier: "confirm", permission: "ask", settable: true });
  });

  it("honours a stored override under the reserved 'native' namespace — proving the projection and broker agree on the key", async () => {
    const view = (await (
      await createMcpCatalogHandler(makeDeps({ role: "adult", permissions: { native: { skill_create: "deny" } } }))(
        makeGetRequest("valid-token"),
      )
    ).json()) as McpCatalogView;

    // The stored native[skill_create] override wins over the role-template
    // default — which is exactly what `settable: true` promises a client.
    expect(nativeTool(view, "skill_create")?.permission).toBe("deny");
    // A sibling native tool with no override still falls to its default.
    expect(nativeTool(view, "skill_use")?.permission).toBe("allow");
  });

  it("a child reaches only the read-tier skill tools, never the confirm-tier mutators or delegateTask", async () => {
    const childView = (await (
      await createMcpCatalogHandler(makeDeps({ role: "child" }))(makeGetRequest("valid-token"))
    ).json()) as McpCatalogView;

    expect(nativeToolNames(childView)).toEqual(["skill_list", "skill_use"]);
  });

  it("a guest reaches only the read-tier skill tools", async () => {
    const guestView = (await (
      await createMcpCatalogHandler(makeDeps({ role: "guest" }))(makeGetRequest("valid-token"))
    ).json()) as McpCatalogView;

    expect(nativeToolNames(guestView)).toEqual(["skill_list", "skill_use"]);
  });
});

// ---------------------------------------------------------------------------
// AGREEMENT WITH THE BROKER — what this suite actually proves, precisely.
//
// The GUARANTEE that the two can never disagree about a resolved VALUE comes
// from the extraction itself (`tools/resolve-tool-permission.ts`): the broker
// and this handler call the identical function, which is separately pinned
// directly in `resolve-tool-permission.test.ts`. `ToolBroker.definitions()`
// exposes only tool NAMES (`d.name`), never the permission it resolved each
// one to — so a suite built on it can prove "visible to the model" vs "not",
// and NOTHING finer; it could not, by itself, catch an `allow`↔`ask` swap.
//
// What THIS suite checks: that the VISIBILITY MAPPING is consistent with the
// exact values a real broker and this handler each land on for a shared
// catalog/role/stored-table fixture — every tool the broker exposes resolves
// to a concrete non-off value here (asserted per-tool, not via a blanket
// negative check), and the one tool the broker hides for being `off` is
// still LISTED here at exactly that value, because this projection must let
// a person turn it back on while the model must not see it at all. That is a
// different consumer making a different choice about the SAME value, not a
// disagreement about the value itself.
// ---------------------------------------------------------------------------
describe("GET /api/v1/mcp-catalog — agrees with the ToolBroker's own resolution", () => {
  const householdTools: McpToolRef[] = [
    { serverName: "household", name: "look_up", description: "looks something up", inputSchema: {}, tier: "read" },
    {
      serverName: "household",
      name: "add_to_list",
      description: "adds an item to a list",
      inputSchema: {},
      tier: "write",
    },
    {
      serverName: "household",
      name: "wipe_data",
      description: "wipes household data",
      inputSchema: {},
      tier: "write",
    },
    {
      serverName: "household",
      name: "unlock_door",
      description: "unlocks the front door",
      inputSchema: {},
      tier: "confirm",
    },
  ];

  function fakeMcp(tools: McpToolRef[]): McpClient {
    return {
      listTools: async () => tools,
      callTool: async () => ({ content: "", isError: false }),
      close: async () => {},
    };
  }

  const accessManager = createAccessManager({ userDataRoot: "/tmp/sentient-mcp-catalog-test" });

  async function brokerDefinitionNames(
    role: UserRole,
    permissions: ProfileV1["tools"]["permissions"],
  ): Promise<string[]> {
    const principal = createUserPrincipal("u_aaaaaaaa", role, "household-1");
    const capability = accessManager.grant(principal, "tool-broker");
    const broker = createToolBroker({
      mcp: fakeMcp(householdTools),
      store: {
        append: () => {
          throw new Error("not used");
        },
        readSession: () => [],
        readSince: () => [],
        findByPendingId: () => null,
        listSessions: () => [],
        createSession: () => {
          throw new Error("not used");
        },
        findSessionByMintKey: () => null,
        getSession: () => null,
        listSessionsWithMetadata: () => [],
        setTitle: () => false,
        close: () => {},
      },
      capability,
      catalog: CATALOG,
      sessionId: "session-1",
      backgroundTools: new Map(),
      config: {
        foreground_timeout_ms: 30000,
        max_concurrent_background_tasks: 1,
        background_completion_request_echo_chars: 240,
        max_tool_result_chars: 20000,
      },
      toolPermissions: async () => permissions,
      requestConfirm: async () => true,
    });
    await broker.ready();
    return broker.definitions().map((d) => d.name);
  }

  it("adult: the broker hides an explicitly 'off' tool from the model, but the settings screen still lists it as 'off'", async () => {
    const permissions: ProfileV1["tools"]["permissions"] = { household: { add_to_list: "deny", wipe_data: "off" } };
    const visibleToModel = await brokerDefinitionNames("adult", permissions);

    const view = (await (
      await createMcpCatalogHandler(makeDeps({ role: "adult", permissions }))(makeGetRequest("valid-token"))
    ).json()) as McpCatalogView;

    // The broker's model-facing surface: `deny` stays visible, `off` does not.
    expect(visibleToModel.sort()).toEqual(["add_to_list", "look_up", "unlock_door"]);

    // EXACT expected value per tool, not a blanket `not.toBe("off")` — a
    // loop-with-a-negative-assertion passes just as well when `permissionOf`
    // returns `undefined` (tool missing entirely) as when it returns a real
    // non-off value, so it cannot actually distinguish "visible and correct"
    // from "silently absent". Concrete values close that gap for the three
    // classes this fixture exercises (profile-stored, role-template, and the
    // tool the stored table turned off).
    expect(permissionOf(view, "household", "look_up")).toBe("allow"); // role-template, unset
    expect(permissionOf(view, "household", "add_to_list")).toBe("deny"); // profile-stored
    expect(permissionOf(view, "household", "unlock_door")).toBe("ask"); // role-template, confirm tier
    // `wipe_data` is invisible to the model (broker's `definitions()` hides
    // `off`) but still LISTED here, at exactly the value that made it hidden.
    expect(names(view, "household")).toContain("wipe_data");
    expect(permissionOf(view, "household", "wipe_data")).toBe("off"); // profile-stored
  });

  it("child: the role gate excludes 'unlock_door' from BOTH the broker's tools[] and the settings projection", async () => {
    const permissions: ProfileV1["tools"]["permissions"] = undefined;
    const visibleToModel = await brokerDefinitionNames("child", permissions);

    const view = (await (
      await createMcpCatalogHandler(makeDeps({ role: "child", permissions }))(makeGetRequest("valid-token"))
    ).json()) as McpCatalogView;

    expect(visibleToModel).not.toContain("unlock_door");
    expect(names(view, "household")).not.toContain("unlock_door");
    // Pinned alongside the absence: the tools a child DOES reach agree too.
    expect(visibleToModel.sort()).toEqual(["add_to_list", "look_up", "wipe_data"]);
    expect(names(view, "household")).toEqual(["add_to_list", "look_up", "wipe_data"]);
  });
});
