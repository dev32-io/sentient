import { audioPrefsSchema } from "@sentient/audio-prefs";
import { type ToolPermission, toolPermissionSchema } from "@sentient/config";
import { z } from "zod";

export const PROFILE_SCHEMA_VERSION = 1;

export const modelProviderSchema = z.enum(["openrouter", "ollama-cloud", "custom"]);
export type ModelProvider = z.output<typeof modelProviderSchema>;

export const voiceProviderSchema = z.literal("local-tts");
export type VoiceProvider = z.output<typeof voiceProviderSchema>;

// Matches the Hermes `agent.reasoning_effort` enum
// (https://hermes-agent.nousresearch.com/docs/user-guide/configuration#reasoning-effort).
// Default at the Hermes layer is "medium"; sentient's product default is
// "minimal" — see the profile-renderer reasoning_effort emission.
export const reasoningEffortSchema = z.enum(["none", "minimal", "low", "medium", "high", "xhigh"]);
export type ReasoningEffort = z.output<typeof reasoningEffortSchema>;

/**
 * Legacy `tools.enabled` → `tools.permissions`. No schema-version bump, same
 * convention as the `voice.provider: "fish-audio"` rewrite above.
 *
 * `enabled` expressed AVAILABILITY per server: a present key meant the server
 * was on (`[]` = inherit the operator's include; a non-empty array = narrow to
 * those tools). It never reached the native loop, so this migration is the
 * moment the setting starts meaning something — a server the user had switched
 * off yields `off` for every tool the catalog lists under it.
 *
 * Servers the user narrowed keep their named tools inheriting and mark nothing
 * else, because the catalog — not the profile — is the authority on what other
 * tools exist. The broker resolves the remainder against the catalog at
 * `definitions()` time (task 2).
 */
function migrateEnabledToPermissions(v: unknown): unknown {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return v;
  const obj = v as Record<string, unknown>;

  // Already permissions-shaped: pass through untouched.
  if ("permissions" in obj) return obj;

  const legacyEnabled = obj.enabled;
  // Nothing to migrate (fresh profile, or already stripped) — the schema
  // default takes over for a missing `permissions` key.
  if (legacyEnabled === undefined) return obj;

  // Doubly-legacy shape: a bare `string[]` of server names, pre-dating the
  // `{name: string[]}` per-server narrowing-array format.
  const enabledRecord: Record<string, unknown> = Array.isArray(legacyEnabled)
    ? Object.fromEntries(
        (legacyEnabled as unknown[]).filter((s): s is string => typeof s === "string").map((s) => [s, [] as string[]]),
      )
    : (legacyEnabled as Record<string, unknown>);

  // Every server the user had enabled — narrowed or not — migrates to
  // "inherit" (an empty per-tool map). Recreating the old narrowing array as
  // explicit `allow` entries would assert the named tools are still valid
  // catalog entries, which this migration has no way to verify (no catalog
  // access here); leaving them to inherit is the safe default until the
  // broker resolves the real subset against the live catalog (task 2).
  const permissions: Record<string, Record<string, ToolPermission>> = {};
  for (const server of Object.keys(enabledRecord)) {
    permissions[server] = {};
  }

  const { enabled: _dropped, ...rest } = obj;
  return { ...rest, permissions };
}

export const profileV1Schema = z.object({
  schemaVersion: z.literal(PROFILE_SCHEMA_VERSION),
  userId: z.string().min(1).max(64),
  model: z.object({
    provider: modelProviderSchema,
    id: z.string().min(1),
  }),
  // Legacy migration (no schema-version bump, mirroring tools.enabled below):
  // pre-local-tts profiles stored `voice.provider: "fish-audio"` with a Fish
  // reference_id. Fish Audio is gone; rewrite such profiles to the local-tts
  // built-in default voice so they still validate on load. The old Fish id maps
  // to no local voice pack, so it is reset to the "default" sentinel — the user
  // re-clones a voice in Settings → Voices if they want a custom one. Without
  // this, every profile.json written before the Fish→local-tts cutover fails
  // schema validation on upgrade (corrupt-file) and the user can't load.
  voice: z.preprocess(
    (v) => {
      if (v && typeof v === "object" && (v as { provider?: unknown }).provider === "fish-audio") {
        return { provider: "local-tts", id: "default" };
      }
      return v;
    },
    z.object({
      provider: voiceProviderSchema,
      id: z.string().min(1),
    }),
  ),
  audio: audioPrefsSchema.default({ ttsEnabled: true, channel: "voice" }),
  persona: z.object({
    template: z.string().min(1),
    overrides: z.string().max(8192),
  }),
  // Migration lives at the `tools:` object level, not on the `permissions`
  // field itself: zod only calls a field's preprocess with THAT field's own
  // raw value, never sibling keys, so migrating `enabled` (a sibling of the
  // new `permissions` key) into `permissions` has to see the whole `tools`
  // object at once. Verified directly against this repo's zod — a
  // field-scoped preprocess on an absent/renamed key is never invoked with
  // its siblings in scope.
  tools: z.preprocess(
    migrateEnabledToPermissions,
    z.object({
      /**
       * Per-tool permission, keyed by MCP server name then tool name. Server
       * names match gateway/config.yaml#mcp_catalog. An ABSENT entry — missing
       * server, or missing tool under a present server — means "inherit", and
       * the broker falls through to mcp-policy.yaml exactly as it did before
       * this field existed. That is what makes adding the field a no-op until
       * somebody touches a dropdown.
       *
       * Replaces the retired `enabled` map. That field's only consumer was the
       * Hermes profile renderer, whose `mcp:` block Hermes never reads (the
       * gateway registers its MCP at call time — external-tools/
       * hermes-external-tool.ts), so it steered nothing.
       *
       * Turning a whole server off: the profile schema never sees the
       * catalog, so it cannot write one `off` entry per tool a server
       * carries. Use the reserved `ALL_TOOLS_PERMISSION_KEY` ("*", exported
       * from @sentient/config) as a server's per-tool key instead — the
       * broker (task 2) checks a tool's own name first, then this wildcard,
       * then falls through to mcp-policy.yaml.
       */
      permissions: z.record(z.string().min(1), z.record(z.string().min(1), toolPermissionSchema)).default({}),
      // Hermes built-in toolsets exposed to the agent loop. Names must
      // appear in hermes_cli/tools_config.CONFIGURABLE_TOOLSETS — common
      // values: memory, todo, clarify, skills, session_search,
      // messaging, web, browser, terminal, file, vision. Empty list is
      // legal (no built-ins, MCP-only). Optional for back-compat with
      // older profile.json files; renderer falls back to a curated lean
      // default when missing.
      toolsets: z.array(z.string().min(1)).optional(),
    }),
  ),
  compression: z.object({
    threshold: z.number().min(0).max(1),
  }),
  advanced: z.object({
    extraSystemPrompt: z.string().max(8192),
    maxTokens: z.number().int().min(1).max(8192),
    // Hermes `agent.reasoning_effort`. "minimal" is the sentient default
    // (family-assistant context — short prompts, latency + cost matter
    // more than deep reasoning). Older profiles missing the field parse
    // as "minimal" via the schema default.
    reasoningEffort: reasoningEffortSchema.default("minimal"),
  }),
});

export type ProfileV1 = z.output<typeof profileV1Schema>;
