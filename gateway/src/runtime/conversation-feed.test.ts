// CONTRACT (spec §3.2, Invariant B) at the WIRE layer: the frames a client
// receives live across a turn rebuild EXACTLY the feed a fresh
// `conversation.snapshot` would hand it afterwards.
//
// store/projection-convergence.test.ts pins the projection (entries → feed
// items). This file pins the layer on top: which of those items actually
// reach the socket, in what order, and how many times. A producer that emits
// a tool tile before its result folds in, or that emits the same entryId
// twice, converges in the projection and diverges on the wire — the web
// connector appends every `conversation.entry` blindly, so a duplicate is a
// duplicate bubble.

import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { type ConversationFeedItem, gatewayMessageSchema } from "@sentient/protocol";
import type { Capability } from "../access/capability.js";
import type { NewSessionEntry } from "../store/entry-types.js";
import { openSessionStore } from "../store/session-store.js";
import type { SessionStore } from "../store/session-store.js";
import type { ConversationFeed, ConversationFeedSink } from "./conversation-feed.js";
import { createConversationFeed } from "./conversation-feed.js";

const ROOT = "/tmp/sentient-conversation-feed-test";
const USER_ID = "u_aaaaaaaa";
const SESSION_ID = "conv";

mkdirSync(`${ROOT}/${USER_ID}`, { recursive: true });
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

const cap: Capability = Object.freeze({
  ownerUserId: USER_ID,
  resource: "session-store",
  rootPath: `${ROOT}/${USER_ID}`,
});

function entry(overrides: Partial<NewSessionEntry>): NewSessionEntry {
  return {
    sessionId: SESSION_ID,
    turnId: "t1",
    replyId: null,
    kind: "user",
    createdAt: 1000,
    text: null,
    toolCallId: null,
    toolName: null,
    toolArgs: null,
    cutoff: null,
    compactedThroughSeq: null,
    pendingId: null,
    ...overrides,
  };
}

interface RecordedFrame {
  type: "conversation.snapshot" | "conversation.entry";
  items: ConversationFeedItem[];
  turnId: string | undefined;
}

interface RecordingSink extends ConversationFeedSink {
  frames: RecordedFrame[];
}

function recordingSink(): RecordingSink {
  const frames: RecordedFrame[] = [];
  return {
    frames,
    conversationSnapshot: (items) => frames.push({ type: "conversation.snapshot", items, turnId: undefined }),
    conversationEntry: (item, turnId) => frames.push({ type: "conversation.entry", items: [item], turnId }),
  };
}

/** What a client's mirror holds after applying these frames, using the
 *  STRICTER of the two connector models: snapshot REPLACES, entry APPENDS
 *  with no dedupe (shared/web-sdk). If append-only converges, the KMP
 *  connector's dedupe-by-entryId converges too. */
function applyFrames(frames: readonly RecordedFrame[]): ConversationFeedItem[] {
  let mirror: ConversationFeedItem[] = [];
  for (const frame of frames) {
    mirror = frame.type === "conversation.snapshot" ? [...frame.items] : [...mirror, ...frame.items];
  }
  return mirror;
}

/** A feed over [store]. `currentReplyId` defaults to "no turn in flight", the
 *  settled-session case: nothing is growing, so nothing is held back. */
function feedOver(
  store: SessionStore,
  sink: RecordingSink,
  currentReplyId: () => string | null = () => null,
): ConversationFeed {
  return createConversationFeed({ store, sessionId: SESSION_ID, userId: USER_ID, emitter: sink, currentReplyId });
}

function freshSnapshotOf(store: SessionStore): ConversationFeedItem[] {
  const sink = recordingSink();
  feedOver(store, sink).snapshot();
  return applyFrames(sink.frames);
}

function openStoreFor(scope: string): SessionStore {
  mkdirSync(`${ROOT}/${scope}`, { recursive: true });
  return openSessionStore({ ...cap, rootPath: `${ROOT}/${scope}` });
}

describe("conversation feed — wire convergence", () => {
  it("CONTRACT: live frames across a full ReAct turn rebuild the fresh snapshot exactly", () => {
    const store = openStoreFor("full-turn");
    const sink = recordingSink();
    const feed = feedOver(store, sink);

    // Empty session: the snapshot a fresh client gets on session.configure.
    feed.snapshot();

    // Drive the turn the way SessionRuntime + react-loop.ts do.
    store.append(entry({ kind: "user", text: "weather?", createdAt: 1001 }));
    feed.publishSettled();
    store.append(
      entry({ kind: "tool_call", toolCallId: "c1", toolName: "search", toolArgs: '{"q":"w"}', createdAt: 1002 }),
    );
    feed.publishSettled();
    store.append(
      entry({ kind: "tool_result", toolCallId: "c1", toolName: "search", toolArgs: "20C", createdAt: 1003 }),
    );
    feed.publishSettled();
    store.append(entry({ kind: "assistant", text: "It is 20C.", createdAt: 1004 }));
    feed.publishAll(); // turn boundary

    const live = applyFrames(sink.frames);

    // Shape assertion first: prove the feed is real, so the equality below
    // cannot pass by both sides being empty.
    expect(live.map((i) => [i.kind, i.entryId])).toEqual([
      ["user", "1"],
      ["tool", "2"],
      ["assistant", "4"],
    ]);
    expect(new Set(live.map((i) => i.entryId)).size).toBe(live.length); // no duplicate tiles

    expect(live).toEqual(freshSnapshotOf(store));
    store.close();
  });

  it("CONTRACT: a stimulus landing between a tool call and its result cannot reorder the feed", () => {
    // The steer path (spec §4.5) appends a `user` entry mid-dispatch. The
    // projection anchors the tool tile at its tool_call's POSITION, so a
    // producer that emitted the tile only once its result landed would place
    // it AFTER the steered message and diverge from every later snapshot.
    const store = openStoreFor("steer-midcall");
    const sink = recordingSink();
    const feed = feedOver(store, sink);

    store.append(entry({ kind: "user", text: "weather?", createdAt: 2001 }));
    feed.publishSettled();
    store.append(entry({ kind: "tool_call", toolCallId: "c1", toolName: "search", toolArgs: "{}", createdAt: 2002 }));
    feed.publishSettled();
    store.append(entry({ kind: "user", text: "actually, tomorrow", createdAt: 2003 }));
    feed.publishSettled();
    store.append(
      entry({ kind: "tool_result", toolCallId: "c1", toolName: "search", toolArgs: "20C", createdAt: 2004 }),
    );
    feed.publishSettled();
    store.append(entry({ kind: "assistant", text: "It is 20C.", createdAt: 2005 }));
    feed.publishAll();

    const live = applyFrames(sink.frames);
    expect(live.map((i) => i.kind)).toEqual(["user", "tool", "user", "assistant"]);
    expect(live).toEqual(freshSnapshotOf(store));
    store.close();
  });

  it("CONTRACT: a tool call that never gets a result is released at the turn boundary, once", () => {
    // A background dispatch (`delegateTask`) appends a tool_call and a system
    // note; its result never arrives as a tool_result. Holding the tile back
    // for a result that is never coming would strand every later item behind
    // it — including the turn's final assistant entry.
    const store = openStoreFor("background-tool");
    const sink = recordingSink();
    const feed = feedOver(store, sink);

    store.append(entry({ kind: "user", text: "delegate it", createdAt: 3001 }));
    store.append(
      entry({ kind: "tool_call", toolCallId: "c9", toolName: "delegateTask", toolArgs: "{}", createdAt: 3002 }),
    );
    store.append(entry({ kind: "system", text: "Task started: delegateTask (taskId=t-9)", createdAt: 3003 }));
    feed.publishSettled();

    // Held back: the assistant entry is behind an unresolved tool tile.
    expect(applyFrames(sink.frames).map((i) => i.kind)).toEqual(["user"]);

    store.append(entry({ kind: "assistant", text: "On it.", createdAt: 3004 }));
    feed.publishAll();
    feed.publishAll(); // a second boundary flush must not re-emit anything

    const live = applyFrames(sink.frames);
    expect(live.map((i) => i.kind)).toEqual(["user", "tool", "assistant"]);
    expect(live).toEqual(freshSnapshotOf(store));
    store.close();
  });

  it("CONTRACT: the OPEN reply is held back until it stops growing, then publishes as ONE item", () => {
    // The ReAct shape: narration, a tool round trip, the answer — three
    // assistant entries under one replyId that the projection folds into one
    // bubble. Publishing the first stretch as its own frame leaves a
    // permanently stale bubble on a client that appends, and a bubble that has
    // LOST its earlier text on one that dedupes by entryId.
    const store = openStoreFor("open-reply");
    const sink = recordingSink();
    let openReplyId: string | null = "r1";
    const feed = feedOver(store, sink, () => openReplyId);

    store.append(entry({ kind: "user", text: "play music", createdAt: 8001 }));
    feed.publishSettled();
    expect(applyFrames(sink.frames).map((i) => i.kind)).toEqual(["user"]);

    store.append(entry({ kind: "assistant", replyId: "r1", text: "Checking. ", createdAt: 8002 }));
    store.append(entry({ kind: "tool_call", toolCallId: "c1", toolName: "search", toolArgs: "{}", createdAt: 8003 }));
    store.append(entry({ kind: "tool_result", toolCallId: "c1", toolName: "search", toolArgs: "ok", createdAt: 8004 }));
    feed.publishSettled();
    // Still growing — and the resolved tile behind it is blocked too, or it
    // would arrive ahead of the bubble it belongs after.
    expect(applyFrames(sink.frames).map((i) => i.kind)).toEqual(["user"]);

    store.append(entry({ kind: "assistant", replyId: "r1", text: "Done.", createdAt: 8005 }));
    openReplyId = null; // the turn settled
    feed.publishAll();

    const live = applyFrames(sink.frames);
    expect(live.map((i) => [i.kind, i.entryId])).toEqual([
      ["user", "1"],
      ["assistant", "r1"],
      ["tool", "3"],
    ]);
    expect(live.find((i) => i.kind === "assistant")).toMatchObject({ content: "Checking. Done." });
    expect(live).toEqual(freshSnapshotOf(store));
    store.close();
  });

  it("CONTRACT: a mid-turn snapshot does not park the cursor above the reply still being written", () => {
    // The snapshot is written to the ONE window that just attached, while the
    // cursor is shared by every window on this session. Arming it at the tail
    // would drop the stretches already committed for the open reply out of
    // every OTHER window's feed for good, and would publish the reply's own id
    // later carrying nothing but its tail.
    const store = openStoreFor("mid-turn-snapshot");
    const sink = recordingSink();
    let openReplyId: string | null = "r1";
    const feed = feedOver(store, sink, () => openReplyId);

    store.append(entry({ kind: "user", text: "play music", createdAt: 8101 }));
    store.append(entry({ kind: "assistant", replyId: "r1", text: "Checking. ", createdAt: 8102 }));
    feed.publishSettled(); // the user row goes out; the reply is still growing
    feed.snapshot(); // a second window attaches mid-turn
    sink.frames.length = 0;

    store.append(entry({ kind: "assistant", replyId: "r1", text: "Done.", createdAt: 8103 }));
    openReplyId = null;
    feed.publishAll();

    expect(sink.frames.flatMap((f) => f.items)).toMatchObject([
      { entryId: "r1", kind: "assistant", content: "Checking. Done." },
    ]);
    store.close();
  });

  it("CONTRACT: a mid-turn snapshot does not park the cursor above a tool tile awaiting its result", () => {
    // The no-narration shape: the model calls a tool without saying anything
    // first, so NO committed entry carries the open reply id and the reply
    // predicate alone finds nothing to hold. The TILE is still held back, and
    // arming the cursor past it drops it out of every already-attached window's
    // feed for good — its `tool_result` then arrives as an orphan the
    // projection discards (`projection.dropped-tool-result-without-tile`),
    // while a fresh snapshot still shows the tile. Live and replay disagree.
    const store = openStoreFor("mid-turn-snapshot-tool");
    const sink = recordingSink();
    const feed = feedOver(store, sink, () => "r1");

    store.append(entry({ kind: "user", text: "play music", createdAt: 8201 }));
    store.append(
      entry({ kind: "tool_call", toolCallId: "c1", toolName: "ma_play_media", toolArgs: "{}", createdAt: 8202 }),
    );
    feed.publishSettled();
    expect(applyFrames(sink.frames).map((i) => i.kind)).toEqual(["user"]);

    feed.snapshot(); // a second window attaches mid-turn
    sink.frames.length = 0;

    store.append(
      entry({ kind: "tool_result", toolCallId: "c1", toolName: "ma_play_media", toolArgs: "ok", createdAt: 8203 }),
    );
    store.append(entry({ kind: "assistant", replyId: "r1", text: "Playing.", createdAt: 8204 }));
    feed.publishAll();

    expect(sink.frames.flatMap((f) => f.items).map((i) => [i.kind, i.entryId])).toEqual([
      ["tool", "2"],
      ["assistant", "r1"],
    ]);
    expect(applyFrames(sink.frames).map((i) => i.kind)).toEqual(["tool", "assistant"]);
    store.close();
  });

  it("CONTRACT: rotating the reply id releases the reply it closed, without waiting for the turn", () => {
    // The steer path (spec §4.5): the person speaks mid-turn, their row breaks
    // the bubble, and session-runtime.ts rotates the id — which is exactly what
    // makes the reply so far content-final. Two replies, two bubbles, and the
    // user's row between them.
    const store = openStoreFor("reply-rotation");
    const sink = recordingSink();
    let openReplyId: string | null = "r1";
    const feed = feedOver(store, sink, () => openReplyId);

    store.append(entry({ kind: "assistant", replyId: "r1", text: "First half. ", createdAt: 9001 }));
    feed.publishSettled();
    expect(sink.frames).toEqual([]);

    store.append(entry({ kind: "user", text: "actually, tomorrow", createdAt: 9002 }));
    openReplyId = "r2";
    feed.publishSettled();
    expect(applyFrames(sink.frames).map((i) => [i.kind, i.entryId])).toEqual([
      ["assistant", "r1"],
      ["user", "2"],
    ]);

    store.append(entry({ kind: "assistant", replyId: "r2", text: "Second half.", createdAt: 9003 }));
    openReplyId = null;
    feed.publishAll();

    const live = applyFrames(sink.frames);
    expect(live.map((i) => [i.kind, i.entryId])).toEqual([
      ["assistant", "r1"],
      ["user", "2"],
      ["assistant", "r2"],
    ]);
    expect(live).toEqual(freshSnapshotOf(store));
    store.close();
  });

  it("CONTRACT: every frame the feed produces satisfies gatewayMessageSchema", () => {
    // A frame that fails validation is DROPPED by sendGatewayFrame, so a
    // mis-shaped item goes silently missing rather than throwing.
    const store = openStoreFor("schema");
    const sink = recordingSink();
    const feed = feedOver(store, sink);

    store.append(entry({ kind: "user", text: "hi", createdAt: 4001 }));
    store.append(entry({ kind: "trigger", text: "task t-9 finished", createdAt: 4002 }));
    store.append(entry({ kind: "tool_call", toolCallId: "c1", toolName: "search", toolArgs: "{}", createdAt: 4003 }));
    store.append(entry({ kind: "tool_result", toolCallId: "c1", toolName: "search", toolArgs: "ok", createdAt: 4004 }));
    store.append(entry({ kind: "assistant", text: "partial", cutoff: "interrupt", createdAt: 4005 }));
    store.append(entry({ kind: "assistant", text: "partial too", cutoff: "barge-in", createdAt: 4006 }));
    feed.publishAll();
    feed.snapshot();

    for (const frame of sink.frames) {
      const wire =
        frame.type === "conversation.snapshot"
          ? { type: frame.type, items: frame.items }
          : { type: frame.type, item: frame.items[0], ...(frame.turnId ? { turnId: frame.turnId } : {}) };
      expect(gatewayMessageSchema.safeParse(wire).success, JSON.stringify(wire)).toBe(true);
    }
    store.close();
  });

  it("CONTRACT: a feed built over an EXISTING session publishes nothing until something new is committed", () => {
    // The recovered-resume path. `session.configure` disposes the old runtime
    // and mints a new one over the same store, but ws-resume.ts has already
    // restored the client's mirror by replaying the journal verbatim — so no
    // snapshot is sent. A cursor starting at zero would then republish the
    // WHOLE history as individual entries on the next commit, doubling every
    // bubble the client already has.
    const store = openStoreFor("recovered-resume");
    store.append(entry({ kind: "user", text: "earlier", createdAt: 6001 }));
    store.append(entry({ kind: "assistant", text: "earlier reply", createdAt: 6002 }));

    const sink = recordingSink();
    const feed = feedOver(store, sink);
    feed.publishAll();
    expect(sink.frames).toEqual([]);

    store.append(entry({ kind: "user", text: "new one", createdAt: 6003 }));
    feed.publishAll();
    expect(sink.frames.flatMap((f) => f.items).map((i) => i.entryId)).toEqual(["3"]);
    store.close();
  });

  it("WIRE: a committed user entry echoes the pendingId the client sent, live AND on replay", () => {
    // Without the echo the client's optimistic bubble never reconciles, its
    // outbox never settles, and the message is re-sent (defect D14). And if
    // the echo were live-only, a reconnect's snapshot would resurrect the
    // duplicate the client had already settled — render(replay) == render(live)
    // is the contract, not an implementation detail.
    const store = openStoreFor("pending-echo");
    const sink = recordingSink();
    const feed = feedOver(store, sink);

    store.append(entry({ kind: "user", text: "hello", pendingId: "p1", createdAt: 7001 }));
    store.append(entry({ kind: "assistant", text: "hi", createdAt: 7002 }));
    feed.publishAll();

    const live = applyFrames(sink.frames);
    expect(live.map((i) => (i.kind === "user" ? i.pendingId : undefined))).toEqual(["p1", undefined]);
    expect(live).toEqual(freshSnapshotOf(store));
    store.close();
  });

  it("WIRE: a user entry with no pendingId omits the field entirely", () => {
    const store = openStoreFor("pending-absent");
    const sink = recordingSink();
    const feed = feedOver(store, sink);
    store.append(entry({ kind: "user", text: "spoken", createdAt: 7101 }));
    feed.publishAll();
    const item = sink.frames[0]?.items[0];
    expect(item?.kind).toBe("user");
    expect(Object.hasOwn(item as object, "pendingId")).toBe(false);
    store.close();
  });

  it("WIRE: republish re-answers an already-published entry without advancing the cursor", () => {
    // A duplicate send must still be ANSWERED — committed once, echoed every
    // time. A silent drop swaps a visible duplicate for an invisible hang: the
    // client's outbox retries forever. The re-emitted frame carries the SAME
    // entryId, which is what makes it an update rather than a second bubble.
    const store = openStoreFor("republish");
    const sink = recordingSink();
    const feed = feedOver(store, sink);

    const committed = store.append(entry({ kind: "user", text: "hello", pendingId: "p1", createdAt: 7201 }));
    feed.publishAll();
    sink.frames.length = 0;

    feed.republish(committed);
    expect(sink.frames).toHaveLength(1);
    const item = sink.frames[0]?.items[0];
    expect(item?.entryId).toBe(String(committed.seq));
    expect(item?.kind === "user" ? item.pendingId : null).toBe("p1");
    expect(sink.frames[0]?.turnId).toBe(committed.turnId);

    // The cursor is untouched, so the next real commit still publishes.
    sink.frames.length = 0;
    store.append(entry({ kind: "assistant", text: "hi", createdAt: 7202 }));
    feed.publishAll();
    expect(sink.frames.flatMap((f) => f.items).map((i) => i.entryId)).toEqual(["2"]);
    store.close();
  });

  it("carries each entry's OWN turnId on its frame so the client never invents the join key", () => {
    const store = openStoreFor("turn-id");
    const sink = recordingSink();
    const feed = feedOver(store, sink);

    store.append(entry({ kind: "user", text: "hi", turnId: "turn-a", createdAt: 5001 }));
    store.append(entry({ kind: "assistant", text: "hello", turnId: "turn-a", createdAt: 5002 }));
    store.append(entry({ kind: "user", text: "again", turnId: "turn-b", createdAt: 5003 }));
    feed.publishAll();

    expect(sink.frames.map((f) => f.turnId)).toEqual(["turn-a", "turn-a", "turn-b"]);
    store.close();
  });
});
