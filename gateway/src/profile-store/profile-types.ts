import { audioPrefsSchema } from "@sentient/audio-prefs";
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
  tools: z.object({
    // Per-server, per-user MCP tool whitelist. Keys match names in
    // gateway/config.yaml#mcp_catalog; unknown server names are dropped
    // at render time with a warn. The value is an array of tool names
    // the user has narrowed to. Conventions:
    //   []        — inherit the catalog's `tools.include` (i.e. all
    //               operator-allowed tools). Most common shape.
    //   ["a","b"] — user further narrows to a subset of the catalog
    //               whitelist. Names not in the catalog whitelist are
    //               dropped at render with a warn.
    // Legacy: older profile.json files store this as `string[]` (just
    // the server names). The .preprocess() below auto-migrates that
    // form to `{name: []}` so we don't need a schema-version bump.
    enabled: z.preprocess(
      (v) => {
        if (Array.isArray(v)) {
          return Object.fromEntries(
            (v as unknown[]).filter((s): s is string => typeof s === "string").map((s) => [s, [] as string[]]),
          );
        }
        return v;
      },
      z.record(z.string().min(1), z.array(z.string().min(1))),
    ),
    // Hermes built-in toolsets exposed to the agent loop. Names must
    // appear in hermes_cli/tools_config.CONFIGURABLE_TOOLSETS — common
    // values: memory, todo, clarify, skills, session_search,
    // messaging, web, browser, terminal, file, vision. Empty list is
    // legal (no built-ins, MCP-only). Optional for back-compat with
    // older profile.json files; renderer falls back to a curated lean
    // default when missing.
    toolsets: z.array(z.string().min(1)).optional(),
  }),
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
  devices: z
    .object({
      signal: z
        .object({
          paired: z.boolean(),
          // Display-only masked E.164, e.g. "+1•••••1234". Never the raw number.
          account_masked: z.string().optional(),
          linked_at: z.string().datetime().optional(),
        })
        .optional(),
    })
    .optional(),
});

export type ProfileV1 = z.output<typeof profileV1Schema>;
