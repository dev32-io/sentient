import { getLog } from "../logging/logger.js";
import type { AcpPerProfileConnection } from "./per-profile-connection.js";

// ---------------------------------------------------------------------------
// AcpWireRegistry — one pooled ACP wire per SURFACE (chat tab / app instance),
// ref-counted across that surface's reconnects. The Hermes overlay spawns a
// fresh child per connection, so per-surface wires are fully isolated; a
// surface's reconnect reuses the same surfaceId → warm child. Two surfaces of
// the same user therefore get two separate wires and two separate Hermes
// children, preventing the "fork" duplicate-conversation bug that occurred when
// the key was userId (both surfaces shared one child).
//
// CONTRACT:
//   - First `acquire(surfaceId)` dials. Concurrent acquires for the same
//     surfaceId await the single in-flight dial promise (no double-dial race).
//   - A subsequent `acquire` for a surfaceId with a LIVE wire reuses it and
//     bumps the refCount — no new overlay connection.
//   - `release(surfaceId)` decrements the refCount; the underlying wire is
//     disposed ONLY when the count reaches zero (last reconnect detaches).
//   - A failed dial removes the entry so a later acquire can retry cleanly —
//     no poisoned entry lingers.
//
// The dial fn is injected so the registry stays decoupled from
// `bootstrapAcpWire`'s signature and is trivially mockable in tests.
// ---------------------------------------------------------------------------

const log = getLog(["sentient", "hermes-adapter-client", "acp-wire-registry"]);

/** A live, disposable ACP wire — the subset of bootstrap's result the pool owns. */
export interface AcpWireHandle {
  readonly acpConn: AcpPerProfileConnection;
  /** Tear down the WS + ACP connection. Idempotent. */
  dispose(): void;
}

/** Dials a fresh wire for a surface. Injected so the pool never imports bootstrap. */
export type AcpWireDialFn = () => Promise<AcpWireHandle>;

export interface AcpWireRegistry {
  /**
   * Acquire the surface's pooled wire, dialing on first acquire and reusing
   * (refCount++) on every subsequent one. Concurrent first acquires share a
   * single dial. Resolves with the live `acpConn`.
   */
  acquire(surfaceId: string, dial: AcpWireDialFn): Promise<AcpPerProfileConnection>;
  /**
   * Release one reference. Disposes the underlying wire when the last
   * reference is released. A release of an unknown / already-disposed surfaceId
   * is a logged no-op.
   */
  release(surfaceId: string): void;
  /** Test/observability hook: current reference count for a surface (0 if absent). */
  refCount(surfaceId: string): number;
  /** True iff any wire is still pooled (retention guard input). */
  hasLiveWires(): boolean;
  /** Force-dispose every pooled handle (PersonSession.dispose backstop). */
  disposeAll(): void;
}

interface PoolEntry {
  /** Resolves to the live handle once the dial completes; rejects on dial failure. */
  readonly dialPromise: Promise<AcpWireHandle>;
  /** Live handle once dialed; null while the dial is still in flight. */
  handle: AcpWireHandle | null;
  refCount: number;
  /** Owner stamped at dial resolution — the regression canary (§4.3). */
  ownerUserId: string;
}

// ownerUserId is optional ONLY during the migration: the process-global
// instantiation (phase-routes) has no user and passes nothing. That global is
// deleted in Task 9, after which PersonSession is the sole caller and always
// passes a real userId. The default keeps every intermediate commit
// typecheck-green while the caller migration is in flight.
export function createAcpWireRegistry(ownerUserId = "__unowned__"): AcpWireRegistry {
  const pool = new Map<string, PoolEntry>();

  async function acquire(surfaceId: string, dial: AcpWireDialFn): Promise<AcpPerProfileConnection> {
    const existing = pool.get(surfaceId);
    if (existing) {
      // Regression canary: within a per-user pool this is always true. If it
      // ever fires, a shared pool was reintroduced — fail closed.
      if (existing.ownerUserId !== ownerUserId) {
        log.error("acquire.owner-mismatch", { surfaceId, stored: existing.ownerUserId, expected: ownerUserId });
        throw new Error("acp-wire-registry: owner mismatch on cache hit");
      }
      existing.refCount += 1;
      log.info("acquire.reuse", { ownerUserId, surfaceId, refCount: existing.refCount });
      const handle = await existing.dialPromise;
      return handle.acpConn;
    }

    log.info("acquire.dial", { ownerUserId, surfaceId });
    const dialPromise = dial();
    const entry: PoolEntry = { dialPromise, handle: null, refCount: 1, ownerUserId };
    pool.set(surfaceId, entry);

    try {
      const handle = await dialPromise;
      entry.handle = handle;
      log.info("acquire.dial-ok", { ownerUserId, surfaceId, refCount: entry.refCount });
      return handle.acpConn;
    } catch (err: unknown) {
      // Drop the poisoned entry so a later acquire retries with a fresh dial.
      // Only drop if it's still THIS entry (a release during the failed dial
      // could have already cleared it).
      if (pool.get(surfaceId) === entry) pool.delete(surfaceId);
      log.warn("acquire.dial-failed", {
        ownerUserId,
        surfaceId,
        reason: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  function release(surfaceId: string): void {
    const entry = pool.get(surfaceId);
    if (!entry) {
      log.debug("release.noop", { ownerUserId, surfaceId, reason: "no-pooled-wire" });
      return;
    }
    entry.refCount -= 1;
    log.info("release", { ownerUserId, surfaceId, refCount: entry.refCount });
    if (entry.refCount > 0) return;

    // Last reference gone — drop the entry and dispose the underlying wire.
    pool.delete(surfaceId);
    if (entry.handle !== null) {
      log.info("release.dispose", { ownerUserId, surfaceId });
      entry.handle.dispose();
      return;
    }
    // Released while the dial is still in flight: dispose once it settles so a
    // wire is never left orphaned. A rejected dial already self-cleaned above.
    log.info("release.dispose-pending-dial", { ownerUserId, surfaceId });
    entry.dialPromise
      .then((handle) => handle.dispose())
      .catch(() => {
        /* failed dial — nothing to dispose */
      });
  }

  function refCount(surfaceId: string): number {
    return pool.get(surfaceId)?.refCount ?? 0;
  }

  function hasLiveWires(): boolean {
    return pool.size > 0;
  }

  function disposeAll(): void {
    if (pool.size === 0) return;
    log.warn("disposeAll", { ownerUserId, count: pool.size, reason: "force-dispose-backstop" });
    for (const [surfaceId, entry] of pool) {
      try {
        if (entry.handle !== null) {
          entry.handle.dispose();
        } else {
          entry.dialPromise
            .then((h) => h.dispose())
            .catch(() => {
              /* failed dial — nothing to dispose */
            });
        }
        log.debug("disposeAll.entry", { ownerUserId, surfaceId, refCount: entry.refCount });
      } catch (err: unknown) {
        // Continue disposing remaining entries even if one throws.
        log.warn("disposeAll.dispose-entry-failed", {
          ownerUserId,
          surfaceId,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
    pool.clear();
  }

  return { acquire, release, refCount, hasLiveWires, disposeAll };
}
