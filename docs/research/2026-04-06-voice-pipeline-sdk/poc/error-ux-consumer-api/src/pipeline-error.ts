// Structured error type capturing where and when an error occurred
export type ErrorSource = "stt" | "llm" | "tts" | "auth" | "network" | "protocol";
export type ErrorPhase = "connecting" | "streaming" | "finalizing" | "idle";
export type ErrorSeverity = "recoverable" | "degraded" | "fatal";

export interface PipelineError {
  source: ErrorSource;
  phase: ErrorPhase;
  severity: ErrorSeverity;
  message: string;
  originalError?: unknown;
}

export function pipelineError(
  source: ErrorSource,
  phase: ErrorPhase,
  message: string,
  originalError?: unknown
): PipelineError {
  const severity = inferSeverity(source, phase);
  return { source, phase, severity, message, originalError };
}

function inferSeverity(source: ErrorSource, phase: ErrorPhase): ErrorSeverity {
  if (source === "auth") return "fatal";
  if (source === "network" && phase === "idle") return "recoverable";
  if (source === "network") return "degraded";
  if (phase === "connecting") return "recoverable";
  if (phase === "streaming") return "degraded";
  return "recoverable";
}
