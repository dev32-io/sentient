import { describe, test, expect } from "bun:test";
import {
  transition,
  initialState,
  pipelineError,
  classifyError,
  resolveRecovery,
  userMessage,
  isAutoRecoverable,
  type ErrorUXEvent,
  type ErrorUXState,
  type Effect,
} from "../src/error-ux";

// Tests that replicate real codebase error scenarios from the exploration doc.
// Each test models a specific failure mode found in the Sentient voice pipeline.

function run(events: ErrorUXEvent[]) {
  let { state, context, effects } = initialState();
  const allEffects: Effect[] = [];
  for (const event of events) {
    const result = transition(state, context, event);
    state = result.state;
    context = result.context;
    effects = result.effects;
    allEffects.push(...effects);
  }
  return { state, context, effects, allEffects };
}

// --- Scenario 1: Deepgram STT drops mid-stream ---
// voice-session.ts:131-138 — readNextFinalTranscript() fails, STT connection dies mid-utterance
describe("Scenario: STT drops mid-stream (Deepgram disconnect)", () => {
  test("user hears 'I didn't catch that' and system resets to listening", () => {
    const err = pipelineError("stt", "streaming", "Deepgram WebSocket closed unexpectedly");
    const category = classifyError(err);
    expect(category).toBe("didnt_catch");

    const msg = userMessage(category);
    expect(msg.toLowerCase()).toContain("didn't catch");
    expect(msg.toLowerCase()).toContain("repeat");

    const recovery = resolveRecovery(category);
    expect(recovery).toBe("reset_to_listening");
    expect(isAutoRecoverable(recovery)).toBe(true);
  });

  test("full flow: STT drop → auto recover → listening", () => {
    const { state } = run([
      { type: "error_occurred", error: pipelineError("stt", "streaming", "ws closed") },
      { type: "recovery_succeeded" },
    ]);
    expect(state).toBe("nominal");
  });
});

// --- Scenario 2: LLM hangs (no timeout in openrouter.ts:30-47) ---
// The exploration doc flagged this: LLM stream() blocks forever, no AbortSignal timeout
describe("Scenario: LLM hangs indefinitely (missing timeout)", () => {
  test("processing timer would fire timeout → thinking_timeout", () => {
    const err = pipelineError("llm", "streaming", "stream() blocked — no response after 30s");
    const category = classifyError(err);
    expect(category).toBe("thinking_timeout");

    const msg = userMessage(category);
    expect(msg.toLowerCase()).not.toContain("llm");
    expect(msg.toLowerCase()).not.toContain("openrouter");
  });

  test("LLM timeout → retry_once → success recovers gracefully", () => {
    const { state } = run([
      { type: "error_occurred", error: pipelineError("llm", "streaming", "timeout") },
      { type: "recovery_succeeded" },
    ]);
    expect(state).toBe("nominal");
  });

  test("LLM timeout → retry_once → fail again → escalated", () => {
    const { state } = run([
      { type: "error_occurred", error: pipelineError("llm", "streaming", "timeout") },
      { type: "recovery_failed", reason: "still hanging" },
      { type: "recovery_failed", reason: "still hanging" },
      { type: "recovery_failed", reason: "still hanging" },
    ]);
    expect(state).toBe("escalated");
  });
});

// --- Scenario 3: TTS drops mid-synthesis (Fish Audio disconnects) ---
// User hears half a word then silence
describe("Scenario: TTS drops mid-synthesis", () => {
  test("classified as try_again — text may still be available", () => {
    const err = pipelineError("tts", "streaming", "Fish Audio WebSocket closed mid-sentence");
    expect(classifyError(err)).toBe("try_again");
  });

  test("TTS error goes to awaiting_user (prompt_retry is not auto-recoverable)", () => {
    const result = transition("nominal", initialState().context, {
      type: "error_occurred",
      error: pipelineError("tts", "streaming", "tts dropped"),
    });
    expect(result.state).toBe("awaiting_user");
  });
});

// --- Scenario 4: WebSocket close mid-turn ---
// use-websocket.ts:81-83 — pong timeout → close 4000
describe("Scenario: WebSocket drops (ping/pong timeout)", () => {
  test("network error → connection_lost → auto_reconnect", () => {
    const err = pipelineError("network", "streaming", "pong timeout — ws closed with code 4000");
    expect(classifyError(err)).toBe("connection_lost");
    expect(resolveRecovery("connection_lost")).toBe("auto_reconnect");
  });

  test("reconnect succeeds → nominal", () => {
    const { state } = run([
      { type: "error_occurred", error: pipelineError("network", "streaming", "ws closed") },
      { type: "recovery_succeeded" },
    ]);
    expect(state).toBe("nominal");
  });

  test("reconnect fails repeatedly → escalated", () => {
    const { state } = run([
      { type: "error_occurred", error: pipelineError("network", "streaming", "ws closed") },
      { type: "recovery_failed", reason: "still no pong" },
      { type: "recovery_failed", reason: "still no pong" },
      { type: "recovery_failed", reason: "still no pong" },
    ]);
    expect(state).toBe("escalated");
  });
});

// --- Scenario 5: Auth token expired mid-session ---
// paseto.ts:verifyToken() returns Result<T> error
describe("Scenario: Auth token expired", () => {
  test("auth_required → awaiting_user (requires reauthentication)", () => {
    const err = pipelineError("auth", "idle", "Token expired");
    expect(classifyError(err)).toBe("auth_required");
    expect(isAutoRecoverable(resolveRecovery("auth_required"))).toBe(false);

    const result = transition("nominal", initialState().context, {
      type: "error_occurred", error: err,
    });
    expect(result.state).toBe("awaiting_user");
  });

  test("user re-authenticates → nominal", () => {
    const { state } = run([
      { type: "error_occurred", error: pipelineError("auth", "connecting", "bad token") },
      { type: "user_action", action: "reauthenticate" },
    ]);
    expect(state).toBe("nominal");
  });
});

// --- Scenario 6: Double error — STT fails, then reconnect also fails ---
// Exploration doc: "Current code shows two separate error messages"
describe("Scenario: Double error (cascading failures)", () => {
  test("STT fails → during recovery, network also fails → context replaced", () => {
    const { state, context, allEffects } = run([
      { type: "error_occurred", error: pipelineError("stt", "streaming", "stt dropped") },
      // During STT recovery, network fails too
      { type: "error_occurred", error: pipelineError("network", "streaming", "ws closed") },
    ]);
    // Network error replaces STT error
    expect(context.currentCategory).toBe("connection_lost");
    expect(state).toBe("auto_recovering");

    // Verify exactly 2 show_message effects (one per error)
    const messages = allEffects.filter(e => e.type === "show_message");
    expect(messages.length).toBe(2);
  });

  test("network fail → during recovery, auth expires → goes to awaiting_user", () => {
    const { state, context } = run([
      { type: "error_occurred", error: pipelineError("network", "streaming", "ws down") },
      { type: "error_occurred", error: pipelineError("auth", "idle", "token expired") },
    ]);
    expect(state).toBe("awaiting_user");
    expect(context.currentCategory).toBe("auth_required");
  });
});

// --- Scenario 7: Barge-in abort vs real error ---
// voice-handlers.ts:50 — signal.aborted check before sending stt_error
describe("Scenario: Barge-in (abort) vs real error", () => {
  test("abort during STT is NOT an error — state unchanged", () => {
    const abortErr = pipelineError("stt", "streaming", "aborted by barge-in", { isAbort: true });
    const result = transition("nominal", initialState().context, {
      type: "error_occurred", error: abortErr,
    });
    expect(result.state).toBe("nominal");
    expect(result.effects.some(e => e.type === "show_message")).toBe(false);
  });

  test("real STT error right after abort IS handled", () => {
    const abortErr = pipelineError("stt", "streaming", "barge-in", { isAbort: true });
    const r1 = transition("nominal", initialState().context, {
      type: "error_occurred", error: abortErr,
    });

    const realErr = pipelineError("stt", "streaming", "connection lost");
    const r2 = transition(r1.state, r1.context, {
      type: "error_occurred", error: realErr,
    });
    expect(r2.state).toBe("auto_recovering");
    expect(r2.effects.some(e => e.type === "show_message")).toBe(true);
  });
});

// --- Scenario 8: Error code mismatch ---
// errors.ts schema vs voice-handlers.ts actual codes — sendError("stt_error") not in ERROR_TYPES
describe("Scenario: Arbitrary error codes from gateway", () => {
  test("any protocol error maps to try_again — never crashes", () => {
    const err = pipelineError("protocol", "idle", "unknown_code_from_gateway");
    expect(classifyError(err)).toBe("try_again");
    expect(userMessage("try_again")).toBeDefined();
  });
});

// --- Scenario 9: JSON parse failure in use-websocket.ts:112 ---
// Currently silently swallowed — should surface as protocol error
describe("Scenario: Malformed message from gateway", () => {
  test("protocol error during streaming → try_again", () => {
    const err = pipelineError("protocol", "streaming", "JSON parse failed");
    expect(classifyError(err)).toBe("try_again");
  });

  test("user sees friendly message, not 'JSON parse error'", () => {
    const msg = userMessage("try_again");
    expect(msg.toLowerCase()).not.toContain("json");
    expect(msg.toLowerCase()).not.toContain("parse");
  });
});

// --- Scenario 10: Early audio buffer leak ---
// voice-session.ts:50 — connectPromise fails, audio buffer orphaned
describe("Scenario: Provider connection fails during setup", () => {
  test("STT connect failure → didnt_catch → reset_to_listening", () => {
    const err = pipelineError("stt", "connecting", "connectPromise rejected");
    expect(classifyError(err)).toBe("didnt_catch");
  });

  test("TTS connect failure → try_again", () => {
    const err = pipelineError("tts", "connecting", "Fish Audio connect timeout");
    expect(classifyError(err)).toBe("try_again");
  });

  test("LLM connect failure → service_unavailable → awaiting_user", () => {
    const err = pipelineError("llm", "connecting", "OpenRouter 502");
    expect(classifyError(err)).toBe("service_unavailable");

    const result = transition("nominal", initialState().context, {
      type: "error_occurred", error: err,
    });
    expect(result.state).toBe("awaiting_user");
  });
});
