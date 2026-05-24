# TTS Emotion Tag Processor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an EmotionTagProcessor decorator unit that annotates text with Fish Audio S2-Pro emotion tags via a cheap LLM, and flatten StreamingOverlap into three independent pipeline units.

**Architecture:** The monolithic StreamingOverlap is decomposed into SentenceAggregator (TextTransform), EmotionTagProcessor (TextTransform), and TTSSender (AudioTransform). Each is a standalone async-generator decorator. The EmotionTagProcessor buffers speech-chunks into paragraphs, calls a cheap LLM to add S2-Pro `[bracket]` emotion/prosody tags, and re-emits tagged PipelineChunks. Display chunks pass through immediately for zero UI latency impact.

**Tech Stack:** Bun, TypeScript, Vitest, OpenRouter (via existing LLMProvider), Fish Audio S2-Pro

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `gateway/src/pipeline/processors/sentence-aggregator-transform.ts` | Create | Standalone TextTransform wrapping existing SentenceAggregator — yields display pass-through + sentence-level speech chunks |
| `gateway/src/pipeline/processors/sentence-aggregator-transform.test.ts` | Create | Tests for the new TextTransform wrapper |
| `gateway/src/pipeline/processors/emotion-tag-set.ts` | Create | EmotionTagSet interface + loadEmotionTagSet factory |
| `gateway/src/pipeline/processors/emotion-tag-set.test.ts` | Create | Tests for loading tag sets |
| `gateway/src/pipeline/processors/prompts/fish-audio-emotion-tags-en.md` | Create | English S2-Pro emotion tagging prompt |
| `gateway/src/pipeline/processors/prompts/fish-audio-emotion-tags-zh.md` | Create | Chinese S2-Pro emotion tagging prompt |
| `gateway/src/pipeline/processors/emotion-tag-processor.ts` | Create | EmotionTagProcessor TextTransform — buffers paragraphs, calls cheap LLM, emits tagged speech |
| `gateway/src/pipeline/processors/emotion-tag-processor.test.ts` | Create | Tests for emotion tagging: happy path, pass-through, abort, LLM failure graceful degradation |
| `gateway/src/pipeline/processors/tts-sender.ts` | Create | TTSSender AudioTransform — extracted from StreamingOverlap, handles TTS lifecycle |
| `gateway/src/pipeline/processors/tts-sender.test.ts` | Create | Tests for TTSSender: first-sentence gate, sendText, endTurn, display pass-through |
| `gateway/src/pipeline/voice-turn.ts` | Modify | Compose flattened pipeline: SentenceAggregator → EmotionTagProcessor → TTSSender |
| `gateway/src/pipeline/voice-turn.test.ts` | Modify | Update tests for new pipeline composition |
| `gateway/src/index.ts` | Modify | Add EMOTION_TAG_MODEL, EMOTION_TAGS_ENABLED env vars, wire EmotionTagProcessor |
| `gateway/src/pipeline/turn-controller.ts` | Modify | Thread emotion tag processor config to voice-turn |
| `gateway/src/pipeline/continuous-session.ts` | Modify | Thread emotion tag config through session options |
| `gateway/src/server/continuous-voice-handler.ts` | Modify | Thread emotion tag config through handler deps |

---

### Task 1: SentenceAggregatorTransform — TextTransform wrapper

**Files:**
- Create: `gateway/src/pipeline/processors/sentence-aggregator-transform.ts`
- Create: `gateway/src/pipeline/processors/sentence-aggregator-transform.test.ts`
- Read: `gateway/src/pipeline/processors/sentence-aggregator.ts` (existing, reused internally)
- Read: `gateway/src/pipeline/processors/pipeline-types.ts` (TextTransform type)

This wraps the existing `SentenceAggregator` as a `TextTransform`. Display chunks pass through immediately. Speech chunks are buffered and emitted as complete sentences.

- [ ] **Step 1: Write the failing tests**

```typescript
// gateway/src/pipeline/processors/sentence-aggregator-transform.test.ts
import { describe, expect, it } from "vitest";
import type { PipelineChunk } from "./pipeline-types.ts";
import { createSentenceAggregatorTransform } from "./sentence-aggregator-transform.ts";
import { createEnglishBoundaryDetector } from "./en-boundary-detector.ts";

async function* chunkGen(chunks: PipelineChunk[]): AsyncGenerator<PipelineChunk> {
  for (const c of chunks) yield c;
}

async function collect(gen: AsyncGenerator<PipelineChunk>): Promise<PipelineChunk[]> {
  const result: PipelineChunk[] = [];
  for await (const c of gen) result.push(c);
  return result;
}

function displayOnly(chunks: PipelineChunk[]): PipelineChunk[] {
  return chunks.filter((c) => c.display !== "");
}

function speechOnly(chunks: PipelineChunk[]): PipelineChunk[] {
  return chunks.filter((c) => c.speech !== "");
}

describe("SentenceAggregatorTransform", () => {
  it("yields display tokens immediately and speech as complete sentences", async () => {
    const transform = createSentenceAggregatorTransform(createEnglishBoundaryDetector());
    const input = chunkGen([
      { display: "Hello ", speech: "Hello " },
      { display: "world.", speech: "world." },
    ]);
    const output = await collect(transform(input, new AbortController().signal));

    expect(displayOnly(output).map((c) => c.display)).toEqual(["Hello ", "world."]);
    // No newline boundary — flushed as one sentence on stream end
    const sentences = speechOnly(output);
    expect(sentences).toHaveLength(1);
    expect(sentences[0]!.speech).toBe("Hello world");
  });

  it("splits on newline boundaries while passing display through", async () => {
    const transform = createSentenceAggregatorTransform(createEnglishBoundaryDetector());
    const input = chunkGen([
      { display: "First.\n", speech: "First.\n" },
      { display: "Second.", speech: "Second." },
    ]);
    const output = await collect(transform(input, new AbortController().signal));

    const sentences = speechOnly(output);
    expect(sentences).toHaveLength(2);
    expect(sentences[0]!.speech).toBe("First");
    expect(sentences[1]!.speech).toBe("Second");
  });

  it("yields nothing for empty input", async () => {
    const transform = createSentenceAggregatorTransform(createEnglishBoundaryDetector());
    const output = await collect(transform(chunkGen([]), new AbortController().signal));
    expect(output).toHaveLength(0);
  });

  it("stops on abort signal", async () => {
    const transform = createSentenceAggregatorTransform(createEnglishBoundaryDetector());
    const controller = new AbortController();
    controller.abort();
    const output = await collect(transform(chunkGen([{ display: "Hi", speech: "Hi" }]), controller.signal));
    expect(output).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/kevinye/Development/sentient && source scripts/env.sh && bun run test --filter 'sentence-aggregator-transform' -- --run`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// gateway/src/pipeline/processors/sentence-aggregator-transform.ts
import { getLog } from "../../logging/logger.ts";
import type { PipelineChunk, TextTransform } from "./pipeline-types.ts";
import { createSentenceAggregator } from "./sentence-aggregator.ts";
import type { SentenceBoundaryDetector } from "./sentence-boundary-detector.ts";

const log = getLog(["sentient", "pipeline", "aggregator-transform"]);

export function createSentenceAggregatorTransform(
  detector: SentenceBoundaryDetector,
  flushTimeoutMs?: number,
): TextTransform {
  return async function* (input: AsyncGenerator<PipelineChunk>, signal: AbortSignal): AsyncGenerator<PipelineChunk> {
    if (signal.aborted) return;

    const aggregator = createSentenceAggregator({ detector, flushTimeoutMs });

    // Consumer: drain input, yield display pass-through, feed speech to aggregator
    let consumerDone = false;
    let consumerError: unknown = null;
    const consumerPromise = (async () => {
      try {
        for await (const chunk of input) {
          if (signal.aborted) break;
          if (chunk.display) {
            displayQueue.push(chunk.display);
            wakeMain();
          }
          aggregator.addToken(chunk.speech);
        }
      } catch (err) {
        consumerError = err;
      } finally {
        aggregator.flush();
        consumerDone = true;
        wakeMain();
      }
    })();

    // Wake mechanism for the main generator
    const displayQueue: string[] = [];
    let mainResolve: (() => void) | null = null;
    function wakeMain(): void {
      if (mainResolve) {
        const r = mainResolve;
        mainResolve = null;
        r();
      }
    }
    function waitForWork(): Promise<void> {
      if (displayQueue.length > 0) return Promise.resolve();
      return new Promise<void>((r) => { mainResolve = r; });
    }

    // Sentence consumer: pull sentences from aggregator, queue them
    const sentenceQueue: string[] = [];
    const sentencePromise = (async () => {
      for await (const sentence of aggregator.sentences(signal)) {
        if (signal.aborted) break;
        sentenceQueue.push(sentence);
        wakeMain();
      }
    })();

    // Main loop: yield display and speech chunks as they arrive
    while (!signal.aborted) {
      // Yield any pending display chunks
      while (displayQueue.length > 0) {
        const display = displayQueue.shift()!;
        log.debug("display-passthrough", { display });
        yield { display, speech: "" };
      }

      // Yield any pending sentence chunks
      while (sentenceQueue.length > 0) {
        const speech = sentenceQueue.shift()!;
        log.debug("speech-sentence", { speech, length: speech.length });
        yield { display: "", speech };
      }

      // Check if we're done
      if (consumerDone && displayQueue.length === 0 && sentenceQueue.length === 0) {
        // Wait for sentence generator to finish draining
        await sentencePromise;
        // Yield any final sentences
        while (sentenceQueue.length > 0) {
          const speech = sentenceQueue.shift()!;
          yield { display: "", speech };
        }
        break;
      }

      await waitForWork();
    }

    await consumerPromise;
    if (consumerError !== null) throw consumerError;
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/kevinye/Development/sentient && source scripts/env.sh && bun run test --filter 'sentence-aggregator-transform' -- --run`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add gateway/src/pipeline/processors/sentence-aggregator-transform.ts gateway/src/pipeline/processors/sentence-aggregator-transform.test.ts
git commit -m "feat(pipeline): add SentenceAggregatorTransform as standalone TextTransform"
```

---

### Task 2: EmotionTagSet abstraction + prompt files

**Files:**
- Create: `gateway/src/pipeline/processors/emotion-tag-set.ts`
- Create: `gateway/src/pipeline/processors/emotion-tag-set.test.ts`
- Create: `gateway/src/pipeline/processors/prompts/fish-audio-emotion-tags-en.md`
- Create: `gateway/src/pipeline/processors/prompts/fish-audio-emotion-tags-zh.md`

- [ ] **Step 1: Write the English emotion tag prompt**

```markdown
<!-- gateway/src/pipeline/processors/prompts/fish-audio-emotion-tags-en.md -->
You are a TTS text annotator. Your job is to insert Fish Audio S2-Pro emotion and prosody tags into the given text so that the synthesized speech sounds natural and expressive.

## Rules

1. Use `[bracket]` syntax for all tags. Never use parentheses.
2. Place tags inline where the emotion or effect should start. The tag applies until the next tag or sentence end.
3. Do NOT tag every sentence. Only tag where emotion adds value — let neutral text stay untagged.
4. Use at most 2 tags per sentence. Prefer 0-1 for most sentences.
5. Output ONLY the tagged text. No explanations, no markdown formatting, no wrapping.
6. Preserve the original text exactly. Do not rephrase, summarize, or remove any words.
7. Add `[pause]` between sentences where a natural breath or beat would occur, especially at paragraph boundaries or topic shifts.
8. Add vocalization tags like `[sigh]`, `[laugh]`, `[inhale]` ONLY when the text strongly implies them (e.g., expressing frustration, humor, relief).

## Tag Reference

### Emotions
| Tag | Use when |
|-----|----------|
| `[happy]` | Joy, good news, cheerful tone |
| `[excited]` | High energy, enthusiasm, anticipation |
| `[sad]` | Grief, loss, disappointment |
| `[angry]` | Frustration, outrage, firm disagreement |
| `[surprised]` | Unexpected information, disbelief |
| `[worried]` | Concern, anxiety, caution |
| `[gentle]` | Comforting, reassuring, tender |
| `[serious]` | Important information, gravity |
| `[curious]` | Wondering, questioning tone |
| `[sarcastic]` | Irony, dry humor |

### Volume and Pace
| Tag | Use when |
|-----|----------|
| `[whisper]` | Secrets, intimacy, quiet asides |
| `[low voice]` | Subdued, calm, private tone |
| `[loud]` | Emphasis, calling out, urgency |
| `[speaking slowly]` | Deliberate pacing, important points |
| `[emphasis]` | Stress a specific word or phrase |

### Pauses and Breathing
| Tag | Use when |
|-----|----------|
| `[pause]` | Natural beat between sentences or after a thought |
| `[long pause]` | Topic shift, dramatic effect, paragraph boundary |
| `[inhale]` | Before delivering important or emotional content |
| `[sigh]` | Resignation, relief, exasperation |

### Vocalizations
| Tag | Use when |
|-----|----------|
| `[laugh]` | Humor, amusement, light-heartedness |
| `[chuckle]` | Mild amusement, self-deprecation |
| `[clearing throat]` | Transitioning topics, preparing to speak formally |

## Examples

**Input:**
I have some great news! We got the approval for the project. It took three months of waiting, but it finally happened.

**Output:**
[excited] I have some great news! [pause] We got the approval for the project. [pause] [gentle] It took three months of waiting, but it finally happened.

**Input:**
I'm sorry to tell you this, but the flight has been cancelled. We're working on rebooking you on the next available flight. Please bear with us.

**Output:**
[sad] I'm sorry to tell you this, but the flight has been cancelled. [pause] [serious] We're working on rebooking you on the next available flight. [gentle] Please bear with us.

**Input:**
Good morning! The weather today is sunny with a high of 72 degrees. Perfect day for a walk in the park.

**Output:**
[happy] Good morning! The weather today is sunny with a high of 72 degrees. [pause] Perfect day for a walk in the park.

**Input:**
Well, that didn't go as planned. The server crashed again right before the demo. I guess we should have tested it one more time.

**Output:**
[sigh] Well, that didn't go as planned. [pause] [worried] The server crashed again right before the demo. [pause] I guess we should have tested it one more time.
```

- [ ] **Step 2: Write the Chinese emotion tag prompt**

```markdown
<!-- gateway/src/pipeline/processors/prompts/fish-audio-emotion-tags-zh.md -->
你是一个TTS文本标注器。你的任务是在给定的文本中插入Fish Audio S2-Pro情感和韵律标签，使合成语音听起来自然且富有表现力。

## 规则

1. 所有标签使用 `[中括号]` 语法，中文标签优先。
2. 将标签放在情感或效果开始的位置。标签作用到下一个标签或句末。
3. 不要给每句话都加标签。只在情感能增加表现力的地方添加——让平淡的文本保持原样。
4. 每句话最多2个标签，大多数句子用0-1个。
5. 只输出标注后的文本。不要解释、不要markdown格式、不要包装。
6. 完整保留原文。不要改写、总结或删除任何文字。
7. 在句子之间需要自然停顿的地方添加 `[停顿]`，特别是段落边界或话题转换处。
8. 只在文本强烈暗示时才添加拟声标签如 `[叹气]`、`[笑]`、`[吸气]`。

## 标签参考

### 情感
| 标签 | 使用场景 |
|------|----------|
| `[开心]` | 喜悦、好消息、愉快的语气 |
| `[兴奋]` | 高能量、热情、期待 |
| `[悲伤]` | 悲痛、失落、失望 |
| `[生气]` | 沮丧、愤怒、坚决反对 |
| `[惊讶]` | 意外信息、难以置信 |
| `[担心]` | 关切、焦虑、谨慎 |
| `[温柔]` | 安慰、令人安心、温和 |
| `[严肃]` | 重要信息、严肃场合 |
| `[好奇]` | 疑惑、探询的语气 |
| `[讽刺]` | 反讽、冷幽默 |

### 音量和节奏
| 标签 | 使用场景 |
|------|----------|
| `[低声说]` | 秘密、私密、安静的旁白 |
| `[轻声]` | 柔和、平静、私人语气 |
| `[大声]` | 强调、呼喊、紧急 |
| `[慢慢说]` | 刻意放慢、重要观点 |
| `[强调]` | 重读某个词或短语 |

### 停顿和呼吸
| 标签 | 使用场景 |
|------|----------|
| `[停顿]` | 句子间的自然间歇 |
| `[长停顿]` | 话题转换、戏剧效果、段落边界 |
| `[吸气]` | 在重要或情感内容前 |
| `[叹气]` | 无奈、释然、烦躁 |

### 拟声
| 标签 | 使用场景 |
|------|----------|
| `[笑]` | 幽默、开心、轻松 |
| `[轻笑]` | 轻微的好笑、自嘲 |
| `[清嗓]` | 转换话题、准备正式发言 |

## 示例

**输入：**
告诉你一个好消息！我们的项目通过审批了。等了三个月，终于成了。

**输出：**
[兴奋] 告诉你一个好消息！[停顿] 我们的项目通过审批了。[停顿] [温柔] 等了三个月，终于成了。

**输入：**
很抱歉通知您，航班取消了。我们正在为您改签下一个可用的航班，请您耐心等待。

**输出：**
[悲伤] 很抱歉通知您，航班取消了。[停顿] [严肃] 我们正在为您改签下一个可用的航班，[温柔] 请您耐心等待。

**输入：**
早上好！今天天气晴朗，最高气温22度，很适合去公园散步。

**输出：**
[开心] 早上好！今天天气晴朗，最高气温22度，[停顿] 很适合去公园散步。

**输入：**
唉，事情没按计划走。服务器在演示前又崩了。也许我们应该多测试一次的。

**输出：**
[叹气] 唉，事情没按计划走。[停顿] [担心] 服务器在演示前又崩了。[停顿] 也许我们应该多测试一次的。
```

- [ ] **Step 3: Write the failing tests for EmotionTagSet**

```typescript
// gateway/src/pipeline/processors/emotion-tag-set.test.ts
import { describe, expect, it } from "vitest";
import { loadEmotionTagSet } from "./emotion-tag-set.ts";

describe("loadEmotionTagSet", () => {
  it("loads English Fish Audio tag set", () => {
    const tagSet = loadEmotionTagSet("fish-audio", "en");
    expect(tagSet.name).toBe("fish-audio-s2");
    expect(tagSet.language).toBe("en");
    const prompt = tagSet.getSystemPrompt();
    expect(prompt).toContain("[bracket]");
    expect(prompt).toContain("[happy]");
    expect(prompt).toContain("[pause]");
  });

  it("loads Chinese Fish Audio tag set", () => {
    const tagSet = loadEmotionTagSet("fish-audio", "zh");
    expect(tagSet.name).toBe("fish-audio-s2");
    expect(tagSet.language).toBe("zh");
    const prompt = tagSet.getSystemPrompt();
    expect(prompt).toContain("[开心]");
    expect(prompt).toContain("[停顿]");
  });

  it("throws for unknown provider", () => {
    expect(() => loadEmotionTagSet("unknown-provider", "en")).toThrow(/unknown.*provider/i);
  });

  it("defaults to English for unsupported language", () => {
    const tagSet = loadEmotionTagSet("fish-audio", "ja");
    expect(tagSet.language).toBe("en");
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `cd /Users/kevinye/Development/sentient && source scripts/env.sh && bun run test --filter 'emotion-tag-set' -- --run`
Expected: FAIL — module not found

- [ ] **Step 5: Write the EmotionTagSet implementation**

```typescript
// gateway/src/pipeline/processors/emotion-tag-set.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface EmotionTagSet {
  readonly name: string;
  readonly language: string;
  getSystemPrompt(): string;
}

const PROMPTS_DIR = join(import.meta.dir, "prompts");

const SUPPORTED_LANGUAGES = new Set(["en", "zh"]);

export function loadEmotionTagSet(provider: string, language: string): EmotionTagSet {
  if (provider !== "fish-audio") {
    throw new Error(`Unknown emotion tag provider: "${provider}" — only "fish-audio" is supported`);
  }

  const resolvedLanguage = SUPPORTED_LANGUAGES.has(language) ? language : "en";
  const promptFile = join(PROMPTS_DIR, `fish-audio-emotion-tags-${resolvedLanguage}.md`);
  const promptContent = readFileSync(promptFile, "utf-8");

  return {
    name: "fish-audio-s2",
    language: resolvedLanguage,
    getSystemPrompt: () => promptContent,
  };
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd /Users/kevinye/Development/sentient && source scripts/env.sh && bun run test --filter 'emotion-tag-set' -- --run`
Expected: PASS (4 tests)

- [ ] **Step 7: Commit**

```bash
git add gateway/src/pipeline/processors/emotion-tag-set.ts gateway/src/pipeline/processors/emotion-tag-set.test.ts gateway/src/pipeline/processors/prompts/
git commit -m "feat(pipeline): add EmotionTagSet abstraction and Fish Audio S2 prompt files"
```

---

### Task 3: EmotionTagProcessor — the core decorator unit

**Files:**
- Create: `gateway/src/pipeline/processors/emotion-tag-processor.ts`
- Create: `gateway/src/pipeline/processors/emotion-tag-processor.test.ts`
- Read: `gateway/src/providers/llm-provider.ts` (LLMProvider interface)
- Read: `gateway/src/pipeline/processors/pipeline-types.ts` (TextTransform, PipelineChunk)

The EmotionTagProcessor is a TextTransform that:
- Passes display-only chunks through immediately
- Buffers speech chunks into paragraphs
- Calls a cheap LLM per paragraph to add emotion tags
- Emits tagged speech chunks
- Gracefully degrades on LLM failure (passes through untagged)

- [ ] **Step 1: Write the failing tests**

```typescript
// gateway/src/pipeline/processors/emotion-tag-processor.test.ts
import { createMockLLMProvider } from "@sentient/testing";
import { describe, expect, it } from "vitest";
import { createEmotionTagProcessor } from "./emotion-tag-processor.ts";
import type { PipelineChunk } from "./pipeline-types.ts";

async function* chunkGen(chunks: PipelineChunk[]): AsyncGenerator<PipelineChunk> {
  for (const c of chunks) yield c;
}

async function collect(gen: AsyncGenerator<PipelineChunk>): Promise<PipelineChunk[]> {
  const result: PipelineChunk[] = [];
  for await (const c of gen) result.push(c);
  return result;
}

const MOCK_TAG_SET = {
  name: "test-tags",
  language: "en",
  getSystemPrompt: () => "You are a TTS annotator. Add [happy] tags.",
};

describe("EmotionTagProcessor — happy path", () => {
  it("passes display-only chunks through immediately", async () => {
    const llm = createMockLLMProvider({ response: "[happy] Hello world" });
    const transform = createEmotionTagProcessor(llm, "test-model", MOCK_TAG_SET);
    const input = chunkGen([
      { display: "Hello ", speech: "" },
      { display: "world", speech: "" },
      { display: "", speech: "Hello world" },
    ]);
    const output = await collect(transform(input, new AbortController().signal));

    const displays = output.filter((c) => c.display !== "");
    expect(displays.map((c) => c.display)).toEqual(["Hello ", "world"]);
  });

  it("sends speech chunks to LLM and yields tagged result", async () => {
    const llm = createMockLLMProvider({ response: "[happy] Hello world" });
    const transform = createEmotionTagProcessor(llm, "test-model", MOCK_TAG_SET);
    const input = chunkGen([{ display: "", speech: "Hello world" }]);
    const output = await collect(transform(input, new AbortController().signal));

    const speeches = output.filter((c) => c.speech !== "");
    expect(speeches).toHaveLength(1);
    expect(speeches[0]!.speech).toBe("[happy] Hello world");
    expect(llm.streamCallCount).toBe(1);
  });

  it("batches multiple speech chunks into one LLM call", async () => {
    const llm = createMockLLMProvider({ response: "[excited] First sentence. Second sentence" });
    const transform = createEmotionTagProcessor(llm, "test-model", MOCK_TAG_SET);
    const input = chunkGen([
      { display: "", speech: "First sentence." },
      { display: "", speech: " Second sentence" },
    ]);
    const output = await collect(transform(input, new AbortController().signal));

    const speeches = output.filter((c) => c.speech !== "");
    expect(speeches).toHaveLength(1);
    expect(llm.streamCallCount).toBe(1);
  });

  it("uses the tag set system prompt and correct model", async () => {
    const llm = createMockLLMProvider({ response: "tagged text" });
    const transform = createEmotionTagProcessor(llm, "anthropic/claude-3-haiku", MOCK_TAG_SET);
    const input = chunkGen([{ display: "", speech: "Hello" }]);
    await collect(transform(input, new AbortController().signal));

    expect(llm.lastMessages[0]!.role).toBe("system");
    expect(llm.lastMessages[0]!.content).toContain("TTS annotator");
    expect(llm.lastMessages[1]!.role).toBe("user");
    expect(llm.lastMessages[1]!.content).toBe("Hello");
  });
});

describe("EmotionTagProcessor — graceful degradation", () => {
  it("passes through untagged text when LLM fails", async () => {
    const llm = createMockLLMProvider({ shouldFail: true, errorMessage: "LLM down" });
    const transform = createEmotionTagProcessor(llm, "test-model", MOCK_TAG_SET);
    const input = chunkGen([{ display: "", speech: "Hello world" }]);
    const output = await collect(transform(input, new AbortController().signal));

    const speeches = output.filter((c) => c.speech !== "");
    expect(speeches).toHaveLength(1);
    expect(speeches[0]!.speech).toBe("Hello world");
  });
});

describe("EmotionTagProcessor — abort", () => {
  it("stops processing when signal is aborted", async () => {
    const llm = createMockLLMProvider({ response: "tagged", tokenDelayMs: 50 });
    const transform = createEmotionTagProcessor(llm, "test-model", MOCK_TAG_SET);
    const controller = new AbortController();
    controller.abort();
    const output = await collect(transform(chunkGen([{ display: "", speech: "Hi" }]), controller.signal));
    expect(output).toHaveLength(0);
  });
});

describe("EmotionTagProcessor — empty input", () => {
  it("yields nothing for empty speech", async () => {
    const llm = createMockLLMProvider({ response: "tagged" });
    const transform = createEmotionTagProcessor(llm, "test-model", MOCK_TAG_SET);
    const output = await collect(transform(chunkGen([]), new AbortController().signal));
    expect(output).toHaveLength(0);
    expect(llm.streamCallCount).toBe(0);
  });

  it("skips LLM call for whitespace-only speech", async () => {
    const llm = createMockLLMProvider({ response: "tagged" });
    const transform = createEmotionTagProcessor(llm, "test-model", MOCK_TAG_SET);
    const input = chunkGen([{ display: " ", speech: "   " }]);
    const output = await collect(transform(input, new AbortController().signal));

    // Display passes through, no speech emitted
    expect(output.filter((c) => c.speech !== "")).toHaveLength(0);
    expect(llm.streamCallCount).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/kevinye/Development/sentient && source scripts/env.sh && bun run test --filter 'emotion-tag-processor' -- --run`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// gateway/src/pipeline/processors/emotion-tag-processor.ts
import { getLog } from "../../logging/logger.ts";
import type { LLMProvider } from "../../providers/llm-provider.ts";
import type { EmotionTagSet } from "./emotion-tag-set.ts";
import type { PipelineChunk, TextTransform } from "./pipeline-types.ts";

const log = getLog(["sentient", "pipeline", "emotion-tag"]);

export function createEmotionTagProcessor(
  llmProvider: LLMProvider,
  model: string,
  tagSet: EmotionTagSet,
): TextTransform {
  const systemPrompt = tagSet.getSystemPrompt();

  return async function* (input: AsyncGenerator<PipelineChunk>, signal: AbortSignal): AsyncGenerator<PipelineChunk> {
    if (signal.aborted) return;

    let speechBuffer = "";

    for await (const chunk of input) {
      if (signal.aborted) return;

      // Display-only: pass through immediately
      if (chunk.display && !chunk.speech) {
        yield chunk;
        continue;
      }

      // Speech-only or mixed: buffer speech
      if (chunk.display) {
        yield { display: chunk.display, speech: "" };
      }
      speechBuffer += chunk.speech;
    }

    // End of stream: process the buffered paragraph
    if (signal.aborted) return;
    const trimmed = speechBuffer.trim();
    if (!trimmed) return;

    log.info("tagging-paragraph", { length: trimmed.length, model });
    const tagged = await tagParagraph(trimmed, llmProvider, model, systemPrompt, signal);
    yield { display: "", speech: tagged };
  };
}

async function tagParagraph(
  text: string,
  llmProvider: LLMProvider,
  model: string,
  systemPrompt: string,
  signal: AbortSignal,
): Promise<string> {
  try {
    let result = "";
    for await (const token of llmProvider.stream({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: text },
      ],
      signal,
      maxTokens: 1024,
      temperature: 0.3,
    })) {
      result += token;
    }

    const trimmed = result.trim();
    if (!trimmed) {
      log.warn("empty-llm-response", { textLength: text.length });
      return text;
    }

    log.debug("tagged-result", { original: text.length, tagged: trimmed.length });
    return trimmed;
  } catch (err: unknown) {
    log.warn("tagging-failed", { message: err instanceof Error ? err.message : String(err) });
    return text;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/kevinye/Development/sentient && source scripts/env.sh && bun run test --filter 'emotion-tag-processor' -- --run`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add gateway/src/pipeline/processors/emotion-tag-processor.ts gateway/src/pipeline/processors/emotion-tag-processor.test.ts
git commit -m "feat(pipeline): add EmotionTagProcessor decorator unit"
```

---

### Task 4: TTSSender — extracted AudioTransform

**Files:**
- Create: `gateway/src/pipeline/processors/tts-sender.ts`
- Create: `gateway/src/pipeline/processors/tts-sender.test.ts`
- Read: `gateway/src/pipeline/processors/streaming-overlap.ts` (extracting logic from here)
- Read: `gateway/src/pipeline/processors/tts-processor.ts` (TTSProcessor interface)

TTSSender is the AudioTransform extracted from StreamingOverlap. It receives PipelineChunks (display-only and speech) and produces PipelineOutput (text + audio events).

- [ ] **Step 1: Write the failing tests**

```typescript
// gateway/src/pipeline/processors/tts-sender.test.ts
import type { AudioFrame } from "@sentient/protocol";
import { createMockTTSProvider } from "@sentient/testing";
import { describe, expect, it } from "vitest";
import type { PipelineChunk, PipelineOutput } from "./pipeline-types.ts";
import { createTTSSender } from "./tts-sender.ts";
import { createTTSProcessor } from "./tts-processor.ts";

async function* chunkGen(chunks: PipelineChunk[]): AsyncGenerator<PipelineChunk> {
  for (const c of chunks) yield c;
}

async function collectOutput(
  gen: AsyncGenerator<PipelineOutput>,
): Promise<PipelineOutput[]> {
  const result: PipelineOutput[] = [];
  for await (const item of gen) result.push(item);
  return result;
}

function textEvents(output: PipelineOutput[]): string[] {
  return output.filter((o) => o.type === "text").map((o) => (o as { type: "text"; display: string }).display);
}

function audioEvents(output: PipelineOutput[]): AudioFrame[] {
  return output.filter((o) => o.type === "audio").map((o) => (o as { type: "audio"; frame: AudioFrame }).frame);
}

describe("TTSSender — happy path", () => {
  it("passes display-only chunks as text events", async () => {
    const mockTTS = createMockTTSProvider({ chunkCount: 1 });
    const sender = createTTSSender(createTTSProcessor(mockTTS));
    const input = chunkGen([
      { display: "Hello ", speech: "" },
      { display: "world", speech: "" },
      { display: "", speech: "Hello world" },
    ]);
    const output = await collectOutput(sender(input, new AbortController().signal));

    expect(textEvents(output)).toEqual(["Hello ", "world"]);
  });

  it("synthesizes first speech chunk and yields audio frames", async () => {
    const mockTTS = createMockTTSProvider({ chunkCount: 3 });
    const sender = createTTSSender(createTTSProcessor(mockTTS));
    const input = chunkGen([{ display: "", speech: "Hello world" }]);
    const output = await collectOutput(sender(input, new AbortController().signal));

    expect(mockTTS.synthesizeCalls).toHaveLength(1);
    expect(mockTTS.synthesizeCalls[0]).toBe("Hello world");
    expect(audioEvents(output)).toHaveLength(3);
  });

  it("sends subsequent speech chunks via sendText", async () => {
    const mockTTS = createMockTTSProvider({ chunkCount: 2 });
    const sender = createTTSSender(createTTSProcessor(mockTTS));
    const input = chunkGen([
      { display: "", speech: "First sentence" },
      { display: "", speech: "Second sentence" },
    ]);
    const output = await collectOutput(sender(input, new AbortController().signal));

    expect(mockTTS.synthesizeCalls).toHaveLength(1);
    expect(mockTTS.synthesizeCalls[0]).toBe("First sentence");
    expect(mockTTS.sendTextCalls).toEqual(["Second sentence"]);
    expect(audioEvents(output).length).toBeGreaterThan(0);
  });

  it("calls endTurn after all speech is sent", async () => {
    const mockTTS = createMockTTSProvider({ chunkCount: 1 });
    const sender = createTTSSender(createTTSProcessor(mockTTS));
    const input = chunkGen([{ display: "", speech: "Hello" }]);
    await collectOutput(sender(input, new AbortController().signal));

    expect(mockTTS.endTurnCallCount).toBe(1);
  });

  it("yields nothing for empty input", async () => {
    const mockTTS = createMockTTSProvider({ chunkCount: 1 });
    const sender = createTTSSender(createTTSProcessor(mockTTS));
    const output = await collectOutput(sender(chunkGen([]), new AbortController().signal));

    expect(output).toHaveLength(0);
    expect(mockTTS.synthesizeCalls).toHaveLength(0);
  });

  it("skips empty speech chunks", async () => {
    const mockTTS = createMockTTSProvider({ chunkCount: 1 });
    const sender = createTTSSender(createTTSProcessor(mockTTS));
    const input = chunkGen([
      { display: "Hi", speech: "" },
      { display: "", speech: "" },
      { display: "", speech: "Hello" },
    ]);
    const output = await collectOutput(sender(input, new AbortController().signal));

    expect(mockTTS.synthesizeCalls).toEqual(["Hello"]);
    expect(textEvents(output)).toEqual(["Hi"]);
  });
});

describe("TTSSender — abort", () => {
  it("stops when signal is aborted before start", async () => {
    const mockTTS = createMockTTSProvider({ chunkCount: 1 });
    const sender = createTTSSender(createTTSProcessor(mockTTS));
    const controller = new AbortController();
    controller.abort();
    const output = await collectOutput(sender(chunkGen([{ display: "", speech: "Hi" }]), controller.signal));

    expect(output).toHaveLength(0);
  });
});

describe("TTSSender — error propagation", () => {
  it("propagates TTS synthesis errors", async () => {
    const mockTTS = createMockTTSProvider({ shouldFailSynthesize: true, errorMessage: "TTS boom" });
    const sender = createTTSSender(createTTSProcessor(mockTTS));
    const input = chunkGen([{ display: "", speech: "Hello" }]);

    await expect(collectOutput(sender(input, new AbortController().signal))).rejects.toThrow(/TTS boom/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/kevinye/Development/sentient && source scripts/env.sh && bun run test --filter 'tts-sender' -- --run`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// gateway/src/pipeline/processors/tts-sender.ts
import { getLog } from "../../logging/logger.ts";
import type { AudioTransform, PipelineChunk, PipelineOutput } from "./pipeline-types.ts";
import type { TTSProcessor } from "./tts-processor.ts";

const log = getLog(["sentient", "pipeline", "tts-sender"]);

export function createTTSSender(ttsProcessor: TTSProcessor): AudioTransform {
  return async function* (input: AsyncGenerator<PipelineChunk>, signal: AbortSignal): AsyncGenerator<PipelineOutput> {
    if (signal.aborted) return;

    let firstSpeechHandled = false;
    let audioGen: AsyncGenerator<import("@sentient/protocol").AudioFrame> | null = null;

    // Collect all input chunks, separating display and speech
    const pendingSpeech: string[] = [];

    for await (const chunk of input) {
      if (signal.aborted) return;

      // Display pass-through
      if (chunk.display) {
        yield { type: "text", display: chunk.display };
      }

      // Buffer speech
      if (chunk.speech) {
        if (!firstSpeechHandled) {
          // First speech: start synthesis immediately
          firstSpeechHandled = true;
          log.debug("first-sentence-to-tts", { speech: chunk.speech, length: chunk.speech.length });
          audioGen = ttsProcessor.synthesizeSentence(chunk.speech, signal);
        } else {
          // Subsequent speech: queue for sendText
          pendingSpeech.push(chunk.speech);
        }
      }
    }

    if (!audioGen || signal.aborted) return;

    // Send remaining speech chunks in background
    for (const speech of pendingSpeech) {
      if (signal.aborted) return;
      log.debug("sentence-to-tts", { speech, length: speech.length });
      ttsProcessor.sendText(speech);
    }

    // Yield all audio frames
    for await (const frame of audioGen) {
      if (signal.aborted) return;
      log.debug("audio-frame", { bytes: frame.data.length });
      yield { type: "audio", frame };
    }

    if (!signal.aborted) {
      log.info("end-turn");
      await ttsProcessor.endTurn();
    }
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/kevinye/Development/sentient && source scripts/env.sh && bun run test --filter 'tts-sender' -- --run`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add gateway/src/pipeline/processors/tts-sender.ts gateway/src/pipeline/processors/tts-sender.test.ts
git commit -m "feat(pipeline): add TTSSender AudioTransform extracted from StreamingOverlap"
```

---

### Task 5: Wire the flattened pipeline in voice-turn.ts

**Files:**
- Modify: `gateway/src/pipeline/voice-turn.ts`
- Modify: `gateway/src/pipeline/voice-turn.test.ts` (if exists, or create)
- Modify: `gateway/src/pipeline/turn-controller.ts:16-28` (add emotion tag options)
- Modify: `gateway/src/pipeline/continuous-session.ts:50-62` (add emotion tag options)
- Modify: `gateway/src/server/continuous-voice-handler.ts:27-34` (add emotion tag to deps)
- Modify: `gateway/src/index.ts:26-33,98-112` (env vars + wiring)

- [ ] **Step 1: Update VoiceTurnOptions in voice-turn.ts**

Replace the contents of `gateway/src/pipeline/voice-turn.ts` with the new flattened pipeline:

```typescript
// gateway/src/pipeline/voice-turn.ts
import type { ContextAssembler, ConversationTurn } from "../context/context-assembler.ts";
import { getLog } from "../logging/logger.ts";
import type { LLMProvider } from "../providers/llm-provider.ts";
import type { EmotionTagSet } from "./processors/emotion-tag-set.ts";
import { createEmotionTagProcessor } from "./processors/emotion-tag-processor.ts";
import { toPipelineChunk } from "./processors/pipeline-types.ts";
import type { PipelineOutput } from "./processors/pipeline-types.ts";
import { createBoundaryDetector } from "./processors/sentence-boundary-detector.ts";
import { createSentenceAggregatorTransform } from "./processors/sentence-aggregator-transform.ts";
import { createTTSSender } from "./processors/tts-sender.ts";
import type { TTSProcessor } from "./processors/tts-processor.ts";

const log = getLog(["sentient", "pipeline"]);

export interface EmotionTagOptions {
  readonly llmProvider: LLMProvider;
  readonly model: string;
  readonly tagSet: EmotionTagSet;
}

export interface VoiceTurnOptions {
  transcript: string;
  history: ConversationTurn[];
  contextAssembler: ContextAssembler;
  llmProvider: LLMProvider;
  ttsProcessor: TTSProcessor;
  chatModel: string;
  signal: AbortSignal;
  language?: string;
  emotionTags?: EmotionTagOptions;
}

export type VoiceTurnEvent =
  | { type: "text.delta"; payload: string }
  | { type: "text.done"; payload: string }
  | { type: "audio.start"; payload: null }
  | { type: "audio.frame"; payload: Uint8Array }
  | { type: "audio.done"; payload: null };

export async function* runVoiceTurn(options: VoiceTurnOptions): AsyncGenerator<VoiceTurnEvent> {
  const { transcript, history, contextAssembler, llmProvider, ttsProcessor, chatModel, signal, language, emotionTags } =
    options;
  const startTime = Date.now();
  log.info("turn-start", { transcript, model: chatModel });
  const messages = contextAssembler.buildMessages(history, transcript);

  // Stage 1: LLM tokens → PipelineChunk
  async function* llmToPipelineChunks() {
    for await (const token of llmProvider.stream({ model: chatModel, messages, signal })) {
      yield toPipelineChunk(token);
    }
  }

  // Stage 2: Sentence aggregation (PipelineChunk → PipelineChunk)
  const detector = createBoundaryDetector(language ?? "en");
  const aggregate = createSentenceAggregatorTransform(detector);
  let sentenceStream = aggregate(llmToPipelineChunks(), signal);

  // Stage 3: Emotion tagging (optional, PipelineChunk → PipelineChunk)
  if (emotionTags) {
    const tag = createEmotionTagProcessor(emotionTags.llmProvider, emotionTags.model, emotionTags.tagSet);
    sentenceStream = tag(sentenceStream, signal);
  }

  // Stage 4: TTS synthesis (PipelineChunk → PipelineOutput)
  const send = createTTSSender(ttsProcessor);

  let fullText = "";
  let audioStartEmitted = false;

  for await (const event of send(sentenceStream, signal)) {
    if (event.type === "text") {
      fullText += event.display;
      log.debug("text-event", { display: event.display });
      yield { type: "text.delta", payload: event.display };
    } else if (event.type === "audio") {
      if (!audioStartEmitted) {
        yield { type: "audio.start", payload: null };
        audioStartEmitted = true;
      }
      log.debug("audio-event", { bytes: event.frame.data.length });
      yield { type: "audio.frame", payload: event.frame.data };
    }
  }

  const durationMs = Date.now() - startTime;
  log.info("turn-end", { textLength: fullText.length, audioStartEmitted, durationMs });
  yield { type: "text.done", payload: fullText };
  if (audioStartEmitted) {
    yield { type: "audio.done", payload: null };
  }
}
```

- [ ] **Step 2: Update TurnControllerOptions to pass emotion tag config**

In `gateway/src/pipeline/turn-controller.ts`, add `EmotionTagOptions` to the options interface and thread it to `runVoiceTurn`:

Add import at top:
```typescript
import type { EmotionTagOptions } from "./voice-turn.ts";
```

Add to `TurnControllerOptions` interface (after `language: string;`):
```typescript
  emotionTags?: EmotionTagOptions;
```

In the `run()` function, add `emotionTags` to the `runVoiceTurn` call (after `language,`):
```typescript
        emotionTags: options.emotionTags,
```

Also destructure it from options at the top of `createTurnController`:
```typescript
  const { ..., emotionTags } = options;
```

And pass in the runVoiceTurn call:
```typescript
        emotionTags,
```

- [ ] **Step 3: Update ContinuousSessionOptions to pass emotion tag config**

In `gateway/src/pipeline/continuous-session.ts`, add import:
```typescript
import type { EmotionTagOptions } from "./voice-turn.ts";
```

Add to `ContinuousSessionOptions` (after `language: string;`):
```typescript
  emotionTags?: EmotionTagOptions;
```

Destructure in `createContinuousSession`:
```typescript
  const { ..., emotionTags } = options;
```

Pass to `createTurnController` in `startTurn()` (after `language,`):
```typescript
      emotionTags,
```

- [ ] **Step 4: Update VoicePipelineDeps to pass emotion tag config**

In `gateway/src/server/continuous-voice-handler.ts`, add import:
```typescript
import type { EmotionTagOptions } from "../pipeline/voice-turn.ts";
```

Add to `VoicePipelineDeps` (after `language: string;`):
```typescript
  emotionTags?: EmotionTagOptions;
```

Pass to `createContinuousSession` in `ensureContinuousSession()` (after `language: deps.language,`):
```typescript
      emotionTags: deps.emotionTags,
```

- [ ] **Step 5: Wire environment variables in index.ts**

In `gateway/src/index.ts`, add the new env vars after existing ones (around line 32):

```typescript
const EMOTION_TAG_MODEL = process.env.EMOTION_TAG_MODEL ?? "anthropic/claude-3-haiku";
const EMOTION_TAGS_ENABLED = process.env.EMOTION_TAGS_ENABLED !== "false";
```

Add imports at top:
```typescript
import { loadEmotionTagSet } from "./pipeline/processors/emotion-tag-set.ts";
import type { EmotionTagOptions } from "./pipeline/voice-turn.ts";
```

After the `llmProvider` setup (around line 51), add:
```typescript
const emotionTags: EmotionTagOptions | undefined =
  EMOTION_TAGS_ENABLED && llmProvider
    ? {
        llmProvider,
        model: EMOTION_TAG_MODEL,
        tagSet: loadEmotionTagSet("fish-audio", STT_LANGUAGE === "zh" ? "zh" : "en"),
      }
    : undefined;
```

In the `createGatewayServer` call, add after `language: STT_LANGUAGE,`:
```typescript
  ...(emotionTags ? { emotionTags } : {}),
```

- [ ] **Step 6: Update ws-server to pass emotionTags through**

Check how `createGatewayServer` forwards options to the handler deps. If `VoicePipelineDeps` is constructed from the server options, add `emotionTags` there.

In `gateway/src/server/ws-server.ts`, add `emotionTags` to the server options interface and pass it through to the handler deps wherever `VoicePipelineDeps` is constructed.

- [ ] **Step 7: Run the full test suite**

Run: `cd /Users/kevinye/Development/sentient && source scripts/env.sh && bun run test -- --run`
Expected: All existing tests pass (streaming-overlap tests may need attention — see Task 6)

- [ ] **Step 8: Commit**

```bash
git add gateway/src/pipeline/voice-turn.ts gateway/src/pipeline/turn-controller.ts gateway/src/pipeline/continuous-session.ts gateway/src/server/continuous-voice-handler.ts gateway/src/server/ws-server.ts gateway/src/index.ts
git commit -m "feat(pipeline): wire flattened pipeline — SentenceAggregator → EmotionTagProcessor → TTSSender"
```

---

### Task 6: Update or remove StreamingOverlap tests

**Files:**
- Modify or Delete: `gateway/src/pipeline/processors/streaming-overlap.test.ts`
- Keep: `gateway/src/pipeline/processors/streaming-overlap.ts` (do NOT delete yet — keep until all tests pass with the new pipeline)

The existing StreamingOverlap tests cover behavior that's now split across SentenceAggregatorTransform, EmotionTagProcessor, and TTSSender. Since the new units have their own tests, the StreamingOverlap tests become integration-level coverage for the old code path.

- [ ] **Step 1: Check if StreamingOverlap is still imported anywhere**

Run: `cd /Users/kevinye/Development/sentient && grep -r "streaming-overlap" gateway/src/ --include="*.ts" | grep -v test | grep -v ".test."`

If nothing imports it (voice-turn.ts no longer does), it's dead code.

- [ ] **Step 2: Delete StreamingOverlap if unused**

```bash
rm gateway/src/pipeline/processors/streaming-overlap.ts
rm gateway/src/pipeline/processors/streaming-overlap.test.ts
```

- [ ] **Step 3: Run the full test suite**

Run: `cd /Users/kevinye/Development/sentient && source scripts/env.sh && bun run test -- --run`
Expected: All tests pass

- [ ] **Step 4: Run lint and typecheck**

Run: `cd /Users/kevinye/Development/sentient && source scripts/env.sh && bun run lint && bun run typecheck`
Expected: Clean

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(pipeline): remove StreamingOverlap — replaced by flattened decorator units"
```

---

### Task 7: End-to-end integration test

**Files:**
- Create: `gateway/src/pipeline/processors/emotion-pipeline-integration.test.ts`

A single integration test that wires the full flattened pipeline with mocks to verify the end-to-end flow.

- [ ] **Step 1: Write the integration test**

```typescript
// gateway/src/pipeline/processors/emotion-pipeline-integration.test.ts
import type { AudioFrame } from "@sentient/protocol";
import { createMockLLMProvider, createMockTTSProvider } from "@sentient/testing";
import { describe, expect, it } from "vitest";
import { createEmotionTagProcessor } from "./emotion-tag-processor.ts";
import { createEnglishBoundaryDetector } from "./en-boundary-detector.ts";
import type { PipelineChunk, PipelineOutput } from "./pipeline-types.ts";
import { createSentenceAggregatorTransform } from "./sentence-aggregator-transform.ts";
import { createTTSProcessor } from "./tts-processor.ts";
import { createTTSSender } from "./tts-sender.ts";

describe("Flattened pipeline integration", () => {
  it("flows LLM tokens through aggregation, emotion tagging, and TTS", async () => {
    // Mock LLM that adds emotion tags
    const emotionLLM = createMockLLMProvider({ response: "[happy] Hello world" });
    const mockTTS = createMockTTSProvider({ chunkCount: 2 });
    const signal = new AbortController().signal;

    // Build the pipeline
    const aggregate = createSentenceAggregatorTransform(createEnglishBoundaryDetector());
    const tag = createEmotionTagProcessor(emotionLLM, "test-model", {
      name: "test",
      language: "en",
      getSystemPrompt: () => "Add tags",
    });
    const send = createTTSSender(createTTSProcessor(mockTTS));

    // Simulate LLM token stream
    async function* tokenStream(): AsyncGenerator<PipelineChunk> {
      yield { display: "Hello ", speech: "Hello " };
      yield { display: "world", speech: "world" };
    }

    // Chain: tokens → aggregator → emotion → TTS
    const step1 = aggregate(tokenStream(), signal);
    const step2 = tag(step1, signal);
    const output: PipelineOutput[] = [];
    for await (const event of send(step2, signal)) {
      output.push(event);
    }

    // Verify display tokens passed through
    const texts = output.filter((o) => o.type === "text").map((o) => (o as { type: "text"; display: string }).display);
    expect(texts).toEqual(["Hello ", "world"]);

    // Verify TTS received tagged text
    expect(mockTTS.synthesizeCalls).toHaveLength(1);
    expect(mockTTS.synthesizeCalls[0]).toBe("[happy] Hello world");

    // Verify audio was produced
    const audioFrames = output.filter((o) => o.type === "audio");
    expect(audioFrames.length).toBeGreaterThan(0);
  });

  it("degrades gracefully when emotion LLM fails", async () => {
    const emotionLLM = createMockLLMProvider({ shouldFail: true });
    const mockTTS = createMockTTSProvider({ chunkCount: 1 });
    const signal = new AbortController().signal;

    const aggregate = createSentenceAggregatorTransform(createEnglishBoundaryDetector());
    const tag = createEmotionTagProcessor(emotionLLM, "test-model", {
      name: "test",
      language: "en",
      getSystemPrompt: () => "Add tags",
    });
    const send = createTTSSender(createTTSProcessor(mockTTS));

    async function* tokenStream(): AsyncGenerator<PipelineChunk> {
      yield { display: "Hello", speech: "Hello" };
    }

    const step1 = aggregate(tokenStream(), signal);
    const step2 = tag(step1, signal);
    const output: PipelineOutput[] = [];
    for await (const event of send(step2, signal)) {
      output.push(event);
    }

    // TTS should receive untagged text as fallback
    expect(mockTTS.synthesizeCalls[0]).toBe("Hello");
  });
});
```

- [ ] **Step 2: Run the integration test**

Run: `cd /Users/kevinye/Development/sentient && source scripts/env.sh && bun run test --filter 'emotion-pipeline-integration' -- --run`
Expected: PASS (2 tests)

- [ ] **Step 3: Run the full CI pipeline**

Run: `cd /Users/kevinye/Development/sentient && source scripts/env.sh && bun run ci`
Expected: All lint, typecheck, and tests pass

- [ ] **Step 4: Commit**

```bash
git add gateway/src/pipeline/processors/emotion-pipeline-integration.test.ts
git commit -m "test(pipeline): add end-to-end integration test for flattened emotion pipeline"
```
