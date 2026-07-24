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
}

export interface ProviderClient {
  stream(req: ProviderRequest): AsyncGenerator<ProviderStreamChunk>;
}
