// The command choke point's contract (session-model spec §3.7, §3.6, §8.3).
//
// Every case here is a WIRE or SECURITY invariant that only becomes reachable
// once a connection can change which session it is a window on. Before session
// switching existed, "the session this command is for" and "the session this
// socket is on" could not disagree; they can now, and the whole of §3.7 is the
// rule for what happens when they do.

import { describe, expect, it } from "bun:test";
import type { ServerWebSocket } from "bun";
import type { SessionWorkSignals } from "../runtime/session-retention.js";
import type { SessionRuntime } from "../runtime/session-runtime.js";
import { type InboundCommand, mediateCommand } from "./command-mediator.js";
import { createInputArbiter } from "./input-arbiter.js";
import { type SessionHandles, type SessionRegistry, createSessionRegistry } from "./session-registry.js";
import type { SttSession } from "./stt-session.js";
import { type SessionData, createEmptySessionData } from "./ws-helpers.js";

const IDLE_WORK: SessionWorkSignals = {
  isTurnInFlight: false,
  hasPendingForegroundTool: false,
  hasOutstandingPrompt: false,
  hasAuxiliaryTaskInFlight: false,
  newestBackgroundTaskStartedAtMs: null,
};

const ARBITRATION_WINDOW_MS = 500;
/** `ServerWebSocket.readyState` OPEN. */
const WS_OPEN = 1;

interface FakeWs {
  data: SessionData;
  sent: Record<string, unknown>[];
  send: (s: string) => void;
  readyState: number;
  getBufferedAmount: () => number;
}

function fakeWs(connectionId: string): FakeWs {
  const data = createEmptySessionData();
  data.sessionId = connectionId;
  data.authState = "authed";
  const ws: FakeWs = {
    data,
    sent: [],
    readyState: WS_OPEN,
    getBufferedAmount: () => 0,
    send(s) {
      ws.sent.push(JSON.parse(s) as Record<string, unknown>);
    },
  };
  return ws;
}

function asWs(w: FakeWs): ServerWebSocket<SessionData> {
  return w as unknown as ServerWebSocket<SessionData>;
}

/** A spoken input's STT uplink, narrowed to what the mediator touches. */
interface FakeStt {
  session: SttSession;
  buffered: () => number;
  discarded: () => number;
}

function fakeStt(bufferedBytes: number): FakeStt {
  let buffered = bufferedBytes;
  let discards = 0;
  const session = {
    get buffered() {
      return buffered;
    },
    discard() {
      discards += 1;
      buffered = 0;
    },
  } as unknown as SttSession;
  return { session, buffered: () => buffered, discarded: () => discards };
}

interface Harness {
  registry: SessionRegistry;
  /** Attach [w] to [sessionId] and park the attachment on the socket, exactly
   *  as `bindSessionRuntime` does in production. */
  attach(w: FakeWs, sessionId: string): void;
  detach(w: FakeWs): void;
}

function harness(): Harness {
  const handlesBySession = new Map<string, SessionHandles>();

  function buildFor(sessionId: string): SessionHandles {
    const handles = {
      runtime: { dispose() {}, cutUnheardSpeech() {} } as unknown as SessionRuntime,
      permissions: { denyAll() {} } as unknown as SessionHandles["permissions"],
      work: IDLE_WORK,
      voicePrefs: null,
      arbiter: createInputArbiter(sessionId, ARBITRATION_WINDOW_MS),
      dispose() {},
    } as unknown as SessionHandles;
    handlesBySession.set(sessionId, handles);
    return handles;
  }

  // Never disposes: these cases re-attach across sessions and a disposal
  // between them would hand the second attach a fresh arbiter, silently
  // defeating the arbitration cases.
  const registry = createSessionRegistry(() => {});

  return {
    registry,
    attach(w, sessionId) {
      const attachment = registry.attach(sessionId, w.data.sessionId ?? "", asWs(w), () => buildFor(sessionId));
      w.data.attachment = attachment;
    },
    detach(w) {
      const attachment = w.data.attachment;
      if (attachment === null) return;
      registry.detach(attachment.sessionId, attachment.attachmentId);
      w.data.attachment = null;
    },
  };
}

function textInput(sessionId?: string, generation?: number): InboundCommand {
  return {
    type: "text.input",
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(generation === undefined ? {} : { generation }),
  };
}

describe("mediateCommand — a command names its session (§3.7)", () => {
  it("INVARIANT: a command carrying a stale attachment generation is dropped, not applied", () => {
    const h = harness();
    const conn = fakeWs("conn-a");
    h.attach(conn, "s_1");
    const stale = conn.data.attachment;
    h.detach(conn);
    h.attach(conn, "s_2");

    const verdict = mediateCommand(textInput("s_1", stale?.generation), asWs(conn), h.registry);

    expect(verdict).toEqual({ accept: false, reason: "stale_generation" });
  });

  it("INVARIANT: a re-attach to the SAME session still invalidates the previous generation", () => {
    // The counter-case for the tempting wrong form — comparing `sessionId`
    // alone. It passes the case above (s_1 ≠ s_2) and fails here, which is
    // exactly the re-`session.configure` a reload performs.
    const h = harness();
    const conn = fakeWs("conn-a");
    h.attach(conn, "s_1");
    const first = conn.data.attachment;
    h.detach(conn);
    h.attach(conn, "s_1");

    expect(conn.data.attachment?.generation).not.toBe(first?.generation);
    expect(mediateCommand(textInput("s_1", first?.generation), asWs(conn), h.registry)).toEqual({
      accept: false,
      reason: "stale_generation",
    });
  });

  it("INVARIANT: a command naming a session while the connection is attached to none is refused", () => {
    const h = harness();
    const conn = fakeWs("conn-a");
    h.attach(conn, "s_1");
    const stale = conn.data.attachment;
    h.detach(conn);

    expect(mediateCommand(textInput("s_1", stale?.generation), asWs(conn), h.registry)).toEqual({
      accept: false,
      reason: "stale_generation",
    });
  });

  it("INVARIANT: half a binding is refused — a sessionId with no generation proves nothing", () => {
    const h = harness();
    const conn = fakeWs("conn-a");
    h.attach(conn, "s_1");

    expect(mediateCommand(textInput("s_1", undefined), asWs(conn), h.registry)).toEqual({
      accept: false,
      reason: "stale_generation",
    });
  });

  it("accepts a command whose binding matches the connection's current attachment", () => {
    const h = harness();
    const conn = fakeWs("conn-a");
    h.attach(conn, "s_1");
    const live = conn.data.attachment;

    expect(mediateCommand(textInput("s_1", live?.generation), asWs(conn), h.registry)).toEqual({
      accept: true,
      sessionId: "s_1",
      attachmentId: live?.attachmentId ?? "",
    });
  });

  it("INVARIANT: an unbound text.input on a DRAFT is accepted — it is the frame that mints the session", () => {
    // A draft has no session and no attachment, so it has nothing to stamp.
    // Refusing here would make it impossible to ever start a conversation.
    const h = harness();
    const conn = fakeWs("conn-a");

    expect(mediateCommand(textInput(), asWs(conn), h.registry)).toEqual({
      accept: true,
      sessionId: null,
      attachmentId: null,
    });
  });

  it("INVARIANT: a permission answer from a connection in no session is refused, not silently dropped", () => {
    const h = harness();
    const conn = fakeWs("conn-a");

    expect(mediateCommand({ type: "permission.response" }, asWs(conn), h.registry)).toEqual({
      accept: false,
      reason: "not_attached",
    });
  });
});

describe("mediateCommand — a rejection is explicit, never silence", () => {
  it("CONTRACT: a rejected command produces a rejection frame the client can act on", () => {
    const h = harness();
    const conn = fakeWs("conn-a");
    h.attach(conn, "s_1");
    const stale = conn.data.attachment;
    h.detach(conn);
    h.attach(conn, "s_2");
    conn.sent.length = 0;

    mediateCommand({ ...textInput("s_1", stale?.generation), pendingId: "p-9" }, asWs(conn), h.registry);

    expect(conn.sent).toContainEqual(
      expect.objectContaining({ type: "command.rejected", reason: "stale_generation", pendingId: "p-9" }),
    );
  });

  it("CONTRACT: an accepted command sends no rejection frame", () => {
    const h = harness();
    const conn = fakeWs("conn-a");
    h.attach(conn, "s_1");
    conn.sent.length = 0;

    mediateCommand(textInput("s_1", conn.data.attachment?.generation), asWs(conn), h.registry);

    expect(conn.sent).toHaveLength(0);
  });
});

describe("mediateCommand — a stale command discards its STT buffer", () => {
  it("INVARIANT: a stale-generation command resets STT rather than committing a partial utterance", () => {
    const h = harness();
    const conn = fakeWs("conn-a");
    const stt = fakeStt(4096);
    conn.data.stt = stt.session;
    h.attach(conn, "s_1");
    const stale = conn.data.attachment;
    h.detach(conn);
    h.attach(conn, "s_2");

    mediateCommand({ type: "audio.end", sessionId: "s_1", generation: stale?.generation }, asWs(conn), h.registry);

    expect(stt.discarded()).toBe(1);
    expect(stt.buffered()).toBe(0);
  });

  it("INVARIANT: losing an input RACE keeps the mic buffer — the speaker is still in this session", () => {
    // The counter-case for discarding on every refusal. `session_busy` means
    // "someone beat you to this dispatch", not "your audio belongs to another
    // conversation"; cutting the uplink there would truncate the next thing
    // the person says.
    const h = harness();
    const a = fakeWs("conn-a");
    const b = fakeWs("conn-b");
    const stt = fakeStt(4096);
    b.data.stt = stt.session;
    h.attach(a, "s_1");
    h.attach(b, "s_1");

    mediateCommand(textInput("s_1", a.data.attachment?.generation), asWs(a), h.registry, 1000);
    mediateCommand(textInput("s_1", b.data.attachment?.generation), asWs(b), h.registry, 1000);

    expect(stt.discarded()).toBe(0);
    expect(stt.buffered()).toBe(4096);
  });
});

describe("mediateCommand — input arbitration (§8.3)", () => {
  it("INVARIANT: two inputs racing at one dispatch resolve to the first; the second is refused busy", () => {
    const h = harness();
    const a = fakeWs("conn-a");
    const b = fakeWs("conn-b");
    h.attach(a, "s_1");
    h.attach(b, "s_1");

    const first = mediateCommand(textInput("s_1", a.data.attachment?.generation), asWs(a), h.registry, 1000);
    const second = mediateCommand(textInput("s_1", b.data.attachment?.generation), asWs(b), h.registry, 1000);

    expect(first.accept).toBe(true);
    expect(second).toEqual({ accept: false, reason: "session_busy" });
  });

  it("INVARIANT: input arriving during a running turn steers it rather than being refused", () => {
    // The pair that makes the case above correct. Arbitration is for
    // simultaneous contention only — a floor lock for the whole turn would let
    // one speaker own the session until their reply finished.
    const h = harness();
    const a = fakeWs("conn-a");
    const b = fakeWs("conn-b");
    h.attach(a, "s_1");
    h.attach(b, "s_1");

    mediateCommand(textInput("s_1", a.data.attachment?.generation), asWs(a), h.registry, 1000);
    const later = mediateCommand(
      textInput("s_1", b.data.attachment?.generation),
      asWs(b),
      h.registry,
      1000 + ARBITRATION_WINDOW_MS,
    );

    expect(later.accept).toBe(true);
  });

  it("INVARIANT: the window that won keeps talking — a fast second message from it is not refused", () => {
    // The counter-case for "refuse any second input inside the window". A
    // person double-sending in one tab is not contention with anybody.
    const h = harness();
    const a = fakeWs("conn-a");
    h.attach(a, "s_1");

    mediateCommand(textInput("s_1", a.data.attachment?.generation), asWs(a), h.registry, 1000);
    const again = mediateCommand(textInput("s_1", a.data.attachment?.generation), asWs(a), h.registry, 1100);

    expect(again.accept).toBe(true);
  });

  it("INVARIANT: a Stop from the losing window is never arbitrated — cancellation is honoured from anywhere", () => {
    // Barge-in and interrupt abort the SHARED turn for everyone attached
    // (§8.3). Refusing B's Stop because A is mid-input would leave the only
    // person who can see the runaway reply unable to stop it.
    const h = harness();
    const a = fakeWs("conn-a");
    const b = fakeWs("conn-b");
    h.attach(a, "s_1");
    h.attach(b, "s_1");

    mediateCommand(textInput("s_1", a.data.attachment?.generation), asWs(a), h.registry, 1000);
    const stop = mediateCommand(
      { type: "interrupt", sessionId: "s_1", generation: b.data.attachment?.generation },
      asWs(b),
      h.registry,
      1000,
    );

    expect(stop.accept).toBe(true);
  });
});

describe("mediateCommand — credential lifetime (§3.6)", () => {
  it("SECURITY: a command on a connection whose token has expired is refused", () => {
    const h = harness();
    const conn = fakeWs("conn-a");
    h.attach(conn, "s_1");
    conn.data.tokenExpiresAtMs = 999;

    expect(mediateCommand(textInput("s_1", conn.data.attachment?.generation), asWs(conn), h.registry, 1000)).toEqual({
      accept: false,
      reason: "credential_expired",
    });
  });

  it("SECURITY: an expired credential DETACHES the window, so it stops receiving session content too", () => {
    // §3.6 covers reads, not only writes. Merely refusing the command would
    // leave a revoked principal reading every frame the session fans out.
    const h = harness();
    const conn = fakeWs("conn-a");
    h.attach(conn, "s_1");
    conn.data.tokenExpiresAtMs = 999;

    mediateCommand(textInput("s_1", conn.data.attachment?.generation), asWs(conn), h.registry, 1000);

    expect(h.registry.subscribers("s_1")).toHaveLength(0);
    expect(conn.data.attachment).toBeNull();
  });

  it("accepts a command on a connection whose token is still valid", () => {
    const h = harness();
    const conn = fakeWs("conn-a");
    h.attach(conn, "s_1");
    conn.data.tokenExpiresAtMs = 5000;

    expect(
      mediateCommand(textInput("s_1", conn.data.attachment?.generation), asWs(conn), h.registry, 1000).accept,
    ).toBe(true);
  });
});
