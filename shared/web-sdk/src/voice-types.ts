// ---------------------------------------------------------------------------
// Voice UI types — shared between SDK and webui.
//
// VoiceState and VoiceStatus describe the client-visible state of a voice
// session. ChatMessage is the display model for the chat log.
// ---------------------------------------------------------------------------

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

export interface VoiceStatus {
  state: VoiceState;
  label: string;
  canSpeak: boolean;
  isActive: boolean;
  transcript?: string;
  error?: string;
}

export interface ChatMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly timestamp: number;
  readonly isStreaming: boolean;
  /** Only set for user messages — which input channel this was from. */
  readonly channel?: "text" | "speech";
  /** Present on assistant messages when the reply was cut short.
   *  - `barge-in`: user spoke mid-TTS; playback stopped.
   *  - `interrupt`: turn hard-aborted. `cancelledTaskIds` is always empty —
   *    an interrupt cancels the turn and nothing else, and no background task
   *    is ever cancelled. Do not render it as tasks killed. */
  readonly cutoff?:
    | { readonly kind: "barge-in" }
    | { readonly kind: "interrupt"; readonly cancelledTaskIds: readonly string[] };
}
