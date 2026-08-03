// Where a session's frames go, now that its runtime outlives any one socket
// (session-model plan task 5).
//
// Three invariants, each with a failure this module exists to prevent:
//
//   - EVERY attached window receives a session frame. Without it "N windows
//     onto one conversation" is a claim with no mechanism behind it.
//   - A window that closes cannot strand the session. The emitter used to
//     capture the socket that BUILT the runtime, so that window closing while
//     a peer stayed attached wrote every later frame to a dead socket — for
//     the life of the session, across the survivor's reloads, because the
//     survivor's reconnect attaches to those same handles rather than
//     rebuilding them.
//   - `conversation.snapshot` reaches ONLY the connection that asked for it.
//     It replaces the client's committed mirror wholesale, which both SDKs
//     treat as a session boundary, and it carries no paired `session.switched`
//     — so fanning it out can make a peer inside its own resume window drop
//     the session id it is holding.

import { describe, expect, it } from "bun:test";
import type { ServerWebSocket } from "bun";
import { createSessionWindows } from "./session-windows.js";
import { type SessionData, createEmptySessionData } from "./ws-helpers.js";

/** `ServerWebSocket.readyState`. */
const WS_OPEN = 1;
const WS_CLOSING = 2;

const SESSION_ID = `s_${"0".repeat(31)}1`;

interface FakeWindow {
  data: SessionData;
  readyState: number;
  sent: Record<string, unknown>[];
  send: (payload: string) => void;
}

function fakeWindow(connectionId: string): FakeWindow {
  const data = createEmptySessionData();
  data.sessionId = connectionId;
  const ws: FakeWindow = {
    data,
    readyState: WS_OPEN,
    sent: [],
    send(payload) {
      ws.sent.push(JSON.parse(payload) as Record<string, unknown>);
    },
  };
  return ws;
}

function asWs(ws: FakeWindow): ServerWebSocket<SessionData> {
  return ws as unknown as ServerWebSocket<SessionData>;
}

describe("SessionWindows", () => {
  it("INVARIANT: a session frame reaches every attached window", () => {
    const windows = createSessionWindows(SESSION_ID);
    const a = fakeWindow("conn-a");
    const b = fakeWindow("conn-b");
    windows.add("at_a", asWs(a));
    windows.add("at_b", asWs(b));

    const delivered = windows.broadcast({ type: "turn.text.delta", turnId: "t1", text: "hi" });

    expect(delivered).toBe(2);
    expect(a.sent).toEqual([{ type: "turn.text.delta", turnId: "t1", text: "hi" }]);
    expect(b.sent).toEqual(a.sent);
  });

  it("INVARIANT: the window that built the session closing does not strand the survivor", () => {
    // The wedge this module exists for. The emitter used to capture ONE
    // socket — the first attachment's — so this sequence silenced B forever.
    const windows = createSessionWindows(SESSION_ID);
    const builder = fakeWindow("conn-builder");
    const survivor = fakeWindow("conn-survivor");
    windows.add("at_builder", asWs(builder));
    windows.add("at_survivor", asWs(survivor));

    windows.remove("at_builder");
    const delivered = windows.broadcast({ type: "turn.completed", turnId: "t1" });

    expect(delivered).toBe(1);
    expect(survivor.sent).toEqual([{ type: "turn.completed", turnId: "t1" }]);
    expect(builder.sent).toEqual([]);
  });

  it("INVARIANT: a window whose socket is closing is skipped, and its peers still receive", () => {
    // Liveness is read at WRITE time, not latched at attach: a detach is a
    // close-EVENT away, and one dying socket must not cost the session a frame.
    const windows = createSessionWindows(SESSION_ID);
    const dying = fakeWindow("conn-dying");
    const live = fakeWindow("conn-live");
    windows.add("at_dying", asWs(dying));
    windows.add("at_live", asWs(live));
    dying.readyState = WS_CLOSING;

    const delivered = windows.broadcast({ type: "turn.completed", turnId: "t1" });

    expect(delivered).toBe(1);
    expect(dying.sent).toEqual([]);
    expect(live.sent).toHaveLength(1);
  });

  it("INVARIANT: a directed frame reaches only the attachment it names", () => {
    const windows = createSessionWindows(SESSION_ID);
    const asking = fakeWindow("conn-asking");
    const peer = fakeWindow("conn-peer");
    windows.add("at_asking", asWs(asking));
    windows.add("at_peer", asWs(peer));

    windows.directTo("at_asking", () => {
      windows.broadcast({ type: "conversation.snapshot", items: [] });
    });

    expect(asking.sent).toEqual([{ type: "conversation.snapshot", items: [] }]);
    expect(peer.sent).toEqual([]);
  });

  it("INVARIANT: the direction is lifted when the emission returns, even if it throws", () => {
    // A latched redirect would silently unicast the REST of the session's
    // frames to one window — a failure with no symptom until someone notices
    // a second window has gone quiet.
    const windows = createSessionWindows(SESSION_ID);
    const asking = fakeWindow("conn-asking");
    const peer = fakeWindow("conn-peer");
    windows.add("at_asking", asWs(asking));
    windows.add("at_peer", asWs(peer));

    expect(() =>
      windows.directTo("at_asking", () => {
        throw new Error("projection failed");
      }),
    ).toThrow();
    windows.broadcast({ type: "turn.completed", turnId: "t1" });

    expect(peer.sent).toEqual([{ type: "turn.completed", turnId: "t1" }]);
  });
});
