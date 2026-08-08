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
// question rather than a lifecycle one: `fan-out-emitter.ts` skips a
// closing/closed socket when delivering a frame.
//
// IDENTITY STILL MATTERS, and for the same reason it did before: `detach` is
// keyed on `attachmentId` (minted per attach, subscriber-set.ts), so a
// duplicated or late close event removes nothing rather than unseating the
// connection that replaced it.
//
// DISPOSAL IS A HOOK, NOT A RULE, and task 8 has now substituted into it: a
// session stays resident while a turn, a foreground tool call, a background
// task, a prompt or an auxiliary task is outstanding (runtime/session-retention.ts,
// runtime/session-retention-policy.ts). That was a POLICY change and this
// module was not rewritten for it — the two additions it needed are a way for
// the policy to reach the session's WORK (`SessionDisposalInput.work`, since
// none of it is an attach or a detach) and a way for a work COMPLETION to ask
// for a fresh decision (`reevaluate`, for the same reason).

import type { ServerWebSocket } from "bun";
import { getLog } from "../logging/logger.js";
import type { SessionPermissionBroker } from "../runtime/session-permission-broker.js";
import type { SessionWorkSignals } from "../runtime/session-retention.js";
import { isRetained, livenessInputsOf } from "../runtime/session-retention.js";
import type { SessionRuntime } from "../runtime/session-runtime.js";
import type { FanOutTurnEmitter } from "./fan-out-emitter.js";
import type { FrameJournal } from "./frame-journal.js";
import type { InputArbiter } from "./input-arbiter.js";
import type { ReplayLease } from "./replay-registry.js";
import { type Attachment, type SubscriberSet, createSubscriberSet } from "./subscriber-set.js";
import type { SessionData } from "./ws-helpers.js";

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
  /** The session's OPEN PROMPTS (task 7). Reached only through this entry —
   *  no socket holds one — which is what makes "any window may answer, the
   *  first answer settles it" a property of the session rather than of which
   *  connection happened to raise the prompt. */
  readonly permissions: SessionPermissionBroker;
  /** The session's INPUT FLOOR (task 9, spec §8.3) — which window won the most
   *  recent dispatch, and for how long that still refuses a peer. Session state
   *  because contention is between windows OF one session, and it dies with the
   *  session for the same reason the runtime does. */
  readonly arbiter: InputArbiter;
  /**
   * The session's outbound seam: one seq allocation per frame, fanned out to
   * every attached window, plus the hold/release that makes an attach atomic
   * (fan-out-emitter.ts). Same object the runtime and the permission broker
   * emit through — there is exactly one, because there is exactly one journal.
   */
  readonly fanOut: FanOutTurnEmitter;
  /**
   * This session's frame journal — ONE monotonic seq space, N cursors into it.
   * Owned by `services.replayRegistry` and held here under `replayLease`, so it
   * survives both the socket that filled it and this session's disposal: a
   * window reconnecting inside the retention window replays what it missed
   * instead of taking a truncated conversation.
   */
  readonly journal: FrameJournal;
  /** `journal`'s epoch, stamped on every session-lane frame. A client whose
   *  `resume.epoch` matches is in the same seq space and can be gap-filled. */
  readonly epoch: number;
  /**
   * This session's OBSERVABLE WORK — every member a getter, read at access
   * time, never latched (task 8). It is what makes residency a DERIVED
   * property: the disposal policy re-reads it on every evaluation and again
   * immediately before it tears anything down.
   */
  readonly work: SessionWorkSignals;
  /** Ownership token for `journal`; released when these handles are disposed. */
  readonly replayLease: ReplayLease;
  /** Settle open prompts, abort any in-flight turn, cut speech and close the
   *  store handle. Invoked by the disposal policy only — never by a
   *  connection, which is precisely the eviction this module deleted. */
  dispose(): void;
}

/**
 * What a change in a session's residency inputs means for its lifetime.
 *
 * Called after EVERY attach and detach, and on every `reevaluate`, so a policy
 * that defers disposal can cancel a pending one when work (or a window)
 * returns. The default disposes as soon as nothing observable holds the
 * session; the production policy adds a grace window on top of the same
 * predicate (runtime/session-retention-policy.ts).
 */
export type SessionDisposalPolicy = (input: SessionDisposalInput) => void;

export interface SessionDisposalInput {
  readonly sessionId: string;
  /**
   * A GETTER, read at access time. A policy that defers (the retention timer)
   * must re-read it immediately before disposing rather than latch the value
   * it saw when the timer was armed — "a check that passed at time T is not a
   * check that passes at time T+ε".
   */
  readonly subscriberCount: number;
  /**
   * This session's work, also read at access time. Present because the
   * predicate a policy needs is NOT a function of the subscriber count: a
   * background task registering, a turn settling and a prompt being answered
   * are none of them an attach or a detach, and each of them changes the
   * answer.
   */
  readonly work: SessionWorkSignals;
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
  attach(
    sessionId: string,
    connectionId: string,
    ws: ServerWebSocket<SessionData>,
    build: () => SessionHandles,
  ): Attachment;
  /** Drop one attachment and let the disposal policy decide what that means.
   *  A duplicate or late close (an `attachmentId` that is no longer a member)
   *  is a no-op. */
  detach(sessionId: string, attachmentId: string): void;
  /**
   * Ask the disposal policy to decide again, without any attachment having
   * changed. The seam for work COMPLETING — a turn settling, and through it
   * every background completion, tool result and answered prompt that turn was
   * waiting on. Without it a session whose last window left mid-work would stay
   * resident until the policy's own re-check timer noticed, because attach and
   * detach are the registry's only other events and neither is going to happen.
   * A no-op for an unknown id.
   */
  reevaluate(sessionId: string): void;
  /** This session's attachments, insertion-ordered. Empty for an unknown id. */
  subscribers(sessionId: string): readonly Attachment[];
  /**
   * Every live attachment whose connection authenticated as [userId], across
   * every resident session. The seam a CREDENTIAL REVOCATION reaches the wire
   * through (credential-revocation.ts): a role change or a deletion has to
   * close that account's open windows, and nothing else knew which they were.
   *
   * A SCAN, not an index, and deliberately. This module owns the attachment
   * map; a second map keyed on userId would have to be kept in step through
   * every attach, detach and disposal, and the thing it would buy — speed on
   * an operation that happens when an admin edits a household member — is
   * worth nothing against a divergence that would leave a revoked account
   * live. The owner is read off `ws.data.principal`, which the auth gate mints
   * once and never rebinds.
   */
  attachmentsForUser(userId: string): readonly Attachment[];
  /**
   * Every RESIDENT session's runtime owned by [userId], whether or not a window
   * is attached to it.
   *
   * STRICTLY WIDER THAN `attachmentsForUser`, and that is the whole reason it
   * exists. A session outlives its windows: `session-retention.ts` keeps one
   * resident while a background task is unfinished, so an account can hold a
   * live runtime — and the `Capability` frozen into its `ToolBroker` — with
   * zero sockets and zero attachments. Enumerating attachments finds none of
   * them, which is how a revoked account kept an authority nobody could reach
   * to take away. Owner read off `SessionRuntime.userId`, minted with the
   * runtime and never rebound.
   *
   * A scan, for the same reason `attachmentsForUser` is one: a second index
   * would have to stay in step through every attach, detach and disposal, and
   * a divergence would leave a revoked account authoritative.
   */
  runtimesForUser(userId: string): readonly SessionRuntime[];
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

/**
 * The default policy: dispose as soon as nothing observable holds the session.
 * The same predicate the production policy uses, with no grace window and no
 * timer — right for a harness, and honest in a way "the last one out disposes"
 * was not: that default would orphan a running background task the moment the
 * last window closed.
 */
function disposeWhenNoWorkRemains(input: SessionDisposalInput): void {
  if (isRetained(livenessInputsOf(input.work, input.subscriberCount > 0))) return;
  input.dispose();
}

export function createSessionRegistry(policy: SessionDisposalPolicy = disposeWhenNoWorkRemains): SessionRegistry {
  const sessions = new Map<string, ResidentSession>();

  function evaluate(sessionId: string, resident: ResidentSession): void {
    policy({
      sessionId,
      get subscriberCount() {
        return resident.subscribers.size;
      },
      get work() {
        return resident.handles.work;
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
    attach(sessionId, connectionId, ws, build) {
      const existing = sessions.get(sessionId);
      if (existing !== undefined) {
        const attachment = existing.subscribers.add(connectionId, ws);
        log.debug("session-registry.joined", {
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
      const attachment = resident.subscribers.add(connectionId, ws);
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

    reevaluate(sessionId) {
      const resident = sessions.get(sessionId);
      if (resident === undefined) return;
      evaluate(sessionId, resident);
    },

    subscribers(sessionId) {
      return sessions.get(sessionId)?.subscribers.attachments ?? [];
    },

    attachmentsForUser(userId) {
      const owned: Attachment[] = [];
      for (const resident of sessions.values()) {
        for (const attachment of resident.subscribers.attachments) {
          if (attachment.ws.data.principal?.userId === userId) owned.push(attachment);
        }
      }
      return owned;
    },

    runtimesForUser(userId) {
      const owned: SessionRuntime[] = [];
      for (const resident of sessions.values()) {
        if (resident.handles.runtime.userId === userId) owned.push(resident.handles.runtime);
      }
      return owned;
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
