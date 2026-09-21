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

import { createHash } from "node:crypto";
import type { OrchestratorConfig } from "@sentient/config";
import type { Result } from "@sentient/protocol";
import type { CatalogProvider, ProviderModelResolution } from "../api/providers-deps.js";
import type { ResolvedVisionProvider } from "../attachments/vision.js";
import { getLog } from "../logging/logger.js";
import type { ProfileStore } from "../profile-store/profile-store.js";
import type { ModelProvider } from "../profile-store/profile-types.js";
import { createOpenAIProvider } from "../provider/openai-provider.js";
import type { ProviderClient, ProviderRequest, ProviderStreamChunk } from "../provider/provider-client.js";
import type { AuxiliaryModelError, AuxiliaryModelPurpose, AuxiliaryModelResolver } from "./auxiliary-model-resolver.js";

const log = getLog(["sentient", "bootstrap", "user-model-provider"]);

/** Where a resolved model came from — carried into the log so an operator can
 *  tell "they picked this" from "nobody picked, so config.yaml decided". */
export type ModelSource = "profile" | "config" | "user-override" | "user-chat" | "operator-default";

export interface ResolvedModel {
  readonly model: string;
  readonly source: ModelSource;
}

/** The live provider connection, resolved from the operator's secrets store.
 *  `provider` is here to be COMPARED against the user's selection, never to be
 *  overridden by it — see `selectModel`. */
export interface ProviderConnectionInput {
  readonly provider: ModelProvider;
  readonly apiKey: string;
  readonly baseUrl: string;
}

export type MainCapability = boolean | "unknown";

export interface MainModelSnapshot {
  readonly client: ProviderClient;
  readonly provider: ModelProvider;
  readonly catalogModelId: string;
  readonly outboundModel: string;
  readonly supportsVision: MainCapability;
  readonly supportsTools: MainCapability;
  readonly contextLength: number | null;
}

export interface UserModelProviderDeps {
  /** `config.yaml#orchestrator.provider` — supplies every non-model knob, plus
   *  the model to fall back to. */
  readonly providerCfg: OrchestratorConfig["provider"];
  readonly connection: ProviderConnectionInput;
  /** Live main-request connection. Secrets mutations update store cache before returning. */
  readonly resolveConnection?: () => Promise<ProviderConnectionInput>;
  readonly profileStore: ProfileStore;
  readonly auxiliaryResolver?: AuxiliaryModelResolver;
  readonly resolveProviderModel?: (
    provider: CatalogProvider,
    id: string,
    connection: ProviderConnectionInput,
  ) => Promise<ProviderModelResolution | null>;
  /** Test seam. Defaults to the real OpenAI-compatible client. */
  readonly createProvider?: (cfg: OrchestratorConfig["provider"], apiKey: string) => ProviderClient;
}

/** One `ProviderClient` per session, resolving that session's user's model. */
export interface UserModelProvider {
  forUser(userId: string, purpose?: AuxiliaryModelPurpose): ProviderClient;
  /** Immutable main request snapshot: client, IDs and capabilities come from one catalog lookup. */
  resolveMain(userId: string): Promise<MainModelSnapshot>;
  /** Resolves and catalog-verifies attachment vision on every inspection. Never falls back across providers. */
  resolveAttachmentVision(userId: string): Promise<Result<ResolvedVisionProvider, AuxiliaryModelError>>;
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

  async function selectModel(
    userId: string,
    purpose?: AuxiliaryModelPurpose,
    activeConnection: ProviderConnectionInput = connection,
  ): Promise<ResolvedModel> {
    if (purpose) {
      if (!deps.auxiliaryResolver) throw new Error(`Auxiliary model resolver unavailable for ${purpose}`);
      const resolved = await deps.auxiliaryResolver.resolve(userId, purpose);
      if (!resolved.ok) throw new Error(`Auxiliary model resolution failed for ${purpose}: ${resolved.error}`);
      return { model: resolved.value.ref.id, source: resolved.value.source };
    }

    const got = await profileStore.get(userId);
    if (!got.ok) {
      return fallback(userId, `profile unreadable (${got.error}) — nobody selected a model for this user`);
    }
    const selected = got.value.model;
    // A model id only means anything to the provider it was picked from. If the
    // operator has since switched the active provider, sending an OpenRouter
    // slug to Ollama's endpoint is a worse and more confusing failure than the
    // documented fallback — so the selection is refused, loudly, not translated.
    if (selected.provider !== activeConnection.provider) {
      return fallback(
        userId,
        `selection was made against provider "${selected.provider}" but the active provider is "${activeConnection.provider}"`,
      );
    }
    return { model: selected.id, source: "profile" };
  }

  function outgoingModel(activeConnection: ProviderConnectionInput, model: string): string {
    const directOllamaCloud =
      activeConnection.provider === "ollama-cloud" && safeHostname(activeConnection.baseUrl) === "ollama.com";
    return directOllamaCloud ? model.replace(/(?::cloud|-cloud)$/u, "") : model;
  }

  function clientFor(activeConnection: ProviderConnectionInput, model: string): ProviderClient {
    const outgoing = outgoingModel(activeConnection, model);
    const identity = createHash("sha256")
      .update(`${activeConnection.provider}\0${activeConnection.baseUrl}\0${activeConnection.apiKey}\0${outgoing}`)
      .digest("hex");
    const cached = clients.get(identity);
    if (cached) return cached;
    const client = createProvider(
      { ...providerCfg, model: outgoing, base_url: activeConnection.baseUrl },
      activeConnection.apiKey,
    );
    clients.set(identity, client);
    return client;
  }

  function noteResolution(
    userId: string,
    resolved: ResolvedModel,
    activeConnection: ProviderConnectionInput = connection,
  ): void {
    const identity = `${activeConnection.provider}:${resolved.model}`;
    if (lastLogged.get(userId) === identity) return;
    lastLogged.set(userId, identity);
    log.info("orchestrator.provider.resolved", {
      userId,
      provider: activeConnection.provider,
      model: resolved.model,
      source: resolved.source,
      // Presence only — NEVER the key itself.
      hasKey: activeConnection.apiKey !== "",
    });
  }

  return {
    forUser(userId: string, purpose?: AuxiliaryModelPurpose): ProviderClient {
      return {
        async *stream(req: ProviderRequest): AsyncGenerator<ProviderStreamChunk> {
          const resolved = await selectModel(userId, purpose);
          noteResolution(userId, resolved);
          const model = outgoingModel(connection, purpose ? resolved.model : (req.model ?? resolved.model));
          yield* clientFor(connection, resolved.model).stream({ ...req, model });
        },
      };
    },
    async resolveMain(userId) {
      const activeConnection = await (deps.resolveConnection?.() ?? connection);
      const resolved = await selectModel(userId, undefined, activeConnection);
      noteResolution(userId, resolved, activeConnection);
      const catalog =
        activeConnection.provider === "openrouter" || activeConnection.provider === "ollama-cloud"
          ? await deps.resolveProviderModel?.(activeConnection.provider, resolved.model, activeConnection)
          : null;
      return Object.freeze({
        client: clientFor(activeConnection, resolved.model),
        provider: activeConnection.provider,
        catalogModelId: resolved.model,
        outboundModel: outgoingModel(activeConnection, resolved.model),
        supportsVision: catalog?.visionCapabilityKnown ? catalog.model.supportsVision : "unknown",
        supportsTools: catalog?.toolsCapabilityKnown ? catalog.model.supportsTools : "unknown",
        contextLength:
          catalog?.visionCapabilityKnown || catalog?.toolsCapabilityKnown ? catalog.model.contextLength : null,
      });
    },
    async resolveAttachmentVision(userId) {
      if (!deps.auxiliaryResolver || !deps.resolveProviderModel) {
        return { ok: false, error: "catalog-unavailable" };
      }
      const activeConnection = await (deps.resolveConnection?.() ?? connection);
      const resolved = await deps.auxiliaryResolver.resolve(userId, "attachmentVision", {
        activeProvider: activeConnection.provider,
        resolveVisionModel: async (provider, id) => {
          if (provider !== "openrouter" && provider !== "ollama-cloud") return null;
          const catalog = await deps.resolveProviderModel?.(provider, id, activeConnection);
          return catalog
            ? {
                supportsVision: catalog.model.supportsVision,
                visionCapabilityKnown: catalog.visionCapabilityKnown,
              }
            : null;
        },
      });
      if (!resolved.ok) return resolved;
      noteResolution(userId, { model: resolved.value.ref.id, source: resolved.value.source }, activeConnection);
      return {
        ok: true,
        value: {
          client: clientFor(activeConnection, resolved.value.ref.id),
          configuredProvider: activeConnection.provider,
          model: {
            provider: resolved.value.ref.provider,
            id: outgoingModel(activeConnection, resolved.value.ref.id),
          },
          supportsVision: true,
        },
      };
    },
  };
}

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}
