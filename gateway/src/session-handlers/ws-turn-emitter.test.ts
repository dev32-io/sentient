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
import { configure, reset } from "@logtape/logtape";
import { gatewayMessageSchema } from "@sentient/protocol";
import type { ServerWebSocket } from "bun";
import type { TurnEmitter } from "../runtime/turn-emitter.js";
import { createFanOutTurnEmitter } from "./fan-out-emitter.js";
import { createFrameJournal } from "./frame-journal.js";
import { type SessionHandles, createSessionRegistry } from "./session-registry.js";
import { type SessionData, createEmptySessionData } from "./ws-helpers.js";

const BINARY_HEADER_BYTES = 9;
const BINARY_TYPE_AUDIO = 0x01;
/** `ServerWebSocket.readyState` OPEN. */
const WS_OPEN = 1;
const SESSION_ID = "s_00000000000000000000000000000001";

/** The registry insists on handles for a session's first attachment; nothing in
 *  this file reads them (delivery is what is under test, not residency). */
const NO_HANDLES = { dispose() {} } as unknown as SessionHandles;

interface FakeWs {
  data: SessionData;
  /** The fan-out skips a window that is not OPEN, so a double that omits this
   *  receives nothing at all. */
  readyState: number;
  /** Decoded JSON frames, in order, with `seq`/`epoch` stripped. This file
   *  pins the frame SHAPE the emitter builds; the stamping that wraps it is
   *  the session journal's job and is pinned in fan-out-emitter.test.ts. */
  sent: unknown[];
  /** Raw binary frames (audio), in order. */
  binary: Uint8Array[];
  send: (payload: string | Uint8Array) => void;
  getBufferedAmount: () => number;
  close: () => void;
}

function fakeWs(): FakeWs {
  const data = createEmptySessionData();
  data.sessionId = "test-session";
  const ws: FakeWs = {
    data,
    readyState: WS_OPEN,
    sent: [],
    binary: [],
    send(payload) {
      if (typeof payload === "string") {
        const { seq, epoch, ...frame } = JSON.parse(payload) as Record<string, unknown>;
        void seq;
        void epoch;
        ws.sent.push(frame);
        return;
      }
      ws.binary.push(payload);
    },
    getBufferedAmount: () => 0,
    close: () => {},
  };
  return ws;
}

/**
 * One session, one attached and delivering window — the shape every case below
 * asserts on. Wired exactly as production: the emitter writes to the session's
 * fan-out, which allocates from the session journal (session-model task 6).
 *
 * `conversationSnapshot` is wrapped in `directTo` because it is a CONNECTION-
 * lane frame: it answers the window that attached, and the fan-out refuses to
 * emit it with no addressee. That is the production call shape too
 * (session-binding.ts's `completeAttachWithSnapshot`).
 */
function emitterFor(ws: { data: SessionData }): TurnEmitter {
  const registry = createSessionRegistry(() => {});
  const journal = createFrameJournal({ sessionId: SESSION_ID, maxBytes: 1_000_000 });
  const fanOut = createFanOutTurnEmitter({
    registry,
    sessionId: SESSION_ID,
    journal,
    epoch: 7,
    maxLagBytes: 1_000_000,
  });
  // No `hold` — an attachment that was never held is delivering from the
  // start, which is what these construction cases want.
  const attachment = registry.attach(
    SESSION_ID,
    "conn-1",
    ws as unknown as ServerWebSocket<SessionData>,
    () => NO_HANDLES,
  );
  return {
    ...fanOut,
    conversationSnapshot(items) {
      fanOut.directTo(attachment.attachmentId, () => fanOut.conversationSnapshot(items));
    },
  };
}

/** The same wiring as `emitterFor`, with TWO windows attached to the one
 *  session — the shape a session-lane frame has to be proven against, because
 *  a single-window harness cannot tell "broadcast" from "written to the only
 *  socket there is". */
function twoWindowEmitter(a: { data: SessionData }, b: { data: SessionData }): TurnEmitter {
  const registry = createSessionRegistry(() => {});
  const journal = createFrameJournal({ sessionId: SESSION_ID, maxBytes: 1_000_000 });
  const fanOut = createFanOutTurnEmitter({
    registry,
    sessionId: SESSION_ID,
    journal,
    epoch: 7,
    maxLagBytes: 1_000_000,
  });
  registry.attach(SESSION_ID, "conn-a", a as unknown as ServerWebSocket<SessionData>, () => NO_HANDLES);
  registry.attach(SESSION_ID, "conn-b", b as unknown as ServerWebSocket<SessionData>, () => NO_HANDLES);
  return fanOut;
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

  it("PRIVACY: turn completion logs aggregate text size without per-delta content", async () => {
    const records: Array<{ message: string; properties: Record<string, unknown> }> = [];
    await configure({
      sinks: {
        test: (record) => records.push({ message: record.message.map(String).join(""), properties: record.properties }),
      },
      loggers: [
        { category: ["sentient", "ws", "turn-emitter"], sinks: ["test"], lowestLevel: "debug" },
        { category: "logtape", sinks: [], lowestLevel: "error" },
      ],
      reset: true,
    });

    const sensitiveText = "PRIVATE_STREAMED_TEXT_DELTA";
    const sensitiveArgument = "PRIVATE_TOOL_ARGUMENT";
    try {
      const ws = fakeWs();
      const emitter = emitterFor(ws);
      emitter.turnStarted("turn-private", "user");
      emitter.textDelta("turn-private", sensitiveText, "reply-private");
      emitter.turnCompleted("turn-private");
      emitter.audioStart("turn-private", "opus", 48000);
      emitter.audioFrame("turn-private", new Uint8Array([1, 2, 3]));
      emitter.audioFrame("turn-private", new Uint8Array([4, 5]));
      emitter.audioDone("turn-private");
      emitter.audioStart("turn-cancelled", "opus", 48000);
      emitter.audioFrame("turn-cancelled", new Uint8Array([9, 9, 9]));
      emitter.playbackStop("turn-cancelled", "interrupt");
      emitter.audioDone("turn-cancelled");
      emitter.permissionRequest({
        requestId: "request-private",
        toolCallId: "call-private",
        toolName: "example",
        args: { [sensitiveArgument]: sensitiveText },
        description: sensitiveText,
        expiresAtMs: 1000,
      });

      expect(records.find((record) => record.message === "turn-emitter.turn-completed")?.properties).toEqual({
        sessionId: SESSION_ID,
        turnId: "turn-private",
        textChunkCount: 1,
        textChars: sensitiveText.length,
      });
      expect(records.some((record) => record.message === "turn-emitter.text-delta")).toBe(false);
      expect(records.find((record) => record.message === "turn-emitter.audio-done")?.properties).toEqual({
        sessionId: SESSION_ID,
        turnId: "turn-private",
        frameCount: 2,
        audioBytes: 5,
      });
      expect(
        records.find(
          (record) => record.message === "turn-emitter.audio-done" && record.properties.turnId === "turn-cancelled",
        )?.properties,
      ).toEqual({ sessionId: SESSION_ID, turnId: "turn-cancelled", frameCount: 0, audioBytes: 0 });
      expect(records.some((record) => record.message === "turn-emitter.audio-frame")).toBe(false);
      expect(JSON.stringify(records)).not.toContain(sensitiveText);
      expect(JSON.stringify(records)).not.toContain(sensitiveArgument);
    } finally {
      await reset();
    }
  });

  it("turnCompleted sends turn.completed", () => {
    const ws = fakeWs();
    emitterFor(ws).turnCompleted("turn-1");
    expect(ws.sent).toEqual([{ type: "turn.completed", turnId: "turn-1" }]);
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

  it("taskList sends the whole live strip under tasklist.state", () => {
    const ws = fakeWs();
    emitterFor(ws).taskList("turn-1", [
      {
        id: "c1",
        toolName: "get_weather",
        kind: "foreground",
        status: "running",
        argsPreview: "{}",
        startedAtMs: 1000,
      },
    ]);
    expect(ws.sent).toEqual([
      {
        type: "tasklist.state",
        turnId: "turn-1",
        items: [
          {
            id: "c1",
            toolName: "get_weather",
            kind: "foreground",
            status: "running",
            argsPreview: "{}",
            startedAtMs: 1000,
          },
        ],
      },
    ]);
  });

  it("taskList carries turnId: null when only background rows survive a finished turn", () => {
    // The strip's own vocabulary for "no turn owns this list any more" —
    // distinct from an EMPTY list, which is "nothing running at all".
    const ws = fakeWs();
    emitterFor(ws).taskList(null, []);
    expect(ws.sent).toEqual([{ type: "tasklist.state", turnId: null, items: [] }]);
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
    emitter.taskList("turn-1", [
      { id: "c1", toolName: "search", kind: "foreground", status: "running", argsPreview: "{}", startedAtMs: 1000 },
    ]);
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
    emitter.sessionTitle("Kitchen light schedule", "generated");
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
      "tasklist.state",
      "turn.audio.start",
      "turn.audio.done",
      "permission.request",
      "permission.resolved",
      "delegation.progress",
      "session.title",
      "conversation.snapshot",
      "conversation.entry",
      "turn.aborted",
      "playback.stop",
      "turn.completed",
    ]);
  });

  it("INVARIANT: a generated title is emitted on the session lane, not to one connection", () => {
    // Titling (spec §6) renames a conversation for EVERYONE looking at it. The
    // fan-out is real here, not a double: `broadcast` refuses a
    // connection-lane frame outright (frame-lanes.ts), so a `sessionTitle`
    // wired through `directed` would deliver to nobody rather than quietly to
    // one window — and this case would catch it either way.
    const connA = fakeWs();
    const connB = fakeWs();
    twoWindowEmitter(connA, connB).sessionTitle("Kitchen light schedule", "generated");

    const frame = {
      type: "session.title",
      sessionId: SESSION_ID,
      title: "Kitchen light schedule",
      provenance: "generated",
    };
    expect(connA.sent).toContainEqual(frame);
    expect(connB.sent).toContainEqual(frame);
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
