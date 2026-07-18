import { type AcpWireRegistry, createAcpWireRegistry } from "../hermes-adapter-client/acp-wire-registry.js";
import { getLog } from "../logging/logger.js";
import type { SessionReplayBuffer } from "../session-handlers/session-replay-buffer.js";
import { type SurfaceCycleRegistry, createSurfaceCycleRegistry } from "../session-handlers/surface-cycle-registry.js";
import { type ConversationAnchors, createConversationAnchors } from "./conversation-anchors.js";
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
 * conversation and derived state — history, ambient context, preferences,
 * Hermes chain continuity, audio pipeline state — plus this user's per-surface
 * ACP wire pool, cycle registry, and conversation anchors, so a client-supplied
 * surfaceId can never address another user's state.
 *
 * Devices attach via DeviceAttachment and become windows into the shared
 * conversation; any attachment can drive input, output fans out to all.
 */

/** Opaque attachment token; tracks identity so detach-before-attach cases log cleanly. */
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
   * Last Hermes response id for chain continuity; survives attach/detach so
   * a reconnecting tab resumes the same chain.
   */
  private _lastResponseId: string | null = null;
  /**
   * Resolved local-tts voice id, hydrated from profile.json#voice.id. `null`
   * falls back to the gateway-wide cfg.tts.voice_id. Mutated by the registry
   * on profile save/first load.
   */
  private _voiceId: string | null = null;
  private readonly _attachments = new Set<PersonSessionAttachment>();
  private readonly _createdAtMs: number;
  private readonly _deviceBuffers: DeviceBufferStore;
  readonly wires: AcpWireRegistry;
  readonly cycles: SurfaceCycleRegistry;
  private readonly _anchors: ConversationAnchors = createConversationAnchors();

  /**
   * Timestamp when the session first became idle (attachmentCount went to 0).
   * Starts at createdAtMs (a fresh session with no attachments is idle).
   */
  private _idleSinceMs: number;

  /**
   * Recently-seen client pendingIds for idempotent resend dedup — a resend is
   * re-echoed via replay/REST history but NOT re-dispatched. Bounded,
   * insertion-ordered, survives reconnect (like _lastResponseId).
   */
  private readonly _recentPendingIds = new Set<string>();
  private static readonly PENDING_ID_CAP = 256;

  constructor(init: PersonSessionInit) {
    this.profile = init.profile;
    this.hermesUrl = init.hermesUrl;
    this.hermesApiKey = init.hermesApiKey;
    this.userId = init.userId;
    this._deviceBuffers = new DeviceBufferStore(init.replayBufferMaxBytes);
    const ownerUserId = init.userId ?? init.profile;
    this.wires = createAcpWireRegistry(ownerUserId);
    this.cycles = createSurfaceCycleRegistry();
    this._createdAtMs = Date.now();
    this._idleSinceMs = this._createdAtMs;
    log.info("created", { profile: this.profile, hermesUrl: this.hermesUrl, userId: this.userId });
  }

  get lastResponseId(): string | null {
    return this._lastResponseId;
  }

  setLastResponseId(id: string | null): void {
    const prev = this._lastResponseId;
    this._lastResponseId = id;
    log.debug("lastResponseId.update", { profile: this.profile, prev, next: id });
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
    log.info("voiceId.update", { profile: this.profile, userId: this.userId, prev, next: id });
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

  /** Immediately remove the surface entry, no TTL (explicit session.end / logout). */
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
   * True when at least one device buffer entry is retained, including
   * currently-attached devices — blocks session eviction either way.
   */
  hasRetainedBuffers(): boolean {
    return this._deviceBuffers.hasRetainedBuffers();
  }

  // Conversation anchors (surfaceId -> conversationId) — delegates to
  // ConversationAnchors; logging stays here for profile context.

  conversationIdFor(surfaceId: string): string | null {
    return this._anchors.get(surfaceId);
  }

  updateConversationId(surfaceId: string, conversationId: string): void {
    const prev = this._anchors.get(surfaceId);
    this._anchors.set(surfaceId, conversationId);
    log.debug("updateConversationId", { profile: this.profile, surfaceId, prev, next: conversationId });
  }

  dropAnchor(surfaceId: string): void {
    if (!this._anchors.drop(surfaceId)) return;
    log.debug("dropAnchor", { profile: this.profile, surfaceId });
  }

  clearAllAnchors(): void {
    const count = this._anchors.size();
    if (count === 0) return;
    this._anchors.clear();
    log.info("clearAllAnchors", { profile: this.profile, count });
  }

  // Lifecycle

  /**
   * Retention input for the registry sweep — a live wire or held cycle lease
   * blocks eviction just as a retained buffer does.
   */
  hasLiveResources(): boolean {
    return this.hasRetainedBuffers() || this.wires.hasLiveWires() || this.cycles.hasActiveLease();
  }

  /**
   * Final teardown when the registry removes this PersonSession: force-dispose
   * any residual wire, abort any residual cycle lease, drop anchors.
   */
  dispose(): void {
    log.info("dispose", { profile: this.profile, userId: this.userId });
    this.wires.disposeAll();
    this.cycles.abortAll();
    this._anchors.clear();
  }

  /**
   * Registry's idle-archive indicator: true when no device is attached. The
   * registry decides eviction from age + idleness; this just exposes the fact.
   */
  get isIdle(): boolean {
    return this._attachments.size === 0;
  }

  /**
   * Timestamp (ms) when the session most recently became idle; 0 while it has
   * live attachments. Used by the registry sweep against the TTL.
   */
  get idleSinceMs(): number {
    return this._idleSinceMs;
  }

  get ageMs(): number {
    return Date.now() - this._createdAtMs;
  }
}
