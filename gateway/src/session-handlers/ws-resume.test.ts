// Reconnect gap-fill contract, now over the SESSION's journal (session-model
// spec §2.1/§2.3).
//
// Two things are pinned here and nothing else:
//
//  1. THE WIRE CONTRACT at the gateway↔SDK boundary — the exact
//     `stream.resumed` payloads, and the FRAME ORDER around them. The order
//     is load-bearing client FSM behaviour, not style: both SDKs ungate
//     their connect handshake only on `session.ready`, and their resume
//     cursor advances `lastSeq` on ANY seq-stamped frame. A seq-stamped
//     `session.ready` on the recovered path would jump the cursor past the
//     replay window and the client would drop every replayed frame as a
//     duplicate. Recovered path: raw ready → resumed ack → verbatim replay.
//     Non-recovered path: resumed ack → the caller's ready + snapshot.
//
//  2. THE REGISTRY FSM, INVERTED BY THIS TASK. It used to key journals by
//     SURFACE and enforce a single owner: a second connection presenting a
//     matching epoch got a FRESH journal, because two sockets sharing one seq
//     counter would each see only the seqs it allocated and silently lose the
//     rest. One journal per SESSION inverts that — sharing the counter IS the
//     mechanism, and minting a second journal for one session is what would
//     split the stream. What carries over unchanged is the LEASE discipline: a
//     superseded or duplicated teardown must not park a journal something live
//     is still filling.
//
// Zero cost: FakeWs doubles, an injected clock, no provider/network I/O.

import { describe, expect, it } from "bun:test";
import type { GatewayMessage } from "@sentient/protocol";
import type { ServerWebSocket } from "bun";
import { createFrameJournal } from "./frame-journal.js";
import { createReplayRegistry } from "./replay-registry.js";
import { type SessionData, createEmptySessionData } from "./ws-helpers.js";
import { handleResumeOrFresh } from "./ws-resume.js";

const decoder = new TextDecoder();

const SESSION_A = "s_aaaa";
const SESSION_B = "s_bbbb";

const SESSION_LANE_TYPE = "turn.text.delta" as const;

interface FakeWs {
  data: SessionData;
  sent: (Record<string, unknown> | Uint8Array)[];
  send: (payload: string | Uint8Array) => void;
}

function fakeWs(): FakeWs {
  const data = createEmptySessionData();
  data.sessionId = "test-session";
  const ws: FakeWs = {
    data,
    sent: [],
    send(payload) {
      if (typeof payload === "string") ws.sent.push(JSON.parse(payload) as Record<string, unknown>);
      else ws.sent.push(payload);
    },
  };
  return ws;
}

function asWs(ws: FakeWs): ServerWebSocket<SessionData> {
  return ws as unknown as ServerWebSocket<SessionData>;
}

const readyFrame: GatewayMessage = {
  type: "session.ready",
  sessionId: "test-session",
  audioEncoding: "pcm16",
  inputSampleRate: 16000,
  outputSampleRate: 48000,
  enabledEffects: [],
};

/** A journal already holding three text frames, as if a prior socket filled it. */
function filledJournal() {
  const journal = createFrameJournal({ sessionId: SESSION_A, maxBytes: 1_000_000 });
  for (const body of ["one", "two", "three"]) {
    journal.allocateText(SESSION_LANE_TYPE, (seq) =>
      JSON.stringify({ type: "turn.text.delta", turnId: "t", text: body, seq, epoch: 3 }),
    );
  }
  return journal;
}

const jsonFrames = (ws: FakeWs) => ws.sent.filter((f): f is Record<string, unknown> => !(f instanceof Uint8Array));

describe("handleResumeOrFresh — recovered replay", () => {
  it("emits raw session.ready, then stream.resumed, then the missed frames verbatim", () => {
    const ws = fakeWs();
    const journal = filledJournal();

    const replayedThrough = handleResumeOrFresh({
      ws: asWs(ws),
      sessionId: "test-session",
      journal,
      epoch: 3,
      epochMatches: true,
      resumeParams: { epoch: 3, lastSeq: 1 },
      readyFrame,
    });

    expect(replayedThrough).toBe(3);
    const frames = jsonFrames(ws);
    expect(frames.map((f) => f.type)).toEqual([
      "session.ready",
      "stream.resumed",
      "turn.text.delta",
      "turn.text.delta",
    ]);
    // The ready must NOT carry a seq — it would advance the client cursor past
    // the replay window. It is CONNECTION lane, so it structurally cannot.
    expect(frames[0]?.seq).toBeUndefined();
    expect(frames[1]).toEqual({ type: "stream.resumed", recovered: true, epoch: 3, fromSeq: 2, toSeq: 3 });
    // Replayed frames keep their ORIGINAL seqs — never re-stamped.
    expect(frames.slice(2).map((f) => f.seq)).toEqual([2, 3]);
  });

  it("acks recovered:true with an empty range when the client is already at the head", () => {
    const ws = fakeWs();
    const journal = filledJournal();

    handleResumeOrFresh({
      ws: asWs(ws),
      sessionId: "test-session",
      journal,
      epoch: 3,
      epochMatches: true,
      resumeParams: { epoch: 3, lastSeq: 3 },
      readyFrame,
    });

    const frames = jsonFrames(ws);
    expect(frames.map((f) => f.type)).toEqual(["session.ready", "stream.resumed"]);
    expect(frames[1]).toEqual({ type: "stream.resumed", recovered: true, epoch: 3, fromSeq: 4, toSeq: 3 });
  });

  it("continues the SAME seq space after the replay, so the client never sees a gap", () => {
    const ws = fakeWs();
    const journal = filledJournal();

    const replayedThrough = handleResumeOrFresh({
      ws: asWs(ws),
      sessionId: "test-session",
      journal,
      epoch: 3,
      epochMatches: true,
      resumeParams: { epoch: 3, lastSeq: 3 },
      readyFrame,
    });
    const next = journal.allocateText("turn.completed", (seq) =>
      JSON.stringify({ type: "turn.completed", turnId: "t", seq, epoch: 3 }),
    );

    expect(replayedThrough).toBe(3);
    expect(next.seq).toBe(4);
  });
});

describe("handleResumeOrFresh — fallbacks", () => {
  it("sends stream.resumed{recovered:false} and defers session.ready on an epoch mismatch", () => {
    const ws = fakeWs();
    const journal = createFrameJournal({ sessionId: SESSION_A, maxBytes: 1_000_000 });

    const replayedThrough = handleResumeOrFresh({
      ws: asWs(ws),
      sessionId: "test-session",
      journal,
      epoch: 9,
      epochMatches: false,
      resumeParams: { epoch: 3, lastSeq: 12 },
      readyFrame,
    });

    expect(replayedThrough).toBeNull();
    expect(jsonFrames(ws)).toEqual([{ type: "stream.resumed", recovered: false, epoch: 9 }]);
  });

  it("answers recovered:false when the connection is on a draft and has no session journal", () => {
    // A draft has no session, so there is nothing to replay — but a client that
    // ASKED still needs the ack, or it assumes it is caught up.
    const ws = fakeWs();

    const replayedThrough = handleResumeOrFresh({
      ws: asWs(ws),
      sessionId: "test-session",
      journal: null,
      epoch: 0,
      epochMatches: false,
      resumeParams: { epoch: 3, lastSeq: 12 },
      readyFrame,
    });

    expect(replayedThrough).toBeNull();
    expect(jsonFrames(ws)).toEqual([{ type: "stream.resumed", recovered: false, epoch: 0 }]);
  });

  it("falls back to recovered:false when the client's cursor was evicted", () => {
    const ws = fakeWs();
    const journal = createFrameJournal({ sessionId: SESSION_A, maxBytes: 25 });
    for (let i = 0; i < 5; i++) journal.allocateBinary(() => new Uint8Array(10));

    const replayedThrough = handleResumeOrFresh({
      ws: asWs(ws),
      sessionId: "test-session",
      journal,
      epoch: 3,
      epochMatches: true,
      resumeParams: { epoch: 3, lastSeq: 1 },
      readyFrame,
    });

    expect(replayedThrough).toBeNull();
    expect(jsonFrames(ws)).toEqual([{ type: "stream.resumed", recovered: false, epoch: 3 }]);
  });

  it("sends no stream.resumed at all on a fresh connect that asked for nothing", () => {
    const ws = fakeWs();
    const journal = createFrameJournal({ sessionId: SESSION_A, maxBytes: 1_000_000 });

    const replayedThrough = handleResumeOrFresh({
      ws: asWs(ws),
      sessionId: "test-session",
      journal,
      epoch: 1,
      epochMatches: false,
      resumeParams: undefined,
      readyFrame,
    });

    expect(replayedThrough).toBeNull();
    expect(ws.sent).toEqual([]);
  });
});

describe("ReplayRegistry — one journal per session, N holders", () => {
  it("INVARIANT: a second holder gets the SAME journal and the SAME epoch", () => {
    // The inversion this task made. Two windows on one session MUST share the
    // seq counter — that is what makes "reconnect" and "join" one primitive.
    const registry = createReplayRegistry({ maxBytesPerSession: 1_000_000, retentionMs: 60_000 });
    const first = registry.acquire(SESSION_A);
    first.journal.allocateText(SESSION_LANE_TYPE, () => "x");

    const second = registry.acquire(SESSION_A);

    expect(second.journal).toBe(first.journal);
    expect(second.epoch).toBe(first.epoch);
    expect(second.reused).toBe(true);
  });

  it("keeps distinct sessions in distinct seq spaces", () => {
    const registry = createReplayRegistry({ maxBytesPerSession: 1_000_000, retentionMs: 60_000 });
    const a = registry.acquire(SESSION_A);
    const b = registry.acquire(SESSION_B);

    expect(a.epoch).not.toBe(b.epoch);
    a.journal.allocateText(SESSION_LANE_TYPE, () => "x");
    expect(b.journal.newestSeq).toBe(0);
  });

  it("survives the session's disposal, so a reconnect inside the window replays", () => {
    const registry = createReplayRegistry({ maxBytesPerSession: 1_000_000, retentionMs: 60_000 });
    const first = registry.acquire(SESSION_A);
    first.journal.allocateText(SESSION_LANE_TYPE, () => "x");
    registry.release(first.lease);

    const reconnect = registry.acquire(SESSION_A);

    expect(reconnect.epoch).toBe(first.epoch);
    expect(reconnect.journal.newestSeq).toBe(1);
  });

  it("reclaims a journal once its retention window expires, forcing a fresh epoch", () => {
    let clock = 1_000;
    const registry = createReplayRegistry({
      maxBytesPerSession: 1_000_000,
      retentionMs: 60_000,
      now: () => clock,
    });
    const first = registry.acquire(SESSION_A);
    registry.release(first.lease);

    clock += 60_001;
    const second = registry.acquire(SESSION_A);

    expect(second.reused).toBe(false);
    expect(second.epoch).not.toBe(first.epoch);
    expect(registry.size).toBe(1);
  });

  it("INVARIANT: the retention clock starts only when the LAST holder releases", () => {
    // The multi-window failure this replaces: one window closing must not put a
    // journal its peers are still filling on a countdown.
    let clock = 1_000;
    const registry = createReplayRegistry({
      maxBytesPerSession: 1_000_000,
      retentionMs: 60_000,
      now: () => clock,
    });
    const windowA = registry.acquire(SESSION_A);
    const windowB = registry.acquire(SESSION_A);

    registry.release(windowA.lease);
    clock += 60_001;
    registry.acquire(SESSION_B); // any acquire sweeps first

    expect(registry.size).toBe(2);
    expect(registry.acquire(SESSION_A).epoch).toBe(windowB.epoch);
  });

  it("ignores a release from a lease the entry no longer holds", () => {
    // A duplicated close event, or one arriving after the entry was already
    // swept. It must not start a second countdown under a live journal.
    let clock = 1_000;
    const registry = createReplayRegistry({
      maxBytesPerSession: 1_000_000,
      retentionMs: 60_000,
      now: () => clock,
    });
    const held = registry.acquire(SESSION_A);
    registry.release(held.lease);
    registry.release(held.lease); // duplicate

    const rebound = registry.acquire(SESSION_A);
    registry.release(held.lease); // the stale lease again, now that a new holder exists
    clock += 60_001;
    registry.acquire(SESSION_B);

    expect(registry.size).toBe(2);
    expect(rebound.epoch).toBe(held.epoch);
  });
});

describe("journal replay bytes", () => {
  it("replays the exact bytes that were written, not a re-serialisation", () => {
    const journal = filledJournal();
    const replayed = journal.since(0) ?? [];

    expect(replayed).toHaveLength(3);
    expect(decoder.decode(replayed[0]?.bytes ?? new Uint8Array())).toBe(
      '{"type":"turn.text.delta","turnId":"t","text":"one","seq":1,"epoch":3}',
    );
  });
});
