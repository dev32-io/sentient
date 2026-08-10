// Episode/journal writer — the dreamer's episodic REDUCE-side output stage
// (memory-system spec §8 "Outputs"). Given a completed map stage (`DreamResult`)
// and, in S3b, the reconciler's applied fact ops, this writes the ONE canonical
// dreamer artifact — `journal/YYYY-MM-DD.md` — and enqueues the derived index
// entries. It is the file-layer half of the night; MEMORY.md is the reconciler's.
//
// TWO SECURITY PROPERTIES THIS FILE HOLDS (spec §3.1, §3.8):
//
//   1. TAINT PROPAGATION IS LOAD-BEARING. Every episode carries its session's
//      `containsToolDerived` bit straight from the projection (no laundering to
//      `assistant` through the LLM pass). It surfaces in TWO durable places:
//        - the journal heading marker `## session <id> [tool-derived]` (present
//          iff tainted; absent = user-speech), so a rebuild-from-files can
//          recover per-session provenance via `parseJournalEpisodes`; and
//        - the enqueued episode entry's `provenance` field.
//      The journal narrative and every fact entry inherit the MOST-tainted
//      provenance of the sessions that fed them — an aggregate over tainted
//      input is itself tainted (spec §3.1 "least-trusted input").
//
//   2. FACT ENTRIES CARRY `sessionRef` — THE §3.8 PURGE CONTRACT. Every fact
//      op cites the sessions it distilled from (`AppliedOpLog.sessionIds`,
//      supplied by T22's reconciler, which maps op source seq-ranges → sessions
//      via the DreamResult). Poison remediation purges the TAINTED session, so
//      we stamp each fact entry with the MOST-TAINTED contributing session as
//      `sessionRef.sessionId` (the first `tool-derived` one in stable order;
//      the first session when none is tainted). A fact distilled from
//      [clean, poison] must pin the poison session, or `purge(scopeId,
//      {sessionId: poison})` would leave the MEMORY.md-derived fact behind. Its
//      provenance is likewise the most-tainted of ALL the op's contributing
//      sessions.
//
// WRITE-TIME SCAN IS FAIL-CLOSED (inherited from the store). A hostile episode
// text makes `store.writeJournal` refuse the WHOLE journal; we return that
// refusal and enqueue NOTHING — the derived index never gets what the canonical
// file rejected. The caller (T20 transaction owner) decides retry vs skip and,
// critically, does NOT advance the dream mark on a refusal.
//
// DETERMINISTIC BY CONSTRUCTION. No `Date.now`: the entry timestamp is derived
// from `date`, and stable ordering (sessions then ops, in input order) means a
// re-run over the same `date + result` produces byte-identical journal text and
// the same deterministic entry ids (index-sync computes ids from
// scope:kind:sourceRef:contentHash) — the idempotence the checkpoint model
// relies on (spec §8 "Checkpointing").
//
// No memory content is logged (global constraint): counts, ids, and the date
// only — never an episode, a narrative, or a fact line.

import { getLog } from "../../logging/logger.js";
import type { EnqueueEntry, IndexSync } from "../index-sync.js";
import type { MemoryStore, WriteResult } from "../memory-store.js";
import type { DreamResult } from "./dreamer-runner.js";

const log = getLog(["sentient", "memory", "dreamer", "episode-writer"]);

// ---------------------------------------------------------------------------
// Format contracts (code details — not operator knobs)
// ---------------------------------------------------------------------------

const KIND_EPISODE_SUMMARY = "episode-summary";
const KIND_JOURNAL = "journal";
const KIND_FILE_SECTION = "file-section";

const TAINTED = "tool-derived";
const UNTAINTED = "user-speech";

/** The journal heading marker appended iff the session is tainted. The single
 *  space + bracket form is what `parseJournalEpisodes` looks for on rebuild. */
const TAINT_MARKER = ` [${TAINTED}]`;

const SESSION_HEADING_PREFIX = "## session ";
const OP_LOG_HEADING = "## memory updates";
const NO_OPS_LINE = "No memory updates this night.";
const EMPTY_NARRATIVE = "No sessions were distilled.";

/** `journal/<date>.md` — the sourceRef file every enqueued entry points at. */
function journalFile(date: string): string {
  return `journal/${date}.md`;
}

/** Midnight-UTC ISO for `date`. Deterministic (no wall clock): entry ids do not
 *  depend on it, but a stable timestamp keeps re-runs byte-identical. */
function dateToIso(date: string): string {
  return `${date}T00:00:00.000Z`;
}

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

/** Provenance an episode/fact entry carries — the taint bit, resolved. */
export type EpisodeProvenance = typeof TAINTED | typeof UNTAINTED;

/** One episode recovered from journal text by `parseJournalEpisodes`. `text` is
 *  the episode body (trimmed); `provenance` is read back from the heading marker. */
export interface ParsedJournalEpisode {
  sessionId: string;
  text: string;
  provenance: EpisodeProvenance;
}

/**
 * One applied fact op, as the reconciler (T22) hands it over for the op log +
 * fact-entry enqueue. `sources` are the raw seq ranges the op distilled from;
 * `sessionIds` are those ranges resolved to sessions (the reconciler maps them
 * via the `DreamResult`). In S3a there is no reconciler, so `appliedOps` is
 * undefined and the op-log section reads "No memory updates this night."
 */
export interface AppliedOpLog {
  op: string;
  target: string;
  line: string;
  sources: Array<{ fromSeq: number; toSeq: number }>;
  sessionIds: string[];
}

/** WriteResult-like outcome. On a scan refusal from the store, `error` is the
 *  store's own `WriteResult` failure reason and NOTHING was enqueued. */
export type WriteDreamOutputsResult =
  | { ok: true; episodeEntries: number; journalEntries: number; factEntries: number }
  | { ok: false; error: Extract<WriteResult, { ok: false }>["error"] };

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** The provenance for a single session's episode. */
function provenanceFor(containsToolDerived: boolean): EpisodeProvenance {
  return containsToolDerived ? TAINTED : UNTAINTED;
}

/** Most-tainted provenance across a set of taint bits — tainted if ANY is
 *  (spec §3.1: an aggregate over tainted input is itself tainted). */
function mostTainted(taintBits: boolean[]): EpisodeProvenance {
  return taintBits.some((bit) => bit) ? TAINTED : UNTAINTED;
}

/** First sentence of `text` (through the first `.`/`!`/`?` at a boundary), or
 *  the whole trimmed text when it has no terminal punctuation. Powers the dumb,
 *  fixed-format day narrative — NOT another LLM call. */
function firstSentence(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return "";
  const match = trimmed.match(/^[\s\S]*?[.!?](?=\s|$)/);
  return (match ? match[0] : trimmed).trim();
}

/** The fixed-format day narrative: first sentence of each episode, in order,
 *  joined. Empty windows get a stable fallback so the entry is never blank. */
function buildNarrative(result: DreamResult): string {
  const sentences = result.sessions.map((session) => firstSentence(session.episode)).filter((s) => s.length > 0);
  return sentences.length > 0 ? sentences.join(" ") : EMPTY_NARRATIVE;
}

/** One session's `## session <id>[ marker]` heading, marker iff tainted. */
function sessionHeading(sessionId: string, tainted: boolean): string {
  return `${SESSION_HEADING_PREFIX}${sessionId}${tainted ? TAINT_MARKER : ""}`;
}

/** Renders one applied op as a greppable op-log line with source citations. */
function renderOpLine(op: AppliedOpLog): string {
  const sessions = op.sessionIds.length > 0 ? op.sessionIds.join(", ") : "none";
  const seqs = op.sources.length > 0 ? op.sources.map((s) => `${s.fromSeq}-${s.toSeq}`).join(", ") : "none";
  return `- ${op.op} ${op.target}: ${op.line}  [sessions: ${sessions}; seqs: ${seqs}]`;
}

/** The `## memory updates` op-log section — applied ops with citations, or the
 *  fixed "no updates" line in the S3a (no-reconciler) path. */
function buildOpLog(appliedOps: AppliedOpLog[]): string {
  const body = appliedOps.length > 0 ? appliedOps.map(renderOpLine).join("\n") : NO_OPS_LINE;
  return `${OP_LOG_HEADING}\n\n${body}`;
}

/** Assembles the whole journal: H1 date, narrative, per-session episode sections
 *  (with taint markers), then the op-log section. Greppable and stable. */
function buildJournal(date: string, result: DreamResult, narrative: string, appliedOps: AppliedOpLog[]): string {
  const blocks: string[] = [`# ${date}`, narrative];
  for (const session of result.sessions) {
    blocks.push(`${sessionHeading(session.sessionId, session.containsToolDerived)}\n\n${session.episode.trim()}`);
  }
  blocks.push(buildOpLog(appliedOps));
  return `${blocks.join("\n\n")}\n`;
}

// ---------------------------------------------------------------------------
// Journal parse (rebuild + deep-dream recovery of per-session taint)
// ---------------------------------------------------------------------------

/** Matches a `## session <id>` heading, capturing the id and the optional
 *  `[tool-derived]` marker. Ids are server-minted opaque tokens (no spaces). */
const SESSION_HEADING_RE = /^## session (\S+)(?: \[tool-derived\])?\s*$/;
/** Any other ATX heading closes the current episode block (`## memory updates`,
 *  a following `## session`, or the H1). */
const ANY_HEADING_RE = /^#{1,6}\s+/;

/**
 * Recovers the episode sections a `buildJournal` produced: for each
 * `## session <id>[ [tool-derived]]` heading, the body up to the next heading,
 * with provenance read back from the marker. Round-trips with the writer so the
 * rebuild path (and future deep-dream) can re-derive per-session taint from the
 * canonical file alone (spec §2 "fully derivable", §3.8). Non-episode sections
 * (narrative preamble, op log) are ignored.
 */
export function parseJournalEpisodes(journalText: string): ParsedJournalEpisode[] {
  const episodes: ParsedJournalEpisode[] = [];
  const lines = journalText.split("\n");
  let current: { sessionId: string; provenance: EpisodeProvenance; body: string[] } | null = null;

  const flush = (): void => {
    if (current === null) return;
    episodes.push({
      sessionId: current.sessionId,
      text: current.body.join("\n").trim(),
      provenance: current.provenance,
    });
    current = null;
  };

  for (const line of lines) {
    const sessionMatch = SESSION_HEADING_RE.exec(line);
    if (sessionMatch) {
      flush();
      current = {
        sessionId: sessionMatch[1] as string,
        provenance: line.includes(TAINT_MARKER) ? TAINTED : UNTAINTED,
        body: [],
      };
      continue;
    }
    if (ANY_HEADING_RE.test(line)) {
      flush();
      continue;
    }
    if (current !== null) current.body.push(line);
  }
  flush();
  return episodes;
}

// ---------------------------------------------------------------------------
// Entry projection
// ---------------------------------------------------------------------------

/** One `episode-summary` entry per session — the primary spark signal — carrying
 *  BOTH `sessionRef` (purge-by-session) and the session's taint as provenance. */
function episodeEntries(scopeId: string, date: string, result: DreamResult): EnqueueEntry[] {
  const file = journalFile(date);
  const timestamp = dateToIso(date);
  return result.sessions.map((session) => ({
    kind: KIND_EPISODE_SUMMARY,
    text: session.episode,
    timestamp,
    scope: scopeId,
    sourceRef: { file, heading: `session ${session.sessionId}` },
    sessionRef: { sessionId: session.sessionId },
    provenance: provenanceFor(session.containsToolDerived),
  }));
}

/** The single `journal` entry for the day narrative. Tainted if ANY contributing
 *  session was — the narrative is a substring aggregate of the episodes. */
function journalEntry(scopeId: string, date: string, result: DreamResult, narrative: string): EnqueueEntry {
  return {
    kind: KIND_JOURNAL,
    text: narrative,
    timestamp: dateToIso(date),
    scope: scopeId,
    sourceRef: { file: journalFile(date) },
    provenance: mostTainted(result.sessions.map((s) => s.containsToolDerived)),
  };
}

/** The session an op's fact entry pins its `sessionRef` to — the §3.8 purge
 *  hook. Poison remediation purges the TAINTED session, so a fact distilled from
 *  a mix must pin the MOST-tainted contributing session (first tool-derived one
 *  in stable order) — else a fact from [clean, poison] pinned to the clean
 *  session escapes `purge(sessionId: poison)`. Falls back to the first session
 *  when none is tainted; undefined when the op cites no resolved session. */
function purgeSessionFor(sessionIds: string[], taintOf: Map<string, boolean>): string | undefined {
  return sessionIds.find((id) => taintOf.get(id) === true) ?? sessionIds[0];
}

/** One `file-section` fact entry per applied op — `sessionRef` = the op's
 *  MOST-tainted contributing session (the §3.8 purge hook), provenance =
 *  most-tainted of ALL its contributing sessions (looked up in the DreamResult).
 *  Ops with no resolved session are still enqueued, without a `sessionRef`. */
function factEntries(scopeId: string, date: string, result: DreamResult, appliedOps: AppliedOpLog[]): EnqueueEntry[] {
  const timestamp = dateToIso(date);
  const taintOf = new Map(result.sessions.map((s) => [s.sessionId, s.containsToolDerived]));
  return appliedOps.map((op) => {
    const provenance = mostTainted(op.sessionIds.map((id) => taintOf.get(id) ?? false));
    const base: EnqueueEntry = {
      kind: KIND_FILE_SECTION,
      text: op.line,
      timestamp,
      scope: scopeId,
      sourceRef: { file: op.target },
      provenance,
    };
    // exactOptionalPropertyTypes forbids `sessionRef: undefined` — omit it.
    const purgeSession = purgeSessionFor(op.sessionIds, taintOf);
    return purgeSession === undefined ? base : { ...base, sessionRef: { sessionId: purgeSession } };
  });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Writes the canonical journal for `date` and enqueues its derived index
 * entries. Journal write is fail-closed (a hostile episode refuses the whole
 * file); on refusal NOTHING is enqueued and the store's error is returned so the
 * caller can decide retry/skip WITHOUT advancing the dream mark. `appliedOps`
 * is undefined/empty in S3a (episodic-only): the op-log section says "no
 * updates" and no fact entries are enqueued.
 *
 * `narrativeOverride` (deep-dreaming, spec §8 "later slice") replaces the
 * fixed first-sentence-per-episode narrative with a caller-supplied one (e.g.
 * "Deep dream over 7 days.") — the ONLY thing that differs between a nightly
 * and a deep-dream write; everything else (headings, taint markers, op log,
 * enqueued entries) is identical, which is the whole point of reusing this
 * writer rather than a second pipeline.
 */
export function writeDreamOutputs(
  store: MemoryStore,
  sync: IndexSync,
  scopeId: string,
  date: string,
  result: DreamResult,
  appliedOps?: AppliedOpLog[],
  narrativeOverride?: string,
): WriteDreamOutputsResult {
  const ops = appliedOps ?? [];
  const narrative = narrativeOverride ?? buildNarrative(result);
  const journalText = buildJournal(date, result, narrative, ops);

  const written = store.writeJournal(date, journalText);
  if (!written.ok) {
    log.warn("episode-writer.journal.refused", { date, error: written.error, sessions: result.sessions.length });
    return { ok: false, error: written.error };
  }

  const entries: EnqueueEntry[] = [
    ...episodeEntries(scopeId, date, result),
    journalEntry(scopeId, date, result, narrative),
    ...factEntries(scopeId, date, result, ops),
  ];
  sync.enqueueEntries(entries);

  const episodes = result.sessions.length;
  const facts = ops.length;
  log.info("episode-writer.done", { date, episodeEntries: episodes, journalEntries: 1, factEntries: facts });
  return { ok: true, episodeEntries: episodes, journalEntries: 1, factEntries: facts };
}
