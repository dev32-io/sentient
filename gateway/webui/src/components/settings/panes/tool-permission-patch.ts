// gateway/webui/src/components/settings/panes/tool-permission-patch.ts
//
// Pure helpers shared by every editable row in the Tools pane (per-tool
// Select and the server master control alike — the master control is just
// this same write targeted at the server's wildcard key). Extracted so the
// one invariant this feature depends on has its own test, independent of
// rendering: see `tool-permission-patch.test.ts`.
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
 * NEVER DELETES A KEY ON THIS SIDE EITHER. The whole-profile PUT
 * (`ProfileApi.updateMe`) sends this map verbatim; dropping a SERVER key
 * here would be a silent PERMANENT no-op the next time this person saves —
 * `ProfileV1["tools"]["permissions"]`'s absent-server rule reads a missing
 * key as "off forever" and never consults the role template again for it.
 * Building the next map by spreading the PREVIOUS one (rather than
 * reconstructing it from the catalog view) is what keeps a server the
 * catalog excluded for an unrelated reason — stdio transport, zero
 * role-governable tools — from being wiped out just because this person
 * happened to touch a different server's dropdown.
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
