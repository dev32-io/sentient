// The per-role permission table every new account is seeded with.
//
// WHY A TEMPLATE AND NOT A FALLTHROUGH. Before this, a tool with no entry in a
// person's table "inherited" the operator's `mcp-policy.yaml`, so the shipped
// behaviour of a tool lived in two places and a profile could be silently
// incomplete. Seeding at account creation replaces that: a profile carries a
// permission for every tool its role can reach, the broker resolves it with
// nothing behind it, and the person can change any entry without the answer
// depending on a file they cannot see.
//
// BUILT FROM THE CATALOG, NEVER FROM A LIST HERE. `config.yaml#mcp_catalog` is
// the source of truth for which tools exist and what impact tier each carries
// (operator-managed YAML, `.claude/rules/config.md`). A hand-copied list of
// tool names in this file would drift the moment an operator adds an MCP, and
// the drift would show up as a tool nobody was ever granted.
//
// TWO INPUTS, TWO DIFFERENT QUESTIONS, and they must not be conflated:
//   role + tier  → MAY this person reach the tool at all (`canExecute`)
//   tier         → what happens when they do (the mapping below)
//
// The role question is deliberately NOT frozen into the seeded table as an
// `off` entry: a stored `off` is a statement the PERSON made, and writing the
// role's verdict into that same slot would both misattribute it and go stale
// the moment an admin re-roles the account. It belongs to a gate that re-asks
// it live, from the capability's role.
//
// THAT GATE DOES NOT EXIST YET — it is task 4 of plan 2026-08-07-tool-permissions,
// and `canExecute` has no runtime call site anywhere in `gateway/src` outside
// this module and its tests. So what an omission from this table means TODAY is
// not "denied": `permissionFor` returns `undefined` for a tool with no entry
// under a present server, which still falls through to `mcp-policy.yaml`, and
// that file CONFIRMS the tools in question (a permission prompt) rather than
// denying them. No regression — omitting is never wider than the old behaviour
// — but do not read the paragraph above as a description of live enforcement
// until task 4 lands the gate and retires the policy engine.

import { type McpCatalog, type ToolPermission, type ToolPermissionMap, catalogTools } from "@sentient/config";
import { type ImpactTier, type UserRole, canExecute } from "@sentient/protocol";
import { getLog } from "../logging/logger.js";

const log = getLog(["sentient", "tools", "role-defaults"]);

/**
 * What a tool of this tier does by default when the model calls it.
 *
 * These are `mcp-policy.yaml`'s 35 rules, restated as one line per tier — the
 * mapping is exact, not an approximation: every tool that file allowed is
 * `read`-tier, and every tool it confirmed is `write` or `confirm`. The two
 * gateway-hosted exceptions it confirmed (`identify_user`,
 * `update_user_settings`) are `read` here by the tiering decision that already
 * shipped — a gateway-hosted tool resolves the CALLER's own session and acts
 * only on that, and a person is by definition allowed to govern their own.
 *
 * EXHAUSTIVE, no `default:` arm. A fifth tier must be decided by whoever adds
 * it — falling through to `allow` hands out a tool nobody meant to give away,
 * and falling through to `ask` prompts on every read.
 */
function defaultPermissionForTier(tier: ImpactTier): ToolPermission {
  switch (tier) {
    case "read":
      // Friction-free queries are the entire point of the read tier.
      return "allow";
    case "write":
      // Reversible, but it changes household state somebody else relies on.
      return "ask";
    case "confirm":
      return "ask";
    case "admin":
      // Reaching the tier at all already takes the admin role; the prompt is
      // about the blast radius of the act, not about who is asking.
      return "ask";
  }
}

/**
 * The starter permission table for `role`, over the tools `catalog` curates.
 *
 * Contains an entry for every tool the role can execute and NO entry for the
 * rest — including no key at all for a server whose every tool is out of
 * reach. That asymmetry is the broker's, not a choice made here: it reads a
 * tool missing under a PRESENT server as "inherit" and a server missing from a
 * table as "off", so emitting `{}` for an unreachable server would hand the
 * role exactly what its tier gate withholds.
 *
 * ONE ACCESSOR. Every caller that needs a default — both account-creation
 * paths, the profile save, and a later per-household customization UI — comes
 * through here, so there is one place where "what does a new child get" is
 * answered.
 */
export function defaultPermissionsFor(role: UserRole, catalog: McpCatalog): ToolPermissionMap {
  const table: ToolPermissionMap = {};
  let withheld = 0;

  for (const tool of catalogTools(catalog)) {
    if (!canExecute(role, tool.tier)) {
      withheld += 1;
      continue;
    }
    const perServer = table[tool.server] ?? {};
    perServer[tool.name] = defaultPermissionForTier(tool.tier);
    table[tool.server] = perServer;
  }

  log.debug("role-defaults.built", {
    role,
    servers: Object.keys(table).length,
    seeded: Object.values(table).reduce((n, perServer) => n + Object.keys(perServer).length, 0),
    withheld,
    reason: withheld === 0 ? "role reaches every tier the catalog uses" : "role cannot execute the tool's impact tier",
  });
  return table;
}
