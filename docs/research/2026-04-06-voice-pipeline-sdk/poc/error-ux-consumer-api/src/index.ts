// Public API — everything a consumer needs
export { pipelineError } from "./pipeline-error";
export type { PipelineError, ErrorSource, ErrorPhase } from "./pipeline-error";
export { classifyError } from "./error-classifier";
export type { UserErrorCategory } from "./error-classifier";
export { resolveRecovery } from "./recovery-resolver";
export type { RecoveryAction } from "./recovery-resolver";
export { friendlyMessage } from "./user-messages";
export { createProcessingTimer } from "./processing-timer";
export type { ProcessingStage, ProcessingEvent } from "./processing-timer";
