// Pins the WS-layer voice routing (spec §6). Inbound BINARY frames are mic
// audio and go to the STT uplink — a separate path from the outbound binary
// TTS stream, and one that must NEVER open pre-auth (a security boundary:
// unauthenticated bytes must not reach a service on the operator's host).
// `audio.start` / `audio.end` are protocol frames whose payloads (turnMode)
// must survive the hop. FakeWs double, no network.

import { describe, expect, it } from "bun:test";
import type { TurnMode } from "@sentient/protocol";
import type { ServerWebSocket } from "bun";
import type { GatewayServices } from "../bootstrap/create-gateway-services.js";
import { createUserPrincipal } from "../identity/user-principal.js";
import type { SttSession } from "./stt-session.js";
import { handleWebSocketMessage } from "./ws-handlers.js";
import { type SessionData, createEmptySessionData } from "./ws-helpers.js";

interface SpyStt {
  session: SttSession;
  starts: TurnMode[];
  ends: number;
  frames: number;
  closes: number;
  discards: number;
}

function spyStt(): SpyStt {
  const spy: SpyStt = {
    starts: [],
    ends: 0,
    frames: 0,
    closes: 0,
    discards: 0,
    session: {
      start: (mode) => {
        spy.starts.push(mode);
      },
      end: () => {
        spy.ends += 1;
      },
      pushFrame: () => {
        spy.frames += 1;
      },
      suppressInputFor: () => {},
      buffered: 0,
      discard: () => {
        spy.discards += 1;
      },
      close: () => {
        spy.closes += 1;
      },
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

// Only the `stt` field is read by the branches under test.
const noSttServices = { stt: null } as unknown as GatewayServices;

describe("ws-handlers — inbound binary (mic audio)", () => {
  it("routes a binary frame to the STT uplink once authed", async () => {
    const spy = spyStt();
    const ws = fakeWs(true, spy.session);

    await handleWebSocketMessage(ws as unknown as ServerWebSocket<SessionData>, Buffer.from([1, 2, 3]), noSttServices);

    expect(spy.frames).toBe(1);
  });

  it("drops a binary frame that arrives before auth completes", async () => {
    const spy = spyStt();
    const ws = fakeWs(false, spy.session);

    await handleWebSocketMessage(ws as unknown as ServerWebSocket<SessionData>, Buffer.from([1, 2, 3]), noSttServices);

    expect(spy.frames).toBe(0);
    expect(ws.sent).toEqual([]);
  });
});

describe("ws-handlers — audio.start / audio.end", () => {
  it("relays the audio.start turnMode to the STT uplink", async () => {
    const spy = spyStt();
    const ws = fakeWs(true, spy.session);

    await handleWebSocketMessage(
      ws as unknown as ServerWebSocket<SessionData>,
      JSON.stringify({ type: "audio.start", turnMode: "manual" }),
      noSttServices,
    );

    expect(spy.starts).toEqual(["manual"]);
  });

  it("defaults a turnMode-less audio.start to semantic (back-compat clients)", async () => {
    const spy = spyStt();
    const ws = fakeWs(true, spy.session);

    await handleWebSocketMessage(
      ws as unknown as ServerWebSocket<SessionData>,
      JSON.stringify({ type: "audio.start" }),
      noSttServices,
    );

    expect(spy.starts).toEqual(["semantic"]);
  });

  it("forwards audio.end to the STT uplink", async () => {
    const spy = spyStt();
    const ws = fakeWs(true, spy.session);

    await handleWebSocketMessage(
      ws as unknown as ServerWebSocket<SessionData>,
      JSON.stringify({ type: "audio.end" }),
      noSttServices,
    );

    expect(spy.ends).toBe(1);
  });

  it("is a safe no-op when STT is not configured on this gateway", async () => {
    const ws = fakeWs(true, null);

    await expect(
      handleWebSocketMessage(
        ws as unknown as ServerWebSocket<SessionData>,
        JSON.stringify({ type: "audio.start", turnMode: "semantic" }),
        noSttServices,
      ),
    ).resolves.toBeUndefined();

    expect(ws.data.stt).toBeNull();
  });
});
