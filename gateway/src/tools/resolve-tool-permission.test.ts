import { describe, expect, it } from "bun:test";
import type { ToolPermissionMap } from "@sentient/config";
import { resolveToolPermission, storedPermissionFor } from "./resolve-tool-permission.js";

const ROLE_TEMPLATE: ToolPermissionMap = {
  "test-mcp": { look_up: "allow", add_to_list: "ask", unlock_door: "ask" },
};

describe("resolveToolPermission — the SAME rule the ToolBroker's PDP dispatches through", () => {
  it("resolves from the person's OWN stored table when it answers, source 'profile'", () => {
    const result = resolveToolPermission({
      toolName: "add_to_list",
      tier: "write",
      serverName: "test-mcp",
      storedPermissions: { "test-mcp": { add_to_list: "deny" } },
      roleTemplate: ROLE_TEMPLATE,
    });

    expect(result).toEqual({ permission: "deny", source: "profile" });
  });

  it("falls to the ROLE TEMPLATE when the table is unset (undefined, not {})", () => {
    const result = resolveToolPermission({
      toolName: "look_up",
      tier: "read",
      serverName: "test-mcp",
      storedPermissions: undefined,
      roleTemplate: ROLE_TEMPLATE,
    });

    expect(result).toEqual({ permission: "allow", source: "role-template" });
  });

  it("falls to the ROLE TEMPLATE when the tool is absent under a PRESENT server", () => {
    // The table names "test-mcp" but says nothing about "look_up" specifically —
    // the per-tool gap is answered by the template, not by the server-absent rule.
    const result = resolveToolPermission({
      toolName: "look_up",
      tier: "read",
      serverName: "test-mcp",
      storedPermissions: { "test-mcp": { add_to_list: "deny" } },
      roleTemplate: ROLE_TEMPLATE,
    });

    expect(result).toEqual({ permission: "allow", source: "role-template" });
  });

  it("treats a table naming no server as 'every server off' — NOT the same as unset", () => {
    const unset = resolveToolPermission({
      toolName: "look_up",
      tier: "read",
      serverName: "test-mcp",
      storedPermissions: undefined,
      roleTemplate: ROLE_TEMPLATE,
    });
    const emptyTable = resolveToolPermission({
      toolName: "look_up",
      tier: "read",
      serverName: "test-mcp",
      storedPermissions: {},
      roleTemplate: ROLE_TEMPLATE,
    });

    expect(unset).toEqual({ permission: "allow", source: "role-template" });
    expect(emptyTable).toEqual({ permission: "off", source: "profile" });
  });

  it("resolves a server's '*' wildcard for a tool that has no more specific key", () => {
    const result = resolveToolPermission({
      toolName: "unlock_door",
      tier: "confirm",
      serverName: "test-mcp",
      storedPermissions: { "test-mcp": { "*": "deny", look_up: "allow" } },
      roleTemplate: ROLE_TEMPLATE,
    });

    expect(result).toEqual({ permission: "deny", source: "profile" });
  });

  it("falls to the fail-closed 'off' backstop for a tool the template does not carry", () => {
    // Neither the stored table nor the role template answers — the template
    // built from the SAME catalog would only omit a tool the catalog does not
    // curate, so this represents a live/catalog drift.
    const result = resolveToolPermission({
      toolName: "uncatalogued_tool",
      tier: "read",
      serverName: "test-mcp",
      storedPermissions: undefined,
      roleTemplate: {},
    });

    expect(result).toEqual({ permission: "off", source: "catalog-backstop" });
  });

  it("SECURITY: the backstop is never 'allow' regardless of tier", () => {
    for (const tier of ["read", "write", "confirm", "admin"] as const) {
      const result = resolveToolPermission({
        toolName: "uncatalogued_tool",
        tier,
        serverName: "test-mcp",
        storedPermissions: undefined,
        roleTemplate: {},
      });
      expect(result.permission).not.toBe("allow");
      expect(result.source).toBe("catalog-backstop");
    }
  });

  describe("the gateway-native (serverless) case — delegateTask", () => {
    it("SECURITY: a stored table can NEVER answer for a serverless tool, no matter what it names", () => {
      // `serverName: null` is how a caller (broker or API projection) says
      // "this tool belongs to no MCP server" — no key any client could write
      // reaches it, structurally, which is exactly Task 3/4's finding about
      // `delegateTask`.
      const result = resolveToolPermission({
        toolName: "delegateTask",
        tier: "confirm",
        serverName: null,
        storedPermissions: { delegateTask: { delegateTask: "deny" }, "*": { delegateTask: "deny" } },
        roleTemplate: ROLE_TEMPLATE,
      });

      expect(result).toEqual({ permission: "ask", source: "role-template" });
    });

    it("answers directly from the tier→permission mapping, bypassing the server-addressed template entirely", () => {
      const result = resolveToolPermission({
        toolName: "delegateTask",
        tier: "confirm",
        serverName: null,
        storedPermissions: undefined,
        // A template that happens to carry a same-named key under some server
        // must not leak into the serverless resolution.
        roleTemplate: { delegateTask: { delegateTask: "deny" } },
      });

      expect(result).toEqual({ permission: "ask", source: "role-template" });
    });
  });
});

describe("storedPermissionFor", () => {
  it("returns undefined for a serverless tool regardless of the table", () => {
    expect(storedPermissionFor({ x: { y: "allow" } }, null, "delegateTask")).toBeUndefined();
  });

  it("returns undefined (unanswered) when the table itself is unset", () => {
    expect(storedPermissionFor(undefined, "test-mcp", "look_up")).toBeUndefined();
  });

  it("returns 'off' when the table exists but the server is absent from it", () => {
    expect(storedPermissionFor({ "other-mcp": {} }, "test-mcp", "look_up")).toBe("off");
  });
});
