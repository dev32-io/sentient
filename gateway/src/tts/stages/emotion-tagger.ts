import { getLog } from "../../logging/logger.ts";
import type { LLMMessage, LLMProvider } from "./emotion-tagger-llm-types.ts";

// ---------------------------------------------------------------------------
// EmotionTagger — stage 2 of the speak effect's streaming pipeline.
// Takes one or more utterance blocks and returns the same blocks enriched
// with inline `[pause]`, `[happy]`, `[curious]` etc. Fish Audio respects
// these tags at synthesis time.
//
// Two design choices worth calling out:
//
//  1. Batched input / batched output. Multiple blocks go in one LLM call
//     wrapped as `<text>...</text>` spans; the model answers with one
//     `<text>...</text>` span per input in order. We pay one LLM
//     round-trip per batch rather than N.
//
//  2. Multi-turn memory via `priorTurns`. Each call's (user, assistant)
//     pair threads forward. Provider prompt caching (OpenAI/Gemini
//     implicit, Anthropic ephemeral) keys on exact prefix, so appending
//     turns grows the cached prefix — the only uncached work each call
//     is the new user message + new assistant response. It also gives
//     the model context of its own earlier tagging choices so emotion
//     arcs stay consistent across the utterance.
//
// Safety rails:
//  - Per-call `timeoutMs` budget; on timeout the raw blocks are returned
//    untouched so TTS still gets audio.
//  - Any tagged output >3× its raw input length or empty → raw fallback
//    for that slot.
//  - Any exception → raw fallback for the whole batch.
// ---------------------------------------------------------------------------

const log = getLog(["sentient", "tts", "emotion-tagger"]);

export interface TagTurn {
  role: "user" | "assistant";
  content: string;
}

export interface EmotionTaggerDeps {
  readonly llmProvider: LLMProvider;
  readonly model: string;
  readonly systemPrompt: string;
  readonly timeoutMs: number;
}

/** Same shape as EmotionTaggerDeps — public alias used by callers that
 *  embed emotion tagging inside a larger pipeline (e.g., content-tts). */
export type EmotionTaggerOptions = EmotionTaggerDeps;

export interface TagBlocksResult {
  /** Tagged output, one string per input block, in the same order. */
  readonly tagged: string[];
  /**
   * `priorTurns` plus the user/assistant pair from this call. Pass to the
   * next tagBlocks call to keep the prompt cache warm and tagging style
   * consistent.
   */
  readonly nextTurns: TagTurn[];
}

const BATCH_INSTRUCTION =
  "\n\nWhen the user supplies multiple <text>...</text> spans, reply with " +
  "exactly one <text>...</text> span per input in the same order, with no " +
  "other text before, between, or after. The tagged content goes inside " +
  "each <text>...</text> span.";

const MAX_EXPANSION_RATIO = 3;

export async function tagBlocks(
  blocks: readonly string[],
  priorTurns: readonly TagTurn[],
  deps: EmotionTaggerDeps,
  signal: AbortSignal,
): Promise<TagBlocksResult> {
  if (blocks.length === 0) {
    return { tagged: [], nextTurns: [...priorTurns] };
  }

  const startTime = Date.now();
  const rawInputChars = blocks.reduce((n, b) => n + b.length, 0);
  log.debug("batch-start", {
    blockCount: blocks.length,
    inputChars: rawInputChars,
    priorTurnCount: priorTurns.length,
    model: deps.model,
    timeoutMs: deps.timeoutMs,
  });
  log.debug("batch-blocks", {
    blocks: blocks.map((b, i) => ({ i, length: b.length, preview: truncate(b, 80) })),
  });

  const userContent = formatUserContent(blocks);
  const messages: LLMMessage[] = [
    { role: "system", content: deps.systemPrompt + BATCH_INSTRUCTION },
    ...priorTurns.map((t) => ({ role: t.role, content: t.content })),
    { role: "user", content: userContent },
  ];

  const { raw, timedOut, errored } = await callLlm(messages, deps, signal);
  const elapsed = Date.now() - startTime;

  if (errored || timedOut || raw === null) {
    log.warn("batch-fallback-to-raw", {
      reason: errored ? "error" : timedOut ? "timeout" : "empty-response",
      elapsedMs: elapsed,
      blockCount: blocks.length,
    });
    return {
      tagged: [...blocks],
      nextTurns: [...priorTurns],
    };
  }

  const parsed = parseResponse(raw, blocks.length);
  if (parsed === null) {
    log.warn("batch-parse-failed", {
      elapsedMs: elapsed,
      blockCount: blocks.length,
      rawPreview: truncate(raw, 200),
    });
    return {
      tagged: [...blocks],
      nextTurns: [...priorTurns],
    };
  }

  const tagged = parsed.map((t, i) => verifyOrFallback(blocks[i] ?? "", t, i));

  log.info("batch-complete", {
    elapsedMs: elapsed,
    blockCount: blocks.length,
    inputChars: rawInputChars,
    outputChars: tagged.reduce((n, b) => n + b.length, 0),
    anyFallback: tagged.some((t, i) => t === blocks[i]),
  });
  log.debug("batch-result", {
    results: tagged.map((t, i) => ({ i, length: t.length, preview: truncate(t, 120) })),
  });

  const assistantContent = formatAssistantContent(tagged);
  const nextTurns: TagTurn[] = [
    ...priorTurns,
    { role: "user", content: userContent },
    { role: "assistant", content: assistantContent },
  ];

  return { tagged, nextTurns };
}

// ---------------------------------------------------------------------------
// LLM call with timeout
// ---------------------------------------------------------------------------

interface CallResult {
  readonly raw: string | null;
  readonly timedOut: boolean;
  readonly errored: boolean;
}

async function callLlm(messages: LLMMessage[], deps: EmotionTaggerDeps, outerSignal: AbortSignal): Promise<CallResult> {
  const inner = new AbortController();
  const onAbort = () => inner.abort();
  outerSignal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => inner.abort(), deps.timeoutMs);

  let raw = "";
  let timedOut = false;
  let errored = false;

  try {
    for await (const chunk of deps.llmProvider.stream({
      model: deps.model,
      messages,
      signal: inner.signal,
      maxTokens: 1024,
      temperature: 0.3,
    })) {
      if (chunk.type === "text") raw += chunk.content;
    }
  } catch (err) {
    if (inner.signal.aborted && !outerSignal.aborted) {
      timedOut = true;
    } else {
      errored = true;
      log.warn("llm-error", { message: err instanceof Error ? err.message : String(err) });
    }
  } finally {
    clearTimeout(timer);
    outerSignal.removeEventListener("abort", onAbort);
  }

  if (outerSignal.aborted) {
    return { raw: null, timedOut: false, errored: true };
  }
  if (timedOut) return { raw: null, timedOut: true, errored: false };
  if (errored) return { raw: null, timedOut: false, errored: true };

  const trimmed = raw.trim();
  log.debug("llm-response", { chars: trimmed.length, preview: truncate(trimmed, 200) });
  return { raw: trimmed.length > 0 ? trimmed : null, timedOut: false, errored: false };
}

// ---------------------------------------------------------------------------
// Wire format — <text>...</text> spans in both directions
// ---------------------------------------------------------------------------

function formatUserContent(blocks: readonly string[]): string {
  return blocks.map((b) => `<text>${b}</text>`).join("\n");
}

function formatAssistantContent(tagged: readonly string[]): string {
  return tagged.map((t) => `<text>${t}</text>`).join("\n");
}

const TEXT_SPAN_RE = /<text>([\s\S]*?)<\/text>/g;

function parseResponse(raw: string, expectedCount: number): string[] | null {
  const matches = [...raw.matchAll(TEXT_SPAN_RE)];
  if (matches.length === expectedCount) {
    return matches.map((m) => (m[1] ?? "").trim());
  }
  // Single-block fallback: some models emit the tagged text without
  // re-wrapping it. Accept the raw trimmed response as the only block.
  if (expectedCount === 1 && matches.length === 0 && raw.length > 0) {
    return [raw];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Per-block safety guard
// ---------------------------------------------------------------------------

function verifyOrFallback(original: string, candidate: string, index: number): string {
  const trimmed = candidate.trim();
  if (trimmed.length === 0) {
    log.warn("block-empty-fallback", { index, originalLength: original.length });
    return original;
  }
  if (trimmed.length > original.length * MAX_EXPANSION_RATIO) {
    log.warn("block-overrun-fallback", {
      index,
      originalLength: original.length,
      taggedLength: trimmed.length,
      ratio: (trimmed.length / Math.max(original.length, 1)).toFixed(2),
    });
    return original;
  }
  return trimmed;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n)}…`;
}
