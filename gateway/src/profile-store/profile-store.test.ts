import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createProfileStore } from "./profile-store.js";
import type { ProfileV1 } from "./profile-types.js";

function sample(userId = "kevin"): ProfileV1 {
  return {
    schemaVersion: 1,
    userId,
    model: { provider: "openrouter", id: "google/gemini-2.5-flash" },
    voice: { provider: "fish-audio", id: "voice-abc" },
    audio: { ttsEnabled: true, channel: "voice" as const },
    persona: { template: "default", overrides: "" },
    tools: { enabled: { home_assistant: [] } },
    compression: { threshold: 0.5 },
    advanced: { extraSystemPrompt: "", maxTokens: 1024, reasoningEffort: "minimal" as const },
  };
}

describe("createProfileStore", () => {
  let root: string;
  let store: ReturnType<typeof createProfileStore>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sentient-pstore-"));
    process.env.SENTIENT_GATEWAY_ROOT = root;
    store = createProfileStore();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    // biome-ignore lint/performance/noDelete: delete is the correct way to unset a process.env key
    delete process.env.SENTIENT_GATEWAY_ROOT;
  });

  it("get returns not-found when no file exists", async () => {
    const r = await store.get("kevin");
    expect(r).toEqual({ ok: false, error: "not-found" });
  });

  it("save then get round-trips", async () => {
    const p = sample();
    const w = await store.save(p);
    expect(w).toEqual({ ok: true, value: undefined });
    const r = await store.get("kevin");
    expect(r).toEqual({ ok: true, value: p });
  });

  it("save uses atomic rename — no .tmp sibling after success", async () => {
    await store.save(sample());
    const dir = join(root, "kevin");
    expect(existsSync(join(dir, "profile.json"))).toBe(true);
    expect(existsSync(join(dir, "profile.json.tmp"))).toBe(false);
  });

  it("returns corrupt-file when JSON is invalid", async () => {
    const dir = join(root, "kevin");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "profile.json"), "not json", "utf8");
    const r = await store.get("kevin");
    expect(r).toEqual({ ok: false, error: "corrupt-file" });
  });

  it("returns corrupt-file when JSON fails schema validation", async () => {
    const dir = join(root, "kevin");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "profile.json"), JSON.stringify({ schemaVersion: 99 }), "utf8");
    const r = await store.get("kevin");
    expect(r).toEqual({ ok: false, error: "corrupt-file" });
  });

  it("save rejects when input fails schema validation", async () => {
    const bad = { ...sample(), model: { provider: "anthropic", id: "x" } } as unknown as ProfileV1;
    const r = await store.save(bad);
    expect(r).toEqual({ ok: false, error: "validation-error" });
  });

  it("remove deletes the profile.json", async () => {
    await store.save(sample());
    const r = await store.remove("kevin");
    expect(r).toEqual({ ok: true, value: undefined });
    const g = await store.get("kevin");
    expect(g).toEqual({ ok: false, error: "not-found" });
  });

  it("remove returns not-found when nothing to remove", async () => {
    const r = await store.remove("ghost");
    expect(r).toEqual({ ok: false, error: "not-found" });
  });
});
