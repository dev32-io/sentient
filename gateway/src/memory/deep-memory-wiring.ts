// Deep-memory composition (Memory System spec §5, §6) — the app-lifetime and
// per-scope wiring the composition root (bootstrap/phase-services.ts) hangs the
// memory subsystem off. Kept OUT of phase-services so the composition root stays
// a wiring file and this domain logic carries its own focused unit test.
//
// THREE things live here:
//
//   1. DeepMemoryApp — one per process. Owns the single DeepMemoryClient, the
//      per-scope IndexSync outboxes (one writer per scope — spec §5.6), the
//      idempotent scope-registration ledger, and a modest health self-poll that
//      re-registers + drains every scope when the service comes back.
//   2. createSessionSpark — binds a per-session MemoryRetriever to this
//      session's static turn context (userId, scope ids, child flag, sessionId),
//      exposing the two-method port SessionRuntime primes at turn start and the
//      situation block reads synchronously.
//   3. withIndexSync — wraps a MemoryStore so a SUCCESSFUL file write enqueues
//      the changed file into the scope's outbox and kicks a flush (spec §5.6:
//      writes feed the index; a dead service defers, never drops).
//
// SCOPE CONVENTIONS (S1/S2 — the household scope is T24):
//   - scopeId   = `user:<userId>` (matches the service's fixture shape).
//   - indexDir  = `<memory-cap.rootPath>/deep-memory` — the gateway-side dir
//     that holds BOTH the sync cursor (`.sync-cursor.json`) and the service's
//     own `index.db` (spec §2, §5.3: derived, rebuildable, disposable).
//   - indexPath = `<indexDir>/index.db` — the register-scope path the service
//     opens. The deep-memory service's `storage.data_root` must contain this
//     path (it is the gateway's `user_data_root`); a mismatch is refused with
//     `path_outside_data_root` and memory degrades non-fatally (spec §11).
//
// REGISTRATION-BEFORE-SEARCH is an invariant, not a hope: every scope-naming
// client op (search/upsert/…) returned by `ensureScope` awaits that scope's
// registration landing first. A post-boot-created user therefore registers on
// its first session build, before its first spark search can fire.
//
// No memory content in logs (global constraint): only scope ids, error kinds
// and counts are logged here — never entry or query text.

import { getLog } from "../logging/logger.js";
import { createDeepMemoryClient } from "./deep-memory-client.js";
import type { DeepMemoryClient } from "./deep-memory-client.js";
import { createIndexSync } from "./index-sync.js";
import type { IndexSync } from "./index-sync.js";
import type { MemoryRetriever } from "./memory-retriever.js";
import type { MemoryConfig, MemoryStore } from "./memory-store.js";

const log = getLog(["sentient", "memory", "deep-wiring"]);

/** How often the app self-polls `/health`; a false→true edge drives
 *  `onHealthRecovered`. An internal recovery cadence, not a behavioural tunable
 *  (the config rule exempts impl details) — the index-sync's own write-driven
 *  retry already backstops staleness, so this only makes the drain PROMPT when
 *  the service returns rather than waiting for the next write. */
const HEALTH_POLL_MS = 30_000;

/** The relPaths `withIndexSync` enqueues on a successful write, mirroring
 *  index-sync's own `parseFileTarget` vocabulary. */
const CORE_RELPATH = "MEMORY.md";
const TOPICS_PREFIX = "topics/";
const JOURNAL_PREFIX = "journal/";
const MD_EXT = ".md";

// ---------------------------------------------------------------------------
// Per-turn spark port
// ---------------------------------------------------------------------------

/** The two-method port SessionRuntime drives. `prime` runs the deadline-bounded
 *  recall at turn start (before the first provider call); `current` is the
 *  synchronous read the situation block's memory closure makes per iteration. */
export interface SessionSpark {
  /** Compute + cache this turn's spark block on the finalized user utterance.
   *  Deadline-bounded inside the retriever, so it cannot stall a turn. An empty
   *  utterance (a background-completion trigger turn) is a no-op. */
  prime(turnId: string, utterance: string): Promise<void>;
  /** The current turn's cached spark block, or null when none was primed / it
   *  was withheld. Read synchronously by the situation block. */
  current(): string | null;
}

/** The static per-session context the spark's SparkTurn is assembled from. */
export interface SessionSparkContext {
  userId: string;
  /** Opaque index scope ids this session searches (private, +family at T24). */
  scopeIds: string[];
  childPrincipal: boolean;
  /** The DURABLE session id — threaded into the SparkTurn purely so the gate's
   *  trace line correlates on the real session, not the turn id. */
  sessionId: string;
}

/**
 * Binds a per-session retriever to its static turn context. `current()` reads
 * the retriever's own memo (`cachedFor`) — the single source of truth — keyed
 * by the last-primed turn, so a byte-identical block is returned across every
 * ReAct iteration of the turn (cache-stable, spec §6).
 */
export function createSessionSpark(retriever: MemoryRetriever, ctx: SessionSparkContext): SessionSpark {
  let currentTurnId: string | null = null;
  return {
    async prime(turnId: string, utterance: string): Promise<void> {
      currentTurnId = turnId;
      if (utterance.trim() === "") return; // no user utterance — nothing to recall
      await retriever.computeSpark({
        utterance,
        turnId,
        sessionId: ctx.sessionId,
        userId: ctx.userId,
        scopeIds: ctx.scopeIds,
        childPrincipal: ctx.childPrincipal,
      });
    },
    current(): string | null {
      return currentTurnId === null ? null : retriever.cachedFor(currentTurnId);
    },
  };
}

// ---------------------------------------------------------------------------
// Store write → index-sync enqueue
// ---------------------------------------------------------------------------

/**
 * Wraps a MemoryStore so every SUCCESSFUL file write enqueues the changed file
 * into the scope's outbox and kicks a (fire-and-forget) flush. This is the S2
 * seam that keeps the derived index following the canonical notes: a `memory_write`
 * lands in the file, the wrapper projects its sections into pending index rows,
 * and flush upserts them — deferring silently when the service is down.
 */
export function withIndexSync(store: MemoryStore, sync: IndexSync): MemoryStore {
  const enqueue = (relPath: string): void => {
    sync.enqueueFile(relPath);
    void sync.flush();
  };
  return {
    ...store,
    writeCore(next: string) {
      const result = store.writeCore(next);
      if (result.ok) enqueue(CORE_RELPATH);
      return result;
    },
    writeTopic(slug, meta, body) {
      const result = store.writeTopic(slug, meta, body);
      if (result.ok) enqueue(`${TOPICS_PREFIX}${slug}${MD_EXT}`);
      return result;
    },
    writeJournal(date, content) {
      const result = store.writeJournal(date, content);
      if (result.ok) enqueue(`${JOURNAL_PREFIX}${date}${MD_EXT}`);
      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// Registration-gated client
// ---------------------------------------------------------------------------

/** Wraps a client so every scope-naming op awaits `ready()` — the scope's
 *  current registration attempt — before it runs. `registerScope` (which IS the
 *  registration) and `health` (auth-free) pass through ungated. */
function gatedClient(base: DeepMemoryClient, ready: () => Promise<void>): DeepMemoryClient {
  const gate =
    <A extends unknown[], R>(fn: (...args: A) => Promise<R>): ((...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      await ready();
      return fn(...args);
    };
  return {
    registerScope: base.registerScope,
    upsert: gate(base.upsert),
    search: gate(base.search),
    setStatus: gate(base.setStatus),
    purge: gate(base.purge),
    rebuild: gate(base.rebuild),
    health: base.health,
  };
}

// ---------------------------------------------------------------------------
// DeepMemoryApp — app-lifetime singleton
// ---------------------------------------------------------------------------

/** The per-scope wiring `ensureScope` hands back: the single-writer outbox and
 *  the registration-gated client both the retriever and `memory_recall` search
 *  through. */
export interface ScopeWiring {
  scopeId: string;
  sync: IndexSync;
  client: DeepMemoryClient;
}

/** Everything one scope needs to be wired: its opaque id, the gateway-side dir
 *  its cursor + index live in, the register-scope path, and its file store. */
export interface ScopeInput {
  scopeId: string;
  indexDir: string;
  indexPath: string;
  store: MemoryStore;
}

export interface DeepMemoryApp {
  /** Idempotent, memoized per scope: registers the scope (once, gating every
   *  later search on it) and builds its single-writer outbox. */
  ensureScope(input: ScopeInput): ScopeWiring;
  /** Re-register every known scope and drain its outbox — the health-recovery
   *  drain (spec §5.6). Driven by the self-poll below. */
  onHealthRecovered(): void;
  /** Stops the health self-poll. */
  stop(): void;
}

export interface DeepMemoryAppOptions {
  baseUrl: string;
  adminToken: string;
  dataToken: string;
  requestTimeoutMs: number;
  cfg: MemoryConfig;
  /** Test seam: inject a client + skip the real self-poll timer. */
  client?: DeepMemoryClient;
  pollMs?: number;
}

interface ScopeEntry {
  input: ScopeInput;
  /** Mutable so a health recovery can re-attempt registration and every gated
   *  client (which reads through the holder) picks the fresh attempt up. */
  holder: { ready: Promise<void> };
  wiring: ScopeWiring;
}

/**
 * Builds the app-lifetime deep-memory wiring. The self-poll starts immediately
 * (unref'd — never the reason the process stays alive) unless `pollMs <= 0`.
 */
export function createDeepMemoryApp(opts: DeepMemoryAppOptions): DeepMemoryApp {
  const baseClient =
    opts.client ??
    createDeepMemoryClient({
      baseUrl: opts.baseUrl,
      adminToken: opts.adminToken,
      dataToken: opts.dataToken,
      requestTimeoutMs: opts.requestTimeoutMs,
    });
  const entries = new Map<string, ScopeEntry>();

  function attemptRegister(input: ScopeInput): Promise<void> {
    return baseClient.registerScope(input.scopeId, input.indexPath).then((result) => {
      if (result.ok) {
        log.info("deep-memory.scope.registered", { scopeId: input.scopeId });
      } else {
        log.warn("deep-memory.scope.register-deferred", { scopeId: input.scopeId, errorKind: result.error.kind });
      }
    });
  }

  function ensureScope(input: ScopeInput): ScopeWiring {
    const existing = entries.get(input.scopeId);
    if (existing) return existing.wiring;

    const holder = { ready: attemptRegister(input) };
    const client = gatedClient(baseClient, () => holder.ready);
    const sync = createIndexSync(
      { scopeId: input.scopeId, store: input.store, indexDir: input.indexDir },
      client,
      opts.cfg,
    );
    const wiring: ScopeWiring = { scopeId: input.scopeId, sync, client };
    entries.set(input.scopeId, { input, holder, wiring });
    return wiring;
  }

  function onHealthRecovered(): void {
    log.info("deep-memory.health-recovered", { scopes: entries.size });
    for (const entry of entries.values()) {
      // Re-register (idempotent on the service) so a scope that failed to
      // register during the outage is repaired, THEN drain its outbox.
      entry.holder.ready = attemptRegister(entry.input);
      void entry.holder.ready.then(() => entry.wiring.sync.onHealthRecovered());
    }
  }

  const pollMs = opts.pollMs ?? HEALTH_POLL_MS;
  let lastHealthy: boolean | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  if (pollMs > 0) {
    timer = setInterval(() => {
      void baseClient.health().then((result) => {
        const healthy = result.ok;
        if (healthy && lastHealthy === false) onHealthRecovered();
        lastHealthy = healthy;
      });
    }, pollMs);
    // A recovery poll must never be the reason the process stays alive.
    timer.unref?.();
  }

  return {
    ensureScope,
    onHealthRecovered,
    stop(): void {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
