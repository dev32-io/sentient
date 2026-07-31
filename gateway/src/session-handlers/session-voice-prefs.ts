// Per-session voice preferences (spec §6). Two values:
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
//
// The audio half is also LIVE, not read-once: `applyAudio` folds in a
// `user.preferences.patch` (handle-preferences-patch.ts) mid-session. Without
// it, tapping mute persisted the preference but left the assistant speaking
// for the rest of the session, because nothing re-read the profile until the
// next `session.configure`.

import { AUDIO_PREFS_DEFAULT, type AudioPrefs, type AudioPrefsPatch } from "@sentient/audio-prefs";
import { getLog } from "../logging/logger.js";
import type { ProfileStore } from "../profile-store/profile-store.js";

const log = getLog(["sentient", "session-handlers", "voice-prefs"]);

export interface SessionVoicePrefs {
  /** profile.json#voice.id, or null to use the gateway-wide default voice. */
  voiceId(): string | null;
  /** False when the user routed this profile to text or disabled TTS. */
  shouldSpeak(): boolean;
  /** Fold a live audio patch over the hydrated values. Takes effect on the
   *  NEXT turn — `TurnVoice.begin` re-reads `shouldSpeak` per turn, so a reply
   *  already streaming finishes speaking rather than being cut mid-word. */
  applyAudio(patch: AudioPrefsPatch): void;
}

export function createSessionVoicePrefs(store: ProfileStore, userId: string, sessionId: string): SessionVoicePrefs {
  let voiceId: string | null = null;
  let audio: AudioPrefs = AUDIO_PREFS_DEFAULT;

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
      audio = result.value.audio;
      log.info("voice-prefs.loaded", {
        sessionId,
        userId,
        voiceId,
        ttsEnabled: audio.ttsEnabled,
        channel: audio.channel,
      });
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
    shouldSpeak: () => audio.ttsEnabled && audio.channel === "voice",
    applyAudio: (patch) => {
      audio = {
        ttsEnabled: patch.ttsEnabled ?? audio.ttsEnabled,
        channel: patch.channel ?? audio.channel,
      };
      log.info("voice-prefs.audio-patched", {
        sessionId,
        userId,
        ttsEnabled: audio.ttsEnabled,
        channel: audio.channel,
      });
    },
  };
}
