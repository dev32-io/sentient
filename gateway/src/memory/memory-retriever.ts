// memory-retriever — the spark: per-turn associative memory recall (spec §6).
//
// Once per conversational turn, on the finalized user utterance, this module
// searches the deep-memory index and assembles a small labeled block of
// "possibly relevant past memories" for the `<situation>` block's per-turn tail.
// Plain code, zero LLM calls. The result is memoized by `turnId` so the block
// is byte-identical across every ReAct iteration of the turn (cache-safe by
// construction — the situation closure reads `cachedFor`).
//
// SCORING (spec §5.3, exact): similarity GATES, recency only ORDERS. A hit
// passes iff `similarity >= spark.min_similarity` — relevance alone, so an old
// but strongly-relevant memory always fires. Passed hits are ordered by
// `orderScore = similarity × max(recency_floor, 2^(-ageDays/half_life))`; decay
// never gates, only ranks.
//
// SECURITY: the assembled block crosses the SESSION'S InboundGate on the
// `memory_body` channel before it is returned — the same gate (and same risk
// accumulator) the ToolBroker's PDP reads, so a hostile indexed memory raises
// the session risk the PDP escalates on. A gate strip (never-legitimate
// tool-envelope form removed) withholds the whole block.
//
// PRIVACY: no memory content in logs — only counts, similarities, kinds, ids.

import type { OrchestratorConfig } from "@sentient/config";
import { getLog } from "../logging/logger.js";
import { memoryTogglesFor } from "../profile-store/profile-store.js";
import type { ProfileStore } from "../profile-store/profile-store.js";
import type { InboundGate } from "../security/inbound-gate.js";
import type { DeepMemoryClient, Hit } from "./deep-memory-client.js";

const log = getLog(["sentient", "memory", "retriever"]);

// --- Constants ---------------------------------------------------------------

/** Header for the injected section — a labeled tail so the model can weigh it
 *  as background, not instruction. */
const SNIPPET_HEADER = "possibly relevant past memories:";
/** Gate channel + source for the outbound screen of the assembled block. */
const GATE_CHANNEL = "memory_body" as const;
const GATE_SOURCE = "spark";
/** Defensive per-snippet char cap — entries are ≤200 by contract, but never
 *  trust the index blindly. */
const SNIPPET_MAX_CHARS = 200;
const SNIPPET_ELLIPSIS = "…";
/** Rough token estimate: ~4 chars/token (matches the compaction estimator). */
const CHARS_PER_TOKEN = 4;
const MS_PER_DAY = 86_400_000;
/** Internal fetch amplification (NOT a behavioral tunable — the config rule
 *  exempts internal impl details): over-fetch candidates so the similarity gate
 *  and audience filter still leave material to order under the snippet cap. */
const CANDIDATE_OVERFETCH = 4;
/** Audience that a child principal must never see (spec §9). */
const ADULTS_ONLY: string = "adults";
/** LRU-ish memo cap — turns are sequential, so a small window is plenty. */
const MEMO_CAP = 8;
/** Sentinel distinguishing a deadline expiry from a legitimately-empty block. */
const TIMED_OUT = Symbol("spark-timeout");

/** Why a turn produced no spark block. Pinned enum (brief). */
type WithheldReason = "below-threshold" | "timeout" | "toggle-off" | "gate-off" | "empty";

type MemoryConfig = OrchestratorConfig["memory"];

// --- Public shape ------------------------------------------------------------

export interface SparkTurn {
  utterance: string;
  turnId: string;
  userId: string;
  scopeIds: string[];
  childPrincipal: boolean;
  /** The DURABLE session id, for the gate's trace line only. Optional so the
   *  retriever stays usable without it (the memo key is `turnId`); when the
   *  wiring supplies it, the `memory_body` screen correlates on the real
   *  session rather than the turn (T15 carried item — T13 passed `turnId`). */
  sessionId?: string;
}

export interface MemoryRetriever {
  /**
   * Computes (once per `turnId`, memoized) the spark block for a turn. Returns
   * the labeled snippet section, or `""` when nothing is worth injecting
   * (toggle off, deadline expiry, no relevant hits, or a gate strip). Never
   * throws — a dead index or a slow search degrades to `""`.
   */
  computeSpark(turn: SparkTurn): Promise<string>;
  /** The cached spark string for a turn, or `null` if not yet computed. Read
   *  by the synchronous situation-block closure. */
  cachedFor(turnId: string): string | null;
}

export interface MemoryRetrieverDeps {
  client: DeepMemoryClient;
  /** The SESSION'S gate — the same instance the ToolBroker holds, so spark
   *  findings raise the risk the PDP reads. */
  gate: InboundGate;
  profileStore: ProfileStore;
  cfg: MemoryConfig;
  now?: () => number;
}

// --- Implementation ----------------------------------------------------------

interface ScoredHit {
  hit: Hit;
  orderScore: number;
}

export function createMemoryRetriever(deps: MemoryRetrieverDeps): MemoryRetriever {
  const { client, gate, profileStore, cfg } = deps;
  const now = deps.now ?? (() => Date.now());
  const memo = new Map<string, string>();

  function remember(turnId: string, block: string): string {
    // First write wins: if the deadline already withheld this turn, a late
    // (post-timeout) compute result must not overwrite the "" the caller saw.
    const existing = memo.get(turnId);
    if (existing !== undefined) {
      return existing;
    }
    memo.set(turnId, block);
    if (memo.size > MEMO_CAP) {
      const oldest = memo.keys().next().value;
      if (oldest !== undefined) {
        memo.delete(oldest);
      }
    }
    return block;
  }

  function withhold(turnId: string, reason: WithheldReason): string {
    // Timeout is the one operationally-notable withhold (a slow index engine);
    // the rest are ordinary "nothing relevant" outcomes.
    const fields = { turnId, reason };
    if (reason === "timeout") {
      log.warn("memory-retriever.spark.withheld", fields);
    } else {
      log.debug("memory-retriever.spark.withheld", fields);
    }
    return remember(turnId, "");
  }

  async function searchActive(turn: SparkTurn): Promise<Hit[] | null> {
    const k = cfg.spark.max_snippets * CANDIDATE_OVERFETCH;
    const result = await client.search({
      scopeIds: turn.scopeIds,
      query: turn.utterance,
      k,
      filters: { statuses: ["active"] },
    });
    if (!result.ok) {
      log.debug("memory-retriever.spark.search-failed", { turnId: turn.turnId, errorKind: result.error.kind });
      return null;
    }
    return result.value;
  }

  function filterAudience(hits: Hit[], turn: SparkTurn): Hit[] {
    if (!turn.childPrincipal) {
      return hits;
    }
    const kept: Hit[] = [];
    for (const hit of hits) {
      if (hit.entry.audience === ADULTS_ONLY) {
        log.debug("memory-retriever.audience.filtered", { turnId: turn.turnId, kind: hit.entry.kind });
        continue;
      }
      kept.push(hit);
    }
    return kept;
  }

  function orderScoreFor(hit: Hit): number {
    const entryMs = Date.parse(hit.entry.timestamp);
    const ageDays = Number.isNaN(entryMs) ? 0 : Math.max(0, (now() - entryMs) / MS_PER_DAY);
    const decay = 2 ** (-ageDays / cfg.spark.recency_half_life_days);
    const recencyFactor = Math.max(cfg.spark.recency_floor, decay);
    return hit.similarity * recencyFactor;
  }

  /** Similarity GATES; recency only ORDERS the survivors (spec §5.3). */
  function gateAndOrder(hits: Hit[]): ScoredHit[] {
    const passed = hits.filter((h) => h.similarity >= cfg.spark.min_similarity);
    return passed.map((hit) => ({ hit, orderScore: orderScoreFor(hit) })).sort((a, b) => b.orderScore - a.orderScore);
  }

  function snippetText(entry: Hit["entry"]): string {
    const text = entry.text;
    if (text.length <= SNIPPET_MAX_CHARS) {
      return text;
    }
    return `${text.slice(0, SNIPPET_MAX_CHARS - SNIPPET_ELLIPSIS.length)}${SNIPPET_ELLIPSIS}`;
  }

  function snippetLine(hit: Hit): string {
    const date = hit.entry.timestamp.slice(0, 10);
    return `- [${hit.entry.scope} · ${date}] ${snippetText(hit.entry)}`;
  }

  /** Assembles the block under the hard caps (max_snippets, token_budget).
   *  Stops adding a snippet BEFORE it would exceed the token budget. */
  function assemble(scored: ScoredHit[], turn: SparkTurn): string {
    const lines: string[] = [];
    for (const { hit, orderScore } of scored) {
      if (lines.length >= cfg.spark.max_snippets) {
        break;
      }
      const candidate = [SNIPPET_HEADER, ...lines, snippetLine(hit)].join("\n");
      if (Math.ceil(candidate.length / CHARS_PER_TOKEN) > cfg.spark.token_budget) {
        break;
      }
      lines.push(snippetLine(hit));
      log.debug("memory-retriever.spark.hit", {
        turnId: turn.turnId,
        similarity: hit.similarity,
        orderScore,
        kind: hit.entry.kind,
      });
    }
    if (lines.length === 0) {
      return "";
    }
    return [SNIPPET_HEADER, ...lines].join("\n");
  }

  /** Screens the assembled block through the session gate. A strip (sanitized
   *  text differs — a never-legitimate envelope form was removed) withholds the
   *  whole block; the gate has already raised risk on the shared accumulator. */
  function screenBlock(block: string, turn: SparkTurn): string | null {
    const screened = gate.screen(
      block,
      { channel: GATE_CHANNEL, source: GATE_SOURCE },
      { sessionId: turn.sessionId ?? turn.turnId },
    );
    if (screened.text !== block) {
      return null;
    }
    return screened.text;
  }

  async function compute(turn: SparkTurn): Promise<string> {
    const hits = await searchActive(turn);
    if (hits === null || hits.length === 0) {
      return withhold(turn.turnId, "empty");
    }
    const scored = gateAndOrder(filterAudience(hits, turn));
    if (scored.length === 0) {
      return withhold(turn.turnId, "below-threshold");
    }
    const block = assemble(scored, turn);
    if (block === "") {
      return withhold(turn.turnId, "below-threshold");
    }
    const screened = screenBlock(block, turn);
    if (screened === null) {
      return withhold(turn.turnId, "gate-off");
    }
    return remember(turn.turnId, screened);
  }

  async function computeSpark(turn: SparkTurn): Promise<string> {
    const cached = memo.get(turn.turnId);
    if (cached !== undefined) {
      return cached;
    }

    const toggles = await memoryTogglesFor(profileStore, turn.userId);
    if (!toggles.spark) {
      return withhold(turn.turnId, "toggle-off");
    }

    // The deadline wraps the WHOLE compute (search + assembly + gate). The
    // underlying client call is not cancellable, so a late result is simply
    // ignored once the deadline sentinel wins.
    const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
      setTimeout(() => resolve(TIMED_OUT), cfg.spark.timeout_ms);
    });
    const outcome = await Promise.race([compute(turn), timeout]);
    if (outcome === TIMED_OUT) {
      return withhold(turn.turnId, "timeout");
    }
    return outcome;
  }

  function cachedFor(turnId: string): string | null {
    const cached = memo.get(turnId);
    return cached === undefined ? null : cached;
  }

  return { computeSpark, cachedFor };
}
