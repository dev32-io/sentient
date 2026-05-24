# Barge-In Hardening Design

## Summary

Harden the entire barge-in pipeline to be bullet-proof: eliminate false barge-in via WebRTC AEC, fix audio leak after barge-in, fix missing ack delivery, fix long speech splitting, and fix self-interruption chunk combining. Extract all barge-in logic from the 520-line ContinuousSession monolith into four isolated, testable units.

## Problems

1. **Audio leaks after barge-in** — `barge_in.ack` is sent before TTS generator fully stops. Client continues receiving and playing audio frames after acknowledging the interruption.
2. **Barge-in messages sometimes don't arrive** — `ws.send()` has no error handling, `barge_in.ack` can be lost if WebSocket is closing, client state machine gets stuck.
3. **False barge-in from echo** — without AEC, the assistant's own TTS audio picked up by the mic triggers barge-in. Confidence gate (0.9) and echo cooldown (1500ms) are insufficient.
4. **Long speech split into chunks** — Deepgram endpointing fires mid-utterance, LLM responds to partial input. When user continues speaking, their input is fragmented across turns.
5. **Self-interruption loses speech** — when barge-in fires with `speechFinal=false`, `accumulatedText` is overwritten instead of appended, losing prior speech chunks.

## Architecture

### Current (monolithic)

`ContinuousSession` owns speech detection, barge-in logic, turn transitions, and transcript accumulation via 8 mutable flags (`isSpeechActive`, `deepgramVadActive`, `accumulatedText`, `activeTurn`, `echoCooldownActive`, `echoCooldownTimer`, `assistantSpeaking`, `assistantText`).

`TurnController` duplicates barge-in detection logic with its own set of flags.

### New (decomposed)

```
ContinuousSession (thin orchestrator, <150 lines of wiring)
  ├── BargeInController (pure state machine — barge-in decisions)
  ├── TranscriptAccumulator (speech text accumulation)
  ├── TurnTransition (atomic abort→flush→ack sequence)
  └── TurnController (pipeline execution, no barge-in logic)

VoiceClient (SDK)
  └── WebRtcAecPlayback (replaces AudioContext playback)
```

Each unit has one job, one file, one test file. No unit exceeds 150 lines.

## Component Specifications

### 1. WebRtcAecPlayback

**File:** `shared/web-sdk/src/adapters/webrtc-aec-playback.ts`

**Purpose:** Play TTS audio through a WebRTC loopback so the browser's built-in AEC subtracts it from mic capture. Drop-in replacement for the current AudioContext-based playback.

**How it works:**

```
TTS audio frames (Float32)
  → AudioContext → MediaStreamDestination
  → RTCPeerConnection (local sender)
  → RTCPeerConnection (remote receiver) [loopback via createOffer/createAnswer]
  → remote MediaStream
  → HTMLAudioElement.srcObject = remoteStream
  → HTMLAudioElement.play()
```

The browser treats audio arriving via RTCPeerConnection as "remote participant" audio and automatically applies acoustic echo cancellation to the mic capture from `getUserMedia`.

**Interface** — same `PlaybackAdapter` already used by VoiceClient:

```typescript
interface PlaybackAdapter {
  init(): Promise<void>;
  enqueue(samples: Float32Array): void;
  clear(): void;
  isPlaying(): boolean;
  dispose(): void;
}
```

**Implementation details:**
- `init()`: create AudioContext, MediaStreamDestination, two RTCPeerConnections, perform ICE exchange via local signaling (no server), set remote stream on HTMLAudioElement
- `enqueue()`: write samples to a ScriptProcessorNode or AudioWorklet feeding the MediaStreamDestination
- `clear()`: flush the audio buffer, silence the stream (write zeros)
- `isPlaying()`: true if buffer has pending samples
- `dispose()`: close both RTCPeerConnections, close AudioContext, remove audio element

**Fallback:** If `RTCPeerConnection` is unavailable (test environments, very old browsers), fall back to the existing `web-audio-playback.ts` implementation. Log a warning — confidence gate still provides partial protection.

**Buffer management:**
- Internal ring buffer of Float32 samples
- `enqueue()` appends to buffer
- AudioWorklet pulls from buffer at playback rate
- `clear()` resets read/write pointers to zero, writes a brief silence frame to flush the audio pipeline

### 2. BargeInController

**File:** `gateway/src/pipeline/barge-in-controller.ts`

**Purpose:** Pure state machine that makes barge-in decisions. No side effects, no timers, no async. Takes events, returns decisions.

```typescript
interface BargeInControllerOptions {
  readonly minInterruptionMs: number;      // default 500 — ignore speech shorter than this after assistant starts
  readonly confidenceThreshold: number;    // default 0.9 — server-side transcript confidence gate
  readonly debounceCooldownMs: number;     // default 300 — min time between consecutive barge-in decisions
}

type BargeInEvent =
  | { type: "transcript"; text: string; isFinal: boolean; confidence: number; speechFinal: boolean; timestampMs: number }
  | { type: "client_vad"; timestampMs: number }
  | { type: "assistant_started"; timestampMs: number }
  | { type: "assistant_ended"; timestampMs: number }
  | { type: "turn_completed" };

type BargeInDecision =
  | { action: "none" }
  | { action: "barge_in"; text: string; speechFinal: boolean };

interface BargeInController {
  handle(event: BargeInEvent): BargeInDecision;
  reset(): void;
}
```

**State machine rules:**

1. **No-interrupt window**: After `assistant_started`, reject all barge-in for `minInterruptionMs` (500ms). This prevents residual user speech, echo, and audio artifacts from triggering.
2. **Server confidence gate**: Transcript-based barge-in requires `isFinal && text.trim().length > 0 && confidence >= confidenceThreshold`.
3. **Client VAD fast path**: `client_vad` events bypass the confidence gate but still respect the no-interrupt window and debounce.
4. **Debounce**: After any `barge_in` decision, reject all events for `debounceCooldownMs` (300ms).
5. **Not speaking = no barge-in**: If assistant is not speaking (no `assistant_started` or already got `assistant_ended`), return `{ action: "none" }`.
6. **Turn completed**: Reset all state for next turn.

**Internal state** (all derived from events, no external dependencies):

```typescript
let assistantSpeakingStartMs: number | null = null;
let lastBargeInMs: number | null = null;
```

Two fields. No flags. The rules above are evaluated from these two values + the incoming event.

**Why timestamps in events:** The caller provides `timestampMs` (from `Date.now()` or test injection). The controller never calls `Date.now()` itself — this makes it fully deterministic and testable without fake timers.

### 3. TranscriptAccumulator

**File:** `gateway/src/pipeline/transcript-accumulator.ts`

**Purpose:** Accumulates transcript chunks from Deepgram into coherent user input. Handles partial replacement, final appending, and cross-barge-in chunk combining.

```typescript
interface TranscriptAccumulator {
  /** Update with a partial transcript (replaces previous partial). */
  updatePartial(text: string): void;
  /** Append a final transcript chunk. Returns full accumulated text. */
  appendFinal(text: string): string;
  /** Get current accumulated text (finals + latest partial). */
  current(): string;
  /** Finalize: return combined text and reset. Used when starting a turn. */
  finalize(): string;
  /** Seed with prior text (e.g., barge-in text). Does not overwrite — appends. */
  seed(text: string): void;
  /** Reset all state. */
  reset(): void;
}
```

**Behavior:**

- **Partial transcripts**: Deepgram sends updated partials that replace the previous partial (not diffs). The accumulator holds at most one pending partial.
- **Final transcripts**: Appended to the finalized text buffer with space separator. Clears the pending partial.
- **`seed(text)`**: Called during barge-in with the barge-in transcript. Appends to existing accumulated text — never overwrites. This is the fix for bug #5.
- **`finalize()`**: Returns `finalizedText + " " + pendingPartial` (trimmed), then resets both. Called when `endSpeech()` triggers a new turn.
- **`current()`**: Returns the current snapshot without modifying state. Used for `history.setDraft()`.
- **`reset()`**: Clears everything. Called on turn completion or disconnect.

**Key fix:** Current code does `accumulatedText = bargeInText` (overwrite). New code does `accumulator.seed(bargeInText)` which appends. This means:

1. User says "Wait, I have" → Deepgram sends final → `appendFinal("Wait, I have")`
2. Barge-in fires → `seed("Wait, I have")` (from barge-in text, may be same or different chunk)
3. User continues "a question about X" → `appendFinal("a question about X")`
4. Speech ends → `finalize()` returns `"Wait, I have a question about X"`

No text is lost.

### 4. TurnTransition

**File:** `gateway/src/pipeline/turn-transition.ts`

**Purpose:** Execute the barge-in abort sequence atomically. Guarantees no audio leaks after completion.

```typescript
interface TurnTransitionOptions {
  readonly turn: TurnController;
  readonly ttsConnectionManager: TTSConnectionManager;
  readonly sink: TurnSink;
}

interface TurnTransition {
  execute(options: TurnTransitionOptions): Promise<void>;
}
```

**The guaranteed sequence:**

```
1. turn.abort()                          ← fires AbortSignal through entire pipeline
2. await ttsConnectionManager.reconnect() ← TTS WebSocket fully torn down (AWAITED)
3. await turn.settled()                   ← wait for run() promise to resolve/reject
4. sink.sendJson({ type: "barge_in.ack" }) ← client notified — no audio can follow
```

**Why this ordering matters:**

- **Current bug**: Steps 2 and 4 happen simultaneously (step 2 is fire-and-forget with `.catch()`). The TTS generator may still yield frames between step 1 and the generator actually stopping. Those frames reach `sink.sendBinary()` after `barge_in.ack` was sent.
- **Fix**: Step 2 is awaited — TTS WebSocket is fully closed before proceeding. Step 3 ensures the `run()` promise has settled — no more `dispatchEvent()` calls possible. Only then does step 4 send the ack.

**TurnController change:** Add a `settled()` method that returns a promise resolving when `run()` completes:

```typescript
interface TurnController {
  run(): Promise<void>;
  abort(): void;
  settled(): Promise<void>;  // NEW — resolves when run() promise settles
  // ... existing methods
}
```

Implementation: store the `run()` promise and expose it via `settled()`.

### 5. ContinuousSession Refactor

**File:** `gateway/src/pipeline/continuous-session.ts`

After extracting the four units, ContinuousSession shrinks from ~520 lines to ~200 lines of orchestration wiring.

**State removed from ContinuousSession:**

| Old flag | Moves to |
|----------|----------|
| `isSpeechActive` | Derived from `TranscriptAccumulator.current().length > 0` |
| `accumulatedText` | `TranscriptAccumulator` |
| `deepgramVadActive` | `TranscriptAccumulator` (tracks whether we're in a speech segment) |
| `echoCooldownActive` + `echoCooldownTimer` | Eliminated — `BargeInController.minInterruptionMs` handles this |
| `assistantSpeaking` (in TurnController) | `BargeInController` receives `assistant_started/ended` events |

**State remaining in ContinuousSession:**
- `activeTurn` — the currently executing TurnController (null when idle)
- Connection state (`sttConnected`, `ttsConnected`, `isClosed`)
- Inactivity monitoring (unchanged)
- `earlyAudioBuffer` (unchanged)

**New `handleTranscriptEvent` (simplified):**

```typescript
function handleTranscriptEvent(event: TranscriptEvent): void {
  if (event.type === "speech_started") {
    accumulator.updatePartial("");  // signal speech activity
    emitter.emit("voiceDetected");
    return;
  }

  if (event.type === "utterance_end") {
    const text = accumulator.current();
    if (text.trim()) startTurnFromSpeech();
    return;
  }

  if (event.type !== "transcript") return;

  // Accumulate
  if (event.isFinal) {
    accumulator.appendFinal(event.text);
    emitter.emit("transcriptFinal", event.text);
  } else {
    accumulator.updatePartial(event.text);
    emitter.emit("transcriptPartial", event.text);
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

  // No turn active — check if speech ended
  if (event.isFinal && event.speechFinal) {
    startTurnFromSpeech();
  }
}
```

**New `executeBargeIn`:**

```typescript
async function executeBargeIn(bargeInText: string, speechFinal: boolean): Promise<void> {
  const turn = activeTurn;
  if (!turn) return;
  activeTurn = null;

  await turnTransition.execute({
    turn,
    ttsConnectionManager,
    sink,
  });

  bargeInController.handle({ type: "turn_completed" });

  if (speechFinal && bargeInText.trim()) {
    // Deepgram finalized — start new turn immediately
    accumulator.seed(bargeInText);
    startTurnFromSpeech();
  } else {
    // User still speaking — keep accumulating
    accumulator.seed(bargeInText);
    emitter.emit("speechStart");
  }
}
```

**New `startTurnFromSpeech`:**

```typescript
function startTurnFromSpeech(): void {
  const transcript = accumulator.finalize();
  if (!transcript.trim()) return;

  history.append("user", transcript);
  history.clearDraft();
  emitter.emit("speechEnd", transcript);
  startTurn(transcript);
}
```

### 6. TurnController Simplification

**File:** `gateway/src/pipeline/turn-controller.ts`

TurnController no longer handles barge-in detection or echo suppression. Those concerns move to `BargeInController` and `TurnTransition`.

**Removed from TurnController:**
- `BARGE_IN_CONFIDENCE_THRESHOLD` constant
- `ECHO_COOLDOWN_MS` constant
- `echoCooldownActive`, `echoCooldownTimer` flags
- `setAssistantSpeaking()` method
- `handleTranscript()` method (barge-in detection)
- `clientBargeIn()` method

**What remains:**
- `run()` — execute the voice turn pipeline
- `abort()` — fire the AbortSignal
- `settled()` — NEW, returns promise that resolves when `run()` settles
- `isAssistantSpeaking()` — still needed for session to feed `BargeInController`
- Event dispatch to sink (text.delta, audio.start, audio.frame, audio.done)

**New:** TurnController notifies the session when assistant starts/stops speaking via a callback, so the session can feed these events to `BargeInController`:

```typescript
interface TurnControllerOptions {
  // ... existing
  onSpeakingChanged?: (speaking: boolean) => void;  // NEW
}
```

### 7. Client SDK VAD Hardening

**File:** `shared/web-sdk/src/voice-client.ts`

**Changes:**

1. **Swap playback adapter**: Use `WebRtcAecPlayback` instead of `WebAudioPlayback`. Feature-detect `RTCPeerConnection`; fall back to `WebAudioPlayback` if unavailable.

2. **Graceful VAD degradation**: If Silero fails to init, skip it in the chain. Energy + trailing still works. Log a warning but don't crash.

3. **Atomic playback rejection on barge-in**: When `barge_in.ack` arrives:
   ```typescript
   // Set rejection flag BEFORE clearing
   playbackRejecting = true;
   playback.clear();
   // Binary message handler checks rejection flag
   transport.on("binaryMessage", (data) => {
     if (playbackRejecting) return;  // drop frames arriving after ack
     // ...
   });
   // Reset rejection flag when next turn starts
   ```
   This prevents the race where frames in-flight before the ack still get enqueued.

4. **Client-initiated barge-in**: When client VAD detects speech during playback, immediately call `playback.clear()` locally (don't wait for server ack). The ack confirms server-side cleanup; client-side cleanup is instant.

## Configuration

New environment variables:

| Var | Default | Description |
|-----|---------|-------------|
| `BARGE_IN_MIN_DURATION_MS` | `500` | Minimum speech duration before barge-in is allowed |
| `BARGE_IN_CONFIDENCE` | `0.9` | Deepgram transcript confidence threshold |
| `BARGE_IN_DEBOUNCE_MS` | `300` | Cooldown between consecutive barge-in decisions |

## Testing Strategy

Each new unit is tested in isolation:

- **BargeInController**: Pure function tests — feed events, assert decisions. Test: no-interrupt window, confidence gate, debounce, client VAD path, reset. No mocks needed.
- **TranscriptAccumulator**: Pure state tests — append/seed/finalize sequences. Test: partial replacement, final append, seed without overwrite, cross-barge-in combine.
- **TurnTransition**: Mock TurnController + TTSConnectionManager + TurnSink. Test: correct ordering (abort → reconnect → settled → ack), error handling if reconnect fails.
- **WebRtcAecPlayback**: Integration test with mocked RTCPeerConnection (verify signaling flow, audio routing). Manual test for actual echo cancellation.
- **ContinuousSession**: Integration test with all four units wired together + mock providers. Test: full barge-in flow, long speech, self-interruption recovery.

## File Plan

| File | Action | Lines (est.) |
|------|--------|-------------|
| `gateway/src/pipeline/barge-in-controller.ts` | Create | ~80 |
| `gateway/src/pipeline/barge-in-controller.test.ts` | Create | ~150 |
| `gateway/src/pipeline/transcript-accumulator.ts` | Create | ~60 |
| `gateway/src/pipeline/transcript-accumulator.test.ts` | Create | ~100 |
| `gateway/src/pipeline/turn-transition.ts` | Create | ~50 |
| `gateway/src/pipeline/turn-transition.test.ts` | Create | ~80 |
| `shared/web-sdk/src/adapters/webrtc-aec-playback.ts` | Create | ~150 |
| `shared/web-sdk/src/adapters/webrtc-aec-playback.test.ts` | Create | ~100 |
| `gateway/src/pipeline/continuous-session.ts` | Refactor | ~200 (from ~520) |
| `gateway/src/pipeline/turn-controller.ts` | Simplify | ~120 (from ~250) |
| `shared/web-sdk/src/voice-client.ts` | Modify | Swap playback, add rejection flag |
| `gateway/src/pipeline/continuous-session.test.ts` | Update | Update for new wiring |
| `gateway/src/pipeline/turn-controller.test.ts` | Update | Remove barge-in tests (moved) |

## Error Handling

- **TurnTransition reconnect fails**: Log error, still send `barge_in.ack` (client needs to know). TTS connection will be rebuilt on next turn start.
- **BargeInController receives events in unexpected order**: Return `{ action: "none" }` for any unrecognized state. Never crash.
- **TranscriptAccumulator seed with empty text**: No-op. Don't append empty strings.
- **WebRtcAecPlayback init fails**: Fall back to WebAudioPlayback, log warning. Pipeline continues with confidence gate as safety net.
- **WebSocket send fails**: TurnSink wraps `ws.send()` in try/catch, logs failure. No silent swallowing.
