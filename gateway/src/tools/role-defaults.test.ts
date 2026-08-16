import { describe, expect, it } from "bun:test";
import { type McpCatalog, catalogTools, mcpCatalogSchema } from "@sentient/config";
import { USER_ROLES, canExecute } from "@sentient/protocol";
import { foundationProductToolMetadata } from "../bootstrap/product-tool-metadata.js";
import { loadShippedCatalog } from "../testing/shipped-catalog.js";
import { defaultPermissionsFor } from "./role-defaults.js";

// ---------------------------------------------------------------------------
// SECURITY BOUNDARY — the table every new account starts life with.
//
// After this task there is no such thing as an unset tool: a profile carries a
// permission for every tool its role can reach, and the ToolBroker resolves it
// with no fallthrough behind it. So a gap here is not "the default is a bit
// wrong" — it is a tool that silently resolves to nothing at all.
// ---------------------------------------------------------------------------

/** A miniature catalog with one tool per impact tier, spread over two servers
 *  so the "a server nobody in this role can reach is ABSENT, not empty" rule
 *  has something to be true about. Parsed through the real schema rather than
 *  cast, so a catalog-shape change breaks this fixture instead of hiding
 *  behind it. */
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
  operator: {
    transport: "http",
    url: "http://127.0.0.1:9001/mcp",
    tools: { include: [{ name: "restart_box", tier: "admin" }] },
  },
});

describe("defaultPermissionsFor maps a tier onto a permission", () => {
  it("leaves a read tool prompt-free — that is what the read tier IS", () => {
    expect(defaultPermissionsFor("adult", CATALOG).household?.look_up).toBe("allow");
  });

  it("prompts on a write tool — a change to household state somebody else relies on", () => {
    expect(defaultPermissionsFor("adult", CATALOG).household?.add_to_list).toBe("ask");
  });

  it("prompts on a confirm tool", () => {
    expect(defaultPermissionsFor("adult", CATALOG).household?.unlock_door).toBe("ask");
  });

  it("prompts on an admin tool even for the one role that reaches it", () => {
    expect(defaultPermissionsFor("admin", CATALOG).operator?.restart_box).toBe("ask");
  });
});

describe("each role gets its own table from the same catalog", () => {
  it("gives an adult every tool below the admin tier", () => {
    expect(defaultPermissionsFor("adult", CATALOG)).toEqual({
      household: { look_up: "allow", add_to_list: "ask", unlock_door: "ask" },
    });
  });

  it("omits from a child's table every tier canExecute denies, and keeps the rest", () => {
    expect(defaultPermissionsFor("child", CATALOG)).toEqual({
      household: { look_up: "allow", add_to_list: "ask" },
    });
  });

  it("leaves a guest the read tier and nothing else", () => {
    expect(defaultPermissionsFor("guest", CATALOG)).toEqual({
      household: { look_up: "allow" },
    });
  });

  it("gives the admin role the admin-tier server nobody else sees", () => {
    expect(defaultPermissionsFor("admin", CATALOG)).toEqual({
      household: { look_up: "allow", add_to_list: "ask", unlock_door: "ask" },
      operator: { restart_box: "ask" },
    });
  });

  // The three tables must be genuinely different objects, not the same one
  // three times — a `defaultPermissionsFor` that ignored its `role` argument
  // would satisfy any single assertion above that happened to be the adult's.
  it("hands the four roles four different tables", () => {
    const tables = USER_ROLES.map((role) => JSON.stringify(defaultPermissionsFor(role, CATALOG)));
    expect(new Set(tables).size).toBe(USER_ROLES.length);
  });
});

// A server key present with an EMPTY per-tool map is not the same statement as
// no key at all: the broker reads a tool missing under a PRESENT server as
// "inherit" and a server missing from a table as "off". Emitting `{}` for a
// server whose every tool this role is denied would therefore hand the role
// exactly what the tier gate exists to withhold.
describe("a server this role can reach no tool of is absent, never empty", () => {
  it("drops the operator server from an adult's table entirely", () => {
    expect(Object.keys(defaultPermissionsFor("adult", CATALOG))).toEqual(["household"]);
  });

  it("drops it from a guest's too, and keeps the server they CAN reach", () => {
    expect(Object.keys(defaultPermissionsFor("guest", CATALOG))).toEqual(["household"]);
  });
});

// ---------------------------------------------------------------------------
// Against the SHIPPED catalog. The fixture above proves the rule; this proves
// the rule applied to the tools this gateway actually hands out — which is the
// thing an operator's account is seeded from, and the thing a hand-copied list
// in a .ts file would have drifted from.
// ---------------------------------------------------------------------------

const shippedCatalog = loadShippedCatalog();

/** Every entry in a table, flattened to `server/tool` for set comparison. */
function seededToolNames(role: Parameters<typeof defaultPermissionsFor>[0]): string[] {
  return Object.entries(
    defaultPermissionsFor(role, shippedCatalog, {
      includeFoundationTools: true,
    }),
  )
    .flatMap(([server, perServer]) => Object.keys(perServer).map((tool) => `${server}/${tool}`))
    .sort();
}

describe("the shipped catalog seeds a complete table", () => {
  it("leaves no tool an adult can execute out of an adult's table", () => {
    const reachable = [...catalogTools(shippedCatalog), ...foundationProductToolMetadata()]
      .filter((tool) => canExecute("adult", tool.tier) && tool.defaultExposure === "standard")
      .map((tool) => `${tool.productGroup}/${tool.name}`)
      .sort();
    expect(seededToolNames("adult")).toEqual(reachable);
  });

  for (const role of USER_ROLES) {
    it(`seeds a ${role} exactly the tools canExecute admits, no more`, () => {
      const reachable = [...catalogTools(shippedCatalog), ...foundationProductToolMetadata()]
        .filter((tool) => canExecute(role, tool.tier) && tool.defaultExposure === "standard")
        .map((tool) => `${tool.productGroup}/${tool.name}`)
        .sort();
      expect(seededToolNames(role)).toEqual(reachable);
    });
  }
});

// ---------------------------------------------------------------------------
// OWNER RULING (plan 2026-08-07-tool-permissions, task 3 controller notes):
// `identify_user` is the model's own utility tool — it is how the assistant
// answers "I'm actually Bob", and it rebinds nothing on its own. `pause_audio`
// stops the CALLER's own TTS and can reach no other session. No role template
// may withhold either.
//
// Both hold today because both are `read`-tier and every role reaches `read`.
// This is the assertion that keeps it that way: re-tiering either one in
// config.yaml is a one-word edit that would otherwise take the tool away from a
// guest, or from everyone, with nothing in the codebase disagreeing.
// ---------------------------------------------------------------------------
describe("the model's own utility tools remain advanced by default", () => {
  for (const role of USER_ROLES) {
    it(`does not seed advanced gateway tools for a ${role}`, () => {
      expect(defaultPermissionsFor(role, shippedCatalog).gateway).toBeUndefined();
    });
  }
});
