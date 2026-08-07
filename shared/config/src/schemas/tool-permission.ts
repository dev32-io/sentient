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
 * `permissionFor`, which documents how presence and absence are read.
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
 * Intended resolution order for the ToolBroker (task 2): a named tool's own
 * key first, then this wildcard, then fall through to mcp-policy.yaml per
 * the field's normal "absent means inherit" rule.
 */
export const ALL_TOOLS_PERMISSION_KEY = "*";
