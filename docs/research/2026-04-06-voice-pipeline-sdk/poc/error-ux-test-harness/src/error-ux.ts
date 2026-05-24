// Consolidated Error UX module — combines classifier, recovery, messages, timer, and state machine
// All pure functions, zero I/O, fully testable in isolation

// --- Core Types ---

export type ErrorSource = "stt" | "llm" | "tts" | "auth" | "network" | "protocol";
export type ErrorPhase = "connecting" | "streaming" | "finalizing" | "idle";
export type ErrorSeverity = "recoverable" | "degraded" | "fatal";

export interface PipelineError {
  source: ErrorSource;
  phase: ErrorPhase;
  severity: ErrorSeverity;
  message: string;
  originalError?: unknown;
  isAbort?: boolean; // Distinguish abort (barge-in) from real error
}

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

// --- State Machine Types ---

export type ErrorUXState =
  | "nominal"
  | "error_detected"
  | "user_notified"
  | "auto_recovering"
  | "awaiting_user"
  | "recovery_timeout"
  | "escalated";

export type ErrorUXEvent =
  | { type: "error_occurred"; error: PipelineError }
  | { type: "recovery_succeeded" }
  | { type: "recovery_failed"; reason: string }
  | { type: "recovery_timed_out" }
  | { type: "user_action"; action: "retry" | "reauthenticate" | "dismiss" }
  | { type: "escalation_acknowledged" }
  | { type: "reset" };

export type Effect =
  | { type: "show_message"; category: UserErrorCategory; message: string }
  | { type: "start_recovery"; recovery: RecoveryType }
  | { type: "start_recovery_timer"; timeout: number }
  | { type: "cancel_recovery_timer" }
  | { type: "escalate"; originalCategory: UserErrorCategory; reason: string }
  | { type: "return_to_pipeline" }
  | { type: "log"; message: string }
  | { type: "noop_abort" }; // Abort is not an error — suppress

export interface ErrorUXContext {
  currentCategory: UserErrorCategory | null;
  recoveryAttempts: number;
  maxRecoveryAttempts: number;
  recoveryTimeoutMs: number;
  lastError: PipelineError | null;
}

export interface TransitionResult {
  state: ErrorUXState;
  context: ErrorUXContext;
  effects: Effect[];
}

// --- Processing Timer Types ---

export type ProcessingStage = "silent" | "thinking" | "still_thinking" | "taking_long" | "timeout";

export interface ProcessingEvent {
  stage: ProcessingStage;
  elapsed: number;
  message: string | null;
}

export const STAGE_THRESHOLDS: Array<{ at: number; stage: ProcessingStage; message: string | null }> = [
  { at: 0,     stage: "silent",         message: null },
  { at: 2000,  stage: "thinking",       message: "Thinking..." },
  { at: 5000,  stage: "still_thinking", message: "Still thinking..." },
  { at: 15000, stage: "taking_long",    message: "Taking longer than usual..." },
  { at: 30000, stage: "timeout",        message: "Sorry, I'm having trouble. Could you try again?" },
];

// --- Pure Functions ---

export function inferSeverity(source: ErrorSource, phase: ErrorPhase): ErrorSeverity {
  if (source === "auth") return "fatal";
  if (source === "network" && phase === "idle") return "recoverable";
  if (source === "network") return "degraded";
  if (phase === "connecting") return "recoverable";
  if (phase === "streaming") return "degraded";
  return "recoverable";
}

export function pipelineError(
  source: ErrorSource,
  phase: ErrorPhase,
  message: string,
  opts?: { originalError?: unknown; isAbort?: boolean }
): PipelineError {
  return {
    source,
    phase,
    severity: inferSeverity(source, phase),
    message,
    originalError: opts?.originalError,
    isAbort: opts?.isAbort ?? false,
  };
}

export function classifyError(error: PipelineError): UserErrorCategory {
  if (error.source === "auth") return "auth_required";
  if (error.source === "network") return "connection_lost";
  if (error.source === "stt") return "didnt_catch";
  if (error.source === "llm" && error.phase === "streaming") return "thinking_timeout";
  if (error.source === "llm" && error.phase === "connecting") return "service_unavailable";
  if (error.source === "tts") return "try_again";
  if (error.source === "protocol") return "try_again";
  return "try_again";
}

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

// --- State Machine ---

const DEFAULT_CONTEXT: ErrorUXContext = {
  currentCategory: null,
  recoveryAttempts: 0,
  maxRecoveryAttempts: 2,
  recoveryTimeoutMs: 10_000,
  lastError: null,
};

export function initialState(): TransitionResult {
  return { state: "nominal", context: { ...DEFAULT_CONTEXT }, effects: [] };
}

export function transition(
  state: ErrorUXState,
  context: ErrorUXContext,
  event: ErrorUXEvent
): TransitionResult {
  // Global: aborts are never errors
  if (event.type === "error_occurred" && event.error.isAbort) {
    return {
      state,
      context,
      effects: [{ type: "noop_abort" }],
    };
  }

  switch (state) {
    case "nominal":        return fromNominal(context, event);
    case "error_detected": return fromErrorDetected(context, event);
    case "user_notified":  return fromUserNotified(context, event);
    case "auto_recovering": return fromAutoRecovering(context, event);
    case "awaiting_user":  return fromAwaitingUser(context, event);
    case "recovery_timeout": return fromRecoveryTimeout(context, event);
    case "escalated":      return fromEscalated(context, event);
  }
}

function enterRecovery(ctx: ErrorUXContext, error: PipelineError): TransitionResult {
  const category = classifyError(error);
  const recovery = resolveRecovery(category);
  const msg = userMessage(category);
  const timeout = recoveryTimeout(recovery);
  const newCtx: ErrorUXContext = {
    ...ctx,
    currentCategory: category,
    recoveryAttempts: 0,
    recoveryTimeoutMs: timeout,
    lastError: error,
  };

  if (isAutoRecoverable(recovery)) {
    return {
      state: "auto_recovering",
      context: newCtx,
      effects: [
        { type: "show_message", category, message: msg },
        { type: "start_recovery", recovery },
        { type: "start_recovery_timer", timeout },
      ],
    };
  }

  return {
    state: "awaiting_user",
    context: newCtx,
    effects: [{ type: "show_message", category, message: msg }],
  };
}

function fromNominal(ctx: ErrorUXContext, event: ErrorUXEvent): TransitionResult {
  if (event.type === "error_occurred") {
    return enterRecovery(ctx, event.error);
  }
  return { state: "nominal", context: ctx, effects: [] };
}

function fromErrorDetected(ctx: ErrorUXContext, event: ErrorUXEvent): TransitionResult {
  if (event.type === "reset") return initialState();
  return { state: "error_detected", context: ctx, effects: [{ type: "log", message: `Unexpected ${event.type} in error_detected` }] };
}

function fromUserNotified(ctx: ErrorUXContext, event: ErrorUXEvent): TransitionResult {
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
  if (event.type === "reset") return initialState();
  return { state: "user_notified", context: ctx, effects: [] };
}

function fromAutoRecovering(ctx: ErrorUXContext, event: ErrorUXEvent): TransitionResult {
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

  // New error during recovery — restart classification
  if (event.type === "error_occurred") {
    const result = enterRecovery(ctx, event.error);
    return {
      ...result,
      effects: [{ type: "cancel_recovery_timer" }, ...result.effects],
    };
  }

  if (event.type === "reset") {
    return { state: "nominal", context: { ...DEFAULT_CONTEXT }, effects: [{ type: "cancel_recovery_timer" }] };
  }

  return { state: "auto_recovering", context: ctx, effects: [] };
}

function fromAwaitingUser(ctx: ErrorUXContext, event: ErrorUXEvent): TransitionResult {
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
    if (event.action === "reauthenticate" || event.action === "dismiss") {
      return { state: "nominal", context: { ...DEFAULT_CONTEXT }, effects: [{ type: "return_to_pipeline" }] };
    }
  }

  if (event.type === "error_occurred") {
    return enterRecovery(ctx, event.error);
  }

  if (event.type === "reset") return initialState();
  return { state: "awaiting_user", context: ctx, effects: [] };
}

function fromRecoveryTimeout(ctx: ErrorUXContext, event: ErrorUXEvent): TransitionResult {
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
  if (event.type === "reset") return initialState();
  return { state: "recovery_timeout", context: ctx, effects: [] };
}

function fromEscalated(ctx: ErrorUXContext, event: ErrorUXEvent): TransitionResult {
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
  if (event.type === "reset") return initialState();
  return { state: "escalated", context: ctx, effects: [] };
}

// --- Processing Timer (pure stage resolver) ---

export function resolveProcessingStage(elapsedMs: number): ProcessingEvent {
  let resolved = STAGE_THRESHOLDS[0];
  for (const stage of STAGE_THRESHOLDS) {
    if (elapsedMs >= stage.at) resolved = stage;
  }
  return { stage: resolved.stage, elapsed: elapsedMs, message: resolved.message };
}

// Timer with real setTimeout (for integration tests only — unit tests use resolveProcessingStage)
export function createProcessingTimer(
  onStage: (event: ProcessingEvent) => void
): { cancel: () => void } {
  const timers: ReturnType<typeof setTimeout>[] = [];
  const start = Date.now();
  for (const { at, stage, message } of STAGE_THRESHOLDS) {
    const timer = setTimeout(() => {
      onStage({ stage, elapsed: Date.now() - start, message });
    }, at);
    timers.push(timer);
  }
  return { cancel() { timers.forEach(clearTimeout); } };
}
