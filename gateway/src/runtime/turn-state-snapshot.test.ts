// The in-flight turn, as a window that was not there needs to see it.
//
// This tracker is the ONLY thing standing between a mid-turn joiner and an
// incoherent screen: deltas for a turn it never saw start, an Interrupt button
// that never arms, a tool tile that never appears, a permission dialog it can
// answer but cannot see. Every case below is a transient prerequisite whose
// absence has exactly one of those symptoms.

import { describe, expect, it } from "bun:test";
import { createLoggingTurnEmitter } from "./turn-emitter.js";
import { EMPTY_TURN_STATE, captureTurnStateSnapshot, createTurnStateTracker } from "./turn-state-snapshot.js";

function tracked() {
  const tracker = createTurnStateTracker("s_1");
  return { tracker, emit: tracker.wrap(createLoggingTurnEmitter()) };
}

describe("turn-state tracker", () => {
  it("reports no turn before one starts", () => {
    const { tracker } = tracked();
    expect(tracker.snapshot()).toEqual(EMPTY_TURN_STATE);
  });

  it("carries the active turn and its trigger", () => {
    const { tracker, emit } = tracked();
    emit.turnStarted("t1", "background-completion");
    const snap = tracker.snapshot();
    expect(snap.activeTurnId).toBe("t1");
    expect(snap.trigger).toBe("background-completion");
  });

  it("accumulates every delta of the active turn", () => {
    const { tracker, emit } = tracked();
    emit.turnStarted("t1", "user");
    emit.textDelta("t1", "one ");
    emit.textDelta("t1", "two");
    expect(tracker.snapshot().textSoFar).toBe("one two");
  });

  it("ignores a delta for a turn that is not the active one", () => {
    // Back-to-back turns overlap on the wire (§7.2); folding a stale turn's
    // tail into the live one would show the joiner the wrong bubble's text.
    const { tracker, emit } = tracked();
    emit.turnStarted("t1", "user");
    emit.textDelta("t0", "stale");
    expect(tracker.snapshot().textSoFar).toBe("");
  });

  it("clears the turn when it completes", () => {
    const { tracker, emit } = tracked();
    emit.turnStarted("t1", "user");
    emit.textDelta("t1", "hi");
    emit.turnCompleted("t1");
    expect(tracker.snapshot().activeTurnId).toBeNull();
    expect(tracker.snapshot().textSoFar).toBe("");
  });

  it("clears the turn when it is cut off", () => {
    const { tracker, emit } = tracked();
    emit.turnStarted("t1", "user");
    emit.turnAborted("t1", "barge-in");
    expect(tracker.snapshot().activeTurnId).toBeNull();
  });

  it("keeps the audio bracket after the turn ends, because speech outlives its turn", () => {
    // A joiner arriving while the tail still drains needs the bracket to
    // attribute the remaining bytes — binary frames carry no turnId.
    const { tracker, emit } = tracked();
    emit.turnStarted("t1", "user");
    emit.audioStart("t1", "opus", 48000);
    emit.turnCompleted("t1");
    expect(tracker.snapshot().audio).toEqual({ turnId: "t1", encoding: "opus", sampleRate: 48000 });
  });

  it("drops the audio bracket when the stream ends", () => {
    const { tracker, emit } = tracked();
    emit.audioStart("t1", "opus", 48000);
    emit.audioDone("t1");
    expect(tracker.snapshot().audio).toBeNull();
  });

  it("drops the audio bracket when playback is flushed", () => {
    // `playback.stop` means the client just dropped everything queued; handing
    // a joiner a bracket for audio nobody is playing arms a spinner forever.
    const { tracker, emit } = tracked();
    emit.audioStart("t1", "opus", 48000);
    emit.playbackStop("t1", "interrupt");
    expect(tracker.snapshot().audio).toBeNull();
  });

  it("keeps an open permission prompt and drops it on resolution", () => {
    const { tracker, emit } = tracked();
    const req = {
      requestId: "r1",
      toolCallId: "tc1",
      toolName: "ha_call_service",
      args: {},
      description: "d",
      expiresAtMs: 1,
    };
    emit.permissionRequest(req);
    expect(tracker.snapshot().prompts.map((p) => p.requestId)).toEqual(["r1"]);
    emit.permissionResolved({ requestId: "r1", outcome: "allowed" });
    expect(tracker.snapshot().prompts).toHaveLength(0);
  });

  it("passes every frame through to the wrapped emitter unchanged", () => {
    // The tracker is a DECORATOR. A frame it swallows is a frame the live
    // windows never see, which is a far worse bug than a stale snapshot.
    const seen: string[] = [];
    const tracker = createTurnStateTracker("s_1");
    const emit = tracker.wrap({
      ...createLoggingTurnEmitter(),
      turnStarted: () => seen.push("turn.started"),
      textDelta: () => seen.push("turn.text.delta"),
      audioStart: () => seen.push("turn.audio.start"),
      permissionRequest: () => seen.push("permission.request"),
      turnCompleted: () => seen.push("turn.completed"),
    });
    emit.turnStarted("t1", "user");
    emit.textDelta("t1", "hi");
    emit.audioStart("t1", "opus", 48000);
    emit.permissionRequest({
      requestId: "r1",
      toolCallId: "tc1",
      toolName: "t",
      args: {},
      description: "d",
      expiresAtMs: 1,
    });
    emit.turnCompleted("t1");
    expect(seen).toEqual([
      "turn.started",
      "turn.text.delta",
      "turn.audio.start",
      "permission.request",
      "turn.completed",
    ]);
  });
});

describe("captureTurnStateSnapshot", () => {
  it("reads the source's live state at call time, never a latched copy", () => {
    // The joiner's snapshot has to be captured atomically WITH the journal
    // watermark; a latched value would describe a turn that has moved on.
    const { tracker, emit } = tracked();
    const source = {
      get turnState() {
        return tracker.snapshot();
      },
    };
    emit.turnStarted("t1", "user");
    expect(captureTurnStateSnapshot(source).activeTurnId).toBe("t1");
    emit.turnCompleted("t1");
    expect(captureTurnStateSnapshot(source).activeTurnId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Argument fidelity. A pass-through decorator that declares FEWER parameters
// than the interface still typechecks — a narrower function is assignable to a
// wider one — so a dropped argument is invisible until someone reads the wire.
// That is exactly how `replyId` reached the client as null while the gateway
// logged the right value one layer up, and the clients then grouped every
// stretch of a ReAct turn's text into one undifferentiated bubble.
// ---------------------------------------------------------------------------

describe("turn-state tracker — argument fidelity", () => {
  it("INVARIANT: forwards the bubble key on a text delta", () => {
    const seen: (readonly [string, string, string | undefined])[] = [];
    const tracker = createTurnStateTracker("s_1");
    const emit = tracker.wrap({
      ...createLoggingTurnEmitter(),
      textDelta: (turnId, text, replyId) => seen.push([turnId, text, replyId] as const),
    });

    emit.textDelta("t1", "hello", "m1");

    expect(seen).toEqual([["t1", "hello", "m1"]]);
  });

  it("INVARIANT: forwards the bubble key on a committed entry", () => {
    const seen: (readonly [string | undefined, string | undefined])[] = [];
    const tracker = createTurnStateTracker("s_1");
    const emit = tracker.wrap({
      ...createLoggingTurnEmitter(),
      conversationEntry: (_item, turnId, replyId) => seen.push([turnId, replyId] as const),
    });

    emit.conversationEntry({ kind: "assistant", entryId: "e1", ts: 0, content: "hi" }, "t1", "m1");

    expect(seen).toEqual([["t1", "m1"]]);
  });
});
