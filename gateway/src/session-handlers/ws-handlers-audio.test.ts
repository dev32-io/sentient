import { describe, expect, it } from "bun:test";
import type { TurnMode } from "@sentient/protocol";
import type { ServerWebSocket } from "bun";
import { createLocalSttAdapter } from "../adapters/stt/local-stt-adapter.js";
import type { STTAdapter, STTEvent } from "../adapters/stt/stt-adapter-types.js";
import type { GatewayServices } from "../bootstrap/create-gateway-services.js";
import { createUserPrincipal } from "../identity/user-principal.js";
import { createGatewayLogger } from "../logging/logger.js";
import type { SessionRuntime } from "../runtime/session-runtime.js";
import { captureDiagnosticRef } from "./capture-diagnostics.js";
import { createMicEchoGuard } from "./mic-echo-guard.js";
import { type SttSession, createSttSession } from "./stt-session.js";
import { handleWebSocketMessage } from "./ws-handlers.js";
import { type SessionData, createEmptySessionData } from "./ws-helpers.js";

interface SpyStt {
  session: SttSession;
  starts: { id: string; mode: TurnMode }[];
  ends: string[];
  cancels: string[];
  frames: { id: string; bytes: number }[];
}

function spyStt(): SpyStt {
  const spy: SpyStt = {
    starts: [],
    ends: [],
    cancels: [],
    frames: [],
    session: {
      start: (id, mode) => {
        spy.starts.push({ id, mode });
        return true;
      },
      end: (id) => spy.ends.push(id),
      cancel: (id) => spy.cancels.push(id),
      pushFrame: (id, bytes) => spy.frames.push({ id, bytes: bytes.byteLength }),
      suppressInputFor: () => {},
      buffered: 0,
      discard: () => {},
      close: () => {},
    },
  };
  return spy;
}

interface FakeWs {
  data: SessionData;
  sent: unknown[];
  send: (s: string) => void;
}

function fakeWs(authed: boolean, stt: SttSession | null): FakeWs {
  const data = createEmptySessionData();
  data.sessionId = "test-session";
  data.authState = authed ? "authed" : "pending";
  data.principal = createUserPrincipal("u_deadbeef", "adult", "home");
  data.stt = stt;
  const ws: FakeWs = {
    data,
    sent: [],
    send(s) {
      ws.sent.push(JSON.parse(s));
    },
  };
  return ws;
}

const noSttServices = { stt: null } as unknown as GatewayServices;
const route = (ws: FakeWs, frame: unknown): Promise<void> =>
  handleWebSocketMessage(ws as unknown as ServerWebSocket<SessionData>, JSON.stringify(frame), noSttServices);

describe("ws-handlers — capture-aware audio", () => {
  it("routes binary only while the identified capture is open", async () => {
    const spy = spyStt();
    const ws = fakeWs(true, spy.session);
    await route(ws, { type: "audio.start", captureId: "cap-1", turnMode: "manual" });
    await handleWebSocketMessage(ws as unknown as ServerWebSocket<SessionData>, Buffer.from([1, 2, 3]), noSttServices);
    await route(ws, { type: "audio.cancel", captureId: "cap-1" });
    await handleWebSocketMessage(ws as unknown as ServerWebSocket<SessionData>, Buffer.from([4]), noSttServices);

    expect(spy.frames).toEqual([{ id: "cap-1", bytes: 3 }]);
  });

  it("drops binary before auth", async () => {
    const spy = spyStt();
    const ws = fakeWs(false, spy.session);
    await handleWebSocketMessage(ws as unknown as ServerWebSocket<SessionData>, Buffer.from([1]), noSttServices);
    expect(spy.frames).toEqual([]);
  });

  it("keeps legacy captureId-less start/end behavior and semantic default", async () => {
    const spy = spyStt();
    const ws = fakeWs(true, spy.session);
    await route(ws, { type: "audio.start" });
    const id = spy.starts[0]?.id;
    expect(spy.starts[0]?.mode).toBe("semantic");
    expect(id).toStartWith("legacy-");
    await route(ws, { type: "audio.end" });
    expect(spy.ends).toEqual([id as string]);
  });

  it("manual Send commits only the matching capture", async () => {
    const spy = spyStt();
    const ws = fakeWs(true, spy.session);
    await route(ws, { type: "audio.start", captureId: "manual-1", turnMode: "manual" });
    await route(ws, { type: "audio.end", captureId: "stale" });
    expect(spy.ends).toEqual([]);
    await route(ws, { type: "audio.end", captureId: "manual-1" });
    expect(spy.ends).toEqual(["manual-1"]);
  });

  it("first terminal wins and stale terminal cannot affect the next capture", async () => {
    const spy = spyStt();
    const ws = fakeWs(true, spy.session);
    await route(ws, { type: "audio.start", captureId: "old", turnMode: "manual" });
    await route(ws, { type: "audio.cancel", captureId: "old" });
    await route(ws, { type: "audio.end", captureId: "old" });
    await route(ws, { type: "audio.start", captureId: "new", turnMode: "semantic" });
    await route(ws, { type: "audio.cancel", captureId: "old" });

    expect(spy.cancels).toEqual(["old"]);
    expect(spy.ends).toEqual([]);
    expect(ws.data.audioCapture?.id).toBe("new");
  });

  it("rejects overlapping starts", async () => {
    const spy = spyStt();
    const ws = fakeWs(true, spy.session);
    await route(ws, { type: "audio.start", captureId: "one" });
    await route(ws, { type: "audio.start", captureId: "two" });
    expect(spy.starts).toHaveLength(1);
    expect(ws.data.audioCapture?.id).toBe("one");
    expect(ws.sent).toEqual([{ type: "command.rejected", command: "audio.start", reason: "session_busy" }]);
  });

  it("keeps duplicate same-capture start idempotent without rejecting or resetting its gate", async () => {
    const spy = spyStt();
    const ws = fakeWs(true, spy.session);
    await route(ws, { type: "audio.start", captureId: "one" });
    await handleWebSocketMessage(ws as unknown as ServerWebSocket<SessionData>, Buffer.from([1]), noSttServices);
    await route(ws, { type: "interrupt" });
    await route(ws, { type: "audio.start", captureId: "one" });
    await handleWebSocketMessage(ws as unknown as ServerWebSocket<SessionData>, Buffer.from([2]), noSttServices);
    expect(spy.starts).toHaveLength(1);
    expect(spy.frames).toEqual([
      { id: "one", bytes: 1 },
      { id: "one", bytes: 1 },
    ]);
    expect(ws.sent).toEqual([]);
    expect(spy.cancels).toEqual([]);
    expect(spy.ends).toEqual([]);
  });

  it("refuses a new start during A finalization, then accepts B after A terminal", async () => {
    let deliver: ((event: STTEvent | null) => void) | undefined;
    const submissions: unknown[] = [];
    let flushes = 0;
    let closes = 0;
    let sentFrames = 0;
    const adapter: STTAdapter = {
      open: async () => {},
      send: () => {
        sentFrames += 1;
      },
      close: async () => {
        closes += 1;
        deliver?.(null);
      },
      suppressInputFor: () => {},
      setTurnMode: () => {},
      endUtterance: () => {
        flushes += 1;
      },
      async *events() {
        while (true) {
          const event = await new Promise<STTEvent | null>((resolve) => {
            deliver = resolve;
          });
          if (event === null) return;
          yield event;
        }
      },
    };
    const runtime = { submit: (stimulus: unknown) => submissions.push(stimulus) } as unknown as SessionRuntime;
    const ws = fakeWs(true, null);
    ws.data.stt = createSttSession({
      sessionId: "test-session",
      factory: () => adapter,
      config: {
        url: "ws://localhost:0",
        language: "en",
        pauseRenderLanguage: "en",
        inputSampleRate: 16000,
        ttsEchoCooldownMs: 0,
        connectTimeoutMs: 100,
        finalizeTimeoutMs: 1000,
        audioFormat: "opus",
      },
      getRuntime: () => runtime,
      getRuntimeForInput: async () => runtime,
    });
    try {
      await route(ws, { type: "audio.start", captureId: "A", turnMode: "manual" });
      // Let adapter open and begin consuming events before End.
      await new Promise((resolve) => setTimeout(resolve, 5));
      await route(ws, { type: "audio.end", captureId: "A" });
      expect(flushes).toBe(1);
      await route(ws, { type: "interrupt" }); // Next Cube hold must not discard committing A.
      expect(closes).toBe(0);
      expect(flushes).toBe(1);
      await route(ws, { type: "audio.start", captureId: "B", turnMode: "manual" });
      expect(ws.data.audioCapture).toBeNull();
      expect(ws.sent).toEqual([{ type: "command.rejected", command: "audio.start", reason: "session_busy" }]);
      await handleWebSocketMessage(ws as unknown as ServerWebSocket<SessionData>, Buffer.from([1]), noSttServices);
      expect(sentFrames).toBe(0);
      deliver?.({ type: "transcript", turnIdx: 1, text: "completed" });
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(submissions).toEqual([{ kind: "conversational", text: "completed" }]);
      await route(ws, { type: "audio.start", captureId: "B", turnMode: "manual" });
      expect(ws.data.audioCapture?.id).toBe("B");
      expect(ws.sent).toHaveLength(1);
    } finally {
      ws.data.stt.close();
    }
  });

  it("is a safe no-op when STT is not configured", async () => {
    const ws = fakeWs(true, null);
    await expect(route(ws, { type: "audio.start", captureId: "cap-1" })).resolves.toBeUndefined();
  });

  it("logs only a bounded fingerprint for content-shaped capture IDs", async () => {
    const lines: string[] = [];
    await createGatewayLogger({ logLevel: "debug", testSink: (line) => lines.push(line) });
    const spy = spyStt();
    const ws = fakeWs(true, spy.session);
    const untrusted = "Bearer-super-secret household-message";

    await route(ws, { type: "audio.start", captureId: untrusted, turnMode: "manual" });
    await route(ws, { type: "audio.end", captureId: `${untrusted}-stale` });
    await route(ws, { type: "audio.cancel", captureId: untrusted });

    const output = lines.join("\n");
    expect(output).not.toContain(untrusted);
    expect(output).toContain(captureDiagnosticRef(untrusted));
    expect(output).not.toContain("captureId=");
  });
});

// Real adapter and SttSession suppression, with transport/clock only faked.
// No STT service, TTS provider, model, or real audio is used.
for (const liveAdapter of [false, true]) {
  it(`authorized interrupt clears post-Done echo guard (${liveAdapter ? "live adapter" : "next adapter"})`, async () => {
    let now = 1000;
    const originalNow = performance.now;
    const originalSocket = globalThis.WebSocket;
    const sockets: TestSocket[] = [];
    class TestSocket {
      static OPEN = 1;
      readyState = 0;
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent<string>) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      bytes: number[][] = [];
      constructor(readonly url: string) {
        sockets.push(this);
        queueMicrotask(() => {
          if (this.readyState !== 0) return;
          this.readyState = TestSocket.OPEN;
          this.onopen?.(new Event("open"));
          this.onmessage?.({ data: '{"type":"ready"}' } as MessageEvent<string>);
        });
      }
      send(data: string | Uint8Array) {
        if (typeof data !== "string") this.bytes.push([...data]);
      }
      close() {
        this.readyState = 3;
        this.onclose?.({ code: 1000, reason: "", wasClean: true } as CloseEvent);
      }
    }
    performance.now = () => now;
    globalThis.WebSocket = TestSocket as unknown as typeof WebSocket;
    const stt = (id: string) =>
      createSttSession({
        sessionId: id,
        factory: createLocalSttAdapter,
        config: {
          url: `ws://fixture/${id}`,
          language: "en",
          pauseRenderLanguage: "en",
          inputSampleRate: 16000,
          audioFormat: "opus",
          ttsEchoCooldownMs: 2500,
          connectTimeoutMs: 1000,
        },
        getRuntime: () => null,
        getRuntimeForInput: async () => null,
      });
    const requester = stt("requester");
    const peer = stt("peer");
    const ws = fakeWs(true, requester);
    const peerWs = fakeWs(true, peer);
    let runtimeInterrupts = 0;
    // Cover both absent runtime and already-Done runtime with nothing to abort.
    if (liveAdapter)
      ws.data.runtime = {
        interrupt: () => {
          ++runtimeInterrupts;
        },
      } as unknown as SessionRuntime;
    const received = (id: string) =>
      sockets.filter((socket) => socket.url.includes(`/${id}`)).flatMap((socket) => socket.bytes);
    const frame = (target: FakeWs) =>
      handleWebSocketMessage(target as unknown as ServerWebSocket<SessionData>, Buffer.from([1]), noSttServices);
    try {
      await route(peerWs, { type: "audio.start", captureId: "continuous", turnMode: "semantic" });
      await Bun.sleep(1);
      createMicEchoGuard(() => [requester, peer], 2500, "fixture").onTtsStart("short-reply");
      now = 1700; // Short reply already Done/drained; original guard expires at 3500.
      if (liveAdapter) {
        await route(ws, { type: "audio.start", captureId: "first-attempt", turnMode: "manual" });
        await Bun.sleep(1);
        await frame(ws);
        expect(received("requester")).toEqual([]); // Manual start alone never bypasses guard.
        await route(ws, { type: "interrupt", sessionId: "stale", attachmentGeneration: 1 });
        expect(ws.sent).toContainEqual({ type: "command.rejected", command: "interrupt", reason: "stale_generation" });
        expect(runtimeInterrupts).toBe(0);
        // Existing security refusal retires capture, but must not clear deadline.
        await route(ws, { type: "audio.start", captureId: "next", turnMode: "manual" });
        await Bun.sleep(1);
        await frame(ws);
        expect(received("requester")).toEqual([]);
      }
      await route(ws, { type: "interrupt" });
      await route(ws, { type: "audio.start", captureId: "next", turnMode: "manual" });
      await Bun.sleep(1);
      expect(ws.data.audioCapture?.id).toBe("next");
      expect(runtimeInterrupts).toBe(liveAdapter ? 1 : 0);
      for (const at of [1700, 2100, 2500, 2899]) {
        now = at;
        await frame(ws);
        await frame(peerWs);
      }
      expect(received("requester")).toEqual([[1], [1], [1], [1]]);
      expect(received("peer")).toEqual([]); // Other window/semantic capture stays guarded.
      now = 3500;
      await frame(peerWs);
      expect(received("peer")).toEqual([[1]]);
    } finally {
      requester.close();
      peer.close();
      globalThis.WebSocket = originalSocket;
      performance.now = originalNow;
    }
  });
}
