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
import type { ChatMessage, ChatToolCall } from "../store/model-projection.js";

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
}

export interface ProviderClient {
  stream(req: ProviderRequest): AsyncGenerator<ProviderStreamChunk>;
}
