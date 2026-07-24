// Provider-connection resolution (Plan 2 Task 9) — decides whether the
// composition root can build a live ProviderClient for the native
// orchestrator, and from where.
//
// CRITICAL (see task-9 correction): the API key and base URL come from the
// operator's 1.0 secrets store (`SecretsStore.getActiveLlm()`), NEVER from
// `process.env` or a config-declared env-var name. `orchestrator.provider.
// base_url` in config.yaml is an OPTIONAL override, consulted ONLY when the
// secrets store's own `baseUrl` is empty — the wizard-seeded
// `keys.yaml.tmpl` ships `openrouter.base_url: null` by default (only
// ollama-cloud/custom entries usually carry one), so the config value fills
// exactly that gap; a secrets-store baseUrl, when present, always wins.
//
// Pure decision logic — no I/O, no client construction — split out from
// phase-services.ts so it carries a focused unit test per the testing rule
// ("a small helper with real logic can have a focused test"). Never returns
// or logs anything beyond what's in `ProviderConnection`; callers must log
// `hasKey`/`baseUrlHost`/`provider`, never the `apiKey` field itself.

import type { OrchestratorConfig } from "@sentient/config";
import type { LlmProvider, ResolvedLlm } from "../admin/secrets-store.js";

export interface ProviderConnection {
  provider: LlmProvider;
  apiKey: string;
  baseUrl: string;
}

export function resolveProviderConnection(
  resolved: ResolvedLlm | null,
  providerCfg: OrchestratorConfig["provider"],
): ProviderConnection | null {
  if (!resolved || resolved.apiKey === "") return null;
  const baseUrl = resolved.baseUrl || providerCfg.base_url;
  if (!baseUrl) return null;
  return { provider: resolved.provider, apiKey: resolved.apiKey, baseUrl };
}
