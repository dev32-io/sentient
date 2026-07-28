// Per-session voice preferences, read once from the authenticated user's
// profile.json (spec §6). Two values:
//   - voice.id     → the local-tts voice pack this session synthesizes with.
//                    Null falls back to config.yaml's `tts.voice_id`.
//   - audio.{ttsEnabled,channel} → whether this session speaks at all.
//
// Hydration is fire-and-forget: `handleSessionConfigure` is synchronous, and
// a profile read is milliseconds against the seconds between session.configure
// and the first spoken reply. Both getters are re-evaluated per turn (voiceId
// per synthesizer session, shouldSpeak per `TurnVoice.begin`), so a read that
// lands late is picked up by the next turn rather than being lost. Defaults
// (no voice override, speaking enabled) match profileV1Schema's own defaults,
// so an unreadable profile degrades to the gateway-wide voice, not silence.

import { getLog } from "../logging/logger.js";
import type { ProfileStore } from "../profile-store/profile-store.js";

const log = getLog(["sentient", "session-handlers", "voice-prefs"]);

export interface SessionVoicePrefs {
  /** profile.json#voice.id, or null to use the gateway-wide default voice. */
  voiceId(): string | null;
  /** False when the user routed this profile to text or disabled TTS. */
  shouldSpeak(): boolean;
}

export function createSessionVoicePrefs(store: ProfileStore, userId: string, sessionId: string): SessionVoicePrefs {
  let voiceId: string | null = null;
  let speak = true;

  void store
    .get(userId)
    .then((result) => {
      if (!result.ok) {
        log.warn("voice-prefs.profile-read-failed", {
          sessionId,
          userId,
          reason: result.error,
          fallback: "gateway default voice, speaking enabled",
        });
        return;
      }
      voiceId = result.value.voice.id;
      speak = result.value.audio.ttsEnabled && result.value.audio.channel === "voice";
      log.info("voice-prefs.loaded", { sessionId, userId, voiceId, speak });
    })
    .catch((err: unknown) => {
      log.warn("voice-prefs.profile-read-threw", {
        sessionId,
        userId,
        reason: err instanceof Error ? err.message : String(err),
      });
    });

  return {
    voiceId: () => voiceId,
    shouldSpeak: () => speak,
  };
}
