import { configure, reset } from "@logtape/logtape";
import { describe, expect, it, vi } from "vitest";
import { endMsg, textMsg } from "./local-tts-protocol.ts";
import { type PreviewSynthConfig, synthesizePreview } from "./preview-synth-client.ts";

// ---------------------------------------------------------------------------
// FakeWebSocket — minimal scriptable WS, mirrors the pattern used in
// voice-mgmt-client.test.ts. Injected via cfg.socketFactory so no real
// socket is touched. Adds an `emit` helper surface (open/ready/audio/done/
// close) tailored to the preview-synth accumulate-until-done flow.
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
  };
  return ws;
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

interface FakeSynth {
  cfg: PreviewSynthConfig;
  /** The URL `synthesizePreview` passed to `socketFactory`, captured on construct. */
  getConnectUrl: () => string | null;
  /** The wrapped fake socket, so tests can inspect recorded `send(...)` args in order. */
  getWs: () => FakeWebSocket | null;
  emit: {
    open: () => Promise<void>;
    ready: () => void;
    audio: (bytes: Uint8Array) => void;
    done: () => void;
    error: (reason: string) => void;
    close: () => Promise<void>;
  };
}

function makeFakeSynth(): FakeSynth {
  let ws: FakeWebSocket | null = null;
  let connectUrl: string | null = null;
  const cfg: PreviewSynthConfig = {
    url: "ws://host.docker.internal:8770",
    connectTimeoutMs: 1000,
    opTimeoutMs: 1000,
    socketFactory: (url: string) => {
      connectUrl = url;
      ws = makeFakeWebSocket();
      return ws as unknown as WebSocket;
    },
  };
  const receiveText = (msg: object) => ws?.onmessage?.({ data: JSON.stringify(msg) } as MessageEvent<string>);
  const receiveBinary = (bytes: Uint8Array) => ws?.onmessage?.({ data: bytes.buffer } as MessageEvent<ArrayBuffer>);
  return {
    cfg,
    getConnectUrl: () => connectUrl,
    getWs: () => ws,
    emit: {
      open: async () => {
        const socket = await waitForSocket(() => ws);
        socket.readyState = 1; // OPEN
        socket.onopen?.({} as Event);
      },
      ready: () => receiveText({ type: "ready", format: "pcm", sample_rate: 24000, voice: "nova" }),
      audio: (bytes) => receiveBinary(bytes),
      done: () => receiveText({ type: "done", requestId: "r1", ttfa_ms: 0, rtf: 0, audio_seconds: 0 }),
      error: (reason) => receiveText({ type: "error", reason }),
      close: async () => {
        const socket = await waitForSocket(() => ws);
        socket.close();
      },
    },
  };
}

describe("synthesizePreview", () => {
  it("logs a safe class when socket construction throws private content", async () => {
    const records: Array<{ message: string; properties: Record<string, unknown> }> = [];
    await configure({
      sinks: {
        test: (record) => records.push({ message: record.message.map(String).join(""), properties: record.properties }),
      },
      loggers: [
        { category: ["sentient", "tts", "preview-synth"], sinks: ["test"], lowestLevel: "debug" },
        { category: "logtape", sinks: [], lowestLevel: "error" },
      ],
      reset: true,
    });
    const sensitiveText = "PRIVATE_PREVIEW_SOCKET_ERROR";
    const cfg: PreviewSynthConfig = {
      url: "ws://127.0.0.1:8770",
      connectTimeoutMs: 1000,
      opTimeoutMs: 1000,
      socketFactory: () => {
        const error = new Error(sensitiveText);
        error.name = sensitiveText;
        throw error;
      },
    };
    try {
      const result = await synthesizePreview(cfg, "nova", "synthetic", new AbortController().signal);
      expect(result).toEqual({ ok: false, error: { kind: "transport" } });
      expect(records.find((record) => record.message === "connect-failed")?.properties).toEqual({
        errorType: "error",
      });
      expect(JSON.stringify(records)).not.toContain(sensitiveText);
    } finally {
      await reset();
    }
  });

  it("accumulates audio frames until done and returns PCM + sampleRate", async () => {
    const { cfg, emit } = makeFakeSynth();
    const p = synthesizePreview(cfg, "nova", "hello", new AbortController().signal);
    await emit.open();
    emit.ready();
    emit.audio(new Uint8Array([1, 2]));
    emit.audio(new Uint8Array([3, 4]));
    emit.done();
    const r = await p;
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(Array.from(r.value.pcm)).toEqual([1, 2, 3, 4]);
      expect(r.value.sampleRate).toBe(24000);
    }
  });

  it("connects with format=pcm + sample_rate=24000 + the requested voice, then sends text before end on open", async () => {
    const { cfg, emit, getConnectUrl, getWs } = makeFakeSynth();
    const p = synthesizePreview(cfg, "nova", "hello", new AbortController().signal);
    await emit.open();
    emit.ready();
    emit.done();
    await p;

    const url = getConnectUrl();
    expect(url).not.toBeNull();
    expect(url).toContain("format=pcm");
    expect(url).toContain("sample_rate=24000");
    expect(url).toContain("voice=nova");

    const ws = getWs();
    expect(ws).not.toBeNull();
    expect(ws?.send).toHaveBeenNthCalledWith(1, textMsg("hello"));
    expect(ws?.send).toHaveBeenNthCalledWith(2, endMsg());
  });

  it("maps a transport failure (socket closes before done) to VoiceOpError transport", async () => {
    const { cfg, emit } = makeFakeSynth();
    const p = synthesizePreview(cfg, "nova", "hello", new AbortController().signal);
    await emit.close();
    const r = await p;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("transport");
  });

  it("maps a service error frame to VoiceOpError service-error", async () => {
    const { cfg, emit } = makeFakeSynth();
    const p = synthesizePreview(cfg, "nova", "hello", new AbortController().signal);
    await emit.open();
    emit.error("bad voiceId");
    const r = await p;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toEqual({ kind: "service-error", reason: "bad voiceId" });
  });

  it("resolves transport error immediately when the signal is already aborted", async () => {
    const { cfg } = makeFakeSynth();
    const controller = new AbortController();
    controller.abort();
    const r = await synthesizePreview(cfg, "nova", "hello", controller.signal);
    expect(r).toEqual({ ok: false, error: { kind: "transport" } });
  });
});
