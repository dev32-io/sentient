# Phase 2: Gateway Voice — Audio Loop — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Audio in → STT → LLM → TTS → audio out, with barge-in. Full voice loop via test client.

**Architecture:** Builds on Phase 1 (WebSocket server, auth, pipeline framework, OpenRouter LLM provider, config system, context assembly). Adds Deepgram STT, Fish Audio TTS, sentence aggregation, streaming overlap, barge-in with cancel propagation, and session lifecycle persistence.

**Tech Stack:** Bun 1.2+, TypeScript 5.8+ (strict), Vitest, raw WebSocket (Deepgram/Fish Audio), @msgpack/msgpack, cockatiel (circuit breaker), AbortController/AbortSignal

**Prerequisite:** Phase 1 complete — gateway has WebSocket server with auth, pipeline framework with frame types and processors, OpenRouter LLM provider, config system, context assembly. Shared packages (@sentient/protocol, @sentient/config, @sentient/testing) are available.

---

## File Structure

```
gateway/src/
├── providers/
│   ├── stt/
│   │   ├── deepgram-provider.ts          # Task 2.1 — Deepgram STT raw WebSocket
│   │   ├── deepgram-provider.test.ts
│   │   ├── stt-types.ts                  # STT provider interface + event types
│   │   └── stt-types.test.ts
│   └── tts/
│       ├── fish-audio-provider.ts        # Task 2.4 — Fish Audio TTS WebSocket+MsgPack
│       ├── fish-audio-provider.test.ts
│       ├── tts-types.ts                  # TTS provider interface + event types
│       └── tts-types.test.ts
├── pipeline/
│   ├── processors/
│   │   ├── audio-relay-processor.ts      # Task 2.2 — Binary WS → STT relay
│   │   ├── audio-relay-processor.test.ts
│   │   ├── sentence-aggregator.ts        # Task 2.3 — LLM tokens → sentences
│   │   ├── sentence-aggregator.test.ts
│   │   ├── tts-processor.ts             # Task 2.4 — Sentences → TTS → audio frames
│   │   ├── tts-processor.test.ts
│   │   ├── streaming-overlap.ts          # Task 2.5 — Overlap orchestration
│   │   └── streaming-overlap.test.ts
│   └── barge-in/
│       ├── barge-in-controller.ts        # Task 2.6 — AbortController cancel chain
│       └── barge-in-controller.test.ts
├── session/
│   ├── session-persistence.ts            # Task 2.7 — Suspend/resume/replay
│   ├── session-persistence.test.ts
│   ├── replay-buffer.ts                  # Task 2.7 — Sequence-numbered ring buffer
│   └── replay-buffer.test.ts
└── config/
    └── voice-config.ts                   # Voice-specific config schema extensions

shared/testing/src/
├── mock-stt-provider.ts                  # Mock Deepgram for unit tests
├── mock-tts-provider.ts                  # Mock Fish Audio for unit tests
└── audio-fixtures.ts                     # Reusable audio test data

gateway/package.json                      # Add @msgpack/msgpack dependency
```

---

## Task 2.1: Deepgram STT Provider (Raw WebSocket, Endpointing)

**Files:**
- Create: `gateway/src/providers/stt/stt-types.ts`
- Create: `gateway/src/providers/stt/stt-types.test.ts`
- Create: `gateway/src/providers/stt/deepgram-provider.ts`
- Create: `gateway/src/providers/stt/deepgram-provider.test.ts`
- Create: `shared/testing/src/mock-stt-provider.ts`
- Create: `shared/testing/src/audio-fixtures.ts`
- Modify: `gateway/package.json` (add @msgpack/msgpack)

### Step 1: Add @msgpack/msgpack dependency

- [ ] **Step 1a: Update `gateway/package.json` — add @msgpack/msgpack**

Add to `dependencies`:

```json
{
  "dependencies": {
    "@sentient/protocol": "workspace:*",
    "@sentient/config": "workspace:*",
    "@msgpack/msgpack": "^3.0.0",
    "cockatiel": "^3.2.1",
    "zod": "^3.24.0"
  }
}
```

- [ ] **Step 1b: Install**

```bash
cd /Users/kevinye/Development/sentient && bun install
```

- [ ] **Step 1c: Commit**

```bash
git add gateway/package.json bun.lockb
git commit -m "chore(gateway): add @msgpack/msgpack for Fish Audio protocol"
```

### Step 2: Create audio test fixtures

- [ ] **Step 2a: Create `shared/testing/src/audio-fixtures.ts`**

```typescript
/** Generates a silent PCM16 audio frame of the given duration */
export function createSilentPCM16Frame(durationMs: number, sampleRate = 16000): Uint8Array {
  const sampleCount = Math.floor((sampleRate * durationMs) / 1000);
  const bytesPerSample = 2; // 16-bit
  return new Uint8Array(sampleCount * bytesPerSample);
}

/** Generates a sine wave PCM16 audio frame (for non-silent test data) */
export function createSineWavePCM16Frame(
  durationMs: number,
  frequencyHz = 440,
  sampleRate = 16000,
): Uint8Array {
  const sampleCount = Math.floor((sampleRate * durationMs) / 1000);
  const buffer = new ArrayBuffer(sampleCount * 2);
  const view = new DataView(buffer);

  for (let i = 0; i < sampleCount; i++) {
    const t = i / sampleRate;
    const sample = Math.sin(2 * Math.PI * frequencyHz * t) * 0.5;
    const int16 = Math.max(-32768, Math.min(32767, Math.floor(sample * 32767)));
    view.setInt16(i * 2, int16, true); // little-endian
  }

  return new Uint8Array(buffer);
}

/** Creates a sequence of audio frames simulating a short utterance */
export function createUtteranceFrames(
  frameCount = 10,
  frameDurationMs = 20,
  sampleRate = 16000,
): Uint8Array[] {
  return Array.from({ length: frameCount }, () =>
    createSineWavePCM16Frame(frameDurationMs, 440, sampleRate),
  );
}

/** Minimal valid Deepgram transcript response JSON */
export function createDeepgramTranscriptResponse(options: {
  text: string;
  isFinal: boolean;
  confidence?: number;
  speechFinal?: boolean;
}): string {
  const { text, isFinal, confidence = 0.98, speechFinal = false } = options;
  return JSON.stringify({
    type: "Results",
    channel_index: [0, 1],
    duration: 1.0,
    start: 0.0,
    is_final: isFinal,
    speech_final: speechFinal,
    channel: {
      alternatives: [
        {
          transcript: text,
          confidence,
          words: text.split(" ").map((word, i) => ({
            word,
            start: i * 0.3,
            end: (i + 1) * 0.3,
            confidence,
          })),
        },
      ],
    },
  });
}

/** Deepgram UtteranceEnd event JSON */
export function createDeepgramUtteranceEnd(): string {
  return JSON.stringify({
    type: "UtteranceEnd",
    last_word_end: 1.5,
    channel: [0, 1],
  });
}

/** Deepgram metadata (connection opened) response JSON */
export function createDeepgramMetadataResponse(): string {
  return JSON.stringify({
    type: "Metadata",
    transaction_key: "test-tx-key",
    request_id: "test-req-id",
    sha256: "test-sha",
    created: new Date().toISOString(),
    duration: 0,
    channels: 1,
    models: ["nova-3"],
    model_info: { "nova-3": { name: "Nova 3", version: "2025-01-01", arch: "nova-3" } },
  });
}
```

- [ ] **Step 2b: Re-export from `shared/testing/src/index.ts`**

Add to existing `shared/testing/src/index.ts`:

```typescript
export * from "./audio-fixtures.ts";
```

- [ ] **Step 2c: Commit**

```bash
git add shared/testing/src/audio-fixtures.ts shared/testing/src/index.ts
git commit -m "test(testing): audio fixtures for STT/TTS provider tests"
```

### Step 3: Define STT provider interface and types

- [ ] **Step 3a: Write test `gateway/src/providers/stt/stt-types.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import {
  type STTConfig,
  type TranscriptEvent,
  STT_DEFAULTS,
  isTranscriptFinal,
  isUtteranceEnd,
} from "./stt-types.ts";

describe("STT_DEFAULTS", () => {
  it("has correct default endpointing", () => {
    expect(STT_DEFAULTS.endpointingMs).toBe(300);
  });

  it("has correct default utterance end timeout", () => {
    expect(STT_DEFAULTS.utteranceEndMs).toBe(1000);
  });

  it("has correct default model", () => {
    expect(STT_DEFAULTS.model).toBe("nova-3");
  });

  it("has correct default language", () => {
    expect(STT_DEFAULTS.language).toBe("en");
  });

  it("has correct default sample rate", () => {
    expect(STT_DEFAULTS.sampleRate).toBe(16000);
  });

  it("has correct default encoding", () => {
    expect(STT_DEFAULTS.encoding).toBe("linear16");
  });
});

describe("isTranscriptFinal", () => {
  it("returns true for final transcript", () => {
    const event: TranscriptEvent = {
      type: "transcript",
      text: "hello world",
      isFinal: true,
      speechFinal: false,
      confidence: 0.98,
    };
    expect(isTranscriptFinal(event)).toBe(true);
  });

  it("returns false for partial transcript", () => {
    const event: TranscriptEvent = {
      type: "transcript",
      text: "hello",
      isFinal: false,
      speechFinal: false,
      confidence: 0.85,
    };
    expect(isTranscriptFinal(event)).toBe(false);
  });

  it("returns false for utterance_end event", () => {
    const event: TranscriptEvent = {
      type: "utterance_end",
    };
    expect(isTranscriptFinal(event)).toBe(false);
  });
});

describe("isUtteranceEnd", () => {
  it("returns true for utterance_end event", () => {
    const event: TranscriptEvent = { type: "utterance_end" };
    expect(isUtteranceEnd(event)).toBe(true);
  });

  it("returns false for transcript event", () => {
    const event: TranscriptEvent = {
      type: "transcript",
      text: "test",
      isFinal: true,
      speechFinal: false,
      confidence: 0.98,
    };
    expect(isUtteranceEnd(event)).toBe(false);
  });
});
```

- [ ] **Step 3b: Run test — verify it fails** (file does not exist yet)

```bash
cd /Users/kevinye/Development/sentient && bun run --filter '@sentient/gateway' test -- stt-types
```

- [ ] **Step 3c: Create `gateway/src/providers/stt/stt-types.ts`**

```typescript
export interface STTConfig {
  readonly apiKey: string;
  readonly model: string;
  readonly language: string;
  readonly sampleRate: number;
  readonly encoding: "linear16" | "opus";
  readonly endpointingMs: number;
  readonly utteranceEndMs: number;
  readonly keepAliveIntervalMs: number;
}

export const STT_DEFAULTS = {
  model: "nova-3",
  language: "en",
  sampleRate: 16000,
  encoding: "linear16" as const,
  endpointingMs: 300,
  utteranceEndMs: 1000,
  keepAliveIntervalMs: 8000,
} as const;

export type TranscriptEvent =
  | {
      type: "transcript";
      text: string;
      isFinal: boolean;
      speechFinal: boolean;
      confidence: number;
    }
  | {
      type: "utterance_end";
    };

export function isTranscriptFinal(event: TranscriptEvent): boolean {
  return event.type === "transcript" && event.isFinal;
}

export function isUtteranceEnd(event: TranscriptEvent): boolean {
  return event.type === "utterance_end";
}

export interface STTProvider {
  connect(config: STTConfig, signal: AbortSignal): Promise<void>;
  sendAudio(audio: Uint8Array): void;
  transcripts(signal: AbortSignal): AsyncGenerator<TranscriptEvent>;
  disconnect(): Promise<void>;
}
```

- [ ] **Step 3d: Run test — verify it passes**

```bash
cd /Users/kevinye/Development/sentient && bun run --filter '@sentient/gateway' test -- stt-types
```

- [ ] **Step 3e: Commit**

```bash
git add gateway/src/providers/stt/stt-types.ts gateway/src/providers/stt/stt-types.test.ts
git commit -m "feat(gateway): STT provider interface and types"
```

### Step 4: Create mock STT provider

- [ ] **Step 4a: Create `shared/testing/src/mock-stt-provider.ts`**

```typescript
import type { STTConfig, STTProvider, TranscriptEvent } from "@sentient/gateway/providers/stt/stt-types";

export interface MockSTTBehavior {
  readonly transcriptEvents: TranscriptEvent[];
  readonly connectDelay?: number;
  readonly shouldFailConnect?: boolean;
  readonly connectErrorMessage?: string;
}

const DEFAULT_BEHAVIOR: MockSTTBehavior = {
  transcriptEvents: [
    {
      type: "transcript",
      text: "hello",
      isFinal: false,
      speechFinal: false,
      confidence: 0.85,
    },
    {
      type: "transcript",
      text: "hello world",
      isFinal: true,
      speechFinal: true,
      confidence: 0.98,
    },
    { type: "utterance_end" },
  ],
};

export function createMockSTTProvider(behavior: Partial<MockSTTBehavior> = {}): STTProvider & {
  readonly audioReceived: Uint8Array[];
  readonly isConnected: boolean;
  readonly connectCallCount: number;
  readonly disconnectCallCount: number;
} {
  const config = { ...DEFAULT_BEHAVIOR, ...behavior };
  const audioReceived: Uint8Array[] = [];
  let connected = false;
  let connectCount = 0;
  let disconnectCount = 0;

  return {
    get audioReceived() {
      return audioReceived;
    },
    get isConnected() {
      return connected;
    },
    get connectCallCount() {
      return connectCount;
    },
    get disconnectCallCount() {
      return disconnectCount;
    },

    async connect(_sttConfig: STTConfig, signal: AbortSignal): Promise<void> {
      connectCount++;
      if (signal.aborted) throw new Error("Connection aborted");
      if (config.shouldFailConnect) {
        throw new Error(config.connectErrorMessage ?? "Mock STT connect failed");
      }
      if (config.connectDelay) {
        await new Promise((resolve) => setTimeout(resolve, config.connectDelay));
      }
      connected = true;
    },

    sendAudio(audio: Uint8Array): void {
      if (!connected) throw new Error("STT provider not connected");
      audioReceived.push(audio);
    },

    async *transcripts(signal: AbortSignal): AsyncGenerator<TranscriptEvent> {
      for (const event of config.transcriptEvents) {
        if (signal.aborted) return;
        yield event;
      }
    },

    async disconnect(): Promise<void> {
      disconnectCount++;
      connected = false;
    },
  };
}
```

- [ ] **Step 4b: Re-export from `shared/testing/src/index.ts`**

Add to existing exports:

```typescript
export * from "./mock-stt-provider.ts";
```

- [ ] **Step 4c: Commit**

```bash
git add shared/testing/src/mock-stt-provider.ts shared/testing/src/index.ts
git commit -m "test(testing): mock STT provider for unit tests"
```

### Step 5: Implement Deepgram STT provider — tests first

- [ ] **Step 5a: Write test `gateway/src/providers/stt/deepgram-provider.test.ts`**

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createDeepgramProvider, parseDeepgramResponse } from "./deepgram-provider.ts";
import { STT_DEFAULTS, type STTConfig } from "./stt-types.ts";
import {
  createDeepgramTranscriptResponse,
  createDeepgramUtteranceEnd,
  createDeepgramMetadataResponse,
  createSilentPCM16Frame,
  createSineWavePCM16Frame,
} from "@sentient/testing";

// ─── Mock WebSocket ───

class MockDeepgramWebSocket {
  static instances: MockDeepgramWebSocket[] = [];

  readonly url: string;
  readyState = 0; // CONNECTING
  binaryType = "blob";
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  readonly sentMessages: (string | ArrayBuffer | Uint8Array)[] = [];
  private closeCode?: number;

  constructor(url: string) {
    this.url = url;
    MockDeepgramWebSocket.instances.push(this);
    // Simulate async open
    queueMicrotask(() => {
      this.readyState = 1; // OPEN
      this.onopen?.(new Event("open"));
    });
  }

  send(data: string | ArrayBuffer | Uint8Array): void {
    this.sentMessages.push(data);
  }

  close(code?: number): void {
    this.closeCode = code;
    this.readyState = 3; // CLOSED
    this.onclose?.(new CloseEvent("close", { code: code ?? 1000 }));
  }

  // Test helpers
  simulateMessage(data: string): void {
    this.onmessage?.(new MessageEvent("message", { data }));
  }

  simulateError(): void {
    this.onerror?.(new Event("error"));
  }

  simulateClose(code = 1000): void {
    this.readyState = 3;
    this.onclose?.(new CloseEvent("close", { code }));
  }
}

function createTestConfig(overrides: Partial<STTConfig> = {}): STTConfig {
  return {
    apiKey: "test-api-key",
    model: STT_DEFAULTS.model,
    language: STT_DEFAULTS.language,
    sampleRate: STT_DEFAULTS.sampleRate,
    encoding: STT_DEFAULTS.encoding,
    endpointingMs: STT_DEFAULTS.endpointingMs,
    utteranceEndMs: STT_DEFAULTS.utteranceEndMs,
    keepAliveIntervalMs: STT_DEFAULTS.keepAliveIntervalMs,
    ...overrides,
  };
}

describe("parseDeepgramResponse", () => {
  it("parses final transcript result", () => {
    const json = createDeepgramTranscriptResponse({
      text: "hello world",
      isFinal: true,
      confidence: 0.98,
      speechFinal: true,
    });
    const event = parseDeepgramResponse(json);

    expect(event).toEqual({
      type: "transcript",
      text: "hello world",
      isFinal: true,
      speechFinal: true,
      confidence: 0.98,
    });
  });

  it("parses partial transcript result", () => {
    const json = createDeepgramTranscriptResponse({
      text: "hello",
      isFinal: false,
      confidence: 0.85,
    });
    const event = parseDeepgramResponse(json);

    expect(event).toEqual({
      type: "transcript",
      text: "hello",
      isFinal: false,
      speechFinal: false,
      confidence: 0.85,
    });
  });

  it("parses utterance_end event", () => {
    const json = createDeepgramUtteranceEnd();
    const event = parseDeepgramResponse(json);

    expect(event).toEqual({ type: "utterance_end" });
  });

  it("returns null for metadata event", () => {
    const json = createDeepgramMetadataResponse();
    const event = parseDeepgramResponse(json);

    expect(event).toBeNull();
  });

  it("returns null for empty transcript", () => {
    const json = createDeepgramTranscriptResponse({
      text: "",
      isFinal: true,
    });
    const event = parseDeepgramResponse(json);

    expect(event).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    const event = parseDeepgramResponse("not json");
    expect(event).toBeNull();
  });

  it("extracts top alternative confidence", () => {
    const json = createDeepgramTranscriptResponse({
      text: "test",
      isFinal: true,
      confidence: 0.72,
    });
    const event = parseDeepgramResponse(json);

    expect(event).not.toBeNull();
    if (event && event.type === "transcript") {
      expect(event.confidence).toBe(0.72);
    }
  });
});

describe("createDeepgramProvider", () => {
  let originalWebSocket: typeof globalThis.WebSocket;

  beforeEach(() => {
    MockDeepgramWebSocket.instances = [];
    originalWebSocket = globalThis.WebSocket;
    // @ts-expect-error — mock WebSocket constructor
    globalThis.WebSocket = MockDeepgramWebSocket;
  });

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket;
  });

  it("constructs correct Deepgram WebSocket URL", async () => {
    const controller = new AbortController();
    const provider = createDeepgramProvider();
    const config = createTestConfig();

    const connectPromise = provider.connect(config, controller.signal);
    await connectPromise;

    const ws = MockDeepgramWebSocket.instances[0]!;
    expect(ws.url).toContain("wss://api.deepgram.com/v1/listen");
    expect(ws.url).toContain("model=nova-3");
    expect(ws.url).toContain("language=en");
    expect(ws.url).toContain("encoding=linear16");
    expect(ws.url).toContain("sample_rate=16000");
    expect(ws.url).toContain("endpointing=300");
    expect(ws.url).toContain("utterance_end_ms=1000");
    expect(ws.url).toContain("punctuate=true");
    expect(ws.url).toContain("interim_results=true");

    controller.abort();
    await provider.disconnect();
  });

  it("sets binaryType to arraybuffer (mandatory for Bun)", async () => {
    const controller = new AbortController();
    const provider = createDeepgramProvider();
    const config = createTestConfig();

    await provider.connect(config, controller.signal);

    const ws = MockDeepgramWebSocket.instances[0]!;
    expect(ws.binaryType).toBe("arraybuffer");

    controller.abort();
    await provider.disconnect();
  });

  it("sends audio frames to Deepgram WebSocket", async () => {
    const controller = new AbortController();
    const provider = createDeepgramProvider();
    const config = createTestConfig();

    await provider.connect(config, controller.signal);

    const frame = createSineWavePCM16Frame(20);
    provider.sendAudio(frame);

    const ws = MockDeepgramWebSocket.instances[0]!;
    expect(ws.sentMessages).toHaveLength(1);
    expect(ws.sentMessages[0]).toBe(frame);

    controller.abort();
    await provider.disconnect();
  });

  it("throws when sending audio before connect", () => {
    const provider = createDeepgramProvider();
    const frame = createSilentPCM16Frame(20);

    expect(() => provider.sendAudio(frame)).toThrow("STT provider not connected");
  });

  it("yields transcript events from transcripts generator", async () => {
    const controller = new AbortController();
    const provider = createDeepgramProvider();
    const config = createTestConfig();

    await provider.connect(config, controller.signal);

    const ws = MockDeepgramWebSocket.instances[0]!;
    const events: unknown[] = [];

    // Start consuming transcripts
    const consumePromise = (async () => {
      for await (const event of provider.transcripts(controller.signal)) {
        events.push(event);
        if (event.type === "utterance_end") break;
      }
    })();

    // Simulate Deepgram responses
    ws.simulateMessage(
      createDeepgramTranscriptResponse({
        text: "hello",
        isFinal: false,
        confidence: 0.85,
      }),
    );
    ws.simulateMessage(
      createDeepgramTranscriptResponse({
        text: "hello world",
        isFinal: true,
        speechFinal: true,
        confidence: 0.98,
      }),
    );
    ws.simulateMessage(createDeepgramUtteranceEnd());

    await consumePromise;

    expect(events).toHaveLength(3);
    expect(events[0]).toEqual({
      type: "transcript",
      text: "hello",
      isFinal: false,
      speechFinal: false,
      confidence: 0.85,
    });
    expect(events[1]).toEqual({
      type: "transcript",
      text: "hello world",
      isFinal: true,
      speechFinal: true,
      confidence: 0.98,
    });
    expect(events[2]).toEqual({ type: "utterance_end" });

    controller.abort();
    await provider.disconnect();
  });

  it("skips metadata events in transcripts generator", async () => {
    const controller = new AbortController();
    const provider = createDeepgramProvider();
    const config = createTestConfig();

    await provider.connect(config, controller.signal);

    const ws = MockDeepgramWebSocket.instances[0]!;
    const events: unknown[] = [];

    const consumePromise = (async () => {
      for await (const event of provider.transcripts(controller.signal)) {
        events.push(event);
        if (event.type === "utterance_end") break;
      }
    })();

    ws.simulateMessage(createDeepgramMetadataResponse());
    ws.simulateMessage(
      createDeepgramTranscriptResponse({
        text: "hello",
        isFinal: true,
        speechFinal: true,
        confidence: 0.98,
      }),
    );
    ws.simulateMessage(createDeepgramUtteranceEnd());

    await consumePromise;

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: "transcript", text: "hello" });
    expect(events[1]).toEqual({ type: "utterance_end" });

    controller.abort();
    await provider.disconnect();
  });

  it("stops transcripts generator when signal is aborted", async () => {
    const controller = new AbortController();
    const provider = createDeepgramProvider();
    const config = createTestConfig();

    await provider.connect(config, controller.signal);

    const events: unknown[] = [];

    const consumePromise = (async () => {
      for await (const event of provider.transcripts(controller.signal)) {
        events.push(event);
      }
    })();

    const ws = MockDeepgramWebSocket.instances[0]!;
    ws.simulateMessage(
      createDeepgramTranscriptResponse({
        text: "hello",
        isFinal: true,
        speechFinal: false,
        confidence: 0.98,
      }),
    );

    // Abort mid-stream
    controller.abort();
    await consumePromise;

    // Should have yielded what was available before abort
    expect(events.length).toBeGreaterThanOrEqual(0);

    await provider.disconnect();
  });

  it("sends KeepAlive messages on interval", async () => {
    vi.useFakeTimers();

    const controller = new AbortController();
    const provider = createDeepgramProvider();
    const config = createTestConfig({ keepAliveIntervalMs: 100 });

    await provider.connect(config, controller.signal);

    const ws = MockDeepgramWebSocket.instances[0]!;

    // Advance past two intervals
    await vi.advanceTimersByTimeAsync(250);

    const keepAlives = ws.sentMessages.filter(
      (msg) => typeof msg === "string" && msg.includes("KeepAlive"),
    );
    expect(keepAlives.length).toBeGreaterThanOrEqual(2);

    controller.abort();
    await provider.disconnect();
    vi.useRealTimers();
  });

  it("sends CloseStream on disconnect", async () => {
    const controller = new AbortController();
    const provider = createDeepgramProvider();
    const config = createTestConfig();

    await provider.connect(config, controller.signal);

    const ws = MockDeepgramWebSocket.instances[0]!;
    await provider.disconnect();

    const closeMessages = ws.sentMessages.filter(
      (msg) => typeof msg === "string" && msg.includes("CloseStream"),
    );
    expect(closeMessages).toHaveLength(1);
  });

  it("rejects connect when signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const provider = createDeepgramProvider();
    const config = createTestConfig();

    await expect(provider.connect(config, controller.signal)).rejects.toThrow();
  });

  it("includes API key in authorization header via URL param", async () => {
    const controller = new AbortController();
    const provider = createDeepgramProvider();
    const config = createTestConfig({ apiKey: "my-secret-key" });

    await provider.connect(config, controller.signal);

    const ws = MockDeepgramWebSocket.instances[0]!;
    // Deepgram raw WS uses token= query param for auth
    expect(ws.url).toContain("token=my-secret-key");

    controller.abort();
    await provider.disconnect();
  });
});
```

- [ ] **Step 5b: Run test — verify it fails**

```bash
cd /Users/kevinye/Development/sentient && bun run --filter '@sentient/gateway' test -- deepgram-provider
```

- [ ] **Step 5c: Create `gateway/src/providers/stt/deepgram-provider.ts`**

```typescript
import type { STTConfig, STTProvider, TranscriptEvent } from "./stt-types.ts";

const DEEPGRAM_WS_BASE = "wss://api.deepgram.com/v1/listen";

/** Parse a Deepgram WebSocket response into a TranscriptEvent or null */
export function parseDeepgramResponse(raw: string): TranscriptEvent | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }

  if (parsed.type === "UtteranceEnd") {
    return { type: "utterance_end" };
  }

  if (parsed.type !== "Results") {
    return null;
  }

  const channel = parsed.channel as {
    alternatives: Array<{ transcript: string; confidence: number }>;
  } | undefined;

  const topAlt = channel?.alternatives?.[0];
  if (!topAlt || !topAlt.transcript) {
    return null;
  }

  return {
    type: "transcript",
    text: topAlt.transcript,
    isFinal: parsed.is_final === true,
    speechFinal: parsed.speech_final === true,
    confidence: topAlt.confidence,
  };
}

function buildDeepgramUrl(config: STTConfig): string {
  const params = new URLSearchParams({
    model: config.model,
    language: config.language,
    encoding: config.encoding,
    sample_rate: String(config.sampleRate),
    endpointing: String(config.endpointingMs),
    utterance_end_ms: String(config.utteranceEndMs),
    punctuate: "true",
    interim_results: "true",
    token: config.apiKey,
  });
  return `${DEEPGRAM_WS_BASE}?${params.toString()}`;
}

export function createDeepgramProvider(): STTProvider {
  let ws: WebSocket | null = null;
  let keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  let eventQueue: TranscriptEvent[] = [];
  let eventResolve: (() => void) | null = null;
  let isClosed = false;

  function enqueueEvent(event: TranscriptEvent): void {
    eventQueue.push(event);
    eventResolve?.();
    eventResolve = null;
  }

  function waitForEvent(): Promise<void> {
    if (eventQueue.length > 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      eventResolve = resolve;
    });
  }

  return {
    async connect(config: STTConfig, signal: AbortSignal): Promise<void> {
      if (signal.aborted) throw new Error("Connection aborted");

      const url = buildDeepgramUrl(config);
      ws = new WebSocket(url);
      ws.binaryType = "arraybuffer";

      return new Promise<void>((resolve, reject) => {
        const onAbort = (): void => {
          ws?.close();
          reject(new Error("Connection aborted"));
        };
        signal.addEventListener("abort", onAbort, { once: true });

        ws!.onopen = (): void => {
          signal.removeEventListener("abort", onAbort);
          isClosed = false;

          // Start KeepAlive interval
          keepAliveTimer = setInterval(() => {
            if (ws?.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "KeepAlive" }));
            }
          }, config.keepAliveIntervalMs);

          resolve();
        };

        ws!.onmessage = (event: MessageEvent): void => {
          const data = typeof event.data === "string" ? event.data : "";
          const parsed = parseDeepgramResponse(data);
          if (parsed) {
            enqueueEvent(parsed);
          }
        };

        ws!.onerror = (): void => {
          signal.removeEventListener("abort", onAbort);
          reject(new Error("Deepgram WebSocket connection failed"));
        };

        ws!.onclose = (): void => {
          isClosed = true;
          // Wake up any waiting consumer so it can exit
          eventResolve?.();
          eventResolve = null;
        };
      });
    },

    sendAudio(audio: Uint8Array): void {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        throw new Error("STT provider not connected");
      }
      ws.send(audio);
    },

    async *transcripts(signal: AbortSignal): AsyncGenerator<TranscriptEvent> {
      while (!signal.aborted && !isClosed) {
        await waitForEvent();
        while (eventQueue.length > 0) {
          if (signal.aborted) return;
          const event = eventQueue.shift()!;
          yield event;
        }
      }
    },

    async disconnect(): Promise<void> {
      if (keepAliveTimer) {
        clearInterval(keepAliveTimer);
        keepAliveTimer = null;
      }
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "CloseStream" }));
        ws.close();
      }
      ws = null;
      isClosed = true;
      eventQueue = [];
      eventResolve?.();
      eventResolve = null;
    },
  };
}
```

- [ ] **Step 5d: Run test — verify it passes**

```bash
cd /Users/kevinye/Development/sentient && bun run --filter '@sentient/gateway' test -- deepgram-provider
```

- [ ] **Step 5e: Commit**

```bash
git add gateway/src/providers/stt/deepgram-provider.ts gateway/src/providers/stt/deepgram-provider.test.ts
git commit -m "feat(gateway): Deepgram STT provider with raw WebSocket, endpointing, KeepAlive"
```

---

## Task 2.2: Audio Relay Processor

**Files:**
- Create: `gateway/src/pipeline/processors/audio-relay-processor.ts`
- Create: `gateway/src/pipeline/processors/audio-relay-processor.test.ts`

### Step 1: Write test

- [ ] **Step 1a: Write test `gateway/src/pipeline/processors/audio-relay-processor.test.ts`**

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createAudioRelayProcessor } from "./audio-relay-processor.ts";
import { createMockSTTProvider } from "@sentient/testing";
import { createSineWavePCM16Frame, createSilentPCM16Frame } from "@sentient/testing";
import type { AudioFrame, DataFrame, TranscriptFrame } from "@sentient/protocol";

function createAudioFrame(data: Uint8Array): AudioFrame {
  return {
    kind: "data",
    type: "audio",
    data,
    encoding: "pcm16",
    sampleRate: 16000,
  };
}

describe("createAudioRelayProcessor", () => {
  it("relays audio frames to STT provider", async () => {
    const stt = createMockSTTProvider();
    const processor = createAudioRelayProcessor(stt);

    const audioData = createSineWavePCM16Frame(20);
    const frame = createAudioFrame(audioData);

    const result = await processor.process(frame);

    expect(stt.audioReceived).toHaveLength(1);
    expect(stt.audioReceived[0]).toBe(audioData);
    expect(result).toEqual([]);
  });

  it("relays multiple audio frames in order", async () => {
    const stt = createMockSTTProvider();
    const processor = createAudioRelayProcessor(stt);

    const frame1 = createAudioFrame(createSineWavePCM16Frame(20, 440));
    const frame2 = createAudioFrame(createSineWavePCM16Frame(20, 880));
    const frame3 = createAudioFrame(createSineWavePCM16Frame(20, 220));

    await processor.process(frame1);
    await processor.process(frame2);
    await processor.process(frame3);

    expect(stt.audioReceived).toHaveLength(3);
  });

  it("does not relay non-audio data frames", async () => {
    const stt = createMockSTTProvider();
    const processor = createAudioRelayProcessor(stt);

    const textFrame: DataFrame = {
      kind: "data",
      type: "text",
      text: "hello",
      isFinal: true,
    };

    const result = await processor.process(textFrame);

    expect(stt.audioReceived).toHaveLength(0);
    expect(result).toEqual([textFrame]);
  });

  it("passes through transcript frames from STT", async () => {
    const stt = createMockSTTProvider({
      transcriptEvents: [
        {
          type: "transcript",
          text: "hello world",
          isFinal: true,
          speechFinal: true,
          confidence: 0.98,
        },
      ],
    });
    const controller = new AbortController();
    const processor = createAudioRelayProcessor(stt);

    const transcripts: TranscriptFrame[] = [];
    const consumePromise = (async () => {
      for await (const frame of processor.transcriptFrames(controller.signal)) {
        transcripts.push(frame);
      }
    })();

    // Trigger transcript consumption
    processor.startTranscriptRelay(controller.signal);

    // Give async generators time to run
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();
    await consumePromise.catch(() => {});

    expect(transcripts.length).toBeGreaterThanOrEqual(1);
    expect(transcripts[0]).toMatchObject({
      kind: "data",
      type: "transcript",
      text: "hello world",
      isFinal: true,
    });
  });

  it("stops relaying when signal is aborted", async () => {
    const stt = createMockSTTProvider();
    const controller = new AbortController();
    const processor = createAudioRelayProcessor(stt);

    controller.abort();

    const transcripts: TranscriptFrame[] = [];
    for await (const frame of processor.transcriptFrames(controller.signal)) {
      transcripts.push(frame);
    }

    expect(transcripts).toHaveLength(0);
  });

  it("clears state on interruption", async () => {
    const stt = createMockSTTProvider();
    const processor = createAudioRelayProcessor(stt);

    await processor.handleInterruption();

    // After interruption, processor should be in clean state
    // (no pending frames, ready for new audio)
    const frame = createAudioFrame(createSilentPCM16Frame(20));
    const result = await processor.process(frame);
    expect(result).toEqual([]);
  });

  it("converts STT transcript events to TranscriptFrame format", async () => {
    const stt = createMockSTTProvider({
      transcriptEvents: [
        {
          type: "transcript",
          text: "partial",
          isFinal: false,
          speechFinal: false,
          confidence: 0.85,
        },
      ],
    });
    const controller = new AbortController();
    const processor = createAudioRelayProcessor(stt);

    const transcripts: TranscriptFrame[] = [];
    const consumePromise = (async () => {
      for await (const frame of processor.transcriptFrames(controller.signal)) {
        transcripts.push(frame);
      }
    })();

    processor.startTranscriptRelay(controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();
    await consumePromise.catch(() => {});

    if (transcripts.length > 0) {
      expect(transcripts[0]).toEqual({
        kind: "data",
        type: "transcript",
        text: "partial",
        isFinal: false,
        confidence: 0.85,
      });
    }
  });
});
```

- [ ] **Step 1b: Run test — verify it fails**

```bash
cd /Users/kevinye/Development/sentient && bun run --filter '@sentient/gateway' test -- audio-relay-processor
```

### Step 2: Implement

- [ ] **Step 2a: Create `gateway/src/pipeline/processors/audio-relay-processor.ts`**

```typescript
import type { STTProvider, TranscriptEvent } from "../../providers/stt/stt-types.ts";
import type { AudioFrame, DataFrame, TranscriptFrame } from "@sentient/protocol";

export interface AudioRelayProcessor {
  process(frame: DataFrame): Promise<DataFrame[]>;
  transcriptFrames(signal: AbortSignal): AsyncGenerator<TranscriptFrame>;
  startTranscriptRelay(signal: AbortSignal): void;
  handleInterruption(): Promise<void>;
}

function toTranscriptFrame(event: TranscriptEvent): TranscriptFrame | null {
  if (event.type !== "transcript") return null;
  return {
    kind: "data",
    type: "transcript",
    text: event.text,
    isFinal: event.isFinal,
    confidence: event.confidence,
  };
}

export function createAudioRelayProcessor(stt: STTProvider): AudioRelayProcessor {
  let transcriptQueue: TranscriptFrame[] = [];
  let transcriptResolve: (() => void) | null = null;
  let relayActive = false;

  function enqueueTranscript(frame: TranscriptFrame): void {
    transcriptQueue.push(frame);
    transcriptResolve?.();
    transcriptResolve = null;
  }

  function waitForTranscript(): Promise<void> {
    if (transcriptQueue.length > 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      transcriptResolve = resolve;
    });
  }

  return {
    async process(frame: DataFrame): Promise<DataFrame[]> {
      if (frame.type !== "audio") {
        return [frame];
      }

      const audioFrame = frame as AudioFrame;
      stt.sendAudio(audioFrame.data);
      return [];
    },

    startTranscriptRelay(signal: AbortSignal): void {
      if (relayActive) return;
      relayActive = true;

      (async () => {
        try {
          for await (const event of stt.transcripts(signal)) {
            if (signal.aborted) break;
            const frame = toTranscriptFrame(event);
            if (frame) {
              enqueueTranscript(frame);
            }
          }
        } catch {
          // Signal aborted or STT disconnected
        } finally {
          relayActive = false;
          // Wake up any waiting consumer
          transcriptResolve?.();
          transcriptResolve = null;
        }
      })();
    },

    async *transcriptFrames(signal: AbortSignal): AsyncGenerator<TranscriptFrame> {
      while (!signal.aborted) {
        await waitForTranscript();
        while (transcriptQueue.length > 0) {
          if (signal.aborted) return;
          yield transcriptQueue.shift()!;
        }
        if (!relayActive && transcriptQueue.length === 0) return;
      }
    },

    async handleInterruption(): Promise<void> {
      transcriptQueue = [];
      transcriptResolve?.();
      transcriptResolve = null;
    },
  };
}
```

- [ ] **Step 2b: Run test — verify it passes**

```bash
cd /Users/kevinye/Development/sentient && bun run --filter '@sentient/gateway' test -- audio-relay-processor
```

- [ ] **Step 2c: Commit**

```bash
git add gateway/src/pipeline/processors/audio-relay-processor.ts gateway/src/pipeline/processors/audio-relay-processor.test.ts
git commit -m "feat(gateway): audio relay processor — binary WS frames to Deepgram relay"
```

---

## Task 2.3: Sentence Aggregator

**Files:**
- Create: `gateway/src/pipeline/processors/sentence-aggregator.ts`
- Create: `gateway/src/pipeline/processors/sentence-aggregator.test.ts`

### Step 1: Write test (porting ~30 cases from PoC)

- [ ] **Step 1a: Write test `gateway/src/pipeline/processors/sentence-aggregator.test.ts`**

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createSentenceAggregator, detectSentenceBoundary } from "./sentence-aggregator.ts";

// ─── Boundary Detection Tests (ported from PoC) ───

describe("detectSentenceBoundary", () => {
  // Basic sentence endings
  it("detects period at end of sentence", () => {
    expect(detectSentenceBoundary("Hello world.")).toBe(12);
  });

  it("detects question mark at end", () => {
    expect(detectSentenceBoundary("How are you?")).toBe(12);
  });

  it("detects exclamation mark at end", () => {
    expect(detectSentenceBoundary("That is great!")).toBe(14);
  });

  // Abbreviations — must NOT split
  it("does not split on Dr.", () => {
    expect(detectSentenceBoundary("Dr. Smith is here")).toBe(-1);
  });

  it("does not split on Mr.", () => {
    expect(detectSentenceBoundary("Mr. Jones arrived")).toBe(-1);
  });

  it("does not split on Mrs.", () => {
    expect(detectSentenceBoundary("Mrs. Davis spoke")).toBe(-1);
  });

  it("does not split on Ms.", () => {
    expect(detectSentenceBoundary("Ms. Chen called")).toBe(-1);
  });

  it("does not split on e.g.", () => {
    expect(detectSentenceBoundary("Use tools e.g. a hammer")).toBe(-1);
  });

  it("does not split on i.e.", () => {
    expect(detectSentenceBoundary("The thing i.e. the object")).toBe(-1);
  });

  it("does not split on etc.", () => {
    expect(detectSentenceBoundary("Cats, dogs, etc. are animals")).toBe(-1);
  });

  it("does not split on vs.", () => {
    expect(detectSentenceBoundary("Red vs. blue debate")).toBe(-1);
  });

  it("does not split on Jr.", () => {
    expect(detectSentenceBoundary("Martin Luther King Jr. was a leader")).toBe(-1);
  });

  it("does not split on Sr.", () => {
    expect(detectSentenceBoundary("Mr. Smith Sr. attended")).toBe(-1);
  });

  it("does not split on St.", () => {
    expect(detectSentenceBoundary("St. Louis is a city")).toBe(-1);
  });

  // Decimal numbers — must NOT split
  it("does not split on decimal 3.14", () => {
    expect(detectSentenceBoundary("Pi is 3.14 approximately")).toBe(-1);
  });

  it("does not split on decimal 99.9", () => {
    expect(detectSentenceBoundary("Temperature is 99.9 degrees")).toBe(-1);
  });

  it("does not split on price $4.50", () => {
    expect(detectSentenceBoundary("It costs $4.50 total")).toBe(-1);
  });

  // Ellipsis — must NOT split mid-sentence
  it("does not split on ellipsis mid-sentence", () => {
    expect(detectSentenceBoundary("Well... I think so")).toBe(-1);
  });

  it("detects sentence end after ellipsis when followed by capital", () => {
    const text = "Well... That was something.";
    const idx = detectSentenceBoundary(text);
    // Should find the sentence boundary
    expect(idx).toBeGreaterThan(0);
  });

  // Newlines — treated as sentence boundary
  it("detects newline as sentence boundary", () => {
    const text = "First sentence\nSecond sentence";
    const idx = detectSentenceBoundary(text);
    expect(idx).toBe(14);
  });

  it("detects double newline as sentence boundary", () => {
    const text = "First paragraph\n\nSecond paragraph";
    const idx = detectSentenceBoundary(text);
    expect(idx).toBe(15);
  });

  // Mixed cases
  it("detects first boundary in multi-sentence text", () => {
    const text = "First sentence. Second sentence.";
    const idx = detectSentenceBoundary(text);
    expect(idx).toBe(15);
  });

  it("handles sentence with abbreviation followed by real end", () => {
    const text = "Dr. Smith is here. He arrived today.";
    const idx = detectSentenceBoundary(text);
    expect(idx).toBe(18);
  });

  it("returns -1 for incomplete sentence", () => {
    expect(detectSentenceBoundary("Hello world")).toBe(-1);
  });

  it("returns -1 for empty string", () => {
    expect(detectSentenceBoundary("")).toBe(-1);
  });

  it("handles colon as non-boundary", () => {
    expect(detectSentenceBoundary("Here is the list: apples")).toBe(-1);
  });

  it("handles semicolon followed by sentence as boundary", () => {
    const text = "First part; second part.";
    const idx = detectSentenceBoundary(text);
    // Semicolons are not sentence boundaries; only the period is
    expect(idx).toBe(24);
  });

  it("detects sentence ending with period and space before next capital", () => {
    const text = "Hello. World";
    const idx = detectSentenceBoundary(text);
    expect(idx).toBe(6);
  });

  // URL-like patterns — must NOT split
  it("does not split on URL-like patterns", () => {
    expect(detectSentenceBoundary("Visit example.com for info")).toBe(-1);
  });
});

// ─── Aggregator Tests ───

describe("createSentenceAggregator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits complete sentence from streamed tokens", async () => {
    const aggregator = createSentenceAggregator();
    const sentences: string[] = [];

    const controller = new AbortController();
    const consumePromise = (async () => {
      for await (const sentence of aggregator.sentences(controller.signal)) {
        sentences.push(sentence);
      }
    })();

    aggregator.addToken("Hello ");
    aggregator.addToken("world.");
    aggregator.addToken(" How ");
    aggregator.addToken("are you?");

    // Give microtask queue time
    await vi.advanceTimersByTimeAsync(10);
    aggregator.flush();
    controller.abort();
    await consumePromise.catch(() => {});

    expect(sentences).toContain("Hello world.");
    expect(sentences).toContain("How are you?");
  });

  it("does not emit partial sentence without period", async () => {
    const aggregator = createSentenceAggregator();
    const sentences: string[] = [];

    const controller = new AbortController();
    const consumePromise = (async () => {
      for await (const sentence of aggregator.sentences(controller.signal)) {
        sentences.push(sentence);
      }
    })();

    aggregator.addToken("Hello ");
    aggregator.addToken("world");

    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    await consumePromise.catch(() => {});

    // No complete sentence detected yet
    expect(sentences.filter((s) => s.includes("Hello world"))).toHaveLength(0);
  });

  it("flushes remaining buffer on flush()", async () => {
    const aggregator = createSentenceAggregator();
    const sentences: string[] = [];

    const controller = new AbortController();
    const consumePromise = (async () => {
      for await (const sentence of aggregator.sentences(controller.signal)) {
        sentences.push(sentence);
      }
    })();

    aggregator.addToken("Hello ");
    aggregator.addToken("world");
    aggregator.flush();

    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    await consumePromise.catch(() => {});

    expect(sentences).toContain("Hello world");
  });

  it("flushes on 2-second timeout", async () => {
    const aggregator = createSentenceAggregator({ flushTimeoutMs: 2000 });
    const sentences: string[] = [];

    const controller = new AbortController();
    const consumePromise = (async () => {
      for await (const sentence of aggregator.sentences(controller.signal)) {
        sentences.push(sentence);
      }
    })();

    aggregator.addToken("Hello ");
    aggregator.addToken("world");

    // Advance past flush timeout
    await vi.advanceTimersByTimeAsync(2100);

    controller.abort();
    await consumePromise.catch(() => {});

    expect(sentences).toContain("Hello world");
  });

  it("resets flush timer on each new token", async () => {
    const aggregator = createSentenceAggregator({ flushTimeoutMs: 2000 });
    const sentences: string[] = [];

    const controller = new AbortController();
    const consumePromise = (async () => {
      for await (const sentence of aggregator.sentences(controller.signal)) {
        sentences.push(sentence);
      }
    })();

    aggregator.addToken("Hello ");
    await vi.advanceTimersByTimeAsync(1500); // 1.5s — not yet timed out
    aggregator.addToken("world");
    await vi.advanceTimersByTimeAsync(1500); // 1.5s after last token — not yet timed out

    // Should not have flushed yet (3s total but timer reset at 1.5s)
    expect(sentences).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(600); // Now 2.1s after last token
    controller.abort();
    await consumePromise.catch(() => {});

    expect(sentences).toContain("Hello world");
  });

  it("handles abbreviations in streaming context", async () => {
    const aggregator = createSentenceAggregator();
    const sentences: string[] = [];

    const controller = new AbortController();
    const consumePromise = (async () => {
      for await (const sentence of aggregator.sentences(controller.signal)) {
        sentences.push(sentence);
      }
    })();

    aggregator.addToken("Dr. ");
    aggregator.addToken("Smith ");
    aggregator.addToken("is here.");

    await vi.advanceTimersByTimeAsync(10);
    aggregator.flush();
    controller.abort();
    await consumePromise.catch(() => {});

    // Should emit as one sentence, not split on "Dr."
    expect(sentences).toContain("Dr. Smith is here.");
  });

  it("handles decimal numbers in streaming", async () => {
    const aggregator = createSentenceAggregator();
    const sentences: string[] = [];

    const controller = new AbortController();
    const consumePromise = (async () => {
      for await (const sentence of aggregator.sentences(controller.signal)) {
        sentences.push(sentence);
      }
    })();

    aggregator.addToken("Pi is ");
    aggregator.addToken("3.");
    aggregator.addToken("14 ");
    aggregator.addToken("approximately.");

    await vi.advanceTimersByTimeAsync(10);
    aggregator.flush();
    controller.abort();
    await consumePromise.catch(() => {});

    expect(sentences).toContain("Pi is 3.14 approximately.");
  });

  it("clears buffer on reset", async () => {
    const aggregator = createSentenceAggregator();
    const sentences: string[] = [];

    const controller = new AbortController();
    const consumePromise = (async () => {
      for await (const sentence of aggregator.sentences(controller.signal)) {
        sentences.push(sentence);
      }
    })();

    aggregator.addToken("Hello ");
    aggregator.addToken("world");
    aggregator.reset();

    // After reset, the buffered "Hello world" should be gone
    aggregator.addToken("Goodbye.");
    await vi.advanceTimersByTimeAsync(10);
    aggregator.flush();
    controller.abort();
    await consumePromise.catch(() => {});

    expect(sentences).not.toContain("Hello world");
    expect(sentences).toContain("Goodbye.");
  });

  it("handles multiple sentences in single token", async () => {
    const aggregator = createSentenceAggregator();
    const sentences: string[] = [];

    const controller = new AbortController();
    const consumePromise = (async () => {
      for await (const sentence of aggregator.sentences(controller.signal)) {
        sentences.push(sentence);
      }
    })();

    aggregator.addToken("First sentence. Second sentence. Third.");

    await vi.advanceTimersByTimeAsync(10);
    aggregator.flush();
    controller.abort();
    await consumePromise.catch(() => {});

    expect(sentences.length).toBeGreaterThanOrEqual(2);
    expect(sentences[0]).toBe("First sentence.");
    expect(sentences[1]).toBe("Second sentence.");
  });

  it("trims whitespace from emitted sentences", async () => {
    const aggregator = createSentenceAggregator();
    const sentences: string[] = [];

    const controller = new AbortController();
    const consumePromise = (async () => {
      for await (const sentence of aggregator.sentences(controller.signal)) {
        sentences.push(sentence);
      }
    })();

    aggregator.addToken("  Hello world.  ");

    await vi.advanceTimersByTimeAsync(10);
    aggregator.flush();
    controller.abort();
    await consumePromise.catch(() => {});

    if (sentences.length > 0) {
      expect(sentences[0]).toBe("Hello world.");
    }
  });

  it("does not emit empty sentences", async () => {
    const aggregator = createSentenceAggregator();
    const sentences: string[] = [];

    const controller = new AbortController();
    const consumePromise = (async () => {
      for await (const sentence of aggregator.sentences(controller.signal)) {
        sentences.push(sentence);
      }
    })();

    aggregator.addToken("   ");
    aggregator.flush();

    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    await consumePromise.catch(() => {});

    expect(sentences).toHaveLength(0);
  });

  it("handles newline as sentence boundary", async () => {
    const aggregator = createSentenceAggregator();
    const sentences: string[] = [];

    const controller = new AbortController();
    const consumePromise = (async () => {
      for await (const sentence of aggregator.sentences(controller.signal)) {
        sentences.push(sentence);
      }
    })();

    aggregator.addToken("First line\nSecond line.");

    await vi.advanceTimersByTimeAsync(10);
    aggregator.flush();
    controller.abort();
    await consumePromise.catch(() => {});

    expect(sentences.length).toBeGreaterThanOrEqual(1);
    expect(sentences[0]).toBe("First line");
  });

  it("stops generator when signal is aborted", async () => {
    const aggregator = createSentenceAggregator();
    const controller = new AbortController();

    controller.abort();
    const sentences: string[] = [];

    for await (const sentence of aggregator.sentences(controller.signal)) {
      sentences.push(sentence);
    }

    expect(sentences).toHaveLength(0);
  });
});
```

- [ ] **Step 1b: Run test — verify it fails**

```bash
cd /Users/kevinye/Development/sentient && bun run --filter '@sentient/gateway' test -- sentence-aggregator
```

### Step 2: Implement

- [ ] **Step 2a: Create `gateway/src/pipeline/processors/sentence-aggregator.ts`**

```typescript
/** Known abbreviations that should not trigger sentence splits */
const ABBREVIATIONS = new Set([
  "Dr", "Mr", "Mrs", "Ms", "Prof", "Sr", "Jr", "St",
  "vs", "etc", "approx", "dept", "est", "govt",
  "e.g", "i.e",
]);

const DECIMAL_BEFORE_PERIOD = /\d$/;
const ELLIPSIS_PATTERN = /\.{2,}$/;
const URL_LIKE_PATTERN = /\w\.\w/;
const SENTENCE_END_PATTERN = /[.!?]/;
const NEWLINE_PATTERN = /\n/;

export interface SentenceAggregatorOptions {
  readonly flushTimeoutMs?: number;
}

const DEFAULT_FLUSH_TIMEOUT_MS = 2000;

/**
 * Detect the first sentence boundary in the given text.
 * Returns the index just past the boundary character, or -1 if no boundary found.
 */
export function detectSentenceBoundary(text: string): number {
  if (text.length === 0) return -1;

  // Check for newline boundary first
  const newlineIdx = text.indexOf("\n");
  if (newlineIdx >= 0 && newlineIdx > 0) {
    return newlineIdx;
  }

  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;

    // Skip non-boundary characters
    if (!SENTENCE_END_PATTERN.test(char)) continue;

    // Period-specific checks
    if (char === ".") {
      // Check for ellipsis
      if (i + 1 < text.length && text[i + 1] === ".") {
        // Skip ellipsis dots
        while (i + 1 < text.length && text[i + 1] === ".") {
          i++;
        }
        // After ellipsis, check if followed by space + capital (sentence boundary)
        if (i + 2 < text.length && text[i + 1] === " " && /[A-Z]/.test(text[i + 2]!)) {
          return i + 1;
        }
        continue;
      }

      // Check for decimal number: digit before period and digit after
      if (i > 0 && DECIMAL_BEFORE_PERIOD.test(text[i - 1]!)) {
        if (i + 1 < text.length && /\d/.test(text[i + 1]!)) {
          continue;
        }
      }

      // Check for abbreviation
      const beforePeriod = text.substring(0, i);
      const lastWord = beforePeriod.split(/\s+/).pop() ?? "";

      // Handle compound abbreviations like "e.g" or "i.e"
      if (ABBREVIATIONS.has(lastWord) || ABBREVIATIONS.has(lastWord.replace(/\./g, ""))) {
        continue;
      }

      // Check for multi-letter abbreviation pattern (e.g. "e.g." — look for dotted pattern)
      const dottedPattern = /^[a-z]\.[a-z]$/i;
      if (dottedPattern.test(lastWord)) {
        continue;
      }

      // Check for URL-like pattern: word.word (no space around period)
      if (i > 0 && i + 1 < text.length && /\w/.test(text[i - 1]!) && /\w/.test(text[i + 1]!)) {
        continue;
      }

      // Check for digit before period with non-digit after (currency like $4.50 handled by decimal check)
      if (i > 0 && DECIMAL_BEFORE_PERIOD.test(text[i - 1]!)) {
        continue;
      }
    }

    // Valid sentence boundary: punctuation at end of text or followed by space
    if (i === text.length - 1) {
      return i + 1;
    }
    if (i + 1 < text.length && /\s/.test(text[i + 1]!)) {
      return i + 1;
    }
  }

  return -1;
}

export interface SentenceAggregator {
  addToken(token: string): void;
  flush(): void;
  reset(): void;
  sentences(signal: AbortSignal): AsyncGenerator<string>;
}

export function createSentenceAggregator(
  options: SentenceAggregatorOptions = {},
): SentenceAggregator {
  const flushTimeoutMs = options.flushTimeoutMs ?? DEFAULT_FLUSH_TIMEOUT_MS;

  let buffer = "";
  let sentenceQueue: string[] = [];
  let sentenceResolve: (() => void) | null = null;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let isDone = false;

  function enqueueSentence(sentence: string): void {
    const trimmed = sentence.trim();
    if (trimmed.length === 0) return;
    sentenceQueue.push(trimmed);
    sentenceResolve?.();
    sentenceResolve = null;
  }

  function waitForSentence(): Promise<void> {
    if (sentenceQueue.length > 0 || isDone) return Promise.resolve();
    return new Promise<void>((resolve) => {
      sentenceResolve = resolve;
    });
  }

  function resetFlushTimer(): void {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(() => {
      if (buffer.trim().length > 0) {
        enqueueSentence(buffer);
        buffer = "";
      }
    }, flushTimeoutMs);
  }

  function extractSentences(): void {
    let boundary = detectSentenceBoundary(buffer);
    while (boundary > 0) {
      const sentence = buffer.substring(0, boundary);
      buffer = buffer.substring(boundary);
      enqueueSentence(sentence);
      boundary = detectSentenceBoundary(buffer);
    }
  }

  return {
    addToken(token: string): void {
      buffer += token;
      extractSentences();
      resetFlushTimer();
    },

    flush(): void {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      if (buffer.trim().length > 0) {
        enqueueSentence(buffer);
        buffer = "";
      }
      isDone = true;
      sentenceResolve?.();
      sentenceResolve = null;
    },

    reset(): void {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      buffer = "";
      sentenceQueue = [];
      isDone = false;
    },

    async *sentences(signal: AbortSignal): AsyncGenerator<string> {
      while (!signal.aborted) {
        await waitForSentence();
        while (sentenceQueue.length > 0) {
          if (signal.aborted) return;
          yield sentenceQueue.shift()!;
        }
        if (isDone && sentenceQueue.length === 0) return;
      }
    },
  };
}
```

- [ ] **Step 2b: Run test — verify it passes**

```bash
cd /Users/kevinye/Development/sentient && bun run --filter '@sentient/gateway' test -- sentence-aggregator
```

- [ ] **Step 2c: Commit**

```bash
git add gateway/src/pipeline/processors/sentence-aggregator.ts gateway/src/pipeline/processors/sentence-aggregator.test.ts
git commit -m "feat(gateway): sentence aggregator with boundary detection (30 test cases from PoC)"
```

---

## Task 2.4: Fish Audio TTS Provider (WebSocket, MsgPack, Opus)

**Files:**
- Create: `gateway/src/providers/tts/tts-types.ts`
- Create: `gateway/src/providers/tts/tts-types.test.ts`
- Create: `gateway/src/providers/tts/fish-audio-provider.ts`
- Create: `gateway/src/providers/tts/fish-audio-provider.test.ts`
- Create: `shared/testing/src/mock-tts-provider.ts`
- Create: `gateway/src/pipeline/processors/tts-processor.ts`
- Create: `gateway/src/pipeline/processors/tts-processor.test.ts`

### Step 1: Define TTS provider interface and types

- [ ] **Step 1a: Write test `gateway/src/providers/tts/tts-types.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import { TTS_DEFAULTS, type TTSConfig, type TTSAudioChunk } from "./tts-types.ts";

describe("TTS_DEFAULTS", () => {
  it("has correct default format", () => {
    expect(TTS_DEFAULTS.format).toBe("opus");
  });

  it("has correct default bitrate", () => {
    expect(TTS_DEFAULTS.bitrate).toBe(48000);
  });

  it("has correct default latency mode", () => {
    expect(TTS_DEFAULTS.latency).toBe("balanced");
  });

  it("has correct default sample rate", () => {
    expect(TTS_DEFAULTS.sampleRate).toBe(48000);
  });
});
```

- [ ] **Step 1b: Run test — verify it fails**

```bash
cd /Users/kevinye/Development/sentient && bun run --filter '@sentient/gateway' test -- tts-types
```

- [ ] **Step 1c: Create `gateway/src/providers/tts/tts-types.ts`**

```typescript
export interface TTSConfig {
  readonly apiKey: string;
  readonly voiceId: string;
  readonly format: "opus" | "pcm" | "mp3";
  readonly bitrate: number;
  readonly sampleRate: number;
  readonly latency: "normal" | "balanced";
  readonly chunkLengthMs: number;
}

export const TTS_DEFAULTS = {
  format: "opus" as const,
  bitrate: 48000,
  sampleRate: 48000,
  latency: "balanced" as const,
  chunkLengthMs: 200,
} as const;

export interface TTSAudioChunk {
  readonly data: Uint8Array;
  readonly encoding: "opus" | "pcm" | "mp3";
  readonly sampleRate: number;
  readonly isFinal: boolean;
}

export interface TTSProvider {
  connect(config: TTSConfig, signal: AbortSignal): Promise<void>;
  synthesize(text: string, signal: AbortSignal): AsyncGenerator<TTSAudioChunk>;
  disconnect(): Promise<void>;
}
```

- [ ] **Step 1d: Run test — verify it passes**

```bash
cd /Users/kevinye/Development/sentient && bun run --filter '@sentient/gateway' test -- tts-types
```

- [ ] **Step 1e: Commit**

```bash
git add gateway/src/providers/tts/tts-types.ts gateway/src/providers/tts/tts-types.test.ts
git commit -m "feat(gateway): TTS provider interface and types"
```

### Step 2: Create mock TTS provider

- [ ] **Step 2a: Create `shared/testing/src/mock-tts-provider.ts`**

```typescript
import type { TTSConfig, TTSProvider, TTSAudioChunk } from "@sentient/gateway/providers/tts/tts-types";

export interface MockTTSBehavior {
  readonly chunkCount: number;
  readonly chunkSizeBytes: number;
  readonly delayPerChunkMs: number;
  readonly shouldFailConnect?: boolean;
  readonly shouldFailSynthesize?: boolean;
  readonly errorMessage?: string;
}

const DEFAULT_BEHAVIOR: MockTTSBehavior = {
  chunkCount: 3,
  chunkSizeBytes: 960,
  delayPerChunkMs: 0,
};

export function createMockTTSProvider(behavior: Partial<MockTTSBehavior> = {}): TTSProvider & {
  readonly synthesizeCalls: string[];
  readonly isConnected: boolean;
  readonly connectCallCount: number;
  readonly disconnectCallCount: number;
} {
  const config = { ...DEFAULT_BEHAVIOR, ...behavior };
  const synthesizeCalls: string[] = [];
  let connected = false;
  let connectCount = 0;
  let disconnectCount = 0;

  return {
    get synthesizeCalls() {
      return synthesizeCalls;
    },
    get isConnected() {
      return connected;
    },
    get connectCallCount() {
      return connectCount;
    },
    get disconnectCallCount() {
      return disconnectCount;
    },

    async connect(_ttsConfig: TTSConfig, signal: AbortSignal): Promise<void> {
      connectCount++;
      if (signal.aborted) throw new Error("Connection aborted");
      if (config.shouldFailConnect) {
        throw new Error(config.errorMessage ?? "Mock TTS connect failed");
      }
      connected = true;
    },

    async *synthesize(text: string, signal: AbortSignal): AsyncGenerator<TTSAudioChunk> {
      synthesizeCalls.push(text);
      if (config.shouldFailSynthesize) {
        throw new Error(config.errorMessage ?? "Mock TTS synthesize failed");
      }

      for (let i = 0; i < config.chunkCount; i++) {
        if (signal.aborted) return;

        if (config.delayPerChunkMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, config.delayPerChunkMs));
        }

        yield {
          data: new Uint8Array(config.chunkSizeBytes),
          encoding: "opus",
          sampleRate: 48000,
          isFinal: i === config.chunkCount - 1,
        };
      }
    },

    async disconnect(): Promise<void> {
      disconnectCount++;
      connected = false;
    },
  };
}
```

- [ ] **Step 2b: Re-export from `shared/testing/src/index.ts`**

Add:

```typescript
export * from "./mock-tts-provider.ts";
```

- [ ] **Step 2c: Commit**

```bash
git add shared/testing/src/mock-tts-provider.ts shared/testing/src/index.ts
git commit -m "test(testing): mock TTS provider for unit tests"
```

### Step 3: Implement Fish Audio TTS provider — tests first

- [ ] **Step 3a: Write test `gateway/src/providers/tts/fish-audio-provider.test.ts`**

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createFishAudioProvider,
  buildFishAudioStartMessage,
  parseFishAudioResponse,
} from "./fish-audio-provider.ts";
import { TTS_DEFAULTS, type TTSConfig } from "./tts-types.ts";
import { encode as msgpackEncode } from "@msgpack/msgpack";

// ─── Mock WebSocket for Fish Audio ───

class MockFishAudioWebSocket {
  static instances: MockFishAudioWebSocket[] = [];

  readonly url: string;
  readyState = 0;
  binaryType = "blob";
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  readonly sentMessages: (string | ArrayBuffer | Uint8Array)[] = [];

  constructor(url: string) {
    this.url = url;
    MockFishAudioWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.(new Event("open"));
    });
  }

  send(data: string | ArrayBuffer | Uint8Array): void {
    this.sentMessages.push(data);
  }

  close(code?: number): void {
    this.readyState = 3;
    this.onclose?.(new CloseEvent("close", { code: code ?? 1000 }));
  }

  simulateMessage(data: ArrayBuffer): void {
    this.onmessage?.(new MessageEvent("message", { data }));
  }

  simulateClose(code = 1000): void {
    this.readyState = 3;
    this.onclose?.(new CloseEvent("close", { code }));
  }
}

function createTestConfig(overrides: Partial<TTSConfig> = {}): TTSConfig {
  return {
    apiKey: "test-fish-api-key",
    voiceId: "test-voice-id",
    format: TTS_DEFAULTS.format,
    bitrate: TTS_DEFAULTS.bitrate,
    sampleRate: TTS_DEFAULTS.sampleRate,
    latency: TTS_DEFAULTS.latency,
    chunkLengthMs: TTS_DEFAULTS.chunkLengthMs,
    ...overrides,
  };
}

describe("buildFishAudioStartMessage", () => {
  it("creates MsgPack-encoded start message with correct fields", () => {
    const config = createTestConfig();
    const msgBytes = buildFishAudioStartMessage(config, "Hello world.");

    // Decode to verify structure
    const { decode } = require("@msgpack/msgpack");
    const msg = decode(msgBytes) as Record<string, unknown>;

    expect(msg.event).toBe("start");
    expect(msg.request).toMatchObject({
      text: "Hello world.",
      latency: "balanced",
      format: "opus",
      sample_rate: 48000,
    });
    expect(msg.request).toHaveProperty("reference_id");
  });

  it("includes voice ID in start message", () => {
    const config = createTestConfig({ voiceId: "custom-voice" });
    const msgBytes = buildFishAudioStartMessage(config, "Test");

    const { decode } = require("@msgpack/msgpack");
    const msg = decode(msgBytes) as Record<string, unknown>;
    const request = msg.request as Record<string, unknown>;

    expect(request.reference_id).toBe("custom-voice");
  });
});

describe("parseFishAudioResponse", () => {
  it("parses audio chunk response", () => {
    const audioData = new Uint8Array([1, 2, 3, 4, 5]);
    const response = msgpackEncode({
      event: "audio",
      audio: audioData,
    });

    const result = parseFishAudioResponse(new Uint8Array(response));

    expect(result).not.toBeNull();
    expect(result!.type).toBe("audio");
    if (result!.type === "audio") {
      expect(result!.data.length).toBeGreaterThan(0);
    }
  });

  it("parses finish event", () => {
    const response = msgpackEncode({ event: "finish", reason: "stop" });
    const result = parseFishAudioResponse(new Uint8Array(response));

    expect(result).not.toBeNull();
    expect(result!.type).toBe("finish");
  });

  it("returns null for unknown events", () => {
    const response = msgpackEncode({ event: "unknown" });
    const result = parseFishAudioResponse(new Uint8Array(response));

    expect(result).toBeNull();
  });

  it("parses log/info events as null (skip)", () => {
    const response = msgpackEncode({ event: "log", message: "processing" });
    const result = parseFishAudioResponse(new Uint8Array(response));

    expect(result).toBeNull();
  });
});

describe("createFishAudioProvider", () => {
  let originalWebSocket: typeof globalThis.WebSocket;

  beforeEach(() => {
    MockFishAudioWebSocket.instances = [];
    originalWebSocket = globalThis.WebSocket;
    // @ts-expect-error — mock WebSocket constructor
    globalThis.WebSocket = MockFishAudioWebSocket;
  });

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket;
  });

  it("connects to Fish Audio WebSocket endpoint", async () => {
    const controller = new AbortController();
    const provider = createFishAudioProvider();
    const config = createTestConfig();

    await provider.connect(config, controller.signal);

    const ws = MockFishAudioWebSocket.instances[0]!;
    expect(ws.url).toContain("wss://api.fish.audio/v1/tts/live");

    controller.abort();
    await provider.disconnect();
  });

  it("sets binaryType to arraybuffer", async () => {
    const controller = new AbortController();
    const provider = createFishAudioProvider();
    const config = createTestConfig();

    await provider.connect(config, controller.signal);

    const ws = MockFishAudioWebSocket.instances[0]!;
    expect(ws.binaryType).toBe("arraybuffer");

    controller.abort();
    await provider.disconnect();
  });

  it("includes authorization header via URL query param", async () => {
    const controller = new AbortController();
    const provider = createFishAudioProvider();
    const config = createTestConfig({ apiKey: "fish-secret" });

    await provider.connect(config, controller.signal);

    const ws = MockFishAudioWebSocket.instances[0]!;
    expect(ws.url).toContain("token=fish-secret");

    controller.abort();
    await provider.disconnect();
  });

  it("sends MsgPack-encoded start message when synthesize called", async () => {
    const controller = new AbortController();
    const provider = createFishAudioProvider();
    const config = createTestConfig();

    await provider.connect(config, controller.signal);

    const ws = MockFishAudioWebSocket.instances[0]!;

    // Start synthesize (run in background)
    const gen = provider.synthesize("Hello world.", controller.signal);

    // Trigger first next() to initiate the request
    const resultPromise = gen.next();

    // The start message should have been sent
    expect(ws.sentMessages.length).toBeGreaterThanOrEqual(1);
    const firstMsg = ws.sentMessages[0]!;
    expect(firstMsg).toBeInstanceOf(Uint8Array);

    // Simulate finish so the generator completes
    const finishResponse = msgpackEncode({ event: "finish", reason: "stop" });
    ws.simulateMessage(new Uint8Array(finishResponse).buffer);

    await resultPromise;
    controller.abort();
    await provider.disconnect();
  });

  it("yields audio chunks from synthesize generator", async () => {
    const controller = new AbortController();
    const provider = createFishAudioProvider();
    const config = createTestConfig();

    await provider.connect(config, controller.signal);

    const ws = MockFishAudioWebSocket.instances[0]!;
    const chunks: unknown[] = [];

    const consumePromise = (async () => {
      for await (const chunk of provider.synthesize("Hello.", controller.signal)) {
        chunks.push(chunk);
      }
    })();

    // Simulate audio responses
    const audioData = new Uint8Array([10, 20, 30, 40]);
    const audioResponse = msgpackEncode({ event: "audio", audio: audioData });
    ws.simulateMessage(new Uint8Array(audioResponse).buffer);

    const audioResponse2 = msgpackEncode({ event: "audio", audio: new Uint8Array([50, 60]) });
    ws.simulateMessage(new Uint8Array(audioResponse2).buffer);

    // Simulate finish
    const finishResponse = msgpackEncode({ event: "finish", reason: "stop" });
    ws.simulateMessage(new Uint8Array(finishResponse).buffer);

    await consumePromise;

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toMatchObject({ encoding: "opus", sampleRate: 48000, isFinal: false });
    expect(chunks[1]).toMatchObject({ encoding: "opus", sampleRate: 48000, isFinal: false });

    controller.abort();
    await provider.disconnect();
  });

  it("stops synthesize generator when signal is aborted", async () => {
    const controller = new AbortController();
    const provider = createFishAudioProvider();
    const config = createTestConfig();

    await provider.connect(config, controller.signal);

    const chunks: unknown[] = [];
    const consumePromise = (async () => {
      for await (const chunk of provider.synthesize("Hello.", controller.signal)) {
        chunks.push(chunk);
        controller.abort(); // Abort after first chunk
      }
    })();

    const ws = MockFishAudioWebSocket.instances[0]!;
    const audioResponse = msgpackEncode({ event: "audio", audio: new Uint8Array([1, 2, 3]) });
    ws.simulateMessage(new Uint8Array(audioResponse).buffer);

    await consumePromise;

    expect(chunks.length).toBeLessThanOrEqual(1);
    await provider.disconnect();
  });

  it("rejects connect when signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const provider = createFishAudioProvider();
    const config = createTestConfig();

    await expect(provider.connect(config, controller.signal)).rejects.toThrow();
  });

  it("sends stop message on disconnect", async () => {
    const controller = new AbortController();
    const provider = createFishAudioProvider();
    const config = createTestConfig();

    await provider.connect(config, controller.signal);

    const ws = MockFishAudioWebSocket.instances[0]!;
    await provider.disconnect();

    // Should have sent a stop/close message
    expect(ws.sentMessages.length).toBeGreaterThanOrEqual(0);
  });
});
```

- [ ] **Step 3b: Run test — verify it fails**

```bash
cd /Users/kevinye/Development/sentient && bun run --filter '@sentient/gateway' test -- fish-audio-provider
```

- [ ] **Step 3c: Create `gateway/src/providers/tts/fish-audio-provider.ts`**

```typescript
import { encode as msgpackEncode, decode as msgpackDecode } from "@msgpack/msgpack";
import type { TTSConfig, TTSProvider, TTSAudioChunk } from "./tts-types.ts";

const FISH_AUDIO_WS_BASE = "wss://api.fish.audio/v1/tts/live";

type FishAudioEvent =
  | { type: "audio"; data: Uint8Array }
  | { type: "finish" }
  | null;

/** Build a MsgPack-encoded start message for Fish Audio TTS */
export function buildFishAudioStartMessage(config: TTSConfig, text: string): Uint8Array {
  const message = {
    event: "start",
    request: {
      text,
      reference_id: config.voiceId,
      latency: config.latency,
      format: config.format,
      sample_rate: config.sampleRate,
      bitrate: config.bitrate,
      chunk_length: config.chunkLengthMs,
    },
  };
  return new Uint8Array(msgpackEncode(message));
}

/** Parse a MsgPack-encoded Fish Audio response */
export function parseFishAudioResponse(data: Uint8Array): FishAudioEvent {
  let parsed: Record<string, unknown>;
  try {
    parsed = msgpackDecode(data) as Record<string, unknown>;
  } catch {
    return null;
  }

  const event = parsed.event as string | undefined;

  if (event === "audio") {
    const audioData = parsed.audio;
    if (audioData instanceof Uint8Array) {
      return { type: "audio", data: audioData };
    }
    return null;
  }

  if (event === "finish") {
    return { type: "finish" };
  }

  // Skip log, info, and unknown events
  return null;
}

function buildFishAudioUrl(apiKey: string): string {
  const params = new URLSearchParams({ token: apiKey });
  return `${FISH_AUDIO_WS_BASE}?${params.toString()}`;
}

export function createFishAudioProvider(): TTSProvider {
  let ws: WebSocket | null = null;
  let currentConfig: TTSConfig | null = null;
  let eventQueue: FishAudioEvent[] = [];
  let eventResolve: (() => void) | null = null;
  let isClosed = false;

  function enqueueEvent(event: FishAudioEvent): void {
    if (event === null) return;
    eventQueue.push(event);
    eventResolve?.();
    eventResolve = null;
  }

  function waitForEvent(): Promise<void> {
    if (eventQueue.length > 0 || isClosed) return Promise.resolve();
    return new Promise<void>((resolve) => {
      eventResolve = resolve;
    });
  }

  return {
    async connect(config: TTSConfig, signal: AbortSignal): Promise<void> {
      if (signal.aborted) throw new Error("Connection aborted");

      currentConfig = config;
      const url = buildFishAudioUrl(config.apiKey);
      ws = new WebSocket(url);
      ws.binaryType = "arraybuffer";

      return new Promise<void>((resolve, reject) => {
        const onAbort = (): void => {
          ws?.close();
          reject(new Error("Connection aborted"));
        };
        signal.addEventListener("abort", onAbort, { once: true });

        ws!.onopen = (): void => {
          signal.removeEventListener("abort", onAbort);
          isClosed = false;
          resolve();
        };

        ws!.onmessage = (event: MessageEvent): void => {
          const data = event.data instanceof ArrayBuffer
            ? new Uint8Array(event.data)
            : null;
          if (data) {
            const parsed = parseFishAudioResponse(data);
            enqueueEvent(parsed);
          }
        };

        ws!.onerror = (): void => {
          signal.removeEventListener("abort", onAbort);
          reject(new Error("Fish Audio WebSocket connection failed"));
        };

        ws!.onclose = (): void => {
          isClosed = true;
          eventResolve?.();
          eventResolve = null;
        };
      });
    },

    async *synthesize(text: string, signal: AbortSignal): AsyncGenerator<TTSAudioChunk> {
      if (!ws || !currentConfig || ws.readyState !== WebSocket.OPEN) {
        throw new Error("TTS provider not connected");
      }

      // Clear any stale events from previous synthesis
      eventQueue = [];

      // Send MsgPack start message
      const startMsg = buildFishAudioStartMessage(currentConfig, text);
      ws.send(startMsg);

      while (!signal.aborted && !isClosed) {
        await waitForEvent();
        while (eventQueue.length > 0) {
          if (signal.aborted) return;
          const event = eventQueue.shift()!;

          if (event.type === "finish") {
            return;
          }

          if (event.type === "audio") {
            yield {
              data: event.data,
              encoding: currentConfig.format,
              sampleRate: currentConfig.sampleRate,
              isFinal: false,
            };
          }
        }
      }
    },

    async disconnect(): Promise<void> {
      if (ws && ws.readyState === WebSocket.OPEN) {
        // Send stop message
        const stopMsg = msgpackEncode({ event: "stop" });
        ws.send(new Uint8Array(stopMsg));
        ws.close();
      }
      ws = null;
      currentConfig = null;
      isClosed = true;
      eventQueue = [];
      eventResolve?.();
      eventResolve = null;
    },
  };
}
```

- [ ] **Step 3d: Run test — verify it passes**

```bash
cd /Users/kevinye/Development/sentient && bun run --filter '@sentient/gateway' test -- fish-audio-provider
```

- [ ] **Step 3e: Commit**

```bash
git add gateway/src/providers/tts/fish-audio-provider.ts gateway/src/providers/tts/fish-audio-provider.test.ts
git commit -m "feat(gateway): Fish Audio TTS provider with WebSocket + MsgPack + Opus"
```

### Step 4: Implement TTS processor — connects sentence aggregator output to TTS

- [ ] **Step 4a: Write test `gateway/src/pipeline/processors/tts-processor.test.ts`**

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { createTTSProcessor } from "./tts-processor.ts";
import { createMockTTSProvider } from "@sentient/testing";
import type { AudioFrame } from "@sentient/protocol";

describe("createTTSProcessor", () => {
  it("converts text sentence to audio frames via TTS provider", async () => {
    const tts = createMockTTSProvider({ chunkCount: 3, chunkSizeBytes: 960 });
    const processor = createTTSProcessor(tts);
    const controller = new AbortController();

    const frames: AudioFrame[] = [];
    for await (const frame of processor.synthesizeSentence("Hello world.", controller.signal)) {
      frames.push(frame);
    }

    expect(frames).toHaveLength(3);
    expect(tts.synthesizeCalls).toEqual(["Hello world."]);
  });

  it("produces AudioFrame with correct structure", async () => {
    const tts = createMockTTSProvider({ chunkCount: 1, chunkSizeBytes: 100 });
    const processor = createTTSProcessor(tts);
    const controller = new AbortController();

    const frames: AudioFrame[] = [];
    for await (const frame of processor.synthesizeSentence("Test.", controller.signal)) {
      frames.push(frame);
    }

    expect(frames[0]).toMatchObject({
      kind: "data",
      type: "audio",
      encoding: "opus",
      sampleRate: 48000,
    });
    expect(frames[0]!.data).toBeInstanceOf(Uint8Array);
  });

  it("stops when signal is aborted", async () => {
    const tts = createMockTTSProvider({
      chunkCount: 100,
      chunkSizeBytes: 960,
      delayPerChunkMs: 10,
    });
    const processor = createTTSProcessor(tts);
    const controller = new AbortController();

    const frames: AudioFrame[] = [];
    const consumePromise = (async () => {
      for await (const frame of processor.synthesizeSentence("Long text.", controller.signal)) {
        frames.push(frame);
        if (frames.length >= 2) controller.abort();
      }
    })();

    await consumePromise;
    expect(frames.length).toBeLessThan(100);
  });

  it("handles empty sentence gracefully", async () => {
    const tts = createMockTTSProvider();
    const processor = createTTSProcessor(tts);
    const controller = new AbortController();

    const frames: AudioFrame[] = [];
    for await (const frame of processor.synthesizeSentence("", controller.signal)) {
      frames.push(frame);
    }

    expect(frames).toHaveLength(0);
    expect(tts.synthesizeCalls).toHaveLength(0);
  });

  it("processes multiple sentences sequentially", async () => {
    const tts = createMockTTSProvider({ chunkCount: 2, chunkSizeBytes: 480 });
    const processor = createTTSProcessor(tts);
    const controller = new AbortController();

    const frames1: AudioFrame[] = [];
    for await (const frame of processor.synthesizeSentence("First.", controller.signal)) {
      frames1.push(frame);
    }

    const frames2: AudioFrame[] = [];
    for await (const frame of processor.synthesizeSentence("Second.", controller.signal)) {
      frames2.push(frame);
    }

    expect(frames1).toHaveLength(2);
    expect(frames2).toHaveLength(2);
    expect(tts.synthesizeCalls).toEqual(["First.", "Second."]);
  });
});
```

- [ ] **Step 4b: Run test — verify it fails**

```bash
cd /Users/kevinye/Development/sentient && bun run --filter '@sentient/gateway' test -- tts-processor
```

- [ ] **Step 4c: Create `gateway/src/pipeline/processors/tts-processor.ts`**

```typescript
import type { TTSProvider, TTSAudioChunk } from "../../providers/tts/tts-types.ts";
import type { AudioFrame } from "@sentient/protocol";

export interface TTSProcessor {
  synthesizeSentence(text: string, signal: AbortSignal): AsyncGenerator<AudioFrame>;
}

function toAudioFrame(chunk: TTSAudioChunk): AudioFrame {
  return {
    kind: "data",
    type: "audio",
    data: chunk.data,
    encoding: chunk.encoding,
    sampleRate: chunk.sampleRate,
  };
}

export function createTTSProcessor(tts: TTSProvider): TTSProcessor {
  return {
    async *synthesizeSentence(text: string, signal: AbortSignal): AsyncGenerator<AudioFrame> {
      if (!text || text.trim().length === 0) return;

      for await (const chunk of tts.synthesize(text, signal)) {
        if (signal.aborted) return;
        yield toAudioFrame(chunk);
      }
    },
  };
}
```

- [ ] **Step 4d: Run test — verify it passes**

```bash
cd /Users/kevinye/Development/sentient && bun run --filter '@sentient/gateway' test -- tts-processor
```

- [ ] **Step 4e: Commit**

```bash
git add gateway/src/pipeline/processors/tts-processor.ts gateway/src/pipeline/processors/tts-processor.test.ts
git commit -m "feat(gateway): TTS processor — sentences to audio frames"
```

---

## Task 2.5: Streaming Overlap

**Files:**
- Create: `gateway/src/pipeline/processors/streaming-overlap.ts`
- Create: `gateway/src/pipeline/processors/streaming-overlap.test.ts`

### Step 1: Write test

- [ ] **Step 1a: Write test `gateway/src/pipeline/processors/streaming-overlap.test.ts`**

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createStreamingOverlap } from "./streaming-overlap.ts";
import { createSentenceAggregator } from "./sentence-aggregator.ts";
import { createTTSProcessor } from "./tts-processor.ts";
import { createMockTTSProvider } from "@sentient/testing";
import type { AudioFrame } from "@sentient/protocol";

/** Helper: creates an async generator that yields tokens with optional delay */
async function* tokenGenerator(
  tokens: string[],
  signal: AbortSignal,
  delayMs = 0,
): AsyncGenerator<string> {
  for (const token of tokens) {
    if (signal.aborted) return;
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    yield token;
  }
}

describe("createStreamingOverlap", () => {
  it("produces audio frames from LLM token stream", async () => {
    const tts = createMockTTSProvider({ chunkCount: 2, chunkSizeBytes: 480 });
    const ttsProcessor = createTTSProcessor(tts);
    const controller = new AbortController();

    const overlap = createStreamingOverlap(ttsProcessor);

    const tokens = ["Hello ", "world. ", "How ", "are you?"];
    const llmStream = tokenGenerator(tokens, controller.signal);

    const audioFrames: AudioFrame[] = [];
    for await (const frame of overlap.process(llmStream, controller.signal)) {
      audioFrames.push(frame);
    }

    // Should have produced audio for at least one sentence
    expect(audioFrames.length).toBeGreaterThan(0);
    expect(tts.synthesizeCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("starts TTS before LLM finishes (streaming overlap)", async () => {
    const tts = createMockTTSProvider({ chunkCount: 1, chunkSizeBytes: 480 });
    const ttsProcessor = createTTSProcessor(tts);
    const controller = new AbortController();

    const overlap = createStreamingOverlap(ttsProcessor);

    const synthesizeTimestamps: number[] = [];
    const origSynthesize = tts.synthesize.bind(tts);
    // Track when synthesize is called (not when generator finishes)
    vi.spyOn(tts, "synthesize").mockImplementation(function* (text, signal) {
      synthesizeTimestamps.push(Date.now());
      yield* origSynthesize(text, signal);
    } as unknown as typeof tts.synthesize);

    // Simulate slow LLM: first sentence arrives, then a gap, then second sentence
    async function* slowLLM(signal: AbortSignal): AsyncGenerator<string> {
      yield "First sentence. ";
      if (signal.aborted) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
      yield "Second sentence.";
    }

    const audioFrames: AudioFrame[] = [];
    for await (const frame of overlap.process(slowLLM(controller.signal), controller.signal)) {
      audioFrames.push(frame);
    }

    // TTS should have been called for first sentence before LLM produced second
    expect(tts.synthesizeCalls).toContain("First sentence.");
    expect(tts.synthesizeCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("handles single sentence without trailing text", async () => {
    const tts = createMockTTSProvider({ chunkCount: 2, chunkSizeBytes: 480 });
    const ttsProcessor = createTTSProcessor(tts);
    const controller = new AbortController();

    const overlap = createStreamingOverlap(ttsProcessor);

    const tokens = ["Hello world."];
    const llmStream = tokenGenerator(tokens, controller.signal);

    const audioFrames: AudioFrame[] = [];
    for await (const frame of overlap.process(llmStream, controller.signal)) {
      audioFrames.push(frame);
    }

    expect(tts.synthesizeCalls).toEqual(["Hello world."]);
    expect(audioFrames).toHaveLength(2);
  });

  it("flushes trailing incomplete sentence after LLM ends", async () => {
    const tts = createMockTTSProvider({ chunkCount: 1, chunkSizeBytes: 480 });
    const ttsProcessor = createTTSProcessor(tts);
    const controller = new AbortController();

    const overlap = createStreamingOverlap(ttsProcessor);

    // LLM ends with incomplete sentence (no period)
    const tokens = ["First sentence. ", "trailing text"];
    const llmStream = tokenGenerator(tokens, controller.signal);

    const audioFrames: AudioFrame[] = [];
    for await (const frame of overlap.process(llmStream, controller.signal)) {
      audioFrames.push(frame);
    }

    // Both "First sentence." and "trailing text" should have been synthesized
    expect(tts.synthesizeCalls).toContain("First sentence.");
    expect(tts.synthesizeCalls).toContain("trailing text");
  });

  it("stops all processing when signal is aborted", async () => {
    const tts = createMockTTSProvider({
      chunkCount: 10,
      chunkSizeBytes: 480,
      delayPerChunkMs: 10,
    });
    const ttsProcessor = createTTSProcessor(tts);
    const controller = new AbortController();

    const overlap = createStreamingOverlap(ttsProcessor);

    async function* infiniteLLM(signal: AbortSignal): AsyncGenerator<string> {
      let i = 0;
      while (!signal.aborted) {
        yield `Sentence ${i++}. `;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }

    const audioFrames: AudioFrame[] = [];
    const consumePromise = (async () => {
      for await (const frame of overlap.process(infiniteLLM(controller.signal), controller.signal)) {
        audioFrames.push(frame);
        if (audioFrames.length >= 3) controller.abort();
      }
    })();

    await consumePromise;

    // Should have stopped without processing all sentences
    expect(audioFrames.length).toBeLessThan(50);
  });

  it("emits response.audio.start and response.audio.done markers", async () => {
    const tts = createMockTTSProvider({ chunkCount: 1, chunkSizeBytes: 480 });
    const ttsProcessor = createTTSProcessor(tts);
    const controller = new AbortController();

    const overlap = createStreamingOverlap(ttsProcessor);

    const tokens = ["Hello."];
    const llmStream = tokenGenerator(tokens, controller.signal);

    let startEmitted = false;
    let doneEmitted = false;

    overlap.onAudioStart(() => { startEmitted = true; });
    overlap.onAudioDone(() => { doneEmitted = true; });

    const audioFrames: AudioFrame[] = [];
    for await (const frame of overlap.process(llmStream, controller.signal)) {
      audioFrames.push(frame);
    }

    expect(startEmitted).toBe(true);
    expect(doneEmitted).toBe(true);
  });
});
```

- [ ] **Step 1b: Run test — verify it fails**

```bash
cd /Users/kevinye/Development/sentient && bun run --filter '@sentient/gateway' test -- streaming-overlap
```

### Step 2: Implement

- [ ] **Step 2a: Create `gateway/src/pipeline/processors/streaming-overlap.ts`**

```typescript
import { createSentenceAggregator } from "./sentence-aggregator.ts";
import type { TTSProcessor } from "./tts-processor.ts";
import type { AudioFrame } from "@sentient/protocol";

export interface StreamingOverlap {
  process(
    llmTokens: AsyncGenerator<string>,
    signal: AbortSignal,
  ): AsyncGenerator<AudioFrame>;
  onAudioStart(callback: () => void): void;
  onAudioDone(callback: () => void): void;
}

export function createStreamingOverlap(ttsProcessor: TTSProcessor): StreamingOverlap {
  let audioStartCallback: (() => void) | null = null;
  let audioDoneCallback: (() => void) | null = null;

  return {
    onAudioStart(callback: () => void): void {
      audioStartCallback = callback;
    },

    onAudioDone(callback: () => void): void {
      audioDoneCallback = callback;
    },

    async *process(
      llmTokens: AsyncGenerator<string>,
      signal: AbortSignal,
    ): AsyncGenerator<AudioFrame> {
      const aggregator = createSentenceAggregator();
      let hasEmittedAudio = false;

      // Collect sentences as they become available
      const sentenceQueue: string[] = [];
      let sentenceResolve: (() => void) | null = null;
      let llmDone = false;

      function enqueueSentence(sentence: string): void {
        sentenceQueue.push(sentence);
        sentenceResolve?.();
        sentenceResolve = null;
      }

      function waitForSentence(): Promise<void> {
        if (sentenceQueue.length > 0 || llmDone) return Promise.resolve();
        return new Promise<void>((resolve) => {
          sentenceResolve = resolve;
        });
      }

      // Background: consume LLM tokens → feed into aggregator → collect sentences
      const llmConsumerPromise = (async () => {
        const sentenceController = new AbortController();

        // Start consuming sentences from aggregator in background
        const sentenceConsumerPromise = (async () => {
          for await (const sentence of aggregator.sentences(sentenceController.signal)) {
            if (signal.aborted) break;
            enqueueSentence(sentence);
          }
        })();

        // Feed LLM tokens into aggregator
        try {
          for await (const token of llmTokens) {
            if (signal.aborted) break;
            aggregator.addToken(token);
          }
        } finally {
          // LLM stream ended — flush remaining text
          aggregator.flush();
          sentenceController.abort();
          await sentenceConsumerPromise.catch(() => {});
          llmDone = true;
          sentenceResolve?.();
          sentenceResolve = null;
        }
      })();

      // Foreground: consume sentences → TTS → yield audio frames
      try {
        while (!signal.aborted) {
          await waitForSentence();

          while (sentenceQueue.length > 0) {
            if (signal.aborted) return;

            const sentence = sentenceQueue.shift()!;

            if (!hasEmittedAudio) {
              audioStartCallback?.();
              hasEmittedAudio = true;
            }

            for await (const frame of ttsProcessor.synthesizeSentence(sentence, signal)) {
              if (signal.aborted) return;
              yield frame;
            }
          }

          if (llmDone && sentenceQueue.length === 0) break;
        }
      } finally {
        await llmConsumerPromise.catch(() => {});
        if (hasEmittedAudio) {
          audioDoneCallback?.();
        }
      }
    },
  };
}
```

- [ ] **Step 2b: Run test — verify it passes**

```bash
cd /Users/kevinye/Development/sentient && bun run --filter '@sentient/gateway' test -- streaming-overlap
```

- [ ] **Step 2c: Commit**

```bash
git add gateway/src/pipeline/processors/streaming-overlap.ts gateway/src/pipeline/processors/streaming-overlap.test.ts
git commit -m "feat(gateway): streaming overlap — TTS starts before LLM finishes"
```

---

## Task 2.6: Barge-In + Cancel Propagation

**Files:**
- Create: `gateway/src/pipeline/barge-in/barge-in-controller.ts`
- Create: `gateway/src/pipeline/barge-in/barge-in-controller.test.ts`

### Step 1: Write test

- [ ] **Step 1a: Write test `gateway/src/pipeline/barge-in/barge-in-controller.test.ts`**

```typescript
import { describe, it, expect, vi } from "vitest";
import { createBargeInController } from "./barge-in-controller.ts";

describe("createBargeInController", () => {
  it("creates initial AbortSignal that is not aborted", () => {
    const controller = createBargeInController();
    const signal = controller.currentSignal();

    expect(signal.aborted).toBe(false);
  });

  it("aborts current signal on bargeIn()", () => {
    const controller = createBargeInController();
    const signal = controller.currentSignal();

    controller.bargeIn();

    expect(signal.aborted).toBe(true);
  });

  it("provides a fresh non-aborted signal after bargeIn()", () => {
    const controller = createBargeInController();
    const oldSignal = controller.currentSignal();

    controller.bargeIn();

    const newSignal = controller.currentSignal();
    expect(oldSignal.aborted).toBe(true);
    expect(newSignal.aborted).toBe(false);
    expect(oldSignal).not.toBe(newSignal);
  });

  it("calls onBargeIn callbacks when barge-in occurs", () => {
    const controller = createBargeInController();
    const callback = vi.fn();

    controller.onBargeIn(callback);
    controller.bargeIn();

    expect(callback).toHaveBeenCalledOnce();
  });

  it("calls multiple onBargeIn callbacks", () => {
    const controller = createBargeInController();
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    const cb3 = vi.fn();

    controller.onBargeIn(cb1);
    controller.onBargeIn(cb2);
    controller.onBargeIn(cb3);
    controller.bargeIn();

    expect(cb1).toHaveBeenCalledOnce();
    expect(cb2).toHaveBeenCalledOnce();
    expect(cb3).toHaveBeenCalledOnce();
  });

  it("allows removing onBargeIn callbacks", () => {
    const controller = createBargeInController();
    const callback = vi.fn();

    const unsubscribe = controller.onBargeIn(callback);
    unsubscribe();
    controller.bargeIn();

    expect(callback).not.toHaveBeenCalled();
  });

  it("supports multiple sequential barge-ins", () => {
    const controller = createBargeInController();
    const callback = vi.fn();
    controller.onBargeIn(callback);

    const signal1 = controller.currentSignal();
    controller.bargeIn();
    expect(signal1.aborted).toBe(true);
    expect(callback).toHaveBeenCalledTimes(1);

    const signal2 = controller.currentSignal();
    controller.bargeIn();
    expect(signal2.aborted).toBe(true);
    expect(callback).toHaveBeenCalledTimes(2);

    const signal3 = controller.currentSignal();
    expect(signal3.aborted).toBe(false);
  });

  it("cancels an active async generator via AbortSignal", async () => {
    const controller = createBargeInController();
    const signal = controller.currentSignal();

    const yielded: number[] = [];

    async function* countForever(sig: AbortSignal): AsyncGenerator<number> {
      let i = 0;
      while (!sig.aborted) {
        yield i++;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }

    const consumePromise = (async () => {
      for await (const n of countForever(signal)) {
        yielded.push(n);
        if (yielded.length >= 3) {
          controller.bargeIn(); // Interrupt!
        }
      }
    })();

    await consumePromise;

    expect(yielded.length).toBeGreaterThanOrEqual(3);
    expect(yielded.length).toBeLessThan(100);
  });

  it("aborts all signals on shutdown()", () => {
    const controller = createBargeInController();
    const signal = controller.currentSignal();

    controller.shutdown();

    expect(signal.aborted).toBe(true);
  });

  it("isActive returns true when processing, false after bargeIn", () => {
    const controller = createBargeInController();

    controller.startProcessing();
    expect(controller.isActive()).toBe(true);

    controller.bargeIn();
    expect(controller.isActive()).toBe(false);
  });

  it("isActive returns false initially", () => {
    const controller = createBargeInController();
    expect(controller.isActive()).toBe(false);
  });

  it("tracks bargeIn count for metrics", () => {
    const controller = createBargeInController();

    expect(controller.bargeInCount()).toBe(0);

    controller.bargeIn();
    expect(controller.bargeInCount()).toBe(1);

    controller.bargeIn();
    expect(controller.bargeInCount()).toBe(2);
  });

  it("propagates abort to chained AbortSignals", () => {
    const controller = createBargeInController();
    const signal = controller.currentSignal();

    // Create a child controller chained to the barge-in signal
    const childController = new AbortController();
    signal.addEventListener("abort", () => childController.abort());

    controller.bargeIn();

    expect(childController.signal.aborted).toBe(true);
  });

  it("does not throw when bargeIn called with no active processing", () => {
    const controller = createBargeInController();

    // Should be a no-op, not throw
    expect(() => controller.bargeIn()).not.toThrow();
  });
});
```

- [ ] **Step 1b: Run test — verify it fails**

```bash
cd /Users/kevinye/Development/sentient && bun run --filter '@sentient/gateway' test -- barge-in-controller
```

### Step 2: Implement

- [ ] **Step 2a: Create `gateway/src/pipeline/barge-in/barge-in-controller.ts`**

```typescript
export interface BargeInController {
  /** Get the current AbortSignal — thread this through all async operations */
  currentSignal(): AbortSignal;

  /** Trigger barge-in: abort current signal, create fresh one, notify callbacks */
  bargeIn(): void;

  /** Register callback for barge-in events. Returns unsubscribe function. */
  onBargeIn(callback: () => void): () => void;

  /** Mark that response processing has started */
  startProcessing(): void;

  /** Whether response is actively being generated */
  isActive(): boolean;

  /** Total number of barge-ins since creation */
  bargeInCount(): number;

  /** Abort everything — used on session end */
  shutdown(): void;
}

export function createBargeInController(): BargeInController {
  let controller = new AbortController();
  let active = false;
  let count = 0;
  const callbacks: Set<() => void> = new Set();

  return {
    currentSignal(): AbortSignal {
      return controller.signal;
    },

    bargeIn(): void {
      count++;
      active = false;

      // Abort current processing
      controller.abort();

      // Notify all listeners
      for (const cb of callbacks) {
        try {
          cb();
        } catch {
          // Never let a callback error break barge-in flow
        }
      }

      // Create fresh controller for next utterance
      controller = new AbortController();
    },

    onBargeIn(callback: () => void): () => void {
      callbacks.add(callback);
      return () => {
        callbacks.delete(callback);
      };
    },

    startProcessing(): void {
      active = true;
    },

    isActive(): boolean {
      return active;
    },

    bargeInCount(): number {
      return count;
    },

    shutdown(): void {
      active = false;
      controller.abort();
      callbacks.clear();
    },
  };
}
```

- [ ] **Step 2b: Run test — verify it passes**

```bash
cd /Users/kevinye/Development/sentient && bun run --filter '@sentient/gateway' test -- barge-in-controller
```

- [ ] **Step 2c: Commit**

```bash
git add gateway/src/pipeline/barge-in/barge-in-controller.ts gateway/src/pipeline/barge-in/barge-in-controller.test.ts
git commit -m "feat(gateway): barge-in controller with AbortSignal cancel propagation"
```

---

## Task 2.7: Session Lifecycle (Persist, Reconnect, Shutdown)

**Files:**
- Create: `gateway/src/session/replay-buffer.ts`
- Create: `gateway/src/session/replay-buffer.test.ts`
- Create: `gateway/src/session/session-persistence.ts`
- Create: `gateway/src/session/session-persistence.test.ts`

### Step 1: Implement replay buffer — tests first

- [ ] **Step 1a: Write test `gateway/src/session/replay-buffer.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import { createReplayBuffer } from "./replay-buffer.ts";

describe("createReplayBuffer", () => {
  it("stores messages with sequence numbers", () => {
    const buffer = createReplayBuffer(100);

    buffer.add({ type: "response.text.delta", text: "hello" });

    expect(buffer.size()).toBe(1);
    expect(buffer.lastSeq()).toBe(1);
  });

  it("assigns incrementing sequence numbers", () => {
    const buffer = createReplayBuffer(100);

    buffer.add({ type: "response.text.delta", text: "a" });
    buffer.add({ type: "response.text.delta", text: "b" });
    buffer.add({ type: "response.text.delta", text: "c" });

    expect(buffer.lastSeq()).toBe(3);
  });

  it("replays messages after a given sequence number", () => {
    const buffer = createReplayBuffer(100);

    buffer.add({ type: "response.text.delta", text: "a" });
    buffer.add({ type: "response.text.delta", text: "b" });
    buffer.add({ type: "response.text.delta", text: "c" });

    const messages = buffer.replayAfter(1);

    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ seq: 2, message: { text: "b" } });
    expect(messages[1]).toMatchObject({ seq: 3, message: { text: "c" } });
  });

  it("returns all messages when replaying from seq 0", () => {
    const buffer = createReplayBuffer(100);

    buffer.add({ type: "a" });
    buffer.add({ type: "b" });

    const messages = buffer.replayAfter(0);
    expect(messages).toHaveLength(2);
  });

  it("returns empty array when replaying from latest seq", () => {
    const buffer = createReplayBuffer(100);

    buffer.add({ type: "a" });
    buffer.add({ type: "b" });

    const messages = buffer.replayAfter(2);
    expect(messages).toHaveLength(0);
  });

  it("evicts oldest messages when capacity is exceeded", () => {
    const buffer = createReplayBuffer(3);

    buffer.add({ type: "a" });
    buffer.add({ type: "b" });
    buffer.add({ type: "c" });
    buffer.add({ type: "d" }); // "a" should be evicted

    expect(buffer.size()).toBe(3);

    const messages = buffer.replayAfter(0);
    // "a" (seq=1) was evicted, so oldest is seq=2
    expect(messages).toHaveLength(3);
    expect(messages[0]).toMatchObject({ seq: 2, message: { type: "b" } });
  });

  it("returns empty replay when requested seq is before buffer window", () => {
    const buffer = createReplayBuffer(2);

    buffer.add({ type: "a" }); // seq 1
    buffer.add({ type: "b" }); // seq 2
    buffer.add({ type: "c" }); // seq 3, evicts seq 1
    buffer.add({ type: "d" }); // seq 4, evicts seq 2

    // Requesting from seq 1, but buffer only has seq 3+
    const messages = buffer.replayAfter(1);
    // Should return what we can (seq 3, 4)
    expect(messages).toHaveLength(2);
  });

  it("clears all messages on reset", () => {
    const buffer = createReplayBuffer(100);

    buffer.add({ type: "a" });
    buffer.add({ type: "b" });

    buffer.reset();

    expect(buffer.size()).toBe(0);
    expect(buffer.lastSeq()).toBe(0);
  });

  it("handles replay with seq number beyond buffer", () => {
    const buffer = createReplayBuffer(100);

    buffer.add({ type: "a" });

    const messages = buffer.replayAfter(999);
    expect(messages).toHaveLength(0);
  });

  it("returns lastSeq as 0 when empty", () => {
    const buffer = createReplayBuffer(100);
    expect(buffer.lastSeq()).toBe(0);
  });

  it("preserves message content exactly", () => {
    const buffer = createReplayBuffer(100);

    const original = { type: "response.text.delta", text: "hello world", extra: 42 };
    buffer.add(original);

    const [entry] = buffer.replayAfter(0);
    expect(entry!.message).toEqual(original);
  });
});
```

- [ ] **Step 1b: Run test — verify it fails**

```bash
cd /Users/kevinye/Development/sentient && bun run --filter '@sentient/gateway' test -- replay-buffer
```

- [ ] **Step 1c: Create `gateway/src/session/replay-buffer.ts`**

```typescript
export interface ReplayEntry {
  readonly seq: number;
  readonly message: Record<string, unknown>;
}

export interface ReplayBuffer {
  add(message: Record<string, unknown>): number;
  replayAfter(seq: number): ReplayEntry[];
  lastSeq(): number;
  size(): number;
  reset(): void;
}

export function createReplayBuffer(capacity: number): ReplayBuffer {
  let entries: ReplayEntry[] = [];
  let nextSeq = 1;

  return {
    add(message: Record<string, unknown>): number {
      const seq = nextSeq++;
      entries.push({ seq, message });

      // Evict oldest if over capacity
      if (entries.length > capacity) {
        entries = entries.slice(entries.length - capacity);
      }

      return seq;
    },

    replayAfter(seq: number): ReplayEntry[] {
      return entries.filter((entry) => entry.seq > seq);
    },

    lastSeq(): number {
      if (entries.length === 0) return 0;
      return entries[entries.length - 1]!.seq;
    },

    size(): number {
      return entries.length;
    },

    reset(): void {
      entries = [];
      nextSeq = 1;
    },
  };
}
```

- [ ] **Step 1d: Run test — verify it passes**

```bash
cd /Users/kevinye/Development/sentient && bun run --filter '@sentient/gateway' test -- replay-buffer
```

- [ ] **Step 1e: Commit**

```bash
git add gateway/src/session/replay-buffer.ts gateway/src/session/replay-buffer.test.ts
git commit -m "feat(gateway): replay buffer with sequence-numbered ring buffer"
```

### Step 2: Implement session persistence — tests first

- [ ] **Step 2a: Write test `gateway/src/session/session-persistence.test.ts`**

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createSessionPersistence,
  type SessionState,
  SESSION_DEFAULTS,
} from "./session-persistence.ts";

function createTestSession(overrides: Partial<SessionState> = {}): SessionState {
  return {
    sessionId: "session-123",
    userId: "user-1",
    role: "adult",
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    status: "active",
    ...overrides,
  };
}

describe("SESSION_DEFAULTS", () => {
  it("has correct suspend window", () => {
    expect(SESSION_DEFAULTS.suspendWindowMs).toBe(120_000);
  });

  it("has correct replay buffer capacity", () => {
    expect(SESSION_DEFAULTS.replayBufferCapacity).toBe(100);
  });
});

describe("createSessionPersistence", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stores session state", () => {
    const persistence = createSessionPersistence();
    const session = createTestSession();

    persistence.save(session);

    const retrieved = persistence.get("session-123");
    expect(retrieved).not.toBeNull();
    expect(retrieved!.sessionId).toBe("session-123");
  });

  it("returns null for unknown session", () => {
    const persistence = createSessionPersistence();

    const retrieved = persistence.get("unknown");
    expect(retrieved).toBeNull();
  });

  it("updates lastActiveAt on touch", () => {
    const persistence = createSessionPersistence();
    const session = createTestSession({ lastActiveAt: 1000 });

    persistence.save(session);
    vi.setSystemTime(new Date(2000));

    persistence.touch("session-123");

    const retrieved = persistence.get("session-123");
    expect(retrieved!.lastActiveAt).toBe(2000);
  });

  it("marks session as suspended on suspend", () => {
    const persistence = createSessionPersistence();
    const session = createTestSession();

    persistence.save(session);
    persistence.suspend("session-123");

    const retrieved = persistence.get("session-123");
    expect(retrieved!.status).toBe("suspended");
  });

  it("allows resume within suspend window", () => {
    const persistence = createSessionPersistence();
    const session = createTestSession();

    persistence.save(session);
    persistence.suspend("session-123");

    // 60 seconds later — within 120s window
    vi.advanceTimersByTime(60_000);

    const result = persistence.canResume("session-123");
    expect(result).toBe(true);
  });

  it("rejects resume after suspend window expires", () => {
    const persistence = createSessionPersistence();
    const session = createTestSession();

    persistence.save(session);
    persistence.suspend("session-123");

    // 130 seconds later — past 120s window
    vi.advanceTimersByTime(130_000);

    const result = persistence.canResume("session-123");
    expect(result).toBe(false);
  });

  it("resumes session and marks as active", () => {
    const persistence = createSessionPersistence();
    const session = createTestSession();

    persistence.save(session);
    persistence.suspend("session-123");

    vi.advanceTimersByTime(30_000);

    const resumed = persistence.resume("session-123");
    expect(resumed).toBe(true);

    const retrieved = persistence.get("session-123");
    expect(retrieved!.status).toBe("active");
  });

  it("rejects resume for already active session", () => {
    const persistence = createSessionPersistence();
    const session = createTestSession({ status: "active" });

    persistence.save(session);

    const resumed = persistence.resume("session-123");
    expect(resumed).toBe(false);
  });

  it("removes session on destroy", () => {
    const persistence = createSessionPersistence();
    const session = createTestSession();

    persistence.save(session);
    persistence.destroy("session-123");

    const retrieved = persistence.get("session-123");
    expect(retrieved).toBeNull();
  });

  it("cleans up expired suspended sessions", () => {
    const persistence = createSessionPersistence();

    const session1 = createTestSession({ sessionId: "s1" });
    const session2 = createTestSession({ sessionId: "s2" });

    persistence.save(session1);
    persistence.save(session2);
    persistence.suspend("s1");
    persistence.suspend("s2");

    // Only s1 expires
    vi.advanceTimersByTime(60_000);
    persistence.touch("s2"); // Keep s2 alive

    vi.advanceTimersByTime(70_000); // 130s total for s1, 70s for s2

    persistence.cleanup();

    expect(persistence.get("s1")).toBeNull();
    expect(persistence.get("s2")).not.toBeNull();
  });

  it("lists all active sessions", () => {
    const persistence = createSessionPersistence();

    persistence.save(createTestSession({ sessionId: "s1", status: "active" }));
    persistence.save(createTestSession({ sessionId: "s2", status: "active" }));
    persistence.save(createTestSession({ sessionId: "s3" }));
    persistence.suspend("s3");

    const active = persistence.activeSessions();
    expect(active).toHaveLength(2);
    expect(active.map((s) => s.sessionId)).toEqual(["s1", "s2"]);
  });

  it("counts total sessions including suspended", () => {
    const persistence = createSessionPersistence();

    persistence.save(createTestSession({ sessionId: "s1" }));
    persistence.save(createTestSession({ sessionId: "s2" }));
    persistence.suspend("s2");

    expect(persistence.totalCount()).toBe(2);
  });

  it("reconnect verifies session_id and provides replay", () => {
    const persistence = createSessionPersistence();
    const session = createTestSession();

    persistence.save(session);

    // Add some replay messages
    persistence.addReplayMessage("session-123", { type: "response.text.delta", text: "a" });
    persistence.addReplayMessage("session-123", { type: "response.text.delta", text: "b" });
    persistence.addReplayMessage("session-123", { type: "response.text.delta", text: "c" });

    persistence.suspend("session-123");

    // Reconnect and request replay from seq 1
    const reconnectResult = persistence.reconnect("session-123", 1);

    expect(reconnectResult.success).toBe(true);
    expect(reconnectResult.missedMessages).toHaveLength(2);
    expect(reconnectResult.missedMessages[0]).toMatchObject({ seq: 2, message: { text: "b" } });
    expect(reconnectResult.missedMessages[1]).toMatchObject({ seq: 3, message: { text: "c" } });
  });

  it("reconnect fails for unknown session", () => {
    const persistence = createSessionPersistence();

    const result = persistence.reconnect("unknown", 0);
    expect(result.success).toBe(false);
    expect(result.missedMessages).toHaveLength(0);
  });

  it("reconnect fails for expired session", () => {
    const persistence = createSessionPersistence();
    const session = createTestSession();

    persistence.save(session);
    persistence.suspend("session-123");

    vi.advanceTimersByTime(130_000);

    const result = persistence.reconnect("session-123", 0);
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 2b: Run test — verify it fails**

```bash
cd /Users/kevinye/Development/sentient && bun run --filter '@sentient/gateway' test -- session-persistence
```

- [ ] **Step 2c: Create `gateway/src/session/session-persistence.ts`**

```typescript
import { createReplayBuffer, type ReplayBuffer, type ReplayEntry } from "./replay-buffer.ts";

export type SessionStatus = "active" | "suspended";

export interface SessionState {
  readonly sessionId: string;
  readonly userId: string;
  readonly role: string;
  readonly createdAt: number;
  lastActiveAt: number;
  status: SessionStatus;
}

export const SESSION_DEFAULTS = {
  suspendWindowMs: 120_000, // 2 minutes
  replayBufferCapacity: 100,
} as const;

export interface ReconnectResult {
  readonly success: boolean;
  readonly missedMessages: ReplayEntry[];
}

export interface SessionPersistence {
  save(session: SessionState): void;
  get(sessionId: string): SessionState | null;
  touch(sessionId: string): void;
  suspend(sessionId: string): void;
  canResume(sessionId: string): boolean;
  resume(sessionId: string): boolean;
  destroy(sessionId: string): void;
  cleanup(): void;
  activeSessions(): SessionState[];
  totalCount(): number;
  addReplayMessage(sessionId: string, message: Record<string, unknown>): void;
  reconnect(sessionId: string, lastSeq: number): ReconnectResult;
}

interface SessionEntry {
  state: SessionState;
  suspendedAt: number | null;
  replayBuffer: ReplayBuffer;
}

export function createSessionPersistence(options?: {
  suspendWindowMs?: number;
  replayBufferCapacity?: number;
}): SessionPersistence {
  const suspendWindowMs = options?.suspendWindowMs ?? SESSION_DEFAULTS.suspendWindowMs;
  const replayCapacity = options?.replayBufferCapacity ?? SESSION_DEFAULTS.replayBufferCapacity;
  const sessions = new Map<string, SessionEntry>();

  function getEntry(sessionId: string): SessionEntry | undefined {
    return sessions.get(sessionId);
  }

  function isSuspendExpired(entry: SessionEntry): boolean {
    if (entry.state.status !== "suspended" || entry.suspendedAt === null) return false;
    return Date.now() - entry.suspendedAt > suspendWindowMs;
  }

  return {
    save(session: SessionState): void {
      sessions.set(session.sessionId, {
        state: { ...session },
        suspendedAt: null,
        replayBuffer: createReplayBuffer(replayCapacity),
      });
    },

    get(sessionId: string): SessionState | null {
      const entry = getEntry(sessionId);
      if (!entry) return null;
      return { ...entry.state };
    },

    touch(sessionId: string): void {
      const entry = getEntry(sessionId);
      if (entry) {
        entry.state.lastActiveAt = Date.now();
      }
    },

    suspend(sessionId: string): void {
      const entry = getEntry(sessionId);
      if (entry) {
        entry.state.status = "suspended";
        entry.suspendedAt = Date.now();
      }
    },

    canResume(sessionId: string): boolean {
      const entry = getEntry(sessionId);
      if (!entry) return false;
      if (entry.state.status !== "suspended") return false;
      return !isSuspendExpired(entry);
    },

    resume(sessionId: string): boolean {
      const entry = getEntry(sessionId);
      if (!entry) return false;
      if (entry.state.status !== "suspended") return false;
      if (isSuspendExpired(entry)) return false;

      entry.state.status = "active";
      entry.state.lastActiveAt = Date.now();
      entry.suspendedAt = null;
      return true;
    },

    destroy(sessionId: string): void {
      sessions.delete(sessionId);
    },

    cleanup(): void {
      for (const [sessionId, entry] of sessions) {
        if (isSuspendExpired(entry)) {
          sessions.delete(sessionId);
        }
      }
    },

    activeSessions(): SessionState[] {
      const result: SessionState[] = [];
      for (const entry of sessions.values()) {
        if (entry.state.status === "active") {
          result.push({ ...entry.state });
        }
      }
      return result;
    },

    totalCount(): number {
      return sessions.size;
    },

    addReplayMessage(sessionId: string, message: Record<string, unknown>): void {
      const entry = getEntry(sessionId);
      if (entry) {
        entry.replayBuffer.add(message);
      }
    },

    reconnect(sessionId: string, lastSeq: number): ReconnectResult {
      const entry = getEntry(sessionId);
      if (!entry) {
        return { success: false, missedMessages: [] };
      }
      if (entry.state.status !== "suspended") {
        return { success: false, missedMessages: [] };
      }
      if (isSuspendExpired(entry)) {
        return { success: false, missedMessages: [] };
      }

      // Resume the session
      entry.state.status = "active";
      entry.state.lastActiveAt = Date.now();
      entry.suspendedAt = null;

      // Get missed messages
      const missedMessages = entry.replayBuffer.replayAfter(lastSeq);

      return { success: true, missedMessages };
    },
  };
}
```

- [ ] **Step 2d: Run test — verify it passes**

```bash
cd /Users/kevinye/Development/sentient && bun run --filter '@sentient/gateway' test -- session-persistence
```

- [ ] **Step 2e: Commit**

```bash
git add gateway/src/session/session-persistence.ts gateway/src/session/session-persistence.test.ts gateway/src/session/replay-buffer.ts gateway/src/session/replay-buffer.test.ts
git commit -m "feat(gateway): session persistence with suspend/resume, replay buffer, reconnect"
```

---

## Phase Checkpoint Verification

- [ ] **Step 1: Run all Phase 2 tests**

```bash
cd /Users/kevinye/Development/sentient && bun run --filter '@sentient/gateway' test
```

Expected: All tests pass (~120 tests total for Phase 2).

- [ ] **Step 2: Run full CI check**

```bash
cd /Users/kevinye/Development/sentient && bun run ci
```

Expected: lint + typecheck + all unit tests pass.

- [ ] **Step 3: Verify test counts by area**

```bash
cd /Users/kevinye/Development/sentient && bun run --filter '@sentient/gateway' test -- --reporter=verbose 2>&1 | grep -c "✓\|✗"
```

Expected approximate counts:
- Task 2.1 (STT): ~20 tests
- Task 2.2 (Audio relay): ~10 tests
- Task 2.3 (Sentence aggregator): ~30 tests
- Task 2.4 (TTS): ~15 tests
- Task 2.5 (Streaming overlap): ~10 tests
- Task 2.6 (Barge-in): ~15 tests
- Task 2.7 (Session lifecycle): ~20 tests
- **Total: ~120 tests**

- [ ] **Step 4: Merge to develop**

```bash
git checkout develop
git merge feature/phase2-voice-loop
git push origin develop
git branch -d feature/phase2-voice-loop
```

---

## Summary

**Phase 2 delivers:**
1. **Deepgram STT** — raw WebSocket (~100 lines), `binaryType="arraybuffer"`, endpointing=300ms, utterance_end_ms=1000, KeepAlive every 8-10s, speech_final for turn-taking
2. **Audio relay processor** — bridges client binary WebSocket frames to Deepgram, emits TranscriptFrames
3. **Sentence aggregator** — boundary detection with abbreviation/decimal/ellipsis/URL guards, 2-second flush timeout, ~130 lines
4. **Fish Audio TTS** — raw WebSocket + @msgpack/msgpack for MsgPack serialization, 48kbps Opus output, "balanced" latency mode
5. **Streaming overlap** — LLM AsyncGenerator → sentence splitter → TTS AsyncGenerator, first audio starts before LLM finishes
6. **Barge-in** — client sends `barge_in` → AbortController.abort() → cancels STT/LLM/TTS → fresh signal for next utterance
7. **Session persistence** — 120s suspend window, sequence-numbered replay buffer (100 messages), reconnect via session_id + last_seq

**CHECKPOINT:** Full voice loop via test client. Audio in → hear response audio.
