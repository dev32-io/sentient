import type { JSX } from "preact";
import { useState } from "preact/hooks";
import type { ModelEntry, ProvidersApi } from "../../../services/providers-api.ts";
import type { ModelRef, ProfileV1 } from "../../../services/profile-api.ts";
import { ActionButton, PaneChrome, SettingsCard } from "../../common/index.ts";
import { ModelPane } from "./model-pane.tsx";

type Purpose = keyof NonNullable<ProfileV1["auxiliaryModels"]>;

const RUNNERS: readonly {
  purpose: Purpose;
  title: string;
  subtitle: string;
  visionOnly?: boolean;
}[] = [
  { purpose: "title", title: "Titles", subtitle: "Creates conversation titles." },
  { purpose: "dreamer", title: "Dreamer", subtitle: "Reviews conversations for durable memory." },
  { purpose: "attachmentVision", title: "Attachment understanding", subtitle: "Understands images and rendered document pages.", visionOnly: true },
];

const supportsVision = (model: ModelEntry): boolean => model.supportsVision;

export interface AuxiliaryRunnersPaneProps {
  api: ProvidersApi;
  token: string;
  draft: ProfileV1;
  onDraftAuxiliaryModels: (models: NonNullable<ProfileV1["auxiliaryModels"]>) => void;
}

export function AuxiliaryRunnersPane({ api, token, draft, onDraftAuxiliaryModels }: AuxiliaryRunnersPaneProps): JSX.Element {
  const [choosing, setChoosing] = useState<Purpose | null>(null);

  const setModel = (purpose: Purpose, model: ModelRef) => {
    onDraftAuxiliaryModels({ ...draft.auxiliaryModels, [purpose]: model });
  };

  const reset = (purpose: Purpose) => {
    const next = { ...draft.auxiliaryModels };
    delete next[purpose];
    onDraftAuxiliaryModels(next);
    setChoosing(null);
  };

  return (
    <PaneChrome title="Auxiliary runners" subtitle="Choose models for background tasks without changing your main chat model.">
      {RUNNERS.map((runner) => {
        const selected = draft.auxiliaryModels?.[runner.purpose];
        return (
          <SettingsCard key={runner.purpose} title={runner.title} subtitle={runner.subtitle}>
            <div class="aux-runner-current">
              <span>{selected ? "Override" : defaultLabel(runner.purpose, draft.model)}</span>
              {selected && <code>{selected.provider} / {selected.id}</code>}
            </div>
            <div class="aux-runner-actions">
              <ActionButton
                ariaLabel={`Choose model for ${runner.title}`}
                aria-pressed={choosing === runner.purpose}
                onClick={() => setChoosing(choosing === runner.purpose ? null : runner.purpose)}
              >
                Choose model
              </ActionButton>
              {selected && (
                <ActionButton
                  variant="quiet"
                  ariaLabel={`Use system default for ${runner.title}`}
                  onClick={() => reset(runner.purpose)}
                >
                  Use system default
                </ActionButton>
              )}
            </div>
            {choosing === runner.purpose && (
              <ModelPane
                api={api}
                token={token}
                draft={draft}
                savedModel={null}
                onDraftModel={(model) => setModel(runner.purpose, model)}
                field={{ value: selected, onChange: (model) => setModel(runner.purpose, model) }}
                lockedProvider={draft.model.provider}
                {...(runner.visionOnly ? { modelFilter: supportsVision } : {})}
                hideHead
                hideSavedTile
              />
            )}
          </SettingsCard>
        );
      })}
    </PaneChrome>
  );
}

function defaultLabel(purpose: Purpose, main: ModelRef): string {
  return purpose === "title" ? `Inherits main model: ${main.provider} / ${main.id}` : "System default";
}
