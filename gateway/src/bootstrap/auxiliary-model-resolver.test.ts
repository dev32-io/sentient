import { describe, expect, it } from "bun:test";
import type { Result } from "@sentient/protocol";
import type { ProfileStore, ProfileStoreError } from "../profile-store/profile-store.js";
import type { ModelRef, ProfileV1 } from "../profile-store/profile-types.js";
import type { ModelEntry } from "../providers/catalogs/types.js";
import { createAuxiliaryModelResolver } from "./auxiliary-model-resolver.js";

const USER = "u_test";
const ATTACHMENT_MODEL = "gemma4:31b-cloud";

function profile(model: ModelRef, auxiliaryModels?: ProfileV1["auxiliaryModels"]): ProfileV1 {
  return { userId: USER, model, auxiliaryModels } as ProfileV1;
}

function storeReturning(result: Result<ProfileV1, ProfileStoreError>): ProfileStore {
  return {
    get: async () => result,
    save: async () => ({ ok: true, value: undefined }),
    remove: async () => ({ ok: true, value: undefined }),
  };
}

function model(id: string, supportsVision: boolean, provider: ModelEntry["provider"] = "ollama-cloud"): ModelEntry {
  return { id, provider, supportsVision } as ModelEntry;
}

function resolver(
  value: ProfileV1 | undefined,
  models: readonly ModelEntry[] = [model(ATTACHMENT_MODEL, true)],
  activeProvider: ModelRef["provider"] = "ollama-cloud",
) {
  return createAuxiliaryModelResolver({
    activeProvider,
    chatModel: "operator-chat",
    dreamerModel: "operator-dreamer",
    attachmentVisionModel: ATTACHMENT_MODEL,
    profileStore: storeReturning(value ? { ok: true, value } : { ok: false, error: "not-found" }),
    listModels: async () => ({ ok: true, value: models }),
  });
}

describe("auxiliary model resolution", () => {
  it("uses overrides before workload defaults", async () => {
    const r = resolver(
      profile(
        { provider: "ollama-cloud", id: "user-chat" },
        {
          title: { provider: "ollama-cloud", id: "title-model" },
          dreamer: { provider: "ollama-cloud", id: "dream-model" },
        },
      ),
    );

    expect(await r.resolve(USER, "title")).toEqual({
      ok: true,
      value: { ref: { provider: "ollama-cloud", id: "title-model" }, source: "user-override" },
    });
    expect(await r.resolve(USER, "dreamer")).toEqual({
      ok: true,
      value: { ref: { provider: "ollama-cloud", id: "dream-model" }, source: "user-override" },
    });
  });

  it("inherits titles from current user chat and Dreamer from operator default", async () => {
    const r = resolver(profile({ provider: "ollama-cloud", id: "user-chat" }));

    expect(await r.resolve(USER, "title")).toEqual({
      ok: true,
      value: { ref: { provider: "ollama-cloud", id: "user-chat" }, source: "user-chat" },
    });
    expect(await r.resolve(USER, "dreamer")).toEqual({
      ok: true,
      value: { ref: { provider: "ollama-cloud", id: "operator-dreamer" }, source: "operator-default" },
    });
  });

  it("defaults attachment vision to Gemma 4 only on active Ollama Cloud", async () => {
    expect(await resolver(undefined).resolve(USER, "attachmentVision")).toEqual({
      ok: true,
      value: {
        ref: { provider: "ollama-cloud", id: ATTACHMENT_MODEL },
        source: "operator-default",
      },
    });
    expect(await resolver(undefined, [], "openrouter").resolve(USER, "attachmentVision")).toEqual({
      ok: false,
      error: "no-default",
    });
  });

  it("refuses wrong-provider overrides rather than sending their id to the active endpoint", async () => {
    const r = resolver(
      profile({ provider: "ollama-cloud", id: "user-chat" }, { title: { provider: "openrouter", id: "vendor/title" } }),
    );
    expect(await r.resolve(USER, "title")).toEqual({ ok: false, error: "provider-mismatch" });
  });

  it("requires catalog proof that attachment model supports vision", async () => {
    const selected = profile(
      { provider: "ollama-cloud", id: "user-chat" },
      { attachmentVision: { provider: "ollama-cloud", id: "custom-id" } },
    );

    expect(await resolver(selected, []).resolve(USER, "attachmentVision")).toEqual({
      ok: false,
      error: "model-not-found",
    });
    expect(await resolver(selected, [model("custom-id", false)]).resolve(USER, "attachmentVision")).toEqual({
      ok: false,
      error: "vision-unsupported",
    });
  });

  it("does not assume vision support when no catalog is wired", async () => {
    const r = createAuxiliaryModelResolver({
      activeProvider: "ollama-cloud",
      chatModel: "chat",
      dreamerModel: "dreamer",
      attachmentVisionModel: ATTACHMENT_MODEL,
      profileStore: storeReturning({ ok: false, error: "not-found" }),
    });
    expect(await r.resolve(USER, "attachmentVision")).toEqual({ ok: false, error: "catalog-unavailable" });
  });
});
