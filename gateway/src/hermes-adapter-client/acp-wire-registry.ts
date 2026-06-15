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
}

interface PoolEntry {
  /** Resolves to the live handle once the dial completes; rejects on dial failure. */
  readonly dialPromise: Promise<AcpWireHandle>;
  /** Live handle once dialed; null while the dial is still in flight. */
  handle: AcpWireHandle | null;
  refCount: number;
}

export function createAcpWireRegistry(): AcpWireRegistry {
  const pool = new Map<string, PoolEntry>();

  async function acquire(surfaceId: string, dial: AcpWireDialFn): Promise<AcpPerProfileConnection> {
    const existing = pool.get(surfaceId);
    if (existing) {
      existing.refCount += 1;
      log.info("acquire.reuse", { surfaceId, refCount: existing.refCount });
      // Awaits the same in-flight dial promise if the first dial is still
      // pending; resolves immediately once the handle is live.
      const handle = await existing.dialPromise;
      return handle.acpConn;
    }

    log.info("acquire.dial", { surfaceId });
    const dialPromise = dial();
    const entry: PoolEntry = { dialPromise, handle: null, refCount: 1 };
    pool.set(surfaceId, entry);

    try {
      const handle = await dialPromise;
      entry.handle = handle;
      log.info("acquire.dial-ok", { surfaceId, refCount: entry.refCount });
      return handle.acpConn;
    } catch (err: unknown) {
      // Drop the poisoned entry so a later acquire retries with a fresh dial.
      // Only drop if it's still THIS entry (a release during the failed dial
      // could have already cleared it).
      if (pool.get(surfaceId) === entry) pool.delete(surfaceId);
      log.warn("acquire.dial-failed", {
        surfaceId,
        reason: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  function release(surfaceId: string): void {
    const entry = pool.get(surfaceId);
    if (!entry) {
      log.debug("release.noop", { surfaceId, reason: "no-pooled-wire" });
      return;
    }
    entry.refCount -= 1;
    log.info("release", { surfaceId, refCount: entry.refCount });
    if (entry.refCount > 0) return;

    // Last reference gone — drop the entry and dispose the underlying wire.
    pool.delete(surfaceId);
    if (entry.handle !== null) {
      log.info("release.dispose", { surfaceId });
      entry.handle.dispose();
      return;
    }
    // Released while the dial is still in flight: dispose once it settles so a
    // wire is never left orphaned. A rejected dial already self-cleaned above.
    log.info("release.dispose-pending-dial", { surfaceId });
    entry.dialPromise
      .then((handle) => handle.dispose())
      .catch(() => {
        /* failed dial — nothing to dispose */
      });
  }

  function refCount(surfaceId: string): number {
    return pool.get(surfaceId)?.refCount ?? 0;
  }

  return { acquire, release, refCount };
}
