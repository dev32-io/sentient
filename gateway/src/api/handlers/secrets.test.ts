import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { InstallStateData } from "../../admin/install-state.js";
import type { KeysYaml } from "../../admin/secrets-store.js";
import type { SecretsDeps } from "./secrets.js";
import { createSecretsHandler } from "./secrets.js";

// --- Fixtures ----------------------------------------------------------------

const MANAGED_GORUSH_URL = "http://127.0.0.1:8088/api/push";
const VALID_KEY_ID = "ABCDEFGHIJ";
const VALID_TEAM_ID = "KLMNOPQRST";
const VALID_PRIVATE_KEY_P8 = generateKeyPairSync("ec", {
  namedCurve: "prime256v1",
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;
const WRONG_CURVE_PRIVATE_KEY = generateKeyPairSync("ec", {
  namedCurve: "secp384r1",
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;
const ENCRYPTED_PRIVATE_KEY = generateKeyPairSync("ec", {
  namedCurve: "prime256v1",
  privateKeyEncoding: { type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase: "test-only" },
  publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;

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
    home_assistant: { url: null, local_ip: null, observe_token: "ha-obs-tok", mcp_server_token: null },
    music_assistant: { url: null, local_ip: null, token: null },
    push: { apns_key_base64: null, apns_key_id: null, apns_team_id: null },
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
      getActiveLlmSync: () => null,
      getProviderSecrets: async () => ({ ok: true, value: { provider: keysData.llm.active, apiKey: "", baseUrl: "" } }),
      getProviderSecretsSync: () => null,
      getApnsCredentialsSync: () => null,
      setApnsCredentials: async ({ keyBase64, keyId, teamId }) => {
        keysData.push = { apns_key_base64: keyBase64, apns_key_id: keyId, apns_team_id: teamId };
        return { ok: true, value: undefined };
      },
      setLlmProviderKey: async () => ({ ok: true, value: undefined }),
      setActiveLlmProvider: async () => ({ ok: true, value: undefined }),
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
        },
      }),
    },
    requireAdmin: async () =>
      isAdmin
        ? { ok: true as const, value: { role: "admin" as const } }
        : { ok: true as const, value: { role: "adult" as const } },
    systemOrchestrator: {
      applySubset: async () => ({
        state: "ready",
        services: [{ name: "gorush", state: "ready", optional: true, version: null, lastError: null }],
        startedAt: 1,
        finishedAt: 2,
      }),
    },
    pushProviderUrl: MANAGED_GORUSH_URL,
  };
}

function apnsRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/v1/admin/secrets/push/apns", {
    method: "PUT",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
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
    expect(body.home_assistant.url).toBeNull();
    expect(body.home_assistant.observe_token.has_token).toBe(true);
    expect(body.home_assistant.mcp_server_token.has_token).toBe(false);
    expect(body.music_assistant.url).toBeNull();
    expect(body.music_assistant.has_token).toBe(false);
    expect(body.push).toEqual({ has_key: false, has_key_id: false, has_team_id: false });
    // masked field must not exist
    expect(body.llm.openrouter.masked).toBeUndefined();
    // LLM provider base_url must not appear in the response (it's a credential-adjacent field)
    expect(body.llm.custom.base_url).toBeUndefined();
  });

  it("returns APNs presence without stored key or ID readback", async () => {
    const privateKeyBase64 = Buffer.from(VALID_PRIVATE_KEY_P8).toString("base64");
    const handler = createSecretsHandler(
      makeDeps(
        {},
        { push: { apns_key_base64: privateKeyBase64, apns_key_id: VALID_KEY_ID, apns_team_id: VALID_TEAM_ID } },
      ),
    );
    const text = await (await handler(new Request("http://localhost/api/v1/admin/secrets"))).text();
    expect(JSON.parse(text).push).toEqual({ has_key: true, has_key_id: true, has_team_id: true });
    expect(text).not.toContain(privateKeyBase64);
    expect(text).not.toContain(VALID_KEY_ID);
    expect(text).not.toContain(VALID_TEAM_ID);
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

describe("APNs credentials and targeted apply", () => {
  it("stores only base64 key material and returns no credential values", async () => {
    const deps = makeDeps();
    const setCredentials = vi.fn(deps.secretsStore.setApnsCredentials);
    deps.secretsStore.setApnsCredentials = setCredentials;
    if (!deps.systemOrchestrator) throw new Error("test orchestrator missing");
    const applySubset = vi.fn(deps.systemOrchestrator.applySubset);
    deps.systemOrchestrator.applySubset = applySubset;

    const res = await createSecretsHandler(deps)(
      apnsRequest({ private_key_p8: VALID_PRIVATE_KEY_P8, key_id: VALID_KEY_ID, team_id: VALID_TEAM_ID }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(setCredentials).toHaveBeenCalledWith({
      keyBase64: Buffer.from(VALID_PRIVATE_KEY_P8).toString("base64"),
      keyId: VALID_KEY_ID,
      teamId: VALID_TEAM_ID,
    });
    expect(applySubset).not.toHaveBeenCalled();
  });

  it("rejects malformed, wrong-curve, encrypted, and invalid-ID credentials", async () => {
    const handler = createSecretsHandler(makeDeps());
    const invalidBodies = [
      { private_key_p8: "not a key", key_id: VALID_KEY_ID, team_id: VALID_TEAM_ID },
      { private_key_p8: WRONG_CURVE_PRIVATE_KEY, key_id: VALID_KEY_ID, team_id: VALID_TEAM_ID },
      { private_key_p8: ENCRYPTED_PRIVATE_KEY, key_id: VALID_KEY_ID, team_id: VALID_TEAM_ID },
      { private_key_p8: VALID_PRIVATE_KEY_P8, key_id: "lowercase1", team_id: VALID_TEAM_ID },
    ];

    for (const body of invalidBodies) {
      const res = await handler(apnsRequest(body));
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({ error: "schema", detail: "Valid APNs P-256 credentials required" });
    }
  });

  it("rejects a declared body over 16 KiB", async () => {
    const deps = makeDeps();
    const setCredentials = vi.fn(deps.secretsStore.setApnsCredentials);
    deps.secretsStore.setApnsCredentials = setCredentials;
    const res = await createSecretsHandler(deps)(
      apnsRequest(
        { private_key_p8: VALID_PRIVATE_KEY_P8, key_id: VALID_KEY_ID, team_id: VALID_TEAM_ID },
        { "content-length": String(16 * 1024 + 1) },
      ),
    );
    expect(res.status).toBe(413);
    expect(setCredentials).not.toHaveBeenCalled();
  });

  it("stops an undeclared chunked body once it exceeds 16 KiB", async () => {
    const deps = makeDeps();
    const setCredentials = vi.fn(deps.secretsStore.setApnsCredentials);
    deps.secretsStore.setApnsCredentials = setCredentials;
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("{"));
        controller.enqueue(encoder.encode("x".repeat(16 * 1024)));
        controller.close();
      },
    });
    const req = new Request("http://localhost/api/v1/admin/secrets/push/apns", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    expect(req.headers.has("content-length")).toBe(false);

    const res = await createSecretsHandler(deps)(req);
    expect(res.status).toBe(413);
    expect(setCredentials).not.toHaveBeenCalled();
  });

  it("supports initial apply, rotation, and reapply without another upload", async () => {
    const deps = makeDeps();
    const setCredentials = vi.fn(deps.secretsStore.setApnsCredentials);
    deps.secretsStore.setApnsCredentials = setCredentials;
    if (!deps.systemOrchestrator) throw new Error("test orchestrator missing");
    const applySubset = vi.fn(deps.systemOrchestrator.applySubset);
    deps.systemOrchestrator.applySubset = applySubset;
    const handler = createSecretsHandler(deps);

    expect(
      (
        await handler(
          apnsRequest({ private_key_p8: VALID_PRIVATE_KEY_P8, key_id: VALID_KEY_ID, team_id: VALID_TEAM_ID }),
        )
      ).status,
    ).toBe(200);
    expect(
      await (
        await handler(
          new Request("http://localhost/api/v1/admin/secrets/push/apns/apply", {
            method: "POST",
          }),
        )
      ).json(),
    ).toEqual({ ok: true, transport: "running" });

    expect(
      (
        await handler(
          apnsRequest({ private_key_p8: VALID_PRIVATE_KEY_P8, key_id: "UVWXYZ1234", team_id: "567890ABCD" }),
        )
      ).status,
    ).toBe(200);
    for (let i = 0; i < 2; i++) {
      const res = await handler(
        new Request("http://localhost/api/v1/admin/secrets/push/apns/apply", {
          method: "POST",
        }),
      );
      expect(await res.json()).toEqual({ ok: true, transport: "running" });
    }

    expect(setCredentials).toHaveBeenCalledTimes(2);
    expect(applySubset).toHaveBeenCalledTimes(3);
    for (const [targets] of applySubset.mock.calls) expect([...targets]).toEqual(["gorush"]);
  });

  it.each(["degraded", "missing"] as const)("fails when Gorush target is %s despite top-level ready", async (kind) => {
    const deps = makeDeps(
      {},
      { push: { apns_key_base64: "stored", apns_key_id: VALID_KEY_ID, apns_team_id: VALID_TEAM_ID } },
    );
    if (!deps.systemOrchestrator) throw new Error("test orchestrator missing");
    deps.systemOrchestrator.applySubset = async () => ({
      state: "ready",
      services:
        kind === "missing"
          ? []
          : [{ name: "gorush", state: "degraded", optional: true, version: null, lastError: "not ready" }],
      startedAt: 1,
      finishedAt: 2,
    });

    const res = await createSecretsHandler(deps)(
      new Request("http://localhost/api/v1/admin/secrets/push/apns/apply", { method: "POST" }),
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: "push-transport-unavailable",
      detail: "APNs transport failed to start",
    });
  });

  it("refuses apply when configured provider URL is not managed Gorush", async () => {
    const deps = makeDeps(
      {},
      { push: { apns_key_base64: "stored", apns_key_id: VALID_KEY_ID, apns_team_id: VALID_TEAM_ID } },
    );
    deps.pushProviderUrl = "http://127.0.0.1:18088/api/push";
    if (!deps.systemOrchestrator) throw new Error("test orchestrator missing");
    const applySubset = vi.fn(deps.systemOrchestrator.applySubset);
    deps.systemOrchestrator.applySubset = applySubset;

    const res = await createSecretsHandler(deps)(
      new Request("http://localhost/api/v1/admin/secrets/push/apns/apply", { method: "POST" }),
    );
    expect(res.status).toBe(412);
    expect(applySubset).not.toHaveBeenCalled();
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
  it("returns 403 without reading secrets when role is not admin", async () => {
    const deps = makeDeps({}, {}, false);
    const load = vi.fn(deps.secretsStore.load);
    deps.secretsStore.load = load;
    const handler = createSecretsHandler(deps);
    const res = await handler(new Request("http://localhost/api/v1/admin/secrets"));
    expect(res.status).toBe(403);
    expect(load).not.toHaveBeenCalled();
  });
});
