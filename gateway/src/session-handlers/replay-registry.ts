// ReplayRegistry — the per-SESSION home for a FrameJournal that must OUTLIVE
// both the socket that filled it and the runtime that produced it
// (session-model spec §2.3).
//
// Keying: `sessionId`. It was `${userId}::${surfaceId}` while a connection was
// the unit of state, which made two browser tabs of one user two independent
// seq spaces — the exact thing "one journal, N cursors" forbids. The journal is
// now acquired ONCE per session, by the attachment that builds the session's
// handles, and released when those handles are disposed.
//
// Epoch: a registry-global monotonic counter, incremented every time a FRESH
// journal is minted for any session. Never reused, so a client holding a stale
// epoch can never accidentally match a recreated entry. It is what a resuming
// client's `resume.epoch` is compared against — a match means its seq cursor is
// in the same space this journal is still allocating from.
//
// LEASES, NOW A SET. The lease discipline carries over as OWNERSHIP HYGIENE and
// nothing more: a lease is minted per acquisition, and only a lease the entry
// still holds may release it, so a superseded or duplicated teardown cannot
// park a journal something live is still filling. What does
// NOT carry over is the single-OWNER half. The old entry held one `leaseId` and
// a second acquisition minted a fresh journal underneath the first, because two
// sockets sharing one seq counter would silently split the stream. Under one
// journal per session that is inverted: sharing the counter is the POINT, and
// minting a second journal for the same session is what would split the stream.
// So an entry holds a SET of leases and is detached only when the set empties.
//
// Retention: swept lazily inside acquire() and release() rather than on a
// timer. release() runs whenever a session's handles are disposed, so the sweep
// does too — growth is bounded without introducing a second lifecycle to reason
// about. Surviving disposal is the point: a window that reconnects inside the
// retention window presents its cursor and gets the frames it missed rather
// than a truncated conversation.

import { getLog } from "../logging/logger.js";
import { type FrameJournal, createFrameJournal } from "./frame-journal.js";

const log = getLog(["sentient", "ws", "replay-registry"]);

/**
 * Per-acquisition ownership token for one session's registry entry.
 *
 * Carries its own `sessionId` so a caller can never release lease A against
 * session B, and compares by `id`, which is registry-global and never reused.
 * A holder whose entry was already swept holds a lease that matches nothing —
 * its release becomes a no-op instead of parking a live journal.
 */
export interface ReplayLease {
  /** The session this lease was minted for. */
  readonly sessionId: string;
  /** Monotonic, registry-global, never reused. */
  readonly id: number;
}

export interface ReplayAcquisition {
  readonly journal: FrameJournal;
  readonly epoch: number;
  /** True iff an EXISTING journal was reused rather than a fresh one minted.
   *  False means a fresh journal + a fresh epoch, so no client cursor into the
   *  previous stream can be honoured. */
  readonly reused: boolean;
  /** Ownership token for this acquisition; hand it back to `release`. */
  readonly lease: ReplayLease;
}

export interface ReplayRegistry {
  /** Take a hold on this session's journal, reusing the retained one whenever
   *  the registry still has it (attached or inside its retention window) and
   *  minting a fresh journal + epoch otherwise. */
  acquire(sessionId: string): ReplayAcquisition;
  /** Drop one hold. The entry starts its retention clock only when the LAST
   *  hold is released. No-op unless `lease` is one of the entry's holders. */
  release(lease: ReplayLease): void;
  readonly size: number;
}

export interface ReplayRegistryOptions {
  maxBytesPerSession: number;
  retentionMs: number;
  /** Injectable clock — the retention sweep is an FSM worth testing without
   *  wall-clock sleeps. Defaults to Date.now. */
  now?: () => number;
}

interface RegistryEntry {
  journal: FrameJournal;
  epoch: number;
  /** Every lease currently holding this entry. Non-empty means attached. */
  leaseIds: Set<number>;
  /** null while any hold remains; the detach timestamp once the set empties. */
  detachedAtMs: number | null;
}

export function createReplayRegistry(options: ReplayRegistryOptions): ReplayRegistry {
  const { maxBytesPerSession, retentionMs } = options;
  const now = options.now ?? (() => Date.now());

  const entries = new Map<string, RegistryEntry>();
  let epochCounter = 0;
  let leaseCounter = 0;

  function sweep(): void {
    const nowMs = now();
    for (const [sessionId, entry] of entries) {
      if (entry.detachedAtMs === null) continue;
      const detachedForMs = nowMs - entry.detachedAtMs;
      if (detachedForMs < retentionMs) continue;
      entries.delete(sessionId);
      log.info("replay-registry.swept", {
        sessionId,
        epoch: entry.epoch,
        detachedForMs,
        retentionMs,
        reason: "detached past the retention window",
      });
    }
  }

  function nextLease(sessionId: string): ReplayLease {
    leaseCounter += 1;
    return { sessionId, id: leaseCounter };
  }

  /** The entry, or null when `lease` is not one of its holders (an entry
   *  already swept, or a duplicated teardown). */
  function heldEntry(lease: ReplayLease, operation: string): RegistryEntry | null {
    const entry = entries.get(lease.sessionId);
    if (entry === undefined) {
      // debug, not warn: a dispose landing after the retention sweep already
      // reclaimed the entry is a normal path, not a fault.
      log.debug("replay-registry.not-found", { sessionId: lease.sessionId, operation, leaseId: lease.id });
      return null;
    }
    if (!entry.leaseIds.has(lease.id)) {
      log.warn("replay-registry.stale-lease", {
        sessionId: lease.sessionId,
        operation,
        leaseId: lease.id,
        holders: entry.leaseIds.size,
        epoch: entry.epoch,
        reason: "this lease no longer holds the session's journal; ignoring a superseded teardown",
      });
      return null;
    }
    return entry;
  }

  return {
    acquire(sessionId: string): ReplayAcquisition {
      sweep();

      const existing = entries.get(sessionId);
      if (existing !== undefined) {
        const lease = nextLease(sessionId);
        existing.leaseIds.add(lease.id);
        existing.detachedAtMs = null;
        log.info("replay-registry.reused", {
          sessionId,
          epoch: existing.epoch,
          leaseId: lease.id,
          holders: existing.leaseIds.size,
          oldestSeq: existing.journal.oldestSeq,
          newestSeq: existing.journal.newestSeq,
          journalBytes: existing.journal.byteLength,
        });
        return { journal: existing.journal, epoch: existing.epoch, reused: true, lease };
      }

      epochCounter += 1;
      const lease = nextLease(sessionId);
      const entry: RegistryEntry = {
        journal: createFrameJournal({ sessionId, maxBytes: maxBytesPerSession }),
        epoch: epochCounter,
        leaseIds: new Set([lease.id]),
        detachedAtMs: null,
      };
      entries.set(sessionId, entry);
      log.info("replay-registry.fresh", { sessionId, epoch: entry.epoch, leaseId: lease.id });
      return { journal: entry.journal, epoch: entry.epoch, reused: false, lease };
    },

    release(lease: ReplayLease): void {
      const entry = heldEntry(lease, "release");
      if (entry !== null) {
        entry.leaseIds.delete(lease.id);
        if (entry.leaseIds.size === 0) entry.detachedAtMs = now();
        log.info("replay-registry.released", {
          sessionId: lease.sessionId,
          epoch: entry.epoch,
          leaseId: lease.id,
          holders: entry.leaseIds.size,
          newestSeq: entry.journal.newestSeq,
          journalBytes: entry.journal.byteLength,
          retentionMs,
        });
      }
      // Sweep on every release, held or not — that is the only lifecycle that
      // bounds registry growth.
      sweep();
    },

    get size() {
      return entries.size;
    },
  };
}
