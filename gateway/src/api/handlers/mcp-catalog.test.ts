import { type HermesBuiltinTools, type McpCatalog, mcpCatalogSchema } from "@sentient/config";
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
    });
    expect(tools.find((t) => t.name === "add_to_list")).toMatchObject({ tier: "write", permission: "ask" });
    expect(tools.find((t) => t.name === "unlock_door")).toMatchObject({ tier: "confirm", permission: "ask" });
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

describe("GET /api/v1/mcp-catalog — role-based omission", () => {
  it("a guest sees only the read-tier tool, never a write- or confirm-tier one", async () => {
    const handler = createMcpCatalogHandler(makeDeps({ role: "guest" }));

    const view = (await (await handler(makeGetRequest("valid-token"))).json()) as McpCatalogView;

    // Pin what IS present alongside what is absent — an absence-only assertion
    // would also pass if the whole server silently vanished.
    expect(names(view, "household")).toEqual(["look_up"]);
    expect(permissionOf(view, "household", "look_up")).toBe("allow");
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

    expect(view.nativeTools).toHaveLength(1);
    expect(view.nativeTools[0]).toMatchObject({ name: "delegateTask", tier: "confirm", permission: "ask" });
  });

  it("is absent for roles that never reach 'confirm' (child, guest) — paired with the household check above", async () => {
    const childView = (await (
      await createMcpCatalogHandler(makeDeps({ role: "child" }))(makeGetRequest("valid-token"))
    ).json()) as McpCatalogView;
    const guestView = (await (
      await createMcpCatalogHandler(makeDeps({ role: "guest" }))(makeGetRequest("valid-token"))
    ).json()) as McpCatalogView;

    expect(childView.nativeTools).toEqual([]);
    expect(guestView.nativeTools).toEqual([]);
  });

  it("cannot be moved off its role-template answer by ANY stored table — no server key ever addresses it", async () => {
    const handler = createMcpCatalogHandler(
      makeDeps({ role: "adult", permissions: { delegateTask: { delegateTask: "deny" }, household: {} } }),
    );

    const view = (await (await handler(makeGetRequest("valid-token"))).json()) as McpCatalogView;

    expect(view.nativeTools[0]?.permission).toBe("ask");
  });
});

// ---------------------------------------------------------------------------
// AGREEMENT WITH THE BROKER. Same catalog, same role, same stored table, fed
// to a REAL ToolBroker and to this handler — if the two ever disagree about a
// tool's resolved PERMISSION, the settings screen is lying about what the
// model can do (plan 2026-08-07-tool-permissions task 5, controller notes).
//
// The one place they are EXPECTED to differ is which tools they expose at
// all: the broker's `definitions()` hides `off` from the MODEL (a prompt-
// cache concern — see tool-broker.ts), while this projection must keep an
// `off` tool LISTED so a person can turn it back on. That is a different
// consumer making a different choice about the SAME value, not a
// disagreement about the value itself — this suite checks both.
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

    // Every tool the broker WOULD show the model resolves to something other
    // than "off" here too — the two must never disagree about the VALUE.
    for (const toolName of visibleToModel) {
      expect(permissionOf(view, "household", toolName)).not.toBe("off");
    }
    // `wipe_data` is invisible to the model but still listed here, at exactly
    // the value that made the broker hide it.
    expect(names(view, "household")).toContain("wipe_data");
    expect(permissionOf(view, "household", "wipe_data")).toBe("off");
    expect(permissionOf(view, "household", "add_to_list")).toBe("deny");
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
