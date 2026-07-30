import { z } from "zod";

export const orchestratorConfigSchema = z.object({
  provider: z.object({
    // OPTIONAL OpenAI-compatible base URL override (OpenRouter, local Ollama,
    // etc.). The composition root's active-provider connection comes from
    // the operator's secrets store (`SecretsStore.getActiveLlm()`) — this
    // key is consulted ONLY when the secrets store's own base_url is empty
    // (e.g. the default openrouter entry ships with no base_url). Leave
    // empty ("") to always defer to the secrets store.
    base_url: z.union([z.literal(""), z.string().url()]).default(""),
    // Model id sent on every request. The key + base_url are resolved from
    // the secrets store at composition-root construction time, NOT from an
    // env var — see gateway/src/bootstrap/resolve-provider-connection.ts.
    model: z.string().min(1),
    // Per-request cap.
    max_output_tokens: z.number().int().min(1).max(32000).default(1024),
    // Per-request wall-clock deadline (ms). Match to the model's worst case.
    request_timeout_ms: z.number().int().min(1000).max(600000).default(120000),
    // Optional site attribution headers (OpenRouter convention).
    site_name: z.string().default("Sentient"),
  }),
  loop: z.object({
    // ReAct iteration cap: consecutive tool-calling iterations before a
    // forced content-only final answer.
    max_iterations: z.number().int().min(1).max(50).default(10),
  }),
  permission: z
    .object({
      // Wall-clock deadline for a human answer to an L3 `confirm` prompt
      // (ms). On expiry the request AUTO-DENIES (spec §7.1 — a timeout is
      // never an implicit approval) and the model receives a "permission
      // request timed out" tool result. 5000-600000; spec default 120000
      // (2 minutes).
      request_timeout_ms: z.number().int().min(5000).max(600000).default(120000),
    })
    // Block-level default: operator configs (`~/.sentient/gateway/config/config.yaml`)
    // are edited in place and predate this key — a missing block must never
    // brick boot for a gateway that was working yesterday.
    .default({}),
  tools: z.object({
    // Per-tool-call deadline for a foreground MCP call (ms).
    foreground_timeout_ms: z.number().int().min(1000).max(120000).default(30000),
    // Max concurrent background tasks per session (generous for family scale).
    max_concurrent_background_tasks: z.number().int().min(1).max(500).default(50),
  }),
  delegation: z.object({
    // Per-agent frontmatter file dir (static delegation envelopes).
    frontmatter_dir: z.string().default("./config/delegation"),
    // Deadline for a single Hermes one-shot invocation (ms). Long-running.
    hermes_timeout_ms: z.number().int().min(1000).max(3600000).default(600000),
    // Configured Hermes profile that each new per-user profile is cloned from,
    // so the clone inherits provider + model + credentials. The gateway never
    // holds a Hermes credential; Hermes copies its own.
    hermes_source_profile: z.string().min(1).default("default"),
    // Deadline for one `hermes profile create` (ms). Range 1000-120000.
    hermes_profile_create_timeout_ms: z.number().int().min(1000).max(120000).default(30000),
    // Deadline for one `hermes mcp add` / `hermes config get` invocation used
    // to register the gateway's MCP on a user's Hermes profile (ms). `mcp add`
    // dials the socket and lists its tools before saving, so this is longer
    // than a pure config write. Range 1000-120000.
    hermes_mcp_register_timeout_ms: z.number().int().min(1000).max(120000).default(30000),
  }),
  compaction: z
    .object({
      // Master switch (spec §8). false = the model window grows unbounded
      // until the provider rejects the request; only sensible for a
      // short-lived debug session.
      enabled: z.boolean().default(true),
      // Estimated model-window size (tokens) at or above which a compaction
      // fires at the NEXT turn boundary. Set to roughly 40-60% of the active
      // model's context window: the estimate is character-based (±30%) and
      // the summarizer itself needs headroom to read the transcript it is
      // compacting. Range 1000-1000000.
      compact_threshold_tokens: z.number().int().min(1000).max(1000000).default(24000),
      // How many of the most recent turns are copied VERBATIM into the
      // compaction marker instead of being summarized away. Recent detail
      // survives inside the marker's own text because the model projection
      // slices POSITIONALLY from the marker forward — nothing can be left
      // "after" an append-only marker. 0 = summarize everything.
      // Range 0-50.
      keep_recent_turns: z.number().int().min(0).max(50).default(4),
      // Output cap for the SUMMARIZER request specifically. The loop's
      // `provider.max_output_tokens` is an ANSWER cap; a reasoning model
      // (gpt-oss:20b emits a Harmony reasoning channel before any visible
      // text) exhausts 1024 on the transcript it is digesting and finishes
      // with finish_reason:"length" and an EMPTY summary, which fails
      // compaction silently and forever. Range 512-8000.
      summarizer_max_output_tokens: z.number().int().min(512).max(8000).default(4000),
      // Consecutive failed compaction attempts before the runtime stops
      // retrying at every single turn boundary and logs one ERROR naming the
      // reason. Past this it retries on an exponentially widening turn
      // interval instead, so a permanently-failing summarizer costs one
      // provider call per 2^n turns rather than one per turn. Range 1-20.
      max_consecutive_failures: z.number().int().min(1).max(20).default(3),
      // Ceiling on that exponentially widening retry interval, in turn
      // boundaries. Without one, `2 ** (failures - max_consecutive_failures)`
      // doubles forever: ~20 further failures puts the next attempt a million
      // turns away, which in a long session IS the permanent give-up the gate
      // is documented not to be. On reaching the cap the runtime logs one
      // ERROR naming it, so a stalled summarizer is visible rather than silent.
      // Keep well above max_consecutive_failures and low enough that a
      // recovered provider is retried within one sitting. Range 1-256.
      max_backoff_turns: z.number().int().min(1).max(256).default(16),
    })
    .default({}),
});
export type OrchestratorConfig = z.output<typeof orchestratorConfigSchema>;
