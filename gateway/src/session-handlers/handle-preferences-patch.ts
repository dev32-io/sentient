// `user.preferences.patch` — the live half of the audio-preference toggle.
//
// Two effects, and BOTH are required:
//   1. PERSIST onto profile.json#audio, because mobile's `setTtsEnabled` sends
//      this frame and nothing else — no REST write rides alongside it, so
//      without this the toggle is forgotten the moment the socket closes.
//   2. APPLY LIVE onto this connection's `SessionVoicePrefs`, because
//      `TurnVoice.begin` re-reads `shouldSpeak` per turn but the profile is
//      read once at session.configure. Without this the assistant keeps
//      speaking for the rest of the session after the user taps mute.
//
// Deliberately NOT mid-turn: the patch lands on the next turn's `TurnVoice`,
// so a reply already being spoken finishes rather than cutting mid-word.
// Silencing what is already in flight is a cancel gesture (interrupt /
// barge-in), not a preference change.
//
// Read-modify-write on the profile is last-write-wins, which is correct here:
// the writers are one person's own surfaces toggling their own preference, and
// the patch carries only the keys that changed.

import type { AudioPrefsPatch } from "@sentient/audio-prefs";
import { getLog } from "../logging/logger.js";
import type { ProfileStore } from "../profile-store/profile-store.js";
import type { SessionVoicePrefs } from "./session-voice-prefs.js";

const log = getLog(["sentient", "session-handlers", "preferences-patch"]);

export interface PreferencesPatchDeps {
  profileStore: ProfileStore;
  /** This connection's live prefs, or null when the session never minted a
   *  runtime (orchestrator absent / construction failed). The patch is still
   *  persisted in that case — only the live application is skipped. */
  voicePrefs: SessionVoicePrefs | null;
  userId: string;
  sessionId: string;
}

/**
 * Applies one audio-preference patch. Never throws and never answers the
 * client: the frame is fire-and-forget on all three SDKs (none registers a
 * handler for a reply), so a failure is a logged WARN, not an error frame
 * nobody reads.
 */
export async function handlePreferencesPatch(deps: PreferencesPatchDeps, patch: AudioPrefsPatch): Promise<void> {
  const { profileStore, voicePrefs, userId, sessionId } = deps;

  if (patch.ttsEnabled === undefined && patch.channel === undefined) {
    log.debug("preferences-patch.empty", { sessionId, userId, reason: "no field set — nothing to apply" });
    return;
  }

  voicePrefs?.applyAudio(patch);
  if (voicePrefs === null) {
    log.warn("preferences-patch.no-live-session", {
      sessionId,
      userId,
      reason: "no voice prefs on this connection — persisted only, applies on the next session.configure",
    });
  }

  const current = await profileStore.get(userId);
  if (!current.ok) {
    log.warn("preferences-patch.profile-read-failed", { sessionId, userId, reason: current.error });
    return;
  }

  const audio = {
    ttsEnabled: patch.ttsEnabled ?? current.value.audio.ttsEnabled,
    channel: patch.channel ?? current.value.audio.channel,
  };
  const saved = await profileStore.save({ ...current.value, audio });
  if (!saved.ok) {
    log.warn("preferences-patch.profile-save-failed", { sessionId, userId, reason: saved.error });
    return;
  }

  log.info("preferences-patch.applied", {
    sessionId,
    userId,
    ttsEnabled: audio.ttsEnabled,
    channel: audio.channel,
  });
}
