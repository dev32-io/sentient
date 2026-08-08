// gateway/webui/src/components/settings/panes/tool-permission-patch.ts
//
// Pure helpers shared by every editable row in the Tools pane. Extracted so
// the invariants this feature depends on have their own tests, independent
// of rendering: see `tool-permission-patch.test.ts`.
//
// WHY THE MASTER CONTROL CANNOT JUST WRITE THE WILDCARD. Every account is
// seeded with a NAMED permission entry for every catalog tool its role can
// execute (`gateway/src/profile-store/profile-defaults.ts#applyProfileDefaults`,
// called at account creation). `resolve-tool-permission.ts`'s
// `storedPermissionFor` reads a tool's own named key BEFORE the server's
// wildcard (`perServer[toolName] ?? perServer[ALL_TOOLS_PERMISSION_KEY]`) —
// so for a normal, already-seeded account, EVERY tool already has an answer
// that outranks the wildcard, and writing only `permissions[server]["*"]`
// changes nothing for any of them. The wildcard only ever governs a tool
// with NO named entry: one the operator adds to the catalog after this
// account was seeded, or one a role change newly grants (a promoted/demoted
// account's table is not re-seeded). `withServerMasterPermission` below is
// what makes the control actually hide/restore an already-named tool too.
import type { ToolPermission, ToolPermissionOrClear, ToolPermissionPatchMap } from "@sentient/config";
import type { McpToolView } from "../../../services/profile-api.js";

/**
 * Returns a NEW permissions map with exactly (serverId, toolName) set to
 * `permission`. Every other server, and every other tool-name key already
 * under `serverId` (including a previously-set wildcard entry), is carried
 * forward untouched.
 *
 * `permission` MAY be `null` — a CLEAR, not a delete. Passed straight
 * through to the PUT body: the gateway's merge (`profile-update.ts`) is what
 * turns a `null` leaf into an absent key server-side, so a person can return
 * a tool (or a server's wildcard) to "no stored opinion, let the role
 * template answer" without this client ever deleting a JS object key itself.
 *
 * NEVER DELETES A KEY ON THIS SIDE EITHER — but not for the reason this
 * comment used to give. Dropping a SERVER key from the body is simply a NO-OP
 * for that server, NOT the "off forever" the absent-server rule describes.
 * They are different maps: `profile-update.ts` does a per-server, per-tool
 * DELTA merge, so a key the body omits is left exactly as stored, while the
 * absent-server rule (`resolve-tool-permission.ts`'s `storedPermissionFor`)
 * is a property of the STORED table — a server with no key there at all — and
 * no PUT can reach that state by omission.
 *
 * Keys are carried forward to match the full-resend convention every other
 * PUT field follows. Building the next map by spreading the PREVIOUS one
 * (rather than reconstructing it from the catalog view) is what keeps a
 * server the catalog excluded for an unrelated reason — stdio transport, zero
 * role-governable tools — represented in the body at all, so this person's
 * saved table stays a complete statement of what they chose.
 */
export function withToolPermission(
  permissions: ToolPermissionPatchMap | undefined,
  serverId: string,
  toolName: string,
  permission: ToolPermissionOrClear,
): ToolPermissionPatchMap {
  return {
    ...permissions,
    [serverId]: { ...permissions?.[serverId], [toolName]: permission },
  };
}

/**
 * The server master control's actual write: a NAMED value for every catalog
 * tool this role can govern (`toolNames`, the role-narrowed list the pane
 * already renders — `entry.tools.map(t => t.name)`), PLUS the wildcard for
 * whatever that list cannot enumerate (see the module comment above for why
 * the wildcard alone is a no-op on a normal, already-seeded account).
 *
 * "Off" writes an explicit `"off"` everywhere — a real, stored opinion that
 * hides every one of this server's tools from the model.
 *
 * "On" writes an explicit `null` everywhere instead of a concrete value:
 * each named tool falls back to ITS OWN role-template answer rather than
 * one blanket value, which is what keeps a `confirm`-tier tool's `ask` from
 * becoming an auto-approved `allow` (the bug this whole clearing mechanism
 * exists to close — see `withToolPermission`'s doc comment).
 *
 * "ON" ALSO ERASES ANY PER-TOOL OVERRIDE THE PERSON SET DELIBERATELY ON THIS
 * SERVER. The stored table records no provenance — a value seeded at
 * account creation and a value a person typed into this exact tool's own
 * Select five minutes ago are the same kind of key, indistinguishable once
 * written. There is no way to clear "everything the template already
 * agreed with" while preserving "everything the person chose on purpose"
 * without inventing data the table does not carry, which is why this
 * control is framed as "Hide all / Reset to role defaults" in the pane's
 * copy, not "Hide all / Undo my last change".
 */
export function withServerMasterPermission(
  permissions: ToolPermissionPatchMap | undefined,
  serverId: string,
  toolNames: readonly string[],
  wildcardKey: string,
  turnOn: boolean,
): ToolPermissionPatchMap {
  const value: ToolPermissionOrClear = turnOn ? null : "off";
  const namedWrites = Object.fromEntries(toolNames.map((name) => [name, value]));
  return {
    ...permissions,
    [serverId]: { ...permissions?.[serverId], ...namedWrites, [wildcardKey]: value },
  };
}

/**
 * What a tool's Select should show: this person's own pending or
 * previously-saved edit for that EXACT tool name if there is one, else the
 * catalog's already-resolved value. The catalog's `tool.permission` was
 * computed server-side by `resolve-tool-permission.ts` from the saved
 * profile plus the role template — this deliberately does not re-simulate
 * that cascade (wildcard, role template, fail-closed backstop) client-side,
 * so the settings screen can never drift from what the ToolBroker actually
 * enforces. One consequence: a PENDING (unsaved) master-control write is not
 * reflected in an individual tool's row until the profile is saved and the
 * catalog is refetched — consistent with this pane's own "changes apply
 * after you save settings" copy.
 *
 * A per-tool Select never WRITES `null` (it only ever offers the four real
 * permissions), but `??` treats a stray `null` the same as "no opinion" here
 * too — the honest fallback if one were ever present — which is also why
 * this keeps returning a concrete `ToolPermission`, never `null`.
 */
export function effectiveToolPermission(
  permissions: ToolPermissionPatchMap | undefined,
  serverId: string,
  tool: McpToolView,
): ToolPermission {
  return permissions?.[serverId]?.[tool.name] ?? tool.permission;
}

/**
 * What a server's master control should show: this person's own pending or
 * previously-saved wildcard write if there is one, else the catalog's
 * snapshot of it at load time (`McpCatalogEntryView.wildcardPermission`).
 *
 * DELIBERATELY NOT `??`. A pending CLEAR is stored as a real, own `null`
 * entry — `permissions?.[serverId]?.[wildcardKey] ?? catalogWildcard` would
 * treat that `null` as "nothing here" and silently fall back to the catalog's
 * (possibly stale, possibly `"off"`) snapshot, which is exactly backwards:
 * the person just asked to clear it. `Object.hasOwn` is what tells "an
 * explicit pending edit exists, and it happens to be null" apart from "no
 * edit was made here at all".
 */
export function effectiveWildcardPermission(
  permissions: ToolPermissionPatchMap | undefined,
  serverId: string,
  wildcardKey: string,
  catalogWildcard: ToolPermission | null,
): ToolPermission | null {
  const serverMap = permissions?.[serverId];
  if (serverMap && Object.hasOwn(serverMap, wildcardKey)) {
    // `noUncheckedIndexedAccess` types this read as possibly `undefined`
    // even though `Object.hasOwn` just proved the key exists. An explicit
    // `=== undefined` check (never `??`) is what lets a REAL `null` pass
    // through untouched — `??` cannot tell "clear" apart from "absent".
    const value = serverMap[wildcardKey];
    return value === undefined ? catalogWildcard : value;
  }
  return catalogWildcard;
}
