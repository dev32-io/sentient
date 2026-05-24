// Error UX State Machine — formal transition table
// Models the lifecycle of an error from detection through recovery/escalation.
// Pure function: (state, event) → { state, effects }

// --- Types ---

export type ErrorUXState =
  | "nominal"           // No error active, pipeline running normally
  | "error_detected"    // Raw error received, classification pending
  | "user_notified"     // Friendly message shown to user
  | "auto_recovering"   // Auto-recovery in progress (reconnect, reset, retry)
  | "awaiting_user"     // Requires user action (re-auth, manual retry)
  | "recovery_timeout"  // Recovery attempt timed out
  | "escalated";        // Error persisted after recovery, escalated message shown

export type ErrorSource = "stt" | "llm" | "tts" | "auth" | "network" | "protocol";
export type ErrorPhase = "connecting" | "streaming" | "finalizing" | "idle";

export type UserErrorCategory =
  | "connection_lost"
  | "didnt_catch"
  | "thinking_timeout"
  | "service_unavailable"
  | "auth_required"
  | "try_again";

export type RecoveryType =
  | "auto_reconnect"
  | "reset_to_listening"
  | "retry_once"
  | "wait_and_retry"
  | "require_auth"
  | "prompt_retry";

export type ErrorUXEvent =
  | { type: "error_occurred"; source: ErrorSource; phase: ErrorPhase; message: string }
  | { type: "classified"; category: UserErrorCategory }
  | { type: "user_shown" }
  | { type: "recovery_started"; recovery: RecoveryType }
  | { type: "recovery_succeeded" }
  | { type: "recovery_failed"; reason: string }
  | { type: "recovery_timed_out" }
  | { type: "user_action"; action: "retry" | "reauthenticate" | "dismiss" }
  | { type: "escalation_acknowledged" }
  | { type: "reset" };

export type Effect =
  | { type: "classify_error"; source: ErrorSource; phase: ErrorPhase }
  | { type: "show_message"; category: UserErrorCategory; message: string }
  | { type: "start_recovery"; recovery: RecoveryType }
  | { type: "start_recovery_timer"; timeout: number }
  | { type: "cancel_recovery_timer" }
  | { type: "escalate"; originalCategory: UserErrorCategory; reason: string }
  | { type: "return_to_pipeline" }
  | { type: "log"; message: string };

export interface ErrorUXContext {
  currentCategory: UserErrorCategory | null;
  recoveryAttempts: number;
  maxRecoveryAttempts: number;
  recoveryTimeoutMs: number;
}

export interface TransitionResult {
  state: ErrorUXState;
  context: ErrorUXContext;
  effects: Effect[];
}

// --- Pure State Machine ---

const DEFAULT_CONTEXT: ErrorUXContext = {
  currentCategory: null,
  recoveryAttempts: 0,
  maxRecoveryAttempts: 2,
  recoveryTimeoutMs: 10_000,
};

export function initialState(): TransitionResult {
  return { state: "nominal", context: { ...DEFAULT_CONTEXT }, effects: [] };
}

export function transition(
  state: ErrorUXState,
  context: ErrorUXContext,
  event: ErrorUXEvent
): TransitionResult {
  switch (state) {
    case "nominal":
      return transitionNominal(context, event);
    case "error_detected":
      return transitionErrorDetected(context, event);
    case "user_notified":
      return transitionUserNotified(context, event);
    case "auto_recovering":
      return transitionAutoRecovering(context, event);
    case "awaiting_user":
      return transitionAwaitingUser(context, event);
    case "recovery_timeout":
      return transitionRecoveryTimeout(context, event);
    case "escalated":
      return transitionEscalated(context, event);
  }
}

// --- Classifier (pure) ---

export function classifyError(source: ErrorSource, phase: ErrorPhase): UserErrorCategory {
  if (source === "auth") return "auth_required";
  if (source === "network") return "connection_lost";
  if (source === "stt") return "didnt_catch";
  if (source === "llm" && phase === "streaming") return "thinking_timeout";
  if (source === "llm" && phase === "connecting") return "service_unavailable";
  if (source === "tts") return "try_again";
  if (source === "protocol") return "try_again";
  return "try_again";
}

// --- Recovery resolver (pure) ---

export function resolveRecovery(category: UserErrorCategory): RecoveryType {
  switch (category) {
    case "connection_lost":     return "auto_reconnect";
    case "didnt_catch":         return "reset_to_listening";
    case "thinking_timeout":    return "retry_once";
    case "service_unavailable": return "wait_and_retry";
    case "auth_required":       return "require_auth";
    case "try_again":           return "prompt_retry";
  }
}

export function isAutoRecoverable(recovery: RecoveryType): boolean {
  return recovery === "auto_reconnect"
    || recovery === "reset_to_listening"
    || recovery === "retry_once";
}

// --- User messages (pure) ---

const USER_MESSAGES: Record<UserErrorCategory, string> = {
  connection_lost:     "Sorry, I lost the connection. Reconnecting...",
  didnt_catch:         "I didn't catch that. Could you repeat?",
  thinking_timeout:    "Hmm, I'm taking longer than usual...",
  service_unavailable: "I'm having trouble right now. Try again in a moment.",
  auth_required:       "Please sign in again.",
  try_again:           "Something went wrong. Could you try again?",
};

export function userMessage(category: UserErrorCategory): string {
  return USER_MESSAGES[category];
}

// --- Timeout guards ---

const RECOVERY_TIMEOUTS: Record<RecoveryType, number> = {
  auto_reconnect:    10_000,
  reset_to_listening: 2_000,
  retry_once:         15_000,
  wait_and_retry:     30_000,
  require_auth:       60_000,
  prompt_retry:       30_000,
};

export function recoveryTimeout(recovery: RecoveryType): number {
  return RECOVERY_TIMEOUTS[recovery];
}

// --- State Handlers ---

function transitionNominal(ctx: ErrorUXContext, event: ErrorUXEvent): TransitionResult {
  if (event.type === "error_occurred") {
    const category = classifyError(event.source, event.phase);
    const recovery = resolveRecovery(category);
    const msg = userMessage(category);
    const newCtx: ErrorUXContext = {
      ...ctx,
      currentCategory: category,
      recoveryAttempts: 0,
      recoveryTimeoutMs: recoveryTimeout(recovery),
    };

    if (isAutoRecoverable(recovery)) {
      return {
        state: "auto_recovering",
        context: newCtx,
        effects: [
          { type: "show_message", category, message: msg },
          { type: "start_recovery", recovery },
          { type: "start_recovery_timer", timeout: newCtx.recoveryTimeoutMs },
        ],
      };
    }

    // Requires user action
    return {
      state: "awaiting_user",
      context: newCtx,
      effects: [
        { type: "show_message", category, message: msg },
      ],
    };
  }

  // Ignore non-error events in nominal
  return { state: "nominal", context: ctx, effects: [] };
}

function transitionErrorDetected(ctx: ErrorUXContext, event: ErrorUXEvent): TransitionResult {
  if (event.type === "classified") {
    const recovery = resolveRecovery(event.category);
    const msg = userMessage(event.category);
    const newCtx: ErrorUXContext = {
      ...ctx,
      currentCategory: event.category,
      recoveryTimeoutMs: recoveryTimeout(recovery),
    };

    return {
      state: "user_notified",
      context: newCtx,
      effects: [
        { type: "show_message", category: event.category, message: msg },
      ],
    };
  }

  if (event.type === "reset") {
    return initialState();
  }

  return { state: "error_detected", context: ctx, effects: [{ type: "log", message: `Unexpected event ${event.type} in error_detected` }] };
}

function transitionUserNotified(ctx: ErrorUXContext, event: ErrorUXEvent): TransitionResult {
  if (event.type === "recovery_started" && ctx.currentCategory) {
    return {
      state: "auto_recovering",
      context: { ...ctx, recoveryAttempts: ctx.recoveryAttempts + 1 },
      effects: [
        { type: "start_recovery", recovery: event.recovery },
        { type: "start_recovery_timer", timeout: ctx.recoveryTimeoutMs },
      ],
    };
  }

  if (event.type === "user_action") {
    if (event.action === "dismiss") {
      return { state: "nominal", context: { ...DEFAULT_CONTEXT }, effects: [{ type: "return_to_pipeline" }] };
    }
    if (event.action === "retry" && ctx.currentCategory) {
      const recovery = resolveRecovery(ctx.currentCategory);
      return {
        state: "auto_recovering",
        context: { ...ctx, recoveryAttempts: ctx.recoveryAttempts + 1 },
        effects: [
          { type: "start_recovery", recovery },
          { type: "start_recovery_timer", timeout: ctx.recoveryTimeoutMs },
        ],
      };
    }
    if (event.action === "reauthenticate") {
      return { state: "nominal", context: { ...DEFAULT_CONTEXT }, effects: [{ type: "return_to_pipeline" }] };
    }
  }

  if (event.type === "reset") {
    return initialState();
  }

  return { state: "user_notified", context: ctx, effects: [] };
}

function transitionAutoRecovering(ctx: ErrorUXContext, event: ErrorUXEvent): TransitionResult {
  if (event.type === "recovery_succeeded") {
    return {
      state: "nominal",
      context: { ...DEFAULT_CONTEXT },
      effects: [
        { type: "cancel_recovery_timer" },
        { type: "return_to_pipeline" },
      ],
    };
  }

  if (event.type === "recovery_failed") {
    if (ctx.recoveryAttempts < ctx.maxRecoveryAttempts && ctx.currentCategory) {
      // Retry
      const recovery = resolveRecovery(ctx.currentCategory);
      return {
        state: "auto_recovering",
        context: { ...ctx, recoveryAttempts: ctx.recoveryAttempts + 1 },
        effects: [
          { type: "cancel_recovery_timer" },
          { type: "start_recovery", recovery },
          { type: "start_recovery_timer", timeout: ctx.recoveryTimeoutMs },
        ],
      };
    }
    // Exhausted retries → escalate
    return {
      state: "escalated",
      context: ctx,
      effects: [
        { type: "cancel_recovery_timer" },
        { type: "escalate", originalCategory: ctx.currentCategory!, reason: event.reason },
      ],
    };
  }

  if (event.type === "recovery_timed_out") {
    return {
      state: "recovery_timeout",
      context: ctx,
      effects: [
        { type: "escalate", originalCategory: ctx.currentCategory!, reason: "Recovery timed out" },
      ],
    };
  }

  // New error during recovery — re-classify from nominal
  if (event.type === "error_occurred") {
    const category = classifyError(event.source, event.phase);
    const recovery = resolveRecovery(category);
    const msg = userMessage(category);
    const newCtx: ErrorUXContext = {
      ...ctx,
      currentCategory: category,
      recoveryAttempts: 0,
      recoveryTimeoutMs: recoveryTimeout(recovery),
    };

    if (isAutoRecoverable(recovery)) {
      return {
        state: "auto_recovering",
        context: newCtx,
        effects: [
          { type: "cancel_recovery_timer" },
          { type: "show_message", category, message: msg },
          { type: "start_recovery", recovery },
          { type: "start_recovery_timer", timeout: newCtx.recoveryTimeoutMs },
        ],
      };
    }

    return {
      state: "awaiting_user",
      context: newCtx,
      effects: [
        { type: "cancel_recovery_timer" },
        { type: "show_message", category, message: msg },
      ],
    };
  }

  if (event.type === "reset") {
    return { state: "nominal", context: { ...DEFAULT_CONTEXT }, effects: [{ type: "cancel_recovery_timer" }] };
  }

  return { state: "auto_recovering", context: ctx, effects: [] };
}

function transitionAwaitingUser(ctx: ErrorUXContext, event: ErrorUXEvent): TransitionResult {
  if (event.type === "user_action") {
    if (event.action === "retry" && ctx.currentCategory) {
      const recovery = resolveRecovery(ctx.currentCategory);
      return {
        state: "auto_recovering",
        context: { ...ctx, recoveryAttempts: ctx.recoveryAttempts + 1 },
        effects: [
          { type: "start_recovery", recovery },
          { type: "start_recovery_timer", timeout: ctx.recoveryTimeoutMs },
        ],
      };
    }
    if (event.action === "reauthenticate") {
      return { state: "nominal", context: { ...DEFAULT_CONTEXT }, effects: [{ type: "return_to_pipeline" }] };
    }
    if (event.action === "dismiss") {
      return { state: "nominal", context: { ...DEFAULT_CONTEXT }, effects: [{ type: "return_to_pipeline" }] };
    }
  }

  // New error while awaiting user — replace context
  if (event.type === "error_occurred") {
    const category = classifyError(event.source, event.phase);
    const recovery = resolveRecovery(category);
    const msg = userMessage(category);
    const newCtx: ErrorUXContext = {
      ...ctx,
      currentCategory: category,
      recoveryAttempts: 0,
      recoveryTimeoutMs: recoveryTimeout(recovery),
    };

    if (isAutoRecoverable(recovery)) {
      return {
        state: "auto_recovering",
        context: newCtx,
        effects: [
          { type: "show_message", category, message: msg },
          { type: "start_recovery", recovery },
          { type: "start_recovery_timer", timeout: newCtx.recoveryTimeoutMs },
        ],
      };
    }

    return {
      state: "awaiting_user",
      context: newCtx,
      effects: [{ type: "show_message", category, message: msg }],
    };
  }

  if (event.type === "reset") {
    return initialState();
  }

  return { state: "awaiting_user", context: ctx, effects: [] };
}

function transitionRecoveryTimeout(ctx: ErrorUXContext, event: ErrorUXEvent): TransitionResult {
  if (event.type === "user_action") {
    if (event.action === "retry" && ctx.currentCategory) {
      const recovery = resolveRecovery(ctx.currentCategory);
      return {
        state: "auto_recovering",
        context: { ...ctx, recoveryAttempts: 0, recoveryTimeoutMs: recoveryTimeout(recovery) },
        effects: [
          { type: "start_recovery", recovery },
          { type: "start_recovery_timer", timeout: recoveryTimeout(recovery) },
        ],
      };
    }
    if (event.action === "dismiss" || event.action === "reauthenticate") {
      return { state: "nominal", context: { ...DEFAULT_CONTEXT }, effects: [{ type: "return_to_pipeline" }] };
    }
  }

  if (event.type === "reset") {
    return initialState();
  }

  return { state: "recovery_timeout", context: ctx, effects: [] };
}

function transitionEscalated(ctx: ErrorUXContext, event: ErrorUXEvent): TransitionResult {
  if (event.type === "user_action") {
    if (event.action === "retry" && ctx.currentCategory) {
      const recovery = resolveRecovery(ctx.currentCategory);
      return {
        state: "auto_recovering",
        context: { ...ctx, recoveryAttempts: 0, recoveryTimeoutMs: recoveryTimeout(recovery) },
        effects: [
          { type: "start_recovery", recovery },
          { type: "start_recovery_timer", timeout: recoveryTimeout(recovery) },
        ],
      };
    }
    if (event.action === "dismiss" || event.action === "reauthenticate") {
      return { state: "nominal", context: { ...DEFAULT_CONTEXT }, effects: [{ type: "return_to_pipeline" }] };
    }
  }

  if (event.type === "escalation_acknowledged") {
    return { state: "awaiting_user", context: ctx, effects: [] };
  }

  if (event.type === "reset") {
    return initialState();
  }

  return { state: "escalated", context: ctx, effects: [] };
}

// --- Formal Transition Table ---
// For documentation: every (state, event.type) pair and its target state

export const TRANSITION_TABLE: Array<{
  from: ErrorUXState;
  event: string;
  to: ErrorUXState;
  guard?: string;
}> = [
  // nominal
  { from: "nominal", event: "error_occurred", to: "auto_recovering", guard: "auto-recoverable" },
  { from: "nominal", event: "error_occurred", to: "awaiting_user", guard: "requires user action" },

  // error_detected (intermediate — used if classification is async)
  { from: "error_detected", event: "classified", to: "user_notified" },
  { from: "error_detected", event: "reset", to: "nominal" },

  // user_notified
  { from: "user_notified", event: "recovery_started", to: "auto_recovering" },
  { from: "user_notified", event: "user_action(retry)", to: "auto_recovering" },
  { from: "user_notified", event: "user_action(dismiss)", to: "nominal" },
  { from: "user_notified", event: "user_action(reauthenticate)", to: "nominal" },
  { from: "user_notified", event: "reset", to: "nominal" },

  // auto_recovering
  { from: "auto_recovering", event: "recovery_succeeded", to: "nominal" },
  { from: "auto_recovering", event: "recovery_failed", to: "auto_recovering", guard: "retries remaining" },
  { from: "auto_recovering", event: "recovery_failed", to: "escalated", guard: "retries exhausted" },
  { from: "auto_recovering", event: "recovery_timed_out", to: "recovery_timeout" },
  { from: "auto_recovering", event: "error_occurred", to: "auto_recovering", guard: "new auto-recoverable error" },
  { from: "auto_recovering", event: "error_occurred", to: "awaiting_user", guard: "new user-action error" },
  { from: "auto_recovering", event: "reset", to: "nominal" },

  // awaiting_user
  { from: "awaiting_user", event: "user_action(retry)", to: "auto_recovering" },
  { from: "awaiting_user", event: "user_action(reauthenticate)", to: "nominal" },
  { from: "awaiting_user", event: "user_action(dismiss)", to: "nominal" },
  { from: "awaiting_user", event: "error_occurred", to: "auto_recovering", guard: "auto-recoverable" },
  { from: "awaiting_user", event: "error_occurred", to: "awaiting_user", guard: "requires user action" },
  { from: "awaiting_user", event: "reset", to: "nominal" },

  // recovery_timeout
  { from: "recovery_timeout", event: "user_action(retry)", to: "auto_recovering" },
  { from: "recovery_timeout", event: "user_action(dismiss)", to: "nominal" },
  { from: "recovery_timeout", event: "user_action(reauthenticate)", to: "nominal" },
  { from: "recovery_timeout", event: "reset", to: "nominal" },

  // escalated
  { from: "escalated", event: "user_action(retry)", to: "auto_recovering" },
  { from: "escalated", event: "user_action(dismiss)", to: "nominal" },
  { from: "escalated", event: "user_action(reauthenticate)", to: "nominal" },
  { from: "escalated", event: "escalation_acknowledged", to: "awaiting_user" },
  { from: "escalated", event: "reset", to: "nominal" },
];
