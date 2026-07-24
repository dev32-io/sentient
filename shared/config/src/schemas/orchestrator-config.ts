import { z } from "zod";

export const orchestratorConfigSchema = z.object({
  provider: z.object({
    // OpenAI-compatible base URL (OpenRouter, local Ollama, etc.).
    base_url: z.string().url(),
    // Model id sent on every request.
    model: z.string().min(1),
    // Env var name holding the API key (secrets only via ${VAR}).
    api_key_env: z.string().min(1),
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
});
export type OrchestratorConfig = z.output<typeof orchestratorConfigSchema>;
