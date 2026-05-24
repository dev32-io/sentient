/**
 * Consumer API Demo: Error UX in <50 lines
 *
 * A developer plugs in the error classifier with zero internal knowledge.
 * They handle any pipeline error with friendly messages and deterministic recovery.
 */
import {
  pipelineError,
  classifyError,
  resolveRecovery,
  friendlyMessage,
  createProcessingTimer,
} from "../src/index";

// 1. Handle any pipeline error in 3 lines
function handleError(source: "stt" | "llm" | "tts" | "auth" | "network" | "protocol", phase: "connecting" | "streaming" | "finalizing" | "idle", rawError: unknown) {
  const error = pipelineError(source, phase, String(rawError), rawError);
  const category = classifyError(error);
  const recovery = resolveRecovery(category);

  showToUser(friendlyMessage(category));

  // Recovery is deterministic — switch on type, done
  if (recovery.type === "auto_reconnect") reconnect();
  if (recovery.type === "reset_to_listening") resetMic();
  if (recovery.type === "require_auth") redirectToLogin();
}

// 2. Processing timer — never leave user staring at nothing
function startProcessing() {
  const timer = createProcessingTimer((event) => {
    if (event.message) showToUser(event.message);
    if (event.stage === "timeout") handleError("llm", "streaming", "Processing timed out");
  });
  return timer; // caller stores and calls timer.cancel() when response arrives
}

// --- Simulated app glue (not part of SDK) ---
function showToUser(msg: string) { console.log(`[UI] ${msg}`); }
function reconnect() { console.log("[App] Reconnecting..."); }
function resetMic() { console.log("[App] Reset to listening"); }
function redirectToLogin() { console.log("[App] Redirect to login"); }

// --- Demo: simulate various errors ---
console.log("=== STT drops mid-stream ===");
handleError("stt", "streaming", new Error("WebSocket closed unexpectedly"));

console.log("\n=== LLM hangs, timeout fires ===");
handleError("llm", "streaming", "Processing timed out");

console.log("\n=== Network lost ===");
handleError("network", "idle", "fetch failed");

console.log("\n=== Auth expired ===");
handleError("auth", "idle", "Token expired");

console.log("\n=== TTS fails mid-sentence ===");
handleError("tts", "streaming", "Connection reset");

console.log("\n=== Processing timer demo ===");
const timer = startProcessing();
// In real usage: timer.cancel() when first response token arrives
setTimeout(() => timer.cancel(), 100); // cancel after demo
