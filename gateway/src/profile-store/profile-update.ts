// What a `PUT /api/v1/profile/me` body MEANS — the rule, separated from the
// HTTP handler that reads it off the wire so it can be exercised without
// constructing a Request.

import type { ToolPermissionMap } from "@sentient/config";
import type { ProfileV1 } from "./profile-types.js";

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
 * A PUT REPLACES ONLY THE PERMISSION KEYS IT NAMES.
 *
 * Every other field is a whole value the body always carries (the schema
 * requires model, voice, persona, compression, advanced, and `tools.toolsets`
 * is a list, where "partial" means nothing), so all of it is replaced outright.
 * `tools.permissions` is the one field a client can legitimately hold an
 * opinion about only PART of:
 *
 *   - a SERVER the body does not name keeps its stored per-tool map;
 *   - a TOOL the body does not name keeps its stored permission;
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
 * NOTHING IS LOST BY GIVING UP DELETION: the four permission states already
 * express every intent a client has. "Off" is `"off"` — including
 * `{"*": "off"}` for a whole server — never an absent key. Silence means "no
 * opinion", which is the only thing a partial body can honestly mean.
 *
 * SEEDING HAPPENS FIRST, AND THE ORDER IS THE WHOLE POINT. A never-tabled
 * profile starts from the role template and takes the body's delta on top.
 * Merging first and seeding only when the result is still absent looks
 * equivalent and is not: a body naming ONE permission produces a one-entry
 * table, which is no longer absent, so the template never lands and every other
 * tool stays unset forever. Under these semantics a partial body is the
 * expected shape, so that is the common path rather than an edge case.
 */
export function applyProfileUpdate(incoming: ProfileV1, base: ProfileUpdateBase): ProfileV1 {
  // `??` and not `||`: a stored `{}` is a table somebody wrote that names no
  // server — every server off — and seeding over it would turn the household
  // back on. Only a genuinely ABSENT table takes the template.
  const startingPoint = base.stored?.tools.permissions ?? base.permissionDefaults;
  const permissions = mergePermissions(startingPoint, incoming.tools.permissions);
  if (permissions === undefined) return incoming;
  return { ...incoming, tools: { ...incoming.tools, permissions } };
}

/** Whether this PUT will seed the role template. Exported so the "when" is
 *  stated once, in the module that owns it, and the handler can log the one
 *  state change a person cannot see in their own request. */
export function seedsPermissionDefaults(base: ProfileUpdateBase): boolean {
  return base.stored?.tools.permissions === undefined && base.permissionDefaults !== undefined;
}

/**
 * `incoming` wins per (server, tool); everything else survives.
 *
 * Built with `Object.fromEntries` rather than `merged[server] = …` because
 * every server key here is a name a CLIENT chose: assigning to `"__proto__"`
 * on a plain object reaches `Object.prototype`'s setter instead of creating an
 * own property, which silently drops the entry. `fromEntries` and object spread
 * both define own properties, so neither level can be steered that way.
 */
function mergePermissions(
  base: ToolPermissionMap | undefined,
  incoming: ToolPermissionMap | undefined,
): ToolPermissionMap | undefined {
  if (base === undefined) return incoming;
  if (incoming === undefined) return base;
  const servers = [...new Set([...Object.keys(base), ...Object.keys(incoming)])];
  return Object.fromEntries(servers.map((server) => [server, { ...base[server], ...incoming[server] }]));
}
