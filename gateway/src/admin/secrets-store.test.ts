import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSecretsStore } from "./secrets-store.ts";

const TEMPLATE_PATH = join(import.meta.dir, "../../templates/wizard/keys.yaml.tmpl");

function makeStore(dir: string, generateAdminToken?: () => string) {
  return createSecretsStore({
    keysPath: join(dir, "secrets", "keys.yaml"),
    templatePath: TEMPLATE_PATH,
    generateAdminToken: generateAdminToken ?? (() => "test-admin-token-32charszzzzzzzzzz"),
  });
}

describe("SecretsStore", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ss-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // --- Wire contract: first load creates keys.yaml from template at mode 0600 ---

  it("first load creates keys.yaml from template with mode 0600", async () => {
    const store = makeStore(dir);
    await store.load();
    const s = await stat(join(dir, "secrets", "keys.yaml"));
    // eslint-disable-next-line no-bitwise
    expect(s.mode & 0o777).toBe(0o600);
  });

  it("first load bootstraps with active=ollama-cloud (template default)", async () => {
    const store = makeStore(dir);
    const data = await store.load();
    expect(data.llm.active).toBe("ollama-cloud");
    expect(data.schema_version).toBe("1.0.0");
  });

  // --- Security boundary: mode > 0600 → permission-too-broad -----------------

  it("reading file with mode 0644 returns permission-too-broad error", async () => {
    // Bootstrap first so file exists
    const store = makeStore(dir);
    await store.load();
    const keysPath = join(dir, "secrets", "keys.yaml");
    await chmod(keysPath, 0o644);
    // New store instance — no cache
    const store2 = makeStore(dir);
    const r = await store2.getActiveLlm();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe("permission-too-broad");
    }
  });

  // --- FSM: setActiveLlmProvider → getActiveLlm reflects change ---------------

  it("setActiveLlmProvider('openrouter') then getActiveLlm returns openrouter entry", async () => {
    const store = makeStore(dir);
    await store.load();
    await store.setActiveLlmProvider("openrouter");
    const r = await store.getActiveLlm();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.provider).toBe("openrouter");
    }
  });

  // --- FSM: setLlmProviderKey round-trips via getActiveLlm --------------------

  it("setLlmProviderKey for active provider round-trips via getActiveLlm", async () => {
    const store = makeStore(dir);
    await store.load();
    // default active is ollama-cloud
    await store.setLlmProviderKey("ollama-cloud", { api_key: "test-key-xyz" });
    const r = await store.getActiveLlm();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.provider).toBe("ollama-cloud");
      expect(r.value.apiKey).toBe("test-key-xyz");
    }
  });

  it("setLlmProviderKey preserves other providers", async () => {
    const store = makeStore(dir);
    await store.load();
    await store.setActiveLlmProvider("openrouter");
    await store.setLlmProviderKey("openrouter", { api_key: "or-key" });
    await store.setLlmProviderKey("custom", { base_url: "http://custom" });
    // Switch to custom and check
    await store.setActiveLlmProvider("custom");
    const r = await store.getActiveLlm();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.provider).toBe("custom");
      expect(r.value.baseUrl).toBe("http://custom");
    }
    // openrouter key must still be there
    const data = await store.load();
    expect(data.llm.openrouter.api_key).toBe("or-key");
  });

  // --- Atomic write recovery: stale .tmp file ignored on load -----------------

  it("stale .tmp file does not prevent loading", async () => {
    const store = makeStore(dir);
    await store.load();
    const keysPath = join(dir, "secrets", "keys.yaml");
    await writeFile(`${keysPath}.tmp`, "# stale tmp");
    const store2 = makeStore(dir);
    const r = await store2.getActiveLlm();
    expect(r.ok).toBe(true);
  });

  // --- Cache consistency: sync getters -------------------------------------------

  it("getActiveLlmSync returns null before any load", () => {
    const store = makeStore(dir);
    expect(store.getActiveLlmSync()).toBeNull();
  });

  it("getActiveLlmSync returns value after load()", async () => {
    const store = makeStore(dir);
    await store.load();
    const sync = store.getActiveLlmSync();
    expect(sync).not.toBeNull();
    expect(sync?.provider).toBe("ollama-cloud");
  });

  // --- Admin token is injected from generateAdminToken -----------------------

  it("admin_token is the value from generateAdminToken", async () => {
    const store = makeStore(dir, () => "my-custom-token-32chars0000000000");
    const data = await store.load();
    expect(data.admin_token).toBe("my-custom-token-32chars0000000000");
  });

  // --- URL setters persist and are readable via load() ----------------------

  it("setHomeAssistantUrl persists and is readable via load()", async () => {
    const store = makeStore(dir);
    await store.setHomeAssistantUrl("https://home.example.com:8123");
    const keys = await store.load();
    expect(keys.home_assistant.url).toBe("https://home.example.com:8123");
  });

  it("setMusicAssistantUrl persists and is readable via load()", async () => {
    const store = makeStore(dir);
    await store.setMusicAssistantUrl("http://mass.local:8095");
    const keys = await store.load();
    expect(keys.music_assistant.url).toBe("http://mass.local:8095");
  });

  // --- diffPaths: returns changed dotted-paths ---------------------------------

  it("diffPaths returns [] when partial is null", async () => {
    const store = makeStore(dir);
    await store.load();
    expect(await store.diffPaths(null)).toEqual([]);
  });

  it("diffPaths returns [] when all values match stored values", async () => {
    const store = makeStore(dir);
    await store.load();
    // Default active is ollama-cloud; api_key starts as null
    const result = await store.diffPaths({ llm: { active: "ollama-cloud" } });
    expect(result).toEqual([]);
  });

  it("diffPaths returns dotted-path when value differs from stored", async () => {
    const store = makeStore(dir);
    await store.load();
    // Default active is ollama-cloud, so setting it to "openrouter" is a diff
    const result = await store.diffPaths({ llm: { active: "openrouter" } });
    expect(result).toContain("llm.active");
  });
});
