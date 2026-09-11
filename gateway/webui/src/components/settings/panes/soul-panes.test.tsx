import { fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import type { ProfileApi, ProfileV1 } from "../../../services/profile-api.ts";
import type { ProvidersApi } from "../../../services/providers-api.ts";
import { AdvancedPane } from "./advanced-pane.tsx";
import { AudioPane } from "./audio-pane.tsx";
import { MemoryPane } from "./memory-pane.tsx";
import { ModelPane } from "./model-pane.tsx";
import { PersonalitiesPane } from "./personalities-pane.tsx";
import { SystemPromptPane } from "./system-prompt-pane.tsx";

function profile(): ProfileV1 {
  return {
    schemaVersion: 1,
    userId: "user",
    model: { provider: "openrouter", id: "model-a" },
    voice: { provider: "local-tts", id: "voice" },
    audio: { ttsEnabled: true, channel: "voice" },
    memory: { spark: true, dreaming: false },
    persona: { template: "default", overrides: "" },
    tools: {},
    compression: { threshold: 0.8 },
    advanced: { extraSystemPrompt: "", maxTokens: 1024, reasoningEffort: "minimal" },
  };
}

function api(methods: Partial<ProfileApi>): ProfileApi {
  return methods as ProfileApi;
}

describe("Soul settings panes", () => {
  it("loads memory, marks edits, enforces the cap, and keeps toggles in the shared draft", async () => {
    const setDraft = vi.fn();
    const onDraftMemoryToggles = vi.fn();
    const doc = { content: "saved", lastModified: "now", charLimit: 10_000 };
    const { rerender } = render(
      <MemoryPane api={api({ getMemoryDoc: vi.fn(async () => ({ ok: true as const, value: doc })) })} token="token" drafts={{ memory: null, user: null }} originals={{ memory: null, user: null }} setOriginal={vi.fn()} setDraft={setDraft} memoryToggles={profile().memory} onDraftMemoryToggles={onDraftMemoryToggles} />,
    );
    await waitFor(() => expect(setDraft).toHaveBeenCalledWith("memory", "saved"));
    rerender(<MemoryPane api={api({})} token="token" drafts={{ memory: "changed", user: null }} originals={{ memory: doc, user: null }} setOriginal={vi.fn()} setDraft={setDraft} memoryToggles={profile().memory} onDraftMemoryToggles={onDraftMemoryToggles} />);
    expect(screen.getByLabelText("Edit General memory").getAttribute("data-dirty")).toBe("true");
    expect(screen.getByRole("status", { name: "Unsaved" })).not.toBeNull();
    fireEvent.click(screen.getByRole("switch", { name: "Memory sparking" }));
    expect(onDraftMemoryToggles).toHaveBeenCalledWith(expect.objectContaining({ spark: false }));
  });

  it("shows retryable load errors and empty personalities", async () => {
    const getPersonalities = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: { code: "unavailable", message: "no" } })
      .mockResolvedValueOnce({ ok: true, value: { activeName: null, personalities: [] } });
    render(<PersonalitiesPane api={api({ getPersonalities })} token="token" onMark={vi.fn()} />);
    expect(await screen.findByText("Couldn't load personalities.")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("No personalities yet")).not.toBeNull();
  });

  it("keeps Audio and Advanced changes in their existing draft callbacks", () => {
    const onDraftAudio = vi.fn();
    const onDraftAdvanced = vi.fn();
    render(<><AudioPane draft={profile()} onDraftAudio={onDraftAudio} /><AdvancedPane draft={profile()} onDraftCompression={vi.fn()} onDraftAdvanced={onDraftAdvanced} /></>);
    fireEvent.click(screen.getByRole("switch", { name: "Speak responses" }));
    expect(onDraftAudio).toHaveBeenCalledWith(expect.objectContaining({ ttsEnabled: false }));
    fireEvent.input(screen.getByLabelText("Extra instructions"), { target: { value: "Be concise" } });
    expect(onDraftAdvanced).toHaveBeenCalledWith(expect.objectContaining({ extraSystemPrompt: "Be concise" }));
  });

  it("covers model loading, empty search, and draft selection", async () => {
    const onDraftModel = vi.fn();
    const providers = { listModels: vi.fn(async () => ({ ok: true as const, value: { stale: false, models: [{ id: "model-b", provider: "openrouter" as const, name: "B", description: "", contextLength: 32000, pricingPer1mPrompt: 1, pricingPer1mCompletion: 2, supportsTools: true, supportsVision: false }] } })) } satisfies ProvidersApi;
    const { rerender } = render(<ModelPane api={providers} token="token" draft={profile()} savedModel={null} onDraftModel={onDraftModel} />);
    const model = await screen.findByRole("button", { name: /model-b/i });
    fireEvent.click(model);
    expect(onDraftModel).toHaveBeenCalledWith({ id: "model-b", provider: "openrouter" });
    fireEvent.input(screen.getByLabelText("Search models"), { target: { value: "missing" } });
    expect(screen.getByText("No models match")).not.toBeNull();
    // The account wizard embeds the same picker without settings chrome or saved state.
    rerender(<ModelPane api={providers} token="token" draft={profile()} savedModel={null} onDraftModel={onDraftModel} hideHead hideSavedTile lockedProvider="openrouter" />);
    expect(screen.queryByRole("heading", { name: "Model" })).toBeNull();
    expect(screen.queryByText("Current selection")).toBeNull();
    fireEvent.input(screen.getByLabelText("Search models"), { target: { value: "" } });
    expect(screen.getByRole("button", { name: /model-b/i })).not.toBeNull();
  });

  it("loads, edits, previews, and reports restore failures for the system prompt", async () => {
    const setDraft = vi.fn();
    const soul = { content: "# Saved", lastModified: "now" };
    const getSoulDefault = vi.fn(async () => ({ ok: false as const, error: { status: 503, code: "unavailable", message: "no" } }));
    const { rerender } = render(<SystemPromptPane api={api({ getSoul: vi.fn(async () => ({ ok: true as const, value: soul })), getSoulDefault })} token="token" onRestoreDefault={vi.fn()} draft={null} original={null} setOriginal={vi.fn()} setDraft={setDraft} />);
    await waitFor(() => expect(setDraft).toHaveBeenCalledWith("# Saved"));
    rerender(<SystemPromptPane api={api({ getSoulDefault })} token="token" onRestoreDefault={vi.fn()} draft="# Changed" original={soul} setOriginal={vi.fn()} setDraft={setDraft} />);
    expect(screen.getByLabelText("System prompt").getAttribute("data-dirty")).toBe("true");
    expect(screen.getByRole("status", { name: "Unsaved" })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect(screen.getByLabelText("System prompt preview")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Restore default" }));
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    expect(await screen.findByText("Couldn't load the default prompt. Try again.")).not.toBeNull();
  });
});
