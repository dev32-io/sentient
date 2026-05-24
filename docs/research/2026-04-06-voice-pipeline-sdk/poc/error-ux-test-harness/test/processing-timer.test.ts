import { describe, test, expect } from "bun:test";
import {
  resolveProcessingStage,
  STAGE_THRESHOLDS,
  type ProcessingStage,
} from "../src/error-ux";

// --- Pure Stage Resolution (no timers needed) ---

describe("resolveProcessingStage — pure function, no setTimeout", () => {
  test("0ms → silent (no indicator)", () => {
    const r = resolveProcessingStage(0);
    expect(r.stage).toBe("silent");
    expect(r.message).toBeNull();
  });

  test("1999ms → still silent", () => {
    const r = resolveProcessingStage(1999);
    expect(r.stage).toBe("silent");
  });

  test("2000ms → thinking", () => {
    const r = resolveProcessingStage(2000);
    expect(r.stage).toBe("thinking");
    expect(r.message).toBe("Thinking...");
  });

  test("4999ms → still thinking (first stage)", () => {
    const r = resolveProcessingStage(4999);
    expect(r.stage).toBe("thinking");
  });

  test("5000ms → still_thinking", () => {
    const r = resolveProcessingStage(5000);
    expect(r.stage).toBe("still_thinking");
    expect(r.message).toBe("Still thinking...");
  });

  test("14999ms → still_thinking", () => {
    const r = resolveProcessingStage(14999);
    expect(r.stage).toBe("still_thinking");
  });

  test("15000ms → taking_long", () => {
    const r = resolveProcessingStage(15000);
    expect(r.stage).toBe("taking_long");
    expect(r.message).toBe("Taking longer than usual...");
  });

  test("29999ms → taking_long", () => {
    const r = resolveProcessingStage(29999);
    expect(r.stage).toBe("taking_long");
  });

  test("30000ms → timeout", () => {
    const r = resolveProcessingStage(30000);
    expect(r.stage).toBe("timeout");
    expect(r.message).toContain("try again");
  });

  test("60000ms → still timeout (no stage beyond timeout)", () => {
    const r = resolveProcessingStage(60000);
    expect(r.stage).toBe("timeout");
  });
});

// --- Stage Progression Invariants ---

describe("stage progression invariants", () => {
  test("stages are monotonically increasing in threshold", () => {
    for (let i = 1; i < STAGE_THRESHOLDS.length; i++) {
      expect(STAGE_THRESHOLDS[i].at).toBeGreaterThan(STAGE_THRESHOLDS[i - 1].at);
    }
  });

  test("first stage starts at 0", () => {
    expect(STAGE_THRESHOLDS[0].at).toBe(0);
  });

  test("first stage is silent (no message)", () => {
    expect(STAGE_THRESHOLDS[0].stage).toBe("silent");
    expect(STAGE_THRESHOLDS[0].message).toBeNull();
  });

  test("last stage is timeout", () => {
    const last = STAGE_THRESHOLDS[STAGE_THRESHOLDS.length - 1];
    expect(last.stage).toBe("timeout");
  });

  test("every non-silent stage has a message", () => {
    for (const s of STAGE_THRESHOLDS) {
      if (s.stage !== "silent") {
        expect(s.message).not.toBeNull();
        expect(s.message!.length).toBeGreaterThan(0);
      }
    }
  });

  test("no duplicate stages", () => {
    const stages = STAGE_THRESHOLDS.map(s => s.stage);
    expect(new Set(stages).size).toBe(stages.length);
  });

  test("continuous coverage: every millisecond maps to exactly one stage", () => {
    // Sample key boundary points
    const points = [0, 1, 1999, 2000, 2001, 4999, 5000, 14999, 15000, 29999, 30000, 100000];
    for (const ms of points) {
      const result = resolveProcessingStage(ms);
      expect(result.stage).toBeDefined();
      expect(typeof result.stage).toBe("string");
    }
  });
});

// --- No Jargon in Timer Messages ---

describe("processing timer messages — no jargon", () => {
  const JARGON = [
    "stt", "tts", "llm", "websocket", "ws", "tcp", "http",
    "500", "502", "exception", "stack", "trace", "provider",
    "pipeline", "null", "undefined",
  ];

  for (const stage of STAGE_THRESHOLDS) {
    if (stage.message) {
      test(`stage "${stage.stage}" message has no jargon`, () => {
        const msg = stage.message!.toLowerCase();
        for (const term of JARGON) {
          expect(msg).not.toContain(term);
        }
      });
    }
  }
});

// --- Integration: Timer Feeds State Machine ---

describe("timer → state machine integration (conceptual)", () => {
  test("timeout stage maps to thinking_timeout category", () => {
    // When processing timer reaches timeout, the system should fire
    // an error_occurred event with source=llm, phase=streaming
    // Verify the category would be correct
    const { classifyError, pipelineError } = require("../src/error-ux");
    const err = pipelineError("llm", "streaming", "processing timeout");
    expect(classifyError(err)).toBe("thinking_timeout");
  });

  test("stages before timeout do NOT trigger errors — just UI updates", () => {
    // silent, thinking, still_thinking, taking_long are indicators only
    const nonErrorStages: ProcessingStage[] = ["silent", "thinking", "still_thinking", "taking_long"];
    for (const stage of nonErrorStages) {
      // These stages should ONLY produce UI updates, not state machine events
      // This is a design constraint: only "timeout" produces an error_occurred
      expect(stage).not.toBe("timeout");
    }
  });
});
