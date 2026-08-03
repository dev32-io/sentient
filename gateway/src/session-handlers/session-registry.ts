// SessionRegistry — exactly ONE live `SessionRuntime` per SESSION, with N
// connections attached to it.
//
// THE INVARIANT, CARRIED FORWARD VERBATIM from the `ConversationRuntimeRegistry`
// this replaces (session-model spec §2.5 #2):
//
//   two live runtimes on one partition are two ReAct loops appending to one
//   append-only log, each having read prior context without the other's writes
//   — which breaks the store's cache-stable prefix invariant — plus two
//   `bun:sqlite` handles contending on one WAL file.
//
// That is unchanged and still binding. WHAT CHANGES IS THE REMEDY. The old
// registry answered it by ownership: the newest connection claimed the
// conversation and the previous one was EVICTED — `previous.evict()` denied its
// open permission prompts and disposed its runtime, aborting whatever turn was
// in flight. Under this module the second connection JOINS. Evict-on-claim is
// deleted, not generalised: with N windows onto one session it would tear down
// a live peer on every attach, which is why the spec's `two-surfaces-live`,
// `join-midturn` and `last-one-out` rows were not merely unimplemented but
// incoherent.
//
// WHAT THAT MAKES OF LIVENESS. The old registry filtered owners through
// `ConversationOwnerHandle.isAlive()`, read at query time, because a claim was
// an exclusive right and a corpse must not hold one against a retry. Nothing
// here is exclusive, so no caller has to ask who is there before attaching, and
// the question dissolves. Liveness survives in exactly one place, as a routing
// question rather than a lifecycle one: `session-windows.ts` skips a
// closing/closed socket when delivering a frame.
//
// IDENTITY STILL MATTERS, and for the same reason it did before: `detach` is
// keyed on `attachmentId` (minted per attach, subscriber-set.ts), so a
// duplicated or late close event removes nothing rather than unseating the
// connection that replaced it.
//
// DISPOSAL IS A HOOK, NOT A RULE. The default is "the last one out disposes".
// Task 8 substitutes a retention predicate (a session stays resident while a
// turn, a foreground tool call, a background task, a prompt or an auxiliary
// task is outstanding) — a POLICY change, not a rewrite of this module.

import { getLog } from "../logging/logger.js";
import type { PermissionBroker } from "../runtime/permission-broker.js";
import type { SessionRuntime } from "../runtime/session-runtime.js";
import type { SessionVoicePrefs } from "./session-voice-prefs.js";
import type { SessionWindows } from "./session-windows.js";
import { type Attachment, type SubscriberSet, createSubscriberSet } from "./subscriber-set.js";

const log = getLog(["sentient", "ws", "session-registry"]);

export type { Attachment } from "./subscriber-set.js";

/**
 * Everything one session owns while it is resident — built by the FIRST
 * attachment and shared by every later one.
 *
 * This is the set `ws-session-configure` used to build per connection, moved
 * to the session because the runtime moved to the session: the ReAct loop, the
 * permission broker whose prompts that loop awaits, the live voice preferences
 * its `TurnVoice` re-reads per turn, and the window set its emitter writes to.
 * Splitting any of them back out per connection would put two of the thing the
 * invariant above forbids on one partition.
 */
export interface SessionHandles {
  readonly runtime: SessionRuntime;
  /** Session-scoped from here on. Task 7 makes that visible on the wire (fan
   *  out the prompt, first answer wins, timeout denies); today it simply means
   *  every attached window can settle a prompt the session issued. */
  readonly permissions: PermissionBroker;
  /** Null when the orchestrator built no voice for this session (no `tts:`
   *  config, or no synthesizer for the resolved voice id). */
  readonly voicePrefs: SessionVoicePrefs | null;
  /** The sockets this session's frames go to. Attach adds one, detach removes
   *  one; the emitter reads it at write time. */
  readonly windows: SessionWindows;
  /** Settle open prompts, abort any in-flight turn, cut speech and close the
   *  store handle. Invoked by the disposal policy only — never by a
   *  connection, which is precisely the eviction this module deleted. */
  dispose(): void;
}

/**
 * What a session's subscriber count changing means for its residency.
 *
 * Called after EVERY attach and detach, so a policy that defers disposal can
 * cancel a pending one when work (or a window) returns. The default disposes
 * the moment the last attachment leaves.
 */
export type SessionDisposalPolicy = (input: SessionDisposalInput) => void;

export interface SessionDisposalInput {
  readonly sessionId: string;
  /**
   * A GETTER, read at access time. A policy that defers (task 8's retention
   * timer) must re-read it immediately before disposing rather than latch the
   * value it saw when the timer was armed — "a check that passed at time T is
   * not a check that passes at time T+ε".
   */
  readonly subscriberCount: number;
  /**
   * Release this session's handles now. Idempotent, and guarded on the
   * registry entry's identity: a deferred call that fires after the session
   * was already disposed and rebuilt is a no-op rather than a teardown of the
   * fresh handles.
   */
  dispose(): void;
}

export interface SessionRegistry {
  /**
   * Attach a connection to [sessionId], constructing the session's handles on
   * the FIRST attachment only. Never evicts and never forks: every later
   * attachment gets the same runtime back through `handlesFor`.
   *
   * Propagates whatever [build] throws, leaving no entry behind — a
   * half-registered session would make the next attach skip construction and
   * hand out handles that were never built.
   */
  attach(sessionId: string, connectionId: string, build: () => SessionHandles): Attachment;
  /** Drop one attachment and let the disposal policy decide what that means.
   *  A duplicate or late close (an `attachmentId` that is no longer a member)
   *  is a no-op. */
  detach(sessionId: string, attachmentId: string): void;
  /** This session's attachments, insertion-ordered. Empty for an unknown id. */
  subscribers(sessionId: string): readonly Attachment[];
  /** The one runtime serving this session, or null when none is resident. */
  runtimeFor(sessionId: string): SessionRuntime | null;
  /** Everything an attaching connection needs to hold onto — see
   *  `SessionHandles`. Null when no session is resident under this id. */
  handlesFor(sessionId: string): SessionHandles | null;
  /** Resident sessions. Exposed so teardown paths can assert no leak. */
  readonly size: number;
}

interface ResidentSession {
  handles: SessionHandles;
  subscribers: SubscriberSet;
}

/** The default policy: the last one out disposes. Task 8 replaces it. */
function disposeWhenLastDetaches(input: SessionDisposalInput): void {
  if (input.subscriberCount > 0) return;
  input.dispose();
}

export function createSessionRegistry(policy: SessionDisposalPolicy = disposeWhenLastDetaches): SessionRegistry {
  const sessions = new Map<string, ResidentSession>();

  function evaluate(sessionId: string, resident: ResidentSession): void {
    policy({
      sessionId,
      get subscriberCount() {
        return resident.subscribers.size;
      },
      dispose() {
        // Identity-guarded, not id-guarded: a deferred disposal that fires
        // after this session was torn down and re-attached must not dispose
        // the handles a live window is using.
        if (sessions.get(sessionId) !== resident) {
          log.debug("session-registry.dispose-superseded", {
            sessionId,
            reason: "these handles are no longer the resident ones — ignoring a stale disposal",
          });
          return;
        }
        sessions.delete(sessionId);
        log.info("session-registry.disposed", {
          sessionId,
          residentSessions: sessions.size,
          reason: "the session's disposal policy released it",
        });
        resident.handles.dispose();
      },
    });
  }

  return {
    attach(sessionId, connectionId, build) {
      const existing = sessions.get(sessionId);
      if (existing !== undefined) {
        const attachment = existing.subscribers.add(connectionId);
        log.info("session-registry.joined", {
          sessionId,
          connectionId,
          attachmentId: attachment.attachmentId,
          subscribers: existing.subscribers.size,
        });
        evaluate(sessionId, existing);
        return attachment;
      }

      // Built BEFORE anything is recorded, so a throw leaves the registry
      // exactly as it was.
      const handles = build();
      const resident: ResidentSession = { handles, subscribers: createSubscriberSet(sessionId) };
      const attachment = resident.subscribers.add(connectionId);
      sessions.set(sessionId, resident);
      log.info("session-registry.resident", {
        sessionId,
        connectionId,
        attachmentId: attachment.attachmentId,
        residentSessions: sessions.size,
        reason: "first attachment — this session's runtime was constructed here",
      });
      evaluate(sessionId, resident);
      return attachment;
    },

    detach(sessionId, attachmentId) {
      const resident = sessions.get(sessionId);
      if (resident === undefined) return;
      if (!resident.subscribers.remove(attachmentId)) return;
      evaluate(sessionId, resident);
    },

    subscribers(sessionId) {
      return sessions.get(sessionId)?.subscribers.attachments ?? [];
    },

    runtimeFor(sessionId) {
      return sessions.get(sessionId)?.handles.runtime ?? null;
    },

    handlesFor(sessionId) {
      return sessions.get(sessionId)?.handles ?? null;
    },

    get size() {
      return sessions.size;
    },
  };
}
