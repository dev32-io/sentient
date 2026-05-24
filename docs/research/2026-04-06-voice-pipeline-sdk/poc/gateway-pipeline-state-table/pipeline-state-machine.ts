/**
 * Gateway Pipeline State Machine — Formal Transition Table
 *
 * Models the complete server-side lifecycle of the voice pipeline:
 * session connection, utterance processing, STT→LLM→TTS stage execution,
 * barge-in, provider failures, and reconnection.
 *
 * Pure function: (state, event) → { state, effects[] }
 * No side effects, no I/O. Effects are descriptors the caller (FlowManager) interprets.
 */

// ─── States ───────────────────────────────────────────────────────────

export type PipelineState =
  | "disconnected"       // No session — waiting for WS connection
  | "connecting"         // Connecting STT + TTS providers
  | "idle"               // Session active, no utterance in progress
  | "receiving-audio"    // Client sent utterance.start, audio streaming to STT
  | "finalizing-stt"     // utterance.end received, STT finalizing transcript
  | "running-llm"       // Final transcript received, LLM streaming tokens
  | "running-tts"       // Sentences ready, TTS synthesizing audio (LLM may still be streaming)
  | "streaming-response" // TTS audio being sent to client (LLM+TTS may overlap)
  | "cancelling"        // Barge-in received, aborting current turn
  | "reconnecting"      // Provider connection dropped, attempting reconnect
  | "error"             // Recoverable error — turn failed, session alive
  | "closed";           // Terminal — session ended

// ─── Events ───────────────────────────────────────────────────────────

export type PipelineEvent =
  | { type: "SESSION_START"; sessionId: string }     // Client connects WS
  | { type: "PROVIDERS_READY" }                       // STT + TTS connected
  | { type: "PROVIDER_CONNECT_FAILED"; reason: string } // Provider connection failed
  | { type: "UTTERANCE_START" }                       // Client: utterance.start
  | { type: "AUDIO_CHUNK" }                           // Client: binary audio data
  | { type: "UTTERANCE_END" }                         // Client: utterance.end
  | { type: "TRANSCRIPT_PARTIAL"; text: string }      // STT emits partial
  | { type: "TRANSCRIPT_FINAL"; text: string }        // STT emits final transcript
  | { type: "STT_TIMEOUT" }                           // STT took too long to finalize
  | { type: "LLM_TOKEN"; token: string }              // LLM yields token
  | { type: "LLM_DONE"; fullText: string }            // LLM stream complete
  | { type: "LLM_TIMEOUT" }                           // LLM took too long
  | { type: "SENTENCE_READY"; sentence: string }      // Sentence aggregator produced a sentence
  | { type: "TTS_AUDIO"; data: Uint8Array }           // TTS yields audio chunk
  | { type: "TTS_DONE" }                              // TTS finished current sentence
  | { type: "TURN_COMPLETE" }                         // All stages done, response fully sent
  | { type: "BARGE_IN" }                              // Client: barge-in request
  | { type: "CANCEL_COMPLETE" }                       // Abort propagated, stages cleaned up
  | { type: "PROVIDER_DROPPED"; provider: string }    // STT/TTS connection lost
  | { type: "RECONNECT_SUCCESS" }                     // Provider reconnected
  | { type: "RECONNECT_FAILED"; reason: string }      // Reconnect gave up
  | { type: "RECONNECT_TIMEOUT" }                     // Reconnect took too long
  | { type: "ERROR"; error: string }                  // Generic recoverable error
  | { type: "RECOVER" }                               // Auto-recover or user retry
  | { type: "SESSION_END" }                           // Client disconnects / server shutdown
  | { type: "DESTROY" };                              // Forceful teardown

// ─── Effects ──────────────────────────────────────────────────────────

export type PipelineEffect =
  | { type: "CONNECT_PROVIDERS" }
  | { type: "DISCONNECT_PROVIDERS" }
  | { type: "RECONNECT_PROVIDER"; provider: string }
  | { type: "INIT_STT_STREAM" }                       // Prepare STT for audio
  | { type: "FORWARD_AUDIO_TO_STT" }                  // Send audio chunk to STT
  | { type: "FINALIZE_STT" }                           // Tell STT no more audio
  | { type: "RELAY_PARTIAL_TRANSCRIPT"; text: string } // Send partial to client
  | { type: "START_LLM_STREAM"; transcript: string }   // Kick off LLM with transcript
  | { type: "RELAY_TEXT_DELTA"; token: string }        // Send text delta to client
  | { type: "RELAY_TEXT_DONE"; text: string }          // Send text done to client
  | { type: "START_TTS"; sentence: string }            // Synthesize sentence
  | { type: "RELAY_AUDIO_FRAME"; data: Uint8Array }   // Send audio frame to client
  | { type: "RELAY_AUDIO_DONE" }                       // Signal audio stream end to client
  | { type: "APPEND_HISTORY"; role: string; content: string } // Append to conversation
  | { type: "ABORT_TURN" }                             // Abort current turn's AbortController
  | { type: "FLUSH_STT_QUEUE" }                        // Clear stale transcript events
  | { type: "SEND_STATUS"; status: string }            // Send status indicator to client
  | { type: "SEND_ERROR"; code: string; message: string } // Send error message to client
  | { type: "START_TIMER"; name: string; durationMs: number }
  | { type: "CANCEL_TIMER"; name: string }
  | { type: "EMIT_STATE"; state: PipelineState }
  | { type: "CLOSE_SESSION" };

// ─── Context ──────────────────────────────────────────────────────────

export interface PipelineContext {
  state: PipelineState;
  sessionId: string | null;
  /** Whether LLM is still producing tokens during TTS phase */
  llmActive: boolean;
  /** Which provider dropped (for targeted reconnect) */
  droppedProvider: string | null;
  /** Number of reconnect attempts */
  reconnectAttempts: number;
}

export interface TransitionResult {
  context: PipelineContext;
  effects: PipelineEffect[];
}

// ─── Initial Context ──────────────────────────────────────────────────

export function initialContext(): PipelineContext {
  return {
    state: "disconnected",
    sessionId: null,
    llmActive: false,
    droppedProvider: null,
    reconnectAttempts: 0,
  };
}

// ─── Transition Function ──────────────────────────────────────────────

export function transition(ctx: PipelineContext, event: PipelineEvent): TransitionResult {
  const { state } = ctx;

  // DESTROY is always valid from any non-terminal state
  if (event.type === "DESTROY" && state !== "closed") {
    return {
      context: { ...ctx, state: "closed", llmActive: false },
      effects: [
        { type: "ABORT_TURN" },
        { type: "CANCEL_TIMER", name: "stt" },
        { type: "CANCEL_TIMER", name: "llm" },
        { type: "CANCEL_TIMER", name: "reconnect" },
        { type: "DISCONNECT_PROVIDERS" },
        { type: "CLOSE_SESSION" },
        { type: "EMIT_STATE", state: "closed" },
      ],
    };
  }

  // SESSION_END is valid from any active state
  if (event.type === "SESSION_END" && state !== "disconnected" && state !== "closed") {
    return {
      context: { ...ctx, state: "closed", llmActive: false },
      effects: [
        { type: "ABORT_TURN" },
        { type: "CANCEL_TIMER", name: "stt" },
        { type: "CANCEL_TIMER", name: "llm" },
        { type: "CANCEL_TIMER", name: "reconnect" },
        { type: "DISCONNECT_PROVIDERS" },
        { type: "CLOSE_SESSION" },
        { type: "EMIT_STATE", state: "closed" },
      ],
    };
  }

  switch (state) {
    // ─── DISCONNECTED ───────────────────────────────────────
    case "disconnected": {
      if (event.type === "SESSION_START") {
        return {
          context: { ...ctx, state: "connecting", sessionId: event.sessionId },
          effects: [
            { type: "CONNECT_PROVIDERS" },
            { type: "SEND_STATUS", status: "connecting" },
            { type: "EMIT_STATE", state: "connecting" },
          ],
        };
      }
      break;
    }

    // ─── CONNECTING ─────────────────────────────────────────
    case "connecting": {
      if (event.type === "PROVIDERS_READY") {
        return {
          context: { ...ctx, state: "idle" },
          effects: [
            { type: "SEND_STATUS", status: "ready" },
            { type: "EMIT_STATE", state: "idle" },
          ],
        };
      }
      if (event.type === "PROVIDER_CONNECT_FAILED") {
        return {
          context: { ...ctx, state: "error" },
          effects: [
            { type: "SEND_ERROR", code: "provider.connect_failed", message: event.reason },
            { type: "EMIT_STATE", state: "error" },
          ],
        };
      }
      break;
    }

    // ─── IDLE ───────────────────────────────────────────────
    case "idle": {
      if (event.type === "UTTERANCE_START") {
        return {
          context: { ...ctx, state: "receiving-audio" },
          effects: [
            { type: "FLUSH_STT_QUEUE" },
            { type: "INIT_STT_STREAM" },
            { type: "SEND_STATUS", status: "listening" },
            { type: "EMIT_STATE", state: "receiving-audio" },
          ],
        };
      }
      if (event.type === "PROVIDER_DROPPED") {
        return {
          context: { ...ctx, state: "reconnecting", droppedProvider: event.provider, reconnectAttempts: 0 },
          effects: [
            { type: "RECONNECT_PROVIDER", provider: event.provider },
            { type: "START_TIMER", name: "reconnect", durationMs: 10000 },
            { type: "SEND_STATUS", status: "reconnecting" },
            { type: "EMIT_STATE", state: "reconnecting" },
          ],
        };
      }
      if (event.type === "ERROR") {
        return {
          context: { ...ctx, state: "error" },
          effects: [
            { type: "SEND_ERROR", code: "session.error", message: event.error },
            { type: "EMIT_STATE", state: "error" },
          ],
        };
      }
      break;
    }

    // ─── RECEIVING AUDIO ────────────────────────────────────
    case "receiving-audio": {
      if (event.type === "AUDIO_CHUNK") {
        return {
          context: ctx,
          effects: [{ type: "FORWARD_AUDIO_TO_STT" }],
        };
      }
      if (event.type === "TRANSCRIPT_PARTIAL") {
        return {
          context: ctx,
          effects: [{ type: "RELAY_PARTIAL_TRANSCRIPT", text: event.text }],
        };
      }
      if (event.type === "UTTERANCE_END") {
        return {
          context: { ...ctx, state: "finalizing-stt" },
          effects: [
            { type: "FINALIZE_STT" },
            { type: "SEND_STATUS", status: "processing" },
            { type: "START_TIMER", name: "stt", durationMs: 5000 },
            { type: "EMIT_STATE", state: "finalizing-stt" },
          ],
        };
      }
      if (event.type === "BARGE_IN") {
        // Barge-in during audio receive = cancel current utterance, go back to idle
        return {
          context: { ...ctx, state: "idle" },
          effects: [
            { type: "ABORT_TURN" },
            { type: "FLUSH_STT_QUEUE" },
            { type: "SEND_STATUS", status: "ready" },
            { type: "EMIT_STATE", state: "idle" },
          ],
        };
      }
      if (event.type === "PROVIDER_DROPPED") {
        return {
          context: { ...ctx, state: "error" },
          effects: [
            { type: "ABORT_TURN" },
            { type: "SEND_ERROR", code: "provider.dropped", message: `${event.provider} disconnected during audio` },
            { type: "EMIT_STATE", state: "error" },
          ],
        };
      }
      if (event.type === "ERROR") {
        return {
          context: { ...ctx, state: "error" },
          effects: [
            { type: "ABORT_TURN" },
            { type: "SEND_ERROR", code: "pipeline.error", message: event.error },
            { type: "EMIT_STATE", state: "error" },
          ],
        };
      }
      break;
    }

    // ─── FINALIZING STT ─────────────────────────────────────
    case "finalizing-stt": {
      if (event.type === "TRANSCRIPT_PARTIAL") {
        return {
          context: ctx,
          effects: [{ type: "RELAY_PARTIAL_TRANSCRIPT", text: event.text }],
        };
      }
      if (event.type === "TRANSCRIPT_FINAL") {
        return {
          context: { ...ctx, state: "running-llm", llmActive: true },
          effects: [
            { type: "CANCEL_TIMER", name: "stt" },
            { type: "APPEND_HISTORY", role: "user", content: event.text },
            { type: "START_LLM_STREAM", transcript: event.text },
            { type: "SEND_STATUS", status: "thinking" },
            { type: "START_TIMER", name: "llm", durationMs: 30000 },
            { type: "EMIT_STATE", state: "running-llm" },
          ],
        };
      }
      if (event.type === "STT_TIMEOUT") {
        return {
          context: { ...ctx, state: "error" },
          effects: [
            { type: "SEND_ERROR", code: "stt.timeout", message: "Transcription timed out — please try again" },
            { type: "EMIT_STATE", state: "error" },
          ],
        };
      }
      if (event.type === "BARGE_IN") {
        return {
          context: { ...ctx, state: "idle" },
          effects: [
            { type: "ABORT_TURN" },
            { type: "CANCEL_TIMER", name: "stt" },
            { type: "FLUSH_STT_QUEUE" },
            { type: "SEND_STATUS", status: "ready" },
            { type: "EMIT_STATE", state: "idle" },
          ],
        };
      }
      if (event.type === "ERROR") {
        return {
          context: { ...ctx, state: "error" },
          effects: [
            { type: "CANCEL_TIMER", name: "stt" },
            { type: "SEND_ERROR", code: "stt.error", message: event.error },
            { type: "EMIT_STATE", state: "error" },
          ],
        };
      }
      break;
    }

    // ─── RUNNING LLM ────────────────────────────────────────
    case "running-llm": {
      if (event.type === "LLM_TOKEN") {
        return {
          context: ctx,
          effects: [{ type: "RELAY_TEXT_DELTA", token: event.token }],
        };
      }
      if (event.type === "SENTENCE_READY") {
        // First sentence ready → start TTS while LLM continues (overlap)
        return {
          context: { ...ctx, state: "streaming-response" },
          effects: [
            { type: "START_TTS", sentence: event.sentence },
            { type: "SEND_STATUS", status: "speaking" },
            { type: "EMIT_STATE", state: "streaming-response" },
          ],
        };
      }
      if (event.type === "LLM_DONE") {
        // LLM finished but no sentence was produced yet (very short response)
        return {
          context: { ...ctx, llmActive: false },
          effects: [
            { type: "CANCEL_TIMER", name: "llm" },
            { type: "RELAY_TEXT_DONE", text: event.fullText },
            { type: "APPEND_HISTORY", role: "assistant", content: event.fullText },
          ],
        };
      }
      if (event.type === "LLM_TIMEOUT") {
        return {
          context: { ...ctx, state: "error", llmActive: false },
          effects: [
            { type: "ABORT_TURN" },
            { type: "SEND_ERROR", code: "llm.timeout", message: "Response generation timed out" },
            { type: "EMIT_STATE", state: "error" },
          ],
        };
      }
      if (event.type === "BARGE_IN") {
        return {
          context: { ...ctx, state: "cancelling", llmActive: false },
          effects: [
            { type: "ABORT_TURN" },
            { type: "CANCEL_TIMER", name: "llm" },
            { type: "EMIT_STATE", state: "cancelling" },
          ],
        };
      }
      if (event.type === "ERROR") {
        return {
          context: { ...ctx, state: "error", llmActive: false },
          effects: [
            { type: "ABORT_TURN" },
            { type: "CANCEL_TIMER", name: "llm" },
            { type: "SEND_ERROR", code: "llm.error", message: event.error },
            { type: "EMIT_STATE", state: "error" },
          ],
        };
      }
      break;
    }

    // ─── STREAMING RESPONSE (LLM→TTS overlap) ──────────────
    case "streaming-response": {
      if (event.type === "LLM_TOKEN") {
        return {
          context: ctx,
          effects: [{ type: "RELAY_TEXT_DELTA", token: event.token }],
        };
      }
      if (event.type === "LLM_DONE") {
        return {
          context: { ...ctx, llmActive: false },
          effects: [
            { type: "CANCEL_TIMER", name: "llm" },
            { type: "RELAY_TEXT_DONE", text: event.fullText },
            { type: "APPEND_HISTORY", role: "assistant", content: event.fullText },
          ],
        };
      }
      if (event.type === "SENTENCE_READY") {
        return {
          context: ctx,
          effects: [{ type: "START_TTS", sentence: event.sentence }],
        };
      }
      if (event.type === "TTS_AUDIO") {
        return {
          context: ctx,
          effects: [{ type: "RELAY_AUDIO_FRAME", data: event.data }],
        };
      }
      if (event.type === "TTS_DONE") {
        // One sentence done — more may follow
        return { context: ctx, effects: [] };
      }
      if (event.type === "TURN_COMPLETE") {
        return {
          context: { ...ctx, state: "idle", llmActive: false },
          effects: [
            { type: "RELAY_AUDIO_DONE" },
            { type: "SEND_STATUS", status: "ready" },
            { type: "EMIT_STATE", state: "idle" },
          ],
        };
      }
      if (event.type === "BARGE_IN") {
        return {
          context: { ...ctx, state: "cancelling", llmActive: false },
          effects: [
            { type: "ABORT_TURN" },
            { type: "CANCEL_TIMER", name: "llm" },
            { type: "RELAY_AUDIO_DONE" },
            { type: "EMIT_STATE", state: "cancelling" },
          ],
        };
      }
      if (event.type === "PROVIDER_DROPPED") {
        return {
          context: { ...ctx, state: "error", llmActive: false },
          effects: [
            { type: "ABORT_TURN" },
            { type: "CANCEL_TIMER", name: "llm" },
            { type: "RELAY_AUDIO_DONE" },
            { type: "SEND_ERROR", code: "provider.dropped", message: `${event.provider} disconnected during response` },
            { type: "EMIT_STATE", state: "error" },
          ],
        };
      }
      if (event.type === "ERROR") {
        return {
          context: { ...ctx, state: "error", llmActive: false },
          effects: [
            { type: "ABORT_TURN" },
            { type: "CANCEL_TIMER", name: "llm" },
            { type: "RELAY_AUDIO_DONE" },
            { type: "SEND_ERROR", code: "pipeline.error", message: event.error },
            { type: "EMIT_STATE", state: "error" },
          ],
        };
      }
      break;
    }

    // ─── CANCELLING (barge-in abort) ────────────────────────
    case "cancelling": {
      if (event.type === "CANCEL_COMPLETE") {
        return {
          context: { ...ctx, state: "idle" },
          effects: [
            { type: "FLUSH_STT_QUEUE" },
            { type: "SEND_STATUS", status: "ready" },
            { type: "EMIT_STATE", state: "idle" },
          ],
        };
      }
      if (event.type === "ERROR") {
        // Error during cancel — force to idle anyway
        return {
          context: { ...ctx, state: "idle" },
          effects: [
            { type: "FLUSH_STT_QUEUE" },
            { type: "SEND_STATUS", status: "ready" },
            { type: "EMIT_STATE", state: "idle" },
          ],
        };
      }
      break;
    }

    // ─── RECONNECTING ───────────────────────────────────────
    case "reconnecting": {
      if (event.type === "RECONNECT_SUCCESS") {
        return {
          context: { ...ctx, state: "idle", droppedProvider: null, reconnectAttempts: 0 },
          effects: [
            { type: "CANCEL_TIMER", name: "reconnect" },
            { type: "SEND_STATUS", status: "ready" },
            { type: "EMIT_STATE", state: "idle" },
          ],
        };
      }
      if (event.type === "RECONNECT_FAILED") {
        const attempts = ctx.reconnectAttempts + 1;
        if (attempts < 3) {
          // Retry
          return {
            context: { ...ctx, reconnectAttempts: attempts },
            effects: [
              { type: "RECONNECT_PROVIDER", provider: ctx.droppedProvider! },
            ],
          };
        }
        // Give up
        return {
          context: { ...ctx, state: "error", reconnectAttempts: attempts },
          effects: [
            { type: "CANCEL_TIMER", name: "reconnect" },
            { type: "SEND_ERROR", code: "provider.reconnect_failed", message: event.reason },
            { type: "EMIT_STATE", state: "error" },
          ],
        };
      }
      if (event.type === "RECONNECT_TIMEOUT") {
        return {
          context: { ...ctx, state: "error" },
          effects: [
            { type: "SEND_ERROR", code: "provider.reconnect_timeout", message: "Reconnection timed out" },
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
          context: { ...ctx, state: "idle", droppedProvider: null, reconnectAttempts: 0 },
          effects: [
            { type: "FLUSH_STT_QUEUE" },
            { type: "SEND_STATUS", status: "ready" },
            { type: "EMIT_STATE", state: "idle" },
          ],
        };
      }
      break;
    }

    // ─── CLOSED (terminal) ──────────────────────────────────
    case "closed": {
      // No transitions out of closed
      break;
    }
  }

  // No matching transition — event ignored in this state
  return { context: ctx, effects: [] };
}

// ─── Formal Transition Table ────────────────────────────────────────

export interface TransitionEntry {
  from: PipelineState;
  event: PipelineEvent["type"];
  to: PipelineState;
  effects: string[];
}

export const TRANSITION_TABLE: TransitionEntry[] = [
  // DISCONNECTED
  { from: "disconnected", event: "SESSION_START", to: "connecting", effects: ["CONNECT_PROVIDERS", "SEND_STATUS"] },
  { from: "disconnected", event: "DESTROY", to: "closed", effects: ["CLOSE_SESSION"] },

  // CONNECTING
  { from: "connecting", event: "PROVIDERS_READY", to: "idle", effects: ["SEND_STATUS"] },
  { from: "connecting", event: "PROVIDER_CONNECT_FAILED", to: "error", effects: ["SEND_ERROR"] },
  { from: "connecting", event: "SESSION_END", to: "closed", effects: ["CLOSE_SESSION"] },
  { from: "connecting", event: "DESTROY", to: "closed", effects: ["CLOSE_SESSION"] },

  // IDLE
  { from: "idle", event: "UTTERANCE_START", to: "receiving-audio", effects: ["FLUSH_STT_QUEUE", "INIT_STT_STREAM", "SEND_STATUS"] },
  { from: "idle", event: "PROVIDER_DROPPED", to: "reconnecting", effects: ["RECONNECT_PROVIDER", "START_TIMER", "SEND_STATUS"] },
  { from: "idle", event: "ERROR", to: "error", effects: ["SEND_ERROR"] },
  { from: "idle", event: "SESSION_END", to: "closed", effects: ["CLOSE_SESSION"] },
  { from: "idle", event: "DESTROY", to: "closed", effects: ["CLOSE_SESSION"] },

  // RECEIVING-AUDIO
  { from: "receiving-audio", event: "AUDIO_CHUNK", to: "receiving-audio", effects: ["FORWARD_AUDIO_TO_STT"] },
  { from: "receiving-audio", event: "TRANSCRIPT_PARTIAL", to: "receiving-audio", effects: ["RELAY_PARTIAL_TRANSCRIPT"] },
  { from: "receiving-audio", event: "UTTERANCE_END", to: "finalizing-stt", effects: ["FINALIZE_STT", "SEND_STATUS", "START_TIMER"] },
  { from: "receiving-audio", event: "BARGE_IN", to: "idle", effects: ["ABORT_TURN", "FLUSH_STT_QUEUE", "SEND_STATUS"] },
  { from: "receiving-audio", event: "PROVIDER_DROPPED", to: "error", effects: ["ABORT_TURN", "SEND_ERROR"] },
  { from: "receiving-audio", event: "ERROR", to: "error", effects: ["ABORT_TURN", "SEND_ERROR"] },
  { from: "receiving-audio", event: "SESSION_END", to: "closed", effects: ["CLOSE_SESSION"] },
  { from: "receiving-audio", event: "DESTROY", to: "closed", effects: ["CLOSE_SESSION"] },

  // FINALIZING-STT
  { from: "finalizing-stt", event: "TRANSCRIPT_PARTIAL", to: "finalizing-stt", effects: ["RELAY_PARTIAL_TRANSCRIPT"] },
  { from: "finalizing-stt", event: "TRANSCRIPT_FINAL", to: "running-llm", effects: ["CANCEL_TIMER", "APPEND_HISTORY", "START_LLM_STREAM", "SEND_STATUS", "START_TIMER"] },
  { from: "finalizing-stt", event: "STT_TIMEOUT", to: "error", effects: ["SEND_ERROR"] },
  { from: "finalizing-stt", event: "BARGE_IN", to: "idle", effects: ["ABORT_TURN", "CANCEL_TIMER", "FLUSH_STT_QUEUE", "SEND_STATUS"] },
  { from: "finalizing-stt", event: "ERROR", to: "error", effects: ["CANCEL_TIMER", "SEND_ERROR"] },
  { from: "finalizing-stt", event: "SESSION_END", to: "closed", effects: ["CLOSE_SESSION"] },
  { from: "finalizing-stt", event: "DESTROY", to: "closed", effects: ["CLOSE_SESSION"] },

  // RUNNING-LLM
  { from: "running-llm", event: "LLM_TOKEN", to: "running-llm", effects: ["RELAY_TEXT_DELTA"] },
  { from: "running-llm", event: "SENTENCE_READY", to: "streaming-response", effects: ["START_TTS", "SEND_STATUS"] },
  { from: "running-llm", event: "LLM_DONE", to: "running-llm", effects: ["CANCEL_TIMER", "RELAY_TEXT_DONE", "APPEND_HISTORY"] },
  { from: "running-llm", event: "LLM_TIMEOUT", to: "error", effects: ["ABORT_TURN", "SEND_ERROR"] },
  { from: "running-llm", event: "BARGE_IN", to: "cancelling", effects: ["ABORT_TURN", "CANCEL_TIMER"] },
  { from: "running-llm", event: "ERROR", to: "error", effects: ["ABORT_TURN", "CANCEL_TIMER", "SEND_ERROR"] },
  { from: "running-llm", event: "SESSION_END", to: "closed", effects: ["CLOSE_SESSION"] },
  { from: "running-llm", event: "DESTROY", to: "closed", effects: ["CLOSE_SESSION"] },

  // STREAMING-RESPONSE
  { from: "streaming-response", event: "LLM_TOKEN", to: "streaming-response", effects: ["RELAY_TEXT_DELTA"] },
  { from: "streaming-response", event: "LLM_DONE", to: "streaming-response", effects: ["CANCEL_TIMER", "RELAY_TEXT_DONE", "APPEND_HISTORY"] },
  { from: "streaming-response", event: "SENTENCE_READY", to: "streaming-response", effects: ["START_TTS"] },
  { from: "streaming-response", event: "TTS_AUDIO", to: "streaming-response", effects: ["RELAY_AUDIO_FRAME"] },
  { from: "streaming-response", event: "TTS_DONE", to: "streaming-response", effects: [] },
  { from: "streaming-response", event: "TURN_COMPLETE", to: "idle", effects: ["RELAY_AUDIO_DONE", "SEND_STATUS"] },
  { from: "streaming-response", event: "BARGE_IN", to: "cancelling", effects: ["ABORT_TURN", "CANCEL_TIMER", "RELAY_AUDIO_DONE"] },
  { from: "streaming-response", event: "PROVIDER_DROPPED", to: "error", effects: ["ABORT_TURN", "CANCEL_TIMER", "RELAY_AUDIO_DONE", "SEND_ERROR"] },
  { from: "streaming-response", event: "ERROR", to: "error", effects: ["ABORT_TURN", "CANCEL_TIMER", "RELAY_AUDIO_DONE", "SEND_ERROR"] },
  { from: "streaming-response", event: "SESSION_END", to: "closed", effects: ["CLOSE_SESSION"] },
  { from: "streaming-response", event: "DESTROY", to: "closed", effects: ["CLOSE_SESSION"] },

  // CANCELLING
  { from: "cancelling", event: "CANCEL_COMPLETE", to: "idle", effects: ["FLUSH_STT_QUEUE", "SEND_STATUS"] },
  { from: "cancelling", event: "ERROR", to: "idle", effects: ["FLUSH_STT_QUEUE", "SEND_STATUS"] },
  { from: "cancelling", event: "SESSION_END", to: "closed", effects: ["CLOSE_SESSION"] },
  { from: "cancelling", event: "DESTROY", to: "closed", effects: ["CLOSE_SESSION"] },

  // RECONNECTING
  { from: "reconnecting", event: "RECONNECT_SUCCESS", to: "idle", effects: ["CANCEL_TIMER", "SEND_STATUS"] },
  { from: "reconnecting", event: "RECONNECT_FAILED", to: "reconnecting", effects: ["RECONNECT_PROVIDER"] }, // retry case (attempts < 3)
  { from: "reconnecting", event: "RECONNECT_TIMEOUT", to: "error", effects: ["SEND_ERROR"] },
  { from: "reconnecting", event: "SESSION_END", to: "closed", effects: ["CLOSE_SESSION"] },
  { from: "reconnecting", event: "DESTROY", to: "closed", effects: ["CLOSE_SESSION"] },

  // ERROR
  { from: "error", event: "RECOVER", to: "idle", effects: ["FLUSH_STT_QUEUE", "SEND_STATUS"] },
  { from: "error", event: "SESSION_END", to: "closed", effects: ["CLOSE_SESSION"] },
  { from: "error", event: "DESTROY", to: "closed", effects: ["CLOSE_SESSION"] },
];

// ─── All states and events (for exhaustiveness checks) ────────────────

export const ALL_STATES: PipelineState[] = [
  "disconnected", "connecting", "idle", "receiving-audio",
  "finalizing-stt", "running-llm", "streaming-response",
  "cancelling", "reconnecting", "error", "closed",
];

export const ALL_EVENT_TYPES: PipelineEvent["type"][] = [
  "SESSION_START", "PROVIDERS_READY", "PROVIDER_CONNECT_FAILED",
  "UTTERANCE_START", "AUDIO_CHUNK", "UTTERANCE_END",
  "TRANSCRIPT_PARTIAL", "TRANSCRIPT_FINAL", "STT_TIMEOUT",
  "LLM_TOKEN", "LLM_DONE", "LLM_TIMEOUT",
  "SENTENCE_READY", "TTS_AUDIO", "TTS_DONE", "TURN_COMPLETE",
  "BARGE_IN", "CANCEL_COMPLETE",
  "PROVIDER_DROPPED", "RECONNECT_SUCCESS", "RECONNECT_FAILED", "RECONNECT_TIMEOUT",
  "ERROR", "RECOVER", "SESSION_END", "DESTROY",
];

/** States that have a timeout guard (waiting states that must not hang) */
export const TIMEOUT_GUARDED_STATES: Record<string, { timer: string; event: PipelineEvent["type"] }> = {
  "finalizing-stt": { timer: "stt", event: "STT_TIMEOUT" },
  "running-llm": { timer: "llm", event: "LLM_TIMEOUT" },
  "reconnecting": { timer: "reconnect", event: "RECONNECT_TIMEOUT" },
};
