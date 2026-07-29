// Wire-contract regression test for ws-turn-emitter.ts (Plan 3 Task 1, spec
// §7). Pins the exact bytes the 2.0 emitter puts on a client socket, so a
// rename or a dropped field breaks loudly here instead of silently in a
// client SDK. Zero live-key cost — a FakeWs double, no provider/network I/O
// (mirrors ws-auth-gate.test.ts's FakeWs pattern).
//
// This file replaces the Plan 2 version, which pinned `response.turn.started`
// / `response.text.delta` / `response.text.done` and asserted that toolUpdate
// and turnAborted were LOG-ONLY. All five of those facts are deliberately
// obsolete: the frames are renamed to the `turn.*` family, `turn.text.delta`
// now carries `turnId` (its absence was a real bug — two overlapping turns
// could not be routed to the right bubble), and tool-tile + cutoff frames now
// actually reach the client.

import { describe, expect, it } from "bun:test";
import { gatewayMessageSchema } from "@sentient/protocol";
import type { ServerWebSocket } from "bun";
import type { ToolUpdate } from "../runtime/react-loop.js";
import { createFrameJournal } from "./frame-journal.js";
import { type SessionData, createEmptySessionData } from "./ws-helpers.js";
import { createWsTurnEmitter } from "./ws-turn-emitter.js";

const BINARY_HEADER_BYTES = 9;
const BINARY_TYPE_AUDIO = 0x01;

interface FakeWs {
  data: SessionData;
  /** Decoded JSON frames, in order. */
  sent: unknown[];
  /** Raw binary frames (audio), in order. */
  binary: Uint8Array[];
  send: (payload: string | Uint8Array) => void;
}

function fakeWs(): FakeWs {
  const data = createEmptySessionData();
  data.sessionId = "test-session";
  const ws: FakeWs = {
    data,
    sent: [],
    binary: [],
    send(payload) {
      if (typeof payload === "string") {
        ws.sent.push(JSON.parse(payload));
        return;
      }
      ws.binary.push(payload);
    },
  };
  return ws;
}

function emitterFor(ws: FakeWs) {
  return createWsTurnEmitter(ws as unknown as ServerWebSocket<SessionData>);
}

describe("createWsTurnEmitter — 2.0 wire contract", () => {
  it("turnStarted sends turn.started carrying the trigger", () => {
    const ws = fakeWs();
    emitterFor(ws).turnStarted("turn-1", "user");
    expect(ws.sent).toEqual([{ type: "turn.started", turnId: "turn-1", trigger: "user" }]);
  });

  it("turnStarted distinguishes a background-completion follow-up turn", () => {
    const ws = fakeWs();
    emitterFor(ws).turnStarted("turn-2", "background-completion");
    expect(ws.sent).toEqual([{ type: "turn.started", turnId: "turn-2", trigger: "background-completion" }]);
  });

  it("REGRESSION: turn.text.delta carries turnId so overlapping turns route correctly", () => {
    const ws = fakeWs();
    emitterFor(ws).textDelta("turn-1", "hello");
    expect(ws.sent).toEqual([{ type: "turn.text.delta", turnId: "turn-1", text: "hello" }]);
  });

  it("turnCompleted sends turn.completed", () => {
    const ws = fakeWs();
    emitterFor(ws).turnCompleted("turn-1");
    expect(ws.sent).toEqual([{ type: "turn.completed", turnId: "turn-1" }]);
  });

  it("toolUpdate reaches the client as turn.tool.update (no longer log-only)", () => {
    const ws = fakeWs();
    const update: ToolUpdate = {
      toolCallId: "c1",
      toolName: "delegateTask",
      status: "running",
      taskId: "t-9",
      argsPreview: '{"agent":"hermes"}',
    };
    emitterFor(ws).toolUpdate("turn-1", update);
    expect(ws.sent).toHaveLength(1);
    expect(ws.sent[0]).toMatchObject({
      type: "turn.tool.update",
      turnId: "turn-1",
      toolCallId: "c1",
      toolName: "delegateTask",
      status: "running",
      taskId: "t-9",
      argsPreview: '{"agent":"hermes"}',
    });
  });

  it("a running tool update carries no endedAtMs; a terminal one does", () => {
    const ws = fakeWs();
    const emitter = emitterFor(ws);
    emitter.toolUpdate("turn-1", { toolCallId: "c1", toolName: "search", status: "running" });
    emitter.toolUpdate("turn-1", { toolCallId: "c1", toolName: "search", status: "done" });
    expect(ws.sent[0]).not.toHaveProperty("endedAtMs");
    expect(ws.sent[1]).toHaveProperty("endedAtMs");
  });

  it("REGRESSION: startedAtMs is carried from the running update to the terminal one", async () => {
    // The terminal frame must report when the call STARTED, not when it ended.
    // Re-stamping Date.now() on every update leaves startedAtMs === endedAtMs,
    // so every client tile renders a 0ms duration — and because each frame is
    // individually schema-valid, nothing else catches it.
    const ws = fakeWs();
    const emitter = emitterFor(ws);
    emitter.toolUpdate("turn-1", { toolCallId: "c1", toolName: "search", status: "running" });
    await new Promise((r) => setTimeout(r, 12));
    emitter.toolUpdate("turn-1", { toolCallId: "c1", toolName: "search", status: "done" });

    const running = ws.sent[0] as { startedAtMs: number };
    const terminal = ws.sent[1] as { startedAtMs: number; endedAtMs: number };
    expect(terminal.startedAtMs).toBe(running.startedAtMs);
    expect(terminal.endedAtMs).toBeGreaterThan(terminal.startedAtMs);
  });

  it("tracks two concurrent tool calls independently by toolCallId", () => {
    const ws = fakeWs();
    const emitter = emitterFor(ws);
    emitter.toolUpdate("turn-1", { toolCallId: "c1", toolName: "search", status: "running" });
    emitter.toolUpdate("turn-1", { toolCallId: "c2", toolName: "weather", status: "running" });
    emitter.toolUpdate("turn-1", { toolCallId: "c1", toolName: "search", status: "done" });

    const c1Running = ws.sent[0] as { startedAtMs: number };
    const c1Done = ws.sent[2] as { toolCallId: string; startedAtMs: number };
    expect(c1Done.toolCallId).toBe("c1");
    expect(c1Done.startedAtMs).toBe(c1Running.startedAtMs);
  });

  it("a tool update without argsPreview still satisfies the schema (falls back to empty)", () => {
    const ws = fakeWs();
    emitterFor(ws).toolUpdate("turn-1", { toolCallId: "c1", toolName: "search", status: "running" });
    expect(ws.sent).toHaveLength(1);
    expect(ws.sent[0]).toMatchObject({ argsPreview: "" });
  });

  it("turnAborted sends ONLY turn.aborted — the feed marker, never the audio flush", () => {
    // REGRESSION (whole-branch review, Critical 2): these two frames drive two
    // different client subsystems and have two different lifetimes. Speech
    // outlives its turn, so a cancel landing in the audio tail must still be
    // able to flush playback for a turn that is no longer abortable. Fusing
    // them into one emitter method made playback.stop unreachable in exactly
    // that window.
    const ws = fakeWs();
    emitterFor(ws).turnAborted("turn-1", "barge-in");
    expect(ws.sent).toEqual([{ type: "turn.aborted", turnId: "turn-1", cutoff: "barge-in" }]);
  });

  it("playbackStop sends the audio flush on its own, carrying the cutoff as its reason", () => {
    const ws = fakeWs();
    emitterFor(ws).playbackStop("turn-1", "interrupt");
    expect(ws.sent).toEqual([{ type: "playback.stop", turnId: "turn-1", reason: "interrupt" }]);
  });

  it("conversationSnapshot sends the whole committed feed under conversation.snapshot", () => {
    const ws = fakeWs();
    emitterFor(ws).conversationSnapshot([
      { entryId: "1", ts: 1000, kind: "user", channel: "text", content: "hi" },
      { entryId: "2", ts: 1001, kind: "assistant", content: "hello" },
    ]);
    expect(ws.sent).toEqual([
      {
        type: "conversation.snapshot",
        items: [
          { entryId: "1", ts: 1000, kind: "user", channel: "text", content: "hi" },
          { entryId: "2", ts: 1001, kind: "assistant", content: "hello" },
        ],
      },
    ]);
  });

  it("conversationEntry carries the entry's own turnId as the join key", () => {
    // The item deliberately strips turn plumbing; the FRAME carries it, and
    // both client connectors re-attach it so a committed assistant entry joins
    // its live streaming bubble by id instead of by ts-window guessing.
    const ws = fakeWs();
    emitterFor(ws).conversationEntry({ entryId: "7", ts: 1002, kind: "assistant", content: "done" }, "turn-1");
    expect(ws.sent).toEqual([
      {
        type: "conversation.entry",
        turnId: "turn-1",
        item: { entryId: "7", ts: 1002, kind: "assistant", content: "done" },
      },
    ]);
  });

  it("conversationEntry omits turnId entirely when the entry has no originating turn", () => {
    const ws = fakeWs();
    emitterFor(ws).conversationEntry({ entryId: "7", ts: 1002, kind: "user", channel: "text", content: "hi" });
    expect(ws.sent[0]).not.toHaveProperty("turnId");
  });

  it("audioStart and audioDone bracket the stream as JSON frames", () => {
    const ws = fakeWs();
    const emitter = emitterFor(ws);
    emitter.audioStart("turn-1", "opus", 48000);
    emitter.audioDone("turn-1");
    expect(ws.sent).toEqual([
      { type: "turn.audio.start", turnId: "turn-1", encoding: "opus", sampleRate: 48000 },
      { type: "turn.audio.done", turnId: "turn-1" },
    ]);
  });

  it("audioFrame travels as binary with a 9-byte header, not JSON", () => {
    const ws = fakeWs();
    emitterFor(ws).audioFrame("turn-1", new Uint8Array([0xaa, 0xbb]));
    expect(ws.sent).toEqual([]); // nothing on the JSON path
    expect(ws.binary).toHaveLength(1);
    const frame = ws.binary[0] as Uint8Array;
    expect(frame.byteLength).toBe(BINARY_HEADER_BYTES + 2);
    expect(frame[8]).toBe(BINARY_TYPE_AUDIO);
    expect(Array.from(frame.slice(BINARY_HEADER_BYTES))).toEqual([0xaa, 0xbb]);
  });

  it("stamps the unsequenced sentinel 0 when the connection has no frame journal", () => {
    // `createEmptySessionData()` leaves `journal` null — the pre-configure
    // window. Both client SDKs treat header seq 0 as "unsequenced" and pass it
    // through without dedup, so the audio still plays; it just cannot be
    // replayed. Monotonic allocation is pinned by the Task 10 block below,
    // against a connection that actually has a journal.
    const ws = fakeWs();
    const emitter = emitterFor(ws);
    emitter.audioFrame("turn-1", new Uint8Array([1]));
    emitter.audioFrame("turn-1", new Uint8Array([2]));
    const seqOf = (f: Uint8Array) => Number(new DataView(f.buffer, f.byteOffset).getBigUint64(0, false));
    expect(seqOf(ws.binary[0] as Uint8Array)).toBe(0);
    expect(seqOf(ws.binary[1] as Uint8Array)).toBe(0);
  });

  it("permissionRequest puts the mediated argument VALUES on the wire", () => {
    // Values must reach the client: the user approves what will really happen,
    // not just a tool name (spec §2.2 — authorization is value-aware).
    const ws = fakeWs();
    emitterFor(ws).permissionRequest({
      requestId: "r1",
      toolCallId: "c1",
      toolName: "ha_call_service",
      args: { entity_id: "light.kitchen" },
      description: "Turn on the kitchen light",
      expiresAtMs: 1_800_000_000_000,
    });
    expect(ws.sent).toEqual([
      {
        type: "permission.request",
        requestId: "r1",
        toolCallId: "c1",
        toolName: "ha_call_service",
        args: { entity_id: "light.kitchen" },
        description: "Turn on the kitchen light",
        expiresAtMs: 1_800_000_000_000,
      },
    ]);
  });

  it("permissionResolved reports a timeout so a client dialog is never orphaned", () => {
    const ws = fakeWs();
    emitterFor(ws).permissionResolved({ requestId: "r1", outcome: "timeout" });
    expect(ws.sent).toEqual([{ type: "permission.resolved", requestId: "r1", outcome: "timeout" }]);
  });

  it("delegationProgress sends the dispatching turnId, not the live one", () => {
    const ws = fakeWs();
    emitterFor(ws).delegationProgress({
      taskId: "t-9",
      turnId: "turn-1",
      agent: "hermes",
      status: "done",
      note: "finished",
    });
    expect(ws.sent).toEqual([
      {
        type: "delegation.progress",
        taskId: "t-9",
        turnId: "turn-1",
        agent: "hermes",
        status: "done",
        note: "finished",
      },
    ]);
  });

  it("CONTRACT: every JSON frame the emitter can produce survives gatewayMessageSchema", () => {
    // Definition-of-done pin. `sendGatewayFrame` writes `parsed.data`, so a
    // re-parse can never fail — the load-bearing assertion is the TYPE SET:
    // a frame the emitter builds wrongly (misnamed/missing field) fails
    // validation and is DROPPED, so it simply goes missing from `sent`. That
    // is the exact silent failure this case exists to catch; comparing the
    // full set also catches a method that starts emitting an extra frame.
    const ws = fakeWs();
    const emitter = emitterFor(ws);
    emitter.turnStarted("turn-1", "user");
    emitter.textDelta("turn-1", "hi");
    emitter.toolUpdate("turn-1", { toolCallId: "c1", toolName: "search", status: "running", argsPreview: "{}" });
    emitter.audioStart("turn-1", "pcm", 48000);
    emitter.audioFrame("turn-1", new Uint8Array([1])); // binary — must NOT appear below
    emitter.audioDone("turn-1");
    emitter.permissionRequest({
      requestId: "r1",
      toolCallId: "c1",
      toolName: "sendMessage",
      args: { to: "+1555" },
      description: "Send a message",
      expiresAtMs: 1_800_000_000_000,
    });
    emitter.permissionResolved({ requestId: "r1", outcome: "allowed" });
    emitter.delegationProgress({ taskId: "t-9", turnId: "turn-1", agent: "hermes", status: "running" });
    emitter.conversationSnapshot([{ entryId: "1", ts: 1000, kind: "user", channel: "text", content: "hi" }]);
    emitter.conversationEntry({ entryId: "2", ts: 1001, kind: "assistant", content: "hello" }, "turn-1");
    emitter.turnAborted("turn-1", "interrupt");
    emitter.playbackStop("turn-1", "interrupt");
    emitter.turnCompleted("turn-1");

    for (const frame of ws.sent) {
      expect(gatewayMessageSchema.safeParse(frame).success, JSON.stringify(frame)).toBe(true);
    }
    expect(ws.sent.map((f) => (f as { type: string }).type)).toEqual([
      "turn.started",
      "turn.text.delta",
      "turn.tool.update",
      "turn.audio.start",
      "turn.audio.done",
      "permission.request",
      "permission.resolved",
      "delegation.progress",
      "conversation.snapshot",
      "conversation.entry",
      "turn.aborted",
      "playback.stop",
      "turn.completed",
    ]);
  });

  it("a schema-violating frame is dropped, not thrown and not sent", () => {
    // The turn's promise chain runs detached from the WS handler, so throwing
    // here would surface as an unhandled rejection. sampleRate must be a
    // positive int; 0 fails the schema.
    const ws = fakeWs();
    expect(() => emitterFor(ws).audioStart("turn-1", "opus", 0)).not.toThrow();
    expect(ws.sent).toEqual([]);
  });

  it("a send failure (socket already closed) is caught, not thrown", () => {
    const ws = fakeWs();
    ws.send = () => {
      throw new Error("socket closed");
    };
    expect(() => emitterFor(ws).textDelta("turn-1", "x")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Plan 3 Task 10 — seq/epoch stamping.
//
// Wire-contract regression. Both client SDKs run ONE resume cursor
// (shared/web-sdk/src/resume-cursor.ts, shared/mobile-sdk/.../ResumeCursor.kt)
// and feed it from BOTH the JSON path and the binary path. If the gateway
// ever draws JSON seqs and audio-header seqs from two counters, the client
// silently drops roughly half the stream as "already applied". This pins the
// single-seq-space invariant at the only place it can be violated.
// ---------------------------------------------------------------------------

interface SequencedFakeWs {
  data: SessionData;
  sentText: Record<string, unknown>[];
  sentBinary: Uint8Array[];
  send: (payload: string | Uint8Array) => void;
}

function sequencedFakeWs(epoch = 7): SequencedFakeWs {
  const data = createEmptySessionData();
  data.sessionId = "test-session";
  data.journal = createFrameJournal({ maxBytes: 1_000_000 });
  data.epoch = epoch;
  const ws: SequencedFakeWs = {
    data,
    sentText: [],
    sentBinary: [],
    send(payload) {
      if (typeof payload === "string") ws.sentText.push(JSON.parse(payload));
      else ws.sentBinary.push(payload);
    },
  };
  return ws;
}

function headerSeq(frame: Uint8Array): number {
  return Number(new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getBigUint64(0, false));
}

describe("createWsTurnEmitter — seq/epoch stamping (Task 10)", () => {
  it("stamps every JSON frame with a monotonic seq and the connection epoch", () => {
    const ws = sequencedFakeWs(7);
    const emitter = createWsTurnEmitter(ws as unknown as ServerWebSocket<SessionData>);

    emitter.turnStarted("turn-1", "user");
    emitter.textDelta("turn-1", "hi");
    emitter.turnCompleted("turn-1");

    expect(ws.sentText.map((f) => f.seq)).toEqual([1, 2, 3]);
    expect(ws.sentText.map((f) => f.epoch)).toEqual([7, 7, 7]);
  });

  it("draws JSON and binary audio seqs from ONE monotonic space", () => {
    const ws = sequencedFakeWs();
    const emitter = createWsTurnEmitter(ws as unknown as ServerWebSocket<SessionData>);

    emitter.audioStart("turn-1", "opus", 48000); // seq 1 (JSON)
    emitter.audioFrame("turn-1", new Uint8Array([1])); // seq 2 (binary)
    emitter.audioFrame("turn-1", new Uint8Array([2])); // seq 3 (binary)
    emitter.audioDone("turn-1"); // seq 4 (JSON)

    expect(ws.sentText.map((f) => f.seq)).toEqual([1, 4]);
    expect(ws.sentBinary.map(headerSeq)).toEqual([2, 3]);
    expect(ws.sentBinary[0]?.byteLength).toBe(BINARY_HEADER_BYTES + 1);
  });

  it("journals every frame it sends so a later resume can replay them verbatim", () => {
    const ws = sequencedFakeWs();
    const emitter = createWsTurnEmitter(ws as unknown as ServerWebSocket<SessionData>);

    emitter.turnStarted("turn-1", "user");
    emitter.audioFrame("turn-1", new Uint8Array([9]));

    const replayed = ws.data.journal?.since(0) ?? [];
    expect(replayed.map((f) => f.seq)).toEqual([1, 2]);
    expect(replayed.map((f) => f.kind)).toEqual(["text", "binary"]);
    expect(JSON.parse(new TextDecoder().decode(replayed[0]?.bytes ?? new Uint8Array()))).toEqual(
      ws.sentText[0] as Record<string, unknown>,
    );
  });

  it("sends unstamped and unjournaled when the connection has no journal yet", () => {
    const ws = sequencedFakeWs();
    ws.data.journal = null;
    ws.data.epoch = 0;
    const emitter = createWsTurnEmitter(ws as unknown as ServerWebSocket<SessionData>);

    emitter.turnStarted("turn-1", "user");

    expect(ws.sentText[0]?.seq).toBeUndefined();
    expect(ws.sentText[0]?.epoch).toBeUndefined();
  });
});
