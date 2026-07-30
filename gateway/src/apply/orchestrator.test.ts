import type { Result } from "@sentient/protocol";
import { describe, expect, it, vi } from "vitest";
import type { RenderedProfile } from "../profile-store/profile-renderer.js";
import type { ProfileStore, ProfileStoreError } from "../profile-store/profile-store.js";
import type { ProfileV1 } from "../profile-store/profile-types.js";
import type { TemplateError } from "../profile-store/template-loader.js";
import { type ApplyDeps, runApply } from "./orchestrator.js";

function sampleProfile(userId = "alice"): ProfileV1 {
  return {
    schemaVersion: 1,
    userId,
    model: { provider: "openrouter", id: "google/gemini-2.5-flash" },
    voice: { provider: "local-tts", id: "voice-abc" },
    audio: { ttsEnabled: true, channel: "voice" as const },
    persona: { template: "default", overrides: "" },
    tools: { enabled: {} },
    compression: { threshold: 0.5 },
    advanced: { extraSystemPrompt: "", maxTokens: 1024, reasoningEffort: "minimal" },
  };
}

function rendered(): RenderedProfile {
  return { soulMarkdown: "# alice\n", hermesConfigYaml: "model: {}\n" };
}

function makeProfileStore(profile: ProfileV1 = sampleProfile()): ProfileStore {
  const ok: Result<ProfileV1, ProfileStoreError> = { ok: true, value: profile };
  const okVoid: Result<void, ProfileStoreError> = { ok: true, value: undefined };
  return {
    get: vi.fn(async () => ok),
    save: vi.fn(async () => okVoid),
    remove: vi.fn(async () => okVoid),
  };
}

function makeDeps(overrides: Partial<ApplyDeps> = {}): ApplyDeps {
  return {
    profileStore: overrides.profileStore ?? makeProfileStore(),
    renderProfile: overrides.renderProfile ?? vi.fn(() => rendered()),
    writeRendered: overrides.writeRendered ?? vi.fn(async () => {}),
    loadTemplate:
      overrides.loadTemplate ??
      (vi.fn(async () => ({ ok: true, value: "template-body" })) as () => Promise<Result<string, TemplateError>>),
  };
}

describe("runApply", () => {
  it("returns ready and writes the rendered profile on the happy path", async () => {
    const deps = makeDeps();
    const result = await runApply(deps, "alice");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.state).toBe("ready");
    expect(result.value.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(deps.profileStore.get).toHaveBeenCalledWith("alice");
    expect(deps.writeRendered).toHaveBeenCalledTimes(1);
  });

  it("returns user-not-found when profileStore.get fails", async () => {
    const profileStore = makeProfileStore();
    profileStore.get = vi.fn(async () => ({ ok: false as const, error: "not-found" as const }));
    const deps = makeDeps({ profileStore });

    const result = await runApply(deps, "ghost");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("user-not-found");
    expect(deps.writeRendered).not.toHaveBeenCalled();
  });

  it("returns render-error when loadTemplate fails", async () => {
    const loadTemplate: () => Promise<Result<string, TemplateError>> = async () => ({
      ok: false,
      error: "not-found",
    });
    const deps = makeDeps({ loadTemplate });

    const result = await runApply(deps, "alice");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("render-error");
    expect(deps.writeRendered).not.toHaveBeenCalled();
  });

  it("returns render-error when renderProfile throws", async () => {
    const renderProfile = vi.fn(() => {
      throw new Error("template syntax broken");
    });
    const deps = makeDeps({ renderProfile });

    const result = await runApply(deps, "alice");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("render-error");
    expect(deps.writeRendered).not.toHaveBeenCalled();
  });

  it("returns write-error when writeRendered throws", async () => {
    const writeRendered = vi.fn(async () => {
      throw new Error("EACCES");
    });
    const deps = makeDeps({ writeRendered });

    const result = await runApply(deps, "alice");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("write-error");
  });
});
