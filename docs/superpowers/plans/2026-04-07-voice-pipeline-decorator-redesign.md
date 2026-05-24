# Voice Pipeline Decorator Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor the gateway voice pipeline into a composable decorator chain with dual-channel chunks, fix TTS audio corruption via text sanitization, replace per-sentence Fish Audio connections with persistent per-turn connections, and parallelize service init at session start.

**Architecture:** Every processing stage is a decorator unit (`AsyncGenerator` in → `AsyncGenerator` out). The pipeline carries `PipelineChunk` (display + speech channels) through text transforms, then a terminal stage produces `PipelineOutput` (interleaved text + audio events). The flow manager orchestrates service lifecycle with parallel init and pre-warming.

**Tech Stack:** Bun, TypeScript, Vitest, Fish Audio WebSocket (MsgPack), Deepgram WebSocket

**Spec:** `docs/superpowers/specs/2026-04-07-voice-pipeline-decorator-redesign.md`
**Rules:** `.claude/rules/pipeline.md` | `agents/docs/pipeline-details.md`

---

## Task 1: Pipeline Types

**Files:**
- Create: `gateway/src/pipeline/processors/pipeline-types.ts`
- Create: `gateway/src/pipeline/processors/pipeline-types.test.ts`

- [ ] **Step 1: Create type definitions**

```typescript
// gateway/src/pipeline/processors/pipeline-types.ts
import type { AudioFrame } from "@sentient/protocol";

export interface PipelineChunk {
  readonly display: string;
  readonly speech: string;
}

export type PipelineOutput =
  | { readonly type: "text"; readonly display: string }
  | { readonly type: "audio"; readonly frame: AudioFrame };

export type TextTransform = (
  input: AsyncGenerator<PipelineChunk>,
  signal: AbortSignal,
) => AsyncGenerator<PipelineChunk>;

export type AudioTransform = (
  input: AsyncGenerator<PipelineChunk>,
  signal: AbortSignal,
) => AsyncGenerator<PipelineOutput>;

export function toPipelineChunk(text: string): PipelineChunk {
  return { display: text, speech: text };
}
```

- [ ] **Step 2: Write test**

```typescript
// gateway/src/pipeline/processors/pipeline-types.test.ts
import { describe, expect, it } from "vitest";
import { toPipelineChunk } from "./pipeline-types.ts";

describe("toPipelineChunk", () => {
  it("creates chunk with identical display and speech", () => {
    const chunk = toPipelineChunk("hello");
    expect(chunk.display).toBe("hello");
    expect(chunk.speech).toBe("hello");
  });

  it("handles empty string", () => {
    const chunk = toPipelineChunk("");
    expect(chunk.display).toBe("");
    expect(chunk.speech).toBe("");
  });
});
```

- [ ] **Step 3: Run tests**

Run: `cd gateway && bun run vitest run src/pipeline/processors/pipeline-types.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add gateway/src/pipeline/processors/pipeline-types.ts gateway/src/pipeline/processors/pipeline-types.test.ts
git commit -m "feat(pipeline): add PipelineChunk/PipelineOutput types and TextTransform/AudioTransform contracts"
```

---

## Task 2: TTS Text Sanitizer

**Files:**
- Create: `gateway/src/pipeline/processors/tts-text-sanitizer.ts`
- Create: `gateway/src/pipeline/processors/tts-text-sanitizer.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// gateway/src/pipeline/processors/tts-text-sanitizer.test.ts
import { describe, expect, it } from "vitest";
import { sanitizeSpeech } from "./tts-text-sanitizer.ts";

describe("sanitizeSpeech", () => {
  it("strips bold markdown", () => {
    expect(sanitizeSpeech("**hello**")).toBe("hello");
  });

  it("strips italic markdown", () => {
    expect(sanitizeSpeech("*hello*")).toBe("hello");
  });

  it("strips underscore emphasis", () => {
    expect(sanitizeSpeech("__hello__")).toBe("hello");
    expect(sanitizeSpeech("_hello_")).toBe("hello");
  });

  it("strips strikethrough", () => {
    expect(sanitizeSpeech("~~hello~~")).toBe("hello");
  });

  it("strips header markers", () => {
    expect(sanitizeSpeech("## Hello World")).toBe("Hello World");
    expect(sanitizeSpeech("### Title")).toBe("Title");
  });

  it("strips horizontal rules", () => {
    expect(sanitizeSpeech("---")).toBe("");
    expect(sanitizeSpeech("***")).toBe("");
    expect(sanitizeSpeech("___")).toBe("");
  });

  it("strips list markers", () => {
    expect(sanitizeSpeech("- item one")).toBe("item one");
    expect(sanitizeSpeech("* item two")).toBe("item two");
    expect(sanitizeSpeech("1. item three")).toBe("item three");
  });

  it("strips blockquote markers", () => {
    expect(sanitizeSpeech("> quoted text")).toBe("quoted text");
  });

  it("strips code fences", () => {
    expect(sanitizeSpeech("```code```")).toBe("code");
    expect(sanitizeSpeech("```")).toBe("");
  });

  it("strips inline code backticks", () => {
    expect(sanitizeSpeech("`code`")).toBe("code");
  });

  it("normalizes newlines to spaces", () => {
    expect(sanitizeSpeech("hello\nworld")).toBe("hello world");
    expect(sanitizeSpeech("hello\r\nworld")).toBe("hello world");
  });

  it("collapses multiple spaces", () => {
    expect(sanitizeSpeech("hello   world")).toBe("hello world");
  });

  it("preserves speech punctuation", () => {
    expect(sanitizeSpeech("Hello! How are you? Fine.")).toBe("Hello! How are you? Fine.");
  });

  it("preserves numbers and currency", () => {
    expect(sanitizeSpeech("$4.50 and 100%")).toBe("$4.50 and 100%");
  });

  it("preserves quotes and parentheses", () => {
    expect(sanitizeSpeech('"hello" (world)')).toBe('"hello" (world)');
  });

  it("handles the story test case", () => {
    const input = "**The End.**\r\n\r\nWould you like another story?";
    const result = sanitizeSpeech(input);
    expect(result).not.toContain("*");
    expect(result).toContain("The End.");
    expect(result).toContain("Would you like another story?");
  });

  it("handles empty string", () => {
    expect(sanitizeSpeech("")).toBe("");
  });

  it("handles plain text unchanged", () => {
    expect(sanitizeSpeech("Just a normal sentence.")).toBe("Just a normal sentence.");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd gateway && bun run vitest run src/pipeline/processors/tts-text-sanitizer.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement sanitizer**

```typescript
// gateway/src/pipeline/processors/tts-text-sanitizer.ts
import type { PipelineChunk, TextTransform } from "./pipeline-types.ts";

const HORIZONTAL_RULE = /^[-*_]{3,}$/;
const HEADER_PREFIX = /^#{1,6}\s+/;
const ORDERED_LIST = /^\d+\.\s+/;
const UNORDERED_LIST = /^[-*]\s+/;
const BLOCKQUOTE = /^>\s+/;
const CODE_FENCE = /```/g;
const BACKTICK = /`/g;
const MARKDOWN_CHARS = /[*_~#]/g;
const CARRIAGE_RETURN = /\r\n?/g;
const NEWLINE = /\n/g;
const MULTI_SPACE = / {2,}/g;

export function sanitizeSpeech(text: string): string {
  if (text.length === 0) return "";

  let result = text;

  // Normalize line endings
  result = result.replace(CARRIAGE_RETURN, "\n");

  // Process line-level patterns before collapsing newlines
  result = result
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (HORIZONTAL_RULE.test(trimmed)) return "";
      let cleaned = trimmed;
      cleaned = cleaned.replace(HEADER_PREFIX, "");
      cleaned = cleaned.replace(ORDERED_LIST, "");
      cleaned = cleaned.replace(UNORDERED_LIST, "");
      cleaned = cleaned.replace(BLOCKQUOTE, "");
      return cleaned;
    })
    .join(" ");

  // Strip inline formatting
  result = result.replace(CODE_FENCE, "");
  result = result.replace(BACKTICK, "");
  result = result.replace(MARKDOWN_CHARS, "");

  // Collapse whitespace
  result = result.replace(MULTI_SPACE, " ");

  return result.trim();
}

export function createTtsSanitizer(): TextTransform {
  return async function* sanitizeTransform(
    input: AsyncGenerator<PipelineChunk>,
    signal: AbortSignal,
  ): AsyncGenerator<PipelineChunk> {
    for await (const chunk of input) {
      if (signal.aborted) return;
      yield { display: chunk.display, speech: sanitizeSpeech(chunk.speech) };
    }
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd gateway && bun run vitest run src/pipeline/processors/tts-text-sanitizer.test.ts`
Expected: PASS

- [ ] **Step 5: Add transform-level tests**

Add to the same test file:

```typescript
describe("createTtsSanitizer", () => {
  it("modifies speech only, preserves display", async () => {
    const { createTtsSanitizer } = await import("./tts-text-sanitizer.ts");
    const sanitizer = createTtsSanitizer();

    async function* source(): AsyncGenerator<PipelineChunk> {
      yield { display: "**bold**", speech: "**bold**" };
    }

    const results: PipelineChunk[] = [];
    for await (const chunk of sanitizer(source(), new AbortController().signal)) {
      results.push(chunk);
    }

    expect(results).toHaveLength(1);
    expect(results[0]?.display).toBe("**bold**");
    expect(results[0]?.speech).toBe("bold");
  });

  it("stops on abort", async () => {
    const { createTtsSanitizer } = await import("./tts-text-sanitizer.ts");
    const sanitizer = createTtsSanitizer();
    const ac = new AbortController();
    ac.abort();

    async function* source(): AsyncGenerator<PipelineChunk> {
      yield { display: "hello", speech: "hello" };
    }

    const results: PipelineChunk[] = [];
    for await (const chunk of sanitizer(source(), ac.signal)) {
      results.push(chunk);
    }
    expect(results).toHaveLength(0);
  });
});
```

Import `PipelineChunk` at the top of the test file:
```typescript
import type { PipelineChunk } from "./pipeline-types.ts";
```

- [ ] **Step 6: Run all tests**

Run: `cd gateway && bun run vitest run src/pipeline/processors/tts-text-sanitizer.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add gateway/src/pipeline/processors/tts-text-sanitizer.ts gateway/src/pipeline/processors/tts-text-sanitizer.test.ts
git commit -m "feat(pipeline): add TTS text sanitizer — strips markdown from speech channel"
```

---

## Task 3: Audio Chunk Queue (Ring Buffer)

**Files:**
- Create: `gateway/src/providers/tts/audio-chunk-queue.ts`
- Create: `gateway/src/providers/tts/audio-chunk-queue.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// gateway/src/providers/tts/audio-chunk-queue.test.ts
import { describe, expect, it } from "vitest";
import { createAudioChunkQueue } from "./audio-chunk-queue.ts";
import type { TTSAudioChunk } from "./tts-types.ts";

function makeChunk(id: number): TTSAudioChunk {
  return { data: new Uint8Array([id]), encoding: "opus", sampleRate: 48000, isFinal: false };
}

describe("AudioChunkQueue", () => {
  it("enqueues and dequeues in FIFO order", () => {
    const queue = createAudioChunkQueue(10);
    queue.enqueue(makeChunk(1));
    queue.enqueue(makeChunk(2));
    expect(queue.dequeue()?.data[0]).toBe(1);
    expect(queue.dequeue()?.data[0]).toBe(2);
  });

  it("returns undefined when dequeuing empty queue", () => {
    const queue = createAudioChunkQueue(10);
    expect(queue.dequeue()).toBeUndefined();
  });

  it("reports size correctly", () => {
    const queue = createAudioChunkQueue(10);
    expect(queue.size()).toBe(0);
    queue.enqueue(makeChunk(1));
    expect(queue.size()).toBe(1);
    queue.dequeue();
    expect(queue.size()).toBe(0);
  });

  it("reports isEmpty correctly", () => {
    const queue = createAudioChunkQueue(10);
    expect(queue.isEmpty()).toBe(true);
    queue.enqueue(makeChunk(1));
    expect(queue.isEmpty()).toBe(false);
  });

  it("doubles capacity when reaching 50% fill", () => {
    const queue = createAudioChunkQueue(4);
    queue.enqueue(makeChunk(1));
    queue.enqueue(makeChunk(2)); // 50% — triggers grow to 8
    queue.enqueue(makeChunk(3));
    queue.enqueue(makeChunk(4));
    queue.enqueue(makeChunk(5));
    // All 5 should be retrievable
    expect(queue.dequeue()?.data[0]).toBe(1);
    expect(queue.dequeue()?.data[0]).toBe(2);
    expect(queue.dequeue()?.data[0]).toBe(3);
    expect(queue.dequeue()?.data[0]).toBe(4);
    expect(queue.dequeue()?.data[0]).toBe(5);
  });

  it("handles wraparound correctly", () => {
    const queue = createAudioChunkQueue(4);
    queue.enqueue(makeChunk(1));
    queue.enqueue(makeChunk(2));
    queue.dequeue(); // head moves forward
    queue.dequeue();
    queue.enqueue(makeChunk(3));
    queue.enqueue(makeChunk(4));
    expect(queue.dequeue()?.data[0]).toBe(3);
    expect(queue.dequeue()?.data[0]).toBe(4);
  });

  it("resets to initial capacity", () => {
    const queue = createAudioChunkQueue(4);
    // Fill past 50% to trigger growth
    for (let i = 0; i < 10; i++) queue.enqueue(makeChunk(i));
    queue.reset();
    expect(queue.size()).toBe(0);
    expect(queue.isEmpty()).toBe(true);
    // Should still work after reset
    queue.enqueue(makeChunk(99));
    expect(queue.dequeue()?.data[0]).toBe(99);
  });

  it("supports finish/isDone semantics", () => {
    const queue = createAudioChunkQueue(4);
    expect(queue.isDone()).toBe(false);
    queue.finish();
    expect(queue.isDone()).toBe(true);
    queue.reset();
    expect(queue.isDone()).toBe(false);
  });

  it("waitForItem resolves immediately when items available", async () => {
    const queue = createAudioChunkQueue(4);
    queue.enqueue(makeChunk(1));
    const hasItem = await queue.waitForItem(new AbortController().signal);
    expect(hasItem).toBe(true);
  });

  it("waitForItem resolves false when finished and empty", async () => {
    const queue = createAudioChunkQueue(4);
    queue.finish();
    const hasItem = await queue.waitForItem(new AbortController().signal);
    expect(hasItem).toBe(false);
  });

  it("waitForItem resolves false when aborted", async () => {
    const queue = createAudioChunkQueue(4);
    const ac = new AbortController();
    ac.abort();
    const hasItem = await queue.waitForItem(ac.signal);
    expect(hasItem).toBe(false);
  });

  it("waitForItem resolves when item enqueued later", async () => {
    const queue = createAudioChunkQueue(4);
    const promise = queue.waitForItem(new AbortController().signal);
    queue.enqueue(makeChunk(1));
    const hasItem = await promise;
    expect(hasItem).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd gateway && bun run vitest run src/providers/tts/audio-chunk-queue.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement ring buffer queue**

```typescript
// gateway/src/providers/tts/audio-chunk-queue.ts
import type { TTSAudioChunk } from "./tts-types.ts";

const GROW_THRESHOLD = 0.5;

export interface AudioChunkQueue {
  enqueue(chunk: TTSAudioChunk): void;
  dequeue(): TTSAudioChunk | undefined;
  size(): number;
  isEmpty(): boolean;
  isDone(): boolean;
  finish(): void;
  reset(): void;
  waitForItem(signal: AbortSignal): Promise<boolean>;
}

/** Default: 600 chunks = 120s at 200ms chunk rate */
export const DEFAULT_AUDIO_QUEUE_CAPACITY = 600;

export function createAudioChunkQueue(initialCapacity: number = DEFAULT_AUDIO_QUEUE_CAPACITY): AudioChunkQueue {
  let buffer: (TTSAudioChunk | undefined)[] = new Array(initialCapacity);
  let head = 0;
  let tail = 0;
  let count = 0;
  let done = false;
  let waitResolve: ((hasItem: boolean) => void) | null = null;

  function capacity(): number {
    return buffer.length;
  }

  function grow(): void {
    const newCap = capacity() * 2;
    const newBuffer: (TTSAudioChunk | undefined)[] = new Array(newCap);
    for (let i = 0; i < count; i++) {
      newBuffer[i] = buffer[(head + i) % capacity()];
    }
    buffer = newBuffer;
    head = 0;
    tail = count;
  }

  function wake(hasItem: boolean): void {
    if (waitResolve) {
      const r = waitResolve;
      waitResolve = null;
      r(hasItem);
    }
  }

  return {
    enqueue(chunk: TTSAudioChunk): void {
      if (count >= capacity() * GROW_THRESHOLD) {
        grow();
      }
      buffer[tail] = chunk;
      tail = (tail + 1) % capacity();
      count++;
      wake(true);
    },

    dequeue(): TTSAudioChunk | undefined {
      if (count === 0) return undefined;
      const item = buffer[head];
      buffer[head] = undefined;
      head = (head + 1) % capacity();
      count--;
      return item;
    },

    size: () => count,
    isEmpty: () => count === 0,
    isDone: () => done,

    finish(): void {
      done = true;
      wake(false);
    },

    reset(): void {
      buffer = new Array(initialCapacity);
      head = 0;
      tail = 0;
      count = 0;
      done = false;
      waitResolve = null;
    },

    waitForItem(signal: AbortSignal): Promise<boolean> {
      if (count > 0) return Promise.resolve(true);
      if (done || signal.aborted) return Promise.resolve(false);
      return new Promise<boolean>((resolve) => {
        waitResolve = resolve;
        signal.addEventListener(
          "abort",
          () => {
            if (waitResolve === resolve) {
              waitResolve = null;
              resolve(false);
            }
          },
          { once: true },
        );
      });
    },
  };
}
```

- [ ] **Step 4: Run tests**

Run: `cd gateway && bun run vitest run src/providers/tts/audio-chunk-queue.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add gateway/src/providers/tts/audio-chunk-queue.ts gateway/src/providers/tts/audio-chunk-queue.test.ts
git commit -m "feat(tts): add ring buffer AudioChunkQueue — pre-allocated, grows at 50%, resets between turns"
```

---

## Task 4: Persona Update

**Files:**
- Modify: `gateway/persona.md`

- [ ] **Step 1: Add voice output rules to persona**

Append the following section to `gateway/persona.md` after the existing "Response Style" section:

```markdown
## Voice Output Rules — CRITICAL
You are speaking out loud. Every response will be read aloud by a text-to-speech engine.
- NEVER use markdown formatting of any kind: no **bold**, no *italic*, no __underline__, no ~~strikethrough~~.
- NEVER use headers (#), horizontal rules (---), bullet points (- or *), or numbered lists (1.).
- NEVER use code blocks, backticks, or any visual formatting.
- NEVER use special characters for emphasis or decoration: no asterisks, no dashes as separators, no equals signs.
- Speak in natural conversational sentences, as if talking to someone in the room.
- Use pauses naturally through punctuation: commas, periods, question marks.
- If listing items, say them conversationally: "first... second... and third..." — not as a formatted list.
- If you need to emphasize something, use words: "this is really important" — not formatting.
```

- [ ] **Step 2: Commit**

```bash
git add gateway/persona.md
git commit -m "feat(persona): add strict voice output rules — forbid all markdown in spoken responses"
```

---

## Task 5: TTSProvider Interface — Add `endTurn()`

**Files:**
- Modify: `gateway/src/providers/tts/tts-types.ts`
- Modify: `shared/testing/src/mock-tts-provider.ts`

- [ ] **Step 1: Add `endTurn` to TTSProvider interface**

In `gateway/src/providers/tts/tts-types.ts`, add `endTurn` to the interface:

```typescript
export interface TTSProvider {
  connect(config: TTSConfig, signal: AbortSignal): Promise<void>;
  synthesize(text: string, signal: AbortSignal): AsyncGenerator<TTSAudioChunk>;
  endTurn(): Promise<void>;
  disconnect(): Promise<void>;
}
```

- [ ] **Step 2: Add `endTurn` to mock TTS provider**

In `shared/testing/src/mock-tts-provider.ts`:

Add to the `TTSProvider` interface:
```typescript
export interface TTSProvider {
  connect(config: TTSConfig, signal: AbortSignal): Promise<void>;
  synthesize(text: string, signal: AbortSignal): AsyncGenerator<TTSAudioChunk>;
  endTurn(): Promise<void>;
  disconnect(): Promise<void>;
}
```

Add to `MockTTSProvider` interface:
```typescript
export interface MockTTSProvider extends TTSProvider {
  synthesizeCalls: string[];
  isConnected: boolean;
  connectCallCount: number;
  disconnectCallCount: number;
  endTurnCallCount: number;
}
```

Add implementation inside `createMockTTSProvider`:
```typescript
let endTurnCallCount = 0;

async function endTurn(): Promise<void> {
  endTurnCallCount++;
}
```

Add to the return object:
```typescript
get endTurnCallCount() { return endTurnCallCount; },
endTurn,
```

- [ ] **Step 3: Add `endTurn` to fish-audio-provider (no-op for now)**

In `gateway/src/providers/tts/fish-audio-provider.ts`, add to the returned object:

```typescript
async function endTurn(): Promise<void> {
  // Will be implemented in Task 7 (persistent connection refactor)
}

return { connect, synthesize, endTurn, disconnect };
```

- [ ] **Step 4: Run tests to verify nothing broke**

Run: `cd gateway && bun run vitest run`
Expected: PASS (all existing tests should still pass)

- [ ] **Step 5: Commit**

```bash
git add gateway/src/providers/tts/tts-types.ts shared/testing/src/mock-tts-provider.ts gateway/src/providers/tts/fish-audio-provider.ts
git commit -m "feat(tts): add endTurn() to TTSProvider interface for per-turn connection lifecycle"
```

---

## Task 6: Fish Audio Provider — Persistent Per-Turn Connection

**Files:**
- Modify: `gateway/src/providers/tts/fish-audio-provider.ts`
- Modify: `gateway/src/providers/tts/fish-audio-provider.test.ts`

This is the largest refactor. The provider changes from opening a new WS per `synthesize()` call to opening one WS on `connect()` and sending multiple `text` events.

- [ ] **Step 1: Update tests for new connection behavior**

Rewrite `fish-audio-provider.test.ts` to expect the new lifecycle. Key test changes:

1. `connect()` now opens a WS and sends `start` message
2. `synthesize()` sends only a `text` event (no `start`/`stop`)
3. `endTurn()` sends `stop` and waits for `finish`
4. Multiple `synthesize()` calls reuse the same WS

Replace the `connect()` test block:
```typescript
describe("connect()", () => {
  it("opens a WebSocket and sends start message", async () => {
    const { decode } = await import("@msgpack/msgpack");
    const provider = createFishAudioProvider();
    const connectPromise = provider.connect(makeConfig(), new AbortController().signal);
    const ws = lastCreatedWs as NonNullable<typeof lastCreatedWs>;
    ws.simulateOpen();
    await connectPromise;

    expect(ws).not.toBeNull();
    expect(ws.url).toBe("wss://api.fish.audio/v1/tts/live");
    expect(ws.sentMessages).toHaveLength(1);
    const start = decode(ws.sentMessages[0] as Uint8Array) as Record<string, unknown>;
    expect(start.event).toBe("start");
  });

  it("sends Authorization and model headers", async () => {
    const provider = createFishAudioProvider();
    const connectPromise = provider.connect(makeConfig({ apiKey: "secret-key" }), new AbortController().signal);
    const ws = lastCreatedWs as NonNullable<typeof lastCreatedWs>;
    ws.simulateOpen();
    await connectPromise;

    expect(ws.options.headers?.Authorization).toBe("Bearer secret-key");
    expect(ws.options.headers?.model).toBe("s1");
  });
});
```

Replace the `synthesize()` messages test block:
```typescript
describe("synthesize() — messages", () => {
  it("sends only a text event on the existing connection", async () => {
    const { decode } = await import("@msgpack/msgpack");
    const provider = createFishAudioProvider();
    const signal = new AbortController().signal;

    const connectPromise = provider.connect(makeConfig(), signal);
    const ws = lastCreatedWs as NonNullable<typeof lastCreatedWs>;
    ws.simulateOpen();
    await connectPromise;

    const startMsgCount = ws.sentMessages.length; // 1 (start)
    const { chunks } = await drainSynthesize(provider, "Hello world.", signal, (w) => {
      w.simulateMessage(makeAudioMessage(new Uint8Array([1])));
      // No finish — that comes from endTurn()
    });

    // Should have sent exactly 1 more message (text)
    expect(ws.sentMessages.length).toBe(startMsgCount + 1);
    const textMsg = decode(ws.sentMessages[startMsgCount] as Uint8Array) as Record<string, unknown>;
    expect(textMsg.event).toBe("text");
    expect(textMsg.text).toBe("Hello world.");
  });

  it("reuses the same WS for multiple synthesize calls", async () => {
    const provider = createFishAudioProvider();
    const signal = new AbortController().signal;

    const connectPromise = provider.connect(makeConfig(), signal);
    const ws = lastCreatedWs as NonNullable<typeof lastCreatedWs>;
    ws.simulateOpen();
    await connectPromise;

    const wsRef = lastCreatedWs;

    await drainSynthesize(provider, "First.", signal, (w) => {
      w.simulateMessage(makeAudioMessage(new Uint8Array([1])));
    });
    await drainSynthesize(provider, "Second.", signal, (w) => {
      w.simulateMessage(makeAudioMessage(new Uint8Array([2])));
    });

    // Same WS instance — no new WS created
    expect(lastCreatedWs).toBe(wsRef);
  });
});
```

Add `endTurn()` tests:
```typescript
describe("endTurn()", () => {
  it("sends stop event and waits for finish", async () => {
    const { decode } = await import("@msgpack/msgpack");
    const provider = createFishAudioProvider();
    const signal = new AbortController().signal;

    const connectPromise = provider.connect(makeConfig(), signal);
    const ws = lastCreatedWs as NonNullable<typeof lastCreatedWs>;
    ws.simulateOpen();
    await connectPromise;

    const endPromise = provider.endTurn();
    const stopMsg = decode(ws.sentMessages[ws.sentMessages.length - 1] as Uint8Array) as Record<string, unknown>;
    expect(stopMsg.event).toBe("stop");

    ws.simulateMessage(makeFinishMessage());
    await endPromise;

    expect(ws.readyState).toBe(3); // CLOSED
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd gateway && bun run vitest run src/providers/tts/fish-audio-provider.test.ts`
Expected: FAIL — connect() no longer just stores config

- [ ] **Step 3: Rewrite fish-audio-provider with persistent connection**

Rewrite `gateway/src/providers/tts/fish-audio-provider.ts`. Key changes:
- `connect()` opens WS and sends `start`
- `synthesize()` sends `text` event on existing WS, yields audio chunks from shared queue
- `endTurn()` sends `stop`, waits for `finish`, closes WS
- `disconnect()` closes WS if open
- Replace bare array with `createAudioChunkQueue(600)`

The `drainSynthesize` helper in tests will also need updating since the WS is already open when `synthesize()` is called (no need to call `ws.simulateOpen()` inside drainSynthesize — it's done during `connect()`).

Read the full current implementation, then rewrite it following the spec's connection lifecycle. The `AudioQueue` internal to the file is replaced by the imported `createAudioChunkQueue`. The WS is held as module state between `connect()` and `disconnect()`.

- [ ] **Step 4: Run tests**

Run: `cd gateway && bun run vitest run src/providers/tts/fish-audio-provider.test.ts`
Expected: PASS

- [ ] **Step 5: Run full gateway test suite to check for breakage**

Run: `cd gateway && bun run vitest run`
Expected: Some tests may fail in `streaming-overlap.test.ts` or `continuous-voice-handler.test.ts` because they use the mock TTS provider which now has `endTurn()`. These will be fixed in later tasks. Note which tests fail.

- [ ] **Step 6: Commit**

```bash
git add gateway/src/providers/tts/fish-audio-provider.ts gateway/src/providers/tts/fish-audio-provider.test.ts
git commit -m "refactor(tts): persistent per-turn Fish Audio connection — one WS per turn, not per sentence"
```

---

## Task 7: Streaming Overlap → TTS Terminal Stage

**Files:**
- Modify: `gateway/src/pipeline/processors/streaming-overlap.ts`
- Modify: `gateway/src/pipeline/processors/streaming-overlap.test.ts`
- Modify: `gateway/src/pipeline/processors/tts-processor.ts`
- Modify: `gateway/src/pipeline/processors/tts-processor.test.ts`

The streaming overlap becomes the TTS terminal stage. It receives `AsyncGenerator<PipelineChunk>` and yields `AsyncGenerator<PipelineOutput>`.

- [ ] **Step 1: Update tts-processor to work with PipelineChunk**

The TTS processor stays mostly the same — it still wraps the TTSProvider's `synthesize()`. But update types for clarity. No signature change needed since `synthesizeSentence` still takes `(text: string, signal: AbortSignal)` — the terminal stage extracts `.speech` before calling it.

Verify no changes needed. If `tts-processor.ts` is still compatible, skip to step 2.

- [ ] **Step 2: Write updated streaming-overlap tests**

Update `streaming-overlap.test.ts` to use `PipelineChunk` input and expect `PipelineOutput` output:

```typescript
// Update the collectFrames helper
async function collectOutput(
  overlap: ReturnType<typeof createStreamingOverlap>,
  chunks: PipelineChunk[],
  signal: AbortSignal,
): Promise<PipelineOutput[]> {
  const results: PipelineOutput[] = [];
  async function* chunkGen(): AsyncGenerator<PipelineChunk> {
    for (const chunk of chunks) {
      if (signal.aborted) return;
      yield chunk;
    }
  }
  for await (const output of overlap.process(chunkGen(), signal)) {
    results.push(output);
  }
  return results;
}
```

Test that the terminal stage yields both text and audio events:
```typescript
it("yields text events for display and audio events for speech", async () => {
  const results = await collectOutput(
    createStreamingOverlap(createTTSProcessor(mockTTS)),
    [{ display: "**Hello** world.", speech: "Hello world." }],
    new AbortController().signal,
  );
  const textEvents = results.filter((r) => r.type === "text");
  const audioEvents = results.filter((r) => r.type === "audio");
  expect(textEvents.length).toBeGreaterThan(0);
  expect(textEvents[0]).toEqual({ type: "text", display: "**Hello** world." });
  expect(audioEvents.length).toBeGreaterThan(0);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd gateway && bun run vitest run src/pipeline/processors/streaming-overlap.test.ts`
Expected: FAIL — type mismatches

- [ ] **Step 4: Refactor streaming-overlap.ts**

Update the `process` method signature and internals:
- Input: `AsyncGenerator<PipelineChunk>` (was `AsyncGenerator<string>`)
- Output: `AsyncGenerator<PipelineOutput>` (was `AsyncGenerator<AudioFrame>`)
- Consumer reads `.speech` for sentence aggregation, yields `{ type: "text", display: chunk.display }` for each incoming chunk
- Yields `{ type: "audio", frame }` for each TTS audio frame

The `runLLMConsumer` becomes `runInputConsumer` — it reads `PipelineChunk`s from the input stream, pushes each `.display` onto a display queue, and feeds `.speech` to the sentence aggregator.

The main generator:
1. Drains display queue → yields `{ type: "text", display }` events
2. Iterates sentences → calls TTS → yields `{ type: "audio", frame }` events

Remove the `onAudioStart` / `onAudioDone` callbacks — the caller can detect these from the stream (first audio event = start, stream end = done).

- [ ] **Step 5: Run tests**

Run: `cd gateway && bun run vitest run src/pipeline/processors/streaming-overlap.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add gateway/src/pipeline/processors/streaming-overlap.ts gateway/src/pipeline/processors/streaming-overlap.test.ts gateway/src/pipeline/processors/tts-processor.ts gateway/src/pipeline/processors/tts-processor.test.ts
git commit -m "refactor(pipeline): streaming overlap → TTS terminal stage with PipelineChunk/PipelineOutput"
```

---

## Task 8: Voice Turn — Pipeline Composition

**Files:**
- Modify: `gateway/src/pipeline/voice-turn.ts`
- Modify: `gateway/src/pipeline/voice-turn.test.ts`

- [ ] **Step 1: Update VoiceTurnEvent type and runVoiceTurn**

The voice turn now composes the decorator pipeline. Replace the manual `textBuffer` + `llmTap()` pattern with the pipeline chain:

1. LLM tokens → `toPipelineChunk()` → sanitizer → TTS terminal stage → `PipelineOutput`
2. Route `PipelineOutput` events to `VoiceTurnEvent` yields

`VoiceTurnEvent` stays the same (the voice handler consumes it). The voice turn is the bridge between the internal pipeline and the external event protocol.

```typescript
export async function* runVoiceTurn(options: VoiceTurnOptions): AsyncGenerator<VoiceTurnEvent> {
  const { transcript, history, contextAssembler, llmProvider, ttsProcessor, chatModel, signal } = options;
  const messages = contextAssembler.buildMessages(history, transcript);

  // LLM token stream → PipelineChunk (display = speech = raw token)
  async function* llmToPipelineChunks(): AsyncGenerator<PipelineChunk> {
    for await (const token of llmProvider.stream({ model: chatModel, messages, signal })) {
      yield toPipelineChunk(token);
    }
  }

  // Compose text decorators
  const sanitizer = createTtsSanitizer();
  const sanitized = sanitizer(llmToPipelineChunks(), signal);

  // Terminal stage: PipelineChunk → PipelineOutput
  const overlap = createStreamingOverlap(ttsProcessor);
  let fullText = "";
  let audioStartEmitted = false;

  for await (const event of overlap.process(sanitized, signal)) {
    if (event.type === "text") {
      fullText += event.display;
      yield { type: "text.delta", payload: event.display };
    } else if (event.type === "audio") {
      if (!audioStartEmitted) {
        yield { type: "audio.start", payload: null };
        audioStartEmitted = true;
      }
      yield { type: "audio.frame", payload: event.frame.data };
    }
  }

  yield { type: "text.done", payload: fullText };
  if (audioStartEmitted) {
    yield { type: "audio.done", payload: null };
  }
}
```

Update imports at top of file:
```typescript
import { toPipelineChunk } from "./processors/pipeline-types.ts";
import { createTtsSanitizer } from "./processors/tts-text-sanitizer.ts";
```

- [ ] **Step 2: Update voice-turn tests**

The existing tests should mostly still pass since `VoiceTurnEvent` shape is unchanged. The mock TTS and LLM providers are the same. Update imports if needed. The key behavioral change: text deltas now come from the pipeline's `text` events rather than the `textBuffer` tap.

Run: `cd gateway && bun run vitest run src/pipeline/voice-turn.test.ts`

Fix any type mismatches. The mock TTS processor may need updating if `streaming-overlap` now expects `PipelineChunk` input.

- [ ] **Step 3: Run full test suite**

Run: `cd gateway && bun run vitest run`
Expected: PASS (or note remaining failures for next task)

- [ ] **Step 4: Commit**

```bash
git add gateway/src/pipeline/voice-turn.ts gateway/src/pipeline/voice-turn.test.ts
git commit -m "refactor(pipeline): voice turn composes decorator pipeline — sanitizer → TTS terminal stage"
```

---

## Task 9: Continuous Voice Handler Update

**Files:**
- Modify: `gateway/src/server/continuous-voice-handler.ts`
- Modify: `gateway/src/server/continuous-voice-handler.test.ts` (if exists)
- Modify: `gateway/src/server/continuous-voice-handler-turns.test.ts` (if exists)

- [ ] **Step 1: Update runTurn to call endTurn**

In `continuous-voice-handler.ts`, the `runTurn` function's `for await` loop over `runVoiceTurn()` stays the same (it consumes `VoiceTurnEvent`). Add `endTurn()` call after the loop completes normally:

```typescript
// After the for-await loop in runTurn():
if (!turnController.signal.aborted) {
  await deps.ttsProcessor.endTurn?.();
}
```

Wait — `ttsProcessor` is a `TTSProcessor`, not a `TTSProvider`. The `endTurn()` is on the provider. The TTS processor wraps the provider. We need to either:
- Expose `endTurn()` through the TTS processor
- Or call it on the provider directly from the voice handler

The cleanest approach: add `endTurn()` to the `TTSProcessor` interface and have it delegate to the provider.

Update `tts-processor.ts`:
```typescript
export interface TTSProcessor {
  synthesizeSentence(text: string, signal: AbortSignal): AsyncGenerator<AudioFrame>;
  endTurn(): Promise<void>;
}

export function createTTSProcessor(tts: TTSProvider): TTSProcessor {
  // ... existing synthesizeSentence ...

  async function endTurn(): Promise<void> {
    await tts.endTurn();
  }

  return { synthesizeSentence, endTurn };
}
```

Then in the streaming-overlap terminal stage, call `ttsProcessor.endTurn()` in the `finally` block after all sentences are processed.

- [ ] **Step 2: Run handler tests**

Run: `cd gateway && bun run vitest run src/server/continuous-voice-handler*.test.ts`
Expected: PASS

- [ ] **Step 3: Run full test suite**

Run: `cd gateway && bun run vitest run`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add gateway/src/server/continuous-voice-handler.ts gateway/src/pipeline/processors/tts-processor.ts gateway/src/pipeline/processors/streaming-overlap.ts
git commit -m "refactor(pipeline): wire endTurn() through TTS processor to terminal stage"
```

---

## Task 10: Parallel Service Initialization

**Files:**
- Modify: `gateway/src/pipeline/continuous-session.ts`
- Modify: `gateway/src/pipeline/continuous-session.test.ts`

- [ ] **Step 1: Write test for parallel init**

Add to `continuous-session.test.ts`:

```typescript
it("connects STT and TTS in parallel", async () => {
  // Track the order of connect calls
  const connectOrder: string[] = [];
  const sttProvider = createMockSTTProvider();
  const ttsProvider = createMockTTSProvider();

  // Wrap connect to track call timing
  const origSttConnect = sttProvider.connect.bind(sttProvider);
  sttProvider.connect = async (...args) => {
    connectOrder.push("stt-start");
    await origSttConnect(...args);
    connectOrder.push("stt-done");
  };

  const origTtsConnect = ttsProvider.connect.bind(ttsProvider);
  ttsProvider.connect = async (...args) => {
    connectOrder.push("tts-start");
    await origTtsConnect(...args);
    connectOrder.push("tts-done");
  };

  const session = createContinuousSession({ sttProvider, sttConfig, ttsProvider, ttsConfig });
  await session.start();

  // Both should have started before either finished (parallel)
  expect(connectOrder[0]).toBe("stt-start");
  expect(connectOrder[1]).toBe("tts-start");
  expect(sttProvider.isConnected).toBe(true);
  expect(ttsProvider.isConnected).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

The current sequential implementation will show `stt-start, stt-done, tts-start, tts-done` order.

- [ ] **Step 3: Update doConnect to use Promise.allSettled**

In `continuous-session.ts`, replace the sequential connect with parallel:

```typescript
async function doConnect(): Promise<void> {
  sessionController = new AbortController();
  const signal = sessionController.signal;

  const results = await Promise.allSettled([
    sttProvider.connect(sttConfig, signal),
    ttsProvider.connect(ttsConfig, signal),
  ]);

  if (isClosed) {
    await sttProvider.disconnect();
    await ttsProvider.disconnect();
    return;
  }

  const sttResult = results[0];
  const ttsResult = results[1];

  // If either failed, clean up the successful one and throw
  if (sttResult.status === "rejected" || ttsResult.status === "rejected") {
    if (sttResult.status === "fulfilled") await sttProvider.disconnect();
    if (ttsResult.status === "fulfilled") await ttsProvider.disconnect();
    const error = sttResult.status === "rejected" ? sttResult.reason : ttsResult.reason;
    throw error instanceof Error ? error : new Error(String(error));
  }

  sttConnected = true;
  ttsConnected = true;

  // Flush early audio buffer
  for (const chunk of earlyAudioBuffer) {
    sttProvider.sendAudio(chunk);
  }
  earlyAudioBuffer = [];

  startTranscriptRelay(signal);
}
```

- [ ] **Step 4: Run tests**

Run: `cd gateway && bun run vitest run src/pipeline/continuous-session.test.ts`
Expected: PASS

- [ ] **Step 5: Run full test suite**

Run: `cd gateway && bun run vitest run`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add gateway/src/pipeline/continuous-session.ts gateway/src/pipeline/continuous-session.test.ts
git commit -m "perf(pipeline): parallel STT + TTS initialization at session start"
```

---

## Task 11: SDK and Web Client Compliance Audit

**Files:**
- Audit: `shared/protocol/src/messages.ts`
- Audit: `shared/web-sdk/src/voice-client.ts`
- Audit: `shared/web-sdk/src/voice-state-machine.ts`
- Audit: `web/src/hooks/use-voice-client.ts`
- Audit: `web/src/adapters/web-audio-playback.ts`

- [ ] **Step 1: Verify protocol messages unchanged**

The gateway still emits the same WS message types (`response.text.delta`, `response.audio.start`, `response.audio.done`, etc.). The `PipelineOutput` is internal to the gateway — the `continuous-voice-handler.ts` translates it to the existing protocol. Verify no protocol changes are needed.

Read `shared/protocol/src/messages.ts` and confirm all gateway→client message types are unchanged.

- [ ] **Step 2: Verify SDK handles messages correctly**

Read `shared/web-sdk/src/voice-client.ts` and confirm:
- `handleJsonMessage` cases match the gateway's message types
- `binaryMessage` handler still receives raw audio bytes
- State machine transitions are unchanged

- [ ] **Step 3: Verify web client**

Read `web/src/hooks/use-voice-client.ts` and confirm the hook still consumes SDK events correctly. No changes expected since the SDK API is unchanged.

- [ ] **Step 4: Run SDK test suite**

Run: `cd shared/web-sdk && bun run vitest run`
Expected: PASS

- [ ] **Step 5: Run web test suite**

Run: `cd web && bun run vitest run`
Expected: PASS

- [ ] **Step 6: Commit (if any changes needed)**

If any client-side changes were needed:
```bash
git add shared/ web/
git commit -m "fix(sdk): update client to comply with pipeline changes"
```

If no changes needed, skip this commit.

---

## Task 12: Integration Verification

- [ ] **Step 1: Run full CI suite**

```bash
bun run ci
```

Expected: All lint, typecheck, and tests pass.

- [ ] **Step 2: Run gateway tests with coverage**

```bash
cd gateway && bun run vitest run --coverage
```

Verify coverage meets 80% statements, 75% branches.

- [ ] **Step 3: Manual smoke test**

Start the gateway and web client. Test the story prompt from the bug report:
- Ask "Tell me a bedtime story"
- Verify: no markdown in TTS audio (no gibberish from asterisks/dashes)
- Verify: text display in chat shows the full response
- Verify: audio plays cleanly without lost words
- Test barge-in during audio playback

- [ ] **Step 4: Final commit if needed**

```bash
git add -A
git commit -m "chore: integration fixes from smoke testing"
```
