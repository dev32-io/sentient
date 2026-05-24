import { describe, test, expect } from "bun:test";
import {
  classifyError,
  pipelineError,
  inferSeverity,
  type ErrorSource,
  type ErrorPhase,
  type UserErrorCategory,
  type PipelineError,
} from "../src/error-ux";

// --- Exhaustive Classification Matrix ---

describe("classifyError — exhaustive source×phase matrix", () => {
  // Every source×phase combination must produce exactly one category
  const ALL_SOURCES: ErrorSource[] = ["stt", "llm", "tts", "auth", "network", "protocol"];
  const ALL_PHASES: ErrorPhase[] = ["connecting", "streaming", "finalizing", "idle"];

  const EXPECTED: Record<string, UserErrorCategory> = {
    "auth/connecting": "auth_required",
    "auth/streaming": "auth_required",
    "auth/finalizing": "auth_required",
    "auth/idle": "auth_required",
    "network/connecting": "connection_lost",
    "network/streaming": "connection_lost",
    "network/finalizing": "connection_lost",
    "network/idle": "connection_lost",
    "stt/connecting": "didnt_catch",
    "stt/streaming": "didnt_catch",
    "stt/finalizing": "didnt_catch",
    "stt/idle": "didnt_catch",
    "llm/connecting": "service_unavailable",
    "llm/streaming": "thinking_timeout",
    "llm/finalizing": "try_again",
    "llm/idle": "try_again",
    "tts/connecting": "try_again",
    "tts/streaming": "try_again",
    "tts/finalizing": "try_again",
    "tts/idle": "try_again",
    "protocol/connecting": "try_again",
    "protocol/streaming": "try_again",
    "protocol/finalizing": "try_again",
    "protocol/idle": "try_again",
  };

  for (const source of ALL_SOURCES) {
    for (const phase of ALL_PHASES) {
      const key = `${source}/${phase}`;
      test(`${key} → ${EXPECTED[key]}`, () => {
        const err = pipelineError(source, phase, `test ${key}`);
        const result = classifyError(err);
        expect(result).toBe(EXPECTED[key]);
      });
    }
  }

  test("no source×phase pair returns undefined", () => {
    for (const source of ALL_SOURCES) {
      for (const phase of ALL_PHASES) {
        const err = pipelineError(source, phase, "test");
        const result = classifyError(err);
        expect(result).toBeDefined();
        expect(typeof result).toBe("string");
      }
    }
  });
});

// --- Severity Inference ---

describe("inferSeverity", () => {
  test("auth is always fatal regardless of phase", () => {
    const phases: ErrorPhase[] = ["connecting", "streaming", "finalizing", "idle"];
    for (const phase of phases) {
      expect(inferSeverity("auth", phase)).toBe("fatal");
    }
  });

  test("network/idle is recoverable, other network phases are degraded", () => {
    expect(inferSeverity("network", "idle")).toBe("recoverable");
    expect(inferSeverity("network", "connecting")).toBe("degraded");
    expect(inferSeverity("network", "streaming")).toBe("degraded");
    expect(inferSeverity("network", "finalizing")).toBe("degraded");
  });

  test("connecting phase (non-auth, non-network) is recoverable", () => {
    expect(inferSeverity("stt", "connecting")).toBe("recoverable");
    expect(inferSeverity("llm", "connecting")).toBe("recoverable");
    expect(inferSeverity("tts", "connecting")).toBe("recoverable");
  });

  test("streaming phase (non-auth, non-network) is degraded", () => {
    expect(inferSeverity("stt", "streaming")).toBe("degraded");
    expect(inferSeverity("llm", "streaming")).toBe("degraded");
    expect(inferSeverity("tts", "streaming")).toBe("degraded");
  });

  test("finalizing and idle default to recoverable", () => {
    expect(inferSeverity("stt", "finalizing")).toBe("recoverable");
    expect(inferSeverity("tts", "idle")).toBe("recoverable");
    expect(inferSeverity("protocol", "idle")).toBe("recoverable");
  });
});

// --- PipelineError Factory ---

describe("pipelineError factory", () => {
  test("creates error with inferred severity", () => {
    const err = pipelineError("auth", "connecting", "bad token");
    expect(err.source).toBe("auth");
    expect(err.phase).toBe("connecting");
    expect(err.severity).toBe("fatal");
    expect(err.message).toBe("bad token");
    expect(err.isAbort).toBe(false);
  });

  test("preserves original error", () => {
    const orig = new Error("underlying");
    const err = pipelineError("stt", "streaming", "STT dropped", { originalError: orig });
    expect(err.originalError).toBe(orig);
  });

  test("abort flag defaults to false", () => {
    const err = pipelineError("stt", "streaming", "abort");
    expect(err.isAbort).toBe(false);
  });

  test("abort flag can be set", () => {
    const err = pipelineError("stt", "streaming", "barge-in", { isAbort: true });
    expect(err.isAbort).toBe(true);
  });
});

// --- Classification Stability ---

describe("classification stability", () => {
  test("same error classified twice returns same category", () => {
    const err = pipelineError("network", "streaming", "ws closed");
    expect(classifyError(err)).toBe(classifyError(err));
  });

  test("message content does not affect classification", () => {
    const a = pipelineError("stt", "streaming", "connection reset");
    const b = pipelineError("stt", "streaming", "timeout");
    const c = pipelineError("stt", "streaming", "unknown");
    expect(classifyError(a)).toBe(classifyError(b));
    expect(classifyError(b)).toBe(classifyError(c));
  });

  test("severity does not affect classification", () => {
    const err1: PipelineError = { source: "tts", phase: "streaming", severity: "recoverable", message: "a" };
    const err2: PipelineError = { source: "tts", phase: "streaming", severity: "fatal", message: "b" };
    expect(classifyError(err1)).toBe(classifyError(err2));
  });
});
