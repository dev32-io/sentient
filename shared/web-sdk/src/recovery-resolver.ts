import type { UserErrorCategory } from "./error-classifier.ts";

export type RecoveryType =
  | "auto_reconnect"
  | "reset_to_listening"
  | "retry_once"
  | "wait_and_retry"
  | "require_auth"
  | "prompt_retry";

export interface RecoveryAction {
  type: RecoveryType;
  message: string;
  autoRetry: boolean;
  delayMs: number;
}

const MESSAGES: Record<UserErrorCategory, string> = {
  auth_required: "Please sign in again",
  connection_lost: "Reconnecting...",
  didnt_catch: "Sorry, I didn't catch that — could you say it again?",
  thinking_timeout: "Still thinking... trying again",
  service_unavailable: "Service temporarily unavailable — retrying shortly",
  try_again: "Something went wrong — please try again",
};

const RECOVERY_MAP: Record<UserErrorCategory, RecoveryAction> = {
  connection_lost: { type: "auto_reconnect", message: MESSAGES.connection_lost, autoRetry: true, delayMs: 1000 },
  didnt_catch: { type: "reset_to_listening", message: MESSAGES.didnt_catch, autoRetry: true, delayMs: 500 },
  thinking_timeout: { type: "retry_once", message: MESSAGES.thinking_timeout, autoRetry: true, delayMs: 0 },
  service_unavailable: {
    type: "wait_and_retry",
    message: MESSAGES.service_unavailable,
    autoRetry: true,
    delayMs: 5000,
  },
  auth_required: { type: "require_auth", message: MESSAGES.auth_required, autoRetry: false, delayMs: 0 },
  try_again: { type: "prompt_retry", message: MESSAGES.try_again, autoRetry: false, delayMs: 0 },
};

/** Pure resolver: error category → recovery strategy */
export function resolveRecovery(category: UserErrorCategory): RecoveryAction {
  return RECOVERY_MAP[category];
}

/** Get user-friendly message for category */
export function friendlyMessage(category: UserErrorCategory): string {
  return MESSAGES[category];
}
