# Pipeline Isolation Refactor — Design Spec

**Date:** 2026-04-08
**Branch:** `feature/voice-pipeline-sdk-redesign`
**Pre-refactor checkpoint:** `c4d7c2c`

## Goal

Extract stateful/management logic from `continuous-session.ts` (450 lines, 19 state variables) into focused modules so that:

- Pipeline decorator units remain purely stateless
- Business logic (barge-in, echo suppression, turn lifecycle) lives in a `TurnController`
- Connection lifecycle stays in a slimmed-down `ContinuousSession`
- `ws-server.ts` becomes a pure message router
- Each module is independently testable with clear interfaces

## Approach

**TurnController-First (Top-Down):** Design the TurnController interface first, then refactor ContinuousSession to create TurnControllers instead of managing turn logic inline.

## Architecture: Two-Module Split

### ContinuousSession (~150 lines)

**Owns:** Connection lifecycle + speech detection. Decides WHEN to start a turn.

**State:**
- `sttConnected`, `ttsConnected` — connection status
- `isSpeechActive`, `accumulatedText`, `deepgramVadActive` — speech detection
- `earlyAudioBuffer`, `connectPromise` — connection buffering
- `lastActivityAt`, `inactivityTimer`, `suspendPromise` — inactivity
- `sessionController` — session-level AbortController
- `activeTurn: TurnController | null` — reference to current turn

**Responsibilities:**
- `start()` — connect STT + TTS in parallel, drain early audio buffer
- `sendAudio()` — forward PCM to STT (buffer if not connected, auto-resume after suspend)
- `close()` — abort active turn, disconnect providers, cleanup timers
- Inactivity monitoring — suspend providers after 5min idle, auto-resume on audio
- Transcript relay — read from STT, route to speech detection or active TurnController
- Speech detection — VAD gating, partial/final accumulation, emit `speechEnd`

**Events emitted:**
- `voiceDetected` — Deepgram VAD fired
- `transcriptPartial(text)` — interim recognition
- `transcriptFinal(text)` — finalized segment
- `speechStart` — user started speaking
- `speechEnd(text)` — complete utterance → triggers TurnController creation
- `error(message)` — connection errors

Note: Turn-level events (text.delta, audio.frame, barge_in.ack) are emitted directly by TurnController through TurnSink — they do NOT flow through ContinuousSession. Session only observes turn completion (run() resolves) and barge-in (to reset speech state via a callback).

**State machine:**
```
Disconnected → Connecting → Connected { Idle ↔ SpeechActive } → Suspended
                                                                    ↓
                                                              auto-resume
```

**Key behavior change:** When `speechEnd` fires, ContinuousSession creates a TurnController and calls `run()`. During an active turn, incoming transcripts are forwarded to `turnController.handleTranscript()` instead of being processed by speech detection.

### TurnController (~150 lines)

**Owns:** One user→assistant turn. Decides HOW to run it and WHEN to abort.

**Interface:**
```typescript
interface TurnController {
  /** Execute the turn. Resolves when turn completes or is aborted. */
  run(): Promise<void>;
  /** Forward a transcript event — may trigger barge-in. */
  handleTranscript(event: TranscriptEvent): void;
  /** Is the assistant currently producing audio? */
  isAssistantSpeaking(): boolean;
  /** Abort the turn externally (client disconnect, session close). */
  abort(): void;
}
```

**Constructor deps (injected):**
```typescript
interface TurnControllerOptions {
  transcript: string;
  history: SessionHistory;
  sink: TurnSink;                        // sendJson + sendBinary
  contextAssembler: ContextAssembler;
  llmProvider: LLMProvider;
  ttsProcessorFactory: TTSProcessorFactory;
  ttsConnectionManager: TTSConnectionManager;
  chatModel: string;
  language: string;
}
```

**State:**
- `turnController: AbortController` — per-turn abort signal
- `assistantSpeaking: boolean` — echo suppression gate
- `echoCooldownActive: boolean` — post-playback cooldown
- `echoCooldownTimer` — 1.5s timer
- `assistantText: string` — accumulated response for history

**State machine:**
```
Created → RunningLLM → StreamingAudio → EchoCooldown → Completed
                ↓              ↓
             Aborted        Aborted  (via barge-in or external abort)
```

**Responsibilities:**

1. **`run()`** — Main execution:
   - Create AbortController
   - Create TTS processor via factory
   - Call `runVoiceTurn()` (existing pipeline, unchanged)
   - Dispatch each event through `TurnSink`
   - Set `assistantSpeaking` on audio.start/audio.done
   - On audio.done → start echo cooldown
   - Finalize history in `finally` block (clearDraft, append assistant text)

2. **`handleTranscript(event)`** — Barge-in detection:
   - If not `assistantSpeaking` and not `echoCooldownActive` → ignore (shouldn't happen, but guard)
   - If `event.isFinal && confidence ≥ 0.9` → trigger barge-in:
     - Abort the turn controller
     - Call `ttsConnectionManager.reconnect()`
     - Emit barge-in event through sink
   - Otherwise → ignore (echo/low confidence)

3. **`abort()`** — External abort:
   - Abort the turn controller signal
   - Clear echo cooldown timer

### TurnSink Interface

Thin abstraction over the WebSocket — TurnController never knows about `ServerWebSocket`:

```typescript
interface TurnSink {
  sendJson(payload: unknown): void;
  sendBinary(data: Uint8Array): void;
}
```

Created by the handler from the WebSocket reference. Allows TurnController to be tested without a real WebSocket.

### Handler Changes (continuous-voice-handler.ts)

Becomes much thinner:
- `wireSessionEvents()` — subscribe to session events, forward to WebSocket
- `ensureContinuousSession()` — create session with deps
- `handleContinuousStart/End/BargeIn` — delegate to session

The handler no longer contains `runTurn()`, `dispatchTurnEvent()`, or `assistantText` state. All of that moves into TurnController.

### ws-server.ts Changes

Minimal — already mostly clean. The `PipelineDeps` type moves to a shared location since both session creation and turn controller need it.

### Pipeline Decorators (NO CHANGES)

These files are untouched:
- `voice-turn.ts` — pure async generator orchestrator
- `streaming-overlap.ts` — pure decorator
- `sentence-aggregator.ts` — self-contained buffering
- `tts-text-sanitizer.ts` — pure transform
- `tts-processor.ts` — pure adapter
- `en-boundary-detector.ts` / `zh-boundary-detector.ts` — pure rules

## Interaction Patterns

### Normal Turn Flow
1. ContinuousSession detects `speechEnd("hello")`
2. Session creates `TurnController({ transcript: "hello", ...deps })`
3. Session sets `activeTurn = turnController`
4. Session calls `turnController.run()`
5. TurnController runs pipeline, dispatches events through TurnSink
6. Turn completes → `run()` resolves
7. Session sets `activeTurn = null`, returns to Idle

### Barge-In Flow
1. Turn is active, assistant streaming audio
2. User speaks → STT sends transcripts
3. Session forwards transcript to `activeTurn.handleTranscript(event)`
4. TurnController checks: `isFinal && confidence ≥ 0.9` → barge-in
5. TurnController aborts pipeline, reconnects TTS, emits `barge_in.ack`
6. `run()` resolves (aborted path, history finalized with partial response)
7. Session sets `activeTurn = null`
8. If `speechFinal`: Session immediately creates new TurnController with barged text
9. If user still speaking: Session returns to SpeechActive, waits for next speechEnd

### Inactivity Suspend
1. No activity for 5 minutes
2. Session disconnects STT + TTS, enters Suspended
3. Audio arrives → Session buffers it, calls `start()` to reconnect
4. On reconnect, drains early audio buffer to STT

## File Changes Summary

| File | Action | Lines (est.) |
|------|--------|-------------|
| `pipeline/turn-controller.ts` | **NEW** | ~150 |
| `pipeline/turn-sink.ts` | **NEW** | ~10 (interface) |
| `pipeline/continuous-session.ts` | **REWRITE** | ~150 (from 450) |
| `server/continuous-voice-handler.ts` | **SIMPLIFY** | ~80 (from 193) |
| `server/ws-server.ts` | **MINOR** | touch imports |
| `pipeline/voice-session.ts` | **DELETE** | dead code |
| `pipeline/barge-in/barge-in-controller.ts` | **DELETE** | unused, replaced by TurnController |
| All processor files | **NO CHANGE** | — |

## What This Enables

- **Adding new decorators:** Just add them to the `runVoiceTurn()` chain. TurnController handles all the stateful orchestration around it.
- **Testing turns in isolation:** Create a TurnController with mock deps, call `run()`, assert events on TurnSink.
- **Testing session without turns:** Mock TurnController creation, test connection lifecycle and speech detection.
- **Alternative turn strategies:** Swap TurnController implementation for different behavior (e.g., text-only turns, multi-modal turns).

## Out of Scope

- No changes to pipeline decorator units
- No changes to provider interfaces (STTProvider, TTSProvider, TTSConnectionManager)
- No changes to client SDK or protocol messages
- Tests deferred until manual verification of refactored pipeline
