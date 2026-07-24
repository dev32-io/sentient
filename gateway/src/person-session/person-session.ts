import { getLog } from "../logging/logger.js";

const log = getLog(["sentient", "person-session"]);

/**
 * One PersonSession per profile (alice/bob/family). Owns per-user session
 * bookkeeping — attachment tracking, idle state, pendingId dedup, voice
 * selection, Hermes chain continuity — so a client-supplied surfaceId can
 * never address another user's state.
 *
 * Devices attach via an opaque PersonSessionAttachment token and become
 * windows into the shared conversation; any attachment can drive input,
 * output fans out to all.
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

  // Lifecycle

  /**
   * Retention input for the registry sweep. No live resources are tracked
   * on PersonSession itself post-purge (the ACP wire pool, cycle lease, and
   * device replay buffer this used to check were part of the deleted
   * Hermes-cycle brain) — a session is retainable only while it has live
   * attachments. Plan 2 rehomes any orchestrator-owned retention signal here.
   */
  hasLiveResources(): boolean {
    return !this.isIdle;
  }

  /** Final teardown when the registry removes this PersonSession. */
  dispose(): void {
    log.info("dispose", { profile: this.profile, userId: this.userId });
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
