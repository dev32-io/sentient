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

import { getLog } from "../logging/logger.js";

const log = getLog(["sentient", "ws", "conversation-runtime-registry"]);

/**
 * Tears down one connection's orchestrator handles (its `SessionRuntime` and
 * `PermissionBroker`) and clears them off that socket. Supplied by the claimer;
 * invoked at most once, by the registry, when a newer connection takes the
 * conversation over.
 */
export type ConversationEviction = () => void;

export interface ConversationRuntimeRegistry {
  /**
   * Make `connectionId` the sole live owner of `conversationId`, evicting the
   * previous owner when that is a DIFFERENT connection. Re-claiming from the
   * same connection only replaces the eviction hook: a re-`session.configure`
   * has already disposed its own prior runtime, and evicting there would kill
   * the runtime the caller just minted.
   */
  claim(conversationId: string, connectionId: string, evict: ConversationEviction): void;
  /**
   * Drop this connection's claim. No-op when a newer connection already took
   * the conversation over — a superseded socket's close must never
   * deregister the live one.
   */
  release(conversationId: string, connectionId: string): void;
  /** Live conversations. Exposed so teardown paths can assert no leak. */
  readonly size: number;
}

interface ConversationOwner {
  connectionId: string;
  evict: ConversationEviction;
}

export function createConversationRuntimeRegistry(): ConversationRuntimeRegistry {
  const owners = new Map<string, ConversationOwner>();

  return {
    claim(conversationId, connectionId, evict) {
      const previous = owners.get(conversationId);
      // Recorded BEFORE the eviction runs, so anything the evicted
      // connection's teardown touches already sees the new owner.
      owners.set(conversationId, { connectionId, evict });

      if (previous === undefined || previous.connectionId === connectionId) {
        log.debug("conversation-runtime.claimed", { conversationId, connectionId, liveConversations: owners.size });
        return;
      }

      log.warn("conversation-runtime.evicted", {
        conversationId,
        connectionId,
        evictedConnectionId: previous.connectionId,
        reason: "newer connection claimed this conversation; two live runtimes would fork one append-only log",
      });
      previous.evict();
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

    get size() {
      return owners.size;
    },
  };
}
