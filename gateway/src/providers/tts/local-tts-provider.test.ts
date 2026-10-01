import { describe, expect, it, vi } from "vitest";
import { type LocalTtsProviderConfig, createLocalTtsProvider } from "./local-tts-provider.ts";
import type { TTSProvider } from "./tts-types.ts";

// ---------------------------------------------------------------------------
// FakeWebSocket — a minimal scriptable WebSocket for deterministic tests.
// Injected via cfg.socketFactory (no globalThis.WebSocket patching needed —
// the provider never calls `new WebSocket()` itself).
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
  _receiveBinary(data: ArrayBuffer): void;
  _url: string;
}

function makeFakeWebSocket(url: string): FakeWebSocket {
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
    _receiveBinary(data: ArrayBuffer) {
      ws.onmessage?.({ data } as MessageEvent<ArrayBuffer>);
    },
    _url: url,
  };
  return ws;
}

// One provider == one WS (per-synthesis-run lifecycle), so each harness only
// ever needs to track the single most-recently-created fake socket.
function setup(overrides: Partial<LocalTtsProviderConfig> = {}): {
  provider: TTSProvider;
  getWs: () => FakeWebSocket | null;
} {
  let ws: FakeWebSocket | null = null;
  const cfg: LocalTtsProviderConfig = {
    url: "ws://host.docker.internal:8770",
    format: "opus",
    sampleRate: 48000,
    connectTimeoutMs: 1000,
    socketFactory: (url: string) => {
      ws = makeFakeWebSocket(url);
      return ws as unknown as WebSocket;
    },
    ...overrides,
  };
  const provider = createLocalTtsProvider(cfg);
  return { provider, getWs: () => ws };
}

async function readyProvider(
  overrides: Partial<LocalTtsProviderConfig> = {},
): Promise<{ provider: TTSProvider; getWs: () => FakeWebSocket | null }> {
  const { provider, getWs } = setup(overrides);
  provider.warmup();
  await Promise.resolve();
  getWs()?._openHandshake();
  getWs()?._receiveText({ type: "ready", format: "opus", sample_rate: 48000, voice: null });
  await provider.ready(new AbortController().signal);
  return { provider, getWs };
}

describe("createLocalTtsProvider — warmup()", () => {
  it("opens a WS at the buildConnectUrl URL", () => {
    const { provider, getWs } = setup();
    provider.warmup();
    expect(getWs()?._url).toBe("ws://host.docker.internal:8770/?format=opus&sample_rate=48000");
  });

  it("includes voice in the connect URL from overrides, falling back to defaultVoice", () => {
    const { provider, getWs } = setup({ defaultVoice: "dad-voice" });
    provider.warmup();
    expect(getWs()?._url).toBe("ws://host.docker.internal:8770/?format=opus&sample_rate=48000&voice=dad-voice");
  });

  it("does not throw when socketFactory throws synchronously, and ready() then rejects cleanly", async () => {
    const provider = createLocalTtsProvider({
      url: "ws://[malformed",
      format: "opus",
      sampleRate: 48000,
      connectTimeoutMs: 1000,
      socketFactory: () => {
        throw new Error("Invalid URL");
      },
    });

    expect(() => provider.warmup()).not.toThrow();
    await expect(provider.ready(new AbortController().signal)).rejects.toThrow();
  });
});

describe("createLocalTtsProvider — ready()", () => {
  it("resolves once the WS opens and the ready frame arrives", async () => {
    const { provider } = await readyProvider();
    await expect(provider.ready(new AbortController().signal)).resolves.toBeUndefined();
  });
});

describe("createLocalTtsProvider — pushText()", () => {
  it("sends a textMsg frame", async () => {
    const { provider, getWs } = await readyProvider();
    provider.pushText("hi");
    expect(getWs()?.send).toHaveBeenCalledWith(JSON.stringify({ type: "text", text: "hi" }));
  });
});

describe("createLocalTtsProvider — audioFrames()", () => {
  it("yields a TTSAudioChunk per binary frame then returns on the done frame", async () => {
    const { provider, getWs } = await readyProvider();
    const controller = new AbortController();
    const gen = provider.audioFrames(controller.signal);

    const frame1 = new Uint8Array([1, 2, 3]).buffer;
    const frame2 = new Uint8Array([4, 5]).buffer;
    getWs()?._receiveBinary(frame1);
    getWs()?._receiveBinary(frame2);
    getWs()?._receiveText({ type: "done", requestId: "req-1", ttfa_ms: 10, rtf: 0.1, audio_seconds: 1 });

    const r1 = await gen.next();
    const r2 = await gen.next();
    const r3 = await gen.next();

    expect(r1.value).toEqual({ data: new Uint8Array([1, 2, 3]), encoding: "opus", sampleRate: 48000, isFinal: false });
    expect(r2.value).toEqual({ data: new Uint8Array([4, 5]), encoding: "opus", sampleRate: 48000, isFinal: false });
    expect(r3.done).toBe(true);
  });

  it("returns without throwing when the signal is already aborted", async () => {
    const { provider } = await readyProvider();
    const controller = new AbortController();
    controller.abort();
    const gen = provider.audioFrames(controller.signal);
    const result = await gen.next();
    expect(result.done).toBe(true);
  });

  it("returns without throwing when aborted mid-drain", async () => {
    const { provider, getWs } = await readyProvider();
    const controller = new AbortController();
    const gen = provider.audioFrames(controller.signal);
    getWs()?._receiveBinary(new Uint8Array([9]).buffer);
    controller.abort();
    // Drain whatever is buffered; must terminate cleanly, never throw.
    await expect(
      (async () => {
        for await (const _chunk of gen) {
          // drain
        }
      })(),
    ).resolves.toBeUndefined();
  });

  it("returns cleanly through the inner between-yields abort check (Fix 3 coverage)", async () => {
    // Unlike "aborted mid-drain" above (which aborts BEFORE the generator's
    // first .next(), short-circuiting on the outer `while (!signal.aborted)`
    // guard), this test genuinely interleaves: consume one chunk, THEN
    // abort, THEN resume — with a second chunk still buffered so the inner
    // `while (!queue.isEmpty())` loop is re-entered and hits its own
    // `if (signal.aborted)` check, not the outer one.
    const { provider, getWs } = await readyProvider();
    const controller = new AbortController();
    const gen = provider.audioFrames(controller.signal);
    getWs()?._receiveBinary(new Uint8Array([1]).buffer);
    getWs()?._receiveBinary(new Uint8Array([2]).buffer);

    const r1 = await gen.next();
    expect(r1.done).toBe(false);
    expect(r1.value).toEqual({ data: new Uint8Array([1]), encoding: "opus", sampleRate: 48000, isFinal: false });

    controller.abort();

    const r2 = await gen.next();
    expect(r2.done).toBe(true);
    expect(r2.value).toBeUndefined();
  });
});

describe("createLocalTtsProvider — endInput()", () => {
  it("sends an endMsg frame", async () => {
    const { provider, getWs } = await readyProvider();
    provider.endInput();
    expect(getWs()?.send).toHaveBeenCalledWith(JSON.stringify({ type: "end" }));
  });
});

describe("createLocalTtsProvider — dispose()", () => {
  it("sends a cancelMsg frame then closes the socket", async () => {
    const { provider, getWs } = await readyProvider();
    provider.dispose();
    expect(getWs()?.send).toHaveBeenCalledWith(JSON.stringify({ type: "cancel" }));
    expect(getWs()?.close).toHaveBeenCalledTimes(1);
  });

  it("is idempotent", async () => {
    const { provider } = await readyProvider();
    provider.dispose();
    expect(() => provider.dispose()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Sad-path FSM exits (Fix 4) — fake-WS driven, no real service. Each test
// asserts the CURRENT implemented behavior (no throw; reject/return per the
// existing contract) — coverage of these exits, not a behavior redesign.
// ---------------------------------------------------------------------------

describe("createLocalTtsProvider — sad paths", () => {
  it("rejects ready() when the server sends an error frame before the ready frame", async () => {
    const { provider, getWs } = setup();
    provider.warmup();
    await Promise.resolve();
    getWs()?._openHandshake();

    const readyRejection = provider.ready(new AbortController().signal);
    getWs()?._receiveText({ type: "error", reason: "synth-engine-unavailable" });

    await expect(readyRejection).rejects.toThrow("synth-engine-unavailable");
  });

  it("rejects audioFrames when the server sends an error frame mid-stream", async () => {
    const { provider, getWs } = await readyProvider();
    const controller = new AbortController();
    const gen = provider.audioFrames(controller.signal);

    // No chunks buffered yet — the generator is parked on queue.waitForItem().
    const nextPromise = gen.next();
    getWs()?._receiveText({ type: "error", reason: "synth-failed" });

    await expect(nextPromise).rejects.toThrow("synth-failed");
  });

  it("throws instead of draining buffered audio after generation exhaustion", async () => {
    const { provider, getWs } = await readyProvider();
    const gen = provider.audioFrames(new AbortController().signal);
    getWs()?._receiveBinary(new Uint8Array([1]).buffer);
    getWs()?._receiveBinary(new Uint8Array([2]).buffer);
    expect((await gen.next()).done).toBe(false);
    getWs()?._receiveText({ type: "error", reason: "generation_token_limit: tokens=75 max_tokens=75" });
    await expect(gen.next()).rejects.toThrow("generation_token_limit");
    provider.dispose();
    expect(getWs()?.close).toHaveBeenCalledTimes(1);
  });

  it("degrades without an unhandled crash when the WS fires onerror", async () => {
    const { provider, getWs } = setup();
    provider.warmup();
    await Promise.resolve();
    getWs()?._openHandshake();

    const readyRejection = provider.ready(new AbortController().signal);
    expect(() => getWs()?.onerror?.({ message: "ECONNRESET" } as unknown as Event)).not.toThrow();

    await expect(readyRejection).rejects.toThrow("ECONNRESET");
  });

  it("rejects ready() when the connect timeout elapses before the ready frame arrives", async () => {
    // Small real connectTimeoutMs — the fake WS never calls _openHandshake(),
    // so it stays CONNECTING and the socket-layer timer fires for real.
    const { provider, getWs } = setup({ connectTimeoutMs: 5 });
    provider.warmup();

    await expect(provider.ready(new AbortController().signal)).rejects.toThrow(/connect timeout/);
    expect(getWs()?.close).toHaveBeenCalled();
  });

  it("rejects ready() immediately when called with an already-aborted signal", async () => {
    const { provider } = setup();
    const controller = new AbortController();
    controller.abort();

    await expect(provider.ready(controller.signal)).rejects.toThrow("aborted");
  });
});

describe("empty completion across provider, synthesizer and turn drain", () => {
  it.each([undefined, "```\ncode\n```"])("releases %s turn before next speech without barge-in", async (text) => {
    const { createStreamingTtsSynthesizer } = await import("../../tts/streaming-tts-synthesizer.ts");
    const { createTurnVoice } = await import("../../runtime/turn-voice.ts");
    const sockets: FakeWebSocket[] = [];
    const synthesizer = createStreamingTtsSynthesizer({
      sessionFactory: {
        createSession: async () =>
          createLocalTtsProvider({
            url: "ws://127.0.0.1:8770",
            format: "opus",
            sampleRate: 48000,
            socketFactory: (url) => {
              const ws = makeFakeWebSocket(url);
              const index = sockets.push(ws) - 1;
              ws.send.mockImplementation((payload: string) => {
                if (JSON.parse(payload).type !== "end") return;
                if (index > 0) ws._receiveBinary(new Uint8Array([1, 2]).buffer);
                ws._receiveText({
                  type: "done",
                  requestId: `req-${index}`,
                  ttfa_ms: 0,
                  rtf: 0,
                  audio_seconds: index > 0 ? 1 : 0,
                });
              });
              // No-text case deliberately never becomes ready: old End was lost.
              if (text !== undefined || index > 0)
                queueMicrotask(() => {
                  ws._openHandshake();
                  ws._receiveText({ type: "ready", format: "opus", sample_rate: 48000, voice: null });
                });
              return ws as unknown as WebSocket;
            },
          }),
      },
    });
    const events: string[] = [];
    const voice = createTurnVoice({
      synthesizer,
      sessionId: "test",
      shouldSpeak: async () => true,
      hasAudience: () => true,
      echoGuard: { onTtsStart() {}, onTtsCancel() {} },
      sink: {
        audioStart: (id) => events.push(`start:${id}`),
        audioFrame: (id) => events.push(`frame:${id}`),
        audioDone: (id) => events.push(`done:${id}`),
      },
    });
    const first = voice.begin("empty", new AbortController().signal);
    if (text !== undefined) first.pushText(text);
    first.end();
    const next = voice.begin("spoken", new AbortController().signal);
    next.pushText("Hello.");
    next.end();
    for (let n = 0; n < 100 && events.length < 3; n++) await new Promise((r) => setTimeout(r, 1));
    expect(events).toEqual(["start:spoken", "frame:spoken", "done:spoken"]);
    expect(sockets).toHaveLength(2);
    expect(sockets.every((ws) => ws.close.mock.calls.length === 1)).toBe(true);
    // Late frames on retired socket must not affect following turn.
    sockets[0]?._receiveBinary(new Uint8Array([9]).buffer);
    sockets[0]?._receiveText({ type: "done", requestId: "late", ttfa_ms: 0, rtf: 0, audio_seconds: 0 });
    expect(events).toHaveLength(3);
    expect(voice.cancelAudio()).toEqual([]);
  });
});

describe("generation failure through provider, runtime and wire sink", () => {
  it("closes partial audio normally, releases tail, and completes next turn without barge-in", async () => {
    const { gatewayMessageSchema } = await import("@sentient/protocol");
    const { createStreamingTtsSynthesizer } = await import("../../tts/streaming-tts-synthesizer.ts");
    const { createTurnVoice } = await import("../../runtime/turn-voice.ts");
    const { createTurnStateTracker } = await import("../../runtime/turn-state-snapshot.ts");
    const { createWsTurnEmitter } = await import("../../session-handlers/ws-turn-emitter.ts");
    const sockets: FakeWebSocket[] = [];
    const events: unknown[] = [];
    const cleared: string[] = [];
    const tracker = createTurnStateTracker("test");
    const sink = tracker.wrap(
      createWsTurnEmitter(
        {
          size: 1,
          broadcast: (frame) => {
            events.push(gatewayMessageSchema.parse(frame));
            return 1;
          },
          directed: () => 0,
          broadcastAudio: () => {
            events.push("frame");
          },
        },
        "test",
      ),
    );
    const voice = createTurnVoice({
      synthesizer: createStreamingTtsSynthesizer({
        sessionFactory: {
          createSession: async () =>
            createLocalTtsProvider({
              url: "ws://127.0.0.1:8770",
              format: "opus",
              sampleRate: 48000,
              socketFactory: (url) => {
                const ws = makeFakeWebSocket(url);
                sockets.push(ws);
                queueMicrotask(() => {
                  ws._openHandshake();
                  ws._receiveText({ type: "ready", format: "opus", sample_rate: 48000, voice: null });
                });
                return ws as unknown as WebSocket;
              },
            }),
        },
      }),
      sessionId: "test",
      sink,
      shouldSpeak: async () => true,
      hasAudience: () => true,
      echoGuard: { onTtsStart() {}, onTtsCancel: (id) => cleared.push(id) },
    });
    const waitFor = async (condition: () => boolean) => {
      for (let n = 0; n < 100 && !condition(); n++) await new Promise((r) => setTimeout(r, 1));
      expect(condition()).toBe(true);
    };
    for (const id of ["failed", "normal"]) {
      const turn = voice.begin(id, new AbortController().signal);
      turn.pushText("Synthetic test.");
      turn.end();
    }
    await waitFor(() => sockets.length === 1);
    sockets[0]?._receiveBinary(new Uint8Array([1]).buffer);
    await waitFor(() => events.length === 2);
    sockets[0]?._receiveText({ type: "error", reason: "generation_token_limit: tokens=75 max_tokens=75" });
    await waitFor(() => sockets.length === 2);
    expect(tracker.snapshot().audio).toBeNull();
    // Already-delivered audio still drains; keep its echo-suppression window.
    expect(cleared).toEqual([]);
    sockets[1]?._receiveBinary(new Uint8Array([2]).buffer);
    await waitFor(() => events.length === 5);
    // Retired provider's late error cannot end the active next turn.
    sockets[0]?._receiveText({ type: "error", reason: "generation_token_limit" });
    expect(tracker.snapshot().audio?.turnId).toBe("normal");
    sockets[1]?._receiveText({ type: "done", requestId: "normal", ttfa_ms: 1, rtf: 1, audio_seconds: 1 });
    await waitFor(() => events.length === 6);
    expect(events).toEqual([
      { type: "turn.audio.start", turnId: "failed", encoding: "opus", sampleRate: 48000 },
      "frame",
      { type: "turn.audio.done", turnId: "failed" },
      { type: "turn.audio.start", turnId: "normal", encoding: "opus", sampleRate: 48000 },
      "frame",
      { type: "turn.audio.done", turnId: "normal" },
    ]);
    expect(tracker.snapshot().audio).toBeNull();
    expect(sockets.every((ws) => ws.close.mock.calls.length === 1)).toBe(true);
    expect(voice.cancelAudio()).toEqual([]);
  });
});
