import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createProfileStore, memoryTogglesFor } from "./profile-store.js";
import type { ProfileV1 } from "./profile-types.js";

function sample(userId = "kevin"): ProfileV1 {
  return {
    schemaVersion: 1,
    userId,
    model: { provider: "openrouter", id: "google/gemini-2.5-flash" },
    voice: { provider: "local-tts", id: "voice-abc" },
    audio: { ttsEnabled: true, channel: "voice" as const },
    // Non-default values (spark off, dreaming on) so the round-trip test
    // actually exercises persistence rather than merely re-observing the
    // schema's own defaults.
    memory: { spark: false, dreaming: true },
    persona: { template: "default", overrides: "" },
    tools: { permissions: { home_assistant: {} } },
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

  describe("memory toggles", () => {
    it("persist through a store re-open — same root, a fresh createProfileStore() instance", async () => {
      await store.save(sample("kevin"));
      // Re-open: a brand new store instance, no reference to the one that
      // saved. Nothing but SENTIENT_GATEWAY_ROOT (unchanged) ties it to the
      // same file — proving the toggle survived on disk, not just in a
      // closure the first store happened to hold.
      const reopened = createProfileStore();
      const r = await reopened.get("kevin");
      expect(r).toEqual({ ok: true, value: sample("kevin") });
      if (r.ok) expect(r.value.memory).toEqual({ spark: false, dreaming: true });
    });

    it("a profile.json written before this field existed parses with both toggles defaulted true", async () => {
      const dir = join(root, "kevin");
      mkdirSync(dir, { recursive: true });
      const { memory: _omitted, ...preMemoryProfile } = sample("kevin");
      writeFileSync(join(dir, "profile.json"), JSON.stringify(preMemoryProfile), "utf8");

      const r = await store.get("kevin");
      expect(r).toEqual({ ok: true, value: { ...preMemoryProfile, memory: { spark: true, dreaming: true } } });
    });

    it("memoryTogglesFor returns the stored values", async () => {
      await store.save(sample("kevin"));
      await expect(memoryTogglesFor(store, "kevin")).resolves.toEqual({ spark: false, dreaming: true });
    });

    it("memoryTogglesFor defaults to {spark: true, dreaming: true} when the profile does not exist", async () => {
      await expect(memoryTogglesFor(store, "ghost")).resolves.toEqual({ spark: true, dreaming: true });
    });

    it("memoryTogglesFor defaults to {spark: true, dreaming: true} on a corrupt profile", async () => {
      const dir = join(root, "kevin");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "profile.json"), "not json", "utf8");
      await expect(memoryTogglesFor(store, "kevin")).resolves.toEqual({ spark: true, dreaming: true });
    });
  });
});
