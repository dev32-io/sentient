// What a `PUT /api/v1/profile/me` body MEANS — the rule, separated from the
// HTTP handler that reads it off the wire so it can be exercised without
// constructing a Request.

import type {
  ToolPermission,
  ToolPermissionMap,
  ToolPermissionOrClear,
  ToolPermissionPatchMap,
} from "@sentient/config";
import type { ProfileV1, ProfileV1PutBody } from "./profile-types.js";

/** The state a PUT is applied ON TOP OF. */
export interface ProfileUpdateBase {
  /** The profile as stored, or `undefined` when there genuinely is not one.
   *  NOT the same as "could not be read" — the caller must refuse that case
   *  rather than passing `undefined`, or a partial body would delete every
   *  setting the read failed to see. */
  readonly stored: ProfileV1 | undefined;
  /** The account's per-role starter table, used ONLY when the stored profile
   *  carries no table at all. `undefined` when the role could not be resolved,
   *  which skips seeding rather than guessing a role. */
  readonly permissionDefaults: ToolPermissionMap | undefined;
}

/**
 * A PUT REPLACES ONLY THE PERMISSION KEYS IT NAMES — and a key named with
 * `null` is CLEARED (removed from the merged map) rather than written.
 *
 * Every other field is a whole value the body always carries (the schema
 * requires model, voice, persona, compression, advanced, and `tools.toolsets`
 * is a list, where "partial" means nothing), so all of it is replaced outright.
 * `tools.permissions` is the one field a client can legitimately hold an
 * opinion about only PART of:
 *
 *   - a SERVER the body does not name keeps its stored per-tool map;
 *   - a TOOL the body does not name keeps its stored permission;
 *   - a TOOL the body names with `null` is CLEARED: the merged map no longer
 *     answers for it, so whatever sits underneath answers instead — the role
 *     template, via the resolver's floor, once nothing in the table names it;
 *   - a body with no `permissions` key at all, or an empty one, changes
 *     nothing.
 *
 * WHY A DELTA AND NOT A REPLACEMENT. Every account's table is complete for its
 * role from creation (`applyProfileDefaults`), and the broker resolves it with
 * no operator policy behind it — so an entry that disappears does not revert to
 * a default, it becomes a tool with no answer. Under replacement, a client that
 * renders four servers and PUTs what it rendered silently deletes the fifth; a
 * client saving a VOICE change with a stale `tools` object silently deletes all
 * of them. Both are one line of client code away at all times, and neither
 * would look like a bug from the client's side.
 *
 * WHY CLEARING EXISTS, AND WHY IT IS NOT THE SAME AS "OFF". `off` is a stored
 * OPINION — the person said hide this tool. Cleared is NO opinion — ask the
 * role template — and for an `ask`-tier tool (a lock, a purchase) that is NOT
 * the same thing as `allow`. Before the per-role floor (`role-defaults.ts`) an
 * absent key meant `off`, so "never delete a key" was the only safe client
 * rule: deleting could only ever make a tool disappear from the model, never
 * grant it something new. Under the floor, an absent key means "the role
 * template decides" — a state a person needs to be able to RETURN to (a
 * server master control's "on" position, for one: writing any CONCRETE value
 * into the server's wildcard forecloses the template for every tool under it
 * with no per-tool override of its own, including `ask`-tier ones — see
 * `resolve-tool-permission.ts`'s `storedPermissionFor`). It can no longer be
 * reached by deleting, because a PUT already only touches the keys it names
 * (the rule above): omitting a key from the body means "no opinion about it
 * in THIS request", not "clear its stored value". `null` is the one way to
 * say "clear" from inside a body that still only ever touches what it names.
 * THIS RETIRES THE REV-1 "NEVER DELETE A KEY" CONSTRAINT'S RATIONALE, not its
 * text: that rule existed because an absent key used to mean `off`; a client
 * now reaches "role template decides" honestly, by naming the key with
 * `null`, without deleting anything from the body or the stored table.
 *
 * SEEDING HAPPENS FIRST, AND THE ORDER IS THE WHOLE POINT. A never-tabled
 * profile starts from the role template and takes the body's delta on top.
 * Merging first and seeding only when the result is still absent looks
 * equivalent and is not: a body naming ONE permission produces a one-entry
 * table, which is no longer absent, so the template never lands and every other
 * tool stays unset forever. Under these semantics a partial body is the
 * expected shape, so that is the common path rather than an edge case.
 */
export function applyProfileUpdate(incoming: ProfileV1PutBody, base: ProfileUpdateBase): ProfileV1 {
  // `??` and not `||`: a stored `{}` is a table somebody wrote that names no
  // server — every server off — and seeding over it would turn the household
  // back on. Only a genuinely ABSENT table takes the template.
  const startingPoint = base.stored?.tools.permissions ?? base.permissionDefaults;
  const permissions = mergePermissions(startingPoint, incoming.tools.permissions);
  return { ...incoming, tools: { ...incoming.tools, permissions } };
}

/** Whether this PUT will seed the role template. Exported so the "when" is
 *  stated once, in the module that owns it, and the handler can log the one
 *  state change a person cannot see in their own request. */
export function seedsPermissionDefaults(base: ProfileUpdateBase): boolean {
  return base.stored?.tools.permissions === undefined && base.permissionDefaults !== undefined;
}

/**
 * `incoming` wins per (server, tool) — except a `null` value, which CLEARS
 * that key instead of writing it, so nothing in the merged table answers for
 * it anymore. Everything else in `base` survives.
 *
 * A server named ONLY by clears (every one of its incoming entries is `null`)
 * still comes back as a key mapping to `{}`, NEVER an absent key — an empty
 * per-tool map is "present, no opinions" and falls through to the role
 * template for every tool; an ABSENT server key is a stored `off` forever
 * (`resolve-tool-permission.ts`'s `storedPermissionFor`). Collapsing the two
 * would turn "restore my defaults" into "hide the whole server", the exact
 * inversion of what a clear means.
 *
 * Built with `Object.fromEntries` rather than `merged[server] = …` because
 * every server key here is a name a CLIENT chose: assigning to `"__proto__"`
 * on a plain object reaches `Object.prototype`'s setter instead of creating an
 * own property, which silently drops the entry. `fromEntries` and object spread
 * both define own properties, so neither level can be steered that way — see
 * `mergeServer` below, which applies the identical rule one level down, where
 * a TOOL name is the client-chosen string.
 */
function mergePermissions(
  base: ToolPermissionMap | undefined,
  incoming: ToolPermissionPatchMap | undefined,
): ToolPermissionMap | undefined {
  if (incoming === undefined) return base;
  const servers = [...new Set([...Object.keys(base ?? {}), ...Object.keys(incoming)])];
  return Object.fromEntries(servers.map((server) => [server, mergeServer(base?.[server], incoming[server] ?? {})]));
}

/**
 * One server's merged per-tool map. `incoming`'s real values win over
 * `base`'s; `incoming`'s `null` values remove the matching tool from the
 * result outright.
 *
 * NO BRACKET ASSIGNMENT (`merged[tool] = …`) AND NO `delete merged[tool]` —
 * both use `[[Set]]`/would need a pre-existing own property to be safe, and a
 * TOOL name is exactly as client-chosen as a SERVER name one level up. Two
 * plain arrays (kept, written) built with `Object.entries`/`.filter`, combined
 * with ONE closing `Object.fromEntries` — which defines each entry with
 * `[[DefineOwnProperty]]`, never the special `__proto__` accessor, and lets a
 * later duplicate key (an incoming real value for a tool `base` also has)
 * simply overwrite the earlier one, which is exactly "incoming wins".
 */
function mergeServer(
  base: Record<string, ToolPermission> | undefined,
  incoming: Record<string, ToolPermissionOrClear>,
): Record<string, ToolPermission> {
  const clearedTools = new Set(
    Object.entries(incoming)
      .filter(([, permission]) => permission === null)
      .map(([tool]) => tool),
  );
  const kept = Object.entries(base ?? {}).filter(([tool]) => !clearedTools.has(tool));
  const written = Object.entries(incoming).filter((entry): entry is [string, ToolPermission] => entry[1] !== null);
  return Object.fromEntries([...kept, ...written]);
}
