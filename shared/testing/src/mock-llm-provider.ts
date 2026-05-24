// Types are structurally compatible with gateway's LLM streaming interface.
// Defined locally to avoid cross-package coupling from the testing package.

// Must mirror LLMStreamChunk exactly (discriminated union, no optional fields).
export type MockLLMStreamChunk =
  | { type: "text"; content: string }
  | { type: "tool_call"; toolCall: { id: string; function: { name: string; arguments: string } } };

export interface MockLLMBehavior {
  response?: string;
  tokens?: string[];
  tokenDelayMs?: number;
  shouldFail?: boolean;
  failAfterTokens?: number;
  errorMessage?: string;
}

export interface MockLLMProvider {
  stream(options: {
    messages: Array<{ role: string; content: string }>;
    signal: AbortSignal;
  }): AsyncGenerator<MockLLMStreamChunk>;
  streamCallCount: number;
  lastMessages: Array<{ role: string; content: string }>;
}

const DEFAULT_TOKENS = ["Hello", " ", "world"];

function resolveTokens(behavior: MockLLMBehavior): string[] {
  if (behavior.tokens) return behavior.tokens;
  if (behavior.response) return behavior.response.split(/(\s+)/);
  return DEFAULT_TOKENS;
}

export function createMockLLMProvider(behavior: MockLLMBehavior = {}): MockLLMProvider {
  let streamCallCount = 0;
  let lastMessages: Array<{ role: string; content: string }> = [];

  const tokens = resolveTokens(behavior);
  const tokenDelayMs = behavior.tokenDelayMs ?? 0;

  async function* stream(options: {
    messages: Array<{ role: string; content: string }>;
    signal: AbortSignal;
  }): AsyncGenerator<MockLLMStreamChunk> {
    streamCallCount++;
    lastMessages = options.messages;

    if (behavior.shouldFail) {
      throw new Error(behavior.errorMessage ?? "Mock LLM stream failed");
    }

    for (let i = 0; i < tokens.length; i++) {
      if (options.signal.aborted) return;

      if (tokenDelayMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, tokenDelayMs));
        if (options.signal.aborted) return;
      }

      const token = tokens[i];
      if (token === undefined) continue;
      yield { type: "text", content: token };

      const tokensYielded = i + 1;

      if (behavior.failAfterTokens !== undefined && tokensYielded >= behavior.failAfterTokens) {
        throw new Error(behavior.errorMessage ?? "Mock LLM failed after tokens");
      }
    }
  }

  return {
    get streamCallCount() {
      return streamCallCount;
    },
    get lastMessages() {
      return lastMessages;
    },
    stream,
  };
}
