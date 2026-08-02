// ConversationRuntimeRegistry — exactly ONE live `SessionRuntime` per durable
// conversation, across connections.
//
// Making the conversation durable (the session store partitions on it, not on
// the per-connection id) made it SHARED: two sockets can now name the same
// partition. replay-registry.ts already documents the window that makes this
// routine rather than hypothetical — "a same-tab reload whose new
// session.configure lands before the old socket's close event, or a TCP/NAT
// drop Bun's idle timeout has not noticed yet" — and answers it by minting a
// fresh journal so two sockets never share one seq counter.
//
// The runtime needs the same coordination for a stronger reason. Two live
// runtimes on one partition are two ReAct loops appending to one append-only
// log, each having read "prior context" without the other's writes — which
// breaks the store's cache-stable prefix invariant — plus two `bun:sqlite`
// handles contending on one WAL file.
//
// Same stance as the journal: the NEWEST connection wins, and the superseded
// one is torn down rather than left running blind. Ownership is tracked by
// connection id, so a superseded socket's late close event cannot deregister
// (or tear down) the connection that replaced it.
//
// "NEWEST" IS MEASURED BY CLAIM-CALL TIME, not by connection recency, and those
// two agree only while every connection claims during its own handshake. Two
// callers break that assumption — a LATE bind (a connection whose handshake-time
// bind failed and which recovers on a later message) and a MINT that replays
// onto a session another connection already minted under the same draft key —
// so both ask `liveOwnerOf` first and decline rather than claiming blind. See
// `ensureBoundRuntime` (ws-handlers.ts).
//
// "LIVE", not merely "claimed": `release` runs on the close event, so between a
// drop and that event the map still names a connection that is already gone.
// A guard that asked only "is this session claimed" would let a corpse refuse
// the retry the mint path exists to serve, so ownership is reported through the
// owner's own liveness predicate — see `ConversationOwnerHandle`.

import { getLog } from "../logging/logger.js";

const log = getLog(["sentient", "ws", "conversation-runtime-registry"]);

/**
 * How the registry asks after, and tears down, the connection that owns a
 * conversation. Supplied by the claimer (session-binding.ts) because that is
 * the only place holding the socket — the registry itself stays free of `bun`
 * types and of any notion of a WebSocket.
 */
export interface ConversationOwnerHandle {
  /**
   * True while this owner's socket can still be served, read at QUERY time
   * rather than latched at claim time. Backed by the socket's own
   * `readyState`: a CLOSING/CLOSED socket whose close event has not been
   * processed yet still holds its claim, and must not block a takeover.
   */
  isAlive(): boolean;
  /**
   * Tears down one connection's orchestrator handles (its `SessionRuntime` and
   * `PermissionBroker`) and clears them off that socket. Invoked at most once,
   * by the registry, when a newer connection takes the conversation over.
   */
  evict(): void;
}

export interface ConversationRuntimeRegistry {
  /**
   * Make `connectionId` the sole live owner of `conversationId`, evicting the
   * previous owner when that is a DIFFERENT connection. Re-claiming from the
   * same connection only replaces the eviction hook: a re-`session.configure`
   * has already disposed its own prior runtime, and evicting there would kill
   * the runtime the caller just minted.
   */
  claim(conversationId: string, connectionId: string, owner: ConversationOwnerHandle): void;
  /**
   * Drop this connection's claim. No-op when a newer connection already took
   * the conversation over — a superseded socket's close must never
   * deregister the live one.
   */
  release(conversationId: string, connectionId: string): void;
  /**
   * The connection currently serving this conversation on a socket that is
   * still open, or null — including when the recorded owner's socket is
   * already CLOSING/CLOSED and only its close event is outstanding.
   *
   * Exists because `claim` decides "newest" by CALL TIME, which is only the
   * same as connection recency while every connection claims during its own
   * handshake. Both `ensureBoundRuntime` paths (ws-handlers.ts) break that
   * assumption — they can claim long after a newer connection did — so they
   * ask who is there first instead of asserting ownership blind.
   *
   * The liveness filter is what keeps that guard from over-reaching: a
   * takeover by a client retrying over a NEW socket must still win against the
   * dying original's unreleased claim.
   */
  liveOwnerOf(conversationId: string): string | null;
  /** Live conversations. Exposed so teardown paths can assert no leak. */
  readonly size: number;
}

interface ConversationOwner {
  connectionId: string;
  handle: ConversationOwnerHandle;
}

export function createConversationRuntimeRegistry(): ConversationRuntimeRegistry {
  const owners = new Map<string, ConversationOwner>();

  return {
    claim(conversationId, connectionId, handle) {
      const previous = owners.get(conversationId);
      // Recorded BEFORE the eviction runs, so anything the evicted
      // connection's teardown touches already sees the new owner.
      owners.set(conversationId, { connectionId, handle });

      if (previous === undefined || previous.connectionId === connectionId) {
        log.debug("conversation-runtime.claimed", { conversationId, connectionId, liveConversations: owners.size });
        return;
      }

      log.warn("conversation-runtime.evicted", {
        conversationId,
        connectionId,
        evictedConnectionId: previous.connectionId,
        evictedWasAlive: previous.handle.isAlive(),
        reason: "newer connection claimed this conversation; two live runtimes would fork one append-only log",
      });
      // Runs for a dead previous owner too, and must: a socket that dropped
      // without its close event landing yet still holds a `SessionRuntime` and
      // its `bun:sqlite` handle, and this is what releases them.
      previous.handle.evict();
    },

    release(conversationId, connectionId) {
      const owner = owners.get(conversationId);
      if (owner === undefined) return;
      if (owner.connectionId !== connectionId) {
        log.debug("conversation-runtime.release-superseded", {
          conversationId,
          connectionId,
          ownerConnectionId: owner.connectionId,
          reason: "a newer connection owns this conversation; ignoring the superseded connection's release",
        });
        return;
      }
      owners.delete(conversationId);
      log.debug("conversation-runtime.released", { conversationId, connectionId, liveConversations: owners.size });
    },

    liveOwnerOf(conversationId) {
      const owner = owners.get(conversationId);
      if (owner === undefined) return null;
      // Deliberately NOT pruned here: the entry is a read model, and dropping
      // it would skip the eviction that frees the dead owner's runtime. The
      // next `claim` evicts it properly, and `release` stays connection-guarded.
      if (!owner.handle.isAlive()) {
        log.debug("conversation-runtime.owner-not-live", {
          conversationId,
          ownerConnectionId: owner.connectionId,
          reason: "owning socket is closing/closed — its claim must not block a takeover",
        });
        return null;
      }
      return owner.connectionId;
    },

    get size() {
      return owners.size;
    },
  };
}
