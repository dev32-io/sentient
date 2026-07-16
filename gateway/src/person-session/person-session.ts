import { getLog } from "../logging/logger.js";
import type { SessionReplayBuffer } from "../session-handlers/session-replay-buffer.js";
import {
  type AcquireDeviceBufferResult,
  type DeviceBufferEntry,
  DeviceBufferStore,
  type DeviceSocketRef,
  type DeviceSocketSink,
} from "./device-buffer-store.js";

const log = getLog(["sentient", "person-session"]);

export type { DeviceBufferEntry, AcquireDeviceBufferResult, DeviceSocketRef, DeviceSocketSink };

/**
 * One PersonSession per profile (alice/bob/family). Owns the rolling
 * conversation and everything derived from it: history, ambient context,
 * preferences, Hermes chain continuity, audio pipeline state.
 *
 * Devices (web tabs, phones, ESP32s) attach to a PersonSession via
 * DeviceAttachment and become windows into that person's conversation.
 * The same conversation is shared by every attachment; any attachment
 * can drive input; output fans out.
 */

/**
 * Opaque attachment token. DeviceAttachment lands in B2; for now the
 * registry just tracks identity (so detach-before-attach-existed cases
 * log cleanly) and iteration count (so tests can assert fan-out).
 */
export interface PersonSessionAttachment {
  readonly attachmentId: string;
}

export interface PersonSessionInit {
  readonly profile: string;
  readonly hermesUrl: string;
  readonly hermesApiKey: string;
  readonly userId: string | null;
  /** Max bytes retained per per-device replay buffer. */
  readonly replayBufferMaxBytes: number;
}

export class PersonSession {
  readonly profile: string;
  readonly hermesUrl: string;
  readonly hermesApiKey: string;
  readonly userId: string | null;

  /**
   * Last Hermes response id for chain continuity on this profile. Mutated
   * after each cycle completes. Survives attach/detach — the point of
   * hoisting it up here is so a reconnecting tab resumes the same chain.
   */
  private _lastResponseId: string | null = null;
  /**
   * Resolved local-tts voice id for this person, hydrated from the user's
   * profile.json#voice.id. `null` means "no per-user override resolved yet —
   * fall back to the gateway-wide default voiceId from cfg.tts.voice_id".
   * Mutated by the registry when profile.json is saved or first loaded.
   */
  private _voiceId: string | null = null;
  private readonly _attachments = new Set<PersonSessionAttachment>();
  private readonly _createdAtMs: number;
  private readonly _deviceBuffers: DeviceBufferStore;

  /**
   * Timestamp when the session first became idle (attachmentCount went to 0).
   * Reset to null when an attachment is added. Starts at createdAtMs (a
   * freshly created session with no attachments is immediately idle).
   */
  private _idleSinceMs: number;

  /**
   * Recently-seen client pendingIds for idempotent resend dedup. A resend
   * (same pendingId on a new connection after reconnect) is rejected so it is
   * re-echoed via replay/REST history but NOT re-dispatched to Hermes. Bounded
   * insertion-ordered; evicts with the session at retention. Survives reconnect
   * (the whole point of placing it here, like _lastResponseId).
   */
  private readonly _recentPendingIds = new Set<string>();
  private static readonly PENDING_ID_CAP = 256;

  constructor(init: PersonSessionInit) {
    this.profile = init.profile;
    this.hermesUrl = init.hermesUrl;
    this.hermesApiKey = init.hermesApiKey;
    this.userId = init.userId;
    this._deviceBuffers = new DeviceBufferStore(init.replayBufferMaxBytes);
    this._createdAtMs = Date.now();
    this._idleSinceMs = this._createdAtMs;
    log.info("created", {
      profile: this.profile,
      hermesUrl: this.hermesUrl,
      userId: this.userId,
    });
  }

  get lastResponseId(): string | null {
    return this._lastResponseId;
  }

  setLastResponseId(id: string | null): void {
    const prev = this._lastResponseId;
    this._lastResponseId = id;
    log.debug("lastResponseId.update", {
      profile: this.profile,
      prev,
      next: id,
    });
  }

  /**
   * Returns true if [pendingId] is new (record it and admit the message),
   * false if it was already seen (a resend — caller must skip re-dispatch).
   */
  admitPendingId(pendingId: string): boolean {
    if (this._recentPendingIds.has(pendingId)) return false;
    this._recentPendingIds.add(pendingId);
    if (this._recentPendingIds.size > PersonSession.PENDING_ID_CAP) {
      const oldest = this._recentPendingIds.values().next().value;
      if (oldest !== undefined) this._recentPendingIds.delete(oldest);
    }
    return true;
  }

  get voiceId(): string | null {
    return this._voiceId;
  }

  setVoiceId(id: string | null): void {
    const prev = this._voiceId;
    if (prev === id) return;
    this._voiceId = id;
    log.info("voiceId.update", {
      profile: this.profile,
      userId: this.userId,
      prev,
      next: id,
    });
  }

  get attachmentCount(): number {
    return this._attachments.size;
  }

  attachments(): readonly PersonSessionAttachment[] {
    return [...this._attachments];
  }

  attach(a: PersonSessionAttachment): void {
    if (this._attachments.has(a)) {
      log.warn("attach.duplicate", {
        profile: this.profile,
        attachmentId: a.attachmentId,
        reason: "attachment already registered",
      });
      return;
    }
    this._attachments.add(a);
    // Session is no longer idle — reset idle clock.
    this._idleSinceMs = 0;
    log.info("attach", {
      profile: this.profile,
      attachmentId: a.attachmentId,
      attachmentCount: this._attachments.size,
    });
  }

  detach(a: PersonSessionAttachment): void {
    const removed = this._attachments.delete(a);
    if (removed && this._attachments.size === 0) {
      this._idleSinceMs = Date.now();
    }
    log.info("detach", {
      profile: this.profile,
      attachmentId: a.attachmentId,
      removed,
      attachmentCount: this._attachments.size,
    });
  }

  // ---------------------------------------------------------------------------
  // Per-device replay buffer API — delegates to DeviceBufferStore
  // ---------------------------------------------------------------------------

  acquireDeviceBuffer(surfaceId: string, opts: { deviceId: string; resumeEpoch?: number }): AcquireDeviceBufferResult {
    const result = this._deviceBuffers.acquire(surfaceId, opts);
    log.debug(`acquireDeviceBuffer.${result.resumed ? "resumed" : "fresh"}`, {
      profile: this.profile,
      surfaceId,
      deviceId: opts.deviceId,
      epoch: result.epoch,
    });
    return result;
  }

  releaseDeviceBuffer(surfaceId: string, deferredTeardown?: () => void): void {
    this._deviceBuffers.release(surfaceId, deferredTeardown);
    log.debug("releaseDeviceBuffer", {
      profile: this.profile,
      surfaceId,
      hasDeferredTeardown: deferredTeardown !== undefined,
    });
  }

  /**
   * Immediately remove the surface buffer entry without starting a TTL.
   * Used on explicit session.end / logout where replay retention is not wanted.
   */
  disposeDeviceBuffer(surfaceId: string): void {
    this._deviceBuffers.dispose(surfaceId);
    log.debug("disposeDeviceBuffer", { profile: this.profile, surfaceId });
  }

  /** Read the replay buffer for a surface (undefined if not present). */
  bufferFor(surfaceId: string): SessionReplayBuffer | undefined {
    return this._deviceBuffers.bufferFor(surfaceId);
  }

  /** Read the current epoch for a surface (undefined if not present). */
  epochFor(surfaceId: string): number | undefined {
    return this._deviceBuffers.epochFor(surfaceId);
  }

  /** Read the carried deviceId for a surface (undefined if absent). */
  deviceIdFor(surfaceId: string): string | undefined {
    return this._deviceBuffers.deviceIdFor(surfaceId);
  }

  /** Reap idle surface buffers (>= idleTimeoutMs of no activity). Returns count removed. */
  sweepIdle(nowMs: number, idleTimeoutMs: number): number {
    return this._deviceBuffers.sweepIdle(nowMs, idleTimeoutMs);
  }

  /** Register the live-WS close hook for a surface (session-configure). */
  setForceClose(surfaceId: string, forceClose: (() => void) | null): void {
    this._deviceBuffers.setForceClose(surfaceId, forceClose);
  }

  /**
   * Returns true when at least one device buffer entry is still retained —
   * including entries for currently-attached (not yet detached) devices.
   * A live attached device blocks session eviction just as much as a detached
   * but not-yet-expired one.
   */
  hasRetainedBuffers(): boolean {
    return this._deviceBuffers.hasRetainedBuffers();
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Indicator for the registry's idle-archive decision. PersonSession is
   * idle when no device is attached. The registry decides when to archive
   * based on age + idleness — PersonSession just exposes the facts.
   */
  get isIdle(): boolean {
    return this._attachments.size === 0;
  }

  /**
   * Timestamp (ms) when the session most recently became idle (all
   * attachments removed). 0 when the session currently has live attachments.
   * Used by the registry sweep to determine if the TTL has elapsed.
   */
  get idleSinceMs(): number {
    return this._idleSinceMs;
  }

  get ageMs(): number {
    return Date.now() - this._createdAtMs;
  }
}
