import { getLog } from "../logging/logger.js";

const log = getLog(["sentient", "cerebrum", "preferences"]);

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * STT language selector. `auto` keeps SenseVoice in multilingual auto-detect
 * mode; `en` / `zh` force the decoder into that language, which helps on
 * short utterances that confuse auto-detect. Additional model languages
 * (ja / ko / yue) are supported by SenseVoice but intentionally not
 * exposed — the household scope is English + Mandarin.
 */
export type PreferenceLanguage = "auto" | "en" | "zh";

/**
 * Output channel selector. Binary: voice or text.
 * - `voice` — call `speak` to deliver audio (TTS-synthesized) for spoken
 *   replies. Chat content is also rendered as the chat bubble.
 * - `text` — suppress audio entirely; reply in chat content only. Useful
 *   for "quiet hours" / library mode / device too far from mic. Future
 *   work: per-endpoint configuration will gate this.
 */
export type PreferenceChannel = "voice" | "text";

export interface SessionPreferences {
  readonly language: PreferenceLanguage;
  readonly channel: PreferenceChannel;
  readonly ttsEnabled: boolean;
}

export interface PreferencePatch {
  readonly language?: PreferenceLanguage;
  readonly channel?: PreferenceChannel;
  readonly ttsEnabled?: boolean;
}

export type PreferenceChangeListener = (
  next: SessionPreferences,
  prev: SessionPreferences,
  changed: ReadonlyArray<keyof SessionPreferences>,
) => void;

export interface PreferenceManager {
  get(): SessionPreferences;
  /**
   * Merge a partial patch. No-op keys (same value) are detected and the
   * listeners are NOT notified. Returns the resulting state.
   */
  update(patch: PreferencePatch): SessionPreferences;
  onChange(listener: PreferenceChangeListener): () => void;
  /** Snapshot alias; same shape as get(). Kept for parity with other stores. */
  snapshot(): SessionPreferences;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface PreferenceManagerConfig {
  readonly initial: SessionPreferences;
}

export function createPreferenceManager(config: PreferenceManagerConfig): PreferenceManager {
  let state: SessionPreferences = config.initial;
  const listeners = new Set<PreferenceChangeListener>();

  log.info("preferences-init", { language: state.language, channel: state.channel, ttsEnabled: state.ttsEnabled });

  function notify(
    next: SessionPreferences,
    prev: SessionPreferences,
    changed: ReadonlyArray<keyof SessionPreferences>,
  ): void {
    for (const listener of listeners) {
      try {
        listener(next, prev, changed);
      } catch (err: unknown) {
        log.warn("listener-error", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return {
    get(): SessionPreferences {
      return state;
    },

    snapshot(): SessionPreferences {
      return state;
    },

    update(patch: PreferencePatch): SessionPreferences {
      const prev = state;
      const next: SessionPreferences = {
        language: patch.language ?? prev.language,
        channel: patch.channel ?? prev.channel,
        ttsEnabled: patch.ttsEnabled ?? prev.ttsEnabled,
      };

      const changed: Array<keyof SessionPreferences> = [];
      if (next.language !== prev.language) changed.push("language");
      if (next.channel !== prev.channel) changed.push("channel");
      if (next.ttsEnabled !== prev.ttsEnabled) changed.push("ttsEnabled");

      if (changed.length === 0) {
        log.debug("update-noop", { current: prev });
        return prev;
      }

      state = next;
      log.info("preferences-changed", {
        changed,
        prev,
        next,
      });
      notify(next, prev, changed);
      return next;
    },

    onChange(listener: PreferenceChangeListener): () => void {
      listeners.add(listener);
      log.debug("listener-added", { total: listeners.size });
      return () => {
        listeners.delete(listener);
        log.debug("listener-removed", { total: listeners.size });
      };
    },
  };
}
