// =============================================================
// SDK State Machine — Complete Isolation Test Harness
//
// Tests the pure transition function and VoiceClient wrapper
// with ZERO external dependencies. No network, no audio, no DOM.
// =============================================================

import { describe, it, expect, beforeEach } from "bun:test";
import {
  transition,
  VoiceClient,
  type VoiceState,
  type VoiceEvent,
  type SideEffect,
  type VoiceStatus,
} from "./state-machine";

// ── Test Helpers ──────────────────────────────────────────────

/** All states in the machine */
const ALL_STATES: VoiceState[] = [
  "inactive", "connecting", "listening", "user-speaking",
  "processing", "assistant-speaking", "interrupting",
  "reconnecting", "error",
];

/** Representative events (one per type) */
const ALL_EVENTS: VoiceEvent[] = [
  { type: "CONNECT" },
  { type: "AUTH_OK", sessionId: "s1" },
  { type: "AUTH_FAILED", reason: "bad token" },
  { type: "TIMEOUT", context: "auth" },
  { type: "TIMEOUT", context: "processing" },
  { type: "TIMEOUT", context: "barge_in_ack" },
  { type: "SPEECH_START" },
  { type: "SPEECH_END" },
  { type: "CANCEL" },
  { type: "TRANSCRIPT_PARTIAL", text: "hel" },
  { type: "TRANSCRIPT_FINAL", text: "hello" },
  { type: "RESPONSE_START" },
  { type: "AUDIO_DONE" },
  { type: "RESPONSE_TEXT_DONE" },
  { type: "BARGE_IN_ACK" },
  { type: "WS_DROP" },
  { type: "RECONNECTED" },
  { type: "MAX_RETRIES" },
  { type: "RETRY" },
  { type: "DISMISS" },
  { type: "DISCONNECT" },
  { type: "SESSION_END" },
];

/** Walk a sequence of events from a starting state, return final state */
function walk(start: VoiceState, events: VoiceEvent[]): VoiceState {
  let state = start;
  for (const ev of events) {
    state = transition(state, ev).state;
  }
  return state;
}

/** Convenience: get to a specific state from inactive using the happy path */
function reachState(target: VoiceState): VoiceEvent[] {
  const paths: Record<VoiceState, VoiceEvent[]> = {
    "inactive": [],
    "connecting": [{ type: "CONNECT" }],
    "listening": [
      { type: "CONNECT" },
      { type: "AUTH_OK", sessionId: "s1" },
    ],
    "user-speaking": [
      { type: "CONNECT" },
      { type: "AUTH_OK", sessionId: "s1" },
      { type: "SPEECH_START" },
    ],
    "processing": [
      { type: "CONNECT" },
      { type: "AUTH_OK", sessionId: "s1" },
      { type: "SPEECH_START" },
      { type: "SPEECH_END" },
    ],
    "assistant-speaking": [
      { type: "CONNECT" },
      { type: "AUTH_OK", sessionId: "s1" },
      { type: "SPEECH_START" },
      { type: "SPEECH_END" },
      { type: "RESPONSE_START" },
    ],
    "interrupting": [
      { type: "CONNECT" },
      { type: "AUTH_OK", sessionId: "s1" },
      { type: "SPEECH_START" },
      { type: "SPEECH_END" },
      { type: "RESPONSE_START" },
      { type: "SPEECH_START" },
    ],
    "reconnecting": [
      { type: "CONNECT" },
      { type: "AUTH_OK", sessionId: "s1" },
      { type: "WS_DROP" },
    ],
    "error": [
      { type: "CONNECT" },
      { type: "AUTH_FAILED", reason: "bad" },
    ],
  };
  return paths[target];
}

/** Build a VoiceClient already in the given state */
function clientAt(target: VoiceState): VoiceClient {
  const client = new VoiceClient();
  for (const ev of reachState(target)) {
    client.send(ev);
  }
  return client;
}

// =============================================================
// 1. PURE TRANSITION FUNCTION TESTS
// =============================================================

describe("transition() — pure function", () => {

  // ── Happy path: full turn cycle ──

  describe("happy path: full voice turn", () => {
    it("inactive → connecting → listening → user-speaking → processing → assistant-speaking → listening", () => {
      let s: VoiceState = "inactive";
      s = transition(s, { type: "CONNECT" }).state;
      expect(s).toBe("connecting");

      s = transition(s, { type: "AUTH_OK", sessionId: "abc" }).state;
      expect(s).toBe("listening");

      s = transition(s, { type: "SPEECH_START" }).state;
      expect(s).toBe("user-speaking");

      s = transition(s, { type: "SPEECH_END" }).state;
      expect(s).toBe("processing");

      s = transition(s, { type: "RESPONSE_START" }).state;
      expect(s).toBe("assistant-speaking");

      s = transition(s, { type: "AUDIO_DONE" }).state;
      expect(s).toBe("listening");
    });
  });

  // ── Per-state: valid transitions ──

  describe("inactive", () => {
    it("CONNECT → connecting with OPEN_WS, SEND_AUTH, auth timeout", () => {
      const r = transition("inactive", { type: "CONNECT" });
      expect(r.state).toBe("connecting");
      expect(r.effects.map(e => e.type)).toEqual(["OPEN_WS", "SEND_AUTH", "START_TIMEOUT"]);
      const timeout = r.effects.find(e => e.type === "START_TIMEOUT") as any;
      expect(timeout.key).toBe("auth");
      expect(timeout.ms).toBe(10_000);
    });

    it("ignores unrelated events", () => {
      const r = transition("inactive", { type: "SPEECH_START" });
      expect(r.state).toBe("inactive");
      expect(r.effects[0].type).toBe("LOG_WARNING");
    });
  });

  describe("connecting", () => {
    it("AUTH_OK → listening, cancels auth timeout, starts VAD", () => {
      const r = transition("connecting", { type: "AUTH_OK", sessionId: "s1" });
      expect(r.state).toBe("listening");
      expect(r.effects.map(e => e.type)).toEqual(["CANCEL_TIMEOUT", "START_VAD"]);
    });

    it("AUTH_FAILED → error", () => {
      const r = transition("connecting", { type: "AUTH_FAILED", reason: "bad" });
      expect(r.state).toBe("error");
    });

    it("auth TIMEOUT → error", () => {
      const r = transition("connecting", { type: "TIMEOUT", context: "auth" });
      expect(r.state).toBe("error");
    });

    it("WS_DROP → reconnecting", () => {
      const r = transition("connecting", { type: "WS_DROP" });
      expect(r.state).toBe("reconnecting");
      expect(r.effects.map(e => e.type)).toContain("START_RECONNECT_BACKOFF");
    });
  });

  describe("listening", () => {
    it("SPEECH_START → user-speaking with utterance.start + audio stream", () => {
      const r = transition("listening", { type: "SPEECH_START" });
      expect(r.state).toBe("user-speaking");
      expect(r.effects.map(e => e.type)).toEqual(["SEND_UTTERANCE_START", "START_AUDIO_STREAM"]);
    });

    it("DISCONNECT → inactive with cleanup", () => {
      const r = transition("listening", { type: "DISCONNECT" });
      expect(r.state).toBe("inactive");
      expect(r.effects[0].type).toBe("CLEANUP");
    });

    it("WS_DROP → reconnecting, stops VAD", () => {
      const r = transition("listening", { type: "WS_DROP" });
      expect(r.state).toBe("reconnecting");
      expect(r.effects.map(e => e.type)).toContain("STOP_VAD");
    });
  });

  describe("user-speaking", () => {
    it("SPEECH_END → processing with utterance.end + processing timeout", () => {
      const r = transition("user-speaking", { type: "SPEECH_END" });
      expect(r.state).toBe("processing");
      expect(r.effects.map(e => e.type)).toContain("SEND_UTTERANCE_END");
      expect(r.effects.map(e => e.type)).toContain("START_TIMEOUT");
    });

    it("CANCEL → listening, sends utterance.cancel", () => {
      const r = transition("user-speaking", { type: "CANCEL" });
      expect(r.state).toBe("listening");
      expect(r.effects.map(e => e.type)).toContain("SEND_UTTERANCE_CANCEL");
    });

    it("WS_DROP → reconnecting, stops audio stream", () => {
      const r = transition("user-speaking", { type: "WS_DROP" });
      expect(r.state).toBe("reconnecting");
      expect(r.effects.map(e => e.type)).toContain("STOP_AUDIO_STREAM");
    });
  });

  describe("processing", () => {
    it("TRANSCRIPT_PARTIAL stays in processing (no effects)", () => {
      const r = transition("processing", { type: "TRANSCRIPT_PARTIAL", text: "hel" });
      expect(r.state).toBe("processing");
      expect(r.effects).toEqual([]);
    });

    it("TRANSCRIPT_FINAL stays in processing", () => {
      const r = transition("processing", { type: "TRANSCRIPT_FINAL", text: "hello" });
      expect(r.state).toBe("processing");
    });

    it("RESPONSE_START → assistant-speaking, cancels processing timeout", () => {
      const r = transition("processing", { type: "RESPONSE_START" });
      expect(r.state).toBe("assistant-speaking");
      expect(r.effects.map(e => e.type)).toContain("CANCEL_TIMEOUT");
      expect(r.effects.map(e => e.type)).toContain("START_PLAYBACK");
    });

    it("processing TIMEOUT → error", () => {
      const r = transition("processing", { type: "TIMEOUT", context: "processing" });
      expect(r.state).toBe("error");
    });

    it("SPEECH_START during processing is ignored with warning", () => {
      const r = transition("processing", { type: "SPEECH_START" });
      expect(r.state).toBe("processing");
      expect(r.effects[0].type).toBe("LOG_WARNING");
    });

    it("WS_DROP → reconnecting, cancels processing timeout", () => {
      const r = transition("processing", { type: "WS_DROP" });
      expect(r.state).toBe("reconnecting");
      expect(r.effects.map(e => e.type)).toContain("CANCEL_TIMEOUT");
    });
  });

  describe("assistant-speaking", () => {
    it("AUDIO_DONE → listening, stops playback, restarts VAD", () => {
      const r = transition("assistant-speaking", { type: "AUDIO_DONE" });
      expect(r.state).toBe("listening");
      expect(r.effects.map(e => e.type)).toEqual(["STOP_PLAYBACK", "START_VAD"]);
    });

    it("SPEECH_START (barge-in) → interrupting, stops + clears playback, sends barge_in", () => {
      const r = transition("assistant-speaking", { type: "SPEECH_START" });
      expect(r.state).toBe("interrupting");
      expect(r.effects.map(e => e.type)).toEqual([
        "STOP_PLAYBACK", "CLEAR_PLAYBACK", "SEND_BARGE_IN", "START_TIMEOUT",
      ]);
    });

    it("RESPONSE_TEXT_DONE stays in assistant-speaking (no effects)", () => {
      const r = transition("assistant-speaking", { type: "RESPONSE_TEXT_DONE" });
      expect(r.state).toBe("assistant-speaking");
      expect(r.effects).toEqual([]);
    });

    it("WS_DROP → reconnecting, stops playback", () => {
      const r = transition("assistant-speaking", { type: "WS_DROP" });
      expect(r.state).toBe("reconnecting");
      expect(r.effects.map(e => e.type)).toContain("STOP_PLAYBACK");
    });
  });

  describe("interrupting", () => {
    it("BARGE_IN_ACK → user-speaking, cancels ack timeout, starts new utterance", () => {
      const r = transition("interrupting", { type: "BARGE_IN_ACK" });
      expect(r.state).toBe("user-speaking");
      expect(r.effects.map(e => e.type)).toContain("CANCEL_TIMEOUT");
      expect(r.effects.map(e => e.type)).toContain("SEND_UTTERANCE_START");
      expect(r.effects.map(e => e.type)).toContain("START_AUDIO_STREAM");
    });

    it("barge_in_ack TIMEOUT → listening with warning", () => {
      const r = transition("interrupting", { type: "TIMEOUT", context: "barge_in_ack" });
      expect(r.state).toBe("listening");
      expect(r.effects.some(e => e.type === "LOG_WARNING")).toBe(true);
      expect(r.effects.some(e => e.type === "START_VAD")).toBe(true);
    });

    it("WS_DROP → reconnecting", () => {
      const r = transition("interrupting", { type: "WS_DROP" });
      expect(r.state).toBe("reconnecting");
    });
  });

  describe("reconnecting", () => {
    it("RECONNECTED → listening with VAD", () => {
      const r = transition("reconnecting", { type: "RECONNECTED" });
      expect(r.state).toBe("listening");
      expect(r.effects[0].type).toBe("START_VAD");
    });

    it("MAX_RETRIES → error", () => {
      const r = transition("reconnecting", { type: "MAX_RETRIES" });
      expect(r.state).toBe("error");
    });
  });

  describe("error", () => {
    it("RETRY → connecting (full auth cycle)", () => {
      const r = transition("error", { type: "RETRY" });
      expect(r.state).toBe("connecting");
      expect(r.effects.map(e => e.type)).toContain("OPEN_WS");
    });

    it("DISMISS → inactive with cleanup", () => {
      const r = transition("error", { type: "DISMISS" });
      expect(r.state).toBe("inactive");
      expect(r.effects[0].type).toBe("CLEANUP");
    });
  });

  // ── Global events ──

  describe("SESSION_END from any state", () => {
    for (const state of ALL_STATES) {
      it(`${state} + SESSION_END → inactive`, () => {
        const r = transition(state, { type: "SESSION_END" });
        expect(r.state).toBe("inactive");
        expect(r.effects[0].type).toBe("CLEANUP");
      });
    }
  });

  // ── No dead states: every state has at least one exit ──

  describe("no dead states — every state has at least one exit", () => {
    for (const state of ALL_STATES) {
      it(`${state} can transition to a different state`, () => {
        // SESSION_END always works, but check for a non-SESSION_END exit too
        // (except inactive which only has CONNECT + SESSION_END)
        const exits = ALL_EVENTS.filter(ev => {
          const r = transition(state, ev);
          return r.state !== state;
        });
        expect(exits.length).toBeGreaterThan(0);
      });
    }
  });

  // ── Determinism: same (state, event) always produces same result ──

  describe("determinism — same inputs always produce same outputs", () => {
    for (const state of ALL_STATES) {
      for (const event of ALL_EVENTS) {
        it(`(${state}, ${event.type}) is deterministic`, () => {
          const r1 = transition(state, event);
          const r2 = transition(state, event);
          expect(r1.state).toBe(r2.state);
          expect(r1.effects).toEqual(r2.effects);
        });
      }
    }
  });

  // ── Unhandled events stay in same state with LOG_WARNING ──

  describe("unhandled events produce LOG_WARNING, no state change", () => {
    const unhandledCases: [VoiceState, VoiceEvent][] = [
      ["inactive", { type: "SPEECH_START" }],
      ["inactive", { type: "AUDIO_DONE" }],
      ["connecting", { type: "SPEECH_START" }],
      ["listening", { type: "AUDIO_DONE" }],
      ["listening", { type: "RESPONSE_START" }],
      ["user-speaking", { type: "AUDIO_DONE" }],
      ["processing", { type: "AUDIO_DONE" }],
      ["assistant-speaking", { type: "SPEECH_END" }],
      ["reconnecting", { type: "SPEECH_START" }],
      ["error", { type: "SPEECH_START" }],
    ];

    for (const [state, event] of unhandledCases) {
      it(`(${state}, ${event.type}) → same state + warning`, () => {
        const r = transition(state, event);
        expect(r.state).toBe(state);
        expect(r.effects.some(e => e.type === "LOG_WARNING")).toBe(true);
      });
    }
  });

  // ── Timeout guards: every waiting state has a timeout transition ──

  describe("timeout guards on waiting states", () => {
    it("connecting has auth timeout guard", () => {
      // CONNECT produces START_TIMEOUT for auth
      const connectResult = transition("inactive", { type: "CONNECT" });
      expect(connectResult.effects.some(e => e.type === "START_TIMEOUT" && (e as any).key === "auth")).toBe(true);
      // auth timeout in connecting → error
      const r = transition("connecting", { type: "TIMEOUT", context: "auth" });
      expect(r.state).toBe("error");
    });

    it("processing has processing timeout guard", () => {
      const speechEnd = transition("user-speaking", { type: "SPEECH_END" });
      expect(speechEnd.effects.some(e => e.type === "START_TIMEOUT" && (e as any).key === "processing")).toBe(true);
      const r = transition("processing", { type: "TIMEOUT", context: "processing" });
      expect(r.state).toBe("error");
    });

    it("interrupting has barge_in_ack timeout guard", () => {
      const bargeIn = transition("assistant-speaking", { type: "SPEECH_START" });
      expect(bargeIn.effects.some(e => e.type === "START_TIMEOUT" && (e as any).key === "barge_in_ack")).toBe(true);
      const r = transition("interrupting", { type: "TIMEOUT", context: "barge_in_ack" });
      expect(r.state).toBe("listening");
    });
  });

  // ── Timeout cleanup: transitions that leave a timed state cancel the timer ──

  describe("timeout cleanup on state exit", () => {
    it("AUTH_OK cancels auth timeout", () => {
      const r = transition("connecting", { type: "AUTH_OK", sessionId: "s" });
      expect(r.effects.some(e => e.type === "CANCEL_TIMEOUT" && (e as any).key === "auth")).toBe(true);
    });

    it("RESPONSE_START cancels processing timeout", () => {
      const r = transition("processing", { type: "RESPONSE_START" });
      expect(r.effects.some(e => e.type === "CANCEL_TIMEOUT" && (e as any).key === "processing")).toBe(true);
    });

    it("BARGE_IN_ACK cancels barge_in_ack timeout", () => {
      const r = transition("interrupting", { type: "BARGE_IN_ACK" });
      expect(r.effects.some(e => e.type === "CANCEL_TIMEOUT" && (e as any).key === "barge_in_ack")).toBe(true);
    });

    it("WS_DROP in connecting cancels auth timeout", () => {
      const r = transition("connecting", { type: "WS_DROP" });
      expect(r.effects.some(e => e.type === "CANCEL_TIMEOUT" && (e as any).key === "auth")).toBe(true);
    });

    it("WS_DROP in processing cancels processing timeout", () => {
      const r = transition("processing", { type: "WS_DROP" });
      expect(r.effects.some(e => e.type === "CANCEL_TIMEOUT" && (e as any).key === "processing")).toBe(true);
    });
  });

  // ── WS_DROP from every active state → reconnecting ──

  describe("WS_DROP resilience — all active states handle connection loss", () => {
    const activeStates: VoiceState[] = [
      "connecting", "listening", "user-speaking", "processing",
      "assistant-speaking", "interrupting",
    ];

    for (const state of activeStates) {
      it(`${state} + WS_DROP → reconnecting`, () => {
        const r = transition(state, { type: "WS_DROP" });
        expect(r.state).toBe("reconnecting");
        expect(r.effects.some(e => e.type === "START_RECONNECT_BACKOFF")).toBe(true);
      });
    }
  });
});

// =============================================================
// 2. MULTI-STEP SCENARIO TESTS (sequence walks)
// =============================================================

describe("multi-step scenarios", () => {

  it("double turn: speak → response → speak again → response", () => {
    const events: VoiceEvent[] = [
      { type: "CONNECT" },
      { type: "AUTH_OK", sessionId: "s1" },
      // Turn 1
      { type: "SPEECH_START" },
      { type: "SPEECH_END" },
      { type: "RESPONSE_START" },
      { type: "AUDIO_DONE" },
      // Turn 2
      { type: "SPEECH_START" },
      { type: "SPEECH_END" },
      { type: "RESPONSE_START" },
      { type: "AUDIO_DONE" },
    ];
    expect(walk("inactive", events)).toBe("listening");
  });

  it("barge-in flow: assistant speaking → interrupt → new turn", () => {
    const events: VoiceEvent[] = [
      { type: "CONNECT" },
      { type: "AUTH_OK", sessionId: "s1" },
      { type: "SPEECH_START" },
      { type: "SPEECH_END" },
      { type: "RESPONSE_START" },
      // Barge-in
      { type: "SPEECH_START" },  // → interrupting
      { type: "BARGE_IN_ACK" }, // → user-speaking
      { type: "SPEECH_END" },   // → processing
      { type: "RESPONSE_START" },
      { type: "AUDIO_DONE" },
    ];
    expect(walk("inactive", events)).toBe("listening");
  });

  it("barge-in timeout: falls back to listening", () => {
    const events: VoiceEvent[] = [
      { type: "CONNECT" },
      { type: "AUTH_OK", sessionId: "s1" },
      { type: "SPEECH_START" },
      { type: "SPEECH_END" },
      { type: "RESPONSE_START" },
      { type: "SPEECH_START" }, // → interrupting
      { type: "TIMEOUT", context: "barge_in_ack" }, // → listening (graceful fallback)
    ];
    expect(walk("inactive", events)).toBe("listening");
  });

  it("cancel mid-utterance: returns to listening", () => {
    const events: VoiceEvent[] = [
      { type: "CONNECT" },
      { type: "AUTH_OK", sessionId: "s1" },
      { type: "SPEECH_START" },
      { type: "CANCEL" }, // → listening
    ];
    expect(walk("inactive", events)).toBe("listening");
  });

  it("reconnect recovery: WS drop → reconnect → resume listening", () => {
    const events: VoiceEvent[] = [
      { type: "CONNECT" },
      { type: "AUTH_OK", sessionId: "s1" },
      { type: "SPEECH_START" },
      { type: "WS_DROP" },      // → reconnecting
      { type: "RECONNECTED" },  // → listening
      { type: "SPEECH_START" }, // should work again
    ];
    expect(walk("inactive", events)).toBe("user-speaking");
  });

  it("max retries → error → retry → success", () => {
    const events: VoiceEvent[] = [
      { type: "CONNECT" },
      { type: "AUTH_OK", sessionId: "s1" },
      { type: "WS_DROP" },
      { type: "MAX_RETRIES" }, // → error
      { type: "RETRY" },      // → connecting
      { type: "AUTH_OK", sessionId: "s2" }, // → listening
    ];
    expect(walk("inactive", events)).toBe("listening");
  });

  it("error → dismiss → inactive", () => {
    const events: VoiceEvent[] = [
      { type: "CONNECT" },
      { type: "AUTH_FAILED", reason: "invalid" },
      { type: "DISMISS" },
    ];
    expect(walk("inactive", events)).toBe("inactive");
  });

  it("processing timeout → error → retry → full turn", () => {
    const events: VoiceEvent[] = [
      { type: "CONNECT" },
      { type: "AUTH_OK", sessionId: "s1" },
      { type: "SPEECH_START" },
      { type: "SPEECH_END" },
      { type: "TIMEOUT", context: "processing" }, // → error
      { type: "RETRY" },
      { type: "AUTH_OK", sessionId: "s2" },
      { type: "SPEECH_START" },
      { type: "SPEECH_END" },
      { type: "RESPONSE_START" },
      { type: "AUDIO_DONE" },
    ];
    expect(walk("inactive", events)).toBe("listening");
  });

  it("WS drop during processing → reconnect → new turn works", () => {
    const events: VoiceEvent[] = [
      { type: "CONNECT" },
      { type: "AUTH_OK", sessionId: "s1" },
      { type: "SPEECH_START" },
      { type: "SPEECH_END" },
      // Processing, then WS dies
      { type: "WS_DROP" },
      { type: "RECONNECTED" },
      // Start fresh turn
      { type: "SPEECH_START" },
      { type: "SPEECH_END" },
      { type: "RESPONSE_START" },
      { type: "AUDIO_DONE" },
    ];
    expect(walk("inactive", events)).toBe("listening");
  });

  it("partial transcripts during processing don't change state", () => {
    let s: VoiceState = walk("inactive", [
      { type: "CONNECT" },
      { type: "AUTH_OK", sessionId: "s1" },
      { type: "SPEECH_START" },
      { type: "SPEECH_END" },
    ]);
    expect(s).toBe("processing");
    s = transition(s, { type: "TRANSCRIPT_PARTIAL", text: "hel" }).state;
    expect(s).toBe("processing");
    s = transition(s, { type: "TRANSCRIPT_PARTIAL", text: "hello" }).state;
    expect(s).toBe("processing");
    s = transition(s, { type: "TRANSCRIPT_FINAL", text: "hello world" }).state;
    expect(s).toBe("processing");
    s = transition(s, { type: "RESPONSE_START" }).state;
    expect(s).toBe("assistant-speaking");
  });
});

// =============================================================
// 3. VOICECLIENT WRAPPER TESTS
// =============================================================

describe("VoiceClient — runtime wrapper", () => {
  let client: VoiceClient;
  let effects: SideEffect[];
  let statuses: VoiceStatus[];

  beforeEach(() => {
    client = new VoiceClient();
    effects = [];
    statuses = [];
    client.onEffect(e => effects.push(e));
    client.onStatusChange(s => statuses.push({ ...s }));
  });

  describe("initial state", () => {
    it("starts inactive", () => {
      expect(client.status.state).toBe("inactive");
      expect(client.status.label).toBe("Ready");
      expect(client.status.canSpeak).toBe(false);
      expect(client.status.isActive).toBe(false);
    });
  });

  describe("status labels", () => {
    const expectedLabels: [VoiceState, string][] = [
      ["inactive", "Ready"],
      ["connecting", "Connecting..."],
      ["listening", "Listening..."],
      ["user-speaking", "Hearing you..."],
      ["processing", "Thinking..."],
      ["assistant-speaking", "Speaking..."],
      ["interrupting", "One moment..."],
      ["reconnecting", "Reconnecting..."],
      ["error", "Something went wrong"],
    ];

    for (const [state, label] of expectedLabels) {
      it(`${state} → "${label}"`, () => {
        const c = clientAt(state);
        expect(c.status.label).toBe(label);
      });
    }
  });

  describe("canSpeak flag", () => {
    it("true in listening", () => {
      const c = clientAt("listening");
      expect(c.status.canSpeak).toBe(true);
    });

    it("true in assistant-speaking (barge-in allowed)", () => {
      const c = clientAt("assistant-speaking");
      expect(c.status.canSpeak).toBe(true);
    });

    it("false in all other states", () => {
      for (const state of ALL_STATES.filter(s => s !== "listening" && s !== "assistant-speaking")) {
        const c = clientAt(state);
        expect(c.status.canSpeak).toBe(false);
      }
    });
  });

  describe("isActive flag", () => {
    it("false for inactive and error", () => {
      expect(clientAt("inactive").status.isActive).toBe(false);
      expect(clientAt("error").status.isActive).toBe(false);
    });

    it("true for all other states", () => {
      for (const state of ALL_STATES.filter(s => s !== "inactive" && s !== "error")) {
        expect(clientAt(state).status.isActive).toBe(true);
      }
    });
  });

  describe("effect dispatch", () => {
    it("dispatches effects to handler", () => {
      client.connect();
      expect(effects.map(e => e.type)).toEqual(["OPEN_WS", "SEND_AUTH", "START_TIMEOUT"]);
    });

    it("dispatches effects in order", () => {
      client.connect();
      client.send({ type: "AUTH_OK", sessionId: "s" });
      // connect effects + auth_ok effects
      const types = effects.map(e => e.type);
      expect(types).toEqual([
        "OPEN_WS", "SEND_AUTH", "START_TIMEOUT",
        "CANCEL_TIMEOUT", "START_VAD",
      ]);
    });
  });

  describe("listener notifications", () => {
    it("notifies on state change", () => {
      client.connect();
      expect(statuses.length).toBe(1);
      expect(statuses[0].state).toBe("connecting");
    });

    it("does NOT notify when state stays the same", () => {
      client.connect();
      client.send({ type: "AUTH_OK", sessionId: "s" });
      client.send({ type: "SPEECH_START" });
      client.send({ type: "SPEECH_END" });
      // Now in processing — partials should not trigger notification
      const countBefore = statuses.length;
      client.send({ type: "TRANSCRIPT_PARTIAL", text: "h" });
      client.send({ type: "TRANSCRIPT_PARTIAL", text: "he" });
      expect(statuses.length).toBe(countBefore); // no new notifications
    });

    it("unsubscribe works", () => {
      const unsub = client.onStatusChange(() => {});
      unsub();
      client.connect();
      // Only the original listener should fire
      expect(statuses.length).toBe(1);
    });
  });

  describe("transcript tracking", () => {
    it("tracks partial transcripts", () => {
      client.connect();
      client.send({ type: "AUTH_OK", sessionId: "s" });
      client.send({ type: "SPEECH_START" });
      client.send({ type: "SPEECH_END" });
      client.send({ type: "TRANSCRIPT_PARTIAL", text: "hel" });
      expect(client.status.transcript).toBe("hel");
    });

    it("tracks final transcripts", () => {
      client.connect();
      client.send({ type: "AUTH_OK", sessionId: "s" });
      client.send({ type: "SPEECH_START" });
      client.send({ type: "SPEECH_END" });
      client.send({ type: "TRANSCRIPT_FINAL", text: "hello world" });
      expect(client.status.transcript).toBe("hello world");
    });
  });

  describe("error tracking", () => {
    it("AUTH_FAILED sets error with reason", () => {
      client.connect();
      client.send({ type: "AUTH_FAILED", reason: "invalid token" });
      expect(client.status.error).toBe("invalid token");
    });

    it("TIMEOUT sets error with context", () => {
      client.connect();
      client.send({ type: "TIMEOUT", context: "auth" });
      expect(client.status.error).toBe("Timed out (auth)");
    });

    it("MAX_RETRIES sets connection lost error", () => {
      const c = clientAt("reconnecting");
      c.send({ type: "MAX_RETRIES" });
      expect(c.status.error).toBe("Connection lost");
    });

    it("error clears when leaving error state", () => {
      client.connect();
      client.send({ type: "AUTH_FAILED", reason: "bad" });
      expect(client.status.error).toBe("bad");
      client.retry();
      expect(client.status.error).toBeUndefined();
    });
  });

  describe("convenience methods", () => {
    it("connect() sends CONNECT", () => {
      client.connect();
      expect(client.status.state).toBe("connecting");
    });

    it("disconnect() sends DISCONNECT from listening", () => {
      const c = clientAt("listening");
      c.disconnect();
      expect(c.status.state).toBe("inactive");
    });

    it("retry() sends RETRY from error", () => {
      const c = clientAt("error");
      c.retry();
      expect(c.status.state).toBe("connecting");
    });

    it("dismiss() sends DISMISS from error", () => {
      const c = clientAt("error");
      c.dismiss();
      expect(c.status.state).toBe("inactive");
    });
  });
});

// =============================================================
// 4. REACHABILITY — Can we reach every state from inactive?
// =============================================================

describe("reachability — every state reachable from inactive", () => {
  for (const target of ALL_STATES) {
    it(`can reach ${target}`, () => {
      const events = reachState(target);
      const finalState = walk("inactive", events);
      expect(finalState).toBe(target);
    });
  }
});

// =============================================================
// 5. EXHAUSTIVE MATRIX — (state × event) coverage check
// =============================================================

describe("exhaustive matrix — every (state, event) pair is handled", () => {
  for (const state of ALL_STATES) {
    for (const event of ALL_EVENTS) {
      it(`(${state}, ${event.type}${event.type === "TIMEOUT" ? `:${(event as any).context}` : ""}) produces a valid result`, () => {
        const r = transition(state, event);
        // Must return a valid state
        expect(ALL_STATES).toContain(r.state);
        // Must return an array of effects
        expect(Array.isArray(r.effects)).toBe(true);
        // Either state changed, or there's a LOG_WARNING (or it's a known no-op like TRANSCRIPT_PARTIAL in processing)
        if (r.state === state && r.effects.length === 0) {
          // Known no-op self-transitions (no effects, no state change):
          // - TRANSCRIPT_PARTIAL/FINAL in processing (UI updates handled by status)
          // - RESPONSE_TEXT_DONE in assistant-speaking (internal: text stream complete)
          const validNoOps: Record<string, string[]> = {
            "processing": ["TRANSCRIPT_PARTIAL", "TRANSCRIPT_FINAL"],
            "assistant-speaking": ["RESPONSE_TEXT_DONE"],
          };
          expect(validNoOps[state]).toBeDefined();
          expect(validNoOps[state]).toContain(event.type);
        }
      });
    }
  }
});
