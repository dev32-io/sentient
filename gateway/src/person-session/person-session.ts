import { getLog } from "../logging/logger.js";

const log = getLog(["sentient", "person-session"]);

/**
 * One PersonSession per profile (alice/bob/family). Owns the rolling
 * conversation and everything derived from it: history, ambient context,
 * preferences, Hermes chain continuity, audio pipeline state.
 *
 * Devices (web tabs, phones, ESP32s) attach to a PersonSession via
 * DeviceAttachment and become windows into that person's conversation.
 * The same conversation is shared by every attachment; any attachment
 * can drive input; output fans out.
 *
 * B1 (this commit) is the skeleton: identity fields + attachment book-
 * keeping + lifecycle logs. State that currently lives per-WS in
 * ws-session-configure is hoisted in B3.
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
   * Resolved Fish-Audio voice id for this person, hydrated from the user's
   * profile.json#voice.id. `null` means "no per-user override resolved yet —
   * fall back to the gateway-wide default voiceId from cfg.tts.voice_id".
   * Mutated by the registry when profile.json is saved or first loaded.
   */
  private _voiceId: string | null = null;
  private readonly _attachments = new Set<PersonSessionAttachment>();
  private readonly _createdAtMs: number;

  constructor(init: PersonSessionInit) {
    this.profile = init.profile;
    this.hermesUrl = init.hermesUrl;
    this.hermesApiKey = init.hermesApiKey;
    this.userId = init.userId;
    this._createdAtMs = Date.now();
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
    log.info("attach", {
      profile: this.profile,
      attachmentId: a.attachmentId,
      attachmentCount: this._attachments.size,
    });
  }

  detach(a: PersonSessionAttachment): void {
    const removed = this._attachments.delete(a);
    log.info("detach", {
      profile: this.profile,
      attachmentId: a.attachmentId,
      removed,
      attachmentCount: this._attachments.size,
    });
  }

  /**
   * Indicator for the registry's idle-archive decision. PersonSession is
   * idle when no device is attached. The registry decides when to archive
   * based on age + idleness — PersonSession just exposes the facts.
   */
  get isIdle(): boolean {
    return this._attachments.size === 0;
  }

  get ageMs(): number {
    return Date.now() - this._createdAtMs;
  }
}
