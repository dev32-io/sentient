import { z } from "zod";

/**
 * What the gateway does when the model calls a tool. ONE setting per tool,
 * owned by the ToolBroker, which is the only thing that reads it.
 *
 *   allow — dispatched with no prompt.
 *   ask   — the person is asked first (permission dialog).
 *   deny  — auto-rejected with a reason the model SEES, so it can explain
 *           itself rather than silently improvising around a gap.
 *   off   — omitted from `tools[]` entirely; the model does not know the tool
 *           exists. This is the only member that changes the request prefix,
 *           and so the only one that costs a prompt-cache re-prime.
 *
 * `deny` and `off` are deliberately distinct: `deny` keeps the capability
 * legible to the model, `off` removes it. Collapsing them loses the model's
 * ability to say WHY it cannot do something.
 *
 * EXHAUSTIVE SWITCHES ONLY. A fifth member (`auto`, once the classifier
 * lands) must break every site that has to handle it — never fall through a
 * `default:` arm into silently-wrong behaviour.
 */
export const toolPermissionSchema = z.enum(["allow", "ask", "deny", "off"]);
export type ToolPermission = z.infer<typeof toolPermissionSchema>;

/**
 * One person's whole permission table: MCP server name → tool name →
 * permission. The stored shape of `ProfileV1["tools"]["permissions"]`, named
 * once here because the ToolBroker, its composition roots and the profile
 * schema all have to spell it.
 *
 * An empty table is NOT "everything off" — see the ToolBroker's
 * `storedPermissionFor`, which documents how presence and absence are read.
 */
export type ToolPermissionMap = Record<string, Record<string, ToolPermission>>;

/**
 * Reserved tool-name key inside a server's per-tool permission map
 * (`ProfileV1["tools"]["permissions"][server]`) that sets the permission for
 * every tool the catalog lists under that server which has no more specific
 * entry of its own.
 *
 * Why this exists: the profile schema never sees `mcp_catalog` (operator
 * config, loaded separately at runtime, not available to a zod schema at
 * parse time) so it cannot enumerate a server's real tool names to write one
 * `off` entry per tool. Without a wildcard, "turn this whole server off"
 * would be inexpressible without inventing tool names that may not exist, or
 * silently drift the moment the operator edits the catalog. This sentinel is
 * the only per-tool-map-shaped way to express a blanket permission.
 *
 * Resolution order in the ToolBroker: a named tool's own key first, then this
 * wildcard, then — nothing stored — the person's role permission template, and
 * finally a fail-closed `off`.
 */
export const ALL_TOOLS_PERMISSION_KEY = "*";

/**
 * One PUT's incoming per-tool value: a permission to WRITE, or `null` to
 * CLEAR that key back to "no stored opinion" — the role template answers it
 * again, exactly as if the key had never been set (`gateway/src/tools/
 * resolve-tool-permission.ts`'s floor).
 *
 * WHY THIS EXISTS. Before the per-role floor (`role-defaults.ts`), an absent
 * key meant `off`, so a client could never safely omit one — "never delete a
 * key" was the only safe rule. Under the floor, absent means "the role
 * template decides", which is exactly the state a person needs to be able to
 * RETURN to (e.g. a server master control's "on" position must restore every
 * un-overridden tool to its role default, not blanket-`allow` them — writing
 * any concrete value into the wildcard forecloses the template for every tool
 * under it with no per-tool override, `ask`-tier tools included). `null` is
 * the only way a client can express "go back to floor" without deleting
 * anything: the incoming body still names the key, it just carries no
 * opinion for it anymore.
 *
 * NEVER THE STORED SHAPE. `ToolPermissionMap`'s leaves are `ToolPermission`
 * only — a clear collapses to an absent key during the merge
 * (`gateway/src/profile-store/profile-update.ts`) and is never persisted as
 * a literal `null`.
 */
export const toolPermissionOrClearSchema = z.union([toolPermissionSchema, z.null()]);
export type ToolPermissionOrClear = z.infer<typeof toolPermissionOrClearSchema>;

/** One PUT body's whole per-tool intent: MCP server name -> tool name (or the
 *  `ALL_TOOLS_PERMISSION_KEY` wildcard) -> a permission to write, or `null`
 *  to clear it. Contrast `ToolPermissionMap`, the STORED shape, whose leaves
 *  are never `null`. */
export type ToolPermissionPatchMap = Record<string, Record<string, ToolPermissionOrClear>>;
