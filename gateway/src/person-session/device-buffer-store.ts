import { getLog } from "../logging/logger.js";
import { type SessionReplayBuffer, createSessionReplayBuffer } from "../session-handlers/session-replay-buffer.js";

const log = getLog(["sentient", "person-session", "device-buffer-store"]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DeviceBufferEntry {
  readonly buffer: SessionReplayBuffer;
  readonly epoch: number;
  detachedAtMs: number | null;
}

export interface AcquireDeviceBufferResult {
  readonly buffer: SessionReplayBuffer;
  readonly epoch: number;
  readonly resumed: boolean;
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
      log.debug("acquire.resumed", { deviceId, epoch: existing.epoch });
      return { buffer: existing.buffer, epoch: existing.epoch, resumed: true };
    }

    this._epochCounter += 1;
    const epoch = this._epochCounter;
    const buffer = createSessionReplayBuffer({ maxBytes: this._maxBytes });
    const entry: DeviceBufferEntry = { buffer, epoch, detachedAtMs: null };
    this._buffers.set(deviceId, entry);
    log.debug("acquire.fresh", {
      deviceId,
      epoch,
      prevEpoch: existing?.epoch ?? null,
    });
    return { buffer, epoch, resumed: false };
  }

  /**
   * Mark a device buffer as detached (start its TTL clock).
   * The buffer is retained briefly for a quick reconnect.
   */
  release(deviceId: string): void {
    const entry = this._buffers.get(deviceId);
    if (entry === undefined) {
      log.warn("release.not-found", { deviceId });
      return;
    }
    entry.detachedAtMs = Date.now();
    log.debug("release", { deviceId, epoch: entry.epoch });
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
        });
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
