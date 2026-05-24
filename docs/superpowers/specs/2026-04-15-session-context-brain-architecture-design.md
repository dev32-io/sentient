# Session Context — Cerebrum Architecture Design

**Date**: 2026-04-15
**Status**: Draft — pending user review
**Scope**: Full replacement of the gateway's turn-based pipeline (`ContinuousSession` / `TurnController` / `voice-turn` / `ContextAssembler` / `SessionHistory`) with a cycle-based cerebrum architecture. Atomic refactor across `gateway/src/`, `shared/web-sdk/`, `shared/protocol/`, `gateway/webui/`, `gateway/config.yaml`, and the Docker stack.

---

## 1. Overview

The gateway becomes a **cerebrum**: a stateful agent that perceives the world through **Adapters**, builds short-term working memory in a **ShortTermContext**, fires cognition in salience-triggered **Cognitive Cycles**, and acts on the world through **Effects** invoked as LLM tool calls.

Everything the user says, hears, sees — and everything the assistant does — flows through this uniform loop. Today's voice pipeline is a single instance of the loop wired for speech in and speech out. The architecture leaves room for future sensor inputs (motion, light, door, smoke) and future motor outputs (notifications, device control, memory writes) without reshaping the core.

Key design moves that distinguish this spec:

1. **Turn is dead.** Cognition is no longer bounded by "user speaks → assistant replies". A cognitive cycle is triggered when salience crosses threshold, which usually is a user utterance but may also be a sensor event when we wire those later.
2. **ShortTermContext is immutable + append-only.** Adapters call `inject()`; the context grows. Cognition reads a projection of the context via `project()`, never the raw log. Short-term memory per session only; summarization and long-term memory are deferred features with hooks preserved.
3. **Effects are LLM tools, gated by projection + assembler.** Every motor action — including speech itself — is an LLM tool call. `ShortTermContext.project()` produces a per-effect salience table; `ContextAssembler` uses that table to selectively include only the tools whose salience crossed threshold, stripping everything else so the LLM never sees irrelevant effects. Safety is structural, not policy.
4. **Attention gate is deterministic.** Salience thresholds + class policies + tonic modulators decide when cognition fires. No LLM in the gate; non-determinism in a home assistant is a safety hazard.
5. **Event-only refractory.** Effect→context updates route through an `afferent-only` interface that zeroes salience, guaranteeing effects cannot recursively wake cognition — a type-level invariant, not a timer.

### 1.1 Atomic ship

Gateway + `@sentient/web-sdk` + `shared/protocol` + `gateway/webui` move together on `feature/brain-arch`. The old pipeline (`ContinuousSession`, `TurnController`, `voice-turn`, `SessionHistory`, turn-based protocol messages) is deleted, not flag-gated. Merge happens after the Verification gate in §11 passes.

### 1.2 Non-goals

No memory system (short-term rolling summary, per-user long-term markdown memory) in Phase 1 — hooks present, implementation is a sibling spec. No sensor adapters (motion, light, smoke) — the class, config, and gate logic exist but only `user-direct`-class adapters fire cycles in Phase 1. No tool-confirmation UI flow (`impact: "confirm"`) — registerable but not exercised. No Android/iOS SDK rework — web only. No classifier / tool-routing — every cycle is one LLM call; multi-step ReAct is deferred.

---

## 2. Architecture

### 2.1 Mental model

```
  ┌─ Adapters ───────────────┐      ┌─ Effects ──────────────────┐
  │  UserTextInputAdapter    │      │  TTSAudioEffect            │
  │  UserAudioInputAdapter   │      │  (future: NotifyEffect,    │
  │  (future: MotionAdapter, │      │   LightToggleEffect,       │
  │   LightAdapter, ...)     │      │   MemoryWriteEffect, ...)  │
  └───────────┬──────────────┘      └─────────────▲──────────────┘
              │ inject()                           │ invoke()
              ▼                                    │
      ┌────────────────────┐             ┌─────────┴──────────┐
      │  ShortTermContext  │             │   TaskManager      │
      │  (immutable log)   │             │  (running effects) │
      └─────────┬──────────┘             └─────────▲──────────┘
                │ project()                        │
                ▼                                  │
      ┌────────────────────┐                       │
      │   AttentionGate    │                       │
      │  (salience → wake) │                       │
      └─────────┬──────────┘                       │
                │ fires cycle                      │
                ▼                                  │
      ┌────────────────────┐     LLM tool calls    │
      │ ContextAssembler → │────────────▶──────────┘
      │   OpenRouter LLM   │
      │ (gated tool list)  │
      └────────────────────┘
```

### 2.2 Top-level file layout (post-refactor)

```
gateway/
├── system_prompts/                          # unchanged (persona.md, language-prompt-*.md)
├── config.yaml                              # adds cerebrum:, salience_map: sections
├── salience_map.yaml                        # NEW — event-kind → per-effect salience
└── src/
    ├── main.ts                              # unchanged shape (~15 lines)
    ├── server.ts                            # unchanged shape
    ├── bootstrap/
    │   ├── create-gateway-services.ts       # composes cerebrum instead of pipeline
    │   ├── cerebrum-factory.ts              # NEW — composes context + gate + assembler + taskmgr
    │   ├── adapter-registry.ts              # NEW — registers enabled adapters
    │   ├── effect-registry.ts               # NEW — registers enabled effects
    │   └── llm-factory.ts, tts-factory.ts   # retained; feed into adapters/effects
    ├── cerebrum/                             # NEW — core loop
    │   ├── short-term-context.ts            # immutable event log + project()
    │   ├── short-term-context-types.ts      # ContextEvent, Projection, SituationAwareness
    │   ├── attention-gate.ts                # CC1 model: debounce + salience math + dispatch
    │   ├── cognitive-cycle.ts               # one-cycle lifecycle orchestrator
    │   ├── context-assembler.ts             # cache-friendly LLM-request builder
    │   ├── task-manager.ts                  # running-effect registry + interrupt propagation
    │   └── afferent.ts                      # EffectLoopback (zero-salience inject path)
    ├── adapters/
    │   ├── adapter-types.ts                 # NEW — Adapter contract
    │   ├── user-text-input-adapter.ts       # NEW
    │   ├── user-audio-input-adapter.ts      # NEW — wraps LocalSttAdapter into cerebrum contract
    │   └── stt/                             # UNCHANGED — local-stt wire-level adapter kept as-is
    ├── effects/
    │   ├── effect-types.ts                  # NEW — Effect contract, impact tiers, wrapper types
    │   ├── effect-wrapper.ts                # NEW — security middleware pipeline
    │   ├── tts-audio-effect.ts              # NEW — wraps Fish Audio as a tool-invokable effect
    │   └── fish-audio/                      # existing TTS provider, now effect-internal
    ├── salience/
    │   ├── salience-map.ts                  # NEW — event-kind → {effect: salience} registry
    │   └── salience-map-loader.ts           # NEW — reads config/salience_map.yaml
    └── api/
        └── ws-handlers.ts                   # rewritten for cycle.* protocol + capability handshake
```

Deleted: `src/pipeline/` (entire directory), `src/context/session-history.ts`, old `src/context/context-assembler.ts`.

### 2.3 Data flow (happy path: voice-mode utterance in Phase 1)

```
User speaks ─► WebSocket audio frames ─► UserAudioInputAdapter (wraps STT)
  ─► transcript.final → ShortTermContext.inject({
        kind: "user.speech.final",
        class: "user-direct",
        signal: "phasic",
        urgency: "none",
        payload: { text, language },
      })
  ─► AttentionGate sees salience for speak ≥ threshold → fires cycle
  ─► CognitiveCycle calls ShortTermContext.project()
       → Situation Awareness Table + salience-by-effect map
  ─► ContextAssembler reads projection, filters tools by salience threshold
       → assembles LLMRequest with only gated tool schemas
  ─► OpenRouter LLM call with TTSAudioEffect ("speak") tool exposed
  ─► LLM responds with tool_call: speak({ text: "..." })
  ─► TaskManager registers task; EffectWrapper runs middleware; handler streams
     Fish Audio frames → client via AssistantAudioResponseConnector channel
  ─► Effect completion → afferent-only inject({ kind: "effect.completed", salience: 0 })
  ─► Cycle ends; ShortTermContext carries forward; ready for next cycle
```

### 2.4 Data flow (barge-in during active TTS)

```
User starts speaking mid-TTS ─► STT emits transcript.start
  ─► UserAudioInputAdapter injects:
        ShortTermContext.inject({
          kind: "user.speech.start",
          class: "user-direct",
          signal: "phasic",
          urgency: "none",
          payload: {},
        })
  ─► AttentionGate evaluates projection:
       salienceByEffect["*cancel*"] = 100 (from salience_map.yaml)
       Active cycle detected → INTERRUPT PATH:
  ─► (1) TaskManager.bargeIn("user_speech_start"):
         For each interruptable task (e.g., running TTS):
           (a) EffectWrapper emits connector.cancelled via task's ConnectorSink (sync WS send)
           (b) EffectWrapper fires task's AbortSignal (sync)
         Then aborts the active cycle's AbortSignal (kills LLM stream)
  ─► (2) Client SDK receives connector.cancelled per connector:
         AssistantAudioResponseConnector → immediately stops playback, dumps audio buffer
         AssistantTextResponseConnector → marks stream as cancelled
  ─► (3) Current cycle rejects; aborted cycle NOT recorded in conversation history
  ─► User finishes speaking → transcript.final arrives → new cycle fires normally
```

**Critical ordering guarantee**: the `cycle.interrupted` WS message is sent BEFORE `TaskManager.cancelAll()` fires abort signals. Since Bun is single-threaded and `ws.send()` queues the frame in the kernel buffer synchronously, the client always receives the interrupt before any cleanup messages. See §3.12 for the concurrency model.

---

## 3. Component specifications

### 3.1 ShortTermContext

**Responsibility**: short-term working memory for the current session. Immutable append-only event log + projection. Recreated on new session (you lose your short-term memory).

```ts
type Signal = "phasic" | "tonic";
type EventClass = "user-direct" | "actionable" | "ambient" | "critical";

interface ContextEvent {
  seq: number;                  // monotonic per session
  ts: number;                   // epoch ms
  kind: string;                 // e.g. "user.speech.final"
  source: string;               // adapter id
  class: EventClass;
  signal: Signal;
  urgency: "none" | "elevated" | "critical";
  payload: unknown;             // kind-specific, zod-validated at adapter boundary
  afferent?: true;              // set when injected via afferent (salience forced 0)
}

interface ShortTermContext {
  readonly sessionId: string;
  inject(event: Omit<ContextEvent, "seq" | "ts">): number;  // returns seq
  injectAfferent(event: Omit<ContextEvent, "seq" | "ts">): number;
  project(opts?: { sinceSeq?: number }): Projection;
  latestSeq(): number;
}

interface Projection {
  situationAwareness: SituationAwarenessTable;
  salienceByEffect: Record<string, number>;   // summed over unprocessed events
  phasicEvents: ContextEvent[];               // ordered, only those newer than sinceSeq
  tonicState: TonicState;                     // latest values of tonic signals
  windowSeqRange: { from: number; to: number };
}

interface SituationAwarenessTable {
  // Endsley's SA model, level 3: current state → near-future inference
  perceivedInputs: Array<{ source: string; kind: string; summary: string; ts: number }>;
  tonicSummary: string;   // e.g. "User is home (last interaction 12s ago). TTS idle."
  comprehension: string;  // freeform prose generated by project() from the above
}

interface TonicState {
  userPresence?: "home" | "away" | "unknown";
  lastInteractionAgeMs: number;
  isTtsPlaying: boolean;
  runningEffects: Array<{ name: string; elapsedMs: number; interruptable: boolean }>;
  // Additional tonic channels registered by adapters
  [channel: string]: unknown;
}
```

**Invariants**:

- Events are append-only. No mutation, no deletion during a session.
- `seq` is strictly monotonic, assigned on inject.
- `inject()` and `injectAfferent()` are **synchronous**. This is a concurrency invariant — see §3.12.
- `injectAfferent()` forces `event.afferent = true` and causes `AttentionGate` to ignore the event for wake-up decisions (but it still enters the log and tonic state).
- `project()` is a **synchronous pure function** of the log + tonic state. Running it twice with the same `sinceSeq` returns equivalent output (modulo `comprehension` — which is templated, not LLM-generated).

**Phase 1 simplifications**:

- `comprehension` is a deterministic string template (no LLM call in projection).
- `SituationAwarenessTable.perceivedInputs` is just the phasic event list rendered to one-liners.
- Short-term memory summarization is not implemented; the log grows unbounded within a session. Sessions are <1 hour in practice; at 5 events/minute × 60 minutes = 300 events, well within token budget. A `max_events_in_projection` config caps the projection tail if ever needed.

**File size target**: `short-term-context.ts` under 150 lines; types in a sibling file.

### 3.2 Adapters

**Responsibility**: perceive the world, translate perceptions into typed events, inject into `ShortTermContext`. Adapters own connection lifecycle to their external data source but never own cognition.

```ts
interface Adapter {
  readonly id: string;                       // unique, e.g. "user-audio-input-v1"
  readonly eventKinds: readonly string[];    // kinds this adapter may emit
  start(ctx: AdapterContext): Promise<void>;
  stop(reason: string): Promise<void>;
}

interface AdapterContext {
  shortTermContext: ShortTermContext;         // via normal inject()
  afferent: AfferentInjector;                // via injectAfferent()
  abortSignal: AbortSignal;
}
```

Adapters **do not reference effects**. They emit typed events. The `SalienceMap` registry (§3.5) is the single point where event-kind → per-effect salience is declared.

**Phase 1 adapters wired**:

- `UserTextInputAdapter` — listens for `text.input` WS messages; emits `user.text.input` events.
- `UserAudioInputAdapter` — wraps the existing `LocalSttAdapter` (untouched at the wire level); on `transcript.final`, emits `user.speech.final`; on `transcript.start` / VAD rising edge, emits `user.speech.start` (phasic, used for barge-in cancel signal).

**Phase 1 adapters scaffolded but unwired**: motion, light, door, smoke (class definitions + event-kind conventions present in `salience_map.yaml`; no code that emits them).

### 3.3 Effects

**Responsibility**: act on the world. Every Effect is LLM-invokable as a tool call.

```ts
interface EffectDefinition<ArgsT> {
  name: string;                              // tool name exposed to LLM
  description: string;                       // shown to LLM in tool schema
  schema: JSONSchema;                        // validates args; auto-exposed to LLM
  argsValidator: (raw: unknown) => ArgsT;    // thin TS wrapper via zod

  impact: "auto" | "confirm" | "admin";
  rolesAllowed: readonly UserRole[];
  rateLimit?: { perHour: number; perSession?: number };
  capabilities: readonly string[];           // e.g. ["audio.output", "network.notify"]
  interruptable: boolean;
  serializing?: true;                        // opt out of parallel dispatch

  handler: (args: ArgsT, ctx: EffectContext) => AsyncGenerator<EffectFrame> | Promise<EffectResult>;
}

interface EffectContext {
  sessionId: string;
  userRole: UserRole;
  taskId: string;
  abortSignal: AbortSignal;
  afferent: AfferentInjector;                // for status/progress updates back to context
  audit: AuditLogger;
  connector: ConnectorSink;                  // writes to the matching client connector
}

type EffectFrame =
  | { type: "progress"; percent: number }
  | { type: "audio"; frame: Uint8Array }
  | { type: "text"; delta: string }
  | { type: "done"; result?: unknown };
```

**Phase 1 effects wired**: `TTSAudioEffect` only. Its `name = "speak"`, `description = "Speak a reply aloud to the user. Use this to respond conversationally."`, `capabilities = ["audio.output"]`, `impact = "auto"`, `rolesAllowed = ["adult", "child"]`, `interruptable = true`. Handler is an `AsyncGenerator<EffectFrame>` that streams text→audio frames through Fish Audio into the `AssistantAudioResponseConnector` channel.

**Phase 1 effects scaffolded but unregistered**: notification, light, memory-write — examples only in comments.

### 3.4 Effect security wrapper

Every effect handler is wrapped by `EffectWrapper.compose(definition)` before being exposed for invocation. The wrapper is the single place tool-call security lives.

**Fixed middleware order** (per effect invocation):

1. **Schema validation** — args parsed by `definition.argsValidator` (zod under a JSON-schema registration). Reject on parse failure.
2. **Role gate** — reject if `session.role ∉ definition.rolesAllowed`.
3. **Capability check** — reject if `runtime.grantedCapabilities ⊉ definition.capabilities`. (Runtime capabilities derive from the SDK's connector advertisement — see §6.)
4. **Rate limit** — `TaskManager` rejects if `perHour` / `perSession` counters exceeded.
5. **Confirmation** (only if `impact ≠ "auto"`) — emit `tool.confirm_request` to client, await `tool.confirm` with 30s timeout, deny-by-default. Phase 1 does not exercise this path but the code is present.
6. **Audit log** — write invocation start entry with sessionId, taskId, effect name, arg digest, decision.
7. **Register with TaskManager** — the wrapper (not the handler) owns `AbortController` creation.
8. **Handler invocation** — under the abort signal. Handler may yield frames and/or inject afferent status updates.
9. **Output sanitization** — any data flowing back into `ShortTermContext` via `ctx.afferent` is scanned against canary tokens, known API key patterns, and cross-user identifiers. Frames emitted to the connector are NOT sanitized (they're transport-specific binary/text payloads, governed by connector contracts).
10. **Audit log** — completion entry with outcome, duration, abort reason if any.
11. **TaskManager deregister**.

Hard-coded gates that LLM-supplied args can never bypass belong INSIDE the handler, not in args. For example, `MemoryWriteEffect.handler` will derive the target path from `sessionId` + fixed filesystem root; no path component ever comes from `args`.

**File size target**: `effect-wrapper.ts` under 250 lines.

### 3.5 SalienceMap

**Responsibility**: declare which event kinds contribute how much salience to which effects. Decoupled from both adapters and effects.

```yaml
# gateway/salience_map.yaml  (loaded at startup; hot-reloadable later)
version: 1
entries:
  user.text.input:
    speak: 85                         # user directly addressed us → high reply salience
  user.speech.final:
    speak: 85
  user.speech.start:                  # phasic, barge-in trigger
    speak: 0
    "*cancel*": 100                   # special pseudo-effect = cancel running cycle/tasks
  effect.completed:
    # afferent-only events are emitted with salience=0 regardless; listed here for docs
  # Phase-2 examples (wire them when sensors exist):
  # sensor.motion.enter:
  #   notify: 40
  #   deter-intruder-speech: 0
  # sensor.smoke.rising:
  #   notify: 95
  #   deter-intruder-speech: 0

tonic_modulators:
  # Modulates outgoing salience at projection time based on tonic state.
  # Example (Phase 2): when user_away: true, boost notify/deter salience.
  # Phase 1: empty.
  entries: []
```

**At projection time**, `ShortTermContext.project()`:

1. Iterates unprocessed phasic events since `sinceSeq`.
2. Looks up each event's kind in `salience_map.entries`.
3. Sums per-effect salience across events.
4. Applies `tonic_modulators` (Phase 1: no-op).
5. Returns `salienceByEffect` in the `Projection`.

`"*cancel*"` is a reserved pseudo-effect used by the gate to signal cycle abort (see §3.6).

**File size target**: `salience-map.ts` under 150 lines.

### 3.6 AttentionGate

**Responsibility**: decide when to fire a cognitive cycle. Pure function over `Projection + thresholds + gate state`.

**Model (CC1 — event-log + debounce + sequence-scoped cycles):**

- Subscribes to `ShortTermContext` inject notifications.
- On each inject, opens or extends a **debounce window** (`cerebrum.cycle.debounce_window_ms`, default 80ms).
- When the window closes, calls `project(sinceSeq = lastCycleSeq)` and evaluates:
  - If any entry in `salienceByEffect` exceeds the **immediate-wake threshold** (default 100 per effect) → fire cycle immediately, don't wait for window close.
  - Else if any entry exceeds the **standard threshold** (configurable per effect, default 50 for `speak`) → fire cycle at window close.
  - Else → do nothing; events accumulate toward next window.
- **Abort path**: if `salienceByEffect["*cancel*"] > 0` and a cycle is currently running:
  1. Call `TaskManager.bargeIn("user_speech_start")` — cancels all interruptable tasks (each emitting `connector.cancelled` through its connector before aborting — see §3.10), THEN aborts the active cycle's signal.
  2. Reset `lastCycleSeq` so in-flight events are re-evaluated against a fresh projection.
- **During active cycle**: new injects still update the log, and `*cancel*` can preempt. Non-cancel salience accumulates silently; the next cycle fires after current cycle completes.
- **Afferent events**: `event.afferent === true` → skip threshold check entirely. The event enters the log and updates tonic state, but never contributes to wake decisions.
- **Hard safety net**: `cerebrum.cycle.max_per_hour` (default 120). Exceeding this triggers a `rate_limited` log entry and suppresses cognition until the rolling hour allows.

Gate state carried between cycles:

```ts
interface AttentionGateState {
  lastCycleEndSeq: number;   // seq value at the moment the last cycle ended
  debounceUntil: number | null;  // epoch ms
  activeCycleId: string | null;
  activeCycleCleanup: Promise<void> | null;  // awaited before next cycle starts
  cyclesThisHour: number[];  // timestamps, rolling window
}
```

**No timers for refractory.** The afferent-only invariant makes recursive wake-up structurally impossible. The only rate-limit mechanism is `max_per_hour`, which is cost control, not correctness.

**File size target**: `attention-gate.ts` under 250 lines.

### 3.7 Cognitive cycle

**Responsibility**: orchestrate one cycle. Owns per-cycle state; created by `AttentionGate`, disposed when complete or aborted.

Lifecycle (linearly, with `AbortSignal` propagating through):

1. `AttentionGate` fires cycle with `{cycleId, projectionSinceSeq, triggerReason}`.
2. `AttentionGate` awaits `activeCycleCleanup` if previous cycle is still cleaning up (serial cycle guarantee — §3.12).
3. `CognitiveCycle` calls `ShortTermContext.project({sinceSeq})` — **synchronous**.
4. Passes projection to `ContextAssembler.assemble(projection, effectRegistry, sessionMeta)` — **synchronous**. Returns `LLMRequest`.
5. Calls `llmProvider.stream(LLMRequest, abortSignal)` — **first async point**. No interleaving possible between steps 3-5.
6. As tool-call chunks arrive, dispatches them to `EffectWrapper.invoke(name, args, ctx)`. Parallel by default (`Promise.allSettled`), serialized where `definition.serializing` is set.
7. Each effect handler runs under its own `AbortSignal` (child of cycle's signal).
8. Cycle completes when: all LLM output consumed AND all dispatched effects complete OR cycle is aborted.
9. On completion, cycle injects a tuple of afferent events capturing the full LLM interaction for future cycles to read as conversation history:
   - `cognition.assistant_message` with `{cycleId, content, toolCallIds[]}`
   - One `cognition.tool_call` per invoked effect with `{cycleId, taskId, toolName, args}`
   - One `cognition.tool_result` per completed effect with `{cycleId, taskId, result}`
   All are afferent (salience 0, wake-excluded). `ContextAssembler` renders these as `assistant` / `tool` role messages in the conversation history layer (§3.8).
10. `AttentionGate.markCycleEnded(cycleId)`; ready for next dispatch.

**Tool-call batch dispatch semantics**: when the LLM emits N tool calls in one response, dispatch them all in parallel if none have `serializing: true`. If *any* effect in the batch is `serializing`, dispatch the whole batch sequentially in emission order. Phase 1 has only `TTSAudioEffect` (not serializing) so batches are always parallel in practice; the contract is designed for future mixed batches.

**Cycle abort semantics**:

- Received: `abortSignal.abort(reason)`.
- Effects: interruptable effects observe the signal and clean up (TTS: stop generation, flush buffer); non-interruptable effects (`interruptable: false`) continue to completion but are logged with a warning if they outlive the cycle.
- LLM stream: the stream is cancelled; the partial response is NOT re-injected into context (aborted cycles are "never happened" for history).
- Cycle emits `cycle.aborted` (afferent, salience 0) with reason.

**File size target**: `cognitive-cycle.ts` under 200 lines.

### 3.8 ContextAssembler

**Responsibility**: assemble the `LLMRequest` from the projection, effect registry, and session metadata. Deterministic; testable as a pure function. **Synchronous** (concurrency invariant — §3.12).

Output shape (matches OpenRouter / OpenAI tool-calling format):

```ts
interface LLMRequest {
  model: string;
  messages: LLMMessage[];
  tools: ToolDefinition[];
  tool_choice?: "auto" | "none" | { type: "function"; function: { name: string } };
  max_tokens: number;
  temperature?: number;
}
```

**Assembly layers — cache-friendly ordering** (static prefix first, rolling content last):

**Layer 1 — System message** (`system` role, single concatenated block, **stable across cycles**):
- Persona + rules — loaded from `persona.md` + `system_prompts/system_prompt.md` + `language-prompt-*.md` (unchanged loader).
- Short-term memory summary hook — Phase 1: empty. Future: rolling summary of older cycle history.
- This entire block is identical across cycles in Phase 1, maximizing prompt-cache prefix hits.

**Layer 2 — Tools array** (`tools` field, **semi-stable**):
- Effect definitions whose salience crossed threshold, as `ToolDefinition[]`. An effect NOT in this list cannot be invoked; this is the hard safety barrier.
- ContextAssembler reads `projection.salienceByEffect`, compares each against the effect's configured threshold, and includes only those that pass. The LLM never sees stripped effects.
- In Phase 1 with only `user-direct` adapters triggering, the tool set is virtually always `[speak]` — stable across cycles.

**Layer 3 — Per-cycle system context** (second `system` message, **changes per cycle**):
- Situation Awareness Table — rendered from `projection.situationAwareness`. Structured markdown table, not prose.
- Tonic state summary — `projection.tonicState` rendered as key-value lines.
- Dynamic instruction block — generated from `cerebrum.cycle.priority_template`, parameterized on the threshold-crossing set. Example: "User addressed you directly. Respond by calling `speak` with your reply as the `text` argument. Keep replies concise and conversational."

**Layer 4 — Conversation history** (`user` / `assistant` / `tool` roles, **rolling, at the end**):
- Prior cycles' `cognition.assistant_message` / `cognition.tool_call` / `cognition.tool_result` afferent events rendered at native OpenAI roles (`assistant` with `tool_calls`, `tool` with `tool_call_id` matching), interleaved with prior `user.*` phasic events rendered as `user`-role content wrapped in `<perception source="..." kind="...">` tags. Order preserved by `seq`. This guarantees OpenAI-format invariants (tool_call / tool_result adjacency by id) hold.
- Current cycle stimulus as the final `user`-role block: phasic events newer than the last cycle's end-seq. If a single dominant phasic event triggered this cycle, named explicitly as "Current trigger" at the end of this block.

**Token budget management**:
- Total assembled tokens must stay under the model's context limit (80% utilization, configurable).
- Layers 1, 2, and 3 are NEVER trimmed — always kept in full.
- Only Layer 4 (conversation history) is truncated when over budget.
- Truncation from the OLDEST end. Never split a `tool_call` / `tool_result` pair — drop both or neither (OpenAI format violation otherwise).
- Simple token counting: ~4 chars/token approximation. Exact counting deferred to a future enhancement.
- Config: `cerebrum.cycle.history_max_tokens` (default 4096).

Tool definitions follow OpenAI function-calling format:

```ts
interface ToolDefinition {
  type: "function";
  function: {
    name: string;          // effect.name
    description: string;   // effect.description
    parameters: JSONSchema; // effect.schema
  };
}
```

Provider: OpenRouter chat-completions with `tools` + `tool_choice: "auto"`. Model: `google/gemini-2.5-flash` (config key `llm.chat_model`). Gemini 2.5 Flash supports tool calling natively via OpenRouter. Switch to streaming endpoint (`stream: true`) with tool-call chunks handled via the standard SSE → concatenate-by-tool_call_id pattern.

**File size target**: `context-assembler.ts` under 250 lines. Extract sub-renderers (persona loader, SA renderer, tool schema builder) into separate files if needed.

### 3.9 TaskManager

**Responsibility**: track running effect invocations. One instance per session. Integrates with the effect wrapper (§3.4) and the attention gate (§3.6).

```ts
interface TaskHandle {
  taskId: string;
  effectName: string;
  args: unknown;
  startedAt: number;
  abortController: AbortController;
  interruptable: boolean;
}

interface TaskManager {
  register(h: TaskHandle): void;
  deregister(taskId: string, outcome: "completed" | "aborted" | "failed"): void;
  cancel(taskId: string, reason: string): void;   // cancel one task (LLM decision, future user request)
  bargeIn(reason: string): void;                   // cancel ALL interruptable tasks + abort active cycle
  listRunning(): ReadonlyArray<TaskSummary>;
  countInWindow(effectName: string, windowMs: number): number;  // rate limiting
}

interface TaskSummary {
  taskId: string;
  effectName: string;
  elapsedMs: number;
  interruptable: boolean;
}
```

`listRunning()` is read by `ShortTermContext.project()` (via an internal binding set at construction) to populate `tonicState.runningEffects`. This is how the LLM "knows what it's currently doing" when asked.

**No task queuing in Phase 1.** LLM tool calls fire immediately via the wrapper. If a user feature needs queuing (e.g., "tell me when you're done"), it's a future effect that writes to memory or schedules a future cycle; it doesn't require queuing infrastructure here.

**File size target**: `task-manager.ts` under 200 lines.

### 3.10 Cancellation propagation

Cancellation flows **per-task, per-connector** — not as a blanket cycle-level message. This gives us two distinct paths through the same mechanism:

**`cancel(taskId, reason)`** — selective cancellation (future: LLM decides to stop one effect while keeping others running):
1. EffectWrapper for that task emits `connector.cancelled` via the task's `ConnectorSink` — **synchronous** WS frame enqueue.
2. EffectWrapper calls `abortController.abort(reason)` on that task — **synchronous**.
3. Effect handler observes abort on next `await` (subsequent microtask).
4. Client SDK routes `connector.cancelled` to the specific connector by `taskId`. That connector decides its own action (audio: flush buffer; text: mark cancelled; future connectors: their own policy).

**`bargeIn(reason)`** — full override (barge-in, user says "stop"):
1. Iterates all interruptable tasks; for each, runs the same steps 1-3 above.
2. THEN aborts the active cycle's `AbortSignal` (kills LLM stream).
3. Each connector receives its own `connector.cancelled` independently.

**Why two separate functions**: `cancel()` is a scalpel — stop one task, cycle continues, LLM might call another tool. `bargeIn()` is a sledgehammer — stop everything, abort cognition, reset for fresh input. Mixing them into one function tangles the "should the cycle itself abort?" decision with per-task cleanup.

**Why no race condition**: the EffectWrapper emits `connector.cancelled` BEFORE calling `abortController.abort()`, both synchronously in the same microtask. WebSocket message ordering guarantees `connector.cancelled` arrives at the client before any `connector.*.done` frames emitted by effect cleanup (which runs in subsequent microtasks after the handler observes the abort signal). Bun's single-threaded event loop guarantees no interleaving.

**Client SDK behavior on `connector.cancelled`**:
- `AssistantAudioResponseConnector`: immediately stops playback, dumps audio buffer, emits silence. No waiting for buffer drain.
- `AssistantTextResponseConnector`: marks current text stream as cancelled (UI can show "..." or similar).
- `CognitionStatusConnector`: not directly affected — it tracks cycle lifecycle (`cycle.started` / `cycle.completed` / `cycle.aborted`), not per-task cancellation.
- Future connectors define their own cancellation policy at registration.

### 3.11 Afferent interface

```ts
interface AfferentInjector {
  inject(event: Omit<ContextEvent, "seq" | "ts" | "afferent">): number;
}
```

Under the hood, `AfferentInjector` calls `shortTermContext.injectAfferent(event)`, which sets `afferent: true` and notifies the gate that the event is wake-excluded. Effects, effect-internal progress emitters, and cycle-lifecycle events all route through here. This is the type-level invariant preventing effect→cognition loops.

**Neuro citation**: afferent = signals traveling toward the central nervous system (sensory input); efferent = signals traveling away (motor output). An effect injecting into context is afferent-only: it updates the cerebrum's state without producing an outgoing response.

### 3.12 Concurrency model

The cerebrum is designed for Bun's **single-threaded event loop**. All correctness invariants rely on synchronous operations being atomic — no explicit locks or mutexes.

**Key guarantees**:

1. **`inject()` / `injectAfferent()` / `project()` are synchronous.** No async yield means no interleaving. An inject-then-project sequence observes a consistent snapshot of the event log.
2. **`ContextAssembler.assemble()` is synchronous.** Between `project()` and `llmProvider.stream()` (the first async point in a cycle), there is no yield. A cancel arriving during this window cannot interleave — it queues behind the current synchronous block.
3. **One cycle at a time.** `AttentionGate.activeCycleId` enforces mutual exclusion. If a previous cycle's cleanup is still running (async effect teardown), the next cycle awaits `activeCycleCleanup` before proceeding. This is a promise chain, not a mutex — safe in single-threaded JS.
4. **Cancel is synchronous.** Per-task `connector.cancelled` WS send and `abortController.abort()` are both synchronous. They execute in the same microtask as the `*cancel*` salience evaluation, guaranteeing `connector.cancelled` arrives at the client before any effect cleanup messages.
5. **The only async boundaries in a cycle** are: LLM streaming, effect handler execution, and effect cleanup. All are governed by `AbortSignal`.

**Critical rule**: NEVER introduce an `await` between `project()` and `llmProvider.stream()` in `CognitiveCycle`. Doing so would break the atomicity of projection-to-dispatch, allowing a cancel to interleave and create an inconsistent state. This invariant must be called out in code comments.

### 3.13 Logging requirements

This system is async and event-driven. Debugging without comprehensive logging is impractical. Every component MUST use the tagged logger (`["sentient", "<module>", "<submodule>"]`).

**Mandatory log points** (DEBUG unless noted):

| Component | Event | Level | Key fields |
| --- | --- | --- | --- |
| ShortTermContext | `inject()` called | DEBUG | seq, kind, source, class, signal, urgency, afferent |
| ShortTermContext | `project()` called | DEBUG | sinceSeq, eventCount, salienceByEffect (summary) |
| AttentionGate | Debounce window opened/extended | DEBUG | debounceUntil, triggerKind |
| AttentionGate | Threshold evaluation | DEBUG | salienceByEffect, thresholds, decision (wake/skip/cancel) |
| AttentionGate | Cycle dispatched | INFO | cycleId, triggerReason, sinceSeq |
| AttentionGate | Barge-in triggered | INFO | cycleId, reason, tasksToCancel |
| AttentionGate | Rate limit hit | WARN | cyclesThisHour, max_per_hour |
| CognitiveCycle | Projection rendered | DEBUG | eventCount, salienceMap, tonicSummary |
| CognitiveCycle | LLM request assembled | DEBUG | messageCount, toolCount, estimatedTokens |
| CognitiveCycle | LLM stream started | INFO | cycleId, model, toolChoice |
| CognitiveCycle | Tool call received | INFO | cycleId, toolName, taskId, argDigest |
| CognitiveCycle | Cycle completed | INFO | cycleId, duration_ms, effectsInvoked[], effectOutcomes[] |
| CognitiveCycle | Cycle aborted | INFO | cycleId, reason, duration_ms, runningTasksAborted |
| ContextAssembler | Assembly complete | DEBUG | layer sizes (tokens), history truncated (bool), toolsExposed[] |
| TaskManager | Task registered | DEBUG | taskId, effectName, interruptable |
| TaskManager | Task completed/aborted/failed | INFO | taskId, effectName, outcome, duration_ms |
| TaskManager | cancel called | INFO | taskId, effectName, reason |
| TaskManager | bargeIn called | INFO | reason, taskCount, interruptableCount |
| EffectWrapper | Middleware decision | DEBUG | step (schema/role/capability/rate/confirm), decision (pass/reject), reason |
| EffectWrapper | Handler started | DEBUG | taskId, effectName |
| EffectWrapper | Handler frame emitted | DEBUG | taskId, frameType, byteSize (for audio) |
| Adapter | Registered | INFO | adapterId, eventKinds[] |
| Adapter | Event emitted | DEBUG | adapterId, kind, payloadSummary |
| Adapter | Started/stopped | INFO | adapterId, reason |
| Effect | Registered | INFO | effectName, impact, capabilities[], interruptable |
| SalienceMap | Loaded | INFO | entryCount, effectNames[] |
| WS handler | Capability handshake | INFO | sessionId, supports[], enabledEffects[] |
| EffectWrapper | connector.cancelled emitted | INFO | taskId, connector, reason |
| SDK connector | Registered/attached/detached | INFO | capability, kind |

**Rules**:
- Every log entry that references a cycle includes `cycleId`.
- Every log entry that references a task includes `taskId`.
- Every log entry that references a session includes `sessionId`.
- Audio frame DEBUG logs include byte count, not frame content.
- Never log raw LLM response content at INFO (token-heavy); use DEBUG with truncation.
- Log the full `salienceByEffect` map on every gate evaluation — this is the primary debugging signal for "why did/didn't a cycle fire."

---

## 4. Scientific naming reference

| Concept in code | Term | Origin |
| --- | --- | --- |
| Top-level cognitive module | **cerebrum** | neuroanatomy; the cerebrum encompasses all higher brain functions: perception, cognition, memory, motor control |
| Per-event attentional weight | **salience** | Koch & Ullman 1985, saliency map |
| Time-criticality axis | **urgency** | orthogonal to salience by convention |
| Signal transience | **phasic / tonic** | neuroscience — phasic = bursts, tonic = steady-state |
| Decision to wake cognition | **AttentionGate** | Posner & Petersen attention-network literature; class name cites reticular activating system in docstring |
| Situation-awareness table | **Situation Awareness** | Endsley 1995, 3-level SA model |
| Effect→context update | **afferent-only** | neuroanatomy; afferent = toward CNS |
| Cycle cooldown against loops | not needed — afferent invariant replaces refractory | — |
| Ambient wake-rate cap | **max_cycles_per_hour** | safety net; not a brain analog |

---

## 5. Protocol changes (WebSocket)

### 5.1 Handshake — capability advertisement

**Client→gateway, first message after auth**:

```json
{
  "type": "session.configure",
  "language": "en",
  "capabilities": {
    "supports": ["audio.input", "audio.output", "text.input", "text.output", "cognition.status"]
  }
}
```

**Gateway→client, response**:

```json
{
  "type": "session.ready",
  "sessionId": "…",
  "audioEncoding": "pcm_s16le",
  "inputSampleRate": 48000,
  "outputSampleRate": 44100,
  "enabledEffects": ["speak"]
}
```

The SDK derives `capabilities.supports` automatically from the set of connectors the client registered with it. The gateway uses this to compute `runtime.grantedCapabilities` for the session and excludes effects whose `capabilities` aren't a subset.

### 5.2 Cycle events (replaces turn events)

Old messages deleted: `turn.started`, `turn.ended`, `transcript.final`-as-turn-signal, `response.start`, `response.text.delta`, `response.text.done`, `response.audio.start`, `response.audio.frame`, `response.audio.done`.

New messages:

| Direction | Type | Payload |
| --- | --- | --- |
| G→C | `cycle.started` | `{cycleId, triggerKind, triggerSource}` |
| G→C | `connector.cancelled` | `{connector, cycleId, taskId, reason}` — per-task, per-connector; sent BEFORE abort signal fires on that task; connector decides action (flush buffer, mark cancelled, etc.) |
| G→C | `cycle.aborted` | `{cycleId, reason}` — sent after all task cleanup; confirms cycle is fully dead |
| G→C | `cycle.completed` | `{cycleId, effectsInvoked: string[]}` |
| G→C | `connector.transcript.final` | `{connector: "UserAudioInputConnector", cycleId, text, language}` — echoes transcript to client for UI ("you said: ...") |
| G→C | `connector.text.delta` | `{connector: "AssistantTextResponseConnector", cycleId, taskId, delta}` |
| G→C | `connector.text.done` | `{connector, cycleId, taskId}` |
| G→C | `connector.audio.start` | `{connector: "AssistantAudioResponseConnector", cycleId, taskId, encoding, sampleRate}` |
| G→C | `connector.audio.frame` (binary) | `{cycleId, taskId, frame}` (binary WS frame, small JSON header) |
| G→C | `connector.audio.done` | `{connector, cycleId, taskId}` |
| G→C | `cognition.status` | `{state: "idle" | "thinking" | "acting", runningEffects: string[]}` |
| C→G | `text.input` | `{text}` — routes to `UserTextInputAdapter` |
| C→G | `audio.start` / binary audio / `audio.end` | unchanged semantics; routes to `UserAudioInputAdapter` |
| C→G | `ping` / G→C `pong` | unchanged |

`tool.confirm_request` / `tool.confirm` stay in the protocol (for future confirmable effects) but aren't exercised in Phase 1.

### 5.3 Shared protocol module changes

`shared/protocol/src/messages.ts` zod schemas rewritten for the above. Old turn-based schemas deleted. Version bump the protocol (`VERSION` constant) and gate strictly: gateway rejects handshakes without `capabilities.supports`.

---

## 6. SDK rework (`shared/web-sdk/`)

### 6.1 Connector contract

```ts
interface Connector {
  readonly capability: string;   // e.g. "audio.output"
  readonly kind: "input" | "output" | "status";
  attach(sdk: SentientSDK): Promise<void>;
  detach(): Promise<void>;
}
```

Inputs implement `EventSource`-like outbound paths; outputs implement sinks keyed by message type; status connectors receive ambient events.

### 6.2 Phase 1 connectors

- `UserAudioInputConnector` (input, `audio.input`) — mic capture + PCM encode + send `audio.*` WS messages. Also receives `connector.transcript.final` echo for UI rendering.
- `UserTextInputConnector` (input, `text.input`) — send `text.input`.
- `AssistantTextResponseConnector` (output, `text.output`) — receive `connector.text.delta`/`done` and emit to client callbacks. On `connector.cancelled`: mark stream as cancelled.
- `AssistantAudioResponseConnector` (output, `audio.output`) — receive binary audio frames and hand to client callbacks. On `connector.cancelled`: **immediately stop playback, dump buffered frames, emit silence**.
- `CognitionStatusConnector` (status, `cognition.status`) — receive `cognition.status` events for UI "thinking" indicator. Tracks cycle lifecycle (`cycle.started`/`cycle.completed`/`cycle.aborted`), not per-task cancellation.

### 6.3 SDK public API

```ts
const sdk = new SentientSDK({ gatewayUrl, token });
sdk.register(new UserAudioInputConnector({ onTranscript: ... }));
sdk.register(new AssistantAudioResponseConnector({ onAudioFrame: ... }));
sdk.register(new CognitionStatusConnector({ onStateChange: ... }));
await sdk.connect();   // handshake derives supports from registered connectors
```

Client app code **never** sees cycles, effects, adapters, or WS message types. The single state machine surface stays: `disconnected → authenticating → ready → ... → disconnected`. Per-connector state is encapsulated in each connector. Error UX ("sorry, pardon?") stays internal as a ready-made renderer the client can opt into.

### 6.4 Web client app (`gateway/webui/`)

Minimum rework: replace the current voice-flow hook with five connector registrations for parity with today's behavior. No new UI surface in Phase 1; the app visually behaves the same (mic button, speech bubble, audio playback) but under the hood runs cycles, not turns.

---

## 7. Configuration additions

New sections in `gateway/config.yaml`:

```yaml
# ---------------------------------------------------------------------------
# Cerebrum — cognitive cycle orchestration
# ---------------------------------------------------------------------------
cerebrum:
  cycle:
    debounce_window_ms: 80            # coalesce events within this window before waking
    standard_threshold: 50            # per-effect salience to fire a cycle at window close
    immediate_wake_threshold: 100     # per-effect salience to fire cycle before window close
    max_per_hour: 120                 # cost-control safety net; rolling 1h window
    history_max_tokens: 4096          # cap on conversation-history layer; oldest cycles drop first
    priority_template: |
      You perceive new events since your last thought. Choose one or more
      tool calls from the enabled tool list to respond appropriately. Speak
      (the `speak` tool) only if you have something useful to say. Prefer
      concise replies for voice.

  salience_map_path: /app/salience_map.yaml

  # Cancel pseudo-effect name (reserved); used for barge-in signalling.
  cancel_effect_name: "*cancel*"

# Existing llm: section extended
llm:
  # ... (existing fields retained)
  chat_model: google/gemini-2.5-flash
  use_tool_calling: true              # NEW — must be true for cerebrum arch
  stream: true                        # NEW — switch from non-streaming to SSE streaming
```

New file `gateway/salience_map.yaml` as shown in §3.5. Mounted read-only into the container same as tokens.yaml.

`deploy/docker/docker-compose.yml` gains the `salience_map.yaml` mount.

---

## 8. Security model

Summary of layered defenses, all of which land in Phase 1:

1. **Projection + assembler gated tool exposure** — `ShortTermContext.project()` produces a per-effect salience table; `ContextAssembler` selectively includes only effects whose salience crossed threshold. Out-of-scope effects are literally absent from the request schema. This is the primary barrier.
2. **Capability negotiation** — effects whose `capabilities` aren't granted by the SDK at handshake are excluded for the whole session.
3. **Role gate** — `rolesAllowed` enforced per-invocation.
4. **Confirmation tier** — `impact: "confirm" | "admin"` requires client-side user approval with deny-by-default (code present, not exercised in Phase 1).
5. **Rate limit** — per-effect `perHour` / `perSession` caps.
6. **Audit log** — every invocation logged; survives restart via existing daily-rotation logger.
7. **Hard-coded arg gates** — LLM-supplied args never reach capabilities like "filesystem path". Paths derived from session metadata internally.
8. **Output sanitization** — afferent context updates from effects scanned before entering log.
9. **Cycle safety net** — `max_per_hour` cap prevents stuck sensors or prompt-injection loops from running away cost-wise.

Prompt-injection concerns: the 6-layer defense from `security-architecture.md` research is orthogonal and applies to LLM input sanitization (delimiters, canary tokens, privilege reduction). Items 1, 2, 3, 4, 7 above ARE the privilege-reduction layer in concrete form. Canary tokens and heuristic pre-filter are deferred to a sibling spec.

---

## 9. Scope — Phase 1 in vs out

**In** (this spec, this PR):

- All components in §3 (ShortTermContext, Adapters contract + 2 concrete, Effects contract + 1 concrete, SalienceMap, AttentionGate, CognitiveCycle, ContextAssembler, TaskManager, Interrupt propagation, Afferent, Concurrency model, Logging).
- Effect security wrapper with all 11 middleware layers.
- WebSocket protocol overhaul per §5.
- Web SDK rework per §6.
- Web client app parity update per §6.4.
- Config additions per §7.
- Delete old pipeline + context + history code.
- Verification gate per §11.

**Out** (sibling specs, future work):

- Short-term memory rolling summary. Hook in `ContextAssembler` §3.8 layer 1.
- Per-user long-term markdown memory. Hook as a future `MemoryAdapter` + `MemoryWriteEffect`.
- Sensor adapters (motion, light, smoke). Class + config scaffolding only.
- Tool-confirmation UI flow. Wrapper supports it; client doesn't render the UI.
- Additional effects beyond `speak`. Future specs per effect.
- Classifier / routing / ReAct multi-step. Every cycle is one LLM call in Phase 1.
- Habituation (per-adapter novelty decay).
- Android/iOS SDK rework. Web only for now.
- Canary tokens and heuristic input pre-filter (6-layer defense spec).
- XState migration if state count exceeds ~12.

---

## 10. Migration strategy — M1 big-bang on feature branch

Branch: `feature/brain-arch` (already checked out at start of implementation).

Steps (high-level; detailed plan lives in `writing-plans`):

1. Scaffold `cerebrum/`, `adapters/`, `effects/`, `salience/` directories with types + empty implementations.
2. Build `ShortTermContext` + tests first (pure; no dependencies).
3. Build `AttentionGate` + tests against mock context.
4. Build `ContextAssembler` + tests (pure function).
5. Build `TaskManager` + tests.
6. Build `EffectWrapper` + tests (mock handler).
7. Build `CognitiveCycle` + tests with mock LLM + mock effect.
8. Write `TTSAudioEffect` wrapping the existing Fish Audio provider. Retain `providers/tts/` unchanged; effect imports it.
9. Write `UserAudioInputAdapter` wrapping existing `adapters/stt/local-stt-adapter.ts`. Retain STT adapter unchanged; cerebrum adapter wraps it.
10. Write `UserTextInputAdapter`.
11. Rewrite `ws-handlers.ts` for cycle.* protocol + capability handshake + interrupt propagation.
12. Rewrite `shared/protocol/src/messages.ts` zod schemas.
13. Rewrite `shared/web-sdk/` connector interfaces + 5 Phase-1 connectors (including `cycle.interrupted` handling).
14. Update `gateway/webui/` to register connectors.
15. Delete old `pipeline/`, `context/session-history.ts`, old `context-assembler.ts`.
16. Update `bootstrap/create-gateway-services.ts` to build the cerebrum instead of the pipeline.
17. Update `gateway/config.yaml` with `cerebrum:` section; add `gateway/salience_map.yaml`; update Docker mounts.
18. Verification per §11.
19. Merge to develop; delete branch.

No feature flag. Git history is the rollback.

---

## 11. Verification (definition of done)

This section is a **hard gate**. The spec is not considered implemented until every item below passes.

### 11.1 Automated

- [ ] `bun run lint` — clean.
- [ ] `bun run typecheck` — clean.
- [ ] `bun run test:unit` — all new components have unit tests ≥80% statements, 75% branches (repo standard).
- [ ] `bun run test:int` — integration tests exercise: handshake with capabilities, cycle fires on user.speech.final, barge-in aborts running TTS (`connector.cancelled` arrives before effect cleanup), selective cancel stops one task while cycle continues, rate-limit rejection, unknown-effect rejection.
- [ ] `bun run ci` — full local CI passes.

### 11.2 Containerized smoke test

Performed by Claude before claiming task done:

- [ ] `cd deploy/docker && docker compose build` succeeds for gateway + webui.
- [ ] `docker compose up -d` brings up gateway, webui, stt-service, sentient-auth.
- [ ] `docker compose logs gateway | grep -E "(cerebrum|cycle|effect|salience|gate)"` shows cycle lifecycle events in structured log.
- [ ] Using a headless client script (or curl-ws), connect → advertise capabilities → send a text.input → observe `cycle.started` → `connector.text.delta` OR `connector.audio.frame` events → `cycle.completed`. Script is committed under `gateway/scripts/smoke-cerebrum.ts`.
- [ ] No ERROR-level log entries during the smoke flow. WARN entries reviewed and justified.

### 11.3 Manual user test

Performed by Kevin (gating merge):

- [ ] Web UI loads at `https://<pi-host>:...`.
- [ ] Voice input → hears reply (cycle path works end-to-end with audio).
- [ ] Text input → hears reply (second adapter works; LLM chose `speak` via tool call).
- [ ] Barge-in: start a reply, interrupt mid-speech, verify assistant stops within ~500ms and starts responding to the new utterance. No trailing audio from buffer.
- [ ] `docker compose logs gateway` reviewed by Kevin for any anomalies. Cerebrum lifecycle events visible. Signs off explicitly.

PR stays in draft until 11.3 sign-off.

---

## 12. Open questions (resolve during planning, not design)

- Exact thresholds in `salience_map.yaml` for `speak` given text vs speech input — tunable in config, initial guesses (85 for `user.speech.final` / `user.text.input`, 0 otherwise) may need empirical adjustment during smoke test.
- Output sanitization regex patterns — start with `sentient-*` auth token shape + known-API-key prefixes; expand as discovered.
- Whether `CognitionStatusConnector` events update on debounce-window open or only on cycle fire — trivial either way; default to on cycle fire to avoid UI flicker during debounce coalescing.
- Fish Audio streaming-to-effect-frame adapter shape — does it emit individual 20ms PCM frames or larger chunks? Match current pipeline behavior.

---

## 13. References

- Endsley, M. R. (1995). "Toward a Theory of Situation Awareness in Dynamic Systems." *Human Factors*.
- Koch, C., & Ullman, S. (1985). "Shifts in selective visual attention: towards the underlying neural circuitry." *Human Neurobiology*.
- Baars, B. J. (1988). *A Cognitive Theory of Consciousness*. Cambridge University Press. (Global Workspace Theory — informs the "spotlight" framing of AttentionGate.)
- Liu et al. (2023). "Lost in the Middle: How Language Models Use Long Contexts." *TACL 2024*. (Informs cache-friendly prompt ordering: stable prefix first, rolling content last.)
- `docs/research/2026-04-03-voice-gateway-arch/explorations/per-user-memory.md` — memory-system design referenced by §9 deferred items.
- `docs/research/2026-04-03-voice-gateway-arch/explorations/security-architecture.md` — 6-layer prompt-injection defense; §8 implements the privilege-reduction portion.
- `docs/research/2026-04-03-voice-gateway-arch/explorations/tool-routing.md` — ReAct vs Plan-and-Execute analysis; §9 defers multi-step routing.
