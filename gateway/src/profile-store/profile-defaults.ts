import { AUDIO_PREFS_DEFAULT } from "@sentient/audio-prefs";
import type { McpCatalog } from "@sentient/config";
import type { UserRole } from "@sentient/protocol";
import { defaultPermissionsFor } from "../tools/role-defaults.js";
import type { ProfileV1 } from "./profile-types.js";

// New-user default Hermes built-in toolsets. Aggressive lean default for
// voice family AI — memory is mandatory, todo helps multi-step intents,
// session_search lets the agent recall earlier conversations, skills lets
// the user say "remember how to do X" and persist a skill doc. Web /
// browser / terminal / file / vision / code_execution / delegation
// toolsets stay OFF: searxng + fetch MCPs cover web, and the rest are
// editor-tier surfaces with zero voice utility but big prompt cost.
const DEFAULT_TOOLSETS = ["memory", "todo", "session_search", "skills"];

/** What the defaults layer needs beyond the profile itself. Both are read from
 *  authoritative state at the call site — the role off the user RECORD, the
 *  catalog off `config.yaml` — never guessed here. */
export interface ProfileDefaultsContext {
  /** The account's role. Decides which tools its starter table carries; see
   *  `defaultPermissionsFor`. */
  readonly role: UserRole;
  /** `config.yaml#mcp_catalog` — the source of truth for which tools exist and
   *  what impact tier each one carries. */
  readonly mcpCatalog: McpCatalog;
}

/**
 * Returns a profile with default tools.permissions / tools.toolsets seeded
 * when the caller didn't supply any. Used by the wizard, admin user creation
 * and the profile save to give every account a table that is COMPLETE for its
 * role — after this there is no such thing as a tool with no permission, which
 * is what lets the broker resolve one with nothing behind it.
 *
 * Caller-provided permissions or toolsets are preserved as-is, so settings
 * rotation and explicit zeros are respected. For permissions that includes an
 * EMPTY table: `{}` is a table naming no server, i.e. every server off, and
 * overwriting it with the role template would silently turn tools back on for
 * somebody who had switched them all off. Only an ABSENT table (never set) is
 * seeded.
 */
export function applyProfileDefaults(p: ProfileV1, ctx: ProfileDefaultsContext): ProfileV1 {
  const permissionsIsUnset = p.tools.permissions === undefined;
  const toolsetsIsEmpty = !p.tools.toolsets || p.tools.toolsets.length === 0;
  // Audio defaults are already applied by zod's .default() in the schema.
  // The explicit assignment here is for legacy callers who bypass schema.parse()
  // and for parity with future expansion — one canonical place for all defaults.
  return {
    ...p,
    tools: {
      permissions: permissionsIsUnset ? defaultPermissionsFor(ctx.role, ctx.mcpCatalog) : p.tools.permissions,
      toolsets: toolsetsIsEmpty ? [...DEFAULT_TOOLSETS] : p.tools.toolsets,
    },
    audio: p.audio ?? AUDIO_PREFS_DEFAULT,
  };
}
