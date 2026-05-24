import type { CognitionState, SDKStatus, VoiceStatus } from "@sentient/web-sdk";

// ---------------------------------------------------------------------------
// Status label maps
// ---------------------------------------------------------------------------

const COGNITION_LABEL: Record<CognitionState, string> = {
  idle: "Listening...",
  thinking: "Thinking...",
  acting: "Thinking...",
};

// ---------------------------------------------------------------------------
// Gateway URL resolver
// ---------------------------------------------------------------------------

export function resolveGatewayUrl(wsUrl?: string): string {
  if (wsUrl) return wsUrl;
  if (typeof window === "undefined") {
    throw new Error("gatewayUrl is required outside a browser — pass wsUrl explicitly.");
  }
  const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${window.location.host}/api/v1/ws`;
}

// ---------------------------------------------------------------------------
// buildVoiceStatus — maps SDK + cognition + audio state → UI VoiceStatus
//
// Source-of-truth mapping:
//   isAudioPlaying === true               → assistant-speaking
//   cognition === "acting" | "thinking"   → assistant-thinking (server processing)
//   cognition === "idle", no audio        → listening
// ---------------------------------------------------------------------------

export function buildVoiceStatus(
  sdkStatus: SDKStatus,
  cognition: CognitionState,
  isAudioPlaying: boolean,
  voiceModeActive: boolean,
): VoiceStatus {
  if (sdkStatus === "error") {
    return { state: "error", label: "Something went wrong", canSpeak: false, isActive: false };
  }

  if (sdkStatus !== "ready") {
    return { state: "connecting", label: "Connecting...", canSpeak: false, isActive: false };
  }

  if (isAudioPlaying) {
    return { state: "assistant-speaking", label: "Speaking...", canSpeak: false, isActive: voiceModeActive };
  }

  if (cognition === "acting" || cognition === "thinking") {
    return { state: "processing", label: COGNITION_LABEL[cognition], canSpeak: false, isActive: voiceModeActive };
  }

  return {
    state: "listening",
    label: COGNITION_LABEL.idle,
    canSpeak: voiceModeActive,
    isActive: voiceModeActive,
  };
}
