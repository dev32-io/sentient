import { describe, test, expect } from "bun:test";
import {
  transition,
  initialState,
  pipelineError,
  classifyError,
  isAutoRecoverable,
  resolveRecovery,
  type ErrorUXState,
  type ErrorUXEvent,
  type ErrorUXContext,
  type UserErrorCategory,
  type Effect,
} from "../src/error-ux";

// --- Test Helpers ---

function run(events: ErrorUXEvent[]) {
  let { state, context, effects } = initialState();
  const trace: Array<{ event: string; from: ErrorUXState; to: ErrorUXState; effects: Effect[] }> = [];
  for (const event of events) {
    const from = state;
    const result = transition(state, context, event);
    trace.push({ event: event.type, from, to: result.state, effects: result.effects });
    state = result.state;
    context = result.context;
    effects = result.effects;
  }
  return { state, context, effects, trace };
}

function err(source: "stt" | "llm" | "tts" | "auth" | "network" | "protocol", phase: "connecting" | "streaming" | "finalizing" | "idle" = "streaming"): ErrorUXEvent {
  return { type: "error_occurred", error: pipelineError(source, phase, `${source} ${phase} error`) };
}

// --- Abort vs Error ---

describe("abort vs error distinction", () => {
  test("abort event is suppressed — state unchanged, noop_abort effect", () => {
    const { state: s } = initialState();
    const abortError = pipelineError("stt", "streaming", "barge-in", { isAbort: true });
    const result = transition(s, initialState().context, { type: "error_occurred", error: abortError });
    expect(result.state).toBe("nominal");
    expect(result.effects).toEqual([{ type: "noop_abort" }]);
  });

  test("abort during auto_recovering does not change state", () => {
    const { state, context } = run([err("network")]);
    expect(state).toBe("auto_recovering");

    const abortError = pipelineError("stt", "streaming", "barge-in", { isAbort: true });
    const result = transition(state, context, { type: "error_occurred", error: abortError });
    expect(result.state).toBe("auto_recovering");
    expect(result.effects).toEqual([{ type: "noop_abort" }]);
  });

  test("real error after abort is handled normally", () => {
    const abortError = pipelineError("stt", "streaming", "barge-in", { isAbort: true });
    const result1 = transition("nominal", initialState().context, { type: "error_occurred", error: abortError });
    expect(result1.state).toBe("nominal");

    const result2 = transition(result1.state, result1.context, err("stt"));
    expect(result2.state).toBe("auto_recovering");
  });
});

// --- Never Silent Principle ---

describe("never silent — every error produces user feedback", () => {
  const SOURCES = ["stt", "llm", "tts", "auth", "network", "protocol"] as const;
  const PHASES = ["connecting", "streaming", "finalizing", "idle"] as const;

  for (const source of SOURCES) {
    for (const phase of PHASES) {
      test(`${source}/${phase} from nominal → show_message effect`, () => {
        const result = transition("nominal", initialState().context, err(source, phase));
        const hasMsg = result.effects.some(e => e.type === "show_message");
        expect(hasMsg).toBe(true);
      });
    }
  }

  test("escalation always produces escalate effect", () => {
    const { state, context } = run([
      err("network"),
      { type: "recovery_failed", reason: "down" },
      { type: "recovery_failed", reason: "down" },
      { type: "recovery_failed", reason: "down" },
    ]);
    expect(state).toBe("escalated");
    // Check the last transition's effects
    const lastResult = transition(
      "auto_recovering",
      { ...context, recoveryAttempts: 3, maxRecoveryAttempts: 2, currentCategory: "connection_lost" },
      { type: "recovery_failed", reason: "down" }
    );
    expect(lastResult.effects.some(e => e.type === "escalate")).toBe(true);
  });

  test("recovery timeout produces escalate effect", () => {
    const { state, context } = run([err("network")]);
    const result = transition(state, context, { type: "recovery_timed_out" });
    expect(result.state).toBe("recovery_timeout");
    expect(result.effects.some(e => e.type === "escalate")).toBe(true);
  });
});

// --- Complete Lifecycle Scenarios ---

describe("full lifecycle scenarios", () => {
  test("happy recovery: network error → auto reconnect → success → nominal", () => {
    const { state, effects } = run([
      err("network"),
      { type: "recovery_succeeded" },
    ]);
    expect(state).toBe("nominal");
    expect(effects.some(e => e.type === "return_to_pipeline")).toBe(true);
  });

  test("STT mid-stream drop → didnt_catch → reset_to_listening → success", () => {
    const r1 = run([err("stt", "streaming")]);
    expect(r1.state).toBe("auto_recovering");
    expect(r1.effects.some(e =>
      e.type === "show_message" && e.category === "didnt_catch"
    )).toBe(true);
    expect(r1.effects.some(e =>
      e.type === "start_recovery" && e.recovery === "reset_to_listening"
    )).toBe(true);

    const { state } = run([
      err("stt", "streaming"),
      { type: "recovery_succeeded" },
    ]);
    expect(state).toBe("nominal");
  });

  test("LLM streaming timeout → retry_once → success", () => {
    const r = run([err("llm", "streaming")]);
    expect(r.state).toBe("auto_recovering");
    expect(r.effects.some(e =>
      e.type === "start_recovery" && e.recovery === "retry_once"
    )).toBe(true);

    const { state } = run([
      err("llm", "streaming"),
      { type: "recovery_succeeded" },
    ]);
    expect(state).toBe("nominal");
  });

  test("LLM connect error → service_unavailable → awaiting_user → user retry", () => {
    const r = run([err("llm", "connecting")]);
    expect(r.state).toBe("awaiting_user");
    expect(r.effects.some(e =>
      e.type === "show_message" && e.category === "service_unavailable"
    )).toBe(true);

    const { state } = run([
      err("llm", "connecting"),
      { type: "user_action", action: "retry" },
      { type: "recovery_succeeded" },
    ]);
    expect(state).toBe("nominal");
  });

  test("auth error → awaiting_user → reauthenticate → nominal", () => {
    const { state } = run([
      err("auth", "connecting"),
      { type: "user_action", action: "reauthenticate" },
    ]);
    expect(state).toBe("nominal");
  });

  test("TTS error → prompt_retry (awaiting_user) → user dismiss → nominal", () => {
    const r = run([err("tts", "streaming")]);
    expect(r.state).toBe("awaiting_user");

    const { state } = run([
      err("tts", "streaming"),
      { type: "user_action", action: "dismiss" },
    ]);
    expect(state).toBe("nominal");
  });

  test("exhausted retries → escalated → user retry resets attempts", () => {
    const { state, context } = run([
      err("network"),
      { type: "recovery_failed", reason: "down" },
      { type: "recovery_failed", reason: "down" },
      { type: "recovery_failed", reason: "down" },
      { type: "user_action", action: "retry" },
    ]);
    expect(state).toBe("auto_recovering");
    expect(context.recoveryAttempts).toBe(0);
  });

  test("recovery timeout → user retry → success → nominal", () => {
    const { state } = run([
      err("network"),
      { type: "recovery_timed_out" },
      { type: "user_action", action: "retry" },
      { type: "recovery_succeeded" },
    ]);
    expect(state).toBe("nominal");
  });

  test("escalated → acknowledged → awaiting_user → dismiss → nominal", () => {
    const { state } = run([
      err("network"),
      { type: "recovery_failed", reason: "down" },
      { type: "recovery_failed", reason: "down" },
      { type: "recovery_failed", reason: "down" },
      { type: "escalation_acknowledged" },
      { type: "user_action", action: "dismiss" },
    ]);
    expect(state).toBe("nominal");
  });
});

// --- Edge Cases ---

describe("edge cases", () => {
  test("new error during recovery replaces context and restarts", () => {
    const { state, context } = run([
      err("network"),                       // → auto_recovering (connection_lost)
      err("auth", "connecting"),            // new error during recovery
    ]);
    expect(state).toBe("awaiting_user");
    expect(context.currentCategory).toBe("auth_required");
  });

  test("new auto-recoverable error during recovery restarts recovery", () => {
    const { state, context } = run([
      err("network"),                       // → auto_recovering (connection_lost)
      err("stt", "streaming"),              // → auto_recovering (didnt_catch, reset)
    ]);
    expect(state).toBe("auto_recovering");
    expect(context.currentCategory).toBe("didnt_catch");
    expect(context.recoveryAttempts).toBe(0);
  });

  test("double error — same type — resets recovery attempts", () => {
    const { state, context } = run([
      err("network"),
      { type: "recovery_failed", reason: "down" },
      err("network"), // new error resets
    ]);
    expect(state).toBe("auto_recovering");
    expect(context.recoveryAttempts).toBe(0);
  });

  test("rapid successive errors — last one wins", () => {
    const { context } = run([
      err("stt"),
      err("llm", "streaming"),
      err("network"),
    ]);
    expect(context.currentCategory).toBe("connection_lost");
  });

  test("error in awaiting_user replaces context", () => {
    const { state, context } = run([
      err("auth", "connecting"),  // → awaiting_user
      err("stt", "streaming"),    // → auto_recovering (didnt_catch)
    ]);
    expect(state).toBe("auto_recovering");
    expect(context.currentCategory).toBe("didnt_catch");
  });

  test("irrelevant events in nominal are ignored", () => {
    const { state } = run([
      { type: "recovery_succeeded" },
      { type: "recovery_failed", reason: "irrelevant" },
      { type: "user_action", action: "retry" },
    ]);
    expect(state).toBe("nominal");
  });

  test("reset from any state returns to nominal", () => {
    const STATES_TO_REACH: ErrorUXEvent[][] = [
      [err("network")],                                           // auto_recovering
      [err("auth", "connecting")],                                // awaiting_user
      [err("network"), { type: "recovery_timed_out" }],           // recovery_timeout
      [err("network"),
       { type: "recovery_failed", reason: "d" },
       { type: "recovery_failed", reason: "d" },
       { type: "recovery_failed", reason: "d" }],                 // escalated
    ];

    for (const events of STATES_TO_REACH) {
      const { state: before, context } = run(events);
      expect(before).not.toBe("nominal");
      const result = transition(before, context, { type: "reset" });
      expect(result.state).toBe("nominal");
    }
  });
});

// --- Timer Effects Tracking ---

describe("timer effect discipline", () => {
  test("entering auto_recovering always starts a timer", () => {
    const r = run([err("network")]);
    expect(r.state).toBe("auto_recovering");
    expect(r.effects.some(e => e.type === "start_recovery_timer")).toBe(true);
  });

  test("recovery_succeeded always cancels timer", () => {
    const { state, context } = run([err("network")]);
    const result = transition(state, context, { type: "recovery_succeeded" });
    expect(result.effects.some(e => e.type === "cancel_recovery_timer")).toBe(true);
  });

  test("recovery_failed with retry cancels old timer and starts new one", () => {
    const { state, context } = run([err("network")]);
    const result = transition(state, context, { type: "recovery_failed", reason: "down" });
    expect(result.effects.some(e => e.type === "cancel_recovery_timer")).toBe(true);
    expect(result.effects.some(e => e.type === "start_recovery_timer")).toBe(true);
  });

  test("new error during recovery cancels old timer before starting new one", () => {
    const { state, context } = run([err("network")]);
    const result = transition(state, context, err("stt"));
    const cancelIdx = result.effects.findIndex(e => e.type === "cancel_recovery_timer");
    const startIdx = result.effects.findIndex(e => e.type === "start_recovery_timer");
    expect(cancelIdx).toBeGreaterThanOrEqual(0);
    expect(startIdx).toBeGreaterThan(cancelIdx); // cancel before start
  });

  test("reset from auto_recovering cancels timer", () => {
    const { state, context } = run([err("network")]);
    const result = transition(state, context, { type: "reset" });
    expect(result.effects.some(e => e.type === "cancel_recovery_timer")).toBe(true);
  });
});

// --- Recovery Attempt Counting ---

describe("recovery attempt counting", () => {
  test("first failure increments attempts from 0 to 1", () => {
    const { state, context } = run([err("network")]);
    expect(context.recoveryAttempts).toBe(0);
    const result = transition(state, context, { type: "recovery_failed", reason: "down" });
    expect(result.context.recoveryAttempts).toBe(1);
  });

  test("retries up to maxRecoveryAttempts then escalates", () => {
    const { state } = run([
      err("network"),
      { type: "recovery_failed", reason: "d" },
      { type: "recovery_failed", reason: "d" },
      { type: "recovery_failed", reason: "d" },
    ]);
    // maxRecoveryAttempts = 2, so after 3 failures (0,1,2 attempts) it escalates
    expect(state).toBe("escalated");
  });

  test("user retry from escalated resets attempts to 0", () => {
    const { state, context } = run([
      err("network"),
      { type: "recovery_failed", reason: "d" },
      { type: "recovery_failed", reason: "d" },
      { type: "recovery_failed", reason: "d" },
      { type: "user_action", action: "retry" },
    ]);
    expect(state).toBe("auto_recovering");
    expect(context.recoveryAttempts).toBe(0);
  });
});
