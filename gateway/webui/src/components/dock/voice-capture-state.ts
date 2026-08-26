export type VoiceCaptureState =
  | "idle"
  | "hold"
  | "auto"
  | "transitioning"
  | "permission-denied"
  | "start-failed"
  | "reconnect-disabled";

export type VoiceCaptureTarget = "auto" | "cancel" | "send";

/** Compatibility names used only by the pre-semantic identified adapter. */
export type VoiceCaptureMode = "manual" | "semantic";

export const VOICE_CAPTURE_STATES: readonly VoiceCaptureState[] = [
  "idle",
  "hold",
  "auto",
  "transitioning",
  "permission-denied",
  "start-failed",
  "reconnect-disabled",
] as const;

export interface VoiceCapturePresentation {
  readonly state: VoiceCaptureState;
  readonly live: boolean;
  readonly disabled: boolean;
  readonly fanOpen: boolean;
  readonly primaryLabel: string;
  readonly primaryPressed: boolean;
  readonly tone: "neutral" | "active" | "error" | "disabled";
}

export function isVoiceCaptureLive(state: VoiceCaptureState): boolean {
  return state === "hold" || state === "auto" || state === "transitioning";
}

/**
 * Map internal state to the complete DOM-facing presentation contract.
 * Keeping this pure makes the state matrix testable without a browser, audio,
 * timers, or a connector.
 */
export function mapVoiceCapturePresentation(
  state: VoiceCaptureState,
  disabled: boolean,
  fanOpen: boolean,
): VoiceCapturePresentation {
  const unavailable = disabled || state === "reconnect-disabled";
  const live = !unavailable && isVoiceCaptureLive(state);
  const tone = unavailable
    ? "disabled"
    : state === "permission-denied" || state === "start-failed"
      ? "error"
      : live
        ? "active"
        : "neutral";

  return {
    state,
    live,
    disabled: unavailable,
    fanOpen: fanOpen && state === "hold" && !unavailable,
    primaryLabel: unavailable
      ? "Voice unavailable while reconnecting"
      : state === "auto"
        ? "Auto listening is on; activate to send and turn it off"
        : "Tap for Auto listening or hold to talk",
    primaryPressed: state === "auto" && !unavailable,
    tone,
  };
}

export function targetLabel(target: VoiceCaptureTarget): string {
  return target === "auto" ? "Auto" : target === "cancel" ? "Cancel" : "Send";
}
