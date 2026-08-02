// Session identity (spec §3.3, §3.5, §4.2) — allocation, not derivation.
//
// WHAT THIS REPLACES. `ws-session-configure.ts` used to DERIVE the id as
// `c::<userId>::<surfaceId>` and honour any client-presented id carrying that
// prefix, opening a brand-new empty partition for one it had never seen. Two
// things were wrong with that:
//
//   - the id was a function of the caller's own identity, so it was
//     enumerable, and a surface could hold exactly one conversation forever;
//   - the prefix parse read AUTHORITY out of a string's SHAPE. Membership is
//     the stronger check and it is free: the store being queried was already
//     selected by the caller's capability, so anything found in it is
//     theirs by construction. The `surfaceId` embedded in a legacy id is dead
//     metadata carrying no authority, and nothing here parses it.
//
// Both id shapes are handled IDENTICALLY from here on: a legacy `c::` id is
// addressable when — and only when — the caller's own store already holds
// entries for it. Absent, it is refused exactly like any other unknown id;
// re-admitting "create if absent" for `c::` ids would reopen the hole §3.5 #2
// exists to close.
//
// DRAFT KEYS. A connection that presents nothing is a draft: no row, no id,
// nothing in the session list, so ten opened tabs leave no trace. The draft
// key minted here is the client's handle on that draft (see
// `sessionDraftSchema` in shared/protocol) and becomes the session's MINT KEY.
// It is deliberately a different shape from a session id so that a draft key
// presented where a session id belongs is refused as malformed rather than
// looked up.

import { getLog } from "../logging/logger.js";
import { MintKeyConflictError, type SessionStore } from "../store/session-store.js";

const log = getLog(["sentient", "session", "session-id"]);

// Internal identifier format — the same class as a protocol string, not an
// operator tunable. 16 bytes = 128 bits of CSPRNG entropy, the spec §3.3
// floor, rendered as lowercase hex.
//
// HEX, NOT base64url, and that is load-bearing rather than taste: base64url's
// alphabet contains both `u` and `_`, so roughly one id in two hundred would
// contain the substring "u_" purely by chance — the very thing an id must
// never look like it carries. Hex cannot produce it.
const ID_ENTROPY_BYTES = 16;
const SESSION_ID_PREFIX = "s_";
const DRAFT_KEY_PREFIX = "d_";
/** Pre-2.0 derived ids: `c::<userId>::<surfaceId>`. Recognised so they can be
 *  looked up; never parsed for the identity they happen to embed. */
const LEGACY_ID_PREFIX = "c::";

const MINTED_ID_PATTERN = new RegExp(`^${SESSION_ID_PREFIX}[0-9a-f]{${ID_ENTROPY_BYTES * 2}}$`);
const DRAFT_KEY_PATTERN = new RegExp(`^${DRAFT_KEY_PREFIX}[0-9a-f]{${ID_ENTROPY_BYTES * 2}}$`);

export type SessionResolution = { sessionId: string } | { rejected: "unknown-session" };

export interface ResolveSessionDeps {
  /** The store the CALLER's capability opened. Choosing it is the
   *  authorization step; everything found in it is already theirs. */
  store: SessionStore;
  presented: string;
}

export interface MintOnFirstMessageDeps {
  store: SessionStore;
  /** The draft key the client held. The `UNIQUE` constraint on `mint_key` is
   *  what makes a retry resolve to the session already minted. */
  mintKey: string;
  /** The message that triggered the mint. Its LENGTH is logged; the entry
   *  itself is appended by `SessionRuntime.submit` — see this function's doc. */
  text: string;
}

function randomHex(): string {
  const bytes = new Uint8Array(ID_ENTROPY_BYTES);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Allocate a session id: CSPRNG, 128 bits, opaque.
 *
 * NEVER derived from a userId, a surfaceId or a timestamp — those make an id
 * enumerable and turn possession of one id into knowledge of others.
 * `auth/session-manager.ts` uses `Math.random().toString(36)` for a CONNECTION
 * id; that is fine there (the value never outlives its socket and authorizes
 * nothing) and wrong here. Do not copy it.
 */
export function mintSessionId(): string {
  return `${SESSION_ID_PREFIX}${randomHex()}`;
}

/** Allocate a draft key — same entropy, distinct shape (see the header). */
export function mintDraftKey(): string {
  return `${DRAFT_KEY_PREFIX}${randomHex()}`;
}

/** True for a minted id and for a legacy `c::` id. Shape only: says nothing
 *  about whether the session exists, and nothing about who owns it. */
export function isWellFormedSessionId(id: string): boolean {
  return MINTED_ID_PATTERN.test(id) || id.startsWith(LEGACY_ID_PREFIX);
}

/** True for a value this gateway minted as a draft key. A draft names no
 *  session, so it is never resolvable — only re-adoptable. */
export function isDraftKey(id: string): boolean {
  return DRAFT_KEY_PATTERN.test(id);
}

/**
 * Resolve a client-presented id to a session, or refuse it.
 *
 * MEMBERSHIP IS THE RULE. Two ways to be a member of the caller's store, and
 * both are accepted because both are real conversations of theirs:
 *
 *   1. a `sessions` row (every session minted since task 2);
 *   2. at least one entry under that id (a legacy `c::` partition, and any
 *      partition that predates the metadata table).
 *
 * Anything else is `unknown-session`. Refusing rather than creating is the
 * whole point: the previous behaviour — documented in its own comment as *"a
 * new conversation, not an error"* — let any well-formed string spawn an empty
 * partition, so a client could fill a user's database with rows nothing can
 * list, open or delete.
 */
export function resolveSession(deps: ResolveSessionDeps): SessionResolution {
  const { store, presented } = deps;
  if (!isWellFormedSessionId(presented)) {
    log.warn("session.resolve.malformed", {
      reason: "presented id is neither a minted session id nor a legacy c:: id",
      presentedLength: presented.length,
    });
    return { rejected: "unknown-session" };
  }

  if (store.getSession(presented) !== null) return { sessionId: presented };

  // Only reached for an id with no metadata row — i.e. a legacy partition or
  // a probe. Reading the partition is the cost of admitting legacy ids, and
  // it is bounded by the same read the snapshot does moments later.
  if (store.readSession(presented).length > 0) {
    log.info("session.resolve.legacy-partition", {
      sessionId: presented,
      reason: "no metadata row, but the caller's store holds entries for this id",
    });
    return { sessionId: presented };
  }

  log.warn("session.resolve.unknown", {
    sessionId: presented,
    reason: "not present in the store this caller's capability opened — refusing to create it",
  });
  return { rejected: "unknown-session" };
}

/**
 * Mint the session a draft becomes when its first message arrives, or return
 * the one that draft already minted.
 *
 * IDEMPOTENT, NOT ATOMIC WITH THE ACK. Spec §4.2: the `session.created` ack is
 * a wire frame and cannot join a SQLite transaction. Commit succeeds, socket
 * drops, client retries — and without a mint key that produces a second
 * session plus a ghost holding a message the user can never reach. The client
 * therefore re-presents the same draft key, and `mint_key`'s `UNIQUE`
 * constraint (not a read-then-write check, which would race) resolves the
 * retry to the existing row.
 *
 * WHY THE FIRST ENTRY IS NOT WRITTEN HERE, though the plan reads that way.
 * `SessionRuntime.submit` is the single writer for every stimulus: it owns the
 * `pendingId` idempotency lookup, the committed-feed publish and the turn
 * start, none of which can join a transaction either. Appending the first
 * entry here would either double-append it (submit appends again) or strand it
 * (submit's resend branch republishes and starts no turn) — two writers for
 * one logical event, which is exactly the drift the append-only store's
 * single-source-of-truth design forbids. Instead the two idempotency keys
 * compose: `mintKey` guarantees one session per draft, `pendingId` guarantees
 * one entry per message, and a retry of the first message is correct under
 * both. The residual is a session row whose first append never happened
 * (runtime construction threw in the same tick) — an empty session in the
 * list, strictly less harmful than the ghost §4.2 names, and visible rather
 * than silent.
 */
export function mintOnFirstMessage(deps: MintOnFirstMessageDeps): { sessionId: string } {
  const { store, mintKey, text } = deps;

  const existing = store.findSessionByMintKey(mintKey);
  if (existing !== null) {
    log.info("session.mint.replayed", {
      sessionId: existing.sessionId,
      reason: "mint key already claimed — the first message is being retried after a lost ack",
    });
    return { sessionId: existing.sessionId };
  }

  const sessionId = mintSessionId();
  try {
    store.createSession(sessionId, mintKey);
  } catch (err: unknown) {
    if (!(err instanceof MintKeyConflictError)) throw err;
    // Lost the insert race against a concurrent first message on the same
    // draft (two windows, one draft). The winner's row is the answer.
    const raced = store.findSessionByMintKey(mintKey);
    if (raced === null) throw err;
    log.warn("session.mint.raced", {
      sessionId: raced.sessionId,
      reason: "a concurrent first message on this draft minted the session first",
    });
    return { sessionId: raced.sessionId };
  }

  log.info("session.mint.created", { sessionId, firstMessageChars: text.length });
  return { sessionId };
}
