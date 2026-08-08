import { describe, expect, it } from "vitest";
import type { McpToolView } from "../../../services/profile-api.js";
import { effectiveToolPermission, effectiveWildcardPermission, withToolPermission } from "./tool-permission-patch.ts";

function tool(overrides?: Partial<McpToolView>): McpToolView {
  return {
    name: "look_up",
    description: "Look something up.",
    tier: "read",
    permission: "allow",
    settable: true,
    ...overrides,
  };
}

describe("withToolPermission", () => {
  it("sets the target (server, tool) key without touching other servers", () => {
    const before = { household: { unlock_door: "ask" as const }, search: { web_search: "deny" as const } };
    const after = withToolPermission(before, "household", "look_up", "off");
    expect(after.search).toEqual({ web_search: "deny" });
  });

  it("keeps other tool keys already set under the same server", () => {
    const before = { household: { unlock_door: "ask" as const, look_up: "allow" as const } };
    const after = withToolPermission(before, "household", "look_up", "off");
    expect(after.household).toEqual({ unlock_door: "ask", look_up: "off" });
  });

  it("never drops a previously-set wildcard entry when writing a named tool", () => {
    const before = { household: { "*": "off" as const } };
    const after = withToolPermission(before, "household", "look_up", "allow");
    expect(after.household).toEqual({ "*": "off", look_up: "allow" });
  });

  it("builds a minimal map from undefined rather than seeding every server", () => {
    const after = withToolPermission(undefined, "household", "look_up", "deny");
    expect(after).toEqual({ household: { look_up: "deny" } });
  });

  it("writes the wildcard key itself, for a server master-control write", () => {
    const before = { household: { unlock_door: "ask" as const } };
    const after = withToolPermission(before, "household", "*", "off");
    expect(after.household).toEqual({ unlock_door: "ask", "*": "off" });
  });

  it("returns a new object rather than mutating the input map", () => {
    const before = { household: { look_up: "allow" as const } };
    const after = withToolPermission(before, "household", "look_up", "off");
    expect(before.household.look_up).toBe("allow");
    expect(after).not.toBe(before);
  });
});

describe("effectiveToolPermission", () => {
  it("prefers the person's own stored/pending value over the catalog's", () => {
    const permissions = { household: { look_up: "off" as const } };
    expect(effectiveToolPermission(permissions, "household", tool({ permission: "allow" }))).toBe("off");
  });

  it("falls back to the catalog's resolved value when this tool has no override", () => {
    const permissions = { household: { unlock_door: "ask" as const } };
    expect(effectiveToolPermission(permissions, "household", tool({ name: "look_up", permission: "allow" }))).toBe(
      "allow",
    );
  });

  it("falls back to the catalog value when no permissions map exists at all", () => {
    expect(effectiveToolPermission(undefined, "household", tool({ permission: "ask" }))).toBe("ask");
  });
});

describe("effectiveWildcardPermission", () => {
  it("prefers a pending/stored wildcard write over the catalog snapshot", () => {
    const permissions = { household: { "*": "off" as const } };
    expect(effectiveWildcardPermission(permissions, "household", "*", "allow")).toBe("off");
  });

  it("falls back to the catalog's wildcard snapshot when unset locally", () => {
    expect(effectiveWildcardPermission(undefined, "household", "*", "deny")).toBe("deny");
  });

  it("is null when neither the draft nor the catalog has a wildcard set", () => {
    expect(effectiveWildcardPermission(undefined, "household", "*", null)).toBeNull();
  });
});
