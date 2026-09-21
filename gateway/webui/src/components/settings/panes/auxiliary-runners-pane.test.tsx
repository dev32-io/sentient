import { fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { useState } from "preact/hooks";
import { describe, expect, it, vi } from "vitest";
import type { ProfileV1 } from "../../../services/profile-api.ts";
import type { ProvidersApi } from "../../../services/providers-api.ts";
import { AuxiliaryRunnersPane } from "./auxiliary-runners-pane.tsx";

const models = [
  { id: "text-model", provider: "ollama-cloud" as const, name: "Text", description: "", contextLength: 32000, pricingPer1mPrompt: "included" as const, pricingPer1mCompletion: "included" as const, supportsTools: true, supportsVision: false },
  { id: "vision-model", provider: "ollama-cloud" as const, name: "Vision", description: "", contextLength: 32000, pricingPer1mPrompt: "included" as const, pricingPer1mCompletion: "included" as const, supportsTools: true, supportsVision: true },
  { id: "other-provider", provider: "openrouter" as const, name: "Other", description: "", contextLength: 32000, pricingPer1mPrompt: 1, pricingPer1mCompletion: 2, supportsTools: true, supportsVision: true },
];

function profile(): ProfileV1 {
  return {
    schemaVersion: 1,
    userId: "user",
    model: { provider: "ollama-cloud", id: "main-model" },
    auxiliaryModels: { dreamer: { provider: "ollama-cloud", id: "old-dreamer" } },
    voice: { provider: "local-tts", id: "voice" },
    audio: { ttsEnabled: true, channel: "voice" },
    memory: { spark: true, dreaming: true },
    persona: { template: "default", overrides: "" },
    tools: {},
    compression: { threshold: 0.8 },
    advanced: { extraSystemPrompt: "", maxTokens: 1024, reasoningEffort: "minimal" },
  };
}

function Harness({ api, onChange }: { api: ProvidersApi; onChange: (profile: ProfileV1) => void }) {
  const [draft, setDraft] = useState(profile);
  return <AuxiliaryRunnersPane api={api} token="token" draft={draft} onDraftAuxiliaryModels={(auxiliaryModels) => {
    const next = { ...draft, auxiliaryModels };
    setDraft(next);
    onChange(next);
  }} />;
}

describe("Auxiliary runners settings", () => {
  it("shows honest defaults, filters attachment choices to vision on active provider, and resets overrides", async () => {
    const onChange = vi.fn();
    const api = { listModels: vi.fn(async () => ({ ok: true as const, value: { models, stale: false } })) } satisfies ProvidersApi;
    render(<Harness api={api} onChange={onChange} />);

    expect(screen.getByText("Inherits main model: ollama-cloud / main-model")).not.toBeNull();
    expect(screen.getAllByText("System default")).toHaveLength(1);
    expect(screen.queryByText(/gemma4/i)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Use system default for Dreamer" }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ auxiliaryModels: {} }));

    fireEvent.click(screen.getByRole("button", { name: "Choose model for Attachment understanding" }));
    expect(await screen.findByRole("button", { name: /vision-model/i })).not.toBeNull();
    expect(screen.queryByRole("button", { name: /text-model/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /other-provider/i })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /vision-model/i }));
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
      auxiliaryModels: { attachmentVision: { provider: "ollama-cloud", id: "vision-model" } },
    })));
  });
});
