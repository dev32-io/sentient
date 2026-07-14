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
  createVoice(audio: Blob, name: string): Promise<VoiceMutationResult>;
  deleteVoice(voiceId: string): Promise<VoiceMutationResult>;
  setActiveVoice(voiceId: string): Promise<VoiceMutationResult>;
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

  async function createVoice(audio: Blob, name: string): Promise<VoiceMutationResult> {
    // NEVER log audio bytes/content — byteLength + name length only.
    log.debug("createVoice.request", { audioBytes: audio.size, nameLength: name.length });
    const r = await api.createVoice(token, name, audio);
    if (!r.ok) {
      log.warn("createVoice.failed", { code: r.error.code });
      return { ok: false, errorCode: r.error.code };
    }
    await load();
    // Creating a voice ACTIVATES it server-side (Task-15 contract).
    activeId.value = r.value.voiceId;
    onActiveVoiceChanged(r.value.voiceId);
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
    // The server only resets profile.voice.id when the deleted pack was the
    // caller's active pick — mirror that exactly so we don't sync a no-op.
    if (wasActive) {
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

  return { voices, activeId, loading, error, load, createVoice, deleteVoice, setActiveVoice };
}
