import { getLog } from "../logging/logger.js";
import { type SessionReplayBuffer, createSessionReplayBuffer } from "../session-handlers/session-replay-buffer.js";

const log = getLog(["sentient", "person-session", "device-buffer-store"]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Raw writer pair for the device's CURRENT live socket. */
export interface DeviceSocketSink {
  sendText: (s: string) => void;
  sendBinary: (b: Uint8Array) => void;
}

/**
 * Shared, mutable reference to the device's CURRENT live socket writer.
 * Lives on the device buffer entry so it SURVIVES reconnects (keyed by
 * deviceId). Every DeviceAttachment for the device resolves this ref at send
 * time rather than capturing its own socket — so a STALE attachment still
 * driving an in-flight Hermes cycle after a resumable reconnect writes its
 * post-resume frames (the final answer + cycle.done) to the NEW socket instead
 * of the dead old one. `null` while the device is disconnected: frames still
 * journal into the buffer (replayed on the next resume); the socket write
 * no-ops.
 */
export interface DeviceSocketRef {
  current: DeviceSocketSink | null;
}

export interface DeviceBufferEntry {
  readonly buffer: SessionReplayBuffer;
  readonly epoch: number;
  detachedAtMs: number | null;
  /**
   * The device's current live socket writer, shared across every attachment
   * for this device and across reconnects. See DeviceSocketRef.
   */
  readonly liveSocket: DeviceSocketRef;
  /**
   * Teardown actions deferred from a resumable disconnect (Task 3.7).
   * Stashed so the sweep can run them when the TTL expires without a
   * reconnect. Must be idempotent (guard flag inside the closure).
   * Cleared (set to null) when the device reconnects via acquireDeviceBuffer
   * so it doesn't fire after a successful resume.
   */
  deferredTeardown: (() => void) | null;
}

export interface AcquireDeviceBufferResult {
  readonly buffer: SessionReplayBuffer;
  readonly epoch: number;
  readonly resumed: boolean;
  /**
   * The deferred teardown that was stashed on the entry by the prior resumable
   * disconnect (Task 3.7), RETURNED here on a matching-epoch resume so the
   * caller (ws-session-configure) can run it NOW — disposing the orphaned old
   * pipeline (gate / ACP wire / sessionManager entry / translator) before the
   * new session configures fresh on the SAME buffer (Task 3.8 handover). null
   * when there was nothing stashed, or on a fresh (non-resumed) acquire.
   *
   * acquire() detaches it from the entry (sets entry.deferredTeardown = null)
   * so the retention sweep can NOT also run it later — exactly-once handover.
   */
  readonly priorDeferredTeardown: (() => void) | null;
  /**
   * The device's shared live-socket ref. The caller hands this to the new
   * DeviceAttachment so its sequencer writes resolve the current socket, and
   * so a stale in-flight cycle's old sequencer (sharing this same ref) follows
   * to the new socket after a resume. Reused across reconnects.
   */
  readonly liveSocket: DeviceSocketRef;
}

// ---------------------------------------------------------------------------
// Pure predicate
// ---------------------------------------------------------------------------

/**
 * Pure predicate: should a device buffer entry be evicted?
 * Detached entries older than `ttlMs` are eligible for eviction.
 * An entry that is still attached (detachedAtMs === null) is never evicted.
 */
export function shouldEvictDeviceBuffer(detachedAtMs: number | null, nowMs: number, ttlMs: number): boolean {
  return detachedAtMs !== null && nowMs - detachedAtMs >= ttlMs;
}

// ---------------------------------------------------------------------------
// DeviceBufferStore
// ---------------------------------------------------------------------------

/**
 * Manages the per-device replay buffer map for a PersonSession.
 * Owns the buffer Map, epoch counter, acquire/release/sweep logic.
 *
 * NOTE: Each buffer is keyed per-device-session; no cross-device fan-out
 * (B3 scope) — a user's other live device does not journal into this
 * device's buffer.
 */
export class DeviceBufferStore {
  private readonly _buffers = new Map<string, DeviceBufferEntry>();
  private _epochCounter = 0;
  private readonly _maxBytes: number;

  constructor(replayBufferMaxBytes: number) {
    this._maxBytes = replayBufferMaxBytes;
  }

  /**
   * Acquire a replay buffer for a reconnecting or newly-connecting device.
   *
   * - If an entry for `deviceId` exists AND `resumeEpoch` matches its epoch
   *   AND it hasn't been evicted → reuse the buffer (clear detachedAtMs),
   *   `resumed: true`.
   * - Otherwise → bump the epoch counter, create a fresh buffer, `resumed: false`.
   *
   * Note: passing no `resumeEpoch` (or `undefined`) on an existing entry
   * always produces a fresh buffer + new epoch because `undefined` never
   * equals a real epoch number.
   */
  acquire(deviceId: string, opts: { resumeEpoch?: number } = {}): AcquireDeviceBufferResult {
    const existing = this._buffers.get(deviceId);
    if (existing !== undefined && opts.resumeEpoch === existing.epoch) {
      existing.detachedAtMs = null;
      // Detach the pending deferred teardown and HAND IT BACK to the caller.
      // The device reconnected before the TTL expired, so the sweep must not
      // run it — but the orphaned old pipeline from the prior disconnect still
      // needs disposing. We return it so ws-session-configure runs it NOW (the
      // handover) and clear it off the entry so it fires exactly once.
      const priorDeferredTeardown = existing.deferredTeardown;
      if (priorDeferredTeardown !== null) {
        log.debug("acquire.handover-deferred-teardown", { deviceId, epoch: existing.epoch });
        existing.deferredTeardown = null;
      }
      log.debug("acquire.resumed", { deviceId, epoch: existing.epoch });
      return {
        buffer: existing.buffer,
        epoch: existing.epoch,
        resumed: true,
        priorDeferredTeardown,
        liveSocket: existing.liveSocket,
      };
    }

    this._epochCounter += 1;
    const epoch = this._epochCounter;
    const buffer = createSessionReplayBuffer({ maxBytes: this._maxBytes });
    const entry: DeviceBufferEntry = {
      buffer,
      epoch,
      detachedAtMs: null,
      liveSocket: { current: null },
      deferredTeardown: null,
    };
    this._buffers.set(deviceId, entry);
    log.debug("acquire.fresh", {
      deviceId,
      epoch,
      prevEpoch: existing?.epoch ?? null,
    });
    return { buffer, epoch, resumed: false, priorDeferredTeardown: null, liveSocket: entry.liveSocket };
  }

  /**
   * Mark a device buffer as detached (start its TTL clock).
   * The buffer is retained briefly for a quick reconnect.
   * An optional deferredTeardown callback is stashed on the entry and
   * invoked by sweepExpired when the TTL expires without a reconnect.
   */
  release(deviceId: string, deferredTeardown?: () => void): void {
    const entry = this._buffers.get(deviceId);
    if (entry === undefined) {
      log.warn("release.not-found", { deviceId });
      return;
    }
    entry.detachedAtMs = Date.now();
    entry.deferredTeardown = deferredTeardown ?? null;
    log.debug("release", { deviceId, epoch: entry.epoch, hasDeferredTeardown: deferredTeardown !== undefined });
  }

  /**
   * Immediately remove the device buffer entry (full teardown path).
   * Unlike release(), this does not start a TTL — it disposes the entry
   * outright. Used on explicit session.end / logout where replay retention
   * is unwanted.
   */
  dispose(deviceId: string): void {
    const entry = this._buffers.get(deviceId);
    if (entry === undefined) {
      // debug (not warn) — expected when the buffer was already swept by TTL
      // expiry or never acquired for this device (e.g. pre-configure teardown).
      // Contrast with release.not-found which is warn because release is always
      // preceded by a successful acquire on the same code path.
      log.debug("dispose.not-found", { deviceId });
      return;
    }
    this._buffers.delete(deviceId);
    log.debug("dispose", { deviceId, epoch: entry.epoch });
  }

  /** Read the replay buffer for a device (undefined if not present). */
  bufferFor(deviceId: string): SessionReplayBuffer | undefined {
    return this._buffers.get(deviceId)?.buffer;
  }

  /** Read the current epoch for a device (undefined if not present). */
  epochFor(deviceId: string): number | undefined {
    return this._buffers.get(deviceId)?.epoch;
  }

  /**
   * Evict device buffer entries that have been detached longer than `ttlMs`.
   * For each evicted entry that carries a deferredTeardown, the teardown is
   * invoked exactly once (the closure is idempotent by construction).
   * Returns the number of entries evicted.
   */
  sweepExpired(nowMs: number, ttlMs: number): number {
    let evicted = 0;
    for (const [deviceId, entry] of this._buffers) {
      if (shouldEvictDeviceBuffer(entry.detachedAtMs, nowMs, ttlMs)) {
        this._buffers.delete(deviceId);
        evicted += 1;
        log.debug("sweepExpired.evicted", {
          deviceId,
          epoch: entry.epoch,
          detachedAtMs: entry.detachedAtMs,
          hasDeferredTeardown: entry.deferredTeardown !== null,
        });
        if (entry.deferredTeardown !== null) {
          try {
            entry.deferredTeardown();
          } catch (err: unknown) {
            log.warn("sweepExpired.deferred-teardown-failed", {
              deviceId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
    }
    return evicted;
  }

  /**
   * Returns true when at least one device buffer entry is still retained —
   * including entries for currently-attached (not yet detached) devices.
   * A live attached device blocks session eviction just as much as a detached
   * but not-yet-expired one.
   */
  hasRetainedBuffers(): boolean {
    return this._buffers.size > 0;
  }
}
