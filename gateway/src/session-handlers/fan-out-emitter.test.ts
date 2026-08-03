// One allocation, N cursors, and an attach that cannot lose a frame.
//
// Every case here pins a failure that is invisible in a browser drive until it
// is a data-loss bug:
//
//   - a CONNECTION-lane frame reaching another window, or burning a seq in the
//     shared space (a security/leak boundary, spec §2.1);
//   - two windows being written two different encodings of one frame, which is
//     what a per-connection seq space silently produced;
//   - one wedged socket stopping the conversation for everyone;
//   - a frame emitted between "snapshot" and "cursor at head" being dropped, or
//     delivered twice, or out of order (spec §7.1);
//   - a joiner re-hearing audio the room already heard (spec §7.2).

import { describe, expect, it } from "bun:test";
import type { ConversationFeedItem } from "@sentient/protocol";
import type { ServerWebSocket } from "bun";
import type { SessionRuntime } from "../runtime/session-runtime.js";
import type { TurnEmitter } from "../runtime/turn-emitter.js";
import { createTurnStateTracker } from "../runtime/turn-state-snapshot.js";
import { attachWithSnapshot, createFanOutTurnEmitter } from "./fan-out-emitter.js";
import { createFrameJournal } from "./frame-journal.js";
import { createInputArbiter } from "./input-arbiter.js";
import { type SessionHandles, type SessionRegistry, createSessionRegistry } from "./session-registry.js";
import { type SessionData, createEmptySessionData } from "./ws-helpers.js";
import { sendConnectionFrame } from "./ws-send.js";

const SESSION_ID = "s_1";
const MAX_LAG_BYTES = 1_000_000;

const WS_OPEN = 1;

interface FakeWindow {
  readonly connectionId: string;
  readonly received: unknown[];
  readyState: number;
  bufferedAmount: number;
  send(data: string | Uint8Array): number;
  close(code?: number, reason?: string): void;
  closedWith: number | null;
  getBufferedAmount(): number;
  data: SessionData;
}

function fakeWindow(connectionId: string): FakeWindow {
  const data = createEmptySessionData();
  data.sessionId = connectionId;
  data.conversationId = SESSION_ID;
  const w: FakeWindow = {
    connectionId,
    received: [],
    readyState: WS_OPEN,
    bufferedAmount: 0,
    closedWith: null,
    send(payload) {
      w.received.push(payload);
      return 1;
    },
    close(code) {
      w.closedWith = code ?? null;
      w.readyState = 3;
    },
    getBufferedAmount() {
      return w.bufferedAmount;
    },
    data,
  };
  return w;
}

function asWs(w: FakeWindow): ServerWebSocket<SessionData> {
  return w as unknown as ServerWebSocket<SessionData>;
}

interface Harness {
  readonly registry: SessionRegistry;
  readonly handles: SessionHandles;
  /**
   * What a turn would emit through, in production composition order: the
   * turn-state tracker wrapping the fan-out. Tests drive THIS rather than the
   * fan-out directly, because "a frame at seq ≤ the watermark is already
   * reflected in the snapshot" is only true when the tracker really did see it
   * — pinning the attach against an inert turn-state double would prove
   * nothing about the invariant it exists to defend.
   */
  readonly emit: TurnEmitter;
  /** Items the fake runtime projects as its committed feed. */
  feedItems: ConversationFeedItem[];
  attach(w: FakeWindow): void;
  attachmentIdOf(w: FakeWindow): string;
}

/** A session with `first` already attached and delivering. Real registry, real
 *  journal, real turn-state tracker — only the store projection is a double. */
function harness(first: FakeWindow, maxLagBytes = MAX_LAG_BYTES, onDispose?: () => void): Harness {
  const registry = createSessionRegistry((input) => {
    // Residency is session-registry.test.ts's subject; these cases only care
    // that a disposal does not fire in the middle of an emission.
    if (onDispose === undefined) return;
    if (input.subscriberCount > 0) return;
    onDispose();
  });
  const journal = createFrameJournal({ sessionId: SESSION_ID, maxBytes: 10_000_000 });
  const fanOut = createFanOutTurnEmitter({ registry, sessionId: SESSION_ID, journal, epoch: 7, maxLagBytes });
  const tracker = createTurnStateTracker(SESSION_ID);
  const emit = tracker.wrap(fanOut);

  const state = { feedItems: [] as ConversationFeedItem[] };
  const runtime = {
    emitConversationSnapshot() {
      fanOut.conversationSnapshot(state.feedItems);
    },
    get turnState() {
      return tracker.snapshot();
    },
  } as unknown as SessionRuntime;

  const handles: SessionHandles = {
    runtime,
    permissions: { denyAll() {} } as unknown as SessionHandles["permissions"],
    // Never driven here — these cases are about delivery, not residency
    // (session-retention.test.ts owns that).
    work: {
      isTurnInFlight: false,
      hasPendingForegroundTool: false,
      hasOutstandingPrompt: false,
      hasAuxiliaryTaskInFlight: false,
      newestBackgroundTaskStartedAtMs: null,
    },
    voicePrefs: null,
    arbiter: createInputArbiter(SESSION_ID, 0),
    fanOut,
    journal,
    epoch: 7,
    replayLease: { sessionId: SESSION_ID, id: 1 },
    dispose() {},
  };

  function attach(w: FakeWindow): void {
    const attachment = registry.attach(SESSION_ID, w.connectionId, asWs(w), () => handles);
    fanOut.hold(attachment.attachmentId);
    w.data.attachment = attachment;
  }
  attach(first);

  return {
    registry,
    handles,
    emit,
    get feedItems() {
      return state.feedItems;
    },
    set feedItems(next: ConversationFeedItem[]) {
      state.feedItems = next;
    },
    attach,
    attachmentIdOf(w) {
      const attachment = w.data.attachment;
      if (attachment === null) throw new Error(`unreachable: ${w.connectionId} is not attached`);
      return attachment.attachmentId;
    },
  };
}

function texts(w: FakeWindow): Record<string, unknown>[] {
  return w.received.filter((f): f is string => typeof f === "string").map((f) => JSON.parse(f));
}

function isTextDelta(frame: unknown): boolean {
  return typeof frame === "string" && (JSON.parse(frame) as { type: string }).type === "turn.text.delta";
}

function isAudioFrame(frame: unknown): boolean {
  return frame instanceof Uint8Array;
}

describe("fan-out emitter", () => {
  it("SECURITY: a connection-lane frame is not journaled and not fanned out", () => {
    const connA = fakeWindow("conn-a");
    const connB = fakeWindow("conn-b");
    const h = harness(connA);
    attachWithSnapshot(h.registry, SESSION_ID, asWs(connA));
    h.attach(connB);
    attachWithSnapshot(h.registry, SESSION_ID, asWs(connB));
    connB.received.length = 0;

    sendConnectionFrame(asWs(connA), { type: "pong" });

    expect(h.handles.journal.frameCount).toBe(0);
    expect(connB.received).toHaveLength(0);
    expect(texts(connA).at(-1)).toEqual({ type: "pong" });
  });

  it("INVARIANT: a session frame is allocated once and read by every cursor", () => {
    const connA = fakeWindow("conn-a");
    const connB = fakeWindow("conn-b");
    const h = harness(connA);
    attachWithSnapshot(h.registry, SESSION_ID, asWs(connA));
    h.attach(connB);
    attachWithSnapshot(h.registry, SESSION_ID, asWs(connB));

    h.emit.textDelta("t1", "hi");

    expect(h.handles.journal.frameCount).toBe(1);
    expect(connA.received.at(-1)).toEqual(connB.received.at(-1));
  });

  it("stamps one seq per session frame, not one per window", () => {
    const connA = fakeWindow("conn-a");
    const connB = fakeWindow("conn-b");
    const h = harness(connA);
    attachWithSnapshot(h.registry, SESSION_ID, asWs(connA));
    h.attach(connB);
    attachWithSnapshot(h.registry, SESSION_ID, asWs(connB));
    connA.received.length = 0;
    connB.received.length = 0;

    h.emit.textDelta("t1", "one");
    h.emit.textDelta("t1", "two");

    expect(texts(connA).map((f) => f.seq)).toEqual([1, 2]);
    expect(texts(connB).map((f) => f.seq)).toEqual([1, 2]);
    expect(h.handles.journal.newestSeq).toBe(2);
  });

  it("draws JSON and binary audio seqs from ONE monotonic space", () => {
    // Both client SDKs run ONE resume cursor and feed it from BOTH paths
    // (shared/web-sdk/src/resume-cursor.ts, the KMP ResumeCursor). Two counters
    // and the client silently drops roughly half the stream as "already
    // applied".
    const connA = fakeWindow("conn-a");
    const h = harness(connA);
    attachWithSnapshot(h.registry, SESSION_ID, asWs(connA));
    connA.received.length = 0;

    h.emit.audioStart("t1", "opus", 48000); // seq 1 (JSON)
    h.emit.audioFrame("t1", new Uint8Array([1])); // seq 2 (binary)
    h.emit.audioFrame("t1", new Uint8Array([2])); // seq 3 (binary)
    h.emit.audioDone("t1"); // seq 4 (JSON)

    const headerSeq = (f: Uint8Array) =>
      Number(new DataView(f.buffer, f.byteOffset, f.byteLength).getBigUint64(0, false));
    expect(texts(connA).map((f) => f.seq)).toEqual([1, 4]);
    expect((connA.received.filter(isAudioFrame) as Uint8Array[]).map(headerSeq)).toEqual([2, 3]);
  });

  it("drops a schema-violating session frame WITHOUT consuming a seq", () => {
    // Validate first, stamp second. A rejected frame that burned a seq would
    // tear a permanent hole in the journal, which every cursor reads as an
    // unfillable gap — one bad frame would force every window to re-snapshot.
    const connA = fakeWindow("conn-a");
    const h = harness(connA);
    attachWithSnapshot(h.registry, SESSION_ID, asWs(connA));
    connA.received.length = 0;

    h.emit.audioStart("t1", "opus", 0); // sampleRate must be a positive int
    h.emit.textDelta("t1", "hi");

    expect(texts(connA).map((f) => f.seq)).toEqual([1]);
    expect(h.handles.journal.newestSeq).toBe(1);
  });

  it("INVARIANT: a throwing subscriber is dropped and the others still receive", async () => {
    const connA = fakeWindow("conn-a");
    const connB = fakeWindow("conn-b");
    const h = harness(connA);
    attachWithSnapshot(h.registry, SESSION_ID, asWs(connA));
    h.attach(connB);
    attachWithSnapshot(h.registry, SESSION_ID, asWs(connB));
    connB.received.length = 0;

    connA.send = () => {
      throw new Error("socket gone");
    };
    h.emit.textDelta("t1", "hi");

    expect(connB.received).toHaveLength(1);
    await Promise.resolve(); // the registry detach is deferred — see below
    expect(h.registry.subscribers(SESSION_ID)).not.toContainEqual(expect.objectContaining({ connectionId: "conn-a" }));
  });

  it("INVARIANT: dropping a window stops delivery NOW but detaches on the next microtask", async () => {
    // `registry.detach` runs the disposal policy synchronously, so on the LAST
    // window it would dispose the runtime and close the store handle INSIDE the
    // `emitter.textDelta()` the ReAct loop is currently executing — the loop
    // would then run against a closed handle until it observed the abort. The
    // window still has to stop receiving immediately, or the rest of this
    // fan-out keeps writing to a socket already known to be gone.
    const connA = fakeWindow("conn-a");
    const disposed: string[] = [];
    const h = harness(connA, MAX_LAG_BYTES, () => disposed.push(SESSION_ID));
    attachWithSnapshot(h.registry, SESSION_ID, asWs(connA));
    connA.received.length = 0;
    connA.send = () => {
      throw new Error("socket gone");
    };

    h.emit.textDelta("t1", "one");
    // Synchronously: still a subscriber (nothing disposed mid-emit) …
    expect(h.registry.subscribers(SESSION_ID)).toHaveLength(1);
    expect(disposed).toHaveLength(0);
    // … but already receiving nothing, so a second frame is not even attempted.
    let attempts = 0;
    connA.send = () => {
      attempts += 1;
      throw new Error("socket gone");
    };
    h.emit.textDelta("t1", "two");
    expect(attempts).toBe(0);

    await Promise.resolve();
    expect(h.registry.subscribers(SESSION_ID)).toHaveLength(0);
    expect(disposed).toEqual([SESSION_ID]);
  });

  it("INVARIANT: a frame the transport DROPS for backpressure is not counted as delivered", async () => {
    // `ws.send()` returning 0 is Bun dropping the message past its
    // backpressure limit — no throw, no error, the bytes are simply gone. Under
    // a SHARED journal that frame carried a seq every other cursor advanced
    // past, so the window that lost it has a hole it will never learn about.
    const connA = fakeWindow("conn-a");
    const connB = fakeWindow("conn-b");
    const h = harness(connA);
    attachWithSnapshot(h.registry, SESSION_ID, asWs(connA));
    h.attach(connB);
    attachWithSnapshot(h.registry, SESSION_ID, asWs(connB));

    connA.send = () => 0;
    h.emit.textDelta("t1", "hi");

    await Promise.resolve();
    expect(h.registry.subscribers(SESSION_ID).map((a) => a.connectionId)).toEqual(["conn-b"]);
  });

  it("counts a frame QUEUED behind backpressure as delivered", () => {
    // `-1` means Bun enqueued it: the bytes are its problem now, and the lag
    // check on the next write is what bounds the queue. Dropping the window
    // here would disconnect every client that hits a momentary stall.
    const connA = fakeWindow("conn-a");
    const h = harness(connA);
    attachWithSnapshot(h.registry, SESSION_ID, asWs(connA));

    connA.send = () => -1;
    h.emit.textDelta("t1", "hi");

    expect(h.registry.subscribers(SESSION_ID)).toHaveLength(1);
  });

  it("skips a closing socket without dropping the attachment", () => {
    // Liveness is a ROUTING question read at write time — a socket whose close
    // event has not been processed yet is skipped, not detached, because its
    // own detach is already on its way.
    const connA = fakeWindow("conn-a");
    const h = harness(connA);
    attachWithSnapshot(h.registry, SESSION_ID, asWs(connA));
    connA.received.length = 0;
    connA.readyState = 2;

    h.emit.textDelta("t1", "hi");

    expect(connA.received).toHaveLength(0);
    expect(h.registry.subscribers(SESSION_ID)).toHaveLength(1);
  });

  it("SECURITY: a window whose credential expired receives no fanned-out frame and is closed", () => {
    // THE OUTBOUND SEAM (spec §3.6). The gateway PUSHES, so a socket whose
    // token died while it sat quietly never sends anything an inbound gate
    // could catch — and keeps receiving every frame of the conversation
    // indefinitely. That is the actual disclosure, and it is closed here,
    // beside the readyState skip, because this is where content leaves.
    const connA = fakeWindow("conn-a");
    const connB = fakeWindow("conn-b");
    const h = harness(connA);
    attachWithSnapshot(h.registry, SESSION_ID, asWs(connA));
    h.attach(connB);
    attachWithSnapshot(h.registry, SESSION_ID, asWs(connB));
    connA.received.length = 0;
    connB.received.length = 0;
    connA.data.tokenExpiresAtMs = Date.now() - 1;

    h.emit.textDelta("t1", "content this window may not read");

    expect(connA.received.filter(isTextDelta)).toHaveLength(0);
    expect(connA.closedWith).toBe(1008);
    expect(texts(connA)).toContainEqual(expect.objectContaining({ type: "auth.error", code: "expired" }));
    // The peer with a live credential is unaffected — one dead window must
    // never silence the session for everyone else.
    expect(connB.received.filter(isTextDelta)).toHaveLength(1);
  });

  it("a LIVE credential still receives everything — the gate must not break every session", () => {
    // The over-correction guard. A wrong reading here (unit confusion, an
    // inverted comparison, `null` treated as expired) closes every socket on
    // the gateway the first time any frame is fanned out.
    const connA = fakeWindow("conn-a");
    const h = harness(connA);
    attachWithSnapshot(h.registry, SESSION_ID, asWs(connA));
    connA.received.length = 0;
    connA.data.tokenExpiresAtMs = Date.now() + 60_000;

    h.emit.textDelta("t1", "hi");

    expect(connA.received.filter(isTextDelta)).toHaveLength(1);
    expect(connA.closedWith).toBeNull();
  });

  it("routes a directed frame to the attachment it names and to no other", () => {
    const connA = fakeWindow("conn-a");
    const connB = fakeWindow("conn-b");
    const h = harness(connA);
    attachWithSnapshot(h.registry, SESSION_ID, asWs(connA));
    h.attach(connB);
    attachWithSnapshot(h.registry, SESSION_ID, asWs(connB));
    connA.received.length = 0;
    connB.received.length = 0;

    h.handles.fanOut.directTo(h.attachmentIdOf(connB), () => h.handles.fanOut.conversationSnapshot([]));

    expect(texts(connB).map((f) => f.type)).toEqual(["conversation.snapshot"]);
    expect(connA.received).toHaveLength(0);
  });

  it("drops a snapshot emitted with no addressee rather than fanning it out", () => {
    const connA = fakeWindow("conn-a");
    const connB = fakeWindow("conn-b");
    const h = harness(connA);
    attachWithSnapshot(h.registry, SESSION_ID, asWs(connA));
    h.attach(connB);
    attachWithSnapshot(h.registry, SESSION_ID, asWs(connB));
    connA.received.length = 0;
    connB.received.length = 0;

    h.handles.fanOut.conversationSnapshot([]);

    expect(connA.received).toHaveLength(0);
    expect(connB.received).toHaveLength(0);
  });

  it("closes a window whose backlog passes the lag bound", async () => {
    const connA = fakeWindow("conn-a");
    const h = harness(connA, 100);
    attachWithSnapshot(h.registry, SESSION_ID, asWs(connA));
    connA.bufferedAmount = 101;

    h.emit.textDelta("t1", "hi");

    expect(connA.closedWith).toBe(1013);
    await Promise.resolve();
    expect(h.registry.subscribers(SESSION_ID)).toHaveLength(0);
  });
});

describe("attachWithSnapshot", () => {
  it("INVARIANT: a frame emitted during attach is delivered exactly once, in order", () => {
    const connA = fakeWindow("conn-a");
    const connB = fakeWindow("conn-b");
    const h = harness(connA);
    attachWithSnapshot(h.registry, SESSION_ID, asWs(connA));
    h.emit.turnStarted("t1", "user");

    h.attach(connB); // registered and HELD, in one synchronous block
    h.emit.textDelta("t1", "mid-attach"); // races the snapshot
    attachWithSnapshot(h.registry, SESSION_ID, asWs(connB));

    // Exactly once, whichever side of the watermark it fell on: reconstructed
    // into the turn-state snapshot, or drained after it — never both, never
    // neither.
    expect(connB.received.filter(isTextDelta)).toHaveLength(1);
    expect(texts(connB).find((f) => f.type === "turn.text.delta")?.text).toBe("mid-attach");
  });

  it("delivers everything buffered during a hold, in emission order, when the attach takes no snapshot", () => {
    // The `completeAttach` path (a fresh mint, a conversation.activate): no
    // snapshot, so nothing is already reflected and the whole buffer drains.
    const connA = fakeWindow("conn-a");
    const connB = fakeWindow("conn-b");
    const h = harness(connA);
    attachWithSnapshot(h.registry, SESSION_ID, asWs(connA));

    h.attach(connB);
    h.emit.textDelta("t1", "one");
    h.emit.textDelta("t1", "two");
    h.emit.textDelta("t1", "three");
    h.handles.fanOut.release(h.attachmentIdOf(connB), 0);

    expect(texts(connB).map((f) => f.text)).toEqual(["one", "two", "three"]);
  });

  it("does not deliver a committed entry the snapshot it was just sent already carries", () => {
    // The watermark is captured atomically WITH the projection, so a frame at
    // seq ≤ watermark is already in the committed feed; the drain must not send
    // it a second time.
    const connA = fakeWindow("conn-a");
    const connB = fakeWindow("conn-b");
    const h = harness(connA);
    attachWithSnapshot(h.registry, SESSION_ID, asWs(connA));
    const item: ConversationFeedItem = { entryId: "e1", ts: 1, kind: "user", channel: "text", content: "hello" };

    // Emitted while connB is HELD, so it is in the buffer AND — because the
    // store append precedes the frame — in the projection connB is about to be
    // sent. The watermark is what stops it arriving twice.
    h.attach(connB);
    h.emit.conversationEntry(item);
    h.feedItems = [item];
    attachWithSnapshot(h.registry, SESSION_ID, asWs(connB));

    expect(texts(connB).map((f) => f.type)).toEqual(["conversation.snapshot"]);
  });

  it("INVARIANT: a joiner receives the in-flight turn's state but no historical audio", () => {
    const connA = fakeWindow("conn-a");
    const connB = fakeWindow("conn-b");
    const h = harness(connA);
    attachWithSnapshot(h.registry, SESSION_ID, asWs(connA));
    h.emit.turnStarted("t1", "user");
    h.emit.textDelta("t1", "a partial answer");
    h.emit.audioStart("t1", "opus", 48000);

    // The audio byte is emitted while connB is HELD and lands BELOW its
    // watermark — the room has already heard it, so the joiner must get the
    // BRACKET (binary frames carry no turnId) and none of the bytes.
    h.attach(connB);
    h.emit.audioFrame("t1", new Uint8Array([1, 2, 3]));
    const snap = attachWithSnapshot(h.registry, SESSION_ID, asWs(connB));

    expect(snap.activeTurnId).toBe("t1");
    expect(snap.textSoFar).toContain("partial");
    expect(connB.received.filter(isAudioFrame)).toHaveLength(0);
    expect(texts(connB).map((f) => f.type)).toEqual([
      "conversation.snapshot",
      "turn.started",
      "turn.text.delta",
      "turn.audio.start",
    ]);
  });

  it("re-raises an open permission prompt to a joiner", () => {
    const connA = fakeWindow("conn-a");
    const connB = fakeWindow("conn-b");
    const h = harness(connA);
    attachWithSnapshot(h.registry, SESSION_ID, asWs(connA));
    h.emit.turnStarted("t1", "user");
    h.emit.permissionRequest({
      requestId: "r1",
      toolCallId: "tc1",
      toolName: "ha_call_service",
      args: { entity: "light.kitchen" },
      description: "turn on the kitchen light",
      expiresAtMs: 1,
    });

    h.attach(connB);
    const snap = attachWithSnapshot(h.registry, SESSION_ID, asWs(connB));

    expect(snap.prompts.map((p) => p.requestId)).toEqual(["r1"]);
    expect(texts(connB).map((f) => f.type)).toContain("permission.request");
  });

  it("reconstructs the in-flight turn even when the client refetches its own committed history", () => {
    // `conversation.activate` takes no committed snapshot — the client refetches
    // over REST on `session.switched` — but it can land mid-reply, and no REST
    // route carries `turn.started`, the text so far, a running tile or an open
    // prompt. Without this a drawer-join renders deltas for a turn it never saw
    // start.
    const connA = fakeWindow("conn-a");
    const connB = fakeWindow("conn-b");
    const h = harness(connA);
    attachWithSnapshot(h.registry, SESSION_ID, asWs(connA));
    h.emit.turnStarted("t1", "user");
    h.emit.textDelta("t1", "half an answer");

    h.attach(connB);
    const snap = attachWithSnapshot(h.registry, SESSION_ID, asWs(connB), "client-refetch");

    expect(snap.activeTurnId).toBe("t1");
    expect(texts(connB).map((f) => f.type)).toEqual(["turn.started", "turn.text.delta"]);
  });

  it("INVARIANT: a joiner landing during the TTS tail still gets the audio bracket", () => {
    // Speech outlives its turn, and this is the seam where that stops being an
    // abstract claim: `session-runtime.ts` emits `turnCompleted` as soon as the
    // loop settles while turn-voice.ts's detached drain is still yielding
    // frames, so "no active turn, audio still playing" is a window seconds wide
    // on EVERY spoken reply. Without the bracket the joiner takes the remaining
    // binary frames with nothing to attribute them to — the web connector drops
    // them silently — and then a `turn.audio.done` for a stream it never opened.
    const connA = fakeWindow("conn-a");
    const connB = fakeWindow("conn-b");
    const h = harness(connA);
    attachWithSnapshot(h.registry, SESSION_ID, asWs(connA));
    h.emit.turnStarted("t1", "user");
    h.emit.audioStart("t1", "opus", 48000);
    h.emit.turnCompleted("t1"); // the loop settled; the drain has not

    h.attach(connB);
    const snap = attachWithSnapshot(h.registry, SESSION_ID, asWs(connB));

    expect(snap.activeTurnId).toBeNull();
    expect(snap.audio).toEqual({ turnId: "t1", encoding: "opus", sampleRate: 48000 });
    expect(texts(connB).map((f) => f.type)).toEqual(["conversation.snapshot", "turn.audio.start"]);
  });

  it("sends no bracket once the audio stream has actually ended", () => {
    const connA = fakeWindow("conn-a");
    const connB = fakeWindow("conn-b");
    const h = harness(connA);
    attachWithSnapshot(h.registry, SESSION_ID, asWs(connA));
    h.emit.turnStarted("t1", "user");
    h.emit.audioStart("t1", "opus", 48000);
    h.emit.turnCompleted("t1");
    h.emit.audioDone("t1");

    h.attach(connB);
    attachWithSnapshot(h.registry, SESSION_ID, asWs(connB));

    expect(texts(connB).map((f) => f.type)).toEqual(["conversation.snapshot"]);
  });

  it("hands a joiner an empty turn state when no turn is in flight", () => {
    const connA = fakeWindow("conn-a");
    const connB = fakeWindow("conn-b");
    const h = harness(connA);
    attachWithSnapshot(h.registry, SESSION_ID, asWs(connA));

    h.attach(connB);
    const snap = attachWithSnapshot(h.registry, SESSION_ID, asWs(connB));

    expect(snap.activeTurnId).toBeNull();
    expect(texts(connB).map((f) => f.type)).toEqual(["conversation.snapshot"]);
  });

  it("the reconnect path: replay_from(seq) is byte-identical to what live delivery wrote", () => {
    // `render(replay_from(seq)) == render(live_at(seq))` for a seq a client
    // GENUINELY reached — the only form of the invariant that holds. It is
    // structural here: the replay hands back the very bytes the fan-out wrote.
    const connA = fakeWindow("conn-a");
    const h = harness(connA);
    attachWithSnapshot(h.registry, SESSION_ID, asWs(connA));
    h.emit.textDelta("t1", "one");
    const reached = h.handles.journal.newestSeq;
    connA.received.length = 0;
    h.emit.textDelta("t1", "two");
    h.emit.textDelta("t1", "three");

    const replayed = h.handles.journal.since(reached);
    const decoder = new TextDecoder();

    expect(replayed?.map((f) => decoder.decode(f.bytes))).toEqual(connA.received as string[]);
  });

  it("the joiner path is snapshot ∪ replay_from(watermark), NOT a replay from zero", () => {
    // The two paths are DIFFERENT and must not be conflated: a joiner never
    // receives the frames that preceded its watermark, only the snapshot (and,
    // for an in-flight turn, the reconstruction) that summarises them.
    const connA = fakeWindow("conn-a");
    const connB = fakeWindow("conn-b");
    const h = harness(connA);
    attachWithSnapshot(h.registry, SESSION_ID, asWs(connA));
    h.emit.textDelta("t1", "before-join");

    h.attach(connB);
    attachWithSnapshot(h.registry, SESSION_ID, asWs(connB));
    h.emit.textDelta("t1", "after-join");

    expect(texts(connB).map((f) => f.text)).toEqual([undefined, "after-join"]);
    expect(h.handles.journal.newestSeq).toBe(2);
  });
});
