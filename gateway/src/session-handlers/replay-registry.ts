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
// Retention: swept lazily inside acquire() and release() rather than on a
// timer. release() runs on every disconnect, so the sweep does too — growth
// is bounded without introducing a second lifecycle to reason about.

import { getLog } from "../logging/logger.js";
import { type FrameJournal, createFrameJournal } from "./frame-journal.js";

const log = getLog(["sentient", "ws", "replay-registry"]);

export interface ReplayAcquisition {
  readonly journal: FrameJournal;
  readonly epoch: number;
  /** True iff an existing journal was reused because `resumeEpoch` matched
   *  its epoch. False means a fresh journal + a fresh epoch, and the caller
   *  must answer any resume request with `recovered: false`. */
  readonly resumed: boolean;
}

export interface ReplayRegistry {
  acquire(surfaceKey: string, resumeEpoch: number | undefined): ReplayAcquisition;
  /** Mark the surface detached and start its retention clock. */
  release(surfaceKey: string): void;
  /** Drop the surface outright — explicit session.end, where the client is
   *  not coming back and retaining its bytes is pure waste. */
  discard(surfaceKey: string): void;
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
  /** null while a socket is attached; the detach timestamp once released. */
  detachedAtMs: number | null;
}

export function createReplayRegistry(options: ReplayRegistryOptions): ReplayRegistry {
  const { maxBytesPerSurface, retentionMs } = options;
  const now = options.now ?? (() => Date.now());

  const entries = new Map<string, RegistryEntry>();
  let epochCounter = 0;

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

  function mintFresh(surfaceKey: string, reason: string, priorEpoch: number | null): ReplayAcquisition {
    epochCounter += 1;
    const entry: RegistryEntry = {
      journal: createFrameJournal({ maxBytes: maxBytesPerSurface }),
      epoch: epochCounter,
      detachedAtMs: null,
    };
    entries.set(surfaceKey, entry);
    log.info("replay-registry.fresh", { surfaceKey, epoch: entry.epoch, priorEpoch, reason });
    return { journal: entry.journal, epoch: entry.epoch, resumed: false };
  }

  return {
    acquire(surfaceKey: string, resumeEpoch: number | undefined): ReplayAcquisition {
      sweep();

      const existing = entries.get(surfaceKey);
      if (existing === undefined) {
        return mintFresh(surfaceKey, resumeEpoch === undefined ? "fresh-connect" : "no-prior-journal", null);
      }
      if (resumeEpoch === undefined) {
        return mintFresh(surfaceKey, "no-resume-requested", existing.epoch);
      }
      if (resumeEpoch !== existing.epoch) {
        return mintFresh(surfaceKey, "epoch-mismatch", existing.epoch);
      }

      existing.detachedAtMs = null;
      log.info("replay-registry.resumed", {
        surfaceKey,
        epoch: existing.epoch,
        oldestSeq: existing.journal.oldestSeq,
        newestSeq: existing.journal.newestSeq,
        journalBytes: existing.journal.byteLength,
      });
      return { journal: existing.journal, epoch: existing.epoch, resumed: true };
    },

    release(surfaceKey: string): void {
      const entry = entries.get(surfaceKey);
      if (entry === undefined) {
        // debug, not warn: an explicit session.end discards the entry before
        // cleanupSession runs, so a missing entry here is a normal path.
        log.debug("replay-registry.release.not-found", { surfaceKey });
        return;
      }
      entry.detachedAtMs = now();
      log.info("replay-registry.released", {
        surfaceKey,
        epoch: entry.epoch,
        newestSeq: entry.journal.newestSeq,
        journalBytes: entry.journal.byteLength,
        retentionMs,
      });
      sweep();
    },

    discard(surfaceKey: string): void {
      const entry = entries.get(surfaceKey);
      if (entry === undefined) {
        log.debug("replay-registry.discard.not-found", { surfaceKey });
        return;
      }
      entries.delete(surfaceKey);
      log.info("replay-registry.discarded", { surfaceKey, epoch: entry.epoch, reason: "explicit session.end" });
    },

    get size() {
      return entries.size;
    },
  };
}
