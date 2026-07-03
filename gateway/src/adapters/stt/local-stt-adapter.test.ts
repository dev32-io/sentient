import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendLanguageQuery, createLocalSttAdapter } from "./local-stt-adapter.ts";
import type { STTAdapter, STTAdapterConfig } from "./stt-adapter-types.ts";

// ---------------------------------------------------------------------------
// FakeWebSocket — a minimal scriptable WebSocket for deterministic tests.
// ---------------------------------------------------------------------------

interface FakeWebSocket {
  readyState: number;
  onopen: ((ev: Event) => void) | null;
  onmessage: ((ev: MessageEvent<string | ArrayBuffer>) => void) | null;
  onclose: ((ev: CloseEvent) => void) | null;
  onerror: ((ev: Event) => void) | null;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  // test helpers:
  _openHandshake(): void;
  _receiveText(msg: object): void;
  _receiveBinary(data: ArrayBuffer): void;
  _closeRemotely(code?: number): void;
  _url: string;
  _headers: Record<string, string>;
}

function makeFakeWebSocket(url: string, headers: Record<string, string>): FakeWebSocket {
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
    _receiveText(msg) {
      ws.onmessage?.({ data: JSON.stringify(msg) } as MessageEvent<string>);
    },
    _receiveBinary(data) {
      ws.onmessage?.({ data } as MessageEvent<ArrayBuffer>);
    },
    _closeRemotely(code = 1011) {
      ws.readyState = 3;
      ws.onclose?.({ code, reason: "", wasClean: false } as CloseEvent);
    },
    _url: url,
    _headers: headers,
  };
  return ws;
}

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

let currentWs: FakeWebSocket | null = null;
const OriginalWebSocket = globalThis.WebSocket;

function installFakeWebSocket(): void {
  currentWs = null;
  // biome-ignore lint/complexity/useArrowFunction: must be a function expression so `new WebSocket()` in adapter works
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = function (
    url: string | URL,
    optionsOrProtocols?: string | string[] | { headers?: Record<string, string>; protocols?: string[] },
  ) {
    const headers =
      optionsOrProtocols && typeof optionsOrProtocols === "object" && !Array.isArray(optionsOrProtocols)
        ? (optionsOrProtocols.headers ?? {})
        : {};
    const ws = makeFakeWebSocket(String(url), headers);
    currentWs = ws;
    return ws as unknown as WebSocket;
  } as unknown as typeof WebSocket;
  (globalThis as unknown as { WebSocket: { OPEN: number } }).WebSocket.OPEN = 1;
}

function restoreWebSocket(): void {
  (globalThis as unknown as { WebSocket: typeof OriginalWebSocket }).WebSocket = OriginalWebSocket;
  currentWs = null;
}

const BASE_CONFIG: STTAdapterConfig = {
  url: "ws://fake-stt:8766",
  language: "en",
  pauseRenderLanguage: "en",
  inputSampleRate: 48000,
  ttsEchoCooldownMs: 0, // 0 → cooldown disabled so existing send() tests are unaffected
  connectTimeoutMs: 1000,
  audioFormat: "pcm16",
};

function pcm16Loud(nSamples: number): Uint8Array {
  const arr = new Int16Array(nSamples);
  arr.fill(20_000);
  return new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
}

beforeEach(() => {
  installFakeWebSocket();
});

afterEach(() => {
  restoreWebSocket();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("appendLanguageQuery", () => {
  it("adds ?language= to a bare URL", () => {
    expect(appendLanguageQuery("ws://host:8766", "en")).toBe("ws://host:8766?language=en");
  });

  it("adds &language= to a URL that already has a query string", () => {
    expect(appendLanguageQuery("ws://host:8766/?foo=bar", "zh")).toBe("ws://host:8766/?foo=bar&language=zh");
  });

  it("url-encodes the value", () => {
    // Not strictly needed for the allowlisted enum but confirms encoding path.
    expect(appendLanguageQuery("ws://host:8766", "auto")).toBe("ws://host:8766?language=auto");
  });
});

describe("createLocalSttAdapter — open()", () => {
  it("resolves after receiving {type:'ready'}", async () => {
    const adapter = createLocalSttAdapter(BASE_CONFIG);
    const signal = new AbortController().signal;
    const openPromise = adapter.open(signal);
    await Promise.resolve();
    currentWs?._openHandshake();
    currentWs?._receiveText({ type: "ready" });
    await expect(openPromise).resolves.toBeUndefined();
  });

  it("connects with the configured language as a URL query param", async () => {
    const adapter = createLocalSttAdapter({ ...BASE_CONFIG, language: "zh" });
    const openPromise = adapter.open(new AbortController().signal);
    await Promise.resolve();
    expect(currentWs?._url).toBe("ws://fake-stt:8766?language=zh&audioFormat=pcm16");
    currentWs?._openHandshake();
    currentWs?._receiveText({ type: "ready" });
    await openPromise;
  });

  it("connects with audioFormat=opus when configured for opus uplink (cube source)", async () => {
    const adapter = createLocalSttAdapter({ ...BASE_CONFIG, audioFormat: "opus" });
    const openPromise = adapter.open(new AbortController().signal);
    await Promise.resolve();
    expect(currentWs?._url).toBe("ws://fake-stt:8766?language=en&audioFormat=opus");
    currentWs?._openHandshake();
    currentWs?._receiveText({ type: "ready" });
    await openPromise;
  });

  it("renders pauses in the configured pauseRenderLanguage even when decode language differs", async () => {
    const adapter = createLocalSttAdapter({ ...BASE_CONFIG, language: "auto", pauseRenderLanguage: "zh" });
    const openPromise = adapter.open(new AbortController().signal);
    await Promise.resolve();
    currentWs?._openHandshake();
    currentWs?._receiveText({ type: "ready" });
    await openPromise;
    const controller = new AbortController();
    const gen = adapter.events(controller.signal);
    currentWs?._receiveText({
      type: "transcript_ready",
      turnIdx: 1,
      text: "你好 [pause.0] 世界",
      pauses: [1500],
    });
    const { value } = await gen.next();
    expect((value as { text: string }).text).toMatch(/停顿/);
    controller.abort();
  });

  it("rejects on connectTimeoutMs expiry", async () => {
    vi.useFakeTimers();
    const adapter = createLocalSttAdapter({ ...BASE_CONFIG, connectTimeoutMs: 100 });
    const openPromise = adapter.open(new AbortController().signal).catch((e) => e);
    vi.advanceTimersByTime(150);
    // Flush microtasks so the rejection propagates before we await.
    await Promise.resolve();
    await Promise.resolve();
    const err = await openPromise;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/timeout/i);
  });
});

describe("createLocalSttAdapter — events()", () => {
  async function openedAdapter(): Promise<STTAdapter> {
    const adapter = createLocalSttAdapter(BASE_CONFIG);
    const openPromise = adapter.open(new AbortController().signal);
    await Promise.resolve();
    currentWs?._openHandshake();
    currentWs?._receiveText({ type: "ready" });
    await openPromise;
    return adapter;
  }

  it("yields turn_started on vad_start", async () => {
    const adapter = await openedAdapter();
    const controller = new AbortController();
    const gen = adapter.events(controller.signal);
    currentWs?._receiveText({ type: "vad_start", turnIdx: 1 });
    const { value } = await gen.next();
    expect(value).toEqual({ type: "turn_started", turnIdx: 1 });
    controller.abort();
  });

  it("yields transcript with rendered text on transcript_ready", async () => {
    const adapter = await openedAdapter();
    const controller = new AbortController();
    const gen = adapter.events(controller.signal);
    currentWs?._receiveText({
      type: "transcript_ready",
      turnIdx: 2,
      text: "hi [pause.0] there",
      pauses: [1200],
      emotion: "<|NEUTRAL|>",
      event: "<|Speech|>",
      decodeMs: 100,
      audioSeconds: 1.0,
    });
    const { value } = await gen.next();
    expect(value).toEqual({ type: "transcript", turnIdx: 2, text: "hi [paused 1.2s] there" });
    controller.abort();
  });

  it("yields turn_dropped on turn_rejected", async () => {
    const adapter = await openedAdapter();
    const controller = new AbortController();
    const gen = adapter.events(controller.signal);
    currentWs?._receiveText({ type: "turn_rejected", turnIdx: 3, reason: "empty_transcript" });
    const { value } = await gen.next();
    expect(value).toEqual({ type: "turn_dropped", turnIdx: 3 });
    controller.abort();
  });

  it("skips unknown types, malformed JSON, and binary frames", async () => {
    const adapter = await openedAdapter();
    const controller = new AbortController();
    const gen = adapter.events(controller.signal);
    // Noise:
    currentWs?._receiveText({ type: "vad_end", turnIdx: 1 });
    currentWs?._receiveText({ type: "smart_turn_eval", turnIdx: 1 });
    currentWs?._receiveBinary(new ArrayBuffer(16));
    // Signal:
    currentWs?._receiveText({ type: "vad_start", turnIdx: 1 });
    const { value } = await gen.next();
    expect(value).toEqual({ type: "turn_started", turnIdx: 1 });
    controller.abort();
  });

  it("terminates generator when signal aborts", async () => {
    const adapter = await openedAdapter();
    const controller = new AbortController();
    const gen = adapter.events(controller.signal);
    controller.abort();
    const result = await gen.next();
    expect(result.done).toBe(true);
  });
});

describe("createLocalSttAdapter — send()", () => {
  it("forwards pcm16 frames after downsample to 16 kHz", async () => {
    vi.useFakeTimers();
    const adapter = createLocalSttAdapter(BASE_CONFIG);
    const openPromise = adapter.open(new AbortController().signal);
    await Promise.resolve();
    currentWs?._openHandshake();
    currentWs?._receiveText({ type: "ready" });
    await openPromise;
    adapter.send(pcm16Loud(48)); // 48 samples @ 48k → ~16 samples @ 16k
    expect(currentWs?.send).toHaveBeenCalledTimes(1);
    const [sent] = currentWs?.send.mock.calls[0] ?? [];
    expect(sent).toBeInstanceOf(Uint8Array);
    expect((sent as Uint8Array).byteLength).toBe(32); // 16 Int16 samples = 32 bytes
    await adapter.close();
  });
});

describe("createLocalSttAdapter — endUtterance()", () => {
  it("sends {type:'flush'} on the open socket", async () => {
    const adapter = createLocalSttAdapter(BASE_CONFIG);
    const openPromise = adapter.open(new AbortController().signal);
    await Promise.resolve();
    currentWs?._openHandshake();
    currentWs?._receiveText({ type: "ready" });
    await openPromise;
    adapter.endUtterance();
    expect(currentWs?.send).toHaveBeenCalledTimes(1);
    const [sent] = currentWs?.send.mock.calls[0] ?? [];
    expect(JSON.parse(sent as string)).toEqual({ type: "flush" });
    await adapter.close();
  });

  it("is a no-op when the socket is closed", async () => {
    const adapter = createLocalSttAdapter(BASE_CONFIG);
    const openPromise = adapter.open(new AbortController().signal);
    await Promise.resolve();
    currentWs?._openHandshake();
    currentWs?._receiveText({ type: "ready" });
    await openPromise;
    await adapter.close();
    adapter.endUtterance(); // must not throw
    expect(currentWs?.send).not.toHaveBeenCalled();
  });
});

describe("createLocalSttAdapter — close()", () => {
  it("is idempotent", async () => {
    const adapter = createLocalSttAdapter(BASE_CONFIG);
    const openPromise = adapter.open(new AbortController().signal);
    await Promise.resolve();
    currentWs?._openHandshake();
    currentWs?._receiveText({ type: "ready" });
    await openPromise;
    await adapter.close();
    await adapter.close(); // must not throw
  });
});

// ---------------------------------------------------------------------------
// C2: abort-listener leak in EventQueue.waitForEvent
// ---------------------------------------------------------------------------

describe("EventQueue abort-listener hygiene (C2)", () => {
  it("removes abort listener when an event arrives so listeners don't accumulate", async () => {
    const adapter = createLocalSttAdapter(BASE_CONFIG);
    const openPromise = adapter.open(new AbortController().signal);
    await Promise.resolve();
    currentWs?._openHandshake();
    currentWs?._receiveText({ type: "ready" });
    await openPromise;

    const controller = new AbortController();
    const { signal } = controller;

    // Track net addEventListener/removeEventListener calls.
    let addCount = 0;
    let removeCount = 0;
    const origAdd = signal.addEventListener.bind(signal);
    const origRemove = signal.removeEventListener.bind(signal);
    signal.addEventListener = (type: string, ...args: unknown[]) => {
      if (type === "abort") addCount++;
      return (origAdd as (...a: unknown[]) => unknown)(type, ...args);
    };
    signal.removeEventListener = (type: string, ...args: unknown[]) => {
      if (type === "abort") removeCount++;
      return (origRemove as (...a: unknown[]) => unknown)(type, ...args);
    };

    const gen = adapter.events(signal);

    // Emit 5 events, consuming each one so waitForEvent registers a new listener.
    for (let i = 1; i <= 5; i++) {
      currentWs?._receiveText({ type: "vad_start", turnIdx: i });
      await gen.next();
    }

    // Each waitForEvent call that blocks adds one listener; each arriving event removes it.
    // After 5 consumed events, net listener count must be zero (add === remove).
    expect(addCount).toBe(removeCount);

    controller.abort();
  });
});

// ---------------------------------------------------------------------------
// suppressInputFor() — TTS-start echo-suppression cooldown
// ---------------------------------------------------------------------------

describe("createLocalSttAdapter — suppressInputFor()", () => {
  async function openedAdapterWith(
    overrides: Partial<STTAdapterConfig>,
  ): Promise<ReturnType<typeof createLocalSttAdapter>> {
    const adapter = createLocalSttAdapter({ ...BASE_CONFIG, ...overrides });
    const openPromise = adapter.open(new AbortController().signal);
    await Promise.resolve();
    currentWs?._openHandshake();
    currentWs?._receiveText({ type: "ready" });
    await openPromise;
    return adapter;
  }

  it("drops send() calls within the cooldown window", async () => {
    vi.useFakeTimers();
    const adapter = await openedAdapterWith({});
    adapter.suppressInputFor(500);
    adapter.send(pcm16Loud(48));
    expect(currentWs?.send).not.toHaveBeenCalled();
    await adapter.close();
  });

  it("resumes send() after the cooldown expires", async () => {
    vi.useFakeTimers();
    const adapter = await openedAdapterWith({});
    adapter.suppressInputFor(500);
    adapter.send(pcm16Loud(48));
    expect(currentWs?.send).not.toHaveBeenCalled();

    vi.advanceTimersByTime(600); // silence timer fires; gate window also expires
    currentWs?.send.mockClear(); // isolate from silence timer frames
    adapter.send(pcm16Loud(48));
    expect(currentWs?.send).toHaveBeenCalledTimes(1);
    await adapter.close();
  });

  it("suppressInputFor(0) clears any active suppression immediately", async () => {
    vi.useFakeTimers();
    const adapter = await openedAdapterWith({});
    adapter.suppressInputFor(5000);
    adapter.send(pcm16Loud(48));
    expect(currentWs?.send).not.toHaveBeenCalled();

    adapter.suppressInputFor(0);
    adapter.send(pcm16Loud(48));
    expect(currentWs?.send).toHaveBeenCalledTimes(1);
    await adapter.close();
  });
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// I4: open() rejects immediately when WS closes before {type:'ready'}
// ---------------------------------------------------------------------------

describe("open() close-before-ready rejection (I4)", () => {
  it("rejects with 'closed before ready' when WS closes without sending ready", async () => {
    const adapter = createLocalSttAdapter(BASE_CONFIG);
    const openPromise = adapter.open(new AbortController().signal);
    await Promise.resolve();
    // Simulate WS accepted then closed without ever sending {type:'ready'}.
    currentWs?._openHandshake();
    currentWs?._closeRemotely(1011);
    await expect(openPromise).rejects.toThrow(/closed before ready/i);
  });

  it("does not reject after ready when close fires later", async () => {
    const adapter = createLocalSttAdapter(BASE_CONFIG);
    const openPromise = adapter.open(new AbortController().signal);
    await Promise.resolve();
    currentWs?._openHandshake();
    currentWs?._receiveText({ type: "ready" });
    await expect(openPromise).resolves.toBeUndefined();
    // Closing after ready must not throw or reject anything.
    currentWs?._closeRemotely(1000);
    await adapter.close();
  });
});
