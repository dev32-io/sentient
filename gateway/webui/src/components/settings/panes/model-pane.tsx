// gateway/webui/src/components/settings/panes/model-pane.tsx
import type { JSX } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import { createLogger } from "@sentient/web-sdk";
import type { ModelEntry, ProvidersApi } from "../../../services/providers-api.ts";
import type { ProfileV1 } from "../../../services/profile-api.js";
import { ActionButton, AsyncState, Field, SegmentedControl, SettingsCard } from "../../common/index.ts";
import { Icon } from "../../common/icon.tsx";

const log = createLogger(["sentient", "webui", "settings", "model-pane"]);
type Provider = "openrouter" | "ollama-cloud";

export interface ModelPaneProps {
  api: ProvidersApi;
  token: string;
  draft: ProfileV1;
  /**
   * Last-saved model. Drives the "Current selection" tile, which only
   * updates after a successful Apply — not on every draft mutation.
   */
  savedModel: ProfileV1["model"] | null;
  onDraftModel: (model: ProfileV1["model"]) => void;
  /**
   * When set, hides the provider segment picker and filters models to this
   * provider only. Used in the wizard where only one provider is configured.
   * Settings page omits this prop.
   */
  lockedProvider?: Provider;
  /**
   * When true, suppresses the PaneHead title/subtitle. Used when the
   * surrounding container already supplies its own heading (e.g. AccountWizard
   * StepModel renders "Choose a model" itself).
   */
  hideHead?: boolean;
  /**
   * When true, suppresses the "Current selection" Card wrapper. Wizard usage
   * is one-shot pick-and-go; there's no saved-vs-draft distinction so the
   * tile would always render "No model selected" until Apply (which never
   * happens in the wizard). Settings page omits this prop.
   */
  hideSavedTile?: boolean;
}

export function ModelPane({
  api,
  token,
  draft,
  savedModel,
  onDraftModel,
  lockedProvider,
  hideHead,
  hideSavedTile,
}: ModelPaneProps): JSX.Element {
  const [models, setModels] = useState<ModelEntry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  // Ephemeral browse state — independent of the saved/draft provider so the
  // user can browse the other catalog without losing their current pick.
  // When lockedProvider is set, initialise from it and never allow mutation.
  const [provider, setProvider] = useState<Provider>(
    lockedProvider ?? (draft.model?.provider as Provider) ?? "ollama-cloud",
  );
  const [q, setQ] = useState("");

  useEffect(() => {
    setLoadError(null);
    void (async () => {
      const r = await api.listModels(token);
      if (!r.ok) {
        log.warn("listModels.failed", { code: r.error.code });
        setLoadError("Couldn't load models.");
        return;
      }
      setModels(r.value.models);
    })();
  }, [api, token, loadAttempt]);

  const list = useMemo(() => {
    if (!models) return [];
    return models.filter(
      (m) => m.provider === provider && (!q || m.id.toLowerCase().includes(q.toLowerCase())),
    );
  }, [models, provider, q]);

  if (loadError) {
    return (
      <>
        {!hideHead && (
          <header class="snt-page-head"><div><h2 class="snt-page-title">Model</h2><p class="snt-page-subtitle">Choose the model that powers reasoning and tool use.</p></div></header>
        )}
        <AsyncState state="error" title={loadError} action={<ActionButton onClick={() => setLoadAttempt((value) => value + 1)}>Retry</ActionButton>} />
      </>
    );
  }

  if (!models) {
    return (
      <>
        {!hideHead && (
          <header class="snt-page-head"><div><h2 class="snt-page-title">Model</h2><p class="snt-page-subtitle">Choose the model that powers reasoning and tool use.</p></div></header>
        )}
        <AsyncState state="loading" title="Loading models" />
      </>
    );
  }

  const handleSelect = (m: ModelEntry) => {
    if (draft.model?.id === m.id) return;
    onDraftModel({ id: m.id, provider: m.provider });
  };

  const savedModelTile = renderSavedModelTile(savedModel, models);

  const body = (
    <div class="prov-body">
          <div class="prov-row">
            {!lockedProvider && (
              <SegmentedControl
                label="Model provider"
                value={provider}
                onChange={(v) => setProvider(v as Provider)}
                options={[
                  { value: "ollama-cloud", label: "Ollama Cloud" },
                  { value: "openrouter", label: "OpenRouter" },
                ]}
              />
            )}
            <span class="prov-row-s">
              {provider === "ollama-cloud" ? "Local · free" : "Cloud · pay-per-token"}
            </span>
          </div>
          <div class="prov-search">
            <Field label="Search models" type="search" value={q} onInput={(event) => setQ(event.currentTarget.value)} placeholder={`Search ${list.length} models…`} />
          </div>
          <div class="model-grid">
            {list.map((m) => {
              const sel = draft.model?.id === m.id;
              return (
                <ActionButton
                  key={m.id}
                  className={["mod", sel && "is-sel"].filter(Boolean).join(" ")}
                  aria-pressed={sel}
                  onClick={() => handleSelect(m)}
                >
                  <div class="mod-top">
                    <code class="mod-id">{m.id}</code>
                  </div>
                  <div class="mod-meta">
                    <span class="mod-price">
                      ${m.pricingPer1mPrompt} / ${m.pricingPer1mCompletion}
                      <span class="muted">
                        {typeof m.pricingPer1mPrompt === "number" ? " /1M" : ""}
                      </span>
                    </span>
                    <span class="mod-dot">·</span>
                    <span class="mod-ctx">{Math.round(m.contextLength / 1000)}k context</span>
                    <span class="grow" />
                    <span class="mod-caps">
                      {m.supportsTools && <span class="cap">Tools</span>}
                      {m.supportsVision && <span class="cap">Vision</span>}
                    </span>
                  </div>
                  {sel && (
                    <div class="mod-check">
                      <Icon name="check" size={11} />
                    </div>
                  )}
                </ActionButton>
              );
            })}
            {list.length === 0 && <AsyncState state="empty" title="No models match" message="Try another search or provider." />}
          </div>
        </div>
  );

  return (
    <>
      {!hideHead && (
        <header class="snt-page-head"><div><h2 class="snt-page-title">Model</h2><p class="snt-page-subtitle">Choose the model that powers reasoning and tool use.</p></div></header>
      )}

      {hideSavedTile ? (
        body
      ) : (
        <>
          <SettingsCard title="Current selection">
            <div class="m-current">{savedModelTile}</div>
          </SettingsCard>
          <SettingsCard title="Browse models" padded={false}>
            {body}
          </SettingsCard>
        </>
      )}
    </>
  );
}

function renderSavedModelTile(
  saved: ProfileV1["model"] | null,
  models: ModelEntry[],
): JSX.Element {
  if (saved === null) {
    return <div class="mod mod-saved mod-saved-empty">No model selected</div>;
  }
  const match = models.find((m) => m.id === saved.id && m.provider === saved.provider);
  if (!match) {
    return (
      <div class="mod mod-saved mod-saved-unknown">
        <div class="mod-top">
          <code class="mod-id">{saved.id}</code>
        </div>
        <div class="mod-meta">
          <span>{saved.provider}</span>
          <span class="mod-dot">·</span>
          <span>not in catalog</span>
        </div>
      </div>
    );
  }
  return (
    <div class="mod mod-saved">
      <div class="mod-top">
        <code class="mod-id">{match.id}</code>
      </div>
      <div class="mod-meta">
        <span class="mod-price">
          ${match.pricingPer1mPrompt} / ${match.pricingPer1mCompletion}
          <span class="muted">
            {typeof match.pricingPer1mPrompt === "number" ? " /1M" : ""}
          </span>
        </span>
        <span class="mod-dot">·</span>
        <span class="mod-ctx">{Math.round(match.contextLength / 1000)}k context</span>
        <span class="grow" />
        <span class="mod-caps">
          {match.supportsTools && <span class="cap">Tools</span>}
          {match.supportsVision && <span class="cap">Vision</span>}
        </span>
      </div>
    </div>
  );
}
