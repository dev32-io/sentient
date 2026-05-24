# Streaming Typewriter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the assistant chat bubble feel smooth and human-paced by revealing streamed LLM text via a `requestAnimationFrame` loop whose rate adapts to buffer depth, with optional sentence/paragraph micro-pauses.

**Architecture:** A new `useTypewriterBuffer` Preact hook in `gateway/webui/src/hooks/` decouples the raw streamed buffer from the `visible` substring rendered into the inflight assistant bubble. `useVoiceClient` feeds the hook with each `InFlightMessage` update and overrides the bubble's text via a new `visibleOverride` parameter on `deriveMessages`. Inflight bubble also appears at cycle start (not just on first delta) with a three-dot pulse while text is empty. No protocol or gateway changes.

**Tech Stack:** Preact + TypeScript, `@preact/signals` for reactive state, Vitest + `@testing-library/preact` for tests, `vi.useFakeTimers()` + monkey-patched `requestAnimationFrame` + `performance.now()` for deterministic rAF tests.

**Source spec:** `docs/superpowers/specs/2026-04-20-streaming-typewriter-design.md`

**Conventions & rules (pre-read mandatory):**
- `.claude/rules/clean-code.md` — 300-line file cap, 40-line function cap, no magic numbers, named constants.
- `.claude/rules/testing.md` — tests beside source (`foo.ts` + `foo.test.ts`), 80% statement coverage, sad paths harder than happy paths.
- `.claude/rules/typescript.md` — strict mode, one behavior per `it()`, name `it('returns X when Y')`.
- `gateway/.claude/rules/logging.md` — every new file uses `createLogger([...tags])`; log buffer sizes, state changes, decisions.
- `gateway/webui/src/hooks/use-follow-latest.test.ts` — reference for `renderHook` + `act` patterns.
- `gateway/webui/src/hooks/awaiting-tracker.test.ts` — reference for `vi.useFakeTimers()` patterns.

**Shell bootstrap:** every command assumes `source scripts/env.sh` has been run in the shell. Re-source if a new shell is opened.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `gateway/webui/src/config/typewriter.ts` | **new** | Tunables for Phase 1 (rates, gap-gain) and Phase 2 (sentence/paragraph pauses). Pure data module. |
| `gateway/webui/src/config/typewriter.test.ts` | **new** | Asserts tunable shape and sane default ranges. |
| `gateway/webui/src/hooks/use-typewriter-buffer.ts` | **new** | The hook. Maintains buffer + visible, runs rAF loop with adaptive rate + sentence/paragraph pauses, exposes `{ visible, setBuffer, markComplete, reset }`. |
| `gateway/webui/src/hooks/use-typewriter-buffer.test.ts` | **new** | Unit tests with mocked `requestAnimationFrame` + `performance.now()`. |
| `gateway/webui/src/hooks/cycle-helpers.ts` | **modify** | `appendInflightMessage` no longer skips when text is empty; accepts optional `visibleOverride` to render typewriter substring instead of raw buffer text. `deriveMessages` forwards the override. |
| `gateway/webui/src/hooks/cycle-helpers.test.ts` | **modify** | Cover empty-text placeholder bubble and `visibleOverride`. |
| `gateway/webui/src/hooks/use-voice-client.ts` | **modify** | Instantiate `useTypewriterBuffer`; on `cycle.started` call `reset()`; on `inflight.onUpdate` call `setBuffer(text)` (non-null) or `markComplete()` (null); pass `visibleOverride` into `deriveMessages`. |
| `gateway/webui/src/components/chat/bubble-text.tsx` | **modify** | Render a three-dot pulse when `text === ""` and `isStreaming === true`. |
| `gateway/webui/src/components/chat/bubble-text.test.tsx` | **modify** | Add test: pulse dots render when empty + streaming; disappear once text arrives. |
| `gateway/webui/src/styles/components.css` | **modify** | Add `.bubble-text__pulse` 3-dot keyframe animation. |

---

## Task 1: Tunables config file

**Files:**
- Create: `gateway/webui/src/config/typewriter.ts`
- Create: `gateway/webui/src/config/typewriter.test.ts`

- [ ] **Step 1.1: Create the config directory and write failing test**

File: `gateway/webui/src/config/typewriter.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { TYPEWRITER } from "./typewriter.ts";

describe("TYPEWRITER config", () => {
  it("defines Phase 1 rate tunables with sane bounds", () => {
    expect(TYPEWRITER.baseRate).toBeGreaterThan(TYPEWRITER.minRate);
    expect(TYPEWRITER.maxRate).toBeGreaterThan(TYPEWRITER.baseRate);
    expect(TYPEWRITER.gapGain).toBeGreaterThan(0);
  });

  it("defines Phase 2 pause tunables in milliseconds", () => {
    expect(TYPEWRITER.sentencePauseMs).toBeGreaterThanOrEqual(0);
    expect(TYPEWRITER.paragraphPauseMs).toBeGreaterThanOrEqual(TYPEWRITER.sentencePauseMs);
  });
});
```

- [ ] **Step 1.2: Run test to verify failure**

Run:
```bash
cd gateway/webui && bun run test src/config/typewriter.test.ts
```
Expected: FAIL — `Cannot find module './typewriter.ts'`.

- [ ] **Step 1.3: Create the config module**

File: `gateway/webui/src/config/typewriter.ts`

```ts
/**
 * Typewriter reveal tunables. All four rate values are user-perceptual and
 * should be tuned from observed UX, not code review. Pauses are millisecond
 * holds at sentence/paragraph boundaries.
 *
 * See docs/superpowers/specs/2026-04-20-streaming-typewriter-design.md.
 */
export const TYPEWRITER = {
  /** chars/sec at steady state — comfortable reading. */
  baseRate: 80,
  /** Floor — never reveal slower than this. */
  minRate: 30,
  /** Ceiling — burst rate when buffer is ahead or draining after complete. */
  maxRate: 400,
  /** Each char of buffer-gap adds this fraction to the base rate. 0.02 = +2%/char. */
  gapGain: 0.02,
  /** Hold duration (ms) after a sentence-ending character (`.`, `!`, `?`) followed by whitespace. */
  sentencePauseMs: 60,
  /** Hold duration (ms) after a paragraph break (`\n\n`). */
  paragraphPauseMs: 160,
} as const;

export type TypewriterConfig = typeof TYPEWRITER;
```

- [ ] **Step 1.4: Run test to verify pass**

Run:
```bash
cd gateway/webui && bun run test src/config/typewriter.test.ts
```
Expected: PASS — 2 tests pass.

- [ ] **Step 1.5: Commit**

```bash
git add gateway/webui/src/config/typewriter.ts gateway/webui/src/config/typewriter.test.ts
git commit -m "feat(webui): add typewriter tunables config"
```

---

## Task 2: useTypewriterBuffer — core reveal loop (Phase 1)

**Files:**
- Create: `gateway/webui/src/hooks/use-typewriter-buffer.ts`
- Create: `gateway/webui/src/hooks/use-typewriter-buffer.test.ts`

**Hook contract:**

```ts
interface UseTypewriterBufferResult {
  visible: Signal<string>;       // reactive substring to render
  setBuffer: (text: string) => void;  // caller feeds full accumulated text (append-only)
  markComplete: () => void;      // stream ended — drain at MAX_RATE
  reset: () => void;             // new cycle — clear state
}
```

Buffer is append-only: `setBuffer(text)` ignores any call where `text.length < bufferRef.current.length`.

- [ ] **Step 2.1: Create rAF test helper + first failing test**

File: `gateway/webui/src/hooks/use-typewriter-buffer.test.ts`

```ts
import { act, renderHook } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTypewriterBuffer } from "./use-typewriter-buffer.ts";

// ---------------------------------------------------------------------------
// Fake rAF harness — drives requestAnimationFrame at a chosen dt per tick so
// the loop's char-advance math is fully deterministic. performance.now() is
// advanced in lockstep so dt computations match.
// ---------------------------------------------------------------------------

interface RafHandle {
  id: number;
  cb: FrameRequestCallback;
}

let rafQueue: RafHandle[] = [];
let rafSeq = 0;
let mockNow = 0;
let originalRaf: typeof globalThis.requestAnimationFrame;
let originalCaf: typeof globalThis.cancelAnimationFrame;
let originalPerfNow: typeof performance.now;

function installRaf(): void {
  rafQueue = [];
  rafSeq = 0;
  mockNow = 0;
  originalRaf = globalThis.requestAnimationFrame;
  originalCaf = globalThis.cancelAnimationFrame;
  originalPerfNow = performance.now.bind(performance);
  globalThis.requestAnimationFrame = (cb: FrameRequestCallback): number => {
    rafSeq += 1;
    rafQueue.push({ id: rafSeq, cb });
    return rafSeq;
  };
  globalThis.cancelAnimationFrame = (id: number): void => {
    rafQueue = rafQueue.filter((h) => h.id !== id);
  };
  (performance as unknown as { now: () => number }).now = () => mockNow;
}

function restoreRaf(): void {
  globalThis.requestAnimationFrame = originalRaf;
  globalThis.cancelAnimationFrame = originalCaf;
  (performance as unknown as { now: () => number }).now = originalPerfNow;
}

/** Flush all rAF callbacks currently queued, advancing mockNow by `dtMs` first. */
function flushFrame(dtMs: number): void {
  mockNow += dtMs;
  const drained = rafQueue;
  rafQueue = [];
  for (const { cb } of drained) cb(mockNow);
}

/** Advance N frames at a fixed dt. */
function runFrames(count: number, dtMs: number): void {
  for (let i = 0; i < count; i++) flushFrame(dtMs);
}

beforeEach(() => {
  installRaf();
});

afterEach(() => {
  restoreRaf();
});

describe("useTypewriterBuffer — initial state", () => {
  it("returns empty visible string before any buffer is set", () => {
    const { result } = renderHook(() => useTypewriterBuffer());
    expect(result.current.visible.value).toBe("");
  });
});
```

- [ ] **Step 2.2: Run test to verify failure**

Run:
```bash
cd gateway/webui && bun run test src/hooks/use-typewriter-buffer.test.ts
```
Expected: FAIL — `Cannot find module './use-typewriter-buffer.ts'`.

- [ ] **Step 2.3: Write minimal hook skeleton**

File: `gateway/webui/src/hooks/use-typewriter-buffer.ts`

```ts
import { type Signal, useSignal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import { createLogger } from "@sentient/web-sdk";
import { TYPEWRITER } from "../config/typewriter.ts";

const log = createLogger(["sentient", "webui", "typewriter"]);

export interface UseTypewriterBufferResult {
  readonly visible: Signal<string>;
  setBuffer: (text: string) => void;
  markComplete: () => void;
  reset: () => void;
}

export function useTypewriterBuffer(): UseTypewriterBufferResult {
  const visible = useSignal("");
  const bufferRef = useRef("");
  const visiblePosRef = useRef(0);
  const streamCompleteRef = useRef(false);
  const lastTickTsRef = useRef(0);
  const pauseUntilRef = useRef(0);
  const rafIdRef = useRef<number | null>(null);

  function cancelScheduled(): void {
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
  }

  function schedule(): void {
    if (rafIdRef.current !== null) return;
    rafIdRef.current = requestAnimationFrame(tick);
  }

  function tick(now: number): void {
    rafIdRef.current = null;

    // Catch-up path: visible has reached buffer end.
    if (visiblePosRef.current >= bufferRef.current.length) {
      if (streamCompleteRef.current) {
        lastTickTsRef.current = 0;
        log.debug("tick-drain-complete", { final: bufferRef.current.length });
        return;
      }
      // Stream still live — keep loop alive cheaply.
      lastTickTsRef.current = now;
      schedule();
      return;
    }

    // Pause gate (Phase 2).
    if (now < pauseUntilRef.current) {
      lastTickTsRef.current = now;
      schedule();
      return;
    }

    if (lastTickTsRef.current === 0) lastTickTsRef.current = now;
    const dt = (now - lastTickTsRef.current) / 1000;
    lastTickTsRef.current = now;

    const gap = bufferRef.current.length - visiblePosRef.current;
    const rawRate = streamCompleteRef.current
      ? TYPEWRITER.maxRate
      : TYPEWRITER.baseRate * (1 + gap * TYPEWRITER.gapGain);
    const rate = Math.max(TYPEWRITER.minRate, Math.min(TYPEWRITER.maxRate, rawRate));

    const advance = Math.max(1, Math.floor(rate * dt));
    visiblePosRef.current = Math.min(
      bufferRef.current.length,
      visiblePosRef.current + advance,
    );
    visible.value = bufferRef.current.slice(0, visiblePosRef.current);

    schedule();
  }

  function setBuffer(text: string): void {
    if (text.length <= bufferRef.current.length) {
      // Never shrink. Shorter text on the same cycle is a caller bug — log and ignore.
      if (text.length < bufferRef.current.length) {
        log.warn("setBuffer-shrink-ignored", {
          reason: "buffer-append-only",
          prev: bufferRef.current.length,
          next: text.length,
        });
      }
      return;
    }
    bufferRef.current = text;
    log.debug("setBuffer", { bufferLen: text.length, visiblePos: visiblePosRef.current });
    schedule();
  }

  function markComplete(): void {
    if (streamCompleteRef.current) return;
    streamCompleteRef.current = true;
    log.debug("markComplete", { bufferLen: bufferRef.current.length, visiblePos: visiblePosRef.current });
    schedule();
  }

  function reset(): void {
    cancelScheduled();
    bufferRef.current = "";
    visiblePosRef.current = 0;
    streamCompleteRef.current = false;
    lastTickTsRef.current = 0;
    pauseUntilRef.current = 0;
    visible.value = "";
    log.debug("reset", {});
  }

  useEffect(() => {
    return () => {
      cancelScheduled();
    };
  }, []);

  return { visible, setBuffer, markComplete, reset };
}
```

- [ ] **Step 2.4: Run test to verify pass**

Run:
```bash
cd gateway/webui && bun run test src/hooks/use-typewriter-buffer.test.ts
```
Expected: PASS — 1 test passes.

- [ ] **Step 2.5: Add reveal-on-set-buffer test**

Append to `gateway/webui/src/hooks/use-typewriter-buffer.test.ts` (inside the same file, as a new `describe` block):

```ts
describe("useTypewriterBuffer — reveal at base rate", () => {
  it("reveals at least one character on the first frame after setBuffer", () => {
    const { result } = renderHook(() => useTypewriterBuffer());
    act(() => {
      result.current.setBuffer("Hello world");
    });
    // First frame: dt is 0 (lastTickTs initialized to `now`), so advance = max(1, 0).
    // Bootstrap behavior must reveal at least one character to avoid dead frames.
    flushFrame(16);
    expect(result.current.visible.value.length).toBeGreaterThanOrEqual(1);
  });

  it("reveals ~80 chars per second at base rate when buffer matches steady reveal", () => {
    const { result } = renderHook(() => useTypewriterBuffer());
    const TEXT = "x".repeat(200);
    act(() => {
      result.current.setBuffer(TEXT);
    });
    // Run 60 frames of 16ms each → ~960ms. At base rate (gap-modulated by
    // decreasing buffer-gap) we expect ~80 chars/sec average for a small gap.
    // Tolerance wide because adaptive rate accelerates when far behind.
    runFrames(60, 16);
    expect(result.current.visible.value.length).toBeGreaterThanOrEqual(60);
    expect(result.current.visible.value.length).toBeLessThanOrEqual(200);
  });
});
```

- [ ] **Step 2.6: Run tests to verify pass**

Run:
```bash
cd gateway/webui && bun run test src/hooks/use-typewriter-buffer.test.ts
```
Expected: PASS — 3 tests pass.

- [ ] **Step 2.7: Add gap-gain acceleration test**

Append to the test file:

```ts
describe("useTypewriterBuffer — gap-gain acceleration", () => {
  it("reveals faster when buffer is far ahead of visible cursor", () => {
    const { result } = renderHook(() => useTypewriterBuffer());
    const BIG = "a".repeat(500);
    act(() => {
      result.current.setBuffer(BIG);
    });
    // With gap=500 and gapGain=0.02, rate ≈ baseRate * (1 + 10) = 880 chars/sec
    // clamped to maxRate=400. One 100ms frame → 40 chars.
    flushFrame(100);
    expect(result.current.visible.value.length).toBeGreaterThanOrEqual(30);
  });

  it("reveals slower when buffer is only slightly ahead of visible cursor", () => {
    const { result } = renderHook(() => useTypewriterBuffer());
    act(() => {
      result.current.setBuffer("abcdefghij");
    });
    // Small 10-char buffer: rate ≈ 80 * (1 + 0.2) = 96 chars/sec.
    // One 100ms frame → ~9-10 chars. Assert <= maxRate * 0.1 + margin.
    flushFrame(100);
    expect(result.current.visible.value.length).toBeLessThanOrEqual(15);
  });
});
```

- [ ] **Step 2.8: Run tests to verify pass**

Run:
```bash
cd gateway/webui && bun run test src/hooks/use-typewriter-buffer.test.ts
```
Expected: PASS — 5 tests pass.

- [ ] **Step 2.9: Commit**

```bash
git add gateway/webui/src/hooks/use-typewriter-buffer.ts gateway/webui/src/hooks/use-typewriter-buffer.test.ts
git commit -m "feat(webui): add useTypewriterBuffer hook with adaptive reveal rate"
```

---

## Task 3: markComplete drain + stream-live idle + reset

The core loop already has the logic; this task adds explicit test coverage to lock it in and catches edge cases.

**Files:**
- Modify: `gateway/webui/src/hooks/use-typewriter-buffer.test.ts`

- [ ] **Step 3.1: Add drain-on-complete test**

Append:

```ts
describe("useTypewriterBuffer — markComplete drain", () => {
  it("drains remaining buffer at MAX_RATE once markComplete is called", () => {
    const { result } = renderHook(() => useTypewriterBuffer());
    act(() => {
      result.current.setBuffer("abcdefghij"); // 10 chars
    });
    // Reveal a bit first.
    flushFrame(16);
    const afterFirstLen = result.current.visible.value.length;
    expect(afterFirstLen).toBeGreaterThanOrEqual(1);

    act(() => {
      result.current.markComplete();
    });
    // At maxRate=400 chars/sec, one 100ms frame = 40 chars, draining any short buffer.
    flushFrame(100);
    expect(result.current.visible.value).toBe("abcdefghij");
  });

  it("stops scheduling rAF after drain is complete", () => {
    const { result } = renderHook(() => useTypewriterBuffer());
    act(() => {
      result.current.setBuffer("hi");
      result.current.markComplete();
    });
    flushFrame(100); // drain
    expect(result.current.visible.value).toBe("hi");
    // Queue must be empty: no further rAF scheduled after final drain.
    flushFrame(16);
    expect(result.current.visible.value).toBe("hi");
  });
});

describe("useTypewriterBuffer — stream-live idle", () => {
  it("holds visible at buffer end when caught up and stream not complete", () => {
    const { result } = renderHook(() => useTypewriterBuffer());
    act(() => {
      result.current.setBuffer("ab"); // tiny buffer
    });
    // Give the loop several frames to fully reveal "ab".
    runFrames(10, 16);
    expect(result.current.visible.value).toBe("ab");
    // Further frames must not change visible (or throw).
    runFrames(10, 16);
    expect(result.current.visible.value).toBe("ab");
  });
});

describe("useTypewriterBuffer — reset", () => {
  it("clears buffer and visible on reset", () => {
    const { result } = renderHook(() => useTypewriterBuffer());
    act(() => {
      result.current.setBuffer("something");
    });
    flushFrame(16);
    expect(result.current.visible.value.length).toBeGreaterThan(0);
    act(() => {
      result.current.reset();
    });
    expect(result.current.visible.value).toBe("");
    // After reset, a new buffer reveal restarts from 0.
    act(() => {
      result.current.setBuffer("new");
    });
    flushFrame(16);
    expect(result.current.visible.value.length).toBeGreaterThanOrEqual(1);
    expect(result.current.visible.value.startsWith("n")).toBe(true);
  });

  it("ignores buffer shrink (append-only contract)", () => {
    const { result } = renderHook(() => useTypewriterBuffer());
    act(() => {
      result.current.setBuffer("abcdefghij");
    });
    flushFrame(100);
    const len = result.current.visible.value.length;
    act(() => {
      result.current.setBuffer("ab"); // shrink attempt
    });
    flushFrame(16);
    expect(result.current.visible.value.length).toBeGreaterThanOrEqual(len);
  });
});
```

- [ ] **Step 3.2: Run tests to verify pass**

Run:
```bash
cd gateway/webui && bun run test src/hooks/use-typewriter-buffer.test.ts
```
Expected: PASS — 10 tests pass.

- [ ] **Step 3.3: Commit**

```bash
git add gateway/webui/src/hooks/use-typewriter-buffer.test.ts
git commit -m "test(webui): cover typewriter drain, idle, and reset behaviors"
```

---

## Task 4: Phase 2 — semantic pause polish

Add sentence and paragraph pauses to the tick loop. When the just-revealed character marks a boundary, set `pauseUntilRef` ahead by the appropriate ms.

**Files:**
- Modify: `gateway/webui/src/hooks/use-typewriter-buffer.ts`
- Modify: `gateway/webui/src/hooks/use-typewriter-buffer.test.ts`

- [ ] **Step 4.1: Write failing sentence-pause test**

Append to `gateway/webui/src/hooks/use-typewriter-buffer.test.ts`:

```ts
describe("useTypewriterBuffer — semantic pauses", () => {
  it("holds visible cursor briefly after a sentence-ending period", () => {
    const { result } = renderHook(() => useTypewriterBuffer());
    // Short text containing a sentence boundary followed by a space and more content.
    const TEXT = "Hi. Bye.";
    act(() => {
      result.current.setBuffer(TEXT);
    });
    // Run enough frames to reveal past "Hi." at base rate. base=80c/s → ~38ms/char.
    // Run 10 frames @ 16ms = 160ms which is > "Hi." reveal time.
    runFrames(10, 16);
    const snapshotAfterPeriod = result.current.visible.value;
    // After revealing through ".", the pause (60ms) should hold.
    // One more 16ms frame keeps us within the pause window.
    flushFrame(16);
    // Visible should not have grown past the pause — bounded by sentence-end index.
    // The pause gate must have held the reveal ≥ part of the 16ms frame.
    // Weak assertion: length did not jump by more than a couple of chars during pause.
    expect(result.current.visible.value.length - snapshotAfterPeriod.length).toBeLessThanOrEqual(2);
  });

  it("holds visible cursor longer after a paragraph break (\\n\\n)", () => {
    const { result } = renderHook(() => useTypewriterBuffer());
    const TEXT = "A\n\nB";
    act(() => {
      result.current.setBuffer(TEXT);
    });
    // Run until "A\n\n" is revealed.
    runFrames(20, 16);
    const lenAfterNewlines = result.current.visible.value.length;
    // Within the 160ms paragraph pause window, reveal must not continue.
    flushFrame(100);
    expect(result.current.visible.value.length).toBe(lenAfterNewlines);
  });

  it("does not pause on a period inside a word (e.g. 'v1.2')", () => {
    const { result } = renderHook(() => useTypewriterBuffer());
    const TEXT = "v1.2 works";
    act(() => {
      result.current.setBuffer(TEXT);
    });
    runFrames(60, 16); // generous time to reveal the whole short string
    expect(result.current.visible.value).toBe(TEXT);
  });
});
```

- [ ] **Step 4.2: Run tests to verify failure**

Run:
```bash
cd gateway/webui && bun run test src/hooks/use-typewriter-buffer.test.ts
```
Expected: FAIL — the paragraph-pause test (and possibly the sentence-pause test) fails because `pauseUntilRef` is never set.

- [ ] **Step 4.3: Add boundary predicates + wire pause logic into tick**

Modify `gateway/webui/src/hooks/use-typewriter-buffer.ts`. Add the following helpers near the top of the file (between the imports and the hook function):

```ts
function isSentenceBoundary(c: string | undefined, next: string | undefined): boolean {
  if (c !== "." && c !== "!" && c !== "?") return false;
  // Trailing boundary (end of buffer so far) OR followed by whitespace.
  if (next === undefined) return true;
  return next === " " || next === "\n" || next === "\t";
}

function isParagraphBoundary(c: string | undefined, prev: string | undefined): boolean {
  return c === "\n" && prev === "\n";
}
```

Then inside `tick`, immediately AFTER the `visible.value = ...` assignment and BEFORE the final `schedule()`, insert:

```ts
    const lastChar = bufferRef.current[visiblePosRef.current - 1];
    const nextChar = bufferRef.current[visiblePosRef.current];
    const prevChar = bufferRef.current[visiblePosRef.current - 2];
    if (isParagraphBoundary(lastChar, prevChar)) {
      pauseUntilRef.current = now + TYPEWRITER.paragraphPauseMs;
      log.debug("pause-paragraph", { at: visiblePosRef.current, untilMs: pauseUntilRef.current });
    } else if (isSentenceBoundary(lastChar, nextChar)) {
      pauseUntilRef.current = now + TYPEWRITER.sentencePauseMs;
      log.debug("pause-sentence", { at: visiblePosRef.current, untilMs: pauseUntilRef.current });
    }
```

- [ ] **Step 4.4: Run tests to verify pass**

Run:
```bash
cd gateway/webui && bun run test src/hooks/use-typewriter-buffer.test.ts
```
Expected: PASS — all 13 tests pass. If `does not pause on 'v1.2'` still fails, double-check that the sentence-boundary predicate requires whitespace or end-of-buffer after the punctuation.

- [ ] **Step 4.5: Commit**

```bash
git add gateway/webui/src/hooks/use-typewriter-buffer.ts gateway/webui/src/hooks/use-typewriter-buffer.test.ts
git commit -m "feat(webui): add sentence and paragraph pause polish to typewriter"
```

---

## Task 5: cycle-helpers — always emit placeholder + visibleOverride

Change `appendInflightMessage` so the inflight bubble appears at cycle start (even with empty text), and accept an optional `visibleOverride` that the typewriter will supply.

**Files:**
- Modify: `gateway/webui/src/hooks/cycle-helpers.ts`
- Modify/create: `gateway/webui/src/hooks/cycle-helpers.test.ts` (may already exist — check first)

- [ ] **Step 5.1: Check for existing test file**

Run:
```bash
ls gateway/webui/src/hooks/cycle-helpers.test.ts 2>/dev/null || echo "missing"
```
If `missing`, create it in Step 5.3 alongside the test addition. Otherwise, just append.

- [ ] **Step 5.2: Write failing tests for empty-placeholder + visibleOverride**

Append (or create) `gateway/webui/src/hooks/cycle-helpers.test.ts` with a new `describe` block (keep any existing content):

```ts
import { describe, expect, it } from "vitest";
import { deriveMessages } from "./cycle-helpers.ts";

describe("deriveMessages — inflight placeholder bubble", () => {
  it("emits an empty-text inflight bubble when inflight.text is empty", () => {
    const out = deriveMessages([], { cycleId: "c-1", text: "" }, null, []);
    const inflight = out.find((m) => m.id === "inflight-c-1");
    expect(inflight).toBeDefined();
    expect(inflight?.text).toBe("");
    expect(inflight?.isStreaming).toBe(true);
  });

  it("emits no inflight bubble when inflight is null", () => {
    const out = deriveMessages([], null, null, []);
    expect(out.find((m) => m.role === "assistant" && m.isStreaming)).toBeUndefined();
  });
});

describe("deriveMessages — visibleOverride for typewriter", () => {
  it("substitutes inflight text with visibleOverride when provided", () => {
    const out = deriveMessages(
      [],
      { cycleId: "c-2", text: "Hello world" },
      null,
      [],
      "Hel", // visibleOverride (typewriter's partial reveal)
    );
    const inflight = out.find((m) => m.id === "inflight-c-2");
    expect(inflight?.text).toBe("Hel");
  });

  it("ignores visibleOverride when inflight is null", () => {
    const out = deriveMessages([], null, null, [], "Hel");
    expect(out.find((m) => m.role === "assistant" && m.isStreaming)).toBeUndefined();
  });
});
```

- [ ] **Step 5.3: Run tests to verify failure**

Run:
```bash
cd gateway/webui && bun run test src/hooks/cycle-helpers.test.ts
```
Expected: FAIL — `deriveMessages` 5th arg not accepted OR empty-text bubble is filtered out.

- [ ] **Step 5.4: Modify cycle-helpers.ts**

In `gateway/webui/src/hooks/cycle-helpers.ts`, replace the existing `appendInflightMessage` function (currently at approximately lines 282–292) with:

```ts
function appendInflightMessage(
  out: ChatMessage[],
  inflight: InFlightMessage | null,
  visibleOverride?: string,
): void {
  if (!inflight) return;
  // Phase 1 placeholder: the bubble appears as soon as cycle.started fires,
  // even before the first delta. bubble-text renders a three-dot pulse when
  // text is empty AND isStreaming — so the user has feedback during LLM TTFB.
  const text = visibleOverride ?? inflight.text;
  out.push({
    id: `inflight-${inflight.cycleId}`,
    role: "assistant",
    text,
    timestamp: Date.now(),
    isStreaming: true,
    cycleId: inflight.cycleId,
  });
}
```

Then update `deriveMessages` (currently at approximately lines 311–322) to accept and forward `visibleOverride`:

```ts
export function deriveMessages(
  items: readonly ConversationFeedItem[],
  inflight: InFlightMessage | null,
  lastInflight: LastInflightStamp | null,
  pending: readonly PendingUserMessage[],
  visibleOverride?: string,
): ChatMessage[] {
  const messages: ChatMessage[] = [];
  appendCommittedItems(messages, items, lastInflight);
  appendInflightMessage(messages, inflight, visibleOverride);
  appendPendingMessages(messages, pending);
  return messages;
}
```

- [ ] **Step 5.5: Run tests to verify pass**

Run:
```bash
cd gateway/webui && bun run test src/hooks/cycle-helpers.test.ts
```
Expected: PASS — new tests green. If any previously-passing test now fails (e.g., a test that asserted an empty inflight produced no bubble), inspect whether the older test was encoding the old bail-on-empty behavior and update it to match the new contract.

- [ ] **Step 5.6: Commit**

```bash
git add gateway/webui/src/hooks/cycle-helpers.ts gateway/webui/src/hooks/cycle-helpers.test.ts
git commit -m "feat(webui): render inflight placeholder at cycle start + visibleOverride plumbing"
```

---

## Task 6: BubbleText — three-dot pulse for empty+streaming placeholder

**Files:**
- Modify: `gateway/webui/src/components/chat/bubble-text.tsx`
- Modify: `gateway/webui/src/components/chat/bubble-text.test.tsx`
- Modify: `gateway/webui/src/styles/components.css`

- [ ] **Step 6.1: Write failing test**

Append to `gateway/webui/src/components/chat/bubble-text.test.tsx` (inside the existing `describe("BubbleText", ...)` block, before the closing `});`):

```ts
  it("renders pulse dots when text is empty and isStreaming is true", () => {
    const { container } = render(<BubbleText text="" isStreaming={true} />);
    const pulse = container.querySelector(".bubble-text__pulse");
    expect(pulse).toBeTruthy();
    // Exactly 3 dots inside the pulse container.
    expect(pulse?.querySelectorAll(".bubble-text__pulse-dot").length).toBe(3);
    // The blinking-cursor span is NOT rendered in placeholder mode.
    expect(container.querySelector(".bubble-text__cursor")).toBeNull();
  });

  it("does not render pulse dots when text is non-empty even if streaming", () => {
    const { container } = render(<BubbleText text="H" isStreaming={true} />);
    expect(container.querySelector(".bubble-text__pulse")).toBeNull();
  });

  it("does not render pulse dots when text is empty but not streaming", () => {
    const { container } = render(<BubbleText text="" isStreaming={false} />);
    expect(container.querySelector(".bubble-text__pulse")).toBeNull();
  });
```

- [ ] **Step 6.2: Run test to verify failure**

Run:
```bash
cd gateway/webui && bun run test src/components/chat/bubble-text.test.tsx
```
Expected: FAIL — no `.bubble-text__pulse` element.

- [ ] **Step 6.3: Update BubbleText component**

Replace the contents of `gateway/webui/src/components/chat/bubble-text.tsx` with:

```tsx
import type { JSX } from "preact";
import type { ConversationAssistantCutoff } from "@sentient/protocol";
import { InterruptChip } from "./interrupt-chip.tsx";

export interface BubbleTextProps {
  text: string;
  isStreaming: boolean;
  cutoff?: ConversationAssistantCutoff;
}

/**
 * Placeholder three-dot pulse rendered while the inflight bubble is waiting
 * for its first token from the LLM. Swaps out the moment the typewriter
 * emits its first character.
 */
function PlaceholderPulse(): JSX.Element {
  return (
    <span class="bubble-text__pulse" aria-label="assistant is thinking" role="status">
      <span class="bubble-text__pulse-dot" />
      <span class="bubble-text__pulse-dot" />
      <span class="bubble-text__pulse-dot" />
    </span>
  );
}

export function BubbleText({ text, isStreaming, cutoff }: BubbleTextProps): JSX.Element {
  const showPlaceholder = isStreaming && text.length === 0;
  return (
    <p class="bubble-text">
      {showPlaceholder ? <PlaceholderPulse /> : text}
      {isStreaming && !showPlaceholder && <span class="bubble-text__cursor" aria-hidden="true" />}
      {cutoff && <InterruptChip variant="inline" cutoffKind={cutoff.kind} />}
    </p>
  );
}
```

- [ ] **Step 6.4: Run test to verify pass**

Run:
```bash
cd gateway/webui && bun run test src/components/chat/bubble-text.test.tsx
```
Expected: PASS — all 8 tests pass.

- [ ] **Step 6.5: Add CSS for pulse animation**

Open `gateway/webui/src/styles/components.css`. Find the `.bubble-text__cursor` block (currently around line 380) and add below it, before the `/* ─── BubbleSpeakingWave ─── */` comment:

```css
.bubble-text__pulse {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  vertical-align: text-bottom;
  height: 1em;
}
.bubble-text__pulse-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-accent);
  opacity: 0.4;
  animation: bubble-pulse-dot 1.1s ease-in-out infinite;
}
.bubble-text__pulse-dot:nth-child(2) { animation-delay: 0.15s; }
.bubble-text__pulse-dot:nth-child(3) { animation-delay: 0.3s; }
@keyframes bubble-pulse-dot {
  0%, 80%, 100% { opacity: 0.3; transform: scale(0.9); }
  40% { opacity: 1; transform: scale(1.1); }
}
```

- [ ] **Step 6.6: Commit**

```bash
git add gateway/webui/src/components/chat/bubble-text.tsx gateway/webui/src/components/chat/bubble-text.test.tsx gateway/webui/src/styles/components.css
git commit -m "feat(webui): three-dot pulse placeholder for empty streaming bubble"
```

---

## Task 7: Wire useTypewriterBuffer into useVoiceClient

The last integration step. Instantiate the hook, reset on cycle start, feed setBuffer on inflight updates, call markComplete when inflight goes null, and pass `visible.value` through as `visibleOverride` into `deriveMessages`.

**Files:**
- Modify: `gateway/webui/src/hooks/use-voice-client.ts`
- Modify: `gateway/webui/src/hooks/use-voice-client.test.ts`

**Key detail — where `reset()` is called:**

The spec says "reset on cycle.started." `useVoiceClient` does NOT directly observe `cycle.started` today; `InFlightMessageConnector` does. The cleanest proxy is: call `reset()` every time the connector reports a NEW `cycleId` (i.e., the first `onUpdate` of a new cycle — detected by comparing `inflight.cycleId` to the previously-seen value).

**Key detail — order of effects inside `inflightMessageConnector.onUpdate`:**

1. If `inflight` is non-null and `inflight.cycleId` differs from the prior cycleId → call `typewriter.reset()` first.
2. If `inflight` is non-null → call `typewriter.setBuffer(inflight.text)`.
3. If `inflight` is null → call `typewriter.markComplete()`.
4. Always call `refreshMessages()` afterward (existing behavior).

- [ ] **Step 7.1: Add failing integration test for reset-on-new-cycle**

Check if existing `use-voice-client.test.ts` has coverage relevant to inflight; if not, add a new `describe` block there. Otherwise skip — the integration will be verified manually in Task 8. If you add a test, keep it focused on the pure plumbing only (mocked connector callbacks); do not try to simulate timed rAF inside a full SDK test.

Skip-if-hard: if mocking the full SDK for this test proves brittle, move this verification to Task 8's manual step and note skipped here. Do NOT stub-and-hope.

- [ ] **Step 7.2: Modify `use-voice-client.ts` to use the typewriter**

Open `gateway/webui/src/hooks/use-voice-client.ts`.

**Edit 1 — add import (near the top with other hook imports):**

After line 22 (`import { createWebAudioCapture } from ...`) add:

```ts
import { useTypewriterBuffer } from "./use-typewriter-buffer.ts";
```

**Edit 2 — instantiate the typewriter at the top of `useVoiceClient`:**

After the existing `useRef` declarations (around line 72, after `rawTasksRef`), add:

```ts
  const typewriter = useTypewriterBuffer();
  const typewriterCycleIdRef = useRef<string | null>(null);
```

**Edit 3 — the `typewriter` object (whose identity is stable across renders because the hook uses stable refs + signals) must be reachable inside the memoized `resources` closure. Pass it by capturing it via a ref:**

After the `typewriterCycleIdRef` declaration, add:

```ts
  const typewriterRef = useRef(typewriter);
  typewriterRef.current = typewriter;
```

**Edit 4 — update `refreshMessages` (inside `resources`, around line 126) to pass `visibleOverride`:**

Replace the existing `refreshMessages` body's `deriveMessages(...)` call with:

```ts
      const base = deriveMessages(
        committedRef.current,
        inflightRef.current,
        lastInflightRef.current,
        pendingRef.current,
        inflightRef.current ? typewriterRef.current.visible.value : undefined,
      );
```

**Edit 5 — update `inflightMessageConnector` (around line 213) to drive the typewriter. Replace the existing block with:**

```ts
    const inflightMessageConnector = new InFlightMessageConnector({
      onUpdate: (inflight) => {
        if (inflight) {
          // New cycle: reset the typewriter before feeding the first buffer.
          if (typewriterCycleIdRef.current !== inflight.cycleId) {
            typewriterRef.current.reset();
            typewriterCycleIdRef.current = inflight.cycleId;
          }
          typewriterRef.current.setBuffer(inflight.text);
          lastInflightRef.current = { ts: Date.now(), cycleId: inflight.cycleId };
          currentCycleId.value = inflight.cycleId;
        } else {
          // message.done or cycle.aborted — drain whatever's buffered at MAX_RATE.
          typewriterRef.current.markComplete();
        }
        inflightRef.current = inflight;
        refreshMessages();
      },
    });
```

**Edit 6 — subscribe `refreshMessages` to typewriter reveals so the bubble re-renders each frame:**

Inside the same `useMemo` block, just before `return { sdk, capture, ... }` add:

```ts
    const unsubTypewriter = typewriterRef.current.visible.subscribe(() => {
      if (inflightRef.current) refreshMessages();
    });
```

Then extend the returned `cleanup` to also call `unsubTypewriter()`:

```ts
      cleanup() {
        unsubCapture();
        unsubPlayback();
        unsubTypewriter();
        awaiting.dispose();
      },
```

- [ ] **Step 7.3: Run typecheck**

Run:
```bash
cd gateway/webui && bun run typecheck
```
Expected: PASS. Fix any type errors before proceeding.

- [ ] **Step 7.4: Run the full web test suite**

Run:
```bash
cd gateway/webui && bun run test
```
Expected: PASS — all tests green. If an existing `use-voice-client.test.ts` test breaks on the new `deriveMessages` signature, update the test to pass `undefined` for the new `visibleOverride` arg (or to reflect the new behavior where empty inflight now produces a bubble). Prefer updating test expectations to match the new contract unless the test was asserting a specific cycle-start behavior that's now explicitly changed.

- [ ] **Step 7.5: Commit**

```bash
git add gateway/webui/src/hooks/use-voice-client.ts gateway/webui/src/hooks/use-voice-client.test.ts
git commit -m "feat(webui): wire useTypewriterBuffer into useVoiceClient"
```

---

## Task 8: Manual UX verification + full CI

The rAF loop's feel can only be judged visually. After code is green locally, verify live in a real browser.

**Files:** none modified; verification only.

- [ ] **Step 8.1: Full local CI**

Run from repo root:
```bash
source scripts/env.sh
bun run ci
```
Expected: PASS — lint, typecheck, all tests green.

If `ci` fails because a docker container is holding a port, follow `feedback_docker_ps_before_tests`: stop conflicting containers (`docker ps` → `docker stop <id>`) and re-run.

- [ ] **Step 8.2: Start the dev server**

Run from repo root:
```bash
bun run dev
```
The gateway starts on its configured port (check `gateway/config.yaml` → `server.port`) and the webui dev server starts on Vite's default (usually :5173). Visit the webui URL shown in the terminal.

- [ ] **Step 8.3: Browser manual verification checklist**

Open Chrome DevTools. In the webui:

1. **Placeholder pulse (empty → first char):** send the text prompt `hi`. Confirm the assistant bubble appears immediately with three pulsing dots, then swaps to text when the first token arrives. If no bubble appears until the first delta, revisit Task 5.
2. **Smooth short reply:** verify a short reply (`hi` → `Hello!`) reveals character-by-character without a sudden chunk pop. Look for visible typing, not instant paste.
3. **Long reply drain:** send `tell me a one-paragraph story about a cat who learns to whistle`. Confirm:
   - Text reveals smoothly at a comfortable rate.
   - If the LLM delivers a large initial chunk, typewriter does not pop — it accelerates to catch up.
   - On cycle completion, remaining buffered text drains visibly quickly (<1s) but not instantaneously.
4. **Sentence pause (Phase 2):** in the long reply, observe brief (~60ms) breathers at `.` `!` `?` followed by a space. It should feel like prose.
5. **Paragraph pause:** if the reply contains `\n\n`, observe a longer (~160ms) hold at the break.
6. **New cycle reset:** send a second prompt immediately after the first commits. Confirm the typewriter starts fresh; no residue of prior reply in the new bubble.
7. **Interrupt / barge-in:** send a long prompt, then click Stop (or press Esc) mid-stream. The inflight bubble's committed entry should show its `cutoff` chip cleanly; the remaining buffered text should drain quickly.

If any step fails, capture a short screen recording or DOM snapshot, then stop: file a bug-triage note in the commit message before the final merge.

- [ ] **Step 8.4: Skim production log**

Run:
```bash
tail -n 200 gateway/logs/$(date -u +%Y-%m-%d).log | grep -i typewriter || echo "no webui logs in gateway daily log (expected — webui logs go to the browser)"
```

Then open DevTools console (with `VITE_LOG_LEVEL=debug` if needed) and confirm typewriter logs show `setBuffer`, `pause-sentence`, `tick-drain-complete`. If any expected log is missing, return to the relevant task and add the missing `log.debug(...)` call.

- [ ] **Step 8.5: Final commit / merge prep**

The branch `feature/streaming-typewriter` should have commits from Tasks 1–7 plus whatever docs / retro artifacts already exist. Verify:

```bash
git status
git log --oneline origin/main..HEAD
```

If the working tree is clean and `bun run ci` passed in Step 8.1, the branch is ready for the `superpowers:finishing-a-development-branch` skill or a direct PR per the user's git workflow preference (feature → develop; never to main).

---

## Acceptance (from spec)

- [x] Short reply (~50 chars) and long reply (~600 chars) both reveal smoothly without sudden "chunk pop." → Task 8.3 steps 2, 3.
- [x] First character appears within ~100ms of first `message.delta`. → Placeholder bubble appears at cycle start (Task 5), first character reveals on first rAF tick (Task 2).
- [x] Cycle completion drains remaining buffer in <1s. → `markComplete()` sets rate to `TYPEWRITER.maxRate = 400 c/s` (Task 3); a 400-char buffer drains in 1s at that rate.
- [x] Sentence ends and paragraph breaks have perceptible (60–160ms) pauses. → Task 4.
- [x] All unit tests green; lint, typecheck, full CI green. → Task 8.1.
- [x] No protocol or gateway changes. → Plan only touches `gateway/webui/`.

## Risks + mitigations (handoff reference)

- **Visible handoff pop on long replies:** when `message.done` fires before the typewriter catches up, the inflight bubble (with partial visible) is replaced by the committed bubble (full text). Mitigated by `markComplete()` → MAX_RATE drain. Worst case is a ~1s delay before the committed entry overwrites; accept for Phase 1.
- **rAF throttling in background tabs:** browsers throttle rAF when tab is hidden. Acceptable degradation; no code change. If complaints arise, add a `visibilitychange` listener in a future iteration that flips `streamComplete` temporarily to let the buffer catch up on re-focus.
- **Rate values feel wrong in production:** all four rate tunables + both pause durations live in `gateway/webui/src/config/typewriter.ts`. Edits there are a one-file change — no core logic churn.
