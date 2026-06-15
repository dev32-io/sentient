import { getLog } from "../logging/logger.js";
import { type SessionReplayBuffer, createSessionReplayBuffer } from "../session-handlers/session-replay-buffer.js";
import { createActivityClock } from "../session/activity/activity-clock.js";
import type { AcquireDeviceBufferResult, DeviceBufferEntry } from "./device-buffer-types.js";

// Re-export so existing consumers that import from this module continue to work.
export type {
  AcquireDeviceBufferResult,
  DeviceBufferEntry,
  DeviceSocketRef,
  DeviceSocketSink,
} from "./device-buffer-types.js";

const log = getLog(["sentient", "person-session", "device-buffer-store"]);

// ---------------------------------------------------------------------------
// DeviceBufferStore
// ---------------------------------------------------------------------------

/**
 * Manages the per-surface replay buffer map for a PersonSession.
 * Owns the buffer Map, epoch counter, acquire/release/sweep logic.
 *
 * NOTE: Each buffer is keyed per-SURFACE (chat tab / app instance), not per
 * device — two web tabs of one browser share a deviceId but have independent
 * buffers and epochs. The deviceId is CARRIED on the entry for device-presence
 * queries (Steward attached-devices, idle-archive) but is NEVER the map key.
 */
export class DeviceBufferStore {
  private readonly _buffers = new Map<string, DeviceBufferEntry>();
  private _epochCounter = 0;
  private readonly _maxBytes: number;

  constructor(replayBufferMaxBytes: number) {
    this._maxBytes = replayBufferMaxBytes;
  }

  /**
   * Acquire a replay buffer for a reconnecting or newly-connecting surface.
   *
   * - If an entry for `surfaceId` exists AND `resumeEpoch` matches its epoch
   *   AND it hasn't been evicted → reuse the buffer (clear detachedAtMs),
   *   `resumed: true`.
   * - Otherwise → bump the epoch counter, create a fresh buffer, `resumed: false`.
   *
   * Note: passing no `resumeEpoch` (or `undefined`) on an existing entry
   * always produces a fresh buffer + new epoch because `undefined` never
   * equals a real epoch number.
   *
   * `opts.deviceId` is stored as a carried field for device-presence queries
   * (Steward, idle-archive). It is never used as a map key.
   */
  acquire(surfaceId: string, opts: { deviceId: string; resumeEpoch?: number }): AcquireDeviceBufferResult {
    const existing = this._buffers.get(surfaceId);
    if (existing !== undefined && opts.resumeEpoch === existing.epoch) {
      existing.detachedAtMs = null;
      // Detach the pending deferred teardown and HAND IT BACK to the caller.
      // The surface reconnected before the TTL expired, so the sweep must not
      // run it — but the orphaned old pipeline from the prior disconnect still
      // needs disposing. We return it so ws-session-configure runs it NOW (the
      // handover) and clear it off the entry so it fires exactly once.
      const priorDeferredTeardown = existing.deferredTeardown;
      if (priorDeferredTeardown !== null) {
        log.debug("acquire.handover-deferred-teardown", {
          surfaceId,
          deviceId: existing.deviceId,
          epoch: existing.epoch,
        });
        existing.deferredTeardown = null;
      }
      log.debug("acquire.resumed", { surfaceId, deviceId: existing.deviceId, epoch: existing.epoch });
      return {
        buffer: existing.buffer,
        epoch: existing.epoch,
        resumed: true,
        priorDeferredTeardown,
        liveSocket: existing.liveSocket,
        clock: existing.clock,
      };
    }

    this._epochCounter += 1;
    const epoch = this._epochCounter;
    const buffer = createSessionReplayBuffer({ maxBytes: this._maxBytes });
    const entry: DeviceBufferEntry = {
      deviceId: opts.deviceId,
      buffer,
      epoch,
      detachedAtMs: null,
      liveSocket: { current: null },
      deferredTeardown: null,
      clock: createActivityClock(),
      forceClose: null,
    };
    this._buffers.set(surfaceId, entry);
    log.debug("acquire.fresh", {
      surfaceId,
      deviceId: opts.deviceId,
      epoch,
      prevEpoch: existing?.epoch ?? null,
    });
    return {
      buffer,
      epoch,
      resumed: false,
      priorDeferredTeardown: null,
      liveSocket: entry.liveSocket,
      clock: entry.clock,
    };
  }

  /** Register the live-WS close hook for a surface (called at session-configure). */
  setForceClose(surfaceId: string, forceClose: (() => void) | null): void {
    const entry = this._buffers.get(surfaceId);
    if (entry !== undefined) entry.forceClose = forceClose;
  }

  /**
   * Mark a surface buffer as detached (start its TTL clock).
   * The buffer is retained briefly for a quick reconnect.
   * An optional deferredTeardown callback is stashed on the entry and
   * invoked by sweepIdle when the idle timeout expires without a reconnect.
   */
  release(surfaceId: string, deferredTeardown?: () => void): void {
    const entry = this._buffers.get(surfaceId);
    if (entry === undefined) {
      log.warn("release.not-found", { surfaceId });
      return;
    }
    entry.detachedAtMs = Date.now();
    entry.deferredTeardown = deferredTeardown ?? null;
    entry.forceClose = null;
    log.debug("release", {
      surfaceId,
      deviceId: entry.deviceId,
      epoch: entry.epoch,
      hasDeferredTeardown: deferredTeardown !== undefined,
    });
  }

  /**
   * Immediately remove the surface buffer entry (full teardown path).
   * Unlike release(), this does not start a TTL — it disposes the entry
   * outright. Used on explicit session.end / logout where replay retention
   * is unwanted.
   */
  dispose(surfaceId: string): void {
    const entry = this._buffers.get(surfaceId);
    if (entry === undefined) {
      // debug (not warn) — expected when the buffer was already swept by TTL
      // expiry or never acquired for this surface (e.g. pre-configure teardown).
      // Contrast with release.not-found which is warn because release is always
      // preceded by a successful acquire on the same code path.
      log.debug("dispose.not-found", { surfaceId });
      return;
    }
    this._buffers.delete(surfaceId);
    log.debug("dispose", { surfaceId, deviceId: entry.deviceId, epoch: entry.epoch });
  }

  /** Read the replay buffer for a surface (undefined if not present). */
  bufferFor(surfaceId: string): SessionReplayBuffer | undefined {
    return this._buffers.get(surfaceId)?.buffer;
  }

  /** Read the current epoch for a surface (undefined if not present). */
  epochFor(surfaceId: string): number | undefined {
    return this._buffers.get(surfaceId)?.epoch;
  }

  /** Read the carried deviceId for a surface (undefined if absent). */
  deviceIdFor(surfaceId: string): string | undefined {
    return this._buffers.get(surfaceId)?.deviceId;
  }

  /**
   * Reap surface buffers that have been idle (no activity-clock touch) for
   * >= idleTimeoutMs. Detached entries -> remove + run deferred teardown.
   * Still-attached entries (a ping-keepalive client) -> invoke forceClose
   * (the normal full teardown via WS close); the entry is removed on the
   * resulting detach/dispose, not here. Returns the number of entries
   * REMOVED here (attached forceClose excluded).
   */
  sweepIdle(nowMs: number, idleTimeoutMs: number): number {
    let removed = 0;
    for (const [surfaceId, entry] of this._buffers) {
      if (entry.clock.idleMs(nowMs) < idleTimeoutMs) continue;
      const attached = entry.detachedAtMs === null;
      if (attached) {
        log.info("sweepIdle.force-close", {
          surfaceId,
          deviceId: entry.deviceId,
          epoch: entry.epoch,
          idleMs: entry.clock.idleMs(nowMs),
        });
        try {
          entry.forceClose?.();
        } catch (err: unknown) {
          log.warn("sweepIdle.force-close-failed", {
            surfaceId,
            deviceId: entry.deviceId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        continue;
      }
      this._buffers.delete(surfaceId);
      removed += 1;
      log.info("sweepIdle.evicted", {
        surfaceId,
        deviceId: entry.deviceId,
        epoch: entry.epoch,
        idleMs: entry.clock.idleMs(nowMs),
      });
      if (entry.deferredTeardown !== null) {
        try {
          entry.deferredTeardown();
        } catch (err: unknown) {
          log.warn("sweepIdle.deferred-teardown-failed", {
            surfaceId,
            deviceId: entry.deviceId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
    return removed;
  }

  /**
   * Returns true when at least one surface buffer entry is still retained —
   * including entries for currently-attached (not yet detached) surfaces.
   * A live attached surface blocks session eviction just as much as a detached
   * but not-yet-expired one.
   */
  hasRetainedBuffers(): boolean {
    return this._buffers.size > 0;
  }
}
