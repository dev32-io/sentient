# Barge-In Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden the barge-in pipeline by extracting barge-in logic into four isolated units (BargeInController, TranscriptAccumulator, TurnTransition), fixing audio leak after barge-in, fixing speech chunk combining, and adding playback rejection on the client.

**Architecture:** ContinuousSession (~520 lines with 8 mutable flags) is decomposed into a thin orchestrator delegating to: BargeInController (pure state machine for barge-in decisions), TranscriptAccumulator (speech text accumulation with proper combining), and TurnTransition (atomic abort→flush→ack sequence). TurnController is simplified to remove all barge-in logic. Client-side gets atomic playback rejection to prevent audio leak after ack.

**Tech Stack:** Bun, TypeScript, Vitest

**Note:** WebRTC AEC is already implemented in `web/src/adapters/web-audio-playback.ts` (RTCPeerConnection loopback). No new playback adapter needed.

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `gateway/src/pipeline/transcript-accumulator.ts` | Create | Accumulates partial/final transcripts, combines across barge-in boundaries |
| `gateway/src/pipeline/transcript-accumulator.test.ts` | Create | Tests for accumulation, seed, finalize |
| `gateway/src/pipeline/barge-in-controller.ts` | Create | Pure state machine for barge-in decisions |
| `gateway/src/pipeline/barge-in-controller.test.ts` | Create | Tests for all rules: min duration, confidence, debounce, no-interrupt window |
| `gateway/src/pipeline/turn-transition.ts` | Create | Atomic abort→reconnect→settled→ack sequence |
| `gateway/src/pipeline/turn-transition.test.ts` | Create | Tests for ordering guarantees, error handling |
| `gateway/src/pipeline/turn-controller.ts` | Simplify | Remove barge-in logic, add `settled()`, add `onSpeakingChanged` callback |
| `gateway/src/pipeline/continuous-session.ts` | Refactor | Replace flags with new units, thin orchestrator |
| `shared/web-sdk/src/voice-client.ts` | Modify | Atomic playback rejection on barge-in, graceful VAD degradation |

---

### Task 1: TranscriptAccumulator

**Files:**
- Create: `gateway/src/pipeline/transcript-accumulator.ts`
- Create: `gateway/src/pipeline/transcript-accumulator.test.ts`

Pure data structure — accumulates Deepgram transcript chunks. Handles partial replacement, final appending, seed (for barge-in text), and finalize (for turn start).

- [ ] **Step 1: Write the failing tests**

```typescript
// gateway/src/pipeline/transcript-accumulator.test.ts
import { describe, expect, it } from "vitest";
import { createTranscriptAccumulator } from "./transcript-accumulator.ts";

describe("TranscriptAccumulator — finals", () => {
  it("accumulates final transcripts with space separator", () => {
    const acc = createTranscriptAccumulator();
    acc.appendFinal("Hello");
    acc.appendFinal("world");
    expect(acc.current()).toBe("Hello world");
  });

  it("returns accumulated text on appendFinal", () => {
    const acc = createTranscriptAccumulator();
    expect(acc.appendFinal("Hello")).toBe("Hello");
    expect(acc.appendFinal("world")).toBe("Hello world");
  });

  it("finalize returns text and resets", () => {
    const acc = createTranscriptAccumulator();
    acc.appendFinal("Hello world");
    expect(acc.finalize()).toBe("Hello world");
    expect(acc.current()).toBe("");
    expect(acc.finalize()).toBe("");
  });
});

describe("TranscriptAccumulator — partials", () => {
  it("replaces previous partial on updatePartial", () => {
    const acc = createTranscriptAccumulator();
    acc.updatePartial("Hel");
    acc.updatePartial("Hello");
    expect(acc.current()).toBe("Hello");
  });

  it("clears partial when final arrives", () => {
    const acc = createTranscriptAccumulator();
    acc.updatePartial("Hello wor");
    acc.appendFinal("Hello world");
    expect(acc.current()).toBe("Hello world");
  });

  it("includes partial in current but not in finalize text after finals", () => {
    const acc = createTranscriptAccumulator();
    acc.appendFinal("First sentence.");
    acc.updatePartial("Second sen");
    expect(acc.current()).toBe("First sentence. Second sen");
    // finalize includes the partial as it may be the user's final words
    expect(acc.finalize()).toBe("First sentence. Second sen");
  });
});

describe("TranscriptAccumulator — seed (barge-in)", () => {
  it("appends seed text to existing accumulation", () => {
    const acc = createTranscriptAccumulator();
    acc.appendFinal("Wait, I have");
    acc.seed("a question");
    expect(acc.current()).toBe("Wait, I have a question");
  });

  it("seed with empty string is a no-op", () => {
    const acc = createTranscriptAccumulator();
    acc.appendFinal("Hello");
    acc.seed("");
    acc.seed("   ");
    expect(acc.current()).toBe("Hello");
  });

  it("seed on empty accumulator starts fresh", () => {
    const acc = createTranscriptAccumulator();
    acc.seed("Barge-in text");
    expect(acc.current()).toBe("Barge-in text");
  });
});

describe("TranscriptAccumulator — reset", () => {
  it("clears all state", () => {
    const acc = createTranscriptAccumulator();
    acc.appendFinal("Hello");
    acc.updatePartial("world");
    acc.reset();
    expect(acc.current()).toBe("");
    expect(acc.finalize()).toBe("");
  });
});

describe("TranscriptAccumulator — hasSpeech", () => {
  it("returns false when empty", () => {
    const acc = createTranscriptAccumulator();
    expect(acc.hasSpeech()).toBe(false);
  });

  it("returns true when has finals", () => {
    const acc = createTranscriptAccumulator();
    acc.appendFinal("Hello");
    expect(acc.hasSpeech()).toBe(true);
  });

  it("returns true when has partial only", () => {
    const acc = createTranscriptAccumulator();
    acc.updatePartial("Hel");
    expect(acc.hasSpeech()).toBe(true);
  });

  it("returns false after reset", () => {
    const acc = createTranscriptAccumulator();
    acc.appendFinal("Hello");
    acc.reset();
    expect(acc.hasSpeech()).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/kevinye/Development/sentient && source scripts/env.sh && cd gateway && bun test --run src/pipeline/transcript-accumulator.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// gateway/src/pipeline/transcript-accumulator.ts
import { getLog } from "../logging/logger.ts";

const log = getLog(["sentient", "pipeline", "accumulator"]);

export interface TranscriptAccumulator {
  updatePartial(text: string): void;
  appendFinal(text: string): string;
  current(): string;
  finalize(): string;
  seed(text: string): void;
  hasSpeech(): boolean;
  reset(): void;
}

export function createTranscriptAccumulator(): TranscriptAccumulator {
  let finals = "";
  let partial = "";

  function appendWithSpace(base: string, addition: string): string {
    if (!base) return addition;
    if (!addition) return base;
    return `${base} ${addition}`;
  }

  return {
    updatePartial(text: string): void {
      partial = text;
      log.debug("partial-updated", { partial });
    },

    appendFinal(text: string): string {
      finals = appendWithSpace(finals, text);
      partial = "";
      log.debug("final-appended", { finals });
      return finals;
    },

    current(): string {
      return appendWithSpace(finals, partial).trim();
    },

    finalize(): string {
      const result = appendWithSpace(finals, partial).trim();
      log.debug("finalize", { result });
      finals = "";
      partial = "";
      return result;
    },

    seed(text: string): void {
      const trimmed = text.trim();
      if (!trimmed) return;
      finals = appendWithSpace(finals, trimmed);
      log.debug("seed", { finals });
    },

    hasSpeech(): boolean {
      return finals.trim().length > 0 || partial.trim().length > 0;
    },

    reset(): void {
      finals = "";
      partial = "";
      log.debug("reset");
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/kevinye/Development/sentient && source scripts/env.sh && cd gateway && bun test --run src/pipeline/transcript-accumulator.test.ts`
Expected: PASS (13 tests)

- [ ] **Step 5: Commit**

```bash
git add gateway/src/pipeline/transcript-accumulator.ts gateway/src/pipeline/transcript-accumulator.test.ts
git commit -m "feat(pipeline): add TranscriptAccumulator for speech chunk combining"
```

---

### Task 2: BargeInController

**Files:**
- Create: `gateway/src/pipeline/barge-in-controller.ts`
- Create: `gateway/src/pipeline/barge-in-controller.test.ts`

Pure state machine — no side effects, no timers, no async. Takes events with caller-provided timestamps, returns decisions.

- [ ] **Step 1: Write the failing tests**

```typescript
// gateway/src/pipeline/barge-in-controller.test.ts
import { describe, expect, it } from "vitest";
import { createBargeInController } from "./barge-in-controller.ts";
import type { BargeInEvent } from "./barge-in-controller.ts";

function transcript(overrides: Partial<Extract<BargeInEvent, { type: "transcript" }>> = {}): BargeInEvent {
  return {
    type: "transcript",
    text: "hello",
    isFinal: true,
    confidence: 0.95,
    speechFinal: false,
    timestampMs: 1000,
    ...overrides,
  };
}

describe("BargeInController — no-interrupt window", () => {
  it("rejects barge-in within minInterruptionMs of assistant start", () => {
    const ctrl = createBargeInController({ minInterruptionMs: 500, confidenceThreshold: 0.9, debounceCooldownMs: 300 });
    ctrl.handle({ type: "assistant_started", timestampMs: 0 });
    const decision = ctrl.handle(transcript({ timestampMs: 400 }));
    expect(decision.action).toBe("none");
  });

  it("accepts barge-in after minInterruptionMs", () => {
    const ctrl = createBargeInController({ minInterruptionMs: 500, confidenceThreshold: 0.9, debounceCooldownMs: 300 });
    ctrl.handle({ type: "assistant_started", timestampMs: 0 });
    const decision = ctrl.handle(transcript({ timestampMs: 600 }));
    expect(decision.action).toBe("barge_in");
  });
});

describe("BargeInController — confidence gate", () => {
  it("rejects transcript below confidence threshold", () => {
    const ctrl = createBargeInController({ minInterruptionMs: 0, confidenceThreshold: 0.9, debounceCooldownMs: 0 });
    ctrl.handle({ type: "assistant_started", timestampMs: 0 });
    const decision = ctrl.handle(transcript({ confidence: 0.85, timestampMs: 100 }));
    expect(decision.action).toBe("none");
  });

  it("rejects non-final transcripts", () => {
    const ctrl = createBargeInController({ minInterruptionMs: 0, confidenceThreshold: 0.9, debounceCooldownMs: 0 });
    ctrl.handle({ type: "assistant_started", timestampMs: 0 });
    const decision = ctrl.handle(transcript({ isFinal: false, timestampMs: 100 }));
    expect(decision.action).toBe("none");
  });

  it("rejects empty text transcripts", () => {
    const ctrl = createBargeInController({ minInterruptionMs: 0, confidenceThreshold: 0.9, debounceCooldownMs: 0 });
    ctrl.handle({ type: "assistant_started", timestampMs: 0 });
    const decision = ctrl.handle(transcript({ text: "  ", timestampMs: 100 }));
    expect(decision.action).toBe("none");
  });

  it("accepts high-confidence final transcript with text", () => {
    const ctrl = createBargeInController({ minInterruptionMs: 0, confidenceThreshold: 0.9, debounceCooldownMs: 0 });
    ctrl.handle({ type: "assistant_started", timestampMs: 0 });
    const decision = ctrl.handle(transcript({ text: "stop", confidence: 0.95, timestampMs: 100 }));
    expect(decision).toEqual({ action: "barge_in", text: "stop", speechFinal: false });
  });
});

describe("BargeInController — client VAD", () => {
  it("accepts client_vad barge-in (bypasses confidence gate)", () => {
    const ctrl = createBargeInController({ minInterruptionMs: 0, confidenceThreshold: 0.9, debounceCooldownMs: 0 });
    ctrl.handle({ type: "assistant_started", timestampMs: 0 });
    const decision = ctrl.handle({ type: "client_vad", timestampMs: 100 });
    expect(decision).toEqual({ action: "barge_in", text: "", speechFinal: false });
  });

  it("client_vad respects no-interrupt window", () => {
    const ctrl = createBargeInController({ minInterruptionMs: 500, confidenceThreshold: 0.9, debounceCooldownMs: 0 });
    ctrl.handle({ type: "assistant_started", timestampMs: 0 });
    const decision = ctrl.handle({ type: "client_vad", timestampMs: 300 });
    expect(decision.action).toBe("none");
  });
});

describe("BargeInController — debounce", () => {
  it("rejects second barge-in within debounce window", () => {
    const ctrl = createBargeInController({ minInterruptionMs: 0, confidenceThreshold: 0.9, debounceCooldownMs: 300 });
    ctrl.handle({ type: "assistant_started", timestampMs: 0 });
    ctrl.handle(transcript({ timestampMs: 100 })); // first barge-in accepted
    const decision = ctrl.handle(transcript({ timestampMs: 350 })); // within 300ms
    expect(decision.action).toBe("none");
  });

  it("accepts barge-in after debounce window", () => {
    const ctrl = createBargeInController({ minInterruptionMs: 0, confidenceThreshold: 0.9, debounceCooldownMs: 300 });
    ctrl.handle({ type: "assistant_started", timestampMs: 0 });
    ctrl.handle(transcript({ timestampMs: 100 }));
    // Need a new assistant_started for the next turn
    ctrl.handle({ type: "turn_completed" });
    ctrl.handle({ type: "assistant_started", timestampMs: 500 });
    const decision = ctrl.handle(transcript({ timestampMs: 600 }));
    expect(decision.action).toBe("barge_in");
  });
});

describe("BargeInController — not speaking", () => {
  it("rejects barge-in when assistant is not speaking", () => {
    const ctrl = createBargeInController({ minInterruptionMs: 0, confidenceThreshold: 0.9, debounceCooldownMs: 0 });
    const decision = ctrl.handle(transcript({ timestampMs: 100 }));
    expect(decision.action).toBe("none");
  });

  it("rejects barge-in after assistant_ended", () => {
    const ctrl = createBargeInController({ minInterruptionMs: 0, confidenceThreshold: 0.9, debounceCooldownMs: 0 });
    ctrl.handle({ type: "assistant_started", timestampMs: 0 });
    ctrl.handle({ type: "assistant_ended", timestampMs: 500 });
    const decision = ctrl.handle(transcript({ timestampMs: 600 }));
    expect(decision.action).toBe("none");
  });
});

describe("BargeInController — reset", () => {
  it("clears all state on reset", () => {
    const ctrl = createBargeInController({ minInterruptionMs: 500, confidenceThreshold: 0.9, debounceCooldownMs: 300 });
    ctrl.handle({ type: "assistant_started", timestampMs: 0 });
    ctrl.reset();
    // No assistant speaking after reset — should reject
    const decision = ctrl.handle(transcript({ timestampMs: 600 }));
    expect(decision.action).toBe("none");
  });
});

describe("BargeInController — speechFinal passthrough", () => {
  it("passes through speechFinal in barge-in decision", () => {
    const ctrl = createBargeInController({ minInterruptionMs: 0, confidenceThreshold: 0.9, debounceCooldownMs: 0 });
    ctrl.handle({ type: "assistant_started", timestampMs: 0 });
    const decision = ctrl.handle(transcript({ speechFinal: true, timestampMs: 100 }));
    expect(decision).toEqual({ action: "barge_in", text: "hello", speechFinal: true });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/kevinye/Development/sentient && source scripts/env.sh && cd gateway && bun test --run src/pipeline/barge-in-controller.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// gateway/src/pipeline/barge-in-controller.ts
import { getLog } from "../logging/logger.ts";

const log = getLog(["sentient", "pipeline", "barge-in"]);

export interface BargeInControllerOptions {
  readonly minInterruptionMs: number;
  readonly confidenceThreshold: number;
  readonly debounceCooldownMs: number;
}

export type BargeInEvent =
  | { type: "transcript"; text: string; isFinal: boolean; confidence: number; speechFinal: boolean; timestampMs: number }
  | { type: "client_vad"; timestampMs: number }
  | { type: "assistant_started"; timestampMs: number }
  | { type: "assistant_ended"; timestampMs: number }
  | { type: "turn_completed" };

export type BargeInDecision =
  | { action: "none" }
  | { action: "barge_in"; text: string; speechFinal: boolean };

const NONE: BargeInDecision = { action: "none" };

export interface BargeInController {
  handle(event: BargeInEvent): BargeInDecision;
  reset(): void;
}

export function createBargeInController(options: BargeInControllerOptions): BargeInController {
  const { minInterruptionMs, confidenceThreshold, debounceCooldownMs } = options;

  let assistantStartMs: number | null = null;
  let lastBargeInMs: number | null = null;

  function isAssistantSpeaking(): boolean {
    return assistantStartMs !== null;
  }

  function inNoInterruptWindow(timestampMs: number): boolean {
    if (assistantStartMs === null) return false;
    return timestampMs - assistantStartMs < minInterruptionMs;
  }

  function inDebounceCooldown(timestampMs: number): boolean {
    if (lastBargeInMs === null) return false;
    return timestampMs - lastBargeInMs < debounceCooldownMs;
  }

  function acceptBargeIn(text: string, speechFinal: boolean, timestampMs: number): BargeInDecision {
    lastBargeInMs = timestampMs;
    assistantStartMs = null;
    log.info("barge-in-accepted", { text: text.slice(0, 50), speechFinal, timestampMs });
    return { action: "barge_in", text, speechFinal };
  }

  return {
    handle(event: BargeInEvent): BargeInDecision {
      if (event.type === "assistant_started") {
        assistantStartMs = event.timestampMs;
        log.debug("assistant-started", { timestampMs: event.timestampMs });
        return NONE;
      }

      if (event.type === "assistant_ended") {
        assistantStartMs = null;
        log.debug("assistant-ended", { timestampMs: event.timestampMs });
        return NONE;
      }

      if (event.type === "turn_completed") {
        assistantStartMs = null;
        lastBargeInMs = null;
        log.debug("turn-completed");
        return NONE;
      }

      // From here: transcript or client_vad — both require assistant speaking
      if (!isAssistantSpeaking()) return NONE;

      const timestampMs = event.timestampMs;

      if (inNoInterruptWindow(timestampMs)) {
        log.debug("rejected-no-interrupt-window", { timestampMs, assistantStartMs });
        return NONE;
      }

      if (inDebounceCooldown(timestampMs)) {
        log.debug("rejected-debounce", { timestampMs, lastBargeInMs });
        return NONE;
      }

      if (event.type === "client_vad") {
        return acceptBargeIn("", false, timestampMs);
      }

      // Transcript confidence gate
      if (!event.isFinal) return NONE;
      if (!event.text.trim()) return NONE;
      if (event.confidence < confidenceThreshold) return NONE;

      return acceptBargeIn(event.text, event.speechFinal, timestampMs);
    },

    reset(): void {
      assistantStartMs = null;
      lastBargeInMs = null;
      log.debug("reset");
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/kevinye/Development/sentient && source scripts/env.sh && cd gateway && bun test --run src/pipeline/barge-in-controller.test.ts`
Expected: PASS (12 tests)

- [ ] **Step 5: Commit**

```bash
git add gateway/src/pipeline/barge-in-controller.ts gateway/src/pipeline/barge-in-controller.test.ts
git commit -m "feat(pipeline): add BargeInController pure state machine"
```

---

### Task 3: TurnTransition

**Files:**
- Create: `gateway/src/pipeline/turn-transition.ts`
- Create: `gateway/src/pipeline/turn-transition.test.ts`

Atomic abort→reconnect→settled→ack sequence. Guarantees no audio leaks after completion.

- [ ] **Step 1: Write the failing tests**

```typescript
// gateway/src/pipeline/turn-transition.test.ts
import { describe, expect, it, vi } from "vitest";
import { createTurnTransition } from "./turn-transition.ts";

function createMockTurn() {
  let aborted = false;
  let settledResolve: (() => void) | null = null;
  const settledPromise = new Promise<void>((r) => { settledResolve = r; });

  return {
    abort() { aborted = true; settledResolve?.(); },
    settled() { return settledPromise; },
    isAborted() { return aborted; },
    abortCallOrder: [] as string[],
  };
}

function createMockTtsManager() {
  let reconnectCalled = false;
  const callOrder: string[] = [];
  return {
    async reconnect() {
      callOrder.push("reconnect");
      reconnectCalled = true;
    },
    isReconnectCalled() { return reconnectCalled; },
    callOrder,
  };
}

function createMockSink() {
  const messages: unknown[] = [];
  const callOrder: string[] = [];
  return {
    sendJson(payload: unknown) {
      callOrder.push("sendJson");
      messages.push(payload);
    },
    sendBinary(_data: Uint8Array) {},
    messages,
    callOrder,
  };
}

describe("TurnTransition", () => {
  it("executes abort → reconnect → settled → ack in order", async () => {
    const turn = createMockTurn();
    const tts = createMockTtsManager();
    const sink = createMockSink();
    const transition = createTurnTransition();

    await transition.execute({ turn, ttsConnectionManager: tts, sink });

    expect(turn.isAborted()).toBe(true);
    expect(tts.isReconnectCalled()).toBe(true);
    expect(sink.messages).toEqual([{ type: "barge_in.ack" }]);
  });

  it("sends ack even if reconnect fails", async () => {
    const turn = createMockTurn();
    const tts = {
      async reconnect() { throw new Error("TTS down"); },
    };
    const sink = createMockSink();
    const transition = createTurnTransition();

    await transition.execute({ turn, ttsConnectionManager: tts, sink });

    expect(turn.isAborted()).toBe(true);
    expect(sink.messages).toEqual([{ type: "barge_in.ack" }]);
  });

  it("waits for turn to settle before sending ack", async () => {
    const order: string[] = [];
    let resolveSettled: (() => void) | null = null;

    const turn = {
      abort() { order.push("abort"); resolveSettled?.(); },
      settled() {
        return new Promise<void>((r) => {
          resolveSettled = () => { order.push("settled"); r(); };
        });
      },
    };
    const tts = { async reconnect() { order.push("reconnect"); } };
    const sink = {
      sendJson(_p: unknown) { order.push("ack"); },
      sendBinary(_d: Uint8Array) {},
    };
    const transition = createTurnTransition();

    await transition.execute({ turn, ttsConnectionManager: tts, sink });

    expect(order).toEqual(["abort", "reconnect", "settled", "ack"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/kevinye/Development/sentient && source scripts/env.sh && cd gateway && bun test --run src/pipeline/turn-transition.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// gateway/src/pipeline/turn-transition.ts
import { getLog } from "../logging/logger.ts";
import type { TurnSink } from "./turn-sink.ts";

const log = getLog(["sentient", "pipeline", "turn-transition"]);

export interface Abortable {
  abort(): void;
  settled(): Promise<void>;
}

export interface Reconnectable {
  reconnect(): Promise<void>;
}

export interface TurnTransitionOptions {
  readonly turn: Abortable;
  readonly ttsConnectionManager: Reconnectable;
  readonly sink: TurnSink;
}

export interface TurnTransition {
  execute(options: TurnTransitionOptions): Promise<void>;
}

export function createTurnTransition(): TurnTransition {
  return {
    async execute({ turn, ttsConnectionManager, sink }: TurnTransitionOptions): Promise<void> {
      // 1. Fire AbortSignal through entire pipeline
      log.info("abort-turn");
      turn.abort();

      // 2. Tear down TTS connection (AWAITED — no audio after this)
      try {
        await ttsConnectionManager.reconnect();
        log.debug("tts-reconnected");
      } catch (err: unknown) {
        log.warn("tts-reconnect-failed", { message: err instanceof Error ? err.message : String(err) });
      }

      // 3. Wait for turn.run() promise to settle — no more dispatchEvent calls possible
      await turn.settled();
      log.debug("turn-settled");

      // 4. Only NOW notify client — no audio can follow this message
      sink.sendJson({ type: "barge_in.ack" });
      log.info("barge-in-ack-sent");
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/kevinye/Development/sentient && source scripts/env.sh && cd gateway && bun test --run src/pipeline/turn-transition.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add gateway/src/pipeline/turn-transition.ts gateway/src/pipeline/turn-transition.test.ts
git commit -m "feat(pipeline): add TurnTransition for atomic barge-in abort sequence"
```

---

### Task 4: Simplify TurnController

**Files:**
- Modify: `gateway/src/pipeline/turn-controller.ts`
- Update: `gateway/src/pipeline/turn-controller.test.ts` (if it exists)

Remove all barge-in detection and echo suppression logic. Add `settled()` method and `onSpeakingChanged` callback.

- [ ] **Step 1: Read and understand current TurnController**

Read `gateway/src/pipeline/turn-controller.ts` (256 lines). The following will be removed:
- `BARGE_IN_CONFIDENCE_THRESHOLD` (line 13)
- `ECHO_COOLDOWN_MS` (line 14)
- `echoCooldownActive`, `echoCooldownTimer` (lines 63-64)
- `setAssistantSpeaking()` (lines 71-92)
- `handleTranscript()` (lines 133-166)
- `clientBargeIn()` (lines 221-236)

The following will be added:
- `onSpeakingChanged` callback option
- `settled()` method returning the `run()` promise

- [ ] **Step 2: Rewrite TurnController**

Replace the full contents of `gateway/src/pipeline/turn-controller.ts`:

```typescript
// gateway/src/pipeline/turn-controller.ts
import type { ContextAssembler } from "../context/context-assembler.ts";
import type { SessionHistory } from "../context/session-history.ts";
import { getLog } from "../logging/logger.ts";
import type { LLMProvider } from "../providers/llm-provider.ts";
import type { TTSProcessorFactory } from "./processors/tts-processor.ts";
import type { TurnSink } from "./turn-sink.ts";
import { type EmotionTagOptions, runVoiceTurn } from "./voice-turn.ts";

const log = getLog(["sentient", "pipeline", "turn"]);

export interface TurnControllerOptions {
  transcript: string;
  history: SessionHistory;
  sink: TurnSink;
  contextAssembler: ContextAssembler;
  llmProvider: LLMProvider;
  ttsProcessorFactory: TTSProcessorFactory;
  chatModel: string;
  language: string;
  emotionTags?: EmotionTagOptions;
  onSpeakingChanged?: (speaking: boolean) => void;
}

export interface TurnController {
  run(): Promise<void>;
  abort(): void;
  settled(): Promise<void>;
  isAssistantSpeaking(): boolean;
}

export function createTurnController(options: TurnControllerOptions): TurnController {
  const {
    transcript,
    history,
    sink,
    contextAssembler,
    llmProvider,
    ttsProcessorFactory,
    chatModel,
    language,
    emotionTags,
    onSpeakingChanged,
  } = options;

  const controller = new AbortController();
  const responseId = `resp-${Date.now()}`;
  let assistantSpeaking = false;
  let assistantText = "";
  let runPromise: Promise<void> | null = null;

  function setSpeaking(speaking: boolean): void {
    if (assistantSpeaking === speaking) return;
    assistantSpeaking = speaking;
    log.debug("speaking-changed", { responseId, speaking });
    onSpeakingChanged?.(speaking);
  }

  function dispatchEvent(event: { type: string; payload?: unknown }): void {
    log.debug("dispatch", { type: event.type, responseId });

    switch (event.type) {
      case "text.delta": {
        const delta = event.payload as string;
        assistantText += delta;
        history.setDraft("assistant", assistantText);
        sink.sendJson({ type: "response.text.delta", responseId, text: delta });
        break;
      }
      case "text.done":
        sink.sendJson({ type: "response.text.done", responseId });
        break;
      case "audio.start":
        setSpeaking(true);
        sink.sendJson({ type: "response.audio.start", responseId });
        break;
      case "audio.frame": {
        const data = event.payload as Uint8Array;
        log.debug("binary-sent", { responseId, bytes: data.length });
        sink.sendBinary(data);
        break;
      }
      case "audio.done":
        setSpeaking(false);
        sink.sendJson({ type: "response.audio.done", responseId });
        break;
    }
  }

  async function run(): Promise<void> {
    log.info("turn-start", { responseId, transcript });
    sink.sendJson({ type: "status.processing" });
    sink.sendJson({ type: "response.start", utteranceId: "server", responseId });

    const ttsProcessor = await ttsProcessorFactory();

    try {
      for await (const event of runVoiceTurn({
        transcript,
        history: [...history.messages()],
        contextAssembler,
        llmProvider,
        ttsProcessor,
        chatModel,
        language,
        ...(emotionTags ? { emotionTags } : {}),
        signal: controller.signal,
      })) {
        if (controller.signal.aborted) break;
        dispatchEvent(event);
      }
    } catch (error: unknown) {
      if (!controller.signal.aborted) {
        const message = error instanceof Error ? error.message : "Voice turn failed";
        log.error("turn-error", { responseId, message });
        sink.sendJson({ type: "error", code: "pipeline_error", message });
      }
    } finally {
      history.clearDraft();
      if (assistantText.trim()) {
        history.append("assistant", assistantText);
      }
      if (assistantSpeaking) {
        setSpeaking(false);
      }
      log.info("turn-end", { responseId, textLength: assistantText.length, aborted: controller.signal.aborted });
    }
  }

  // Wrap run() so settled() can return the promise
  function start(): Promise<void> {
    runPromise = run();
    return runPromise;
  }

  return {
    run: start,
    abort(): void {
      log.info("turn-abort", { responseId });
      controller.abort();
    },
    settled(): Promise<void> {
      return runPromise ?? Promise.resolve();
    },
    isAssistantSpeaking: () => assistantSpeaking,
  };
}
```

- [ ] **Step 3: Run the full test suite to check for breakage**

Run: `cd /Users/kevinye/Development/sentient && source scripts/env.sh && cd gateway && bun test --run`

The `ContinuousSession` tests may fail because they depend on the old `TurnController` interface (e.g., `handleTranscript`, `clientBargeIn`). That's expected — Task 5 will fix these. For now, note which tests break.

- [ ] **Step 4: Commit**

```bash
git add gateway/src/pipeline/turn-controller.ts
git commit -m "refactor(pipeline): simplify TurnController — remove barge-in logic, add settled()"
```

---

### Task 5: Refactor ContinuousSession

**Files:**
- Modify: `gateway/src/pipeline/continuous-session.ts`

This is the largest task. Replace the 8 mutable flags with the three new units. The session becomes a thin orchestrator.

- [ ] **Step 1: Read current ContinuousSession carefully**

Read `gateway/src/pipeline/continuous-session.ts` (527 lines). Note all the state that will be replaced:
- `isSpeechActive` → derived from `accumulator.hasSpeech()`
- `accumulatedText` → `TranscriptAccumulator`
- `deepgramVadActive` → track as a simple boolean (still needed for speech detection)
- `echoCooldownActive` + `echoCooldownTimer` → eliminated (BargeInController handles)
- Inline barge-in logic → `BargeInController`
- Inline abort sequence → `TurnTransition`

- [ ] **Step 2: Rewrite ContinuousSession**

Replace the full contents of `gateway/src/pipeline/continuous-session.ts`. The new version:

```typescript
// gateway/src/pipeline/continuous-session.ts
import type { ContextAssembler } from "../context/context-assembler.ts";
import type { SessionHistory } from "../context/session-history.ts";
import { getLog } from "../logging/logger.ts";
import type { LLMProvider } from "../providers/llm-provider.ts";
import type { STTConfig, STTProvider, TranscriptEvent } from "../providers/stt/stt-types.ts";
import type { TTSConnectionManager } from "../providers/tts/tts-connection.ts";
import { type BargeInController, type BargeInControllerOptions, createBargeInController } from "./barge-in-controller.ts";
import type { TTSProcessorFactory } from "./processors/tts-processor.ts";
import { createTranscriptAccumulator } from "./transcript-accumulator.ts";
import { type TurnController, createTurnController } from "./turn-controller.ts";
import { createTurnTransition } from "./turn-transition.ts";
import type { TurnSink } from "./turn-sink.ts";
import type { EmotionTagOptions } from "./voice-turn.ts";

const log = getLog(["sentient", "session"]);

// biome-ignore lint/suspicious/noExplicitAny: generic event handler signature
type AnyFn = (...args: any[]) => any;

interface TypedEmitter<Events extends { [K in keyof Events]: AnyFn }> {
  on<K extends keyof Events>(event: K, handler: Events[K]): () => void;
  emit<K extends keyof Events>(event: K, ...args: Parameters<Events[K]>): void;
  removeAll(): void;
}

function createEmitter<Events extends { [K in keyof Events]: AnyFn }>(): TypedEmitter<Events> {
  const handlers = new Map<keyof Events, Set<(...args: unknown[]) => void>>();
  return {
    on<K extends keyof Events>(event: K, handler: Events[K]): () => void {
      if (!handlers.has(event)) handlers.set(event, new Set());
      const set = handlers.get(event);
      if (!set) return () => {};
      set.add(handler as (...args: unknown[]) => void);
      return () => { set.delete(handler as (...args: unknown[]) => void); };
    },
    emit<K extends keyof Events>(event: K, ...args: Parameters<Events[K]>): void {
      const set = handlers.get(event);
      if (set) { for (const h of set) h(...args); }
    },
    removeAll(): void { handlers.clear(); },
  };
}

const DEFAULT_INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000;
const INACTIVITY_CHECK_INTERVAL_MS = 30_000;

const DEFAULT_BARGE_IN_OPTIONS: BargeInControllerOptions = {
  minInterruptionMs: 500,
  confidenceThreshold: 0.9,
  debounceCooldownMs: 300,
};

export interface ContinuousSessionOptions {
  sttProvider: STTProvider;
  sttConfig: STTConfig;
  ttsConnectionManager: TTSConnectionManager;
  history: SessionHistory;
  sink: TurnSink;
  contextAssembler: ContextAssembler;
  llmProvider: LLMProvider;
  ttsProcessorFactory: TTSProcessorFactory;
  chatModel: string;
  language: string;
  emotionTags?: EmotionTagOptions;
  inactivityTimeoutMs?: number;
  bargeInOptions?: BargeInControllerOptions;
}

export interface ContinuousSessionEvents {
  voiceDetected: () => void;
  transcriptPartial: (text: string) => void;
  transcriptFinal: (text: string) => void;
  speechStart: () => void;
  speechEnd: (text: string) => void;
  error: (message: string) => void;
}

export interface ContinuousSession {
  start(): Promise<void>;
  sendAudio(audio: Uint8Array): void;
  bargeIn(): void;
  close(): Promise<void>;
  isConnected(): boolean;
  on<K extends keyof ContinuousSessionEvents>(event: K, handler: ContinuousSessionEvents[K]): () => void;
}

export function createContinuousSession(options: ContinuousSessionOptions): ContinuousSession {
  const {
    sttProvider, sttConfig, ttsConnectionManager, history, sink,
    contextAssembler, llmProvider, ttsProcessorFactory, chatModel, language, emotionTags,
  } = options;
  const inactivityTimeoutMs = options.inactivityTimeoutMs ?? DEFAULT_INACTIVITY_TIMEOUT_MS;
  const emitter = createEmitter<ContinuousSessionEvents>();

  // -- Extracted units --
  const accumulator = createTranscriptAccumulator();
  const bargeInController = createBargeInController(options.bargeInOptions ?? DEFAULT_BARGE_IN_OPTIONS);
  const turnTransition = createTurnTransition();

  // -- Connection state (unchanged) --
  let isClosed = false;
  let sttConnected = false;
  let ttsConnected = false;
  let sessionController: AbortController | null = null;
  let earlyAudioBuffer: Uint8Array[] = [];
  let connectPromise: Promise<void> | null = null;

  // -- Inactivity state (unchanged) --
  let lastActivityAt = 0;
  let inactivityTimer: ReturnType<typeof setInterval> | null = null;
  let suspendPromise: Promise<void> | null = null;

  // -- Minimal speech state --
  let deepgramVadActive = false;
  let speechStartEmitted = false;

  // -- Turn state --
  let activeTurn: TurnController | null = null;

  // ---------------------------------------------------------------------------
  // Connection lifecycle (unchanged from original)
  // ---------------------------------------------------------------------------

  async function start(): Promise<void> {
    if (isClosed) return;
    if (suspendPromise) await suspendPromise;
    if (sttConnected && ttsConnected) return;
    if (connectPromise) { await connectPromise; return; }
    connectPromise = doConnect();
    await connectPromise;
    connectPromise = null;
  }

  async function doConnect(): Promise<void> {
    log.info("session-connect-start");
    sessionController = new AbortController();
    const signal = sessionController.signal;
    const results = await Promise.allSettled([sttProvider.connect(sttConfig, signal), ttsConnectionManager.connect()]);
    if (isClosed) { await sttProvider.disconnect(); ttsConnectionManager.dispose(); return; }
    const sttResult = results[0];
    const ttsResult = results[1];
    if (sttResult.status === "rejected" || ttsResult.status === "rejected") {
      if (sttResult.status === "fulfilled") await sttProvider.disconnect();
      if (ttsResult.status === "fulfilled") ttsConnectionManager.dispose();
      const rawError = sttResult.status === "rejected" ? sttResult.reason : (ttsResult as PromiseRejectedResult).reason;
      throw rawError instanceof Error ? rawError : new Error(String(rawError));
    }
    sttConnected = true;
    ttsConnected = true;
    lastActivityAt = Date.now();
    log.info("session-connected");
    for (const chunk of earlyAudioBuffer) { sttProvider.sendAudio(chunk); }
    earlyAudioBuffer = [];
    startTranscriptRelay(signal);
    startInactivityMonitor();
  }

  // ---------------------------------------------------------------------------
  // Inactivity monitoring (unchanged)
  // ---------------------------------------------------------------------------

  function startInactivityMonitor(): void {
    if (inactivityTimer || inactivityTimeoutMs <= 0) return;
    inactivityTimer = setInterval(checkInactivity, INACTIVITY_CHECK_INTERVAL_MS);
  }

  function stopInactivityMonitor(): void {
    if (inactivityTimer) { clearInterval(inactivityTimer); inactivityTimer = null; }
  }

  function checkInactivity(): void {
    if (isClosed || (!sttConnected && !ttsConnected)) return;
    if (activeTurn?.isAssistantSpeaking() || activeTurn) return;
    if (Date.now() - lastActivityAt >= inactivityTimeoutMs) suspendProviders();
  }

  function suspendProviders(): void {
    log.info("inactivity-suspend", { idleMs: Date.now() - lastActivityAt });
    sttConnected = false;
    ttsConnected = false;
    accumulator.reset();
    deepgramVadActive = false;
    speechStartEmitted = false;
    sessionController?.abort();
    suspendPromise = (async () => {
      try { await sttProvider.disconnect(); ttsConnectionManager.dispose(); }
      catch (err: unknown) { log.error("suspend-error", { message: err instanceof Error ? err.message : String(err) }); }
      finally { suspendPromise = null; }
    })();
  }

  // ---------------------------------------------------------------------------
  // Transcript relay
  // ---------------------------------------------------------------------------

  function startTranscriptRelay(signal: AbortSignal): void {
    (async () => {
      try {
        for await (const event of sttProvider.transcripts(signal)) {
          if (signal.aborted || isClosed) break;
          handleTranscriptEvent(event);
        }
      } catch {
        if (!isClosed) emitter.emit("error", "STT transcript stream ended unexpectedly");
      }
    })();
  }

  // ---------------------------------------------------------------------------
  // Turn lifecycle
  // ---------------------------------------------------------------------------

  function startTurnFromSpeech(): void {
    const transcript = accumulator.finalize();
    if (!transcript.trim()) return;

    deepgramVadActive = false;
    speechStartEmitted = false;

    history.append("user", transcript);
    history.clearDraft();
    log.info("speech-end", { text: transcript });
    emitter.emit("speechEnd", transcript);
    startTurn(transcript);
  }

  function startTurn(transcript: string): void {
    if (activeTurn) {
      log.warn("start-turn-while-active", { transcript });
      activeTurn.abort();
    }

    log.info("start-turn", { transcript });
    bargeInController.reset();

    const turn = createTurnController({
      transcript, history, sink, contextAssembler, llmProvider,
      ttsProcessorFactory, chatModel, language,
      ...(emotionTags ? { emotionTags } : {}),
      onSpeakingChanged: (speaking) => {
        if (speaking) {
          bargeInController.handle({ type: "assistant_started", timestampMs: Date.now() });
        } else {
          bargeInController.handle({ type: "assistant_ended", timestampMs: Date.now() });
        }
      },
    });

    activeTurn = turn;

    turn.run()
      .then(() => log.debug("turn-run-resolved", { transcript }))
      .catch((err: unknown) => log.error("turn-run-rejected", { transcript, message: err instanceof Error ? err.message : String(err) }))
      .finally(() => {
        if (activeTurn === turn) {
          activeTurn = null;
          bargeInController.handle({ type: "turn_completed" });
          log.debug("turn-cleared", { transcript });
        }
      });
  }

  // ---------------------------------------------------------------------------
  // Barge-in execution
  // ---------------------------------------------------------------------------

  async function executeBargeIn(bargeInText: string, speechFinal: boolean): Promise<void> {
    const turn = activeTurn;
    if (!turn) return;
    activeTurn = null;

    log.info("barge-in-execute", { bargeInText: bargeInText.slice(0, 50), speechFinal });

    await turnTransition.execute({ turn, ttsConnectionManager, sink });

    if (speechFinal && bargeInText.trim()) {
      accumulator.seed(bargeInText);
      startTurnFromSpeech();
    } else {
      accumulator.seed(bargeInText);
      deepgramVadActive = true;
      if (!speechStartEmitted) {
        speechStartEmitted = true;
        emitter.emit("speechStart");
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Transcript event handling (simplified)
  // ---------------------------------------------------------------------------

  function handleTranscriptEvent(event: TranscriptEvent): void {
    // Deepgram lifecycle events
    if (event.type === "speech_started") {
      deepgramVadActive = true;
      emitter.emit("voiceDetected");
      return;
    }

    if (event.type === "utterance_end") {
      log.debug("utterance-end", { hasSpeech: accumulator.hasSpeech() });
      if (accumulator.hasSpeech() && !activeTurn) {
        startTurnFromSpeech();
      }
      return;
    }

    if (event.type !== "transcript") return;

    // Accumulate transcript
    if (event.isFinal) {
      accumulator.appendFinal(event.text);
      emitter.emit("transcriptFinal", event.text);
    } else {
      accumulator.updatePartial(event.text);
      if (event.text.trim()) emitter.emit("transcriptPartial", event.text);
    }

    // Update draft for UI
    if (accumulator.hasSpeech()) {
      history.setDraft("user", accumulator.current());
    }

    // Emit speechStart on first real speech (when no turn active)
    if (!speechStartEmitted && deepgramVadActive && accumulator.hasSpeech() && !activeTurn) {
      speechStartEmitted = true;
      emitter.emit("speechStart");
    }

    // Barge-in check (only if turn is active)
    if (activeTurn) {
      const decision = bargeInController.handle({
        type: "transcript",
        text: event.text,
        isFinal: event.isFinal,
        confidence: event.confidence,
        speechFinal: event.speechFinal,
        timestampMs: Date.now(),
      });

      if (decision.action === "barge_in") {
        executeBargeIn(decision.text, decision.speechFinal);
      }
      return;
    }

    // No active turn — check if speech ended
    if (event.isFinal && event.speechFinal && accumulator.hasSpeech()) {
      startTurnFromSpeech();
    }
  }

  // ---------------------------------------------------------------------------
  // Client-initiated barge-in
  // ---------------------------------------------------------------------------

  function bargeIn(): void {
    if (!activeTurn) {
      log.debug("barge-in-no-active-turn");
      return;
    }

    const decision = bargeInController.handle({ type: "client_vad", timestampMs: Date.now() });
    if (decision.action === "barge_in") {
      executeBargeIn("", false);
    }
  }

  // ---------------------------------------------------------------------------
  // Audio routing (unchanged)
  // ---------------------------------------------------------------------------

  function sendAudio(audio: Uint8Array): void {
    lastActivityAt = Date.now();
    if (sttConnected) {
      sttProvider.sendAudio(audio);
    } else if (connectPromise) {
      earlyAudioBuffer.push(audio);
    } else if (!isClosed) {
      earlyAudioBuffer.push(audio);
      log.info("inactivity-resume");
      start().catch((err: unknown) => {
        log.error("reconnect-failed", { message: err instanceof Error ? err.message : String(err) });
        emitter.emit("error", "Failed to reconnect after inactivity");
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Cleanup
  // ---------------------------------------------------------------------------

  async function close(): Promise<void> {
    log.info("session-close");
    isClosed = true;
    stopInactivityMonitor();
    activeTurn?.abort();
    activeTurn = null;
    accumulator.reset();
    bargeInController.reset();
    sessionController?.abort();
    if (suspendPromise) await suspendPromise;
    if (sttConnected) { await sttProvider.disconnect(); sttConnected = false; }
    if (ttsConnected) { await ttsConnectionManager.close(); ttsConnected = false; }
    emitter.removeAll();
  }

  return {
    start, sendAudio, bargeIn, close,
    isConnected: () => sttConnected && ttsConnected,
    on: (event, handler) => emitter.on(event, handler),
  };
}
```

- [ ] **Step 3: Remove `onBargeIn` from TurnControllerOptions**

The `onBargeIn` callback is no longer used since ContinuousSession handles barge-in via `BargeInController` and `TurnTransition`. Also remove `ttsConnectionManager` from TurnControllerOptions since the session handles reconnect via TurnTransition.

In `gateway/src/pipeline/turn-controller.ts`, remove these from the options interface:
- `ttsConnectionManager: TTSConnectionManager`
- `onBargeIn?: (bargeInText: string, speechFinal: boolean) => void`

And update `createContinuousSession` to not pass them.

- [ ] **Step 4: Update handler and server to match new interfaces**

In `gateway/src/server/continuous-voice-handler.ts`, remove `handleTranscript` and `clientBargeIn` references if the handler was forwarding those. The `bargeIn()` method on ContinuousSession is still the same interface.

In `gateway/src/server/ws-server.ts`, verify the `barge_in` message handler calls `session.bargeIn()` correctly (should be unchanged).

- [ ] **Step 5: Run full test suite**

Run: `cd /Users/kevinye/Development/sentient && source scripts/env.sh && cd gateway && bun test --run`

Fix any failures. The main changes are:
- TurnController no longer has `handleTranscript()` or `clientBargeIn()` — tests referencing these must be updated
- ContinuousSession tests may need updating for the new barge-in flow

- [ ] **Step 6: Run lint and typecheck**

Run: `cd /Users/kevinye/Development/sentient && source scripts/env.sh && bun run lint && bun run typecheck`
Expected: Clean

- [ ] **Step 7: Commit**

```bash
git add gateway/src/pipeline/continuous-session.ts gateway/src/pipeline/turn-controller.ts gateway/src/server/continuous-voice-handler.ts gateway/src/server/ws-server.ts
git commit -m "refactor(pipeline): decompose ContinuousSession — use BargeInController, TranscriptAccumulator, TurnTransition"
```

---

### Task 6: Client-side playback hardening

**Files:**
- Modify: `shared/web-sdk/src/voice-client.ts`

Two fixes: (1) atomic playback rejection after barge-in.ack, (2) graceful VAD degradation.

- [ ] **Step 1: Read voice-client.ts**

Read `shared/web-sdk/src/voice-client.ts`. Focus on:
- Lines 276-285: binary message handler (`transport.on("binaryMessage", ...)`)
- Lines 218-227: barge-in handler
- Lines 77-82: VAD chain setup
- Lines 368-380: `startVoiceMode()`

- [ ] **Step 2: Add playback rejection flag**

In `voice-client.ts`, add a `playbackRejecting` flag:

```typescript
let playbackRejecting = false;
```

In the barge-in handler (around line 218-227), set the flag BEFORE clearing:

```typescript
// On barge_in.ack received:
playbackRejecting = true;  // reject all frames from now
playback.clear();
```

In the binary message handler (around line 276-285), check the flag:

```typescript
transport.on("binaryMessage", (data) => {
  if (playbackRejecting || !isPlaybackActive) return;  // drop frames after ack
  // ... existing PCM16→Float32 conversion
});
```

Reset the flag when a new turn starts (on `response.audio.start`):

```typescript
// In the response.audio.start handler:
playbackRejecting = false;
isPlaybackActive = true;
```

- [ ] **Step 3: Add graceful VAD degradation**

In the VAD chain setup (around line 77-82), wrap Silero init in a try/catch that falls back to energy-only:

```typescript
const sileroFilter = createSileroVadFilter();
let innerVadFilter: VadFilter;
try {
  await sileroFilter.init();
  innerVadFilter = config.vadPreFilter
    ? createChainedVadFilter(config.vadPreFilter, sileroFilter)
    : sileroFilter;
} catch {
  log.warn("silero-init-failed, falling back to energy-only VAD");
  innerVadFilter = config.vadPreFilter ?? createEnergyVadFilter();
}
const vadFilter: VadFilter = createTrailingVadFilter(innerVadFilter);
```

Note: this may require restructuring the `startVoiceMode()` function. Read the current code and adapt accordingly.

- [ ] **Step 4: Run web-sdk tests**

Run: `cd /Users/kevinye/Development/sentient && source scripts/env.sh && cd shared/web-sdk && bun test --run`
Expected: All pass

- [ ] **Step 5: Commit**

```bash
git add shared/web-sdk/src/voice-client.ts
git commit -m "fix(sdk): atomic playback rejection on barge-in, graceful VAD degradation"
```

---

### Task 7: Integration test

**Files:**
- Create: `gateway/src/pipeline/barge-in-integration.test.ts`

End-to-end test wiring all three new units together.

- [ ] **Step 1: Write the integration test**

```typescript
// gateway/src/pipeline/barge-in-integration.test.ts
import { describe, expect, it } from "vitest";
import { createBargeInController } from "./barge-in-controller.ts";
import { createTranscriptAccumulator } from "./transcript-accumulator.ts";
import { createTurnTransition } from "./turn-transition.ts";

describe("Barge-in integration", () => {
  it("full barge-in flow: accumulate → detect → transition → re-accumulate", async () => {
    const accumulator = createTranscriptAccumulator();
    const controller = createBargeInController({
      minInterruptionMs: 0,
      confidenceThreshold: 0.9,
      debounceCooldownMs: 0,
    });
    const transition = createTurnTransition();

    // User says something, turn starts
    accumulator.appendFinal("Tell me a story");
    const userText = accumulator.finalize();
    expect(userText).toBe("Tell me a story");

    // Assistant starts speaking
    controller.handle({ type: "assistant_started", timestampMs: 0 });

    // User interrupts
    const decision = controller.handle({
      type: "transcript",
      text: "Wait, actually",
      isFinal: true,
      confidence: 0.95,
      speechFinal: false,
      timestampMs: 100,
    });
    expect(decision.action).toBe("barge_in");

    // Execute transition
    let aborted = false;
    const mockTurn = {
      abort() { aborted = true; },
      settled() { return Promise.resolve(); },
    };
    const mockTts = { async reconnect() {} };
    const ackMessages: unknown[] = [];
    const mockSink = {
      sendJson(p: unknown) { ackMessages.push(p); },
      sendBinary(_d: Uint8Array) {},
    };

    await transition.execute({ turn: mockTurn, ttsConnectionManager: mockTts, sink: mockSink });

    expect(aborted).toBe(true);
    expect(ackMessages).toEqual([{ type: "barge_in.ack" }]);

    // Seed accumulator with barge-in text, user continues speaking
    accumulator.seed("Wait, actually");
    accumulator.appendFinal("tell me about dogs");
    const combined = accumulator.finalize();
    expect(combined).toBe("Wait, actually tell me about dogs");
  });

  it("rejects barge-in during no-interrupt window", () => {
    const controller = createBargeInController({
      minInterruptionMs: 500,
      confidenceThreshold: 0.9,
      debounceCooldownMs: 300,
    });

    controller.handle({ type: "assistant_started", timestampMs: 0 });

    // Too early — within 500ms window
    const decision = controller.handle({
      type: "transcript",
      text: "hello",
      isFinal: true,
      confidence: 0.95,
      speechFinal: false,
      timestampMs: 200,
    });
    expect(decision.action).toBe("none");

    // After window — accepted
    const decision2 = controller.handle({
      type: "transcript",
      text: "hello",
      isFinal: true,
      confidence: 0.95,
      speechFinal: false,
      timestampMs: 600,
    });
    expect(decision2.action).toBe("barge_in");
  });

  it("transcript accumulator preserves text across barge-in seed", () => {
    const acc = createTranscriptAccumulator();

    // First chunk of speech
    acc.appendFinal("I want to ask you");

    // Barge-in fires mid-speech — seed with barge-in text
    acc.seed("I want to ask you");

    // User continues
    acc.appendFinal("about the weather tomorrow");

    expect(acc.finalize()).toBe("I want to ask you I want to ask you about the weather tomorrow");
    // Note: deduplication is Deepgram's job — accumulator just appends
  });
});
```

- [ ] **Step 2: Run integration test**

Run: `cd /Users/kevinye/Development/sentient && source scripts/env.sh && cd gateway && bun test --run src/pipeline/barge-in-integration.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 3: Run full CI**

Run: `cd /Users/kevinye/Development/sentient && source scripts/env.sh && bun run ci`
Expected: All pass

- [ ] **Step 4: Commit**

```bash
git add gateway/src/pipeline/barge-in-integration.test.ts
git commit -m "test(pipeline): add barge-in integration test"
```
