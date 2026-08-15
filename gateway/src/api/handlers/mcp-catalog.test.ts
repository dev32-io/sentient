import { type HermesBuiltinTools, type McpCatalog, mcpCatalogSchema } from "@sentient/config";
import type { UserRole } from "@sentient/protocol";
import { describe, expect, it, vi } from "vitest";
import type { ProfileStore } from "../../profile-store/profile-store.js";
import type { ProfileV1 } from "../../profile-store/profile-types.js";
import { NEVER_REVOKED } from "../../user-auth/credential-floor.js";
import type { TokenPayload, TokenResult, UserRecord } from "../../user-auth/types.js";
import type { UserStore } from "../../user-auth/user-store.js";
import { type McpCatalogView, createMcpCatalogHandler } from "./mcp-catalog.js";

const CATALOG: McpCatalog = mcpCatalogSchema.parse({
  search_transport: {
    product_group: "web",
    transport: "http",
    url: "http://127.0.0.1:9000/mcp",
    tools: { include: [{ name: "search_web", tier: "read", description: "Searches the web" }] },
  },
  fetch_transport: {
    product_group: "web",
    transport: "http",
    url: "http://127.0.0.1:9001/mcp",
    tools: { include: [{ name: "fetch", tier: "read", description: "Fetches a page" }] },
  },
  experimental_transport: {
    product_group: "research",
    default_exposure: "advanced",
    transport: "http",
    url: "http://127.0.0.1:9002/mcp",
    tools: { include: [{ name: "deep_research", tier: "read", description: "Researches deeply" }] },
  },
});

function profile(permissions?: ProfileV1["tools"]["permissions"]): ProfileV1 {
  return {
    schemaVersion: 1,
    userId: "alice",
    model: { provider: "openrouter", id: "test" },
    voice: { provider: "local-tts", id: "default" },
    audio: { ttsEnabled: true, channel: "voice" },
    memory: { spark: true, dreaming: true },
    persona: { template: "default", overrides: "" },
    tools: { permissions, toolsets: [] },
    compression: { threshold: 0.5 },
    advanced: { extraSystemPrompt: "", maxTokens: 1024, reasoningEffort: "minimal" },
  };
}

function deps(role: UserRole = "adult", permissions?: ProfileV1["tools"]["permissions"]) {
  const record: UserRecord = {
    userId: "alice",
    displayName: "Alice",
    pinHash: "hash",
    role,
    avatarTint: "sage",
    createdAt: "2026-01-01T00:00:00.000Z",
    credentialsValidFrom: NEVER_REVOKED,
  };
  const tokens = {
    validate: vi.fn(
      async (): Promise<TokenResult<TokenPayload>> => ({
        ok: true,
        value: { userId: "alice", issuedAt: 0, expiresAt: 9999999999 },
      }),
    ),
  };
  const users: Pick<UserStore, "get"> = { get: vi.fn(async () => ({ ok: true as const, value: record })) };
  const profileStore: ProfileStore = {
    get: vi.fn(async () => ({ ok: true as const, value: profile(permissions) })),
    save: vi.fn(async () => ({ ok: true as const, value: undefined })),
    remove: vi.fn(async () => ({ ok: true as const, value: undefined })),
  };
  return { tokens, users, profileStore, catalog: CATALOG, hermesBuiltinTools: [] as HermesBuiltinTools };
}

async function viewFor(role: UserRole = "adult", permissions?: ProfileV1["tools"]["permissions"]) {
  const handler = createMcpCatalogHandler(deps(role, permissions));
  const response = await handler(
    new Request("http://localhost/api/v1/mcp-catalog", { headers: { authorization: "Bearer valid" } }),
  );
  expect(response.status).toBe(200);
  return (await response.json()) as McpCatalogView;
}

describe("GET /api/v1/mcp-catalog — product groups", () => {
  it("projects multiple MCP transports into one stable product section and retains routing metadata", async () => {
    const view = await viewFor();
    expect(Object.keys(view)).toEqual(["groups", "wildcardPermissionKey", "hermesBuiltins"]);
    expect(view.groups.web?.tools.map((tool) => tool.name)).toEqual(["search_web", "fetch"]);
    expect(view.groups.web?.tools.map((tool) => tool.dispatch)).toEqual([
      { kind: "mcp", serverName: "search_transport" },
      { kind: "mcp", serverName: "fetch_transport" },
    ]);
  });

  it("projects native memory tools through the same group contract", async () => {
    const view = await viewFor();
    expect(view.groups.memory?.tools.find((tool) => tool.name === "memory_read")?.dispatch).toEqual({ kind: "native" });
    expect(view.groups.memory?.tools.find((tool) => tool.name === "memory_read")?.permission).toBe("allow");
  });

  it("applies group wildcard then explicit tool override", async () => {
    const view = await viewFor("adult", { web: { "*": "off", fetch: "deny" } });
    expect(view.groups.web?.wildcardPermission).toBe("off");
    expect(view.groups.web?.tools.find((tool) => tool.name === "search_web")?.permission).toBe("off");
    expect(view.groups.web?.tools.find((tool) => tool.name === "fetch")?.permission).toBe("deny");
  });

  it("keeps advanced tools off by default and allows an explicit enable", async () => {
    const fresh = await viewFor();
    expect(fresh.groups.research?.defaultExposure).toBe("advanced");
    expect(fresh.groups.research?.tools[0]?.permission).toBe("off");
    const enabled = await viewFor("adult", { research: { "*": "allow" }, web: {} });
    expect(enabled.groups.research?.tools[0]?.permission).toBe("allow");
  });

  it("role reach remains an independent upper bound", async () => {
    const view = await viewFor("guest", { delegation: { "*": "allow" } });
    expect(view.groups.delegation).toBeUndefined();
  });
});
