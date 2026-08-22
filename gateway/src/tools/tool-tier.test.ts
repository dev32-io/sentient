import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { catalogTools, loadConfig, mcpCatalogSchema, tierOf } from "@sentient/config";
import { IMPACT_TIERS, type ImpactTier, USER_ROLES, canExecute } from "@sentient/protocol";
import { z } from "zod";
import { composeProductToolProviders } from "../bootstrap/product-tool-providers.js";
import { delegateTaskDefinition } from "./delegate-task.js";

// ---------------------------------------------------------------------------
// SECURITY BOUNDARY — the tier of every tool the gateway ships, pinned by name
// against the SHIPPED config.yaml.
//
// A tier is not documentation. Once the role gate lands it is the whole of
// "who may reach this tool", and a one-word edit moves a tool between roles
// with nothing else in the codebase disagreeing. `ha_call_service` — the
// generic Home Assistant dispatcher whose blast radius includes locks and
// alarms — was demoted `confirm` → `read` during review and the entire gateway
// suite stayed green. That is the gap this file closes.
//
// The pin is stated as "every tool that is NOT read", both directions:
//   - a listed tool whose tier changed fails, naming itself;
//   - a tool that is NOT listed and is not `read` fails too, so a promotion
//     into a restricted tier is as loud as a demotion out of one.
// Adding a new READ tool needs no edit here. Adding or re-tiering anything
// else does — deliberately, because that is a change to who can do what.
//
// WHAT TIERING IS FOR: tools that reach THE HOUSEHOLD. Every entry in the
// restricted list below is a Home Assistant or Music Assistant tool acting on
// shared state. Nothing that acts only on the caller's own session appears
// there, and the rule that keeps it that way is pinned separately.
// ---------------------------------------------------------------------------

const catalog = loadConfig(
  readFileSync(join(import.meta.dir, "../../config.yaml"), "utf-8"),
  z.object({ mcp_catalog: mcpCatalogSchema }),
).mcp_catalog;

/** The gateway's own MCP entry — `gateway/src/mcp-host/tools/`, every one of
 *  them scoped to the caller's own session. */
const GATEWAY_HOSTED_SERVER = "gateway";

const nativeProductDefinitions = [...composeProductToolProviders().values()].map((runner) => runner.definition);

function tier(toolName: string): ImpactTier {
  const found =
    nativeProductDefinitions.find((definition) => definition.name === toolName)?.tier ?? tierOf(catalog, toolName);
  if (found === undefined) throw new Error(`config.yaml#mcp_catalog no longer curates "${toolName}"`);
  return found;
}

/** Every shipped tool that is not `read`, with the reason it is not, in one
 *  place. `read` is the ordinary case and is asserted by exclusion. */
const RESTRICTED_TIERS: Readonly<Record<string, ImpactTier>> = {
  home_control: "write",
  home_activate_scene: "write",
  home_activate_script: "write",
  home_activate_automation: "write",
  home_create_scene: "write",
  home_update_scene: "write",
  home_remove_scene: "confirm",
  home_create_automation: "write",
  home_update_automation: "write",
  home_remove_automation: "confirm",
  home_create_script: "write",
  home_update_script: "write",
  home_remove_script: "confirm",
  home_add_todo: "write",
  home_update_todo: "write",
  home_remove_todo: "confirm",
  music_play: "write",
  music_play_media: "write",
  music_transport: "write",
  music_volume: "write",
  music_transfer: "write",
  music_group: "write",
};

describe("every shipped tool keeps the tier it was reviewed with", () => {
  for (const [toolName, expected] of Object.entries(RESTRICTED_TIERS)) {
    it(`tiers ${toolName} as ${expected}`, () => {
      expect(tier(toolName)).toBe(expected);
    });
  }

  // The other direction. Without this, tiering a NEW tool `confirm` — or
  // promoting an existing `read` one — passes silently, and the list above
  // stops being the whole truth about who can do what.
  it("leaves every other tool at read, so the list above is exhaustive", () => {
    const restricted = [...catalogTools(catalog), ...nativeProductDefinitions]
      .filter((tool) => tool.tier !== "read")
      .map((tool) => [tool.name, tool.tier] as const)
      .sort(([a], [b]) => a.localeCompare(b));
    const expected = Object.entries(RESTRICTED_TIERS).sort(([a], [b]) => a.localeCompare(b));
    expect(restricted).toEqual(expected);
  });

  it("restricts only tools that reach the household, never the gateway's own", () => {
    const restrictedServers = [
      ...new Set(
        catalogTools(catalog)
          .filter((tool) => tool.tier !== "read")
          .map((tool) => tool.server),
      ),
    ].sort();
    expect(restrictedServers).not.toContain(GATEWAY_HOSTED_SERVER);
  });
});

// ---------------------------------------------------------------------------
// The rule, not four judgements: every tool the gateway hosts itself resolves
// `ctx.userId` to the CALLER's own session and acts only on that — their TTS
// playback (`audio-tools.ts`), their settings (`update-user-settings.ts`),
// their identity (`identify-user.ts`, which is inert and rebinds nothing). A
// person is by definition allowed to govern their own session.
//
// The retired policy file's `child_cannot_pause_audio` and `no_guest_identify`
// are RETIRED by owner decision, not tiering casualties: `pause_audio` cannot
// reach anyone else's playback, so there was never anything for the rule to
// defend, and withholding `identify_user` from a guest bought no safety while
// costing the model the only answer it has to "I'm actually Bob".
// ---------------------------------------------------------------------------
describe("a gateway-hosted tool acts on the caller's own session, so every role gets it", () => {
  const hosted = catalogTools(catalog).filter((tool) => tool.server === GATEWAY_HOSTED_SERVER);

  it("finds the gateway-hosted tools in the catalog", () => {
    expect(hosted.map((tool) => tool.name).sort()).toEqual([
      "identify_user",
      "pause_audio",
      "resume_audio",
      "update_user_settings",
    ]);
  });

  for (const role of USER_ROLES) {
    it(`lets a ${role} use every one of them`, () => {
      const denied = hosted.filter((tool) => !canExecute(role, tool.tier)).map((tool) => tool.name);
      expect(denied).toEqual([]);
    });
  }
});

describe("the role gate over household tools", () => {
  it("keeps every read-tier tool reachable by a guest", () => {
    const unreachable = catalogTools(catalog)
      .filter((tool) => tool.tier === "read" && !canExecute("guest", tool.tier))
      .map((tool) => tool.name);
    expect(unreachable).toEqual([]);
  });

  it("keeps a child out of every confirm-tier tool", () => {
    const reachable = catalogTools(catalog)
      .filter((tool) => tool.tier === "confirm" && canExecute("child", tool.tier))
      .map((tool) => tool.name);
    expect(reachable).toEqual([]);
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
