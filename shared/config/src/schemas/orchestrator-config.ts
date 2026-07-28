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
    })
    .default({}),
});
export type OrchestratorConfig = z.output<typeof orchestratorConfigSchema>;
