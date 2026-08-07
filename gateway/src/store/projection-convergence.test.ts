// CONTRACT (spec §3.2, Invariant B): render(replay(store)) === render(live).
//
// This is the structural guarantee against "a weird tile that only shows up
// after reload." Live commits and replay must both flow through
// projectForClient over the same stored entries.

import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import type { Capability } from "../access/capability.js";
import { projectForClient } from "./client-projection.js";
import type { NewSessionEntry } from "./entry-types.js";
import { openSessionStore } from "./session-store.js";

const ROOT = "/tmp/sentient-convergence-test";
mkdirSync(`${ROOT}/u_aaaaaaaa`, { recursive: true });

const cap: Capability = Object.freeze({
  ownerUserId: "u_aaaaaaaa",
  resource: "session-store",
  rootPath: `${ROOT}/u_aaaaaaaa`,
});

function entry(overrides: Partial<NewSessionEntry>): NewSessionEntry {
  return {
    sessionId: "conv",
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

afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

describe("projection convergence", () => {
  it("CONTRACT: replayed feed is identical to the live-committed feed", () => {
    const store = openSessionStore(cap);

    // Drive a realistic turn: user → tool call → tool result → assistant,
    // capturing the feed as it would be rendered live after each commit.
    const committed = [
      store.append(entry({ kind: "user", text: "weather?", createdAt: 1001 })),
      store.append(
        entry({
          kind: "tool_call",
          toolCallId: "c1",
          toolName: "search",
          toolArgs: '{"q":"weather"}',
          createdAt: 1002,
        }),
      ),
      store.append(
        entry({
          kind: "tool_result",
          toolCallId: "c1",
          toolName: "search",
          toolArgs: '{"temp":"20C"}',
          createdAt: 1003,
        }),
      ),
      store.append(entry({ kind: "assistant", text: "It is 20C.", createdAt: 1004 })),
    ];
    const liveFeed = projectForClient(committed);
    store.close();

    // Shape assertion: prove the fold actually happened, not just that both
    // sides produced the same (possibly empty/wrong) thing. Without this, a
    // projection that always returns [] — or a broken fold — passes the
    // equality check below by construction.
    expect(liveFeed.map((i) => [i.kind, i.text])).toEqual([
      ["user", "weather?"],
      ["assistant", "It is 20C."],
    ]);

    // Id provenance: ids must trace to the entries' own seq, not to array
    // position — a position-derived id would still pass the plain equality
    // check below (both sides project the same full array), but would break
    // the moment the live side projects a tail instead (see the readSince
    // test below).
    const [userEntry, , , assistantEntry] = committed;
    if (!userEntry || !assistantEntry) throw new Error("fixture entries missing");
    expect(liveFeed.map((i) => i.id)).toEqual([String(userEntry.seq), String(assistantEntry.seq)]);

    // Replay: reopen and project from persisted state.
    const reopened = openSessionStore(cap);
    const replayFeed = projectForClient(reopened.readSession("conv"));
    reopened.close();

    expect(replayFeed).toEqual(liveFeed);
  });

  it("CONTRACT: a live readSince TAIL projects ids matching the same items from a full replay", () => {
    // This is what makes a position-derived-id mutant (e.g. `id: String(items.length)`
    // instead of `id: String(entry.seq)`) fail: projecting the full array on
    // both sides can never distinguish "id from seq" from "id from position"
    // because the arrays are identical. A live view that only ever sees a
    // readSince TAIL (the shape the live path actually uses mid-session)
    // starts its position count at 0 while its seq count does not — so the
    // two derivations diverge here and only here.
    const store = openSessionStore(cap);
    const committed = [
      store.append(entry({ sessionId: "conv3", kind: "user", text: "weather?", createdAt: 3001 })),
      store.append(
        entry({
          sessionId: "conv3",
          kind: "tool_call",
          toolCallId: "c1",
          toolName: "search",
          toolArgs: '{"q":"weather"}',
          createdAt: 3002,
        }),
      ),
      store.append(
        entry({
          sessionId: "conv3",
          kind: "tool_result",
          toolCallId: "c1",
          toolName: "search",
          toolArgs: '{"temp":"20C"}',
          createdAt: 3003,
        }),
      ),
      store.append(entry({ sessionId: "conv3", kind: "assistant", text: "It is 20C.", createdAt: 3004 })),
    ];

    // Live mid-session view: only the tail after the first entry (as
    // readSince would return to a client that already has entry #1).
    const firstEntry = committed[0];
    if (!firstEntry) throw new Error("fixture entry missing");
    const tail = store.readSince("conv3", firstEntry.seq);
    const liveTailFeed = projectForClient(tail);
    store.close();

    const reopened = openSessionStore(cap);
    const fullReplayFeed = projectForClient(reopened.readSession("conv3"));
    reopened.close();

    // The tail covers tool_call + tool_result + assistant; only the assistant
    // renders, so it is the last item of the full replay. Its id must match by
    // seq, even though the tail's own array positions start over at 0.
    const correspondingReplayIds = fullReplayFeed.slice(-liveTailFeed.length).map((i) => i.id);
    expect(liveTailFeed.map((i) => i.id)).toEqual(correspondingReplayIds);
  });

  it("CONTRACT: a folded reply keeps the SAME id whether projected from a tail or a full replay", () => {
    // A reply's item is named by its replyId precisely so its identity does not
    // move when the reply grows or when the projection starts mid-reply: a
    // window attaching mid-turn is answered with a snapshot, and the id it sees
    // there must be the id every later frame uses, or its dedupe-by-entryId
    // appends a second bubble instead of updating the first.
    const store = openSessionStore(cap);
    const committed = [
      store.append(entry({ sessionId: "conv4", kind: "user", text: "weather?", createdAt: 4001 })),
      store.append(
        entry({ sessionId: "conv4", kind: "assistant", replyId: "r1", text: "Checking. ", createdAt: 4002 }),
      ),
      store.append(
        entry({
          sessionId: "conv4",
          kind: "tool_call",
          toolCallId: "c1",
          toolName: "search",
          toolArgs: "{}",
          createdAt: 4003,
        }),
      ),
      store.append(
        entry({
          sessionId: "conv4",
          kind: "tool_result",
          toolCallId: "c1",
          toolName: "search",
          toolArgs: "20C",
          createdAt: 4004,
        }),
      ),
      store.append(
        entry({ sessionId: "conv4", kind: "assistant", replyId: "r1", text: "It is 20C.", createdAt: 4005 }),
      ),
    ];

    const firstEntry = committed[0];
    if (!firstEntry) throw new Error("fixture entries missing");
    const tailFeed = projectForClient(store.readSince("conv4", firstEntry.seq));
    store.close();

    const reopened = openSessionStore(cap);
    const fullReplayFeed = projectForClient(reopened.readSession("conv4"));
    reopened.close();

    // One bubble, both ways — and the same name for it.
    expect(fullReplayFeed.map((i) => [i.kind, i.id, i.text])).toEqual([
      ["user", String(firstEntry.seq), "weather?"],
      ["assistant", "r1", "Checking. It is 20C."],
    ]);
    expect(tailFeed.map((i) => i.id)).toEqual(fullReplayFeed.slice(-tailFeed.length).map((i) => i.id));
  });

  it("CONTRACT: convergence still holds across a compaction boundary", () => {
    const store = openSessionStore(cap);
    const committed = [
      store.append(entry({ sessionId: "conv2", kind: "user", text: "old", createdAt: 2001 })),
      store.append(
        entry({
          sessionId: "conv2",
          kind: "compaction",
          text: "Summary.",
          compactedThroughSeq: 1,
          createdAt: 2002,
        }),
      ),
      store.append(entry({ sessionId: "conv2", kind: "user", text: "new", createdAt: 2003 })),
    ];
    const liveFeed = projectForClient(committed);
    store.close();

    const reopened = openSessionStore(cap);
    const replayFeed = projectForClient(reopened.readSession("conv2"));
    reopened.close();

    expect(replayFeed).toEqual(liveFeed);
    expect(replayFeed.map((i) => i.text)).toEqual(["old", "new"]);
  });
});
