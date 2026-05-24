> **SUPERSEDED BY** `docs/superpowers/specs/2026-04-21-hermes-cerebrum-integration-design-v4.md`
>
> Date superseded: 2026-04-22.
> Reason: Phase 1 (Hermes cerebrum integration) absorbs this scope.
> Kept as historical reference.

---

# Speak as Terminal Tool — Design

**Date:** 2026-04-19
**Status:** Brainstormed, awaiting user approval before plan-writing.
**Scope:** Port TTS out of the auto-pipeline that today consumes the LLM token stream and back into an explicit `speak` tool/effect that the model invokes when it decides the user should hear something. Introduces a new "terminal tool" effect category, a session-capability gate that generalizes beyond TTS, and a clean two-layer split between effect orchestration and TTS provider so providers can be swapped without touching the wrapper. Preserves all existing wire signals so the SDK does not need a protocol bump.

---

## 1 — Motivation

The current `ContentTTSPipeline` auto-attaches a TTS pass to every cycle's LLM token stream, gated only by a `channel: voice|text|auto` preference. This is wrong for the model the rest of the system is converging on:

- Each cycle, the model can produce rich markdown content (code blocks, tables, links) that is useful to *show* but is not TTS-friendly.
- Each cycle, the model may produce content the user does not need to hear at all.
- Each cycle, the model may produce no content and only call tools.
- The model has no way to compose a TTS-ready summary that *differs* from the visible content (e.g., a short spoken acknowledgement after a long markdown report).

The right primitive is an explicit `speak(text)` tool the model calls when audio is appropriate. The text argument carries TTS-ready prose; visible content stays in the assistant entry. The tool joins a new "terminal" category — calling only terminal tools (or none) ends the ReAct loop, mirroring today's "no tool calls = loop ends" semantic but allowing speak as the final-word action.

The infrastructure for this port already exists in the codebase, unused: `PartialJsonFieldExtractor` and `StreamingEffectCoordinator` (added in the cerebrum v0.1.0 commit) handle the partial-JSON arg-streaming wiring, and the original `tts-audio-effect.ts` (deleted in the same commit) gives the synthesize-and-stream-frames shape.

---

## 2 — Guiding principles

- **The model decides what gets spoken.** No server-side heuristic on the assistant content; speak is opt-in per cycle.
- **Visible content and spoken text are independent channels.** Content goes to the chat surface; speak goes to audio. They may overlap in meaning but never collapse into one stream.
- **Terminal tools end the loop, not the cycle.** A cycle with terminal-only tool calls completes normally; the ReAct loop simply doesn't fire another cycle.
- **Capability set, not predicate list.** Session state derives a capability snapshot; effects declare what they require; the same set drives both dynamic tool exposure and execution-time defense-in-depth.
- **Two-layer split for provider swap.** The `speak` effect orchestrates lifecycle and audio framing; a separate `TextStreamSynthesizer` interface owns the TTS engine. Provider swap = one bootstrap line.
- **Wire compatibility.** The SDK already parses `audio.start/frame/done` and `playback.stop`. New work adds optional fields, never breaks existing ones.
- **Terminal tasks are invisible to task lists.** They communicate via the audio envelope. The SDK and the LLM both see live tasks as the *non-terminal* set; terminal tasks have their own first-class wire signals (audio).

---

## 3 — Effect surface

### 3.1 — New `terminal` category

A boolean flag on `EffectDefinition`:

```ts
interface EffectDefinition<A> {
  name: string;
  // ...existing fields...
  terminal?: boolean;                  // ← new
  requires?: Capability[];             // ← new (Section 4)
  streamingArgs?: { field: string };   // already exists
  interruptable: boolean;
}
```

**Loop continuation rule** (`cognitive-cycle.ts` `shouldContinue`):

> A cycle ends ⇔ no non-terminal tool call in the cycle.

A cycle with no tool calls ends the loop (today's behavior). A cycle with only terminal tool calls also ends the loop. A cycle with at least one non-terminal tool call continues the loop after that tool's result is committed and salience accumulates.

Terminal effects are still `interruptable: true` — both flags coexist. `terminal` controls *loop* behavior; `interruptable` controls *cancellation* behavior.

### 3.2 — `speak` effect definition

```ts
{
  name: "speak",
  description: SPEAK_TOOL_DESCRIPTION,   // see Section 3.3
  schema: {
    type: "object",
    properties: { text: { type: "string", minLength: 1 } },
    required: ["text"],
  },
  argsValidator: speakArgsSchema.parse,
  impact: "auto",
  rolesAllowed: ["adult", "child"],
  requires: ["audio.output"],
  interruptable: true,
  terminal: true,
  streamingArgs: { field: "text" },
  handler: speakHandler,                  // see Section 5
}
```

### 3.3 — Tool description (model-facing)

```
Speak text aloud to the user.

The `text` argument must be TTS-friendly prose that mirrors the spoken
essence of your `content` for this turn — strip markdown, fenced code,
URLs, table layout, and any other elements that don't translate to
speech, but preserve the meaning. Use natural punctuation (commas,
periods, em-dashes, ellipses) to shape pacing and intonation; the TTS
engine depends on it for smooth, lifelike output.

Call this only when you've decided the user should *hear* what you're
saying. Check the session preferences table — if `channel` is "text",
do not call `speak`; if "voice", prefer it; if "auto", decide from
context (short conversational reply → speak; a long markdown report
the user is meant to read → skip). You may call `speak` multiple times
per turn (e.g., a status line before a tool call, then a result line
after). Each call queues independently and plays in order.
```

### 3.4 — System-prompt addition

The cycle's system message gains a new section explaining the two output channels:

```
Your reply each turn has two channels:

  • content (markdown, code, tables, links) — always rendered in
    the chat surface. Visible but not spoken.

  • speak(text) tool — the only way the user *hears* something.
    Call it when audio is appropriate.

Read the session preferences table at the top of this prompt before
deciding whether to call speak. The `channel` setting is authoritative.
```

The exact wording lives in `gateway/src/cerebrum/context-assembler.ts` alongside the existing system-message composition.

---

## 4 — Capability gate

Promotes the existing `capabilities` field from a static role-permission tag into a session-derived capability set used in two places: dynamic tool exposure, and defense-in-depth at the wrapper.

### 4.1 — Capability model

```ts
type Capability =
  | "audio.output"      // granted when preferences.channel != "text"
  | "image.display"     // granted when a visual surface is connected
  | "calendar.read"     // granted when calendar integration enabled
  | "private.context"   // granted when user role allows
  // ...add as features land

interface SessionCapabilities {
  has(cap: Capability): boolean;
  list(): Capability[];
}

function deriveSessionCapabilities(input: {
  preferences: PreferenceSnapshot;
  role: UserRole;
  surfaces: ConnectedSurface[];
  integrations: IntegrationStatus;
}): SessionCapabilities;
```

Lives in `gateway/src/cerebrum/session-capabilities.ts` (new file). Pure function; trivially testable.

### 4.2 — Two consumers, one source of truth

**Consumer 1 — Dynamic tool list.** When building the per-cycle effect list:

```ts
const availableEffects = allEffects.filter(
  e => (e.requires ?? []).every(c => session.capabilities.has(c))
);
```

If `channel === "text"`, `audio.output` is absent, `speak` is filtered out, the model never sees it in the tool list. No tokens spent describing an unusable tool.

**Consumer 2 — Defense-in-depth at wrapper.** A new gate in `effect-wrapper.ts` runs after role/capability/rate-limit gates and before task registration. Re-checks `requires ⊆ session.capabilities` in case the snapshot the LLM saw is stale (preference changed mid-cycle, etc.):

```ts
// effect-wrapper.ts — pre-handler chain
const missing = (effect.requires ?? []).filter(c => !session.capabilities.has(c));
if (missing.length > 0) {
  if (effect.terminal) {
    log.warn("terminal-effect-blocked-by-capability", {
      effectName: effect.name, taskId, sessionId, missing,
      reason: "model-drift",
    });
    return { ok: true, data: { skipped: true, reason: `capability-missing:${missing.join(",")}` } };
  }
  // Non-terminal: synthetic error tool result, flows through normal commit path
  return {
    ok: false,
    data: {
      error: "capability-missing",
      capability: missing[0],
      hint: capabilityHint(missing[0]),  // human-readable guidance for model
    },
  };
}
```

### 4.3 — Behavior on capability miss

| Effect kind | Outcome | Wire emission | History | Salience |
|---|---|---|---|---|
| Terminal (e.g., `speak`) | Silent skip + WARN log | None | None | None |
| Non-terminal (e.g., `read_calendar`) | Synthetic error tool result | Normal `task.update`† | Tool entry with error | Bumps salience → next cycle fires → model sees error and adapts |

† Non-terminal capability blocks still emit a brief `task.update` lifecycle (started + ended-with-error) so the SDK can surface the failure if it wants. Terminal blocks emit nothing — they are invisible by design.

The terminal-skip path requires one extra rule in `cognitive-cycle-dispatch.ts`: when the wrapper returns `{ ok: true, data: { skipped: true } }` for a `terminal` effect, the dispatch path **skips the tool-entry commit** for that call (matches the "no history entry" row above). All other cases — terminal completed, terminal aborted, non-terminal anything — commit normally.

The model on the next cycle sees the error tool result and can adapt: "Calendar isn't connected — would you like to link it?"

---

## 5 — Two-layer split: orchestration vs. TTS provider

A clean seam between effect-wrapper concerns (task lifecycle, abort, connector, audio framing) and TTS-provider concerns (text-in, audio-out). Provider swap touches one factory call.

### 5.1 — Layer 1: `speak-effect.ts` (orchestration)

`gateway/src/effects/speak-effect.ts` (new; replaces deleted `tts-audio-effect.ts`):

```ts
async function* speakHandler(
  args: SpeakArgs,
  ctx: EffectContext,
  synth: TextStreamSynthesizer,
): AsyncGenerator<EffectFrame> {
  if (ctx.abortSignal.aborted) return;

  ctx.connector.send({
    type: "audio.start",
    cycleId: ctx.cycleId, taskId: ctx.taskId,
  });

  let frameCount = 0;
  for await (const frame of synth.synthesize(ctx.argStream, ctx.abortSignal)) {
    if (ctx.abortSignal.aborted) break;
    ctx.connector.sendBinary(frame.data, {
      encoding: frame.encoding, sampleRate: frame.sampleRate,
    });
    frameCount++;
    yield { type: "audio", frame: frame.data };
  }

  if (!ctx.abortSignal.aborted) {
    ctx.connector.send({
      type: "audio.done",
      cycleId: ctx.cycleId, taskId: ctx.taskId,
    });
  }
  yield { type: "done" };
}
```

This file knows: task context, connector, abort signal, audio envelope. It does not know: Fish Audio, sentence aggregation, emotion tagging, voice IDs, sample-rate specifics. ~25 lines. Should never need to change when swapping TTS providers.

### 5.2 — Layer 2: `TextStreamSynthesizer` interface

`gateway/src/tts/text-stream-synthesizer.ts` (new):

```ts
export interface TextStreamSynthesizer {
  synthesize(
    textStream: AsyncIterable<string>,
    signal: AbortSignal,
  ): AsyncIterable<AudioFrame>;
}

export interface AudioFrame {
  readonly data: Uint8Array;
  readonly encoding: string;
  readonly sampleRate: number;
}
```

Single function, two args, one return. Contract: text in, audio out, with abort propagation. Everything provider-specific lives behind it.

### 5.3 — Layer 2 concrete: `FishAudioStreamSynthesizer`

`gateway/src/providers/tts/fish-audio-synthesizer.ts` (new):

```ts
export function createFishAudioSynthesizer(deps: {
  sessionFactory: TTSSessionFactory;
  aggregator: () => UtteranceAggregator;
  emotionTagger?: EmotionTagger;
}): TextStreamSynthesizer {
  return {
    async *synthesize(textStream, signal) {
      const session = await deps.sessionFactory.createSession();
      const agg = deps.aggregator();

      // Concurrent producer/consumer:
      //   producer task: drain textStream → agg → optional emotion tag
      //                  → session.pushText(block); session.endInput() at close
      //   consumer (this generator):
      //     for await (frame of session.audioFrames(signal)) yield frame
      //
      // Both halves respect signal. On abort: producer stops draining,
      // consumer stops yielding, session is released.
    },
  };
}
```

Aggregator + emotion tagger move *inside* this file — they are "how Fish Audio likes its input prepared", not universal preprocessing. A future `PiperSynthesizer` may do zero aggregation or different chunk shapes.

### 5.4 — Bootstrap wiring

`gateway/src/bootstrap/cerebrum-factory.ts`:

```ts
const synthesizer = createFishAudioSynthesizer({
  sessionFactory: createFishAudioSessionFactory(connection, ttsConfig, onTurn),
  aggregator: () => createUtteranceAggregator(aggOpts),
  emotionTagger: emotionTagger,
});

const speakEffect = createSpeakEffect({ synthesizer });
```

Provider swap = change one factory call. Wrapper, dispatch, task manager, connector, audio framing, capability gate, history representation: all untouched.

### 5.5 — Test surfaces

Two clean files, two clean test files, no entanglement:

- `speak-effect.test.ts` — mocks `TextStreamSynthesizer`. Tests envelope ordering, abort behavior, multi-call concurrency, capability gate. Never instantiates Fish Audio.
- `fish-audio-synthesizer.test.ts` — mocks `TTSSessionFactory`. Tests aggregator wiring, emotion-tagger wiring, partial-input → final endInput drain, abort propagation. Never instantiates the speak handler or task manager.

---

## 6 — Cancellation primitives

Replace today's three primitives with four around `TaskManager`. Composition happens at the call site, not inside a "stop everything" method.

| Primitive | Action | Caller | Replaces |
|---|---|---|---|
| `taskManager.cancelTerminal(reason)` | Cancel all active tasks where `effect.terminal === true`. Returns cancelled task IDs. | Mic onset (barge-in) | `ttsSlot.cancelCurrent()` |
| `taskManager.cancelInterruptable(reason)` | Cancel all tasks with `interruptable: true` (includes terminal). Returns IDs. | UI Stop / `cancel_all_tasks` effect | unchanged |
| `taskManager.cancel(taskId, reason)` | Cancel one specific task. | `cancel_task` effect | unchanged |
| `cycleSlot.cancelCurrent()` | Aborts the LLM stream of the in-flight cycle. | Interrupt path only | unchanged |

**Barge-in path:**

```
mic-onset → BargeInController →
  taskManager.cancelTerminal("barge-in")
  + ws.send({ type: "playback.stop", cycleId, reason: "barge-in", cancelledTaskIds })
```

LLM stream untouched. `BargeInController` shrinks to ~10 lines: subscribe to mic-onset event, call those two things.

**Interrupt path** (UI Stop / `cancel_all_tasks` effect):

```
interrupt → InterruptController →
  cycleSlot.cancelCurrent()
  + taskManager.cancelInterruptable("interrupt")
  + ws.send({ type: "playback.stop", cycleId, reason: "interrupt", cancelledTaskIds })
  + attentionGate.clearConversationSalience()
```

Interrupt is a strict superset of barge-in: cancels everything barge-in would, plus the cycle, plus non-terminal interruptable tasks.

The four primitives compose cleanly. No central `SessionAudioController` orchestrates them — each call site composes the primitives it needs.

---

## 7 — ConversationHistory representation

Each `speak` call produces a normal **tool entry** appended after the cycle's assistant entry. No new entry kind.

```ts
{
  kind: "tool",
  toolName: "speak",
  toolCallId: "T-xyz",
  cycleId: "C-abc",
  args: { text: "It's 72 and sunny." },
  status: "completed" | "aborted" | "skipped",
  cutoff?: "barge-in" | "interrupt",
  spokenChars?: number,    // best-effort: count of TTS-friendly chars sent to the synthesizer before abort. Only present when status === "aborted".
}
```

**Cutoff lives on the tool entry, not the assistant entry.** Auto-content TTS is gone; the assistant entry's `content` is display-only and cannot be "interrupted" — the LLM finishes generating it. What gets truncated is the audio of a specific speak task, so cutoff naturally moves there.

### 7.1 — Edge cases

- **Speak interrupted mid-drain (barge-in):** tool entry `status: aborted, cutoff: barge-in, spokenChars: ~N`. Model on next cycle sees: "I tried to say X but was interrupted after ~N chars."
- **Interrupt mid-cycle while LLM still streaming speak args:** assistant entry committed with whatever `content` LLM produced + `cutoff: interrupt` (LLM stream itself was killed). Tool entry: `status: aborted, cutoff: interrupt`. Coherent "user stopped me" picture.
- **Speak skipped by capability gate** (channel=text, model drift): no tool entry at all. WARN log only. Model never sees its drift; on next cycle the tool list still excludes `speak`, so re-drift is unlikely.

### 7.2 — Webui rendering

Existing tool-pill rendering already handles the entry shape. `speak` pill renders the spoken text inline:

```
🔊 "It's 72 and sunny."
```

UI may collapse to icon-only when the same text appears in the assistant content above. UI choice; protocol carries everything either way.

---

## 8 — Wire protocol + visibility filters

### 8.1 — Wire signals (preserve everything the SDK parses today)

Same four messages, additive `taskId` field only:

```
audio.start    { cycleId }              → { cycleId, taskId }
audio.frame    { cycleId }              → { cycleId, taskId }
audio.done     { cycleId }              → { cycleId, taskId }
playback.stop  { cycleId, reason }      → { cycleId, reason, cancelledTaskIds: string[] }
```

Old SDK builds keep working — they ignore `taskId` and key the existing `CycleAudioQueue` on `cycleId`. New behavior unlocks when the SDK chooses to use `taskId` (per-speak progress, future per-task UI cues).

Multi-speak in one cycle = multiple envelopes with the same `cycleId` and distinct `taskId`s, arriving sequentially. The existing `CycleAudioQueue` already handles "start … frames … done … start … frames … done" within a cycle as concatenation.

`playback.stop`'s `cancelledTaskIds` array generalizes today's single-cancel signal — a single barge-in may now stop N concurrent speaks. No new wire messages; no protocol bump.

### 8.2 — Visibility filters

Terminal tasks are an internal construct. They communicate via the audio envelope; they never surface as task-list items.

**Filter 1 — `task.update` emission.**

```ts
// task-manager.ts
private emitLifecycle(handle: TaskHandle, phase: "started" | "ended", outcome?: TaskOutcome) {
  if (handle.effect.terminal) return;          // ← new guard
  this.listeners.forEach(l => l({ ...handle, phase, outcome }));
}
```

`ComposerTaskStrip` in the webui shows real work (calendar reads, email sends, etc.) but never a `speak` pill. The user already sees the speech: it's playing.

**Filter 2 — Snapshot accessors.**

```ts
class TaskManager {
  iterAll(): Iterable<TaskHandle> { ... }                       // existing — internal cancel iteration
  iterPublic(): Iterable<TaskHandle> {                          // new — for SDK serialization
    return [...this.iterAll()].filter(h => !h.effect.terminal);
  }
  iterForLLM(): Iterable<TaskHandle> {                          // new — for context-assembler
    return this.iterPublic();
  }
}
```

`ContextAssembler`'s task-table renderer switches from `iterAll` → `iterForLLM`. Model sees: "Currently running: `read_calendar`" — never "Currently running: `speak`". Stops the model from getting confused about whether to wait for its own speech.

Cancellation paths still use `iterAll` internally — they need to see speak tasks to cancel them. Visibility filter is for *display*, not for *control*.

### 8.3 — Visibility audit

| Surface | Sees terminal tasks? |
|---|---|
| `audio.start/frame/done`, `playback.stop` wire messages | ✅ yes (the only signal) |
| `task.update` lifecycle events | ❌ no |
| `task.snapshot` on reconnect | ❌ no |
| `ComposerTaskStrip` in webui | ❌ no |
| LLM system-prompt task table | ❌ no |
| `ConversationHistory` tool entries (committed) | ✅ yes (durable record) |

Live channel for terminal tasks is audio; durable record is history. The "task" abstraction stays internal.

---

## 9 — Files added, modified, deleted

### Added

- `gateway/src/effects/speak-effect.ts` (+ test)
- `gateway/src/tts/text-stream-synthesizer.ts` (interface; no logic)
- `gateway/src/providers/tts/fish-audio-synthesizer.ts` (+ test)
- `gateway/src/cerebrum/session-capabilities.ts` (+ test)

### Modified

- `gateway/src/effects/effect-types.ts` — add `terminal?: boolean`, `requires?: Capability[]`
- `gateway/src/effects/effect-wrapper.ts` — add capability gate (Section 4.2); pass through `cycleId`/`taskId` to handlers
- `gateway/src/cerebrum/cognitive-cycle.ts` — `shouldContinue` checks for *non-terminal* tool calls; remove `ttsPipeline` plumbing (lines ~202–224, 376, 211, 217)
- `gateway/src/cerebrum/cognitive-cycle-dispatch.ts` — propagate capability snapshot into wrapper
- `gateway/src/cerebrum/context-assembler.ts` — append the two-channel system-prompt addition (Section 3.4); switch task-table source to `iterForLLM`. Tool-list rendering already iterates the per-cycle effects list, which Section 4.2 already filters by capability — no separate capability rendering needed.
- `gateway/src/cerebrum/task-manager.ts` — `emitLifecycle` filter, `iterPublic`/`iterForLLM` accessors, store `effect` ref on `TaskHandle` (or at minimum the `terminal` flag)
- `gateway/src/session-handlers/barge-in-controller.ts` — call `taskManager.cancelTerminal` instead of `ttsSlot.cancelCurrent`; emit `cancelledTaskIds` on `playback.stop`
- `gateway/src/session-handlers/interrupt-controller.ts` — emit `cancelledTaskIds` on `playback.stop`
- `gateway/src/bootstrap/cerebrum-factory.ts` — wire synthesizer + speak effect; remove content-TTS pipeline construction
- `shared/protocol/*` — add `taskId` to `audio.start/frame/done`; add `cancelledTaskIds: string[]` to `playback.stop`
- `gateway/src/effects/configure-effect.ts` — already exists; no changes needed (channel preference still drives capability derivation)

### Deleted

- `gateway/src/cerebrum/content-tts-pipeline.ts` + test
- `services.contentTTSOptions` field and its construction in bootstrap
- `ttsSlot` — the `AbortSlot` instance dedicated to TTS
- `services.contentTTSPipeline` `pushDelta`/`endInput`/`done` plumbing inside `cognitive-cycle.ts`

### Untouched but reused

- `gateway/src/cerebrum/partial-json-field-extractor.ts` — already exists, unused; first real consumer is now `speak`
- `gateway/src/cerebrum/streaming-effect-coordinator.ts` — already exists, unused; activates with `speak`
- `gateway/src/effects/utterance-aggregator.ts` — moves logically inside `fish-audio-synthesizer` ownership; file path stays
- `gateway/src/effects/emotion-tagger.ts` — same
- `gateway/src/cerebrum/conversation-history.ts` — schema already supports tool entries with cutoff/status; no changes needed
- Webui SDK + `CycleAudioQueue` + `ComposerTaskStrip` — all signals it parses today are preserved; `task.update` filter happens server-side before emission

---

## 10 — Open follow-ups (out of scope for this spec)

- Per-task UI cues in the webui that opt into the new `taskId` field on audio messages (e.g., a tiny waveform indicator per speak chunk).
- Capability hint strings (`capabilityHint(cap)`) for non-terminal capability-miss errors — needs UX wording per capability.
- A future second terminal effect (e.g., `play_sound`, `show_image`) to validate that the `terminal` + `requires` abstractions hold up.
- A `speak` retry policy if Fish Audio session creation fails partway through a cycle (today: handler errors, tool entry status `error`; could be smarter).
