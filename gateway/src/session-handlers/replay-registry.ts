// ReplayRegistry — the per-surface home for a FrameJournal that must OUTLIVE
// the socket that filled it (spec §11 slice 6).
//
// Successor to the deleted person-session/device-buffer-store.ts, stripped to
// the two fields 2.0 actually needs. The old store also carried a shared
// mutable live-socket ref (so a stale in-flight ACP cycle could follow a
// resumed surface to its new socket), a deferredTeardown callback, an
// ActivityClock, and a forceClose hook. NONE of that transfers:
// SessionRuntime.dispose() is immediate and idempotent, so there is no
// orphaned pipeline to hand over and no in-flight turn that survives the
// disconnect. What survives here is bytes, and only bytes.
//
// Keying: `${userId}::${surfaceId}` (surfaceId falls back to deviceId — see
// sessionConfigureSchema.surfaceId's own contract note). Same identity
// SessionRuntime uses, so two browser tabs of one user are two surfaces with
// independent journals and epochs.
//
// Epoch: a registry-global monotonic counter, incremented every time a FRESH
// journal is minted for any surface. Never reused, so a client holding a
// stale epoch can never accidentally match a recreated entry.
//
// Leases: an epoch alone cannot answer "is this journal FREE to hand out?".
// Two sockets can legitimately be open on one surface at the same instant —
// a same-tab reload whose new session.configure lands before the old socket's
// close event, or a TCP/NAT drop Bun's idle timeout has not noticed yet — and
// the reconnecting client presents a MATCHING epoch, because it really did
// see that stream. Handing both sockets the same FrameJournal would give them
// one shared seq counter: every frame allocated by one socket is invisible to
// the other, and the client's resume cursor reads the resulting jump as
// "not yet applied" rather than as a gap, so the bytes are lost silently and
// permanently. So an entry is resumable only while DETACHED, and every
// acquisition mints a `ReplayLease` — the ownership token that entry's
// release/discard must present. A superseded connection's eventual disconnect
// therefore cannot stamp a retention clock on (or destroy) the journal the
// live connection is still filling.
//
// Retention: swept lazily inside acquire() and release() rather than on a
// timer. release() runs on every disconnect, so the sweep does too — growth
// is bounded without introducing a second lifecycle to reason about.

import { getLog } from "../logging/logger.js";
import { type FrameJournal, createFrameJournal } from "./frame-journal.js";

const log = getLog(["sentient", "ws", "replay-registry"]);

/**
 * Per-acquisition ownership token for one surface's registry entry.
 *
 * Carries its own `surfaceKey` so a caller can never release lease A against
 * key B, and compares by `id`, which is registry-global and never reused. A
 * connection whose entry has since been taken over by a newer connection
 * holds a lease that matches nothing — its release/discard become no-ops
 * instead of corrupting the live connection's journal.
 */
export interface ReplayLease {
  /** `${userId}::${surfaceId}` — the key this lease was minted for. */
  readonly surfaceKey: string;
  /** Monotonic, registry-global, never reused. */
  readonly id: number;
}

export interface ReplayAcquisition {
  readonly journal: FrameJournal;
  readonly epoch: number;
  /** True iff an EXISTING journal was reused rather than a fresh one minted.
   *  `acquire` sets it only when the entry was DETACHED and its epoch matched
   *  `resumeEpoch`; ws-session-configure.ts also builds this shape itself when
   *  a still-open connection re-configures a surface it already holds, which
   *  is the same "existing journal, existing epoch" answer arrived at without
   *  a registry round-trip. False means a fresh journal + a fresh epoch, and
   *  the caller must answer any resume request with `recovered: false`. */
  readonly resumed: boolean;
  /** Ownership token for this acquisition; hand it back to release/discard. */
  readonly lease: ReplayLease;
}

export interface ReplayRegistry {
  /** Take ownership of the surface's journal, resuming the retained one only
   *  when it is detached AND `resumeEpoch` matches; otherwise mint a fresh
   *  journal + epoch and take the key over. */
  acquire(surfaceKey: string, resumeEpoch: number | undefined): ReplayAcquisition;
  /** Mark the surface detached and start its retention clock. No-op unless
   *  `lease` is the entry's current owner. */
  release(lease: ReplayLease): void;
  /** Drop the surface outright — explicit session.end, where the client is
   *  not coming back and retaining its bytes is pure waste. No-op unless
   *  `lease` is the entry's current owner. */
  discard(lease: ReplayLease): void;
  readonly size: number;
}

export interface ReplayRegistryOptions {
  maxBytesPerSurface: number;
  retentionMs: number;
  /** Injectable clock — the retention sweep is an FSM worth testing without
   *  wall-clock sleeps. Defaults to Date.now. */
  now?: () => number;
}

interface RegistryEntry {
  journal: FrameJournal;
  epoch: number;
  /** Id of the lease that currently owns this entry. Only that lease may
   *  release or discard it. */
  leaseId: number;
  /** null while a socket is attached; the detach timestamp once released. */
  detachedAtMs: number | null;
}

export function createReplayRegistry(options: ReplayRegistryOptions): ReplayRegistry {
  const { maxBytesPerSurface, retentionMs } = options;
  const now = options.now ?? (() => Date.now());

  const entries = new Map<string, RegistryEntry>();
  let epochCounter = 0;
  let leaseCounter = 0;

  function sweep(): void {
    const nowMs = now();
    for (const [key, entry] of entries) {
      if (entry.detachedAtMs === null) continue;
      const detachedForMs = nowMs - entry.detachedAtMs;
      if (detachedForMs < retentionMs) continue;
      entries.delete(key);
      log.info("replay-registry.swept", {
        surfaceKey: key,
        epoch: entry.epoch,
        detachedForMs,
        retentionMs,
        reason: "detached past the retention window",
      });
    }
  }

  function nextLease(surfaceKey: string): ReplayLease {
    leaseCounter += 1;
    return { surfaceKey, id: leaseCounter };
  }

  function mintFresh(surfaceKey: string, reason: string, priorEpoch: number | null): ReplayAcquisition {
    epochCounter += 1;
    const lease = nextLease(surfaceKey);
    const entry: RegistryEntry = {
      journal: createFrameJournal({ maxBytes: maxBytesPerSurface }),
      epoch: epochCounter,
      leaseId: lease.id,
      detachedAtMs: null,
    };
    entries.set(surfaceKey, entry);
    log.info("replay-registry.fresh", { surfaceKey, epoch: entry.epoch, priorEpoch, leaseId: lease.id, reason });
    return { journal: entry.journal, epoch: entry.epoch, resumed: false, lease };
  }

  /** The entry, or null when `lease` no longer owns it (superseded connection
   *  or an entry already swept/discarded). */
  function ownedEntry(lease: ReplayLease, operation: string): RegistryEntry | null {
    const entry = entries.get(lease.surfaceKey);
    if (entry === undefined) {
      // debug, not warn: an explicit session.end discards the entry before
      // cleanupSession runs, so a missing entry here is a normal path.
      log.debug("replay-registry.not-found", { surfaceKey: lease.surfaceKey, operation, leaseId: lease.id });
      return null;
    }
    if (entry.leaseId !== lease.id) {
      log.warn("replay-registry.stale-lease", {
        surfaceKey: lease.surfaceKey,
        operation,
        leaseId: lease.id,
        currentLeaseId: entry.leaseId,
        epoch: entry.epoch,
        reason: "a newer connection owns this surface; ignoring the superseded connection's request",
      });
      return null;
    }
    return entry;
  }

  return {
    acquire(surfaceKey: string, resumeEpoch: number | undefined): ReplayAcquisition {
      sweep();

      const existing = entries.get(surfaceKey);
      if (existing === undefined) {
        return mintFresh(surfaceKey, resumeEpoch === undefined ? "fresh-connect" : "no-prior-journal", null);
      }
      if (existing.detachedAtMs === null) {
        // Another socket is still attached to this surface (its close event
        // has not been processed yet). Sharing the journal would share its
        // seq counter and silently split the stream across two sockets, so
        // the new connection takes the key over with a FRESH journal + epoch
        // and answers `recovered: false`; the client REST-refetches instead
        // of losing frames it will never learn are missing. The superseded
        // connection keeps writing into its now-orphaned journal, which its
        // stale lease can no longer park or destroy.
        log.warn("replay-registry.still-attached", {
          surfaceKey,
          epoch: existing.epoch,
          currentLeaseId: existing.leaseId,
          resumeEpoch: resumeEpoch ?? null,
          reason: "a live connection still holds this surface's journal",
        });
        return mintFresh(surfaceKey, "surface-still-attached", existing.epoch);
      }
      if (resumeEpoch === undefined) {
        return mintFresh(surfaceKey, "no-resume-requested", existing.epoch);
      }
      if (resumeEpoch !== existing.epoch) {
        return mintFresh(surfaceKey, "epoch-mismatch", existing.epoch);
      }

      const lease = nextLease(surfaceKey);
      existing.detachedAtMs = null;
      existing.leaseId = lease.id;
      log.info("replay-registry.resumed", {
        surfaceKey,
        epoch: existing.epoch,
        leaseId: lease.id,
        oldestSeq: existing.journal.oldestSeq,
        newestSeq: existing.journal.newestSeq,
        journalBytes: existing.journal.byteLength,
      });
      return { journal: existing.journal, epoch: existing.epoch, resumed: true, lease };
    },

    release(lease: ReplayLease): void {
      const entry = ownedEntry(lease, "release");
      if (entry !== null) {
        entry.detachedAtMs = now();
        log.info("replay-registry.released", {
          surfaceKey: lease.surfaceKey,
          epoch: entry.epoch,
          leaseId: lease.id,
          newestSeq: entry.journal.newestSeq,
          journalBytes: entry.journal.byteLength,
          retentionMs,
        });
      }
      // Sweep on every disconnect, owned or not — that is the only lifecycle
      // that bounds registry growth.
      sweep();
    },

    discard(lease: ReplayLease): void {
      const entry = ownedEntry(lease, "discard");
      if (entry === null) return;
      entries.delete(lease.surfaceKey);
      log.info("replay-registry.discarded", {
        surfaceKey: lease.surfaceKey,
        epoch: entry.epoch,
        leaseId: lease.id,
        reason: "explicit session.end",
      });
    },

    get size() {
      return entries.size;
    },
  };
}
