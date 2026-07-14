// gateway/webui/src/hooks/use-voices.ts
import { type Signal, signal } from "@preact/signals";
import { createLogger } from "@sentient/web-sdk";
import { type ProfileApi, createProfileApi } from "../services/profile-api.ts";
import { type VoiceSummary, type VoicesApi, createVoicesApi } from "../services/voices-api.ts";

const log = createLogger(["sentient", "webui", "voices"]);

/** Sentinel voice id — falls back to the model's built-in default voice.
 *  Mirrors the gateway's DEFAULT_VOICE_ID (api/handlers/voices.ts). */
const DEFAULT_VOICE_ID = "default";

export interface VoiceMutationResult {
  ok: boolean;
  /** Non-fatal warning surfaced when the primary op succeeded service-side
   *  but a secondary local profile write failed (Task-15 voices handler). */
  warning?: string;
  /** Error code from the failed request, for caller-side message mapping. */
  errorCode?: string;
}

export interface UseVoices {
  readonly voices: Signal<VoiceSummary[] | null>;
  readonly activeId: Signal<string>;
  readonly loading: Signal<boolean>;
  readonly error: Signal<string | null>;
  load(): Promise<void>;
  createVoice(audio: Blob, name: string, description: string, tags: string[]): Promise<VoiceMutationResult>;
  deleteVoice(voiceId: string): Promise<VoiceMutationResult>;
  setActiveVoice(voiceId: string): Promise<VoiceMutationResult>;
  /** Sync-only: mirrors an externally-resolved active id (e.g. the caller's
   *  profile fetch settling after this hook's own seed) into local state.
   *  Never fetches, never PUTs, never calls `onActiveVoiceChanged` — the
   *  value is already the server's truth flowing IN, not a user action. */
  syncActiveId(voiceId: string): void;
}

export interface UseVoicesDeps {
  token: string;
  /** Seed value — the caller's last-known profile.voice.id. */
  initialActiveId: string;
  /**
   * Sync-only callback. Voice ops are immediate (not draft/apply), but the
   * caller (settings-view) still holds the full profileDraft/profileOriginal
   * that other tabs PUT on Apply — without this sync, a later model/tools
   * Apply would PUT the stale voice.id and revert the user's pick. MUST NOT
   * itself PUT anything; it only updates the caller's local draft mirrors.
   */
  onActiveVoiceChanged: (voiceId: string) => void;
  voicesApi?: VoicesApi;
  profileApi?: ProfileApi;
}

export function createUseVoices(deps: UseVoicesDeps): UseVoices {
  const api = deps.voicesApi ?? createVoicesApi();
  const profileApi = deps.profileApi ?? createProfileApi();
  const { token, onActiveVoiceChanged } = deps;

  const voices = signal<VoiceSummary[] | null>(null);
  const activeId = signal(deps.initialActiveId);
  const loading = signal(false);
  const error = signal<string | null>(null);

  async function load(): Promise<void> {
    loading.value = true;
    error.value = null;
    const r = await api.listVoices(token);
    loading.value = false;
    if (!r.ok) {
      log.warn("load.failed", { code: r.error.code });
      error.value = "Couldn't load voices.";
      return;
    }
    voices.value = r.value.voices;
    log.debug("load.success", { count: r.value.voices.length });
  }

  async function createVoice(
    audio: Blob,
    name: string,
    description: string,
    tags: string[],
  ): Promise<VoiceMutationResult> {
    // NEVER log audio bytes/content — byteLength + name length only.
    log.debug("createVoice.request", { audioBytes: audio.size, nameLength: name.length, tagCount: tags.length });
    const r = await api.createVoice(token, name, audio, description, tags);
    if (!r.ok) {
      log.warn("createVoice.failed", { code: r.error.code });
      return { ok: false, errorCode: r.error.code };
    }
    await load();
    // Creating a voice ACTIVATES it server-side (Task-15 contract) — but only
    // when the profile write actually persisted. A `not-activated` warning means
    // the pack exists yet profile.voice.id was NOT updated (server still
    // synthesizes in the prior voice), so mirroring it as active locally would
    // contradict the server AND the "activation failed" toast. Leave activeId.
    if (!r.value.warning) {
      activeId.value = r.value.voiceId;
      onActiveVoiceChanged(r.value.voiceId);
    }
    log.info("createVoice.success", { voiceId: r.value.voiceId, warning: r.value.warning ?? null });
    return { ok: true, ...(r.value.warning ? { warning: r.value.warning } : {}) };
  }

  async function deleteVoice(voiceId: string): Promise<VoiceMutationResult> {
    log.debug("deleteVoice.request", { voiceId });
    const wasActive = activeId.value === voiceId;
    const r = await api.deleteVoice(token, voiceId);
    if (!r.ok) {
      log.warn("deleteVoice.failed", { code: r.error.code, voiceId });
      return { ok: false, errorCode: r.error.code };
    }
    await load();
    // The server resets profile.voice.id to the default ONLY when the deleted
    // pack was the caller's active pick AND the reset write persisted. A
    // `profile-not-updated` warning means the reset did NOT persist (the profile
    // still points at the now-deleted id), so don't optimistically show
    // "default" as active — mirror only a confirmed reset.
    if (wasActive && !r.value.warning) {
      activeId.value = DEFAULT_VOICE_ID;
      onActiveVoiceChanged(DEFAULT_VOICE_ID);
    }
    log.info("deleteVoice.success", { voiceId, warning: r.value.warning ?? null });
    return { ok: true, ...(r.value.warning ? { warning: r.value.warning } : {}) };
  }

  async function setActiveVoice(voiceId: string): Promise<VoiceMutationResult> {
    // No dedicated set-active endpoint (Task 15 deliberately left this to the
    // profile PUT) — read-modify-write via the existing profile-api.
    log.debug("setActiveVoice.request", { voiceId });
    const cur = await profileApi.getMe(token);
    if (!cur.ok) {
      log.warn("setActiveVoice.read-failed", { code: cur.error.code });
      return { ok: false, errorCode: cur.error.code };
    }
    const next = { ...cur.value, voice: { provider: "local-tts" as const, id: voiceId } };
    const r = await profileApi.updateMe(token, next);
    if (!r.ok) {
      log.warn("setActiveVoice.write-failed", { code: r.error.code });
      return { ok: false, errorCode: r.error.code };
    }
    activeId.value = voiceId;
    onActiveVoiceChanged(voiceId);
    log.info("setActiveVoice.success", { voiceId });
    return { ok: true };
  }

  function syncActiveId(voiceId: string): void {
    if (activeId.value === voiceId) return;
    log.debug("syncActiveId", { voiceId });
    activeId.value = voiceId;
  }

  return { voices, activeId, loading, error, load, createVoice, deleteVoice, setActiveVoice, syncActiveId };
}
