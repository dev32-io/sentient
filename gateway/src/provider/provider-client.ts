// ProviderClient — the OpenAI-compatible streaming chat interface consumed by
// the native ReAct loop (spec §3, Plan 2 Task 2).
//
// `ProviderStreamChunk` is deliberately structurally compatible with
// `MockLLMStreamChunk` (shared/testing/src/mock-llm-provider.ts): both are a
// discriminated union over {type:"text"|"tool_call"}, no optional fields on
// the shared variants. The real provider (`createOpenAIProvider`) drops into
// any loop test written against the mock without adaptation. `"done"` is the
// one variant the mock doesn't carry — it exists only so the terminal
// finishReason/usage can ride the same stream instead of a side-channel.
import type { OrchestratorConfig } from "@sentient/config";
import type { ChatMessage, ChatToolCall } from "../store/model-projection.js";

/** The `reasoning_effort` vocabulary, sourced from the config schema so a new
 *  value can never be accepted by config and rejected here. */
export type ReasoningEffort = OrchestratorConfig["provider"]["reasoning_effort"];

export type ProviderStreamChunk =
  | { type: "text"; content: string }
  | { type: "tool_call"; toolCall: ChatToolCall }
  | {
      type: "done";
      finishReason: string;
      usage?: { promptTokens: number; cachedTokens: number; completionTokens: number };
    };

export interface ProviderTool {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ProviderRequest {
  messages: ChatMessage[];
  tools: ProviderTool[];
  signal: AbortSignal;
  /** Per-request output cap, overriding `orchestrator.provider.max_output_tokens`.
   *  The configured value is an ANSWER cap tuned for a spoken reply; the
   *  compaction summarizer is a different workload (digest a multi-thousand
   *  token transcript, and on a reasoning model emit a whole reasoning channel
   *  first) and needs its own, larger budget or it finishes with
   *  finish_reason:"length" and no visible text at all. */
  maxOutputTokens?: number;
  /**
   * Per-request `reasoning_effort` override, for a workload whose reasoning
   * need differs from the loop's — an auxiliary task (spec §6) wants none at
   * all, since a five-word title has nothing to reason about and the reasoning
   * channel is charged against the same output budget.
   *
   * DOES NOT OVERRIDE THE OPERATOR'S ESCAPE HATCH. When
   * `orchestrator.provider.reasoning_effort` is `"unset"` the field is omitted
   * from every request regardless of what is asked for here — that setting
   * exists because a strict OpenAI-compatible endpoint 400s on the unknown
   * field, and a per-request override that re-introduced it would break every
   * auxiliary call on exactly the deployment that had to disable it.
   */
  reasoningEffort?: ReasoningEffort;
  /**
   * Per-request model override, for a workload that must run a different model
   * than the loop's (`orchestrator.provider.model`, or a user's per-session
   * selection resolved upstream) — the dreamer's nightly map/reduce calls (spec
   * §8) are the first caller: `orchestrator.memory.dreamer.model` lets an
   * operator point background distillation at a cheaper/faster model without
   * touching the chat model. Omitted (or `undefined`) falls back to whatever
   * the `ProviderClient` implementation would otherwise send.
   */
  model?: string;
}

export interface ProviderClient {
  stream(req: ProviderRequest): AsyncGenerator<ProviderStreamChunk>;
}
