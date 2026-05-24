import { createLogger } from "@sentient/web-sdk";
import { type ApiHttpError, bearerHeaders, handleFetch, jsonHeaders } from "./_helpers";
import type { ProfileV1 } from "./profile-api.ts";

const log = createLogger(["sentient", "webui", "admin", "api"]);

// --- Types (match gateway admin handler response shapes) ---

export type LlmProvider = "ollama-cloud" | "openrouter" | "custom";

export interface UserSummary {
  userId: string;
  displayName: string;
  isAdmin: boolean;
  avatarTint: string;
  slotKey: string;
  createdAt: string;
}

export interface LlmProviderStatus {
  has_key: boolean;
  has_base_url: boolean;
}

export interface SecretsStatus {
  llm: {
    active: LlmProvider;
    ollama_cloud: LlmProviderStatus;
    openrouter: LlmProviderStatus;
    custom: LlmProviderStatus;
  };
  tts: {
    fish_audio: { has_key: boolean };
  };
  home_assistant: {
    observe_token: { has_token: boolean };
    mcp_server_token: { has_token: boolean };
  };
  music_assistant: { has_token: boolean };
}

export type AdminApiError = ApiHttpError;

type Result<T> = { ok: true; value: T } | { ok: false; error: AdminApiError };

/**
 * Profile body sent to POST /admin/users and POST /auth/setup.
 * Omits userId and schemaVersion — both are server-stamped.
 */
export type ProfileBody = Omit<ProfileV1, "userId" | "schemaVersion">;

export interface CreateUserInput {
  displayName: string;
  pin: string;
  isAdmin: boolean;
  profile: ProfileBody;
}

/** Response from POST /auth/setup (first-admin bootstrap). */
export interface BootstrapAdminResult {
  token: string;
  user: { userId: string; displayName: string; isAdmin: boolean; avatarTint: string };
}

// --- API interface ---

export interface AdminApi {
  listUsers(token: string): Promise<Result<{ users: UserSummary[] }>>;
  /** POST /api/v1/admin/users — requires admin token. Blocks until worker ready (~30s). */
  createUser(token: string, input: CreateUserInput): Promise<Result<{ user: UserSummary }>>;
  deleteUser(token: string, userId: string): Promise<Result<void>>;
  resetPin(token: string, userId: string, pin: string): Promise<Result<void>>;
  setIsAdmin(token: string, userId: string, isAdmin: boolean): Promise<Result<{ user: UserSummary }>>;
  getSecretsStatus(token: string): Promise<Result<SecretsStatus>>;
  /** PUT /api/v1/admin/secrets/llm/{provider} — replaces the stored LLM provider key. */
  setLlmProviderKey(
    token: string,
    provider: LlmProvider,
    body: { api_key?: string | null; base_url?: string | null },
  ): Promise<Result<void>>;
  /** PUT /api/v1/admin/secrets/llm/active — sets the active LLM provider. */
  setActiveLlmProvider(token: string, provider: LlmProvider): Promise<Result<void>>;
  /** PUT /api/v1/admin/secrets/tts/fish_audio — replaces the Fish Audio key. */
  setFishAudioKey(token: string, value: string): Promise<Result<void>>;
  /**
   * POST /api/v1/auth/setup — first-admin bootstrap, no auth required.
   * Returns token + user on success so the wizard can immediately log in.
   */
  bootstrapAdmin(input: CreateUserInput): Promise<Result<BootstrapAdminResult>>;
}

// --- Factory ---

export interface AdminApiConfig {
  baseUrl?: string;
}

export function createAdminApi(config?: AdminApiConfig): AdminApi {
  const base = config?.baseUrl ?? "";

  return {
    listUsers(token) {
      log.debug("listUsers");
      return handleFetch<{ users: UserSummary[] }>(
        fetch(`${base}/api/v1/admin/users`, { headers: bearerHeaders(token) }),
      );
    },

    createUser(token, input) {
      log.debug("createUser", { displayName: input.displayName });
      return handleFetch<{ user: UserSummary }>(
        fetch(`${base}/api/v1/admin/users`, {
          method: "POST",
          headers: jsonHeaders(bearerHeaders(token)),
          body: JSON.stringify(input),
        }),
      );
    },

    deleteUser(token, userId) {
      log.debug("deleteUser", { userId });
      return handleFetch<void>(
        fetch(`${base}/api/v1/admin/users/${encodeURIComponent(userId)}`, {
          method: "DELETE",
          headers: bearerHeaders(token),
        }),
      );
    },

    resetPin(token, userId, pin) {
      log.debug("resetPin", { userId });
      return handleFetch<void>(
        fetch(`${base}/api/v1/admin/users/${encodeURIComponent(userId)}/reset-pin`, {
          method: "POST",
          headers: jsonHeaders(bearerHeaders(token)),
          body: JSON.stringify({ pin }),
        }),
      );
    },

    setIsAdmin(token, userId, isAdmin) {
      log.debug("setIsAdmin", { userId, isAdmin });
      return handleFetch<{ user: UserSummary }>(
        fetch(`${base}/api/v1/admin/users/${encodeURIComponent(userId)}`, {
          method: "PATCH",
          headers: jsonHeaders(bearerHeaders(token)),
          body: JSON.stringify({ isAdmin }),
        }),
      );
    },

    getSecretsStatus(token) {
      log.debug("getSecretsStatus");
      return handleFetch<SecretsStatus>(fetch(`${base}/api/v1/admin/secrets`, { headers: bearerHeaders(token) }));
    },

    setLlmProviderKey(token, provider, body) {
      log.debug("setLlmProviderKey", { provider, hasKey: body.api_key != null });
      // Only include fields that were explicitly provided — omitting a field means
      // "leave that field unchanged". The backend LlmKeyPatchSchema enforces that
      // at least one field is present.
      const patch: Record<string, string> = {};
      if (body.api_key !== undefined && body.api_key !== null) patch.value = body.api_key;
      else if (body.api_key === null) patch.value = "";
      if (body.base_url !== undefined && body.base_url !== null) patch.base_url = body.base_url;
      else if (body.base_url === null) patch.base_url = "";
      return handleFetch<void>(
        fetch(`${base}/api/v1/admin/secrets/llm/${encodeURIComponent(provider)}`, {
          method: "PUT",
          headers: jsonHeaders(bearerHeaders(token)),
          body: JSON.stringify(patch),
        }),
      );
    },

    setActiveLlmProvider(token, provider) {
      log.debug("setActiveLlmProvider", { provider });
      return handleFetch<void>(
        fetch(`${base}/api/v1/admin/secrets/llm/active`, {
          method: "PUT",
          headers: jsonHeaders(bearerHeaders(token)),
          body: JSON.stringify({ provider }),
        }),
      );
    },

    setFishAudioKey(token, value) {
      log.debug("setFishAudioKey", { hasKey: value !== "" });
      return handleFetch<void>(
        fetch(`${base}/api/v1/admin/secrets/tts/fish_audio`, {
          method: "PUT",
          headers: jsonHeaders(bearerHeaders(token)),
          body: JSON.stringify({ value }),
        }),
      );
    },

    bootstrapAdmin(input) {
      log.debug("bootstrapAdmin", { displayName: input.displayName });
      return handleFetch<BootstrapAdminResult>(
        fetch(`${base}/api/v1/auth/setup`, {
          method: "POST",
          headers: jsonHeaders({}),
          body: JSON.stringify(input),
        }),
      );
    },
  };
}
