/**
 * Codec Negotiation State Machine — Formal Transition Table
 *
 * Models the complete lifecycle of audio codec negotiation between
 * SDK client and gateway, covering: connection, negotiation handshake,
 * active streaming with codec, renegotiation, and error/teardown.
 *
 * Pure function: (state, event) → { state, effects[] }
 * No side effects, no I/O. Effects are descriptors the caller interprets.
 */

// ─── Types ───────────────────────────────────────────────────────────

export type Encoding = "pcm16" | "opus";

export interface AudioCapabilities {
  supportedEncodings: Encoding[];
  preferredEncoding: Encoding;
  captureSampleRate: number;
  playbackSampleRate: number;
}

export interface NegotiatedFormat {
  encoding: Encoding;
  captureSampleRate: number;
  playbackSampleRate: number;
}

// ─── States ───────────────────────────────────────────────────────────

export type CodecState =
  | "disconnected"       // No WS connection, initial state
  | "connected"          // WS open, no session.start sent yet
  | "negotiating"        // session.start sent, awaiting session.ready
  | "ready"              // Negotiation complete, codec selected, can encode/decode
  | "streaming"          // Actively sending/receiving audio with negotiated codec
  | "renegotiating"      // Mid-session renegotiation (e.g., codec switch request)
  | "error"              // Negotiation failed or codec error — recoverable
  | "closed";            // Terminal — session ended

// ─── Events ───────────────────────────────────────────────────────────

export type CodecEvent =
  | { type: "WS_OPEN" }                                         // WebSocket connected
  | { type: "SEND_CAPABILITIES"; caps: AudioCapabilities }       // SDK sends session.start
  | { type: "SESSION_READY"; format: NegotiatedFormat }          // Gateway confirms format
  | { type: "SESSION_REJECTED"; reason: string }                 // Gateway rejects all encodings
  | { type: "AUDIO_START" }                                      // Audio streaming begins
  | { type: "AUDIO_STOP" }                                       // Audio streaming pauses (between utterances)
  | { type: "RENEGOTIATE"; caps: AudioCapabilities }             // Request codec change mid-session
  | { type: "CODEC_ERROR"; error: string }                       // Encode/decode failure at runtime
  | { type: "NEGOTIATION_TIMEOUT" }                              // Gateway didn't respond in time
  | { type: "WS_CLOSE" }                                         // WebSocket closed
  | { type: "RECOVER" }                                          // Retry after error
  | { type: "CLOSE" };                                           // Explicit session teardown

// ─── Effects ──────────────────────────────────────────────────────────

export type CodecEffect =
  | { type: "SEND_SESSION_START"; caps: AudioCapabilities }
  | { type: "APPLY_CODEC"; format: NegotiatedFormat }
  | { type: "RELEASE_CODEC" }
  | { type: "START_TIMER"; name: string; durationMs: number }
  | { type: "CANCEL_TIMER"; name: string }
  | { type: "EMIT_STATE"; state: CodecState }
  | { type: "EMIT_ERROR"; error: string }
  | { type: "EMIT_FORMAT"; format: NegotiatedFormat }
  | { type: "NOTIFY_AUDIO_READY" }
  | { type: "NOTIFY_AUDIO_SUSPENDED" };

// ─── Context ──────────────────────────────────────────────────────────

export interface CodecContext {
  state: CodecState;
  format: NegotiatedFormat | null;
  lastCaps: AudioCapabilities | null;
  /** Number of consecutive negotiation failures (for backoff) */
  failCount: number;
}

export interface TransitionResult {
  context: CodecContext;
  effects: CodecEffect[];
}

// ─── Constants ────────────────────────────────────────────────────────

const NEGOTIATION_TIMEOUT_MS = 5_000;
const RENEGOTIATION_TIMEOUT_MS = 3_000;

// ─── Initial Context ──────────────────────────────────────────────────

export function initialContext(): CodecContext {
  return {
    state: "disconnected",
    format: null,
    lastCaps: null,
    failCount: 0,
  };
}

// ─── Transition Function ──────────────────────────────────────────────

export function transition(ctx: CodecContext, event: CodecEvent): TransitionResult {
  const { state } = ctx;

  // CLOSE is valid from any non-terminal state
  if (event.type === "CLOSE" && state !== "closed") {
    return {
      context: { ...ctx, state: "closed", format: null },
      effects: [
        { type: "CANCEL_TIMER", name: "negotiation" },
        { type: "CANCEL_TIMER", name: "renegotiation" },
        { type: "RELEASE_CODEC" },
        { type: "EMIT_STATE", state: "closed" },
      ],
    };
  }

  // WS_CLOSE is valid from any connected state → disconnected
  if (event.type === "WS_CLOSE" && state !== "disconnected" && state !== "closed") {
    return {
      context: { ...ctx, state: "disconnected", format: null },
      effects: [
        { type: "CANCEL_TIMER", name: "negotiation" },
        { type: "CANCEL_TIMER", name: "renegotiation" },
        { type: "RELEASE_CODEC" },
        { type: "EMIT_STATE", state: "disconnected" },
      ],
    };
  }

  switch (state) {
    // ─── DISCONNECTED ───────────────────────────────────────
    case "disconnected": {
      if (event.type === "WS_OPEN") {
        return {
          context: { ...ctx, state: "connected", failCount: 0 },
          effects: [{ type: "EMIT_STATE", state: "connected" }],
        };
      }
      break;
    }

    // ─── CONNECTED (WS open, awaiting capabilities) ─────────
    case "connected": {
      if (event.type === "SEND_CAPABILITIES") {
        return {
          context: { ...ctx, state: "negotiating", lastCaps: event.caps },
          effects: [
            { type: "SEND_SESSION_START", caps: event.caps },
            { type: "START_TIMER", name: "negotiation", durationMs: NEGOTIATION_TIMEOUT_MS },
            { type: "EMIT_STATE", state: "negotiating" },
          ],
        };
      }
      break;
    }

    // ─── NEGOTIATING (waiting for session.ready) ─────────────
    case "negotiating": {
      if (event.type === "SESSION_READY") {
        return {
          context: { ...ctx, state: "ready", format: event.format, failCount: 0 },
          effects: [
            { type: "CANCEL_TIMER", name: "negotiation" },
            { type: "APPLY_CODEC", format: event.format },
            { type: "EMIT_FORMAT", format: event.format },
            { type: "EMIT_STATE", state: "ready" },
          ],
        };
      }
      if (event.type === "SESSION_REJECTED") {
        return {
          context: { ...ctx, state: "error", failCount: ctx.failCount + 1 },
          effects: [
            { type: "CANCEL_TIMER", name: "negotiation" },
            { type: "EMIT_ERROR", error: event.reason },
            { type: "EMIT_STATE", state: "error" },
          ],
        };
      }
      if (event.type === "NEGOTIATION_TIMEOUT") {
        return {
          context: { ...ctx, state: "error", failCount: ctx.failCount + 1 },
          effects: [
            { type: "EMIT_ERROR", error: "Codec negotiation timed out" },
            { type: "EMIT_STATE", state: "error" },
          ],
        };
      }
      break;
    }

    // ─── READY (codec applied, can stream) ───────────────────
    case "ready": {
      if (event.type === "AUDIO_START") {
        return {
          context: { ...ctx, state: "streaming" },
          effects: [
            { type: "NOTIFY_AUDIO_READY" },
            { type: "EMIT_STATE", state: "streaming" },
          ],
        };
      }
      if (event.type === "RENEGOTIATE") {
        return {
          context: { ...ctx, state: "renegotiating", lastCaps: event.caps },
          effects: [
            { type: "SEND_SESSION_START", caps: event.caps },
            { type: "START_TIMER", name: "renegotiation", durationMs: RENEGOTIATION_TIMEOUT_MS },
            { type: "EMIT_STATE", state: "renegotiating" },
          ],
        };
      }
      if (event.type === "CODEC_ERROR") {
        return {
          context: { ...ctx, state: "error" },
          effects: [
            { type: "RELEASE_CODEC" },
            { type: "EMIT_ERROR", error: event.error },
            { type: "EMIT_STATE", state: "error" },
          ],
        };
      }
      break;
    }

    // ─── STREAMING (actively sending/receiving audio) ────────
    case "streaming": {
      if (event.type === "AUDIO_STOP") {
        return {
          context: { ...ctx, state: "ready" },
          effects: [
            { type: "NOTIFY_AUDIO_SUSPENDED" },
            { type: "EMIT_STATE", state: "ready" },
          ],
        };
      }
      if (event.type === "RENEGOTIATE") {
        // Must stop audio first, then renegotiate
        return {
          context: { ...ctx, state: "renegotiating", lastCaps: event.caps },
          effects: [
            { type: "NOTIFY_AUDIO_SUSPENDED" },
            { type: "SEND_SESSION_START", caps: event.caps },
            { type: "START_TIMER", name: "renegotiation", durationMs: RENEGOTIATION_TIMEOUT_MS },
            { type: "EMIT_STATE", state: "renegotiating" },
          ],
        };
      }
      if (event.type === "CODEC_ERROR") {
        return {
          context: { ...ctx, state: "error" },
          effects: [
            { type: "NOTIFY_AUDIO_SUSPENDED" },
            { type: "RELEASE_CODEC" },
            { type: "EMIT_ERROR", error: event.error },
            { type: "EMIT_STATE", state: "error" },
          ],
        };
      }
      break;
    }

    // ─── RENEGOTIATING (mid-session codec change) ────────────
    case "renegotiating": {
      if (event.type === "SESSION_READY") {
        return {
          context: { ...ctx, state: "ready", format: event.format, failCount: 0 },
          effects: [
            { type: "CANCEL_TIMER", name: "renegotiation" },
            { type: "RELEASE_CODEC" },
            { type: "APPLY_CODEC", format: event.format },
            { type: "EMIT_FORMAT", format: event.format },
            { type: "EMIT_STATE", state: "ready" },
          ],
        };
      }
      if (event.type === "SESSION_REJECTED") {
        // Renegotiation failed — fall back to previous format (still in ready state)
        return {
          context: { ...ctx, state: ctx.format ? "ready" : "error", failCount: ctx.failCount + 1 },
          effects: [
            { type: "CANCEL_TIMER", name: "renegotiation" },
            { type: "EMIT_ERROR", error: `Renegotiation failed: ${event.reason}` },
            { type: "EMIT_STATE", state: ctx.format ? "ready" : "error" },
          ],
        };
      }
      if (event.type === "NEGOTIATION_TIMEOUT") {
        // Timeout during renegotiation — fall back to previous format if available
        return {
          context: { ...ctx, state: ctx.format ? "ready" : "error", failCount: ctx.failCount + 1 },
          effects: [
            { type: "EMIT_ERROR", error: "Renegotiation timed out, keeping current format" },
            { type: "EMIT_STATE", state: ctx.format ? "ready" : "error" },
          ],
        };
      }
      break;
    }

    // ─── ERROR ──────────────────────────────────────────────
    case "error": {
      if (event.type === "RECOVER") {
        // If we still have a WS connection, go back to connected to re-negotiate
        // Caller decides if WS is still open
        return {
          context: { ...ctx, state: "connected" },
          effects: [{ type: "EMIT_STATE", state: "connected" }],
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

// ─── Formal Transition Table ──────────────────────────────────────────

export interface TransitionEntry {
  from: CodecState;
  event: CodecEvent["type"];
  to: CodecState;
  effects: string[];
  note?: string;
}

export const TRANSITION_TABLE: TransitionEntry[] = [
  // DISCONNECTED
  { from: "disconnected", event: "WS_OPEN", to: "connected", effects: ["EMIT_STATE"] },
  { from: "disconnected", event: "CLOSE", to: "closed", effects: ["RELEASE_CODEC", "EMIT_STATE"] },

  // CONNECTED
  { from: "connected", event: "SEND_CAPABILITIES", to: "negotiating", effects: ["SEND_SESSION_START", "START_TIMER", "EMIT_STATE"] },
  { from: "connected", event: "WS_CLOSE", to: "disconnected", effects: ["RELEASE_CODEC", "EMIT_STATE"] },
  { from: "connected", event: "CLOSE", to: "closed", effects: ["RELEASE_CODEC", "EMIT_STATE"] },

  // NEGOTIATING
  { from: "negotiating", event: "SESSION_READY", to: "ready", effects: ["CANCEL_TIMER", "APPLY_CODEC", "EMIT_FORMAT", "EMIT_STATE"] },
  { from: "negotiating", event: "SESSION_REJECTED", to: "error", effects: ["CANCEL_TIMER", "EMIT_ERROR", "EMIT_STATE"] },
  { from: "negotiating", event: "NEGOTIATION_TIMEOUT", to: "error", effects: ["EMIT_ERROR", "EMIT_STATE"] },
  { from: "negotiating", event: "WS_CLOSE", to: "disconnected", effects: ["CANCEL_TIMER", "RELEASE_CODEC", "EMIT_STATE"] },
  { from: "negotiating", event: "CLOSE", to: "closed", effects: ["CANCEL_TIMER", "RELEASE_CODEC", "EMIT_STATE"] },

  // READY
  { from: "ready", event: "AUDIO_START", to: "streaming", effects: ["NOTIFY_AUDIO_READY", "EMIT_STATE"] },
  { from: "ready", event: "RENEGOTIATE", to: "renegotiating", effects: ["SEND_SESSION_START", "START_TIMER", "EMIT_STATE"] },
  { from: "ready", event: "CODEC_ERROR", to: "error", effects: ["RELEASE_CODEC", "EMIT_ERROR", "EMIT_STATE"] },
  { from: "ready", event: "WS_CLOSE", to: "disconnected", effects: ["RELEASE_CODEC", "EMIT_STATE"] },
  { from: "ready", event: "CLOSE", to: "closed", effects: ["RELEASE_CODEC", "EMIT_STATE"] },

  // STREAMING
  { from: "streaming", event: "AUDIO_STOP", to: "ready", effects: ["NOTIFY_AUDIO_SUSPENDED", "EMIT_STATE"] },
  { from: "streaming", event: "RENEGOTIATE", to: "renegotiating", effects: ["NOTIFY_AUDIO_SUSPENDED", "SEND_SESSION_START", "START_TIMER", "EMIT_STATE"] },
  { from: "streaming", event: "CODEC_ERROR", to: "error", effects: ["NOTIFY_AUDIO_SUSPENDED", "RELEASE_CODEC", "EMIT_ERROR", "EMIT_STATE"] },
  { from: "streaming", event: "WS_CLOSE", to: "disconnected", effects: ["RELEASE_CODEC", "EMIT_STATE"] },
  { from: "streaming", event: "CLOSE", to: "closed", effects: ["RELEASE_CODEC", "EMIT_STATE"] },

  // RENEGOTIATING
  { from: "renegotiating", event: "SESSION_READY", to: "ready", effects: ["CANCEL_TIMER", "RELEASE_CODEC", "APPLY_CODEC", "EMIT_FORMAT", "EMIT_STATE"] },
  { from: "renegotiating", event: "SESSION_REJECTED", to: "ready", effects: ["CANCEL_TIMER", "EMIT_ERROR", "EMIT_STATE"], note: "Falls back to previous format if available" },
  { from: "renegotiating", event: "NEGOTIATION_TIMEOUT", to: "ready", effects: ["EMIT_ERROR", "EMIT_STATE"], note: "Falls back to previous format if available" },
  { from: "renegotiating", event: "WS_CLOSE", to: "disconnected", effects: ["CANCEL_TIMER", "RELEASE_CODEC", "EMIT_STATE"] },
  { from: "renegotiating", event: "CLOSE", to: "closed", effects: ["CANCEL_TIMER", "RELEASE_CODEC", "EMIT_STATE"] },

  // ERROR
  { from: "error", event: "RECOVER", to: "connected", effects: ["EMIT_STATE"] },
  { from: "error", event: "WS_CLOSE", to: "disconnected", effects: ["RELEASE_CODEC", "EMIT_STATE"] },
  { from: "error", event: "CLOSE", to: "closed", effects: ["RELEASE_CODEC", "EMIT_STATE"] },
];

// ─── All states and events (for exhaustiveness checks) ────────────────

export const ALL_STATES: CodecState[] = [
  "disconnected", "connected", "negotiating", "ready",
  "streaming", "renegotiating", "error", "closed",
];

export const ALL_EVENT_TYPES: CodecEvent["type"][] = [
  "WS_OPEN", "SEND_CAPABILITIES", "SESSION_READY", "SESSION_REJECTED",
  "AUDIO_START", "AUDIO_STOP", "RENEGOTIATE", "CODEC_ERROR",
  "NEGOTIATION_TIMEOUT", "WS_CLOSE", "RECOVER", "CLOSE",
];

/** States that have a timeout guard (waiting states that must not hang) */
export const TIMEOUT_GUARDED_STATES: Record<string, { timer: string; event: CodecEvent["type"] }> = {
  "negotiating": { timer: "negotiation", event: "NEGOTIATION_TIMEOUT" },
  "renegotiating": { timer: "renegotiation", event: "NEGOTIATION_TIMEOUT" },
};
