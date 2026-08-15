import { describe, expect, it } from "vitest";
import { resolveToolPermission, storedPermissionFor } from "./resolve-tool-permission.js";

const TEMPLATE = { web: { search_web: "allow" as const, fetch: "allow" as const } };

function resolve(overrides: Partial<Parameters<typeof resolveToolPermission>[0]> = {}) {
  return resolveToolPermission({
    toolName: "search_web",
    tier: "read",
    productGroup: "web",
    defaultExposure: "standard",
    storedPermissions: undefined,
    roleTemplate: TEMPLATE,
    ...overrides,
  });
}

describe("product-group tool permission resolver", () => {
  it("uses explicit tool, then group wildcard, then role default", () => {
    expect(resolve({ storedPermissions: { web: { "*": "off", search_web: "deny" } } })).toEqual({
      permission: "deny",
      source: "profile",
    });
    expect(resolve({ storedPermissions: { web: { "*": "ask" } } })).toEqual({ permission: "ask", source: "profile" });
    expect(resolve()).toEqual({ permission: "allow", source: "role-template" });
  });

  it("preserves absent versus empty tables", () => {
    expect(resolve({ storedPermissions: undefined }).permission).toBe("allow");
    expect(resolve({ storedPermissions: {} }).permission).toBe("off");
  });

  it("defaults an advanced tool off without inferring that from transport", () => {
    expect(resolve({ productGroup: "research", defaultExposure: "advanced", roleTemplate: {} })).toEqual({
      permission: "off",
      source: "role-template",
    });
    expect(
      resolve({
        productGroup: "research",
        defaultExposure: "advanced",
        storedPermissions: { research: { "*": "allow" } },
        roleTemplate: {},
      }).permission,
    ).toBe("allow");
  });

  it("gives explicitly metadata-bearing native tools the same standard tier default", () => {
    expect(resolve({ toolName: "memory_read", productGroup: "memory", roleTemplate: {} }).permission).toBe("allow");
  });

  it("fails closed for a legacy/uncurated tool with no authoritative product metadata", () => {
    expect(
      resolveToolPermission({
        toolName: "unknown",
        tier: "read",
        serverName: "server",
        storedPermissions: undefined,
        roleTemplate: {},
      }),
    ).toEqual({ permission: "off", source: "catalog-backstop" });
  });

  it("stored lookup is group-addressed and explicit tool wins wildcard", () => {
    expect(storedPermissionFor({ web: { "*": "off", fetch: "deny" } }, "web", "fetch")).toBe("deny");
    expect(storedPermissionFor({ web: { "*": "off" } }, "web", "fetch")).toBe("off");
  });
});
