import { audioPrefsSchema } from "@sentient/audio-prefs";
import { type ToolPermission, toolPermissionOrClearSchema, toolPermissionSchema } from "@sentient/config";
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
 * off is absent from the emitted table, which the broker reads as `off` for
 * every tool that server carries.
 *
 * Servers the user narrowed keep their named tools inheriting and mark nothing
 * else, because the catalog — not the profile — is the authority on what other
 * tools exist. The broker resolves the remainder against the catalog at
 * `definitions()` time (task 2).
 *
 * THREE INPUTS, THREE DIFFERENT OUTPUTS — and the last two must never collapse:
 *   - `{enabled: {a: [], b: []}}` → `{permissions: {a: {}, b: {}}}` (those two
 *     servers on and inheriting, everything else off);
 *   - `{enabled: {}}`            → NO `permissions` key at all, i.e. unset =
 *     "nobody has configured tools yet" → the defaults layer seeds the starter
 *     set. See the carve-out below for why.
 *   - `{permissions: {}}`        → passed straight through by the early return
 *     at the top: somebody wrote a table naming no server, which is a
 *     deliberate everything-off and is preserved as such.
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

  const { enabled: _dropped, ...rest } = obj;

  // AN EMPTY `enabled` MAP IS "NOT CONFIGURED YET", NOT "EVERYTHING OFF", and
  // the difference is the whole ball game now that `permissions` is enforced.
  // In the legacy world a key's PRESENCE meant a server was on, so `{}` meant
  // no server had been configured — which for a fresh profile has always meant
  // "seed the starter set". Emitting `permissions: {}` here would instead be a
  // table naming no server, i.e. every server off; `applyProfileDefaults` would
  // see a set field and decline to seed, and every new user would end up with
  // zero MCP tools. Both account-creation paths send exactly this shape today
  // (the web wizard's INITIAL_DRAFT and mobile's templateMemberProfile), so
  // this is the live default, not an edge case. Dropping the key entirely
  // yields "unset", which is what the defaults layer and the broker both read
  // as "nobody has chosen yet".
  if (Object.keys(enabledRecord).length === 0) return rest;

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
  // Per-user memory toggles (S1: storage + read helper only — the spark and
  // dreamer consumers land in later slices, T15/T20). Defaulted true on both:
  // missing-field resilience for every profile written before this field
  // existed, same pattern as `audio` above and `advanced.reasoningEffort`
  // below. Gateway-side only, like `audio` — never rendered into the Hermes
  // profile, so a change here never needs the "slow" apply-pipeline rewrite.
  memory: z
    .object({
      // Bring up relevant past memories in conversation (recall/spark).
      spark: z.boolean(),
      // Nightly reflection — Sentient reviews the day and updates its notes.
      dreaming: z.boolean(),
    })
    .default({ spark: true, dreaming: true }),
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
       * names match gateway/config.yaml#mcp_catalog. THE BROKER
       * (`gateway/src/tools/tool-broker.ts`, `storedPermissionFor`) IS THE ONLY
       * READER — write to this shape against the rules below, not against an
       * intuition about what "absent" ought to mean.
       *
       * THE FIELD ITSELF IS OPTIONAL, and that is load-bearing. Absent means
       * NEVER SET: every tool resolves from the person's ROLE TEMPLATE
       * (`gateway/src/tools/role-defaults.ts`), which is also what a freshly
       * seeded profile would have said — so an unseeded account behaves exactly
       * like a seeded one until somebody touches a dropdown. An empty OBJECT is
       * a different statement — it is a table somebody wrote that names no
       * server, i.e. every server off. Do not collapse the two by defaulting
       * this to `{}`.
       *
       * ABSENCE MEANS DIFFERENT THINGS AT THE TWO LEVELS, deliberately:
       *   - a TOOL missing under a PRESENT server → the role template answers;
       *   - a SERVER missing from a table that exists → the whole server is
       *     `off`, and that `off` is a stored answer the template never gets to
       *     sit underneath.
       * The second rule is inherited from the retired `tools.enabled`, which
       * expressed availability by presence. NO CLIENT RELIES ON IT ANY MORE:
       * since task 6 all three Tools panes turn a server off by WRITING, and
       * `profile-update.ts` merges a delta, so a key a PUT omits is left
       * untouched rather than deleted. The rule is kept because the stored table
       * can still hold a missing server (written before seeding, or hand-edited)
       * — letting the role template answer underneath one would show somebody
       * "off" in the UI while the model kept the tools.
       *
       * TURNING A WHOLE SERVER OFF is a named `off` for every tool the catalog
       * lists under it PLUS the reserved `ALL_TOOLS_PERMISSION_KEY` ("*",
       * exported from @sentient/config) for whatever that list cannot
       * enumerate. The wildcard ALONE is a no-op on any seeded account: the
       * resolver checks a tool's own name first, and seeding gave every catalog
       * tool one. This schema never sees the catalog, which is why the wildcard
       * exists at all — a client that does (`withServerMasterPermission`, in
       * every one of the three) writes both halves.
       *
       * Replaces the retired `enabled` map. That field's only consumer was the
       * Hermes profile renderer, whose `mcp:` block Hermes never reads (the
       * gateway registers its MCP at call time — external-tools/
       * hermes-external-tool.ts), so it steered nothing.
       */
      permissions: z.record(z.string().min(1), z.record(z.string().min(1), toolPermissionSchema)).optional(),
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

/**
 * The shape a `PUT /api/v1/profile/me` BODY is parsed against — identical to
 * `profileV1Schema` except `tools.permissions`'s leaf values additionally
 * accept `null` (`ToolPermissionOrClear` — see its doc comment in
 * `@sentient/config` for why a client needs to be able to send that: it is
 * the only way to express "go back to my role default" for one key without
 * deleting anything, now that an absent key under a floor-seeded table means
 * the role template decides rather than `off`).
 *
 * NEVER THE STORED SHAPE. `profile-update.ts#applyProfileUpdate` collapses
 * every `null` to an absent key while merging — a `null` never reaches
 * `ProfileStore.save`, and nothing downstream of the merge (the ToolBroker,
 * the mcp-catalog projection, a GET response) ever sees this schema. Built
 * with `.extend()` rather than a hand-copied second `z.object({...})` so
 * every OTHER field — model, voice, persona, compression, advanced,
 * `tools.toolsets` — stays byte-for-byte the same validation `profileV1Schema`
 * already does; only the one leaf that needs to widen, widens.
 */
export const profileV1PutBodySchema = profileV1Schema.extend({
  tools: z.preprocess(
    migrateEnabledToPermissions,
    z.object({
      permissions: z.record(z.string().min(1), z.record(z.string().min(1), toolPermissionOrClearSchema)).optional(),
      toolsets: z.array(z.string().min(1)).optional(),
    }),
  ),
});
export type ProfileV1PutBody = z.output<typeof profileV1PutBodySchema>;
