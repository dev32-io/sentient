/**
 * Client-Side VAD State Machine — Formal Transition Table
 *
 * Models the complete lifecycle of the SDK's voice activity detection,
 * covering VAD mode, push-to-talk mode, and continuous mode.
 *
 * Pure function: (state, event) → { state, effects[] }
 * No side effects, no I/O. Effects are descriptors the caller interprets.
 */

// ─── States ───────────────────────────────────────────────────────────

export type VadState =
  | "inactive"           // SDK not started, no mic access
  | "requesting-mic"     // Awaiting getUserMedia permission
  | "listening"          // Mic active, waiting for speech (VAD mode) or user action (PTT mode)
  | "speech-detected"    // VAD onset debounce — energy/ML detected but not yet confirmed
  | "user-speaking"      // Confirmed speech, audio flowing to gateway
  | "trailing-silence"   // Speech ended per VAD, waiting silence timeout before committing
  | "processing"         // audio.end sent, waiting for gateway response
  | "assistant-speaking" // Gateway is streaming response audio
  | "interrupting"       // User spoke during assistant — barge-in in progress
  | "error"             // Recoverable error state
  | "disposed";          // SDK torn down, terminal state

// ─── Events ───────────────────────────────────────────────────────────

export type VadEvent =
  | { type: "START"; mode: DetectionMode }           // SDK.start()
  | { type: "MIC_GRANTED" }                          // getUserMedia succeeded
  | { type: "MIC_DENIED"; reason: string }           // getUserMedia failed
  | { type: "SPEECH_DETECTED" }                      // VAD onset (energy/ML threshold crossed)
  | { type: "SPEECH_CONFIRMED" }                     // Onset debounce passed (3+ frames)
  | { type: "SILENCE_DETECTED" }                     // VAD offset (energy/ML below threshold)
  | { type: "SILENCE_TIMEOUT" }                      // Silence duration exceeded threshold (700ms default)
  | { type: "PTT_PRESS" }                            // Push-to-talk button pressed
  | { type: "PTT_RELEASE" }                          // Push-to-talk button released
  | { type: "RESPONSE_START" }                       // Gateway starts streaming response
  | { type: "RESPONSE_DONE" }                        // Gateway finished response
  | { type: "BARGE_IN_ACK" }                         // Gateway acknowledged barge-in
  | { type: "PROCESSING_TIMEOUT" }                   // Processing took too long
  | { type: "ERROR"; error: string }                 // Recoverable error occurred
  | { type: "RECOVER" }                              // User/SDK retries after error
  | { type: "STOP" }                                 // SDK.stop()
  | { type: "DISPOSE" }                              // SDK.dispose() — terminal

export type DetectionMode = "vad" | "ptt" | "continuous";

// ─── Effects ──────────────────────────────────────────────────────────

export type VadEffect =
  | { type: "REQUEST_MIC" }
  | { type: "START_CAPTURE" }
  | { type: "STOP_CAPTURE" }
  | { type: "SEND_AUDIO_START" }
  | { type: "SEND_AUDIO_END" }
  | { type: "SEND_BARGE_IN" }
  | { type: "START_TIMER"; name: string; durationMs: number }
  | { type: "CANCEL_TIMER"; name: string }
  | { type: "CLEAR_PLAYBACK" }
  | { type: "RELEASE_MIC" }
  | { type: "EMIT_STATE"; state: VadState }
  | { type: "EMIT_ERROR"; error: string };

// ─── Context ──────────────────────────────────────────────────────────

export interface VadContext {
  state: VadState;
  mode: DetectionMode;
  /** Tracks if we're in a barge-in that needs special handling */
  bargeInPending: boolean;
}

export interface TransitionResult {
  context: VadContext;
  effects: VadEffect[];
}

// ─── Initial Context ──────────────────────────────────────────────────

export function initialContext(): VadContext {
  return {
    state: "inactive",
    mode: "vad",
    bargeInPending: false,
  };
}

// ─── Transition Function ──────────────────────────────────────────────

export function transition(ctx: VadContext, event: VadEvent): TransitionResult {
  const { state, mode } = ctx;

  // DISPOSE is always valid from any non-terminal state
  if (event.type === "DISPOSE" && state !== "disposed") {
    return {
      context: { ...ctx, state: "disposed" },
      effects: [
        { type: "CANCEL_TIMER", name: "silence" },
        { type: "CANCEL_TIMER", name: "processing" },
        { type: "CANCEL_TIMER", name: "onset-debounce" },
        { type: "STOP_CAPTURE" },
        { type: "RELEASE_MIC" },
        { type: "EMIT_STATE", state: "disposed" },
      ],
    };
  }

  // STOP is valid from any active state (not inactive/disposed)
  if (
    event.type === "STOP" &&
    state !== "inactive" &&
    state !== "disposed"
  ) {
    return {
      context: { ...ctx, state: "inactive", bargeInPending: false },
      effects: [
        { type: "CANCEL_TIMER", name: "silence" },
        { type: "CANCEL_TIMER", name: "processing" },
        { type: "CANCEL_TIMER", name: "onset-debounce" },
        { type: "STOP_CAPTURE" },
        { type: "RELEASE_MIC" },
        { type: "EMIT_STATE", state: "inactive" },
      ],
    };
  }

  switch (state) {
    // ─── INACTIVE ───────────────────────────────────────────
    case "inactive": {
      if (event.type === "START") {
        return {
          context: { ...ctx, state: "requesting-mic", mode: event.mode },
          effects: [
            { type: "REQUEST_MIC" },
            { type: "EMIT_STATE", state: "requesting-mic" },
          ],
        };
      }
      break;
    }

    // ─── REQUESTING MIC ─────────────────────────────────────
    case "requesting-mic": {
      if (event.type === "MIC_GRANTED") {
        const newState: VadState = "listening";
        const effects: VadEffect[] = [
          { type: "START_CAPTURE" },
          { type: "EMIT_STATE", state: newState },
        ];
        // In continuous mode, immediately start sending audio
        if (ctx.mode === "continuous") {
          effects.push({ type: "SEND_AUDIO_START" });
        }
        return { context: { ...ctx, state: newState }, effects };
      }
      if (event.type === "MIC_DENIED") {
        return {
          context: { ...ctx, state: "error" },
          effects: [
            { type: "EMIT_ERROR", error: event.reason },
            { type: "EMIT_STATE", state: "error" },
          ],
        };
      }
      break;
    }

    // ─── LISTENING ──────────────────────────────────────────
    case "listening": {
      if (event.type === "SPEECH_DETECTED" && mode === "vad") {
        return {
          context: { ...ctx, state: "speech-detected" },
          effects: [
            { type: "START_TIMER", name: "onset-debounce", durationMs: 32 },
            { type: "EMIT_STATE", state: "speech-detected" },
          ],
        };
      }
      if (event.type === "PTT_PRESS" && mode === "ptt") {
        return {
          context: { ...ctx, state: "user-speaking" },
          effects: [
            { type: "SEND_AUDIO_START" },
            { type: "EMIT_STATE", state: "user-speaking" },
          ],
        };
      }
      if (event.type === "ERROR") {
        return {
          context: { ...ctx, state: "error" },
          effects: [
            { type: "EMIT_ERROR", error: event.error },
            { type: "EMIT_STATE", state: "error" },
          ],
        };
      }
      break;
    }

    // ─── SPEECH DETECTED (onset debounce) ───────────────────
    case "speech-detected": {
      if (event.type === "SPEECH_CONFIRMED") {
        return {
          context: { ...ctx, state: "user-speaking" },
          effects: [
            { type: "CANCEL_TIMER", name: "onset-debounce" },
            { type: "SEND_AUDIO_START" },
            { type: "EMIT_STATE", state: "user-speaking" },
          ],
        };
      }
      if (event.type === "SILENCE_DETECTED") {
        // False alarm (cough, etc.) — back to listening
        return {
          context: { ...ctx, state: "listening" },
          effects: [
            { type: "CANCEL_TIMER", name: "onset-debounce" },
            { type: "EMIT_STATE", state: "listening" },
          ],
        };
      }
      if (event.type === "ERROR") {
        return {
          context: { ...ctx, state: "error" },
          effects: [
            { type: "CANCEL_TIMER", name: "onset-debounce" },
            { type: "EMIT_ERROR", error: event.error },
            { type: "EMIT_STATE", state: "error" },
          ],
        };
      }
      break;
    }

    // ─── USER SPEAKING ──────────────────────────────────────
    case "user-speaking": {
      if (event.type === "SILENCE_DETECTED" && mode === "vad") {
        return {
          context: { ...ctx, state: "trailing-silence" },
          effects: [
            { type: "START_TIMER", name: "silence", durationMs: 700 },
            { type: "EMIT_STATE", state: "trailing-silence" },
          ],
        };
      }
      if (event.type === "PTT_RELEASE" && mode === "ptt") {
        return {
          context: { ...ctx, state: "processing" },
          effects: [
            { type: "SEND_AUDIO_END" },
            { type: "START_TIMER", name: "processing", durationMs: 15000 },
            { type: "EMIT_STATE", state: "processing" },
          ],
        };
      }
      if (event.type === "ERROR") {
        return {
          context: { ...ctx, state: "error" },
          effects: [
            { type: "SEND_AUDIO_END" },
            { type: "EMIT_ERROR", error: event.error },
            { type: "EMIT_STATE", state: "error" },
          ],
        };
      }
      break;
    }

    // ─── TRAILING SILENCE ───────────────────────────────────
    case "trailing-silence": {
      if (event.type === "SPEECH_DETECTED") {
        // User resumed speaking — cancel silence timer, back to speaking
        return {
          context: { ...ctx, state: "user-speaking" },
          effects: [
            { type: "CANCEL_TIMER", name: "silence" },
            { type: "EMIT_STATE", state: "user-speaking" },
          ],
        };
      }
      if (event.type === "SILENCE_TIMEOUT") {
        return {
          context: { ...ctx, state: "processing" },
          effects: [
            { type: "SEND_AUDIO_END" },
            { type: "START_TIMER", name: "processing", durationMs: 15000 },
            { type: "EMIT_STATE", state: "processing" },
          ],
        };
      }
      if (event.type === "ERROR") {
        return {
          context: { ...ctx, state: "error" },
          effects: [
            { type: "CANCEL_TIMER", name: "silence" },
            { type: "SEND_AUDIO_END" },
            { type: "EMIT_ERROR", error: event.error },
            { type: "EMIT_STATE", state: "error" },
          ],
        };
      }
      break;
    }

    // ─── PROCESSING ─────────────────────────────────────────
    case "processing": {
      if (event.type === "RESPONSE_START") {
        return {
          context: { ...ctx, state: "assistant-speaking" },
          effects: [
            { type: "CANCEL_TIMER", name: "processing" },
            { type: "EMIT_STATE", state: "assistant-speaking" },
          ],
        };
      }
      if (event.type === "PROCESSING_TIMEOUT") {
        return {
          context: { ...ctx, state: "error" },
          effects: [
            { type: "EMIT_ERROR", error: "Response timed out — please try again" },
            { type: "EMIT_STATE", state: "error" },
          ],
        };
      }
      // User speaks again before response — double utterance
      if (event.type === "SPEECH_DETECTED" && mode === "vad") {
        // Gateway handles queuing; we allow new speech
        return {
          context: { ...ctx, state: "speech-detected" },
          effects: [
            { type: "CANCEL_TIMER", name: "processing" },
            { type: "START_TIMER", name: "onset-debounce", durationMs: 32 },
            { type: "EMIT_STATE", state: "speech-detected" },
          ],
        };
      }
      if (event.type === "PTT_PRESS" && mode === "ptt") {
        return {
          context: { ...ctx, state: "user-speaking" },
          effects: [
            { type: "CANCEL_TIMER", name: "processing" },
            { type: "SEND_AUDIO_START" },
            { type: "EMIT_STATE", state: "user-speaking" },
          ],
        };
      }
      if (event.type === "ERROR") {
        return {
          context: { ...ctx, state: "error" },
          effects: [
            { type: "CANCEL_TIMER", name: "processing" },
            { type: "EMIT_ERROR", error: event.error },
            { type: "EMIT_STATE", state: "error" },
          ],
        };
      }
      break;
    }

    // ─── ASSISTANT SPEAKING ─────────────────────────────────
    case "assistant-speaking": {
      if (event.type === "RESPONSE_DONE") {
        return {
          context: { ...ctx, state: "listening" },
          effects: [{ type: "EMIT_STATE", state: "listening" }],
        };
      }
      // Barge-in: user speaks during assistant
      if (event.type === "SPEECH_DETECTED" && mode === "vad") {
        return {
          context: { ...ctx, state: "interrupting", bargeInPending: true },
          effects: [
            { type: "SEND_BARGE_IN" },
            { type: "CLEAR_PLAYBACK" },
            { type: "START_TIMER", name: "onset-debounce", durationMs: 32 },
            { type: "EMIT_STATE", state: "interrupting" },
          ],
        };
      }
      if (event.type === "PTT_PRESS" && mode === "ptt") {
        return {
          context: { ...ctx, state: "interrupting", bargeInPending: true },
          effects: [
            { type: "SEND_BARGE_IN" },
            { type: "CLEAR_PLAYBACK" },
            { type: "EMIT_STATE", state: "interrupting" },
          ],
        };
      }
      if (event.type === "ERROR") {
        return {
          context: { ...ctx, state: "error" },
          effects: [
            { type: "CLEAR_PLAYBACK" },
            { type: "EMIT_ERROR", error: event.error },
            { type: "EMIT_STATE", state: "error" },
          ],
        };
      }
      break;
    }

    // ─── INTERRUPTING (barge-in) ────────────────────────────
    case "interrupting": {
      if (event.type === "BARGE_IN_ACK") {
        // Gateway confirmed barge-in; now user is speaking
        return {
          context: { ...ctx, state: "user-speaking", bargeInPending: false },
          effects: [
            { type: "SEND_AUDIO_START" },
            { type: "EMIT_STATE", state: "user-speaking" },
          ],
        };
      }
      if (event.type === "SPEECH_CONFIRMED") {
        // VAD confirmed speech during barge-in wait — stay in interrupting
        // but note that speech is real (not echo)
        return { context: ctx, effects: [] };
      }
      if (event.type === "SILENCE_DETECTED") {
        // User stopped before barge-in was acknowledged — false alarm
        return {
          context: { ...ctx, state: "assistant-speaking", bargeInPending: false },
          effects: [
            { type: "CANCEL_TIMER", name: "onset-debounce" },
            { type: "EMIT_STATE", state: "assistant-speaking" },
          ],
        };
      }
      if (event.type === "PTT_RELEASE" && mode === "ptt") {
        return {
          context: { ...ctx, state: "processing", bargeInPending: false },
          effects: [
            { type: "SEND_AUDIO_END" },
            { type: "START_TIMER", name: "processing", durationMs: 15000 },
            { type: "EMIT_STATE", state: "processing" },
          ],
        };
      }
      if (event.type === "ERROR") {
        return {
          context: { ...ctx, state: "error", bargeInPending: false },
          effects: [
            { type: "CANCEL_TIMER", name: "onset-debounce" },
            { type: "EMIT_ERROR", error: event.error },
            { type: "EMIT_STATE", state: "error" },
          ],
        };
      }
      break;
    }

    // ─── ERROR ──────────────────────────────────────────────
    case "error": {
      if (event.type === "RECOVER") {
        return {
          context: { ...ctx, state: "listening", bargeInPending: false },
          effects: [{ type: "EMIT_STATE", state: "listening" }],
        };
      }
      break;
    }

    // ─── DISPOSED (terminal) ────────────────────────────────
    case "disposed": {
      // No transitions out of disposed
      break;
    }
  }

  // No matching transition — event ignored in this state
  return { context: ctx, effects: [] };
}

// ─── Formal Transition Table (for documentation/verification) ────────

export interface TransitionEntry {
  from: VadState;
  event: VadEvent["type"];
  modeConstraint?: DetectionMode;
  to: VadState;
  effects: string[];
}

/**
 * Complete transition table — every valid (state, event) → state mapping.
 * Used by tests to verify exhaustiveness.
 */
export const TRANSITION_TABLE: TransitionEntry[] = [
  // INACTIVE
  { from: "inactive", event: "START", to: "requesting-mic", effects: ["REQUEST_MIC"] },
  { from: "inactive", event: "DISPOSE", to: "disposed", effects: ["RELEASE_MIC"] },

  // REQUESTING-MIC
  { from: "requesting-mic", event: "MIC_GRANTED", to: "listening", effects: ["START_CAPTURE"] },
  { from: "requesting-mic", event: "MIC_DENIED", to: "error", effects: ["EMIT_ERROR"] },
  { from: "requesting-mic", event: "STOP", to: "inactive", effects: ["RELEASE_MIC"] },
  { from: "requesting-mic", event: "DISPOSE", to: "disposed", effects: ["RELEASE_MIC"] },

  // LISTENING
  { from: "listening", event: "SPEECH_DETECTED", modeConstraint: "vad", to: "speech-detected", effects: ["START_TIMER"] },
  { from: "listening", event: "PTT_PRESS", modeConstraint: "ptt", to: "user-speaking", effects: ["SEND_AUDIO_START"] },
  { from: "listening", event: "ERROR", to: "error", effects: ["EMIT_ERROR"] },
  { from: "listening", event: "STOP", to: "inactive", effects: ["STOP_CAPTURE", "RELEASE_MIC"] },
  { from: "listening", event: "DISPOSE", to: "disposed", effects: ["STOP_CAPTURE", "RELEASE_MIC"] },

  // SPEECH-DETECTED
  { from: "speech-detected", event: "SPEECH_CONFIRMED", to: "user-speaking", effects: ["SEND_AUDIO_START"] },
  { from: "speech-detected", event: "SILENCE_DETECTED", to: "listening", effects: ["CANCEL_TIMER"] },
  { from: "speech-detected", event: "ERROR", to: "error", effects: ["CANCEL_TIMER", "EMIT_ERROR"] },
  { from: "speech-detected", event: "STOP", to: "inactive", effects: ["STOP_CAPTURE", "RELEASE_MIC"] },
  { from: "speech-detected", event: "DISPOSE", to: "disposed", effects: ["STOP_CAPTURE", "RELEASE_MIC"] },

  // USER-SPEAKING
  { from: "user-speaking", event: "SILENCE_DETECTED", modeConstraint: "vad", to: "trailing-silence", effects: ["START_TIMER"] },
  { from: "user-speaking", event: "PTT_RELEASE", modeConstraint: "ptt", to: "processing", effects: ["SEND_AUDIO_END", "START_TIMER"] },
  { from: "user-speaking", event: "ERROR", to: "error", effects: ["SEND_AUDIO_END", "EMIT_ERROR"] },
  { from: "user-speaking", event: "STOP", to: "inactive", effects: ["STOP_CAPTURE", "RELEASE_MIC"] },
  { from: "user-speaking", event: "DISPOSE", to: "disposed", effects: ["STOP_CAPTURE", "RELEASE_MIC"] },

  // TRAILING-SILENCE
  { from: "trailing-silence", event: "SPEECH_DETECTED", to: "user-speaking", effects: ["CANCEL_TIMER"] },
  { from: "trailing-silence", event: "SILENCE_TIMEOUT", to: "processing", effects: ["SEND_AUDIO_END", "START_TIMER"] },
  { from: "trailing-silence", event: "ERROR", to: "error", effects: ["CANCEL_TIMER", "SEND_AUDIO_END", "EMIT_ERROR"] },
  { from: "trailing-silence", event: "STOP", to: "inactive", effects: ["STOP_CAPTURE", "RELEASE_MIC"] },
  { from: "trailing-silence", event: "DISPOSE", to: "disposed", effects: ["STOP_CAPTURE", "RELEASE_MIC"] },

  // PROCESSING
  { from: "processing", event: "RESPONSE_START", to: "assistant-speaking", effects: ["CANCEL_TIMER"] },
  { from: "processing", event: "PROCESSING_TIMEOUT", to: "error", effects: ["EMIT_ERROR"] },
  { from: "processing", event: "SPEECH_DETECTED", modeConstraint: "vad", to: "speech-detected", effects: ["CANCEL_TIMER", "START_TIMER"] },
  { from: "processing", event: "PTT_PRESS", modeConstraint: "ptt", to: "user-speaking", effects: ["CANCEL_TIMER", "SEND_AUDIO_START"] },
  { from: "processing", event: "ERROR", to: "error", effects: ["CANCEL_TIMER", "EMIT_ERROR"] },
  { from: "processing", event: "STOP", to: "inactive", effects: ["STOP_CAPTURE", "RELEASE_MIC"] },
  { from: "processing", event: "DISPOSE", to: "disposed", effects: ["STOP_CAPTURE", "RELEASE_MIC"] },

  // ASSISTANT-SPEAKING
  { from: "assistant-speaking", event: "RESPONSE_DONE", to: "listening", effects: [] },
  { from: "assistant-speaking", event: "SPEECH_DETECTED", modeConstraint: "vad", to: "interrupting", effects: ["SEND_BARGE_IN", "CLEAR_PLAYBACK", "START_TIMER"] },
  { from: "assistant-speaking", event: "PTT_PRESS", modeConstraint: "ptt", to: "interrupting", effects: ["SEND_BARGE_IN", "CLEAR_PLAYBACK"] },
  { from: "assistant-speaking", event: "ERROR", to: "error", effects: ["CLEAR_PLAYBACK", "EMIT_ERROR"] },
  { from: "assistant-speaking", event: "STOP", to: "inactive", effects: ["STOP_CAPTURE", "RELEASE_MIC"] },
  { from: "assistant-speaking", event: "DISPOSE", to: "disposed", effects: ["STOP_CAPTURE", "RELEASE_MIC"] },

  // INTERRUPTING
  { from: "interrupting", event: "BARGE_IN_ACK", to: "user-speaking", effects: ["SEND_AUDIO_START"] },
  { from: "interrupting", event: "SILENCE_DETECTED", to: "assistant-speaking", effects: ["CANCEL_TIMER"] },
  { from: "interrupting", event: "PTT_RELEASE", modeConstraint: "ptt", to: "processing", effects: ["SEND_AUDIO_END", "START_TIMER"] },
  { from: "interrupting", event: "ERROR", to: "error", effects: ["CANCEL_TIMER", "EMIT_ERROR"] },
  { from: "interrupting", event: "STOP", to: "inactive", effects: ["STOP_CAPTURE", "RELEASE_MIC"] },
  { from: "interrupting", event: "DISPOSE", to: "disposed", effects: ["STOP_CAPTURE", "RELEASE_MIC"] },

  // ERROR
  { from: "error", event: "RECOVER", to: "listening", effects: [] },
  { from: "error", event: "STOP", to: "inactive", effects: ["STOP_CAPTURE", "RELEASE_MIC"] },
  { from: "error", event: "DISPOSE", to: "disposed", effects: ["RELEASE_MIC"] },
];

// ─── All states and events (for exhaustiveness checks) ────────────────

export const ALL_STATES: VadState[] = [
  "inactive", "requesting-mic", "listening", "speech-detected",
  "user-speaking", "trailing-silence", "processing", "assistant-speaking",
  "interrupting", "error", "disposed",
];

export const ALL_EVENT_TYPES: VadEvent["type"][] = [
  "START", "MIC_GRANTED", "MIC_DENIED", "SPEECH_DETECTED",
  "SPEECH_CONFIRMED", "SILENCE_DETECTED", "SILENCE_TIMEOUT",
  "PTT_PRESS", "PTT_RELEASE", "RESPONSE_START", "RESPONSE_DONE",
  "BARGE_IN_ACK", "PROCESSING_TIMEOUT", "ERROR", "RECOVER",
  "STOP", "DISPOSE",
];

/** States that have a timeout guard (waiting states that must not hang) */
export const TIMEOUT_GUARDED_STATES: Record<string, { timer: string; event: VadEvent["type"] }> = {
  "speech-detected": { timer: "onset-debounce", event: "SILENCE_DETECTED" },
  "trailing-silence": { timer: "silence", event: "SILENCE_TIMEOUT" },
  "processing": { timer: "processing", event: "PROCESSING_TIMEOUT" },
};
