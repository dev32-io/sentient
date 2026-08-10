// UserAudioPolicy (spec §6) — whether this user's replies are spoken, and in
// which voice, READ AT THE MOMENT THE ANSWER IS USED.
//
// NO SNAPSHOT. This replaces a per-session cache that hydrated itself from the
// profile with a fire-and-forget read and defaulted to AUDIO_PREFS_DEFAULT
// (speaking on, gateway-wide voice) until that read landed. The comment
// defending it assumed "seconds between session.configure and the first spoken
// reply" — but mobile's session.configure CARRIES the first message, so the
// turn starts in the same tick, and the defaults won:
//
//   23:07:53.429  turn-voice.begin                  shouldSpeak() -> true  (default)
//   23:07:53.431  ws-open-requested ...&voice=default  voiceId() -> null   (default)
//   23:07:53.432  voice-prefs.loaded  ttsEnabled=false voiceId="c624a6ca…"
//   23:07:59.613  turn-voice.audio.start
//
// The first turn of every fresh session spoke while muted, in the wrong voice.
// A patch landing before the read resolved was clobbered by it for the same
// reason — a lost update in the other direction.
//
// The fix is not a better await. The profile IS the authority and the gateway
// owns it, so nothing downstream should hold a copy: each getter reads the
// store when its answer is about to be acted on. A session carrying stale
// preferences is then not a thing that can exist. It also deletes the live
// `applyAudio` path wholesale — `user.preferences.patch` persists, and the very
// next read sees it, with no second copy to keep in step.
//
// Cost is one small file read per decision — roughly two per turn, against a
// turn measured in seconds. Correctness is worth more than that here.
//
// An unreadable profile degrades to speaking with the gateway-wide voice, not
// to silence: preferences failing closed would mute a household that never
// asked for it.

import { AUDIO_PREFS_DEFAULT, type AudioPrefs } from "@sentient/audio-prefs";
import { getLog } from "../logging/logger.js";
import type { ProfileStore } from "../profile-store/profile-store.js";

const log = getLog(["sentient", "session-handlers", "audio-policy"]);

export interface UserAudioPolicy {
  /**
   * Whether this session should speak the turn that is about to be drained.
   * Read by `TurnVoice` immediately before audio starts leaving — the latest
   * possible moment, so a mute that lands during the previous turn's playback
   * silences this one.
   */
  shouldSpeak(): Promise<boolean>;
  /**
   * The local-tts voice pack to synthesize with, or null for the gateway-wide
   * default (`config.yaml`'s `tts.voice_id`). Read when the synthesizer opens
   * its upstream session, which is where the voice is actually chosen.
   */
  voiceId(): Promise<string | null>;
}

export function createUserAudioPolicy(store: ProfileStore, userId: string, sessionId: string): UserAudioPolicy {
  async function readAudio(): Promise<AudioPrefs> {
    const result = await store.get(userId);
    if (result.ok) return result.value.audio;
    log.warn("audio-policy.profile-read-failed", {
      sessionId,
      userId,
      reason: result.error,
      fallback: "speaking enabled — a preference that cannot be read must not mute the household",
    });
    return AUDIO_PREFS_DEFAULT;
  }

  return {
    async shouldSpeak() {
      const audio = await readAudio();
      const speak = audio.ttsEnabled && audio.channel === "voice";
      log.debug("audio-policy.should-speak", {
        sessionId,
        userId,
        ttsEnabled: audio.ttsEnabled,
        channel: audio.channel,
        speak,
      });
      return speak;
    },

    async voiceId() {
      const result = await store.get(userId);
      if (!result.ok) {
        log.warn("audio-policy.profile-read-failed", {
          sessionId,
          userId,
          reason: result.error,
          fallback: "gateway-wide default voice",
        });
        return null;
      }
      const voiceId = result.value.voice.id;
      log.debug("audio-policy.voice-id", { sessionId, userId, voiceId });
      return voiceId;
    },
  };
}
