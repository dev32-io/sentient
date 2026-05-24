import { describe, expect, it } from "vitest";
import type { InstallStateData } from "../../admin/install-state.js";
import type { KeysYaml } from "../../admin/secrets-store.js";
import type { SecretsDeps } from "./secrets.js";
import { createSecretsHandler } from "./secrets.js";

// --- Fixtures ----------------------------------------------------------------

function makeInstallState(overrides: Partial<InstallStateData> = {}): InstallStateData {
  return {
    schema_version: "1.0.0",
    installed_version: "1.0.0",
    last_upgraded_from: null,
    last_upgraded_at: null,
    bootstrap_complete: true,
    wizard_cursor: "finish",
    unlock_verified: true,
    ...overrides,
  };
}

function makeKeys(overrides: Partial<KeysYaml> = {}): KeysYaml {
  return {
    schema_version: "1",
    admin_token: "admin-tok",
    llm: {
      active: "openrouter",
      ollama_cloud: { api_key: null, base_url: null },
      openrouter: { api_key: "sk-or-abc123", base_url: null },
      custom: { api_key: null, base_url: "http://custom.local" },
    },
    tts: { fish_audio: { api_key: "fa-xyz" } },
    home_assistant: { url: null, local_ip: null, observe_token: "ha-obs-tok", mcp_server_token: null },
    music_assistant: { url: null, local_ip: null, token: null },
    ...overrides,
  };
}

function makeDeps(
  installState: Partial<InstallStateData> = {},
  keys: Partial<KeysYaml> = {},
  isAdmin = true,
): SecretsDeps {
  const state = makeInstallState(installState);
  const keysData = makeKeys(keys);
  return {
    installState: { load: async () => state } as SecretsDeps["installState"],
    secretsStore: {
      load: async () => keysData,
      loadSync: () => keysData,
      getActiveLlm: async () => ({ ok: true, value: { provider: keysData.llm.active, apiKey: "", baseUrl: "" } }),
      getFishAudioKey: async () => keysData.tts.fish_audio.api_key,
      getActiveLlmSync: () => null,
      getFishAudioKeySync: () => null,
      getProviderSecrets: async () => ({ ok: true, value: { provider: keysData.llm.active, apiKey: "", baseUrl: "" } }),
      getProviderSecretsSync: () => null,
      setLlmProviderKey: async () => ({ ok: true, value: undefined }),
      setActiveLlmProvider: async () => ({ ok: true, value: undefined }),
      setFishAudioKey: async () => ({ ok: true, value: undefined }),
      setHomeAssistantToken: async () => ({ ok: true, value: undefined }),
      setHomeAssistantUrl: async () => ({ ok: true, value: undefined }),
      setHomeAssistantLocalIp: async () => ({ ok: true, value: undefined }),
      setMusicAssistantToken: async () => ({ ok: true, value: undefined }),
      setMusicAssistantUrl: async () => ({ ok: true, value: undefined }),
      setMusicAssistantLocalIp: async () => ({ ok: true, value: undefined }),
      diffPaths: async () => [],
      getAdminToken: async () => keysData.admin_token,
      status: async () => ({
        ok: true,
        value: {
          keysPath: "/test/keys.yaml",
          schemaVersion: "1",
          hasFile: true,
          activeLlmProvider: keysData.llm.active,
          hasFishAudioKey: keysData.tts.fish_audio.api_key !== null,
        },
      }),
    },
    requireAdmin: async () =>
      isAdmin ? { ok: true as const, value: { isAdmin: true } } : { ok: true as const, value: { isAdmin: false } },
  };
}

// --- Tests -------------------------------------------------------------------

describe("GET /api/v1/admin/secrets — never-echo contract", () => {
  it("response body never contains any real key chars (full or partial)", async () => {
    const realKey = "sk-or-CONTRACT-TEST-XYZ-1234567890";
    const deps = makeDeps(
      {},
      {
        llm: {
          active: "openrouter",
          ollama_cloud: { api_key: null, base_url: null },
          openrouter: { api_key: realKey, base_url: null },
          custom: { api_key: null, base_url: "http://custom.local" },
        },
        tts: { fish_audio: { api_key: "fa-xyz" } },
      },
    );
    const handler = createSecretsHandler(deps);
    const res = await handler(new Request("http://localhost/api/v1/admin/secrets"));
    expect(res.status).toBe(200);
    const text = await res.text();
    // No full key value
    expect(text).not.toContain(realKey);
    // No prefix (5+ chars)
    expect(text).not.toContain("sk-or");
    // No suffix (5+ chars)
    expect(text).not.toContain("1234567890");
    // No other real key values from fixtures
    expect(text).not.toContain("fa-xyz");
    expect(text).not.toContain("ha-obs-tok");
    expect(text).not.toContain("admin-tok");
  });

  it("response shows correct presence flags", async () => {
    const handler = createSecretsHandler(makeDeps());
    const res = await handler(new Request("http://localhost/api/v1/admin/secrets"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.llm.active).toBe("openrouter");
    expect(body.llm.openrouter.has_key).toBe(true);
    expect(body.llm.ollama_cloud.has_key).toBe(false);
    expect(body.llm.custom.has_key).toBe(false);
    expect(body.llm.custom.has_base_url).toBe(true);
    expect(body.tts.fish_audio.has_key).toBe(true);
    expect(body.home_assistant.url).toBeNull();
    expect(body.home_assistant.observe_token.has_token).toBe(true);
    expect(body.home_assistant.mcp_server_token.has_token).toBe(false);
    expect(body.music_assistant.url).toBeNull();
    expect(body.music_assistant.has_token).toBe(false);
    // masked field must not exist
    expect(body.llm.openrouter.masked).toBeUndefined();
    expect(body.tts.fish_audio.masked).toBeUndefined();
    // LLM provider base_url must not appear in the response (it's a credential-adjacent field)
    expect(body.llm.custom.base_url).toBeUndefined();
  });
});

describe("PUT /api/v1/admin/secrets — never-echo contract", () => {
  it("PUT response body never contains submitted value", async () => {
    const handler = createSecretsHandler(makeDeps());
    const res = await handler(
      new Request("http://localhost/api/v1/admin/secrets/tts/fish_audio", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "fa-supersecret99" }),
      }),
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("fa-supersecret99");
  });
});

describe("PUT /api/v1/admin/secrets/llm/{provider} — independent field patches", () => {
  it("base_url-only patch calls setLlmProviderKey with only base_url in patch", async () => {
    const calls: Array<{ provider: string; patch: unknown }> = [];
    const deps = makeDeps();
    deps.secretsStore.setLlmProviderKey = async (provider, patch) => {
      calls.push({ provider, patch });
      return { ok: true, value: undefined };
    };
    const handler = createSecretsHandler(deps);
    const res = await handler(
      new Request("http://localhost/api/v1/admin/secrets/llm/custom", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ base_url: "https://api.example.com/v1" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.patch).toEqual({ base_url: "https://api.example.com/v1" });
    // api_key must NOT be in the patch — base_url-only update must not touch the key
    expect((calls[0]?.patch as Record<string, unknown>).api_key).toBeUndefined();
  });

  it("value-only patch calls setLlmProviderKey with only api_key in patch", async () => {
    const calls: Array<{ provider: string; patch: unknown }> = [];
    const deps = makeDeps();
    deps.secretsStore.setLlmProviderKey = async (provider, patch) => {
      calls.push({ provider, patch });
      return { ok: true, value: undefined };
    };
    const handler = createSecretsHandler(deps);
    const res = await handler(
      new Request("http://localhost/api/v1/admin/secrets/llm/custom", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "sk-supersecret" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.patch).toEqual({ api_key: "sk-supersecret" });
    // base_url must NOT be in the patch — api_key-only update must not touch the base_url
    expect((calls[0]?.patch as Record<string, unknown>).base_url).toBeUndefined();
  });

  it("returns 422 when neither value nor base_url is provided", async () => {
    const handler = createSecretsHandler(makeDeps());
    const res = await handler(
      new Request("http://localhost/api/v1/admin/secrets/llm/custom", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ something_else: "x" }),
      }),
    );
    expect(res.status).toBe(422);
  });

  it("empty value clears api_key but leaves base_url untouched", async () => {
    const calls: Array<{ provider: string; patch: unknown }> = [];
    const deps = makeDeps();
    deps.secretsStore.setLlmProviderKey = async (provider, patch) => {
      calls.push({ provider, patch });
      return { ok: true, value: undefined };
    };
    const handler = createSecretsHandler(deps);
    const res = await handler(
      new Request("http://localhost/api/v1/admin/secrets/llm/custom", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(calls[0]?.patch).toEqual({ api_key: null });
    expect((calls[0]?.patch as Record<string, unknown>).base_url).toBeUndefined();
  });
});

describe("bootstrap gate", () => {
  it("returns 412 when bootstrap_complete=false", async () => {
    const handler = createSecretsHandler(makeDeps({ bootstrap_complete: false }));
    const res = await handler(new Request("http://localhost/api/v1/admin/secrets"));
    expect(res.status).toBe(412);
  });
});

describe("admin gate", () => {
  it("returns 403 when isAdmin=false", async () => {
    const handler = createSecretsHandler(makeDeps({}, {}, false));
    const res = await handler(new Request("http://localhost/api/v1/admin/secrets"));
    expect(res.status).toBe(403);
  });
});
