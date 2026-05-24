// Copied from consumer-api PoC — the system under test
// (In the real SDK this would be an import)

export type VoiceState =
  | "inactive"
  | "connecting"
  | "listening"
  | "user-speaking"
  | "processing"
  | "assistant-speaking"
  | "interrupting"
  | "reconnecting"
  | "error";

export type VoiceEvent =
  | { type: "CONNECT" }
  | { type: "AUTH_OK"; sessionId: string }
  | { type: "AUTH_FAILED"; reason: string }
  | { type: "TIMEOUT"; context: string }
  | { type: "SPEECH_START" }
  | { type: "SPEECH_END" }
  | { type: "CANCEL" }
  | { type: "TRANSCRIPT_PARTIAL"; text: string }
  | { type: "TRANSCRIPT_FINAL"; text: string }
  | { type: "RESPONSE_START" }
  | { type: "AUDIO_DONE" }
  | { type: "RESPONSE_TEXT_DONE" }
  | { type: "BARGE_IN_ACK" }
  | { type: "WS_DROP" }
  | { type: "RECONNECTED" }
  | { type: "MAX_RETRIES" }
  | { type: "RETRY" }
  | { type: "DISMISS" }
  | { type: "DISCONNECT" }
  | { type: "SESSION_END" };

export type SideEffect =
  | { type: "OPEN_WS" }
  | { type: "SEND_AUTH" }
  | { type: "SEND_UTTERANCE_START" }
  | { type: "SEND_UTTERANCE_END" }
  | { type: "SEND_UTTERANCE_CANCEL" }
  | { type: "SEND_BARGE_IN" }
  | { type: "START_VAD" }
  | { type: "STOP_VAD" }
  | { type: "START_AUDIO_STREAM" }
  | { type: "STOP_AUDIO_STREAM" }
  | { type: "START_PLAYBACK" }
  | { type: "STOP_PLAYBACK" }
  | { type: "CLEAR_PLAYBACK" }
  | { type: "START_TIMEOUT"; key: string; ms: number }
  | { type: "CANCEL_TIMEOUT"; key: string }
  | { type: "START_RECONNECT_BACKOFF" }
  | { type: "CLEANUP" }
  | { type: "LOG_WARNING"; message: string };

export interface TransitionResult {
  state: VoiceState;
  effects: SideEffect[];
}

export function transition(state: VoiceState, event: VoiceEvent): TransitionResult {
  if (event.type === "SESSION_END") {
    return { state: "inactive", effects: [{ type: "CLEANUP" }] };
  }

  switch (state) {
    case "inactive":
      if (event.type === "CONNECT") {
        return {
          state: "connecting",
          effects: [
            { type: "OPEN_WS" },
            { type: "SEND_AUTH" },
            { type: "START_TIMEOUT", key: "auth", ms: 10_000 },
          ],
        };
      }
      break;

    case "connecting":
      if (event.type === "AUTH_OK") {
        return {
          state: "listening",
          effects: [
            { type: "CANCEL_TIMEOUT", key: "auth" },
            { type: "START_VAD" },
          ],
        };
      }
      if (event.type === "AUTH_FAILED" || (event.type === "TIMEOUT" && event.context === "auth")) {
        return {
          state: "error",
          effects: [{ type: "CANCEL_TIMEOUT", key: "auth" }],
        };
      }
      if (event.type === "WS_DROP") {
        return {
          state: "reconnecting",
          effects: [
            { type: "CANCEL_TIMEOUT", key: "auth" },
            { type: "START_RECONNECT_BACKOFF" },
          ],
        };
      }
      break;

    case "listening":
      if (event.type === "SPEECH_START") {
        return {
          state: "user-speaking",
          effects: [
            { type: "SEND_UTTERANCE_START" },
            { type: "START_AUDIO_STREAM" },
          ],
        };
      }
      if (event.type === "DISCONNECT") {
        return { state: "inactive", effects: [{ type: "CLEANUP" }] };
      }
      if (event.type === "WS_DROP") {
        return {
          state: "reconnecting",
          effects: [{ type: "STOP_VAD" }, { type: "START_RECONNECT_BACKOFF" }],
        };
      }
      break;

    case "user-speaking":
      if (event.type === "SPEECH_END") {
        return {
          state: "processing",
          effects: [
            { type: "SEND_UTTERANCE_END" },
            { type: "STOP_AUDIO_STREAM" },
            { type: "START_TIMEOUT", key: "processing", ms: 30_000 },
          ],
        };
      }
      if (event.type === "CANCEL") {
        return {
          state: "listening",
          effects: [
            { type: "SEND_UTTERANCE_CANCEL" },
            { type: "STOP_AUDIO_STREAM" },
          ],
        };
      }
      if (event.type === "WS_DROP") {
        return {
          state: "reconnecting",
          effects: [
            { type: "STOP_AUDIO_STREAM" },
            { type: "START_RECONNECT_BACKOFF" },
          ],
        };
      }
      break;

    case "processing":
      if (event.type === "TRANSCRIPT_PARTIAL" || event.type === "TRANSCRIPT_FINAL") {
        return { state: "processing", effects: [] };
      }
      if (event.type === "RESPONSE_START") {
        return {
          state: "assistant-speaking",
          effects: [
            { type: "CANCEL_TIMEOUT", key: "processing" },
            { type: "START_PLAYBACK" },
          ],
        };
      }
      if (event.type === "TIMEOUT" && event.context === "processing") {
        return { state: "error", effects: [] };
      }
      if (event.type === "SPEECH_START") {
        return { state: "processing", effects: [{ type: "LOG_WARNING", message: "Speech during processing ignored" }] };
      }
      if (event.type === "WS_DROP") {
        return {
          state: "reconnecting",
          effects: [
            { type: "CANCEL_TIMEOUT", key: "processing" },
            { type: "START_RECONNECT_BACKOFF" },
          ],
        };
      }
      break;

    case "assistant-speaking":
      if (event.type === "AUDIO_DONE") {
        return {
          state: "listening",
          effects: [{ type: "STOP_PLAYBACK" }, { type: "START_VAD" }],
        };
      }
      if (event.type === "SPEECH_START") {
        return {
          state: "interrupting",
          effects: [
            { type: "STOP_PLAYBACK" },
            { type: "CLEAR_PLAYBACK" },
            { type: "SEND_BARGE_IN" },
            { type: "START_TIMEOUT", key: "barge_in_ack", ms: 3_000 },
          ],
        };
      }
      if (event.type === "RESPONSE_TEXT_DONE") {
        return { state: "assistant-speaking", effects: [] };
      }
      if (event.type === "WS_DROP") {
        return {
          state: "reconnecting",
          effects: [
            { type: "STOP_PLAYBACK" },
            { type: "START_RECONNECT_BACKOFF" },
          ],
        };
      }
      break;

    case "interrupting":
      if (event.type === "BARGE_IN_ACK") {
        return {
          state: "user-speaking",
          effects: [
            { type: "CANCEL_TIMEOUT", key: "barge_in_ack" },
            { type: "SEND_UTTERANCE_START" },
            { type: "START_AUDIO_STREAM" },
          ],
        };
      }
      if (event.type === "TIMEOUT" && event.context === "barge_in_ack") {
        return {
          state: "listening",
          effects: [
            { type: "LOG_WARNING", message: "barge_in ack timeout" },
            { type: "START_VAD" },
          ],
        };
      }
      if (event.type === "WS_DROP") {
        return {
          state: "reconnecting",
          effects: [{ type: "START_RECONNECT_BACKOFF" }],
        };
      }
      break;

    case "reconnecting":
      if (event.type === "RECONNECTED") {
        return {
          state: "listening",
          effects: [{ type: "START_VAD" }],
        };
      }
      if (event.type === "MAX_RETRIES") {
        return { state: "error", effects: [] };
      }
      break;

    case "error":
      if (event.type === "RETRY") {
        return {
          state: "connecting",
          effects: [
            { type: "OPEN_WS" },
            { type: "SEND_AUTH" },
            { type: "START_TIMEOUT", key: "auth", ms: 10_000 },
          ],
        };
      }
      if (event.type === "DISMISS") {
        return { state: "inactive", effects: [{ type: "CLEANUP" }] };
      }
      break;
  }

  return {
    state,
    effects: [{ type: "LOG_WARNING", message: `Ignored ${event.type} in ${state}` }],
  };
}

// Status labels
const STATUS_LABELS: Record<VoiceState, string> = {
  inactive: "Ready",
  connecting: "Connecting...",
  listening: "Listening...",
  "user-speaking": "Hearing you...",
  processing: "Thinking...",
  "assistant-speaking": "Speaking...",
  interrupting: "One moment...",
  reconnecting: "Reconnecting...",
  error: "Something went wrong",
};

const SPEAKABLE_STATES: Set<VoiceState> = new Set(["listening", "assistant-speaking"]);

export interface VoiceStatus {
  state: VoiceState;
  label: string;
  canSpeak: boolean;
  isActive: boolean;
  transcript?: string;
  error?: string;
}

export type StateListener = (status: VoiceStatus) => void;

export class VoiceClient {
  private _state: VoiceState = "inactive";
  private _transcript: string | undefined;
  private _error: string | undefined;
  private _listeners = new Set<StateListener>();
  private _effectHandler: ((effect: SideEffect) => void) | undefined;

  get status(): VoiceStatus {
    return {
      state: this._state,
      label: STATUS_LABELS[this._state],
      canSpeak: SPEAKABLE_STATES.has(this._state),
      isActive: this._state !== "inactive" && this._state !== "error",
      transcript: this._transcript,
      error: this._error,
    };
  }

  onStatusChange(listener: StateListener): () => void {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  onEffect(handler: (effect: SideEffect) => void): void {
    this._effectHandler = handler;
  }

  send(event: VoiceEvent): void {
    const prev = this._state;
    const result = transition(this._state, event);
    this._state = result.state;

    if (event.type === "TRANSCRIPT_PARTIAL" || event.type === "TRANSCRIPT_FINAL") {
      this._transcript = event.text;
    }
    if (result.state === "error") {
      this._error =
        event.type === "AUTH_FAILED" ? event.reason :
        event.type === "TIMEOUT" ? `Timed out (${event.context})` :
        event.type === "MAX_RETRIES" ? "Connection lost" :
        "Unknown error";
    } else {
      this._error = undefined;
    }

    for (const effect of result.effects) {
      this._effectHandler?.(effect);
    }

    if (prev !== this._state) {
      const status = this.status;
      for (const listener of this._listeners) {
        listener(status);
      }
    }
  }

  connect() { this.send({ type: "CONNECT" }); }
  disconnect() { this.send({ type: "DISCONNECT" }); }
  retry() { this.send({ type: "RETRY" }); }
  dismiss() { this.send({ type: "DISMISS" }); }
}
