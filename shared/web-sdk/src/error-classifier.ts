export type ErrorSource = "auth" | "network" | "stt" | "llm" | "tts" | "protocol";
export type ErrorPhase = "connecting" | "streaming" | "idle";
export type ErrorSeverity = "fatal" | "degraded" | "recoverable";
export type UserErrorCategory =
  | "auth_required"
  | "connection_lost"
  | "didnt_catch"
  | "thinking_timeout"
  | "service_unavailable"
  | "try_again";

export interface PipelineError {
  source: ErrorSource;
  phase: ErrorPhase;
  severity: ErrorSeverity;
  message: string;
}

/** Convenience factory */
export function pipelineError(
  source: ErrorSource,
  phase: ErrorPhase,
  severity: ErrorSeverity,
  message: string,
): PipelineError {
  return { source, phase, severity, message };
}

/** Pure classifier: raw error → user-facing category */
export function classifyError(error: PipelineError): UserErrorCategory {
  if (error.source === "auth") return "auth_required";
  if (error.source === "network") return "connection_lost";
  if (error.source === "stt") return "didnt_catch";
  if (error.source === "llm" && error.phase === "streaming") return "thinking_timeout";
  if (error.source === "llm") return "service_unavailable";
  return "try_again"; // catch-all for tts, protocol, unknown
}
