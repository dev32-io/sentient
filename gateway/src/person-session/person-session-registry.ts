import { clearInterval, setInterval } from "node:timers";
import type { HermesConfig } from "@sentient/config";
import type { UserPortStore } from "../admin/user-port-store.js";
import { getLog } from "../logging/logger.js";
import { renderWorkerUrl } from "../session-router.js";
import { PersonSession } from "./person-session.js";

const log = getLog(["sentient", "person-session-registry"]);

/**
 * One-per-user registry for PersonSession. First attachment for a user
 * creates its PersonSession via getOrCreate; subsequent attachments
 * reuse it. UserId → Hermes URL is resolved from the user-port-store
 * + worker template, so MCP tool handlers can look up a PersonSession
 * by userId without going through SessionRouter.
 */

export type ApiKeyResolver = () => string;

/**
 * Resolves the per-user TTS voice id from the profile store. The registry
 * calls this on `getOrCreate` (initial hydrate) and `refreshVoice` (after
 * a profile.json save) to keep `PersonSession.voiceId` aligned with the
 * persisted user preference. Returns `null` when the profile is missing
 * or has no voice configured — caller falls back to the gateway-wide
 * default voiceId.
 */
export type VoiceLoader = (userId: string) => Promise<string | null>;

export interface PersonSessionRegistry {
  /** Return the existing PersonSession for the user, or create one. */
  getOrCreate(userId: string): Promise<PersonSession | null>;
  /** Read-only lookup; null if the user has never been attached to. */
  get(userId: string): PersonSession | null;
  /** Snapshot of all live PersonSessions (diagnostics, shutdown). */
  list(): readonly PersonSession[];
  /**
   * Re-resolve the TTS voiceId for the given user from the profile store
   * and update any matching PersonSession in-place. Idempotent. Called by
   * the WS handler on session attach (initial load) and by the profile PUT
   * handler after a successful save (so live sessions pick up the new
   * voice on the next TTS turn without a Hermes restart). No-op when no
   * PersonSession is bound to the userId.
   */
  refreshVoice(userId: string): Promise<void>;
  /**
   * Run a sweep of all sessions: evict expired device buffers, then remove
   * idle sessions with no retained buffers and no live attachments that have
   * exceeded the retention TTL. Exposed for testing (avoids real timers).
   * Returns sweep stats for observability.
   */
  sweep(nowMs: number): SweepResult;
  /**
   * Stop the background sweep interval. Call during gateway shutdown.
   */
  dispose(): void;
}

export interface SweepResult {
  readonly sessionsChecked: number;
  readonly buffersEvicted: number;
  readonly sessionsRemoved: number;
}

export interface PersonSessionRegistryOptions {
  /**
   * Optional voice resolver. When provided, `getOrCreate` fires it in the
   * background after creating a new session so the voiceId is hydrated
   * without blocking the WS handler. When omitted, all sessions stay at
   * `voiceId: null` (callers fall back to the global gateway voice).
   * Tests can omit this safely.
   */
  readonly voiceLoader?: VoiceLoader;
  /**
   * Override the current-time source for testing. Defaults to Date.now().
   */
  readonly nowMs?: () => number;
}

export interface PersonSessionRegistryDeps {
  hermes: HermesConfig;
  userPortStore: UserPortStore;
  apiKeyResolver: ApiKeyResolver;
  /**
   * How long a device buffer may be idle (no activity-clock touch) before
   * the sweep reaps it. Must be provided explicitly — sourced from
   * config.session.idle_timeout_ms.
   */
  idleTimeoutMs: number;
  /**
   * Per-device replay ring buffer cap in bytes.
   * Must be provided explicitly — sourced from config.session.replay_buffer_max_bytes.
   */
  replayBufferMaxBytes: number;
  options?: PersonSessionRegistryOptions;
}

export function createPersonSessionRegistry(deps: PersonSessionRegistryDeps): PersonSessionRegistry {
  const sessions = new Map<string, PersonSession>();
  const { voiceLoader, nowMs: clockNowMs } = deps.options ?? {};
  const idleTimeoutMs = deps.idleTimeoutMs;
  const replayBufferMaxBytes = deps.replayBufferMaxBytes;
  // Sweep every ~idleTimeoutMs/6 (e.g. 5 min for a 30-min idle timeout).
  const sweepIntervalMs = Math.max(60_000, Math.floor(idleTimeoutMs / 6));
  const now = clockNowMs ?? (() => Date.now());

  async function loadAndApplyVoice(session: PersonSession): Promise<void> {
    if (!voiceLoader || !session.userId) return;
    try {
      const id = await voiceLoader(session.userId);
      session.setVoiceId(id);
    } catch (err: unknown) {
      log.warn("voiceLoader.failed", {
        userId: session.userId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  function sweep(nowMs: number): SweepResult {
    let sessionsChecked = 0;
    let buffersEvicted = 0;
    let sessionsRemoved = 0;

    for (const [userId, session] of sessions) {
      sessionsChecked += 1;
      buffersEvicted += session.sweepIdle(nowMs, idleTimeoutMs);
      if (!session.hasRetainedBuffers()) {
        sessions.delete(userId);
        sessionsRemoved += 1;
        log.info("sweep.session-removed", { userId, ageMs: session.ageMs });
      }
    }

    log.debug("sweep.done", { sessionsChecked, buffersEvicted, sessionsRemoved });
    return { sessionsChecked, buffersEvicted, sessionsRemoved };
  }

  // Background sweep interval — clears expired buffers + idle sessions.
  // Import from node:timers so Bun returns a Timeout object (not a number)
  // and .unref() actually runs, preventing the timer from keeping the process alive.
  const sweepTimer = setInterval(() => {
    sweep(now());
  }, sweepIntervalMs);
  sweepTimer.unref();

  return {
    async getOrCreate(userId) {
      const existing = sessions.get(userId);
      if (existing) {
        log.debug("getOrCreate.hit", { userId, attachmentCount: existing.attachmentCount });
        return existing;
      }
      const port = await deps.userPortStore.resolvePort(userId);
      if (port === null) {
        log.warn("getOrCreate.no-port-binding", { userId });
        return null;
      }
      const url = renderWorkerUrl(deps.hermes.worker.url_template, port);
      const next = new PersonSession({
        profile: userId,
        hermesUrl: url,
        hermesApiKey: deps.apiKeyResolver(),
        userId,
        replayBufferMaxBytes,
      });
      sessions.set(userId, next);
      log.info("getOrCreate.miss-created", {
        userId,
        hermesUrl: url,
        sessionCount: sessions.size,
      });
      void loadAndApplyVoice(next);
      return next;
    },

    get(userId) {
      return sessions.get(userId) ?? null;
    },

    list() {
      return [...sessions.values()];
    },

    async refreshVoice(userId) {
      const session = sessions.get(userId);
      if (!session) {
        log.debug("refreshVoice.no-session", { userId });
        return;
      }
      await loadAndApplyVoice(session);
    },

    sweep,

    dispose() {
      clearInterval(sweepTimer);
      log.info("registry.disposed");
    },
  };
}
