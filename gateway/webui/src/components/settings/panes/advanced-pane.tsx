// gateway/webui/src/components/settings/panes/advanced-pane.tsx
import type { JSX } from "preact";
import { createLogger } from "@sentient/web-sdk";
import type { ProfileV1, ReasoningEffort } from "../../../services/profile-api.js";
import { Card } from "../primitives/card.tsx";
import { PaneHead } from "../primitives/pane-head.tsx";
import { Row } from "../primitives/row.tsx";
import { Select, type SelectOption } from "../primitives/select.tsx";
import { Slider } from "../primitives/slider.tsx";
import { Textarea } from "../primitives/textarea.tsx";

// Surfaced verbatim from Hermes `agent.reasoning_effort` (none/minimal/low/
// medium/high/xhigh). Labels add the same one-word hint the docs use so
// non-technical family members can pick without re-reading the upstream
// configuration page.
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

export function AdvancedPane({
  draft,
  onDraftCompression,
  onDraftAdvanced,
}: AdvancedPaneProps): JSX.Element {
  const handleCompressionChange = (v: number) => {
    log.debug("compression.threshold.change", { threshold: v });
    onDraftCompression({ ...draft.compression, threshold: v });
  };

  const handleMaxTokensChange = (v: number) => {
    log.debug("advanced.maxTokens.change", { maxTokens: v });
    onDraftAdvanced({ ...draft.advanced, maxTokens: v });
  };

  const handleExtraPromptChange = (e: Event) => {
    const v = (e.target as HTMLTextAreaElement).value;
    log.debug("advanced.extraSystemPrompt.change", { length: v.length });
    onDraftAdvanced({ ...draft.advanced, extraSystemPrompt: v });
  };

  const handleReasoningChange = (v: string) => {
    log.debug("advanced.reasoningEffort.change", { reasoningEffort: v });
    onDraftAdvanced({ ...draft.advanced, reasoningEffort: v as ReasoningEffort });
  };

  return (
    <>
      <PaneHead
        title="Advanced"
        sub="Power-user knobs. Defaults are sensible — only touch if you know why."
      />

      <Card title="Context">
        <Row
          label="Reasoning"
          hint="How hard the model thinks before answering. Higher = better on tough questions, slower and pricier per turn. Minimal is the family-assistant default."
        >
          <Select
            value={draft.advanced.reasoningEffort}
            options={REASONING_OPTIONS}
            onChange={handleReasoningChange}
          />
        </Row>
        <Row
          label="Compression threshold"
          hint="Trigger context summarization when usage exceeds this fraction of the model's window."
        >
          <Slider
            value={draft.compression.threshold}
            min={0}
            max={1}
            step={0.05}
            format={(v) => v.toFixed(2)}
            onChange={handleCompressionChange}
          />
        </Row>
        <Row label="Max tokens" hint="Hard cap on assistant output per turn.">
          <Slider
            value={draft.advanced.maxTokens}
            min={128}
            max={8192}
            step={128}
            onChange={handleMaxTokensChange}
          />
        </Row>
      </Card>

      <Card
        title="Prompt injection"
        sub="Appended to every user message before it's sent. Use sparingly — counts against context."
      >
        <Textarea
          value={draft.advanced.extraSystemPrompt}
          rows={4}
          placeholder="Optional extra instructions…"
          onChange={handleExtraPromptChange}
        />
      </Card>
    </>
  );
}
