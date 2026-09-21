// INVARIANT — the model a user picked in Settings is the model that runs.
//
// It was not. `ResolvedLlm` carries `{provider, apiKey, baseUrl}` and no model,
// so the orchestrator took the model from `config.yaml#orchestrator.provider.
// model` for everybody: the settings UI showed `deepseek-v4-flash:cloud` while
// the runtime dialled `gpt-oss:20b-cloud`. Every judgement about model
// behaviour on this branch — task 15's role A/B included — was made against a
// model nobody chose.
//
// The selection does NOT live in the secrets store even though the key does; it
// is per-user, in `profile.json#model`. So these cases pin the precedence, the
// fallback, and the one refusal that keeps the fallback honest.

import { describe, expect, it } from "bun:test";
import type { OrchestratorConfig } from "@sentient/config";
import type { Result } from "@sentient/protocol";
import type { ProfileStore, ProfileStoreError } from "../profile-store/profile-store.js";
import type { ProfileV1 } from "../profile-store/profile-types.js";
import type { ProviderClient } from "../provider/provider-client.js";
import { createAuxiliaryModelResolver } from "./auxiliary-model-resolver.js";
import { type ProviderConnectionInput, createUserModelProvider } from "./user-model-provider.js";

const CONFIG_MODEL = "gpt-oss:20b-cloud";
const USER = "u_0417d3b0";

const providerCfg = {
  base_url: "https://ollama.com/v1",
  model: CONFIG_MODEL,
  max_output_tokens: 1024,
  request_timeout_ms: 120000,
  site_name: "Sentient",
} as OrchestratorConfig["provider"];

function profileWith(model: ProfileV1["model"]): ProfileV1 {
  return { userId: USER, model } as ProfileV1;
}

function storeReturning(result: Result<ProfileV1, ProfileStoreError>): ProfileStore {
  return {
    get: async () => result,
    save: async () => ({ ok: true, value: undefined }),
    remove: async () => ({ ok: true, value: undefined }),
  };
}

/** Records the model each constructed client was built with, and yields one
 *  `done` chunk so the generator can be driven to completion. */
function recordingFactory(built: string[]): (cfg: OrchestratorConfig["provider"]) => ProviderClient {
  return (cfg) => {
    built.push(cfg.model);
    return {
      async *stream() {
        yield { type: "done", finishReason: "stop" } as never;
      },
    };
  };
}

async function drive(client: ProviderClient): Promise<void> {
  for await (const _chunk of client.stream({
    messages: [],
    tools: [],
    signal: new AbortController().signal,
  } as never)) {
    // drained
  }
}

describe("createUserModelProvider", () => {
  it("runs the model the user selected, not config.yaml's", async () => {
    const built: string[] = [];
    const factory = createUserModelProvider({
      providerCfg,
      connection: { provider: "ollama-cloud", apiKey: "k", baseUrl: "https://ollama.com/v1" },
      profileStore: storeReturning({
        ok: true,
        value: profileWith({ provider: "ollama-cloud", id: "deepseek-v4-flash:cloud" }),
      }),
      createProvider: recordingFactory(built),
    });

    await drive(factory.forUser(USER));

    expect(built).toEqual(["deepseek-v4-flash"]);
  });

  it("falls back to config.yaml when the user has no profile", async () => {
    const built: string[] = [];
    const factory = createUserModelProvider({
      providerCfg,
      connection: { provider: "ollama-cloud", apiKey: "k", baseUrl: "https://ollama.com/v1" },
      profileStore: storeReturning({ ok: false, error: "not-found" }),
      createProvider: recordingFactory(built),
    });

    await drive(factory.forUser(USER));

    expect(built).toEqual(["gpt-oss:20b"]);
  });

  // A model id is only meaningful to the provider it was picked from. Sending an
  // OpenRouter slug to Ollama's endpoint is a worse failure than the documented
  // fallback, and a silent one — so the mismatch refuses the selection.
  it("refuses a selection made against a provider that is no longer active", async () => {
    const built: string[] = [];
    const factory = createUserModelProvider({
      providerCfg,
      connection: { provider: "ollama-cloud", apiKey: "k", baseUrl: "https://ollama.com/v1" },
      profileStore: storeReturning({
        ok: true,
        value: profileWith({ provider: "openrouter", id: "anthropic/claude-sonnet-4.6" }),
      }),
      createProvider: recordingFactory(built),
    });

    await drive(factory.forUser(USER));

    expect(built).toEqual(["gpt-oss:20b"]);
  });

  // One OpenAI client per distinct model, not per turn: the resolution is
  // per-request (so a Settings change lands on the next turn, with no restart),
  // but constructing a fresh HTTP client for every LLM call is not.
  it("builds one client per distinct model however often it is asked", async () => {
    const built: string[] = [];
    const factory = createUserModelProvider({
      providerCfg,
      connection: { provider: "ollama-cloud", apiKey: "k", baseUrl: "https://ollama.com/v1" },
      profileStore: storeReturning({
        ok: true,
        value: profileWith({ provider: "ollama-cloud", id: "deepseek-v4-flash:cloud" }),
      }),
      createProvider: recordingFactory(built),
    });

    const client = factory.forUser(USER);
    await drive(client);
    await drive(client);
    await drive(factory.forUser(USER));

    expect(built).toEqual(["deepseek-v4-flash"]);
  });

  it("resolves auxiliary override/default per request and refuses mismatched providers", async () => {
    const built: string[] = [];
    let current = profileWith({ provider: "ollama-cloud", id: "chat:cloud" });
    const store = storeReturning({ ok: true, value: current });
    store.get = async () => ({ ok: true, value: current });
    const auxiliaryResolver = createAuxiliaryModelResolver({
      activeProvider: "ollama-cloud",
      chatModel: CONFIG_MODEL,
      dreamerModel: "operator-dreamer:cloud",
      attachmentVisionModel: "gemma4:31b-cloud",
      profileStore: store,
    });
    const factory = createUserModelProvider({
      providerCfg,
      connection: { provider: "ollama-cloud", apiKey: "k", baseUrl: "https://ollama.com/v1" },
      profileStore: store,
      auxiliaryResolver,
      createProvider: recordingFactory(built),
    });

    await drive(factory.forUser(USER, "title"));
    current = {
      ...current,
      auxiliaryModels: { dreamer: { provider: "ollama-cloud", id: "user-dreamer:cloud" } },
    };
    await drive(factory.forUser(USER, "dreamer"));
    expect(built).toEqual(["chat", "user-dreamer"]);

    current = {
      ...current,
      auxiliaryModels: { title: { provider: "openrouter", id: "vendor/title" } },
    };
    await expect(drive(factory.forUser(USER, "title"))).rejects.toThrow("provider-mismatch");
  });

  it("resolves attachment vision through active-provider catalog without fallback", async () => {
    const built: string[] = [];
    const store = storeReturning({
      ok: true,
      value: {
        ...profileWith({ provider: "ollama-cloud", id: "chat:cloud" }),
        auxiliaryModels: { attachmentVision: { provider: "ollama-cloud", id: "gemma4:31b-cloud" } },
      },
    });
    const factory = createUserModelProvider({
      providerCfg,
      connection: { provider: "ollama-cloud", apiKey: "k", baseUrl: "https://ollama.com/v1" },
      profileStore: store,
      auxiliaryResolver: createAuxiliaryModelResolver({
        activeProvider: "ollama-cloud",
        chatModel: CONFIG_MODEL,
        dreamerModel: "operator-dreamer:cloud",
        attachmentVisionModel: "gemma4:31b-cloud",
        profileStore: store,
      }),
      resolveProviderModel: async (provider, id) => ({
        model: { provider, id, supportsVision: true } as never,
        visionCapabilityKnown: true,
        toolsCapabilityKnown: false,
      }),
      createProvider: recordingFactory(built),
    });

    const resolved = await factory.resolveAttachmentVision(USER);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.model).toEqual({ provider: "ollama-cloud", id: "gemma4:31b" });
    await drive(resolved.value.client);
    expect(built).toEqual(["gemma4:31b"]);
  });

  it("snapshots catalog ID, normalized outbound model, client, and known capabilities together", async () => {
    const built: string[] = [];
    const factory = createUserModelProvider({
      providerCfg,
      connection: { provider: "ollama-cloud", apiKey: "k", baseUrl: "https://ollama.com/v1" },
      profileStore: storeReturning({
        ok: true,
        value: profileWith({ provider: "ollama-cloud", id: "vision:cloud" }),
      }),
      resolveProviderModel: async (_provider, id) => ({
        model: {
          provider: "ollama-cloud",
          id,
          name: "Vision",
          description: "",
          contextLength: 8192,
          pricingPer1mPrompt: "included",
          pricingPer1mCompletion: "included",
          supportsTools: false,
          supportsVision: true,
        },
        visionCapabilityKnown: true,
        toolsCapabilityKnown: true,
      }),
      createProvider: recordingFactory(built),
    });

    const snapshot = await factory.resolveMain(USER);
    expect(snapshot).toMatchObject({
      provider: "ollama-cloud",
      catalogModelId: "vision:cloud",
      outboundModel: "vision",
      supportsVision: true,
      supportsTools: false,
      contextLength: 8192,
    });
    await drive(snapshot.client);
    expect(built).toEqual(["vision"]);
  });

  it("snapshots live provider, credential, catalog, and client together after rotation", async () => {
    let connection: ProviderConnectionInput = {
      provider: "openrouter",
      apiKey: "old-key",
      baseUrl: "https://old.example/v1",
    };
    let profile = profileWith({ provider: "openrouter", id: "vendor/old" });
    const store = storeReturning({ ok: true, value: profile });
    store.get = async () => ({ ok: true, value: profile });
    const catalogs: Array<{ provider: string; id: string; key: string; baseUrl: string }> = [];
    const clients: Array<{ baseUrl: string; key: string; model: string }> = [];
    const factory = createUserModelProvider({
      providerCfg,
      connection,
      resolveConnection: async () => connection,
      profileStore: store,
      resolveProviderModel: async (provider, id, snapshot) => {
        catalogs.push({ provider, id, key: snapshot.apiKey, baseUrl: snapshot.baseUrl });
        return {
          model: {
            provider,
            id,
            name: id,
            description: "",
            contextLength: 8192,
            pricingPer1mPrompt: provider === "ollama-cloud" ? "included" : 0,
            pricingPer1mCompletion: provider === "ollama-cloud" ? "included" : 0,
            supportsTools: true,
            supportsVision: true,
          },
          visionCapabilityKnown: true,
          toolsCapabilityKnown: true,
        };
      },
      createProvider: (cfg, key) => {
        clients.push({ baseUrl: cfg.base_url, key, model: cfg.model });
        return {
          async *stream() {
            yield { type: "done", finishReason: "stop" } as never;
          },
        };
      },
    });

    const oldSnapshot = await factory.resolveMain(USER);
    await drive(oldSnapshot.client);
    connection = { provider: "openrouter", apiKey: "old-key", baseUrl: "https://new.example/v1" };
    const rotatedSnapshot = await factory.resolveMain(USER);
    await drive(rotatedSnapshot.client);
    connection = { provider: "ollama-cloud", apiKey: "ollama-key", baseUrl: "https://ollama.com/v1" };
    profile = profileWith({ provider: "ollama-cloud", id: "vision:cloud" });
    const switchedSnapshot = await factory.resolveMain(USER);
    await drive(switchedSnapshot.client);

    expect(catalogs).toEqual([
      { provider: "openrouter", id: "vendor/old", key: "old-key", baseUrl: "https://old.example/v1" },
      { provider: "openrouter", id: "vendor/old", key: "old-key", baseUrl: "https://new.example/v1" },
      { provider: "ollama-cloud", id: "vision:cloud", key: "ollama-key", baseUrl: "https://ollama.com/v1" },
    ]);
    expect(clients).toEqual([
      { baseUrl: "https://old.example/v1", key: "old-key", model: "vendor/old" },
      { baseUrl: "https://new.example/v1", key: "old-key", model: "vendor/old" },
      { baseUrl: "https://ollama.com/v1", key: "ollama-key", model: "vision" },
    ]);
  });

  it("binds attachment catalog validation and streaming to each live connection snapshot", async () => {
    let connection: ProviderConnectionInput = {
      provider: "openrouter",
      apiKey: "old-key",
      baseUrl: "https://old.example/v1",
    };
    let current: ProfileV1 = {
      ...profileWith({ provider: "openrouter", id: "vendor/chat" }),
      auxiliaryModels: { attachmentVision: { provider: "openrouter" as const, id: "vendor/vision" } },
    };
    const store = storeReturning({ ok: true, value: current });
    store.get = async () => ({ ok: true, value: current });
    const catalogs: Array<{ provider: string; id: string; key: string; baseUrl: string }> = [];
    const clients: Array<{ baseUrl: string; key: string; model: string }> = [];
    const factory = createUserModelProvider({
      providerCfg,
      connection,
      resolveConnection: async () => connection,
      profileStore: store,
      auxiliaryResolver: createAuxiliaryModelResolver({
        activeProvider: "openrouter",
        chatModel: CONFIG_MODEL,
        dreamerModel: "operator-dreamer",
        attachmentVisionModel: "unused",
        profileStore: store,
      }),
      resolveProviderModel: async (provider, id, snapshot) => {
        catalogs.push({ provider, id, key: snapshot.apiKey, baseUrl: snapshot.baseUrl });
        return {
          model: { provider, id, supportsVision: true } as never,
          visionCapabilityKnown: true,
          toolsCapabilityKnown: false,
        };
      },
      createProvider: (cfg, key) => {
        clients.push({ baseUrl: cfg.base_url, key, model: cfg.model });
        return {
          async *stream() {
            yield { type: "done", finishReason: "stop" } as never;
          },
        };
      },
    });

    connection = { provider: "openrouter", apiKey: "old-key", baseUrl: "https://new.example/v1" };
    const rotated = await factory.resolveAttachmentVision(USER);
    expect(rotated.ok).toBe(true);
    if (!rotated.ok) return;
    await drive(rotated.value.client);

    connection = { provider: "ollama-cloud", apiKey: "new-key", baseUrl: "https://ollama.example/v1" };
    current = {
      ...profileWith({ provider: "ollama-cloud", id: "chat:cloud" }),
      auxiliaryModels: { attachmentVision: { provider: "ollama-cloud", id: "vision:cloud" } },
    };
    const switched = await factory.resolveAttachmentVision(USER);
    expect(switched.ok).toBe(true);
    if (!switched.ok) return;
    await drive(switched.value.client);

    expect(catalogs).toEqual([
      { provider: "openrouter", id: "vendor/vision", key: "old-key", baseUrl: "https://new.example/v1" },
      { provider: "ollama-cloud", id: "vision:cloud", key: "new-key", baseUrl: "https://ollama.example/v1" },
    ]);
    expect(clients).toEqual([
      { baseUrl: "https://new.example/v1", key: "old-key", model: "vendor/vision" },
      { baseUrl: "https://ollama.example/v1", key: "new-key", model: "vision:cloud" },
    ]);
  });

  it("keeps ordinary main usable but reports unknown capabilities when catalog resolution fails", async () => {
    const factory = createUserModelProvider({
      providerCfg,
      connection: { provider: "ollama-cloud", apiKey: "k", baseUrl: "https://ollama.com/v1" },
      profileStore: storeReturning({
        ok: true,
        value: profileWith({ provider: "ollama-cloud", id: "chat:cloud" }),
      }),
      resolveProviderModel: async () => null,
      createProvider: recordingFactory([]),
    });
    expect(await factory.resolveMain(USER)).toMatchObject({ supportsVision: "unknown", supportsTools: "unknown" });
  });

  it("uses Dreamer operator default when no per-user override exists", async () => {
    const built: string[] = [];
    const store = storeReturning({
      ok: true,
      value: profileWith({ provider: "ollama-cloud", id: "chat:cloud" }),
    });
    const factory = createUserModelProvider({
      providerCfg,
      connection: { provider: "ollama-cloud", apiKey: "k", baseUrl: "https://ollama.com/v1" },
      profileStore: store,
      auxiliaryResolver: createAuxiliaryModelResolver({
        activeProvider: "ollama-cloud",
        chatModel: CONFIG_MODEL,
        dreamerModel: "operator-dreamer:cloud",
        attachmentVisionModel: "gemma4:31b-cloud",
        profileStore: store,
      }),
      createProvider: recordingFactory(built),
    });

    await drive(factory.forUser(USER, "dreamer"));
    expect(built).toEqual(["operator-dreamer"]);
  });

  it("normalizes only direct ollama.com requests, including explicit request models", async () => {
    const seen: Array<{ built: string; requested: string | undefined }> = [];
    const make = (baseUrl: string) =>
      createUserModelProvider({
        providerCfg,
        connection: { provider: "ollama-cloud", apiKey: "k", baseUrl },
        profileStore: storeReturning({
          ok: true,
          value: profileWith({ provider: "ollama-cloud", id: "chat:cloud" }),
        }),
        createProvider: (cfg) => ({
          async *stream(req) {
            seen.push({ built: cfg.model, requested: req.model });
            yield { type: "done", finishReason: "stop" };
          },
        }),
      });
    const request = {
      messages: [],
      tools: [],
      signal: new AbortController().signal,
      model: "gemma4:31b-cloud",
    } as never;

    for await (const _ of make("https://ollama.com/v1").forUser(USER).stream(request)) {
      // drained
    }
    for await (const _ of make("http://127.0.0.1:11434/v1").forUser(USER).stream(request)) {
      // drained
    }

    expect(seen).toEqual([
      { built: "chat", requested: "gemma4:31b" },
      { built: "chat:cloud", requested: "gemma4:31b-cloud" },
    ]);
  });
});
