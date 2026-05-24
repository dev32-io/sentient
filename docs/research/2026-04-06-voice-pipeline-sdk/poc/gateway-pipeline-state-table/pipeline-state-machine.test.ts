import { describe, it, expect } from "bun:test";
import {
  transition,
  initialContext,
  ALL_STATES,
  ALL_EVENT_TYPES,
  TIMEOUT_GUARDED_STATES,
  TRANSITION_TABLE,
  type PipelineContext,
  type PipelineEvent,
  type PipelineState,
  type PipelineEffect,
} from "./pipeline-state-machine";

// ─── Helpers ──────────────────────────────────────────────────────────

function ctx(state: PipelineState, overrides: Partial<PipelineContext> = {}): PipelineContext {
  return {
    state,
    sessionId: "test-session",
    llmActive: false,
    droppedProvider: null,
    reconnectAttempts: 0,
    ...overrides,
  };
}

function effectTypes(effects: PipelineEffect[]): string[] {
  return effects.map((e) => e.type);
}

function applySequence(
  initial: PipelineContext,
  events: PipelineEvent[]
): { context: PipelineContext; allEffects: PipelineEffect[] } {
  let current = initial;
  const allEffects: PipelineEffect[] = [];
  for (const event of events) {
    const result = transition(current, event);
    current = result.context;
    allEffects.push(...result.effects);
  }
  return { context: current, allEffects };
}

function makeEvent(type: PipelineEvent["type"]): PipelineEvent {
  switch (type) {
    case "SESSION_START": return { type: "SESSION_START", sessionId: "s1" };
    case "PROVIDERS_READY": return { type: "PROVIDERS_READY" };
    case "PROVIDER_CONNECT_FAILED": return { type: "PROVIDER_CONNECT_FAILED", reason: "timeout" };
    case "UTTERANCE_START": return { type: "UTTERANCE_START" };
    case "AUDIO_CHUNK": return { type: "AUDIO_CHUNK" };
    case "UTTERANCE_END": return { type: "UTTERANCE_END" };
    case "TRANSCRIPT_PARTIAL": return { type: "TRANSCRIPT_PARTIAL", text: "hel" };
    case "TRANSCRIPT_FINAL": return { type: "TRANSCRIPT_FINAL", text: "hello" };
    case "STT_TIMEOUT": return { type: "STT_TIMEOUT" };
    case "LLM_TOKEN": return { type: "LLM_TOKEN", token: "Hi" };
    case "LLM_DONE": return { type: "LLM_DONE", fullText: "Hi there" };
    case "LLM_TIMEOUT": return { type: "LLM_TIMEOUT" };
    case "SENTENCE_READY": return { type: "SENTENCE_READY", sentence: "Hi there." };
    case "TTS_AUDIO": return { type: "TTS_AUDIO", data: new Uint8Array([1, 2]) };
    case "TTS_DONE": return { type: "TTS_DONE" };
    case "TURN_COMPLETE": return { type: "TURN_COMPLETE" };
    case "BARGE_IN": return { type: "BARGE_IN" };
    case "CANCEL_COMPLETE": return { type: "CANCEL_COMPLETE" };
    case "PROVIDER_DROPPED": return { type: "PROVIDER_DROPPED", provider: "stt" };
    case "RECONNECT_SUCCESS": return { type: "RECONNECT_SUCCESS" };
    case "RECONNECT_FAILED": return { type: "RECONNECT_FAILED", reason: "refused" };
    case "RECONNECT_TIMEOUT": return { type: "RECONNECT_TIMEOUT" };
    case "ERROR": return { type: "ERROR", error: "test error" };
    case "RECOVER": return { type: "RECOVER" };
    case "SESSION_END": return { type: "SESSION_END" };
    case "DESTROY": return { type: "DESTROY" };
  }
}

// ─── 1. Every State Has At Least One Exit ─────────────────────────────

describe("every state has at least one exit", () => {
  for (const state of ALL_STATES) {
    if (state === "closed") continue; // terminal
    it(`${state} has at least one outgoing transition`, () => {
      const entries = TRANSITION_TABLE.filter((t) => t.from === state);
      expect(entries.length).toBeGreaterThan(0);
    });
  }
});

// ─── 2. Closed Is Terminal ────────────────────────────────────────────

describe("closed is terminal", () => {
  it("no events cause transitions from closed", () => {
    for (const eventType of ALL_EVENT_TYPES) {
      const event = makeEvent(eventType);
      const result = transition(ctx("closed"), event);
      expect(result.context.state).toBe("closed");
      expect(result.effects).toEqual([]);
    }
  });
});

// ─── 3. DESTROY Works From Every Non-Terminal State ───────────────────

describe("DESTROY reaches closed from every state", () => {
  for (const state of ALL_STATES) {
    if (state === "closed") continue;
    it(`${state} → DESTROY → closed`, () => {
      const result = transition(ctx(state), { type: "DESTROY" });
      expect(result.context.state).toBe("closed");
      expect(effectTypes(result.effects)).toContain("EMIT_STATE");
      expect(effectTypes(result.effects)).toContain("CLOSE_SESSION");
    });
  }
});

// ─── 4. SESSION_END Works From Every Active State ────────────────────

describe("SESSION_END reaches closed from every active state", () => {
  const activeStates = ALL_STATES.filter(
    (s) => s !== "disconnected" && s !== "closed"
  );
  for (const state of activeStates) {
    it(`${state} → SESSION_END → closed`, () => {
      const result = transition(ctx(state), { type: "SESSION_END" });
      expect(result.context.state).toBe("closed");
    });
  }
});

// ─── 5. Timeout Guards on Waiting States ──────────────────────────────

describe("timeout guards on waiting states", () => {
  it("finalizing-stt has stt timer (5s)", () => {
    const result = transition(ctx("receiving-audio"), { type: "UTTERANCE_END" });
    expect(result.context.state).toBe("finalizing-stt");
    const timerEffects = result.effects.filter(
      (e) => e.type === "START_TIMER" && e.name === "stt"
    );
    expect(timerEffects.length).toBe(1);
    expect((timerEffects[0] as any).durationMs).toBe(5000);
  });

  it("finalizing-stt exits on STT_TIMEOUT → error", () => {
    const result = transition(ctx("finalizing-stt"), { type: "STT_TIMEOUT" });
    expect(result.context.state).toBe("error");
    expect(effectTypes(result.effects)).toContain("SEND_ERROR");
  });

  it("finalizing-stt exits on TRANSCRIPT_FINAL → running-llm", () => {
    const result = transition(ctx("finalizing-stt"), { type: "TRANSCRIPT_FINAL", text: "hello" });
    expect(result.context.state).toBe("running-llm");
    expect(effectTypes(result.effects)).toContain("CANCEL_TIMER");
    expect(effectTypes(result.effects)).toContain("START_LLM_STREAM");
  });

  it("running-llm has llm timer (30s)", () => {
    const result = transition(ctx("finalizing-stt"), { type: "TRANSCRIPT_FINAL", text: "hello" });
    expect(result.context.state).toBe("running-llm");
    const timerEffects = result.effects.filter(
      (e) => e.type === "START_TIMER" && e.name === "llm"
    );
    expect(timerEffects.length).toBe(1);
    expect((timerEffects[0] as any).durationMs).toBe(30000);
  });

  it("running-llm exits on LLM_TIMEOUT → error", () => {
    const result = transition(ctx("running-llm", { llmActive: true }), { type: "LLM_TIMEOUT" });
    expect(result.context.state).toBe("error");
    expect(effectTypes(result.effects)).toContain("ABORT_TURN");
    expect(effectTypes(result.effects)).toContain("SEND_ERROR");
  });

  it("reconnecting has reconnect timer (10s)", () => {
    const result = transition(ctx("idle"), { type: "PROVIDER_DROPPED", provider: "stt" });
    expect(result.context.state).toBe("reconnecting");
    const timerEffects = result.effects.filter(
      (e) => e.type === "START_TIMER" && e.name === "reconnect"
    );
    expect(timerEffects.length).toBe(1);
    expect((timerEffects[0] as any).durationMs).toBe(10000);
  });

  it("reconnecting exits on RECONNECT_TIMEOUT → error", () => {
    const result = transition(ctx("reconnecting", { droppedProvider: "stt" }), { type: "RECONNECT_TIMEOUT" });
    expect(result.context.state).toBe("error");
    expect(effectTypes(result.effects)).toContain("SEND_ERROR");
  });

  it("every timeout-guarded state is listed in TIMEOUT_GUARDED_STATES", () => {
    for (const [state, { timer, event }] of Object.entries(TIMEOUT_GUARDED_STATES)) {
      // Verify the timeout event transitions out of this state
      const result = transition(ctx(state as PipelineState, { llmActive: true, droppedProvider: "stt" }), makeEvent(event));
      expect(result.context.state).not.toBe(state);
    }
  });
});

// ─── 6. Complete Conversation Flows ──────────────────────────────────

describe("complete conversation flows", () => {
  it("happy path: connect → utterance → STT → LLM → TTS → done", () => {
    const { context } = applySequence(initialContext(), [
      { type: "SESSION_START", sessionId: "s1" },
      { type: "PROVIDERS_READY" },
      { type: "UTTERANCE_START" },
      { type: "AUDIO_CHUNK" },
      { type: "AUDIO_CHUNK" },
      { type: "TRANSCRIPT_PARTIAL", text: "hel" },
      { type: "UTTERANCE_END" },
      { type: "TRANSCRIPT_FINAL", text: "hello" },
      { type: "LLM_TOKEN", token: "Hi" },
      { type: "LLM_TOKEN", token: " there." },
      { type: "SENTENCE_READY", sentence: "Hi there." },
      { type: "TTS_AUDIO", data: new Uint8Array([1]) },
      { type: "TTS_AUDIO", data: new Uint8Array([2]) },
      { type: "TTS_DONE" },
      { type: "LLM_DONE", fullText: "Hi there." },
      { type: "TURN_COMPLETE" },
    ]);
    expect(context.state).toBe("idle");
    expect(context.sessionId).toBe("s1");
  });

  it("multi-turn conversation", () => {
    const { context } = applySequence(initialContext(), [
      // Connect
      { type: "SESSION_START", sessionId: "s1" },
      { type: "PROVIDERS_READY" },
      // Turn 1
      { type: "UTTERANCE_START" },
      { type: "UTTERANCE_END" },
      { type: "TRANSCRIPT_FINAL", text: "hello" },
      { type: "SENTENCE_READY", sentence: "Hi there." },
      { type: "LLM_DONE", fullText: "Hi there." },
      { type: "TTS_AUDIO", data: new Uint8Array([1]) },
      { type: "TURN_COMPLETE" },
      // Turn 2
      { type: "UTTERANCE_START" },
      { type: "UTTERANCE_END" },
      { type: "TRANSCRIPT_FINAL", text: "how are you" },
      { type: "SENTENCE_READY", sentence: "I'm great!" },
      { type: "LLM_DONE", fullText: "I'm great!" },
      { type: "TTS_AUDIO", data: new Uint8Array([1]) },
      { type: "TURN_COMPLETE" },
    ]);
    expect(context.state).toBe("idle");
  });

  it("barge-in during LLM streaming", () => {
    const { context } = applySequence(initialContext(), [
      { type: "SESSION_START", sessionId: "s1" },
      { type: "PROVIDERS_READY" },
      { type: "UTTERANCE_START" },
      { type: "UTTERANCE_END" },
      { type: "TRANSCRIPT_FINAL", text: "tell me a story" },
      { type: "LLM_TOKEN", token: "Once" },
      // User interrupts
      { type: "BARGE_IN" },
      { type: "CANCEL_COMPLETE" },
      // New utterance
      { type: "UTTERANCE_START" },
      { type: "UTTERANCE_END" },
      { type: "TRANSCRIPT_FINAL", text: "never mind" },
      { type: "SENTENCE_READY", sentence: "Okay!" },
      { type: "LLM_DONE", fullText: "Okay!" },
      { type: "TTS_AUDIO", data: new Uint8Array([1]) },
      { type: "TURN_COMPLETE" },
    ]);
    expect(context.state).toBe("idle");
  });

  it("barge-in during TTS streaming", () => {
    const { context } = applySequence(initialContext(), [
      { type: "SESSION_START", sessionId: "s1" },
      { type: "PROVIDERS_READY" },
      { type: "UTTERANCE_START" },
      { type: "UTTERANCE_END" },
      { type: "TRANSCRIPT_FINAL", text: "hello" },
      { type: "SENTENCE_READY", sentence: "Hi there." },
      { type: "TTS_AUDIO", data: new Uint8Array([1]) },
      // Barge-in during audio playback
      { type: "BARGE_IN" },
      { type: "CANCEL_COMPLETE" },
    ]);
    expect(context.state).toBe("idle");
  });

  it("provider reconnection during idle", () => {
    const { context } = applySequence(initialContext(), [
      { type: "SESSION_START", sessionId: "s1" },
      { type: "PROVIDERS_READY" },
      // STT drops
      { type: "PROVIDER_DROPPED", provider: "stt" },
      // Reconnect succeeds
      { type: "RECONNECT_SUCCESS" },
      // Continue normally
      { type: "UTTERANCE_START" },
      { type: "UTTERANCE_END" },
      { type: "TRANSCRIPT_FINAL", text: "hi" },
      { type: "SENTENCE_READY", sentence: "Hello!" },
      { type: "LLM_DONE", fullText: "Hello!" },
      { type: "TTS_AUDIO", data: new Uint8Array([1]) },
      { type: "TURN_COMPLETE" },
    ]);
    expect(context.state).toBe("idle");
  });

  it("provider reconnection with retries", () => {
    const { context } = applySequence(initialContext(), [
      { type: "SESSION_START", sessionId: "s1" },
      { type: "PROVIDERS_READY" },
      { type: "PROVIDER_DROPPED", provider: "tts" },
      // First retry fails
      { type: "RECONNECT_FAILED", reason: "refused" },
      // Second retry fails
      { type: "RECONNECT_FAILED", reason: "refused" },
      // Third retry succeeds
      { type: "RECONNECT_SUCCESS" },
    ]);
    expect(context.state).toBe("idle");
    expect(context.reconnectAttempts).toBe(0);
  });

  it("provider reconnection exhausts retries → error", () => {
    const { context } = applySequence(initialContext(), [
      { type: "SESSION_START", sessionId: "s1" },
      { type: "PROVIDERS_READY" },
      { type: "PROVIDER_DROPPED", provider: "stt" },
      { type: "RECONNECT_FAILED", reason: "refused" },
      { type: "RECONNECT_FAILED", reason: "refused" },
      { type: "RECONNECT_FAILED", reason: "refused" }, // 3rd attempt → give up
    ]);
    expect(context.state).toBe("error");
  });

  it("STT timeout during finalization → error → recover → idle", () => {
    const { context } = applySequence(initialContext(), [
      { type: "SESSION_START", sessionId: "s1" },
      { type: "PROVIDERS_READY" },
      { type: "UTTERANCE_START" },
      { type: "UTTERANCE_END" },
      { type: "STT_TIMEOUT" },
      { type: "RECOVER" },
    ]);
    expect(context.state).toBe("idle");
  });

  it("LLM timeout → error → recover → idle", () => {
    const { context } = applySequence(initialContext(), [
      { type: "SESSION_START", sessionId: "s1" },
      { type: "PROVIDERS_READY" },
      { type: "UTTERANCE_START" },
      { type: "UTTERANCE_END" },
      { type: "TRANSCRIPT_FINAL", text: "hello" },
      { type: "LLM_TIMEOUT" },
      { type: "RECOVER" },
    ]);
    expect(context.state).toBe("idle");
  });

  it("provider drops during TTS streaming → error", () => {
    const { context, allEffects } = applySequence(initialContext(), [
      { type: "SESSION_START", sessionId: "s1" },
      { type: "PROVIDERS_READY" },
      { type: "UTTERANCE_START" },
      { type: "UTTERANCE_END" },
      { type: "TRANSCRIPT_FINAL", text: "hello" },
      { type: "SENTENCE_READY", sentence: "Hi." },
      { type: "TTS_AUDIO", data: new Uint8Array([1]) },
      { type: "PROVIDER_DROPPED", provider: "tts" },
    ]);
    expect(context.state).toBe("error");
    // Audio done should be relayed to cleanly close the audio stream
    expect(allEffects.map(e => e.type)).toContain("RELAY_AUDIO_DONE");
  });

  it("session end during active turn", () => {
    const { context } = applySequence(initialContext(), [
      { type: "SESSION_START", sessionId: "s1" },
      { type: "PROVIDERS_READY" },
      { type: "UTTERANCE_START" },
      { type: "UTTERANCE_END" },
      { type: "TRANSCRIPT_FINAL", text: "hello" },
      { type: "LLM_TOKEN", token: "Hi" },
      { type: "SESSION_END" },
    ]);
    expect(context.state).toBe("closed");
  });

  it("LLM done before first sentence (short response) stays in running-llm", () => {
    const result = transition(
      ctx("running-llm", { llmActive: true }),
      { type: "LLM_DONE", fullText: "Ok" }
    );
    // Short response: LLM_DONE without SENTENCE_READY first
    // State stays running-llm (sentence aggregator will flush and emit SENTENCE_READY)
    expect(result.context.state).toBe("running-llm");
    expect(result.context.llmActive).toBe(false);
  });
});

// ─── 7. Error Recovery Paths ──────────────────────────────────────────

describe("error recovery", () => {
  const errorableStates: PipelineState[] = [
    "idle", "receiving-audio", "finalizing-stt",
    "running-llm", "streaming-response",
  ];

  for (const state of errorableStates) {
    it(`${state} → ERROR → error → RECOVER → idle`, () => {
      const r1 = transition(ctx(state, { llmActive: true }), { type: "ERROR", error: "test" });
      expect(r1.context.state).toBe("error");
      expect(effectTypes(r1.effects)).toContain("SEND_ERROR");

      const r2 = transition(r1.context, { type: "RECOVER" });
      expect(r2.context.state).toBe("idle");
    });
  }

  it("provider connect failed → error → session end → closed", () => {
    const { context } = applySequence(initialContext(), [
      { type: "SESSION_START", sessionId: "s1" },
      { type: "PROVIDER_CONNECT_FAILED", reason: "auth failed" },
      { type: "SESSION_END" },
    ]);
    expect(context.state).toBe("closed");
  });
});

// ─── 8. No Dead States (every state reachable from initial) ───────────

describe("reachability — every state reachable from initial", () => {
  function findReachableStates(): Set<PipelineState> {
    const reachable = new Set<PipelineState>();
    const queue: PipelineContext[] = [initialContext()];
    const visited = new Set<string>();

    while (queue.length > 0) {
      const current = queue.shift()!;
      const key = `${current.state}:${current.llmActive}:${current.reconnectAttempts}`;
      if (visited.has(key)) continue;
      visited.add(key);
      reachable.add(current.state);

      for (const eventType of ALL_EVENT_TYPES) {
        const event = makeEvent(eventType);
        const result = transition(current, event);
        const newKey = `${result.context.state}:${result.context.llmActive}:${result.context.reconnectAttempts}`;
        if (!visited.has(newKey)) {
          queue.push(result.context);
        }
      }
    }
    return reachable;
  }

  it("all states are reachable", () => {
    const reachable = findReachableStates();
    for (const state of ALL_STATES) {
      expect(reachable.has(state)).toBe(true);
    }
  });
});

// ─── 9. TRANSITION_TABLE Matches transition() Function ────────────────

describe("transition table matches implementation", () => {
  for (const entry of TRANSITION_TABLE) {
    const label = `${entry.from} + ${entry.event} → ${entry.to}`;
    it(label, () => {
      const event = makeEvent(entry.event);
      const testCtx = ctx(entry.from, {
        llmActive: entry.from === "running-llm" || entry.from === "streaming-response",
        droppedProvider: entry.from === "reconnecting" ? "stt" : null,
      });
      const result = transition(testCtx, event);

      // Special case: RECONNECT_FAILED can go to either reconnecting or error
      if (entry.event === "RECONNECT_FAILED" && entry.to === "reconnecting") {
        // This is the retry case (attempts < 3)
        expect(result.context.state === "reconnecting" || result.context.state === "error").toBe(true);
      } else {
        expect(result.context.state).toBe(entry.to);
      }
    });
  }
});

// ─── 10. Ignored Events Don't Change State ────────────────────────────

describe("ignored events produce no state change and no effects", () => {
  const ignoredCases: [PipelineState, PipelineEvent["type"]][] = [
    ["disconnected", "PROVIDERS_READY"],
    ["disconnected", "UTTERANCE_START"],
    ["disconnected", "AUDIO_CHUNK"],
    ["disconnected", "RECOVER"],
    ["connecting", "UTTERANCE_START"],
    ["connecting", "AUDIO_CHUNK"],
    ["idle", "AUDIO_CHUNK"],
    ["idle", "TRANSCRIPT_FINAL"],
    ["idle", "LLM_TOKEN"],
    ["idle", "TTS_AUDIO"],
    ["idle", "TURN_COMPLETE"],
    ["receiving-audio", "TRANSCRIPT_FINAL"],
    ["receiving-audio", "LLM_TOKEN"],
    ["finalizing-stt", "AUDIO_CHUNK"],
    ["finalizing-stt", "LLM_TOKEN"],
    ["running-llm", "AUDIO_CHUNK"],
    ["running-llm", "TTS_AUDIO"],
    ["error", "UTTERANCE_START"],
    ["error", "AUDIO_CHUNK"],
    ["error", "LLM_TOKEN"],
  ];

  for (const [state, eventType] of ignoredCases) {
    it(`${state} ignores ${eventType}`, () => {
      const event = makeEvent(eventType);
      const result = transition(ctx(state), event);
      expect(result.context.state).toBe(state);
      expect(result.effects).toEqual([]);
    });
  }
});

// ─── 11. Effect Correctness for Key Transitions ─────────────────────

describe("effect correctness", () => {
  it("utterance.start flushes stale STT queue", () => {
    const result = transition(ctx("idle"), { type: "UTTERANCE_START" });
    expect(effectTypes(result.effects)).toContain("FLUSH_STT_QUEUE");
    expect(effectTypes(result.effects)).toContain("INIT_STT_STREAM");
  });

  it("utterance.end triggers STT finalize", () => {
    const result = transition(ctx("receiving-audio"), { type: "UTTERANCE_END" });
    expect(effectTypes(result.effects)).toContain("FINALIZE_STT");
  });

  it("transcript.final starts LLM and appends history", () => {
    const result = transition(ctx("finalizing-stt"), { type: "TRANSCRIPT_FINAL", text: "hello" });
    expect(effectTypes(result.effects)).toContain("START_LLM_STREAM");
    expect(effectTypes(result.effects)).toContain("APPEND_HISTORY");
  });

  it("sentence.ready starts TTS", () => {
    const result = transition(ctx("running-llm", { llmActive: true }), { type: "SENTENCE_READY", sentence: "Hi." });
    expect(effectTypes(result.effects)).toContain("START_TTS");
    expect(effectTypes(result.effects)).toContain("SEND_STATUS");
  });

  it("barge-in during streaming aborts turn and relays audio done", () => {
    const result = transition(ctx("streaming-response", { llmActive: true }), { type: "BARGE_IN" });
    expect(result.context.state).toBe("cancelling");
    expect(effectTypes(result.effects)).toContain("ABORT_TURN");
    expect(effectTypes(result.effects)).toContain("RELAY_AUDIO_DONE");
  });

  it("turn complete relays audio done and sends ready status", () => {
    const result = transition(ctx("streaming-response"), { type: "TURN_COMPLETE" });
    expect(result.context.state).toBe("idle");
    expect(effectTypes(result.effects)).toContain("RELAY_AUDIO_DONE");
    expect(effectTypes(result.effects)).toContain("SEND_STATUS");
  });

  it("partial transcripts relayed during receiving-audio", () => {
    const result = transition(ctx("receiving-audio"), { type: "TRANSCRIPT_PARTIAL", text: "hel" });
    expect(result.context.state).toBe("receiving-audio");
    const relays = result.effects.filter(e => e.type === "RELAY_PARTIAL_TRANSCRIPT") as any[];
    expect(relays.length).toBe(1);
    expect(relays[0].text).toBe("hel");
  });

  it("partial transcripts relayed during finalizing-stt", () => {
    const result = transition(ctx("finalizing-stt"), { type: "TRANSCRIPT_PARTIAL", text: "hello" });
    expect(result.context.state).toBe("finalizing-stt");
    const relays = result.effects.filter(e => e.type === "RELAY_PARTIAL_TRANSCRIPT") as any[];
    expect(relays.length).toBe(1);
  });

  it("LLM tokens relayed as text deltas during streaming-response", () => {
    const result = transition(ctx("streaming-response", { llmActive: true }), { type: "LLM_TOKEN", token: "word" });
    const relays = result.effects.filter(e => e.type === "RELAY_TEXT_DELTA") as any[];
    expect(relays.length).toBe(1);
    expect(relays[0].token).toBe("word");
  });

  it("error during receiving-audio aborts turn", () => {
    const result = transition(ctx("receiving-audio"), { type: "ERROR", error: "ws closed" });
    expect(result.context.state).toBe("error");
    expect(effectTypes(result.effects)).toContain("ABORT_TURN");
    expect(effectTypes(result.effects)).toContain("SEND_ERROR");
  });
});

// ─── 12. Status Indicators — Every Transition Emits Feedback ─────────

describe("status indicators — no silent state transitions", () => {
  const statesWithStatus: PipelineState[] = [
    "connecting", "idle",
    "finalizing-stt", "running-llm", "streaming-response",
    "reconnecting",
  ];

  for (const state of statesWithStatus) {
    it(`entering ${state} from a different state sends a status or error indicator`, () => {
      // Find transitions TO this state from a DIFFERENT state (skip self-transitions)
      const entries = TRANSITION_TABLE.filter(t => t.to === state && t.from !== state);
      expect(entries.length).toBeGreaterThan(0);
      for (const entry of entries) {
        expect(
          entry.effects.some(e => e === "SEND_STATUS" || e === "SEND_ERROR"),
        ).toBe(true);
      }
    });
  }
});

// ─── 13. Cancelling Always Returns to Idle ───────────────────────────

describe("cancelling always returns to idle", () => {
  it("CANCEL_COMPLETE → idle", () => {
    const result = transition(ctx("cancelling"), { type: "CANCEL_COMPLETE" });
    expect(result.context.state).toBe("idle");
    expect(effectTypes(result.effects)).toContain("FLUSH_STT_QUEUE");
  });

  it("ERROR during cancel → idle (not double-error)", () => {
    const result = transition(ctx("cancelling"), { type: "ERROR", error: "cleanup failed" });
    expect(result.context.state).toBe("idle");
  });
});

// ─── 14. Reconnect Retry Logic ───────────────────────────────────────

describe("reconnect retry logic", () => {
  it("retries up to 3 times then gives up", () => {
    let c = ctx("reconnecting", { droppedProvider: "stt", reconnectAttempts: 0 });

    // Attempt 1 fails → retry
    let r = transition(c, { type: "RECONNECT_FAILED", reason: "refused" });
    expect(r.context.state).toBe("reconnecting");
    expect(r.context.reconnectAttempts).toBe(1);

    // Attempt 2 fails → retry
    r = transition(r.context, { type: "RECONNECT_FAILED", reason: "refused" });
    expect(r.context.state).toBe("reconnecting");
    expect(r.context.reconnectAttempts).toBe(2);

    // Attempt 3 fails → error (3 >= 3)
    r = transition(r.context, { type: "RECONNECT_FAILED", reason: "refused" });
    expect(r.context.state).toBe("error");
    expect(r.context.reconnectAttempts).toBe(3);
  });

  it("successful reconnect resets attempt counter", () => {
    const c = ctx("reconnecting", { droppedProvider: "stt", reconnectAttempts: 2 });
    const r = transition(c, { type: "RECONNECT_SUCCESS" });
    expect(r.context.state).toBe("idle");
    expect(r.context.reconnectAttempts).toBe(0);
    expect(r.context.droppedProvider).toBeNull();
  });
});
