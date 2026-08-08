import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { catalogTools, loadConfig, mcpCatalogSchema, tierOf } from "@sentient/config";
import { IMPACT_TIERS, canExecute } from "@sentient/protocol";
import { z } from "zod";
import { delegateTaskDefinition } from "./delegate-task.js";

// ---------------------------------------------------------------------------
// SECURITY BOUNDARY — the role gate, and whether the shipped tiering actually
// reproduces the restrictions `mcp-policy.yaml` spells as string conditions.
//
// Two of that file's three `deny` rules are role rules:
//
//   child_cannot_pause_audio   tool: pause_audio    role == "child"
//   no_guest_identify          tool: identify_user  role == "guest"
//
// Neither is a policy decision about a call — both say "this person may not
// hold this tool". That is `canExecute(role, tier)`, and the ONLY thing that
// makes it come out right is the tier the catalog declares. Get either tier
// wrong and the rule silently stops existing when the engine retires, which
// is why these two are pinned against the SHIPPED config.yaml rather than a
// fixture: an operator edit that re-tiers `pause_audio` down to `write` hands
// a child the house's audio, and must fail here.
//
// NOT reproducible, and deliberately so: `ROLE_PERMISSIONS` is a lattice
// (guest ⊂ child ⊂ adult), so no tier can deny a child something it grants a
// guest. `child_cannot_pause_audio` therefore also costs the guest
// `pause_audio`, which the old rule allowed. Tightening, and recorded.
// ---------------------------------------------------------------------------

const catalog = loadConfig(
  readFileSync(join(import.meta.dir, "../../config.yaml"), "utf-8"),
  z.object({ mcp_catalog: mcpCatalogSchema }),
).mcp_catalog;

function tier(toolName: string) {
  const found = tierOf(catalog, toolName);
  if (found === undefined) throw new Error(`config.yaml#mcp_catalog no longer curates "${toolName}"`);
  return found;
}

describe("the role gate reproduces mcp-policy.yaml's role rules", () => {
  it("denies a child pause_audio, as child_cannot_pause_audio did", () => {
    expect(canExecute("child", tier("pause_audio"))).toBe(false);
  });

  it("still lets an adult pause_audio", () => {
    expect(canExecute("adult", tier("pause_audio"))).toBe(true);
  });

  it("denies a guest identify_user, as no_guest_identify did", () => {
    expect(canExecute("guest", tier("identify_user"))).toBe(false);
  });

  it("still lets an adult identify_user", () => {
    expect(canExecute("adult", tier("identify_user"))).toBe(true);
  });

  it("keeps every read-tier tool reachable by a guest", () => {
    const unreachable = catalogTools(catalog)
      .filter((tool) => tool.tier === "read" && !canExecute("guest", tool.tier))
      .map((tool) => tool.name);
    expect(unreachable).toEqual([]);
  });

  it("keeps delegateTask — an unsupervised agent with its own tools — adult-only", () => {
    expect(canExecute("adult", delegateTaskDefinition.tier)).toBe(true);
    expect(canExecute("child", delegateTaskDefinition.tier)).toBe(false);
    expect(canExecute("guest", delegateTaskDefinition.tier)).toBe(false);
  });
});

describe("every catalog tool declares an impact tier", () => {
  it("tiers all of them", () => {
    const tools = catalogTools(catalog);
    expect(tools.length).toBeGreaterThan(0);
    const untiered = tools.filter((tool) => !IMPACT_TIERS.includes(tool.tier)).map((tool) => tool.name);
    expect(untiered).toEqual([]);
  });

  // The whole point of "no default". An untiered tool defaulted low is handed
  // to a guest nobody meant to give it to; defaulted high it vanishes from an
  // adult's tool list with no error anywhere. Refusing to boot is the only
  // outcome an operator can act on — so the message has to name the tool,
  // because `mcp_catalog.home_assistant.tools.include[7].tier` makes them
  // count array entries.
  it("refuses to load a catalog whose tool has no tier, naming it", () => {
    const yaml = [
      "mcp_catalog:",
      "  home_assistant:",
      "    transport: http",
      "    url: http://127.0.0.1:8086/mcp",
      "    tools:",
      "      include:",
      "        - { name: ha_get_state, tier: read }",
      "        - { name: ha_call_service }",
      "",
    ].join("\n");
    expect(() => loadConfig(yaml, z.object({ mcp_catalog: mcpCatalogSchema }))).toThrow(/ha_call_service/);
  });

  it("refuses to load a catalog entry that curates no tool surface at all", () => {
    const yaml = ["mcp_catalog:", "  fetch:", "    transport: http", "    url: http://127.0.0.1:8088/mcp", ""].join(
      "\n",
    );
    expect(() => loadConfig(yaml, z.object({ mcp_catalog: mcpCatalogSchema }))).toThrow();
  });
});
