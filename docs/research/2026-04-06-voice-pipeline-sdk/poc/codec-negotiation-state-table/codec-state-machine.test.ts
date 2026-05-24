/**
 * Codec Negotiation State Machine — Exhaustive Tests
 *
 * Tests every reachable state for:
 * 1. Valid exit transitions
 * 2. Timeout guards on waiting states
 * 3. No dead states (every state reachable, every state has exit)
 * 4. Global events (WS_CLOSE, CLOSE) work from every active state
 * 5. Ignored events don't mutate state
 * 6. Happy path and error scenarios end-to-end
 */

import {
  transition,
  initialContext,
  ALL_STATES,
  ALL_EVENT_TYPES,
  TIMEOUT_GUARDED_STATES,
  TRANSITION_TABLE,
  type CodecContext,
  type CodecEvent,
  type CodecState,
  type AudioCapabilities,
  type NegotiatedFormat,
} from "./codec-state-machine";

// ─── Helpers ──────────────────────────────────────────────────────────

const PCM16_CAPS: AudioCapabilities = {
  supportedEncodings: ["pcm16"],
  preferredEncoding: "pcm16",
  captureSampleRate: 48_000,
  playbackSampleRate: 44_100,
};

const OPUS_CAPS: AudioCapabilities = {
  supportedEncodings: ["pcm16", "opus"],
  preferredEncoding: "opus",
  captureSampleRate: 48_000,
  playbackSampleRate: 48_000,
};

const PCM16_FORMAT: NegotiatedFormat = {
  encoding: "pcm16",
  captureSampleRate: 48_000,
  playbackSampleRate: 44_100,
};

const OPUS_FORMAT: NegotiatedFormat = {
  encoding: "opus",
  captureSampleRate: 48_000,
  playbackSampleRate: 48_000,
};

function ctxInState(state: CodecState, overrides?: Partial<CodecContext>): CodecContext {
  return {
    state,
    format: state === "ready" || state === "streaming" || state === "renegotiating" ? PCM16_FORMAT : null,
    lastCaps: PCM16_CAPS,
    failCount: 0,
    ...overrides,
  };
}

/** Walk a sequence of events from initial context, return final context */
function walkPath(events: CodecEvent[]): CodecContext {
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

// ─── Test: Every State is Reachable ───────────────────────────────────

const PATHS_TO_STATES: Record<CodecState, CodecEvent[]> = {
  disconnected: [],
  connected: [{ type: "WS_OPEN" }],
  negotiating: [
    { type: "WS_OPEN" },
    { type: "SEND_CAPABILITIES", caps: PCM16_CAPS },
  ],
  ready: [
    { type: "WS_OPEN" },
    { type: "SEND_CAPABILITIES", caps: PCM16_CAPS },
    { type: "SESSION_READY", format: PCM16_FORMAT },
  ],
  streaming: [
    { type: "WS_OPEN" },
    { type: "SEND_CAPABILITIES", caps: PCM16_CAPS },
    { type: "SESSION_READY", format: PCM16_FORMAT },
    { type: "AUDIO_START" },
  ],
  renegotiating: [
    { type: "WS_OPEN" },
    { type: "SEND_CAPABILITIES", caps: PCM16_CAPS },
    { type: "SESSION_READY", format: PCM16_FORMAT },
    { type: "RENEGOTIATE", caps: OPUS_CAPS },
  ],
  error: [
    { type: "WS_OPEN" },
    { type: "SEND_CAPABILITIES", caps: PCM16_CAPS },
    { type: "SESSION_REJECTED", reason: "no common encoding" },
  ],
  closed: [{ type: "CLOSE" }],
};

console.log("=== Codec Negotiation State Machine Tests ===\n");

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
  if (state === "closed") continue; // terminal
  const exits = TRANSITION_TABLE.filter((t) => t.from === state);
  assert(exits.length > 0, `State ${state} has no exits (dead state!)`);
}

// Test 3: Every non-terminal state can reach "closed"
console.log("\n--- Test 3: Every non-terminal state can reach closed ---");
for (const state of ALL_STATES) {
  if (state === "closed") continue;
  const ctx = ctxInState(state);
  const result = transition(ctx, { type: "CLOSE" });
  assert(result.context.state === "closed", `CLOSE from ${state} should → closed, got ${result.context.state}`);
  assert(hasEffect(result.effects, "EMIT_STATE"), `CLOSE from ${state} should emit state`);
}

// Test 4: WS_CLOSE from every connected state → disconnected
console.log("\n--- Test 4: WS_CLOSE from all active states → disconnected ---");
const ACTIVE_STATES: CodecState[] = ["connected", "negotiating", "ready", "streaming", "renegotiating", "error"];
for (const state of ACTIVE_STATES) {
  const ctx = ctxInState(state);
  const result = transition(ctx, { type: "WS_CLOSE" });
  assert(
    result.context.state === "disconnected",
    `WS_CLOSE from ${state} should → disconnected, got ${result.context.state}`
  );
  assert(hasEffect(result.effects, "RELEASE_CODEC"), `WS_CLOSE from ${state} should release codec`);
}

// Test 5: Timeout guards on waiting states
console.log("\n--- Test 5: Timeout guards on waiting states ---");
for (const [state, guard] of Object.entries(TIMEOUT_GUARDED_STATES)) {
  // Verify the state starts a timer on entry
  const entries = TRANSITION_TABLE.filter((t) => t.to === state as CodecState);
  const startsTimer = entries.some((t) => t.effects.includes("START_TIMER"));
  assert(startsTimer, `State ${state} should have a START_TIMER effect on some entry transition`);

  // Verify the timeout event is handled
  const ctx = ctxInState(state as CodecState);
  const result = transition(ctx, { type: guard.event } as CodecEvent);
  assert(
    result.context.state !== state,
    `Timeout event ${guard.event} in ${state} should transition out, but stayed`
  );
}

// Test 6: Happy path — PCM16 negotiation
console.log("\n--- Test 6: Happy path — PCM16 negotiation ---");
{
  let ctx = initialContext();
  assert(ctx.state === "disconnected", "Initial state should be disconnected");

  let r = transition(ctx, { type: "WS_OPEN" });
  ctx = r.context;
  assert(ctx.state === "connected", "After WS_OPEN → connected");

  r = transition(ctx, { type: "SEND_CAPABILITIES", caps: PCM16_CAPS });
  ctx = r.context;
  assert(ctx.state === "negotiating", "After SEND_CAPABILITIES → negotiating");
  assert(hasEffect(r.effects, "SEND_SESSION_START"), "Should send session.start");
  assert(hasEffect(r.effects, "START_TIMER"), "Should start negotiation timer");

  r = transition(ctx, { type: "SESSION_READY", format: PCM16_FORMAT });
  ctx = r.context;
  assert(ctx.state === "ready", "After SESSION_READY → ready");
  assert(hasEffect(r.effects, "CANCEL_TIMER"), "Should cancel negotiation timer");
  assert(hasEffect(r.effects, "APPLY_CODEC"), "Should apply codec");
  assert(ctx.format?.encoding === "pcm16", "Format should be pcm16");

  r = transition(ctx, { type: "AUDIO_START" });
  ctx = r.context;
  assert(ctx.state === "streaming", "After AUDIO_START → streaming");
  assert(hasEffect(r.effects, "NOTIFY_AUDIO_READY"), "Should notify audio ready");

  r = transition(ctx, { type: "AUDIO_STOP" });
  ctx = r.context;
  assert(ctx.state === "ready", "After AUDIO_STOP → ready");
  assert(hasEffect(r.effects, "NOTIFY_AUDIO_SUSPENDED"), "Should notify audio suspended");

  r = transition(ctx, { type: "CLOSE" });
  ctx = r.context;
  assert(ctx.state === "closed", "After CLOSE → closed");
  assert(hasEffect(r.effects, "RELEASE_CODEC"), "Should release codec");
}

// Test 7: Renegotiation — switch from PCM16 to Opus
console.log("\n--- Test 7: Renegotiation — PCM16 → Opus ---");
{
  // Get to ready with PCM16
  let ctx = walkPath([
    { type: "WS_OPEN" },
    { type: "SEND_CAPABILITIES", caps: PCM16_CAPS },
    { type: "SESSION_READY", format: PCM16_FORMAT },
  ]);
  assert(ctx.state === "ready", "Should be in ready state");
  assert(ctx.format?.encoding === "pcm16", "Should have pcm16 format");

  // Renegotiate to Opus
  let r = transition(ctx, { type: "RENEGOTIATE", caps: OPUS_CAPS });
  ctx = r.context;
  assert(ctx.state === "renegotiating", "After RENEGOTIATE → renegotiating");
  assert(hasEffect(r.effects, "START_TIMER"), "Should start renegotiation timer");

  // Gateway accepts
  r = transition(ctx, { type: "SESSION_READY", format: OPUS_FORMAT });
  ctx = r.context;
  assert(ctx.state === "ready", "After SESSION_READY → ready");
  assert(ctx.format?.encoding === "opus", "Format should now be opus");
  assert(hasEffect(r.effects, "RELEASE_CODEC"), "Should release old codec");
  assert(hasEffect(r.effects, "APPLY_CODEC"), "Should apply new codec");
}

// Test 8: Renegotiation failure falls back to previous format
console.log("\n--- Test 8: Renegotiation failure → fallback ---");
{
  let ctx = walkPath([
    { type: "WS_OPEN" },
    { type: "SEND_CAPABILITIES", caps: PCM16_CAPS },
    { type: "SESSION_READY", format: PCM16_FORMAT },
  ]);

  let r = transition(ctx, { type: "RENEGOTIATE", caps: OPUS_CAPS });
  ctx = r.context;

  // Gateway rejects Opus
  r = transition(ctx, { type: "SESSION_REJECTED", reason: "opus not supported" });
  ctx = r.context;
  assert(ctx.state === "ready", "After renegotiation rejection with existing format → ready (fallback)");
  assert(ctx.format?.encoding === "pcm16", "Should keep previous pcm16 format");
  assert(hasEffect(r.effects, "EMIT_ERROR"), "Should emit error about rejection");
}

// Test 9: Renegotiation timeout falls back to previous format
console.log("\n--- Test 9: Renegotiation timeout → fallback ---");
{
  let ctx = walkPath([
    { type: "WS_OPEN" },
    { type: "SEND_CAPABILITIES", caps: PCM16_CAPS },
    { type: "SESSION_READY", format: PCM16_FORMAT },
  ]);

  let r = transition(ctx, { type: "RENEGOTIATE", caps: OPUS_CAPS });
  ctx = r.context;

  r = transition(ctx, { type: "NEGOTIATION_TIMEOUT" });
  ctx = r.context;
  assert(ctx.state === "ready", "After renegotiation timeout with existing format → ready (fallback)");
  assert(ctx.format?.encoding === "pcm16", "Should keep previous pcm16 format");
}

// Test 10: Initial negotiation timeout → error
console.log("\n--- Test 10: Initial negotiation timeout → error ---");
{
  let ctx = walkPath([
    { type: "WS_OPEN" },
    { type: "SEND_CAPABILITIES", caps: PCM16_CAPS },
  ]);

  let r = transition(ctx, { type: "NEGOTIATION_TIMEOUT" });
  ctx = r.context;
  assert(ctx.state === "error", "After initial negotiation timeout → error");
  assert(ctx.failCount === 1, "Fail count should increment");
}

// Test 11: Error → Recover → re-negotiate
console.log("\n--- Test 11: Error recovery path ---");
{
  let ctx = walkPath([
    { type: "WS_OPEN" },
    { type: "SEND_CAPABILITIES", caps: PCM16_CAPS },
    { type: "SESSION_REJECTED", reason: "bad format" },
  ]);
  assert(ctx.state === "error", "Should be in error");

  let r = transition(ctx, { type: "RECOVER" });
  ctx = r.context;
  assert(ctx.state === "connected", "After RECOVER → connected");

  // Can re-negotiate
  r = transition(ctx, { type: "SEND_CAPABILITIES", caps: PCM16_CAPS });
  ctx = r.context;
  assert(ctx.state === "negotiating", "Can re-negotiate after recovery");
}

// Test 12: Codec error during streaming
console.log("\n--- Test 12: Codec error during streaming ---");
{
  let ctx = walkPath([
    { type: "WS_OPEN" },
    { type: "SEND_CAPABILITIES", caps: PCM16_CAPS },
    { type: "SESSION_READY", format: PCM16_FORMAT },
    { type: "AUDIO_START" },
  ]);
  assert(ctx.state === "streaming", "Should be streaming");

  let r = transition(ctx, { type: "CODEC_ERROR", error: "decode failed" });
  ctx = r.context;
  assert(ctx.state === "error", "Codec error → error state");
  assert(hasEffect(r.effects, "NOTIFY_AUDIO_SUSPENDED"), "Should suspend audio");
  assert(hasEffect(r.effects, "RELEASE_CODEC"), "Should release broken codec");
  assert(hasEffect(r.effects, "EMIT_ERROR"), "Should emit error");
}

// Test 13: Renegotiation while streaming
console.log("\n--- Test 13: Renegotiation while streaming ---");
{
  let ctx = walkPath([
    { type: "WS_OPEN" },
    { type: "SEND_CAPABILITIES", caps: PCM16_CAPS },
    { type: "SESSION_READY", format: PCM16_FORMAT },
    { type: "AUDIO_START" },
  ]);
  assert(ctx.state === "streaming", "Should be streaming");

  let r = transition(ctx, { type: "RENEGOTIATE", caps: OPUS_CAPS });
  ctx = r.context;
  assert(ctx.state === "renegotiating", "Streaming + RENEGOTIATE → renegotiating");
  assert(hasEffect(r.effects, "NOTIFY_AUDIO_SUSPENDED"), "Should suspend audio first");
}

// Test 14: Ignored events don't change state
console.log("\n--- Test 14: Ignored events don't change state ---");
{
  // AUDIO_START in disconnected — should be ignored
  const ctx = initialContext();
  const r = transition(ctx, { type: "AUDIO_START" });
  assert(r.context.state === "disconnected", "AUDIO_START in disconnected should be ignored");
  assert(r.effects.length === 0, "Ignored event should produce no effects");

  // SESSION_READY in connected (no negotiation started) — should be ignored
  const ctx2 = ctxInState("connected");
  const r2 = transition(ctx2, { type: "SESSION_READY", format: PCM16_FORMAT });
  assert(r2.context.state === "connected", "SESSION_READY without negotiation should be ignored");

  // RECOVER in ready — should be ignored
  const ctx3 = ctxInState("ready");
  const r3 = transition(ctx3, { type: "RECOVER" });
  assert(r3.context.state === "ready", "RECOVER in ready should be ignored");
}

// Test 15: Closed is terminal — nothing transitions out
console.log("\n--- Test 15: Closed is terminal ---");
{
  const ctx = ctxInState("closed");
  for (const eventType of ALL_EVENT_TYPES) {
    let event: CodecEvent;
    switch (eventType) {
      case "SEND_CAPABILITIES": event = { type: eventType, caps: PCM16_CAPS }; break;
      case "SESSION_READY": event = { type: eventType, format: PCM16_FORMAT }; break;
      case "SESSION_REJECTED": event = { type: eventType, reason: "test" }; break;
      case "CODEC_ERROR": event = { type: eventType, error: "test" }; break;
      case "RENEGOTIATE": event = { type: eventType, caps: OPUS_CAPS }; break;
      default: event = { type: eventType } as CodecEvent; break;
    }
    const r = transition(ctx, event);
    assert(r.context.state === "closed", `${eventType} in closed should stay closed`);
  }
}

// Test 16: Fail count increments on repeated failures
console.log("\n--- Test 16: Fail count tracking ---");
{
  let ctx = walkPath([
    { type: "WS_OPEN" },
    { type: "SEND_CAPABILITIES", caps: PCM16_CAPS },
    { type: "SESSION_REJECTED", reason: "fail 1" },
  ]);
  assert(ctx.failCount === 1, "First failure: failCount should be 1");

  // Recover and try again
  ctx = transition(ctx, { type: "RECOVER" }).context;
  ctx = transition(ctx, { type: "SEND_CAPABILITIES", caps: PCM16_CAPS }).context;
  ctx = transition(ctx, { type: "NEGOTIATION_TIMEOUT" }).context;
  assert(ctx.failCount === 2, "Second failure: failCount should be 2");

  // Successful negotiation resets count
  ctx = transition(ctx, { type: "RECOVER" }).context;
  ctx = transition(ctx, { type: "SEND_CAPABILITIES", caps: PCM16_CAPS }).context;
  ctx = transition(ctx, { type: "SESSION_READY", format: PCM16_FORMAT }).context;
  assert(ctx.failCount === 0, "Success should reset failCount to 0");
}

// Test 17: Transition table covers all documented transitions
console.log("\n--- Test 17: Transition table consistency ---");
{
  // Every entry in TRANSITION_TABLE should match the actual transition function
  for (const entry of TRANSITION_TABLE) {
    const ctx = ctxInState(entry.from);
    let event: CodecEvent;
    switch (entry.event) {
      case "SEND_CAPABILITIES": event = { type: entry.event, caps: PCM16_CAPS }; break;
      case "SESSION_READY": event = { type: entry.event, format: PCM16_FORMAT }; break;
      case "SESSION_REJECTED": event = { type: entry.event, reason: "test" }; break;
      case "CODEC_ERROR": event = { type: entry.event, error: "test" }; break;
      case "RENEGOTIATE": event = { type: entry.event, caps: OPUS_CAPS }; break;
      default: event = { type: entry.event } as CodecEvent; break;
    }

    const result = transition(ctx, event);
    // For renegotiation fallback cases, the table says "ready" when format exists
    // Our ctxInState gives format for ready/streaming/renegotiating
    const expectedTo = entry.to;
    assert(
      result.context.state === expectedTo,
      `Table: ${entry.from} + ${entry.event} → ${expectedTo}, got ${result.context.state}`
    );

    // Verify documented effects are present
    for (const eff of entry.effects) {
      assert(
        hasEffect(result.effects, eff),
        `Table: ${entry.from} + ${entry.event} should have ${eff} effect`
      );
    }
  }
  console.log(`  ${TRANSITION_TABLE.length} transition table entries verified`);
}

// Test 18: Format preservation across non-format-changing transitions
console.log("\n--- Test 18: Format preservation ---");
{
  let ctx = walkPath([
    { type: "WS_OPEN" },
    { type: "SEND_CAPABILITIES", caps: PCM16_CAPS },
    { type: "SESSION_READY", format: PCM16_FORMAT },
  ]);
  assert(ctx.format !== null, "Should have format after negotiation");

  // AUDIO_START preserves format
  ctx = transition(ctx, { type: "AUDIO_START" }).context;
  assert(ctx.format?.encoding === "pcm16", "Format preserved through AUDIO_START");

  // AUDIO_STOP preserves format
  ctx = transition(ctx, { type: "AUDIO_STOP" }).context;
  assert(ctx.format?.encoding === "pcm16", "Format preserved through AUDIO_STOP");

  // WS_CLOSE clears format
  const r = transition(ctx, { type: "WS_CLOSE" });
  assert(r.context.format === null, "WS_CLOSE should clear format");
}

// ─── Summary ──────────────────────────────────────────────────────────

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  process.exit(1);
}
