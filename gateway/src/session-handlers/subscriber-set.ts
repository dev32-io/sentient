// The attachments of ONE session — the "N" in "one runtime per session, N
// attachments to it" (session-model spec §2.5).
//
// A SET, NOT AN OWNER. `replay-registry.ts`'s lease is the precedent for one
// thing only: identity discipline, so a superseded or duplicated close event
// cannot unseat the connection that replaced it. Its PURPOSE — single
// ownership — is the opposite of this module's, and reusing that primitive
// here is exactly the mistake the first spec draft invited by calling it
// "precedent" without qualification.
//
// The identity that makes a late close harmless is `attachmentId`: minted per
// ATTACH, never per connection. A connection that detaches and attaches again
// (a re-`session.configure`, a `conversation.activate` that returns to the same
// session) is a NEW attachment, so its previous id refers to nothing and a
// close event carrying it removes nothing.

import { getLog } from "../logging/logger.js";

const log = getLog(["sentient", "ws", "subscriber-set"]);

/** 16 bytes of CSPRNG hex, matching `session-id.ts`'s id format. Attachment
 *  ids are log-attribution keys rather than credentials, but minting them the
 *  same way costs nothing and keeps one id shape in this directory. */
const ID_ENTROPY_BYTES = 16;
const ATTACHMENT_ID_PREFIX = "at_";

export interface Attachment {
  /** Unique per ATTACH — the log-attribution key, and the key `detach` is
   *  matched on. Two attachments of the same connection never share one. */
  readonly attachmentId: string;
  /** The WebSocket connection this attachment belongs to (`ws.data.sessionId`).
   *  Present for log correlation; it is deliberately NOT the detach key,
   *  because one connection can attach twice over its lifetime. */
  readonly connectionId: string;
  /**
   * Monotonic per session, never reused, starting at 1 for a session's first
   * attachment. Task 9 stamps commands with `{sessionId, generation}` and drops
   * traffic whose pair does not match the issuing connection's CURRENT
   * attachment — the correctness condition for session switching, since
   * `text.input` / `interrupt` / `permission.response` carry no session id of
   * their own.
   *
   * Per SESSION rather than global on purpose: the wire value is only ever
   * compared as half of that pair, and a counter that restarts per session is
   * still unambiguous because the sessionId disambiguates the other half.
   */
  readonly generation: number;
}

export interface SubscriberSet {
  /** Register a new attachment for this session. Always mints; never dedups on
   *  `connectionId` — two windows of one browser can and do share one. */
  add(connectionId: string): Attachment;
  /** Remove the attachment with this id. Returns false when there is nothing
   *  to remove — a duplicate close event, or a close arriving after the
   *  connection already re-attached under a fresh id. */
  remove(attachmentId: string): boolean;
  /** Insertion-ordered snapshot. A copy: iterating it while a subscriber
   *  detaches (a socket that dies during a fan-out) must not skip a peer. */
  readonly attachments: readonly Attachment[];
  readonly size: number;
}

function mintAttachmentId(): string {
  const bytes = new Uint8Array(ID_ENTROPY_BYTES);
  crypto.getRandomValues(bytes);
  return `${ATTACHMENT_ID_PREFIX}${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export function createSubscriberSet(sessionId: string): SubscriberSet {
  const members = new Map<string, Attachment>();
  let generations = 0;

  return {
    add(connectionId) {
      generations += 1;
      const attachment: Attachment = { attachmentId: mintAttachmentId(), connectionId, generation: generations };
      members.set(attachment.attachmentId, attachment);
      log.debug("subscriber-set.attached", {
        sessionId,
        connectionId,
        attachmentId: attachment.attachmentId,
        generation: attachment.generation,
        subscribers: members.size,
      });
      return attachment;
    },

    remove(attachmentId) {
      const attachment = members.get(attachmentId);
      if (attachment === undefined) {
        log.debug("subscriber-set.detach-stale", {
          sessionId,
          attachmentId,
          subscribers: members.size,
          reason: "no such attachment — a duplicate close, or one superseded by a later attach",
        });
        return false;
      }
      members.delete(attachmentId);
      log.debug("subscriber-set.detached", {
        sessionId,
        connectionId: attachment.connectionId,
        attachmentId,
        generation: attachment.generation,
        subscribers: members.size,
      });
      return true;
    },

    get attachments() {
      return [...members.values()];
    },

    get size() {
      return members.size;
    },
  };
}
