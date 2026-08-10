// The client half of command binding (gateway spec §3.7).
//
// Wire-contract cases: what this stamps, and — the half that actually breaks
// things — what it must NOT stamp. A binding on the wrong frame does not
// degrade gracefully; the gateway refuses it, and the message is gone.

import { describe, expect, it } from "vitest";
import { createCommandBindingState } from "./command-binding.ts";

describe("command binding — the stamp every command carries", () => {
  it("stamps a command with the session and generation the gateway announced", () => {
    const state = createCommandBindingState();
    state.attached({ sessionId: "s_1", generation: 3 });

    expect(state.stamp({ type: "text.input", text: "hi" })).toEqual({
      type: "text.input",
      text: "hi",
      sessionId: "s_1",
      attachmentGeneration: 3,
    });
  });

  it("CONTRACT: session.configure / session.new / conversation.activate are NEVER stamped", () => {
    // These are how a connection LEAVES a session. Binding them to the session
    // being left would make the gateway refuse the very frames that switch,
    // and switching would be unreachable.
    const state = createCommandBindingState();
    state.attached({ sessionId: "s_1", generation: 1 });

    for (const type of ["session.configure", "session.new", "conversation.activate", "ping", "auth"]) {
      expect(state.stamp({ type })).toEqual({ type });
    }
  });

  it("INVARIANT: a DRAFT sends its minting message unstamped", () => {
    // A draft holds no attachment. `text.input` here is the frame that mints
    // the session, and a stamp left over from the previous conversation would
    // be refused as stale — the new chat would never start.
    const state = createCommandBindingState();
    state.attached({ sessionId: "s_1", generation: 1 });
    state.clear("session.draft");

    expect(state.stamp({ type: "text.input", text: "hi" })).toEqual({ type: "text.input", text: "hi" });
  });

  it("INVARIANT: a re-attach replaces the pair rather than accumulating one", () => {
    const state = createCommandBindingState();
    state.attached({ sessionId: "s_1", generation: 1 });
    state.attached({ sessionId: "s_2", generation: 1 });

    expect(state.stamp({ type: "interrupt" })).toEqual({
      type: "interrupt",
      sessionId: "s_2",
      attachmentGeneration: 1,
    });
  });
});
