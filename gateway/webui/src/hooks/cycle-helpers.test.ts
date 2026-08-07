// ---------------------------------------------------------------------------
// cycle-helpers — feed → UI derivation.
//
// The gateway now folds a whole reply into ONE `conversation.entry` and
// publishes tool rows separately as `tasklist.state` (rendered by the
// composer task strip, not the chat feed). These tests pin what's left:
// the walk renders exactly what the committed feed + inflight buffer say,
// with no client-side merge or tool-tile anchoring of its own.
// ---------------------------------------------------------------------------

import type { CommittedFeedItem } from "@sentient/web-sdk";
import { describe, expect, it } from "vitest";
import { deriveMessages } from "./cycle-helpers.ts";

function userEntry(content: string, ts: number): CommittedFeedItem {
  return { entryId: `e-${ts}`, ts, kind: "user", channel: "text", content };
}

function assistantEntry(content: string, ts: number, turnId?: string): CommittedFeedItem {
  const base: CommittedFeedItem = { entryId: `e-${ts}`, ts, kind: "assistant", content };
  return turnId === undefined ? base : { ...base, turnId };
}

function triggerEntry(summary: string, ts: number): CommittedFeedItem {
  return { entryId: `e-${ts}`, ts, kind: "trigger", source: "background-completion", summary };
}

describe("cycle-helpers — one bubble per reply", () => {
  it("renders one bubble per assistant item, because the gateway already folded the reply", () => {
    const items = [
      { entryId: "r1", ts: 1, kind: "assistant", replyId: "r1", content: "one reply, already whole" },
    ] as const;
    const out = deriveMessages(items as never, []);
    expect(out).toHaveLength(1);
    expect(out[0]?.text).toBe("one reply, already whole");
  });
});

// ---------------------------------------------------------------------------
// A background completion is CONTEXT FOR THE MODEL, never a feed artifact.
//
// The gateway puts the settled delegated result on the wire as a `trigger` feed
// item (source + summary), because the model needs it. The owner's ruling
// (2026-07-31) is that a tool result is not a user-facing artifact: the model
// synthesises a reply from it and THAT is what the user sees and hears — which
// is also the only thing that works in voice, where there is no card to show.
//
// So the walk skips it.
// ---------------------------------------------------------------------------

describe("cycle-helpers — background completions", () => {
  it("CONTRACT: a trigger feed item produces no chat message at all", () => {
    const summary = "Background task t1 completed.\n--- BEGIN TASK OUTPUT (task t1) ---\nA Fresnel lens…";
    const messages = deriveMessages([userEntry("delegate it", 1), triggerEntry(summary, 2)], []);

    expect(messages.map((m) => m.text)).toEqual(["delegate it"]);
  });

  it("does not let a background completion landing mid-dispatch disrupt the turn", () => {
    // A completion can land mid-dispatch (the steer seam). Unlike a user
    // message it is not a person taking the floor, so it must not close the
    // turn early or otherwise break the reply that follows.
    const messages = deriveMessages(
      [userEntry("delegate it", 1), triggerEntry("Background task t1 completed.", 3), assistantEntry("here it is", 4)],
      [],
    );

    expect(messages.map((m) => m.text)).toEqual(["delegate it", "here it is"]);
  });
});
