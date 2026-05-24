// ---------------------------------------------------------------------------
// LLM types for the OpenRouter provider and the emotion-tagger.
// The gateway no longer calls LLMs for cognitive cycles (Hermes handles that),
// but the emotion-tagger stage still needs an LLM provider for text enrichment,
// and the OpenRouter provider is the concrete implementation.
// ---------------------------------------------------------------------------

export interface LLMMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: LLMToolCall[];
  tool_call_id?: string;
}

export interface LLMToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface LLMStreamOptions {
  model: string;
  messages: LLMMessage[];
  signal: AbortSignal;
  maxTokens?: number;
  temperature?: number;
  tools?: LLMToolDefinition[];
  tool_choice?: "auto" | "required" | "none";
}

export type LLMStreamChunk =
  | { type: "text"; content: string }
  | { type: "tool_call_delta"; delta: LLMToolCallDelta }
  | { type: "tool_call"; toolCall: LLMToolCall };

export interface LLMToolCall {
  id: string;
  function: { name: string; arguments: string };
}

export interface LLMToolCallDelta {
  id: string;
  index: number;
  nameChunk?: string;
  argsChunk?: string;
}

export interface LLMProvider {
  stream(options: LLMStreamOptions): AsyncGenerator<LLMStreamChunk>;
}
