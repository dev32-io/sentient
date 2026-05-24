import { audioPrefsPatchSchema } from "@sentient/audio-prefs";
import type { PreferenceManager } from "../cerebrum/preferences.js";
import { getLog } from "../logging/logger.js";

const log = getLog(["sentient", "session-handlers", "preferences-patch"]);

export interface HandlePreferencesPatchDeps {
  raw: unknown;
  preferenceManager: PreferenceManager;
  persistAudioPatch: (userId: string, patch: { ttsEnabled?: boolean; channel?: "voice" | "text" }) => Promise<void>;
  sessionId: string;
  userId: string;
}

export async function handlePreferencesPatch(deps: HandlePreferencesPatchDeps): Promise<void> {
  const r = deps.raw as { type?: string; payload?: unknown };
  if (r?.type !== "user.preferences.patch") return;
  const parsed = audioPrefsPatchSchema.safeParse(r.payload);
  if (!parsed.success) {
    log.warn("invalid-payload", {
      sessionId: deps.sessionId,
      userId: deps.userId,
      reason: parsed.error.message,
    });
    return;
  }
  const patch = parsed.data;
  if (patch.ttsEnabled === undefined && patch.channel === undefined) {
    log.debug("empty-patch", { sessionId: deps.sessionId });
    return;
  }
  // Build a clean patch with only present keys — exactOptionalPropertyTypes
  // rejects `?: T | undefined` against `?: T`-shaped consumers.
  const clean: { ttsEnabled?: boolean; channel?: "voice" | "text" } = {};
  if (patch.ttsEnabled !== undefined) clean.ttsEnabled = patch.ttsEnabled;
  if (patch.channel !== undefined) clean.channel = patch.channel;
  await deps.persistAudioPatch(deps.userId, clean);
  deps.preferenceManager.update(clean);
  log.info("applied", {
    sessionId: deps.sessionId,
    userId: deps.userId,
    patch: clean,
  });
}
