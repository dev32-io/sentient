// Reconciler — the dreamer's REDUCE-side write arm (memory-system spec §8
// "Fact ops", "Safety rails"; §3.7 "History is preserved in layers"). This is
// the ONE code path that ever rewrites distilled `MEMORY.md` (and topic files)
// from the model's proposed ops, and the highest-injection-risk write in the
// system: the ops originate from an LLM pass over session transcripts that may
// themselves be tool-derived (tainted). Everything here is fail-closed.
//
// THE ORDER IS THE CONTRACT (spec §8 "Safety rails"):
//   1. Zod-validate the whole batch (discriminated union + target shape). An
//      unknown op, a malformed field, or a bad target refuses the WHOLE batch —
//      nothing is touched, no file read even matters.
//   2. Compute the final content of every target IN MEMORY from the full batch,
//      applying ops in array order against the evolving working copy. ADD
//      appends; REWRITE/SUPERSEDE replace `old_line`→`new_line`; FLAG_STALE
//      removes `old_line`. `old_line` MUST match EXACTLY one line of the current
//      working copy — zero or >1 matches refuses the whole batch.
//   3. Preservation rail (MEMORY.md only, and only when it is a target): a
//      post-batch line count below `dreamer.preservation_pct`% of prior refuses
//      the batch. The rail is why the dreamer cannot quietly gut the file that
//      is injected into every session.
//   4. Pre-write validation of EVERY computed content — caps
//      (`validateMemoryText`) and the SAME fail-closed injection scan the store
//      applies on write. This is the crux: the store is atomic PER FILE (one
//      scan + one tmp+rename), but a multi-target batch spans files and cannot
//      be atomic across them. So we validate ALL contents up front and only
//      write once every target passes — refuse means write NOTHING.
//   5. Writes, only now: `archiveCore()` FIRST when MEMORY.md is a target
//      (timestamped snapshot before the rewrite, spec §8), then ONE
//      `writeCore`/`writeTopic` per target. A store refusal AFTER the pre-check
//      is near-impossible; if it happens we stop and return refused with an
//      ERROR log naming which targets were already written (honest partial-state
//      report — no silent success).
//   6. Retire the index entries of the lines SUPERSEDE/FLAG_STALE removed, via
//      the injected `retireLine` seam (below). Best-effort: the file write is
//      the durable truth; a retire failure defers like index-sync's own status
//      flips, it never un-writes a committed file.
//
// THE `retireLine` SEAM (spec §8 "SUPERSEDE/FLAG_STALE … status-flip the
// corresponding index entries with reason"). The spec's shape was a narrow
// `{setStatus}`-only client — deliberately no `purge`, so the no-hard-delete
// invariant (§3.7) is STRUCTURAL, not a runtime check. But `setStatus` needs
// deterministic entry ids, and those ids live in the sync layer's
// `lastIdBySource` bookkeeping (index-sync.ts) — the reconciler cannot derive
// them from an op alone. So the seam the reconciler accepts is `retireLine`:
// "retire the index entry for THIS file line, with THIS reason". T22 wires it to
// index-sync's supersession mechanics. The `reason` union is closed to the two
// retire reasons (`superseded | stale`) — there is no `purge`/`delete` arm — so
// the structural no-hard-delete guarantee is preserved through this shape too.
//
// NO MEMORY CONTENT IN LOGS (global constraint): op kind, target, scope, counts,
// and refusal reasons only — never a line, an `old_line`, or a `new_line`.

import { z } from "zod";
import { getLog } from "../../logging/logger.js";
import type { ScanProvenance, scanContent } from "../../security/injection-scanner.js";
import { MEMORY_SLUG_RE, validateMemoryText } from "../memory-file.js";
import type { MemoryConfig, MemoryStore, TopicMeta, WriteResult } from "../memory-store.js";
import type { AppliedOpLog } from "./episode-writer.js";

const log = getLog(["sentient", "memory", "dreamer", "reconciler"]);

// ---------------------------------------------------------------------------
// Constants (format contracts / code details — not operator knobs)
// ---------------------------------------------------------------------------

const CORE_TARGET = "MEMORY.md";
const TOPIC_PREFIX = "topics/";
const SCAN_CHANNEL = "memory_body" as const;
const PCT_DIVISOR = 100;

// ---------------------------------------------------------------------------
// Op schema (spec §8; `system_prompts/dreamer/reduce.md` "Output"). A single
// discriminated union on `op`; any parse failure refuses the WHOLE batch.
// ---------------------------------------------------------------------------

const sourceSchema = z.object({
  fromSeq: z.number(),
  toSeq: z.number(),
});

/** `"MEMORY.md"` or `"topics/<slug>"` (no `.md` — the reduce prompt's shape).
 *  A traversal-shaped slug fails `MEMORY_SLUG_RE` by construction, so a bad
 *  target refuses the batch rather than reaching the filesystem. */
const targetSchema = z.string().refine(isValidTarget, { message: "target must be MEMORY.md or topics/<slug>" });

const addSchema = z.object({
  op: z.literal("ADD"),
  target: targetSchema,
  line: z.string(),
  // Optional topic description, honored ONLY when this ADD creates a NEW topic
  // file (amendment 2): it seeds the new topic's frontmatter `description`.
  // Ignored for MEMORY.md and for an ADD onto a topic that already exists (its
  // existing description is preserved). Absent for the vast majority of ops.
  description: z.string().optional(),
  sources: z.array(sourceSchema),
});

const rewriteSchema = z.object({
  op: z.literal("REWRITE"),
  target: targetSchema,
  old_line: z.string(),
  new_line: z.string(),
  sources: z.array(sourceSchema),
});

const supersedeSchema = z.object({
  op: z.literal("SUPERSEDE"),
  target: targetSchema,
  old_line: z.string(),
  new_line: z.string(),
  sources: z.array(sourceSchema),
});

const flagStaleSchema = z.object({
  op: z.literal("FLAG_STALE"),
  target: targetSchema,
  old_line: z.string(),
  reason: z.string(),
  sources: z.array(sourceSchema),
});

const reduceOpSchema = z.discriminatedUnion("op", [addSchema, rewriteSchema, supersedeSchema, flagStaleSchema]);

/** One reduce op, exactly as `system_prompts/dreamer/reduce.md` emits it. */
export type ReduceOp = z.infer<typeof reduceOpSchema>;

/** The whole reduce reply, exactly `reduce.md`'s "## Output" — `{"ops": [...]}`.
 *  Exported so the reduce-stage runner (dreamer-runner.ts) validates + retries
 *  on the SAME schema the reconciler applies, no drift between the two. */
export const reduceReplySchema = z.object({ ops: z.array(reduceOpSchema) });
export type ReduceReply = z.infer<typeof reduceReplySchema>;

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

/** One session's seq coverage, as the reduce stage's source mapper needs it:
 *  which sessions a fact op's `sources` seq-ranges fall inside, and each
 *  session's taint bit (for the tainted-first ordering the purge hook relies
 *  on — episode-writer.ts pins the MOST-tainted contributing session). */
export interface SessionIndexEntry {
  sessionId: string;
  containsToolDerived: boolean;
  ranges: Array<{ fromSeq: number; toSeq: number }>;
}

/** Why a retirement is happening — the CLOSED union that keeps the no-hard-delete
 *  invariant structural (no `purge`/`delete` arm; §3.7). */
export type RetireReason = "superseded" | "stale";

export interface ReconcilerDeps {
  /** Retire the index entry for a removed/replaced file line (the
   *  SUPERSEDE/FLAG_STALE seam). T22 binds this to index-sync's supersession
   *  mechanics (`lastIdBySource`); the reconciler cannot derive index ids
   *  itself. Scope-bound at wiring — no `scopeId` arg here. */
  retireLine: (target: string, oldLine: string, reason: RetireReason) => Promise<void>;
  /** The SAME fail-closed injection scan the store applies on write. Pre-scanning
   *  every computed content BEFORE any write is what makes a multi-target batch
   *  all-or-nothing despite the store being atomic only per file. */
  scan: typeof scanContent;
}

/** Why a batch was refused. Every arm leaves the filesystem and index untouched
 *  (the near-impossible post-precheck store failure is the one exception, and it
 *  logs ERROR with the already-written targets). */
export type RefuseReason = "unknown_op" | "rail" | "scan_rejected" | "old_line_not_found" | "cap";

export type ApplyResult = { ok: true; applied: AppliedOpLog[] } | { ok: false; refused: RefuseReason; detail?: string };

// ---------------------------------------------------------------------------
// Target helpers
// ---------------------------------------------------------------------------

function isValidTarget(target: string): boolean {
  if (target === CORE_TARGET) return true;
  if (target.startsWith(TOPIC_PREFIX)) return MEMORY_SLUG_RE.test(target.slice(TOPIC_PREFIX.length));
  return false;
}

/** The evolving working copy for one target during in-memory computation. */
interface TargetState {
  target: string;
  isCore: boolean;
  /** Topic slug (`target` sans `topics/` prefix); undefined for core. */
  slug: string | undefined;
  /** Existing topic frontmatter, preserved across a body rewrite; new topics get
   *  `{name: slug, description: ""}`. Undefined for core. */
  meta: TopicMeta | undefined;
  /** True iff this is a topic the store did NOT already have — the only case in
   *  which an ADD op's optional `description` seeds the frontmatter (amendment 2). */
  isNewTopic: boolean;
  /** Line count of the prior content — the preservation-rail baseline (core). */
  priorLines: number;
  /** The working line array; joined with `\n` into the final content. */
  lines: string[];
}

/** `content` split into a line array. An empty string is zero lines (not one),
 *  so ADD onto an empty file lands a single clean line and the rail baseline of
 *  a not-yet-existing MEMORY.md is 0. */
function splitLines(content: string): string[] {
  return content.length === 0 ? [] : content.split("\n");
}

// ---------------------------------------------------------------------------
// Source → session mapping (tainted-first)
// ---------------------------------------------------------------------------

function rangesOverlap(a: { fromSeq: number; toSeq: number }, b: { fromSeq: number; toSeq: number }): boolean {
  return a.fromSeq <= b.toSeq && b.fromSeq <= a.toSeq;
}

/**
 * Resolves an op's `sources` seq-ranges to the sessions they fall inside, via
 * `sessionsIndex` range overlap, TAINTED SESSIONS FIRST (stable within each
 * group). Episode-writer picks `sessionIds[0]` preferring tainted for the §3.8
 * purge hook, so the tainted-first order is load-bearing, not cosmetic.
 */
function resolveSessionIds(
  sources: Array<{ fromSeq: number; toSeq: number }>,
  sessionsIndex: SessionIndexEntry[],
): string[] {
  const matched = sessionsIndex.filter((session) =>
    session.ranges.some((sessionRange) => sources.some((opRange) => rangesOverlap(opRange, sessionRange))),
  );
  const tainted = matched.filter((s) => s.containsToolDerived).map((s) => s.sessionId);
  const clean = matched.filter((s) => !s.containsToolDerived).map((s) => s.sessionId);
  return [...tainted, ...clean];
}

// ---------------------------------------------------------------------------
// In-memory batch computation
// ---------------------------------------------------------------------------

/** The line an applied op contributes to the op log: the resulting line for
 *  ADD/REWRITE/SUPERSEDE, the removed line for FLAG_STALE. */
function opLogLine(op: ReduceOp): string {
  switch (op.op) {
    case "ADD":
      return op.line;
    case "REWRITE":
    case "SUPERSEDE":
      return op.new_line;
    case "FLAG_STALE":
      return op.old_line;
  }
}

/** Seeds a newly-created topic's frontmatter `description` from an ADD op's
 *  optional `description` (amendment 2). Only fires for a topic the store did
 *  not already have AND whose description is still empty (the first ADD wins) —
 *  an existing topic keeps its own description, MEMORY.md has none to set. */
function seedNewTopicDescription(state: TargetState, description: string | undefined): void {
  if (state.isCore || !state.isNewTopic || description === undefined) return;
  if (state.meta !== undefined && state.meta.description === "") {
    state.meta = { ...state.meta, description };
  }
}

/** Applies one line-replace/remove op to a working line array. Returns `false`
 *  when `old_line` does not match EXACTLY one current line (zero or >1) — the
 *  caller turns that into an `old_line_not_found` batch refusal. */
function applyLineOp(lines: string[], oldLine: string, newLine: string | null): boolean {
  const indices: number[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i] === oldLine) indices.push(i);
  }
  if (indices.length !== 1) return false;
  const index = indices[0] as number;
  if (newLine === null) {
    lines.splice(index, 1);
  } else {
    lines[index] = newLine;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Pre-write validation (caps + scan — mirrors the store's own write gate)
// ---------------------------------------------------------------------------

/** The text the store scans for a target: bare content for core; the topic's
 *  `name\ndescription\nbody` for a topic (memory-store.ts `topicScanText`). */
function scanTextFor(state: TargetState, content: string): string {
  if (state.isCore || state.meta === undefined) return content;
  return `${state.meta.name}\n${state.meta.description}\n${content}`;
}

function isScanRejected(maxSeverity: "notice" | "suspicious" | "hostile" | null): boolean {
  return maxSeverity === "suspicious" || maxSeverity === "hostile";
}

/** Runs the store's write-gate checks (caps then scan) over a computed content
 *  WITHOUT writing. Returns the matching refusal, or null to proceed. */
function prevalidate(
  state: TargetState,
  content: string,
  deps: ReconcilerDeps,
  cfg: MemoryConfig,
): RefuseReason | null {
  const caps = state.isCore
    ? { maxLines: cfg.core_max_lines, maxChars: cfg.core_max_chars }
    : { maxLines: cfg.topic_max_lines, maxChars: cfg.topic_max_chars };
  const capResult = validateMemoryText(content, caps);
  if (!capResult.ok) {
    // A cap breach and the invisible-char lint both refuse the write; the latter
    // maps to scan_rejected in the same content-safety family the store uses.
    return capResult.error === "invisible_chars" ? "scan_rejected" : "cap";
  }
  const provenance: ScanProvenance = { channel: SCAN_CHANNEL, source: state.target };
  const scan = deps.scan(scanTextFor(state, content), provenance);
  return isScanRejected(scan.maxSeverity) ? "scan_rejected" : null;
}

// ---------------------------------------------------------------------------
// Refusal helper
// ---------------------------------------------------------------------------

function refuse(refused: RefuseReason, scopeId: string, detail?: string): ApplyResult {
  log.warn("dreamer.reconcile.refused", { scopeId, refused, ...(detail === undefined ? {} : { detail }) });
  return detail === undefined ? { ok: false, refused } : { ok: false, refused, detail };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Applies a batch of reduce ops to the scope's memory files, all-or-nothing.
 * See the file header for the six-phase order. Never throws: every failure is a
 * typed `ApplyResult` refusal (error-handling rule). On success returns the
 * `AppliedOpLog[]` the episode-writer needs for the journal op log and the
 * fact-entry enqueue (sources already resolved to tainted-first session ids).
 */
export async function applyOps(
  store: MemoryStore,
  deps: ReconcilerDeps,
  scopeId: string,
  ops: ReduceOp[],
  sessionsIndex: SessionIndexEntry[],
  cfg: MemoryConfig,
): Promise<ApplyResult> {
  // -- Phase 1: validate the whole batch ------------------------------------
  const parsed = z.array(reduceOpSchema).safeParse(ops);
  if (!parsed.success) {
    return refuse("unknown_op", scopeId, parsed.error.issues[0]?.message ?? "malformed op");
  }
  const validOps = parsed.data;

  // -- Phase 2: compute final content per target, in memory -----------------
  const states = new Map<string, TargetState>();
  const openState = (target: string): TargetState => {
    const existing = states.get(target);
    if (existing) return existing;
    const state = openTargetState(store, target);
    states.set(target, state);
    return state;
  };

  for (const op of validOps) {
    const state = openState(op.target);
    if (op.op === "ADD") {
      // Idempotent ADD: never append a line the target already carries verbatim.
      // The reduce prompt is TOLD not to re-add covered facts, but a crash-rerun
      // re-derives ops against a MEMORY.md the first (committed) run already
      // extended — so the SAME ADD arrives twice. Skipping the duplicate here
      // closes that window mechanically rather than trusting the model. The op
      // is still reported applied (the file already reflects it), so the journal
      // op-log and fact-entry enqueue stay stable across the rerun.
      if (!state.lines.includes(op.line)) state.lines.push(op.line);
      seedNewTopicDescription(state, op.description);
      continue;
    }
    const newLine = op.op === "FLAG_STALE" ? null : op.new_line;
    if (!applyLineOp(state.lines, op.old_line, newLine)) {
      return refuse("old_line_not_found", scopeId, `op ${op.op} on ${op.target}`);
    }
  }

  const computed = [...states.values()].map((state) => ({ state, content: state.lines.join("\n") }));

  // -- Phase 3: preservation rail (MEMORY.md only) --------------------------
  const core = computed.find((c) => c.state.isCore);
  if (core) {
    const nextLines = splitLines(core.content).length;
    const prior = core.state.priorLines;
    // Effective floor is `min(prior*pct/100, prior-1)` (amendment 1): the pct
    // rail still guards a large batch, but a batch may ALWAYS drop at least one
    // line — otherwise a tiny file wedges (a 2-line MEMORY.md with pct=75 has a
    // raw floor of 1.5, so a single legitimate FLAG_STALE could never apply and
    // the same stale line refuses every night). `prior-1` goes negative only
    // when prior is 0, where nextLines>=0 clears it anyway.
    const floor = Math.min((prior * cfg.dreamer.preservation_pct) / PCT_DIVISOR, prior - 1);
    if (nextLines < floor) {
      log.warn("dreamer.rail.refused", { scopeId, prior, next: nextLines });
      return { ok: false, refused: "rail", detail: `prior=${prior} next=${nextLines}` };
    }
  }

  // -- Phase 4: pre-write validation of EVERY computed content --------------
  for (const { state, content } of computed) {
    const bad = prevalidate(state, content, deps, cfg);
    if (bad) return refuse(bad, scopeId, `target ${state.target}`);
  }

  // -- Phase 5: writes (archive core FIRST, then one write per target) ------
  if (core) store.archiveCore();

  const written: string[] = [];
  for (const { state, content } of computed) {
    const result = writeTarget(store, state, content);
    if (!result.ok) {
      // Near-impossible: we pre-validated. Report honest partial state, stop.
      log.error("dreamer.reconcile.write-failed", {
        scopeId,
        target: state.target,
        error: result.error,
        alreadyWritten: written,
      });
      return { ok: false, refused: storeErrorToRefuse(result.error), detail: `write failed on ${state.target}` };
    }
    written.push(state.target);
  }

  // -- Phase 6: retire superseded/stale index entries (best-effort) ---------
  await retireRemoved(deps, validOps, scopeId);

  // -- Build the applied op log ---------------------------------------------
  const applied: AppliedOpLog[] = validOps.map((op) => ({
    op: op.op,
    target: op.target,
    line: opLogLine(op),
    sources: op.sources,
    sessionIds: resolveSessionIds(op.sources, sessionsIndex),
  }));
  for (const entry of applied) {
    log.info("dreamer.op.applied", { scopeId, op: entry.op, target: entry.target });
  }
  log.info("dreamer.reconcile.ok", { scopeId, targets: written.length, ops: applied.length });
  return { ok: true, applied };
}

// ---------------------------------------------------------------------------
// Store adapters
// ---------------------------------------------------------------------------

/** Opens the working state for a target from the store's CURRENT content. */
function openTargetState(store: MemoryStore, target: string): TargetState {
  if (target === CORE_TARGET) {
    const prior = store.readCore() ?? "";
    return {
      target,
      isCore: true,
      slug: undefined,
      meta: undefined,
      isNewTopic: false,
      priorLines: splitLines(prior).length,
      lines: splitLines(prior),
    };
  }
  const slug = target.slice(TOPIC_PREFIX.length);
  const priorBody = store.readTopic(slug) ?? "";
  const existing = store.listTopics().find((t) => t.name === slug);
  const meta: TopicMeta = existing ?? { name: slug, description: "" };
  return {
    target,
    isCore: false,
    slug,
    meta,
    isNewTopic: existing === undefined,
    priorLines: splitLines(priorBody).length,
    lines: splitLines(priorBody),
  };
}

/** Writes one target's final content through the store's atomic, scan-gated
 *  write (core → `writeCore`, topic → `writeTopic`). */
function writeTarget(store: MemoryStore, state: TargetState, content: string): WriteResult {
  if (state.isCore) return store.writeCore(content);
  const slug = state.slug as string;
  const meta = state.meta as TopicMeta;
  return store.writeTopic(slug, meta, content);
}

/** Maps a store write error to a batch refusal reason (only reached on the
 *  near-impossible post-precheck failure). */
function storeErrorToRefuse(error: Extract<WriteResult, { ok: false }>["error"]): RefuseReason {
  return error === "cap_lines" || error === "cap_chars" ? "cap" : "scan_rejected";
}

/** Retires the index entries of every SUPERSEDE/FLAG_STALE `old_line`. Best-effort:
 *  the file writes already committed, so a retire failure DEFERS (WARN) like
 *  index-sync's own status flips — it never un-writes a committed line. */
async function retireRemoved(deps: ReconcilerDeps, ops: ReduceOp[], scopeId: string): Promise<void> {
  for (const op of ops) {
    if (op.op !== "SUPERSEDE" && op.op !== "FLAG_STALE") continue;
    const reason: RetireReason = op.op === "SUPERSEDE" ? "superseded" : "stale";
    try {
      await deps.retireLine(op.target, op.old_line, reason);
    } catch (err) {
      // Amendment 3: log the error NAME only — a retire-line error message can
      // echo the very memory line it failed to retire (no memory content in
      // logs, global constraint). The name + target + reason is enough to trace.
      log.warn("dreamer.reconcile.retire-deferred", {
        scopeId,
        target: op.target,
        reason,
        errorName: err instanceof Error ? err.name : "non-error",
      });
    }
  }
}
