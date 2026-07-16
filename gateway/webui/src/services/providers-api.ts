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

export interface ProvidersApi {
  listModels(token: string): Promise<Result<{ models: ModelEntry[]; stale: boolean }>>;
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
  };
}
