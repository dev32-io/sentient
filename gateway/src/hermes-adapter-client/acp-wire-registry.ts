import { getLog } from "../logging/logger.js";
import type { AcpPerProfileConnection } from "./per-profile-connection.js";

// ---------------------------------------------------------------------------
// AcpWireRegistry — one pooled ACP wire per userId, ref-counted across the
// PersonSession's device attachments.
//
// WHY: the gateway opens ONE ACP wire per client WebSocket, but the Hermes
// overlay (`acp_ws_server.py`) permits ONE ACP WS per profile and EVICTS the
// prior one with a clean 1000 close when a second client (e.g. webui + mobile)
// connects for the same user. Dialing a second wire therefore tears down the
// first. Pooling one wire per userId — mirroring the existing multi-attachment
// PersonSession model — removes the second dial, hence the eviction.
//
// CONTRACT:
//   - First `acquire(userId)` dials. Concurrent acquires for the same userId
//     await the single in-flight dial promise (no double-dial race).
//   - A subsequent `acquire` for a userId with a LIVE wire reuses it and bumps
//     the refCount — no new overlay connection.
//   - `release(userId)` decrements the refCount; the underlying wire is
//     disposed ONLY when the count reaches zero (last attachment detaches).
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

/** Dials a fresh wire for a user. Injected so the pool never imports bootstrap. */
export type AcpWireDialFn = () => Promise<AcpWireHandle>;

export interface AcpWireRegistry {
  /**
   * Acquire the user's pooled wire, dialing on first acquire and reusing
   * (refCount++) on every subsequent one. Concurrent first acquires share a
   * single dial. Resolves with the live `acpConn`.
   */
  acquire(userId: string, dial: AcpWireDialFn): Promise<AcpPerProfileConnection>;
  /**
   * Release one reference. Disposes the underlying wire when the last
   * reference is released. A release of an unknown / already-disposed user is
   * a logged no-op.
   */
  release(userId: string): void;
  /** Test/observability hook: current reference count for a user (0 if absent). */
  refCount(userId: string): number;
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

  async function acquire(userId: string, dial: AcpWireDialFn): Promise<AcpPerProfileConnection> {
    const existing = pool.get(userId);
    if (existing) {
      existing.refCount += 1;
      log.info("acquire.reuse", { userId, refCount: existing.refCount });
      // Awaits the same in-flight dial promise if the first dial is still
      // pending; resolves immediately once the handle is live.
      const handle = await existing.dialPromise;
      return handle.acpConn;
    }

    log.info("acquire.dial", { userId });
    const dialPromise = dial();
    const entry: PoolEntry = { dialPromise, handle: null, refCount: 1 };
    pool.set(userId, entry);

    try {
      const handle = await dialPromise;
      entry.handle = handle;
      log.info("acquire.dial-ok", { userId, refCount: entry.refCount });
      return handle.acpConn;
    } catch (err: unknown) {
      // Drop the poisoned entry so a later acquire retries with a fresh dial.
      // Only drop if it's still THIS entry (a release during the failed dial
      // could have already cleared it).
      if (pool.get(userId) === entry) pool.delete(userId);
      log.warn("acquire.dial-failed", {
        userId,
        reason: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  function release(userId: string): void {
    const entry = pool.get(userId);
    if (!entry) {
      log.debug("release.noop", { userId, reason: "no-pooled-wire" });
      return;
    }
    entry.refCount -= 1;
    log.info("release", { userId, refCount: entry.refCount });
    if (entry.refCount > 0) return;

    // Last reference gone — drop the entry and dispose the underlying wire.
    pool.delete(userId);
    if (entry.handle !== null) {
      log.info("release.dispose", { userId });
      entry.handle.dispose();
      return;
    }
    // Released while the dial is still in flight: dispose once it settles so a
    // wire is never left orphaned. A rejected dial already self-cleaned above.
    log.info("release.dispose-pending-dial", { userId });
    entry.dialPromise
      .then((handle) => handle.dispose())
      .catch(() => {
        /* failed dial — nothing to dispose */
      });
  }

  function refCount(userId: string): number {
    return pool.get(userId)?.refCount ?? 0;
  }

  return { acquire, release, refCount };
}
