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
import { createUserModelProvider } from "./user-model-provider.js";

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

    expect(built).toEqual(["deepseek-v4-flash:cloud"]);
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

    expect(built).toEqual([CONFIG_MODEL]);
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

    expect(built).toEqual([CONFIG_MODEL]);
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

    expect(built).toEqual(["deepseek-v4-flash:cloud"]);
  });
});
