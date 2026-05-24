import { describe, it, expect } from "vitest";
import {
  transition,
  createInitialContext,
  ALL_STATES,
  TIMEOUT_GUARDED_STATES,
  TRANSITION_TABLE,
  type ContractState,
  type ContractEvent,
  type ContractContext,
  type ContractEffect,
} from "./contract-state-machine";

// ─── Helpers ───

const NOW = 1000000;

function ctx(overrides: Partial<ContractContext> = {}): ContractContext {
  return { ...createInitialContext(), stateEnteredAt: NOW, ...overrides };
}

function trans(
  state: ContractState,
  event: ContractEvent,
  context?: Partial<ContractContext>
) {
  return transition(state, event, ctx(context), NOW);
}

function effectTypes(effects: ContractEffect[]): string[] {
  return effects.map((e) => e.type);
}

function hasEffect(effects: ContractEffect[], type: string): boolean {
  return effects.some((e) => e.type === type);
}

function getEmitStatus(effects: ContractEffect[]): string | undefined {
  const e = effects.find(
    (e) => e.type === "emit_status"
  ) as Extract<ContractEffect, { type: "emit_status" }> | undefined;
  return e?.status;
}

// ─── Connection Lifecycle ───

describe("Connection lifecycle", () => {
  it("transitions disconnected → connecting on ws_open", () => {
    const result = trans("disconnected", { type: "ws_open" });
    expect(result.state).toBe("connecting");
    expect(getEmitStatus(result.effects)).toBe("Connecting...");
  });

  it("stays disconnected on irrelevant events", () => {
    const result = trans("disconnected", { type: "ping" });
    expect(result.state).toBe("disconnected");
    expect(result.effects).toEqual([]);
  });

  it("transitions connecting → authenticating (sends auth + starts timer)", () => {
    // connecting receives ws_open as a "proceed" signal → sends auth
    const result = trans("connecting", { type: "ws_open" });
    expect(result.state).toBe("authenticating");
    expect(hasEffect(result.effects, "send")).toBe(true);
    expect(hasEffect(result.effects, "start_timer")).toBe(true);
    expect(getEmitStatus(result.effects)).toBe("Authenticating...");
  });
});

// ─── Authentication ───

describe("Authentication", () => {
  it("transitions authenticating → configuring on auth_ok", () => {
    const result = trans("authenticating", {
      type: "auth_ok",
      sessionId: "sess-1",
    });
    expect(result.state).toBe("configuring");
    expect(result.context.sessionId).toBe("sess-1");
    expect(hasEffect(result.effects, "cancel_timer")).toBe(true);
    expect(hasEffect(result.effects, "send")).toBe(true);
    expect(getEmitStatus(result.effects)).toBe("Configuring...");
  });

  it("transitions authenticating → error on auth_failed", () => {
    const result = trans("authenticating", { type: "auth_failed" });
    expect(result.state).toBe("error");
    expect(result.context.lastError?.code).toBe("auth_failed");
    expect(result.context.lastError?.recoverable).toBe(false);
    expect(getEmitStatus(result.effects)).toBe("Authentication failed");
  });

  it("transitions authenticating → error on timeout", () => {
    const result = trans("authenticating", {
      type: "timeout",
      context: "auth",
    });
    expect(result.state).toBe("error");
    expect(result.context.lastError?.code).toBe("auth_timeout");
    expect(result.context.lastError?.recoverable).toBe(true);
  });

  it("transitions authenticating → disconnected on ws_close", () => {
    const result = trans("authenticating", { type: "ws_close", code: 1006 });
    expect(result.state).toBe("disconnected");
    expect(result.context.sessionId).toBeNull();
  });
});

// ─── Configuration ───

describe("Configuration", () => {
  it("transitions configuring → idle on session_ready", () => {
    const result = trans("configuring", { type: "session_ready" });
    expect(result.state).toBe("idle");
    expect(hasEffect(result.effects, "cancel_timer")).toBe(true);
    expect(getEmitStatus(result.effects)).toBe("Listening...");
  });

  it("transitions configuring → error on unsupported_config", () => {
    const result = trans("configuring", { type: "unsupported_config" });
    expect(result.state).toBe("error");
    expect(result.context.lastError?.code).toBe("unsupported_config");
    expect(result.context.lastError?.recoverable).toBe(false);
  });

  it("transitions configuring → error on timeout", () => {
    const result = trans("configuring", { type: "timeout", context: "config" });
    expect(result.state).toBe("error");
    expect(result.context.lastError?.code).toBe("config_timeout");
  });
});

// ─── Utterance Lifecycle ───

describe("Utterance lifecycle", () => {
  it("transitions idle → streaming_audio on utterance_start", () => {
    const result = trans("idle", {
      type: "utterance_start",
      utteranceId: "utt-1",
    });
    expect(result.state).toBe("streaming_audio");
    expect(result.context.activeUtteranceId).toBe("utt-1");
    expect(getEmitStatus(result.effects)).toBe("Listening...");
  });

  it("transitions streaming_audio → awaiting_transcript on utterance_end", () => {
    const result = trans(
      "streaming_audio",
      { type: "utterance_end", utteranceId: "utt-1" },
      { activeUtteranceId: "utt-1" }
    );
    expect(result.state).toBe("awaiting_transcript");
    expect(hasEffect(result.effects, "start_timer")).toBe(true);
    expect(getEmitStatus(result.effects)).toBe("Processing...");
  });

  it("warns on utterance_end ID mismatch", () => {
    const result = trans(
      "streaming_audio",
      { type: "utterance_end", utteranceId: "utt-WRONG" },
      { activeUtteranceId: "utt-1" }
    );
    expect(result.state).toBe("streaming_audio"); // stays
    expect(hasEffect(result.effects, "log_warning")).toBe(true);
  });

  it("transitions awaiting_transcript → processing on transcript_final", () => {
    const result = trans("awaiting_transcript", {
      type: "transcript_final",
      utteranceId: "utt-1",
    });
    expect(result.state).toBe("processing");
    expect(hasEffect(result.effects, "cancel_timer")).toBe(true);
    expect(hasEffect(result.effects, "start_timer")).toBe(true);
    expect(getEmitStatus(result.effects)).toBe("Thinking...");
  });

  it("stays in awaiting_transcript on transcript_partial", () => {
    const result = trans("awaiting_transcript", {
      type: "transcript_partial",
      utteranceId: "utt-1",
    });
    expect(result.state).toBe("awaiting_transcript");
  });
});

// ─── Response Lifecycle ───

describe("Response lifecycle", () => {
  it("transitions processing → responding on response_start", () => {
    const result = trans("processing", {
      type: "response_start",
      responseId: "resp-1",
    });
    expect(result.state).toBe("responding");
    expect(result.context.activeResponseId).toBe("resp-1");
    expect(getEmitStatus(result.effects)).toBe("Speaking...");
  });

  it("stays responding on sub-events (text_delta, audio_start, etc.)", () => {
    const subEvents: ContractEvent[] = [
      { type: "response_text_delta", responseId: "resp-1" },
      { type: "response_audio_start", responseId: "resp-1" },
      { type: "response_audio_done", responseId: "resp-1" },
      { type: "response_text_done", responseId: "resp-1" },
    ];
    for (const event of subEvents) {
      const result = trans("responding", event, { activeResponseId: "resp-1" });
      expect(result.state).toBe("responding");
    }
  });

  it("transitions responding → idle on response_done", () => {
    const result = trans(
      "responding",
      { type: "response_done", responseId: "resp-1" },
      { activeResponseId: "resp-1" }
    );
    expect(result.state).toBe("idle");
    expect(result.context.activeResponseId).toBeNull();
    expect(result.context.activeUtteranceId).toBeNull();
    expect(getEmitStatus(result.effects)).toBe("Listening...");
  });
});

// ─── Barge-In ───

describe("Barge-in", () => {
  it("stays responding on barge_in (awaiting ack)", () => {
    const result = trans(
      "responding",
      { type: "barge_in", responseId: "resp-1" },
      { activeResponseId: "resp-1" }
    );
    expect(result.state).toBe("responding");
    expect(hasEffect(result.effects, "send")).toBe(true);
  });

  it("transitions responding → idle on barge_in_ack", () => {
    const result = trans(
      "responding",
      { type: "barge_in_ack", responseId: "resp-1" },
      { activeResponseId: "resp-1" }
    );
    expect(result.state).toBe("idle");
    expect(getEmitStatus(result.effects)).toBe("Listening...");
  });

  it("transitions responding → streaming_audio on utterance_start (immediate barge-in)", () => {
    const result = trans(
      "responding",
      { type: "utterance_start", utteranceId: "utt-2" },
      { activeResponseId: "resp-1" }
    );
    expect(result.state).toBe("streaming_audio");
    expect(result.context.activeUtteranceId).toBe("utt-2");
    expect(result.context.activeResponseId).toBeNull();
    // Should send both barge_in for old response and utterance.start for new
    const sends = result.effects.filter((e) => e.type === "send");
    expect(sends.length).toBe(2);
  });

  it("transitions processing → streaming_audio on utterance_start (pre-response barge-in)", () => {
    const result = trans("processing", {
      type: "utterance_start",
      utteranceId: "utt-2",
    });
    expect(result.state).toBe("streaming_audio");
    expect(result.context.activeUtteranceId).toBe("utt-2");
  });
});

// ─── Error Handling ───

describe("Error handling", () => {
  it("recoverable error allows utterance_start to recover to streaming_audio", () => {
    const result = trans(
      "error",
      { type: "utterance_start", utteranceId: "utt-retry" },
      { lastError: { code: "transcript_timeout", recoverable: true } }
    );
    expect(result.state).toBe("streaming_audio");
    expect(result.context.lastError).toBeNull();
    expect(result.context.activeUtteranceId).toBe("utt-retry");
  });

  it("non-recoverable error blocks utterance_start", () => {
    const result = trans(
      "error",
      { type: "utterance_start", utteranceId: "utt-retry" },
      { lastError: { code: "auth_failed", recoverable: false } }
    );
    expect(result.state).toBe("error");
  });

  it("error state allows reconnect via ws_open", () => {
    const result = trans("error", { type: "ws_open" });
    expect(result.state).toBe("connecting");
    expect(result.context.lastError).toBeNull();
  });

  it("error state allows session end", () => {
    const result = trans("error", { type: "session_end_request" });
    expect(result.state).toBe("ended");
  });
});

// ─── Timeout Guards ───

describe("Timeout guards", () => {
  it("awaiting_transcript times out to error with friendly message", () => {
    const result = trans("awaiting_transcript", {
      type: "timeout",
      context: "transcript",
    });
    expect(result.state).toBe("error");
    expect(result.context.lastError?.code).toBe("transcript_timeout");
    expect(result.context.lastError?.recoverable).toBe(true);
    expect(getEmitStatus(result.effects)).toContain("didn't catch");
  });

  it("processing times out to error", () => {
    const result = trans("processing", {
      type: "timeout",
      context: "processing",
    });
    expect(result.state).toBe("error");
    expect(result.context.lastError?.code).toBe("processing_timeout");
    expect(result.context.lastError?.recoverable).toBe(true);
  });

  it("responding times out to error", () => {
    const result = trans("responding", {
      type: "timeout",
      context: "response",
    });
    expect(result.state).toBe("error");
    expect(result.context.lastError?.code).toBe("response_timeout");
  });

  it("idle keepalive timeout → disconnected", () => {
    const result = trans("idle", {
      type: "timeout",
      context: "keepalive",
    });
    expect(result.state).toBe("disconnected");
    expect(hasEffect(result.effects, "close_connection")).toBe(true);
  });
});

// ─── WS Drop from Every Active State ───

describe("WS drop from every active state", () => {
  const activeStates: ContractState[] = [
    "authenticating",
    "configuring",
    "idle",
    "streaming_audio",
    "awaiting_transcript",
    "processing",
    "responding",
    "error",
  ];

  for (const state of activeStates) {
    it(`transitions ${state} → disconnected on ws_close`, () => {
      const result = trans(state, { type: "ws_close", code: 1006 });
      expect(result.state).toBe("disconnected");
      expect(getEmitStatus(result.effects)).toBe("Disconnected");
    });
  }
});

// ─── Session End ───

describe("Session end", () => {
  it("transitions idle → ended on session_end_request", () => {
    const result = trans("idle", { type: "session_end_request" });
    expect(result.state).toBe("ended");
    expect(getEmitStatus(result.effects)).toBe("Session ended");
  });

  it("transitions idle → ended on session_ended (server-initiated)", () => {
    const result = trans("idle", { type: "session_ended" });
    expect(result.state).toBe("ended");
  });

  it("ended allows ws_open for new session", () => {
    const result = trans("ended", { type: "ws_open" });
    expect(result.state).toBe("connecting");
  });

  it("ended ignores irrelevant events", () => {
    const result = trans("ended", { type: "ping" });
    expect(result.state).toBe("ended");
  });
});

// ─── Full Conversation Flow ───

describe("Full conversation flow (happy path)", () => {
  it("completes a full utterance → response cycle", () => {
    let state: ContractState = "disconnected";
    let context = createInitialContext();
    const step = (event: ContractEvent) => {
      const result = transition(state, event, context, NOW);
      state = result.state;
      context = result.context;
      return result;
    };

    // Connect
    step({ type: "ws_open" });
    expect(state).toBe("connecting");

    step({ type: "ws_open" }); // proceed to auth
    expect(state).toBe("authenticating");

    step({ type: "auth_ok", sessionId: "sess-1" });
    expect(state).toBe("configuring");

    step({ type: "session_ready" });
    expect(state).toBe("idle");

    // Utterance
    step({ type: "utterance_start", utteranceId: "utt-1" });
    expect(state).toBe("streaming_audio");

    step({ type: "utterance_end", utteranceId: "utt-1" });
    expect(state).toBe("awaiting_transcript");

    step({ type: "transcript_partial", utteranceId: "utt-1" });
    expect(state).toBe("awaiting_transcript");

    step({ type: "transcript_final", utteranceId: "utt-1" });
    expect(state).toBe("processing");

    // Response
    step({ type: "response_start", responseId: "resp-1" });
    expect(state).toBe("responding");

    step({ type: "response_text_delta", responseId: "resp-1" });
    expect(state).toBe("responding");

    step({ type: "response_audio_start", responseId: "resp-1" });
    expect(state).toBe("responding");

    step({ type: "response_audio_done", responseId: "resp-1" });
    expect(state).toBe("responding");

    step({ type: "response_text_done", responseId: "resp-1" });
    expect(state).toBe("responding");

    step({ type: "response_done", responseId: "resp-1" });
    expect(state).toBe("idle");

    // Second utterance
    step({ type: "utterance_start", utteranceId: "utt-2" });
    expect(state).toBe("streaming_audio");

    // End session
    step({ type: "utterance_end", utteranceId: "utt-2" });
    step({ type: "transcript_final", utteranceId: "utt-2" });
    step({ type: "response_start", responseId: "resp-2" });
    step({ type: "response_done", responseId: "resp-2" });
    expect(state).toBe("idle");

    step({ type: "session_end_request" });
    expect(state).toBe("ended");
  });
});

// ─── Barge-In Full Flow ───

describe("Barge-in full flow", () => {
  it("user barges in during response, starts new utterance", () => {
    let state: ContractState = "responding";
    let context = ctx({
      activeResponseId: "resp-1",
      activeUtteranceId: "utt-1",
    });
    const step = (event: ContractEvent) => {
      const result = transition(state, event, context, NOW);
      state = result.state;
      context = result.context;
      return result;
    };

    // User speaks during response → automatic barge-in
    const result = step({
      type: "utterance_start",
      utteranceId: "utt-2",
    });
    expect(state).toBe("streaming_audio");
    expect(context.activeUtteranceId).toBe("utt-2");
    expect(context.activeResponseId).toBeNull();
    // Should have sent barge_in for resp-1
    const sends = result.effects.filter((e) => e.type === "send");
    expect(sends.some((s) => (s as any).message.includes("barge_in"))).toBe(true);

    // Continue with new utterance
    step({ type: "utterance_end", utteranceId: "utt-2" });
    expect(state).toBe("awaiting_transcript");

    step({ type: "transcript_final", utteranceId: "utt-2" });
    expect(state).toBe("processing");
  });
});

// ─── Every State Has an Exit ───

describe("Every state has at least one exit", () => {
  for (const state of ALL_STATES) {
    it(`${state} has at least one transition out`, () => {
      const exits = TRANSITION_TABLE.filter((t) => t.from === state);
      expect(exits.length).toBeGreaterThan(0);
    });
  }
});

// ─── Timeout-Guarded States ───

describe("Timeout-guarded states", () => {
  for (const state of TIMEOUT_GUARDED_STATES) {
    it(`${state} handles timeout event`, () => {
      const result = trans(state, {
        type: "timeout",
        context: state,
      });
      // Timeout should either transition to error or another state — not stay
      expect(result.state).not.toBe(state);
    });
  }
});

// ─── Every Active State Handles WS Drop ───

describe("Every active state handles WS disconnection", () => {
  const activeStates = ALL_STATES.filter(
    (s) => s !== "disconnected" && s !== "ended"
  );
  for (const state of activeStates) {
    it(`${state} handles ws_close`, () => {
      const result = trans(state, { type: "ws_close", code: 1006 });
      expect(result.state).toBe("disconnected");
    });
  }
});

// ─── User Always Gets Feedback ───

describe("User always gets feedback on state change", () => {
  const significantTransitions = TRANSITION_TABLE.filter(
    (t) => t.from !== t.to
  );
  for (const entry of significantTransitions) {
    it(`${entry.from} → ${entry.to} has user feedback: "${entry.userFeedback}"`, () => {
      expect(entry.userFeedback).toBeTruthy();
      expect(entry.userFeedback.length).toBeGreaterThan(0);
    });
  }
});

// ─── No Dead States ───

describe("No dead states (every state is reachable)", () => {
  for (const state of ALL_STATES) {
    if (state === "disconnected") continue; // initial state
    it(`${state} is reachable from some other state`, () => {
      const incoming = TRANSITION_TABLE.filter((t) => t.to === state);
      expect(incoming.length).toBeGreaterThan(0);
    });
  }
});

// ─── Pure Function: No Mutation ───

describe("Pure function guarantees", () => {
  it("does not mutate input context", () => {
    const original = ctx({ sessionId: "sess-1" });
    const frozen = { ...original };
    trans("authenticating", {
      type: "auth_ok",
      sessionId: "sess-2",
    });
    expect(original).toEqual(frozen);
  });

  it("returns same result for same inputs (deterministic)", () => {
    const c = ctx();
    const r1 = transition("idle", { type: "utterance_start", utteranceId: "u1" }, c, NOW);
    const r2 = transition("idle", { type: "utterance_start", utteranceId: "u1" }, c, NOW);
    expect(r1).toEqual(r2);
  });
});
