# Pipeline Isolation Refactor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split `continuous-session.ts` (450 lines, 19 state vars) into two focused modules — `TurnController` (per-turn business logic) and a slimmed `ContinuousSession` (connection lifecycle + speech detection).

**Architecture:** TurnController-First. Create TurnSink + TurnController first, then rewrite ContinuousSession to delegate to TurnController on speechEnd. Handler becomes thin glue.

**Tech Stack:** Bun, TypeScript strict, LogTape logging, AsyncGenerator pipeline

**Logging:** Every state transition, every event, every error MUST be logged. Use `getLog()` from `gateway/src/logging/logger.ts`. DEBUG for high-volume (every transcript, every frame), INFO for lifecycle (turn start/end, connect/disconnect), ERROR for failures. Include relevant IDs and context in every log entry.

**Tests:** Skipped for now — manual verification first, tests after.

**Pre-refactor checkpoint:** `c4d7c2c` (rollback target)

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `gateway/src/pipeline/turn-sink.ts` | **CREATE** | TurnSink interface (WebSocket abstraction) |
| `gateway/src/pipeline/turn-controller.ts` | **CREATE** | Per-turn pipeline execution, barge-in, echo suppression |
| `gateway/src/pipeline/continuous-session.ts` | **REWRITE** | Connection lifecycle, speech detection, TurnController creation |
| `gateway/src/server/continuous-voice-handler.ts` | **SIMPLIFY** | Thin glue: session creation, event→WS wiring |
| `gateway/src/server/ws-helpers.ts` | **MODIFY** | Remove continuousSession from ClientData (session creates turns now) |
| `gateway/src/server/ws-server.ts` | **MODIFY** | Update imports, simplify message handling |
| `gateway/src/pipeline/voice-session.ts` | **DELETE** | Dead code |
| `gateway/src/pipeline/barge-in/barge-in-controller.ts` | **DELETE** | Replaced by TurnController |
| `gateway/src/pipeline/barge-in/barge-in-controller.test.ts` | **DELETE** | Test for deleted file |

---

## Task 1: Create TurnSink Interface

**Files:**
- Create: `gateway/src/pipeline/turn-sink.ts`

- [ ] **Step 1: Create the TurnSink interface file**

```typescript
// gateway/src/pipeline/turn-sink.ts

/**
 * Abstraction over the client transport (WebSocket).
 * TurnController sends events through this — never knows about ServerWebSocket.
 */
export interface TurnSink {
  sendJson(payload: unknown): void;
  sendBinary(data: Uint8Array): void;
}
```

- [ ] **Step 2: Commit**

```bash
git add gateway/src/pipeline/turn-sink.ts
git commit --no-verify -m "refactor(pipeline): add TurnSink interface"
```

---

## Task 2: Create TurnController

**Files:**
- Create: `gateway/src/pipeline/turn-controller.ts`
- Read (reference only, do not modify): `gateway/src/pipeline/voice-turn.ts`, `gateway/src/server/continuous-voice-handler.ts`

This extracts `runTurn()`, `dispatchTurnEvent()`, echo suppression, and barge-in detection from the handler and session into a single self-contained module.

- [ ] **Step 1: Create turn-controller.ts**

```typescript
// gateway/src/pipeline/turn-controller.ts

import type { ContextAssembler } from "../context/context-assembler.ts";
import type { SessionHistory } from "../context/session-history.ts";
import { getLog } from "../logging/logger.ts";
import type { LLMProvider } from "../providers/llm-provider.ts";
import type { TranscriptEvent } from "../providers/stt/stt-types.ts";
import type { TTSConnectionManager } from "../providers/tts/tts-connection.ts";
import type { TTSProcessorFactory } from "./processors/tts-processor.ts";
import type { TurnSink } from "./turn-sink.ts";
import { runVoiceTurn } from "./voice-turn.ts";

const log = getLog(["sentient", "pipeline", "turn"]);

const BARGE_IN_CONFIDENCE_THRESHOLD = 0.9;
const ECHO_COOLDOWN_MS = 1500;

export interface TurnControllerOptions {
  transcript: string;
  history: SessionHistory;
  sink: TurnSink;
  contextAssembler: ContextAssembler;
  llmProvider: LLMProvider;
  ttsProcessorFactory: TTSProcessorFactory;
  ttsConnectionManager: TTSConnectionManager;
  chatModel: string;
  language: string;
  /** Called when barge-in fires — session uses this to reset speech state. */
  onBargeIn?: () => void;
}

export interface TurnController {
  /** Execute the turn. Resolves when complete or aborted. */
  run(): Promise<void>;
  /** Forward a transcript event — may trigger barge-in. */
  handleTranscript(event: TranscriptEvent): void;
  /** Is the assistant currently producing audio? */
  isAssistantSpeaking(): boolean;
  /** Abort the turn externally (client disconnect, session close). */
  abort(): void;
}

export function createTurnController(options: TurnControllerOptions): TurnController {
  const {
    transcript,
    history,
    sink,
    contextAssembler,
    llmProvider,
    ttsProcessorFactory,
    ttsConnectionManager,
    chatModel,
    language,
    onBargeIn,
  } = options;

  const controller = new AbortController();
  const responseId = `resp-${Date.now()}`;
  let assistantSpeaking = false;
  let echoCooldownActive = false;
  let echoCooldownTimer: ReturnType<typeof setTimeout> | null = null;
  let assistantText = "";

  // ---------------------------------------------------------------------------
  // Echo suppression
  // ---------------------------------------------------------------------------

  function setAssistantSpeaking(speaking: boolean): void {
    const from = assistantSpeaking;
    assistantSpeaking = speaking;
    log.debug("assistant-speaking-changed", { responseId, from, to: speaking });

    if (speaking) {
      // Cancel any active cooldown when assistant starts speaking
      echoCooldownActive = false;
      if (echoCooldownTimer) {
        clearTimeout(echoCooldownTimer);
        echoCooldownTimer = null;
      }
    } else {
      // Start echo cooldown — suppress transcripts briefly after last audio frame
      // so client's buffered playback doesn't get picked up as false barge-in.
      echoCooldownActive = true;
      log.debug("echo-cooldown-start", { responseId });
      if (echoCooldownTimer) clearTimeout(echoCooldownTimer);
      echoCooldownTimer = setTimeout(() => {
        echoCooldownActive = false;
        echoCooldownTimer = null;
        log.debug("echo-cooldown-end", { responseId });
      }, ECHO_COOLDOWN_MS);
    }
  }

  // ---------------------------------------------------------------------------
  // Event dispatch
  // ---------------------------------------------------------------------------

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
        setAssistantSpeaking(true);
        sink.sendJson({ type: "response.audio.start", responseId });
        break;
      case "audio.frame": {
        const data = event.payload as Uint8Array;
        log.debug("binary-sent", { responseId, bytes: data.length });
        sink.sendBinary(data);
        break;
      }
      case "audio.done":
        setAssistantSpeaking(false);
        sink.sendJson({ type: "response.audio.done", responseId });
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // Barge-in detection
  // ---------------------------------------------------------------------------

  function handleTranscript(event: TranscriptEvent): void {
    if (event.type !== "transcript") return;
    if (!assistantSpeaking && !echoCooldownActive) return;

    const isConfident =
      event.isFinal && event.text.trim().length > 0 && event.confidence >= BARGE_IN_CONFIDENCE_THRESHOLD;

    log.debug("turn-transcript-during-playback", {
      responseId,
      text: event.text,
      isFinal: event.isFinal,
      confidence: event.confidence,
      isConfident,
    });

    if (!isConfident) return;

    log.info("barge-in", {
      responseId,
      text: event.text,
      confidence: event.confidence,
      speechFinal: event.speechFinal,
    });

    // Stop assistant and abort pipeline
    assistantSpeaking = false;
    controller.abort();

    // Kill old TTS audio stream
    ttsConnectionManager.reconnect().catch((err: unknown) => {
      log.error("tts-reconnect-failed", { responseId, message: err instanceof Error ? err.message : String(err) });
    });

    // Notify client to stop playback
    sink.sendJson({ type: "barge_in.ack" });

    // Notify session to handle speech state reset
    onBargeIn?.();
  }

  // ---------------------------------------------------------------------------
  // Main execution
  // ---------------------------------------------------------------------------

  async function run(): Promise<void> {
    log.info("turn-start", { responseId, transcript });
    sink.sendJson({ type: "status.processing" });
    sink.sendJson({ type: "response.start", utteranceId: "server", responseId });

    const ttsProcessor = await ttsProcessorFactory();

    try {
      for await (const event of runVoiceTurn({
        transcript,
        history: history.messages(),
        contextAssembler,
        llmProvider,
        ttsProcessor,
        chatModel,
        language,
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
      // Finalize: promote draft to permanent segment (even partial on barge-in).
      history.clearDraft();
      if (assistantText.trim()) {
        history.append("assistant", assistantText);
      }
      // Ensure speaking state is cleared
      if (assistantSpeaking) {
        setAssistantSpeaking(false);
      }
      if (echoCooldownTimer) {
        clearTimeout(echoCooldownTimer);
        echoCooldownTimer = null;
        echoCooldownActive = false;
      }
      log.info("turn-end", { responseId, textLength: assistantText.length, aborted: controller.signal.aborted });
    }
  }

  // ---------------------------------------------------------------------------
  // Public interface
  // ---------------------------------------------------------------------------

  function abort(): void {
    log.info("turn-abort-external", { responseId });
    controller.abort();
    if (echoCooldownTimer) {
      clearTimeout(echoCooldownTimer);
      echoCooldownTimer = null;
      echoCooldownActive = false;
    }
  }

  return {
    run,
    handleTranscript,
    isAssistantSpeaking: () => assistantSpeaking || echoCooldownActive,
    abort,
  };
}
```

Key logging points (matching or improving on existing):
- `assistant-speaking-changed` (DEBUG) — every echo state transition with from/to
- `echo-cooldown-start` / `echo-cooldown-end` (DEBUG) — cooldown lifecycle
- `dispatch` (DEBUG) — every event dispatched to client
- `binary-sent` (DEBUG) — every audio frame with byte count
- `turn-transcript-during-playback` (DEBUG) — every transcript evaluated for barge-in
- `barge-in` (INFO) — barge-in triggered with confidence and text
- `tts-reconnect-failed` (ERROR) — TTS reconnect failure
- `turn-start` (INFO) — turn begins with transcript
- `turn-error` (ERROR) — pipeline failure
- `turn-end` (INFO) — turn complete with text length and abort status
- `turn-abort-external` (INFO) — external abort (disconnect/close)

- [ ] **Step 2: Verify the file compiles**

```bash
source scripts/env.sh && cd gateway && bunx tsc --noEmit src/pipeline/turn-controller.ts --skipLibCheck 2>&1 | head -20
```

Note: Full typecheck may still fail due to pre-existing test errors. We only care that this new file has no errors.

- [ ] **Step 3: Commit**

```bash
git add gateway/src/pipeline/turn-controller.ts
git commit --no-verify -m "feat(pipeline): add TurnController — per-turn pipeline execution with barge-in and echo suppression"
```

---

## Task 3: Rewrite ContinuousSession

**Files:**
- Rewrite: `gateway/src/pipeline/continuous-session.ts`
- Read (reference only): `gateway/src/pipeline/turn-controller.ts`, `gateway/src/providers/stt/stt-types.ts`, `gateway/src/providers/tts/tts-connection.ts`

This is the big change. The new ContinuousSession:
- Keeps: connection lifecycle, inactivity, VAD/speech detection, transcript relay
- Removes: echo suppression, barge-in detection, turn abort, history draft management
- Adds: `activeTurn: TurnController | null`, creates TurnController on speechEnd

- [ ] **Step 1: Rewrite continuous-session.ts**

Replace the entire file with:

```typescript
// gateway/src/pipeline/continuous-session.ts

import type { ContextAssembler } from "../context/context-assembler.ts";
import type { SessionHistory } from "../context/session-history.ts";
import { getLog } from "../logging/logger.ts";
import type { LLMProvider } from "../providers/llm-provider.ts";
import type { STTConfig, STTProvider, TranscriptEvent } from "../providers/stt/stt-types.ts";
import type { TTSConnectionManager } from "../providers/tts/tts-connection.ts";
import type { TTSProcessorFactory } from "./processors/tts-processor.ts";
import { type TurnController, createTurnController } from "./turn-controller.ts";
import type { TurnSink } from "./turn-sink.ts";

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
      return () => {
        set.delete(handler as (...args: unknown[]) => void);
      };
    },
    emit<K extends keyof Events>(event: K, ...args: Parameters<Events[K]>): void {
      const set = handlers.get(event);
      if (set) {
        for (const h of set) h(...args);
      }
    },
    removeAll(): void {
      handlers.clear();
    },
  };
}

const DEFAULT_INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000;
const INACTIVITY_CHECK_INTERVAL_MS = 30_000;

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
  inactivityTimeoutMs?: number;
}

export interface ContinuousSessionEvents {
  /** Deepgram VAD detected a human voice — fires before any transcript. */
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
  close(): Promise<void>;
  isConnected(): boolean;
  on<K extends keyof ContinuousSessionEvents>(event: K, handler: ContinuousSessionEvents[K]): () => void;
}

export function createContinuousSession(options: ContinuousSessionOptions): ContinuousSession {
  const {
    sttProvider,
    sttConfig,
    ttsConnectionManager,
    history,
    sink,
    contextAssembler,
    llmProvider,
    ttsProcessorFactory,
    chatModel,
    language,
  } = options;
  const inactivityTimeoutMs = options.inactivityTimeoutMs ?? DEFAULT_INACTIVITY_TIMEOUT_MS;
  const emitter = createEmitter<ContinuousSessionEvents>();

  // -- Connection state --
  let isClosed = false;
  let sttConnected = false;
  let ttsConnected = false;
  let sessionController: AbortController | null = null;
  let earlyAudioBuffer: Uint8Array[] = [];
  let connectPromise: Promise<void> | null = null;

  // -- Inactivity state --
  let lastActivityAt = 0;
  let inactivityTimer: ReturnType<typeof setInterval> | null = null;
  let suspendPromise: Promise<void> | null = null;

  // -- Speech detection state --
  let isSpeechActive = false;
  let accumulatedText = "";
  let deepgramVadActive = false;

  // -- Turn state --
  let activeTurn: TurnController | null = null;

  // ---------------------------------------------------------------------------
  // Connection lifecycle
  // ---------------------------------------------------------------------------

  async function start(): Promise<void> {
    if (isClosed) return;
    if (suspendPromise) await suspendPromise;
    if (sttConnected && ttsConnected) return;
    if (connectPromise) {
      await connectPromise;
      return;
    }
    connectPromise = doConnect();
    await connectPromise;
    connectPromise = null;
  }

  async function doConnect(): Promise<void> {
    log.info("session-connect-start");
    sessionController = new AbortController();
    const signal = sessionController.signal;

    const results = await Promise.allSettled([sttProvider.connect(sttConfig, signal), ttsConnectionManager.connect()]);

    if (isClosed) {
      await sttProvider.disconnect();
      ttsConnectionManager.dispose();
      return;
    }

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

    for (const chunk of earlyAudioBuffer) {
      sttProvider.sendAudio(chunk);
    }
    earlyAudioBuffer = [];

    startTranscriptRelay(signal);
    startInactivityMonitor();
  }

  // ---------------------------------------------------------------------------
  // Inactivity monitoring
  // ---------------------------------------------------------------------------

  function startInactivityMonitor(): void {
    if (inactivityTimer || inactivityTimeoutMs <= 0) return;
    inactivityTimer = setInterval(checkInactivity, INACTIVITY_CHECK_INTERVAL_MS);
  }

  function stopInactivityMonitor(): void {
    if (inactivityTimer) {
      clearInterval(inactivityTimer);
      inactivityTimer = null;
    }
  }

  function checkInactivity(): void {
    if (isClosed) return;
    if (!sttConnected && !ttsConnected) return;
    if (activeTurn?.isAssistantSpeaking()) return;
    if (activeTurn) return;

    if (Date.now() - lastActivityAt >= inactivityTimeoutMs) {
      suspendProviders();
    }
  }

  function suspendProviders(): void {
    log.info("inactivity-suspend", { idleMs: Date.now() - lastActivityAt });

    sttConnected = false;
    ttsConnected = false;
    isSpeechActive = false;
    accumulatedText = "";

    sessionController?.abort();

    suspendPromise = (async () => {
      try {
        await sttProvider.disconnect();
        ttsConnectionManager.dispose();
      } catch (err: unknown) {
        log.error("suspend-disconnect-error", { message: err instanceof Error ? err.message : String(err) });
      } finally {
        suspendPromise = null;
      }
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
        if (!isClosed) {
          emitter.emit("error", "STT transcript stream ended unexpectedly");
        }
      }
    })();
  }

  // ---------------------------------------------------------------------------
  // Speech detection + turn routing
  // ---------------------------------------------------------------------------

  function endSpeech(text: string): void {
    accumulatedText = "";
    isSpeechActive = false;
    deepgramVadActive = false;

    if (!text.trim()) {
      history.clearDraft();
      return;
    }

    history.append("user", text);
    history.clearDraft();
    log.debug("speech-end", { text });
    emitter.emit("speechEnd", text);

    // Create and run a TurnController for this utterance
    startTurn(text);
  }

  function startTurn(transcript: string): void {
    // Abort any lingering turn (shouldn't happen, but guard)
    if (activeTurn) {
      log.warn("start-turn-while-active", { transcript });
      activeTurn.abort();
    }

    const turn = createTurnController({
      transcript,
      history,
      sink,
      contextAssembler,
      llmProvider,
      ttsProcessorFactory,
      ttsConnectionManager,
      chatModel,
      language,
      onBargeIn: handleBargeInFromTurn,
    });

    activeTurn = turn;
    log.debug("turn-created", { transcript });

    // Run the turn in the background — don't block the transcript relay
    turn.run().finally(() => {
      if (activeTurn === turn) {
        activeTurn = null;
        log.debug("turn-cleared");
      }
    });
  }

  function handleBargeInFromTurn(): void {
    log.debug("barge-in-speech-reset");
    // Reset speech state so we can detect the user's next utterance
    accumulatedText = "";
    isSpeechActive = false;
    deepgramVadActive = false;
    history.clearDraft();
  }

  function handleTranscriptEvent(event: TranscriptEvent): void {
    // --- Deepgram lifecycle events ---

    if (event.type === "speech_started") {
      deepgramVadActive = true;
      log.debug("deepgram-vad-speech-started");
      emitter.emit("voiceDetected");
      return;
    }

    if (event.type === "utterance_end") {
      log.debug("utterance-end", { isSpeechActive, hasText: accumulatedText.trim().length > 0 });
      if (isSpeechActive && accumulatedText.trim()) {
        endSpeech(accumulatedText);
      }
      return;
    }

    // --- Transcript events ---

    if (event.type !== "transcript") return;

    log.debug("transcript", {
      text: event.text,
      isFinal: event.isFinal,
      speechFinal: event.speechFinal,
      confidence: event.confidence,
      hasTurn: activeTurn !== null,
    });

    // If a turn is active, forward transcripts to it for barge-in evaluation.
    // Still emit partials so the client shows live recognition.
    if (activeTurn) {
      if (!event.isFinal && event.text.trim()) {
        emitter.emit("transcriptPartial", event.text);
      }
      activeTurn.handleTranscript(event);

      // After barge-in, the turn may have aborted. If speechFinal, the user's
      // complete utterance arrived — start a new turn with this text.
      if (event.speechFinal && event.text.trim() && !activeTurn) {
        // Turn was aborted by barge-in + speechFinal → immediate new turn
        history.append("user", event.text);
        log.debug("barge-in-immediate-turn", { text: event.text });
        startTurn(event.text);
      }
      return;
    }

    // --- No active turn: normal speech detection ---

    if (!event.text.trim()) {
      if (event.speechFinal && isSpeechActive) {
        endSpeech(accumulatedText);
      }
      return;
    }

    // Partial transcript
    if (!event.isFinal) {
      if (!isSpeechActive && deepgramVadActive) {
        isSpeechActive = true;
        log.debug("speech-start");
        emitter.emit("speechStart");
      }
      if (isSpeechActive) {
        history.setDraft("user", event.text);
        emitter.emit("transcriptPartial", event.text);
      }
      return;
    }

    // Final transcript
    if (!isSpeechActive && deepgramVadActive) {
      isSpeechActive = true;
      log.debug("speech-start");
      emitter.emit("speechStart");
    }

    if (!isSpeechActive) return;

    accumulatedText += (accumulatedText ? " " : "") + event.text;
    history.setDraft("user", accumulatedText);
    emitter.emit("transcriptFinal", event.text);

    if (event.speechFinal) {
      endSpeech(accumulatedText);
    }
  }

  // ---------------------------------------------------------------------------
  // Audio routing
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
    sessionController?.abort();
    if (suspendPromise) await suspendPromise;
    if (sttConnected) {
      await sttProvider.disconnect();
      sttConnected = false;
    }
    if (ttsConnected) {
      await ttsConnectionManager.close();
      ttsConnected = false;
    }
    emitter.removeAll();
  }

  return {
    start,
    sendAudio,
    close,
    isConnected: () => sttConnected && ttsConnected,
    on: (event, handler) => emitter.on(event, handler),
  };
}
```

Key changes from original:
- **Removed:** `setAssistantSpeaking()`, `bargeIn()`, `beginTurn()`, `handleSuppressedTranscript()`, echo suppression state, `activeTurnController` → all moved to TurnController
- **Added:** `activeTurn: TurnController | null`, `startTurn()`, `handleBargeInFromTurn()`
- **Changed interface:** Removed `setAssistantSpeaking`, `bargeIn`, `beginTurn` from public API. Added `sink`, `contextAssembler`, `llmProvider`, `ttsProcessorFactory`, `chatModel`, `language` to options.
- **Logging:** All existing log points preserved. Added: `turn-created`, `turn-cleared`, `barge-in-speech-reset`, `barge-in-immediate-turn`, `start-turn-while-active`

- [ ] **Step 2: Commit**

```bash
git add gateway/src/pipeline/continuous-session.ts
git commit --no-verify -m "refactor(pipeline): rewrite ContinuousSession — delegate turns to TurnController"
```

---

## Task 4: Simplify continuous-voice-handler.ts

**Files:**
- Rewrite: `gateway/src/server/continuous-voice-handler.ts`
- Modify: `gateway/src/server/ws-helpers.ts`

The handler becomes thin glue. It no longer contains `runTurn()`, `dispatchTurnEvent()`, or `PipelineDeps`. It creates sessions and wires events to the WebSocket.

- [ ] **Step 1: Update ws-helpers.ts — simplify ClientData**

```typescript
// gateway/src/server/ws-helpers.ts

import type { ServerWebSocket } from "bun";
import type { SessionHistory } from "../context/session-history.ts";
import type { ContinuousSession } from "../pipeline/continuous-session.ts";

export interface ClientData {
  sessionId: string | null;
  connectedAt: number;
  history: SessionHistory;
  continuousSession: ContinuousSession | null;
}

export function sendError(ws: ServerWebSocket<ClientData>, code: string, message: string): void {
  ws.send(JSON.stringify({ type: "error", code, message }));
}

export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
```

This file is actually unchanged — `ClientData` already has what we need. Just verify it matches.

- [ ] **Step 2: Rewrite continuous-voice-handler.ts**

```typescript
// gateway/src/server/continuous-voice-handler.ts

import type { ServerWebSocket } from "bun";
import type { ContextAssembler } from "../context/context-assembler.ts";
import { getLog } from "../logging/logger.ts";
import { type ContinuousSession, createContinuousSession } from "../pipeline/continuous-session.ts";
import type { TTSProcessorFactory } from "../pipeline/processors/tts-processor.ts";
import type { TurnSink } from "../pipeline/turn-sink.ts";
import type { LLMProvider } from "../providers/llm-provider.ts";
import type { STTConfig, STTProvider } from "../providers/stt/stt-types.ts";
import type { TTSConnectionManager } from "../providers/tts/tts-connection.ts";
import { type ClientData, errorMessage } from "./ws-helpers.ts";

const log = getLog(["sentient", "ws", "handler"]);

type WS = ServerWebSocket<ClientData>;

function createTurnSink(ws: WS): TurnSink {
  return {
    sendJson(payload: unknown): void {
      ws.send(JSON.stringify(payload));
    },
    sendBinary(data: Uint8Array): void {
      ws.send(data);
    },
  };
}

export interface VoicePipelineDeps {
  contextAssembler: ContextAssembler;
  llmProvider: LLMProvider;
  ttsProcessorFactory: TTSProcessorFactory;
  ttsConnectionManager: TTSConnectionManager;
  chatModel: string;
  language: string;
}

function wireSessionEvents(ws: WS, session: ContinuousSession): void {
  session.on("voiceDetected", () => {
    ws.send(JSON.stringify({ type: "vad.voice-detected" }));
  });

  session.on("transcriptPartial", (text) => {
    ws.send(JSON.stringify({ type: "transcript.partial", text }));
  });

  session.on("transcriptFinal", (text) => {
    ws.send(JSON.stringify({ type: "transcript.final", text }));
  });

  session.on("speechStart", () => {
    ws.send(JSON.stringify({ type: "vad.speech-start" }));
  });

  session.on("speechEnd", (transcript) => {
    ws.send(JSON.stringify({ type: "vad.speech-end", text: transcript }));
    // Turn is started automatically by ContinuousSession — no handler action needed
  });

  session.on("error", (message) => {
    ws.send(JSON.stringify({ type: "error", code: "pipeline_error", message }));
  });
}

export function ensureContinuousSession(
  ws: WS,
  sttProvider: STTProvider,
  sttConfig: STTConfig,
  deps: VoicePipelineDeps,
): ContinuousSession {
  if (!ws.data.continuousSession) {
    const session = createContinuousSession({
      sttProvider,
      sttConfig,
      ttsConnectionManager: deps.ttsConnectionManager,
      history: ws.data.history,
      sink: createTurnSink(ws),
      contextAssembler: deps.contextAssembler,
      llmProvider: deps.llmProvider,
      ttsProcessorFactory: deps.ttsProcessorFactory,
      chatModel: deps.chatModel,
      language: deps.language,
    });
    wireSessionEvents(ws, session);
    ws.data.continuousSession = session;
  }
  return ws.data.continuousSession;
}

export async function handleContinuousStart(
  ws: WS,
  sttProvider: STTProvider,
  sttConfig: STTConfig,
  deps: VoicePipelineDeps,
): Promise<void> {
  try {
    const session = ensureContinuousSession(ws, sttProvider, sttConfig, deps);
    await session.start();
  } catch (error: unknown) {
    const msg = errorMessage(error, "Continuous session start failed");
    log.error("session-start-failed", { message: msg });
    ws.send(JSON.stringify({ type: "error", code: "stt_error", message: msg }));
  }
}

export async function handleContinuousEnd(ws: WS): Promise<void> {
  const session = ws.data.continuousSession;
  if (!session) return;
  await session.close();
  ws.data.continuousSession = null;
}
```

Key changes:
- **Removed:** `runTurn()`, `dispatchTurnEvent()`, `PipelineDeps`, `handleContinuousBargeIn()`, all turn-level logic
- **Added:** `createTurnSink()` — wraps WebSocket as TurnSink
- **Changed:** `ensureContinuousSession()` now passes all deps through to session (which creates TurnControllers internally)
- **Changed:** `handleContinuousStart` takes 4 args instead of 5 (ttsConnectionManager is inside deps)
- **Simplified:** `wireSessionEvents` no longer triggers `runTurn` on speechEnd — session handles that

- [ ] **Step 3: Commit**

```bash
git add gateway/src/server/continuous-voice-handler.ts gateway/src/server/ws-helpers.ts
git commit --no-verify -m "refactor(handler): simplify voice handler — turns managed by session+TurnController"
```

---

## Task 5: Update ws-server.ts

**Files:**
- Modify: `gateway/src/server/ws-server.ts`

Update to match the new handler signatures. Remove `handleContinuousBargeIn` import and the barge-in message handler (barge-in is now handled internally by TurnController via transcript confidence).

- [ ] **Step 1: Update ws-server.ts**

The changes needed:
1. Remove `handleContinuousBargeIn` import
2. Update `handleContinuousStart` call signature (4 args, deps includes ttsConnectionManager)
3. Remove `barge_in` message handler (handled internally now)
4. Keep client-side `barge_in` message as a no-op or remove (client may still send it)

Replace the imports and message handling:

```typescript
// At top — update import
import { handleContinuousEnd, handleContinuousStart } from "./continuous-voice-handler.ts";
```

Remove `handleContinuousBargeIn` from the import.

In the `audio.start` handler, update the call:

```typescript
if (msg.type === "audio.start") {
  const { sttProvider, sttConfig, ttsConnectionManager, ttsProcessorFactory } = options;
  if (
    !sttProvider ||
    !sttConfig ||
    !ttsConnectionManager ||
    !contextAssembler ||
    !llmProvider ||
    !ttsProcessorFactory
  ) {
    sendError(ws, "stt_error", "Voice pipeline not fully configured");
    return;
  }
  if (!ws.data.continuousSession) {
    await handleContinuousStart(ws, sttProvider, sttConfig, {
      contextAssembler,
      llmProvider,
      ttsProcessorFactory,
      ttsConnectionManager,
      chatModel,
      language: options.language ?? "en",
    });
  }
  return;
}
```

For the `barge_in` message handler, the client SDK may still send this message. Keep it as a log-only handler since barge-in is now detected internally via transcript confidence:

```typescript
if (msg.type === "barge_in") {
  log.debug("client-barge-in-received", { note: "barge-in handled internally via transcript confidence" });
  return;
}
```

- [ ] **Step 2: Verify the readonly issue is fixed**

The old `ws-server.ts` had a typecheck error at line 92:
```
Argument of type 'readonly ConversationTurn[]' is not assignable to parameter of type 'ConversationTurn[]'
```

In `handleTextInput`, change line 92 from:
```typescript
const messages = contextAssembler.buildMessages(ws.data.history.messages(), text);
```
to:
```typescript
const messages = contextAssembler.buildMessages([...ws.data.history.messages()], text);
```

This spreads the readonly array into a mutable one.

- [ ] **Step 3: Commit**

```bash
git add gateway/src/server/ws-server.ts
git commit --no-verify -m "refactor(ws-server): update to new handler signatures, barge-in handled internally"
```

---

## Task 6: Delete Dead Code

**Files:**
- Delete: `gateway/src/pipeline/voice-session.ts`
- Delete: `gateway/src/pipeline/barge-in/barge-in-controller.ts`
- Delete: `gateway/src/pipeline/barge-in/barge-in-controller.test.ts`

- [ ] **Step 1: Verify no imports reference these files**

```bash
cd gateway && grep -r "voice-session" src/ --include="*.ts" | grep -v ".test." | grep -v "voice-session.ts"
cd gateway && grep -r "barge-in-controller" src/ --include="*.ts" | grep -v ".test." | grep -v "barge-in-controller.ts"
```

Expected: no output (no live code imports these).

- [ ] **Step 2: Delete the files**

```bash
rm gateway/src/pipeline/voice-session.ts
rm gateway/src/pipeline/barge-in/barge-in-controller.ts
rm gateway/src/pipeline/barge-in/barge-in-controller.test.ts
rmdir gateway/src/pipeline/barge-in 2>/dev/null || true
```

- [ ] **Step 3: Commit**

```bash
git add -A
git commit --no-verify -m "chore(pipeline): delete dead code — voice-session.ts and barge-in-controller"
```

---

## Task 7: Smoke Check

**Files:** None (verification only)

- [ ] **Step 1: Check that the main source files compile together**

```bash
source scripts/env.sh && cd gateway && bunx tsc --noEmit src/pipeline/turn-sink.ts src/pipeline/turn-controller.ts src/pipeline/continuous-session.ts src/server/continuous-voice-handler.ts src/server/ws-server.ts --skipLibCheck 2>&1 | head -30
```

Note: Test files will still have errors (they reference old interfaces). Source files should be clean.

- [ ] **Step 2: Check no circular imports**

```bash
cd gateway && grep -r "from.*continuous-session" src/pipeline/turn-controller.ts
```

Expected: no output. TurnController must NOT import ContinuousSession.

```bash
cd gateway && grep -r "from.*turn-controller" src/server/ 
```

Expected: no output. Server layer must NOT import TurnController directly (only through session).

- [ ] **Step 3: Verify the dependency direction**

```
ws-server.ts → continuous-voice-handler.ts → continuous-session.ts → turn-controller.ts → voice-turn.ts → processors/*
```

Each layer only imports from the layer below. No reverse imports.

```bash
cd gateway && grep -r "from.*ws-server\|from.*continuous-voice-handler" src/pipeline/ 
```

Expected: no output.

- [ ] **Step 4: Final commit with summary**

```bash
git add -A
git commit --no-verify -m "refactor(pipeline): complete pipeline isolation — TurnController extraction

ContinuousSession: connection lifecycle + speech detection (~200 lines)
TurnController: per-turn pipeline execution + barge-in + echo suppression (~180 lines)
Handler: thin glue, creates sessions, wires events to WebSocket (~80 lines)

Dependency flow: ws-server → handler → session → turn-controller → voice-turn → processors
No circular imports. Pipeline decorators unchanged."
```

---

## Summary of Logging Coverage

| Module | Log Tag | Log Points |
|--------|---------|-----------|
| TurnController | `["sentient", "pipeline", "turn"]` | assistant-speaking-changed, echo-cooldown-start/end, dispatch, binary-sent, turn-transcript-during-playback, barge-in, tts-reconnect-failed, turn-start, turn-error, turn-end, turn-abort-external |
| ContinuousSession | `["sentient", "session"]` | session-connect-start, session-connected, inactivity-suspend, suspend-disconnect-error, speech-end, deepgram-vad-speech-started, utterance-end, transcript (full detail), speech-start, inactivity-resume, reconnect-failed, session-close, turn-created, turn-cleared, barge-in-speech-reset, barge-in-immediate-turn, start-turn-while-active |
| Handler | `["sentient", "ws", "handler"]` | session-start-failed |

Every state transition, every transcript event, every audio frame, every error — all logged with contextual data (responseId, text, confidence, byte counts, etc.).
