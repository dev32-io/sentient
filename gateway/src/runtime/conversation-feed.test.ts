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
import type { ConversationFeedSink } from "./conversation-feed.js";
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

function freshSnapshotOf(store: SessionStore): ConversationFeedItem[] {
  const sink = recordingSink();
  createConversationFeed({ store, sessionId: SESSION_ID, userId: USER_ID, emitter: sink }).snapshot();
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
    const feed = createConversationFeed({ store, sessionId: SESSION_ID, userId: USER_ID, emitter: sink });

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
    const feed = createConversationFeed({ store, sessionId: SESSION_ID, userId: USER_ID, emitter: sink });

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
    const feed = createConversationFeed({ store, sessionId: SESSION_ID, userId: USER_ID, emitter: sink });

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

  it("CONTRACT: every frame the feed produces satisfies gatewayMessageSchema", () => {
    // A frame that fails validation is DROPPED by sendGatewayFrame, so a
    // mis-shaped item goes silently missing rather than throwing.
    const store = openStoreFor("schema");
    const sink = recordingSink();
    const feed = createConversationFeed({ store, sessionId: SESSION_ID, userId: USER_ID, emitter: sink });

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
    const feed = createConversationFeed({ store, sessionId: SESSION_ID, userId: USER_ID, emitter: sink });
    feed.publishAll();
    expect(sink.frames).toEqual([]);

    store.append(entry({ kind: "user", text: "new one", createdAt: 6003 }));
    feed.publishAll();
    expect(sink.frames.flatMap((f) => f.items).map((i) => i.entryId)).toEqual(["3"]);
    store.close();
  });

  it("carries each entry's OWN turnId on its frame so the client never invents the join key", () => {
    const store = openStoreFor("turn-id");
    const sink = recordingSink();
    const feed = createConversationFeed({ store, sessionId: SESSION_ID, userId: USER_ID, emitter: sink });

    store.append(entry({ kind: "user", text: "hi", turnId: "turn-a", createdAt: 5001 }));
    store.append(entry({ kind: "assistant", text: "hello", turnId: "turn-a", createdAt: 5002 }));
    store.append(entry({ kind: "user", text: "again", turnId: "turn-b", createdAt: 5003 }));
    feed.publishAll();

    expect(sink.frames.map((f) => f.turnId)).toEqual(["turn-a", "turn-a", "turn-b"]);
    store.close();
  });
});
