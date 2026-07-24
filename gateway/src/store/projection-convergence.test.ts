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
    kind: "user",
    createdAt: 1000,
    text: null,
    toolCallId: null,
    toolName: null,
    toolArgs: null,
    cutoff: null,
    compactedThroughSeq: null,
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

    // Replay: reopen and project from persisted state.
    const reopened = openSessionStore(cap);
    const replayFeed = projectForClient(reopened.readSession("conv"));
    reopened.close();

    expect(replayFeed).toEqual(liveFeed);
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
