// `user.preferences.patch` — persisting the audio-preference toggle.
//
// ONE effect, because one is now enough: write profile.json#audio. Mobile's
// `setTtsEnabled` sends this frame and nothing else — no REST write rides
// alongside it — so without this the toggle is forgotten the moment the socket
// closes.
//
// There used to be a second effect: applying the patch onto this connection's
// `SessionVoicePrefs`, a per-session copy of the profile that `TurnVoice` read
// per turn. That copy is gone (user-audio-policy.ts) — the profile is read at
// the moment the answer is used, so persisting IS applying, and there is no
// second place for a preference to be stale in. It also removes a lost update:
// the copy hydrated itself asynchronously, and a patch landing before that read
// resolved was silently overwritten by it.
//
// Still NOT mid-turn, for the same reason as before: the read happens as a
// turn's audio is about to drain, so a reply already being spoken finishes
// rather than cutting mid-word. Silencing what is already in flight is a cancel
// gesture (interrupt / barge-in), not a preference change.
//
// Read-modify-write on the profile is last-write-wins, which is correct here:
// the writers are one person's own surfaces toggling their own preference, and
// the patch carries only the keys that changed.

import type { AudioPrefsPatch } from "@sentient/audio-prefs";
import { getLog } from "../logging/logger.js";
import type { ProfileStore } from "../profile-store/profile-store.js";

const log = getLog(["sentient", "session-handlers", "preferences-patch"]);

export interface PreferencesPatchDeps {
  profileStore: ProfileStore;
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
  const { profileStore, userId, sessionId } = deps;

  if (patch.ttsEnabled === undefined && patch.channel === undefined) {
    log.debug("preferences-patch.empty", { sessionId, userId, reason: "no field set — nothing to apply" });
    return;
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
