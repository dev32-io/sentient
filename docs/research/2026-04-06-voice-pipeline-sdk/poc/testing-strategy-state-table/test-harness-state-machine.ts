/**
 * Testing Strategy State Machine — Test Harness Lifecycle
 *
 * Models the complete lifecycle of a test harness that orchestrates
 * mock providers (STT, LLM, TTS) through setup → execution → teardown,
 * covering: provider configuration, connection management, event emission,
 * failure injection, and cleanup.
 *
 * This models the MOCK PROVIDER test harness — the component that wires
 * mock providers together for integration/contract tests. Each mock provider
 * has its own sub-lifecycle managed by this harness.
 *
 * Pure function: (state, event) → { state, effects[] }
 * No side effects, no I/O. Effects are descriptors the caller interprets.
 */

// ─── Types ───────────────────────────────────────────────────────────

export interface MockProviderConfig {
  stt?: { transcripts: string[]; delayMs?: number; failAfter?: number };
  llm?: { tokens: string[]; delayMs?: number; failAfter?: number };
  tts?: { chunkCount: number; chunkSize?: number; delayMs?: number; failAfter?: number };
}

export interface TestAssertion {
  type: "event_sequence" | "state_check" | "effect_check" | "timing_check";
  description: string;
}

// ─── States ───────────────────────────────────────────────────────────

export type HarnessState =
  | "idle"               // No test configured, initial state
  | "configuring"        // Mock providers being set up with behaviors
  | "ready"              // All mocks configured, pipeline wired, ready to run
  | "running"            // Test execution in progress — events flowing through pipeline
  | "injecting_failure"  // Failure injection triggered mid-run (simulating provider crash)
  | "collecting"         // Test complete, collecting emitted events for assertions
  | "asserting"          // Running assertions against collected events
  | "tearing_down"      // Cleaning up providers, connections, abort controllers
  | "passed"            // Terminal — all assertions passed
  | "failed"            // Terminal — at least one assertion failed
  | "error";            // Harness-level error (not test failure — infrastructure problem)

// ─── Events ───────────────────────────────────────────────────────────

export type HarnessEvent =
  | { type: "CONFIGURE"; config: MockProviderConfig }       // Set up mock behaviors
  | { type: "ADD_ASSERTION"; assertion: TestAssertion }      // Add assertion to check later
  | { type: "WIRE_PIPELINE" }                                // Connect mock providers into pipeline
  | { type: "START_RUN" }                                    // Begin test execution
  | { type: "PROVIDER_EVENT"; provider: string; data: unknown } // Mock provider emits event
  | { type: "INJECT_FAILURE"; provider: string; error: string } // Trigger failure in mock
  | { type: "FAILURE_PROPAGATED" }                           // Failure reached pipeline error handler
  | { type: "PIPELINE_COMPLETE" }                            // Pipeline finished (success or handled error)
  | { type: "PIPELINE_TIMEOUT" }                             // Pipeline didn't complete in time
  | { type: "RUN_ASSERTIONS" }                               // Start checking assertions
  | { type: "ASSERTION_PASSED" }                             // One assertion passed
  | { type: "ASSERTION_FAILED"; reason: string }             // One assertion failed
  | { type: "ALL_ASSERTIONS_DONE"; allPassed: boolean }      // All assertions checked
  | { type: "TEARDOWN" }                                     // Clean up resources
  | { type: "TEARDOWN_COMPLETE" }                            // Cleanup finished
  | { type: "HARNESS_ERROR"; error: string }                 // Infrastructure error
  | { type: "RESET" };                                       // Reset to idle for next test

// ─── Effects ──────────────────────────────────────────────────────────

export type HarnessEffect =
  | { type: "CREATE_MOCK_STT"; config: MockProviderConfig["stt"] }
  | { type: "CREATE_MOCK_LLM"; config: MockProviderConfig["llm"] }
  | { type: "CREATE_MOCK_TTS"; config: MockProviderConfig["tts"] }
  | { type: "WIRE_PROVIDERS" }
  | { type: "START_PIPELINE" }
  | { type: "RECORD_EVENT"; provider: string; data: unknown }
  | { type: "TRIGGER_PROVIDER_FAILURE"; provider: string; error: string }
  | { type: "ABORT_PIPELINE" }
  | { type: "COLLECT_EVENTS" }
  | { type: "CHECK_ASSERTION"; assertion: TestAssertion }
  | { type: "DISCONNECT_PROVIDERS" }
  | { type: "RELEASE_RESOURCES" }
  | { type: "EMIT_STATE"; state: HarnessState }
  | { type: "EMIT_RESULT"; passed: boolean; reason?: string }
  | { type: "START_TIMER"; name: string; durationMs: number }
  | { type: "CANCEL_TIMER"; name: string }
  | { type: "LOG_ERROR"; error: string };

// ─── Context ──────────────────────────────────────────────────────────

export interface HarnessContext {
  state: HarnessState;
  config: MockProviderConfig | null;
  assertions: TestAssertion[];
  pendingAssertions: number;
  collectedEvents: Array<{ provider: string; data: unknown }>;
  failureReasons: string[];
  /** Whether pipeline wiring is complete */
  pipelineWired: boolean;
}

export interface TransitionResult {
  context: HarnessContext;
  effects: HarnessEffect[];
}

// ─── Constants ────────────────────────────────────────────────────────

const PIPELINE_TIMEOUT_MS = 10_000;
const TEARDOWN_TIMEOUT_MS = 5_000;

// ─── Initial Context ──────────────────────────────────────────────────

export function initialContext(): HarnessContext {
  return {
    state: "idle",
    config: null,
    assertions: [],
    pendingAssertions: 0,
    collectedEvents: [],
    failureReasons: [],
    pipelineWired: false,
  };
}

// ─── Transition Function ──────────────────────────────────────────────

export function transition(ctx: HarnessContext, event: HarnessEvent): TransitionResult {
  const { state } = ctx;

  // HARNESS_ERROR is valid from any non-terminal state
  if (event.type === "HARNESS_ERROR" && state !== "passed" && state !== "failed" && state !== "error") {
    return {
      context: { ...ctx, state: "error", failureReasons: [...ctx.failureReasons, event.error] },
      effects: [
        { type: "CANCEL_TIMER", name: "pipeline" },
        { type: "CANCEL_TIMER", name: "teardown" },
        { type: "ABORT_PIPELINE" },
        { type: "LOG_ERROR", error: event.error },
        { type: "EMIT_STATE", state: "error" },
      ],
    };
  }

  // RESET is valid from terminal/error states
  if (event.type === "RESET" && (state === "passed" || state === "failed" || state === "error")) {
    const fresh = initialContext();
    return {
      context: fresh,
      effects: [{ type: "EMIT_STATE", state: "idle" }],
    };
  }

  switch (state) {
    // ─── IDLE ──────────────────────────────────────────────
    case "idle": {
      if (event.type === "CONFIGURE") {
        const effects: HarnessEffect[] = [{ type: "EMIT_STATE", state: "configuring" }];
        if (event.config.stt) effects.push({ type: "CREATE_MOCK_STT", config: event.config.stt });
        if (event.config.llm) effects.push({ type: "CREATE_MOCK_LLM", config: event.config.llm });
        if (event.config.tts) effects.push({ type: "CREATE_MOCK_TTS", config: event.config.tts });
        return {
          context: { ...ctx, state: "configuring", config: event.config },
          effects,
        };
      }
      break;
    }

    // ─── CONFIGURING ──────────────────────────────────────
    case "configuring": {
      if (event.type === "ADD_ASSERTION") {
        return {
          context: {
            ...ctx,
            assertions: [...ctx.assertions, event.assertion],
            pendingAssertions: ctx.pendingAssertions + 1,
          },
          effects: [],
        };
      }
      if (event.type === "WIRE_PIPELINE") {
        return {
          context: { ...ctx, state: "ready", pipelineWired: true },
          effects: [
            { type: "WIRE_PROVIDERS" },
            { type: "EMIT_STATE", state: "ready" },
          ],
        };
      }
      break;
    }

    // ─── READY ────────────────────────────────────────────
    case "ready": {
      if (event.type === "ADD_ASSERTION") {
        return {
          context: {
            ...ctx,
            assertions: [...ctx.assertions, event.assertion],
            pendingAssertions: ctx.pendingAssertions + 1,
          },
          effects: [],
        };
      }
      if (event.type === "START_RUN") {
        return {
          context: { ...ctx, state: "running", collectedEvents: [] },
          effects: [
            { type: "START_PIPELINE" },
            { type: "START_TIMER", name: "pipeline", durationMs: PIPELINE_TIMEOUT_MS },
            { type: "EMIT_STATE", state: "running" },
          ],
        };
      }
      break;
    }

    // ─── RUNNING ──────────────────────────────────────────
    case "running": {
      if (event.type === "PROVIDER_EVENT") {
        return {
          context: {
            ...ctx,
            collectedEvents: [...ctx.collectedEvents, { provider: event.provider, data: event.data }],
          },
          effects: [{ type: "RECORD_EVENT", provider: event.provider, data: event.data }],
        };
      }
      if (event.type === "INJECT_FAILURE") {
        return {
          context: { ...ctx, state: "injecting_failure" },
          effects: [
            { type: "TRIGGER_PROVIDER_FAILURE", provider: event.provider, error: event.error },
            { type: "EMIT_STATE", state: "injecting_failure" },
          ],
        };
      }
      if (event.type === "PIPELINE_COMPLETE") {
        return {
          context: { ...ctx, state: "collecting" },
          effects: [
            { type: "CANCEL_TIMER", name: "pipeline" },
            { type: "COLLECT_EVENTS" },
            { type: "EMIT_STATE", state: "collecting" },
          ],
        };
      }
      if (event.type === "PIPELINE_TIMEOUT") {
        return {
          context: {
            ...ctx,
            state: "collecting",
            failureReasons: [...ctx.failureReasons, "Pipeline timed out"],
          },
          effects: [
            { type: "ABORT_PIPELINE" },
            { type: "COLLECT_EVENTS" },
            { type: "EMIT_STATE", state: "collecting" },
          ],
        };
      }
      break;
    }

    // ─── INJECTING_FAILURE ────────────────────────────────
    case "injecting_failure": {
      if (event.type === "FAILURE_PROPAGATED") {
        // Failure was handled by the pipeline — back to running to see how it finishes
        return {
          context: { ...ctx, state: "running" },
          effects: [{ type: "EMIT_STATE", state: "running" }],
        };
      }
      if (event.type === "PIPELINE_COMPLETE") {
        // Pipeline finished during/after failure injection
        return {
          context: { ...ctx, state: "collecting" },
          effects: [
            { type: "CANCEL_TIMER", name: "pipeline" },
            { type: "COLLECT_EVENTS" },
            { type: "EMIT_STATE", state: "collecting" },
          ],
        };
      }
      if (event.type === "PIPELINE_TIMEOUT") {
        return {
          context: {
            ...ctx,
            state: "collecting",
            failureReasons: [...ctx.failureReasons, "Pipeline timed out after failure injection"],
          },
          effects: [
            { type: "ABORT_PIPELINE" },
            { type: "COLLECT_EVENTS" },
            { type: "EMIT_STATE", state: "collecting" },
          ],
        };
      }
      if (event.type === "PROVIDER_EVENT") {
        // Events can still arrive during failure propagation
        return {
          context: {
            ...ctx,
            collectedEvents: [...ctx.collectedEvents, { provider: event.provider, data: event.data }],
          },
          effects: [{ type: "RECORD_EVENT", provider: event.provider, data: event.data }],
        };
      }
      break;
    }

    // ─── COLLECTING ───────────────────────────────────────
    case "collecting": {
      if (event.type === "RUN_ASSERTIONS") {
        return {
          context: { ...ctx, state: "asserting", pendingAssertions: ctx.assertions.length },
          effects: [
            ...ctx.assertions.map((a): HarnessEffect => ({ type: "CHECK_ASSERTION", assertion: a })),
            { type: "EMIT_STATE", state: "asserting" },
          ],
        };
      }
      break;
    }

    // ─── ASSERTING ────────────────────────────────────────
    case "asserting": {
      if (event.type === "ASSERTION_PASSED") {
        return {
          context: { ...ctx, pendingAssertions: ctx.pendingAssertions - 1 },
          effects: [],
        };
      }
      if (event.type === "ASSERTION_FAILED") {
        return {
          context: {
            ...ctx,
            pendingAssertions: ctx.pendingAssertions - 1,
            failureReasons: [...ctx.failureReasons, event.reason],
          },
          effects: [],
        };
      }
      if (event.type === "ALL_ASSERTIONS_DONE") {
        return {
          context: { ...ctx, state: "tearing_down" },
          effects: [
            { type: "DISCONNECT_PROVIDERS" },
            { type: "START_TIMER", name: "teardown", durationMs: TEARDOWN_TIMEOUT_MS },
            { type: "EMIT_STATE", state: "tearing_down" },
          ],
        };
      }
      break;
    }

    // ─── TEARING_DOWN ─────────────────────────────────────
    case "tearing_down": {
      if (event.type === "TEARDOWN_COMPLETE") {
        const allPassed = ctx.failureReasons.length === 0;
        const nextState: HarnessState = allPassed ? "passed" : "failed";
        return {
          context: { ...ctx, state: nextState },
          effects: [
            { type: "CANCEL_TIMER", name: "teardown" },
            { type: "RELEASE_RESOURCES" },
            { type: "EMIT_RESULT", passed: allPassed, reason: allPassed ? undefined : ctx.failureReasons.join("; ") },
            { type: "EMIT_STATE", state: nextState },
          ],
        };
      }
      if (event.type === "PIPELINE_TIMEOUT") {
        // Teardown timed out — still finish but note the leak
        const nextState: HarnessState = ctx.failureReasons.length === 0 ? "passed" : "failed";
        return {
          context: {
            ...ctx,
            state: nextState,
            failureReasons: [...ctx.failureReasons, "Teardown timed out — possible resource leak"],
          },
          effects: [
            { type: "RELEASE_RESOURCES" },
            { type: "LOG_ERROR", error: "Teardown timed out — resources may have leaked" },
            { type: "EMIT_RESULT", passed: false, reason: "Teardown timeout" },
            { type: "EMIT_STATE", state: nextState },
          ],
        };
      }
      break;
    }

    // ─── PASSED (terminal) ────────────────────────────────
    case "passed":
    // ─── FAILED (terminal) ────────────────────────────────
    case "failed":
    // ─── ERROR (terminal-ish) ─────────────────────────────
    case "error": {
      // Only RESET handled (above, before switch)
      break;
    }
  }

  // No matching transition — event ignored in this state
  return { context: ctx, effects: [] };
}

// ─── Formal Transition Table ──────────────────────────────────────────

export interface TransitionEntry {
  from: HarnessState;
  event: HarnessEvent["type"];
  to: HarnessState;
  effects: string[];
  note?: string;
}

export const TRANSITION_TABLE: TransitionEntry[] = [
  // IDLE
  { from: "idle", event: "CONFIGURE", to: "configuring", effects: ["EMIT_STATE", "CREATE_MOCK_*"] },

  // CONFIGURING
  { from: "configuring", event: "ADD_ASSERTION", to: "configuring", effects: [], note: "Self-loop, adds assertion" },
  { from: "configuring", event: "WIRE_PIPELINE", to: "ready", effects: ["WIRE_PROVIDERS", "EMIT_STATE"] },
  { from: "configuring", event: "HARNESS_ERROR", to: "error", effects: ["ABORT_PIPELINE", "LOG_ERROR", "EMIT_STATE"] },

  // READY
  { from: "ready", event: "ADD_ASSERTION", to: "ready", effects: [], note: "Self-loop, adds assertion" },
  { from: "ready", event: "START_RUN", to: "running", effects: ["START_PIPELINE", "START_TIMER", "EMIT_STATE"] },
  { from: "ready", event: "HARNESS_ERROR", to: "error", effects: ["ABORT_PIPELINE", "LOG_ERROR", "EMIT_STATE"] },

  // RUNNING
  { from: "running", event: "PROVIDER_EVENT", to: "running", effects: ["RECORD_EVENT"], note: "Self-loop, records event" },
  { from: "running", event: "INJECT_FAILURE", to: "injecting_failure", effects: ["TRIGGER_PROVIDER_FAILURE", "EMIT_STATE"] },
  { from: "running", event: "PIPELINE_COMPLETE", to: "collecting", effects: ["CANCEL_TIMER", "COLLECT_EVENTS", "EMIT_STATE"] },
  { from: "running", event: "PIPELINE_TIMEOUT", to: "collecting", effects: ["ABORT_PIPELINE", "COLLECT_EVENTS", "EMIT_STATE"] },
  { from: "running", event: "HARNESS_ERROR", to: "error", effects: ["CANCEL_TIMER", "ABORT_PIPELINE", "LOG_ERROR", "EMIT_STATE"] },

  // INJECTING_FAILURE
  { from: "injecting_failure", event: "FAILURE_PROPAGATED", to: "running", effects: ["EMIT_STATE"] },
  { from: "injecting_failure", event: "PIPELINE_COMPLETE", to: "collecting", effects: ["CANCEL_TIMER", "COLLECT_EVENTS", "EMIT_STATE"] },
  { from: "injecting_failure", event: "PIPELINE_TIMEOUT", to: "collecting", effects: ["ABORT_PIPELINE", "COLLECT_EVENTS", "EMIT_STATE"] },
  { from: "injecting_failure", event: "PROVIDER_EVENT", to: "injecting_failure", effects: ["RECORD_EVENT"], note: "Self-loop" },
  { from: "injecting_failure", event: "HARNESS_ERROR", to: "error", effects: ["CANCEL_TIMER", "ABORT_PIPELINE", "LOG_ERROR", "EMIT_STATE"] },

  // COLLECTING
  { from: "collecting", event: "RUN_ASSERTIONS", to: "asserting", effects: ["CHECK_ASSERTION", "EMIT_STATE"] },
  { from: "collecting", event: "HARNESS_ERROR", to: "error", effects: ["ABORT_PIPELINE", "LOG_ERROR", "EMIT_STATE"] },

  // ASSERTING
  { from: "asserting", event: "ASSERTION_PASSED", to: "asserting", effects: [], note: "Self-loop, decrements pending" },
  { from: "asserting", event: "ASSERTION_FAILED", to: "asserting", effects: [], note: "Self-loop, records failure" },
  { from: "asserting", event: "ALL_ASSERTIONS_DONE", to: "tearing_down", effects: ["DISCONNECT_PROVIDERS", "START_TIMER", "EMIT_STATE"] },
  { from: "asserting", event: "HARNESS_ERROR", to: "error", effects: ["ABORT_PIPELINE", "LOG_ERROR", "EMIT_STATE"] },

  // TEARING_DOWN
  { from: "tearing_down", event: "TEARDOWN_COMPLETE", to: "passed|failed", effects: ["CANCEL_TIMER", "RELEASE_RESOURCES", "EMIT_RESULT", "EMIT_STATE"], note: "Terminal depends on failures" },
  { from: "tearing_down", event: "PIPELINE_TIMEOUT", to: "passed|failed", effects: ["RELEASE_RESOURCES", "LOG_ERROR", "EMIT_RESULT", "EMIT_STATE"], note: "Teardown timeout" },
  { from: "tearing_down", event: "HARNESS_ERROR", to: "error", effects: ["ABORT_PIPELINE", "LOG_ERROR", "EMIT_STATE"] },

  // TERMINAL STATES
  { from: "passed", event: "RESET", to: "idle", effects: ["EMIT_STATE"] },
  { from: "failed", event: "RESET", to: "idle", effects: ["EMIT_STATE"] },
  { from: "error", event: "RESET", to: "idle", effects: ["EMIT_STATE"] },
];

// ─── All states and events (for exhaustiveness checks) ────────────────

export const ALL_STATES: HarnessState[] = [
  "idle", "configuring", "ready", "running", "injecting_failure",
  "collecting", "asserting", "tearing_down", "passed", "failed", "error",
];

export const ALL_EVENT_TYPES: HarnessEvent["type"][] = [
  "CONFIGURE", "ADD_ASSERTION", "WIRE_PIPELINE", "START_RUN",
  "PROVIDER_EVENT", "INJECT_FAILURE", "FAILURE_PROPAGATED",
  "PIPELINE_COMPLETE", "PIPELINE_TIMEOUT", "RUN_ASSERTIONS",
  "ASSERTION_PASSED", "ASSERTION_FAILED", "ALL_ASSERTIONS_DONE",
  "TEARDOWN", "TEARDOWN_COMPLETE", "HARNESS_ERROR", "RESET",
];

/** States that have a timeout guard (waiting states that must not hang) */
export const TIMEOUT_GUARDED_STATES: Record<string, { timer: string; timeoutEvent: HarnessEvent["type"] }> = {
  running: { timer: "pipeline", timeoutEvent: "PIPELINE_TIMEOUT" },
  injecting_failure: { timer: "pipeline", timeoutEvent: "PIPELINE_TIMEOUT" },
  tearing_down: { timer: "teardown", timeoutEvent: "PIPELINE_TIMEOUT" },
};

/** Terminal states — no outgoing transitions except RESET */
export const TERMINAL_STATES: HarnessState[] = ["passed", "failed", "error"];
