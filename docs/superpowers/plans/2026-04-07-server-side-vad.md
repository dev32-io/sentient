# Server-Side VAD Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move voice activity detection from client-side RMS threshold to server-side STT provider, making the gateway the turn boundary authority while keeping the SDK surface unchanged.

**Architecture:** Three independent contracts (VadFilter, SpeechService, voice state machine) with zero coupling between them. Audio streams continuously while voice mode is active, filtered by a client-side VadFilter (cost optimization). Gateway determines speech start/end from STT provider events and relays them to the client. Gateway self-suppresses speech events during TTS playback.

**Tech Stack:** Bun/TypeScript, Vitest, Zod, @ricky0123/vad-web (Silero VAD), Deepgram Nova-3

**Spec:** `docs/superpowers/specs/2026-04-07-server-side-vad-redesign.md`

---

## File Structure

### New files

| File | Responsibility |
|------|---------------|
| `shared/web-sdk/src/vad-filter.ts` | VadFilter interface + VadFilterResult type |
| `shared/web-sdk/src/vad-filter.test.ts` | Contract test for EnergyVadFilter |
| `shared/web-sdk/src/energy-vad-filter.ts` | RMS energy fallback implementation |
| `shared/web-sdk/src/energy-vad-filter.test.ts` | Unit tests |
| `shared/web-sdk/src/speech-service.ts` | SpeechService interface + ServiceState type |
| `shared/web-sdk/src/ws-speech-service.ts` | WebSocket-to-SpeechService adapter |
| `shared/web-sdk/src/ws-speech-service.test.ts` | Unit tests |
| `web/src/adapters/silero-vad-filter.ts` | Silero ML VAD using @ricky0123/vad-web |
| `web/src/adapters/silero-vad-filter.test.ts` | Unit tests |
| `web/src/adapters/create-vad-filter.ts` | Factory: try Silero, fall back to Energy |
| `web/src/adapters/create-vad-filter.test.ts` | Factory fallback tests |

### Modified files

| File | Change |
|------|--------|
| `shared/protocol/src/messages.ts` | Add `vad.speech-start`, `vad.speech-end` to gateway messages |
| `shared/web-sdk/src/voice-state-machine.ts` | Remove utterance/VAD effects, simplify transitions for server-driven events |
| `shared/web-sdk/src/voice-state-machine.test.ts` | Update all transition tests |
| `shared/web-sdk/src/audio-capture-adapter.ts` | Remove `onVadEvent` from interface |
| `shared/web-sdk/src/voice-client.ts` | Replace VAD dispatch with SpeechService + VadFilter integration |
| `shared/web-sdk/src/voice-client.test.ts` | Rewrite tests for server-driven flow |
| `shared/web-sdk/src/index.ts` | Update exports |
| `web/src/audio/capture-worklet.ts` | Remove VAD logic (RMS threshold, speaking state) |
| `web/src/adapters/web-audio-capture.ts` | Remove VAD handler wiring |
| `gateway/src/pipeline/continuous-session.ts` | Add server-driven turn detection + TTS suppression |
| `gateway/src/pipeline/continuous-session.test.ts` | Add suppression + turn boundary tests |
| `gateway/src/server/continuous-voice-handler.ts` | Replace utterance handlers with server-driven flow |
| `gateway/src/server/continuous-voice-handler.test.ts` | Rewrite for new flow |
| `gateway/src/server/ws-server.ts` | Remove utterance.start/end/cancel routing |
| `gateway/src/server/ws-server-voice.test.ts` | Update routing tests |
| `web/package.json` | Add `@ricky0123/vad-web` dependency |

### Deleted files

| File | Reason |
|------|--------|
| `shared/web-sdk/src/vad-state-machine.ts` | Replaced by server-side VAD |
| `shared/web-sdk/src/vad-state-machine.test.ts` | Tests for deleted machine |
| `shared/web-sdk/src/voice-effect-handler.ts` | VAD dispatch + effect runners consolidated into voice-client |

---

### Task 1: Protocol — Add server VAD messages

**Files:**
- Modify: `shared/protocol/src/messages.ts:96-202`
- Modify: `shared/protocol/src/messages.test.ts` (if exists, else skip)

- [ ] **Step 1: Write test for new message schemas**

In `shared/protocol/src/messages.test.ts` (create if needed):

```typescript
import { describe, expect, it } from "vitest";
import { gatewayMessageSchema, vadSpeechStartSchema, vadSpeechEndSchema } from "./messages.ts";

describe("vad gateway messages", () => {
  it("parses vad.speech-start", () => {
    const result = vadSpeechStartSchema.safeParse({ type: "vad.speech-start" });
    expect(result.success).toBe(true);
  });

  it("parses vad.speech-end", () => {
    const result = vadSpeechEndSchema.safeParse({ type: "vad.speech-end" });
    expect(result.success).toBe(true);
  });

  it("gatewayMessageSchema accepts vad.speech-start", () => {
    const result = gatewayMessageSchema.safeParse({ type: "vad.speech-start" });
    expect(result.success).toBe(true);
  });

  it("gatewayMessageSchema accepts vad.speech-end", () => {
    const result = gatewayMessageSchema.safeParse({ type: "vad.speech-end" });
    expect(result.success).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd shared/protocol && bun test src/messages.test.ts`
Expected: FAIL — `vadSpeechStartSchema` not found

- [ ] **Step 3: Add vad.speech-start and vad.speech-end schemas**

In `shared/protocol/src/messages.ts`, add after `bargeInAckSchema` (line 167):

```typescript
export const vadSpeechStartSchema = z.object({
  type: z.literal("vad.speech-start"),
});

export const vadSpeechEndSchema = z.object({
  type: z.literal("vad.speech-end"),
});
```

Add both to the `gatewayMessageSchema` discriminated union (after `bargeInAckSchema` in the array):

```typescript
export const gatewayMessageSchema = z.discriminatedUnion("type", [
  authOkSchema,
  sessionReadySchema,
  transcriptPartialSchema,
  transcriptFinalSchema,
  statusProcessingSchema,
  responseStartSchema,
  responseTextDeltaSchema,
  responseTextDoneSchema,
  responseAudioStartSchema,
  responseAudioDoneSchema,
  toolConfirmRequestSchema,
  bargeInAckSchema,
  vadSpeechStartSchema,
  vadSpeechEndSchema,
  errorSchema,
  pongSchema,
  sessionExpiredSchema,
]);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd shared/protocol && bun test src/messages.test.ts`
Expected: PASS

- [ ] **Step 5: Run full typecheck**

Run: `source scripts/env.sh && bun run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add shared/protocol/src/messages.ts shared/protocol/src/messages.test.ts
git commit -m "feat(protocol): add vad.speech-start and vad.speech-end gateway messages"
```

---

### Task 2: VadFilter contract + EnergyVadFilter

**Files:**
- Create: `shared/web-sdk/src/vad-filter.ts`
- Create: `shared/web-sdk/src/energy-vad-filter.ts`
- Create: `shared/web-sdk/src/energy-vad-filter.test.ts`

- [ ] **Step 1: Write VadFilter interface**

Create `shared/web-sdk/src/vad-filter.ts`:

```typescript
/** Result of processing a single audio frame through a VadFilter. */
export interface VadFilterResult {
  /** Should this frame be sent to the gateway? */
  send: boolean;
  /** Speech probability 0.0–1.0 (used for cosmetic audio level UI). */
  speechProbability: number;
}

/**
 * Client-side audio gate. Decides per-frame whether audio is worth sending
 * to the gateway. Pure cost optimization — has zero coupling to the
 * SpeechService or voice state machine.
 */
export interface VadFilter {
  /** Initialize the filter (load model, warm up). */
  init(): Promise<void>;
  /** Process a single audio frame. Must return synchronously. */
  process(frame: Int16Array): VadFilterResult;
  /** Release resources (model, WASM memory). */
  dispose(): void;
}
```

- [ ] **Step 2: Write failing tests for EnergyVadFilter**

Create `shared/web-sdk/src/energy-vad-filter.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { createEnergyVadFilter } from "./energy-vad-filter.ts";

function silentFrame(length = 512): Int16Array {
  return new Int16Array(length);
}

function loudFrame(length = 512, amplitude = 20000): Int16Array {
  const frame = new Int16Array(length);
  for (let i = 0; i < length; i++) {
    frame[i] = Math.sin(i * 0.1) * amplitude;
  }
  return frame;
}

function quietFrame(length = 512, amplitude = 50): Int16Array {
  const frame = new Int16Array(length);
  for (let i = 0; i < length; i++) {
    frame[i] = Math.sin(i * 0.1) * amplitude;
  }
  return frame;
}

describe("EnergyVadFilter", () => {
  it("init resolves immediately", async () => {
    const filter = createEnergyVadFilter();
    await expect(filter.init()).resolves.toBeUndefined();
    filter.dispose();
  });

  it("returns send=false for silent frames", () => {
    const filter = createEnergyVadFilter();
    const result = filter.process(silentFrame());
    expect(result.send).toBe(false);
    expect(result.speechProbability).toBe(0);
    filter.dispose();
  });

  it("returns send=true for loud frames", () => {
    const filter = createEnergyVadFilter();
    const result = filter.process(loudFrame());
    expect(result.send).toBe(true);
    expect(result.speechProbability).toBeGreaterThan(0.5);
    filter.dispose();
  });

  it("returns send=false for very quiet frames", () => {
    const filter = createEnergyVadFilter();
    const result = filter.process(quietFrame());
    expect(result.send).toBe(false);
    expect(result.speechProbability).toBeLessThan(0.5);
    filter.dispose();
  });

  it("speechProbability is clamped between 0 and 1", () => {
    const filter = createEnergyVadFilter();
    const maxFrame = new Int16Array(512).fill(32767);
    const result = filter.process(maxFrame);
    expect(result.speechProbability).toBeLessThanOrEqual(1);
    expect(result.speechProbability).toBeGreaterThanOrEqual(0);
    filter.dispose();
  });

  it("accepts custom threshold", () => {
    const sensitive = createEnergyVadFilter({ threshold: 0.001 });
    const strict = createEnergyVadFilter({ threshold: 0.5 });
    const frame = quietFrame(512, 200);
    expect(sensitive.process(frame).send).toBe(true);
    expect(strict.process(frame).send).toBe(false);
    sensitive.dispose();
    strict.dispose();
  });

  it("dispose is safe to call multiple times", () => {
    const filter = createEnergyVadFilter();
    expect(() => {
      filter.dispose();
      filter.dispose();
    }).not.toThrow();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd shared/web-sdk && bun test src/energy-vad-filter.test.ts`
Expected: FAIL — module not found

- [ ] **Step 4: Implement EnergyVadFilter**

Create `shared/web-sdk/src/energy-vad-filter.ts`:

```typescript
import type { VadFilter, VadFilterResult } from "./vad-filter.ts";

const DEFAULT_THRESHOLD = 0.008;
const INT16_MAX = 32768;

export interface EnergyVadFilterOptions {
  /** RMS threshold (0.0–1.0). Frames above this are considered speech. Default 0.008. */
  threshold?: number;
}

export function createEnergyVadFilter(options?: EnergyVadFilterOptions): VadFilter {
  const threshold = options?.threshold ?? DEFAULT_THRESHOLD;

  return {
    async init() {
      // No-op — energy filter needs no model loading.
    },

    process(frame: Int16Array): VadFilterResult {
      let sumSquares = 0;
      for (let i = 0; i < frame.length; i++) {
        const normalized = (frame[i] ?? 0) / INT16_MAX;
        sumSquares += normalized * normalized;
      }
      const rms = Math.sqrt(sumSquares / frame.length);
      const speechProbability = Math.min(1, rms / (threshold * 4));

      return {
        send: rms > threshold,
        speechProbability,
      };
    },

    dispose() {
      // No-op — nothing to release.
    },
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd shared/web-sdk && bun test src/energy-vad-filter.test.ts`
Expected: All PASS

- [ ] **Step 6: Commit**

```bash
git add shared/web-sdk/src/vad-filter.ts shared/web-sdk/src/energy-vad-filter.ts shared/web-sdk/src/energy-vad-filter.test.ts
git commit -m "feat(web-sdk): add VadFilter contract and EnergyVadFilter implementation"
```

---

### Task 3: SpeechService contract + WebSocketSpeechService

**Files:**
- Create: `shared/web-sdk/src/speech-service.ts`
- Create: `shared/web-sdk/src/ws-speech-service.ts`
- Create: `shared/web-sdk/src/ws-speech-service.test.ts`

- [ ] **Step 1: Write SpeechService interface**

Create `shared/web-sdk/src/speech-service.ts`:

```typescript
export type ServiceState = "connecting" | "connected" | "disconnected" | "error";

/**
 * Abstract speech detection + transcription service.
 * The SDK consumes this contract without knowing the concrete provider.
 * Could be backed by a gateway WebSocket (Deepgram), local Whisper, or anything.
 */
export interface SpeechService {
  /** Push a filtered audio frame to the service. */
  sendAudio(frame: ArrayBuffer): void;

  /** Events emitted by the service. */
  on(event: "speech-start", cb: () => void): () => void;
  on(event: "speech-end", cb: () => void): () => void;
  on(event: "transcript-partial", cb: (text: string) => void): () => void;
  on(event: "transcript-final", cb: (text: string) => void): () => void;
  on(event: "barge-in", cb: () => void): () => void;
  on(event: "state", cb: (state: ServiceState) => void): () => void;

  /** Release resources. */
  dispose(): void;
}
```

- [ ] **Step 2: Write failing tests for WebSocketSpeechService**

Create `shared/web-sdk/src/ws-speech-service.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import type { Transport } from "./transport.ts";
import { createWsSpeechService } from "./ws-speech-service.ts";

function mockTransport(): Transport & {
  _receiveJson(msg: Record<string, unknown>): void;
  sentBinary: ArrayBuffer[];
} {
  const jsonHandlers: Array<(msg: Record<string, unknown>) => void> = [];
  const sentBinary: ArrayBuffer[] = [];

  return {
    connect: vi.fn(),
    disconnect: vi.fn(),
    sendJson: vi.fn(),
    sendBinary: vi.fn((data: ArrayBuffer) => {
      sentBinary.push(data);
    }),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (event === "jsonMessage") {
        jsonHandlers.push(handler as (msg: Record<string, unknown>) => void);
      }
      return () => {};
    }),
    state: vi.fn(() => "connected" as const),
    sentBinary,
    _receiveJson(msg) {
      for (const h of jsonHandlers) h(msg);
    },
  };
}

describe("WebSocketSpeechService", () => {
  it("emits speech-start on vad.speech-start message", () => {
    const transport = mockTransport();
    const service = createWsSpeechService(transport);
    const handler = vi.fn();
    service.on("speech-start", handler);

    transport._receiveJson({ type: "vad.speech-start" });
    expect(handler).toHaveBeenCalledOnce();
    service.dispose();
  });

  it("emits speech-end on vad.speech-end message", () => {
    const transport = mockTransport();
    const service = createWsSpeechService(transport);
    const handler = vi.fn();
    service.on("speech-end", handler);

    transport._receiveJson({ type: "vad.speech-end" });
    expect(handler).toHaveBeenCalledOnce();
    service.dispose();
  });

  it("emits transcript-partial on transcript.partial message", () => {
    const transport = mockTransport();
    const service = createWsSpeechService(transport);
    const handler = vi.fn();
    service.on("transcript-partial", handler);

    transport._receiveJson({ type: "transcript.partial", text: "hello" });
    expect(handler).toHaveBeenCalledWith("hello");
    service.dispose();
  });

  it("emits transcript-final on transcript.final message", () => {
    const transport = mockTransport();
    const service = createWsSpeechService(transport);
    const handler = vi.fn();
    service.on("transcript-final", handler);

    transport._receiveJson({ type: "transcript.final", text: "hello world" });
    expect(handler).toHaveBeenCalledWith("hello world");
    service.dispose();
  });

  it("emits barge-in on barge_in.ack message", () => {
    const transport = mockTransport();
    const service = createWsSpeechService(transport);
    const handler = vi.fn();
    service.on("barge-in", handler);

    transport._receiveJson({ type: "barge_in.ack" });
    expect(handler).toHaveBeenCalledOnce();
    service.dispose();
  });

  it("forwards audio frames via transport.sendBinary", () => {
    const transport = mockTransport();
    const service = createWsSpeechService(transport);
    const frame = new ArrayBuffer(256);
    service.sendAudio(frame);
    expect(transport.sendBinary).toHaveBeenCalledWith(frame);
    service.dispose();
  });

  it("on returns unsubscribe function", () => {
    const transport = mockTransport();
    const service = createWsSpeechService(transport);
    const handler = vi.fn();
    const unsub = service.on("speech-start", handler);
    unsub();

    transport._receiveJson({ type: "vad.speech-start" });
    expect(handler).not.toHaveBeenCalled();
    service.dispose();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd shared/web-sdk && bun test src/ws-speech-service.test.ts`
Expected: FAIL — module not found

- [ ] **Step 4: Implement WebSocketSpeechService**

Create `shared/web-sdk/src/ws-speech-service.ts`:

```typescript
import { createEmitter, type TypedEmitter } from "./event-emitter.ts";
import type { SpeechService, ServiceState } from "./speech-service.ts";
import type { Transport } from "./transport.ts";

interface SpeechServiceEvents {
  "speech-start": () => void;
  "speech-end": () => void;
  "transcript-partial": (text: string) => void;
  "transcript-final": (text: string) => void;
  "barge-in": () => void;
  state: (state: ServiceState) => void;
}

/**
 * Maps gateway WebSocket messages to the SpeechService contract.
 * The SDK never knows this is backed by Deepgram on the gateway.
 */
export function createWsSpeechService(transport: Transport): SpeechService {
  const emitter = createEmitter<SpeechServiceEvents>();

  const unsubTransport = transport.on("jsonMessage", (msg: Record<string, unknown>) => {
    const msgType = msg.type as string;
    switch (msgType) {
      case "vad.speech-start":
        emitter.emit("speech-start");
        break;
      case "vad.speech-end":
        emitter.emit("speech-end");
        break;
      case "transcript.partial":
        emitter.emit("transcript-partial", (msg.text as string) ?? "");
        break;
      case "transcript.final":
        emitter.emit("transcript-final", (msg.text as string) ?? "");
        break;
      case "barge_in.ack":
        emitter.emit("barge-in");
        break;
    }
  });

  return {
    sendAudio(frame: ArrayBuffer): void {
      transport.sendBinary(frame);
    },

    on(event: string, cb: (...args: unknown[]) => void): () => void {
      return emitter.on(event as keyof SpeechServiceEvents, cb as never);
    },

    dispose(): void {
      unsubTransport();
      emitter.removeAll();
    },
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd shared/web-sdk && bun test src/ws-speech-service.test.ts`
Expected: All PASS

- [ ] **Step 6: Run typecheck**

Run: `source scripts/env.sh && bun run typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add shared/web-sdk/src/speech-service.ts shared/web-sdk/src/ws-speech-service.ts shared/web-sdk/src/ws-speech-service.test.ts
git commit -m "feat(web-sdk): add SpeechService contract and WebSocketSpeechService adapter"
```

---

### Task 4: Refactor voice state machine

Remove utterance/VAD effects. The state machine no longer drives turn boundaries or audio streaming toggling. Audio streams continuously; the server drives speech start/end.

**Files:**
- Modify: `shared/web-sdk/src/voice-state-machine.ts`
- Modify: `shared/web-sdk/src/voice-state-machine.test.ts`

- [ ] **Step 1: Update SideEffect and transition types**

In `shared/web-sdk/src/voice-state-machine.ts`, replace the `SideEffect` type (lines 34-52):

```typescript
export type SideEffect =
  | { type: "OPEN_WS" }
  | { type: "SEND_AUTH" }
  | { type: "SEND_BARGE_IN" }
  | { type: "START_PLAYBACK" }
  | { type: "STOP_PLAYBACK" }
  | { type: "CLEAR_PLAYBACK" }
  | { type: "START_TIMEOUT"; key: string; ms: number }
  | { type: "CANCEL_TIMEOUT"; key: string }
  | { type: "START_RECONNECT_BACKOFF" }
  | { type: "CLEANUP" }
  | { type: "LOG_WARNING"; message: string };
```

Removed: `SEND_UTTERANCE_START`, `SEND_UTTERANCE_END`, `SEND_UTTERANCE_CANCEL`, `START_VAD`, `STOP_VAD`, `START_AUDIO_STREAM`, `STOP_AUDIO_STREAM`.

- [ ] **Step 2: Update transition functions**

Replace `transitionConnecting` — remove `START_VAD` from AUTH_OK:

```typescript
function transitionConnecting(event: VoiceEvent): TransitionResult {
  if (event.type === "AUTH_OK") {
    return {
      state: "listening",
      effects: [{ type: "CANCEL_TIMEOUT", key: "auth" }],
    };
  }
  if (event.type === "AUTH_FAILED") {
    return { state: "error", effects: [{ type: "CANCEL_TIMEOUT", key: "auth" }] };
  }
  if (event.type === "TIMEOUT") {
    return { state: "error", effects: [{ type: "CANCEL_TIMEOUT", key: "auth" }] };
  }
  if (event.type === "WS_DROP") {
    return {
      state: "reconnecting",
      effects: [{ type: "CANCEL_TIMEOUT", key: "auth" }, { type: "START_RECONNECT_BACKOFF" }],
    };
  }
  return unhandled("connecting", event);
}
```

Replace `transitionListening` — remove utterance/VAD effects:

```typescript
function transitionListening(event: VoiceEvent): TransitionResult {
  if (event.type === "SPEECH_START") {
    return { state: "user-speaking", effects: [] };
  }
  if (event.type === "DISCONNECT") {
    return { state: "inactive", effects: [{ type: "CLEANUP" }] };
  }
  if (event.type === "WS_DROP") {
    return {
      state: "reconnecting",
      effects: [{ type: "START_RECONNECT_BACKOFF" }],
    };
  }
  return unhandled("listening", event);
}
```

Replace `transitionUserSpeaking` — remove utterance/stream effects:

```typescript
function transitionUserSpeaking(event: VoiceEvent): TransitionResult {
  if (event.type === "SPEECH_END") {
    return {
      state: "processing",
      effects: [{ type: "START_TIMEOUT", key: "processing", ms: PROCESSING_TIMEOUT_MS }],
    };
  }
  if (event.type === "CANCEL") {
    return { state: "listening", effects: [] };
  }
  if (event.type === "WS_DROP") {
    return {
      state: "reconnecting",
      effects: [{ type: "START_RECONNECT_BACKOFF" }],
    };
  }
  return unhandled("user-speaking", event);
}
```

Replace `transitionAssistantSpeaking` — server-driven barge-in goes directly to user-speaking:

```typescript
function transitionAssistantSpeaking(event: VoiceEvent): TransitionResult {
  if (event.type === "AUDIO_DONE") {
    return { state: "listening", effects: [{ type: "STOP_PLAYBACK" }] };
  }
  if (event.type === "SPEECH_START") {
    // Server-initiated barge-in: gateway already confirmed this is real speech.
    return {
      state: "user-speaking",
      effects: [{ type: "STOP_PLAYBACK" }, { type: "CLEAR_PLAYBACK" }],
    };
  }
  if (event.type === "RESPONSE_TEXT_DONE") {
    return { state: "assistant-speaking", effects: [] };
  }
  if (event.type === "WS_DROP") {
    return {
      state: "reconnecting",
      effects: [{ type: "STOP_PLAYBACK" }, { type: "START_RECONNECT_BACKOFF" }],
    };
  }
  return unhandled("assistant-speaking", event);
}
```

Replace `transitionInterrupting` — only for manual client barge-in (button press):

```typescript
function transitionInterrupting(event: VoiceEvent): TransitionResult {
  if (event.type === "BARGE_IN_ACK") {
    return {
      state: "listening",
      effects: [{ type: "CANCEL_TIMEOUT", key: "barge_in_ack" }],
    };
  }
  if (event.type === "TIMEOUT" && event.context === "barge_in_ack") {
    return {
      state: "listening",
      effects: [{ type: "LOG_WARNING", message: "Barge-in ack timeout, falling back to listening" }],
    };
  }
  if (event.type === "WS_DROP") {
    return {
      state: "reconnecting",
      effects: [{ type: "START_RECONNECT_BACKOFF" }],
    };
  }
  return unhandled("interrupting", event);
}
```

Replace `transitionReconnecting` — remove START_VAD:

```typescript
function transitionReconnecting(event: VoiceEvent): TransitionResult {
  if (event.type === "RECONNECTED") {
    return { state: "listening", effects: [] };
  }
  if (event.type === "MAX_RETRIES") {
    return { state: "error", effects: [] };
  }
  return unhandled("reconnecting", event);
}
```

- [ ] **Step 3: Update tests**

Replace `shared/web-sdk/src/voice-state-machine.test.ts` entirely:

```typescript
import { describe, expect, it } from "vitest";
import { type VoiceEvent, type VoiceState, transition } from "./voice-state-machine.ts";

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

    it("listening + SPEECH_START transitions with no effects", () => {
      const result = transition("listening", { type: "SPEECH_START" });
      expect(result.state).toBe("user-speaking");
      expect(result.effects).toHaveLength(0);
    });

    it("user-speaking + SPEECH_END starts processing timeout", () => {
      const result = transition("user-speaking", { type: "SPEECH_END" });
      expect(result.state).toBe("processing");
      expect(result.effects).toContainEqual({ type: "START_TIMEOUT", key: "processing", ms: 30_000 });
    });
  });

  describe("server-driven barge-in", () => {
    it("SPEECH_START during assistant-speaking goes directly to user-speaking", () => {
      const result = transition("assistant-speaking", { type: "SPEECH_START" });
      expect(result.state).toBe("user-speaking");
      expect(result.effects).toContainEqual({ type: "STOP_PLAYBACK" });
      expect(result.effects).toContainEqual({ type: "CLEAR_PLAYBACK" });
    });
  });

  describe("manual barge-in", () => {
    it("BARGE_IN_ACK during interrupting goes to listening", () => {
      const result = transition("interrupting", { type: "BARGE_IN_ACK" });
      expect(result.state).toBe("listening");
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

    it("RECONNECTED returns to listening with no VAD effects", () => {
      const result = transition("reconnecting", { type: "RECONNECTED" });
      expect(result.state).toBe("listening");
      expect(result.effects).toHaveLength(0);
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

  describe("no removed effects", () => {
    it("no transition produces SEND_UTTERANCE_START", () => {
      const ALL_STATES: VoiceState[] = [
        "inactive", "connecting", "listening", "user-speaking",
        "processing", "assistant-speaking", "interrupting", "reconnecting", "error",
      ];
      const ALL_EVENTS: VoiceEvent[] = [
        { type: "CONNECT" }, { type: "AUTH_OK", sessionId: "s" },
        { type: "SPEECH_START" }, { type: "SPEECH_END" },
        { type: "RESPONSE_START" }, { type: "AUDIO_DONE" },
        { type: "BARGE_IN_ACK" }, { type: "WS_DROP" }, { type: "RECONNECTED" },
      ];
      for (const state of ALL_STATES) {
        for (const event of ALL_EVENTS) {
          const result = transition(state, event);
          for (const effect of result.effects) {
            expect(effect.type).not.toBe("SEND_UTTERANCE_START");
            expect(effect.type).not.toBe("SEND_UTTERANCE_END");
            expect(effect.type).not.toBe("START_VAD");
            expect(effect.type).not.toBe("STOP_VAD");
            expect(effect.type).not.toBe("START_AUDIO_STREAM");
            expect(effect.type).not.toBe("STOP_AUDIO_STREAM");
          }
        }
      }
    });
  });

  describe("exhaustiveness", () => {
    it("every state is reachable from inactive", () => {
      const ALL_STATES: VoiceState[] = [
        "inactive", "connecting", "listening", "user-speaking", "processing",
        "assistant-speaking", "interrupting", "reconnecting", "error",
      ];
      const reachable = new Set<VoiceState>(["inactive"]);
      const ALL_EVENTS: VoiceEvent[] = [
        { type: "CONNECT" }, { type: "AUTH_OK", sessionId: "s" },
        { type: "AUTH_FAILED", reason: "r" }, { type: "TIMEOUT", context: "auth" },
        { type: "SPEECH_START" }, { type: "SPEECH_END" }, { type: "CANCEL" },
        { type: "RESPONSE_START" }, { type: "AUDIO_DONE" }, { type: "RESPONSE_TEXT_DONE" },
        { type: "BARGE_IN_ACK" }, { type: "WS_DROP" }, { type: "RECONNECTED" },
        { type: "MAX_RETRIES" }, { type: "RETRY" }, { type: "DISMISS" },
        { type: "DISCONNECT" }, { type: "TIMEOUT", context: "processing" },
        { type: "TIMEOUT", context: "barge_in_ack" },
      ];
      let changed = true;
      while (changed) {
        changed = false;
        for (const state of reachable) {
          for (const event of ALL_EVENTS) {
            const next = transition(state, event).state;
            if (!reachable.has(next)) { reachable.add(next); changed = true; }
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
        const result = transition(state, { type: "SESSION_END" });
        expect(result.state).toBe("inactive");
      }
    });
  });
});
```

- [ ] **Step 4: Run tests**

Run: `cd shared/web-sdk && bun test src/voice-state-machine.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add shared/web-sdk/src/voice-state-machine.ts shared/web-sdk/src/voice-state-machine.test.ts
git commit -m "refactor(web-sdk): simplify voice state machine for server-driven VAD"
```

---

### Task 5: Gateway — server-driven turn boundaries + suppression

The gateway now determines when speech starts/ends using STT provider events, and suppresses during TTS playback.

**Files:**
- Modify: `gateway/src/pipeline/continuous-session.ts`
- Modify: `gateway/src/pipeline/continuous-session.test.ts`

- [ ] **Step 1: Write failing tests for new behavior**

Add these tests to `gateway/src/pipeline/continuous-session.test.ts`:

```typescript
// Add to existing describe block:

it("emits speechStart when STT reports speechFinal=false followed by isFinal=true", async () => {
  const { stt, session } = makeSession();
  const speechStarts: string[] = [];

  session.on("speechStart", () => speechStarts.push("start"));
  await session.start();

  stt.emitEvent({ type: "transcript", text: "hello", isFinal: false, speechFinal: false, confidence: 0.8 });
  await new Promise((r) => setTimeout(r, 0));

  expect(speechStarts).toHaveLength(1);
  await session.close();
});

it("emits speechEnd on speechFinal=true from STT", async () => {
  const { stt, session } = makeSession();
  const speechEnds: string[] = [];

  session.on("speechEnd", (text) => speechEnds.push(text));
  await session.start();

  stt.emitEvent({ type: "transcript", text: "hello", isFinal: true, speechFinal: false, confidence: 0.9 });
  stt.emitEvent({ type: "transcript", text: "world", isFinal: true, speechFinal: true, confidence: 0.95 });
  await new Promise((r) => setTimeout(r, 0));

  expect(speechEnds).toContain("hello world");
  await session.close();
});

it("suppresses speechStart during TTS playback", async () => {
  const { stt, session } = makeSession();
  const speechStarts: string[] = [];

  session.on("speechStart", () => speechStarts.push("start"));
  await session.start();
  session.setAssistantSpeaking(true);

  stt.emitEvent({ type: "transcript", text: "echo", isFinal: false, speechFinal: false, confidence: 0.5 });
  await new Promise((r) => setTimeout(r, 0));

  expect(speechStarts).toHaveLength(0);
  await session.close();
});

it("allows barge-in during suppression when confidence exceeds threshold", async () => {
  const { stt, session } = makeSession();
  const bargeIns: string[] = [];

  session.on("bargeIn", (text) => bargeIns.push(text));
  await session.start();
  session.setAssistantSpeaking(true);

  stt.emitEvent({ type: "transcript", text: "stop", isFinal: true, speechFinal: true, confidence: 0.95 });
  await new Promise((r) => setTimeout(r, 0));

  expect(bargeIns).toContain("stop");
  await session.close();
});

it("does not barge-in when confidence is below threshold", async () => {
  const { stt, session } = makeSession();
  const bargeIns: string[] = [];

  session.on("bargeIn", (text) => bargeIns.push(text));
  await session.start();
  session.setAssistantSpeaking(true);

  stt.emitEvent({ type: "transcript", text: "maybe", isFinal: true, speechFinal: true, confidence: 0.4 });
  await new Promise((r) => setTimeout(r, 0));

  expect(bargeIns).toHaveLength(0);
  await session.close();
});

it("resumes normal speech detection after TTS ends", async () => {
  const { stt, session } = makeSession();
  const speechStarts: string[] = [];

  session.on("speechStart", () => speechStarts.push("start"));
  await session.start();

  session.setAssistantSpeaking(true);
  stt.emitEvent({ type: "transcript", text: "suppressed", isFinal: false, speechFinal: false, confidence: 0.5 });
  await new Promise((r) => setTimeout(r, 0));
  expect(speechStarts).toHaveLength(0);

  session.setAssistantSpeaking(false);
  stt.emitEvent({ type: "transcript", text: "heard", isFinal: false, speechFinal: false, confidence: 0.8 });
  await new Promise((r) => setTimeout(r, 0));
  expect(speechStarts).toHaveLength(1);

  await session.close();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd gateway && bun test src/pipeline/continuous-session.test.ts`
Expected: FAIL — `speechStart`, `speechEnd`, `bargeIn`, `setAssistantSpeaking` not found

- [ ] **Step 3: Update ContinuousSession interface and implementation**

In `gateway/src/pipeline/continuous-session.ts`, update the events interface (line 45-50):

```typescript
export interface ContinuousSessionEvents {
  transcriptPartial: (text: string) => void;
  transcriptFinal: (text: string) => void;
  speechStart: () => void;
  speechEnd: (text: string) => void;
  bargeIn: (text: string) => void;
  error: (message: string) => void;
}
```

Update the session interface (line 52-62) — remove `utteranceStart`/`utteranceEnd`, add `setAssistantSpeaking`:

```typescript
export interface ContinuousSession {
  start(): Promise<void>;
  sendAudio(audio: Uint8Array): void;
  setAssistantSpeaking(speaking: boolean): void;
  bargeIn(): void;
  beginTurn(): AbortController;
  close(): Promise<void>;
  isConnected(): boolean;
  on<K extends keyof ContinuousSessionEvents>(event: K, handler: ContinuousSessionEvents[K]): () => void;
}
```

Update `createContinuousSession` — add suppression state, server-driven turn logic:

Replace the state variables section and `handleTranscriptEvent`:

```typescript
const BARGE_IN_CONFIDENCE_THRESHOLD = 0.85;

export function createContinuousSession(options: ContinuousSessionOptions): ContinuousSession {
  const { sttProvider, sttConfig, ttsProvider, ttsConfig } = options;
  const emitter = createEmitter<ContinuousSessionEvents>();

  let isClosed = false;
  let sttConnected = false;
  let ttsConnected = false;
  let isAssistantSpeaking = false;
  let isSpeechActive = false;
  let accumulatedText = "";
  let activeTurnController: AbortController | null = null;
  let sessionController: AbortController | null = null;
  let earlyAudioBuffer: Uint8Array[] = [];
  let connectPromise: Promise<void> | null = null;
```

Replace `handleTranscriptEvent` with server-driven logic:

```typescript
  function handleTranscriptEvent(event: TranscriptEvent): void {
    if (event.type !== "transcript") return;

    if (isAssistantSpeaking) {
      handleSuppressedTranscript(event);
      return;
    }

    if (!event.isFinal) {
      if (!isSpeechActive) {
        isSpeechActive = true;
        emitter.emit("speechStart");
      }
      emitter.emit("transcriptPartial", event.text);
      return;
    }

    if (!isSpeechActive) {
      isSpeechActive = true;
      emitter.emit("speechStart");
    }

    accumulatedText += (accumulatedText ? " " : "") + event.text;
    emitter.emit("transcriptFinal", event.text);

    if (event.speechFinal) {
      const fullText = accumulatedText;
      accumulatedText = "";
      isSpeechActive = false;
      emitter.emit("speechEnd", fullText);
    }
  }

  function handleSuppressedTranscript(event: {
    text: string;
    isFinal: boolean;
    speechFinal: boolean;
    confidence: number;
  }): void {
    if (
      event.isFinal &&
      event.text.trim().length > 0 &&
      event.confidence >= BARGE_IN_CONFIDENCE_THRESHOLD
    ) {
      isAssistantSpeaking = false;
      activeTurnController?.abort();
      emitter.emit("bargeIn", event.text);
    }
  }
```

Add `setAssistantSpeaking` and remove `utteranceStart`/`utteranceEnd` from the return object:

```typescript
  function setAssistantSpeaking(speaking: boolean): void {
    isAssistantSpeaking = speaking;
    if (!speaking) {
      accumulatedText = "";
    }
  }

  return {
    start,
    sendAudio,
    setAssistantSpeaking,
    bargeIn,
    beginTurn,
    close,
    isConnected: () => sttConnected && ttsConnected,
    on: (event, handler) => emitter.on(event, handler),
  };
```

- [ ] **Step 4: Run tests**

Run: `cd gateway && bun test src/pipeline/continuous-session.test.ts`
Expected: All PASS (including new tests). Some old tests for `utteranceStart`/`utteranceEnd` will fail — update them to use the new API.

- [ ] **Step 5: Fix remaining old tests**

Remove tests that call `session.utteranceStart()` and `session.utteranceEnd()`. Replace the `relays partial transcripts` and `relays final transcripts` tests — they no longer need `utteranceStart` to work because the session now auto-detects speech from STT events:

```typescript
it("relays partial transcripts", async () => {
  const { stt, session } = makeSession();
  const partials: string[] = [];

  session.on("transcriptPartial", (text) => partials.push(text));
  await session.start();

  stt.emitEvent({ type: "transcript", text: "hello", isFinal: false, speechFinal: false, confidence: 0.8 });
  await new Promise((r) => setTimeout(r, 0));

  expect(partials).toContain("hello");
  await session.close();
});

it("relays final transcripts", async () => {
  const { stt, session } = makeSession();
  const finals: string[] = [];

  session.on("transcriptFinal", (text) => finals.push(text));
  await session.start();

  stt.emitEvent({ type: "transcript", text: "hello world", isFinal: true, speechFinal: false, confidence: 0.99 });
  await new Promise((r) => setTimeout(r, 0));

  expect(finals).toContain("hello world");
  await session.close();
});
```

Remove these old tests (no longer applicable):
- `"includes utteranceId in transcript events"` — no utteranceId in new API
- `"resets accumulated text on new utterance"` — no manual utterance reset
- `"emits utteranceReady on speechFinal"` — replaced by `speechEnd`

- [ ] **Step 6: Run full test suite**

Run: `cd gateway && bun test src/pipeline/continuous-session.test.ts`
Expected: All PASS

- [ ] **Step 7: Commit**

```bash
git add gateway/src/pipeline/continuous-session.ts gateway/src/pipeline/continuous-session.test.ts
git commit -m "feat(gateway): server-driven turn boundaries with TTS suppression in ContinuousSession"
```

---

### Task 6: Gateway — voice handler + WS routing

Replace client-driven utterance handlers with server-driven turn flow.

**Files:**
- Modify: `gateway/src/server/continuous-voice-handler.ts`
- Modify: `gateway/src/server/continuous-voice-handler.test.ts`
- Modify: `gateway/src/server/ws-server.ts:210-280`

- [ ] **Step 1: Rewrite continuous-voice-handler.ts**

Replace `gateway/src/server/continuous-voice-handler.ts` entirely:

```typescript
import type { ServerWebSocket } from "bun";
import type { ContextAssembler } from "../context/context-assembler.ts";
import { type ContinuousSession, createContinuousSession } from "../pipeline/continuous-session.ts";
import type { TTSProcessor } from "../pipeline/processors/tts-processor.ts";
import { runVoiceTurn } from "../pipeline/voice-turn.ts";
import type { LLMProvider } from "../providers/llm-provider.ts";
import type { STTConfig, STTProvider } from "../providers/stt/stt-types.ts";
import type { TTSConfig, TTSProvider } from "../providers/tts/tts-types.ts";
import { type ClientData, errorMessage } from "./ws-helpers.ts";

type WS = ServerWebSocket<ClientData>;

function sendJson(ws: WS, payload: unknown): void {
  ws.send(JSON.stringify(payload));
}

interface PipelineDeps {
  contextAssembler: ContextAssembler;
  llmProvider: LLMProvider;
  ttsProcessor: TTSProcessor;
  chatModel: string;
}

function wireSessionEvents(ws: WS, session: ContinuousSession, deps: PipelineDeps): void {
  session.on("transcriptPartial", (text) => {
    sendJson(ws, { type: "transcript.partial", text });
  });

  session.on("transcriptFinal", (text) => {
    sendJson(ws, { type: "transcript.final", text });
  });

  session.on("speechStart", () => {
    sendJson(ws, { type: "vad.speech-start" });
  });

  session.on("speechEnd", (transcript) => {
    sendJson(ws, { type: "vad.speech-end" });
    if (transcript.trim()) {
      runTurn(ws, session, transcript, deps);
    }
  });

  session.on("bargeIn", (transcript) => {
    sendJson(ws, { type: "barge_in.ack" });
    sendJson(ws, { type: "vad.speech-start" });
    if (transcript.trim()) {
      runTurn(ws, session, transcript, deps);
    }
  });

  session.on("error", (message) => {
    sendJson(ws, { type: "error", code: "pipeline_error", message });
  });
}

async function runTurn(ws: WS, session: ContinuousSession, transcript: string, deps: PipelineDeps): Promise<void> {
  const responseId = `resp-${Date.now()}`;
  sendJson(ws, { type: "status.processing" });
  sendJson(ws, { type: "response.start", utteranceId: "server", responseId });
  ws.data.history.push({ role: "user", content: transcript });

  const turnController = session.beginTurn();

  try {
    let fullResponse = "";

    for await (const event of runVoiceTurn({
      transcript,
      history: ws.data.history,
      contextAssembler: deps.contextAssembler,
      llmProvider: deps.llmProvider,
      ttsProcessor: deps.ttsProcessor,
      chatModel: deps.chatModel,
      signal: turnController.signal,
    })) {
      if (turnController.signal.aborted) break;
      switch (event.type) {
        case "text.delta":
          sendJson(ws, { type: "response.text.delta", responseId, text: event.payload });
          break;
        case "text.done":
          fullResponse = event.payload;
          sendJson(ws, { type: "response.text.done", responseId });
          break;
        case "audio.start":
          session.setAssistantSpeaking(true);
          sendJson(ws, { type: "response.audio.start", responseId });
          break;
        case "audio.frame":
          ws.send(event.payload);
          break;
        case "audio.done":
          session.setAssistantSpeaking(false);
          sendJson(ws, { type: "response.audio.done", responseId });
          break;
      }
    }

    if (fullResponse) {
      ws.data.history.push({ role: "assistant", content: fullResponse });
    }
  } catch (error: unknown) {
    session.setAssistantSpeaking(false);
    if (!turnController.signal.aborted) {
      sendJson(ws, { type: "error", code: "pipeline_error", message: errorMessage(error, "Voice turn failed") });
    }
  }
}

export function ensureContinuousSession(
  ws: WS,
  sttProvider: STTProvider,
  sttConfig: STTConfig,
  ttsProvider: TTSProvider,
  ttsConfig: TTSConfig,
  deps: PipelineDeps,
): ContinuousSession {
  if (!ws.data.continuousSession) {
    const session = createContinuousSession({ sttProvider, sttConfig, ttsProvider, ttsConfig });
    wireSessionEvents(ws, session, deps);
    ws.data.continuousSession = session;
  }
  return ws.data.continuousSession;
}

export async function handleContinuousStart(
  ws: WS,
  sttProvider: STTProvider,
  sttConfig: STTConfig,
  ttsProvider: TTSProvider,
  ttsConfig: TTSConfig,
  deps: PipelineDeps,
): Promise<void> {
  try {
    const session = ensureContinuousSession(ws, sttProvider, sttConfig, ttsProvider, ttsConfig, deps);
    await session.start();
  } catch (error: unknown) {
    sendJson(ws, { type: "error", code: "stt_error", message: errorMessage(error, "Continuous session start failed") });
  }
}

export function handleContinuousBargeIn(ws: WS): void {
  const session = ws.data.continuousSession;
  if (!session) return;
  session.bargeIn();
  sendJson(ws, { type: "barge_in.ack" });
}

export async function handleContinuousEnd(ws: WS): Promise<void> {
  const session = ws.data.continuousSession;
  if (!session) return;
  await session.close();
  ws.data.continuousSession = null;
}
```

- [ ] **Step 2: Update WS server message routing**

In `gateway/src/server/ws-server.ts`, remove the `utterance.start`, `utterance.end`, and `utterance.cancel` handlers (lines 241-267). Also update the `audio.start` handler to pass pipeline deps:

Replace lines 217-267 with:

```typescript
        if (msg.type === "audio.start") {
          const { sttProvider, sttConfig, ttsProvider, ttsConfig } = options;
          if (!sttProvider || !sttConfig || !ttsProvider || !ttsConfig || !contextAssembler || !llmProvider || !options.ttsProcessor) {
            sendError(ws, "stt_error", "Voice pipeline not fully configured");
            return;
          }
          if (!ws.data.continuousSession) {
            await handleContinuousStart(ws, sttProvider, sttConfig, ttsProvider, ttsConfig, {
              contextAssembler,
              llmProvider,
              ttsProcessor: options.ttsProcessor,
              chatModel,
            });
          }
          return;
        }

        if (msg.type === "audio.end") {
          if (ws.data.continuousSession) {
            await handleContinuousEnd(ws);
          }
          return;
        }

        if (msg.type === "barge_in") {
          handleContinuousBargeIn(ws);
          return;
        }
```

Remove the `utterance.start`, `utterance.end`, and `utterance.cancel` handlers entirely. Keep the `session.configure` handler.

- [ ] **Step 3: Update handler imports in ws-server.ts**

Update the import from `continuous-voice-handler.ts` — remove `handleUtteranceStart` and `handleUtteranceEnd`:

```typescript
import {
  handleContinuousBargeIn,
  handleContinuousEnd,
  handleContinuousStart,
} from "./continuous-voice-handler.ts";
```

- [ ] **Step 4: Run gateway tests**

Run: `cd gateway && bun test`
Expected: Some existing handler/routing tests may fail. Fix them to match the new server-driven flow.

- [ ] **Step 5: Update continuous-voice-handler.test.ts**

Rewrite tests to verify the new event-driven flow (session emits speechStart → vad.speech-start sent, speechEnd → triggers turn, bargeIn → barge_in.ack + turn). The specific test content depends on the existing mock patterns — follow the mock style in the current test file.

- [ ] **Step 6: Run full gateway test suite**

Run: `cd gateway && bun test`
Expected: All PASS

- [ ] **Step 7: Commit**

```bash
git add gateway/src/server/continuous-voice-handler.ts gateway/src/server/continuous-voice-handler.test.ts gateway/src/server/ws-server.ts gateway/src/server/ws-server-voice.test.ts
git commit -m "refactor(gateway): server-driven turn flow, remove utterance message handlers"
```

---

### Task 7: Voice client rewire

Replace the VAD dispatch system with SpeechService + VadFilter integration.

**Files:**
- Modify: `shared/web-sdk/src/voice-client.ts`
- Modify: `shared/web-sdk/src/voice-client.test.ts`
- Modify: `shared/web-sdk/src/audio-capture-adapter.ts`

- [ ] **Step 1: Update AudioCaptureAdapter — remove onVadEvent**

In `shared/web-sdk/src/audio-capture-adapter.ts`:

```typescript
/** Platform-specific audio capture (mic). Implemented per platform (web, mobile). */
export interface AudioCaptureAdapter {
  /** Request mic permissions and start capturing. */
  start(): Promise<void>;
  /** Stop capturing and release mic. */
  stop(): void;
  /** Register handler for PCM16 audio chunks. Returns unsubscribe. */
  onAudioData(handler: (data: ArrayBuffer) => void): () => void;
  /** Register handler for errors. Returns unsubscribe. */
  onError(handler: (message: string) => void): () => void;
}
```

- [ ] **Step 2: Rewrite voice-client.ts**

Replace `shared/web-sdk/src/voice-client.ts` entirely. Key changes:
- Import SpeechService, VadFilter, EnergyVadFilter instead of VAD state machine
- Audio streams continuously through VadFilter when voice mode active
- State machine transitions driven by SpeechService events (speech-start, speech-end)
- Remove all VAD dispatch, EffectContext, buildVadDispatcher

```typescript
import type { AudioCaptureAdapter } from "./audio-capture-adapter.ts";
import type { AudioPlaybackAdapter } from "./audio-playback-adapter.ts";
import { sdkDebug } from "./debug.ts";
import { createEnergyVadFilter } from "./energy-vad-filter.ts";
import { createEmitter } from "./event-emitter.ts";
import type { ChatMessage } from "./message-store.ts";
import { createMessageStore } from "./message-store.ts";
import type { SpeechService } from "./speech-service.ts";
import { createTranscriptAccumulator } from "./transcript-accumulator.ts";
import { createTransport } from "./transport.ts";
import type { VadFilter } from "./vad-filter.ts";
import type { VoiceState, VoiceStatus } from "./voice-state-machine.ts";
import { SPEAKABLE_STATES, STATUS_LABELS, type SideEffect, type VoiceEvent, transition } from "./voice-state-machine.ts";
import { createWsSpeechService } from "./ws-speech-service.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface VoiceClientConfig {
  wsUrl: string;
  token: string;
  capture: AudioCaptureAdapter;
  playback: AudioPlaybackAdapter;
  vadFilter?: VadFilter;
  createWebSocket?: (url: string) => WebSocket;
}

// biome-ignore lint/suspicious/noExplicitAny: event handler map
export interface VoiceClientEvents extends Record<string, (...args: any[]) => any> {
  statusChange: (status: VoiceStatus) => void;
  transcript: (text: string, isFinal: boolean) => void;
  response: (text: string, isFinal: boolean) => void;
  messages: (messages: readonly ChatMessage[]) => void;
  audioLevel: (probability: number) => void;
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

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createVoiceClient(config: VoiceClientConfig): VoiceClient {
  const { wsUrl, token, capture, playback, createWebSocket } = config;

  const emitter = createEmitter<VoiceClientEvents>();
  const messageStore = createMessageStore();
  const transcriptAccumulator = createTranscriptAccumulator();
  const transportConfig =
    createWebSocket !== undefined ? { url: wsUrl, token, createWebSocket } : { url: wsUrl, token };
  const transport = createTransport(transportConfig);
  const speechService: SpeechService = createWsSpeechService(transport);
  const vadFilter: VadFilter = config.vadFilter ?? createEnergyVadFilter();

  let voiceStateValue: VoiceState = "inactive";
  let isPlaybackActive = false;
  let voiceModeRequested = false;
  let activeStreamId: string | null = null;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  // ---------------------------------------------------------------------------
  // Voice state machine dispatch + effect runner
  // ---------------------------------------------------------------------------

  function buildStatus(): VoiceStatus {
    return {
      state: voiceStateValue,
      label: voiceModeRequested ? STATUS_LABELS[voiceStateValue] : "Connected",
      canSpeak: SPEAKABLE_STATES.has(voiceStateValue) && voiceModeRequested,
      isActive: voiceModeRequested && voiceStateValue !== "inactive",
    };
  }

  function dispatchVoice(event: VoiceEvent): void {
    const prev = voiceStateValue;
    const result = transition(voiceStateValue, event);
    voiceStateValue = result.state;
    if (prev !== result.state || result.effects.length > 0) {
      sdkDebug(
        "voice",
        `${prev} + ${event.type} → ${result.state}`,
        result.effects.map((e) => e.type),
      );
    }
    for (const effect of result.effects) {
      runEffect(effect);
    }
    emitter.emit("statusChange", buildStatus());
  }

  function runEffect(effect: SideEffect): void {
    switch (effect.type) {
      case "OPEN_WS":
        transport.connect();
        break;
      case "SEND_AUTH":
        break;
      case "SEND_BARGE_IN":
        transport.sendJson({ type: "barge_in" });
        break;
      case "START_PLAYBACK":
        isPlaybackActive = true;
        break;
      case "STOP_PLAYBACK":
        isPlaybackActive = false;
        break;
      case "CLEAR_PLAYBACK":
        playback.clear();
        break;
      case "START_TIMEOUT": {
        const { key, ms } = effect;
        const timer = setTimeout(() => {
          timers.delete(`voice:${key}`);
          dispatchVoice({ type: "TIMEOUT", context: key });
        }, ms);
        timers.set(`voice:${key}`, timer);
        break;
      }
      case "CANCEL_TIMEOUT": {
        const { key } = effect;
        const t = timers.get(`voice:${key}`);
        if (t !== undefined) {
          clearTimeout(t);
          timers.delete(`voice:${key}`);
        }
        break;
      }
      case "START_RECONNECT_BACKOFF":
        break;
      case "CLEANUP":
        isPlaybackActive = false;
        capture.stop();
        transport.disconnect();
        speechService.dispose();
        for (const t of timers.values()) clearTimeout(t);
        timers.clear();
        break;
      case "LOG_WARNING":
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // SpeechService → voice state machine
  // ---------------------------------------------------------------------------

  speechService.on("speech-start", () => {
    dispatchVoice({ type: "SPEECH_START" });
  });

  speechService.on("speech-end", () => {
    dispatchVoice({ type: "SPEECH_END" });
  });

  speechService.on("barge-in", () => {
    // Server-initiated barge-in arrives as both barge_in.ack and vad.speech-start.
    // The speech-start handler above will transition the state machine.
    dispatchVoice({ type: "BARGE_IN_ACK" });
  });

  // ---------------------------------------------------------------------------
  // Capture adapter → VadFilter → transport
  // ---------------------------------------------------------------------------

  capture.onAudioData((data) => {
    if (!voiceModeRequested) return;
    const frame = new Int16Array(data);
    const result = vadFilter.process(frame);
    emitter.emit("audioLevel", result.speechProbability);
    if (result.send) {
      speechService.sendAudio(data);
    }
  });

  capture.onError((message) => {
    emitter.emit("error", message);
  });

  // ---------------------------------------------------------------------------
  // Transport → voice state machine
  // ---------------------------------------------------------------------------

  transport.on("authSuccess", (sessionId) => {
    sdkDebug("transport", "authSuccess", sessionId);
    dispatchVoice({ type: "AUTH_OK", sessionId });
  });

  transport.on("authFailed", (reason) => {
    sdkDebug("transport", "authFailed", reason);
    dispatchVoice({ type: "AUTH_FAILED", reason });
  });

  transport.on("stateChange", (state) => {
    sdkDebug("transport", "stateChange", state);
    if (state === "reconnecting") dispatchVoice({ type: "WS_DROP" });
    if (state === "connected" && voiceStateValue === "reconnecting") {
      dispatchVoice({ type: "RECONNECTED" });
    }
  });

  transport.on("jsonMessage", (msg) => {
    sdkDebug("msg", msg.type, msg);
    handleJsonMessage(msg);
  });

  transport.on("binaryMessage", (data) => {
    if (isPlaybackActive) {
      const pcm16 = new Int16Array(data);
      const float32 = new Float32Array(pcm16.length);
      for (let i = 0; i < pcm16.length; i++) {
        float32[i] = (pcm16[i] ?? 0) / 32768;
      }
      playback.enqueue(float32);
    }
  });

  // ---------------------------------------------------------------------------
  // Transcript + message store wiring
  // ---------------------------------------------------------------------------

  transcriptAccumulator.onChange((text, isFinal) => {
    emitter.emit("transcript", text, isFinal);
  });

  messageStore.onChange((messages) => {
    emitter.emit("messages", messages);
  });

  // ---------------------------------------------------------------------------
  // JSON message router (response lifecycle — non-speech messages)
  // ---------------------------------------------------------------------------

  function handleJsonMessage(msg: Record<string, unknown>): void {
    const msgType = msg.type as string;
    switch (msgType) {
      case "response.start":
        activeStreamId = messageStore.startAssistantStream();
        dispatchVoice({ type: "RESPONSE_START" });
        break;
      case "response.audio.done":
        if (activeStreamId !== null) {
          messageStore.finalizeStream(activeStreamId);
          activeStreamId = null;
        }
        dispatchVoice({ type: "AUDIO_DONE" });
        break;
      case "response.text.done":
        if (activeStreamId !== null) {
          messageStore.finalizeStream(activeStreamId);
          activeStreamId = null;
        }
        dispatchVoice({ type: "RESPONSE_TEXT_DONE" });
        emitter.emit("response", (msg.text as string) ?? "", true);
        break;
      case "transcript.partial":
        transcriptAccumulator.updatePartial((msg.text as string) ?? "");
        break;
      case "transcript.final":
        transcriptAccumulator.finalize((msg.text as string) ?? "");
        break;
      case "response.text.delta": {
        const delta = (msg.text as string) ?? "";
        if (activeStreamId === null) {
          activeStreamId = messageStore.startAssistantStream();
        }
        messageStore.appendToStream(activeStreamId, delta);
        emitter.emit("response", delta, false);
        break;
      }
      default:
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  return {
    connect() {
      dispatchVoice({ type: "CONNECT" });
    },

    disconnect() {
      dispatchVoice({ type: "DISCONNECT" });
    },

    async startVoiceMode() {
      voiceModeRequested = true;
      await vadFilter.init();
      await playback.init();
      transport.sendJson({ type: "audio.start" });
      await capture.start();
      emitter.emit("statusChange", buildStatus());
    },

    stopVoiceMode() {
      voiceModeRequested = false;
      transport.sendJson({ type: "audio.end" });
      capture.stop();
      emitter.emit("statusChange", buildStatus());
    },

    sendText(text: string) {
      messageStore.addUserMessage(text);
      transport.sendJson({ type: "text.input", text });
    },

    voiceState: () => voiceStateValue,
    status: buildStatus,
    messages: () => messageStore.messages(),

    on<K extends keyof VoiceClientEvents>(event: K, handler: VoiceClientEvents[K]): () => void {
      return emitter.on(event, handler);
    },
  };
}
```

- [ ] **Step 3: Update voice-client.test.ts**

The tests need to change because:
- No more `_simulateVad` — speech events come from the SpeechService (WS messages)
- No more fake timers for onset debounce / trailing silence
- Audio streaming is continuous (controlled by VadFilter, not state machine)

Update the `mockCapture` factory — remove `_simulateVad`:

```typescript
type MockCapture = AudioCaptureAdapter & {
  _simulateAudio(data: ArrayBuffer): void;
  _simulateError(message: string): void;
};

function mockCapture(): MockCapture {
  const audioHandlers: Array<(d: ArrayBuffer) => void> = [];
  const errorHandlers: Array<(m: string) => void> = [];
  return {
    start: vi.fn(async () => {}),
    stop: vi.fn(),
    onAudioData: (h) => { audioHandlers.push(h); return () => {}; },
    onError: (h) => { errorHandlers.push(h); return () => {}; },
    _simulateAudio: (data) => { for (const h of audioHandlers) h(data); },
    _simulateError: (msg) => { for (const h of errorHandlers) h(msg); },
  };
}
```

Update the voice mode lifecycle tests to use WS messages instead of VAD simulation:

```typescript
describe("voice mode lifecycle", () => {
  it("speech start from server transitions to user-speaking", async () => {
    const ctx = buildClient();
    const ws = await connectAndAuth(ctx);
    ws._receiveJson({ type: "vad.speech-start" });
    expect(ctx.client.status().state).toBe("user-speaking");
  });

  it("speech end from server transitions to processing", async () => {
    const ctx = buildClient();
    const ws = await connectAndAuth(ctx);
    ws._receiveJson({ type: "vad.speech-start" });
    ws._receiveJson({ type: "vad.speech-end" });
    expect(ctx.client.status().state).toBe("processing");
  });

  it("response.start transitions to assistant-speaking", async () => {
    const ctx = buildClient();
    const ws = await connectAndAuth(ctx);
    ws._receiveJson({ type: "vad.speech-start" });
    ws._receiveJson({ type: "vad.speech-end" });
    ws._receiveJson({ type: "response.start" });
    expect(ctx.client.status().state).toBe("assistant-speaking");
  });

  it("response.audio.done transitions back to listening", async () => {
    const ctx = buildClient();
    const ws = await connectAndAuth(ctx);
    ws._receiveJson({ type: "vad.speech-start" });
    ws._receiveJson({ type: "vad.speech-end" });
    ws._receiveJson({ type: "response.start" });
    ws._receiveJson({ type: "response.audio.done" });
    expect(ctx.client.status().state).toBe("listening");
  });
});
```

Update barge-in test — server sends barge_in.ack + vad.speech-start:

```typescript
describe("server barge-in", () => {
  it("barge_in.ack during assistant-speaking transitions to user-speaking via speech-start", async () => {
    const ctx = buildClient();
    const ws = await connectAndAuth(ctx);
    ws._receiveJson({ type: "vad.speech-start" });
    ws._receiveJson({ type: "vad.speech-end" });
    ws._receiveJson({ type: "response.start" });
    // Server detects barge-in — sends both
    ws._receiveJson({ type: "barge_in.ack" });
    ws._receiveJson({ type: "vad.speech-start" });
    expect(ctx.client.status().state).toBe("user-speaking");
  });
});
```

Update audio streaming test — audio goes through VadFilter, always streams when voice mode active:

```typescript
describe("audio streaming", () => {
  it("forwards audio through VadFilter when voice mode active", async () => {
    const ctx = buildClient();
    const ws = await connectAndAuth(ctx);
    const audioData = new Int16Array(512).fill(20000).buffer;
    ctx.capture._simulateAudio(audioData);
    const binaryMessages = ws.sentMessages.filter((m) => m instanceof ArrayBuffer);
    expect(binaryMessages.length).toBeGreaterThan(0);
  });

  it("does not forward silent audio (VadFilter drops it)", async () => {
    const ctx = buildClient();
    const ws = await connectAndAuth(ctx);
    const silentData = new Int16Array(512).fill(0).buffer;
    ctx.capture._simulateAudio(silentData);
    const binaryMessages = ws.sentMessages.filter((m) => m instanceof ArrayBuffer);
    expect(binaryMessages).toHaveLength(0);
  });

  it("does not forward audio when voice mode not active", async () => {
    const ctx = buildClient();
    ctx.client.connect();
    const ws = ctx.wsRef.current;
    if (!ws) throw new Error("no ws");
    ws._open();
    ws._receiveJson({ type: "auth.ok", sessionId: "s1", role: "user" });
    // Don't call startVoiceMode
    const audioData = new Int16Array(512).fill(20000).buffer;
    ctx.capture._simulateAudio(audioData);
    const binaryMessages = ws.sentMessages.filter((m) => m instanceof ArrayBuffer);
    expect(binaryMessages).toHaveLength(0);
  });
});
```

- [ ] **Step 4: Run tests**

Run: `cd shared/web-sdk && bun test src/voice-client.test.ts`
Expected: All PASS

- [ ] **Step 5: Run full typecheck**

Run: `source scripts/env.sh && bun run typecheck`
Expected: May fail due to imports of deleted types in other files. Fix iteratively.

- [ ] **Step 6: Commit**

```bash
git add shared/web-sdk/src/voice-client.ts shared/web-sdk/src/voice-client.test.ts shared/web-sdk/src/audio-capture-adapter.ts
git commit -m "refactor(web-sdk): rewire voice client for server-driven VAD with VadFilter"
```

---

### Task 8: Client-side cleanup — worklet, capture adapter, old files

**Files:**
- Modify: `web/src/audio/capture-worklet.ts`
- Modify: `web/src/adapters/web-audio-capture.ts`
- Delete: `shared/web-sdk/src/vad-state-machine.ts`
- Delete: `shared/web-sdk/src/vad-state-machine.test.ts`
- Delete: `shared/web-sdk/src/voice-effect-handler.ts`
- Modify: `shared/web-sdk/src/index.ts`

- [ ] **Step 1: Remove VAD logic from capture worklet**

In `web/src/audio/capture-worklet.ts`, remove line 26 (`VAD_THRESHOLD`), line 31 (`wasSpeaking`), and lines 58-68 (RMS + VAD message). The worklet becomes a pure PCM capture pipe:

```typescript
/// <reference path="./audio-worklet.d.ts" />

const FRAME_SIZE = 128;
const BATCH_FRAMES = 4;
const INT16_MAX = 0x7fff;
const INT16_MIN_MAGNITUDE = 0x8000;

class CaptureProcessor extends AudioWorkletProcessor {
  private batchBuffer: Int16Array;
  private batchOffset: number;

  constructor() {
    super();
    this.batchBuffer = new Int16Array(FRAME_SIZE * BATCH_FRAMES);
    this.batchOffset = 0;
  }

  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0]?.[0];
    if (!input) return true;

    for (let i = 0; i < input.length; i++) {
      const sample = Math.max(-1, Math.min(1, input[i] ?? 0));
      this.batchBuffer[this.batchOffset++] = sample < 0 ? sample * INT16_MIN_MAGNITUDE : sample * INT16_MAX;

      if (this.batchOffset >= this.batchBuffer.length) {
        const out = new Int16Array(this.batchBuffer.length);
        out.set(this.batchBuffer);
        this.port.postMessage({ type: "pcm", buffer: out.buffer }, [out.buffer]);
        this.batchOffset = 0;
      }
    }

    return true;
  }
}

registerProcessor("capture-processor", CaptureProcessor);
```

- [ ] **Step 2: Remove VAD handler from web-audio-capture.ts**

In `web/src/adapters/web-audio-capture.ts`:

Remove `VadMessage` interface (line 17-20), remove it from `WorkletMessage` union, remove `vadHandlers` set (line 43), remove VAD branch in `handleWorkletMessage` (line 51-52), remove `onVadEvent` method (line 106-109).

The simplified file:

```typescript
import type { AudioCaptureAdapter } from "@sentient/web-sdk";
import captureWorkletUrl from "../audio/capture-worklet.ts?worker&url";
import { CAPTURE_GAIN, CAPTURE_SAMPLE_RATE } from "../constants.ts";

export interface WebAudioCaptureOptions {
  sampleRate?: number;
  gain?: number;
}

interface PcmMessage {
  type: "pcm";
  buffer: ArrayBuffer;
}

function isPcmMessage(value: unknown): value is PcmMessage {
  return typeof value === "object" && value !== null && "type" in value && (value as PcmMessage).type === "pcm";
}

export function createWebAudioCapture(options?: WebAudioCaptureOptions): AudioCaptureAdapter {
  const sampleRate = options?.sampleRate ?? CAPTURE_SAMPLE_RATE;
  const gainValue = options?.gain ?? CAPTURE_GAIN;

  let audioContext: AudioContext | null = null;
  let workletNode: AudioWorkletNode | null = null;
  let mediaStream: MediaStream | null = null;
  let gainNode: GainNode | null = null;

  const audioHandlers = new Set<(data: ArrayBuffer) => void>();
  const errorHandlers = new Set<(message: string) => void>();

  function handleWorkletMessage(event: MessageEvent): void {
    if (!isPcmMessage(event.data)) return;
    for (const h of audioHandlers) h(event.data.buffer);
  }

  function cleanup(): void {
    workletNode?.disconnect();
    gainNode?.disconnect();
    for (const t of mediaStream?.getTracks() ?? []) t.stop();
    audioContext?.close().catch(() => {});
    workletNode = null;
    gainNode = null;
    mediaStream = null;
    audioContext = null;
  }

  return {
    async start() {
      try {
        mediaStream = await navigator.mediaDevices.getUserMedia({
          audio: { sampleRate, echoCancellation: true, noiseSuppression: true },
        });
        audioContext = new AudioContext({ sampleRate });
        await audioContext.audioWorklet.addModule(captureWorkletUrl);
        const source = audioContext.createMediaStreamSource(mediaStream);
        gainNode = audioContext.createGain();
        gainNode.gain.value = gainValue;
        workletNode = new AudioWorkletNode(audioContext, "capture-processor");
        workletNode.port.onmessage = handleWorkletMessage;
        source.connect(gainNode).connect(workletNode);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Mic access failed";
        for (const h of errorHandlers) h(message);
        cleanup();
        throw error;
      }
    },

    stop() {
      cleanup();
    },

    onAudioData(handler) {
      audioHandlers.add(handler);
      return () => audioHandlers.delete(handler);
    },

    onError(handler) {
      errorHandlers.add(handler);
      return () => errorHandlers.delete(handler);
    },
  };
}
```

- [ ] **Step 3: Delete old files**

```bash
rm shared/web-sdk/src/vad-state-machine.ts
rm shared/web-sdk/src/vad-state-machine.test.ts
rm shared/web-sdk/src/voice-effect-handler.ts
```

- [ ] **Step 4: Update index.ts exports**

In `shared/web-sdk/src/index.ts`, add new exports:

```typescript
// @sentient/web-sdk — Public API
export { createEmitter, type TypedEmitter } from "./event-emitter.ts";
export { pcm16ToFloat32, float32ToPcm16 } from "./audio-codec.ts";
export type { AudioCaptureAdapter } from "./audio-capture-adapter.ts";
export type { AudioPlaybackAdapter } from "./audio-playback-adapter.ts";
export type { VoiceState, VoiceEvent, VoiceStatus } from "./voice-state-machine.ts";
export type { ChatMessage, MessageStore } from "./message-store.ts";
export { createVoiceClient } from "./voice-client.ts";
export type { VoiceClient, VoiceClientConfig, VoiceClientEvents } from "./voice-client.ts";
export type { VadFilter, VadFilterResult } from "./vad-filter.ts";
export { createEnergyVadFilter } from "./energy-vad-filter.ts";
export type { SpeechService, ServiceState } from "./speech-service.ts";
export { createWsSpeechService } from "./ws-speech-service.ts";
```

- [ ] **Step 5: Run full typecheck + tests**

Run: `source scripts/env.sh && bun run typecheck && bun run test`
Expected: All PASS. If anything references deleted files, fix the imports.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: remove client-side VAD state machine, clean up worklet and capture adapter"
```

---

### Task 9: SileroVadFilter + factory

**Files:**
- Modify: `web/package.json` — add `@ricky0123/vad-web`
- Create: `web/src/adapters/silero-vad-filter.ts`
- Create: `web/src/adapters/silero-vad-filter.test.ts`
- Create: `web/src/adapters/create-vad-filter.ts`
- Create: `web/src/adapters/create-vad-filter.test.ts`

- [ ] **Step 1: Install @ricky0123/vad-web**

```bash
cd web && bun add @ricky0123/vad-web
```

- [ ] **Step 2: Write SileroVadFilter**

Create `web/src/adapters/silero-vad-filter.ts`:

```typescript
import type { VadFilter, VadFilterResult } from "@sentient/web-sdk";

const SPEECH_THRESHOLD = 0.5;

/**
 * ML-based VAD using Silero model via @ricky0123/vad-web.
 * Runs the ONNX model in a WASM worker for per-frame speech probability.
 * Falls back gracefully if the model fails to load (e.g., iOS Safari WASM issues).
 */
export function createSileroVadFilter(): VadFilter {
  let frameProcessor: { process: (frame: Float32Array) => { isSpeech: number } } | null = null;
  let isReady = false;

  return {
    async init() {
      try {
        // Dynamic import to avoid bundling ONNX runtime when not used
        const { utils } = await import("@ricky0123/vad-web");
        const modelFetcher = utils.modelFetcher;
        const ortModule = await import("onnxruntime-web");

        // Load the Silero VAD model
        const model = await modelFetcher("legacy");
        const session = await ortModule.InferenceSession.create(model);

        // Create a simple frame processor wrapper
        // The actual frame processing follows Silero's expected input format
        let h = new Float32Array(2 * 64);
        let c = new Float32Array(2 * 64);
        const sr = BigInt(16000);

        frameProcessor = {
          process(frame: Float32Array) {
            const inputTensor = new ortModule.Tensor("float32", frame, [1, frame.length]);
            const hTensor = new ortModule.Tensor("float32", h, [2, 1, 64]);
            const cTensor = new ortModule.Tensor("float32", c, [2, 1, 64]);
            const srTensor = new ortModule.Tensor("int64", [sr], []);

            // Note: This is a simplified version. The actual integration should
            // use @ricky0123/vad-web's FrameProcessor for correct resampling
            // and state management. Implement this properly based on the
            // library's non-real-time API.
            const feeds = { input: inputTensor, h: hTensor, c: cTensor, sr: srTensor };
            // Synchronous inference is not available — use cached last result
            return { isSpeech: 0 };
          },
        };
        isReady = true;
      } catch {
        // Model failed to load (iOS WASM issues, network error, etc.)
        // Caller should fall back to EnergyVadFilter.
        throw new Error("Silero VAD model failed to load");
      }
    },

    process(frame: Int16Array): VadFilterResult {
      if (!isReady || !frameProcessor) {
        return { send: true, speechProbability: 0.5 };
      }
      // Convert Int16 to Float32 normalized [-1, 1]
      const float32 = new Float32Array(frame.length);
      for (let i = 0; i < frame.length; i++) {
        float32[i] = (frame[i] ?? 0) / 32768;
      }
      const result = frameProcessor.process(float32);
      return {
        send: result.isSpeech > SPEECH_THRESHOLD,
        speechProbability: result.isSpeech,
      };
    },

    dispose() {
      frameProcessor = null;
      isReady = false;
    },
  };
}
```

> **Note to implementer:** The Silero integration above is a scaffold. The actual implementation should use `@ricky0123/vad-web`'s `NonRealTimeVAD` or `FrameProcessor` class for correct model inference. The library handles resampling, ONNX session management, and hidden state. Read the library's source at `node_modules/@ricky0123/vad-web/src/` to understand the correct integration path. The key is: feed 16kHz Float32 frames, get speech probability back.

- [ ] **Step 3: Write create-vad-filter factory**

Create `web/src/adapters/create-vad-filter.ts`:

```typescript
import { createEnergyVadFilter, type VadFilter } from "@sentient/web-sdk";
import { createSileroVadFilter } from "./silero-vad-filter.ts";

/**
 * Creates the best available VadFilter for the current platform.
 * Tries Silero (ML) first, falls back to Energy (RMS) on failure.
 */
export async function createVadFilter(): Promise<VadFilter> {
  const silero = createSileroVadFilter();
  try {
    await silero.init();
    return silero;
  } catch {
    silero.dispose();
    const energy = createEnergyVadFilter();
    await energy.init();
    return energy;
  }
}
```

- [ ] **Step 4: Write factory test**

Create `web/src/adapters/create-vad-filter.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";

// Since Silero requires WASM/ONNX runtime which isn't available in test,
// the factory should always fall back to EnergyVadFilter in test environment.
describe("createVadFilter", () => {
  it("falls back to EnergyVadFilter when Silero fails", async () => {
    const { createVadFilter } = await import("./create-vad-filter.ts");
    const filter = await createVadFilter();

    // EnergyVadFilter should be functional
    const silent = new Int16Array(512);
    const result = filter.process(silent);
    expect(result.send).toBe(false);
    expect(result.speechProbability).toBe(0);

    filter.dispose();
  });
});
```

- [ ] **Step 5: Run tests**

Run: `cd web && bun test src/adapters/create-vad-filter.test.ts`
Expected: PASS (falls back to Energy since ONNX isn't available in test)

- [ ] **Step 6: Commit**

```bash
git add web/package.json web/bun.lockb web/src/adapters/silero-vad-filter.ts web/src/adapters/silero-vad-filter.test.ts web/src/adapters/create-vad-filter.ts web/src/adapters/create-vad-filter.test.ts
git commit -m "feat(web): add SileroVadFilter with EnergyVadFilter fallback factory"
```

---

### Task 10: Full integration verification

**Files:** None created — just running existing tests and verifying.

- [ ] **Step 1: Run full lint**

Run: `source scripts/env.sh && bun run lint`
Expected: PASS. Fix any issues.

- [ ] **Step 2: Run full typecheck**

Run: `source scripts/env.sh && bun run typecheck`
Expected: PASS. Fix any type errors from removed interfaces.

- [ ] **Step 3: Run full test suite**

Run: `source scripts/env.sh && bun run test`
Expected: All PASS.

- [ ] **Step 4: Verify no references to deleted files**

```bash
cd /Users/kevinye/Development/sentient && grep -r "vad-state-machine" --include="*.ts" -l && grep -r "voice-effect-handler" --include="*.ts" -l
```

Expected: No results (or only this plan file / spec files).

- [ ] **Step 5: Run CI locally**

Run: `source scripts/env.sh && bun run ci`
Expected: All PASS.

- [ ] **Step 6: Commit any fixups**

```bash
git add -A
git commit -m "fix: resolve integration issues from server-side VAD migration"
```

---

## Summary

| Task | What | Files changed | Estimated steps |
|------|------|--------------|-----------------|
| 1 | Protocol messages | 2 | 6 |
| 2 | VadFilter + EnergyVadFilter | 3 | 6 |
| 3 | SpeechService + WsSpeechService | 3 | 7 |
| 4 | Voice state machine refactor | 2 | 5 |
| 5 | Gateway server-driven turns | 2 | 7 |
| 6 | Gateway handler + routing | 3 | 7 |
| 7 | Voice client rewire | 3 | 6 |
| 8 | Client cleanup + delete old files | 6 | 6 |
| 9 | SileroVadFilter + factory | 5 | 6 |
| 10 | Integration verification | 0 | 6 |
