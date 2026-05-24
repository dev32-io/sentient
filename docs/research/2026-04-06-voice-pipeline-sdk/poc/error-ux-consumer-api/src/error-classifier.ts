import type { PipelineError } from "./pipeline-error";

// User-facing error categories — the ONLY thing consumers see
export type UserErrorCategory =
  | "connection_lost"
  | "didnt_catch"
  | "thinking_timeout"
  | "service_unavailable"
  | "auth_required"
  | "try_again";

// Pure function: classify any technical error into a user-facing category
export function classifyError(error: PipelineError): UserErrorCategory {
  // Auth errors always require re-auth
  if (error.source === "auth") return "auth_required";

  // Network errors → connection lost (auto-reconnect)
  if (error.source === "network") return "connection_lost";

  // STT errors during streaming → "didn't catch that"
  if (error.source === "stt" && error.phase === "streaming") return "didnt_catch";
  if (error.source === "stt" && error.phase === "connecting") return "didnt_catch";

  // LLM errors → thinking timeout (user was waiting for a response)
  if (error.source === "llm" && error.phase === "streaming") return "thinking_timeout";
  if (error.source === "llm" && error.phase === "connecting") return "service_unavailable";

  // TTS errors → try again (text may still be delivered)
  if (error.source === "tts") return "try_again";

  // Protocol errors → try again
  if (error.source === "protocol") return "try_again";

  // Catch-all: never silent
  return "try_again";
}
