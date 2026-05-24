// gateway/webui/src/components/account-wizard/step-model.tsx
//
// Auth strategy: in "admin" mode the caller passes a catalogToken (adminToken)
// and a standard ProvidersApi. In "first-admin" mode we use a wizard-scoped
// ProvidersApi (mode: "wizard") that hits /api/v1/wizard/providers/models —
// gated by unlock_verified instead of a bearer token. The lockedProvider is
// read from /api/v1/wizard/active-llm so the ModelPane only shows models for
// the provider the user just configured. Custom provider has no catalog, so it
// falls back to a free-form model-id input.
import { useEffect, useState } from "preact/hooks";
import type { JSX } from "preact";
import { createLogger } from "@sentient/web-sdk";
import type { ProfileV1, ModelProvider } from "../../services/profile-api.ts";
import type { ProvidersApi } from "../../services/providers-api.ts";
import { ModelPane } from "../settings/panes/model-pane.tsx";
import { Btn } from "../settings/primitives/btn.tsx";

const log = createLogger(["sentient", "webui", "account-wizard", "step-model"]);

export interface StepModelProps {
  draft: ProfileV1;
  onDraftModel: (model: ProfileV1["model"]) => void;
  onNext: () => void;
  onBack: () => void;
  /**
   * When present, the model catalog is fetched using this token (admin mode).
   * When null, the wizard-scoped API is used (first-admin mode).
   * @deprecated Pass null and rely on providersApi mode="wizard" for first-admin.
   */
  catalogToken: string | null;
  providersApi: ProvidersApi;
  onCancel?: () => void;
}

/** Non-catalog providers that get a free-form model-id input. */
const FREE_FORM_PROVIDERS: ReadonlySet<ModelProvider> = new Set(["custom"]);

type ActiveLlmProvider = "ollama-cloud" | "openrouter" | "custom" | null;

export function StepModel({
  draft,
  onDraftModel,
  onNext,
  onBack,
  catalogToken,
  providersApi,
  onCancel,
}: StepModelProps): JSX.Element {
  // In first-admin mode (catalogToken === null) we fetch the active provider
  // that was selected in setup-wizard step 1 so we can lock the ModelPane.
  const [activeLlmProvider, setActiveLlmProvider] = useState<ActiveLlmProvider>(null);
  const [providerLoaded, setProviderLoaded] = useState(catalogToken !== null);

  useEffect(() => {
    if (catalogToken !== null) return; // admin mode — no need to fetch
    void (async () => {
      try {
        const res = await fetch("/api/v1/wizard/active-llm");
        if (res.ok) {
          const body = await res.json() as { provider: ActiveLlmProvider };
          setActiveLlmProvider(body.provider);
          log.debug("active-llm.loaded", { provider: body.provider });
        } else {
          log.warn("active-llm.failed", { status: res.status });
        }
      } catch (err) {
        log.warn("active-llm.fetch-error", { err: String(err) });
      } finally {
        setProviderLoaded(true);
      }
    })();
  }, [catalogToken]);

  const isValid = draft.model.id.trim().length > 0 && draft.model.provider.length > 0;

  log.debug("render", {
    provider: draft.model.provider,
    hasId: !!draft.model.id,
    hasCatalog: catalogToken !== null,
    activeLlmProvider,
    providerLoaded,
  });

  // Free-form fallback: only when active provider is "custom" (no catalog).
  const effectiveProvider = catalogToken !== null
    ? draft.model.provider
    : (activeLlmProvider ?? draft.model.provider);
  const useFreeForm = FREE_FORM_PROVIDERS.has(effectiveProvider as ModelProvider);

  if (!providerLoaded) {
    return (
      <section class="aw-step aw-step-model">
        <header class="aw-step-head">
          <h2 class="aw-step__title">Choose a model</h2>
          <p class="aw-step__sub">Pick the LLM that will power your assistant. You can switch anytime in Settings → Model.</p>
        </header>
        <div class="pane-skeleton" aria-hidden="true" />
        <footer class="aw-footer">
          {onCancel && <Btn kind="ghost" onClick={onCancel}>Cancel</Btn>}
          <span class="aw-footer__spacer" />
          <Btn kind="secondary" onClick={onBack}>Back</Btn>
          <Btn kind="primary" disabled onClick={onNext}>Next</Btn>
        </footer>
      </section>
    );
  }

  return (
    <section class="aw-step aw-step-model">
      <header class="aw-step-head">
        <h2 class="aw-step__title">Choose a model</h2>
        <p class="aw-step__sub">Pick the LLM that will power your assistant. You can switch anytime in Settings → Model.</p>
      </header>

      {useFreeForm ? (
        <FreeFormModel draft={draft} onDraftModel={onDraftModel} />
      ) : (
        <ModelPane
          api={providersApi}
          token={catalogToken ?? ""}
          draft={draft}
          savedModel={null}
          onDraftModel={onDraftModel}
          hideHead
          hideSavedTile
        />
      )}

      <footer class="aw-footer">
        {onCancel && <Btn kind="ghost" onClick={onCancel}>Cancel</Btn>}
        <span class="aw-footer__spacer" />
        <Btn kind="secondary" onClick={onBack}>Back</Btn>
        <Btn kind="primary" disabled={!isValid} onClick={onNext}>Next</Btn>
      </footer>
    </section>
  );
}

interface FreeFormModelProps {
  draft: ProfileV1;
  onDraftModel: (model: ProfileV1["model"]) => void;
}

function FreeFormModel({ draft, onDraftModel }: FreeFormModelProps): JSX.Element {
  const selectedProvider = draft.model.provider;

  return (
    <div class="aw-fields">
      <p class="aw-fields__label">Custom provider — enter the model ID accepted by your base URL endpoint.</p>
      <div class="aw-field-group">
        <label class="aw-label" htmlFor="aw-model-id">
          Model ID
        </label>
        <input
          id="aw-model-id"
          class="aw-input"
          type="text"
          placeholder={placeholderFor(selectedProvider)}
          value={draft.model.id}
          onInput={(e) => onDraftModel({ provider: selectedProvider, id: (e.target as HTMLInputElement).value })}
        />
        <span class="aw-field-hint">{hintFor(selectedProvider)}</span>
      </div>
    </div>
  );
}

function placeholderFor(provider: ModelProvider): string {
  if (provider === "openrouter") return "e.g. openai/gpt-4o-mini";
  if (provider === "ollama-cloud") return "e.g. llama3.2";
  return "e.g. mistral-small-latest";
}

function hintFor(provider: ModelProvider): string {
  if (provider === "openrouter") return "OpenRouter model slug — find at openrouter.ai/models";
  if (provider === "ollama-cloud") return "Ollama model name — find at ollama.com/library";
  return "Model name accepted by your custom base URL endpoint";
}
