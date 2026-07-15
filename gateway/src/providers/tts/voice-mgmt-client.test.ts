import { describe, expect, it, vi } from "vitest";
import { type VoiceMgmtConfig, createVoice, listVoices } from "./voice-mgmt-client.ts";

// ---------------------------------------------------------------------------
// FakeWebSocket — minimal scriptable WS, mirrors the pattern used in
// local-tts-provider.test.ts / voices.test.ts. Injected via cfg.socketFactory
// so no real socket is touched.
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

function setup(): { cfg: VoiceMgmtConfig; getWs: () => FakeWebSocket | null } {
  let ws: FakeWebSocket | null = null;
  const cfg: VoiceMgmtConfig = {
    url: "ws://host.docker.internal:8770",
    connectTimeoutMs: 1000,
    opTimeoutMs: 1000,
    socketFactory: (_url: string) => {
      ws = makeFakeWebSocket();
      return ws as unknown as WebSocket;
    },
  };
  return { cfg, getWs: () => ws };
}

/** Polls the microtask queue until the harness has opened a socket. */
async function waitForSocket(getWs: () => FakeWebSocket | null): Promise<FakeWebSocket> {
  for (let i = 0; i < 50; i++) {
    const ws = getWs();
    if (ws) return ws;
    await Promise.resolve();
  }
  throw new Error("socket was never created");
}

describe("createVoice", () => {
  it("sends voiceCreateMsg with description, tags, and language, followed by the binary audio frame", async () => {
    const { cfg, getWs } = setup();
    const audio = new Uint8Array([1, 2, 3]).buffer;
    const pending = createVoice(cfg, "Nova", audio, new AbortController().signal, "Warm", ["warm", "calm"], "zh");

    const ws = await waitForSocket(getWs);
    ws._openHandshake();
    ws._receiveText({ type: "voice.created", voiceId: "3f9b", name: "Nova", createdAt: 0 });

    const result = await pending;
    expect(result).toEqual({ ok: true, value: { voiceId: "3f9b", name: "Nova" } });
    expect(ws.send).toHaveBeenNthCalledWith(
      1,
      JSON.stringify({
        type: "voice.create",
        name: "Nova",
        description: "Warm",
        tags: ["warm", "calm"],
        language: "zh",
      }),
    );
    expect(ws.send).toHaveBeenNthCalledWith(2, audio);
  });

  it("sends empty description/tags/language as-is for a bare-name pack", async () => {
    const { cfg, getWs } = setup();
    const audio = new Uint8Array([1]).buffer;
    const pending = createVoice(cfg, "Dad", audio, new AbortController().signal, "", []);

    const ws = await waitForSocket(getWs);
    ws._openHandshake();
    ws._receiveText({ type: "voice.created", voiceId: "abc1", name: "Dad", createdAt: 0 });
    await pending;

    expect(ws.send).toHaveBeenNthCalledWith(
      1,
      JSON.stringify({ type: "voice.create", name: "Dad", description: "", tags: [], language: "" }),
    );
  });
});

describe("listVoices", () => {
  it("passes through description/tags/source from the voice.list reply", async () => {
    const { cfg, getWs } = setup();
    const pending = listVoices(cfg, new AbortController().signal);

    const ws = await waitForSocket(getWs);
    ws._openHandshake();
    ws._receiveText({
      type: "voice.list",
      voices: [
        {
          voiceId: "nova",
          name: "Nova",
          description: "",
          tags: ["warm"],
          source: "builtin",
          createdAt: 0,
          refDurationMs: 0,
        },
        {
          voiceId: "3f9b",
          name: "Dad",
          description: "Warm, low register",
          tags: ["family", "warm"],
          source: "user",
          createdAt: 1752400000,
          refDurationMs: 12000,
        },
      ],
    });

    const result = await pending;
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.voices).toEqual([
        {
          voiceId: "nova",
          name: "Nova",
          description: "",
          tags: ["warm"],
          source: "builtin",
          createdAt: 0,
          refDurationMs: 0,
        },
        {
          voiceId: "3f9b",
          name: "Dad",
          description: "Warm, low register",
          tags: ["family", "warm"],
          source: "user",
          createdAt: 1752400000,
          refDurationMs: 12000,
        },
      ]);
    }
  });
});
