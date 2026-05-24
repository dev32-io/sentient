import { z } from "zod";

// ---------------------------------------------------------------------------
// HermesEvent discriminated union
// ---------------------------------------------------------------------------
// Gateway-internal event shape emitted by HermesClient to its caller
// (AttentionGate / subscribers). Corresponds to Hermes SSE events but is
// type-friendly and stable across API version changes.

export const hermesEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("created"),
    responseId: z.string(),
    conversationId: z.string(),
  }),
  z.object({
    type: z.literal("text.delta"),
    delta: z.string(),
  }),
  z.object({
    type: z.literal("tool.started"),
    callId: z.string(),
    toolName: z.string(),
    argsPreview: z.string(),
  }),
  // Conditional on Phase 1.0 measurement M-3: Hermes does NOT emit
  // function_call_arguments.delta — tool args arrive atomically.
  // Schema entry is kept for forward compatibility; callers must not rely
  // on receiving this event type from Hermes.
  z.object({
    type: z.literal("tool.args.delta"),
    callId: z.string(),
    delta: z.string(),
  }),
  z.object({
    type: z.literal("tool.finished"),
    callId: z.string(),
    status: z.enum(["ok", "failed"]),
    summary: z.string(),
  }),
  z.object({
    type: z.literal("completed"),
    usage: z.object({
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
      // Provider-reported prompt-cache hit (Gemini, OpenAI, DeepSeek pass
      // this through the OpenAI-shape input_tokens_details.cached_tokens).
      // 0 when cache miss or provider doesn't report. Useful for
      // diagnosing whether the per-cycle prefix tax is amortized.
      cachedInputTokens: z.number().int().nonnegative().optional(),
      // Reasoning model's hidden thinking tokens (o-series, Gemini thinking,
      // DeepSeek-R*). 0 / undefined for non-reasoning models. Cost-relevant
      // and explains TTFT spikes when reasoning sneaks on.
      reasoningTokens: z.number().int().nonnegative().optional(),
    }),
  }),
  z.object({
    type: z.literal("error"),
    message: z.string(),
  }),
]);

export type HermesEvent = z.infer<typeof hermesEventSchema>;

// ---------------------------------------------------------------------------
// Turn input
// ---------------------------------------------------------------------------

export interface HermesTurnInput {
  userId: string;
  cycleId: string;
  userMessage: string;
  conversationId: string | null;
  maxOutputTokens: number;
  /**
   * Optional gateway-minted session id. When set, the outbound
   * `user.message` carries `session_id` and the Python adapter forces
   * Hermes' active session onto this id (creating the SQLite row via
   * `ensure_session` if absent). Used by `+ New chat` to start a fresh
   * Hermes chain — without it, Hermes' single-session-per-tuple keying
   * collapses every chat onto the same chain.
   */
  forcedSessionId?: string;
}

// ---------------------------------------------------------------------------
// Dispatch mode
// ---------------------------------------------------------------------------

export interface DispatchMode {
  bargedIn(): boolean;
}
