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
import type { ServerWebSocket } from "bun";
import type { ToolUpdate } from "../runtime/react-loop.js";
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

  it("turnAborted sends BOTH turn.aborted and playback.stop, in that order", () => {
    // Two frames because they drive two different client subsystems: the feed
    // marker (cutoff kind on the bubble) and the audio flush. playback.stop is
    // the ONLY sanctioned audio flush — a new turnId must never cause one.
    const ws = fakeWs();
    emitterFor(ws).turnAborted("turn-1", "barge-in");
    expect(ws.sent).toEqual([
      { type: "turn.aborted", turnId: "turn-1", cutoff: "barge-in" },
      { type: "playback.stop", turnId: "turn-1", reason: "barge-in" },
    ]);
  });

  it("carries the interrupt cutoff kind through both frames", () => {
    const ws = fakeWs();
    emitterFor(ws).turnAborted("turn-1", "interrupt");
    expect(ws.sent).toEqual([
      { type: "turn.aborted", turnId: "turn-1", cutoff: "interrupt" },
      { type: "playback.stop", turnId: "turn-1", reason: "interrupt" },
    ]);
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

  it("audio frame seq is monotonic and starts at 1 (0 means unsequenced to clients)", () => {
    const ws = fakeWs();
    const emitter = emitterFor(ws);
    emitter.audioFrame("turn-1", new Uint8Array([1]));
    emitter.audioFrame("turn-1", new Uint8Array([2]));
    const seqOf = (f: Uint8Array) => Number(new DataView(f.buffer, f.byteOffset).getBigUint64(0, false));
    expect(seqOf(ws.binary[0] as Uint8Array)).toBe(1);
    expect(seqOf(ws.binary[1] as Uint8Array)).toBe(2);
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
