// Session identity (spec §3.3, §3.5, §4.2).
//
// Four invariants live here, and every one of them is a security or
// durability boundary rather than a unit-level detail:
//
//   - a minted id is unguessable and carries no identity, so possessing one
//     tells an attacker nothing and guessing one is infeasible;
//   - an id the gateway never minted is REFUSED, not silently created — the
//     behaviour this replaces created an empty partition for any well-formed
//     string, which is the junk-partition vector;
//   - membership, not shape, is the rule: a legacy `c::` partition that
//     actually holds entries still opens, and one that does not is refused
//     exactly like any other unknown id;
//   - minting is idempotent under a dropped ack, because the ack is a wire
//     frame and cannot join the SQLite transaction that committed the row.

import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import type { Capability } from "../access/capability.js";
import type { NewSessionEntry } from "../store/entry-types.js";
import { type SessionStore, openSessionStore } from "../store/session-store.js";
import { mintOnFirstMessage, mintSessionId, resolveSession } from "./session-id.js";

const ROOT = "/tmp/sentient-session-id-test";

afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

let storeSeq = 0;

/** A fresh, isolated on-disk store per test — each gets its own user dir so no
 *  test can see another's rows. */
function freshStore(): SessionStore {
  storeSeq += 1;
  const userId: `u_${string}` = `u_${storeSeq.toString(16).padStart(8, "0")}`;
  mkdirSync(`${ROOT}/${userId}`, { recursive: true });
  const cap: Capability = Object.freeze({
    ownerUserId: userId,
    resource: "session-store",
    rootPath: `${ROOT}/${userId}`,
  });
  return openSessionStore(cap);
}

function entryFor(sessionId: string): NewSessionEntry {
  return {
    sessionId,
    turnId: "turn-1",
    messageId: null,
    kind: "user",
    createdAt: Date.now(),
    text: "hello",
    toolCallId: null,
    toolName: null,
    toolArgs: null,
    cutoff: null,
    compactedThroughSeq: null,
    pendingId: null,
  };
}

/** `s_` + 32 lowercase hex = exactly 16 CSPRNG bytes. Asserted as a SHAPE, not
 *  as a minimum length: a `>= 22` bound was calibrated for base64url and would
 *  still pass if the entropy silently dropped to 12 bytes (96 bits), which is
 *  the regression this line exists to catch. Hex also cannot produce the "u_"
 *  substring, which base64url's alphabet would yield in ~1 id in 200. */
const MINTED_ID_SHAPE = /^s_[0-9a-f]{32}$/;

describe("session id — minting", () => {
  it("SECURITY: a minted session id embeds no identity and does not repeat", () => {
    const ids = new Set(Array.from({ length: 1000 }, mintSessionId));
    expect(ids.size).toBe(1000);
    for (const id of ids) {
      expect(id).not.toContain("u_");
      expect(id).toMatch(MINTED_ID_SHAPE); // 128 bits, no more and no less
    }
  });
});

describe("session id — addressing", () => {
  it("SECURITY: an unknown session id is rejected rather than silently created", () => {
    const store = freshStore();
    const r = resolveSession({ store, presented: mintSessionId() });
    expect(r).toEqual({ rejected: "unknown-session" });
    expect(store.listSessionsWithMetadata()).toHaveLength(0);
    store.close();
  });

  it("INVARIANT: a legacy c:: partition with existing entries is addressable", () => {
    const store = freshStore();
    store.append(entryFor("c::u_0417d3b0::web-1"));
    expect(resolveSession({ store, presented: "c::u_0417d3b0::web-1" })).toEqual({
      sessionId: "c::u_0417d3b0::web-1",
    });
    store.close();
  });

  it("SECURITY: a well-formed legacy id with no entries is rejected like any unknown id", () => {
    const store = freshStore();
    expect(resolveSession({ store, presented: "c::u_0417d3b0::never-used" })).toEqual({
      rejected: "unknown-session",
    });
    store.close();
  });

  it("opens a minted session that this store already holds", () => {
    const store = freshStore();
    const { sessionId } = mintOnFirstMessage({ store, mintKey: "k-open", text: "hello" });
    expect(resolveSession({ store, presented: sessionId })).toEqual({ sessionId });
    store.close();
  });
});

describe("session id — minting on the first message", () => {
  it("INVARIANT: retrying the first message with one mint key yields one session", () => {
    const store = freshStore();
    const a = mintOnFirstMessage({ store, mintKey: "k-1", text: "hello" });
    const b = mintOnFirstMessage({ store, mintKey: "k-1", text: "hello" });
    expect(b.sessionId).toBe(a.sessionId);
    expect(store.listSessionsWithMetadata()).toHaveLength(1);
    store.close();
  });

  it("INVARIANT: the retry is reported as replayed, so the caller can re-project the feed", () => {
    // The caller needs this bit: a replayed mint lands on a connection whose
    // handshake already handed it an EMPTY committed feed, and without knowing
    // the session is older than this message it never refills the pane.
    const store = freshStore();
    expect(mintOnFirstMessage({ store, mintKey: "k-2", text: "hello" }).replayed).toBe(false);
    expect(mintOnFirstMessage({ store, mintKey: "k-2", text: "hello" }).replayed).toBe(true);
    store.close();
  });
});
