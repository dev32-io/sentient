import { createLogger } from "@sentient/web-sdk";
import { type ApiHttpError, bearerHeaders, handleFetch } from "./_helpers";

const log = createLogger(["sentient", "webui", "providers", "api"]);

// ---------------------------------------------------------------------------
// Types — mirror gateway/src/providers/catalogs/types.ts exactly (camelCase).
// TODO: move to shared/ when the gateway/webui boundary is formally bridged.
// ---------------------------------------------------------------------------

/** Local mirror of gateway ModelEntry. Keep in sync with providers/catalogs/types.ts. */
export interface ModelEntry {
  id: string;
  provider: "openrouter" | "ollama-cloud" | "custom";
  name: string;
  description: string;
  contextLength: number;
  pricingPer1mPrompt: number | "included";
  pricingPer1mCompletion: number | "included";
  supportsTools: boolean;
  supportsVision: boolean;
}

/** Local mirror of gateway VoiceEntry. Keep in sync with providers/catalogs/types.ts. */
export interface VoiceEntry {
  id: string;
  title: string;
  description: string;
  languages: string[];
  tags: string[];
  coverImageUrl: string | null;
  previewAudioUrl: string | null;
  visibility: "public" | "private";
  taskCount: number;
  createdAt: string;
}

export type ProvidersApiError = ApiHttpError;

type Result<T> = { ok: true; value: T } | { ok: false; error: ProvidersApiError };

// ---------------------------------------------------------------------------
// Providers API factory
// ---------------------------------------------------------------------------

export interface ProvidersApiConfig {
  baseUrl?: string;
  /**
   * "user"   (default) — hits /api/v1/providers/*   with a bearer token.
   * "wizard" — hits /api/v1/wizard/providers/* with NO bearer token.
   *            Used in first-admin mode where no user token exists yet.
   */
  mode?: "user" | "wizard";
}

export interface ListVoicesOptions {
  /** Substring search against voice title; routed to Fish via gateway. */
  title?: string;
  /** 1-indexed page number; defaults to 1. */
  page?: number;
}

export interface ProvidersApi {
  listModels(token: string): Promise<Result<{ models: ModelEntry[]; stale: boolean }>>;
  listVoices(
    token: string,
    opts?: ListVoicesOptions,
  ): Promise<Result<{ voices: VoiceEntry[]; hasMore: boolean; stale: boolean }>>;
  getVoice(token: string, id: string): Promise<Result<{ voice: VoiceEntry }>>;
}

export function createProvidersApi(config?: ProvidersApiConfig): ProvidersApi {
  const base = config?.baseUrl ?? "";
  const isWizard = config?.mode === "wizard";
  const prefix = isWizard ? `${base}/api/v1/wizard/providers` : `${base}/api/v1/providers`;

  function makeHeaders(token: string): Record<string, string> {
    // Wizard catalog endpoints are gated by unlock_verified (cookie/session),
    // not by a bearer token — no Authorization header needed.
    if (isWizard) return {};
    return bearerHeaders(token);
  }

  return {
    async listModels(token) {
      log.debug("listModels", { mode: isWizard ? "wizard" : "user" });
      return handleFetch<{ models: ModelEntry[]; stale: boolean }>(
        fetch(`${prefix}/models`, {
          method: "GET",
          headers: makeHeaders(token),
        }),
      );
    },

    async listVoices(token, opts) {
      const params = new URLSearchParams();
      if (opts?.title) params.set("title", opts.title);
      if (opts?.page && opts.page > 1) params.set("page", String(opts.page));
      const qs = params.toString();
      const url = `${prefix}/voices${qs ? `?${qs}` : ""}`;
      log.debug("listVoices", { mode: isWizard ? "wizard" : "user", hasTitle: !!opts?.title, page: opts?.page ?? 1 });
      return handleFetch<{ voices: VoiceEntry[]; hasMore: boolean; stale: boolean }>(
        fetch(url, {
          method: "GET",
          headers: makeHeaders(token),
        }),
      );
    },

    async getVoice(token, id) {
      log.debug("getVoice", { mode: isWizard ? "wizard" : "user", id });
      // getVoice is only needed by VoiceSavedTile for the currently-saved voice.
      // In wizard mode there is no saved voice yet, so fall through to the user prefix
      // (will be unreachable in practice, but keep the contract consistent).
      const voiceBase = isWizard ? `${base}/api/v1/providers` : prefix;
      return handleFetch<{ voice: VoiceEntry }>(
        fetch(`${voiceBase}/voices/${encodeURIComponent(id)}`, {
          method: "GET",
          headers: makeHeaders(token),
        }),
      );
    },
  };
}
