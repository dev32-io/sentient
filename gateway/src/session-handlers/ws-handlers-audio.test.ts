import { describe, expect, it } from "bun:test";
import type { TurnMode } from "@sentient/protocol";
import type { ServerWebSocket } from "bun";
import type { GatewayServices } from "../bootstrap/create-gateway-services.js";
import { createUserPrincipal } from "../identity/user-principal.js";
import { createGatewayLogger } from "../logging/logger.js";
import { captureDiagnosticRef } from "./capture-diagnostics.js";
import type { SttSession } from "./stt-session.js";
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
