import { describe, expect, it } from "bun:test";
import type { McpCatalog } from "@sentient/config";
import { createMcpClient, filterByAllowlist } from "./mcp-client.js";

const tools = [
  { serverName: "ha", name: "ha_get_state", description: "", inputSchema: {} },
  { serverName: "ha", name: "ha_dangerous", description: "", inputSchema: {} },
];

describe("filterByAllowlist", () => {
  it("keeps only allowlisted tools when an include list is set", () => {
    expect(filterByAllowlist(tools, ["ha_get_state"]).map((t) => t.name)).toEqual(["ha_get_state"]);
  });
  it("keeps all tools when no include list is set", () => {
    expect(filterByAllowlist(tools, undefined)).toHaveLength(2);
  });
});

// MCP containers publish NO host ports (`.claude/rules/gateway/mcp-deployment.md`),
// so there is no default localhost URL to dial from the host. This gated
// @live test only runs when a developer temporarily exposes one and points
// MCP_LIVE_URL at it — skips cleanly everywhere else (CI, plain `bun test`).
const live = process.env.MCP_LIVE ? describe : describe.skip;

live("[@live] mcp-client against a real MCP server", () => {
  it("lists at least one tool", async () => {
    const url = process.env.MCP_LIVE_URL;
    if (!url) throw new Error("live test requires MCP_LIVE_URL (e.g. http://localhost:8088/mcp)");
    const catalog: McpCatalog = {
      live: { transport: "http", url, timeout: 30, connect_timeout: 5 },
    };
    const client = createMcpClient(catalog);
    try {
      const tools = await client.listTools();
      expect(tools.length).toBeGreaterThanOrEqual(1);
    } finally {
      await client.close();
    }
  });
});
