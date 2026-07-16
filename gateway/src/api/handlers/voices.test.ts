import type { Result } from "@sentient/protocol";
import { describe, expect, it, vi } from "vitest";
import type { ProfileStore, ProfileStoreError } from "../../profile-store/profile-store.js";
import type { ProfileV1 } from "../../profile-store/profile-types.js";
import type { VoiceMgmtSocketFactory } from "../../providers/tts/voice-mgmt-client.js";
import type { TokenPayload, TokenResult } from "../../user-auth/types.js";
import { type VoicesHandlerDeps, createVoicesHandler } from "./voices.js";

// ---------------------------------------------------------------------------
// FakeWebSocket — minimal scriptable WS for the mock LocalTTSService.
// Mirrors the pattern used in local-tts-provider.test.ts. Injected via
// deps.socketFactory — the handler (through voice-mgmt-client) never calls
// `new WebSocket()` itself, so no real socket or filesystem is touched.
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
  _receiveBinary(bytes: Uint8Array): void;
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
    _receiveBinary(bytes: Uint8Array) {
      ws.onmessage?.({ data: bytes.buffer } as MessageEvent<ArrayBuffer>);
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

/** Polls the microtask queue until the handler has opened a socket (formData /
 *  blob.arrayBuffer() parsing takes a few ticks before voice-mgmt-client
 *  constructs the WS) — bounded so a genuine "never opens" bug fails fast
 *  instead of hanging. */
async function waitForSocket(getWs: () => FakeWebSocket | null): Promise<FakeWebSocket> {
  for (let i = 0; i < 50; i++) {
    const ws = getWs();
    if (ws) return ws;
    await Promise.resolve();
  }
  throw new Error("socket was never created");
}

/** Opens the fake socket and immediately replies with `msg` — the sequence
 *  every handler op follows once connected (connect -> send -> one reply). */
async function autoReply(getWs: () => FakeWebSocket | null, msg: object): Promise<FakeWebSocket> {
  const ws = await waitForSocket(getWs);
  ws._openHandshake();
  ws._receiveText(msg);
  return ws;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function sampleProfile(userId = "alice", voiceId = "voice-abc"): ProfileV1 {
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

function makeTokens(userId = "alice") {
  return {
    validate: vi.fn(
      async (): Promise<TokenResult<TokenPayload>> => ({
        ok: true,
        value: { userId, isAdmin: false, issuedAt: 0, expiresAt: 9999999999 },
      }),
    ),
  };
}

function makeInvalidTokens() {
  return {
    validate: vi.fn(async (): Promise<TokenResult<TokenPayload>> => ({ ok: false, error: "signature-invalid" })),
  };
}

function makeProfileStore(profile: ProfileV1 = sampleProfile()): ProfileStore {
  return {
    get: vi.fn(async (): Promise<Result<ProfileV1, ProfileStoreError>> => ({ ok: true, value: profile })),
    save: vi.fn(async (): Promise<Result<void, ProfileStoreError>> => ({ ok: true, value: undefined })),
    remove: vi.fn(async (): Promise<Result<void, ProfileStoreError>> => ({ ok: true, value: undefined })),
  };
}

/** A profileStore whose `get` succeeds (so callers can determine what would be
 *  written) but whose `save` fails — pins the partial-failure invariant: the TTS
 *  service already committed the primary op, so a save failure must degrade to a
 *  200+warning, never a 500 or a dropped voiceId. */
function makeProfileStoreWithFailingSave(profile: ProfileV1, error: ProfileStoreError = "io-error"): ProfileStore {
  return {
    get: vi.fn(async (): Promise<Result<ProfileV1, ProfileStoreError>> => ({ ok: true, value: profile })),
    save: vi.fn(async (): Promise<Result<void, ProfileStoreError>> => ({ ok: false, error })),
    remove: vi.fn(async (): Promise<Result<void, ProfileStoreError>> => ({ ok: true, value: undefined })),
  };
}

/** A profileStore whose `get` always fails — used to pin the "can't tell whether a
 *  reset is owed" DELETE path, which stays a plain 200 (no warning, no save call). */
function makeProfileStoreWithFailingGet(error: ProfileStoreError = "io-error"): ProfileStore {
  return {
    get: vi.fn(async (): Promise<Result<ProfileV1, ProfileStoreError>> => ({ ok: false, error })),
    save: vi.fn(async (): Promise<Result<void, ProfileStoreError>> => ({ ok: true, value: undefined })),
    remove: vi.fn(async (): Promise<Result<void, ProfileStoreError>> => ({ ok: true, value: undefined })),
  };
}

function makeDeps(overrides: Partial<VoicesHandlerDeps> = {}): {
  deps: VoicesHandlerDeps;
  getWs: () => FakeWebSocket | null;
} {
  const { factory, getWs } = makeSocketFactory();
  const deps: VoicesHandlerDeps = {
    tokens: makeTokens(),
    profileStore: makeProfileStore(),
    refreshVoice: vi.fn(async () => undefined),
    ttsUrl: "ws://host.docker.internal:8770",
    connectTimeoutMs: 1000,
    opTimeoutMs: 1000,
    previewGreetings: { en: ["Hi, I'm your family's Sentient assistant."] },
    previewTimeoutMs: 1000,
    descriptionMaxLen: 240,
    tagMaxLen: 24,
    maxTags: 8,
    socketFactory: factory,
    ...overrides,
  };
  return { deps, getWs };
}

// `null` (never `undefined`) means "omit the header" — a default *parameter*
// can't distinguish an explicit `undefined` argument from an omitted one, so
// callers that want the happy-path token rely on the default and callers
// testing the missing-token path pass `null` explicitly.
function authHeaders(bearerToken: string | null = "valid-token"): Headers {
  const headers = new Headers();
  if (bearerToken !== null) headers.set("authorization", `Bearer ${bearerToken}`);
  return headers;
}

function makeGetRequest(bearerToken?: string | null): Request {
  return new Request("http://localhost/api/v1/voices", { method: "GET", headers: authHeaders(bearerToken) });
}

function makePostRequest(form: FormData, bearerToken?: string | null): Request {
  return new Request("http://localhost/api/v1/voices", {
    method: "POST",
    headers: authHeaders(bearerToken),
    body: form,
  });
}

function makeCreateForm(name = "Dad", audioBytes = new Uint8Array([1, 2, 3, 4])): FormData {
  const form = new FormData();
  form.set("name", name);
  form.set("audio", new Blob([audioBytes], { type: "audio/wav" }), "ref.wav");
  return form;
}

function makeDeleteRequest(voiceId: string, bearerToken?: string | null): Request {
  return new Request(`http://localhost/api/v1/voices/${voiceId}`, {
    method: "DELETE",
    headers: authHeaders(bearerToken),
  });
}

function makePreviewRequest(voiceId: string, bearerToken?: string | null): Request {
  return new Request(`http://localhost/api/v1/voices/${voiceId}/preview`, {
    method: "POST",
    headers: authHeaders(bearerToken),
  });
}

const VALID_VOICE_ID = "3f9bd0e1a2b3c4d5e6f7081920313243";

describe("GET /api/v1/voices", () => {
  it("returns the service's voice.list reply as {voices:[...]}", async () => {
    const { deps, getWs } = makeDeps();
    const handler = createVoicesHandler(deps);

    const responsePromise = handler(makeGetRequest());
    await autoReply(getWs, {
      type: "voice.list",
      voices: [
        {
          voiceId: VALID_VOICE_ID,
          name: "Dad",
          description: "Warm, low register",
          tags: ["family", "warm"],
          source: "user",
          createdAt: 1752400000.0,
          refDurationMs: 12000,
        },
      ],
    });
    const response = await responsePromise;

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      voices: [
        {
          voiceId: VALID_VOICE_ID,
          name: "Dad",
          description: "Warm, low register",
          tags: ["family", "warm"],
          source: "user",
          createdAt: 1752400000.0,
          refDurationMs: 12000,
          language: "",
        },
      ],
    });
  });

  it("returns 401 when the bearer token is missing or invalid", async () => {
    const { deps: missingDeps } = makeDeps();
    const missingResponse = await createVoicesHandler(missingDeps)(makeGetRequest(null));
    expect(missingResponse.status).toBe(401);

    const { deps: invalidDeps } = makeDeps({ tokens: makeInvalidTokens() });
    const invalidResponse = await createVoicesHandler(invalidDeps)(makeGetRequest("bad-token"));
    expect(invalidResponse.status).toBe(401);
  });
});

describe("POST /api/v1/voices", () => {
  it("sends a voice.create JSON frame plus a following binary frame, activates the voice on success", async () => {
    const profile = sampleProfile("alice", "old-voice");
    const profileStore = makeProfileStore(profile);
    const { deps, getWs } = makeDeps({ profileStore });
    const handler = createVoicesHandler(deps);

    const responsePromise = handler(makePostRequest(makeCreateForm("Dad")));
    const ws = await autoReply(getWs, {
      type: "voice.created",
      voiceId: VALID_VOICE_ID,
      name: "Dad",
      createdAt: 1752400000.0,
    });
    const response = await responsePromise;

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ voiceId: VALID_VOICE_ID, name: "Dad" });

    // First send is the JSON voice.create control frame, second is the raw binary WAV.
    // No description/tags were set on the form, so both go through as empty defaults.
    expect(ws.send).toHaveBeenCalledTimes(2);
    expect(JSON.parse(ws.send.mock.calls[0]?.[0])).toEqual({
      type: "voice.create",
      name: "Dad",
      description: "",
      tags: [],
      language: "",
    });
    expect(ws.send.mock.calls[1]?.[0]).toBeInstanceOf(ArrayBuffer);

    expect(profileStore.save).toHaveBeenCalledWith(
      expect.objectContaining({ voice: { provider: "local-tts", id: VALID_VOICE_ID } }),
    );
    expect(deps.refreshVoice).toHaveBeenCalledWith("alice");
  });

  it("POST create forwards description and tags", async () => {
    const { deps, getWs } = makeDeps();
    const form = makeCreateForm("Dad");
    form.set("description", "Warm, low register");
    form.append("tags", "family");
    form.append("tags", "warm");

    const responsePromise = createVoicesHandler(deps)(makePostRequest(form));
    const ws = await autoReply(getWs, {
      type: "voice.created",
      voiceId: VALID_VOICE_ID,
      name: "Dad",
      createdAt: 1752400000.0,
    });
    await responsePromise;

    expect(JSON.parse(ws.send.mock.calls[0]?.[0])).toEqual({
      type: "voice.create",
      name: "Dad",
      description: "Warm, low register",
      tags: ["family", "warm"],
      language: "",
    });
  });

  it("POST create normalizes and forwards a supported language", async () => {
    const { deps, getWs } = makeDeps();
    const form = makeCreateForm("Dad");
    form.set("language", "ZH");

    const responsePromise = createVoicesHandler(deps)(makePostRequest(form));
    const ws = await autoReply(getWs, {
      type: "voice.created",
      voiceId: VALID_VOICE_ID,
      name: "Dad",
      createdAt: 1752400000.0,
    });
    await responsePromise;

    expect(JSON.parse(ws.send.mock.calls[0]?.[0])).toEqual({
      type: "voice.create",
      name: "Dad",
      description: "",
      tags: [],
      language: "zh",
    });
  });

  it("POST create clamps over-cap tags to maxTags instead of rejecting", async () => {
    const { deps, getWs } = makeDeps({ maxTags: 2 });
    const form = makeCreateForm("Dad");
    form.append("tags", "a");
    form.append("tags", "b");
    form.append("tags", "c");

    const responsePromise = createVoicesHandler(deps)(makePostRequest(form));
    const ws = await autoReply(getWs, {
      type: "voice.created",
      voiceId: VALID_VOICE_ID,
      name: "Dad",
      createdAt: 1752400000.0,
    });
    await responsePromise;

    expect(JSON.parse(ws.send.mock.calls[0]?.[0]).tags).toEqual(["a", "b"]);
  });

  it("returns 422 invalid-request when name is missing/empty, without opening a WS", async () => {
    const { deps, getWs } = makeDeps();
    const form = new FormData();
    form.set("name", "   ");
    form.set("audio", new Blob([new Uint8Array([1, 2])]));

    const response = await createVoicesHandler(deps)(makePostRequest(form));

    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body.error).toBe("invalid-request");
    expect(getWs()).toBeNull();
  });

  it("returns 422 invalid-request when audio is missing, without opening a WS", async () => {
    const { deps, getWs } = makeDeps();
    const form = new FormData();
    form.set("name", "Dad");

    const response = await createVoicesHandler(deps)(makePostRequest(form));

    expect(response.status).toBe(422);
    expect(getWs()).toBeNull();
  });

  it("returns 422 voice-op-failed when the service replies error (bad/short clip)", async () => {
    const { deps, getWs } = makeDeps();
    const responsePromise = createVoicesHandler(deps)(makePostRequest(makeCreateForm()));
    await autoReply(getWs, { type: "error", reason: "clip too short" });
    const response = await responsePromise;

    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body).toEqual({ error: "voice-op-failed", reason: "clip too short" });
  });

  it("returns 504 voice-op-timeout when the service never replies", async () => {
    vi.useFakeTimers();
    try {
      const { deps, getWs } = makeDeps({ opTimeoutMs: 50 });
      const responsePromise = createVoicesHandler(deps)(makePostRequest(makeCreateForm()));
      const ws = await waitForSocket(getWs);
      ws._openHandshake(); // cancels the connect timer, arms the 50ms op timer
      vi.advanceTimersByTime(60);
      const response = await responsePromise;

      expect(response.status).toBe(504);
      const body = await response.json();
      expect(body.error).toBe("voice-op-timeout");
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns 401 when bearer token is missing", async () => {
    const { deps } = makeDeps();
    const response = await createVoicesHandler(deps)(makePostRequest(makeCreateForm(), null));
    expect(response.status).toBe(401);
  });

  it("returns 200 voiceId + not-activated warning when the service create succeeds but the profile save fails", async () => {
    const profile = sampleProfile("alice", "old-voice");
    const profileStore = makeProfileStoreWithFailingSave(profile);
    const { deps, getWs } = makeDeps({ profileStore });

    const responsePromise = createVoicesHandler(deps)(makePostRequest(makeCreateForm("Dad")));
    await autoReply(getWs, {
      type: "voice.created",
      voiceId: VALID_VOICE_ID,
      name: "Dad",
      createdAt: 1752400000.0,
    });
    const response = await responsePromise;

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ voiceId: VALID_VOICE_ID, name: "Dad", warning: "not-activated" });
    expect(deps.refreshVoice).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/v1/voices/:id", () => {
  it("resets profile.voice.id to 'default' when deleting the active voice", async () => {
    const profile = sampleProfile("alice", VALID_VOICE_ID);
    const profileStore = makeProfileStore(profile);
    const { deps, getWs } = makeDeps({ profileStore });

    const responsePromise = createVoicesHandler(deps)(makeDeleteRequest(VALID_VOICE_ID));
    await autoReply(getWs, { type: "voice.deleted", voiceId: VALID_VOICE_ID });
    const response = await responsePromise;

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ voiceId: VALID_VOICE_ID });
    expect(profileStore.save).toHaveBeenCalledWith(
      expect.objectContaining({ voice: { provider: "local-tts", id: "default" } }),
    );
    expect(deps.refreshVoice).toHaveBeenCalledWith("alice");
  });

  it("leaves the profile unchanged when deleting a non-active voice", async () => {
    const profile = sampleProfile("alice", "some-other-voice");
    const profileStore = makeProfileStore(profile);
    const { deps, getWs } = makeDeps({ profileStore });

    const responsePromise = createVoicesHandler(deps)(makeDeleteRequest(VALID_VOICE_ID));
    await autoReply(getWs, { type: "voice.deleted", voiceId: VALID_VOICE_ID });
    const response = await responsePromise;

    expect(response.status).toBe(200);
    expect(profileStore.save).not.toHaveBeenCalled();
    expect(deps.refreshVoice).not.toHaveBeenCalled();
  });

  it("returns 422 invalid-voice-id for a structurally-invalid id, without opening a WS", async () => {
    const { deps, getWs } = makeDeps();

    // Uppercase + underscore fall outside the widened [a-z0-9-]{1,32} shape
    // (hex OR built-in slug) — still rejected pre-service, same as an
    // over-length id or a traversal-shaped one.
    const response = await createVoicesHandler(deps)(makeDeleteRequest("Not_A_Valid-ID"));

    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body.error).toBe("invalid-voice-id");
    expect(getWs()).toBeNull();
  });

  it("rejects a malformed percent-encoding with 422 (not 500), without opening a WS", async () => {
    const { deps, getWs } = makeDeps();

    // `%ZZ` is invalid percent-encoding — decodeURIComponent throws; the handler
    // must degrade to a clean 422, never let a URIError bubble to a 500.
    const request = new Request("http://localhost/api/v1/voices/%ZZ", {
      method: "DELETE",
      headers: authHeaders(),
    });
    const response = await createVoicesHandler(deps)(request);

    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body.error).toBe("invalid-voice-id");
    expect(getWs()).toBeNull();
  });

  it("DELETE accepts a slug id shape", async () => {
    const { deps, getWs } = makeDeps();

    const responsePromise = createVoicesHandler(deps)(makeDeleteRequest("nova"));
    const ws = await autoReply(getWs, { type: "voice.deleted", voiceId: "nova" });
    const response = await responsePromise;

    expect(response.status).toBe(200);
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: "voice.delete", voiceId: "nova" }));
  });

  it("maps service builtin-voice error to 409", async () => {
    const { deps, getWs } = makeDeps();

    const responsePromise = createVoicesHandler(deps)(makeDeleteRequest("nova"));
    await autoReply(getWs, { type: "error", reason: "builtin-voice" });
    const response = await responsePromise;

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body).toEqual({ error: "builtin-voice" });
  });

  it("returns 502 tts-unreachable on a transport failure (connect refused)", async () => {
    const failingFactory: VoiceMgmtSocketFactory = () => {
      throw new Error("ECONNREFUSED");
    };
    const { deps } = makeDeps({ socketFactory: failingFactory });

    const response = await createVoicesHandler(deps)(makeDeleteRequest(VALID_VOICE_ID));

    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.error).toBe("tts-unreachable");
  });

  it("returns 401 when bearer token is invalid", async () => {
    const { deps } = makeDeps({ tokens: makeInvalidTokens() });
    const response = await createVoicesHandler(deps)(makeDeleteRequest(VALID_VOICE_ID, "bad-token"));
    expect(response.status).toBe(401);
  });

  it("returns 200 voiceId + profile-not-updated warning when deleting the active voice but the reset save fails", async () => {
    const profile = sampleProfile("alice", VALID_VOICE_ID);
    const profileStore = makeProfileStoreWithFailingSave(profile);
    const { deps, getWs } = makeDeps({ profileStore });

    const responsePromise = createVoicesHandler(deps)(makeDeleteRequest(VALID_VOICE_ID));
    await autoReply(getWs, { type: "voice.deleted", voiceId: VALID_VOICE_ID });
    const response = await responsePromise;

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ voiceId: VALID_VOICE_ID, warning: "profile-not-updated" });
    expect(deps.refreshVoice).not.toHaveBeenCalled();
  });

  it("returns 200 voiceId (no warning) when the service delete succeeds but the profile read fails", async () => {
    const profileStore = makeProfileStoreWithFailingGet();
    const { deps, getWs } = makeDeps({ profileStore });

    const responsePromise = createVoicesHandler(deps)(makeDeleteRequest(VALID_VOICE_ID));
    await autoReply(getWs, { type: "voice.deleted", voiceId: VALID_VOICE_ID });
    const response = await responsePromise;

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ voiceId: VALID_VOICE_ID });
    expect(profileStore.save).not.toHaveBeenCalled();
    expect(deps.refreshVoice).not.toHaveBeenCalled();
  });
});

describe("POST /api/v1/voices/:id/preview", () => {
  it("returns 200 audio/wav after a ready -> audio -> done synth sequence", async () => {
    const { deps, getWs } = makeDeps();
    const handler = createVoicesHandler(deps);

    const responsePromise = handler(makePreviewRequest("nova"));
    const ws = await waitForSocket(getWs);
    ws._openHandshake();
    ws._receiveText({ type: "ready", format: "pcm", sample_rate: 24000, voice: "nova" });
    ws._receiveBinary(new Uint8Array([1, 2, 3, 4]));
    ws._receiveText({ type: "done", requestId: "r1", ttfa_ms: 0, rtf: 0, audio_seconds: 0 });
    const response = await responsePromise;

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("audio/wav");
    expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(44);
  });

  it("maps tts-unreachable to 502 when the socket closes before ready", async () => {
    const { deps, getWs } = makeDeps();

    const responsePromise = createVoicesHandler(deps)(makePreviewRequest("nova"));
    const ws = await waitForSocket(getWs);
    ws.close();
    const response = await responsePromise;

    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.error).toBe("tts-unreachable");
  });

  it("returns 401 when the bearer token is missing", async () => {
    const { deps } = makeDeps();
    const response = await createVoicesHandler(deps)(makePreviewRequest("nova", null));
    expect(response.status).toBe(401);
  });

  it("rejects an encoded-traversal id with 422 before dialing the service", async () => {
    const { deps, getWs } = makeDeps();

    // `..%2Fsecret` matches the `([^/]+)` path group, decodes to `../secret` —
    // must be caught by the shape guard (same as DELETE), never reaching synth.
    const request = new Request("http://localhost/api/v1/voices/..%2Fsecret/preview", {
      method: "POST",
      headers: authHeaders(),
    });
    const response = await createVoicesHandler(deps)(request);

    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body.error).toBe("invalid-voice-id");
    expect(getWs()).toBeNull();
  });

  it("rejects a malformed percent-encoding with 422 (not 500)", async () => {
    const { deps, getWs } = makeDeps();

    // `%ZZ` is invalid percent-encoding — decodeURIComponent throws; the handler
    // must degrade to a clean 422, never surface an unhandled 500.
    const request = new Request("http://localhost/api/v1/voices/%ZZ/preview", {
      method: "POST",
      headers: authHeaders(),
    });
    const response = await createVoicesHandler(deps)(request);

    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body.error).toBe("invalid-voice-id");
    expect(getWs()).toBeNull();
  });

  it("accepts a 32-hex id and reaches the service", async () => {
    const { deps, getWs } = makeDeps();

    const responsePromise = createVoicesHandler(deps)(makePreviewRequest(VALID_VOICE_ID));
    const ws = await waitForSocket(getWs);
    ws._openHandshake();
    ws._receiveText({ type: "ready", format: "pcm", sample_rate: 24000, voice: VALID_VOICE_ID });
    ws._receiveBinary(new Uint8Array([1, 2, 3, 4]));
    ws._receiveText({ type: "done", requestId: "r1", ttfa_ms: 0, rtf: 0, audio_seconds: 0 });
    const response = await responsePromise;

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("audio/wav");
  });
});
