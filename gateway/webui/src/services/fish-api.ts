// gateway/webui/src/services/fish-api.ts
import { createLogger } from "@sentient/web-sdk";
import { type ApiHttpError, bearerHeaders, handleFetch, jsonHeaders } from "./_helpers";

const log = createLogger(["sentient", "webui", "fish", "api"]);

// ---------------------------------------------------------------------------
// Types — mirror gateway VoiceEntry (providers/catalogs/types.ts) exactly.
// TODO: move to shared/ when the gateway/webui boundary is formally bridged.
// ---------------------------------------------------------------------------

/** Local mirror of gateway VoiceEntry. Keep in sync with providers/catalogs/types.ts. */
export interface FishVoiceEntry {
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

export type FishApiError = ApiHttpError;

type Result<T> = { ok: true; value: T } | { ok: false; error: FishApiError };

// ---------------------------------------------------------------------------
// Fish API factory
// ---------------------------------------------------------------------------

export interface ListVoicesOptions {
  /** Substring search against voice title; routed to Fish via gateway. */
  title?: string;
  /** 1-indexed page number; defaults to 1. */
  page?: number;
}

export interface CloneFromFishInput {
  fishVoiceId: string;
  name: string;
  description: string;
  tags: string[];
}

export interface CloneFromFishResult {
  voiceId: string;
  name: string;
  /** Present when the pack was cloned service-side but the local
   *  profile-activation write failed. The pack still exists — surface a
   *  non-fatal notice, never treat this as a request failure. */
  warning?: "not-activated";
}

export interface FishApiConfig {
  baseUrl?: string;
}

export interface FishApi {
  listVoices(
    token: string,
    opts?: ListVoicesOptions,
  ): Promise<Result<{ voices: FishVoiceEntry[]; hasMore: boolean; stale: boolean }>>;
  getVoice(token: string, id: string): Promise<Result<{ voice: FishVoiceEntry }>>;
  cloneFromFish(token: string, input: CloneFromFishInput): Promise<Result<CloneFromFishResult>>;
}

export function createFishApi(config?: FishApiConfig): FishApi {
  const base = config?.baseUrl ?? "";
  const prefix = `${base}/api/v1/providers`;

  return {
    listVoices(token, opts) {
      const params = new URLSearchParams();
      if (opts?.title) params.set("title", opts.title);
      if (opts?.page && opts.page > 1) params.set("page", String(opts.page));
      const qs = params.toString();
      const url = `${prefix}/voices${qs ? `?${qs}` : ""}`;
      log.debug("listVoices", { hasTitle: !!opts?.title, page: opts?.page ?? 1 });
      return handleFetch<{ voices: FishVoiceEntry[]; hasMore: boolean; stale: boolean }>(
        fetch(url, {
          method: "GET",
          headers: bearerHeaders(token),
        }),
      );
    },

    getVoice(token, id) {
      log.debug("getVoice", { id });
      return handleFetch<{ voice: FishVoiceEntry }>(
        fetch(`${prefix}/voices/${encodeURIComponent(id)}`, {
          method: "GET",
          headers: bearerHeaders(token),
        }),
      );
    },

    cloneFromFish(token, input) {
      log.debug("cloneFromFish", {
        fishVoiceIdLength: input.fishVoiceId.length,
        nameLength: input.name.length,
        tagCount: input.tags.length,
      });
      return handleFetch<CloneFromFishResult>(
        fetch(`${prefix}/voices/${encodeURIComponent(input.fishVoiceId)}/clone`, {
          method: "POST",
          headers: jsonHeaders(bearerHeaders(token)),
          body: JSON.stringify({ name: input.name, description: input.description, tags: input.tags }),
        }),
      );
    },
  };
}
