// Per-user model resolution for the native orchestrator.
//
// THE DEFECT THIS EXISTS FOR. `ResolvedLlm` (the secrets store's answer) is
// `{provider, apiKey, baseUrl}` — no model. So `buildOrchestratorProvider` took
// the model from `config.yaml#orchestrator.provider.model` and every user got
// it, while the settings UI happily showed something else: measured 2026-07-31,
// the UI said `deepseek-v4-flash:cloud` and the runtime dialled
// `gpt-oss:20b-cloud`.
//
// WHERE THE SELECTION ACTUALLY LIVES — not the secrets store, even though the
// key does. It is per-user, in `profile.json#model` (`ProfileV1["model"]`,
// written by Settings → Model and by the account wizard). That is what makes
// this a per-SESSION concern rather than a boot-time one: two household members
// can hold different models at the same time, so resolving once at boot would
// have to pick one person's answer for everybody.
//
// WHY PER REQUEST rather than once per session. The read is a small local JSON
// file (~1 ms) against an LLM round trip of hundreds of ms, and resolving it per
// request is what makes a Settings change take effect on the NEXT TURN instead
// of on the next reconnect. Settings' Apply does not reopen the WS, so a
// session-lifetime cache would reproduce the same "I changed it and nothing
// happened" surprise this module exists to remove — one layer down.
//
// The OpenAI CLIENT is memoized by model id, so per-request resolution does not
// mean per-request HTTP client construction.

import type { OrchestratorConfig } from "@sentient/config";
import { getLog } from "../logging/logger.js";
import type { ProfileStore } from "../profile-store/profile-store.js";
import { createOpenAIProvider } from "../provider/openai-provider.js";
import type { ProviderClient, ProviderRequest, ProviderStreamChunk } from "../provider/provider-client.js";

const log = getLog(["sentient", "bootstrap", "user-model-provider"]);

/** Where a resolved model came from — carried into the log so an operator can
 *  tell "they picked this" from "nobody picked, so config.yaml decided". */
export type ModelSource = "profile" | "config";

export interface ResolvedModel {
  readonly model: string;
  readonly source: ModelSource;
}

/** The live provider connection, resolved from the operator's secrets store.
 *  `provider` is here to be COMPARED against the user's selection, never to be
 *  overridden by it — see `selectModel`. */
export interface ProviderConnectionInput {
  readonly provider: string;
  readonly apiKey: string;
  readonly baseUrl: string;
}

export interface UserModelProviderDeps {
  /** `config.yaml#orchestrator.provider` — supplies every non-model knob, plus
   *  the model to fall back to. */
  readonly providerCfg: OrchestratorConfig["provider"];
  readonly connection: ProviderConnectionInput;
  readonly profileStore: ProfileStore;
  /** Test seam. Defaults to the real OpenAI-compatible client. */
  readonly createProvider?: (cfg: OrchestratorConfig["provider"], apiKey: string) => ProviderClient;
}

/** One `ProviderClient` per session, resolving that session's user's model. */
export interface UserModelProvider {
  forUser(userId: string): ProviderClient;
}

export function createUserModelProvider(deps: UserModelProviderDeps): UserModelProvider {
  const { providerCfg, connection, profileStore } = deps;
  const createProvider = deps.createProvider ?? createOpenAIProvider;

  /** model id → client. Bounded by the number of distinct models the household
   *  actually selects, which is a handful. */
  const clients = new Map<string, ProviderClient>();
  /** userId → last model logged for them, so `orchestrator.provider.resolved`
   *  is a state-CHANGE line rather than one per LLM call. */
  const lastLogged = new Map<string, string>();

  function fallback(userId: string, reason: string): ResolvedModel {
    log.warn("orchestrator.provider.model-fallback", { userId, model: providerCfg.model, reason });
    return { model: providerCfg.model, source: "config" };
  }

  async function selectModel(userId: string): Promise<ResolvedModel> {
    const got = await profileStore.get(userId);
    if (!got.ok) {
      return fallback(userId, `profile unreadable (${got.error}) — nobody selected a model for this user`);
    }
    const selected = got.value.model;
    // A model id only means anything to the provider it was picked from. If the
    // operator has since switched the active provider, sending an OpenRouter
    // slug to Ollama's endpoint is a worse and more confusing failure than the
    // documented fallback — so the selection is refused, loudly, not translated.
    if (selected.provider !== connection.provider) {
      return fallback(
        userId,
        `selection was made against provider "${selected.provider}" but the active provider is "${connection.provider}"`,
      );
    }
    return { model: selected.id, source: "profile" };
  }

  function clientFor(model: string): ProviderClient {
    const cached = clients.get(model);
    if (cached) return cached;
    const client = createProvider({ ...providerCfg, model, base_url: connection.baseUrl }, connection.apiKey);
    clients.set(model, client);
    return client;
  }

  function noteResolution(userId: string, resolved: ResolvedModel): void {
    if (lastLogged.get(userId) === resolved.model) return;
    lastLogged.set(userId, resolved.model);
    log.info("orchestrator.provider.resolved", {
      userId,
      provider: connection.provider,
      model: resolved.model,
      source: resolved.source,
      // Presence only — NEVER the key itself.
      hasKey: connection.apiKey !== "",
    });
  }

  return {
    forUser(userId: string): ProviderClient {
      return {
        async *stream(req: ProviderRequest): AsyncGenerator<ProviderStreamChunk> {
          const resolved = await selectModel(userId);
          noteResolution(userId, resolved);
          yield* clientFor(resolved.model).stream(req);
        },
      };
    },
  };
}
