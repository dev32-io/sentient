import { describe, it, expect } from "bun:test";
import {
  transition,
  initialContext,
  ALL_STATES,
  ALL_EVENT_TYPES,
  TIMEOUT_GUARDED_STATES,
  TRANSITION_TABLE,
  type VadContext,
  type VadEvent,
  type VadState,
  type VadEffect,
  type DetectionMode,
} from "./vad-state-machine";

// ─── Helpers ──────────────────────────────────────────────────────────

function ctx(state: VadState, mode: DetectionMode = "vad"): VadContext {
  return { state, mode, bargeInPending: false };
}

function effectTypes(effects: VadEffect[]): string[] {
  return effects.map((e) => e.type);
}

function applySequence(
  initial: VadContext,
  events: VadEvent[]
): { context: VadContext; allEffects: VadEffect[] } {
  let current = initial;
  const allEffects: VadEffect[] = [];
  for (const event of events) {
    const result = transition(current, event);
    current = result.context;
    allEffects.push(...result.effects);
  }
  return { context: current, allEffects };
}

// ─── 1. Every State Has At Least One Exit ─────────────────────────────

describe("every state has at least one exit", () => {
  for (const state of ALL_STATES) {
    if (state === "disposed") continue; // terminal state — no exits expected
    it(`${state} has at least one outgoing transition`, () => {
      const entries = TRANSITION_TABLE.filter((t) => t.from === state);
      expect(entries.length).toBeGreaterThan(0);
    });
  }
});

// ─── 2. Disposed Is Terminal ──────────────────────────────────────────

describe("disposed is terminal", () => {
  it("no events cause transitions from disposed", () => {
    for (const eventType of ALL_EVENT_TYPES) {
      const event = makeEvent(eventType);
      const result = transition(ctx("disposed"), event);
      expect(result.context.state).toBe("disposed");
      expect(result.effects).toEqual([]);
    }
  });
});

// ─── 3. DISPOSE Works From Every Non-Terminal State ───────────────────

describe("DISPOSE reaches disposed from every state", () => {
  for (const state of ALL_STATES) {
    if (state === "disposed") continue;
    it(`${state} → DISPOSE → disposed`, () => {
      const result = transition(ctx(state), { type: "DISPOSE" });
      expect(result.context.state).toBe("disposed");
      expect(effectTypes(result.effects)).toContain("EMIT_STATE");
    });
  }
});

// ─── 4. STOP Works From Every Active State ────────────────────────────

describe("STOP reaches inactive from every active state", () => {
  const activeStates = ALL_STATES.filter(
    (s) => s !== "inactive" && s !== "disposed"
  );
  for (const state of activeStates) {
    it(`${state} → STOP → inactive`, () => {
      const result = transition(ctx(state), { type: "STOP" });
      expect(result.context.state).toBe("inactive");
    });
  }
});

// ─── 5. Timeout Guards on Waiting States ──────────────────────────────

describe("timeout guards on waiting states", () => {
  it("speech-detected has onset-debounce timer", () => {
    // Enter speech-detected state
    const result = transition(ctx("listening", "vad"), { type: "SPEECH_DETECTED" });
    expect(result.context.state).toBe("speech-detected");

    const timerEffects = result.effects.filter(
      (e) => e.type === "START_TIMER" && e.name === "onset-debounce"
    );
    expect(timerEffects.length).toBe(1);
    expect((timerEffects[0] as any).durationMs).toBe(32);
  });

  it("speech-detected exits on SILENCE_DETECTED (false alarm)", () => {
    const result = transition(ctx("speech-detected", "vad"), { type: "SILENCE_DETECTED" });
    expect(result.context.state).toBe("listening");
    expect(effectTypes(result.effects)).toContain("CANCEL_TIMER");
  });

  it("trailing-silence has silence timer", () => {
    const result = transition(ctx("user-speaking", "vad"), { type: "SILENCE_DETECTED" });
    expect(result.context.state).toBe("trailing-silence");

    const timerEffects = result.effects.filter(
      (e) => e.type === "START_TIMER" && e.name === "silence"
    );
    expect(timerEffects.length).toBe(1);
    expect((timerEffects[0] as any).durationMs).toBe(700);
  });

  it("trailing-silence exits on SILENCE_TIMEOUT → processing", () => {
    const result = transition(ctx("trailing-silence", "vad"), { type: "SILENCE_TIMEOUT" });
    expect(result.context.state).toBe("processing");
    expect(effectTypes(result.effects)).toContain("SEND_AUDIO_END");
    expect(effectTypes(result.effects)).toContain("START_TIMER"); // processing timer
  });

  it("trailing-silence exits on SPEECH_DETECTED → back to user-speaking", () => {
    const result = transition(ctx("trailing-silence", "vad"), { type: "SPEECH_DETECTED" });
    expect(result.context.state).toBe("user-speaking");
    expect(effectTypes(result.effects)).toContain("CANCEL_TIMER");
  });

  it("processing has processing timer (15s)", () => {
    const result = transition(ctx("trailing-silence", "vad"), { type: "SILENCE_TIMEOUT" });
    expect(result.context.state).toBe("processing");

    const timerEffects = result.effects.filter(
      (e) => e.type === "START_TIMER" && e.name === "processing"
    );
    expect(timerEffects.length).toBe(1);
    expect((timerEffects[0] as any).durationMs).toBe(15000);
  });

  it("processing exits on PROCESSING_TIMEOUT → error", () => {
    const result = transition(ctx("processing"), { type: "PROCESSING_TIMEOUT" });
    expect(result.context.state).toBe("error");
    expect(effectTypes(result.effects)).toContain("EMIT_ERROR");
  });

  it("processing exits on RESPONSE_START → assistant-speaking", () => {
    const result = transition(ctx("processing"), { type: "RESPONSE_START" });
    expect(result.context.state).toBe("assistant-speaking");
    expect(effectTypes(result.effects)).toContain("CANCEL_TIMER");
  });
});

// ─── 6. Complete VAD Conversation Flow ────────────────────────────────

describe("complete conversation flows", () => {
  it("VAD mode: full happy path", () => {
    const { context } = applySequence(initialContext(), [
      { type: "START", mode: "vad" },
      { type: "MIC_GRANTED" },
      { type: "SPEECH_DETECTED" },
      { type: "SPEECH_CONFIRMED" },
      // user speaks...
      { type: "SILENCE_DETECTED" },
      // trailing silence...
      { type: "SILENCE_TIMEOUT" },
      // processing...
      { type: "RESPONSE_START" },
      // assistant speaks...
      { type: "RESPONSE_DONE" },
      // back to listening
    ]);
    expect(context.state).toBe("listening");
    expect(context.mode).toBe("vad");
  });

  it("PTT mode: full happy path", () => {
    const { context } = applySequence(initialContext(), [
      { type: "START", mode: "ptt" },
      { type: "MIC_GRANTED" },
      { type: "PTT_PRESS" },
      { type: "PTT_RELEASE" },
      { type: "RESPONSE_START" },
      { type: "RESPONSE_DONE" },
    ]);
    expect(context.state).toBe("listening");
    expect(context.mode).toBe("ptt");
  });

  it("VAD mode: barge-in during assistant speaking", () => {
    const { context } = applySequence(initialContext(), [
      { type: "START", mode: "vad" },
      { type: "MIC_GRANTED" },
      { type: "SPEECH_DETECTED" },
      { type: "SPEECH_CONFIRMED" },
      { type: "SILENCE_DETECTED" },
      { type: "SILENCE_TIMEOUT" },
      { type: "RESPONSE_START" },
      // assistant speaking, user interrupts:
      { type: "SPEECH_DETECTED" },
      { type: "BARGE_IN_ACK" },
      // now user is speaking again
      { type: "SILENCE_DETECTED" },
      { type: "SILENCE_TIMEOUT" },
      { type: "RESPONSE_START" },
      { type: "RESPONSE_DONE" },
    ]);
    expect(context.state).toBe("listening");
  });

  it("VAD mode: false barge-in (echo) reverts to assistant-speaking", () => {
    const { context } = applySequence(initialContext(), [
      { type: "START", mode: "vad" },
      { type: "MIC_GRANTED" },
      { type: "SPEECH_DETECTED" },
      { type: "SPEECH_CONFIRMED" },
      { type: "SILENCE_DETECTED" },
      { type: "SILENCE_TIMEOUT" },
      { type: "RESPONSE_START" },
      // false barge-in from echo:
      { type: "SPEECH_DETECTED" },
      { type: "SILENCE_DETECTED" }, // echo fades, silence detected
      // back to assistant speaking
      { type: "RESPONSE_DONE" },
    ]);
    expect(context.state).toBe("listening");
  });

  it("VAD mode: cough during listening (false alarm)", () => {
    const { context } = applySequence(initialContext(), [
      { type: "START", mode: "vad" },
      { type: "MIC_GRANTED" },
      // cough triggers speech detection
      { type: "SPEECH_DETECTED" },
      // but silence returns before debounce confirms
      { type: "SILENCE_DETECTED" },
    ]);
    expect(context.state).toBe("listening");
  });

  it("VAD mode: double utterance (speak, pause, speak again)", () => {
    const { context } = applySequence(initialContext(), [
      { type: "START", mode: "vad" },
      { type: "MIC_GRANTED" },
      // First utterance
      { type: "SPEECH_DETECTED" },
      { type: "SPEECH_CONFIRMED" },
      { type: "SILENCE_DETECTED" },
      { type: "SILENCE_TIMEOUT" },
      // Processing first utterance, user speaks again
      { type: "SPEECH_DETECTED" },
      { type: "SPEECH_CONFIRMED" },
      { type: "SILENCE_DETECTED" },
      { type: "SILENCE_TIMEOUT" },
      // Now processing second utterance
      { type: "RESPONSE_START" },
      { type: "RESPONSE_DONE" },
    ]);
    expect(context.state).toBe("listening");
  });

  it("VAD mode: mid-sentence pause (trailing silence → resume)", () => {
    const { context } = applySequence(initialContext(), [
      { type: "START", mode: "vad" },
      { type: "MIC_GRANTED" },
      { type: "SPEECH_DETECTED" },
      { type: "SPEECH_CONFIRMED" },
      // Pause mid-sentence:
      { type: "SILENCE_DETECTED" },
      // Resume before timeout:
      { type: "SPEECH_DETECTED" },
      // Continue speaking, then truly stop:
      { type: "SILENCE_DETECTED" },
      { type: "SILENCE_TIMEOUT" },
      { type: "RESPONSE_START" },
      { type: "RESPONSE_DONE" },
    ]);
    expect(context.state).toBe("listening");
  });

  it("PTT mode: barge-in during assistant speaking", () => {
    const { context } = applySequence(initialContext(), [
      { type: "START", mode: "ptt" },
      { type: "MIC_GRANTED" },
      { type: "PTT_PRESS" },
      { type: "PTT_RELEASE" },
      { type: "RESPONSE_START" },
      // barge-in via PTT:
      { type: "PTT_PRESS" },
      { type: "BARGE_IN_ACK" },
      { type: "PTT_RELEASE" },
      { type: "RESPONSE_START" },
      { type: "RESPONSE_DONE" },
    ]);
    expect(context.state).toBe("listening");
  });
});

// ─── 7. Error Recovery Paths ──────────────────────────────────────────

describe("error recovery", () => {
  const errorableStates: VadState[] = [
    "listening", "speech-detected", "user-speaking",
    "trailing-silence", "processing", "assistant-speaking", "interrupting",
  ];

  for (const state of errorableStates) {
    it(`${state} → ERROR → error → RECOVER → listening`, () => {
      const r1 = transition(ctx(state), { type: "ERROR", error: "test" });
      expect(r1.context.state).toBe("error");
      expect(effectTypes(r1.effects)).toContain("EMIT_ERROR");

      const r2 = transition(r1.context, { type: "RECOVER" });
      expect(r2.context.state).toBe("listening");
    });
  }

  it("mic denied → error → STOP → inactive", () => {
    const { context } = applySequence(initialContext(), [
      { type: "START", mode: "vad" },
      { type: "MIC_DENIED", reason: "NotAllowedError" },
      { type: "STOP" },
    ]);
    expect(context.state).toBe("inactive");
  });

  it("processing timeout → error → RECOVER → listening", () => {
    const { context } = applySequence(initialContext(), [
      { type: "START", mode: "vad" },
      { type: "MIC_GRANTED" },
      { type: "SPEECH_DETECTED" },
      { type: "SPEECH_CONFIRMED" },
      { type: "SILENCE_DETECTED" },
      { type: "SILENCE_TIMEOUT" },
      { type: "PROCESSING_TIMEOUT" },
      { type: "RECOVER" },
    ]);
    expect(context.state).toBe("listening");
  });
});

// ─── 8. No Dead States (every state reachable from initial) ───────────

describe("reachability — every state reachable from initial", () => {
  // BFS from inactive using all possible events
  function findReachableStates(): Set<VadState> {
    const reachable = new Set<VadState>();
    const queue: VadContext[] = [initialContext()];
    const visited = new Set<string>();

    while (queue.length > 0) {
      const current = queue.shift()!;
      const key = `${current.state}:${current.mode}:${current.bargeInPending}`;
      if (visited.has(key)) continue;
      visited.add(key);
      reachable.add(current.state);

      for (const eventType of ALL_EVENT_TYPES) {
        for (const mode of ["vad", "ptt", "continuous"] as DetectionMode[]) {
          const testCtx = { ...current, mode };
          const event = makeEvent(eventType, mode);
          const result = transition(testCtx, event);
          if (!visited.has(`${result.context.state}:${result.context.mode}:${result.context.bargeInPending}`)) {
            queue.push(result.context);
          }
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

// ─── 9. TRANSITION_TABLE matches transition() function ────────────────

describe("transition table matches implementation", () => {
  for (const entry of TRANSITION_TABLE) {
    const label = `${entry.from} + ${entry.event}${entry.modeConstraint ? ` (${entry.modeConstraint})` : ""} → ${entry.to}`;
    it(label, () => {
      const mode = entry.modeConstraint || "vad";
      const event = makeEvent(entry.event, mode);
      const result = transition(ctx(entry.from, mode), event);
      expect(result.context.state).toBe(entry.to);
    });
  }
});

// ─── 10. Ignored events don't change state ────────────────────────────

describe("ignored events produce no state change and no effects", () => {
  // Sample of events that should be ignored in certain states
  const ignoredCases: [VadState, VadEvent["type"]][] = [
    ["inactive", "MIC_GRANTED"],
    ["inactive", "SPEECH_DETECTED"],
    ["inactive", "RECOVER"],
    ["listening", "MIC_GRANTED"],
    ["listening", "SILENCE_TIMEOUT"],
    ["listening", "RESPONSE_START"],
    ["user-speaking", "SPEECH_DETECTED"], // Only valid in VAD as transition to trailing-silence, not in PTT
    ["processing", "SILENCE_TIMEOUT"],
    ["assistant-speaking", "SILENCE_TIMEOUT"],
    ["error", "SPEECH_DETECTED"],
    ["error", "RESPONSE_START"],
  ];

  for (const [state, eventType] of ignoredCases) {
    it(`${state} ignores ${eventType}`, () => {
      // Use PTT mode for user-speaking + SPEECH_DETECTED (that's a VAD-only transition)
      const mode: DetectionMode = state === "user-speaking" ? "ptt" : "vad";
      const event = makeEvent(eventType, mode);
      const result = transition(ctx(state, mode), event);
      expect(result.context.state).toBe(state);
      expect(result.effects).toEqual([]);
    });
  }
});

// ─── 11. Effect correctness for protocol messages ─────────────────────

describe("protocol message effects", () => {
  it("audio.start sent when entering user-speaking (VAD)", () => {
    const result = transition(ctx("speech-detected", "vad"), { type: "SPEECH_CONFIRMED" });
    expect(effectTypes(result.effects)).toContain("SEND_AUDIO_START");
  });

  it("audio.start sent when entering user-speaking (PTT)", () => {
    const result = transition(ctx("listening", "ptt"), { type: "PTT_PRESS" });
    expect(effectTypes(result.effects)).toContain("SEND_AUDIO_START");
  });

  it("audio.end sent when entering processing (VAD)", () => {
    const result = transition(ctx("trailing-silence", "vad"), { type: "SILENCE_TIMEOUT" });
    expect(effectTypes(result.effects)).toContain("SEND_AUDIO_END");
  });

  it("audio.end sent when entering processing (PTT)", () => {
    const result = transition(ctx("user-speaking", "ptt"), { type: "PTT_RELEASE" });
    expect(effectTypes(result.effects)).toContain("SEND_AUDIO_END");
  });

  it("barge_in sent on interruption", () => {
    const result = transition(ctx("assistant-speaking", "vad"), { type: "SPEECH_DETECTED" });
    expect(effectTypes(result.effects)).toContain("SEND_BARGE_IN");
    expect(effectTypes(result.effects)).toContain("CLEAR_PLAYBACK");
  });

  it("audio.end sent on error during user-speaking", () => {
    const result = transition(ctx("user-speaking", "vad"), { type: "ERROR", error: "ws closed" });
    expect(effectTypes(result.effects)).toContain("SEND_AUDIO_END");
  });
});

// ─── 12. Continuous mode ──────────────────────────────────────────────

describe("continuous mode", () => {
  it("sends audio.start immediately on mic granted", () => {
    const result = transition(
      { state: "requesting-mic", mode: "continuous", bargeInPending: false },
      { type: "MIC_GRANTED" }
    );
    expect(result.context.state).toBe("listening");
    expect(effectTypes(result.effects)).toContain("SEND_AUDIO_START");
  });
});

// ─── Helper: create event from type ───────────────────────────────────

function makeEvent(type: VadEvent["type"], mode: DetectionMode = "vad"): VadEvent {
  switch (type) {
    case "START": return { type: "START", mode };
    case "MIC_GRANTED": return { type: "MIC_GRANTED" };
    case "MIC_DENIED": return { type: "MIC_DENIED", reason: "NotAllowedError" };
    case "SPEECH_DETECTED": return { type: "SPEECH_DETECTED" };
    case "SPEECH_CONFIRMED": return { type: "SPEECH_CONFIRMED" };
    case "SILENCE_DETECTED": return { type: "SILENCE_DETECTED" };
    case "SILENCE_TIMEOUT": return { type: "SILENCE_TIMEOUT" };
    case "PTT_PRESS": return { type: "PTT_PRESS" };
    case "PTT_RELEASE": return { type: "PTT_RELEASE" };
    case "RESPONSE_START": return { type: "RESPONSE_START" };
    case "RESPONSE_DONE": return { type: "RESPONSE_DONE" };
    case "BARGE_IN_ACK": return { type: "BARGE_IN_ACK" };
    case "PROCESSING_TIMEOUT": return { type: "PROCESSING_TIMEOUT" };
    case "ERROR": return { type: "ERROR", error: "test error" };
    case "RECOVER": return { type: "RECOVER" };
    case "STOP": return { type: "STOP" };
    case "DISPOSE": return { type: "DISPOSE" };
  }
}
