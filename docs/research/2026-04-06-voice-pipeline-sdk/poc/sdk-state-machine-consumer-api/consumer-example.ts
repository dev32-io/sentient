// ============================================================
// CONSUMER EXAMPLE — A developer uses the SDK in <50 lines
// Zero internal knowledge required. No providers, no protocols.
// ============================================================

import { VoiceClient } from "./state-machine";

// 1. Create client
const voice = new VoiceClient();

// 2. React to status changes — drive your UI from this single callback
voice.onStatusChange((status) => {
  // Update a status indicator
  document.getElementById("status")!.textContent = status.label;

  // Show/hide mic button based on whether input is accepted
  document.getElementById("mic")!.hidden = !status.canSpeak;

  // Show transcript as it streams in
  if (status.transcript) {
    document.getElementById("transcript")!.textContent = status.transcript;
  }

  // Show error with retry button
  if (status.state === "error") {
    showError(status.error ?? "Something went wrong", () => voice.retry());
  }
});

// 3. Connect — that's it, voice mode is active
voice.connect();

// 4. Wire up a manual talk button (if not using VAD)
document.getElementById("mic")!.addEventListener("mousedown", () => {
  voice.send({ type: "SPEECH_START" });
});
document.getElementById("mic")!.addEventListener("mouseup", () => {
  voice.send({ type: "SPEECH_END" });
});

// --- That's 35 lines. Developer is done. ---
// The SDK handles: connection, auth, reconnection, timeouts,
// barge-in, partial transcripts, error recovery, state guards.

// Helper (app code, not SDK)
function showError(message: string, onRetry: () => void) {
  const el = document.getElementById("error")!;
  el.textContent = message;
  el.querySelector("button")?.addEventListener("click", onRetry);
}
