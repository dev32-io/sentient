import { expect, it } from "bun:test";
import { createLocalSttAdapter } from "../adapters/stt/local-stt-adapter.ts";
import type { STTAdapterConfig } from "../adapters/stt/stt-adapter-types.ts";
import type { SessionRuntime } from "../runtime/session-runtime.ts";
import { createSttSession } from "./stt-session.ts";

const waitFor = async (check: () => boolean) => {
  for (let n = 0; n < 200; n++) {
    if (check()) return;
    await Bun.sleep(5);
  }
  throw new Error("condition_timeout");
};

it("real adapter consumer: empty/silent/drop/timeout captures release; next speech commits once", async () => {
  let connections = 0;
  let flushes = 0;
  let bytes = 0;
  const submitted: unknown[] = [];
  const server = Bun.serve<{ index: number }>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, server) {
      if (server.upgrade(req, { data: { index: ++connections } })) return;
      return new Response(null, { status: 400 });
    },
    websocket: {
      open(ws) {
        ws.send(JSON.stringify({ type: "ready" }));
      },
      message(ws, data) {
        if (typeof data !== "string") {
          bytes += data.byteLength;
          return;
        }
        if (JSON.parse(data).type !== "flush") return;
        flushes++;
        if (ws.data.index === 3) return; // hung service: bounded abandonment
        if (ws.data.index < 3) {
          ws.send(JSON.stringify({ type: "turn_rejected", turnIdx: 1, reason: "no_speech" }));
          // Already queued callback must not bleed into next capture.
          ws.send(JSON.stringify({ type: "transcript_ready", turnIdx: 1, text: "stale" }));
        } else {
          ws.send(JSON.stringify({ type: "transcript_ready", turnIdx: 1, text: "synthetic speech" }));
        }
      },
    },
  });
  const config: STTAdapterConfig = {
    url: `ws://127.0.0.1:${server.port}`,
    language: "en",
    pauseRenderLanguage: "en",
    inputSampleRate: 16000,
    audioFormat: "pcm16",
    ttsEchoCooldownMs: 0,
    connectTimeoutMs: 1000,
    finalizeTimeoutMs: 30,
  };
  const runtime = { submit: (value: unknown) => submitted.push(value) } as unknown as SessionRuntime;
  let opened = 0;
  const session = createSttSession({
    sessionId: "synthetic",
    config,
    getRuntime: () => null,
    getRuntimeForInput: async () => runtime,
    factory: (cfg) => {
      const adapter = createLocalSttAdapter(cfg);
      return {
        ...adapter,
        open: async (signal) => {
          await adapter.open(signal);
          opened++;
        },
      };
    },
  });
  try {
    expect(session.start("zero", "manual")).toBe(true);
    await waitFor(() => opened === 1);
    session.end("zero");
    await waitFor(() => flushes === 1);
    await waitFor(() => session.start("silence", "manual"));
    await waitFor(() => opened === 2);
    session.pushFrame("silence", new Uint8Array(4096));
    session.end("silence");
    await waitFor(() => flushes === 2);
    await waitFor(() => session.start("timeout", "manual"));
    await waitFor(() => opened === 3);
    session.end("timeout");
    await waitFor(() => flushes === 3);
    await waitFor(() => session.start("speech", "manual"));
    await waitFor(() => opened === 4);
    expect(submitted).toEqual([]);
    expect(bytes).toBe(4096);
    session.pushFrame("speech", new Uint8Array([1, 2]));
    session.end("speech");
    await waitFor(() => submitted.length === 1);
    expect(submitted).toEqual([{ kind: "conversational", text: "synthetic speech" }]);
    expect(session.start("next", "manual")).toBe(true);
  } finally {
    session.close();
    server.stop(true);
  }
});

it("real adapter rotation drains pre-ready audio before flush; cancel and missing READY recover", async () => {
  let connections = 0;
  const ready: Array<() => void> = [];
  const received: Array<Array<string | number[]>> = [];
  const submitted: unknown[] = [];
  const server = Bun.serve<{ index: number }>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, server) {
      if (server.upgrade(req, { data: { index: connections++ } })) return;
      return new Response(null, { status: 400 });
    },
    websocket: {
      open(ws) {
        const index = ws.data.index;
        received[index] = [];
        ready[index] = () => ws.send(JSON.stringify({ type: "ready" }));
        if (index === 0) ready[index]?.();
      },
      message(ws, data) {
        const index = ws.data.index;
        if (typeof data !== "string") {
          received[index]?.push([...data]);
          return;
        }
        const msg = JSON.parse(data);
        if (msg.type === "turn_mode") received[index]?.push(msg.semantic ? "semantic" : "manual");
        if (msg.type !== "flush") return;
        received[index]?.push("flush");
        ws.send(JSON.stringify({ type: "transcript_ready", turnIdx: 1, text: `capture-${index}` }));
      },
    },
  });
  const config: STTAdapterConfig = {
    url: `ws://127.0.0.1:${server.port}`,
    language: "en",
    pauseRenderLanguage: "en",
    inputSampleRate: 16000,
    audioFormat: "pcm16",
    ttsEchoCooldownMs: 0,
    connectTimeoutMs: 100,
    finalizeTimeoutMs: 1000,
  };
  const runtime = { submit: (value: unknown) => submitted.push(value) } as unknown as SessionRuntime;
  const session = createSttSession({
    sessionId: "deferred-ready",
    config,
    factory: createLocalSttAdapter,
    getRuntime: () => null,
    getRuntimeForInput: async () => runtime,
  });
  try {
    expect(session.start("A", "manual")).toBe(true);
    session.end("A");
    await waitFor(() => submitted.length === 1);
    expect(session.start("B", "manual")).toBe(true);
    session.pushFrame("B", new Uint8Array([1, 2]));
    session.pushFrame("B", new Uint8Array([3, 4]));
    session.end("B");
    await waitFor(() => ready.length === 2); // OPEN, but no READY yet
    expect(received[1]).toEqual([]);
    expect(session.start("overlap", "manual")).toBe(false);
    ready[1]?.();
    await waitFor(() => submitted.length === 2);
    expect(received[1]).toEqual(["manual", [1, 2], [3, 4], "flush"]);

    expect(session.start("cancelled", "manual")).toBe(true);
    session.pushFrame("cancelled", new Uint8Array([5, 6]));
    await waitFor(() => ready.length === 3);
    session.cancel("cancelled");
    expect(session.buffered).toBe(0);
    expect(session.start("D", "manual")).toBe(true);
    session.pushFrame("D", new Uint8Array([7, 8]));
    session.end("D");
    ready[2]?.(); // superseded socket may still try to become ready
    await waitFor(() => ready.length === 4);
    ready[3]?.();
    await waitFor(() => submitted.length === 3);
    expect(received[2]).toEqual([]);
    expect(received[3]).toEqual(["manual", [7, 8], "flush"]);

    expect(session.start("never-ready", "manual")).toBe(true);
    session.pushFrame("never-ready", new Uint8Array([9, 10]));
    await waitFor(() => ready.length === 5); // accepted capture stays active, no End
    await waitFor(() => session.start("recovery", "manual")); // connect deadline frees it
    expect(session.buffered).toBe(0);
    ready[4]?.();
    session.pushFrame("recovery", new Uint8Array([11, 12]));
    session.end("recovery");
    await waitFor(() => ready.length === 6);
    ready[5]?.();
    await waitFor(() => submitted.length === 4);
    expect(received[4]).toEqual([]);
    expect(received[5]).toEqual(["manual", [11, 12], "flush"]);
    expect(submitted).toEqual([0, 1, 3, 5].map((index) => ({ kind: "conversational", text: `capture-${index}` })));
  } finally {
    session.close();
    server.stop(true);
  }
});
