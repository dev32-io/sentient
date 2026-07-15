import type { Result } from "@sentient/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProfileStore, ProfileStoreError } from "../../../profile-store/profile-store.js";
import type { ProfileV1 } from "../../../profile-store/profile-types.js";
import type { FishFetchError } from "../../../providers/fish/fish-fetcher.js";
import type { VoiceEntry } from "../../../providers/fish/fish-voice-types.js";
import type { VoiceMgmtSocketFactory } from "../../../providers/tts/voice-mgmt-client.js";
import type { TokenPayload, TokenResult } from "../../../user-auth/types.js";
import { createProvidersHandler } from "../providers.js";
import type { FishCloneDeps, FishCloneFetchers } from "./fish-clone.js";
import { handleFishClone } from "./fish-clone.js";

// ---------------------------------------------------------------------------
// FakeWebSocket — minimal scriptable WS for the mock ChatterboxTTSService,
// copied from voices.test.ts's pattern. Injected via deps.socketFactory — the
// handler (through voice-mgmt-client) never calls `new WebSocket()` itself.
// ---------------------------------------------------------------------------

interface FakeWebSocket {
  readyState: number;
  binaryType?: string;
  onopen: ((ev: Event) => void) | null;
  onmessage: ((ev: MessageEvent<string | ArrayBuffer>) => void) | null;
  onclose: ((ev: CloseEvent) => void) | null;
  onerror: ((ev: Event) => void) | null;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  _openHandshake(): void;
  _receiveText(msg: object): void;
}

function makeFakeWebSocket(): FakeWebSocket {
  const ws: FakeWebSocket = {
    readyState: 0, // CONNECTING
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    send: vi.fn(),
    close: vi.fn(() => {
      ws.readyState = 3; // CLOSED
      ws.onclose?.({ code: 1000, reason: "", wasClean: true } as CloseEvent);
    }),
    _openHandshake() {
      ws.readyState = 1; // OPEN
      ws.onopen?.({} as Event);
    },
    _receiveText(msg: object) {
      ws.onmessage?.({ data: JSON.stringify(msg) } as MessageEvent<string>);
    },
  };
  return ws;
}

function makeSocketFactory(): { factory: VoiceMgmtSocketFactory; getWs: () => FakeWebSocket | null } {
  let ws: FakeWebSocket | null = null;
  const factory = (_url: string) => {
    ws = makeFakeWebSocket();
    return ws as unknown as WebSocket;
  };
  return { factory, getWs: () => ws };
}

async function waitForSocket(getWs: () => FakeWebSocket | null): Promise<FakeWebSocket> {
  for (let i = 0; i < 50; i++) {
    const ws = getWs();
    if (ws) return ws;
    await Promise.resolve();
  }
  throw new Error("socket was never created");
}

async function autoReply(getWs: () => FakeWebSocket | null, msg: object): Promise<FakeWebSocket> {
  const ws = await waitForSocket(getWs);
  ws._openHandshake();
  ws._receiveText(msg);
  return ws;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_VOICE_ID = "3f9bd0e1a2b3c4d5e6f7081920313243";
const PREVIEW_URL = "https://cdn.fish.audio/samples/v1.mp3";
const SAMPLE_BYTES = new Uint8Array([1, 2, 3, 4, 5]);

function makeFishVoice(overrides: Partial<VoiceEntry> = {}): VoiceEntry {
  return {
    id: "v1",
    title: "Fish Voice",
    description: "",
    languages: ["en"],
    tags: [],
    coverImageUrl: null,
    previewAudioUrl: PREVIEW_URL,
    visibility: "public",
    taskCount: 0,
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeFetchers(overrides: Partial<FishCloneFetchers> = {}): FishCloneFetchers {
  return {
    fishById: vi.fn(async (): Promise<Result<VoiceEntry, FishFetchError>> => ({ ok: true, value: makeFishVoice() })),
    ...overrides,
  };
}

function sampleProfile(userId = "alice", voiceId = "old-voice"): ProfileV1 {
  return {
    schemaVersion: 1,
    userId,
    model: { provider: "openrouter", id: "google/gemini-2.5-flash" },
    voice: { provider: "local-tts", id: voiceId },
    audio: { ttsEnabled: true, channel: "voice" as const },
    persona: { template: "default", overrides: "" },
    tools: { enabled: {} },
    compression: { threshold: 0.5 },
    advanced: { extraSystemPrompt: "", maxTokens: 1024, reasoningEffort: "minimal" },
  };
}

function makeProfileStore(profile: ProfileV1 = sampleProfile()): ProfileStore {
  return {
    get: vi.fn(async (): Promise<Result<ProfileV1, ProfileStoreError>> => ({ ok: true, value: profile })),
    save: vi.fn(async (): Promise<Result<void, ProfileStoreError>> => ({ ok: true, value: undefined })),
    remove: vi.fn(async (): Promise<Result<void, ProfileStoreError>> => ({ ok: true, value: undefined })),
  };
}

function makeDeps(overrides: Partial<FishCloneDeps> = {}): {
  deps: FishCloneDeps;
  getWs: () => FakeWebSocket | null;
} {
  const { factory, getWs } = makeSocketFactory();
  const deps: FishCloneDeps = {
    fishBrowseEnabled: true,
    fishApiKey: null,
    externalFetchTimeoutMs: 5000,
    profileStore: makeProfileStore(),
    refreshVoice: vi.fn(async () => undefined),
    ttsUrl: "ws://host.docker.internal:8770",
    connectTimeoutMs: 1000,
    opTimeoutMs: 1000,
    descriptionMaxLen: 240,
    tagMaxLen: 24,
    maxTags: 8,
    socketFactory: factory,
    fetchers: makeFetchers(),
    ...overrides,
  };
  return { deps, getWs };
}

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/v1/providers/voices/v1/clone", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// biome-ignore lint/suspicious/noExplicitAny: vitest fetch spy generic (mirrors fish-fetcher.test.ts)
let fetchSpy: any;

function stubDownloadFetch(bytes: Uint8Array, ok = true): ReturnType<typeof vi.fn> {
  fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
    ok,
    arrayBuffer: async () => bytes.buffer,
  } as Response);
  return fetchSpy;
}

afterEach(() => {
  fetchSpy?.mockRestore();
});

describe("handleFishClone", () => {
  it("downloads the preview sample, creates the voice, and activates it", async () => {
    const fetchFn = stubDownloadFetch(SAMPLE_BYTES);
    const { deps, getWs } = makeDeps();

    const responsePromise = handleFishClone(
      deps,
      "alice",
      "v1",
      makeRequest({ name: "Dad", description: "Warm", tags: ["family"] }),
    );
    const ws = await autoReply(getWs, {
      type: "voice.created",
      voiceId: VALID_VOICE_ID,
      name: "Dad",
      createdAt: 1752400000.0,
    });
    const response = await responsePromise;

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ voiceId: VALID_VOICE_ID, name: "Dad" });

    expect(fetchFn).toHaveBeenCalledWith(PREVIEW_URL, expect.objectContaining({ signal: expect.anything() }));
    expect(JSON.parse(ws.send.mock.calls[0]?.[0])).toEqual({
      type: "voice.create",
      name: "Dad",
      description: "Warm",
      tags: ["family"],
    });
    const sentBytes = new Uint8Array(ws.send.mock.calls[1]?.[0] as ArrayBuffer);
    expect(sentBytes).toEqual(SAMPLE_BYTES);
  });

  it("returns 422 no-preview-sample when the Fish voice has no preview clip", async () => {
    const { deps } = makeDeps({
      fetchers: makeFetchers({
        fishById: vi.fn(async () => ({ ok: true as const, value: makeFishVoice({ previewAudioUrl: null }) })),
      }),
    });

    const response = await handleFishClone(deps, "alice", "v1", makeRequest({ name: "Dad" }));

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "no-preview-sample" });
  });

  it("surfaces a service clip-too-short rejection as 422, not 500", async () => {
    stubDownloadFetch(SAMPLE_BYTES);
    const { deps, getWs } = makeDeps();

    const responsePromise = handleFishClone(deps, "alice", "v1", makeRequest({ name: "Dad" }));
    await autoReply(getWs, { type: "error", reason: "clip too short" });
    const response = await responsePromise;

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "voice-op-failed", reason: "clip too short" });
  });

  it("rejects over-cap tags with 422 before any Fish fetch", async () => {
    const fishById = vi.fn(async () => ({ ok: true as const, value: makeFishVoice() }));
    const { deps } = makeDeps({ maxTags: 2, fetchers: makeFetchers({ fishById }) });

    const response = await handleFishClone(deps, "alice", "v1", makeRequest({ name: "Dad", tags: ["a", "b", "c"] }));

    expect(response.status).toBe(422);
    expect((await response.json()).error).toBe("invalid-request");
    expect(fishById).not.toHaveBeenCalled();
  });

  it("returns 404 when fishBrowseEnabled is false, without reading the body", async () => {
    const fishById = vi.fn(async () => ({ ok: true as const, value: makeFishVoice() }));
    const { deps } = makeDeps({ fishBrowseEnabled: false, fetchers: makeFetchers({ fishById }) });

    const response = await handleFishClone(deps, "alice", "v1", makeRequest({ name: "Dad" }));

    expect(response.status).toBe(404);
    expect(fishById).not.toHaveBeenCalled();
  });

  it("returns 404 voice-not-found when the Fish voice does not exist", async () => {
    const { deps } = makeDeps({
      fetchers: makeFetchers({
        fishById: vi.fn(async () => ({ ok: false as const, error: { kind: "not-found" as const } })),
      }),
    });

    const response = await handleFishClone(deps, "alice", "unknown", makeRequest({ name: "Dad" }));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "voice-not-found" });
  });

  it("returns 502 preview-download-failed when the mp3 download fails", async () => {
    stubDownloadFetch(SAMPLE_BYTES, false);
    const { deps } = makeDeps();

    const response = await handleFishClone(deps, "alice", "v1", makeRequest({ name: "Dad" }));

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "preview-download-failed" });
  });

  it("allows a Cloudflare R2 preview host (Fish's real CDN) and proceeds to download + create", async () => {
    const fetchFn = stubDownloadFetch(SAMPLE_BYTES);
    const { deps, getWs } = makeDeps({
      fetchers: makeFetchers({
        fishById: vi.fn(async () => ({
          ok: true as const,
          value: makeFishVoice({ previewAudioUrl: "https://abc123.r2.cloudflarestorage.com/samples/v1.mp3" }),
        })),
      }),
    });

    const responsePromise = handleFishClone(deps, "alice", "v1", makeRequest({ name: "Dad" }));
    await autoReply(getWs, { type: "voice.created", voiceId: VALID_VOICE_ID, name: "Dad", createdAt: 1.0 });
    const response = await responsePromise;

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ voiceId: VALID_VOICE_ID, name: "Dad" });
    expect(fetchFn).toHaveBeenCalledWith(
      "https://abc123.r2.cloudflarestorage.com/samples/v1.mp3",
      expect.objectContaining({ signal: expect.anything() }),
    );
  });

  it.each([
    ["localhost loopback", "http://localhost/internal/secret"],
    ["an arbitrary non-listed host", "https://evil.example.com/x.mp3"],
  ])("rejects %s as a preview host (SSRF guard) without downloading it", async (_label, previewAudioUrl) => {
    const fetchFn = stubDownloadFetch(SAMPLE_BYTES);
    const { deps } = makeDeps({
      fetchers: makeFetchers({
        fishById: vi.fn(async () => ({ ok: true as const, value: makeFishVoice({ previewAudioUrl }) })),
      }),
    });

    const response = await handleFishClone(deps, "alice", "v1", makeRequest({ name: "Dad" }));

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "preview-host-not-allowed" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("returns 422 invalid-request when name is missing, without downloading anything", async () => {
    const fetchFn = stubDownloadFetch(SAMPLE_BYTES);
    const { deps } = makeDeps();

    const response = await handleFishClone(deps, "alice", "v1", makeRequest({ name: "   " }));

    expect(response.status).toBe(422);
    expect((await response.json()).error).toBe("invalid-request");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("keeps the voiceId and returns a warning when activation fails", async () => {
    stubDownloadFetch(SAMPLE_BYTES);
    const profileStore = makeProfileStore();
    profileStore.get = vi.fn(
      async (): Promise<Result<ProfileV1, ProfileStoreError>> => ({ ok: false, error: "io-error" }),
    );
    const { deps, getWs } = makeDeps({ profileStore });

    const responsePromise = handleFishClone(deps, "alice", "v1", makeRequest({ name: "Dad" }));
    await autoReply(getWs, { type: "voice.created", voiceId: VALID_VOICE_ID, name: "Dad", createdAt: 1.0 });
    const response = await responsePromise;

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ voiceId: VALID_VOICE_ID, name: "Dad", warning: "not-activated" });
  });
});

describe("POST /api/v1/providers/voices/:id/clone (mount)", () => {
  function makeCloneRequest(bearerToken?: string | null): Request {
    const headers = new Headers({ "content-type": "application/json" });
    if (bearerToken != null) headers.set("authorization", `Bearer ${bearerToken}`);
    return new Request("http://localhost/api/v1/providers/voices/v1/clone", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Dad" }),
    });
  }

  it("returns 401 when the bearer token is missing (enabled route)", async () => {
    const { deps } = makeDeps();
    const handler = createProvidersHandler({
      tokens: {
        validate: vi.fn(async (): Promise<TokenResult<TokenPayload>> => ({ ok: false, error: "signature-invalid" })),
      },
      listModels: vi.fn(async () => ({ ok: true as const, value: [] })),
      fishCloneDeps: deps,
    });

    const response = await handler(makeCloneRequest(null));

    expect(response.status).toBe(401);
  });

  it("returns 404 (not 401) for a disabled clone route with no bearer — gate wins over auth", async () => {
    const { deps } = makeDeps({ fishBrowseEnabled: false });
    const handler = createProvidersHandler({
      tokens: {
        validate: vi.fn(async (): Promise<TokenResult<TokenPayload>> => ({ ok: false, error: "signature-invalid" })),
      },
      listModels: vi.fn(async () => ({ ok: true as const, value: [] })),
      fishCloneDeps: deps,
    });

    const response = await handler(makeCloneRequest(null));

    expect(response.status).toBe(404);
  });

  it("routes an authenticated request through to handleFishClone", async () => {
    stubDownloadFetch(SAMPLE_BYTES);
    const { deps, getWs } = makeDeps();
    const handler = createProvidersHandler({
      tokens: {
        validate: vi.fn(
          async (): Promise<TokenResult<TokenPayload>> => ({
            ok: true,
            value: { userId: "alice", isAdmin: false, issuedAt: 0, expiresAt: 9999999999 },
          }),
        ),
      },
      listModels: vi.fn(async () => ({ ok: true as const, value: [] })),
      fishCloneDeps: deps,
    });

    const responsePromise = handler(makeCloneRequest("valid-token"));
    await autoReply(getWs, { type: "voice.created", voiceId: VALID_VOICE_ID, name: "Dad", createdAt: 1.0 });
    const response = await responsePromise;

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ voiceId: VALID_VOICE_ID, name: "Dad" });
  });
});
