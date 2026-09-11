import type { JSX } from "preact";
import { createLogger } from "@sentient/web-sdk";
import type { ProfileV1, ReasoningEffort } from "../../../services/profile-api.js";
import { PaneChrome, SelectControl, SettingsCard, SettingsEditor, SettingsGroup, SettingsRow, SliderControl, TextArea, type SelectOption } from "../../common/index.ts";

const REASONING_OPTIONS: SelectOption[] = [
  { value: "none", label: "None", tag: "fastest" },
  { value: "minimal", label: "Minimal", tag: "default" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra high", tag: "slowest" },
];
const log = createLogger(["sentient", "webui", "settings", "advanced-pane"]);

export interface AdvancedPaneProps {
  draft: ProfileV1;
  onDraftCompression: (cmp: ProfileV1["compression"]) => void;
  onDraftAdvanced: (adv: ProfileV1["advanced"]) => void;
}

export function AdvancedPane({ draft, onDraftCompression, onDraftAdvanced }: AdvancedPaneProps): JSX.Element {
  return (
    <PaneChrome title="Advanced" subtitle="Fine-tune reasoning and context limits. The defaults work well for most households.">
      <SettingsCard title="Context" padded={false}>
        <SettingsGroup>
          <SettingsRow label="Reasoning" hint="Higher effort can improve difficult answers, but may take longer and cost more.">
            <SelectControl
              label="Reasoning effort"
              value={draft.advanced.reasoningEffort}
              options={REASONING_OPTIONS}
              onChange={(reasoningEffort) => {
                log.debug("advanced.reasoningEffort.change", { reasoningEffort });
                onDraftAdvanced({ ...draft.advanced, reasoningEffort: reasoningEffort as ReasoningEffort });
              }}
            />
          </SettingsRow>
          <SettingsRow label="Compression threshold" hint="Summarize context when usage reaches this fraction of the model's window.">
            <SliderControl label="Compression threshold" value={draft.compression.threshold} min={0} max={1} step={0.05} format={(value) => value.toFixed(2)} onChange={(threshold) => onDraftCompression({ ...draft.compression, threshold })} />
          </SettingsRow>
          <SettingsRow label="Maximum response length" hint="Hard cap on assistant output per turn.">
            <SliderControl label="Maximum response length" value={draft.advanced.maxTokens} min={128} max={8192} step={128} onChange={(maxTokens) => onDraftAdvanced({ ...draft.advanced, maxTokens })} />
          </SettingsRow>
        </SettingsGroup>
      </SettingsCard>
      <SettingsEditor title="Extra instructions" subtitle="Appended to every user message. Use sparingly because this counts against context.">
        <TextArea
          label="Extra instructions"
          value={draft.advanced.extraSystemPrompt}
          rows={4}
          placeholder="Optional extra instructions…"
          onInput={(event) => {
            const extraSystemPrompt = event.currentTarget.value;
            log.debug("advanced.extraSystemPrompt.change", { length: extraSystemPrompt.length });
            onDraftAdvanced({ ...draft.advanced, extraSystemPrompt });
          }}
        />
      </SettingsEditor>
    </PaneChrome>
  );
}
