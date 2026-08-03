// The lane table is a CONTRACT, and these cases are the only thing that keeps
// it one: a frame type added to `gatewayMessageSchema` with no lane is a
// silent leak (private frame fanned out) or a silent hole in the replay window
// (conversation content never journaled), and neither shows up in a browser
// drive.

import { describe, expect, it } from "bun:test";
import { gatewayMessageSchema } from "@sentient/protocol";
import { ALL_GATEWAY_MESSAGE_TYPES, frameLane } from "./frame-lanes.js";

describe("frameLane", () => {
  it("CONTRACT: every gateway frame type is assigned a lane", () => {
    for (const type of ALL_GATEWAY_MESSAGE_TYPES) {
      expect(() => frameLane(type)).not.toThrow();
    }
  });

  it("enumerates exactly the wire union — the list is read from zod, never hand-maintained", () => {
    expect(ALL_GATEWAY_MESSAGE_TYPES).toHaveLength(gatewayMessageSchema.options.length);
  });

  it("throws rather than defaulting for a type with no lane", () => {
    expect(() => frameLane("not.a.frame" as never)).toThrow(/no lane assignment/);
  });

  it("keeps the connection's own frames off the session lane", () => {
    // The leak this split exists to prevent: one window's auth result, ready
    // handshake, resume coordination or pong reaching another window.
    for (const type of ["auth.ok", "auth.error", "session.ready", "stream.resumed", "pong"] as const) {
      expect(frameLane(type)).toBe("connection");
    }
  });

  it("keeps conversation.snapshot on the connection lane and conversation.entry on the session lane", () => {
    // A snapshot REPLACES a client's committed mirror, so it is an answer to
    // the connection that attached; the incremental entry is the conversation.
    expect(frameLane("conversation.snapshot")).toBe("connection");
    expect(frameLane("conversation.entry")).toBe("session");
  });

  it("puts the turn stream, audio bracketing and permission mediation on the session lane", () => {
    for (const type of [
      "turn.started",
      "turn.text.delta",
      "turn.completed",
      "turn.aborted",
      "turn.tool.update",
      "turn.audio.start",
      "turn.audio.done",
      "playback.stop",
      "permission.request",
      "permission.resolved",
      "delegation.progress",
      "session.title",
    ] as const) {
      expect(frameLane(type)).toBe("session");
    }
  });
});
