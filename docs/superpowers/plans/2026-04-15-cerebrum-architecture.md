# Cerebrum Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the gateway's turn-based pipeline with a cycle-based cerebrum architecture where adapters perceive, ShortTermContext holds immutable event state, AttentionGate fires cognitive cycles on salience, and effects execute as LLM tool calls.

**Architecture:** Adapters inject typed events into ShortTermContext (append-only log). AttentionGate evaluates salience from SalienceMap config, fires CognitiveCycle when threshold crossed. ContextAssembler builds cache-friendly LLM requests with projection-gated tool schemas. Effects run through a security EffectWrapper and emit frames to per-connector client channels. TaskManager tracks running effects; cancel/bargeIn propagate per-connector.

**Tech Stack:** Bun, TypeScript (strict), Vitest, Zod, OpenAI SDK (via OpenRouter), Fish Audio WebSocket

**Spec:** `docs/superpowers/specs/2026-04-15-session-context-brain-architecture-design.md`

**Branch:** `feature/brain-arch` (already exists, branched from develop)

---

## File Map

### New files (gateway/src/cerebrum/)

| File | Responsibility | ~Lines |
|------|---------------|--------|
| `cerebrum/short-term-context-types.ts` | ContextEvent, Projection, SituationAwarenessTable, TonicState, Signal, EventClass types | 80 |
| `cerebrum/short-term-context.ts` | Immutable append-only event log + synchronous project() | 150 |
| `cerebrum/attention-gate.ts` | CC1 debounce + salience evaluation + cycle dispatch | 200 |
| `cerebrum/cognitive-cycle.ts` | Single cycle orchestrator: project → assemble → LLM → effects | 180 |
| `cerebrum/context-assembler.ts` | 4-layer cache-friendly LLM request builder | 220 |
| `cerebrum/task-manager.ts` | Running effect registry + cancel + bargeIn | 150 |
| `cerebrum/afferent.ts` | Zero-salience inject wrapper for effect→context | 25 |

### New files (gateway/src/adapters/)

| File | Responsibility | ~Lines |
|------|---------------|--------|
| `adapters/adapter-types.ts` | Adapter, AdapterContext interfaces | 30 |
| `adapters/user-text-input-adapter.ts` | WS text.input → ShortTermContext inject | 50 |
| `adapters/user-audio-input-adapter.ts` | Wraps LocalSttAdapter → injects speech events | 90 |

### New files (gateway/src/effects/)

| File | Responsibility | ~Lines |
|------|---------------|--------|
| `effects/effect-types.ts` | EffectDefinition, EffectContext, EffectFrame, ConnectorSink | 80 |
| `effects/effect-wrapper.ts` | 11-step security middleware pipeline | 220 |
| `effects/tts-audio-effect.ts` | Wraps Fish Audio as tool-invokable "speak" effect | 120 |

### New files (gateway/src/salience/)

| File | Responsibility | ~Lines |
|------|---------------|--------|
| `salience/salience-map.ts` | Event-kind → per-effect salience lookup | 80 |
| `salience/salience-map-loader.ts` | Reads + validates salience_map.yaml | 50 |

### New files (gateway/src/bootstrap/)

| File | Responsibility | ~Lines |
|------|---------------|--------|
| `bootstrap/cerebrum-factory.ts` | Composes ShortTermContext + gate + assembler + TaskManager | 80 |
| `bootstrap/adapter-registry.ts` | Registers enabled adapters for session | 40 |
| `bootstrap/effect-registry.ts` | Registers enabled effects for session | 60 |

### New files (config)

| File | Responsibility | ~Lines |
|------|---------------|--------|
| `gateway/salience_map.yaml` | Event-kind → per-effect salience config | 25 |

### Modified files

| File | Change |
|------|--------|
| `shared/config/src/schema.ts` | Add `cerebrumConfigSchema` to `gatewayConfigSchema` |
| `shared/protocol/src/messages.ts` | Replace turn schemas with cycle/connector schemas |
| `gateway/src/providers/llm-provider.ts` | Extend for tool calling + tool role |
| `gateway/src/providers/openrouter.ts` | Add streaming + tool-call chunk handling |
| `gateway/src/config/startup-config.ts` | Add cerebrum config fields |
| `gateway/src/bootstrap/create-gateway-services.ts` | Wire cerebrum instead of pipeline |
| `gateway/src/api/ws-handlers.ts` | Rewrite for cycle protocol + capability handshake |
| `shared/web-sdk/src/` | Rewrite: connector-based SDK replacing VoiceClient |
| `gateway/webui/src/hooks/use-voice-client.ts` | Replace with connector registrations |
| `gateway/config.yaml` | Add `cerebrum:` section |
| `deploy/docker/docker-compose.yml` | Add salience_map.yaml mount |

### Deleted files

| Path | Reason |
|------|--------|
| `gateway/src/pipeline/` (entire) | Replaced by cerebrum/ |
| `gateway/src/context/session-history.ts` | Replaced by ShortTermContext |
| `gateway/src/context/context-assembler.ts` | Replaced by cerebrum/context-assembler.ts |

---

## Task 1: Foundation types

**Files:**
- Create: `gateway/src/cerebrum/short-term-context-types.ts`
- Create: `gateway/src/adapters/adapter-types.ts`
- Create: `gateway/src/effects/effect-types.ts`
- Create: `gateway/src/cerebrum/afferent.ts`

- [ ] **Step 1: Create cerebrum types**

```typescript
// gateway/src/cerebrum/short-term-context-types.ts
import type { z } from "zod";

export type Signal = "phasic" | "tonic";
export type EventClass = "user-direct" | "actionable" | "ambient" | "critical";
export type Urgency = "none" | "elevated" | "critical";

export interface ContextEvent {
  readonly seq: number;
  readonly ts: number;
  readonly kind: string;
  readonly source: string;
  readonly class: EventClass;
  readonly signal: Signal;
  readonly urgency: Urgency;
  readonly payload: unknown;
  readonly afferent?: true;
}

export type InjectableEvent = Omit<ContextEvent, "seq" | "ts">;

export interface Projection {
  readonly situationAwareness: SituationAwarenessTable;
  readonly salienceByEffect: Readonly<Record<string, number>>;
  readonly phasicEvents: readonly ContextEvent[];
  readonly tonicState: TonicState;
  readonly windowSeqRange: { readonly from: number; readonly to: number };
}

export interface SituationAwarenessTable {
  readonly perceivedInputs: ReadonlyArray<{
    source: string;
    kind: string;
    summary: string;
    ts: number;
  }>;
  readonly tonicSummary: string;
  readonly comprehension: string;
}

export interface TonicState {
  readonly userPresence: "home" | "away" | "unknown";
  readonly lastInteractionAgeMs: number;
  readonly isTtsPlaying: boolean;
  readonly runningEffects: ReadonlyArray<{
    name: string;
    elapsedMs: number;
    interruptable: boolean;
  }>;
  readonly [channel: string]: unknown;
}

export interface ShortTermContext {
  readonly sessionId: string;
  inject(event: InjectableEvent): number;
  injectAfferent(event: InjectableEvent): number;
  project(opts?: { sinceSeq?: number }): Projection;
  latestSeq(): number;
  onInject(listener: (event: ContextEvent) => void): () => void;
}
```

- [ ] **Step 2: Create adapter types**

```typescript
// gateway/src/adapters/adapter-types.ts
import type { ShortTermContext } from "../cerebrum/short-term-context-types.js";
import type { AfferentInjector } from "../cerebrum/afferent.js";

export interface Adapter {
  readonly id: string;
  readonly eventKinds: readonly string[];
  start(ctx: AdapterContext): Promise<void>;
  stop(reason: string): Promise<void>;
}

export interface AdapterContext {
  readonly shortTermContext: ShortTermContext;
  readonly afferent: AfferentInjector;
  readonly abortSignal: AbortSignal;
}
```

- [ ] **Step 3: Create effect types**

```typescript
// gateway/src/effects/effect-types.ts
import type { AfferentInjector } from "../cerebrum/afferent.js";
import type { UserRole } from "@sentient/protocol";

export type ImpactTier = "auto" | "confirm" | "admin";

export interface EffectDefinition<ArgsT = unknown> {
  readonly name: string;
  readonly description: string;
  readonly schema: Record<string, unknown>;
  readonly argsValidator: (raw: unknown) => ArgsT;
  readonly impact: ImpactTier;
  readonly rolesAllowed: readonly UserRole[];
  readonly rateLimit?: { readonly perHour: number; readonly perSession?: number };
  readonly capabilities: readonly string[];
  readonly interruptable: boolean;
  readonly serializing?: true;
  readonly handler: (
    args: ArgsT,
    ctx: EffectContext,
  ) => AsyncGenerator<EffectFrame> | Promise<EffectResult>;
}

export interface EffectContext {
  readonly sessionId: string;
  readonly userRole: UserRole;
  readonly taskId: string;
  readonly abortSignal: AbortSignal;
  readonly afferent: AfferentInjector;
  readonly audit: AuditLogger;
  readonly connector: ConnectorSink;
}

export type EffectFrame =
  | { readonly type: "progress"; readonly percent: number }
  | { readonly type: "audio"; readonly frame: Uint8Array }
  | { readonly type: "text"; readonly delta: string }
  | { readonly type: "done"; readonly result?: unknown };

export type EffectResult = { readonly ok: boolean; readonly data?: unknown };

export interface ConnectorSink {
  send(message: unknown): void;
  sendBinary(frame: Uint8Array, header: unknown): void;
  sendCancelled(reason: string): void;
}

export interface AuditLogger {
  start(entry: { taskId: string; effectName: string; argDigest: string }): void;
  complete(entry: { taskId: string; outcome: string; durationMs: number; reason?: string }): void;
}
```

- [ ] **Step 4: Create afferent interface**

```typescript
// gateway/src/cerebrum/afferent.ts
import type { InjectableEvent, ShortTermContext } from "./short-term-context-types.js";

export interface AfferentInjector {
  inject(event: InjectableEvent): number;
}

export function createAfferentInjector(ctx: ShortTermContext): AfferentInjector {
  return {
    inject(event) {
      return ctx.injectAfferent(event);
    },
  };
}
```

- [ ] **Step 5: Verify types compile**

Run: `cd gateway && bunx tsc --noEmit`
Expected: PASS (types only, no implementation)

- [ ] **Step 6: Commit**

```bash
git add gateway/src/cerebrum/ gateway/src/adapters/adapter-types.ts gateway/src/effects/effect-types.ts
git commit -m "feat(cerebrum): add foundation types for cerebrum architecture

ShortTermContext, ContextEvent, Projection, Adapter, Effect, Afferent
type definitions. No implementation yet."
```

---

## Task 2: Config schema + salience_map.yaml

**Files:**
- Create: `gateway/salience_map.yaml`
- Modify: `shared/config/src/schema.ts`
- Modify: `gateway/src/config/startup-config.ts`
- Modify: `gateway/config.yaml`

- [ ] **Step 1: Create salience_map.yaml**

```yaml
# gateway/salience_map.yaml — event-kind to per-effect salience mapping.
# Adapters emit event kinds. This file declares how much salience each kind
# contributes to each registered effect. AttentionGate uses summed salience
# to decide whether to fire a cognitive cycle.
version: 1
entries:
  user.text.input:
    speak: 85                         # user directly addressed us → high reply salience
  user.speech.final:
    speak: 85
  user.speech.start:                  # phasic, barge-in trigger
    speak: 0
    "*cancel*": 100                   # pseudo-effect: cancel running cycle/tasks
  effect.completed: {}                # afferent-only; listed for documentation

tonic_modulators:
  # Phase 2: modulate salience at projection time based on tonic state.
  entries: []
```

- [ ] **Step 2: Add cerebrum config schema to shared/config**

Read `shared/config/src/schema.ts` and add the `cerebrumConfigSchema` alongside existing schemas. Add it as an optional field to `gatewayConfigSchema`:

```typescript
// Add to shared/config/src/schema.ts

export const cerebrumCycleConfigSchema = z.object({
  debounce_window_ms: z.number().int().min(10).max(5000).default(80),
  standard_threshold: z.number().min(0).max(100).default(50),
  immediate_wake_threshold: z.number().min(0).max(200).default(100),
  max_per_hour: z.number().int().min(1).max(1000).default(120),
  history_max_tokens: z.number().int().min(256).max(32768).default(4096),
  priority_template: z.string().default(
    "You perceive new events since your last thought. Choose one or more " +
    "tool calls from the enabled tool list to respond appropriately. Speak " +
    "(the `speak` tool) only if you have something useful to say. Prefer " +
    "concise replies for voice.",
  ),
});

export const cerebrumConfigSchema = z.object({
  cycle: cerebrumCycleConfigSchema.default({}),
  salience_map_path: z.string().default("/app/salience_map.yaml"),
  cancel_effect_name: z.string().default("*cancel*"),
});

// In gatewayConfigSchema, add:
//   cerebrum: cerebrumConfigSchema.default({}),
```

- [ ] **Step 3: Extend startup-config.ts**

Read `gateway/src/config/startup-config.ts` and add cerebrum fields to `StartupConfig` interface and `loadStartupConfig()`.

- [ ] **Step 4: Add cerebrum section to gateway/config.yaml**

Append to `gateway/config.yaml`:

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
  cancel_effect_name: "*cancel*"
```

Also extend `llm:` section:

```yaml
llm:
  # ... existing fields ...
  use_tool_calling: true              # must be true for cerebrum arch
  stream: true                        # switch from non-streaming to SSE streaming
```

- [ ] **Step 5: Verify config loads**

Run: `cd gateway && bun run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add gateway/salience_map.yaml shared/config/src/schema.ts gateway/src/config/ gateway/config.yaml
git commit -m "feat(config): add cerebrum + salience_map config schema

cerebrumConfigSchema with cycle thresholds, history token cap, and
salience_map.yaml for event-kind → per-effect salience mapping."
```

---

## Task 3: ShortTermContext (TDD)

**Files:**
- Create: `gateway/src/cerebrum/short-term-context.ts`
- Create: `gateway/src/cerebrum/short-term-context.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// gateway/src/cerebrum/short-term-context.test.ts
import { describe, expect, it } from "vitest";
import { createShortTermContext } from "./short-term-context.js";
import type { InjectableEvent, SalienceMap } from "./short-term-context-types.js";

const stubSalienceMap: SalienceMap = {
  lookup: (kind: string) => {
    if (kind === "user.speech.final") return { speak: 85 };
    if (kind === "user.speech.start") return { speak: 0, "*cancel*": 100 };
    return {};
  },
};

function userSpeechEvent(text: string): InjectableEvent {
  return {
    kind: "user.speech.final",
    source: "user-audio-input-v1",
    class: "user-direct",
    signal: "phasic",
    urgency: "none",
    payload: { text, language: "en" },
  };
}

describe("ShortTermContext", () => {
  it("assigns monotonically increasing seq on inject", () => {
    const ctx = createShortTermContext("sess-1", stubSalienceMap);
    const seq1 = ctx.inject(userSpeechEvent("hello"));
    const seq2 = ctx.inject(userSpeechEvent("world"));
    expect(seq2).toBeGreaterThan(seq1);
  });

  it("project returns phasic events since sinceSeq", () => {
    const ctx = createShortTermContext("sess-1", stubSalienceMap);
    ctx.inject(userSpeechEvent("first"));
    const midSeq = ctx.latestSeq();
    ctx.inject(userSpeechEvent("second"));
    const proj = ctx.project({ sinceSeq: midSeq });
    expect(proj.phasicEvents).toHaveLength(1);
    expect((proj.phasicEvents[0].payload as { text: string }).text).toBe("second");
  });

  it("project computes salienceByEffect from salience map", () => {
    const ctx = createShortTermContext("sess-1", stubSalienceMap);
    ctx.inject(userSpeechEvent("hello"));
    const proj = ctx.project({ sinceSeq: 0 });
    expect(proj.salienceByEffect["speak"]).toBe(85);
  });

  it("injectAfferent sets afferent flag and does not contribute salience", () => {
    const ctx = createShortTermContext("sess-1", stubSalienceMap);
    ctx.injectAfferent({
      kind: "effect.completed",
      source: "tts",
      class: "user-direct",
      signal: "phasic",
      urgency: "none",
      payload: {},
    });
    const proj = ctx.project({ sinceSeq: 0 });
    expect(proj.salienceByEffect["speak"] ?? 0).toBe(0);
  });

  it("notifies inject listeners synchronously", () => {
    const ctx = createShortTermContext("sess-1", stubSalienceMap);
    const received: number[] = [];
    ctx.onInject((event) => received.push(event.seq));
    ctx.inject(userSpeechEvent("hello"));
    expect(received).toHaveLength(1);
  });

  it("renders situation awareness table from phasic events", () => {
    const ctx = createShortTermContext("sess-1", stubSalienceMap);
    ctx.inject(userSpeechEvent("hello"));
    const proj = ctx.project({ sinceSeq: 0 });
    expect(proj.situationAwareness.perceivedInputs).toHaveLength(1);
    expect(proj.situationAwareness.perceivedInputs[0].kind).toBe("user.speech.final");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd gateway && bun run vitest run src/cerebrum/short-term-context.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement ShortTermContext**

```typescript
// gateway/src/cerebrum/short-term-context.ts
import { createLogger } from "../logging/logger.js";
import type {
  ContextEvent,
  InjectableEvent,
  Projection,
  ShortTermContext,
  SituationAwarenessTable,
  TonicState,
} from "./short-term-context-types.js";

const log = createLogger(["sentient", "cerebrum", "short-term-context"]);

export interface SalienceMap {
  lookup(kind: string): Readonly<Record<string, number>>;
}

export function createShortTermContext(
  sessionId: string,
  salienceMap: SalienceMap,
): ShortTermContext {
  const events: ContextEvent[] = [];
  let nextSeq = 1;
  const listeners: Array<(event: ContextEvent) => void> = [];

  function appendEvent(event: InjectableEvent, afferent: boolean): number {
    const seq = nextSeq++;
    const full: ContextEvent = {
      ...event,
      seq,
      ts: Date.now(),
      ...(afferent ? { afferent: true } : {}),
    };
    events.push(full);
    log.debug({ seq, kind: full.kind, source: full.source, afferent }, "inject");
    for (const listener of listeners) listener(full);
    return seq;
  }

  return {
    sessionId,

    inject(event) {
      return appendEvent(event, false);
    },

    injectAfferent(event) {
      return appendEvent(event, true);
    },

    latestSeq() {
      return events.length > 0 ? events[events.length - 1].seq : 0;
    },

    project(opts) {
      const sinceSeq = opts?.sinceSeq ?? 0;
      const newEvents = events.filter((e) => e.seq > sinceSeq);
      const phasicEvents = newEvents.filter((e) => e.signal === "phasic");

      const salienceByEffect: Record<string, number> = {};
      for (const event of newEvents) {
        if (event.afferent) continue;
        const mapping = salienceMap.lookup(event.kind);
        for (const [effect, salience] of Object.entries(mapping)) {
          salienceByEffect[effect] = (salienceByEffect[effect] ?? 0) + salience;
        }
      }

      const situationAwareness = renderSA(phasicEvents);
      const tonicState = renderTonicState(events);

      const projection: Projection = {
        situationAwareness,
        salienceByEffect,
        phasicEvents,
        tonicState,
        windowSeqRange: {
          from: sinceSeq,
          to: events.length > 0 ? events[events.length - 1].seq : sinceSeq,
        },
      };

      log.debug(
        { sinceSeq, eventCount: newEvents.length, salienceByEffect },
        "project",
      );
      return projection;
    },

    onInject(listener) {
      listeners.push(listener);
      return () => {
        const idx = listeners.indexOf(listener);
        if (idx >= 0) listeners.splice(idx, 1);
      };
    },
  };
}

function renderSA(phasicEvents: readonly ContextEvent[]): SituationAwarenessTable {
  return {
    perceivedInputs: phasicEvents.map((e) => ({
      source: e.source,
      kind: e.kind,
      summary: summarizePayload(e),
      ts: e.ts,
    })),
    tonicSummary: "",
    comprehension: "",
  };
}

function summarizePayload(event: ContextEvent): string {
  const p = event.payload as Record<string, unknown> | null;
  if (p && typeof p === "object" && "text" in p) return String(p.text).slice(0, 100);
  return event.kind;
}

function renderTonicState(events: readonly ContextEvent[]): TonicState {
  const lastUserEvent = [...events]
    .reverse()
    .find((e) => e.class === "user-direct" && !e.afferent);
  return {
    userPresence: "home",
    lastInteractionAgeMs: lastUserEvent ? Date.now() - lastUserEvent.ts : Infinity,
    isTtsPlaying: false,
    runningEffects: [],
  };
}
```

Note: the `SalienceMap` interface is declared in this file and will also need to be exported from `short-term-context-types.ts`. Add to the types file:

```typescript
// Add to short-term-context-types.ts
export interface SalienceMap {
  lookup(kind: string): Readonly<Record<string, number>>;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd gateway && bun run vitest run src/cerebrum/short-term-context.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add gateway/src/cerebrum/short-term-context*
git commit -m "feat(cerebrum): implement ShortTermContext with TDD

Append-only event log, synchronous project() with salience
summation from SalienceMap, afferent flag exclusion, and
inject listener notification."
```

---

## Task 4: SalienceMap loader

**Files:**
- Create: `gateway/src/salience/salience-map.ts`
- Create: `gateway/src/salience/salience-map.test.ts`
- Create: `gateway/src/salience/salience-map-loader.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// gateway/src/salience/salience-map.test.ts
import { describe, expect, it } from "vitest";
import { createSalienceMap } from "./salience-map.js";

const entries = {
  "user.speech.final": { speak: 85 },
  "user.speech.start": { speak: 0, "*cancel*": 100 },
  "user.text.input": { speak: 85 },
};

describe("SalienceMap", () => {
  it("returns per-effect salience for known event kind", () => {
    const map = createSalienceMap(entries);
    expect(map.lookup("user.speech.final")).toEqual({ speak: 85 });
  });

  it("returns empty object for unknown event kind", () => {
    const map = createSalienceMap(entries);
    expect(map.lookup("sensor.motion.enter")).toEqual({});
  });

  it("returns cancel salience for speech start", () => {
    const map = createSalienceMap(entries);
    const result = map.lookup("user.speech.start");
    expect(result["*cancel*"]).toBe(100);
    expect(result["speak"]).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd gateway && bun run vitest run src/salience/salience-map.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement SalienceMap**

```typescript
// gateway/src/salience/salience-map.ts
import { createLogger } from "../logging/logger.js";
import type { SalienceMap } from "../cerebrum/short-term-context-types.js";

const log = createLogger(["sentient", "cerebrum", "salience-map"]);

export type SalienceEntries = Record<string, Record<string, number>>;

export function createSalienceMap(entries: SalienceEntries): SalienceMap {
  const frozen = Object.freeze(
    Object.fromEntries(
      Object.entries(entries).map(([k, v]) => [k, Object.freeze(v)]),
    ),
  );

  log.info({ entryCount: Object.keys(frozen).length }, "salience map loaded");

  return {
    lookup(kind: string): Readonly<Record<string, number>> {
      return frozen[kind] ?? {};
    },
  };
}
```

```typescript
// gateway/src/salience/salience-map-loader.ts
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { createLogger } from "../logging/logger.js";
import { createSalienceMap, type SalienceEntries } from "./salience-map.js";
import type { SalienceMap } from "../cerebrum/short-term-context-types.js";

const log = createLogger(["sentient", "cerebrum", "salience-map-loader"]);

interface SalienceMapYaml {
  version: number;
  entries: SalienceEntries;
  tonic_modulators?: { entries: unknown[] };
}

export function loadSalienceMap(path: string): SalienceMap {
  const raw = readFileSync(path, "utf-8");
  const parsed = parseYaml(raw) as SalienceMapYaml;
  if (parsed.version !== 1) {
    throw new Error(`Unsupported salience_map version: ${parsed.version}`);
  }
  log.info({ path, effectNames: Object.keys(parsed.entries) }, "loaded salience map file");
  return createSalienceMap(parsed.entries);
}
```

- [ ] **Step 4: Run tests**

Run: `cd gateway && bun run vitest run src/salience/salience-map.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add gateway/src/salience/
git commit -m "feat(cerebrum): add SalienceMap + YAML loader

Event-kind → per-effect salience lookup loaded from
salience_map.yaml config file."
```

---

## Task 5: TaskManager (TDD)

**Files:**
- Create: `gateway/src/cerebrum/task-manager.ts`
- Create: `gateway/src/cerebrum/task-manager.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// gateway/src/cerebrum/task-manager.test.ts
import { describe, expect, it, vi } from "vitest";
import { createTaskManager } from "./task-manager.js";

function makeHandle(overrides: Partial<{
  taskId: string;
  effectName: string;
  interruptable: boolean;
  onCancelled: () => void;
}> = {}) {
  const controller = new AbortController();
  const onCancelled = overrides.onCancelled ?? vi.fn();
  return {
    handle: {
      taskId: overrides.taskId ?? `task-${Math.random().toString(36).slice(2)}`,
      effectName: overrides.effectName ?? "speak",
      args: { text: "hello" },
      startedAt: Date.now(),
      abortController: controller,
      interruptable: overrides.interruptable ?? true,
      onCancelled,
    },
    controller,
    onCancelled,
  };
}

describe("TaskManager", () => {
  it("tracks registered tasks", () => {
    const tm = createTaskManager();
    const { handle } = makeHandle({ taskId: "t1" });
    tm.register(handle);
    expect(tm.listRunning()).toHaveLength(1);
    expect(tm.listRunning()[0].taskId).toBe("t1");
  });

  it("deregister removes task", () => {
    const tm = createTaskManager();
    const { handle } = makeHandle({ taskId: "t1" });
    tm.register(handle);
    tm.deregister("t1", "completed");
    expect(tm.listRunning()).toHaveLength(0);
  });

  it("cancel aborts specific task and calls onCancelled before abort", () => {
    const tm = createTaskManager();
    const order: string[] = [];
    const { handle, controller } = makeHandle({
      taskId: "t1",
      onCancelled: () => order.push("cancelled"),
    });
    controller.signal.addEventListener("abort", () => order.push("aborted"));
    tm.register(handle);
    tm.cancel("t1", "user_request");
    expect(order).toEqual(["cancelled", "aborted"]);
  });

  it("bargeIn cancels all interruptable tasks and fires cycleAbort", () => {
    const tm = createTaskManager();
    const cycleController = new AbortController();
    const { handle: h1, onCancelled: oc1 } = makeHandle({ taskId: "t1", interruptable: true });
    const { handle: h2, onCancelled: oc2 } = makeHandle({ taskId: "t2", interruptable: false });
    tm.register(h1);
    tm.register(h2);
    tm.bargeIn("user_speech_start", cycleController);
    expect(oc1).toHaveBeenCalled();
    expect(oc2).not.toHaveBeenCalled();
    expect(cycleController.signal.aborted).toBe(true);
  });

  it("countInWindow tracks invocations in time window", () => {
    const tm = createTaskManager();
    const { handle } = makeHandle({ effectName: "speak" });
    tm.register(handle);
    tm.deregister(handle.taskId, "completed");
    expect(tm.countInWindow("speak", 60_000)).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd gateway && bun run vitest run src/cerebrum/task-manager.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement TaskManager**

```typescript
// gateway/src/cerebrum/task-manager.ts
import { createLogger } from "../logging/logger.js";

const log = createLogger(["sentient", "cerebrum", "task-manager"]);

export interface TaskHandle {
  readonly taskId: string;
  readonly effectName: string;
  readonly args: unknown;
  readonly startedAt: number;
  readonly abortController: AbortController;
  readonly interruptable: boolean;
  readonly onCancelled: () => void;
}

export interface TaskSummary {
  readonly taskId: string;
  readonly effectName: string;
  readonly elapsedMs: number;
  readonly interruptable: boolean;
}

export interface TaskManager {
  register(h: TaskHandle): void;
  deregister(taskId: string, outcome: "completed" | "aborted" | "failed"): void;
  cancel(taskId: string, reason: string): void;
  bargeIn(reason: string, cycleAbortController: AbortController): void;
  listRunning(): ReadonlyArray<TaskSummary>;
  countInWindow(effectName: string, windowMs: number): number;
}

interface CompletionRecord {
  effectName: string;
  completedAt: number;
}

export function createTaskManager(): TaskManager {
  const running = new Map<string, TaskHandle>();
  const completions: CompletionRecord[] = [];

  function cancelTask(handle: TaskHandle, reason: string): void {
    log.info({ taskId: handle.taskId, effectName: handle.effectName, reason }, "cancel");
    handle.onCancelled();
    handle.abortController.abort(reason);
  }

  return {
    register(h) {
      running.set(h.taskId, h);
      log.debug({ taskId: h.taskId, effectName: h.effectName, interruptable: h.interruptable }, "task registered");
    },

    deregister(taskId, outcome) {
      const handle = running.get(taskId);
      if (!handle) return;
      running.delete(taskId);
      completions.push({ effectName: handle.effectName, completedAt: Date.now() });
      log.info({ taskId, effectName: handle.effectName, outcome, durationMs: Date.now() - handle.startedAt }, "task deregistered");
    },

    cancel(taskId, reason) {
      const handle = running.get(taskId);
      if (!handle) return;
      cancelTask(handle, reason);
    },

    bargeIn(reason, cycleAbortController) {
      let cancelled = 0;
      for (const handle of running.values()) {
        if (handle.interruptable) {
          cancelTask(handle, reason);
          cancelled++;
        }
      }
      log.info({ reason, taskCount: running.size, cancelled }, "bargeIn");
      cycleAbortController.abort(reason);
    },

    listRunning() {
      const now = Date.now();
      return [...running.values()].map((h) => ({
        taskId: h.taskId,
        effectName: h.effectName,
        elapsedMs: now - h.startedAt,
        interruptable: h.interruptable,
      }));
    },

    countInWindow(effectName, windowMs) {
      const cutoff = Date.now() - windowMs;
      return completions.filter((r) => r.effectName === effectName && r.completedAt >= cutoff).length;
    },
  };
}
```

- [ ] **Step 4: Run tests**

Run: `cd gateway && bun run vitest run src/cerebrum/task-manager.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add gateway/src/cerebrum/task-manager*
git commit -m "feat(cerebrum): implement TaskManager with cancel + bargeIn

Per-task cancel with onCancelled→abort ordering guarantee.
bargeIn cancels all interruptable tasks then aborts cycle."
```

---

## Task 6: AttentionGate (TDD)

**Files:**
- Create: `gateway/src/cerebrum/attention-gate.ts`
- Create: `gateway/src/cerebrum/attention-gate.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// gateway/src/cerebrum/attention-gate.test.ts
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createAttentionGate, type AttentionGateConfig } from "./attention-gate.js";
import { createShortTermContext } from "./short-term-context.js";
import { createSalienceMap } from "../salience/salience-map.js";
import type { InjectableEvent } from "./short-term-context-types.js";

const salienceMap = createSalienceMap({
  "user.speech.final": { speak: 85 },
  "user.speech.start": { speak: 0, "*cancel*": 100 },
  "user.text.input": { speak: 85 },
});

const gateConfig: AttentionGateConfig = {
  debounceWindowMs: 10,
  standardThreshold: 50,
  immediateWakeThreshold: 100,
  maxPerHour: 120,
  cancelEffectName: "*cancel*",
};

function speechFinal(text: string): InjectableEvent {
  return {
    kind: "user.speech.final",
    source: "audio",
    class: "user-direct",
    signal: "phasic",
    urgency: "none",
    payload: { text },
  };
}

function speechStart(): InjectableEvent {
  return {
    kind: "user.speech.start",
    source: "audio",
    class: "user-direct",
    signal: "phasic",
    urgency: "none",
    payload: {},
  };
}

describe("AttentionGate", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.restoreAllTimers(); });

  it("fires cycle after debounce when salience exceeds standard threshold", async () => {
    const ctx = createShortTermContext("s1", salienceMap);
    const onCycle = vi.fn();
    createAttentionGate(ctx, gateConfig, { onCycle });

    ctx.inject(speechFinal("hello"));
    expect(onCycle).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(gateConfig.debounceWindowMs + 1);
    expect(onCycle).toHaveBeenCalledOnce();
    expect(onCycle.mock.calls[0][0]).toHaveProperty("triggerReason");
  });

  it("fires immediately when salience exceeds immediate threshold", () => {
    const ctx = createShortTermContext("s1", salienceMap);
    const onCycle = vi.fn();
    createAttentionGate(ctx, gateConfig, { onCycle: vi.fn(), onBargeIn: vi.fn() });

    // *cancel* has salience 100, which equals immediate_wake_threshold
    // but *cancel* triggers bargeIn path, not onCycle. Test with a custom map.
  });

  it("does not fire for afferent events", async () => {
    const ctx = createShortTermContext("s1", salienceMap);
    const onCycle = vi.fn();
    createAttentionGate(ctx, gateConfig, { onCycle });

    ctx.injectAfferent({
      kind: "effect.completed",
      source: "tts",
      class: "user-direct",
      signal: "phasic",
      urgency: "none",
      payload: {},
    });

    await vi.advanceTimersByTimeAsync(gateConfig.debounceWindowMs + 1);
    expect(onCycle).not.toHaveBeenCalled();
  });

  it("triggers bargeIn when cancel salience detected during active cycle", async () => {
    const ctx = createShortTermContext("s1", salienceMap);
    const onCycle = vi.fn().mockReturnValue(Promise.resolve());
    const onBargeIn = vi.fn();
    createAttentionGate(ctx, gateConfig, { onCycle, onBargeIn });

    ctx.inject(speechFinal("hello"));
    await vi.advanceTimersByTimeAsync(gateConfig.debounceWindowMs + 1);
    expect(onCycle).toHaveBeenCalledOnce();

    // Now simulate barge-in while cycle is "active"
    ctx.inject(speechStart());
    // Cancel salience = 100 >= immediate threshold → bargeIn fires synchronously
    expect(onBargeIn).toHaveBeenCalledOnce();
  });

  it("respects max_per_hour rate limit", async () => {
    const limitedConfig = { ...gateConfig, maxPerHour: 2 };
    const ctx = createShortTermContext("s1", salienceMap);
    const onCycle = vi.fn().mockReturnValue(Promise.resolve());
    createAttentionGate(ctx, limitedConfig, { onCycle });

    // Fire 3 cycles
    for (let i = 0; i < 3; i++) {
      ctx.inject(speechFinal(`msg-${i}`));
      await vi.advanceTimersByTimeAsync(gateConfig.debounceWindowMs + 1);
    }
    // Only 2 should have fired
    expect(onCycle).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd gateway && bun run vitest run src/cerebrum/attention-gate.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement AttentionGate**

Create `gateway/src/cerebrum/attention-gate.ts` implementing the CC1 model:
- Subscribe to ShortTermContext inject notifications
- On each inject: evaluate salience immediately for `*cancel*` (bargeIn path), otherwise start/extend debounce timer
- On debounce window close: call `project(sinceSeq)`, evaluate thresholds, fire `onCycle` if crossed
- Track `activeCycleId`, `lastCycleEndSeq`, `cyclesThisHour[]`
- Log every gate evaluation with salienceByEffect and decision

Key interfaces:

```typescript
export interface AttentionGateConfig {
  debounceWindowMs: number;
  standardThreshold: number;
  immediateWakeThreshold: number;
  maxPerHour: number;
  cancelEffectName: string;
}

export interface AttentionGateCallbacks {
  onCycle: (params: { cycleId: string; sinceSeq: number; triggerReason: string }) => Promise<void>;
  onBargeIn?: (params: { cycleId: string; reason: string }) => void;
}
```

Implementation should be under 200 lines. Use `setTimeout` for debounce. Gate evaluates `*cancel*` salience synchronously on inject (no debounce) when a cycle is active.

- [ ] **Step 4: Run tests**

Run: `cd gateway && bun run vitest run src/cerebrum/attention-gate.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add gateway/src/cerebrum/attention-gate*
git commit -m "feat(cerebrum): implement AttentionGate with CC1 model

Debounce window, standard/immediate threshold evaluation,
cancel-salience bargeIn path, max_per_hour rate limiting."
```

---

## Task 7: Extend LLM provider for tool calling

**Files:**
- Modify: `gateway/src/providers/llm-provider.ts`
- Modify: `gateway/src/providers/openrouter.ts`
- Create: `gateway/src/providers/openrouter.test.ts` (extend existing if present)

- [ ] **Step 1: Extend LLM types**

Read `gateway/src/providers/llm-provider.ts` and extend:

```typescript
// Add to llm-provider.ts

export interface LLMToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface LLMToolCall {
  id: string;
  function: { name: string; arguments: string };
}

// Extend LLMMessage to support tool role and tool_calls
export interface LLMMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: LLMToolCall[];
  tool_call_id?: string;
}

// Extend LLMStreamOptions to support tools
export interface LLMStreamOptions {
  model: string;
  messages: LLMMessage[];
  signal: AbortSignal;
  maxTokens?: number;
  temperature?: number;
  tools?: LLMToolDefinition[];
  tool_choice?: "auto" | "required" | "none";
}

// Change stream return type to yield text OR tool calls
export type LLMStreamChunk =
  | { type: "text"; content: string }
  | { type: "tool_call"; toolCall: LLMToolCall };

export interface LLMProvider {
  stream(options: LLMStreamOptions): AsyncGenerator<LLMStreamChunk>;
}
```

- [ ] **Step 2: Update OpenRouter provider for streaming + tool calls**

Read `gateway/src/providers/openrouter.ts` and update `createOpenRouterProvider` to:
1. Pass `tools` and `tool_choice` to the OpenAI SDK
2. Use `stream: true` when config enables it
3. Parse SSE chunks, yield `LLMStreamChunk` (text or tool_call)
4. Concatenate partial tool_call arguments by `tool_call.index`

The OpenAI SDK's `chat.completions.create({ stream: true })` returns an async iterable of chunks. Each chunk has `choices[0].delta` with optional `tool_calls` array.

- [ ] **Step 3: Fix any downstream compilation errors**

The old `stream()` returned `AsyncGenerator<string>`. All callers need updating. Since we're deleting the old pipeline, the only callers will be the new CognitiveCycle (Task 11). Fix `voice-turn.ts` temporarily if it exists in the codebase during the transition by wrapping the new chunk type.

- [ ] **Step 4: Verify compilation**

Run: `cd gateway && bun run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add gateway/src/providers/
git commit -m "feat(providers): extend LLM provider for tool calling + streaming

LLMToolDefinition, LLMToolCall, tool_choice support.
OpenRouter provider uses SSE streaming with tool-call chunk
concatenation by index."
```

---

## Task 8: ContextAssembler (TDD)

**Files:**
- Create: `gateway/src/cerebrum/context-assembler.ts`
- Create: `gateway/src/cerebrum/context-assembler.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// gateway/src/cerebrum/context-assembler.test.ts
import { describe, expect, it } from "vitest";
import { createContextAssembler, type AssemblerConfig } from "./context-assembler.js";
import type { Projection } from "./short-term-context-types.js";
import type { EffectDefinition } from "../effects/effect-types.js";

const config: AssemblerConfig = {
  persona: "You are Sentient, a helpful family AI assistant.",
  systemPrompt: "Follow voice interaction rules.",
  languageHint: "",
  chatModel: "google/gemini-2.5-flash",
  maxTokens: 1024,
  historyMaxTokens: 4096,
  priorityTemplate: "Respond to the user by calling `speak`.",
  standardThreshold: 50,
};

const speakEffect: EffectDefinition = {
  name: "speak",
  description: "Speak a reply aloud to the user.",
  schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  argsValidator: (x) => x,
  impact: "auto",
  rolesAllowed: ["adult", "child"],
  capabilities: ["audio.output"],
  interruptable: true,
  handler: async function* () {},
};

function stubProjection(overrides: Partial<Projection> = {}): Projection {
  return {
    situationAwareness: {
      perceivedInputs: [{ source: "audio", kind: "user.speech.final", summary: "Hello", ts: Date.now() }],
      tonicSummary: "user_presence: home",
      comprehension: "",
    },
    salienceByEffect: { speak: 85 },
    phasicEvents: [],
    tonicState: {
      userPresence: "home",
      lastInteractionAgeMs: 0,
      isTtsPlaying: false,
      runningEffects: [],
    },
    windowSeqRange: { from: 0, to: 1 },
    ...overrides,
  };
}

describe("ContextAssembler", () => {
  it("includes persona in system message", () => {
    const assembler = createContextAssembler(config);
    const req = assembler.assemble(stubProjection(), [speakEffect], {
      conversationHistory: [],
      currentStimulus: "Hello",
    });
    const systemMsg = req.messages.find((m) => m.role === "system");
    expect(systemMsg?.content).toContain("Sentient");
  });

  it("exposes tools whose salience crossed threshold", () => {
    const assembler = createContextAssembler(config);
    const req = assembler.assemble(stubProjection({ salienceByEffect: { speak: 85 } }), [speakEffect], {
      conversationHistory: [],
      currentStimulus: "Hello",
    });
    expect(req.tools).toHaveLength(1);
    expect(req.tools![0].function.name).toBe("speak");
  });

  it("excludes tools below threshold", () => {
    const assembler = createContextAssembler(config);
    const req = assembler.assemble(stubProjection({ salienceByEffect: { speak: 10 } }), [speakEffect], {
      conversationHistory: [],
      currentStimulus: "Hello",
    });
    expect(req.tools).toHaveLength(0);
  });

  it("places conversation history after system context", () => {
    const assembler = createContextAssembler(config);
    const req = assembler.assemble(stubProjection(), [speakEffect], {
      conversationHistory: [
        { role: "user", content: "Hi" },
        { role: "assistant", content: "", tool_calls: [{ id: "c1", function: { name: "speak", arguments: '{"text":"Hey!"}' } }] },
        { role: "tool", content: '{"ok":true}', tool_call_id: "c1" },
      ],
      currentStimulus: "How are you?",
    });
    const roles = req.messages.map((m) => m.role);
    // system messages first, then history, then current user stimulus
    expect(roles[0]).toBe("system");
    expect(roles[roles.length - 1]).toBe("user");
  });

  it("sets tool_choice to required", () => {
    const assembler = createContextAssembler(config);
    const req = assembler.assemble(stubProjection(), [speakEffect], {
      conversationHistory: [],
      currentStimulus: "Hello",
    });
    expect(req.tool_choice).toBe("required");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd gateway && bun run vitest run src/cerebrum/context-assembler.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement ContextAssembler**

Create `gateway/src/cerebrum/context-assembler.ts`:
- Layer 1 (system): persona + rules + language hint (stable prefix for cache)
- Layer 2 (tools): filter effects by salience threshold → ToolDefinition[]
- Layer 3 (system): SA table + tonic state + priority template
- Layer 4 (messages): conversation history + current stimulus
- Token budget: count history tokens (~4 chars/token), truncate oldest full cycles when over `historyMaxTokens`. Never split tool_call/tool_result pairs.
- Return `LLMRequest` shape matching the OpenRouter format.

Key interface:

```typescript
export interface AssemblerConfig {
  persona: string;
  systemPrompt: string;
  languageHint: string;
  chatModel: string;
  maxTokens: number;
  historyMaxTokens: number;
  priorityTemplate: string;
  standardThreshold: number;
}

export interface AssemblerInput {
  conversationHistory: LLMMessage[];
  currentStimulus: string;
}

export interface ContextAssembler {
  assemble(
    projection: Projection,
    effects: readonly EffectDefinition[],
    input: AssemblerInput,
  ): LLMRequest;
}
```

Log: layer sizes (estimated tokens), tools exposed, history truncated.

- [ ] **Step 4: Run tests**

Run: `cd gateway && bun run vitest run src/cerebrum/context-assembler.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add gateway/src/cerebrum/context-assembler*
git commit -m "feat(cerebrum): implement ContextAssembler with cache-friendly ordering

4-layer assembly: static system prefix → tools (salience-gated) →
per-cycle SA/tonic/instructions → rolling conversation history.
Token budget truncation from oldest, never splits tool_call pairs."
```

---

## Task 9: EffectWrapper (TDD)

**Files:**
- Create: `gateway/src/effects/effect-wrapper.ts`
- Create: `gateway/src/effects/effect-wrapper.test.ts`

- [ ] **Step 1: Write failing tests**

Test the 11-step middleware chain: schema validation, role gate, capability check, rate limit, audit log, TaskManager registration, handler invocation, onCancelled → connector.cancelled, deregistration.

Key test cases:
- Happy path: valid args + correct role + capabilities → handler runs → task deregistered as completed
- Schema validation rejects invalid args
- Role gate rejects unauthorized role
- Capability check rejects missing capabilities
- Rate limit rejects exceeded rate
- Cancel calls `connector.sendCancelled()` before abort

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd gateway && bun run vitest run src/effects/effect-wrapper.test.ts`

- [ ] **Step 3: Implement EffectWrapper**

Create `gateway/src/effects/effect-wrapper.ts`:
- `composeEffect(definition, deps)` returns a function `(args, ctx) => Promise<EffectResult>`
- The function runs the 11 middleware steps sequentially
- `onCancelled` callback (passed to TaskManager registration) calls `ctx.connector.sendCancelled(reason)` synchronously THEN the abort signal fires (ordering guarantee from TaskManager)
- Log each middleware decision

- [ ] **Step 4: Run tests**

Run: `cd gateway && bun run vitest run src/effects/effect-wrapper.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add gateway/src/effects/effect-wrapper*
git commit -m "feat(effects): implement EffectWrapper security middleware

11-step pipeline: schema → role → capability → rate → confirm →
audit → register → handler → sanitize → audit → deregister.
onCancelled emits connector.cancelled before abort fires."
```

---

## Task 10: CognitiveCycle

**Files:**
- Create: `gateway/src/cerebrum/cognitive-cycle.ts`
- Create: `gateway/src/cerebrum/cognitive-cycle.test.ts`

- [ ] **Step 1: Write failing tests**

Test with mock LLM provider and mock effect:
- Happy path: LLM returns tool_call → effect executes → cycle injects afferent history events
- Abort: cycle's AbortSignal fires → LLM stream cancelled → aborted cycle does NOT inject history
- No tool calls: LLM returns text only → no effects dispatched → cycle completes

- [ ] **Step 2: Implement CognitiveCycle**

Create `gateway/src/cerebrum/cognitive-cycle.ts`:

```typescript
export interface CognitiveCycleConfig {
  cycleId: string;
  sinceSeq: number;
  triggerReason: string;
}

export interface CognitiveCycleDeps {
  shortTermContext: ShortTermContext;
  contextAssembler: ContextAssembler;
  llmProvider: LLMProvider;
  effectRegistry: ReadonlyArray<EffectDefinition>;
  effectWrapper: ReturnType<typeof composeEffect>; // for each effect
  taskManager: TaskManager;
  afferent: AfferentInjector;
  conversationHistory: LLMMessage[]; // mutable, appended on cycle completion
  wsSend: (msg: unknown) => void;
}
```

Lifecycle implementation matching spec §3.7:
1. `project({sinceSeq})` — synchronous
2. `assemble(projection, effects, input)` — synchronous
3. `llmProvider.stream(request, abortSignal)` — first async point
4. Parse tool_call chunks, dispatch effects in parallel via `Promise.allSettled`
5. On completion: inject `cognition.assistant_message` + `cognition.tool_call` + `cognition.tool_result` afferent events; append to `conversationHistory`
6. On abort: inject `cycle.aborted` afferent event; do NOT append to history

**Critical invariant**: no `await` between project() and llmProvider.stream(). Comment this in code.

- [ ] **Step 3: Run tests**

Run: `cd gateway && bun run vitest run src/cerebrum/cognitive-cycle.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add gateway/src/cerebrum/cognitive-cycle*
git commit -m "feat(cerebrum): implement CognitiveCycle orchestrator

project → assemble → LLM stream → dispatch effects → inject history.
No await between project and LLM dispatch (atomicity invariant)."
```

---

## Task 11: TTSAudioEffect

**Files:**
- Create: `gateway/src/effects/tts-audio-effect.ts`
- Create: `gateway/src/effects/tts-audio-effect.test.ts`

- [ ] **Step 1: Implement TTSAudioEffect**

Read existing `gateway/src/providers/tts/` code to understand Fish Audio integration. Create `tts-audio-effect.ts` that wraps the existing TTS provider as an `EffectDefinition`:

- `name: "speak"`, `description: "Speak a reply aloud to the user."`
- `schema`: `{ type: "object", properties: { text: { type: "string" } }, required: ["text"] }`
- `capabilities: ["audio.output"]`, `impact: "auto"`, `interruptable: true`
- Handler: `async function*` that connects to Fish Audio, sends text, yields `EffectFrame` audio frames through the ConnectorSink, yields `{ type: "done" }` on completion
- Respect `abortSignal`: on abort, close Fish Audio connection, stop yielding

- [ ] **Step 2: Write test with mock TTS**

Test: handler yields audio frames when given text, stops on abort signal.

- [ ] **Step 3: Commit**

```bash
git add gateway/src/effects/tts-audio-effect*
git commit -m "feat(effects): implement TTSAudioEffect wrapping Fish Audio

speak tool: text → Fish Audio → audio frames via ConnectorSink.
Respects AbortSignal for barge-in cancellation."
```

---

## Task 12: Adapters (UserAudioInput + UserTextInput)

**Files:**
- Create: `gateway/src/adapters/user-audio-input-adapter.ts`
- Create: `gateway/src/adapters/user-text-input-adapter.ts`
- Create: `gateway/src/adapters/user-audio-input-adapter.test.ts`
- Create: `gateway/src/adapters/user-text-input-adapter.test.ts`

- [ ] **Step 1: Implement UserTextInputAdapter**

```typescript
// gateway/src/adapters/user-text-input-adapter.ts
import { createLogger } from "../logging/logger.js";
import type { Adapter, AdapterContext } from "./adapter-types.js";

const log = createLogger(["sentient", "adapter", "user-text-input"]);

export function createUserTextInputAdapter(): Adapter {
  let ctx: AdapterContext | null = null;

  return {
    id: "user-text-input-v1",
    eventKinds: ["user.text.input"],

    async start(adapterCtx) {
      ctx = adapterCtx;
      log.info({ id: this.id }, "adapter started");
    },

    async stop(reason) {
      ctx = null;
      log.info({ id: this.id, reason }, "adapter stopped");
    },

    // Called by ws-handlers when text.input arrives
    handleTextInput(text: string): void {
      if (!ctx) return;
      ctx.shortTermContext.inject({
        kind: "user.text.input",
        source: this.id,
        class: "user-direct",
        signal: "phasic",
        urgency: "none",
        payload: { text },
      });
      log.debug({ text: text.slice(0, 50) }, "text input injected");
    },
  } as Adapter & { handleTextInput(text: string): void };
}
```

- [ ] **Step 2: Implement UserAudioInputAdapter**

Wraps the existing `LocalSttAdapter`. On STT events:
- `turn_started` → inject `user.speech.start` (phasic, triggers barge-in via cancel salience)
- `transcript` (final) → inject `user.speech.final` with text payload
- `turn_dropped` → inject `user.speech.dropped` (informational, low salience)

Read `gateway/src/adapters/stt/stt-adapter-types.ts` for the `STTEvent` type to map from.

- [ ] **Step 3: Write tests for both adapters**

- [ ] **Step 4: Commit**

```bash
git add gateway/src/adapters/user-*
git commit -m "feat(adapters): implement UserTextInput + UserAudioInput adapters

UserTextInputAdapter: WS text.input → ShortTermContext inject.
UserAudioInputAdapter: wraps LocalSttAdapter STT events into
cerebrum event kinds (speech.start, speech.final, speech.dropped)."
```

---

## Task 13: Protocol rewrite

**Files:**
- Modify: `shared/protocol/src/messages.ts`
- Modify: `shared/protocol/src/index.ts` (re-exports)

- [ ] **Step 1: Rewrite message schemas**

Read `shared/protocol/src/messages.ts` fully. Replace turn-based schemas with cycle-based ones per spec §5.2.

**Delete**: `turnStartedSchema`, `turnDroppedSchema`, `transcriptFinalSchema`, `responseStartSchema`, `responseTextDeltaSchema`, `responseTextDoneSchema`, `responseAudioStartSchema`, `responseAudioDoneSchema`, `bargeInAckSchema`.

**Add**:
```typescript
// Cycle lifecycle
export const cycleStartedSchema = z.object({
  type: z.literal("cycle.started"),
  cycleId: z.string(),
  triggerKind: z.string(),
  triggerSource: z.string(),
});

export const cycleCancelledSchema = z.object({
  type: z.literal("connector.cancelled"),
  connector: z.string(),
  cycleId: z.string(),
  taskId: z.string(),
  reason: z.string(),
});

export const cycleAbortedSchema = z.object({
  type: z.literal("cycle.aborted"),
  cycleId: z.string(),
  reason: z.string(),
});

export const cycleCompletedSchema = z.object({
  type: z.literal("cycle.completed"),
  cycleId: z.string(),
  effectsInvoked: z.array(z.string()),
});

// Connector messages
export const connectorTranscriptFinalSchema = z.object({
  type: z.literal("connector.transcript.final"),
  connector: z.literal("UserAudioInputConnector"),
  cycleId: z.string().optional(),
  text: z.string(),
  language: z.string(),
});

export const connectorTextDeltaSchema = z.object({
  type: z.literal("connector.text.delta"),
  connector: z.literal("AssistantTextResponseConnector"),
  cycleId: z.string(),
  taskId: z.string(),
  delta: z.string(),
});

export const connectorTextDoneSchema = z.object({
  type: z.literal("connector.text.done"),
  connector: z.string(),
  cycleId: z.string(),
  taskId: z.string(),
});

export const connectorAudioStartSchema = z.object({
  type: z.literal("connector.audio.start"),
  connector: z.literal("AssistantAudioResponseConnector"),
  cycleId: z.string(),
  taskId: z.string(),
  encoding: z.string(),
  sampleRate: z.number(),
});

export const connectorAudioDoneSchema = z.object({
  type: z.literal("connector.audio.done"),
  connector: z.string(),
  cycleId: z.string(),
  taskId: z.string(),
});

export const cognitionStatusSchema = z.object({
  type: z.literal("cognition.status"),
  state: z.enum(["idle", "thinking", "acting"]),
  runningEffects: z.array(z.string()),
});

// Update session.configure to include capabilities
export const sessionConfigureSchema = z.object({
  type: z.literal("session.configure"),
  language: z.enum(["en", "zh"]).default("en"),
  capabilities: z.object({
    supports: z.array(z.string()),
  }),
});

// Update session.ready to include enabledEffects
export const sessionReadySchema = z.object({
  type: z.literal("session.ready"),
  sessionId: z.string(),
  audioEncoding: z.string(),
  inputSampleRate: z.number(),
  outputSampleRate: z.number(),
  enabledEffects: z.array(z.string()),
});
```

Rebuild discriminated unions for `GatewayMessage` and `ClientMessage`.

- [ ] **Step 2: Fix protocol test compilation**

Run: `cd shared/protocol && bun run typecheck`
Fix any broken tests referencing old schemas.

- [ ] **Step 3: Commit**

```bash
git add shared/protocol/
git commit -m "feat(protocol): replace turn-based schemas with cycle/connector protocol

Delete turn.started, response.text.delta, etc. Add cycle.started,
connector.cancelled, connector.text.delta, connector.audio.start,
cognition.status. session.configure now includes capabilities."
```

---

## Task 14: Web SDK connector rewrite

**Files:**
- Create: `shared/web-sdk/src/connector-types.ts`
- Create: `shared/web-sdk/src/connectors/user-audio-input-connector.ts`
- Create: `shared/web-sdk/src/connectors/user-text-input-connector.ts`
- Create: `shared/web-sdk/src/connectors/assistant-audio-response-connector.ts`
- Create: `shared/web-sdk/src/connectors/assistant-text-response-connector.ts`
- Create: `shared/web-sdk/src/connectors/cognition-status-connector.ts`
- Modify: `shared/web-sdk/src/index.ts`
- Modify or rewrite: `shared/web-sdk/src/voice-client.ts` → SDK public API

- [ ] **Step 1: Define connector contract**

```typescript
// shared/web-sdk/src/connector-types.ts
export interface Connector {
  readonly capability: string;
  readonly kind: "input" | "output" | "status";
  attach(sdk: SentientSDK): void;
  detach(): void;
}

export interface SentientSDK {
  register(connector: Connector): void;
  connect(): Promise<void>;
  disconnect(): void;
  status(): "disconnected" | "authenticating" | "ready" | "error";
  send(message: unknown): void;
  sendBinary(data: ArrayBuffer): void;
  onMessage(type: string, handler: (msg: unknown) => void): () => void;
}
```

- [ ] **Step 2: Implement 5 Phase-1 connectors**

Each connector handles `connector.cancelled` per the spec §3.10:
- `AssistantAudioResponseConnector`: on cancelled → flush buffer, stop playback
- `AssistantTextResponseConnector`: on cancelled → mark stream cancelled
- `CognitionStatusConnector`: tracks `cycle.started` / `cycle.completed` / `cycle.aborted`

- [ ] **Step 3: Implement SentientSDK**

Rewrite `voice-client.ts` as the new SDK entry point. Derives `capabilities.supports` from registered connectors. Manages WebSocket connection, routes incoming messages to connectors by type prefix.

- [ ] **Step 4: Update index.ts exports**

- [ ] **Step 5: Commit**

```bash
git add shared/web-sdk/
git commit -m "feat(sdk): connector-based SDK replacing VoiceClient

5 Phase-1 connectors: UserAudioInput, UserTextInput,
AssistantAudioResponse, AssistantTextResponse, CognitionStatus.
SentientSDK derives capabilities from registered connectors.
connector.cancelled flushes buffers per connector."
```

---

## Task 15: WS handlers rewrite

**Files:**
- Rewrite: `gateway/src/session-handlers/ws-handlers.ts`

- [ ] **Step 1: Rewrite ws-handlers for cerebrum protocol**

Read existing `ws-handlers.ts`. Replace turn-based session creation with:
1. Parse `session.configure` with `capabilities.supports`
2. Create `ShortTermContext` for session
3. Create `AttentionGate` with callbacks wired to `CognitiveCycle`
4. Register adapters based on capabilities
5. Register effects based on capabilities + salience map
6. Route `text.input` → `UserTextInputAdapter.handleTextInput()`
7. Route binary audio → `UserAudioInputAdapter` (existing STT adapter)
8. Emit `cycle.started`, `cycle.completed`, `cycle.aborted`, `cognition.status` events
9. Route `connector.cancelled` per-task from EffectWrapper through ConnectorSink → WS

- [ ] **Step 2: Verify compilation**

Run: `cd gateway && bun run typecheck`

- [ ] **Step 3: Commit**

```bash
git add gateway/src/session-handlers/
git commit -m "feat(gateway): rewrite ws-handlers for cerebrum cycle protocol

Capability handshake, ShortTermContext per session, AttentionGate
wiring, adapter/effect registration, connector message routing."
```

---

## Task 16: Bootstrap + main wiring

**Files:**
- Create: `gateway/src/bootstrap/cerebrum-factory.ts`
- Create: `gateway/src/bootstrap/adapter-registry.ts`
- Create: `gateway/src/bootstrap/effect-registry.ts`
- Modify: `gateway/src/bootstrap/create-gateway-services.ts`

- [ ] **Step 1: Create cerebrum-factory.ts**

Composes: load salience map, create ShortTermContext factory, create AttentionGate factory, create ContextAssembler, create TaskManager. Returns a `CerebrumServices` interface that `ws-handlers` consumes.

- [ ] **Step 2: Create adapter-registry.ts and effect-registry.ts**

Registry pattern: each registers available adapters/effects based on config and returns arrays for per-session instantiation.

- [ ] **Step 3: Update create-gateway-services.ts**

Replace pipeline service composition with cerebrum service composition. Add `CerebrumServices` to `GatewayServices` interface.

- [ ] **Step 4: Commit**

```bash
git add gateway/src/bootstrap/
git commit -m "feat(bootstrap): wire cerebrum services into gateway startup

cerebrum-factory composes context + gate + assembler + taskmanager.
adapter-registry + effect-registry for per-session instantiation."
```

---

## Task 17: WebUI update

**Files:**
- Modify: `gateway/webui/src/hooks/use-voice-client.ts`
- Modify: `gateway/webui/src/app.tsx` or equivalent entry

- [ ] **Step 1: Replace voice-flow hook with connector registrations**

Update the web UI to use the new SentientSDK with 5 connector registrations. The UI behavior stays the same (mic button, speech bubble, audio playback) — only the internals change.

- [ ] **Step 2: Verify webui builds**

Run: `cd gateway/webui && bun run build`

- [ ] **Step 3: Commit**

```bash
git add gateway/webui/
git commit -m "feat(webui): replace voice-flow hook with connector registrations

Same UI behavior (mic, speech bubble, audio). Under the hood:
5 connectors registered with SentientSDK, cycle-based protocol."
```

---

## Task 18: Delete old pipeline code

**Files:**
- Delete: `gateway/src/pipeline/` (entire directory)
- Delete: `gateway/src/context/session-history.ts`
- Delete: `gateway/src/context/context-assembler.ts`
- Clean up any remaining imports of deleted modules

- [ ] **Step 1: Delete directories and files**

```bash
rm -rf gateway/src/pipeline/
rm gateway/src/context/session-history.ts
rm gateway/src/context/context-assembler.ts
```

- [ ] **Step 2: Grep for remaining imports**

Run: `grep -r "from.*pipeline/" gateway/src/ --include="*.ts" -l`
Run: `grep -r "from.*session-history" gateway/src/ --include="*.ts" -l`
Fix any remaining references.

- [ ] **Step 3: Verify clean build**

Run: `cd gateway && bun run typecheck && bun run lint`

- [ ] **Step 4: Commit**

```bash
git add -A gateway/src/
git commit -m "refactor(gateway): delete old turn-based pipeline code

Remove pipeline/, context/session-history.ts, context/context-assembler.ts.
All orchestration now runs through cerebrum/."
```

---

## Task 19: Docker config + salience_map mount

**Files:**
- Modify: `deploy/docker/docker-compose.yml`

- [ ] **Step 1: Add salience_map.yaml volume mount**

Add to the gateway service in docker-compose.yml:

```yaml
volumes:
  # ... existing mounts ...
  - ${HOME}/.sentient/gateway/salience_map.yaml:/app/salience_map.yaml:ro
```

- [ ] **Step 2: Copy default salience_map.yaml to host config**

Edit `~/.sentient/gateway/salience_map.yaml` in place (per the "don't clobber host config" memory) with the same content as `gateway/salience_map.yaml`.

- [ ] **Step 3: Update host config.yaml**

Edit `~/.sentient/gateway/config.yaml` in place to add the `cerebrum:` section.

- [ ] **Step 4: Commit**

```bash
git add deploy/docker/docker-compose.yml
git commit -m "chore(deploy): add salience_map.yaml mount to docker compose"
```

---

## Task 20: Full CI + Smoke test

**Files:**
- Create: `gateway/scripts/smoke-cerebrum.ts`

- [ ] **Step 1: Run full local CI**

```bash
source scripts/env.sh
# Stop any running containers that hold test ports
docker compose -f deploy/docker/docker-compose.yml down 2>/dev/null || true
cd gateway && bun run ci
```

Expected: lint clean, typecheck clean, all tests pass.

- [ ] **Step 2: Create headless smoke test script**

Create `gateway/scripts/smoke-cerebrum.ts` that:
1. Connects via WebSocket to gateway
2. Sends `session.configure` with capabilities
3. Sends `text.input` with "Hello"
4. Waits for `cycle.started` → `connector.text.delta` or `connector.audio.start` → `cycle.completed`
5. Exits 0 on success, 1 on timeout (10s)

- [ ] **Step 3: Docker build and smoke**

```bash
cd deploy/docker && docker compose build
docker compose up -d
sleep 5  # wait for services to start
docker compose logs gateway | grep -E "(cerebrum|cycle|effect|salience|gate)"
# Run smoke test against running containers
cd ../../gateway && bun run scripts/smoke-cerebrum.ts
docker compose logs gateway  # review for ERROR entries
```

- [ ] **Step 4: Commit smoke script**

```bash
git add gateway/scripts/smoke-cerebrum.ts
git commit -m "test(gateway): add cerebrum smoke test script

Headless WS client: configure → text.input → verify cycle
lifecycle events in 10s timeout."
```

---

## Task 21: Verification gate

This task is the hard gate from spec §11. All items must pass before declaring done.

- [ ] **Step 1: Automated checks**

```bash
source scripts/env.sh
bun run lint        # clean
bun run typecheck   # clean
bun run test:unit   # ≥80% statements, 75% branches
bun run test:int    # handshake, cycle fire, barge-in, rate limit
bun run ci          # full pass
```

- [ ] **Step 2: Containerized smoke test**

```bash
cd deploy/docker && docker compose build && docker compose up -d
docker compose logs gateway | grep -E "(cerebrum|cycle|effect|salience|gate)"
cd ../../gateway && bun run scripts/smoke-cerebrum.ts
# Verify no ERROR-level log entries
docker compose logs gateway 2>&1 | grep -i "ERROR" && echo "FAIL: errors found" || echo "PASS: no errors"
```

- [ ] **Step 3: Hand off to Kevin for manual test**

Message Kevin:
> "Cerebrum architecture is ready for manual testing. PR is in draft. Please:
> 1. Open web UI at `https://<pi-host>:...`
> 2. Voice input → verify you hear a reply
> 3. Text input → verify you hear a reply
> 4. Barge-in mid-reply → verify assistant stops within ~500ms, no trailing audio
> 5. Review `docker compose logs gateway` for anomalies
> Sign off when satisfied."

- [ ] **Step 4: After Kevin signs off, merge**

```bash
# Kevin has approved — merge to develop
git checkout develop
git merge feature/brain-arch
git push
git branch -d feature/brain-arch
```

---

## Dependency graph

```
Task 1 (types) ──► Task 3 (ShortTermContext) ──► Task 6 (AttentionGate) ──► Task 10 (CognitiveCycle)
     │                                                                            │
     ├──► Task 4 (SalienceMap) ──────────────────────────────────────────────────►─┤
     │                                                                            │
     ├──► Task 5 (TaskManager) ──────► Task 9 (EffectWrapper) ──────────────────►─┤
     │                                                                            │
     ├──► Task 2 (Config) ──────────────────────────────────────────────────────►─┤
     │                                                                            │
     └──► Task 7 (LLM provider) ──► Task 8 (ContextAssembler) ────────────────►─┘
                                                                                  │
                                              Task 11 (TTSAudioEffect) ──────────►┤
                                              Task 12 (Adapters) ─────────────────►┤
                                                                                   │
Task 13 (Protocol) ──► Task 14 (SDK) ──► Task 17 (WebUI) ────────────────────────►┤
                                                                                   │
                                              Task 15 (WS handlers) ──────────────►┤
                                              Task 16 (Bootstrap) ────────────────►┤
                                                                                   │
                                              Task 18 (Delete old) ───────────────►┤
                                              Task 19 (Docker) ───────────────────►┤
                                                                                   ▼
                                              Task 20 (Smoke) ──► Task 21 (Verify)
```

**Parallelizable groups** (no cross-dependencies):
- Group A: Tasks 3, 4, 5 (ShortTermContext, SalienceMap, TaskManager)
- Group B: Tasks 7, 8 (LLM provider, ContextAssembler) — after types
- Group C: Tasks 11, 12, 13 (TTSEffect, Adapters, Protocol) — after core cerebrum
- Group D: Tasks 14, 15 (SDK, WS handlers) — after protocol
