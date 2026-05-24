// SDK-Gateway Contract State Machine
// Models the session lifecycle from the contract perspective:
// connect → auth → configure → streaming (utterances + responses) → ended

// ─── States ───

export type ContractState =
  | "disconnected"      // No WS connection
  | "connecting"        // WS handshake in progress
  | "authenticating"    // WS open, awaiting auth.ok
  | "configuring"       // Auth'd, awaiting session.ready
  | "idle"              // Session ready, no active utterance or response
  | "streaming_audio"   // Client sending utterance audio
  | "awaiting_transcript" // utterance.end sent, waiting for transcript.final
  | "processing"        // transcript.final received, waiting for response.start
  | "responding"        // Response streaming (text + audio)
  | "error"             // Recoverable error state
  | "ended"             // Session terminated cleanly

// ─── Events ───

export type ContractEvent =
  // Connection lifecycle
  | { type: "ws_open" }
  | { type: "ws_close"; code: number }
  | { type: "ws_error" }

  // Auth
  | { type: "auth_ok"; sessionId: string }
  | { type: "auth_failed" }

  // Session config
  | { type: "session_ready" }
  | { type: "unsupported_config" }

  // Utterance lifecycle (client-driven)
  | { type: "utterance_start"; utteranceId: string }
  | { type: "utterance_end"; utteranceId: string }

  // Transcript (server-driven)
  | { type: "transcript_partial"; utteranceId: string }
  | { type: "transcript_final"; utteranceId: string }

  // Response (server-driven)
  | { type: "response_start"; responseId: string }
  | { type: "response_text_delta"; responseId: string }
  | { type: "response_audio_start"; responseId: string }
  | { type: "response_audio_done"; responseId: string }
  | { type: "response_text_done"; responseId: string }
  | { type: "response_done"; responseId: string }

  // Barge-in
  | { type: "barge_in"; responseId: string }
  | { type: "barge_in_ack"; responseId: string }

  // Errors
  | { type: "error_recoverable"; code: string }
  | { type: "error_fatal"; code: string }

  // Session end
  | { type: "session_end_request" }
  | { type: "session_ended" }

  // Timeouts
  | { type: "timeout"; context: string }

  // Keepalive
  | { type: "ping" }
  | { type: "pong" }

// ─── Context ───

export interface ContractContext {
  sessionId: string | null;
  activeUtteranceId: string | null;
  activeResponseId: string | null;
  lastError: { code: string; recoverable: boolean } | null;
  stateEnteredAt: number;
}

// ─── Transition Result ───

export interface TransitionResult {
  state: ContractState;
  context: ContractContext;
  effects: ContractEffect[];
}

export type ContractEffect =
  | { type: "send"; message: string }
  | { type: "start_timer"; name: string; ms: number }
  | { type: "cancel_timer"; name: string }
  | { type: "emit_status"; status: string }
  | { type: "close_connection"; code: number }
  | { type: "log_warning"; message: string }

// ─── Timeout Constants ───

const TIMEOUTS = {
  AUTH: 5_000,
  CONFIG: 5_000,
  TRANSCRIPT: 10_000,
  PROCESSING: 30_000,
  RESPONSE: 60_000,
  KEEPALIVE: 30_000,
} as const;

// ─── Initial State ───

export function createInitialContext(): ContractContext {
  return {
    sessionId: null,
    activeUtteranceId: null,
    activeResponseId: null,
    lastError: null,
    stateEnteredAt: Date.now(),
  };
}

// ─── Pure Transition Function ───

export function transition(
  state: ContractState,
  event: ContractEvent,
  ctx: ContractContext,
  now: number = Date.now()
): TransitionResult {
  const unchanged = { state, context: ctx, effects: [] };
  const go = (
    nextState: ContractState,
    ctxPatch: Partial<ContractContext>,
    effects: ContractEffect[] = []
  ): TransitionResult => ({
    state: nextState,
    context: { ...ctx, ...ctxPatch, stateEnteredAt: now },
    effects,
  });

  switch (state) {
    // ─── DISCONNECTED ───
    case "disconnected": {
      if (event.type === "ws_open") {
        return go("connecting", {}, [
          { type: "emit_status", status: "Connecting..." },
        ]);
      }
      return unchanged;
    }

    // ─── CONNECTING ───
    // "connecting" = WS handshake in progress. Any event means WS is alive → send auth.
    case "connecting": {
      if (event.type === "ws_close" || event.type === "ws_error") {
        return go("disconnected", { sessionId: null }, [
          { type: "emit_status", status: "Disconnected" },
        ]);
      }
      // WS opened successfully → send auth
      return go("authenticating", {}, [
        { type: "send", message: "auth" },
        { type: "start_timer", name: "auth", ms: TIMEOUTS.AUTH },
        { type: "emit_status", status: "Authenticating..." },
      ]);
    }

    // ─── AUTHENTICATING ───
    case "authenticating": {
      switch (event.type) {
        case "auth_ok":
          return go(
            "configuring",
            { sessionId: event.sessionId },
            [
              { type: "cancel_timer", name: "auth" },
              { type: "send", message: "session.configure" },
              { type: "start_timer", name: "config", ms: TIMEOUTS.CONFIG },
              { type: "emit_status", status: "Configuring..." },
            ]
          );
        case "auth_failed":
          return go(
            "error",
            { lastError: { code: "auth_failed", recoverable: false } },
            [
              { type: "cancel_timer", name: "auth" },
              { type: "emit_status", status: "Authentication failed" },
            ]
          );
        case "timeout":
          return go(
            "error",
            { lastError: { code: "auth_timeout", recoverable: true } },
            [
              { type: "emit_status", status: "Connection timed out" },
            ]
          );
        case "ws_close":
        case "ws_error":
          return go("disconnected", { sessionId: null }, [
            { type: "cancel_timer", name: "auth" },
            { type: "emit_status", status: "Disconnected" },
          ]);
        default:
          return unchanged;
      }
    }

    // ─── CONFIGURING ───
    case "configuring": {
      switch (event.type) {
        case "session_ready":
          return go("idle", {}, [
            { type: "cancel_timer", name: "config" },
            { type: "start_timer", name: "keepalive", ms: TIMEOUTS.KEEPALIVE },
            { type: "emit_status", status: "Listening..." },
          ]);
        case "unsupported_config":
          return go(
            "error",
            { lastError: { code: "unsupported_config", recoverable: false } },
            [
              { type: "cancel_timer", name: "config" },
              { type: "emit_status", status: "Unsupported configuration" },
            ]
          );
        case "timeout":
          return go(
            "error",
            { lastError: { code: "config_timeout", recoverable: true } },
            [
              { type: "emit_status", status: "Configuration timed out" },
            ]
          );
        case "ws_close":
        case "ws_error":
          return go("disconnected", { sessionId: null }, [
            { type: "cancel_timer", name: "config" },
            { type: "emit_status", status: "Disconnected" },
          ]);
        default:
          return unchanged;
      }
    }

    // ─── IDLE ───
    case "idle": {
      switch (event.type) {
        case "utterance_start":
          return go(
            "streaming_audio",
            { activeUtteranceId: event.utteranceId },
            [
              { type: "send", message: `utterance.start:${event.utteranceId}` },
              { type: "emit_status", status: "Listening..." },
            ]
          );
        case "ping":
          return {
            state,
            context: ctx,
            effects: [
              { type: "send", message: "ping" },
              { type: "start_timer", name: "keepalive", ms: TIMEOUTS.KEEPALIVE },
            ],
          };
        case "pong":
          return unchanged;
        case "session_end_request":
          return go("ended", { sessionId: null }, [
            { type: "cancel_timer", name: "keepalive" },
            { type: "send", message: "session.end" },
            { type: "emit_status", status: "Session ended" },
          ]);
        case "session_ended":
          return go("ended", { sessionId: null }, [
            { type: "cancel_timer", name: "keepalive" },
            { type: "emit_status", status: "Session ended" },
          ]);
        case "error_recoverable":
          return go(
            "error",
            { lastError: { code: event.code, recoverable: true } },
            [{ type: "emit_status", status: "Something went wrong" }]
          );
        case "error_fatal":
          return go(
            "error",
            { lastError: { code: event.code, recoverable: false } },
            [{ type: "emit_status", status: "Session error" }]
          );
        case "ws_close":
        case "ws_error":
          return go("disconnected", { sessionId: null }, [
            { type: "cancel_timer", name: "keepalive" },
            { type: "emit_status", status: "Disconnected" },
          ]);
        case "timeout":
          if (event.context === "keepalive") {
            return go("disconnected", { sessionId: null }, [
              { type: "close_connection", code: 1001 },
              { type: "emit_status", status: "Connection lost" },
            ]);
          }
          return unchanged;
        default:
          return unchanged;
      }
    }

    // ─── STREAMING AUDIO ───
    case "streaming_audio": {
      switch (event.type) {
        case "utterance_end":
          if (event.utteranceId !== ctx.activeUtteranceId) {
            return {
              state,
              context: ctx,
              effects: [
                {
                  type: "log_warning",
                  message: `utterance_end ID mismatch: ${event.utteranceId} vs ${ctx.activeUtteranceId}`,
                },
              ],
            };
          }
          return go("awaiting_transcript", {}, [
            { type: "send", message: `utterance.end:${event.utteranceId}` },
            { type: "start_timer", name: "transcript", ms: TIMEOUTS.TRANSCRIPT },
            { type: "emit_status", status: "Processing..." },
          ]);
        case "transcript_partial":
          // Partial transcripts can arrive while still streaming
          return unchanged;
        case "ws_close":
        case "ws_error":
          return go(
            "disconnected",
            { sessionId: null, activeUtteranceId: null },
            [{ type: "emit_status", status: "Disconnected" }]
          );
        case "error_recoverable":
          return go(
            "error",
            {
              activeUtteranceId: null,
              lastError: { code: event.code, recoverable: true },
            },
            [{ type: "emit_status", status: "I didn't catch that" }]
          );
        default:
          return unchanged;
      }
    }

    // ─── AWAITING TRANSCRIPT ───
    case "awaiting_transcript": {
      switch (event.type) {
        case "transcript_partial":
          return unchanged; // display partial, but don't transition
        case "transcript_final":
          return go("processing", {}, [
            { type: "cancel_timer", name: "transcript" },
            { type: "start_timer", name: "processing", ms: TIMEOUTS.PROCESSING },
            { type: "emit_status", status: "Thinking..." },
          ]);
        case "timeout":
          return go(
            "error",
            {
              activeUtteranceId: null,
              lastError: { code: "transcript_timeout", recoverable: true },
            },
            [
              { type: "emit_status", status: "I didn't catch that, could you repeat?" },
            ]
          );
        case "ws_close":
        case "ws_error":
          return go(
            "disconnected",
            { sessionId: null, activeUtteranceId: null },
            [
              { type: "cancel_timer", name: "transcript" },
              { type: "emit_status", status: "Disconnected" },
            ]
          );
        default:
          return unchanged;
      }
    }

    // ─── PROCESSING ───
    case "processing": {
      switch (event.type) {
        case "response_start":
          return go(
            "responding",
            { activeResponseId: event.responseId },
            [
              { type: "cancel_timer", name: "processing" },
              { type: "start_timer", name: "response", ms: TIMEOUTS.RESPONSE },
              { type: "emit_status", status: "Speaking..." },
            ]
          );
        case "utterance_start":
          // Barge-in during processing (before response starts)
          return go(
            "streaming_audio",
            {
              activeUtteranceId: event.utteranceId,
              activeResponseId: null,
            },
            [
              { type: "cancel_timer", name: "processing" },
              { type: "send", message: `utterance.start:${event.utteranceId}` },
              { type: "emit_status", status: "Listening..." },
            ]
          );
        case "timeout":
          return go(
            "error",
            {
              activeUtteranceId: null,
              lastError: { code: "processing_timeout", recoverable: true },
            },
            [
              { type: "emit_status", status: "Sorry, that took too long" },
            ]
          );
        case "error_recoverable":
          return go(
            "error",
            {
              activeUtteranceId: null,
              lastError: { code: event.code, recoverable: true },
            },
            [{ type: "emit_status", status: "Something went wrong" }]
          );
        case "ws_close":
        case "ws_error":
          return go(
            "disconnected",
            { sessionId: null, activeUtteranceId: null },
            [
              { type: "cancel_timer", name: "processing" },
              { type: "emit_status", status: "Disconnected" },
            ]
          );
        default:
          return unchanged;
      }
    }

    // ─── RESPONDING ───
    case "responding": {
      switch (event.type) {
        case "response_text_delta":
        case "response_audio_start":
        case "response_audio_done":
        case "response_text_done":
          return unchanged; // Sub-events within the response, don't change top-level state
        case "response_done":
          return go(
            "idle",
            { activeUtteranceId: null, activeResponseId: null },
            [
              { type: "cancel_timer", name: "response" },
              { type: "start_timer", name: "keepalive", ms: TIMEOUTS.KEEPALIVE },
              { type: "emit_status", status: "Listening..." },
            ]
          );
        case "barge_in":
          // Client initiates barge-in
          return {
            state: "responding", // Stay in responding until ack
            context: ctx,
            effects: [
              { type: "send", message: `barge_in:${event.responseId}` },
            ],
          };
        case "barge_in_ack":
          return go(
            "idle",
            { activeUtteranceId: null, activeResponseId: null },
            [
              { type: "cancel_timer", name: "response" },
              { type: "start_timer", name: "keepalive", ms: TIMEOUTS.KEEPALIVE },
              { type: "emit_status", status: "Listening..." },
            ]
          );
        case "utterance_start":
          // Immediate barge-in: user starts speaking → send barge_in + start new utterance
          return go(
            "streaming_audio",
            {
              activeUtteranceId: event.utteranceId,
              activeResponseId: null,
            },
            [
              { type: "cancel_timer", name: "response" },
              {
                type: "send",
                message: `barge_in:${ctx.activeResponseId}`,
              },
              { type: "send", message: `utterance.start:${event.utteranceId}` },
              { type: "emit_status", status: "Listening..." },
            ]
          );
        case "timeout":
          return go(
            "error",
            {
              activeResponseId: null,
              lastError: { code: "response_timeout", recoverable: true },
            },
            [
              { type: "emit_status", status: "Response timed out" },
            ]
          );
        case "ws_close":
        case "ws_error":
          return go(
            "disconnected",
            {
              sessionId: null,
              activeUtteranceId: null,
              activeResponseId: null,
            },
            [
              { type: "cancel_timer", name: "response" },
              { type: "emit_status", status: "Disconnected" },
            ]
          );
        default:
          return unchanged;
      }
    }

    // ─── ERROR ───
    case "error": {
      switch (event.type) {
        case "utterance_start":
          // Auto-recover: user starts speaking again
          if (ctx.lastError?.recoverable) {
            return go(
              "streaming_audio",
              {
                activeUtteranceId: event.utteranceId,
                activeResponseId: null,
                lastError: null,
              },
              [
                { type: "send", message: `utterance.start:${event.utteranceId}` },
                { type: "emit_status", status: "Listening..." },
              ]
            );
          }
          return unchanged;
        case "session_end_request":
          return go("ended", { sessionId: null }, [
            { type: "send", message: "session.end" },
            { type: "emit_status", status: "Session ended" },
          ]);
        case "ws_close":
        case "ws_error":
          return go("disconnected", { sessionId: null }, [
            { type: "emit_status", status: "Disconnected" },
          ]);
        case "ws_open":
          // Reconnect attempt
          return go("connecting", { lastError: null }, [
            { type: "emit_status", status: "Reconnecting..." },
          ]);
        default:
          return unchanged;
      }
    }

    // ─── ENDED ───
    case "ended": {
      if (event.type === "ws_open") {
        // New session
        return go("connecting", createInitialContext(), [
          { type: "emit_status", status: "Connecting..." },
        ]);
      }
      return unchanged;
    }

    default:
      return unchanged;
  }
}

// ─── Transition Table (for documentation / test generation) ───

export interface TransitionEntry {
  from: ContractState;
  event: ContractEvent["type"];
  to: ContractState;
  hasTimeout: boolean;
  userFeedback: string;
}

export const TRANSITION_TABLE: TransitionEntry[] = [
  // Connection
  { from: "disconnected", event: "ws_open", to: "connecting", hasTimeout: false, userFeedback: "Connecting..." },
  { from: "connecting", event: "ws_open", to: "authenticating", hasTimeout: true, userFeedback: "Authenticating..." },

  // Auth
  { from: "authenticating", event: "auth_ok", to: "configuring", hasTimeout: true, userFeedback: "Configuring..." },
  { from: "authenticating", event: "auth_failed", to: "error", hasTimeout: false, userFeedback: "Authentication failed" },
  { from: "authenticating", event: "timeout", to: "error", hasTimeout: false, userFeedback: "Connection timed out" },

  // Config
  { from: "configuring", event: "session_ready", to: "idle", hasTimeout: false, userFeedback: "Listening..." },
  { from: "configuring", event: "unsupported_config", to: "error", hasTimeout: false, userFeedback: "Unsupported configuration" },
  { from: "configuring", event: "timeout", to: "error", hasTimeout: false, userFeedback: "Configuration timed out" },

  // Idle → Utterance
  { from: "idle", event: "utterance_start", to: "streaming_audio", hasTimeout: false, userFeedback: "Listening..." },
  { from: "idle", event: "session_end_request", to: "ended", hasTimeout: false, userFeedback: "Session ended" },
  { from: "idle", event: "session_ended", to: "ended", hasTimeout: false, userFeedback: "Session ended" },

  // Streaming
  { from: "streaming_audio", event: "utterance_end", to: "awaiting_transcript", hasTimeout: true, userFeedback: "Processing..." },

  // Transcript
  { from: "awaiting_transcript", event: "transcript_final", to: "processing", hasTimeout: true, userFeedback: "Thinking..." },
  { from: "awaiting_transcript", event: "timeout", to: "error", hasTimeout: false, userFeedback: "I didn't catch that, could you repeat?" },

  // Processing
  { from: "processing", event: "response_start", to: "responding", hasTimeout: true, userFeedback: "Speaking..." },
  { from: "processing", event: "utterance_start", to: "streaming_audio", hasTimeout: false, userFeedback: "Listening..." },
  { from: "processing", event: "timeout", to: "error", hasTimeout: false, userFeedback: "Sorry, that took too long" },

  // Responding
  { from: "responding", event: "response_done", to: "idle", hasTimeout: false, userFeedback: "Listening..." },
  { from: "responding", event: "barge_in_ack", to: "idle", hasTimeout: false, userFeedback: "Listening..." },
  { from: "responding", event: "utterance_start", to: "streaming_audio", hasTimeout: false, userFeedback: "Listening..." },
  { from: "responding", event: "timeout", to: "error", hasTimeout: false, userFeedback: "Response timed out" },

  // Error recovery
  { from: "error", event: "utterance_start", to: "streaming_audio", hasTimeout: false, userFeedback: "Listening..." },
  { from: "error", event: "ws_open", to: "connecting", hasTimeout: false, userFeedback: "Reconnecting..." },
  { from: "error", event: "session_end_request", to: "ended", hasTimeout: false, userFeedback: "Session ended" },

  // WS drops (from any active state)
  { from: "authenticating", event: "ws_close", to: "disconnected", hasTimeout: false, userFeedback: "Disconnected" },
  { from: "configuring", event: "ws_close", to: "disconnected", hasTimeout: false, userFeedback: "Disconnected" },
  { from: "idle", event: "ws_close", to: "disconnected", hasTimeout: false, userFeedback: "Disconnected" },
  { from: "streaming_audio", event: "ws_close", to: "disconnected", hasTimeout: false, userFeedback: "Disconnected" },
  { from: "awaiting_transcript", event: "ws_close", to: "disconnected", hasTimeout: false, userFeedback: "Disconnected" },
  { from: "processing", event: "ws_close", to: "disconnected", hasTimeout: false, userFeedback: "Disconnected" },
  { from: "responding", event: "ws_close", to: "disconnected", hasTimeout: false, userFeedback: "Disconnected" },
  { from: "error", event: "ws_close", to: "disconnected", hasTimeout: false, userFeedback: "Disconnected" },

  // Ended
  { from: "ended", event: "ws_open", to: "connecting", hasTimeout: false, userFeedback: "Connecting..." },
];

// ─── All States ───

export const ALL_STATES: ContractState[] = [
  "disconnected",
  "connecting",
  "authenticating",
  "configuring",
  "idle",
  "streaming_audio",
  "awaiting_transcript",
  "processing",
  "responding",
  "error",
  "ended",
];

// ─── States that must have timeouts guarding them ───

export const TIMEOUT_GUARDED_STATES: ContractState[] = [
  "authenticating",  // Auth must not hang
  "configuring",     // Config must not hang
  "awaiting_transcript", // STT must not hang (fixes current bug!)
  "processing",      // LLM must not hang
  "responding",      // Response must not run forever
];
