// Types are structurally compatible with @sentient/gateway's TTSProvider.
// Defined locally to avoid cross-package coupling from the testing package.

export interface TTSAudioChunk {
  readonly data: Uint8Array;
  readonly encoding: "opus" | "pcm" | "mp3";
  readonly sampleRate: number;
  readonly isFinal: boolean;
}

export interface TTSProvider {
  warmup(): void;
  ready(signal: AbortSignal): Promise<void>;
  pushText(text: string): void;
  audioFrames(signal: AbortSignal): AsyncGenerator<TTSAudioChunk>;
  endInput(): void;
  dispose(): void;
}

export interface MockTTSBehavior {
  /** How many audio chunks to emit before endInput is called. */
  chunkCount?: number;
  chunkSizeBytes?: number;
  delayPerChunkMs?: number;
  /** If true, `ready()` rejects with errorMessage. */
  shouldFailReady?: boolean;
  errorMessage?: string;
  /** Simulate a hung provider (never emits frames, never finishes). */
  stall?: boolean;
}

export interface MockTTSProvider extends TTSProvider {
  warmupCallCount: number;
  readyCallCount: number;
  pushTextCalls: string[];
  endInputCallCount: number;
  disposeCallCount: number;
}

const DEFAULT_CHUNK_COUNT = 3;
const DEFAULT_CHUNK_SIZE_BYTES = 960;
const DEFAULT_DELAY_PER_CHUNK_MS = 0;

export function createMockTTSProvider(behavior: MockTTSBehavior = {}): MockTTSProvider {
  const pushTextCalls: string[] = [];
  const chunkCount = behavior.chunkCount ?? DEFAULT_CHUNK_COUNT;
  const chunkSizeBytes = behavior.chunkSizeBytes ?? DEFAULT_CHUNK_SIZE_BYTES;
  const delayPerChunkMs = behavior.delayPerChunkMs ?? DEFAULT_DELAY_PER_CHUNK_MS;

  let warmupCallCount = 0;
  let readyCallCount = 0;
  let endInputCallCount = 0;
  let disposeCallCount = 0;
  let inputEnded = false;
  let disposed = false;

  function warmup(): void {
    warmupCallCount += 1;
  }

  async function ready(signal: AbortSignal): Promise<void> {
    readyCallCount += 1;
    if (behavior.shouldFailReady) {
      throw new Error(behavior.errorMessage ?? "Mock TTS ready failed");
    }
    if (signal.aborted) throw new Error("aborted");
  }

  function pushText(text: string): void {
    pushTextCalls.push(text);
  }

  function endInput(): void {
    endInputCallCount += 1;
    inputEnded = true;
  }

  function dispose(): void {
    disposeCallCount += 1;
    disposed = true;
  }

  async function* audioFrames(signal: AbortSignal): AsyncGenerator<TTSAudioChunk> {
    if (behavior.stall) {
      if (!signal.aborted) {
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      }
      return;
    }

    for (let i = 0; i < chunkCount; i++) {
      if (signal.aborted || disposed) return;

      if (delayPerChunkMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, delayPerChunkMs));
        if (signal.aborted || disposed) return;
      }

      yield {
        data: new Uint8Array(chunkSizeBytes),
        encoding: "opus",
        sampleRate: 48000,
        isFinal: i === chunkCount - 1,
      };
    }

    // If caller hasn't called endInput yet, wait until they do or abort.
    while (!inputEnded && !disposed && !signal.aborted) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
  }

  return {
    get warmupCallCount() {
      return warmupCallCount;
    },
    get readyCallCount() {
      return readyCallCount;
    },
    get pushTextCalls() {
      return pushTextCalls;
    },
    get endInputCallCount() {
      return endInputCallCount;
    },
    get disposeCallCount() {
      return disposeCallCount;
    },
    warmup,
    ready,
    pushText,
    audioFrames,
    endInput,
    dispose,
  };
}
