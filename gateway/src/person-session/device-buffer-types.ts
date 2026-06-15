// Types for DeviceBufferStore — extracted to keep device-buffer-store.ts under 300 lines.
import type { SessionReplayBuffer } from "../session-handlers/session-replay-buffer.js";
import type { ActivityClock } from "../session/activity/activity-clock.js";

/** Raw writer pair for the surface's CURRENT live socket. */
export interface DeviceSocketSink {
  sendText: (s: string) => void;
  sendBinary: (b: Uint8Array) => void;
}

/**
 * Shared, mutable reference to the surface's CURRENT live socket writer.
 * Lives on the surface buffer entry so it SURVIVES reconnects (keyed by
 * surfaceId). Every DeviceAttachment for the surface resolves this ref at
 * send time rather than capturing its own socket — so a STALE attachment
 * still driving an in-flight Hermes cycle after a resumable reconnect writes
 * its post-resume frames (the final answer + cycle.done) to the NEW socket
 * instead of the dead old one. `null` while the surface is disconnected:
 * frames still journal into the buffer (replayed on the next resume); the
 * socket write no-ops.
 */
export interface DeviceSocketRef {
  current: DeviceSocketSink | null;
}

export interface DeviceBufferEntry {
  /** Physical device this surface belongs to. CARRIED for device-presence
   *  (Steward attached-devices, idle-archive); NEVER the map key (keyed by surfaceId). */
  readonly deviceId: string;
  readonly buffer: SessionReplayBuffer;
  readonly epoch: number;
  detachedAtMs: number | null;
  /**
   * The surface's current live socket writer, shared across every attachment
   * for this surface and across reconnects. See DeviceSocketRef.
   */
  readonly liveSocket: DeviceSocketRef;
  /**
   * Teardown actions deferred from a resumable disconnect (Task 3.7).
   * Stashed so the sweep can run them when the TTL expires without a
   * reconnect. Must be idempotent (guard flag inside the closure).
   * Cleared (set to null) when the surface reconnects via acquireDeviceBuffer
   * so it doesn't fire after a successful resume.
   */
  deferredTeardown: (() => void) | null;
  /** Activity clock — single idle source of truth for this surface's session.
   *  Reused across reconnects (same entry), like liveSocket. */
  readonly clock: ActivityClock;
  /** Closes the CURRENT live WS for this surface, running the normal full
   *  teardown. Registered at session-configure. null while detached. Used by
   *  the idle sweep to reap a still-attached but silent (ping-keepalive)
   *  session. Cleared on detach. */
  forceClose: (() => void) | null;
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
   * The surface's shared live-socket ref. The caller hands this to the new
   * DeviceAttachment so its sequencer writes resolve the current socket, and
   * so a stale in-flight cycle's old sequencer (sharing this same ref) follows
   * to the new socket after a resume. Reused across reconnects.
   */
  readonly liveSocket: DeviceSocketRef;
  /** The surface's activity clock, reused across reconnects. */
  readonly clock: ActivityClock;
}
