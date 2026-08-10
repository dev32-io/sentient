// Dreamer FULL dream transaction (memory-system spec §8 "Checkpointing",
// "Outputs", "Fact ops", "Safety rails") — the per-user, idempotent-by-
// construction nightly consolidation. Both halves: EPISODIC (journal) AND
// SEMANTIC (the reduce stage → reconciler → MEMORY.md/topic ops).
//
// THE ORDER IS THE CONTRACT (spec §8). A single run is:
//   read mark → snapshot maxSeq from the session store → immutable window
//   (lastSeq, maxSeq] → projectForDreaming → runMapStage → read current memory →
//   runReduceStage → applyOps (reconciler) → writeDreamOutputs(..., APPLIED ops)
//   (journal committed atomically, index entries enqueued) → sync.flush()
//   best-effort → advanceMark.
// The mark advances LAST, and ONLY on a clean journal write. A crash anywhere
// before it redoes the SAME window next run; deterministic ids make the redone
// journal last-wins by date, the redone index upserts converge, and the ops are
// re-derived from the same window (episode-writer.ts / reconciler.ts).
//
// FIVE OUTCOMES:
//   - ok               — map + reduce ran, ops applied, journal committed, mark advanced.
//   - ok-episodic-only — the SEMANTIC half was refused but the EPISODES are canonical
//               and must NOT be lost. Two ways in: the reduce call double-failed
//               (unparseable after retry → `runReduceStage` returns null), OR the
//               reconciler REFUSED the batch (rail / scan / cap / old_line). Either
//               way the journal is still written WITH NO OPS ("No memory updates
//               this night." — the applied-op log is empty), the refusal is logged
//               + recorded in the status `reason`, and THE MARK STILL ADVANCES.
//               Re-dreaming the same window would re-spend the provider for episodes
//               that are already durable, so the episodic commit is the checkpoint —
//               a broken reduce does not hold the whole window hostage.
//   - skipped — dreaming toggled OFF for this user: no LLM call, no journal, but
//               the mark STILL advances to maxSeq (spec §8 per-user toggle).
//   - failed  — the map stage threw, the journal write was scan-refused, the scope
//               could not open, OR any UNEXPECTED throw crashed the semantic/write
//               phase. The night is abandoned WITH A WARN and the mark is NOT
//               advanced, so the next run redoes the window. (Distinct from
//               ok-episodic-only: a crash means the episodes never committed either.)
//   - initialized — first-run mark seed (advance without dreaming; no backlog).
//
// No memory content is logged (global constraint): userId, counts, seqs, the
// date, the refusal reason and the outcome only — never a transcript, an
// episode, a fact, or a memory line.

import { join } from "node:path";
import type { OrchestratorConfig } from "@sentient/config";
import { getLog } from "../../logging/logger.js";
import { scanContent } from "../../security/injection-scanner.js";
import type { SessionEntry } from "../../store/entry-types.js";
import { projectForDreaming } from "../../store/project-for-dreaming.js";
import { writeFileAtomic } from "../../user-auth/atomic-write.js";
import type { UserId } from "../../user-auth/user-id.js";
import type { IndexSync } from "../index-sync.js";
import type { MemoryStore } from "../memory-store.js";
import type { CurrentMemory, DreamMark, DreamResult, DreamRunner } from "./dreamer-runner.js";
import type { AppliedOpLog } from "./episode-writer.js";
import { writeDreamOutputs as realWriteDreamOutputs } from "./episode-writer.js";
import { applyOps as realApplyOps } from "./reconciler.js";
import type { ReconcilerDeps, SessionIndexEntry } from "./reconciler.js";

const log = getLog(["sentient", "memory", "dreamer", "transaction"]);

// ---------------------------------------------------------------------------
// Constants (format contracts — not operator knobs)
// ---------------------------------------------------------------------------

/** The greppable per-user status record (spec §8): a future viewer surface, an
 *  operator `cat` today. Sibling of the mark in the scope's memory dir. */
const STATUS_FILENAME = ".dream-status.json";
const MS_PER_HOUR = 3_600_000;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** One dream's result label + counts, returned to the scheduler for its per-user
 *  log line and (in tests) assertions. `ops` is always 0 in S3a (episodic only).
 *  `initialized` is the FIRST-RUN outcome — the mark was missing (first-ever boot
 *  with the dreamer enabled), so we advance it to the current head WITHOUT dreaming
 *  the entire back-history through the paid provider. */
export interface DreamOutcome {
  result: "ok" | "ok-episodic-only" | "skipped" | "failed" | "initialized";
  sessions: number;
  ops: number;
  durationMs: number;
  /** Present on `ok-episodic-only`/`skipped`/`failed`/`initialized` — the
   *  greppable reason (the reduce/reconciler refusal on `ok-episodic-only`). */
  reason?: string;
}

/** The boot-time decision for one user, from the mark alone (no scope open):
 *   - `initialize` — NO mark yet (first-ever boot with the dreamer on): advance
 *     to head, do NOT dream the back-history (the paid-spend hazard).
 *   - `dream` — a mark EXISTS but its `lastRunAt` is stale (the gateway was down
 *     over a night): a real catch-up dream of `(lastSeq, maxSeq]`.
 *   - `skip` — a mark exists and is recent: nothing to do at boot. */
export type BootDecision = "initialize" | "dream" | "skip";

/** Everything one user's dream operates on, opened by the composition root (it
 *  owns the AccessManager, provider and deep-memory app). Returned by
 *  `openDreamScope`; the transaction never mints capabilities itself. */
export interface DreamScopeHandle {
  /** The branded user id — what `runMapStage` logs + yields on. */
  userId: UserId;
  /** The private index scope id (`user:<userId>`). */
  scopeId: string;
  /** Absolute path to the scope's memory dir — where the mark + status live. */
  memoryDir: string;
  /** RAW store (NOT sync-wrapped): `writeDreamOutputs` enqueues provenance-carrying
   *  index ENTRIES via `sync.enqueueEntries`, so the store must NOT also enqueue
   *  the journal FILE — a `enqueueFile` re-feed cannot recover per-section taint
   *  (index-sync.ts header). */
  store: MemoryStore;
  sync: IndexSync;
  /** The provider- and turn-state-bound map runner for this user. */
  runner: DreamRunner;
  /** Snapshot the session store: all entries (append order) + the current
   *  `maxSeq`. The window is `(mark.lastSeq, maxSeq]`, cut by `projectForDreaming`. */
  readWindow(): { entries: SessionEntry[]; maxSeq: number };
}

export interface DreamTransactionDeps {
  /** Opens one user's dream scope, or null when it cannot be built (memory off,
   *  deep-memory app absent, or provider unavailable) — a null is a `failed`
   *  outcome with no mark movement. */
  openDreamScope(userId: string): DreamScopeHandle | null;
  /** Lightweight mark read for the catch-up due check — no scope open, just the
   *  mark file in the user's memory dir. */
  readDreamMark(userId: string): DreamMark;
  /** `orchestrator.memory` — `cfg.dreamer.catch_up_threshold_hours` is the only
   *  field this module reads directly. */
  cfg: OrchestratorConfig["memory"];
  /** Injected clock (ms). Defaults to `Date.now` — tests pass a fake. */
  now?: () => number;
  /** Injected for tests only: lets a test drive the journal-write outcome
   *  (ok / scan-refused) without standing up a real MemoryStore. Defaults to the
   *  real `writeDreamOutputs`. */
  writeOutputs?: typeof realWriteDreamOutputs;
  /** Injected for tests only: the reconciler write arm. Defaults to the real
   *  `applyOps`; crash tests stub it to throw at the apply boundary. */
  applyOps?: typeof realApplyOps;
}

export interface DreamTransaction {
  /** The ENABLED path: full episodic dream for one user (map → write → flush →
   *  advance). NEVER throws — a map-stage or write failure resolves as `failed`
   *  with the mark untouched. */
  runDreamFor(userId: string): Promise<DreamOutcome>;
  /** The DISABLED path: advance the mark to the current maxSeq WITHOUT running,
   *  so a toggled-off user never accrues an unbounded backlog. NEVER throws. */
  skipAndAdvance(userId: string): Promise<DreamOutcome>;
  /** The FIRST-RUN path: advance the mark to the current maxSeq WITHOUT dreaming
   *  the back-history (spec §8 checkpoint init). Reuses `skipAndAdvance`'s
   *  mechanics; distinct status/log so an operator can see the mark was seeded
   *  rather than a night skipped. NEVER throws. */
  initialize(userId: string): Promise<DreamOutcome>;
  /** The boot decision from the mark alone (no scope open). `initialize` when the
   *  mark is missing / `lastRunAt` null / unparseable; `dream` when it exists and
   *  is stale; `skip` when it exists and is recent. */
  bootDecisionFor(userId: string): Promise<BootDecision>;
}

// ---------------------------------------------------------------------------
// Status record
// ---------------------------------------------------------------------------

interface DreamStatusRecord {
  lastRunAt: string;
  result: DreamOutcome["result"];
  sessions: number;
  ops: number;
  durationMs: number;
  reason?: string;
}

/** Best-effort persisted status (spec §8). A write failure here must never sink
 *  a dream that otherwise succeeded — the mark is the durable checkpoint, this
 *  is an observability surface — so it only WARNs. */
async function writeStatus(memoryDir: string, record: DreamStatusRecord): Promise<void> {
  try {
    await writeFileAtomic(join(memoryDir, STATUS_FILENAME), JSON.stringify(record, null, 2), { mode: 0o600 });
  } catch (err) {
    log.warn("dreamer.status.write-failed", { reason: err instanceof Error ? err.message : String(err) });
  }
}

// ---------------------------------------------------------------------------
// Pure helpers (reduce-stage inputs)
// ---------------------------------------------------------------------------

/** Reads the store's CURRENT distilled memory for the reduce prompt: MEMORY.md
 *  body + every topic file (slug + body). Absent files read as empty strings so
 *  a first-ever dream reconciles against a clean slate rather than crashing. */
function readCurrentMemory(store: MemoryStore): CurrentMemory {
  const core = store.readCore() ?? "";
  const topics = store.listTopics().map((t) => ({ slug: t.name, body: store.readTopic(t.name) ?? "" }));
  return { core, topics };
}

/** Builds the reconciler's `sessionsIndex` from the map result: each session's
 *  taint bit plus the seq ranges its FACTS cited, so a reduce op's `sources`
 *  resolve back (via range overlap) to the exact contributing sessions —
 *  tainted-first, the §3.8 purge-hook ordering. A session with no facts still
 *  appears (empty ranges) so its taint is available if an op somehow cites it. */
function buildSessionsIndex(result: DreamResult): SessionIndexEntry[] {
  return result.sessions.map((session) => ({
    sessionId: session.sessionId,
    containsToolDerived: session.containsToolDerived,
    ranges: session.facts.flatMap((fact) => fact.sources),
  }));
}

// ---------------------------------------------------------------------------
// Transaction
// ---------------------------------------------------------------------------

export function createDreamTransaction(deps: DreamTransactionDeps): DreamTransaction {
  const now = deps.now ?? ((): number => Date.now());
  const writeOutputs = deps.writeOutputs ?? realWriteDreamOutputs;
  const applyOps = deps.applyOps ?? realApplyOps;

  /** `YYYY-MM-DD` in LOCAL time (matches logging/format.ts's local-clock rule so
   *  the journal date lines up with "today's log"). */
  function localDate(ms: number): string {
    const d = new Date(ms);
    const y = d.getFullYear();
    const m = `${d.getMonth() + 1}`.padStart(2, "0");
    const day = `${d.getDate()}`.padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  async function runDreamFor(userId: string): Promise<DreamOutcome> {
    const startedAt = now();
    const handle = deps.openDreamScope(userId);
    if (handle === null) {
      log.warn("dreamer.run.failed", { userId, reason: "scope-unavailable" });
      return { result: "failed", sessions: 0, ops: 0, durationMs: now() - startedAt, reason: "scope-unavailable" };
    }

    const mark = handle.runner.readMark(handle.memoryDir);
    const { entries, maxSeq } = handle.readWindow();
    const runAtIso = new Date(now()).toISOString();

    // MAP — wrap so a template-load throw (runMapStage calls loadTemplate
    // internally) or any other map failure is caught here (T18b review M1): the
    // night is abandoned WITHOUT advancing the mark, so the next run redoes it.
    let result: DreamResult;
    try {
      const window = projectForDreaming(entries, mark.lastSeq, maxSeq);
      result = await handle.runner.runMapStage({ userId: handle.userId, memoryDir: handle.memoryDir }, window);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log.warn("dreamer.run.failed", { userId, reason: "map-stage", detail: reason });
      const durationMs = now() - startedAt;
      await writeStatus(handle.memoryDir, {
        lastRunAt: runAtIso,
        result: "failed",
        sessions: 0,
        ops: 0,
        durationMs,
        reason: "map-stage",
      });
      return { result: "failed", sessions: 0, ops: 0, durationMs, reason: "map-stage" };
    }

    // SEMANTIC HALF — reduce → reconcile → write → flush → mark. Wrapped so an
    // UNEXPECTED throw anywhere here is a `failed` crash (mark untouched → the
    // next run redoes the window), while the GRACEFUL degradations (a null
    // reduce or a reconciler refusal) fall through to `ok-episodic-only` WITH the
    // mark advanced. The difference is the whole point: a crash lost the episodes
    // too; an episodic-only night committed them.
    try {
      const applied = await reconcileMemory(handle, result, userId);

      // WRITE — fail-closed: a scan-refused journal returns ok:false and enqueues
      // NOTHING; we abandon the night WITHOUT advancing the mark (spec §8). The
      // op log carries the APPLIED ops only (empty on an episodic-only refusal).
      const date = localDate(now());
      const written = writeOutputs(handle.store, handle.sync, handle.scopeId, date, result, applied.ops);
      if (!written.ok) {
        log.warn("dreamer.run.failed", { userId, reason: "journal-refused", error: written.error });
        const durationMs = now() - startedAt;
        await writeStatus(handle.memoryDir, {
          lastRunAt: runAtIso,
          result: "failed",
          sessions: 0,
          ops: 0,
          durationMs,
          reason: "journal-refused",
        });
        return { result: "failed", sessions: 0, ops: 0, durationMs, reason: "journal-refused" };
      }

      // Index drain is best-effort — a dead service defers, never drops (index-sync
      // header). The journal is the canonical artifact; the mark advances even if
      // the flush is deferred, because the outbox replays it on the next flush.
      try {
        await handle.sync.flush();
      } catch (err) {
        log.warn("dreamer.flush.deferred", { userId, reason: err instanceof Error ? err.message : String(err) });
      }

      // MARK LAST — the checkpoint that makes the window immutable and the run
      // idempotent. Reached on a clean journal write whether or not the semantic
      // half was refused (episodes are canonical either way).
      handle.runner.advanceMark(handle.memoryDir, maxSeq, runAtIso);

      const sessions = written.episodeEntries;
      const opsCount = applied.ops.length;
      const durationMs = now() - startedAt;
      const result_ = applied.refusedReason === undefined ? "ok" : "ok-episodic-only";
      await writeStatus(handle.memoryDir, {
        lastRunAt: runAtIso,
        result: result_,
        sessions,
        ops: opsCount,
        durationMs,
        ...(applied.refusedReason === undefined ? {} : { reason: applied.refusedReason }),
      });
      log.info("dreamer.run.ok", {
        userId,
        sessions,
        ops: opsCount,
        episodicOnly: result_ === "ok-episodic-only",
        duration_ms: durationMs,
      });
      return {
        result: result_,
        sessions,
        ops: opsCount,
        durationMs,
        ...(applied.refusedReason === undefined ? {} : { reason: applied.refusedReason }),
      };
    } catch (err) {
      // A crash in the semantic/write phase (reduce, reconcile, journal write, or
      // mark advance threw). The mark advances only as the LAST step, so a throw
      // before it leaves the window intact; a throw AT advanceMark leaves the
      // journal written but the mark stale — the next run redoes it (last-wins).
      const detail = err instanceof Error ? err.message : String(err);
      log.warn("dreamer.run.failed", { userId, reason: "crash", detail });
      const durationMs = now() - startedAt;
      await writeStatus(handle.memoryDir, {
        lastRunAt: runAtIso,
        result: "failed",
        sessions: 0,
        ops: 0,
        durationMs,
        reason: "crash",
      });
      return { result: "failed", sessions: 0, ops: 0, durationMs, reason: "crash" };
    }
  }

  /** The semantic half's non-crash logic: read current memory → run the reduce
   *  call → reconcile the ops. Returns the APPLIED op log (empty when the reduce
   *  double-failed or the reconciler refused) plus the refusal reason that makes
   *  the night `ok-episodic-only`. THROWS on an unexpected failure — the caller's
   *  try/catch turns that into a `failed` crash. */
  async function reconcileMemory(
    handle: DreamScopeHandle,
    result: DreamResult,
    userId: string,
  ): Promise<{ ops: AppliedOpLog[]; refusedReason: string | undefined }> {
    const currentMemory = readCurrentMemory(handle.store);
    const ops = await handle.runner.runReduceStage(
      { userId: handle.userId, memoryDir: handle.memoryDir },
      result,
      currentMemory,
    );

    if (ops === null) {
      log.warn("dreamer.reduce.episodic-only", { userId, reason: "reduce-unavailable" });
      return { ops: [], refusedReason: "reduce-unavailable" };
    }
    if (ops.length === 0) {
      // A quiet night: nothing warranted a change. Not a refusal — a clean `ok`.
      return { ops: [], refusedReason: undefined };
    }

    const reconcilerDeps: ReconcilerDeps = {
      // Retire the removed line's index entry through the sync layer's
      // supersession bookkeeping (index-sync `retireEntry`). Bound here from the
      // scope's own sync — the reconciler cannot derive index ids itself.
      retireLine: async (target, oldLine, reason) => {
        handle.sync.retireEntry(target, oldLine, reason);
      },
      scan: scanContent,
    };
    const sessionsIndex = buildSessionsIndex(result);
    const applyResult = await applyOps(handle.store, reconcilerDeps, handle.scopeId, ops, sessionsIndex, deps.cfg);
    if (applyResult.ok) {
      return { ops: applyResult.applied, refusedReason: undefined };
    }
    // Rail / scan / cap / old_line refusal — the episodes are NOT lost: write the
    // journal with NO ops, advance the mark, record the refusal (spec §8 the
    // reconciler is fail-closed; the episodic checkpoint is not).
    log.warn("dreamer.reduce.episodic-only", { userId, reason: "reduce-refused", refused: applyResult.refused });
    return { ops: [], refusedReason: `reduce-refused:${applyResult.refused}` };
  }

  /** Advance the mark to the current head WITHOUT dreaming — the shared mechanic
   *  behind both the toggle-off skip (`skipped`) and the first-run seed
   *  (`initialized`). No journal, no index entries, NO provider call: nothing is
   *  distilled, so the back-history is never fed to the LLM. */
  async function advanceWithoutDreaming(
    userId: string,
    result: "skipped" | "initialized",
    reason: string,
    logEvent: string,
  ): Promise<DreamOutcome> {
    const startedAt = now();
    const handle = deps.openDreamScope(userId);
    if (handle === null) {
      log.warn("dreamer.run.failed", { userId, reason: "scope-unavailable" });
      return { result: "failed", sessions: 0, ops: 0, durationMs: now() - startedAt, reason: "scope-unavailable" };
    }
    const { maxSeq } = handle.readWindow();
    const runAtIso = new Date(now()).toISOString();
    handle.runner.advanceMark(handle.memoryDir, maxSeq, runAtIso);
    const durationMs = now() - startedAt;
    await writeStatus(handle.memoryDir, { lastRunAt: runAtIso, result, sessions: 0, ops: 0, durationMs, reason });
    log.info(logEvent, { userId, reason, advancedTo: maxSeq, duration_ms: durationMs });
    return { result, sessions: 0, ops: 0, durationMs, reason };
  }

  function skipAndAdvance(userId: string): Promise<DreamOutcome> {
    // Toggle-off no-backlog rule (spec §8 per-user toggle).
    return advanceWithoutDreaming(userId, "skipped", "dreaming-off", "dreamer.run.skipped");
  }

  function initialize(userId: string): Promise<DreamOutcome> {
    // First-run mark seed — the paid-spend guard: a dreamer freshly enabled on a
    // gateway with existing session history must NOT dream that whole history at
    // boot. Seed the mark to the current head; the next NIGHTLY dreams only what
    // arrives after this point.
    return advanceWithoutDreaming(userId, "initialized", "first-run", "dreamer.run.initialized");
  }

  async function bootDecisionFor(userId: string): Promise<BootDecision> {
    const mark = deps.readDreamMark(userId);
    // Missing / never-run / unparseable ⇒ FIRST RUN: seed the mark, do not dream.
    if (mark.lastRunAt === null) return "initialize";
    const lastRunMs = Date.parse(mark.lastRunAt);
    if (Number.isNaN(lastRunMs)) return "initialize";
    // A mark exists with a real timestamp: catch up ONLY when it is stale.
    const ageMs = now() - lastRunMs;
    return ageMs > deps.cfg.dreamer.catch_up_threshold_hours * MS_PER_HOUR ? "dream" : "skip";
  }

  return { runDreamFor, skipAndAdvance, initialize, bootDecisionFor };
}
