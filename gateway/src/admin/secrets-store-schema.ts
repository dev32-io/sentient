import type { Result } from "@sentient/protocol";
import { z } from "zod";

// --- Internal schema helpers -------------------------------------------------

const LlmProviderEntry = z.object({
  api_key: z.string().nullable(),
  base_url: z.string().nullable(),
});

// Default zod strict mode strips unknown keys on parse — operator-added custom fields are silently dropped on next write. Acceptable here because keys.yaml is gateway-managed.
export const KeysYamlSchema = z.object({
  schema_version: z.string(),
  llm: z.object({
    active: z.enum(["ollama-cloud", "openrouter", "custom"]),
    ollama_cloud: LlmProviderEntry,
    openrouter: LlmProviderEntry,
    custom: LlmProviderEntry,
  }),
  tts: z.object({
    fish_audio: z.object({ api_key: z.string().nullable() }),
  }),
  home_assistant: z.object({
    url: z.string().nullable().default(null),
    /** LAN IP for `homeassistant.local` (or the hostname inside `url`) —
     *  reserved for a future ha-mcp template that needs static /etc/hosts
     *  mapping. Nullable today; wizard collects it for forward-compat. */
    local_ip: z.string().nullable().default(null),
    observe_token: z.string().nullable(),
    mcp_server_token: z.string().nullable(),
  }),
  music_assistant: z.object({
    url: z.string().nullable().default(null),
    /** LAN IP for `mass.local` (or whatever hostname `url` uses) — wired
     *  into the ma-mcp container's /etc/hosts so docker can reach the MA
     *  instance without mDNS. Optional; if null the orchestrator skips
     *  ma-mcp at apply time (ma-mcp is an optional managed service). */
    local_ip: z.string().nullable().default(null),
    token: z.string().nullable(),
  }),
  admin_token: z.string(),
});

export type KeysYaml = z.infer<typeof KeysYamlSchema>;
export type LlmProvider = "ollama-cloud" | "openrouter" | "custom";

// --- Error types -------------------------------------------------------------

export type SecretsStoreError =
  | { kind: "io-error"; reason: string }
  | { kind: "corrupt-file"; reason: string }
  | { kind: "permission-too-broad"; mode: number };

// --- Resolved types ----------------------------------------------------------

export interface ResolvedLlm {
  provider: LlmProvider;
  apiKey: string; // empty string if null
  baseUrl: string; // empty string if null
}

// --- Status ------------------------------------------------------------------

// TODO(Task 12): SecretsStatus will be superseded by GET /api/v1/admin/secrets returning a richer per-provider shape (has_key, has_base_url, base_url for each LLM provider, plus HA/MA flags). status() will be removed from the SecretsStore interface at that point.
export interface SecretsStatus {
  keysPath: string;
  schemaVersion: string;
  hasFile: boolean;
  activeLlmProvider: LlmProvider;
  hasFishAudioKey: boolean;
}

// --- Interface ---------------------------------------------------------------

export interface SecretsStore {
  load(): Promise<KeysYaml>;
  /** Returns the cached snapshot synchronously.
   *  Throws if the store has never been loaded (cache cold). */
  loadSync(): KeysYaml;
  /** Returns dotted-paths (e.g. `"llm.api_key"`) whose new value in
   *  `partial` differs from the currently-stored value. Empty array when
   *  `partial` is null/undefined or all values are identical. */
  diffPaths(partial: Record<string, Record<string, unknown>> | null | undefined): Promise<string[]>;
  getActiveLlm(): Promise<Result<ResolvedLlm, SecretsStoreError>>;
  getFishAudioKey(): Promise<string | null>;
  getActiveLlmSync(): ResolvedLlm | null;
  getFishAudioKeySync(): string | null;
  /** Returns secrets for a specific provider (async — loads from disk if cache cold). */
  getProviderSecrets(provider: LlmProvider): Promise<Result<ResolvedLlm, SecretsStoreError>>;
  /** Returns secrets for a specific provider from cache; null if cache not yet warm. */
  getProviderSecretsSync(provider: LlmProvider): ResolvedLlm | null;
  setLlmProviderKey(
    provider: LlmProvider,
    patch: { api_key?: string | null; base_url?: string | null },
  ): Promise<Result<void, SecretsStoreError>>;
  setActiveLlmProvider(provider: LlmProvider): Promise<Result<void, SecretsStoreError>>;
  setFishAudioKey(key: string | null): Promise<Result<void, SecretsStoreError>>;
  setHomeAssistantToken(
    kind: "observe_token" | "mcp_server_token",
    token: string | null,
  ): Promise<Result<void, SecretsStoreError>>;
  setHomeAssistantUrl(url: string | null): Promise<Result<void, SecretsStoreError>>;
  setHomeAssistantLocalIp(ip: string | null): Promise<Result<void, SecretsStoreError>>;
  setMusicAssistantToken(token: string | null): Promise<Result<void, SecretsStoreError>>;
  setMusicAssistantUrl(url: string | null): Promise<Result<void, SecretsStoreError>>;
  setMusicAssistantLocalIp(ip: string | null): Promise<Result<void, SecretsStoreError>>;
  getAdminToken(): Promise<string>;
  /** Returns summary of configured state for API status endpoint. */
  status(): Promise<Result<SecretsStatus, SecretsStoreError>>;
}

// --- Config ------------------------------------------------------------------

export interface SecretsStoreConfig {
  keysPath: string; // ~/.sentient/secrets/keys.yaml
  templatePath: string; // gateway/templates/wizard/keys.yaml.tmpl
  generateAdminToken(): string; // injectable for testing
}
