# Rethink: Testing Strategy — Presence Gaps & Indicator States

## Context

The "user" here is a **developer running tests** — not an end-user of the voice app. The question: at every moment during test setup, execution, and teardown, does the developer have clear feedback about what's happening? Or are there silent gaps where they're staring at a spinner (or nothing) with no insight?

## Timeline Analysis: Developer Action → System Feedback

### Phase 1: Test Configuration (`idle` → `configuring` → `ready`)

| Step | Developer Action | Current Feedback | Gap? |
|------|-----------------|-----------------|------|
| 1a | Calls `configure({stt, llm, tts})` | State emits `configuring` | No gap |
| 1b | Mock provider creation (STT, LLM, TTS) | **Nothing** — mocks are created synchronously but no per-provider confirmation | **GAP**: If one mock config is invalid, developer doesn't know which one failed |
| 1c | Adds assertions | No state change, self-loop | Minor gap: no count visible |
| 1d | Calls `wirePipeline()` | State emits `ready` | No gap |
| 1e | **Invalid config passed** | Currently: no validation — silently creates bad mocks | **GAP**: Bad config surfaces as cryptic runtime error later, not at config time |

**Proposed indicator states for Phase 1:**
- `EMIT_PROVIDER_CONFIGURED { provider: "stt" | "llm" | "tts", valid: boolean }` — emitted per-provider during `CONFIGURE`, so developer sees which providers were set up
- `EMIT_CONFIG_VALIDATION { errors: string[] }` — if config is invalid, surface immediately with actionable messages ("STT failAfter must be < transcripts.length")

### Phase 2: Test Execution (`ready` → `running`)

| Step | Developer Action | Current Feedback | Gap? |
|------|-----------------|-----------------|------|
| 2a | Calls `startRun()` | State emits `running`, timer starts | No gap |
| 2b | Mock STT emits partial transcript | `PROVIDER_EVENT` recorded, state stays `running` | **GAP**: Developer doesn't know pipeline is progressing — just "running" |
| 2c | Mock LLM streams tokens | `PROVIDER_EVENT` recorded | **GAP**: Same — no progress indicator |
| 2d | Mock TTS generates chunks | `PROVIDER_EVENT` recorded | **GAP**: Same |
| 2e | **Pipeline stalls** (bug in processor) | **Nothing until PIPELINE_TIMEOUT** (10s!) | **CRITICAL GAP**: 10 seconds of silence before timeout fires |
| 2f | **Provider emits unexpected event** | Silently recorded | **GAP**: No warning that event doesn't match expected sequence |

**Proposed indicator states for Phase 2:**
- `EMIT_PROGRESS { phase: "stt" | "llm" | "tts", eventCount: number, elapsed: number }` — periodic progress updates so developer sees the pipeline is alive
- `EMIT_STAGE_ENTERED { stage: "stt→transcript" | "transcript→llm" | "llm→aggregator" | "aggregator→tts" | "tts→audio" }` — emitted when pipeline enters each stage, giving coarse progress
- `EMIT_STALL_WARNING { afterMs: number, lastEvent: string }` — emitted at e.g. 2s of no events (well before the 10s timeout), so developer knows something might be wrong
- Add a stall detection timer: if no `PROVIDER_EVENT` for N ms during `running`, emit stall warning

### Phase 3: Failure Injection (`running` → `injecting_failure`)

| Step | Developer Action | Current Feedback | Gap? |
|------|-----------------|-----------------|------|
| 3a | Calls `injectFailure("stt", "connection dropped")` | State emits `injecting_failure` | No gap |
| 3b | Failure propagates through pipeline | **Nothing until FAILURE_PROPAGATED** | **GAP**: Developer doesn't know if failure was received by the provider, is propagating, or is stuck |
| 3c | **Failure doesn't propagate** (pipeline swallows error) | **Nothing until PIPELINE_TIMEOUT** | **CRITICAL GAP**: Swallowed errors cause 10s hang with no feedback |

**Proposed indicator states for Phase 3:**
- `EMIT_FAILURE_INJECTED { provider: string, acknowledged: boolean }` — confirms the mock provider received and will act on the failure
- `EMIT_FAILURE_PROPAGATING { currentStage: string }` — tracks failure as it moves through pipeline stages
- Reuse stall warning timer: if no `FAILURE_PROPAGATED` within 2s, warn

### Phase 4: Collection & Assertion (`collecting` → `asserting`)

| Step | Developer Action | Current Feedback | Gap? |
|------|-----------------|-----------------|------|
| 4a | Pipeline completes, events collected | State emits `collecting` | No gap |
| 4b | Developer calls `runAssertions()` | State emits `asserting` | No gap |
| 4c | Individual assertion passes | `ASSERTION_PASSED` — but state stays `asserting` | **GAP**: Developer doesn't know which assertion passed or what it checked |
| 4d | Individual assertion fails | `ASSERTION_FAILED` with reason | Partial gap: reason exists but no context on which assertion |
| 4e | **Assertion hangs** (e.g., waiting for event that was never emitted) | **No timeout on assertion phase** | **CRITICAL GAP**: No timeout guard on `asserting` state |

**Proposed indicator states for Phase 4:**
- `EMIT_ASSERTION_RESULT { index: number, total: number, description: string, passed: boolean, reason?: string }` — per-assertion progress with context
- Add a timeout guard on `asserting` state (e.g., 5s) — assertions should be synchronous checks on collected data, so any hang indicates a bug
- `EMIT_COLLECTION_SUMMARY { eventCount: number, providers: string[], durationMs: number }` — quick summary after collecting, before asserting

### Phase 5: Teardown (`tearing_down` → `passed` | `failed`)

| Step | Developer Action | Current Feedback | Gap? |
|------|-----------------|-----------------|------|
| 5a | All assertions done, teardown starts | State emits `tearing_down` | No gap |
| 5b | Providers disconnecting | **Nothing until TEARDOWN_COMPLETE** | **GAP**: If teardown is slow, developer doesn't know which provider is hanging |
| 5c | Resources released | `EMIT_RESULT` with pass/fail | No gap |
| 5d | **Teardown hangs** (orphaned connection) | Timeout after 5s, but state goes to `passed`/`failed` with a log | Weak: the log is easy to miss, and 5s is long |

**Proposed indicator states for Phase 5:**
- `EMIT_PROVIDER_DISCONNECTED { provider: string }` — per-provider teardown confirmation
- `EMIT_TEARDOWN_PROGRESS { disconnected: string[], pending: string[] }` — so developer sees which providers are cleaned up

## Summary of Critical Gaps

| # | Gap | Severity | Current Behavior | Proposed Fix |
|---|-----|----------|-----------------|-------------|
| 1 | Pipeline stall during `running` | **Critical** | 10s silent hang → timeout | Stall warning at 2s; stage-entered indicators |
| 2 | Failure injection doesn't propagate | **Critical** | 10s silent hang → timeout | Injection ACK + propagation tracking + stall warning |
| 3 | Assertion phase has no timeout | **Critical** | Hangs forever | Add timeout guard (5s) on `asserting` state |
| 4 | Invalid mock config | High | Runtime error later | Validate at config time, emit errors immediately |
| 5 | No per-provider teardown feedback | Medium | Silent until done/timeout | Per-provider disconnect events |
| 6 | No progress during execution | Medium | Just "running" for entire pipeline | Stage-entered + event count indicators |
| 7 | No per-assertion context | Low | Pass/fail without saying which | Index + description in assertion results |

## Proposed State Machine Additions

### New States
None needed — the gaps are about **missing effects/emissions within existing states**, not missing states.

### New Effects (Indicator Emissions)
```typescript
// Add to HarnessEffect union:
| { type: "EMIT_PROGRESS"; phase: string; eventCount: number; elapsedMs: number }
| { type: "EMIT_STAGE_ENTERED"; stage: string }
| { type: "EMIT_STALL_WARNING"; afterMs: number; lastEventType: string }
| { type: "EMIT_FAILURE_ACK"; provider: string }
| { type: "EMIT_ASSERTION_DETAIL"; index: number; total: number; description: string; passed: boolean }
| { type: "EMIT_PROVIDER_DISCONNECTED"; provider: string }
| { type: "EMIT_CONFIG_VALIDATED"; errors: string[] }
| { type: "EMIT_COLLECTION_SUMMARY"; eventCount: number; durationMs: number }
```

### New Timeout Guard
```typescript
// Add to TIMEOUT_GUARDED_STATES:
asserting: { timer: "assertion", timeoutEvent: "PIPELINE_TIMEOUT" }  // 5s — assertions should be instant
```

### Stall Detection (New Concept)
The stall detection doesn't need a new state — it's a **timer that resets on every `PROVIDER_EVENT`** during `running` or `injecting_failure`:
- On entering `running`: start a 2s stall timer
- On every `PROVIDER_EVENT`: reset the stall timer
- On stall timer expiry: emit `EMIT_STALL_WARNING` (does NOT change state)
- On `PIPELINE_COMPLETE` or `PIPELINE_TIMEOUT`: cancel stall timer

This requires a new effect: `{ type: "RESET_STALL_TIMER" }` emitted alongside every `RECORD_EVENT`.

## Key Principle

**The developer should never wait more than 2 seconds without feedback.** The 10s pipeline timeout is a hard safety net, but the stall warning at 2s is the soft indicator that something is wrong. Combined with stage-entered indicators, the developer always knows where the pipeline is and whether it's alive.
