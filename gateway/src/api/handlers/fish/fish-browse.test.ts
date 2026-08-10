import { describe, expect, it, vi } from "vitest";
import type { VoiceEntry } from "../../../providers/fish/fish-voice-types.js";
import type { TokenService } from "../../../user-auth/token-service.js";
import type { FishBrowseDeps, FishBrowseFetchers } from "./fish-browse.js";
import { handleFishBrowse } from "./fish-browse.js";

const VALID_TOKEN = "valid-token";
const CACHE_TTL_MS = 60_000;

function makeTokens(): Pick<TokenService, "validate"> {
  return {
    validate: async (token) => {
      if (token === VALID_TOKEN) {
        return { ok: true, value: { userId: "test-user", issuedAt: 0, expiresAt: 9999999999 } };
      }
      return { ok: false, error: "signature-invalid" };
    },
  };
}

function makeVoice(id: string, title = "Voice"): VoiceEntry {
  return {
    id,
    title,
    description: "",
    languages: ["en"],
    tags: [],
    coverImageUrl: null,
    previewAudioUrl: null,
    visibility: "public",
    taskCount: 0,
    createdAt: "2026-01-01T00:00:00Z",
  };
}

function makeRequest(path: string, token?: string | null): Request {
  const headers = new Headers();
  if (token != null) headers.set("authorization", `Bearer ${token}`);
  return new Request(`http://localhost${path}`, { method: "GET", headers });
}

function makeFetchers(overrides: Partial<FishBrowseFetchers> = {}): FishBrowseFetchers {
  return {
    fish: vi.fn(async () => ({ ok: true as const, value: { voices: [makeVoice("v1")], hasMore: false } })),
    fishById: vi.fn(async (_cfg: unknown, id: string) => {
      if (id === "v1") return { ok: true as const, value: makeVoice("v1") };
      return { ok: false as const, error: { kind: "not-found" as const } };
    }),
    ...overrides,
  };
}

function makeDeps(overrides: Partial<FishBrowseDeps> = {}): FishBrowseDeps {
  return {
    tokens: makeTokens(),
    fishBrowseEnabled: true,
    fishApiKey: null,
    timeoutMs: 5000,
    cacheTtlMs: CACHE_TTL_MS,
    fetchers: makeFetchers(),
    ...overrides,
  };
}

describe("handleFishBrowse", () => {
  it("rejects a request with no Authorization header", async () => {
    const res = await handleFishBrowse(makeDeps(), makeRequest("/api/v1/providers/voices"));
    expect(res.status).toBe(401);
  });

  it("returns {voices, hasMore, stale} for the default list view", async () => {
    const res = await handleFishBrowse(makeDeps(), makeRequest("/api/v1/providers/voices", VALID_TOKEN));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ voices: [makeVoice("v1")], hasMore: false, stale: false });
  });

  it("bypasses the cache when a title filter is present", async () => {
    const fish = vi.fn(async () => ({ ok: true as const, value: { voices: [makeVoice("v1")], hasMore: false } }));
    const deps = makeDeps({ fetchers: makeFetchers({ fish }) });
    await handleFishBrowse(deps, makeRequest("/api/v1/providers/voices?title=abc", VALID_TOKEN));
    await handleFishBrowse(deps, makeRequest("/api/v1/providers/voices?title=abc", VALID_TOKEN));
    expect(fish).toHaveBeenCalledTimes(2);
  });

  it("hits the cache on a second default-view call", async () => {
    const fish = vi.fn(async () => ({ ok: true as const, value: { voices: [makeVoice("v1")], hasMore: false } }));
    const deps = makeDeps({ fetchers: makeFetchers({ fish }) });
    await handleFishBrowse(deps, makeRequest("/api/v1/providers/voices", VALID_TOKEN));
    await handleFishBrowse(deps, makeRequest("/api/v1/providers/voices", VALID_TOKEN));
    expect(fish).toHaveBeenCalledTimes(1);
  });

  it("falls back to the stale cached value when the upstream fails after expiry", async () => {
    let calls = 0;
    const fish = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return { ok: true as const, value: { voices: [makeVoice("v1")], hasMore: false } };
      return { ok: false as const, error: { kind: "fetch-error" as const, status: 500 } };
    });
    // 1ms TTL so the second call sees an expired (but still stale-readable) entry.
    const deps = makeDeps({ fetchers: makeFetchers({ fish }), cacheTtlMs: 1 });
    const first = await handleFishBrowse(deps, makeRequest("/api/v1/providers/voices", VALID_TOKEN));
    expect(first.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = await handleFishBrowse(deps, makeRequest("/api/v1/providers/voices", VALID_TOKEN));
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ voices: [makeVoice("v1")], hasMore: false, stale: true });
    expect(fish).toHaveBeenCalledTimes(2);
  });

  it("returns {voice} for a known id", async () => {
    const res = await handleFishBrowse(makeDeps(), makeRequest("/api/v1/providers/voices/v1", VALID_TOKEN));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ voice: makeVoice("v1") });
  });

  it("returns 404 for an unknown id", async () => {
    const res = await handleFishBrowse(makeDeps(), makeRequest("/api/v1/providers/voices/unknown", VALID_TOKEN));
    expect(res.status).toBe(404);
  });

  it("returns 404 for every route when fishBrowseEnabled is false", async () => {
    const deps = makeDeps({ fishBrowseEnabled: false });
    const list = await handleFishBrowse(deps, makeRequest("/api/v1/providers/voices", VALID_TOKEN));
    expect(list.status).toBe(404);
    const byId = await handleFishBrowse(deps, makeRequest("/api/v1/providers/voices/v1", VALID_TOKEN));
    expect(byId.status).toBe(404);
    // Gate wins over auth — no bearer token needed to observe the 404.
    const noAuth = await handleFishBrowse(deps, makeRequest("/api/v1/providers/voices"));
    expect(noAuth.status).toBe(404);
  });
});
