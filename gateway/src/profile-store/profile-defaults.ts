import { AUDIO_PREFS_DEFAULT } from "@sentient/audio-prefs";
import type { ToolPermission } from "@sentient/config";
import type { ProfileV1 } from "./profile-types.js";

// New-user defaults: each default server is present with an empty per-tool
// map (= "inherit" for every tool — the broker falls through to the
// operator-curated mcp-policy.yaml). Don't bake individual tool names here;
// the catalog is the source of truth and hardcoding them would drift the
// moment an operator edits config.yaml.
const DEFAULT_TOOL_PERMISSIONS: Record<string, Record<string, ToolPermission>> = {
  home_assistant: {},
  gateway: {},
  music_assistant: {},
  searxng: {},
  fetch: {},
};

// New-user default Hermes built-in toolsets. Aggressive lean default for
// voice family AI — memory is mandatory, todo helps multi-step intents,
// session_search lets the agent recall earlier conversations, skills lets
// the user say "remember how to do X" and persist a skill doc. Web /
// browser / terminal / file / vision / code_execution / delegation
// toolsets stay OFF: searxng + fetch MCPs cover web, and the rest are
// editor-tier surfaces with zero voice utility but big prompt cost.
const DEFAULT_TOOLSETS = ["memory", "todo", "session_search", "skills"];

/**
 * Returns a profile with default tools.permissions / tools.toolsets seeded
 * when the caller didn't supply any. Used by the wizard and admin user
 * creation to give every new user the curated MCP/toolset starter set.
 *
 * Caller-provided permissions or toolsets are preserved as-is (any non-empty
 * value wins), so settings rotation and explicit zeros are respected.
 */
export function applyProfileDefaults(p: ProfileV1): ProfileV1 {
  const permissionsIsEmpty = Object.keys(p.tools.permissions).length === 0;
  const toolsetsIsEmpty = !p.tools.toolsets || p.tools.toolsets.length === 0;
  // Audio defaults are already applied by zod's .default() in the schema.
  // The explicit assignment here is for legacy callers who bypass schema.parse()
  // and for parity with future expansion — one canonical place for all defaults.
  return {
    ...p,
    tools: {
      permissions: permissionsIsEmpty ? { ...DEFAULT_TOOL_PERMISSIONS } : p.tools.permissions,
      toolsets: toolsetsIsEmpty ? [...DEFAULT_TOOLSETS] : p.tools.toolsets,
    },
    audio: p.audio ?? AUDIO_PREFS_DEFAULT,
  };
}
