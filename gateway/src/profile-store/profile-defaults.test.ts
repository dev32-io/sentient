import { describe, expect, it, test } from "bun:test";
import { applyProfileDefaults } from "./profile-defaults.js";
import { profileV1Schema } from "./profile-types.js";

test("applyProfileDefaults seeds tools.permissions and tools.toolsets when caller omits them", () => {
  const partial = {
    schemaVersion: 1 as const,
    userId: "u_test",
    model: { provider: "openrouter" as const, id: "google/gemini-2.5-flash" },
    voice: { provider: "local-tts" as const, id: "abc" },
    audio: { ttsEnabled: true, channel: "voice" as const },
    persona: { template: "default", overrides: "" },
    tools: { permissions: {}, toolsets: [] },
    compression: { threshold: 0.5 },
    advanced: { extraSystemPrompt: "", maxTokens: 1024, reasoningEffort: "minimal" as const },
  };

  const out = applyProfileDefaults(partial);

  expect(out.tools.permissions).toEqual({
    home_assistant: {},
    gateway: {},
    music_assistant: {},
    searxng: {},
    fetch: {},
  });
  expect(out.tools.toolsets).toEqual(["memory", "todo", "session_search", "skills"]);
});

test("applyProfileDefaults preserves caller-provided tools.permissions overrides", () => {
  const partial = {
    schemaVersion: 1 as const,
    userId: "u_test",
    model: { provider: "openrouter" as const, id: "x" },
    voice: { provider: "local-tts" as const, id: "y" },
    audio: { ttsEnabled: true, channel: "voice" as const },
    persona: { template: "default", overrides: "" },
    tools: { permissions: { searxng: { web_search: "allow" as const } }, toolsets: ["memory"] },
    compression: { threshold: 0.5 },
    advanced: { extraSystemPrompt: "", maxTokens: 1024, reasoningEffort: "minimal" as const },
  };
  const out = applyProfileDefaults(partial);
  expect(out.tools.permissions).toEqual({ searxng: { web_search: "allow" } });
  expect(out.tools.toolsets).toEqual(["memory"]);
});

describe("audio defaults", () => {
  it("injects {ttsEnabled:true, channel:'voice'} when audio is absent", () => {
    const legacy = {
      schemaVersion: 1,
      userId: "alice",
      model: { provider: "openrouter", id: "anthropic/claude-sonnet-4" },
      voice: { provider: "local-tts", id: "default" },
      persona: { template: "default", overrides: "" },
      tools: { enabled: {} },
      compression: { threshold: 0.8 },
      advanced: { extraSystemPrompt: "", maxTokens: 4096 },
    };
    const parsed = profileV1Schema.parse(legacy);
    const withDefaults = applyProfileDefaults(parsed);
    expect(withDefaults.audio).toEqual({ ttsEnabled: true, channel: "voice" });
  });

  it("preserves existing audio values", () => {
    const profile = {
      schemaVersion: 1,
      userId: "alice",
      model: { provider: "openrouter", id: "anthropic/claude-sonnet-4" },
      voice: { provider: "local-tts", id: "default" },
      persona: { template: "default", overrides: "" },
      tools: { enabled: {} },
      compression: { threshold: 0.8 },
      advanced: { extraSystemPrompt: "", maxTokens: 4096 },
      audio: { ttsEnabled: false, channel: "text" as const },
    };
    const parsed = profileV1Schema.parse(profile);
    const withDefaults = applyProfileDefaults(parsed);
    expect(withDefaults.audio).toEqual({ ttsEnabled: false, channel: "text" });
  });
});

describe("voice provider migration (fish-audio → local-tts)", () => {
  const base = {
    schemaVersion: 1,
    userId: "alice",
    model: { provider: "openrouter", id: "anthropic/claude-sonnet-4" },
    persona: { template: "default", overrides: "" },
    tools: { enabled: {} },
    compression: { threshold: 0.8 },
    advanced: { extraSystemPrompt: "", maxTokens: 4096 },
  };

  it("migrates a legacy fish-audio voice to the local-tts default (upgrade path)", () => {
    // Pre-cutover profiles on disk carry provider:"fish-audio" + a Fish
    // reference_id. Without the preprocess migration these fail schema
    // validation on upgrade (corrupt-file) and lock the user out.
    const legacy = { ...base, voice: { provider: "fish-audio", id: "3ad4d432023c47ee9e6c7805b973630a" } };
    const parsed = profileV1Schema.parse(legacy);
    expect(parsed.voice).toEqual({ provider: "local-tts", id: "default" });
  });

  it("leaves a valid local-tts voice untouched", () => {
    const current = { ...base, voice: { provider: "local-tts", id: "a".repeat(32) } };
    const parsed = profileV1Schema.parse(current);
    expect(parsed.voice).toEqual({ provider: "local-tts", id: "a".repeat(32) });
  });
});
