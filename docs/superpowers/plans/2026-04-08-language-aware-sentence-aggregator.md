# Language-Aware Sentence Aggregator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the English-only sentence boundary detection with a strategy pattern that supports per-language detectors, starting with English and Chinese.

**Architecture:** `SentenceBoundaryDetector` interface with `detectBoundary` and `cleanForTts` methods. A factory `createBoundaryDetector(language)` resolves to a concrete detector. The aggregator receives the detector via options. Language flows from `index.ts` → `PipelineDeps` → `runVoiceTurn` → `createStreamingOverlap` → `createSentenceAggregator`.

**Tech Stack:** TypeScript, Bun test runner, Vitest API

---

### Task 1: Create `SentenceBoundaryDetector` interface and factory

**Files:**
- Create: `gateway/src/pipeline/processors/sentence-boundary-detector.ts`
- Create: `gateway/src/pipeline/processors/sentence-boundary-detector.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// sentence-boundary-detector.test.ts
import { describe, expect, it } from "vitest";
import { createBoundaryDetector } from "./sentence-boundary-detector.ts";

describe("createBoundaryDetector", () => {
  it("returns a detector with detectBoundary and cleanForTts", () => {
    const detector = createBoundaryDetector("en");
    expect(typeof detector.detectBoundary).toBe("function");
    expect(typeof detector.cleanForTts).toBe("function");
  });

  it("returns English detector for unknown language", () => {
    const detector = createBoundaryDetector("unknown");
    // English detector finds period boundary
    expect(detector.detectBoundary("Hello.")).toBe(6);
  });

  it("returns English detector for 'multi'", () => {
    const detector = createBoundaryDetector("multi");
    expect(detector.detectBoundary("Hello.")).toBe(6);
  });

  it("returns Chinese detector for 'zh'", () => {
    const detector = createBoundaryDetector("zh");
    // Chinese detector finds 。 boundary
    expect(detector.detectBoundary("你好。世界")).toBe(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/pipeline/processors/sentence-boundary-detector.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the interface and factory**

```typescript
// sentence-boundary-detector.ts
import { createChineseBoundaryDetector } from "./zh-boundary-detector.ts";
import { createEnglishBoundaryDetector } from "./en-boundary-detector.ts";

export interface SentenceBoundaryDetector {
  /** Returns index just past the first sentence boundary, or -1 if none. */
  detectBoundary(text: string): number;
  /** Clean sentence text before sending to TTS (strip trailing punctuation, etc). */
  cleanForTts(sentence: string): string;
}

export function createBoundaryDetector(language: string): SentenceBoundaryDetector {
  if (language === "zh") return createChineseBoundaryDetector();
  return createEnglishBoundaryDetector();
}
```

Note: this will not compile yet — the detector files don't exist. Tasks 2 and 3 create them. Run the test after Task 3 completes.

---

### Task 2: Create English boundary detector

**Files:**
- Create: `gateway/src/pipeline/processors/en-boundary-detector.ts`
- Create: `gateway/src/pipeline/processors/en-boundary-detector.test.ts`
- Delete: `gateway/src/pipeline/processors/sentence-boundary.ts` (after migration)
- Delete: `gateway/src/pipeline/processors/sentence-boundary.test.ts` (after migration)

- [ ] **Step 1: Write the test file**

Migrate all tests from `sentence-boundary.test.ts`, changing the import and adding `cleanForTts` tests. The `detectBoundary` method is identical to the old `detectSentenceBoundary` free function.

```typescript
// en-boundary-detector.test.ts
import { describe, expect, it } from "vitest";
import { createEnglishBoundaryDetector } from "./en-boundary-detector.ts";

const detector = createEnglishBoundaryDetector();

describe("EnglishBoundaryDetector — detectBoundary", () => {
  // --- terminal punctuation ---
  it("returns index+1 for period at end of text", () => {
    expect(detector.detectBoundary("Hello world.")).toBe(12);
  });

  it("returns index+1 for question mark at end of text", () => {
    expect(detector.detectBoundary("How are you?")).toBe(12);
  });

  it("returns index+1 for exclamation at end of text", () => {
    expect(detector.detectBoundary("That is great!")).toBe(14);
  });

  it("returns index+1 for period followed by whitespace", () => {
    expect(detector.detectBoundary("Hello. World")).toBe(6);
  });

  it("returns first boundary in multi-sentence text", () => {
    expect(detector.detectBoundary("First sentence. Second sentence.")).toBe(15);
  });

  it("returns boundary after abbreviation in full sentence", () => {
    expect(detector.detectBoundary("Dr. Smith is here. He arrived.")).toBe(18);
  });

  // --- newline boundaries ---
  it("returns index past newline for newline boundary", () => {
    expect(detector.detectBoundary("Hello\nWorld")).toBe(6);
  });

  it("returns index past first newline for double newline", () => {
    expect(detector.detectBoundary("Hello\n\nWorld")).toBe(6);
  });

  it("returns index past newline when content follows", () => {
    expect(detector.detectBoundary("Line one\nLine two")).toBe(9);
  });

  it("returns index past newline for leading newline", () => {
    expect(detector.detectBoundary("\nSecond")).toBe(1);
  });

  it("returns index past first newline when multiple present", () => {
    expect(detector.detectBoundary("First\nSecond\nThird.")).toBe(6);
  });

  // --- abbreviations (no split) ---
  it("does not split on Dr.", () => {
    expect(detector.detectBoundary("Dr. Smith")).toBe(-1);
  });

  it("does not split on Mr.", () => {
    expect(detector.detectBoundary("Mr. Jones")).toBe(-1);
  });

  it("does not split on Mrs.", () => {
    expect(detector.detectBoundary("Mrs. Smith")).toBe(-1);
  });

  it("does not split on Ms.", () => {
    expect(detector.detectBoundary("Ms. Allen")).toBe(-1);
  });

  it("does not split on Prof.", () => {
    expect(detector.detectBoundary("Prof. Davis")).toBe(-1);
  });

  it("does not split on Jr.", () => {
    expect(detector.detectBoundary("Martin Luther King Jr. spoke")).toBe(-1);
  });

  it("does not split on Sr.", () => {
    expect(detector.detectBoundary("John Smith Sr. arrived")).toBe(-1);
  });

  it("does not split on St.", () => {
    expect(detector.detectBoundary("St. Patrick")).toBe(-1);
  });

  it("does not split on vs.", () => {
    expect(detector.detectBoundary("Team A vs. Team B")).toBe(-1);
  });

  it("does not split on etc.", () => {
    expect(detector.detectBoundary("apples, oranges, etc. and more")).toBe(-1);
  });

  it("does not split on e.g.", () => {
    expect(detector.detectBoundary("fruits e.g. apples")).toBe(-1);
  });

  it("does not split on i.e.", () => {
    expect(detector.detectBoundary("the best i.e. the most optimal")).toBe(-1);
  });

  // --- decimals and special patterns ---
  it("does not split on decimal 3.14", () => {
    expect(detector.detectBoundary("Pi is 3.14 approximately")).toBe(-1);
  });

  it("does not split on decimal 99.9", () => {
    expect(detector.detectBoundary("Score is 99.9 points")).toBe(-1);
  });

  it("does not split on currency $4.50", () => {
    expect(detector.detectBoundary("It costs $4.50 total")).toBe(-1);
  });

  it("does not split on URL-like patterns", () => {
    expect(detector.detectBoundary("Visit example.com for info")).toBe(-1);
  });

  // --- ellipsis ---
  it("does not split on ellipsis mid-sentence", () => {
    expect(detector.detectBoundary("Well... I think")).toBe(-1);
  });

  it("finds terminal period in text containing mid-sentence ellipsis", () => {
    const text = "Well... That was something.";
    expect(detector.detectBoundary(text)).toBe(text.length);
  });

  // --- non-boundary characters ---
  it("returns -1 for empty string", () => {
    expect(detector.detectBoundary("")).toBe(-1);
  });

  it("returns -1 for incomplete sentence with no punctuation", () => {
    expect(detector.detectBoundary("Hello world")).toBe(-1);
  });

  it("returns -1 for colon (not a boundary)", () => {
    expect(detector.detectBoundary("Here is the list: apples")).toBe(-1);
  });

  it("finds period boundary even when semicolon appears first", () => {
    expect(detector.detectBoundary("First part; second part.")).toBe(24);
  });

  // --- closing delimiters ---
  it("detects boundary after period followed by closing parenthesis", () => {
    expect(detector.detectBoundary("(See above.) Next point.")).toBe(12);
  });

  it("detects boundary after period followed by closing quote", () => {
    expect(detector.detectBoundary('He said "done." Then left.')).toBe(15);
  });
});

describe("EnglishBoundaryDetector — cleanForTts", () => {
  it("strips trailing periods", () => {
    expect(detector.cleanForTts("Hello world.")).toBe("Hello world");
  });

  it("strips multiple trailing periods", () => {
    expect(detector.cleanForTts("Wait...")).toBe("Wait");
  });

  it("preserves trailing ! for prosody", () => {
    expect(detector.cleanForTts("Hello!")).toBe("Hello!");
  });

  it("preserves trailing ? for prosody", () => {
    expect(detector.cleanForTts("How are you?")).toBe("How are you?");
  });

  it("returns empty string for punctuation-only input", () => {
    expect(detector.cleanForTts(".")).toBe("");
    expect(detector.cleanForTts("...")).toBe("");
  });

  it("returns empty string for non-word punctuation", () => {
    expect(detector.cleanForTts("!?")).toBe("");
  });

  it("preserves internal periods (abbreviations, decimals)", () => {
    expect(detector.cleanForTts("Dr. Smith is here")).toBe("Dr. Smith is here");
    expect(detector.cleanForTts("Pi is 3.14")).toBe("Pi is 3.14");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/pipeline/processors/en-boundary-detector.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Create the English boundary detector**

Extract the existing `sentence-boundary.ts` code into a detector that implements the interface:

```typescript
// en-boundary-detector.ts
import type { SentenceBoundaryDetector } from "./sentence-boundary-detector.ts";

const ABBREVIATIONS = new Set([
  "dr", "mr", "mrs", "ms", "prof", "sr", "jr", "st",
  "vs", "etc", "eg", "ie", "approx", "dept", "est", "govt",
]);

const CLOSING_DELIMITERS = new Set([")", '"', "'", "\u2019", "]", "}"]);

const HAS_WORD_CHAR = /\w/;
const TRAILING_PERIODS = /\.+$/;

function extractAbbrevCandidate(text: string, i: number): string {
  let pos = i;
  let letters = "";

  while (pos > 0) {
    if (text[pos - 1] === "." && pos < i) {
      pos--;
      continue;
    }
    if (/[a-zA-Z]/.test(text[pos - 1] ?? "")) {
      const wordEnd = pos;
      while (pos > 0 && /[a-zA-Z]/.test(text[pos - 1] ?? "")) {
        pos--;
      }
      letters = text.slice(pos, wordEnd).toLowerCase() + letters;
      if (pos > 0 && text[pos - 1] === ".") {
        pos--;
        continue;
      }
      break;
    }
    break;
  }

  return letters;
}

function isEllipsis(text: string, i: number): boolean {
  return text[i] === "." && (text[i + 1] === "." || text[i - 1] === ".");
}

function isDecimal(text: string, i: number): boolean {
  return /\d/.test(text[i - 1] ?? "") && /\d/.test(text[i + 1] ?? "");
}

function isPrecededByDigit(text: string, i: number): boolean {
  return /\d/.test(text[i - 1] ?? "");
}

function isUrlLike(text: string, i: number): boolean {
  return /\w/.test(text[i - 1] ?? "") && /\w/.test(text[i + 1] ?? "");
}

function isAbbreviation(text: string, i: number): boolean {
  return ABBREVIATIONS.has(extractAbbrevCandidate(text, i));
}

function isTerminal(text: string, i: number): boolean {
  if (i + 1 >= text.length) return true;
  const next = text[i + 1];
  if (/\s/.test(next ?? "")) return true;
  if (CLOSING_DELIMITERS.has(next ?? "")) {
    const afterCloser = text[i + 2];
    return afterCloser === undefined || /\s/.test(afterCloser);
  }
  return false;
}

function skipPastEllipsis(text: string, i: number): number {
  let pos = i;
  while (pos + 1 < text.length && text[pos + 1] === ".") pos++;
  return pos;
}

function terminalBoundary(text: string, i: number): number {
  const next = text[i + 1];
  if (next !== undefined && CLOSING_DELIMITERS.has(next)) return i + 2;
  return i + 1;
}

function checkPeriod(text: string, i: number): number {
  if (isEllipsis(text, i)) return skipPastEllipsis(text, i);
  if (isDecimal(text, i)) return i;
  if (isPrecededByDigit(text, i)) return i;
  if (isAbbreviation(text, i)) return i;
  if (isUrlLike(text, i)) return i;
  if (isTerminal(text, i)) return -terminalBoundary(text, i);
  return i;
}

function detectBoundary(text: string): number {
  const newlineIdx = text.indexOf("\n");
  if (newlineIdx !== -1) return newlineIdx + 1;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (ch === "!" || ch === "?") {
      if (isTerminal(text, i)) return terminalBoundary(text, i);
      continue;
    }

    if (ch !== ".") continue;

    const result = checkPeriod(text, i);
    if (result < 0) return -result;
    i = result;
  }

  return -1;
}

function cleanForTts(sentence: string): string {
  const trimmed = sentence.trim();
  if (trimmed.length === 0) return "";
  if (!HAS_WORD_CHAR.test(trimmed)) return "";
  const cleaned = trimmed.replace(TRAILING_PERIODS, "");
  return cleaned.length === 0 ? "" : cleaned;
}

export function createEnglishBoundaryDetector(): SentenceBoundaryDetector {
  return { detectBoundary, cleanForTts };
}
```

- [ ] **Step 4: Run tests**

Run: `bun test src/pipeline/processors/en-boundary-detector.test.ts`
Expected: All pass

- [ ] **Step 5: Delete old files**

```bash
rm gateway/src/pipeline/processors/sentence-boundary.ts
rm gateway/src/pipeline/processors/sentence-boundary.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add gateway/src/pipeline/processors/sentence-boundary-detector.ts \
  gateway/src/pipeline/processors/sentence-boundary-detector.test.ts \
  gateway/src/pipeline/processors/en-boundary-detector.ts \
  gateway/src/pipeline/processors/en-boundary-detector.test.ts
git rm gateway/src/pipeline/processors/sentence-boundary.ts \
  gateway/src/pipeline/processors/sentence-boundary.test.ts
git commit -m "refactor(pipeline): extract English boundary detector from sentence-boundary"
```

---

### Task 3: Create Chinese boundary detector

**Files:**
- Create: `gateway/src/pipeline/processors/zh-boundary-detector.ts`
- Create: `gateway/src/pipeline/processors/zh-boundary-detector.test.ts`

- [ ] **Step 1: Write the test file**

```typescript
// zh-boundary-detector.test.ts
import { describe, expect, it } from "vitest";
import { createChineseBoundaryDetector } from "./zh-boundary-detector.ts";

const detector = createChineseBoundaryDetector();

describe("ChineseBoundaryDetector — detectBoundary", () => {
  // --- CJK terminal punctuation ---
  it("splits on 。 (period)", () => {
    expect(detector.detectBoundary("你好。世界")).toBe(3);
  });

  it("splits on ！ (exclamation)", () => {
    expect(detector.detectBoundary("太好了！谢谢")).toBe(4);
  });

  it("splits on ？ (question)", () => {
    expect(detector.detectBoundary("你好吗？我很好")).toBe(4);
  });

  it("splits on ； (semicolon)", () => {
    expect(detector.detectBoundary("第一部分；第二部分")).toBe(5);
  });

  it("splits on newline", () => {
    expect(detector.detectBoundary("第一行\n第二行")).toBe(4);
  });

  it("returns boundary at end of text for trailing 。", () => {
    expect(detector.detectBoundary("你好。")).toBe(3);
  });

  it("returns first boundary in multi-sentence text", () => {
    expect(detector.detectBoundary("第一句话。第二句话。")).toBe(5);
  });

  // --- no false splits ---
  it("returns -1 for text without CJK punctuation", () => {
    expect(detector.detectBoundary("你好世界")).toBe(-1);
  });

  it("returns -1 for empty string", () => {
    expect(detector.detectBoundary("")).toBe(-1);
  });

  it("does not split on English period within Chinese text", () => {
    // English period is NOT a CJK sentence boundary
    expect(detector.detectBoundary("版本3.14发布了")).toBe(-1);
  });

  it("does not split on ASCII punctuation", () => {
    expect(detector.detectBoundary("Hello. World")).toBe(-1);
  });

  // --- mixed content ---
  it("splits on CJK punctuation in mixed CJK/English text", () => {
    expect(detector.detectBoundary("这是English。下一句")).toBe(10);
  });
});

describe("ChineseBoundaryDetector — cleanForTts", () => {
  it("strips trailing 。", () => {
    expect(detector.cleanForTts("你好世界。")).toBe("你好世界");
  });

  it("preserves trailing ！ for prosody", () => {
    expect(detector.cleanForTts("太好了！")).toBe("太好了！");
  });

  it("preserves trailing ？ for prosody", () => {
    expect(detector.cleanForTts("你好吗？")).toBe("你好吗？");
  });

  it("returns empty string for punctuation-only input", () => {
    expect(detector.cleanForTts("。")).toBe("");
  });

  it("preserves content with no trailing 。", () => {
    expect(detector.cleanForTts("你好世界")).toBe("你好世界");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/pipeline/processors/zh-boundary-detector.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the Chinese boundary detector**

```typescript
// zh-boundary-detector.ts
import type { SentenceBoundaryDetector } from "./sentence-boundary-detector.ts";

const CJK_TERMINALS = new Set(["。", "！", "？", "；"]);
const TRAILING_CJK_PERIOD = /。+$/;
const HAS_CONTENT = /\S/;

function detectBoundary(text: string): number {
  const newlineIdx = text.indexOf("\n");
  if (newlineIdx !== -1) return newlineIdx + 1;

  for (let i = 0; i < text.length; i++) {
    if (CJK_TERMINALS.has(text[i] ?? "")) {
      return i + 1;
    }
  }

  return -1;
}

function cleanForTts(sentence: string): string {
  const trimmed = sentence.trim();
  if (trimmed.length === 0) return "";
  if (!HAS_CONTENT.test(trimmed)) return "";
  const cleaned = trimmed.replace(TRAILING_CJK_PERIOD, "");
  return cleaned.length === 0 ? "" : cleaned;
}

export function createChineseBoundaryDetector(): SentenceBoundaryDetector {
  return { detectBoundary, cleanForTts };
}
```

- [ ] **Step 4: Run Chinese and factory tests**

Run: `bun test src/pipeline/processors/zh-boundary-detector.test.ts src/pipeline/processors/sentence-boundary-detector.test.ts`
Expected: All pass

- [ ] **Step 5: Commit**

```bash
git add gateway/src/pipeline/processors/zh-boundary-detector.ts \
  gateway/src/pipeline/processors/zh-boundary-detector.test.ts
git commit -m "feat(pipeline): add Chinese sentence boundary detector"
```

---

### Task 4: Update sentence aggregator to use detector

**Files:**
- Modify: `gateway/src/pipeline/processors/sentence-aggregator.ts`
- Modify: `gateway/src/pipeline/processors/sentence-aggregator.test.ts`

- [ ] **Step 1: Update the aggregator options and internals**

In `sentence-aggregator.ts`:

1. Replace the `import { detectSentenceBoundary }` with the detector interface
2. Make `detector` a required option
3. Use `detector.detectBoundary` in `extractSentencesFromBuffer`
4. Use `detector.cleanForTts` in `enqueue` instead of inline regex
5. Remove `HAS_WORD_CHAR` and `TRAILING_PERIODS` constants

```typescript
// sentence-aggregator.ts
import { getLog } from "../../logging/logger.ts";
import type { SentenceBoundaryDetector } from "./sentence-boundary-detector.ts";

const log = getLog(["sentient", "pipeline", "aggregator"]);

const DEFAULT_FLUSH_TIMEOUT_MS = 2000;

export interface SentenceAggregatorOptions {
  readonly flushTimeoutMs?: number;
  readonly detector: SentenceBoundaryDetector;
}

export interface SentenceAggregator {
  addToken(token: string): void;
  flush(): void;
  reset(): void;
  sentences(signal: AbortSignal): AsyncGenerator<string>;
}

// ---------------------------------------------------------------------------
// Sentence queue
// ---------------------------------------------------------------------------

interface SentenceQueue {
  readonly pending: string[];
  enqueue(sentence: string): void;
  wake(): void;
  clear(): void;
  waitForItem(signal: AbortSignal): Promise<boolean>;
}

function createSentenceQueue(detector: SentenceBoundaryDetector): SentenceQueue {
  const pending: string[] = [];
  let waitResolve: (() => void) | null = null;

  function enqueue(sentence: string): void {
    const cleaned = detector.cleanForTts(sentence);
    if (cleaned.length === 0) return;
    log.debug("sentence-detected", { sentence: cleaned });
    pending.push(cleaned);
    if (waitResolve) {
      const r = waitResolve;
      waitResolve = null;
      r();
    }
  }

  function wake(): void {
    if (waitResolve) {
      const r = waitResolve;
      waitResolve = null;
      r();
    }
  }

  function clear(): void {
    pending.length = 0;
  }

  function waitForItem(signal: AbortSignal): Promise<boolean> {
    if (pending.length > 0) return Promise.resolve(true);
    if (signal.aborted) return Promise.resolve(false);

    return new Promise<boolean>((resolve) => {
      waitResolve = () => resolve(true);
      signal.addEventListener(
        "abort",
        () => {
          if (waitResolve) {
            waitResolve = null;
            resolve(false);
          }
        },
        { once: true },
      );
    });
  }

  return { pending, enqueue, wake, clear, waitForItem };
}

// ---------------------------------------------------------------------------
// Buffer extraction
// ---------------------------------------------------------------------------

function extractSentencesFromBuffer(
  buffer: string,
  enqueue: (s: string) => void,
  detector: SentenceBoundaryDetector,
): string {
  let remaining = buffer;
  let boundary = detector.detectBoundary(remaining);

  while (boundary !== -1) {
    enqueue(remaining.slice(0, boundary));
    remaining = remaining.slice(boundary);
    boundary = detector.detectBoundary(remaining);
  }

  return remaining;
}

// ---------------------------------------------------------------------------
// Aggregator factory
// ---------------------------------------------------------------------------

export function createSentenceAggregator(options: SentenceAggregatorOptions): SentenceAggregator {
  const flushTimeoutMs = options.flushTimeoutMs ?? DEFAULT_FLUSH_TIMEOUT_MS;
  const { detector } = options;

  let buffer = "";
  let isDone = false;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  const queue = createSentenceQueue(detector);

  function clearFlushTimer(): void {
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
  }

  function resetFlushTimer(): void {
    clearFlushTimer();
    flushTimer = setTimeout(() => {
      flushTimer = null;
      doFlush();
    }, flushTimeoutMs);
  }

  function doFlush(): void {
    clearFlushTimer();
    const trimmed = buffer.trim();
    buffer = "";
    isDone = true;
    log.debug("flush", { remaining: trimmed });
    if (trimmed.length > 0) {
      queue.enqueue(trimmed);
    }
    queue.wake();
  }

  return {
    addToken(token: string): void {
      buffer += token;
      log.debug("add-token", { tokenLength: token.length, bufferLength: buffer.length });
      buffer = extractSentencesFromBuffer(buffer, queue.enqueue, detector);
      resetFlushTimer();
    },

    flush(): void {
      doFlush();
    },

    reset(): void {
      clearFlushTimer();
      buffer = "";
      isDone = false;
      queue.clear();
    },

    sentences(signal: AbortSignal): AsyncGenerator<string> {
      return (async function* () {
        while (!signal.aborted) {
          if (isDone && queue.pending.length === 0) return;

          const hasItem = await queue.waitForItem(signal);
          if (!hasItem) return;

          while (queue.pending.length > 0) {
            if (signal.aborted) return;
            const sentence = queue.pending.shift();
            if (sentence !== undefined) yield sentence;
          }

          if (isDone && queue.pending.length === 0) return;
        }
      })();
    },
  };
}
```

- [ ] **Step 2: Update aggregator tests**

In `sentence-aggregator.test.ts`, add the detector import and pass it to every `createSentenceAggregator` call:

```typescript
// At top of file:
import { createEnglishBoundaryDetector } from "./en-boundary-detector.ts";

const enDetector = createEnglishBoundaryDetector();
```

Replace every `createSentenceAggregator({ flushTimeoutMs: 2000 })` with:
```typescript
createSentenceAggregator({ flushTimeoutMs: 2000, detector: enDetector })
```

And replace every `createSentenceAggregator()` with:
```typescript
createSentenceAggregator({ detector: enDetector })
```

Add one Chinese-specific test at the end:

```typescript
describe("SentenceAggregator — Chinese detector", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("splits on CJK punctuation when using Chinese detector", async () => {
    const zhDetector = createChineseBoundaryDetector();
    const agg = createSentenceAggregator({ flushTimeoutMs: 2000, detector: zhDetector });
    const controller = new AbortController();
    const sentences: string[] = [];

    const consuming = (async () => {
      for await (const s of agg.sentences(controller.signal)) {
        sentences.push(s);
      }
    })();

    agg.addToken("你好。");
    agg.addToken("世界！");
    agg.flush();
    await consuming;

    expect(sentences).toEqual(["你好", "世界！"]);
  });
});
```

Import `createChineseBoundaryDetector` at top:
```typescript
import { createChineseBoundaryDetector } from "./zh-boundary-detector.ts";
```

- [ ] **Step 3: Run aggregator tests**

Run: `bun test src/pipeline/processors/sentence-aggregator.test.ts`
Expected: All pass

- [ ] **Step 4: Commit**

```bash
git add gateway/src/pipeline/processors/sentence-aggregator.ts \
  gateway/src/pipeline/processors/sentence-aggregator.test.ts
git commit -m "refactor(pipeline): sentence aggregator takes injected boundary detector"
```

---

### Task 5: Wire language through the pipeline

**Files:**
- Modify: `gateway/src/pipeline/processors/streaming-overlap.ts`
- Modify: `gateway/src/pipeline/processors/streaming-overlap.test.ts`
- Modify: `gateway/src/pipeline/voice-turn.ts`
- Modify: `gateway/src/pipeline/voice-turn.test.ts`
- Modify: `gateway/src/server/continuous-voice-handler.ts`
- Modify: `gateway/src/index.ts`

- [ ] **Step 1: Update `streaming-overlap.ts`**

Add language option and use detector factory:

```typescript
// At top, replace aggregator import:
import { createBoundaryDetector } from "./sentence-boundary-detector.ts";
import { createSentenceAggregator } from "./sentence-aggregator.ts";

// Add options interface:
export interface StreamingOverlapOptions {
  language?: string;
}

// Update factory signature:
export function createStreamingOverlap(ttsProcessor: TTSProcessor, options: StreamingOverlapOptions = {}): StreamingOverlap {
  async function* process(input: AsyncGenerator<PipelineChunk>, signal: AbortSignal): AsyncGenerator<PipelineOutput> {
    const detector = createBoundaryDetector(options.language ?? "en");
    const aggregator = createSentenceAggregator({ detector });
    // ... rest unchanged
```

- [ ] **Step 2: Update `voice-turn.ts`**

Add `language` to `VoiceTurnOptions` and pass through:

```typescript
export interface VoiceTurnOptions {
  transcript: string;
  history: ConversationTurn[];
  contextAssembler: ContextAssembler;
  llmProvider: LLMProvider;
  ttsProcessor: TTSProcessor;
  chatModel: string;
  signal: AbortSignal;
  language?: string;
}
```

In `runVoiceTurn`, change:
```typescript
const overlap = createStreamingOverlap(ttsProcessor);
```
to:
```typescript
const overlap = createStreamingOverlap(ttsProcessor, { language: options.language });
```

- [ ] **Step 3: Update `continuous-voice-handler.ts`**

Add `language` to `PipelineDeps` and pass to `runVoiceTurn`:

```typescript
interface PipelineDeps {
  contextAssembler: ContextAssembler;
  llmProvider: LLMProvider;
  ttsProcessor: TTSProcessor;
  chatModel: string;
  language: string;
}
```

In `runTurn`, add `language` to the `runVoiceTurn` call:

```typescript
for await (const event of runVoiceTurn({
  transcript,
  history: ws.data.history,
  contextAssembler: deps.contextAssembler,
  llmProvider: deps.llmProvider,
  ttsProcessor: deps.ttsProcessor,
  chatModel: deps.chatModel,
  signal: turnController.signal,
  language: deps.language,
})) {
```

- [ ] **Step 4: Update `index.ts`**

Pass `STT_LANGUAGE` into deps as `language`:

In the `createGatewayServer` call, add:
```typescript
language: STT_LANGUAGE,
```

Also update the `ws-server.ts` options type and handler wiring to pass `language` through to `PipelineDeps`. Wherever `ttsProcessor` is spread into deps, add `language: options.language`.

- [ ] **Step 5: Update streaming-overlap tests**

In `streaming-overlap.test.ts`, the `createStreamingOverlap` calls now optionally take a second argument. Existing calls without it default to English — no changes needed for existing tests.

Add one Chinese integration test:

```typescript
it("uses Chinese detector when language is zh", async () => {
  const mockTTS = createMockTTSProvider({ chunkCount: 1 });
  await mockTTS.connect(TTS_CONFIG, new AbortController().signal);
  const overlap = createStreamingOverlap(createTTSProcessor(mockTTS), { language: "zh" });
  await collectOutput(overlap, [
    { display: "你好。", speech: "你好。" },
    { display: "世界", speech: "世界" },
  ], new AbortController().signal);
  // Chinese detector splits on 。 — first sentence synthesized, second via sendText
  expect(mockTTS.synthesizeCalls).toHaveLength(1);
  expect(mockTTS.synthesizeCalls[0]).toBe("你好");
  expect(mockTTS.sendTextCalls).toEqual(["世界"]);
});
```

- [ ] **Step 6: Update voice-turn tests**

Add `language: "en"` to `runVoiceTurn` calls in `voice-turn.test.ts` (optional — defaults work, but explicit is better):

No changes strictly required — `language` is optional and defaults to `"en"`.

- [ ] **Step 7: Run full test suite**

Run: `bun test`
Expected: All 492+ tests pass, 0 fail

- [ ] **Step 8: Commit**

```bash
git add gateway/src/pipeline/processors/streaming-overlap.ts \
  gateway/src/pipeline/processors/streaming-overlap.test.ts \
  gateway/src/pipeline/voice-turn.ts \
  gateway/src/server/continuous-voice-handler.ts \
  gateway/src/server/ws-server.ts \
  gateway/src/index.ts
git commit -m "feat(pipeline): wire language config through pipeline to sentence aggregator"
```
