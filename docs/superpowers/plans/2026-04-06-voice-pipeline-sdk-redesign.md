# Voice Pipeline SDK Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the push-to-talk voice pipeline with a continuous voice mode SDK (`@sentient/web-sdk`) that exposes a single `VoiceStatus` to developers, backed by three internal state machines and a composable gateway pipeline.

**Architecture:** Pure reducer state machines `(state, event) → (state, effects[])` at every layer. SDK orchestrates internal VAD + Error machines, exposes one public surface. Gateway receives clean audio segments with utterance start/end markers, processes through composable async generator stages. All validated by 11 PoCs in `docs/research/2026-04-06-voice-pipeline-sdk/poc/`.

**Tech Stack:** Bun runtime, TypeScript strict, Vitest, Preact (web), Zod (validation), Web Audio API + AudioWorklet

**Research output:** `docs/research/2026-04-06-voice-pipeline-sdk/` — PoC code is reference patterns to adapt to project conventions (Biome lint, existing test patterns, project structure rules). Read PoCs for the pattern, don't copy verbatim.

---

## File Structure

### Phase 1: SDK Foundation (`shared/web-sdk/`)

| File | Responsibility |
|------|---------------|
| `shared/web-sdk/package.json` | Package config, depends on `@sentient/protocol` |
| `shared/web-sdk/tsconfig.json` | TypeScript strict config |
| `shared/web-sdk/src/index.ts` | Public API exports |
| `shared/web-sdk/src/event-emitter.ts` | Typed event emitter utility |
| `shared/web-sdk/src/audio-codec.ts` | PCM16↔Float32 pure conversion |
| `shared/web-sdk/src/audio-capture-adapter.ts` | Platform adapter interface for mic |
| `shared/web-sdk/src/audio-playback-adapter.ts` | Platform adapter interface for speakers |
| `shared/web-sdk/src/voice-state-machine.ts` | 9-state pure reducer (public states) |
| `shared/web-sdk/src/vad-state-machine.ts` | 11-state pure reducer (internal) |
| `shared/web-sdk/src/error-classifier.ts` | Pure: raw error → user category |
| `shared/web-sdk/src/recovery-resolver.ts` | Pure: category → recovery strategy |
| `shared/web-sdk/src/error-state-machine.ts` | 7-state pure reducer (internal) |
| `shared/web-sdk/src/processing-timer.ts` | Staged indicators (2s/5s/15s/30s) |
| `shared/web-sdk/src/transcript-accumulator.ts` | Partial → final transcript buffering |
| `shared/web-sdk/src/message-store.ts` | Chat history with streaming support |
| `shared/web-sdk/src/transport.ts` | WebSocket connect/auth/reconnect/keepalive |
| `shared/web-sdk/src/voice-client.ts` | Orchestrator: wires all machines + adapters |

### Phase 2: Protocol + Codec (`shared/protocol/`, `shared/testing/`)

| File | Responsibility |
|------|---------------|
| `shared/protocol/src/messages.ts` | MODIFY: add utterance.*, status.processing, correlation IDs |
| `shared/testing/src/mock-stt-provider.ts` | MODIFY: add `emitEvent()`, `simulateDisconnect()` |
| `shared/testing/src/mock-tts-provider.ts` | MODIFY: add `failAfterChunks`, `stallAfterChunks` |
| `shared/testing/src/mock-llm-provider.ts` | NEW: configurable token stream + failure injection |
| `shared/testing/src/mock-transport.ts` | NEW: for SDK integration tests |
| `shared/testing/src/mock-audio-adapter.ts` | NEW: mock capture + playback adapters |

### Phase 3: Gateway Continuous Mode (`gateway/`)

| File | Responsibility |
|------|---------------|
| `gateway/src/pipeline/continuous-session.ts` | Event-driven session, relays partials, manages turns |
| `gateway/src/server/continuous-voice-handler.ts` | Thin WS→FlowManager bridge |
| `gateway/src/server/ws-server.ts` | MODIFY: route to new handler |
| `gateway/src/server/ws-helpers.ts` | MODIFY: update ClientData type |

### Phase 4: Web Client Migration (`web/`)

| File | Responsibility |
|------|---------------|
| `web/src/audio/capture-worklet.ts` | MODIFY: add VAD RMS energy detection |
| `web/src/adapters/web-audio-capture.ts` | Implements AudioCaptureAdapter |
| `web/src/adapters/web-audio-playback.ts` | Implements AudioPlaybackAdapter |
| `web/src/hooks/use-voice-client.ts` | Thin Preact bridge to SDK |
| `web/src/components/voice-mode-button.tsx` | Voice mode toggle UI |
| `web/src/components/live-transcript.tsx` | Partial transcript display |
| `web/src/app.tsx` | REWRITE: ~40 LOC using SDK |
| `web/src/components/chat-screen.tsx` | MODIFY: updated props |

### Phase 5: Cleanup

Delete: `web/src/hooks/use-websocket.ts`, `use-audio-capture.ts`, `use-audio-playback.ts`, `use-messages.ts` (all + tests), `web/src/components/toggle-talk-button.tsx` + test, `web/src/audio/pcm-decoder.ts`

---

## Phase 1: SDK Foundation

### Task 1: Package Scaffolding

**Files:**
- Create: `shared/web-sdk/package.json`
- Create: `shared/web-sdk/tsconfig.json`
- Create: `shared/web-sdk/src/index.ts`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "@sentient/web-sdk",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "dependencies": {
    "@sentient/protocol": "workspace:*"
  },
  "devDependencies": {
    "bun-types": "latest",
    "vitest": "^3.1.0"
  },
  "scripts": {
    "test": "vitest run",
    "test:unit": "vitest run",
    "typecheck": "tsc --noEmit"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "types": ["bun-types"],
    "paths": {
      "@sentient/protocol": ["../protocol/src/index.ts"]
    }
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Create empty index.ts**

```typescript
// @sentient/web-sdk — Public API
// Exports added as components are built.
```

- [ ] **Step 4: Install dependencies**

Run: `cd /Users/kevinye/Development/sentient && bun install`
Expected: `@sentient/web-sdk` linked in workspace

- [ ] **Step 5: Verify typecheck**

Run: `cd shared/web-sdk && bun run typecheck`
Expected: PASS (empty project, no errors)

- [ ] **Step 6: Commit**

```bash
git add shared/web-sdk/
git commit -m "chore(web-sdk): scaffold @sentient/web-sdk package"
```

---

### Task 2: Event Emitter

**Files:**
- Create: `shared/web-sdk/src/event-emitter.ts`
- Test: `shared/web-sdk/src/event-emitter.test.ts`

- [ ] **Step 1: Write the test**

```typescript
import { describe, it, expect, vi } from "vitest";
import { createEmitter } from "./event-emitter.ts";

interface TestEvents {
  hello: (name: string) => void;
  count: (n: number) => void;
}

describe("createEmitter", () => {
  it("calls handler when event is emitted", () => {
    const emitter = createEmitter<TestEvents>();
    const handler = vi.fn();
    emitter.on("hello", handler);
    emitter.emit("hello", "world");
    expect(handler).toHaveBeenCalledWith("world");
  });

  it("returns unsubscribe function", () => {
    const emitter = createEmitter<TestEvents>();
    const handler = vi.fn();
    const unsub = emitter.on("hello", handler);
    unsub();
    emitter.emit("hello", "world");
    expect(handler).not.toHaveBeenCalled();
  });

  it("supports multiple handlers per event", () => {
    const emitter = createEmitter<TestEvents>();
    const h1 = vi.fn();
    const h2 = vi.fn();
    emitter.on("hello", h1);
    emitter.on("hello", h2);
    emitter.emit("hello", "world");
    expect(h1).toHaveBeenCalledOnce();
    expect(h2).toHaveBeenCalledOnce();
  });

  it("removeAll clears all handlers", () => {
    const emitter = createEmitter<TestEvents>();
    const handler = vi.fn();
    emitter.on("hello", handler);
    emitter.on("count", vi.fn());
    emitter.removeAll();
    emitter.emit("hello", "world");
    expect(handler).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd shared/web-sdk && bunx vitest run src/event-emitter.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement event emitter**

```typescript
export interface TypedEmitter<Events extends Record<string, (...args: never[]) => void>> {
  on<K extends keyof Events>(event: K, handler: Events[K]): () => void;
  emit<K extends keyof Events>(event: K, ...args: Parameters<Events[K]>): void;
  removeAll(): void;
}

export function createEmitter<
  Events extends Record<string, (...args: never[]) => void>,
>(): TypedEmitter<Events> {
  const handlers = new Map<keyof Events, Set<(...args: unknown[]) => void>>();

  return {
    on<K extends keyof Events>(event: K, handler: Events[K]): () => void {
      if (!handlers.has(event)) handlers.set(event, new Set());
      const set = handlers.get(event)!;
      set.add(handler as (...args: unknown[]) => void);
      return () => set.delete(handler as (...args: unknown[]) => void);
    },

    emit<K extends keyof Events>(event: K, ...args: Parameters<Events[K]>): void {
      const set = handlers.get(event);
      if (set) for (const h of set) h(...args);
    },

    removeAll(): void {
      handlers.clear();
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd shared/web-sdk && bunx vitest run src/event-emitter.test.ts`
Expected: PASS — all 4 tests

- [ ] **Step 5: Export from index.ts**

Add to `shared/web-sdk/src/index.ts`:
```typescript
export { createEmitter, type TypedEmitter } from "./event-emitter.ts";
```

- [ ] **Step 6: Commit**

```bash
git add shared/web-sdk/src/event-emitter.ts shared/web-sdk/src/event-emitter.test.ts shared/web-sdk/src/index.ts
git commit -m "feat(web-sdk): add typed event emitter"
```

---

### Task 3: Audio Codec

**Files:**
- Create: `shared/web-sdk/src/audio-codec.ts`
- Test: `shared/web-sdk/src/audio-codec.test.ts`

- [ ] **Step 1: Write the test**

```typescript
import { describe, it, expect } from "vitest";
import { pcm16ToFloat32, float32ToPcm16 } from "./audio-codec.ts";

describe("audio-codec", () => {
  it("converts Float32 to PCM16 and back (roundtrip)", () => {
    const original = new Float32Array([0, 0.5, -0.5, 1.0, -1.0]);
    const pcm16 = float32ToPcm16(original);
    expect(pcm16).toBeInstanceOf(Uint8Array);
    expect(pcm16.byteLength).toBe(original.length * 2);

    const restored = pcm16ToFloat32(pcm16.buffer);
    // Allow ±1 LSB quantization error
    for (let i = 0; i < original.length; i++) {
      expect(restored[i]).toBeCloseTo(original[i]!, 2);
    }
  });

  it("pcm16ToFloat32 converts Int16 range to [-1, 1)", () => {
    const int16 = new Int16Array([0, 16384, -16384, 32767, -32768]);
    const result = pcm16ToFloat32(int16.buffer);
    expect(result[0]).toBeCloseTo(0, 5);
    expect(result[1]).toBeCloseTo(0.5, 2);
    expect(result[2]).toBeCloseTo(-0.5, 2);
    expect(result[3]).toBeCloseTo(1.0, 2);
    expect(result[4]).toBeCloseTo(-1.0, 2);
  });

  it("float32ToPcm16 clamps values outside [-1, 1]", () => {
    const input = new Float32Array([2.0, -2.0]);
    const pcm16 = float32ToPcm16(input);
    const view = new Int16Array(pcm16.buffer);
    expect(view[0]).toBe(32767);  // clamped to max
    expect(view[1]).toBe(-32768); // clamped to min
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd shared/web-sdk && bunx vitest run src/audio-codec.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement audio codec**

```typescript
const INT16_MAX = 0x7fff;
const INT16_MIN_MAGNITUDE = 0x8000;

/** Decode PCM16 (Int16 ArrayBuffer) to Float32 [-1.0, ~1.0) */
export function pcm16ToFloat32(buffer: ArrayBuffer): Float32Array {
  const int16 = new Int16Array(buffer);
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    float32[i] = (int16[i] ?? 0) / INT16_MIN_MAGNITUDE;
  }
  return float32;
}

/** Encode Float32 [-1.0, 1.0] to PCM16 (Uint8Array containing Int16 data) */
export function float32ToPcm16(samples: Float32Array): Uint8Array {
  const int16 = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    int16[i] = s < 0 ? s * INT16_MIN_MAGNITUDE : s * INT16_MAX;
  }
  return new Uint8Array(int16.buffer);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd shared/web-sdk && bunx vitest run src/audio-codec.test.ts`
Expected: PASS

- [ ] **Step 5: Export and commit**

Add to `index.ts`: `export { pcm16ToFloat32, float32ToPcm16 } from "./audio-codec.ts";`

```bash
git add shared/web-sdk/src/audio-codec.ts shared/web-sdk/src/audio-codec.test.ts shared/web-sdk/src/index.ts
git commit -m "feat(web-sdk): add PCM16↔Float32 audio codec"
```

---

### Task 4: Platform Adapter Interfaces

**Files:**
- Create: `shared/web-sdk/src/audio-capture-adapter.ts`
- Create: `shared/web-sdk/src/audio-playback-adapter.ts`

No tests — interfaces only.

- [ ] **Step 1: Create capture adapter interface**

```typescript
/** Platform-specific audio capture (mic). Implemented per platform (web, mobile). */
export interface AudioCaptureAdapter {
  /** Request mic permissions and start capturing. */
  start(): Promise<void>;
  /** Stop capturing and release mic. */
  stop(): void;
  /** Register handler for PCM16 audio chunks. Returns unsubscribe. */
  onAudioData(handler: (data: ArrayBuffer) => void): () => void;
  /** Register handler for VAD speech detection events. Returns unsubscribe. */
  onVadEvent(handler: (speaking: boolean) => void): () => void;
  /** Register handler for errors. Returns unsubscribe. */
  onError(handler: (message: string) => void): () => void;
}
```

- [ ] **Step 2: Create playback adapter interface**

```typescript
/** Platform-specific audio playback (speakers). Implemented per platform. */
export interface AudioPlaybackAdapter {
  /** Initialize audio output (may require user gesture on web). */
  init(): Promise<boolean>;
  /** Enqueue Float32 audio samples for playback. */
  enqueue(samples: Float32Array): void;
  /** Clear all queued audio (for barge-in). */
  clear(): void;
  /** Release audio resources. */
  destroy(): void;
  /** Register handler for playback state changes. Returns unsubscribe. */
  onStateChange(handler: (playing: boolean) => void): () => void;
}
```

- [ ] **Step 3: Export and commit**

Add to `index.ts`:
```typescript
export type { AudioCaptureAdapter } from "./audio-capture-adapter.ts";
export type { AudioPlaybackAdapter } from "./audio-playback-adapter.ts";
```

```bash
git add shared/web-sdk/src/audio-capture-adapter.ts shared/web-sdk/src/audio-playback-adapter.ts shared/web-sdk/src/index.ts
git commit -m "feat(web-sdk): add audio capture and playback adapter interfaces"
```

---

### Task 5: Voice State Machine

**Files:**
- Create: `shared/web-sdk/src/voice-state-machine.ts`
- Test: `shared/web-sdk/src/voice-state-machine.test.ts`

**PoC reference:** Read `docs/research/2026-04-06-voice-pipeline-sdk/poc/sdk-state-machine-consumer-api/state-machine.ts` for the complete transition table and types. Adapt to project conventions. The PoC has 395 LOC with the full `transition()` function, `VoiceStatus`, status labels, and `VoiceClient` runtime wrapper.

**PoC test reference:** Read `docs/research/2026-04-06-voice-pipeline-sdk/poc/sdk-state-machine-test-harness/state-machine.test.ts` for exhaustive test patterns including `walk()` helper, reachability checks, and timeout guard verification. The PoC has 882 LOC of tests with 57+ assertions.

- [ ] **Step 1: Write core test cases**

Create `shared/web-sdk/src/voice-state-machine.test.ts`. Key tests to include (adapt from PoC test harness):

```typescript
import { describe, it, expect } from "vitest";
import { transition, type VoiceState, type VoiceEvent } from "./voice-state-machine.ts";

/** Walk a sequence of events from a start state, return final state */
function walk(start: VoiceState, events: VoiceEvent[]): VoiceState {
  let state = start;
  for (const event of events) {
    state = transition(state, event).state;
  }
  return state;
}

describe("voice-state-machine", () => {
  describe("happy path", () => {
    it("walks full voice turn: connect → speak → process → respond → listen", () => {
      const result = walk("inactive", [
        { type: "CONNECT" },
        { type: "AUTH_OK", sessionId: "s1" },
        { type: "SPEECH_START" },
        { type: "SPEECH_END" },
        { type: "RESPONSE_START" },
        { type: "AUDIO_DONE" },
      ]);
      expect(result).toBe("listening");
    });
  });

  describe("barge-in", () => {
    it("interrupts assistant speech on SPEECH_START", () => {
      const result = transition("assistant-speaking", { type: "SPEECH_START" });
      expect(result.state).toBe("interrupting");
      expect(result.effects).toContainEqual({ type: "SEND_BARGE_IN" });
      expect(result.effects).toContainEqual({ type: "CLEAR_PLAYBACK" });
    });

    it("returns to user-speaking after BARGE_IN_ACK", () => {
      const result = transition("interrupting", { type: "BARGE_IN_ACK" });
      expect(result.state).toBe("user-speaking");
      expect(result.effects).toContainEqual({ type: "SEND_UTTERANCE_START" });
    });

    it("falls back to listening on barge-in timeout", () => {
      const result = transition("interrupting", { type: "TIMEOUT", context: "barge_in_ack" });
      expect(result.state).toBe("listening");
    });
  });

  describe("timeout guards", () => {
    it("connecting has auth timeout", () => {
      const result = transition("inactive", { type: "CONNECT" });
      expect(result.effects).toContainEqual({ type: "START_TIMEOUT", key: "auth", ms: 10_000 });
    });

    it("processing has 30s timeout", () => {
      const result = transition("user-speaking", { type: "SPEECH_END" });
      expect(result.effects).toContainEqual({ type: "START_TIMEOUT", key: "processing", ms: 30_000 });
    });

    it("processing timeout goes to error", () => {
      const result = transition("processing", { type: "TIMEOUT", context: "processing" });
      expect(result.state).toBe("error");
    });
  });

  describe("reconnection", () => {
    it("WS_DROP from listening goes to reconnecting", () => {
      const result = transition("listening", { type: "WS_DROP" });
      expect(result.state).toBe("reconnecting");
    });

    it("RECONNECTED returns to listening", () => {
      const result = transition("reconnecting", { type: "RECONNECTED" });
      expect(result.state).toBe("listening");
    });

    it("MAX_RETRIES goes to error", () => {
      const result = transition("reconnecting", { type: "MAX_RETRIES" });
      expect(result.state).toBe("error");
    });
  });

  describe("error recovery", () => {
    it("RETRY from error goes to connecting", () => {
      const result = transition("error", { type: "RETRY" });
      expect(result.state).toBe("connecting");
    });

    it("DISMISS from error goes to inactive", () => {
      const result = transition("error", { type: "DISMISS" });
      expect(result.state).toBe("inactive");
    });
  });

  describe("global events", () => {
    it("SESSION_END from any state goes to inactive", () => {
      const states: VoiceState[] = [
        "connecting", "listening", "user-speaking", "processing",
        "assistant-speaking", "interrupting", "reconnecting", "error",
      ];
      for (const state of states) {
        const result = transition(state, { type: "SESSION_END" });
        expect(result.state).toBe("inactive");
      }
    });
  });

  describe("unhandled events", () => {
    it("produces LOG_WARNING and no state change", () => {
      const result = transition("listening", { type: "AUTH_OK", sessionId: "s1" });
      expect(result.state).toBe("listening");
      expect(result.effects[0]?.type).toBe("LOG_WARNING");
    });
  });

  describe("exhaustiveness", () => {
    it("every state is reachable from inactive", () => {
      const ALL_STATES: VoiceState[] = [
        "inactive", "connecting", "listening", "user-speaking",
        "processing", "assistant-speaking", "interrupting",
        "reconnecting", "error",
      ];
      const reachable = new Set<VoiceState>(["inactive"]);
      // BFS: try all events from each reachable state
      const ALL_EVENTS: VoiceEvent[] = [
        { type: "CONNECT" }, { type: "AUTH_OK", sessionId: "s" },
        { type: "AUTH_FAILED", reason: "r" }, { type: "TIMEOUT", context: "auth" },
        { type: "SPEECH_START" }, { type: "SPEECH_END" }, { type: "CANCEL" },
        { type: "RESPONSE_START" }, { type: "AUDIO_DONE" },
        { type: "RESPONSE_TEXT_DONE" }, { type: "BARGE_IN_ACK" },
        { type: "WS_DROP" }, { type: "RECONNECTED" }, { type: "MAX_RETRIES" },
        { type: "RETRY" }, { type: "DISMISS" }, { type: "DISCONNECT" },
        { type: "TIMEOUT", context: "processing" },
        { type: "TIMEOUT", context: "barge_in_ack" },
      ];
      let changed = true;
      while (changed) {
        changed = false;
        for (const state of reachable) {
          for (const event of ALL_EVENTS) {
            const next = transition(state, event).state;
            if (!reachable.has(next)) {
              reachable.add(next);
              changed = true;
            }
          }
        }
      }
      for (const state of ALL_STATES) {
        expect(reachable.has(state), `${state} should be reachable`).toBe(true);
      }
    });

    it("no state is a dead end (except inactive)", () => {
      const ALL_STATES: VoiceState[] = [
        "connecting", "listening", "user-speaking", "processing",
        "assistant-speaking", "interrupting", "reconnecting", "error",
      ];
      for (const state of ALL_STATES) {
        // SESSION_END always works from non-inactive states
        const result = transition(state, { type: "SESSION_END" });
        expect(result.state).toBe("inactive");
      }
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd shared/web-sdk && bunx vitest run src/voice-state-machine.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement voice state machine**

Create `shared/web-sdk/src/voice-state-machine.ts`. Adapt the complete transition function from the PoC at `docs/research/2026-04-06-voice-pipeline-sdk/poc/sdk-state-machine-consumer-api/state-machine.ts`. The PoC contains the exact types (`VoiceState`, `VoiceEvent`, `SideEffect`, `TransitionResult`, `VoiceStatus`), the full `transition()` function with all state/event combinations, status labels, and the `VoiceClient` runtime wrapper class.

Key adaptations from PoC to production:
- Keep the same type names and transition logic — they are validated
- Add the `VoiceClient` runtime wrapper from the PoC (lines 324-394)
- Ensure `STATUS_LABELS` and `SPEAKABLE_STATES` match the spec's "Listening...", "Hearing you...", "Thinking...", "Speaking...", etc.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd shared/web-sdk && bunx vitest run src/voice-state-machine.test.ts`
Expected: PASS — all tests

- [ ] **Step 5: Export and commit**

Add to `index.ts`:
```typescript
export {
  transition as voiceTransition,
  VoiceClient,
  type VoiceState,
  type VoiceEvent,
  type SideEffect,
  type TransitionResult,
  type VoiceStatus,
} from "./voice-state-machine.ts";
```

```bash
git add shared/web-sdk/src/voice-state-machine.ts shared/web-sdk/src/voice-state-machine.test.ts shared/web-sdk/src/index.ts
git commit -m "feat(web-sdk): add 9-state voice state machine with pure reducer"
```

---

### Task 6: VAD State Machine

**Files:**
- Create: `shared/web-sdk/src/vad-state-machine.ts`
- Test: `shared/web-sdk/src/vad-state-machine.test.ts`

**PoC reference:** Read `docs/research/2026-04-06-voice-pipeline-sdk/poc/client-vad-state-table/vad-state-machine.ts` for the complete 11-state transition table (575 LOC) with mode-aware guards (vad/ptt/continuous), onset debounce (32ms), trailing silence (700ms), and barge-in confirmation (300ms).

**PoC test reference:** Read `docs/research/2026-04-06-voice-pipeline-sdk/poc/client-vad-state-table/vad-state-machine.test.ts` for exhaustive tests (507 LOC).

- [ ] **Step 1: Write core test cases**

Key tests to include: mic permission flow, onset debounce (speech-detected → 32ms → user-speaking), false alarm (speech-detected + silence → listening), trailing silence (700ms → SPEECH_END), barge-in during assistant-speaking, mode switching (VAD/PTT/continuous produce same output events), DISPOSE from any state → disposed.

Pattern: same `walk()` helper, same exhaustiveness checks as Task 5. Adapt from PoC test file.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd shared/web-sdk && bunx vitest run src/vad-state-machine.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement VAD state machine**

Adapt from PoC at `docs/research/2026-04-06-voice-pipeline-sdk/poc/client-vad-state-table/vad-state-machine.ts`. Key types:

```typescript
export type VadState =
  | "inactive" | "requesting-mic" | "listening" | "speech-detected"
  | "user-speaking" | "trailing-silence" | "processing"
  | "assistant-speaking" | "interrupting" | "error" | "disposed";

export type DetectionMode = "vad" | "ptt" | "continuous";

export type VadEvent =
  | { type: "START"; mode: DetectionMode }
  | { type: "STOP" }
  | { type: "MIC_GRANTED" }
  | { type: "MIC_DENIED"; reason: string }
  | { type: "SPEECH_DETECTED" }
  | { type: "SPEECH_CONFIRMED" }
  | { type: "SILENCE_DETECTED" }
  | { type: "SILENCE_TIMEOUT" }
  | { type: "PTT_PRESS" }
  | { type: "PTT_RELEASE" }
  | { type: "RESPONSE_START" }
  | { type: "RESPONSE_DONE" }
  | { type: "BARGE_IN_ACK" }
  | { type: "TIMEOUT"; context: string }
  | { type: "RECOVER" }
  | { type: "DISPOSE" };

export type VadEffect =
  | { type: "REQUEST_MIC" }
  | { type: "START_CAPTURE" }
  | { type: "STOP_CAPTURE" }
  | { type: "SEND_SPEECH_START" }   // → feeds into Voice state machine
  | { type: "SEND_SPEECH_END" }     // → feeds into Voice state machine
  | { type: "START_TIMER"; key: string; ms: number }
  | { type: "CANCEL_TIMER"; key: string }
  | { type: "CLEAR_PLAYBACK" }
  | { type: "SEND_BARGE_IN" }
  | { type: "RELEASE_MIC" }
  | { type: "EMIT_STATE" }
  | { type: "EMIT_ERROR"; message: string };
```

The transition function follows the same pure pattern: `(state, context, event) → { state, context, effects[] }`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd shared/web-sdk && bunx vitest run src/vad-state-machine.test.ts`
Expected: PASS

- [ ] **Step 5: Commit (internal — not exported from index.ts)**

```bash
git add shared/web-sdk/src/vad-state-machine.ts shared/web-sdk/src/vad-state-machine.test.ts
git commit -m "feat(web-sdk): add 11-state VAD state machine with onset debounce and trailing silence"
```

---

### Task 7: Error Classifier + Recovery Resolver

**Files:**
- Create: `shared/web-sdk/src/error-classifier.ts`
- Create: `shared/web-sdk/src/recovery-resolver.ts`
- Test: `shared/web-sdk/src/error-classifier.test.ts`
- Test: `shared/web-sdk/src/recovery-resolver.test.ts`

**PoC reference:** Read `docs/research/2026-04-06-voice-pipeline-sdk/poc/error-ux-consumer-api/src/` — contains `error-classifier.ts` (37 LOC), `pipeline-error.ts` (32 LOC), `recovery-resolver.ts` (21 LOC), `user-messages.ts` (16 LOC). These are production-ready pure functions. Adapt to project conventions.

- [ ] **Step 1: Write classifier test**

```typescript
import { describe, it, expect } from "vitest";
import { classifyError, type PipelineError } from "./error-classifier.ts";

describe("classifyError", () => {
  it("classifies auth errors as auth_required", () => {
    const err: PipelineError = { source: "auth", phase: "connecting", severity: "fatal", message: "expired" };
    expect(classifyError(err)).toBe("auth_required");
  });

  it("classifies network errors as connection_lost", () => {
    const err: PipelineError = { source: "network", phase: "streaming", severity: "degraded", message: "ws closed" };
    expect(classifyError(err)).toBe("connection_lost");
  });

  it("classifies STT streaming errors as didnt_catch", () => {
    const err: PipelineError = { source: "stt", phase: "streaming", severity: "degraded", message: "stt failed" };
    expect(classifyError(err)).toBe("didnt_catch");
  });

  it("classifies LLM streaming errors as thinking_timeout", () => {
    const err: PipelineError = { source: "llm", phase: "streaming", severity: "degraded", message: "llm timeout" };
    expect(classifyError(err)).toBe("thinking_timeout");
  });

  it("classifies LLM connecting errors as service_unavailable", () => {
    const err: PipelineError = { source: "llm", phase: "connecting", severity: "recoverable", message: "connect failed" };
    expect(classifyError(err)).toBe("service_unavailable");
  });

  it("classifies TTS errors as try_again", () => {
    const err: PipelineError = { source: "tts", phase: "streaming", severity: "degraded", message: "tts failed" };
    expect(classifyError(err)).toBe("try_again");
  });

  it("never returns undefined (catch-all)", () => {
    const err: PipelineError = { source: "protocol", phase: "idle", severity: "recoverable", message: "unknown" };
    expect(classifyError(err)).toBe("try_again");
  });
});
```

- [ ] **Step 2: Write resolver test**

```typescript
import { describe, it, expect } from "vitest";
import { resolveRecovery } from "./recovery-resolver.ts";

describe("resolveRecovery", () => {
  it("connection_lost → auto_reconnect", () => {
    expect(resolveRecovery("connection_lost").type).toBe("auto_reconnect");
  });
  it("didnt_catch → reset_to_listening", () => {
    expect(resolveRecovery("didnt_catch").type).toBe("reset_to_listening");
  });
  it("thinking_timeout → retry_once", () => {
    expect(resolveRecovery("thinking_timeout").type).toBe("retry_once");
  });
  it("service_unavailable → wait_and_retry", () => {
    expect(resolveRecovery("service_unavailable").type).toBe("wait_and_retry");
  });
  it("auth_required → require_auth", () => {
    expect(resolveRecovery("auth_required").type).toBe("require_auth");
  });
  it("try_again → prompt_retry", () => {
    expect(resolveRecovery("try_again").type).toBe("prompt_retry");
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd shared/web-sdk && bunx vitest run src/error-classifier.test.ts src/recovery-resolver.test.ts`
Expected: FAIL

- [ ] **Step 4: Implement both files**

Adapt the exact code from the PoC files at `docs/research/2026-04-06-voice-pipeline-sdk/poc/error-ux-consumer-api/src/`. The classifier, resolver, pipeline-error types, and user-messages are all <40 LOC pure functions. Combine `pipeline-error.ts` types into `error-classifier.ts` and `user-messages.ts` into `recovery-resolver.ts` to keep 1 module per file.

The `error-classifier.ts` should export: `PipelineError`, `ErrorSource`, `ErrorPhase`, `ErrorSeverity`, `UserErrorCategory`, `classifyError()`, `pipelineError()`.

The `recovery-resolver.ts` should export: `RecoveryAction`, `resolveRecovery()`, `friendlyMessage()`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd shared/web-sdk && bunx vitest run src/error-classifier.test.ts src/recovery-resolver.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add shared/web-sdk/src/error-classifier.ts shared/web-sdk/src/error-classifier.test.ts shared/web-sdk/src/recovery-resolver.ts shared/web-sdk/src/recovery-resolver.test.ts
git commit -m "feat(web-sdk): add error classifier and recovery resolver"
```

---

### Task 8: Error State Machine

**Files:**
- Create: `shared/web-sdk/src/error-state-machine.ts`
- Test: `shared/web-sdk/src/error-state-machine.test.ts`

**PoC reference:** Read `docs/research/2026-04-06-voice-pipeline-sdk/poc/error-ux-state-table/src/error-ux-states.ts` for the 7-state transition table and `test/error-ux-states.test.ts` for tests.

- [ ] **Step 1: Write test**

Key tests: error detection → classification → notification → auto-recovery → success/failure, retry budget (max 2), escalation flow, recovery timeout, new error during recovery restarts classification.

```typescript
import { describe, it, expect } from "vitest";
import { errorTransition, type ErrorUXState, type ErrorUXEvent } from "./error-state-machine.ts";

describe("error-state-machine", () => {
  it("classifies and notifies on error", () => {
    const result = errorTransition("nominal", {
      type: "ERROR_OCCURRED",
      error: { source: "network", phase: "streaming", severity: "degraded", message: "ws closed" },
    });
    expect(result.state).toBe("user-notified");
    expect(result.effects).toContainEqual(expect.objectContaining({ type: "SHOW_MESSAGE" }));
  });

  it("auto-recovers for connection_lost", () => {
    const r1 = errorTransition("nominal", {
      type: "ERROR_OCCURRED",
      error: { source: "network", phase: "streaming", severity: "degraded", message: "ws closed" },
    });
    // Should include auto-recovery effect
    expect(r1.effects).toContainEqual(expect.objectContaining({ type: "ATTEMPT_RECOVERY" }));
  });

  it("escalates after max retries", () => {
    let state: ErrorUXState = "auto-recovering";
    const r1 = errorTransition(state, { type: "RECOVERY_FAILED" }, { attempts: 1 });
    // Still retrying
    const r2 = errorTransition(r1.state, { type: "RECOVERY_FAILED" }, { attempts: 2 });
    expect(r2.state).toBe("escalated");
  });

  it("returns to nominal on success", () => {
    const result = errorTransition("auto-recovering", { type: "RECOVERY_SUCCEEDED" });
    expect(result.state).toBe("nominal");
  });
});
```

- [ ] **Step 2: Run test to verify it fails, implement, verify it passes**

Adapt from PoC at `docs/research/2026-04-06-voice-pipeline-sdk/poc/error-ux-state-table/src/error-ux-states.ts`. Key: the state machine uses `classifyError()` and `resolveRecovery()` from Task 7 internally.

- [ ] **Step 3: Commit**

```bash
git add shared/web-sdk/src/error-state-machine.ts shared/web-sdk/src/error-state-machine.test.ts
git commit -m "feat(web-sdk): add 7-state error UX state machine with recovery flow"
```

---

### Task 9: Processing Timer

**Files:**
- Create: `shared/web-sdk/src/processing-timer.ts`
- Test: `shared/web-sdk/src/processing-timer.test.ts`

**PoC reference:** Read `docs/research/2026-04-06-voice-pipeline-sdk/poc/error-ux-consumer-api/src/processing-timer.ts` (37 LOC) — production-ready.

- [ ] **Step 1: Write test**

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createProcessingTimer, type ProcessingStage } from "./processing-timer.ts";

describe("createProcessingTimer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("emits thinking at 2s", () => {
    const handler = vi.fn();
    createProcessingTimer(handler);
    vi.advanceTimersByTime(2000);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ stage: "thinking" }));
  });

  it("emits still_thinking at 5s", () => {
    const handler = vi.fn();
    createProcessingTimer(handler);
    vi.advanceTimersByTime(5000);
    const calls = handler.mock.calls.map((c) => (c[0] as { stage: ProcessingStage }).stage);
    expect(calls).toContain("still_thinking");
  });

  it("emits timeout at 30s", () => {
    const handler = vi.fn();
    createProcessingTimer(handler);
    vi.advanceTimersByTime(30000);
    const calls = handler.mock.calls.map((c) => (c[0] as { stage: ProcessingStage }).stage);
    expect(calls).toContain("timeout");
  });

  it("cancel stops all timers", () => {
    const handler = vi.fn();
    const timer = createProcessingTimer(handler);
    timer.cancel();
    vi.advanceTimersByTime(30000);
    // Only the immediate "silent" stage at 0ms may have fired
    const stages = handler.mock.calls.map((c) => (c[0] as { stage: ProcessingStage }).stage);
    expect(stages).not.toContain("thinking");
  });
});
```

- [ ] **Step 2: Run test, implement (adapt from PoC), verify, commit**

Adapt from PoC. Stages: 0ms silent, 2000ms thinking, 5000ms still_thinking, 15000ms taking_long, 30000ms timeout.

```bash
git add shared/web-sdk/src/processing-timer.ts shared/web-sdk/src/processing-timer.test.ts
git commit -m "feat(web-sdk): add staged processing timer (2s/5s/15s/30s)"
```

---

### Task 10: Transcript Accumulator

**Files:**
- Create: `shared/web-sdk/src/transcript-accumulator.ts`
- Test: `shared/web-sdk/src/transcript-accumulator.test.ts`

- [ ] **Step 1: Write test**

```typescript
import { describe, it, expect, vi } from "vitest";
import { createTranscriptAccumulator } from "./transcript-accumulator.ts";

describe("createTranscriptAccumulator", () => {
  it("updatePartial stores current text", () => {
    const acc = createTranscriptAccumulator();
    acc.updatePartial("hello w");
    expect(acc.current()).toBe("hello w");
    expect(acc.isFinal()).toBe(false);
  });

  it("finalize returns full text and marks final", () => {
    const acc = createTranscriptAccumulator();
    acc.updatePartial("hello w");
    const result = acc.finalize("hello world");
    expect(result).toBe("hello world");
    expect(acc.isFinal()).toBe(true);
  });

  it("reset clears state", () => {
    const acc = createTranscriptAccumulator();
    acc.updatePartial("hello");
    acc.reset();
    expect(acc.current()).toBe("");
    expect(acc.isFinal()).toBe(false);
  });

  it("onChange fires on partial and final", () => {
    const acc = createTranscriptAccumulator();
    const handler = vi.fn();
    acc.onChange(handler);
    acc.updatePartial("hi");
    expect(handler).toHaveBeenCalledWith("hi", false);
    acc.finalize("hi there");
    expect(handler).toHaveBeenCalledWith("hi there", true);
  });
});
```

- [ ] **Step 2: Implement**

```typescript
export interface TranscriptAccumulator {
  updatePartial(text: string): void;
  finalize(text: string): string;
  current(): string;
  isFinal(): boolean;
  reset(): void;
  onChange(handler: (text: string, isFinal: boolean) => void): () => void;
}

export function createTranscriptAccumulator(): TranscriptAccumulator {
  let text = "";
  let final = false;
  const handlers = new Set<(text: string, isFinal: boolean) => void>();

  function notify() {
    for (const h of handlers) h(text, final);
  }

  return {
    updatePartial(t: string) {
      text = t;
      final = false;
      notify();
    },
    finalize(t: string): string {
      text = t;
      final = true;
      notify();
      return text;
    },
    current: () => text,
    isFinal: () => final,
    reset() {
      text = "";
      final = false;
    },
    onChange(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  };
}
```

- [ ] **Step 3: Run tests, commit**

```bash
git add shared/web-sdk/src/transcript-accumulator.ts shared/web-sdk/src/transcript-accumulator.test.ts
git commit -m "feat(web-sdk): add transcript accumulator for partial→final buffering"
```

---

### Task 11: Message Store

**Files:**
- Create: `shared/web-sdk/src/message-store.ts`
- Test: `shared/web-sdk/src/message-store.test.ts`

- [ ] **Step 1: Write test**

```typescript
import { describe, it, expect, vi } from "vitest";
import { createMessageStore } from "./message-store.ts";

describe("createMessageStore", () => {
  it("adds user messages", () => {
    const store = createMessageStore();
    store.addUserMessage("hello");
    expect(store.messages()).toHaveLength(1);
    expect(store.messages()[0]?.role).toBe("user");
    expect(store.messages()[0]?.text).toBe("hello");
  });

  it("streams assistant messages", () => {
    const store = createMessageStore();
    const id = store.startAssistantStream();
    store.appendToStream(id, "The ");
    store.appendToStream(id, "weather");
    expect(store.messages()).toHaveLength(1);
    expect(store.messages()[0]?.text).toBe("The weather");
    expect(store.messages()[0]?.isStreaming).toBe(true);
  });

  it("finalizes stream", () => {
    const store = createMessageStore();
    const id = store.startAssistantStream();
    store.appendToStream(id, "hello");
    store.finalizeStream(id);
    expect(store.messages()[0]?.isStreaming).toBe(false);
  });

  it("trims to maxMessages", () => {
    const store = createMessageStore({ maxMessages: 3 });
    store.addUserMessage("1");
    store.addUserMessage("2");
    store.addUserMessage("3");
    store.addUserMessage("4");
    expect(store.messages()).toHaveLength(3);
  });

  it("onChange fires on mutations", () => {
    const store = createMessageStore();
    const handler = vi.fn();
    store.onChange(handler);
    store.addUserMessage("hi");
    expect(handler).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Implement**

```typescript
export interface ChatMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly timestamp: number;
  readonly isStreaming: boolean;
}

export interface MessageStore {
  messages(): readonly ChatMessage[];
  addUserMessage(text: string): void;
  startAssistantStream(): string;
  appendToStream(id: string, text: string): void;
  finalizeStream(id: string): void;
  clear(): void;
  onChange(handler: (messages: readonly ChatMessage[]) => void): () => void;
}

export function createMessageStore(options?: { maxMessages?: number }): MessageStore {
  const maxMessages = options?.maxMessages ?? 200;
  let msgs: ChatMessage[] = [];
  let counter = 0;
  const handlers = new Set<(messages: readonly ChatMessage[]) => void>();

  function notify() {
    const snapshot = [...msgs];
    for (const h of handlers) h(snapshot);
  }

  function trim() {
    if (msgs.length > maxMessages) {
      msgs = msgs.slice(msgs.length - maxMessages);
    }
  }

  return {
    messages: () => [...msgs],
    addUserMessage(text: string) {
      msgs.push({ id: `msg-${++counter}`, role: "user", text, timestamp: Date.now(), isStreaming: false });
      trim();
      notify();
    },
    startAssistantStream(): string {
      const id = `msg-${++counter}`;
      msgs.push({ id, role: "assistant", text: "", timestamp: Date.now(), isStreaming: true });
      notify();
      return id;
    },
    appendToStream(id: string, text: string) {
      const idx = msgs.findIndex((m) => m.id === id);
      if (idx === -1) return;
      const msg = msgs[idx]!;
      msgs[idx] = { ...msg, text: msg.text + text };
      notify();
    },
    finalizeStream(id: string) {
      const idx = msgs.findIndex((m) => m.id === id);
      if (idx === -1) return;
      msgs[idx] = { ...msgs[idx]!, isStreaming: false };
      notify();
    },
    clear() {
      msgs = [];
      notify();
    },
    onChange(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  };
}
```

- [ ] **Step 3: Run tests, commit**

```bash
git add shared/web-sdk/src/message-store.ts shared/web-sdk/src/message-store.test.ts
git commit -m "feat(web-sdk): add message store with streaming support"
```

---

### Task 12: Transport Layer

**Files:**
- Create: `shared/web-sdk/src/transport.ts`
- Test: `shared/web-sdk/src/transport.test.ts`

**Reference:** Extract from `web/src/hooks/use-websocket.ts` (227 LOC). Same connect/auth/reconnect/keepalive logic but framework-agnostic — no Preact hooks, refs, or signals. Uses `createEmitter()` from Task 2.

- [ ] **Step 1: Write test**

Key tests: connect + auth flow, reconnect with exponential backoff, ping/pong keepalive, pong timeout → reconnect, auth timeout → error, sendJson/sendBinary, binary message routing.

Use a mock WebSocket (from `@sentient/testing` — `createMockWebSocket()`). The transport should accept a WebSocket factory so tests can inject mocks.

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTransport, type TransportConfig } from "./transport.ts";

describe("transport", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("connects and authenticates", () => {
    const stateChanges: string[] = [];
    const transport = createTransport({
      url: "ws://localhost:3000/ws",
      token: "test-token",
      createWebSocket: (url) => createMockWs(url),
    });
    transport.on("stateChange", (s) => stateChanges.push(s));
    transport.connect();
    expect(stateChanges).toContain("connecting");
  });

  // ... additional tests for reconnect, keepalive, auth timeout, etc.
});
```

- [ ] **Step 2: Implement transport**

The transport manages:
- WebSocket lifecycle (connect, close, error handlers)
- Auth flow: send `{ type: "auth", token }` on open, wait for `auth.ok`
- Ping/pong: 25s interval, 10s pong timeout
- Reconnection: exponential backoff (1s base, 30s max, 500ms jitter)
- Message routing: JSON → `jsonMessage` event, binary → `binaryMessage` event

Interface:
```typescript
export type TransportState = "disconnected" | "connecting" | "authenticating" | "connected" | "reconnecting";

export interface TransportConfig {
  url: string;
  token: string;
  pingIntervalMs?: number;    // default: 25000
  pongTimeoutMs?: number;     // default: 10000
  reconnectBaseMs?: number;   // default: 1000
  reconnectMaxMs?: number;    // default: 30000
  reconnectJitterMs?: number; // default: 500
  authTimeoutMs?: number;     // default: 10000
  createWebSocket?: (url: string) => WebSocket; // for testing
}

export interface Transport {
  connect(): void;
  disconnect(): void;
  sendJson(msg: Record<string, unknown>): void;
  sendBinary(data: ArrayBuffer): void;
  state(): TransportState;
  on<K extends keyof TransportEvents>(event: K, handler: TransportEvents[K]): () => void;
}
```

- [ ] **Step 3: Run tests, commit**

```bash
git add shared/web-sdk/src/transport.ts shared/web-sdk/src/transport.test.ts
git commit -m "feat(web-sdk): add WebSocket transport with auth, reconnect, and keepalive"
```

---

### Task 13: Voice Client Orchestrator

**Files:**
- Create: `shared/web-sdk/src/voice-client.ts`
- Test: `shared/web-sdk/src/voice-client.test.ts`

**PoC references:**
- `docs/research/2026-04-06-voice-pipeline-sdk/poc/sdk-state-machine-consumer-api/state-machine.ts` — VoiceClient runtime wrapper pattern (lines 324-394)
- `docs/research/2026-04-06-voice-pipeline-sdk/poc/sdk-state-machine-consumer-api/consumer-api.test.ts` — integration test patterns

This is the public API. It wires Transport + Voice State Machine + VAD State Machine + Error State Machine + MessageStore + TranscriptAccumulator + ProcessingTimer + AudioAdapters.

- [ ] **Step 1: Write integration test**

```typescript
import { describe, it, expect, vi } from "vitest";
import { createVoiceClient } from "./voice-client.ts";

// Minimal mock adapters
function mockCapture() {
  const handlers = { audio: [] as Array<(d: ArrayBuffer) => void>, vad: [] as Array<(s: boolean) => void> };
  return {
    start: vi.fn(async () => {}),
    stop: vi.fn(),
    onAudioData: (h: (d: ArrayBuffer) => void) => { handlers.audio.push(h); return () => {}; },
    onVadEvent: (h: (s: boolean) => void) => { handlers.vad.push(h); return () => {}; },
    onError: () => () => {},
    _simulateVad: (speaking: boolean) => handlers.vad.forEach(h => h(speaking)),
    _simulateAudio: (data: ArrayBuffer) => handlers.audio.forEach(h => h(data)),
  };
}

function mockPlayback() {
  return {
    init: vi.fn(async () => true),
    enqueue: vi.fn(),
    clear: vi.fn(),
    destroy: vi.fn(),
    onStateChange: () => () => {},
  };
}

describe("VoiceClient", () => {
  it("exposes initial inactive status", () => {
    const client = createVoiceClient({
      wsUrl: "ws://localhost:3000/ws",
      token: "test",
      capture: mockCapture(),
      playback: mockPlayback(),
    });
    expect(client.voiceState()).toBe("inactive");
  });

  it("startVoiceMode transitions to connecting", async () => {
    const capture = mockCapture();
    const playback = mockPlayback();
    const states: string[] = [];
    const client = createVoiceClient({
      wsUrl: "ws://localhost:3000/ws",
      token: "test",
      capture,
      playback,
      createWebSocket: () => createMockWs(),
    });
    client.on("statusChange", (s) => states.push(s.state));
    client.connect();
    // Should attempt connection
    expect(states).toContain("connecting");
  });
});
```

- [ ] **Step 2: Implement voice client**

The VoiceClient is a function `createVoiceClient(config) → VoiceClient` that:

1. Creates internal instances: Transport, VoiceStateMachine, VadStateMachine, ErrorStateMachine, MessageStore, TranscriptAccumulator, ProcessingTimer
2. Wires VAD events → Voice state machine
3. Wires Transport messages → Voice state machine (transcript.partial, transcript.final, response.start, etc.)
4. Wires Transport errors → Error state machine → Voice state machine
5. Dispatches Voice state machine effects → Transport (send messages), Capture (start/stop), Playback (play/clear)
6. Exposes public API: `connect()`, `disconnect()`, `startVoiceMode()`, `stopVoiceMode()`, `sendText()`, `voiceState()`, `on()`, `status()`

```typescript
export interface VoiceClientConfig {
  wsUrl: string;
  token: string;
  capture: AudioCaptureAdapter;
  playback: AudioPlaybackAdapter;
  audioDecoder?: (data: ArrayBuffer) => Float32Array;
  createWebSocket?: (url: string) => WebSocket;
}

export interface VoiceClientEvents {
  statusChange: (status: VoiceStatus) => void;
  transcript: (text: string, isFinal: boolean) => void;
  response: (text: string, isFinal: boolean) => void;
  messages: (messages: readonly ChatMessage[]) => void;
  error: (message: string) => void;
}

export interface VoiceClient {
  connect(): void;
  disconnect(): void;
  startVoiceMode(): Promise<void>;
  stopVoiceMode(): void;
  sendText(text: string): void;
  voiceState(): VoiceState;
  status(): VoiceStatus;
  messages(): readonly ChatMessage[];
  on<K extends keyof VoiceClientEvents>(event: K, handler: VoiceClientEvents[K]): () => void;
}

export function createVoiceClient(config: VoiceClientConfig): VoiceClient;
```

- [ ] **Step 3: Run tests, commit**

```bash
git add shared/web-sdk/src/voice-client.ts shared/web-sdk/src/voice-client.test.ts
git commit -m "feat(web-sdk): add VoiceClient orchestrator wiring all state machines"
```

- [ ] **Step 4: Update index.ts with all public exports**

```typescript
export { createEmitter, type TypedEmitter } from "./event-emitter.ts";
export { pcm16ToFloat32, float32ToPcm16 } from "./audio-codec.ts";
export type { AudioCaptureAdapter } from "./audio-capture-adapter.ts";
export type { AudioPlaybackAdapter } from "./audio-playback-adapter.ts";
export {
  type VoiceState, type VoiceEvent, type VoiceStatus,
} from "./voice-state-machine.ts";
export { type ChatMessage, type MessageStore } from "./message-store.ts";
export { createVoiceClient, type VoiceClient, type VoiceClientConfig, type VoiceClientEvents } from "./voice-client.ts";
```

- [ ] **Step 5: Run full SDK test suite**

Run: `cd shared/web-sdk && bunx vitest run`
Expected: ALL PASS

- [ ] **Step 6: Commit index update**

```bash
git add shared/web-sdk/src/index.ts
git commit -m "feat(web-sdk): finalize public API exports"
```

---

## Phase 2: Protocol + Codec

### Task 14: Protocol Message Updates

**Files:**
- Modify: `shared/protocol/src/messages.ts`
- Test: `shared/protocol/src/messages.test.ts`

- [ ] **Step 1: Add new client message schemas**

Add to `shared/protocol/src/messages.ts`:

```typescript
export const utteranceStartSchema = z.object({
  type: z.literal("utterance.start"),
  utteranceId: z.string().min(1),
});

export const utteranceEndSchema = z.object({
  type: z.literal("utterance.end"),
  utteranceId: z.string().min(1),
});

export const utteranceCancelSchema = z.object({
  type: z.literal("utterance.cancel"),
  utteranceId: z.string().min(1),
});

export const sessionConfigureSchema = z.object({
  type: z.literal("session.configure"),
  supportedEncodings: z.array(z.enum(["pcm16", "opus"])),
  preferredEncoding: z.enum(["pcm16", "opus"]),
  captureSampleRate: z.number().int().positive(),
  playbackSampleRate: z.number().int().positive(),
});
```

Add these to the `clientMessageSchema` discriminated union.

- [ ] **Step 2: Add new gateway message schemas**

```typescript
export const statusProcessingSchema = z.object({
  type: z.literal("status.processing"),
  utteranceId: z.string(),
});

export const sessionReadySchema = z.object({
  type: z.literal("session.ready"),
  encoding: z.enum(["pcm16", "opus"]),
  captureSampleRate: z.number().int().positive(),
  playbackSampleRate: z.number().int().positive(),
});

export const responseStartSchema = z.object({
  type: z.literal("response.start"),
  utteranceId: z.string(),
  responseId: z.string(),
});
```

- [ ] **Step 3: Add correlation IDs to existing schemas**

Modify existing schemas to include correlation IDs:

```typescript
// Add utteranceId to transcript schemas
export const transcriptPartialSchema = z.object({
  type: z.literal("transcript.partial"),
  utteranceId: z.string(),
  text: z.string(),
});

export const transcriptFinalSchema = z.object({
  type: z.literal("transcript.final"),
  utteranceId: z.string(),
  text: z.string(),
});

// Add responseId to response schemas
export const responseTextDeltaSchema = z.object({
  type: z.literal("response.text.delta"),
  responseId: z.string(),
  text: z.string(),
});

export const responseTextDoneSchema = z.object({
  type: z.literal("response.text.done"),
  responseId: z.string(),
});

export const responseAudioStartSchema = z.object({
  type: z.literal("response.audio.start"),
  responseId: z.string(),
});

export const responseAudioDoneSchema = z.object({
  type: z.literal("response.audio.done"),
  responseId: z.string(),
});

export const bargeInAckSchema = z.object({
  type: z.literal("barge_in.ack"),
  responseId: z.string(),
});

// Add responseId to barge_in client message
export const bargeInSchema = z.object({
  type: z.literal("barge_in"),
  responseId: z.string(),
});

// Add responseId to tool confirm request
export const toolConfirmRequestSchema = z.object({
  type: z.literal("tool.confirm_request"),
  responseId: z.string(),
  toolCallId: z.string(),
  toolName: z.string(),
  args: z.record(z.unknown()),
  description: z.string(),
});
```

Add all new schemas to the `gatewayMessageSchema` discriminated union.

- [ ] **Step 4: Update tests**

Add schema validation tests for all new message types. Verify `utteranceId` and `responseId` are required strings.

- [ ] **Step 5: Run tests**

Run: `cd shared/protocol && bunx vitest run`
Expected: PASS — may need to update existing tests that create messages without correlation IDs

- [ ] **Step 6: Commit**

```bash
git add shared/protocol/src/messages.ts shared/protocol/src/messages.test.ts
git commit -m "feat(protocol): add utterance lifecycle, correlation IDs, and codec negotiation messages"
```

---

### Task 15: Enhanced Mock Providers

**Files:**
- Modify: `shared/testing/src/mock-stt-provider.ts`
- Modify: `shared/testing/src/mock-tts-provider.ts`
- Create: `shared/testing/src/mock-llm-provider.ts`
- Modify: `shared/testing/src/index.ts`

- [ ] **Step 1: Enhance MockSTTProvider**

Add to existing `createMockSTTProvider`:

```typescript
// Add imperative event emission for continuous mode testing
emitEvent(event: TranscriptEvent): void;
// Simulate provider disconnect mid-stream
simulateDisconnect(): void;
```

The `emitEvent()` method pushes events into an async queue that the `transcripts()` generator drains. This enables tests to imperatively control when partials and finals arrive.

- [ ] **Step 2: Enhance MockTTSProvider**

Add to existing `createMockTTSProvider`:

```typescript
// New behavior options
failAfterChunks?: number;    // throw after N chunks
stallAfterChunks?: number;   // stop yielding after N chunks (simulate hang)
```

- [ ] **Step 3: Create MockLLMProvider**

```typescript
export interface MockLLMBehavior {
  response?: string;           // full response text, tokenized by word
  tokens?: string[];           // explicit token sequence
  tokenDelayMs?: number;       // delay between tokens
  shouldFail?: boolean;
  failAfterTokens?: number;
  errorMessage?: string;
}

export interface MockLLMProvider {
  stream(options: { messages: Array<{ role: string; content: string }>; signal: AbortSignal }): AsyncGenerator<string>;
  streamCallCount: number;
  lastMessages: Array<{ role: string; content: string }>;
}

export function createMockLLMProvider(behavior?: MockLLMBehavior): MockLLMProvider;
```

- [ ] **Step 4: Update exports, run tests, commit**

```bash
git add shared/testing/src/mock-stt-provider.ts shared/testing/src/mock-tts-provider.ts shared/testing/src/mock-llm-provider.ts shared/testing/src/index.ts
git commit -m "feat(testing): enhance mock providers with imperative emission and failure injection"
```

---

### Task 16: Mock Transport + Audio Adapters

**Files:**
- Create: `shared/testing/src/mock-transport.ts`
- Create: `shared/testing/src/mock-audio-adapter.ts`
- Modify: `shared/testing/src/index.ts`

- [ ] **Step 1: Create MockTransport**

```typescript
export interface MockTransport {
  // Standard Transport interface
  connect(): void;
  disconnect(): void;
  sendJson(msg: Record<string, unknown>): void;
  sendBinary(data: ArrayBuffer): void;
  state(): TransportState;
  on<K extends keyof TransportEvents>(event: K, handler: TransportEvents[K]): () => void;

  // Test control
  simulateJsonMessage(msg: Record<string, unknown>): void;
  simulateBinaryMessage(data: ArrayBuffer): void;
  simulateStateChange(state: TransportState): void;
  simulateAuthSuccess(sessionId: string, role: string): void;
  sentJsonMessages(): Array<Record<string, unknown>>;
  sentBinaryMessages(): ArrayBuffer[];
}

export function createMockTransport(): MockTransport;
```

- [ ] **Step 2: Create MockAudioAdapters**

```typescript
export function createMockCaptureAdapter(): AudioCaptureAdapter & {
  simulateVadEvent(speaking: boolean): void;
  simulateAudioData(data: ArrayBuffer): void;
  simulateError(message: string): void;
};

export function createMockPlaybackAdapter(): AudioPlaybackAdapter & {
  enqueuedSamples(): Float32Array[];
  wasCleared(): boolean;
  resetCleared(): void;
};
```

- [ ] **Step 3: Export, commit**

```bash
git add shared/testing/src/mock-transport.ts shared/testing/src/mock-audio-adapter.ts shared/testing/src/index.ts
git commit -m "feat(testing): add mock transport and audio adapters for SDK testing"
```

---

## Phase 3: Gateway Continuous Mode

### Task 17: Continuous Session

**Files:**
- Create: `gateway/src/pipeline/continuous-session.ts`
- Test: `gateway/src/pipeline/continuous-session.test.ts`

**PoC reference:** Read `docs/research/2026-04-06-voice-pipeline-sdk/poc/gateway-pipeline-consumer-api/pipeline-sdk.ts` for the FlowManager pattern (275 LOC) and `docs/research/2026-04-06-voice-pipeline-sdk/poc/gateway-pipeline-state-table/pipeline-state-machine.ts` for the 11-state server-side model.

- [ ] **Step 1: Write test**

Key tests using enhanced MockSTTProvider with `emitEvent()`:
- Partial transcripts are relayed via event callback
- Final transcripts accumulated from multiple `isFinal` segments
- `utteranceReady` event fires on `speechFinal: true`
- Barge-in aborts current turn via AbortController
- Early audio buffering during STT connect
- `status.processing` emitted immediately on `utteranceEnd()`
- Provider disconnect triggers error event

```typescript
import { describe, it, expect, vi } from "vitest";
import { createContinuousSession } from "./continuous-session.ts";
import { createMockSTTProvider, createMockTTSProvider } from "@sentient/testing";

describe("ContinuousSession", () => {
  it("relays partial transcripts", async () => {
    const stt = createMockSTTProvider();
    const tts = createMockTTSProvider();
    const partials: string[] = [];

    const session = createContinuousSession({
      sttProvider: stt, sttConfig: { /* test config */ },
      ttsProvider: tts, ttsConfig: { /* test config */ },
    });

    session.on("transcriptPartial", (text) => partials.push(text));
    await session.start();

    stt.emitEvent({ type: "transcript", text: "hello", isFinal: false, speechFinal: false, confidence: 0.8 });
    expect(partials).toContain("hello");
  });

  // ... more tests for final accumulation, utteranceReady, barge-in, etc.
});
```

- [ ] **Step 2: Implement ContinuousSession**

Replaces `voice-session.ts`. Key differences:
- Event-driven (uses `createEmitter()`) instead of blocking `readNextFinalTranscript()`
- Runs a background transcript relay loop that iterates ALL STT events
- Accumulates `isFinal` segments, emits `utteranceReady` on `speechFinal: true`
- Emits `status.processing` immediately on `utteranceEnd()`

Reuse patterns from current `voice-session.ts`: AbortController rotation, early audio buffering, connect serialization via `connectPromise`.

- [ ] **Step 3: Run tests, commit**

```bash
git add gateway/src/pipeline/continuous-session.ts gateway/src/pipeline/continuous-session.test.ts
git commit -m "feat(gateway): add ContinuousSession with partial transcript relay"
```

---

### Task 18: Continuous Voice Handler

**Files:**
- Create: `gateway/src/server/continuous-voice-handler.ts`
- Test: `gateway/src/server/continuous-voice-handler.test.ts`

- [ ] **Step 1: Write test and implement**

Thin bridge between WebSocket messages and ContinuousSession. Handles:
- `audio.start` → create ContinuousSession, start
- `utterance.start` → session.utteranceStart()
- `utterance.end` → session.utteranceEnd(), generate responseId, send `status.processing`, kick off LLM→TTS pipeline
- `barge_in` → session.bargeIn(), send `barge_in.ack`
- `audio.end` → stop session

Wire ContinuousSession events to WebSocket sends:
- `transcriptPartial` → `ws.send({ type: "transcript.partial", utteranceId, text })`
- `transcriptFinal` → `ws.send({ type: "transcript.final", utteranceId, text })`
- `utteranceReady` → run voice turn pipeline (reuse `runVoiceTurn()` from existing `voice-turn.ts` or compose stages directly)

- [ ] **Step 2: Run tests, commit**

```bash
git add gateway/src/server/continuous-voice-handler.ts gateway/src/server/continuous-voice-handler.test.ts
git commit -m "feat(gateway): add continuous voice handler bridging WS to ContinuousSession"
```

---

### Task 19: Wire into WebSocket Server

**Files:**
- Modify: `gateway/src/server/ws-server.ts`
- Modify: `gateway/src/server/ws-helpers.ts`

- [ ] **Step 1: Update ClientData**

In `ws-helpers.ts`, update `ClientData` to support `ContinuousSession`:

```typescript
import type { ContinuousSession } from "../pipeline/continuous-session.ts";

export interface ClientData {
  sessionId: string | null;
  connectedAt: number;
  history: ConversationTurn[];
  voiceSession: VoiceSession | null;          // deprecated, kept for now
  continuousSession: ContinuousSession | null; // new
}
```

- [ ] **Step 2: Update message routing in ws-server.ts**

Add handlers for new message types (`utterance.start`, `utterance.end`, `utterance.cancel`, `session.configure`) alongside existing handlers. Route to `continuous-voice-handler.ts`.

Keep existing `audio.start`/`audio.end` handlers but update semantics (voice mode toggle). Binary audio forwarding: check `continuousSession` first, fall back to `voiceSession`.

- [ ] **Step 3: Run gateway tests**

Run: `cd gateway && bun run test`
Expected: PASS — existing tests should still pass (old handlers still exist)

- [ ] **Step 4: Commit**

```bash
git add gateway/src/server/ws-server.ts gateway/src/server/ws-helpers.ts
git commit -m "feat(gateway): wire continuous voice handler into WS server"
```

---

### Task 20: Gateway Integration Tests

**Files:**
- Create: `gateway/src/pipeline/__tests__/continuous-session.integration.test.ts`
- Create: `gateway/src/server/__tests__/continuous-voice.integration.test.ts`

**PoC reference:** Read `docs/research/2026-04-06-voice-pipeline-sdk/poc/gateway-pipeline-test-harness/` for patterns: mock provider setup, event collection, assertion helpers.

- [ ] **Step 1: Write pipeline integration test**

Tests ContinuousSession with mock providers wired through real stage composition:
- Full turn: audio → STT → LLM → TTS → response events
- Partial transcript relay during audio streaming
- Barge-in mid-response aborts all stages
- Multi-turn with history accumulation
- Provider failure mid-stream triggers error

- [ ] **Step 2: Write WebSocket contract test**

Tests full protocol over real WebSocket:
- Connect → auth → auth.ok
- utterance.start → stream audio → utterance.end → status.processing
- transcript.partial arrives during streaming
- transcript.final → response.start → response.text.delta → response.text.done
- Binary audio frames arrive
- response.audio.done
- barge_in { responseId } → barge_in.ack { responseId }
- utteranceId/responseId correlation verified

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createGatewayServer } from "../ws-server.ts";
import { createMockSTTProvider, createMockTTSProvider, createMockLLMProvider, createAuthToken, TEST_PASETO_SECRET } from "@sentient/testing";

describe("continuous voice WebSocket contract", () => {
  let server: ReturnType<typeof createGatewayServer>;
  let port: number;

  beforeAll(async () => {
    const stt = createMockSTTProvider({ /* realistic partial+final sequence */ });
    const llm = createMockLLMProvider({ response: "It is sunny today" });
    const tts = createMockTTSProvider({ framesPerSentence: 3 });

    server = createGatewayServer({
      port: 0, host: "127.0.0.1",
      sttProvider: stt, sttConfig: { /* ... */ },
      ttsProvider: tts, ttsConfig: { /* ... */ },
      llmProvider: llm,
      // ... other required options
    });
    port = server.port;
  });

  afterAll(() => server.stop());

  it("completes full voice turn with correlation IDs", async () => {
    const token = await createAuthToken(undefined, TEST_PASETO_SECRET);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    // ... auth, utterance lifecycle, assertions on correlation IDs
  });
});
```

- [ ] **Step 3: Run integration tests**

Run: `cd gateway && bun run test:int`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add gateway/src/pipeline/__tests__/ gateway/src/server/__tests__/
git commit -m "test(gateway): add pipeline and WebSocket contract integration tests"
```

---

## Phase 4: Web Client Migration

### Task 21: Capture Worklet VAD + Web Audio Adapters

**Files:**
- Modify: `web/src/audio/capture-worklet.ts`
- Create: `web/src/adapters/web-audio-capture.ts`
- Create: `web/src/adapters/web-audio-playback.ts`
- Test: `web/src/adapters/web-audio-capture.test.ts`
- Test: `web/src/adapters/web-audio-playback.test.ts`

- [ ] **Step 1: Add VAD to capture worklet**

Add RMS energy detection to `web/src/audio/capture-worklet.ts` inside the `process()` method, after the PCM conversion loop:

```typescript
// Add these fields to CaptureProcessor class
private wasSpeaking = false;
private readonly VAD_THRESHOLD = 0.01; // RMS threshold for speech detection

// Add at the end of process(), before return true:
let sumSquares = 0;
for (let i = 0; i < input.length; i++) {
  const s = input[i] ?? 0;
  sumSquares += s * s;
}
const rms = Math.sqrt(sumSquares / input.length);
const speaking = rms > this.VAD_THRESHOLD;
if (speaking !== this.wasSpeaking) {
  this.port.postMessage({ type: "vad", speaking });
  this.wasSpeaking = speaking;
}
```

- [ ] **Step 2: Create web audio capture adapter**

Implements `AudioCaptureAdapter` from `@sentient/web-sdk`. Extracted from `web/src/hooks/use-audio-capture.ts` — same getUserMedia setup, AudioContext creation, worklet loading. Routes `pcm` messages to `onAudioData` and `vad` messages to `onVadEvent`.

- [ ] **Step 3: Create web audio playback adapter**

Implements `AudioPlaybackAdapter` from `@sentient/web-sdk`. Extracted from `web/src/hooks/use-audio-playback.ts` — same AudioContext, playback worklet, FIFO queue.

- [ ] **Step 4: Write tests, run, commit**

```bash
git add web/src/audio/capture-worklet.ts web/src/adapters/
git commit -m "feat(web): add VAD to capture worklet and create audio adapters"
```

---

### Task 22: Preact Bridge + UI Components

**Files:**
- Create: `web/src/hooks/use-voice-client.ts`
- Create: `web/src/hooks/use-voice-client.test.ts`
- Create: `web/src/components/voice-mode-button.tsx`
- Create: `web/src/components/voice-mode-button.test.tsx`
- Create: `web/src/components/live-transcript.tsx`
- Create: `web/src/components/live-transcript.test.tsx`

- [ ] **Step 1: Create useVoiceClient hook**

```typescript
import { useSignal } from "@preact/signals";
import { useMemo, useEffect } from "preact/hooks";
import { createVoiceClient, type VoiceStatus, type ChatMessage } from "@sentient/web-sdk";
import { createWebAudioCapture } from "../adapters/web-audio-capture.ts";
import { createWebAudioPlayback } from "../adapters/web-audio-playback.ts";

export function useVoiceClient(options: { wsUrl: string; token: string }) {
  const status = useSignal<VoiceStatus>({ state: "inactive", label: "Ready", canSpeak: false, isActive: false });
  const messages = useSignal<readonly ChatMessage[]>([]);

  const client = useMemo(() => {
    const capture = createWebAudioCapture();
    const playback = createWebAudioPlayback();
    return createVoiceClient({ ...options, capture, playback });
  }, [options.wsUrl, options.token]);

  useEffect(() => {
    const unsub1 = client.on("statusChange", (s) => { status.value = s; });
    const unsub2 = client.on("messages", (m) => { messages.value = m; });
    client.connect();
    return () => { unsub1(); unsub2(); client.disconnect(); };
  }, [client]);

  return {
    status,
    messages,
    startVoiceMode: () => client.startVoiceMode(),
    stopVoiceMode: () => client.stopVoiceMode(),
    sendText: (text: string) => client.sendText(text),
  };
}
```

- [ ] **Step 2: Create voice-mode-button component**

```tsx
import type { VoiceState } from "@sentient/web-sdk";

interface VoiceModeButtonProps {
  voiceState: VoiceState;
  label: string;
  onStart: () => void;
  onStop: () => void;
  disabled: boolean;
}

export function VoiceModeButton({ voiceState, label, onStart, onStop, disabled }: VoiceModeButtonProps) {
  const isActive = voiceState !== "inactive";
  return (
    <button
      class={`voice-mode-button ${isActive ? "voice-mode-button--active" : ""}`}
      onClick={isActive ? onStop : onStart}
      disabled={disabled}
      aria-label={isActive ? "Stop voice mode" : "Start voice mode"}
    >
      <span class="voice-mode-button__label">{label}</span>
    </button>
  );
}
```

- [ ] **Step 3: Create live-transcript component**

```tsx
interface LiveTranscriptProps {
  text: string;
  isFinal: boolean;
}

export function LiveTranscript({ text, isFinal }: LiveTranscriptProps) {
  if (!text) return null;
  return (
    <div class={`live-transcript ${isFinal ? "live-transcript--final" : ""}`}>
      {text}
      {!isFinal && <span class="live-transcript__cursor">|</span>}
    </div>
  );
}
```

- [ ] **Step 4: Write tests, run, commit**

```bash
git add web/src/hooks/use-voice-client.ts web/src/hooks/use-voice-client.test.ts web/src/components/voice-mode-button.tsx web/src/components/voice-mode-button.test.tsx web/src/components/live-transcript.tsx web/src/components/live-transcript.test.tsx
git commit -m "feat(web): add useVoiceClient hook and voice mode UI components"
```

---

### Task 23: Rewrite App + ChatScreen

**Files:**
- Rewrite: `web/src/app.tsx`
- Modify: `web/src/components/chat-screen.tsx`

- [ ] **Step 1: Rewrite app.tsx**

```tsx
import { useState } from "preact/hooks";
import { useVoiceClient } from "./hooks/use-voice-client.ts";
import { AuthGate } from "./components/auth-gate.tsx";
import { ChatScreen } from "./components/chat-screen.tsx";

const WS_URL = `ws://${window.location.host}/ws`;

export function App() {
  const [token, setToken] = useState("");
  const client = useVoiceClient({ wsUrl: WS_URL, token });

  return (
    <AuthGate onTokenReady={setToken}>
      <ChatScreen
        status={client.status}
        messages={client.messages}
        onStartVoice={client.startVoiceMode}
        onStopVoice={client.stopVoiceMode}
        onSendText={client.sendText}
      />
    </AuthGate>
  );
}
```

- [ ] **Step 2: Update ChatScreen props**

Update `chat-screen.tsx` to accept the new prop shapes (VoiceStatus signal, messages signal, voice mode callbacks instead of toggle-talk).

- [ ] **Step 3: Run web tests**

Run: `cd web && bun run test`
Expected: PASS (some old tests may fail — expected, cleaned up in Task 24)

- [ ] **Step 4: Commit**

```bash
git add web/src/app.tsx web/src/components/chat-screen.tsx
git commit -m "feat(web): rewrite app.tsx and chat-screen to use SDK"
```

---

## Phase 5: Cleanup

### Task 24: Delete Old Code

**Files to delete:**
- `web/src/hooks/use-websocket.ts` + `web/src/hooks/use-websocket.test.ts`
- `web/src/hooks/use-audio-capture.ts` + `web/src/hooks/use-audio-capture.test.ts`
- `web/src/hooks/use-audio-playback.ts` + `web/src/hooks/use-audio-playback.test.ts`
- `web/src/hooks/use-messages.ts` + `web/src/hooks/use-messages.test.ts`
- `web/src/components/toggle-talk-button.tsx` + `web/src/components/toggle-talk-button.test.tsx`
- `web/src/audio/pcm-decoder.ts` (moved to SDK's audio-codec.ts)

- [ ] **Step 1: Delete all listed files**

```bash
rm web/src/hooks/use-websocket.ts web/src/hooks/use-websocket.test.ts
rm web/src/hooks/use-audio-capture.ts web/src/hooks/use-audio-capture.test.ts
rm web/src/hooks/use-audio-playback.ts web/src/hooks/use-audio-playback.test.ts
rm web/src/hooks/use-messages.ts web/src/hooks/use-messages.test.ts
rm web/src/components/toggle-talk-button.tsx web/src/components/toggle-talk-button.test.tsx
rm web/src/audio/pcm-decoder.ts
```

- [ ] **Step 2: Update any remaining imports**

Search for imports of deleted files. Update `web/src/types.ts` to remove `TalkState` if present.

- [ ] **Step 3: Run full CI**

Run: `cd /Users/kevinye/Development/sentient && bun run ci`
Expected: ALL PASS — lint, typecheck, tests

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore(web): remove legacy hooks and components replaced by SDK"
```

---

### Task 25: Update Test Rules

**Files:**
- Modify: `.claude/rules/testing.md`

- [ ] **Step 1: Add voice pipeline test philosophy**

Append to `.claude/rules/testing.md`:

```markdown
## Voice Pipeline Test Philosophy

- State machines are the source of truth. Every behavior traces to a state transition.
- Test the contract, not the wiring. Feed typed inputs, assert typed outputs. Never mock internals.
- Pure functions don't need mocks. State machines, classifiers, resolvers, codecs — test directly.
- Every waiting state must have a timeout test. No exceptions.
- Zero-cost by default. No API keys in any test. Mock providers simulate all provider behavior.
- Test sad paths harder than happy path. Barge-in, disconnect, timeout, double-event, abort-during-transition.
- Exhaustiveness over coverage %. Verify every state is reachable, every state has an exit, every waiting state has timeout guard.
```

- [ ] **Step 2: Commit**

```bash
git add .claude/rules/testing.md
git commit -m "docs: update testing rules with voice pipeline test philosophy"
```

---

### Task 26: Final Verification

- [ ] **Step 1: Run full CI**

```bash
cd /Users/kevinye/Development/sentient && bun run ci
```

Expected: ALL PASS — lint + typecheck + all tests across all packages

- [ ] **Step 2: Manual E2E test**

```bash
bun run dev
```

Open browser, toggle voice mode on, speak, verify:
1. Partial transcripts appear in real-time as you speak
2. After pause, "Thinking..." indicator shows
3. Assistant response streams back (text + audio)
4. Mic stays active, ready for next utterance
5. Toggle voice mode off returns to text-only mode

- [ ] **Step 3: Final commit if any fixes needed**

```bash
git add -A && git commit -m "fix: address E2E test findings"
```
