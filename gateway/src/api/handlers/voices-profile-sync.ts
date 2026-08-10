import type { Result } from "@sentient/protocol";
import { getLog } from "../../logging/logger.js";
import type { ProfileStore, ProfileStoreError } from "../../profile-store/profile-store.js";
import type { ProfileV1 } from "../../profile-store/profile-types.js";

const log = getLog(["sentient", "gateway", "api", "voices", "profile-sync"]);

// Reset target when the deleted voice was the caller's active pick — mirrors
// cfg.tts.voice_id's "default" sentinel (falls back to the model's built-in
// default voice at synthesis time; see local-tts-protocol's connect-URL doc).
const DEFAULT_VOICE_ID = "default";

export interface ProfileSyncDeps {
  readonly profileStore: ProfileStore;
}

/** Sets `profile.voice = {provider:"local-tts", id: voiceId}` and live-propagates it.
 *  Creating a voice activates it — the plan's stated contract. */
export async function activateVoice(
  deps: ProfileSyncDeps,
  userId: string,
  voiceId: string,
): Promise<Result<void, string>> {
  return writeVoiceId(deps, userId, voiceId);
}

/** Resets `profile.voice.id` to "default" ONLY when the deleted id was the
 *  caller's current active voice. No profile write otherwise — deleting an
 *  inactive pack must not disturb the active pick. */
export async function deactivateIfActive(
  deps: ProfileSyncDeps,
  userId: string,
  deletedVoiceId: string,
): Promise<Result<void, string>> {
  const got = await deps.profileStore.get(userId);
  if (!got.ok) {
    // The service-side deletion already succeeded (idempotent op); a failed
    // profile read here means we can't tell whether a reset is owed, not
    // that the delete itself failed. Log and don't fail the whole request.
    log.warn("profile-read-failed", { userId, reason: got.error });
    return { ok: true, value: undefined };
  }
  if (got.value.voice.id !== deletedVoiceId) return { ok: true, value: undefined };
  return writeVoiceId(deps, userId, DEFAULT_VOICE_ID);
}

async function writeVoiceId(deps: ProfileSyncDeps, userId: string, voiceId: string): Promise<Result<void, string>> {
  const got = await deps.profileStore.get(userId);
  if (!got.ok) return mapProfileStoreError(got.error);

  const updated: ProfileV1 = { ...got.value, voice: { provider: "local-tts", id: voiceId } };
  const saved = await deps.profileStore.save(updated);
  if (!saved.ok) return mapProfileStoreError(saved.error);

  return { ok: true, value: undefined };
}

function mapProfileStoreError(error: ProfileStoreError): Result<void, string> {
  return { ok: false, error };
}
