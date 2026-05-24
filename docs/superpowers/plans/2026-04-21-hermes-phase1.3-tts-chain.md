# Phase 1.3 — TTS Decorator Chain + Barge-In Gate

> **Parent plan:** `2026-04-21-hermes-phase1-overview.md`
> **Previous:** `2026-04-21-hermes-phase1.2-wire-parity.md` (must be complete)

**Goal:** a working TTS pipeline consuming Hermes `text.delta` events:

```
text.delta stream
  │
  ▼
BargeInGate          (drop-when-bargedIn=true; logs)
  │
  ▼
MarkdownStripper     (remove-markdown)
  │
  ▼
EmojiStripper        (emoji-regex)
  │
  ▼
UtteranceAggregator  (paragraph/block boundaries)
  │
  ▼
EmotionTagger        (Gemini Flash; safety fallback)
  │
  ▼
FishAudioSynthesizer
  │
  ▼
ConnectorSink        → connector.audio.start / .frame / .done
```

Each stage is a **decorator unit** per `.claude/rules/pipeline.md`: AsyncGenerator in, AsyncGenerator out, one responsibility, one file, one test. Existing `utterance-aggregator` and `emotion-tagger` move from `gateway/src/effects/` to `gateway/src/tts/stages/` (interface unchanged).

**Builds on:** Phase 1.2 (`HermesClient.dispatch` yields `text.delta`).

**Spec reference:** v4 §5.5, §5.14, §5.16.5 (prompt philosophy).

---

## 1. Context and prerequisites

### New NPM dependencies

- `remove-markdown` (MIT, ~500k weekly DL, stable)
- `emoji-regex` (MIT, Unicode 16+)

### Existing code we MOVE (not rewrite)

Per v3 §5.5 and migration table in v4 §9:

| From | To | Change |
|---|---|---|
| `gateway/src/effects/utterance-aggregator.ts` | `gateway/src/tts/stages/utterance-aggregator.ts` | Move; no code change. |
| `gateway/src/effects/utterance-aggregator.test.ts` | `gateway/src/tts/stages/utterance-aggregator.test.ts` | Move; update imports only. |
| `gateway/src/effects/emotion-tagger.ts` | `gateway/src/tts/stages/emotion-tagger.ts` | Move. Simplify the prompt (remove "strip markdown" instructions — stripper owns that). |
| `gateway/src/effects/emotion-tagger.test.ts` | `gateway/src/tts/stages/emotion-tagger.test.ts` | Move; update imports. |
| `gateway/src/providers/fish-audio.ts` (or similar) | `gateway/src/tts/fish-audio-synthesizer.ts` | Move if not already there. |
| `gateway/src/session-handlers/session-audio-wire.ts` | stays | ConnectorSink unchanged. |

**Verify these files exist** before Phase 1.3 begins. If they don't, locate the equivalent code in your current effects pipeline — all we need is the `UtteranceAggregator`, emotion-tagging, and Fish Audio streaming, in whatever files they currently live.

### What we do NOT delete

The existing `speak-effect.ts` and its direct ties to the in-process cerebrum stay untouched in Phase 1.3. Phase 1.9 deletes them. Until then, both the old speak-effect and the new pipeline can coexist — selected by `cerebrum.provider`.

---

## Task 1.3.1 — Install dependencies

### Step 1.3.1a: Add deps to gateway package

- [ ] From repo root:

```bash
source scripts/env.sh
cd gateway
bun add remove-markdown emoji-regex
bun add -d @types/remove-markdown
cd -
```

- [ ] Verify entries appear in `gateway/package.json` under `dependencies`.

### Step 1.3.1b: Commit

- [ ] Commit:

```bash
git add gateway/package.json bun.lockb
git commit -m "$(cat <<'EOF'
chore(gateway): add remove-markdown and emoji-regex for TTS stripping

Phase 1.3 decorator stages MarkdownStripper and EmojiStripper use
these MIT libs. remove-markdown handles lists/code fences/tables;
emoji-regex is Unicode 16+ correct on ZWJ/skin-tone/regional indicator.

Co-Authored-By: <your-model-id>
EOF
)"
```

---

## Task 1.3.2 — Move existing stages to `gateway/src/tts/stages/`

**Files:**
- Move: `gateway/src/effects/utterance-aggregator.ts` → `gateway/src/tts/stages/utterance-aggregator.ts`
- Move: `gateway/src/effects/utterance-aggregator.test.ts` → `gateway/src/tts/stages/utterance-aggregator.test.ts`
- Move: `gateway/src/effects/emotion-tagger.ts` → `gateway/src/tts/stages/emotion-tagger.ts`
- Move: `gateway/src/effects/emotion-tagger.test.ts` → `gateway/src/tts/stages/emotion-tagger.test.ts`

### Step 1.3.2a: Confirm file locations

- [ ] Find the current locations:

```bash
grep -lrn "utterance-aggregator\|UtteranceAggregator\|emotion-tagger\|EmotionTagger" gateway/src/ | grep -v node_modules
```

- [ ] Note the actual paths. If they're NOT in `effects/`, adjust the move commands below.

### Step 1.3.2b: Move files

- [ ] `git mv` to preserve history:

```bash
mkdir -p gateway/src/tts/stages
git mv gateway/src/effects/utterance-aggregator.ts gateway/src/tts/stages/
git mv gateway/src/effects/utterance-aggregator.test.ts gateway/src/tts/stages/
git mv gateway/src/effects/emotion-tagger.ts gateway/src/tts/stages/
git mv gateway/src/effects/emotion-tagger.test.ts gateway/src/tts/stages/
```

### Step 1.3.2c: Update imports

- [ ] Any file importing from the old paths needs updating:

```bash
grep -lrn "from.*effects/utterance-aggregator\|from.*effects/emotion-tagger" gateway/src/
```

- [ ] Update each match to the new path `gateway/src/tts/stages/...`. Use your editor's find/replace or:

```bash
grep -rl "from.*effects/utterance-aggregator" gateway/src/ | xargs sed -i '' 's|from "../effects/utterance-aggregator"|from "../tts/stages/utterance-aggregator"|g'
grep -rl "from.*effects/emotion-tagger" gateway/src/ | xargs sed -i '' 's|from "../effects/emotion-tagger"|from "../tts/stages/emotion-tagger"|g'
```

(Adjust relative paths based on where the imports live. `sed -i ''` is macOS; on Linux use `sed -i`.)

### Step 1.3.2d: Simplify emotion-tagger prompt

- [ ] Open `gateway/src/tts/stages/emotion-tagger.ts`. Find the prompt that instructs the model on output format. Remove any clause like:
  - "strip all markdown"
  - "no code blocks"
  - "no bullet lists"
  - "plain prose only"

Reason: MarkdownStripper (Task 1.3.4) owns that deterministically. Emotion tagger should ONLY ask for emotion tags. A simplified system prompt:

```typescript
const SYSTEM_PROMPT = `You are an emotion tagger. Insert inline tags like [pause], [happy], [surprised], [gentle], [confident] before sentences where appropriate, based on meaning. Do not modify the text otherwise. Do not add any commentary.`;
```

(Adapt to the exact structure of the existing file.)

### Step 1.3.2e: Verify + commit

- [ ] `source scripts/env.sh && bun run --filter @sentient/gateway typecheck`
- [ ] `source scripts/env.sh && bun run --filter @sentient/gateway test:unit -- utterance-aggregator emotion-tagger`
- [ ] Commit:

```bash
git add gateway/src/tts/stages/ gateway/src/effects/ gateway/src/
git commit -m "$(cat <<'EOF'
refactor(tts): move utterance-aggregator + emotion-tagger to tts/stages/

Relocates to the new TTS pipeline home per v4 §5.5. Interface unchanged.
Emotion-tagger prompt simplified to only request emotion tags —
MarkdownStripper (Phase 1.3.4) owns markdown stripping.

Co-Authored-By: <your-model-id>
EOF
)"
```

---

## Task 1.3.3 — Decorator-unit primitive (shared type)

**Files:**
- Create: `gateway/src/tts/stages/stage-types.ts`

### Step 1.3.3a: Shared types

Every stage is `AsyncGenerator<string>` → `AsyncGenerator<string>`. For emotion-tagged output we need a richer type later, but the early stages are plain text.

- [ ] Create `gateway/src/tts/stages/stage-types.ts`:

```typescript
/**
 * A text-domain decorator unit in the TTS pipeline.
 *
 * Rules (from .claude/rules/pipeline.md):
 * - AsyncGenerator in, AsyncGenerator out.
 * - One responsibility per unit.
 * - Respects AbortSignal — stops consuming, stops yielding, releases buffers,
 *   does NOT throw.
 * - Internal buffering is its own business; does not own service lifecycle.
 */
export type TextStage = (
  input: AsyncIterable<string>,
  signal: AbortSignal,
) => AsyncGenerator<string>;

/**
 * Compose stages left-to-right: s1 → s2 → s3.
 */
export function composeTextStages(...stages: TextStage[]): TextStage {
  return (input, signal) => {
    let current: AsyncIterable<string> = input;
    for (const s of stages) current = s(current, signal);
    return (async function* () {
      for await (const chunk of current) {
        if (signal.aborted) return;
        yield chunk;
      }
    })();
  };
}
```

- [ ] Commit:

```bash
git add gateway/src/tts/stages/stage-types.ts
git commit -m "chore(tts): shared TextStage type + composeTextStages helper

Co-Authored-By: <your-model-id>"
```

---

## Task 1.3.4 — MarkdownStripper stage

**Files:**
- Create: `gateway/src/tts/stages/markdown-stripper.ts`
- Create: `gateway/src/tts/stages/markdown-stripper.test.ts`

### Step 1.3.4a: Implementation

The stage strips markdown CHUNK-BY-CHUNK. Markdown is tricky with streaming because a marker might span chunks (`*hello*` could arrive as `*hel` + `lo*`). Pragmatic approach: buffer until whitespace boundary, strip, emit.

- [ ] Create `gateway/src/tts/stages/markdown-stripper.ts`:

```typescript
import removeMd from "remove-markdown";
import { createLogger } from "@sentient/logging";
import type { TextStage } from "./stage-types";

const log = createLogger(["sentient.gateway.tts", "markdown-stripper"]);

/**
 * Streaming markdown stripper.
 *
 * Strategy:
 * - Accumulate input until we see a word-boundary char (whitespace or end).
 * - On boundary, strip the accumulated buffer and emit.
 * - This keeps markdown markers intact across chunk boundaries.
 *
 * Edge cases:
 * - Code fences (```...```) may span many chunks. remove-markdown handles a
 *   closed fence; an OPEN fence would emit as-is. Hermes output rarely leaves
 *   unclosed fences mid-stream; if it happens, TTS gets raw fence chars —
 *   acceptable for POC.
 * - Tables: remove-markdown collapses them to text rows. Fine for speech.
 */
export function createMarkdownStripper(): TextStage {
  return async function* stripper(input, signal) {
    let buffer = "";
    let emittedChunks = 0;

    log.debug("enter", {});
    try {
      for await (const chunk of input) {
        if (signal.aborted) break;
        buffer += chunk;

        // Find last boundary (space, tab, newline, or end of a clause).
        const lastBoundary = findLastBoundary(buffer);
        if (lastBoundary === -1) continue;

        const toStrip = buffer.slice(0, lastBoundary + 1);
        buffer = buffer.slice(lastBoundary + 1);
        const stripped = safeRemove(toStrip);
        if (stripped.length > 0) {
          emittedChunks++;
          log.debug("chunk", {
            inputLen: toStrip.length,
            outputLen: stripped.length,
          });
          yield stripped;
        }
      }
      // Flush tail
      if (buffer.length > 0 && !signal.aborted) {
        const stripped = safeRemove(buffer);
        if (stripped.length > 0) {
          emittedChunks++;
          yield stripped;
        }
      }
    } finally {
      log.debug("exit", { emittedChunks });
    }
  };
}

function findLastBoundary(s: string): number {
  for (let i = s.length - 1; i >= 0; i--) {
    const c = s[i];
    if (c === " " || c === "\n" || c === "\t" || c === "." || c === "?" || c === "!") {
      return i;
    }
  }
  return -1;
}

function safeRemove(s: string): string {
  try {
    return removeMd(s, {
      stripListLeaders: true,
      listUnicodeChar: "",
      gfm: true,
      useImgAltText: false,
    });
  } catch (err) {
    log.debug("fallback.remove-markdown-error", {
      err: err instanceof Error ? err.message : String(err),
    });
    return s; // fail open — better raw than dropped
  }
}
```

### Step 1.3.4b: Tests

- [ ] Create `gateway/src/tts/stages/markdown-stripper.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { createMarkdownStripper } from "./markdown-stripper";

async function pipe(input: string[], aborted = false): Promise<string> {
  const ctrl = new AbortController();
  if (aborted) ctrl.abort();
  const stage = createMarkdownStripper();
  const chunks: string[] = [];
  async function* gen() {
    for (const c of input) yield c;
  }
  for await (const out of stage(gen(), ctrl.signal)) chunks.push(out);
  return chunks.join("");
}

describe("MarkdownStripper", () => {
  it("strips bold and italic", async () => {
    const out = await pipe(["**hello** and *world*."]);
    expect(out).toContain("hello");
    expect(out).toContain("world");
    expect(out).not.toContain("*");
  });

  it("removes headers", async () => {
    const out = await pipe(["# Title\n\nBody text."]);
    expect(out).not.toContain("#");
    expect(out).toContain("Title");
    expect(out).toContain("Body text");
  });

  it("strips list markers", async () => {
    const out = await pipe(["- item one\n- item two\n"]);
    expect(out).not.toContain("-");
    expect(out).toContain("item one");
    expect(out).toContain("item two");
  });

  it("handles chunk boundaries mid-marker", async () => {
    // "**hello**" split across chunks
    const out = await pipe(["**hel", "lo**"]);
    expect(out).toContain("hello");
    expect(out).not.toContain("*");
  });

  it("preserves plain prose", async () => {
    const out = await pipe(["The quick brown fox jumps."]);
    expect(out.trim()).toBe("The quick brown fox jumps.");
  });

  it("returns empty on abort-before-iteration", async () => {
    const out = await pipe(["anything"], true);
    expect(out).toBe("");
  });
});
```

- [ ] Verify:

```bash
source scripts/env.sh && bun run --filter @sentient/gateway test:unit -- markdown-stripper
```

### Step 1.3.4c: Commit

```bash
git add gateway/src/tts/stages/markdown-stripper.ts gateway/src/tts/stages/markdown-stripper.test.ts
git commit -m "$(cat <<'EOF'
feat(tts): MarkdownStripper decorator stage

Streaming markdown-to-plain converter using remove-markdown. Buffers to
word boundaries to preserve markers across chunk edges. Fails open on
library errors (raw > dropped for TTS).

Co-Authored-By: <your-model-id>
EOF
)"
```

---

## Task 1.3.5 — EmojiStripper stage

**Files:**
- Create: `gateway/src/tts/stages/emoji-stripper.ts`
- Create: `gateway/src/tts/stages/emoji-stripper.test.ts`

### Step 1.3.5a: Implementation

- [ ] Create `gateway/src/tts/stages/emoji-stripper.ts`:

```typescript
import emojiRegex from "emoji-regex";
import { createLogger } from "@sentient/logging";
import type { TextStage } from "./stage-types";

const log = createLogger(["sentient.gateway.tts", "emoji-stripper"]);

/**
 * Removes all emoji (including ZWJ sequences, skin-tone modifiers, regional
 * indicator pairs, keycap sequences) from the text stream.
 *
 * Pass-through for non-emoji. No buffering required — emoji are self-contained
 * codepoint sequences and emoji-regex matches them atomically.
 */
export function createEmojiStripper(): TextStage {
  return async function* stripper(input, signal) {
    log.debug("enter", {});
    let stripped = 0;
    try {
      for await (const chunk of input) {
        if (signal.aborted) return;
        const re = emojiRegex();
        const cleaned = chunk.replace(re, () => {
          stripped++;
          return "";
        });
        if (cleaned.length > 0) yield cleaned;
      }
    } finally {
      log.debug("exit", { stripped });
    }
  };
}
```

### Step 1.3.5b: Tests

- [ ] Create `gateway/src/tts/stages/emoji-stripper.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { createEmojiStripper } from "./emoji-stripper";

async function pipe(input: string[]): Promise<string> {
  const ctrl = new AbortController();
  const stage = createEmojiStripper();
  const chunks: string[] = [];
  async function* gen() {
    for (const c of input) yield c;
  }
  for await (const out of stage(gen(), ctrl.signal)) chunks.push(out);
  return chunks.join("");
}

describe("EmojiStripper", () => {
  it("removes basic emoji", async () => {
    const out = await pipe(["Hello 😀 world"]);
    expect(out).toBe("Hello  world");
  });

  it("removes ZWJ sequences (family emoji)", async () => {
    const out = await pipe(["The family 👨‍👩‍👧 is here"]);
    expect(out).not.toContain("👨");
    expect(out).toContain("family");
  });

  it("removes flags", async () => {
    const out = await pipe(["Country 🇺🇸 flag"]);
    expect(out).not.toContain("🇺");
  });

  it("pass-through for non-emoji text", async () => {
    const out = await pipe(["No emoji here, just text."]);
    expect(out).toBe("No emoji here, just text.");
  });
});
```

### Step 1.3.5c: Commit

```bash
git add gateway/src/tts/stages/emoji-stripper.ts gateway/src/tts/stages/emoji-stripper.test.ts
git commit -m "$(cat <<'EOF'
feat(tts): EmojiStripper decorator stage

Removes emoji using emoji-regex (Unicode 16+, handles ZWJ sequences,
skin-tone modifiers, regional indicator pairs, keycap sequences).
Pass-through for non-emoji text. Zero buffering.

Co-Authored-By: <your-model-id>
EOF
)"
```

---

## Task 1.3.6 — BargeInGate stage

**Files:**
- Create: `gateway/src/tts/stages/barge-in-gate.ts`
- Create: `gateway/src/tts/stages/barge-in-gate.test.ts`

### Step 1.3.6a: Implementation

The gate drops text-delta chunks from the TTS chain when `bargedIn()` returns true — BUT the ConversationMirror still sees them upstream (that happens in `hermes-event-translator`). This gate is the last decision point before audio.

- [ ] Create `gateway/src/tts/stages/barge-in-gate.ts`:

```typescript
import { createLogger } from "@sentient/logging";
import type { TextStage } from "./stage-types";

const log = createLogger(["sentient.gateway.tts", "barge-in-gate"]);

export interface BargeInGateControls {
  bargedIn(): boolean;
}

/**
 * If bargedIn() is true when a chunk arrives, drop it (do not yield).
 * Otherwise pass through. Logs transitions and per-drop stats.
 */
export function createBargeInGate(controls: BargeInGateControls): TextStage {
  return async function* gate(input, signal) {
    let dropped = 0;
    let passed = 0;
    let wasBargedIn = false;

    log.debug("enter", {});
    try {
      for await (const chunk of input) {
        if (signal.aborted) return;
        const b = controls.bargedIn();
        if (b !== wasBargedIn) {
          log.debug("state.transition", { bargedIn: b });
          wasBargedIn = b;
        }
        if (b) {
          dropped++;
          continue;
        }
        passed++;
        yield chunk;
      }
    } finally {
      log.debug("exit", { dropped, passed });
    }
  };
}
```

### Step 1.3.6b: Tests

- [ ] Create `gateway/src/tts/stages/barge-in-gate.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { createBargeInGate } from "./barge-in-gate";

async function pipe(
  chunks: string[],
  bargedInWhen: (index: number) => boolean,
): Promise<string> {
  const ctrl = new AbortController();
  let i = 0;
  const gate = createBargeInGate({ bargedIn: () => bargedInWhen(i) });
  async function* gen() {
    for (const c of chunks) {
      yield c;
      i++;
    }
  }
  const out: string[] = [];
  for await (const chunk of gate(gen(), ctrl.signal)) out.push(chunk);
  return out.join("");
}

describe("BargeInGate", () => {
  it("passes through when never barged in", async () => {
    const out = await pipe(["hi ", "there"], () => false);
    expect(out).toBe("hi there");
  });

  it("drops chunks when barged in", async () => {
    const out = await pipe(["hi ", "there", "!"], () => true);
    expect(out).toBe("");
  });

  it("partial drop — barges in mid-stream", async () => {
    const out = await pipe(["first ", "second ", "third"], (i) => i >= 1);
    expect(out).toBe("first ");
  });
});
```

### Step 1.3.6c: Commit

```bash
git add gateway/src/tts/stages/barge-in-gate.ts gateway/src/tts/stages/barge-in-gate.test.ts
git commit -m "$(cat <<'EOF'
feat(tts): BargeInGate decorator stage

Last gate before audio synthesis. Drops text chunks when bargedIn() is
true. Logs transition + drop/pass counts. Zero buffering, zero state
beyond the caller's bargedIn callback.

Co-Authored-By: <your-model-id>
EOF
)"
```

---

## Task 1.3.7 — Pipeline orchestrator: `TextToSpeechPipeline`

**Files:**
- Create: `gateway/src/tts/pipeline.ts`
- Create: `gateway/src/tts/pipeline.test.ts`

### Step 1.3.7a: Orchestrator

Ties everything together. Takes an `AsyncIterable<string>` (the Hermes `text.delta` stream), runs it through the decorator chain, feeds the result into the existing `UtteranceAggregator` → `EmotionTagger` → `FishAudioSynthesizer`, and emits audio frames via the existing `ConnectorSink`.

- [ ] Create `gateway/src/tts/pipeline.ts`:

```typescript
import { createLogger } from "@sentient/logging";
import { createMarkdownStripper } from "./stages/markdown-stripper";
import { createEmojiStripper } from "./stages/emoji-stripper";
import { createBargeInGate, type BargeInGateControls } from "./stages/barge-in-gate";
import { composeTextStages } from "./stages/stage-types";
// Adjust imports to your repo's ACTUAL module structure for aggregator/tagger/synth:
import { createUtteranceAggregator } from "./stages/utterance-aggregator";
import { createEmotionTagger, type EmotionTaggerDeps } from "./stages/emotion-tagger";
import type { ConnectorSink } from "../session-handlers/session-audio-wire";
import type { TextStreamSynthesizer } from "./fish-audio-synthesizer";

const log = createLogger(["sentient.gateway.tts", "pipeline"]);

export interface TextToSpeechPipelineDeps {
  synthesizer: TextStreamSynthesizer;
  sink: ConnectorSink;
  emotionTaggerDeps: EmotionTaggerDeps;
  maxBlockChars: number;
  markdownStripping: boolean;
  emojiStripping: boolean;
}

export interface TextToSpeechPipelineControls extends BargeInGateControls {
  // extend if needed later
}

export interface TextToSpeechPipelineRun {
  /** Awaits final completion; resolves when ConnectorSink emits audio.done. */
  done: Promise<void>;
  /** Cancels and drains the pipeline. */
  cancel(): void;
}

/**
 * Spawn a pipeline run fed by `textDeltas`. Returns a handle that resolves
 * when audio playback finishes (or cancel() is called).
 *
 * Safe to call concurrently for different cycles (no shared mutable state
 * between runs), but CALLER is responsible for serializing by cycle so
 * audio doesn't overlap.
 */
export function runTextToSpeechPipeline(
  textDeltas: AsyncIterable<string>,
  controls: TextToSpeechPipelineControls,
  deps: TextToSpeechPipelineDeps,
  cycleId: string,
  taskId: string,
): TextToSpeechPipelineRun {
  const ctrl = new AbortController();
  log.debug("run.start", { cycleId, taskId });

  const stages = [];
  stages.push(createBargeInGate(controls));
  if (deps.markdownStripping) stages.push(createMarkdownStripper());
  if (deps.emojiStripping) stages.push(createEmojiStripper());
  const stripChain = composeTextStages(...stages);

  const text = stripChain(textDeltas, ctrl.signal);

  const aggregator = createUtteranceAggregator({ maxBlockChars: deps.maxBlockChars });
  const blocks = aggregator(text, ctrl.signal);

  const tagger = createEmotionTagger(deps.emotionTaggerDeps);
  const tagged = tagger(blocks, ctrl.signal);

  // Synthesizer returns AsyncGenerator of audio frames
  const frames = deps.synthesizer.synthesize(tagged, ctrl.signal);

  const done = (async () => {
    await deps.sink.start({ cycleId, taskId });
    try {
      for await (const frame of frames) {
        if (ctrl.signal.aborted) break;
        await deps.sink.frame(frame);
      }
    } finally {
      await deps.sink.done({ cycleId, taskId });
      log.debug("run.end", { cycleId, taskId, aborted: ctrl.signal.aborted });
    }
  })();

  return {
    done,
    cancel: () => {
      if (!ctrl.signal.aborted) {
        log.debug("run.cancel", { cycleId, taskId });
        ctrl.abort();
      }
    },
  };
}
```

**Adjust the imports** for `createUtteranceAggregator`, `createEmotionTagger`, `TextStreamSynthesizer`, and `ConnectorSink` to match the actual signatures in your repo. The interface principles:
- `createUtteranceAggregator` returns a `TextStage`.
- `createEmotionTagger` returns a `TextStage` (may need to be adapted — emotion tagger might return enriched blocks, not plain text).
- `TextStreamSynthesizer.synthesize(textStream, signal)` yields audio frames.
- `ConnectorSink.start/frame/done` sends wire messages.

If any existing signature doesn't match, write a thin adapter inside `pipeline.ts` rather than rewriting upstream code.

### Step 1.3.7b: Smoke test (contract, not full integration)

- [ ] Create `gateway/src/tts/pipeline.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { runTextToSpeechPipeline } from "./pipeline";

// Stub implementations matching the shape. Adapt types to actual definitions.
const fakeSynth = {
  async *synthesize(input: AsyncIterable<unknown>, signal: AbortSignal) {
    for await (const _ of input) {
      if (signal.aborted) return;
      yield new Uint8Array([1, 2, 3]);
    }
  },
};

function makeFakeSink() {
  const calls: string[] = [];
  return {
    calls,
    async start(_: { cycleId: string; taskId: string }) {
      calls.push("start");
    },
    async frame(_: Uint8Array) {
      calls.push("frame");
    },
    async done(_: { cycleId: string; taskId: string }) {
      calls.push("done");
    },
  };
}

describe("TextToSpeechPipeline", () => {
  it("processes plain text through to audio frames", async () => {
    const sink = makeFakeSink();
    async function* input() {
      yield "Hello world.";
    }
    // NOTE: this test uses the REAL markdown/emoji/barge stages but fake
    // aggregator/tagger/synth. Adjust EmotionTaggerDeps stub as needed.
    const run = runTextToSpeechPipeline(
      input(),
      { bargedIn: () => false },
      {
        synthesizer: fakeSynth as never, // cast to TextStreamSynthesizer if needed
        sink: sink as never,
        emotionTaggerDeps: { /* fill with stubs that match actual shape */ } as never,
        maxBlockChars: 600,
        markdownStripping: true,
        emojiStripping: true,
      },
      "c1",
      "t1",
    );
    await run.done;
    expect(sink.calls).toContain("start");
    expect(sink.calls).toContain("done");
  });
});
```

> **Smaller-model guidance:** this test is a SCAFFOLD. The real emotionTaggerDeps will have a defined shape from Task 1.3.2 (moving the existing emotion-tagger). Replace `{ /* stubs */ } as never` with a real stub once you see the actual type. If the test is hard to write because the existing emotion-tagger tangles with other code, fix in place or split the tagger into a leaner interface — but do not skip the test.

### Step 1.3.7c: Verify + commit

- [ ] `source scripts/env.sh && bun run --filter @sentient/gateway test:unit -- tts`
- [ ] Commit:

```bash
git add gateway/src/tts/pipeline.ts gateway/src/tts/pipeline.test.ts
git commit -m "$(cat <<'EOF'
feat(tts): TextToSpeechPipeline orchestrator

Wires the decorator chain: BargeInGate → MarkdownStripper → EmojiStripper →
UtteranceAggregator → EmotionTagger → FishAudioSynthesizer → ConnectorSink.
Returns a pipeline-run handle with done promise + cancel(). Feature flags
on markdown/emoji stripping from config.

Co-Authored-By: <your-model-id>
EOF
)"
```

---

## Task 1.3.8 — Wire to the HermesClient event stream (adapter)

**Files:**
- Create: `gateway/src/cerebrum/text-delta-broadcaster.ts`
- Create: `gateway/src/cerebrum/text-delta-broadcaster.test.ts`

### Step 1.3.8a: Why a broadcaster

`HermesEventTranslator` emits wire messages + mutates mirrors. But ALSO the TTS pipeline wants to consume the `text.delta` stream IN PARALLEL. A tiny broadcaster lets us fork the event stream.

- [ ] Create `gateway/src/cerebrum/text-delta-broadcaster.ts`:

```typescript
import { createLogger } from "@sentient/logging";
import type { HermesEvent } from "./hermes-event-types";

const log = createLogger(["sentient.gateway.cerebrum", "text-delta-broadcaster"]);

/**
 * Fork a HermesEvent stream into two consumers:
 * (1) translator: sees ALL events.
 * (2) textDeltas: sees only text.delta events as strings.
 *
 * Both consumers are driven by ONE upstream iteration. We yield the pure text
 * deltas on a dedicated queue so the TTS pipeline can run concurrently with
 * the translator.
 */
export function forkTextDeltas(
  source: AsyncIterable<HermesEvent>,
): {
  translatorEvents: AsyncGenerator<HermesEvent>;
  textDeltas: AsyncGenerator<string>;
} {
  // Implement a buffered T-junction. Using two queues + a pump.
  type Queue<T> = { items: T[]; resolvers: ((v: IteratorResult<T>) => void)[]; done: boolean };
  function makeQueue<T>(): Queue<T> {
    return { items: [], resolvers: [], done: false };
  }
  const eventsQ = makeQueue<HermesEvent>();
  const textQ = makeQueue<string>();

  function push<T>(q: Queue<T>, v: T) {
    const r = q.resolvers.shift();
    if (r) r({ value: v, done: false });
    else q.items.push(v);
  }
  function end<T>(q: Queue<T>) {
    q.done = true;
    while (q.resolvers.length > 0) {
      q.resolvers.shift()!({ value: undefined as unknown as T, done: true });
    }
  }
  function pull<T>(q: Queue<T>): Promise<IteratorResult<T>> {
    if (q.items.length > 0) {
      return Promise.resolve({ value: q.items.shift()!, done: false });
    }
    if (q.done) return Promise.resolve({ value: undefined as unknown as T, done: true });
    return new Promise<IteratorResult<T>>((res) => q.resolvers.push(res));
  }

  (async () => {
    try {
      for await (const ev of source) {
        push(eventsQ, ev);
        if (ev.type === "text.delta") push(textQ, ev.delta);
      }
    } catch (err) {
      log.debug("pump.error", {
        err: err instanceof Error ? err.message : String(err),
      });
    } finally {
      end(eventsQ);
      end(textQ);
    }
  })();

  const translatorEvents = (async function* () {
    while (true) {
      const r = await pull(eventsQ);
      if (r.done) return;
      yield r.value;
    }
  })();
  const textDeltas = (async function* () {
    while (true) {
      const r = await pull(textQ);
      if (r.done) return;
      yield r.value;
    }
  })();

  return { translatorEvents, textDeltas };
}
```

### Step 1.3.8b: Test

- [ ] Create `gateway/src/cerebrum/text-delta-broadcaster.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { forkTextDeltas } from "./text-delta-broadcaster";
import type { HermesEvent } from "./hermes-event-types";

async function* source(events: HermesEvent[]): AsyncGenerator<HermesEvent> {
  for (const e of events) yield e;
}

describe("forkTextDeltas", () => {
  it("splits events into two streams — all events + text deltas only", async () => {
    const events: HermesEvent[] = [
      { type: "created", responseId: "r", conversationId: "c" },
      { type: "text.delta", delta: "hi " },
      { type: "tool.started", callId: "t", toolName: "search", argsPreview: "" },
      { type: "text.delta", delta: "there" },
      { type: "completed", usage: { inputTokens: 1, outputTokens: 2 } },
    ];
    const { translatorEvents, textDeltas } = forkTextDeltas(source(events));

    const allEvents: HermesEvent[] = [];
    const allText: string[] = [];
    await Promise.all([
      (async () => {
        for await (const e of translatorEvents) allEvents.push(e);
      })(),
      (async () => {
        for await (const t of textDeltas) allText.push(t);
      })(),
    ]);

    expect(allEvents).toHaveLength(5);
    expect(allText).toEqual(["hi ", "there"]);
  });
});
```

- [ ] Verify:

```bash
source scripts/env.sh && bun run --filter @sentient/gateway test:unit -- text-delta-broadcaster
```

### Step 1.3.8c: Update `hermes-dispatcher.ts` to use the broadcaster

- [ ] Open `gateway/src/cerebrum/hermes-dispatcher.ts`. Add an optional TTS pipeline hook:

```typescript
// Add to HermesDispatcherDeps
export interface HermesDispatcherDeps {
  clientFor(binding: HermesProfileBinding): HermesClient;
  mirror: ConversationMirror;
  tasks: TaskMirror;
  emit: WireEmitter;
  /** Phase 1.3+ — optional TTS pipeline starter. */
  startTts?: (deltas: AsyncIterable<string>, cycleId: string) => { done: Promise<void>; cancel: () => void };
}
```

- [ ] In `dispatchHermesCycle`, wrap the event stream with the broadcaster:

```typescript
import { forkTextDeltas } from "./text-delta-broadcaster";
// ...

const rawEvents = client.dispatch({ /* ... */ }, req.signal, req.mode);

const { translatorEvents, textDeltas } = forkTextDeltas(rawEvents);

const ttsRun = deps.startTts?.(textDeltas, req.cycleId);
// If no startTts hook, drain textDeltas to avoid blocking the broadcaster queue
if (!deps.startTts) {
  (async () => {
    for await (const _ of textDeltas) {
      // discard
    }
  })();
}

await translateHermesStream(translatorEvents, { ... }, deps.mirror, deps.tasks, deps.emit, ...);

if (ttsRun) {
  try {
    await ttsRun.done;
  } catch (err) {
    log.debug("tts.done.error", { err: err instanceof Error ? err.message : String(err) });
  }
}
```

- [ ] Update the existing tests in `hermes-dispatcher.test.ts` to cover the new optional `startTts` hook path.

### Step 1.3.8d: Verify + commit

- [ ] `source scripts/env.sh && bun run --filter @sentient/gateway test:unit -- hermes-dispatcher text-delta-broadcaster`
- [ ] Commit:

```bash
git add gateway/src/cerebrum/text-delta-broadcaster.ts gateway/src/cerebrum/text-delta-broadcaster.test.ts gateway/src/cerebrum/hermes-dispatcher.ts gateway/src/cerebrum/hermes-dispatcher.test.ts
git commit -m "$(cat <<'EOF'
feat(cerebrum): fork text.delta events for parallel translator + TTS

Broadcaster splits HermesEvent stream into (a) all events for translator
(wire + mirrors) and (b) text-delta-only strings for TTS pipeline. Both
run concurrently off ONE upstream iteration. Dispatcher takes an optional
startTts hook; omitting it still drains the text queue.

Co-Authored-By: <your-model-id>
EOF
)"
```

---

## Task 1.3.9 — Quality gate

- [ ] Full CI:

```bash
source scripts/env.sh && bun run ci
```

Expected: green. The new TTS-chain code compiles, unit tests pass, existing tests unaffected.

- [ ] Commit log check:

```bash
git log --oneline develop..HEAD
```

---

## Done

Phase 1.3 complete when:

- [ ] Deps added: `remove-markdown`, `emoji-regex`.
- [ ] Existing `utterance-aggregator` + `emotion-tagger` moved to `gateway/src/tts/stages/`. Imports fixed. Emotion-tagger prompt simplified.
- [ ] New stages: `markdown-stripper`, `emoji-stripper`, `barge-in-gate`, each with tests.
- [ ] Pipeline orchestrator: `gateway/src/tts/pipeline.ts`.
- [ ] Event broadcaster: `text-delta-broadcaster.ts`.
- [ ] HermesDispatcher takes optional `startTts` hook.
- [ ] `bun run ci` green.

**Proceed to** `2026-04-21-hermes-phase1.4-gateway-mcp.md` to build the gateway-hosted MCP server that Hermes calls for `identify_user`, `pause_audio`, etc.
