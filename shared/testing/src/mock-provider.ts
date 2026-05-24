export type ProviderType = "stt" | "llm" | "tts";

export interface MockProviderBehavior {
  latencyMs?: number;
  shouldFail?: boolean;
  failAfterChunks?: number;
  errorMessage?: string;
}

/** Creates a mock async generator that simulates a streaming provider */
export async function* createMockStream<T>(chunks: T[], behavior: MockProviderBehavior = {}): AsyncGenerator<T> {
  const { latencyMs = 0, shouldFail = false, failAfterChunks, errorMessage = "Provider error" } = behavior;

  for (let i = 0; i < chunks.length; i++) {
    if (shouldFail && failAfterChunks !== undefined && i >= failAfterChunks) {
      throw new Error(errorMessage);
    }
    if (latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, latencyMs));
    }
    yield chunks[i] as T;
  }

  if (shouldFail && failAfterChunks === undefined) {
    throw new Error(errorMessage);
  }
}
