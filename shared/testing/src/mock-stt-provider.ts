// Types are structurally compatible with @sentient/gateway's STTProvider.
// Defined locally to avoid cross-package coupling from the testing package.

export type FluxTurnEvent = "StartOfTurn" | "Update" | "EagerEndOfTurn" | "TurnResumed" | "EndOfTurn";

export interface STTConfig {
  readonly apiKey: string;
  readonly model: string;
  readonly language: string;
  readonly sampleRate: number;
  readonly encoding: "linear16" | "opus";
  readonly eotTimeoutMs: number;
  readonly eotThreshold: number;
  readonly eagerEotThreshold: number;
  readonly transcriptTimeoutMs: number;
  readonly keepAliveIntervalMs: number;
  readonly connectTimeoutMs: number;
}

export type TranscriptEvent =
  | {
      type: "turn_info";
      event: FluxTurnEvent;
      transcript: string;
      confidence: number;
      turnIndex: number;
    }
  | { type: "speech_started" };

export interface STTProvider {
  warmup?(config: STTConfig): void;
  dispose?(): void;
  connect(config: STTConfig, signal: AbortSignal): Promise<void>;
  sendAudio(audio: Uint8Array): void;
  finalize(): void;
  flushTranscriptQueue(): void;
  transcripts(signal: AbortSignal): AsyncGenerator<TranscriptEvent>;
  disconnect(): Promise<void>;
}

export interface MockSTTBehavior {
  transcriptEvents?: TranscriptEvent[];
  connectDelay?: number;
  shouldFailConnect?: boolean;
  connectErrorMessage?: string;
  /** When true, transcripts() generator waits for emitEvent() calls after preloaded events. */
  liveMode?: boolean;
}

export interface MockSTTProvider extends STTProvider {
  audioReceived: Uint8Array[];
  isConnected: boolean;
  connectCallCount: number;
  disconnectCallCount: number;
  emitEvent(event: TranscriptEvent): void;
  simulateDisconnect(): void;
}

const DEFAULT_TRANSCRIPT_EVENTS: TranscriptEvent[] = [
  { type: "turn_info", event: "StartOfTurn", transcript: "hello", confidence: 0, turnIndex: 0 },
  { type: "turn_info", event: "EndOfTurn", transcript: "hello world", confidence: 0.99, turnIndex: 0 },
];

type PendingRead = { resolve: (event: TranscriptEvent) => void; reject: (err: unknown) => void } | null;

export function createMockSTTProvider(behavior: MockSTTBehavior = {}): MockSTTProvider {
  const audioReceived: Uint8Array[] = [];
  const preloadedEvents = behavior.transcriptEvents ?? DEFAULT_TRANSCRIPT_EVENTS;

  let isConnected = false;
  let connectCallCount = 0;
  let disconnectCallCount = 0;

  // Live queue for imperative event injection.
  const liveQueue: TranscriptEvent[] = [];
  let pendingRead: PendingRead = null;
  let isClosed = false;
  const liveMode = behavior.liveMode ?? false;

  async function connect(_config: STTConfig, _signal: AbortSignal): Promise<void> {
    connectCallCount++;

    if (behavior.connectDelay && behavior.connectDelay > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, behavior.connectDelay));
    }

    if (behavior.shouldFailConnect) {
      throw new Error(behavior.connectErrorMessage ?? "Mock STT connect failed");
    }

    isConnected = true;
  }

  function sendAudio(audio: Uint8Array): void {
    audioReceived.push(audio);
  }

  function finalize(): void {
    // No-op in mock — events are pre-loaded.
  }

  function flushTranscriptQueue(): void {
    // No-op in mock.
  }

  function emitEvent(event: TranscriptEvent): void {
    if (isClosed) return;
    if (pendingRead) {
      const { resolve } = pendingRead;
      pendingRead = null;
      resolve(event);
    } else {
      liveQueue.push(event);
    }
  }

  function simulateDisconnect(): void {
    isClosed = true;
    if (pendingRead) {
      const { reject } = pendingRead;
      pendingRead = null;
      reject(new Error("Mock STT disconnected"));
    }
  }

  function waitForNextEvent(): Promise<TranscriptEvent> {
    return new Promise<TranscriptEvent>((resolve, reject) => {
      pendingRead = { resolve, reject };
    });
  }

  async function* transcripts(_signal: AbortSignal): AsyncGenerator<TranscriptEvent> {
    for (const event of preloadedEvents) {
      yield event;
    }

    // Only enter live queue loop if liveMode is enabled.
    if (!liveMode) return;

    while (!isClosed) {
      if (liveQueue.length > 0) {
        const next = liveQueue.shift();
        if (next !== undefined) yield next;
        continue;
      }
      try {
        yield await waitForNextEvent();
      } catch {
        return;
      }
    }
  }

  async function disconnect(): Promise<void> {
    disconnectCallCount++;
    isConnected = false;
  }

  return {
    get audioReceived() {
      return audioReceived;
    },
    get isConnected() {
      return isConnected;
    },
    get connectCallCount() {
      return connectCallCount;
    },
    get disconnectCallCount() {
      return disconnectCallCount;
    },
    connect,
    sendAudio,
    finalize,
    flushTranscriptQueue,
    transcripts,
    disconnect,
    emitEvent,
    simulateDisconnect,
  };
}
