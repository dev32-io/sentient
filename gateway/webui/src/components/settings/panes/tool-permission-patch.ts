// gateway/webui/src/components/settings/panes/tool-permission-patch.ts
//
// Pure helpers shared by every editable row in the Tools pane (per-tool
// Select and the server master control alike — the master control is just
// this same write targeted at the server's wildcard key). Extracted so the
// one invariant this feature depends on has its own test, independent of
// rendering: see `tool-permission-patch.test.ts`.
import type { ToolPermission, ToolPermissionMap } from "@sentient/config";
import type { McpToolView } from "../../../services/profile-api.js";

/**
 * Returns a NEW permissions map with exactly (serverId, toolName) set to
 * `permission`. Every other server, and every other tool-name key already
 * under `serverId` (including a previously-set wildcard entry), is carried
 * forward untouched.
 *
 * NEVER DELETES A KEY. The whole-profile PUT (`ProfileApi.updateMe`) sends
 * this map verbatim; dropping a server key here would be a silent PERMANENT
 * no-op the next time this person saves — `ProfileV1["tools"]["permissions"]`'s
 * absent-server rule reads a missing key as "off forever" and never consults
 * the role template again for it. Building the next map by spreading the
 * PREVIOUS one (rather than reconstructing it from the catalog view) is what
 * keeps a server the catalog excluded for an unrelated reason — stdio
 * transport, zero role-governable tools — from being wiped out just because
 * this person happened to touch a different server's dropdown.
 */
export function withToolPermission(
  permissions: ToolPermissionMap | undefined,
  serverId: string,
  toolName: string,
  permission: ToolPermission,
): ToolPermissionMap {
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
 */
export function effectiveToolPermission(
  permissions: ToolPermissionMap | undefined,
  serverId: string,
  tool: McpToolView,
): ToolPermission {
  return permissions?.[serverId]?.[tool.name] ?? tool.permission;
}

/**
 * What a server's master control should show: this person's own pending or
 * previously-saved wildcard write if there is one, else the catalog's
 * snapshot of it at load time (`McpCatalogEntryView.wildcardPermission`).
 */
export function effectiveWildcardPermission(
  permissions: ToolPermissionMap | undefined,
  serverId: string,
  wildcardKey: string,
  catalogWildcard: ToolPermission | null,
): ToolPermission | null {
  return permissions?.[serverId]?.[wildcardKey] ?? catalogWildcard;
}
