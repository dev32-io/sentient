/**
 * Enhanced mock providers with imperative control for test scenarios.
 *
 * Key enhancement over consumer-api mocks: providers expose imperative
 * methods (emitPartial, emitFinal, fail, drop) so tests can control
 * exact timing of events without relying on finalize() triggers.
 */

// ─── Provider interfaces (copied from pipeline SDK) ───

export interface STTProvider {
  connect(signal: AbortSignal): Promise<void>;
  sendAudio(chunk: Uint8Array): void;
  finalize(): void;
  transcripts(signal: AbortSignal): AsyncGenerator<{ text: string; isFinal: boolean }>;
  disconnect(): Promise<void>;
}

export interface LLMProvider {
  stream(messages: Array<{ role: string; content: string }>): AsyncGenerator<string>;
}

export interface TTSProvider {
  connect(signal: AbortSignal): Promise<void>;
  synthesize(text: string, signal: AbortSignal): AsyncGenerator<Uint8Array>;
  disconnect(): Promise<void>;
}

// ─── Controllable Mock STT ───

export interface ControllableSTT extends STTProvider {
  /** Imperatively emit a partial transcript */
  emitPartial(text: string): void;
  /** Imperatively emit a final transcript */
  emitFinal(text: string): void;
  /** Simulate provider failure */
  fail(error: Error): void;
  /** Number of audio chunks received */
  readonly audioChunkCount: number;
  /** Whether finalize() was called */
  readonly finalized: boolean;
  /** Whether connect() was called */
  readonly connected: boolean;
}

export function createControllableSTT(): ControllableSTT {
  let connected = false;
  let finalized = false;
  let audioChunkCount = 0;
  let aborted = false;

  // Queue of transcript events pushed imperatively
  type TranscriptItem =
    | { kind: "transcript"; text: string; isFinal: boolean }
    | { kind: "error"; error: Error }
    | { kind: "end" };

  const queue: TranscriptItem[] = [];
  let waiter: ((item: TranscriptItem) => void) | null = null;

  function push(item: TranscriptItem) {
    if (waiter) {
      const w = waiter;
      waiter = null;
      w(item);
    } else {
      queue.push(item);
    }
  }

  function pull(): Promise<TranscriptItem> {
    if (queue.length > 0) return Promise.resolve(queue.shift()!);
    return new Promise((resolve) => { waiter = resolve; });
  }

  return {
    get audioChunkCount() { return audioChunkCount; },
    get finalized() { return finalized; },
    get connected() { return connected; },

    async connect(_signal) { connected = true; },

    sendAudio(_chunk) { audioChunkCount++; },

    finalize() { finalized = true; },

    async *transcripts(signal) {
      aborted = false;
      signal.addEventListener("abort", () => {
        aborted = true;
        push({ kind: "end" });
      }, { once: true });

      while (!aborted) {
        const item = await pull();
        if (item.kind === "end") return;
        if (item.kind === "error") throw item.error;
        yield { text: item.text, isFinal: item.isFinal };
      }
    },

    async disconnect() { connected = false; },

    emitPartial(text: string) { push({ kind: "transcript", text, isFinal: false }); },
    emitFinal(text: string) { push({ kind: "transcript", text, isFinal: true }); },
    fail(error: Error) { push({ kind: "error", error }); },
  };
}

// ─── Controllable Mock LLM ───

export interface ControllableLLM extends LLMProvider {
  /** Set the response for the next stream() call */
  setResponse(tokens: string[]): void;
  /** Make next stream() call throw */
  setError(error: Error): void;
  /** Set per-token delay */
  setTokenDelay(ms: number): void;
  /** Messages received in last stream() call */
  readonly lastMessages: Array<{ role: string; content: string }>;
  /** Number of stream() calls made */
  readonly streamCount: number;
}

export function createControllableLLM(options?: {
  response?: string;
  tokenDelayMs?: number;
}): ControllableLLM {
  let tokens = (options?.response ?? "I'm great! How can I help?").split(" ")
    .map((w, i) => (i > 0 ? " " : "") + w);
  let tokenDelay = options?.tokenDelayMs ?? 1;
  let error: Error | null = null;
  let lastMessages: Array<{ role: string; content: string }> = [];
  let streamCount = 0;

  return {
    get lastMessages() { return lastMessages; },
    get streamCount() { return streamCount; },

    async *stream(messages) {
      streamCount++;
      lastMessages = [...messages];
      if (error) {
        const e = error;
        error = null;
        throw e;
      }
      for (const token of tokens) {
        await delay(tokenDelay);
        yield token;
      }
    },

    setResponse(newTokens: string[]) { tokens = newTokens; },
    setError(e: Error) { error = e; },
    setTokenDelay(ms: number) { tokenDelay = ms; },
  };
}

// ─── Controllable Mock TTS ───

export interface ControllableTTS extends TTSProvider {
  /** Set frames per sentence */
  setFramesPerSentence(n: number): void;
  /** Make next synthesize() call throw */
  setError(error: Error): void;
  /** Sentences synthesized so far */
  readonly synthesizedSentences: string[];
  /** Whether connect() was called */
  readonly connected: boolean;
}

export function createControllableTTS(options?: {
  frameSizeBytes?: number;
  framesPerSentence?: number;
  frameDelayMs?: number;
}): ControllableTTS {
  const frameSize = options?.frameSizeBytes ?? 320;
  let framesPerSentence = options?.framesPerSentence ?? 2;
  const frameDelay = options?.frameDelayMs ?? 1;
  let error: Error | null = null;
  let connected = false;
  const synthesizedSentences: string[] = [];

  return {
    get synthesizedSentences() { return [...synthesizedSentences]; },
    get connected() { return connected; },

    async connect(_signal) { connected = true; },

    async *synthesize(text, signal) {
      synthesizedSentences.push(text);
      if (error) {
        const e = error;
        error = null;
        throw e;
      }
      for (let i = 0; i < framesPerSentence; i++) {
        if (signal.aborted) return;
        await delay(frameDelay);
        // Encode sentence index in first byte for verification
        const frame = new Uint8Array(frameSize);
        frame[0] = synthesizedSentences.length;
        yield frame;
      }
    },

    async disconnect() { connected = false; },

    setFramesPerSentence(n: number) { framesPerSentence = n; },
    setError(e: Error) { error = e; },
  };
}

// ─── Scripted Mock STT (auto-emits on finalize, simpler for happy-path tests) ───

export function createScriptedSTT(options?: {
  partials?: string[];
  finalText?: string;
  latencyMs?: number;
}): STTProvider {
  const partials = options?.partials ?? ["hel", "hello"];
  const finalText = options?.finalText ?? "hello how are you";
  const latency = options?.latencyMs ?? 1;
  let resolveFinalize: (() => void) | null = null;

  return {
    async connect(_signal) {},
    sendAudio(_chunk) {},
    finalize() { resolveFinalize?.(); },
    async *transcripts(signal) {
      let aborted = false;
      signal.addEventListener("abort", () => { aborted = true; }, { once: true });
      await new Promise<void>((resolve) => { resolveFinalize = resolve; });
      for (const partial of partials) {
        if (aborted) return;
        await delay(latency);
        yield { text: partial, isFinal: false };
      }
      if (!aborted) {
        await delay(latency);
        yield { text: finalText, isFinal: true };
      }
    },
    async disconnect() {},
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
