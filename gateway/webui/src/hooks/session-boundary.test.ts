// ---------------------------------------------------------------------------
// The conversation boundary — what the pane must DROP when it stops showing
// the conversation it was showing.
//
// The composer task strip is the case with no server backstop on every path:
// `conversation.activate` is answered with a fresh full-state `tasklist.state`,
// but the "+" / fresh-mint path is not (the draft handshake sends an empty
// `conversation.snapshot` and no strip frame, then the socket unbinds). A
// background `delegateTask` row is keyed by taskId and retained by design, so
// nothing else ever retires it — it would sit on the strip of every later chat.
// ---------------------------------------------------------------------------

import type { CommittedFeedItem, InFlightMessage } from "@sentient/web-sdk";
import { describe, expect, it, vi } from "vitest";
import {
  type ConversationScopedState,
  type DrainBubble,
  type SessionBoundaryKind,
  clearConversationScopedState,
} from "./session-boundary.ts";

const BUBBLE: InFlightMessage = { turnId: "t1", replyId: "m1", text: "half a reply" };
const DRAIN: DrainBubble = { turnId: "t1", replyId: "m1", snapshot: BUBBLE };
const COMMITTED: CommittedFeedItem[] = [{ entryId: "e1", ts: 1, kind: "user", channel: "text", content: "hi" }];

function loadedPane() {
  const state: ConversationScopedState = {
    drain: { current: DRAIN },
    inflight: { current: [BUBBLE] },
    committed: { current: COMMITTED },
    typewriterBubbleId: { current: "m1" },
    typewriter: { reset: vi.fn() },
    taskList: { clear: vi.fn() },
  };
  return state;
}

describe("clearConversationScopedState", () => {
  for (const kind of ["switched", "created", "draft"] as const satisfies readonly SessionBoundaryKind[]) {
    it(`INVARIANT: clears the composer task strip on a ${kind} boundary`, () => {
      const state = loadedPane();

      clearConversationScopedState(kind, state);

      expect(state.taskList.clear).toHaveBeenCalledTimes(1);
    });

    it(`drops the drain bubble and the typewriter on a ${kind} boundary`, () => {
      const state = loadedPane();

      clearConversationScopedState(kind, state);

      expect(state.drain.current).toBeNull();
      expect(state.inflight.current).toEqual([]);
      expect(state.typewriterBubbleId.current).toBeNull();
      expect(state.typewriter.reset).toHaveBeenCalledTimes(1);
    });
  }

  it("leaves the committed mirror alone on a switch — the history connector replaces it via REST", () => {
    const state = loadedPane();

    clearConversationScopedState("switched", state);

    expect(state.committed.current).toEqual(COMMITTED);
  });

  it("empties the committed mirror on a draft or a fresh mint", () => {
    for (const kind of ["created", "draft"] as const) {
      const state = loadedPane();
      clearConversationScopedState(kind, state);
      expect(state.committed.current).toEqual([]);
    }
  });
});
