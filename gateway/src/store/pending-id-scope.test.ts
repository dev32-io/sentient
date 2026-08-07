// `pendingId` uniqueness per window (session-model spec §3.8).
//
// The dedup record is durable and session-scoped, so these are store-contract
// cases, not utility cases: each one is a message that would be silently lost,
// duplicated or unreconcilable in production if it did not hold.

import { describe, expect, it } from "bun:test";
import { projectForClient } from "./client-projection.js";
import type { SessionEntry } from "./entry-types.js";
import { scopePendingId, unscopePendingId } from "./pending-id-scope.js";

function userEntry(seq: number, text: string, pendingId: string | null): SessionEntry {
  return {
    seq,
    sessionId: "s_1",
    turnId: "t_1",
    replyId: null,
    kind: "user",
    createdAt: 1,
    text,
    toolCallId: null,
    toolName: null,
    toolArgs: null,
    cutoff: null,
    compactedThroughSeq: null,
    pendingId,
  };
}

describe("pendingId scoping — one window's resend record cannot suppress another's message", () => {
  it("CONTRACT: the client sees back the value it sent, not the namespaced one", () => {
    // The client reconciles its optimistic bubble by pendingId. Echoing the
    // stored form would leave that bubble unsettled and render the message
    // twice.
    const stored = scopePendingId("surface-a", "p-1");
    const [item] = projectForClient([userEntry(1, "hello", stored)]);
    expect(item?.pendingId).toBe("p-1");
  });

  it("CONTRACT: a pre-namespace row projects verbatim", () => {
    // Stores written before this change hold bare client values. Slicing a
    // fixed prefix off one would corrupt every historical user entry.
    const [item] = projectForClient([userEntry(1, "hello", "5c1f9b4e-1c8a-4a3e-9f00-0d1a2b3c4d5e")]);
    expect(item?.pendingId).toBe("5c1f9b4e-1c8a-4a3e-9f00-0d1a2b3c4d5e");
  });

  it("CONTRACT: a client value containing the separator round-trips intact", () => {
    const stored = scopePendingId("surface-a", "w0000000.not-a-prefix.p-2");
    expect(unscopePendingId(stored)).toBe("w0000000.not-a-prefix.p-2");
  });
});
