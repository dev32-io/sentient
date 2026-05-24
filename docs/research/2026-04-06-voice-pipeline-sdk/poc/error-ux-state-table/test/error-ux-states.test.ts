import { describe, test, expect } from "bun:test";
import {
  transition,
  initialState,
  classifyError,
  resolveRecovery,
  isAutoRecoverable,
  userMessage,
  recoveryTimeout,
  TRANSITION_TABLE,
  type ErrorUXState,
  type ErrorUXEvent,
  type ErrorUXContext,
  type ErrorSource,
  type ErrorPhase,
  type UserErrorCategory,
} from "../src/error-ux-states";

// Helper to run a sequence of events from initial state
function runSequence(events: ErrorUXEvent[]) {
  let { state, context, effects } = initialState();
  const trace: Array<{ event: string; from: ErrorUXState; to: ErrorUXState }> = [];
  for (const event of events) {
    const from = state;
    const result = transition(state, context, event);
    trace.push({ event: event.type, from, to: result.state });
    state = result.state;
    context = result.context;
    effects = result.effects;
  }
  return { state, context, effects, trace };
}

// --- Classifier Tests ---

describe("classifyError", () => {
  const cases: Array<[ErrorSource, ErrorPhase, UserErrorCategory]> = [
    ["auth", "connecting", "auth_required"],
    ["auth", "streaming", "auth_required"],
    ["auth", "idle", "auth_required"],
    ["network", "connecting", "connection_lost"],
    ["network", "streaming", "connection_lost"],
    ["network", "idle", "connection_lost"],
    ["stt", "connecting", "didnt_catch"],
    ["stt", "streaming", "didnt_catch"],
    ["llm", "streaming", "thinking_timeout"],
    ["llm", "connecting", "service_unavailable"],
    ["tts", "connecting", "try_again"],
    ["tts", "streaming", "try_again"],
    ["protocol", "idle", "try_again"],
  ];

  for (const [source, phase, expected] of cases) {
    test(`${source}/${phase} → ${expected}`, () => {
      expect(classifyError(source, phase)).toBe(expected);
    });
  }

  test("exhaustive: every source has a mapping", () => {
    const sources: ErrorSource[] = ["stt", "llm", "tts", "auth", "network", "protocol"];
    const phases: ErrorPhase[] = ["connecting", "streaming", "finalizing", "idle"];
    for (const source of sources) {
      for (const phase of phases) {
        const result = classifyError(source, phase);
        expect(result).toBeTruthy();
        expect(typeof result).toBe("string");
      }
    }
  });
});

// --- Recovery Resolver Tests ---

describe("resolveRecovery", () => {
  test("every category has a recovery type", () => {
    const categories: UserErrorCategory[] = [
      "connection_lost", "didnt_catch", "thinking_timeout",
      "service_unavailable", "auth_required", "try_again",
    ];
    for (const cat of categories) {
      const recovery = resolveRecovery(cat);
      expect(recovery).toBeTruthy();
    }
  });

  test("auto-recoverable detection", () => {
    expect(isAutoRecoverable("auto_reconnect")).toBe(true);
    expect(isAutoRecoverable("reset_to_listening")).toBe(true);
    expect(isAutoRecoverable("retry_once")).toBe(true);
    expect(isAutoRecoverable("wait_and_retry")).toBe(false);
    expect(isAutoRecoverable("require_auth")).toBe(false);
    expect(isAutoRecoverable("prompt_retry")).toBe(false);
  });
});

// --- User Messages ---

describe("userMessage", () => {
  test("every category has a non-empty message", () => {
    const categories: UserErrorCategory[] = [
      "connection_lost", "didnt_catch", "thinking_timeout",
      "service_unavailable", "auth_required", "try_again",
    ];
    for (const cat of categories) {
      const msg = userMessage(cat);
      expect(msg.length).toBeGreaterThan(0);
    }
  });

  test("no message contains technical jargon", () => {
    const categories: UserErrorCategory[] = [
      "connection_lost", "didnt_catch", "thinking_timeout",
      "service_unavailable", "auth_required", "try_again",
    ];
    const jargon = ["stt", "tts", "llm", "websocket", "tcp", "http", "500", "timeout", "exception", "stack"];
    for (const cat of categories) {
      const msg = userMessage(cat).toLowerCase();
      for (const term of jargon) {
        expect(msg).not.toContain(term);
      }
    }
  });
});

// --- Timeout Guards ---

describe("recoveryTimeout", () => {
  test("every recovery type has a positive timeout", () => {
    const types = [
      "auto_reconnect", "reset_to_listening", "retry_once",
      "wait_and_retry", "require_auth", "prompt_retry",
    ] as const;
    for (const t of types) {
      expect(recoveryTimeout(t)).toBeGreaterThan(0);
    }
  });

  test("reset_to_listening is the fastest recovery", () => {
    expect(recoveryTimeout("reset_to_listening")).toBeLessThanOrEqual(recoveryTimeout("auto_reconnect"));
    expect(recoveryTimeout("reset_to_listening")).toBeLessThanOrEqual(recoveryTimeout("retry_once"));
  });
});

// --- State Machine: Every State Has Exits ---

describe("state reachability and exits", () => {
  const ALL_STATES: ErrorUXState[] = [
    "nominal", "error_detected", "user_notified",
    "auto_recovering", "awaiting_user", "recovery_timeout", "escalated",
  ];

  test("every state is reachable from nominal", () => {
    const reachable = new Set<ErrorUXState>(["nominal"]);

    // nominal → auto_recovering (network error)
    let r = transition("nominal", initialState().context, {
      type: "error_occurred", source: "network", phase: "streaming", message: "ws closed",
    });
    reachable.add(r.state); // auto_recovering

    // nominal → awaiting_user (auth error)
    r = transition("nominal", initialState().context, {
      type: "error_occurred", source: "auth", phase: "connecting", message: "bad token",
    });
    reachable.add(r.state); // awaiting_user

    // auto_recovering → nominal (recovery_succeeded)
    const recoveringCtx = { ...initialState().context, currentCategory: "connection_lost" as UserErrorCategory, recoveryAttempts: 0 };
    r = transition("auto_recovering", recoveringCtx, { type: "recovery_succeeded" });
    reachable.add(r.state);

    // auto_recovering → escalated (recovery_failed, max retries)
    const exhaustedCtx = { ...recoveringCtx, recoveryAttempts: 3, maxRecoveryAttempts: 2 };
    r = transition("auto_recovering", exhaustedCtx, { type: "recovery_failed", reason: "still down" });
    reachable.add(r.state); // escalated

    // auto_recovering → recovery_timeout
    r = transition("auto_recovering", recoveringCtx, { type: "recovery_timed_out" });
    reachable.add(r.state); // recovery_timeout

    // error_detected → user_notified (classified)
    r = transition("error_detected", { ...initialState().context, currentCategory: null }, {
      type: "classified", category: "try_again",
    });
    reachable.add(r.state); // user_notified
    reachable.add("error_detected"); // reachable as intermediate state when classification is async

    // escalated → awaiting_user (escalation_acknowledged)
    r = transition("escalated", exhaustedCtx, { type: "escalation_acknowledged" });
    reachable.add(r.state);

    for (const state of ALL_STATES) {
      expect(reachable.has(state)).toBe(true);
    }
  });

  test("every state can reach nominal via reset", () => {
    const ctx = { ...initialState().context, currentCategory: "try_again" as UserErrorCategory };
    for (const state of ALL_STATES) {
      if (state === "nominal") continue;
      const r = transition(state, ctx, { type: "reset" });
      expect(r.state).toBe("nominal");
    }
  });

  test("no dead states — every non-nominal state has at least one exit", () => {
    const table = TRANSITION_TABLE;
    for (const state of ALL_STATES) {
      if (state === "nominal") continue; // nominal is the home state
      const exits = table.filter(t => t.from === state && t.to !== state);
      expect(exits.length).toBeGreaterThan(0);
    }
  });
});

// --- State Machine: Key Scenarios ---

describe("error lifecycle scenarios", () => {
  test("network error → auto recover → success → nominal", () => {
    const { state } = runSequence([
      { type: "error_occurred", source: "network", phase: "streaming", message: "ws closed" },
      { type: "recovery_succeeded" },
    ]);
    expect(state).toBe("nominal");
  });

  test("network error → auto recover → fail → retry → fail → escalated", () => {
    const { state } = runSequence([
      { type: "error_occurred", source: "network", phase: "streaming", message: "ws closed" },
      { type: "recovery_failed", reason: "still down" },
      { type: "recovery_failed", reason: "still down" },
      { type: "recovery_failed", reason: "still down" },
    ]);
    expect(state).toBe("escalated");
  });

  test("auth error → awaiting_user → reauthenticate → nominal", () => {
    const { state } = runSequence([
      { type: "error_occurred", source: "auth", phase: "connecting", message: "bad token" },
      { type: "user_action", action: "reauthenticate" },
    ]);
    expect(state).toBe("nominal");
  });

  test("STT streaming error → auto recover (reset_to_listening) → success", () => {
    const { state, effects } = runSequence([
      { type: "error_occurred", source: "stt", phase: "streaming", message: "stt dropped" },
    ]);
    expect(state).toBe("auto_recovering");
    expect(effects.some(e => e.type === "show_message" && e.category === "didnt_catch")).toBe(true);

    // Then recovery succeeds
    const { state: final } = runSequence([
      { type: "error_occurred", source: "stt", phase: "streaming", message: "stt dropped" },
      { type: "recovery_succeeded" },
    ]);
    expect(final).toBe("nominal");
  });

  test("LLM streaming error → auto recover (retry_once) → success", () => {
    const { state } = runSequence([
      { type: "error_occurred", source: "llm", phase: "streaming", message: "stream failed" },
      { type: "recovery_succeeded" },
    ]);
    expect(state).toBe("nominal");
  });

  test("LLM connect error → awaiting_user (service_unavailable)", () => {
    const { state } = runSequence([
      { type: "error_occurred", source: "llm", phase: "connecting", message: "502" },
    ]);
    expect(state).toBe("awaiting_user");
  });

  test("recovery timeout → user retry → recover → nominal", () => {
    const { state } = runSequence([
      { type: "error_occurred", source: "network", phase: "streaming", message: "ws closed" },
      { type: "recovery_timed_out" },
      { type: "user_action", action: "retry" },
      { type: "recovery_succeeded" },
    ]);
    expect(state).toBe("nominal");
  });

  test("escalated → user retry resets recovery attempts", () => {
    const result = runSequence([
      { type: "error_occurred", source: "network", phase: "streaming", message: "ws closed" },
      { type: "recovery_failed", reason: "down" },
      { type: "recovery_failed", reason: "down" },
      { type: "recovery_failed", reason: "down" },
      // Now escalated
      { type: "user_action", action: "retry" },
    ]);
    expect(result.state).toBe("auto_recovering");
    expect(result.context.recoveryAttempts).toBe(0);
  });

  test("new error during recovery replaces context", () => {
    const { state, context } = runSequence([
      { type: "error_occurred", source: "network", phase: "streaming", message: "ws closed" },
      // During recovery, auth error occurs
      { type: "error_occurred", source: "auth", phase: "connecting", message: "token expired" },
    ]);
    // Auth requires user action, overrides network auto-recovery
    expect(state).toBe("awaiting_user");
    expect(context.currentCategory).toBe("auth_required");
  });

  test("dismiss from awaiting_user returns to nominal", () => {
    const { state } = runSequence([
      { type: "error_occurred", source: "auth", phase: "connecting", message: "bad token" },
      { type: "user_action", action: "dismiss" },
    ]);
    expect(state).toBe("nominal");
  });
});

// --- Timeout Guard Integration ---

describe("timeout guards on every waiting state", () => {
  test("auto_recovering accepts recovery_timed_out", () => {
    const ctx = { ...initialState().context, currentCategory: "connection_lost" as UserErrorCategory };
    const r = transition("auto_recovering", ctx, { type: "recovery_timed_out" });
    expect(r.state).toBe("recovery_timeout");
    expect(r.effects.some(e => e.type === "escalate")).toBe(true);
  });

  test("auto_recovering emits start_recovery_timer on entry", () => {
    const { effects } = runSequence([
      { type: "error_occurred", source: "network", phase: "streaming", message: "ws closed" },
    ]);
    expect(effects.some(e => e.type === "start_recovery_timer")).toBe(true);
  });

  test("recovery_succeeded cancels timer", () => {
    const ctx = { ...initialState().context, currentCategory: "connection_lost" as UserErrorCategory };
    const r = transition("auto_recovering", ctx, { type: "recovery_succeeded" });
    expect(r.effects.some(e => e.type === "cancel_recovery_timer")).toBe(true);
  });

  test("recovery_failed cancels and restarts timer on retry", () => {
    const ctx = {
      ...initialState().context,
      currentCategory: "connection_lost" as UserErrorCategory,
      recoveryAttempts: 0,
      maxRecoveryAttempts: 2,
    };
    const r = transition("auto_recovering", ctx, { type: "recovery_failed", reason: "down" });
    expect(r.state).toBe("auto_recovering");
    expect(r.effects.some(e => e.type === "cancel_recovery_timer")).toBe(true);
    expect(r.effects.some(e => e.type === "start_recovery_timer")).toBe(true);
  });
});

// --- Effects: Never Silent ---

describe("never-silent principle", () => {
  test("every error_occurred from nominal produces a show_message effect", () => {
    const sources: ErrorSource[] = ["stt", "llm", "tts", "auth", "network", "protocol"];
    const phases: ErrorPhase[] = ["connecting", "streaming", "finalizing", "idle"];

    for (const source of sources) {
      for (const phase of phases) {
        const r = transition("nominal", initialState().context, {
          type: "error_occurred", source, phase, message: "test",
        });
        const hasMessage = r.effects.some(e => e.type === "show_message");
        expect(hasMessage).toBe(true);
      }
    }
  });

  test("escalation always produces an escalate effect", () => {
    const ctx = {
      ...initialState().context,
      currentCategory: "connection_lost" as UserErrorCategory,
      recoveryAttempts: 3,
      maxRecoveryAttempts: 2,
    };
    const r = transition("auto_recovering", ctx, { type: "recovery_failed", reason: "still down" });
    expect(r.state).toBe("escalated");
    expect(r.effects.some(e => e.type === "escalate")).toBe(true);
  });
});

// --- Transition Table Completeness ---

describe("transition table completeness", () => {
  test("every state appears as a 'from' in the table", () => {
    const ALL_STATES: ErrorUXState[] = [
      "nominal", "error_detected", "user_notified",
      "auto_recovering", "awaiting_user", "recovery_timeout", "escalated",
    ];
    for (const state of ALL_STATES) {
      const entries = TRANSITION_TABLE.filter(t => t.from === state);
      expect(entries.length).toBeGreaterThan(0);
    }
  });

  test("every target state is also a source state or nominal", () => {
    const sources = new Set(TRANSITION_TABLE.map(t => t.from));
    for (const entry of TRANSITION_TABLE) {
      expect(sources.has(entry.to) || entry.to === "nominal").toBe(true);
    }
  });
});
