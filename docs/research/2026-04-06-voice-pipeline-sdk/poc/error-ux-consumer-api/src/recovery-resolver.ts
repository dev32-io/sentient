import type { UserErrorCategory } from "./error-classifier";

export type RecoveryAction =
  | { type: "auto_reconnect" }
  | { type: "reset_to_listening" }
  | { type: "retry_once" }
  | { type: "wait_and_retry" }
  | { type: "require_auth" }
  | { type: "prompt_retry" };

// Pure function: category → deterministic recovery action
export function resolveRecovery(category: UserErrorCategory): RecoveryAction {
  switch (category) {
    case "connection_lost":     return { type: "auto_reconnect" };
    case "didnt_catch":         return { type: "reset_to_listening" };
    case "thinking_timeout":    return { type: "retry_once" };
    case "service_unavailable": return { type: "wait_and_retry" };
    case "auth_required":       return { type: "require_auth" };
    case "try_again":           return { type: "prompt_retry" };
  }
}
