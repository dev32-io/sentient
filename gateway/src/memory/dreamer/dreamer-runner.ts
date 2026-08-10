// Dreamer map-stage runner + checkpoint (memory-system spec §8 "Dreamer —
// nightly distillation"). This is the CHUNKED, YIELD-AWARE, CHECKPOINTED map
// half of the nightly consolidation: one call per session window that distills
// the session into an episode summary plus fact candidates.
//
// WHY ITS OWN RUNNER AND NOT THE AUXILIARY SEAM (spec §8, global constraint).
// The auxiliary seam is session-bound, one-shot, and truncates its input to a
// titling-shaped ~4k chars — the wrong shape for a batch distillation of a whole
// day. So the dreamer makes its OWN `provider.stream` calls, exactly the way
// compaction.ts does (compaction.ts:239-252): collect the text stream, bound
// the output with the workload's own `max_output_tokens`, tools:[] because a
// summarizer that can act is an unmediated side-effecting surface.
//
// TWO PROPERTIES TO HOLD BEFORE EDITING:
//   1. runMapStage NEVER advances the mark. The transaction owner (T22 full
//      dream; T20 episodic slice) advances the durable high-water mark ONLY
//      after the canonical files are committed, so a crash mid-map redoes the
//      whole window on the next run — idempotent by construction (spec §8
//      "Checkpointing"). readMark/advanceMark live here because the mark file
//      is memory-dir state, but the ORDER is the caller's to enforce.
//   2. runMapStage NEVER throws. A session that fails both map attempts is
//      SKIPPED (WARN), the rest proceed — one poisoned session must not sink
//      the night (error-handling rule: no throwing from business logic).
//
// No memory content is logged (global constraint) — chars, tokens, seqs, and
// ids only; never a transcript, an episode, or a fact.

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { OrchestratorConfig } from "@sentient/config";
import { z } from "zod";
import { getLog } from "../../logging/logger.js";
import type { ProviderClient, ProviderStreamChunk } from "../../provider/provider-client.js";
import type { ChatMessage } from "../../store/model-projection.js";
import type { DreamSession, DreamWindow } from "../../store/project-for-dreaming.js";
import type { UserId } from "../../user-auth/user-id.js";
import { type ReduceOp, reduceReplySchema } from "./reconciler.js";

const log = getLog(["sentient", "memory", "dreamer"]);

// ---------------------------------------------------------------------------
// Public types (T22's reduce stage compiles against these)
// ---------------------------------------------------------------------------

/** The seq range in the source session that grounds a fact — the exact shape
 *  the map prompt (`system_prompts/dreamer/map.md`) is instructed to emit. */
export interface DreamFactSource {
  fromSeq: number;
  toSeq: number;
}

/** One distilled fact candidate. `durable` = carry forward; `ephemeral` =
 *  true only for this session (spec §8 Task 2). */
export interface DreamFact {
  text: string;
  kind: "durable" | "ephemeral";
  sources: DreamFactSource[];
}

/** One session's map result: episode narrative + fact candidates, carrying the
 *  `containsToolDerived` taint bit straight through from the input projection
 *  (spec §3.1 — no laundering to `assistant` through the LLM pass). */
export interface DreamSessionResult {
  sessionId: string;
  episode: string;
  facts: DreamFact[];
  containsToolDerived: boolean;
}

/** The whole map stage's output for one window. */
export interface DreamResult {
  sessions: DreamSessionResult[];
}

/** The distilled memory the reduce stage reconciles today's candidates against:
 *  the current `MEMORY.md` body plus every topic file, path + contents. Read
 *  from the store by the transaction owner and handed in — the runner never
 *  touches the store itself. */
export interface CurrentMemory {
  core: string;
  topics: Array<{ slug: string; body: string }>;
}

/** The durable high-water mark on the session-store entry sequence, per user. */
export interface DreamMark {
  /** Last entry seq consolidated. `(lastSeq, maxSeq]` is the next window. */
  lastSeq: number;
  /** ISO-8601 timestamp of the last completed run, or null before the first. */
  lastRunAt: string | null;
}

/** The user identity + memory dir a map run operates on. */
export interface DreamUser {
  userId: UserId;
  /** Absolute path to the user's memory dir (where the mark file lives). */
  memoryDir: string;
}

/** The slice of turn-state the dreamer polls to yield to live conversation.
 *  Minimal on purpose: the caller (T20) adapts the real registry to this. */
export interface TurnStateView {
  hasActiveTurn(): boolean;
}

export interface DreamRunnerDeps {
  provider: ProviderClient;
  /** Baked-or-override template loader (`system_prompts/dreamer/<name>.md`).
   *  Injected, never read from disk here, so tests drive it with a string. */
  loadTemplate: (name: "map" | "reduce") => string;
  /** Turn-state lookup for the yield gate — polled before every provider call. */
  turnStateFor: (userId: UserId) => TurnStateView;
  /** `orchestrator.memory` — `cfg.dreamer.*` holds every tunable this uses. */
  cfg: OrchestratorConfig["memory"];
  /** Provider model id, for the per-call INFO log's `model=` field only. The
   *  ProviderClient owns the actual model selection; this is a label. */
  model: string;
  /** Injected clock (ms). Defaults to Date.now — tests pass a fake. */
  now?: () => number;
  /** Injected sleep, for the yield poll. Defaults to a real timer — tests pass
   *  a resolved-immediately stub so the poll never actually waits. */
  sleep?: (ms: number) => Promise<void>;
}

export interface DreamRunner {
  readMark(dir: string): DreamMark;
  advanceMark(dir: string, seq: number, runAt: string): void;
  runMapStage(user: DreamUser, window: DreamWindow): Promise<DreamResult>;
  /** The night's SECOND call: reconcile today's durable fact candidates against
   *  the current distilled memory into a batch of reduce ops. ONE call, ONE
   *  retry on parse/schema failure; `null` on double-fail (the transaction then
   *  completes episodic-only, WARN — a broken reduce must not lose the episodes).
   *  An empty `ops` array is a valid, common answer (a quiet night). Never throws
   *  (this file's property 2). */
  runReduceStage(user: DreamUser, result: DreamResult, currentMemory: CurrentMemory): Promise<ReduceOp[] | null>;
}

// ---------------------------------------------------------------------------
// Constants (format contracts / code details — not operator knobs)
// ---------------------------------------------------------------------------

const MARK_FILENAME = ".dream-mark.json";
const TRANSCRIPT_PLACEHOLDER = "{{transcript}}";
/** reduce.md's three placeholders (spec §8 reduce). */
const MEMORY_MD_PLACEHOLDER = "{{memory_md}}";
const TOPICS_PLACEHOLDER = "{{topics}}";
const FACT_CANDIDATES_PLACEHOLDER = "{{fact_candidates}}";
/** Joins the per-chunk episode paragraphs of a split session into one episode. */
const EPISODE_JOIN = "\n\n";
/** Rendered when the day produced no durable fact candidates — the reduce prompt
 *  still runs (the model may FLAG_STALE existing lines the day mooted). */
const NO_FACT_CANDIDATES = "(no durable fact candidates today)";
const TAINT_ANNOTATION = "tool-derived";
const CLEAN_ANNOTATION = "user-speech";

/** The two dreamer LLM phases — a label on every per-call log line. */
type DreamPhase = "map" | "reduce";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const factSourceSchema = z.object({
  fromSeq: z.number(),
  toSeq: z.number(),
});

const factSchema = z.object({
  text: z.string(),
  kind: z.enum(["durable", "ephemeral"]),
  sources: z.array(factSourceSchema),
});

/** The map call's required output shape — exactly `map.md`'s "## Output". */
const mapOutputSchema = z.object({
  episode: z.string(),
  facts: z.array(factSchema),
});
type MapOutput = z.output<typeof mapOutputSchema>;

const markSchema = z.object({
  lastSeq: z.number(),
  lastRunAt: z.string().nullable(),
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Splits a session transcript into chunks each ≤ `budget` chars, on line
 * boundaries so a `#seq …` line is never cut in half. A single line longer
 * than the budget is hard-sliced — the budget is a hard ceiling every chunk
 * (and therefore every provider request) honors. An empty transcript yields
 * one empty chunk, so every session still gets at least one map call.
 */
export function chunkTranscript(text: string, budget: number): string[] {
  if (text.length <= budget) return [text];

  const chunks: string[] = [];
  let current = "";
  const flush = (): void => {
    if (current.length > 0) {
      chunks.push(current);
      current = "";
    }
  };

  for (const line of text.split("\n")) {
    if (line.length > budget) {
      flush();
      for (let i = 0; i < line.length; i += budget) chunks.push(line.slice(i, i + budget));
      continue;
    }
    const candidate = current.length === 0 ? line : `${current}\n${line}`;
    if (candidate.length > budget) {
      flush();
      current = line;
    } else {
      current = candidate;
    }
  }
  flush();
  return chunks.length > 0 ? chunks : [""];
}

/**
 * The JSON object inside a model response, or null. Models wrap structured
 * answers in ``` fences and leading prose regardless of the prompt, so the
 * first `{` through the last `}` is the pragmatic extraction (auxiliary-task.ts
 * precedent).
 */
function extractJson(raw: string): unknown | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** Union the fact candidates of a split session's chunks, first-occurrence
 *  order, deduped on the whole fact so a claim repeated across chunk boundaries
 *  lands once. Deterministic: same chunks in, same facts out. */
function unionFacts(perChunk: DreamFact[][]): DreamFact[] {
  const seen = new Set<string>();
  const merged: DreamFact[] = [];
  for (const facts of perChunk) {
    for (const fact of facts) {
      const key = JSON.stringify(fact);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(fact);
    }
  }
  return merged;
}

/** Substitutes EVERY occurrence of `placeholder` with `value` without treating
 *  the value as a regex replacement (a literal `$1`/`$&` in memory content must
 *  survive verbatim — `String.replace` would mangle it). */
function replaceAll(template: string, placeholder: string, value: string): string {
  return template.split(placeholder).join(value);
}

/** Renders the current topic files for the reduce prompt's `{{topics}}` block:
 *  one `--- topics/<slug> ---`-delimited section per topic, path then body. An
 *  empty set renders a stable marker so the block is never blank. */
function renderTopics(topics: Array<{ slug: string; body: string }>): string {
  if (topics.length === 0) return "(no topic files yet)";
  return topics.map((t) => `--- topics/${t.slug} ---\n${t.body}`).join("\n\n");
}

/** Renders the day's DURABLE fact candidates for `{{fact_candidates}}`: one line
 *  per fact with its source seq range(s) AND its session's taint annotation, so
 *  the reduce model sees which candidates came from untrusted (tool-derived)
 *  input. Ephemeral facts are dropped — they are never carried into MEMORY.md.
 *  Deterministic: same DreamResult in, same block out. */
function renderFactCandidates(result: DreamResult): string {
  const lines: string[] = [];
  for (const session of result.sessions) {
    const taint = session.containsToolDerived ? TAINT_ANNOTATION : CLEAN_ANNOTATION;
    for (const fact of session.facts) {
      if (fact.kind !== "durable") continue;
      const seqs = fact.sources.map((s) => `${s.fromSeq}-${s.toSeq}`).join(", ");
      lines.push(`- ${fact.text}  [sources: ${seqs || "none"}; session ${session.sessionId} (${taint})]`);
    }
  }
  return lines.length > 0 ? lines.join("\n") : NO_FACT_CANDIDATES;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export function createDreamRunner(deps: DreamRunnerDeps): DreamRunner {
  const now = deps.now ?? ((): number => Date.now());
  const sleep = deps.sleep ?? ((ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)));
  const dreamerCfg = deps.cfg.dreamer;

  /** Poll-wait while the user has a turn in flight — the dreamer is low
   *  priority and never competes with live conversation (spec §8). Re-checked
   *  every `yield_check_ms`; the injected sleep makes this instant in tests. */
  async function yieldUntilIdle(userId: UserId): Promise<void> {
    const view = deps.turnStateFor(userId);
    let waits = 0;
    while (view.hasActiveTurn()) {
      waits += 1;
      log.debug("dreamer.yield.waiting", { userId, waits, intervalMs: dreamerCfg.yield_check_ms });
      await sleep(dreamerCfg.yield_check_ms);
    }
  }

  /** One provider round trip, collected as text. Null on any provider failure —
   *  never a throw (this file's property 2). Logs the per-call INFO line with
   *  input chars, output tokens, latency, and model — no content. */
  async function streamOnce(userId: UserId, phase: DreamPhase, prompt: string): Promise<string | null> {
    const messages: ChatMessage[] = [{ role: "user", content: prompt }];
    const startedAt = now();
    let stream: AsyncGenerator<ProviderStreamChunk> | null = null;
    let answer = "";
    let completionTokens = 0;
    try {
      stream = deps.provider.stream({
        messages,
        tools: [],
        signal: new AbortController().signal,
        maxOutputTokens: dreamerCfg.max_output_tokens,
      });
      for await (const chunk of stream) {
        if (chunk.type === "text") answer += chunk.content;
        if (chunk.type === "done") completionTokens = chunk.usage?.completionTokens ?? 0;
      }
    } catch (err) {
      log.warn("dreamer.call.failed", {
        userId,
        phase,
        chars: prompt.length,
        reason: err instanceof Error ? err.message : String(err),
      });
      return null;
    } finally {
      try {
        await stream?.return(undefined);
      } catch (err) {
        log.warn("dreamer.call.cleanup-failed", { userId, reason: err instanceof Error ? err.message : String(err) });
      }
    }
    log.info("dreamer.call", {
      phase,
      chars: prompt.length,
      tokens: completionTokens,
      ms: now() - startedAt,
      model: deps.model,
    });
    return answer;
  }

  /** One map attempt: yield, stream, extract, validate. Null on any failure —
   *  provider error, unparseable, or schema mismatch — so the caller decides
   *  retry vs skip uniformly. */
  async function attemptMap(userId: UserId, template: string, transcript: string): Promise<MapOutput | null> {
    await yieldUntilIdle(userId);
    const prompt = replaceAll(template, TRANSCRIPT_PLACEHOLDER, transcript);
    const raw = await streamOnce(userId, "map", prompt);
    if (raw === null) return null;
    const json = extractJson(raw);
    if (json === null) return null;
    const parsed = mapOutputSchema.safeParse(json);
    return parsed.success ? parsed.data : null;
  }

  /** One map call for one chunk, with ONE retry on parse/validation failure
   *  (spec §8). Null iff both attempts failed — the caller skips the session. */
  async function mapChunk(userId: UserId, template: string, transcript: string): Promise<MapOutput | null> {
    const first = await attemptMap(userId, template, transcript);
    if (first !== null) return first;
    log.warn("dreamer.call.retry", { userId, phase: "map", chars: transcript.length });
    return attemptMap(userId, template, transcript);
  }

  /** Map one session: chunk, map each chunk (retry-guarded), merge. Null iff any
   *  chunk failed both attempts — a partial session result would misattribute
   *  facts across a dropped span, so the whole session is skipped. */
  async function mapSession(
    userId: UserId,
    template: string,
    session: DreamSession,
  ): Promise<DreamSessionResult | null> {
    const chunks = chunkTranscript(session.text, dreamerCfg.max_input_chars_per_call);
    const episodes: string[] = [];
    const factsPerChunk: DreamFact[][] = [];
    for (const chunk of chunks) {
      const result = await mapChunk(userId, template, chunk);
      if (result === null) return null;
      episodes.push(result.episode);
      factsPerChunk.push(result.facts);
    }
    return {
      sessionId: session.sessionId,
      episode: episodes.join(EPISODE_JOIN),
      facts: unionFacts(factsPerChunk),
      containsToolDerived: session.containsToolDerived,
    };
  }

  async function runMapStage(user: DreamUser, window: DreamWindow): Promise<DreamResult> {
    const template = deps.loadTemplate("map");
    const sessions: DreamSessionResult[] = [];
    let skipped = 0;
    for (const session of window.sessions) {
      const result = await mapSession(user.userId, template, session);
      if (result === null) {
        skipped += 1;
        log.warn("dreamer.session.skipped", {
          userId: user.userId,
          sessionId: session.sessionId,
          reason: "map-failed-after-retry",
        });
        continue;
      }
      sessions.push(result);
    }
    log.info("dreamer.map.done", {
      userId: user.userId,
      sessionsIn: window.sessions.length,
      sessionsOut: sessions.length,
      skipped,
    });
    return { sessions };
  }

  /** One reduce attempt: yield, render the three placeholders, stream, extract,
   *  validate against the shared reduce schema. Null on any failure (provider
   *  error, unparseable, or schema mismatch) so `runReduceStage` decides retry
   *  vs give-up uniformly — exactly the map stage's shape. */
  async function attemptReduce(userId: UserId, prompt: string): Promise<ReduceOp[] | null> {
    await yieldUntilIdle(userId);
    const raw = await streamOnce(userId, "reduce", prompt);
    if (raw === null) return null;
    const json = extractJson(raw);
    if (json === null) return null;
    const parsed = reduceReplySchema.safeParse(json);
    return parsed.success ? parsed.data.ops : null;
  }

  async function runReduceStage(
    user: DreamUser,
    result: DreamResult,
    currentMemory: CurrentMemory,
  ): Promise<ReduceOp[] | null> {
    const template = deps.loadTemplate("reduce");
    const prompt = replaceAll(
      replaceAll(
        replaceAll(template, MEMORY_MD_PLACEHOLDER, currentMemory.core),
        TOPICS_PLACEHOLDER,
        renderTopics(currentMemory.topics),
      ),
      FACT_CANDIDATES_PLACEHOLDER,
      renderFactCandidates(result),
    );

    const first = await attemptReduce(user.userId, prompt);
    if (first !== null) {
      log.info("dreamer.reduce.done", { userId: user.userId, ops: first.length });
      return first;
    }
    log.warn("dreamer.call.retry", { userId: user.userId, phase: "reduce", chars: prompt.length });
    const second = await attemptReduce(user.userId, prompt);
    if (second === null) {
      log.warn("dreamer.reduce.failed", { userId: user.userId, reason: "unparseable-after-retry" });
      return null;
    }
    log.info("dreamer.reduce.done", { userId: user.userId, ops: second.length });
    return second;
  }

  return {
    readMark,
    advanceMark,
    runMapStage,
    runReduceStage,
  };
}

// ---------------------------------------------------------------------------
// Checkpoint mark (memory-dir state — read here, ADVANCED BY THE CALLER)
// ---------------------------------------------------------------------------

/** Reads `<dir>/.dream-mark.json`. A missing file is the pre-first-run state:
 *  `{lastSeq: 0, lastRunAt: null}`, so the first window is the whole history. A
 *  present-but-corrupt file fails the same way (with a WARN) — a garbled mark
 *  must never be read as a large `lastSeq` that silently skips real history. */
export function readMark(dir: string): DreamMark {
  const path = join(dir, MARK_FILENAME);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { lastSeq: 0, lastRunAt: null };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    log.warn("dreamer.mark.unparseable", { dir });
    return { lastSeq: 0, lastRunAt: null };
  }
  const parsed = markSchema.safeParse(json);
  if (!parsed.success) {
    log.warn("dreamer.mark.invalid", { dir, issue: parsed.error.issues[0]?.message ?? "unknown" });
    return { lastSeq: 0, lastRunAt: null };
  }
  return parsed.data;
}

/** Atomically advances the mark (tmp + rename, all-or-nothing). CALLED BY THE
 *  TRANSACTION OWNER after canonical writes commit — never by runMapStage (spec
 *  §8: a crash before this redoes the window). */
export function advanceMark(dir: string, seq: number, runAt: string): void {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, MARK_FILENAME);
  const tmpPath = join(dir, `.${basename(MARK_FILENAME)}.tmp-${randomUUID()}`);
  const mark: DreamMark = { lastSeq: seq, lastRunAt: runAt };
  writeFileSync(tmpPath, JSON.stringify(mark, null, 2), "utf8");
  renameSync(tmpPath, path);
  log.info("dreamer.mark.advanced", { dir, lastSeq: seq });
}
