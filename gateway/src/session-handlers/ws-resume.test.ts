// Reconnect gap-fill contract (Plan 3 Task 10, spec §11 slice 6).
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
//     Non-recovered path: resumed ack → stamped ready.
//
//  2. THE REGISTRY FSM — epoch mismatch forces a fresh stream, and a
//     detached journal is reclaimed once its retention window expires.
//
// Zero cost: FakeWs doubles, an injected clock, no provider/network I/O.

import { describe, expect, it } from "bun:test";
import type { GatewayMessage } from "@sentient/protocol";
import type { ServerWebSocket } from "bun";
import { createFrameJournal } from "./frame-journal.js";
import { createReplayRegistry } from "./replay-registry.js";
import { type SessionData, createEmptySessionData } from "./ws-helpers.js";
import { handleResumeOrFresh } from "./ws-resume.js";
import { sendGatewayFrame } from "./ws-send.js";

const decoder = new TextDecoder();

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
  const journal = createFrameJournal({ maxBytes: 1_000_000 });
  for (const body of ["one", "two", "three"]) {
    journal.allocateText((seq) => JSON.stringify({ type: "turn.text.delta", turnId: "t", text: body, seq, epoch: 3 }));
  }
  return journal;
}

const jsonFrames = (ws: FakeWs) => ws.sent.filter((f): f is Record<string, unknown> => !(f instanceof Uint8Array));

describe("handleResumeOrFresh — recovered replay", () => {
  it("emits raw session.ready, then stream.resumed, then the missed frames verbatim", () => {
    const ws = fakeWs();
    const journal = filledJournal();
    ws.data.journal = journal;
    ws.data.epoch = 3;

    const readySent = handleResumeOrFresh({
      ws: asWs(ws),
      sessionId: "test-session",
      surfaceKey: "u_deadbeef::surface-a",
      journal,
      epoch: 3,
      resumed: true,
      resumeParams: { epoch: 3, lastSeq: 1 },
      readyFrame,
    });

    expect(readySent).toBe(true);
    const frames = jsonFrames(ws);
    expect(frames.map((f) => f.type)).toEqual([
      "session.ready",
      "stream.resumed",
      "turn.text.delta",
      "turn.text.delta",
    ]);
    // The raw ready must NOT carry a seq — it would advance the client cursor
    // past the replay window.
    expect(frames[0]?.seq).toBeUndefined();
    expect(frames[1]).toEqual({ type: "stream.resumed", recovered: true, epoch: 3, fromSeq: 2, toSeq: 3 });
    // Replayed frames keep their ORIGINAL seqs — never re-stamped.
    expect(frames.slice(2).map((f) => f.seq)).toEqual([2, 3]);
  });

  it("acks recovered:true with an empty range when the client is already at the head", () => {
    const ws = fakeWs();
    const journal = filledJournal();
    ws.data.journal = journal;
    ws.data.epoch = 3;

    handleResumeOrFresh({
      ws: asWs(ws),
      sessionId: "test-session",
      surfaceKey: "u_deadbeef::surface-a",
      journal,
      epoch: 3,
      resumed: true,
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
    ws.data.journal = journal;
    ws.data.epoch = 3;

    handleResumeOrFresh({
      ws: asWs(ws),
      sessionId: "test-session",
      surfaceKey: "u_deadbeef::surface-a",
      journal,
      epoch: 3,
      resumed: true,
      resumeParams: { epoch: 3, lastSeq: 3 },
      readyFrame,
    });
    sendGatewayFrame(asWs(ws), { type: "turn.completed", turnId: "t" });

    const last = jsonFrames(ws).at(-1);
    expect(last).toEqual({ type: "turn.completed", turnId: "t", seq: 4, epoch: 3 });
  });
});

describe("handleResumeOrFresh — fallbacks", () => {
  it("sends stream.resumed{recovered:false} and defers session.ready on an epoch mismatch", () => {
    const ws = fakeWs();
    const journal = createFrameJournal({ maxBytes: 1_000_000 });
    ws.data.journal = journal;
    ws.data.epoch = 9;

    const readySent = handleResumeOrFresh({
      ws: asWs(ws),
      sessionId: "test-session",
      surfaceKey: "u_deadbeef::surface-a",
      journal,
      epoch: 9,
      resumed: false,
      resumeParams: { epoch: 3, lastSeq: 12 },
      readyFrame,
    });

    expect(readySent).toBe(false);
    expect(jsonFrames(ws)).toEqual([{ type: "stream.resumed", recovered: false, epoch: 9 }]);
  });

  it("falls back to recovered:false when the client's cursor was evicted", () => {
    const ws = fakeWs();
    const journal = createFrameJournal({ maxBytes: 25 });
    for (let i = 0; i < 5; i++) journal.allocateBinary(() => new Uint8Array(10));
    ws.data.journal = journal;
    ws.data.epoch = 3;

    const readySent = handleResumeOrFresh({
      ws: asWs(ws),
      sessionId: "test-session",
      surfaceKey: "u_deadbeef::surface-a",
      journal,
      epoch: 3,
      resumed: true,
      resumeParams: { epoch: 3, lastSeq: 1 },
      readyFrame,
    });

    expect(readySent).toBe(false);
    expect(jsonFrames(ws)).toEqual([{ type: "stream.resumed", recovered: false, epoch: 3 }]);
  });

  it("sends no stream.resumed at all on a fresh connect that asked for nothing", () => {
    const ws = fakeWs();
    const journal = createFrameJournal({ maxBytes: 1_000_000 });
    ws.data.journal = journal;
    ws.data.epoch = 1;

    const readySent = handleResumeOrFresh({
      ws: asWs(ws),
      sessionId: "test-session",
      surfaceKey: "u_deadbeef::surface-a",
      journal,
      epoch: 1,
      resumed: false,
      resumeParams: undefined,
      readyFrame,
    });

    expect(readySent).toBe(false);
    expect(ws.sent).toEqual([]);
  });
});

describe("ReplayRegistry — epoch + retention FSM", () => {
  it("returns the same journal and epoch when the resume epoch matches", () => {
    const registry = createReplayRegistry({ maxBytesPerSurface: 1_000_000, retentionMs: 60_000 });
    const first = registry.acquire("u_deadbeef::surface-a", undefined);
    first.journal.allocateText(() => "x");
    registry.release("u_deadbeef::surface-a");

    const second = registry.acquire("u_deadbeef::surface-a", first.epoch);

    expect(second.resumed).toBe(true);
    expect(second.epoch).toBe(first.epoch);
    expect(second.journal.newestSeq).toBe(1);
  });

  it("mints a fresh journal and a NEW epoch when the resume epoch does not match", () => {
    const registry = createReplayRegistry({ maxBytesPerSurface: 1_000_000, retentionMs: 60_000 });
    const first = registry.acquire("u_deadbeef::surface-a", undefined);
    first.journal.allocateText(() => "x");
    registry.release("u_deadbeef::surface-a");

    const second = registry.acquire("u_deadbeef::surface-a", first.epoch + 99);

    expect(second.resumed).toBe(false);
    expect(second.epoch).not.toBe(first.epoch);
    expect(second.journal.newestSeq).toBe(0);
  });

  it("keeps surfaces of the same user isolated from each other", () => {
    const registry = createReplayRegistry({ maxBytesPerSurface: 1_000_000, retentionMs: 60_000 });
    const tabA = registry.acquire("u_deadbeef::surface-a", undefined);
    const tabB = registry.acquire("u_deadbeef::surface-b", undefined);

    expect(tabA.epoch).not.toBe(tabB.epoch);
    tabA.journal.allocateText(() => "x");
    expect(tabB.journal.newestSeq).toBe(0);
  });

  it("reclaims a detached journal once the retention window expires", () => {
    let clock = 1_000;
    const registry = createReplayRegistry({
      maxBytesPerSurface: 1_000_000,
      retentionMs: 60_000,
      now: () => clock,
    });
    const first = registry.acquire("u_deadbeef::surface-a", undefined);
    registry.release("u_deadbeef::surface-a");

    clock += 60_001;
    const second = registry.acquire("u_deadbeef::surface-a", first.epoch);

    expect(second.resumed).toBe(false);
    expect(registry.size).toBe(1);
  });

  it("discard drops the journal outright so a later resume cannot match it", () => {
    const registry = createReplayRegistry({ maxBytesPerSurface: 1_000_000, retentionMs: 60_000 });
    const first = registry.acquire("u_deadbeef::surface-a", undefined);
    registry.discard("u_deadbeef::surface-a");

    expect(registry.size).toBe(0);
    expect(registry.acquire("u_deadbeef::surface-a", first.epoch).resumed).toBe(false);
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
