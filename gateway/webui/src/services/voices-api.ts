// gateway/webui/src/services/voices-api.ts
import { createLogger } from "@sentient/web-sdk";
import { type ApiHttpError, bearerHeaders, handleBlobFetch, handleFetch } from "./_helpers";

const log = createLogger(["sentient", "webui", "voices", "api"]);

// ---------------------------------------------------------------------------
// Types — mirror the Task-15 gateway voices handler response shapes exactly
// (gateway/src/api/handlers/voices.ts + providers/tts/local-tts-protocol.ts
// LocalTtsVoiceInfo). TODO: move to shared/ when the gateway/webui boundary
// is formally bridged.
// ---------------------------------------------------------------------------

export interface VoiceSummary {
  voiceId: string;
  name: string;
  description: string;
  tags: string[];
  language: string;
  source: "builtin" | "user";
  /** Unix epoch SECONDS (float) — the TTS service's `time.time()`. Not ms. */
  createdAt: number;
  refDurationMs: number;
}

export interface CreateVoiceResult {
  voiceId: string;
  name: string;
  /** Present when the pack was created service-side but the local
   *  profile-activation write failed. The pack still exists — surface a
   *  non-fatal notice, never treat this as a request failure. */
  warning?: "not-activated";
}

export interface DeleteVoiceResult {
  voiceId: string;
  /** Present when the delete succeeded service-side but the local
   *  profile-reset write failed (only relevant when the deleted pack was
   *  the caller's active voice). */
  warning?: "profile-not-updated";
}

export type VoicesApiError = ApiHttpError;

type Result<T> = { ok: true; value: T } | { ok: false; error: VoicesApiError };

// ---------------------------------------------------------------------------
// Voices API factory
// ---------------------------------------------------------------------------

export interface VoicesApiConfig {
  baseUrl?: string;
}

export interface VoicesApi {
  listVoices(token: string): Promise<Result<{ voices: VoiceSummary[] }>>;
  /** POSTs multipart/form-data (`name` + `description` + repeated `tags` +
   *  `language` + `audio`). Creating a voice ACTIVATES it server-side — see
   *  CreateVoiceResult.warning. */
  createVoice(
    token: string,
    name: string,
    audio: Blob,
    description: string,
    tags: string[],
    language: string,
  ): Promise<Result<CreateVoiceResult>>;
  deleteVoice(token: string, voiceId: string): Promise<Result<DeleteVoiceResult>>;
  /** POSTs to `/api/v1/voices/:id/preview?lang=<lang>` — returns synthesized
   *  preview audio as a raw WAV blob (200 audio/wav), or a typed error on
   *  502/504/etc. */
  previewVoice(token: string, voiceId: string, lang: string): Promise<Result<Blob>>;
}

export function createVoicesApi(config?: VoicesApiConfig): VoicesApi {
  const base = config?.baseUrl ?? "";

  return {
    listVoices(token) {
      log.debug("listVoices");
      return handleFetch<{ voices: VoiceSummary[] }>(fetch(`${base}/api/v1/voices`, { headers: bearerHeaders(token) }));
    },

    createVoice(token, name, audio, description, tags, language) {
      // NEVER log audio bytes/content — byteLength + name length only.
      log.debug("createVoice", { nameLength: name.length, audioBytes: audio.size, tagCount: tags.length });
      const form = new FormData();
      form.set("name", name);
      form.set("description", description);
      for (const t of tags) form.append("tags", t);
      form.set("language", language);
      form.set("audio", audio, "reference.wav");
      return handleFetch<CreateVoiceResult>(
        fetch(`${base}/api/v1/voices`, {
          method: "POST",
          // No Content-Type header — the browser sets the multipart boundary.
          headers: bearerHeaders(token),
          body: form,
        }),
      );
    },

    deleteVoice(token, voiceId) {
      log.debug("deleteVoice", { voiceId });
      return handleFetch<DeleteVoiceResult>(
        fetch(`${base}/api/v1/voices/${encodeURIComponent(voiceId)}`, {
          method: "DELETE",
          headers: bearerHeaders(token),
        }),
      );
    },

    previewVoice(token, voiceId, lang) {
      log.debug("previewVoice", { voiceId });
      return handleBlobFetch(
        fetch(`${base}/api/v1/voices/${encodeURIComponent(voiceId)}/preview?lang=${encodeURIComponent(lang)}`, {
          method: "POST",
          headers: bearerHeaders(token),
        }),
      );
    },
  };
}
