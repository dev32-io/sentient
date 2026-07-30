// Compaction (spec §8 + §3.4) — the PRODUCER of `kind:"compaction"` entries.
//
// WHY GATEWAY-SIDE AND NOT PROVIDER-SIDE. Spec §8 specifies OpenAI-compatible
// server-side compaction (`context_management` + `compact_threshold`).
// Verified against the pinned SDK (openai@6.49.0): those fields exist ONLY on
// the Responses API (resources/responses/responses.d.ts:6954, :7216) and are
// absent from ChatCompletionCreateParamsBase — and Chat Completions is what
// openai-provider.ts calls and what spec §4.1 commits the gateway to. Neither
// configured provider (OpenRouter, Ollama Cloud) is verified to serve
// Responses at all. So v1 runs the summarization itself, through the same
// ProviderClient, and produces exactly the entry §3.4 specifies. Switching to
// the provider-native path later is a provider-layer change: the entry, both
// projections, and these config keys are identical either way.
//
// THE ONE THING TO UNDERSTAND BEFORE EDITING THIS FILE. model-projection.ts
// slices POSITIONALLY: `sliceFromLatestCompaction()` keeps
// `entries.slice(lastCompactionIdx + 1)` and never reads
// `compactedThroughSeq`. A marker therefore supersedes EVERY entry appended
// before it. Three consequences, all load-bearing:
//   1. The boundary is always the store's current tail. An unsafe tail is
//      REFUSED (retry at the next turn end), never snapped backwards — a
//      backwards-snapped boundary would drop entries from the model window
//      without summarizing them, and `compactedThroughSeq` would be a lie.
//   2. "Keep the last N turns" cannot mean "leave them after the marker";
//      nothing survives after an append-only marker. Those turns are
//      rendered VERBATIM into the marker's own text. §3.4 explicitly allows
//      the two projections to diverge — the client still renders every
//      original entry, straight from the store.
//   3. The summarization round trip is the only await here, and
//      SessionRuntime.submit() can append a steer during it. A marker
//      appended over that entry would make it invisible to the model
//      FOREVER, so the tail seq is re-checked immediately before the append
//      and the whole compaction is skipped if it moved. Skipping costs one
//      turn of over-long context; not skipping costs the user's message.
//
// Never throws: every failure path returns a typed outcome (error-handling
// rule — no throwing from business logic). The caller (session-runtime.ts)
// is on the turn-settle path and must stay total.

import type { OrchestratorConfig } from "@sentient/config";
import { getLog } from "../logging/logger.js";
import type { ProviderClient } from "../provider/provider-client.js";
import type { NewSessionEntry, SessionEntry } from "../store/entry-types.js";
import type { ChatMessage } from "../store/model-projection.js";
import { projectForModel } from "../store/model-projection.js";
import type { SessionStore } from "../store/session-store.js";
import type { UserId } from "../user-auth/user-id.js";

const log = getLog(["sentient", "runtime", "compaction"]);

// Estimator internals, NOT operator knobs — the operator knob is
// `orchestrator.compaction.compact_threshold_tokens`. ~4 chars/token is the
// standard BPE average for latin script; CJK runs ~1 token/char, and this
// gateway is bilingual en/zh (stt.language: auto), so counting CJK at a
// quarter would under-count a Chinese session ~4x and compaction would never
// fire. Swapping in a real tokenizer later changes only `estimateTokens`.
const CHARS_PER_TOKEN_LATIN = 4;
// Kana + CJK ideographs + compatibility ideographs, written as escapes so
// the source stays ASCII-safe in every editor and diff tool.
const CJK_CHAR = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/gu;

// Marker layout. Fixed strings, not config: they are the format contract
// between this producer and the model that reads the marker back.
const SUMMARY_HEADER = "[Earlier conversation — summarized]";
const VERBATIM_HEADER = "[Recent conversation — verbatim]";
const PRIOR_SUMMARY_HEADER = "[Summary of everything before that]";

export type CompactionReason =
  | "compacted"
  | "disabled"
  | "below-threshold"
  | "unsafe-boundary"
  | "nothing-to-summarize"
  | "raced-with-append"
  | "empty-summary"
  | "aborted"
  | "provider-error";

export interface CompactionOutcome {
  compacted: boolean;
  reason: CompactionReason;
  estimatedTokens: number;
  compactedThroughSeq: number | null;
}

export interface CompactionDeps {
  store: SessionStore;
  provider: ProviderClient;
  sessionId: string;
  userId: UserId;
  /** The turn that just ended. Stamped on the marker because every row needs
   *  a turnId; the client projection skips markers, so it never renders. */
  turnId: string;
  config: OrchestratorConfig["compaction"];
  /** From `loadCompactionSummarizerPrompt()` — injected, never read from
   *  disk here, so tests drive this with a fixed string. */
  summarizerPrompt: string;
  /** The ended turn's AbortSignal. `SessionRuntime.dispose()` aborts it and
   *  closes the store, so it is re-checked after the summarization round
   *  trip and before the append. */
  signal: AbortSignal;
}

function messageChars(m: ChatMessage): string {
  const parts: string[] = [m.content ?? ""];
  for (const tc of m.tool_calls ?? []) parts.push(tc.function.name, tc.function.arguments);
  return parts.join("");
}

/** Rough model-window size. Deliberately provider-independent: an exact
 *  count would have to come from a `usage.prompt_tokens` plumbed out of
 *  react-loop.ts, and this decides one boolean against an operator-tuned
 *  threshold. */
export function estimateTokens(messages: ChatMessage[]): number {
  let cjk = 0;
  let latin = 0;
  for (const m of messages) {
    const s = messageChars(m);
    const cjkCount = s.match(CJK_CHAR)?.length ?? 0;
    cjk += cjkCount;
    latin += s.length - cjkCount;
  }
  return Math.ceil(cjk + latin / CHARS_PER_TOKEN_LATIN);
}

/** Entries after the latest marker — the only region a new marker may
 *  summarize — plus that marker's own text, carried into the new summary so
 *  successive compactions never drop the older chain. */
export function regionAfterLatestMarker(entries: SessionEntry[]): {
  priorSummary: string | null;
  region: SessionEntry[];
} {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (entries[i]?.kind === "compaction") {
      return { priorSummary: entries[i]?.text ?? "", region: entries.slice(i + 1) };
    }
  }
  return { priorSummary: null, region: entries };
}

/** Splits a region into "summarize these" / "keep these verbatim" at a TURN
 *  boundary — never inside a turn, so a tool_call and its tool_result can
 *  never land on opposite sides (both carry the same turnId, and a turn's
 *  entries are contiguous by construction: react-loop.ts and
 *  session-runtime.ts only ever append under the running turnId). Returns
 *  null when the region holds no more than `keepRecentTurns` turns — there
 *  is nothing to summarize yet. */
export function splitAtTurnBoundary(
  region: SessionEntry[],
  keepRecentTurns: number,
): { older: SessionEntry[]; recent: SessionEntry[] } | null {
  const turnIds: string[] = [];
  for (const e of region) {
    if (turnIds[turnIds.length - 1] !== e.turnId) turnIds.push(e.turnId);
  }
  if (turnIds.length <= keepRecentTurns) return null;

  const keptIds = new Set(turnIds.slice(turnIds.length - keepRecentTurns));
  const splitIdx = keepRecentTurns === 0 ? region.length : region.findIndex((e) => keptIds.has(e.turnId));
  if (splitIdx <= 0) return null;
  return { older: region.slice(0, splitIdx), recent: region.slice(splitIdx) };
}

/** The boundary is ALWAYS the store's tail — a positional marker can
 *  honestly cover nothing else. So this REFUSES an unsafe tail rather than
 *  moving the boundary: a trailing `tool_call` means its `tool_result` may
 *  still be coming (a turn aborted mid-dispatch), and a marker wedged
 *  between the two leaves the next slice starting on a dangling role:"tool"
 *  message. Refuse; the next turn end tries again. A trailing `compaction`
 *  means nothing new has happened since the last marker. */
export function safeBoundarySeq(entries: SessionEntry[]): number | null {
  const tail = entries[entries.length - 1];
  if (!tail) return null;
  if (tail.kind === "tool_call" || tail.kind === "compaction") return null;
  return tail.seq;
}

function renderEntry(e: SessionEntry): string | null {
  switch (e.kind) {
    case "user":
      return `user: ${e.text ?? ""}`;
    case "trigger":
      return `event: ${e.text ?? ""}`;
    case "assistant":
      return e.cutoff ? `assistant (cut off — ${e.cutoff}): ${e.text ?? ""}` : `assistant: ${e.text ?? ""}`;
    case "tool_call":
      return `tool_call ${e.toolName ?? "unknown"}(${e.toolArgs ?? "{}"})`;
    case "tool_result":
      return `tool_result ${e.toolName ?? "unknown"} -> ${e.toolArgs ?? ""}`;
    case "system":
      return `system: ${e.text ?? ""}`;
    default:
      // A prior marker rides as `priorSummary`, never inline; an unknown
      // kind has no defined rendering.
      return null;
  }
}

export function renderTranscript(entries: SessionEntry[]): string {
  return entries
    .flatMap((e) => {
      const line = renderEntry(e);
      return line === null ? [] : [line];
    })
    .join("\n");
}

function skip(reason: CompactionReason, estimatedTokens: number): CompactionOutcome {
  return { compacted: false, reason, estimatedTokens, compactedThroughSeq: null };
}

/** One summarization round trip. Returns null on any provider failure — the
 *  caller turns that into a skip, never a throw. `tools: []` is deliberate:
 *  a summarizer that can act is a side-effecting surface nobody mediates
 *  (spec §2.2). The per-request deadline is the ProviderClient's own
 *  (`orchestrator.provider.request_timeout_ms`). */
async function summarize(deps: CompactionDeps, transcript: string): Promise<string | null> {
  const messages: ChatMessage[] = [
    { role: "system", content: deps.summarizerPrompt },
    { role: "user", content: transcript },
  ];
  const stream = deps.provider.stream({
    messages,
    tools: [],
    signal: deps.signal,
    // The summarizer's OWN budget, not the loop's answer cap — see the config
    // key's comment. Without it a reasoning model spends the whole cap on its
    // reasoning channel and returns finish_reason:"length" with no text.
    maxOutputTokens: deps.config.summarizer_max_output_tokens,
  });
  let summary = "";
  try {
    for await (const chunk of stream) {
      if (deps.signal.aborted) break;
      if (chunk.type === "text") summary += chunk.content;
    }
  } catch (err) {
    log.warn("compaction.summarize.failed", {
      userId: deps.userId,
      sessionId: deps.sessionId,
      turnId: deps.turnId,
      reason: err instanceof Error ? err.message : String(err),
    });
    return null;
  } finally {
    await stream.return(undefined);
  }
  return summary;
}

export async function maybeCompact(deps: CompactionDeps): Promise<CompactionOutcome> {
  const { store, sessionId, userId, turnId, config, signal } = deps;

  if (!config.enabled) return skip("disabled", 0);

  const entries = store.readSession(sessionId);
  const estimatedTokens = estimateTokens(projectForModel(entries));
  if (estimatedTokens < config.compact_threshold_tokens) {
    log.debug("compaction.below-threshold", {
      userId,
      sessionId,
      turnId,
      estimatedTokens,
      thresholdTokens: config.compact_threshold_tokens,
    });
    return skip("below-threshold", estimatedTokens);
  }

  const boundarySeq = safeBoundarySeq(entries);
  if (boundarySeq === null) {
    log.info("compaction.skipped", {
      userId,
      sessionId,
      turnId,
      reason: "unsafe-boundary",
      tailKind: entries[entries.length - 1]?.kind ?? null,
      estimatedTokens,
    });
    return skip("unsafe-boundary", estimatedTokens);
  }

  const { priorSummary, region } = regionAfterLatestMarker(entries);
  const split = splitAtTurnBoundary(region, config.keep_recent_turns);
  if (split === null) {
    log.info("compaction.skipped", {
      userId,
      sessionId,
      turnId,
      reason: "nothing-to-summarize",
      regionEntries: region.length,
      keepRecentTurns: config.keep_recent_turns,
      estimatedTokens,
    });
    return skip("nothing-to-summarize", estimatedTokens);
  }

  const older = renderTranscript(split.older);
  const transcript = priorSummary ? `${PRIOR_SUMMARY_HEADER}\n${priorSummary}\n\n${older}` : older;

  log.info("compaction.summarizing", {
    userId,
    sessionId,
    turnId,
    estimatedTokens,
    thresholdTokens: config.compact_threshold_tokens,
    boundarySeq,
    olderEntries: split.older.length,
    recentEntries: split.recent.length,
    transcriptChars: transcript.length,
  });

  const summary = await summarize(deps, transcript);
  if (summary === null) return skip("provider-error", estimatedTokens);
  if (signal.aborted) {
    log.info("compaction.skipped", { userId, sessionId, turnId, reason: "aborted", boundarySeq });
    return skip("aborted", estimatedTokens);
  }
  if (summary.trim().length === 0) {
    log.warn("compaction.skipped", { userId, sessionId, turnId, reason: "empty-summary", boundarySeq });
    return skip("empty-summary", estimatedTokens);
  }

  // Re-check + append are ONE synchronous block: Bun is single-threaded, so
  // nothing can interleave between them. Everything before this point is
  // recomputable; only the append is destructive to the model window.
  const nowEntries = store.readSession(sessionId);
  const tailNow = nowEntries[nowEntries.length - 1];
  if (!tailNow || tailNow.seq !== boundarySeq) {
    log.info("compaction.skipped", {
      userId,
      sessionId,
      turnId,
      reason: "raced-with-append",
      boundarySeq,
      tailSeqNow: tailNow?.seq ?? null,
    });
    return skip("raced-with-append", estimatedTokens);
  }

  const markerText =
    split.recent.length > 0
      ? `${SUMMARY_HEADER}\n${summary.trim()}\n\n${VERBATIM_HEADER}\n${renderTranscript(split.recent)}`
      : `${SUMMARY_HEADER}\n${summary.trim()}`;

  const marker: NewSessionEntry = {
    sessionId,
    turnId,
    kind: "compaction",
    createdAt: Date.now(),
    text: markerText,
    toolCallId: null,
    toolName: null,
    toolArgs: null,
    cutoff: null,
    compactedThroughSeq: boundarySeq,
  };
  const appended = store.append(marker);
  // Lengths and ids only — the marker text is verbatim conversation content
  // and never goes to a log sink (logging rules).
  log.info("compaction.committed", {
    userId,
    sessionId,
    turnId,
    seq: appended.seq,
    compactedThroughSeq: boundarySeq,
    estimatedTokens,
    summaryChars: summary.length,
    markerChars: markerText.length,
  });
  return { compacted: true, reason: "compacted", estimatedTokens, compactedThroughSeq: boundarySeq };
}

// ---------------------------------------------------------------------------
// Failure gate
// ---------------------------------------------------------------------------

/** Outcomes that mean "the attempt itself did not work", as opposed to "there
 *  was correctly nothing to do". Only these count toward the failure streak:
 *  `below-threshold` / `disabled` / `nothing-to-summarize` are the normal
 *  steady state at most turn boundaries, and `unsafe-boundary` /
 *  `raced-with-append` are deliberate one-turn deferrals whose own next
 *  attempt is the designed retry. */
const FAILURE_REASONS: ReadonlySet<CompactionReason> = new Set<CompactionReason>(["empty-summary", "provider-error"]);

export interface CompactionGate {
  /** False while backing off — the caller skips the whole attempt. */
  shouldAttempt(): boolean;
  /** Feed every outcome back, including the successful ones. */
  record(outcome: CompactionOutcome): void;
}

/** maybeCompact runs at EVERY turn end, so a summarizer that cannot succeed
 *  used to burn one real provider call per turn, forever, at `warn` — while
 *  the model window it was supposed to bound kept growing. This makes the
 *  failure loud once and then rare: after `max_consecutive_failures` the
 *  interval between attempts doubles each time, so a permanently broken
 *  summarizer costs one call per 2^n turns instead of one per turn.
 *
 *  Deliberately NOT a permanent give-up: the usual causes (provider outage, a
 *  transient rate limit, an operator fixing a token budget and restarting
 *  nothing) all resolve on their own, and a session that stopped trying would
 *  grow its window until the provider rejected the request outright. */
export function createCompactionGate(maxConsecutiveFailures: number): CompactionGate {
  let failures = 0;
  let turnsToSkip = 0;

  return {
    shouldAttempt(): boolean {
      if (turnsToSkip <= 0) return true;
      turnsToSkip -= 1;
      return false;
    },
    record(outcome: CompactionOutcome): void {
      if (!FAILURE_REASONS.has(outcome.reason)) {
        if (failures > 0) log.info("compaction.recovered", { afterFailures: failures, reason: outcome.reason });
        failures = 0;
        turnsToSkip = 0;
        return;
      }
      failures += 1;
      if (failures < maxConsecutiveFailures) {
        log.warn("compaction.attempt-failed", { failures, maxConsecutiveFailures, reason: outcome.reason });
        return;
      }
      // 1, 2, 4, 8 … turn boundaries skipped before the next attempt.
      turnsToSkip = 2 ** (failures - maxConsecutiveFailures);
      log.error("compaction.failing-repeatedly", {
        failures,
        reason: outcome.reason,
        nextAttemptAfterTurns: turnsToSkip,
        impact: "the model window is not being bounded; context keeps growing",
      });
    },
  };
}
