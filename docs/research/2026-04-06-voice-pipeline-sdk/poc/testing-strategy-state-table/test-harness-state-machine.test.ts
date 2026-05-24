/**
 * Testing Strategy State Machine — Exhaustive Tests
 *
 * Tests every reachable state for:
 * 1. Valid exit transitions
 * 2. Timeout guards on waiting states
 * 3. No dead states (every state reachable, every non-terminal state has exit)
 * 4. HARNESS_ERROR works from every active state
 * 5. Ignored events don't mutate state
 * 6. Happy path and failure scenarios end-to-end
 * 7. RESET from terminal states
 */

import {
  transition,
  initialContext,
  ALL_STATES,
  ALL_EVENT_TYPES,
  TIMEOUT_GUARDED_STATES,
  TERMINAL_STATES,
  TRANSITION_TABLE,
  type HarnessContext,
  type HarnessEvent,
  type HarnessState,
  type MockProviderConfig,
  type TestAssertion,
} from "./test-harness-state-machine";

// ─── Helpers ──────────────────────────────────────────────────────────

const BASIC_CONFIG: MockProviderConfig = {
  stt: { transcripts: ["hello world"], delayMs: 0 },
  llm: { tokens: ["Hi", " there"], delayMs: 0 },
  tts: { chunkCount: 2, chunkSize: 1024, delayMs: 0 },
};

const SEQ_ASSERTION: TestAssertion = {
  type: "event_sequence",
  description: "Events arrive in correct order",
};

const STATE_ASSERTION: TestAssertion = {
  type: "state_check",
  description: "Pipeline reaches expected state",
};

function ctxInState(state: HarnessState, overrides?: Partial<HarnessContext>): HarnessContext {
  return {
    state,
    config: BASIC_CONFIG,
    assertions: [SEQ_ASSERTION],
    pendingAssertions: 1,
    collectedEvents: [],
    failureReasons: [],
    pipelineWired: state !== "idle" && state !== "configuring",
    ...overrides,
  };
}

/** Walk a sequence of events from initial context, return final context */
function walkPath(events: HarnessEvent[]): HarnessContext {
  let ctx = initialContext();
  for (const event of events) {
    ctx = transition(ctx, event).context;
  }
  return ctx;
}

/** Check that an effect of given type is present */
function hasEffect(effects: { type: string }[], effectType: string): boolean {
  return effects.some((e) => e.type === effectType);
}

// ─── Paths to each state ──────────────────────────────────────────────

const PATHS_TO_STATES: Record<HarnessState, HarnessEvent[]> = {
  idle: [],
  configuring: [
    { type: "CONFIGURE", config: BASIC_CONFIG },
  ],
  ready: [
    { type: "CONFIGURE", config: BASIC_CONFIG },
    { type: "WIRE_PIPELINE" },
  ],
  running: [
    { type: "CONFIGURE", config: BASIC_CONFIG },
    { type: "WIRE_PIPELINE" },
    { type: "START_RUN" },
  ],
  injecting_failure: [
    { type: "CONFIGURE", config: BASIC_CONFIG },
    { type: "WIRE_PIPELINE" },
    { type: "START_RUN" },
    { type: "INJECT_FAILURE", provider: "stt", error: "connection lost" },
  ],
  collecting: [
    { type: "CONFIGURE", config: BASIC_CONFIG },
    { type: "WIRE_PIPELINE" },
    { type: "START_RUN" },
    { type: "PIPELINE_COMPLETE" },
  ],
  asserting: [
    { type: "CONFIGURE", config: BASIC_CONFIG },
    { type: "ADD_ASSERTION", assertion: SEQ_ASSERTION },
    { type: "WIRE_PIPELINE" },
    { type: "START_RUN" },
    { type: "PIPELINE_COMPLETE" },
    { type: "RUN_ASSERTIONS" },
  ],
  tearing_down: [
    { type: "CONFIGURE", config: BASIC_CONFIG },
    { type: "ADD_ASSERTION", assertion: SEQ_ASSERTION },
    { type: "WIRE_PIPELINE" },
    { type: "START_RUN" },
    { type: "PIPELINE_COMPLETE" },
    { type: "RUN_ASSERTIONS" },
    { type: "ALL_ASSERTIONS_DONE", allPassed: true },
  ],
  passed: [
    { type: "CONFIGURE", config: BASIC_CONFIG },
    { type: "ADD_ASSERTION", assertion: SEQ_ASSERTION },
    { type: "WIRE_PIPELINE" },
    { type: "START_RUN" },
    { type: "PIPELINE_COMPLETE" },
    { type: "RUN_ASSERTIONS" },
    { type: "ALL_ASSERTIONS_DONE", allPassed: true },
    { type: "TEARDOWN_COMPLETE" },
  ],
  failed: [
    { type: "CONFIGURE", config: BASIC_CONFIG },
    { type: "ADD_ASSERTION", assertion: SEQ_ASSERTION },
    { type: "WIRE_PIPELINE" },
    { type: "START_RUN" },
    { type: "PIPELINE_COMPLETE" },
    { type: "RUN_ASSERTIONS" },
    { type: "ASSERTION_FAILED", reason: "wrong event order" },
    { type: "ALL_ASSERTIONS_DONE", allPassed: false },
    { type: "TEARDOWN_COMPLETE" },
  ],
  error: [
    { type: "CONFIGURE", config: BASIC_CONFIG },
    { type: "HARNESS_ERROR", error: "mock setup failed" },
  ],
};

// ─── Tests ────────────────────────────────────────────────────────────

console.log("=== Testing Strategy State Machine Tests ===\n");

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL: ${msg}`);
  }
}

// Test 1: Every state is reachable
console.log("--- Test 1: Every state is reachable ---");
for (const state of ALL_STATES) {
  const path = PATHS_TO_STATES[state];
  const ctx = walkPath(path);
  assert(ctx.state === state, `Expected to reach ${state}, got ${ctx.state}`);
}
console.log(`  ${ALL_STATES.length} states verified reachable`);

// Test 2: No dead states — every non-terminal state has at least one exit
console.log("\n--- Test 2: No dead states ---");
for (const state of ALL_STATES) {
  if (TERMINAL_STATES.includes(state)) {
    // Terminal states only exit via RESET
    const ctx = ctxInState(state);
    const r = transition(ctx, { type: "RESET" });
    assert(r.context.state === "idle", `RESET from terminal ${state} → idle`);
    continue;
  }
  // Non-terminal: must have at least one event that transitions out
  let hasExit = false;
  for (const eventType of ALL_EVENT_TYPES) {
    const event = makeEvent(eventType);
    const ctx = ctxInState(state);
    const r = transition(ctx, event);
    if (r.context.state !== state) {
      hasExit = true;
      break;
    }
  }
  assert(hasExit, `State ${state} has no exits (dead state!)`);
}

// Test 3: HARNESS_ERROR from every non-terminal state → error
console.log("\n--- Test 3: HARNESS_ERROR from all active states → error ---");
const ACTIVE_STATES = ALL_STATES.filter((s) => !TERMINAL_STATES.includes(s));
for (const state of ACTIVE_STATES) {
  const ctx = ctxInState(state);
  const r = transition(ctx, { type: "HARNESS_ERROR", error: "infra failure" });
  assert(r.context.state === "error", `HARNESS_ERROR from ${state} → error, got ${r.context.state}`);
  assert(hasEffect(r.effects, "LOG_ERROR"), `HARNESS_ERROR from ${state} should log error`);
  assert(hasEffect(r.effects, "EMIT_STATE"), `HARNESS_ERROR from ${state} should emit state`);
}

// Test 4: Timeout guards on waiting states
console.log("\n--- Test 4: Timeout guards on waiting states ---");
for (const [state, guard] of Object.entries(TIMEOUT_GUARDED_STATES)) {
  const ctx = ctxInState(state as HarnessState);
  const event = makeEvent(guard.timeoutEvent);
  const r = transition(ctx, event);
  assert(
    r.context.state !== state,
    `Timeout event ${guard.timeoutEvent} in ${state} should transition out, stayed in ${r.context.state}`
  );
}

// Test 5: Happy path — full test lifecycle
console.log("\n--- Test 5: Happy path — full test lifecycle ---");
{
  let ctx = initialContext();
  assert(ctx.state === "idle", "Initial state should be idle");

  // Configure
  let r = transition(ctx, { type: "CONFIGURE", config: BASIC_CONFIG });
  ctx = r.context;
  assert(ctx.state === "configuring", "After CONFIGURE → configuring");
  assert(hasEffect(r.effects, "CREATE_MOCK_STT"), "Should create mock STT");
  assert(hasEffect(r.effects, "CREATE_MOCK_LLM"), "Should create mock LLM");
  assert(hasEffect(r.effects, "CREATE_MOCK_TTS"), "Should create mock TTS");

  // Add assertion
  r = transition(ctx, { type: "ADD_ASSERTION", assertion: SEQ_ASSERTION });
  ctx = r.context;
  assert(ctx.state === "configuring", "ADD_ASSERTION is self-loop in configuring");
  assert(ctx.assertions.length === 1, "Should have 1 assertion");

  // Wire pipeline
  r = transition(ctx, { type: "WIRE_PIPELINE" });
  ctx = r.context;
  assert(ctx.state === "ready", "After WIRE_PIPELINE → ready");
  assert(hasEffect(r.effects, "WIRE_PROVIDERS"), "Should wire providers");
  assert(ctx.pipelineWired, "Pipeline should be marked as wired");

  // Start run
  r = transition(ctx, { type: "START_RUN" });
  ctx = r.context;
  assert(ctx.state === "running", "After START_RUN → running");
  assert(hasEffect(r.effects, "START_PIPELINE"), "Should start pipeline");
  assert(hasEffect(r.effects, "START_TIMER"), "Should start pipeline timer");

  // Provider emits events
  r = transition(ctx, { type: "PROVIDER_EVENT", provider: "stt", data: { type: "transcript", text: "hello" } });
  ctx = r.context;
  assert(ctx.state === "running", "PROVIDER_EVENT is self-loop");
  assert(ctx.collectedEvents.length === 1, "Should collect 1 event");
  assert(hasEffect(r.effects, "RECORD_EVENT"), "Should record event");

  // Pipeline completes
  r = transition(ctx, { type: "PIPELINE_COMPLETE" });
  ctx = r.context;
  assert(ctx.state === "collecting", "After PIPELINE_COMPLETE → collecting");
  assert(hasEffect(r.effects, "CANCEL_TIMER"), "Should cancel pipeline timer");
  assert(hasEffect(r.effects, "COLLECT_EVENTS"), "Should collect events");

  // Run assertions
  r = transition(ctx, { type: "RUN_ASSERTIONS" });
  ctx = r.context;
  assert(ctx.state === "asserting", "After RUN_ASSERTIONS → asserting");
  assert(hasEffect(r.effects, "CHECK_ASSERTION"), "Should check assertions");
  assert(ctx.pendingAssertions === 1, "Should have 1 pending assertion");

  // Assertion passes
  r = transition(ctx, { type: "ASSERTION_PASSED" });
  ctx = r.context;
  assert(ctx.state === "asserting", "ASSERTION_PASSED is self-loop");
  assert(ctx.pendingAssertions === 0, "Should have 0 pending assertions");

  // All assertions done
  r = transition(ctx, { type: "ALL_ASSERTIONS_DONE", allPassed: true });
  ctx = r.context;
  assert(ctx.state === "tearing_down", "After ALL_ASSERTIONS_DONE → tearing_down");
  assert(hasEffect(r.effects, "DISCONNECT_PROVIDERS"), "Should disconnect providers");
  assert(hasEffect(r.effects, "START_TIMER"), "Should start teardown timer");

  // Teardown complete
  r = transition(ctx, { type: "TEARDOWN_COMPLETE" });
  ctx = r.context;
  assert(ctx.state === "passed", "After TEARDOWN_COMPLETE with no failures → passed");
  assert(hasEffect(r.effects, "RELEASE_RESOURCES"), "Should release resources");
  assert(hasEffect(r.effects, "EMIT_RESULT"), "Should emit result");
}

// Test 6: Failure path — assertion fails
console.log("\n--- Test 6: Failure path — assertion fails ---");
{
  let ctx = walkPath([
    { type: "CONFIGURE", config: BASIC_CONFIG },
    { type: "ADD_ASSERTION", assertion: SEQ_ASSERTION },
    { type: "ADD_ASSERTION", assertion: STATE_ASSERTION },
    { type: "WIRE_PIPELINE" },
    { type: "START_RUN" },
    { type: "PIPELINE_COMPLETE" },
    { type: "RUN_ASSERTIONS" },
  ]);
  assert(ctx.state === "asserting", "Should be asserting");
  assert(ctx.pendingAssertions === 2, "Should have 2 pending assertions");

  // First passes, second fails
  ctx = transition(ctx, { type: "ASSERTION_PASSED" }).context;
  assert(ctx.pendingAssertions === 1, "1 pending after first passes");

  let r = transition(ctx, { type: "ASSERTION_FAILED", reason: "wrong event order" });
  ctx = r.context;
  assert(ctx.failureReasons.length === 1, "Should record failure reason");
  assert(ctx.pendingAssertions === 0, "0 pending after second");

  // Complete → teardown → failed
  ctx = transition(ctx, { type: "ALL_ASSERTIONS_DONE", allPassed: false }).context;
  assert(ctx.state === "tearing_down", "→ tearing_down");

  r = transition(ctx, { type: "TEARDOWN_COMPLETE" });
  ctx = r.context;
  assert(ctx.state === "failed", "After teardown with failures → failed");
}

// Test 7: Failure injection mid-run
console.log("\n--- Test 7: Failure injection mid-run ---");
{
  let ctx = walkPath([
    { type: "CONFIGURE", config: BASIC_CONFIG },
    { type: "WIRE_PIPELINE" },
    { type: "START_RUN" },
  ]);
  assert(ctx.state === "running", "Should be running");

  // Inject STT failure
  let r = transition(ctx, { type: "INJECT_FAILURE", provider: "stt", error: "connection lost" });
  ctx = r.context;
  assert(ctx.state === "injecting_failure", "After INJECT_FAILURE → injecting_failure");
  assert(hasEffect(r.effects, "TRIGGER_PROVIDER_FAILURE"), "Should trigger provider failure");

  // Events can still arrive during failure propagation
  r = transition(ctx, { type: "PROVIDER_EVENT", provider: "tts", data: { type: "audio_chunk" } });
  ctx = r.context;
  assert(ctx.state === "injecting_failure", "PROVIDER_EVENT is self-loop in injecting_failure");
  assert(ctx.collectedEvents.length === 1, "Should still collect events");

  // Failure propagated — back to running
  r = transition(ctx, { type: "FAILURE_PROPAGATED" });
  ctx = r.context;
  assert(ctx.state === "running", "After FAILURE_PROPAGATED → running");

  // Pipeline finishes
  r = transition(ctx, { type: "PIPELINE_COMPLETE" });
  ctx = r.context;
  assert(ctx.state === "collecting", "After PIPELINE_COMPLETE → collecting");
}

// Test 8: Pipeline timeout
console.log("\n--- Test 8: Pipeline timeout ---");
{
  let ctx = walkPath([
    { type: "CONFIGURE", config: BASIC_CONFIG },
    { type: "WIRE_PIPELINE" },
    { type: "START_RUN" },
  ]);

  let r = transition(ctx, { type: "PIPELINE_TIMEOUT" });
  ctx = r.context;
  assert(ctx.state === "collecting", "After PIPELINE_TIMEOUT → collecting");
  assert(hasEffect(r.effects, "ABORT_PIPELINE"), "Should abort pipeline");
  assert(ctx.failureReasons.length === 1, "Should record timeout as failure");
}

// Test 9: Pipeline timeout during failure injection
console.log("\n--- Test 9: Pipeline timeout during failure injection ---");
{
  let ctx = walkPath([
    { type: "CONFIGURE", config: BASIC_CONFIG },
    { type: "WIRE_PIPELINE" },
    { type: "START_RUN" },
    { type: "INJECT_FAILURE", provider: "stt", error: "test" },
  ]);

  let r = transition(ctx, { type: "PIPELINE_TIMEOUT" });
  ctx = r.context;
  assert(ctx.state === "collecting", "Timeout during injection → collecting");
  assert(ctx.failureReasons.includes("Pipeline timed out after failure injection"), "Records timeout reason");
}

// Test 10: Pipeline complete directly from injecting_failure
console.log("\n--- Test 10: Pipeline complete during failure injection ---");
{
  let ctx = walkPath([
    { type: "CONFIGURE", config: BASIC_CONFIG },
    { type: "WIRE_PIPELINE" },
    { type: "START_RUN" },
    { type: "INJECT_FAILURE", provider: "tts", error: "synth failed" },
  ]);

  let r = transition(ctx, { type: "PIPELINE_COMPLETE" });
  ctx = r.context;
  assert(ctx.state === "collecting", "PIPELINE_COMPLETE during injection → collecting");
  assert(hasEffect(r.effects, "CANCEL_TIMER"), "Should cancel timer");
}

// Test 11: Ignored events don't change state
console.log("\n--- Test 11: Ignored events don't change state ---");
{
  // START_RUN in idle — ignored
  const ctx1 = initialContext();
  const r1 = transition(ctx1, { type: "START_RUN" });
  assert(r1.context.state === "idle", "START_RUN in idle should be ignored");
  assert(r1.effects.length === 0, "No effects for ignored event");

  // PIPELINE_COMPLETE in configuring — ignored
  const ctx2 = ctxInState("configuring");
  const r2 = transition(ctx2, { type: "PIPELINE_COMPLETE" });
  assert(r2.context.state === "configuring", "PIPELINE_COMPLETE in configuring should be ignored");

  // INJECT_FAILURE in collecting — ignored
  const ctx3 = ctxInState("collecting");
  const r3 = transition(ctx3, { type: "INJECT_FAILURE", provider: "stt", error: "test" });
  assert(r3.context.state === "collecting", "INJECT_FAILURE in collecting should be ignored");

  // CONFIGURE in running — ignored
  const ctx4 = ctxInState("running");
  const r4 = transition(ctx4, { type: "CONFIGURE", config: BASIC_CONFIG });
  assert(r4.context.state === "running", "CONFIGURE in running should be ignored");

  // WIRE_PIPELINE in asserting — ignored
  const ctx5 = ctxInState("asserting");
  const r5 = transition(ctx5, { type: "WIRE_PIPELINE" });
  assert(r5.context.state === "asserting", "WIRE_PIPELINE in asserting should be ignored");
}

// Test 12: Terminal states only respond to RESET
console.log("\n--- Test 12: Terminal states only respond to RESET ---");
for (const termState of TERMINAL_STATES) {
  const ctx = ctxInState(termState);
  for (const eventType of ALL_EVENT_TYPES) {
    if (eventType === "RESET") continue;
    // HARNESS_ERROR is special — it's handled before the switch but
    // only for non-terminal states, so terminals ignore it
    const event = makeEvent(eventType);
    const r = transition(ctx, event);
    assert(
      r.context.state === termState,
      `${eventType} in terminal ${termState} should be ignored, got ${r.context.state}`
    );
  }
  // RESET should work
  const r = transition(ctx, { type: "RESET" });
  assert(r.context.state === "idle", `RESET from ${termState} → idle`);
}

// Test 13: Assertions accumulate in configuring and ready
console.log("\n--- Test 13: Assertions accumulate across states ---");
{
  let ctx = initialContext();
  ctx = transition(ctx, { type: "CONFIGURE", config: BASIC_CONFIG }).context;

  // Add in configuring
  ctx = transition(ctx, { type: "ADD_ASSERTION", assertion: SEQ_ASSERTION }).context;
  assert(ctx.assertions.length === 1, "1 assertion in configuring");

  ctx = transition(ctx, { type: "WIRE_PIPELINE" }).context;

  // Add in ready
  ctx = transition(ctx, { type: "ADD_ASSERTION", assertion: STATE_ASSERTION }).context;
  assert(ctx.assertions.length === 2, "2 assertions after adding in ready");
  assert(ctx.pendingAssertions === 2, "2 pending assertions");
}

// Test 14: Collected events persist through state transitions
console.log("\n--- Test 14: Event collection ---");
{
  let ctx = walkPath([
    { type: "CONFIGURE", config: BASIC_CONFIG },
    { type: "WIRE_PIPELINE" },
    { type: "START_RUN" },
  ]);

  // Emit several events
  ctx = transition(ctx, { type: "PROVIDER_EVENT", provider: "stt", data: { text: "hello" } }).context;
  ctx = transition(ctx, { type: "PROVIDER_EVENT", provider: "llm", data: { token: "Hi" } }).context;
  ctx = transition(ctx, { type: "PROVIDER_EVENT", provider: "tts", data: { chunk: 1 } }).context;
  assert(ctx.collectedEvents.length === 3, "Should have 3 collected events");

  // Events persist into collecting
  ctx = transition(ctx, { type: "PIPELINE_COMPLETE" }).context;
  assert(ctx.collectedEvents.length === 3, "Events persist in collecting");
  assert(ctx.state === "collecting", "Should be in collecting");
}

// Test 15: Partial config (only STT)
console.log("\n--- Test 15: Partial provider config ---");
{
  const partialConfig: MockProviderConfig = {
    stt: { transcripts: ["test"] },
  };
  const r = transition(initialContext(), { type: "CONFIGURE", config: partialConfig });
  assert(r.context.state === "configuring", "Partial config → configuring");
  assert(hasEffect(r.effects, "CREATE_MOCK_STT"), "Should create STT mock");
  assert(!hasEffect(r.effects, "CREATE_MOCK_LLM"), "Should NOT create LLM mock");
  assert(!hasEffect(r.effects, "CREATE_MOCK_TTS"), "Should NOT create TTS mock");
}

// Test 16: RESET clears all state
console.log("\n--- Test 16: RESET clears all state ---");
{
  // Get to failed with accumulated state
  let ctx = walkPath([
    { type: "CONFIGURE", config: BASIC_CONFIG },
    { type: "ADD_ASSERTION", assertion: SEQ_ASSERTION },
    { type: "WIRE_PIPELINE" },
    { type: "START_RUN" },
    { type: "PROVIDER_EVENT", provider: "stt", data: "ev1" },
    { type: "PIPELINE_COMPLETE" },
    { type: "RUN_ASSERTIONS" },
    { type: "ASSERTION_FAILED", reason: "test fail" },
    { type: "ALL_ASSERTIONS_DONE", allPassed: false },
    { type: "TEARDOWN_COMPLETE" },
  ]);
  assert(ctx.state === "failed", "Should be failed");
  assert(ctx.collectedEvents.length > 0, "Should have events");
  assert(ctx.failureReasons.length > 0, "Should have failures");

  // Reset
  ctx = transition(ctx, { type: "RESET" }).context;
  assert(ctx.state === "idle", "After RESET → idle");
  assert(ctx.config === null, "Config cleared");
  assert(ctx.assertions.length === 0, "Assertions cleared");
  assert(ctx.collectedEvents.length === 0, "Events cleared");
  assert(ctx.failureReasons.length === 0, "Failures cleared");
  assert(ctx.pipelineWired === false, "Pipeline wired flag cleared");
}

// Test 17: Teardown timeout path
console.log("\n--- Test 17: Teardown timeout ---");
{
  let ctx = walkPath([
    { type: "CONFIGURE", config: BASIC_CONFIG },
    { type: "ADD_ASSERTION", assertion: SEQ_ASSERTION },
    { type: "WIRE_PIPELINE" },
    { type: "START_RUN" },
    { type: "PIPELINE_COMPLETE" },
    { type: "RUN_ASSERTIONS" },
    { type: "ASSERTION_PASSED" },
    { type: "ALL_ASSERTIONS_DONE", allPassed: true },
  ]);
  assert(ctx.state === "tearing_down", "Should be tearing_down");

  // Teardown times out
  let r = transition(ctx, { type: "PIPELINE_TIMEOUT" });
  ctx = r.context;
  // Even though assertions passed, teardown timeout means leaked resources
  assert(hasEffect(r.effects, "RELEASE_RESOURCES"), "Should release resources");
  assert(hasEffect(r.effects, "LOG_ERROR"), "Should log teardown timeout");
  assert(ctx.failureReasons.some((r) => r.includes("Teardown")), "Should note teardown timeout");
}

// Test 18: Multiple failure reasons accumulate
console.log("\n--- Test 18: Multiple failure reasons ---");
{
  let ctx = walkPath([
    { type: "CONFIGURE", config: BASIC_CONFIG },
    { type: "ADD_ASSERTION", assertion: SEQ_ASSERTION },
    { type: "ADD_ASSERTION", assertion: STATE_ASSERTION },
    { type: "WIRE_PIPELINE" },
    { type: "START_RUN" },
    { type: "PIPELINE_TIMEOUT" }, // adds timeout failure
  ]);
  assert(ctx.failureReasons.length === 1, "1 failure after timeout");

  ctx = transition(ctx, { type: "RUN_ASSERTIONS" }).context;
  ctx = transition(ctx, { type: "ASSERTION_FAILED", reason: "wrong order" }).context;
  ctx = transition(ctx, { type: "ASSERTION_FAILED", reason: "missing event" }).context;
  assert(ctx.failureReasons.length === 3, "3 failures total");
}

// ─── Summary ──────────────────────────────────────────────────────────

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  process.exit(1);
}

// ─── Helper to create events by type ──────────────────────────────────

function makeEvent(eventType: HarnessEvent["type"]): HarnessEvent {
  switch (eventType) {
    case "CONFIGURE": return { type: "CONFIGURE", config: BASIC_CONFIG };
    case "ADD_ASSERTION": return { type: "ADD_ASSERTION", assertion: SEQ_ASSERTION };
    case "WIRE_PIPELINE": return { type: "WIRE_PIPELINE" };
    case "START_RUN": return { type: "START_RUN" };
    case "PROVIDER_EVENT": return { type: "PROVIDER_EVENT", provider: "stt", data: {} };
    case "INJECT_FAILURE": return { type: "INJECT_FAILURE", provider: "stt", error: "test" };
    case "FAILURE_PROPAGATED": return { type: "FAILURE_PROPAGATED" };
    case "PIPELINE_COMPLETE": return { type: "PIPELINE_COMPLETE" };
    case "PIPELINE_TIMEOUT": return { type: "PIPELINE_TIMEOUT" };
    case "RUN_ASSERTIONS": return { type: "RUN_ASSERTIONS" };
    case "ASSERTION_PASSED": return { type: "ASSERTION_PASSED" };
    case "ASSERTION_FAILED": return { type: "ASSERTION_FAILED", reason: "test" };
    case "ALL_ASSERTIONS_DONE": return { type: "ALL_ASSERTIONS_DONE", allPassed: true };
    case "TEARDOWN": return { type: "TEARDOWN" };
    case "TEARDOWN_COMPLETE": return { type: "TEARDOWN_COMPLETE" };
    case "HARNESS_ERROR": return { type: "HARNESS_ERROR", error: "test" };
    case "RESET": return { type: "RESET" };
  }
}
