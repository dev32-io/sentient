import { AUDIO_PREFS_DEFAULT } from "@sentient/audio-prefs";
import type { ProfileV1 } from "./profile-types.js";

// New-user defaults: each per-MCP value is `[]` (= "inherit the catalog's
// `tools.include`" — the snappy operator-curated whitelist). Don't bake
// individual tool names here; the catalog is the source of truth and
// hardcoding them would drift the moment an operator edits config.yaml.
const DEFAULT_TOOLS_ENABLED: Record<string, string[]> = {
  home_assistant: [],
  gateway: [],
  music_assistant: [],
  searxng: [],
  fetch: [],
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
 * Returns a profile with default tools.enabled / tools.toolsets seeded when
 * the caller didn't supply any. Used by the wizard and admin user creation
 * to give every new user the curated MCP/toolset starter set.
 *
 * Caller-provided enabled or toolsets are preserved as-is (any non-empty
 * value wins), so settings rotation and explicit zeros are respected.
 */
export function applyProfileDefaults(p: ProfileV1): ProfileV1 {
  const enabledIsEmpty = Object.keys(p.tools.enabled).length === 0;
  const toolsetsIsEmpty = !p.tools.toolsets || p.tools.toolsets.length === 0;
  // Audio defaults are already applied by zod's .default() in the schema.
  // The explicit assignment here is for legacy callers who bypass schema.parse()
  // and for parity with future expansion — one canonical place for all defaults.
  return {
    ...p,
    tools: {
      enabled: enabledIsEmpty ? { ...DEFAULT_TOOLS_ENABLED } : p.tools.enabled,
      toolsets: toolsetsIsEmpty ? [...DEFAULT_TOOLSETS] : p.tools.toolsets,
    },
    audio: p.audio ?? AUDIO_PREFS_DEFAULT,
  };
}
