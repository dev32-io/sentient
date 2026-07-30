import type { McpCatalog } from "@sentient/config";
import type { SecretsStore } from "../admin/secrets-store.js";
import { type ProviderBaseUrlAccessor, renderProfile, writeRendered } from "../profile-store/profile-renderer.js";
import type { ProfileStore } from "../profile-store/profile-store.js";
import type { ModelProvider } from "../profile-store/profile-types.js";
import type { TemplateLoader } from "../profile-store/template-loader.js";
import type { ApplyDeps } from "./orchestrator.js";

/** Discrete dependency view consumed by `createApplyDeps`. */
export interface ApplyDepsServices {
  readonly profileStore: ProfileStore;
  readonly templateLoader: TemplateLoader;
  /** Operator-managed MCP server inventory. Loaded once at boot from
   *  `gateway/config.yaml#mcp_catalog`; the renderer joins entries
   *  against `profile.tools.enabled[]` per-user with var substitution. */
  readonly mcpCatalog: McpCatalog;
  /** Secrets store for reading per-user provider configuration (e.g.
   *  base_url for the "custom" LLM provider). Must already be loaded
   *  (load() or setLlmProviderKey() called) before renderProfile runs.
   *  Null in headless/test setups where custom provider is not used. */
  readonly secretsStore: SecretsStore | null;
}

/** Adapts SecretsStore into the narrow ProviderBaseUrlAccessor interface
 *  used by the renderer, so the renderer has no direct SecretsStore dep. */
function makeProviderBaseUrlAccessor(store: SecretsStore | null): ProviderBaseUrlAccessor {
  return {
    getProviderBaseUrlSync(provider: ModelProvider): string | null {
      if (!store) return null;
      const llm = store.getActiveLlmSync();
      if (!llm || llm.provider !== provider) return null;
      return llm.baseUrl || null;
    },
  };
}

/** Compose a fully-wired ApplyDeps from the discrete services view. */
export function createApplyDeps(services: ApplyDepsServices): ApplyDeps {
  const providerBaseUrl = makeProviderBaseUrlAccessor(services.secretsStore);
  const renderWithCatalog: ApplyDeps["renderProfile"] = (profile, template) =>
    renderProfile(profile, template, { mcpCatalog: services.mcpCatalog, providerBaseUrl });
  return {
    profileStore: services.profileStore,
    renderProfile: renderWithCatalog,
    writeRendered,
    loadTemplate: () => services.templateLoader.loadOrBuiltinDefault(),
  };
}
