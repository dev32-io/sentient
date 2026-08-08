// The pure permission resolution shared by the ToolBroker (tool-broker.ts,
// the PDP choke point a live turn dispatches through) and the mcp-catalog API
// projection (api/handlers/mcp-catalog.ts, the settings screen's read model).
// ONE function answers "what permission does this tool resolve to for this
// person", so the two can never drift into disagreeing about the same tool —
// which the plan (2026-08-07-tool-permissions, task 5) calls out as the worst
// possible bug in this feature: it would make the UI a liar about what the
// model can do.
//
// EXTRACTED FROM THE BROKER, NOT RE-DERIVED. Before this file existed, both
// `storedPermissionFor` and `resolvePermission` were closures inside
// `createToolBroker`, capturing `permissions` (a live snapshot refreshed per
// turn) and `serverOf` (backed by `mcpIndex`, filled by an MCP round trip no
// stateless HTTP handler can casually pay for). Neither is something an API
// handler can construct. What varies between the two callers is entirely the
// INPUTS — a session-scoped live snapshot vs. a fresh per-request read, an
// `mcpIndex` lookup vs. a name already known from iterating the catalog
// itself — never the resolution rule. So the inputs are parameters here, and
// the rule lives in exactly one place.

import { ALL_TOOLS_PERMISSION_KEY } from "@sentient/config";
import type { ToolPermission, ToolPermissionMap } from "@sentient/config";
import type { ImpactTier } from "@sentient/protocol";
import { defaultPermissionForTier } from "./role-defaults.js";

/** Which of the three tables answered. They are three different facts and
 *  only the first two are things a person or an operator chose:
 *
 *    profile           the person's own stored setting (a tool key, a `"*"`
 *                      wildcard, or the absent-server rule)
 *    role-template     their role's starter table, or — for a gateway-native
 *                      tool with no server — the same tier→permission mapping
 *                      that table is built from
 *    catalog-backstop  NOTHING answered. Fail-closed `off`, not a choice
 *                      anybody made; means the live tool surface and
 *                      `config.yaml#mcp_catalog` have drifted apart. */
export type PermissionSource = "profile" | "role-template" | "catalog-backstop";

export interface ResolvedPermission {
  readonly permission: ToolPermission;
  readonly source: PermissionSource;
}

/**
 * The person's OWN STORED setting for a tool, or `undefined` when their table
 * does not answer — which is the signal to fall to the role template.
 *
 * PRECEDENCE inside a server: the tool's own key, then the server's `"*"`
 * wildcard, then unanswered.
 *
 * THE SERVER-LEVEL ASYMMETRY, deliberate and load-bearing. A tool absent
 * from a PRESENT server is unanswered (the template decides); a whole server
 * absent from a NON-EMPTY table is `off`, and that `off` is a STORED answer
 * that stops the template ever being consulted. See
 * `ProfileV1["tools"]["permissions"]`'s doc comment for the full rationale —
 * it is `.optional()` rather than `.default({})` precisely so these two
 * remain distinguishable all the way down to this function.
 *
 * `serverName: null` is the gateway-native case (`delegateTask`): no server
 * addresses it, so no stored table can ever answer for it — this always
 * returns `undefined` and resolution falls straight to the tier mapping.
 */
export function storedPermissionFor(
  permissions: ToolPermissionMap | undefined,
  serverName: string | null,
  toolName: string,
): ToolPermission | undefined {
  if (serverName === null) return undefined;
  if (permissions === undefined) return undefined;
  const perServer = permissions[serverName];
  if (perServer === undefined) return "off";
  return perServer[toolName] ?? perServer[ALL_TOOLS_PERMISSION_KEY];
}

/**
 * THE RESOLUTION, total by construction — every tool has exactly one answer,
 * `undefined` is not one of them, and the answer says WHICH table produced it.
 *
 * `roleTemplate` is server-addressed because it is built from the catalog
 * (`role-defaults.ts#defaultPermissionsFor`), so it cannot answer for a
 * GATEWAY-NATIVE tool (`delegateTask`), which belongs to no server —
 * `serverName: null` is how a caller says so. That tool declares its own
 * `tier`, and the SAME tier→permission mapping the template is built from
 * answers for it directly — one rule, asked at two granularities, never two
 * rules. Falling to the `"off"` backstop for it instead would delete
 * delegation from every profile in the product.
 *
 * The backstop must never be `allow`: a tool in neither the person's table nor
 * the role template is one the operator's catalog does not curate, and nobody
 * tiered it. This is NOT "absent = inherit everything" — the value underneath
 * is a server-computed, role-derived template, not a permissive default.
 */
export function resolveToolPermission(params: {
  toolName: string;
  tier: ImpactTier;
  /** The MCP server that curates this tool, or `null` for a gateway-native
   *  tool with no server (`delegateTask`). Callers with a live `mcpIndex`
   *  (the broker) and callers iterating a static catalog (the API
   *  projection) compute this the same way: the server they found the tool
   *  under, or `null` when it belongs to no server at all. */
  serverName: string | null;
  storedPermissions: ToolPermissionMap | undefined;
  roleTemplate: ToolPermissionMap;
}): ResolvedPermission {
  const { toolName, tier, serverName, storedPermissions, roleTemplate } = params;
  const stored = storedPermissionFor(storedPermissions, serverName, toolName);
  if (stored !== undefined) return { permission: stored, source: "profile" };
  if (serverName === null) return { permission: defaultPermissionForTier(tier), source: "role-template" };
  const templated = roleTemplate[serverName]?.[toolName];
  if (templated !== undefined) return { permission: templated, source: "role-template" };
  return { permission: "off", source: "catalog-backstop" };
}
